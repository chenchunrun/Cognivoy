"""Kimi CLI backend — drive the local ``kimi`` CLI in headless print mode.

Uses ``kimi --prompt ... --output-format stream-json``: a JSONL stream of chat-shaped
messages, one object per line, flushed live at step boundaries. Lines are
discriminated by their ``role`` key — ``assistant`` (text / ``think`` parts /
``tool_calls``), ``tool`` (a tool result), and role-less service lines
(notifications, plan displays). Streaming is message-granular: the CLI merges
its internal token deltas before printing, so the answer lands per step rather
than typing out.

The command shape follows current ``kimi-code`` releases. Prompt mode is
selected by ``--prompt`` itself; the removed ``--print`` and
``--thinking``/``--no-thinking`` flags must not be sent.

For a fresh run Kimi creates the session and emits a ``session.resume_hint``
meta record containing its real id. Resumed runs pass that id via ``--session``.
Sessions are keyed by working directory, which a connection pins by design.

Auth and config are inherited automatically from the user's local Kimi Code
home — no token is ever handled here. Headless image input is not supported by
the CLI.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from cognivoy.services.subagent.base import OnEvent, SubagentBackend
from cognivoy.services.subagent.config import BackendConfig
from cognivoy.services.subagent.process import probe_version, stream_process_lines
from cognivoy.services.subagent.types import (
    EVENT_ERROR,
    EVENT_LOG,
    EVENT_REASONING,
    EVENT_TEXT,
    EVENT_TOOL,
    EVENT_TOOL_RESULT,
    ConsultResult,
    DetectResult,
    SubagentControlSignal,
    SubagentEvent,
)

logger = logging.getLogger(__name__)

_MAX_FIELD_CHARS = 4000
_TOOL_HEADER_CHARS = 160

# Exit code the CLI uses for retryable provider failures (429/5xx/timeouts).
_RETRYABLE_EXIT = "75"

_TOOL_PRIMARY_ARGS = (
    "command",
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "prompt",
    "description",
)


class KimiBackend(SubagentBackend):
    kind = "kimi"
    display_name = "Kimi CLI"
    cli_command = "kimi"

    async def detect(self) -> DetectResult:
        ok, text = await probe_version([self.cli_command, "--version"])
        return DetectResult(
            kind=self.kind,
            display_name=self.display_name,
            available=ok,
            version=text if ok else "",
            detail="" if ok else (text or "kimi CLI not found on PATH"),
        )

    def _build_command(
        self,
        question: str,
        *,
        session_id: str | None,
        fresh_session: bool,
        config: BackendConfig,
        agent_profile: str | None = None,
    ) -> list[str]:
        prompt = question
        # No system-prompt flag exists, so the delegate instruction is prepended
        # once, on the session-creating consult; resumed sessions already have it.
        if config.system_prompt.strip() and fresh_session:
            prompt = f"{config.system_prompt.strip()}\n\n{question}"
        cmd = [self.cli_command, "--output-format", "stream-json"]
        if session_id:
            cmd += ["--session", session_id]
        elif agent_profile:
            cmd += ["--agent", agent_profile]
        # Current kimi-code rejects --yolo together with --prompt. Prompt mode
        # is already non-interactive, so no permission flag is added here.
        if config.model:
            cmd += ["--model", config.model]
        cmd += list(config.extra_args)
        cmd += ["--prompt", prompt]
        return cmd

    async def consult(
        self,
        question: str,
        *,
        on_event: OnEvent,
        cwd: str | None = None,
        session_id: str | None = None,
        config: BackendConfig | None = None,
        images: list[str] | None = None,  # noqa: ARG002 — no headless image input
        partner_id: str | None = None,  # noqa: ARG002 — partner-only; ignored here
        agent_profile: str | None = None,
    ) -> ConsultResult:
        config = config or BackendConfig()
        fresh_session = not session_id
        cmd = self._build_command(
            question,
            session_id=session_id,
            fresh_session=fresh_session,
            config=config,
            agent_profile=agent_profile,
        )
        result = ConsultResult(session_id=session_id)

        async def emit(
            kind: str, text: str, raw: dict[str, Any], meta: dict[str, Any] | None = None
        ) -> None:
            result.event_count += 1
            await on_event(SubagentEvent(kind=kind, text=text, raw=raw, meta=meta or {}))

        try:
            async for channel, line in stream_process_lines(cmd, cwd=cwd):
                if channel == "exit":
                    if line != "0" and result.success and not result.final_text:
                        result.success = False
                        suffix = " (transient provider error)" if line == _RETRYABLE_EXIT else ""
                        result.error = f"kimi exited with code {line}{suffix}"
                        await emit(EVENT_ERROR, result.error, {"returncode": line})
                    continue
                if channel == "stderr":
                    if line.strip():
                        await emit(EVENT_LOG, line, {"stream": "stderr"})
                    continue
                event = _parse_json(line)
                if event is None:
                    if line.strip():
                        await emit(EVENT_LOG, line, {"stream": "stdout"})
                    continue
                await self._handle_event(event, result, emit)
        except SubagentControlSignal:
            raise
        except Exception as exc:  # pragma: no cover - defensive: surface, don't crash the turn
            logger.warning("kimi consult failed: %s", exc, exc_info=True)
            result.success = False
            result.error = str(exc)
            await emit(EVENT_ERROR, str(exc), {})

        return result

    async def _handle_event(self, event: dict[str, Any], result: ConsultResult, emit: Any) -> None:
        role = str(event.get("role") or "")

        if role == "meta":
            if event.get("type") == "session.resume_hint":
                sid = str(event.get("session_id") or "").strip()
                if sid:
                    result.session_id = sid
            return

        if role == "assistant":
            for part in _content_parts(event.get("content")):
                ptype = str(part.get("type") or "")
                if ptype == "text":
                    text = str(part.get("text") or "").strip()
                    if text:
                        # Message-granular stream: the latest assistant text is
                        # the freshest candidate for the final answer.
                        result.final_text = text
                        await emit(EVENT_TEXT, text, event)
                elif ptype == "think":
                    text = str(part.get("think") or "").strip()
                    if text:
                        await emit(EVENT_REASONING, text, event)
            for call in event.get("tool_calls") or []:
                if isinstance(call, dict):
                    await emit(EVENT_TOOL, _render_tool_call(call), call)
            return

        if role == "tool":
            text = "\n".join(
                str(p.get("text") or "") for p in _content_parts(event.get("content"))
            ).strip()
            await emit(EVENT_TOOL_RESULT, _truncate(text) or "(empty result)", event)
            return

        if role:
            return  # an echoed user/system message — nothing to surface

        # Role-less service lines: notifications and plan displays.
        if event.get("category") or event.get("severity"):
            title = str(event.get("title") or "").strip()
            body = str(event.get("body") or "").strip()
            text = " · ".join(p for p in (title, body) if p)
            if text:
                await emit(EVENT_LOG, _truncate(text), event)
            return
        if event.get("file_path") and event.get("content"):
            await emit(EVENT_LOG, f"plan · {event.get('file_path')}", event)
            return
        await emit(EVENT_LOG, _compact(event), event)


def _content_parts(content: Any) -> list[dict[str, Any]]:
    """Normalize the polymorphic ``content`` — a plain string or a part list."""
    if isinstance(content, str):
        return [{"type": "text", "text": content}] if content else []
    if isinstance(content, list):
        return [p for p in content if isinstance(p, dict)]
    return []


def _render_tool_call(call: dict[str, Any]) -> str:
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(function.get("name") or "tool")
    raw_args = function.get("arguments")
    args: Any = raw_args
    if isinstance(raw_args, str):  # arguments arrive JSON-encoded
        try:
            args = json.loads(raw_args)
        except (ValueError, TypeError):
            args = raw_args
    if isinstance(args, dict) and args:
        for key in _TOOL_PRIMARY_ARGS:
            value = args.get(key)
            if isinstance(value, str) and value.strip():
                return f"{name}({_inline(value)})"
        return f"{name}({_inline(_compact(args))})"
    return name


def _parse_json(line: str) -> dict[str, Any] | None:
    line = line.strip()
    if not line or line[0] not in "{[":
        return None
    try:
        parsed = json.loads(line)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _inline(text: str) -> str:
    one_line = " ".join(text.split())
    if len(one_line) > _TOOL_HEADER_CHARS:
        return one_line[:_TOOL_HEADER_CHARS].rstrip() + " …"
    return one_line


def _compact(obj: Any) -> str:
    try:
        text = json.dumps(obj, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(obj)
    return _truncate(text)


def _truncate(text: str) -> str:
    text = text.strip()
    if len(text) > _MAX_FIELD_CHARS:
        return text[:_MAX_FIELD_CHARS].rstrip() + " …"
    return text


__all__ = ["KimiBackend"]
