"""Safe response policy for user-controlled files.

Files served from attachment and generated-output stores are untrusted.  In
particular, HTML/SVG/XML/JavaScript must never execute in Cognivoy's own origin.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from urllib.parse import quote

_ACTIVE_SUFFIXES = {
    ".cjs",
    ".htm",
    ".html",
    ".js",
    ".mjs",
    ".svg",
    ".xhtml",
    ".xml",
}
_ACTIVE_MEDIA_TYPES = {
    "application/javascript",
    "application/xhtml+xml",
    "application/xml",
    "image/svg+xml",
    "text/html",
    "text/javascript",
    "text/xml",
}


def untrusted_file_policy(path: Path) -> tuple[str, str, dict[str, str]]:
    """Return ``(media_type, disposition, headers)`` for an untrusted file."""

    guessed, _ = mimetypes.guess_type(path.name)
    media_type = guessed or "application/octet-stream"
    active = path.suffix.lower() in _ACTIVE_SUFFIXES or media_type in _ACTIVE_MEDIA_TYPES
    headers = {
        "Cache-Control": "private, max-age=0, must-revalidate",
        "X-Content-Type-Options": "nosniff",
        # This is defense in depth for browsers that inspect downloaded files.
        "Content-Security-Policy": "default-src 'none'; sandbox",
    }
    if active:
        return "application/octet-stream", "attachment", headers
    return media_type, "inline", headers


def content_disposition(filename: str, disposition: str) -> str:
    """Build an injection-safe, Unicode-compatible disposition header."""

    fallback = filename.encode("ascii", errors="replace").decode("ascii")
    fallback = fallback.replace('"', "_").replace("\\", "_")
    return f"{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


__all__ = ["content_disposition", "untrusted_file_policy"]
