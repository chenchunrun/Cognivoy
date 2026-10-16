from __future__ import annotations

import pytest

from cognivoy.services.optional_readiness import MEDIA_SERVICES, get_media_readiness


def _catalog(name: str, **profile_overrides):
    profile = {
        "id": "p1",
        "name": "Sample",
        "binding": "openai",
        "api_key": "secret-test",
        "base_url": "https://provider.example/v1",
        "models": [{"id": "m1", "model": "sample-model"}],
        **profile_overrides,
    }
    return {
        "services": {
            name: {"active_profile_id": "p1", "active_model_id": "m1", "profiles": [profile]}
        }
    }


@pytest.mark.parametrize("name", MEDIA_SERVICES)
def test_preflight_requires_profile_and_model(name):
    assert get_media_readiness({"services": {}})[name]["missing_configuration"] == ["profile"]
    result = get_media_readiness(_catalog(name, models=[]))[name]
    assert result["status"] == "not_configured"
    assert result["missing_configuration"] == ["model"]


@pytest.mark.parametrize("name", MEDIA_SERVICES)
def test_valid_preflight_is_not_live_verification_or_secret_disclosure(name):
    result = get_media_readiness(_catalog(name))[name]
    assert result["status"] == "configured"
    assert result["verification"] == "not_run"
    assert result["missing_configuration"] == []
    assert "secret-test" not in repr(result)
    assert "provider.example" not in repr(result)
    assert result["setup_path"] in {
        "/settings/tts",
        "/settings/stt",
        "/settings/image",
        "/settings/video",
    }


@pytest.mark.parametrize("binding", ["openai", "volcengine"])
def test_known_hosted_provider_requires_credentials(binding):
    result = get_media_readiness(_catalog("imagegen", binding=binding, api_key=""))["imagegen"]
    assert result["missing_configuration"] == ["credentials"]


def test_explicit_auth_header_and_keyless_custom_gateway_are_supported():
    catalog = _catalog("tts", api_key="", extra_headers={"Authorization": "Bearer secret-header"})
    assert get_media_readiness(catalog)["tts"]["status"] == "configured"
    catalog = _catalog("tts", binding="custom", api_key="")
    assert get_media_readiness(catalog)["tts"]["status"] == "configured"


@pytest.mark.parametrize("endpoint", ["", "not-a-url", "https://[invalid"])
def test_custom_endpoint_must_be_valid(endpoint):
    result = get_media_readiness(_catalog("tts", binding="custom", base_url=endpoint))["tts"]
    assert result["missing_configuration"] == ["endpoint"]
