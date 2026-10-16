"""Login brute-force protection at the real FastAPI route boundary."""

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from cognivoy.api.routers import auth as auth_router
from cognivoy.services.coordination import SharedCoordinationStore
from cognivoy.services.login_rate_limit import (
    FileLoginRateLimiter,
    SharedLoginRateLimiter,
)


@pytest.fixture
def client(monkeypatch):
    auth_router._login_rate_limiter.reset()
    monkeypatch.setattr(auth_router, "AUTH_ENABLED", True)
    monkeypatch.setattr(auth_router, "POCKETBASE_ENABLED", False)
    monkeypatch.setattr(auth_router, "authenticate", lambda _username, _password: None)
    monkeypatch.setattr(auth_router, "create_token", lambda *_args: "signed-token")
    app = FastAPI()
    app.include_router(auth_router.router, prefix="/api/v1/auth")
    yield TestClient(app)
    auth_router._login_rate_limiter.reset()


def _login(client: TestClient, username: str, *, ip: str = "203.0.113.10"):
    return client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": "wrong-password"},
        headers={"x-forwarded-for": ip},
    )


def test_sixth_failed_identity_attempt_is_rate_limited(client):
    for _ in range(5):
        assert _login(client, "alice").status_code == 401

    blocked = _login(client, "alice")
    assert blocked.status_code == 429
    assert blocked.json()["detail"] == "Too many login attempts. Try again later."
    assert int(blocked.headers["retry-after"]) > 0

    # A different identity on the same address remains usable until the wider
    # IP bucket reaches its own, deliberately higher limit.
    assert _login(client, "bob").status_code == 401


def test_success_clears_the_identity_failure_bucket(client, monkeypatch):
    for _ in range(4):
        assert _login(client, "alice").status_code == 401

    monkeypatch.setattr(
        auth_router,
        "authenticate",
        lambda _username, _password: SimpleNamespace(
            username="alice", role="user", user_id="u_alice"
        ),
    )
    success = client.post(
        "/api/v1/auth/login",
        json={"username": "alice", "password": "correct-password"},
        headers={"x-forwarded-for": "203.0.113.10"},
    )
    assert success.status_code == 200

    monkeypatch.setattr(auth_router, "authenticate", lambda _username, _password: None)
    for _ in range(5):
        assert _login(client, "alice").status_code == 401
    assert _login(client, "alice").status_code == 429


def test_wider_ip_bucket_limits_distributed_username_guessing(client):
    for index in range(auth_router._LOGIN_IP_FAILURE_LIMIT):
        response = _login(client, f"user-{index}", ip="198.51.100.25")
        assert response.status_code == 401

    blocked = _login(client, "one-more-user", ip="198.51.100.25")
    assert blocked.status_code == 429


def test_public_peer_does_not_trust_spoofed_forwarded_address(monkeypatch):
    class Client:
        host = "198.51.100.8"

    class Request:
        client = Client()
        headers = {"x-forwarded-for": "203.0.113.99"}

    assert auth_router._login_client_ip(Request()) == "198.51.100.8"


def test_file_limiter_shares_failures_between_workers(tmp_path):
    first = FileLoginRateLimiter(tmp_path / "login.json", identity_limit=2, ip_limit=10)
    second = FileLoginRateLimiter(tmp_path / "login.json", identity_limit=2, ip_limit=10)

    first.record_failure("203.0.113.4", "alice")
    second.record_failure("203.0.113.4", "alice")

    assert first.retry_after("203.0.113.4", "alice") > 0
    assert second.retry_after("203.0.113.4", "alice") > 0
    second.record_success("203.0.113.4", "alice")
    assert first.retry_after("203.0.113.4", "alice") == 0


def test_sqlite_limiter_shares_failures_across_instances_and_hosts(tmp_path):
    first_store = SharedCoordinationStore(tmp_path / "coordination.sqlite3")
    second_store = SharedCoordinationStore(tmp_path / "coordination.sqlite3")
    first = SharedLoginRateLimiter(
        store=first_store, identity_limit=2, ip_limit=10, clock=lambda: 100.0
    )
    second = SharedLoginRateLimiter(
        store=second_store, identity_limit=2, ip_limit=10, clock=lambda: 101.0
    )

    first.record_failure("203.0.113.4", "Alice")
    second.record_failure("203.0.113.4", "alice")

    assert first.retry_after("203.0.113.4", "alice") == 300
    assert second.retry_after("203.0.113.4", "ALICE") == 299
    second.record_success("203.0.113.4", "alice")
    assert first.retry_after("203.0.113.4", "alice") == 0
