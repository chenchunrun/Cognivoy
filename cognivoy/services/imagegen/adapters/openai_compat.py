"""OpenAI-compatible image-generation adapter.

Covers OpenAI DALL·E / gpt-image, Volcengine Ark Seedream and any gateway that
exposes ``POST {base}/images/generations``. Handles both response shapes —
``data[].b64_json`` (preferred: bytes inline) and ``data[].url`` (downloaded) —
so the caller always receives raw bytes and never has to deal with expiring
provider URLs.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from cognivoy.services.generation_http import (
    MAX_GENERATED_IMAGE_BYTES,
    GenerationProviderError,
    build_auth_headers,
    decode_generated_base64,
    download_generated_media,
    join_api_path,
    raise_for_provider,
)
from cognivoy.services.imagegen.base import BaseImagegenAdapter
from cognivoy.services.imagegen.config import ImagegenConfig

logger = logging.getLogger(__name__)


class OpenAICompatImagegenAdapter(BaseImagegenAdapter):
    """POST ``{base}/images/generations`` with a JSON body, returning image bytes."""

    async def generate(
        self, prompt: str, config: ImagegenConfig, *, n: int = 1
    ) -> list[tuple[bytes, str]]:
        if not config.base_url:
            raise GenerationProviderError("No endpoint URL configured for image generation.")
        url = join_api_path(config.base_url, "images/generations")
        headers = {
            "Content-Type": "application/json",
            **build_auth_headers(config.auth_style, config.api_key),
            **(config.extra_headers or {}),
        }
        payload: dict[str, Any] = {"model": config.model, "prompt": prompt, "n": max(1, n)}
        if config.size:
            payload["size"] = config.size
        if config.quality:
            payload["quality"] = config.quality
        if config.style:
            payload["style"] = config.style
        if config.response_format:
            payload["response_format"] = config.response_format

        logger.debug(
            "imagegen url=%s model=%s n=%d size=%s", url, config.model, max(1, n), config.size
        )
        try:
            async with httpx.AsyncClient(timeout=config.request_timeout) as client:
                resp = await client.post(url, headers=headers, json=payload)
                raise_for_provider(resp, "Image generation")
                images = [
                    await self._materialize(item, config) for item in self._extract_items(resp)
                ]
        except httpx.HTTPError as exc:
            raise GenerationProviderError(f"Image generation request error: {exc}") from exc
        if not images:
            raise GenerationProviderError("Image provider returned no images.")
        return images

    @staticmethod
    def _extract_items(resp: httpx.Response) -> list[dict[str, Any]]:
        data = resp.json()
        if isinstance(data, dict):
            items = data.get("data")
            if isinstance(items, list) and items:
                return [item for item in items if isinstance(item, dict)]
        raise GenerationProviderError("Image response had no `data` array.")

    async def _materialize(self, item: dict[str, Any], config: ImagegenConfig) -> tuple[bytes, str]:
        b64 = item.get("b64_json")
        if isinstance(b64, str) and b64:
            return (
                decode_generated_base64(
                    b64,
                    max_bytes=MAX_GENERATED_IMAGE_BYTES,
                    action="Image provider payload",
                ),
                "image/png",
            )
        src = item.get("url")
        if isinstance(src, str) and src:
            return await download_generated_media(
                src,
                media_kind="image",
                max_bytes=MAX_GENERATED_IMAGE_BYTES,
                timeout_seconds=config.request_timeout,
            )
        raise GenerationProviderError("Image item had neither `b64_json` nor `url`.")


__all__ = ["OpenAICompatImagegenAdapter"]
