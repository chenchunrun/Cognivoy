"""Non-network preflight for optional media services; never claims live success."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from cognivoy.services.config import provider_runtime
from cognivoy.services.config.model_catalog import get_model_catalog_service

MEDIA_SERVICES = ("tts", "stt", "imagegen", "videogen")
_SETUP_PATHS = {
    "tts": "/settings/tts",
    "stt": "/settings/stt",
    "imagegen": "/settings/image",
    "videogen": "/settings/video",
}


def get_media_readiness(catalog: dict[str, Any] | None = None) -> dict[str, dict[str, Any]]:
    """Validate active model, endpoint, and provider auth without sending data.

    A custom gateway may intentionally be keyless. Known hosted providers must
    have a key or an explicit authentication header. Neither configuration nor
    a successful connection probe proves that a complete media artifact works.
    """
    service = get_model_catalog_service()
    loaded = catalog if catalog is not None else service.load()
    result: dict[str, dict[str, Any]] = {}
    for name in MEDIA_SERVICES:
        profile = service.get_active_profile(loaded, name)
        missing: list[str] = []
        if not profile:
            missing.append("profile")
        else:
            try:
                resolver = getattr(provider_runtime, f"resolve_{name}_runtime_config")
                config = resolver(catalog=loaded, service=service)
            except ValueError:
                # Do not expose provider values or exception strings in public status.
                missing.append("model")
            else:
                try:
                    endpoint = urlsplit(config.base_url)
                    valid_endpoint = endpoint.scheme in {"http", "https"} and bool(
                        endpoint.hostname
                    )
                except ValueError:
                    valid_endpoint = False
                if not valid_endpoint:
                    missing.append("endpoint")
                auth_headers = {key.lower(): value for key, value in config.extra_headers.items()}
                explicit_auth = any(
                    str(auth_headers.get(key) or "").strip()
                    for key in ("authorization", "api-key", "x-api-key")
                )
                if (
                    not config.api_key.strip()
                    and not explicit_auth
                    and config.provider_name not in {"custom", "custom_chat"}
                ):
                    missing.append("credentials")
        result[name] = {
            "status": "not_configured" if missing else "configured",
            "profile": str(profile.get("name") or profile.get("id") or "") if profile else None,
            "missing_configuration": missing,
            "verification": "not_run",
            "setup_path": _SETUP_PATHS[name],
        }
    return result


__all__ = ["MEDIA_SERVICES", "get_media_readiness"]
