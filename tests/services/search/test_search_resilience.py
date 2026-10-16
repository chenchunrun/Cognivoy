"""Offline regressions for bounded keyless-search recovery."""

from __future__ import annotations

import asyncio
from concurrent.futures import ThreadPoolExecutor
import sys
from types import SimpleNamespace

import pytest

from cognivoy.services.search.resilience import SearchProviderError, search_with_recovery
from cognivoy.services.search.types import WebSearchResponse


class FakeProvider:
    name = "duckduckgo"

    def __init__(self, failures):
        self.failures = list(failures)
        self.calls = []

    def search(self, query, **kwargs):
        self.calls.append(kwargs)
        if self.failures:
            raise self.failures.pop(0)
        return WebSearchResponse(query=query, answer="found", provider=self.name)


@pytest.fixture
def clock(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("cognivoy.services.search.resilience.time.monotonic", lambda: now[0])

    def advance(seconds):
        now[0] += seconds

    monkeypatch.setattr("cognivoy.services.search.resilience.time.sleep", advance)
    return now


@pytest.mark.parametrize(
    "failure",
    [
        RuntimeError("TLS handshake EOF"),
        RuntimeError("TLS handshake failed: unexpected EOF"),
        ConnectionResetError("connection reset by peer"),
        TimeoutError("timed out"),
    ],
)
def test_transient_failure_recovers_once_with_remaining_budget(clock, failure):
    provider = FakeProvider([failure])
    result = search_with_recovery(provider, "public query", {"timeout": 10, "proxy": "proxy"})
    assert result.answer == "found"
    assert result.metadata["search_attempts"] == 2
    assert provider.calls == [
        {"timeout": 5, "proxy": "proxy"},
        {"timeout": 9, "proxy": "proxy"},
    ]


@pytest.mark.parametrize(
    ("failure", "category"),
    [
        (ConnectionError("CERTIFICATE_VERIFY_FAILED: connection reset"), "tls_verification"),
        (RuntimeError("self signed certificate"), "tls_verification"),
        (ImportError("ddgs missing"), "configuration"),
        (ValueError("invalid URL"), "configuration"),
        (RuntimeError("rate limit exceeded"), "rate_limited"),
        (RuntimeError("No results found."), "no_results"),
    ],
)
def test_nontransient_failures_are_not_retried(clock, failure, category):
    provider = FakeProvider([failure])
    with pytest.raises(SearchProviderError) as raised:
        search_with_recovery(provider, "query", {"timeout": 60})
    assert raised.value.category == category
    assert len(provider.calls) == 1


def test_authentication_errors_are_not_retried(clock):
    failure = ConnectionError("token rejected")
    failure.response = SimpleNamespace(status_code=401)
    provider = FakeProvider([failure])
    with pytest.raises(SearchProviderError, match="authentication"):
        search_with_recovery(provider, "query", {"timeout": 60})
    assert len(provider.calls) == 1


def test_retries_stop_after_two_and_error_does_not_expose_proxy_secrets(clock):
    failure = RuntimeError("unexpected EOF via https://user:private-token@proxy.example?q=private")
    provider = FakeProvider([failure, failure, failure])
    with pytest.raises(SearchProviderError) as raised:
        search_with_recovery(provider, "query", {"timeout": 60})
    assert raised.value.attempts == 2
    assert len(provider.calls) == 2
    assert "private" not in str(raised.value)
    assert "proxy.example" not in str(raised.value)


def test_slow_failure_does_not_gain_another_timeout_budget(clock):
    provider = FakeProvider([])

    def fail_after_budget(_query, **kwargs):
        provider.calls.append(kwargs)
        clock[0] += 10
        raise TimeoutError("timed out")

    provider.search = fail_after_budget
    with pytest.raises(SearchProviderError, match="timeout"):
        search_with_recovery(provider, "query", {"timeout": 10})
    assert len(provider.calls) == 1


def test_paid_provider_is_not_replayed_even_for_transport_errors(clock):
    provider = FakeProvider([TimeoutError("timed out")])
    provider.name = "tavily"
    with pytest.raises(SearchProviderError):
        search_with_recovery(provider, "query", {"timeout": 60})
    assert len(provider.calls) == 1


def test_cancellation_is_not_converted_or_retried(clock):
    provider = FakeProvider([asyncio.CancelledError()])
    with pytest.raises(asyncio.CancelledError):
        search_with_recovery(provider, "query", {"timeout": 60})
    assert len(provider.calls) == 1


def test_concurrent_searches_keep_independent_retry_budgets():
    def run(query):
        provider = FakeProvider([RuntimeError("TLS handshake EOF")])
        return search_with_recovery(provider, query, {"timeout": 5})

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, ["first", "second"]))
    assert [result.query for result in results] == ["first", "second"]
    assert all(result.metadata["search_attempts"] == 2 for result in results)


def test_ddgs_uses_bounded_engines_and_keeps_tls_and_proxy(monkeypatch):
    from cognivoy.services.search.providers.duckduckgo import DuckDuckGoProvider

    captured = {}

    class DDGS:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def text(self, query, **kwargs):
            captured.update(kwargs)
            return [{"title": "source", "href": "https://example.com", "body": "result"}]

    monkeypatch.setitem(sys.modules, "ddgs", SimpleNamespace(DDGS=DDGS))
    provider = DuckDuckGoProvider(api_key="unused", proxy="http://proxy.example:8080")
    result = provider.search("query", timeout=15, max_results=3)
    assert captured == {
        "proxy": "http://proxy.example:8080",
        "timeout": 15,
        "verify": True,
        "max_results": 3,
        "backend": "duckduckgo,brave",
    }
    assert len(result.citations) == 1
    assert result.metadata["search_backends"] == ["duckduckgo", "brave"]
