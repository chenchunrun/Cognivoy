"""Persistent, cancellable background jobs for reviewed Skill Hub installs."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
import json
from pathlib import Path
import threading
from typing import Any, Awaitable, Callable
from uuid import uuid4


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True, slots=True)
class SkillInstallJob:
    task_id: str
    ref: str
    status: str
    log: str = ""
    message: str = ""
    result: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> "SkillInstallJob":
        return cls(
            task_id=str(value.get("task_id") or ""),
            ref=str(value.get("ref") or ""),
            status=str(value.get("status") or ""),
            log=str(value.get("log") or ""),
            message=str(value.get("message") or ""),
            result=dict(value.get("result") or {}),
            created_at=str(value.get("created_at") or ""),
            updated_at=str(value.get("updated_at") or ""),
        )


Installer = Callable[..., Awaitable[dict[str, Any]]]


class SkillInstallJobRegistry:
    """Run one user's reviewed imports without losing status on page refresh."""

    def __init__(self, root: Path, *, installer: Installer) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._installer = installer
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._lock = threading.RLock()
        self._recover_orphans()

    def _path(self, task_id: str) -> Path:
        if not task_id or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-" for ch in task_id):
            raise KeyError(task_id)
        return self.root / f"{task_id}.json"

    def _write(self, job: SkillInstallJob) -> None:
        with self._lock:
            path = self._path(job.task_id)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(job.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
            )
            temporary.replace(path)

    def get(self, task_id: str) -> SkillInstallJob:
        try:
            payload = json.loads(self._path(task_id).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise KeyError(task_id) from exc
        if not isinstance(payload, dict):
            raise KeyError(task_id)
        return SkillInstallJob.from_dict(payload)

    def _replace(self, job: SkillInstallJob, **changes: Any) -> SkillInstallJob:
        payload = job.to_dict()
        payload.update(changes)
        payload["updated_at"] = _now()
        updated = SkillInstallJob.from_dict(payload)
        self._write(updated)
        return updated

    def _recover_orphans(self) -> None:
        for path in self.root.glob("*.json"):
            try:
                job = self.get(path.stem)
            except KeyError:
                continue
            if job.status in {"queued", "running", "cancelling"}:
                self._replace(
                    job,
                    status="failed",
                    message=(
                        "Installation was interrupted by an application restart. "
                        "Review the package and retry."
                    ),
                )

    def start(self, payload: dict[str, Any]) -> SkillInstallJob:
        task_id = uuid4().hex
        stamp = _now()
        job = SkillInstallJob(
            task_id=task_id,
            ref=str(payload.get("ref") or ""),
            status="queued",
            created_at=stamp,
            updated_at=stamp,
        )
        self._write(job)
        event = threading.Event()
        self._cancel_events[task_id] = event
        self._tasks[task_id] = asyncio.create_task(
            self._run(job, dict(payload), event), name=f"skill-install:{task_id}"
        )
        return job

    def _cancel_requested(self, task_id: str, event: threading.Event) -> bool:
        if event.is_set():
            return True
        try:
            return self.get(task_id).status in {"cancelling", "cancelled"}
        except KeyError:
            return True

    def _progress(self, task_id: str, line: str) -> None:
        if not line:
            return
        try:
            job = self.get(task_id)
        except KeyError:
            return
        self._replace(job, log=f"{job.log}\n{line}".strip()[-20_000:])

    async def _run(
        self, job: SkillInstallJob, payload: dict[str, Any], event: threading.Event
    ) -> None:
        self._replace(job, status="running")
        try:
            result = await self._installer(
                payload,
                cancel_requested=lambda: self._cancel_requested(job.task_id, event),
                progress=lambda line: self._progress(job.task_id, line),
            )
            current = self.get(job.task_id)
            if current.status == "cancelling":
                self._replace(current, status="cancelled", message="Cancelled by user.")
            else:
                self._replace(current, status="completed", result=result)
        except asyncio.CancelledError:
            current = self.get(job.task_id)
            self._replace(current, status="cancelled", message="Cancelled by user.")
        except Exception as exc:
            current = self.get(job.task_id)
            if current.status == "cancelling":
                self._replace(current, status="cancelled", message="Cancelled by user.")
            else:
                self._replace(current, status="failed", message=str(exc))
        finally:
            self._cancel_events.pop(job.task_id, None)

    def cancel(self, task_id: str) -> SkillInstallJob:
        job = self.get(task_id)
        if job.status in {"completed", "failed", "cancelled"}:
            return job
        event = self._cancel_events.get(task_id)
        if event is not None:
            event.set()
        return self._replace(job, status="cancelling", message="Cancellation requested.")

    async def wait(self, task_id: str) -> SkillInstallJob:
        task = self._tasks.get(task_id)
        if task is not None:
            await task
        return self.get(task_id)


__all__ = ["SkillInstallJob", "SkillInstallJobRegistry"]
