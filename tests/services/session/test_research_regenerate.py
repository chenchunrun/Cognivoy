"""The UI's Regenerate command must resume the confirmed research request."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from cognivoy.services.session.sqlite_store import SQLiteSessionStore
from cognivoy.services.session.turn_runtime import TurnRuntimeManager

pytestmark = pytest.mark.asyncio


async def seed_research(tmp_path, *, manifest_session=None, checkpoint="research_resume123"):
    store = SQLiteSessionStore(db_path=tmp_path / "sessions.db")
    runtime = TurnRuntimeManager(store=store)
    session = await store.create_session()
    sid = session["id"]
    await store.add_message(
        sid,
        role="user",
        content="Original broad request",
        capability="deep_research",
        metadata={"request_snapshot": {"config": {"depth": "quick"}}},
    )
    turn = await store.create_turn(sid, capability="deep_research")
    await store.update_turn_status(turn["id"], "completed")
    await store.add_message(
        sid,
        role="assistant",
        content="Partial research report",
        capability="deep_research",
        events=[
            {
                "type": "result",
                "source": "deep_research",
                "turn_id": turn["id"],
                "metadata": {
                    "metadata": {
                        "partial": True,
                        "checkpoint_resumable": True,
                        "research_checkpoint_id": checkpoint,
                    }
                },
            }
        ],
    )
    confirmed_config = {
        "depth": "quick",
        "source_types": ["web"],
        "checkpoint_id": "research_resume123",
        "confirmed_outline": [{"title": "User-approved scope", "overview": "Confirmed"}],
        "_persist_user_message": False,
    }
    runtime.recovery_store.create(
        turn_id=turn["id"],
        session_id=manifest_session or sid,
        capability="deep_research",
        payload={
            "session_id": manifest_session or sid,
            "capability": "deep_research",
            "content": "Refined and approved research topic",
            "config": confirmed_config,
            "tools": ["web_search"],
            "knowledge_bases": [],
            "language": "en",
            "llm_selection": {"provider_id": "example", "model": "model"},
        },
    )
    return runtime, sid, confirmed_config


async def test_regenerate_resumes_confirmed_partial_research_not_planning(tmp_path, monkeypatch):
    runtime, sid, confirmed = await seed_research(tmp_path)
    recorder = AsyncMock(return_value=({}, {}))
    monkeypatch.setattr(runtime, "start_turn", recorder)
    await runtime.regenerate_last_turn(sid, {"language": "zh"})
    payload = recorder.await_args.args[0]
    assert payload["content"] == "Refined and approved research topic"
    assert payload["config"]["checkpoint_id"] == confirmed["checkpoint_id"]
    assert payload["config"]["confirmed_outline"] == confirmed["confirmed_outline"]
    assert payload["config"]["_persist_user_message"] is False
    assert payload["config"]["_regenerate"] is True
    assert payload["tools"] == ["web_search"]
    assert payload["language"] == "zh"
    assert payload["llm_selection"] == {"provider_id": "example", "model": "model"}


@pytest.mark.parametrize("mutation", ["other_session", "other_checkpoint", "changed_scope"])
async def test_regenerate_does_not_resume_unrelated_or_changed_research(
    tmp_path,
    monkeypatch,
    mutation,
):
    runtime, sid, _ = await seed_research(
        tmp_path,
        manifest_session="other-session" if mutation == "other_session" else None,
        checkpoint="research_unrelated" if mutation == "other_checkpoint" else "research_resume123",
    )
    recorder = AsyncMock(return_value=({}, {}))
    monkeypatch.setattr(runtime, "start_turn", recorder)
    override = {"config": {"source_types": ["papers"]}} if mutation == "changed_scope" else {}
    await runtime.regenerate_last_turn(sid, override)
    payload = recorder.await_args.args[0]
    assert "checkpoint_id" not in payload["config"]
    assert "confirmed_outline" not in payload["config"]
    assert payload["content"] == "Original broad request"
    if mutation == "changed_scope":
        assert payload["config"]["source_types"] == ["papers"]
