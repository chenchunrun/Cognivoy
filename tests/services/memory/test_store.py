from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from cognivoy.services.memory import paths, store
from cognivoy.services.memory.consolidator.meta import save_l2_meta
from cognivoy.services.memory.consolidator.versions import entity_version
from cognivoy.services.memory.snapshot.entity import Entity
from cognivoy.services.memory.store import (
    MemoryStore,
    migrate_partner_surface_if_needed,
    migrate_v1_if_needed,
)
from cognivoy.services.memory.trace import TraceEvent


@pytest.fixture
def tmp_memory(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point ``paths.memory_root`` at an isolated tmp dir."""
    root = tmp_path / "memory"
    monkeypatch.setattr(paths, "memory_root", lambda: root)
    paths.ensure_dirs()
    # Reset the singleton so each test gets a fresh store with its own locks.
    monkeypatch.setattr(store, "_singleton", None)
    return root


def _run(coro):
    return asyncio.run(coro)


def test_read_l3_concat_empty(tmp_memory: Path) -> None:
    s = MemoryStore()
    out = s.read_l3_concat()
    assert "(No memory available" in out


def test_read_l3_concat_joins_present_slots(tmp_memory: Path) -> None:
    (tmp_memory / "L3" / "profile.md").write_text("# User profile\n\n## Identity\n- (none)\n")
    (tmp_memory / "L3" / "preferences.md").write_text("# Preferences\n\n## Style\n- terse\n")
    out = MemoryStore().read_l3_concat()
    assert "# User profile" in out
    assert "# Preferences" in out
    assert "---" in out
    # No "no memory" sentinel when something is present.
    assert "(No memory available" not in out


def test_read_l3_selected_respects_explicit_scope_and_summary_alias(tmp_memory: Path) -> None:
    (tmp_memory / "L3" / "profile.md").write_text("# Private profile\n")
    (tmp_memory / "L3" / "recent.md").write_text("# Recent learning\n")
    (tmp_memory / "L3" / "preferences.md").write_text("# Preferences\n")

    selected = MemoryStore().read_l3_selected(["summary"])

    assert "# Recent learning" in selected
    assert "# Private profile" not in selected
    assert "# Preferences" not in selected


def test_overwrite_and_read_doc_roundtrip(tmp_memory: Path) -> None:
    s = MemoryStore()
    md = (
        "# Chat memory\n\n"
        "## Misconceptions\n"
        "- Misreads quantifier order[^m_01HZK4ABCDEFGHJKMNPQRSTVWX]\n\n"
        "---\n\n"
        "[^m_01HZK4ABCDEFGHJKMNPQRSTVWX]: chat:01HZK4AAAAAAAAAAAAAAAAAAAA\n"
    )
    _run(s.overwrite_doc("L2", "chat", md))
    doc = s.read_doc("L2", "chat")
    assert doc.title == "Chat memory"
    assert len(doc.all_entries()) == 1


def test_delete_entry_removes_from_persisted_doc(tmp_memory: Path) -> None:
    s = MemoryStore()
    md = (
        "# Chat memory\n\n"
        "## Misconceptions\n"
        "- A[^m_01HZK4ABCDEFGHJKMNPQRSTVWX]\n"
        "- B[^m_01HZK5ABCDEFGHJKMNPQRSTVWX]\n\n"
        "---\n\n"
        "[^m_01HZK4ABCDEFGHJKMNPQRSTVWX]: chat:01HZK4AAAAAAAAAAAAAAAAAAAA\n"
        "[^m_01HZK5ABCDEFGHJKMNPQRSTVWX]: chat:01HZK5BBBBBBBBBBBBBBBBBBBB\n"
    )
    _run(s.overwrite_doc("L2", "chat", md))
    ok = _run(s.delete_entry("L2", "chat", "m_01HZK4ABCDEFGHJKMNPQRSTVWX"))
    assert ok
    doc = s.read_doc("L2", "chat")
    assert len(doc.all_entries()) == 1
    assert doc.all_entries()[0].id == "m_01HZK5ABCDEFGHJKMNPQRSTVWX"


def test_delete_entry_is_recoverable_and_preserves_evidence(tmp_memory: Path) -> None:
    s = MemoryStore()
    entry_id = "m_01HZK4ABCDEFGHJKMNPQRSTVWX"
    md = (f"# Chat memory\n\n## Misconceptions\n- Reverses the inequality[^${entry_id}]\n").replace(
        "[^$", "[^"
    ) + f"\n---\n\n[^{entry_id}]: chat:turn-1\n"
    _run(s.overwrite_doc("L2", "chat", md))

    assert _run(s.delete_entry("L2", "chat", entry_id)) is True
    deleted = s.list_deleted_entries(layer="L2", key="chat")
    assert deleted[0]["entry"] == {
        "id": entry_id,
        "section": "Misconceptions",
        "text": "Reverses the inequality",
        "refs": ["chat:turn-1"],
    }

    assert _run(s.restore_deleted_entry("L2", "chat", entry_id)) is True
    restored = s.read_doc("L2", "chat").find(entry_id)
    assert restored is not None
    assert restored.refs == ["chat:turn-1"]
    assert s.list_deleted_entries(layer="L2", key="chat") == []


def test_emit_respects_collection_switch(tmp_memory: Path, monkeypatch) -> None:
    import cognivoy.services.memory.settings as settings_mod
    from cognivoy.services.memory.settings import CollectionSettings, MemorySettings

    monkeypatch.setattr(
        settings_mod,
        "load_memory_settings",
        lambda: MemorySettings(collection=CollectionSettings(enabled=False, auto_capture=False)),
    )
    event = TraceEvent.new("chat", "turn_completed", {"summary": "do not store"})
    _run(MemoryStore().emit(event))
    assert list((tmp_memory / "trace" / "chat").glob("*.jsonl")) == []


def test_emit_prunes_only_expired_trace_days(tmp_memory: Path, monkeypatch) -> None:
    import cognivoy.services.memory.settings as settings_mod
    from cognivoy.services.memory.settings import CollectionSettings, MemorySettings

    monkeypatch.setattr(
        settings_mod,
        "load_memory_settings",
        lambda: MemorySettings(
            collection=CollectionSettings(retention_days=30),
        ),
    )
    trace_dir = tmp_memory / "trace" / "chat"
    today = datetime.now(UTC).date()
    expired = trace_dir / f"{today - timedelta(days=31)}.jsonl"
    retained = trace_dir / f"{today - timedelta(days=30)}.jsonl"
    malformed = trace_dir / "notes.jsonl"
    expired.write_text("expired\n", encoding="utf-8")
    retained.write_text("retained\n", encoding="utf-8")
    malformed.write_text("leave me alone\n", encoding="utf-8")

    event = TraceEvent.new("chat", "turn_completed", {"summary": "stored"})
    _run(MemoryStore().emit(event))

    assert not expired.exists()
    assert retained.exists()
    assert malformed.exists()
    assert (trace_dir / f"{datetime.now(UTC).date()}.jsonl").exists()


def test_find_conflicts_requires_shared_valid_l2_evidence(tmp_memory: Path) -> None:
    s = MemoryStore()
    evidence_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    left_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWY"
    right_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWZ"
    _run(
        s.overwrite_doc(
            "L2",
            "chat",
            (
                "# Chat\n\n## Facts\n"
                f"- Learner asked for concise answers <!--{evidence_id}-->\n\n"
                "---\n\n[^1]: chat:turn-1\n"
            ),
        )
    )
    # Use the legacy format here so the shared L2 id is unambiguous in the
    # fixture; the production parser normalizes it on the next write.
    _run(
        s.overwrite_doc(
            "L3",
            "profile",
            (
                "# Profile\n\n## Communication\n"
                f"- Prefers concise answers[^{left_id}]\n"
                f"- Prefers detailed answers[^{right_id}]\n\n"
                "---\n\n"
                f"[^{left_id}]: {evidence_id}, missing-evidence\n"
                f"[^{right_id}]: {evidence_id}\n"
            ),
        )
    )

    conflicts = s.find_conflicts()

    assert len(conflicts) == 1
    conflict = conflicts[0]
    assert conflict["id"] == f"L3:profile:{left_id}:{right_id}"
    assert conflict["reason"] == "shared_evidence_distinct_claims"
    assert conflict["shared_refs"] == [evidence_id]
    assert conflict["left"]["valid_ref_count"] == 1
    assert conflict["left"]["ref_count"] == 2
    assert conflict["left"]["confidence"] == 0.5
    assert conflict["right"]["confidence"] == 1.0


def test_resolve_conflict_merge_is_atomic_soft_deletes_and_audits(
    tmp_memory: Path,
) -> None:
    s = MemoryStore()
    evidence_a = "m_01HZK1ABCDEFGHJKMNPQRSTVWX"
    evidence_b = "m_01HZK1ABCDEFGHJKMNPQRSTVWY"
    left_id = "m_01HZK1ABCDEFGHJKMNPQRSTVWZ"
    right_id = "m_01HZK1ABCDEFGHJKMNPQRSTVV0"
    _run(
        s.overwrite_doc(
            "L3",
            "profile",
            (
                "# Profile\n\n## Communication\n"
                f"- Concise[^{left_id}]\n"
                f"- Detailed[^{right_id}]\n\n---\n\n"
                f"[^{left_id}]: {evidence_a}\n"
                f"[^{right_id}]: {evidence_a}, {evidence_b}\n"
            ),
        )
    )

    result = _run(
        s.resolve_conflict(
            layer="L3",
            key="profile",
            left_id=left_id,
            right_id=right_id,
            action="merge",
            merged_text="Prefers concise answers first, with details on request",
            reason="User reconciled both observations",
        )
    )

    assert result["action"] == "merge"
    doc = s.read_doc("L3", "profile")
    merged = doc.find(left_id)
    assert merged is not None
    assert merged.text == "Prefers concise answers first, with details on request"
    assert merged.refs == [evidence_a, evidence_b]
    assert doc.find(right_id) is None
    deleted = s.list_deleted_entries(layer="L3", key="profile")
    assert deleted[0]["entry"]["id"] == right_id
    assert deleted[0]["reason"] == "conflict_resolution:merge"
    audit = s.list_conflict_audit()
    assert audit[-1]["reason"] == "User reconciled both observations"
    assert audit[-1]["kept_ids"] == [left_id]


def test_write_preference_add(tmp_memory: Path) -> None:
    s = MemoryStore()
    report = _run(
        s.write_preference(
            op="add",
            text="prefers concise answers",
            trace_id="chat:01HZK4AAAAAAAAAAAAAAAAAAAA",
        )
    )
    assert report.accepted
    doc = s.read_doc("L3", "preferences")
    assert len(doc.all_entries()) == 1
    assert doc.all_entries()[0].text == "prefers concise answers"


def test_write_preference_add_is_idempotent(tmp_memory: Path) -> None:
    # Issue #647: re-adding an identical preference (even with different case /
    # whitespace) must not create a duplicate record, since preferences.md is
    # never auto-consolidated.
    s = MemoryStore()
    first = _run(
        s.write_preference(
            op="add",
            text="prefers concise answers",
            trace_id="chat:01HZK4AAAAAAAAAAAAAAAAAAAA",
        )
    )
    first_id = first.results[0].entry_id
    second = _run(
        s.write_preference(
            op="add",
            text="  Prefers   concise   answers ",
            trace_id="chat:01HZK5BBBBBBBBBBBBBBBBBBBB",
        )
    )
    assert second.accepted
    assert second.results[0].detail == "duplicate"
    assert second.results[0].entry_id == first_id  # points at the original
    doc = s.read_doc("L3", "preferences")
    assert len(doc.all_entries()) == 1  # no duplicate appended


def test_write_preference_edit(tmp_memory: Path) -> None:
    s = MemoryStore()
    add_report = _run(
        s.write_preference(
            op="add",
            text="prefers concise",
            trace_id="chat:01HZK4AAAAAAAAAAAAAAAAAAAA",
        )
    )
    new_id = add_report.results[0].entry_id
    assert new_id

    edit_report = _run(
        s.write_preference(
            op="edit",
            text="prefers concise but with examples",
            target_id=new_id,
            trace_id="chat:01HZK5BBBBBBBBBBBBBBBBBBBB",
        )
    )
    assert edit_report.accepted
    doc = s.read_doc("L3", "preferences")
    entry = doc.find(new_id)
    assert entry is not None
    assert entry.text == "prefers concise but with examples"
    assert entry.refs == ["chat:01HZK5BBBBBBBBBBBBBBBBBBBB"]


def test_write_preference_edit_without_target_fails(tmp_memory: Path) -> None:
    report = _run(
        MemoryStore().write_preference(
            op="edit",
            text="x",
            trace_id="chat:01HZK4AAAAAAAAAAAAAAAAAAAA",
        )
    )
    assert not report.accepted
    assert "target_id" in report.reason


def test_update_l3_rejects_preferences_slot(tmp_memory: Path) -> None:
    with pytest.raises(ValueError, match="preferences.md is not auto-consolidated"):
        _run(MemoryStore().update_l3("preferences"))


def test_emit_appends_trace_event(tmp_memory: Path) -> None:
    event = TraceEvent.new(
        "chat",
        "turn",
        {"user": "hi", "assistant": "hello"},
        session_id="sess_1",
    )
    _run(MemoryStore().emit(event))
    files = list((tmp_memory / "trace" / "chat").glob("*.jsonl"))
    assert len(files) == 1
    contents = files[0].read_text(encoding="utf-8").strip().splitlines()
    assert len(contents) == 1
    assert "sess_1" in contents[0]


def test_overview_reports_all_layers(tmp_memory: Path) -> None:
    rows = MemoryStore().overview()
    keys = {(r.layer, r.key) for r in rows}
    for surface in paths.SURFACES:
        assert ("L2", surface) in keys
    for slot in paths.L3_SLOTS:
        assert ("L3", slot) in keys
    # All start as exists=False, entry_count=0.
    for r in rows:
        assert not r.exists
        assert r.entry_count == 0


def test_overview_backlog_uses_same_version_cursor_as_consolidator(
    tmp_memory: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entity = Entity(
        id="session-1",
        label="Conversation",
        ts="2026-08-17T00:00:00Z",
        content="first version",
        fingerprint="fp-1",
    )
    current = [entity]
    monkeypatch.setattr(
        "cognivoy.services.memory.snapshot.read_snapshot",
        lambda surface: current if surface == "chat" else [],
    )
    memory_store = MemoryStore()
    rows = {(row.layer, row.key): row for row in memory_store.overview()}
    assert rows[("L2", "chat")].backlog == 1

    save_l2_meta(
        "chat",
        seen_entity_versions={"chat:session-1": entity_version(entity)},
    )
    rows = {(row.layer, row.key): row for row in memory_store.overview()}
    assert rows[("L2", "chat")].backlog == 0

    current[0] = Entity(
        id="session-1",
        label="Conversation",
        ts="2026-08-17T00:00:00Z",
        content="modified version",
        fingerprint="fp-2",
    )
    rows = {(row.layer, row.key): row for row in memory_store.overview()}
    assert rows[("L2", "chat")].backlog == 1


def test_migrate_v1_moves_loose_files(tmp_memory: Path) -> None:
    (tmp_memory / "PROFILE.md").write_text("v1 profile content")
    (tmp_memory / "SUMMARY.md").write_text("v1 summary content")
    (tmp_memory / "stray.md").write_text("untracked")

    backup = migrate_v1_if_needed()
    assert backup is not None
    assert backup.parent == tmp_memory / "backup"
    assert (backup / "PROFILE.md").read_text() == "v1 profile content"
    assert (backup / "SUMMARY.md").read_text() == "v1 summary content"
    assert (backup / "stray.md").read_text() == "untracked"
    assert not (tmp_memory / "PROFILE.md").exists()
    assert not (tmp_memory / "SUMMARY.md").exists()


def test_migrate_v1_noop_when_clean(tmp_memory: Path) -> None:
    # Only v2 dirs present; nothing to migrate.
    assert migrate_v1_if_needed() is None
    assert not (tmp_memory / "backup").exists()


def test_migrate_v1_preserves_v2_dirs(tmp_memory: Path) -> None:
    (tmp_memory / "PROFILE.md").write_text("v1")
    # Pre-existing v2 doc — must not be moved.
    l2_chat = tmp_memory / "L2" / "chat.md"
    l2_chat.write_text("# v2 doc\n")

    backup = migrate_v1_if_needed()
    assert backup is not None
    assert l2_chat.exists()
    assert l2_chat.read_text() == "# v2 doc\n"
    assert (backup / "PROFILE.md").exists()


def test_migrate_partner_surface_renames_artifacts(tmp_memory: Path) -> None:
    import json

    l2 = tmp_memory / "L2"
    (l2 / "tutorbot.md").write_text(
        "# Tutorbot memory\n\n"
        "## Themes\n"
        "- Engages with a tutorbot named Frank[^m_01HZK4ABCDEFGHJKMNPQRSTVWX]\n\n"
        "---\n\n"
        "[^m_01HZK4ABCDEFGHJKMNPQRSTVWX]: tutorbot:frank:web_s1\n",
        encoding="utf-8",
    )
    (l2 / "tutorbot.meta.json").write_text(
        json.dumps({"seen_entity_refs": ["tutorbot:frank:web_s1"]}), encoding="utf-8"
    )
    (tmp_memory / "snapshot" / "tutorbot").mkdir(parents=True)
    (tmp_memory / "snapshot" / "tutorbot" / "state.json").write_text("{}", encoding="utf-8")
    (tmp_memory / "trace" / "tutorbot").mkdir(parents=True, exist_ok=True)
    (tmp_memory / "L3").mkdir(exist_ok=True)
    (tmp_memory / "L3" / "profile.meta.json").write_text(
        json.dumps({"seen_l2_entry_ids": {"tutorbot": ["m_01HZK4ABCDEFGHJKMNPQRSTVWX"]}}),
        encoding="utf-8",
    )

    assert migrate_partner_surface_if_needed() is True

    new_md = l2 / "partner.md"
    assert new_md.exists()
    assert not (l2 / "tutorbot.md").exists()
    text = new_md.read_text(encoding="utf-8")
    # Footnote ref prefix and bare prose word both rewritten.
    assert "partner:frank:web_s1" in text
    assert "a partner named Frank" in text
    assert "tutorbot" not in text.lower()

    meta = json.loads((l2 / "partner.meta.json").read_text(encoding="utf-8"))
    assert meta["seen_entity_refs"] == ["partner:frank:web_s1"]

    assert (tmp_memory / "snapshot" / "partner").is_dir()
    assert not (tmp_memory / "snapshot" / "tutorbot").exists()
    assert (tmp_memory / "trace" / "partner").is_dir()

    l3 = json.loads((tmp_memory / "L3" / "profile.meta.json").read_text(encoding="utf-8"))
    assert "partner" in l3["seen_l2_entry_ids"]
    assert "tutorbot" not in l3["seen_l2_entry_ids"]

    # Idempotent: a second run finds nothing tutorbot-shaped.
    assert migrate_partner_surface_if_needed() is False


def test_migrate_partner_surface_noop_when_clean(tmp_memory: Path) -> None:
    assert migrate_partner_surface_if_needed() is False
