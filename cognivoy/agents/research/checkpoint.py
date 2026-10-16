"""Durable, user-scoped checkpoints for resumable Deep Research runs."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any

from cognivoy.agents.research.data_structures import DynamicTopicQueue, TopicStatus
from cognivoy.services.path_service import get_path_service


class ResearchCheckpointStore:
    """Persist the research queue and lifecycle without serialising LLM clients.

    Completed blocks and their tool traces are the durable unit. A process
    interruption can leave a block in ``researching``; resume deliberately
    returns those blocks to ``pending`` while preserving completed work.
    """

    def __init__(self, checkpoint_id: str, *, root: Path | None = None) -> None:
        self.checkpoint_id = checkpoint_id
        self.directory = (
            Path(root) / checkpoint_id
            if root is not None
            else get_path_service().get_task_workspace("deep_research", checkpoint_id)
        )
        self.queue_path = self.directory / "queue.json"
        self.manifest_path = self.directory / "checkpoint.json"
        self.report_path = self.directory / "report_progress.json"

    def start(self, *, topic: str, queue: DynamicTopicQueue) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        existing = self._read_manifest()
        if existing and existing.get("status") == "complete":
            for stale in (self.queue_path, self.directory / "citations.json", self.report_path):
                stale.unlink(missing_ok=True)
        queue.set_state_file(str(self.queue_path))
        self._write_manifest(
            {
                "version": 1,
                "checkpoint_id": self.checkpoint_id,
                "topic": topic.strip(),
                "status": "in_progress",
                "created_at": self._now(),
                "updated_at": self._now(),
                "resume_count": 0,
            }
        )

    def resume(self, *, topic: str) -> DynamicTopicQueue | None:
        manifest = self._read_manifest()
        if manifest is None or manifest.get("status") == "complete":
            return None
        if str(manifest.get("topic") or "").strip() != topic.strip():
            raise ValueError("checkpoint belongs to a different research topic")
        if not self.queue_path.exists():
            return None
        queue = DynamicTopicQueue.load_from_json(str(self.queue_path))
        for block in queue.blocks:
            if block.status in {TopicStatus.RESEARCHING, TopicStatus.FAILED}:
                block.status = TopicStatus.PENDING
        queue.set_state_file(str(self.queue_path))
        manifest["status"] = "in_progress"
        manifest["updated_at"] = self._now()
        manifest["resumed_at"] = self._now()
        manifest["resume_count"] = int(manifest.get("resume_count") or 0) + 1
        self._write_manifest(manifest)
        return queue

    def finish(self, *, partial: bool) -> None:
        manifest = self._read_manifest() or {
            "version": 1,
            "checkpoint_id": self.checkpoint_id,
            "created_at": self._now(),
        }
        manifest["status"] = "partial" if partial else "complete"
        manifest["updated_at"] = self._now()
        manifest["completed_at"] = self._now()
        self._write_manifest(manifest)

    def metadata(self) -> dict[str, Any]:
        return dict(self._read_manifest() or {})

    def load_report_progress(self, fingerprint: str) -> dict[str, Any]:
        """Reuse report steps only when their research inputs still match."""
        try:
            value = json.loads(self.report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if (
            not isinstance(value, dict)
            or value.get("fingerprint") != fingerprint
            or not isinstance(value.get("steps"), dict)
        ):
            return {}
        return value

    def save_report_progress(self, value: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.report_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        temporary.replace(self.report_path)

    def _read_manifest(self) -> dict[str, Any] | None:
        if not self.manifest_path.exists():
            return None
        try:
            value = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return value if isinstance(value, dict) else None

    def _write_manifest(self, value: dict[str, Any]) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = self.manifest_path.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n",
            encoding="utf-8",
        )
        temporary.replace(self.manifest_path)

    @staticmethod
    def _now() -> str:
        return datetime.now(timezone.utc).isoformat()


__all__ = ["ResearchCheckpointStore"]
