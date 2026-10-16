"""Cross-worker publication generation for cached provider clients."""

from __future__ import annotations

from cognivoy.services.coordination import get_shared_coordination_store

_PROVIDER_TOPIC = "runtime-provider-config"


def provider_config_revision() -> int:
    return get_shared_coordination_store().revision(_PROVIDER_TOPIC)


def publish_provider_config_revision() -> int:
    return get_shared_coordination_store().publish_revision(_PROVIDER_TOPIC)


__all__ = ["provider_config_revision", "publish_provider_config_revision"]
