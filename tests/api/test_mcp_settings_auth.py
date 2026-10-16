"""The deployment MCP registry is admin-only, and single-server writes are surgical.

A ``stdio`` server's ``command`` runs on the host as the application user, so
every route that can read or change this registry is administrator-gated. That
gate had no test at all.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from cognivoy.api.routers import mcp_settings
from cognivoy.api.routers.auth import require_admin
from cognivoy.services.mcp.config import MCPConfig, MCPServerConfig


@pytest.fixture(autouse=True)
def _offline_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    """The URL guard resolves DNS; a unit test must not depend on a resolver."""
    import socket

    monkeypatch.setattr(
        "cognivoy.services.mcp.network.socket.getaddrinfo",
        lambda host, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))],
    )


@pytest.fixture
def admin_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """Mount the router with the admin gate satisfied and config on tmp disk."""
    config_path = tmp_path / "mcp.json"
    monkeypatch.setattr(
        "cognivoy.services.mcp.config.mcp_config_path",
        lambda: config_path,
    )

    class _Manager:
        async def ensure_started(self) -> None: ...

        async def reload(self) -> None: ...

        def status(self, owner: str = "_shared") -> list[dict[str, object]]:
            return []

    monkeypatch.setattr(mcp_settings, "get_mcp_manager", lambda: _Manager())

    app = FastAPI()
    app.include_router(mcp_settings.router, prefix="/api/v1/settings/mcp")
    app.dependency_overrides[require_admin] = lambda: None
    return TestClient(app)


def _write(config_path: Path, config: MCPConfig) -> None:
    config_path.write_text(config.model_dump_json(indent=2), encoding="utf-8")


def test_every_route_is_admin_gated() -> None:
    """Asserted on the router itself: a route added later inherits the gate.

    Checking each path individually would pass while a newly added route sat
    ungated, because the dependency lives on the router.
    """
    gated = {
        dependency.dependency
        for dependency in mcp_settings.router.dependencies
        if dependency.dependency is not None
    }
    assert require_admin in gated


def test_single_server_put_preserves_the_other_entries(
    admin_client: TestClient, tmp_path: Path
) -> None:
    config_path = tmp_path / "mcp.json"
    _write(
        config_path,
        MCPConfig(
            servers={
                "keep": MCPServerConfig(url="https://keep.example/mcp", disabled_tools=["noisy"]),
                "edit": MCPServerConfig(url="https://old.example/mcp"),
            }
        ),
    )

    response = admin_client.put(
        "/api/v1/settings/mcp/servers/edit",
        json={"url": "https://new.example/mcp"},
    )

    assert response.status_code == 200
    servers = response.json()["servers"]
    assert servers["edit"]["url"] == "https://new.example/mcp"
    # The untouched entry keeps a field the editor does not model.
    assert servers["keep"]["disabled_tools"] == ["noisy"]


def test_single_server_delete_removes_only_that_entry(
    admin_client: TestClient, tmp_path: Path
) -> None:
    config_path = tmp_path / "mcp.json"
    _write(
        config_path,
        MCPConfig(
            servers={
                "a": MCPServerConfig(url="https://a.example/mcp"),
                "b": MCPServerConfig(url="https://b.example/mcp"),
            }
        ),
    )

    response = admin_client.delete("/api/v1/settings/mcp/servers/a")

    assert response.status_code == 200
    assert set(response.json()["servers"]) == {"b"}


def test_an_invalid_server_name_is_refused(admin_client: TestClient, tmp_path: Path) -> None:
    (tmp_path / "mcp.json").write_text('{"servers": {}}', encoding="utf-8")
    response = admin_client.put(
        "/api/v1/settings/mcp/servers/bad name!",
        json={"url": "https://x.example/mcp"},
    )
    assert response.status_code == 400


def test_admin_registry_masks_and_preserves_stdio_environment_secrets(
    admin_client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config_path = tmp_path / "mcp.json"
    _write(
        config_path,
        MCPConfig(
            servers={
                "local": MCPServerConfig(
                    command="npx",
                    args=["trusted-server"],
                    env={"API_KEY": "sk-secret", "MODE": "safe"},
                )
            }
        ),
    )

    body = admin_client.get("/api/v1/settings/mcp").json()
    assert "sk-secret" not in repr(body)
    assert body["servers"]["local"]["env"]["API_KEY"] == mcp_settings.SECRET_MASK

    body["servers"]["local"]["args"] = ["trusted-server", "--verbose"]
    response = admin_client.put(
        "/api/v1/settings/mcp/servers/local",
        json=body["servers"]["local"],
    )
    assert response.status_code == 200
    stored = MCPConfig.model_validate_json(config_path.read_text(encoding="utf-8"))
    assert stored.servers["local"].env["API_KEY"] == "sk-secret"
    assert stored.servers["local"].args[-1] == "--verbose"

    captured: dict[str, MCPServerConfig] = {}

    async def fake_probe(config: MCPServerConfig) -> dict[str, object]:
        captured["config"] = config
        return {"ok": True, "tools": [], "error": ""}

    monkeypatch.setattr(mcp_settings, "probe_server", fake_probe)
    test_response = admin_client.post(
        "/api/v1/settings/mcp/servers/local/test",
        json=body["servers"]["local"],
    )
    assert test_response.status_code == 200
    assert captured["config"].env["API_KEY"] == "sk-secret"
