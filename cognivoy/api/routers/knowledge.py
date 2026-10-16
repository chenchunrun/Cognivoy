"""
Knowledge Base API Router
=========================

Handles knowledge base CRUD operations, file uploads, and initialization.
"""

import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import logging
import mimetypes
import os
from pathlib import Path
import re
import shutil
import traceback
from uuid import uuid4

from fastapi import (
    APIRouter,
    BackgroundTasks,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from cognivoy.api.errors import internal_http_error
from cognivoy.api.utils.knowledge_task_registry import get_knowledge_task_registry
from cognivoy.api.utils.progress_broadcaster import ProgressBroadcaster
from cognivoy.api.utils.task_id_manager import TaskIDManager
from cognivoy.api.utils.task_log_stream import capture_task_logs, get_task_stream_manager
from cognivoy.knowledge.add_documents import DocumentAdder, remove_raw_document
from cognivoy.knowledge.initializer import KnowledgeBaseInitializer
from cognivoy.knowledge.kb_types import is_connected_kb, supports_local_raw_files
from cognivoy.knowledge.manager import KnowledgeBaseManager
from cognivoy.knowledge.naming import validate_knowledge_base_name
from cognivoy.knowledge.progress_tracker import ProgressStage, ProgressTracker
from cognivoy.knowledge.references import get_knowledge_reference_service
from cognivoy.logging import bind_log_context
from cognivoy.multi_user.context import get_current_user
from cognivoy.multi_user.knowledge_access import (
    assert_writable,
    current_kb_base_dir,
    current_kb_manager,
    manager_for_resource,
    resolve_kb,
)
from cognivoy.multi_user.knowledge_access import (
    list_visible_knowledge_bases as list_visible_kb_access,
)
from cognivoy.services.config import PROJECT_ROOT, load_config_with_main
from cognivoy.services.file_io import atomic_write_json
from cognivoy.services.rag.factory import (
    DEFAULT_PROVIDER,
    GRAPHRAG_PROVIDER,
    LIGHTRAG_PROVIDER,
    PAGEINDEX_PROVIDER,
    normalize_provider_name,
    provider_uses_embedding_versions,
)
from cognivoy.services.rag.file_routing import FileTypeRouter
from cognivoy.services.rag.linked_kb import (
    LINKABLE_PROVIDERS,
    assert_path_allowed,
    probe_linked_folder,
)
from cognivoy.utils.document_extractor import (
    MAX_EXTRACTED_CHARS_PER_DOC,
    DocumentExtractionError,
    extract_text_from_path,
)
from cognivoy.utils.document_validator import DocumentValidator
from cognivoy.utils.error_utils import format_exception_message

# Initialize logger with config
config = load_config_with_main("main.yaml", PROJECT_ROOT)
log_dir = config.get("paths", {}).get("user_log_dir") or config.get("logging", {}).get("log_dir")
logger = logging.getLogger(__name__)

router = APIRouter()

# Constants for byte conversions
BYTES_PER_GB = 1024**3
BYTES_PER_MB = 1024**2


def format_bytes_human_readable(size_bytes: int) -> str:
    """Format bytes into human-readable string (GB, MB, or bytes)."""
    if size_bytes >= BYTES_PER_GB:
        return f"{size_bytes / BYTES_PER_GB:.1f} GB"
    elif size_bytes >= BYTES_PER_MB:
        return f"{size_bytes / BYTES_PER_MB:.1f} MB"
    else:
        return f"{size_bytes} bytes"


def _record_project_retrieval_health(
    *,
    requested_name: str,
    resolved_name: str,
    info: dict,
    ready: bool,
    checks: list[dict[str, object]],
) -> None:
    """Best-effort bridge from a KB health check to linked learning projects."""

    try:
        from cognivoy.learning.project_storage import LearningProjectStore

        failed_keys = sorted(
            str(check.get("key") or "unknown")
            for check in checks
            if not bool(check.get("ok")) and not bool(check.get("optional"))
        )
        state_key = "ready" if ready else "attention:" + ",".join(failed_keys)
        identifiers = [
            requested_name,
            resolved_name,
            str(info.get("id") or ""),
            str(info.get("name") or ""),
        ]
        LearningProjectStore().record_linked_resource_activity(
            owner_id=get_current_user().id,
            resource_type="knowledge_base",
            resource_ids=identifiers,
            title="Knowledge retrieval ready" if ready else "Knowledge retrieval needs attention",
            description=(
                "The linked knowledge base passed all required retrieval checks."
                if ready
                else f"{len(failed_keys)} required retrieval check(s) need attention."
            ),
            result_refs=[f"knowledge-base:{resolved_name}", f"knowledge-health:{state_key}"],
            dedupe_key=f"retrieval-health:{resolved_name}:{state_key}",
        )
    except Exception:
        logger.warning("Failed to record linked knowledge retrieval health", exc_info=True)


_kb_base_dir = PROJECT_ROOT / "data" / "knowledge_bases"
DEFAULT_KB_ALIASES = {"", "default", "current", "selected", "默认", "默认知识库", "当前知识库"}

# Lazy initialization
kb_manager = None


def get_kb_manager():
    """Get KnowledgeBaseManager instance (lazy init)"""
    if kb_manager is not None:
        return kb_manager
    return current_kb_manager()


def _overridden_kb_manager() -> KnowledgeBaseManager | None:
    """Return the legacy/test manager when the route-level getter is patched.

    Production multi-user access control goes through ``assert_writable`` and
    ``resolve_kb``. Older tests and single-module integrations patch
    ``get_kb_manager`` directly, so we keep that seam without weakening the
    normal write guard.
    """
    manager = get_kb_manager()
    if kb_manager is not None or manager is not current_kb_manager():
        return manager
    return None


def _current_kb_base_dir() -> Path:
    manager = _overridden_kb_manager()
    if manager is not None:
        return Path(manager.base_dir)
    return current_kb_base_dir()


def _writable_kb(kb_name: str) -> tuple[KnowledgeBaseManager, str, Path]:
    manager = _overridden_kb_manager()
    if manager is not None:
        resolved_name = _resolve_registered_kb_name(manager, kb_name)
        return manager, resolved_name, Path(manager.base_dir)
    resource = assert_writable(kb_name)
    return manager_for_resource(resource), resource.name, resource.base_dir


def _readable_kb(kb_name: str) -> tuple[KnowledgeBaseManager, str]:
    """Resolve a visible KB while preserving the route-level test seam."""

    manager = _overridden_kb_manager()
    if manager is not None:
        return manager, _resolve_registered_kb_name(manager, kb_name)
    resource = resolve_kb(kb_name)
    return manager_for_resource(resource), resource.name


class KnowledgeBaseInfo(BaseModel):
    id: str | None = None
    name: str
    is_default: bool
    statistics: dict
    metadata: dict | None = None
    path: str | None = None
    status: str | None = None
    progress: dict | None = None
    source: str | None = None
    assigned: bool = False
    read_only: bool = False
    provenance_label: str | None = None
    available: bool = True


class LinkFolderRequest(BaseModel):
    """Request model for linking a local folder to a KB."""

    folder_path: str


class LinkedFolderInfo(BaseModel):
    """Response model for linked folder information."""

    id: str
    path: str
    added_at: str
    file_count: int


class SupportedFileTypesInfo(BaseModel):
    """Upload constraints exposed to the web client."""

    extensions: list[str]
    accept: str
    max_file_size_bytes: int


class UploadPreflightFile(BaseModel):
    """Client-side file metadata used before any upload bytes are written."""

    name: str
    relative_path: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None


class UploadPreflightRequest(BaseModel):
    files: list[UploadPreflightFile]


class IndexFragmentsRequest(BaseModel):
    query: str
    top_k: int = 8


class BatchCancelRequest(BaseModel):
    task_ids: list[str]


class ResumableUploadCreateRequest(BaseModel):
    name: str
    relative_path: str | None = None
    size_bytes: int
    sha256: str | None = None


class ResumableUploadCompleteRequest(BaseModel):
    duplicate_strategy: str = "error"


class ResumableUploadProcessRequest(BaseModel):
    paths: list[str]


IMAGE_ACCEPT_MIME_TYPES = {
    ".bmp": "image/bmp",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
}


def _build_unique_task_id(task_type: str, task_key_prefix: str) -> str:
    task_manager = TaskIDManager.get_instance()
    task_key = f"{task_key_prefix}_{datetime.now().isoformat()}_{uuid4().hex[:8]}"
    return task_manager.generate_task_id(task_type, task_key)


def _mark_kb_queued_for_processing(
    manager: KnowledgeBaseManager,
    kb_name: str,
    task_id: str,
    message: str,
    *,
    status: str = "processing",
) -> None:
    """Flip an existing KB to a live processing status before its background task is dispatched.

    ``run_upload_processing_task`` only writes status once it starts running;
    without this pre-dispatch update the KB keeps reporting ``ready`` between
    the accepted upload/sync response and the task's first progress write.
    Mirrors the pre-dispatch update ``create_knowledge_base`` already does.
    ``stage`` must be a member of the frontend's ``LIVE_PROGRESS_STAGES`` set
    (web/lib/knowledge-helpers.ts).
    """
    manager.update_kb_status(
        name=kb_name,
        status=status,
        progress={
            "stage": "starting",
            "message": message,
            "percent": 0,
            "task_id": task_id,
            "timestamp": datetime.now().isoformat(),
        },
    )


def _start_knowledge_task(task_id: str, kb_name: str, awaitable) -> None:
    """Start a KB job and retain its task handle for later cancellation."""
    get_knowledge_task_registry().start(task_id, kb_name, awaitable)


def _mark_knowledge_task_cancelled(
    kb_name: str,
    base_dir: str | Path,
    task_id: str,
    *,
    action: str,
) -> None:
    """Persist and broadcast a single, non-error cancellation terminal state."""
    detail = f"{action} cancelled by user"
    task_manager = TaskIDManager.get_instance()
    task_manager.update_task_status(task_id, "cancelled")
    tracker = ProgressTracker(kb_name, Path(base_dir))
    tracker.task_id = task_id
    existing = tracker.get_progress()
    if (
        isinstance(existing, dict)
        and existing.get("stage") == "cancelled"
        and existing.get("task_id") == task_id
    ):
        return
    tracker.update(ProgressStage.CANCELLED, detail)
    _task_log(task_id, detail, level="warning")
    get_task_stream_manager().emit_cancelled(task_id, detail)


def _save_zip_archive(
    file: UploadFile,
    sanitized_filename: str,
    target_dir: Path,
    allowed_extensions: set[str] | None,
) -> list[Path]:
    """Safely expand an uploaded ``.zip`` into ``target_dir``.

    The archive itself is never persisted; each member is validated and
    extracted via :func:`safe_extract_zip` (Zip Slip / zip-bomb / extension
    guards). Returns the list of written file paths.
    """
    import tempfile
    import zipfile

    from cognivoy.utils.archive_extractor import ArchiveTooLargeError, safe_extract_zip

    file.file.seek(0)
    max_size = DocumentValidator.MAX_FILE_SIZE
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
            tmp_path = Path(tmp.name)
            written = 0
            for chunk in iter(lambda: file.file.read(8192), b""):
                written += len(chunk)
                if written > max_size:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Archive '{sanitized_filename}' exceeds maximum size limit of "
                            f"{format_bytes_human_readable(max_size)}"
                        ),
                    )
                tmp.write(chunk)

        try:
            result = safe_extract_zip(
                tmp_path, target_dir, allowed_extensions=allowed_extensions or set()
            )
        except ArchiveTooLargeError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"Rejected archive '{sanitized_filename}': {exc}",
            ) from exc
        except zipfile.BadZipFile as exc:
            raise HTTPException(
                status_code=400,
                detail=f"'{sanitized_filename}' is not a valid zip archive.",
            ) from exc

        if not result.extracted:
            raise HTTPException(
                status_code=400,
                detail=f"Archive '{sanitized_filename}' contained no supported files.",
            )
        return result.extracted
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


# Folder organization is purely a human-facing layout: folders are real
# subdirectories under ``raw/`` (no manifest, no retrieval effect). These
# helpers keep user-supplied relative paths safe before they touch the FS.
_BAD_PATH_CHARS = re.compile(r'[\\:*?"<>|\x00-\x1f]')


def _sanitize_path_segment(segment: str) -> str:
    """Sanitize a single folder/file path segment for safe FS use."""
    cleaned = _BAD_PATH_CHARS.sub("", segment).strip().strip(".")
    return cleaned[:128]


def _sanitize_rel_subdir(rel_path: str | None) -> str:
    """Return a safe POSIX relative subdir (folders only, no traversal).

    A leading/trailing or interior ``..``/absolute marker raises 400 so a
    crafted directory upload can never escape ``raw/``.
    """
    if not rel_path:
        return ""
    parts: list[str] = []
    for raw_seg in str(rel_path).replace("\\", "/").split("/"):
        seg = raw_seg.strip()
        if seg in ("", "."):
            continue
        if seg == "..":
            raise HTTPException(status_code=400, detail="Invalid folder path")
        safe = _sanitize_path_segment(seg)
        if safe:
            parts.append(safe)
    return "/".join(parts)


def _safe_join_raw(raw_dir: Path, rel_path: str) -> Path:
    """Resolve ``rel_path`` under ``raw_dir``, rejecting traversal."""
    target = (raw_dir / rel_path).resolve()
    try:
        target.relative_to(raw_dir.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=403, detail="Access denied") from exc
    return target


def _sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _upload_relative_path(filename: str, relative_path: str | None) -> str:
    """Apply the same path sanitisation used by the actual upload writer."""

    rel = str(relative_path or "").replace("\\", "/")
    subdir = _sanitize_rel_subdir(rel.rsplit("/", 1)[0]) if "/" in rel else ""
    sanitized = DocumentValidator.validate_upload_safety(filename, None)
    return f"{subdir}/{sanitized}" if subdir else sanitized


def _renamed_upload_path(raw_dir: Path, relative_path: str) -> str:
    candidate = Path(relative_path)
    parent = candidate.parent
    stem = candidate.stem
    suffix = candidate.suffix
    index = 2
    while True:
        name = f"{stem} ({index}){suffix}"
        renamed = (parent / name).as_posix() if str(parent) != "." else name
        if not _safe_join_raw(raw_dir, renamed).exists():
            return renamed
        index += 1


def _upload_sessions_dir(manager: KnowledgeBaseManager, kb_name: str) -> Path:
    directory = manager.get_knowledge_base_path(kb_name) / ".upload-sessions"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


_UPLOAD_SESSION_TTL = timedelta(days=7)


def _cleanup_expired_upload_sessions(
    manager: KnowledgeBaseManager,
    kb_name: str,
    *,
    now: datetime | None = None,
) -> list[str]:
    """Remove abandoned resumable upload metadata and partial bytes.

    The most recent ``updated_at`` keeps an active upload alive. Invalid
    metadata cannot be resumed safely and is cleaned once its file mtime is
    older than the same retention window.
    """
    directory = _upload_sessions_dir(manager, kb_name)
    cutoff = (now or datetime.now(timezone.utc)) - _UPLOAD_SESSION_TTL
    removed: list[str] = []
    for metadata_path in directory.glob("*.json"):
        session_id = metadata_path.stem
        if not re.fullmatch(r"[0-9a-f]{32}", session_id):
            continue
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            raw_timestamp = str(payload.get("updated_at") or payload.get("created_at") or "")
            touched_at = datetime.fromisoformat(raw_timestamp.replace("Z", "+00:00"))
            if touched_at.tzinfo is None:
                touched_at = touched_at.replace(tzinfo=timezone.utc)
            else:
                touched_at = touched_at.astimezone(timezone.utc)
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            touched_at = datetime.fromtimestamp(metadata_path.stat().st_mtime, tz=timezone.utc)
        if touched_at > cutoff:
            continue
        metadata_path.unlink(missing_ok=True)
        (directory / f"{session_id}.part").unlink(missing_ok=True)
        removed.append(session_id)
    return removed


def _upload_session_paths(
    manager: KnowledgeBaseManager, kb_name: str, session_id: str
) -> tuple[Path, Path]:
    if not re.fullmatch(r"[0-9a-f]{32}", session_id):
        raise HTTPException(status_code=404, detail="Upload session not found.")
    directory = _upload_sessions_dir(manager, kb_name)
    return directory / f"{session_id}.json", directory / f"{session_id}.part"


def _load_upload_session(
    manager: KnowledgeBaseManager, kb_name: str, session_id: str
) -> tuple[dict[str, object], Path, Path]:
    metadata_path, part_path = _upload_session_paths(manager, kb_name, session_id)
    if not metadata_path.is_file():
        raise HTTPException(status_code=404, detail="Upload session not found.")
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=409, detail="Upload session metadata is invalid.") from exc
    return metadata, metadata_path, part_path


def _append_upload_chunk(part_path: Path, expected_offset: int, file: UploadFile) -> int:
    current_size = part_path.stat().st_size if part_path.exists() else 0
    if current_size != expected_offset:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "upload_offset_mismatch",
                "message": "The upload offset is stale; resume from the server offset.",
                "offset": current_size,
            },
        )
    chunk_size = _get_upload_file_size(file) or 0
    if chunk_size <= 0 or chunk_size > 8 * BYTES_PER_MB:
        raise HTTPException(
            status_code=400, detail="Upload chunks must be between 1 byte and 8 MB."
        )
    file.file.seek(0)
    with part_path.open("ab") as output:
        shutil.copyfileobj(file.file, output, length=1024 * 1024)
        output.flush()
        os.fsync(output.fileno())
    return part_path.stat().st_size


def _save_uploaded_files(
    files: list[UploadFile],
    target_dir: Path,
    allowed_extensions: set[str] | None = None,
    kb_name: str | None = None,
    rel_paths: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    """
    Save uploaded files to the local raw/ directory.

    When PocketBase is enabled and ``kb_name`` is supplied, each file is also
    uploaded to the PocketBase knowledge_bases record as a file attachment
    (best-effort — local write is always the primary path).
    """
    uploaded_files: list[str] = []
    uploaded_file_paths: list[str] = []
    written_file_paths: list[Path] = []

    from cognivoy.services.pocketbase_client import is_pocketbase_enabled

    _pb_sync = is_pocketbase_enabled() and bool(kb_name)

    try:
        for idx, file in enumerate(files):
            file_path = None
            original_filename = file.filename or "upload"
            try:
                sanitized_filename = DocumentValidator.validate_upload_safety(
                    original_filename,
                    _get_upload_file_size(file),
                    allowed_extensions=allowed_extensions,
                )
                file.filename = sanitized_filename

                # Directory uploads carry a relative path (folder/sub/file); the
                # folder portion is preserved under raw/ so nested structure is
                # kept verbatim. Single-file uploads have no rel path → root.
                rel = (
                    rel_paths[idx].replace("\\", "/")
                    if rel_paths and idx < len(rel_paths) and rel_paths[idx]
                    else ""
                )
                subdir = _sanitize_rel_subdir(rel.rsplit("/", 1)[0]) if "/" in rel else ""
                dest_dir = target_dir / subdir if subdir else target_dir
                if subdir:
                    dest_dir.mkdir(parents=True, exist_ok=True)
                rel_name = f"{subdir}/{sanitized_filename}" if subdir else sanitized_filename

                if Path(sanitized_filename).suffix.lower() == ".zip":
                    # Expand the archive in place; register each extracted
                    # member instead of the zip itself.
                    for dest in _save_zip_archive(
                        file, sanitized_filename, dest_dir, allowed_extensions
                    ):
                        written_file_paths.append(dest)
                        uploaded_files.append(dest.relative_to(target_dir).as_posix())
                        uploaded_file_paths.append(str(dest))
                        if _pb_sync and kb_name:
                            try:
                                _upload_file_to_pb(kb_name, dest.name, dest)
                            except Exception as pb_exc:
                                logger.debug(
                                    "PocketBase file upload failed for '%s': %s",
                                    dest.name,
                                    pb_exc,
                                )
                    continue

                file_path = dest_dir / sanitized_filename
                max_size = DocumentValidator.MAX_FILE_SIZE
                written_bytes = 0

                file.file.seek(0)
                with open(file_path, "wb") as buffer:
                    for chunk in iter(lambda: file.file.read(8192), b""):
                        written_bytes += len(chunk)
                        if written_bytes > max_size:
                            size_str = format_bytes_human_readable(max_size)
                            raise HTTPException(
                                status_code=400,
                                detail=(
                                    f"File '{sanitized_filename}' exceeds maximum size "
                                    f"limit of {size_str}"
                                ),
                            )
                        buffer.write(chunk)

                DocumentValidator.validate_upload_safety(
                    sanitized_filename, written_bytes, allowed_extensions=allowed_extensions
                )
                written_file_paths.append(file_path)
                uploaded_files.append(rel_name)
                uploaded_file_paths.append(str(file_path))

                # Mirror file to PocketBase when enabled (best-effort, non-blocking).
                if _pb_sync and kb_name:
                    try:
                        _upload_file_to_pb(kb_name, sanitized_filename, file_path)
                    except Exception as pb_exc:
                        logger.debug(
                            "PocketBase file upload failed for '%s': %s",
                            sanitized_filename,
                            pb_exc,
                        )
            except Exception as e:
                if file_path and file_path.exists():
                    try:
                        os.unlink(file_path)
                    except OSError:
                        pass

                error_message = f"Validation failed for file '{original_filename}': {format_exception_message(e)}"
                logger.error(error_message, exc_info=True)
                raise HTTPException(status_code=400, detail=error_message) from e
    except Exception:
        for written_path in written_file_paths:
            if written_path.exists():
                try:
                    os.unlink(written_path)
                except OSError:
                    pass
        raise

    return uploaded_files, uploaded_file_paths


async def _save_uploaded_files_off_loop(
    files: list[UploadFile],
    target_dir: Path,
    allowed_extensions: set[str] | None = None,
    kb_name: str | None = None,
    rel_paths: list[str] | None = None,
) -> tuple[list[str], list[str]]:
    """:func:`_save_uploaded_files` on a worker thread.

    That function blocks end to end — a chunked write of every uploaded byte,
    zip extraction for archive members, and (when PocketBase is enabled) one
    synchronous HTTP upload per file. Called inline from an ``async def``
    route it held the event loop for the whole batch, so every other request
    — chat WebSockets included — stalled until the upload finished (#777).

    Safe to hand to a thread: it only touches ``UploadFile.file``, the plain
    ``SpooledTemporaryFile`` underneath, never the async ``UploadFile`` API.
    """
    return await asyncio.to_thread(
        _save_uploaded_files,
        files,
        target_dir,
        allowed_extensions=allowed_extensions,
        kb_name=kb_name,
        rel_paths=rel_paths,
    )


def _get_upload_file_size(file: UploadFile) -> int | None:
    """Best-effort byte size detection without consuming the uploaded stream."""
    try:
        current_position = file.file.tell()
        file.file.seek(0, os.SEEK_END)
        size = file.file.tell()
        file.file.seek(current_position)
        return size
    except Exception:
        return None


def _validate_upload_batch(
    files: list[UploadFile],
    allowed_extensions: set[str] | None = None,
    rel_paths: list[str] | None = None,
) -> list[dict[str, int | str | None]]:
    """Validate upload metadata before mutating KB state or writing any files."""
    validated: list[dict[str, int | str | None]] = []
    seen_names: set[str] = set()

    for idx, file in enumerate(files):
        original_filename = file.filename or "upload"
        size_bytes = _get_upload_file_size(file)
        try:
            sanitized_filename = DocumentValidator.validate_upload_safety(
                original_filename,
                size_bytes,
                allowed_extensions=allowed_extensions,
            )
        except Exception as e:
            error_message = (
                f"Validation failed for file '{original_filename}': {format_exception_message(e)}"
            )
            raise HTTPException(status_code=400, detail=error_message) from e

        rel = (
            rel_paths[idx].replace("\\", "/")
            if rel_paths and idx < len(rel_paths) and rel_paths[idx]
            else ""
        )
        subdir = _sanitize_rel_subdir(rel.rsplit("/", 1)[0]) if "/" in rel else ""
        duplicate_key = f"{subdir}/{sanitized_filename}" if subdir else sanitized_filename

        if duplicate_key in seen_names:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Duplicate filename after sanitization: '{duplicate_key}'. "
                    "Rename one of the files and try again."
                ),
            )

        seen_names.add(duplicate_key)
        validated.append(
            {
                "original_filename": original_filename,
                "sanitized_filename": sanitized_filename,
                "path": duplicate_key,
                "size_bytes": size_bytes,
            }
        )

    return validated


def _upload_file_to_pb(kb_name: str, filename: str, file_path: Path) -> None:
    """Upload a single file to the PocketBase knowledge_bases record."""
    try:
        from cognivoy.services.pocketbase_client import get_pb_client

        pb = get_pb_client()
        records = pb.collection("knowledge_bases").get_full_list(
            query_params={"filter": f'kb_name="{kb_name}"'}
        )
        if not records:
            logger.debug(f"PocketBase KB record not found for '{kb_name}', skipping file upload")
            return
        with open(file_path, "rb") as fh:
            pb.collection("knowledge_bases").update(
                records[0].id,
                body={"kb_name": kb_name},
                files={"raw_files": (filename, fh)},
            )
        logger.debug(f"Uploaded '{filename}' to PocketBase KB '{kb_name}'")
    except Exception as exc:
        logger.debug(f"_upload_file_to_pb failed: {exc}")


def _task_log(task_id: str, message: str, level: str = "info") -> None:
    manager = get_task_stream_manager()
    manager.ensure_task(task_id)
    manager.emit_log(task_id, message)

    log_method = getattr(logger, level, None)
    if callable(log_method):
        log_method(f"[{task_id}] {message}")
    else:
        logger.info(f"[{task_id}] {message}")


def _emit_private_task_failure(
    task_id: str,
    exc: Exception,
    *,
    code: str,
    message: str,
) -> str:
    """Publish an actionable failure without exposing provider internals.

    Full exception diagnostics remain in server logs under a trace id. The
    task stream and persisted progress receive only stable, user-safe copy and
    the same trace id so an administrator can correlate the failure.
    """

    trace_id = uuid4().hex
    public_message = f"{message} Diagnostic ID: {trace_id}"
    stream = get_task_stream_manager()
    stream.ensure_task(task_id)
    stream.emit_log(task_id, public_message)
    stream.emit_failed(
        task_id,
        public_message,
        code=code,
        retryable=True,
        trace_id=trace_id,
    )
    with bind_log_context(sink="server"):
        logger.error(
            "Knowledge task failed trace_id=%s task_id=%s code=%s",
            trace_id,
            task_id,
            code,
            exc_info=(type(exc), exc, exc.__traceback__),
        )
    return public_message


def _validate_registered_provider(raw_provider: str | None) -> str:
    """Resolve a requested provider to a known engine.

    Empty / legacy / unknown strings coerce to the default (so a stale config or
    a removed engine never selects a missing pipeline). Returning the real,
    canonical provider is what makes the per-KB lock meaningful: the upload route
    compares the requested provider against the KB's bound provider, so asking to
    add to a ``pageindex`` KB with ``llamaindex`` (or vice versa) is rejected.
    """
    return normalize_provider_name(raw_provider)


def _assert_provider_ready(provider: str) -> None:
    """Block creating/using a KB whose engine isn't ready.

    PageIndex needs an API key; GraphRAG needs the optional package installed.
    """
    if provider == PAGEINDEX_PROVIDER:
        from cognivoy.services.rag.pipelines.pageindex.config import is_pageindex_configured

        if not is_pageindex_configured():
            raise HTTPException(
                status_code=400,
                detail=(
                    "PageIndex API key is not configured. Add it under "
                    "Knowledge → RAG pipeline settings before creating a PageIndex "
                    "knowledge base."
                ),
            )

    if provider == GRAPHRAG_PROVIDER:
        from cognivoy.services.rag.pipelines.graphrag.config import is_graphrag_available

        if not is_graphrag_available():
            raise HTTPException(
                status_code=400,
                detail=(
                    "GraphRAG is temporarily disabled pending dependency security compatibility. "
                    "Use LlamaIndex, keyword/BM25, or LightRAG instead."
                ),
            )

    if provider == LIGHTRAG_PROVIDER:
        from cognivoy.services.rag.pipelines.lightrag.config import is_lightrag_available

        if not is_lightrag_available():
            raise HTTPException(
                status_code=400,
                detail=(
                    "LightRAG is not installed. Run "
                    "`pip install 'cognivoy[rag-lightrag]'` on the server before "
                    "creating a LightRAG knowledge base."
                ),
            )


def _preflight_error_code(failed_checks: list[dict]) -> str:
    """Return a stable client-facing code for an engine preflight failure."""
    keys = {str(check.get("key") or "") for check in failed_checks}
    if "embedding" in keys:
        return "embedding_model_missing"
    if "chat" in keys:
        return "llm_model_missing"
    if "api_key" in keys:
        return "provider_credentials_missing"
    if "package" in keys:
        return "provider_dependency_missing"
    return "knowledge_preflight_failed"


def _preflight_action(failed_checks: list[dict]) -> dict | None:
    keys = {str(check.get("key") or "") for check in failed_checks}
    if "embedding" in keys:
        return {
            "type": "open_settings",
            "path": "/settings/embedding",
            "label": "Open embedding settings",
        }
    if "chat" in keys:
        return {
            "type": "open_settings",
            "path": "/settings/llm",
            "label": "Open LLM settings",
        }
    return None


def _assert_index_preflight(provider: str) -> None:
    """Reject indexing before any files or KB records are mutated.

    The same preflight report powers the UI and the write endpoints, which
    keeps a stale browser or a direct API client from starting a task that is
    guaranteed to fail later in the background worker.
    """
    from cognivoy.services.rag.preflight import engine_preflight

    report = engine_preflight(provider)
    failed_checks = [
        check
        for check in report.get("checks", [])
        if not check.get("ok") and not check.get("optional")
    ]
    if not failed_checks:
        return

    first_detail = str(failed_checks[0].get("detail") or "").strip()
    message = first_detail or "The selected index engine is not ready."
    detail = {
        "code": _preflight_error_code(failed_checks),
        "message": message,
        "retryable": False,
        "provider": provider,
        "checks": failed_checks,
    }
    action = _preflight_action(failed_checks)
    if action:
        detail["action"] = action
    raise HTTPException(status_code=422, detail=detail)


def _enforce_provider_formats(provider: str, files: list[UploadFile]) -> None:
    """Reject files PageIndex's document endpoint does not accept, up front."""
    if provider != PAGEINDEX_PROVIDER:
        return
    from cognivoy.services.rag.pipelines.pageindex.pipeline import SUPPORTED_EXTENSIONS

    unsupported = [
        f.filename
        for f in files
        if f.filename
        and not f.filename.lower().endswith(".zip")
        and Path(f.filename).suffix.lower() not in SUPPORTED_EXTENSIONS
    ]
    if unsupported:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise HTTPException(
            status_code=400,
            detail=(
                f"PageIndex knowledge bases accept: {supported}. "
                f"Unsupported: {', '.join(unsupported[:5])}."
            ),
        )


def _resolve_registered_kb_name(manager: KnowledgeBaseManager, kb_name: str | None) -> str:
    """Resolve route-level default aliases to the configured default KB."""
    requested = str(kb_name or "").strip()
    kb_names = manager.list_knowledge_bases()
    if requested and requested in kb_names:
        return requested

    if requested.lower() in DEFAULT_KB_ALIASES:
        default_kb = manager.get_default()
        if default_kb and default_kb in kb_names:
            return default_kb
        raise HTTPException(status_code=404, detail="No default knowledge base is configured")

    raise HTTPException(status_code=404, detail=f"Knowledge base '{requested}' not found")


def _load_kb_entry_or_404(manager: KnowledgeBaseManager, kb_name: str) -> dict:
    manager.config = manager._load_config()
    kb_entry = manager.config.get("knowledge_bases", {}).get(kb_name)
    if kb_entry is None:
        raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")
    return kb_entry


def _assert_not_connected_kb(kb_name: str, kb_entry: dict) -> None:
    """Block writes to connected KBs (Obsidian vaults, linked indexes).

    They are read-only pointers to the user's external files — we never write
    into or re-index them.
    """
    if is_connected_kb(kb_entry):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Knowledge base '{kb_name}' is connected to an external resource and is "
                "read-only. Local file operations and re-indexing are not available for it."
            ),
        )


def _assert_kb_writable_or_409(kb_name: str, kb_entry: dict) -> None:
    _assert_not_connected_kb(kb_name, kb_entry)
    if bool(kb_entry.get("needs_reindex", False)):
        raise HTTPException(
            status_code=409,
            detail=(
                f"Knowledge base '{kb_name}' uses legacy index format and needs reindex "
                "before accepting incremental uploads."
            ),
        )


def _matching_index_is_valid(kb_name: str, matching_version: dict | None) -> bool:
    """Return whether a matching active index can safely satisfy retrieval."""
    if not matching_version:
        return False
    try:
        from cognivoy.services.rag.index_probe import inspect_provider_version
        from cognivoy.services.rag.pipelines.llamaindex.storage import (
            validate_storage_embeddings,
        )

        probe = inspect_provider_version(matching_version, DEFAULT_PROVIDER)
        if not probe.ready:
            logger.warning(
                "Matching index for KB '%s' is not provider-ready; forcing re-index: %s",
                kb_name,
                probe.failure_summary or probe.diagnostics,
            )
            return False
        validate_storage_embeddings(Path(str(matching_version["storage_path"])))
        return True
    except Exception as exc:
        logger.warning(
            "Matching index for KB '%s' is invalid; forcing re-index: %s",
            kb_name,
            exc,
        )
        return False


async def run_initialization_task(initializer: KnowledgeBaseInitializer, task_id: str):
    """Background task for knowledge base initialization"""
    task_manager = TaskIDManager.get_instance()
    task_stream_manager = get_task_stream_manager()
    task_stream_manager.ensure_task(task_id)

    with capture_task_logs(task_id):
        try:
            if not initializer.progress_tracker:
                initializer.progress_tracker = ProgressTracker(
                    initializer.kb_name, initializer.base_dir
                )

            initializer.progress_tracker.task_id = task_id

            _task_log(task_id, f"Initializing knowledge base '{initializer.kb_name}'")

            await initializer.process_documents()
            _task_log(task_id, "Document processing complete")
            _task_log(task_id, "Finalizing initialization")
            indexed_count = len(
                FileTypeRouter.collect_supported_files(initializer.raw_dir, recursive=True)
            )

            initializer.progress_tracker.update(
                ProgressStage.COMPLETED,
                "Knowledge base initialization complete!",
                current=1,
                total=1,
                indexed_count=indexed_count,
                index_changed=True,
                index_action="create",
            )

            manager = get_kb_manager()
            manager.update_kb_status(
                name=initializer.kb_name,
                status="ready",
                progress={
                    "stage": "completed",
                    "message": "Knowledge base initialization complete!",
                    "percent": 100,
                    "current": 1,
                    "total": 1,
                    "task_id": task_id,
                    "timestamp": datetime.now().isoformat(),
                    "indexed_count": indexed_count,
                    "index_changed": True,
                    "index_action": "create",
                },
            )

            _task_log(
                task_id, f"Knowledge base '{initializer.kb_name}' initialized", level="success"
            )
            task_manager.update_task_status(task_id, "completed")
            task_stream_manager.emit_complete(
                task_id, f"Knowledge base '{initializer.kb_name}' initialization complete"
            )
        except asyncio.CancelledError:
            _mark_knowledge_task_cancelled(
                initializer.kb_name,
                initializer.base_dir,
                task_id,
                action="Knowledge base initialization",
            )
            raise
        except Exception as e:
            error_msg = _emit_private_task_failure(
                task_id,
                e,
                code="knowledge_initialization_failed",
                message=(
                    "Knowledge base initialization failed. Check document parsing and "
                    "model settings, then retry."
                ),
            )

            task_manager.update_task_status(task_id, "error", error=error_msg)

            manager = get_kb_manager()
            manager.update_kb_status(
                name=initializer.kb_name,
                status="error",
                progress={
                    "stage": "error",
                    "message": f"Initialization failed: {error_msg}",
                    "percent": 0,
                    "error": error_msg,
                    "task_id": task_id,
                    "timestamp": datetime.now().isoformat(),
                },
            )

            if initializer.progress_tracker:
                initializer.progress_tracker.update(
                    ProgressStage.ERROR, f"Initialization failed: {error_msg}", error=error_msg
                )


async def run_upload_processing_task(
    kb_name: str,
    base_dir: str,
    uploaded_file_paths: list[str],
    task_id: str,
    rag_provider: str = None,
    folder_id: str = None,
):
    """Background task for processing uploaded files.

    Args:
        kb_name: Knowledge base name
        base_dir: Base directory for knowledge bases
        uploaded_file_paths: List of file paths to process
        rag_provider: RAG provider already matched against the KB binding
        folder_id: Optional folder ID for sync state update
    """
    task_manager = TaskIDManager.get_instance()
    task_stream_manager = get_task_stream_manager()
    task_stream_manager.ensure_task(task_id)

    progress_tracker = ProgressTracker(kb_name, Path(base_dir))
    progress_tracker.task_id = task_id

    with capture_task_logs(task_id):
        try:
            _task_log(task_id, f"Processing {len(uploaded_file_paths)} file(s) for KB '{kb_name}'")
            progress_tracker.update(
                ProgressStage.PROCESSING_DOCUMENTS,
                f"Processing {len(uploaded_file_paths)} files...",
                current=0,
                total=len(uploaded_file_paths),
            )

            adder = DocumentAdder(
                kb_name=kb_name,
                base_dir=base_dir,
                progress_tracker=progress_tracker,
                rag_provider=rag_provider,
                cancel_event=get_knowledge_task_registry().get_cancel_event(task_id),
            )

            # Staging blocks: a full-content hash per file, plus a copy for
            # anything not already under raw/. A BackgroundTasks entry declared
            # ``async def`` is awaited ON the event loop — starlette only routes
            # *sync* callables to its threadpool — so doing this inline stalled
            # every other request for the length of the batch (#777).
            staged_files = await asyncio.to_thread(
                adder.add_documents,
                uploaded_file_paths,
                allow_duplicates=False,
                cancel_event=get_knowledge_task_registry().get_cancel_event(task_id),
            )
            _task_log(task_id, f"Staged {len(staged_files)} new file(s)")

            if not staged_files:
                _task_log(task_id, "No new files to process (all duplicates or invalid)")
                progress_tracker.update(
                    ProgressStage.COMPLETED,
                    "No new files to process (all duplicates or invalid)",
                    current=0,
                    total=0,
                )
                task_manager.update_task_status(task_id, "completed")
                task_stream_manager.emit_complete(
                    task_id, "No new files to process (all duplicates or invalid)"
                )
                return

            index_result = await adder.process_new_documents(staged_files)
            processed_files = index_result.processed_files
            _task_log(task_id, f"Indexed {index_result.processed_count} file(s)")

            if index_result.has_failures:
                failed_names = ", ".join(
                    failure.file_path.name for failure in index_result.failures[:5]
                )
                if index_result.failed_count > 5:
                    failed_names += f", and {index_result.failed_count - 5} more"
                internal_error = RuntimeError(
                    "; ".join(
                        f"{failure.file_path}: {failure.error}" for failure in index_result.failures
                    )
                )
                error_msg = _emit_private_task_failure(
                    task_id,
                    internal_error,
                    code="knowledge_document_partial_failure",
                    message=(
                        f"Indexed {index_result.processed_count}/{len(staged_files)} file(s); "
                        f"{index_result.failed_count} failed ({failed_names}). Check the file "
                        "format and parser settings, then retry."
                    ),
                )
                progress_tracker.update(
                    ProgressStage.ERROR,
                    f"Processing failed: {error_msg}",
                    current=index_result.processed_count,
                    total=len(staged_files),
                    error=error_msg,
                    indexed_count=index_result.processed_count,
                    index_changed=index_result.processed_count > 0,
                    index_action="upload",
                )
                task_manager.update_task_status(task_id, "error", error=error_msg)
                return

            adder.update_metadata(index_result.processed_count)

            if folder_id and processed_files:
                try:
                    manager = get_kb_manager()
                    manager.update_folder_sync_state(
                        kb_name, folder_id, [str(f) for f in processed_files]
                    )
                    _task_log(task_id, f"Updated folder sync state: {folder_id}")
                except Exception as sync_err:
                    _task_log(
                        task_id, f"Folder sync state update failed: {sync_err}", level="warning"
                    )

            num_processed = index_result.processed_count
            progress_tracker.update(
                ProgressStage.COMPLETED,
                f"Successfully processed {num_processed} files!",
                current=num_processed,
                total=num_processed,
                indexed_count=num_processed,
                index_changed=num_processed > 0,
                index_action="upload",
            )

            _task_log(
                task_id, f"Processed {num_processed} file(s) for '{kb_name}'", level="success"
            )
            task_manager.update_task_status(task_id, "completed")
            task_stream_manager.emit_complete(
                task_id, f"Successfully processed {num_processed} files for '{kb_name}'"
            )
        except asyncio.CancelledError:
            _mark_knowledge_task_cancelled(
                kb_name,
                base_dir,
                task_id,
                action="Document indexing",
            )
            raise
        except Exception as e:
            error_msg = _emit_private_task_failure(
                task_id,
                e,
                code="knowledge_document_processing_failed",
                message=(
                    "Document processing failed. Check the file format, parser, and "
                    "embedding settings, then retry."
                ),
            )

            task_manager.update_task_status(task_id, "error", error=error_msg)

            progress_tracker.update(
                ProgressStage.ERROR, f"Processing failed: {error_msg}", error=error_msg
            )


@router.get("/health")
async def health_check():
    """Health check endpoint"""
    try:
        manager = get_kb_manager()
        config_exists = manager.config_file.exists()
        kb_count = len(manager.list_knowledge_bases())
        return {
            "status": "ok",
            "config_file": str(manager.config_file),
            "config_exists": config_exists,
            "base_dir": str(manager.base_dir),
            "base_dir_exists": manager.base_dir.exists(),
            "knowledge_bases_count": kb_count,
        }
    except Exception:
        logger.exception("Knowledge health check failed", extra={"sink": "server"})
        return {"status": "error", "error": "Knowledge health check failed."}


@router.get("/rag-providers")
async def get_rag_providers():
    """Get list of available RAG providers (with the active per-engine mode)."""
    try:
        from cognivoy.services.config import get_kb_config_service
        from cognivoy.services.rag.preflight import engine_preflight
        from cognivoy.services.rag.service import RAGService

        providers = RAGService.list_providers()
        kb_config = get_kb_config_service()
        for provider in providers:
            modes = provider.get("modes") or []
            if modes:
                stored = kb_config.get_provider_mode(provider["id"])
                if stored in modes:
                    provider["default_mode"] = stored
            # Whether an existing index for this engine can be linked in place
            # (self-contained on disk). Drives the "link existing folder" UI.
            provider["linkable"] = provider.get("id") in LINKABLE_PROVIDERS
            if provider.get("id") in {
                DEFAULT_PROVIDER,
                PAGEINDEX_PROVIDER,
                GRAPHRAG_PROVIDER,
                LIGHTRAG_PROVIDER,
            }:
                report = engine_preflight(provider["id"])
                provider["preflight"] = report
                provider["ready"] = bool(report.get("ok"))
            else:
                provider["ready"] = provider.get("configured") is not False
        return {"providers": providers}
    except Exception as e:
        logger.error(f"Error getting RAG providers: {e}")
        raise internal_http_error(e, operation="knowledge.list_rag_providers") from e


class ProviderModeUpdate(BaseModel):
    """Set an engine's global default retrieval mode (from its engine card)."""

    mode: str


@router.put("/rag-providers/{provider}/mode")
async def set_rag_provider_mode(provider: str, payload: ProviderModeUpdate):
    """Persist the default retrieval mode for a mode-aware engine.

    The mode must be one the engine supports; a KB's own ``search_mode`` still
    overrides this per-KB default.
    """
    from cognivoy.services.config import get_kb_config_service
    from cognivoy.services.rag.service import RAGService

    entry = next((p for p in RAGService.list_providers() if p["id"] == provider), None)
    modes = (entry or {}).get("modes") or []
    if entry is None or not modes:
        raise HTTPException(status_code=404, detail=f"No retrieval modes for engine '{provider}'.")

    mode = (payload.mode or "").strip().lower()
    if mode not in modes:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid mode '{payload.mode}' for {provider}. Choose one of: {', '.join(modes)}.",
        )

    get_kb_config_service().set_provider_mode(provider, mode)
    return {"provider": provider, "mode": mode}


class PageIndexConfigUpdate(BaseModel):
    # Tri-state api_key: omit/None keeps the stored key, "" clears it, any other
    # value replaces it — so the masked UI never round-trips the real secret.
    api_key: str | None = None
    api_base_url: str | None = None


def _pageindex_config_payload() -> dict:
    """PageIndex pipeline settings for the UI, with the API key redacted."""
    from cognivoy.services.config import get_runtime_settings_service

    settings = get_runtime_settings_service().load_pageindex()
    return {
        "api_base_url": settings.get("api_base_url") or "",
        "api_key_set": bool(settings.get("api_key")),
        "configured": bool(settings.get("api_key")),
    }


@router.get("/rag-pipelines/pageindex/config")
async def get_pageindex_pipeline_config():
    """Read the PageIndex credential state (key redacted to a boolean)."""
    try:
        return _pageindex_config_payload()
    except Exception as e:
        logger.error(f"Error reading PageIndex config: {e}")
        raise internal_http_error(e, operation="knowledge.get_pageindex_config") from e


@router.put("/rag-pipelines/pageindex/config")
async def update_pageindex_pipeline_config(payload: PageIndexConfigUpdate):
    """Persist the PageIndex API key / base URL for this user's account."""
    try:
        from cognivoy.services.config import get_runtime_settings_service
        from cognivoy.services.rag.pipelines.pageindex.config import DEFAULT_API_BASE_URL

        service = get_runtime_settings_service()
        current = service.load_pageindex(include_process_overrides=False)

        api_key = current.get("api_key", "")
        if payload.api_key is not None:
            api_key = payload.api_key.strip()

        api_base_url = current.get("api_base_url") or DEFAULT_API_BASE_URL
        if payload.api_base_url is not None and payload.api_base_url.strip():
            api_base_url = payload.api_base_url.strip()

        service.save_pageindex({"api_key": api_key, "api_base_url": api_base_url})

        # The built-in pageindex MCP server derives its URL/Bearer header from
        # these settings — resync connections so key changes apply immediately.
        try:
            from cognivoy.services.mcp import get_mcp_manager

            await get_mcp_manager().reload()
        except Exception:
            logger.warning("MCP reload after PageIndex config change failed", exc_info=True)

        return _pageindex_config_payload()
    except Exception as e:
        logger.error(f"Error updating PageIndex config: {e}")
        raise internal_http_error(e, operation="knowledge.update_pageindex_config") from e


class LlamaIndexConfigUpdate(BaseModel):
    """Partial update for the LlamaIndex engine knobs (omitted fields kept)."""

    retrieval_profile: str | None = None
    top_k: int | None = None
    vector_top_k_multiplier: int | None = None
    bm25_top_k_multiplier: int | None = None
    chunk_size: int | None = None
    chunk_overlap: int | None = None


@router.get("/rag-pipelines/llamaindex/config")
async def get_llamaindex_pipeline_config():
    """Read the LlamaIndex engine's retrieval + chunking knobs."""
    try:
        from cognivoy.services.config import get_runtime_settings_service

        return get_runtime_settings_service().load_llamaindex()
    except Exception as e:
        logger.error(f"Error reading LlamaIndex config: {e}")
        raise internal_http_error(e, operation="knowledge.get_llamaindex_config") from e


@router.put("/rag-pipelines/llamaindex/config")
async def update_llamaindex_pipeline_config(payload: LlamaIndexConfigUpdate):
    """Persist the LlamaIndex engine knobs.

    Retrieval knobs take effect on the next query; chunk geometry only changes
    how documents indexed *after* the save are split.
    """
    try:
        from cognivoy.services.config import get_runtime_settings_service

        service = get_runtime_settings_service()
        current = service.load_llamaindex(include_process_overrides=False)
        # Merge only the provided fields so partial saves never wipe others.
        updates = payload.model_dump(exclude_none=True)
        return service.save_llamaindex({**current, **updates})
    except Exception as e:
        logger.error(f"Error updating LlamaIndex config: {e}")
        raise internal_http_error(e, operation="knowledge.update_llamaindex_config") from e


class GraphRagConfigUpdate(BaseModel):
    """Partial update for GraphRAG query knobs (omitted fields kept)."""

    response_type: str | None = None
    community_level: int | None = None
    dynamic_community_selection: bool | None = None


@router.get("/rag-pipelines/graphrag/config")
async def get_graphrag_pipeline_config():
    """Read GraphRAG's query knobs (response style, community granularity)."""
    try:
        from cognivoy.services.config import get_runtime_settings_service

        return get_runtime_settings_service().load_graphrag()
    except Exception as e:
        logger.error(f"Error reading GraphRAG config: {e}")
        raise internal_http_error(e, operation="knowledge.get_graphrag_config") from e


@router.put("/rag-pipelines/graphrag/config")
async def update_graphrag_pipeline_config(payload: GraphRagConfigUpdate):
    """Persist GraphRAG's query knobs. Takes effect on the next query."""
    try:
        from cognivoy.services.config import get_runtime_settings_service

        service = get_runtime_settings_service()
        current = service.load_graphrag()
        updates = payload.model_dump(exclude_none=True)
        return service.save_graphrag({**current, **updates})
    except Exception as e:
        logger.error(f"Error updating GraphRAG config: {e}")
        raise internal_http_error(e, operation="knowledge.update_graphrag_config") from e


class LightRagConfigUpdate(BaseModel):
    """Partial update for LightRAG query knobs (omitted fields kept)."""

    top_k: int | None = None
    response_type: str | None = None


@router.get("/rag-pipelines/lightrag/config")
async def get_lightrag_pipeline_config():
    """Read LightRAG's query knobs (top_k, response style)."""
    try:
        from cognivoy.services.config import get_runtime_settings_service

        return get_runtime_settings_service().load_lightrag()
    except Exception as e:
        logger.error(f"Error reading LightRAG config: {e}")
        raise internal_http_error(e, operation="knowledge.get_lightrag_config") from e


@router.put("/rag-pipelines/lightrag/config")
async def update_lightrag_pipeline_config(payload: LightRagConfigUpdate):
    """Persist LightRAG's query knobs. Takes effect on the next query."""
    try:
        from cognivoy.services.config import get_runtime_settings_service

        service = get_runtime_settings_service()
        current = service.load_lightrag()
        updates = payload.model_dump(exclude_none=True)
        return service.save_lightrag({**current, **updates})
    except Exception as e:
        logger.error(f"Error updating LightRAG config: {e}")
        raise internal_http_error(e, operation="knowledge.update_lightrag_config") from e


@router.get("/rag-pipelines/{provider}/preflight")
async def get_rag_pipeline_preflight(provider: str):
    """Check whether ``provider`` can run in the current environment.

    Returns ``{ok, checks:[{key,label,ok,detail,optional}]}`` — package
    install, API key, and active model requirements per engine.
    """
    try:
        from cognivoy.services.rag.preflight import engine_preflight

        return engine_preflight(provider)
    except Exception as e:
        logger.error(f"Error running preflight for '{provider}': {e}")
        raise internal_http_error(e, operation="knowledge.engine_preflight") from e


# Model kinds an engine page is allowed to read/switch. ``vision`` is not a
# catalog service (it rides on the active chat model), so it is intentionally
# excluded here.
_ENGINE_MODEL_KINDS = ("llm", "embedding")


def _model_options_payload(kinds: list[str]) -> dict:
    """Secret-free model options per kind for the engine page picker.

    Exposes only ids / display labels / dimensions — never provider URLs or
    API keys (those stay behind the admin-only catalog endpoint).
    """
    from cognivoy.services.config import get_model_catalog_service

    catalog = get_model_catalog_service().load()
    services = catalog.get("services", {})
    out: dict = {}
    for kind in kinds:
        svc = services.get(kind) or {}
        options = []
        for profile in svc.get("profiles", []) or []:
            pid = profile.get("id")
            pname = profile.get("name") or pid
            for model in profile.get("models", []) or []:
                detail = ""
                if kind == "embedding" and model.get("dimension"):
                    detail = f"{model.get('dimension')}d"
                options.append(
                    {
                        "profile_id": pid,
                        "profile_name": pname,
                        "model_id": model.get("id"),
                        "label": model.get("name") or model.get("model") or model.get("id"),
                        "model": model.get("model") or "",
                        "detail": detail,
                    }
                )
        out[kind] = {
            "active": {
                "profile_id": svc.get("active_profile_id"),
                "model_id": svc.get("active_model_id"),
            },
            "options": options,
        }
    return out


@router.get("/rag-pipelines/model-options")
async def get_rag_model_options(kinds: str = "llm,embedding"):
    """List configured models (secret-free) for the requested model kinds."""
    try:
        requested = [
            k.strip() for k in kinds.split(",") if k.strip() in _ENGINE_MODEL_KINDS
        ] or list(_ENGINE_MODEL_KINDS)
        return _model_options_payload(requested)
    except Exception as e:
        logger.error(f"Error reading model options: {e}")
        raise internal_http_error(e, operation="knowledge.get_model_options") from e


class ActiveModelUpdate(BaseModel):
    """Switch the globally-active model for a kind (llm / embedding)."""

    kind: str
    profile_id: str
    model_id: str


@router.put("/rag-pipelines/active-model")
async def set_rag_active_model(payload: ActiveModelUpdate):
    """Set the active model for an engine's required kind, applied immediately.

    This is the same active selection the model catalog manages; switching it
    here affects every engine that uses that kind (the active model is global).
    """
    if payload.kind not in _ENGINE_MODEL_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported model kind '{payload.kind}'. Choose one of: {', '.join(_ENGINE_MODEL_KINDS)}.",
        )
    try:
        from cognivoy.services.config import get_model_catalog_service

        service = get_model_catalog_service()
        catalog = service.load()
        svc = (catalog.get("services") or {}).get(payload.kind)
        if not svc:
            raise HTTPException(status_code=404, detail=f"No '{payload.kind}' models configured.")
        profile = next(
            (p for p in svc.get("profiles", []) if p.get("id") == payload.profile_id), None
        )
        if profile is None:
            raise HTTPException(status_code=400, detail="Unknown profile for this kind.")
        if not any(m.get("id") == payload.model_id for m in profile.get("models", [])):
            raise HTTPException(status_code=400, detail="Unknown model for this profile.")
        svc["active_profile_id"] = payload.profile_id
        svc["active_model_id"] = payload.model_id
        service.apply(catalog)
        return _model_options_payload([payload.kind])[payload.kind]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error setting active model: {e}")
        raise internal_http_error(e, operation="knowledge.set_active_model") from e


@router.get("/supported-file-types", response_model=SupportedFileTypesInfo)
async def get_supported_file_types():
    """Return the current upload policy so the web client stays in sync."""
    extensions = sorted(FileTypeRouter.get_supported_extensions())
    accept_items = extensions + [
        mime
        for extension, mime in sorted(IMAGE_ACCEPT_MIME_TYPES.items())
        if extension in FileTypeRouter.IMAGE_EXTENSIONS
    ]
    return SupportedFileTypesInfo(
        extensions=extensions,
        accept=",".join(dict.fromkeys(accept_items)),
        max_file_size_bytes=DocumentValidator.MAX_FILE_SIZE,
    )


@router.get("/configs")
async def get_all_kb_configs():
    """Get all knowledge base configurations from centralized config file."""
    try:
        from cognivoy.services.config import get_kb_config_service

        service = get_kb_config_service()
        return service.get_all_configs()
    except Exception as e:
        logger.error(f"Error getting KB configs: {e}")
        raise internal_http_error(e, operation="knowledge.list_configs") from e


@router.get("/{kb_name}/config")
async def get_kb_config(kb_name: str):
    """Get configuration for a specific knowledge base."""
    try:
        from cognivoy.services.config import get_kb_config_service

        service = get_kb_config_service()
        config = service.get_kb_config(kb_name)
        return {"kb_name": kb_name, "config": config}
    except Exception as e:
        logger.error(f"Error getting config for KB '{kb_name}': {e}")
        raise internal_http_error(e, operation="knowledge.get_config") from e


@router.put("/{kb_name}/config")
async def update_kb_config(kb_name: str, config: dict):
    """Update configuration for a specific knowledge base."""
    try:
        from cognivoy.services.config import get_kb_config_service
        from cognivoy.services.rag.index_probe import has_ready_provider_index

        manager, kb_name, kb_base_dir = _writable_kb(kb_name)
        config = dict(config or {})
        # Storage pointers, KB types, and lifecycle state are owned by the
        # registration/indexing flows. Accepting them here bypasses their
        # filesystem authorization and can turn a normal KB into a host path.
        if set(config) - {"rag_provider", "search_mode", "description"}:
            raise HTTPException(status_code=400, detail="Unsupported knowledge base setting")
        if "rag_provider" in config:
            requested_provider = _validate_registered_provider(config.get("rag_provider"))
            service = get_kb_config_service()
            current_config = service.get_kb_config(kb_name)
            current_provider = _validate_registered_provider(
                current_config.get("rag_provider") or DEFAULT_PROVIDER
            )
            if requested_provider != current_provider:
                kb_dir = kb_base_dir / kb_name
                if kb_dir.exists() and has_ready_provider_index(kb_dir, current_provider):
                    raise HTTPException(
                        status_code=409,
                        detail=(
                            f"Knowledge base '{kb_name}' already has a ready "
                            f"{current_provider} index. Provider changes require "
                            "an explicit re-index/migration instead of a silent config edit."
                        ),
                    )
                config["needs_reindex"] = True
                config["reindex_reason"] = "provider_changed"
                config.setdefault("status", "needs_reindex")
                config["progress"] = {
                    "stage": "needs_reindex",
                    "message": (
                        f"Provider changed from {current_provider} to {requested_provider}; "
                        "re-index this knowledge base before use."
                    ),
                    "percent": 0,
                    "timestamp": datetime.now().isoformat(),
                }
            config["rag_provider"] = requested_provider
        else:
            service = get_kb_config_service()

        service.set_kb_config(kb_name, config)
        return {"status": "success", "kb_name": kb_name, "config": service.get_kb_config(kb_name)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating config for KB '{kb_name}': {e}")
        raise internal_http_error(e, operation="knowledge.update_config") from e


@router.post("/configs/sync")
async def sync_configs_from_metadata():
    """Sync all KB configurations from their metadata.json files to centralized config."""
    try:
        from cognivoy.services.config import get_kb_config_service

        service = get_kb_config_service()
        service.sync_all_from_metadata(_current_kb_base_dir())
        return {"status": "success", "message": "Configurations synced from metadata files"}
    except Exception as e:
        logger.error(f"Error syncing configs: {e}")
        raise internal_http_error(e, operation="knowledge.sync_configs") from e


@router.get("/default")
async def get_default_kb():
    """Get the default knowledge base."""
    try:
        manager = get_kb_manager()
        default_kb = manager.get_default()
        return {"default_kb": default_kb}
    except Exception as e:
        logger.error(f"Error getting default KB: {e}")
        raise internal_http_error(e, operation="knowledge.get_default") from e


@router.put("/default/{kb_name}")
async def set_default_kb(kb_name: str):
    """Set the default knowledge base."""
    try:
        manager, kb_name, _ = _writable_kb(kb_name)

        # Verify KB exists
        if kb_name not in manager.list_knowledge_bases():
            raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")

        manager.set_default(kb_name)
        return {"status": "success", "default_kb": kb_name}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error setting default KB: {e}")
        raise internal_http_error(e, operation="knowledge.set_default") from e


class ConnectObsidianRequest(BaseModel):
    name: str
    vault_path: str


@router.post("/connect-obsidian")
async def connect_obsidian_vault(payload: ConnectObsidianRequest):
    """Connect an existing Obsidian vault as a knowledge base.

    Registers a pointer to the user's vault directory (``type: obsidian``) — no
    upload, no index. The vault must be a directory the server can reach (i.e. a
    local/self-hosted deployment); the Obsidian capability reads it live.
    """
    name = (payload.name or "").strip()
    vault_path = (payload.vault_path or "").strip()
    if not name or not vault_path:
        raise HTTPException(status_code=400, detail="Both name and vault_path are required.")
    try:
        folder = assert_path_allowed(vault_path)
        manager = get_kb_manager()
        entry = manager.register_obsidian_vault(name, str(folder))
        return {"status": "connected", "name": name, "vault_path": entry["vault_path"]}
    except ValueError as e:
        # Missing/invalid path, disallowed location, or a name clash → 400.
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error connecting Obsidian vault: {e}")
        raise internal_http_error(e, operation="knowledge.connect_obsidian") from e


class ProbeFolderRequest(BaseModel):
    folder_path: str
    rag_provider: str = DEFAULT_PROVIDER


class ConnectFolderRequest(BaseModel):
    name: str
    folder_path: str
    rag_provider: str = DEFAULT_PROVIDER


@router.post("/probe-folder")
async def probe_linked_folder_route(payload: ProbeFolderRequest):
    """Inspect a local folder for a ready engine index before linking it.

    Returns the probe verdict (ready index? embedding compatible? warnings?) so
    the UI can present and confirm before any registration happens. Does not
    create a knowledge base.
    """
    folder_path = (payload.folder_path or "").strip()
    if not folder_path:
        raise HTTPException(status_code=400, detail="folder_path is required.")
    try:
        folder = assert_path_allowed(folder_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    result = probe_linked_folder(str(folder), payload.rag_provider)
    return result.to_dict()


@router.post("/connect-folder")
async def connect_linked_folder_route(payload: ConnectFolderRequest):
    """Mount an existing engine index as a read-only ``linked`` knowledge base.

    Re-probes server-side (never trusts the client's verdict), then registers a
    pointer to the folder. Retrieval reads the index in place — no copy, no
    re-index. Embedding-mismatch warnings do not block the link (the user may
    switch embedding models later); a missing/invalid index does.
    """
    name = (payload.name or "").strip()
    folder_path = (payload.folder_path or "").strip()
    if not name or not folder_path:
        raise HTTPException(status_code=400, detail="Both name and folder_path are required.")
    try:
        folder = assert_path_allowed(folder_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    result = probe_linked_folder(str(folder), payload.rag_provider)
    if not result.ok:
        raise HTTPException(status_code=400, detail=result.error or "Folder is not linkable.")

    stats = {
        "embedding_model": result.embedding.index_model,
        "doc_count": result.doc_count,
    }
    try:
        manager = get_kb_manager()
        entry = manager.register_linked_kb(
            name,
            str(folder),
            result.provider,
            stats=stats,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error connecting linked folder: {e}")
        raise internal_http_error(e, operation="knowledge.connect_folder") from e

    return {
        "status": "connected",
        "name": name,
        "external_path": entry["external_path"],
        "rag_provider": entry["rag_provider"],
        "warnings": result.warnings,
    }


class ProbeLightRagServerRequest(BaseModel):
    server_url: str
    api_key: str = ""


class ConnectLightRagServerRequest(BaseModel):
    name: str
    server_url: str
    api_key: str = ""
    search_mode: str = ""


@router.post("/probe-lightrag-server")
async def probe_lightrag_server_route(payload: ProbeLightRagServerRequest):
    """Test-connect to an external LightRAG server before binding a KB to it.

    Returns the verdict (reachable? is it a LightRAG server? API key accepted?)
    so the UI can confirm before any registration happens. Creates nothing.
    """
    from cognivoy.services.rag.pipelines.lightrag_server.probe import probe_server

    server_url = (payload.server_url or "").strip()
    if not server_url:
        raise HTTPException(status_code=400, detail="server_url is required.")
    result = await probe_server(server_url, payload.api_key or "")
    return result.to_dict()


@router.post("/connect-lightrag-server")
async def connect_lightrag_server_route(payload: ConnectLightRagServerRequest):
    """Connect an external LightRAG server as a retrieval-only knowledge base.

    Re-probes server-side (never trusts the client's verdict), then registers a
    pointer (``type: lightrag_server``). Retrieval is offloaded to the server's
    ``/query`` endpoint — no copy, no local index.
    """
    from cognivoy.services.rag.pipelines.lightrag_server.config import SUPPORTED_MODES
    from cognivoy.services.rag.pipelines.lightrag_server.probe import probe_server

    name = (payload.name or "").strip()
    server_url = (payload.server_url or "").strip()
    if not name or not server_url:
        raise HTTPException(status_code=400, detail="Both name and server_url are required.")

    result = await probe_server(server_url, payload.api_key or "")
    if not result.ok:
        raise HTTPException(
            status_code=400, detail=result.error or "Could not connect to the LightRAG server."
        )

    search_mode = (payload.search_mode or "").strip().lower()
    if search_mode and search_mode not in SUPPORTED_MODES:
        search_mode = ""

    try:
        manager = get_kb_manager()
        entry = manager.register_lightrag_server_kb(
            name,
            result.base_url,
            api_key=payload.api_key or "",
            search_mode=search_mode,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error connecting LightRAG server: {e}")
        raise internal_http_error(e, operation="knowledge.connect_lightrag") from e

    return {
        "status": "connected",
        "name": name,
        "server_url": entry["server_url"],
        "rag_provider": entry["rag_provider"],
    }


class ProbeImaRequest(BaseModel):
    client_id: str
    api_key: str
    knowledge_base_id: str


class ConnectImaRequest(BaseModel):
    name: str
    client_id: str
    api_key: str
    knowledge_base_id: str


@router.post("/probe-ima")
async def probe_ima_route(payload: ProbeImaRequest):
    """Test-connect to a Tencent IMA knowledge base before binding a KB to it.

    Returns the verdict (credentials accepted? does the library id resolve, and
    what is it called?) so the UI can confirm before any registration happens.
    Creates nothing.
    """
    from cognivoy.services.rag.pipelines.ima.probe import probe_knowledge_base

    result = await probe_knowledge_base(
        payload.client_id,
        payload.api_key,
        payload.knowledge_base_id,
    )
    return result.to_dict()


@router.post("/connect-ima")
async def connect_ima_route(payload: ConnectImaRequest):
    """Connect a Tencent IMA knowledge base as a retrieval-only knowledge base.

    Re-probes server-side (never trusts the client's verdict), then registers a
    pointer (``type: ima``). Retrieval is offloaded to IMA's ``search_knowledge``
    OpenAPI — no copy, no local index.
    """
    from cognivoy.services.rag.pipelines.ima.probe import probe_knowledge_base

    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Knowledge base name is required.")

    result = await probe_knowledge_base(
        payload.client_id,
        payload.api_key,
        payload.knowledge_base_id,
    )
    if not result.ok:
        raise HTTPException(
            status_code=400,
            detail=result.error or "Could not connect to the IMA knowledge base.",
        )

    try:
        manager = get_kb_manager()
        entry = manager.register_ima_kb(
            name,
            payload.client_id,
            payload.api_key,
            payload.knowledge_base_id,
            description=result.description or "",
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error connecting IMA knowledge base: {e}")
        raise internal_http_error(e, operation="knowledge.connect_ima") from e

    return {
        "status": "connected",
        "name": name,
        "knowledge_base_id": entry["knowledge_base_id"],
        "rag_provider": entry["rag_provider"],
    }


@router.get("/list", response_model=list[KnowledgeBaseInfo])
async def list_knowledge_bases():
    """List all available knowledge bases with their details."""
    try:
        manager = get_kb_manager()
        kb_names = manager.list_knowledge_bases()
        default_name = manager.get_default(available_names=kb_names)
        access_items = list_visible_kb_access()
        access_by_id = {str(item.get("id") or ""): item for item in access_items}
        own_prefix = "admin:kb:" if get_current_user().is_admin else "user:kb:"

        logger.debug(f"Found {len(kb_names)} knowledge bases: {kb_names}")

        result = []
        errors = []

        for name in kb_names:
            try:
                info = manager.get_info(
                    name,
                    refresh_config=False,
                    default_name=default_name,
                )
                logger.debug(f"Successfully got info for KB '{name}': {info.get('statistics', {})}")
                result.append(
                    KnowledgeBaseInfo(
                        id=f"{own_prefix}{info['name']}",
                        name=info["name"],
                        is_default=info["is_default"],
                        statistics=info.get("statistics", {}),
                        metadata=info.get("metadata"),
                        path=info.get("path"),
                        status=info.get("status"),
                        progress=info.get("progress"),
                        source="admin" if get_current_user().is_admin else "user",
                        assigned=False,
                        read_only=False,
                        provenance_label=access_by_id.get(f"{own_prefix}{info['name']}", {}).get(
                            "provenance_label"
                        ),
                    )
                )
            except Exception as e:
                error_msg = f"Error getting info for KB '{name}': {e}"
                errors.append(error_msg)
                logger.warning(f"{error_msg}\n{traceback.format_exc()}")
                try:
                    kb_dir = manager.base_dir / name
                    if kb_dir.exists():
                        logger.debug(f"KB '{name}' directory exists, creating error fallback info")
                        fallback_progress = {
                            "stage": "error",
                            "message": "Failed to load knowledge base info.",
                            "error": error_msg,
                        }
                        result.append(
                            KnowledgeBaseInfo(
                                id=f"{own_prefix}{name}",
                                name=name,
                                is_default=name == default_name,
                                statistics={
                                    "raw_documents": 0,
                                    "images": 0,
                                    "content_lists": 0,
                                    "rag_initialized": False,
                                },
                                metadata={"name": name, "last_error": error_msg},
                                path=str(kb_dir),
                                status="error",
                                progress=fallback_progress,
                                source="admin" if get_current_user().is_admin else "user",
                            )
                        )
                except Exception as fallback_err:
                    logger.error(f"Fallback also failed for KB '{name}': {fallback_err}")

        if errors and not result:
            error_detail = f"Failed to load knowledge bases. Errors: {'; '.join(errors)}"
            logger.error(error_detail)
            raise internal_http_error(
                RuntimeError(error_detail),
                operation="knowledge.list",
            )

        if errors:
            logger.warning(
                f"Some KBs had errors, returning {len(result)} results. Errors: {errors}"
            )

        logger.debug(f"Returning {len(result)} knowledge bases")
        if not get_current_user().is_admin:
            assigned_snapshots: dict[str, str | None] = {}
            own_ids = {item.id for item in result}
            for access in access_items:
                if access.get("source") != "admin" or access.get("id") in own_ids:
                    continue
                if not access.get("available", True):
                    result.append(
                        KnowledgeBaseInfo(
                            id=str(access.get("id") or ""),
                            name=str(access.get("name") or ""),
                            is_default=False,
                            statistics={},
                            metadata={},
                            path=None,
                            status="unavailable",
                            progress=None,
                            source="admin",
                            assigned=True,
                            read_only=True,
                            provenance_label=str(access.get("provenance_label") or ""),
                            available=False,
                        )
                    )
                    continue
                resource = resolve_kb(str(access.get("id") or access.get("name") or ""))
                assigned_manager = manager_for_resource(resource)
                try:
                    manager_key = str(assigned_manager.base_dir.resolve())
                    if manager_key not in assigned_snapshots:
                        assigned_names = assigned_manager.list_knowledge_bases()
                        assigned_snapshots[manager_key] = assigned_manager.get_default(
                            available_names=assigned_names
                        )
                    info = assigned_manager.get_info(
                        resource.name,
                        refresh_config=False,
                        default_name=assigned_snapshots[manager_key],
                    )
                    result.append(
                        KnowledgeBaseInfo(
                            id=resource.id,
                            name=info["name"],
                            is_default=False,
                            statistics=info.get("statistics", {}),
                            metadata=info.get("metadata"),
                            path=None,
                            status=info.get("status"),
                            progress=info.get("progress"),
                            source="admin",
                            assigned=True,
                            read_only=True,
                            provenance_label=str(access.get("provenance_label") or ""),
                        )
                    )
                except Exception as exc:
                    error_msg = f"Error getting assigned KB '{resource.name}': {exc}"
                    result.append(
                        KnowledgeBaseInfo(
                            id=resource.id,
                            name=resource.name,
                            is_default=False,
                            statistics={},
                            metadata={"name": resource.name, "last_error": error_msg},
                            status="error",
                            progress={
                                "stage": "error",
                                "message": "Failed to load assigned knowledge base info.",
                                "error": error_msg,
                            },
                            source="admin",
                            assigned=True,
                            read_only=True,
                            provenance_label=str(access.get("provenance_label") or ""),
                        )
                    )
        return result
    except HTTPException:
        raise
    except Exception as e:
        error_msg = f"Error listing knowledge bases: {e}"
        logger.error(f"{error_msg}\n{traceback.format_exc()}")
        raise internal_http_error(e, operation="knowledge.list") from e


@router.get("/{kb_name}")
async def get_knowledge_base_details(kb_name: str):
    """Get detailed info for a specific KB."""
    try:
        resource = resolve_kb(kb_name)
        manager = manager_for_resource(resource)
        info = manager.get_info(resource.name)
        info.update(
            {
                "id": resource.id,
                "source": resource.source,
                "assigned": resource.assigned,
                "read_only": resource.read_only,
            }
        )
        if resource.assigned:
            info.pop("path", None)
        return info
    except HTTPException:
        raise
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")
    except Exception as e:
        raise internal_http_error(e, operation="knowledge.get_details") from e


@router.get("/{kb_name}/retrieval-health")
async def get_retrieval_health(kb_name: str):
    """Run a read-only retrieval readiness check without invoking a model.

    The report deliberately exposes stable, learner-actionable checks rather
    than provider storage paths or raw exception details. It verifies source
    presence, engine prerequisites, provider-owned index artifacts, freshness,
    and the persisted task state.
    """

    try:
        manager, resolved_name = _readable_kb(kb_name)
        entry = _load_kb_entry_or_404(manager, resolved_name)
        info = manager.get_info(resolved_name)
        statistics = info.get("statistics") or {}
        provider = normalize_provider_name(
            statistics.get("rag_provider") or entry.get("rag_provider")
        )
        connected = is_connected_kb(entry)
        checks: list[dict[str, object]] = []

        def add_check(
            key: str,
            label: str,
            ok: bool,
            detail: str,
            *,
            detail_key: str | None = None,
            parameters: dict[str, object] | None = None,
            optional: bool = False,
            action: dict | None = None,
        ) -> None:
            item: dict[str, object] = {
                "key": key,
                "label": label,
                "ok": bool(ok),
                "detail": detail,
                "detail_key": detail_key or detail,
                "optional": optional,
            }
            if parameters:
                item["parameters"] = parameters
            if action:
                item["action"] = action
            checks.append(item)

        if connected:
            connection_ok = str(info.get("status") or "").lower() not in {"error", "missing"}
            add_check(
                "connection",
                "Connected source",
                connection_ok,
                "The external knowledge source is registered."
                if connection_ok
                else "The external knowledge source is unavailable.",
                action=None
                if connection_ok
                else {"label": "Reconnect source", "href": "/knowledge"},
            )
        else:
            source_count = int(statistics.get("raw_documents") or 0)
            add_check(
                "source_documents",
                "Source documents",
                source_count > 0,
                f"{source_count} source document(s) found.",
                detail_key="{{count}} source document(s) found.",
                parameters={"count": source_count},
                action=None
                if source_count > 0
                else {"label": "Upload documents", "href": f"/knowledge?kb={resolved_name}"},
            )

            try:
                from cognivoy.services.rag.preflight import engine_preflight

                preflight = engine_preflight(provider)
                failed = [
                    check
                    for check in preflight.get("checks", [])
                    if not check.get("ok") and not check.get("optional")
                ]
                engine_ok = bool(preflight.get("ok")) and not failed
                engine_detail = (
                    "All required retrieval engine prerequisites are available."
                    if engine_ok
                    else "Required retrieval engine prerequisites are missing."
                )
            except Exception:
                logger.exception("Retrieval preflight failed for KB '%s'", resolved_name)
                engine_ok = False
                engine_detail = "The retrieval engine readiness check could not be completed."
            add_check(
                "engine_ready",
                "Retrieval engine",
                engine_ok,
                engine_detail,
                action=None if engine_ok else {"label": "Open settings", "href": "/settings"},
            )

            index_ready = bool(
                statistics.get("active_match")
                if provider_uses_embedding_versions(provider)
                else statistics.get("rag_initialized")
            )
            add_check(
                "active_index",
                "Active index",
                index_ready,
                "The active index has queryable provider artifacts."
                if index_ready
                else "No queryable index matches the active retrieval configuration.",
                action=None
                if index_ready
                else {"label": "Re-index", "href": f"/knowledge?kb={resolved_name}"},
            )

            fresh = not bool(statistics.get("needs_reindex"))
            add_check(
                "index_freshness",
                "Index freshness",
                fresh,
                "The index is synchronized with its source documents."
                if fresh
                else "Source documents changed after the last successful index.",
                action=None
                if fresh
                else {"label": "Re-index", "href": f"/knowledge?kb={resolved_name}"},
            )

        status = str(info.get("status") or "unknown").lower()
        task_ok = status not in {"error", "initializing", "processing"}
        add_check(
            "task_state",
            "Index task state",
            task_ok,
            f"Current knowledge-base state: {status}.",
            detail_key="Current knowledge-base state: {{status}}.",
            parameters={"status": status},
            action=None
            if task_ok
            else {"label": "Review diagnostics", "href": f"/knowledge?kb={resolved_name}"},
        )
        required = [check for check in checks if not check["optional"]]
        ready = all(bool(check["ok"]) for check in required)
        report = {
            "knowledge_base": resolved_name,
            "provider": provider,
            "ready": ready,
            "checked_at": datetime.now().astimezone().isoformat(),
            "checks": checks,
        }
        _record_project_retrieval_health(
            requested_name=kb_name,
            resolved_name=resolved_name,
            info=info,
            ready=ready,
            checks=checks,
        )
        return report
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")
    except Exception as exc:
        raise internal_http_error(exc, operation="knowledge.retrieval_health") from exc


def _retrieval_probe_terms(text: str) -> tuple[str, set[str]]:
    normalized = " ".join(str(text or "").split())
    if not normalized:
        return "", set()
    candidates = [
        part.strip()
        for part in re.split(r"(?<=[。！？.!?])\s*|\n+", normalized)
        if len(part.strip()) >= 40
    ]
    excerpt = (candidates[0] if candidates else normalized)[:280]
    folded = re.sub(r"\s+", "", excerpt).casefold()
    terms = {folded[index : index + 3] for index in range(max(0, len(folded) - 2))}
    return excerpt, terms


@router.post("/{kb_name}/retrieval-quality")
async def run_retrieval_quality_probe(kb_name: str):
    """Sample one source passage and verify that the active index recalls it.

    This is deliberately retrieval-only: it does not ask an LLM to grade its
    own answer. The score combines passage overlap and source-file attribution,
    making the result repeatable, bounded, and useful even when no chat model is
    configured.
    """

    try:
        manager, resolved_name = _readable_kb(kb_name)
        entry = _load_kb_entry_or_404(manager, resolved_name)
        if is_connected_kb(entry):
            raise HTTPException(
                status_code=409,
                detail="Retrieval quality sampling requires a locally managed source document.",
            )
        raw_dir = manager.get_knowledge_base_path(resolved_name) / "raw"
        files = [
            path
            for path in FileTypeRouter.collect_supported_files(raw_dir, recursive=True)
            if path.is_file()
        ]
        if not files:
            raise HTTPException(
                status_code=409, detail="Upload a readable document before running a quality probe."
            )
        files.sort(key=lambda path: path.relative_to(raw_dir).as_posix().casefold())
        day_key = datetime.now().astimezone().date().isoformat()
        sample_index = int(
            hashlib.sha256(f"{resolved_name}:{day_key}".encode()).hexdigest()[:8], 16
        ) % len(files)
        sample = files[sample_index]
        extracted = extract_text_from_path(
            sample,
            max_bytes=DocumentValidator.MAX_FILE_SIZE,
            max_chars=min(MAX_EXTRACTED_CHARS_PER_DOC, 20_000),
        )
        excerpt, expected_terms = _retrieval_probe_terms(extracted)
        if not excerpt or not expected_terms:
            raise HTTPException(
                status_code=422, detail="The sampled document did not contain enough readable text."
            )

        from cognivoy.services.rag.service import RAGService

        result = await RAGService(kb_base_dir=str(manager.base_dir)).search(
            excerpt,
            resolved_name,
            top_k=5,
        )
        if (
            result.get("success") is False
            or result.get("error")
            or result.get("error_type")
            or result.get("needs_reindex")
        ):
            return {
                "knowledge_base": resolved_name,
                "sample_source": sample.relative_to(raw_dir).as_posix(),
                "question": f"Locate the passage that explains: {excerpt[:120]}",
                "score": 0.0,
                "quality": "unavailable",
                "source_matched": False,
                "passage_overlap": 0.0,
                "retrieved_count": 0,
                "recommendations": [
                    "Re-index the knowledge base and verify the retrieval engine settings."
                ],
            }
        sources = [item for item in (result.get("sources") or []) if isinstance(item, dict)]
        retrieved = " ".join(
            [str(result.get("content") or result.get("answer") or "")]
            + [str(item.get("content") or "") for item in sources]
        )
        retrieved_folded = re.sub(r"\s+", "", retrieved).casefold()
        overlap = (
            sum(1 for term in expected_terms if term in retrieved_folded) / len(expected_terms)
            if retrieved_folded
            else 0.0
        )
        sample_name = sample.name.casefold()
        source_matched = any(
            sample_name in str(item.get("source") or item.get("title") or "").casefold()
            for item in sources
        )
        score = round(min(1.0, overlap * 0.8 + (0.2 if source_matched else 0.0)), 3)
        quality = "good" if score >= 0.7 else "partial" if score >= 0.35 else "poor"
        recommendations: list[str] = []
        if overlap < 0.6:
            recommendations.append(
                "Re-index after checking chunk size and embedding configuration."
            )
        if not source_matched:
            recommendations.append(
                "Inspect source metadata so citations can return to the original file."
            )
        if not recommendations:
            recommendations.append(
                "Retrieval recalled the sampled passage with usable source attribution."
            )
        return {
            "knowledge_base": resolved_name,
            "sample_source": sample.relative_to(raw_dir).as_posix(),
            "question": f"Locate the passage that explains: {excerpt[:120]}",
            "score": score,
            "quality": quality,
            "source_matched": source_matched,
            "passage_overlap": round(overlap, 3),
            "retrieved_count": len(sources),
            "recommendations": recommendations,
        }
    except HTTPException:
        raise
    except DocumentExtractionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise internal_http_error(exc, operation="knowledge.retrieval_quality") from exc


@router.post("/{kb_name}/index-fragments")
async def inspect_index_fragments(kb_name: str, request: IndexFragmentsRequest):
    """Expose bounded real retrieval hits for index diagnosis.

    This is intentionally a retrieval workbench, not a raw vector-store dump:
    it exercises the same provider and active index used by Chat while
    returning only source metadata and a short text excerpt.
    """

    query = request.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="Enter a query to inspect index fragments.")
    top_k = min(20, max(1, int(request.top_k)))
    manager, resolved_name = _readable_kb(kb_name)
    _load_kb_entry_or_404(manager, resolved_name)
    try:
        from cognivoy.services.rag.service import RAGService

        result = await RAGService(kb_base_dir=str(manager.base_dir)).search(
            query,
            resolved_name,
            top_k=top_k,
        )
        if (
            result.get("success") is False
            or result.get("error")
            or result.get("error_type")
            or result.get("needs_reindex")
        ):
            raise HTTPException(
                status_code=409,
                detail="The active index is unavailable. Re-index the knowledge base first.",
            )
        fragments: list[dict[str, object]] = []
        for index, source in enumerate(result.get("sources") or []):
            if not isinstance(source, dict):
                continue
            content = str(
                source.get("content") or source.get("text") or source.get("snippet") or ""
            ).strip()
            fragments.append(
                {
                    "rank": index + 1,
                    "source": str(source.get("source") or source.get("title") or "Unknown"),
                    "page": source.get("page") or source.get("page_number"),
                    "section": source.get("section") or source.get("heading"),
                    "score": source.get("score") or source.get("similarity"),
                    "content": content[:2_000],
                    "metadata": {
                        key: value
                        for key, value in source.items()
                        if key
                        not in {
                            "content",
                            "text",
                            "snippet",
                            "embedding",
                            "vector",
                        }
                        and isinstance(value, (str, int, float, bool, type(None)))
                    },
                }
            )
        return {
            "knowledge_base": resolved_name,
            "query": query,
            "requested_top_k": top_k,
            "fragment_count": len(fragments),
            "fragments": fragments,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise internal_http_error(exc, operation="knowledge.index_fragments") from exc


def _resolve_kb_raw_dir(kb_name: str, *, allow_unsupported: bool = False) -> Path | None:
    """Resolve a KB's managed ``raw/`` directory without inventing one.

    Connected KBs are external-resource pointers and intentionally have no
    Cognivoy-managed raw directory.  File listing treats that as an empty
    collection for backwards compatibility; endpoints that require a local
    file receive an explicit conflict response.
    """
    manager = _overridden_kb_manager()
    if manager is not None:
        resolved_name = _resolve_registered_kb_name(manager, kb_name)
    else:
        resource = resolve_kb(kb_name)
        manager = manager_for_resource(resource)
        resolved_name = resource.name

    kb_entry = _load_kb_entry_or_404(manager, resolved_name)
    if not supports_local_raw_files(kb_entry):
        if allow_unsupported:
            return None
        raise HTTPException(
            status_code=409,
            detail=(
                f"Knowledge base '{resolved_name}' is connected to an external resource "
                "and has no local files."
            ),
        )

    kb_path = manager.get_knowledge_base_path(resolved_name)
    return kb_path / "raw"


def _resolve_kb_raw_file_or_404(kb_name: str, filename: str) -> Path:
    """Resolve a raw KB file while preventing traversal outside raw/."""
    raw_dir = _resolve_kb_raw_dir(kb_name)
    assert raw_dir is not None  # allow_unsupported=False guarantees a path
    if not raw_dir.exists():
        raise HTTPException(status_code=404, detail="File not found")

    raw_resolved = raw_dir.resolve()
    target = (raw_dir / filename).resolve()
    try:
        target.relative_to(raw_resolved)
    except ValueError:
        raise HTTPException(status_code=403, detail="Access denied")

    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return target


@router.get("/{kb_name}/files")
async def list_kb_raw_files(kb_name: str):
    """List raw documents under <kb>/raw/, recursing into folders.

    ``name`` is the POSIX path relative to ``raw/`` so the web client can
    rebuild the folder tree. Folders (including empty ones) are returned as
    ``type: "folder"`` entries so user-created/uploaded structure shows even
    before it holds any files. Folders are purely organizational and have no
    effect on indexing or retrieval.
    """
    raw_dir = _resolve_kb_raw_dir(kb_name, allow_unsupported=True)
    if raw_dir is None:
        return {"files": []}
    if not raw_dir.exists() or not raw_dir.is_dir():
        return {"files": []}

    files = []
    for entry in sorted(raw_dir.rglob("*"), key=lambda p: str(p).lower()):
        rel = entry.relative_to(raw_dir).as_posix()
        if entry.is_dir():
            files.append({"name": rel, "type": "folder"})
            continue
        if not entry.is_file():
            continue
        try:
            stat = entry.stat()
        except OSError:
            continue
        media_type, _ = mimetypes.guess_type(entry.name)
        files.append(
            {
                "name": rel,
                "type": "file",
                "size": stat.st_size,
                "modified": stat.st_mtime,
                "mime_type": media_type,
            }
        )
    return {"files": files}


class CreateFolderPayload(BaseModel):
    path: str


class MoveFilePayload(BaseModel):
    source: str
    dest_folder: str = ""


@router.post("/{kb_name}/folders")
async def create_kb_folder(kb_name: str, payload: CreateFolderPayload):
    """Create an (organizational) folder under <kb>/raw/. No retrieval effect."""
    manager, kb_name, _ = _writable_kb(kb_name)
    _assert_kb_writable_or_409(kb_name, _load_kb_entry_or_404(manager, kb_name))
    raw_dir = manager.get_knowledge_base_path(kb_name) / "raw"
    subdir = _sanitize_rel_subdir(payload.path)
    if not subdir:
        raise HTTPException(status_code=400, detail="Folder name is required")
    target = _safe_join_raw(raw_dir, subdir)
    target.mkdir(parents=True, exist_ok=True)
    return {"status": "ok", "path": subdir}


@router.post("/{kb_name}/files/move")
async def move_kb_file(kb_name: str, payload: MoveFilePayload):
    """Move a file/folder between organizational folders (display only).

    Moving never re-indexes: folders don't affect retrieval, so this is a pure
    filesystem relocation under ``raw/``.
    """
    manager, kb_name, _ = _writable_kb(kb_name)
    _assert_kb_writable_or_409(kb_name, _load_kb_entry_or_404(manager, kb_name))
    raw_dir = manager.get_knowledge_base_path(kb_name) / "raw"

    source_rel = _sanitize_rel_subdir(payload.source)
    if not source_rel:
        raise HTTPException(status_code=400, detail="Source path is required")
    src = _safe_join_raw(raw_dir, source_rel)
    if not src.exists():
        raise HTTPException(status_code=404, detail="Source not found")

    dest_folder = _sanitize_rel_subdir(payload.dest_folder)
    dest_dir = _safe_join_raw(raw_dir, dest_folder) if dest_folder else raw_dir.resolve()
    dest = dest_dir / src.name

    if dest.resolve() == src.resolve():
        return {"status": "ok", "path": source_rel}
    if src.is_dir() and dest_dir.resolve().is_relative_to(src.resolve()):
        raise HTTPException(status_code=400, detail="Cannot move a folder into itself")
    if dest.exists():
        raise HTTPException(
            status_code=409,
            detail=f"'{src.name}' already exists in the target folder",
        )

    dest_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dest))
    return {"status": "ok", "path": dest.relative_to(raw_dir.resolve()).as_posix()}


@router.get("/{kb_name}/file-preview-text/{filename:path}")
async def serve_kb_raw_file_text_preview(kb_name: str, filename: str):
    """Serve extracted plain text for a raw KB document preview."""
    target = _resolve_kb_raw_file_or_404(kb_name, filename)
    try:
        text = extract_text_from_path(
            target,
            max_bytes=DocumentValidator.MAX_FILE_SIZE,
            max_chars=MAX_EXTRACTED_CHARS_PER_DOC,
        )
    except DocumentExtractionError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=404, detail="File not found") from exc

    return PlainTextResponse(text, media_type="text/plain; charset=utf-8")


@router.get("/{kb_name}/file-preview-slides/{filename:path}")
async def serve_kb_pptx_slide_preview(kb_name: str, filename: str):
    """Return a bounded, layout-preserving preview for a PPTX document."""
    from cognivoy.utils.pptx_preview import PptxPreviewError, build_pptx_preview

    if Path(filename).suffix.lower() != ".pptx":
        raise HTTPException(
            status_code=415,
            detail="Slide preview is only available for PPTX presentations",
        )
    target = _resolve_kb_raw_file_or_404(kb_name, filename)
    try:
        return build_pptx_preview(target)
    except PptxPreviewError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/{kb_name}/files/{filename:path}")
async def serve_kb_raw_file(kb_name: str, filename: str):
    """Serve a single raw document for inline preview / download.

    Resolution is sandboxed to the KB's raw/ directory; any path that
    escapes via traversal yields 403.
    """
    target = _resolve_kb_raw_file_or_404(kb_name, filename)
    media_type, _ = mimetypes.guess_type(target.name)
    return FileResponse(
        target,
        media_type=media_type or "application/octet-stream",
        filename=target.name,
        content_disposition_type="inline",
    )


@router.delete("/{kb_name}/files/{filename:path}")
async def delete_kb_file(kb_name: str, filename: str):
    """Remove a single raw document from a knowledge base.

    Unlike deleting the whole KB, this works while the KB is in an *error*
    state — that is the point: a file that failed to parse (e.g. one that
    exceeds the cloud parser's page limit) can be dropped without deleting and
    rebuilding everything. Connected (read-only) and legacy KBs are still
    rejected. Vectors are not pruned here; ``was_indexed`` tells the caller
    whether a re-index is needed to purge the file from retrieval.
    """
    manager, kb_name, _ = _writable_kb(kb_name)
    _assert_kb_writable_or_409(kb_name, _load_kb_entry_or_404(manager, kb_name))
    target = _resolve_kb_raw_file_or_404(kb_name, filename)

    kb_dir = manager.get_knowledge_base_path(kb_name)
    keyword_source_indexed = False
    from cognivoy.services.rag.pipelines.llamaindex.config import keyword_enabled

    kb_entry = manager.config.get("knowledge_bases", {}).get(kb_name) or {}
    if (
        normalize_provider_name(kb_entry.get("rag_provider")) == DEFAULT_PROVIDER
        and keyword_enabled()
    ):
        from cognivoy.services.rag.pipelines.llamaindex.keyword import load_rows

        # Full keyword builds need no embedding ledger, so the old incremental
        # file-hash ledger alone cannot tell whether deleting a source is stale.
        try:
            keyword_source_indexed = any(
                (Path(str(row["metadata"]["file_path"])).resolve() == target.resolve())
                if row["metadata"].get("file_path")
                else row["metadata"].get("file_name") == target.name
                for row in load_rows(Path(kb_dir))
            )
        except (OSError, ValueError, TypeError, KeyError):
            keyword_source_indexed = True  # A broken index also needs rebuilding.
    removal = remove_raw_document(Path(kb_dir), target)
    was_indexed = removal.was_indexed or keyword_source_indexed
    if was_indexed:
        kb_entry["needs_reindex"] = True
        kb_entry["reindex_reason"] = "source_changed"
        manager._save_config()
    return {
        "status": "ok",
        "path": removal.rel_path,
        "was_indexed": was_indexed,
    }


@router.get("/references/deleted")
async def list_deleted_knowledge_references():
    """Tombstones let historical sessions and notebooks label stale sources."""
    return {"knowledge_bases": get_knowledge_reference_service().list_tombstones()}


@router.get("/{kb_name}/deletion-impact")
async def get_knowledge_base_deletion_impact(kb_name: str):
    _manager, resolved_name, _path = _writable_kb(kb_name)
    return get_knowledge_reference_service().build_impact(resolved_name)


@router.delete("/{kb_name}")
async def delete_knowledge_base(
    kb_name: str,
    confirmation_token: str | None = Query(default=None),
):
    """Delete a knowledge base."""
    try:
        manager, resolved_name, _ = _writable_kb(kb_name)
        references = get_knowledge_reference_service()
        impact = references.build_impact(resolved_name)
        expected = str(impact["confirmation_token"])
        if not confirmation_token or not hmac.compare_digest(confirmation_token, expected):
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "knowledge_deletion_confirmation_required",
                    "message": "Review the current deletion impact before confirming.",
                    "impact": impact,
                },
            )
        success = manager.delete_knowledge_base(resolved_name, confirm=True)
        if not success:
            raise HTTPException(status_code=400, detail="Failed to delete knowledge base")
        references.record_deletion(resolved_name, impact=impact)
        logger.info(f"KB '{kb_name}' deleted")
        return {
            "message": f"Knowledge base '{kb_name}' deleted successfully",
            "tombstone": references.get_tombstone(resolved_name),
        }
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")
    except Exception as e:
        raise internal_http_error(e, operation="knowledge.delete") from e


@router.get("/tasks/{task_id}/stream")
async def stream_task_logs(task_id: str):
    """Stream task-specific logs for knowledge-base operations."""
    manager = get_task_stream_manager()
    manager.ensure_task(task_id)
    return StreamingResponse(
        manager.stream(task_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/{kb_name}/upload-preflight")
async def preflight_upload_files(kb_name: str, request: UploadPreflightRequest):
    """Report path and byte-identical duplicates before upload mutation.

    The client may provide SHA-256 values so content duplicates can be found
    even when their filenames differ.  Omitting hashes still provides the
    safety-critical same-path check used by the upload endpoint itself.
    """

    manager, resolved_name, _ = _writable_kb(kb_name)
    entry = _load_kb_entry_or_404(manager, resolved_name)
    _assert_kb_writable_or_409(resolved_name, entry)
    raw_dir = manager.get_knowledge_base_path(resolved_name) / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)

    existing_hashes: dict[str, list[str]] = {}
    supplied_hashes = {
        str(item.sha256 or "").lower()
        for item in request.files
        if re.fullmatch(r"[0-9a-fA-F]{64}", str(item.sha256 or ""))
    }
    if supplied_hashes:
        for path in FileTypeRouter.collect_supported_files(raw_dir, recursive=True):
            if not path.is_file():
                continue
            digest = await asyncio.to_thread(_sha256_path, path)
            if digest in supplied_hashes:
                existing_hashes.setdefault(digest, []).append(path.relative_to(raw_dir).as_posix())

    results: list[dict[str, object]] = []
    for item in request.files:
        relative_path = _upload_relative_path(item.name, item.relative_path)
        target = _safe_join_raw(raw_dir, relative_path)
        sha256 = str(item.sha256 or "").lower()
        same_content = existing_hashes.get(sha256, []) if sha256 else []
        results.append(
            {
                "name": item.name,
                "relative_path": relative_path,
                "path_exists": target.is_file(),
                "existing_size_bytes": target.stat().st_size if target.is_file() else None,
                "same_content_paths": same_content,
                "suggested_rename": (
                    _renamed_upload_path(raw_dir, relative_path) if target.exists() else None
                ),
            }
        )
    return {
        "knowledge_base": resolved_name,
        "has_duplicates": any(
            bool(item["path_exists"] or item["same_content_paths"]) for item in results
        ),
        "files": results,
    }


@router.post("/{kb_name}/uploads/resumable")
async def create_resumable_upload(kb_name: str, request: ResumableUploadCreateRequest):
    """Create a durable upload session whose offset survives page reloads."""

    manager, resolved_name, _ = _writable_kb(kb_name)
    entry = _load_kb_entry_or_404(manager, resolved_name)
    _assert_kb_writable_or_409(resolved_name, entry)
    await asyncio.to_thread(_cleanup_expired_upload_sessions, manager, resolved_name)
    if request.size_bytes <= 0 or request.size_bytes > DocumentValidator.MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File size must be between 1 byte and {DocumentValidator.MAX_FILE_SIZE} bytes.",
        )
    allowed_extensions = FileTypeRouter.get_supported_extensions()
    relative_path = _upload_relative_path(request.name, request.relative_path)
    DocumentValidator.validate_upload_safety(
        Path(relative_path).name,
        request.size_bytes,
        allowed_extensions=allowed_extensions,
    )
    sha256 = str(request.sha256 or "").lower() or None
    if sha256 and not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise HTTPException(
            status_code=400, detail="sha256 must be a 64-character hexadecimal digest."
        )
    session_id = uuid4().hex
    metadata_path, part_path = _upload_session_paths(manager, resolved_name, session_id)
    metadata: dict[str, object] = {
        "session_id": session_id,
        "knowledge_base": resolved_name,
        "relative_path": relative_path,
        "size_bytes": request.size_bytes,
        "sha256": sha256,
        "offset": 0,
        "created_at": datetime.now().isoformat(),
        "updated_at": datetime.now().isoformat(),
    }
    atomic_write_json(metadata_path, metadata)
    part_path.touch(exist_ok=False)
    return metadata


@router.post("/{kb_name}/uploads/resumable/cleanup")
async def cleanup_resumable_uploads(kb_name: str):
    manager, resolved_name, _ = _writable_kb(kb_name)
    removed = await asyncio.to_thread(
        _cleanup_expired_upload_sessions,
        manager,
        resolved_name,
    )
    return {"removed_session_ids": removed, "removed_count": len(removed)}


@router.get("/{kb_name}/uploads/resumable/{session_id}")
async def get_resumable_upload(kb_name: str, session_id: str):
    manager, resolved_name, _ = _writable_kb(kb_name)
    metadata, _, part_path = _load_upload_session(manager, resolved_name, session_id)
    metadata["offset"] = part_path.stat().st_size if part_path.exists() else 0
    return metadata


@router.put("/{kb_name}/uploads/resumable/{session_id}")
async def append_resumable_upload(
    kb_name: str,
    session_id: str,
    chunk: UploadFile = File(...),
    offset: int = Form(...),
):
    manager, resolved_name, _ = _writable_kb(kb_name)
    metadata, metadata_path, part_path = _load_upload_session(manager, resolved_name, session_id)
    next_offset = await asyncio.to_thread(_append_upload_chunk, part_path, offset, chunk)
    expected_size = int(metadata.get("size_bytes") or 0)
    if next_offset > expected_size:
        part_path.unlink(missing_ok=True)
        metadata_path.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Uploaded bytes exceed the declared file size.")
    metadata["offset"] = next_offset
    metadata["updated_at"] = datetime.now().isoformat()
    atomic_write_json(metadata_path, metadata)
    return {
        "session_id": session_id,
        "offset": next_offset,
        "complete": next_offset == expected_size,
    }


@router.post("/{kb_name}/uploads/resumable/{session_id}/complete")
async def complete_resumable_upload(
    kb_name: str,
    session_id: str,
    request: ResumableUploadCompleteRequest,
):
    manager, resolved_name, _ = _writable_kb(kb_name)
    metadata, metadata_path, part_path = _load_upload_session(manager, resolved_name, session_id)
    expected_size = int(metadata.get("size_bytes") or 0)
    actual_size = part_path.stat().st_size if part_path.exists() else 0
    if actual_size != expected_size:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "upload_incomplete",
                "message": "The upload is incomplete; continue from the server offset.",
                "offset": actual_size,
                "size_bytes": expected_size,
            },
        )
    expected_hash = str(metadata.get("sha256") or "")
    if expected_hash:
        actual_hash = await asyncio.to_thread(_sha256_path, part_path)
        if not hmac.compare_digest(actual_hash, expected_hash):
            raise HTTPException(status_code=422, detail="Uploaded file checksum did not match.")

    strategy = request.duplicate_strategy.strip().lower()
    if strategy not in {"error", "skip", "replace", "rename"}:
        raise HTTPException(status_code=400, detail="Invalid duplicate strategy.")
    raw_dir = manager.get_knowledge_base_path(resolved_name) / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    relative_path = str(metadata.get("relative_path") or "")
    target = _safe_join_raw(raw_dir, relative_path)
    final_path = relative_path
    if target.exists():
        if strategy == "error":
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "knowledge_duplicate_files",
                    "message": "The file already exists. Choose skip, replace, or rename.",
                    "files": [relative_path],
                },
            )
        if strategy == "skip":
            part_path.unlink(missing_ok=True)
            metadata_path.unlink(missing_ok=True)
            return {"session_id": session_id, "path": relative_path, "skipped": True}
        if strategy == "rename":
            final_path = _renamed_upload_path(raw_dir, relative_path)
            target = _safe_join_raw(raw_dir, final_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(part_path, target)
    metadata_path.unlink(missing_ok=True)
    return {"session_id": session_id, "path": final_path, "skipped": False}


@router.delete("/{kb_name}/uploads/resumable/{session_id}")
async def cancel_resumable_upload(kb_name: str, session_id: str):
    manager, resolved_name, _ = _writable_kb(kb_name)
    _, metadata_path, part_path = _load_upload_session(manager, resolved_name, session_id)
    part_path.unlink(missing_ok=True)
    metadata_path.unlink(missing_ok=True)
    return {"session_id": session_id, "status": "cancelled"}


@router.post("/{kb_name}/uploads/resumable/process")
async def process_resumable_uploads(
    kb_name: str,
    request: ResumableUploadProcessRequest,
):
    """Start one indexing task after a resumable batch has fully landed."""

    manager, resolved_name, kb_base_dir = _writable_kb(kb_name)
    entry = _load_kb_entry_or_404(manager, resolved_name)
    _assert_kb_writable_or_409(resolved_name, entry)
    provider = _validate_registered_provider(entry.get("rag_provider") or DEFAULT_PROVIDER)
    _assert_index_preflight(provider)
    _assert_provider_ready(provider)
    raw_dir = manager.get_knowledge_base_path(resolved_name) / "raw"
    paths = list(dict.fromkeys(str(path).strip() for path in request.paths if str(path).strip()))
    if not paths:
        return {"message": "No new files require indexing.", "task_id": None, "noop": True}
    uploaded_paths: list[str] = []
    uploaded_files: list[str] = []
    for relative_path in paths:
        target = _safe_join_raw(raw_dir, relative_path)
        if not target.is_file():
            raise HTTPException(
                status_code=404, detail=f"Uploaded file '{relative_path}' was not found."
            )
        uploaded_paths.append(str(target))
        uploaded_files.append(relative_path)
    task_id = _build_unique_task_id("kb_upload", resolved_name)
    get_task_stream_manager().ensure_task(task_id)
    _mark_kb_queued_for_processing(
        manager,
        resolved_name,
        task_id,
        f"Processing {len(uploaded_files)} uploaded file(s)...",
    )
    _start_knowledge_task(
        task_id,
        resolved_name,
        run_upload_processing_task(
            kb_name=resolved_name,
            base_dir=str(kb_base_dir),
            uploaded_file_paths=uploaded_paths,
            task_id=task_id,
            rag_provider=provider,
        ),
    )
    return {
        "message": f"Uploaded {len(uploaded_files)} files. Processing in background.",
        "files": uploaded_files,
        "task_id": task_id,
    }


@router.post("/{kb_name}/upload")
async def upload_files(
    kb_name: str,
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    rag_provider: str = Form(None),
    rel_paths: list[str] = Form(None),
    duplicate_strategy: str = Form("error"),
):
    """Upload files to a knowledge base and process them in background."""
    try:
        manager, kb_name, kb_base_dir = _writable_kb(kb_name)
        requested_provider = None
        if rag_provider is not None and str(rag_provider).strip():
            requested_provider = _validate_registered_provider(rag_provider)

        kb_entry = _load_kb_entry_or_404(manager, kb_name)
        _assert_kb_writable_or_409(kb_name, kb_entry)
        kb_path = manager.get_knowledge_base_path(kb_name)
        raw_dir = kb_path / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        kb_provider = _validate_registered_provider(
            kb_entry.get("rag_provider") or DEFAULT_PROVIDER
        )
        if requested_provider and requested_provider != kb_provider:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Requested provider '{requested_provider}' does not match KB provider '{kb_provider}'. "
                    "A knowledge base is locked to the engine it was created with."
                ),
            )
        _assert_index_preflight(kb_provider)
        _assert_provider_ready(kb_provider)
        _enforce_provider_formats(kb_provider, files)
        allowed_extensions = FileTypeRouter.get_supported_extensions()
        # ``.zip`` is accepted as an upload container; its members are
        # validated against ``allowed_extensions`` during extraction and the
        # archive itself is never indexed (``safe_extract_zip`` skips ``.zip``).
        upload_extensions = allowed_extensions | {".zip"}
        strategy = str(duplicate_strategy or "error").strip().lower()
        if strategy not in {"error", "skip", "replace", "rename"}:
            raise HTTPException(
                status_code=400,
                detail="duplicate_strategy must be one of: error, skip, replace, rename",
            )
        validated = _validate_upload_batch(
            files, allowed_extensions=upload_extensions, rel_paths=rel_paths
        )
        selected_files: list[UploadFile] = []
        selected_rel_paths: list[str] = []
        skipped_files: list[str] = []
        renamed_files: dict[str, str] = {}
        for index, metadata in enumerate(validated):
            relative_path = str(metadata["path"])
            target = _safe_join_raw(raw_dir, relative_path)
            if target.exists():
                if strategy == "error":
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "code": "knowledge_duplicate_files",
                            "message": "One or more files already exist. Choose skip, replace, or rename.",
                            "files": [relative_path],
                        },
                    )
                if strategy == "skip":
                    skipped_files.append(relative_path)
                    continue
                if strategy == "rename":
                    renamed = _renamed_upload_path(raw_dir, relative_path)
                    renamed_files[relative_path] = renamed
                    files[index].filename = Path(renamed).name
                    relative_path = renamed
            selected_files.append(files[index])
            selected_rel_paths.append(relative_path)

        if not selected_files:
            return {
                "message": "No files were uploaded because every selected file was skipped.",
                "files": [],
                "skipped_files": skipped_files,
                "renamed_files": renamed_files,
                "task_id": None,
                "noop": True,
            }
        uploaded_files, uploaded_file_paths = await _save_uploaded_files_off_loop(
            selected_files,
            raw_dir,
            allowed_extensions=upload_extensions,
            rel_paths=selected_rel_paths,
        )
        task_id = _build_unique_task_id("kb_upload", kb_name)
        get_task_stream_manager().ensure_task(task_id)

        logger.info(f"Uploading {len(uploaded_files)} files to KB '{kb_name}'")

        _mark_kb_queued_for_processing(
            manager,
            kb_name,
            task_id,
            f"Processing {len(uploaded_files)} uploaded file(s)...",
        )

        _start_knowledge_task(
            task_id,
            kb_name,
            run_upload_processing_task(
                kb_name=kb_name,
                base_dir=str(kb_base_dir),
                uploaded_file_paths=uploaded_file_paths,
                task_id=task_id,
                rag_provider=kb_provider,
            ),
        )

        return {
            "message": f"Uploaded {len(uploaded_files)} files. Processing in background.",
            "files": uploaded_files,
            "skipped_files": skipped_files,
            "renamed_files": renamed_files,
            "task_id": task_id,
        }
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")
    except Exception as e:
        # Unexpected failure (Server error)
        raise internal_http_error(e, operation="knowledge.upload") from e


@router.post("/create")
async def create_knowledge_base(
    background_tasks: BackgroundTasks,
    name: str = Form(...),
    files: list[UploadFile] = File(...),
    rag_provider: str = Form(DEFAULT_PROVIDER),
    rel_paths: list[str] = Form(None),
):
    """Create a new knowledge base and initialize it with files."""
    try:
        try:
            name = validate_knowledge_base_name(name)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        manager = get_kb_manager()
        kb_base_dir = _current_kb_base_dir()
        if name in manager.list_knowledge_bases():
            raise HTTPException(status_code=400, detail=f"Knowledge base '{name}' already exists")

        rag_provider = _validate_registered_provider(rag_provider)
        _assert_index_preflight(rag_provider)
        _assert_provider_ready(rag_provider)
        _enforce_provider_formats(rag_provider, files)
        allowed_extensions = FileTypeRouter.get_supported_extensions()
        _validate_upload_batch(files, allowed_extensions=allowed_extensions, rel_paths=rel_paths)

        logger.info(f"Creating KB: {name} (provider={rag_provider})")
        task_id = _build_unique_task_id("kb_init", name)
        get_task_stream_manager().ensure_task(task_id)

        # Register KB to kb_config.json immediately with "initializing" status
        # This ensures the KB appears in the list right away
        manager.update_kb_status(
            name=name,
            status="initializing",
            progress={
                "stage": "initializing",
                "message": "Initializing knowledge base...",
                "percent": 0,
                "current": 0,
                "total": len(files),
                "task_id": task_id,
            },
        )
        # Also store rag_provider in config (reload and update)
        manager.config = manager._load_config()
        if name in manager.config.get("knowledge_bases", {}):
            manager.config["knowledge_bases"][name]["rag_provider"] = rag_provider
            manager.config["knowledge_bases"][name]["needs_reindex"] = False
            manager._save_config()

        progress_tracker = ProgressTracker(name, kb_base_dir)

        initializer = KnowledgeBaseInitializer(
            kb_name=name,
            base_dir=str(kb_base_dir),
            progress_tracker=progress_tracker,
            rag_provider=rag_provider,
        )

        initializer.create_directory_structure()
        progress_tracker.task_id = task_id

        manager = get_kb_manager()
        if name not in manager.list_knowledge_bases():
            logger.warning(f"KB {name} not found in config, registering manually")
            initializer._register_to_config()

        uploaded_files, _ = await _save_uploaded_files_off_loop(
            files, initializer.raw_dir, allowed_extensions=allowed_extensions, rel_paths=rel_paths
        )

        progress_tracker.update(
            ProgressStage.PROCESSING_DOCUMENTS,
            f"Saved {len(uploaded_files)} files, preparing to process...",
            current=0,
            total=len(uploaded_files),
        )

        _start_knowledge_task(
            task_id,
            name,
            run_initialization_task(initializer, task_id),
        )

        logger.info(f"KB '{name}' created, processing {len(uploaded_files)} files in background")

        return {
            "message": f"Knowledge base '{name}' created. Processing {len(uploaded_files)} files in background.",
            "name": name,
            "files": uploaded_files,
            "task_id": task_id,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to create KB: {e}")
        logger.debug(traceback.format_exc())
        raise internal_http_error(e, operation="knowledge.create") from e


async def run_reindex_task(kb_name: str, base_dir: str, task_id: str, signature_hash: str) -> None:
    """Re-index raw documents through the active retrieval profile.

    Each ``(profile, model, dimension, base_url)`` combination gets its own
    flat ``<kb>/version-N/`` storage directory. Prior versions are preserved
    untouched so switching the active embedding model back to a
    previously-indexed one reuses the existing version with no extra work.
    Keyword retrieval writes a separate model-free text index instead.
    """
    task_manager = TaskIDManager.get_instance()
    task_stream_manager = get_task_stream_manager()
    task_stream_manager.ensure_task(task_id)
    progress_tracker = ProgressTracker(kb_name, Path(base_dir))
    progress_tracker.task_id = task_id

    with capture_task_logs(task_id):
        try:
            base_path = Path(base_dir)
            kb_dir = base_path / kb_name
            raw_dir = kb_dir / "raw"
            if not raw_dir.is_dir():
                raise FileNotFoundError(f"KB '{kb_name}' has no `raw/` directory; cannot reindex.")
            file_paths = [
                str(path)
                for path in FileTypeRouter.collect_supported_files(raw_dir, recursive=True)
            ]
            if not file_paths:
                raise ValueError(f"KB '{kb_name}' has no source files in `raw/` to reindex.")

            _task_log(
                task_id,
                f"Re-indexing '{kb_name}' ({len(file_paths)} files) against signature {signature_hash}",
            )

            progress_tracker.update(
                ProgressStage.PROCESSING_DOCUMENTS,
                f"Re-indexing {len(file_paths)} document(s) with the active retrieval configuration...",
                current=0,
                total=len(file_paths),
            )

            from cognivoy.services.rag.service import RAGService

            # provider=None → RAGService resolves the KB's Cognivoy-bound
            # engine, so re-indexing a PageIndex/LightRAG/GraphRAG KB stays on
            # that provider rather than forcing the default pipeline.
            rag_service = RAGService(kb_base_dir=str(base_path), provider=None)

            def _on_progress(batch_num: int, total_batches: int, _message: str = "") -> None:
                progress_tracker.update(
                    ProgressStage.PROCESSING_DOCUMENTS,
                    f"Indexing text documents: {batch_num}/{total_batches}"
                    if signature_hash == "keyword"
                    else f"Embedding batches: {batch_num}/{total_batches}",
                    current=batch_num,
                    total=total_batches,
                )

            # The pipeline now raises the underlying error (embedding API
            # failure, parse error, etc.) so it surfaces in the task log
            # rather than being swallowed into a generic wrapper. A False
            # return is reserved for "no documents to index" — surface that
            # specifically too.
            success = await rag_service.initialize(
                kb_name=kb_name,
                file_paths=file_paths,
                progress_callback=_on_progress,
            )
            if not success:
                raise RuntimeError(f"Re-index found no valid documents to index in '{kb_name}'.")

            completed_at = datetime.now().isoformat()
            metadata_file = kb_dir / "metadata.json"
            try:
                metadata = {}
                if metadata_file.exists():
                    with open(metadata_file, encoding="utf-8") as handle:
                        loaded_metadata = json.load(handle)
                    if isinstance(loaded_metadata, dict):
                        metadata = loaded_metadata
                metadata["last_updated"] = completed_at
                metadata["last_indexed_at"] = completed_at
                metadata["last_indexed_count"] = len(file_paths)
                metadata["last_indexed_action"] = "reindex"
                atomic_write_json(metadata_file, metadata)
            except Exception as meta_err:
                logger.warning(
                    "Failed to update re-index metadata for '%s': %s",
                    kb_name,
                    meta_err,
                )

            manager = get_kb_manager()
            manager.update_kb_status(
                name=kb_name,
                status="ready",
                progress={
                    "stage": "completed",
                    "message": "Re-index complete",
                    "percent": 100,
                    "current": len(file_paths),
                    "total": len(file_paths),
                    "task_id": task_id,
                    "timestamp": completed_at,
                    "indexed_count": len(file_paths),
                    "index_changed": True,
                    "index_action": "reindex",
                },
            )
            # Clear the legacy mismatch / needs_reindex flags now that an
            # index version matching the active config exists on disk.
            kb_entry = manager.config.get("knowledge_bases", {}).get(kb_name) or {}
            mutated = False
            if kb_entry.get("needs_reindex"):
                kb_entry["needs_reindex"] = False
                mutated = True
            if kb_entry.get("reindex_reason"):
                kb_entry.pop("reindex_reason", None)
                mutated = True
            if kb_entry.get("embedding_mismatch"):
                kb_entry.pop("embedding_mismatch", None)
                mutated = True
            if mutated:
                manager._save_config()

            # `/progress` recovers the durable snapshot before kb_config. A
            # ready config alone would therefore leave the last processing
            # snapshot visible forever after a successful re-index.
            progress_tracker.update(
                ProgressStage.COMPLETED,
                "Re-index complete",
                current=len(file_paths),
                total=len(file_paths),
                indexed_count=len(file_paths),
                index_changed=True,
                index_action="reindex",
            )
            _task_log(task_id, f"Re-index of '{kb_name}' complete", level="success")
            task_manager.update_task_status(task_id, "completed")
            task_stream_manager.emit_complete(task_id, f"Re-index of '{kb_name}' complete")
        except asyncio.CancelledError:
            _mark_knowledge_task_cancelled(
                kb_name,
                base_dir,
                task_id,
                action="Knowledge base re-index",
            )
            raise
        except Exception as e:
            error_msg = _emit_private_task_failure(
                task_id,
                e,
                code="knowledge_reindex_failed",
                message=(
                    "Knowledge base re-indexing failed. Check the retrieval engine "
                    "and document parser settings, then retry."
                ),
            )
            task_manager.update_task_status(task_id, "error", error=error_msg)
            try:
                progress_tracker.update(
                    ProgressStage.ERROR,
                    f"Re-index failed: {error_msg}",
                    error=error_msg,
                )
            except Exception:
                pass


@router.post("/{kb_name}/reindex")
async def reindex_knowledge_base(
    kb_name: str,
    background_tasks: BackgroundTasks,
):
    """Re-index ``kb_name`` through its bound RAG provider.

    LlamaIndex still keys versions by the active embedding model. The other
    providers keep synthetic provider-keyed versions, so they should rebuild
    without requiring an embedding-signature precheck.
    """
    try:
        manager, kb_name, kb_base_dir = _writable_kb(kb_name)
        kb_entry = _load_kb_entry_or_404(manager, kb_name)
        _assert_not_connected_kb(kb_name, kb_entry)
        force_reindex = str(kb_entry.get("status") or "").lower() == "error"
        kb_provider = _validate_registered_provider(
            kb_entry.get("rag_provider") or DEFAULT_PROVIDER
        )
        _assert_index_preflight(kb_provider)
        _assert_provider_ready(kb_provider)

        kb_dir = kb_base_dir / kb_name
        signature_hash = kb_provider
        from cognivoy.services.rag.pipelines.llamaindex.config import keyword_enabled

        keyword_mode = kb_provider == DEFAULT_PROVIDER and keyword_enabled()
        if keyword_mode:
            signature_hash = "keyword"
        if provider_uses_embedding_versions(kb_provider) and not keyword_mode:
            from cognivoy.services.rag.embedding_signature import signature_from_embedding_config
            from cognivoy.services.rag.index_versioning import (
                find_matching_version,
            )

            signature = signature_from_embedding_config()
            if signature is None:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        "No embedding model is configured. Set up the embedding "
                        "profile in Settings before re-indexing."
                    ),
                )

            signature_hash = signature.hash()
            matching_version = find_matching_version(kb_dir, signature)
            matching_valid = _matching_index_is_valid(kb_name, matching_version)
            if (
                matching_version
                and matching_version.get("layout") == "flat"
                and matching_valid
                and not force_reindex
            ):
                return {
                    "message": (
                        f"Knowledge base '{kb_name}' already has an index for the "
                        "active embedding configuration; no reindex needed."
                    ),
                    "task_id": None,
                    "signature": signature_hash,
                    "noop": True,
                }

        task_id = _build_unique_task_id("kb_reindex", kb_name)
        get_task_stream_manager().ensure_task(task_id)

        _mark_kb_queued_for_processing(
            manager, kb_name, task_id, "Queueing re-index...", status="initializing"
        )

        _start_knowledge_task(
            task_id,
            kb_name,
            run_reindex_task(
                kb_name=kb_name,
                base_dir=str(kb_base_dir),
                task_id=task_id,
                signature_hash=signature_hash,
            ),
        )

        return {
            "message": f"Re-indexing '{kb_name}' in the background.",
            "task_id": task_id,
            "signature": signature_hash,
            "noop": False,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to start reindex for '{kb_name}': {e}")
        raise internal_http_error(e, operation="knowledge.start_reindex") from e


@router.post("/{kb_name}/retry")
async def retry_knowledge_base(
    kb_name: str,
    background_tasks: BackgroundTasks,
):
    """Retry a failed KB initialization/indexing run from its stored raw files."""
    try:
        manager, resolved_name, _ = _writable_kb(kb_name)
        kb_entry = _load_kb_entry_or_404(manager, resolved_name)
        status = str(kb_entry.get("status") or "").lower()
        progress = kb_entry.get("progress") if isinstance(kb_entry.get("progress"), dict) else {}
        progress_stage = str(progress.get("stage") or "").lower()
        if status not in {"error", "cancelled"} and progress_stage not in {
            "error",
            "cancelled",
        }:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Knowledge base '{resolved_name}' is not in an error state. "
                    "Use re-index when you want to rebuild a healthy knowledge base."
                ),
            )
        return await reindex_knowledge_base(resolved_name, background_tasks)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to retry KB '{kb_name}': {e}")
        raise internal_http_error(e, operation="knowledge.retry") from e


@router.post("/{kb_name}/tasks/{task_id}/cancel")
async def cancel_knowledge_task(kb_name: str, task_id: str):
    """Cancel the currently-running indexing job for a writable KB.

    The KB's persisted progress task id is checked in addition to the live
    registry so a stale browser cannot cancel a newer replacement job.
    """
    manager, resolved_name, base_dir = _writable_kb(kb_name)
    kb_entry = _load_kb_entry_or_404(manager, resolved_name)
    progress = kb_entry.get("progress") if isinstance(kb_entry.get("progress"), dict) else {}
    current_task_id = str(progress.get("task_id") or "")
    if current_task_id and current_task_id != task_id:
        raise HTTPException(
            status_code=409,
            detail="This task is no longer the active job for the knowledge base.",
        )

    metadata = TaskIDManager.get_instance().get_task_metadata(task_id)
    if metadata and metadata.get("status") == "cancelled":
        return {"task_id": task_id, "status": "cancelled", "already_cancelled": True}
    if metadata and metadata.get("status") in {"completed", "error"}:
        raise HTTPException(status_code=409, detail="The task has already finished.")

    cancelled = await get_knowledge_task_registry().cancel(task_id, kb_name=resolved_name)
    if not cancelled:
        raise HTTPException(status_code=404, detail="No running task was found for this id.")
    # The registry publishes the terminal intent before cancelling and waits
    # only a bounded interval. Persist the user-visible terminal state here as
    # well, because an uncooperative provider may not unwind through the task
    # wrapper's CancelledError handler before this response is returned.
    _mark_knowledge_task_cancelled(
        resolved_name,
        base_dir,
        task_id,
        action="Knowledge base task",
    )
    return {"task_id": task_id, "status": "cancelled", "already_cancelled": False}


@router.post("/{kb_name}/tasks/cancel-batch")
async def cancel_knowledge_tasks_batch(kb_name: str, request: BatchCancelRequest):
    """Cancel multiple known tasks and report every outcome independently."""

    task_ids = list(dict.fromkeys(str(task_id).strip() for task_id in request.task_ids))
    task_ids = [task_id for task_id in task_ids if task_id]
    if not task_ids:
        raise HTTPException(status_code=400, detail="Select at least one task to cancel.")
    if len(task_ids) > 50:
        raise HTTPException(status_code=400, detail="At most 50 tasks can be cancelled at once.")

    # Resolve write access once even if every supplied id is already stale.
    _writable_kb(kb_name)
    results: list[dict[str, object]] = []
    for task_id in task_ids:
        try:
            result = await cancel_knowledge_task(kb_name, task_id)
            results.append({"ok": True, **result})
        except HTTPException as exc:
            results.append(
                {
                    "ok": False,
                    "task_id": task_id,
                    "status_code": exc.status_code,
                    "detail": exc.detail,
                }
            )
    return {
        "knowledge_base": kb_name,
        "cancelled": sum(1 for item in results if item["ok"]),
        "failed": sum(1 for item in results if not item["ok"]),
        "results": results,
    }


@router.get("/{kb_name}/progress")
async def get_progress(kb_name: str):
    """Get initialization progress for a knowledge base"""
    try:
        resource = resolve_kb(kb_name)
        progress_tracker = ProgressTracker(resource.name, resource.base_dir)
        progress = progress_tracker.get_progress()

        if progress is None:
            return {"status": "not_started", "message": "Initialization not started"}

        return progress
    except HTTPException:
        raise
    except Exception as e:
        raise internal_http_error(e, operation="knowledge.get_progress") from e


@router.post("/{kb_name}/progress/clear")
async def clear_progress(kb_name: str):
    """Clear progress file for a knowledge base (useful for stuck states)"""
    try:
        _, resolved_name, base_dir = _writable_kb(kb_name)
        progress_tracker = ProgressTracker(resolved_name, base_dir)
        progress_tracker.clear()
        return {"status": "success", "message": f"Progress cleared for {kb_name}"}
    except HTTPException:
        raise
    except Exception as e:
        raise internal_http_error(e, operation="knowledge.clear_progress") from e


@router.websocket("/{kb_name}/progress/ws")
async def websocket_progress(websocket: WebSocket, kb_name: str):
    """WebSocket endpoint for real-time progress updates"""
    from cognivoy.api.routers.auth import ws_auth_failed, ws_require_auth
    from cognivoy.multi_user.context import reset_current_user

    user_token = await ws_require_auth(websocket)
    if user_token is ws_auth_failed:
        return

    await websocket.accept()

    broadcaster = ProgressBroadcaster.get_instance()

    try:
        await broadcaster.connect(kb_name, websocket)

        base_dir = _current_kb_base_dir()
        progress_tracker = ProgressTracker(kb_name, base_dir)
        initial_progress = progress_tracker.get_progress()
        expected_task_id = websocket.query_params.get("task_id")

        try:
            kb_info = KnowledgeBaseManager(base_dir=str(base_dir)).get_info(kb_name)
            kb_is_ready = bool(kb_info.get("statistics", {}).get("rag_initialized"))
        except Exception:
            kb_is_ready = False

        # Fast path: no active task — send current state and close immediately
        # This prevents infinite polling loops for ready or legacy KBs.
        has_active_task = False
        if initial_progress:
            stage = initial_progress.get("stage")
            if stage not in ("completed", "error", "cancelled", None):
                ts = initial_progress.get("timestamp")
                if ts:
                    try:
                        age = (datetime.now() - datetime.fromisoformat(ts)).total_seconds()
                        has_active_task = age < 120
                    except Exception:
                        pass

        if not has_active_task and not expected_task_id:
            if kb_is_ready:
                await websocket.send_json(
                    {
                        "type": "progress",
                        "data": {
                            "stage": "completed",
                            "message": "Knowledge base is ready.",
                            "percent": 100,
                            "current": 1,
                            "total": 1,
                        },
                    }
                )
            else:
                await websocket.send_json(
                    {
                        "type": "progress",
                        "data": initial_progress
                        or {
                            "stage": "error",
                            "message": "Knowledge base needs reindex or initialization.",
                        },
                    }
                )
            return

        if initial_progress:
            stage = initial_progress.get("stage")
            timestamp = initial_progress.get("timestamp")
            progress_task_id = initial_progress.get("task_id")

            should_send = False
            if expected_task_id and progress_task_id and progress_task_id != expected_task_id:
                should_send = False
            elif stage in {"error", "cancelled"} or not kb_is_ready:
                should_send = True
            elif stage != "completed" and timestamp:
                try:
                    progress_time = datetime.fromisoformat(timestamp)
                    now = datetime.now()
                    age_seconds = (now - progress_time).total_seconds()
                    if age_seconds < 300:
                        should_send = True
                except Exception:
                    pass

            if should_send:
                await websocket.send_json({"type": "progress", "data": initial_progress})

        last_progress = initial_progress
        last_timestamp = initial_progress.get("timestamp") if initial_progress else None

        while True:
            try:
                try:
                    await asyncio.wait_for(websocket.receive_text(), timeout=1.0)
                except asyncio.TimeoutError:
                    current_progress = progress_tracker.get_progress()
                    if current_progress:
                        progress_task_id = current_progress.get("task_id")
                        if (
                            expected_task_id
                            and progress_task_id
                            and progress_task_id != expected_task_id
                        ):
                            continue
                        current_timestamp = current_progress.get("timestamp")
                        if current_timestamp != last_timestamp:
                            await websocket.send_json(
                                {"type": "progress", "data": current_progress}
                            )
                            last_progress = current_progress
                            last_timestamp = current_timestamp

                            if current_progress.get("stage") in ["completed", "error", "cancelled"]:
                                await asyncio.sleep(3)
                                break
                    continue

            except WebSocketDisconnect:
                break
            except Exception:
                break

    except Exception as e:
        trace_id = uuid4().hex
        logger.error(
            "Knowledge progress WebSocket failed trace_id=%s kb_name=%s",
            trace_id,
            kb_name,
            exc_info=(type(e), e, e.__traceback__),
        )
        try:
            await websocket.send_json(
                {
                    "type": "error",
                    "code": "knowledge_progress_stream_failed",
                    "message": "Knowledge progress updates were interrupted. Reconnect to continue.",
                    "retryable": True,
                    "trace_id": trace_id,
                }
            )
        except Exception:
            pass
    finally:
        await broadcaster.disconnect(kb_name, websocket)
        try:
            await websocket.close()
        except Exception:
            pass
        if user_token is not None:
            try:
                reset_current_user(user_token)
            except Exception:
                pass


@router.post("/{kb_name}/link-folder", response_model=LinkedFolderInfo)
async def link_folder(kb_name: str, request: LinkFolderRequest):
    """
    Link a local folder to a knowledge base.

    This allows syncing documents from a local folder (which can be
    synced with SharePoint, Google Drive, OneLake, etc.) to the KB.

    The folder path supports:
    - Absolute paths: /Users/name/Documents or C:\\Users\\name\\Documents
    - Home directory: ~/Documents
    - Relative paths (resolved from server working directory)
    """
    try:
        manager, resolved_name, _ = _writable_kb(kb_name)
        _assert_not_connected_kb(resolved_name, _load_kb_entry_or_404(manager, resolved_name))
        folder_info = manager.link_folder(resolved_name, request.folder_path)
        logger.info(f"Linked folder '{request.folder_path}' to KB '{kb_name}'")
        return LinkedFolderInfo(**folder_info)
    except HTTPException:
        raise
    except ValueError as e:
        error_msg = str(e)
        if "not found" in error_msg.lower():
            raise HTTPException(status_code=404, detail=error_msg)
        raise HTTPException(status_code=400, detail=error_msg)
    except Exception as e:
        raise internal_http_error(e, operation="knowledge.link_folder") from e


@router.get("/{kb_name}/linked-folders", response_model=list[LinkedFolderInfo])
async def get_linked_folders(kb_name: str):
    """Get list of linked folders for a knowledge base."""
    try:
        resource = resolve_kb(kb_name)
        manager = manager_for_resource(resource)
        folders = manager.get_linked_folders(resource.name)
        return [LinkedFolderInfo(**f) for f in folders]
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")
    except Exception as e:
        raise internal_http_error(e, operation="knowledge.list_linked_folders") from e


@router.delete("/{kb_name}/linked-folders/{folder_id}")
async def unlink_folder(kb_name: str, folder_id: str):
    """Unlink a folder from a knowledge base."""
    try:
        manager, resolved_name, _ = _writable_kb(kb_name)
        success = manager.unlink_folder(resolved_name, folder_id)
        if not success:
            raise HTTPException(status_code=404, detail=f"Folder '{folder_id}' not found")
        logger.info(f"Unlinked folder '{folder_id}' from KB '{kb_name}'")
        return {"message": "Folder unlinked successfully", "folder_id": folder_id}
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")
    except Exception as e:
        raise internal_http_error(e, operation="knowledge.unlink_folder") from e


@router.post("/{kb_name}/sync-folder/{folder_id}")
async def sync_folder(kb_name: str, folder_id: str, background_tasks: BackgroundTasks):
    """
    Sync files from a linked folder to the knowledge base.

    This scans the linked folder for supported documents and processes
    any new files that haven't been added yet.
    """
    try:
        manager, kb_name, kb_base_dir = _writable_kb(kb_name)
        kb_entry = _load_kb_entry_or_404(manager, kb_name)
        _assert_kb_writable_or_409(kb_name, kb_entry)
        kb_provider = _validate_registered_provider(
            kb_entry.get("rag_provider") or DEFAULT_PROVIDER
        )

        # Get linked folders and find the one with matching ID
        folders = manager.get_linked_folders(kb_name)
        folder_info = next((f for f in folders if f["id"] == folder_id), None)

        if not folder_info:
            raise HTTPException(status_code=404, detail=f"Linked folder '{folder_id}' not found")

        folder_path = folder_info["path"]

        # Check for changes (new or modified files)
        changes = manager.detect_folder_changes(kb_name, folder_id)
        files_to_process = changes["new_files"] + changes["modified_files"]

        if not files_to_process:
            return {"message": "No new or modified files to sync", "files": [], "file_count": 0}

        logger.info(
            f"Syncing {len(files_to_process)} files from folder '{folder_path}' to KB '{kb_name}'"
        )
        task_id = _build_unique_task_id("kb_upload", f"{kb_name}_folder_{folder_id}")
        get_task_stream_manager().ensure_task(task_id)

        # NOTE: We DO NOT update sync state here anymore.
        # It is updated in run_upload_processing_task only after successful processing.
        # This prevents marking files as synced if processing fails (race condition fix).

        _mark_kb_queued_for_processing(
            manager,
            kb_name,
            task_id,
            f"Syncing {len(files_to_process)} file(s) from linked folder...",
        )

        # Add background task to process files
        _start_knowledge_task(
            task_id,
            kb_name,
            run_upload_processing_task(
                kb_name=kb_name,
                base_dir=str(kb_base_dir),
                uploaded_file_paths=files_to_process,
                task_id=task_id,
                rag_provider=kb_provider,
                folder_id=folder_id,  # Pass folder_id to update state on success
            ),
        )

        return {
            "message": f"Syncing {len(files_to_process)} files from linked folder",
            "folder_path": folder_path,
            "new_files": changes["new_count"],
            "modified_files": changes["modified_count"],
            "file_count": len(files_to_process),
            "task_id": task_id,
        }
    except HTTPException:
        raise
    except ValueError:
        raise HTTPException(status_code=404, detail=f"Knowledge base '{kb_name}' not found")
    except Exception as e:
        raise internal_http_error(e, operation="knowledge.sync_folder") from e
