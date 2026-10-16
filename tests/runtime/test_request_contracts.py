from __future__ import annotations

import pytest

from cognivoy.runtime.request_contracts import (
    get_capability_request_schema,
    validate_capability_config,
    validate_start_turn_payload,
)


def test_start_turn_contract_covers_all_cross_entry_reference_fields() -> None:
    payload = validate_start_turn_payload(
        {
            "type": "start_turn",
            "content": "continue",
            "memory_references": ["profile", "preferences"],
            "skills": ["socratic-tutor"],
            "question_notebook_references": [7],
            "book_references": [{"book_id": "b1", "page_ids": ["p1"]}],
            "learning_context": {
                "project_id": "project-1",
                "task_id": "task-1",
                "objective": "Practice eigenvalues",
            },
        }
    )
    assert payload["memory_references"] == ["profile", "preferences"]
    assert payload["skills"] == ["socratic-tutor"]
    assert payload["learning_context"] == {
        "project_id": "project-1",
        "task_id": "task-1",
        "objective": "Practice eigenvalues",
    }


def test_start_turn_contract_rejects_unknown_fields_and_invalid_memory_slots() -> None:
    with pytest.raises(ValueError, match="unknown"):
        validate_start_turn_payload({"type": "start_turn", "content": "hello", "unknown": True})
    with pytest.raises(ValueError, match="memory_references"):
        validate_start_turn_payload(
            {
                "type": "start_turn",
                "content": "hello",
                "memory_references": ["all-secrets"],
            }
        )
    with pytest.raises(ValueError, match="learning_context"):
        validate_start_turn_payload(
            {
                "type": "start_turn",
                "content": "hello",
                "learning_context": {"project_id": "../escape", "task_id": "task-1"},
            }
        )


def test_deep_solve_public_config_matches_the_prd_contract() -> None:
    config = validate_capability_config(
        "deep_solve",
        {
            "solve_mode": "guided",
            "depth": "deep",
            "answer_format": "step_by_step",
            "max_rounds": 18,
            "total_timeout_seconds": 420,
        },
    )

    assert config == {
        "solve_mode": "guided",
        "depth": "deep",
        "answer_format": "step_by_step",
        "max_rounds": 18,
        "total_timeout_seconds": 420.0,
    }
    schema = get_capability_request_schema("deep_solve")
    assert set(config).issubset(schema["properties"])


@pytest.mark.parametrize(
    "field,value",
    [
        ("solve_mode", "guess"),
        ("depth", "unbounded"),
        ("answer_format", "xml"),
        ("max_rounds", 0),
        ("total_timeout_seconds", 901),
    ],
)
def test_deep_solve_public_config_rejects_unsafe_values(field: str, value: object) -> None:
    with pytest.raises(ValueError):
        validate_capability_config("deep_solve", {field: value})


def test_deep_research_public_config_supports_source_and_report_constraints() -> None:
    config = validate_capability_config(
        "deep_research",
        {
            "mode": "report",
            "depth": "deep",
            "source_types": ["knowledge_base", "papers"],
            "date_from": "2024-01-01",
            "date_to": "2026-01-31",
            "report_format": "literature_review",
            "max_sources": 24,
            "audience": "graduate students",
        },
    )

    assert config["source_types"] == ["knowledge_base", "papers"]
    assert config["date_from"] == "2024-01-01"
    assert config["date_to"] == "2026-01-31"
    assert config["report_format"] == "literature_review"
    assert config["max_sources"] == 24


def test_deep_question_accepts_a_bounded_similar_question_seed() -> None:
    config = validate_capability_config(
        "deep_question",
        {
            "mode": "custom",
            "topic": "linear equations",
            "num_questions": 1,
            "difficulty": "medium",
            "question_types": ["short_answer"],
            "similar_to": {
                "question": "Solve x + 2 = 5",
                "correct_answer": "x = 3",
                "explanation": "Subtract two.",
                "source_refs": [{"type": "book", "id": "page-1"}],
            },
        },
    )

    assert config["similar_to"]["question"] == "Solve x + 2 = 5"
    assert config["similar_to"]["source_refs"] == [{"type": "book", "id": "page-1"}]


@pytest.mark.parametrize(
    "override",
    [
        {"source_types": []},
        {"source_types": ["social_media"]},
        {"date_from": "2026-02-01", "date_to": "2026-01-01"},
        {"max_sources": 0},
        {"max_sources": 101},
    ],
)
def test_deep_research_rejects_unsafe_source_constraints(override: dict) -> None:
    with pytest.raises(ValueError):
        validate_capability_config(
            "deep_research",
            {"mode": "report", "depth": "standard", **override},
        )


def test_visualize_public_config_exposes_actionable_render_constraints() -> None:
    config = validate_capability_config(
        "visualize",
        {
            "render_mode": "manim_video",
            "quality": "high",
            "style_hint": "chalkboard",
            "aspect_ratio": "16:9",
            "theme": "dark",
            "width": 1920,
            "height": 1080,
            "duration_seconds": 45,
            "fps": 30,
            "show_code": True,
            "parameters": {"amplitude": 2, "label": "wave"},
        },
    )

    assert config["duration_seconds"] == 45.0
    assert config["fps"] == 30
    assert config["parameters"] == {"amplitude": 2, "label": "wave"}


@pytest.mark.parametrize(
    "field,value",
    [
        ("width", 100),
        ("height", 9000),
        ("duration_seconds", 0),
        ("fps", 121),
        ("parameters", {"nested": {"unsafe": True}}),
    ],
)
def test_visualize_rejects_unsafe_render_constraints(field: str, value: object) -> None:
    with pytest.raises(ValueError):
        validate_capability_config("visualize", {field: value})
