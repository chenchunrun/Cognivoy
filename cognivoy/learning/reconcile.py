"""Safe, deterministic repair of internally inconsistent course plans."""

from __future__ import annotations

from statistics import median
import time

from .project_models import LearningProject


def reconcile_course_plan(project: LearningProject) -> list[str]:
    """Align schedule, task load, dependencies, and visible plan in place.

    The function never invents learning content.  It only derives missing
    structure from tasks and learner preferences already saved on the project.
    """

    changed: list[str] = []
    # Earlier course advancement used deterministic ids only.  A curated
    # course whose weeks already existed under different ids could therefore
    # acquire empty duplicate tasks.  Remove only provably disposable copies:
    # an exact-objective duplicate that is untouched, has no evidence, and is
    # shadowed by a task with real resources.  User-created/reviewed tasks are
    # deliberately preserved.
    events_by_task: dict[str, set[str]] = {}
    for event in project.events:
        if event.task_id:
            events_by_task.setdefault(event.task_id, set()).add(event.event_type)
    resource_objectives = {
        task.objective.strip()
        for task in project.tasks
        if task.intent != "assessment" and task.resource_refs
    }
    duplicate_ids = {
        task.id
        for task in project.tasks
        if task.intent != "assessment"
        and task.objective.strip() in resource_objectives
        and not task.resource_refs
        and task.status == "todo"
        and not task.result_refs
        and task.mastery_before is None
        and task.mastery_after is None
        and events_by_task.get(task.id, set()) <= {"task_created"}
    }
    if duplicate_ids:
        project.tasks = [task for task in project.tasks if task.id not in duplicate_ids]
        project.events = [event for event in project.events if event.task_id not in duplicate_ids]
        changed.append("duplicate_tasks")
    assessment_tasks = [task for task in project.tasks if task.intent == "assessment"]
    learning_tasks = sorted(
        (task for task in project.tasks if task.intent != "assessment"),
        key=lambda task: (task.due_at is None, task.due_at or float("inf"), task.created_at),
    )
    previous_id = assessment_tasks[-1].id if assessment_tasks else ""
    due_times = sorted(float(task.due_at) for task in learning_tasks if task.due_at is not None)
    due_gaps = [
        (right - left) / 86400
        for left, right in zip(due_times, due_times[1:], strict=False)
        if right > left
    ]
    # Only infer a per-task weekly budget when the saved plan is actually
    # weekly.  A project may contain several short tasks per week; assigning
    # 80% of the weekly budget to every such task would silently overbook it.
    weekly_cadence = bool(due_gaps and 4 <= median(due_gaps) <= 10)
    weekly_task_minutes = min(480, max(30, round(project.weekly_minutes * 0.8)))
    for task in learning_tasks:
        task_changed = False
        prerequisites = [previous_id] if previous_id else []
        if task.prerequisites != prerequisites:
            task.prerequisites = prerequisites
            changed.append("task_dependencies")
            task_changed = True
        if weekly_cadence and task.expected_minutes != weekly_task_minutes:
            task.expected_minutes = weekly_task_minutes
            changed.append("weekly_load")
            task_changed = True
        if task_changed:
            task.updated_at = time.time()
            task.version += 1
        previous_id = task.id
    dated_due_times = [float(task.due_at) for task in learning_tasks if task.due_at is not None]
    if project.deadline is None and dated_due_times:
        project.deadline = max(dated_due_times)
        changed.append("deadline")
    visible_plan = [task.objective for task in learning_tasks]
    if visible_plan and project.weekly_plan != visible_plan:
        project.weekly_plan = visible_plan
        changed.append("weekly_plan")
    if changed:
        project.plan_version += 1
    return sorted(set(changed))


__all__ = ["reconcile_course_plan"]
