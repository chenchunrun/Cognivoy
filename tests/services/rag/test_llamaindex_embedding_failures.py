from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest

from tests.services.rag.isolated_runner import inline_isolated_runner


@pytest.fixture
def vector_retrieval(monkeypatch: pytest.MonkeyPatch) -> None:
    """Opt only vector-search regressions into the optional embedding path."""
    monkeypatch.setenv("COGNIVOY_RAG_RETRIEVAL_PROFILE", "vector")


def test_custom_embedding_rejects_null_coordinates(monkeypatch: pytest.MonkeyPatch) -> None:
    from cognivoy.services.rag.pipelines.llamaindex import (
        embedding_adapter as embedding_module,
    )

    class _FakeClient:
        config = SimpleNamespace(binding="openai", model="bad-embed")

        async def embed(self, texts, progress_callback=None, *, input_type=None):
            del progress_callback, input_type
            return [[0.1, None, 0.3] for _ in texts]

    monkeypatch.setattr(embedding_module, "get_embedding_client", lambda: _FakeClient())

    embedding = embedding_module.CustomEmbedding()

    with pytest.raises(ValueError, match="dimension 1 is null"):
        embedding._get_text_embeddings(["chunk"])


def test_custom_embedding_refreshes_stale_client(monkeypatch: pytest.MonkeyPatch) -> None:
    from cognivoy.services.rag.pipelines.llamaindex import (
        embedding_adapter as embedding_module,
    )

    class _FakeClient:
        def __init__(self, model: str, value: float) -> None:
            self.config = SimpleNamespace(
                binding="openai",
                model=model,
                dim=1,
                effective_url="https://example.test/v1/embeddings",
                base_url="https://example.test/v1/embeddings",
                api_version=None,
                send_dimensions=None,
            )
            self.value = value
            self.calls: list[list[str]] = []

        async def embed(self, texts, progress_callback=None, *, input_type=None):
            del progress_callback, input_type
            self.calls.append(list(texts))
            return [[self.value] for _ in texts]

    old_client = _FakeClient("old-embed", 1.0)
    new_client = _FakeClient("new-embed", 2.0)
    active_client = {"value": old_client}
    monkeypatch.setattr(
        embedding_module,
        "get_embedding_client",
        lambda config=None: active_client["value"],
    )

    embedding = embedding_module.CustomEmbedding()
    active_client["value"] = new_client

    assert embedding._get_query_embedding("hello") == [2.0]
    assert old_client.calls == []
    assert new_client.calls == [["hello"]]


def test_connection_failure_is_localized_and_hides_isolated_traceback() -> None:
    from cognivoy.services.rag.pipelines.llamaindex.errors import search_error_result

    result = search_error_result(
        "CISA 五个领域是什么？",
        RuntimeError(
            "ConnectionError: Cannot connect to Ollama at http://127.0.0.1:11434/api/embed. "
            "[isolated worker]\nTraceback (most recent call last):\nFile '/private/app.py'"
        ),
    )

    assert result["error_type"] == "embedding_service_unavailable"
    assert "无法连接嵌入服务" in result["answer"]
    assert "Traceback" not in result["answer"]
    assert "127.0.0.1" not in result["answer"]
    assert "private/app.py" not in result["error"]


def test_unknown_retrieval_failure_uses_safe_generic_message() -> None:
    from cognivoy.services.rag.pipelines.llamaindex.errors import search_error_result

    result = search_error_result("question", RuntimeError("secret-token at /private/path"))

    assert result["error_type"] == "retrieval_failed"
    assert "secret-token" not in result["answer"]
    assert "/private/path" not in result["error"]


def test_invalid_embedding_response_hides_provider_payload() -> None:
    from cognivoy.services.rag.pipelines.llamaindex.errors import search_error_result

    result = search_error_result(
        "检索 CISA",
        ValueError("embedding provider returned invalid vector: api-key=secret"),
    )

    assert result["error_type"] == "invalid_embedding_provider_response"
    assert "无效向量" in result["answer"]
    assert "api-key" not in result["answer"]
    assert "secret" not in result["error"]


@pytest.mark.asyncio
async def test_search_returns_reindex_hint_for_null_vector_index(
    tmp_path, monkeypatch: pytest.MonkeyPatch, vector_retrieval
) -> None:
    from cognivoy.services.rag.pipelines.llamaindex import storage as storage_module
    from cognivoy.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline

    storage_dir = tmp_path / "kb" / "version-1"
    storage_dir.mkdir(parents=True)
    (storage_dir / "docstore.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(
        LlamaIndexPipeline,
        "_configure_settings",
        lambda self: None,
    )
    monkeypatch.setattr(
        storage_module,
        "retrieve_nodes",
        lambda storage_dir, query, top_k=5: (_ for _ in ()).throw(
            TypeError("unsupported operand type(s) for *: 'NoneType' and 'float'")
        ),
    )

    pipeline = LlamaIndexPipeline(
        kb_base_dir=str(tmp_path),
        signature_provider=lambda: None,
        isolated_runner=inline_isolated_runner,
    )

    result = await pipeline.search("what is this?", "kb")

    assert result["error_type"] == "invalid_embedding_index"
    assert result["needs_reindex"] is True
    assert "Re-index the knowledge base" in result["answer"]
    assert "unsupported operand" not in result["answer"]


@pytest.mark.asyncio
async def test_search_uses_killable_storage_worker(
    tmp_path, monkeypatch: pytest.MonkeyPatch, vector_retrieval
) -> None:
    from cognivoy.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline

    storage_dir = tmp_path / "kb" / "version-1"
    storage_dir.mkdir(parents=True)
    (storage_dir / "docstore.json").write_text("{}", encoding="utf-8")
    calls: list[dict] = []

    async def isolated_runner(**kwargs):
        calls.append(kwargs)
        return [
            {
                "text": "grounded text",
                "metadata": {"file_name": "source.pdf", "page": 2},
                "node_id": "chunk-1",
                "score": 0.9,
            }
        ]

    monkeypatch.setattr(LlamaIndexPipeline, "_configure_settings", lambda self: None)
    pipeline = LlamaIndexPipeline(
        kb_base_dir=str(tmp_path),
        signature_provider=lambda: None,
        isolated_runner=isolated_runner,
    )

    result = await pipeline.search("question", "kb")

    assert calls[0]["qualname"] == "retrieve_nodes_payload"
    assert result["content"] == "grounded text"
    assert result["sources"][0]["chunk_id"] == "chunk-1"


def test_retrieve_nodes_rejects_invalid_persisted_embeddings(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from cognivoy.services.rag.pipelines.llamaindex import storage as storage_module

    class _RetrieverShouldNotRun:
        def retrieve(self, query: str):  # pragma: no cover - assertion helper
            raise AssertionError("retriever should not run for invalid persisted vectors")

    fake_index = SimpleNamespace(
        vector_store=SimpleNamespace(
            data=SimpleNamespace(embedding_dict={"bad-node": [0.1, None, 0.3]})
        ),
        as_retriever=lambda similarity_top_k=5: _RetrieverShouldNotRun(),
    )

    monkeypatch.setattr(storage_module.vector_store, "load_index", lambda _dir: fake_index)

    with pytest.raises(ValueError, match="RAG index contains invalid embedding vectors"):
        storage_module.retrieve_nodes(tmp_path, "what is this?")


def test_validate_storage_embeddings_rejects_invalid_vector_file(tmp_path) -> None:
    from cognivoy.services.rag.pipelines.llamaindex import storage as storage_module

    (tmp_path / "default__vector_store.json").write_text(
        json.dumps({"embedding_dict": {"bad-node": [0.1, None, 0.3]}}),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="RAG index contains invalid embedding vectors"):
        storage_module.validate_storage_embeddings(tmp_path)


def test_retrieve_nodes_checks_storage_context_vector_stores(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from cognivoy.services.rag.pipelines.llamaindex import storage as storage_module

    class _RetrieverShouldNotRun:
        def retrieve(self, query: str):  # pragma: no cover - assertion helper
            raise AssertionError("retriever should not run for invalid persisted vectors")

    fake_index = SimpleNamespace(
        vector_store=SimpleNamespace(data=SimpleNamespace(embedding_dict={})),
        storage_context=SimpleNamespace(
            vector_stores={
                "default": SimpleNamespace(
                    data=SimpleNamespace(embedding_dict={"bad-node": [0.1, None, 0.3]})
                )
            }
        ),
        as_retriever=lambda similarity_top_k=5: _RetrieverShouldNotRun(),
    )

    monkeypatch.setattr(storage_module.vector_store, "load_index", lambda _dir: fake_index)

    with pytest.raises(ValueError, match="RAG index contains invalid embedding vectors"):
        storage_module.retrieve_nodes(tmp_path, "what is this?")


@pytest.mark.asyncio
async def test_search_reconfigures_llamaindex_settings_for_cached_pipeline(
    tmp_path, monkeypatch: pytest.MonkeyPatch, vector_retrieval
) -> None:
    from cognivoy.services.rag.pipelines.llamaindex import storage as storage_module
    from cognivoy.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline

    storage_dir = tmp_path / "kb" / "version-1"
    storage_dir.mkdir(parents=True)
    (storage_dir / "docstore.json").write_text("{}", encoding="utf-8")

    configure_calls: list[str] = []
    monkeypatch.setattr(
        LlamaIndexPipeline,
        "_configure_settings",
        lambda self: configure_calls.append("configure"),
    )
    monkeypatch.setattr(storage_module, "retrieve_nodes", lambda *_args, **_kwargs: [])

    pipeline = LlamaIndexPipeline(
        kb_base_dir=str(tmp_path),
        signature_provider=lambda: None,
        isolated_runner=inline_isolated_runner,
    )
    result = await pipeline.search("what is this?", "kb")

    assert result["provider"] == "llamaindex"
    assert configure_calls == ["configure", "configure"]


@pytest.mark.asyncio
async def test_rag_service_hides_low_level_invalid_index_error_in_raw_logs(
    tmp_path, monkeypatch: pytest.MonkeyPatch, vector_retrieval
) -> None:
    from cognivoy.services.rag.pipelines.llamaindex import storage as storage_module
    from cognivoy.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline
    from cognivoy.services.rag.service import RAGService

    storage_dir = tmp_path / "kb" / "version-1"
    storage_dir.mkdir(parents=True)
    (storage_dir / "docstore.json").write_text("{}", encoding="utf-8")

    monkeypatch.setattr(
        LlamaIndexPipeline,
        "_configure_settings",
        lambda self: None,
    )
    monkeypatch.setattr(
        storage_module,
        "retrieve_nodes",
        lambda storage_dir, query, top_k=5: (_ for _ in ()).throw(
            TypeError("unsupported operand type(s) for *: 'NoneType' and 'float'")
        ),
    )

    pipeline = LlamaIndexPipeline(
        kb_base_dir=str(tmp_path),
        signature_provider=lambda: None,
        isolated_runner=inline_isolated_runner,
    )
    service = RAGService(kb_base_dir=str(tmp_path))
    service._pipelines["llamaindex"] = pipeline
    events: list[tuple[str, str, dict]] = []

    async def event_sink(event_type: str, message: str, metadata: dict) -> None:
        events.append((event_type, message, metadata))

    result = await service.search("what is this?", "kb", event_sink=event_sink)
    await asyncio.sleep(0)

    raw_logs = [message for event_type, message, _ in events if event_type == "raw_log"]
    assert result["error_type"] == "invalid_embedding_index"
    assert any("Search failed (invalid_embedding_index)" in message for message in raw_logs)
    assert not any("unsupported operand" in message for message in raw_logs)
    assert any(
        metadata.get("call_state") == "error" and metadata.get("needs_reindex") is True
        for event_type, _, metadata in events
        if event_type == "status"
    )
    assert not any(
        message.startswith("Retrieved ")
        for event_type, message, _ in events
        if event_type == "status"
    )
