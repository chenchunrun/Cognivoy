import json
import os
from pathlib import Path

import pytest

from cognivoy.services.rag.pipelines.llamaindex import keyword
from cognivoy.services.rag.pipelines.llamaindex.document_loader import TextDocument as Document


def _write_legacy_docstore(path, text, metadata=None):
    """Write the historical wire format without importing its retired producer."""
    path.write_text(
        json.dumps(
            {
                "docstore/data": {
                    "legacy-node": {
                        "__type__": "1",
                        "__data__": {
                            "id_": "legacy-node",
                            "text": text,
                            "metadata": metadata or {},
                        },
                    }
                }
            }
        )
    )


def test_keyword_ranking_and_cjk_without_models(tmp_path):
    docs = [
        Document(
            text="CISA exam domains include information systems auditing.",
            metadata={"file_name": "cisa.txt"},
        ),
        Document(text="知识库检索支持信息系统审计和风险管理。", metadata={"file_name": "中文.txt"}),
        Document(text="Astronomy studies planets and stars.", metadata={"file_name": "stars.txt"}),
    ]
    keyword.index_documents(docs, str(tmp_path))
    assert (
        keyword.retrieve(str(tmp_path), "CISA exam domains")[0]["metadata"]["file_name"]
        == "cisa.txt"
    )
    assert keyword.retrieve(str(tmp_path), "信息系统审计")[0]["metadata"]["file_name"] == "中文.txt"
    assert keyword.retrieve(str(tmp_path), "xyzzyq") == []


def test_keyword_append_and_rebuild_preserve_vectors(tmp_path):
    vector_file = tmp_path / "old-vector.bin"
    vector_file.write_bytes(b"original")
    first = Document(text="initial CISA guide", metadata={"file_name": "one.txt"})
    keyword.index_documents([first], str(tmp_path))
    keyword.index_documents(
        [Document(text="updated auditing guide", metadata={"file_name": "one.txt"})],
        str(tmp_path),
        append=True,
    )
    assert len(keyword.load_rows(tmp_path)) == 1
    assert keyword.retrieve(str(tmp_path), "initial") == []
    keyword.index_documents([Document(text="another guide", metadata={})], str(tmp_path))
    assert vector_file.read_bytes() == b"original"
    assert keyword.retrieve(str(tmp_path), "auditing") == []


def test_keyword_failed_publish_preserves_previous_index(tmp_path, monkeypatch):
    keyword.index_documents([Document(text="CISA original", metadata={})], str(tmp_path))
    monkeypatch.setattr(
        keyword.os, "replace", lambda *_: (_ for _ in ()).throw(OSError("disk full"))
    )
    with pytest.raises(OSError):
        keyword.index_documents([Document(text="replacement", metadata={})], str(tmp_path))
    assert keyword.retrieve(str(tmp_path), "original")
    assert len(list((tmp_path / keyword.INDEX_DIR).iterdir())) == 1


def test_keyword_oversized_publish_preserves_previous_index(tmp_path, monkeypatch):
    keyword.index_documents([Document(text="CISA original", metadata={})], str(tmp_path))
    index = tmp_path / keyword.INDEX_DIR / keyword.INDEX_FILE
    original = index.read_bytes()
    monkeypatch.setattr(keyword, "MAX_INDEX_BYTES", len(original) + 10)
    with pytest.raises(ValueError, match="size"):
        keyword.index_documents(
            [Document(text="oversized replacement " * 100, metadata={})], str(tmp_path)
        )
    assert index.read_bytes() == original
    assert keyword.retrieve(str(tmp_path), "original")


def test_keyword_append_replaces_document_id_without_file_metadata(tmp_path):
    keyword.index_documents(
        [Document(text="old content", doc_id="stable", metadata={})], str(tmp_path)
    )
    keyword.index_documents(
        [Document(text="new content", doc_id="stable", metadata={})], str(tmp_path), append=True
    )
    assert len(keyword.load_rows(tmp_path)) == 1
    assert not keyword.retrieve(str(tmp_path), "old")


def test_keyword_append_upgrades_legacy_filename_without_merging_known_paths(tmp_path):
    keyword.index_documents(
        [Document(text="old content", metadata={"file_name": "book.txt"})], str(tmp_path)
    )
    keyword.index_documents(
        [
            Document(
                text="new content", metadata={"file_name": "book.txt", "file_path": "/a/book.txt"}
            )
        ],
        str(tmp_path),
        append=True,
    )
    assert len(keyword.load_rows(tmp_path)) == 1
    keyword.index_documents(
        [
            Document(
                text="different book",
                metadata={"file_name": "book.txt", "file_path": "/b/book.txt"},
            )
        ],
        str(tmp_path),
        append=True,
    )
    assert len(keyword.load_rows(tmp_path)) == 2


def test_keyword_reads_legacy_text_without_opening_vectors(tmp_path):
    legacy = tmp_path / "llamaindex_storage"
    legacy.mkdir()
    _write_legacy_docstore(
        legacy / "docstore.json", "CISA audit evidence", {"file_name": "cisa.pdf", "page": 3}
    )
    # Existing version readiness requires an index marker, not valid vectors.
    (legacy / "index_store.json").write_text("{}")
    assert keyword.available(tmp_path)
    rows = keyword.retrieve(str(tmp_path), "audit")
    assert rows[0]["metadata"]["page"] == 3


def test_keyword_reads_nested_legacy_without_embedding_signature(tmp_path):
    legacy = tmp_path / "index_versions" / "old-model" / "llamaindex_storage"
    legacy.mkdir(parents=True)
    _write_legacy_docstore(legacy / "docstore.json", "CISA legacy auditing")
    assert keyword.available(tmp_path)
    assert keyword.retrieve(str(tmp_path), "auditing")


def test_keyword_rejects_docstore_symlink_and_oversized_or_invalid_index(tmp_path, monkeypatch):
    root = tmp_path / "kb"
    legacy = root / "llamaindex_storage"
    legacy.mkdir(parents=True)
    outside = tmp_path / "foreign.json"
    outside.write_text("{}")
    (legacy / "docstore.json").symlink_to(outside)
    assert not keyword.available(root)
    with pytest.raises(ValueError, match="inside"):
        keyword.load_rows(root)
    sidecar = root / keyword.INDEX_DIR
    sidecar.mkdir()
    index = sidecar / keyword.INDEX_FILE
    index.write_text('[{"text":"invalid row"}]')
    assert not keyword.available(root)
    with pytest.raises(ValueError, match="Invalid"):
        keyword.load_rows(root)
    monkeypatch.setattr(keyword, "MAX_INDEX_BYTES", 2)
    with pytest.raises(ValueError, match="size"):
        keyword.load_rows(root)


def test_keyword_is_safe_default_on_config_failure(monkeypatch):
    from cognivoy.services.rag.pipelines.llamaindex import config

    assert config.normalize_retrieval_profile("invalid") == "keyword"
    monkeypatch.setattr(
        config, "_load_runtime_settings", lambda: (_ for _ in ()).throw(OSError("unreadable"))
    )
    assert config.keyword_enabled()


def test_keyword_rejects_out_of_scope_index(tmp_path):
    root = tmp_path / "kb"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / keyword.INDEX_DIR).symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="inside"):
        keyword.index_documents([Document(text="secret", metadata={})], str(root))
    assert list(outside.iterdir()) == []


def test_keyword_readiness_caches_only_boolean_and_rechecks_changes(tmp_path, monkeypatch):
    keyword._cached_available.cache_clear()
    original_load = keyword.load_rows
    calls = []

    def counted_load(root):
        calls.append(root)
        return original_load(root)

    monkeypatch.setattr(keyword, "load_rows", counted_load)
    assert not keyword.available(tmp_path)
    assert not keyword.available(tmp_path)
    assert len(calls) == 1
    keyword.index_documents([Document(text="CISA auditing", metadata={})], str(tmp_path))
    assert keyword.available(tmp_path)
    assert keyword.available(tmp_path)
    assert len(calls) == 2
    index = tmp_path / keyword.INDEX_DIR / keyword.INDEX_FILE
    index.write_text("[]")
    assert not keyword.available(tmp_path)
    assert len(calls) == 3
    index.unlink()
    assert not keyword.available(tmp_path)
    assert keyword._cached_available.cache_parameters()["maxsize"] == 128


def test_keyword_readiness_invalidates_same_size_atomic_replacement(tmp_path):
    keyword.index_documents([Document(text="CISA", metadata={})], str(tmp_path))
    assert keyword.available(tmp_path)
    index = tmp_path / keyword.INDEX_DIR / keyword.INDEX_FILE
    before = index.stat()
    replacement = index.with_name("replacement.json")
    replacement.write_text(" " * before.st_size)
    os.utime(replacement, ns=(before.st_atime_ns, before.st_mtime_ns))
    os.replace(replacement, index)
    assert not keyword.available(tmp_path)


@pytest.mark.parametrize("layout", ["keyword", "legacy"])
def test_keyword_readiness_cache_cannot_hide_new_out_of_scope_symlink(tmp_path, layout):
    root = tmp_path / "kb"
    if layout == "keyword":
        keyword.index_documents([Document(text="CISA auditing", metadata={})], str(root))
        index = root / keyword.INDEX_DIR / keyword.INDEX_FILE
    else:
        folder = root / "llamaindex_storage"
        folder.mkdir(parents=True)
        index = folder / "docstore.json"
        _write_legacy_docstore(index, "CISA auditing")
    assert keyword.available(root)
    outside = tmp_path / "outside.json"
    index.replace(outside)
    index.symlink_to(outside)
    assert not keyword.available(root)


def test_keyword_readiness_rechecks_legacy_docstore_and_new_sidecar(tmp_path):
    folder = tmp_path / "llamaindex_storage"
    folder.mkdir()
    index = folder / "docstore.json"
    _write_legacy_docstore(index, "CISA auditing")
    assert keyword.available(tmp_path)
    index.write_text("{}")
    assert not keyword.available(tmp_path)
    keyword.index_documents([Document(text="CISA restored", metadata={})], str(tmp_path))
    assert keyword.available(tmp_path)


@pytest.mark.asyncio
async def test_keyword_pipeline_index_search_add_without_embedding(tmp_path, monkeypatch):
    from cognivoy.services.rag.pipelines.llamaindex import pipeline, storage
    from cognivoy.services.rag.preflight import engine_preflight

    monkeypatch.setenv("COGNIVOY_RAG_RETRIEVAL_PROFILE", "keyword")
    monkeypatch.setattr(
        pipeline,
        "configure_llamaindex_settings",
        lambda *_: pytest.fail("must not configure models"),
    )
    monkeypatch.setattr(
        pipeline,
        "signature_from_embedding_config",
        lambda: pytest.fail("must not resolve embeddings"),
    )

    async def inline_runner(**call):
        return getattr(storage, call["qualname"])(*call["args"], **call["kwargs"])

    engine = pipeline.LlamaIndexPipeline(kb_base_dir=str(tmp_path), isolated_runner=inline_runner)
    document = tmp_path / "course.txt"
    document.write_text("CISA information systems auditing and risk management")
    assert engine_preflight("llamaindex")["ok"]
    assert await engine.initialize("course", [str(document)])
    result = await engine.search("CISA auditing", "course")
    assert result["success"] and not result["model_required"]
    assert result["sources"][0]["chunk_id"]
    assert result["sources"][0]["source"] == "course.txt"
    document.write_text("Business continuity and disaster recovery")
    assert await engine.add_documents("course", [str(document)])
    assert (await engine.search("disaster recovery", "course"))["sources"]
    assert not (await engine.search("CISA", "course"))["sources"]


@pytest.mark.asyncio
async def test_keyword_missing_index_is_failure(tmp_path, monkeypatch):
    from cognivoy.services.rag.pipelines.llamaindex.pipeline import LlamaIndexPipeline

    monkeypatch.setenv("COGNIVOY_RAG_RETRIEVAL_PROFILE", "keyword")
    result = await LlamaIndexPipeline(kb_base_dir=str(tmp_path)).search("CISA", "empty")
    assert result["success"] is False
    assert result["sources"] == []
