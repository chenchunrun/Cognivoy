from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from cognivoy.multi_user import paths
from cognivoy.services.config.execution_policy import (
    load_execution_policy_for_tenant,
    save_default_execution_policy,
    save_tenant_execution_policy,
)
from cognivoy.services.config.policy_workflow import (
    get_policy_workflow_state,
    mark_policy_notification_read,
    publish_staged_policy,
    rollback_policy_revision,
    simulate_policy_change,
    stage_policy_change,
    stage_tenant_policy_deletion,
)


@pytest.fixture(autouse=True)
def _system_root(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    monkeypatch.setattr(paths, "LEGACY_MULTI_USER_ROOT", tmp_path / "legacy")


def _policy(*, calls: int, tools=None):
    return {
        "allowed_capabilities": ["chat"],
        "allowed_tools": tools,
        "denied_tools": [],
        "max_tool_calls": calls,
        "max_tool_calls_per_name": min(calls, 4),
    }


def test_simulation_does_not_change_active_policy() -> None:
    save_default_execution_policy(_policy(calls=8, tools=["rag", "reason"]))
    result = simulate_policy_change(scope="default", payload=_policy(calls=2, tools=["rag"]))
    assert result["changes"]["tools"]["removed"] == ["reason"]
    assert result["changes"]["max_tool_calls"] == {"before": 8, "after": 2}
    assert load_execution_policy_for_tenant("alice").max_tool_calls == 8


def test_stage_publish_and_rollback_are_two_phase() -> None:
    save_default_execution_policy(_policy(calls=8, tools=["rag", "reason"]))
    stage = stage_policy_change(
        scope="default",
        payload=_policy(calls=2, tools=["rag"]),
        created_by="admin-a",
    )
    assert load_execution_policy_for_tenant("alice").max_tool_calls == 8

    published = publish_staged_policy(stage["id"], approved_by="admin-b")
    assert load_execution_policy_for_tenant("alice").max_tool_calls == 2
    state = get_policy_workflow_state()
    assert state["stages"] == []
    assert state["revisions"][0]["created_by"] == "admin-b"
    assert "document" not in state["revisions"][0]

    rollback_policy_revision(published["revision"]["id"], approved_by="admin-c")
    assert load_execution_policy_for_tenant("alice").max_tool_calls == 8
    assert get_policy_workflow_state()["revisions"][0]["action"] == "rollback"


def test_stale_stage_cannot_overwrite_newer_policy() -> None:
    save_default_execution_policy(_policy(calls=8))
    stage = stage_policy_change(scope="default", payload=_policy(calls=4), created_by="admin-a")
    save_default_execution_policy(_policy(calls=3))

    with pytest.raises(ValueError, match="changed after staging"):
        publish_staged_policy(stage["id"], approved_by="admin-b")
    assert load_execution_policy_for_tenant("alice").max_tool_calls == 3


def test_tenant_deletion_is_staged_before_it_takes_effect() -> None:
    save_default_execution_policy(_policy(calls=8))
    save_tenant_execution_policy("alice", _policy(calls=2))
    stage = stage_tenant_policy_deletion(tenant_id="alice", created_by="admin-a")
    assert load_execution_policy_for_tenant("alice").max_tool_calls == 2

    publish_staged_policy(stage["id"], approved_by="admin-b")
    assert load_execution_policy_for_tenant("alice").max_tool_calls == 8


def test_four_eyes_mode_rejects_self_approval() -> None:
    stage = stage_policy_change(scope="default", payload=_policy(calls=4), created_by="admin-a")
    with pytest.raises(ValueError, match="cannot approve their own"):
        publish_staged_policy(
            stage["id"],
            approved_by="admin-a",
            require_separate_approver=True,
        )
    publish_staged_policy(
        stage["id"],
        approved_by="admin-b",
        require_separate_approver=True,
    )


def test_stage_expires_after_24_hours(monkeypatch) -> None:
    from cognivoy.services.config import policy_workflow

    created_at = datetime(2026, 8, 26, tzinfo=timezone.utc)
    monkeypatch.setattr(policy_workflow, "_now", lambda: created_at)
    stage = stage_policy_change(scope="default", payload=_policy(calls=4), created_by="admin-a")
    monkeypatch.setattr(policy_workflow, "_now", lambda: created_at + timedelta(hours=25))
    assert get_policy_workflow_state()["stages"][0]["expired"] is True
    with pytest.raises(ValueError, match="expired"):
        publish_staged_policy(stage["id"], approved_by="admin-b")


def test_approval_notification_is_hidden_from_creator_and_tracks_read_state() -> None:
    stage = stage_policy_change(scope="default", payload=_policy(calls=4), created_by="admin-a")
    assert get_policy_workflow_state(viewer_id="admin-a")["notifications"] == []
    notification = get_policy_workflow_state(viewer_id="admin-b")["notifications"][0]
    assert notification["stage_id"] == stage["id"]
    assert notification["read"] is False

    mark_policy_notification_read(notification["id"], user_id="admin-b")
    refreshed = get_policy_workflow_state(viewer_id="admin-b")["notifications"][0]
    assert refreshed["read"] is True
