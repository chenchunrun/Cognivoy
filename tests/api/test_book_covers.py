from pathlib import Path

import pytest

pytest.importorskip("fastapi")
from fastapi import FastAPI
from fastapi.testclient import TestClient

from cognivoy.api.routers import book as book_router
from cognivoy.book.models import Block, BlockType, Book, Page, PageStatus


class _PathService:
    def __init__(self, root: Path) -> None:
        self.root = root

    def get_book_assets_dir(self, book_id: str) -> Path:
        return self.root / f"book_{book_id}" / "assets"


class _Storage:
    def __init__(self, root: Path, book: Book) -> None:
        self.path_service = _PathService(root)
        self.book = book

    def save_book(self, book: Book) -> None:
        self.book = book


class _Engine:
    def __init__(self, root: Path) -> None:
        self.book = Book(id="cover-book", title="AI Systems", description="A practical guide")
        self.storage = _Storage(root, self.book)

    def load_book(self, book_id: str):
        return self.book if book_id == self.book.id else None

    def load_spine(self, book_id: str):
        return None

    def list_pages(self, book_id: str):
        if book_id != self.book.id:
            return []
        return [
            Page(
                id="page-1",
                book_id=book_id,
                title="Production",
                status=PageStatus.READY,
                blocks=[Block(id="block-1", type=BlockType.TEXT, payload={"body": "Ship safely."})],
            )
        ]


@pytest.fixture()
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    engine = _Engine(tmp_path)
    monkeypatch.setattr(book_router, "get_book_engine", lambda: engine)
    app = FastAPI()
    app.include_router(book_router.router, prefix="/api/v1/book")
    return TestClient(app), engine


def test_generate_cover_persists_asset_and_serves_it(client) -> None:
    http, engine = client
    response = http.post(
        "/api/v1/book/books/cover-book/cover/generate",
        json={"theme": "technical", "accent": "#c65d32"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["cover_url"].endswith("/books/cover-book/cover")
    assert engine.book.metadata["cover_url"] == payload["cover_url"]
    asset = engine.storage.path_service.get_book_assets_dir("cover-book") / "cover.svg"
    assert asset.exists()
    assert "AI Systems" in asset.read_text(encoding="utf-8")
    served = http.get(payload["cover_url"])
    assert served.status_code == 200
    assert served.headers["content-type"].startswith("image/svg+xml")
    assert served.headers["content-disposition"].startswith("inline")
    downloaded = http.get(f"{payload['cover_url']}?download=true")
    assert downloaded.status_code == 200
    assert downloaded.headers["content-disposition"].startswith("attachment")


def test_upload_cover_validates_content_and_replaces_generated_cover(client) -> None:
    http, engine = client
    invalid = http.post(
        "/api/v1/book/books/cover-book/cover/upload",
        files={"file": ("cover.svg", b"<svg/>", "image/svg+xml")},
    )
    assert invalid.status_code == 415
    png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00"
    uploaded = http.post(
        "/api/v1/book/books/cover-book/cover/upload",
        files={"file": ("cover.png", png, "image/png")},
    )
    assert uploaded.status_code == 200
    assert engine.book.metadata["cover_mime"] == "image/png"
    assert http.get(uploaded.json()["cover_url"]).content.startswith(b"\x89PNG")


def test_portable_exports_have_download_headers_and_content(client) -> None:
    http, _ = client

    markdown = http.get("/api/v1/book/books/cover-book/export?format=markdown")
    assert markdown.status_code == 200
    assert markdown.headers["content-type"].startswith("text/markdown")
    assert "filename*=UTF-8''AI-Systems.md" in markdown.headers["content-disposition"]
    assert "Ship safely." in markdown.text

    epub = http.get("/api/v1/book/books/cover-book/export?format=epub")
    assert epub.status_code == 200
    assert epub.headers["content-type"] == "application/epub+zip"
    assert epub.content.startswith(b"PK")
