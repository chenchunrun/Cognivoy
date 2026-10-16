"""Tests for the Deep Solve loop capability: capability hooks, owned tools, session."""

from __future__ import annotations

import json

import pytest

from cognivoy.capabilities.solve import SOLVE_TOOL_NAMES, SolveLoopCapability
from cognivoy.capabilities.solve.capability import resolve_solve_depth
from cognivoy.capabilities.solve.session import SolveSession, get_session
from cognivoy.capabilities.solve.tools import (
    SolveFinishStepTool,
    SolvePlanTool,
    SolveReplanTool,
)
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream import StreamEventType
from cognivoy.core.stream_bus import StreamBus


def _solve_context(session_id: str = "t1") -> UnifiedContext:
    return UnifiedContext(
        user_message="solve it",
        metadata={"solve_mode": True, "solve_session_id": session_id},
    )


# ---- capability hooks ---------------------------------------------------------


def test_plugin_inactive_outside_solve_mode() -> None:
    plugin = SolveLoopCapability()
    ctx = UnifiedContext(user_message="hi")
    assert plugin.is_active(ctx) is False
    assert plugin.system_block(ctx, language="en", prompts={}) is None


def test_plugin_declares_owned_tools_and_playbook() -> None:
    plugin = SolveLoopCapability()
    ctx = _solve_context()
    assert plugin.is_active(ctx) is True
    # The plugin contributes only its own tools; it reuses chat's full built-in
    # surface (no curated builtin list).
    assert tuple(plugin.owned_tools) == SOLVE_TOOL_NAMES
    block = plugin.system_block(ctx, language="en", prompts={})
    assert block is not None and "solve_plan" in block.content


def test_plugin_augments_session_id_only_for_solve_tools() -> None:
    plugin = SolveLoopCapability()
    ctx = _solve_context("turn-9")
    assert plugin.augment_kwargs("solve_plan", {}, ctx)["_solve_session_id"] == "turn-9"
    # A reused built-in is left untouched (no private kwarg leak).
    assert "_solve_session_id" not in plugin.augment_kwargs("rag", {}, ctx)


def test_solve_depth_routes_simple_exercises_to_quick_mode() -> None:
    assert (
        resolve_solve_depth(UnifiedContext(user_message="求解 x²-5x+6=0，并代入验证。")) == "quick"
    )
    assert (
        resolve_solve_depth(UnifiedContext(user_message="Prove the theorem for all cases."))
        == "standard"
    )
    assert (
        resolve_solve_depth(
            UnifiedContext(user_message="根据教材求解", knowledge_bases=["algebra"])
        )
        == "deep"
    )
    assert (
        resolve_solve_depth(
            UnifiedContext(user_message="简单题", config_overrides={"solve_depth": "deep"})
        )
        == "deep"
    )
    assert (
        resolve_solve_depth(
            UnifiedContext(user_message="simple", config_overrides={"depth": "deep"})
        )
        == "deep"
    )


@pytest.mark.asyncio
async def test_independent_planner_commits_plan_before_solver(monkeypatch) -> None:
    from cognivoy.agents.solve.roles import SolvePlan, SolvePlannerAgent

    async def fake_process(self, **kwargs):
        return SolvePlan(analysis="independent plan", steps=["derive", "verify"])

    monkeypatch.setattr(SolvePlannerAgent, "process", fake_process)
    ctx = _solve_context("planner-turn")
    block = await SolveLoopCapability().pre_loop(ctx, StreamBus())
    session = get_session("planner-turn")
    assert [step.goal for step in session.steps] == ["derive", "verify"]
    assert block is not None and "independent planner" in block.content


@pytest.mark.asyncio
async def test_quick_solve_skips_planner_model_and_commits_one_step(monkeypatch) -> None:
    from cognivoy.agents.solve.roles import SolvePlannerAgent

    async def should_not_run(self, **kwargs):
        raise AssertionError("quick solve must not call the planner")

    monkeypatch.setattr(SolvePlannerAgent, "process", should_not_run)
    ctx = _solve_context("quick-turn")
    ctx.language = "zh"
    ctx.metadata["solve_depth"] = "quick"
    bus = StreamBus()

    block = await SolveLoopCapability().pre_loop(ctx, bus)

    session = get_session("quick-turn")
    assert len(session.steps) == 1
    assert "直接求解" in session.steps[0].goal
    assert block is not None and "Quick solve plan" in block.content
    assert any(event.type.value == "progress" for event in bus.history())


# ---- owned tools ----------------------------------------------------------


@pytest.mark.asyncio
async def test_plan_then_finish_steps_advances_and_folds() -> None:
    sid = "test-plan-1"
    plan = await SolvePlanTool().execute(
        _solve_session_id=sid,
        analysis="factor it",
        steps=[{"goal": "factor"}, {"goal": "solve roots"}],
    )
    assert plan.success
    payload = json.loads(plan.content)
    assert payload["status"] == "planned"
    assert payload["next"]["id"] == "S1"
    assert [s["id"] for s in payload["steps"]] == ["S1", "S2"]

    fin = await SolveFinishStepTool().execute(
        _solve_session_id=sid, step_id="S1", summary="x^2-4=(x-2)(x+2)"
    )
    assert fin.success
    # The checkpoint summary is what the loop folds the step's chatter into.
    assert "S1" in fin.metadata["_context_checkpoint"]["summary"]
    fp = json.loads(fin.content)
    assert fp["next"]["id"] == "S2"
    assert fp["all_done"] is False

    fin2 = await SolveFinishStepTool().execute(_solve_session_id=sid, step_id="S2", summary="x=±2")
    fp2 = json.loads(fin2.content)
    assert fp2["next"] is None
    assert fp2["all_done"] is True


@pytest.mark.asyncio
async def test_finish_unknown_step_is_rejected() -> None:
    sid = "test-plan-2"
    await SolvePlanTool().execute(_solve_session_id=sid, analysis="a", steps=[{"goal": "g1"}])
    res = await SolveFinishStepTool().execute(_solve_session_id=sid, step_id="S99", summary="x")
    assert res.success is False


@pytest.mark.asyncio
async def test_replan_is_budget_limited() -> None:
    sid = "test-replan-1"
    await SolvePlanTool().execute(_solve_session_id=sid, analysis="a", steps=[{"goal": "g1"}])
    get_session(sid).max_replans = 1

    ok = await SolveReplanTool().execute(
        _solve_session_id=sid, reason="wrong", steps=[{"goal": "g2"}]
    )
    assert ok.success is True
    refused = await SolveReplanTool().execute(
        _solve_session_id=sid, reason="again", steps=[{"goal": "g3"}]
    )
    assert refused.success is False
    assert "budget_exhausted" in refused.content


@pytest.mark.asyncio
async def test_tools_require_a_session_id() -> None:
    res = await SolvePlanTool().execute(analysis="a", steps=[{"goal": "g"}])
    assert res.success is False


# ---- session --------------------------------------------------------------


def test_session_replan_resets_steps_and_counts() -> None:
    session = SolveSession(session_id="x", max_replans=2)
    session.set_plan("a", [("S1", "g1")])
    assert session.replan("redo", [("S1", "g2")]) is True
    assert session.replans == 1
    assert session.next_step().goal == "g2"
    assert session.all_done() is False


@pytest.mark.asyncio
async def test_deep_solve_restores_reasoning_and_verification_checkpoint(
    monkeypatch,
) -> None:
    from cognivoy.agents.solve.roles import SolveVerifierAgent
    from cognivoy.capabilities.solve import capability as capability_module
    from cognivoy.capabilities.solve import checkpoint
    from cognivoy.capabilities.solve.capability import DeepSolveCapability
    from cognivoy.core.agentic.usage import UsageTracker

    finished: list[str] = []

    class FakeCheckpoint:
        def __init__(self, _turn_id: str) -> None:
            pass

        def start(self, *, fingerprint: str):
            assert fingerprint
            return {"resume_count": 1, "stages": {"reasoning": {}, "verification": {}}}

        def load_stage(self, stage: str):
            if stage == "reasoning":
                return {
                    "solver_payload": {"response": "x = 2", "artifacts": []},
                    "session": {
                        "analysis": "isolate x",
                        "steps": [{"id": "S1", "goal": "solve", "done": True, "summary": "x=2"}],
                        "replans": 0,
                        "max_replans": 2,
                    },
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                        "total_calls": 1,
                    },
                }
            if stage == "verification":
                return {"passed": True, "critique": "checked", "corrected_answer": ""}
            return None

        def save_stage(self, *_args, **_kwargs) -> None:
            raise AssertionError("restored stages must not be recomputed")

        def finish(self, *, status: str) -> None:
            finished.append(status)

    class FakePipeline:
        def __init__(self, **_kwargs) -> None:
            self.usage = UsageTracker(model="test")

        async def run(self, *_args, **_kwargs):
            raise AssertionError("reasoning checkpoint should skip the solver")

    async def verifier_must_not_run(self, **_kwargs):
        raise AssertionError("verification checkpoint should skip the verifier")

    monkeypatch.setattr(checkpoint, "DeepSolveCheckpointStore", FakeCheckpoint)
    monkeypatch.setattr(capability_module, "AgenticChatPipeline", FakePipeline)
    monkeypatch.setattr(capability_module, "get_solve_params", lambda: {})
    monkeypatch.setattr(SolveVerifierAgent, "process", verifier_must_not_run)

    bus = StreamBus()
    await DeepSolveCapability().run(
        UnifiedContext(
            session_id="session-1",
            user_message="Solve x + 1 = 3",
            language="en",
            metadata={"turn_id": "turn-1"},
        ),
        bus,
    )

    result = next(event for event in bus.history() if event.type == StreamEventType.RESULT)
    assert result.metadata["response"] == "x = 2"
    assert result.metadata["verification"]["passed"] is True
    assert result.metadata["resumed_from_checkpoint"] is True
    assert result.metadata["metadata"]["cost_summary"]["total_tokens"] == 15
    assert finished == ["completed"]
