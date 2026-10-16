from __future__ import annotations

import pytest


def test_outbound_policy_blocks_external_features(monkeypatch):
    from cognivoy.services.config import network_policy

    monkeypatch.setattr(
        network_policy,
        "_load_policy_settings",
        lambda: {
            "external_network_enabled": False,
            "external_request_timeout_seconds": 75,
            "outbound_proxy": "http://proxy.example.com:8080",
        },
    )

    policy = network_policy.get_outbound_network_policy()
    assert policy.timeout_seconds == 75
    assert policy.proxy == "http://proxy.example.com:8080"
    with pytest.raises(network_policy.OutboundNetworkDisabledError):
        network_policy.require_outbound_network("web_search")
