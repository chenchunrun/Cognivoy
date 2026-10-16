from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import logging
import time
from typing import TYPE_CHECKING
import uuid

from cognivoy.learning.grading import classify_error, grade_answer
from cognivoy.learning.mastery import compute_mastery
from cognivoy.learning.models import (
    ErrorRecord,
    LearningModule,
    LearningProgress,
    LearningStage,
    PendingQuestion,
    QuizAttempt,
    RetryAttempt,
)
from cognivoy.learning.policy import current_streak_days, due_reviews
from cognivoy.learning.storage import LearningStore
from cognivoy.services.partners.proactive_learning import schedule_proactive_event

if TYPE_CHECKING:
    from cognivoy.learning.scheduler import SpacedRepetitionScheduler

logger = logging.getLogger(__name__)


def _schedule_outreach(**kwargs) -> list[str]:
    """Best-effort bridge from learning state to opt-in TutorBot policies.

    Learning progress is authoritative and must still save when Partner/Cron
    storage is unavailable.  Scheduling failures are therefore observable in
    logs but never roll back an answer or path mutation.
    """
    try:
        return schedule_proactive_event(**kwargs)
    except Exception:
        logging.getLogger(__name__).warning(
            "Failed to schedule TutorBot learning outreach",
            exc_info=True,
        )
        return []


def _refresh_inactivity_outreach(
    progress: LearningProgress,
    *,
    now: datetime,
) -> list[str]:
    return _schedule_outreach(
        event_type="inactivity",
        event_key=f"learning:{progress.book_id}",
        message=(
            "The learner has not continued this learning path for seven days. "
            "Offer a short, low-pressure next step and allow them to dismiss the reminder."
        ),
        desired_at=now + timedelta(days=7),
        now=now,
        metadata={"book_id": progress.book_id, "inactivity_days": 7},
        replace_existing=True,
    )


def schedule_learning_plan_outreach(
    progress: LearningProgress,
    *,
    now: datetime | None = None,
) -> list[str]:
    """Schedule the first plan checkpoint and reset the inactivity deadline."""
    moment = now or datetime.now(timezone.utc)
    plan_shape = "|".join(
        f"{module.id}:{','.join(kp.id for kp in module.knowledge_points)}"
        for module in progress.modules
    )
    version = hashlib.sha256(plan_shape.encode("utf-8")).hexdigest()[:12]
    module_names = ", ".join(module.name for module in progress.modules[:3])
    jobs = _schedule_outreach(
        event_type="learning_plan",
        event_key=f"{progress.book_id}:{version}",
        message=(
            f"Check in on the new learning plan for {progress.book_id}. "
            f"The first modules are: {module_names or 'not yet named'}. "
            "Help the learner choose one concrete next step."
        ),
        desired_at=moment + timedelta(days=1),
        now=moment,
        metadata={
            "book_id": progress.book_id,
            "module_count": len(progress.modules),
            "plan_version": version,
        },
    )
    jobs.extend(_refresh_inactivity_outreach(progress, now=moment))
    return jobs


class LearningService:
    def __init__(self, store: LearningStore | None = None) -> None:
        self._store = store or LearningStore()

    def get_or_create(self, book_id: str) -> LearningProgress:
        existing = self._store.load(book_id)
        if existing is not None:
            return existing
        progress = LearningProgress(book_id=book_id)
        self._store.save(progress)  # persist immediately to prevent race
        return progress

    def init_modules(self, progress: LearningProgress, modules: list[LearningModule]) -> None:
        """Initialize the runnable module set (replace semantics)."""
        self.replace_modules(progress, modules)

    def replace_modules(self, progress: LearningProgress, modules: list[LearningModule]) -> None:
        """Replace all modules and clean stale KP state."""
        new_kp_ids = {kp.id for m in modules for kp in m.knowledge_points}

        # Clean stale KP state
        for key in list(progress.mastery_levels.keys()):
            if key not in new_kp_ids:
                del progress.mastery_levels[key]
        for key in list(progress.knowledge_types.keys()):
            if key not in new_kp_ids:
                del progress.knowledge_types[key]
        for key in list(progress.repetition_states.keys()):
            if key not in new_kp_ids:
                del progress.repetition_states[key]
        progress.error_records = [
            r for r in progress.error_records if r.knowledge_point_id in new_kp_ids
        ]
        progress.feynman_retries = {
            k: v for k, v in progress.feynman_retries.items() if k in new_kp_ids
        }
        progress.feynman_explanations = {
            k: v for k, v in progress.feynman_explanations.items() if k in new_kp_ids
        }
        progress.review_queue = [
            t for t in progress.review_queue if t.knowledge_point_id in new_kp_ids
        ]
        # Clear global stage failure records — different modules should not share failure counts
        progress.stage_failure_counts = {}
        progress.stage_failure_notes = {}

        # Set new modules
        progress.modules = list(modules)
        for mod in modules:
            for kp in mod.knowledge_points:
                progress.knowledge_types[kp.id] = kp.type

    def advance_stage(self, progress: LearningProgress, next_stage: LearningStage) -> None:
        progress.current_stage = next_stage
        progress.updated_at = time.time()

    def switch_module(self, progress: LearningProgress, module_id: str) -> bool:
        """Point the session at ``module_id`` and reset it to that module's
        first teaching stage (EXPLAIN). Mutates ``progress`` in place and returns
        whether the module exists. The caller is responsible for persisting
        (``save``) — typically *after* cancelling any in-flight turn so the
        turn's teardown cannot overwrite the switch with stale progress.
        """
        found = any(m.id == module_id for m in progress.modules)
        if found:
            progress.current_module_id = module_id
            progress.current_kp_index = 0
            progress.current_stage = LearningStage.EXPLAIN
            progress.updated_at = time.time()
        return found

    def record_quiz_attempt(self, progress: LearningProgress, attempt: QuizAttempt) -> None:
        if not attempt.is_correct and attempt.error_type is not None:
            # Find existing error record for this question + knowledge point.
            existing = None
            for rec in progress.error_records:
                if (
                    rec.question_id == attempt.question_id
                    and rec.knowledge_point_id == attempt.knowledge_point_id
                ):
                    existing = rec
                    break

            if existing is not None:
                existing.retry_history.append(
                    RetryAttempt(
                        timestamp=time.time(),
                        is_correct=False,
                        attempt_number=len(existing.retry_history) + 1,
                    )
                )
                existing.status = "retrying"
            else:
                record = ErrorRecord(
                    id=uuid.uuid4().hex,
                    question_id=attempt.question_id,
                    knowledge_point_id=attempt.knowledge_point_id,
                    module_id=attempt.module_id,
                    error_type=attempt.error_type,
                    self_attribution=attempt.self_attribution,
                    status="active",
                )
                progress.error_records.append(record)

        elif attempt.is_correct:
            # Graduate any active error record for this question + knowledge point.
            for rec in progress.error_records:
                if (
                    rec.question_id == attempt.question_id
                    and rec.knowledge_point_id == attempt.knowledge_point_id
                    and rec.status in ("active", "retrying")
                ):
                    rec.retry_history.append(
                        RetryAttempt(
                            timestamp=time.time(),
                            is_correct=True,
                            attempt_number=len(rec.retry_history) + 1,
                        )
                    )
                    rec.status = "graduated"
                    break

        progress.quiz_attempts.append(attempt)
        progress.updated_at = time.time()

    def calculate_mastery(self, progress: LearningProgress, kp_id: str) -> float:
        """Mastery 0..1 for *kp_id* from its attempt history (policy in mastery.py)."""
        correctness = [
            a.is_correct for a in progress.quiz_attempts if a.knowledge_point_id == kp_id
        ]
        return compute_mastery(correctness)

    def update_mastery(self, progress: LearningProgress, kp_id: str, level: float) -> None:
        previous = float(progress.mastery_levels.get(kp_id, 0.0) or 0.0)
        progress.mastery_levels[kp_id] = level
        progress.updated_at = time.time()
        if previous < 0.8 <= level:
            try:
                from cognivoy.services.observability import get_slo_service

                get_slo_service().record_business_event("learning_completed")
            except Exception:
                logger.debug("Unable to record learning completion SLI", exc_info=True)

    def grade_and_record(
        self,
        progress: LearningProgress,
        *,
        question_id: str,
        knowledge_point_id: str,
        module_id: str,
        user_answer: str,
        expected_answer: str,
        question_type: str = "short",
        self_attribution: str = "",
        hints_used: int = 0,
        elapsed_ms: int | None = None,
        source_refs: list[str] | None = None,
        judge_confidence: float | None = None,
        scheduler: SpacedRepetitionScheduler | None = None,
    ) -> bool:
        """Grade one answer and fold it through the full post-answer pipeline.

        record attempt -> recompute mastery -> advance the spaced-repetition
        state -> rebuild the review queue -> persist. This is the single source
        of truth for what happens when a student answers, shared by every
        interactive stage. Grading is fail-closed: with no stored expected
        answer the attempt is recorded wrong, never right.
        """
        is_correct = bool(expected_answer) and grade_answer(
            user_answer, expected_answer, question_type
        )
        self.record_quiz_attempt(
            progress,
            QuizAttempt(
                question_id=question_id,
                knowledge_point_id=knowledge_point_id,
                module_id=module_id,
                is_correct=is_correct,
                user_answer=user_answer,
                self_attribution=self_attribution,
                hints_used=hints_used,
                elapsed_ms=elapsed_ms,
                source_refs=list(source_refs or []),
                judge_confidence=judge_confidence,
                error_type=None if is_correct else classify_error(user_answer),
            ),
        )
        review_due_at: float | None = None
        if knowledge_point_id:
            self.update_mastery(
                progress, knowledge_point_id, self.calculate_mastery(progress, knowledge_point_id)
            )
            kp_type = progress.knowledge_types.get(knowledge_point_id)
            if kp_type is not None and scheduler is not None:
                state = progress.repetition_states.get(
                    knowledge_point_id
                ) or scheduler.get_initial_state(kp_type)
                progress.repetition_states[knowledge_point_id] = state
                scheduler.schedule_next(state, kp_type, is_correct)
                progress.review_queue = scheduler.build_review_queue(progress)
                review_due_at = state.next_review_at
        self.save(progress)
        moment = datetime.now(timezone.utc)
        if review_due_at is not None:
            due_at = datetime.fromtimestamp(review_due_at, tz=timezone.utc)
            _schedule_outreach(
                event_type="due_review",
                event_key=(f"{progress.book_id}:{knowledge_point_id}:{int(review_due_at)}"),
                message=(
                    f"The knowledge point {knowledge_point_id} in learning path "
                    f"{progress.book_id} is due for spaced review. Start with retrieval, "
                    "then offer a hint if needed."
                ),
                desired_at=due_at,
                now=moment,
                metadata={
                    "book_id": progress.book_id,
                    "knowledge_point_id": knowledge_point_id,
                    "module_id": module_id,
                    "question_id": question_id,
                },
            )
        _refresh_inactivity_outreach(progress, now=moment)
        return is_correct

    # ── Loop-driven tutoring helpers ─────────────────────────────────────

    def set_pending_question(self, progress: LearningProgress, pending: PendingQuestion) -> None:
        """Store the question the tutor just posed so its expected answer can
        be graded deterministically on a later turn (never via the model)."""
        progress.pending_question = pending
        progress.updated_at = time.time()
        self.save(progress)

    def clear_pending_question(self, progress: LearningProgress) -> None:
        progress.pending_question = None
        progress.updated_at = time.time()
        self.save(progress)

    def record_qualitative(
        self,
        progress: LearningProgress,
        kp_id: str,
        *,
        passed: bool,
        evidence: str = "",
    ) -> None:
        """Record the qualitative (CONCEPT / DESIGN) gate outcome.

        The boolean is the gate of record; ``mastery_levels`` is nudged only so
        the map's colour matches the gate (full on pass, capped on fail).
        """
        progress.qualitative_mastery[kp_id] = bool(passed)
        current = progress.mastery_levels.get(kp_id, 0.0)
        progress.mastery_levels[kp_id] = max(current, 1.0) if passed else min(current, 0.4)
        if evidence:
            progress.feynman_explanations[kp_id] = evidence
        progress.updated_at = time.time()
        self.save(progress)

    def list_progress(self) -> dict:
        """Return summary of all book progress with per-book error info."""
        logger = logging.getLogger(__name__)

        book_ids = self._store.list_all()
        summaries = []
        errors = []
        for bid in book_ids:
            try:
                progress = self._store.load(bid)
                if progress is None:
                    continue
                # Only count KPs from current modules (exclude stale IDs)
                current_kp_ids = {kp.id for m in progress.modules for kp in m.knowledge_points}
                total_kps = len(current_kp_ids)
                total_mastery = sum(
                    progress.mastery_levels.get(kp_id, 0) for kp_id in current_kp_ids
                )
                # Derive display name from first module, fall back to book_id
                display_name = ""
                if progress.modules:
                    display_name = progress.modules[0].name or ""
                summaries.append(
                    {
                        "book_id": progress.book_id,
                        "name": display_name or progress.book_id,
                        "modules_count": len(progress.modules),
                        "kp_count": total_kps,
                        "current_stage": progress.current_stage.value
                        if progress.current_stage
                        else "",
                        # Average mastery across current KPs (not the % of KPs mastered).
                        "avg_mastery_pct": round(total_mastery / total_kps * 100)
                        if total_kps
                        else 0,
                        # Keep the high-frequency home dashboard on this
                        # aggregate endpoint.  Fetching every mastery map just
                        # to count reviews turns one page load into N+1 calls.
                        "due_reviews": len(due_reviews(progress)),
                        "evidence_count": len(progress.quiz_attempts),
                        "current_streak_days": current_streak_days(progress),
                        "updated_at": progress.updated_at,
                    }
                )
            except Exception:
                logger.warning("Failed to load progress for book %s, skipping", bid, exc_info=True)
                errors.append({"book_id": bid, "error": "Failed to load"})
                continue
        return {"summaries": summaries, "errors": errors}

    def save(self, progress: LearningProgress) -> None:
        self._store.save(progress)


__all__ = ["LearningService", "schedule_learning_plan_outreach"]
