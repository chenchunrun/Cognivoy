#!/usr/bin/env python3
"""Repair structural book-spine gaps without fabricating source evidence."""

from __future__ import annotations

import argparse
import json

from cognivoy.book.agents.spine_synthesizer import _ensure_learning_objectives
from cognivoy.book.storage import BookStorage


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("book_id")
    args = parser.parse_args()

    storage = BookStorage()
    book = storage.load_book(args.book_id)
    spine = storage.load_spine(args.book_id)
    if book is None or spine is None:
        raise SystemExit(f"Book or spine not found: {args.book_id}")

    before = sum(bool(chapter.learning_objectives) for chapter in spine.chapters)
    _ensure_learning_objectives(spine.chapters, language=book.language)
    after = sum(bool(chapter.learning_objectives) for chapter in spine.chapters)
    if after != before:
        spine.version += 1
        storage.save_spine(spine)
    print(
        json.dumps(
            {
                "book_id": args.book_id,
                "chapters": len(spine.chapters),
                "objectives_before": before,
                "objectives_after": after,
                "source_evidence_changed": False,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
