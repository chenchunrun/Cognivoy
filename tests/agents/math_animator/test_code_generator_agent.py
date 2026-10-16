"""Regression coverage for bounded Math Animator code generation."""

from __future__ import annotations

import json
from typing import Any

import pytest

from cognivoy.agents.base_agent import BaseAgent
from cognivoy.agents.math_animator.agents.code_generator_agent import CodeGeneratorAgent
from cognivoy.agents.math_animator.models import ConceptAnalysis, SceneDesign


def _analysis() -> ConceptAnalysis:
    return ConceptAnalysis(learning_goal="Explain a quadratic", math_focus=["x^2"])


def _design() -> SceneDesign:
    return SceneDesign(title="Quadratic", scene_outline=["show formula", "plot curve"])


@pytest.mark.asyncio
async def test_generate_retries_once_with_compact_contract_after_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    replies = iter(
        [
            '{"code": "from manim import *',
            json.dumps(
                {
                    "code": "from manim import *\nclass Demo(Scene):\n    def construct(self):\n        pass",
                    "rationale": "concise",
                }
            ),
        ]
    )

    async def _stream_llm(self: BaseAgent, **kwargs: Any):
        calls.append(kwargs)
        yield next(replies)

    monkeypatch.setattr(BaseAgent, "stream_llm", _stream_llm)

    generated = await CodeGeneratorAgent().generate(
        user_input="animate a quadratic",
        output_mode="video",
        analysis=_analysis(),
        design=_design(),
    )

    assert "class Demo" in generated.code
    assert len(calls) == 2
    assert calls[0]["max_tokens"] >= 16_000
    assert calls[0]["reasoning_effort"] == "minimal"
    assert calls[1]["reasoning_effort"] == "minimal"
    assert calls[1]["stage"] == "code_generation_compact_retry"
    assert "at most 160 non-empty Python lines" in calls[1]["system_prompt"]


@pytest.mark.asyncio
async def test_generate_does_not_retry_valid_nonempty_code(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    async def _stream_llm(self: BaseAgent, **kwargs: Any):
        calls.append(kwargs)
        yield json.dumps({"code": "from manim import *\nclass Demo(Scene): pass"})

    monkeypatch.setattr(BaseAgent, "stream_llm", _stream_llm)

    generated = await CodeGeneratorAgent().generate(
        user_input="animate a quadratic",
        output_mode="video",
        analysis=_analysis(),
        design=_design(),
    )

    assert generated.code.startswith("from manim")
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_generate_ignores_schema_placeholder_before_final_scene(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []
    final = {
        "code": (
            "from manim import *\n\n"
            "class FinalScene(Scene):\n"
            "    def construct(self):\n"
            "        self.wait(1)"
        ),
        "rationale": "complete final answer",
    }

    async def _stream_llm(self: BaseAgent, **kwargs: Any):
        calls.append(kwargs)
        yield (
            '<think>The schema is {"code":"full code string",'
            '"rationale":"example"}.</think>\n' + json.dumps(final)
        )

    monkeypatch.setattr(BaseAgent, "stream_llm", _stream_llm)

    generated = await CodeGeneratorAgent().generate(
        user_input="animate a quadratic",
        output_mode="video",
        analysis=_analysis(),
        design=_design(),
    )

    assert "class FinalScene(Scene)" in generated.code
    assert generated.rationale == "complete final answer"
    assert len(calls) == 1


def test_parse_rejects_non_scene_placeholders_and_invalid_python() -> None:
    response = "\n".join(
        [
            json.dumps({"code": "full code string"}),
            json.dumps({"code": "class Broken(Scene):\n  if"}),
        ]
    )

    with pytest.raises(ValueError, match="complete renderable script"):
        CodeGeneratorAgent._parse_generated_code(response, output_mode="video")
