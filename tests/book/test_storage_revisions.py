from pathlib import Path

import pytest

from cognivoy.book.models import Block, BlockType, Page, PageStatus
from cognivoy.book.storage import BookStorage
from cognivoy.services.path_service import PathService


def _page(body: str) -> Page:
    return Page(
        id="page-1",
        book_id="book-1",
        title="Agent foundations",
        status=PageStatus.READY,
        blocks=[Block(id="block-1", type=BlockType.TEXT, payload={"body": body})],
    )


def test_page_updates_keep_bounded_revisions_and_restore_current_safely(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path_service = PathService(workspace_root=tmp_path)
    monkeypatch.setattr(
        "cognivoy.book.storage.get_path_service",
        lambda: path_service,
    )
    storage = BookStorage()

    first = _page("version one")
    storage.save_page(first)
    storage.save_page(first.model_copy(deep=True))
    assert storage.list_page_revisions("book-1", "page-1") == []

    second = first.model_copy(deep=True)
    second.blocks[0].payload["body"] = "version two"
    storage.save_page(second)
    revisions = storage.list_page_revisions("book-1", "page-1")
    assert len(revisions) == 1
    assert revisions[0]["block_count"] == 1

    restored = storage.restore_page_revision("book-1", "page-1", revisions[0]["revision_id"])
    assert restored.blocks[0].payload["body"] == "version one"
    assert storage.load_page("book-1", "page-1") == restored

    after_restore = storage.list_page_revisions("book-1", "page-1")
    assert len(after_restore) == 2
    current_snapshot = storage._page_revisions_dir("book-1", "page-1") / (
        after_restore[0]["revision_id"] + ".json"
    )
    assert "version two" in current_snapshot.read_text(encoding="utf-8")


def test_restore_rejects_unknown_or_cross_page_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path_service = PathService(workspace_root=tmp_path)
    monkeypatch.setattr("cognivoy.book.storage.get_path_service", lambda: path_service)
    storage = BookStorage()

    with pytest.raises(FileNotFoundError):
        storage.restore_page_revision("book-1", "page-1", "missing")
    with pytest.raises(ValueError):
        storage.restore_page_revision("book-1", "page-1", "../escape")


def test_stage_reviews_are_versioned_and_reject_stale_writers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path_service = PathService(workspace_root=tmp_path)
    monkeypatch.setattr("cognivoy.book.storage.get_path_service", lambda: path_service)
    storage = BookStorage()
    storage.ensure_book_root("book-1")

    first = storage.save_stage_review(
        "book-1",
        stage="outline",
        decision="approved",
        snapshot={"chapter_count": 4},
        expected_revision=0,
    )
    second = storage.save_stage_review(
        "book-1",
        stage="outline",
        decision="changes_requested",
        snapshot={"chapter_count": 5},
        notes="Add a deployment chapter.",
        expected_revision=1,
    )

    assert first["revision"] == 1
    assert second["revision"] == 2
    assert storage.list_stage_reviews("book-1")[0]["notes"] == "Add a deployment chapter."
    with pytest.raises(RuntimeError, match="stage_review_conflict:2"):
        storage.save_stage_review(
            "book-1",
            stage="outline",
            decision="approved",
            snapshot={},
            expected_revision=1,
        )
