"""A reindex terminal state must survive page reloads via /progress."""

from __future__ import annotations

import asyncio
from contextlib import nullcontext
import importlib
from types import SimpleNamespace

import pytest

from cognivoy.knowledge.manager import KnowledgeBaseManager
from cognivoy.knowledge.progress_tracker import ProgressStage, ProgressTracker

router = importlib.import_module("cognivoy.api.routers.knowledge")


@pytest.fixture
def progress_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("COGNIVOY_RAG_RETRIEVAL_PROFILE", "keyword")
    monkeypatch.setattr(KnowledgeBaseManager, "_sync_kb_to_pb", lambda *_: None)
    manager = KnowledgeBaseManager(base_dir=str(tmp_path))
    raw = tmp_path / "course" / "raw"
    raw.mkdir(parents=True)
    (raw / "notes.txt").write_text("CISA audit evidence")
    task_states = {}

    def update_status(task_id, state, **_kwargs):
        task_states[task_id] = {"status": state}

    tasks = SimpleNamespace(
        update_task_status=update_status,
        get_task_metadata=lambda task_id: task_states.get(task_id, {}),
    )
    stream = SimpleNamespace(
        ensure_task=lambda *_: None,
        emit=lambda *_: None,
        emit_complete=lambda *_: None,
        emit_cancelled=lambda *_: None,
    )
    monkeypatch.setattr(router.TaskIDManager, "get_instance", lambda: tasks)
    monkeypatch.setattr(router, "get_task_stream_manager", lambda: stream)
    monkeypatch.setattr(
        importlib.import_module("cognivoy.api.utils.task_log_stream"),
        "get_task_stream_manager",
        lambda: stream,
    )
    monkeypatch.setattr(router, "capture_task_logs", lambda *_: nullcontext())
    monkeypatch.setattr(router, "_task_log", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        router, "_emit_private_task_failure", lambda *_args, **_kwargs: "Safe failure"
    )
    monkeypatch.setattr(router, "get_kb_manager", lambda: manager)
    monkeypatch.setattr(
        router, "resolve_kb", lambda *_: SimpleNamespace(name="course", base_dir=tmp_path)
    )
    return manager, task_states


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["completed", "error", "cancelled"])
async def test_reindex_terminal_snapshot_keeps_current_task_id(
    progress_environment, monkeypatch, outcome
):
    manager, task_states = progress_environment

    class RAG:
        def __init__(self, **_kwargs):
            pass

        async def initialize(self, *, progress_callback, **_kwargs):
            progress_callback(1, 2, "Indexing text")
            if outcome == "error":
                raise RuntimeError("private provider diagnostic")
            if outcome == "cancelled":
                raise asyncio.CancelledError()
            return True

    monkeypatch.setattr(importlib.import_module("cognivoy.services.rag.service"), "RAGService", RAG)
    if outcome == "cancelled":
        with pytest.raises(asyncio.CancelledError):
            await router.run_reindex_task(
                "course", str(manager.base_dir), "current-task", "keyword"
            )
    else:
        await router.run_reindex_task("course", str(manager.base_dir), "current-task", "keyword")
    snapshot = await router.get_progress("course")
    assert snapshot["stage"] == outcome
    assert snapshot["task_id"] == "current-task"
    assert task_states["current-task"]["status"] == outcome
    if outcome == "completed":
        assert snapshot["progress_percent"] == 100
        assert snapshot["index_action"] == "reindex"
        assert manager.get_kb_status("course")["status"] == "ready"
    elif outcome == "error":
        assert snapshot["error"] == "Safe failure"
        assert "private" not in str(snapshot)


@pytest.mark.asyncio
async def test_reindex_preflight_failure_still_persists_owned_terminal_state(progress_environment):
    manager, task_states = progress_environment
    (manager.base_dir / "course" / "raw" / "notes.txt").unlink()
    await router.run_reindex_task("course", str(manager.base_dir), "early-failure", "keyword")
    snapshot = await router.get_progress("course")
    assert snapshot["stage"] == "error"
    assert snapshot["task_id"] == "early-failure"
    assert task_states["early-failure"]["status"] == "error"


def test_cancelled_snapshot_from_older_task_does_not_hide_current_cancellation(
    progress_environment,
):
    manager, _ = progress_environment
    tracker = ProgressTracker("course", manager.base_dir)
    tracker.task_id = "old-task"
    tracker.update(ProgressStage.CANCELLED, "Old cancellation")
    router._mark_knowledge_task_cancelled(
        "course", manager.base_dir, "current-task", action="Reindex"
    )
    snapshot = tracker.get_progress()
    assert snapshot["stage"] == "cancelled"
    assert snapshot["task_id"] == "current-task"
