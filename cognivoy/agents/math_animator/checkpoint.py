"""Stage-boundary checkpoints for restartable Math Animator turns."""

from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from cognivoy.services.path_service import get_path_service

ModelT = TypeVar("ModelT", bound=BaseModel)
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,160}$")


class MathAnimatorCheckpointStore:
    """Persist serialisable outputs after every expensive pipeline stage."""

    def __init__(self, turn_id: str, *, root: Path | None = None) -> None:
        candidate = str(turn_id or "").strip()
        if not _SAFE_ID.fullmatch(candidate):
            raise ValueError("turn_id contains unsafe characters")
        self.turn_id = candidate
        self.directory = (
            Path(root) / candidate
            if root is not None
            else get_path_service().get_agent_dir("math_animator") / candidate
        )
        self.path = self.directory / "workflow-checkpoint.json"

    def start(self, *, fingerprint: str) -> dict[str, Any]:
        existing = self._read()
        if existing and existing.get("fingerprint") == fingerprint:
            if existing.get("status") != "completed":
                existing["resume_count"] = int(existing.get("resume_count") or 0) + 1
                existing["status"] = "running"
                existing["resumed_at"] = self._now()
                self._write(existing)
            return dict(existing)
        value = {
            "version": 1,
            "turn_id": self.turn_id,
            "fingerprint": str(fingerprint),
            "status": "running",
            "resume_count": 0,
            "stages": {},
            "created_at": self._now(),
            "updated_at": self._now(),
        }
        self._write(value)
        return dict(value)

    def save_stage(self, stage: str, value: Any) -> None:
        manifest = self._read()
        if manifest is None:
            raise RuntimeError("Math Animator checkpoint was not started")
        stages = dict(manifest.get("stages") or {})
        if isinstance(value, BaseModel):
            payload = value.model_dump(mode="json")
        elif isinstance(value, dict):
            payload = dict(value)
        elif callable(getattr(value, "model_dump", None)):
            try:
                payload = value.model_dump(mode="json")
            except TypeError:
                payload = value.model_dump()
        else:
            payload = dict(vars(value))
        stages[str(stage)] = {
            "value": payload,
            "completed_at": self._now(),
        }
        manifest["stages"] = stages
        manifest["last_completed_stage"] = str(stage)
        manifest["status"] = "running"
        self._write(manifest)

    def load_stage(self, stage: str, model: type[ModelT]) -> ModelT | None:
        manifest = self._read()
        row = ((manifest or {}).get("stages") or {}).get(str(stage))
        if not isinstance(row, dict) or not isinstance(row.get("value"), dict):
            return None
        try:
            return model.model_validate(row["value"])
        except ValidationError:
            return None

    def load_dict(self, stage: str) -> dict[str, Any] | None:
        manifest = self._read()
        row = ((manifest or {}).get("stages") or {}).get(str(stage))
        value = row.get("value") if isinstance(row, dict) else None
        return dict(value) if isinstance(value, dict) else None

    def finish(self, *, status: str) -> None:
        if status not in {"completed", "failed", "cancelled", "timed_out"}:
            raise ValueError(f"Invalid Math Animator checkpoint status: {status}")
        manifest = self._read()
        if manifest is None:
            return
        manifest["status"] = status
        manifest["finished_at"] = self._now()
        self._write(manifest)

    def metadata(self) -> dict[str, Any]:
        return dict(self._read() or {})

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


__all__ = ["MathAnimatorCheckpointStore"]
