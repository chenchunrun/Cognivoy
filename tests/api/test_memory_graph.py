"""Structured memory graph contract — backend owns Markdown parsing."""

from __future__ import annotations

import importlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest.importorskip("fastapi")

FastAPI = pytest.importorskip("fastapi").FastAPI
TestClient = pytest.importorskip("fastapi.testclient").TestClient

memory_api = importlib.import_module("cognivoy.api.routers.memory")
memory_router = memory_api.router
paths_mod = importlib.import_module("cognivoy.services.memory.paths")
document_mod = importlib.import_module("cognivoy.services.memory.document")
snapshot_mod = importlib.import_module("cognivoy.services.memory.snapshot")
entity_mod = importlib.import_module("cognivoy.services.memory.snapshot.entity")


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(paths_mod, "memory_root", lambda: tmp_path)
    (tmp_path / "L2").mkdir()
    (tmp_path / "L3").mkdir()
    monkeypatch.setattr(
        snapshot_mod,
        "read_snapshot",
        lambda surface: [
            entity_mod.Entity(
                id=f"{surface}-1",
                label=f"{surface} item",
                ts="2026-08-15T00:00:00Z",
                content=f"raw {surface} evidence",
            )
        ],
    )
    app = FastAPI()
    app.include_router(memory_router, prefix="/api/v1/memory")
    return TestClient(app)


def _write_doc(path: Path, *, entry_id: str, text: str, refs: list[str]) -> None:
    doc = document_mod.Document(
        title="Learning profile",
        sections=[
            (
                "Facts",
                [
                    document_mod.Entry(
                        id=entry_id,
                        section="Facts",
                        text=text,
                        refs=refs,
                    )
                ],
            )
        ],
    )
    path.write_text(document_mod.serialize(doc), encoding="utf-8")


def test_memory_resource_creation_time_is_backfilled_and_stable(
    client: TestClient, tmp_path: Path
) -> None:
    entry_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    _write_doc(
        tmp_path / "L2" / "chat.md",
        entry_id=entry_id,
        text="The learner prefers diagrams",
        refs=["chat:turn-1"],
    )
    first = client.get("/api/v1/memory/resources?layer=L2&key=chat").json()["items"][0]
    assert first["created_at"]
    state = json.loads((tmp_path / "resource-state.json").read_text(encoding="utf-8"))
    assert state[f"L2:chat:{entry_id}"]["created_at"] == first["created_at"]

    second = client.get("/api/v1/memory/resources?layer=L2&key=chat").json()["items"][0]
    assert second["created_at"] == first["created_at"]


def test_memory_projects_are_owner_scoped_persisted_and_audited(
    client: TestClient, tmp_path: Path, monkeypatch
) -> None:
    entry_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    _write_doc(
        tmp_path / "L2" / "chat.md",
        entry_id=entry_id,
        text="The learner benefits from worked examples",
        refs=["chat:turn-1"],
    )
    projects = {
        "project-1": SimpleNamespace(id="project-1", owner_id="learner-1"),
        "foreign": SimpleNamespace(id="foreign", owner_id="learner-2"),
    }
    events: list[dict] = []

    class FakeProjectStore:
        def load(self, project_id: str):
            return projects.get(project_id)

        def record_external_event(self, project_id: str, **kwargs):
            events.append({"project_id": project_id, **kwargs})
            return projects.get(project_id)

    monkeypatch.setattr(memory_api, "LearningProjectStore", FakeProjectStore)
    monkeypatch.setattr(
        memory_api,
        "get_current_user",
        lambda: SimpleNamespace(id="learner-1"),
    )

    linked = client.put(
        f"/api/v1/memory/resources/L2/chat/{entry_id}/projects",
        json={"project_ids": ["project-1", "project-1"]},
    )
    assert linked.status_code == 200
    assert linked.json()["item"]["project_ids"] == ["project-1"]
    assert linked.json()["added_project_ids"] == ["project-1"]
    assert events[-1]["event_type"] == "resource_activity"
    assert events[-1]["result_refs"] == [f"memory:L2:chat:{entry_id}"]

    repeated = client.put(
        f"/api/v1/memory/resources/L2/chat/{entry_id}/projects",
        json={"project_ids": ["project-1"]},
    )
    assert repeated.status_code == 200
    assert repeated.json()["added_project_ids"] == []
    assert len(events) == 1

    resources = client.get("/api/v1/memory/resources", params={"layer": "L2", "key": "chat"}).json()
    assert resources["items"][0]["project_ids"] == ["project-1"]
    assert resources["items"][0]["project_link_revision"] == 1

    forbidden = client.put(
        f"/api/v1/memory/resources/L2/chat/{entry_id}/projects",
        json={"project_ids": ["foreign"]},
    )
    assert forbidden.status_code == 404
    assert client.get("/api/v1/memory/resources", params={"layer": "L2", "key": "chat"}).json()[
        "items"
    ][0]["project_ids"] == ["project-1"]

    unlinked = client.put(
        f"/api/v1/memory/resources/L2/chat/{entry_id}/projects",
        json={"project_ids": []},
    )
    assert unlinked.status_code == 200
    assert unlinked.json()["removed_project_ids"] == ["project-1"]
    assert events[-1]["title"] == "Memory removed from learning project"


def test_graph_returns_backend_parsed_three_layer_snapshot(
    client: TestClient, tmp_path: Path
) -> None:
    l2_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    l3_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWY"
    _write_doc(
        tmp_path / "L2" / "chat.md",
        entry_id=l2_id,
        text="Learner asks for derivations",
        refs=["chat:chat-1"],
    )
    _write_doc(
        tmp_path / "L3" / "profile.md",
        entry_id=l3_id,
        text="Prefers rigorous explanations",
        refs=[l2_id],
    )

    response = client.get("/api/v1/memory/graph")
    assert response.status_code == 200
    body = response.json()
    assert body["schema_version"] == 1
    assert body["l1"]["chat"][0]["id"] == "chat-1"
    assert body["l2"]["chat"] == {
        "title": "Learning profile",
        "entries": [
            {
                "id": l2_id,
                "section": "Facts",
                "text": "Learner asks for derivations",
                "refs": ["chat:chat-1"],
            }
        ],
    }
    assert body["l3"]["profile"]["entries"][0]["refs"] == [l2_id]
    assert "preferences" in body["l3"]


def test_graph_uses_empty_documents_for_missing_files(client: TestClient) -> None:
    body = client.get("/api/v1/memory/graph").json()
    assert set(body["l2"]) == set(paths_mod.SURFACES)
    assert set(body["l3"]) == set(paths_mod.L3_SLOTS)
    assert body["l2"]["book"] == {"title": "", "entries": []}


def test_memory_trash_lists_restores_and_permanently_deletes(
    client: TestClient, tmp_path: Path
) -> None:
    entry_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    _write_doc(
        tmp_path / "L2" / "chat.md",
        entry_id=entry_id,
        text="Learner prefers worked examples",
        refs=["chat:turn-1"],
    )

    deleted = client.delete(f"/api/v1/memory/doc/L2/chat/entry/{entry_id}")
    assert deleted.status_code == 200
    assert deleted.json()["recoverable"] is True

    trash = client.get("/api/v1/memory/trash", params={"layer": "L2", "key": "chat"})
    assert trash.status_code == 200
    assert trash.json()["total"] == 1
    assert trash.json()["items"][0]["entry"]["refs"] == ["chat:turn-1"]

    restored = client.post(f"/api/v1/memory/trash/L2/chat/{entry_id}/restore")
    assert restored.status_code == 200
    assert restored.json()["restored"] == entry_id
    assert (
        document_mod.parse((tmp_path / "L2" / "chat.md").read_text(encoding="utf-8")).find(entry_id)
        is not None
    )

    assert client.delete(f"/api/v1/memory/doc/L2/chat/entry/{entry_id}").status_code == 200
    purged = client.delete(f"/api/v1/memory/trash/L2/chat/{entry_id}")
    assert purged.status_code == 200
    assert purged.json()["permanently_deleted"] == entry_id
    assert client.get("/api/v1/memory/trash").json()["total"] == 0


@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/memory/trash/L2/chat/not-an-entry/restore",
        "/api/v1/memory/trash/L2/chat/not-an-entry",
    ],
)
def test_memory_trash_rejects_invalid_entry_ids(client: TestClient, path: str) -> None:
    response = client.post(path) if path.endswith("/restore") else client.delete(path)
    assert response.status_code == 400


def test_versioned_memory_resources_page_update_soft_delete_and_export(
    client: TestClient, tmp_path: Path
) -> None:
    first_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    second_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWY"
    doc = document_mod.Document(
        title="Profile",
        sections=[
            (
                "Facts",
                [
                    document_mod.Entry(first_id, "Facts", "First fact", ["chat:1"]),
                    document_mod.Entry(second_id, "Facts", "Second fact", ["chat:2"]),
                ],
            )
        ],
    )
    (tmp_path / "L2" / "chat.md").write_text(document_mod.serialize(doc), encoding="utf-8")

    first_page = client.get(
        "/api/v1/memory/resources",
        params={"layer": "L2", "key": "chat", "limit": 1},
    )
    assert first_page.status_code == 200
    page_body = first_page.json()
    assert page_body["total"] == 2
    assert page_body["cursor"] == "1"
    assert page_body["items"][0]["version"].startswith("sha256:")
    version = page_body["items"][0]["version"]

    updated = client.put(
        f"/api/v1/memory/resources/L2/chat/{first_id}",
        json={
            "expected_version": version,
            "text": "Updated fact",
            "section": "Confirmed",
            "refs": ["chat:1", "notebook:2"],
        },
    )
    assert updated.status_code == 200
    updated_body = updated.json()
    assert updated_body["item"]["text"] == "Updated fact"
    assert updated_body["item"]["section"] == "Confirmed"
    assert updated_body["version"] != version

    stale = client.put(
        f"/api/v1/memory/resources/L2/chat/{first_id}",
        json={"expected_version": version, "text": "Overwrite"},
    )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "memory_version_conflict"

    deleted = client.request(
        "DELETE",
        f"/api/v1/memory/resources/L2/chat/{first_id}",
        json={
            "expected_version": updated_body["version"],
            "reason": "learner correction",
        },
    )
    assert deleted.status_code == 200
    assert deleted.json()["recoverable"] is True
    trash = client.get(
        "/api/v1/memory/resources",
        params={"layer": "L2", "key": "chat", "status": "deleted"},
    ).json()
    assert trash["items"][0]["reason"] == "learner correction"

    exported = client.get(
        "/api/v1/memory/resources/export",
        params={"layer": "L2", "key": "chat", "include_deleted": "true"},
    )
    assert exported.status_code == 200
    assert {item["status"] for item in exported.json()["items"]} == {
        "active",
        "deleted",
    }


def test_memory_resource_pause_incorrect_and_duplicate_merge(
    client: TestClient, tmp_path: Path
) -> None:
    from cognivoy.services.memory import get_memory_store

    first_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    second_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWY"
    doc = document_mod.Document(
        title="Profile",
        sections=[
            (
                "Preferences",
                [
                    document_mod.Entry(first_id, "Preferences", "Uses examples", ["chat:1"]),
                    document_mod.Entry(second_id, "Preferences", "Uses examples", ["book:2"]),
                ],
            )
        ],
    )
    (tmp_path / "L3" / "profile.md").write_text(document_mod.serialize(doc), encoding="utf-8")

    page = client.get("/api/v1/memory/resources", params={"layer": "L3", "key": "profile"}).json()
    assert page["items"][0]["paused"] is False
    assert page["items"][0]["flagged_incorrect"] is False

    paused = client.patch(
        f"/api/v1/memory/resources/L3/profile/{first_id}/state",
        json={"paused": True, "reason": "learner_paused"},
    )
    assert paused.status_code == 200
    assert paused.json()["item"]["paused"] is True
    rendered = get_memory_store().read_l3_selected(["profile"])
    assert "Uses examples" in rendered  # duplicate remains active

    incorrect = client.patch(
        f"/api/v1/memory/resources/L3/profile/{second_id}/state",
        json={"flagged_incorrect": True, "reason": "learner_marked_incorrect"},
    )
    assert incorrect.status_code == 200
    assert incorrect.json()["item"]["paused"] is True
    assert incorrect.json()["item"]["flagged_incorrect"] is True
    assert get_memory_store().read_l3_selected(["profile"]).startswith("(No memory")

    resumed = client.patch(
        f"/api/v1/memory/resources/L3/profile/{first_id}/state",
        json={"paused": False},
    )
    assert resumed.status_code == 200
    current = client.get(
        "/api/v1/memory/resources", params={"layer": "L3", "key": "profile"}
    ).json()
    by_id = {item["id"]: item for item in current["items"]}
    merged = client.post(
        "/api/v1/memory/resources/merge",
        json={
            "layer": "L3",
            "key": "profile",
            "entry_ids": [first_id, second_id],
            "expected_version": by_id[first_id]["version"],
        },
    )
    assert merged.status_code == 200
    assert merged.json()["kept_id"] == first_id
    assert set(merged.json()["item"]["refs"]) == {"chat:1", "book:2"}
    after = client.get("/api/v1/memory/resources", params={"layer": "L3", "key": "profile"}).json()
    assert after["total"] == 1
    assert client.get("/api/v1/memory/trash").json()["total"] == 1


def test_conflict_api_lists_and_resolves_keep_left(client: TestClient, tmp_path: Path) -> None:
    evidence_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    left_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWY"
    right_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWZ"
    _write_doc(
        tmp_path / "L2" / "chat.md",
        entry_id=evidence_id,
        text="A shared observation",
        refs=["chat:turn-1"],
    )
    doc = document_mod.Document(
        title="Profile",
        sections=[
            (
                "Preferences",
                [
                    document_mod.Entry(
                        id=left_id,
                        section="Preferences",
                        text="Prefers concise answers",
                        refs=[evidence_id],
                    ),
                    document_mod.Entry(
                        id=right_id,
                        section="Preferences",
                        text="Prefers detailed answers",
                        refs=[evidence_id],
                    ),
                ],
            )
        ],
    )
    (tmp_path / "L3" / "profile.md").write_text(document_mod.serialize(doc), encoding="utf-8")

    listed = client.get("/api/v1/memory/conflicts")
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    conflict_id = listed.json()["items"][0]["id"]

    resolved = client.post(
        "/api/v1/memory/conflicts/resolve",
        json={
            "conflict_id": conflict_id,
            "layer": "L3",
            "key": "profile",
            "left_id": left_id,
            "right_id": right_id,
            "action": "keep_left",
            "reason": "The learner confirmed the left statement",
        },
    )
    assert resolved.status_code == 200
    assert resolved.json()["kept_ids"] == [left_id]
    assert (
        document_mod.parse((tmp_path / "L3" / "profile.md").read_text(encoding="utf-8")).find(
            right_id
        )
        is None
    )
    assert client.get("/api/v1/memory/trash").json()["total"] == 1
    assert client.get("/api/v1/memory/conflicts/audit").json()["total"] == 1


def test_conflict_api_rejects_invalid_resolution(client: TestClient) -> None:
    response = client.post(
        "/api/v1/memory/conflicts/resolve",
        json={
            "conflict_id": "bad",
            "layer": "L3",
            "key": "profile",
            "left_id": "not-an-id",
            "right_id": "also-bad",
            "action": "keep_left",
            "reason": "test",
        },
    )
    assert response.status_code == 400
