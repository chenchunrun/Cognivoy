"""Tests for TutorBot-style web_search runtime behavior."""

from __future__ import annotations

import pytest

from cognivoy.services.config.network_policy import (
    OutboundNetworkDisabledError,
    OutboundNetworkPolicy,
)
from cognivoy.services.config.provider_runtime import ResolvedSearchConfig
from cognivoy.services.search import web_search
from cognivoy.services.search.types import WebSearchResponse


class _FakeProvider:
    def __init__(self, name: str, supports_answer: bool = False):
        self.name = name
        self.supports_answer = supports_answer

    def search(self, query: str, **kwargs):
        return WebSearchResponse(
            query=query,
            answer="",
            provider=self.name,
            citations=[],
            search_results=[],
        )


def test_web_search_stops_before_provider_when_outbound_network_is_disabled(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "cognivoy.services.search.require_outbound_network",
        lambda _feature: (_ for _ in ()).throw(OutboundNetworkDisabledError("disabled")),
    )
    called = False

    def _provider(*_args, **_kwargs):
        nonlocal called
        called = True
        return _FakeProvider("duckduckgo")

    monkeypatch.setattr("cognivoy.services.search.get_provider", _provider)
    with pytest.raises(OutboundNetworkDisabledError, match="disabled"):
        web_search("hello")
    assert called is False


def test_web_search_applies_global_timeout_and_proxy(monkeypatch) -> None:
    captured: dict[str, object] = {}

    monkeypatch.setattr(
        "cognivoy.services.search.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(
            enabled=True,
            timeout_seconds=47,
            proxy="http://global-proxy.example:8080",
        ),
    )
    monkeypatch.setattr(
        "cognivoy.services.search._get_web_search_config",
        lambda: {"enabled": True},
    )
    monkeypatch.setattr(
        "cognivoy.services.search.resolve_search_runtime_config",
        lambda: ResolvedSearchConfig(
            provider="duckduckgo",
            requested_provider="duckduckgo",
            max_results=3,
            proxy="http://provider-proxy.example:7890",
        ),
    )

    def _fake_get_provider(name: str, **kwargs):
        captured.update(kwargs)
        return _FakeProvider(name)

    monkeypatch.setattr("cognivoy.services.search.get_provider", _fake_get_provider)
    web_search("hello", timeout=999, proxy="http://caller-proxy.example")
    assert captured["timeout"] == 47
    assert captured["proxy"] == "http://global-proxy.example:8080"


def test_web_search_rejects_deprecated_provider(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.services.search._get_web_search_config",
        lambda: {"enabled": True},
    )
    monkeypatch.setattr(
        "cognivoy.services.search.resolve_search_runtime_config",
        lambda: ResolvedSearchConfig(
            provider="exa",
            requested_provider="exa",
            unsupported_provider=True,
            deprecated_provider=True,
        ),
    )
    with pytest.raises(ValueError):
        web_search("hello")


def test_web_search_perplexity_missing_key_hard_fails(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.services.search._get_web_search_config",
        lambda: {"enabled": True},
    )
    monkeypatch.setattr(
        "cognivoy.services.search.resolve_search_runtime_config",
        lambda: ResolvedSearchConfig(
            provider="perplexity",
            requested_provider="perplexity",
            api_key="",
            max_results=5,
            missing_credentials=True,
        ),
    )
    monkeypatch.setattr("cognivoy.services.search._resolve_provider_key", lambda _p, _k: "")
    with pytest.raises(ValueError, match="perplexity requires api_key"):
        web_search("hello")


def test_web_search_missing_key_falls_back_to_duckduckgo(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def _fake_get_provider(name: str, **kwargs):
        captured["provider"] = name
        captured["kwargs"] = kwargs
        return _FakeProvider(name)

    monkeypatch.setattr(
        "cognivoy.services.search._get_web_search_config",
        lambda: {"enabled": True},
    )
    monkeypatch.setattr(
        "cognivoy.services.search.resolve_search_runtime_config",
        lambda: ResolvedSearchConfig(
            provider="brave",
            requested_provider="brave",
            api_key="",
            base_url="",
            max_results=3,
            proxy="http://127.0.0.1:7890",
        ),
    )
    monkeypatch.setattr("cognivoy.services.search._resolve_provider_key", lambda _p, _k: "")
    monkeypatch.setattr("cognivoy.services.search.get_provider", _fake_get_provider)
    result = web_search("hello")
    assert captured["provider"] == "duckduckgo"
    assert result["provider"] == "duckduckgo"
    kwargs = captured["kwargs"]
    assert kwargs["proxy"] == "http://127.0.0.1:7890"
    assert kwargs["max_results"] == 3


def test_web_search_searxng_uses_base_url(monkeypatch) -> None:
    captured: dict[str, object] = {}

    def _fake_get_provider(name: str, **kwargs):
        captured["provider"] = name
        captured["kwargs"] = kwargs
        return _FakeProvider(name)

    monkeypatch.setattr(
        "cognivoy.services.search._get_web_search_config",
        lambda: {"enabled": True},
    )
    monkeypatch.setattr(
        "cognivoy.services.search.resolve_search_runtime_config",
        lambda: ResolvedSearchConfig(
            provider="searxng",
            requested_provider="searxng",
            base_url="https://searx.example.com",
            max_results=4,
        ),
    )
    monkeypatch.setattr("cognivoy.services.search.get_provider", _fake_get_provider)
    result = web_search("hello")
    assert captured["provider"] == "searxng"
    assert captured["kwargs"]["base_url"] == "https://searx.example.com"
    assert captured["kwargs"]["max_results"] == 4
    assert result["provider"] == "searxng"
