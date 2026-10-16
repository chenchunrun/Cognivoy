"""Fail-closed validation for untrusted public HTTP(S) targets."""

from __future__ import annotations

from dataclasses import dataclass
import ipaddress
import socket
from typing import Any
from urllib.parse import urlparse

import httpx

PUBLIC_HTTP_SCHEMES = frozenset({"http", "https"})
MAX_PUBLIC_URL_LENGTH = 8192


@dataclass(frozen=True, slots=True)
class PinnedHttpTarget:
    """A validated public URL whose connection address cannot change."""

    original_url: str
    connect_url: str
    host_header: str
    sni_hostname: str
    resolved_ip: str


def _normalise_ip(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> ipaddress.IPv4Address | ipaddress.IPv6Address:
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def is_disallowed_public_host(host: str, *, resolver: Any = None) -> bool:
    """Return true unless every resolved address is globally routable."""
    candidate = str(host or "").strip().strip("[]").rstrip(".")
    if not candidate:
        return True
    lower = candidate.lower()
    if lower in {"localhost", "ip6-localhost", "ip6-loopback"} or lower.endswith(".local"):
        return True
    try:
        return not _normalise_ip(ipaddress.ip_address(candidate)).is_global
    except ValueError:
        pass

    resolve = resolver or socket.getaddrinfo
    try:
        infos = resolve(candidate, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
    except OSError:
        return True
    addresses = []
    for info in infos:
        try:
            addresses.append(_normalise_ip(ipaddress.ip_address(info[4][0])))
        except (IndexError, ValueError):
            return True
    return not addresses or any(not address.is_global for address in addresses)


def pin_public_http_url(url: str, *, resolver: Any = None) -> tuple[PinnedHttpTarget | None, str]:
    """Resolve and pin one public address while preserving Host and TLS SNI.

    Every DNS answer must be globally routable. The returned ``connect_url``
    contains the selected numeric address, eliminating a second resolver call
    between policy validation and the TCP connection.
    """
    allowed, error = validate_public_http_url(url, host_validator=lambda _host: False)
    if not allowed:
        return None, error
    parsed = urlparse(url)
    hostname = (parsed.hostname or "").strip().rstrip(".")
    candidate = hostname.strip("[]")
    try:
        port = parsed.port
    except ValueError:
        return None, "URL contains an invalid port."
    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    try:
        addresses = [_normalise_ip(ipaddress.ip_address(candidate))]
    except ValueError:
        resolve = resolver or socket.getaddrinfo
        try:
            infos = resolve(candidate, port, socket.AF_UNSPEC, socket.SOCK_STREAM)
        except OSError:
            return None, f"Cannot resolve hostname: {hostname}."
        seen: set[str] = set()
        for info in infos:
            try:
                address = _normalise_ip(ipaddress.ip_address(info[4][0]))
            except (IndexError, ValueError):
                return None, f"Hostname returned an invalid address: {hostname}."
            if str(address) not in seen:
                seen.add(str(address))
                addresses.append(address)
    if not addresses:
        return None, f"Hostname returned no usable addresses: {hostname}."
    for address in addresses:
        if not address.is_global:
            return None, (
                f"Refusing to fetch private/loopback/non-public host: {hostname} "
                f"resolved to {address}."
            )

    selected = addresses[0]
    try:
        original = httpx.URL(url)
    except httpx.InvalidURL:
        return None, "Malformed URL."
    connect_url = str(original.copy_with(host=str(selected)))
    raw_host = original.raw_host.decode("ascii").rstrip(".")
    host_header = f"[{raw_host}]" if ":" in raw_host else raw_host
    if original.port is not None:
        host_header = f"{host_header}:{original.port}"
    return (
        PinnedHttpTarget(
            original_url=str(original),
            connect_url=connect_url,
            host_header=host_header,
            sni_hostname=raw_host,
            resolved_ip=str(selected),
        ),
        "",
    )


def validate_public_http_url(url: str, *, host_validator: Any = None) -> tuple[bool, str]:
    """Validate syntax, credentials, and the current DNS target of a URL."""
    raw_url = str(url or "")
    if len(raw_url) > MAX_PUBLIC_URL_LENGTH:
        return False, "URL is too long."
    if "\\" in raw_url or any(ord(char) < 32 or ord(char) == 127 for char in raw_url):
        return False, "URL contains unsafe characters."
    try:
        parsed = urlparse(raw_url)
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").strip()
    except (TypeError, ValueError):
        return False, "Malformed URL."
    if scheme not in PUBLIC_HTTP_SCHEMES:
        return False, f"Unsupported URL scheme: {scheme or '(empty)'}. Use http:// or https://."
    if not host:
        return False, "URL is missing a host."
    if parsed.username is not None or parsed.password is not None:
        return False, "URLs containing embedded credentials are not allowed."
    try:
        parsed.port
    except ValueError:
        return False, "URL contains an invalid port."
    if "%" in host:
        return False, "URL host contains invalid escaping."
    validator = host_validator or is_disallowed_public_host
    if validator(host):
        return False, f"Refusing to fetch private/loopback/non-public host: {host}."
    return True, ""


__all__ = [
    "PUBLIC_HTTP_SCHEMES",
    "MAX_PUBLIC_URL_LENGTH",
    "PinnedHttpTarget",
    "is_disallowed_public_host",
    "pin_public_http_url",
    "validate_public_http_url",
]
