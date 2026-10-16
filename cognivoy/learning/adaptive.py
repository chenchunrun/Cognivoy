"""Evidence-based teaching profile for learner projects.

The profile is intentionally deterministic: the same saved project evidence
produces the same teaching guidance across WebSocket reconnects and retries.
It never upgrades mastery from a single preference or an unsaved UI choice.
"""

from __future__ import annotations

from typing import Any


def adaptive_teaching_profile(project: Any) -> dict[str, Any]:
    """Return a conservative difficulty and teaching strategy recommendation."""

    mastery = max(0.0, min(1.0, float(getattr(project, "mastery_summary", 0) or 0)))
    baseline = getattr(project, "baseline_assessment", None)
    baseline_score = getattr(baseline, "score", None)
    weak_points = [
        str(item).strip()
        for item in (getattr(project, "weak_points", None) or [])
        if str(item).strip()
    ]
    completed_tasks = sum(
        1
        for task in (getattr(project, "tasks", None) or [])
        if getattr(task, "status", "") == "completed"
    )

    # A new learner starts with foundation scaffolding. We only raise the
    # challenge when persisted evidence supports it; weak points cap the band
    # at guided so the tutor repairs the gap before testing transfer.
    evidence_score = mastery
    if baseline_score is not None:
        evidence_score = max(evidence_score, float(baseline_score))
    configured_difficulty = str(getattr(project, "difficulty_policy", "adaptive") or "adaptive")
    if configured_difficulty in {"foundation", "guided", "challenge"}:
        difficulty = configured_difficulty
    elif evidence_score < 0.35:
        difficulty = "foundation"
    elif evidence_score < 0.72 or weak_points:
        difficulty = "guided"
    else:
        difficulty = "challenge"

    methods = " ".join(
        str(item).strip().lower() for item in (getattr(project, "preferred_methods", None) or [])
    )
    configured_strategy = str(getattr(project, "teaching_strategy", "adaptive") or "adaptive")
    if configured_strategy in {
        "structured",
        "visual_first",
        "socratic",
        "practice_first",
        "example_first",
    }:
        strategy = configured_strategy
    elif any(token in methods for token in ("visual", "diagram", "图", "可视")):
        strategy = "visual_first"
    elif any(token in methods for token in ("socratic", "discussion", "苏格拉底", "讨论")):
        strategy = "socratic"
    elif any(token in methods for token in ("practice", "hands-on", "exercise", "练习", "实操")):
        strategy = "practice_first"
    elif any(token in methods for token in ("example", "worked", "案例", "示例")):
        strategy = "example_first"
    else:
        strategy = "structured"

    reason_codes: list[str] = []
    if baseline_score is not None:
        reason_codes.append("baseline_assessment")
    if completed_tasks:
        reason_codes.append("completed_tasks")
    if weak_points:
        reason_codes.append("weak_points")
    if methods:
        reason_codes.append("learning_preferences")
    if configured_strategy != "adaptive" or configured_difficulty != "adaptive":
        reason_codes.append("learner_override")
    if not reason_codes:
        reason_codes.append("new_learner_default")

    return {
        "difficulty": difficulty,
        "strategy": strategy,
        "mastery": round(mastery, 4),
        "baseline_score": round(float(baseline_score), 4) if baseline_score is not None else None,
        "weak_point_count": len(weak_points),
        "completed_task_count": completed_tasks,
        "reason_codes": reason_codes,
    }


__all__ = ["adaptive_teaching_profile"]
