"""Bounded HTTP downloads with redirect validation and DNS-pinned connections."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from cognivoy.services.config.network_policy import (
    OutboundNetworkDisabledError,
    require_outbound_network,
)
from cognivoy.utils.network.public_url import pin_public_http_url, validate_public_http_url

_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})
_SENSITIVE_HEADERS = frozenset({"authorization", "cookie", "proxy-authorization"})


class PublicHttpError(RuntimeError):
    pass


def _record_network_denial(feature: str, target: str) -> None:
    # Lazy import avoids pulling the runtime and multi-user layers into this
    # low-level network module during bootstrap.
    from cognivoy.runtime.control_plane import record_network_policy_denial

    record_network_policy_denial(feature, target)


@dataclass(frozen=True, slots=True)
class PublicHttpResponse:
    content: bytes
    content_type: str
    final_url: str
    status_code: int


def _origin(url: str) -> tuple[str, str, int | None]:
    parsed = urlparse(url)
    return parsed.scheme.lower(), (parsed.hostname or "").lower(), parsed.port


def _redirect_headers(headers: dict[str, str], source: str, target: str) -> dict[str, str]:
    if _origin(source) == _origin(target):
        return dict(headers)
    return {key: value for key, value in headers.items() if key.lower() not in _SENSITIVE_HEADERS}


def _request_target(
    url: str,
    *,
    pin: bool,
    host_validator: Any,
    target_pinner: Any,
) -> tuple[str, dict[str, str], dict[str, Any]]:
    if pin:
        pinner = target_pinner or pin_public_http_url
        pinned, error = pinner(url)
        if pinned is None:
            raise PublicHttpError(error)
        return (
            pinned.connect_url,
            {"Host": pinned.host_header},
            {"sni_hostname": pinned.sni_hostname},
        )
    allowed, error = validate_public_http_url(url, host_validator=host_validator)
    if not allowed:
        raise PublicHttpError(error)
    return url, {}, {}


def _client_kwargs(timeout: float, proxy: str | None) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "timeout": timeout,
        "limits": httpx.Limits(max_connections=10, max_keepalive_connections=0),
        "trust_env": False,
    }
    if proxy:
        kwargs["proxy"] = proxy
    return kwargs


async def fetch_public_bytes(
    url: str,
    *,
    feature: str,
    max_bytes: int,
    timeout_seconds: float = 30.0,
    headers: dict[str, str] | None = None,
    max_redirects: int = 5,
    client_factory: Any = None,
    host_validator: Any = None,
    target_pinner: Any = None,
) -> PublicHttpResponse:
    """Download an untrusted public URL without DNS or redirect SSRF gaps."""
    try:
        policy = require_outbound_network(feature)
    except OutboundNetworkDisabledError:
        _record_network_denial(feature, url)
        raise
    timeout = min(float(timeout_seconds), float(policy.timeout_seconds))
    factory = client_factory or (lambda **kwargs: httpx.AsyncClient(**kwargs))
    kwargs = {"timeout": timeout}
    if client_factory is None:
        kwargs = _client_kwargs(timeout, policy.proxy)
    current_url = str(url or "").strip()
    current_headers = dict(headers or {})

    async with factory(**kwargs) as client:
        for redirect_count in range(max_redirects + 1):
            try:
                request_url, pinned_headers, extensions = _request_target(
                    current_url,
                    pin=client_factory is None or target_pinner is not None,
                    host_validator=host_validator,
                    target_pinner=target_pinner,
                )
            except PublicHttpError as exc:
                _record_network_denial(feature, current_url)
                prefix = "Redirect blocked: " if redirect_count else ""
                raise PublicHttpError(prefix + str(exc)) from exc
            hop_headers = {**current_headers, **pinned_headers}
            async with client.stream(
                "GET",
                request_url,
                headers=hop_headers,
                follow_redirects=False,
                extensions=extensions or None,
            ) as response:
                if response.status_code in _REDIRECT_STATUSES:
                    location = str(response.headers.get("location") or "").strip()
                    if not location:
                        raise PublicHttpError(
                            f"HTTP {response.status_code} redirect without Location"
                        )
                    if redirect_count >= max_redirects:
                        raise PublicHttpError("Too many redirects")
                    next_url = urljoin(current_url, location)
                    current_headers = _redirect_headers(current_headers, current_url, next_url)
                    current_url = next_url
                    continue
                if response.status_code >= 400:
                    raise PublicHttpError(f"HTTP {response.status_code} from {current_url}")
                declared = response.headers.get("content-length")
                if declared:
                    try:
                        if int(declared) > max_bytes:
                            raise PublicHttpError("Response exceeds the configured size limit")
                    except ValueError:
                        pass
                content = bytearray()
                async for chunk in response.aiter_bytes():
                    content.extend(chunk)
                    if len(content) > max_bytes:
                        raise PublicHttpError("Response exceeds the configured size limit")
                return PublicHttpResponse(
                    content=bytes(content),
                    content_type=(response.headers.get("content-type") or "")
                    .split(";", 1)[0]
                    .strip()
                    .lower(),
                    final_url=current_url,
                    status_code=response.status_code,
                )
    raise PublicHttpError("Download ended without a response")


def fetch_public_bytes_sync(
    url: str,
    *,
    feature: str,
    max_bytes: int,
    timeout_seconds: float = 30.0,
    headers: dict[str, str] | None = None,
    max_redirects: int = 5,
    client_factory: Any = None,
    host_validator: Any = None,
    target_pinner: Any = None,
) -> PublicHttpResponse:
    """Synchronous counterpart for parsing engines that run in worker threads."""
    try:
        policy = require_outbound_network(feature)
    except OutboundNetworkDisabledError:
        _record_network_denial(feature, url)
        raise
    timeout = min(float(timeout_seconds), float(policy.timeout_seconds))
    factory = client_factory or (lambda **kwargs: httpx.Client(**kwargs))
    kwargs = {"timeout": timeout}
    if client_factory is None:
        kwargs = _client_kwargs(timeout, policy.proxy)
    current_url = str(url or "").strip()
    current_headers = dict(headers or {})

    with factory(**kwargs) as client:
        for redirect_count in range(max_redirects + 1):
            try:
                request_url, pinned_headers, extensions = _request_target(
                    current_url,
                    pin=client_factory is None or target_pinner is not None,
                    host_validator=host_validator,
                    target_pinner=target_pinner,
                )
            except PublicHttpError as exc:
                _record_network_denial(feature, current_url)
                prefix = "Redirect blocked: " if redirect_count else ""
                raise PublicHttpError(prefix + str(exc)) from exc
            hop_headers = {**current_headers, **pinned_headers}
            with client.stream(
                "GET",
                request_url,
                headers=hop_headers,
                follow_redirects=False,
                extensions=extensions or None,
            ) as response:
                if response.status_code in _REDIRECT_STATUSES:
                    location = str(response.headers.get("location") or "").strip()
                    if not location:
                        raise PublicHttpError(
                            f"HTTP {response.status_code} redirect without Location"
                        )
                    if redirect_count >= max_redirects:
                        raise PublicHttpError("Too many redirects")
                    next_url = urljoin(current_url, location)
                    current_headers = _redirect_headers(current_headers, current_url, next_url)
                    current_url = next_url
                    continue
                if response.status_code >= 400:
                    raise PublicHttpError(f"HTTP {response.status_code} from {current_url}")
                declared = response.headers.get("content-length")
                if declared:
                    try:
                        if int(declared) > max_bytes:
                            raise PublicHttpError("Response exceeds the configured size limit")
                    except ValueError:
                        pass
                content = bytearray()
                for chunk in response.iter_bytes():
                    content.extend(chunk)
                    if len(content) > max_bytes:
                        raise PublicHttpError("Response exceeds the configured size limit")
                return PublicHttpResponse(
                    content=bytes(content),
                    content_type=(response.headers.get("content-type") or "")
                    .split(";", 1)[0]
                    .strip()
                    .lower(),
                    final_url=current_url,
                    status_code=response.status_code,
                )
    raise PublicHttpError("Download ended without a response")


def put_public_bytes_sync(
    url: str,
    content: bytes,
    *,
    feature: str,
    timeout_seconds: float = 300.0,
    headers: dict[str, str] | None = None,
    client_factory: Any = None,
    host_validator: Any = None,
    target_pinner: Any = None,
) -> int:
    """Upload bytes to one pinned public URL; redirects are never followed."""
    try:
        policy = require_outbound_network(feature)
    except OutboundNetworkDisabledError:
        _record_network_denial(feature, url)
        raise
    timeout = min(float(timeout_seconds), float(policy.timeout_seconds))
    factory = client_factory or (lambda **kwargs: httpx.Client(**kwargs))
    kwargs = {"timeout": timeout}
    if client_factory is None:
        kwargs = _client_kwargs(timeout, policy.proxy)
    original_url = str(url or "").strip()
    try:
        request_url, pinned_headers, extensions = _request_target(
            original_url,
            pin=client_factory is None or target_pinner is not None,
            host_validator=host_validator,
            target_pinner=target_pinner,
        )
    except PublicHttpError as exc:
        _record_network_denial(feature, original_url)
        raise PublicHttpError(f"Upload target blocked: {exc}") from exc

    with factory(**kwargs) as client:
        with client.stream(
            "PUT",
            request_url,
            content=content,
            headers={**(headers or {}), **pinned_headers},
            follow_redirects=False,
            extensions=extensions or None,
        ) as response:
            if response.status_code in _REDIRECT_STATUSES:
                _record_network_denial(feature, original_url)
                raise PublicHttpError("Upload redirect refused")
            if response.status_code >= 400:
                raise PublicHttpError(f"HTTP {response.status_code} from upload target")
            # Drain the usually-empty response so the transport closes cleanly.
            for _chunk in response.iter_bytes():
                pass
            return response.status_code


__all__ = [
    "PublicHttpError",
    "PublicHttpResponse",
    "fetch_public_bytes",
    "fetch_public_bytes_sync",
    "put_public_bytes_sync",
]
