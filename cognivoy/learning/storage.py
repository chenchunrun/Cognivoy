from __future__ import annotations

import json
from pathlib import Path
import shutil
import threading
import time
import uuid

from cognivoy.learning.models import LearningProgress
from cognivoy.services.file_io import atomic_write_text as _atomic_write_text
from cognivoy.services.path_service import get_path_service

# Module-level lock so CAS semantics hold across all store instances.
_cas_lock = threading.Lock()


class LearningStore:
    def __init__(self, root: Path | None = None) -> None:
        self._root = root or (get_path_service().get_workspace_dir() / "learning")
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, book_id: str) -> Path:
        self._validate_identifier(book_id, "book_id")
        return self._root / f"{book_id}.json"

    @staticmethod
    def _validate_identifier(value: str, label: str) -> None:
        if not value or "/" in value or "\\" in value or ".." in value or ":" in value:
            raise ValueError(f"Invalid {label}: {value!r}")

    def _redo_history_dir(self, book_id: str) -> Path:
        self._validate_identifier(book_id, "book_id")
        return self._root / ".redo-history" / book_id

    def _redo_history_path(self, book_id: str, audit_id: str) -> Path:
        self._validate_identifier(audit_id, "audit_id")
        return self._redo_history_dir(book_id) / f"{audit_id}.json"

    def _write_progress_unlocked(self, progress: LearningProgress) -> None:
        progress.updated_at = time.time()
        progress.version += 1
        data = progress.model_dump(mode="json")
        text = json.dumps(data, ensure_ascii=False, indent=2)
        _atomic_write_text(self._path(progress.book_id), text)

    @staticmethod
    def _redo_summary(record: dict) -> dict:
        snapshot = record.get("snapshot") if isinstance(record.get("snapshot"), dict) else {}
        return {
            "id": record["id"],
            "book_id": record["book_id"],
            "reason": record.get("reason", ""),
            "created_at": record["created_at"],
            "source_version": record.get("source_version", snapshot.get("version", 0)),
            "mastery_count": len(snapshot.get("mastery_levels", {})),
            "attempt_count": len(snapshot.get("quiz_attempts", [])),
            "error_count": len(snapshot.get("error_records", [])),
            "restore_count": record.get("restore_count", 0),
            "last_restored_at": record.get("last_restored_at"),
        }

    def save(self, progress: LearningProgress) -> None:
        with _cas_lock:
            self._write_progress_unlocked(progress)

    def load(self, book_id: str) -> LearningProgress | None:
        path = self._path(book_id)
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return LearningProgress.model_validate(data)

    def delete(self, book_id: str) -> None:
        with _cas_lock:
            path = self._path(book_id)
            if path.exists():
                path.unlink()
            history_dir = self._redo_history_dir(book_id)
            if history_dir.exists():
                shutil.rmtree(history_dir)

    def exists(self, book_id: str) -> bool:
        return self._path(book_id).exists()

    def list_all(self) -> list[str]:
        """Return all book_ids that have stored progress."""
        return sorted(p.stem for p in self._root.glob("*.json") if not p.name.startswith("."))

    def archive_and_replace_for_redo(
        self,
        previous: LearningProgress,
        replacement: LearningProgress,
        *,
        reason: str = "",
    ) -> dict:
        """Archive the complete pre-redo state before replacing active progress.

        The archive write happens first and both writes are serialized by the
        store lock.  A failed archive therefore can never destroy the active
        learning evidence.
        """
        if previous.book_id != replacement.book_id:
            raise ValueError("Redo replacement must belong to the same book")
        audit_id = uuid.uuid4().hex
        created_at = time.time()
        record = {
            "schema_version": 1,
            "id": audit_id,
            "book_id": previous.book_id,
            "reason": reason.strip(),
            "created_at": created_at,
            "source_version": previous.version,
            "restore_count": 0,
            "last_restored_at": None,
            "snapshot": previous.model_dump(mode="json"),
        }
        archive_path = self._redo_history_path(previous.book_id, audit_id)
        with _cas_lock:
            archive_path.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_text(
                archive_path,
                json.dumps(record, ensure_ascii=False, indent=2),
            )
            self._write_progress_unlocked(replacement)
        return self._redo_summary(record)

    def list_redo_history(self, book_id: str) -> list[dict]:
        history_dir = self._redo_history_dir(book_id)
        if not history_dir.exists():
            return []
        items: list[dict] = []
        for path in history_dir.glob("*.json"):
            try:
                record = json.loads(path.read_text(encoding="utf-8"))
                if record.get("book_id") != book_id:
                    continue
                items.append(self._redo_summary(record))
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                # A damaged audit record must not make the active learning path
                # unavailable.  It remains on disk for administrator recovery.
                continue
        return sorted(items, key=lambda item: item["created_at"], reverse=True)

    def restore_redo_archive(self, book_id: str, audit_id: str) -> LearningProgress | None:
        archive_path = self._redo_history_path(book_id, audit_id)
        if not archive_path.exists():
            return None
        with _cas_lock:
            try:
                record = json.loads(archive_path.read_text(encoding="utf-8"))
                if record.get("book_id") != book_id:
                    return None
                restored = LearningProgress.model_validate(record["snapshot"])
            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                return None
            if restored.book_id != book_id:
                return None
            current = self.load(book_id)
            if current is not None:
                restored.version = max(restored.version, current.version)
            self._write_progress_unlocked(restored)
            record["restore_count"] = int(record.get("restore_count", 0)) + 1
            record["last_restored_at"] = time.time()
            _atomic_write_text(
                archive_path,
                json.dumps(record, ensure_ascii=False, indent=2),
            )
            return restored


__all__ = ["LearningStore"]
