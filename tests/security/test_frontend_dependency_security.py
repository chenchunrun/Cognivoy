"""Pin the frontend packages outside their published vulnerable ranges."""

import json
from pathlib import Path


def _version_at_least(version: str, minimum: str) -> bool:
    return tuple(map(int, version.split(".")[:3])) >= tuple(map(int, minimum.split(".")[:3]))


def test_frontend_lockfile_uses_patched_low_severity_dependencies():
    root = Path(__file__).resolve().parents[2]
    lockfile = json.loads((root / "web" / "package-lock.json").read_text(encoding="utf-8"))
    packages = lockfile["packages"]

    assert _version_at_least(packages["node_modules/dompurify"]["version"], "3.4.16")
    katex_packages = {
        path: package["version"]
        for path, package in packages.items()
        if path.endswith("node_modules/katex")
    }
    assert katex_packages
    assert all(_version_at_least(version, "0.18.2") for version in katex_packages.values())
    assert _version_at_least(packages["node_modules/mermaid"]["version"], "12.2.0")


def test_iframe_math_runtime_uses_patched_katex_release():
    root = Path(__file__).resolve().parents[2]
    iframe_html = (root / "web" / "lib" / "iframe-html.ts").read_text(encoding="utf-8")

    assert "katex@0.18.2" in iframe_html
    assert "katex@0.16.9" not in iframe_html
