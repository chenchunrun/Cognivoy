"""Disabled local engines cannot be reenabled by installed packages."""

import pytest


def test_vector_adapter_denies_preinstalled_dependencies():
    from cognivoy.services.rag.pipelines.llamaindex import pipeline

    with pytest.raises(RuntimeError, match="temporarily unavailable"):
        pipeline._vector_adapter()


@pytest.mark.parametrize("profile", ["vector", "hybrid"])
def test_saved_vector_profile_fails_without_mutating_index(tmp_path, monkeypatch, profile):
    from cognivoy.services.rag.pipelines.llamaindex import config, pipeline

    settings = {"retrieval_profile": profile}
    monkeypatch.setattr(config, "_load_runtime_settings", lambda: settings)
    index = tmp_path / "kb" / "llamaindex_storage"
    index.mkdir(parents=True)
    saved = index / "docstore.json"
    saved.write_text('{"existing": "data"}')
    with pytest.raises(RuntimeError, match="Select keyword retrieval"):
        pipeline.LlamaIndexPipeline(kb_base_dir=str(tmp_path))
    assert saved.read_text() == '{"existing": "data"}'
    assert settings["retrieval_profile"] == profile
    assert not (tmp_path / "kb" / "keyword_index").exists()


def test_docling_denied_before_conversion(tmp_path):
    from cognivoy.services.parsing.engines.docling.config import DoclingConfig
    from cognivoy.services.parsing.engines.docling.engine import DoclingParser
    from cognivoy.services.parsing.types import ParserError

    parser = DoclingParser()
    config = DoclingConfig(allow_local_model_download=True)
    assert not parser.is_available()
    assert not parser.is_ready(config).ready
    source = tmp_path / "source.txt"
    source.write_text("Keep the original document.")
    with pytest.raises(ParserError, match="temporarily unavailable"):
        parser.parse(source, tmp_path, config=config)
    assert source.read_text() == "Keep the original document."
    assert not (tmp_path / "source.md").exists()
