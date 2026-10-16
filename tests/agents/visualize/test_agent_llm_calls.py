"""The visualize agents must call the LLM through their own agent seam.

Reaching for ``cognivoy.services.llm.complete`` directly silently drops what
``BaseAgent.call_llm`` carries: the image attachments the analysis stage was
given, the trace metadata the Activity panel renders, and the per-agent
api_key / base_url / binding routing (regression from #707).
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.agents.visualize.agents.analysis_agent import AnalysisAgent
from cognivoy.agents.visualize.agents.code_generator_agent import CodeGeneratorAgent
from cognivoy.agents.visualize.models import VisualizationAnalysis


def _record_call_llm(monkeypatch: pytest.MonkeyPatch, reply: str) -> dict[str, Any]:
    """Capture the kwargs an agent hands to ``BaseAgent.call_llm``."""
    recorded: dict[str, Any] = {}

    async def _call_llm(self: BaseAgent, **kwargs: Any) -> str:
        recorded.update(kwargs)
        return reply

    monkeypatch.setattr(BaseAgent, "call_llm", _call_llm)
    return recorded


@pytest.mark.asyncio
async def test_analysis_agent_forwards_attachments_and_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reply = json.dumps(
        {
            "render_type": "svg",
            "description": "a bar chart",
            "data_description": "two series",
            "chart_type": "bar",
            "visual_elements": ["bars"],
            "rationale": "simple comparison",
        }
    )
    recorded = _record_call_llm(monkeypatch, reply)
    attachments = [object()]

    await AnalysisAgent().process(
        user_input="chart our revenue",
        history_context="",
        render_mode="svg",
        attachments=attachments,  # type: ignore[arg-type]
    )

    assert recorded["attachments"] is attachments
    assert recorded["stage"] == "analyzing"
    assert recorded["trace_meta"]["call_kind"] == "viz_analysis"
    assert recorded["response_format"] == {"type": "json_object"}


@pytest.mark.asyncio
async def test_code_generator_agent_emits_its_trace(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded: dict[str, Any] = {}

    async def _stream_llm(self: BaseAgent, **kwargs: Any):
        recorded.update(kwargs)
        yield "```svg\n"
        yield "<svg/>"
        yield "\n```"

    monkeypatch.setattr(BaseAgent, "stream_llm", _stream_llm)
    analysis = VisualizationAnalysis(
        render_type="svg",
        description="a bar chart",
        data_description="two series",
        chart_type="bar",
        visual_elements=["bars"],
        rationale="simple comparison",
    )

    generated = await CodeGeneratorAgent().process(
        user_input="chart our revenue",
        history_context="",
        analysis=analysis,
    )

    assert recorded["stage"] == "generating"
    assert recorded["trace_meta"]["call_kind"] == "viz_code_generation"
    assert generated == "<svg/>"
