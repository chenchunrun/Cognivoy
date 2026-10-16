"""Shared HTTP plumbing for media-generation providers (imagegen / videogen).

Image- and video-generation endpoints across OpenAI, Volcengine Ark (Seedream /
Seedance) and compatible gateways share the same auth + base-URL conventions as
the rest of the OpenAI-compatible cluster. This module factors out the few
helpers both generation services need so each adapter stays thin.

Voice keeps its own copy in ``services/voice/base.py`` — this module is
deliberately scoped to image/video generation rather than refactoring voice.
"""

from __future__ import annotations

import base64
import binascii

import httpx

from cognivoy.services.config.network_policy import OutboundNetworkDisabledError
from cognivoy.utils.network.safe_http import PublicHttpError, fetch_public_bytes

MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024
MAX_GENERATED_VIDEO_BYTES = 256 * 1024 * 1024

# Auth header styles understood by the generation adapters.
AUTH_BEARER = "bearer"  # Authorization: Bearer <key>  (OpenAI, Volcengine, gateways)
AUTH_API_KEY_HEADER = "api_key_header"  # api-key: <key>  (Azure OpenAI)


class GenerationProviderError(RuntimeError):
    """Raised when an image/video provider request fails or is misconfigured."""


def build_auth_headers(auth_style: str, api_key: str) -> dict[str, str]:
    """Map an ``auth_style`` + key onto request headers.

    ``bearer`` (default) → ``Authorization: Bearer``; ``api_key_header`` →
    ``api-key`` (Azure OpenAI).
    """
    if not api_key:
        return {}
    if auth_style == AUTH_API_KEY_HEADER:
        return {"api-key": api_key}
    return {"Authorization": f"Bearer {api_key}"}


def join_api_path(base_url: str, suffix: str) -> str:
    """Append an OpenAI-style path to a configured API base.

    ``base_url`` is the API base (e.g. ``https://api.openai.com/v1`` or
    ``https://ark.cn-beijing.volces.com/api/v3``); ``suffix`` is the relative
    path (e.g. ``images/generations``). If the admin already pasted a full
    endpoint ending in ``suffix`` it is returned verbatim, query string kept.
    """
    base = (base_url or "").strip()
    if not base:
        raise GenerationProviderError("No endpoint URL configured for this provider.")
    head, sep, query = base.partition("?")
    norm_suffix = suffix.strip("/")
    if head.rstrip("/").endswith(norm_suffix):
        return base
    joined = f"{head.rstrip('/')}/{norm_suffix}"
    return f"{joined}?{query}" if sep else joined


def raise_for_provider(resp: httpx.Response, action: str) -> None:
    """Surface a provider error with a trimmed body for diagnostics."""
    if resp.status_code < 400:
        return
    detail = (resp.text or "").strip()[:400]
    raise GenerationProviderError(
        f"{action} failed with HTTP {resp.status_code}" + (f": {detail}" if detail else ".")
    )


def decode_generated_base64(value: str, *, max_bytes: int, action: str) -> bytes:
    """Strictly decode a provider payload without allowing unbounded allocation."""
    encoded = str(value or "").strip()
    max_encoded = ((max_bytes + 2) // 3) * 4
    if not encoded or len(encoded) > max_encoded:
        raise GenerationProviderError(f"{action} exceeds the configured size limit.")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise GenerationProviderError(f"{action} returned invalid base64 data.") from exc
    if len(content) > max_bytes:
        raise GenerationProviderError(f"{action} exceeds the configured size limit.")
    return content


async def download_generated_media(
    url: str,
    *,
    media_kind: str,
    max_bytes: int,
    timeout_seconds: float,
) -> tuple[bytes, str]:
    """Download a provider-returned public URL through the shared SSRF guard."""
    try:
        response = await fetch_public_bytes(
            url,
            feature=f"{media_kind} generation download",
            max_bytes=max_bytes,
            timeout_seconds=timeout_seconds,
        )
    except (PublicHttpError, OutboundNetworkDisabledError) as exc:
        raise GenerationProviderError(f"{media_kind.title()} download blocked: {exc}") from exc

    content_type = response.content_type
    if content_type and content_type != "application/octet-stream":
        if not content_type.startswith(f"{media_kind}/"):
            raise GenerationProviderError(
                f"{media_kind.title()} download returned unsupported content type: {content_type}."
            )
    return (
        response.content,
        content_type or f"{media_kind}/{'png' if media_kind == 'image' else 'mp4'}",
    )


__all__ = [
    "AUTH_BEARER",
    "AUTH_API_KEY_HEADER",
    "GenerationProviderError",
    "MAX_GENERATED_IMAGE_BYTES",
    "MAX_GENERATED_VIDEO_BYTES",
    "build_auth_headers",
    "decode_generated_base64",
    "download_generated_media",
    "join_api_path",
    "raise_for_provider",
]
