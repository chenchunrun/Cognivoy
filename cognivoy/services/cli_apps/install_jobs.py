"""Persistent, cancellable background jobs for privileged CLI app installs."""

from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
import threading
from typing import Awaitable, Callable
from uuid import uuid4

from cognivoy.services.cli_apps.installer import InstallOutcome, install_app
from cognivoy.services.cli_apps.models import CliAppEntry


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True, slots=True)
class CliInstallJob:
    task_id: str
    app_id: str
    display_name: str
    status: str
    log: str
    message: str
    created_at: str
    updated_at: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict[str, object]) -> "CliInstallJob":
        return cls(**{field: str(value.get(field) or "") for field in cls.__dataclass_fields__})


Installer = Callable[..., Awaitable[InstallOutcome]]


class CliInstallJobRegistry:
    """Own install tasks while persisting state for refresh and cross-worker cancel."""

    def __init__(self, root: Path, *, installer: Installer = install_app) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._installer = installer
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancel_events: dict[str, threading.Event] = {}
        self._lock = threading.RLock()
        self._recover_orphaned_jobs()

    def _recover_orphaned_jobs(self) -> None:
        """Make pre-restart non-terminal jobs honest and explicitly retryable."""
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

    def _path(self, task_id: str) -> Path:
        if not task_id or any(ch not in "abcdefghijklmnopqrstuvwxyz0123456789-" for ch in task_id):
            raise KeyError(task_id)
        return self.root / f"{task_id}.json"

    def _write(self, job: CliInstallJob) -> None:
        with self._lock:
            path = self._path(job.task_id)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(job.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8"
            )
            tmp.replace(path)

    def get(self, task_id: str) -> CliInstallJob:
        path = self._path(task_id)
        if not path.is_file():
            raise KeyError(task_id)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise KeyError(task_id) from exc
        if not isinstance(payload, dict):
            raise KeyError(task_id)
        return CliInstallJob.from_dict(payload)

    def _replace(self, job: CliInstallJob, **changes: str) -> CliInstallJob:
        data = job.to_dict()
        data.update(changes)
        data["updated_at"] = _now()
        updated = CliInstallJob.from_dict(data)
        self._write(updated)
        return updated

    def start(self, entry: CliAppEntry) -> CliInstallJob:
        task_id = uuid4().hex
        stamp = _now()
        job = CliInstallJob(task_id, entry.id, entry.display_name, "queued", "", "", stamp, stamp)
        self._write(job)
        cancel_event = threading.Event()
        self._cancel_events[task_id] = cancel_event
        self._tasks[task_id] = asyncio.create_task(
            self._run(job, entry, cancel_event), name=f"cli-install:{entry.id}:{task_id}"
        )
        return job

    def _cancel_requested(self, task_id: str, event: threading.Event) -> bool:
        if event.is_set():
            return True
        try:
            return self.get(task_id).status in {"cancelling", "cancelled"}
        except KeyError:
            return True

    def _append_progress(self, task_id: str, value: str) -> None:
        if not value:
            return
        try:
            job = self.get(task_id)
        except KeyError:
            return
        self._replace(job, log=f"{job.log}\n{value}".strip()[-20_000:])

    async def _run(
        self, job: CliInstallJob, entry: CliAppEntry, cancel_event: threading.Event
    ) -> None:
        self._replace(job, status="running")
        try:
            outcome = await self._installer(
                entry,
                cancel_requested=lambda: self._cancel_requested(job.task_id, cancel_event),
                progress=lambda line: self._append_progress(job.task_id, line),
            )
            current = self.get(job.task_id)
            if outcome.log:
                self._append_progress(job.task_id, outcome.log)
                current = self.get(job.task_id)
            if outcome.code == "cli.install_cancelled" or current.status == "cancelling":
                self._replace(current, status="cancelled", message=outcome.message)
            elif outcome.ok:
                self._replace(current, status="completed", message=outcome.message)
            else:
                self._replace(current, status="failed", message=outcome.message)
        except asyncio.CancelledError:
            current = self.get(job.task_id)
            self._replace(current, status="cancelled", message="Cancelled by administrator.")
            raise
        except Exception as exc:
            current = self.get(job.task_id)
            self._replace(current, status="failed", message=str(exc))
        finally:
            self._cancel_events.pop(job.task_id, None)

    def cancel(self, task_id: str) -> CliInstallJob:
        job = self.get(task_id)
        if job.status in {"completed", "failed", "cancelled"}:
            return job
        event = self._cancel_events.get(task_id)
        if event is not None:
            event.set()
        return self._replace(job, status="cancelling", message="Cancellation requested.")

    async def wait(self, task_id: str) -> CliInstallJob:
        task = self._tasks.get(task_id)
        if task is not None:
            await task
        return self.get(task_id)


__all__ = ["CliInstallJob", "CliInstallJobRegistry"]
