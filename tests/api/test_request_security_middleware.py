from __future__ import annotations

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from cognivoy.api.security_middleware import RequestSecurityMiddleware


async def _ok(_request) -> PlainTextResponse:  # noqa: ANN001
    return PlainTextResponse("ok")


app = RequestSecurityMiddleware(Starlette(routes=[Route("/", _ok, methods=["GET", "POST"])]))


def test_rejects_host_header_path_confusion() -> None:
    response = TestClient(app).get("/", headers={"host": "trusted.example/api/v1/auth/status"})
    assert response.status_code == 400


def test_rejects_oversized_urlencoded_form_before_parsing() -> None:
    response = TestClient(app).post(
        "/",
        content=b"x=" + b"a" * (1024 * 1024),
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    assert response.status_code == 413


@pytest.mark.asyncio
async def test_rejects_chunked_urlencoded_body_that_crosses_limit() -> None:
    messages = iter(
        [
            {"type": "http.request", "body": b"a" * 700_000, "more_body": True},
            {"type": "http.request", "body": b"b" * 700_000, "more_body": False},
        ]
    )
    sent: list[dict] = []

    async def receive() -> dict:
        return next(messages)

    async def send(message: dict) -> None:
        sent.append(message)

    async def consume(_scope, receive, _send) -> None:  # noqa: ANN001
        while True:
            message = await receive()
            if not message.get("more_body"):
                break

    middleware = RequestSecurityMiddleware(consume)
    await middleware(
        {
            "type": "http",
            "path": "/",
            "headers": [
                (b"host", b"localhost"),
                (b"content-type", b"application/x-www-form-urlencoded"),
            ],
        },
        receive,
        send,
    )

    assert sent[0]["status"] == 413
