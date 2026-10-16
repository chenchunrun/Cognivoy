"""Real router → run manager → files → graph → chat-memory boundary journey."""

from __future__ import annotations

import importlib
from pathlib import Path
import re
import time

import pytest

pytest.importorskip("fastapi")
FastAPI = pytest.importorskip("fastapi").FastAPI
TestClient = pytest.importorskip("fastapi.testclient").TestClient

from cognivoy.services.memory.consolidator.runs import reset_run_manager_for_tests
from cognivoy.services.memory.settings import DedupSettings, MemorySettings
from cognivoy.services.memory.snapshot.entity import Entity
from cognivoy.services.memory.store import MemoryStore

memory_router = importlib.import_module("cognivoy.api.routers.memory").router
paths_mod = importlib.import_module("cognivoy.services.memory.paths")
update_mod = importlib.import_module("cognivoy.services.memory.consolidator.modes.update")


def _wait_run(client: TestClient, run_id: str) -> dict:
    for _ in range(200):
        body = client.get(f"/api/v1/memory/runs/{run_id}").json()
        if body["status"] not in {"queued", "running"}:
            return body
        time.sleep(0.01)
    raise AssertionError(f"memory run {run_id} did not finish")


def test_l1_to_l2_to_l3_to_scoped_chat_context(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(paths_mod, "memory_root", lambda: tmp_path)
    paths_mod.ensure_dirs()
    reset_run_manager_for_tests()
    entity = Entity(
        id="session-1",
        label="Calculus conversation",
        ts="2026-08-17T00:00:00Z",
        content="The learner prefers rigorous derivations.",
        fingerprint="conversation-v1",
    )
    monkeypatch.setattr(
        update_mod.snap, "read_snapshot", lambda surface: [entity] if surface == "chat" else []
    )
    monkeypatch.setattr(
        update_mod,
        "load_memory_settings",
        lambda: MemorySettings(dedup=DedupSettings(auto_after_update=False)),
    )

    async def fake_llm(*, user_prompt, **kwargs):
        if "@entity chat:session-1" in user_prompt:
            return '{"facts":[{"text":"Prefers rigorous derivations","section":"Learning style","refs":["chat:session-1"]}]}'
        match = re.search(r"@l2 (m_[0-9A-HJKMNP-TV-Z]{26})", user_prompt)
        assert match is not None
        return (
            '{"facts":[{"text":"The learner values rigorous mathematical explanations",'
            '"section":"Learning profile","refs":["' + match.group(1) + '"]}]}'
        )

    monkeypatch.setattr(update_mod, "call_llm", fake_llm)
    app = FastAPI()
    app.include_router(memory_router, prefix="/api/v1/memory")
    with TestClient(app) as client:
        l2 = client.post(
            "/api/v1/memory/runs/start",
            json={"layer": "L2", "key": "chat", "mode": "update", "language": "en"},
        )
        assert l2.status_code == 200
        assert _wait_run(client, l2.json()["id"])["status"] == "done"

        l3 = client.post(
            "/api/v1/memory/runs/start",
            json={"layer": "L3", "key": "profile", "mode": "update", "language": "en"},
        )
        assert l3.status_code == 200
        assert _wait_run(client, l3.json()["id"])["status"] == "done"

        graph = client.get("/api/v1/memory/graph").json()
        l2_entry = graph["l2"]["chat"]["entries"][0]
        l3_entry = graph["l3"]["profile"]["entries"][0]
        assert l2_entry["refs"] == ["chat:session-1"]
        assert l3_entry["refs"] == [l2_entry["id"]]

    (tmp_path / "L3" / "recent.md").write_text("# Recent\n\nDo not leak this turn.\n")
    chat_context = MemoryStore().read_l3_selected(["profile"])
    assert "rigorous mathematical explanations" in chat_context
    assert "Do not leak this turn" not in chat_context
    reset_run_manager_for_tests()
