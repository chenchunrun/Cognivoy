"""Public request contracts and config validators for built-in capabilities."""

from __future__ import annotations

from typing import Any, Callable, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

from cognivoy.agents.math_animator.request_config import (
    MathAnimatorRequestConfig,
    validate_math_animator_request_config,
)
from cognivoy.agents.research.request_config import (
    DeepResearchRequestConfig,
    validate_research_request_config,
)

_RUNTIME_ONLY_KEYS = {
    "_persist_user_message",
    "_recovery_attempt",
    "_recovery_mode",
    "followup_question_context",
    # Per-turn subagent consult budget (composer stepper). Not part of any
    # capability's public config schema; stripped here so it never trips
    # ``extra="forbid"`` (turn_runtime carries it through to the turn config).
    "subagent_consult_budget",
}


class LearningContextPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    project_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,160}$")
    task_id: str = Field(pattern=r"^[A-Za-z0-9_-]{1,160}$")
    objective: str = Field(default="", max_length=500)


class StartTurnPayload(BaseModel):
    """Canonical request shared by WebSocket, Python SDK, and CLI adapters."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["message", "start_turn"] = "start_turn"
    content: str = Field(max_length=2_000_000)
    capability: str | None = "chat"
    session_id: str | None = None
    tools: list[str] | None = None
    knowledge_bases: list[str] = Field(default_factory=list)
    language: str = "en"
    config: dict[str, Any] = Field(default_factory=dict)
    notebook_references: list[dict[str, Any]] = Field(default_factory=list)
    history_references: list[str] = Field(default_factory=list)
    question_notebook_references: list[int] = Field(default_factory=list)
    book_references: list[dict[str, Any]] = Field(default_factory=list)
    memory_references: list[Literal["recent", "profile", "scope", "preferences", "summary"]] = (
        Field(default_factory=list)
    )
    persona: str = ""
    llm_selection: dict[str, str] | None = None
    parent_message_id: int | None = None
    attachments: list[dict[str, Any]] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    learning_context: LearningContextPayload | None = None


def validate_start_turn_payload(raw_payload: dict[str, Any]) -> dict[str, Any]:
    """Validate a public start request without erasing explicit empty values."""
    try:
        model = StartTurnPayload.model_validate(raw_payload)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise ValueError(f"Invalid start turn payload: {details}") from exc
    return model.model_dump(exclude_unset=True)


class ChatRequestConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DeepSolveRequestConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    solve_mode: Literal["guided", "full", "check"] = "full"
    depth: Literal["auto", "quick", "standard", "deep"] = "auto"
    answer_format: Literal["concise", "step_by_step", "structured"] = "structured"
    max_rounds: int | None = Field(default=None, ge=1, le=50)
    total_timeout_seconds: float = Field(default=180.0, ge=5.0, le=900.0)


class SimilarQuestionSeed(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=5_000)
    correct_answer: str = Field(default="", max_length=5_000)
    explanation: str = Field(default="", max_length=10_000)
    source_refs: list[dict[str, Any]] = Field(default_factory=list, max_length=20)


class DeepQuestionRequestConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["custom", "mimic"] = "custom"
    topic: str = ""
    num_questions: int = Field(default=1, ge=1, le=50)
    difficulty: str = ""
    # Allowed-types whitelist. Empty list means "any type — let the
    # planner pick per question". Frontend sends the user's multi-select.
    question_types: list[str] = Field(default_factory=list)
    # Optional per-type quantity targets. When non-empty, sum must equal
    # ``num_questions`` (frontend keeps them in sync). Empty dict means
    # "no per-type targets — distribute freely across allowed types".
    per_type_counts: dict[str, int] = Field(default_factory=dict)
    paper_path: str = ""
    max_questions: int = Field(default=10, ge=1, le=100)
    similar_to: SimilarQuestionSeed | None = None


class VisualizeRequestConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    render_mode: Literal[
        "auto",
        "svg",
        "chartjs",
        "mermaid",
        "html",
        "manim_video",
        "manim_image",
    ] = "auto"
    # Only meaningful when the routed render_type is manim_video / manim_image
    # (either chosen explicitly or selected by AnalysisAgent in auto mode).
    # Mirrors MathAnimatorRequestConfig defaults so the auto path stays
    # zero-config.
    quality: Literal["low", "medium", "high"] = "medium"
    style_hint: str = Field(default="", max_length=500)
    aspect_ratio: Literal["auto", "16:9", "4:3", "1:1", "9:16"] = "auto"
    theme: Literal["auto", "light", "dark"] = "auto"
    width: int | None = Field(default=None, ge=320, le=3840)
    height: int | None = Field(default=None, ge=240, le=2160)
    duration_seconds: float | None = Field(default=None, gt=0, le=600)
    fps: int = Field(default=30, ge=1, le=120)
    show_code: bool = True
    parameters: dict[str, str | int | float | bool | None] = Field(default_factory=dict)

    @field_validator("parameters")
    @classmethod
    def validate_parameters(
        cls, value: dict[str, str | int | float | bool | None]
    ) -> dict[str, str | int | float | bool | None]:
        if len(value) > 20:
            raise ValueError("parameters supports at most 20 entries")
        for key in value:
            if not key.strip() or len(key) > 80:
                raise ValueError("parameter names must contain 1-80 visible characters")
        return value

    @model_validator(mode="after")
    def validate_dimensions(self) -> VisualizeRequestConfig:
        if (self.width is None) != (self.height is None):
            raise ValueError("width and height must be provided together")
        return self


def _clean_public_config(raw_config: dict[str, Any] | None) -> dict[str, Any]:
    if raw_config is None:
        return {}
    if not isinstance(raw_config, dict):
        raise ValueError("Capability config must be an object.")
    cleaned = dict(raw_config)
    for key in _RUNTIME_ONLY_KEYS:
        cleaned.pop(key, None)
    return cleaned


def _validate_model(
    model_type: type[BaseModel],
    raw_config: dict[str, Any] | None,
    *,
    label: str,
) -> BaseModel:
    cleaned = _clean_public_config(raw_config)
    try:
        return model_type.model_validate(cleaned)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise ValueError(f"Invalid {label} config: {details}") from exc


def validate_chat_request_config(raw_config: dict[str, Any] | None) -> ChatRequestConfig:
    return _validate_model(ChatRequestConfig, raw_config, label="chat")


def validate_deep_solve_request_config(
    raw_config: dict[str, Any] | None,
) -> DeepSolveRequestConfig:
    return _validate_model(DeepSolveRequestConfig, raw_config, label="deep solve")


def validate_deep_question_request_config(
    raw_config: dict[str, Any] | None,
) -> DeepQuestionRequestConfig:
    return _validate_model(DeepQuestionRequestConfig, raw_config, label="deep question")


def validate_visualize_request_config(
    raw_config: dict[str, Any] | None,
) -> VisualizeRequestConfig:
    return _validate_model(VisualizeRequestConfig, raw_config, label="visualize")


def build_request_schema(model_type: type[BaseModel]) -> dict[str, Any]:
    return model_type.model_json_schema(mode="validation")


CAPABILITY_CONFIG_VALIDATORS: dict[str, Callable[[dict[str, Any] | None], Any]] = {
    "chat": validate_chat_request_config,
    "deep_solve": validate_deep_solve_request_config,
    "deep_question": validate_deep_question_request_config,
    "deep_research": validate_research_request_config,
    "math_animator": validate_math_animator_request_config,
    "visualize": validate_visualize_request_config,
}

CAPABILITY_REQUEST_SCHEMAS: dict[str, dict[str, Any]] = {
    "chat": build_request_schema(ChatRequestConfig),
    "deep_solve": build_request_schema(DeepSolveRequestConfig),
    "deep_question": build_request_schema(DeepQuestionRequestConfig),
    "deep_research": build_request_schema(DeepResearchRequestConfig),
    "math_animator": build_request_schema(MathAnimatorRequestConfig),
    "visualize": build_request_schema(VisualizeRequestConfig),
}


def validate_capability_config(
    capability: str, raw_config: dict[str, Any] | None
) -> dict[str, Any]:
    validator = CAPABILITY_CONFIG_VALIDATORS.get(capability)
    if validator is None:
        return _clean_public_config(raw_config)
    model = validator(raw_config)
    if isinstance(model, BaseModel):
        return model.model_dump(mode="json", exclude_none=True)
    return _clean_public_config(raw_config)


def get_capability_request_schema(capability: str) -> dict[str, Any]:
    return dict(CAPABILITY_REQUEST_SCHEMAS.get(capability, {}))


__all__ = [
    "CAPABILITY_CONFIG_VALIDATORS",
    "CAPABILITY_REQUEST_SCHEMAS",
    "ChatRequestConfig",
    "DeepQuestionRequestConfig",
    "DeepSolveRequestConfig",
    "VisualizeRequestConfig",
    "build_request_schema",
    "get_capability_request_schema",
    "validate_capability_config",
    "validate_chat_request_config",
    "validate_deep_question_request_config",
    "validate_deep_solve_request_config",
    "validate_visualize_request_config",
]
