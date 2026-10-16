"""Tests for the grading module and the unified post-answer pipeline.

``grade_answer`` is the pure correctness check. ``classify_error`` is the
coarse wrong-answer tagger. ``LearningService.grade_and_record`` folds both of
those through the full record -> mastery -> spaced-repetition pipeline and is
fail-closed: with no stored expected answer the attempt is recorded wrong.
"""

import pytest

from cognivoy.learning.grading import classify_error, grade_answer
from cognivoy.learning.models import (
    ErrorType,
    KnowledgePoint,
    KnowledgeType,
    LearningModule,
    LearningProgress,
)
from cognivoy.learning.scheduler import SpacedRepetitionScheduler
from cognivoy.learning.service import LearningService
from cognivoy.learning.storage import LearningStore


class TestChoiceGrading:
    def test_choice_exact_match(self):
        assert grade_answer("A", "A", "choice") is True

    def test_choice_case_insensitive(self):
        assert grade_answer("b", "B", "choice") is True

    def test_choice_with_spaces(self):
        assert grade_answer("A ", " A", "choice") is True

    def test_choice_wrong(self):
        assert grade_answer("C", "A", "choice") is False


class TestShortGrading:
    def test_short_exact_match(self):
        assert grade_answer("photosynthesis", "photosynthesis", "short") is True

    def test_short_typo_requires_review(self):
        # Similar spelling is not evidence of semantic equivalence.
        assert grade_answer("photosynthesi", "photosynthesis", "short") is False

    def test_short_fuzzy_fail(self):
        assert grade_answer("completely different", "photosynthesis", "short") is False

    def test_short_long_expected_no_fuzzy(self):
        long_expected = "a" * 31  # >30 chars, no fuzzy
        assert grade_answer(long_expected, long_expected, "short") is True
        assert grade_answer("something else entirely", long_expected, "short") is False


class TestOpenGrading:
    def test_open_keyword_prose_requires_review(self):
        expected = "cell membrane, nucleus, mitochondria"
        user = "The cell has a cell membrane and nucleus, with mitochondria for energy"
        assert grade_answer(user, expected, "open") is False

    def test_open_keywords_fail(self):
        expected = "cell membrane, nucleus, mitochondria"
        user = "I don't know anything about cells"
        assert grade_answer(user, expected, "open") is False

    def test_open_chinese_keyword_prose_requires_review(self):
        expected = "光合作用；叶绿体；二氧化碳"
        user = "光合作用发生在叶绿体中，需要二氧化碳"
        assert grade_answer(user, expected, "open") is False


@pytest.mark.parametrize("question_type", ["short", "open"])
@pytest.mark.parametrize(
    ("user", "expected"),
    [
        ("x = -10", "x = 10"),
        ("x = −10", "x = 10"),
        ("x < 10", "x > 10"),
        ("0.01", "0.1"),
        ("10 mg", "10 g"),
        ("10 mW", "10 MW"),
        ("不需要风险评估，不需要访问控制", "风险评估,访问控制"),
        ("风险评估是错误的；访问控制也是错误的", "风险评估；访问控制"),
        ("Do not use risk assessment or access control", "risk assessment,access control"),
        ("风险评估；访问控制；备份", "风险评估；访问控制；加密"),
    ],
)
def test_semantic_changes_never_award_mastery(user, expected, question_type):
    assert grade_answer(user, expected, question_type) is False


@pytest.mark.parametrize("question_type", ["short", "open"])
@pytest.mark.parametrize("answer", ["x = -10", "不应共享密码", "风险评估；访问控制", "10 MW"])
def test_exact_free_text_preserves_meaning(answer, question_type):
    assert grade_answer(f"  {answer}\n", answer, question_type) is True


class TestEdgeCases:
    def test_empty_expected_returns_false(self):
        assert grade_answer("anything", "", "short") is False
        assert grade_answer("anything", "  ", "short") is False

    def test_empty_user_answer(self):
        assert grade_answer("", "expected", "short") is False

    def test_substring_no_longer_matches(self):
        """Regression: 'expected in user' substring match must not cause false positive."""
        user = "I do not know electromagnetic induction but maybe something else"
        expected = "electromagnetic induction"
        assert grade_answer(user, expected, "short") is False

    def test_unknown_type_returns_false(self):
        assert grade_answer("a", "a", "unknown") is False


class TestClassifyError:
    """Coarse wrong-answer tagging used by the post-answer pipeline.

    Blank means "I didn't know" (metacognitive); anything else is treated as a
    wrong application. The richer taxonomy is assigned later by the LLM.
    """

    def test_blank_answer_is_metacognitive(self):
        assert classify_error("") is ErrorType.METACOGNITIVE

    def test_whitespace_only_answer_is_metacognitive(self):
        assert classify_error("   \n\t  ") is ErrorType.METACOGNITIVE

    def test_nonblank_answer_is_application_error(self):
        assert classify_error("the answer is 42") is ErrorType.APPLICATION_ERROR


def _progress_with_kp(kp_type: KnowledgeType = KnowledgeType.CONCEPT) -> LearningProgress:
    progress = LearningProgress(book_id="book1")
    progress.modules = [
        LearningModule(
            id="m1",
            name="Module 1",
            order=0,
            knowledge_points=[KnowledgePoint(id="kp1", name="KP1", type=kp_type, module_id="m1")],
        )
    ]
    progress.knowledge_types["kp1"] = kp_type
    return progress


class TestGradeAndRecordFailClosed:
    """``grade_and_record`` is the single post-answer pipeline. It must never
    grade an answer correct when there is no stored expected answer, and it must
    fold correctness through attempt history, mastery, and error records."""

    @pytest.mark.parametrize(
        ("answer", "expected", "question_type"),
        [
            ("x = -10", "x = 10", "short"),
            ("不需要风险评估，不需要访问控制", "风险评估,访问控制", "open"),
        ],
    )
    def test_semantic_error_persists_without_mastery_credit(
        self, tmp_path, answer, expected, question_type
    ):
        store = LearningStore(root=tmp_path)
        service = LearningService(store)
        progress = _progress_with_kp()
        for index in range(3):
            assert (
                service.grade_and_record(
                    progress,
                    question_id=f"q{index}",
                    knowledge_point_id="kp1",
                    module_id="m1",
                    user_answer=answer,
                    expected_answer=expected,
                    question_type=question_type,
                    scheduler=SpacedRepetitionScheduler(),
                )
                is False
            )
        loaded = store.load("book1")
        assert loaded is not None
        assert len(loaded.quiz_attempts) == 3
        assert all(not attempt.is_correct for attempt in loaded.quiz_attempts)
        assert loaded.mastery_levels["kp1"] == 0.0
        assert loaded.error_records
        assert all(error.status == "active" for error in loaded.error_records)
        assert any(item.knowledge_point_id == "kp1" for item in loaded.review_queue)

    def test_no_expected_answer_is_wrong_and_records_error(self, tmp_path):
        service = LearningService(LearningStore(root=tmp_path))
        progress = _progress_with_kp()

        result = service.grade_and_record(
            progress,
            question_id="q1",
            knowledge_point_id="kp1",
            module_id="m1",
            user_answer="anything plausible",
            expected_answer="",  # missing expected -> fail-closed
        )

        assert result is False
        assert len(progress.quiz_attempts) == 1
        attempt = progress.quiz_attempts[0]
        assert attempt.is_correct is False
        # Non-blank wrong answer is an application error and opens an error record.
        assert attempt.error_type is ErrorType.APPLICATION_ERROR
        assert len(progress.error_records) == 1
        assert progress.error_records[0].status == "active"
        assert progress.error_records[0].error_type is ErrorType.APPLICATION_ERROR

    def test_blank_wrong_answer_is_metacognitive(self, tmp_path):
        service = LearningService(LearningStore(root=tmp_path))
        progress = _progress_with_kp()

        result = service.grade_and_record(
            progress,
            question_id="q1",
            knowledge_point_id="kp1",
            module_id="m1",
            user_answer="",
            expected_answer="photosynthesis",
        )

        assert result is False
        assert progress.quiz_attempts[0].error_type is ErrorType.METACOGNITIVE

    def test_correct_answer_records_and_caps_single_attempt_mastery(self, tmp_path):
        service = LearningService(LearningStore(root=tmp_path))
        progress = _progress_with_kp()

        result = service.grade_and_record(
            progress,
            question_id="q1",
            knowledge_point_id="kp1",
            module_id="m1",
            user_answer="photosynthesis",
            expected_answer="photosynthesis",
        )

        assert result is True
        assert progress.quiz_attempts[0].is_correct is True
        assert progress.quiz_attempts[0].error_type is None
        # A single correct attempt is capped at low confidence (0.5), never 1.0.
        assert progress.mastery_levels["kp1"] == 0.5
        assert progress.error_records == []

    def test_correct_answer_graduates_existing_error_record(self, tmp_path):
        service = LearningService(LearningStore(root=tmp_path))
        progress = _progress_with_kp()

        # First a wrong answer opens an error record...
        service.grade_and_record(
            progress,
            question_id="q1",
            knowledge_point_id="kp1",
            module_id="m1",
            user_answer="wrong guess",
            expected_answer="photosynthesis",
        )
        assert progress.error_records[0].status == "active"

        # ...then a correct retry graduates it.
        service.grade_and_record(
            progress,
            question_id="q1",
            knowledge_point_id="kp1",
            module_id="m1",
            user_answer="photosynthesis",
            expected_answer="photosynthesis",
        )

        assert progress.error_records[0].status == "graduated"

    def test_persists_through_store(self, tmp_path):
        store = LearningStore(root=tmp_path)
        service = LearningService(store)
        progress = _progress_with_kp()

        service.grade_and_record(
            progress,
            question_id="q1",
            knowledge_point_id="kp1",
            module_id="m1",
            user_answer="photosynthesis",
            expected_answer="photosynthesis",
        )

        loaded = store.load("book1")
        assert loaded is not None
        assert len(loaded.quiz_attempts) == 1
        assert loaded.mastery_levels["kp1"] == 0.5

    def test_scheduler_advances_repetition_and_builds_queue(self, tmp_path):
        store = LearningStore(root=tmp_path)
        service = LearningService(store)
        scheduler = SpacedRepetitionScheduler()
        progress = _progress_with_kp(KnowledgeType.CONCEPT)

        service.grade_and_record(
            progress,
            question_id="q1",
            knowledge_point_id="kp1",
            module_id="m1",
            user_answer="photosynthesis",
            expected_answer="photosynthesis",
            scheduler=scheduler,
        )

        # A repetition state was created and the review queue rebuilt from it.
        assert "kp1" in progress.repetition_states
        assert len(progress.review_queue) == 1
        assert progress.review_queue[0].knowledge_point_id == "kp1"
