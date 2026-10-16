#!/usr/bin/env python3
"""Attach auditable CISA material locators to an existing generated book.

The script is intentionally idempotent.  It links chapters and blocks to the
learner's private knowledge base without copying licensed question content.
"""

from __future__ import annotations

import argparse
import json

from cognivoy.book.models import SourceAnchor
from cognivoy.book.storage import BookStorage

DOMAIN_RANGES: tuple[tuple[range, str, str, str], ...] = (
    (range(1, 4), "Domain 1", "22-62", "97-160"),
    (range(4, 7), "Domain 2", "63-98", "19-96"),
    (range(7, 9), "Domain 3", "99-151", "161-268"),
    (range(9, 13), "Domain 4", "152-204", "269-448"),
    (range(13, 17), "Domain 5", "205-end", "449-590"),
)


def anchors_for_order(order: int) -> list[SourceAnchor]:
    anchors = [
        SourceAnchor(
            kind="kb",
            ref="cisa-official:official-exam-outline-2026.md",
            snippet="2026 current exam outline; authoritative for scope and weights.",
        ),
        SourceAnchor(
            kind="kb",
            ref="cisa-official:cisa-topic-locator-2026.md",
            snippet="Current-to-legacy topic, week, chapter, and page locator.",
        ),
    ]
    if order == 0:
        return anchors
    for orders, domain, review_pages, guide_pages in DOMAIN_RANGES:
        if order not in orders:
            continue
        anchors.extend(
            [
                SourceAnchor(
                    kind="kb",
                    ref=(f"cisa-official:CISA考试复习手册27版 2019.pdf#pdf-pages={review_pages}"),
                    snippet=(
                        f"ISACA Review Manual 27e legacy coverage for {domain}; "
                        "use the current outline for exam weighting."
                    ),
                ),
                SourceAnchor(
                    kind="kb",
                    ref=(
                        "cisa-official:CISA All-in-One Exam Guide 2020.pdf"
                        f"#book-pages={guide_pages}"
                    ),
                    snippet=f"Third-party practical explanation and terminology for {domain}.",
                ),
            ]
        )
        return anchors
    raise ValueError(f"Unsupported CISA chapter order: {order}")


def merge_anchors(
    current: list[SourceAnchor], additions: list[SourceAnchor]
) -> tuple[list[SourceAnchor], int]:
    merged = list(current)
    keys = {(item.kind, item.ref) for item in current}
    added = 0
    for item in additions:
        key = (item.kind, item.ref)
        if key in keys:
            continue
        merged.append(item)
        keys.add(key)
        added += 1
    return merged, added


def link_book(book_id: str) -> dict[str, int | str]:
    storage = BookStorage()
    spine = storage.load_spine(book_id)
    if spine is None:
        raise SystemExit(f"Book spine not found: {book_id}")

    chapter_additions = 0
    block_additions = 0
    chapter_anchors: dict[str, list[SourceAnchor]] = {}
    for chapter in spine.chapters:
        additions = anchors_for_order(chapter.order)
        chapter.source_anchors, added = merge_anchors(chapter.source_anchors, additions)
        chapter_additions += added
        chapter_anchors[chapter.id] = additions

    if chapter_additions:
        spine.version += 1
        storage.save_spine(spine)

    pages_changed = 0
    for page in storage.list_pages(book_id):
        additions = chapter_anchors.get(page.chapter_id)
        if not additions:
            continue
        page_changed = False
        for block in page.blocks:
            block.source_anchors, added = merge_anchors(block.source_anchors, additions)
            block_additions += added
            page_changed = page_changed or bool(added)
        if page_changed:
            storage.save_page(page)
            pages_changed += 1

    return {
        "book_id": book_id,
        "chapters": len(spine.chapters),
        "chapter_anchors_added": chapter_additions,
        "pages_changed": pages_changed,
        "block_anchors_added": block_additions,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("book_id")
    args = parser.parse_args()
    print(json.dumps(link_book(args.book_id), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
