from __future__ import annotations

import json
from pathlib import Path

import pytest

from cognivoy.learning.project_models import LearningProject, LearningTask
from cognivoy.learning.project_storage import LearningProjectStore
from cognivoy.learning.storage import LearningStore
from cognivoy.tools.mastery_tool import (
    LearningSessionCheckpointTool,
    MasteryStatusTool,
)


def _store_with_task(tmp_path: Path) -> tuple[LearningProjectStore, LearningProject, LearningTask]:
    store = LearningProjectStore(root=tmp_path / "projects")
    task = LearningTask(
        id="task-1",
        project_id="project-1",
        objective="Explain and apply the target concept",
        status="in_progress",
    )
    project = LearningProject(
        id="project-1",
        owner_id="learner-1",
        title="Structured learning",
        weekly_plan=[task.objective],
        tasks=[task],
    )
    store.create(project)
    return store, project, task


def _checkpoint(
    store: LearningProjectStore,
    phase: str,
    *,
    passed: bool | None = None,
    turn_id: str = "turn-1",
    summary: str = "observed evidence",
):
    return store.record_session_checkpoint(
        "project-1",
        "task-1",
        session_id="session-1",
        turn_id=turn_id,
        phase=phase,  # type: ignore[arg-type]
        passed=passed,
        summary=summary,
    )


def test_structured_session_blocks_completion_until_exit_and_transfer_pass(
    tmp_path: Path,
) -> None:
    store, _, _ = _store_with_task(tmp_path)

    started = store.start_structured_session("project-1", "task-1", session_id="session-1")
    assert started is not None
    initial_version = started[0].version
    repeated = store.start_structured_session("project-1", "task-1", session_id="session-1")
    assert repeated is not None
    assert repeated[0].version == initial_version
    assert store.complete_task_from_turn("project-1", "task-1", session_id="session-1") is None

    with pytest.raises(ValueError, match="expected goal"):
        _checkpoint(store, "instruction")

    _checkpoint(store, "goal", summary="Goal and time box agreed")
    status = store.structured_session_status("project-1", "task-1")
    assert status is not None
    assert status["current_phase"] == "goal"
    assert status["next_phases"] == ["prerequisite_check"]
    _checkpoint(store, "prerequisite_check", passed=True)
    _checkpoint(store, "instruction")
    _checkpoint(store, "active_recall", passed=True)
    _checkpoint(store, "feedback")
    _checkpoint(store, "exit_check", passed=True)
    _, task = _checkpoint(store, "transfer", passed=True)

    assert task.learning_session is not None
    assert task.learning_session.status == "verified"
    assert task.learning_session.exit_check_passed is True
    assert task.learning_session.transfer_passed is True

    completion = store.complete_task_from_turn("project-1", "task-1", session_id="session-1")
    assert completion is not None
    completed_project, _ = completion
    completed_task = completed_project.tasks[0]
    assert completed_task.status == "completed"
    assert "session:session-1" in completed_task.result_refs
    assert (
        len([ref for ref in completed_task.result_refs if ref.startswith("learning-session:")]) == 7
    )


def test_checkpoint_is_idempotent_and_failed_recall_requires_remediation(
    tmp_path: Path,
) -> None:
    store, _, _ = _store_with_task(tmp_path)
    store.start_structured_session("project-1", "task-1", session_id="session-1")

    _checkpoint(store, "goal")
    _checkpoint(store, "prerequisite_check", passed=True)
    _checkpoint(store, "instruction")
    project, task = _checkpoint(store, "active_recall", passed=False)
    failed_version = project.version
    checkpoint_count = len(task.learning_session.checkpoints) if task.learning_session else 0

    repeated_project, repeated_task = _checkpoint(store, "active_recall", passed=False)
    assert repeated_project.version == failed_version
    assert repeated_task.learning_session is not None
    assert len(repeated_task.learning_session.checkpoints) == checkpoint_count

    with pytest.raises(ValueError, match="expected feedback"):
        _checkpoint(store, "exit_check", passed=True)

    _checkpoint(store, "feedback")
    _checkpoint(store, "active_recall", passed=True, turn_id="turn-2")
    _checkpoint(store, "feedback", turn_id="turn-2")
    _checkpoint(store, "exit_check", passed=True, turn_id="turn-2")
    _, task = _checkpoint(store, "transfer", passed=True, turn_id="turn-2")
    assert task.learning_session is not None
    assert task.learning_session.status == "verified"


def test_assessed_checkpoint_requires_observed_result(tmp_path: Path) -> None:
    store, _, _ = _store_with_task(tmp_path)
    store.start_structured_session("project-1", "task-1", session_id="session-1")
    _checkpoint(store, "goal")

    with pytest.raises(ValueError, match="requires a passed result"):
        _checkpoint(store, "prerequisite_check")


def test_failed_exit_can_be_retried_after_feedback_and_recall(tmp_path: Path) -> None:
    store, _, _ = _store_with_task(tmp_path)
    store.start_structured_session("project-1", "task-1", session_id="session-1")
    _checkpoint(store, "goal")
    _checkpoint(store, "prerequisite_check", passed=True)
    _checkpoint(store, "instruction")
    _checkpoint(store, "active_recall", passed=True)
    _checkpoint(store, "feedback")
    _checkpoint(store, "exit_check", passed=False)
    _checkpoint(store, "feedback", turn_id="turn-2")
    _checkpoint(store, "active_recall", passed=True, turn_id="turn-2")
    _checkpoint(store, "feedback", turn_id="turn-2", summary="misconception repaired")
    _checkpoint(store, "exit_check", passed=True, turn_id="turn-2")
    _, task = _checkpoint(store, "transfer", passed=True, turn_id="turn-2")

    assert task.learning_session is not None
    assert task.learning_session.status == "verified"


def test_task_session_resumes_from_a_new_chat_session(tmp_path: Path) -> None:
    store, _, _ = _store_with_task(tmp_path)
    store.start_structured_session("project-1", "task-1", session_id="session-1")
    _checkpoint(store, "goal")

    project, task = store.record_session_checkpoint(
        "project-1",
        "task-1",
        session_id="replacement-chat-session",
        turn_id="turn-2",
        phase="prerequisite_check",
        passed=True,
        summary="resumed after interruption",
    )

    assert project.tasks[0].learning_session is not None
    assert task.learning_session is not None
    assert task.learning_session.session_id == "session-1"
    assert task.learning_session.current_phase == "prerequisite_check"


def test_legacy_task_without_session_keeps_completion_compatibility(tmp_path: Path) -> None:
    store, _, _ = _store_with_task(tmp_path)

    completion = store.complete_task_from_turn("project-1", "task-1", session_id="legacy-session")

    assert completion is not None
    project, _ = completion
    assert project.tasks[0].status == "completed"
    assert project.tasks[0].learning_session is None


@pytest.mark.asyncio
async def test_mastery_tools_record_and_report_recoverable_session_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project_root = tmp_path / "projects"
    mastery_root = tmp_path / "mastery"

    def project_store_init(self, root=None):
        self.root = project_root
        self.root.mkdir(parents=True, exist_ok=True)

    def mastery_store_init(self, root=None):
        self._root = mastery_root
        self._root.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(LearningProjectStore, "__init__", project_store_init)
    monkeypatch.setattr(LearningStore, "__init__", mastery_store_init)
    store, _, _ = _store_with_task(tmp_path)
    store.start_structured_session("project-1", "task-1", session_id="session-1")
    trusted_context = {"project_id": "project-1", "task_id": "task-1"}

    checkpoint = await LearningSessionCheckpointTool().execute(
        phase="goal",
        summary="Goal agreed",
        _learning_context=trusted_context,
        _session_id="session-1",
        _turn_id="turn-1",
    )
    assert checkpoint.success is True

    status = await MasteryStatusTool().execute(
        _mastery_path_id="path-1",
        _learning_context=trusted_context,
    )
    payload = json.loads(status.content)
    assert payload["learning_session"]["current_phase"] == "goal"
    assert payload["learning_session"]["next_phases"] == ["prerequisite_check"]
