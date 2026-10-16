"""Local regression tests for the visualization analysis output boundary."""

from __future__ import annotations

import asyncio
import json
import traceback
from typing import Any
from unittest.mock import AsyncMock

import pytest

from cognivoy.agents.visualize.agents.analysis_agent import AnalysisAgent
from cognivoy.agents.visualize.analysis import (
    MAX_ANALYSIS_CHARS,
    VisualizationAnalysisError,
    parse_visualization_analysis,
)

_BRIEF = {
    "render_type": "mermaid",
    "description": "Three learning loops and their trigger conditions",
    "visual_elements": ["foreground", "review", "curator"],
    "visual_genre": "structural",
}
_SECRET = "provider-private-payload-should-not-appear"


@pytest.mark.parametrize(
    ("raw", "reason"),
    [
        (None, "empty_analysis"),
        ("", "empty_analysis"),
        (" \n\t ", "empty_analysis"),
        (_SECRET, "non_json_analysis"),
        ('{"render_type": "svg",', "non_json_analysis"),
        ({"render_type": "svg"}, "invalid_analysis_schema"),
        (b'{"render_type":"svg"}', "invalid_analysis_schema"),
        ("{}", "invalid_analysis_schema"),
        ("null", "invalid_analysis_schema"),
        ("[]", "invalid_analysis_schema"),
        ('[{"render_type":"svg"}]', "invalid_analysis_schema"),
        ('```json\n[{"render_type":"svg"}]\n```', "invalid_analysis_schema"),
        ('{"render_type":null}', "invalid_analysis_schema"),
        ('{"render_type":["svg"]}', "invalid_analysis_schema"),
        ('{"render_type":{"svg":true}}', "invalid_analysis_schema"),
        ('{"render_type":"svg","visual_genre":42}', "invalid_analysis_schema"),
        ('{"render_type":"svg","description":42}', "invalid_analysis_schema"),
        ('{"render_type":"svg","visual_elements":"box"}', "invalid_analysis_schema"),
        ('{"render_type":"svg","visual_elements":[42]}', "invalid_analysis_schema"),
        ("9" * 5000, "invalid_analysis_schema"),
        (_SECRET * MAX_ANALYSIS_CHARS, "analysis_output_limit"),
    ],
)
def test_invalid_output_is_a_safe_typed_failure(raw: Any, reason: str) -> None:
    with pytest.raises(VisualizationAnalysisError) as raised:
        parse_visualization_analysis(raw)

    assert raised.value.reason == reason
    assert raised.value.__cause__ is None
    assert _SECRET not in str(raised.value)
    assert _SECRET not in "".join(traceback.format_exception(raised.value))


@pytest.mark.parametrize("wrapper", ["{}", "```json\n{}\n```", "Analysis:\n{}\nEnd."])
def test_supported_formatting_wrappers_keep_the_real_brief(wrapper: str) -> None:
    result = parse_visualization_analysis(wrapper.format(json.dumps(_BRIEF)))

    assert result.render_type == "mermaid"
    assert result.description == _BRIEF["description"]
    assert result.visual_elements == _BRIEF["visual_elements"]


def test_unescaped_quotes_in_nonempty_json_brief_are_not_mistaken_for_empty_output() -> None:
    # The provider can return a complete JSON-looking response but forget to
    # escape quotes inside a description. Keep this literally invalid JSON.
    raw = '{"render_type":"html","description":"展示"三个阶段"的关系"}'
    with pytest.raises(json.JSONDecodeError, match="Expecting ',' delimiter"):
        json.loads(raw)

    with pytest.raises(VisualizationAnalysisError) as raised:
        parse_visualization_analysis(raw)

    assert raised.value.reason == "non_json_analysis"
    assert raised.value.__cause__ is None
    assert "三个阶段" not in str(raised.value)
    assert "三个阶段" not in "".join(traceback.format_exception(raised.value))


@pytest.mark.parametrize("render_mode", ["svg", "chartjs", "mermaid", "html"])
@pytest.mark.parametrize("reported_render_type", [None, "svg", "manim_video", "invented-type"])
def test_explicit_render_mode_is_authoritative(
    render_mode: str, reported_render_type: str | None
) -> None:
    brief = {**_BRIEF}
    if reported_render_type is None:
        brief.pop("render_type")
    else:
        brief["render_type"] = reported_render_type

    result = parse_visualization_analysis(json.dumps(brief), render_mode=render_mode)

    assert result.render_type == render_mode
    assert result.description == _BRIEF["description"]


@pytest.mark.parametrize("render_type", ["svg", "chartjs", "mermaid", "html", "manim_video"])
def test_figure_mode_remains_static(render_type: str) -> None:
    result = parse_visualization_analysis(
        json.dumps({**_BRIEF, "render_type": render_type}), render_mode="figure"
    )

    assert result.render_type == (
        render_type if render_type in {"svg", "chartjs", "mermaid"} else "svg"
    )


def test_optional_brief_fields_keep_existing_defaults() -> None:
    result = parse_visualization_analysis('{"render_type":"svg"}')

    assert result.render_type == "svg"
    assert result.description == ""
    assert result.visual_elements == []


def test_invented_string_enums_keep_compatibility_without_logging_raw_output(caplog) -> None:
    result = parse_visualization_analysis(
        json.dumps({**_BRIEF, "render_type": _SECRET, "visual_genre": _SECRET})
    )

    assert result.render_type == "svg"
    assert result.visual_genre == ""
    assert _SECRET not in caplog.text


def _agent(raw: Any = None) -> AnalysisAgent:
    # The test controls the model seam without reading runtime credentials.
    agent = object.__new__(AnalysisAgent)
    agent.agent_name = "analysis_agent"
    agent.prompts = {
        "system": "Return a JSON visualization brief.",
        "user_template": "{user_input} {history_context}",
        "system_fixed": "Respect the selected format.",
        "user_template_fixed": "{render_type} {user_input} {history_context}",
    }
    agent.call_llm = AsyncMock(return_value=raw)
    agent._emit_trace_event = AsyncMock()
    return agent


@pytest.mark.asyncio
async def test_parse_failure_corrects_the_same_trace_without_raw_response() -> None:
    agent = _agent(_SECRET)
    with pytest.raises(VisualizationAnalysisError):
        await agent.process(user_input="draw the three loops", history_context="")

    agent.call_llm.assert_awaited_once()
    recorded = agent.call_llm.call_args.kwargs
    agent._emit_trace_event.assert_awaited_once()
    trace = agent._emit_trace_event.call_args.args[0]
    assert trace["call_id"] == recorded["trace_meta"]["call_id"]
    assert trace["state"] == "error"
    assert trace["reason"] == "non_json_analysis"
    assert _SECRET not in json.dumps(trace)


@pytest.mark.asyncio
async def test_real_json_contract_and_attachments_reach_the_agent_seam() -> None:
    agent = _agent(json.dumps(_BRIEF))
    attachments = [object()]

    result = await agent.process(
        user_input="draw the three loops",
        history_context="background",
        render_mode="html",
        attachments=attachments,
    )

    assert result.render_type == "html"
    recorded = agent.call_llm.call_args.kwargs
    assert recorded["attachments"] is attachments
    assert recorded["response_format"] == {"type": "json_object"}
    assert recorded["stage"] == "analyzing"
    agent._emit_trace_event.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancellation_is_not_transformed_into_analysis_recovery() -> None:
    agent = _agent()
    agent.call_llm.side_effect = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await agent.process(user_input="draw", history_context="")

    agent.call_llm.assert_awaited_once()
    agent._emit_trace_event.assert_not_awaited()


@pytest.mark.asyncio
async def test_provider_exception_is_not_misclassified_as_bad_analysis_json() -> None:
    agent = _agent()
    failure = RuntimeError("provider transport failed")
    agent.call_llm.side_effect = failure

    with pytest.raises(RuntimeError) as raised:
        await agent.process(user_input="draw", history_context="")

    assert raised.value is failure
    agent.call_llm.assert_awaited_once()
    agent._emit_trace_event.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("render_mode", ["manim_video", "manim_image"])
async def test_explicit_manim_routing_never_calls_analysis_model(render_mode: str) -> None:
    agent = _agent(_SECRET)

    result = await agent.process(user_input="animate", history_context="", render_mode=render_mode)

    assert result.render_type == render_mode
    agent.call_llm.assert_not_awaited()
    agent._emit_trace_event.assert_not_awaited()
