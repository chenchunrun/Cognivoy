from __future__ import annotations

import pytest

from cognivoy.book.engine import BookEngine
from cognivoy.book.models import (
    Block,
    BlockStatus,
    BlockType,
    Book,
    BookStatus,
    Chapter,
    ContentType,
    Page,
    PageStatus,
    Progress,
    Spine,
)


def test_force_compile_reset_preserves_user_notes() -> None:
    generated = Block(
        type=BlockType.CODE,
        status=BlockStatus.READY,
        payload={"code": "print(1)"},
        source_anchors=[],
        metadata={"generation_ms": 10, "transition_in": "bridge"},
    )
    note = Block(
        type=BlockType.USER_NOTE,
        status=BlockStatus.READY,
        payload={"body": "keep me"},
    )
    page = Page(status=PageStatus.READY, error="", blocks=[generated, note])

    BookEngine._reset_page_for_force_compile(page)

    assert page.status == PageStatus.PENDING
    assert generated.status == BlockStatus.PENDING
    assert generated.payload == {}
    assert generated.error == ""
    assert generated.metadata == {"transition_in": "bridge"}
    assert note.status == BlockStatus.READY
    assert note.payload == {"body": "keep me"}


class _RecordingStorage:
    """Minimal stand-in for BookStorage: records or refuses save_page calls."""

    def __init__(self, fail: bool = False):
        self.saved: list[Page] = []
        self.fail = fail

    def save_page(self, page: Page) -> None:
        if self.fail:
            raise OSError("disk full")
        self.saved.append(page)


def _engine_with_storage(storage: _RecordingStorage) -> BookEngine:
    engine = BookEngine.__new__(BookEngine)
    engine.storage = storage
    return engine


def test_mark_page_error_resets_generating_page() -> None:
    storage = _RecordingStorage()
    engine = _engine_with_storage(storage)
    page = Page(status=PageStatus.GENERATING)

    engine._mark_page_error(page, RuntimeError("llm timeout"), prefix="Compilation failed")

    assert page.status == PageStatus.ERROR
    assert "llm timeout" in page.error
    assert storage.saved == [page]


def test_mark_page_error_resets_planning_page() -> None:
    storage = _RecordingStorage()
    engine = _engine_with_storage(storage)
    page = Page(status=PageStatus.PLANNING)

    engine._mark_page_error(page, RuntimeError("planner crashed"), prefix="Compilation failed")

    assert page.status == PageStatus.ERROR
    assert "planner crashed" in page.error
    assert storage.saved == [page]


def test_mark_page_error_ignores_missing_or_settled_pages() -> None:
    storage = _RecordingStorage()
    engine = _engine_with_storage(storage)

    engine._mark_page_error(None, RuntimeError("boom"), prefix="x")
    ready = Page(status=PageStatus.READY)
    engine._mark_page_error(ready, RuntimeError("boom"), prefix="x")

    assert storage.saved == []
    assert ready.status == PageStatus.READY


def test_mark_page_error_survives_save_failure() -> None:
    engine = _engine_with_storage(_RecordingStorage(fail=True))
    page = Page(status=PageStatus.GENERATING)

    # Runs inside exception handlers (worker loop) — must never raise.
    engine._mark_page_error(page, RuntimeError("boom"), prefix="x")

    assert page.status == PageStatus.ERROR


class _RebuildStorage:
    def __init__(self) -> None:
        self.book = Book(
            id="book-1",
            status=BookStatus.READY,
            metadata={"page_chat_sessions": {"old-page": "chat-1"}},
        )
        self.spine = Spine(
            book_id="book-1",
            chapters=[Chapter(id="chapter-1", title="Chapter one", page_ids=["old-page"])],
        )
        self.pages = {
            "old-page": Page(
                id="old-page",
                book_id="book-1",
                chapter_id="chapter-1",
                title="Old page",
                status=PageStatus.READY,
                blocks=[
                    Block(type=BlockType.TEXT, status=BlockStatus.READY, payload={"text": "old"}),
                    Block(
                        id="note-1",
                        type=BlockType.USER_NOTE,
                        status=BlockStatus.READY,
                        payload={"body": "Do not lose this note"},
                    ),
                ],
            )
        }
        self.progress = Progress(
            book_id="book-1",
            current_page_id="old-page",
            visited_page_ids=["old-page"],
            bookmarked_page_ids=["old-page"],
            score=7,
        )

    def load_book(self, _book_id):
        return self.book

    def load_spine(self, _book_id):
        return self.spine

    def list_pages(self, _book_id):
        return list(self.pages.values())

    def load_progress(self, _book_id):
        return self.progress

    def save_progress(self, progress):
        self.progress = progress

    def save_book(self, book):
        self.book = book

    def save_spine(self, spine):
        self.spine = spine

    def save_page(self, page):
        self.pages[page.id] = page

    def delete_page(self, _book_id, page_id):
        self.pages.pop(page_id, None)

    def append_log(self, *_args, **_kwargs):
        return None


class _ReadingProgressStorage:
    def __init__(self) -> None:
        self.pages = {
            "page-1": Page(id="page-1", book_id="book-1", status=PageStatus.READY),
            "page-2": Page(id="page-2", book_id="book-1", status=PageStatus.READY),
        }
        self.progress: Progress | None = None
        self.save_count = 0

    def load_page(self, _book_id: str, page_id: str) -> Page | None:
        return self.pages.get(page_id)

    def load_progress(self, _book_id: str) -> Progress | None:
        return self.progress

    def save_progress(self, progress: Progress) -> None:
        self.progress = progress
        self.save_count += 1


def test_record_page_visit_tracks_unique_pages_and_resume_position() -> None:
    storage = _ReadingProgressStorage()
    engine = BookEngine.__new__(BookEngine)
    engine.storage = storage

    first = engine.record_page_visit("book-1", "page-1")
    duplicate = engine.record_page_visit("book-1", "page-1")
    second = engine.record_page_visit("book-1", "page-2")

    assert first is not None
    assert duplicate is not None
    assert second is not None
    assert second.current_page_id == "page-2"
    assert second.visited_page_ids == ["page-1", "page-2"]
    assert storage.save_count == 4  # initial progress + one save per valid visit


def test_record_page_visit_rejects_unknown_page_without_progress_write() -> None:
    storage = _ReadingProgressStorage()
    engine = BookEngine.__new__(BookEngine)
    engine.storage = storage

    assert engine.record_page_visit("book-1", "missing") is None
    assert storage.progress is None
    assert storage.save_count == 0


@pytest.mark.asyncio
async def test_legacy_ready_book_gets_overview_once_without_recompiling_content() -> None:
    storage = _RebuildStorage()
    engine = BookEngine.__new__(BookEngine)
    engine.storage = storage
    original_page = storage.pages["old-page"]

    migrated = await engine.ensure_legacy_overview("book-1")
    migrated_again = await engine.ensure_legacy_overview("book-1")

    assert migrated is True
    assert migrated_again is False
    assert storage.spine.chapters[0].content_type == ContentType.OVERVIEW
    assert (
        len(
            [
                chapter
                for chapter in storage.spine.chapters
                if chapter.content_type == ContentType.OVERVIEW
            ]
        )
        == 1
    )
    overview_pages = [
        page for page in storage.pages.values() if page.content_type == ContentType.OVERVIEW
    ]
    assert len(overview_pages) == 1
    assert overview_pages[0].status == PageStatus.READY
    assert [block.type for block in overview_pages[0].blocks] == [
        BlockType.TEXT,
        BlockType.CONCEPT_GRAPH,
        BlockType.TEXT,
    ]
    assert storage.pages["old-page"] is original_page
    assert storage.pages["old-page"].blocks[1].payload["body"] == "Do not lose this note"
    assert storage.book.page_count == 2


def test_rebuild_preview_reports_destructive_scope_and_preserved_state() -> None:
    engine = BookEngine.__new__(BookEngine)
    engine.storage = _RebuildStorage()

    preview = engine.preview_rebuild("book-1")

    assert preview["page_count"] == 1
    assert preview["generated_block_count"] == 1
    assert preview["user_note_count"] == 1
    assert preview["visited_page_count"] == 1
    assert preview["bookmarked_page_count"] == 1
    assert preview["page_chat_count"] == 1
    assert preview["preserves_user_notes"] is True
    assert preview["preserves_learning_state"] is True


@pytest.mark.asyncio
async def test_rebuild_preserves_notes_progress_and_page_chat_by_chapter() -> None:
    storage = _RebuildStorage()
    engine = BookEngine.__new__(BookEngine)
    engine.storage = storage
    engine._runtimes = {}

    async def fake_confirm_spine(*, book_id, edited_spine, stream, auto_compile):
        assert auto_compile is False
        page = Page(
            id="new-page",
            book_id=book_id,
            chapter_id="chapter-1",
            title="New page",
            status=PageStatus.PENDING,
            blocks=[Block(type=BlockType.TEXT, payload={"text": "new"})],
        )
        storage.pages[page.id] = page
        edited_spine.chapters[0].page_ids = [page.id]
        storage.save_spine(edited_spine)
        storage.save_progress(Progress(book_id=book_id))
        return [page]

    queued: list[str] = []

    async def fake_enqueue(book_id, pages, *, stream):
        queued.extend(page.id for page in pages)

    engine.confirm_spine = fake_confirm_spine
    engine._enqueue_pending_pages = fake_enqueue

    pages = await engine.rebuild_book(book_id="book-1", auto_compile=True)

    assert queued == ["new-page"]
    assert [block.id for block in pages[0].blocks if block.type == BlockType.USER_NOTE] == [
        "note-1"
    ]
    assert storage.progress.current_page_id == "new-page"
    assert storage.progress.visited_page_ids == ["new-page"]
    assert storage.progress.bookmarked_page_ids == ["new-page"]
    assert storage.progress.score == 7
    assert storage.book.metadata["page_chat_sessions"] == {"new-page": "chat-1"}
