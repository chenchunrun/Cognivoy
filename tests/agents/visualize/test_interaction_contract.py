"""Timeline range checks are deterministic; JS behavior is a browser check."""

from decimal import Decimal

import pytest

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.agents.visualize.agents.code_generator_agent import CodeGeneratorAgent
from cognivoy.agents.visualize.interaction_contract import timeline_contract
from cognivoy.agents.visualize.models import VisualizationAnalysis

REQUEST = "拖动时间轴滑块，7 天循环，30天进入 stale，90天 archived，pinned 免疫。"
ANALYSIS = VisualizationAnalysis(render_type="html")


def slider(maximum="7776000", extra="", step="any"):
    return (
        '<div><input type="range" data-cognivoy-timeline="seconds" '
        f'min="0" max="{maximum}" step="{step}" {extra}></div>'
    )


def test_extracts_all_thresholds_without_confusing_cycle_and_horizon():
    contract = timeline_contract(REQUEST, ANALYSIS)
    assert contract.milestones_seconds == (Decimal(604800), Decimal(2592000), Decimal(7776000))
    assert "7776000" in contract.prompt()
    assert not contract.validate(slider("604800"))[0]
    assert contract.validate(slider())[0]


@pytest.mark.parametrize(
    "prompt,expected",
    [
        ("time slider: 2 hours, 2 weeks, 0.5 seconds", ("0.5", "7200", "1209600")),
        ("时间滑块，过30天变色，90天归档", ("2592000", "7776000")),
        ("拖动时间轴到1毫秒，再到2分钟", ("0.001", "120")),
    ],
)
def test_units_and_unspaced_chinese(prompt, expected):
    assert timeline_contract(prompt, ANALYSIS).milestones_seconds == tuple(map(Decimal, expected))


@pytest.mark.parametrize(
    "prompt",
    [
        "Show a static timeline: 30 days",
        "Make a color slider; 90 days of samples",
        "拖动时间轴看2026年历史",
        "Draw a diagram",
        "timeline slider for 1 month",
    ],
)
def test_unrelated_or_ambiguous_requests_are_unchanged(prompt):
    assert timeline_contract(prompt, ANALYSIS) is None


def test_analysis_cannot_invent_slider_or_duration_contract():
    assert (
        timeline_contract(
            "Explain cycles", VisualizationAnalysis(render_type="html", description=REQUEST)
        )
        is None
    )
    assert timeline_contract(REQUEST, VisualizationAnalysis(render_type="svg")) is None


@pytest.mark.parametrize(
    "html",
    [
        slider("604800"),
        slider("NaN"),
        slider("Infinity"),
        slider("1e999999"),
        slider("7_776_000"),
        slider("٧٧٧٦٠٠٠"),
        slider("604800", extra='max="7776000"'),
        slider(extra="disabled"),
        slider(extra="hidden"),
        slider(step="0"),
        slider(step="2e-999"),
        slider(step="Infinity"),
        slider(step="1000000"),
        slider().replace('min="0"', 'min="1"'),
        slider().replace('data-cognivoy-timeline="seconds"', ""),
        slider().replace('type="range"', "type"),
        "<script>const mock = " + repr(slider()) + ";</script>",
        "<template>" + slider() + "</template>",
        "<noscript>" + slider() + "</noscript>",
        "<div hidden>" + slider() + "</div>",
        "<div inert>" + slider() + "</div>",
        "<fieldset disabled>" + slider() + "</fieldset>",
        "<div hidden/>" + slider() + "</div>",
        "<textarea>" + slider() + "</textarea>",
        slider() + slider(),
    ],
)
def test_rejects_missing_inert_ambiguous_or_unreachable_ranges(html):
    ok, error = timeline_contract(REQUEST, ANALYSIS).validate(html)
    assert not ok
    assert "7776000" in error


@pytest.mark.parametrize("step", ["any", "1", "0.001", "86400"])
def test_explicit_steps_reach_required_milestones(step):
    assert timeline_contract(REQUEST, ANALYSIS).validate(slider(step=step))[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("language", ["en", "zh"])
@pytest.mark.parametrize("simplified", [False, True])
async def test_codegen_preserves_contract_on_both_attempts(monkeypatch, language, simplified):
    calls = []

    async def stream(self, **kwargs):
        calls.append(kwargs)
        yield f"```html\n{slider()}\n```"

    monkeypatch.setattr(BaseAgent, "stream_llm", stream)
    await CodeGeneratorAgent(language=language).process(
        user_input=REQUEST, history_context="", analysis=ANALYSIS, simplified=simplified
    )
    prompt = calls[0]["user_prompt"]
    assert 'data-cognivoy-timeline="seconds"' in prompt
    assert "7776000" in prompt
    assert "2592000" in prompt
    if simplified:
        assert "Never remove explicitly requested controls" in prompt
