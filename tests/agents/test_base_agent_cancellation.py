"""Cancellation must close providers and terminate their existing trace cards."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest

from cognivoy.agents import base_agent
from cognivoy.agents.base_agent import BaseAgent

_PARTIAL = "<svg>unfinished-private-generated-code"
_KEY = "private-provider-credential"
_CANCEL_DETAIL = "private-cancellation-detail"


class _Agent(BaseAgent):
    async def process(self, **_kwargs):
        return None


@pytest.fixture
def configured_agent(monkeypatch):
    """No runtime settings, live providers, prompts, or usage stores are touched."""
    monkeypatch.setattr(
        base_agent,
        "get_llm_config",
        lambda: SimpleNamespace(
            model="test-model",
            api_key=_KEY,
            base_url="https://example.invalid/v1",
            binding="openai",
            api_version=None,
        ),
    )
    monkeypatch.setattr(
        base_agent,
        "get_agent_params",
        lambda _module: {"temperature": 0.2, "max_tokens": 64},
    )
    monkeypatch.setattr(
        base_agent,
        "get_prompt_manager",
        lambda: SimpleNamespace(load_prompts=lambda **_kwargs: {}),
    )
    tracked: list[dict[str, Any]] = []
    monkeypatch.setattr(BaseAgent, "_track_tokens", lambda _self, **kwargs: tracked.append(kwargs))
    agent = _Agent(
        module_name="visualize",
        agent_name="test_cancel_agent",
        language="en",
        config={"agents": {"test_cancel_agent": {"max_retries": 0}}},
    )
    events: list[dict[str, Any]] = []
    agent.set_trace_callback(events.append)
    return agent, events, tracked


def _assert_cancelled_trace(events, *, call_id: str, partial_chars: int | None = None):
    terminal = [event for event in events if event.get("state") in {"error", "complete"}]
    assert len(terminal) == 1
    assert terminal[0]["state"] == "error"
    assert terminal[0]["reason"] == "cancelled"
    assert terminal[0]["call_id"] == call_id
    assert terminal[0]["response"] == "LLM call cancelled."
    assert "chunk" not in terminal[0]
    if partial_chars is not None:
        assert terminal[0]["partial_chars"] == partial_chars
    serialized = json.dumps(terminal)
    for private_value in (_PARTIAL, _KEY, _CANCEL_DETAIL):
        assert private_value not in serialized


@pytest.mark.asyncio
async def test_call_llm_cancellation_propagates_and_emits_error_terminal(
    monkeypatch, configured_agent
):
    agent, events, tracked = configured_agent
    started = asyncio.Event()
    closed = asyncio.Event()

    async def provider(**_kwargs):
        try:
            started.set()
            await asyncio.Event().wait()
        finally:
            closed.set()

    monkeypatch.setattr(base_agent, "llm_complete", provider)
    task = asyncio.create_task(
        agent.call_llm(
            user_prompt="Draw a diagram",
            system_prompt="Return code",
            trace_meta={"call_id": "complete-cancel"},
        )
    )
    await started.wait()
    task.cancel(_CANCEL_DETAIL)
    with pytest.raises(asyncio.CancelledError):
        await task

    assert closed.is_set()
    assert tracked == []
    assert events[0]["state"] == "running"
    _assert_cancelled_trace(events, call_id="complete-cancel")


@pytest.mark.asyncio
async def test_call_llm_outer_timeout_closes_provider_without_success(
    monkeypatch, configured_agent
):
    agent, events, tracked = configured_agent
    closed = asyncio.Event()

    async def provider(**_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            closed.set()

    monkeypatch.setattr(base_agent, "llm_complete", provider)
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(
            agent.call_llm(
                user_prompt="Draw a diagram",
                system_prompt="Return code",
                trace_meta={"call_id": "complete-timeout"},
            ),
            timeout=0.025,
        )
    assert closed.is_set()
    assert tracked == []
    _assert_cancelled_trace(events, call_id="complete-timeout")


@pytest.mark.asyncio
@pytest.mark.parametrize("with_partial", [False, True])
async def test_stream_cancellation_closes_provider_without_leaking_partial_terminal(
    monkeypatch, configured_agent, with_partial
):
    agent, events, tracked = configured_agent
    waiting = asyncio.Event()
    closed = asyncio.Event()
    received: list[str] = []

    async def provider(**_kwargs):
        try:
            if with_partial:
                yield _PARTIAL
            waiting.set()
            await asyncio.Event().wait()
        finally:
            closed.set()

    monkeypatch.setattr(base_agent, "llm_stream", provider)

    async def consume():
        async for chunk in agent.stream_llm(
            user_prompt="Draw a diagram",
            system_prompt="Return code",
            trace_meta={"call_id": "stream-cancel"},
        ):
            received.append(chunk)

    task = asyncio.create_task(consume())
    await waiting.wait()
    task.cancel(_CANCEL_DETAIL)
    with pytest.raises(asyncio.CancelledError):
        await task

    assert closed.is_set()
    assert received == ([_PARTIAL] if with_partial else [])
    assert tracked == []
    _assert_cancelled_trace(
        events,
        call_id="stream-cancel",
        partial_chars=len(_PARTIAL) if with_partial else 0,
    )


@pytest.mark.asyncio
async def test_explicit_stream_aclose_closes_suspended_provider_and_is_idempotent(
    monkeypatch, configured_agent
):
    agent, events, tracked = configured_agent
    closed = asyncio.Event()
    advanced: list[bool] = []

    async def provider(**_kwargs):
        try:
            yield _PARTIAL
            advanced.append(True)
            yield "This must never be consumed"
        finally:
            closed.set()

    monkeypatch.setattr(base_agent, "llm_stream", provider)
    stream = agent.stream_llm(
        user_prompt="Draw a diagram",
        system_prompt="Return code",
        trace_meta={"call_id": "stream-close"},
    )
    assert await anext(stream) == _PARTIAL
    await stream.aclose()
    await stream.aclose()

    assert closed.is_set()
    assert advanced == []
    assert tracked == []
    _assert_cancelled_trace(events, call_id="stream-close", partial_chars=len(_PARTIAL))


@pytest.mark.asyncio
async def test_successful_stream_still_closes_provider_and_completes_once(
    monkeypatch, configured_agent
):
    agent, events, tracked = configured_agent
    closed = asyncio.Event()

    async def provider(**_kwargs):
        try:
            yield "<svg>"
            yield "</svg>"
        finally:
            closed.set()

    monkeypatch.setattr(base_agent, "llm_stream", provider)
    result = "".join(
        [
            chunk
            async for chunk in agent.stream_llm(
                user_prompt="Draw a diagram",
                system_prompt="Return code",
                trace_meta={"call_id": "stream-complete"},
            )
        ]
    )
    assert result == "<svg></svg>"
    assert closed.is_set()
    assert len(tracked) == 1
    terminal = [event for event in events if event.get("state") in {"error", "complete"}]
    assert len(terminal) == 1
    assert terminal[0]["state"] == "complete"
    assert terminal[0]["call_id"] == "stream-complete"
