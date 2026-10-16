"""Bounded recovery for transient search-provider transport failures."""

from __future__ import annotations

import logging
import time
from typing import Any

from .base import BaseSearchProvider
from .types import WebSearchResponse

_logger = logging.getLogger(__name__)
_MAX_ATTEMPTS = 2
_RETRY_DELAY_SECONDS = 0.25


class SearchProviderError(RuntimeError):
    """Safe diagnostic suitable for tool output; never contains provider bodies."""

    def __init__(self, provider: str, category: str, attempts: int):
        self.provider = provider
        self.category = category
        self.attempts = attempts
        super().__init__(
            f"{provider} search failed ({category}; {attempts} attempt(s)). "
            "Check the search provider and outbound-network settings."
        )


def _failure_category(exc: Exception) -> str:
    # ddgs wraps native transport failures in DDGSException, so inspect the
    # message as well as the type. Never retry certificate validation failures
    # (including when wrapped as a connection error), or relax TLS verification.
    message = str(exc).lower()
    kind = type(exc).__name__.lower()
    if any(
        marker in message for marker in ("certificate", "cert_verify", "unknown ca", "self signed")
    ):
        return "tls_verification"
    if isinstance(exc, (ValueError, ImportError)):
        return "configuration"
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None) or getattr(exc, "status_code", None)
    if status in (401, 403):
        return "authentication"
    if status == 429 or "ratelimit" in kind or "rate limit" in message:
        return "rate_limited"
    if status in (502, 503, 504):
        return "unavailable"
    if (
        isinstance(exc, TimeoutError)
        or "timeout" in kind
        or any(marker in message for marker in ("timed out", "timeout"))
    ):
        return "timeout"
    if isinstance(exc, ConnectionError) or any(
        marker in message
        for marker in (
            "connection reset",
            "connection refused",
            "connection aborted",
            "socket hang up",
            "unexpected eof",
            "handshake eof",
            "peer closed",
            "dns error",
            "dnserror",
        )
    ):
        return "connection"
    if message.strip().rstrip(".") == "no results found":
        # ddgs raises instead of returning an empty list when all selected
        # engines finish without usable hits. This is not a transport failure.
        return "no_results"
    return "provider_error"


def search_with_recovery(
    provider: BaseSearchProvider, query: str, kwargs: dict[str, Any]
) -> WebSearchResponse:
    """Retry a keyless search once, using only its remaining network budget.

    Paid/answer-generating providers are not automatically replayed. The
    existing killable worker remains the hard timeout and cancellation boundary;
    no detached threads, background retries, proxy bypass or provider switch.
    """
    deadline = time.monotonic() + float(kwargs["timeout"])
    if provider.name == "duckduckgo":
        # Reserve room for one fresh transport attempt instead of spending the
        # entire budget on the first connection. ddgs is restricted to two
        # engines by DuckDuckGoProvider, so this isn't multiplied across an
        # unbounded sequence of metasearch backends.
        kwargs = {**kwargs, "timeout": max(1, int(kwargs["timeout"] / _MAX_ATTEMPTS))}
    attempts = 0
    while True:
        attempts += 1
        try:
            response = provider.search(query, **kwargs)
            response.metadata["search_attempts"] = attempts
            return response
        except Exception as exc:
            category = _failure_category(exc)
            remaining = deadline - time.monotonic()
            if (
                provider.name != "duckduckgo"
                or attempts >= _MAX_ATTEMPTS
                or category not in {"connection", "timeout", "unavailable"}
                or remaining < 1 + _RETRY_DELAY_SECONDS
            ):
                _logger.warning(
                    "[%s] Search failed: category=%s attempts=%s",
                    provider.name,
                    category,
                    attempts,
                )
                raise SearchProviderError(provider.name, category, attempts) from exc
            _logger.info("[%s] Retrying transient search failure: %s", provider.name, category)
            time.sleep(_RETRY_DELAY_SECONDS)
            # Floor to whole seconds for ddgs/native-client compatibility. A
            # fresh DDGS instance is created by the provider on each attempt.
            kwargs = {**kwargs, "timeout": int(deadline - time.monotonic())}
            if kwargs["timeout"] < 1:
                raise SearchProviderError(provider.name, category, attempts) from exc
