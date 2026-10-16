"""Notebook service regression tests."""

from __future__ import annotations

import json
import time

import pytest

from cognivoy.services.notebook.service import (
    NotebookManager,
    NotebookRevisionConflict,
    RecordType,
)


def test_add_record_accepts_enum_record_type(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("CLI test notebook")

    result = manager.add_record(
        notebook_ids=[notebook["id"]],
        record_type=RecordType.CHAT,
        title="Sample",
        user_query="Sample",
        output="# Sample",
    )

    assert result["record"]["type"] == RecordType.CHAT

    stored = manager.get_notebook(notebook["id"])
    assert stored is not None
    assert stored["records"][0]["type"] == "chat"


def test_add_record_strips_thinking_tags_from_summary(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("Sanitized notebook")

    result = manager.add_record(
        notebook_ids=[notebook["id"]],
        record_type="chat",
        title="Sample",
        summary="<think>private reasoning</think>\nReusable summary.",
        user_query="Sample",
        output="# Sample",
    )

    assert result["record"]["summary"] == "Reusable summary."

    stored = manager.get_notebook(notebook["id"])
    assert stored is not None
    assert stored["records"][0]["summary"] == "Reusable summary."


def test_get_notebook_repairs_existing_thinking_tags_in_summary(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("Legacy notebook")
    manager.add_record(
        notebook_ids=[notebook["id"]],
        record_type="chat",
        title="Sample",
        summary="Reusable summary.",
        user_query="Sample",
        output="# Sample",
    )

    path = manager._get_notebook_file(notebook["id"])
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["records"][0]["summary"] = "<think>old reasoning</think>\nReusable summary."
    path.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    repaired = manager.get_notebook(notebook["id"])
    assert repaired is not None
    assert repaired["records"][0]["summary"] == "Reusable summary."
    assert "old reasoning" not in path.read_text(encoding="utf-8")


def test_legacy_records_are_migrated_to_versioned_asset_contract(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("Legacy notebook")
    path = manager._get_notebook_file(notebook["id"])
    raw = json.loads(path.read_text(encoding="utf-8"))
    raw["records"] = [
        {
            "id": "legacy-1",
            "type": "chat",
            "title": "Legacy",
            "summary": "summary",
            "user_query": "question",
            "output": "answer",
            "metadata": {
                "tags": ["calculus", "calculus"],
                "source_refs": [{"type": "book", "id": "page-1"}],
            },
            "created_at": 123.0,
            "kb_name": None,
        }
    ]
    path.write_text(json.dumps(raw), encoding="utf-8")

    repaired = manager.get_notebook(notebook["id"])

    record = repaired["records"][0]
    assert record["tags"] == ["calculus"]
    assert record["references"] == [{"type": "book", "id": "page-1"}]
    assert record["updated_at"] == 123.0
    assert record["revision"] == 1


def test_add_record_idempotency_and_revision_conflict(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("Versioned notebook")
    args = {
        "notebook_ids": [notebook["id"]],
        "record_type": "chat",
        "title": "Fourier",
        "user_query": "Explain Fourier",
        "output": "Initial answer",
        "tags": ["signals", "signals", " math "],
        "references": [{"type": "session", "id": "turn-1"}],
        "idempotency_key": "save:session-1:turn-1",
    }

    first = manager.add_record(**args)
    second = manager.add_record(**args)

    assert first["created"] is True
    assert second["created"] is False
    assert second["record"]["id"] == first["record"]["id"]
    assert second["record"]["tags"] == ["signals", "math"]
    assert len(manager.get_notebook(notebook["id"])["records"]) == 1

    updated = manager.update_record(
        notebook["id"],
        first["record"]["id"],
        output="Revised answer",
        expected_revision=1,
    )
    assert updated["revision"] == 2
    assert updated["updated_at"] >= updated["created_at"]
    with pytest.raises(NotebookRevisionConflict) as raised:
        manager.update_record(
            notebook["id"],
            first["record"]["id"],
            output="Stale overwrite",
            expected_revision=1,
        )
    assert raised.value.current["output"] == "Revised answer"


def test_markdown_import_append_is_idempotent_and_replace_is_explicit(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("Imported notes")
    manager.add_record(
        notebook_ids=[notebook["id"]],
        record_type="chat",
        title="Existing",
        user_query="",
        output="Keep for append",
    )
    markdown = (
        "# Course notes\n\n## Limits\nDefinition of a limit.\n\n## Derivatives\nRate of change."
    )

    appended = manager.import_markdown(
        notebook["id"],
        markdown=markdown,
        mode="append",
        idempotency_key="import:course-notes:v1",
    )
    repeated = manager.import_markdown(
        notebook["id"],
        markdown=markdown,
        mode="append",
        idempotency_key="import:course-notes:v1",
    )
    assert appended["imported_count"] == 2
    assert repeated["imported_count"] == 0
    assert len(manager.get_notebook(notebook["id"])["records"]) == 3

    replaced = manager.import_markdown(
        notebook["id"],
        markdown="# Replacement\n\nOnly the replacement remains.",
        mode="replace",
        title="Replacement",
        idempotency_key="import:replacement:v1",
    )
    assert replaced["replaced_count"] == 3
    detail = manager.get_notebook(notebook["id"])
    assert len(detail["records"]) == 1
    assert detail["records"][0]["title"] == "Replacement"


def test_list_notebooks_uses_summary_index_without_loading_every_asset(
    tmp_path, monkeypatch
) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    first = manager.create_notebook("First")
    second = manager.create_notebook("Second")

    def fail_if_loaded(_notebook_id: str):
        raise AssertionError("complete index entries must not load notebook JSON")

    monkeypatch.setattr(manager, "_load_notebook", fail_if_loaded)

    listed = manager.list_notebooks()

    assert {item["id"] for item in listed} == {first["id"], second["id"]}
    assert all(item["record_count"] == 0 for item in listed)


def test_ten_thousand_record_page_is_bounded_and_within_capacity_budget(tmp_path) -> None:
    manager = NotebookManager(base_dir=str(tmp_path))
    notebook = manager.create_notebook("Capacity")
    now = time.time()
    notebook["records"] = [
        {
            "id": f"record-{index}",
            "type": "chat",
            "title": f"Topic {index}",
            "summary": "bounded summary",
            "user_query": f"question {index}",
            "output": "answer " * 20,
            "metadata": {},
            "created_at": now + index,
            "updated_at": now + index,
            "revision": 1,
            "tags": [],
            "references": [],
            "idempotency_key": None,
            "kb_name": None,
        }
        for index in range(10_000)
    ]
    manager._save_notebook(notebook)

    started = time.perf_counter()
    page = manager.list_records(notebook["id"], limit=50, offset=5_000)
    elapsed = time.perf_counter() - started

    assert page is not None
    assert page["total"] == 10_000
    assert len(page["items"]) == 50
    assert page["items"][0]["id"] == "record-4999"
    assert elapsed < 2.0
