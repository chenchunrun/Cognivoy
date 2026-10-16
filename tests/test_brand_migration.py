from __future__ import annotations

import os

import cognivoy
from cognivoy.services.config import secret_envelope


def test_legacy_environment_is_copied_when_new_name_is_absent(monkeypatch):
    monkeypatch.setenv("DEEPTUTOR_HOME", "/legacy/workspace")
    monkeypatch.delenv("COGNIVOY_HOME", raising=False)

    migrated = cognivoy._migrate_legacy_environment()

    assert migrated == ("COGNIVOY_HOME",)
    assert os.environ["COGNIVOY_HOME"] == "/legacy/workspace"


def test_cognivoy_environment_takes_precedence(monkeypatch):
    monkeypatch.setenv("DEEPTUTOR_HOME", "/legacy/workspace")
    monkeypatch.setenv("COGNIVOY_HOME", "/cognivoy/workspace")

    migrated = cognivoy._migrate_legacy_environment()

    assert "COGNIVOY_HOME" not in migrated
    assert os.environ["COGNIVOY_HOME"] == "/cognivoy/workspace"


def test_openmentor_master_key_migrates_for_existing_envelopes(monkeypatch):
    monkeypatch.setenv("OPENMENTOR_MASTER_KEY", "legacy-secret-manager-value")
    monkeypatch.delenv("COGNIVOY_MASTER_KEY", raising=False)

    assert cognivoy._migrate_legacy_environment() == ("COGNIVOY_MASTER_KEY",)
    assert os.environ["COGNIVOY_MASTER_KEY"] == "legacy-secret-manager-value"


def test_legacy_secret_envelopes_remain_readable(monkeypatch):
    monkeypatch.setattr(secret_envelope, "_master_key", lambda: b"k" * 32)
    envelope = secret_envelope.encrypt_json({"token": "preserved"}, purpose="migration")
    envelope["_encrypted"] = "openmentor-aesgcm-v1"

    assert secret_envelope.is_encrypted_envelope(envelope)
    assert secret_envelope.decrypt_json(envelope, purpose="migration") == {"token": "preserved"}
