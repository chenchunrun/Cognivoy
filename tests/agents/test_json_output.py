from __future__ import annotations

from cognivoy.agents._shared.json_output import extract_json_object


def test_extract_json_object_uses_final_object_after_reasoning_examples() -> None:
    raw = (
        '<think>Return a shape like {"title": "example"}, then finish.</think>\n'
        '{"title": "Area proof", "scene_outline": ["draw square"]}'
    )

    assert extract_json_object(raw) == {
        "title": "Area proof",
        "scene_outline": ["draw square"],
    }


def test_extract_json_object_skips_unbalanced_reasoning_braces() -> None:
    raw = '<think>Considering { an unfinished object...</think>\n{"ready": true}'

    assert extract_json_object(raw) == {"ready": True}
