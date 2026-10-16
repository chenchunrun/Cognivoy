"""Deterministic WebVTT captions for rendered math animations."""

from __future__ import annotations

from pathlib import Path
import re

from .models import SummaryPayload


def _timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{millis:03d}"


def _safe_line(value: str) -> str:
    return re.sub(r"\s+", " ", value.replace("-->", "→")).strip()[:500]


def build_webvtt(lines: list[str], duration_seconds: float) -> str:
    cues = [_safe_line(line) for line in lines if _safe_line(line)]
    if not cues:
        return "WEBVTT\n"
    duration = max(float(duration_seconds or 0), float(len(cues)) * 2.0)
    interval = duration / len(cues)
    body = ["WEBVTT", ""]
    for index, cue in enumerate(cues):
        start = index * interval
        end = duration if index == len(cues) - 1 else (index + 1) * interval
        body.extend([str(index + 1), f"{_timestamp(start)} --> {_timestamp(end)}", cue, ""])
    return "\n".join(body)


def create_subtitle_asset(
    *,
    base_dir: Path,
    user_data_dir: Path,
    summary: SummaryPayload,
    duration_seconds: float,
    language: str = "en",
) -> dict[str, str]:
    lines = list(getattr(summary, "key_points", None) or [])
    summary_text = str(getattr(summary, "summary_text", "") or "")
    if not lines and summary_text:
        lines = [summary_text]
    meta_dir = base_dir / "meta"
    meta_dir.mkdir(parents=True, exist_ok=True)
    target = meta_dir / "captions.vtt"
    target.write_text(build_webvtt(lines, duration_seconds), encoding="utf-8")
    relative = target.resolve().relative_to(user_data_dir.resolve())
    return {
        "url": f"/api/outputs/{relative.as_posix()}",
        "language": language if language in {"en", "zh"} else "en",
        "filename": target.name,
    }


__all__ = ["build_webvtt", "create_subtitle_asset"]
