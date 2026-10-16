"""Validated request config and intent-to-policy mapping for deep research.

Tool composition lives in :mod:`cognivoy.agents._shared.tool_composition`
— the same shim chat uses. Research has no separate ``sources`` knob:
whatever tools the user enables in the composer become available to the
per-block research loop, with ``rag`` auto-mounted when a KB is attached
(again, identical to chat).
"""

from __future__ import annotations

from datetime import date
import re
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)

ResearchMode = Literal["notes", "report", "comparison", "learning_path"]
ResearchDepth = Literal["quick", "standard", "deep", "manual"]
ResearchSourceType = Literal["knowledge_base", "web", "papers"]
ResearchReportFormat = Literal[
    "markdown",
    "executive_summary",
    "literature_review",
    "comparison",
]


class OutlineItem(BaseModel):
    title: str
    overview: str = ""


class DeepResearchRequestConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: ResearchMode
    depth: ResearchDepth

    manual_subtopics: int | None = None
    manual_max_iterations: int | None = None

    confirmed_outline: list[OutlineItem] | None = None
    checkpoint_id: str | None = Field(default=None, min_length=8, max_length=80)
    source_types: list[ResearchSourceType] | None = Field(default=None, min_length=1)
    date_from: date | None = None
    date_to: date | None = None
    report_format: ResearchReportFormat = "markdown"
    max_sources: int = Field(default=20, ge=1, le=100)
    audience: str = Field(default="", max_length=200)
    region: str = Field(default="", max_length=100)

    @field_validator("manual_subtopics")
    @classmethod
    def validate_manual_subtopics(cls, value: int | None) -> int | None:
        if value is not None:
            return max(1, min(value, 10))
        return value

    @field_validator("manual_max_iterations")
    @classmethod
    def validate_manual_max_iterations(cls, value: int | None) -> int | None:
        if value is not None:
            return max(1, min(value, 10))
        return value

    @field_validator("source_types")
    @classmethod
    def validate_source_types(
        cls, value: list[ResearchSourceType] | None
    ) -> list[ResearchSourceType] | None:
        if value is not None and len(set(value)) != len(value):
            raise ValueError("source_types must not contain duplicates")
        return value

    @field_validator("checkpoint_id")
    @classmethod
    def validate_checkpoint_id(cls, value: str | None) -> str | None:
        if value is not None and not re.fullmatch(r"[A-Za-z0-9_-]+", value):
            raise ValueError("checkpoint_id may contain only letters, numbers, '_' and '-'")
        return value

    @model_validator(mode="after")
    def validate_date_range(self) -> DeepResearchRequestConfig:
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from must not be after date_to")
        return self


def validate_research_request_config(
    raw_config: dict[str, Any] | None,
) -> DeepResearchRequestConfig:
    if not isinstance(raw_config, dict):
        raise ValueError("Deep research requires an explicit config object.")
    try:
        return DeepResearchRequestConfig.model_validate(raw_config)
    except ValidationError as exc:
        details = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        raise ValueError(f"Invalid deep research config: {details}") from exc


def build_research_execution_policy(
    *,
    request_config: DeepResearchRequestConfig,
) -> dict[str, Any]:
    depth_policy = _build_depth_policy(
        request_config.depth,
        manual_max_iterations=request_config.manual_max_iterations,
        manual_subtopics=request_config.manual_subtopics,
    )
    mode_policy = _build_mode_policy(request_config.mode, request_config.depth)

    if request_config.depth == "manual" and request_config.manual_subtopics is not None:
        n = request_config.manual_subtopics
        if mode_policy.get("decompose_mode") == "auto":
            mode_policy["auto_max_subtopics"] = n
        else:
            mode_policy["initial_subtopics"] = n

    planning = {
        "rephrase": {
            "enabled": mode_policy["rephrase_enabled"],
            "max_iterations": mode_policy["rephrase_iterations"],
        },
        "decompose": {
            "mode": mode_policy["decompose_mode"],
            # The pipeline consumes a concrete target count. Auto modes used
            # to pass None here, which `_read_int` converted to the global
            # default (5), silently ignoring quick/standard/deep limits.
            "initial_subtopics": (
                mode_policy["initial_subtopics"]
                if mode_policy["initial_subtopics"] is not None
                else mode_policy["auto_max_subtopics"]
            ),
            "auto_max_subtopics": mode_policy["auto_max_subtopics"],
        },
    }
    researching = {
        "max_iterations": depth_policy["max_iterations"],
        "iteration_mode": depth_policy["iteration_mode"],
        "execution_mode": depth_policy["execution_mode"],
        "max_parallel_topics": depth_policy["max_parallel_topics"],
    }
    reporting = {
        "min_section_length": mode_policy["min_section_length"],
        "report_single_pass_threshold": mode_policy["report_single_pass_threshold"],
        "enable_citation_list": mode_policy["enable_citation_list"],
        "enable_inline_citations": mode_policy["enable_inline_citations"],
        "deduplicate_enabled": mode_policy["deduplicate_enabled"],
        "style": mode_policy["style"],
        "mode": request_config.mode,
        "depth": request_config.depth,
        "format": request_config.report_format,
        "audience": request_config.audience,
        "region": request_config.region,
    }
    researching["source_types"] = request_config.source_types
    researching["date_from"] = (
        request_config.date_from.isoformat() if request_config.date_from else None
    )
    researching["date_to"] = request_config.date_to.isoformat() if request_config.date_to else None
    researching["max_sources"] = request_config.max_sources
    queue = {"max_length": depth_policy["queue_max_length"]}

    return {
        "planning": planning,
        "researching": researching,
        "reporting": reporting,
        "queue": queue,
        "intent": request_config.model_dump(mode="json"),
    }


def build_research_runtime_config(
    *,
    base_config: dict[str, Any],
    request_config: DeepResearchRequestConfig,
    kb_name: str | None,
) -> dict[str, Any]:
    capabilities = (
        base_config.get("capabilities", {})
        if isinstance(base_config.get("capabilities"), dict)
        else {}
    )
    research_root = (
        capabilities.get("research", {}) if isinstance(capabilities.get("research"), dict) else {}
    )
    researching_root = (
        research_root.get("researching", {})
        if isinstance(research_root.get("researching"), dict)
        else {}
    )
    reporting_root = (
        research_root.get("reporting", {})
        if isinstance(research_root.get("reporting"), dict)
        else {}
    )
    rag_root: dict = {}
    policy = build_research_execution_policy(request_config=request_config)

    runtime_config = dict(base_config)
    runtime_config["planning"] = policy["planning"]
    runtime_config["researching"] = {
        **{
            key: researching_root[key]
            for key in (
                "note_agent_mode",
                "tool_timeout",
                "tool_max_retries",
                "paper_search_years_limit",
            )
            if key in researching_root
        },
        **policy["researching"],
    }
    runtime_config["reporting"] = {
        **{key: reporting_root[key] for key in () if key in reporting_root},
        **policy["reporting"],
    }
    runtime_config["queue"] = policy["queue"]
    runtime_config["rag"] = {
        **rag_root,
        "kb_name": kb_name or rag_root.get("kb_name"),
    }
    runtime_config["intent"] = policy["intent"]

    system_cfg = dict(runtime_config.get("system", {}) or {})
    paths_cfg = dict(runtime_config.get("paths", {}) or {})
    system_cfg["output_base_dir"] = paths_cfg.get(
        "research_output_dir",
        "./data/user/workspace/chat/deep_research",
    )
    system_cfg["reports_dir"] = paths_cfg.get(
        "research_reports_dir",
        "./data/user/workspace/chat/deep_research/reports",
    )
    runtime_config["system"] = system_cfg

    return runtime_config


def _build_depth_policy(
    depth: ResearchDepth,
    *,
    manual_max_iterations: int | None = None,
    manual_subtopics: int | None = None,
) -> dict[str, Any]:
    presets: dict[str, dict[str, Any]] = {
        "quick": {
            "max_iterations": 1,
            "iteration_mode": "fixed",
            "execution_mode": "series",
            "max_parallel_topics": 1,
            "queue_max_length": 2,
        },
        "standard": {
            "max_iterations": 3,
            "iteration_mode": "fixed",
            "execution_mode": "series",
            "max_parallel_topics": 1,
            "queue_max_length": 5,
        },
        "deep": {
            "max_iterations": 5,
            "iteration_mode": "flexible",
            "execution_mode": "parallel",
            "max_parallel_topics": 3,
            "queue_max_length": 8,
        },
    }

    if depth == "manual":
        iters = manual_max_iterations or 3
        subtopics = manual_subtopics or 3
        return {
            "max_iterations": iters,
            "iteration_mode": "fixed",
            "execution_mode": "series" if subtopics <= 3 else "parallel",
            "max_parallel_topics": min(subtopics, 3),
            "queue_max_length": subtopics + 2,
        }

    return dict(presets[depth])


def _build_mode_policy(mode: ResearchMode, depth: ResearchDepth) -> dict[str, Any]:
    from cognivoy.agents.research.mode_strategy import get_strategy

    strategy = get_strategy(mode)
    return dict(strategy.build_policy(depth))


__all__ = [
    "DeepResearchRequestConfig",
    "OutlineItem",
    "ResearchDepth",
    "ResearchMode",
    "ResearchReportFormat",
    "ResearchSourceType",
    "build_research_execution_policy",
    "build_research_runtime_config",
    "validate_research_request_config",
]
