from __future__ import annotations

from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from cognivoy.api.errors import install_error_handlers
from cognivoy.api.routers import learning_projects
from cognivoy.learning import project_storage
from cognivoy.learning.models import (
    KnowledgePoint,
    KnowledgeType,
    LearningModule,
    LearningProgress,
    RepetitionState,
    ReviewTask,
)
from cognivoy.learning.project_models import ProjectReviewItem
from cognivoy.learning.project_storage import LearningProjectStore


def test_project_sources_propagate_to_linked_books_and_mark_pages_stale() -> None:
    book = SimpleNamespace(
        id="book-1",
        knowledge_bases=["book-only"],
        stale_page_ids=[],
        updated_at=0.0,
    )
    pages = [SimpleNamespace(id="page-1"), SimpleNamespace(id="page-2")]

    class FakeBookStorage:
        saved = None
        log = None

        def load_book(self, book_id):
            return book if book_id == "book-1" else None

        def list_pages(self, book_id):
            return pages

        def save_book(self, value):
            self.saved = value

        def append_log(self, book_id, message, *, op):
            self.log = (book_id, message, op)

    storage = FakeBookStorage()
    project = SimpleNamespace(
        book_ids=["book-1"],
        knowledge_base_ids=["official-cisa", "book-only"],
    )

    learning_projects._sync_project_book_sources(project, storage=storage)

    assert book.knowledge_bases == ["book-only", "official-cisa"]
    assert book.stale_page_ids == ["page-1", "page-2"]
    assert storage.saved is book
    assert storage.log[2] == "project_sources"


@pytest.fixture()
def client(tmp_path, monkeypatch: pytest.MonkeyPatch):
    store = LearningProjectStore(tmp_path / "projects")
    monkeypatch.setattr(learning_projects, "_store", lambda: store)
    monkeypatch.setattr(
        learning_projects,
        "_experiment_preferences_path",
        lambda: tmp_path / "learning_experiments.json",
    )
    monkeypatch.setattr(
        learning_projects,
        "get_current_user",
        lambda: SimpleNamespace(id="learner-1"),
    )
    app = FastAPI()
    install_error_handlers(app)
    app.include_router(learning_projects.router, prefix="/api/v1/learning")
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


def _create(client: TestClient, key: str = "create-linear-algebra") -> dict:
    response = client.post(
        "/api/v1/learning/projects",
        headers={"Idempotency-Key": key},
        json={
            "title": "Linear algebra",
            "motivation": "Prepare for machine learning",
            "current_level": "beginner",
            "target_level": "practical",
            "weekly_minutes": 240,
            "preferred_methods": ["visual", "practice"],
        },
    )
    assert response.status_code == 201
    return response.json()


def test_empty_dashboard_has_one_create_plan_action(client: TestClient) -> None:
    dashboard = client.get("/api/v1/learning/dashboard")

    assert dashboard.status_code == 200
    assert dashboard.json()["active_projects"] == 0
    assert dashboard.json()["primary_project"] is None
    assert dashboard.json()["next_action"]["kind"] == "create_plan"


def test_project_status_prioritizes_due_review_over_resumable_work() -> None:
    project = learning_projects.LearningProject(
        id="priority-project",
        owner_id="learner-1",
        title="Priority project",
        baseline_assessment=learning_projects.BaselineAssessment(status="completed"),
        tasks=[
            learning_projects.LearningTask(
                id="continue-task",
                project_id="priority-project",
                objective="Continue this lesson",
                status="in_progress",
            )
        ],
        review_items=[
            ProjectReviewItem(
                id="due-review",
                title="Recall vectors",
                source_ref="question:q1",
                due_at=0,
                status="due",
            )
        ],
        due_review_count=1,
    )

    status = learning_projects._project_status_snapshot(project)

    assert status["next_action"]["kind"] == "review"
    assert status["progress"] == {
        "completed_tasks": 0,
        "total_tasks": 1,
        "completion_rate": 0.0,
    }


def test_project_onboarding_generates_plan_and_first_resumable_task(client: TestClient) -> None:
    project = _create(client)

    assert project["owner_id"] == "learner-1"
    assert len(project["weekly_plan"]) == 4
    assert project["tasks"][0]["status"] == "todo"
    assert project["tasks"][0]["intent"] == "assessment"
    assert project["tasks"][0]["expected_minutes"] >= 10
    assert len(project["knowledge_map"]) == 4
    assert project["knowledge_map"][0]["status"] == "ready"
    assert project["knowledge_map"][1]["status"] == "locked"
    assert project["baseline_assessment"]["status"] == "pending"
    assert project["learning_status"]["schema_version"] == 1
    assert project["learning_status"]["progress"] == {
        "completed_tasks": 0,
        "total_tasks": 1,
        "completion_rate": 0.0,
    }
    assert project["learning_status"]["next_action"]["kind"] == "baseline"
    assert project["analytics"]["task_completion_rate"] == 0.0
    assert project["review_preferences"] == {
        "intensity": "balanced",
        "reminder_time": "19:00",
        "daily_question_limit": 10,
        "reminder_weekdays": [0, 1, 2, 3, 4, 5, 6],
        "reminders_paused_until": None,
    }
    assert "creation_key" not in project["tasks"][0]
    assert [event["event_type"] for event in project["events"]] == [
        "project_created",
        "task_created",
    ]

    dashboard = client.get("/api/v1/learning/dashboard")
    assert dashboard.status_code == 200
    assert dashboard.json()["active_projects"] == 1
    assert dashboard.json()["next_action"]["kind"] == "baseline"
    assert dashboard.json()["next_action"]["task"]["id"] == project["tasks"][0]["id"]
    assert dashboard.json()["primary_project"]["id"] == project["id"]
    assert (
        dashboard.json()["primary_project"]["learning_status"]["progress"]["completion_rate"] == 0.0
    )
    assert "next_action" not in dashboard.json()["primary_project"]["learning_status"]
    assert set(dashboard.json()["primary_project"]["analytics"]) == {"quiz_attempts"}
    assert "events" not in dashboard.json()["primary_project"]
    assert "knowledge_map" not in dashboard.json()["primary_project"]
    assert "baseline_assessment" not in dashboard.json()["primary_project"]
    assert dashboard.json()["recent_projects"] == []
    assert len(dashboard.content) < 5_000
    assert dashboard.json()["continue_task"]["id"] == project["tasks"][0]["id"]
    assert dashboard.json()["due_reviews"] == 0
    assert dashboard.json()["weak_points"] == []
    assert dashboard.json()["mentor_suggestion"]["kind"] == "continue"
    suggestion = dashboard.json()["mentor_suggestion"]
    assert suggestion["project_id"] == project["id"]
    assert len(suggestion["id"]) == 32
    assert dashboard.headers["cache-control"] == "private, max-age=0, must-revalidate"
    etag = dashboard.headers["etag"]
    cached_dashboard = client.get(
        "/api/v1/learning/dashboard",
        headers={"If-None-Match": etag},
    )
    assert cached_dashboard.status_code == 304
    assert cached_dashboard.headers["etag"] == etag

    shown = client.post(
        f"/api/v1/learning/dashboard/suggestions/{suggestion['id']}/events",
        json={"project_id": project["id"], "kind": "continue", "action": "shown"},
    )
    repeated = client.post(
        f"/api/v1/learning/dashboard/suggestions/{suggestion['id']}/events",
        json={"project_id": project["id"], "kind": "continue", "action": "shown"},
    )
    adopted = client.post(
        f"/api/v1/learning/dashboard/suggestions/{suggestion['id']}/events",
        json={"project_id": project["id"], "kind": "continue", "action": "adopted"},
    )
    assert shown.status_code == 200 and shown.json()["recorded"] is True
    assert repeated.status_code == 200 and repeated.json()["recorded"] is False
    assert adopted.status_code == 200 and adopted.json()["recorded"] is True
    timeline = client.get(f"/api/v1/learning/projects/{project['id']}/timeline").json()["items"]
    suggestion_events = [item for item in timeline if item["event_type"] == "mentor_suggestion"]
    assert len(suggestion_events) == 2


def test_portfolio_metrics_are_local_aggregates_and_experiments_require_consent(
    client: TestClient,
) -> None:
    project = _create(client, "metrics-consent")
    responses = {item["id"]: 2 for item in project["knowledge_map"]}
    assessment = client.post(
        f"/api/v1/learning/projects/{project['id']}/assessment",
        json={"expected_project_version": project["version"], "responses": responses},
    )
    assert assessment.status_code == 200

    metrics = client.get("/api/v1/learning/metrics")
    assert metrics.status_code == 200
    payload = metrics.json()
    assert payload["project_count"] == 1
    assert payload["first_learning_completed"] == 1
    assert payload["completed_tasks"] == 1
    assert payload["privacy"] == {
        "source": "local_learning_evidence",
        "message_content_used": False,
        "external_transfer": False,
    }

    initial = client.get("/api/v1/learning/experiments/consent")
    assert initial.status_code == 200
    assert initial.json()["consent"] is False
    assert initial.json()["external_sharing"] is False

    enabled = client.put(
        "/api/v1/learning/experiments/consent",
        json={"consent": True, "notice_version": 1},
    )
    assert enabled.status_code == 200
    assert enabled.json()["consent"] is True
    assert client.get("/api/v1/learning/experiments/consent").json()["consent"] is True

    disabled = client.put(
        "/api/v1/learning/experiments/consent",
        json={"consent": False, "notice_version": 1},
    )
    assert disabled.status_code == 200
    assert disabled.json()["consent"] is False


def test_project_partner_assignment_can_be_updated_and_cleared(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    reconciled: list[tuple[str | None, str | None]] = []
    monkeypatch.setattr(
        learning_projects,
        "_reconcile_outreach",
        lambda project, previous_partner_id=None: reconciled.append(
            (project.partner_id, previous_partner_id)
        ),
    )
    project = _create(client, "partner-assignment")

    assigned = client.patch(
        f"/api/v1/learning/projects/{project['id']}",
        json={"expected_version": project["version"], "partner_id": "tutor-1"},
    )
    assert assigned.status_code == 200
    assert assigned.json()["partner_id"] == "tutor-1"

    cleared = client.patch(
        f"/api/v1/learning/projects/{project['id']}",
        json={"expected_version": assigned.json()["version"], "partner_id": None},
    )
    assert cleared.status_code == 200
    assert cleared.json()["partner_id"] is None
    assert reconciled == [
        (None, None),
        ("tutor-1", None),
        (None, "tutor-1"),
    ]


def test_baseline_assessment_calibrates_map_and_unlocks_next_task(client: TestClient) -> None:
    project = _create(client, "baseline-project")
    assessment = client.get(f"/api/v1/learning/projects/{project['id']}/assessment")

    assert assessment.status_code == 200
    questions = assessment.json()["questions"]
    assert len(questions) == 4
    assert all(len(question["choices"]) == 4 for question in questions)

    incomplete = client.post(
        f"/api/v1/learning/projects/{project['id']}/assessment",
        json={
            "expected_project_version": project["version"],
            "responses": {questions[0]["id"]: 1},
        },
    )
    assert incomplete.status_code == 422

    submitted = client.post(
        f"/api/v1/learning/projects/{project['id']}/assessment",
        json={
            "expected_project_version": project["version"],
            "responses": {
                questions[0]["id"]: 3,
                questions[1]["id"]: 2,
                questions[2]["id"]: 1,
                questions[3]["id"]: 0,
            },
        },
    )
    assert submitted.status_code == 200
    calibrated = submitted.json()
    assert calibrated["baseline_assessment"]["status"] == "completed"
    assert calibrated["baseline_assessment"]["inferred_level"] == "intermediate"
    assert calibrated["tasks"][0]["status"] == "completed"
    assert calibrated["tasks"][1]["intent"] == "mastery_path"
    assert [node["status"] for node in calibrated["knowledge_map"]] == [
        "mastered",
        "in_progress",
        "ready",
        "locked",
    ]
    assert {event["event_type"] for event in calibrated["events"]} >= {
        "assessment_completed",
        "knowledge_map_updated",
        "task_completed",
        "task_created",
    }

    stale = client.post(
        f"/api/v1/learning/projects/{project['id']}/assessment",
        json={
            "expected_project_version": project["version"],
            "responses": {question["id"]: 2 for question in questions},
        },
    )
    assert stale.status_code == 409


def test_chinese_onboarding_generates_chinese_plan_and_task(client: TestClient) -> None:
    response = client.post(
        "/api/v1/learning/projects",
        headers={"Idempotency-Key": "create-chinese-project"},
        json={
            "title": "学习线性代数",
            "motivation": "准备机器学习课程",
            "language": "zh",
            "current_level": "beginner",
            "target_level": "practical",
            "weekly_minutes": 180,
            "preferred_methods": ["visual", "practice"],
        },
    )

    assert response.status_code == 201
    project = response.json()
    assert project["language"] == "zh"
    assert project["weekly_plan"][0].startswith("诊断")
    assert project["tasks"][0]["objective"] == project["weekly_plan"][0]


def test_project_create_and_task_create_are_idempotent(client: TestClient) -> None:
    first = _create(client, "same-project")
    second = _create(client, "same-project")
    assert second["id"] == first["id"]
    assert len(client.get("/api/v1/learning/projects").json()["items"]) == 1

    payload = {
        "expected_project_version": first["version"],
        "objective": "Practice matrix multiplication",
        "expected_minutes": 20,
    }
    one = client.post(
        f"/api/v1/learning/projects/{first['id']}/tasks",
        headers={"Idempotency-Key": "matrix-task"},
        json=payload,
    )
    assert one.status_code == 201
    two = client.post(
        f"/api/v1/learning/projects/{first['id']}/tasks",
        headers={"Idempotency-Key": "matrix-task"},
        json=payload,
    )
    assert two.status_code == 201
    assert two.json()["task"]["id"] == one.json()["task"]["id"]


def test_task_prerequisites_are_enforced_and_reconcile_repairs_plan(client: TestClient) -> None:
    project = _create(client, "reconcile-project")
    baseline = project["tasks"][0]
    created = client.post(
        f"/api/v1/learning/projects/{project['id']}/tasks",
        json={
            "expected_project_version": project["version"],
            "objective": "Week 1",
            "expected_minutes": 30,
            "prerequisite_ids": [baseline["id"]],
            "resource_refs": [f"questions:project:{project['id']}:task:week-1"],
        },
    )
    assert created.status_code == 201
    task = created.json()["task"]
    blocked = client.patch(
        f"/api/v1/learning/projects/{project['id']}/tasks/{task['id']}",
        json={
            "expected_project_version": created.json()["project_version"],
            "expected_task_version": task["version"],
            "status": "in_progress",
        },
    )
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "prerequisites_incomplete"

    reconciled = client.post(
        f"/api/v1/learning/projects/{project['id']}/reconcile",
        json={"expected_project_version": created.json()["project_version"]},
    )
    assert reconciled.status_code == 200
    payload = reconciled.json()
    repaired = next(item for item in payload["tasks"] if item["id"] == task["id"])
    assert repaired["prerequisites"] == [baseline["id"]]
    # An undated one-off task is not assumed to consume an entire weekly
    # budget.  Reconciliation must not overbook non-weekly projects.
    assert repaired["expected_minutes"] == 30
    assert payload["weekly_plan"] == ["Week 1"]


def test_revision_conflicts_are_explicit_and_completion_is_persisted(client: TestClient) -> None:
    project = _create(client)
    task = project["tasks"][0]

    completed = client.patch(
        f"/api/v1/learning/projects/{project['id']}/tasks/{task['id']}",
        json={
            "expected_project_version": project["version"],
            "expected_task_version": task["version"],
            "status": "completed",
            "mastery_after": 0.7,
            "result_refs": ["session:abc"],
        },
    )
    assert completed.status_code == 200
    assert completed.json()["task"]["completed_at"] is not None
    assert completed.json()["task"]["mastery_after"] == 0.7

    refreshed = client.get(f"/api/v1/learning/projects/{project['id']}").json()
    assert refreshed["mastery_summary"] == 0.7
    assert refreshed["weak_points"] == []
    assert refreshed["analytics"]["period_days"] == 7
    assert refreshed["analytics"]["completed_tasks"] == 1
    assert refreshed["analytics"]["study_minutes"] == task["expected_minutes"]
    assert refreshed["analytics"]["active_days"] == 1
    assert refreshed["analytics"]["mastery_delta"] == 0.7
    # A raw task update cannot make an unfinished baseline look complete on
    # one surface while the project detail still asks the learner to answer it.
    assert refreshed["analytics"]["task_completion_rate"] == 0.0
    assert refreshed["learning_status"]["progress"]["completion_rate"] == 0.0
    assert refreshed["learning_status"]["next_action"]["kind"] == "baseline"
    assert refreshed["analytics"]["comparison"]["previous_period_days"] == 7
    assert refreshed["analytics"]["comparison"]["completed_tasks_delta"] == 1
    assert refreshed["teaching_profile"]["difficulty"] == "guided"
    assert sum(day["completed_tasks"] for day in refreshed["analytics"]["daily"]) == 1
    timeline = client.get(f"/api/v1/learning/projects/{project['id']}/timeline")
    assert timeline.status_code == 200
    assert timeline.json()["items"][0]["event_type"] == "mastery_updated"
    assert {item["event_type"] for item in timeline.json()["items"]} >= {
        "project_created",
        "task_completed",
        "mastery_updated",
    }

    stale = client.patch(
        f"/api/v1/learning/projects/{project['id']}",
        json={"expected_version": project["version"], "title": "Stale title"},
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "revision_conflict"
    assert stale.json()["details"]["current_version"] == completed.json()["project_version"]


def test_projects_are_owner_filtered(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    project = _create(client)
    monkeypatch.setattr(
        learning_projects,
        "get_current_user",
        lambda: SimpleNamespace(id="learner-2"),
    )

    assert client.get("/api/v1/learning/projects").json()["items"] == []
    missing = client.get(f"/api/v1/learning/projects/{project['id']}")
    assert missing.status_code == 404
    timeline = client.get(f"/api/v1/learning/projects/{project['id']}/timeline")
    assert timeline.status_code == 404


def test_completed_turn_advances_the_plan_exactly_once(tmp_path) -> None:
    store = LearningProjectStore(tmp_path / "projects")
    project = learning_projects.LearningProject(
        id="project-1",
        owner_id="learner-1",
        title="Linear algebra",
        weekly_plan=["Diagnose", "Study vectors", "Practice"],
        tasks=[
            learning_projects.LearningTask(
                id="task-1",
                project_id="project-1",
                objective="Diagnose",
                status="in_progress",
            )
        ],
    )
    store.create(project)

    first = store.complete_task_from_turn("project-1", "task-1", session_id="session-1")
    version_after_first = store.load("project-1").version  # type: ignore[union-attr]
    second = store.complete_task_from_turn("project-1", "task-1", session_id="session-1")

    assert first is not None and second is not None
    saved = store.load("project-1")
    assert saved is not None
    assert saved.tasks[0].status == "completed"
    assert saved.tasks[0].result_refs == ["session:session-1"]
    assert len(saved.tasks) == 2
    assert saved.tasks[1].objective == "Study vectors"
    assert saved.version == version_after_first
    assert [event.event_type for event in saved.events] == [
        "task_completed",
        "task_created",
    ]


def test_completed_turn_reuses_a_precreated_week_instead_of_duplicating_it(tmp_path) -> None:
    store = LearningProjectStore(tmp_path / "projects")
    project = learning_projects.LearningProject(
        id="project-curated",
        owner_id="learner-1",
        title="Curated course",
        weekly_plan=["Week 1", "Week 2"],
        tasks=[
            learning_projects.LearningTask(
                id="week-1",
                project_id="project-curated",
                objective="Week 1",
                status="in_progress",
            ),
            learning_projects.LearningTask(
                id="curated-week-2",
                project_id="project-curated",
                objective="Week 2",
                resource_refs=["book:chapter-2"],
            ),
        ],
    )
    store.create(project)

    result = store.complete_task_from_turn("project-curated", "week-1", session_id="session-1")

    assert result is not None
    saved = store.load("project-curated")
    assert saved is not None
    assert [task.id for task in saved.tasks] == ["week-1", "curated-week-2"]
    assert [event.event_type for event in saved.events] == ["task_completed"]


def test_low_mastery_is_reflected_in_project_weak_points(client: TestClient) -> None:
    project = _create(client, "weak-project")
    task = project["tasks"][0]

    response = client.patch(
        f"/api/v1/learning/projects/{project['id']}/tasks/{task['id']}",
        json={
            "expected_project_version": project["version"],
            "expected_task_version": task["version"],
            "status": "completed",
            "mastery_after": 0.45,
        },
    )

    assert response.status_code == 200
    refreshed = client.get(f"/api/v1/learning/projects/{project['id']}").json()
    assert refreshed["mastery_summary"] == 0.45
    assert refreshed["weak_points"] == [task["objective"]]
    dashboard = client.get("/api/v1/learning/dashboard").json()
    assert dashboard["weak_points"] == [task["objective"]]
    assert dashboard["weak_project"]["project_id"] == project["id"]
    assert dashboard["mentor_suggestion"]["kind"] == "strengthen"


def test_completed_turn_merges_mastery_weakness_and_review_evidence(
    tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    store = LearningProjectStore(tmp_path / "projects")
    project = learning_projects.LearningProject(
        id="project-mastery",
        owner_id="learner-1",
        title="Vectors",
        weekly_plan=["Diagnose vectors"],
        tasks=[
            learning_projects.LearningTask(
                id="task-mastery",
                project_id="project-mastery",
                objective="Diagnose vectors",
                status="in_progress",
            )
        ],
    )
    store.create(project)
    now = 1_800_000_000.0
    repetition = RepetitionState(next_review_at=now - 10)
    progress = LearningProgress(
        book_id="session-mastery",
        modules=[
            LearningModule(
                id="module-1",
                name="Vector foundations",
                order=1,
                knowledge_points=[
                    KnowledgePoint(
                        id="kp-1",
                        name="Vector addition",
                        type=KnowledgeType.PROCEDURE,
                        module_id="module-1",
                    )
                ],
            )
        ],
        mastery_levels={"kp-1": 0.4},
        review_queue=[
            ReviewTask(
                id="review-kp-1",
                knowledge_point_id="kp-1",
                knowledge_type=KnowledgeType.PROCEDURE,
                due_at=now - 10,
                priority=1,
                state=repetition,
            )
        ],
    )
    monkeypatch.setattr(project_storage, "_load_mastery_progress", lambda _session: progress)
    monkeypatch.setattr(project_storage.time, "time", lambda: now)

    result = store.complete_task_from_turn(
        "project-mastery",
        "task-mastery",
        session_id="session-mastery",
    )

    assert result is not None
    saved = store.load("project-mastery")
    assert saved is not None
    assert saved.mastery_summary == 0.4
    assert saved.weak_points == ["Vector addition"]
    assert saved.due_review_count == 1
    assert saved.next_review_at == now - 10
    assert {event.event_type for event in saved.events} >= {
        "task_completed",
        "mastery_updated",
        "review_scheduled",
    }


def test_quiz_mistakes_create_an_idempotent_project_review_queue(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    reconciled: list[tuple[str, int]] = []
    monkeypatch.setattr(
        project_storage,
        "reconcile_project_partner_outreach",
        lambda item: reconciled.append((item.id, item.due_review_count)) or [],
    )
    project = _create(client, "quiz-project")
    store = learning_projects._store()
    answers = [
        {
            "question_id": "q1",
            "question": "What is a vector space?",
            "knowledge_points": ["Vector spaces"],
            "is_correct": False,
        },
        {
            "question_id": "q2",
            "question": "Add two vectors",
            "knowledge_points": ["Vector addition"],
            "is_correct": True,
        },
    ]

    first = store.record_quiz_attempt(
        project["id"],
        project["tasks"][0]["id"],
        session_id="session-quiz",
        turn_id="turn-quiz",
        submission_id="attempt-1",
        answers=answers,
    )
    second = store.record_quiz_attempt(
        project["id"],
        project["tasks"][0]["id"],
        session_id="session-quiz",
        turn_id="turn-quiz",
        submission_id="attempt-1",
        answers=answers,
    )

    assert first is not None and second is not None
    assert second.version == first.version
    assert second.mastery_summary == 0.5
    assert second.due_review_count == 1
    assert second.weak_points == [project["tasks"][0]["objective"], "Vector spaces"]
    assert len(second.review_items) == 2
    assert {item.status for item in second.review_items} == {"due", "scheduled"}
    mistaken = next(item for item in second.review_items if item.status == "due")
    assert mistaken.mistake_category == "expression"
    assert "No complete answer" in mistaken.diagnostic_reason
    assert {event.event_type for event in second.events} >= {
        "quiz_completed",
        "mistake_recorded",
        "review_scheduled",
    }
    assert reconciled == [(project["id"], 1)]

    dashboard = client.get("/api/v1/learning/dashboard").json()
    assert dashboard["due_reviews"] == 1
    assert dashboard["review_project"]["project_id"] == project["id"]


def test_due_review_completion_is_versioned_and_idempotent(client: TestClient) -> None:
    project = _create(client, "review-project")
    store = learning_projects._store()
    recorded = store.record_quiz_attempt(
        project["id"],
        project["tasks"][0]["id"],
        session_id="session-review",
        turn_id="turn-review",
        submission_id="quiz-1",
        answers=[
            {
                "question_id": "q1",
                "question": "Explain eigenvectors",
                "knowledge_points": ["Eigenvectors"],
                "is_correct": False,
            }
        ],
    )
    assert recorded is not None
    review_id = recorded.review_items[0].id

    due = client.get(f"/api/v1/learning/projects/{project['id']}/reviews?due_only=true")
    assert due.status_code == 200
    assert [item["id"] for item in due.json()["items"]] == [review_id]

    payload = {
        "expected_project_version": recorded.version,
        "is_correct": True,
        "attempt_id": "review-attempt-1",
    }
    completed = client.post(
        f"/api/v1/learning/projects/{project['id']}/reviews/{review_id}/complete",
        json=payload,
    )
    assert completed.status_code == 200
    assert completed.json()["review"]["status"] == "scheduled"
    assert completed.json()["due_review_count"] == 0

    retry = client.post(
        f"/api/v1/learning/projects/{project['id']}/reviews/{review_id}/complete",
        json=payload,
    )
    assert retry.status_code == 200
    assert retry.json()["project_version"] == completed.json()["project_version"]

    stale = client.post(
        f"/api/v1/learning/projects/{project['id']}/reviews/{review_id}/complete",
        json={**payload, "attempt_id": "review-attempt-2"},
    )
    assert stale.status_code == 409


def test_review_preferences_drive_interval_and_preserve_diagnosis(client: TestClient) -> None:
    project = _create(client, "review-preferences")
    configured = client.patch(
        f"/api/v1/learning/projects/{project['id']}",
        json={
            "expected_version": project["version"],
            "review_preferences": {
                "intensity": "light",
                "reminder_time": "08:30",
                "daily_question_limit": 4,
            },
            "knowledge_base_ids": ["rag-notes"],
            "book_ids": ["book-linear-algebra"],
            "notebook_ids": ["notebook-practice"],
        },
    )
    assert configured.status_code == 200
    assert configured.json()["review_preferences"]["daily_question_limit"] == 4
    assert configured.json()["knowledge_base_ids"] == ["rag-notes"]
    assert configured.json()["book_ids"] == ["book-linear-algebra"]
    assert configured.json()["notebook_ids"] == ["notebook-practice"]

    store = learning_projects._store()
    recorded = store.record_quiz_attempt(
        project["id"],
        project["tasks"][0]["id"],
        session_id="session-policy",
        turn_id="turn-policy",
        submission_id="quiz-policy",
        answers=[
            {
                "question_id": "q-calc",
                "question": "What is 12 / 3?",
                "question_type": "fill_blank",
                "user_answer": "5",
                "correct_answer": "4",
                "knowledge_points": ["Division"],
                "is_correct": False,
                "error_type": "calculation",
                "diagnostic_reason": "Division step was evaluated incorrectly.",
            }
        ],
    )
    assert recorded is not None
    review = recorded.review_items[0]
    assert review.mistake_category == "calculation"
    assert review.diagnostic_reason == "Division step was evaluated incorrectly."
    assert review.diagnostic_confidence == 0.72
    assert review.diagnostic_evidence_count == 1

    first, review = store.complete_review(
        project["id"],
        review.id,
        is_correct=True,
        attempt_id="policy-1",
        expected_version=recorded.version,
    )
    assert review.interval_days == 1
    second, review = store.complete_review(
        project["id"],
        review.id,
        is_correct=True,
        attempt_id="policy-2",
        expected_version=first.version,
    )
    assert review.interval_days == 7
    _, review = store.complete_review(
        project["id"],
        review.id,
        is_correct=True,
        attempt_id="policy-3",
        expected_version=second.version,
    )
    assert review.interval_days == 30
    assert review.diagnostic_confidence == pytest.approx(0.96)
    assert review.diagnostic_evidence_count == 4


def test_linked_resource_activity_is_owner_scoped_and_idempotent(client: TestClient) -> None:
    linked = _create(client, "linked-resource")
    unlinked = _create(client, "unlinked-resource")
    configured = client.patch(
        f"/api/v1/learning/projects/{linked['id']}",
        json={
            "expected_version": linked["version"],
            "book_ids": ["book-1"],
            "notebook_ids": ["notes-1"],
        },
    ).json()
    store = learning_projects._store()

    first = store.record_linked_resource_activity(
        owner_id="learner-1",
        resource_type="notebook",
        resource_ids=["notes-1"],
        title="Saved explanation",
        result_refs=["notebook-record:record-1"],
        dedupe_key="record:record-1",
    )
    retry = store.record_linked_resource_activity(
        owner_id="learner-1",
        resource_type="notebook",
        resource_ids=["notes-1"],
        title="Saved explanation",
        result_refs=["notebook-record:record-1"],
        dedupe_key="record:record-1",
    )
    wrong_owner = store.record_linked_resource_activity(
        owner_id="someone-else",
        resource_type="book",
        resource_ids=["book-1"],
        title="Book practice completed",
        dedupe_key="quiz:1",
    )

    assert [item.id for item in first] == [linked["id"]]
    assert retry == []
    assert wrong_owner == []
    saved = store.load(linked["id"])
    assert saved is not None
    assert saved.version == configured["version"] + 1
    assert saved.events[-1].event_type == "resource_activity"
    assert saved.events[-1].result_refs == ["notebook-record:record-1"]
    untouched = store.load(unlinked["id"])
    assert untouched is not None
    assert all(event.event_type != "resource_activity" for event in untouched.events)

    reminded = store.record_external_event(
        linked["id"],
        owner_id="learner-1",
        event_type="tutor_reminder",
        title="Tutor reminder snoozed",
        result_refs=["reminder:job-1"],
        dedupe_key="reminder:job-1:snoozed",
    )
    reminded_retry = store.record_external_event(
        linked["id"],
        owner_id="learner-1",
        event_type="tutor_reminder",
        title="Tutor reminder snoozed",
        result_refs=["reminder:job-1"],
        dedupe_key="reminder:job-1:snoozed",
    )
    assert reminded is not None and reminded_retry is not None
    assert reminded_retry.version == reminded.version
    assert reminded.events[-1].event_type == "tutor_reminder"
    assert (
        store.record_external_event(
            linked["id"],
            owner_id="someone-else",
            event_type="tutor_reminder",
            title="Forbidden",
            dedupe_key="forbidden",
        )
        is None
    )
