import pytest

from cognivoy.agents.solve.roles import SolvePlannerAgent, SolveVerifierAgent


@pytest.mark.asyncio
async def test_planner_returns_a_bounded_structured_plan(monkeypatch):
    async def fake_call(self, **kwargs):
        assert kwargs["stage"] == "planning"
        return '{"analysis":"factorization","steps":["factor","check roots"]}'

    monkeypatch.setattr(SolvePlannerAgent, "call_llm", fake_call)
    agent = SolvePlannerAgent(language="en")
    plan = await agent.process(problem="x^2-4=0", context="")
    assert plan.steps == ["factor", "check roots"]


@pytest.mark.asyncio
async def test_verifier_can_reject_and_supply_a_correction(monkeypatch):
    async def fake_call(self, **kwargs):
        assert kwargs["stage"] == "verification"
        return '{"passed":false,"critique":"missed negative root","corrected_answer":"x = -2 or 2"}'

    monkeypatch.setattr(SolveVerifierAgent, "call_llm", fake_call)
    agent = SolveVerifierAgent(language="en")
    result = await agent.process(
        problem="x^2-4=0",
        plan=[{"id": "S1", "goal": "factor", "done": True}],
        candidate_answer="x=2",
    )
    assert result.passed is False
    assert "-2" in result.corrected_answer
