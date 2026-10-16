"""Authoritative derived statistics for generated books.

The web library and the reader must consume this single backend contract.
The estimator intentionally separates prose, code, formulae, quizzes, and
interactive blocks because treating every serialized payload character as a
"word" produces misleading reading-time numbers.
"""

from __future__ import annotations

import math
import re
from typing import Any

from pydantic import BaseModel

from cognivoy.book.models import (
    Block,
    BlockStatus,
    BlockType,
    ContentType,
    Page,
    PageStatus,
    Progress,
    SourceAnchor,
    Spine,
)

_CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")
_LATIN_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)
_MARKUP_RE = re.compile(r"```[\s\S]*?```|<[^>]+>|https?://\S+", re.IGNORECASE)
_DECORATION_RE = re.compile(r"[#>*_~`|\[\](){}-]+")
_FORMULA_KEYS = {"formula", "formulas", "latex", "math", "equation", "expression"}
_NON_PROSE_KEYS = {
    "code",
    "html",
    "id",
    "language",
    "url",
    "video_url",
    "filename",
    *_FORMULA_KEYS,
}
_NON_PROSE_BLOCKS = {
    BlockType.CODE,
    BlockType.QUIZ,
    BlockType.INTERACTIVE,
    BlockType.ANIMATION,
}


class BookStatistics(BaseModel):
    chapter_count: int = 0
    page_count: int = 0
    ready_page_count: int = 0
    block_count: int = 0
    content_units: int = 0
    code_line_count: int = 0
    formula_count: int = 0
    quiz_count: int = 0
    interactive_count: int = 0
    source_count: int = 0
    estimated_reading_minutes: int = 0
    visited_page_count: int = 0
    reading_progress_percent: int = 0


def _collect_strings(value: Any, *, parent_key: str = "") -> list[str]:
    if parent_key.lower() in _NON_PROSE_KEYS:
        return []
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped or stripped.lower().startswith(("http:", "https:", "data:", "blob:")):
            return []
        return [stripped]
    if isinstance(value, list):
        return [text for item in value for text in _collect_strings(item, parent_key=parent_key)]
    if isinstance(value, dict):
        return [
            text
            for key, item in value.items()
            for text in _collect_strings(item, parent_key=str(key))
        ]
    return []


def _prose_units(block: Block) -> int:
    if block.type in _NON_PROSE_BLOCKS:
        return 0
    text = " ".join(_collect_strings(block.payload))
    cleaned = _DECORATION_RE.sub(" ", _MARKUP_RE.sub(" ", text))
    cjk_count = len(_CJK_RE.findall(cleaned))
    latin_text = _CJK_RE.sub(" ", cleaned)
    latin_count = sum(
        1 for word in _LATIN_WORD_RE.findall(latin_text) if any(ch.isalnum() for ch in word)
    )
    return cjk_count + latin_count


def _code_lines(block: Block) -> int:
    if block.type != BlockType.CODE:
        return 0
    code = block.payload.get("code")
    if not isinstance(code, str):
        return 0
    return sum(1 for line in code.splitlines() if line.strip())


def _formula_count(value: Any, *, parent_key: str = "") -> int:
    if parent_key.lower() in _FORMULA_KEYS:
        if isinstance(value, str):
            return int(bool(value.strip()))
        if isinstance(value, list):
            return sum(int(bool(str(item).strip())) for item in value)
    if isinstance(value, dict):
        return sum(_formula_count(item, parent_key=str(key)) for key, item in value.items())
    if isinstance(value, list):
        return sum(_formula_count(item, parent_key=parent_key) for item in value)
    return 0


def _source_key(anchor: SourceAnchor) -> tuple[str, str] | None:
    kind = anchor.kind.strip()
    ref = anchor.ref.strip()
    if not kind or not ref:
        return None
    return kind, ref


def calculate_book_statistics(
    *,
    pages: list[Page],
    spine: Spine | None,
    progress: Progress,
) -> BookStatistics:
    content_pages = [page for page in pages if page.content_type != ContentType.OVERVIEW]
    blocks = [
        block
        for page in content_pages
        for block in page.blocks
        if block.status not in {BlockStatus.HIDDEN, BlockStatus.ERROR}
    ]
    chapter_count = len(
        [
            chapter
            for chapter in (spine.chapters if spine else [])
            if chapter.content_type != ContentType.OVERVIEW
        ]
    )
    if chapter_count == 0:
        chapter_count = len({page.chapter_id for page in content_pages if page.chapter_id})

    content_units = sum(_prose_units(block) for block in blocks)
    code_line_count = sum(_code_lines(block) for block in blocks)
    formula_count = sum(_formula_count(block.payload) for block in blocks)
    quiz_count = sum(block.type == BlockType.QUIZ for block in blocks)
    interactive_count = sum(block.type == BlockType.INTERACTIVE for block in blocks)

    source_keys: set[tuple[str, str]] = set()
    for chapter in spine.chapters if spine else []:
        for anchor in chapter.source_anchors:
            if key := _source_key(anchor):
                source_keys.add(key)
    for block in blocks:
        for anchor in block.source_anchors:
            if key := _source_key(anchor):
                source_keys.add(key)

    # A content unit is one CJK character or one Latin/numeric word.  The
    # weighted additions make active learning effort visible without inflating
    # the displayed prose count.
    estimated_minutes = (
        content_units / 300
        + code_line_count / 20
        + formula_count * 0.5
        + quiz_count * 1.5
        + interactive_count * 2.0
    )
    visited = set(progress.visited_page_ids)
    visited_page_count = sum(page.id in visited for page in content_pages)
    page_count = len(content_pages)

    return BookStatistics(
        chapter_count=chapter_count,
        page_count=page_count,
        ready_page_count=sum(page.status == PageStatus.READY for page in content_pages),
        block_count=len(blocks),
        content_units=content_units,
        code_line_count=code_line_count,
        formula_count=formula_count,
        quiz_count=quiz_count,
        interactive_count=interactive_count,
        source_count=len(source_keys),
        estimated_reading_minutes=math.ceil(estimated_minutes) if estimated_minutes > 0 else 0,
        visited_page_count=visited_page_count,
        reading_progress_percent=(
            round(visited_page_count / page_count * 100) if page_count else 0
        ),
    )


__all__ = ["BookStatistics", "calculate_book_statistics"]
