from __future__ import annotations

from types import SimpleNamespace

import pytest

from cognivoy.book.blocks.base import GenerationFailure
from cognivoy.book.blocks.section import SectionGenerator


def _context() -> SimpleNamespace:
    return SimpleNamespace(language="zh")


@pytest.mark.asyncio
async def test_fill_subsection_marks_provider_failure_as_generation_failure(monkeypatch) -> None:
    async def fail_llm_text(**_kwargs):
        raise RuntimeError("invalid api key")

    monkeypatch.setattr("cognivoy.book.blocks.section.llm_text", fail_llm_text)

    with pytest.raises(GenerationFailure, match="invalid api key"):
        await SectionGenerator()._fill_subsection(
            ctx=_context(),
            chapter_title="工具调用",
            section_focus="MCP",
            outline_intro="intro",
            sub={"heading": "能力协商", "role": "core", "focus": "MCP", "target_words": 320},
            chunks=[],
        )


@pytest.mark.asyncio
async def test_fill_subsection_rejects_empty_content(monkeypatch) -> None:
    async def empty_llm_text(**_kwargs):
        return "   "

    monkeypatch.setattr("cognivoy.book.blocks.section.llm_text", empty_llm_text)

    with pytest.raises(GenerationFailure, match="empty content"):
        await SectionGenerator()._fill_subsection(
            ctx=_context(),
            chapter_title="工具调用",
            section_focus="MCP",
            outline_intro="intro",
            sub={"heading": "能力协商", "role": "core", "focus": "MCP", "target_words": 320},
            chunks=[],
        )


@pytest.mark.asyncio
async def test_fill_subsection_adds_markdown_heading(monkeypatch) -> None:
    async def successful_llm_text(**_kwargs):
        return "正文内容完整。" * 40

    monkeypatch.setattr("cognivoy.book.blocks.section.llm_text", successful_llm_text)

    body = await SectionGenerator()._fill_subsection(
        ctx=_context(),
        chapter_title="工具调用",
        section_focus="MCP",
        outline_intro="intro",
        sub={"heading": "能力协商", "role": "core", "focus": "MCP", "target_words": 320},
        chunks=[],
    )

    assert body == f"### 能力协商\n\n{'正文内容完整。' * 40}"


@pytest.mark.asyncio
async def test_fill_subsection_disables_reasoning_and_retries_truncated_output(
    monkeypatch,
) -> None:
    calls: list[dict] = []

    async def retrying_llm_text(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            return "这是一段明显被截断的正文，因为它还没有"
        return "重试后正文完整，覆盖设计、实现、验证与失败恢复。" * 20

    monkeypatch.setattr("cognivoy.book.blocks.section.llm_text", retrying_llm_text)

    body = await SectionGenerator()._fill_subsection(
        ctx=_context(),
        chapter_title="工具调用",
        section_focus="MCP",
        outline_intro="intro",
        sub={"heading": "能力协商", "role": "core", "focus": "MCP", "target_words": 320},
        chunks=[],
    )

    assert len(calls) == 2
    assert all(call["reasoning_effort"] == "minimal" for call in calls)
    assert "The previous attempt was truncated" in calls[1]["user_prompt"]
    assert body.endswith("失败恢复。")


@pytest.mark.asyncio
async def test_fill_subsection_rejects_repeated_truncation(monkeypatch) -> None:
    async def truncated_llm_text(**_kwargs):
        return "内容尚未完成并且"

    monkeypatch.setattr("cognivoy.book.blocks.section.llm_text", truncated_llm_text)

    with pytest.raises(GenerationFailure, match="incomplete content"):
        await SectionGenerator()._fill_subsection(
            ctx=_context(),
            chapter_title="工具调用",
            section_focus="MCP",
            outline_intro="intro",
            sub={"heading": "能力协商", "role": "core", "focus": "MCP", "target_words": 320},
            chunks=[],
        )
