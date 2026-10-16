"""Learning projects and resumable learning tasks."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from hashlib import sha256
import json
import logging
from pathlib import Path
import time
from uuid import NAMESPACE_URL, uuid4, uuid5

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

from cognivoy.book.storage import BookStorage, get_book_storage
from cognivoy.learning.adaptive import adaptive_teaching_profile
from cognivoy.learning.project_models import (
    BaselineAssessment,
    KnowledgeNode,
    LearningProject,
    LearningTask,
    ReviewPreferences,
)
from cognivoy.learning.project_storage import (
    LearningProjectStore,
    reconcile_project_partner_outreach,
)
from cognivoy.learning.readiness import course_readiness
from cognivoy.learning.reconcile import reconcile_course_plan
from cognivoy.multi_user.context import get_current_user
from cognivoy.services.file_io import atomic_write_json
from cognivoy.services.path_service import get_path_service
from cognivoy.services.session import get_sqlite_session_store

router = APIRouter()
logger = logging.getLogger(__name__)


class ProjectCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    language: str = Field(default="en", pattern="^(en|zh)$")
    motivation: str = Field(default="", max_length=1000)
    current_level: str = Field(default="beginner", max_length=80)
    target_level: str = Field(default="practical", max_length=80)
    existing_materials: str = Field(default="", max_length=1000)
    deadline: float | None = None
    weekly_minutes: int = Field(default=180, ge=15, le=10080)
    preferred_methods: list[str] = Field(default_factory=list, max_length=12)
    teaching_strategy: str = Field(
        default="adaptive",
        pattern="^(adaptive|structured|visual_first|socratic|practice_first|example_first)$",
    )
    difficulty_policy: str = Field(
        default="adaptive", pattern="^(adaptive|foundation|guided|challenge)$"
    )
    knowledge_base_ids: list[str] = Field(default_factory=list, max_length=50)
    book_ids: list[str] = Field(default_factory=list, max_length=50)
    notebook_ids: list[str] = Field(default_factory=list, max_length=50)
    partner_id: str | None = None


class ProjectUpdate(BaseModel):
    expected_version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    motivation: str | None = Field(default=None, max_length=1000)
    current_level: str | None = Field(default=None, max_length=80)
    target_level: str | None = Field(default=None, max_length=80)
    existing_materials: str | None = Field(default=None, max_length=1000)
    deadline: float | None = None
    preferred_methods: list[str] | None = Field(default=None, max_length=12)
    teaching_strategy: str | None = Field(
        default=None,
        pattern="^(adaptive|structured|visual_first|socratic|practice_first|example_first)$",
    )
    difficulty_policy: str | None = Field(
        default=None, pattern="^(adaptive|foundation|guided|challenge)$"
    )
    status: str | None = None
    weekly_minutes: int | None = Field(default=None, ge=15, le=10080)
    knowledge_base_ids: list[str] | None = Field(default=None, max_length=50)
    book_ids: list[str] | None = Field(default=None, max_length=50)
    notebook_ids: list[str] | None = Field(default=None, max_length=50)
    partner_id: str | None = None
    review_preferences: ReviewPreferences | None = None


class TaskCreate(BaseModel):
    expected_project_version: int = Field(ge=1)
    objective: str = Field(min_length=1, max_length=500)
    expected_minutes: int = Field(default=25, ge=5, le=480)
    intent: str = Field(default="mastery_path", max_length=80)
    due_at: float | None = None
    prerequisite_ids: list[str] = Field(default_factory=list)
    resource_refs: list[str] = Field(default_factory=list)


class TaskUpdate(BaseModel):
    expected_project_version: int = Field(ge=1)
    expected_task_version: int = Field(ge=1)
    status: str | None = None
    mastery_after: float | None = Field(default=None, ge=0, le=1)
    result_refs: list[str] | None = None


class BaselineAssessmentSubmit(BaseModel):
    expected_project_version: int = Field(ge=1)
    responses: dict[str, int] = Field(min_length=1, max_length=20)


class ReviewComplete(BaseModel):
    expected_project_version: int = Field(ge=1)
    is_correct: bool
    attempt_id: str = Field(min_length=1, max_length=200)


class PlanReconcileRequest(BaseModel):
    expected_project_version: int = Field(ge=1)


class ExperimentConsentUpdate(BaseModel):
    consent: bool
    notice_version: int = Field(default=1, ge=1, le=100)


class MentorSuggestionEventCreate(BaseModel):
    project_id: str = Field(min_length=1, max_length=200)
    kind: str = Field(pattern="^(review|strengthen|continue|plan)$")
    action: str = Field(pattern="^(shown|adopted)$")


def _store() -> LearningProjectStore:
    return LearningProjectStore()


def _experiment_preferences_path() -> Path:
    return get_path_service().get_settings_file("learning_experiments")


def _load_experiment_preferences() -> dict:
    path = _experiment_preferences_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        payload = {}
    owner_id = get_current_user().id
    if payload.get("owner_id") != owner_id:
        payload = {}
    return {
        "consent": bool(payload.get("consent", False)),
        "notice_version": int(payload.get("notice_version") or 1),
        "updated_at": payload.get("updated_at"),
        "analytics_scope": "local_aggregate_only",
        "content_collection": False,
        "external_sharing": False,
    }


def _portfolio_metrics(projects: list[LearningProject]) -> dict:
    """Aggregate only durable learning evidence; never inspect message content."""
    now = time.time()
    week_start = now - 7 * 86400
    month_start = now - 30 * 86400
    events = [event for project in projects for event in project.events]
    project_tasks = [(project, task) for project in projects for task in project.tasks]
    reviews = [item for project in projects for item in project.review_items]
    active_days_7 = {
        datetime.fromtimestamp(event.created_at, tz=UTC).date().isoformat()
        for event in events
        if event.created_at >= week_start
    }
    active_days_30 = {
        datetime.fromtimestamp(event.created_at, tz=UTC).date().isoformat()
        for event in events
        if event.created_at >= month_start
    }
    completed_tasks = [
        task for project, task in project_tasks if _is_effectively_completed(project, task)
    ]
    actionable_tasks = [task for _, task in project_tasks if task.status != "skipped"]
    attempted_reviews = [item for item in reviews if item.attempt_count > 0]
    repeated_errors = [
        item for item in attempted_reviews if item.attempt_count > 1 and item.correct_streak == 0
    ]
    mastered_nodes = sum(
        node.status == "mastered" for project in projects for node in project.knowledge_map
    )
    return {
        "project_count": len(projects),
        "first_learning_completed": sum(
            project.baseline_assessment.status == "completed" for project in projects
        ),
        "completed_tasks": len(completed_tasks),
        "task_completion_rate": round(len(completed_tasks) / len(actionable_tasks), 4)
        if actionable_tasks
        else 0.0,
        "review_participation_count": len(attempted_reviews),
        "repeated_error_rate": round(len(repeated_errors) / len(attempted_reviews), 4)
        if attempted_reviews
        else 0.0,
        "mastered_knowledge_points": mastered_nodes,
        "active_days_7": len(active_days_7),
        "active_days_30": len(active_days_30),
        "privacy": {
            "source": "local_learning_evidence",
            "message_content_used": False,
            "external_transfer": False,
        },
    }


def _reconcile_outreach(
    project: LearningProject,
    *,
    previous_partner_id: str | None = None,
) -> None:
    if previous_partner_id and previous_partner_id != project.partner_id:
        try:
            from cognivoy.services.partners.proactive_learning import (
                cancel_learning_project_outreach,
            )

            cancel_learning_project_outreach(
                project_id=project.id,
                partner_id=previous_partner_id,
                reason="tutor_reassigned",
            )
        except Exception:
            logger.warning(
                "Failed to clear outreach for previous Partner %s on project %s",
                previous_partner_id,
                project.id,
                exc_info=True,
            )
    reconcile_project_partner_outreach(project)


def _project_or_404(store: LearningProjectStore, project_id: str) -> LearningProject:
    try:
        project = store.load(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid project id") from exc
    if project is None:
        raise HTTPException(status_code=404, detail="Learning project not found")
    if project.owner_id != get_current_user().id:
        raise HTTPException(status_code=404, detail="Learning project not found")
    return project


def _save(
    store: LearningProjectStore, project: LearningProject, expected_version: int
) -> LearningProject:
    try:
        return store.save(project, expected_version=expected_version)
    except RuntimeError as exc:
        current_version = int(str(exc).partition(":")[2] or 0)
        raise HTTPException(
            status_code=409,
            detail={
                "code": "revision_conflict",
                "message": "The learning project changed on the server. Reload and retry.",
                "current_version": current_version,
            },
        ) from exc


def _initial_plan(title: str, weekly_minutes: int, language: str) -> list[str]:
    session_minutes = max(15, min(45, weekly_minutes // 4))
    if language == "zh":
        return [
            f"诊断你目前对“{title}”的理解",
            f"学习“{title}”的核心概念（{session_minutes} 分钟）",
            f"完成“{title}”的引导练习",
            "复盘错题并安排下一次复习",
        ]
    return [
        f"Diagnose your current understanding of {title}",
        f"Study the core concepts of {title} ({session_minutes} minutes)",
        f"Complete guided practice for {title}",
        "Review mistakes and schedule the next review",
    ]


def _knowledge_map(project_id: str, title: str, language: str) -> list[KnowledgeNode]:
    if language == "zh":
        steps = [
            (f"{title}：基础概念", "识别关键术语、对象和最基本的规则。"),
            (f"{title}：核心关系", "理解主要概念之间如何关联，并能解释原因。"),
            (f"{title}：应用与练习", "在典型问题中选择方法、完成步骤并检查结果。"),
            (f"{title}：综合与迁移", "解决陌生问题，并能总结、比较或教授这一主题。"),
        ]
    else:
        steps = [
            (f"{title}: foundations", "Recognize the key terms, objects, and basic rules."),
            (f"{title}: core relationships", "Explain how the main ideas connect and why."),
            (
                f"{title}: application and practice",
                "Choose a method, solve typical problems, and check the result.",
            ),
            (
                f"{title}: synthesis and transfer",
                "Solve unfamiliar problems and summarize or teach the topic.",
            ),
        ]
    nodes: list[KnowledgeNode] = []
    for index, (node_title, description) in enumerate(steps):
        node_id = uuid5(NAMESPACE_URL, f"cognivoy:{project_id}:knowledge:{index}").hex
        nodes.append(
            KnowledgeNode(
                id=node_id,
                title=node_title,
                description=description,
                status="ready" if index == 0 else "locked",
                prerequisite_ids=[nodes[index - 1].id] if index else [],
                order=index,
            )
        )
    return nodes


def _assessment_questions(project: LearningProject) -> list[dict]:
    if project.language == "zh":
        prompts = [
            "面对这一层内容时，你目前能做到什么程度？",
            "你能否不看资料解释这一层的关键关系？",
            "你能否独立完成这一层的典型练习？",
            "你能否把这一层迁移到陌生问题或讲给别人？",
        ]
        choices = ["完全陌生", "见过但需要指导", "能完成常见任务", "能独立解释和应用"]
    else:
        prompts = [
            "What can you currently do at this layer?",
            "Can you explain the key relationships without notes?",
            "Can you complete typical practice at this layer independently?",
            "Can you transfer this layer to unfamiliar problems or teach it?",
        ]
        choices = [
            "New to me",
            "Familiar but need guidance",
            "Can handle typical tasks",
            "Can explain and apply independently",
        ]
    return [
        {
            "id": node.id,
            "knowledge_node_id": node.id,
            "title": node.title,
            "prompt": prompts[min(index, len(prompts) - 1)],
            "choices": choices,
        }
        for index, node in enumerate(project.knowledge_map)
    ]


def _task_payload(task: LearningTask) -> dict:
    return task.model_dump(exclude={"creation_key"})


def _is_effectively_completed(project: LearningProject, task: LearningTask) -> bool:
    """Use one completion rule everywhere the learner sees plan progress.

    Imported courses can mark an assessment task complete before every
    objective baseline question has been answered.  Treating that task as
    complete on one screen and incomplete on another was the main source of
    progress drift between the dashboard and project detail.
    """

    return task.status == "completed" and not (
        task.intent == "assessment" and project.baseline_assessment.status != "completed"
    )


def _next_project_action(project: LearningProject) -> dict:
    """Return the single learner-facing action that should win this project."""

    now = time.time()
    assessment_task = next(
        (task for task in project.tasks if task.intent == "assessment"),
        None,
    )
    if project.baseline_assessment.status != "completed" and assessment_task is not None:
        return {
            "kind": "baseline",
            "project_id": project.id,
            "project_title": project.title,
            "title": assessment_task.objective,
            "reason": (
                "先校准起点，学习计划才能根据你的水平调整。"
                if project.language == "zh"
                else "Calibrate your starting point before the plan adapts."
            ),
            "expected_minutes": assessment_task.expected_minutes,
            "task": {
                **_task_payload(assessment_task),
                "project_version": project.version,
            },
        }

    due_reviews = [
        item
        for item in project.review_items
        if item.status == "due" or (item.status == "scheduled" and item.due_at <= now)
    ]
    if due_reviews:
        return {
            "kind": "review",
            "project_id": project.id,
            "project_title": project.title,
            "title": (
                f"复习 {len(due_reviews)} 个到期知识点"
                if project.language == "zh"
                else f"Review {len(due_reviews)} due item(s)"
            ),
            "reason": (
                "趁记忆仍可巩固时完成复习。"
                if project.language == "zh"
                else "Review before the knowledge becomes harder to retrieve."
            ),
            "expected_minutes": min(30, max(5, len(due_reviews) * 5)),
            "task": None,
        }

    available_tasks = [
        task
        for task in project.tasks
        if task.status in {"todo", "in_progress"} and task.intent != "assessment"
    ]
    available_tasks.sort(
        key=lambda item: (
            item.status != "in_progress",
            item.due_at or float("inf"),
            item.created_at,
        )
    )
    if available_tasks:
        task = available_tasks[0]
        return {
            "kind": "continue" if task.status == "in_progress" else "start",
            "project_id": project.id,
            "project_title": project.title,
            "title": task.objective,
            "reason": (
                "从上次停下的位置继续。"
                if project.language == "zh" and task.status == "in_progress"
                else "开始计划中最优先的学习任务。"
                if project.language == "zh"
                else "Continue from where you left off."
                if task.status == "in_progress"
                else "Start the highest-priority task in your plan."
            ),
            "expected_minutes": task.expected_minutes,
            "task": {
                **_task_payload(task),
                "project_version": project.version,
            },
        }

    return {
        "kind": "completed" if project.tasks else "plan",
        "project_id": project.id,
        "project_title": project.title,
        "title": (
            "查看学习成果"
            if project.language == "zh" and project.tasks
            else "完善学习计划"
            if project.language == "zh"
            else "Review your learning results"
            if project.tasks
            else "Complete your learning plan"
        ),
        "reason": (
            "当前计划任务已完成。"
            if project.language == "zh" and project.tasks
            else "补充目标和时间安排后开始学习。"
            if project.language == "zh"
            else "Every current plan task is complete."
            if project.tasks
            else "Add a goal and schedule before you begin."
        ),
        "expected_minutes": 0,
        "task": None,
    }


def _project_status_snapshot(project: LearningProject) -> dict:
    """Build the canonical, versioned status consumed by every entry point."""

    actionable_tasks = [task for task in project.tasks if task.status != "skipped"]
    completed_tasks = [
        task for task in actionable_tasks if _is_effectively_completed(project, task)
    ]
    total = len(actionable_tasks)
    completed = len(completed_tasks)
    return {
        "schema_version": 1,
        "project_id": project.id,
        "project_version": project.version,
        "status": project.status,
        "progress": {
            "completed_tasks": completed,
            "total_tasks": total,
            "completion_rate": round(completed / total, 4) if total else 0.0,
        },
        "mastery": round(project.mastery_summary, 4),
        "due_reviews": project.due_review_count,
        "weak_point_count": len(project.weak_points),
        "next_action": _next_project_action(project),
        "updated_at": project.updated_at,
    }


def _project_analytics(project: LearningProject, *, status: dict | None = None) -> dict:
    """Return deterministic learner-facing outcome metrics for the last week.

    These figures are derived from the append-only evidence chain rather than
    browser telemetry, so refreshes and duplicate submissions cannot inflate
    them.
    """
    now = datetime.now(UTC)
    start = now - timedelta(days=6)
    previous_start = start - timedelta(days=7)
    day_keys = [(start + timedelta(days=offset)).date().isoformat() for offset in range(7)]
    activity = {
        key: {"events": 0, "completed_tasks": 0, "reviews": 0, "quizzes": 0} for key in day_keys
    }
    for event in project.events:
        occurred = datetime.fromtimestamp(event.created_at, tz=UTC)
        key = occurred.date().isoformat()
        if key not in activity:
            continue
        activity[key]["events"] += 1
        if event.event_type == "task_completed":
            activity[key]["completed_tasks"] += 1
        elif event.event_type == "review_completed":
            activity[key]["reviews"] += 1
        elif event.event_type == "quiz_completed":
            activity[key]["quizzes"] += 1
    completed_tasks = [
        task
        for task in project.tasks
        if task.completed_at is not None
        and datetime.fromtimestamp(task.completed_at, tz=UTC) >= start
    ]
    previous_completed_tasks = [
        task
        for task in project.tasks
        if task.completed_at is not None
        and previous_start <= datetime.fromtimestamp(task.completed_at, tz=UTC) < start
    ]
    mastery_delta = sum(
        (task.mastery_after or 0.0) - (task.mastery_before or 0.0)
        for task in completed_tasks
        if task.mastery_after is not None
    )
    active_days = sum(1 for day in activity.values() if day["events"] > 0)
    previous_events = [
        event
        for event in project.events
        if previous_start <= datetime.fromtimestamp(event.created_at, tz=UTC) < start
    ]
    previous_active_days = len(
        {
            datetime.fromtimestamp(event.created_at, tz=UTC).date().isoformat()
            for event in previous_events
        }
    )
    status = status or _project_status_snapshot(project)
    return {
        "period_days": 7,
        "active_days": active_days,
        "completed_tasks": len(completed_tasks),
        "study_minutes": sum(task.expected_minutes for task in completed_tasks),
        "review_attempts": sum(day["reviews"] for day in activity.values()),
        "quiz_attempts": sum(day["quizzes"] for day in activity.values()),
        "mastery_delta": round(mastery_delta, 4),
        "task_completion_rate": status["progress"]["completion_rate"],
        "comparison": {
            "previous_period_days": 7,
            "active_days": previous_active_days,
            "completed_tasks": len(previous_completed_tasks),
            "study_minutes": sum(task.expected_minutes for task in previous_completed_tasks),
            "active_days_delta": active_days - previous_active_days,
            "completed_tasks_delta": len(completed_tasks) - len(previous_completed_tasks),
            "study_minutes_delta": sum(task.expected_minutes for task in completed_tasks)
            - sum(task.expected_minutes for task in previous_completed_tasks),
        },
        "daily": [{"date": key, **activity[key]} for key in day_keys],
    }


def _project_payload(project: LearningProject, *, include_tasks: bool = True) -> dict:
    status = _project_status_snapshot(project)
    if not include_tasks:
        payload = project.model_dump(exclude={"tasks"})
        payload["server_time"] = time.time()
        payload["analytics"] = _project_analytics(project, status=status)
        payload["learning_status"] = status
        payload["teaching_profile"] = adaptive_teaching_profile(project)
        return payload
    payload = project.model_dump()
    payload["tasks"] = [_task_payload(task) for task in project.tasks]
    payload["server_time"] = time.time()
    payload["analytics"] = _project_analytics(project, status=status)
    payload["learning_status"] = status
    payload["teaching_profile"] = adaptive_teaching_profile(project)
    return payload


def _dashboard_task_payload(
    task: LearningTask | dict,
    *,
    project_version: int | None = None,
) -> dict:
    """Return only the task fields required to launch work from the home page."""

    source = _task_payload(task) if isinstance(task, LearningTask) else task
    fields = (
        "id",
        "project_id",
        "objective",
        "expected_minutes",
        "intent",
        "status",
        "due_at",
        "completed_at",
        "version",
        "project_version",
        "prerequisites",
        "resource_refs",
    )
    payload = {field: source[field] for field in fields if field in source}
    if project_version is not None:
        payload["project_version"] = project_version
    return payload


def _project_dashboard_summary(project: LearningProject, *, status: dict | None = None) -> dict:
    """Build the intentionally small project shape used above the home fold."""

    status = status or _project_status_snapshot(project)
    analytics = _project_analytics(project, status=status)
    return {
        "id": project.id,
        "title": project.title,
        "language": project.language,
        "motivation": project.motivation,
        "status": project.status,
        "mastery_summary": project.mastery_summary,
        "weak_points": project.weak_points[:5],
        "due_review_count": project.due_review_count,
        "next_review_at": project.next_review_at,
        "version": project.version,
        "updated_at": project.updated_at,
        "analytics": {"quiz_attempts": analytics["quiz_attempts"]},
        "learning_status": {key: value for key, value in status.items() if key != "next_action"},
    }


def _book_grounding(project: LearningProject) -> dict[str, int]:
    pages = 0
    grounded_pages = 0
    path_service = get_path_service()
    for book_id in project.book_ids:
        try:
            page_files = path_service.get_book_pages_dir(book_id).glob("*.json")
        except ValueError:
            continue
        for page_file in page_files:
            try:
                payload = json.loads(page_file.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                continue
            pages += 1
            blocks = payload.get("blocks") if isinstance(payload, dict) else []
            blocks = blocks if isinstance(blocks, list) else []
            grounded = False
            for block in blocks:
                if not isinstance(block, dict):
                    continue
                metadata = block.get("metadata")
                metadata = metadata if isinstance(metadata, dict) else {}
                anchors = block.get("source_anchors")
                if metadata.get("used_rag") is True or (isinstance(anchors, list) and anchors):
                    grounded = True
                    break
            if grounded:
                grounded_pages += 1
    return {"pages": pages, "grounded_pages": grounded_pages}


def _sync_project_book_sources(
    project: LearningProject,
    *,
    storage: BookStorage | None = None,
) -> None:
    """Propagate newly linked project KBs into linked books.

    A learning project is the learner-facing aggregate.  Linking a knowledge
    base there must not leave its books silently detached from the same
    evidence.  Existing book-specific sources are preserved; newly added
    project sources mark compiled pages stale so the learner gets an explicit
    rebuild/review decision instead of false provenance.
    """

    if not project.book_ids or not project.knowledge_base_ids:
        return
    book_storage = storage or get_book_storage()
    for book_id in project.book_ids:
        try:
            book = book_storage.load_book(book_id)
            if book is None:
                continue
            additions = [
                name for name in project.knowledge_base_ids if name not in book.knowledge_bases
            ]
            if not additions:
                continue
            book.knowledge_bases.extend(additions)
            page_ids = [page.id for page in book_storage.list_pages(book_id)]
            book.stale_page_ids = list(dict.fromkeys([*book.stale_page_ids, *page_ids]))
            book.updated_at = time.time()
            book_storage.save_book(book)
            book_storage.append_log(
                book_id,
                f"linked project knowledge sources: {', '.join(additions)}; "
                f"marked {len(page_ids)} pages for evidence review",
                op="project_sources",
            )
        except Exception:
            logger.warning(
                "Failed to synchronize project sources into book %s",
                book_id,
                exc_info=True,
            )


@router.get("/projects")
async def list_projects():
    owner_id = get_current_user().id
    store = _store()
    projects = [item for item in store.list() if item.owner_id == owner_id]
    for project in projects:
        store.refresh_learning_outcomes(project)
    return {"items": [_project_payload(item) for item in projects]}


@router.post("/projects", status_code=201)
async def create_project(
    body: ProjectCreate,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    store = _store()
    scoped_key = f"{get_current_user().id}:{idempotency_key}" if idempotency_key else ""
    existing = store.resolve_idempotency(scoped_key)
    if existing is not None:
        return _project_payload(existing)
    project_id = uuid4().hex
    task = LearningTask(
        id=uuid4().hex,
        project_id=project_id,
        objective=(
            f"诊断你目前对“{body.title.strip()}”的理解"
            if body.language == "zh"
            else f"Assess what you already know about {body.title.strip()}"
        ),
        expected_minutes=max(10, min(30, body.weekly_minutes // 10)),
        intent="assessment",
        due_at=time.time(),
    )
    project = LearningProject(
        id=project_id,
        owner_id=get_current_user().id,
        title=body.title.strip(),
        language=body.language,
        motivation=body.motivation.strip(),
        current_level=body.current_level.strip(),
        target_level=body.target_level.strip(),
        existing_materials=body.existing_materials.strip(),
        deadline=body.deadline,
        weekly_minutes=body.weekly_minutes,
        preferred_methods=[item.strip() for item in body.preferred_methods if item.strip()],
        teaching_strategy=body.teaching_strategy,
        difficulty_policy=body.difficulty_policy,
        knowledge_base_ids=body.knowledge_base_ids,
        book_ids=body.book_ids,
        notebook_ids=body.notebook_ids,
        partner_id=body.partner_id,
        weekly_plan=_initial_plan(body.title.strip(), body.weekly_minutes, body.language),
        knowledge_map=_knowledge_map(project_id, body.title.strip(), body.language),
        tasks=[task],
    )
    store.append_event(
        project,
        "project_created",
        project.title,
        description=project.motivation,
        dedupe_key="project-created",
    )
    store.append_event(
        project,
        "task_created",
        task.objective,
        description="First task from onboarding",
        task_id=task.id,
        dedupe_key=f"initial-task:{task.id}",
    )
    store.create(project)
    _sync_project_book_sources(project)
    store.remember_idempotency(scoped_key, project.id)
    _reconcile_outreach(project)
    return _project_payload(project)


@router.get("/projects/{project_id}")
async def get_project(project_id: str):
    store = _store()
    project = _project_or_404(store, project_id)
    store.refresh_learning_outcomes(project)
    payload = _project_payload(project)
    question_store = get_sqlite_session_store()
    statistics = await question_store.get_question_notebook_statistics(project.id)
    baseline_entries = await question_store.list_notebook_entries(
        limit=200,
        learning_project_id=project.id,
        learning_task_id=next(
            (task.id for task in project.tasks if task.intent == "assessment"),
            "",
        ),
    )
    statistics["attempted"] = int(statistics.get("correct") or 0) + int(
        statistics.get("incorrect") or 0
    )
    payload["course_readiness"] = course_readiness(
        project,
        question_statistics=statistics,
        baseline_question_count=int(baseline_entries.get("total") or 0),
        baseline_attempted_count=sum(
            int(item.get("attempt_count") or 0) > 0 for item in baseline_entries.get("items", [])
        ),
        book_grounding=_book_grounding(project),
    )
    return payload


@router.get("/projects/{project_id}/timeline")
async def get_project_timeline(project_id: str, limit: int = 50):
    project = _project_or_404(_store(), project_id)
    bounded_limit = max(1, min(limit, 200))
    events = sorted(project.events, key=lambda item: item.created_at, reverse=True)
    return {"items": [item.model_dump() for item in events[:bounded_limit]]}


@router.get("/projects/{project_id}/reviews")
async def get_project_reviews(project_id: str, due_only: bool = False):
    project = _project_or_404(_store(), project_id)
    now = time.time()
    items = [
        item
        for item in project.review_items
        if not due_only
        or item.status == "due"
        or (item.status == "scheduled" and item.due_at <= now)
    ]
    items.sort(key=lambda item: (item.due_at, item.created_at))
    return {"items": [item.model_dump() for item in items]}


@router.post("/projects/{project_id}/reviews/{review_id}/complete")
async def complete_project_review(project_id: str, review_id: str, body: ReviewComplete):
    store = _store()
    _project_or_404(store, project_id)
    try:
        project, review = store.complete_review(
            project_id,
            review_id,
            is_correct=body.is_correct,
            attempt_id=body.attempt_id.strip(),
            expected_version=body.expected_project_version,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Review item not found") from exc
    except RuntimeError as exc:
        current_version = int(str(exc).partition(":")[2] or 0)
        raise HTTPException(
            status_code=409,
            detail={
                "code": "revision_conflict",
                "message": "The learning project changed on the server. Reload and retry.",
                "current_version": current_version,
            },
        ) from exc
    return {
        "project_version": project.version,
        "review": review.model_dump(),
        "due_review_count": project.due_review_count,
        "next_review_at": project.next_review_at,
    }


@router.get("/projects/{project_id}/assessment")
async def get_baseline_assessment(project_id: str):
    project = _project_or_404(_store(), project_id)
    return {
        "status": project.baseline_assessment.status,
        "score": project.baseline_assessment.score,
        "inferred_level": project.baseline_assessment.inferred_level,
        "responses": project.baseline_assessment.responses,
        "questions": _assessment_questions(project),
    }


@router.post("/projects/{project_id}/assessment")
async def submit_baseline_assessment(project_id: str, body: BaselineAssessmentSubmit):
    store = _store()
    project = _project_or_404(store, project_id)
    node_ids = {node.id for node in project.knowledge_map}
    if set(body.responses) != node_ids:
        raise HTTPException(status_code=422, detail="Answer every baseline assessment question")
    if any(
        not isinstance(value, int) or value < 0 or value > 3 for value in body.responses.values()
    ):
        raise HTTPException(status_code=422, detail="Assessment responses must be between 0 and 3")
    values = [body.responses[node.id] for node in project.knowledge_map]
    score = round(sum(values) / (3 * len(values)), 4) if values else 0
    inferred_level = "beginner" if score < 0.34 else "intermediate" if score < 0.72 else "advanced"
    previous_open = True
    for node in project.knowledge_map:
        response = body.responses[node.id]
        node.mastery = (0, 0.3, 0.6, 0.85)[response]
        if node.mastery >= 0.8:
            node.status = "mastered"
        elif previous_open or not node.prerequisite_ids:
            node.status = "in_progress" if node.mastery >= 0.35 else "ready"
        else:
            node.status = "locked"
        previous_open = node.mastery >= 0.35
    now = time.time()
    project.baseline_assessment = BaselineAssessment(
        status="completed",
        responses=body.responses,
        score=score,
        inferred_level=inferred_level,
        completed_at=now,
    )
    project.current_level = inferred_level
    assessment_task = next((task for task in project.tasks if task.intent == "assessment"), None)
    if assessment_task is not None and assessment_task.status != "completed":
        assessment_task.status = "completed"
        assessment_task.mastery_after = score
        assessment_task.completed_at = now
        assessment_task.updated_at = now
        assessment_task.version += 1
        assessment_task.result_refs = [f"assessment:{project.id}"]
        store.append_event(
            project,
            "task_completed",
            assessment_task.objective,
            description="Baseline assessment completed",
            task_id=assessment_task.id,
            result_refs=assessment_task.result_refs,
            mastery_after=score,
            dedupe_key="baseline-assessment-task",
        )
    store.append_event(
        project,
        "assessment_completed",
        "Baseline assessment" if project.language == "en" else "初始水平测试",
        description=f"Inferred level: {inferred_level}",
        mastery_after=score,
        dedupe_key="baseline-assessment",
    )
    store.append_event(
        project,
        "knowledge_map_updated",
        "Knowledge map calibrated" if project.language == "en" else "知识地图已校准",
        description=f"{len(project.knowledge_map)} learning stages calibrated",
        mastery_after=score,
        dedupe_key="baseline-knowledge-map",
    )
    completed_count = sum(task.status == "completed" for task in project.tasks)
    if completed_count < len(project.weekly_plan):
        objective = project.weekly_plan[completed_count]
        next_id = uuid5(NAMESPACE_URL, f"cognivoy:{project.id}:weekly-plan:{completed_count}").hex
        # Imported and curated courses commonly pre-create their entire plan.
        # In that case the deterministic id differs from the curated task id,
        # so id-only deduplication would append a second, empty copy of the
        # same week after baseline completion.
        if not any(
            task.id == next_id or task.objective.strip() == objective.strip()
            for task in project.tasks
        ):
            next_task = LearningTask(
                id=next_id,
                project_id=project.id,
                objective=objective,
                expected_minutes=max(15, min(45, project.weekly_minutes // 4)),
                intent="mastery_path",
                due_at=now,
            )
            project.tasks.append(next_task)
            store.append_event(
                project,
                "task_created",
                next_task.objective,
                description="Added after baseline assessment",
                task_id=next_task.id,
                dedupe_key=f"weekly-plan-task:{next_task.id}",
            )
    project.mastery_summary = score
    saved = _save(store, project, body.expected_project_version)
    return _project_payload(saved)


@router.patch("/projects/{project_id}")
async def update_project(project_id: str, body: ProjectUpdate):
    store = _store()
    project = _project_or_404(store, project_id)
    previous_partner_id = project.partner_id
    changes = body.model_dump(exclude_unset=True, exclude={"expected_version"})
    if "status" in changes and changes["status"] not in {
        "active",
        "paused",
        "completed",
        "archived",
    }:
        raise HTTPException(status_code=422, detail="Invalid project status")
    for key, value in changes.items():
        setattr(project, key, value.strip() if isinstance(value, str) else value)
    store.append_event(
        project,
        "project_updated",
        project.title,
        description="Learning project settings updated",
        dedupe_key=f"project-update:{body.expected_version}",
    )
    saved = _save(store, project, body.expected_version)
    _sync_project_book_sources(saved)
    _reconcile_outreach(saved, previous_partner_id=previous_partner_id)
    return _project_payload(saved)


@router.post("/projects/{project_id}/reconcile")
async def reconcile_project_plan(project_id: str, body: PlanReconcileRequest):
    """Repair deterministic course-plan gaps without inventing new content.

    Reconciliation is explicit and revision-guarded: it derives the target
    date, visible weekly plan, task dependency chain, and explicit task load
    from the schedule the learner already approved.
    """

    store = _store()
    project = _project_or_404(store, project_id)
    reconcile_course_plan(project)
    store.append_event(
        project,
        "project_updated",
        "Course plan reconciled" if project.language == "en" else "课程计划已校准",
        description=(
            "Target date, weekly load, task prerequisites, and visible plan were aligned."
            if project.language == "en"
            else "已对齐目标日期、周投入、任务前置关系和可见学习计划。"
        ),
        dedupe_key=f"plan-reconcile:{body.expected_project_version}",
    )
    saved = _save(store, project, body.expected_project_version)
    payload = _project_payload(saved)
    question_store = get_sqlite_session_store()
    statistics = await question_store.get_question_notebook_statistics(saved.id)
    statistics["attempted"] = int(statistics.get("correct") or 0) + int(
        statistics.get("incorrect") or 0
    )
    baseline_task_id = next((task.id for task in saved.tasks if task.intent == "assessment"), "")
    baseline_entries = await question_store.list_notebook_entries(
        limit=200,
        learning_project_id=saved.id,
        learning_task_id=baseline_task_id,
    )
    payload["course_readiness"] = course_readiness(
        saved,
        question_statistics=statistics,
        baseline_question_count=int(baseline_entries.get("total") or 0),
        baseline_attempted_count=sum(
            int(item.get("attempt_count") or 0) > 0 for item in baseline_entries.get("items", [])
        ),
        book_grounding=_book_grounding(saved),
    )
    return payload


@router.post("/projects/{project_id}/tasks", status_code=201)
async def create_task(
    project_id: str,
    body: TaskCreate,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    store = _store()
    project = _project_or_404(store, project_id)
    scoped_key = f"{get_current_user().id}:{idempotency_key}" if idempotency_key else ""
    if scoped_key:
        existing = next((item for item in project.tasks if item.creation_key == scoped_key), None)
        if existing is not None:
            return {"project_version": project.version, "task": _task_payload(existing)}
    task = LearningTask(
        id=uuid4().hex,
        project_id=project.id,
        objective=body.objective.strip(),
        expected_minutes=body.expected_minutes,
        intent=body.intent,
        due_at=body.due_at,
        prerequisites=body.prerequisite_ids,
        resource_refs=body.resource_refs,
        creation_key=scoped_key,
    )
    project.tasks.append(task)
    store.append_event(
        project,
        "task_created",
        task.objective,
        description="Task added to the learning project",
        task_id=task.id,
        dedupe_key=f"task-created:{task.id}",
    )
    saved = _save(store, project, body.expected_project_version)
    return {"project_version": saved.version, "task": _task_payload(task)}


@router.patch("/projects/{project_id}/tasks/{task_id}")
async def update_task(project_id: str, task_id: str, body: TaskUpdate):
    store = _store()
    project = _project_or_404(store, project_id)
    task = next((item for item in project.tasks if item.id == task_id), None)
    if task is None:
        raise HTTPException(status_code=404, detail="Learning task not found")
    if task.version != body.expected_task_version:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "revision_conflict",
                "message": "The learning task changed on the server. Reload and retry.",
                "current_version": task.version,
            },
        )
    if body.status is not None:
        if body.status not in {"todo", "in_progress", "completed", "skipped"}:
            raise HTTPException(status_code=422, detail="Invalid task status")
        if body.status in {"in_progress", "completed"} and task.prerequisites:
            task_by_id = {item.id: item for item in project.tasks}
            incomplete = [
                prerequisite_id
                for prerequisite_id in task.prerequisites
                if prerequisite_id not in task_by_id
                or task_by_id[prerequisite_id].status != "completed"
            ]
            assessment_ids = {
                prerequisite_id
                for prerequisite_id in task.prerequisites
                if prerequisite_id in task_by_id
                and task_by_id[prerequisite_id].intent == "assessment"
            }
            for assessment_id in assessment_ids:
                baseline_entries = await get_sqlite_session_store().list_notebook_entries(
                    limit=200,
                    learning_project_id=project.id,
                    learning_task_id=assessment_id,
                )
                if baseline_entries.get("total") and any(
                    int(item.get("attempt_count") or 0) == 0
                    for item in baseline_entries.get("items", [])
                ):
                    incomplete.append(assessment_id)
            incomplete = list(dict.fromkeys(incomplete))
            if incomplete:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "prerequisites_incomplete",
                        "message": "Complete prerequisite learning tasks before starting this task.",
                        "prerequisite_ids": incomplete,
                    },
                )
        task.status = body.status  # type: ignore[assignment]
        task.completed_at = time.time() if body.status == "completed" else None
    if body.mastery_after is not None:
        task.mastery_after = body.mastery_after
    if body.result_refs is not None:
        task.result_refs = body.result_refs
    task.version += 1
    task.updated_at = time.time()
    if body.status == "in_progress":
        store.append_event(
            project,
            "task_started",
            task.objective,
            task_id=task.id,
            dedupe_key=f"task-started:{task.id}:{task.version}",
        )
    elif body.status in {"completed", "skipped"}:
        store.append_event(
            project,
            "task_completed" if body.status == "completed" else "task_skipped",
            task.objective,
            task_id=task.id,
            result_refs=task.result_refs,
            mastery_before=task.mastery_before,
            mastery_after=task.mastery_after,
            dedupe_key=f"task-{body.status}:{task.id}:{task.version}",
        )
    if body.mastery_after is not None:
        store.append_event(
            project,
            "mastery_updated",
            task.objective,
            description=f"Mastery updated to {body.mastery_after:.0%}",
            task_id=task.id,
            mastery_before=task.mastery_before,
            mastery_after=body.mastery_after,
            dedupe_key=f"mastery:{task.id}:{task.version}",
        )
    store.refresh_learning_outcomes(project)
    saved = _save(store, project, body.expected_project_version)
    return {"project_version": saved.version, "task": _task_payload(task)}


@router.get("/metrics")
async def learning_portfolio_metrics():
    owner_id = get_current_user().id
    projects = [item for item in _store().list() if item.owner_id == owner_id]
    return _portfolio_metrics(projects)


@router.get("/experiments/consent")
async def get_experiment_consent():
    return _load_experiment_preferences()


@router.put("/experiments/consent")
async def update_experiment_consent(body: ExperimentConsentUpdate):
    path = _experiment_preferences_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "owner_id": get_current_user().id,
        "consent": body.consent,
        "notice_version": body.notice_version,
        "updated_at": time.time(),
    }
    atomic_write_json(path, payload)
    return _load_experiment_preferences()


@router.get("/dashboard")
async def learning_dashboard(if_none_match: str | None = Header(default=None)):
    owner_id = get_current_user().id
    projects = [
        item for item in _store().list() if item.owner_id == owner_id and item.status == "active"
    ]
    for project in projects:
        LearningProjectStore.refresh_learning_outcomes(project)
    projects.sort(key=lambda item: item.last_activity_at, reverse=True)
    status_by_project = {project.id: _project_status_snapshot(project) for project in projects}
    action_priority = {
        "review": 0,
        "continue": 1,
        "baseline": 2,
        "start": 3,
        "plan": 4,
        "completed": 5,
    }
    primary_project = min(
        projects,
        key=lambda item: (
            action_priority.get(status_by_project[item.id]["next_action"]["kind"], 99),
            -item.last_activity_at,
        ),
        default=None,
    )
    next_action = (
        status_by_project[primary_project.id]["next_action"]
        if primary_project is not None
        else {
            "kind": "create_plan",
            "project_id": None,
            "project_title": None,
            "title": "Create your first learning plan",
            "reason": "Set a goal so Cognivoy can build your first task.",
            "expected_minutes": 3,
            "task": None,
        }
    )
    next_action = {
        **next_action,
        "task": (
            _dashboard_task_payload(next_action["task"])
            if next_action.get("task") is not None
            else None
        ),
    }
    tasks = [
        task
        for project in projects
        for task in project.tasks
        if task.status in {"todo", "in_progress"}
    ]
    tasks.sort(
        key=lambda item: (
            item.status != "in_progress",
            item.due_at or float("inf"),
            item.created_at,
        )
    )
    weak_points = list(
        dict.fromkeys(point for project in projects for point in project.weak_points)
    )[:5]
    weak_project = next(
        (
            {
                "project_id": project.id,
                "project_version": project.version,
                "objective": project.weak_points[0],
            }
            for project in projects
            if project.weak_points
        ),
        None,
    )
    due_reviews = sum(project.due_review_count for project in projects)
    review_project = next(
        (
            {"project_id": project.id, "project_title": project.title}
            for project in projects
            if project.due_review_count
        ),
        None,
    )
    continue_project = next(
        (project for project in projects if tasks and project.id == tasks[0].project_id),
        None,
    )
    suggestion_project = (
        next((project for project in projects if project.due_review_count), None)
        if due_reviews
        else next((project for project in projects if project.weak_points), None)
        if weak_points
        else continue_project or (projects[0] if projects else None)
    )
    mentor_suggestion = (
        {"kind": "review", "count": due_reviews}
        if due_reviews
        else (
            {"kind": "strengthen", "objective": weak_points[0]}
            if weak_points
            else (
                {"kind": "continue", "objective": tasks[0].objective} if tasks else {"kind": "plan"}
            )
        )
    )
    suggestion_seed = ":".join(
        [
            str(mentor_suggestion["kind"]),
            suggestion_project.id if suggestion_project else "onboarding",
            str(mentor_suggestion.get("objective") or mentor_suggestion.get("count") or "plan"),
        ]
    )
    mentor_suggestion.update(
        {
            "id": uuid5(NAMESPACE_URL, f"cognivoy:mentor-suggestion:{suggestion_seed}").hex,
            "project_id": suggestion_project.id if suggestion_project else None,
        }
    )
    payload = {
        "active_projects": len(projects),
        "next_action": next_action,
        "primary_project": (
            _project_dashboard_summary(
                primary_project,
                status=status_by_project[primary_project.id],
            )
            if primary_project is not None
            else None
        ),
        "due_reviews": due_reviews,
        "review_project": review_project,
        "next_review_at": min(
            (project.next_review_at for project in projects if project.next_review_at is not None),
            default=None,
        ),
        "weak_points": weak_points,
        "weak_project": weak_project,
        "mentor_suggestion": mentor_suggestion,
        "continue_task": (
            {
                **_dashboard_task_payload(tasks[0]),
                "project_version": next(
                    project.version for project in projects if project.id == tasks[0].project_id
                ),
            }
            if tasks
            else None
        ),
        "today_tasks": [
            _dashboard_task_payload(
                item,
                project_version=next(
                    project.version for project in projects if project.id == item.project_id
                ),
            )
            for item in tasks
            if item.due_at is not None and item.due_at <= time.time() + 86400
        ][:5],
        "recent_projects": [
            _project_dashboard_summary(item, status=status_by_project[item.id])
            for item in projects
            if primary_project is None or item.id != primary_project.id
        ][:4],
    }
    etag_seed = ";".join(
        [
            owner_id,
            *(
                f"{project.id}:{project.version}:{project.due_review_count}:"
                f"{status_by_project[project.id]['next_action']['kind']}"
                for project in projects
            ),
        ]
    )
    etag = f'"{sha256(etag_seed.encode("utf-8")).hexdigest()[:24]}"'
    headers = {
        "Cache-Control": "private, max-age=0, must-revalidate",
        "ETag": etag,
    }
    if if_none_match == etag:
        return Response(status_code=304, headers=headers)
    return JSONResponse(content=payload, headers=headers)


@router.post("/dashboard/suggestions/{suggestion_id}/events")
async def record_mentor_suggestion_event(
    suggestion_id: str,
    body: MentorSuggestionEventCreate,
):
    if not suggestion_id or len(suggestion_id) > 64:
        raise HTTPException(status_code=400, detail="Invalid mentor suggestion id")
    store = _store()
    project = _project_or_404(store, body.project_id)
    before = len(project.events)
    event = store.append_event(
        project,
        "mentor_suggestion",
        "Tutor suggestion adopted" if body.action == "adopted" else "Tutor suggestion shown",
        description=f"{body.kind}:{body.action}",
        result_refs=[f"mentor-suggestion:{suggestion_id}:{body.action}"],
        dedupe_key=f"mentor-suggestion:{suggestion_id}:{body.action}",
    )
    if len(project.events) == before:
        return {"recorded": False, "event": event}
    saved = _save(store, project, project.version)
    return {"recorded": True, "project_version": saved.version, "event": event}


__all__ = ["router"]
