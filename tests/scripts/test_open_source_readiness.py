"""Regression coverage for repository public-release hygiene."""

from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def test_open_source_readiness_check_passes() -> None:
    result = subprocess.run(
        [sys.executable, "scripts/check_open_source_readiness.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
