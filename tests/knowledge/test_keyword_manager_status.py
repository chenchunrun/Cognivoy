"""Keyword KB lifecycle must not depend on, or relabel, an embedding model."""

from __future__ import annotations

import importlib
import json
from types import SimpleNamespace

import pytest

from cognivoy.knowledge import manager as manager_module
from cognivoy.knowledge.manager import KnowledgeBaseManager
from cognivoy.services.rag import embedding_signature
from cognivoy.services.rag.pipelines.llamaindex import keyword
from cognivoy.services.rag.pipelines.llamaindex.document_loader import TextDocument as Document


@pytest.fixture(autouse=True)
def no_embedding(monkeypatch):
    monkeypatch.setenv("COGNIVOY_RAG_RETRIEVAL_PROFILE", "keyword")

    def forbidden():
        pytest.fail("Keyword lifecycle must not read active embedding configuration")

    monkeypatch.setattr(manager_module, "_get_embedding_fingerprint", forbidden)
    monkeypatch.setattr(embedding_signature, "signature_from_embedding_config", forbidden)
    monkeypatch.setattr(KnowledgeBaseManager, "_sync_kb_to_pb", lambda *_: None)


def make_manager(tmp_path, **fields):
    kb = tmp_path / "course"
    keyword.index_documents([Document(text="CISA auditing evidence", metadata={})], str(kb))
    (tmp_path / "kb_config.json").write_text(
        json.dumps(
            {
                "knowledge_bases": {
                    "course": {"rag_provider": "llamaindex", "status": "ready", **fields}
                }
            }
        )
    )
    return KnowledgeBaseManager(base_dir=str(tmp_path))


def test_keyword_clears_legacy_model_mismatch_and_allows_upload(tmp_path):
    from cognivoy.api.routers.knowledge import _assert_kb_writable_or_409

    manager = make_manager(
        tmp_path,
        embedding_mismatch=True,
        needs_reindex=True,
        embedding_model="old-ollama",
        embedding_dim=768,
        embedding_signature="old-signature",
    )
    entry = manager.config["knowledge_bases"]["course"]
    assert not entry.get("embedding_mismatch")
    assert not entry["needs_reindex"]
    _assert_kb_writable_or_409("course", entry)
    info = manager.get_info("course")
    assert info["status"] == "ready"
    assert info["statistics"]["active_match"]
    assert info["statistics"]["active_signature"] is None


@pytest.mark.parametrize(
    "fields",
    [
        {"reindex_reason": "source_changed"},
        {"reindex_reason": "provider_changed"},
        {"status": "needs_reindex"},
        {"status": "error", "progress": {"stage": "error"}},
    ],
)
def test_keyword_preserves_non_embedding_rebuild_requirements(tmp_path, fields):
    manager = make_manager(tmp_path, embedding_mismatch=True, needs_reindex=True, **fields)
    entry = manager.config["knowledge_bases"]["course"]
    assert not entry.get("embedding_mismatch")
    assert entry["needs_reindex"]
    assert manager.get_info("course")["statistics"]["needs_reindex"]


def test_keyword_ready_does_not_relabel_preserved_vector_identity(tmp_path):
    fields = {
        "embedding_model": "old-ollama",
        "embedding_dim": 768,
        "embedding_signature": "old-signature",
    }
    manager = make_manager(tmp_path, **fields)
    manager.update_kb_status(
        "course",
        "ready",
        progress={"index_changed": True, "indexed_count": 1, "index_action": "reindex"},
    )
    entry = manager.config["knowledge_bases"]["course"]
    assert {key: entry[key] for key in fields} == fields
    assert manager.get_rag_storage_path("course") == tmp_path / "course" / keyword.INDEX_DIR


def test_missing_keyword_index_does_not_clear_required_rebuild(tmp_path):
    kb = tmp_path / "course"
    kb.mkdir()
    entries = {
        "course": {
            "rag_provider": "llamaindex",
            "embedding_mismatch": True,
            "needs_reindex": True,
            "status": "ready",
        }
    }
    assert manager_module._reconcile_embedding_flags(entries, tmp_path)
    assert entries["course"]["needs_reindex"]


def test_switching_back_to_vector_does_not_clear_source_changes(tmp_path, monkeypatch):
    monkeypatch.setenv("COGNIVOY_RAG_RETRIEVAL_PROFILE", "vector")
    monkeypatch.setattr(manager_module, "_get_embedding_fingerprint", lambda: ("old", 768))
    monkeypatch.setattr(embedding_signature, "signature_from_embedding_config", lambda: object())
    index_versions = importlib.import_module("cognivoy.services.rag.index_versioning")
    monkeypatch.setattr(index_versions, "find_matching_version", lambda *_: {"ready": True})
    monkeypatch.setattr(
        manager_module, "inspect_provider_version", lambda *_: SimpleNamespace(ready=True)
    )
    monkeypatch.setattr(manager_module, "inspect_kb_versions", lambda *_: [])
    entries = {
        "course": {
            "rag_provider": "llamaindex",
            "needs_reindex": True,
            "reindex_reason": "source_changed",
            "embedding_mismatch": True,
        }
    }
    manager_module._reconcile_embedding_flags(entries, tmp_path)
    assert entries["course"]["needs_reindex"]
    assert entries["course"]["reindex_reason"] == "source_changed"
