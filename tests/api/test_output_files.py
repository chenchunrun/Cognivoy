"""Request-scoped regression coverage for generated-output downloads (#790)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from cognivoy.services.auth import TokenPayload
from cognivoy.services.path_service import PathService

OutputAppFactory = Callable[[dict[str, TokenPayload | None], bool], tuple[TestClient, Path, Path]]


@pytest.fixture
def output_app(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> OutputAppFactory:
    from cognivoy.api.routers import auth as auth_router
    from cognivoy.api.routers import outputs
    from cognivoy.multi_user import paths as multi_user_paths

    admin_root = tmp_path / "data"
    users_root = admin_root / "users"
    monkeypatch.setattr(multi_user_paths, "ADMIN_WORKSPACE_ROOT", admin_root)
    monkeypatch.setattr(multi_user_paths, "USERS_ROOT", users_root)
    monkeypatch.setattr(multi_user_paths, "_path_services", {})

    def make_app(
        tokens: dict[str, TokenPayload | None], auth_enabled: bool = True
    ) -> tuple[TestClient, Path, Path]:
        monkeypatch.setattr(auth_router, "AUTH_ENABLED", auth_enabled)
        monkeypatch.setattr(auth_router, "POCKETBASE_ENABLED", False)
        monkeypatch.setattr(auth_router, "decode_token", lambda token: tokens.get(token))

        def get_user_info(username: str) -> dict | None:
            for payload in tokens.values():
                if payload is not None and payload.username == username:
                    return {
                        "id": payload.user_id,
                        "role": payload.role,
                        "disabled": False,
                    }
            return None

        monkeypatch.setattr(auth_router, "get_user_info", get_user_info)
        app = FastAPI()
        app.include_router(outputs.router, prefix="/api/outputs")
        return TestClient(app), admin_root, users_root

    return make_app


def _write_output(workspace_root: Path, relative_path: str, contents: bytes) -> Path:
    output = PathService(workspace_root=workspace_root).get_public_outputs_root() / relative_path
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(contents)
    return output


@pytest.mark.parametrize(
    ("headers", "cookie"),
    [
        ({}, True),
        ({"Authorization": "Bearer alice-token"}, False),
    ],
)
def test_authenticated_user_downloads_own_output(output_app, headers, cookie) -> None:
    relative_path = "workspace/chat/chat/session-1/code_runs/report.pdf"
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = output_app({"alice-token": alice})
    _write_output(users_root / "u_alice", relative_path, b"alice report")

    with client:
        if cookie:
            client.cookies.set("dt_token", "alice-token")
        response = client.get(f"/api/outputs/{relative_path}", headers=headers)

    assert response.status_code == 200
    assert response.content == b"alice report"
    assert response.headers["content-type"] == "application/pdf"


def test_same_output_url_is_isolated_between_users(output_app) -> None:
    relative_path = "workspace/chat/chat/session-1/code_runs/report.docx"
    tokens = {
        "alice-token": TokenPayload(username="alice", role="user", user_id="u_alice"),
        "bob-token": TokenPayload(username="bob", role="user", user_id="u_bob"),
        "carol-token": TokenPayload(username="carol", role="user", user_id="u_carol"),
    }
    client, _admin_root, users_root = output_app(tokens)
    _write_output(users_root / "u_alice", relative_path, b"alice document")
    _write_output(users_root / "u_bob", relative_path, b"bob document")

    with client:
        client.cookies.set("dt_token", "alice-token")
        alice = client.get(f"/api/outputs/{relative_path}")
        client.cookies.set("dt_token", "bob-token")
        bob = client.get(f"/api/outputs/{relative_path}")
        client.cookies.set("dt_token", "carol-token")
        carol = client.get(f"/api/outputs/{relative_path}")

    assert alice.content == b"alice document"
    assert bob.content == b"bob document"
    assert carol.status_code == 404
    assert "u_alice" not in carol.text
    assert "u_bob" not in carol.text


@pytest.mark.parametrize("token", [None, "malformed-token", "expired-token"])
def test_invalid_auth_never_falls_back_to_admin_output(output_app, token) -> None:
    relative_path = "workspace/chat/chat/session-1/code_runs/admin.pdf"
    client, admin_root, _users_root = output_app({"malformed-token": None, "expired-token": None})
    _write_output(admin_root, relative_path, b"admin-only output")
    headers = {} if token is None else {"Authorization": f"Bearer {token}"}

    with client:
        response = client.get(f"/api/outputs/{relative_path}", headers=headers)

    assert response.status_code == 401
    assert "admin-only output" not in response.text
    assert str(admin_root) not in response.text


def test_auth_disabled_reads_local_admin_output(output_app) -> None:
    relative_path = "workspace/chat/chat/session-1/code_runs/local.pdf"
    client, admin_root, _users_root = output_app({}, auth_enabled=False)
    _write_output(admin_root, relative_path, b"local output")

    with client:
        response = client.get(f"/api/outputs/{relative_path}")

    assert response.status_code == 200
    assert response.content == b"local output"


def test_active_output_is_forced_to_download(output_app) -> None:
    relative_path = "workspace/chat/chat/session-1/code_runs/diagram.svg"
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = output_app({"alice-token": alice})
    _write_output(users_root / "u_alice", relative_path, b"<svg onload='alert(1)'></svg>")

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.get(f"/api/outputs/{relative_path}")

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/octet-stream"
    assert response.headers["content-disposition"].startswith("attachment;")
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]


def test_private_suffix_is_rejected(output_app) -> None:
    relative_path = "workspace/chat/chat/session-1/code_runs/private.json"
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = output_app({"alice-token": alice})
    _write_output(users_root / "u_alice", relative_path, b'{"secret": true}')

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.get(f"/api/outputs/{relative_path}")

    assert response.status_code == 404
    assert "secret" not in response.text


def test_math_animator_caption_is_public_but_other_metadata_is_not(output_app) -> None:
    base = "workspace/chat/math_animator/turn-1/meta"
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = output_app({"alice-token": alice})
    _write_output(users_root / "u_alice", f"{base}/captions.vtt", b"WEBVTT\n")
    _write_output(users_root / "u_alice", f"{base}/debug.txt", b"private metadata")

    with client:
        client.cookies.set("dt_token", "alice-token")
        caption = client.get(f"/api/outputs/{base}/captions.vtt")
        debug = client.get(f"/api/outputs/{base}/debug.txt")

    assert caption.status_code == 200
    assert caption.content == b"WEBVTT\n"
    assert debug.status_code == 404
    assert "private metadata" not in debug.text


def test_path_traversal_is_rejected(output_app) -> None:
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = output_app({"alice-token": alice})
    _write_output(users_root / "u_alice", "secret.pdf", b"outside public allowlist")

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.get("/api/outputs/%2E%2E/secret.pdf")

    assert response.status_code == 404
    assert "outside public allowlist" not in response.text


def test_symlink_outside_user_root_is_rejected(output_app, tmp_path: Path) -> None:
    relative_path = "workspace/chat/chat/session-1/code_runs/escape.pdf"
    alice = TokenPayload(username="alice", role="user", user_id="u_alice")
    client, _admin_root, users_root = output_app({"alice-token": alice})
    external = tmp_path / "external.pdf"
    external.write_bytes(b"other user's data")
    link = _write_output(users_root / "u_alice", relative_path, b"placeholder")
    link.unlink()
    link.symlink_to(external)

    with client:
        client.cookies.set("dt_token", "alice-token")
        response = client.get(f"/api/outputs/{relative_path}")

    assert response.status_code == 404
    assert "other user's data" not in response.text


def test_absolute_parent_and_symlink_escapes_are_rejected(tmp_path: Path) -> None:
    workspace_root = tmp_path / "data" / "users" / "u_alice"
    service = PathService(workspace_root=workspace_root)
    public_root = service.get_public_outputs_root()
    external = workspace_root / "external.pdf"
    external.parent.mkdir(parents=True, exist_ok=True)
    external.write_bytes(b"outside the public root")

    absolute_parent_escape = public_root / ".." / "external.pdf"
    assert absolute_parent_escape.is_absolute()
    assert service.resolve_public_output_path(absolute_parent_escape) is None

    link = public_root / "workspace" / "chat" / "chat" / "session-1" / "exec" / "link.pdf"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(external)
    assert service.resolve_public_output_path(link.absolute()) is None
