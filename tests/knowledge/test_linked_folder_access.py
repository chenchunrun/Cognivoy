"""External folder links must respect the authenticated user's workspace."""

import pytest

from cognivoy.knowledge.manager import KnowledgeBaseManager
from cognivoy.multi_user.context import reset_current_user, set_current_user
from cognivoy.multi_user.models import CurrentUser, UserScope
from cognivoy.services.rag.linked_kb import assert_path_allowed


@pytest.fixture
def scoped_user(tmp_path, monkeypatch):
    monkeypatch.delenv("COGNIVOY_LINKED_FOLDER_ROOTS", raising=False)
    root = tmp_path / "user"
    root.mkdir()
    token = set_current_user(
        CurrentUser("alice", "alice", "user", UserScope("user", "alice", root))
    )
    try:
        yield root
    finally:
        reset_current_user(token)


def test_user_can_link_only_own_workspace(scoped_user, tmp_path, monkeypatch):
    outside = tmp_path / "other-user"
    outside.mkdir()
    assert assert_path_allowed(str(scoped_user)) == scoped_user.resolve()
    # A shared operator allowlist must not grant access to other users' data.
    monkeypatch.setenv("COGNIVOY_LINKED_FOLDER_ROOTS", str(tmp_path))
    with pytest.raises(ValueError, match="outside your workspace"):
        assert_path_allowed(str(outside))
    link = scoped_user / "escape"
    link.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="outside your workspace"):
        assert_path_allowed(str(link))


def test_legacy_folder_link_enforces_user_scope(scoped_user, tmp_path):
    manager = KnowledgeBaseManager(base_dir=str(scoped_user / "knowledge_bases"))
    (manager.base_dir / "kb").mkdir()
    manager.register_knowledge_base("kb")
    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(ValueError, match="outside your workspace"):
        manager.link_folder("kb", str(outside))
    assert manager.get_linked_folders("kb") == []


def test_sync_rechecks_previously_registered_pointer(tmp_path, monkeypatch):
    monkeypatch.delenv("COGNIVOY_LINKED_FOLDER_ROOTS", raising=False)
    root = tmp_path / "user"
    manager = KnowledgeBaseManager(base_dir=str(root / "knowledge_bases"))
    (manager.base_dir / "kb").mkdir()
    manager.register_knowledge_base("kb")
    outside = tmp_path / "outside"
    outside.mkdir()
    folder = manager.link_folder("kb", str(outside))
    token = set_current_user(
        CurrentUser("alice", "alice", "user", UserScope("user", "alice", root))
    )
    try:
        with pytest.raises(ValueError, match="outside your workspace"):
            manager.detect_folder_changes("kb", folder["id"])
    finally:
        reset_current_user(token)


def test_admin_can_link_external_folder(tmp_path, monkeypatch):
    monkeypatch.delenv("COGNIVOY_LINKED_FOLDER_ROOTS", raising=False)
    root = tmp_path / "admin"
    outside = tmp_path / "external"
    outside.mkdir()
    token = set_current_user(
        CurrentUser("admin", "admin", "admin", UserScope("admin", "admin", root))
    )
    try:
        assert assert_path_allowed(str(outside)) == outside.resolve()
    finally:
        reset_current_user(token)


@pytest.mark.parametrize("name", ["../outside", "/outside", "..", "folder\\outside"])
def test_connected_kb_names_cannot_create_traversal_entries(tmp_path, name):
    manager = KnowledgeBaseManager(base_dir=str(tmp_path / "kbs"))
    with pytest.raises(ValueError):
        manager.register_linked_kb(name, str(tmp_path), "llamaindex")
    with pytest.raises(ValueError):
        manager.register_obsidian_vault(name, str(tmp_path))
    assert name not in manager.config.get("knowledge_bases", {})


def test_folder_registration_and_collection_reject_external_file_symlink(scoped_user, tmp_path):
    from cognivoy.services.rag.file_routing import FileTypeRouter

    secret = tmp_path / "other-user.md"
    secret.write_text("private", encoding="utf-8")
    (scoped_user / "note.md").symlink_to(secret)
    with pytest.raises(ValueError, match="unsafe symbolic link"):
        assert_path_allowed(str(scoped_user))
    with pytest.raises(ValueError, match="unsafe symbolic link"):
        FileTypeRouter.collect_supported_files(scoped_user, recursive=True)


def test_linked_index_rechecks_symlinks_added_after_registration(scoped_user, tmp_path):
    import json

    from cognivoy.services.rag.index_versioning import list_kb_versions
    from cognivoy.services.rag.kb_paths import resolve_kb_dir

    external = scoped_user / "index"
    external.mkdir()
    assert_path_allowed(str(external))
    base = scoped_user / "kbs"
    base.mkdir()
    (base / "kb_config.json").write_text(
        json.dumps(
            {"knowledge_bases": {"linked": {"type": "linked", "external_path": str(external)}}}
        ),
        encoding="utf-8",
    )
    secret = tmp_path / "secret.json"
    secret.write_text("{}", encoding="utf-8")
    version = external / "version-1"
    version.mkdir()
    (version / "docstore.json").symlink_to(secret)
    with pytest.raises(ValueError, match="unsafe symbolic link"):
        resolve_kb_dir(base, "linked")
    with pytest.raises(ValueError, match="unsafe symbolic link"):
        list_kb_versions(external)


def test_directory_symlink_cannot_hide_unwalked_descendants(scoped_user):
    notes = scoped_user / "notes"
    notes.mkdir()
    (scoped_user / "alias").symlink_to(notes, target_is_directory=True)
    with pytest.raises(ValueError, match="unsafe symbolic link"):
        assert_path_allowed(str(scoped_user))


def test_obsidian_bare_note_lookup_rejects_external_symlink(scoped_user, tmp_path):
    from cognivoy.capabilities.obsidian.vault import VaultError, resolve_note

    secret = tmp_path / "private.md"
    secret.write_text("private", encoding="utf-8")
    (scoped_user / "secret.md").symlink_to(secret)
    with pytest.raises(VaultError, match="escapes the vault"):
        resolve_note(scoped_user, "secret")
