"""Direct DeepSeek Flash JSON mode, through the real SDK with an offline transport."""

from __future__ import annotations

import json
from typing import Any

import httpx
from openai import AsyncOpenAI
import pytest

from cognivoy.services.llm import capabilities, factory
from cognivoy.services.llm.config import LLMConfig
from cognivoy.services.llm.provider_core.base import LLMProvider
from cognivoy.services.llm.provider_core.openai_compat_provider import OpenAICompatProvider
from cognivoy.services.provider_registry import find_by_name


@pytest.fixture(autouse=True)
def isolated_runtime_overrides(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(capabilities, "_RUNTIME_DISABLED_RESPONSE_FORMAT", set())


@pytest.mark.parametrize(
    "binding,model", [("deepseek", "deepseek-flash"), ("DeepSeek", "DeepSeek-Flash")]
)
def test_verified_exact_pair_supports_json_mode(binding: str, model: str) -> None:
    assert capabilities.supports_response_format(binding, model)
    assert capabilities.get_capability(binding, "supports_response_format", model) is True
    assert capabilities.supports_vision(binding, model) is False


@pytest.mark.parametrize(
    "binding,model",
    [
        ("deepseek", "deepseek-reasoner"),
        ("deepseek", "deepseek-chat"),
        ("deepseek", "deepseek-flash-preview"),
        ("deepseek", "deepseek-v4-flash"),
        ("deepseek", None),
        ("custom", "deepseek-flash"),
        ("openai", "deepseek-flash"),
        ("siliconflow", "deepseek-flash"),
        ("openrouter", "deepseek-flash"),
    ],
)
def test_unverified_pairs_stay_disabled(binding: str, model: str | None) -> None:
    assert capabilities.supports_response_format(binding, model) is False


def test_runtime_rejection_overrides_verified_pair() -> None:
    capabilities.disable_response_format_at_runtime("DeepSeek", "DeepSeek-Flash")
    assert capabilities.supports_response_format("deepseek", "deepseek-flash") is False


def _install_provider(
    monkeypatch: pytest.MonkeyPatch,
    requests: list[dict[str, Any]],
    *,
    reject_first: bool = False,
) -> OpenAICompatProvider:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "deepseek-json-mode.invalid"
        assert request.url.path == "/v1/chat/completions"
        requests.append(json.loads(request.content))
        if reject_first and len(requests) == 1:
            return httpx.Response(
                400,
                json={
                    "error": {
                        "message": "response_format json_object is not supported",
                        "type": "invalid_request_error",
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "id": "offline-json-mode-test",
                "object": "chat.completion",
                "created": 0,
                "model": "deepseek-flash",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": '{"render_type":"svg"}'},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30},
            },
        )

    # Construct the real provider without its environment-mutating setup. Every
    # SDK request is handled by MockTransport; no endpoint or credential is real.
    provider = OpenAICompatProvider.__new__(OpenAICompatProvider)
    LLMProvider.__init__(
        provider, api_key="offline-test-key", api_base="https://deepseek-json-mode.invalid/v1"
    )
    provider.default_model = "deepseek-flash"
    provider.extra_headers = {}
    provider._spec = find_by_name("deepseek")
    provider._provider_name = "deepseek"
    provider._effective_base = "https://deepseek-json-mode.invalid/v1"
    provider._client = AsyncOpenAI(
        api_key="offline-test-key",
        base_url=provider._effective_base,
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    cfg = LLMConfig(
        model="deepseek-flash",
        api_key="offline-test-key",
        base_url=provider._effective_base,
        effective_url=provider._effective_base,
        binding="deepseek",
        provider_name="deepseek",
    )
    monkeypatch.setattr(factory, "get_llm_config", lambda: cfg)
    monkeypatch.setattr(factory, "get_runtime_provider", lambda _config: provider)
    return provider


@pytest.mark.asyncio
async def test_factory_and_real_sdk_preserve_json_object(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[dict[str, Any]] = []
    provider = _install_provider(monkeypatch, requests)
    try:
        result = await factory.complete(
            "Return JSON with render_type=svg.",
            response_format={"type": "json_object"},
            max_retries=0,
        )
    finally:
        await provider.aclose()
    assert json.loads(result) == {"render_type": "svg"}
    assert len(requests) == 1
    assert requests[0]["model"] == "deepseek-flash"
    assert requests[0]["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_compatibility_400_retries_without_format_and_remembers_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[dict[str, Any]] = []
    provider = _install_provider(monkeypatch, requests, reject_first=True)
    try:
        for _ in range(2):
            result = await factory.complete(
                "Return JSON with render_type=svg.",
                response_format={"type": "json_object"},
                max_retries=0,
            )
            assert json.loads(result) == {"render_type": "svg"}
    finally:
        await provider.aclose()
    assert len(requests) == 3
    assert requests[0]["response_format"] == {"type": "json_object"}
    assert "response_format" not in requests[1]
    assert "response_format" not in requests[2]
    assert capabilities.is_response_format_disabled_at_runtime("deepseek", "deepseek-flash")
