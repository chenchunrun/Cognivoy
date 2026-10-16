from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.testclient import TestClient

from cognivoy.api.errors import (
    install_error_handlers,
    internal_error_payload,
    internal_http_error,
)


def _client() -> TestClient:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/missing")
    async def missing():
        raise HTTPException(status_code=404, detail="missing resource")

    @app.get("/conflict")
    async def conflict():
        raise HTTPException(
            status_code=409,
            detail={
                "code": "revision_conflict",
                "message": "The record changed on the server.",
                "current_revision": 3,
            },
        )

    @app.get("/legacy-500")
    async def legacy_500():
        raise HTTPException(status_code=500, detail="password=super-secret")

    @app.get("/crash")
    async def crash():
        raise RuntimeError("token=server-secret")

    @app.get("/validated")
    async def validated(count: int = Query(gt=0)):
        return {"count": count}

    return TestClient(app, raise_server_exceptions=False)


def _assert_contract(payload: dict) -> None:
    assert set(("code", "message", "details", "retryable", "trace_id")) <= set(payload)
    assert isinstance(payload["details"], dict)
    assert isinstance(payload["retryable"], bool)
    assert isinstance(payload["trace_id"], str)
    assert payload["trace_id"]


def test_http_errors_use_stable_envelope_and_preserve_legacy_detail() -> None:
    client = _client()

    response = client.get("/missing")

    assert response.status_code == 404
    payload = response.json()
    _assert_contract(payload)
    assert payload["code"] == "not_found"
    assert payload["message"] == "missing resource"
    assert payload["retryable"] is False
    assert payload["detail"] == "missing resource"


def test_structured_http_error_promotes_code_and_keeps_compatibility() -> None:
    client = _client()

    response = client.get("/conflict")

    assert response.status_code == 409
    payload = response.json()
    _assert_contract(payload)
    assert payload["code"] == "revision_conflict"
    assert payload["message"] == "The record changed on the server."
    assert payload["details"]["current_revision"] == 3
    assert payload["detail"]["current_revision"] == 3


def test_legacy_500_is_sanitized_and_retryable() -> None:
    client = _client()

    response = client.get("/legacy-500")

    assert response.status_code == 500
    payload = response.json()
    _assert_contract(payload)
    assert payload["code"] == "internal_error"
    assert payload["retryable"] is True
    assert "super-secret" not in response.text
    assert payload["detail"] == payload["message"]


def test_uncaught_exception_is_sanitized() -> None:
    client = _client()

    response = client.get("/crash")

    assert response.status_code == 500
    payload = response.json()
    _assert_contract(payload)
    assert payload["code"] == "internal_error"
    assert payload["retryable"] is True
    assert "server-secret" not in response.text


def test_caught_internal_errors_share_a_non_leaking_trace_id(caplog) -> None:
    app = FastAPI()
    install_error_handlers(app)

    @app.get("/caught")
    async def caught():
        try:
            raise RuntimeError("provider secret sk-private and /private/path")
        except RuntimeError as exc:
            raise internal_http_error(exc, operation="test.caught") from exc

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/caught")

    assert response.status_code == 500
    payload = response.json()
    assert payload["code"] == "internal_error"
    assert payload["message"] == "An internal server error occurred."
    assert payload["details"] == {}
    assert payload["retryable"] is True
    assert payload["trace_id"] == response.headers["X-Trace-ID"]
    assert "sk-private" not in response.text
    assert payload["trace_id"] in caplog.text


def test_transport_neutral_internal_error_payload_is_safe_and_traceable(caplog) -> None:
    payload = internal_error_payload(
        RuntimeError("token=private-key at /private/provider/path"),
        operation="test.websocket",
        message="The operation failed. Please retry.",
    )

    _assert_contract(payload)
    assert payload["code"] == "internal_error"
    assert payload["message"] == "The operation failed. Please retry."
    assert payload["details"] == {}
    assert payload["retryable"] is True
    assert "private-key" not in str(payload)
    assert payload["trace_id"] in caplog.text


def test_router_sources_do_not_construct_raw_http_500_or_websocket_exception_messages() -> None:
    routers = Path(__file__).parents[2] / "cognivoy" / "api" / "routers"
    violations: list[str] = []
    for source_file in routers.glob("*.py"):
        source = source_file.read_text(encoding="utf-8")
        if "HTTPException(status_code=500" in source or "HTTPException(500" in source:
            violations.append(f"{source_file.name}: raw HTTPException 500")
        if '"message": str(exc)' in source or '"message": str(e)' in source:
            # Domain validation errors can safely expose their curated message.
            if source_file.name not in {"memory.py", "partners.py", "space_mcp.py"}:
                violations.append(f"{source_file.name}: raw exception message")

    assert violations == []


def test_framework_404_and_validation_errors_use_the_same_contract() -> None:
    client = _client()

    missing = client.get("/route-that-does-not-exist")
    invalid = client.get("/validated?count=0")

    assert missing.status_code == 404
    _assert_contract(missing.json())
    assert missing.json()["code"] == "not_found"
    assert invalid.status_code == 422
    _assert_contract(invalid.json())
    assert invalid.json()["code"] == "validation_error"
    assert invalid.json()["details"]["errors"]
