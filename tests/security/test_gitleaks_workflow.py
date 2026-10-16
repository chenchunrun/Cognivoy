"""Keep the secret-scan workflow bound to the repository's reviewed rules."""

from pathlib import Path


def test_secret_scan_explicitly_uses_reviewed_gitleaks_configuration():
    root = Path(__file__).resolve().parents[2]
    workflow = (root / ".github" / "workflows" / "security.yml").read_text(encoding="utf-8")

    assert "GITLEAKS_CONFIG: .gitleaks.toml" in workflow
