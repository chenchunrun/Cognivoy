"""
Turn-level runtime manager for unified chat streaming.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Sequence
import contextlib
from contextvars import Token
from dataclasses import dataclass, field
import json
import logging
from pathlib import Path
import time
from typing import TYPE_CHECKING, Any, Literal
from uuid import uuid4

from cognivoy.core.stream import StreamEvent, StreamEventType
from cognivoy.services.llm.utils import clean_thinking_tags
from cognivoy.services.path_service import get_path_service
from cognivoy.services.session.artifact_attachments import (
    artifact_attachments,
    fill_preview_text,
)
from cognivoy.services.session.protocol import SessionStoreProtocol
from cognivoy.services.session.turn_recovery import (
    TurnRecoveryStore,
    recovery_mode_for,
)
from cognivoy.services.session.turn_status import (
    TERMINAL_TURN_STATUSES,
    is_active_turn_status,
)

if TYPE_CHECKING:
    from cognivoy.services.llm.config import LLMConfig

logger = logging.getLogger(__name__)

MemoryReference = Literal["recent", "profile", "scope", "preferences", "summary"]


# Content call_kinds that make up the persisted answer. The chat agent loop
# streams every round's text as ``content`` with ``agent_loop_round``; the
# finish round (and forced-finish) are the answer, narration rounds are
# filtered back out via their ``call_role`` marker (see _narration_marker_call_id).
_ANSWER_CONTENT_CALL_KINDS = frozenset({"llm_final_response", "agent_loop_round"})
_FINAL_TURN_STATUSES = TERMINAL_TURN_STATUSES


def _should_capture_assistant_content(event: StreamEvent) -> bool:
    if event.type != StreamEventType.CONTENT:
        return False
    metadata = event.metadata or {}
    call_id = metadata.get("call_id")
    if not call_id:
        return True
    return metadata.get("call_kind") in _ANSWER_CONTENT_CALL_KINDS


def _resolve_turn_outcome(
    assistant_events: Sequence[dict[str, Any]],
    done_event: StreamEvent | None,
) -> tuple[str, str]:
    """Resolve the persisted turn status and error from the terminal protocol."""
    done_metadata = (done_event.metadata or {}) if done_event is not None else {}
    status = str(done_metadata.get("status") or "completed")
    if status not in _FINAL_TURN_STATUSES:
        status = "completed"

    error = ""
    for event in reversed(assistant_events):
        metadata = event.get("metadata")
        metadata = metadata if isinstance(metadata, dict) else {}
        if event.get("type") != StreamEventType.ERROR.value or not metadata.get("turn_terminal"):
            continue
        terminal_status = str(metadata.get("status") or "failed")
        status = terminal_status if terminal_status in _FINAL_TURN_STATUSES else "failed"
        if status == "completed":
            status = "failed"
        error = str(event.get("content") or "")
        break

    return status, error


def _narration_marker_call_id(event: StreamEvent) -> str | None:
    """call_id of a chat-loop round that resolved as narration (a short
    preamble streamed alongside a tool call). Its text belongs to the trace,
    not the persisted answer, so it is excluded when assembling content.

    DSML rounds may explicitly keep the cleaned prose surrounding a call; that
    narrow exception remains part of the persisted answer.
    """
    metadata = event.metadata or {}
    if (
        metadata.get("trace_kind") == "call_status"
        and metadata.get("call_state") == "complete"
        and metadata.get("call_role") == "narration"
        and metadata.get("answer_visible") is not True
    ):
        call_id = metadata.get("call_id")
        return str(call_id) if call_id else None
    return None


def _assemble_persisted_answer(
    content_segments: Sequence[tuple[str | None, str]],
    narration_call_ids: set[str],
) -> str:
    """Replay visible content bytes, excluding trace-only narration rounds."""
    return clean_thinking_tags(
        "".join(
            text
            for call_id, text in content_segments
            if not (call_id and call_id in narration_call_ids)
        )
    )


def _stamp_ask_user_content_offset(
    payload_event: dict[str, Any],
    assistant_content: str,
) -> None:
    """Attach the replay boundary to a persisted ask_user resolution event."""
    metadata = payload_event.get("metadata")
    if isinstance(metadata, dict) and metadata.get("ask_user_resolved"):
        metadata.setdefault("assistant_content_offset", len(assistant_content))


def _clip_text(value: str, limit: int = 4000) -> str:
    text = str(value or "").strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n...[truncated]"


_TITLE_QUOTE_PAIRS: tuple[tuple[str, str], ...] = (
    ('"', '"'),
    ("'", "'"),
    ("“", "”"),
    ("‘", "’"),
    ("「", "」"),
    ("『", "』"),
    ("`", "`"),
)
_TITLE_PREFIXES: tuple[str, ...] = (
    "Title:",
    "title:",
    "TITLE:",
    "Title-",
    "标题：",
    "标题:",
    "对话标题：",
    "对话标题:",
)
_TITLE_TRAILING_PUNCT = ".。!！?？,，;；、 \t"
_INTERRUPTED_TURN_ERROR = "Turn interrupted by server restart. Please retry your message."


def _sanitize_session_title(raw: str) -> str:
    """Trim the noise LLMs love to add to short titles.

    Strips model reasoning tags, surrounding quotes, leading "Title:" labels,
    trailing punctuation, and Markdown bold/italic markers. Caps length at
    80 characters so a chatty model can't blow past the sidebar layout.
    """
    text = clean_thinking_tags(raw or "").strip()
    if not text:
        return ""
    text = text.splitlines()[0].strip()
    # Iterate until the text stops shrinking — models often nest the
    # noise (e.g. ``**Title:** "Hello"``) so a single pass leaves
    # leftover wrappers.
    for _ in range(8):
        prev = text
        text = text.lstrip("*_#- \t").rstrip("*_ \t")
        for prefix in _TITLE_PREFIXES:
            if text.startswith(prefix):
                text = text[len(prefix) :].strip()
                break
        for opener, closer in _TITLE_QUOTE_PAIRS:
            if len(text) >= 2 and text.startswith(opener) and text.endswith(closer):
                text = text[len(opener) : len(text) - len(closer)].strip()
                break
        text = text.rstrip(_TITLE_TRAILING_PUNCT)
        if text == prev:
            break
    return text[:80]


def _extract_memory_references(payload: dict[str, Any]) -> list[MemoryReference]:
    """Return the L3 slot names the client opted in for this turn.

    The list is an explicit least-privilege boundary: only these slots are
    injected. ``summary`` remains a client-compatible alias for ``recent``.
    """
    refs = payload.get("memory_references", []) or []
    if not isinstance(refs, list):
        return []
    allowed = {"recent", "profile", "scope", "preferences", "summary"}
    out: list[MemoryReference] = []
    for item in refs:
        if item in allowed and item not in out:
            out.append(item)
    return out


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str) and item]


def _llm_selection_dict(value: Any) -> dict[str, str] | None:
    from cognivoy.services.model_selection import LLMSelection

    selection = LLMSelection.from_payload(value)
    return selection.to_dict() if selection else None


def _request_snapshot_metadata(
    *,
    payload: dict[str, Any],
    content: str,
    capability: str,
    config: dict[str, Any],
    attachments: list[dict[str, Any]],
    notebook_references: list[Any],
    history_references: list[Any],
    question_notebook_references: list[Any],
    book_references: list[Any],
    persona: str,
    memory_references: Sequence[str],
    llm_selection: dict[str, str] | None,
) -> dict[str, Any]:
    """Persist the front-end context chips with the user message."""
    snapshot: dict[str, Any] = {
        "content": content,
        "capability": capability,
        "enabledTools": _string_list(payload.get("tools")),
        "knowledgeBases": _string_list(payload.get("knowledge_bases")),
        "language": str(payload.get("language", "en") or "en"),
    }
    if attachments:
        snapshot["attachments"] = attachments
    if config:
        snapshot["config"] = dict(config)
    if notebook_references:
        snapshot["notebookReferences"] = notebook_references
    if history_references:
        snapshot["historyReferences"] = history_references
    if question_notebook_references:
        snapshot["questionNotebookReferences"] = question_notebook_references
    if book_references:
        snapshot["bookReferences"] = book_references
    if persona:
        snapshot["persona"] = persona
    if memory_references:
        snapshot["memoryReferences"] = memory_references
    requested_skills = _string_list(payload.get("skills"))
    if requested_skills:
        snapshot["skills"] = requested_skills
    if llm_selection:
        snapshot["llmSelection"] = llm_selection
    learning_context = payload.get("learning_context")
    if isinstance(learning_context, dict) and learning_context:
        snapshot["learningContext"] = {
            key: str(value)
            for key, value in learning_context.items()
            if key in {"project_id", "task_id", "objective"} and value
        }
    return {"request_snapshot": snapshot}


def _resolve_session_learning_context(
    payload: dict[str, Any], preferences: dict[str, Any]
) -> tuple[dict[str, str], bool]:
    """Keep an explicitly linked learning project attached to its session.

    Capability switches are ordinary turns in the same learning journey.  The
    browser only has the project/task query parameters on the entry URL, so a
    later quiz turn may omit ``learning_context`` even though the session is
    still project-owned.  Persisting the small, validated reference in session
    preferences makes that association durable without consulting a global
    "active project" or accidentally linking unrelated chats.
    """

    explicit = "learning_context" in payload
    candidate = payload.get("learning_context") if explicit else preferences.get("learning_context")
    if not isinstance(candidate, dict):
        return {}, explicit
    resolved = {
        key: str(candidate.get(key) or "").strip() for key in ("project_id", "task_id", "objective")
    }
    return {key: value for key, value in resolved.items() if value}, explicit


def _learning_project_for_turn(
    payload: dict[str, Any],
    *,
    owner_id: str,
) -> Any | None:
    """Resolve the trusted owner-scoped project referenced by this turn."""
    learning_context = payload.get("learning_context")
    if not isinstance(learning_context, dict):
        return None
    project_id = str(learning_context.get("project_id") or "").strip()
    if not project_id:
        return None
    try:
        from cognivoy.learning.project_storage import LearningProjectStore

        project = LearningProjectStore().load(project_id)
    except (OSError, TypeError, ValueError):
        return None
    if project is None or project.owner_id != owner_id:
        return None
    return project


def _learning_project_guidance(
    payload: dict[str, Any],
    *,
    owner_id: str,
    language: str,
    project: Any | None = None,
) -> str:
    """Resolve trusted, owner-scoped teaching guidance for a project turn."""
    project = project or _learning_project_for_turn(payload, owner_id=owner_id)
    if project is None:
        return ""
    learning_context = payload.get("learning_context")
    if not isinstance(learning_context, dict):
        return ""
    objective = str(learning_context.get("objective") or "").strip()[:500]
    from cognivoy.learning.adaptive import adaptive_teaching_profile

    teaching = adaptive_teaching_profile(project)
    methods = ", ".join(project.preferred_methods[:8]) or (
        "未指定" if language.startswith("zh") else "not specified"
    )
    weak_points = ", ".join(project.weak_points[:8]) or (
        "暂无证据" if language.startswith("zh") else "no evidence yet"
    )
    if language.startswith("zh"):
        return "\n".join(
            [
                "这是一个已归属学习项目的教学回合。请根据学习者状态调整解释、例子、检查题和下一步建议。",
                f"项目：{project.title[:300]}",
                f"本次目标：{objective or '继续当前学习计划'}",
                f"当前水平：{project.current_level[:100]}；目标水平：{project.target_level[:100]}",
                f"偏好方法：{methods}",
                f"已有薄弱点：{weak_points}",
                f"本回合教学策略：{teaching['strategy']}；难度档位：{teaching['difficulty']}",
                "基础档应分步讲解并给完整示例；引导档应逐步减少提示；挑战档应要求迁移应用并说明理由。遇到已知薄弱点时先修复概念，不要盲目加难。",
                "不要声称学习者已经掌握尚无证据支持的内容；结束时给出一次简短理解检查。",
            ]
        )
    return "\n".join(
        [
            "This turn belongs to a learning project. Adapt the explanation, examples, checks, and next step to the learner evidence below.",
            f"Project: {project.title[:300]}",
            f"Turn objective: {objective or 'Continue the current learning plan'}",
            f"Current level: {project.current_level[:100]}; target level: {project.target_level[:100]}",
            f"Preferred methods: {methods}",
            f"Known weak points: {weak_points}",
            f"Teaching strategy for this turn: {teaching['strategy']}; difficulty band: {teaching['difficulty']}",
            "At foundation level, teach in small steps with a complete worked example. At guided level, fade hints progressively. At challenge level, require transfer and justification. Repair known weak points before increasing difficulty.",
            "Do not claim mastery without evidence; end with one concise understanding check.",
        ]
    )


def _trusted_learning_task_context(
    project: Any | None,
    learning_context: Any,
) -> dict[str, str]:
    """Bind client task selection to an owner-validated project object."""

    if project is None or not isinstance(learning_context, dict):
        return {}
    requested_task_id = str(learning_context.get("task_id") or "").strip()
    task = next((item for item in project.tasks if item.id == requested_task_id), None)
    if task is None:
        return {}
    return {
        "project_id": project.id,
        "task_id": task.id,
        "objective": task.objective,
    }


def _mount_learning_project_knowledge(payload: dict[str, Any], project: Any | None) -> None:
    """Mount project knowledge without replacing explicit turn selections."""

    if project is None or not project.knowledge_base_ids:
        return
    payload["knowledge_bases"] = list(
        dict.fromkeys(
            [
                *[str(item) for item in (payload.get("knowledge_bases") or []) if str(item)],
                *[str(item) for item in project.knowledge_base_ids if str(item)],
            ]
        )
    )


def _format_question_bank_entry(entry: dict[str, Any]) -> str:
    """Render a single Question Bank entry as a structured Markdown block."""
    lines: list[str] = []
    title = str(entry.get("session_title", "") or "Untitled session")
    difficulty = str(entry.get("difficulty", "") or "").strip()
    qtype = str(entry.get("question_type", "") or "").strip()
    is_correct = bool(entry.get("is_correct"))

    badges: list[str] = []
    if qtype:
        badges.append(qtype)
    if difficulty:
        badges.append(difficulty)
    badges.append("correct" if is_correct else "incorrect")
    badge_text = " · ".join(badges)

    lines.append(f"### Question (from {title}) [{badge_text}]")
    lines.append(_clip_text(str(entry.get("question", "") or ""), limit=2000))

    options = entry.get("options") or {}
    if isinstance(options, dict) and options:
        lines.append("")
        lines.append("**Options:**")
        for key in sorted(options.keys()):
            lines.append(f"- {key}. {options[key]}")

    user_answer = str(entry.get("user_answer", "") or "").strip()
    correct_answer = str(entry.get("correct_answer", "") or "").strip()
    if user_answer:
        lines.append("")
        lines.append(f"**User's Answer:** {_clip_text(user_answer, limit=1000)}")
    if correct_answer:
        lines.append(f"**Reference Answer:** {_clip_text(correct_answer, limit=1500)}")

    explanation = str(entry.get("explanation", "") or "").strip()
    if explanation:
        lines.append("")
        lines.append("**Explanation:**")
        lines.append(_clip_text(explanation, limit=2000))

    return "\n".join(lines)


async def _count_branch_user_turns(
    store: SessionStoreProtocol,
    session_id: str,
    leaf_message_id: int | None,
) -> int:
    """Count user messages on the active branch's ancestor chain.

    Used by the chat source inventory to assign ``first_seen_turn`` for
    *fresh* sources (= current turn = past_user_turns + 1). When
    ``leaf_message_id`` is ``None`` (legacy linear append) all messages
    in the session are counted; otherwise we walk the
    ``parent_message_id`` chain so sibling branches don't inflate the
    count. Kept tiny and protocol-only (``get_messages``) so it stays
    compatible with every store backend.
    """
    all_msgs = await store.get_messages(session_id)
    if leaf_message_id is None:
        return sum(1 for m in all_msgs if m.get("role") == "user")
    by_id: dict[int, dict[str, Any]] = {}
    for m in all_msgs:
        mid = m.get("id")
        if mid is not None:
            by_id[int(mid)] = m
    count = 0
    current: int | None = int(leaf_message_id)
    safety = 10_000
    while current is not None and safety > 0:
        m = by_id.get(int(current))
        if m is None:
            break
        if m.get("role") == "user":
            count += 1
        parent = m.get("parent_message_id")
        current = int(parent) if parent is not None else None
        safety -= 1
    return count


async def _build_question_bank_context(
    store: SessionStoreProtocol,
    entry_ids: list[Any],
) -> str:
    """Fetch the requested Question Bank entries and render them as context."""
    get_entry = getattr(store, "get_notebook_entry", None)
    if not callable(get_entry):
        return ""

    seen: set[int] = set()
    blocks: list[str] = []
    for raw in entry_ids:
        try:
            entry_id = int(raw)
        except (TypeError, ValueError):
            continue
        if entry_id in seen:
            continue
        seen.add(entry_id)
        try:
            entry = await get_entry(entry_id)
        except Exception:
            entry = None
        if not entry:
            continue
        blocks.append(_format_question_bank_entry(entry))
    return "\n\n---\n\n".join(blocks)


def _normalize_filename_list(raw: dict[str, Any]) -> list[str]:
    """Coalesce legacy single-filename and modern multi-filename inputs.

    Returns the cleaned list (possibly empty). Empty / whitespace-only
    entries are dropped, and the singular ``user_answer_image_filename``
    is honoured as a fallback so older clients still surface their
    filename in the system prompt.
    """
    candidates: list[Any] = []
    plural = raw.get("user_answer_image_filenames")
    if isinstance(plural, list):
        candidates.extend(plural)
    elif isinstance(plural, str):
        candidates.append(plural)
    legacy = raw.get("user_answer_image_filename")
    if isinstance(legacy, str) and legacy.strip():
        candidates.append(legacy)
    cleaned: list[str] = []
    for item in candidates:
        if not isinstance(item, str):
            continue
        name = item.strip()
        if name:
            cleaned.append(name)
    return cleaned


def _extract_followup_question_context(
    config: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(config, dict):
        return None
    raw = config.pop("followup_question_context", None)
    if not isinstance(raw, dict):
        return None

    question = str(raw.get("question", "") or "").strip()
    question_id = str(raw.get("question_id", "") or "").strip()
    if not question:
        return None

    options = raw.get("options")
    normalized_options: dict[str, str] | None = None
    if isinstance(options, dict):
        normalized_options = {
            str(key).strip().upper()[:1]: str(value or "").strip()
            for key, value in options.items()
            if str(value or "").strip()
        }

    return {
        "parent_quiz_session_id": str(raw.get("parent_quiz_session_id", "") or "").strip(),
        "question_id": question_id,
        "question": question,
        "question_type": str(raw.get("question_type", "") or "").strip(),
        "options": normalized_options,
        "correct_answer": str(raw.get("correct_answer", "") or "").strip(),
        "explanation": str(raw.get("explanation", "") or "").strip(),
        "difficulty": str(raw.get("difficulty", "") or "").strip(),
        "concentration": str(raw.get("concentration", "") or "").strip(),
        "knowledge_context": _clip_text(str(raw.get("knowledge_context", "") or "").strip()),
        "user_answer": str(raw.get("user_answer", "") or "").strip(),
        "is_correct": raw.get("is_correct"),
        # Filenames of the learner's image answers, when any were attached.
        # The bytes are sent as regular WS attachments on the first
        # follow-up turn — we just record the filenames here so the system
        # prompt can tell the LLM *what* those attached images actually
        # are. Accept both the legacy single ``user_answer_image_filename``
        # string and the new ``user_answer_image_filenames`` list.
        "user_answer_image_filenames": _normalize_filename_list(raw),
        # Most recent AI-judge output the learner saw, if they ran the
        # judge. Forwarded so the follow-up tutor can build on the same
        # assessment rather than starting fresh.
        "ai_judgment": _clip_text(str(raw.get("ai_judgment", "") or "").strip()),
    }


def _extract_persist_user_message(config: dict[str, Any] | None) -> bool:
    if not isinstance(config, dict):
        return True
    raw = config.pop("_persist_user_message", True)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        return raw.strip().lower() not in {"false", "0", "no"}
    return bool(raw)


def _extract_regenerate_flag(config: dict[str, Any] | None) -> bool:
    if not isinstance(config, dict):
        return False
    raw = config.pop("_regenerate", False)
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        return raw.strip().lower() in {"true", "1", "yes"}
    return bool(raw)


def _format_followup_question_context(context: dict[str, Any], language: str = "en") -> str:
    options = context.get("options") or {}
    option_lines = []
    if isinstance(options, dict) and options:
        for key, value in options.items():
            if value:
                option_lines.append(f"{key}. {value}")
    correctness = context.get("is_correct")
    correctness_text = (
        "correct" if correctness is True else "incorrect" if correctness is False else "unknown"
    )

    if str(language or "en").lower().startswith("zh"):
        lines = [
            "你正在处理一道测验题的后续追问。",
            "下面是本题上下文，请在后续回答中优先围绕这道题进行解释、纠错、延展和追问。",
            "如果用户提出超出本题的内容，也可以正常回答，但要保持和本题的连续性。",
            "",
            "[Question Follow-up Context]",
            f"Question ID: {context.get('question_id') or '(none)'}",
            f"Parent quiz session: {context.get('parent_quiz_session_id') or '(none)'}",
            f"Question type: {context.get('question_type') or '(none)'}",
            f"Difficulty: {context.get('difficulty') or '(none)'}",
            f"Concentration: {context.get('concentration') or '(none)'}",
            "",
            "Question:",
            context.get("question") or "(none)",
        ]
        if option_lines:
            lines.extend(["", "Options:", *option_lines])
        lines.extend(
            [
                "",
                f"User answer: {context.get('user_answer') or '(not provided)'}",
                f"User result: {correctness_text}",
                f"Reference answer: {context.get('correct_answer') or '(none)'}",
                "",
                "Explanation:",
                context.get("explanation") or "(none)",
            ]
        )
        image_filenames = context.get("user_answer_image_filenames") or []
        if isinstance(image_filenames, list) and image_filenames:
            filename_text = "、".join(image_filenames)
            count_text = f"{len(image_filenames)} 张" if len(image_filenames) > 1 else "一张"
            lines.extend(
                [
                    "",
                    "学习者作答附图：",
                    f"该作答共附了{count_text}图片（文件名：{filename_text}），"
                    f"随首条追问消息一起发送，是用户提交的作答内容的一部分，不是无关上下文。"
                    f"请结合图片中的文字/公式/草图进行解读，并将其视为对上面 “User answer” 文本的补充。",
                ]
            )
        ai_judgment = context.get("ai_judgment")
        if ai_judgment:
            lines.extend(
                [
                    "",
                    "AI 评判（之前已对学习者作答给出的评判，请基于此继续，不要重复完整重写）：",
                    ai_judgment,
                ]
            )
        if context.get("knowledge_context"):
            lines.extend(
                [
                    "",
                    "Knowledge context:",
                    context["knowledge_context"],
                ]
            )
        return "\n".join(lines).strip()

    lines = [
        "You are handling follow-up questions about a single quiz item.",
        "Use the question context below as the primary grounding for future turns in this session.",
        "If the user asks something broader, you may answer normally, but maintain continuity with this quiz item.",
        "",
        "[Question Follow-up Context]",
        f"Question ID: {context.get('question_id') or '(none)'}",
        f"Parent quiz session: {context.get('parent_quiz_session_id') or '(none)'}",
        f"Question type: {context.get('question_type') or '(none)'}",
        f"Difficulty: {context.get('difficulty') or '(none)'}",
        f"Concentration: {context.get('concentration') or '(none)'}",
        "",
        "Question:",
        context.get("question") or "(none)",
    ]
    if option_lines:
        lines.extend(["", "Options:", *option_lines])
    lines.extend(
        [
            "",
            f"User answer: {context.get('user_answer') or '(not provided)'}",
            f"User result: {correctness_text}",
            f"Reference answer: {context.get('correct_answer') or '(none)'}",
            "",
            "Explanation:",
            context.get("explanation") or "(none)",
        ]
    )
    image_filenames = context.get("user_answer_image_filenames") or []
    if isinstance(image_filenames, list) and image_filenames:
        joined = ", ".join(image_filenames)
        plural = "images were" if len(image_filenames) > 1 else "image was"
        plural_noun = (
            "Learner answer images" if len(image_filenames) > 1 else "Learner answer image"
        )
        lines.extend(
            [
                "",
                f"{plural_noun}:",
                f"{len(image_filenames)} {plural} attached to the first follow-up message "
                f"(filenames: {joined}). They are part of the learner's answer — read their "
                "text/formulas/sketches and treat them as a supplement to the typed `User answer` "
                "above, not unrelated context.",
            ]
        )
    ai_judgment = context.get("ai_judgment")
    if ai_judgment:
        lines.extend(
            [
                "",
                "Prior AI judgment (already shown to the learner — build on it instead of restating it in full):",
                ai_judgment,
            ]
        )
    if context.get("knowledge_context"):
        lines.extend(
            [
                "",
                "Knowledge context:",
                context["knowledge_context"],
            ]
        )
    return "\n".join(lines).strip()


@dataclass
class _LiveSubscriber:
    queue: asyncio.Queue[dict[str, Any]]


@dataclass
class _TurnExecution:
    turn_id: str
    session_id: str
    capability: str
    payload: dict[str, Any]
    task: asyncio.Task[None] | None = None
    recovery_lease_task: asyncio.Task[None] | None = None
    subscribers: list[_LiveSubscriber] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    next_seq: int = 1
    events_flushed: bool = False
    last_checkpoint_stage: str = ""


class TurnRuntimeManager:
    """Run one turn in the background and multiplex persisted/live events."""

    def __init__(
        self,
        store: SessionStoreProtocol | None = None,
        *,
        recovery_store: TurnRecoveryStore | None = None,
    ) -> None:
        from cognivoy.services.session import get_session_store

        self.store = store or get_session_store()
        if recovery_store is None:
            db_path = getattr(self.store, "db_path", None)
            recovery_store = TurnRecoveryStore(
                root=(Path(db_path).parent / "turn-recovery") if db_path else None
            )
        self.recovery_store = recovery_store
        # PID alone is not unique when an ASGI process constructs more than one
        # runtime manager (tests, hot reload, tenant-scoped app factories).  A
        # per-manager suffix prevents two owners in the same process from both
        # treating the same lease as theirs.
        self._worker_id = f"{self.recovery_store.default_worker_id()}:{uuid4().hex[:12]}"
        self._lock = asyncio.Lock()
        self._executions: dict[str, _TurnExecution] = {}
        # Per-turn reply queues used by tools that pause the agentic
        # loop (e.g. ``ask_user``). Queue is created in ``_run_turn``
        # before the orchestrator is invoked and cleaned up in the
        # ``finally`` block, so callers of ``submit_user_reply`` see
        # ``False`` for any turn that is no longer awaiting input.
        # Each entry is a dict of shape:
        #   {"text": str, "answers": list[{"questionId": str, "text": str}] | None}
        # ``text`` is always present (flat fallback for legacy callers);
        # ``answers`` carries the structured per-question replies when the
        # frontend sends the v2 ``ask_user`` shape.
        self._reply_queues: dict[str, asyncio.Queue[dict[str, Any] | None]] = {}

    async def has_live_execution(self, turn_id: str) -> bool:
        """Public check for whether this process still owns the turn's runner.

        Lets transport callers (e.g. the unified WS router) avoid reaching into
        ``_lock`` / ``_executions`` directly.
        """
        return await self._has_live_execution(turn_id)

    async def _renew_recovery_lease(self, turn_id: str) -> None:
        """Keep a cross-worker turn lease alive until the runner terminates."""
        try:
            while True:
                await asyncio.sleep(5.0)
                renewed = await asyncio.to_thread(
                    self.recovery_store.renew_lease,
                    turn_id,
                    worker_id=self._worker_id,
                    lease_seconds=15.0,
                )
                if not renewed:
                    return
        except asyncio.CancelledError:
            raise

    async def _run_turn_with_recovery_lease(self, execution: _TurnExecution) -> None:
        execution.recovery_lease_task = asyncio.create_task(
            self._renew_recovery_lease(execution.turn_id)
        )
        try:
            await self._run_turn(execution)
        finally:
            lease_task = execution.recovery_lease_task
            if lease_task is not None and not lease_task.done():
                lease_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await lease_task

    async def _has_live_execution(self, turn_id: str) -> bool:
        """Whether this process still owns the turn's in-memory runner."""
        async with self._lock:
            execution = self._executions.get(turn_id)
            if execution is None:
                return False
            # Some tests and pause/resubscribe paths create an execution
            # placeholder without a task. Treat its presence as live so we do
            # not falsely fail a turn that is still owned by this process.
            return execution.task is None or not execution.task.done()

    async def _fail_orphan_running_turn(self, turn: dict[str, Any] | None) -> dict[str, Any] | None:
        """Finalize a persisted running turn that has no local execution.

        Running turns are process-local: after a server/container restart the
        database row may still say ``running`` while the task and subscriber
        queues are gone. The runtime owns that liveness check, not the store,
        so recovery stays backend-agnostic.
        """
        if turn is None or not is_active_turn_status(turn.get("status")):
            return turn
        turn_id = str(turn.get("id") or turn.get("turn_id") or "").strip()
        if not turn_id or await self._has_live_execution(turn_id):
            return turn
        await self.store.update_turn_status(turn_id, "failed", _INTERRUPTED_TURN_ERROR)
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self.recovery_store.finish, turn_id, status="failed")
        return await self.store.get_turn(turn_id)

    async def _recover_orphan_running_turns_for_session(self, session_id: str) -> None:
        """Clear stale active turns before creating a fresh turn."""
        for turn in await self.store.list_active_turns(session_id):
            await self._fail_orphan_running_turn(turn)

    async def recover_orphan_turn(self, turn: dict[str, Any] | None) -> dict[str, Any] | None:
        """Resume a persisted turn when its durable request can be claimed.

        Legacy rows without a recovery manifest keep the old safe behaviour:
        they become a visible, retryable failure instead of remaining stuck.
        """
        if turn is None or not is_active_turn_status(turn.get("status")):
            return turn
        turn_id = str(turn.get("id") or turn.get("turn_id") or "").strip()
        if not turn_id or await self._has_live_execution(turn_id):
            return turn

        manifest = await asyncio.to_thread(
            self.recovery_store.claim_resume,
            turn_id,
            worker_id=self._worker_id,
            lease_seconds=120.0,
        )
        if manifest is None:
            # A live lease can belong to another API worker. Do not fail a turn
            # that is actively being resumed elsewhere.
            existing = await asyncio.to_thread(self.recovery_store.load, turn_id)
            if existing and float(existing.get("lease_expires_at") or 0.0) > time.time():
                return turn
            return await self._fail_orphan_running_turn(turn)

        payload = dict(manifest.get("payload") or {})
        if not payload:
            return await self._fail_orphan_running_turn(turn)
        capability = str(turn.get("capability") or manifest.get("capability") or "chat")
        recovery_mode = recovery_mode_for(capability)
        if recovery_mode == "fail":
            return await self._fail_orphan_running_turn(turn)
        raw_config = dict(payload.get("config") or {})
        raw_config["_persist_user_message"] = not bool(manifest.get("input_persisted"))
        raw_config["_recovery_attempt"] = int(manifest.get("resume_count") or 1)
        raw_config["_recovery_mode"] = recovery_mode
        payload["config"] = raw_config
        payload["session_id"] = str(turn.get("session_id") or manifest.get("session_id") or "")

        execution = _TurnExecution(
            turn_id=turn_id,
            session_id=payload["session_id"],
            capability=capability,
            payload=payload,
            next_seq=int(turn.get("last_seq") or 0) + 1,
            last_checkpoint_stage=str(manifest.get("last_stage") or ""),
        )
        async with self._lock:
            # A competing coroutine in this worker may have won while the file
            # lease was being acquired.
            existing_execution = self._executions.get(turn_id)
            if existing_execution is not None:
                return turn
            self._executions[turn_id] = execution
        try:
            await self.store.update_turn_status(turn_id, "running")
            recovery_event = await self.store.append_turn_event(
                turn_id,
                {
                    "type": StreamEventType.PROGRESS.value,
                    "source": "turn_runtime",
                    "stage": "recovery",
                    "content": (
                        "Resuming the interrupted task from its durable checkpoint."
                        if recovery_mode == "checkpoint"
                        else "Restarting the interrupted task from its saved request."
                    ),
                    "metadata": {
                        "recovered_after_restart": True,
                        "recovery_mode": recovery_mode,
                        "resume_count": int(manifest.get("resume_count") or 1),
                        "last_stage": str(manifest.get("last_stage") or ""),
                    },
                },
            )
            execution.next_seq = max(execution.next_seq, int(recovery_event.get("seq") or 0) + 1)
            try:
                from cognivoy.services.observability import get_slo_service

                await asyncio.to_thread(get_slo_service().record_business_event, "turn_recovered")
            except Exception:
                logger.debug("Unable to record turn recovery SLI", exc_info=True)
            execution.task = asyncio.create_task(self._run_turn_with_recovery_lease(execution))
        except Exception:
            async with self._lock:
                self._executions.pop(turn_id, None)
            with contextlib.suppress(Exception):
                await asyncio.to_thread(
                    self.recovery_store.release, turn_id, worker_id=self._worker_id
                )
            raise
        return await self.store.get_turn(turn_id)

    async def _wait_for_user_reply(
        self,
        turn_id: str,
        reply_queue: asyncio.Queue[dict[str, Any] | None],
        *,
        pause_event: asyncio.Event,
        resume_event: asyncio.Event,
    ) -> dict[str, Any] | None:
        """Pause a live turn durably until the learner supplies a reply."""
        resume_event.clear()
        await self.store.update_turn_status(turn_id, "waiting_for_input")
        await asyncio.to_thread(self.recovery_store.mark_waiting_for_input, turn_id, waiting=True)
        # Signal readiness only after both durable stores can accept a reply;
        # otherwise a fast client routed to another worker can lose its input.
        pause_event.set()
        try:
            while True:
                reply = await asyncio.to_thread(self.recovery_store.take_reply, turn_id)
                if reply is not None:
                    break
                try:
                    reply = await asyncio.wait_for(reply_queue.get(), timeout=0.1)
                    break
                except TimeoutError:
                    continue
            await self.store.update_turn_status(turn_id, "running")
            return reply
        finally:
            await asyncio.to_thread(
                self.recovery_store.mark_waiting_for_input, turn_id, waiting=False
            )
            pause_event.clear()
            resume_event.set()

    async def start_turn(self, payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        # Every entry point (WebSocket, SDK, CLI, partner adapters and internal
        # retries) must cross the same public request boundary.  Validating only
        # in the transport adapters lets direct runtime callers smuggle unknown
        # fields into snapshots and makes the three entry points drift apart.
        try:
            from cognivoy.runtime.request_contracts import validate_start_turn_payload

            payload = validate_start_turn_payload(payload)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc

        capability = str(payload.get("capability") or "chat")
        if capability == "math_animator":
            from cognivoy.agents.math_animator.availability import (
                require_math_animator_ready,
            )

            require_math_animator_ready()
        if not payload.get("language"):
            from cognivoy.services.settings.interface_settings import (
                get_response_language,
            )

            payload = {**payload, "language": get_response_language(default="en")}
        from cognivoy.services.prompt.language import infer_response_language

        payload = {
            **payload,
            "language": infer_response_language(
                str(payload.get("content") or ""), str(payload.get("language") or "en")
            ),
        }
        raw_config = dict(payload.get("config", {}) or {})
        runtime_only_keys = (
            "_persist_user_message",
            "_regenerate",
            "_regenerated_from_message_id",
            "_superseded_turn_id",
            "_recovery_attempt",
            "_recovery_mode",
            "followup_question_context",
            # Per-turn subagent consult budget (composer stepper). Not part of
            # any capability's public config schema, so it rides as a runtime
            # key — stripped before validation, merged back into the turn config
            # and read by the subagent capability from context.config_overrides.
            "subagent_consult_budget",
        )
        runtime_only_config = {
            key: raw_config.pop(key) for key in runtime_only_keys if key in raw_config
        }
        try:
            from cognivoy.runtime.request_contracts import validate_capability_config

            validated_public_config = validate_capability_config(capability, raw_config)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc
        payload = {
            **payload,
            "capability": capability,
            "config": {**validated_public_config, **runtime_only_config},
        }
        session = await self.store.ensure_session(payload.get("session_id"))
        preferences = session.get("preferences") or {}
        learning_context, learning_context_explicit = _resolve_session_learning_context(
            payload, preferences
        )
        if learning_context:
            payload = {**payload, "learning_context": learning_context}
        elif learning_context_explicit:
            payload = {key: value for key, value in payload.items() if key != "learning_context"}
        # Persona is a session-level preference (mirrors llm_selection): an
        # explicit ``persona`` key in the payload — including an empty string,
        # which means "Default" / no persona — wins and is persisted below; an
        # absent key falls back to the session's stored preference so the
        # active persona survives reloads and follows the session.
        persona_explicit = "persona" in payload
        persona_pref = str(
            (payload.get("persona") if persona_explicit else preferences.get("persona")) or ""
        ).strip()
        payload = {**payload, "persona": persona_pref}
        raw_llm_selection = payload.get("llm_selection")
        if raw_llm_selection is None:
            raw_llm_selection = preferences.get("llm_selection")
        try:
            llm_selection = _llm_selection_dict(raw_llm_selection)
        except ValueError as exc:
            raise RuntimeError(str(exc)) from exc
        if llm_selection:
            try:
                from cognivoy.multi_user.model_access import apply_allowed_llm_selection

                llm_selection = apply_allowed_llm_selection(llm_selection) or {}
            except PermissionError as exc:
                raise RuntimeError(str(exc)) from exc
        else:
            # Non-admin users MUST end up with a concrete llm_selection so we
            # never silently fall through to the global LLM client (which is
            # configured from admin runtime settings). Admin keeps the existing behavior
            # (None llm_selection → default config from admin scope).
            from cognivoy.multi_user.context import get_current_user
            from cognivoy.multi_user.model_access import (
                has_capability_access,
                redacted_model_access,
            )

            current_user = get_current_user()
            if not current_user.is_admin:
                # Single gate, shared with the frontend lock and any HTTP
                # surface: no usable LLM grant → a clear terminal error here
                # instead of a silent fall-through to the global client.
                if not has_capability_access("llm"):
                    raise RuntimeError(
                        "No LLM model is assigned to your account. Please contact an administrator."
                    )
                # Pin the first granted-and-available model as the selection.
                assigned_llms = [
                    item
                    for item in redacted_model_access(current_user.id).get("llm", [])
                    if item.get("available")
                ]
                llm_selection = {
                    "profile_id": assigned_llms[0].get("profile_id"),
                    "model_id": assigned_llms[0].get("model_id"),
                }
        if llm_selection:
            from cognivoy.multi_user.personal_models import merge_personal_llm_profiles
            from cognivoy.services.config import get_model_catalog_service
            from cognivoy.services.model_selection import (
                LLMSelection,
                apply_llm_selection_to_catalog,
            )

            try:
                # Personal (owner-bound) profiles live in the user's own
                # catalog, so validating against the shared one alone would
                # reject a Codex model the user signed in for themselves —
                # the same merge the resolution path performs (#781).
                apply_llm_selection_to_catalog(
                    merge_personal_llm_profiles(get_model_catalog_service().load()),
                    LLMSelection.from_payload(llm_selection),
                )
            except ValueError as exc:
                raise RuntimeError(str(exc)) from exc
        # If the caller didn't pin a per-turn tool list (e.g. non-web
        # channels or the new web UI which sources tools from
        # /settings/tools), back-fill from the user's saved toggleable-tool
        # preference so the chat pipeline sees the same set the user picked
        # in Settings. Callers that explicitly pass ``tools`` (including
        # an empty list) keep their value untouched.
        if payload.get("tools") is None:
            try:
                from cognivoy.api.routers.settings import get_enabled_optional_tools

                payload = {**payload, "tools": list(get_enabled_optional_tools())}
            except Exception:
                payload = {**payload, "tools": []}
        # Admin-imposed per-user tool whitelist (grant v2). Sits after the
        # back-fill so explicit caller lists and settings defaults pass the
        # same gate; this is the single enforcement point for every
        # capability's turn.
        from cognivoy.multi_user.tool_access import allowed_optional_tools

        allowed_tools = allowed_optional_tools()
        if allowed_tools is not None:
            payload = {
                **payload,
                "tools": [t for t in (payload.get("tools") or []) if t in allowed_tools],
            }
        payload = {**payload, "llm_selection": llm_selection}
        await self._recover_orphan_running_turns_for_session(session["id"])
        preference_update: dict[str, Any] = {
            "capability": capability,
            "tools": list(payload.get("tools") or []),
            "knowledge_bases": list(payload.get("knowledge_bases") or []),
            "language": str(payload.get("language") or "en"),
        }
        if llm_selection:
            preference_update["llm_selection"] = llm_selection
        if persona_explicit:
            # Persist explicit set AND explicit clear ("" = back to Default).
            preference_update["persona"] = persona_pref
        if learning_context_explicit:
            # An explicit empty object clears a prior project association.
            preference_update["learning_context"] = learning_context
        await self.store.update_session_preferences(session["id"], preference_update)
        turn = await self.store.create_turn(session["id"], capability=capability)
        # Deep Research already checkpoints individual topic blocks. Giving it
        # a deterministic id tied to the Turn lets a restarted runner continue
        # those blocks without a transport-specific resume parameter.
        if capability == "deep_research" and not payload["config"].get("checkpoint_id"):
            payload = {
                **payload,
                "config": {
                    **dict(payload.get("config") or {}),
                    "checkpoint_id": f"research_{turn['id']}",
                },
            }
        await asyncio.to_thread(
            self.recovery_store.create,
            turn_id=turn["id"],
            session_id=session["id"],
            capability=capability,
            payload=dict(payload),
            worker_id=self._worker_id,
            lease_seconds=15.0,
        )
        execution = _TurnExecution(
            turn_id=turn["id"],
            session_id=session["id"],
            capability=capability,
            payload=dict(payload),
        )
        session_metadata: dict[str, Any] = {
            "session_id": session["id"],
            "turn_id": turn["id"],
        }
        regenerated_from = runtime_only_config.get("_regenerated_from_message_id")
        if regenerated_from is not None:
            session_metadata["regenerated_from_message_id"] = regenerated_from
        superseded_turn_id = runtime_only_config.get("_superseded_turn_id")
        if superseded_turn_id:
            session_metadata["superseded_turn_id"] = str(superseded_turn_id)
        if runtime_only_config.get("_regenerate"):
            session_metadata["regenerate"] = True
        async with self._lock:
            self._executions[turn["id"]] = execution
        try:
            await self.store.update_turn_status(turn["id"], "running")
            turn = {**turn, "status": "running"}
            await self._publish_live_event(
                execution,
                StreamEvent(
                    type=StreamEventType.SESSION,
                    source="turn_runtime",
                    metadata=session_metadata,
                ),
            )
        except Exception as exc:
            async with self._lock:
                self._executions.pop(turn["id"], None)
            await self.store.update_turn_status(turn["id"], "failed", str(exc))
            raise
        async with self._lock:
            execution.task = asyncio.create_task(self._run_turn_with_recovery_lease(execution))
        return session, turn

    async def regenerate_last_turn(
        self,
        session_id: str,
        overrides: dict[str, Any] | None = None,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        """Re-run the prior user message in ``session_id``.

        Deletes the trailing assistant message (if any), then dispatches a new
        turn with ``_persist_user_message=False`` and ``_regenerate=True`` so
        the runtime knows not to duplicate the user row or refresh long-term
        memory a second time. The original user message stays in place.
        """
        session_id = str(session_id or "").strip()
        if not session_id:
            raise RuntimeError("nothing_to_regenerate")

        session = await self.store.get_session(session_id)
        if session is None:
            raise RuntimeError("nothing_to_regenerate")

        active = await self.store.get_active_turn(session_id)
        if active is not None:
            raise RuntimeError("regenerate_busy")

        last_user = await self.store.get_last_message(session_id, role="user")
        if last_user is None:
            raise RuntimeError("nothing_to_regenerate")

        last_message = await self.store.get_last_message(session_id)
        previous_turn_id: str | None = None
        if last_message is not None and last_message.get("role") == "assistant":
            for event in last_message.get("events") or []:
                turn_id = str((event or {}).get("turn_id") or "")
                if turn_id:
                    previous_turn_id = turn_id
                    break
            await self.store.delete_message(last_message["id"])

        preferences = session.get("preferences") or {}
        overrides = overrides or {}
        snapshot = {}
        metadata = last_user.get("metadata") or {}
        if isinstance(metadata, dict):
            candidate = metadata.get("request_snapshot") or metadata.get("requestSnapshot")
            if isinstance(candidate, dict):
                snapshot = candidate

        capability = str(
            overrides.get("capability")
            or last_user.get("capability")
            or preferences.get("capability")
            or "chat"
        )

        def replay_value(
            override_key: str,
            snapshot_key: str,
            preference_key: str | None = None,
            *,
            default: Any,
        ) -> Any:
            """Resolve regenerate context without treating explicit empties as absent."""
            if override_key in overrides:
                return overrides[override_key]
            if snapshot_key in snapshot:
                return snapshot[snapshot_key]
            if preference_key is not None and preference_key in preferences:
                return preferences[preference_key]
            return default

        tools = list(replay_value("tools", "enabledTools", "tools", default=[]) or [])
        knowledge_bases = list(
            replay_value("knowledge_bases", "knowledgeBases", "knowledge_bases", default=[]) or []
        )
        language = str(replay_value("language", "language", "language", default="en") or "en")

        # Re-run the exact public configuration captured with the original
        # message, then apply explicitly supplied overrides. Runtime-only flags
        # are always regenerated below and can never come from the snapshot.
        config: dict[str, Any] = dict(snapshot.get("config") or {})
        config.update(dict(overrides.get("config") or {}))
        config.update(
            {
                "_persist_user_message": False,
                "_regenerate": True,
                "_regenerated_from_message_id": int(last_user["id"]),
            }
        )
        if previous_turn_id:
            config["_superseded_turn_id"] = previous_turn_id
        llm_selection = replay_value("llm_selection", "llmSelection", "llm_selection", default=None)

        payload: dict[str, Any] = {
            "session_id": session_id,
            "capability": capability,
            "content": str(last_user.get("content", "") or ""),
            "tools": tools,
            "knowledge_bases": knowledge_bases,
            "language": language,
            "attachments": list(last_user.get("attachments") or []),
            "notebook_references": list(
                replay_value(
                    "notebook_references",
                    "notebookReferences",
                    "notebook_references",
                    default=[],
                )
                or []
            ),
            "history_references": list(
                replay_value(
                    "history_references",
                    "historyReferences",
                    "history_references",
                    default=[],
                )
                or []
            ),
            "question_notebook_references": list(
                replay_value(
                    "question_notebook_references",
                    "questionNotebookReferences",
                    default=[],
                )
                or []
            ),
            "book_references": list(
                replay_value("book_references", "bookReferences", default=[]) or []
            ),
            "memory_references": list(
                replay_value("memory_references", "memoryReferences", default=[]) or []
            ),
            "skills": list(replay_value("skills", "skills", default=[]) or []),
            "persona": str(replay_value("persona", "persona", "persona", default="") or ""),
            "config": config,
        }
        learning_context = replay_value("learning_context", "learningContext", default=None)
        if learning_context:
            payload["learning_context"] = dict(learning_context)
        if llm_selection:
            payload["llm_selection"] = llm_selection
        # Confirming a research outline intentionally does not persist a second
        # user message. The user snapshot therefore still describes planning,
        # not the confirmed research request. Retry a partial report from that
        # turn's owner-scoped manifest so Regenerate actually resumes its
        # checkpoint instead of asking for the outline again.
        if capability == "deep_research" and previous_turn_id and last_message is not None:
            research_result = next(
                (
                    event.get("metadata", {}).get("metadata", {})
                    for event in reversed(last_message.get("events") or [])
                    if event.get("type") == "result"
                    and event.get("source") == "deep_research"
                    and isinstance(event.get("metadata"), dict)
                ),
                {},
            )
            if (
                isinstance(research_result, dict)
                and research_result.get("partial") is True
                and research_result.get("checkpoint_resumable") is True
                and isinstance(research_result.get("research_checkpoint_id"), str)
                and research_result["research_checkpoint_id"]
            ):
                previous_turn = await self.store.get_turn(previous_turn_id)
                manifest = (
                    await asyncio.to_thread(self.recovery_store.load, previous_turn_id)
                    if previous_turn is not None and previous_turn.get("session_id") == session_id
                    else None
                )
                if (
                    manifest
                    and manifest.get("session_id") == session_id
                    and manifest.get("capability") == "deep_research"
                    and isinstance(manifest.get("payload"), dict)
                    and isinstance(manifest["payload"].get("config"), dict)
                ):
                    confirmed_request = manifest.get("payload") or {}
                    confirmed_config = confirmed_request.get("config") or {}
                    compatible = all(
                        value == confirmed_request.get(key)
                        for key, value in overrides.items()
                        if key not in {"language", "llm_selection", "config"}
                    ) and all(
                        value == confirmed_config.get(key)
                        for key, value in (overrides.get("config") or {}).items()
                    )
                    if (
                        compatible
                        and confirmed_request.get("session_id") == session_id
                        and confirmed_request.get("capability") == "deep_research"
                        and confirmed_config.get("confirmed_outline")
                        and confirmed_config.get("checkpoint_id")
                        == research_result.get("research_checkpoint_id")
                    ):
                        payload = {
                            **confirmed_request,
                            "session_id": session_id,
                            "language": language,
                            "config": {
                                **{
                                    key: value
                                    for key, value in confirmed_config.items()
                                    if not key.startswith("_")
                                },
                                **{
                                    key: value
                                    for key, value in config.items()
                                    if key.startswith("_")
                                },
                            },
                        }
                        if "llm_selection" in overrides:
                            payload["llm_selection"] = overrides["llm_selection"]
        return await self.start_turn(payload)

    async def cancel_turn(self, turn_id: str) -> bool:
        async with self._lock:
            execution = self._executions.get(turn_id)
        if execution is None or execution.task is None or execution.task.done():
            turn = await self.store.get_turn(turn_id)
            if turn is None or not is_active_turn_status(turn.get("status")):
                return False
            await self.store.update_turn_status(turn_id, "cancelled", "Turn cancelled")
            return True
        execution.task.cancel()
        # Wait for the task to finish so its finally block (including save)
        # completes before the caller proceeds.
        try:
            await execution.task
        except asyncio.CancelledError:
            pass
        return True

    async def submit_user_reply(
        self,
        turn_id: str,
        text: str | None = None,
        *,
        answers: list[dict[str, Any]] | None = None,
    ) -> bool:
        """Deliver a user reply to a turn that's paused on ``ask_user``.

        Returns ``True`` if the turn was waiting and the reply was
        accepted; ``False`` if no waiter is registered (turn finished,
        was cancelled, or the model never asked).

        Accepts either ``text`` (single free-form reply, legacy single-
        question shape) or ``answers`` (list of ``{questionId, text}``
        pairs, v2 multi-question shape). Both may be passed; the
        consumer prefers structured ``answers`` when present and falls
        back to ``text`` for the legacy case. The payload is enqueued —
        the pipeline's ``await waiter()`` call unblocks on the next
        event-loop tick and substitutes the reply into the matching
        ``role=tool`` message.
        """
        queue = self._reply_queues.get(turn_id)
        payload: dict[str, Any] = {"text": text or "", "answers": answers}
        if queue is None:
            return await asyncio.to_thread(self.recovery_store.submit_reply, turn_id, payload)
        await queue.put(payload)
        return True

    async def subscribe_turn(
        self,
        turn_id: str,
        after_seq: int = 0,
    ) -> AsyncIterator[dict[str, Any]]:
        backlog = await self.store.get_turn_events(turn_id, after_seq=after_seq)
        last_seq = after_seq
        # Track whether we ever yielded a terminal event (DONE) — if the live
        # queue ends WITHOUT one (e.g. a transient send-side stall on
        # ``safe_send`` swallowed it), we synthesise one before returning so
        # the frontend's ``isStreaming`` state clears immediately rather than
        # waiting on the 45s heartbeat-timeout + reconnect catchup path.
        done_yielded = False

        def _track(item: dict[str, Any]) -> dict[str, Any]:
            nonlocal done_yielded
            if str(item.get("type") or "") == "done":
                done_yielded = True
            return item

        for item in backlog:
            last_seq = max(last_seq, int(item.get("seq") or 0))
            yield _track(item)

        queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        subscriber = _LiveSubscriber(queue=queue)
        execution: _TurnExecution | None = None
        live_backlog: list[dict[str, Any]] = []
        async with self._lock:
            execution = self._executions.get(turn_id)
            if execution is not None:
                execution.subscribers.append(subscriber)
                live_backlog = [
                    item for item in execution.events if int(item.get("seq") or 0) > last_seq
                ]

        for item in live_backlog:
            seq = int(item.get("seq") or 0)
            if seq <= last_seq:
                continue
            last_seq = seq
            yield _track(item)

        catchup = []
        if execution is None:
            catchup = await self.store.get_turn_events(turn_id, after_seq=last_seq)
        for item in catchup:
            seq = int(item.get("seq") or 0)
            if seq <= last_seq:
                continue
            last_seq = seq
            yield _track(item)

        turn = await self.store.get_turn(turn_id)
        if execution is None:
            turn = await self.recover_orphan_turn(turn)
            if turn is not None and is_active_turn_status(turn.get("status")):
                async with self._lock:
                    resumed_execution = self._executions.get(turn_id)
                    if resumed_execution is not None:
                        resumed_execution.subscribers.append(subscriber)
                        execution = resumed_execution
                # The recovery marker is persisted before the replacement task
                # starts, so fetch it after attaching and preserve sequence
                # ordering relative to any immediately emitted live events.
                resumed_backlog = await self.store.get_turn_events(turn_id, after_seq=last_seq)
                for item in resumed_backlog:
                    seq = int(item.get("seq") or 0)
                    if seq <= last_seq:
                        continue
                    last_seq = seq
                    yield _track(item)
        if execution is None:
            if turn is None or not is_active_turn_status(turn.get("status")):
                # Turn already finished and we didn't see a DONE in any of the
                # persisted history above — synthesise one so the caller can
                # still close out its streaming state cleanly.
                if not done_yielded:
                    if turn is not None and str(turn.get("status") or "") in {
                        "failed",
                        "timed_out",
                    }:
                        error_event = self._synthesize_error_event(turn_id, turn)
                        if error_event is not None:
                            yield error_event
                    yield self._synthesize_done_event(turn_id, turn)
                return
            # Another API worker owns the live runner.  Its in-memory subscriber
            # queues are not visible here, so tail the authoritative event store
            # until the persisted turn reaches a terminal state.  This also
            # keeps reconnects working without requiring sticky load balancing.
            while True:
                persisted = await self.store.get_turn_events(turn_id, after_seq=last_seq)
                for item in persisted:
                    seq = int(item.get("seq") or 0)
                    if seq <= last_seq:
                        continue
                    last_seq = seq
                    yield _track(item)
                turn = await self.store.get_turn(turn_id)
                if turn is None or not is_active_turn_status(turn.get("status")):
                    if not done_yielded:
                        if turn is not None and str(turn.get("status") or "") in {
                            "failed",
                            "timed_out",
                        }:
                            error_event = self._synthesize_error_event(turn_id, turn)
                            if error_event is not None:
                                yield error_event
                        yield self._synthesize_done_event(turn_id, turn)
                    return
                await asyncio.sleep(0.05)
        try:
            while True:
                item = await queue.get()
                if item is None:
                    break
                seq = int(item.get("seq") or 0)
                if seq <= last_seq:
                    continue
                last_seq = seq
                yield _track(item)
        finally:
            async with self._lock:
                execution = self._executions.get(turn_id)
                if execution is not None:
                    execution.subscribers = [
                        sub for sub in execution.subscribers if sub is not subscriber
                    ]
            # Safety net: if we drained the live queue (None sentinel arrived)
            # without ever yielding a DONE, the turn is over server-side but
            # the frontend wouldn't know. Read the persisted turn status one
            # more time and synthesise a terminal DONE only for genuinely
            # terminal turns so ``isStreaming`` clears without waiting on
            # the heartbeat-reconnect fallback. A running turn may be paused
            # on ``ask_user`` or may have had this subscription replaced; in
            # that case a synthetic DONE would falsely mark the turn
            # completed while the backend is still awaiting input.
            if not done_yielded:
                final_turn = await self.store.get_turn(turn_id)
                final_status = str((final_turn or {}).get("status") or "").strip()
                if final_turn is None or final_status in TERMINAL_TURN_STATUSES:
                    yield self._synthesize_done_event(turn_id, final_turn)

    @staticmethod
    def _synthesize_done_event(turn_id: str, turn: dict[str, Any] | None) -> dict[str, Any]:
        """Build a DONE event payload from the persisted turn status.

        Used as a recovery path when ``subscribe_turn`` finishes without
        ever observing a live or persisted DONE event for a turn that has
        nonetheless terminated server-side. Mirrors the shape of the
        events the runtime would normally publish so the frontend doesn't
        need a special code path to consume it.
        """
        status = "completed"
        error: str | None = None
        if turn is not None:
            raw_status = str(turn.get("status") or "").strip()
            if raw_status in TERMINAL_TURN_STATUSES:
                status = raw_status
            error_text = str(turn.get("error") or "").strip()
            if error_text:
                error = error_text
        metadata: dict[str, Any] = {"status": status, "synthesized": True}
        if error:
            metadata["error"] = error
        return {
            "type": "done",
            "source": "turn_runtime",
            "stage": "",
            "content": "",
            "metadata": metadata,
            "session_id": "",
            "turn_id": turn_id,
            "seq": 0,
        }

    @staticmethod
    def _synthesize_error_event(turn_id: str, turn: dict[str, Any] | None) -> dict[str, Any] | None:
        """Build a terminal ERROR event from a failed or timed-out persisted turn."""
        error = str((turn or {}).get("error") or "").strip()
        if not error:
            return None
        return {
            "type": "error",
            "source": "turn_runtime",
            "stage": "",
            "content": error,
            "metadata": {
                "status": str((turn or {}).get("status") or "failed"),
                "synthesized": True,
            },
            "session_id": str((turn or {}).get("session_id") or ""),
            "turn_id": turn_id,
            "seq": 0,
        }

    async def subscribe_session(
        self,
        session_id: str,
        after_seq: int = 0,
    ) -> AsyncIterator[dict[str, Any]]:
        active_turn = await self.store.get_active_turn(session_id)
        if active_turn is None:
            return
        async for item in self.subscribe_turn(active_turn["id"], after_seq=after_seq):
            yield item

    async def _run_turn(self, execution: _TurnExecution) -> None:
        payload = execution.payload
        session_id = execution.session_id
        capability_name = execution.capability
        turn_id = execution.turn_id
        attachments = []
        attachment_records = []
        assistant_events: list[dict[str, Any]] = []
        assistant_content = ""
        # Per-round content segments + narration call_ids: a chat-loop round's
        # text is captured live but a round that resolves as narration is
        # dropped from the persisted answer (mirrors the frontend bubble).
        content_segments: list[tuple[str | None, str]] = []
        narration_call_ids: set[str] = set()

        def _persisted_answer() -> str:
            # clean_thinking_tags is a second line of defence: providers that
            # inline <think> in the content channel are split at streaming
            # time by the agent loop, but anything that slips through must
            # never be persisted as the user-facing answer.
            return _assemble_persisted_answer(content_segments, narration_call_ids)

        # Files the model generated this turn (exec/code_execution artifacts),
        # persisted as assistant-message attachments so the UI shows openable
        # cards. Deduped by URL across the turn's SOURCES events.
        generated_attachments: list[dict[str, Any]] = []
        seen_artifact_urls: set[str] = set()
        stream_done_sent = False
        llm_scope_token: Token[LLMConfig | None] | None = None
        reset_active_llm_selection: Callable[[Token[LLMConfig | None] | None], None] | None = None
        # One queue per turn for ``ask_user`` style pause-resume.
        # Created here (BEFORE the orchestrator runs) so the pipeline can
        # await on the awaitable we publish into ``context.metadata``.
        # Cleaned up unconditionally in the outer ``finally``.
        reply_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
        self._reply_queues[turn_id] = reply_queue
        user_input_pause_event = asyncio.Event()
        user_input_resume_event = asyncio.Event()
        user_input_resume_event.set()

        async def _wait_for_user_reply() -> dict[str, Any] | None:
            return await self._wait_for_user_reply(
                turn_id,
                reply_queue,
                pause_event=user_input_pause_event,
                resume_event=user_input_resume_event,
            )

        try:
            from cognivoy.agents.notebook import NotebookAnalysisAgent
            from cognivoy.book.context import build_book_context
            from cognivoy.core.context import Attachment, UnifiedContext
            from cognivoy.runtime.orchestrator import ChatOrchestrator
            from cognivoy.services.memory import get_memory_store
            from cognivoy.services.model_selection.runtime import (
                activate_llm_selection,
            )
            from cognivoy.services.model_selection.runtime import (
                reset_llm_selection as reset_active_llm_selection,
            )
            from cognivoy.services.notebook import get_notebook_manager
            from cognivoy.services.session.context_builder import ContextBuilder
            from cognivoy.services.skill import get_skill_service

            request_config = dict(payload.get("config", {}) or {})
            followup_question_context = _extract_followup_question_context(request_config)
            persist_user_message = _extract_persist_user_message(request_config)
            is_regenerate = _extract_regenerate_flag(request_config)
            recovery_attempt = int(request_config.pop("_recovery_attempt", 0) or 0)
            request_config.pop("_regenerated_from_message_id", None)
            request_config.pop("_superseded_turn_id", None)
            raw_user_content = str(payload.get("content", "") or "")
            # Edit-branching tip: when the FE includes ``parent_message_id``
            # (even as ``null``), the new user message attaches at that
            # exact parent — creating a sibling of any existing children
            # and forcing LLM context to come from that parent's ancestor
            # chain only. When the key is absent (legacy callers), the
            # store auto-appends to the latest message in the session.
            branch_parent_explicit = "parent_message_id" in payload
            branch_parent_raw = payload.get("parent_message_id")
            branch_parent_id: int | None
            if branch_parent_explicit:
                try:
                    branch_parent_id = (
                        int(branch_parent_raw) if branch_parent_raw is not None else None
                    )
                except (TypeError, ValueError):
                    branch_parent_id = None
                    branch_parent_explicit = False
            else:
                branch_parent_id = None
            notebook_references = payload.get("notebook_references", []) or []
            history_references = payload.get("history_references", []) or []
            question_notebook_references = payload.get("question_notebook_references", []) or []
            book_context_result = build_book_context(payload.get("book_references", []) or [])
            book_references = book_context_result.references
            memory_references = _extract_memory_references(payload)
            notebook_context = ""
            history_context = ""
            question_bank_context = ""
            book_context = book_context_result.text

            import base64 as _b64
            import uuid as _uuid

            from cognivoy.services.storage import get_attachment_store

            for item in payload.get("attachments", []):
                record = {
                    "type": item.get("type", "file"),
                    "url": item.get("url", ""),
                    "base64": item.get("base64", ""),
                    "filename": item.get("filename", ""),
                    "mime_type": item.get("mime_type", ""),
                    "id": item.get("id", "") or _uuid.uuid4().hex[:12],
                }
                attachment_records.append(record)

            # Persist original bytes to the attachment store before extraction
            # so the frontend preview drawer can fetch the file later. The
            # extractor will clear base64 on documents to keep DB rows lean,
            # but the URL we record here outlives that pruning. Upload errors
            # are non-fatal — extraction still runs from the in-memory base64.
            attachment_store = get_attachment_store()
            for record in attachment_records:
                if record.get("url"):
                    continue  # already hosted (e.g. legacy URL)
                b64 = record.get("base64") or ""
                if not b64:
                    continue
                try:
                    raw_bytes = _b64.b64decode(b64, validate=False)
                except Exception as exc:
                    logger.warning(
                        "skipping attachment upload for %r: invalid base64 (%s)",
                        record.get("filename"),
                        exc,
                    )
                    continue
                try:
                    record["url"] = await attachment_store.put(
                        session_id=session_id,
                        attachment_id=record["id"],
                        filename=record.get("filename", "") or "file",
                        data=raw_bytes,
                        mime_type=record.get("mime_type", "") or "",
                    )
                except Exception as exc:
                    logger.warning(
                        "attachment store rejected %r: %s",
                        record.get("filename"),
                        exc,
                    )

            from cognivoy.utils.document_extractor import extract_documents_from_records

            document_texts, attachment_records = extract_documents_from_records(attachment_records)
            attachments = [
                Attachment(
                    type=r.get("type", "file"),
                    url=r.get("url", ""),
                    base64=r.get("base64", ""),
                    filename=r.get("filename", ""),
                    mime_type=r.get("mime_type", ""),
                    id=r.get("id", ""),
                    extracted_text=r.get("extracted_text", ""),
                )
                for r in attachment_records
            ]
            # DB persistence copy: drop base64 unconditionally now that the
            # original bytes live in the attachment store. Image attachments
            # used to keep base64 here (which bloated message rows); the URL
            # is now the stable source for previews.
            persisted_attachment_records = [
                {
                    **{k: v for k, v in r.items() if k != "base64"},
                    "base64": "",
                }
                for r in attachment_records
            ]

            if followup_question_context:
                existing_messages = await self.store.get_messages_for_context(
                    session_id, leaf_message_id=branch_parent_id
                )
                if not existing_messages:
                    await self.store.add_message(
                        session_id=session_id,
                        role="system",
                        content=_format_followup_question_context(
                            followup_question_context,
                            language=str(payload.get("language", "en") or "en"),
                        ),
                        capability=capability_name or "chat",
                    )

            llm_config, llm_scope_token = activate_llm_selection(payload.get("llm_selection"))
            builder = ContextBuilder(self.store)

            async def _emit_context_event(event: StreamEvent) -> None:
                if event.source in {"context", "context_builder"}:
                    return
                await self._publish_live_event(execution, event)

            history_result = await builder.build(
                session_id=session_id,
                llm_config=llm_config,
                language=payload.get("language", "en"),
                on_event=_emit_context_event,
                leaf_message_id=branch_parent_id,
            )
            memory_store = get_memory_store()
            memory_context = (
                memory_store.read_l3_selected(memory_references) if memory_references else ""
            )

            # Persona: at most one behaviour preset per turn, eagerly
            # injected (a persona must shape the voice from the first
            # token). Resolution: the user's own workspace first; non-admin
            # users fall back to admin-authored presets (personas carry no
            # privileged workflow, so no grant gate applies).
            from cognivoy.multi_user.context import get_current_user
            from cognivoy.multi_user.paths import get_admin_path_service
            from cognivoy.multi_user.skill_access import assigned_skill_ids
            from cognivoy.services.persona import PersonaService, get_persona_service
            from cognivoy.services.skill.service import SkillService, render_skills_manifest

            current_user = get_current_user()
            requested_persona = str(payload.get("persona") or "").strip()
            persona_context = ""
            if requested_persona:
                persona_context = get_persona_service().load_for_context(requested_persona)
                if not persona_context and not current_user.is_admin:
                    persona_context = PersonaService(
                        root=get_admin_path_service().get_workspace_dir() / "personas"
                    ).load_for_context(requested_persona)
            active_persona = requested_persona if persona_context else ""
            learning_project = _learning_project_for_turn(
                payload,
                owner_id=current_user.id,
            )
            learning_context = payload.get("learning_context")
            trusted_learning_context = _trusted_learning_task_context(
                learning_project,
                learning_context,
            )
            if (
                learning_project is not None
                and capability_name == "mastery_path"
                and trusted_learning_context
            ):
                try:
                    from cognivoy.learning.project_storage import LearningProjectStore

                    started = await asyncio.to_thread(
                        LearningProjectStore().start_structured_session,
                        learning_project.id,
                        trusted_learning_context["task_id"],
                        session_id=session_id,
                    )
                    if started is not None:
                        learning_project = started[0]
                except (OSError, KeyError, TypeError, ValueError):
                    logger.warning(
                        "Failed to initialize structured learning session for project %s",
                        learning_project.id,
                        exc_info=True,
                    )
            _mount_learning_project_knowledge(payload, learning_project)
            learning_guidance = _learning_project_guidance(
                payload,
                owner_id=current_user.id,
                language=str(payload.get("language", "en") or "en"),
                project=learning_project,
            )

            # Skills: never user-selected per turn. The model sees a
            # one-line manifest of every skill visible to this user (own +
            # builtin, plus admin-assigned for non-admin users) and pulls
            # full content on demand via ``read_skill``. ``always`` skills
            # are the exception — their bodies are injected eagerly.
            user_skill_service = get_skill_service()
            skill_entries = user_skill_service.summary_entries()
            requested_skills = set(_string_list(payload.get("skills")))
            if requested_skills:
                skill_entries = [
                    entry
                    for entry in skill_entries
                    if entry.always or entry.name in requested_skills
                ]
            always_blocks = [user_skill_service.load_always_for_context()]
            if not current_user.is_admin:
                assigned_service = SkillService(
                    root=get_admin_path_service().get_workspace_dir() / "skills",
                    builtin_root=None,
                )
                allowed_skills = assigned_skill_ids(current_user.id)
                assigned_entries = [
                    e for e in assigned_service.summary_entries() if e.name in allowed_skills
                ]
                if requested_skills:
                    assigned_entries = [
                        entry
                        for entry in assigned_entries
                        if entry.always or entry.name in requested_skills
                    ]
                skill_entries = skill_entries + assigned_entries
                always_blocks.append(
                    assigned_service.load_for_context(
                        [e.name for e in assigned_entries if e.always and e.available]
                    )
                )
            skills_manifest = "\n\n".join(
                part for part in (*always_blocks, render_skills_manifest(skill_entries)) if part
            )

            # Chat capability uses the lightweight manifest + read_source
            # affordance (no upstream LLM call, no wholesale-dump into the
            # user message). All other capabilities keep the legacy concat
            # path because their internal pipelines consume the named blocks
            # (``[Notebook Context]`` etc.) directly.
            is_chat_capability = (capability_name or "") in {"", "chat"}

            source_manifest_text = ""
            source_index: dict[str, str] = {}

            if is_chat_capability:
                from cognivoy.services.session.source_inventory import (
                    build_inventory,
                    render_manifest,
                )

                resolved_notebook_records = (
                    get_notebook_manager().get_records_by_references(notebook_references)
                    if notebook_references
                    else []
                )
                # Current turn ordinal = (#user messages on this branch's
                # ancestor chain) + 1. ``_count_branch_user_turns`` walks
                # the same lineage the inventory builder uses, so we agree
                # on what "turn N" means for the historical labels.
                current_turn_ordinal = (
                    await _count_branch_user_turns(self.store, session_id, branch_parent_id) + 1
                )
                inventory = await build_inventory(
                    self.store,
                    session_id=session_id,
                    leaf_message_id=branch_parent_id,
                    current_turn_ordinal=current_turn_ordinal,
                    fresh_attachment_records=attachment_records,
                    fresh_notebook_records=resolved_notebook_records,
                    fresh_book_context_text=book_context,
                    fresh_book_references=book_references,
                    fresh_history_session_ids=history_references,
                    fresh_question_entry_ids=question_notebook_references,
                    language=str(payload.get("language", "en") or "en"),
                )
                source_manifest_text, source_index = render_manifest(inventory)
                effective_user_message = raw_user_content
            else:
                if notebook_references:
                    referenced_records = get_notebook_manager().get_records_by_references(
                        notebook_references
                    )
                    if referenced_records:
                        analysis_agent = NotebookAnalysisAgent(
                            language=str(payload.get("language", "en") or "en")
                        )
                        notebook_context = await analysis_agent.analyze(
                            user_question=raw_user_content,
                            records=referenced_records,
                            emit=_emit_context_event,
                        )

                if history_references:
                    from cognivoy.services.session.source_inventory import (
                        serialize_referenced_transcript,
                    )

                    history_records: list[dict[str, Any]] = []
                    for session_ref in history_references:
                        history_session_id = str(session_ref or "").strip()
                        if not history_session_id:
                            continue

                        history_session = await self.store.get_session(history_session_id)
                        if not history_session:
                            continue

                        history_messages = await self.store.get_messages_for_context(
                            history_session_id
                        )
                        transcript = serialize_referenced_transcript(
                            history_session,
                            history_messages,
                            language=str(payload.get("language", "en") or "en"),
                        )
                        if not transcript:
                            continue

                        history_summary = str(
                            history_session.get("compressed_summary", "") or ""
                        ).strip()
                        if not history_summary:
                            history_summary = _clip_text(
                                " ".join(
                                    str(message.get("content", "") or "").strip()
                                    for message in history_messages[-4:]
                                    if str(message.get("content", "") or "").strip()
                                ),
                                limit=400,
                            )
                        if not history_summary:
                            history_summary = f"{len(history_messages)} messages"

                        history_records.append(
                            {
                                "id": history_session_id,
                                "notebook_id": "__history__",
                                "notebook_name": "History",
                                "title": str(
                                    history_session.get("title", "") or "Untitled session"
                                ),
                                "summary": history_summary,
                                "output": transcript,
                                "metadata": {
                                    "session_id": history_session_id,
                                    "source": "history",
                                },
                            }
                        )

                    if history_records:
                        analysis_agent = NotebookAnalysisAgent(
                            language=str(payload.get("language", "en") or "en")
                        )
                        history_context = await analysis_agent.analyze(
                            user_question=raw_user_content,
                            records=history_records,
                            emit=_emit_context_event,
                        )
                        if not history_context.strip():
                            MAX_FALLBACK_CHARS = 8000
                            parts: list[str] = []
                            total = 0
                            for record in history_records:
                                output = record.get("output")
                                if not output:
                                    continue
                                part = f"## Session: {record.get('title', 'Untitled')}\n{output}"
                                if total + len(part) > MAX_FALLBACK_CHARS:
                                    remaining = MAX_FALLBACK_CHARS - total
                                    if remaining > 100:
                                        parts.append(part[:remaining] + "\n...(truncated)")
                                    break
                                parts.append(part)
                                total += len(part)
                            history_context = "\n\n".join(parts)

                if question_notebook_references:
                    question_bank_context = await _build_question_bank_context(
                        self.store, question_notebook_references
                    )

                effective_user_message = raw_user_content
                context_parts: list[str] = []
                if document_texts:
                    context_parts.append("[Attached Documents]\n" + "\n\n".join(document_texts))
                if book_context:
                    context_parts.append(f"[Book Context]\n{book_context}")
                if notebook_context:
                    context_parts.append(f"[Notebook Context]\n{notebook_context}")
                if history_context:
                    context_parts.append(f"[History Context]\n{history_context}")
                if question_bank_context:
                    context_parts.append(f"[Question Bank Context]\n{question_bank_context}")
                if context_parts:
                    context_parts.append(f"[User Question]\n{raw_user_content}")
                    effective_user_message = "\n\n".join(context_parts)

            conversation_history = list(history_result.conversation_history)
            conversation_context_text = history_result.context_text

            # SQLite returns integer rowids; PocketBase returns its string
            # record ids. Both are opaque to this layer — they only flow into
            # ``parent_message_id`` chaining and the DONE reconcile metadata.
            new_user_message_id: int | str | None = None
            if persist_user_message:
                # Pass parent explicitly only when the FE pinned it (covers
                # both branched edits with a positive id and root edits
                # with explicit null). Otherwise let the store auto-append.
                parent_kwargs: dict[str, Any] = (
                    {"parent_message_id": branch_parent_id} if branch_parent_explicit else {}
                )
                new_user_message_id = await self.store.add_message(
                    session_id=session_id,
                    role="user",
                    content=raw_user_content,
                    capability=capability_name,
                    attachments=persisted_attachment_records,
                    metadata=_request_snapshot_metadata(
                        payload=payload,
                        content=raw_user_content,
                        capability=capability_name,
                        config=request_config,
                        attachments=persisted_attachment_records,
                        notebook_references=notebook_references,
                        history_references=history_references,
                        question_notebook_references=question_notebook_references,
                        book_references=book_references,
                        persona=active_persona,
                        memory_references=memory_references,
                        llm_selection=payload.get("llm_selection"),
                    ),
                    **parent_kwargs,
                )
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(
                        self.recovery_store.mark_input_persisted,
                        turn_id,
                        message_id=new_user_message_id,
                    )

            context = UnifiedContext(
                session_id=session_id,
                user_message=effective_user_message,
                conversation_history=conversation_history,
                enabled_tools=payload.get("tools"),
                active_capability=payload.get("capability"),
                knowledge_bases=payload.get("knowledge_bases", []),
                attachments=attachments,
                config_overrides=request_config,
                language=payload.get("language", "en"),
                memory_context=memory_context,
                persona_context=persona_context,
                skills_manifest=skills_manifest,
                source_manifest=source_manifest_text,
                metadata={
                    "conversation_summary": history_result.conversation_summary,
                    "conversation_context_text": conversation_context_text,
                    "history_token_count": history_result.token_count,
                    "history_budget": history_result.budget,
                    "turn_id": turn_id,
                    "question_followup_context": followup_question_context or {},
                    "notebook_references": notebook_references,
                    "history_references": history_references,
                    "question_notebook_references": question_notebook_references,
                    "book_references": book_references,
                    "book_context": book_context,
                    "book_context_warnings": book_context_result.warnings,
                    "memory_references": memory_references,
                    "question_bank_context": question_bank_context,
                    "memory_context": memory_context,
                    "active_persona": active_persona,
                    "recovery_attempt": recovery_attempt,
                    "llm_selection": payload.get("llm_selection") or {},
                    "learning_context": trusted_learning_context,
                    "learning_guidance": learning_guidance,
                    "llm_model": str(getattr(llm_config, "model", "") or ""),
                    "llm_provider": str(getattr(llm_config, "provider_name", "") or ""),
                    # Per-turn full-text payload for read_source. Empty when
                    # the manifest is empty (non-chat capabilities, or chat
                    # turns with no attached sources). Consumed by the chat
                    # pipeline's tool kwargs injector.
                    "source_index": source_index,
                    # Pause-resume hook: the agentic chat pipeline awaits
                    # this callable when ``ask_user`` (or any other
                    # ``pause_for_user``-emitting tool) pauses the loop.
                    # The callable resolves when the frontend POSTs a
                    # reply via the ``submit_user_reply`` WS message.
                    "wait_for_user_reply": _wait_for_user_reply,
                    "user_input_pause_event": user_input_pause_event,
                    "user_input_resume_event": user_input_resume_event,
                },
            )

            orch = ChatOrchestrator()
            pending_done_event: StreamEvent | None = None
            async for event in orch.handle(context):
                if event.type == StreamEventType.SESSION:
                    continue
                if event.type == StreamEventType.DONE:
                    pending_done_event = event
                    continue
                payload_event = await self._publish_live_event(execution, event)
                if payload_event.get("type") not in {"done", "session"}:
                    _stamp_ask_user_content_offset(payload_event, _persisted_answer())
                    assistant_events.append(payload_event)
                if _should_capture_assistant_content(event):
                    call_id = (event.metadata or {}).get("call_id")
                    content_segments.append((str(call_id) if call_id else None, event.content))
                narration_call_id = _narration_marker_call_id(event)
                if narration_call_id:
                    narration_call_ids.add(narration_call_id)
                for attachment in artifact_attachments(event):
                    if attachment["url"] not in seen_artifact_urls:
                        seen_artifact_urls.add(attachment["url"])
                        generated_attachments.append(attachment)

            # Office binaries the browser cannot render need their text pulled
            # out now, while the files are still on disk, or their preview card
            # opens empty. Skipped on the cancelled path below: that one is
            # already unwinding and must not start new blocking work.
            await fill_preview_text(generated_attachments)

            # The persisted answer is the captured content minus any narration
            # rounds (their text stayed in the trace, never the answer).
            assistant_content = _persisted_answer()

            # Assistant continues the same branch as the user message it
            # answers. If we just persisted a new user row we chain off
            # that; if we did not (regenerate path) and the caller pinned a
            # parent, we use it; otherwise we let the store auto-append
            # (legacy behavior).
            if new_user_message_id is not None:
                assistant_message_id = await self.store.add_message(
                    session_id=session_id,
                    role="assistant",
                    content=assistant_content,
                    capability=capability_name,
                    events=assistant_events,
                    attachments=generated_attachments or None,
                    parent_message_id=new_user_message_id,
                )
            elif branch_parent_explicit:
                assistant_message_id = await self.store.add_message(
                    session_id=session_id,
                    role="assistant",
                    content=assistant_content,
                    capability=capability_name,
                    events=assistant_events,
                    attachments=generated_attachments or None,
                    parent_message_id=branch_parent_id,
                )
            else:
                assistant_message_id = await self.store.add_message(
                    session_id=session_id,
                    role="assistant",
                    content=assistant_content,
                    capability=capability_name,
                    events=assistant_events,
                    attachments=generated_attachments or None,
                )
            await self._flush_buffered_events(execution)
            turn_status, turn_error = _resolve_turn_outcome(
                assistant_events,
                pending_done_event,
            )
            await self.store.update_turn_status(turn_id, turn_status, turn_error)
            if pending_done_event is None:
                pending_done_event = StreamEvent(
                    type=StreamEventType.DONE,
                    source=capability_name,
                    metadata={"status": turn_status},
                )
            else:
                pending_done_event.metadata = {
                    **pending_done_event.metadata,
                    "status": turn_status,
                }
            # Attach the persisted row ids so the frontend can reconcile its
            # optimistic (negative) message ids with a targeted in-place swap
            # instead of refetching and re-rendering the whole session.
            persisted_ids = {
                key: value
                for key, value in (
                    ("user_message_id", new_user_message_id),
                    ("assistant_message_id", assistant_message_id),
                )
                if value
            }
            if persisted_ids:
                pending_done_event.metadata = {**pending_done_event.metadata, **persisted_ids}
            learning_context = trusted_learning_context
            if (
                turn_status == "completed"
                and not is_regenerate
                and isinstance(learning_context, dict)
                and learning_context.get("project_id")
                and learning_context.get("task_id")
            ):
                try:
                    from cognivoy.learning.project_storage import LearningProjectStore

                    completion = await asyncio.to_thread(
                        LearningProjectStore().complete_task_from_turn,
                        str(learning_context["project_id"]),
                        str(learning_context["task_id"]),
                        session_id=session_id,
                    )
                    if completion is not None:
                        project, next_task = completion
                        completed_task = next(
                            (
                                item
                                for item in project.tasks
                                if item.id == str(learning_context["task_id"])
                            ),
                            None,
                        )
                        if memory_references:
                            await asyncio.to_thread(
                                LearningProjectStore().record_external_event,
                                project.id,
                                owner_id=current_user.id,
                                event_type="resource_activity",
                                title=(
                                    "学习记忆已用于本次任务"
                                    if str(payload.get("language", "en")).startswith("zh")
                                    else "Learning memory used for this task"
                                ),
                                description=(
                                    "本次讲解使用了你明确选择的长期记忆，并保留了可追溯引用。"
                                    if str(payload.get("language", "en")).startswith("zh")
                                    else "The turn used the long-term memory slots you explicitly selected."
                                ),
                                result_refs=[f"memory:{slot}" for slot in memory_references],
                                dedupe_key=(
                                    f"turn-memory:{session_id}:{learning_context['task_id']}:"
                                    + ",".join(memory_references)
                                ),
                            )
                        pending_done_event.metadata = {
                            **pending_done_event.metadata,
                            "learning_project_id": project.id,
                            "learning_task_completed": str(learning_context["task_id"]),
                            "next_learning_task_id": next_task.id if next_task else "",
                            "learning_result": (
                                {
                                    "project_id": project.id,
                                    "task_id": completed_task.id,
                                    "objective": completed_task.objective,
                                    "mastery_before": completed_task.mastery_before,
                                    "mastery_after": completed_task.mastery_after,
                                    "evidence_confidence": "high",
                                    "evidence_refs": completed_task.result_refs,
                                    "review_due_count": project.due_review_count,
                                    "next_review_at": project.next_review_at,
                                    "next_task": (
                                        {
                                            "id": next_task.id,
                                            "objective": next_task.objective,
                                        }
                                        if next_task
                                        else None
                                    ),
                                }
                                if completed_task is not None
                                else None
                            ),
                        }
                except Exception:
                    logger.error(
                        "Failed to update learning task after completed turn",
                        exc_info=True,
                    )
            await self._publish_live_event(execution, pending_done_event)
            stream_done_sent = True
            if not is_regenerate and turn_status == "completed":
                # Title generation is post-turn metadata. Keep it after DONE
                # so the composer and duration clock stop as soon as the
                # assistant answer is saved; the frontend keeps this socket
                # open briefly so the later ``session_meta`` title update can
                # still arrive.
                try:
                    await self._maybe_generate_session_title(
                        execution=execution,
                        session_id=session_id,
                        ui_language=str(payload.get("language", "en") or "en"),
                    )
                except Exception:
                    logger.debug("Failed to generate session title", exc_info=True)
        except asyncio.CancelledError:
            if not stream_done_sent:
                await self._publish_live_event(
                    execution,
                    StreamEvent(
                        type=StreamEventType.ERROR,
                        source=capability_name,
                        content="Turn cancelled",
                        metadata={"turn_terminal": True, "status": "cancelled"},
                    ),
                )
                await self._publish_live_event(
                    execution,
                    StreamEvent(
                        type=StreamEventType.DONE,
                        source=capability_name,
                        metadata={"status": "cancelled"},
                    ),
                )
            with contextlib.suppress(Exception):
                await self._flush_buffered_events(execution)
            # Best-effort: persist what the turn already produced (streamed
            # answer text, trace events, generated files) so cancelling a
            # turn does not erase visible work — files the model created are
            # on disk either way and must stay reachable. Shielded because
            # we are already unwinding a cancellation. Every step is
            # suppressed separately so the status update below always runs —
            # a turn left "running" gets mislabelled as a restart orphan.
            partial_content = _persisted_answer()
            if partial_content or generated_attachments or assistant_events:
                with contextlib.suppress(Exception):
                    await asyncio.shield(
                        self.store.add_message(
                            session_id=session_id,
                            role="assistant",
                            content=partial_content,
                            capability=capability_name,
                            events=assistant_events,
                            attachments=generated_attachments or None,
                        )
                    )
            with contextlib.suppress(Exception):
                await self.store.update_turn_status(turn_id, "cancelled", "Turn cancelled")
            raise
        except Exception as exc:
            trace_id = uuid4().hex
            safe_error = f"The task failed unexpectedly. Retry or share diagnostic {trace_id}."
            if stream_done_sent:
                logger.error(
                    "Post-stream persistence failed turn_id=%s trace_id=%s",
                    turn_id,
                    trace_id,
                    exc_info=True,
                )
                # Suppress each step separately: a flush failure must not
                # also skip the status update, or the turn stays "running"
                # forever and gets mislabelled as a server-restart orphan.
                with contextlib.suppress(Exception):
                    await self._flush_buffered_events(execution)
                with contextlib.suppress(Exception):
                    await self.store.update_turn_status(turn_id, "failed", safe_error)
            else:
                logger.error(
                    "Turn failed turn_id=%s trace_id=%s",
                    turn_id,
                    trace_id,
                    exc_info=True,
                )
                await self._publish_live_event(
                    execution,
                    StreamEvent(
                        type=StreamEventType.ERROR,
                        source=capability_name,
                        content=safe_error,
                        metadata={
                            "turn_terminal": True,
                            "status": "failed",
                            "code": "turn_failed",
                            "retryable": True,
                            "trace_id": trace_id,
                        },
                    ),
                )
                await self._publish_live_event(
                    execution,
                    StreamEvent(
                        type=StreamEventType.DONE,
                        source=capability_name,
                        metadata={"status": "failed", "trace_id": trace_id},
                    ),
                )
                with contextlib.suppress(Exception):
                    await self._flush_buffered_events(execution)
                partial_content = _persisted_answer()
                if partial_content or generated_attachments:
                    with contextlib.suppress(Exception):
                        await self.store.add_message(
                            session_id=session_id,
                            role="assistant",
                            content=partial_content,
                            capability=capability_name,
                            events=assistant_events,
                            attachments=generated_attachments or None,
                        )
                await self.store.update_turn_status(turn_id, "failed", safe_error)
        finally:
            if execution.recovery_lease_task is not None:
                execution.recovery_lease_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await execution.recovery_lease_task
            if llm_scope_token is not None and reset_active_llm_selection is not None:
                reset_active_llm_selection(llm_scope_token)
            # Drop the reply queue first — any in-flight ``submit_user_reply``
            # that finds the queue gone will return ``False`` rather than
            # accumulating on a dead turn.
            self._reply_queues.pop(turn_id, None)
            async with self._lock:
                current = self._executions.get(turn_id)
                if current is not None:
                    for subscriber in current.subscribers:
                        with contextlib.suppress(asyncio.QueueFull):
                            subscriber.queue.put_nowait(None)
                    self._executions.pop(turn_id, None)
            with contextlib.suppress(Exception):
                persisted_turn = await self.store.get_turn(turn_id)
                persisted_status = str((persisted_turn or {}).get("status") or "")
                if persisted_status in TERMINAL_TURN_STATUSES:
                    await asyncio.to_thread(
                        self.recovery_store.finish,
                        turn_id,
                        status=persisted_status,
                    )
                else:
                    await asyncio.to_thread(
                        self.recovery_store.release,
                        turn_id,
                        worker_id=self._worker_id,
                    )
            # A turn may have parsed large attachments or built substantial
            # temporary prompts/results. Reclaim after this coroutine returns,
            # outside the user-visible streaming path.
            from cognivoy.runtime.memory_reclaim import schedule_memory_reclaim

            schedule_memory_reclaim()

    async def _publish_live_event(
        self,
        execution: _TurnExecution,
        event: StreamEvent,
    ) -> dict[str, Any]:
        if event.type == StreamEventType.DONE and not event.metadata.get("status"):
            event.metadata = {**event.metadata, "status": "completed"}
        event.session_id = execution.session_id
        event.turn_id = execution.turn_id
        payload = event.to_dict()
        async with self._lock:
            current = self._executions.get(execution.turn_id, execution)
            seq = int(payload.get("seq") or 0)
            if seq <= 0:
                seq = current.next_seq
                current.next_seq += 1
                if current is not execution:
                    execution.next_seq = max(execution.next_seq, current.next_seq)
            else:
                current.next_seq = max(current.next_seq, seq + 1)
                execution.next_seq = max(execution.next_seq, seq + 1)
            payload["seq"] = seq
            current.events.append(payload)
            if current is not execution:
                execution.events.append(payload)
            subscribers = list(current.subscribers)
        for subscriber in subscribers:
            with contextlib.suppress(asyncio.QueueFull):
                subscriber.queue.put_nowait(payload)
        if (
            event.stage
            and event.type in {StreamEventType.STAGE_START, StreamEventType.STAGE_END}
            and (
                event.stage != execution.last_checkpoint_stage
                or event.type == StreamEventType.STAGE_END
            )
        ):
            execution.last_checkpoint_stage = event.stage
            checkpoint = {
                key: value
                for key, value in (event.metadata or {}).items()
                if key.endswith("checkpoint_id") or key in {"checkpoint_resumable"}
            }
            with contextlib.suppress(Exception):
                await asyncio.to_thread(
                    self.recovery_store.record_checkpoint,
                    execution.turn_id,
                    stage=event.stage,
                    checkpoint=checkpoint,
                )
        return payload

    async def _maybe_generate_session_title(
        self,
        *,
        execution: _TurnExecution,
        session_id: str,
        ui_language: str,
    ) -> None:
        """Generate a short LLM-written title for a freshly-named session.

        Runs only when the session still carries the ``New conversation``
        sentinel — once a user manually renames the chat (or this method
        has already filled in a title), it short-circuits. Uses the LLM
        scope already active on the calling task, which is the user's
        currently selected model.
        """
        if not session_id:
            return
        session = await self.store.get_session(session_id)
        if not session:
            return
        current_title = str(session.get("title") or "").strip()
        if current_title and current_title != "New conversation":
            return

        messages = await self.store.get_messages(session_id)
        first_user = ""
        first_assistant = ""
        for m in messages:
            role = str(m.get("role") or "")
            content = str(m.get("content") or "").strip()
            if not content:
                continue
            if role == "user" and not first_user:
                first_user = content
            elif role == "assistant" and not first_assistant:
                first_assistant = content
            if first_user and first_assistant:
                break
        if not first_user or not first_assistant:
            return

        title = ""
        try:
            from cognivoy.services.llm import stream as llm_stream

            zh = str(ui_language or "").lower().startswith("zh")
            if zh:
                sys_prompt = (
                    "你需要为一段对话生成一个简洁的标题。"
                    "直接输出标题文本，不要引号、不要 Markdown 格式、"
                    '不要末尾标点、不要 "标题：" 这类前缀。'
                    "标题控制在 4-10 个汉字以内。"
                )
                user_prompt = (
                    "请基于以下对话生成标题：\n\n"
                    f"[用户]\n{_clip_text(first_user, 800)}\n\n"
                    f"[助手]\n{_clip_text(first_assistant, 1500)}"
                )
            else:
                sys_prompt = (
                    "You generate a concise, descriptive title for a "
                    "conversation. Output only the title as plain text "
                    "— no quotes, no markdown, no trailing punctuation, "
                    'no "Title:" prefix. Keep it 4-8 words.'
                )
                user_prompt = (
                    "Generate a title for this conversation:\n\n"
                    f"[User]\n{_clip_text(first_user, 800)}\n\n"
                    f"[Assistant]\n{_clip_text(first_assistant, 1500)}"
                )

            async def _collect_title() -> str:
                buf: list[str] = []
                async for c in llm_stream(
                    prompt=user_prompt,
                    system_prompt=sys_prompt,
                    temperature=0.3,
                    max_tokens=80,
                ):
                    buf.append(c)
                return "".join(buf)

            raw_title = await asyncio.wait_for(_collect_title(), timeout=20.0)
            title = _sanitize_session_title(raw_title)
        except asyncio.TimeoutError:
            logger.debug("Title LLM call timed out — falling back")
        except Exception:
            logger.debug("Title LLM call failed", exc_info=True)

        if not title:
            # Fallback: truncate the first user message so the sidebar
            # doesn't sit on "New conversation" indefinitely when the
            # title model errors out.
            title = first_user[:50] + ("..." if len(first_user) > 50 else "")

        if not title:
            return

        try:
            await self.store.update_session_title(session_id, title)
        except Exception:
            logger.debug("update_session_title failed", exc_info=True)
            return

        await self._publish_live_event(
            execution,
            StreamEvent(
                type=StreamEventType.SESSION_META,
                source="turn_runtime",
                stage="title",
                content=title,
                metadata={"title": title, "session_id": session_id},
            ),
        )

    async def _flush_buffered_events(self, execution: _TurnExecution) -> None:
        """Persist buffered turn events after the live stream has already drained."""
        async with self._lock:
            if execution.events_flushed:
                return
            execution.events_flushed = True
            events = list(execution.events)

        # Prefer the store's batch append (single transaction) when available:
        # per-event commits fsync once per event, which on slow storage (NAS
        # spinning disks) stretches this flush — and the visible spinner — to
        # minutes for a long turn.
        append_batch = getattr(self.store, "append_turn_events", None)
        if callable(append_batch):
            try:
                persisted_batch = await append_batch(execution.turn_id, events)
            except ValueError as exc:
                # A turn can disappear when the session is deleted while the
                # turn task is draining post-stream persistence.
                if "Turn not found:" not in str(exc):
                    raise
                logger.warning(
                    "Skip persisting %d buffered event(s) for missing turn %s",
                    len(events),
                    execution.turn_id,
                )
                return
            await self._mirror_events_to_workspace(execution, persisted_batch)
            return

        persisted_events: list[dict[str, Any]] = []
        try:
            for index, payload in enumerate(events):
                try:
                    persisted = await self.store.append_turn_event(execution.turn_id, payload)
                except ValueError as exc:
                    # A turn can disappear when the session is deleted while the turn
                    # task is draining post-stream persistence. Avoid cascading
                    # failures. The turn will not come back, so drop the whole
                    # remaining batch with one summary line instead of logging once
                    # per buffered event.
                    if "Turn not found:" not in str(exc):
                        raise
                    logger.warning(
                        "Skip persisting %d buffered event(s) for missing turn %s (first: %s)",
                        len(events) - index,
                        execution.turn_id,
                        payload.get("type", ""),
                    )
                    break
                persisted_events.append(persisted)
        finally:
            # Mirror whatever actually persisted, even when the loop broke or
            # raised part-way — matches the previous per-event behaviour.
            await self._mirror_events_to_workspace(execution, persisted_events)

    async def _mirror_events_to_workspace(
        self, execution: _TurnExecution, payloads: list[dict[str, Any]]
    ) -> None:
        """Mirror turn events to the task-local ``events.jsonl`` under ``data/user/workspace``.

        One open/write for the whole batch, off the event loop: the previous
        per-event ``open()+append`` ran synchronously on the loop thread and
        stretched turn finalisation (and every other connection) on slow
        storage. ``to_thread`` copies contextvars, so the per-user path scope
        resolves the same as on the loop.
        """
        if not payloads:
            return
        await asyncio.to_thread(self._mirror_events_to_workspace_sync, execution, payloads)

    @staticmethod
    def _mirror_events_to_workspace_sync(
        execution: _TurnExecution, payloads: list[dict[str, Any]]
    ) -> None:
        try:
            path_service = get_path_service()
            task_dir = path_service.get_task_workspace(execution.capability, execution.turn_id)
            task_dir.mkdir(parents=True, exist_ok=True)
            event_file = task_dir / "events.jsonl"
            lines = "".join(
                json.dumps(payload, ensure_ascii=False, default=str) + "\n" for payload in payloads
            )
            with open(event_file, "a", encoding="utf-8") as f:
                f.write(lines)
        except Exception:
            logger.debug("Failed to mirror turn events to workspace", exc_info=True)


import threading

_runtime_lock = threading.Lock()
_runtime_instances: dict[str, TurnRuntimeManager] = {}


def get_turn_runtime_manager() -> TurnRuntimeManager:
    from cognivoy.services.session import get_session_store

    store = get_session_store()
    key = str(getattr(store, "db_path", id(store)))
    with _runtime_lock:
        if key not in _runtime_instances:
            _runtime_instances[key] = TurnRuntimeManager(store=store)
        return _runtime_instances[key]


__all__ = ["TurnRuntimeManager", "get_turn_runtime_manager"]
