"""ASGI-level request validation for framework-independent security bounds."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
import re
from typing import Any

_MAX_HOST_BYTES = 255
_MAX_URLENCODED_BODY = 1024 * 1024
_SAFE_HOST = re.compile(rb"^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::[0-9]{1,5})?$")


class _BodyTooLarge(Exception):
    pass


class RequestSecurityMiddleware:
    """Reject ambiguous authorities/paths and bound URL-encoded form bodies."""

    def __init__(self, app: Callable[..., Awaitable[None]]) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path")
        headers = list(scope.get("headers") or [])
        hosts = [value for name, value in headers if name.lower() == b"host"]
        if not isinstance(path, str) or not path.startswith("/"):
            await self._reject(send, 400, b'{"error":"invalid request path"}')
            return
        if len(hosts) != 1 or len(hosts[0]) > _MAX_HOST_BYTES or not _SAFE_HOST.fullmatch(hosts[0]):
            await self._reject(send, 400, b'{"error":"invalid host header"}')
            return

        content_type = next(
            (value.lower() for name, value in headers if name.lower() == b"content-type"),
            b"",
        )
        if not content_type.startswith(b"application/x-www-form-urlencoded"):
            await self.app(scope, receive, send)
            return

        content_lengths = [value for name, value in headers if name.lower() == b"content-length"]
        if len(content_lengths) > 1:
            await self._reject(send, 400, b'{"error":"invalid content length"}')
            return
        content_length = content_lengths[0] if content_lengths else None
        try:
            if content_length is not None:
                if not content_length.isdigit():
                    raise ValueError
                if int(content_length) > _MAX_URLENCODED_BODY:
                    await self._reject(send, 413, b'{"error":"request body too large"}')
                    return
        except ValueError:
            await self._reject(send, 400, b'{"error":"invalid content length"}')
            return

        received = 0

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message.get("type") == "http.request":
                received += len(message.get("body") or b"")
                if received > _MAX_URLENCODED_BODY:
                    raise _BodyTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except _BodyTooLarge:
            await self._reject(send, 413, b'{"error":"request body too large"}')

    @staticmethod
    async def _reject(send, status: int, body: bytes) -> None:
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


__all__ = ["RequestSecurityMiddleware"]
