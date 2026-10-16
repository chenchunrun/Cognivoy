"""Error normalization for LlamaIndex-backed RAG retrieval."""

from __future__ import annotations

from typing import Any, Dict


def _uses_chinese(query: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in query)


def _localized(query: str, *, zh: str, en: str) -> str:
    return zh if _uses_chinese(query) else en


def search_error_result(query: str, exc: Exception) -> Dict[str, Any]:
    """Convert retrieval failures into actionable tool output."""
    message = str(exc)
    lower = message.lower()

    connection_markers = (
        "cannot connect to ollama",
        "all connection attempts failed",
        "connection refused",
        "connecterror",
    )
    if any(marker in lower for marker in connection_markers):
        safe_message = _localized(
            query,
            zh="知识库检索暂时不可用：无法连接嵌入服务。请检查服务状态后重试。",
            en=(
                "Knowledge-base retrieval is temporarily unavailable because "
                "the embedding service could not be reached. Check the service and retry."
            ),
        )
        return {
            "query": query,
            "answer": safe_message,
            "content": "",
            "provider": "llamaindex",
            "error": safe_message,
            "error_type": "embedding_service_unavailable",
            "log_message": "Embedding service connection failed during retrieval.",
        }

    if "embedding provider returned invalid" in lower:
        safe_message = _localized(
            query,
            zh="知识库检索失败：嵌入服务返回了无效向量。请检查嵌入模型配置后重试。",
            en=(
                "Knowledge-base retrieval failed because the embedding service "
                "returned an invalid vector. Check the embedding model and retry."
            ),
        )
        return {
            "query": query,
            "answer": safe_message,
            "content": "",
            "provider": "llamaindex",
            "error": safe_message,
            "error_type": "invalid_embedding_provider_response",
            "log_message": (
                "Embedding provider returned an invalid query vector; check "
                "the embedding provider/model configuration."
            ),
        }

    null_vector_similarity_error = (
        "unsupported operand type(s) for *" in lower and "nonetype" in lower and "float" in lower
    )
    shape_vector_error = "inhomogeneous shape" in lower or (
        "shapes" in lower and "not aligned" in lower
    )
    invalid_persisted_index = "rag index contains invalid embedding vectors" in lower
    if null_vector_similarity_error or shape_vector_error or invalid_persisted_index:
        return {
            "query": query,
            "answer": (
                "RAG search failed because this knowledge base index contains "
                "invalid embedding vectors. Re-index the knowledge base with "
                "the current embedding provider/model before querying it again."
            ),
            "content": "",
            "provider": "llamaindex",
            "error": message,
            "error_type": "invalid_embedding_index",
            "log_message": "RAG index contains invalid embedding vectors; re-index required.",
            "needs_reindex": True,
        }

    safe_message = _localized(
        query,
        zh="知识库检索暂时失败。请重试；如果问题持续，请检查索引与嵌入服务状态。",
        en=(
            "Knowledge-base retrieval failed temporarily. Retry, then check the "
            "index and embedding service if the problem continues."
        ),
    )
    return {
        "query": query,
        "answer": safe_message,
        "content": "",
        "provider": "llamaindex",
        "error": safe_message,
        "error_type": "retrieval_failed",
        "log_message": f"{type(exc).__name__}: retrieval failed.",
    }
