"""Deterministic execution control plane for capabilities and tools.

The model may propose work, but this module is the authority that admits it.
One request-scoped :class:`ExecutionControlPlane` is installed by the
orchestrator and inherited by every task spawned during that turn.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
import hashlib
import json
import logging
from typing import Any, Callable, Iterator, Literal
from uuid import uuid4

from cognivoy.core.context import UnifiedContext

logger = logging.getLogger(__name__)

ExecutionKind = Literal["capability", "tool"]

HIGH_RISK_TOOLS = frozenset(
    {
        "exec",
        "code_execution",
        "web_fetch",
        "github",
        "cron",
        "write_memory",
        "write_note",
    }
)


class ControlPlaneDenied(PermissionError):
    """Raised when a direct registry execution is rejected by policy."""

    def __init__(self, decision: "PolicyDecision") -> None:
        self.decision = decision
        super().__init__(decision.reason)


@dataclass(frozen=True, slots=True)
class ExecutionPrincipal:
    user_id: str
    role: str
    tenant_id: str
    session_id: str
    turn_id: str


@dataclass(frozen=True, slots=True)
class PolicyDecision:
    decision_id: str
    kind: ExecutionKind
    name: str
    allowed: bool
    rule_id: str
    reason: str
    risk_level: str
    args_digest: str = ""
    source: str = ""
    stage: str = ""


@dataclass(slots=True)
class ExecutionBudget:
    """Bounded, per-turn execution counters.

    Admission is synchronous and contains no ``await`` point, so increments are
    atomic with respect to the asyncio tasks sharing this request context.
    """

    max_tool_calls: int = 32
    max_tool_calls_per_name: int = 12
    tool_calls: int = 0
    per_tool: dict[str, int] = field(default_factory=dict)

    def consume_tool(self, name: str) -> tuple[bool, str, str]:
        if self.tool_calls >= self.max_tool_calls:
            return False, "budget.tool_calls", "Per-turn tool-call budget exhausted"
        used = self.per_tool.get(name, 0)
        if used >= self.max_tool_calls_per_name:
            return (
                False,
                "budget.tool_calls_per_name",
                f"Per-turn budget for tool {name!r} exhausted",
            )
        self.tool_calls += 1
        self.per_tool[name] = used + 1
        return True, "budget.admitted", "Execution budget admitted"


def _clamped_int(value: Any, *, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return min(maximum, max(minimum, parsed))


def _normalise_name_set(value: Any) -> frozenset[str] | None:
    if value is None:
        return None
    if not isinstance(value, (list, tuple, set, frozenset)):
        return frozenset()
    return frozenset(str(item).strip() for item in value if str(item).strip())


def _args_digest(args: dict[str, Any] | None) -> str:
    """Return a replay correlation digest without logging argument contents."""
    try:
        payload = json.dumps(args or {}, sort_keys=True, separators=(",", ":"), default=str)
    except (TypeError, ValueError):
        payload = repr(args)
    return hashlib.sha256(payload.encode("utf-8", errors="replace")).hexdigest()[:16]


class ExecutionControlPlane:
    """Request-scoped policy enforcement, budgeting, and audit correlation."""

    def __init__(
        self,
        *,
        principal: ExecutionPrincipal,
        budget: ExecutionBudget | None = None,
        allowed_capabilities: frozenset[str] | None = None,
        allowed_tools: frozenset[str] | None = None,
        denied_tools: frozenset[str] = frozenset(),
        audit_buffer: list[dict[str, Any]] | None = None,
        audit_sink: Callable[[dict[str, Any]], None] | None = None,
        identity_error: str = "",
    ) -> None:
        self.principal = principal
        self.budget = budget or ExecutionBudget()
        self.allowed_capabilities = allowed_capabilities
        self.allowed_tools = allowed_tools
        self.denied_tools = denied_tools
        self.audit_buffer = audit_buffer
        self.audit_sink = audit_sink
        self.identity_error = identity_error

    @classmethod
    def from_context(cls, context: UnifiedContext) -> "ExecutionControlPlane":
        # Imported lazily to keep ``runtime`` importable while the multi-user
        # package is still constructing its path and identity context.
        from cognivoy.multi_user.audit import log_control_plane_event
        from cognivoy.multi_user.context import get_current_user
        from cognivoy.services.config.execution_policy import (
            load_execution_policy_for_tenant,
        )

        user = get_current_user()
        metadata = context.metadata
        authenticated_tenant_id = str(user.scope.user_id or user.id)
        persistent_policy = load_execution_policy_for_tenant(authenticated_tenant_id)
        supplied_tenant_id = str(metadata.get("tenant_id") or "").strip()
        identity_error = ""
        if supplied_tenant_id and supplied_tenant_id != authenticated_tenant_id:
            identity_error = "Request tenant does not match the authenticated workspace scope"
        audit_buffer = metadata.setdefault("control_plane_audit", [])
        if not isinstance(audit_buffer, list):
            audit_buffer = []
            metadata["control_plane_audit"] = audit_buffer
        request_capabilities = _normalise_name_set(metadata.get("allowed_capabilities"))
        request_tools = _normalise_name_set(metadata.get("allowed_tools"))

        def tighten(
            persistent: frozenset[str] | None,
            requested: frozenset[str] | None,
        ) -> frozenset[str] | None:
            if persistent is None:
                return requested
            if requested is None:
                return persistent
            return persistent & requested

        return cls(
            principal=ExecutionPrincipal(
                user_id=user.id,
                role=user.role,
                tenant_id=authenticated_tenant_id,
                session_id=context.session_id,
                turn_id=str(metadata.get("turn_id") or ""),
            ),
            budget=ExecutionBudget(
                # Per-request overrides may tighten a server ceiling but may
                # never expand it. A caller is not an authority over its own
                # resource guardrails.
                max_tool_calls=min(
                    persistent_policy.max_tool_calls,
                    96,
                    _clamped_int(
                        context.config_overrides.get("max_tool_calls"),
                        default=96,
                        minimum=1,
                        maximum=96,
                    ),
                ),
                max_tool_calls_per_name=min(
                    persistent_policy.max_tool_calls_per_name,
                    32,
                    _clamped_int(
                        context.config_overrides.get("max_tool_calls_per_name"),
                        default=32,
                        minimum=1,
                        maximum=32,
                    ),
                ),
            ),
            allowed_capabilities=tighten(
                persistent_policy.allowed_capabilities, request_capabilities
            ),
            allowed_tools=tighten(persistent_policy.allowed_tools, request_tools),
            denied_tools=(
                persistent_policy.denied_tools
                | (_normalise_name_set(metadata.get("denied_tools")) or frozenset())
            ),
            audit_buffer=audit_buffer,
            audit_sink=log_control_plane_event,
            identity_error=identity_error,
        )

    def authorize_capability(self, name: str, *, source: str = "orchestrator") -> PolicyDecision:
        normalised = str(name or "").strip()
        if self.identity_error:
            return self._decision(
                kind="capability",
                name=normalised,
                allowed=False,
                rule_id="identity.tenant_binding",
                reason=self.identity_error,
                risk_level="critical",
                source=source,
            )
        if not normalised:
            return self._decision(
                kind="capability",
                name=normalised,
                allowed=False,
                rule_id="capability.valid_name",
                reason="Capability name is empty",
                risk_level="high",
                source=source,
            )
        if self.allowed_capabilities is not None and normalised not in self.allowed_capabilities:
            return self._decision(
                kind="capability",
                name=normalised,
                allowed=False,
                rule_id="capability.allowlist",
                reason=f"Capability {normalised!r} is not allowed for this request",
                risk_level="high",
                source=source,
            )
        return self._decision(
            kind="capability",
            name=normalised,
            allowed=True,
            rule_id="capability.admitted",
            reason="Capability admitted",
            risk_level="medium",
            source=source,
        )

    def authorize_tool(
        self,
        name: str,
        args: dict[str, Any] | None = None,
        *,
        source: str = "",
        stage: str = "",
    ) -> PolicyDecision:
        normalised = str(name or "").strip()
        risk = "high" if normalised in HIGH_RISK_TOOLS else "medium"
        if self.identity_error:
            return self._decision(
                kind="tool",
                name=normalised,
                allowed=False,
                rule_id="identity.tenant_binding",
                reason=self.identity_error,
                risk_level="critical",
                args=args,
                source=source,
                stage=stage,
            )
        if not normalised:
            return self._decision(
                kind="tool",
                name=normalised,
                allowed=False,
                rule_id="tool.valid_name",
                reason="Tool name is empty",
                risk_level="high",
                args=args,
                source=source,
                stage=stage,
            )
        if normalised in self.denied_tools:
            return self._decision(
                kind="tool",
                name=normalised,
                allowed=False,
                rule_id="tool.denylist",
                reason=f"Tool {normalised!r} is denied for this request",
                risk_level=risk,
                args=args,
                source=source,
                stage=stage,
            )
        if self.allowed_tools is not None and normalised not in self.allowed_tools:
            return self._decision(
                kind="tool",
                name=normalised,
                allowed=False,
                rule_id="tool.allowlist",
                reason=f"Tool {normalised!r} is not allowed for this request",
                risk_level=risk,
                args=args,
                source=source,
                stage=stage,
            )
        admitted, rule_id, reason = self.budget.consume_tool(normalised)
        return self._decision(
            kind="tool",
            name=normalised,
            allowed=admitted,
            rule_id=rule_id,
            reason=reason,
            risk_level=risk,
            args=args,
            source=source,
            stage=stage,
        )

    def record_outcome(
        self,
        decision: PolicyDecision,
        *,
        success: bool,
        error_type: str = "",
    ) -> None:
        self._audit(
            {
                "event": "execution_outcome",
                "decision_id": decision.decision_id,
                "kind": decision.kind,
                "name": decision.name,
                "success": bool(success),
                "error_type": str(error_type or ""),
            }
        )

    def record_security_event(
        self,
        *,
        category: str,
        name: str,
        rule_id: str,
        reason: str,
        risk_level: str = "high",
        target_digest: str = "",
    ) -> None:
        """Record a non-execution security decision in the same audit stream."""
        self._audit(
            {
                "event": "security_event",
                "category": str(category or "security"),
                "name": str(name or ""),
                "allowed": False,
                "rule_id": str(rule_id or "security.denied"),
                "reason": str(reason or "Security policy denied the operation"),
                "risk_level": str(risk_level or "high"),
                "target_digest": str(target_digest or ""),
            }
        )

    def _decision(
        self,
        *,
        kind: ExecutionKind,
        name: str,
        allowed: bool,
        rule_id: str,
        reason: str,
        risk_level: str,
        args: dict[str, Any] | None = None,
        source: str = "",
        stage: str = "",
    ) -> PolicyDecision:
        decision = PolicyDecision(
            decision_id=uuid4().hex,
            kind=kind,
            name=name,
            allowed=allowed,
            rule_id=rule_id,
            reason=reason,
            risk_level=risk_level,
            args_digest=_args_digest(args) if kind == "tool" else "",
            source=source,
            stage=stage,
        )
        self._audit(
            {
                "event": "policy_decision",
                "decision_id": decision.decision_id,
                "kind": decision.kind,
                "name": decision.name,
                "allowed": decision.allowed,
                "rule_id": decision.rule_id,
                "reason": decision.reason,
                "risk_level": decision.risk_level,
                "args_digest": decision.args_digest,
                "source": decision.source,
                "stage": decision.stage,
            }
        )
        return decision

    def _audit(self, payload: dict[str, Any]) -> None:
        row = {
            **payload,
            "tenant_id": self.principal.tenant_id,
            "user_id": self.principal.user_id,
            "role": self.principal.role,
            "session_id": self.principal.session_id,
            "turn_id": self.principal.turn_id,
        }
        if self.audit_buffer is not None:
            self.audit_buffer.append(row)
        if self.audit_sink is not None:
            try:
                self.audit_sink(row)
            except Exception:
                logger.exception("Failed to persist control-plane audit event")
        logger.info("control_plane %s", json.dumps(row, sort_keys=True, ensure_ascii=False))


_current_control_plane: ContextVar[ExecutionControlPlane | None] = ContextVar(
    "cognivoy_execution_control_plane", default=None
)
_registry_guard_bypass: ContextVar[int] = ContextVar(
    "cognivoy_control_plane_registry_guard_bypass", default=0
)


def get_current_control_plane() -> ExecutionControlPlane | None:
    return _current_control_plane.get()


def record_network_policy_denial(feature: str, target: str) -> None:
    """Audit an outbound-target denial without retaining the target itself."""
    digest = hashlib.sha256(
        str(target or "").strip().encode("utf-8", errors="replace")
    ).hexdigest()[:16]
    fields = {
        "category": "network_policy_denial",
        "name": str(feature or "outbound network"),
        "rule_id": "network.public_target",
        "reason": "Outbound target rejected by public-network policy",
        "risk_level": "high",
        "target_digest": digest,
    }
    control_plane = get_current_control_plane()
    if control_plane is not None:
        control_plane.record_security_event(**fields)
        return

    # Some protected downloads run in background workers outside an
    # orchestrated turn. They still belong in the operator audit stream.
    try:
        from cognivoy.multi_user.audit import log_control_plane_event
        from cognivoy.multi_user.context import get_current_user_or_none

        user = get_current_user_or_none()
        if user is None:
            return
        log_control_plane_event(
            {
                "event": "security_event",
                **fields,
                "tenant_id": str(user.scope.user_id or user.id),
                "user_id": user.id,
                "role": user.role,
                "session_id": "",
                "turn_id": "",
            }
        )
    except Exception:
        logger.exception("Failed to persist network-policy denial")


def registry_guard_is_bypassed() -> bool:
    return _registry_guard_bypass.get() > 0


@contextmanager
def control_plane_scope(control_plane: ExecutionControlPlane) -> Iterator[None]:
    token: Token[ExecutionControlPlane | None] = _current_control_plane.set(control_plane)
    try:
        yield
    finally:
        _current_control_plane.reset(token)


@contextmanager
def authorized_registry_execution() -> Iterator[None]:
    token = _registry_guard_bypass.set(_registry_guard_bypass.get() + 1)
    try:
        yield
    finally:
        _registry_guard_bypass.reset(token)


__all__ = [
    "ControlPlaneDenied",
    "ExecutionBudget",
    "ExecutionControlPlane",
    "ExecutionPrincipal",
    "PolicyDecision",
    "authorized_registry_execution",
    "control_plane_scope",
    "get_current_control_plane",
    "record_network_policy_denial",
    "registry_guard_is_bypassed",
]
