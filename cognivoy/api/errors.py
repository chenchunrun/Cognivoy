"""Stable, non-leaking HTTP error responses for every API entry point."""

from __future__ import annotations

from http import HTTPStatus
import logging
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from cognivoy.services.session.errors import SessionStorageUnavailableError

logger = logging.getLogger(__name__)

_INTERNAL_MESSAGE = "An internal server error occurred."
_STATUS_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    408: "request_timeout",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "validation_error",
    429: "rate_limited",
    500: "internal_error",
    501: "not_implemented",
    502: "bad_gateway",
    503: "service_unavailable",
    504: "gateway_timeout",
}


def _default_code(status_code: int) -> str:
    if status_code in _STATUS_CODES:
        return _STATUS_CODES[status_code]
    try:
        return HTTPStatus(status_code).phrase.lower().replace(" ", "_")
    except ValueError:
        return "http_error"


def _retryable(status_code: int) -> bool:
    return status_code in {408, 425, 429} or status_code >= 500


def internal_error_payload(
    exc: Exception,
    *,
    operation: str,
    message: str = _INTERNAL_MESSAGE,
    code: str = "internal_error",
    retryable: bool = True,
) -> dict[str, Any]:
    """Log an unexpected failure and return a transport-neutral safe envelope."""

    trace_id = uuid4().hex
    logger.error(
        "Caught API failure trace_id=%s operation=%s",
        trace_id,
        operation,
        exc_info=(type(exc), exc, exc.__traceback__),
    )
    return {
        "code": code,
        "message": message,
        "details": {},
        "retryable": retryable,
        "trace_id": trace_id,
    }


def internal_http_error(
    exc: Exception,
    *,
    operation: str,
    message: str = _INTERNAL_MESSAGE,
) -> HTTPException:
    """Create a traceable, non-leaking HTTP 500 for caught exceptions.

    Routers should use this instead of ``detail=str(exc)``. The trace id is
    shared by the server log, response header, and global error envelope while
    provider payloads, local paths, and credentials remain server-side.
    """

    payload = internal_error_payload(exc, operation=operation, message=message)
    return HTTPException(
        status_code=500,
        detail=message,
        headers={"X-Trace-ID": str(payload["trace_id"])},
    )


def _response(
    *,
    status_code: int,
    code: str,
    message: str,
    details: dict[str, Any] | None,
    retryable: bool,
    trace_id: str,
    legacy_detail: Any,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    content = {
        "code": code,
        "message": message,
        "details": details or {},
        "retryable": retryable,
        "trace_id": trace_id,
        # Transitional compatibility for callers written against FastAPI's
        # default {"detail": ...} response. New clients use the fields above.
        "detail": legacy_detail,
    }
    response_headers = dict(headers or {})
    response_headers["X-Trace-ID"] = trace_id
    return JSONResponse(
        status_code=status_code,
        content=jsonable_encoder(content),
        headers=response_headers,
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    del request
    trace_id = (exc.headers or {}).get("X-Trace-ID") or uuid4().hex
    status_code = exc.status_code

    if status_code >= 500:
        logger.error(
            "HTTP failure trace_id=%s status=%s detail=%r",
            trace_id,
            status_code,
            exc.detail,
        )
        return _response(
            status_code=status_code,
            code=_default_code(status_code),
            message=_INTERNAL_MESSAGE,
            details={},
            retryable=True,
            trace_id=trace_id,
            legacy_detail=_INTERNAL_MESSAGE,
            headers=exc.headers,
        )

    raw_detail = exc.detail
    if isinstance(raw_detail, dict):
        code = str(raw_detail.get("code") or _default_code(status_code))
        message = str(raw_detail.get("message") or raw_detail.get("detail") or code)
        details = {
            key: value
            for key, value in raw_detail.items()
            if key not in {"code", "message", "retryable", "trace_id"}
        }
        retryable = bool(raw_detail.get("retryable", _retryable(status_code)))
    else:
        code = _default_code(status_code)
        message = str(raw_detail)
        details = {}
        retryable = _retryable(status_code)

    return _response(
        status_code=status_code,
        code=code,
        message=message,
        details=details,
        retryable=retryable,
        trace_id=trace_id,
        legacy_detail=raw_detail,
        headers=exc.headers,
    )


async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    del request
    trace_id = uuid4().hex
    errors = jsonable_encoder(exc.errors())
    return _response(
        status_code=422,
        code="validation_error",
        message="Request validation failed.",
        details={"errors": errors},
        retryable=False,
        trace_id=trace_id,
        legacy_detail=errors,
    )


async def unexpected_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    del request
    trace_id = uuid4().hex
    logger.exception("Unhandled API failure trace_id=%s", trace_id, exc_info=exc)
    return _response(
        status_code=500,
        code="internal_error",
        message=_INTERNAL_MESSAGE,
        details={},
        retryable=True,
        trace_id=trace_id,
        legacy_detail=_INTERNAL_MESSAGE,
    )


async def session_storage_exception_handler(
    request: Request, exc: SessionStorageUnavailableError
) -> JSONResponse:
    del request
    trace_id = uuid4().hex
    logger.exception("Session storage unavailable trace_id=%s", trace_id, exc_info=exc)
    return _response(
        status_code=503,
        code="session_storage_unavailable",
        message="Conversation storage is temporarily unavailable. Please retry.",
        details={"operation": exc.operation},
        retryable=True,
        trace_id=trace_id,
        legacy_detail="Conversation storage is temporarily unavailable. Please retry.",
    )


def install_error_handlers(app: FastAPI) -> None:
    """Install the API-wide error contract on a FastAPI application."""

    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(SessionStorageUnavailableError, session_storage_exception_handler)
    app.add_exception_handler(Exception, unexpected_exception_handler)
