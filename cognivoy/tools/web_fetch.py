"""HTTP fetch + readable-content extraction for the chat ``web_fetch`` tool.

Kept deliberately self-contained: a single async entrypoint
:py:func:`fetch_url_as_markdown` that takes a URL and returns either the
extracted text (with a ``url`` field for citation) or a structured error.
The chat pipeline calls it via the thin ``WebFetchTool`` wrapper in
``cognivoy/tools/builtin/__init__.py``; no internal global state, no
hidden side-effects — easy to test by passing a mock httpx client.

Security stance (kept tight on purpose because the model decides
arguments, not a human):

* Only ``http://`` / ``https://`` schemes accepted.
* IP literals and hostnames resolving to **private / loopback / link-local**
  ranges are rejected before every request. Redirects are followed manually,
  so a redirect to ``127.0.0.1`` is blocked before the private request occurs.
* Response size is hard-capped at ``MAX_RESPONSE_BYTES``; we stop reading
  once the body grows past this even before the server finishes.
* Extracted text is truncated to ``max_chars`` (default 50 000 chars,
  callers can request smaller excerpts) with a ``…[truncated]`` marker.
* Transient failures get at most two retries, sharing one wall-clock
  deadline with redirects and reads. Long Retry-After waits are not shortened.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
import logging
import math
import re
import time
from typing import Any
from urllib.parse import urljoin

import httpx

from cognivoy.services.config.network_policy import (
    OutboundNetworkDisabledError,
    require_outbound_network,
)
from cognivoy.utils.network.public_url import (
    PUBLIC_HTTP_SCHEMES,
    is_disallowed_public_host,
    pin_public_http_url,
    validate_public_http_url,
)

logger = logging.getLogger(__name__)

DEFAULT_MAX_CHARS = 50_000
MAX_RESPONSE_BYTES = 4 * 1024 * 1024  # 4 MB — safety cap on raw download
DEFAULT_TIMEOUT_S = 15.0
DEFAULT_USER_AGENT = "Cognivoy/1.0 (+https://hkuds.dev/cognivoy)"
ALLOWED_SCHEMES = PUBLIC_HTTP_SCHEMES
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
MAX_REDIRECTS = 5
MAX_RETRIES = 2  # shared across redirects; never multiplied per hop
MAX_RETRY_DELAY_S = 5.0
RETRYABLE_STATUSES = frozenset({429, 500, 502, 503, 504})


def _audit_target_denial(target: str) -> None:
    from cognivoy.runtime.control_plane import record_network_policy_denial

    record_network_policy_denial("web_fetch", target)


# Cheap inline HTML → text. Good enough for blog / docs / arxiv abstract
# pages. For JS-heavy SPAs the tool will return the bare HTML scaffold —
# the docstring tells the model it may fail in that case, so it won't
# fabricate around an empty result.
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.DOTALL | re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"[ \t]+")
_BLANK_LINE_RE = re.compile(r"\n{3,}")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.DOTALL | re.IGNORECASE)


@dataclass(frozen=True)
class FetchOutcome:
    """Result of a single ``web_fetch`` invocation.

    ``ok=True`` paths populate ``markdown`` and ``url`` (the final
    resolved URL after redirects). ``ok=False`` paths populate ``error``
    with a one-line description suitable to surface back to the model.
    """

    ok: bool
    markdown: str = ""
    url: str = ""
    title: str = ""
    truncated: bool = False
    error: str = ""
    status_code: int | None = None
    attempts: int = 0
    retry_count: int = 0
    retry_after_seconds: float | None = None


async def fetch_url_as_markdown(
    url: str,
    *,
    max_chars: int = DEFAULT_MAX_CHARS,
    timeout_s: float = DEFAULT_TIMEOUT_S,
    user_agent: str = DEFAULT_USER_AGENT,
    client_factory: Any = None,
    host_validator: Any = None,
    target_pinner: Any = None,
) -> FetchOutcome:
    """Fetch ``url`` and extract readable text.

    ``client_factory`` accepts a callable taking ``timeout`` and ``user_agent``, returning an
    ``httpx.AsyncClient``-compatible context manager. ``host_validator``
    is a ``(host: str) -> bool`` that returns ``True`` iff the host
    should be **rejected** as private/loopback — defaults to
    :py:func:`_is_disallowed_host`. Both default to real production
    behaviour; tests inject stubs to bypass DNS or network I/O.
    """
    url_clean = (url or "").strip().strip("`\"'")
    validator = host_validator or _is_disallowed_host
    pin_connections = client_factory is None or target_pinner is not None
    preflight_validator = (lambda _host: False) if pin_connections else validator
    validation_error = _validate_fetch_target(url_clean, preflight_validator)
    if validation_error:
        _audit_target_denial(url_clean)
        return FetchOutcome(ok=False, error=validation_error)

    try:
        network_policy = require_outbound_network("web_fetch")
    except OutboundNetworkDisabledError as exc:
        _audit_target_denial(url_clean)
        return FetchOutcome(ok=False, error=str(exc))

    try:
        effective_timeout = min(float(timeout_s), float(network_policy.timeout_seconds))
    except (TypeError, ValueError):
        return FetchOutcome(ok=False, error="timeout_s must be a positive finite number.")
    if not math.isfinite(effective_timeout) or effective_timeout <= 0:
        return FetchOutcome(ok=False, error="timeout_s must be a positive finite number.")
    if isinstance(max_chars, bool) or not isinstance(max_chars, int) or max_chars < 1:
        return FetchOutcome(ok=False, error="max_chars must be a positive integer.")
    max_chars = min(max_chars, DEFAULT_MAX_CHARS)

    factory = client_factory or _default_client_factory
    deadline = time.monotonic() + effective_timeout
    current_url = url_clean
    attempts = retries = redirect_count = 0
    status_code = None
    retry_after = None

    def failure(error: str) -> FetchOutcome:
        return FetchOutcome(
            ok=False,
            url=current_url,
            error=error,
            status_code=status_code,
            attempts=attempts,
            retry_count=retries,
            retry_after_seconds=retry_after,
        )

    try:
        # One wall-clock deadline covers redirects, DNS, response reads and backoff.
        # External cancellation propagates; only this scope's timeout becomes an outcome.
        async with asyncio.timeout(effective_timeout):
            factory_kwargs: dict[str, Any] = {
                "timeout": effective_timeout,
                "user_agent": user_agent,
            }
            if client_factory is None:
                factory_kwargs["proxy"] = network_policy.proxy
            async with factory(**factory_kwargs) as client:
                while True:
                    try:
                        require_outbound_network("web_fetch")
                    except OutboundNetworkDisabledError as exc:
                        _audit_target_denial(current_url)
                        return failure(str(exc))
                    validation_error = _validate_fetch_target(current_url, preflight_validator)
                    if validation_error:
                        _audit_target_denial(current_url)
                        prefix = "Redirect blocked: " if redirect_count else ""
                        return failure(prefix + validation_error)
                    request_url = current_url
                    request_headers = {"User-Agent": user_agent, "Accept": "text/html,*/*;q=0.5"}
                    request_extensions: dict[str, Any] = {}
                    if pin_connections:
                        # Re-resolve and validate EVERY retry/redirect; never reuse a pin
                        # after backoff. DNS must not block the event loop/deadline.
                        pinner = target_pinner or pin_public_http_url
                        pinned, pin_error = await asyncio.to_thread(pinner, current_url)
                        if pinned is None:
                            _audit_target_denial(current_url)
                            return failure(pin_error)
                        request_url = pinned.connect_url
                        request_headers["Host"] = pinned.host_header
                        request_extensions["sni_hostname"] = pinned.sni_hostname
                    status_code = None
                    retry_after = None
                    attempts += 1
                    try:
                        async with client.stream(
                            "GET",
                            request_url,
                            headers=request_headers,
                            follow_redirects=False,
                            extensions=request_extensions or None,
                            timeout=max(0.001, deadline - time.monotonic()),
                        ) as response:
                            status_code = response.status_code
                            if status_code in REDIRECT_STATUSES:
                                location = str(response.headers.get("location") or "").strip()
                                if not location:
                                    return failure(f"HTTP {status_code} redirect without Location.")
                                if redirect_count >= MAX_REDIRECTS:
                                    return failure("Too many redirects.")
                                next_url = urljoin(current_url, location)
                                redirect_error = _validate_fetch_target(
                                    next_url, preflight_validator
                                )
                                if redirect_error:
                                    _audit_target_denial(next_url)
                                    return failure("Redirect blocked: " + redirect_error)
                                current_url = next_url
                                redirect_count += 1
                                continue
                            if status_code >= 400:
                                error = f"HTTP {status_code} from {current_url}."
                                if status_code not in RETRYABLE_STATUSES:
                                    return failure(error)
                                retry_after = _retry_after_seconds(
                                    response.headers.get("retry-after")
                                )
                            else:
                                raw, download_truncated = await _bounded_read(
                                    response, MAX_RESPONSE_BYTES
                                )
                                break
                    except httpx.TransportError as exc:
                        error = f"Network error: {exc}"
                    # The previous response is closed before waiting or retrying.
                    delay = retry_after if retry_after is not None else 0.5 * (2**retries)
                    if (
                        retries >= MAX_RETRIES
                        or delay > MAX_RETRY_DELAY_S
                        or delay + 0.1 >= deadline - time.monotonic()
                    ):
                        return failure(
                            error + f" Automatic retry budget stopped after {attempts} request(s). "
                            "Avoid immediate repeated calls; use another source or try later."
                        )
                    await asyncio.sleep(delay)
                    retries += 1
    except TimeoutError:
        return failure(
            f"Fetch exceeded its total {effective_timeout:g}s deadline (including retries)."
        )
    except httpx.HTTPError as exc:
        return failure(f"Network error: {exc}")
    except Exception as exc:  # pragma: no cover — defensive
        return failure(f"Unexpected fetch failure: {exc}")

    title, body = _extract_readable(raw)
    truncated = download_truncated
    if len(body) > max_chars:
        body = body[:max_chars].rstrip() + "\n…[truncated]"
        truncated = True
    elif download_truncated:
        body += "\n…[truncated at download limit]"
    return FetchOutcome(
        ok=True,
        markdown=body,
        url=current_url,
        title=title,
        truncated=truncated,
        status_code=status_code,
        attempts=attempts,
        retry_count=retries,
    )


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _retry_after_seconds(value: str | None) -> float | None:
    """Parse delta-seconds or HTTP-date; never shorten a valid server wait."""
    raw = str(value or "").strip()
    if raw.isdigit():
        try:
            return float(raw)
        except ValueError:
            return None
    try:
        parsed = parsedate_to_datetime(raw)
        if parsed.tzinfo is None:
            return None
        return max(0.0, parsed.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def _default_client_factory(
    *, timeout: float, user_agent: str, proxy: str | None = None
) -> httpx.AsyncClient:
    kwargs: dict[str, Any] = {
        "timeout": timeout,
        "headers": {"User-Agent": user_agent},
        "limits": httpx.Limits(max_connections=10, max_keepalive_connections=0),
        "trust_env": False,
    }
    if proxy:
        kwargs["proxy"] = proxy
    return httpx.AsyncClient(**kwargs)


def _validate_fetch_target(url: str, validator: Any) -> str:
    """Return a safe-to-display error, or an empty string for an allowed URL."""
    allowed, error = validate_public_http_url(url, host_validator=validator)
    return "" if allowed else error


def _is_disallowed_host(host: str) -> bool:
    """Block hosts that resolve to private / loopback / link-local IPs.

    Handles both raw IP literals (``127.0.0.1`` / ``[::1]``) and DNS
    names (resolves them once via ``socket.getaddrinfo`` and checks ALL
    returned addresses). DNS failures are treated as disallowed to fail
    closed when in doubt.
    """
    return is_disallowed_public_host(host)


async def _bounded_read(response: httpx.Response, limit: int) -> tuple[str, bool]:
    """Stream-read at most ``limit`` bytes from ``response`` then stop.

    Avoids holding hundreds of MB if a server (or an LLM-supplied URL)
    points at a huge resource. Encoding falls back from response.encoding
    → utf-8 with replacement.
    """
    buf = bytearray()
    async for chunk in response.aiter_bytes():
        buf.extend(chunk[: max(0, limit - len(buf))])
        if len(buf) >= limit:
            break
    encoding = response.encoding or "utf-8"
    try:
        return buf.decode(encoding, errors="replace"), len(buf) >= limit
    except (LookupError, TypeError):
        return buf.decode("utf-8", errors="replace"), len(buf) >= limit


def _extract_readable(html_or_text: str) -> tuple[str, str]:
    """Return ``(title, body_text)`` extracted from an HTML string.

    For non-HTML payloads (plain text, JSON dumps) just normalises
    whitespace and returns the input as-is — the model still gets
    something usable.
    """
    title = ""
    if "<" in html_or_text and ">" in html_or_text:
        title_match = _TITLE_RE.search(html_or_text)
        if title_match:
            title = re.sub(r"\s+", " ", title_match.group(1)).strip()
        stripped = _SCRIPT_STYLE_RE.sub(" ", html_or_text)
        stripped = _TAG_RE.sub(" ", stripped)
        # Decode common entities cheaply (full entity table is overkill).
        stripped = (
            stripped.replace("&nbsp;", " ")
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", '"')
            .replace("&#39;", "'")
        )
        body = stripped
    else:
        body = html_or_text
    body = _WHITESPACE_RE.sub(" ", body)
    body = "\n".join(line.strip() for line in body.splitlines())
    body = _BLANK_LINE_RE.sub("\n\n", body).strip()
    if title:
        body = f"# {title}\n\n{body}"
    return title, body


__all__ = [
    "DEFAULT_MAX_CHARS",
    "FetchOutcome",
    "fetch_url_as_markdown",
]
