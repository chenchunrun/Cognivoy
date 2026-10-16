"""Authoritative resource and wall-clock boundaries for external agents."""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
import time
from typing import Any, AsyncIterator
import uuid

from cognivoy.services.config import get_runtime_settings_service
from cognivoy.services.config.network_policy import require_outbound_network
from cognivoy.services.coordination import (
    SharedCoordinationStore,
    get_shared_coordination_store,
)
from cognivoy.services.subagent.base import SubagentBackend
from cognivoy.services.subagent.config import BackendConfig
from cognivoy.services.subagent.types import ConsultResult, SubagentControlSignal, SubagentEvent


class SubagentTimeoutError(TimeoutError):
    """Raised after the configured external-agent runtime limit expires."""

    def __init__(self, timeout_seconds: int) -> None:
        self.timeout_seconds = timeout_seconds
        super().__init__(f"External agent exceeded its {timeout_seconds}-second runtime limit.")


class SubagentCapacityError(RuntimeError):
    """Raised before spawn when the deployment queue is full."""


class SubagentQueueTimeoutError(TimeoutError):
    """Raised before spawn when a run waits too long for capacity."""

    def __init__(self, timeout_seconds: float) -> None:
        self.timeout_seconds = timeout_seconds
        super().__init__(f"External agent waited {timeout_seconds:g} seconds for capacity.")


class SubagentOutputLimitError(SubagentControlSignal):
    """Raised after preserving the allowed output prefix and cancelling the run."""

    def __init__(self, limit_chars: int, preserved_text: str = "") -> None:
        self.limit_chars = limit_chars
        self.preserved_text = preserved_text
        super().__init__(f"External agent output exceeded {limit_chars} characters.")


@dataclass(frozen=True, slots=True)
class SubagentResourcePolicy:
    max_concurrent_runs: int
    max_queued_runs: int
    queue_timeout_seconds: float
    max_output_chars: int


def load_resource_policy() -> SubagentResourcePolicy:
    system = get_runtime_settings_service().load_system(include_process_overrides=True)
    return SubagentResourcePolicy(
        max_concurrent_runs=int(system["subagent_max_concurrent_runs"]),
        max_queued_runs=int(system["subagent_max_queued_runs"]),
        queue_timeout_seconds=float(system["subagent_queue_timeout_seconds"]),
        max_output_chars=int(system["subagent_max_output_chars"]),
    )


class SubagentResourceGovernor:
    """FIFO capacity gate, optionally shared by every deployment worker."""

    def __init__(
        self,
        *,
        shared_store: SharedCoordinationStore | None = None,
        namespace: str = "subagents",
        shared: bool = False,
    ) -> None:
        self._condition = asyncio.Condition()
        self._active = 0
        self._waiters: deque[object] = deque()
        self._completed = 0
        self._failed = 0
        self._timed_out = 0
        self._rejected = 0
        self._queue_timed_out = 0
        self._output_limited = 0
        self._shared_store = shared_store
        self._namespace = namespace
        self._shared = shared

    def _store(self) -> SharedCoordinationStore | None:
        if self._shared_store is not None:
            return self._shared_store
        if self._shared:
            return get_shared_coordination_store()
        return None

    @asynccontextmanager
    async def slot(
        self,
        policy: SubagentResourcePolicy,
        *,
        lease_seconds: float | None = None,
    ) -> AsyncIterator[None]:
        store = self._store()
        if store is not None:
            ticket = uuid.uuid4().hex
            deadline = time.monotonic() + policy.queue_timeout_seconds
            active_lease = max(
                30.0,
                float(
                    lease_seconds
                    if lease_seconds is not None
                    else policy.queue_timeout_seconds + 30.0
                ),
            )
            try:
                while True:
                    decision = await asyncio.to_thread(
                        store.try_acquire_slot,
                        namespace=self._namespace,
                        ticket=ticket,
                        max_active=policy.max_concurrent_runs,
                        max_queued=policy.max_queued_runs,
                        lease_seconds=active_lease,
                        waiter_ttl_seconds=policy.queue_timeout_seconds + 5.0,
                    )
                    if decision == "acquired":
                        break
                    if decision == "rejected":
                        store.increment_metric(self._namespace, "rejected_runs")
                        raise SubagentCapacityError("External agent capacity queue is full.")
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        store.release_slot(namespace=self._namespace, ticket=ticket)
                        store.increment_metric(self._namespace, "queue_timed_out_runs")
                        raise SubagentQueueTimeoutError(policy.queue_timeout_seconds)
                    await asyncio.sleep(min(0.05, remaining))
                try:
                    yield
                finally:
                    await asyncio.to_thread(
                        store.release_slot,
                        namespace=self._namespace,
                        ticket=ticket,
                    )
            except BaseException:
                await asyncio.to_thread(
                    store.release_slot,
                    namespace=self._namespace,
                    ticket=ticket,
                )
                raise
            return

        ticket: object | None = None
        async with self._condition:
            if self._active >= policy.max_concurrent_runs or self._waiters:
                if len(self._waiters) >= policy.max_queued_runs:
                    self._rejected += 1
                    raise SubagentCapacityError("External agent capacity queue is full.")
                ticket = object()
                self._waiters.append(ticket)
                deadline = time.monotonic() + policy.queue_timeout_seconds
                try:
                    while (
                        not self._waiters
                        or self._waiters[0] is not ticket
                        or self._active >= policy.max_concurrent_runs
                    ):
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise asyncio.TimeoutError
                        await asyncio.wait_for(self._condition.wait(), timeout=remaining)
                except (TimeoutError, asyncio.TimeoutError):
                    try:
                        self._waiters.remove(ticket)
                    except ValueError:
                        pass
                    self._queue_timed_out += 1
                    self._condition.notify_all()
                    raise SubagentQueueTimeoutError(policy.queue_timeout_seconds) from None
                self._waiters.popleft()
            self._active += 1

        try:
            yield
        finally:
            async with self._condition:
                self._active = max(0, self._active - 1)
                self._condition.notify_all()

    def record_completed(self) -> None:
        store = self._store()
        if store is not None:
            store.increment_metric(self._namespace, "completed_runs")
            return
        self._completed += 1

    def record_failed(self) -> None:
        store = self._store()
        if store is not None:
            store.increment_metric(self._namespace, "failed_runs")
            return
        self._failed += 1

    def record_timed_out(self) -> None:
        store = self._store()
        if store is not None:
            store.increment_metric(self._namespace, "timed_out_runs")
            return
        self._timed_out += 1

    def record_output_limited(self) -> None:
        store = self._store()
        if store is not None:
            store.increment_metric(self._namespace, "output_limited_runs")
            return
        self._output_limited += 1

    def snapshot(self) -> dict[str, int]:
        store = self._store()
        if store is not None:
            slots = store.slot_snapshot(self._namespace)
            metrics = store.metrics(self._namespace)
            return {
                **slots,
                "completed_runs": metrics.get("completed_runs", 0),
                "failed_runs": metrics.get("failed_runs", 0),
                "timed_out_runs": metrics.get("timed_out_runs", 0),
                "rejected_runs": metrics.get("rejected_runs", 0),
                "queue_timed_out_runs": metrics.get("queue_timed_out_runs", 0),
                "output_limited_runs": metrics.get("output_limited_runs", 0),
            }
        return {
            "active_runs": self._active,
            "queued_runs": len(self._waiters),
            "completed_runs": self._completed,
            "failed_runs": self._failed,
            "timed_out_runs": self._timed_out,
            "rejected_runs": self._rejected,
            "queue_timed_out_runs": self._queue_timed_out,
            "output_limited_runs": self._output_limited,
        }


_resource_governor = SubagentResourceGovernor(shared=True)


def get_subagent_resource_status() -> dict[str, Any]:
    policy = load_resource_policy()
    return {
        "policy": {
            "max_concurrent_runs": policy.max_concurrent_runs,
            "max_queued_runs": policy.max_queued_runs,
            "queue_timeout_seconds": policy.queue_timeout_seconds,
            "max_output_chars": policy.max_output_chars,
        },
        "runtime": _resource_governor.snapshot(),
    }


async def consult_with_timeout(
    backend: SubagentBackend,
    question: str,
    *,
    config: BackendConfig | None,
    **kwargs: Any,
) -> ConsultResult:
    """Queue, bound output, run a backend, and cancel it at the total limit."""

    if getattr(backend, "local_cli", True):
        # This is the authoritative backstop, not just a UI/API restriction:
        # stale connection metadata must not let an ordinary account spawn a
        # host CLI with the server process's files and credentials.
        from cognivoy.multi_user.context import get_current_user

        if not get_current_user().is_admin:
            raise PermissionError("Admin access required for local agent CLIs")
    require_outbound_network(f"agent:{backend.kind}")
    resolved_config = config or BackendConfig()
    timeout_seconds = resolved_config.runtime_timeout_seconds
    policy = load_resource_policy()
    original_on_event = kwargs.get("on_event")
    emitted_chars = 0
    preserved_parts: list[str] = []
    merge_texts: dict[str, str] = {}

    async def bounded_on_event(event: SubagentEvent) -> None:
        nonlocal emitted_chars
        text = event.text or ""
        merge_id_value = event.meta.get("merge_id")
        merge_id = str(merge_id_value) if merge_id_value is not None else ""
        previous = merge_texts.get(merge_id, "") if merge_id else ""
        base_chars = emitted_chars - len(previous)
        allowed_text_chars = max(0, policy.max_output_chars - base_chars)
        if len(text) > allowed_text_chars:
            prefix = text[:allowed_text_chars]
            if prefix and original_on_event is not None:
                if merge_id:
                    merge_texts[merge_id] = prefix
                    emitted_chars = base_chars + len(prefix)
                else:
                    preserved_parts.append(prefix)
                    emitted_chars += len(prefix)
                await original_on_event(
                    replace(
                        event,
                        text=prefix,
                        meta={**event.meta, "output_truncated": True},
                    )
                )
            raise SubagentOutputLimitError(
                policy.max_output_chars,
                prefix if merge_id else "".join(preserved_parts),
            )
        if merge_id:
            merge_texts[merge_id] = text
            emitted_chars = base_chars + len(text)
        else:
            emitted_chars += len(text)
        if text and not merge_id:
            preserved_parts.append(text)
        if original_on_event is not None:
            await original_on_event(event)

    kwargs["on_event"] = bounded_on_event
    try:
        async with _resource_governor.slot(policy, lease_seconds=float(timeout_seconds) + 30.0):
            try:
                result = await asyncio.wait_for(
                    backend.consult(question, config=resolved_config, **kwargs),
                    timeout=timeout_seconds,
                )
                if emitted_chars == 0 and len(result.final_text) > policy.max_output_chars:
                    raise SubagentOutputLimitError(
                        policy.max_output_chars,
                        result.final_text[: policy.max_output_chars],
                    )
                _resource_governor.record_completed()
                return result
            except SubagentOutputLimitError:
                _resource_governor.record_output_limited()
                raise
            except (TimeoutError, asyncio.TimeoutError) as exc:
                _resource_governor.record_timed_out()
                raise SubagentTimeoutError(timeout_seconds) from exc
            except BaseException:
                _resource_governor.record_failed()
                raise
    except (SubagentCapacityError, SubagentQueueTimeoutError):
        raise


__all__ = [
    "SubagentCapacityError",
    "SubagentOutputLimitError",
    "SubagentQueueTimeoutError",
    "SubagentResourceGovernor",
    "SubagentResourcePolicy",
    "SubagentTimeoutError",
    "consult_with_timeout",
    "get_subagent_resource_status",
    "load_resource_policy",
]
