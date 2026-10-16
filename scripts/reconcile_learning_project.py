#!/usr/bin/env python3
"""Reconcile one saved learning project using the same rules as the API."""

from __future__ import annotations

import argparse
import json

from cognivoy.learning.project_storage import LearningProjectStore
from cognivoy.learning.reconcile import reconcile_course_plan


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("project_id")
    args = parser.parse_args()
    store = LearningProjectStore()
    project = store.load(args.project_id)
    if project is None:
        parser.error(f"learning project not found: {args.project_id}")
    expected_version = project.version
    changed = reconcile_course_plan(project)
    saved = store.save(project, expected_version=expected_version) if changed else project
    print(
        json.dumps(
            {
                "project_id": saved.id,
                "version": saved.version,
                "changed": changed,
                "deadline": saved.deadline,
                "weekly_plan_items": len(saved.weekly_plan),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
