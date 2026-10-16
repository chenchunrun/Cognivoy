"""LightRAG-backed RAG pipeline orchestration.

Implements the same contract as :class:`LlamaIndexPipeline` (see
``..base.RAGPipeline``) but delegates indexing/retrieval to RAG-Anything /
LightRAG. Each KB owns a self-contained LightRAG store under its ``version-N``
directory (see ``storage``).

Documents are turned into a MinerU-style ``content_list`` by Cognivoy's shared
parse layer (``cognivoy/services/parsing``) — the same bridge the question
extractor uses — so multimodal parsing stays a decoupled, cached, engine-
pluggable concern and this pipeline only ever feeds LightRAG ready content.

LightRAG is an optional dependency: every method fails with a clear, actionable
message when it is not installed instead of an opaque ``ImportError``.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import inspect
import logging
from pathlib import Path
import shutil
import traceback
from typing import Any, Dict, List, Optional

from cognivoy.runtime.home import get_runtime_data_root
from cognivoy.services.rag.index_versioning import (
    resolve_storage_dir_for_read,
    resolve_storage_dir_for_rebuild,
)
from cognivoy.services.rag.kb_paths import resolve_kb_dir

from . import config as lr_config
from . import engine, storage
from .worker import OwnerLoopBridge

logger = logging.getLogger(__name__)

DEFAULT_KB_BASE_DIR = str(get_runtime_data_root() / "knowledge_bases")


async def _index_isolated_worker(
    working_dir: str,
    file_paths: list[str],
    *,
    progress_callback=None,
) -> int:
    """Spawn-safe LightRAG indexing entrypoint.

    The complete parser + native storage + provider stack lives in the child,
    so cancelling the parent can terminate even code currently blocked inside
    a third-party SDK or local vector-store merge.
    """

    from cognivoy.services.parsing import ParserError, get_parse_service

    rag = engine.build_rag(Path(working_dir))
    parser = get_parse_service()
    inserted = 0
    total = len(file_paths)
    for file_path in file_paths:
        path = Path(file_path)
        try:
            document = parser.parse(path)
        except ParserError as exc:
            logger.warning("LightRAG: parse failed for %s: %s", path.name, exc)
            continue
        content_list = document.blocks or (
            [{"type": "text", "text": document.markdown, "page_idx": 0}]
            if document.markdown
            else []
        )
        if not content_list:
            logger.warning("LightRAG: empty document skipped: %s", path.name)
            continue
        await engine.insert(
            rag,
            content_list,
            file_name=path.name,
            doc_id=document.source_hash or path.stem,
        )
        doc_error = storage.document_error(Path(rag.working_dir), document.source_hash or path.stem)
        if doc_error:
            raise RuntimeError(f"{path.name}: {doc_error}")
        inserted += 1
        if progress_callback is not None:
            progress_result = progress_callback(inserted, total)
            if inspect.isawaitable(progress_result):
                await progress_result
    return inserted


async def _search_isolated_worker(
    working_dir: str,
    query: str,
    mode: str,
) -> dict[str, Any]:
    rag = engine.build_rag(Path(working_dir))
    answer, sources = await engine.query_with_sources(rag, query, mode)
    return {"answer": answer, "sources": sources}


class LightRagPipeline:
    """Index/retrieve KB content via RAG-Anything / LightRAG."""

    def __init__(
        self,
        kb_base_dir: Optional[str] = None,
        *,
        isolated_runner=None,
        **_: Any,
    ) -> None:
        self.logger = logging.getLogger(__name__)
        self.kb_base_dir = kb_base_dir or DEFAULT_KB_BASE_DIR
        self._isolated_runner = isolated_runner

    # ----- helpers --------------------------------------------------------

    def _ensure_available(self) -> None:
        if not lr_config.is_lightrag_available():
            raise lr_config.LightRagNotAvailableError(
                "LightRAG is not installed. Install it with "
                "Local RAG-Anything is temporarily disabled because its parser stack "
                "pins dependencies with known security issues. Connect a secured "
                "LightRAG Server knowledge base instead."
            )

    def _resolve_mode(self, kb_name: str, kwargs: dict[str, Any]) -> str:
        from ..modes import resolve_kb_mode

        return resolve_kb_mode(
            self.kb_base_dir,
            kb_name,
            storage.PROVIDER,
            explicit=kwargs.get("mode"),
            supported=lr_config.SUPPORTED_MODES,
            default=lr_config.DEFAULT_MODE,
        )

    def _cleanup_failed_version_dir(self, root_dir: Path) -> None:
        try:
            if root_dir.is_dir() and not (root_dir / storage.META_FILENAME).exists():
                shutil.rmtree(root_dir)
        except Exception as exc:  # pragma: no cover - best-effort
            self.logger.warning("Could not clean up failed version dir %s: %s", root_dir, exc)

    async def _ingest(
        self,
        rag: Any,
        file_paths: List[str],
        *,
        io_bridge: OwnerLoopBridge,
        progress_callback: Callable[[int, int], Any] | None = None,
    ) -> int:
        """Parse each file via the shared parse layer and insert it into LightRAG.

        Returns the number of documents successfully inserted. Per-file failures
        are logged and skipped so one bad document doesn't abort the batch.
        """
        from cognivoy.services.parsing import ParserError, get_parse_service

        parse_service = get_parse_service()
        inserted = 0
        total = len(file_paths)
        for file_path in file_paths:
            io_bridge.raise_if_cancelled()
            path = Path(file_path)
            try:
                doc = parse_service.parse(path)
            except ParserError as exc:
                self.logger.warning("LightRAG: parse failed for %s: %s", path.name, exc)
                continue

            content_list = doc.blocks or (
                [{"type": "text", "text": doc.markdown, "page_idx": 0}] if doc.markdown else []
            )
            if not content_list:
                self.logger.warning("LightRAG: empty document skipped: %s", path.name)
                continue

            await engine.insert(
                rag,
                content_list,
                file_name=path.name,
                doc_id=doc.source_hash or path.stem,
            )
            io_bridge.raise_if_cancelled()
            doc_error = storage.document_error(Path(rag.working_dir), doc.source_hash or path.stem)
            if doc_error:
                raise RuntimeError(f"{path.name}: {doc_error}")
            inserted += 1
            self.logger.info("LightRAG: inserted %s", path.name)
            if progress_callback is not None:
                await io_bridge.call(progress_callback, inserted, total)
        return inserted

    async def _run_indexing(
        self,
        working_dir: Path,
        file_paths: List[str],
        progress_callback: Callable[[int, int], Any] | None,
    ) -> int:
        """Run the complete local LightRAG indexing phase in a killable child."""

        from cognivoy.services.process_isolation import (
            current_user_context_payload,
            run_in_killable_process,
        )

        runner = self._isolated_runner or run_in_killable_process
        call: dict[str, Any] = {
            "module": __name__,
            "qualname": "_index_isolated_worker",
            "args": (str(working_dir), list(file_paths)),
            "timeout_seconds": 3600,
            "user_context": current_user_context_payload(),
        }
        if progress_callback is not None:
            call.update(
                {
                    "progress_kwarg": "progress_callback",
                    "on_progress": progress_callback,
                }
            )
        return int(await runner(**call))

    # ----- indexing -------------------------------------------------------

    async def initialize(self, kb_name: str, file_paths: List[str], **kwargs) -> bool:
        self._ensure_available()
        progress_callback = kwargs.get("progress_callback")
        kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
        root_dir = resolve_storage_dir_for_rebuild(kb_dir, None)
        self.logger.info(
            "Initializing KB '%s' with %d file(s) using LightRAG", kb_name, len(file_paths)
        )
        try:
            count = await self._run_indexing(
                storage.working_dir(root_dir), file_paths, progress_callback
            )
            if count == 0:
                self.logger.error("LightRAG: no extractable documents for '%s'", kb_name)
                self._cleanup_failed_version_dir(root_dir)
                return False
            if not storage.has_output(root_dir):
                details = storage.failure_summary(root_dir)
                message = f"LightRAG did not produce a ready index for '{kb_name}'"
                if details:
                    message = f"{message}: {details}"
                self.logger.error(message)
                self._cleanup_failed_version_dir(root_dir)
                raise RuntimeError(message)
            storage.write_meta(root_dir)
            self.logger.info("KB '%s' initialized with LightRAG (%d docs)", kb_name, count)
            return True
        except asyncio.CancelledError:
            self._cleanup_failed_version_dir(root_dir)
            raise
        except Exception as exc:
            self.logger.error("Failed to initialize LightRAG KB: %s", exc)
            self.logger.error(traceback.format_exc())
            self._cleanup_failed_version_dir(root_dir)
            raise

    async def add_documents(self, kb_name: str, file_paths: List[str], **kwargs) -> bool:
        self._ensure_available()
        progress_callback = kwargs.get("progress_callback")
        kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
        existing = resolve_storage_dir_for_read(kb_dir, None)
        if existing is not None and storage.has_output(existing):
            is_update = True
            root_dir = existing
        else:
            is_update = False
            root_dir = resolve_storage_dir_for_rebuild(kb_dir, None)

        self.logger.info(
            "Adding %d document(s) to LightRAG KB '%s' (update=%s)",
            len(file_paths),
            kb_name,
            is_update,
        )
        try:
            count = await self._run_indexing(
                storage.working_dir(root_dir), file_paths, progress_callback
            )
            if count == 0:
                self.logger.warning("LightRAG: no extractable documents to add for '%s'", kb_name)
                return False
            if not storage.has_output(root_dir):
                details = storage.failure_summary(root_dir)
                message = f"LightRAG did not produce a ready index for '{kb_name}'"
                if details:
                    message = f"{message}: {details}"
                self.logger.error(message)
                if not is_update:
                    self._cleanup_failed_version_dir(root_dir)
                raise RuntimeError(message)
            storage.write_meta(root_dir)
            self.logger.info("Added %d doc(s) to LightRAG KB '%s'", count, kb_name)
            return True
        except asyncio.CancelledError:
            if not is_update:
                self._cleanup_failed_version_dir(root_dir)
            raise
        except Exception as exc:
            self.logger.error("Failed to add documents to LightRAG KB: %s", exc)
            self.logger.error(traceback.format_exc())
            if not is_update:
                self._cleanup_failed_version_dir(root_dir)
            raise

    # ----- retrieval ------------------------------------------------------

    async def search(self, query: str, kb_name: str, **kwargs) -> Dict[str, Any]:
        kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
        root_dir = resolve_storage_dir_for_read(kb_dir, None)

        if root_dir is None or not storage.has_output(root_dir):
            return {
                "query": query,
                "answer": (
                    "This LightRAG knowledge base has no index yet. Add documents before querying."
                ),
                "content": "",
                "sources": [],
                "provider": storage.PROVIDER,
                "needs_reindex": True,
            }

        mode = self._resolve_mode(kb_name, kwargs)
        try:
            self._ensure_available()
            from cognivoy.services.config.network_policy import (
                get_outbound_network_policy,
            )
            from cognivoy.services.process_isolation import (
                current_user_context_payload,
                run_in_killable_process,
            )

            runner = self._isolated_runner or run_in_killable_process
            result = await runner(
                module=__name__,
                qualname="_search_isolated_worker",
                args=(str(storage.working_dir(root_dir)), query, mode),
                timeout_seconds=get_outbound_network_policy().timeout_seconds,
                user_context=current_user_context_payload(),
            )
        except lr_config.LightRagNotAvailableError as exc:
            return self._error_result(query, exc, error_type="not_configured")
        except Exception as exc:
            self.logger.error("LightRAG search failed: %s", exc)
            self.logger.error(traceback.format_exc())
            return self._error_result(query, exc, error_type="retrieval_error")

        answer = str(result.get("answer") or "") if isinstance(result, dict) else str(result)
        sources = result.get("sources") if isinstance(result, dict) else []
        return {
            "query": query,
            "answer": answer,
            "content": answer,
            "sources": sources if isinstance(sources, list) else [],
            "provider": storage.PROVIDER,
            "mode": mode,
        }

    def _error_result(self, query: str, exc: Exception, *, error_type: str) -> Dict[str, Any]:
        return {
            "query": query,
            "answer": str(exc),
            "content": "",
            "sources": [],
            "provider": storage.PROVIDER,
            "error_type": error_type,
        }

    # ----- lifecycle ------------------------------------------------------

    async def delete(self, kb_name: str, **kwargs) -> bool:
        kb_dir = resolve_kb_dir(self.kb_base_dir, kb_name)
        if kb_dir.exists():
            shutil.rmtree(kb_dir)
            self.logger.info("Deleted LightRAG KB '%s'", kb_name)
            return True
        return False


__all__ = ["LightRagPipeline"]
