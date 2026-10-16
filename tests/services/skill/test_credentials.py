import json
from pathlib import Path

from cognivoy.services.skill import credentials


def test_skill_hub_token_is_encrypted_and_identity_never_returns_it(
    tmp_path: Path, monkeypatch
) -> None:
    from cognivoy.multi_user import paths

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    path = tmp_path / "skill_hub_auth.json"
    monkeypatch.setattr(credentials, "_auth_path", lambda: path)

    credentials.store_token("eduhub", "hub-secret", login="ada", name="Ada")

    raw = path.read_text(encoding="utf-8")
    assert "hub-secret" not in raw
    assert json.loads(raw)["_encrypted"] == "cognivoy-aesgcm-v1"
    assert credentials.get_stored_token("eduhub") == "hub-secret"
    assert credentials.get_stored_identity("eduhub") == {"login": "ada", "name": "Ada"}


def test_legacy_skill_token_migrates_on_first_read(tmp_path: Path, monkeypatch) -> None:
    from cognivoy.multi_user import paths

    monkeypatch.setattr(paths, "SYSTEM_ROOT", tmp_path / "system")
    path = tmp_path / "skill_hub_auth.json"
    path.write_text(
        json.dumps({"tokens": {"eduhub": {"token": "legacy", "login": "ada"}}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(credentials, "_auth_path", lambda: path)

    assert credentials.get_stored_token("eduhub") == "legacy"

    raw = path.read_text(encoding="utf-8")
    assert "legacy" not in raw
    assert json.loads(raw)["_encrypted"] == "cognivoy-aesgcm-v1"
