"""
Unified session history API.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
from typing import Any
import uuid

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from cognivoy.multi_user.context import get_current_user
from cognivoy.services.session import get_session_store, get_sqlite_session_store
from cognivoy.services.storage.attachment_store import get_attachment_store

logger = logging.getLogger(__name__)

router = APIRouter()


class SessionRenameRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=100)


class BranchSelectionRequest(BaseModel):
    """Edit-branch picker state: `{parent_message_id: chosen_child_id}`.

    Stored inside the session preferences blob so it survives reloads
    without a dedicated column.
    """

    selected_branches: dict[str, int] = Field(default_factory=dict)


class QuizAnswerImageUpload(BaseModel):
    id: str = Field(default="", max_length=100)
    base64: str = ""
    url: str = Field(default="", max_length=2000)
    filename: str = Field(default="answer.png", max_length=255)
    mime_type: str = Field(default="image/png", max_length=100)


class QuizResultItem(BaseModel):
    question_id: str = ""
    question: str = Field(..., min_length=1)
    question_type: str = ""
    options: dict[str, str] | None = None
    user_answer: str = ""
    correct_answer: str = ""
    explanation: str | None = ""
    difficulty: str | None = ""
    knowledge_points: list[str] = Field(default_factory=list)
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    rubric: dict[str, Any] = Field(default_factory=dict)
    user_answer_images: list[QuizAnswerImageUpload] = Field(default_factory=list, max_length=4)
    is_correct: bool
    error_type: str = Field(default="", max_length=40)
    diagnostic_reason: str = Field(default="", max_length=1000)
    was_guess: bool = False

    @field_validator("options", mode="before")
    @classmethod
    def _coerce_options(cls, v):
        return v if isinstance(v, dict) else {}

    @field_validator("explanation", "difficulty", mode="before")
    @classmethod
    def _coerce_str(cls, v):
        return v if isinstance(v, str) else ""


class QuizResultsRequest(BaseModel):
    answers: list[QuizResultItem] = Field(default_factory=list)
    turn_id: str = ""
    submission_id: str = Field(default="", max_length=200)


def _learning_context_from_messages(messages: list[dict[str, Any]]) -> dict[str, str]:
    """Return the newest durable learning-project context in a session."""

    for message in reversed(messages):
        metadata = message.get("metadata") if isinstance(message, dict) else None
        snapshot = metadata.get("request_snapshot") if isinstance(metadata, dict) else None
        context = snapshot.get("learningContext") if isinstance(snapshot, dict) else None
        if not isinstance(context, dict):
            continue
        project_id = str(context.get("project_id") or "").strip()
        task_id = str(context.get("task_id") or "").strip()
        if project_id:
            return {"project_id": project_id, "task_id": task_id}
    return {}


async def _materialize_quiz_answer_images(
    session_id: str, images: list[QuizAnswerImageUpload]
) -> list[dict[str, str]]:
    """Persist browser image payloads and return lightweight references."""
    attachment_store = get_attachment_store()
    records: list[dict[str, str]] = []
    for image in images:
        record_id = (image.id or uuid.uuid4().hex[:12]).strip()
        filename = (image.filename or "answer.png").strip() or "answer.png"
        mime_type = (image.mime_type or "image/png").strip() or "image/png"
        if not mime_type.startswith("image/"):
            raise HTTPException(status_code=400, detail="Quiz answer attachments must be images")
        url = image.url.strip()
        if not url and image.base64:
            try:
                raw_bytes = base64.b64decode(image.base64, validate=True)
            except Exception as exc:
                raise HTTPException(status_code=400, detail="Invalid answer image") from exc
            if len(raw_bytes) > 5 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="Answer image exceeds 5 MB")
            url = await attachment_store.put(
                session_id=session_id,
                attachment_id=record_id,
                filename=filename,
                data=raw_bytes,
                mime_type=mime_type,
            )
        if url:
            records.append(
                {
                    "id": record_id,
                    "url": url,
                    "filename": filename,
                    "mime_type": mime_type,
                }
            )
    return records


def _format_quiz_results_message(answers: list[QuizResultItem]) -> str:
    total = len(answers)
    correct = sum(1 for item in answers if item.is_correct)
    score_pct = round((correct / total) * 100) if total else 0
    lines = ["[Quiz Performance]"]
    for idx, item in enumerate(answers, 1):
        question = item.question.strip().replace("\n", " ")
        user_answer = (item.user_answer or "").strip() or "(blank)"
        status = "Correct" if item.is_correct else "Incorrect"
        suffix = f" ({status})"
        if not item.is_correct and (item.correct_answer or "").strip():
            suffix = f" ({status}, correct: {(item.correct_answer or '').strip()})"
        qid = f"[{item.question_id}] " if item.question_id else ""
        lines.append(f"{idx}. {qid}Q: {question} -> Answered: {user_answer}{suffix}")
    lines.append(f"Score: {correct}/{total} ({score_pct}%)")
    return "\n".join(lines)


@router.get("")
async def list_sessions(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    q: str = Query(default="", max_length=100),
    capability: str = Query(default="", max_length=64),
    updated_from: float | None = Query(default=None, ge=0),
    updated_to: float | None = Query(default=None, ge=0),
):
    if updated_from is not None and updated_to is not None and updated_from > updated_to:
        raise HTTPException(
            status_code=422,
            detail="updated_from must be less than or equal to updated_to",
        )
    store = get_session_store()
    needle = q.strip().casefold()
    capability_filter = capability.strip()
    if not (needle or capability_filter or updated_from is not None or updated_to is not None):
        sessions = await store.list_sessions(limit=limit, offset=offset)
        return {"sessions": sessions}

    def matches(session: dict[str, Any]) -> bool:
        if (
            needle
            and needle
            not in " ".join(
                [
                    str(session.get("title", "") or ""),
                    str(session.get("last_message", "") or ""),
                ]
            ).casefold()
        ):
            return False
        preferences = session.get("preferences")
        if not isinstance(preferences, dict):
            preferences = {}
        actual_capability = str(
            preferences.get("capability") or session.get("capability") or "chat"
        )
        if capability_filter and actual_capability != capability_filter:
            return False
        updated_at = float(session.get("updated_at", 0) or 0)
        if updated_from is not None and updated_at < updated_from:
            return False
        if updated_to is not None and updated_at > updated_to:
            return False
        return True

    # Stores expose the same paginated contract but use different backends.
    # Scan sorted pages and apply filters before the caller's offset, stopping
    # as soon as the requested filtered window is complete.
    sessions = []
    scan_offset = 0
    batch_size = 200
    target = offset + limit
    while len(sessions) < target:
        batch = await store.list_sessions(limit=batch_size, offset=scan_offset)
        if not batch:
            break
        sessions.extend(session for session in batch if matches(session))
        scan_offset += len(batch)
        if len(batch) < batch_size:
            break
    sessions = sessions[offset:target]
    return {"sessions": sessions}


@router.get("/stats")
async def get_session_stats():
    """Return an authoritative native-chat count and latest activity."""
    store = get_session_store()
    recent = await store.list_sessions(limit=1, offset=0)
    return {
        "total": await store.count_sessions(),
        "updated_at": recent[0].get("updated_at") if recent else None,
    }


# Cap (in characters) for a single event payload returned to the UI. RAG
# tools can attach whole KB documents to ``tool_result``/``observation``
# events; the frontend TraceSurface only needs a preview, and the LLM context
# is built from a separate content-only store, so capping here never affects
# model input.
MAX_EVENT_PAYLOAD = 1024 * 1024
_TRUNCATION_NOTICE = "\n\n[... content truncated]"
_TRUNCATABLE_EVENT_TYPES = ("tool_result", "observation")


def _truncate_oversized_events(
    messages: list[dict[str, Any]], limit: int = MAX_EVENT_PAYLOAD
) -> None:
    """Cap oversized ``tool_result``/``observation`` payloads in place.

    The session store already returns each message's events as a parsed
    ``events`` list (see ``SqliteSessionStore._serialize_message``), so we
    mutate that list directly. Only the UI rendering path is affected.
    """

    def _cap(container: dict[str, Any], field: str) -> bool:
        value = container.get(field)
        if isinstance(value, str) and len(value) > limit:
            container[field] = value[:limit] + _TRUNCATION_NOTICE
            return True
        return False

    for msg in messages:
        events = msg.get("events")
        if not isinstance(events, list):
            continue
        for event in events:
            if not isinstance(event, dict) or event.get("type") not in _TRUNCATABLE_EVENT_TYPES:
                continue
            truncated = _cap(event, "content")
            tool_metadata = (event.get("metadata") or {}).get("tool_metadata")
            if isinstance(tool_metadata, dict):
                for field in ("content", "answer"):
                    truncated = _cap(tool_metadata, field) or truncated
            if truncated:
                event["_truncated"] = True


@router.get("/{session_id}")
async def get_session(session_id: str):
    store = get_session_store()
    session = await store.get_session_with_messages(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    _truncate_oversized_events(session.get("messages", []))
    return session


@router.patch("/{session_id}")
async def rename_session(session_id: str, payload: SessionRenameRequest):
    store = get_session_store()
    updated = await store.update_session_title(session_id, payload.title)
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    session = await store.get_session(session_id)
    return {"session": session}


@router.delete("/{session_id}")
async def delete_session(session_id: str):
    store = get_session_store()
    deleted = await store.delete_session(session_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Session not found")
    try:
        await get_attachment_store().delete_session(session_id)
    except Exception:
        logger.exception("failed to clean up attachments for session %s", session_id)
    return {"deleted": True, "session_id": session_id}


@router.put("/{session_id}/branch-selection")
async def update_branch_selection(session_id: str, payload: BranchSelectionRequest):
    store = get_sqlite_session_store()
    session = await store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    updated = await store.update_session_preferences(
        session_id, {"selected_branches": dict(payload.selected_branches)}
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"selected_branches": payload.selected_branches}


@router.delete("/{session_id}/messages/{message_id}")
async def delete_turn_by_message(session_id: str, message_id: int):
    store = get_sqlite_session_store()
    result = await store.delete_turn_by_message(session_id, message_id)
    if result["was_running"]:
        raise HTTPException(
            status_code=409, detail="Cannot delete a message while its turn is running"
        )
    if not result["deleted"]:
        raise HTTPException(status_code=404, detail="Message not found")
    attachment_store = get_attachment_store()
    for aid in result["attachment_ids"]:
        try:
            await attachment_store.delete_attachment(session_id, aid)
        except Exception:
            logger.exception("failed to delete attachment %s for session %s", aid, session_id)
    return result


@router.post("/{session_id}/quiz-results")
async def record_quiz_results(session_id: str, payload: QuizResultsRequest):
    if not payload.answers:
        raise HTTPException(status_code=400, detail="Quiz results are required")
    store = get_sqlite_session_store()
    session = await store.get_session(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    content = _format_quiz_results_message(payload.answers)
    # Retrying or editing an already-submitted quiz updates its notebook rows
    # but must not append another synthetic user message to chat history.
    # The turn-scoped key is authoritative because q_1..q_N repeat across
    # quizzes in the same session.
    first_question_id = payload.answers[0].question_id
    already_recorded = bool(
        await store.find_notebook_entry(
            session_id,
            first_question_id,
            payload.turn_id,
        )
    )
    submission_id = payload.submission_id.strip()
    if not submission_id:
        # Backward-compatible callers still receive retry idempotency: the
        # same turn and answer payload produce the same content hash. A real
        # redo changes the answer payload (new clients send an explicit UUID).
        digest = hashlib.sha256(
            payload.model_dump_json(exclude={"submission_id"}).encode("utf-8")
        ).hexdigest()[:24]
        submission_id = f"legacy-{digest}"
    attempt_ids = [
        f"{session_id}:{submission_id}:{item.question_id or index}"
        for index, item in enumerate(payload.answers, 1)
    ]
    duplicate_submission = bool(attempt_ids) and all(
        [await store.has_notebook_attempt(attempt_id) for attempt_id in attempt_ids]
    )
    learning_context = _learning_context_from_messages(await store.get_messages(session_id))
    learning_project = None
    if learning_context.get("project_id"):
        try:
            from cognivoy.learning.project_storage import LearningProjectStore

            candidate = LearningProjectStore().load(learning_context["project_id"])
            if candidate is not None and candidate.owner_id == get_current_user().id:
                learning_project = candidate
            else:
                learning_context = {}
        except Exception:
            logger.warning(
                "Failed to validate learning project context for session %s",
                session_id,
                exc_info=True,
            )
            learning_context = {}
    notebook_items: list[dict[str, Any]] = []
    for index, item in enumerate(payload.answers):
        stored_images: list[dict[str, str]]
        if duplicate_submission:
            existing = await store.find_notebook_entry(
                session_id,
                item.question_id,
                payload.turn_id,
            )
            stored_images = list((existing or {}).get("user_answer_images") or [])
        else:
            stored_images = await _materialize_quiz_answer_images(
                session_id, item.user_answer_images
            )
        notebook_item = item.model_dump(exclude={"user_answer_images"})
        notebook_item.update(
            {
                "user_answer_images": stored_images,
                "turn_id": payload.turn_id,
                "attempt_id": attempt_ids[index],
                "record_attempt": True,
                "learning_project_id": learning_context.get("project_id", ""),
                "learning_task_id": learning_context.get("task_id", ""),
            }
        )
        notebook_items.append(notebook_item)
    notebook_count = 0
    try:
        notebook_count = await store.upsert_notebook_entries(
            session_id,
            notebook_items,
        )
    except Exception:
        logger.warning(
            "Failed to upsert notebook entries for session %s", session_id, exc_info=True
        )
    if not already_recorded:
        await store.add_message(
            session_id=session_id,
            role="user",
            content=content,
            capability="deep_question",
        )
    proactive_job_ids: list[str] = []
    try:
        from cognivoy.services.partners.proactive_learning import (
            schedule_low_score_reviews,
        )

        proactive_job_ids = schedule_low_score_reviews(
            session_id=session_id,
            turn_id=payload.turn_id,
            answers=[item.model_dump() for item in payload.answers],
        )
    except Exception:
        logger.warning(
            "Failed to schedule proactive review for session %s",
            session_id,
            exc_info=True,
        )
    learning_project_updated = False
    if not duplicate_submission:
        try:
            from cognivoy.learning.project_storage import LearningProjectStore

            if learning_project is not None:
                project_store = LearningProjectStore()
                updated = await asyncio.to_thread(
                    project_store.record_quiz_attempt,
                    learning_project.id,
                    learning_context.get("task_id", ""),
                    session_id=session_id,
                    turn_id=payload.turn_id,
                    submission_id=submission_id,
                    answers=[item.model_dump() for item in payload.answers],
                )
                learning_project_updated = updated is not None
        except Exception:
            logger.warning(
                "Failed to project quiz evidence into a learning project for session %s",
                session_id,
                exc_info=True,
            )
    return {
        "recorded": True,
        "session_id": session_id,
        "answer_count": len(payload.answers),
        "notebook_count": notebook_count,
        "content": content,
        "history_message_created": not already_recorded,
        "duplicate_submission": duplicate_submission,
        "proactive_job_ids": proactive_job_ids,
        "learning_project_updated": learning_project_updated,
    }
