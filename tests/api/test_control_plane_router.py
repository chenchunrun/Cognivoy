from __future__ import annotations

from datetime import datetime, timezone
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient

from cognivoy.api.routers import control_plane
from cognivoy.api.routers.auth import require_admin
from cognivoy.multi_user import paths


def _write_rows(tmp_path, rows: list[dict[str, object]]) -> None:
    audit_dir = tmp_path / "system" / "audit"
    audit_dir.mkdir(parents=True, exist_ok=True)
    (audit_dir / "control-plane.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8"
    )


def _client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    monkeypatch.setattr(paths, "LEGACY_MULTI_USER_ROOT", tmp_path / "legacy")
    app = FastAPI()
    app.include_router(control_plane.router, prefix="/api/v1/control-plane")
    app.dependency_overrides[require_admin] = lambda: None
    return TestClient(app)


def test_every_control_plane_route_is_admin_gated() -> None:
    gated = {
        dependency.dependency
        for dependency in control_plane.router.dependencies
        if dependency.dependency is not None
    }
    assert require_admin in gated


def test_event_query_returns_redacted_summary_and_filters(tmp_path, monkeypatch) -> None:
    now = datetime.now(timezone.utc).isoformat()
    _write_rows(
        tmp_path,
        [
            {
                "time": now,
                "event": "policy_decision",
                "decision_id": "allow-1",
                "name": "rag",
                "allowed": True,
                "risk_level": "medium",
                "user_id": "alice",
                "unexpected_secret": "must-not-leak",
            },
            {
                "time": now,
                "event": "security_event",
                "category": "network_policy_denial",
                "name": "web_fetch",
                "allowed": False,
                "rule_id": "network.public_target",
                "risk_level": "high",
                "target_digest": "0123456789abcdef",
                "user_id": "alice",
                "raw_url": "must-not-leak.example",
            },
            {
                "time": now,
                "event": "policy_decision",
                "decision_id": "deny-1",
                "name": "exec",
                "allowed": False,
                "rule_id": "identity.tenant_binding",
                "risk_level": "critical",
                "user_id": "bob",
                "unexpected_secret": "must-not-leak",
            },
        ],
    )

    response = _client(tmp_path, monkeypatch).get(
        "/api/v1/control-plane/events?decision=denied&limit=10"
    )

    assert response.status_code == 200
    body = response.json()
    assert {event["event"] for event in body["events"]} == {
        "security_event",
        "policy_decision",
    }
    assert any(event.get("decision_id") == "deny-1" for event in body["events"])
    assert body["summary"]["decisions"] == 2
    assert body["summary"]["denied"] == 1
    assert body["summary"]["critical_denied"] == 1
    assert body["summary"]["network_denied"] == 1
    assert any(alert["code"] == "network_policy_denials" for alert in body["alerts"])
    assert body["alerts"][0]["code"] == "critical_policy_denials"
    assert "must-not-leak" not in response.text


def test_event_query_bounds_invalid_parameters(tmp_path, monkeypatch) -> None:
    response = _client(tmp_path, monkeypatch).get(
        "/api/v1/control-plane/events?limit=201&since_hours=0"
    )
    assert response.status_code == 422


def test_direct_policy_mutations_require_staged_workflow(tmp_path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    policy = {
        "allowed_capabilities": ["chat"],
        "allowed_tools": ["rag", "exec"],
        "denied_tools": ["exec"],
        "max_tool_calls": 8,
        "max_tool_calls_per_name": 3,
    }

    default_response = client.put("/api/v1/control-plane/policies/default", json=policy)
    tenant_response = client.put("/api/v1/control-plane/policies/tenants/alice", json=policy)
    deleted = client.delete("/api/v1/control-plane/policies/tenants/alice")
    assert default_response.status_code == 409
    assert tenant_response.status_code == 409
    assert deleted.status_code == 409


def test_direct_default_write_is_reserved_for_integrity_repair(tmp_path, monkeypatch) -> None:
    policy_path = tmp_path / "system" / "control-plane" / "policies.json"
    policy_path.parent.mkdir(parents=True)
    policy_path.write_text("{broken", encoding="utf-8")
    response = _client(tmp_path, monkeypatch).put(
        "/api/v1/control-plane/policies/default",
        json={
            "allowed_capabilities": ["chat"],
            "allowed_tools": [],
            "denied_tools": [],
            "max_tool_calls": 1,
            "max_tool_calls_per_name": 1,
        },
    )
    assert response.status_code == 200
    assert response.json()["integrity_error"] == ""


def test_policy_api_rejects_invalid_budget(tmp_path, monkeypatch) -> None:
    response = _client(tmp_path, monkeypatch).put(
        "/api/v1/control-plane/policies/default",
        json={
            "allowed_capabilities": None,
            "allowed_tools": None,
            "denied_tools": [],
            "max_tool_calls": 0,
            "max_tool_calls_per_name": 1,
        },
    )
    assert response.status_code == 409

    simulated = _client(tmp_path, monkeypatch).post(
        "/api/v1/control-plane/policies/simulate",
        json={
            "scope": "default",
            "tenant_id": "",
            "policy": {
                "allowed_capabilities": None,
                "allowed_tools": None,
                "denied_tools": [],
                "max_tool_calls": 0,
                "max_tool_calls_per_name": 1,
            },
        },
    )
    assert simulated.status_code == 422
    assert "between 1 and 96" in simulated.json()["detail"]


def test_alert_acknowledgement_is_invalidated_by_a_new_event(tmp_path, monkeypatch) -> None:
    first_time = datetime.now(timezone.utc).isoformat()
    first = {
        "time": first_time,
        "event": "policy_decision",
        "decision_id": "critical-1",
        "name": "exec",
        "allowed": False,
        "risk_level": "critical",
    }
    _write_rows(tmp_path, [first])
    client = _client(tmp_path, monkeypatch)

    initial = client.get("/api/v1/control-plane/events").json()
    fingerprint = initial["alerts"][0]["fingerprint"]
    assert initial["alerts"][0]["acknowledged"] is False
    acknowledged = client.post(
        "/api/v1/control-plane/alerts/acknowledge",
        json={"fingerprint": fingerprint},
    )
    assert acknowledged.status_code == 200
    assert client.get("/api/v1/control-plane/events").json()["alerts"][0]["acknowledged"] is True

    second = {
        **first,
        "time": datetime.now(timezone.utc).isoformat(),
        "decision_id": "critical-2",
    }
    _write_rows(tmp_path, [first, second])
    refreshed_alert = client.get("/api/v1/control-plane/events").json()["alerts"][0]
    assert refreshed_alert["fingerprint"] != fingerprint
    assert refreshed_alert["acknowledged"] is False


def test_csv_export_is_redacted_and_formula_safe(tmp_path, monkeypatch) -> None:
    _write_rows(
        tmp_path,
        [
            {
                "time": datetime.now(timezone.utc).isoformat(),
                "event": "policy_decision",
                "decision_id": "csv-1",
                "name": "=cmd|' /C calc'!A0",
                "allowed": False,
                "unexpected_secret": "must-not-export",
            }
        ],
    )
    response = _client(tmp_path, monkeypatch).get(
        "/api/v1/control-plane/events/export.csv?since_hours=24"
    )
    assert response.status_code == 200
    assert response.headers["content-disposition"].endswith('filename="control-plane-audit.csv"')
    assert "'=cmd" in response.text
    assert "must-not-export" not in response.text


def test_policy_workflow_stages_publishes_and_rolls_back(tmp_path, monkeypatch) -> None:
    client = _client(tmp_path, monkeypatch)
    initial = client.get("/api/v1/control-plane/policies").json()["default"]
    candidate = {
        **initial,
        "allowed_capabilities": ["chat"],
        "allowed_tools": ["rag"],
        "max_tool_calls": 7,
        "max_tool_calls_per_name": 2,
    }
    staged = client.post(
        "/api/v1/control-plane/policies/stages",
        json={"scope": "default", "tenant_id": "", "policy": candidate},
    )
    assert staged.status_code == 200
    stage = staged.json()["stage"]
    assert stage["simulation"]["changes"]["max_tool_calls"]["after"] == 7
    assert client.get("/api/v1/control-plane/policies").json()["default"] == initial

    published = client.post(f"/api/v1/control-plane/policies/stages/{stage['id']}/publish")
    assert published.status_code == 200
    published_body = published.json()
    assert published_body["default"]["max_tool_calls"] == 7
    revision_id = published_body["workflow"]["revisions"][0]["id"]
    history = client.get("/api/v1/control-plane/events?name=default").json()["events"]
    assert [event["action"] for event in history[:2]] == ["published", "staged"]
    assert all(len(event["policy_digest"]) == 16 for event in history[:2])
    assert "allowed_tools" not in json.dumps(history)

    rolled_back = client.post(f"/api/v1/control-plane/policies/revisions/{revision_id}/rollback")
    assert rolled_back.status_code == 200
    assert rolled_back.json()["default"] == initial


def test_authenticated_mode_enforces_four_eyes_at_api_boundary(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(control_plane, "AUTH_ENABLED", True)
    client = _client(tmp_path, monkeypatch)
    policy = client.get("/api/v1/control-plane/policies").json()["default"]
    stage = client.post(
        "/api/v1/control-plane/policies/stages",
        json={"scope": "default", "tenant_id": "", "policy": policy},
    ).json()["stage"]

    bundle = client.get("/api/v1/control-plane/policies").json()
    assert bundle["approval_mode"] == "four_eyes"
    assert bundle["workflow"]["stages"][0]["can_approve"] is False
    denied = client.post(f"/api/v1/control-plane/policies/stages/{stage['id']}/publish")
    assert denied.status_code == 422
    assert "cannot approve" in denied.json()["detail"]
