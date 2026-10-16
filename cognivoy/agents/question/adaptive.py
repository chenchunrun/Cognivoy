"""Turn durable quiz evidence into conservative generation guidance."""

from __future__ import annotations

from typing import Any

_DIFFICULTIES = frozenset({"easy", "medium", "hard"})


def resolve_generation_difficulty(
    requested: str | None,
    profile: dict[str, Any] | None,
) -> str:
    """Honor an explicit choice, otherwise use the persisted recommendation.

    An empty return value deliberately keeps the planner in auto mode when no
    evidence exists. This avoids inventing certainty for a new learner.
    """

    explicit = str(requested or "").strip().lower()
    if explicit in _DIFFICULTIES:
        return explicit
    recommendation = str((profile or {}).get("recommended_difficulty") or "").strip().lower()
    if int((profile or {}).get("attempt_count") or 0) <= 0:
        return ""
    return recommendation if recommendation in _DIFFICULTIES else ""


def build_adaptive_generation_context(profile: dict[str, Any] | None) -> str:
    """Build a short, non-sensitive planner hint from aggregate evidence."""

    data = profile or {}
    attempts = int(data.get("attempt_count") or 0)
    if attempts <= 0:
        return ""
    accuracy = int(data.get("recent_accuracy_percent") or 0)
    correct_streak = int(data.get("correct_streak") or 0)
    incorrect_streak = int(data.get("incorrect_streak") or 0)
    weak_points: list[str] = []
    for item in data.get("weak_knowledge_points") or []:
        if not isinstance(item, dict):
            continue
        point = str(item.get("knowledge_point") or "").strip()
        if point:
            weak_points.append(point)
    parts = [
        "[Adaptive quiz evidence]",
        f"Recent accuracy: {accuracy}% across {attempts} attempts.",
        f"Current streaks: {correct_streak} correct, {incorrect_streak} incorrect.",
    ]
    if weak_points:
        parts.append(f"Weak knowledge points: {', '.join(weak_points[:5])}.")
    parts.append(
        "Use this only to choose scaffolding and difficulty. Do not declare mastery from one answer."
    )
    return "\n".join(parts)


__all__ = ["build_adaptive_generation_context", "resolve_generation_difficulty"]
