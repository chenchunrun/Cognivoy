"""Built-in cron service — scheduled tasks for chat and partners.

A trimmed-down take on nanobot's CronService (docs/ref/nanobot): same job
semantics (``at`` / ``every`` / ``cron`` schedules, JSON persistence and run
bookkeeping). Multiple API workers serialize store mutations with a file lock
and coordinate each due occurrence through a shared SQLite lease so only one
worker dispatches it.

Jobs carry an *owner*: a chat session (the reply is appended to that
session) or a partner conversation (the prompt is injected into the
partner's message bus and the reply rides the original IM channel). The
executor lives in :mod:`cognivoy.services.cron.executor`.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field
from datetime import datetime
import fcntl
import json
import logging
from pathlib import Path
import threading
import time
from typing import Any, Awaitable, Callable
import uuid

from cognivoy.services.coordination import SharedCoordinationStore
from cognivoy.services.file_io import atomic_write_json

logger = logging.getLogger(__name__)

# Re-check the schedule at least this often even when nothing is due —
# cheap, and it picks up externally-edited stores within a minute.
_MAX_SLEEP_SECONDS = 60.0
_MAX_RUN_HISTORY = 10


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class CronSchedule:
    """When a job runs: one-shot, fixed interval, or cron expression."""

    kind: str  # "at" | "every" | "cron"
    at_ms: int | None = None  # "at": epoch ms
    every_seconds: int | None = None  # "every": interval
    expr: str | None = None  # "cron": e.g. "0 9 * * *"
    tz: str | None = None  # "cron": IANA timezone


@dataclass
class CronOwner:
    """Who scheduled the job and where its output goes."""

    kind: str  # "chat" | "partner"
    user_id: str = ""  # chat: owning user
    is_admin: bool = True  # chat: scope restore
    session_id: str = ""  # chat: reply lands in this session
    language: str = "en"
    partner_id: str = ""  # partner: owning partner
    channel: str = ""  # partner: originating channel
    chat_id: str = ""  # partner: originating chat
    session_key: str = ""  # partner: conversation key
    channel_meta: dict[str, Any] = field(default_factory=dict)  # partner: thread/reply metadata

    @property
    def key(self) -> str:
        if self.kind == "partner":
            return f"partner:{self.partner_id}"
        return f"chat:{self.user_id or 'local-admin'}"


@dataclass
class CronRunRecord:
    run_at_ms: int
    status: str  # "ok" | "error" | "skipped"
    duration_ms: int = 0
    error: str | None = None


@dataclass
class CronJobState:
    next_run_at_ms: int | None = None
    last_run_at_ms: int | None = None
    last_status: str | None = None
    last_error: str | None = None
    run_history: list[CronRunRecord] = field(default_factory=list)
    attempt_count: int = 0


@dataclass
class CronJob:
    id: str
    name: str
    message: str
    schedule: CronSchedule
    owner: CronOwner
    enabled: bool = True
    delete_after_run: bool = False
    created_at_ms: int = 0
    max_attempts: int = 1
    retry_delay_seconds: int = 300
    state: CronJobState = field(default_factory=CronJobState)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "CronJob":
        state = dict(data.get("state") or {})
        state["run_history"] = [CronRunRecord(**record) for record in state.get("run_history", [])]
        return cls(
            id=str(data["id"]),
            name=str(data.get("name") or ""),
            message=str(data.get("message") or ""),
            schedule=CronSchedule(**(data.get("schedule") or {"kind": "every"})),
            owner=CronOwner(**(data.get("owner") or {"kind": "chat"})),
            enabled=bool(data.get("enabled", True)),
            delete_after_run=bool(data.get("delete_after_run", False)),
            created_at_ms=int(data.get("created_at_ms", 0)),
            max_attempts=max(1, int(data.get("max_attempts", 1) or 1)),
            retry_delay_seconds=max(30, int(data.get("retry_delay_seconds", 300) or 300)),
            state=CronJobState(**state),
        )


def compute_next_run(schedule: CronSchedule, now_ms: int) -> int | None:
    """Next due time in epoch ms, or ``None`` for never/expired."""
    if schedule.kind == "at":
        if schedule.at_ms and schedule.at_ms > now_ms:
            return schedule.at_ms
        return None

    if schedule.kind == "every":
        if not schedule.every_seconds or schedule.every_seconds <= 0:
            return None
        return now_ms + schedule.every_seconds * 1000

    if schedule.kind == "cron" and schedule.expr:
        try:
            from zoneinfo import ZoneInfo

            from croniter import croniter

            tz = ZoneInfo(schedule.tz) if schedule.tz else datetime.now().astimezone().tzinfo
            base = datetime.fromtimestamp(now_ms / 1000, tz=tz)
            next_dt = croniter(schedule.expr, base).get_next(datetime)
            return int(next_dt.timestamp() * 1000)
        except ImportError:
            raise ValueError(
                "cron expressions need the 'croniter' package — "
                "use an 'every' or 'at' schedule instead"
            ) from None
        except Exception as exc:
            raise ValueError(f"invalid cron expression {schedule.expr!r}: {exc}") from None

    return None


def validate_schedule(schedule: CronSchedule) -> None:
    """Reject schedules that could never run (raises ValueError)."""
    if schedule.kind == "at":
        if not schedule.at_ms:
            raise ValueError("'at' schedules need a time")
        if schedule.at_ms <= _now_ms():
            raise ValueError("'at' time is in the past")
        return
    if schedule.kind == "every":
        if not schedule.every_seconds or schedule.every_seconds < 30:
            raise ValueError("'every' interval must be at least 30 seconds")
        return
    if schedule.kind == "cron":
        if schedule.tz:
            try:
                from zoneinfo import ZoneInfo

                ZoneInfo(schedule.tz)
            except Exception:
                raise ValueError(f"unknown timezone {schedule.tz!r}") from None
        # Raises ValueError on bad/unsupported expressions.
        if compute_next_run(schedule, _now_ms()) is None:
            raise ValueError(f"cron expression {schedule.expr!r} never fires")
        return
    raise ValueError(f"unknown schedule kind {schedule.kind!r}")


class CronService:
    """Persistent job store with cross-worker occurrence claiming."""

    def __init__(
        self,
        store_path: Path,
        on_job: Callable[[CronJob], Awaitable[tuple[str, str | None]]] | None = None,
        worker_id: str | None = None,
        coordination_store: SharedCoordinationStore | None = None,
    ) -> None:
        """``on_job`` returns ``(status, error)`` with status ok/error/skipped."""
        self.store_path = store_path
        self.on_job = on_job
        self.worker_id = worker_id or f"cron-{uuid.uuid4().hex}"
        self.coordination_store = coordination_store or SharedCoordinationStore(
            store_path.with_suffix(".coordination.sqlite3")
        )
        self._jobs: dict[str, CronJob] = {}
        self._loaded = False
        self._store_mtime_ns: int | None = None
        self._timer_task: asyncio.Task | None = None
        self._wake = asyncio.Event()
        self._running = False
        self._thread_lock = threading.RLock()

    @contextmanager
    def _store_lock(self):
        """Serialize a complete read-modify-write transaction across workers."""
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.store_path.with_suffix(self.store_path.suffix + ".lock")
        with self._thread_lock:
            with lock_path.open("a+", encoding="utf-8") as lock:
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    # ── persistence ───────────────────────────────────────────────

    def _load(self, *, force: bool = False) -> None:
        if self._loaded:
            if not force:
                return
        self._loaded = True
        if force:
            self._jobs = {}
        if not self.store_path.exists():
            return
        try:
            data = json.loads(self.store_path.read_text(encoding="utf-8"))
            for raw in data.get("jobs", []):
                job = CronJob.from_dict(raw)
                self._jobs[job.id] = job
            self._store_mtime_ns = self.store_path.stat().st_mtime_ns
        except Exception:
            # Preserve the corrupt store for recovery; an empty in-memory
            # view would otherwise overwrite it on the next save.
            backup = self.store_path.with_suffix(f".corrupt-{int(time.time())}")
            try:
                self.store_path.rename(backup)
            except OSError:
                pass
            logger.exception("Corrupt cron store moved to %s", backup)

    def _save_unlocked(self) -> None:
        payload = {"version": 1, "jobs": [asdict(job) for job in self._jobs.values()]}
        atomic_write_json(self.store_path, payload)
        self._store_mtime_ns = self.store_path.stat().st_mtime_ns

    def _save(self) -> None:
        """Persist deliberate in-memory edits (kept for scheduler/tests)."""
        with self._store_lock():
            self._save_unlocked()

    # ── job management ────────────────────────────────────────────

    def add_job(
        self,
        *,
        name: str,
        message: str,
        schedule: CronSchedule,
        owner: CronOwner,
        delete_after_run: bool | None = None,
        max_attempts: int = 1,
        retry_delay_seconds: int = 300,
    ) -> CronJob:
        validate_schedule(schedule)
        if not message.strip():
            raise ValueError("message is required")
        if not 1 <= max_attempts <= 10:
            raise ValueError("max_attempts must be between 1 and 10")
        if not 30 <= retry_delay_seconds <= 86_400:
            raise ValueError("retry_delay_seconds must be between 30 and 86400")
        job = CronJob(
            id=uuid.uuid4().hex[:10],
            name=name.strip() or message.strip()[:48],
            message=message.strip(),
            schedule=schedule,
            owner=owner,
            # One-shot jobs clean up after themselves unless told otherwise.
            delete_after_run=(
                delete_after_run if delete_after_run is not None else schedule.kind == "at"
            ),
            created_at_ms=_now_ms(),
            max_attempts=max_attempts,
            retry_delay_seconds=retry_delay_seconds,
        )
        job.state.next_run_at_ms = compute_next_run(schedule, _now_ms())
        with self._store_lock():
            self._load(force=True)
            self._jobs[job.id] = job
            self._save_unlocked()
        self._wake.set()
        return job

    def list_jobs(self, owner_key: str | None = None) -> list[CronJob]:
        with self._store_lock():
            self._load(force=True)
            jobs = list(self._jobs.values())
        if owner_key is not None:
            jobs = [job for job in jobs if job.owner.key == owner_key]
        return sorted(jobs, key=lambda job: job.state.next_run_at_ms or 0)

    def get_job(self, job_id: str) -> CronJob | None:
        with self._store_lock():
            self._load(force=True)
            return self._jobs.get(job_id)

    def update_job(
        self,
        job_id: str,
        *,
        message: str | None = None,
        channel_meta: dict[str, Any] | None = None,
    ) -> CronJob | None:
        """Atomically persist the mutable payload of a pending job.

        Scheduling policy uses this to merge related reminders instead of
        creating notification storms.  Timing and ownership remain immutable;
        callers cannot use it to move or steal another owner's job.
        """
        with self._store_lock():
            self._load(force=True)
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if message is not None:
                if not message.strip():
                    raise ValueError("message is required")
                job.message = message.strip()
            if channel_meta is not None:
                job.owner.channel_meta = dict(channel_meta)
            self._save_unlocked()
        self._wake.set()
        return job

    def reschedule_job(
        self,
        job_id: str,
        *,
        at_ms: int,
        owner_key: str | None = None,
    ) -> CronJob | None:
        """Move a pending one-shot job while preserving identity and audit links."""
        with self._store_lock():
            self._load(force=True)
            job = self._jobs.get(job_id)
            if job is None or (owner_key is not None and job.owner.key != owner_key):
                return None
            if at_ms <= _now_ms():
                raise ValueError("rescheduled time must be in the future")
            job.schedule = CronSchedule(kind="at", at_ms=at_ms)
            job.state.next_run_at_ms = at_ms
            self._save_unlocked()
        self._wake.set()
        return job

    def cancel_job(self, job_id: str, *, owner_key: str | None = None) -> bool:
        """Remove a job; ``owner_key`` scopes the cancel to its owner."""
        with self._store_lock():
            self._load(force=True)
            job = self._jobs.get(job_id)
            if job is None:
                return False
            if owner_key is not None and job.owner.key != owner_key:
                return False
            del self._jobs[job_id]
            self._save_unlocked()
        self._wake.set()
        return True

    def remove_owner_jobs(self, owner_key: str) -> int:
        """Drop every job belonging to *owner_key* (e.g. a destroyed partner)."""
        with self._store_lock():
            self._load(force=True)
            doomed = [job_id for job_id, job in self._jobs.items() if job.owner.key == owner_key]
            for job_id in doomed:
                del self._jobs[job_id]
            if doomed:
                self._save_unlocked()
                self._wake.set()
        return len(doomed)

    # ── scheduler ─────────────────────────────────────────────────

    async def start(self) -> None:
        if self._running:
            return
        with self._store_lock():
            self._load(force=True)
            # Re-arm interval/cron jobs whose due time passed while the server
            # was down: run once now (next_run in the past stays "due"); expired
            # one-shots are dropped.
            now = _now_ms()
            changed = False
            for job in list(self._jobs.values()):
                if job.schedule.kind == "at" and (job.schedule.at_ms or 0) <= now:
                    del self._jobs[job.id]
                    changed = True
            if changed:
                self._save_unlocked()
        self._running = True
        self._timer_task = asyncio.create_task(self._loop(), name="cron:scheduler")
        logger.info("Cron service started (%d jobs)", len(self._jobs))

    async def stop(self) -> None:
        self._running = False
        if self._timer_task:
            self._timer_task.cancel()
            try:
                await self._timer_task
            except asyncio.CancelledError:
                pass
            self._timer_task = None

    async def _loop(self) -> None:
        while self._running:
            try:
                await self._tick()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Cron tick failed")
            sleep_s = self._seconds_until_next_due()
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=sleep_s)
            except asyncio.TimeoutError:
                pass

    def _seconds_until_next_due(self) -> float:
        due_times = [
            job.state.next_run_at_ms
            for job in self._jobs.values()
            if job.enabled and job.state.next_run_at_ms
        ]
        if not due_times:
            return _MAX_SLEEP_SECONDS
        delta_s = (min(due_times) - _now_ms()) / 1000
        return max(0.05, min(delta_s, _MAX_SLEEP_SECONDS))

    async def _tick(self) -> None:
        # Observe mutations persisted by another API worker before deciding
        # which occurrences are due.
        with self._store_lock():
            self._load(force=True)
            jobs = list(self._jobs.values())
        now = _now_ms()
        for job in jobs:
            if not job.enabled or not job.state.next_run_at_ms:
                continue
            if job.state.next_run_at_ms > now:
                continue
            occurrence = f"{job.id}:{job.state.next_run_at_ms}"
            claimed = await asyncio.to_thread(
                self.coordination_store.claim,
                namespace="cron-occurrence",
                key=occurrence,
                owner=self.worker_id,
                lease_seconds=3600.0,
            )
            if not claimed:
                continue
            await self._run_job(job)

    async def _run_job(self, job: CronJob) -> None:
        started = _now_ms()
        status, error = "skipped", None
        if self.on_job is not None:
            try:
                status, error = await self.on_job(job)
            except Exception as exc:  # noqa: BLE001
                status, error = "error", f"{type(exc).__name__}: {exc}"
                logger.exception("Cron job %s (%s) crashed", job.id, job.name)

        with self._store_lock():
            # Do not overwrite jobs added or updated while this occurrence ran.
            self._load(force=True)
            persisted = self._jobs.get(job.id)
            if persisted is None:
                return
            persisted.state.last_run_at_ms = started
            persisted.state.attempt_count += 1
            persisted.state.last_status = status
            persisted.state.last_error = error
            persisted.state.run_history.append(
                CronRunRecord(
                    run_at_ms=started,
                    status=status,
                    duration_ms=_now_ms() - started,
                    error=error,
                )
            )
            persisted.state.run_history = persisted.state.run_history[-_MAX_RUN_HISTORY:]

            if persisted.delete_after_run or persisted.schedule.kind == "at":
                if status != "ok" and persisted.state.attempt_count < persisted.max_attempts:
                    persisted.state.next_run_at_ms = (
                        _now_ms() + persisted.retry_delay_seconds * 1000
                    )
                else:
                    self._jobs.pop(persisted.id, None)
            else:
                persisted.state.next_run_at_ms = compute_next_run(persisted.schedule, _now_ms())
                if persisted.state.next_run_at_ms is None:
                    self._jobs.pop(persisted.id, None)
            self._save_unlocked()


_service: CronService | None = None


def get_cron_service() -> CronService:
    """Process-wide cron service, anchored at the admin workspace."""
    global _service
    if _service is None:
        from cognivoy.multi_user.paths import get_admin_path_service
        from cognivoy.services.cron.executor import execute_job

        store = get_admin_path_service().workspace_root / "cron" / "jobs.json"
        _service = CronService(store_path=store, on_job=execute_job)
    return _service


__all__ = [
    "CronJob",
    "CronOwner",
    "CronSchedule",
    "CronService",
    "compute_next_run",
    "get_cron_service",
    "validate_schedule",
]
