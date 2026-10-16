"""
Plugins API Router
==================

Lists registered tools, capabilities, and playground plugins.
Provides direct tool execution for the Playground tester.
"""

import asyncio
import json
import time
from typing import Any, AsyncGenerator, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from cognivoy.agents.math_animator.renderer import (
    ManimRenderError,
    ManimRenderService,
)
from cognivoy.core.context import UnifiedContext
from cognivoy.core.i18n import t
from cognivoy.i18n.metadata_i18n import tool_description_i18n
from cognivoy.logging import (
    ProcessLogEvent,
    bind_log_context,
    capture_process_logs,
)
from cognivoy.logging.safe_logger import get_logger
from cognivoy.runtime.control_plane import ExecutionControlPlane, control_plane_scope
from cognivoy.runtime.registry.capability_registry import get_capability_registry
from cognivoy.runtime.registry.tool_registry import get_tool_registry

logger = get_logger(__name__)

router = APIRouter()


def _playground_execution_enabled() -> bool:
    from cognivoy.services.config import get_runtime_settings_service

    settings = get_runtime_settings_service().load_system(include_process_overrides=True)
    return bool(settings.get("playground_execution_enabled", True))


def _execution_disabled_response() -> JSONResponse:
    return _playground_json_error(
        403,
        "playground_execution_disabled",
        "Direct Playground execution has been disabled by an administrator.",
        retryable=False,
    )


def _playground_error(
    code: str,
    message: str,
    *,
    retryable: bool,
    details: dict[str, Any] | None = None,
    trace_id: str | None = None,
) -> dict[str, Any]:
    """Build the stable error contract shared by HTTP and SSE execution paths.

    Internal exception text is intentionally excluded.  The generated trace id
    is logged server-side and is the only value a user needs to report when an
    unexpected execution fails.
    """
    return {
        "code": code,
        "message": message,
        "details": details or {},
        "retryable": retryable,
        "trace_id": trace_id or uuid4().hex,
    }


def _playground_json_error(
    status_code: int,
    code: str,
    message: str,
    *,
    retryable: bool,
    details: dict[str, Any] | None = None,
) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=_playground_error(
            code,
            message,
            retryable=retryable,
            details=details,
        ),
    )


def _capability_availability(name: str) -> dict[str, Any]:
    """Return live optional-dependency readiness for frontend lock states."""
    if name == "math_animator":
        from cognivoy.agents.math_animator.availability import (
            get_math_animator_readiness,
        )

        readiness = get_math_animator_readiness()
        return {
            "name": name,
            "available": readiness.available,
            "missing_dependencies": list(readiness.missing_dependencies),
            "install_hint": readiness.install_hint,
        }
    return {"name": name, "available": True, "install_hint": ""}


def _discover_plugins() -> list[Any]:
    try:
        from cognivoy.plugins.loader import discover_plugins
    except Exception:
        logger.debug("Plugin loader unavailable; returning no plugins.", exc_info=True)
        return []
    return discover_plugins()


class ToolExecuteRequest(BaseModel):
    params: dict[str, Any] = Field(default_factory=dict)


class CapabilityExecuteRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    content: str
    tools: list[str] = Field(default_factory=list, alias="enabledTools")
    knowledge_bases: list[str] = Field(default_factory=list, alias="knowledgeBases")
    language: str = "en"
    config: dict[str, Any] = Field(default_factory=dict)
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    # ``bot_id`` is the legacy TutorBot field name; it now addresses a partner.
    partner_id: str | None = Field(default=None, alias="bot_id")
    session_id: str | None = None
    chat_id: str | None = None
    llm_selection: dict[str, str] | None = Field(default=None, alias="llmSelection")


class MathAnimatorRerenderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parent_turn_id: str = Field(pattern=r"^[A-Za-z0-9_-]{8,100}$")
    code: str = Field(min_length=1, max_length=200_000)
    output_mode: Literal["video", "image"] = "video"
    quality: Literal["low", "medium", "high"] = "medium"
    width: int | None = Field(default=None, ge=320, le=3840)
    height: int | None = Field(default=None, ge=240, le=2160)
    fps: int = Field(default=30, ge=1, le=120)


@router.get("/list")
async def list_plugins():
    tool_registry = get_tool_registry()
    capability_registry = get_capability_registry()
    plugin_manifests = _discover_plugins()

    tools = [
        {
            "name": definition.name,
            "description": definition.description,
            "description_i18n": tool_description_i18n(definition.name, definition.description),
            "parameters": [
                {
                    "name": parameter.name,
                    "type": parameter.type,
                    "description": parameter.description,
                    "required": parameter.required,
                    "default": parameter.default,
                    "enum": parameter.enum,
                }
                for parameter in definition.parameters
            ],
        }
        for definition in tool_registry.get_definitions()
    ]

    capabilities = [
        {
            **manifest,
            "availability": _capability_availability(str(manifest.get("name", ""))),
        }
        for manifest in capability_registry.get_manifests()
    ]

    plugins = [
        {
            "name": plugin.name,
            "type": plugin.type,
            "description": plugin.description,
            "stages": plugin.stages,
            "version": plugin.version,
            "author": plugin.author,
        }
        for plugin in plugin_manifests
    ]

    return {
        "tools": tools,
        "capabilities": capabilities,
        "plugins": plugins,
        "execution_enabled": _playground_execution_enabled(),
    }


@router.post("/math-animator/rerender")
async def rerender_math_animator_source(body: MathAnimatorRerenderRequest):
    """Render user-reviewed Manim source without running another LLM turn."""
    from cognivoy.agents.math_animator.availability import get_math_animator_readiness

    readiness = get_math_animator_readiness()
    if not readiness.available:
        return _playground_json_error(
            503,
            "capability_unavailable",
            readiness.install_hint or "Math Animator is unavailable.",
            retryable=False,
            details={"missing_dependencies": list(readiness.missing_dependencies)},
        )
    if (body.width is None) != (body.height is None):
        return _playground_json_error(
            422,
            "invalid_render_dimensions",
            "Width and height must be provided together.",
            retryable=False,
        )

    render_id = f"rerender-{uuid4().hex}"
    renderer = ManimRenderService(render_id)
    try:
        result = await renderer.render(
            code=body.code,
            output_mode=body.output_mode,
            quality=body.quality,
            width=body.width,
            height=body.height,
            fps=body.fps,
        )
    except ManimRenderError as exc:
        return _playground_json_error(
            422,
            "math_render_failed",
            str(exc),
            retryable=True,
            details={"parent_turn_id": body.parent_turn_id},
        )
    except Exception:
        payload = _playground_error(
            "math_render_failed",
            "The edited scene could not be rendered. Use the trace id to inspect server logs.",
            retryable=True,
            details={"parent_turn_id": body.parent_turn_id},
        )
        logger.exception(
            "Edited Math Animator render failed parent_turn_id=%s trace_id=%s",
            body.parent_turn_id,
            payload["trace_id"],
        )
        return JSONResponse(status_code=500, content=payload)

    return {
        "parent_turn_id": body.parent_turn_id,
        "render_id": render_id,
        "output_mode": result.output_mode,
        "artifacts": [artifact.model_dump() for artifact in result.artifacts],
        "quality": result.quality,
        "code": {"language": "python", "content": body.code},
    }


@router.post("/tools/{tool_name}/execute")
async def execute_tool(tool_name: str, body: ToolExecuteRequest):
    """Execute a single tool with explicit parameters (for Playground testing)."""
    if not _playground_execution_enabled():
        return _execution_disabled_response()
    registry = get_tool_registry()
    tool = registry.get(tool_name)
    if not tool:
        return _playground_json_error(
            404,
            "tool_not_found",
            t("api.tool_not_found", name=tool_name),
            retryable=False,
            details={"tool": tool_name},
        )

    try:
        control_context = UnifiedContext(
            session_id=f"playground-tool-{uuid4().hex}",
            metadata={"turn_id": uuid4().hex},
        )
        control_plane = ExecutionControlPlane.from_context(control_context)
        with control_plane_scope(control_plane):
            result = await registry.execute(tool_name, **body.params)
        return {
            "success": result.success,
            "content": result.content,
            "sources": result.sources,
            "metadata": result.metadata,
        }
    except Exception as exc:
        payload = _playground_error(
            "tool_execution_failed",
            "The tool could not be executed. Retry, or inspect the server log with the trace id.",
            retryable=True,
            details={"tool": tool_name},
        )
        logger.exception(
            "Playground tool execution failed tool=%s trace_id=%s",
            tool_name,
            payload["trace_id"],
        )
        return JSONResponse(status_code=500, content=payload)


def _sse(event: str, payload: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"


def _queue_process_emit(
    queue: asyncio.Queue[dict[str, Any]],
    loop: asyncio.AbstractEventLoop,
):
    def emit(event: ProcessLogEvent) -> None:
        payload = event.to_dict()
        if event.level in {"WARNING", "ERROR", "CRITICAL"}:
            # Providers sometimes concatenate a traceback into the message
            # itself. Keep the original server log, not its diagnostic text in SSE.
            payload["message"] = "Execution reported a problem. Check the server log."
        loop.call_soon_threadsafe(
            queue.put_nowait,
            {"kind": "process_log", "payload": payload},
        )

    return emit


async def _execute_stream(tool_name: str, params: dict[str, Any]) -> AsyncGenerator[str, None]:
    """Run a tool while streaming structured process logs and the final result."""
    registry = get_tool_registry()
    tool = registry.get(tool_name)
    if not tool:
        yield _sse(
            "error",
            _playground_error(
                "tool_not_found",
                t("api.tool_not_found", name=tool_name),
                retryable=False,
                details={"tool": tool_name},
            ),
        )
        return

    event_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    result_holder: dict[str, Any] = {}
    error_holder: dict[str, Any] = {}
    done = asyncio.Event()
    task_id = f"playground_tool_{tool_name}_{int(time.time() * 1000)}"

    async def _run():
        try:
            control_context = UnifiedContext(
                session_id=f"playground-tool-{uuid4().hex}",
                metadata={"turn_id": task_id},
            )
            control_plane = ExecutionControlPlane.from_context(control_context)

            with bind_log_context(task_id=task_id, capability="playground", sink="ui"):
                with capture_process_logs(_queue_process_emit(event_queue, loop), task_id=task_id):
                    with control_plane_scope(control_plane):
                        result = await registry.execute(tool_name, **params)
            result_holder["data"] = {
                "success": result.success,
                "content": result.content,
                "sources": result.sources,
                "metadata": result.metadata,
            }
        except Exception as exc:
            error_holder.update(
                _playground_error(
                    "tool_execution_failed",
                    "The tool could not be executed. Retry, or inspect the server log with the trace id.",
                    retryable=True,
                    details={"tool": tool_name},
                )
            )
            logger.exception(
                "Playground streamed tool execution failed tool=%s trace_id=%s",
                tool_name,
                error_holder["trace_id"],
            )
        finally:
            done.set()

    task = asyncio.create_task(_run())
    t0 = time.monotonic()

    try:
        while not done.is_set():
            try:
                item = await asyncio.wait_for(event_queue.get(), timeout=0.15)
                yield _sse(item["kind"], item["payload"])
            except asyncio.TimeoutError:
                pass

        while not event_queue.empty():
            item = event_queue.get_nowait()
            yield _sse(item["kind"], item["payload"])

        elapsed_ms = round((time.monotonic() - t0) * 1000)
        if error_holder:
            yield _sse("error", {**error_holder, "elapsed_ms": elapsed_ms})
        else:
            payload = {**result_holder.get("data", {}), "elapsed_ms": elapsed_ms}
            yield _sse("result", payload)
    finally:
        if not task.done():
            task.cancel()


@router.post("/tools/{tool_name}/execute-stream")
async def execute_tool_stream(tool_name: str, body: ToolExecuteRequest):
    """Execute a tool and stream process logs + result as SSE."""
    if not _playground_execution_enabled():
        return _execution_disabled_response()
    return StreamingResponse(
        _execute_stream(tool_name, body.params),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


async def _execute_capability_stream(
    capability_name: str,
    body: CapabilityExecuteRequest,
) -> AsyncGenerator[str, None]:
    """Run a capability while streaming process logs, trace events, and the result."""
    partner_id = (body.partner_id or "").strip()
    if capability_name == "chat" and partner_id:
        from cognivoy.api.routers.partners import (
            ChatMessageRequest,
            _ensure_running_partner,
            _partner_chat_stream,
        )

        if not body.content.strip():
            yield _sse(
                "error",
                _playground_error(
                    "content_required",
                    "Content is required.",
                    retryable=False,
                ),
            )
            return
        try:
            await _ensure_running_partner(partner_id)
        except HTTPException as exc:
            yield _sse(
                "error",
                _playground_error(
                    "partner_unavailable",
                    "Partner is unavailable." if exc.status_code >= 500 else str(exc.detail),
                    retryable=exc.status_code >= 500,
                    details={"status_code": exc.status_code, "partner_id": partner_id},
                ),
            )
            return
        request = ChatMessageRequest(
            content=body.content,
            session_id=body.session_id,
            chat_id=body.chat_id,
            llm_selection=body.llm_selection,
        )
        async for chunk in _partner_chat_stream(partner_id, request):
            yield chunk
        return

    from cognivoy.core.context import Attachment, UnifiedContext
    from cognivoy.runtime.orchestrator import ChatOrchestrator

    orch = ChatOrchestrator()
    if capability_name not in orch.list_capabilities():
        yield _sse(
            "error",
            _playground_error(
                "capability_not_found",
                f"Capability {capability_name!r} was not found.",
                retryable=False,
                details={"capability": capability_name},
            ),
        )
        return

    attachments = [
        Attachment(
            type=a.get("type", "file"),
            url=a.get("url", ""),
            base64=a.get("base64", ""),
            filename=a.get("filename", ""),
            mime_type=a.get("mime_type", ""),
        )
        for a in body.attachments
    ]

    ctx = UnifiedContext(
        user_message=body.content,
        enabled_tools=body.tools,
        active_capability=capability_name,
        knowledge_bases=body.knowledge_bases,
        attachments=attachments,
        config_overrides=body.config,
        language=body.language,
    )

    event_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    final_result: dict[str, Any] | None = None
    error_holder: dict[str, Any] = {}
    done = asyncio.Event()
    task_id = f"playground_capability_{capability_name}_{int(time.time() * 1000)}"

    async def _run():
        nonlocal final_result
        try:
            with bind_log_context(
                task_id=task_id,
                capability=capability_name,
                sink="ui",
            ):
                with capture_process_logs(_queue_process_emit(event_queue, loop), task_id=task_id):
                    async for event in orch.handle(ctx):
                        if event.type.value == "result":
                            final_result = dict(event.metadata)
                            continue
                        await event_queue.put({"kind": "stream", "payload": event.to_dict()})
        except Exception as exc:
            error_holder.update(
                _playground_error(
                    "capability_execution_failed",
                    "The capability could not be completed. Retry, or inspect the server log with the trace id.",
                    retryable=True,
                    details={"capability": capability_name},
                )
            )
            logger.exception(
                "Playground capability execution failed capability=%s trace_id=%s",
                capability_name,
                error_holder["trace_id"],
            )
        finally:
            done.set()

    task = asyncio.create_task(_run())
    t0 = time.monotonic()

    try:
        while not done.is_set():
            try:
                item = await asyncio.wait_for(event_queue.get(), timeout=0.15)
                yield _sse(item["kind"], item["payload"])
            except asyncio.TimeoutError:
                pass

        while not event_queue.empty():
            item = event_queue.get_nowait()
            yield _sse(item["kind"], item["payload"])

        elapsed_ms = round((time.monotonic() - t0) * 1000)
        if error_holder:
            yield _sse("error", {**error_holder, "elapsed_ms": elapsed_ms})
        else:
            yield _sse(
                "result",
                {"success": True, "data": final_result or {}, "elapsed_ms": elapsed_ms},
            )
    finally:
        if not task.done():
            task.cancel()


@router.post("/capabilities/{capability_name}/execute-stream")
async def execute_capability_stream(
    capability_name: str,
    body: CapabilityExecuteRequest,
):
    """Execute a capability and stream logs + trace + final result as SSE."""
    if not _playground_execution_enabled():
        return _execution_disabled_response()
    availability = _capability_availability(capability_name)
    if not availability["available"]:
        return _playground_json_error(
            503,
            "capability_unavailable",
            (f"Capability {capability_name!r} is unavailable. {availability['install_hint']}"),
            retryable=False,
            details={
                "capability": capability_name,
                "missing_dependencies": availability.get("missing_dependencies", []),
            },
        )
    return StreamingResponse(
        _execute_capability_stream(capability_name, body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
