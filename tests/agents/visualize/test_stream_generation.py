"""Code-generation liveness is bounded without cancelling productive streams."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncGenerator
from typing import Any

import pytest

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.agents.visualize import generation
from cognivoy.agents.visualize.agents.code_generator_agent import CodeGeneratorAgent
from cognivoy.agents.visualize.generation import (
    VisualizationGenerationError,
    collect_generated_code,
)
from cognivoy.agents.visualize.models import VisualizationAnalysis


def _limits(
    monkeypatch: pytest.MonkeyPatch,
    *,
    first: float = 0.2,
    idle: float = 0.2,
    total: float = 1.0,
) -> None:
    monkeypatch.setattr(generation, "FIRST_OUTPUT_TIMEOUT_S", first)
    monkeypatch.setattr(generation, "IDLE_OUTPUT_TIMEOUT_S", idle)
    monkeypatch.setattr(generation, "TOTAL_OUTPUT_TIMEOUT_S", total)


@pytest.mark.asyncio
async def test_productive_stream_can_outlive_the_first_response_deadline(monkeypatch):
    _limits(monkeypatch, first=0.06, idle=0.06)
    closed = asyncio.Event()

    async def stream():
        try:
            for chunk in ["<svg>", "\n", "<rect/>", "\n", "</svg>"]:
                await asyncio.sleep(0.02)
                yield chunk
        finally:
            closed.set()

    assert await collect_generated_code(stream()) == "<svg>\n<rect/>\n</svg>"
    assert closed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("heartbeat", ["", " "])
async def test_first_nonempty_output_timeout_ignores_heartbeats(monkeypatch, heartbeat):
    _limits(monkeypatch, first=0.035)
    closed = asyncio.Event()

    async def stream():
        try:
            while True:
                await asyncio.sleep(0.005)
                yield heartbeat
        finally:
            closed.set()

    with pytest.raises(VisualizationGenerationError) as caught:
        await collect_generated_code(stream())
    assert caught.value.reason == "first_response_timeout"
    assert closed.is_set()


@pytest.mark.asyncio
async def test_idle_deadline_is_not_reset_by_empty_chunks(monkeypatch):
    _limits(monkeypatch, idle=0.035)
    closed = asyncio.Event()

    async def stream():
        try:
            yield "<svg>"
            while True:
                await asyncio.sleep(0.005)
                yield ""
        finally:
            closed.set()

    with pytest.raises(VisualizationGenerationError) as caught:
        await collect_generated_code(stream())
    assert caught.value.reason == "idle_timeout"
    assert caught.value.partial_chars == 5
    assert "<svg>" not in str(caught.value)
    assert closed.is_set()


@pytest.mark.asyncio
async def test_total_deadline_stops_an_endless_productive_stream(monkeypatch):
    _limits(monkeypatch, first=0.2, idle=0.2, total=0.055)
    closed = asyncio.Event()

    async def stream():
        try:
            while True:
                await asyncio.sleep(0.005)
                yield "x"
        finally:
            closed.set()

    with pytest.raises(VisualizationGenerationError) as caught:
        await collect_generated_code(stream())
    assert caught.value.reason == "total_timeout"
    assert caught.value.partial_chars > 0
    assert closed.is_set()


@pytest.mark.asyncio
async def test_simplified_attempt_has_a_shorter_total_bound(monkeypatch):
    _limits(monkeypatch)
    monkeypatch.setattr(generation, "SIMPLIFIED_TOTAL_TIMEOUT_S", 0.03)

    async def stream():
        yield "<svg>"
        await asyncio.sleep(0.06)
        yield "</svg>"

    with pytest.raises(VisualizationGenerationError) as caught:
        await collect_generated_code(stream(), simplified=True)
    assert caught.value.reason == "total_timeout"


@pytest.mark.asyncio
async def test_maximum_code_length_is_bounded_and_closes_the_stream(monkeypatch):
    monkeypatch.setattr(generation, "MAX_GENERATED_CHARS", 4)
    closed = asyncio.Event()

    async def stream():
        try:
            yield "ab"
            yield "cd"
            yield "do not include this content in errors"
        finally:
            closed.set()

    with pytest.raises(VisualizationGenerationError) as caught:
        await collect_generated_code(stream())
    assert caught.value.reason == "output_limit"
    assert caught.value.partial_chars == 4
    assert vars(caught.value) == {"reason": "output_limit", "partial_chars": 4}
    assert closed.is_set()


@pytest.mark.asyncio
async def test_external_cancellation_propagates_and_closes_the_generator():
    started = asyncio.Event()
    closed = asyncio.Event()

    async def stream():
        try:
            yield "<svg>"
            started.set()
            await asyncio.Event().wait()
        finally:
            closed.set()

    task = asyncio.create_task(collect_generated_code(stream()))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()


@pytest.mark.asyncio
async def test_buffered_empty_stream_does_not_starve_cancellation(monkeypatch):
    _limits(monkeypatch, first=0.1)
    started = asyncio.Event()
    closed = asyncio.Event()

    async def stream():
        try:
            started.set()
            while True:
                yield ""
        finally:
            closed.set()

    task = asyncio.create_task(collect_generated_code(stream()))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("exception_type", [RuntimeError, TimeoutError])
async def test_provider_error_is_distinct_and_does_not_expose_provider_details(exception_type):
    async def stream():
        yield "<svg>"
        raise exception_type("request failed at https://example.test?api_key=private-value")

    with pytest.raises(VisualizationGenerationError) as caught:
        await collect_generated_code(stream())
    assert caught.value.reason == "provider_error"
    assert caught.value.partial_chars == 5
    assert "private-value" not in str(caught.value)


@pytest.mark.asyncio
async def test_empty_stream_returns_empty_for_artifact_validation():
    async def stream():
        if False:
            yield ""

    assert await collect_generated_code(stream()) == ""


@pytest.mark.asyncio
async def test_invalid_chunk_is_rejected_and_closed():
    closed = asyncio.Event()

    async def stream():
        try:
            yield {"unexpected": "chunk"}
        finally:
            closed.set()

    with pytest.raises(VisualizationGenerationError) as caught:
        await collect_generated_code(stream())  # type: ignore[arg-type]
    assert caught.value.reason == "invalid_chunk"
    assert closed.is_set()


@pytest.mark.asyncio
@pytest.mark.parametrize("configured,expected", [(12000, 4096), (2048, 2048), (0, 4096)])
async def test_simplified_codegen_preserves_constraints_and_caps_tokens(
    monkeypatch, configured, expected
):
    recorded: dict[str, Any] = {}

    async def stream_llm(self, **kwargs) -> AsyncGenerator[str, None]:
        recorded.update(kwargs)
        yield "```svg\n<svg><rect width='1'/></svg>\n```"

    monkeypatch.setattr(BaseAgent, "stream_llm", stream_llm)
    monkeypatch.setattr(BaseAgent, "get_max_tokens", lambda self: configured)
    result = await CodeGeneratorAgent().process(
        user_input="Show three layers",
        history_context="Layer one, two, and three",
        analysis=VisualizationAnalysis(render_type="svg", description="three layers"),
        render_constraints="Keep the three layer labels",
        simplified=True,
    )
    assert result == "<svg><rect width='1'/></svg>"
    assert recorded["max_tokens"] == expected
    assert recorded["trace_meta"]["simplified"] is True
    assert "Keep the three layer labels" in recorded["user_prompt"]
    assert "Preserve the essential teaching points" in recorded["user_prompt"]
    assert "Do not return a text-only page" in recorded["user_prompt"]


@pytest.mark.asyncio
async def test_generation_failure_emits_same_call_id_terminal_trace(monkeypatch):
    _limits(monkeypatch, first=0.025)
    recorded: dict[str, Any] = {}
    events: list[dict[str, Any]] = []

    async def stream_llm(self, **kwargs):
        recorded.update(kwargs)
        await asyncio.Event().wait()
        yield "unreachable"

    monkeypatch.setattr(BaseAgent, "stream_llm", stream_llm)
    agent = CodeGeneratorAgent()
    agent.set_trace_callback(events.append)
    with pytest.raises(VisualizationGenerationError):
        await agent.process(
            user_input="Show three layers",
            history_context="",
            analysis=VisualizationAnalysis(render_type="svg"),
        )
    assert len(events) == 1
    assert events[0]["call_id"] == recorded["trace_meta"]["call_id"]
    assert events[0]["state"] == "error"
    assert events[0]["reason"] == "first_response_timeout"
    assert "chunk" not in events[0]
