"""Artifact success is not the same as returning a renderable failure card."""

import asyncio
from types import SimpleNamespace

import pytest

from cognivoy.agents.visualize.analysis import VisualizationAnalysisError
from cognivoy.agents.visualize.capability import VisualizeCapability
from cognivoy.agents.visualize.generation import VisualizationGenerationError
from cognivoy.agents.visualize.models import VisualizationAnalysis
from cognivoy.agents.visualize.utils import build_fallback_html, validate_visualization
from cognivoy.core.context import UnifiedContext
from cognivoy.core.errors import CapabilityGenerationError
from cognivoy.core.stream import StreamEventType
from cognivoy.core.stream_bus import StreamBus
from tests.agents.visualize.test_interaction_contract import REQUEST, slider

SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="5"/></svg>'
FORMATS = {
    "svg": SVG,
    "chartjs": '{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}',
    "mermaid": "graph TD\n A-->B",
    "html": '<div><svg viewBox="0 0 20 20"><circle r="5"/></svg></div>',
}


@pytest.fixture
def harness(monkeypatch):
    state = SimpleNamespace(
        calls=[], stages={}, finished=[], replies=[SVG], render_type="svg", analysis_error=None
    )

    class Checkpoint:
        def __init__(self, *_a, **_kw):
            pass

        def start(self, **_kw):
            return {"status": "running", "resume_count": int(bool(state.stages))}

        def load_stage(self, stage):
            return state.stages.get(stage)

        def save_stage(self, stage, value):
            state.stages[stage] = value

        def finish(self, *, status):
            state.finished.append(status)

    class Pipeline:
        def __init__(self, **_kw):
            pass

        async def run_analysis(self, **_kw):
            if state.analysis_error:
                raise state.analysis_error
            return VisualizationAnalysis(render_type=state.render_type, description="A diagram")

        async def run_code_generation(self, **kw):
            state.calls.append(kw)
            reply = state.replies.pop(0)
            if isinstance(reply, BaseException):
                raise reply
            return reply

    monkeypatch.setattr(
        "cognivoy.services.session.stage_checkpoint.StageCheckpointStore", Checkpoint
    )
    monkeypatch.setattr("cognivoy.agents.visualize.pipeline.VisualizePipeline", Pipeline)
    monkeypatch.setattr(
        "cognivoy.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(
            model="test", api_key="test", base_url="http://invalid", api_version="v1"
        ),
    )
    return state


async def run(bus, **kwargs):
    context = UnifiedContext(user_message="Draw a diagram", language="en", **kwargs)
    await VisualizeCapability().run(context, bus)


def result(bus):
    return next(e.metadata for e in bus.history() if e.type == StreamEventType.RESULT)


@pytest.mark.asyncio
@pytest.mark.parametrize("format", FORMATS)
async def test_normal_graphic_success(harness, format):
    harness.render_type = format
    harness.replies = [FORMATS[format]]
    bus = StreamBus()
    await run(bus)
    assert result(bus)["render_type"] == format
    assert result(bus)["generation"] == {
        "status": "completed",
        "attempts": 1,
        "simplified": False,
        "requested_render_type": format,
    }
    assert harness.finished == ["completed"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "first",
    [
        TimeoutError(),
        "",
        "not code",
        build_fallback_html(title="failed", note="Generation timed out; showing a safe fallback."),
    ],
)
async def test_one_simplified_retry_after_failed_generation(harness, first):
    harness.replies = [first, SVG]
    bus = StreamBus()
    await run(bus)
    assert len(harness.calls) == 2
    assert not harness.calls[0].get("simplified")
    assert harness.calls[1]["simplified"] is True
    assert result(bus)["code"]["content"] == SVG
    assert result(bus)["generation"]["attempts"] == 2
    assert harness.stages["generating"]["code"] == SVG


@pytest.mark.asyncio
@pytest.mark.parametrize("format", FORMATS)
async def test_failed_retry_emits_no_success_or_checkpoint(harness, format):
    harness.render_type = format
    harness.replies = [TimeoutError(), "not a diagram"]
    bus = StreamBus()
    with pytest.raises(CapabilityGenerationError):
        await run(bus)
    assert harness.finished == ["failed"]
    assert set(harness.stages) == {"analyzing"}
    assert len(harness.calls) == 2
    assert not any(
        e.type in (StreamEventType.CONTENT, StreamEventType.RESULT) for e in bus.history()
    )
    assert not any(
        e.content in ("Code generated.", "Passed local format checks.") for e in bus.history()
    )


@pytest.mark.asyncio
async def test_cancellation_never_retries_or_completes(harness):
    harness.replies = [asyncio.CancelledError()]
    with pytest.raises(asyncio.CancelledError):
        await run(StreamBus())
    assert len(harness.calls) == 1
    assert harness.finished == ["cancelled"]
    assert "generating" not in harness.stages


@pytest.mark.asyncio
async def test_legacy_fallback_checkpoint_is_not_reused(harness):
    fallback = build_fallback_html(
        title="old", note="Generation timed out; showing a safe fallback."
    )
    harness.stages = {
        "analyzing": {
            "analysis": VisualizationAnalysis(
                render_type="svg", description="Recovered"
            ).model_dump()
        },
        "generating": {"render_type": "html", "code": fallback},
        "reviewing": {
            "render_type": "html",
            "final_code": fallback,
            "review": {"optimized_code": fallback},
        },
    }
    bus = StreamBus()
    await run(bus)
    assert len(harness.calls) == 1
    assert result(bus)["render_type"] == "svg"
    assert result(bus)["code"]["content"] == SVG


@pytest.mark.asyncio
async def test_analysis_timeout_keeps_explicit_format(harness):
    harness.analysis_error = TimeoutError()
    harness.replies = [FORMATS["mermaid"]]
    bus = StreamBus()
    await run(bus, config_overrides={"render_mode": "mermaid"})
    assert result(bus)["render_type"] == "mermaid"
    assert harness.calls[0]["analysis"].render_type == "mermaid"


@pytest.mark.asyncio
async def test_exhausted_total_budget_does_not_start_generation(harness, monkeypatch):
    monkeypatch.setattr("cognivoy.runtime.orchestrator._turn_timeout_seconds", lambda *_a: 5)
    with pytest.raises(CapabilityGenerationError):
        await run(StreamBus())
    assert harness.calls == []
    assert harness.finished == ["failed"]


def test_legacy_template_rejected_but_discussion_of_timeouts_allowed():
    assert not validate_visualization(
        build_fallback_html(title="old", note="Generation timed out; showing a safe fallback."),
        "html",
    )[0]
    assert validate_visualization(
        "<div>Diagram about timeout and safe fallback strategies.</div>", "html"
    )[0]


@pytest.mark.asyncio
async def test_short_timeline_gets_one_retry_with_specific_feedback(harness):
    harness.render_type = "html"
    harness.replies = [slider("604800"), slider()]
    bus = StreamBus()
    await VisualizeCapability().run(UnifiedContext(user_message=REQUEST, language="en"), bus)
    assert len(harness.calls) == 2
    assert "7776000" in harness.calls[1]["render_constraints"]
    assert result(bus)["code"]["content"] == slider()


@pytest.mark.asyncio
async def test_invalid_timeline_retry_never_emits_completed_result(harness):
    harness.render_type = "html"
    harness.replies = [slider("604800"), slider("604800")]
    bus = StreamBus()
    with pytest.raises(CapabilityGenerationError):
        await VisualizeCapability().run(UnifiedContext(user_message=REQUEST, language="en"), bus)
    assert len(harness.calls) == 2
    assert harness.finished == ["failed"]
    assert "generating" not in harness.stages
    assert not any(
        e.type in (StreamEventType.CONTENT, StreamEventType.RESULT) for e in bus.history()
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid_stage", ["generating", "reviewing"])
async def test_short_timeline_cannot_bypass_contract_via_checkpoint(harness, invalid_stage):
    harness.stages = {
        "analyzing": {"analysis": VisualizationAnalysis(render_type="html").model_dump()},
        "generating": {
            "render_type": "html",
            "code": slider("604800") if invalid_stage == "generating" else slider(),
        },
        "reviewing": {
            "render_type": "html",
            "final_code": slider("604800"),
            "review": {"optimized_code": slider("604800")},
        },
    }
    harness.replies = [slider()]
    bus = StreamBus()
    await VisualizeCapability().run(UnifiedContext(user_message=REQUEST, language="en"), bus)
    assert result(bus)["code"]["content"] == slider()
    assert len(harness.calls) == (1 if invalid_stage == "generating" else 0)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reason", ["first_response_timeout", "idle_timeout", "total_timeout", "output_limit"]
)
async def test_precise_generation_failure_reason_is_preserved(harness, reason):
    harness.replies = [
        VisualizationGenerationError(reason, 12),
        VisualizationGenerationError(reason, 20),
    ]
    with pytest.raises(CapabilityGenerationError) as caught:
        await run(StreamBus())
    assert caught.value.reason == reason


@pytest.mark.asyncio
async def test_old_analysis_checkpoint_cannot_override_explicit_format(harness):
    harness.render_type = "mermaid"
    harness.stages["analyzing"] = {
        "analysis": VisualizationAnalysis(render_type="html", description="old").model_dump()
    }
    harness.replies = [FORMATS["mermaid"]]
    bus = StreamBus()
    await run(bus, config_overrides={"render_mode": "mermaid"})
    assert result(bus)["render_type"] == "mermaid"


@pytest.mark.asyncio
async def test_code_progress_does_not_leak_source_into_thinking():
    bus = StreamBus()
    bridge = VisualizeCapability()._build_trace_bridge(bus)
    for i in range(20):
        await bridge(
            {
                "event": "llm_call",
                "state": "streaming",
                "call_kind": "viz_code_generation",
                "call_id": "c",
                "phase": "generating",
                "chunk": "<svg>secret partial</svg>",
            }
        )
    assert len(bus.history()) == 1
    assert all(e.type != StreamEventType.THINKING for e in bus.history())
    assert "secret partial" not in str(bus.history())


@pytest.mark.asyncio
@pytest.mark.parametrize("format", ["auto", *FORMATS])
@pytest.mark.parametrize(
    "reason", ["empty_analysis", "non_json_analysis", "invalid_analysis_schema"]
)
async def test_bad_analysis_recovers_from_original_request(harness, format, reason):
    harness.analysis_error = VisualizationAnalysisError(reason)
    expected_format = "svg" if format == "auto" else format
    harness.replies = [FORMATS[expected_format]]
    bus = StreamBus()
    await run(bus, config_overrides={"render_mode": format})
    payload = result(bus)
    assert payload["render_type"] == expected_format
    assert payload["code"]["content"] == FORMATS[expected_format]
    assert payload["analysis_recovery"] == {"reason": reason, "strategy": "original_request"}
    assert harness.calls[0]["analysis"].description == "Draw a diagram"
    assert harness.stages["analyzing"]["recovery"] == payload["analysis_recovery"]
    assert harness.finished == ["completed"]
    assert any(e.metadata.get("reason") == reason for e in bus.history())


@pytest.mark.asyncio
async def test_bad_analysis_and_failed_generation_never_become_success(harness):
    harness.analysis_error = VisualizationAnalysisError("non_json_analysis")
    harness.replies = ["not code", "still not code"]
    bus = StreamBus()
    with pytest.raises(CapabilityGenerationError) as caught:
        await run(bus)
    assert caught.value.reason == "invalid_visualization"
    assert harness.finished == ["failed"]
    assert not any(e.type == StreamEventType.RESULT for e in bus.history())


@pytest.mark.asyncio
async def test_analysis_provider_error_is_safe_and_does_not_trigger_generation(harness):
    harness.analysis_error = RuntimeError("provider secret-token raw-payload")
    bus = StreamBus()
    with pytest.raises(CapabilityGenerationError) as caught:
        await run(bus)
    assert caught.value.reason == "analysis_provider_failed"
    assert "secret-token" not in str(caught.value)
    assert harness.calls == []
    assert harness.finished == ["failed"]
    assert harness.stages == {}


@pytest.mark.asyncio
async def test_analysis_cancellation_is_not_recovered(harness):
    harness.analysis_error = asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError):
        await run(StreamBus())
    assert harness.calls == []
    assert harness.finished == ["cancelled"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad",
    [
        [],
        ["bad"],
        {"description": []},
        {"render_type": "svg", "description": []},
        {"render_type": ["svg"]},
        {"render_type": "svg", "visual_genre": {"invalid": True}},
    ],
)
async def test_invalid_analysis_checkpoint_is_reanalyzed(harness, bad):
    harness.stages["analyzing"] = {"analysis": bad}
    bus = StreamBus()
    await run(bus)
    assert result(bus)["analysis"]["description"] == "A diagram"
    assert harness.finished == ["completed"]


@pytest.mark.asyncio
async def test_analysis_raw_response_is_not_shown_as_learner_thinking():
    bus = StreamBus()
    bridge = VisualizeCapability()._build_trace_bridge(bus)
    for state in ("streaming", "complete"):
        await bridge(
            {
                "event": "llm_call",
                "state": state,
                "call_kind": "viz_analysis",
                "call_id": "analysis",
                "phase": "analyzing",
                "chunk": "internal reasoning",
                "response": "unparsed internal reasoning",
            }
        )
    assert not any(e.type == StreamEventType.THINKING for e in bus.history())
    assert "internal reasoning" not in str(bus.history())


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "raw",
    [
        "",
        "<think>Plan the diagram</think>",
        "plain prose instead of JSON",
        '{"description":[]}',
        '{"render_type":"html","description":"Show "three stages" separately"}',
    ],
)
async def test_real_analysis_and_generation_pipeline_recovers_contract_error(
    monkeypatch, tmp_path, raw
):
    """Keep both real agents and parsing; replace only the model transport."""
    from cognivoy.agents.base_agent import BaseAgent
    from cognivoy.services.session.stage_checkpoint import StageCheckpointStore

    calls = []

    async def complete(self, **kwargs):
        calls.append("analysis")
        return raw

    async def stream_llm(self, **kwargs):
        calls.append("generation")
        yield SVG

    monkeypatch.setattr(BaseAgent, "call_llm", complete)
    monkeypatch.setattr(BaseAgent, "stream_llm", stream_llm)
    monkeypatch.setattr(
        "cognivoy.services.session.stage_checkpoint.StageCheckpointStore",
        lambda capability, turn: StageCheckpointStore(capability, turn, root=tmp_path),
    )
    bus = StreamBus()
    await run(bus)
    assert result(bus)["code"]["content"] == SVG
    assert result(bus)["analysis_recovery"]["strategy"] == "original_request"
    assert calls == ["analysis", "generation"]
