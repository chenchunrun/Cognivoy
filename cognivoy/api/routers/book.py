"""
Book Engine API Router
======================

REST + WebSocket endpoints for the ``BookEngine``. Phase 1 surface:
create / confirm / compile / read / delete + a per-book event stream.
"""

from __future__ import annotations

import asyncio
from html import escape
from pathlib import Path
import re
import time
from typing import Any, Literal
from urllib.parse import quote

from fastapi import APIRouter, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

from cognivoy.api.errors import internal_http_error
from cognivoy.book import (
    BlockType,
    BookProposal,
    Spine,
    get_book_engine,
)
from cognivoy.book.export import export_epub, export_markdown, safe_export_filename
from cognivoy.book.models import ContentType
from cognivoy.book.statistics import calculate_book_statistics
from cognivoy.book.streaming import SOURCE as BOOK_SOURCE
from cognivoy.core.stream import StreamEventType
from cognivoy.core.stream_bus import StreamBus
from cognivoy.logging.safe_logger import get_logger
from cognivoy.multi_user.context import get_current_user

router = APIRouter()
logger = get_logger(__name__)


def _book_internal_error(operation: str, exc: Exception) -> HTTPException:
    """Log full diagnostics while keeping provider/path details out of HTTP."""
    return internal_http_error(
        exc,
        operation=f"book.{operation}",
        message="Book operation failed.",
    )


def _record_project_book_quiz_activity(req: "QuizAttemptRequest", progress: Any) -> None:
    """Best-effort projection of book practice into linked projects."""

    try:
        from cognivoy.learning.project_storage import LearningProjectStore

        attempt_number = len(progress.quiz_attempts)
        LearningProjectStore().record_linked_resource_activity(
            owner_id=get_current_user().id,
            resource_type="book",
            resource_ids=[req.book_id],
            title="Book practice completed",
            description=(
                "Correct answer recorded in a linked book."
                if req.is_correct
                else "An incorrect answer was recorded for follow-up practice."
            ),
            result_refs=[
                f"book:{req.book_id}",
                f"book-quiz:{req.book_id}:{req.page_id}:{req.block_id}:{req.question_id}",
            ],
            dedupe_key=f"quiz-attempt:{req.book_id}:{attempt_number}",
        )
    except Exception:
        # Book progress is authoritative. Project evidence is a best-effort
        # cross-module projection and must not break the quiz interaction.
        logger.warning("Failed to record linked book activity", exc_info=True)


# ─────────────────────────────────────────────────────────────────────────────
# Request / response models
# ─────────────────────────────────────────────────────────────────────────────


class CreateBookRequest(BaseModel):
    user_intent: str = Field(default="")
    chat_session_id: str = Field(default="")
    chat_selections: list[dict[str, Any]] = Field(default_factory=list)
    notebook_refs: list[dict[str, Any]] = Field(default_factory=list)
    knowledge_bases: list[str] = Field(default_factory=list)
    question_categories: list[int] = Field(default_factory=list)
    question_entries: list[int] = Field(default_factory=list)
    language: str = Field(default="en")


class ConfirmProposalRequest(BaseModel):
    book_id: str
    proposal: dict[str, Any] | None = None  # full edited BookProposal payload


class ConfirmSpineRequest(BaseModel):
    book_id: str
    spine: dict[str, Any] | None = None
    auto_compile: bool = True


class CompilePageRequest(BaseModel):
    book_id: str
    page_id: str
    force: bool = False


class RecordPageVisitRequest(BaseModel):
    book_id: str
    page_id: str


class RegenerateBlockRequest(BaseModel):
    book_id: str
    page_id: str
    block_id: str
    params_override: dict[str, Any] | None = None


class InsertBlockRequest(BaseModel):
    book_id: str
    page_id: str
    block_type: str
    params: dict[str, Any] | None = None
    position: int | None = None
    compile_now: bool = True


class DeleteBlockRequest(BaseModel):
    book_id: str
    page_id: str
    block_id: str


class MoveBlockRequest(BaseModel):
    book_id: str
    page_id: str
    block_id: str
    new_position: int


class ChangeBlockTypeRequest(BaseModel):
    book_id: str
    page_id: str
    block_id: str
    new_type: str
    params_override: dict[str, Any] | None = None


class DeepDiveRequest(BaseModel):
    book_id: str
    parent_page_id: str
    topic: str
    block_id: str | None = None
    content_type: str = "concept"


class QuizAttemptRequest(BaseModel):
    book_id: str
    page_id: str
    block_id: str
    question_id: str = ""
    user_answer: str = ""
    is_correct: bool = False
    request_remediation: bool = False


class SupplementRequest(BaseModel):
    book_id: str
    page_id: str
    topic: str


class PageChatSessionRequest(BaseModel):
    book_id: str
    page_id: str
    session_id: str


class RebuildBookRequest(BaseModel):
    book_id: str
    auto_compile: bool = True


class GenerateCoverRequest(BaseModel):
    theme: str = Field(default="editorial", max_length=40)
    accent: str = Field(default="#c65d32", pattern=r"^#[0-9a-fA-F]{6}$")


class RestorePageRevisionRequest(BaseModel):
    revision_id: str = Field(min_length=1, max_length=80)


class StageReviewRequest(BaseModel):
    stage: Literal["outline", "proofread"]
    decision: Literal["draft", "approved", "changes_requested"] = "draft"
    notes: str = Field(default="", max_length=2_000)
    expected_revision: int = Field(default=0, ge=0)


def _proofread_snapshot(engine: Any, book_id: str) -> dict[str, Any]:
    pages = engine.list_pages(book_id)
    issues: list[dict[str, Any]] = []
    source_anchor_count = 0
    block_count = 0
    for page in pages:
        status = page.status.value if hasattr(page.status, "value") else str(page.status)
        if status in {"error", "partial"}:
            issues.append(
                {
                    "severity": "error" if status == "error" else "warning",
                    "code": f"page_{status}",
                    "page_id": page.id,
                    "page_title": page.title,
                    "message": f"Page status is {status}.",
                }
            )
        if not page.blocks:
            issues.append(
                {
                    "severity": "warning",
                    "code": "page_empty",
                    "page_id": page.id,
                    "page_title": page.title,
                    "message": "Page has no content blocks.",
                }
            )
        for block in page.blocks:
            block_count += 1
            source_anchor_count += len(block.source_anchors)
            block_status = (
                block.status.value if hasattr(block.status, "value") else str(block.status)
            )
            if block_status == "error" or block.error:
                issues.append(
                    {
                        "severity": "error",
                        "code": "block_failed",
                        "page_id": page.id,
                        "page_title": page.title,
                        "block_id": block.id,
                        "message": block.error or "Block generation failed.",
                    }
                )
    if pages and source_anchor_count == 0:
        issues.append(
            {
                "severity": "info",
                "code": "sources_missing",
                "message": "No source anchors are recorded for the current edition.",
            }
        )
    return {
        "page_count": len(pages),
        "block_count": block_count,
        "source_anchor_count": source_anchor_count,
        "issue_count": len(issues),
        "error_count": sum(item["severity"] == "error" for item in issues),
        "warning_count": sum(item["severity"] == "warning" for item in issues),
        "issues": issues[:200],
    }


# ─────────────────────────────────────────────────────────────────────────────
# REST endpoints
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "healthy", "service": "book"}


@router.get("/books")
async def list_books(
    q: str = "",
    status: str = "all",
    sort: Literal["recent", "title", "progress", "reading_time"] = "recent",
    limit: int = 24,
    offset: int = 0,
) -> dict[str, Any]:
    """Return a bounded library page.

    The old endpoint calculated page-level statistics for every book before
    returning anything.  That made a cosmetic client-side paginator slower as
    the library grew.  Metadata filtering and the common recent/title sorts
    now happen first; expensive page statistics are loaded only for the
    requested page.  Progress/time sorting necessarily evaluates the matching
    set because those values are derived from page content.
    """
    engine = get_book_engine()
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))
    query = q.strip().casefold()
    candidates: list[Any] = []
    for listed_book in engine.list_books():
        migrated = await engine.ensure_legacy_overview(listed_book.id)
        book = engine.load_book(listed_book.id) if migrated else listed_book
        if book is None:  # pragma: no cover - concurrent deletion safety
            continue
        if (
            status != "all"
            and str(book.status.value if hasattr(book.status, "value") else book.status) != status
        ):
            continue
        if query and query not in f"{book.title} {book.description}".casefold():
            continue
        candidates.append(book)

    statistics_by_id: dict[str, dict[str, Any] | None] = {}

    def statistics_for(book: Any) -> dict[str, Any] | None:
        if book.id in statistics_by_id:
            return statistics_by_id[book.id]
        try:
            value = calculate_book_statistics(
                pages=engine.list_pages(book.id),
                spine=engine.load_spine(book.id),
                progress=engine.load_progress(book.id),
            ).model_dump(mode="json")
        except Exception:  # pragma: no cover - storage corruption safety net
            logger.exception("Failed to calculate book statistics for %s", book.id)
            value = None
        statistics_by_id[book.id] = value
        return value

    if sort == "title":
        candidates.sort(key=lambda item: str(item.title or "").casefold())
    elif sort in {"progress", "reading_time"}:
        field = "reading_progress_percent" if sort == "progress" else "estimated_reading_minutes"
        candidates.sort(
            key=lambda item: (statistics_for(item) or {}).get(field, -1),
            reverse=True,
        )
    else:
        candidates.sort(key=lambda item: float(item.updated_at or 0), reverse=True)

    total = len(candidates)
    summary = {
        "total": total,
        "ready": sum(
            1
            for item in candidates
            if str(item.status.value if hasattr(item.status, "value") else item.status) == "ready"
        ),
        "in_progress": sum(
            1
            for item in candidates
            if str(item.status.value if hasattr(item.status, "value") else item.status)
            in {"draft", "spine_ready", "compiling"}
        ),
        "chapters": sum(int(item.chapter_count or 0) for item in candidates),
    }
    page = candidates[offset : offset + limit]
    items: list[dict[str, Any]] = []
    for book in page:
        payload = book.model_dump(mode="json")
        payload["statistics"] = statistics_for(book)
        if payload["statistics"] is None:
            payload["statistics"] = None
            payload["statistics_error"] = True
        items.append(payload)
    return {
        "books": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "summary": summary,
    }


_COVER_MAX_BYTES = 8 * 1024 * 1024
_COVER_TYPES = {
    "image/png": ("png", lambda data: data.startswith(b"\x89PNG\r\n\x1a\n")),
    "image/jpeg": ("jpg", lambda data: data.startswith(b"\xff\xd8\xff")),
    "image/webp": (
        "webp",
        lambda data: len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP",
    ),
}


def _book_or_404(book_id: str):
    engine = get_book_engine()
    book = engine.load_book(book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return engine, book


def _cover_assets(engine: Any, book_id: str) -> Path:
    assets = Path(engine.storage.path_service.get_book_assets_dir(book_id))
    assets.mkdir(parents=True, exist_ok=True)
    return assets


def _persist_cover_metadata(engine: Any, book: Any, filename: str, mime: str) -> str:
    cover_url = f"/api/v1/book/books/{book.id}/cover"
    metadata = dict(book.metadata or {})
    metadata.update({"cover_url": cover_url, "cover_file": filename, "cover_mime": mime})
    book.metadata = metadata
    book.updated_at = time.time()
    engine.storage.save_book(book)
    return cover_url


@router.post("/books/{book_id}/cover/generate")
async def generate_book_cover(book_id: str, payload: GenerateCoverRequest) -> dict[str, str]:
    """Generate a reliable local SVG cover without depending on an image provider."""
    engine, book = _book_or_404(book_id)
    assets = _cover_assets(engine, book_id)
    accent = payload.accent.lower()
    title = escape((book.title or "Untitled book")[:100])
    description = escape((book.description or payload.theme or "Cognivoy")[:140])
    theme = escape(payload.theme[:40])
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600" viewBox="0 0 1200 1600">
<rect width="1200" height="1600" fill="#f7f2e8"/><rect x="72" y="72" width="1056" height="1456" rx="32" fill="none" stroke="{accent}" stroke-width="8"/>
<circle cx="960" cy="260" r="190" fill="{accent}" opacity=".16"/><path d="M72 1180 L1128 760 L1128 1528 L72 1528 Z" fill="{accent}" opacity=".1"/>
<text x="120" y="180" fill="{accent}" font-family="sans-serif" font-size="34" letter-spacing="8">COGNIVOY · {theme.upper()}</text>
<foreignObject x="120" y="430" width="920" height="520"><div xmlns="http://www.w3.org/1999/xhtml" style="font:700 92px/1.15 Georgia,serif;color:#28231d;overflow-wrap:anywhere">{title}</div></foreignObject>
<foreignObject x="120" y="1050" width="900" height="240"><div xmlns="http://www.w3.org/1999/xhtml" style="font:36px/1.45 sans-serif;color:#625a50">{description}</div></foreignObject>
<text x="120" y="1450" fill="#625a50" font-family="sans-serif" font-size="30">AI-authored learning book</text></svg>"""
    target = assets / "cover.svg"
    target.write_text(svg, encoding="utf-8")
    cover_url = _persist_cover_metadata(engine, book, target.name, "image/svg+xml")
    return {"cover_url": cover_url, "mime_type": "image/svg+xml", "source": "generated"}


@router.post("/books/{book_id}/cover/upload")
async def upload_book_cover(book_id: str, file: UploadFile = File(...)) -> dict[str, str]:
    engine, book = _book_or_404(book_id)
    mime = str(file.content_type or "").lower()
    spec = _COVER_TYPES.get(mime)
    if spec is None:
        raise HTTPException(status_code=415, detail="Cover must be a PNG, JPEG, or WebP image")
    data = await file.read(_COVER_MAX_BYTES + 1)
    if not data or len(data) > _COVER_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Cover image must be between 1 byte and 8 MB")
    extension, signature_ok = spec
    if not signature_ok(data):
        raise HTTPException(status_code=422, detail="Cover content does not match its image type")
    assets = _cover_assets(engine, book_id)
    target = assets / f"cover.{extension}"
    target.write_bytes(data)
    cover_url = _persist_cover_metadata(engine, book, target.name, mime)
    return {"cover_url": cover_url, "mime_type": mime, "source": "uploaded"}


@router.get("/books/{book_id}/cover")
async def serve_book_cover(book_id: str, download: bool = False):
    engine, book = _book_or_404(book_id)
    filename = str((book.metadata or {}).get("cover_file") or "")
    if not re.fullmatch(r"cover\.(?:svg|png|jpg|webp)", filename):
        raise HTTPException(status_code=404, detail="Book cover not found")
    target = _cover_assets(engine, book_id) / filename
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Book cover not found")
    return FileResponse(
        target,
        media_type=str((book.metadata or {}).get("cover_mime") or "application/octet-stream"),
        filename=filename,
        content_disposition_type="attachment" if download else "inline",
    )


@router.get("/books/{book_id}")
async def get_book(book_id: str) -> dict[str, Any]:
    engine = get_book_engine()
    book = engine.load_book(book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    if await engine.ensure_legacy_overview(book_id):
        book = engine.load_book(book_id) or book
    spine = engine.load_spine(book_id)
    pages = engine.list_pages(book_id)
    progress = engine.load_progress(book_id)
    try:
        statistics: dict[str, Any] | None = calculate_book_statistics(
            pages=pages,
            spine=spine,
            progress=progress,
        ).model_dump(mode="json")
    except Exception:  # pragma: no cover - storage corruption safety net
        logger.exception("Failed to calculate book statistics for %s", book_id)
        statistics = None
    return {
        "book": book.model_dump(mode="json"),
        "spine": spine.model_dump(mode="json") if spine else None,
        "pages": [p.model_dump(mode="json") for p in pages],
        "progress": progress.model_dump(mode="json"),
        "statistics": statistics,
    }


@router.get("/books/{book_id}/export")
async def export_book(
    book_id: str,
    format: Literal["markdown", "epub"] = "markdown",
) -> Response:
    """Download a portable edition without invoking a model or rebuild."""

    engine = get_book_engine()
    book = engine.load_book(book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    spine = engine.load_spine(book_id)
    pages = engine.list_pages(book_id)
    try:
        if format == "epub":
            content = export_epub(book, spine, pages)
            media_type = "application/epub+zip"
            filename = safe_export_filename(book.title, "epub")
        else:
            content = export_markdown(book, spine, pages).encode("utf-8")
            media_type = "text/markdown; charset=utf-8"
            filename = safe_export_filename(book.title, "md")
    except Exception as exc:
        raise _book_internal_error("export", exc) from exc
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename, safe='')}"},
    )


@router.get("/books/{book_id}/spine")
async def get_spine(book_id: str) -> dict[str, Any]:
    engine = get_book_engine()
    spine = engine.load_spine(book_id)
    if spine is None:
        raise HTTPException(status_code=404, detail="Spine not found")
    return {"spine": spine.model_dump(mode="json")}


@router.get("/books/{book_id}/stage-reviews")
async def list_stage_reviews(book_id: str) -> dict[str, Any]:
    engine = get_book_engine()
    if engine.load_book(book_id) is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return {"reviews": engine.storage.list_stage_reviews(book_id)}


@router.post("/books/{book_id}/stage-reviews")
async def create_stage_review(book_id: str, req: StageReviewRequest) -> dict[str, Any]:
    engine = get_book_engine()
    book = engine.load_book(book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    if req.stage == "outline":
        spine = engine.load_spine(book_id)
        if spine is None:
            raise HTTPException(status_code=409, detail="Book outline is not available yet")
        snapshot: dict[str, Any] = {
            "title": book.title,
            "chapter_count": len(spine.chapters),
            "page_count": sum(len(chapter.pages) for chapter in spine.chapters),
            "spine": spine.model_dump(mode="json"),
        }
    else:
        snapshot = _proofread_snapshot(engine, book_id)
    try:
        review = engine.storage.save_stage_review(
            book_id,
            stage=req.stage,
            decision=req.decision,
            snapshot=snapshot,
            notes=req.notes,
            expected_revision=req.expected_revision,
        )
    except RuntimeError as exc:
        if str(exc).startswith("stage_review_conflict:"):
            current = int(str(exc).rsplit(":", 1)[-1])
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "stage_review_conflict",
                    "message": "This review stage changed on another device.",
                    "current_revision": current,
                },
            ) from exc
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"review": review}


@router.get("/books/{book_id}/pages/{page_id}")
async def get_page(book_id: str, page_id: str) -> dict[str, Any]:
    engine = get_book_engine()
    page = engine.load_page(book_id, page_id)
    if page is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return {"page": page.model_dump(mode="json")}


@router.get("/books/{book_id}/pages/{page_id}/revisions")
async def list_page_revisions(book_id: str, page_id: str) -> dict[str, Any]:
    engine = get_book_engine()
    if engine.load_page(book_id, page_id) is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return {"revisions": engine.storage.list_page_revisions(book_id, page_id)}


@router.post("/books/{book_id}/pages/{page_id}/revisions/restore")
async def restore_page_revision(
    book_id: str,
    page_id: str,
    request: RestorePageRevisionRequest,
) -> dict[str, Any]:
    engine = get_book_engine()
    if engine.load_page(book_id, page_id) is None:
        raise HTTPException(status_code=404, detail="Page not found")
    try:
        page = engine.storage.restore_page_revision(book_id, page_id, request.revision_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"page": page.model_dump(mode="json"), "restored_revision_id": request.revision_id}


@router.delete("/books/{book_id}")
async def delete_book(book_id: str) -> dict[str, Any]:
    engine = get_book_engine()
    ok = engine.delete_book(book_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Book not found")
    return {"deleted": True, "book_id": book_id}


@router.post("/books")
async def create_book(req: CreateBookRequest) -> dict[str, Any]:
    """Stage 1: capture inputs + run IdeationAgent."""
    if not req.user_intent.strip():
        raise HTTPException(status_code=400, detail="user_intent is required")
    engine = get_book_engine()
    try:
        book, proposal = await engine.create_book(
            user_intent=req.user_intent,
            chat_session_id=req.chat_session_id,
            chat_selections=req.chat_selections,
            notebook_refs=req.notebook_refs,
            knowledge_bases=req.knowledge_bases,
            question_categories=req.question_categories,
            question_entries=req.question_entries,
            language=req.language,
        )
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("create_book", exc) from exc
    return {
        "book": book.model_dump(mode="json"),
        "proposal": proposal.model_dump(mode="json"),
    }


@router.post("/books/confirm-proposal")
async def confirm_proposal(req: ConfirmProposalRequest) -> dict[str, Any]:
    """Stage 2: user confirms (and possibly edits) the proposal → SpineAgent."""
    engine = get_book_engine()
    edited: BookProposal | None = None
    if req.proposal:
        try:
            edited = BookProposal.model_validate(req.proposal)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid proposal: {exc}")
    try:
        book, spine = await engine.confirm_proposal(book_id=req.book_id, edited_proposal=edited)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("confirm_proposal", exc) from exc
    return {
        "book": book.model_dump(mode="json"),
        "spine": spine.model_dump(mode="json"),
    }


@router.post("/books/confirm-spine")
async def confirm_spine(req: ConfirmSpineRequest) -> dict[str, Any]:
    """Stage 3: user confirms the spine → create pending page shells."""
    engine = get_book_engine()
    edited: Spine | None = None
    if req.spine:
        try:
            edited = Spine.model_validate(req.spine)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid spine: {exc}")
    try:
        pages = await engine.confirm_spine(
            book_id=req.book_id,
            edited_spine=edited,
            auto_compile=req.auto_compile,
        )
        confirmed_spine = engine.load_spine(req.book_id)
        if confirmed_spine is not None:
            reviews = engine.storage.list_stage_reviews(req.book_id)
            current_revision = max(
                (
                    int(item.get("revision") or 0)
                    for item in reviews
                    if item.get("stage") == "outline"
                ),
                default=0,
            )
            engine.storage.save_stage_review(
                req.book_id,
                stage="outline",
                decision="approved",
                notes="Outline confirmed before page generation.",
                snapshot={
                    "chapter_count": len(confirmed_spine.chapters),
                    "page_count": sum(len(chapter.pages) for chapter in confirmed_spine.chapters),
                    "spine": confirmed_spine.model_dump(mode="json"),
                },
                expected_revision=current_revision,
            )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("confirm_spine", exc) from exc
    return {"pages": [p.model_dump(mode="json") for p in pages]}


@router.post("/books/compile-page")
async def compile_page(req: CompilePageRequest) -> dict[str, Any]:
    """Drive the compiler for the page the user just opened (current-page priority)."""
    engine = get_book_engine()
    try:
        page = await engine.compile_page(book_id=req.book_id, page_id=req.page_id, force=req.force)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("compile_page", exc) from exc
    return {"page": page.model_dump(mode="json")}


@router.post("/books/regenerate-block")
async def regenerate_block(req: RegenerateBlockRequest) -> dict[str, Any]:
    engine = get_book_engine()
    try:
        block = await engine.regenerate_block(
            book_id=req.book_id,
            page_id=req.page_id,
            block_id=req.block_id,
            params_override=req.params_override,
        )
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("regenerate_block", exc) from exc
    if block is None:
        raise HTTPException(status_code=404, detail="Block not found")
    return {"block": block.model_dump(mode="json")}


def _coerce_block_type(name: str) -> BlockType:
    try:
        return BlockType(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown block type: {name}") from exc


def _coerce_content_type(name: str) -> ContentType:
    try:
        return ContentType(name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"Unknown content type: {name}") from exc


@router.post("/books/insert-block")
async def insert_block(req: InsertBlockRequest) -> dict[str, Any]:
    engine = get_book_engine()
    block_type = _coerce_block_type(req.block_type)
    try:
        block = await engine.insert_block(
            book_id=req.book_id,
            page_id=req.page_id,
            block_type=block_type,
            params=req.params,
            position=req.position,
            compile_now=req.compile_now,
        )
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("insert_block", exc) from exc
    if block is None:
        raise HTTPException(status_code=404, detail="Page or chapter not found")
    return {"block": block.model_dump(mode="json")}


@router.post("/books/delete-block")
async def delete_block(req: DeleteBlockRequest) -> dict[str, Any]:
    engine = get_book_engine()
    ok = await engine.delete_block(book_id=req.book_id, page_id=req.page_id, block_id=req.block_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Block not found")
    return {"ok": True}


@router.post("/books/move-block")
async def move_block(req: MoveBlockRequest) -> dict[str, Any]:
    engine = get_book_engine()
    ok = await engine.move_block(
        book_id=req.book_id,
        page_id=req.page_id,
        block_id=req.block_id,
        new_position=req.new_position,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Block not found")
    return {"ok": True}


@router.post("/books/change-block-type")
async def change_block_type(req: ChangeBlockTypeRequest) -> dict[str, Any]:
    engine = get_book_engine()
    new_type = _coerce_block_type(req.new_type)
    try:
        block = await engine.change_block_type(
            book_id=req.book_id,
            page_id=req.page_id,
            block_id=req.block_id,
            new_type=new_type,
            params_override=req.params_override,
        )
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("change_block_type", exc) from exc
    if block is None:
        raise HTTPException(status_code=404, detail="Block not found")
    return {"block": block.model_dump(mode="json")}


@router.post("/books/deep-dive")
async def deep_dive(req: DeepDiveRequest) -> dict[str, Any]:
    engine = get_book_engine()
    content_type = _coerce_content_type(req.content_type)
    try:
        page = await engine.create_deep_dive_subpage(
            book_id=req.book_id,
            parent_page_id=req.parent_page_id,
            topic=req.topic,
            block_id=req.block_id,
            content_type=content_type,
        )
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("deep_dive", exc) from exc
    if page is None:
        raise HTTPException(status_code=404, detail="Parent page not found")
    return {"page": page.model_dump(mode="json")}


@router.post("/books/quiz-attempt")
async def quiz_attempt(req: QuizAttemptRequest) -> dict[str, Any]:
    engine = get_book_engine()
    progress = await engine.record_quiz_attempt(
        book_id=req.book_id,
        page_id=req.page_id,
        block_id=req.block_id,
        question_id=req.question_id,
        user_answer=req.user_answer,
        is_correct=req.is_correct,
    )
    _record_project_book_quiz_activity(req, progress)
    return {"progress": progress.model_dump(mode="json")}


@router.post("/books/page-visit")
async def record_page_visit(req: RecordPageVisitRequest) -> dict[str, Any]:
    engine = get_book_engine()
    progress = engine.record_page_visit(req.book_id, req.page_id)
    if progress is None:
        raise HTTPException(status_code=404, detail="Book page not found")
    try:
        from cognivoy.learning.project_storage import LearningProjectStore

        LearningProjectStore().record_linked_resource_activity(
            owner_id=get_current_user().id,
            resource_type="book",
            resource_ids=[req.book_id],
            title="Book page read",
            description="Reading progress was updated in a linked book.",
            result_refs=[f"book:{req.book_id}", f"book-page:{req.book_id}:{req.page_id}"],
            dedupe_key=f"page-visit:{req.book_id}:{req.page_id}",
        )
    except Exception:
        logger.warning("Failed to record linked book page activity", exc_info=True)
    return {"progress": progress.model_dump(mode="json")}


@router.get("/books/{book_id}/health")
async def book_health(book_id: str) -> dict[str, Any]:
    engine = get_book_engine()
    drift = engine.kb_drift_report(book_id)
    log = engine.log_health(book_id)
    return {"kb_drift": drift, "log_health": log}


@router.post("/books/{book_id}/refresh-fingerprints")
async def refresh_fingerprints(book_id: str) -> dict[str, Any]:
    engine = get_book_engine()
    result = engine.refresh_kb_fingerprints(book_id)
    if result is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return result


@router.post("/books/supplement")
async def supplement(req: SupplementRequest) -> dict[str, Any]:
    engine = get_book_engine()
    try:
        block = await engine.supplement_for_weakness(
            book_id=req.book_id,
            page_id=req.page_id,
            topic=req.topic,
        )
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("supplement", exc) from exc
    if block is None:
        raise HTTPException(status_code=404, detail="Page not found")
    return {"block": block.model_dump(mode="json")}


@router.post("/books/page-chat-session")
async def set_page_chat_session(req: PageChatSessionRequest) -> dict[str, Any]:
    engine = get_book_engine()
    book = engine.set_page_chat_session(
        book_id=req.book_id,
        page_id=req.page_id,
        session_id=req.session_id,
    )
    if book is None:
        raise HTTPException(status_code=404, detail="Book or page not found")
    return {"book": book.model_dump(mode="json")}


@router.post("/books/rebuild")
async def rebuild_book(req: RebuildBookRequest) -> dict[str, Any]:
    engine = get_book_engine()
    try:
        pages = await engine.rebuild_book(book_id=req.book_id, auto_compile=req.auto_compile)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise _book_internal_error("rebuild_book", exc) from exc
    return {"pages": [p.model_dump(mode="json") for p in pages]}


@router.post("/books/rebuild-preview")
async def preview_rebuild_book(req: RebuildBookRequest) -> dict[str, Any]:
    """Describe rebuild impact without mutating the book."""
    engine = get_book_engine()
    try:
        return engine.preview_rebuild(req.book_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# WebSocket – streamed Book events
# ─────────────────────────────────────────────────────────────────────────────


def _serialize_event(event) -> dict[str, Any]:
    return {
        "type": event.type.value if hasattr(event.type, "value") else str(event.type),
        "source": event.source,
        "stage": event.stage,
        "content": event.content,
        "metadata": event.metadata or {},
    }


@router.websocket("/ws")
async def book_websocket(ws: WebSocket) -> None:
    """Streaming endpoint.

    Client message protocol::

        {"type": "create",          ...CreateBookRequest fields}
        {"type": "confirm_proposal", "book_id": "...", "proposal": {...}}
        {"type": "confirm_spine",    "book_id": "...", "spine": {...}, "auto_compile": true}
        {"type": "compile_page",     "book_id": "...", "page_id": "..."}
        {"type": "regenerate_block", "book_id": "...", "page_id": "...", "block_id": "...", "params_override": {}}
    """
    from cognivoy.api.routers.auth import ws_auth_failed, ws_require_auth
    from cognivoy.multi_user.context import reset_current_user

    user_token = await ws_require_auth(ws)
    if user_token is ws_auth_failed:
        return

    await ws.accept()
    closed = False

    async def send(data: dict[str, Any]) -> None:
        nonlocal closed
        if closed:
            return
        try:
            await ws.send_json(data)
        except Exception:
            closed = True

    async def stream_into_socket(bus: StreamBus) -> asyncio.Task:
        async def _forward() -> None:
            async for event in bus.subscribe():
                if event.source != BOOK_SOURCE:
                    continue
                await send(_serialize_event(event))
                if event.type == StreamEventType.STAGE_END and event.stage in {
                    "ideation",
                    "spine",
                    "compilation",
                }:
                    pass  # keep streaming – multiple stages per task

        return asyncio.create_task(_forward())

    try:
        engine = get_book_engine()
        while not closed:
            try:
                data = await ws.receive_json()
            except WebSocketDisconnect:
                break
            except Exception as exc:
                await send({"type": "error", "content": f"Bad message: {exc}"})
                continue

            msg_type = str(data.get("type") or "").strip()
            if not msg_type:
                await send({"type": "error", "content": "Missing 'type' field"})
                continue

            bus = StreamBus()
            forward_task = await stream_into_socket(bus)

            try:
                if msg_type == "create":
                    book, proposal = await engine.create_book(
                        user_intent=str(data.get("user_intent") or ""),
                        chat_session_id=str(data.get("chat_session_id") or ""),
                        chat_selections=data.get("chat_selections") or [],
                        notebook_refs=data.get("notebook_refs") or [],
                        knowledge_bases=data.get("knowledge_bases") or [],
                        question_categories=[
                            int(c) for c in (data.get("question_categories") or [])
                        ],
                        question_entries=[int(e) for e in (data.get("question_entries") or [])],
                        language=str(data.get("language") or "en"),
                        stream=bus,
                    )
                    await send(
                        {
                            "type": "create_result",
                            "book": book.model_dump(mode="json"),
                            "proposal": proposal.model_dump(mode="json"),
                        }
                    )

                elif msg_type == "confirm_proposal":
                    edited: BookProposal | None = None
                    if data.get("proposal"):
                        edited = BookProposal.model_validate(data["proposal"])
                    book, spine = await engine.confirm_proposal(
                        book_id=str(data.get("book_id") or ""),
                        edited_proposal=edited,
                        stream=bus,
                    )
                    await send(
                        {
                            "type": "confirm_proposal_result",
                            "book": book.model_dump(mode="json"),
                            "spine": spine.model_dump(mode="json"),
                        }
                    )

                elif msg_type == "confirm_spine":
                    edited_spine: Spine | None = None
                    if data.get("spine"):
                        edited_spine = Spine.model_validate(data["spine"])
                    pages = await engine.confirm_spine(
                        book_id=str(data.get("book_id") or ""),
                        edited_spine=edited_spine,
                        auto_compile=bool(data.get("auto_compile", True)),
                        stream=bus,
                    )
                    await send(
                        {
                            "type": "confirm_spine_result",
                            "pages": [p.model_dump(mode="json") for p in pages],
                        }
                    )

                elif msg_type == "compile_page":
                    page = await engine.compile_page(
                        book_id=str(data.get("book_id") or ""),
                        page_id=str(data.get("page_id") or ""),
                        stream=bus,
                        force=bool(data.get("force", False)),
                    )
                    await send(
                        {
                            "type": "compile_page_result",
                            "page": page.model_dump(mode="json"),
                        }
                    )

                elif msg_type == "regenerate_block":
                    block = await engine.regenerate_block(
                        book_id=str(data.get("book_id") or ""),
                        page_id=str(data.get("page_id") or ""),
                        block_id=str(data.get("block_id") or ""),
                        params_override=data.get("params_override"),
                        stream=bus,
                    )
                    await send(
                        {
                            "type": "regenerate_block_result",
                            "block": block.model_dump(mode="json") if block else None,
                        }
                    )

                else:
                    await send({"type": "error", "content": f"Unknown message type: {msg_type}"})

            except Exception as exc:
                logger.error(f"book ws action {msg_type} failed: {exc}", exc_info=True)
                await send({"type": "error", "content": str(exc)})
            finally:
                await bus.close()
                forward_task.cancel()
                try:
                    await forward_task
                except (asyncio.CancelledError, Exception):
                    pass

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.error(f"Book WS connection error: {exc}", exc_info=True)
    finally:
        closed = True
        try:
            await ws.close()
        except Exception:
            pass
        if user_token is not None:
            try:
                reset_current_user(user_token)
            except Exception:
                pass
