"""Administrator-only execution control-plane observability API."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from cognivoy.api.routers.auth import AUTH_ENABLED, require_admin
from cognivoy.multi_user.audit import query_control_plane_events

router = APIRouter(dependencies=[Depends(require_admin)])


def _policy_bundle() -> dict:
    from cognivoy.multi_user.context import get_current_user
    from cognivoy.runtime.registry import get_capability_registry, get_tool_registry
    from cognivoy.services.config.execution_policy import (
        load_execution_policy_document,
    )
    from cognivoy.services.config.policy_workflow import get_policy_workflow_state

    user = get_current_user()
    workflow = get_policy_workflow_state(viewer_id=user.id)
    for stage in workflow["stages"]:
        stage["can_approve"] = not AUTH_ENABLED or stage.get("created_by") != user.id
    return {
        **load_execution_policy_document(),
        "catalog": {
            "capabilities": sorted(get_capability_registry().list_capabilities()),
            "tools": sorted(get_tool_registry().list_tools()),
        },
        "workflow": workflow,
        "approval_mode": "four_eyes" if AUTH_ENABLED else "single_admin",
        "current_user_id": user.id,
    }


def _policy_error(exc: ValueError) -> HTTPException:
    return HTTPException(status_code=422, detail=str(exc))


def _record_policy_change(action: str, target: str, policy: dict | None) -> None:
    from cognivoy.multi_user.audit import log_control_plane_event
    from cognivoy.multi_user.context import get_current_user

    user = get_current_user()
    payload = json.dumps(policy or {}, sort_keys=True, separators=(",", ":"))
    log_control_plane_event(
        {
            "event": "policy_change",
            "category": "execution_policy",
            "action": action,
            "name": target,
            "target_user_id": "" if target == "default" else target,
            "policy_digest": hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16],
            "risk_level": "high",
            "tenant_id": str(user.scope.user_id or user.id),
            "user_id": user.id,
            "role": user.role,
            "session_id": "",
            "turn_id": "",
        }
    )


@router.get("/events")
async def list_control_plane_events(
    since_hours: int = Query(default=24, ge=1, le=720),
    limit: int = Query(default=100, ge=1, le=200),
    decision: Literal["all", "allowed", "denied"] = "all",
    risk_level: Literal["", "medium", "high", "critical"] = "",
    user_id: str = Query(default="", max_length=128),
    name: str = Query(default="", max_length=128),
):
    """Return a bounded recent audit view and aggregate security signals."""
    return await asyncio.to_thread(
        query_control_plane_events,
        since_hours=since_hours,
        limit=limit,
        decision=decision,
        risk_level=risk_level,
        user_id=user_id.strip(),
        name=name.strip(),
    )


@router.get("/events/export.csv")
async def export_control_plane_events(
    since_hours: int = Query(default=24, ge=1, le=720),
):
    from cognivoy.multi_user.audit import export_control_plane_events_csv

    content = await asyncio.to_thread(export_control_plane_events_csv, since_hours=since_hours)
    return Response(
        content=content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="control-plane-audit.csv"'},
    )


@router.post("/alerts/acknowledge")
async def acknowledge_alert(payload: dict):
    from cognivoy.multi_user.audit import acknowledge_control_plane_alert
    from cognivoy.multi_user.context import get_current_user

    try:
        acknowledgement = await asyncio.to_thread(
            acknowledge_control_plane_alert,
            str(payload.get("fingerprint") or ""),
            user_id=get_current_user().id,
        )
    except ValueError as exc:
        raise _policy_error(exc) from exc
    return {"acknowledgement": acknowledgement}


@router.get("/policies")
async def get_execution_policies():
    """Return deployment and tenant policy plus the current execution catalog."""
    return await asyncio.to_thread(_policy_bundle)


@router.post("/policies/simulate")
async def simulate_execution_policy(payload: dict):
    from cognivoy.services.config.policy_workflow import simulate_policy_change

    try:
        return await asyncio.to_thread(
            simulate_policy_change,
            scope=str(payload.get("scope") or ""),
            tenant_id=str(payload.get("tenant_id") or ""),
            payload=payload.get("policy"),
        )
    except ValueError as exc:
        raise _policy_error(exc) from exc


@router.post("/policies/stages")
async def stage_execution_policy(payload: dict):
    from cognivoy.multi_user.context import get_current_user
    from cognivoy.services.config.policy_workflow import stage_policy_change

    user = get_current_user()
    try:
        stage = await asyncio.to_thread(
            stage_policy_change,
            scope=str(payload.get("scope") or ""),
            tenant_id=str(payload.get("tenant_id") or ""),
            payload=payload.get("policy"),
            created_by=user.id,
        )
    except ValueError as exc:
        raise _policy_error(exc) from exc
    target = stage["tenant_id"] if stage["scope"] == "tenant" else "default"
    _record_policy_change("staged", target, stage["simulation"]["candidate"])
    return {"stage": {key: value for key, value in stage.items() if key != "policy"}}


@router.post("/policies/stages/delete-tenant")
async def stage_tenant_policy_delete(payload: dict):
    from cognivoy.multi_user.context import get_current_user
    from cognivoy.services.config.policy_workflow import (
        stage_tenant_policy_deletion,
    )

    user = get_current_user()
    try:
        stage = await asyncio.to_thread(
            stage_tenant_policy_deletion,
            tenant_id=str(payload.get("tenant_id") or ""),
            created_by=user.id,
        )
    except ValueError as exc:
        raise _policy_error(exc) from exc
    _record_policy_change("staged_delete", stage["tenant_id"], None)
    return {"stage": {key: value for key, value in stage.items() if key != "policy"}}


@router.delete("/policies/stages/{stage_id}")
async def discard_execution_policy_stage(stage_id: str):
    from cognivoy.services.config.policy_workflow import discard_staged_policy

    try:
        workflow = await asyncio.to_thread(discard_staged_policy, stage_id)
    except ValueError as exc:
        raise _policy_error(exc) from exc
    return {"workflow": workflow}


@router.post("/policies/stages/{stage_id}/publish")
async def publish_execution_policy_stage(stage_id: str):
    from cognivoy.multi_user.audit import log_admin_action
    from cognivoy.multi_user.context import get_current_user
    from cognivoy.services.config.policy_workflow import publish_staged_policy

    user = get_current_user()
    try:
        result = await asyncio.to_thread(
            publish_staged_policy,
            stage_id,
            approved_by=user.id,
            require_separate_approver=AUTH_ENABLED,
        )
    except ValueError as exc:
        raise _policy_error(exc) from exc
    revision = result["revision"]
    target = str(revision["target"])
    log_admin_action(
        "control_plane.policy_stage.published",
        target_user_id=None if target == "default" else target,
        summary={"revision_id": revision["id"]},
    )
    _record_policy_change("published", target, result["document"])
    return await asyncio.to_thread(_policy_bundle)


@router.post("/policies/notifications/{notification_id}/read")
async def read_policy_notification(notification_id: str):
    from cognivoy.multi_user.context import get_current_user
    from cognivoy.services.config.policy_workflow import (
        mark_policy_notification_read,
    )

    try:
        await asyncio.to_thread(
            mark_policy_notification_read,
            notification_id,
            user_id=get_current_user().id,
        )
    except ValueError as exc:
        raise _policy_error(exc) from exc
    return {"ok": True}


@router.post("/policies/revisions/{revision_id}/rollback")
async def rollback_execution_policy(revision_id: str):
    from cognivoy.multi_user.audit import log_admin_action
    from cognivoy.multi_user.context import get_current_user
    from cognivoy.services.config.policy_workflow import rollback_policy_revision

    user = get_current_user()
    try:
        result = await asyncio.to_thread(rollback_policy_revision, revision_id, approved_by=user.id)
    except ValueError as exc:
        raise _policy_error(exc) from exc
    log_admin_action(
        "control_plane.policy_revision.rolled_back",
        summary={"source_revision_id": revision_id},
    )
    _record_policy_change("rollback", "document", result["document"])
    return await asyncio.to_thread(_policy_bundle)


@router.put("/policies/default")
async def put_default_execution_policy(payload: dict):
    from cognivoy.multi_user.audit import log_admin_action
    from cognivoy.services.config.execution_policy import (
        load_execution_policy_document,
        save_default_execution_policy,
    )

    if not load_execution_policy_document().get("integrity_error"):
        raise HTTPException(
            status_code=409,
            detail="Direct policy writes are disabled; preview and publish a staged change",
        )

    try:
        document = await asyncio.to_thread(save_default_execution_policy, payload)
    except ValueError as exc:
        raise _policy_error(exc) from exc
    log_admin_action(
        "control_plane.default_policy.updated",
        summary={"field_count": len(payload)},
    )
    _record_policy_change("updated", "default", document["default"])
    return await asyncio.to_thread(_policy_bundle)


@router.put("/policies/tenants/{tenant_id}")
async def put_tenant_execution_policy(tenant_id: str, payload: dict):
    del tenant_id, payload
    raise HTTPException(
        status_code=409,
        detail="Direct policy writes are disabled; preview and publish a staged change",
    )


@router.delete("/policies/tenants/{tenant_id}")
async def remove_tenant_execution_policy(tenant_id: str):
    del tenant_id
    raise HTTPException(
        status_code=409,
        detail="Direct policy deletes are disabled; stage the override deletion",
    )
