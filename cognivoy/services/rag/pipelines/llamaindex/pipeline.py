"""LlamaIndex-backed RAG pipeline orchestration."""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
import traceback
from typing import Any, Awaitable, Callable, Dict, List, Optional

from cognivoy.runtime.home import get_runtime_data_root
from cognivoy.services.embedding import get_embedding_config
from cognivoy.services.rag.embedding_signature import signature_from_embedding_config
from cognivoy.services.rag.index_versioning import (
    EmbeddingSignature,
    resolve_storage_dir_for_read,
    resolve_storage_dir_for_rebuild,
    write_version_meta,
)
from cognivoy.services.rag.kb_paths import resolve_kb_dir

from . import storage
from .config import default_top_k, keyword_enabled
from .document_loader import LlamaIndexDocumentLoader
from .errors import search_error_result


def _vector_adapter():
    try:
        from . import embedding_adapter
    except ModuleNotFoundError as exc:
        if exc.name and exc.name.split(".")[0] in {"llama_index", "nltk", "faiss"}:
            raise RuntimeError(
                "Vector/hybrid retrieval requires the optional vector dependencies. "
                "Install cognivoy[rag-llamaindex] (or cognivoy-cli[rag-llamaindex]), "
                "or select keyword retrieval. See SECURITY.md for optional dependency risks."
            ) from exc
        raise
    return embedding_adapter


def configure_llamaindex_settings(*args):
    return _vector_adapter().configure_llamaindex_settings(*args)


def set_progress_callback(callback):
    return _vector_adapter().set_progress_callback(callback)


async def verify_embedding_connectivity(*args):
    return await _vector_adapter().verify_embedding_connectivity(*args)


DEFAULT_KB_BASE_DIR = str(get_runtime_data_root() / "knowledge_bases")

SignatureProvider = Callable[[], EmbeddingSignature | None]
IsolatedRunner = Callable[..., Awaitable[Any]]


def _public_source_name(metadata: dict[str, Any], fallback: str) -> str:
    """Return a display-safe citation label, never a server filesystem path."""
    file_name = str(metadata.get("file_name") or "").strip()
    if file_name:
        return Path(file_name.replace("\\", "/")).name or fallback
    file_path = str(metadata.get("file_path") or "").strip()
    if file_path:
        return Path(file_path.replace("\\", "/")).name or fallback
    return str(metadata.get("title") or fallback)


class LlamaIndexPipeline:
    """Pipeline that indexes and retrieves KB content via LlamaIndex."""

    def __init__(
        self,
        kb_base_dir: Optional[str] = None,
        *,
        signature_provider: SignatureProvider | None = None,
        document_loader: LlamaIndexDocumentLoader | None = None,
        isolated_runner: IsolatedRunner | None = None,
    ):
        self.logger = logging.getLogger(__name__)
        self.kb_base_dir = kb_base_dir or DEFAULT_KB_BASE_DIR
        self._signature_provider = signature_provider or signature_from_embedding_config
        self.document_loader = document_loader or LlamaIndexDocumentLoader(self.logger)
        self._isolated_runner = isolated_runner
        self._configure_settings()

    async def _run_storage_isolated(
        self,
        *,
        qualname: str,
        args: tuple[Any, ...],
        kwargs: dict[str, Any] | None = None,
        timeout_seconds: float,
        progress_callback=None,
    ) -> Any:
        from cognivoy.services.process_isolation import (
            current_user_context_payload,
            run_in_killable_process,
        )

        runner = self._isolated_runner or run_in_killable_process
        call: dict[str, Any] = {
            "module": storage.__name__,
            "qualname": qualname,
            "args": args,
            "kwargs": dict(kwargs or {}),
            "timeout_seconds": timeout_seconds,
            "user_context": current_user_context_payload(),
        }
        if progress_callback is not None:
            call.update(
                {
                    "progress_kwarg": "progress_callback",
                    "on_progress": progress_callback,
                }
            )
        return await runner(**call)

    def _configure_settings(self) -> None:
        if not keyword_enabled():
            configure_llamaindex_settings(self.logger)

    async def _index_keyword(
        self, kb_name: str, file_paths: List[str], *, append: bool, progress_callback=None
    ) -> bool:
        documents = await self.document_loader.load(file_paths, include_images=False)
        if not documents:
            raise ValueError(
                "No searchable text was found. Image-only documents need text extraction."
            )
        await self._run_storage_isolated(
            qualname="create_keyword_index_isolated",
            args=(documents, str(resolve_kb_dir(self.kb_base_dir, kb_name))),
            kwargs={"append": append},
            timeout_seconds=3600,
            progress_callback=progress_callback,
        )
        return True

    async def _verify_embedding_connectivity(self) -> None:
        await verify_embedding_connectivity(self.logger)

    def _current_signature(self) -> EmbeddingSignature | None:
        return self._signature_provider()

    def _cleanup_failed_version_dir(self, storage_dir: Path, signature: Optional[Any]) -> None:
        _ = signature
        try:
            if storage.cleanup_failed_version_dir(storage_dir):
                self.logger.info(
                    f"Removed empty version dir after failed pipeline run: {storage_dir}"
                )
        except Exception as cleanup_exc:  # pragma: no cover - best-effort
            self.logger.warning(
                f"Could not clean up failed version dir for {storage_dir}: {cleanup_exc}"
            )

    async def initialize(self, kb_name: str, file_paths: List[str], **kwargs) -> bool:
        progress_callback = kwargs.get("progress_callback")
        if keyword_enabled():
            return await self._index_keyword(
                kb_name, file_paths, append=False, progress_callback=progress_callback
            )
        self._configure_settings()

        self.logger.info(
            f"Initializing KB '{kb_name}' with {len(file_paths)} files using LlamaIndex"
        )

        kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
        signature = self._current_signature()
        storage_dir = resolve_storage_dir_for_rebuild(kb_dir, signature)

        try:
            await self._verify_embedding_connectivity()
            documents = await self.document_loader.load(file_paths)
            if not documents:
                self.logger.error("No valid documents found")
                return False

            self.logger.info(
                f"Creating VectorStoreIndex with {len(documents)} documents "
                f"(chunking + embedding)..."
            )

            await self._run_storage_isolated(
                qualname="create_index_isolated",
                args=(documents, str(storage_dir)),
                kwargs={"show_progress": True},
                timeout_seconds=3600,
                progress_callback=progress_callback,
            )

            self.logger.info(f"Index persisted to {storage_dir}")
            if signature is not None:
                write_version_meta(kb_dir, signature, storage_dir=storage_dir)

            self.logger.info(f"KB '{kb_name}' initialized successfully with LlamaIndex")
            return True

        except Exception as exc:
            self.logger.error(f"Failed to initialize KB: {exc}")
            self.logger.error(traceback.format_exc())
            self._cleanup_failed_version_dir(storage_dir, signature)
            raise
        finally:
            set_progress_callback(None)

    async def search(
        self,
        query: str,
        kb_name: str,
        **kwargs,
    ) -> Dict[str, Any]:
        kwargs.pop("mode", None)
        if keyword_enabled():
            from .keyword import available

            kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
            if not await asyncio.to_thread(available, kb_dir):
                return {
                    "success": False,
                    "error": "No text index. Re-index this knowledge base.",
                    "answer": "No text index. Re-index this knowledge base.",
                    "needs_reindex": True,
                    "sources": [],
                    "provider": "llamaindex",
                    "retrieval_profile": "keyword",
                }
            try:
                nodes = await self._run_storage_isolated(
                    qualname="retrieve_keyword_payload",
                    args=(str(kb_dir), query),
                    kwargs={"top_k": kwargs.get("top_k") or default_top_k()},
                    timeout_seconds=60,
                )
                result = self._node_payload_to_result(query, nodes)
                result.update(
                    {"success": True, "retrieval_profile": "keyword", "model_required": False}
                )
                return result
            except Exception as exc:
                result = search_error_result(query, exc)
                result.update({"success": False, "retrieval_profile": "keyword"})
                return result
        self._configure_settings()
        self.logger.info(f"Searching KB '{kb_name}' with query: {query[:50]}...")

        kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
        signature = self._current_signature()
        storage_dir = resolve_storage_dir_for_read(kb_dir, signature)

        if storage_dir is None or not (storage_dir / "docstore.json").exists():
            self.logger.warning(
                f"No matching index found for KB '{kb_name}' at signature "
                f"{signature.hash() if signature else 'n/a'}"
            )
            return {
                "query": query,
                "answer": (
                    "This knowledge base has no index for the active embedding "
                    "model. Re-index it (or switch back to a previously-used "
                    "embedding model) before querying."
                ),
                "content": "",
                "provider": "llamaindex",
                "success": False,
                "needs_reindex": True,
            }

        embedding_mismatch_warning = self._embedding_mismatch_warning(kb_name)

        try:
            top_k = kwargs.get("top_k") or default_top_k()
            from cognivoy.services.config.network_policy import (
                get_outbound_network_policy,
            )

            nodes = await self._run_storage_isolated(
                qualname="retrieve_nodes_payload",
                args=(str(storage_dir), query),
                kwargs={"top_k": top_k},
                timeout_seconds=get_outbound_network_policy().timeout_seconds,
            )

            result = self._node_payload_to_result(query, nodes)
            if embedding_mismatch_warning:
                result["warning"] = embedding_mismatch_warning
            return result

        except Exception as exc:
            result = search_error_result(query, exc)
            if result.get("error_type"):
                log_message = result.get("log_message") or str(exc)
                self.logger.warning(f"Search failed ({result['error_type']}): {log_message}")
            else:
                self.logger.error(f"Search failed: {exc}")
                self.logger.error(traceback.format_exc())
            return result

    def _embedding_mismatch_warning(self, kb_name: str) -> str:
        try:
            cfg_path = Path(self.kb_base_dir) / "kb_config.json"
            if not cfg_path.exists():
                return ""
            with open(cfg_path, encoding="utf-8") as handle:
                kb_entry = json.load(handle).get("knowledge_bases", {}).get(kb_name, {})
            if not kb_entry.get("embedding_mismatch"):
                return ""
            stored = kb_entry.get("embedding_model", "unknown")
            current = get_embedding_config().model
            warning = (
                f"Warning: KB '{kb_name}' was indexed with '{stored}' "
                f"but current model is '{current}'. Re-index recommended."
            )
            self.logger.warning(warning)
            return warning
        except Exception:
            return ""

    def _nodes_to_result(self, query: str, nodes: list[Any]) -> Dict[str, Any]:
        context_parts: list[str] = []
        sources: list[dict[str, Any]] = []
        for i, node in enumerate(nodes):
            context_parts.append(node.node.text)
            meta = node.node.metadata or {}
            sources.append(
                {
                    "title": meta.get("file_name", meta.get("title", f"Document {i + 1}")),
                    "content": node.node.text[:200],
                    "source": _public_source_name(meta, f"Document {i + 1}"),
                    "page": meta.get("page_label", meta.get("page", "")),
                    "chunk_id": node.node.node_id or str(i),
                    "score": round(node.score, 4) if node.score is not None else "",
                }
            )

        content = "\n\n".join(context_parts) if context_parts else ""
        return {
            "query": query,
            "answer": content,
            "content": content,
            "sources": sources,
            "provider": "llamaindex",
        }

    def _node_payload_to_result(self, query: str, nodes: list[dict[str, Any]]) -> Dict[str, Any]:
        context_parts: list[str] = []
        sources: list[dict[str, Any]] = []
        for index, row in enumerate(nodes):
            text = str(row.get("text") or "")
            metadata = dict(row.get("metadata") or {})
            context_parts.append(text)
            score = row.get("score")
            sources.append(
                {
                    "title": metadata.get(
                        "file_name", metadata.get("title", f"Document {index + 1}")
                    ),
                    "content": text[:200],
                    "source": _public_source_name(metadata, f"Document {index + 1}"),
                    "page": metadata.get("page_label", metadata.get("page", "")),
                    "chunk_id": str(row.get("node_id") or index),
                    "score": round(float(score), 4) if score is not None else "",
                }
            )
        content = "\n\n".join(context_parts) if context_parts else ""
        return {
            "query": query,
            "answer": content,
            "content": content,
            "sources": sources,
            "provider": "llamaindex",
        }

    async def add_documents(self, kb_name: str, file_paths: List[str], **kwargs) -> bool:
        progress_callback = kwargs.get("progress_callback")
        if keyword_enabled():
            return await self._index_keyword(
                kb_name, file_paths, append=True, progress_callback=progress_callback
            )
        self._configure_settings()

        self.logger.info(f"Adding {len(file_paths)} documents to KB '{kb_name}' using LlamaIndex")

        kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
        signature = self._current_signature()
        plan = storage.resolve_add_storage_plan(kb_dir, signature)

        try:
            await self._verify_embedding_connectivity()
            documents = await self.document_loader.load(file_paths)
            if not documents:
                self.logger.warning("No valid documents to add")
                return False

            if plan.existing_storage is not None:
                self.logger.info(f"Loading existing index from {plan.existing_storage}...")
                num_added = await self._run_storage_isolated(
                    qualname="insert_documents_isolated",
                    args=(
                        str(plan.existing_storage),
                        str(plan.storage_dir),
                        documents,
                    ),
                    timeout_seconds=3600,
                    progress_callback=progress_callback,
                )
                self.logger.info(f"Added {num_added} documents to existing index")
                if signature is not None and plan.storage_dir != plan.existing_storage:
                    write_version_meta(kb_dir, signature, storage_dir=plan.storage_dir)
            else:
                self.logger.info(f"Creating new index with {len(documents)} documents...")
                plan.storage_dir.mkdir(parents=True, exist_ok=True)
                num_added = await self._run_storage_isolated(
                    qualname="create_index_isolated",
                    args=(documents, str(plan.storage_dir)),
                    kwargs={"show_progress": True},
                    timeout_seconds=3600,
                    progress_callback=progress_callback,
                )
                self.logger.info(f"Created new index with {num_added} documents")
                if signature is not None:
                    write_version_meta(kb_dir, signature, storage_dir=plan.storage_dir)

            self.logger.info(f"Successfully added documents to KB '{kb_name}'")
            return True

        except Exception as exc:
            self.logger.error(f"Failed to add documents: {exc}")
            self.logger.error(traceback.format_exc())
            if plan.existing_storage is None or plan.storage_dir != plan.existing_storage:
                self._cleanup_failed_version_dir(plan.storage_dir, signature)
            raise
        finally:
            set_progress_callback(None)

    async def delete(self, kb_name: str) -> bool:
        kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
        deleted = storage.delete_kb_dir(kb_dir)
        if deleted:
            self.logger.info(f"Deleted KB '{kb_name}'")
        return deleted
