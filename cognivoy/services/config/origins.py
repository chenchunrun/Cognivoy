from __future__ import annotations

import re
from typing import Any, Iterable
from urllib.parse import urlparse, urlsplit

_ORIGIN_SEPARATORS = re.compile(r"[,;\n]+")


def _raw_origin_items(value: Any) -> Iterable[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        items: list[str] = []
        for item in value:
            items.extend(_raw_origin_items(item))
        return items
    return _ORIGIN_SEPARATORS.split(str(value))


def normalize_origin(value: Any) -> str:
    """Normalize a browser Origin value for CORS allowlists.

    Operators often paste values as ``host:port`` or separate multiple origins
    with semicolons. Browsers always send an Origin as ``scheme://host[:port]``.
    This helper makes common deployment input tolerant while keeping the output
    as exact origins for Starlette's CORSMiddleware.
    """

    origin = str(value or "").strip().rstrip("/")
    if not origin:
        return ""
    if origin in {"*", "null"}:
        return origin
    if "://" not in origin:
        origin = f"http://{origin}"

    try:
        parsed = urlparse(origin)
    except ValueError:
        return origin
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        return f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    return origin


def normalize_origins(value: Any) -> list[str]:
    origins: list[str] = []
    seen: set[str] = set()
    for raw in _raw_origin_items(value):
        origin = normalize_origin(raw)
        if origin and origin not in seen:
            origins.append(origin)
            seen.add(origin)
    return origins


def canonical_browser_origin(value: Any) -> str:
    """Return a strict browser origin or ``""`` for malformed input.

    Unlike :func:`normalize_origin`, this is for request headers rather than
    operator-entered settings: paths, credentials, queries and fragments are
    rejected instead of being helpfully discarded.
    """

    try:
        parsed = urlsplit(str(value or "").strip())
    except ValueError:
        return ""
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        return ""
    host = parsed.hostname
    if not host:
        return ""
    try:
        port = parsed.port
    except ValueError:
        return ""
    default_port = 80 if parsed.scheme == "http" else 443
    authority = host.lower() if port in {None, default_port} else f"{host.lower()}:{port}"
    return f"{parsed.scheme}://{authority}"


def browser_allowed_origins(system_settings: dict[str, Any]) -> list[str]:
    """Build the exact browser-origin allowlist shared by HTTP and WebSocket."""

    frontend_port = str(system_settings["frontend_port"])
    origins = [
        f"http://localhost:{frontend_port}",
        f"http://127.0.0.1:{frontend_port}",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ]
    for origin in normalize_origins(
        [system_settings.get("cors_origin"), system_settings.get("cors_origins")]
    ):
        canonical = canonical_browser_origin(origin)
        if canonical and canonical not in origins:
            origins.append(canonical)
    return origins


__all__ = [
    "browser_allowed_origins",
    "canonical_browser_origin",
    "normalize_origin",
    "normalize_origins",
]
