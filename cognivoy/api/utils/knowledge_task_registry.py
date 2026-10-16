"""Lifecycle registry for cancellable knowledge-base background jobs."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from dataclasses import dataclass
import threading
from typing import Any


@dataclass(frozen=True)
class KnowledgeTaskRecord:
    task_id: str
    kb_name: str
    task: asyncio.Task[Any]
    cancel_event: threading.Event


class KnowledgeTaskRegistry:
    """Keep live KB jobs addressable after their HTTP request has returned.

    Starlette ``BackgroundTasks`` does not expose a handle that a later
    request can cancel.  This registry owns the actual ``asyncio.Task`` and
    removes it once settled.  Completed task metadata remains available via
    ``TaskIDManager`` and the task stream tombstone.
    """

    _instance: "KnowledgeTaskRegistry | None" = None
    _instance_lock = threading.Lock()

    def __init__(self, *, cancel_wait_seconds: float = 0.25) -> None:
        self._records: dict[str, KnowledgeTaskRecord] = {}
        self._lock = threading.Lock()
        self._cancel_wait_seconds = max(0.0, float(cancel_wait_seconds))

    @classmethod
    def get_instance(cls) -> "KnowledgeTaskRegistry":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def start(self, task_id: str, kb_name: str, awaitable: Awaitable[Any]) -> None:
        cancel_event = threading.Event()
        task = asyncio.create_task(awaitable, name=f"knowledge:{task_id}")
        record = KnowledgeTaskRecord(
            task_id=task_id,
            kb_name=kb_name,
            task=task,
            cancel_event=cancel_event,
        )
        with self._lock:
            existing = self._records.get(task_id)
            if existing and not existing.task.done():
                task.cancel()
                raise RuntimeError(f"Knowledge task '{task_id}' is already running")
            self._records[task_id] = record
        task.add_done_callback(lambda completed: self._discard(task_id, completed))

    def _discard(self, task_id: str, completed: asyncio.Task[Any]) -> None:
        with self._lock:
            record = self._records.get(task_id)
            if record and record.task is completed:
                self._records.pop(task_id, None)
        # Retrieve unexpected exceptions so the event loop does not emit a
        # noisy "Task exception was never retrieved" warning.  The job
        # wrappers normally convert failures into stream events themselves.
        if not completed.cancelled():
            try:
                completed.exception()
            except (asyncio.CancelledError, Exception):
                pass

    def get(self, task_id: str) -> KnowledgeTaskRecord | None:
        with self._lock:
            return self._records.get(task_id)

    def get_cancel_event(self, task_id: str) -> threading.Event | None:
        record = self.get(task_id)
        return record.cancel_event if record is not None else None

    async def cancel(self, task_id: str, *, kb_name: str) -> bool:
        record = self.get(task_id)
        if record is None or record.kb_name != kb_name or record.task.done():
            return False
        # asyncio cancellation cannot stop code already executing in a worker
        # thread. Signal that code first so hashing/copying exits at its next
        # bounded checkpoint, then publish the terminal intent before asking
        # the coroutine to stop.  A provider that swallows CancelledError must
        # never be able to resurrect the task as error/completed.
        record.cancel_event.set()
        from cognivoy.api.utils.task_id_manager import TaskIDManager

        TaskIDManager.get_instance().update_task_status(task_id, "cancelled")
        record.task.cancel()
        # Do not let an uncooperative third-party coroutine hold the cancel API
        # open forever.  The live record remains registered until its callback
        # observes actual settlement, while terminal guards reject late writes.
        if self._cancel_wait_seconds > 0:
            await asyncio.wait({record.task}, timeout=self._cancel_wait_seconds)
        return True


def get_knowledge_task_registry() -> KnowledgeTaskRegistry:
    return KnowledgeTaskRegistry.get_instance()
