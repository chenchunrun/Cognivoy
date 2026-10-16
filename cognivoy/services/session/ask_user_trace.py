"""Recover resolved ``ask_user`` exchanges from persisted assistant rows."""

from __future__ import annotations

import json
from typing import Any

_RESOLVED_MARKER = '"ask_user_resolved"'
_GROUNDING_TOOL_MARKERS = (
    '"tool_name": "web_search"',
    '"tool_name":"web_search"',
    '"tool_name": "web_fetch"',
    '"tool_name":"web_fetch"',
    '"tool_name": "paper_search"',
    '"tool_name":"paper_search"',
    '"tool_name": "github"',
    '"tool_name":"github"',
)
_GROUNDING_TOOLS = {"web_search", "web_fetch", "paper_search", "github"}


def _ask_user_payload(metadata: dict[str, Any]) -> dict[str, Any] | None:
    tool_metadata = metadata.get("tool_metadata")
    payload = (
        tool_metadata.get("ask_user") if isinstance(tool_metadata, dict) else None
    ) or metadata.get("ask_user")
    return payload if isinstance(payload, dict) else None


def _is_ask_user_event(event: dict[str, Any]) -> bool:
    metadata = event.get("metadata")
    if not isinstance(metadata, dict):
        return False
    if metadata.get("ask_user_resolved"):
        return True
    return event.get("type") == "tool_result" and _ask_user_payload(metadata) is not None


def filter_ask_user_events(events: Any) -> list[dict[str, Any]]:
    """Keep only ask_user exchanges from an already-parsed event trace."""
    if not isinstance(events, list):
        return []
    return [event for event in events if isinstance(event, dict) and _is_ask_user_event(event)]


def select_ask_user_events(raw_events: str | None) -> list[dict[str, Any]]:
    """Filter a stored ``events_json`` blob down to ask_user exchanges."""
    if not raw_events or _RESOLVED_MARKER not in raw_events:
        return []
    try:
        return filter_ask_user_events(json.loads(raw_events))
    except (TypeError, ValueError):
        return []


def _is_grounding_event(event: dict[str, Any]) -> bool:
    """Return whether an event is a successful external-evidence result."""
    if event.get("type") != "tool_result":
        return False
    metadata = event.get("metadata")
    if not isinstance(metadata, dict):
        return False
    tool_name = str(metadata.get("tool_name") or metadata.get("tool") or "")
    return tool_name in _GROUNDING_TOOLS and metadata.get("success", True) is not False


def filter_context_events(events: Any) -> list[dict[str, Any]]:
    """Keep only events needed to rebuild conversational context.

    Tool traces are intentionally excluded except successful evidence-bearing
    results. This keeps follow-up grounding without replaying execution noise or
    unbounded traces into the next model call.
    """
    if not isinstance(events, list):
        return []
    return [
        event
        for event in events
        if isinstance(event, dict) and (_is_ask_user_event(event) or _is_grounding_event(event))
    ]


def select_context_events(raw_events: str | None) -> list[dict[str, Any]]:
    """Filter stored JSON down to clarification and grounding events."""
    if not raw_events:
        return []
    if _RESOLVED_MARKER not in raw_events and not any(
        marker in raw_events for marker in _GROUNDING_TOOL_MARKERS
    ):
        return []
    try:
        return filter_context_events(json.loads(raw_events))
    except (TypeError, ValueError):
        return []


def extract_ask_user_clarification_blocks(
    message: dict[str, Any],
) -> list[tuple[int, str]]:
    """Return resolved clarifications with their assistant-content boundary."""
    pending_questions: dict[str, str] = {}
    blocks: list[tuple[int, str]] = []
    for event in message.get("events") or []:
        if not isinstance(event, dict):
            continue
        metadata = event.get("metadata") or {}
        if not isinstance(metadata, dict):
            continue
        if event.get("type") == "tool_result":
            ask_user = _ask_user_payload(metadata)
            if ask_user is None:
                continue
            pending_questions = {
                str(question.get("id") or ""): str(question.get("prompt") or "").strip()
                for question in ask_user.get("questions") or []
                if isinstance(question, dict) and str(question.get("prompt") or "").strip()
            }
            continue
        if not metadata.get("ask_user_resolved"):
            continue
        exchanges: list[tuple[str, str]] = []
        for answer in metadata.get("answers") or []:
            if not isinstance(answer, dict):
                continue
            question_id = str(answer.get("questionId") or answer.get("question_id") or "")
            answer_text = str(answer.get("text") or "").strip()
            question_text = pending_questions.get(question_id, question_id).strip()
            if question_text and answer_text:
                exchanges.append((question_text, answer_text))
        if not exchanges:
            preview = str(metadata.get("reply_preview") or "").strip()
            if preview:
                question_text = next(iter(pending_questions.values()), "User clarification")
                exchanges.append((question_text, preview))
        if exchanges:
            try:
                content_offset = max(0, int(metadata.get("assistant_content_offset") or 0))
            except (TypeError, ValueError):
                content_offset = 0
            lines = [
                "[Earlier ask_user clarification — treat these answers as user-provided context]"
            ]
            for question, answer in exchanges:
                lines.extend((f"- Question: {question}", f"  User answer: {answer}"))
            blocks.append((content_offset, "\n".join(lines)))
        pending_questions = {}
    return blocks


def extract_ask_user_clarifications(message: dict[str, Any]) -> str:
    """Render all resolved ask_user exchanges as context text."""
    return "\n\n".join(text for _, text in extract_ask_user_clarification_blocks(message))


__all__ = [
    "extract_ask_user_clarifications",
    "extract_ask_user_clarification_blocks",
    "filter_ask_user_events",
    "filter_context_events",
    "select_ask_user_events",
    "select_context_events",
]
