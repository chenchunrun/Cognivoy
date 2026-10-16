"""Reject user-facing remnants of names retired before Cognivoy."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RETIRED_BRANDS = ("OpenMentor",)
TEXT_SUFFIXES = {".md", ".mdx", ".rst", ".txt", ".tsx", ".json", ".yaml", ".yml"}
EXCLUDED_PARTS = {".git", ".next", ".next-cognivoy", "node_modules", "test-results"}
EXCLUDED_FILES = {ROOT / "AGENTS.md", ROOT / "web" / "AGENTS.md", ROOT / "web" / "CLAUDE.md"}
ALLOWED_FRAGMENTS = (
    "github.com/HKUDS/DeepTutor",
    "HKUDS%2FDeepTutor",
    "repo=HKUDS/DeepTutor",
    "DeepTutor: Towards Agentic Personalized Tutoring",
)


def main() -> int:
    violations: list[str] = []
    roots = [
        ROOT / "README.md",
        ROOT / "CONTRIBUTING.md",
        ROOT / "docs",
        ROOT / "assets" / "README",
        ROOT / "cognivoy_cli" / "README.md",
        ROOT / "web",
    ]
    for root in roots:
        paths = [root] if root.is_file() else root.rglob("*") if root.exists() else []
        for path in paths:
            if (
                not path.is_file()
                or path in EXCLUDED_FILES
                or path.suffix.lower() not in TEXT_SUFFIXES
            ):
                continue
            if any(part in EXCLUDED_PARTS for part in path.parts):
                continue
            try:
                lines = path.read_text(encoding="utf-8").splitlines()
            except UnicodeDecodeError:
                continue
            for number, line in enumerate(lines, start=1):
                visible = line
                for fragment in ALLOWED_FRAGMENTS:
                    visible = visible.replace(fragment, "")
                if any(brand in visible for brand in RETIRED_BRANDS):
                    violations.append(f"{path.relative_to(ROOT)}:{number}: {line.strip()}")
    if violations:
        print("Retired user-facing brand references found:")
        print("\n".join(violations))
        return 1
    print("Brand check OK: user-facing surfaces use Cognivoy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
