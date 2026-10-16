"""
Co-Writer Document Storage
==========================

Per-document directory + manifest persistence with atomic writes.

Layout (relative to ``data/user/workspace/co-writer/``)::

    documents/
    ├── doc_{doc_id}/
    │   └── manifest.json   # { id, title, content, revision, created_at, updated_at }
    └── doc_{doc_id2}/
        └── manifest.json
"""

from __future__ import annotations

import difflib
import json
import logging
from pathlib import Path
import shutil
import threading
import time
from typing import Any
import uuid

from pydantic import BaseModel, Field

from cognivoy.services.file_io import atomic_write_text as _atomic_write_text
from cognivoy.services.path_service import get_path_service

logger = logging.getLogger(__name__)
_storage_lock = threading.RLock()
_REVISION_HISTORY_LIMIT = 100


class CoWriterDocument(BaseModel):
    """Lightweight document model for Co-Writer projects."""

    id: str
    title: str = ""
    content: str = ""
    revision: int = Field(default=1, ge=1)
    created_at: float = Field(default_factory=lambda: time.time())
    updated_at: float = Field(default_factory=lambda: time.time())


class CoWriterDocumentSummary(BaseModel):
    """Summary view (without full content) used for list endpoints."""

    id: str
    title: str
    created_at: float
    updated_at: float
    preview: str = ""


class CoWriterDocumentRevision(BaseModel):
    """Immutable snapshot used by the document's user-visible history."""

    revision: int = Field(ge=1)
    title: str
    content: str
    created_at: float
    updated_at: float
    current: bool = False


class CoWriterRevisionConflict(RuntimeError):
    """Raised when a client tries to overwrite a newer document revision."""

    def __init__(self, *, expected: int, current: int) -> None:
        self.expected = expected
        self.current = current
        super().__init__(f"Expected revision {expected}, current revision is {current}")


class CoWriterMergeConflict(RuntimeError):
    """Raised when local and remote edits touch the same base hunk."""

    def __init__(self, conflicts: list[dict[str, Any]]) -> None:
        self.conflicts = conflicts
        super().__init__("Local and remote edits overlap")


def _line_changes(base: str, changed: str, side: str) -> list[dict[str, Any]]:
    base_lines = base.splitlines(keepends=True)
    changed_lines = changed.splitlines(keepends=True)
    matcher = difflib.SequenceMatcher(a=base_lines, b=changed_lines, autojunk=False)
    return [
        {"start": i1, "end": i2, "replacement": changed_lines[j1:j2], "side": side}
        for tag, i1, i2, j1, j2 in matcher.get_opcodes()
        if tag != "equal"
    ]


def _changes_overlap(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_start, left_end = int(left["start"]), int(left["end"])
    right_start, right_end = int(right["start"]), int(right["end"])
    if left_start == left_end and right_start == right_end:
        return left_start == right_start
    if left_start == left_end:
        return right_start <= left_start <= right_end
    if right_start == right_end:
        return left_start <= right_start <= left_end
    return max(left_start, right_start) < min(left_end, right_end)


def merge_document_text(base: str, local: str, remote: str) -> tuple[str, list[dict[str, Any]]]:
    """Three-way line-hunk merge with explicit overlapping conflicts."""
    local_changes = _line_changes(base, local, "local")
    remote_changes = _line_changes(base, remote, "remote")
    conflicts: list[dict[str, Any]] = []
    deduplicated: list[dict[str, Any]] = []
    for change in [*local_changes, *remote_changes]:
        identical = next(
            (
                item
                for item in deduplicated
                if item["start"] == change["start"]
                and item["end"] == change["end"]
                and item["replacement"] == change["replacement"]
            ),
            None,
        )
        if identical is None:
            deduplicated.append(change)
    for local_change in local_changes:
        for remote_change in remote_changes:
            if not _changes_overlap(local_change, remote_change):
                continue
            if (
                local_change["start"] == remote_change["start"]
                and local_change["end"] == remote_change["end"]
                and local_change["replacement"] == remote_change["replacement"]
            ):
                continue
            conflicts.append(
                {
                    "start_line": min(local_change["start"], remote_change["start"]) + 1,
                    "end_line": max(local_change["end"], remote_change["end"]),
                    "local": "".join(local_change["replacement"]),
                    "remote": "".join(remote_change["replacement"]),
                }
            )
    if conflicts:
        return remote, conflicts
    merged_lines = base.splitlines(keepends=True)
    for change in sorted(
        deduplicated,
        key=lambda item: (int(item["start"]), int(item["end"])),
        reverse=True,
    ):
        merged_lines[int(change["start"]) : int(change["end"])] = change["replacement"]
    return "".join(merged_lines), []


def _atomic_write_json(path: Path, payload: Any) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    _atomic_write_text(path, text)


def _read_json(path: Path) -> Any | None:
    if not path.exists():
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning(f"Failed to read JSON {path}: {exc}")
        return None


def _derive_title(content: str, fallback: str = "Untitled draft") -> str:
    """Pick a title from the first heading line; fallback otherwise."""
    if not content:
        return fallback
    for raw in content.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            stripped = line.lstrip("#").strip()
            if stripped:
                return stripped[:120]
        return line[:120]
    return fallback


def _build_preview(content: str, limit: int = 160) -> str:
    if not content:
        return ""
    cleaned = "\n".join(line.strip() for line in content.splitlines() if line.strip())
    cleaned = cleaned.replace("\n", "  ")
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit].rstrip() + "…"


class CoWriterStorage:
    """File-system backed store for Co-Writer documents."""

    def __init__(self, path_service=None) -> None:
        self._path_service = path_service

    @property
    def path_service(self):
        if self._path_service is not None:
            return self._path_service
        return get_path_service()

    # ── Path helpers ─────────────────────────────────────────────────────

    def docs_root(self) -> Path:
        return self.path_service.get_co_writer_docs_dir()

    def doc_root(self, doc_id: str) -> Path:
        return self.path_service.get_co_writer_doc_root(doc_id)

    def manifest_path(self, doc_id: str) -> Path:
        return self.path_service.get_co_writer_doc_manifest(doc_id)

    def revisions_root(self, doc_id: str) -> Path:
        return self.doc_root(doc_id) / "revisions"

    def revision_path(self, doc_id: str, revision: int) -> Path:
        return self.revisions_root(doc_id) / f"revision-{revision}.json"

    def ensure_root(self) -> Path:
        root = self.docs_root()
        root.mkdir(parents=True, exist_ok=True)
        return root

    def ensure_doc_root(self, doc_id: str) -> Path:
        root = self.doc_root(doc_id)
        root.mkdir(parents=True, exist_ok=True)
        return root

    def doc_exists(self, doc_id: str) -> bool:
        return self.manifest_path(doc_id).exists()

    # ── CRUD ─────────────────────────────────────────────────────────────

    def list_doc_ids(self) -> list[str]:
        root = self.docs_root()
        if not root.exists():
            return []
        ids: list[str] = []
        for child in root.iterdir():
            if child.is_dir() and child.name.startswith("doc_"):
                ids.append(child.name[len("doc_") :])
        return ids

    def list_documents(self) -> list[CoWriterDocumentSummary]:
        summaries: list[CoWriterDocumentSummary] = []
        for doc_id in self.list_doc_ids():
            doc = self.load_document(doc_id)
            if doc is None:
                continue
            summaries.append(
                CoWriterDocumentSummary(
                    id=doc.id,
                    title=doc.title or _derive_title(doc.content),
                    created_at=doc.created_at,
                    updated_at=doc.updated_at,
                    preview=_build_preview(doc.content),
                )
            )
        summaries.sort(key=lambda s: s.updated_at, reverse=True)
        return summaries

    def create_document(
        self,
        *,
        title: str | None = None,
        content: str = "",
    ) -> CoWriterDocument:
        doc_id = uuid.uuid4().hex[:12]
        # Avoid extremely unlikely collisions.
        while self.doc_exists(doc_id):
            doc_id = uuid.uuid4().hex[:12]

        now = time.time()
        resolved_title = (title or "").strip() or _derive_title(content, "Untitled draft")
        document = CoWriterDocument(
            id=doc_id,
            title=resolved_title,
            content=content,
            created_at=now,
            updated_at=now,
        )
        self._write(document)
        return document

    def load_document(self, doc_id: str) -> CoWriterDocument | None:
        data = _read_json(self.manifest_path(doc_id))
        if data is None:
            return None
        try:
            return CoWriterDocument.model_validate(data)
        except Exception as exc:
            logger.warning(f"Failed to validate Co-Writer document {doc_id}: {exc}")
            return None

    def update_document(
        self,
        doc_id: str,
        *,
        title: str | None = None,
        content: str | None = None,
        expected_revision: int | None = None,
    ) -> CoWriterDocument | None:
        with _storage_lock:
            document = self.load_document(doc_id)
            if document is None:
                return None
            if expected_revision is not None and document.revision != expected_revision:
                raise CoWriterRevisionConflict(
                    expected=expected_revision,
                    current=document.revision,
                )
            # Preserve the exact pre-update state before advancing the manifest.
            self._archive_revision(document)
            if title is not None:
                document.title = title.strip() or _derive_title(
                    content if content is not None else document.content
                )
            if content is not None:
                document.content = content
                if title is None:
                    # Keep title in sync with the first heading when the user
                    # never set an explicit title (or kept the default).
                    derived = _derive_title(content, document.title or "Untitled draft")
                    if not document.title or document.title == "Untitled draft":
                        document.title = derived
            document.updated_at = time.time()
            document.revision += 1
            self._write(document)
            return document

    def list_revisions(self, doc_id: str) -> list[CoWriterDocumentRevision]:
        document = self.load_document(doc_id)
        if document is None:
            return []
        items = [
            CoWriterDocumentRevision(
                revision=document.revision,
                title=document.title,
                content=document.content,
                created_at=document.created_at,
                updated_at=document.updated_at,
                current=True,
            )
        ]
        root = self.revisions_root(doc_id)
        if root.exists():
            for path in root.glob("revision-*.json"):
                data = _read_json(path)
                if not isinstance(data, dict):
                    continue
                try:
                    items.append(CoWriterDocumentRevision.model_validate(data))
                except Exception:
                    logger.warning("Ignoring invalid Co-Writer revision %s", path)
        unique = {item.revision: item for item in items}
        return sorted(unique.values(), key=lambda item: item.revision, reverse=True)

    def restore_revision(
        self,
        doc_id: str,
        revision: int,
        *,
        expected_revision: int | None = None,
    ) -> CoWriterDocument | None:
        with _storage_lock:
            current = self.load_document(doc_id)
            if current is None:
                return None
            if expected_revision is not None and current.revision != expected_revision:
                raise CoWriterRevisionConflict(
                    expected=expected_revision,
                    current=current.revision,
                )
            target = next(
                (item for item in self.list_revisions(doc_id) if item.revision == revision),
                None,
            )
            if target is None:
                return None
            return self.update_document(
                doc_id,
                title=target.title,
                content=target.content,
                expected_revision=current.revision,
            )

    def merge_document(
        self,
        doc_id: str,
        *,
        base_revision: int,
        local_title: str,
        local_content: str,
        expected_current_revision: int,
    ) -> CoWriterDocument | None:
        """Merge a stale client draft against the latest server revision."""
        with _storage_lock:
            current = self.load_document(doc_id)
            if current is None:
                return None
            if current.revision != expected_current_revision:
                raise CoWriterRevisionConflict(
                    expected=expected_current_revision,
                    current=current.revision,
                )
            base = next(
                (item for item in self.list_revisions(doc_id) if item.revision == base_revision),
                None,
            )
            if base is None:
                raise ValueError("Base revision is no longer available")
            merged_content, conflicts = merge_document_text(
                base.content,
                local_content,
                current.content,
            )
            title_conflict = (
                local_title != base.title
                and current.title != base.title
                and local_title != current.title
            )
            if title_conflict:
                conflicts.append(
                    {
                        "field": "title",
                        "start_line": 1,
                        "end_line": 1,
                        "local": local_title,
                        "remote": current.title,
                    }
                )
            if conflicts:
                raise CoWriterMergeConflict(conflicts)
            merged_title = local_title if local_title != base.title else current.title
            return self.update_document(
                doc_id,
                title=merged_title,
                content=merged_content,
                expected_revision=current.revision,
            )

    def delete_document(self, doc_id: str) -> bool:
        root = self.doc_root(doc_id)
        if not root.exists():
            return False
        shutil.rmtree(root, ignore_errors=True)
        return not root.exists()

    # ── Internal ─────────────────────────────────────────────────────────

    def _write(self, document: CoWriterDocument) -> None:
        self.ensure_doc_root(document.id)
        _atomic_write_json(self.manifest_path(document.id), document.model_dump(mode="json"))

    def _archive_revision(self, document: CoWriterDocument) -> None:
        root = self.revisions_root(document.id)
        root.mkdir(parents=True, exist_ok=True)
        snapshot = CoWriterDocumentRevision(
            revision=document.revision,
            title=document.title,
            content=document.content,
            created_at=document.created_at,
            updated_at=document.updated_at,
            current=False,
        )
        _atomic_write_json(
            self.revision_path(document.id, document.revision),
            snapshot.model_dump(mode="json"),
        )
        paths = sorted(
            root.glob("revision-*.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for stale in paths[_REVISION_HISTORY_LIMIT:]:
            stale.unlink(missing_ok=True)


_storages: dict[str, CoWriterStorage] = {}


def get_co_writer_storage() -> CoWriterStorage:
    key = str(get_path_service().workspace_root.resolve())
    if key not in _storages:
        _storages[key] = CoWriterStorage()
    return _storages[key]


__all__ = [
    "CoWriterDocument",
    "CoWriterDocumentRevision",
    "CoWriterDocumentSummary",
    "CoWriterStorage",
    "CoWriterMergeConflict",
    "merge_document_text",
    "get_co_writer_storage",
]
