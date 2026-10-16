from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys


def test_api_import_keeps_optional_heavy_dependencies_cold() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    probe = """
import json
import sys

import cognivoy.api.main  # noqa: F401

heavy_roots = {
    "anthropic",
    "docx",
    "fitz",
    "graphrag",
    "llama_index",
    "matplotlib",
    "networkx",
    "numpy",
    "openpyxl",
    "pandas",
    "pptx",
    "pypdf",
}
loaded = sorted(name for name in heavy_roots if name in sys.modules)
print("COGNIVOY_COLD_IMPORT_RESULT=" + json.dumps(loaded))
"""

    result = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=repo_root,
        capture_output=True,
        check=True,
        text=True,
    )

    # Startup diagnostics may use stdout depending on the isolated runtime's
    # logging settings. Parse our explicit probe, not incidental log lines.
    marker = "COGNIVOY_COLD_IMPORT_RESULT="
    results = [
        line.removeprefix(marker) for line in result.stdout.splitlines() if line.startswith(marker)
    ]
    assert len(results) == 1, "Cold-import probe did not return exactly one result"
    assert json.loads(results[0]) == []
