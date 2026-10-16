#!/usr/bin/env python3
"""Fail when repository content is not ready for a public source release."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
REQUIRED_FILES = (
    "LICENSE",
    "NOTICE",
    "MODIFICATIONS.md",
    "THIRD_PARTY_NOTICES.md",
    "README.md",
    "CONTRIBUTING.md",
    "CODE_OF_CONDUCT.md",
    "SECURITY.md",
    "SUPPORT.md",
    "GOVERNANCE.md",
    "CHANGELOG.md",
    "CITATION.cff",
    "ASSET_POLICY.md",
    "ASSET_PROVENANCE.md",
    "UPSTREAM.md",
)
TEXT_SUFFIXES = {
    "",
    ".cjs",
    ".css",
    ".html",
    ".ini",
    ".js",
    ".json",
    ".md",
    ".mjs",
    ".py",
    ".sh",
    ".toml",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
}
PLACEHOLDERS = ("<your-account>", "ghcr.io/your-account/cognivoy")
THIS_SCRIPT = Path(__file__).resolve()


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [ROOT / item.decode() for item in result.stdout.split(b"\0") if item]


def main() -> int:
    errors: list[str] = []

    for relative in REQUIRED_FILES:
        if not (ROOT / relative).is_file():
            errors.append(f"missing required public file: {relative}")

    for path in tracked_files():
        # The checker necessarily contains the literal sentinel values it searches
        # for. Exclude only this implementation file so real release content is
        # still scanned without the checker reporting its own definitions.
        if path.resolve() == THIS_SCRIPT:
            continue
        if path.suffix.lower() not in TEXT_SUFFIXES or not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for placeholder in PLACEHOLDERS:
            if placeholder in text:
                errors.append(f"release placeholder {placeholder!r}: {path.relative_to(ROOT)}")

    for relative in ("CONTRIBUTING.md",):
        text = (ROOT / relative).read_text(encoding="utf-8")
        if "github.com/HKUDS/DeepTutor/issues" in text:
            errors.append(f"upstream issue tracker used as Cognivoy support: {relative}")

    metadata = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    for field in ("authors", "maintainers", "keywords", "classifiers", "urls"):
        if not metadata.get(field):
            errors.append(f"pyproject.toml is missing project.{field}")

    if errors:
        print("Open-source readiness check failed:", file=sys.stderr)
        for error in errors:
            print(f"- {error}", file=sys.stderr)
        return 1

    print("Open-source readiness checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
