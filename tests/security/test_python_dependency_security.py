"""Keep supported installs above the reviewed dependency security floors."""

from pathlib import Path
import tomllib

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version
import pytest

ROOT = Path(__file__).resolve().parents[2]
FLOORS = {"pyjwt": "2.15.1", "pypdf": "6.20.1", "multidict": "6.9.1", "urllib3": "2.8.0"}
PREVIOUS = {"pyjwt": "2.13.0", "pypdf": "6.16.2", "multidict": "6.7.1", "urllib3": "2.7.0"}


def test_lockfile_security_floors():
    lock = tomllib.loads((ROOT / "uv.lock").read_text())
    versions = {p["name"]: p["version"] for p in lock["package"] if p["name"] in FLOORS}
    for name, floor in FLOORS.items():
        assert Version(versions[name]) >= Version(floor)


def test_install_manifests_reject_previous_vulnerable_versions():
    requirements = []
    for path in (ROOT / "pyproject.toml", ROOT / "packaging/cognivoy-cli/pyproject.toml"):
        project = tomllib.loads(path.read_text())["project"]
        requirements.extend(project["dependencies"])
        for group in project["optional-dependencies"].values():
            requirements.extend(group)
    for path in (ROOT / "requirements").glob("*.txt"):
        requirements.extend(
            line
            for line in path.read_text().splitlines()
            if line.strip() and not line.startswith(("#", "-"))
        )
    for value in requirements:
        req = Requirement(value)
        name = canonicalize_name(req.name)
        if name in FLOORS:
            assert FLOORS[name] in req.specifier, value
            assert PREVIOUS[name] not in req.specifier, value


@pytest.mark.parametrize("invalid", ["expired", "wrong-key", "unsigned"])
def test_jwt_upgrade_preserves_authentication_boundary(monkeypatch, invalid):
    import jwt

    from cognivoy.services import auth

    secret = "test-only-signing-secret-" * 3
    monkeypatch.setattr(auth, "AUTH_SECRET", secret)
    monkeypatch.setattr(auth, "POCKETBASE_ENABLED", False)
    token = auth.create_token("test-user", user_id="test-id")
    assert auth.decode_token(token).username == "test-user"
    claims = {"sub": "test-user", "uid": "test-id"}
    if invalid == "expired":
        claims["exp"] = 1
    key = secret if invalid != "wrong-key" else "wrong-test-secret-" * 4
    algorithm = "HS256"
    if invalid == "unsigned":
        key, algorithm = "", "none"
    assert auth.decode_token(jwt.encode(claims, key, algorithm=algorithm)) is None
