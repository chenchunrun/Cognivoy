"""Origin-bound CSRF protection for cookie-authenticated API writes."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from urllib.parse import urlsplit
from uuid import uuid4

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
_COOKIE_NAME = "dt_token"
_HEADER_NAME = "x-cognivoy-csrf"
_HEADER_VALUE = "1"


def _canonical_origin(value: str) -> str | None:
    """Return a strict scheme/authority origin, rejecting paths and credentials."""
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return None
    host = parsed.hostname
    if not host:
        return None
    try:
        port = parsed.port
    except ValueError:
        return None
    default_port = 80 if parsed.scheme == "http" else 443
    authority = host.lower() if port in {None, default_port} else f"{host.lower()}:{port}"
    return f"{parsed.scheme}://{authority}"


def _has_cookie(cookie_header: str, name: str) -> bool:
    for item in cookie_header.split(";"):
        key, separator, _value = item.strip().partition("=")
        if separator and key == name:
            return True
    return False


class CsrfProtectionMiddleware:
    """Require an allowed Origin and explicit header for cookie-auth writes.

    Bearer-token clients are not vulnerable to ambient-cookie CSRF and remain
    usable from CLI/SDK callers. Unauthenticated writes such as login and
    registration are also left to their endpoint-specific abuse controls.
    """

    def __init__(
        self,
        app: ASGIApp,
        *,
        auth_enabled: Callable[[], bool],
        allowed_origins: Iterable[str],
    ) -> None:
        self.app = app
        self.auth_enabled = auth_enabled
        self.allowed_origins = frozenset(
            origin
            for value in allowed_origins
            if (origin := _canonical_origin(str(value))) is not None
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or str(scope.get("method", "GET")).upper() in _SAFE_METHODS:
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        authorization = headers.get("authorization", "")
        has_bearer = authorization.lstrip().lower().startswith("bearer ")
        has_auth_cookie = _has_cookie(headers.get("cookie", ""), _COOKIE_NAME)
        if not self.auth_enabled() or not has_auth_cookie or has_bearer:
            await self.app(scope, receive, send)
            return

        origin = _canonical_origin(headers.get("origin", ""))
        valid = origin in self.allowed_origins and headers.get(_HEADER_NAME) == _HEADER_VALUE
        if valid:
            await self.app(scope, receive, send)
            return

        trace_id = uuid4().hex
        message = "Request origin could not be verified."
        response = JSONResponse(
            status_code=403,
            content={
                "code": "csrf_validation_failed",
                "message": message,
                "details": {},
                "retryable": False,
                "trace_id": trace_id,
                "detail": {"code": "csrf_validation_failed", "message": message},
            },
            headers={"X-Trace-ID": trace_id},
        )
        await response(scope, receive, send)


__all__ = ["CsrfProtectionMiddleware"]
