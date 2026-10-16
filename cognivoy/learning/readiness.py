"""Deterministic readiness checks for a complete learning-course loop."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .project_models import LearningProject


def _issue(code: str, severity: str, message: str, action: str) -> dict[str, str]:
    return {"code": code, "severity": severity, "message": message, "action": action}


def course_readiness(
    project: LearningProject,
    *,
    question_statistics: dict[str, Any] | None = None,
    baseline_question_count: int = 0,
    baseline_attempted_count: int = 0,
    book_grounding: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Return a learner-visible, evidence-based course readiness report.

    The report intentionally uses durable project/question evidence only.  It
    never treats the existence of a resource link as proof that learning or an
    exam simulation has been completed.
    """

    zh = project.language == "zh"
    stats = question_statistics or {}
    total_questions = int(stats.get("total") or 0)
    unique_questions = int(stats.get("unique_total") or total_questions)
    attempted = int(stats.get("attempted") or 0)
    if not attempted:
        attempted = int(stats.get("correct") or 0) + int(stats.get("incorrect") or 0)
    issues: list[dict[str, str]] = []
    score = 100

    if baseline_question_count and baseline_attempted_count < baseline_question_count:
        issues.append(
            _issue(
                "baseline_incomplete",
                "blocker",
                (
                    f"客观基线测验已完成 {baseline_attempted_count}/{baseline_question_count} 题。"
                    if zh
                    else f"The objective baseline is {baseline_attempted_count}/{baseline_question_count} complete."
                ),
                (
                    "先作答全部基线题，再开始第一项学习任务。"
                    if zh
                    else "Answer every baseline question before starting the first mastery task."
                ),
            )
        )
        score -= 20
    elif project.baseline_assessment.status != "completed":
        issues.append(
            _issue(
                "baseline_incomplete",
                "blocker",
                ("基线评估尚未完成。" if zh else "The baseline assessment is not completed."),
                (
                    "完成基线评估，让难度和薄弱点建立在真实证据上。"
                    if zh
                    else "Complete the baseline so difficulty and weak points use real evidence."
                ),
            )
        )
        score -= 20

    if project.deadline is None:
        issues.append(
            _issue(
                "deadline_missing",
                "warning",
                (
                    "尚未设置目标日期，无法计算进度风险。"
                    if zh
                    else "No target date is set, so pacing risk cannot be calculated."
                ),
                (
                    "设置考试或完成日期，并重建每周计划。"
                    if zh
                    else "Set an exam or completion date and rebuild the weekly schedule."
                ),
            )
        )
        score -= 10
    elif project.deadline <= datetime.now(UTC).timestamp() and project.status != "completed":
        issues.append(
            _issue(
                "deadline_overdue",
                "blocker",
                (
                    "目标日期已过，但项目仍处于进行中。"
                    if zh
                    else "The target date has passed while the project is still active."
                ),
                (
                    "选择新的目标日期，并调整逾期任务。"
                    if zh
                    else "Choose a new target date and reconcile overdue tasks."
                ),
            )
        )
        score -= 15

    assessment_tasks = [task for task in project.tasks if task.intent == "assessment"]
    learning_tasks = [task for task in project.tasks if task.intent != "assessment"]
    missing_dependencies = [task for task in learning_tasks if not task.prerequisites]
    if assessment_tasks and missing_dependencies:
        issues.append(
            _issue(
                "task_dependencies_missing",
                "blocker",
                (
                    f"有 {len(missing_dependencies)} 个学习任务未设置前置条件。"
                    if zh
                    else f"{len(missing_dependencies)} learning tasks can start without completing their prerequisites."
                ),
                (
                    "校正计划，强制先完成基线并按顺序推进。"
                    if zh
                    else "Reconcile the plan to enforce baseline-first and sequential progression."
                ),
            )
        )
        score -= 15

    dated_tasks = sorted(
        (task for task in learning_tasks if task.due_at is not None),
        key=lambda task: float(task.due_at or 0),
    )
    if len(dated_tasks) >= 2:
        span_days = max(1.0, ((dated_tasks[-1].due_at or 0) - (dated_tasks[0].due_at or 0)) / 86400)
        planned_weeks = max(1, round(span_days / 7) + 1)
    else:
        planned_weeks = max(1, len(learning_tasks))
    allocated_minutes = sum(task.expected_minutes for task in learning_tasks)
    expected_minutes = project.weekly_minutes * planned_weeks
    allocation_ratio = allocated_minutes / expected_minutes if expected_minutes else 1.0
    if learning_tasks and allocation_ratio < 0.75:
        issues.append(
            _issue(
                "weekly_load_underallocated",
                "warning",
                (
                    f"任务仅分配了计划中 {expected_minutes} 分钟的 {allocated_minutes} 分钟（{allocation_ratio:.0%}）。"
                    if zh
                    else f"Tasks allocate {allocated_minutes} of {expected_minutes} planned minutes ({allocation_ratio:.0%})."
                ),
                (
                    "至少将每周时间的 75% 分配到明确任务，其余用于复习。"
                    if zh
                    else "Allocate at least 75% of weekly time to explicit tasks and reserve the rest for review."
                ),
            )
        )
        score -= 10

    resource_counts = {
        "knowledge_bases": len(project.knowledge_base_ids),
        "books": len(project.book_ids),
        "notebooks": len(project.notebook_ids),
        "tutors": 1 if project.partner_id else 0,
    }
    missing_resources = [name for name, count in resource_counts.items() if count == 0]
    if missing_resources:
        issues.append(
            _issue(
                "resources_incomplete",
                "warning",
                (
                    ("缺少已关联的课程资源：" + "、".join(missing_resources) + "。")
                    if zh
                    else "Missing linked course resources: " + ", ".join(missing_resources) + "."
                ),
                (
                    "为项目关联稳定的学习资料、参考资料、笔记和导师。"
                    if zh
                    else "Bind stable learning, reference, note, and tutor resources to the project."
                ),
            )
        )
        score -= min(15, 5 * len(missing_resources))

    grounding = book_grounding or {}
    book_pages = int(grounding.get("pages") or 0)
    grounded_pages = int(grounding.get("grounded_pages") or 0)
    if project.book_ids and book_pages and grounded_pages < book_pages:
        issues.append(
            _issue(
                "book_sources_unverified",
                "warning",
                (
                    f"教材 {book_pages} 页中仅有 {grounded_pages} 页包含可追溯来源证据。"
                    if zh
                    else f"Only {grounded_pages} of {book_pages} book pages contain retrievable source evidence."
                ),
                (
                    "使用已关联知识库复核或重新生成无来源页面，并保留来源锚点。"
                    if zh
                    else "Review or regenerate ungrounded pages with the linked knowledge base and preserve source anchors."
                ),
            )
        )
        score -= 10

    if total_questions == 0:
        issues.append(
            _issue(
                "practice_missing",
                "blocker",
                (
                    "项目尚未关联练习题。"
                    if zh
                    else "No practice questions are linked to this project."
                ),
                (
                    "创建项目范围的基线、每周练习和期末测验题集。"
                    if zh
                    else "Create project-scoped baseline, weekly practice, and final assessment sets."
                ),
            )
        )
        score -= 20
    elif attempted == 0:
        issues.append(
            _issue(
                "practice_unattempted",
                "warning",
                (
                    f"已有 {total_questions} 道题，但尚未记录任何作答。"
                    if zh
                    else f"{total_questions} questions exist, but no learner attempt has been recorded."
                ),
                (
                    "完成基线和一组每周练习以启用自适应复习。"
                    if zh
                    else "Complete the baseline and one weekly set to activate adaptive review."
                ),
            )
        )
        score -= 10

    duplicate_questions = max(0, total_questions - unique_questions)
    if duplicate_questions:
        issues.append(
            _issue(
                "practice_duplicates",
                "warning",
                (
                    f"题库中有 {duplicate_questions} 道重复题，可能导致覆盖率和正确率被高估。"
                    if zh
                    else f"The question bank contains {duplicate_questions} duplicate questions, which can overstate coverage and accuracy."
                ),
                (
                    "保留需要重复抽测的题，但为等价副本添加变式或从覆盖统计中排除。"
                    if zh
                    else "Keep intentional retests, but vary equivalent copies or exclude them from coverage metrics."
                ),
            )
        )
        score -= min(10, max(2, round(duplicate_questions / max(1, total_questions) * 100)))

    task_question_refs = {
        task.id
        for task in project.tasks
        if any(ref.startswith("questions:") for ref in task.resource_refs)
    }
    tasks_without_practice = [task for task in learning_tasks if task.id not in task_question_refs]
    if tasks_without_practice:
        issues.append(
            _issue(
                "task_practice_unlinked",
                "warning",
                (
                    f"有 {len(tasks_without_practice)} 个学习任务未关联练习题集。"
                    if zh
                    else f"{len(tasks_without_practice)} learning tasks have no linked practice set."
                ),
                (
                    "关联任务范围的题集，让学习与练习保持在同一闭环。"
                    if zh
                    else "Attach a task-scoped question set so learning and practice stay in one loop."
                ),
            )
        )
        score -= 10

    blocker_count = sum(issue["severity"] == "blocker" for issue in issues)
    status = "blocked" if blocker_count else "ready" if not issues else "needs_attention"
    return {
        "status": status,
        "score": max(0, score),
        "issues": issues,
        "metrics": {
            "planned_weeks": planned_weeks,
            "weekly_minutes": project.weekly_minutes,
            "allocated_minutes": allocated_minutes,
            "allocation_ratio": round(allocation_ratio, 4),
            "total_questions": total_questions,
            "unique_questions": unique_questions,
            "duplicate_questions": duplicate_questions,
            "attempted_questions": attempted,
            "baseline_questions": baseline_question_count,
            "baseline_attempted_questions": baseline_attempted_count,
            "book_pages": book_pages,
            "grounded_book_pages": grounded_pages,
            "resource_counts": resource_counts,
        },
    }


__all__ = ["course_readiness"]
