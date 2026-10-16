"""Deep Solve capability — Planner → tool-using Solver → Verifier.

The independent Planner runs through the solve loop's ``pre_loop`` hook, the
chat agent loop acts as the tool-using Solver, and this capability runs an
independent Verifier over the candidate answer before the turn closes. The solve loop capability
(:class:`cognivoy.capabilities.solve.loop.SolveLoopCapability`) mounts the
solve tools (``solve_plan`` / ``solve_finish_step`` / ``solve_replan``) plus a
curated built-in toolset
(``rag`` / ``code_execution`` / ``geogebra_analysis`` / …) and injects the
solver playbook; the in-memory :class:`SolveSession` holds the plan, the
per-step gate, and the replan budget.

Design axiom (shared with chat / mastery): the intelligence lives at the
loop's exit — the model plans and solves — while the deterministic spine
(commit to a plan, don't skip steps, bounded replan) is engine state read and
written through tools.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from typing import Any

from cognivoy.agents._shared.capability_result import emit_capability_result
from cognivoy.agents.chat.agentic_pipeline import AgenticChatPipeline
from cognivoy.capabilities.solve.session import (
    DEFAULT_MAX_REPLANS,
    SolveSession,
    SolveStep,
    get_session,
)
from cognivoy.capabilities.solve.tools import SOLVE_TOOL_NAMES
from cognivoy.core.capability_protocol import BaseCapability, CapabilityManifest
from cognivoy.core.context import UnifiedContext
from cognivoy.core.errors import CapabilityGenerationError
from cognivoy.core.stream_bus import StreamBus
from cognivoy.runtime.request_contracts import (
    get_capability_request_schema,
    validate_deep_solve_request_config,
)
from cognivoy.services.config.capabilities_settings import get_solve_params

logger = logging.getLogger(__name__)

_UNSAFE_ID_CHARS = re.compile(r"[^A-Za-z0-9_-]")
_COMPLEXITY_MARKERS = re.compile(
    r"(证明|推导|研究|比较|所有情况|一般形式|多步骤|优化|建模|prove|derive|research|compare|all cases|general form|optimi[sz]|model)",
    re.IGNORECASE,
)


def resolve_solve_depth(context: UnifiedContext) -> str:
    """Choose execution depth without spending another model call."""
    explicit = str(
        context.config_overrides.get("depth")
        or context.config_overrides.get("solve_depth")
        or "auto"
    ).lower()
    if explicit in {"quick", "standard", "deep"}:
        return explicit
    text = context.user_message.strip()
    if context.attachments or context.knowledge_bases or len(text) > 500:
        return "deep"
    if len(text) <= 220 and not _COMPLEXITY_MARKERS.search(text):
        return "quick"
    return "standard"


def _sanitize(raw: str) -> str:
    cleaned = _UNSAFE_ID_CHARS.sub("_", raw).strip("_")
    return cleaned or "default"


def resolve_solve_session_id(context: UnifiedContext) -> str:
    """Resolve the in-memory session key for this solve turn.

    A solve turn is one-shot, so the turn id (falling back to the session /
    message id) is enough to scope the plan + replan budget; concurrent turns
    get distinct keys and never race.
    """
    raw = str(
        context.metadata.get("turn_id")
        or context.session_id
        or context.metadata.get("message_id")
        or "default"
    )
    return _sanitize(raw)


def _session_checkpoint(session: SolveSession) -> dict[str, Any]:
    return {
        "analysis": session.analysis,
        "steps": [
            {
                "id": step.id,
                "goal": step.goal,
                "done": step.done,
                "summary": step.summary,
            }
            for step in session.steps
        ],
        "replans": session.replans,
        "max_replans": session.max_replans,
    }


def _restore_session(session: SolveSession, value: dict[str, Any]) -> None:
    session.analysis = str(value.get("analysis") or "")
    session.steps = [
        SolveStep(
            id=str(row.get("id") or ""),
            goal=str(row.get("goal") or ""),
            done=bool(row.get("done")),
            summary=str(row.get("summary") or ""),
        )
        for row in value.get("steps", [])
        if isinstance(row, dict) and str(row.get("id") or "").strip()
    ][:12]
    session.replans = max(0, int(value.get("replans") or 0))
    session.max_replans = max(0, int(value.get("max_replans") or DEFAULT_MAX_REPLANS))


def _restore_usage(usage: Any, value: dict[str, Any]) -> None:
    if usage is None:
        return
    usage.prompt_tokens = max(0, int(value.get("prompt_tokens") or 0))
    usage.completion_tokens = max(0, int(value.get("completion_tokens") or 0))
    usage.total_tokens = max(
        usage.prompt_tokens + usage.completion_tokens,
        int(value.get("total_tokens") or 0),
    )
    usage.calls = max(0, int(value.get("total_calls") or value.get("calls") or 0))


class DeepSolveCapability(BaseCapability):
    manifest = CapabilityManifest(
        name="deep_solve",
        description="Multi-agent planning, tool-using solving, and independent verification.",
        stages=["planning", "reasoning", "verification", "writing"],
        tools_used=[*SOLVE_TOOL_NAMES, "rag", "code_execution", "geogebra_analysis", "reason"],
        cli_aliases=["solve"],
        request_schema=get_capability_request_schema("deep_solve"),
    )

    async def run(self, context: UnifiedContext, stream: StreamBus) -> None:
        request_config = validate_deep_solve_request_config(context.config_overrides)
        context.metadata["solve_mode"] = True
        context.metadata["requested_solve_mode"] = request_config.solve_mode
        context.metadata["solve_answer_format"] = request_config.answer_format
        context.metadata["solve_session_id"] = resolve_solve_session_id(context)
        solve_depth = resolve_solve_depth(context)
        context.metadata["solve_depth"] = solve_depth
        # Read the solve settings and forward them so the page actually drives
        # the loop: max_rounds → the loop's round budget, max_replans → the
        # SolveSession gate (via metadata, read in SolveLoopCapability),
        # temperature / max_tokens → the LLM calls.
        try:
            params = get_solve_params()
        except Exception as exc:  # pragma: no cover - defensive config read
            logger.warning("Failed to load solve params, using defaults: %s", exc)
            params = {}
        context.metadata["solve_max_replans"] = (
            0 if solve_depth == "quick" else int(params.get("max_replans", DEFAULT_MAX_REPLANS))
        )
        configured_rounds = request_config.max_rounds or params.get("max_rounds")
        max_rounds = (
            min(int(configured_rounds or 12), 5) if solve_depth == "quick" else configured_rounds
        )
        pipeline = AgenticChatPipeline(
            language=context.language,
            max_rounds=max_rounds,
            temperature=params.get("temperature"),
            max_tokens=params.get("max_tokens"),
        )
        from cognivoy.capabilities.solve.checkpoint import DeepSolveCheckpointStore

        turn_id = str(
            context.metadata.get("turn_id")
            or context.session_id
            or context.metadata.get("message_id")
            or "deep-solve"
        )
        checkpoint = DeepSolveCheckpointStore(_sanitize(turn_id))
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "content": context.user_message,
                    "language": context.language,
                    "config": request_config.model_dump(mode="json"),
                    "knowledge_bases": list(context.knowledge_bases),
                    "attachments": [
                        {
                            "type": item.type,
                            "filename": item.filename,
                            "url": item.url,
                        }
                        for item in context.attachments
                    ],
                },
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        checkpoint_meta = await asyncio.to_thread(checkpoint.start, fingerprint=fingerprint)
        resumed_from_checkpoint = bool(checkpoint_meta.get("resume_count"))
        session = get_session(context.metadata["solve_session_id"])
        # Deep Solve owns settlement. The shared solver streams its candidate
        # answer but deliberately withholds RESULT until the independent
        # verifier has accepted or corrected it.
        reasoning_checkpoint = (
            await asyncio.to_thread(checkpoint.load_stage, "reasoning")
            if checkpoint_meta.get("status") != "completed"
            else None
        )
        if (
            reasoning_checkpoint is not None
            and isinstance(reasoning_checkpoint.get("solver_payload"), dict)
            and str(reasoning_checkpoint["solver_payload"].get("response") or "").strip()
        ):
            solver_payload = dict(reasoning_checkpoint["solver_payload"])
            if isinstance(reasoning_checkpoint.get("session"), dict):
                _restore_session(session, reasoning_checkpoint["session"])
            if isinstance(reasoning_checkpoint.get("usage"), dict):
                _restore_usage(pipeline.usage, reasoning_checkpoint["usage"])
            await stream.progress(
                "Restored completed solving work from the durable checkpoint.",
                source=self.name,
                stage="reasoning",
                metadata={"trace_kind": "checkpoint", "resumed": True},
            )
        else:
            solver_payload = await pipeline.run(context, stream, emit_result=False)
            if str(solver_payload.get("response") or "").strip():
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "reasoning",
                    {
                        "solver_payload": solver_payload,
                        "session": _session_checkpoint(session),
                        "usage": pipeline.usage.summary() if pipeline.usage is not None else {},
                    },
                )

        from cognivoy.agents.solve import SolveVerification, SolveVerifierAgent

        candidate = str(solver_payload.get("response") or "").strip()
        if not candidate:
            await asyncio.to_thread(checkpoint.finish, status="failed")
            raise CapabilityGenerationError(
                "求解器未能生成有效答案，请重试或简化问题。"
                if str(context.language).lower().startswith("zh")
                else "The solver did not produce a usable answer. Please retry or simplify the problem.",
                reason="empty_solution",
            )
        verification_incomplete = False
        verification_checkpoint = (
            await asyncio.to_thread(checkpoint.load_stage, "verification")
            if checkpoint_meta.get("status") != "completed"
            else None
        )
        try:
            verification = (
                SolveVerification.model_validate(verification_checkpoint)
                if verification_checkpoint is not None
                else None
            )
        except Exception:
            verification = None
        if verification is not None:
            await stream.progress(
                "Restored independent verification from the durable checkpoint.",
                source=self.name,
                stage="verification",
                metadata={"trace_kind": "checkpoint", "resumed": True},
            )
        else:
            verifier = SolveVerifierAgent(language=context.language, token_tracker=pipeline.usage)
            async with stream.stage("verification", source=self.name):
                try:
                    verification = await asyncio.wait_for(
                        verifier.process(
                            problem=context.user_message,
                            plan=session.map(),
                            candidate_answer=candidate,
                        ),
                        timeout=30,
                    )
                except asyncio.TimeoutError:
                    verification_incomplete = True
                    verification = SolveVerification(
                        passed=False,
                        critique=(
                            "独立验证超时；已保留求解器答案，请复核关键步骤。"
                            if str(context.language).lower().startswith("zh")
                            else "Independent verification timed out; the solver answer is preserved. Check key steps."
                        ),
                        corrected_answer="",
                    )
                    await stream.progress(
                        verification.critique,
                        source=self.name,
                        stage="verification",
                        metadata={
                            "trace_kind": "warning",
                            "verification_incomplete": True,
                            "retryable": True,
                        },
                    )
                await stream.observation(
                    verification.critique,
                    source=self.name,
                    stage="verification",
                    metadata={
                        "call_kind": "solve_verification",
                        "passed": verification.passed,
                        "verification_incomplete": verification_incomplete,
                        "agent_role": "verifier",
                    },
                )
            if not verification_incomplete:
                await asyncio.to_thread(
                    checkpoint.save_stage,
                    "verification",
                    verification.model_dump(mode="json"),
                )
        final_answer = candidate
        if not verification.passed and verification.corrected_answer.strip():
            final_answer = verification.corrected_answer.strip()
            async with stream.stage("writing", source=self.name):
                await stream.content(
                    "\n\n" + final_answer,
                    source=self.name,
                    stage="writing",
                    metadata={
                        "call_kind": "solve_verified_correction",
                        "agent_role": "verifier",
                    },
                )
        final_payload = {
            **solver_payload,
            "response": final_answer,
            "engine": "multi_agent_solve",
            "solve_depth": solve_depth,
            "solve_mode": request_config.solve_mode,
            "answer_format": request_config.answer_format,
            "max_rounds": max_rounds,
            "verification": verification.model_dump(),
            "resumed_from_checkpoint": resumed_from_checkpoint,
        }
        if verification_incomplete:
            final_payload["verification"]["status"] = "unverified"
            final_payload["verification_incomplete"] = True
            final_payload["metadata"] = {
                **(solver_payload.get("metadata") or {}),
                "partial": True,
                "partial_reasons": ["verification_timeout"],
                "verification_incomplete": True,
                "retryable": True,
                "checkpoint_resumable": True,
            }
        await emit_capability_result(
            stream,
            final_payload,
            source=self.name,
            usage=pipeline.usage,
        )
        await asyncio.to_thread(
            checkpoint.finish, status="timed_out" if verification_incomplete else "completed"
        )


__all__ = ["DeepSolveCapability", "resolve_solve_depth", "resolve_solve_session_id"]
