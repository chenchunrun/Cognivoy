from __future__ import annotations

import json

import pytest

from cognivoy.multi_user import paths
from cognivoy.services.config.execution_policy import (
    delete_tenant_execution_policy,
    load_execution_policy_document,
    load_execution_policy_for_tenant,
    save_default_execution_policy,
    save_tenant_execution_policy,
)


@pytest.fixture(autouse=True)
def _system_root(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    monkeypatch.setattr(paths, "LEGACY_MULTI_USER_ROOT", tmp_path / "legacy")


def _policy(**overrides):
    return {
        "allowed_capabilities": None,
        "allowed_tools": None,
        "denied_tools": [],
        "max_tool_calls": 20,
        "max_tool_calls_per_name": 5,
        **overrides,
    }


def test_tenant_policy_overrides_default_and_can_be_deleted() -> None:
    save_default_execution_policy(_policy(denied_tools=["exec"]))
    save_tenant_execution_policy(
        "tenant-a",
        _policy(allowed_capabilities=["chat"], allowed_tools=["rag", "exec"]),
    )

    tenant = load_execution_policy_for_tenant("tenant-a")
    fallback = load_execution_policy_for_tenant("tenant-b")
    assert tenant.allowed_capabilities == frozenset({"chat"})
    assert tenant.allowed_tools == frozenset({"rag"})
    assert tenant.denied_tools == frozenset({"exec"})
    assert fallback.denied_tools == frozenset({"exec"})

    delete_tenant_execution_policy("tenant-a")
    assert load_execution_policy_for_tenant("tenant-a").denied_tools == frozenset({"exec"})


def test_denied_tools_are_removed_from_same_policy_allowlist() -> None:
    save_default_execution_policy(_policy(allowed_tools=["rag", "exec"], denied_tools=["exec"]))
    policy = load_execution_policy_for_tenant("tenant-a")
    assert policy.allowed_tools == frozenset({"rag"})
    assert policy.denied_tools == frozenset({"exec"})


def test_tenant_override_cannot_expand_deployment_default() -> None:
    save_default_execution_policy(
        _policy(
            allowed_capabilities=["chat"],
            allowed_tools=["rag"],
            denied_tools=["exec"],
            max_tool_calls=6,
            max_tool_calls_per_name=2,
        )
    )
    save_tenant_execution_policy(
        "tenant-a",
        _policy(
            allowed_capabilities=None,
            allowed_tools=None,
            denied_tools=[],
            max_tool_calls=96,
            max_tool_calls_per_name=32,
        ),
    )

    effective = load_execution_policy_for_tenant("tenant-a")
    assert effective.allowed_capabilities == frozenset({"chat"})
    assert effective.allowed_tools == frozenset({"rag"})
    assert effective.denied_tools == frozenset({"exec"})
    assert effective.max_tool_calls == 6
    assert effective.max_tool_calls_per_name == 2


def test_existing_corrupt_document_fails_closed() -> None:
    policy_path = paths.SYSTEM_ROOT / "control-plane" / "policies.json"
    policy_path.parent.mkdir(parents=True)
    policy_path.write_text("{broken", encoding="utf-8")

    document = load_execution_policy_document()
    policy = load_execution_policy_for_tenant("tenant-a")
    assert document["integrity_error"]
    assert policy.allowed_capabilities == frozenset({"chat"})
    assert policy.allowed_tools == frozenset()


def test_policy_rejects_invalid_names_and_bounds() -> None:
    with pytest.raises(ValueError, match="invalid name"):
        save_default_execution_policy(_policy(denied_tools=["bad name"]))
    with pytest.raises(ValueError, match="between 1 and 96"):
        save_default_execution_policy(_policy(max_tool_calls=0))
    with pytest.raises(ValueError, match="Invalid tenant"):
        save_tenant_execution_policy("../escape", _policy())


def test_policy_file_contains_normalized_non_secret_data() -> None:
    save_default_execution_policy(_policy(allowed_tools=["rag", "rag"]))
    raw = json.loads((paths.SYSTEM_ROOT / "control-plane" / "policies.json").read_text())
    assert raw["version"] == 1
    assert raw["default"]["allowed_tools"] == ["rag"]
