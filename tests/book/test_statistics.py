from __future__ import annotations

import time

import pytest

from cognivoy.book.models import (
    Block,
    BlockStatus,
    BlockType,
    Book,
    Chapter,
    ContentType,
    Page,
    PageStatus,
    Progress,
    SourceAnchor,
    Spine,
)
from cognivoy.book.statistics import calculate_book_statistics


class _BookEngineStub:
    def __init__(self) -> None:
        self.book = Book(id="book-1", title="Test book")
        self.pages = [
            Page(
                id="page-1",
                book_id="book-1",
                chapter_id="chapter-1",
                status=PageStatus.READY,
                blocks=[
                    Block(
                        type=BlockType.TEXT,
                        status=BlockStatus.READY,
                        payload={"text": "hello world"},
                    )
                ],
            )
        ]
        self.spine = Spine(book_id="book-1", chapters=[Chapter(id="chapter-1", title="One")])
        self.progress = Progress(book_id="book-1", visited_page_ids=["page-1"])

    def list_books(self):
        return [self.book]

    async def ensure_legacy_overview(self, _book_id: str) -> bool:
        return False

    def list_pages(self, _book_id: str):
        return self.pages

    def load_spine(self, _book_id: str):
        return self.spine

    def load_progress(self, _book_id: str):
        return self.progress


def test_book_statistics_exclude_overview_and_separate_learning_effort() -> None:
    pages = [
        Page(
            id="overview",
            book_id="book-1",
            chapter_id="overview",
            content_type=ContentType.OVERVIEW,
            status=PageStatus.READY,
            blocks=[
                Block(
                    type=BlockType.TEXT, status=BlockStatus.READY, payload={"text": "not content"}
                )
            ],
        ),
        Page(
            id="page-1",
            book_id="book-1",
            chapter_id="chapter-1",
            content_type=ContentType.THEORY,
            status=PageStatus.READY,
            blocks=[
                Block(
                    type=BlockType.TEXT,
                    status=BlockStatus.READY,
                    payload={"text": "你好 world lesson", "latex": "x^2 + y^2 = z^2"},
                    source_anchors=[SourceAnchor(kind="kb", ref="doc-1")],
                ),
                Block(
                    type=BlockType.CODE,
                    status=BlockStatus.READY,
                    payload={"code": "first = 1\nsecond = 2\nthird = first + second"},
                ),
                Block(type=BlockType.QUIZ, status=BlockStatus.READY, payload={"question": "Why?"}),
                Block(
                    type=BlockType.INTERACTIVE,
                    status=BlockStatus.READY,
                    payload={"html": "<button>Run</button>"},
                ),
                Block(type=BlockType.TEXT, status=BlockStatus.ERROR, payload={"text": "ignored"}),
                Block(type=BlockType.TEXT, status=BlockStatus.HIDDEN, payload={"text": "hidden"}),
            ],
        ),
    ]
    spine = Spine(
        book_id="book-1",
        chapters=[
            Chapter(id="overview", title="Overview", content_type=ContentType.OVERVIEW),
            Chapter(
                id="chapter-1",
                title="Chapter one",
                source_anchors=[
                    SourceAnchor(kind="kb", ref="doc-1"),
                    SourceAnchor(kind="web", ref="page-a"),
                ],
            ),
        ],
    )
    progress = Progress(book_id="book-1", visited_page_ids=["overview", "page-1"])

    stats = calculate_book_statistics(pages=pages, spine=spine, progress=progress)

    assert stats.chapter_count == 1
    assert stats.page_count == 1
    assert stats.ready_page_count == 1
    assert stats.block_count == 4
    assert stats.content_units == 4  # 2 CJK characters + 2 Latin words
    assert stats.code_line_count == 3
    assert stats.formula_count == 1
    assert stats.quiz_count == 1
    assert stats.interactive_count == 1
    assert stats.source_count == 2
    assert stats.visited_page_count == 1
    assert stats.reading_progress_percent == 100
    assert stats.estimated_reading_minutes >= 4


def test_book_statistics_empty_book_is_zero_and_never_divides_by_zero() -> None:
    stats = calculate_book_statistics(
        pages=[],
        spine=Spine(book_id="book-1"),
        progress=Progress(book_id="book-1"),
    )

    assert stats.model_dump(mode="json") == {
        "chapter_count": 0,
        "page_count": 0,
        "ready_page_count": 0,
        "block_count": 0,
        "content_units": 0,
        "code_line_count": 0,
        "formula_count": 0,
        "quiz_count": 0,
        "interactive_count": 0,
        "source_count": 0,
        "estimated_reading_minutes": 0,
        "visited_page_count": 0,
        "reading_progress_percent": 0,
    }


@pytest.mark.asyncio
async def test_list_books_embeds_authoritative_statistics(monkeypatch) -> None:
    from cognivoy.api.routers import book as book_router

    monkeypatch.setattr(book_router, "get_book_engine", lambda: _BookEngineStub())

    result = await book_router.list_books()

    assert result["books"][0]["statistics"] == {
        "chapter_count": 1,
        "page_count": 1,
        "ready_page_count": 1,
        "block_count": 1,
        "content_units": 2,
        "code_line_count": 0,
        "formula_count": 0,
        "quiz_count": 0,
        "interactive_count": 0,
        "source_count": 0,
        "estimated_reading_minutes": 1,
        "visited_page_count": 1,
        "reading_progress_percent": 100,
    }
    assert result["total"] == 1
    assert result["limit"] == 24
    assert result["offset"] == 0


@pytest.mark.asyncio
async def test_list_books_paginates_before_loading_expensive_statistics(monkeypatch) -> None:
    from cognivoy.api.routers import book as book_router

    class ManyBooksEngine(_BookEngineStub):
        def __init__(self) -> None:
            super().__init__()
            self.books = [
                Book(id=f"book-{index}", title=f"Book {index:02d}", updated_at=float(index))
                for index in range(30)
            ]
            self.statistics_calls: list[str] = []

        def list_books(self):
            return self.books

        def list_pages(self, book_id: str):
            self.statistics_calls.append(book_id)
            return []

        def load_spine(self, book_id: str):
            return Spine(book_id=book_id)

        def load_progress(self, book_id: str):
            return Progress(book_id=book_id)

    engine = ManyBooksEngine()
    monkeypatch.setattr(book_router, "get_book_engine", lambda: engine)

    result = await book_router.list_books(q="Book 2", sort="title", limit=3, offset=2)

    assert result["total"] == 10
    assert result["limit"] == 3
    assert result["offset"] == 2
    assert [book["id"] for book in result["books"]] == ["book-22", "book-23", "book-24"]
    assert engine.statistics_calls == ["book-22", "book-23", "book-24"]


@pytest.mark.asyncio
async def test_thousand_book_library_keeps_expensive_work_page_bounded(
    monkeypatch,
) -> None:
    from cognivoy.api.routers import book as book_router

    class ThousandBooksEngine(_BookEngineStub):
        def __init__(self) -> None:
            super().__init__()
            self.books = [
                Book(
                    id=f"book-{index}",
                    title=f"Book {index:04d}",
                    updated_at=float(index),
                )
                for index in range(1_000)
            ]
            self.statistics_calls: list[str] = []

        def list_books(self):
            return self.books

        def list_pages(self, book_id: str):
            self.statistics_calls.append(book_id)
            return []

        def load_spine(self, book_id: str):
            return Spine(book_id=book_id)

        def load_progress(self, book_id: str):
            return Progress(book_id=book_id)

    engine = ThousandBooksEngine()
    monkeypatch.setattr(book_router, "get_book_engine", lambda: engine)

    started = time.perf_counter()
    result = await book_router.list_books(limit=24, offset=480)
    elapsed = time.perf_counter() - started

    assert result["total"] == 1_000
    assert len(result["books"]) == 24
    assert len(engine.statistics_calls) == 24
    assert elapsed < 2.0


@pytest.mark.asyncio
async def test_rebuild_preview_endpoint_is_read_only(monkeypatch) -> None:
    from cognivoy.api.routers import book as book_router

    class PreviewEngine:
        def preview_rebuild(self, book_id: str):
            assert book_id == "book-1"
            return {
                "book_id": book_id,
                "page_count": 2,
                "generated_block_count": 6,
                "user_note_count": 1,
                "preserves_user_notes": True,
                "preserves_learning_state": True,
            }

    monkeypatch.setattr(book_router, "get_book_engine", lambda: PreviewEngine())

    result = await book_router.preview_rebuild_book(
        book_router.RebuildBookRequest(book_id="book-1", auto_compile=False)
    )

    assert result["page_count"] == 2
    assert result["user_note_count"] == 1
