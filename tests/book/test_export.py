from io import BytesIO
from zipfile import ZIP_STORED, ZipFile

from cognivoy.book.export import export_epub, export_markdown, safe_export_filename
from cognivoy.book.models import (
    Block,
    BlockStatus,
    BlockType,
    Book,
    ContentType,
    Page,
    PageStatus,
    SourceAnchor,
)


def _book_and_pages():
    book = Book(id="bk-export", title="AI 智能体 / 生产实践", language="zh")
    overview = Page(
        id="overview",
        book_id=book.id,
        title="本书导览",
        content_type=ContentType.OVERVIEW,
        status=PageStatus.READY,
        order=-1,
    )
    chapter = Page(
        id="chapter-1",
        book_id=book.id,
        title="可靠工具调用",
        content_type=ContentType.THEORY,
        status=PageStatus.READY,
        order=1,
        learning_objectives=["理解幂等与重试"],
        blocks=[
            Block(
                id="text-1",
                type=BlockType.TEXT,
                status=BlockStatus.READY,
                title="核心原则",
                payload={"markdown": "工具调用必须可观察、可取消。"},
                source_anchors=[
                    SourceAnchor(
                        kind="kb",
                        ref="course-material:textbook.pdf#pages=12-18",
                    )
                ],
            ),
            Block(
                id="code-1",
                type=BlockType.CODE,
                status=BlockStatus.READY,
                payload={"code": "result = await tool()", "language": "python"},
            ),
        ],
    )
    return book, [overview, chapter]


def test_markdown_export_contains_readable_chapters_and_omits_overview() -> None:
    book, pages = _book_and_pages()

    content = export_markdown(book, None, pages)

    assert content.startswith("# AI 智能体 / 生产实践")
    assert "本书导览" not in content
    assert "## 目录" in content
    assert "## 1. 可靠工具调用" in content
    assert "### 学习目标" in content
    assert "工具调用必须可观察、可取消。" in content
    assert "```python\nresult = await tool()\n```" in content
    assert "## 资料来源" in content
    assert "course-material:textbook.pdf#pages=12-18" in content


def test_epub_export_has_valid_container_manifest_navigation_and_chapter() -> None:
    book, pages = _book_and_pages()

    payload = export_epub(book, None, pages)

    with ZipFile(BytesIO(payload)) as archive:
        names = archive.namelist()
        assert names[0] == "mimetype"
        assert archive.getinfo("mimetype").compress_type == ZIP_STORED
        assert archive.read("mimetype") == b"application/epub+zip"
        assert "META-INF/container.xml" in names
        assert "OEBPS/content.opf" in names
        assert "OEBPS/nav.xhtml" in names
        assert "OEBPS/chapter-1.xhtml" in names
        assert "可靠工具调用" in archive.read("OEBPS/nav.xhtml").decode()
        assert "工具调用必须可观察" in archive.read("OEBPS/chapter-1.xhtml").decode()


def test_export_filename_is_safe_and_keeps_cjk_title() -> None:
    filename = safe_export_filename("AI 智能体 / 生产实践", "epub")
    assert filename == "AI-智能体-生产实践.epub"
    assert "/" not in filename


def test_markdown_export_supports_common_body_payload() -> None:
    book = Book(id="body-book", title="Body payload", language="en")
    page = Page(
        id="body-page",
        book_id=book.id,
        title="Compatibility",
        status=PageStatus.READY,
        blocks=[Block(id="body-block", type=BlockType.TEXT, payload={"body": "Visible prose"})],
    )

    assert "Visible prose" in export_markdown(book, None, [page])
