"""Unit tests for the ``web_fetch`` tool's pure helpers."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from email.utils import format_datetime

import httpx
import pytest

from cognivoy.services.config.network_policy import (
    OutboundNetworkDisabledError,
    OutboundNetworkPolicy,
)
from cognivoy.tools.web_fetch import (
    DEFAULT_MAX_CHARS,
    FetchOutcome,
    _extract_readable,
    _is_disallowed_host,
    _retry_after_seconds,
    fetch_url_as_markdown,
)
from cognivoy.utils.network.public_url import PinnedHttpTarget


@pytest.fixture(autouse=True)
def isolated_network_policy(monkeypatch):
    monkeypatch.setattr(
        "cognivoy.tools.web_fetch.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 15, None),
    )
    monkeypatch.setattr("cognivoy.tools.web_fetch._audit_target_denial", lambda _url: None)


@pytest.fixture
def retry_delays(monkeypatch):
    delays = []

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr("cognivoy.tools.web_fetch.asyncio.sleep", sleep)
    return delays


# ---------------------------------------------------------------------------
# Host validation
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",
        "localhost",
        "10.0.0.1",
        "192.168.1.1",
        "169.254.1.1",
        "::1",
        "[::1]",
        "metadata.local",
    ],
)
def test_is_disallowed_host_blocks_private_addresses(host: str) -> None:
    assert _is_disallowed_host(host) is True, f"{host!r} should be disallowed"


def test_is_disallowed_host_allows_public_hostname() -> None:
    # The DNS-dependent positive test is environment-fragile (CI sandboxes
    # often block outbound DNS). The negative coverage above plus the
    # injectable ``host_validator`` (used in fetch tests) makes a fully-
    # offline public-host assertion unnecessary.
    pytest.skip("public DNS check skipped; relies on injectable validator in tests")


# ---------------------------------------------------------------------------
# HTML readability extraction
# ---------------------------------------------------------------------------


def test_extract_readable_strips_scripts_and_styles() -> None:
    html = """
    <html><head><title>Hello</title><style>body {color:red;}</style></head>
    <body><p>Visible.</p><script>alert('no');</script></body></html>
    """
    title, body = _extract_readable(html)
    assert title == "Hello"
    assert "Visible." in body
    assert "alert" not in body
    assert "color:red" not in body
    # Title is prepended as h1 markdown
    assert body.startswith("# Hello")


def test_extract_readable_passes_through_plain_text() -> None:
    title, body = _extract_readable("Plain text payload\nwith two lines.")
    assert title == ""
    assert "Plain text payload" in body
    assert "with two lines" in body


# ---------------------------------------------------------------------------
# Top-level fetch — uses injected client_factory so no real network I/O.
# ---------------------------------------------------------------------------


class _StubResponse:
    def __init__(
        self,
        *,
        body: bytes = b"<html><title>T</title><body><p>x</p></body></html>",
        status: int = 200,
        url: str = "https://example.com/p",
        encoding: str = "utf-8",
    ) -> None:
        self._body = body
        self.status_code = status
        self.url = url
        self.encoding = encoding
        self.headers = {"content-type": "text/html; charset=utf-8"}
        self.closed = False

    async def aiter_bytes(self):
        yield self._body

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _StubAsyncClient:
    def __init__(self, response: _StubResponse | list[_StubResponse]) -> None:
        self._responses = list(response) if isinstance(response, list) else [response]
        self.requested_urls: list[str] = []
        self.request_kwargs: list[dict[str, object]] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def stream(self, _method, url, **kwargs):
        outer = self
        assert kwargs.get("follow_redirects") is False
        outer.requested_urls.append(url)
        outer.request_kwargs.append(kwargs)

        class _Ctx:
            async def __aenter__(self):
                self.response = outer._responses.pop(0)
                if isinstance(self.response, Exception):
                    raise self.response
                return self.response

            async def __aexit__(self, exc_type, exc, tb):
                self.response.closed = True
                return False

        return _Ctx()


def _factory_returning(response: _StubResponse):
    def _factory(*, timeout: float, user_agent: str):
        return _StubAsyncClient(response)

    return _factory


@pytest.mark.asyncio
async def test_fetch_stops_before_client_when_outbound_network_is_disabled(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.tools.web_fetch.require_outbound_network",
        lambda _feature: (_ for _ in ()).throw(OutboundNetworkDisabledError("network disabled")),
    )
    called = False

    def _factory(**_kwargs):
        nonlocal called
        called = True
        return _StubAsyncClient(_StubResponse())

    outcome = await fetch_url_as_markdown(
        "https://example.com/p",
        client_factory=_factory,
        host_validator=_ALLOW_ALL,
    )
    assert outcome.ok is False
    assert "network disabled" in outcome.error
    assert called is False


@pytest.mark.asyncio
async def test_fetch_clamps_timeout_to_policy(monkeypatch) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        "cognivoy.tools.web_fetch.require_outbound_network",
        lambda _feature: OutboundNetworkPolicy(True, 9, None),
    )

    def _factory(*, timeout: float, user_agent: str):
        captured["timeout"] = timeout
        captured["user_agent"] = user_agent
        return _StubAsyncClient(_StubResponse())

    outcome = await fetch_url_as_markdown(
        "https://example.com/p",
        timeout_s=30,
        client_factory=_factory,
        host_validator=_ALLOW_ALL,
    )
    assert outcome.ok is True
    assert captured["timeout"] == 9


@pytest.mark.asyncio
async def test_fetch_rejects_unsupported_scheme() -> None:
    outcome = await fetch_url_as_markdown("ftp://example.com/x")
    assert outcome.ok is False
    assert "scheme" in outcome.error.lower()


@pytest.mark.asyncio
async def test_fetch_rejects_private_host() -> None:
    outcome = await fetch_url_as_markdown("http://127.0.0.1/x")
    assert outcome.ok is False
    assert "private" in outcome.error.lower() or "loopback" in outcome.error.lower()


@pytest.mark.asyncio
async def test_fetch_rejects_embedded_credentials_before_network() -> None:
    called = False

    def _factory(**_kwargs):
        nonlocal called
        called = True
        return _StubAsyncClient(_StubResponse())

    outcome = await fetch_url_as_markdown(
        "https://user:password@example.com/x",
        client_factory=_factory,
        host_validator=_ALLOW_ALL,
    )
    assert outcome.ok is False
    assert "credentials" in outcome.error.lower()
    assert called is False


# Bypass DNS in every stubbed-network test — the validator is treated as
# trusted here because ``client_factory`` already pins the response.
_ALLOW_ALL = lambda host: False  # noqa: E731 — single-use stub


@pytest.mark.asyncio
async def test_fetch_extracts_html_via_stubbed_client() -> None:
    outcome = await fetch_url_as_markdown(
        "https://example.com/p",
        client_factory=_factory_returning(_StubResponse()),
        host_validator=_ALLOW_ALL,
    )
    assert outcome.ok is True
    assert outcome.title == "T"
    assert "x" in outcome.markdown


@pytest.mark.asyncio
async def test_fetch_truncates_at_max_chars() -> None:
    big_body = b"<html><body>" + (b"a" * 5000) + b"</body></html>"
    outcome = await fetch_url_as_markdown(
        "https://example.com/big",
        max_chars=200,
        client_factory=_factory_returning(_StubResponse(body=big_body)),
        host_validator=_ALLOW_ALL,
    )
    assert outcome.ok is True
    assert outcome.truncated is True
    assert outcome.markdown.endswith("…[truncated]")
    assert len(outcome.markdown) <= 220  # cap + marker headroom


@pytest.mark.asyncio
async def test_fetch_propagates_http_error_as_outcome_not_exception() -> None:
    outcome = await fetch_url_as_markdown(
        "https://example.com/missing",
        client_factory=_factory_returning(_StubResponse(status=404, body=b"<p>missing</p>")),
        host_validator=_ALLOW_ALL,
    )
    assert outcome.ok is False
    assert "404" in outcome.error


@pytest.mark.asyncio
async def test_fetch_blocks_private_redirect_before_second_request() -> None:
    redirect = _StubResponse(status=302, url="https://example.com/start")
    redirect.headers["location"] = "http://127.0.0.1/admin"
    client = _StubAsyncClient(redirect)

    def _factory(*, timeout: float, user_agent: str):
        return client

    outcome = await fetch_url_as_markdown(
        "https://example.com/start",
        client_factory=_factory,
        host_validator=lambda host: host == "127.0.0.1",
    )

    assert outcome.ok is False
    assert "redirect blocked" in outcome.error.lower()
    assert client.requested_urls == ["https://example.com/start"]


@pytest.mark.asyncio
async def test_fetch_follows_valid_redirect_one_hop_at_a_time() -> None:
    redirect = _StubResponse(status=302, url="https://example.com/start")
    redirect.headers["location"] = "/final"
    final = _StubResponse(url="https://example.com/final")
    client = _StubAsyncClient([redirect, final])

    def _factory(*, timeout: float, user_agent: str):
        return client

    outcome = await fetch_url_as_markdown(
        "https://example.com/start",
        client_factory=_factory,
        host_validator=_ALLOW_ALL,
    )

    assert outcome.ok is True
    assert outcome.url == "https://example.com/final"
    assert client.requested_urls == [
        "https://example.com/start",
        "https://example.com/final",
    ]


@pytest.mark.asyncio
async def test_fetch_uses_pinned_ip_host_header_and_tls_sni() -> None:
    client = _StubAsyncClient(_StubResponse(url="https://93.184.216.34/p"))

    def _factory(*, timeout: float, user_agent: str):
        return client

    outcome = await fetch_url_as_markdown(
        "https://example.com/p",
        client_factory=_factory,
        host_validator=_ALLOW_ALL,
        target_pinner=lambda _url: (
            PinnedHttpTarget(
                original_url="https://example.com/p",
                connect_url="https://93.184.216.34/p",
                host_header="example.com",
                sni_hostname="example.com",
                resolved_ip="93.184.216.34",
            ),
            "",
        ),
    )

    assert outcome.ok is True
    assert client.requested_urls == ["https://93.184.216.34/p"]
    assert client.request_kwargs[0]["headers"]["Host"] == "example.com"
    assert client.request_kwargs[0]["extensions"]["sni_hostname"] == "example.com"


async def _fetch_responses(responses, **kwargs):
    client = _StubAsyncClient(responses)
    outcome = await fetch_url_as_markdown(
        "https://example.com/p",
        client_factory=lambda **_kwargs: client,
        host_validator=_ALLOW_ALL,
        **kwargs,
    )
    return outcome, client


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
async def test_transient_http_status_retries_inside_one_tool_call(status, retry_delays) -> None:
    first = _StubResponse(status=status)
    outcome, client = await _fetch_responses([first, _StubResponse()])
    assert outcome.ok and outcome.status_code == 200
    assert outcome.attempts == 2 and outcome.retry_count == 1
    assert first.closed and len(client.requested_urls) == 2
    assert retry_delays == [0.5]


@pytest.mark.asyncio
async def test_retry_exhaustion_is_bounded_and_advises_against_immediate_loop(retry_delays) -> None:
    outcome, client = await _fetch_responses([_StubResponse(status=429) for _ in range(5)])
    assert not outcome.ok and outcome.status_code == 429
    assert outcome.attempts == 3 and outcome.retry_count == 2
    assert len(client.requested_urls) == 3 and retry_delays == [0.5, 1.0]
    assert "Avoid immediate repeated calls" in outcome.error


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [400, 401, 403, 404, 501])
async def test_nontransient_status_never_retries(status, retry_delays) -> None:
    outcome, client = await _fetch_responses([_StubResponse(status=status), _StubResponse()])
    assert not outcome.ok and outcome.attempts == 1
    assert len(client.requested_urls) == 1 and retry_delays == []


@pytest.mark.asyncio
async def test_retry_after_seconds_is_honoured_after_response_close(monkeypatch) -> None:
    limited = _StubResponse(status=429)
    limited.headers["retry-after"] = "2"
    delays = []

    async def sleep(delay):
        assert limited.closed
        delays.append(delay)

    monkeypatch.setattr("cognivoy.tools.web_fetch.asyncio.sleep", sleep)
    outcome, _ = await _fetch_responses([limited, _StubResponse()])
    assert outcome.ok and delays == [2.0]


@pytest.mark.asyncio
async def test_retry_after_http_date_is_honoured(monkeypatch, retry_delays) -> None:
    monkeypatch.setattr("cognivoy.tools.web_fetch.time.time", lambda: 1_700_000_000)
    limited = _StubResponse(status=503)
    limited.headers["retry-after"] = format_datetime(
        datetime.fromtimestamp(1_700_000_003, timezone.utc),
        usegmt=True,
    )
    outcome, _ = await _fetch_responses([limited, _StubResponse()])
    assert outcome.ok and retry_delays == [3.0]


@pytest.mark.parametrize("value", [None, "", "bad-date", "-1", "NaN", "inf", "0.5"])
def test_malformed_retry_after_uses_fallback(value) -> None:
    assert _retry_after_seconds(value) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("header,timeout", [("60", 15), ("3", 1)])
async def test_excessive_server_wait_is_not_shortened(header, timeout, retry_delays) -> None:
    limited = _StubResponse(status=429)
    limited.headers["retry-after"] = header
    outcome, client = await _fetch_responses([limited, _StubResponse()], timeout_s=timeout)
    assert not outcome.ok and outcome.retry_after_seconds == float(header)
    assert len(client.requested_urls) == 1 and retry_delays == []


@pytest.mark.asyncio
async def test_transport_failure_retries(retry_delays) -> None:
    outcome, _ = await _fetch_responses(
        [httpx.ReadError("connection interrupted"), _StubResponse()]
    )
    assert outcome.ok and outcome.attempts == 2 and outcome.retry_count == 1
    assert retry_delays == [0.5]


@pytest.mark.asyncio
async def test_retry_rechecks_dns_and_blocks_rebinding(retry_delays) -> None:
    resolutions = []

    def pin(url):
        resolutions.append(url)
        if len(resolutions) > 1:
            return None, "Refusing private DNS answer."
        return PinnedHttpTarget(
            url, "https://93.184.216.34/p", "example.com", "example.com", "93.184.216.34"
        ), ""

    outcome, client = await _fetch_responses(
        [_StubResponse(status=429), _StubResponse()], target_pinner=pin
    )
    assert not outcome.ok and "private" in outcome.error
    assert resolutions == ["https://example.com/p"] * 2
    assert client.requested_urls == ["https://93.184.216.34/p"]


@pytest.mark.asyncio
async def test_retry_does_not_bypass_redirect_validation(retry_delays) -> None:
    redirect = _StubResponse(status=302)
    redirect.headers["location"] = "http://user:secret@example.com/private"
    outcome, client = await _fetch_responses([_StubResponse(status=429), redirect, _StubResponse()])
    assert not outcome.ok and "Redirect blocked" in outcome.error
    assert len(client.requested_urls) == 2


@pytest.mark.asyncio
async def test_retry_budget_shared_across_redirect_hops(retry_delays) -> None:
    redirect = _StubResponse(status=302)
    redirect.headers["location"] = "/final"
    outcome, client = await _fetch_responses(
        [
            _StubResponse(status=503),
            redirect,
            _StubResponse(status=503),
            _StubResponse(status=503),
            _StubResponse(),
        ]
    )
    assert not outcome.ok and outcome.retry_count == 2
    assert len(client.requested_urls) == 4 and retry_delays == [0.5, 1.0]


@pytest.mark.asyncio
async def test_policy_revocation_during_backoff_blocks_next_request(monkeypatch) -> None:
    allowed = True

    def policy(_feature):
        if not allowed:
            raise OutboundNetworkDisabledError("network disabled during retry")
        return OutboundNetworkPolicy(True, 15, None)

    async def sleep(_delay):
        nonlocal allowed
        allowed = False

    monkeypatch.setattr("cognivoy.tools.web_fetch.require_outbound_network", policy)
    monkeypatch.setattr("cognivoy.tools.web_fetch.asyncio.sleep", sleep)
    outcome, client = await _fetch_responses([_StubResponse(status=429), _StubResponse()])
    assert not outcome.ok and "disabled" in outcome.error
    assert len(client.requested_urls) == 1


@pytest.mark.asyncio
async def test_cancellation_during_backoff_propagates_without_next_request(monkeypatch) -> None:
    limited = _StubResponse(status=429)

    async def sleep(_delay):
        assert limited.closed
        raise asyncio.CancelledError

    monkeypatch.setattr("cognivoy.tools.web_fetch.asyncio.sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await _fetch_responses([limited, _StubResponse()])


@pytest.mark.asyncio
async def test_total_deadline_includes_response_read_and_closes_stream() -> None:
    class SlowResponse(_StubResponse):
        async def aiter_bytes(self):
            await asyncio.Event().wait()
            yield b"never reached"

    response = SlowResponse()
    outcome, client = await _fetch_responses(response, timeout_s=0.01)
    assert not outcome.ok and "total" in outcome.error and "deadline" in outcome.error
    assert response.closed and len(client.requested_urls) == 1


@pytest.mark.asyncio
async def test_download_cap_handles_oversized_single_chunk(monkeypatch) -> None:
    monkeypatch.setattr("cognivoy.tools.web_fetch.MAX_RESPONSE_BYTES", 50)
    outcome, _ = await _fetch_responses(_StubResponse(body=b"a" * 1000))
    assert outcome.ok and outcome.truncated
    assert outcome.markdown.startswith("a" * 50 + "\n")
    assert len(outcome.markdown) < 100


@pytest.mark.asyncio
async def test_wrapper_surfaces_retry_metadata(monkeypatch) -> None:
    from cognivoy.tools.builtin import WebFetchTool

    async def fetch(_url, **_kwargs):
        return FetchOutcome(ok=False, error="limited", status_code=429, attempts=3, retry_count=2)

    monkeypatch.setattr("cognivoy.tools.web_fetch.fetch_url_as_markdown", fetch)
    result = await WebFetchTool().execute(url="https://example.com/p")
    assert not result.success
    assert result.metadata["status_code"] == 429 and result.metadata["retry_count"] == 2
