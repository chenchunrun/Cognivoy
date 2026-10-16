"""API surface tests for /api/v1/partners (create / config / soul / assets)."""

from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
import yaml

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception:  # pragma: no cover
    FastAPI = None
    TestClient = None

pytestmark = pytest.mark.skipif(
    FastAPI is None or TestClient is None, reason="fastapi not installed"
)


@pytest.fixture
def isolated_root(tmp_path, monkeypatch) -> Path:
    from cognivoy.multi_user import paths

    project_root = tmp_path
    admin_root = (project_root / "data").resolve()
    monkeypatch.setattr(paths, "PROJECT_ROOT", project_root)
    monkeypatch.setattr(paths, "ADMIN_WORKSPACE_ROOT", admin_root)
    monkeypatch.setattr(paths, "USERS_ROOT", admin_root / "users")
    monkeypatch.setattr(paths, "SYSTEM_ROOT", admin_root / "system")
    monkeypatch.setattr(paths, "_path_services", {})
    admin_root.mkdir(parents=True, exist_ok=True)
    return admin_root


@pytest.fixture
def client(isolated_root, monkeypatch) -> TestClient:
    import cognivoy.api.routers.partners as partners_router_mod
    from cognivoy.services.partners.manager import PartnerManager

    # Fresh manager per test so the module-level singleton can't leak
    # tmp-path state across tests.
    mgr = PartnerManager()
    monkeypatch.setattr(partners_router_mod, "get_partner_manager", lambda: mgr)
    partners_router_mod._start_locks.clear()

    app = FastAPI()
    app.include_router(partners_router_mod.router, prefix="/api/v1/partners")
    return TestClient(app)


def _create(client: TestClient, **overrides):
    payload = {
        "name": "Ada",
        "description": "study partner",
        "soul": {"source": "custom", "content": "# Soul\nBe rigorous."},
        "start": False,
        **overrides,
    }
    return client.post("/api/v1/partners", json=payload)


class TestCreate:
    def test_create_returns_masked_config(self, client):
        res = _create(
            client,
            channels={
                "telegram": {
                    "enabled": True,
                    "token": "123:ABC",
                    "allow_from": ["*"],
                }
            },
            enabled_tools=["web_search"],
            mcp_tools=[],
        )
        assert res.status_code == 200
        body = res.json()
        assert body["partner_id"] == "ada"
        assert body["channels"]["telegram"]["token"] == "***"
        assert body["enabled_tools"] == ["web_search"]
        assert body["mcp_tools"] == []
        assert body["soul_origin"] == {"type": "custom", "id": ""}
        assert body["provisioning"]["errors"] == []

    def test_omitted_mcp_tools_defaults_to_deny(self, client):
        # A create that says nothing about MCP must not inherit the deployment's
        # configured MCP tools; ``null`` stays the deliberate opt-in to all.
        assert _create(client).status_code == 200
        assert client.get("/api/v1/partners/ada").json()["mcp_tools"] == []
        assert _create(client, partner_id="bob", name="Bob", mcp_tools=None).status_code == 200
        assert client.get("/api/v1/partners/bob").json()["mcp_tools"] is None

    def test_duplicate_id_conflicts(self, client):
        assert _create(client).status_code == 200
        assert _create(client).status_code == 409


class TestDeliveryOperations:
    def _seed_dead_letter(self, isolated_root: Path) -> str:
        from cognivoy.partners.bus.events import OutboundMessage
        from cognivoy.partners.channels.dead_letter import DeadLetterStore

        record = DeadLetterStore(
            isolated_root / "partners" / "ada" / "runtime" / "dead-letter.jsonl"
        ).append(
            OutboundMessage(channel="telegram", chat_id="42", content="review now"),
            attempts=3,
            error=RuntimeError("network unavailable"),
        )
        return str(record["id"])

    def test_lists_and_discards_partner_scoped_dead_letters(self, client, isolated_root):
        assert _create(client).status_code == 200
        record_id = self._seed_dead_letter(isolated_root)

        pending = client.get("/api/v1/partners/ada/dead-letters?status=pending")
        assert pending.status_code == 200
        assert [row["id"] for row in pending.json()["records"]] == [record_id]

        discarded = client.post(
            f"/api/v1/partners/ada/dead-letters/{record_id}/discard",
            json={"note": "recipient left the workspace"},
        )
        assert discarded.status_code == 200
        assert discarded.json()["status"] == "discarded"
        assert discarded.json()["resolution_note"] == "recipient left the workspace"
        assert (
            client.get("/api/v1/partners/ada/dead-letters?status=pending").json()["records"] == []
        )

    def test_missing_dead_letter_and_partner_are_not_silent(self, client):
        assert client.get("/api/v1/partners/ghost/dead-letters").status_code == 404
        assert _create(client).status_code == 200
        assert (
            client.post(
                "/api/v1/partners/ada/dead-letters/missing/discard",
                json={"note": ""},
            ).status_code
            == 404
        )

    def test_stopped_channel_status_is_explicit(self, client):
        assert (
            _create(
                client,
                channels={
                    "telegram": {
                        "enabled": True,
                        "token": "123:ABC",
                        "allow_from": ["*"],
                    }
                },
            ).status_code
            == 200
        )
        response = client.get("/api/v1/partners/ada/channels/status")
        assert response.status_code == 200
        assert response.json()["channels"]["telegram"]["status"] == "stopped"

    def test_top_level_delivery_flags_rejected(self, client):
        res = _create(client, channels={"send_progress": False})
        assert res.status_code == 422

    def test_create_from_library_soul(self, client):
        res = _create(
            client,
            partner_id="mathy",
            soul={"source": "library", "id": "math-tutor"},
        )
        assert res.status_code == 200
        soul = client.get("/api/v1/partners/mathy/soul").json()
        assert "math tutor" in soul["content"].lower()

    def test_create_with_unknown_library_soul_404(self, client):
        res = _create(client, soul={"source": "library", "id": "ghost"})
        assert res.status_code == 404


class TestConfigAndSoul:
    def test_invalid_channel_update_is_rejected_without_persisting(self, client):
        assert _create(client).status_code == 200

        response = client.patch(
            "/api/v1/partners/ada",
            json={
                "channels": {
                    "telegram": {
                        "enabled": True,
                        "token": "",
                        "allow_from": [],
                    }
                }
            },
        )

        assert response.status_code == 422
        assert "telegram" in response.json()["detail"]["message"]
        detail = client.get("/api/v1/partners/ada?include_secrets=true").json()
        assert detail["channels"] == {}

    def test_proactive_policy_roundtrip_and_validation(self, client):
        res = _create(
            client,
            proactive_learning=True,
            proactive_goal="Pass the calculus final",
            proactive_timezone="Asia/Shanghai",
            proactive_allowed_start="08:15",
            proactive_allowed_end="20:45",
            proactive_allowed_weekdays=[0, 1, 2, 3, 4],
            proactive_frequency="daily",
            proactive_preferred_channel="telegram",
            proactive_paused_until="2026-09-01T00:00:00+08:00",
            proactive_min_interval_hours=18,
            proactive_max_per_day=2,
            proactive_merge_window_hours=3,
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["proactive_goal"] == "Pass the calculus final"
        assert body["proactive_timezone"] == "Asia/Shanghai"
        assert body["proactive_allowed_weekdays"] == [0, 1, 2, 3, 4]
        assert body["proactive_frequency"] == "daily"
        assert body["proactive_max_per_day"] == 2

        patched = client.patch(
            "/api/v1/partners/ada",
            json={"proactive_paused_until": "", "proactive_frequency": "weekly"},
        )
        assert patched.status_code == 200
        assert patched.json()["proactive_paused_until"] == ""
        assert patched.json()["proactive_frequency"] == "weekly"

        invalid_tz = client.patch(
            "/api/v1/partners/ada", json={"proactive_timezone": "Mars/Olympus"}
        )
        assert invalid_tz.status_code == 422
        invalid_window = client.patch(
            "/api/v1/partners/ada", json={"proactive_allowed_start": "25:00"}
        )
        assert invalid_window.status_code == 422

    def test_proactive_reminder_list_and_cancel_are_owner_scoped(
        self, client, monkeypatch, tmp_path
    ):
        import cognivoy.api.routers.partners as partners_router_mod
        from cognivoy.services.cron.service import (
            CronOwner,
            CronSchedule,
            CronService,
        )

        assert _create(client).status_code == 200
        cron = CronService(tmp_path / "cron.json")
        job = cron.add_job(
            name="learning-review:ada:event",
            message="Review quadratics",
            schedule=CronSchedule(kind="at", at_ms=4_102_444_800_000),
            owner=CronOwner(
                kind="partner",
                partner_id="ada",
                channel="web",
                chat_id="web",
                channel_meta={"weak_questions": ["Quadratics"]},
            ),
        )
        monkeypatch.setattr(partners_router_mod, "get_cron_service", lambda: cron)

        listed = client.get("/api/v1/partners/ada/proactive-reminders")
        assert listed.status_code == 200
        assert listed.json()["pending"][0]["id"] == job.id
        assert listed.json()["pending"][0]["weak_questions"] == ["Quadratics"]

        viewed = client.post(
            f"/api/v1/partners/ada/proactive-reminders/{job.id}/action",
            json={"action": "view"},
        )
        assert viewed.status_code == 200
        viewed_again = client.post(
            f"/api/v1/partners/ada/proactive-reminders/{job.id}/action",
            json={"action": "view"},
        )
        assert viewed_again.status_code == 200
        viewed_state = client.get("/api/v1/partners/ada/proactive-reminders").json()
        assert viewed_state["analytics"]["viewed"] == 1
        assert [item["decision"] for item in viewed_state["audit"]].count("viewed") == 1

        snoozed = client.post(
            f"/api/v1/partners/ada/proactive-reminders/{job.id}/action",
            json={"action": "later", "later_hours": 4},
        )
        assert snoozed.status_code == 200
        assert snoozed.json()["action"] == "later"
        assert (
            client.get("/api/v1/partners/ada/proactive-reminders").json()["audit"][-1]["decision"]
            == "snoozed"
        )

        cancelled = client.delete(f"/api/v1/partners/ada/proactive-reminders/{job.id}")
        assert cancelled.status_code == 200
        assert cron.get_job(job.id) is None
        assert (
            client.get("/api/v1/partners/ada/proactive-reminders").json()["audit"][-1]["decision"]
            == "cancelled"
        )

        overview = client.get("/api/v1/partners/reminders/overview")
        assert overview.status_code == 200
        assert overview.json()["pending_count"] == 0
        assert overview.json()["partners"][0]["partner_id"] == "ada"

    def test_generic_proactive_event_is_created_listed_and_actionable(
        self, client, monkeypatch, tmp_path
    ):
        import cognivoy.api.routers.partners as partners_router_mod
        from cognivoy.services.cron.service import CronService
        import cognivoy.services.partners.proactive_learning as proactive_mod

        assert (
            _create(
                client,
                proactive_learning=True,
                proactive_allowed_start="00:00",
                proactive_allowed_end="23:59",
                proactive_min_interval_hours=0,
                proactive_max_per_day=10,
                proactive_merge_window_hours=0,
            ).status_code
            == 200
        )
        cron = CronService(tmp_path / "cron.json")
        monkeypatch.setattr(partners_router_mod, "get_cron_service", lambda: cron)
        monkeypatch.setattr(proactive_mod, "get_cron_service", lambda: cron)
        monkeypatch.setattr(
            proactive_mod,
            "get_partner_manager",
            partners_router_mod.get_partner_manager,
        )

        payload = {
            "event_type": "due_review",
            "event_key": "book-1:limits:2026-08-20",
            "message": "Limits are due for spaced review.",
            "desired_at": "2099-08-20T10:00:00+00:00",
            "metadata": {"book_id": "book-1", "knowledge_point_id": "limits"},
        }
        created = client.post("/api/v1/partners/ada/proactive-events", json=payload)
        assert created.status_code == 200, created.text
        assert len(created.json()["job_ids"]) == 1
        job_id = created.json()["job_ids"][0]

        duplicate = client.post("/api/v1/partners/ada/proactive-events", json=payload)
        assert duplicate.status_code == 200
        assert duplicate.json()["job_ids"] == []

        pending = client.get("/api/v1/partners/ada/proactive-reminders")
        assert pending.status_code == 200
        reminder = pending.json()["pending"][0]
        assert reminder["id"] == job_id
        assert reminder["event_type"] == "due_review"
        assert reminder["event_key"] == payload["event_key"]
        assert reminder["metadata"]["knowledge_point_id"] == "limits"

        snoozed = client.post(
            f"/api/v1/partners/ada/proactive-reminders/{job_id}/action",
            json={"action": "later", "later_hours": 2},
        )
        assert snoozed.status_code == 200, snoozed.text
        assert snoozed.json()["reminder"]["event_type"] == "due_review"

        overview = client.get("/api/v1/partners/reminders/overview")
        assert overview.status_code == 200
        assert overview.json()["pending_count"] == 1
        assert overview.json()["partners"][0]["pending"][0]["id"] == job_id

    def test_generic_proactive_event_rejects_unknown_type(self, client):
        assert _create(client, proactive_learning=True).status_code == 200
        response = client.post(
            "/api/v1/partners/ada/proactive-events",
            json={
                "event_type": "surprise",
                "event_key": "event-1",
                "message": "Unexpected event",
            },
        )
        assert response.status_code == 422

    def test_get_masks_secrets_by_default(self, client):
        _create(
            client,
            channels={
                "telegram": {
                    "enabled": True,
                    "token": "raw",
                    "allow_from": ["*"],
                }
            },
        )
        body = client.get("/api/v1/partners/ada").json()
        assert body["channels"]["telegram"]["token"] == "***"
        body = client.get("/api/v1/partners/ada?include_secrets=true").json()
        assert body["channels"]["telegram"]["token"] == "raw"

    def test_patch_updates_tools_and_clears(self, client):
        _create(client, enabled_tools=["web_search", "paper_search"])
        res = client.patch(
            "/api/v1/partners/ada",
            json={"enabled_tools": [], "mcp_tools": ["mcp_x_y"]},
        )
        assert res.status_code == 200
        body = client.get("/api/v1/partners/ada").json()
        assert body["enabled_tools"] == []
        assert body["mcp_tools"] == ["mcp_x_y"]

    def test_builtin_tools_create_and_patch(self, client):
        res = _create(client, builtin_tools=["rag", "read_memory"])
        assert res.status_code == 200
        assert res.json()["builtin_tools"] == ["rag", "read_memory"]
        # Default (omitted) stays null = no gating; an explicit deny persists.
        _create(client, partner_id="bob", name="Bob")
        assert client.get("/api/v1/partners/bob").json()["builtin_tools"] is None
        res = client.patch("/api/v1/partners/ada", json={"builtin_tools": []})
        assert res.status_code == 200
        assert client.get("/api/v1/partners/ada").json()["builtin_tools"] == []

    def test_tool_options_exposes_builtin_tools(self, client):
        body = client.get("/api/v1/partners/tool-options").json()
        assert {"tools", "builtin_tools", "mcp_tools"} <= set(body)
        builtin_names = {t["name"] for t in body["builtin_tools"]}
        # rag stays owner-configurable; the chat memory tools are NOT — partners
        # use the mandatory partner_read / partner_memorize / partner_search
        # instead, so they never surface in the partner config UI.
        assert "rag" in builtin_names
        assert "read_memory" not in builtin_names
        assert "write_memory" not in builtin_names

    def test_avatar_roundtrip_and_validation(self, client):
        _create(client)
        avatar = "data:image/png;base64,iVBORw0KGgo="
        res = client.patch("/api/v1/partners/ada", json={"avatar": avatar})
        assert res.status_code == 200
        assert client.get("/api/v1/partners/ada").json()["avatar"] == avatar

        # Clearing works; junk and oversized payloads are rejected.
        assert client.patch("/api/v1/partners/ada", json={"avatar": ""}).status_code == 200
        assert client.get("/api/v1/partners/ada").json()["avatar"] == ""
        res = client.patch("/api/v1/partners/ada", json={"avatar": "https://evil.example/x.png"})
        assert res.status_code == 422
        res = client.patch(
            "/api/v1/partners/ada",
            json={"avatar": "data:image/png;base64," + "A" * 200_001},
        )
        assert res.status_code == 422

    def test_soul_roundtrip(self, client):
        _create(client)
        res = client.put("/api/v1/partners/ada/soul", json={"content": "# Soul\nUpdated."})
        assert res.status_code == 200
        assert client.get("/api/v1/partners/ada/soul").json()["content"] == "# Soul\nUpdated."

    def test_soul_versions_list_and_restore(self, client):
        _create(client, soul={"source": "custom", "content": "# Soul\nInitial"})
        client.put("/api/v1/partners/ada/soul", json={"content": "# Soul\nRevised"})

        listed = client.get("/api/v1/partners/ada/soul/versions")
        assert listed.status_code == 200
        versions = listed.json()["versions"]
        assert [version["content"] for version in versions[:2]] == [
            "# Soul\nRevised",
            "# Soul\nInitial",
        ]

        restored = client.post(f"/api/v1/partners/ada/soul/versions/{versions[1]['id']}/restore")
        assert restored.status_code == 200
        assert restored.json()["content"] == "# Soul\nInitial"
        assert client.get("/api/v1/partners/ada/soul").json()["content"] == "# Soul\nInitial"

        missing = client.post("/api/v1/partners/ada/soul/versions/missing/restore")
        assert missing.status_code == 404

    def test_404_for_unknown_partner(self, client):
        assert client.get("/api/v1/partners/ghost").status_code == 404
        assert client.get("/api/v1/partners/ghost/soul").status_code == 404


class TestAssets:
    def _seed_skill(self, admin_root: Path, name="focus"):
        skill = admin_root / "user" / "workspace" / "skills" / name
        skill.mkdir(parents=True)
        (skill / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: d\n---\nBody", encoding="utf-8"
        )

    def test_add_list_remove_assets(self, client, isolated_root):
        self._seed_skill(isolated_root)
        _create(client)

        res = client.post("/api/v1/partners/ada/assets", json={"skills": ["focus"]})
        assert res.status_code == 200
        assert res.json()["copied"]["skills"] == ["focus"]
        assert [s["name"] for s in res.json()["assets"]["skills"]] == ["focus"]

        res = client.delete("/api/v1/partners/ada/assets/skill/focus")
        assert res.status_code == 200
        assert res.json()["assets"]["skills"] == []

    def test_unknown_asset_reported_in_errors(self, client):
        _create(client)
        res = client.post("/api/v1/partners/ada/assets", json={"skills": ["ghost"]})
        assert res.status_code == 200
        assert res.json()["errors"][0]["type"] == "skill"


class TestSoulLibraryEndpoints:
    def test_souls_crud(self, client):
        res = client.get("/api/v1/partners/souls")
        assert res.status_code == 200
        assert any(s["id"] == "math-tutor" for s in res.json())

        res = client.post(
            "/api/v1/partners/souls",
            json={"id": "custom-soul", "name": "Custom", "content": "# Soul"},
        )
        assert res.status_code == 200
        assert client.get("/api/v1/partners/souls/custom-soul").status_code == 200
        assert (
            client.put("/api/v1/partners/souls/custom-soul", json={"name": "Renamed"}).json()[
                "name"
            ]
            == "Renamed"
        )
        assert client.delete("/api/v1/partners/souls/custom-soul").status_code == 200
        assert client.get("/api/v1/partners/souls/custom-soul").status_code == 404

    def test_soul_cjk_id_is_ascii_safe(self, client):
        # A pure-CJK soul name must not become a non-ASCII (unreachable) id: the
        # server slugs it authoritatively and the returned id is URL-safe.
        res = client.post(
            "/api/v1/partners/souls",
            json={"id": "我的灵魂", "name": "我的灵魂", "content": "# Soul"},
        )
        assert res.status_code == 200
        soul_id = res.json()["id"]
        assert soul_id.isascii() and soul_id.startswith("soul-")
        # …and the soul is reachable / deletable by that returned id.
        assert client.get(f"/api/v1/partners/souls/{soul_id}").status_code == 200
        assert client.delete(f"/api/v1/partners/souls/{soul_id}").status_code == 200

    def test_soul_sources_shape(self, client):
        body = client.get("/api/v1/partners/soul-sources").json()
        assert "library" in body and "personas" in body


class TestHistory:
    def test_history_reads_session_store(self, client, isolated_root):
        _create(client)
        sessions = isolated_root / "partners" / "ada" / "sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        (sessions / "telegram_42.jsonl").write_text(
            json.dumps({"role": "user", "content": "hi", "timestamp": "2026-01-01T00:00:00"})
            + "\n",
            encoding="utf-8",
        )
        res = client.get("/api/v1/partners/ada/history")
        assert res.status_code == 200
        assert res.json()[0]["content"] == "hi"

    def test_history_scoped_by_web_session_id(self, client, isolated_root):
        _create(client)
        sessions = isolated_root / "partners" / "ada" / "sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        # Two distinct web sessions; the endpoint must scope to the one asked for.
        (sessions / "web_s1.jsonl").write_text(
            json.dumps({"role": "user", "content": "from s1", "timestamp": "t"}) + "\n",
            encoding="utf-8",
        )
        (sessions / "web_s2.jsonl").write_text(
            json.dumps({"role": "user", "content": "from s2", "timestamp": "t"}) + "\n",
            encoding="utf-8",
        )
        res = client.get("/api/v1/partners/ada/history?session_id=s1")
        assert res.status_code == 200
        contents = [m["content"] for m in res.json()]
        assert contents == ["from s1"]

    def test_sessions_list_carries_title(self, client, isolated_root):
        _create(client)
        sessions = isolated_root / "partners" / "ada" / "sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        (sessions / "web_s1.jsonl").write_text(
            json.dumps({"role": "user", "content": "what is recursion?", "timestamp": "t"}) + "\n",
            encoding="utf-8",
        )
        res = client.get("/api/v1/partners/ada/sessions")
        assert res.status_code == 200
        assert res.json()[0]["title"] == "what is recursion?"

    def _seed_session(self, isolated_root: Path, key: str, content: str) -> None:
        sessions = isolated_root / "partners" / "ada" / "sessions"
        sessions.mkdir(parents=True, exist_ok=True)
        (sessions / f"{key}.jsonl").write_text(
            json.dumps({"role": "user", "content": content, "timestamp": "t"}) + "\n",
            encoding="utf-8",
        )

    def test_archive_then_resume_roundtrip(self, client, isolated_root):
        _create(client)
        self._seed_session(isolated_root, "web-a", "hi")
        assert (
            client.post("/api/v1/partners/ada/sessions/archive", json={"session_key": "web-a"})
        ).status_code == 200
        archived = {s["session_key"]: s for s in client.get("/api/v1/partners/ada/sessions").json()}
        assert archived["web-a"]["archived"] is True
        assert (
            client.post("/api/v1/partners/ada/sessions/resume", json={"session_key": "web-a"})
        ).status_code == 200
        live = {s["session_key"]: s for s in client.get("/api/v1/partners/ada/sessions").json()}
        assert live["web-a"]["archived"] is False

    def test_branch_copies_and_archives(self, client, isolated_root):
        _create(client)
        self._seed_session(isolated_root, "web-a", "carry me")
        res = client.post(
            "/api/v1/partners/ada/sessions/branch",
            json={"source_key": "web-a", "new_key": "web-b"},
        )
        assert res.status_code == 200
        assert res.json()["session"]["session_key"] == "web-b"
        hist = client.get("/api/v1/partners/ada/history?session_key=web-b").json()
        assert [m["content"] for m in hist] == ["carry me"]
        sessions = {s["session_key"]: s for s in client.get("/api/v1/partners/ada/sessions").json()}
        assert sessions["web-a"]["archived"] is True

    def test_delete_session_endpoint(self, client, isolated_root):
        _create(client)
        self._seed_session(isolated_root, "web-a", "bye")
        assert (
            client.post("/api/v1/partners/ada/sessions/delete", json={"session_key": "web-a"})
        ).status_code == 200
        assert client.get("/api/v1/partners/ada/sessions").json() == []
        # Deleting a missing session is a 404.
        assert (
            client.post("/api/v1/partners/ada/sessions/delete", json={"session_key": "web-a"})
        ).status_code == 404


class TestChatAttachments:
    def test_chat_does_not_auto_start_stopped_partner(self, client):
        # ``start=True`` spawns a real PartnerRunner task; drive every request
        # through one shared event loop (context-managed TestClient) so the
        # runner started by create can be cancelled by stop — otherwise each
        # request runs on its own loop and the cancel raises a cross-loop error.
        with client:
            assert _create(client, start=True).status_code == 200
            assert client.post("/api/v1/partners/ada/stop").status_code == 200

            res = client.post("/api/v1/partners/ada/chat", json={"content": "hello"})

        assert res.status_code == 409
        from cognivoy.core.i18n import t

        assert res.json()["detail"] == t("api.partner_stopped_start_required")

    def test_create_start_false_disables_auto_start(self, client, isolated_root):
        assert _create(client, start=False).status_code == 200

        data = yaml.safe_load(
            (isolated_root / "partners" / "ada" / "config.yaml").read_text(encoding="utf-8")
        )
        assert data["auto_start"] is False

    def test_materialize_partner_attachment_writes_partner_media(self, isolated_root):
        from cognivoy.api.routers.partners import (
            ChatAttachmentRequest,
            _materialize_partner_attachments,
        )

        paths = _materialize_partner_attachments(
            "ada",
            [
                ChatAttachmentRequest(
                    type="file",
                    filename="notes.txt",
                    base64=base64.b64encode(b"hello").decode("ascii"),
                    mime_type="text/plain",
                )
            ],
        )

        assert len(paths) == 1
        path = Path(paths[0])
        assert path.read_bytes() == b"hello"
        assert path.name.endswith("_notes.txt")
        assert path.parent == isolated_root / "partners" / "ada" / "media" / "web"
