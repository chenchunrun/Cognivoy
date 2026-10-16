from cognivoy.learning.project_models import LearningEvent, LearningProject, LearningTask
from cognivoy.learning.reconcile import reconcile_course_plan


def test_weekly_cadence_receives_explicit_weekly_load_and_dependencies() -> None:
    baseline = LearningTask(
        id="baseline", project_id="course", objective="Baseline", intent="assessment"
    )
    week_one = LearningTask(
        id="week-1",
        project_id="course",
        objective="Week 1",
        expected_minutes=30,
        due_at=1_800_000_000,
    )
    week_two = LearningTask(
        id="week-2",
        project_id="course",
        objective="Week 2",
        expected_minutes=30,
        due_at=1_800_604_800,
    )
    project = LearningProject(
        id="course",
        owner_id="learner",
        title="Course",
        weekly_minutes=600,
        tasks=[baseline, week_one, week_two],
    )

    changed = reconcile_course_plan(project)

    assert "weekly_load" in changed
    assert week_one.expected_minutes == 480
    assert week_two.expected_minutes == 480
    assert week_one.prerequisites == [baseline.id]
    assert week_two.prerequisites == [week_one.id]


def test_reconcile_removes_only_untouched_empty_duplicate_tasks() -> None:
    curated = LearningTask(
        id="curated", project_id="course", objective="Week 2", resource_refs=["book:chapter"]
    )
    duplicate = LearningTask(
        id="generated", project_id="course", objective="Week 2", expected_minutes=45
    )
    project = LearningProject(
        id="course",
        owner_id="learner",
        title="Course",
        tasks=[curated, duplicate],
        events=[
            LearningEvent(
                id="created",
                project_id="course",
                event_type="task_created",
                title="Week 2",
                task_id=duplicate.id,
            )
        ],
    )

    changed = reconcile_course_plan(project)

    assert "duplicate_tasks" in changed
    assert [task.id for task in project.tasks] == [curated.id]
    assert project.events == []
