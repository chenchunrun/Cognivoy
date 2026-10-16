"""Only final answer code, never a fenced reasoning draft, is an artifact."""

import pytest

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.agents.visualize.agents.code_generator_agent import CodeGeneratorAgent
from cognivoy.agents.visualize.models import VisualizationAnalysis

HTML = '<!DOCTYPE html><html><head><title>Diagram</title></head><body><svg viewBox="0 0 20 20"><circle r="5"/></svg></body></html>'
SVG = '<svg viewBox="0 0 20 20"><circle r="5"/></svg>'
CASES = {
    "html": ("html", HTML),
    "svg": ("svg", SVG),
    "chartjs": ("javascript", '{"type":"bar","data":{"labels":["A"],"datasets":[{"data":[1]}]}}'),
    "mermaid": ("mermaid", "graph TD\n A-->B"),
}


@pytest.mark.asyncio
@pytest.mark.parametrize("format", CASES)
async def test_fenced_reasoning_draft_is_not_extracted(monkeypatch, format):
    language, final = CASES[format]
    raw = f"<think>Draft example:\n```{language}\n<style>...</style>\n```\n</think>\n```{language}\n{final}\n```"

    async def stream(self, **kwargs):
        # Exercise markers split across transport chunks.
        for index in range(0, len(raw), 7):
            yield raw[index : index + 7]

    monkeypatch.setattr(BaseAgent, "stream_llm", stream)
    code = await CodeGeneratorAgent().process(
        user_input="Show the relationship",
        history_context="",
        analysis=VisualizationAnalysis(render_type=format),
    )
    assert code == final
    assert "Draft example" not in code


@pytest.mark.asyncio
@pytest.mark.parametrize("close", ["</think>", ""])
async def test_reasoning_only_stream_never_becomes_generated_code(monkeypatch, close):
    async def stream(self, **kwargs):
        yield f"<think>```html\n{HTML}\n```{close}"

    monkeypatch.setattr(BaseAgent, "stream_llm", stream)
    code = await CodeGeneratorAgent().process(
        user_input="Show the relationship",
        history_context="",
        analysis=VisualizationAnalysis(render_type="html"),
    )
    assert code == ""


@pytest.mark.asyncio
async def test_later_corrected_block_is_used_instead_of_initial_sketch(monkeypatch):
    async def stream(self, **kwargs):
        yield f"```html\n<style>...</style>\n```\nFinal:\n```html\n{HTML}\n```"

    monkeypatch.setattr(BaseAgent, "stream_llm", stream)
    code = await CodeGeneratorAgent().process(
        user_input="Show the relationship",
        history_context="",
        analysis=VisualizationAnalysis(render_type="html"),
    )
    assert code == HTML


@pytest.mark.asyncio
async def test_unclosed_final_fence_never_falls_back_to_old_complete_draft(monkeypatch):
    async def stream(self, **kwargs):
        yield f"```html\n{HTML}\n```\nCorrected final:\n```html\n<div>unfinished"

    monkeypatch.setattr(BaseAgent, "stream_llm", stream)
    code = await CodeGeneratorAgent().process(
        user_input="Show the relationship",
        history_context="",
        analysis=VisualizationAnalysis(render_type="html"),
    )
    assert code == ""
