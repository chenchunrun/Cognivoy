"""The disabled provider must not execute even with cached/installed engines."""

import importlib.util

import pytest

from cognivoy.services.rag import factory
from cognivoy.services.rag.pipelines.graphrag import config, engine
from cognivoy.services.rag.pipelines.graphrag.pipeline import GraphRagPipeline


def test_installed_graphrag_is_not_available(monkeypatch):
    monkeypatch.setattr(importlib.util, "find_spec", lambda name: object())
    assert config.is_graphrag_available() is False


def test_provider_picker_excludes_graphrag():
    names = {item["id"] for item in factory.list_pipelines()}
    assert "graphrag" not in names
    assert {"llamaindex", "lightrag", "lightrag-server"} <= names


def test_factory_rejects_cached_graphrag(monkeypatch, tmp_path):
    monkeypatch.setitem(factory._PIPELINE_CACHE, (str(tmp_path), "graphrag"), object())
    with pytest.raises(config.GraphRagNotAvailableError, match="temporarily disabled"):
        factory.get_pipeline(" GraphRAG ", kb_base_dir=str(tmp_path))


@pytest.mark.asyncio
async def test_direct_pipeline_rejects_indexing_without_touching_files(tmp_path):
    pipeline = GraphRagPipeline(kb_base_dir=str(tmp_path))
    with pytest.raises(config.GraphRagNotAvailableError, match="temporarily disabled"):
        await pipeline.initialize("test", [])
    assert not list(tmp_path.iterdir())


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["build", "search"])
async def test_engine_blocks_before_spawning_worker(monkeypatch, tmp_path, operation):
    from cognivoy.services import process_isolation

    async def forbidden_worker(**kwargs):
        raise AssertionError("Disabled provider attempted to start a worker")

    monkeypatch.setattr(process_isolation, "run_in_killable_process", forbidden_worker)
    with pytest.raises(config.GraphRagNotAvailableError, match="temporarily disabled"):
        if operation == "build":
            await engine.build(tmp_path)
        else:
            await engine.search(tmp_path, "test")
