from __future__ import annotations

from pathlib import Path

import pytest

from cognivoy.services.session.stage_checkpoint import StageCheckpointStore


def test_stage_checkpoint_resumes_only_matching_incomplete_workflow(tmp_path: Path) -> None:
    store = StageCheckpointStore("visualize", "turn_123", root=tmp_path)

    first = store.start(fingerprint="request-a")
    store.save_stage("analysis", {"render_type": "svg"})
    resumed = store.start(fingerprint="request-a")

    assert first["resume_count"] == 0
    assert resumed["resume_count"] == 1
    assert store.load_stage("analysis") == {"render_type": "svg"}

    reset = store.start(fingerprint="request-b")
    assert reset["resume_count"] == 0
    assert store.load_stage("analysis") is None


def test_stage_checkpoint_completion_and_safe_identifiers(tmp_path: Path) -> None:
    store = StageCheckpointStore("deep_question", "turn-safe", root=tmp_path)
    store.start(fingerprint="request")
    store.finish(status="completed")

    completed = store.start(fingerprint="request")
    assert completed["status"] == "completed"
    assert completed["resume_count"] == 0

    with pytest.raises(ValueError, match="unsafe"):
        StageCheckpointStore("visualize", "../../escape", root=tmp_path)


def test_stage_checkpoint_can_append_incremental_items_idempotently(tmp_path: Path) -> None:
    store = StageCheckpointStore("deep_question", "turn-list", root=tmp_path)
    store.start(fingerprint="request")

    store.append_item("questions", "q1", {"question_id": "q1", "question": "One"})
    store.append_item("questions", "q1", {"question_id": "q1", "question": "Updated"})
    store.append_item("questions", "q2", {"question_id": "q2", "question": "Two"})

    assert store.load_items("questions") == [
        {"question_id": "q1", "question": "Updated"},
        {"question_id": "q2", "question": "Two"},
    ]
