#!/usr/bin/env python3
"""Merge unattempted duplicate project questions while preserving task links."""

from __future__ import annotations

import argparse
import json

from cognivoy.services.session.sqlite_store import get_sqlite_session_store


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    store = get_sqlite_session_store()  # also applies the association migration
    merged = 0
    skipped_attempted = 0
    with store._connect() as conn:  # maintenance script, one atomic transaction
        groups = conn.execute(
            """
            SELECT LOWER(TRIM(question)) AS normalized_question,
                   GROUP_CONCAT(id) AS ids, COUNT(*) AS copies
            FROM notebook_entries
            WHERE learning_project_id = ?
            GROUP BY LOWER(TRIM(question))
            HAVING COUNT(*) > 1
            """,
            (args.project_id,),
        ).fetchall()
        for group in groups:
            ids = sorted(int(value) for value in str(group["ids"]).split(","))
            rows = conn.execute(
                f"SELECT id, attempt_count FROM notebook_entries WHERE id IN ({','.join('?' for _ in ids)})",
                ids,
            ).fetchall()
            if any(int(row["attempt_count"] or 0) > 0 for row in rows):
                skipped_attempted += len(ids) - 1
                continue
            canonical, duplicates = ids[0], ids[1:]
            if not args.apply:
                merged += len(duplicates)
                continue
            for duplicate in duplicates:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO notebook_entry_learning_tasks (
                        entry_id, learning_project_id, learning_task_id, created_at
                    )
                    SELECT ?, learning_project_id, learning_task_id, created_at
                    FROM notebook_entry_learning_tasks WHERE entry_id = ?
                    """,
                    (canonical, duplicate),
                )
                conn.execute(
                    """
                    INSERT OR IGNORE INTO notebook_entry_categories (entry_id, category_id)
                    SELECT ?, category_id FROM notebook_entry_categories WHERE entry_id = ?
                    """,
                    (canonical, duplicate),
                )
                conn.execute("DELETE FROM notebook_entries WHERE id = ?", (duplicate,))
                merged += 1
        if not args.apply:
            conn.rollback()

    print(
        json.dumps(
            {
                "project_id": args.project_id,
                "apply": args.apply,
                "duplicates_merged": merged,
                "duplicates_skipped_because_attempted": skipped_attempted,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
