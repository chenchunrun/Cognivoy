"""The structured-output boundary for visualization analysis.

An analysis response is a brief, not an artifact. Formatting wrappers can be
removed, but missing or malformed structured output must remain an explicit
failure for the capability to handle before it attempts real generation.
"""

from __future__ import annotations

import json
import re
from typing import get_args

from pydantic import ValidationError

from cognivoy.agents._shared.json_output import extract_json_object

from .models import RenderType, VisualGenre, VisualizationAnalysis

MAX_ANALYSIS_CHARS = 64_000
_FIXED_RENDER_TYPES = {"svg", "chartjs", "mermaid", "html"}


class VisualizationAnalysisError(RuntimeError):
    """Safe, stable classification with no retained provider response."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(f"Visualization analysis failed ({reason}).")


def parse_visualization_analysis(
    raw: str | None, *, render_mode: str = "auto"
) -> VisualizationAnalysis:
    """Parse one brief, preserving explicit user routing and existing defaults.

    JSON objects, fenced JSON and a JSON object wrapped in prose are supported
    using the shared extractor. Valid non-object JSON is not reinterpreted by
    extracting a nested object. Optional descriptive fields keep their model
    defaults; only actual schema violations fail validation.
    """
    if raw is None or isinstance(raw, str) and not raw.strip():
        raise VisualizationAnalysisError("empty_analysis")
    if not isinstance(raw, str):
        raise VisualizationAnalysisError("invalid_analysis_schema")
    if len(raw) > MAX_ANALYSIS_CHARS:
        raise VisualizationAnalysisError("analysis_output_limit")

    candidate = raw.strip()
    fence = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", candidate, re.IGNORECASE)
    if fence:
        candidate = fence.group(1)
    try:
        payload = json.loads(candidate)
    except json.JSONDecodeError:
        try:
            payload = extract_json_object(candidate)
        except (ValueError, RecursionError):
            raise VisualizationAnalysisError("non_json_analysis") from None
    except (ValueError, RecursionError):
        raise VisualizationAnalysisError("invalid_analysis_schema") from None

    if not isinstance(payload, dict):
        raise VisualizationAnalysisError("invalid_analysis_schema")

    # Preserve the established tolerance for invented string enum labels, but
    # do not let the model's compatibility validator turn arrays/objects into
    # an apparently valid enum or log arbitrary provider content.
    for key in ("render_type", "visual_genre"):
        if key in payload and not isinstance(payload[key], str):
            raise VisualizationAnalysisError("invalid_analysis_schema")
    if render_mode in _FIXED_RENDER_TYPES:
        payload = {**payload, "render_type": render_mode}
    elif "render_type" in payload and payload["render_type"] not in get_args(RenderType):
        payload = {**payload, "render_type": "svg"}
    if "visual_genre" in payload and payload["visual_genre"] not in get_args(VisualGenre):
        payload = {**payload, "visual_genre": ""}

    try:
        result = VisualizationAnalysis.model_validate(payload, strict=True)
    except ValidationError:
        # Pydantic's exception contains the input value. Never expose or retain
        # it as the displayed failure/cause of this structured-output boundary.
        raise VisualizationAnalysisError("invalid_analysis_schema") from None

    if render_mode == "figure" and result.render_type not in {"svg", "chartjs", "mermaid"}:
        result.render_type = "svg"
    return result
