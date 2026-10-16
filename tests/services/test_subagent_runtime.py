"""External-agent wall-clock limits cancel the underlying run cleanly."""

import asyncio

import pytest

from cognivoy.services.coordination import SharedCoordinationStore
from cognivoy.services.subagent.base import SubagentBackend
from cognivoy.services.subagent.config import BackendConfig
from cognivoy.services.subagent.runtime import (
    SubagentCapacityError,
    SubagentOutputLimitError,
    SubagentQueueTimeoutError,
    SubagentResourceGovernor,
    SubagentResourcePolicy,
    SubagentTimeoutError,
    consult_with_timeout,
)
from cognivoy.services.subagent.types import ConsultResult, DetectResult, SubagentEvent


class _Backend(SubagentBackend):
    kind = "test"
    display_name = "Test"
    cli_command = "test"

    def __init__(self, *, delay: float) -> None:
        self.delay = delay
        self.cancelled = asyncio.Event()

    async def detect(self) -> DetectResult:
        return DetectResult(self.kind, self.display_name, available=True)

    async def consult(self, question, *, on_event, **_kwargs) -> ConsultResult:
        try:
            await asyncio.sleep(self.delay)
            return ConsultResult(final_text=question, success=True)
        finally:
            if self.delay > 0.01:
                self.cancelled.set()


@pytest.mark.asyncio
async def test_non_admin_cannot_start_host_local_agent(monkeypatch) -> None:
    backend = _Backend(delay=0)
    monkeypatch.setattr(
        "cognivoy.multi_user.context.get_current_user",
        lambda: type("User", (), {"is_admin": False})(),
    )

    with pytest.raises(PermissionError, match="Admin access required"):
        await consult_with_timeout(
            backend,
            "hello",
            config=BackendConfig(runtime_timeout_seconds=30),
            on_event=lambda _event: None,
        )


@pytest.mark.asyncio
async def test_non_admin_can_still_consult_partner_backend(monkeypatch) -> None:
    class _PartnerBackend(_Backend):
        local_cli = False

    backend = _PartnerBackend(delay=0)
    monkeypatch.setattr(
        "cognivoy.multi_user.context.get_current_user",
        lambda: type("User", (), {"is_admin": False})(),
    )
    result = await consult_with_timeout(
        backend,
        "hello",
        config=BackendConfig(runtime_timeout_seconds=30),
        on_event=lambda _event: None,
    )
    assert result.success is True


@pytest.mark.asyncio
async def test_consult_timeout_cancels_backend_and_reports_budget() -> None:
    backend = _Backend(delay=1)
    config = BackendConfig(runtime_timeout_seconds=0.01)  # type: ignore[arg-type]

    with pytest.raises(SubagentTimeoutError) as raised:
        await consult_with_timeout(
            backend,
            "hello",
            config=config,
            on_event=lambda _event: None,
        )

    assert raised.value.timeout_seconds == 0.01
    assert backend.cancelled.is_set()


@pytest.mark.asyncio
async def test_consult_finishes_inside_runtime_budget() -> None:
    backend = _Backend(delay=0)
    result = await consult_with_timeout(
        backend,
        "hello",
        config=BackendConfig(runtime_timeout_seconds=30),
        on_event=lambda _event: None,
    )
    assert result.success is True
    assert result.final_text == "hello"


@pytest.mark.asyncio
async def test_consult_is_blocked_before_agent_start_when_network_is_disabled(
    monkeypatch,
) -> None:
    backend = _Backend(delay=0)
    started = False

    async def consult(*_args, **_kwargs):
        nonlocal started
        started = True
        return ConsultResult(final_text="unexpected", success=True)

    backend.consult = consult  # type: ignore[method-assign]
    monkeypatch.setattr(
        "cognivoy.services.subagent.runtime.require_outbound_network",
        lambda _feature: (_ for _ in ()).throw(RuntimeError("network disabled")),
    )

    with pytest.raises(RuntimeError, match="network disabled"):
        await consult_with_timeout(
            backend,
            "hello",
            config=BackendConfig(runtime_timeout_seconds=30),
            on_event=lambda _event: None,
        )
    assert started is False


@pytest.mark.asyncio
async def test_resource_governor_queues_then_runs_in_fifo_order(monkeypatch) -> None:
    governor = SubagentResourceGovernor()
    policy = SubagentResourcePolicy(
        max_concurrent_runs=1,
        max_queued_runs=2,
        queue_timeout_seconds=1,
        max_output_chars=10_000,
    )
    monkeypatch.setattr("cognivoy.services.subagent.runtime._resource_governor", governor)
    monkeypatch.setattr("cognivoy.services.subagent.runtime.load_resource_policy", lambda: policy)
    release = asyncio.Event()
    starts: list[str] = []

    class ControlledBackend(_Backend):
        async def consult(self, question, *, on_event, **_kwargs):
            starts.append(question)
            if question == "first":
                await release.wait()
            return ConsultResult(final_text=question, success=True)

    backend = ControlledBackend(delay=0)
    first = asyncio.create_task(
        consult_with_timeout(backend, "first", config=BackendConfig(), on_event=lambda _e: None)
    )
    await asyncio.sleep(0)
    second = asyncio.create_task(
        consult_with_timeout(backend, "second", config=BackendConfig(), on_event=lambda _e: None)
    )
    await asyncio.sleep(0.02)
    assert starts == ["first"]
    assert governor.snapshot()["queued_runs"] == 1

    release.set()
    assert (await first).final_text == "first"
    assert (await second).final_text == "second"
    stats = governor.snapshot()
    assert stats["active_runs"] == 0
    assert stats["queued_runs"] == 0
    assert stats["completed_runs"] == 2


@pytest.mark.asyncio
async def test_resource_governors_share_capacity_across_workers(tmp_path) -> None:
    store = SharedCoordinationStore(tmp_path / "coordination.sqlite3")
    first = SubagentResourceGovernor(shared_store=store, namespace="agents")
    second = SubagentResourceGovernor(shared_store=store, namespace="agents")
    policy = SubagentResourcePolicy(1, 1, 1, 10_000)
    entered: list[str] = []
    release = asyncio.Event()

    async def occupy(governor, name):
        async with governor.slot(policy, lease_seconds=30):
            entered.append(name)
            if name == "first":
                await release.wait()

    first_task = asyncio.create_task(occupy(first, "first"))
    await asyncio.sleep(0.05)
    second_task = asyncio.create_task(occupy(second, "second"))
    await asyncio.sleep(0.05)
    assert entered == ["first"]
    assert first.snapshot()["active_runs"] == 1
    assert second.snapshot()["queued_runs"] == 1

    release.set()
    await asyncio.gather(first_task, second_task)
    assert entered == ["first", "second"]
    assert first.snapshot()["active_runs"] == 0


@pytest.mark.asyncio
async def test_resource_governor_rejects_when_queue_is_full(monkeypatch) -> None:
    governor = SubagentResourceGovernor()
    policy = SubagentResourcePolicy(1, 0, 1, 10_000)
    monkeypatch.setattr("cognivoy.services.subagent.runtime._resource_governor", governor)
    monkeypatch.setattr("cognivoy.services.subagent.runtime.load_resource_policy", lambda: policy)
    release = asyncio.Event()

    class BlockingBackend(_Backend):
        async def consult(self, question, *, on_event, **_kwargs):
            await release.wait()
            return ConsultResult(final_text=question)

    backend = BlockingBackend(delay=0)
    first = asyncio.create_task(
        consult_with_timeout(backend, "first", config=BackendConfig(), on_event=lambda _e: None)
    )
    await asyncio.sleep(0)
    with pytest.raises(SubagentCapacityError):
        await consult_with_timeout(
            backend, "second", config=BackendConfig(), on_event=lambda _e: None
        )
    release.set()
    await first
    assert governor.snapshot()["rejected_runs"] == 1


@pytest.mark.asyncio
async def test_resource_governor_times_out_queued_run(monkeypatch) -> None:
    governor = SubagentResourceGovernor()
    policy = SubagentResourcePolicy(1, 1, 0.01, 10_000)
    monkeypatch.setattr("cognivoy.services.subagent.runtime._resource_governor", governor)
    monkeypatch.setattr("cognivoy.services.subagent.runtime.load_resource_policy", lambda: policy)
    release = asyncio.Event()

    class BlockingBackend(_Backend):
        async def consult(self, question, *, on_event, **_kwargs):
            await release.wait()
            return ConsultResult(final_text=question)

    backend = BlockingBackend(delay=0)
    first = asyncio.create_task(
        consult_with_timeout(backend, "first", config=BackendConfig(), on_event=lambda _e: None)
    )
    await asyncio.sleep(0)
    with pytest.raises(SubagentQueueTimeoutError):
        await consult_with_timeout(
            backend, "second", config=BackendConfig(), on_event=lambda _e: None
        )
    release.set()
    await first
    assert governor.snapshot()["queue_timed_out_runs"] == 1


@pytest.mark.asyncio
async def test_output_limit_preserves_prefix_and_cancels_backend(monkeypatch) -> None:
    governor = SubagentResourceGovernor()
    policy = SubagentResourcePolicy(1, 1, 1, 5)
    monkeypatch.setattr("cognivoy.services.subagent.runtime._resource_governor", governor)
    monkeypatch.setattr("cognivoy.services.subagent.runtime.load_resource_policy", lambda: policy)
    events: list[SubagentEvent] = []
    cancelled = asyncio.Event()

    async def capture(event: SubagentEvent) -> None:
        events.append(event)

    class StreamingBackend(_Backend):
        async def consult(self, question, *, on_event, **_kwargs):
            try:
                await on_event(SubagentEvent(kind="text", text="abcdefgh"))
                return ConsultResult(final_text="abcdefgh")
            finally:
                cancelled.set()

    with pytest.raises(SubagentOutputLimitError) as raised:
        await consult_with_timeout(
            StreamingBackend(delay=0),
            "hello",
            config=BackendConfig(),
            on_event=capture,
        )
    assert raised.value.limit_chars == 5
    assert [event.text for event in events] == ["abcde"]
    assert events[0].meta["output_truncated"] is True
    assert cancelled.is_set()
    assert governor.snapshot()["output_limited_runs"] == 1


@pytest.mark.asyncio
async def test_output_limit_counts_cumulative_stream_rows_once(monkeypatch) -> None:
    """Growing rows with one merge id represent one logical output, not three."""

    governor = SubagentResourceGovernor()
    policy = SubagentResourcePolicy(1, 1, 1, 5)
    monkeypatch.setattr("cognivoy.services.subagent.runtime._resource_governor", governor)
    monkeypatch.setattr("cognivoy.services.subagent.runtime.load_resource_policy", lambda: policy)
    events: list[SubagentEvent] = []

    async def capture(event: SubagentEvent) -> None:
        events.append(event)

    class CumulativeBackend(_Backend):
        async def consult(self, question, *, on_event, **_kwargs):
            for text in ("a", "abc", "abcde"):
                await on_event(SubagentEvent(kind="text", text=text, meta={"merge_id": "answer"}))
            return ConsultResult(final_text="abcde", success=True)

    result = await consult_with_timeout(
        CumulativeBackend(delay=0),
        "hello",
        config=BackendConfig(),
        on_event=capture,
    )

    assert result.final_text == "abcde"
    assert [event.text for event in events] == ["a", "abc", "abcde"]
    assert governor.snapshot()["output_limited_runs"] == 0
