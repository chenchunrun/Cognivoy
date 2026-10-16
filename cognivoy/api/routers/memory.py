"""Memory v3 API — workbench backend.

Three layers, three modes (update / audit / dedup). Long-running work
is owned by the :mod:`runs` manager so a refresh / nav-away does not
kill it; clients re-attach by polling ``/runs/{id}/events?since=N``.

- ``GET  /overview``                              → all 11 docs' state + L1 backlog
- ``GET  /doc/{layer}/{key}``                     → raw MD
- ``GET  /doc/{layer}/{key}/lines``               → line-numbered view
- ``PUT  /doc/{layer}/{key}``                     → user-edited save
- ``DELETE /doc/{layer}/{key}/entry/{id}``        → drop one entry
- ``POST /runs/start``                            → start update/audit/dedup; returns run_id
- ``GET  /runs/{id}``                             → run state
- ``GET  /runs/{id}/events?since=N``              → SSE-replay events from cursor N
- ``POST /runs/{id}/cancel``                      → cooperative cancellation
- ``POST /runs/{id}/undo``                        → restore latest run write
- ``GET  /runs?layer=L2&key=chat``                → active+recent runs for one doc
- ``GET  /settings``                              → memory: settings subtree
- ``PUT  /settings``                              → save memory: settings subtree
- ``GET  /trace/{surface}``                       → paginated L1 events
- ``DELETE /trace/{surface}/day/{date}``          → drop one day of trace
- ``DELETE /trace/{surface}``                     → drop all trace for a surface
- ``GET  /backup``                                → list v1-migration backup dirs (if any)

The legacy per-mode endpoints (``POST /doc/{layer}/{key}/update`` etc.)
are kept for the moment as thin wrappers that start a run and stream
its events — older clients keep working.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime
from datetime import date as date_cls
import json
import logging
import re
from typing import Literal

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from cognivoy.api.errors import internal_http_error
from cognivoy.learning.project_storage import LearningProjectStore
from cognivoy.multi_user.context import get_current_user
from cognivoy.services.memory import (
    L3_SLOTS,
    SURFACES,
    Surface,
    get_memory_store,
    paths,
)

_ENTRY_ID_RE = re.compile(r"^m_[0-9A-HJKMNP-TV-Z]{26}$")

logger = logging.getLogger(__name__)
router = APIRouter()

Layer = Literal["L2", "L3"]


# ── Helpers ──────────────────────────────────────────────────────────────


def _validate_doc_key(layer: Layer, key: str) -> None:
    if layer == "L2" and key not in SURFACES:
        raise HTTPException(status_code=404, detail=f"unknown surface {key!r}")
    if layer == "L3" and key not in L3_SLOTS:
        raise HTTPException(status_code=404, detail=f"unknown L3 slot {key!r}")


def _validate_layer(layer: str) -> Layer:
    if layer not in {"L2", "L3"}:
        raise HTTPException(status_code=400, detail="layer must be L2 or L3")
    return layer  # type: ignore[return-value]


def _validate_surface(surface: str) -> Surface:
    if surface not in SURFACES:
        raise HTTPException(status_code=404, detail=f"unknown surface {surface!r}")
    return surface  # type: ignore[return-value]


def _validate_entry_id(entry_id: str) -> None:
    if not _ENTRY_ID_RE.fullmatch(entry_id):
        raise HTTPException(status_code=400, detail="not a valid entry id")


# ── Overview / list ──────────────────────────────────────────────────────


@router.get("/overview")
async def get_overview():
    store = get_memory_store()
    rows = [asdict(r) for r in store.overview()]
    backup_dir = paths.backup_root()
    backups: list[str] = []
    if backup_dir.exists():
        backups = sorted(p.name for p in backup_dir.iterdir() if p.is_dir())
    return {"docs": rows, "backups": backups}


@router.get("/graph")
async def get_structured_graph():
    """Return the authoritative, backend-parsed L1/L2/L3 graph snapshot.

    Markdown remains the durable representation for L2/L3, but its syntax is
    interpreted exactly once by :mod:`services.memory.document`. A client no
    longer needs a second parser that can silently disagree with consolidation.
    Failures are isolated per surface/slot and reported alongside an empty
    collection so one damaged document cannot blank the whole graph.
    """

    from cognivoy.services.memory import snapshot as snap
    from cognivoy.services.memory.document import parse

    errors: list[dict[str, str]] = []
    l1: dict[str, list[dict]] = {}
    for surface in SURFACES:
        try:
            l1[surface] = [entity.to_dict() for entity in snap.read_snapshot(surface)]
        except Exception as exc:  # noqa: BLE001 - isolate one adapter failure
            logger.exception("Failed to read L1 graph surface %s", surface)
            l1[surface] = []
            errors.append({"layer": "L1", "key": surface, "error": type(exc).__name__})

    def read_doc(layer: Layer, key: str) -> dict:
        path = paths.l2_file(key) if layer == "L2" else paths.l3_file(key)  # type: ignore[arg-type]
        if not path.exists():
            return {"title": "", "entries": []}
        try:
            doc = parse(path.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001 - isolate one malformed doc
            logger.exception("Failed to parse %s graph document %s", layer, key)
            errors.append({"layer": layer, "key": key, "error": type(exc).__name__})
            return {"title": "", "entries": []}
        return {
            "title": doc.title,
            "entries": [asdict(entry) for entry in doc.all_entries()],
        }

    l2 = {surface: read_doc("L2", surface) for surface in SURFACES}
    l3 = {slot: read_doc("L3", slot) for slot in L3_SLOTS}
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "l1": l1,
        "l2": l2,
        "l3": l3,
        "errors": errors,
    }


@router.get("/resolve_entry/{entry_id}")
async def resolve_entry(entry_id: str):
    """Find which L2 doc owns this entry id.

    L3 docs cite L2 entries by their ``m_<ULID>`` entry id; the workbench
    UI uses this resolver to turn an L3 footnote click into a navigation
    to the right L2 surface + scroll-to anchor.

    Scans the seven L2 mds in order; first hit wins. 404 if no L2 doc
    contains the id (e.g. the entry was deleted or the id is stale).
    """
    if not _ENTRY_ID_RE.match(entry_id):
        raise HTTPException(status_code=400, detail="not a valid entry id")
    from cognivoy.services.memory.document import parse

    for surface in SURFACES:
        path = paths.l2_file(surface)
        if not path.exists():
            continue
        try:
            doc = parse(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — malformed L2 should not 500 the resolver
            continue
        for entry in doc.all_entries():
            if entry.id == entry_id:
                return {"layer": "L2", "key": surface, "entry_id": entry_id}
    raise HTTPException(status_code=404, detail="entry not found in any L2 doc")


@router.get("/backup")
async def list_backups():
    backup_dir = paths.backup_root()
    if not backup_dir.exists():
        return {"backups": []}
    out: list[dict] = []
    for entry in sorted(backup_dir.iterdir()):
        if entry.is_dir():
            files = sorted(p.name for p in entry.iterdir())
            out.append({"name": entry.name, "files": files})
    return {"backups": out}


# ── Versioned resource contract ────────────────────────────────────────


def _resource_rows(
    *,
    layer: Layer | None,
    key: str | None,
    status: Literal["active", "deleted", "all"],
    updated_from: float | None,
    updated_to: float | None,
) -> list[dict]:
    store = get_memory_store()
    layers: list[Layer] = [layer] if layer is not None else ["L2", "L3"]
    rows: list[dict] = []
    if status in {"active", "all"}:
        for current_layer in layers:
            keys = SURFACES if current_layer == "L2" else L3_SLOTS
            for current_key in keys:
                if key is not None and current_key != key:
                    continue
                rows.extend(store.list_resource_items(current_layer, current_key))
    if status in {"deleted", "all"}:
        for tombstone in store.list_deleted_entries(layer=layer, key=key):
            entry = tombstone.get("entry") or {}
            current_layer = str(tombstone.get("layer") or "")
            current_key = str(tombstone.get("key") or "")
            rows.append(
                {
                    "id": str(entry.get("id") or ""),
                    "layer": current_layer,
                    "key": current_key,
                    "section": str(entry.get("section") or ""),
                    "text": str(entry.get("text") or ""),
                    "refs": list(entry.get("refs") or []),
                    "source_count": len(entry.get("refs") or []),
                    "confidence": 1.0 if entry.get("refs") else 0.0,
                    "created_at": tombstone.get("created_at"),
                    "updated_at": tombstone.get("deleted_at"),
                    "deleted_at": tombstone.get("deleted_at"),
                    "reason": tombstone.get("reason") or "user_delete",
                    "status": "deleted",
                    "version": (
                        store.resource_version(current_layer, current_key)
                        if current_layer in {"L2", "L3"} and current_key
                        else ""
                    ),
                }
            )

    def timestamp(item: dict) -> float:
        raw = item.get("updated_at")
        if not raw:
            return 0.0
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0.0

    if updated_from is not None:
        rows = [item for item in rows if timestamp(item) >= updated_from]
    if updated_to is not None:
        rows = [item for item in rows if timestamp(item) <= updated_to]
    rows.sort(key=lambda item: (timestamp(item), str(item.get("id") or "")), reverse=True)
    return rows


@router.get("/resources")
async def list_memory_resources(
    layer: str | None = None,
    key: str | None = None,
    status: Literal["active", "deleted", "all"] = "active",
    updated_from: float | None = None,
    updated_to: float | None = None,
    cursor: str | None = None,
    limit: int = 100,
):
    lyr = _validate_layer(layer) if layer is not None else None
    if key is not None:
        if lyr is None:
            raise HTTPException(status_code=400, detail="key requires layer")
        _validate_doc_key(lyr, key)
    try:
        start = max(0, int(cursor or "0"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="invalid cursor") from exc
    bounded_limit = max(1, min(int(limit), 500))
    rows = _resource_rows(
        layer=lyr,
        key=key,
        status=status,
        updated_from=updated_from,
        updated_to=updated_to,
    )
    end = min(len(rows), start + bounded_limit)
    return {
        "schema_version": 1,
        "items": rows[start:end],
        "total": len(rows),
        "cursor": str(end) if end < len(rows) else None,
    }


@router.get("/resources/export")
async def export_memory_resources(
    layer: str | None = None,
    key: str | None = None,
    include_deleted: bool = False,
):
    lyr = _validate_layer(layer) if layer is not None else None
    if key is not None:
        if lyr is None:
            raise HTTPException(status_code=400, detail="key requires layer")
        _validate_doc_key(lyr, key)
    items = _resource_rows(
        layer=lyr,
        key=key,
        status="all" if include_deleted else "active",
        updated_from=None,
        updated_to=None,
    )
    return {
        "schema_version": 1,
        "exported_at": datetime.now(UTC).isoformat(),
        "items": items,
        "total": len(items),
    }


class ResourceWriteRequest(BaseModel):
    expected_version: str = Field(min_length=8, max_length=100)
    text: str = Field(min_length=1, max_length=4_000)
    section: str | None = Field(default=None, max_length=200)
    refs: list[str] | None = None


class ResourceDeleteRequest(BaseModel):
    expected_version: str = Field(min_length=8, max_length=100)
    reason: str = Field(default="user_delete", max_length=500)


class ResourceStateRequest(BaseModel):
    paused: bool | None = None
    flagged_incorrect: bool | None = None
    reason: str | None = Field(default=None, max_length=500)


class ResourceProjectsRequest(BaseModel):
    project_ids: list[str] = Field(default_factory=list, max_length=20)


class ResourceMergeRequest(BaseModel):
    layer: Layer
    key: str
    entry_ids: list[str] = Field(min_length=2, max_length=50)
    expected_version: str = Field(min_length=8, max_length=100)
    merged_text: str | None = Field(default=None, max_length=4_000)
    reason: str = Field(default="learner_merged_duplicates", max_length=500)


def _memory_version_conflict(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "memory_version_conflict",
            "message": str(exc),
            "current_version": getattr(exc, "current_version", ""),
            "retryable": True,
        },
    )


@router.put("/resources/{layer}/{key}/{entry_id}")
async def update_memory_resource(
    layer: str,
    key: str,
    entry_id: str,
    payload: ResourceWriteRequest,
):
    from cognivoy.services.memory.store import MemoryVersionConflict

    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    _validate_entry_id(entry_id)
    try:
        result = await get_memory_store().update_resource(
            lyr,
            key,
            entry_id,
            expected_version=payload.expected_version,
            text=payload.text,
            section=payload.section,
            refs=payload.refs,
        )
    except MemoryVersionConflict as exc:
        raise _memory_version_conflict(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="entry not found")
    return result


@router.delete("/resources/{layer}/{key}/{entry_id}")
async def delete_memory_resource(
    layer: str,
    key: str,
    entry_id: str,
    payload: ResourceDeleteRequest,
):
    from cognivoy.services.memory.store import MemoryVersionConflict

    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    _validate_entry_id(entry_id)
    try:
        result = await get_memory_store().delete_resource(
            lyr,
            key,
            entry_id,
            expected_version=payload.expected_version,
            reason=payload.reason,
        )
    except MemoryVersionConflict as exc:
        raise _memory_version_conflict(exc) from exc
    if result is None:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"layer": lyr, "key": key, **result}


@router.patch("/resources/{layer}/{key}/{entry_id}/state")
async def update_memory_resource_state(
    layer: str,
    key: str,
    entry_id: str,
    payload: ResourceStateRequest,
):
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    _validate_entry_id(entry_id)
    if payload.paused is None and payload.flagged_incorrect is None and payload.reason is None:
        raise HTTPException(status_code=422, detail="no memory state change supplied")
    result = await get_memory_store().set_resource_state(
        lyr,
        key,
        entry_id,
        paused=payload.paused,
        flagged_incorrect=payload.flagged_incorrect,
        reason=payload.reason,
    )
    if result is None:
        raise HTTPException(status_code=404, detail="entry not found")
    return {"item": result}


@router.put("/resources/{layer}/{key}/{entry_id}/projects")
async def update_memory_resource_projects(
    layer: str,
    key: str,
    entry_id: str,
    payload: ResourceProjectsRequest,
):
    """Assign a memory to owner-scoped learning projects explicitly."""
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    _validate_entry_id(entry_id)
    owner_id = get_current_user().id
    project_store = LearningProjectStore()
    normalized = list(
        dict.fromkeys(value.strip() for value in payload.project_ids if value.strip())
    )
    for project_id in normalized:
        try:
            project = project_store.load(project_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid learning project id") from exc
        if project is None or project.owner_id != owner_id:
            raise HTTPException(status_code=404, detail="learning project not found")

    item, added, removed = await get_memory_store().set_resource_projects(
        lyr,
        key,
        entry_id,
        normalized,
    )
    if item is None:
        raise HTTPException(status_code=404, detail="entry not found")
    resource_ref = f"memory:{lyr}:{key}:{entry_id}"
    revision = int(item.get("project_link_revision") or 0)
    for project_id in added:
        project_store.record_external_event(
            project_id,
            owner_id=owner_id,
            event_type="resource_activity",
            title="Memory linked to learning project",
            description=str(item.get("text") or "")[:500],
            result_refs=[resource_ref],
            dedupe_key=f"memory-link:{resource_ref}:{revision}",
        )
    for project_id in removed:
        project_store.record_external_event(
            project_id,
            owner_id=owner_id,
            event_type="resource_activity",
            title="Memory removed from learning project",
            description=str(item.get("text") or "")[:500],
            result_refs=[resource_ref],
            dedupe_key=f"memory-unlink:{resource_ref}:{revision}",
        )
    return {"item": item, "added_project_ids": added, "removed_project_ids": removed}


@router.post("/resources/merge")
async def merge_memory_resources(payload: ResourceMergeRequest):
    from cognivoy.services.memory.store import MemoryVersionConflict

    _validate_doc_key(payload.layer, payload.key)
    for entry_id in payload.entry_ids:
        _validate_entry_id(entry_id)
    try:
        return await get_memory_store().merge_resources(
            payload.layer,
            payload.key,
            payload.entry_ids,
            expected_version=payload.expected_version,
            merged_text=payload.merged_text,
            reason=payload.reason,
        )
    except MemoryVersionConflict as exc:
        raise _memory_version_conflict(exc) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# ── Doc read / write / delete ────────────────────────────────────────────


@router.get("/doc/{layer}/{key}")
async def get_doc(layer: str, key: str):
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    store = get_memory_store()
    return {
        "layer": lyr,
        "key": key,
        "content": store.read_raw(lyr, key),
        "version": store.resource_version(lyr, key),
    }


class DocWriteRequest(BaseModel):
    content: str
    expected_version: str | None = Field(default=None, min_length=8, max_length=100)


@router.put("/doc/{layer}/{key}")
async def put_doc(layer: str, key: str, payload: DocWriteRequest):
    from cognivoy.services.memory.store import MemoryVersionConflict

    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    try:
        version = await get_memory_store().overwrite_doc(
            lyr,
            key,
            payload.content,
            expected_version=payload.expected_version,
        )
    except MemoryVersionConflict as exc:
        raise _memory_version_conflict(exc) from exc
    return {"layer": lyr, "key": key, "saved": True, "version": version}


@router.delete("/doc/{layer}/{key}/entry/{entry_id}")
async def delete_entry(layer: str, key: str, entry_id: str):
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    _validate_entry_id(entry_id)
    ok = await get_memory_store().delete_entry(lyr, key, entry_id)
    if not ok:
        raise HTTPException(status_code=404, detail="entry not found")
    return {
        "layer": lyr,
        "key": key,
        "deleted": entry_id,
        "recoverable": True,
    }


@router.get("/trash")
async def list_deleted_entries(layer: str | None = None, key: str | None = None):
    lyr: Layer | None = None
    if layer is not None:
        lyr = _validate_layer(layer)
    if key is not None:
        if lyr is None:
            raise HTTPException(status_code=400, detail="key requires layer")
        _validate_doc_key(lyr, key)
    items = get_memory_store().list_deleted_entries(layer=lyr, key=key)
    return {"items": items, "total": len(items)}


@router.post("/trash/{layer}/{key}/{entry_id}/restore")
async def restore_deleted_entry(layer: str, key: str, entry_id: str):
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    _validate_entry_id(entry_id)
    restored = await get_memory_store().restore_deleted_entry(lyr, key, entry_id)
    if not restored:
        raise HTTPException(status_code=404, detail="deleted entry not found")
    return {"layer": lyr, "key": key, "restored": entry_id}


@router.delete("/trash/{layer}/{key}/{entry_id}")
async def permanently_delete_entry(layer: str, key: str, entry_id: str):
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    _validate_entry_id(entry_id)
    deleted = await get_memory_store().permanently_delete_entry(lyr, key, entry_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="deleted entry not found")
    return {"layer": lyr, "key": key, "permanently_deleted": entry_id}


# ── L3 conflict review ──────────────────────────────────────────────────


class ConflictResolveRequest(BaseModel):
    conflict_id: str = Field(min_length=1, max_length=240)
    layer: Literal["L3"] = "L3"
    key: str
    left_id: str
    right_id: str
    action: Literal["keep_left", "keep_right", "merge", "delete_both"]
    merged_text: str | None = Field(default=None, max_length=4_000)
    reason: str = Field(default="", max_length=1_000)


@router.get("/conflicts")
async def list_conflicts(limit: int = 500):
    items = get_memory_store().find_conflicts(limit=limit)
    return {"schema_version": 1, "items": items, "total": len(items)}


@router.get("/conflicts/audit")
async def list_conflict_audit(limit: int = 100):
    items = get_memory_store().list_conflict_audit(limit=limit)
    return {"items": items, "total": len(items)}


@router.post("/conflicts/resolve")
async def resolve_conflict(payload: ConflictResolveRequest):
    _validate_doc_key("L3", payload.key)
    _validate_entry_id(payload.left_id)
    _validate_entry_id(payload.right_id)
    try:
        return await get_memory_store().resolve_conflict(
            layer="L3",
            key=payload.key,
            left_id=payload.left_id,
            right_id=payload.right_id,
            action=payload.action,
            merged_text=payload.merged_text,
            reason=payload.reason,
            conflict_id=payload.conflict_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/doc/{layer}/{key}/reset")
async def reset_doc(layer: str, key: str):
    """Wipe the doc + its meta sidecar so the next update starts fresh.

    Destructive — the caller has confirmed. After this returns the .md
    file is gone *and* the ``seen_entity_refs`` set is cleared, so a
    subsequent ``run_update`` re-ingests every L1 entity instead of
    treating them as already-seen.

    Refuses while a consolidator run is active on this doc; the caller
    can cancel first.
    """
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)

    from cognivoy.services.memory.consolidator.runs import get_run_manager

    if get_run_manager().active_for(lyr, key) is not None:
        raise HTTPException(
            status_code=409,
            detail="cancel the active run before resetting this doc",
        )

    from cognivoy.services.memory.consolidator import meta as meta_mod

    doc_path = paths.l2_file(key) if lyr == "L2" else paths.l3_file(key)  # type: ignore[arg-type]
    meta_path = (
        meta_mod.l2_meta_path(key)  # type: ignore[arg-type]
        if lyr == "L2"
        else meta_mod.l3_meta_path(key)  # type: ignore[arg-type]
    )

    removed_doc = False
    removed_meta = False
    try:
        if doc_path.exists():
            doc_path.unlink()
            removed_doc = True
        if meta_path.exists():
            meta_path.unlink()
            removed_meta = True
    except OSError as exc:
        raise internal_http_error(exc, operation="memory.reset_document") from exc

    return {
        "layer": lyr,
        "key": key,
        "reset": True,
        "removed_doc": removed_doc,
        "removed_meta": removed_meta,
    }


# ── Doc update (SSE-streamed consolidator) ───────────────────────────────


class LLMSelectionPayload(BaseModel):
    profile_id: str
    model_id: str


class RunStartRequest(BaseModel):
    layer: str
    key: str
    mode: Literal["update", "audit", "dedup", "merge"]
    language: str = "en"
    budget: int | None = None
    iterations: int | None = None
    llm_selection: LLMSelectionPayload | None = None


def _runner_for(req: RunStartRequest):
    """Return an ``async on_event → None`` runner for the requested mode."""
    from cognivoy.services.memory.consolidator import (
        run_audit,
        run_dedup,
        run_merge,
        run_update,
    )

    selection = (
        {"profile_id": req.llm_selection.profile_id, "model_id": req.llm_selection.model_id}
        if req.llm_selection
        else None
    )

    if req.mode == "update":

        async def go(on_event):
            await run_update(
                req.layer,
                req.key,
                language=req.language,
                budget=req.budget,
                llm_selection=selection,
                on_event=on_event,
            )

        return go
    if req.mode == "audit":

        async def go(on_event):
            await run_audit(
                req.layer,
                req.key,
                language=req.language,
                budget=req.budget,
                llm_selection=selection,
                on_event=on_event,
            )

        return go
    if req.mode == "dedup":

        async def go(on_event):
            await run_dedup(
                req.layer,
                req.key,
                language=req.language,
                iterations=req.iterations,
                llm_selection=selection,
                on_event=on_event,
            )

        return go
    if req.mode == "merge":

        async def go(on_event):
            await run_merge(
                req.layer,
                req.key,
                language=req.language,
                on_event=on_event,
            )

        return go
    raise HTTPException(status_code=400, detail=f"unknown mode {req.mode!r}")


@router.post("/runs/start")
async def start_run(req: RunStartRequest):
    """Start one consolidator mode and return a run handle.

    The run survives client disconnects; reconnect via
    ``GET /runs/{id}/events?since=N``.
    """
    return await _start_run_request(req)


async def _start_run_request(req: RunStartRequest, *, retry_of: str | None = None):
    lyr = _validate_layer(req.layer)
    _validate_doc_key(lyr, req.key)
    if lyr == "L3" and req.key == "preferences" and req.mode not in ("dedup", "merge"):
        raise HTTPException(
            status_code=405,
            detail="preferences is written by the write_memory tool, not consolidated",
        )
    from cognivoy.services.memory.consolidator.runs import (
        RunBusyError,
        get_run_manager,
    )

    manager = get_run_manager()
    runner = _runner_for(req)
    selection = (
        {"profile_id": req.llm_selection.profile_id, "model_id": req.llm_selection.model_id}
        if req.llm_selection
        else None
    )
    try:
        run = await manager.start(
            layer=lyr,
            key=req.key,
            mode=req.mode,
            runner=runner,
            params={
                "budget": req.budget,
                "iterations": req.iterations,
                "language": req.language,
                "llm_selection": selection,
            },
            language=req.language,
            retry_of=retry_of,
        )
    except RunBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return run.to_dict()


@router.post("/runs/{run_id}/retry")
async def retry_run(run_id: str):
    """Retry a terminal run using its durable original parameters."""
    from cognivoy.services.memory.consolidator.runs import get_run_manager

    previous = get_run_manager().get(run_id)
    if previous is None:
        raise HTTPException(status_code=404, detail="unknown run_id")
    if previous.active:
        raise HTTPException(status_code=409, detail="run is still active")
    selection = previous.params.get("llm_selection")
    req = RunStartRequest(
        layer=previous.layer,
        key=previous.key,
        mode=previous.mode,
        language=str(previous.params.get("language") or previous.language),
        budget=previous.params.get("budget"),
        iterations=previous.params.get("iterations"),
        llm_selection=LLMSelectionPayload(**selection) if isinstance(selection, dict) else None,
    )
    return await _start_run_request(req, retry_of=run_id)


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    from cognivoy.services.memory.consolidator.runs import get_run_manager

    run = get_run_manager().get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="unknown run_id")
    return run.to_dict()


@router.post("/runs/{run_id}/cancel")
async def cancel_run(run_id: str):
    from cognivoy.services.memory.consolidator.runs import get_run_manager

    ok = await get_run_manager().cancel(run_id)
    if not ok:
        raise HTTPException(status_code=409, detail="not active")
    return {"run_id": run_id, "cancelled": True}


@router.post("/runs/{run_id}/undo")
async def undo_run_edit(run_id: str):
    from cognivoy.services.memory.consolidator.runs import (
        RunBusyError,
        get_run_manager,
    )

    manager = get_run_manager()
    try:
        event = await manager.undo_last(run_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown run_id")
    except RunBusyError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if event is None:
        raise HTTPException(status_code=409, detail="nothing to undo")
    run = manager.get(run_id)
    return {
        "run_id": run_id,
        "undone": True,
        "undo_count": len(run.undo_stack) if run else 0,
        "event": {"seq": event.seq, "ts": event.ts, **event.payload},
    }


@router.get("/runs")
async def list_runs(layer: str | None = None, key: str | None = None):
    from cognivoy.services.memory.consolidator.runs import get_run_manager

    lyr = _validate_layer(layer) if layer is not None else None
    if lyr and key is not None:
        _validate_doc_key(lyr, key)
    runs = get_run_manager().list_for(layer=lyr, key=key)
    return {"runs": [r.to_dict() for r in runs]}


@router.get("/runs/{run_id}/events")
async def stream_run_events(run_id: str, since: int = 0):
    """SSE-replay events from ``since`` (exclusive) until the run ends.

    Reconnecting after a refresh: pass the largest ``seq`` previously
    observed. The manager replays the buffered tail, then blocks on
    new events until the run reaches a terminal state.
    """
    from cognivoy.services.memory.consolidator.runs import get_run_manager

    manager = get_run_manager()
    run = manager.get(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="unknown run_id")

    async def producer():
        cursor = max(0, since)
        # Initial backfill (if any) is delivered as a batch up front.
        while True:
            events = await manager.wait_for_events(run, since=cursor)
            for ev in events:
                yield (
                    "data: "
                    + json.dumps(
                        {"seq": ev.seq, "ts": ev.ts, **ev.payload},
                        ensure_ascii=False,
                    )
                    + "\n\n"
                )
            cursor = max(cursor, run.events[-1].seq + 1 if run.events else cursor)
            if not run.active:
                # Drain any final events that arrived between wait return and now.
                final = run.events[cursor:]
                for ev in final:
                    yield (
                        "data: "
                        + json.dumps(
                            {"seq": ev.seq, "ts": ev.ts, **ev.payload},
                            ensure_ascii=False,
                        )
                        + "\n\n"
                    )
                break

    return StreamingResponse(producer(), media_type="text/event-stream")


# ── Legacy per-mode endpoints (kept as thin wrappers over /runs/start) ──


def _legacy_run_stream(req: RunStartRequest) -> StreamingResponse:
    """Old contract: POST /doc/{layer}/{key}/<mode> streams events inline."""
    from cognivoy.services.memory.consolidator.runs import (
        RunBusyError,
        get_run_manager,
    )

    async def producer():
        manager = get_run_manager()
        runner = _runner_for(req)
        selection = (
            {"profile_id": req.llm_selection.profile_id, "model_id": req.llm_selection.model_id}
            if req.llm_selection
            else None
        )
        try:
            run = await manager.start(
                layer=req.layer,
                key=req.key,
                mode=req.mode,
                runner=runner,
                params={
                    "budget": req.budget,
                    "iterations": req.iterations,
                    "language": req.language,
                    "llm_selection": selection,
                },
                language=req.language,
            )
        except RunBusyError as exc:
            yield (
                "data: "
                + json.dumps({"stage": "error", "message": str(exc)}, ensure_ascii=False)
                + "\n\n"
            )
            return
        cursor = 0
        while True:
            events = await manager.wait_for_events(run, since=cursor)
            for ev in events:
                yield (
                    "data: "
                    + json.dumps({**ev.payload, "seq": ev.seq}, ensure_ascii=False)
                    + "\n\n"
                )
                cursor = ev.seq + 1
            if not run.active:
                break

    return StreamingResponse(producer(), media_type="text/event-stream")


class UpdateRequest(BaseModel):
    language: str = "en"
    budget: int | None = None
    llm_selection: LLMSelectionPayload | None = None


class AuditRequest(BaseModel):
    language: str = "en"
    budget: int | None = None
    llm_selection: LLMSelectionPayload | None = None


class DedupRequest(BaseModel):
    language: str = "en"
    iterations: int | None = None
    llm_selection: LLMSelectionPayload | None = None


@router.post("/doc/{layer}/{key}/update")
async def update_doc(layer: str, key: str, payload: UpdateRequest | None = None):
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    req = RunStartRequest(
        layer=lyr,
        key=key,
        mode="update",
        language=(payload.language if payload else "en") or "en",
        budget=payload.budget if payload else None,
        llm_selection=payload.llm_selection if payload else None,
    )
    return _legacy_run_stream(req)


@router.post("/doc/{layer}/{key}/audit")
async def audit_doc(layer: str, key: str, payload: AuditRequest | None = None):
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    req = RunStartRequest(
        layer=lyr,
        key=key,
        mode="audit",
        language=(payload.language if payload else "en") or "en",
        budget=payload.budget if payload else None,
        llm_selection=payload.llm_selection if payload else None,
    )
    return _legacy_run_stream(req)


@router.post("/doc/{layer}/{key}/dedup")
async def dedup_doc(layer: str, key: str, payload: DedupRequest | None = None):
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    req = RunStartRequest(
        layer=lyr,
        key=key,
        mode="dedup",
        language=(payload.language if payload else "en") or "en",
        iterations=payload.iterations if payload else None,
        llm_selection=payload.llm_selection if payload else None,
    )
    return _legacy_run_stream(req)


@router.get("/doc/{layer}/{key}/lines")
async def get_doc_lines(layer: str, key: str):
    """Return the line-numbered, footnote-stripped view of a doc.

    Used by the workbench's "show line numbers" toggle so the same line
    indices the audit/dedup LLMs see are visible to the user. Footnote
    block is omitted because edit ops never reference it directly.
    """
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    from cognivoy.services.memory import paths
    from cognivoy.services.memory.consolidator.line_doc import render_view
    from cognivoy.services.memory.document import Document, parse

    path = paths.l2_file(key) if lyr == "L2" else paths.l3_file(key)  # type: ignore[arg-type]
    doc = (
        parse(path.read_text(encoding="utf-8"))
        if path.exists()
        else Document(title=_default_title(lyr, key))
    )
    view = render_view(doc)
    return {
        "layer": lyr,
        "key": key,
        "lines": [
            {
                "number": line.number,
                "kind": line.kind,
                "text": line.text,
                "entry_id": line.entry_id,
                "section": line.section,
            }
            for line in view.lines
        ],
    }


# ── Settings ────────────────────────────────────────────────────────────


@router.get("/settings")
async def get_memory_settings_endpoint():
    """Return the current ``memory:`` subtree (defaults merged in)."""
    from cognivoy.services.memory.settings import memory_settings_dict

    return memory_settings_dict()


@router.put("/settings")
async def put_memory_settings(payload: dict):
    """Merge the payload into the ``memory:`` subtree and persist."""
    from cognivoy.services.memory.settings import (
        memory_settings_dict,
        save_memory_settings,
    )

    save_memory_settings(payload)
    from cognivoy.services.memory.automation import get_auto_consolidation_scheduler

    scheduler = get_auto_consolidation_scheduler()
    await scheduler.reconfigure()
    return memory_settings_dict()


def _default_title(layer: str, key: str) -> str:
    if layer == "L2":
        return f"{key} memory"
    return {
        "recent": "Recent summary",
        "profile": "User profile",
        "scope": "Knowledge scope",
        "preferences": "Preferences",
    }.get(key, f"{key} memory")


class ApplyOpsRequest(BaseModel):
    ops: list[dict]


@router.post("/doc/{layer}/{key}/apply")
async def apply_doc_ops(layer: str, key: str, payload: ApplyOpsRequest):
    """Commit a list of previously-previewed ops to a doc atomically."""
    lyr = _validate_layer(layer)
    _validate_doc_key(lyr, key)
    if lyr == "L3" and key == "preferences":
        raise HTTPException(
            status_code=405,
            detail="preferences is written by the write_memory tool, not consolidated",
        )
    if not payload.ops:
        return {"accepted": True, "reason": "no ops to apply", "results": []}

    report = await get_memory_store().apply_ops_payload(lyr, key, payload.ops)
    return {
        "accepted": report.accepted,
        "reason": report.reason,
        "results": [
            {
                "status": r.status,
                "entry_id": r.entry_id,
                "detail": r.detail,
            }
            for r in report.results
        ],
    }


# ── Trace browser ────────────────────────────────────────────────────────


@router.get("/trace/{surface}")
async def get_trace(surface: str, limit: int = 200, offset: int = 0):
    surf = _validate_surface(surface)
    from cognivoy.services.memory.trace import iter_since

    events = []
    for i, event in enumerate(iter_since(surf)):
        if i < offset:
            continue
        if len(events) >= max(1, min(limit, 1000)):
            break
        events.append(asdict(event))
    return {"surface": surf, "events": events, "offset": offset, "limit": limit}


@router.delete("/trace/{surface}")
async def clear_trace(surface: str):
    surf = _validate_surface(surface)
    removed = 0
    for path in paths.trace_dir(surf).glob("*.jsonl"):
        try:
            path.unlink()
            removed += 1
        except OSError:
            continue
    return {"surface": surf, "removed_files": removed}


@router.delete("/trace/{surface}/day/{day}")
async def clear_trace_day(surface: str, day: str):
    surf = _validate_surface(surface)
    try:
        parsed = date_cls.fromisoformat(day)
    except ValueError:
        raise HTTPException(status_code=400, detail="day must be YYYY-MM-DD")
    path = paths.trace_file(surf, parsed)
    if not path.exists():
        raise HTTPException(status_code=404, detail="no trace for that day")
    try:
        path.unlink()
    except OSError as exc:
        raise internal_http_error(exc, operation="memory.clear_trace_day") from exc
    return {"surface": surf, "day": day, "deleted": True}


# ── Snapshot (L1 workspace mirror) ───────────────────────────────────────


@router.get("/snapshot/{surface}")
async def get_snapshot(surface: str):
    """Return the current entity list for ``surface`` from workspace.

    Snapshot is always derived live from workspace at call time. The response
    also includes ``pending_changes`` — the diff vs the last persisted state.
    Refresh commits these pending changes into ``changes.jsonl``.
    """
    surf = _validate_surface(surface)
    from cognivoy.services.memory import snapshot as snap

    entities = snap.read_snapshot(surf)
    pending = snap.pending_changes(surf, entities)
    state = snap.current_state(surf)
    return {
        "surface": surf,
        "entities": [e.to_dict() for e in entities],
        "last_refresh": state.get("last_refresh"),
        "pending_changes": [c.to_dict() for c in pending],
    }


@router.post("/snapshot/{surface}/refresh")
async def refresh_snapshot(surface: str):
    """Reconcile persisted state with current workspace; record diffs."""
    surf = _validate_surface(surface)
    from cognivoy.services.memory import snapshot as snap

    changes = snap.refresh_snapshot(surf)
    state = snap.current_state(surf)
    return {
        "surface": surf,
        "changes": [c.to_dict() for c in changes],
        "last_refresh": state.get("last_refresh"),
    }


@router.get("/snapshot/{surface}/changes")
async def get_changes(surface: str, limit: int = 200, offset: int = 0):
    surf = _validate_surface(surface)
    from cognivoy.services.memory import snapshot as snap

    entries = snap.read_changes(surf, limit=limit, offset=offset)
    return {
        "surface": surf,
        "changes": [c.to_dict() for c in entries],
        "limit": limit,
        "offset": offset,
    }


@router.delete("/snapshot/{surface}/changes")
async def clear_snapshot_changes(surface: str):
    surf = _validate_surface(surface)
    from cognivoy.services.memory import snapshot as snap

    snap.clear_changes(surf)
    return {"surface": surf, "cleared": True}
