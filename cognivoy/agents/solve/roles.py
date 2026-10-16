"""Role-isolated agents used around the tool-using Deep Solve worker."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel, Field

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.core.trace import build_trace_metadata, new_call_id


class SolvePlan(BaseModel):
    analysis: str = ""
    steps: list[str] = Field(min_length=1, max_length=12)


class SolveVerification(BaseModel):
    passed: bool
    critique: str = ""
    corrected_answer: str = ""


def _json_object(raw: str) -> dict[str, Any]:
    text = raw.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
    payload = json.loads(text)
    if not isinstance(payload, dict):
        raise ValueError("Expected a JSON object")
    return payload


class SolvePlannerAgent(BaseAgent):
    def __init__(self, *, language: str, token_tracker: Any = None) -> None:
        super().__init__(
            module_name="solve",
            agent_name="planner_agent",
            language=language,
            token_tracker=token_tracker,
        )

    async def process(self, *, problem: str, context: str) -> SolvePlan:
        response = await self.call_llm(
            user_prompt=self.get_prompt("user_template").format(
                problem=problem.strip(),
                context=context.strip() or "(none)",
            ),
            system_prompt=self.get_prompt("system"),
            response_format={"type": "json_object"},
            stage="planning",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("solve-planner"),
                phase="planning",
                label="Independent solve planner",
                call_kind="solve_planner",
                trace_role="planner",
                trace_kind="llm_output",
            ),
        )
        return SolvePlan.model_validate(_json_object(response))


class SolveVerifierAgent(BaseAgent):
    def __init__(self, *, language: str, token_tracker: Any = None) -> None:
        super().__init__(
            module_name="solve",
            agent_name="verifier_agent",
            language=language,
            token_tracker=token_tracker,
        )

    async def process(
        self,
        *,
        problem: str,
        plan: list[dict[str, Any]],
        candidate_answer: str,
    ) -> SolveVerification:
        response = await self.call_llm(
            user_prompt=self.get_prompt("user_template").format(
                problem=problem.strip(),
                plan=json.dumps(plan, ensure_ascii=False),
                candidate_answer=candidate_answer.strip(),
            ),
            system_prompt=self.get_prompt("system"),
            response_format={"type": "json_object"},
            stage="verification",
            trace_meta=build_trace_metadata(
                call_id=new_call_id("solve-verifier"),
                phase="verification",
                label="Independent answer verifier",
                call_kind="solve_verifier",
                trace_role="verifier",
                trace_kind="llm_output",
            ),
        )
        return SolveVerification.model_validate(_json_object(response))


__all__ = [
    "SolvePlan",
    "SolvePlannerAgent",
    "SolveVerification",
    "SolveVerifierAgent",
]
