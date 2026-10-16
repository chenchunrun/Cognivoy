"""
Chat Orchestrator
=================

Unified entry point that routes user messages to the appropriate capability.
All consumers (CLI, WebSocket, SDK) call the orchestrator.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator
import uuid

from cognivoy.core.context import UnifiedContext
from cognivoy.core.errors import CapabilityGenerationError
from cognivoy.core.stream import StreamEvent, StreamEventType
from cognivoy.core.stream_bus import StreamBus, register_bus, unregister_bus
from cognivoy.events.event_bus import Event, EventType, get_event_bus
from cognivoy.runtime.capability_router import route_capability
from cognivoy.runtime.control_plane import ExecutionControlPlane, control_plane_scope
from cognivoy.runtime.registry.capability_registry import get_capability_registry
from cognivoy.runtime.registry.tool_registry import get_tool_registry

logger = logging.getLogger(__name__)

# Product-level hard stops. Capabilities may use smaller per-stage budgets and
# recover internally, but none may hold a learner's turn indefinitely.
CAPABILITY_TOTAL_TIMEOUT_SECONDS: dict[str, float] = {
    "chat": 180,
    "mastery_path": 180,
    "deep_solve": 180,
    # Grounded quiz generation can legitimately consume explore + plan + one
    # bounded question/recovery pass.  Ninety seconds cut that documented
    # sequence off before its own recovery could finish.
    "deep_question": 180,
    "deep_research": 600,
    "visualize": 300,
    "math_animator": 600,
}
MIN_TOTAL_TIMEOUT_SECONDS = 5.0
MAX_TOTAL_TIMEOUT_SECONDS = 900.0


async def _run_with_active_timeout(
    awaitable: Any,
    *,
    timeout_seconds: float,
    pause_event: asyncio.Event | None = None,
    resume_event: asyncio.Event | None = None,
) -> None:
    """Run a capability with an active-execution budget.

    ``ask_user`` pauses are human think time, not model runtime. The turn
    runtime clears ``resume_event`` and sets ``pause_event`` while awaiting the
    reply, so that wall-clock interval does not consume this budget.
    """
    if pause_event is None or resume_event is None:
        await asyncio.wait_for(awaitable, timeout=timeout_seconds)
        return

    task = asyncio.create_task(awaitable)
    remaining = timeout_seconds
    loop = asyncio.get_running_loop()
    try:
        while not task.done():
            await resume_event.wait()
            started = loop.time()
            paused = asyncio.create_task(pause_event.wait())
            done, _ = await asyncio.wait(
                {task, paused},
                timeout=remaining,
                return_when=asyncio.FIRST_COMPLETED,
            )
            remaining -= loop.time() - started
            if task in done:
                paused.cancel()
                await asyncio.gather(paused, return_exceptions=True)
                await task
                return
            if paused in done:
                continue
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            raise TimeoutError
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def _turn_timeout_seconds(context: UnifiedContext, capability: str) -> float:
    default = CAPABILITY_TOTAL_TIMEOUT_SECONDS.get(capability, 180.0)
    raw = context.config_overrides.get("total_timeout_seconds", default)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = default
    return min(MAX_TOTAL_TIMEOUT_SECONDS, max(MIN_TOTAL_TIMEOUT_SECONDS, value))


def _timeout_message(language: str, seconds: float) -> str:
    if str(language or "").lower().startswith("zh"):
        return f"本次任务已达到 {int(seconds)} 秒运行上限。已完成的内容仍会保留，你可以重试或改用更快的模式。"
    return (
        f"This task reached its {int(seconds)}-second runtime limit. "
        "Completed output is preserved; retry or choose a faster mode."
    )


class ChatOrchestrator:
    """
    Routes a ``UnifiedContext`` to the correct capability, manages
    the ``StreamBus`` lifecycle, and publishes completion events.
    """

    def __init__(self) -> None:
        self._cap_registry = get_capability_registry()
        self._tool_registry = get_tool_registry()

    async def handle(self, context: UnifiedContext) -> AsyncIterator[StreamEvent]:
        """
        Execute a single user turn and yield streaming events.

        If ``context.active_capability`` is set, the corresponding capability
        handles the turn. Otherwise, the default ``chat`` capability is used.
        """
        from cognivoy.services.prompt.language import infer_response_language

        context.language = infer_response_language(context.user_message, context.language)
        if not context.session_id:
            context.session_id = str(uuid.uuid4())

        cap_name = context.active_capability or "chat"
        if cap_name == "auto":
            cap_name = route_capability(context)
            context.active_capability = cap_name
        control_plane = ExecutionControlPlane.from_context(context)
        capability_decision = control_plane.authorize_capability(cap_name)
        if not capability_decision.allowed:
            bus = StreamBus()
            await bus.error(
                capability_decision.reason,
                source="orchestrator",
                metadata={
                    "turn_terminal": True,
                    "status": "denied",
                    "policy_decision_id": capability_decision.decision_id,
                    "policy_rule_id": capability_decision.rule_id,
                },
            )
            await bus.emit(
                StreamEvent(
                    type=StreamEventType.DONE,
                    source="orchestrator",
                    metadata={"status": "denied"},
                )
            )
            await bus.close()
            async for event in bus.subscribe():
                yield event
            return
        capability = self._cap_registry.get(cap_name)

        if capability is None:
            bus = StreamBus()
            await bus.error(
                f"Unknown capability: {cap_name}. "
                f"Available: {self._cap_registry.list_capabilities()}",
                source="orchestrator",
                metadata={"turn_terminal": True, "status": "failed"},
            )
            await bus.emit(
                StreamEvent(
                    type=StreamEventType.DONE,
                    source="orchestrator",
                    metadata={"status": "failed"},
                )
            )
            await bus.close()
            async for event in bus.subscribe():
                yield event
            return

        yield StreamEvent(
            type=StreamEventType.SESSION,
            source="orchestrator",
            metadata={
                "session_id": context.session_id,
                "turn_id": str(context.metadata.get("turn_id", "")),
            },
        )

        bus = StreamBus()
        _turn_id = str(context.metadata.get("turn_id") or "")
        if _turn_id:
            register_bus(_turn_id, bus)

        async def _run() -> None:
            status = "completed"
            try:
                timeout_seconds = _turn_timeout_seconds(context, cap_name)
                with control_plane_scope(control_plane):
                    await _run_with_active_timeout(
                        capability.run(context, bus),
                        timeout_seconds=timeout_seconds,
                        pause_event=context.metadata.get("user_input_pause_event"),
                        resume_event=context.metadata.get("user_input_resume_event"),
                    )
            except TimeoutError:
                status = "timed_out"
                logger.warning(
                    "Capability %s exceeded %.1fs total budget", cap_name, timeout_seconds
                )
                await bus.error(
                    _timeout_message(context.language, timeout_seconds),
                    source=cap_name,
                    metadata={
                        "turn_terminal": True,
                        "status": status,
                        "retryable": True,
                        "timeout_seconds": timeout_seconds,
                    },
                )
            except Exception as exc:
                status = "failed"
                logger.error("Capability %s failed: %s", cap_name, exc, exc_info=True)
                await bus.error(
                    str(exc),
                    source=cap_name,
                    metadata={
                        "turn_terminal": True,
                        "status": status,
                        **(
                            {"retryable": True, "reason": exc.reason}
                            if isinstance(exc, CapabilityGenerationError)
                            else {}
                        ),
                    },
                )
            finally:
                await bus.emit(
                    StreamEvent(
                        type=StreamEventType.DONE,
                        source=cap_name,
                        metadata={"status": status},
                    )
                )
                await bus.close()
                if _turn_id:
                    unregister_bus(_turn_id)

        stream = bus.subscribe()
        task = asyncio.create_task(_run())

        async for event in stream:
            yield event

        await task
        await self._publish_completion(context, cap_name)

    async def _publish_completion(self, context: UnifiedContext, cap_name: str) -> None:
        """Publish CAPABILITY_COMPLETE to the global EventBus."""
        try:
            bus = get_event_bus()
            await bus.publish(
                Event(
                    type=EventType.CAPABILITY_COMPLETE,
                    task_id=str(context.metadata.get("turn_id") or context.session_id),
                    user_input=context.user_message,
                    agent_output="",
                    metadata={
                        "capability": cap_name,
                        "session_id": context.session_id,
                        "turn_id": str(context.metadata.get("turn_id", "")),
                    },
                )
            )
        except Exception:
            logger.debug("EventBus publish failed (may not be running)", exc_info=True)

    def list_tools(self) -> list[str]:
        return self._tool_registry.list_tools()

    def list_capabilities(self) -> list[str]:
        return self._cap_registry.list_capabilities()

    def get_capability_manifests(self) -> list[dict[str, Any]]:
        return self._cap_registry.get_manifests()

    def get_tool_schemas(self, names: list[str] | None = None) -> list[dict[str, Any]]:
        return self._tool_registry.build_openai_schemas(names)
