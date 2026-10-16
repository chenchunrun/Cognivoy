"""Parsing helpers shared by agents that consume structured model output."""

from __future__ import annotations

import json
import re
from typing import Any


def extract_json_object(text: str) -> dict[str, Any]:
    """Extract the first usable JSON object from raw model output."""
    raw = (text or "").strip()
    if not raw:
        return {}

    fenced = re.findall(r"```(?:json)?\s*([\s\S]*?)\s*```", raw)
    for candidate in [*fenced, raw]:
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            parsed = _decode_first_json_object(candidate)
            if parsed is not None:
                return parsed

    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        snippet = raw[start : end + 1]
        try:
            return json.loads(snippet)
        except json.JSONDecodeError:
            parsed = _decode_first_json_object(snippet)
            if parsed is not None:
                return parsed

    raise json.JSONDecodeError("No JSON object found", raw, 0)


def _decode_first_json_object(text: str) -> dict[str, Any] | None:
    decoder = json.JSONDecoder()
    stripped = (text or "").lstrip()
    if not stripped:
        return None

    starts = [0, *(match.start() for match in re.finditer(r"\{", stripped))]

    found: dict[str, Any] | None = None
    for start in dict.fromkeys(starts):
        try:
            parsed, _end = decoder.raw_decode(stripped[start:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            # Reasoning wrappers sometimes contain small schema/example
            # objects before the real response. The final decodable object is
            # the model's answer in every supported structured-output prompt.
            found = parsed
    return found


__all__ = ["extract_json_object"]
