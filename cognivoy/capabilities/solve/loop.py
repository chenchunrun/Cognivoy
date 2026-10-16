"""Deep Solve loop-capability hooks.

Solve runs as the chat agent loop with a deterministic spine: a committed plan,
a per-step done gate, and a bounded replan (the SolveSession + three owned
tools), while the actual problem-solving happens at the loop's exit using the
shared built-in tools. Active only when the turn is marked ``solve_mode`` by
:class:`cognivoy.capabilities.solve.capability.DeepSolveCapability`.
"""

from __future__ import annotations

import asyncio
from importlib import resources
from typing import Any

from cognivoy.capabilities.protocol import PromptBlock
from cognivoy.capabilities.solve.session import DEFAULT_MAX_REPLANS, get_session
from cognivoy.capabilities.solve.tools import SOLVE_TOOL_NAMES
from cognivoy.core.context import UnifiedContext


class SolveLoopCapability:
    """Turn-scoped integration for deep problem solving.

    Reuses the full chat tool surface — every built-in, with the user's
    composer toggles respected (web_search / reason / geogebra_analysis mount
    iff the user enabled them, exactly as in chat) — and adds the solve spine
    (plan / finish-step / replan) on top.
    """

    name = "solve"
    owned_tools = SOLVE_TOOL_NAMES

    def is_active(self, context: UnifiedContext) -> bool:
        return bool(context.metadata.get("solve_mode"))

    def system_block(
        self,
        context: UnifiedContext,
        *,
        language: str,
        prompts: dict[str, Any],
    ) -> PromptBlock | None:
        if not self.is_active(context):
            return None
        override = _prompt_text(prompts, ("solve", "system"))
        content = override or _load_system_prompt(language)
        mode = str(context.metadata.get("requested_solve_mode") or "full")
        answer_format = str(context.metadata.get("solve_answer_format") or "structured")
        mode_directives = {
            "guided": (
                "Guide the learner with progressive hints and use ask_user when their next step matters; "
                "do not reveal more than needed before they attempt it."
            ),
            "check": (
                "Treat the user's message as an attempted solution: identify the first incorrect or "
                "unsupported step, verify the remainder, and provide a corrected conclusion."
            ),
            "full": "Provide a complete solution and an explicit independent check.",
        }
        format_directives = {
            "concise": "Keep the final answer concise while preserving the decisive derivation and check.",
            "step_by_step": "Present the final answer as numbered, teachable steps.",
            "structured": "Structure the final answer into assumptions, method, derivation, conclusion, and verification.",
        }
        content = (
            f"{content}\n\n[Requested solve mode: {mode}] {mode_directives[mode]}\n"
            f"[Requested answer format: {answer_format}] {format_directives[answer_format]}"
        )
        return PromptBlock("deep_solve", content)

    def augment_kwargs(
        self,
        tool_name: str,
        kwargs: dict[str, Any],
        context: UnifiedContext,
    ) -> dict[str, Any]:
        if self.is_active(context) and tool_name in SOLVE_TOOL_NAMES:
            session_id = str(context.metadata.get("solve_session_id") or "").strip()
            # Seed the replan budget from the solve settings (the solve
            # capability forwards ``max_replans`` into metadata); never the model.
            session = get_session(session_id)
            try:
                session.max_replans = int(
                    context.metadata.get("solve_max_replans", DEFAULT_MAX_REPLANS)
                )
            except (TypeError, ValueError):
                session.max_replans = DEFAULT_MAX_REPLANS
            updated = dict(kwargs)
            updated["_solve_session_id"] = session_id
            return updated
        return kwargs

    def pre_loop_seed(self, context: UnifiedContext) -> str:
        _ = context
        return ""

    async def pre_loop(self, context, stream, *, usage=None) -> PromptBlock | None:
        """Run an independent planner before the tool-using solver starts."""
        session_id = str(context.metadata.get("solve_session_id") or "").strip()
        session = get_session(session_id)
        if context.metadata.get("solve_depth") == "quick":
            # Simple exercises do not justify a separate planning-model call.
            # Keep the deterministic solve gate and independent verifier while
            # reducing the path to one solve step plus one check.
            analysis = "Use the shortest valid solution, then verify the result once."
            steps = ["Solve the problem directly and verify the final result once."]
            if str(context.language or "").lower().startswith("zh"):
                analysis = "采用最短的有效解法，并对最终结果做一次验证。"
                steps = ["直接求解，并对最终结果进行一次验证。"]
            session.set_plan(analysis, [("S1", steps[0])])
            await stream.progress(
                "已识别为简单题，使用快速求解与一次验证。"
                if str(context.language or "").lower().startswith("zh")
                else "Simple problem detected: using a quick solve and one verification.",
                source="deep_solve",
                stage="planning",
                metadata={"trace_kind": "progress_summary", "solve_depth": "quick"},
            )
            return PromptBlock(
                "deep_solve_plan",
                f"[Quick solve plan: execute S1, call solve_finish_step once, then answer.]\nSteps: {session.map()}",
            )

        from cognivoy.agents.solve import SolvePlannerAgent

        planner = SolvePlannerAgent(language=context.language, token_tracker=usage)
        async with stream.stage("planning", source="deep_solve"):
            try:
                plan = await asyncio.wait_for(
                    planner.process(
                        problem=context.user_message,
                        context=str(context.metadata.get("conversation_context_text", "") or ""),
                    ),
                    timeout=30,
                )
            except asyncio.TimeoutError:
                analysis = (
                    "规划超时，改用直接求解并验证。"
                    if str(context.language).lower().startswith("zh")
                    else "Planning timed out; solve directly and verify."
                )
                session.set_plan(analysis, [("S1", analysis)])
                await stream.progress(
                    analysis,
                    source="deep_solve",
                    stage="planning",
                    metadata={"trace_kind": "warning", "fallback": "direct_solve"},
                )
                return PromptBlock(
                    "deep_solve_plan",
                    f"[Planner timeout fallback: execute S1 directly, verify, then answer.]\nSteps: {session.map()}",
                )
        session.set_plan(
            plan.analysis,
            [(f"S{index}", goal) for index, goal in enumerate(plan.steps, 1)],
        )
        return PromptBlock(
            "deep_solve_plan",
            (
                "[An independent planner has committed this solve plan. Do not call "
                "solve_plan again. Execute S1 first, call solve_finish_step after each "
                f"step, and replan only if verification or execution finds a defect.]\n"
                f"Analysis: {plan.analysis}\nSteps: {session.map()}"
            ),
        )


def _prompt_text(prompts: dict[str, Any], path: tuple[str, ...]) -> str:
    value: Any = prompts
    for key in path:
        if not isinstance(value, dict):
            return ""
        value = value.get(key)
    return value if isinstance(value, str) and value else ""


def _load_system_prompt(language: str) -> str:
    lang = "zh" if language.lower().startswith("zh") else "en"
    prompt = resources.files(__package__).joinpath("prompts", lang, "system.md")
    return prompt.read_text(encoding="utf-8").strip()


__all__ = ["SolveLoopCapability"]
