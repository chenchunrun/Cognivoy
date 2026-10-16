"""API regressions for model-free KB reindex, failure status and freshness."""

from __future__ import annotations

from contextlib import nullcontext
import importlib
from types import SimpleNamespace

from fastapi import BackgroundTasks, HTTPException
import pytest

from cognivoy.knowledge.manager import KnowledgeBaseManager
from cognivoy.services.rag import embedding_signature
from cognivoy.services.rag.pipelines.llamaindex import keyword
from cognivoy.services.rag.pipelines.llamaindex.document_loader import TextDocument as Document

router = importlib.import_module("cognivoy.api.routers.knowledge")


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setenv("COGNIVOY_RAG_RETRIEVAL_PROFILE", "keyword")
    monkeypatch.setattr(KnowledgeBaseManager, "_sync_kb_to_pb", lambda *_: None)
    instance = KnowledgeBaseManager(base_dir=str(tmp_path))
    instance.config["knowledge_bases"] = {
        "course": {"rag_provider": "llamaindex", "status": "ready"}
    }
    instance._save_config()
    raw = tmp_path / "course" / "raw"
    raw.mkdir(parents=True)
    source = raw / "course.txt"
    source.write_text(
        "CISA auditing controls rely on sufficient evidence and well documented risk assessment."
    )
    keyword.index_documents(
        [
            Document(
                text=source.read_text(),
                metadata={
                    "file_path": str(source),
                    "file_name": source.name,
                },
            )
        ],
        str(raw.parent),
    )
    monkeypatch.setattr(router, "_writable_kb", lambda _name: (instance, "course", tmp_path))
    monkeypatch.setattr(router, "_readable_kb", lambda _name: (instance, "course"))
    monkeypatch.setattr(router, "_assert_index_preflight", lambda *_: None)
    monkeypatch.setattr(router, "_assert_provider_ready", lambda *_: None)
    return instance


@pytest.mark.asyncio
async def test_keyword_reindex_queues_without_reading_embedding_or_noop(manager, monkeypatch):
    monkeypatch.setattr(
        embedding_signature,
        "signature_from_embedding_config",
        lambda: pytest.fail("keyword reindex must not resolve embedding"),
    )
    calls = []

    def start(task_id, kb_name, coroutine):
        calls.append((task_id, kb_name))
        coroutine.close()

    monkeypatch.setattr(router, "_start_knowledge_task", start)
    monkeypatch.setattr(router, "_mark_kb_queued_for_processing", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        router,
        "get_task_stream_manager",
        lambda: type("Stream", (), {"ensure_task": lambda *_: None})(),
    )
    response = await router.reindex_knowledge_base("course", BackgroundTasks())
    assert response["signature"] == "keyword"
    assert response["noop"] is False
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_keyword_delete_source_without_hash_ledger_marks_rebuild(manager, monkeypatch):
    source = manager.base_dir / "course" / "raw" / "course.txt"
    monkeypatch.setattr(router, "_resolve_kb_raw_file_or_404", lambda *_: source)
    response = await router.delete_kb_file("course", "course.txt")
    assert response["was_indexed"]
    entry = manager._load_config()["knowledge_bases"]["course"]
    assert entry["needs_reindex"]
    assert entry["reindex_reason"] == "source_changed"
    assert not source.exists()


@pytest.mark.asyncio
async def test_keyword_api_probes_reject_explicit_unsuccessful_results(manager, monkeypatch):
    service = importlib.import_module("cognivoy.services.rag.service")

    class FailedRAG:
        def __init__(self, **_kwargs):
            pass

        async def search(self, *_args, **_kwargs):
            return {"success": False, "sources": []}

    monkeypatch.setattr(service, "RAGService", FailedRAG)
    result = await router.run_retrieval_quality_probe("course")
    assert result["quality"] == "unavailable"
    with pytest.raises(HTTPException) as failure:
        await router.inspect_index_fragments(
            "course", router.IndexFragmentsRequest(query="CISA", top_k=5)
        )
    assert failure.value.status_code == 409


@pytest.mark.asyncio
async def test_keyword_background_reindex_accepts_document_progress(manager, monkeypatch):
    statuses = []
    messages = []
    task_manager = SimpleNamespace(update_task_status=lambda *args, **kwargs: statuses.append(args))
    stream = SimpleNamespace(ensure_task=lambda *_: None, emit_complete=lambda *_: None)
    monkeypatch.setattr(router.TaskIDManager, "get_instance", lambda: task_manager)
    monkeypatch.setattr(router, "get_task_stream_manager", lambda: stream)
    monkeypatch.setattr(router, "capture_task_logs", lambda *_: nullcontext())
    monkeypatch.setattr(router, "_task_log", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(router, "get_kb_manager", lambda: manager)
    monkeypatch.setattr(
        router,
        "ProgressTracker",
        lambda *_: SimpleNamespace(
            update=lambda *args, **kwargs: messages.append(args[1]),
        ),
    )

    class TextRAG:
        def __init__(self, **_kwargs):
            pass

        async def initialize(self, *, progress_callback, **_kwargs):
            progress_callback(1, 1, "Indexing text without an embedding model")
            return True

    monkeypatch.setattr(
        importlib.import_module("cognivoy.services.rag.service"), "RAGService", TextRAG
    )
    await router.run_reindex_task("course", str(manager.base_dir), "keyword-test", "keyword")
    assert statuses[-1] == ("keyword-test", "completed")
    assert any("Indexing text documents" in message for message in messages)
    assert all("Embedding batches" not in message for message in messages)
