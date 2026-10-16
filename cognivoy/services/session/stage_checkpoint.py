"""Reusable stage-boundary persistence for restartable capabilities."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from typing import Any

from cognivoy.services.path_service import get_path_service

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")
_TERMINAL = frozenset({"completed", "failed", "cancelled", "timed_out"})


class StageCheckpointStore:
    """Atomically persist completed stages and keyed incremental results."""

    def __init__(
        self,
        capability: str,
        turn_id: str,
        *,
        root: Path | None = None,
    ) -> None:
        capability_id = str(capability or "").strip()
        turn = str(turn_id or "").strip()
        if not _SAFE_ID.fullmatch(capability_id) or not _SAFE_ID.fullmatch(turn):
            raise ValueError("capability or turn_id contains unsafe characters")
        self.capability = capability_id
        self.turn_id = turn
        self.directory = (
            Path(root) / capability_id / turn
            if root is not None
            else (
                get_path_service().get_chat_workspace_root()
                / "_workflow_checkpoints"
                / capability_id
                / turn
            )
        )
        self.path = self.directory / "workflow-checkpoint.json"

    def start(self, *, fingerprint: str) -> dict[str, Any]:
        fingerprint = str(fingerprint)
        existing = self._read()
        if existing and existing.get("fingerprint") == fingerprint:
            if existing.get("status") not in _TERMINAL:
                existing["resume_count"] = int(existing.get("resume_count") or 0) + 1
                existing["status"] = "running"
                existing["resumed_at"] = self._now()
                self._write(existing)
            return dict(existing)
        value = {
            "version": 1,
            "capability": self.capability,
            "turn_id": self.turn_id,
            "fingerprint": fingerprint,
            "status": "running",
            "resume_count": 0,
            "stages": {},
            "items": {},
            "created_at": self._now(),
        }
        self._write(value)
        return dict(value)

    def save_stage(self, stage: str, value: dict[str, Any]) -> None:
        manifest = self._require_manifest()
        stages = dict(manifest.get("stages") or {})
        stages[str(stage)] = {"value": dict(value), "completed_at": self._now()}
        manifest["stages"] = stages
        manifest["last_completed_stage"] = str(stage)
        manifest["status"] = "running"
        self._write(manifest)

    def load_stage(self, stage: str) -> dict[str, Any] | None:
        manifest = self._read()
        row = ((manifest or {}).get("stages") or {}).get(str(stage))
        value = row.get("value") if isinstance(row, dict) else None
        return dict(value) if isinstance(value, dict) else None

    def append_item(self, collection: str, key: str, value: dict[str, Any]) -> None:
        manifest = self._require_manifest()
        items = dict(manifest.get("items") or {})
        collection_items = dict(items.get(str(collection)) or {})
        collection_items[str(key)] = {
            "value": dict(value),
            "completed_at": self._now(),
        }
        items[str(collection)] = collection_items
        manifest["items"] = items
        manifest["status"] = "running"
        self._write(manifest)

    def load_items(self, collection: str) -> list[dict[str, Any]]:
        manifest = self._read()
        rows = ((manifest or {}).get("items") or {}).get(str(collection))
        if not isinstance(rows, dict):
            return []
        values: list[dict[str, Any]] = []
        for row in rows.values():
            value = row.get("value") if isinstance(row, dict) else None
            if isinstance(value, dict):
                values.append(dict(value))
        return values

    def finish(self, *, status: str) -> None:
        if status not in _TERMINAL:
            raise ValueError(f"Invalid checkpoint status: {status}")
        manifest = self._read()
        if manifest is None:
            return
        manifest["status"] = status
        manifest["finished_at"] = self._now()
        self._write(manifest)

    def metadata(self) -> dict[str, Any]:
        return dict(self._read() or {})

    def _require_manifest(self) -> dict[str, Any]:
        manifest = self._read()
        if manifest is None:
            raise RuntimeError("stage checkpoint was not started")
        return manifest

    def _read(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def _write(self, value: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        value["updated_at"] = self._now()
        temporary = self.path.with_suffix(f".json.{os.getpid()}.tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary, self.path)

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()


__all__ = ["StageCheckpointStore"]
