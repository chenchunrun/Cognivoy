"""
Book Storage
============

Per-book directory + per-page file persistence with atomic writes.

Layout (relative to ``data/user/workspace/book/``)::

    book_{book_id}/
    ├── manifest.json    # Book metadata
    ├── spine.json       # Spine
    ├── progress.json    # Progress
    ├── inputs.json      # Captured BookInputs
    ├── log.md           # Append-only operation log
    ├── pages/
    │   └── {page_id}.json
    └── assets/
        └── ...
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import threading
from typing import Any
from uuid import uuid4

from cognivoy.logging.safe_logger import get_logger
from cognivoy.services.file_io import atomic_write_text as _atomic_write_text
from cognivoy.services.path_service import get_path_service

from .models import Book, BookInputs, ExplorationReport, Page, Progress, Spine

logger = get_logger(__name__)
_stage_review_lock = threading.RLock()


# ─────────────────────────────────────────────────────────────────────────────
# Atomic JSON helpers
# ─────────────────────────────────────────────────────────────────────────────


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


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────


class BookStorage:
    """Async-friendly wrapper around the on-disk book layout."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()

    @property
    def path_service(self):
        return get_path_service()

    # ── Path helpers ─────────────────────────────────────────────────────

    def book_root(self, book_id: str) -> Path:
        return self.path_service.get_book_root(book_id)

    def ensure_book_root(self, book_id: str) -> Path:
        return self.path_service.ensure_book_root(book_id)

    def list_book_ids(self) -> list[str]:
        root = self.path_service.get_book_dir()
        if not root.exists():
            return []
        ids = []
        for child in root.iterdir():
            if child.is_dir() and child.name.startswith("book_"):
                ids.append(child.name[len("book_") :])
        return ids

    def book_exists(self, book_id: str) -> bool:
        return self.book_root(book_id).exists()

    # ── Manifest ─────────────────────────────────────────────────────────

    def save_book(self, book: Book) -> None:
        self.ensure_book_root(book.id)
        _atomic_write_json(
            self.path_service.get_book_manifest_file(book.id), book.model_dump(mode="json")
        )

    def load_book(self, book_id: str) -> Book | None:
        data = _read_json(self.path_service.get_book_manifest_file(book_id))
        if data is None:
            return None
        try:
            return Book.model_validate(data)
        except Exception as exc:
            logger.warning(f"Failed to validate Book {book_id}: {exc}")
            return None

    # ── Inputs (immutable snapshot) ─────────────────────────────────────

    def save_inputs(self, book_id: str, inputs: BookInputs) -> None:
        self.ensure_book_root(book_id)
        _atomic_write_json(
            self.path_service.get_book_inputs_file(book_id), inputs.model_dump(mode="json")
        )

    def load_inputs(self, book_id: str) -> BookInputs | None:
        data = _read_json(self.path_service.get_book_inputs_file(book_id))
        if data is None:
            return None
        try:
            return BookInputs.model_validate(data)
        except Exception as exc:
            logger.warning(f"Failed to validate BookInputs {book_id}: {exc}")
            return None

    # ── Spine ────────────────────────────────────────────────────────────

    def save_spine(self, spine: Spine) -> None:
        self.ensure_book_root(spine.book_id)
        _atomic_write_json(
            self.path_service.get_book_spine_file(spine.book_id),
            spine.model_dump(mode="json"),
        )

    def load_spine(self, book_id: str) -> Spine | None:
        data = _read_json(self.path_service.get_book_spine_file(book_id))
        if data is None:
            return None
        try:
            return Spine.model_validate(data)
        except Exception as exc:
            logger.warning(f"Failed to validate Spine {book_id}: {exc}")
            return None

    # ── Stage reviews (outline / whole-book proofreading) ───────────────

    def _stage_reviews_path(self, book_id: str) -> Path:
        return self.book_root(book_id) / "stage-reviews.json"

    def _read_stage_reviews(self, book_id: str) -> list[dict[str, Any]]:
        payload = _read_json(self._stage_reviews_path(book_id))
        if not isinstance(payload, list):
            return []
        return [dict(item) for item in payload if isinstance(item, dict)]

    def list_stage_reviews(self, book_id: str) -> list[dict[str, Any]]:
        return sorted(
            self._read_stage_reviews(book_id),
            key=lambda item: (str(item.get("stage") or ""), int(item.get("revision") or 0)),
            reverse=True,
        )

    def save_stage_review(
        self,
        book_id: str,
        *,
        stage: str,
        decision: str,
        snapshot: dict[str, Any],
        notes: str = "",
        expected_revision: int = 0,
    ) -> dict[str, Any]:
        if stage not in {"outline", "proofread"}:
            raise ValueError("Unsupported book review stage")
        if decision not in {"draft", "approved", "changes_requested"}:
            raise ValueError("Unsupported book review decision")
        with _stage_review_lock:
            reviews = self._read_stage_reviews(book_id)
            current = max(
                (int(item.get("revision") or 0) for item in reviews if item.get("stage") == stage),
                default=0,
            )
            if current != expected_revision:
                raise RuntimeError(f"stage_review_conflict:{current}")
            record = {
                "id": uuid4().hex,
                "book_id": book_id,
                "stage": stage,
                "revision": current + 1,
                "decision": decision,
                "notes": str(notes or "").strip()[:2_000],
                "snapshot": snapshot,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            reviews.append(record)
            _atomic_write_json(self._stage_reviews_path(book_id), reviews[-100:])
            return record

    # ── Exploration report (Stage 2 — Source sweep) ────────────────────

    def _exploration_path(self, book_id: str) -> Path:
        return self.book_root(book_id) / "exploration.json"

    def save_exploration(self, book_id: str, report: ExplorationReport) -> None:
        self.ensure_book_root(book_id)
        report.book_id = report.book_id or book_id
        _atomic_write_json(self._exploration_path(book_id), report.model_dump(mode="json"))

    def load_exploration(self, book_id: str) -> ExplorationReport | None:
        data = _read_json(self._exploration_path(book_id))
        if data is None:
            return None
        try:
            return ExplorationReport.model_validate(data)
        except Exception as exc:
            logger.warning(f"Failed to validate ExplorationReport {book_id}: {exc}")
            return None

    # ── Progress ─────────────────────────────────────────────────────────

    def save_progress(self, progress: Progress) -> None:
        self.ensure_book_root(progress.book_id)
        _atomic_write_json(
            self.path_service.get_book_progress_file(progress.book_id),
            progress.model_dump(mode="json"),
        )

    def load_progress(self, book_id: str) -> Progress | None:
        data = _read_json(self.path_service.get_book_progress_file(book_id))
        if data is None:
            return None
        try:
            return Progress.model_validate(data)
        except Exception as exc:
            logger.warning(f"Failed to validate Progress {book_id}: {exc}")
            return None

    # ── Pages ────────────────────────────────────────────────────────────

    def _page_revisions_dir(self, book_id: str, page_id: str) -> Path:
        return self.book_root(book_id) / "revisions" / page_id

    def _snapshot_page(self, page: Page) -> str:
        revision_id = (
            datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-" + uuid4().hex[:8]
        )
        directory = self._page_revisions_dir(page.book_id, page.id)
        directory.mkdir(parents=True, exist_ok=True)
        _atomic_write_json(
            directory / f"{revision_id}.json",
            {
                "revision_id": revision_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
                "title": page.title,
                "status": page.status.value if hasattr(page.status, "value") else str(page.status),
                "block_count": len(page.blocks),
                "page": page.model_dump(mode="json"),
            },
        )
        revisions = sorted(directory.glob("*.json"), key=lambda path: path.name, reverse=True)
        for stale in revisions[30:]:
            stale.unlink(missing_ok=True)
        return revision_id

    def save_page(self, page: Page) -> None:
        self.ensure_book_root(page.book_id)
        page_path = self.path_service.get_book_page_file(page.book_id, page.id)
        current = _read_json(page_path)
        next_payload = page.model_dump(mode="json")
        if isinstance(current, dict) and current != next_payload:
            try:
                self._snapshot_page(Page.model_validate(current))
            except Exception as exc:
                logger.warning("Failed to snapshot page %s before update: %s", page.id, exc)
        _atomic_write_json(page_path, next_payload)

    def load_page(self, book_id: str, page_id: str) -> Page | None:
        data = _read_json(self.path_service.get_book_page_file(book_id, page_id))
        if data is None:
            return None
        try:
            return Page.model_validate(data)
        except Exception as exc:
            logger.warning(f"Failed to validate Page {page_id}: {exc}")
            return None

    def list_pages(self, book_id: str) -> list[Page]:
        pages_dir = self.path_service.get_book_pages_dir(book_id)
        if not pages_dir.exists():
            return []
        result: list[Page] = []
        for child in pages_dir.iterdir():
            if child.suffix != ".json":
                continue
            data = _read_json(child)
            if data is None:
                continue
            try:
                result.append(Page.model_validate(data))
            except Exception as exc:
                logger.warning(f"Skipping invalid page file {child}: {exc}")
        result.sort(key=lambda p: (p.order, p.created_at))
        return result

    def delete_page(self, book_id: str, page_id: str) -> bool:
        path = self.path_service.get_book_page_file(book_id, page_id)
        if path.exists():
            path.unlink()
            return True
        return False

    def list_page_revisions(self, book_id: str, page_id: str) -> list[dict[str, Any]]:
        directory = self._page_revisions_dir(book_id, page_id)
        if not directory.exists():
            return []
        revisions: list[dict[str, Any]] = []
        for path in sorted(directory.glob("*.json"), key=lambda item: item.name, reverse=True):
            payload = _read_json(path)
            if not isinstance(payload, dict):
                continue
            revisions.append(
                {
                    "revision_id": str(payload.get("revision_id") or path.stem),
                    "created_at": payload.get("created_at"),
                    "title": payload.get("title"),
                    "status": payload.get("status"),
                    "block_count": payload.get("block_count"),
                }
            )
        return revisions

    def restore_page_revision(self, book_id: str, page_id: str, revision_id: str) -> Page:
        if not revision_id or not all(char.isalnum() or char in {"-", "_"} for char in revision_id):
            raise ValueError("Invalid revision id")
        payload = _read_json(self._page_revisions_dir(book_id, page_id) / f"{revision_id}.json")
        if not isinstance(payload, dict) or not isinstance(payload.get("page"), dict):
            raise FileNotFoundError("Page revision not found")
        page = Page.model_validate(payload["page"])
        if page.book_id != book_id or page.id != page_id:
            raise ValueError("Revision does not belong to this page")
        self.save_page(page)
        self.append_log(
            book_id, f"Restored page '{page.title}' from revision {revision_id}", op="restore"
        )
        return page

    # ── Log (append-only) ────────────────────────────────────────────────

    def append_log(self, book_id: str, message: str, *, op: str = "info") -> None:
        path = self.path_service.get_book_log_file(book_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).replace(tzinfo=None).isoformat(timespec="seconds")
        line = f"- `{ts}Z` **{op}** — {message.strip()}\n"
        with open(path, "a", encoding="utf-8") as f:
            f.write(line)

    # ── Delete ───────────────────────────────────────────────────────────

    def delete_book(self, book_id: str) -> bool:
        root = self.book_root(book_id)
        if not root.exists():
            return False
        shutil.rmtree(root, ignore_errors=True)
        return not root.exists()


_storages: dict[str, BookStorage] = {}


def get_book_storage() -> BookStorage:
    key = str(get_path_service().workspace_root.resolve())
    if key not in _storages:
        _storages[key] = BookStorage()
    return _storages[key]


__all__ = ["BookStorage", "get_book_storage"]
