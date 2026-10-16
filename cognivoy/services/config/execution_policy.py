"""Persistent deployment and tenant execution policies.

The file lives under ``data/system`` because it is administrator-owned policy,
not a preference belonging to whichever user happens to make a request.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import logging
from pathlib import Path
import re
import threading
from typing import Any

from cognivoy.services.file_io import atomic_write_json

logger = logging.getLogger(__name__)

_POLICY_VERSION = 1
_MAX_NAMES = 256
_NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
_TENANT_RE = re.compile(r"^[A-Za-z0-9_.:@-]{1,128}$")
_lock = threading.RLock()


@dataclass(frozen=True, slots=True)
class ExecutionPolicy:
    allowed_capabilities: frozenset[str] | None = None
    allowed_tools: frozenset[str] | None = None
    denied_tools: frozenset[str] = frozenset()
    max_tool_calls: int = 96
    max_tool_calls_per_name: int = 32

    def to_dict(self) -> dict[str, Any]:
        return {
            "allowed_capabilities": (
                None if self.allowed_capabilities is None else sorted(self.allowed_capabilities)
            ),
            "allowed_tools": None if self.allowed_tools is None else sorted(self.allowed_tools),
            "denied_tools": sorted(self.denied_tools),
            "max_tool_calls": self.max_tool_calls,
            "max_tool_calls_per_name": self.max_tool_calls_per_name,
        }


DEFAULT_EXECUTION_POLICY = ExecutionPolicy()
LOCKED_EXECUTION_POLICY = ExecutionPolicy(
    allowed_capabilities=frozenset({"chat"}),
    allowed_tools=frozenset(),
    max_tool_calls=1,
    max_tool_calls_per_name=1,
)


def _policy_path() -> Path:
    from cognivoy.multi_user import paths

    return paths.SYSTEM_ROOT / "control-plane" / "policies.json"


def _names(value: Any, *, nullable: bool, field_name: str) -> frozenset[str] | None:
    if value is None and nullable:
        return None
    if not isinstance(value, list):
        raise ValueError(f"{field_name} must be a list" + (" or null" if nullable else ""))
    if len(value) > _MAX_NAMES:
        raise ValueError(f"{field_name} contains too many entries")
    result: set[str] = set()
    for item in value:
        name = str(item or "").strip()
        if not _NAME_RE.fullmatch(name):
            raise ValueError(f"{field_name} contains an invalid name")
        result.add(name)
    return frozenset(result)


def _bounded_int(value: Any, *, field_name: str, maximum: int) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be an integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be an integer") from exc
    if not 1 <= parsed <= maximum:
        raise ValueError(f"{field_name} must be between 1 and {maximum}")
    return parsed


def normalize_execution_policy(payload: Any) -> ExecutionPolicy:
    if not isinstance(payload, dict):
        raise ValueError("Execution policy must be an object")
    allowed_capabilities = _names(
        payload.get("allowed_capabilities"),
        nullable=True,
        field_name="allowed_capabilities",
    )
    allowed_tools = _names(payload.get("allowed_tools"), nullable=True, field_name="allowed_tools")
    denied_tools = _names(
        payload.get("denied_tools", []), nullable=False, field_name="denied_tools"
    )
    assert denied_tools is not None
    if allowed_tools is not None:
        allowed_tools = allowed_tools - denied_tools
    return ExecutionPolicy(
        allowed_capabilities=allowed_capabilities,
        allowed_tools=allowed_tools,
        denied_tools=denied_tools,
        max_tool_calls=_bounded_int(
            payload.get("max_tool_calls", 96), field_name="max_tool_calls", maximum=96
        ),
        max_tool_calls_per_name=_bounded_int(
            payload.get("max_tool_calls_per_name", 32),
            field_name="max_tool_calls_per_name",
            maximum=32,
        ),
    )


def tighten_execution_policy(base: ExecutionPolicy, override: ExecutionPolicy) -> ExecutionPolicy:
    def intersect(
        left: frozenset[str] | None, right: frozenset[str] | None
    ) -> frozenset[str] | None:
        if left is None:
            return right
        if right is None:
            return left
        return left & right

    denied = base.denied_tools | override.denied_tools
    allowed_tools = intersect(base.allowed_tools, override.allowed_tools)
    if allowed_tools is not None:
        allowed_tools = allowed_tools - denied
    return ExecutionPolicy(
        allowed_capabilities=intersect(base.allowed_capabilities, override.allowed_capabilities),
        allowed_tools=allowed_tools,
        denied_tools=denied,
        max_tool_calls=min(base.max_tool_calls, override.max_tool_calls),
        max_tool_calls_per_name=min(base.max_tool_calls_per_name, override.max_tool_calls_per_name),
    )


def validate_tenant_id(tenant_id: str) -> str:
    normalized = str(tenant_id or "").strip()
    if not _TENANT_RE.fullmatch(normalized):
        raise ValueError("Invalid tenant id")
    return normalized


def _empty_document() -> dict[str, Any]:
    return {
        "version": _POLICY_VERSION,
        "default": DEFAULT_EXECUTION_POLICY.to_dict(),
        "tenants": {},
    }


def _load_document_unlocked() -> tuple[dict[str, Any], str]:
    path = _policy_path()
    if not path.exists():
        return _empty_document(), ""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict) or raw.get("version") != _POLICY_VERSION:
            raise ValueError("Unsupported execution-policy document")
        default = normalize_execution_policy(raw.get("default"))
        tenant_payloads = raw.get("tenants")
        if not isinstance(tenant_payloads, dict) or len(tenant_payloads) > 10_000:
            raise ValueError("Invalid tenant policy map")
        tenants: dict[str, dict[str, Any]] = {}
        for tenant_id, payload in tenant_payloads.items():
            normalized_id = validate_tenant_id(str(tenant_id))
            tenants[normalized_id] = normalize_execution_policy(payload).to_dict()
        return {
            "version": _POLICY_VERSION,
            "default": default.to_dict(),
            "tenants": tenants,
        }, ""
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as exc:
        logger.error("Execution policy integrity failure: %s", exc)
        return {
            "version": _POLICY_VERSION,
            "default": LOCKED_EXECUTION_POLICY.to_dict(),
            "tenants": {},
        }, "Execution policy failed integrity validation; fail-closed policy is active"


def load_execution_policy_document() -> dict[str, Any]:
    with _lock:
        document, integrity_error = _load_document_unlocked()
    return {**document, "integrity_error": integrity_error}


def load_execution_policy_for_tenant(tenant_id: str) -> ExecutionPolicy:
    normalized_id = validate_tenant_id(tenant_id)
    with _lock:
        document, _integrity_error = _load_document_unlocked()
    default = normalize_execution_policy(document["default"])
    tenant_payload = document["tenants"].get(normalized_id)
    if tenant_payload is None:
        return default
    return tighten_execution_policy(default, normalize_execution_policy(tenant_payload))


def save_default_execution_policy(payload: Any) -> dict[str, Any]:
    policy = normalize_execution_policy(payload)
    with _lock:
        document, _integrity_error = _load_document_unlocked()
        document["default"] = policy.to_dict()
        atomic_write_json(_policy_path(), document)
    return load_execution_policy_document()


def save_tenant_execution_policy(tenant_id: str, payload: Any) -> dict[str, Any]:
    normalized_id = validate_tenant_id(tenant_id)
    policy = normalize_execution_policy(payload)
    with _lock:
        document, integrity_error = _load_document_unlocked()
        if integrity_error:
            raise ValueError("Repair the default execution policy before adding tenant policies")
        document["tenants"][normalized_id] = policy.to_dict()
        atomic_write_json(_policy_path(), document)
    return load_execution_policy_document()


def delete_tenant_execution_policy(tenant_id: str) -> dict[str, Any]:
    normalized_id = validate_tenant_id(tenant_id)
    with _lock:
        document, integrity_error = _load_document_unlocked()
        if integrity_error:
            raise ValueError("Repair the default execution policy before deleting tenant policies")
        document["tenants"].pop(normalized_id, None)
        atomic_write_json(_policy_path(), document)
    return load_execution_policy_document()


def replace_execution_policy_document(payload: Any) -> dict[str, Any]:
    """Atomically replace the complete policy document with validated content."""
    if not isinstance(payload, dict):
        raise ValueError("Execution policy document must be an object")
    default = normalize_execution_policy(payload.get("default"))
    tenant_payloads = payload.get("tenants")
    if not isinstance(tenant_payloads, dict) or len(tenant_payloads) > 10_000:
        raise ValueError("Invalid tenant policy map")
    tenants: dict[str, dict[str, Any]] = {}
    for tenant_id, policy_payload in tenant_payloads.items():
        normalized_id = validate_tenant_id(str(tenant_id))
        tenants[normalized_id] = normalize_execution_policy(policy_payload).to_dict()
    document = {
        "version": _POLICY_VERSION,
        "default": default.to_dict(),
        "tenants": tenants,
    }
    with _lock:
        atomic_write_json(_policy_path(), document)
    return load_execution_policy_document()


__all__ = [
    "DEFAULT_EXECUTION_POLICY",
    "ExecutionPolicy",
    "delete_tenant_execution_policy",
    "load_execution_policy_document",
    "load_execution_policy_for_tenant",
    "normalize_execution_policy",
    "replace_execution_policy_document",
    "save_default_execution_policy",
    "save_tenant_execution_policy",
    "tighten_execution_policy",
    "validate_tenant_id",
]
