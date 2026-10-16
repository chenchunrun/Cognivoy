"""Two-phase execution-policy publishing with bounded rollback history."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import json
import threading
from typing import Any, Literal
from uuid import uuid4

from cognivoy.services.config.execution_policy import (
    delete_tenant_execution_policy,
    load_execution_policy_document,
    load_execution_policy_for_tenant,
    normalize_execution_policy,
    replace_execution_policy_document,
    save_default_execution_policy,
    save_tenant_execution_policy,
    tighten_execution_policy,
    validate_tenant_id,
)
from cognivoy.services.file_io import atomic_write_json

PolicyScope = Literal["default", "tenant"]
_lock = threading.RLock()
_MAX_STAGES = 50
_MAX_REVISIONS = 100
_MAX_NOTIFICATIONS = 500
_STAGE_TTL_HOURS = 24


def _workflow_path():
    from cognivoy.multi_user import paths

    return paths.SYSTEM_ROOT / "control-plane" / "policy-workflow.json"


def _empty_workflow() -> dict[str, Any]:
    return {"version": 1, "stages": [], "revisions": [], "notifications": []}


def _load_workflow_unlocked() -> dict[str, Any]:
    path = _workflow_path()
    if not path.exists():
        return _empty_workflow()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("Policy workflow state failed integrity validation") from exc
    if (
        not isinstance(raw, dict)
        or raw.get("version") != 1
        or not isinstance(raw.get("stages"), list)
        or not isinstance(raw.get("revisions"), list)
    ):
        raise ValueError("Policy workflow state failed integrity validation")
    raw.setdefault("notifications", [])
    if not isinstance(raw["notifications"], list):
        raise ValueError("Policy workflow state failed integrity validation")
    return raw


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _is_expired(stage: dict[str, Any]) -> bool:
    try:
        expires_at = datetime.fromisoformat(
            str(stage.get("expires_at") or "").replace("Z", "+00:00")
        )
    except ValueError:
        return True
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at.astimezone(timezone.utc) <= _now()


def _notification(stage: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": uuid4().hex,
        "type": "policy_approval_requested",
        "created_at": stage["created_at"],
        "stage_id": stage["id"],
        "target": stage["tenant_id"] or "default",
        "excluded_user_id": stage["created_by"],
        "read_by": [],
        "resolved_at": "",
    }


def _resolve_stage_notifications(workflow: dict[str, Any], stage_id: str) -> None:
    resolved_at = _now().isoformat()
    for notification in workflow["notifications"]:
        if notification.get("stage_id") == stage_id and not notification.get("resolved_at"):
            notification["resolved_at"] = resolved_at


def _policy_document() -> dict[str, Any]:
    document = load_execution_policy_document()
    if document.get("integrity_error"):
        raise ValueError("Repair the execution policy before using the publish workflow")
    return {
        "version": int(document["version"]),
        "default": document["default"],
        "tenants": document["tenants"],
    }


def _digest(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]


def _scope(scope: str, tenant_id: str) -> tuple[PolicyScope, str]:
    normalized_scope = str(scope or "").strip()
    if normalized_scope == "default":
        return "default", ""
    if normalized_scope == "tenant":
        return "tenant", validate_tenant_id(tenant_id)
    raise ValueError("Policy scope must be default or tenant")


def _set_diff(before: frozenset[str] | None, after: frozenset[str] | None) -> dict[str, Any]:
    return {
        "before_unrestricted": before is None,
        "after_unrestricted": after is None,
        "removed": sorted(before - after) if before is not None and after is not None else [],
        "added": sorted(after - before) if before is not None and after is not None else [],
        "became_restricted": before is None and after is not None,
        "became_unrestricted": before is not None and after is None,
    }


def simulate_policy_change(*, scope: str, tenant_id: str = "", payload: Any) -> dict[str, Any]:
    normalized_scope, normalized_tenant = _scope(scope, tenant_id)
    candidate = normalize_execution_policy(payload)
    document = _policy_document()
    if normalized_scope == "default":
        before = normalize_execution_policy(document["default"])
        after = candidate
        affected_tenants = len(document["tenants"])
    else:
        before = load_execution_policy_for_tenant(normalized_tenant)
        default = normalize_execution_policy(document["default"])
        after = tighten_execution_policy(default, candidate)
        affected_tenants = 1

    warnings: list[str] = []
    if after.allowed_capabilities == frozenset():
        warnings.append("no_capabilities")
    elif before.allowed_capabilities is None and after.allowed_capabilities is not None:
        warnings.append("capability_scope_restricted")
    if after.allowed_tools == frozenset():
        warnings.append("no_tools")
    elif before.allowed_tools is None and after.allowed_tools is not None:
        warnings.append("tool_scope_restricted")
    if after.max_tool_calls < before.max_tool_calls:
        warnings.append("tool_budget_decrease")
    return {
        "scope": normalized_scope,
        "tenant_id": normalized_tenant,
        "candidate": candidate.to_dict(),
        "base_digest": _digest(document),
        "candidate_digest": _digest(candidate.to_dict()),
        "affected_tenants": affected_tenants,
        "changes": {
            "capabilities": _set_diff(before.allowed_capabilities, after.allowed_capabilities),
            "tools": _set_diff(before.allowed_tools, after.allowed_tools),
            "denied_tools": _set_diff(before.denied_tools, after.denied_tools),
            "max_tool_calls": {"before": before.max_tool_calls, "after": after.max_tool_calls},
            "max_tool_calls_per_name": {
                "before": before.max_tool_calls_per_name,
                "after": after.max_tool_calls_per_name,
            },
        },
        "warnings": warnings,
    }


def stage_policy_change(
    *, scope: str, tenant_id: str = "", payload: Any, created_by: str
) -> dict[str, Any]:
    simulation = simulate_policy_change(scope=scope, tenant_id=tenant_id, payload=payload)
    created_at = _now()
    stage = {
        "id": uuid4().hex,
        "created_at": created_at.isoformat(),
        "expires_at": (created_at + timedelta(hours=_STAGE_TTL_HOURS)).isoformat(),
        "created_by": str(created_by or ""),
        "scope": simulation["scope"],
        "operation": "upsert",
        "tenant_id": simulation["tenant_id"],
        "base_digest": simulation["base_digest"],
        "candidate_digest": simulation["candidate_digest"],
        "policy": simulation["candidate"],
        "simulation": simulation,
    }
    with _lock:
        workflow = _load_workflow_unlocked()
        workflow["stages"] = [stage, *workflow["stages"]][:_MAX_STAGES]
        workflow["notifications"] = [
            _notification(stage),
            *workflow["notifications"],
        ][:_MAX_NOTIFICATIONS]
        atomic_write_json(_workflow_path(), workflow)
    return stage


def stage_tenant_policy_deletion(*, tenant_id: str, created_by: str) -> dict[str, Any]:
    normalized_tenant = validate_tenant_id(tenant_id)
    document = _policy_document()
    if normalized_tenant not in document["tenants"]:
        raise ValueError("Tenant policy override was not found")
    before = load_execution_policy_for_tenant(normalized_tenant)
    after = normalize_execution_policy(document["default"])
    simulation = {
        "scope": "tenant",
        "tenant_id": normalized_tenant,
        "base_digest": _digest(document),
        "candidate_digest": _digest({"delete": normalized_tenant}),
        "affected_tenants": 1,
        "changes": {
            "capabilities": _set_diff(before.allowed_capabilities, after.allowed_capabilities),
            "tools": _set_diff(before.allowed_tools, after.allowed_tools),
            "denied_tools": _set_diff(before.denied_tools, after.denied_tools),
            "max_tool_calls": {"before": before.max_tool_calls, "after": after.max_tool_calls},
            "max_tool_calls_per_name": {
                "before": before.max_tool_calls_per_name,
                "after": after.max_tool_calls_per_name,
            },
        },
        "warnings": ["tenant_override_removal"],
    }
    created_at = _now()
    stage = {
        "id": uuid4().hex,
        "created_at": created_at.isoformat(),
        "expires_at": (created_at + timedelta(hours=_STAGE_TTL_HOURS)).isoformat(),
        "created_by": str(created_by or ""),
        "scope": "tenant",
        "operation": "delete",
        "tenant_id": normalized_tenant,
        "base_digest": simulation["base_digest"],
        "candidate_digest": simulation["candidate_digest"],
        "policy": None,
        "simulation": simulation,
    }
    with _lock:
        workflow = _load_workflow_unlocked()
        workflow["stages"] = [stage, *workflow["stages"]][:_MAX_STAGES]
        workflow["notifications"] = [
            _notification(stage),
            *workflow["notifications"],
        ][:_MAX_NOTIFICATIONS]
        atomic_write_json(_workflow_path(), workflow)
    return stage


def publish_staged_policy(
    stage_id: str,
    *,
    approved_by: str,
    require_separate_approver: bool = False,
) -> dict[str, Any]:
    normalized_id = str(stage_id or "").strip()
    with _lock:
        workflow = _load_workflow_unlocked()
        stage = next((row for row in workflow["stages"] if row.get("id") == normalized_id), None)
        if stage is None:
            raise ValueError("Staged policy was not found")
        if _is_expired(stage):
            raise ValueError("Staged policy approval has expired")
        if require_separate_approver and stage.get("created_by") == str(approved_by or ""):
            raise ValueError("The policy creator cannot approve their own staged change")
        document_before = _policy_document()
        if _digest(document_before) != stage.get("base_digest"):
            raise ValueError("Execution policy changed after staging; run the preview again")
        if stage.get("operation") == "delete":
            target = validate_tenant_id(stage["tenant_id"])
            saved = delete_tenant_execution_policy(target)
        elif stage["scope"] == "default":
            saved = save_default_execution_policy(stage["policy"])
            target = "default"
        else:
            target = validate_tenant_id(stage["tenant_id"])
            saved = save_tenant_execution_policy(target, stage["policy"])
        document_after = {
            "version": saved["version"],
            "default": saved["default"],
            "tenants": saved["tenants"],
        }
        revision = {
            "id": uuid4().hex,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "created_by": str(approved_by or ""),
            "action": "published",
            "scope": stage["scope"],
            "target": target,
            "policy_digest": _digest(document_after),
            "rollback_digest": _digest(document_before),
            "source_stage_id": stage["id"],
            # The hidden snapshot is the state immediately before this publish,
            # so rolling back the revision actually undoes the change.
            "document": document_before,
        }
        workflow["stages"] = [row for row in workflow["stages"] if row.get("id") != normalized_id]
        _resolve_stage_notifications(workflow, normalized_id)
        workflow["revisions"] = [revision, *workflow["revisions"]][:_MAX_REVISIONS]
        atomic_write_json(_workflow_path(), workflow)
    return {"revision": _public_revision(revision), "document": saved}


def rollback_policy_revision(revision_id: str, *, approved_by: str) -> dict[str, Any]:
    normalized_id = str(revision_id or "").strip()
    with _lock:
        workflow = _load_workflow_unlocked()
        source = next(
            (row for row in workflow["revisions"] if row.get("id") == normalized_id), None
        )
        if source is None:
            raise ValueError("Policy revision was not found")
        document_before = _policy_document()
        saved = replace_execution_policy_document(source.get("document"))
        document = {
            "version": saved["version"],
            "default": saved["default"],
            "tenants": saved["tenants"],
        }
        revision = {
            "id": uuid4().hex,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "created_by": str(approved_by or ""),
            "action": "rollback",
            "scope": "document",
            "target": normalized_id,
            "policy_digest": _digest(document),
            "rollback_digest": _digest(document_before),
            "source_revision_id": normalized_id,
            "document": document_before,
        }
        workflow["revisions"] = [revision, *workflow["revisions"]][:_MAX_REVISIONS]
        pending_stages = list(workflow["stages"])
        workflow["stages"] = []
        for stage in pending_stages:
            _resolve_stage_notifications(workflow, str(stage.get("id") or ""))
        atomic_write_json(_workflow_path(), workflow)
    return {"revision": _public_revision(revision), "document": saved}


def discard_staged_policy(stage_id: str) -> dict[str, Any]:
    normalized_id = str(stage_id or "").strip()
    with _lock:
        workflow = _load_workflow_unlocked()
        before = len(workflow["stages"])
        workflow["stages"] = [row for row in workflow["stages"] if row.get("id") != normalized_id]
        if len(workflow["stages"]) == before:
            raise ValueError("Staged policy was not found")
        _resolve_stage_notifications(workflow, normalized_id)
        atomic_write_json(_workflow_path(), workflow)
    return get_policy_workflow_state()


def _public_revision(revision: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in revision.items() if key != "document"}


def mark_policy_notification_read(notification_id: str, *, user_id: str) -> None:
    normalized_id = str(notification_id or "").strip()
    normalized_user = str(user_id or "").strip()
    with _lock:
        workflow = _load_workflow_unlocked()
        notification = next(
            (row for row in workflow["notifications"] if row.get("id") == normalized_id),
            None,
        )
        if notification is None:
            raise ValueError("Policy notification was not found")
        readers = {str(value) for value in notification.get("read_by", [])}
        readers.add(normalized_user)
        notification["read_by"] = sorted(readers)[:100]
        atomic_write_json(_workflow_path(), workflow)


def get_policy_workflow_state(*, viewer_id: str = "") -> dict[str, Any]:
    with _lock:
        workflow = _load_workflow_unlocked()
    stages = []
    for stage in workflow["stages"]:
        public = {key: value for key, value in stage.items() if key != "policy"}
        public["expired"] = _is_expired(stage)
        stages.append(public)
    notifications = []
    for notification in workflow["notifications"]:
        if notification.get("excluded_user_id") == viewer_id:
            continue
        public = {
            key: value
            for key, value in notification.items()
            if key not in {"read_by", "excluded_user_id"}
        }
        public["read"] = viewer_id in notification.get("read_by", [])
        notifications.append(public)
    return {
        "stages": stages,
        "revisions": [_public_revision(row) for row in workflow["revisions"]],
        "notifications": notifications[:50],
    }


__all__ = [
    "discard_staged_policy",
    "get_policy_workflow_state",
    "mark_policy_notification_read",
    "publish_staged_policy",
    "rollback_policy_revision",
    "simulate_policy_change",
    "stage_policy_change",
    "stage_tenant_policy_deletion",
]
