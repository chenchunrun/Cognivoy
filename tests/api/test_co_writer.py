"""Co-Writer backend tests: doc id validation, storage CRUD, history limits."""

from pathlib import Path

from fastapi import HTTPException
import pytest

from cognivoy.api.routers import co_writer as co_writer_router
from cognivoy.api.routers.co_writer import UpdateDocumentRequest, _validate_doc_id
from cognivoy.co_writer import edit_agent
from cognivoy.co_writer.storage import (
    CoWriterMergeConflict,
    CoWriterRevisionConflict,
    CoWriterStorage,
)


class _StubPathService:
    def __init__(self, root: Path):
        self.root = root

    def get_co_writer_dir(self) -> Path:
        return self.root

    def get_co_writer_history_file(self) -> Path:
        return self.root / "history.json"

    def get_co_writer_tool_calls_dir(self) -> Path:
        return self.root / "tool_calls"

    def get_co_writer_docs_dir(self) -> Path:
        return self.root / "documents"

    def get_co_writer_doc_root(self, doc_id: str) -> Path:
        return self.get_co_writer_docs_dir() / f"doc_{doc_id}"

    def get_co_writer_doc_manifest(self, doc_id: str) -> Path:
        return self.get_co_writer_doc_root(doc_id) / "manifest.json"


# ── doc_id validation ────────────────────────────────────────────────────


def test_validate_doc_id_accepts_generated_ids():
    assert _validate_doc_id("a1b2c3d4e5f6") == "a1b2c3d4e5f6"


@pytest.mark.parametrize(
    "bad",
    [
        "../x",
        "a/../../etc",
        "a1b2c3d4e5f6/../../x",
        "doc_1; rm -rf",
        "A1B2C3D4E5F6",
        "",
        "a" * 40,
    ],
)
def test_validate_doc_id_rejects_traversal_and_junk(bad):
    with pytest.raises(HTTPException) as exc:
        _validate_doc_id(bad)
    assert exc.value.status_code == 404


# ── storage CRUD ─────────────────────────────────────────────────────────


def test_storage_crud_roundtrip(tmp_path):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))

    doc = storage.create_document(title=None, content="# Hello\nWorld")
    assert doc.title == "Hello"
    assert _validate_doc_id(doc.id) == doc.id

    loaded = storage.load_document(doc.id)
    assert loaded is not None
    assert loaded.content.startswith("# Hello")

    # Explicit titles stick across content updates.
    updated = storage.update_document(doc.id, content="# Renamed\nBody")
    assert updated is not None
    assert updated.title == "Hello"

    assert storage.delete_document(doc.id) is True
    assert storage.load_document(doc.id) is None


def test_storage_untitled_doc_follows_first_heading(tmp_path):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))
    doc = storage.create_document(title=None, content="")
    assert doc.title == "Untitled draft"

    updated = storage.update_document(doc.id, content="# Fresh title\nBody")
    assert updated is not None
    assert updated.title == "Fresh title"


def test_storage_list_sorted_by_recency(tmp_path):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))
    first = storage.create_document(title="first", content="a")
    second = storage.create_document(title="second", content="b")
    storage.update_document(first.id, content="a updated")

    summaries = storage.list_documents()
    assert [s.id for s in summaries][0] == first.id
    assert {s.id for s in summaries} == {first.id, second.id}


def test_storage_revision_prevents_stale_overwrite(tmp_path):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))
    doc = storage.create_document(title="Draft", content="version one")
    assert doc.revision == 1

    updated = storage.update_document(
        doc.id,
        content="version two",
        expected_revision=1,
    )
    assert updated is not None
    assert updated.revision == 2

    with pytest.raises(CoWriterRevisionConflict) as exc:
        storage.update_document(
            doc.id,
            content="stale overwrite",
            expected_revision=1,
        )
    assert exc.value.current == 2
    assert storage.load_document(doc.id).content == "version two"


def test_storage_keeps_document_revision_history_and_restores(tmp_path):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))
    doc = storage.create_document(title="Draft", content="version one")
    second = storage.update_document(
        doc.id,
        title="Draft two",
        content="version two",
        expected_revision=1,
    )
    assert second is not None
    third = storage.update_document(doc.id, content="version three", expected_revision=2)
    assert third is not None

    revisions = storage.list_revisions(doc.id)
    assert [item.revision for item in revisions] == [3, 2, 1]
    assert revisions[0].current is True
    assert revisions[1].content == "version two"
    assert revisions[2].content == "version one"

    restored = storage.restore_revision(doc.id, 1, expected_revision=3)
    assert restored is not None
    assert restored.revision == 4
    assert restored.title == "Draft"
    assert restored.content == "version one"
    assert [item.revision for item in storage.list_revisions(doc.id)][:2] == [4, 3]


def test_storage_three_way_merges_non_overlapping_cross_device_edits(tmp_path):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))
    doc = storage.create_document(title="Draft", content="alpha\nbeta\ngamma\n")
    remote = storage.update_document(
        doc.id,
        content="ALPHA\nbeta\ngamma\n",
        expected_revision=1,
    )
    assert remote is not None

    merged = storage.merge_document(
        doc.id,
        base_revision=1,
        local_title="Draft",
        local_content="alpha\nbeta\nGAMMA\n",
        expected_current_revision=2,
    )

    assert merged is not None
    assert merged.revision == 3
    assert merged.content == "ALPHA\nbeta\nGAMMA\n"


def test_storage_three_way_merge_rejects_overlapping_edits(tmp_path):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))
    doc = storage.create_document(title="Draft", content="alpha\nbeta\n")
    storage.update_document(doc.id, content="remote\nbeta\n", expected_revision=1)

    with pytest.raises(CoWriterMergeConflict) as exc:
        storage.merge_document(
            doc.id,
            base_revision=1,
            local_title="Draft",
            local_content="local\nbeta\n",
            expected_current_revision=2,
        )

    assert exc.value.conflicts[0]["start_line"] == 1
    assert storage.load_document(doc.id).content == "remote\nbeta\n"


@pytest.mark.asyncio
async def test_document_revision_history_endpoint_can_restore(tmp_path, monkeypatch):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))
    doc = storage.create_document(title="Draft", content="one")
    storage.update_document(doc.id, content="two", expected_revision=1)
    monkeypatch.setattr(co_writer_router, "get_co_writer_storage", lambda: storage)

    listed = await co_writer_router.list_document_revisions(doc.id)
    assert [item.revision for item in listed.revisions] == [2, 1]

    restored = await co_writer_router.restore_document_revision(
        doc.id,
        1,
        co_writer_router.RestoreDocumentRevisionRequest(expected_revision=2),
    )
    assert restored.revision == 3
    assert restored.content == "one"


@pytest.mark.asyncio
async def test_update_endpoint_returns_structured_revision_conflict(tmp_path, monkeypatch):
    storage = CoWriterStorage(path_service=_StubPathService(tmp_path))
    doc = storage.create_document(title="Draft", content="one")
    storage.update_document(doc.id, content="two", expected_revision=1)
    monkeypatch.setattr(co_writer_router, "get_co_writer_storage", lambda: storage)

    with pytest.raises(HTTPException) as exc:
        await co_writer_router.update_document(
            doc.id,
            UpdateDocumentRequest(content="stale", expected_revision=1),
        )
    assert exc.value.status_code == 409
    assert exc.value.detail == {
        "code": "document_revision_conflict",
        "message": "The document changed since it was loaded.",
        "expected_revision": 1,
        "current_revision": 2,
    }


# ── history limits ───────────────────────────────────────────────────────


def test_append_history_caps_entries(tmp_path, monkeypatch):
    stub = _StubPathService(tmp_path)
    monkeypatch.setattr(edit_agent, "get_path_service", lambda: stub)

    overflow = 5
    for i in range(edit_agent._HISTORY_MAX_ENTRIES + overflow):
        edit_agent.append_history({"id": str(i)})

    history = edit_agent.load_history()
    assert len(history) == edit_agent._HISTORY_MAX_ENTRIES
    assert history[-1]["id"] == str(edit_agent._HISTORY_MAX_ENTRIES + overflow - 1)
    assert history[0]["id"] == str(overflow)


def test_append_history_clips_long_texts(tmp_path, monkeypatch):
    stub = _StubPathService(tmp_path)
    monkeypatch.setattr(edit_agent, "get_path_service", lambda: stub)

    long_text = "x" * (edit_agent._HISTORY_TEXT_LIMIT + 500)
    edit_agent.append_history({"id": "clip", "input": {"original_text": long_text}})

    record = edit_agent.load_history()[-1]
    stored = record["input"]["original_text"]
    assert stored.endswith("…[truncated]")
    assert len(stored) < len(long_text)


def test_load_history_survives_corrupt_file(tmp_path, monkeypatch):
    stub = _StubPathService(tmp_path)
    monkeypatch.setattr(edit_agent, "get_path_service", lambda: stub)

    stub.get_co_writer_dir().mkdir(parents=True, exist_ok=True)
    stub.get_co_writer_history_file().write_text("{not json", encoding="utf-8")
    assert edit_agent.load_history() == []


def test_operation_decision_is_durable_and_document_scoped(tmp_path, monkeypatch):
    stub = _StubPathService(tmp_path)
    monkeypatch.setattr(edit_agent, "get_path_service", lambda: stub)
    edit_agent.append_history({"id": "op-1", "document_id": "doc-1", "action": "rewrite"})
    edit_agent.append_history({"id": "op-2", "document_id": "doc-2", "action": "shorten"})

    updated = edit_agent.record_history_decision(
        "op-1", decision="accepted", applied_text="revised text", partial=True
    )

    assert updated["decision"] == "accepted"
    assert updated["partial"] is True
    assert updated["applied_text"] == "revised text"
    assert [row["id"] for row in edit_agent.load_history() if row["document_id"] == "doc-1"] == [
        "op-1"
    ]


@pytest.mark.asyncio
async def test_operation_history_endpoint_filters_and_records_decision(monkeypatch):
    rows = [
        {"id": "op-1", "document_id": "aaaaaaaaaaaa"},
        {"id": "op-2", "document_id": "bbbbbbbbbbbb"},
    ]
    monkeypatch.setattr(co_writer_router, "load_history", lambda: rows)
    monkeypatch.setattr(
        co_writer_router,
        "record_history_decision",
        lambda operation_id, **values: {"id": operation_id, **values},
    )

    listed = await co_writer_router.get_history(document_id="aaaaaaaaaaaa")
    assert listed == {"history": [rows[0]], "total": 1}
    decided = await co_writer_router.set_operation_decision(
        "op-1",
        co_writer_router.OperationDecisionRequest(
            decision="accepted", applied_text="new", partial=True
        ),
    )
    assert decided["decision"] == "accepted"
    assert decided["partial"] is True
