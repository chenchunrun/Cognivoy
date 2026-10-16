"""Regression tests for the memory consolidator LLM boundary."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from cognivoy.services.llm.config import LLMConfig
from cognivoy.services.memory.consolidator.modes import _runtime


async def _collect(events: list[dict], event: dict) -> None:
    events.append(event)


@pytest.mark.asyncio
async def test_structured_memory_disables_deepseek_thinking() -> None:
    captured: dict = {}

    async def fake_stream(**kwargs):
        captured.update(kwargs)
        yield '{"facts": []}'

    config = LLMConfig(
        model="deepseek-v4-pro",
        api_key="test",
        binding="deepseek",
        provider_name="deepseek",
    )
    with (
        patch("cognivoy.services.llm.get_llm_config", return_value=config),
        patch.object(_runtime, "llm_stream", side_effect=fake_stream),
        patch.object(_runtime, "llm_complete", new=AsyncMock()) as complete,
    ):
        result = await _runtime.call_llm(system_prompt="system", user_prompt="user")

    assert result == '{"facts": []}'
    assert captured["reasoning_effort"] == "minimal"
    complete.assert_not_awaited()


@pytest.mark.asyncio
async def test_empty_reasoning_only_stream_retries_non_streaming() -> None:
    events: list[dict] = []

    async def reasoning_only_stream(**kwargs):
        assert kwargs["reasoning_effort"] == "minimal"
        yield "<think>spending the output budget on reasoning</think>"

    config = LLMConfig(
        model="deepseek-v4-pro",
        api_key="test",
        binding="deepseek",
        provider_name="deepseek",
    )
    complete = AsyncMock(return_value='{"facts": []}')
    with (
        patch("cognivoy.services.llm.get_llm_config", return_value=config),
        patch.object(_runtime, "llm_stream", side_effect=reasoning_only_stream),
        patch.object(_runtime, "llm_complete", new=complete),
    ):
        result = await _runtime.call_llm(
            system_prompt="system",
            user_prompt="user",
            max_tokens=1500,
            on_event=lambda event: _collect(events, event),
            turn=1,
            chunk_index=0,
            label="update",
        )

    assert result == '{"facts": []}'
    retry = next(event for event in events if event["stage"] == "llm_retry")
    assert retry["reason"] == "empty_stream_response"
    complete.assert_awaited_once()
    assert complete.await_args.kwargs["reasoning_effort"] == "minimal"
    assert complete.await_args.kwargs["max_tokens"] == 3000
    ended = next(event for event in events if event["stage"] == "llm_io_end")
    assert ended["retried"] is True
    assert ended["error"] is None


@pytest.mark.asyncio
async def test_empty_retry_emits_actionable_diagnostic() -> None:
    events: list[dict] = []

    async def empty_stream(**kwargs):
        if False:
            yield ""

    config = LLMConfig(
        model="plain-model",
        api_key="test",
        binding="custom",
        provider_name="custom",
    )
    with (
        patch("cognivoy.services.llm.get_llm_config", return_value=config),
        patch.object(_runtime, "llm_stream", side_effect=empty_stream),
        patch.object(_runtime, "llm_complete", new=AsyncMock(return_value="")),
    ):
        result = await _runtime.call_llm(
            system_prompt="system",
            user_prompt="user",
            on_event=lambda event: _collect(events, event),
        )

    assert result == ""
    ended = next(event for event in events if event["stage"] == "llm_io_end")
    assert ended["error"] == "empty_response_after_retry"
    assert ended["retry_reason"] == "empty_stream_response"
    assert ended["reasoning_effort"] is None
