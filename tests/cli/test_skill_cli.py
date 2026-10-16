from pathlib import Path

from typer.testing import CliRunner

from cognivoy.services.skill.hub import (
    HubInstallFile,
    HubInstallOutcome,
    HubInstallPreview,
    HubSkillRef,
    HubVerdict,
)
from cognivoy.services.skill.service import SkillInfo, SkillInstallResult
from cognivoy_cli.main import app


def _preview(*, conflict: bool = False) -> HubInstallPreview:
    return HubInstallPreview(
        ref=HubSkillRef(hub="fake", slug="demo", version="1", display_name="Demo"),
        name="demo",
        description="A reviewed skill",
        files=(HubInstallFile("SKILL.md", 42, True),),
        requirements={"bins": ["git"], "env": ["DEMO_TOKEN"], "network": True},
        verdict=HubVerdict("ok", "verified"),
        conflict=conflict,
        confirmation_digest="digest-1",
    )


def _outcome(tmp_path: Path) -> HubInstallOutcome:
    info = SkillInfo(name="demo", description="A reviewed skill")
    return HubInstallOutcome(
        result=SkillInstallResult(info=info),
        ref=_preview().ref,
        verdict=HubVerdict("ok", "verified"),
    )


def test_skill_install_requires_review_confirmation(monkeypatch, tmp_path: Path) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        "cognivoy.services.skill.hub.preview_hub_install",
        lambda *args, **kwargs: _preview(),
    )
    monkeypatch.setattr(
        "cognivoy.services.skill.hub.install_from_hub",
        lambda *args, **kwargs: calls.append(kwargs) or _outcome(tmp_path),
    )

    result = CliRunner().invoke(app, ["skill", "install", "fake:demo"], input="n\n")

    assert result.exit_code != 0
    assert "Package files" in result.stdout
    assert "DEMO_TOKEN" in result.stdout
    assert calls == []


def test_skill_install_yes_preserves_digest_and_conflict_policy(
    monkeypatch, tmp_path: Path
) -> None:
    calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        "cognivoy.services.skill.hub.preview_hub_install",
        lambda *args, **kwargs: _preview(conflict=True),
    )
    monkeypatch.setattr(
        "cognivoy.services.skill.hub.install_from_hub",
        lambda *args, **kwargs: calls.append(kwargs) or _outcome(tmp_path),
    )

    result = CliRunner().invoke(
        app,
        ["skill", "install", "fake:demo", "--yes", "--conflict", "copy"],
    )

    assert result.exit_code == 0, result.stdout
    assert calls[0]["confirmation_digest"] == "digest-1"
    assert calls[0]["conflict_strategy"] == "copy"
