"""Image processing utilities - URL download and format conversion."""

import base64
import logging
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx

from cognivoy.services.config.network_policy import (
    OutboundNetworkDisabledError,
    require_outbound_network,
)
from cognivoy.utils.network.public_url import pin_public_http_url, validate_public_http_url

logger = logging.getLogger(__name__)

# Supported image MIME types
SUPPORTED_IMAGE_TYPES = {
    "image/jpeg": "jpeg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
}

# Maximum image size (10MB)
MAX_IMAGE_SIZE = 10 * 1024 * 1024

# Request timeout (seconds)
REQUEST_TIMEOUT = 30
MAX_REDIRECTS = 5
REDIRECT_STATUSES = {301, 302, 303, 307, 308}


class ImageError(Exception):
    """Image processing error."""

    pass


def is_valid_image_url(url: str) -> bool:
    """Check if a URL is valid for images.

    Args:
        url: URL to check

    Returns:
        True if valid URL format
    """
    try:
        parsed = urlparse(url)
        return (
            parsed.scheme in ("http", "https")
            and bool(parsed.netloc)
            and parsed.username is None
            and parsed.password is None
        )
    except Exception:
        return False


def is_base64_image(data: str) -> bool:
    """Check if data is base64 encoded image.

    Args:
        data: Data to check

    Returns:
        True if data:image/...;base64,... format
    """
    return data.startswith("data:image/") and ";base64," in data


async def fetch_image_from_url(
    url: str,
    *,
    client_factory: Any = None,
    host_validator: Any = None,
    target_pinner: Any = None,
) -> tuple[bytes, str]:
    """Download image from URL.

    Args:
        url: Image URL

    Returns:
        (image bytes, MIME type)

    Raises:
        ImageError: If download fails or format unsupported
    """
    pin_connections = client_factory is None or target_pinner is not None
    preflight_validator = (lambda _host: False) if pin_connections else host_validator
    allowed, validation_error = validate_public_http_url(url, host_validator=preflight_validator)
    if not allowed:
        from cognivoy.runtime.control_plane import record_network_policy_denial

        record_network_policy_denial("remote image download", url)
        raise ImageError(validation_error)

    logger.info("Fetching remote image host=%s", urlparse(url).hostname)

    try:
        network_policy = require_outbound_network("remote image download")
    except OutboundNetworkDisabledError as exc:
        from cognivoy.runtime.control_plane import record_network_policy_denial

        record_network_policy_denial("remote image download", url)
        raise ImageError(str(exc)) from exc

    effective_timeout = min(float(REQUEST_TIMEOUT), float(network_policy.timeout_seconds))
    factory = client_factory or _default_image_client_factory
    factory_kwargs: dict[str, Any] = {"timeout": effective_timeout}
    if client_factory is None:
        factory_kwargs["proxy"] = network_policy.proxy

    try:
        async with factory(**factory_kwargs) as client:
            current_url = url
            for redirect_count in range(MAX_REDIRECTS + 1):
                allowed, validation_error = validate_public_http_url(
                    current_url, host_validator=preflight_validator
                )
                if not allowed:
                    from cognivoy.runtime.control_plane import record_network_policy_denial

                    record_network_policy_denial("remote image download", current_url)
                    raise ImageError(validation_error)
                request_url = current_url
                request_headers: dict[str, str] = {}
                request_extensions: dict[str, Any] = {}
                if pin_connections:
                    pinner = target_pinner or pin_public_http_url
                    pinned, pin_error = pinner(current_url)
                    if pinned is None:
                        from cognivoy.runtime.control_plane import record_network_policy_denial

                        record_network_policy_denial("remote image download", current_url)
                        raise ImageError(pin_error)
                    request_url = pinned.connect_url
                    request_headers["Host"] = pinned.host_header
                    request_extensions["sni_hostname"] = pinned.sni_hostname
                async with client.stream(
                    "GET",
                    request_url,
                    headers=request_headers,
                    follow_redirects=False,
                    extensions=request_extensions or None,
                ) as response:
                    final_url = current_url
                    if response.status_code in REDIRECT_STATUSES:
                        location = str(response.headers.get("location") or "").strip()
                        if not location:
                            raise ImageError(
                                f"HTTP {response.status_code} redirect without Location"
                            )
                        if redirect_count >= MAX_REDIRECTS:
                            raise ImageError("Too many image download redirects")
                        next_url = urljoin(final_url, location)
                        allowed, validation_error = validate_public_http_url(
                            next_url, host_validator=preflight_validator
                        )
                        if not allowed:
                            from cognivoy.runtime.control_plane import record_network_policy_denial

                            record_network_policy_denial("remote image download", next_url)
                            raise ImageError("Redirect blocked: " + validation_error)
                        current_url = next_url
                        continue
                    if response.status_code >= 400:
                        raise ImageError(f"Failed to download image: HTTP {response.status_code}")

                    content_type = (
                        response.headers.get("content-type", "").split(";")[0].strip().lower()
                    )

                    if not content_type or content_type == "application/octet-stream":
                        content_type = guess_image_type_from_url(final_url)

                    if content_type not in SUPPORTED_IMAGE_TYPES:
                        raise ImageError(f"Unsupported image format: {content_type}")

                    declared_size = response.headers.get("content-length")
                    if declared_size:
                        try:
                            if int(declared_size) > MAX_IMAGE_SIZE:
                                raise ImageError("Image exceeds the 10MB size limit")
                        except ValueError:
                            pass
                    content = await _bounded_image_read(response)
                    break

            logger.info(
                "Image fetched successfully: %d bytes, type: %s", len(content), content_type
            )

            return content, content_type

    except httpx.TimeoutException:
        raise ImageError(f"Image download timeout ({REQUEST_TIMEOUT}s)")
    except httpx.RequestError as e:
        raise ImageError(f"Failed to download image: {e!s}")


def _default_image_client_factory(*, timeout: float, proxy: str | None = None) -> httpx.AsyncClient:
    kwargs: dict[str, Any] = {
        "timeout": timeout,
        "limits": httpx.Limits(max_connections=10, max_keepalive_connections=0),
        "trust_env": False,
    }
    if proxy:
        kwargs["proxy"] = proxy
    return httpx.AsyncClient(**kwargs)


async def _bounded_image_read(response: httpx.Response) -> bytes:
    content = bytearray()
    async for chunk in response.aiter_bytes():
        content.extend(chunk)
        if len(content) > MAX_IMAGE_SIZE:
            raise ImageError("Image exceeds the 10MB size limit")
    return bytes(content)


def guess_image_type_from_url(url: str) -> str:
    """Infer image type from URL.

    Args:
        url: Image URL

    Returns:
        Inferred MIME type
    """
    url_lower = url.lower()

    if ".png" in url_lower:
        return "image/png"
    elif ".jpg" in url_lower or ".jpeg" in url_lower:
        return "image/jpeg"
    elif ".gif" in url_lower:
        return "image/gif"
    elif ".webp" in url_lower:
        return "image/webp"
    else:
        # Default to JPEG
        return "image/jpeg"


def image_bytes_to_base64(content: bytes, mime_type: str) -> str:
    """Convert image bytes to base64 data URL.

    Args:
        content: Image binary data
        mime_type: MIME type

    Returns:
        data:image/...;base64,... format string
    """
    b64_data = base64.b64encode(content).decode("utf-8")
    result = f"data:{mime_type};base64,{b64_data}"

    logger.debug(f"image_bytes_to_base64: input={len(content)} bytes, output={len(b64_data)} chars")

    return result


async def url_to_base64(url: str) -> str:
    """Convert image URL to base64 data URL.

    Args:
        url: Image URL

    Returns:
        data:image/...;base64,... format string

    Raises:
        ImageError: If download or conversion fails
    """
    content, mime_type = await fetch_image_from_url(url)
    return image_bytes_to_base64(content, mime_type)


async def resolve_image_input(
    image_base64: str | None = None,
    image_url: str | None = None,
) -> str | None:
    """Resolve image input to base64 format.

    Prioritizes image_base64, falls back to downloading from image_url.

    Args:
        image_base64: Base64 format image data
        image_url: Image URL

    Returns:
        Base64 format image data, or None if no image

    Raises:
        ImageError: If URL download or conversion fails
    """
    logger.debug(
        f"resolve_image_input: base64={'yes' if image_base64 else 'no'}, url={image_url or 'none'}"
    )

    # Prefer base64
    if image_base64:
        if is_base64_image(image_base64):
            logger.debug("Using provided base64 image")
            return image_base64
        else:
            logger.error("Invalid base64 image format")
            raise ImageError("Invalid base64 image format, should be data:image/...;base64,...")

    # Try to download from URL
    if image_url:
        logger.debug("Downloading image from URL")
        result = await url_to_base64(image_url)
        logger.debug(f"Download complete, base64 length: {len(result)}")
        return result

    logger.debug("No image provided")
    return None
