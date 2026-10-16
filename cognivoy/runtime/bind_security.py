"""Network bind policy shared by local launch entry points."""

from __future__ import annotations

import ipaddress


def is_loopback_bind(host: str) -> bool:
    """Return whether a bind address is restricted to the local machine."""
    normalized = host.strip().strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def require_authenticated_remote_bind(host: str, *, auth_enabled: bool) -> None:
    """Reject network-visible binds when Cognivoy authentication is disabled."""
    if not is_loopback_bind(host) and not auth_enabled:
        raise RuntimeError(
            "Refusing a non-loopback bind while authentication is disabled. "
            "Enable auth first, or bind to 127.0.0.1 and use a secured reverse proxy."
        )


__all__ = ["is_loopback_bind", "require_authenticated_remote_bind"]
