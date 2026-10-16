"""Durable outbound dead-letter records for failed partner deliveries."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import threading
from typing import Any
from uuid import uuid4

from cognivoy.partners.bus.events import OutboundMessage
from cognivoy.partners.config.paths import get_runtime_subdir
from cognivoy.services.file_io import atomic_write_text


class DeadLetterStore:
    """Append-only JSONL store that preserves messages after retry exhaustion."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (get_runtime_subdir("dead-letter") / "outbound.jsonl")
        self._lock = threading.RLock()

    @contextmanager
    def _store_lock(self):
        """Lock the JSONL transaction across threads and API workers."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.path.with_suffix(self.path.suffix + ".lock")
        with self._lock:
            with lock_path.open("a+", encoding="utf-8") as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def append(
        self, message: OutboundMessage, *, attempts: int, error: Exception
    ) -> dict[str, Any]:
        record = {
            "id": uuid4().hex,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "status": "pending",
            "channel": message.channel,
            "chat_id": message.chat_id,
            "content": message.content,
            "reply_to": message.reply_to,
            "media": list(message.media),
            "metadata": dict(message.metadata or {}),
            "attempts": attempts,
            "error_type": type(error).__name__,
            "error_message": str(error)[:500],
        }
        line = json.dumps(record, ensure_ascii=False, default=str)
        with self._store_lock():
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()
                try:
                    os.fsync(handle.fileno())
                except OSError:
                    pass
        return record

    def list_records(self, *, status: str | None = None) -> list[dict[str, Any]]:
        with self._store_lock():
            lines = self.path.read_text(encoding="utf-8").splitlines() if self.path.exists() else []
        records: list[dict[str, Any]] = []
        for line in lines:
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and (status is None or value.get("status") == status):
                records.append(value)
        return records

    def get(self, record_id: str) -> dict[str, Any] | None:
        return next((row for row in self.list_records() if row.get("id") == record_id), None)

    def resolve(
        self,
        record_id: str,
        *,
        status: str,
        note: str = "",
    ) -> dict[str, Any]:
        """Atomically record an operator or replay decision.

        JSONL remains the durable representation, but status changes rewrite it
        as one atomic file so a process crash cannot leave two conflicting
        versions of the same delivery record.
        """
        if status not in {"pending", "replayed", "discarded"}:
            raise ValueError(f"unsupported dead-letter status: {status}")
        with self._store_lock():
            records = self._read_unlocked()
            selected: dict[str, Any] | None = None
            for row in records:
                if row.get("id") != record_id:
                    continue
                row["status"] = status
                row["resolved_at"] = datetime.now(timezone.utc).isoformat()
                row["resolution_note"] = str(note or "")[:500]
                selected = row
                break
            if selected is None:
                raise KeyError(record_id)
            self._write_unlocked(records)
            return dict(selected)

    def to_message(self, record_id: str) -> OutboundMessage:
        record = self.get(record_id)
        if record is None:
            raise KeyError(record_id)
        return OutboundMessage(
            channel=str(record.get("channel") or ""),
            chat_id=str(record.get("chat_id") or ""),
            content=str(record.get("content") or ""),
            reply_to=str(record["reply_to"]) if record.get("reply_to") else None,
            media=[str(item) for item in record.get("media") or []],
            metadata=dict(record.get("metadata") or {}),
        )

    def _read_unlocked(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        records: list[dict[str, Any]] = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                records.append(value)
        return records

    def _write_unlocked(self, records: list[dict[str, Any]]) -> None:
        atomic_write_text(
            self.path,
            "".join(json.dumps(row, ensure_ascii=False, default=str) + "\n" for row in records),
        )
