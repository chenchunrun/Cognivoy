from __future__ import annotations

import pytest

from cognivoy.services.path_service import PathService


@pytest.mark.parametrize(
    "book_id",
    ["../victim", "book/../../victim", "book\\..\\victim", ".", "", "含空格"],
)
def test_book_root_rejects_unsafe_identifiers(tmp_path, book_id: str) -> None:
    service = PathService(workspace_root=tmp_path / "data")

    with pytest.raises(ValueError, match="book_id"):
        service.get_book_root(book_id)


@pytest.mark.parametrize("page_id", ["../manifest", "a/b", "a\\b", ".", ""])
def test_book_page_rejects_unsafe_identifiers(tmp_path, page_id: str) -> None:
    service = PathService(workspace_root=tmp_path / "data")

    with pytest.raises(ValueError, match="page_id"):
        service.get_book_page_file("safe-book", page_id)


def test_book_paths_remain_inside_their_workspace(tmp_path) -> None:
    service = PathService(workspace_root=tmp_path / "data")
    book_dir = service.get_book_dir().resolve()
    book_root = service.get_book_root("book-123")
    page = service.get_book_page_file("book-123", "page_456")

    assert book_root.is_relative_to(book_dir)
    assert page.is_relative_to(book_root / "pages")
