from __future__ import annotations

from cognivoy.learning.project_models import LearningProject, LearningTask
from cognivoy.learning.readiness import course_readiness


def test_course_readiness_blocks_an_unsequenced_unassessed_course() -> None:
    project = LearningProject(
        id="course-1",
        owner_id="learner",
        title="Certification course",
        weekly_minutes=600,
        knowledge_base_ids=["official"],
        book_ids=["book"],
        notebook_ids=["notes"],
        partner_id="tutor",
        tasks=[
            LearningTask(
                id="baseline", project_id="course-1", objective="Baseline", intent="assessment"
            ),
            LearningTask(
                id="week-1", project_id="course-1", objective="Week 1", expected_minutes=300
            ),
        ],
    )

    report = course_readiness(
        project,
        question_statistics={"total": 30, "attempted": 0},
        baseline_question_count=30,
    )

    assert report["status"] == "blocked"
    assert {issue["code"] for issue in report["issues"]} >= {
        "baseline_incomplete",
        "deadline_missing",
        "task_dependencies_missing",
        "weekly_load_underallocated",
        "practice_unattempted",
        "task_practice_unlinked",
    }


def test_course_readiness_accepts_a_complete_evidence_loop() -> None:
    baseline = LearningTask(
        id="baseline",
        project_id="course-2",
        objective="Baseline",
        intent="assessment",
        status="completed",
    )
    learning = LearningTask(
        id="week-1",
        project_id="course-2",
        objective="Week 1",
        expected_minutes=480,
        prerequisites=[baseline.id],
        resource_refs=["questions:project:course-2:task:week-1"],
    )
    project = LearningProject(
        id="course-2",
        owner_id="learner",
        title="Certification course",
        weekly_minutes=600,
        deadline=4_102_444_800,
        knowledge_base_ids=["official"],
        book_ids=["book"],
        notebook_ids=["notes"],
        partner_id="tutor",
        tasks=[baseline, learning],
    )
    project.baseline_assessment.status = "completed"

    report = course_readiness(
        project,
        question_statistics={"total": 30, "attempted": 10},
        baseline_question_count=10,
        baseline_attempted_count=10,
    )

    assert report["status"] == "ready"
    assert report["score"] == 100
    assert report["issues"] == []


def test_course_readiness_reports_duplicate_practice() -> None:
    project = LearningProject(
        id="duplicates",
        owner_id="learner",
        title="Course",
        language="zh",
        deadline=4_102_444_800,
        weekly_minutes=60,
        knowledge_base_ids=["kb"],
        book_ids=["book"],
        notebook_ids=["notes"],
        partner_id="tutor",
        tasks=[
            LearningTask(
                id="task",
                project_id="duplicates",
                objective="练习",
                expected_minutes=60,
                resource_refs=["questions:task"],
            )
        ],
    )
    project.baseline_assessment.status = "completed"

    report = course_readiness(
        project,
        question_statistics={"total": 10, "unique_total": 8, "attempted": 2},
    )

    duplicate = next(issue for issue in report["issues"] if issue["code"] == "practice_duplicates")
    assert "2 道重复题" in duplicate["message"]
