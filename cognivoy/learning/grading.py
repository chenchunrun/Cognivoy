"""Deterministic answer grading + coarse error classification for Mastery Path."""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from cognivoy.learning.models import ErrorType


def grade_answer(user_answer: str, expected_answer: str, question_type: str = "short") -> bool:
    """Grade user answer against expected answer.

    Args:
        user_answer: The user's submitted answer.
        expected_answer: The stored expected answer.
        question_type: One of "choice", "short", "open".

    Returns:
        True if the answer matches the reference. Free-text paraphrases need
        semantic review; this deterministic fallback must not award mastery
        from edit distance or keyword presence. Only surrounding whitespace
        is ignored for free text: case, signs, units and negation can change
        the meaning of an answer.
    """
    user = user_answer.strip()
    expected = expected_answer.strip()

    if not expected:
        return False

    if question_type == "choice":
        user_norm = user.lower().replace(" ", "")
        expected_norm = expected.lower().replace(" ", "")
        return user_norm == expected_norm

    if question_type in {"short", "open"}:
        return user == expected

    return False


def classify_error(user_answer: str) -> ErrorType:
    """Coarse error classification for a wrong answer.

    A blank answer signals the student did not know (metacognitive); anything
    else is treated as a wrong application. The richer four-type taxonomy is
    assigned later by the LLM in the error-diagnosis stage.
    """
    from cognivoy.learning.models import ErrorType

    return ErrorType.METACOGNITIVE if not user_answer.strip() else ErrorType.APPLICATION_ERROR


__all__ = ["grade_answer", "classify_error"]
