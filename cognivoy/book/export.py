"""Portable Markdown and EPUB exports for generated learning books."""

from __future__ import annotations

from html import escape
from io import BytesIO
import re
from typing import Any, Iterable
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo

from cognivoy.book.models import Book, Page, SourceAnchor, Spine

_TEXT_KEYS = (
    "markdown",
    "body",
    "content",
    "text",
    "explanation",
    "summary",
    "description",
    "question",
    "prompt",
    "answer",
)


def _clean_text(value: Any) -> str:
    return str(value or "").replace("\r\n", "\n").strip()


def _payload_text(payload: dict[str, Any]) -> str:
    """Return learner-facing text without dumping internal generation metadata."""

    parts: list[str] = []
    for key in _TEXT_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            parts.append(_clean_text(value))
    code = payload.get("code")
    if isinstance(code, str) and code.strip():
        language = _clean_text(payload.get("language") or payload.get("lang"))
        parts.append(f"```{language}\n{code.rstrip()}\n```")
    choices = payload.get("choices") or payload.get("options")
    if isinstance(choices, list):
        rendered = [f"- {_clean_text(item)}" for item in choices if _clean_text(item)]
        if rendered:
            parts.append("\n".join(rendered))
    cards = payload.get("cards") or payload.get("items")
    if isinstance(cards, list):
        for item in cards:
            if not isinstance(item, dict):
                continue
            front = _clean_text(item.get("front") or item.get("title") or item.get("term"))
            back = _clean_text(item.get("back") or item.get("content") or item.get("definition"))
            if front or back:
                parts.append(f"**{front}**\n\n{back}".strip())
    if parts:
        return "\n\n".join(dict.fromkeys(parts))
    # Preserve useful primitive payloads for uncommon future block types while
    # excluding URLs, raw binary data, and private/internal keys.
    primitives = []
    for key, value in payload.items():
        if key.startswith("_") or key in {"url", "src", "data", "html"}:
            continue
        if isinstance(value, (str, int, float, bool)) and _clean_text(value):
            primitives.append(f"**{key.replace('_', ' ').title()}:** {_clean_text(value)}")
    return "\n\n".join(primitives)


def _ordered_pages(pages: Iterable[Page]) -> list[Page]:
    return sorted(pages, key=lambda page: (page.order, page.created_at, page.id))


def _source_label(anchor: SourceAnchor) -> str:
    """Return a portable source label for the current SourceAnchor contract."""

    ref = _clean_text(anchor.ref)
    if ref:
        return ref
    return _clean_text(anchor.kind)


def export_markdown(book: Book, spine: Spine | None, pages: Iterable[Page]) -> str:
    """Render a stable, readable Markdown edition."""

    ordered = [page for page in _ordered_pages(pages) if page.content_type.value != "overview"]
    is_zh = (book.language or "").lower().startswith("zh")
    untitled = "未命名书籍" if is_zh else "Untitled book"
    chapter_label = "第 {index} 章" if is_zh else "Chapter {index}"
    contents_label = "目录" if is_zh else "Contents"
    objectives_label = "学习目标" if is_zh else "Learning objectives"
    sources_label = "资料来源" if is_zh else "Sources"
    lines = [f"# {book.title or untitled}"]
    if book.description:
        lines.extend(["", book.description.strip()])
    lines.extend(["", f"## {contents_label}", ""])
    for index, page in enumerate(ordered, 1):
        anchor = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "-", page.title.lower()).strip("-")
        fallback = chapter_label.format(index=index)
        lines.append(f"{index}. [{page.title or fallback}](#{anchor or f'chapter-{index}'})")
    for index, page in enumerate(ordered, 1):
        fallback = chapter_label.format(index=index)
        lines.extend(["", f"## {index}. {page.title or fallback}"])
        if page.learning_objectives:
            lines.extend(["", f"### {objectives_label}", ""])
            lines.extend(f"- {item}" for item in page.learning_objectives)
        for block in page.blocks:
            body = _payload_text(block.payload)
            if not body:
                continue
            if block.title:
                lines.extend(["", f"### {block.title}"])
            lines.extend(["", body])
    source_names = sorted(
        {
            label
            for page in ordered
            for block in page.blocks
            for anchor in block.source_anchors
            if (label := _source_label(anchor))
        }
    )
    if source_names:
        lines.extend(["", f"## {sources_label}", ""])
        lines.extend(f"- {name}" for name in source_names)
    return "\n".join(lines).strip() + "\n"


def _markdown_to_xhtml(markdown: str) -> str:
    """Small dependency-free renderer for the export's controlled Markdown."""

    html: list[str] = []
    in_code = False
    code_lines: list[str] = []
    list_open = False
    for raw in markdown.splitlines():
        line = raw.rstrip()
        if line.startswith("```"):
            if in_code:
                html.append(f"<pre><code>{escape(chr(10).join(code_lines))}</code></pre>")
                code_lines = []
            in_code = not in_code
            continue
        if in_code:
            code_lines.append(line)
            continue
        if line.startswith("- "):
            if not list_open:
                html.append("<ul>")
                list_open = True
            html.append(f"<li>{escape(line[2:])}</li>")
            continue
        if list_open:
            html.append("</ul>")
            list_open = False
        if not line:
            continue
        if line.startswith("### "):
            html.append(f"<h3>{escape(line[4:])}</h3>")
        elif line.startswith("## "):
            html.append(f"<h2>{escape(line[3:])}</h2>")
        elif line.startswith("# "):
            html.append(f"<h1>{escape(line[2:])}</h1>")
        elif re.match(r"^\d+\. \[", line):
            # The EPUB navigation document is authoritative; omit Markdown's
            # duplicate linked contents list from chapter prose.
            continue
        else:
            html.append(f"<p>{escape(line)}</p>")
    if list_open:
        html.append("</ul>")
    if code_lines:
        html.append(f"<pre><code>{escape(chr(10).join(code_lines))}</code></pre>")
    return "\n".join(html)


def export_epub(book: Book, spine: Spine | None, pages: Iterable[Page]) -> bytes:
    """Build an EPUB 3 archive using only the Python standard library."""

    ordered = [page for page in _ordered_pages(pages) if page.content_type.value != "overview"]
    title = book.title or "Untitled book"
    language = book.language or "en"
    identifier = f"urn:cognivoy:book:{book.id}"
    chapters: list[tuple[str, str, str]] = []
    for index, page in enumerate(ordered, 1):
        filename = f"chapter-{index}.xhtml"
        body_md = export_markdown(
            Book(id=book.id, title=page.title, language=language),
            None,
            [page],
        )
        body = _markdown_to_xhtml(body_md)
        xhtml = f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="{escape(language)}">
<head><title>{escape(page.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>{body}</body></html>'''
        chapters.append((filename, page.title or f"Chapter {index}", xhtml))

    nav_items = "".join(
        f'<li><a href="{escape(filename)}">{escape(chapter_title)}</a></li>'
        for filename, chapter_title, _ in chapters
    )
    nav = f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{escape(language)}">
<head><title>{escape(title)}</title></head><body><nav epub:type="toc"><h1>{escape(title)}</h1><ol>{nav_items}</ol></nav></body></html>'''
    manifest = "".join(
        f'<item id="chapter-{index}" href="{filename}" media-type="application/xhtml+xml"/>'
        for index, (filename, _, _) in enumerate(chapters, 1)
    )
    spine_items = "".join(
        f'<itemref idref="chapter-{index}"/>' for index in range(1, len(chapters) + 1)
    )
    package = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">{escape(identifier)}</dc:identifier><dc:title>{escape(title)}</dc:title><dc:language>{escape(language)}</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="style" href="style.css" media-type="text/css"/>{manifest}</manifest>
<spine>{spine_items}</spine></package>"""
    container = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"""
    css = "body{font-family:serif;line-height:1.7;margin:5%;}h1,h2,h3{line-height:1.3;}pre{white-space:pre-wrap;background:#f4f1ea;padding:1em;}"
    output = BytesIO()
    with ZipFile(output, "w") as archive:
        mime = ZipInfo("mimetype")
        archive.writestr(mime, "application/epub+zip", compress_type=ZIP_STORED)
        archive.writestr("META-INF/container.xml", container, compress_type=ZIP_DEFLATED)
        archive.writestr("OEBPS/content.opf", package, compress_type=ZIP_DEFLATED)
        archive.writestr("OEBPS/nav.xhtml", nav, compress_type=ZIP_DEFLATED)
        archive.writestr("OEBPS/style.css", css, compress_type=ZIP_DEFLATED)
        for filename, _, xhtml in chapters:
            archive.writestr(f"OEBPS/{filename}", xhtml, compress_type=ZIP_DEFLATED)
    return output.getvalue()


def safe_export_filename(title: str, extension: str) -> str:
    stem = re.sub(r"[^\w\-\u4e00-\u9fff]+", "-", title, flags=re.UNICODE).strip("-")
    return f"{stem[:100] or 'cognivoy-book'}.{extension}"


__all__ = ["export_epub", "export_markdown", "safe_export_filename"]
