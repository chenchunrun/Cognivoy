from fastapi import FastAPI
from fastapi.testclient import TestClient

from cognivoy.api.csrf import CsrfProtectionMiddleware


def _client() -> TestClient:
    app = FastAPI()
    app.add_middleware(
        CsrfProtectionMiddleware,
        auth_enabled=lambda: True,
        allowed_origins=("https://app.example",),
    )

    @app.api_route("/resource", methods=["GET", "POST", "DELETE"])
    async def resource():
        return {"ok": True}

    return TestClient(app)


def test_cookie_authenticated_write_requires_origin_and_custom_header() -> None:
    client = _client()
    client.cookies.set("dt_token", "signed")

    missing = client.post("/resource")
    assert missing.status_code == 403
    assert missing.json()["code"] == "csrf_validation_failed"

    foreign = client.post(
        "/resource",
        headers={"origin": "https://evil.example", "x-cognivoy-csrf": "1"},
    )
    assert foreign.status_code == 403

    accepted = client.post(
        "/resource",
        headers={"origin": "https://app.example", "x-cognivoy-csrf": "1"},
    )
    assert accepted.status_code == 200


def test_safe_bearer_and_unauthenticated_requests_are_not_blocked() -> None:
    client = _client()
    client.cookies.set("dt_token", "signed")
    assert client.get("/resource").status_code == 200
    assert (
        client.delete("/resource", headers={"authorization": "Bearer api-client"}).status_code
        == 200
    )

    client.cookies.clear()
    assert client.post("/resource").status_code == 200
