"""The general settings endpoint cannot forge filesystem registrations."""

import asyncio

from fastapi import HTTPException
import pytest

from cognivoy.api.routers import knowledge


@pytest.mark.parametrize("key", ["path", "external_path", "vault_path", "type", "cwd", "status"])
def test_config_rejects_storage_and_lifecycle_fields(monkeypatch, tmp_path, key):
    monkeypatch.setattr(knowledge, "_writable_kb", lambda name: (None, name, tmp_path))
    with pytest.raises(HTTPException) as error:
        asyncio.run(knowledge.update_kb_config("kb", {key: "/outside"}))
    assert error.value.status_code == 400


def test_config_requires_writable_registered_kb(monkeypatch):
    def deny(_name):
        raise HTTPException(status_code=403, detail="Knowledge base is read-only")

    monkeypatch.setattr(knowledge, "_writable_kb", deny)
    with pytest.raises(HTTPException) as error:
        asyncio.run(knowledge.update_kb_config("admin:kb:shared", {"description": "changed"}))
    assert error.value.status_code == 403
