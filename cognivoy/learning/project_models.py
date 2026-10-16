from __future__ import annotations

import time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ProjectStatus = Literal["active", "paused", "completed", "archived"]
TaskStatus = Literal["todo", "in_progress", "completed", "skipped"]
LearningSessionPhase = Literal[
    "goal",
    "prerequisite_check",
    "instruction",
    "active_recall",
    "feedback",
    "exit_check",
    "transfer",
]
LearningSessionStatus = Literal["active", "verified"]
LearningEventType = Literal[
    "project_created",
    "project_updated",
    "task_created",
    "task_started",
    "task_completed",
    "task_skipped",
    "mastery_updated",
    "review_scheduled",
    "assessment_completed",
    "knowledge_map_updated",
    "quiz_completed",
    "mistake_recorded",
    "review_completed",
    "resource_activity",
    "tutor_reminder",
    "mentor_suggestion",
]
KnowledgeNodeStatus = Literal["locked", "ready", "in_progress", "mastered"]
AssessmentStatus = Literal["pending", "completed", "skipped"]
ReviewStatus = Literal["due", "scheduled", "completed", "mastered"]
ReviewIntensity = Literal["light", "balanced", "intensive"]
TeachingStrategy = Literal[
    "adaptive", "structured", "visual_first", "socratic", "practice_first", "example_first"
]
DifficultyPolicy = Literal["adaptive", "foundation", "guided", "challenge"]
MistakeCategory = Literal[
    "concept",
    "prerequisite",
    "calculation",
    "misunderstanding",
    "question_reading",
    "expression",
    "guessing",
    "unknown",
]


class LearningEvent(BaseModel):
    """Append-only learner-visible evidence attached to a project."""

    model_config = ConfigDict(extra="ignore")

    id: str
    project_id: str
    event_type: LearningEventType
    title: str
    description: str = ""
    task_id: str | None = None
    result_refs: list[str] = Field(default_factory=list)
    mastery_before: float | None = Field(default=None, ge=0, le=1)
    mastery_after: float | None = Field(default=None, ge=0, le=1)
    created_at: float = Field(default_factory=time.time)


class LearningSessionCheckpoint(BaseModel):
    """One server-authored checkpoint in a structured teaching session."""

    model_config = ConfigDict(extra="ignore")

    phase: LearningSessionPhase
    passed: bool | None = None
    summary: str = Field(default="", max_length=1000)
    evidence_ref: str
    turn_id: str = ""
    created_at: float = Field(default_factory=time.time)


class LearningSessionState(BaseModel):
    """Recoverable per-task teaching state with a deterministic exit gate."""

    model_config = ConfigDict(extra="ignore")

    schema_version: Literal[1] = 1
    session_id: str
    status: LearningSessionStatus = "active"
    current_phase: LearningSessionPhase | None = None
    checkpoints: list[LearningSessionCheckpoint] = Field(default_factory=list)
    exit_check_passed: bool = False
    transfer_passed: bool = False
    started_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


class LearningTask(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    project_id: str
    objective: str
    expected_minutes: int = Field(default=25, ge=5, le=480)
    prerequisites: list[str] = Field(default_factory=list)
    intent: str = "mastery_path"
    resource_refs: list[str] = Field(default_factory=list)
    status: TaskStatus = "todo"
    mastery_before: float | None = Field(default=None, ge=0, le=1)
    mastery_after: float | None = Field(default=None, ge=0, le=1)
    result_refs: list[str] = Field(default_factory=list)
    learning_session: LearningSessionState | None = None
    creation_key: str = ""
    due_at: float | None = None
    completed_at: float | None = None
    version: int = 1
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


class KnowledgeNode(BaseModel):
    """A learner-facing step in the project's knowledge map."""

    model_config = ConfigDict(extra="ignore")

    id: str
    title: str
    description: str = ""
    status: KnowledgeNodeStatus = "locked"
    mastery: float = Field(default=0, ge=0, le=1)
    prerequisite_ids: list[str] = Field(default_factory=list)
    order: int = Field(default=0, ge=0)


class BaselineAssessment(BaseModel):
    """Persisted baseline calibration; questions are derived from the map."""

    model_config = ConfigDict(extra="ignore")

    status: AssessmentStatus = "pending"
    responses: dict[str, int] = Field(default_factory=dict)
    score: float | None = Field(default=None, ge=0, le=1)
    inferred_level: str | None = None
    completed_at: float | None = None


class ProjectReviewItem(BaseModel):
    """One durable, learner-visible spaced-review item."""

    model_config = ConfigDict(extra="ignore")

    id: str
    title: str
    knowledge_point: str = ""
    source_ref: str
    mistake_category: MistakeCategory = "unknown"
    diagnostic_reason: str = ""
    diagnostic_confidence: float = Field(default=0.35, ge=0, le=1)
    diagnostic_evidence_count: int = Field(default=1, ge=0)
    due_at: float
    status: ReviewStatus = "due"
    interval_days: int = Field(default=0, ge=0, le=365)
    attempt_count: int = Field(default=0, ge=0)
    correct_streak: int = Field(default=0, ge=0)
    last_reviewed_at: float | None = None
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


class ReviewPreferences(BaseModel):
    """Learner-controlled project review policy."""

    model_config = ConfigDict(extra="ignore")

    intensity: ReviewIntensity = "balanced"
    reminder_time: str = Field(default="19:00", pattern=r"^(?:[01]\d|2[0-3]):[0-5]\d$")
    daily_question_limit: int = Field(default=10, ge=1, le=100)
    reminder_weekdays: list[Literal[0, 1, 2, 3, 4, 5, 6]] = Field(
        default_factory=lambda: [0, 1, 2, 3, 4, 5, 6],
        min_length=1,
        max_length=7,
    )
    reminders_paused_until: float | None = Field(default=None, ge=0)


class LearningProject(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    owner_id: str
    title: str
    language: Literal["en", "zh"] = "en"
    motivation: str = ""
    current_level: str = "beginner"
    target_level: str = "practical"
    existing_materials: str = ""
    deadline: float | None = None
    weekly_minutes: int = Field(default=180, ge=15, le=10080)
    preferred_methods: list[str] = Field(default_factory=list)
    teaching_strategy: TeachingStrategy = "adaptive"
    difficulty_policy: DifficultyPolicy = "adaptive"
    status: ProjectStatus = "active"
    knowledge_base_ids: list[str] = Field(default_factory=list)
    book_ids: list[str] = Field(default_factory=list)
    notebook_ids: list[str] = Field(default_factory=list)
    partner_id: str | None = None
    plan_version: int = 1
    weekly_plan: list[str] = Field(default_factory=list)
    knowledge_map: list[KnowledgeNode] = Field(default_factory=list)
    baseline_assessment: BaselineAssessment = Field(default_factory=BaselineAssessment)
    review_items: list[ProjectReviewItem] = Field(default_factory=list)
    review_preferences: ReviewPreferences = Field(default_factory=ReviewPreferences)
    mastery_summary: float = Field(default=0, ge=0, le=1)
    weak_points: list[str] = Field(default_factory=list)
    due_review_count: int = Field(default=0, ge=0)
    next_review_at: float | None = None
    tasks: list[LearningTask] = Field(default_factory=list)
    events: list[LearningEvent] = Field(default_factory=list)
    version: int = 1
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)
    last_activity_at: float = Field(default_factory=time.time)


__all__ = [
    "LearningEvent",
    "LearningEventType",
    "LearningProject",
    "LearningTask",
    "LearningSessionCheckpoint",
    "LearningSessionPhase",
    "LearningSessionState",
    "LearningSessionStatus",
    "KnowledgeNode",
    "KnowledgeNodeStatus",
    "BaselineAssessment",
    "AssessmentStatus",
    "ProjectReviewItem",
    "ReviewStatus",
    "ReviewPreferences",
    "ReviewIntensity",
    "TeachingStrategy",
    "DifficultyPolicy",
    "MistakeCategory",
    "ProjectStatus",
    "TaskStatus",
]
