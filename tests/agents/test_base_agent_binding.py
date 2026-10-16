"""Tests for BaseAgent runtime binding behavior."""

from __future__ import annotations

import pytest

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.services.llm.config import LLMConfig


class _DummyAgent(BaseAgent):
    async def process(self, **_kwargs):  # noqa: ANN003
        return {}


def test_base_agent_defaults_to_resolved_binding(monkeypatch) -> None:
    """When binding is not explicitly provided, use resolved runtime binding."""
    resolved = LLMConfig(
        model="google/gemini-3-flash-preview",
        api_key="sk-test",
        base_url="https://openrouter.ai/api/v1",
        binding="openrouter",
        provider_name="openrouter",
        provider_mode="gateway",
    )
    monkeypatch.setattr("cognivoy.agents.base_agent.get_llm_config", lambda: resolved)

    agent = _DummyAgent(
        module_name="question",
        agent_name="idea_agent",
        language="en",
    )

    assert agent.binding == "openrouter"


@pytest.mark.asyncio
async def test_base_agent_appends_runtime_language_to_every_completion(monkeypatch) -> None:
    captured: dict[str, str] = {}

    async def fake_complete(*, system_prompt: str, **_kwargs):  # noqa: ANN003
        captured["system_prompt"] = system_prompt
        return "完成"

    monkeypatch.setattr("cognivoy.agents.base_agent.llm_complete", fake_complete)
    monkeypatch.setattr(
        "cognivoy.agents.base_agent.get_llm_config",
        lambda: LLMConfig(model="test-model", api_key="test", binding="openai"),
    )
    agent = _DummyAgent(module_name="question", agent_name="idea_agent", language="zh")

    await agent.call_llm(user_prompt="题目", system_prompt="Respond in English.", verbose=False)

    assert "Respond in English." in captured["system_prompt"]
    assert "请严格使用中文（简体）" in captured["system_prompt"]
    assert captured["system_prompt"].rfind("请严格使用中文（简体）") > captured[
        "system_prompt"
    ].rfind("Respond in English.")


def test_base_agent_appends_runtime_language_to_prebuilt_messages(monkeypatch) -> None:
    monkeypatch.setattr(
        "cognivoy.agents.base_agent.get_llm_config",
        lambda: LLMConfig(model="test-model", api_key="test", binding="openai"),
    )
    agent = _DummyAgent(module_name="question", agent_name="idea_agent", language="zh")

    system, messages = agent._apply_response_language(
        "outer",
        [
            {"role": "system", "content": "Respond in English."},
            {"role": "user", "content": "请讲解"},
        ],
    )

    assert "请严格使用中文（简体）" in system
    assert messages is not None
    assert "请严格使用中文（简体）" in str(messages[0]["content"])
