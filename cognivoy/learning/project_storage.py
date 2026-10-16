from __future__ import annotations

import json
import logging
from pathlib import Path
import threading
import time
from typing import Any
from uuid import NAMESPACE_URL, uuid5

from cognivoy.learning.project_models import (
    LearningEvent,
    LearningEventType,
    LearningProject,
    LearningSessionCheckpoint,
    LearningSessionPhase,
    LearningSessionState,
    LearningTask,
    ProjectReviewItem,
)
from cognivoy.services.file_io import atomic_write_text
from cognivoy.services.path_service import get_path_service

_project_lock = threading.RLock()
logger = logging.getLogger(__name__)


def reconcile_project_partner_outreach(project: LearningProject) -> list[str]:
    """Best-effort bridge from durable learning evidence to Tutor outreach."""

    try:
        from cognivoy.services.partners.proactive_learning import (
            reconcile_learning_project_outreach,
        )

        return reconcile_learning_project_outreach(project)
    except Exception:
        # Learning evidence is authoritative. A transient Partner/Cron failure
        # must never roll back a quiz or review completion.
        logger.warning(
            "Failed to reconcile Partner outreach for learning project %s",
            project.id,
            exc_info=True,
        )
        return []


def _load_mastery_progress(session_id: str):
    """Load an existing mastery path without creating synthetic progress."""

    try:
        from cognivoy.learning.storage import LearningStore

        return LearningStore().load(session_id)
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


_ASSESSED_SESSION_PHASES = {"prerequisite_check", "active_recall", "exit_check", "transfer"}


def _allowed_session_phases(state: LearningSessionState) -> set[LearningSessionPhase]:
    """Return deterministic next phases, including remediation loops."""

    if not state.checkpoints:
        return {"goal"}
    last = state.checkpoints[-1]
    if last.phase == "goal":
        return {"prerequisite_check"}
    if last.phase == "prerequisite_check":
        return {"instruction"}
    if last.phase == "instruction":
        return {"active_recall"}
    if last.phase == "active_recall":
        return {"feedback"}
    if last.phase == "feedback":
        assessed_before_feedback = state.checkpoints[-2] if len(state.checkpoints) >= 2 else None
        needs_remediation = (
            assessed_before_feedback is None
            or assessed_before_feedback.phase != "active_recall"
            or assessed_before_feedback.passed is False
        )
        return {"active_recall"} if needs_remediation else {"exit_check"}
    if last.phase == "exit_check":
        return {"transfer"} if last.passed else {"feedback"}
    if last.phase == "transfer":
        return set() if last.passed else {"feedback"}
    return set()


class LearningProjectStore:
    """Per-workspace project storage with atomic writes and CAS semantics."""

    def __init__(self, root: Path | None = None) -> None:
        self.root = root or (get_path_service().get_workspace_dir() / "learning" / "projects")
        self.root.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def validate_id(value: str, label: str = "project_id") -> str:
        if not value or len(value) > 160 or not all(ch.isalnum() or ch in "_-" for ch in value):
            raise ValueError(f"Invalid {label}")
        return value

    def _path(self, project_id: str) -> Path:
        return self.root / f"{self.validate_id(project_id)}.json"

    def _idempotency_path(self) -> Path:
        return self.root / ".idempotency.json"

    def _read_idempotency(self) -> dict[str, str]:
        path = self._idempotency_path()
        if not path.exists():
            return {}
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return {str(key): str(value) for key, value in data.items()}
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return {}

    def resolve_idempotency(self, key: str) -> LearningProject | None:
        if not key:
            return None
        with _project_lock:
            project_id = self._read_idempotency().get(key)
            return self.load(project_id) if project_id else None

    def remember_idempotency(self, key: str, project_id: str) -> None:
        if not key:
            return
        with _project_lock:
            data = self._read_idempotency()
            data[key] = self.validate_id(project_id)
            atomic_write_text(
                self._idempotency_path(),
                json.dumps(data, ensure_ascii=False, indent=2),
            )

    def list(self) -> list[LearningProject]:
        projects: list[LearningProject] = []
        for path in self.root.glob("*.json"):
            if path.name.startswith("."):
                continue
            try:
                projects.append(
                    LearningProject.model_validate_json(path.read_text(encoding="utf-8"))
                )
            except (OSError, ValueError):
                continue
        return sorted(projects, key=lambda item: item.last_activity_at, reverse=True)

    def load(self, project_id: str) -> LearningProject | None:
        path = self._path(project_id)
        if not path.exists():
            return None
        return LearningProject.model_validate_json(path.read_text(encoding="utf-8"))

    def create(self, project: LearningProject) -> LearningProject:
        with _project_lock:
            path = self._path(project.id)
            if path.exists():
                raise FileExistsError(project.id)
            atomic_write_text(path, project.model_dump_json(indent=2))
            return project

    def save(self, project: LearningProject, *, expected_version: int) -> LearningProject:
        with _project_lock:
            current = self.load(project.id)
            if current is None:
                raise FileNotFoundError(project.id)
            if current.version != expected_version:
                raise RuntimeError(f"revision_conflict:{current.version}")
            now = time.time()
            project.version = current.version + 1
            project.updated_at = now
            project.last_activity_at = now
            atomic_write_text(self._path(project.id), project.model_dump_json(indent=2))
            return project

    @staticmethod
    def append_event(
        project: LearningProject,
        event_type: LearningEventType,
        title: str,
        *,
        description: str = "",
        task_id: str | None = None,
        result_refs: list[str] | None = None,
        mastery_before: float | None = None,
        mastery_after: float | None = None,
        dedupe_key: str | None = None,
    ) -> LearningEvent:
        seed = dedupe_key or f"{event_type}:{time.time_ns()}"
        event_id = uuid5(NAMESPACE_URL, f"cognivoy:{project.id}:event:{seed}").hex
        existing = next((item for item in project.events if item.id == event_id), None)
        if existing is not None:
            return existing
        event = LearningEvent(
            id=event_id,
            project_id=project.id,
            event_type=event_type,
            title=title,
            description=description,
            task_id=task_id,
            result_refs=list(result_refs or []),
            mastery_before=mastery_before,
            mastery_after=mastery_after,
        )
        project.events.append(event)
        return event

    @staticmethod
    def refresh_learning_outcomes(project: LearningProject) -> None:
        scored = [task.mastery_after for task in project.tasks if task.mastery_after is not None]
        project.mastery_summary = round(sum(scored) / len(scored), 4) if scored else 0
        project.weak_points = list(
            dict.fromkeys(
                [
                    *(
                        task.objective
                        for task in project.tasks
                        if task.mastery_after is not None and task.mastery_after < 0.7
                    ),
                    *(
                        item.knowledge_point or item.title
                        for item in project.review_items
                        if item.status == "due"
                    ),
                ]
            )
        )[:12]
        now = time.time()
        project.due_review_count = sum(
            item.status == "due" or (item.status == "scheduled" and item.due_at <= now)
            for item in project.review_items
        )
        project.next_review_at = min(
            (item.due_at for item in project.review_items if item.status in {"due", "scheduled"}),
            default=None,
        )

    def record_quiz_attempt(
        self,
        project_id: str,
        task_id: str,
        *,
        session_id: str,
        turn_id: str,
        submission_id: str,
        answers: list[dict],
    ) -> LearningProject | None:
        """Project a durable quiz submission into mastery and review evidence."""

        with _project_lock:
            project = self.load(project_id)
            if project is None or not answers:
                return project
            result_ref = f"quiz:{session_id}:{turn_id}:{submission_id}"
            event_seed = f"quiz:{session_id}:{turn_id}:{submission_id}"
            event_id = uuid5(NAMESPACE_URL, f"cognivoy:{project.id}:event:{event_seed}").hex
            if any(item.id == event_id for item in project.events):
                return project
            now = time.time()
            correct_count = sum(bool(item.get("is_correct")) for item in answers)
            score = round(correct_count / len(answers), 4)
            task = next((item for item in project.tasks if item.id == task_id), None)
            if task is not None:
                before = task.mastery_after
                task.mastery_before = before
                task.mastery_after = score
                task.updated_at = now
                task.version += 1
            self.append_event(
                project,
                "quiz_completed",
                "测验已完成" if project.language == "zh" else "Quiz completed",
                description=f"{correct_count}/{len(answers)} correct",
                task_id=task_id or None,
                result_refs=[result_ref],
                mastery_before=task.mastery_before if task else None,
                mastery_after=score,
                dedupe_key=event_seed,
            )
            for index, answer in enumerate(answers):
                question_id = str(answer.get("question_id") or index + 1)
                source_ref = f"question:{session_id}:{turn_id}:{question_id}"
                review_id = uuid5(NAMESPACE_URL, f"cognivoy:{project.id}:review:{source_ref}").hex
                knowledge_points = [
                    str(value).strip()
                    for value in (answer.get("knowledge_points") or [])
                    if str(value).strip()
                ]
                question = str(answer.get("question") or "").strip()
                title = knowledge_points[0] if knowledge_points else question[:160]
                review = next((item for item in project.review_items if item.id == review_id), None)
                mistake_category, diagnostic_reason = self._diagnose_mistake(answer)
                diagnostic_confidence = self._diagnostic_confidence(answer, mistake_category)
                if review is None:
                    review = ProjectReviewItem(
                        id=review_id,
                        title=title
                        or ("Review question" if project.language == "en" else "复习题目"),
                        knowledge_point=knowledge_points[0] if knowledge_points else "",
                        source_ref=source_ref,
                        due_at=now,
                        mistake_category=mistake_category,
                        diagnostic_reason=diagnostic_reason,
                        diagnostic_confidence=diagnostic_confidence,
                    )
                    project.review_items.append(review)
                elif not bool(answer.get("is_correct")):
                    review.mistake_category = mistake_category
                    review.diagnostic_reason = diagnostic_reason
                    review.diagnostic_confidence = diagnostic_confidence
                    review.diagnostic_evidence_count += 1
                review.attempt_count += 1
                review.last_reviewed_at = now
                review.updated_at = now
                if bool(answer.get("is_correct")):
                    review.correct_streak += 1
                    review.interval_days = self._next_review_interval(
                        project, review.correct_streak
                    )
                    review.due_at = now + review.interval_days * 86400
                    review.status = "mastered" if review.correct_streak >= 3 else "scheduled"
                else:
                    review.correct_streak = 0
                    review.interval_days = 0
                    review.due_at = now
                    review.status = "due"
                    self.append_event(
                        project,
                        "mistake_recorded",
                        review.title,
                        description="Incorrect answer added to the review queue",
                        task_id=task_id or None,
                        result_refs=[source_ref],
                        dedupe_key=f"mistake:{event_seed}:{question_id}",
                    )
            self.append_event(
                project,
                "review_scheduled",
                "复习队列已更新" if project.language == "zh" else "Review queue updated",
                description=f"{len(answers) - correct_count} due after this quiz",
                task_id=task_id or None,
                result_refs=[result_ref],
                dedupe_key=f"review:{event_seed}",
            )
            self.refresh_learning_outcomes(project)
            project.version += 1
            project.updated_at = now
            project.last_activity_at = now
            atomic_write_text(self._path(project.id), project.model_dump_json(indent=2))
            reconcile_project_partner_outreach(project)
            return project

    def complete_review(
        self,
        project_id: str,
        review_id: str,
        *,
        is_correct: bool,
        attempt_id: str,
        expected_version: int,
    ) -> tuple[LearningProject, ProjectReviewItem]:
        """Complete one project review with CAS and idempotent attempt identity."""

        with _project_lock:
            project = self.load(project_id)
            if project is None:
                raise FileNotFoundError(project_id)
            review = next((item for item in project.review_items if item.id == review_id), None)
            if review is None:
                raise KeyError(review_id)
            event_id = uuid5(
                NAMESPACE_URL,
                f"cognivoy:{project.id}:event:review-complete:{review.id}:{attempt_id}",
            ).hex
            if any(item.id == event_id for item in project.events):
                return project, review
            if project.version != expected_version:
                raise RuntimeError(f"revision_conflict:{project.version}")
            now = time.time()
            review.attempt_count += 1
            review.last_reviewed_at = now
            review.updated_at = now
            if is_correct:
                review.correct_streak += 1
                review.interval_days = self._next_review_interval(project, review.correct_streak)
                review.due_at = now + review.interval_days * 86400
                review.status = "mastered" if review.correct_streak >= 3 else "scheduled"
                review.diagnostic_confidence = min(1.0, review.diagnostic_confidence + 0.08)
            else:
                review.correct_streak = 0
                review.interval_days = 0
                review.due_at = now
                review.status = "due"
                review.diagnostic_confidence = max(0.15, review.diagnostic_confidence - 0.06)
            review.diagnostic_evidence_count += 1
            self.append_event(
                project,
                "review_completed",
                review.title,
                description="Correct" if is_correct else "Needs another review",
                result_refs=[review.source_ref],
                dedupe_key=f"review-complete:{review.id}:{attempt_id}",
                mastery_after=1.0 if is_correct else 0.0,
            )
            self.refresh_learning_outcomes(project)
            project.version += 1
            project.updated_at = now
            project.last_activity_at = now
            atomic_write_text(self._path(project.id), project.model_dump_json(indent=2))
            reconcile_project_partner_outreach(project)
            return project, review

    def record_linked_resource_activity(
        self,
        *,
        owner_id: str,
        resource_type: str,
        resource_ids: list[str],
        title: str,
        description: str = "",
        result_refs: list[str] | None = None,
        dedupe_key: str,
    ) -> list[LearningProject]:
        """Append one idempotent activity to every project linked to a resource.

        Resource modules remain independently usable. This bridge only writes
        learner-visible evidence when the same stable resource id is already
        attached to an owner-scoped learning project.
        """

        fields = {
            "knowledge_base": "knowledge_base_ids",
            "book": "book_ids",
            "notebook": "notebook_ids",
        }
        field = fields.get(resource_type)
        normalized_ids = {str(value).strip() for value in resource_ids if str(value).strip()}
        if field is None or not owner_id or not normalized_ids or not dedupe_key:
            return []
        updated: list[LearningProject] = []
        with _project_lock:
            for project in self.list():
                linked_ids = set(getattr(project, field, []))
                if project.owner_id != owner_id or not (linked_ids & normalized_ids):
                    continue
                event_seed = f"resource:{resource_type}:{dedupe_key}"
                event_id = uuid5(
                    NAMESPACE_URL,
                    f"cognivoy:{project.id}:event:{event_seed}",
                ).hex
                if any(item.id == event_id for item in project.events):
                    continue
                self.append_event(
                    project,
                    "resource_activity",
                    title,
                    description=description,
                    result_refs=list(result_refs or []),
                    dedupe_key=event_seed,
                )
                now = time.time()
                project.version += 1
                project.updated_at = now
                project.last_activity_at = now
                atomic_write_text(
                    self._path(project.id),
                    project.model_dump_json(indent=2),
                )
                updated.append(project)
        return updated

    def record_external_event(
        self,
        project_id: str,
        *,
        owner_id: str,
        event_type: LearningEventType,
        title: str,
        description: str = "",
        result_refs: list[str] | None = None,
        dedupe_key: str,
    ) -> LearningProject | None:
        """Record an owner-scoped cross-module event without weakening CAS APIs."""

        with _project_lock:
            project = self.load(project_id)
            if project is None or project.owner_id != owner_id:
                return None
            seed = f"external:{dedupe_key}"
            event_id = uuid5(
                NAMESPACE_URL,
                f"cognivoy:{project.id}:event:{seed}",
            ).hex
            if any(item.id == event_id for item in project.events):
                return project
            self.append_event(
                project,
                event_type,
                title,
                description=description,
                result_refs=list(result_refs or []),
                dedupe_key=seed,
            )
            now = time.time()
            project.version += 1
            project.updated_at = now
            project.last_activity_at = now
            atomic_write_text(self._path(project.id), project.model_dump_json(indent=2))
            return project

    def start_structured_session(
        self,
        project_id: str,
        task_id: str,
        *,
        session_id: str,
    ) -> tuple[LearningProject, LearningTask] | None:
        """Idempotently attach a recoverable teaching session to a task."""

        with _project_lock:
            project = self.load(project_id)
            if project is None:
                return None
            task = next((item for item in project.tasks if item.id == task_id), None)
            if task is None:
                return None
            if task.learning_session is not None:
                return project, task
            now = time.time()
            task.learning_session = LearningSessionState(
                session_id=session_id,
                started_at=now,
                updated_at=now,
            )
            task.updated_at = now
            task.version += 1
            project.version += 1
            project.updated_at = now
            project.last_activity_at = now
            atomic_write_text(self._path(project.id), project.model_dump_json(indent=2))
            return project, task

    def structured_session_status(
        self,
        project_id: str,
        task_id: str,
    ) -> dict[str, Any] | None:
        """Return the learner-visible recovery state for one teaching task."""

        with _project_lock:
            project = self.load(project_id)
            if project is None:
                return None
            task = next((item for item in project.tasks if item.id == task_id), None)
            if task is None or task.learning_session is None:
                return None
            state = task.learning_session
            return {
                "status": state.status,
                "current_phase": state.current_phase,
                "next_phases": sorted(_allowed_session_phases(state)),
                "exit_check_passed": state.exit_check_passed,
                "transfer_passed": state.transfer_passed,
                "checkpoints": [
                    {
                        "phase": item.phase,
                        "passed": item.passed,
                        "summary": item.summary,
                    }
                    for item in state.checkpoints
                ],
            }

    def record_session_checkpoint(
        self,
        project_id: str,
        task_id: str,
        *,
        session_id: str,
        turn_id: str,
        phase: LearningSessionPhase,
        passed: bool | None,
        summary: str = "",
    ) -> tuple[LearningProject, LearningTask]:
        """Persist one valid teaching-stage transition with server evidence."""

        with _project_lock:
            project = self.load(project_id)
            if project is None:
                raise FileNotFoundError(project_id)
            task = next((item for item in project.tasks if item.id == task_id), None)
            if task is None:
                raise KeyError(task_id)
            state = task.learning_session
            if state is None:
                state = LearningSessionState(session_id=session_id)
                task.learning_session = state
            else:
                # The durable teaching session belongs to the task, not to a
                # particular chat transport. A learner may resume it from a
                # new chat session after navigation, refresh, or interruption.
                session_id = state.session_id
            if state.status == "verified":
                return project, task
            if phase in _ASSESSED_SESSION_PHASES and passed is None:
                raise ValueError(f"{phase} requires a passed result")

            normalized_summary = str(summary or "").strip()[:1000]
            existing = next(
                (
                    item
                    for item in state.checkpoints
                    if item.phase == phase
                    and item.turn_id == turn_id
                    and item.passed == (passed if phase in _ASSESSED_SESSION_PHASES else None)
                    and item.summary == normalized_summary
                ),
                None,
            )
            if existing is not None:
                return project, task

            allowed = _allowed_session_phases(state)
            if phase not in allowed:
                expected = ", ".join(sorted(allowed)) or "none"
                raise ValueError(
                    f"invalid learning session transition: {phase}; expected {expected}"
                )

            now = time.time()
            evidence_ref = (
                f"learning-session:{session_id}:{turn_id or 'turn'}:"
                f"{len(state.checkpoints) + 1}:{phase}"
            )
            checkpoint = LearningSessionCheckpoint(
                phase=phase,
                passed=passed if phase in _ASSESSED_SESSION_PHASES else None,
                summary=normalized_summary,
                evidence_ref=evidence_ref,
                turn_id=turn_id,
                created_at=now,
            )
            state.checkpoints.append(checkpoint)
            state.current_phase = phase
            if phase == "exit_check":
                state.exit_check_passed = bool(passed)
                if not passed:
                    state.transfer_passed = False
            elif phase == "transfer":
                state.transfer_passed = bool(passed)
            if state.exit_check_passed and state.transfer_passed:
                state.status = "verified"
            state.updated_at = now
            task.updated_at = now
            task.version += 1
            project.version += 1
            project.updated_at = now
            project.last_activity_at = now
            atomic_write_text(self._path(project.id), project.model_dump_json(indent=2))
            return project, task

    @staticmethod
    def _next_review_interval(project: LearningProject, correct_streak: int) -> int:
        schedules = {
            "intensive": (1, 3, 7, 14, 30),
            "balanced": (1, 3, 7, 30),
            "light": (1, 7, 30),
        }
        schedule = schedules[project.review_preferences.intensity]
        return schedule[min(max(correct_streak, 1) - 1, len(schedule) - 1)]

    @staticmethod
    def _diagnose_mistake(answer: dict) -> tuple[str, str]:
        """Return a conservative, learner-facing error category.

        A grader-supplied category wins when available. Otherwise use only
        observable answer evidence and label ambiguous cases as a likely
        misunderstanding instead of pretending to know the learner's intent.
        """

        allowed = {
            "concept",
            "prerequisite",
            "calculation",
            "misunderstanding",
            "question_reading",
            "expression",
            "guessing",
            "unknown",
        }
        supplied = str(answer.get("error_type") or "").strip().lower()
        if supplied in allowed:
            reason = str(answer.get("diagnostic_reason") or "").strip()
            return supplied, reason or "Classified by the quiz assessment."
        submitted = str(answer.get("user_answer") or "").strip()
        expected = str(answer.get("correct_answer") or "").strip()
        question_type = str(answer.get("question_type") or "").strip().lower()
        if not submitted:
            return "expression", "No complete answer was submitted."
        if bool(answer.get("was_guess")):
            return "guessing", "The answer was marked as a guess."
        numeric_chars = set("0123456789.-+*/() %=,")
        if (
            submitted
            and expected
            and set(submitted) <= numeric_chars
            and set(expected) <= numeric_chars
        ):
            return "calculation", "The submitted calculation did not match the expected result."
        if question_type in {"short_answer", "written", "oral"}:
            return (
                "expression",
                "The response did not yet satisfy the expected explanation or rubric.",
            )
        if question_type in {"multiple_choice", "multiple_select", "true_false", "fill_blank"}:
            return (
                "misunderstanding",
                "The selected answer conflicts with the expected concept evidence.",
            )
        return "unknown", "More evidence is needed to identify the error type reliably."

    @staticmethod
    def _diagnostic_confidence(answer: dict, category: str) -> float:
        """Calibrate a diagnosis from its evidence source and later reviews."""

        supplied = str(answer.get("error_type") or "").strip().lower()
        grader_confidence = answer.get("diagnostic_confidence")
        if supplied == category and grader_confidence is not None:
            try:
                return round(max(0.15, min(0.9, float(grader_confidence))), 4)
            except (TypeError, ValueError):
                pass
        if supplied == category:
            return 0.72
        if category in {"calculation", "expression", "guessing"}:
            return 0.58
        if category == "unknown":
            return 0.2
        return 0.42

    @staticmethod
    def merge_mastery_progress(project: LearningProject, task: LearningTask, progress) -> None:
        """Project the mastery engine's evidence into the cross-module project."""

        if progress is None:
            return
        from cognivoy.learning.policy import display_mastery, is_mastered

        scores: list[float] = []
        weak_points: list[str] = []
        for module in progress.modules:
            for knowledge_point in module.knowledge_points:
                score = display_mastery(progress, knowledge_point)
                scores.append(score)
                if not is_mastered(progress, knowledge_point):
                    weak_points.append(knowledge_point.name)
        if scores:
            task.mastery_after = round(sum(scores) / len(scores), 4)
        project.weak_points = list(
            dict.fromkeys(
                [
                    *weak_points,
                    *(
                        item.knowledge_point or item.title
                        for item in project.review_items
                        if item.status == "due"
                    ),
                ]
            )
        )[:12]
        now = time.time()
        project.due_review_count = sum(item.due_at <= now for item in progress.review_queue) + sum(
            item.status == "due" or (item.status == "scheduled" and item.due_at <= now)
            for item in project.review_items
        )
        project.next_review_at = min(
            [
                *(item.due_at for item in progress.review_queue),
                *(
                    item.due_at
                    for item in project.review_items
                    if item.status in {"due", "scheduled"}
                ),
            ],
            default=None,
        )

    def complete_task_from_turn(
        self,
        project_id: str,
        task_id: str,
        *,
        session_id: str,
    ) -> tuple[LearningProject, LearningTask | None] | None:
        """Idempotently complete one task and materialize the next plan step."""

        with _project_lock:
            project = self.load(project_id)
            if project is None:
                return None
            task = next((item for item in project.tasks if item.id == task_id), None)
            if task is None:
                return None
            # New sessions use a hard exit gate. Legacy tasks without a
            # structured session retain their historical completion behavior
            # so existing projects remain compatible during migration.
            if task.learning_session is not None and task.learning_session.status != "verified":
                return None
            result_ref = f"session:{session_id}"
            if task.status == "completed" and result_ref in task.result_refs:
                next_task = next(
                    (item for item in project.tasks if item.status in {"todo", "in_progress"}),
                    None,
                )
                return project, next_task
            mastery_progress = None
            if task.status != "completed":
                now = time.time()
                mastery_progress = _load_mastery_progress(session_id)
                self.merge_mastery_progress(project, task, mastery_progress)
                task.status = "completed"
                task.completed_at = now
                task.updated_at = now
                task.version += 1
                if result_ref not in task.result_refs:
                    task.result_refs.append(result_ref)
                if task.learning_session is not None:
                    for checkpoint in task.learning_session.checkpoints:
                        if checkpoint.evidence_ref not in task.result_refs:
                            task.result_refs.append(checkpoint.evidence_ref)
                self.append_event(
                    project,
                    "task_completed",
                    task.objective,
                    description="Completed in guided learning",
                    task_id=task.id,
                    result_refs=task.result_refs,
                    mastery_before=task.mastery_before,
                    mastery_after=task.mastery_after,
                    dedupe_key=f"turn-complete:{task.id}:{session_id}",
                )
                if task.mastery_after is not None:
                    self.append_event(
                        project,
                        "mastery_updated",
                        task.objective,
                        description=f"Mastery updated to {task.mastery_after:.0%}",
                        task_id=task.id,
                        mastery_before=task.mastery_before,
                        mastery_after=task.mastery_after,
                        dedupe_key=f"turn-mastery:{task.id}:{session_id}",
                    )
                if project.next_review_at is not None:
                    self.append_event(
                        project,
                        "review_scheduled",
                        task.objective,
                        description="Spaced review scheduled from mastery evidence",
                        task_id=task.id,
                        dedupe_key=f"turn-review:{task.id}:{session_id}",
                    )

            next_task: LearningTask | None = None
            completed_count = sum(item.status == "completed" for item in project.tasks)
            if completed_count < len(project.weekly_plan):
                objective = project.weekly_plan[completed_count]
                deterministic_id = uuid5(
                    NAMESPACE_URL,
                    f"cognivoy:{project.id}:weekly-plan:{completed_count}",
                ).hex
                next_task = next(
                    (
                        item
                        for item in project.tasks
                        if item.id == deterministic_id
                        or item.objective.strip() == objective.strip()
                    ),
                    None,
                )
                if next_task is None:
                    next_task = LearningTask(
                        id=deterministic_id,
                        project_id=project.id,
                        objective=objective,
                        expected_minutes=max(15, min(45, project.weekly_minutes // 4)),
                        intent="mastery_path",
                        due_at=time.time(),
                    )
                    project.tasks.append(next_task)
                    self.append_event(
                        project,
                        "task_created",
                        next_task.objective,
                        description="Added from the weekly learning plan",
                        task_id=next_task.id,
                        dedupe_key=f"weekly-plan-task:{next_task.id}",
                    )
            elif project.tasks and all(
                item.status in {"completed", "skipped"} for item in project.tasks
            ):
                project.status = "completed"

            now = time.time()
            self.refresh_learning_outcomes(project)
            if mastery_progress is not None:
                self.merge_mastery_progress(project, task, mastery_progress)
            project.version += 1
            project.updated_at = now
            project.last_activity_at = now
            atomic_write_text(self._path(project.id), project.model_dump_json(indent=2))
            return project, next_task


__all__ = ["LearningProjectStore"]
