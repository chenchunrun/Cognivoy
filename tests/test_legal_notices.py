"""Distribution-level checks for license and attribution notices."""

import hashlib
from pathlib import Path
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def test_apache_license_is_unmodified_and_notice_preserves_attribution() -> None:
    license_bytes = (ROOT / "LICENSE").read_bytes()
    license_text = license_bytes.decode("utf-8")
    notice_text = (ROOT / "NOTICE").read_text(encoding="utf-8")

    # SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt. The license
    # must stay verbatim; project-specific attribution belongs in NOTICE.
    assert hashlib.sha256(license_bytes).hexdigest() == (
        "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
    )
    assert "Copyright 2025 Data Intelligence Lab, The University of Hong Kong" in notice_text
    assert "Copyright 2026 contributors to this derivative distribution" in notice_text
    assert "https://github.com/HKUDS/DeepTutor" in notice_text
    assert "not affiliated with, sponsored by, or endorsed by" in notice_text
    assert "does not modify the License" in notice_text


def test_python_distribution_declares_apache_license_and_legal_files() -> None:
    metadata = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    assert metadata["project"]["license"] == "Apache-2.0"
    assert metadata["project"]["license-files"] == [
        "LICENSE",
        "NOTICE",
        "MODIFICATIONS.md",
        "THIRD_PARTY_NOTICES.md",
        "ASSET_PROVENANCE.md",
    ]


def test_cli_distribution_points_to_shared_legal_files() -> None:
    metadata = tomllib.loads(
        (ROOT / "packaging" / "cognivoy-cli" / "pyproject.toml").read_text(encoding="utf-8")
    )

    assert metadata["project"]["license"] == "Apache-2.0"
    assert metadata["project"]["license-files"] == [
        "LICENSE",
        "NOTICE",
        "MODIFICATIONS.md",
        "THIRD_PARTY_NOTICES.md",
        "ASSET_PROVENANCE.md",
    ]
    cli_root = ROOT / "packaging" / "cognivoy-cli"
    for name in metadata["project"]["license-files"]:
        assert (cli_root / name).read_bytes() == (ROOT / name).read_bytes()


def test_container_distributions_include_legal_files() -> None:
    required = "COPY LICENSE NOTICE MODIFICATIONS.md THIRD_PARTY_NOTICES.md ASSET_PROVENANCE.md"
    assert required in (ROOT / "Dockerfile").read_text(encoding="utf-8")
    assert required in (ROOT / "Dockerfile.runner").read_text(encoding="utf-8")


def test_python_distribution_excludes_generated_bytecode() -> None:
    metadata = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    excluded = metadata["tool"]["setuptools"]["exclude-package-data"]["*"]
    web_excluded = metadata["tool"]["setuptools"]["exclude-package-data"]["cognivoy_web"]
    assert "**/__pycache__/*" in excluded
    assert "**/*.pyc" in excluded
    assert "__pycache__/*" in web_excluded
    assert (
        "cognivoy_web.__pycache__*" in metadata["tool"]["setuptools"]["packages"]["find"]["exclude"]
    )
    manifest = (ROOT / "MANIFEST.in").read_text(encoding="utf-8")
    assert "global-exclude *.py[cod]" in manifest
    assert "prune cognivoy_web/__pycache__" in manifest


def test_citation_preserves_the_upstream_paper_title() -> None:
    citation = (ROOT / "CITATION.cff").read_text(encoding="utf-8")
    assert 'title: "Cognivoy"' in citation
    assert citation.count('title: "DeepTutor: Towards Agentic Personalized Tutoring"') == 1
    assert "Cognivoy: Towards Agentic Personalized Tutoring" not in citation


def test_readme_and_modification_record_disclaim_upstream_affiliation() -> None:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    modifications = (ROOT / "MODIFICATIONS.md").read_text(encoding="utf-8")
    assert "independently maintained derivative" in readme
    assert "not affiliated" in readme
    assert "HKUDS/DeepTutor" in modifications
    assert "reviewed source snapshot" in modifications
