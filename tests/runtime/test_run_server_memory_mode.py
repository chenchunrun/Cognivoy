from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from cognivoy.api import run_server


@pytest.fixture
def uvicorn_kwargs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, Any]:
    captured: dict[str, Any] = {}

    monkeypatch.setattr(run_server, "get_runtime_home", lambda: tmp_path)
    monkeypatch.setattr(run_server.os, "chdir", lambda _path: None)
    monkeypatch.setattr(run_server.uvicorn, "run", lambda *args, **kwargs: captured.update(kwargs))

    from cognivoy import logging as cognivoy_logging
    from cognivoy.runtime import mode
    from cognivoy.services import config, setup

    monkeypatch.setattr(cognivoy_logging, "configure_logging", lambda: None)
    monkeypatch.setattr(mode, "set_mode", lambda _mode: None)
    monkeypatch.setattr(setup, "get_backend_port", lambda _root: 8001)
    monkeypatch.setattr(config, "load_auth_settings", lambda: {"enabled": False})
    return captured


def test_run_server_disables_reload_by_default(
    monkeypatch: pytest.MonkeyPatch, uvicorn_kwargs: dict[str, Any]
) -> None:
    monkeypatch.delenv("COGNIVOY_DEV_RELOAD", raising=False)

    run_server.main()

    assert uvicorn_kwargs["reload"] is False
    assert uvicorn_kwargs["reload_excludes"] is None
    assert uvicorn_kwargs["host"] == "127.0.0.1"


def test_run_server_reload_remains_available_for_development(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    uvicorn_kwargs: dict[str, Any],
) -> None:
    monkeypatch.setenv("COGNIVOY_DEV_RELOAD", "true")
    (tmp_path / "data").mkdir()

    run_server.main()

    assert uvicorn_kwargs["reload"] is True
    assert str(tmp_path / "data") in uvicorn_kwargs["reload_excludes"]


def test_run_server_honors_explicit_bind_address(
    monkeypatch: pytest.MonkeyPatch, uvicorn_kwargs: dict[str, Any]
) -> None:
    from cognivoy.services import config

    monkeypatch.setenv("COGNIVOY_HOST", "0.0.0.0")
    monkeypatch.setattr(config, "load_auth_settings", lambda: {"enabled": True})

    run_server.main()

    assert uvicorn_kwargs["host"] == "0.0.0.0"
