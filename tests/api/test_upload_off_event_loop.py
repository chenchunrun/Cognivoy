"""The upload path must never hold the event loop (issue #777).

Batch-uploading files stalled every other request — chat WebSockets included
— for the whole duration of the batch. Two distinct causes, both pinned here:

* ``_save_uploaded_files`` is blocking end to end (a chunked write of every
  uploaded byte, zip extraction, plus a synchronous HTTP upload per file when
  PocketBase is on) and was called inline from an ``async def`` route.
* the follow-up work runs in a FastAPI ``BackgroundTasks`` entry declared
  ``async def``, which starlette awaits ON the event loop — only *sync*
  callables get routed to its threadpool — so the staging hash/copy and the
  per-file re-hash blocked there too.

Each test asserts the work happens on a worker thread, and one asserts the
loop keeps serving unrelated work while an upload is being written.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import threading
import time
from typing import Any

import pytest

from cognivoy.api.routers import knowledge as knowledge_router
from cognivoy.api.utils.knowledge_task_registry import KnowledgeTaskRegistry
from cognivoy.api.utils.task_id_manager import TaskIDManager
from cognivoy.knowledge.add_documents import DocumentAdder


def test_saving_uploads_runs_on_a_worker_thread(monkeypatch, tmp_path: Path) -> None:
    recorded: dict[str, int] = {}

    def _fake_save(
        files: list[Any],
        target_dir: Path,
        **_kwargs: Any,
    ) -> tuple[list[str], list[str]]:
        recorded["thread"] = threading.get_ident()
        return (["a.pdf"], [str(target_dir / "a.pdf")])

    monkeypatch.setattr(knowledge_router, "_save_uploaded_files", _fake_save)

    uploaded, paths = asyncio.run(
        knowledge_router._save_uploaded_files_off_loop([], tmp_path, rel_paths=None)
    )

    assert (uploaded, paths) == (["a.pdf"], [str(tmp_path / "a.pdf")])
    assert recorded["thread"] != threading.get_ident()


@pytest.mark.asyncio
async def test_cancelling_registry_signals_blocking_staging_worker(
    monkeypatch, tmp_path: Path
) -> None:
    started = threading.Event()
    stopped = threading.Event()

    class _CooperativeAdder:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        def add_documents(self, *_args: Any, cancel_event=None, **_kwargs: Any):
            assert cancel_event is not None
            started.set()
            cancel_event.wait(timeout=5)
            stopped.set()
            return []

    monkeypatch.setattr(knowledge_router, "DocumentAdder", _CooperativeAdder)
    monkeypatch.setattr(
        knowledge_router,
        "get_knowledge_task_registry",
        lambda: registry,
    )
    registry = KnowledgeTaskRegistry()
    task_id = "cooperative-cancel"
    registry.start(
        task_id,
        "kb",
        knowledge_router.run_upload_processing_task(
            kb_name="kb",
            base_dir=str(tmp_path),
            uploaded_file_paths=[str(tmp_path / "source.txt")],
            task_id=task_id,
            rag_provider="llamaindex",
        ),
    )
    await asyncio.to_thread(started.wait, 2)

    assert await registry.cancel(task_id, kb_name="kb") is True
    assert await asyncio.to_thread(stopped.wait, 2) is True


@pytest.mark.asyncio
async def test_cancelled_terminal_state_survives_a_provider_that_swallows_cancel() -> None:
    task_manager = TaskIDManager.get_instance()
    task_id = task_manager.generate_task_id("kb_upload", "stubborn-terminal")
    started = asyncio.Event()

    async def _stubborn_provider() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            # Simulates a provider wrapper that converts cancellation into its
            # own late failure result instead of re-raising it.
            task_manager.update_task_status(task_id, "error", error="late provider failure")

    registry = KnowledgeTaskRegistry()
    registry.start(task_id, "kb", _stubborn_provider())
    await asyncio.wait_for(started.wait(), timeout=1)

    assert await registry.cancel(task_id, kb_name="kb") is True
    assert task_manager.get_task_metadata(task_id)["status"] == "cancelled"


@pytest.mark.asyncio
async def test_cancel_request_does_not_wait_forever_for_uncooperative_provider() -> None:
    task_manager = TaskIDManager.get_instance()
    task_id = task_manager.generate_task_id("kb_upload", "uncooperative-timeout")
    started = asyncio.Event()
    release = asyncio.Event()

    async def _uncooperative_provider() -> None:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()

    registry = KnowledgeTaskRegistry(cancel_wait_seconds=0.01)
    registry.start(task_id, "kb", _uncooperative_provider())
    await asyncio.wait_for(started.wait(), timeout=1)

    before = time.monotonic()
    assert await registry.cancel(task_id, kb_name="kb") is True
    assert time.monotonic() - before < 0.2
    assert task_manager.get_task_metadata(task_id)["status"] == "cancelled"

    release.set()
    record = registry.get(task_id)
    if record is not None:
        await asyncio.wait_for(record.task, timeout=1)


@pytest.mark.asyncio
async def test_event_loop_keeps_serving_while_an_upload_is_written(
    monkeypatch, tmp_path: Path
) -> None:
    """The regression itself: unrelated work must progress mid-write."""
    started = threading.Event()
    release = threading.Event()

    def _blocking_save(*_args: Any, **_kwargs: Any) -> tuple[list[str], list[str]]:
        started.set()
        release.wait(timeout=5)
        return ([], [])

    monkeypatch.setattr(knowledge_router, "_save_uploaded_files", _blocking_save)

    ticks = 0

    async def _other_request_traffic() -> None:
        nonlocal ticks
        while True:
            ticks += 1
            await asyncio.sleep(0.005)

    heartbeat = asyncio.create_task(_other_request_traffic())
    save = asyncio.create_task(knowledge_router._save_uploaded_files_off_loop([], tmp_path))
    try:
        await asyncio.to_thread(started.wait, 5)
        ticks_at_start = ticks
        await asyncio.sleep(0.05)
        assert ticks > ticks_at_start, "the event loop stalled while the upload was written"
    finally:
        release.set()
        heartbeat.cancel()
        await save


def test_recording_an_indexed_file_hash_runs_on_a_worker_thread(
    monkeypatch, tmp_path: Path
) -> None:
    """Re-hashes the whole file, once per indexed document."""
    monkeypatch.setenv("COGNIVOY_RAG_RETRIEVAL_PROFILE", "vector")
    kb_dir = tmp_path / "kb"
    raw_dir = kb_dir / "raw"
    raw_dir.mkdir(parents=True)
    version_dir = kb_dir / "version-1"
    version_dir.mkdir()
    (version_dir / "docstore.json").write_text("{}", encoding="utf-8")
    (version_dir / "index_store.json").write_text("{}", encoding="utf-8")
    (version_dir / "meta.json").write_text(
        json.dumps({"provider": "llamaindex", "signature": "llamaindex", "version": "version-1"}),
        encoding="utf-8",
    )
    doc = raw_dir / "ok.txt"
    doc.write_text("hello", encoding="utf-8")

    class _OkRagService:
        def __init__(self, *_args: Any, **_kwargs: Any) -> None:
            pass

        async def add_documents(self, *_args: Any, **_kwargs: Any) -> bool:
            return True

    monkeypatch.setattr("cognivoy.knowledge.add_documents.RAGService", _OkRagService)

    adder = DocumentAdder(kb_name="kb", base_dir=str(tmp_path))
    recorded: dict[str, int] = {}

    def _spy(file_path: Path) -> None:
        recorded["thread"] = threading.get_ident()

    monkeypatch.setattr(adder, "_record_successful_hash", _spy)

    result = asyncio.run(adder.process_new_documents([doc]))

    assert result.processed_files == [doc]
    assert recorded["thread"] != threading.get_ident()
