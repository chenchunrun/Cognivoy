"""
Question Notebook API — persists quiz questions, bookmarks, and categories.
"""

from __future__ import annotations

import base64 as _b64
import logging
from typing import Literal
import uuid as _uuid

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from cognivoy.api.errors import internal_http_error
from cognivoy.services.session import get_sqlite_session_store
from cognivoy.services.storage import get_attachment_store

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Models ────────────────────────────────────────────────────────


class AnswerImageItem(BaseModel):
    """Persisted reference to one image attached to a learner's answer.

    The bytes live in the AttachmentStore at ``url``; we never round-trip
    base64 back to the client so notebook lookups stay cheap.
    """

    id: str = ""
    url: str = ""
    filename: str = ""
    mime_type: str = ""


class NotebookEntryItem(BaseModel):
    id: int
    session_id: str
    session_title: str = ""
    turn_id: str = ""
    question_id: str = ""
    question: str
    question_type: str = ""
    options: dict[str, str] = {}
    correct_answer: str = ""
    explanation: str = ""
    difficulty: str = ""
    user_answer: str = ""
    user_answer_images: list[AnswerImageItem] = []
    is_correct: bool = False
    bookmarked: bool = False
    followup_session_id: str = ""
    ai_judgment: str = ""
    knowledge_points: list[str] = []
    source_refs: list[dict] = []
    rubric: dict = {}
    learning_project_id: str = ""
    learning_task_id: str = ""
    attempt_count: int = 0
    correct_streak: int = 0
    incorrect_streak: int = 0
    review_interval_days: int = 0
    review_due_at: float | None = None
    last_reviewed_at: float | None = None
    review_status: str = "new"
    recommended_difficulty: str = "medium"
    created_at: float
    updated_at: float
    categories: list[CategoryItem] | None = None


class NotebookEntryListResponse(BaseModel):
    items: list[NotebookEntryItem]
    total: int


class EntryUpdateRequest(BaseModel):
    bookmarked: bool | None = None
    followup_session_id: str | None = None
    ai_judgment: str | None = None


class CategoryItem(BaseModel):
    id: int
    name: str
    created_at: float = 0
    entry_count: int = 0


class CategoryCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)


class CategoryRenameRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)


class CategoryAddRequest(BaseModel):
    category_id: int


class AnswerImageUpload(BaseModel):
    """One image attached to the learner's answer.

    Either ``base64`` (new upload) or ``url`` (re-submit of an already
    persisted image) must be set. ``id`` is preserved when the client
    sends one so the same logical image keeps a stable AttachmentStore
    record across resubmissions.
    """

    id: str = ""
    base64: str = ""
    url: str = ""
    filename: str = "answer.png"
    mime_type: str = "image/png"


class UpsertEntryRequest(BaseModel):
    session_id: str
    turn_id: str = ""
    question_id: str
    question: str
    question_type: str = ""
    options: dict[str, str] | None = None
    correct_answer: str = ""
    explanation: str = ""
    difficulty: str = ""
    user_answer: str = ""
    # Optional: list of images attached as part of the learner's answer.
    # ``None`` means "don't touch any previously-stored images on update";
    # an empty list explicitly clears them.
    user_answer_images: list[AnswerImageUpload] | None = None
    is_correct: bool = False
    knowledge_points: list[str] | None = None
    source_refs: list[dict] | None = None
    rubric: dict | None = None
    learning_project_id: str = Field(default="", max_length=160)
    learning_task_id: str = Field(default="", max_length=160)


class AttemptEntryRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=20_000)
    attempt_id: str = Field(min_length=1, max_length=200)


# ── Entry endpoints ──────────────────────────────────────────────


async def _persist_answer_images(
    session_id: str, images: list[AnswerImageUpload] | None
) -> list[dict[str, str]] | None:
    """Materialise base64 image uploads into the AttachmentStore.

    Returns a list of ``{id, url, filename, mime_type}`` records suitable
    for ``notebook_entries.user_answer_images_json``. ``None`` is returned
    when ``images`` is ``None`` (no change to existing stored images).
    Records whose bytes fail to upload are dropped from the result with
    a warning — losing an image is better than failing the whole upsert.
    """
    if images is None:
        return None

    attachment_store = get_attachment_store()
    records: list[dict[str, str]] = []
    for image in images:
        record_id = (image.id or _uuid.uuid4().hex[:12]).strip()
        filename = (image.filename or "answer.png").strip() or "answer.png"
        mime_type = (image.mime_type or "image/png").strip() or "image/png"
        url = (image.url or "").strip()

        if not url and image.base64:
            try:
                raw_bytes = _b64.b64decode(image.base64, validate=False)
            except Exception as exc:
                logger.warning("answer image %s rejected: invalid base64 (%s)", filename, exc)
                continue
            try:
                url = await attachment_store.put(
                    session_id=session_id,
                    attachment_id=record_id,
                    filename=filename,
                    data=raw_bytes,
                    mime_type=mime_type,
                )
            except Exception as exc:
                logger.warning("attachment store rejected answer image %s: %s", filename, exc)
                continue

        if not url:
            # No url and no base64 — nothing usable.
            continue
        records.append(
            {
                "id": record_id,
                "url": url,
                "filename": filename,
                "mime_type": mime_type,
            }
        )
    return records


@router.post("/entries/upsert")
async def upsert_single_entry(payload: UpsertEntryRequest):
    store = get_sqlite_session_store()
    images_records = await _persist_answer_images(payload.session_id, payload.user_answer_images)
    item = payload.model_dump()
    # This endpoint also powers notebook edits. Editing an explanation or
    # answer is not a new learning attempt; quiz submissions use the
    # session-level endpoint which supplies an idempotent attempt id.
    item["record_attempt"] = False
    # The store expects ``user_answer_images`` as a plain list of dicts
    # (or absent to mean "leave the stored images alone"). Strip the
    # upload payload version and replace with the persisted records.
    item.pop("user_answer_images", None)
    if images_records is not None:
        item["user_answer_images"] = images_records
    try:
        await store.upsert_notebook_entries(payload.session_id, [item])
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    entry = await store.find_notebook_entry(
        payload.session_id, payload.question_id, turn_id=payload.turn_id
    )
    if entry is None:
        raise internal_http_error(
            RuntimeError("Notebook upsert completed without a readable entry"),
            operation="question_notebook.upsert",
        )
    return entry


@router.post("/entries/{entry_id}/attempt")
async def attempt_entry(entry_id: int, payload: AttemptEntryRequest):
    """Record a real learner attempt against an existing course question."""

    store = get_sqlite_session_store()
    entry = await store.get_notebook_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Notebook entry not found")
    options = entry.get("options") or {}
    submitted = payload.answer.strip()
    expected = str(entry.get("correct_answer") or "").strip()
    normalized_type = str(entry.get("question_type") or "").strip().lower()
    if normalized_type in {"choice", "mcq"}:
        option_by_text = {
            str(value).strip().casefold(): str(key).strip().upper()
            for key, value in options.items()
        }
        actual_value = option_by_text.get(submitted.casefold(), submitted.upper())
        expected_value = option_by_text.get(expected.casefold(), expected.upper())
        is_correct = actual_value == expected_value
    elif normalized_type in {"multiple_choice", "multiple-choice", "multi_select"}:

        def split(value: str) -> list[str]:
            return sorted(
                {
                    part.strip().upper()
                    for part in value.replace(";", ",").split(",")
                    if part.strip()
                }
            )

        is_correct = bool(split(submitted)) and split(submitted) == split(expected)
    else:
        is_correct = submitted.casefold() == expected.casefold()
    item = {
        **entry,
        "options": options,
        "user_answer": submitted,
        "is_correct": is_correct,
        "attempt_id": payload.attempt_id.strip(),
        "record_attempt": True,
    }
    item.pop("id", None)
    item.pop("categories", None)
    item.pop("session_title", None)
    await store.upsert_notebook_entries(str(entry["session_id"]), [item])
    updated = await store.get_notebook_entry(entry_id)
    if updated is None:
        raise internal_http_error(
            RuntimeError("Notebook attempt completed without a readable entry"),
            operation="question_notebook.attempt",
        )
    return updated


@router.get("/entries", response_model=NotebookEntryListResponse)
async def list_entries(
    category_id: int | None = Query(default=None),
    bookmarked: bool | None = Query(default=None),
    is_correct: bool | None = Query(default=None),
    q: str | None = Query(default=None, max_length=100),
    question_type: str | None = Query(default=None, max_length=50),
    difficulty: str | None = Query(default=None, max_length=50),
    source_type: str | None = Query(default=None, max_length=50),
    project_id: str | None = Query(default=None, max_length=160),
    task_id: str | None = Query(default=None, max_length=160),
    review_status: Literal["new", "due", "scheduled", "mastered"] | None = Query(default=None),
    updated_from: float | None = Query(default=None, ge=0),
    updated_to: float | None = Query(default=None, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> NotebookEntryListResponse:
    if updated_from is not None and updated_to is not None and updated_from > updated_to:
        raise HTTPException(status_code=422, detail="updated_from must not exceed updated_to")
    store = get_sqlite_session_store()
    result = await store.list_notebook_entries(
        category_id=category_id,
        bookmarked=bookmarked,
        is_correct=is_correct,
        query=q,
        question_type=question_type,
        difficulty=difficulty,
        source_type=source_type,
        learning_project_id=project_id,
        learning_task_id=task_id,
        review_status=review_status,
        updated_from=updated_from,
        updated_to=updated_to,
        limit=limit,
        offset=offset,
    )
    return NotebookEntryListResponse(
        items=[NotebookEntryItem(**item) for item in result["items"]],
        total=result["total"],
    )


@router.get("/statistics")
async def get_statistics(
    project_id: str | None = Query(default=None, max_length=160),
):
    store = get_sqlite_session_store()
    return await store.get_question_notebook_statistics(project_id)


@router.get("/adaptive-profile")
async def get_adaptive_profile():
    store = get_sqlite_session_store()
    return await store.get_question_adaptive_profile()


@router.get("/entries/lookup/by-question")
async def lookup_entry(
    session_id: str = Query(...),
    question_id: str = Query(...),
    turn_id: str | None = Query(default=None),
    missing_ok: bool = Query(
        default=False,
        description="Return 204 No Content instead of 404 when the entry is "
        "absent — used by the quiz viewer to probe not-yet-saved questions "
        "without logging noisy 404s.",
    ),
):
    store = get_sqlite_session_store()
    entry = await store.find_notebook_entry(session_id, question_id, turn_id=turn_id)
    if entry is None:
        if missing_ok:
            return Response(status_code=204)
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry


@router.get("/entries/{entry_id}", response_model=NotebookEntryItem)
async def get_entry(entry_id: int) -> NotebookEntryItem:
    store = get_sqlite_session_store()
    entry = await store.get_notebook_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    return NotebookEntryItem(**entry)


@router.patch("/entries/{entry_id}")
async def update_entry(entry_id: int, payload: EntryUpdateRequest):
    store = get_sqlite_session_store()
    updates = payload.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    updated = await store.update_notebook_entry(entry_id, updates)
    if not updated:
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"updated": True, "id": entry_id}


@router.delete("/entries/{entry_id}")
async def delete_entry(entry_id: int):
    store = get_sqlite_session_store()
    deleted = await store.delete_notebook_entry(entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Entry not found")
    return {"deleted": True, "id": entry_id}


# ── Entry ↔ Category linking ────────────────────────────────────


@router.post("/entries/{entry_id}/categories")
async def add_entry_to_category(entry_id: int, payload: CategoryAddRequest):
    store = get_sqlite_session_store()
    entry = await store.get_notebook_entry(entry_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    ok = await store.add_entry_to_category(entry_id, payload.category_id)
    if not ok:
        raise HTTPException(status_code=400, detail="Failed to add to category")
    return {"added": True, "entry_id": entry_id, "category_id": payload.category_id}


@router.delete("/entries/{entry_id}/categories/{category_id}")
async def remove_entry_from_category(entry_id: int, category_id: int):
    store = get_sqlite_session_store()
    removed = await store.remove_entry_from_category(entry_id, category_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Link not found")
    return {"removed": True, "entry_id": entry_id, "category_id": category_id}


# ── Category CRUD ────────────────────────────────────────────────


@router.get("/categories", response_model=list[CategoryItem])
async def list_categories():
    store = get_sqlite_session_store()
    return await store.list_categories()


@router.post("/categories", response_model=CategoryItem, status_code=201)
async def create_category(payload: CategoryCreateRequest):
    store = get_sqlite_session_store()
    try:
        return await store.create_category(payload.name)
    except Exception:
        raise HTTPException(status_code=409, detail="Category name already exists")


@router.patch("/categories/{category_id}")
async def rename_category(category_id: int, payload: CategoryRenameRequest):
    store = get_sqlite_session_store()
    updated = await store.rename_category(category_id, payload.name)
    if not updated:
        raise HTTPException(status_code=404, detail="Category not found")
    return {"updated": True, "id": category_id, "name": payload.name}


@router.delete("/categories/{category_id}")
async def delete_category(category_id: int):
    store = get_sqlite_session_store()
    deleted = await store.delete_category(category_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Category not found")
    return {"deleted": True, "id": category_id}
