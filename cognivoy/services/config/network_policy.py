"""Central outbound-network policy shared by tools and capabilities."""

from __future__ import annotations

from dataclasses import dataclass


class OutboundNetworkDisabledError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class OutboundNetworkPolicy:
    enabled: bool
    timeout_seconds: int
    proxy: str | None


def _load_policy_settings() -> dict[str, object]:
    from cognivoy.services.config.runtime_settings import get_runtime_settings_service

    return get_runtime_settings_service().load_system(include_process_overrides=True)


def get_outbound_network_policy() -> OutboundNetworkPolicy:
    settings = _load_policy_settings()
    return OutboundNetworkPolicy(
        enabled=bool(settings.get("external_network_enabled", True)),
        timeout_seconds=max(5, min(600, int(settings.get("external_request_timeout_seconds", 60)))),
        proxy=str(settings.get("outbound_proxy") or "").strip() or None,
    )


def require_outbound_network(feature: str) -> OutboundNetworkPolicy:
    policy = get_outbound_network_policy()
    if not policy.enabled:
        raise OutboundNetworkDisabledError(
            f"Outbound network access is disabled by Settings > Network ({feature})."
        )
    return policy


__all__ = [
    "OutboundNetworkDisabledError",
    "OutboundNetworkPolicy",
    "get_outbound_network_policy",
    "require_outbound_network",
]
