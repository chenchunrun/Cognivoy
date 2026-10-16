"""Keep the unpatched NLTK model-artifact APIs outside Cognivoy's entry points.

PYSEC-2026-3740 remains an upstream exception, not a patched dependency. This
gate prevents accidentally introducing a direct model-path API while that
exception is in force. It does not claim to sandbox arbitrary Python programs.
"""

import ast
from pathlib import Path


def test_product_does_not_import_nltk_model_apis():
    root = Path(__file__).resolve().parents[2]
    violations = []
    for package in (root / "cognivoy", root / "cognivoy_cli"):
        for path in package.rglob("*.py"):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                names = []
                if isinstance(node, ast.Import):
                    names = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                elif (
                    isinstance(node, ast.Call)
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                    and isinstance(node.args[0].value, str)
                ):
                    # Covers import_module/__import__ with literal targets;
                    # also deliberately prevents literal NLTK plugin targets.
                    names = [node.args[0].value]
                if any(name == "nltk" or name.startswith("nltk.") for name in names):
                    violations.append(f"{path.relative_to(root)}:{node.lineno}")
    assert not violations, "NLTK direct access requires a security review: " + ", ".join(violations)
