from pathlib import Path

from cognivoy.agents.math_animator.models import SummaryPayload
from cognivoy.agents.math_animator.subtitles import build_webvtt, create_subtitle_asset


def test_webvtt_spreads_narrative_across_animation_duration() -> None:
    text = build_webvtt(["Introduce the equation", "Show the transformation"], 12)
    assert text.startswith("WEBVTT\n")
    assert "00:00:00.000 --> 00:00:06.000" in text
    assert "00:00:06.000 --> 00:00:12.000" in text
    assert "Introduce the equation" in text


def test_create_subtitle_asset_writes_safe_public_vtt(tmp_path: Path) -> None:
    summary = SummaryPayload(
        summary_text="Overview",
        key_points=["First\nstep", "Second --> step"],
    )
    result = create_subtitle_asset(
        base_dir=tmp_path,
        user_data_dir=tmp_path.parent,
        summary=summary,
        duration_seconds=8,
    )
    assert result["url"].startswith("/api/outputs/")
    assert result["language"] == "en"
    content = (tmp_path / "meta" / "captions.vtt").read_text(encoding="utf-8")
    assert "First step" in content
    assert "Second → step" in content
