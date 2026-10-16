from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from cognivoy.core.agentic.tool_dispatch import dispatch_tool_calls
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream_bus import StreamBus
from cognivoy.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult
from cognivoy.multi_user.context import reset_current_user, set_current_user
from cognivoy.multi_user.models import CurrentUser, UserScope
from cognivoy.runtime.control_plane import (
    ControlPlaneDenied,
    ExecutionBudget,
    ExecutionControlPlane,
    ExecutionPrincipal,
    control_plane_scope,
    record_network_policy_denial,
)
from cognivoy.runtime.registry.tool_registry import ToolRegistry


def _principal() -> ExecutionPrincipal:
    return ExecutionPrincipal(
        user_id="u_alice",
        role="user",
        tenant_id="tenant-a",
        session_id="s1",
        turn_id="t1",
    )


def test_control_plane_from_context_binds_identity_and_redacts_args(
    tmp_path: Path, monkeypatch
) -> None:
    from cognivoy.multi_user import paths

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    user = CurrentUser(
        id="u_alice",
        username="alice",
        role="user",
        scope=UserScope(kind="user", user_id="u_alice", root=tmp_path),
    )
    token = set_current_user(user)
    try:
        context = UnifiedContext(
            session_id="s1",
            config_overrides={"max_tool_calls": 2},
            metadata={"turn_id": "t1", "tenant_id": "u_alice"},
        )
        control_plane = ExecutionControlPlane.from_context(context)
        decision = control_plane.authorize_tool("web_fetch", {"token": "super-secret"})
    finally:
        reset_current_user(token)

    assert decision.allowed is True
    assert control_plane.principal.user_id == "u_alice"
    assert control_plane.principal.tenant_id == "u_alice"
    audit_json = json.dumps(context.metadata["control_plane_audit"])
    assert "super-secret" not in audit_json
    assert decision.args_digest in audit_json
    persisted = (tmp_path / "system" / "audit" / "control-plane.jsonl").read_text()
    assert decision.decision_id in persisted
    assert "super-secret" not in persisted


def test_forged_tenant_context_is_denied(tmp_path: Path, monkeypatch) -> None:
    from cognivoy.multi_user import paths

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    user = CurrentUser(
        id="u_alice",
        username="alice",
        role="user",
        scope=UserScope(kind="user", user_id="u_alice", root=tmp_path),
    )
    token = set_current_user(user)
    try:
        control_plane = ExecutionControlPlane.from_context(
            UnifiedContext(session_id="s1", metadata={"tenant_id": "u_bob"})
        )
        capability = control_plane.authorize_capability("chat")
        tool = control_plane.authorize_tool("rag", {"query": "secret"})
    finally:
        reset_current_user(token)

    assert control_plane.principal.tenant_id == "u_alice"
    assert capability.allowed is False
    assert tool.allowed is False
    assert capability.rule_id == "identity.tenant_binding"
    assert tool.rule_id == "identity.tenant_binding"


def test_capability_allowlist_and_tool_budget_fail_closed() -> None:
    control_plane = ExecutionControlPlane(
        principal=_principal(),
        allowed_capabilities=frozenset({"chat"}),
        budget=ExecutionBudget(max_tool_calls=1, max_tool_calls_per_name=1),
    )

    assert control_plane.authorize_capability("chat").allowed is True
    denied_capability = control_plane.authorize_capability("deep_research")
    assert denied_capability.allowed is False
    assert denied_capability.rule_id == "capability.allowlist"

    assert control_plane.authorize_tool("rag", {"query": "one"}).allowed is True
    denied_tool = control_plane.authorize_tool("web_fetch", {"url": "https://example.com"})
    assert denied_tool.allowed is False
    assert denied_tool.rule_id == "budget.tool_calls"


def test_network_denial_is_redacted_and_correlated() -> None:
    rows: list[dict[str, Any]] = []
    control_plane = ExecutionControlPlane(
        principal=_principal(),
        audit_buffer=rows,
    )
    target = "http://127.0.0.1/admin?token=super-secret"

    with control_plane_scope(control_plane):
        record_network_policy_denial("web_fetch", target)

    encoded = json.dumps(rows)
    assert target not in encoded
    assert "super-secret" not in encoded
    assert rows[0]["event"] == "security_event"
    assert rows[0]["category"] == "network_policy_denial"
    assert rows[0]["name"] == "web_fetch"
    assert len(rows[0]["target_digest"]) == 16


def test_persistent_policy_and_request_constraints_only_tighten(
    tmp_path: Path, monkeypatch
) -> None:
    from cognivoy.multi_user import paths
    from cognivoy.services.config.execution_policy import save_tenant_execution_policy

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    user = CurrentUser(
        id="u_alice",
        username="alice",
        role="user",
        scope=UserScope(kind="user", user_id="u_alice", root=tmp_path),
    )
    save_tenant_execution_policy(
        "u_alice",
        {
            "allowed_capabilities": ["chat", "deep_solve"],
            "allowed_tools": ["rag", "reason"],
            "denied_tools": ["reason"],
            "max_tool_calls": 4,
            "max_tool_calls_per_name": 3,
        },
    )
    token = set_current_user(user)
    try:
        control_plane = ExecutionControlPlane.from_context(
            UnifiedContext(
                metadata={
                    "allowed_capabilities": ["chat", "deep_research"],
                    "allowed_tools": ["rag", "web_fetch"],
                },
                config_overrides={
                    "max_tool_calls": 10,
                    "max_tool_calls_per_name": 2,
                },
            )
        )
    finally:
        reset_current_user(token)

    assert control_plane.allowed_capabilities == frozenset({"chat"})
    assert control_plane.allowed_tools == frozenset({"rag"})
    assert control_plane.denied_tools == frozenset({"reason"})
    assert control_plane.budget.max_tool_calls == 4
    assert control_plane.budget.max_tool_calls_per_name == 2


class _EchoTool(BaseTool):
    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="echo",
            description="Echo text",
            parameters=[ToolParameter(name="text", type="string")],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        return ToolResult(content=str(kwargs.get("text") or ""))


@pytest.mark.asyncio
async def test_direct_registry_calls_cannot_bypass_control_plane() -> None:
    registry = ToolRegistry()
    registry.register(_EchoTool())
    control_plane = ExecutionControlPlane(
        principal=_principal(),
        allowed_tools=frozenset({"rag"}),
    )

    with control_plane_scope(control_plane):
        with pytest.raises(ControlPlaneDenied) as exc_info:
            await registry.execute("echo", text="blocked")

    assert exc_info.value.decision.rule_id == "tool.allowlist"


class _CountingRegistry:
    def __init__(self) -> None:
        self.calls = 0

    def get(self, _name: str) -> None:
        return None

    async def execute(self, _name: str, **_kwargs: Any) -> ToolResult:
        self.calls += 1
        return ToolResult(content="ok")


@pytest.mark.asyncio
async def test_dispatcher_enforces_shared_budget_before_execution() -> None:
    registry = _CountingRegistry()
    bus = StreamBus()
    control_plane = ExecutionControlPlane(
        principal=_principal(),
        budget=ExecutionBudget(max_tool_calls=1, max_tool_calls_per_name=1),
    )

    async def drain() -> None:
        async for _event in bus.subscribe():
            pass

    consumer = asyncio.create_task(drain())
    await asyncio.sleep(0)
    with control_plane_scope(control_plane):
        outcome = await dispatch_tool_calls(
            tool_calls=[
                {"id": "c1", "name": "echo", "arguments": '{"text":"one"}'},
                {"id": "c2", "name": "echo", "arguments": '{"text":"two"}'},
            ],
            context=UnifiedContext(session_id="s1"),
            stream=bus,
            source="chat",
            stage="responding",
            iteration_index=0,
            registry=registry,
        )
    await bus.close()
    await consumer

    assert registry.calls == 1
    assert outcome.tool_messages[0]["content"] == "ok"
    assert "Tool execution denied" in outcome.tool_messages[1]["content"]
