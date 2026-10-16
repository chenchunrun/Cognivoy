from __future__ import annotations

import json

from cognivoy.multi_user import audit, paths


def test_control_plane_audit_is_persistent_and_rotates(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    monkeypatch.setattr(paths, "LEGACY_MULTI_USER_ROOT", tmp_path / "legacy")
    monkeypatch.setattr(audit, "_AUDIT_MAX_BYTES", 1)
    monkeypatch.setattr(audit, "_AUDIT_BACKUPS", 2)

    audit.log_control_plane_event({"event": "policy_decision", "decision_id": "first"})
    audit.log_control_plane_event({"event": "execution_outcome", "decision_id": "second"})

    active = tmp_path / "system" / "audit" / "control-plane.jsonl"
    rotated = tmp_path / "system" / "audit" / "control-plane.jsonl.1"
    assert json.loads(active.read_text())["decision_id"] == "second"
    assert json.loads(rotated.read_text())["decision_id"] == "first"
