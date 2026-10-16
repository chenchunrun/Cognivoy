from __future__ import annotations

import pytest

from cognivoy.agents.chat.round_budget import MAX_EXTENSION_TOKENS, RoundBudget
from cognivoy.core.agentic.tool_dispatch import DispatchOutcome


def observe(budget, query="one", success=True, content=None):
    if content is None:
        content = f"Evidence for {query}"
    call = {"id": "c1", "function": {"name": "github", "arguments": query}}
    budget.observe(
        [call],
        DispatchOutcome(
            successful_tool_call_ids=("c1",) if success else (),
            tool_messages=[{"tool_call_id": "c1", "content": content}],
        ),
    )


def test_distinct_successful_progress_extends_in_bounded_steps():
    budget = RoundBudget(8, 16)
    observe(budget, "one")
    observe(budget, "two")
    assert budget.extend(total_tokens=100)
    assert budget.limit == 12
    observe(budget, "three")
    assert budget.extend(total_tokens=100)
    assert budget.limit == 16
    assert not budget.extend(total_tokens=100)
    assert budget.reason == "round_limit"


@pytest.mark.parametrize("scenario", ["repeat", "failure", "empty"])
def test_unproductive_work_cannot_earn_headroom(scenario):
    budget = RoundBudget(8, 16)
    observe(budget)
    observe(
        budget,
        "one" if scenario == "repeat" else "two",
        success=scenario != "failure",
        content="" if scenario == "empty" else "evidence",
    )
    assert not budget.extend(total_tokens=0)
    assert budget.reason == "no_recent_progress"


def test_reordered_json_arguments_are_not_new_progress():
    budget = RoundBudget(8, 16)
    observe(budget, '{"a":1,"b":2}')
    observe(budget, '{"b":2, "a":1}')
    assert not budget.extend(total_tokens=0)


def test_new_arguments_with_identical_results_do_not_earn_headroom():
    budget = RoundBudget(8, 16)
    observe(budget, "one", content="same result")
    observe(budget, "two", content="same result")
    assert not budget.extend(total_tokens=0)


def test_usage_and_time_reserve_prevent_extension(monkeypatch):
    budget = RoundBudget(8, 16, started_at=0, extension_deadline_s=120)
    observe(budget, "one")
    observe(budget, "two")
    monkeypatch.setattr("cognivoy.agents.chat.round_budget.time.monotonic", lambda: 119)
    assert not budget.extend(total_tokens=MAX_EXTENSION_TOKENS)
    assert budget.reason == "usage_reserve"
    monkeypatch.setattr("cognivoy.agents.chat.round_budget.time.monotonic", lambda: 121)
    assert not budget.extend(total_tokens=0)
    assert budget.reason == "time_reserve"
    budget.paused_seconds = 5
    assert budget.extend(total_tokens=0)


def test_single_success_or_disabled_headroom_does_not_extend():
    budget = RoundBudget(8, 8)
    observe(budget, "one")
    observe(budget, "two")
    assert not budget.extend(total_tokens=0)
    single = RoundBudget(1, 9)
    observe(single)
    assert not single.extend(total_tokens=0)
