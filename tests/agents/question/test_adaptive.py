from cognivoy.agents.question.adaptive import (
    build_adaptive_generation_context,
    resolve_generation_difficulty,
)


def test_explicit_difficulty_overrides_adaptive_profile() -> None:
    profile = {
        "attempt_count": 3,
        "recommended_difficulty": "easy",
        "recent_accuracy_percent": 20,
        "weak_knowledge_points": [{"knowledge_point": "fractions"}],
    }

    assert resolve_generation_difficulty("hard", profile) == "hard"


def test_auto_difficulty_uses_persisted_learning_evidence() -> None:
    profile = {
        "attempt_count": 3,
        "recommended_difficulty": "easy",
        "recent_accuracy_percent": 33,
        "correct_streak": 0,
        "incorrect_streak": 2,
        "weak_knowledge_points": [
            {
                "knowledge_point": "fractions",
                "incorrect_attempts": 2,
                "total_attempts": 2,
            }
        ],
    }

    assert resolve_generation_difficulty("", profile) == "easy"
    context = build_adaptive_generation_context(profile)
    assert "33%" in context
    assert "fractions" in context
    assert "Do not declare mastery" in context


def test_empty_profile_keeps_planner_in_auto_mode() -> None:
    assert resolve_generation_difficulty("", {}) == ""
    assert build_adaptive_generation_context({}) == ""
