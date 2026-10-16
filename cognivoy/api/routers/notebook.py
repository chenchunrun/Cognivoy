"""
Notebook API Router
Provides notebook creation, querying, updating, deletion, and record management functions
"""

import json
import logging
from typing import AsyncGenerator, Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from cognivoy.agents.notebook import NotebookSummarizeAgent
from cognivoy.api.errors import internal_http_error
from cognivoy.multi_user.context import get_current_user
from cognivoy.services.llm import clean_thinking_tags
from cognivoy.services.notebook import notebook_manager
from cognivoy.services.notebook.service import NotebookRevisionConflict

router = APIRouter()
logger = logging.getLogger(__name__)


def _record_project_notebook_activity(request: "AddRecordRequest", result: dict) -> None:
    """Best-effort projection of a saved note into linked learning projects."""

    try:
        from cognivoy.learning.project_storage import LearningProjectStore

        record = result.get("record") or {}
        record_id = str(record.get("id") or "").strip()
        if not record_id:
            return
        LearningProjectStore().record_linked_resource_activity(
            owner_id=get_current_user().id,
            resource_type="notebook",
            resource_ids=list(result.get("added_to_notebooks") or request.notebook_ids),
            title=request.title,
            description="Saved as reusable learning evidence in a linked notebook.",
            result_refs=[f"notebook-record:{record_id}"],
            dedupe_key=f"record:{record_id}",
        )
    except Exception:
        # The note is authoritative; a project timeline bridge must not make a
        # successful save appear to fail.
        logger.warning("Failed to record linked notebook activity", exc_info=True)


# === Request/Response Models ===


class CreateNotebookRequest(BaseModel):
    """Create notebook request"""

    name: str
    description: str = ""
    color: str = "#3B82F6"
    icon: str = "book"


class UpdateNotebookRequest(BaseModel):
    """Update notebook request"""

    name: str | None = None
    description: str | None = None
    color: str | None = None
    icon: str | None = None


class AddRecordRequest(BaseModel):
    """Add record request"""

    notebook_ids: list[str]
    record_type: Literal["solve", "question", "research", "chat", "co_writer", "tutorbot"]
    title: str
    summary: str = ""
    user_query: str
    output: str
    metadata: dict = Field(default_factory=dict)
    kb_name: str | None = None
    tags: list[str] = Field(default_factory=list, max_length=50)
    references: list[dict] = Field(default_factory=list, max_length=100)
    idempotency_key: str | None = Field(default=None, max_length=240)


class RemoveRecordRequest(BaseModel):
    """Remove record request"""

    record_id: str


class UpdateRecordRequest(BaseModel):
    """Update an existing notebook record."""

    title: str | None = None
    summary: str | None = None
    user_query: str | None = None
    output: str | None = None
    metadata: dict | None = None
    kb_name: str | None = None
    tags: list[str] | None = Field(default=None, max_length=50)
    references: list[dict] | None = Field(default=None, max_length=100)
    expected_revision: int | None = Field(default=None, ge=1)


class ImportMarkdownRequest(BaseModel):
    content: str = Field(min_length=1, max_length=5_000_000)
    mode: Literal["append", "replace"] = "append"
    title: str = Field(default="Imported note", max_length=500)
    idempotency_key: str | None = Field(default=None, max_length=240)


# === API Endpoints ===


async def _build_record_summary(request: AddRecordRequest) -> str:
    if request.summary.strip():
        return clean_thinking_tags(request.summary).strip()
    agent = NotebookSummarizeAgent(language=str(request.metadata.get("ui_language", "en")))
    return clean_thinking_tags(
        await agent.summarize(
            title=request.title,
            record_type=request.record_type,
            user_query=request.user_query,
            output=request.output,
            metadata=request.metadata,
        )
    ).strip()


async def _stream_add_record_with_summary(
    request: AddRecordRequest,
) -> AsyncGenerator[str, None]:
    try:
        agent = NotebookSummarizeAgent(language=str(request.metadata.get("ui_language", "en")))
        summary_parts: list[str] = []
        if request.summary.strip():
            summary = clean_thinking_tags(request.summary).strip()
            summary_parts.append(summary)
            if summary:
                yield f"data: {json.dumps({'type': 'summary_chunk', 'content': summary}, ensure_ascii=False)}\n\n"
        else:
            async for chunk in agent.stream_summary(
                title=request.title,
                record_type=request.record_type,
                user_query=request.user_query,
                output=request.output,
                metadata=request.metadata,
            ):
                if not chunk:
                    continue
                summary_parts.append(chunk)

            summary = clean_thinking_tags("".join(summary_parts)).strip()
            if summary:
                yield f"data: {json.dumps({'type': 'summary_chunk', 'content': summary}, ensure_ascii=False)}\n\n"

        summary = clean_thinking_tags("".join(summary_parts)).strip()
        result = notebook_manager.add_record(
            notebook_ids=request.notebook_ids,
            record_type=request.record_type,
            title=request.title,
            summary=summary,
            user_query=request.user_query,
            output=request.output,
            metadata=request.metadata,
            kb_name=request.kb_name,
            tags=request.tags,
            references=request.references,
            idempotency_key=request.idempotency_key,
        )
        _record_project_notebook_activity(request, result)
        payload = {
            "type": "result",
            "success": True,
            "summary": summary,
            "record": result["record"],
            "added_to_notebooks": result["added_to_notebooks"],
            "created": result["created"],
        }
        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
    except Exception as exc:
        internal_http_error(exc, operation="notebook.stream_summary")
        payload = {"type": "error", "detail": "Notebook summary failed."}
        yield f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


@router.get("/list")
async def list_notebooks():
    """
    Get all notebook list

    Returns:
        Notebook list (includes summary information)
    """
    try:
        notebooks = notebook_manager.list_notebooks()
        return {"notebooks": notebooks, "total": len(notebooks)}
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.get("/statistics")
async def get_statistics():
    """
    Get notebook statistics

    Returns:
        Statistics information
    """
    try:
        stats = notebook_manager.get_statistics()
        return stats
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.post("/create")
async def create_notebook(request: CreateNotebookRequest):
    """
    Create new notebook

    Args:
        request: Create request

    Returns:
        Created notebook information
    """
    try:
        notebook = notebook_manager.create_notebook(
            name=request.name,
            description=request.description,
            color=request.color,
            icon=request.icon,
        )
        return {"success": True, "notebook": notebook}
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.get("/{notebook_id}")
async def get_notebook(notebook_id: str):
    """
    Get notebook details

    Args:
        notebook_id: Notebook ID

    Returns:
        Notebook details (includes all records)
    """
    try:
        notebook = notebook_manager.get_notebook(notebook_id)
        if not notebook:
            raise HTTPException(status_code=404, detail="Notebook not found")
        return notebook
    except HTTPException:
        raise
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.get("/{notebook_id}/records")
async def list_notebook_records(
    notebook_id: str,
    q: str = "",
    limit: int = 50,
    offset: int = 0,
):
    """List a bounded page of records for large notebooks."""
    try:
        result = notebook_manager.list_records(
            notebook_id,
            query=q,
            limit=limit,
            offset=offset,
        )
        if result is None:
            raise HTTPException(status_code=404, detail="Notebook not found")
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.put("/{notebook_id}")
async def update_notebook(notebook_id: str, request: UpdateNotebookRequest):
    """
    Update notebook information

    Args:
        notebook_id: Notebook ID
        request: Update request

    Returns:
        Updated notebook information
    """
    try:
        notebook = notebook_manager.update_notebook(
            notebook_id=notebook_id,
            name=request.name,
            description=request.description,
            color=request.color,
            icon=request.icon,
        )
        if not notebook:
            raise HTTPException(status_code=404, detail="Notebook not found")
        return {"success": True, "notebook": notebook}
    except HTTPException:
        raise
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.delete("/{notebook_id}")
async def delete_notebook(notebook_id: str):
    """
    Delete notebook

    Args:
        notebook_id: Notebook ID

    Returns:
        Deletion result
    """
    try:
        success = notebook_manager.delete_notebook(notebook_id)
        if not success:
            raise HTTPException(status_code=404, detail="Notebook not found")
        return {"success": True, "message": "Notebook deleted successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.post("/add_record")
async def add_record(request: AddRecordRequest):
    """
    Add record to notebook

    Args:
        request: Add record request

    Returns:
        Addition result
    """
    try:
        summary = await _build_record_summary(request)
        result = notebook_manager.add_record(
            notebook_ids=request.notebook_ids,
            record_type=request.record_type,
            title=request.title,
            summary=summary,
            user_query=request.user_query,
            output=request.output,
            metadata=request.metadata,
            kb_name=request.kb_name,
            tags=request.tags,
            references=request.references,
            idempotency_key=request.idempotency_key,
        )
        _record_project_notebook_activity(request, result)
        return {
            "success": True,
            "summary": summary,
            "record": result["record"],
            "added_to_notebooks": result["added_to_notebooks"],
            "created": result["created"],
        }
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.post("/add_record_with_summary")
async def add_record_with_summary(request: AddRecordRequest):
    """Add record to notebook and stream generated summary."""
    return StreamingResponse(
        _stream_add_record_with_summary(request),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.delete("/{notebook_id}/records/{record_id}")
async def remove_record(notebook_id: str, record_id: str):
    """
    Remove record from notebook

    Args:
        notebook_id: Notebook ID
        record_id: Record ID

    Returns:
        Deletion result
    """
    try:
        success = notebook_manager.remove_record(notebook_id, record_id)
        if not success:
            raise HTTPException(status_code=404, detail="Record not found")
        return {"success": True, "message": "Record removed successfully"}
    except HTTPException:
        raise
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.put("/{notebook_id}/records/{record_id}")
async def update_record(notebook_id: str, record_id: str, request: UpdateRecordRequest):
    """Update an existing notebook record in place."""
    try:
        updated = notebook_manager.update_record(
            notebook_id=notebook_id,
            record_id=record_id,
            title=request.title,
            summary=request.summary,
            user_query=request.user_query,
            output=request.output,
            metadata=request.metadata,
            kb_name=request.kb_name,
            tags=request.tags,
            references=request.references,
            expected_revision=request.expected_revision,
        )
        if not updated:
            raise HTTPException(status_code=404, detail="Record not found")
        return {"success": True, "record": updated}
    except NotebookRevisionConflict as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "revision_conflict", "current": exc.current},
        ) from exc
    except HTTPException:
        raise
    except Exception as e:
        raise internal_http_error(e, operation="notebook.request") from e


@router.post("/{notebook_id}/import-markdown")
async def import_markdown(notebook_id: str, request: ImportMarkdownRequest):
    """Append Markdown sections or explicitly replace the notebook contents."""
    try:
        result = notebook_manager.import_markdown(
            notebook_id,
            markdown=request.content,
            mode=request.mode,
            title=request.title,
            idempotency_key=request.idempotency_key,
        )
        return {"success": True, **result}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Notebook not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/health")
async def health_check():
    """Health check"""
    return {"status": "healthy", "service": "notebook"}
