"""Provider-specific protocol behavior must use parsed host identities."""

import pytest

from cognivoy.services.llm.provider_core.openai_compat_provider import (
    _is_direct_openai_base,
    _uses_openrouter,
)


@pytest.mark.parametrize(
    "url",
    [
        "https://api.openai.com.attacker.example/v1",
        "https://attacker.example/api.openai.com",
        "https://api.openai.com@attacker.example/v1",
    ],
)
def test_openai_lookalikes_are_not_direct(url):
    assert not _is_direct_openai_base(url)


@pytest.mark.parametrize(
    "url",
    [
        "https://openrouter.ai.attacker.example/v1",
        "https://attacker.example/openrouter",
    ],
)
def test_openrouter_lookalikes_are_not_direct(url):
    assert not _uses_openrouter(None, url)


def test_exact_provider_hosts():
    assert _is_direct_openai_base("https://api.openai.com/v1")
    assert _uses_openrouter(None, "https://openrouter.ai/api/v1")
