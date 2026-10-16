from __future__ import annotations

import pytest

from cognivoy.book.blocks.base import BlockContext
from cognivoy.book.blocks.callout import CalloutGenerator
from cognivoy.book.models import Block, BlockStatus, BlockType, Chapter, Page


@pytest.mark.asyncio
async def test_empty_model_call_uses_chapter_scoped_fallback(monkeypatch) -> None:
    async def empty_llm_text(**_kwargs) -> str:
        return ""

    monkeypatch.setattr("cognivoy.book.blocks.callout.llm_text", empty_llm_text)
    chapter = Chapter(
        id="chapter-1",
        title="工具调用",
        learning_objectives=["理解工具契约与失败边界"],
    )
    page = Page(id="page-1", book_id="book-1", chapter_id=chapter.id)
    block = Block(type=BlockType.CALLOUT, params={"variant": "common_pitfall"})
    context = BlockContext(
        book_id="book-1",
        chapter=chapter,
        page=page,
        block=block,
        language="zh",
        rag_enabled=False,
    )

    generated = await CalloutGenerator().generate(context)

    assert generated.status == BlockStatus.READY
    assert generated.payload["body"]
    assert "工具契约与失败边界" in generated.payload["body"]
    assert generated.metadata["degraded"] is True


def test_fallback_variants_are_localized_and_non_empty() -> None:
    for variant in ("key_idea", "common_pitfall", "summary", "tip"):
        body = CalloutGenerator._fallback_body(
            variant=variant,
            chapter_title="Agent runtime",
            chapter_summary="",
            objectives=["Recover interrupted work"],
            language="en",
        )
        assert body
        assert "Recover interrupted work" in body
