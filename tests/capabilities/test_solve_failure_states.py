"""Failure-state contracts, using fake models and temporary checkpoints only."""

from __future__ import annotations

import asyncio

import pytest

from cognivoy.agents.solve.roles import SolveVerification
from cognivoy.capabilities.solve import capability as capability_module
from cognivoy.capabilities.solve import checkpoint as checkpoint_module
from cognivoy.core.agentic.usage import UsageTracker
from cognivoy.core.context import UnifiedContext
from cognivoy.core.errors import CapabilityGenerationError
from cognivoy.core.stream import StreamEventType
from cognivoy.core.stream_bus import StreamBus


@pytest.fixture
def solve_harness(monkeypatch, tmp_path):
    state = {"response": "x = 2", "solver_calls": 0, "verifier_calls": 0, "timeout": True}
    store = checkpoint_module.DeepSolveCheckpointStore("test-turn", root=tmp_path)

    class FakePipeline:
        def __init__(self, **_kwargs):
            self.usage = UsageTracker(model="test")

        async def run(self, *_args, **_kwargs):
            state["solver_calls"] += 1
            return {"response": state["response"], "metadata": {"context_budget": {"used": 12}}}

    class FakeVerifier:
        def __init__(self, **_kwargs):
            pass

        async def process(self, **_kwargs):
            state["verifier_calls"] += 1
            if state["timeout"]:
                raise TimeoutError("fake provider timeout")
            return SolveVerification(passed=True, critique="Checked.", corrected_answer="")

    monkeypatch.setattr(capability_module, "AgenticChatPipeline", FakePipeline)
    monkeypatch.setattr(capability_module, "get_solve_params", lambda: {})
    monkeypatch.setattr(checkpoint_module, "DeepSolveCheckpointStore", lambda _turn_id: store)
    monkeypatch.setattr("cognivoy.agents.solve.SolveVerifierAgent", FakeVerifier)
    return state, store


@pytest.mark.asyncio
@pytest.mark.parametrize("language", ["en", "zh"])
async def test_verifier_timeout_is_unverified_and_retry_preserves_solver(solve_harness, language):
    state, checkpoint = solve_harness
    context = UnifiedContext(user_message="Solve x + 1 = 3", language=language)
    bus = StreamBus()

    await capability_module.DeepSolveCapability().run(context, bus)

    result = next(event.metadata for event in bus.history() if event.type == StreamEventType.RESULT)
    assert result["response"] == "x = 2"
    assert result["verification"]["passed"] is False
    assert result["verification"]["status"] == "unverified"
    assert result["metadata"]["partial"] is True
    assert result["metadata"]["context_budget"] == {"used": 12}
    assert result["metadata"]["checkpoint_resumable"] is True
    assert result["metadata"]["partial_reasons"] == ["verification_timeout"]
    assert checkpoint.metadata()["status"] == "timed_out"
    assert checkpoint.load_stage("verification") is None
    assert any(event.metadata.get("verification_incomplete") for event in bus.history())

    state["timeout"] = False
    resumed = StreamBus()
    await capability_module.DeepSolveCapability().run(context, resumed)
    assert state["solver_calls"] == 1
    assert state["verifier_calls"] == 2
    assert checkpoint.metadata()["status"] == "completed"
    assert checkpoint.load_stage("verification")["passed"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("language", ["en", "zh"])
async def test_empty_solver_is_retryable_failure_and_not_cached(solve_harness, language):
    state, checkpoint = solve_harness
    state["response"] = "   "
    context = UnifiedContext(user_message="Solve x + 1 = 3", language=language)
    bus = StreamBus()

    with pytest.raises(CapabilityGenerationError) as caught:
        await capability_module.DeepSolveCapability().run(context, bus)
    assert caught.value.reason == "empty_solution"
    assert checkpoint.metadata()["status"] == "failed"
    assert checkpoint.load_stage("reasoning") is None
    assert not any(event.type == StreamEventType.RESULT for event in bus.history())
    assert state["verifier_calls"] == 0

    state.update(response="x = 2", timeout=False)
    await capability_module.DeepSolveCapability().run(context, StreamBus())
    assert state["solver_calls"] == 2
    assert checkpoint.metadata()["status"] == "completed"


@pytest.mark.asyncio
async def test_verifier_cancellation_propagates_without_result(solve_harness, monkeypatch):
    _, checkpoint = solve_harness

    async def cancelled(_awaitable, *, timeout):
        _awaitable.close()
        raise asyncio.CancelledError

    monkeypatch.setattr(capability_module.asyncio, "wait_for", cancelled)
    bus = StreamBus()
    with pytest.raises(asyncio.CancelledError):
        await capability_module.DeepSolveCapability().run(
            UnifiedContext(user_message="Solve x + 1 = 3"), bus
        )
    assert checkpoint.load_stage("reasoning") is not None
    assert checkpoint.load_stage("verification") is None
    assert not any(event.type == StreamEventType.RESULT for event in bus.history())
