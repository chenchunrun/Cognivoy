from __future__ import annotations

import asyncio
import importlib
import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from cognivoy.api.routers import plugins_api
from cognivoy.services.config.network_policy import OutboundNetworkDisabledError
from cognivoy.services.search.resilience import SearchProviderError
from cognivoy.tools.builtin import WebSearchTool


@pytest.mark.parametrize(
    ("failure", "category", "attempts"),
    [
        (SearchProviderError("duckduckgo", "no_results", 2), "no_results", 2),
        (SearchProviderError("duckduckgo", "connection", 2), "connection", 2),
        (SearchProviderError("tavily", "authentication", 1), "authentication", 1),
        (OutboundNetworkDisabledError("secret-policy-detail"), "network_disabled", 0),
        (ValueError("secret-config-detail"), "configuration", 0),
    ],
)
def test_worker_serializes_known_search_failures_without_secrets(
    monkeypatch, failure, category, attempts
):
    module = importlib.import_module("cognivoy.tools.web_search")
    calls = []

    def fail_service(*args, **kwargs):
        calls.append((args, kwargs))
        raise failure from RuntimeError("secret-upstream-body")

    monkeypatch.setattr(module, "_service_web_search", fail_service)
    result = module.web_search("public query")

    assert result["success"] is False
    assert result["error_type"] == category
    assert result["search_attempts"] == attempts
    assert result["citations"] == result["search_results"] == []
    assert "secret" not in json.dumps(result)
    assert len(calls) == 1  # Serializing a failure must not replay the provider.


@pytest.mark.asyncio
async def test_wrapper_preserves_failure_metadata_and_removes_sources():
    async def runner(**kwargs):
        return {
            "success": False,
            "error": True,
            "error_type": "no_results",
            "answer": "No usable results",
            "citations": [{"url": "https://example.com/not-evidence"}],
        }

    result = await WebSearchTool(isolated_runner=runner).execute(query="public query")

    assert result.success is False
    assert result.metadata["error_type"] == "no_results"
    assert result.sources == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("failure", "category"),
    [
        (TimeoutError("secret-timeout-detail"), "timeout"),
        (RuntimeError("secret-crash"), "worker_error"),
    ],
)
async def test_wrapper_classifies_hard_worker_failures_without_tracebacks(failure, category):
    async def runner(**kwargs):
        raise failure

    result = await WebSearchTool(isolated_runner=runner).execute(query="public query")

    assert result.success is False
    assert result.metadata["error_type"] == category
    assert result.sources == []
    assert "secret" not in str(result)


@pytest.mark.asyncio
async def test_wrapper_does_not_swallow_cancellation():
    async def runner(**kwargs):
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await WebSearchTool(isolated_runner=runner).execute(query="public query")


def test_playground_preserves_no_results_contract_instead_of_http_500(monkeypatch):
    module = importlib.import_module("cognivoy.tools.web_search")

    def fail_service(*args, **kwargs):
        raise SearchProviderError("duckduckgo", "no_results", 2)

    monkeypatch.setattr(module, "_service_web_search", fail_service)

    async def runner(**kwargs):
        return module.web_search(**kwargs["kwargs"])

    tool = WebSearchTool(isolated_runner=runner)

    class Registry:
        def get(self, name):
            return tool if name == "web_search" else None

        async def execute(self, name, **params):
            return await tool.execute(**params)

    monkeypatch.setattr(plugins_api, "get_tool_registry", lambda: Registry())
    monkeypatch.setattr(plugins_api, "_playground_execution_enabled", lambda: True)
    app = FastAPI()
    app.include_router(plugins_api.router, prefix="/api/v1/plugins")

    with TestClient(app) as client:
        response = client.post(
            "/api/v1/plugins/tools/web_search/execute", json={"params": {"query": "public query"}}
        )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["success"] is False
    assert response.json()["metadata"]["error_type"] == "no_results"
    assert response.json()["metadata"]["search_attempts"] == 2
    assert response.json()["sources"] == []
