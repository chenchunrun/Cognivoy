"""Deep Research must not report success when a research block fails (issue #595).

A subtopic that raises (or exhausts its iteration budget without finishing) is
backfilled with empty knowledge so the surviving subtopics still yield a report.
The fix keeps that resilience but makes the shortfall explicit in the result
envelope (``metadata.partial`` / ``failed_block_count`` / ``failed_block_titles``)
instead of returning a clean-success shape with missing evidence.
"""

from __future__ import annotations

import types
from unittest.mock import patch

import pytest

from cognivoy.agents.research.data_structures import DynamicTopicQueue
from cognivoy.agents.research.pipeline import ResearchedBlock, ResearchPipeline, SubTopicItem
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream_bus import StreamBus

pytestmark = pytest.mark.asyncio


class _FakeLLM:
    binding = "openai"
    model = "gpt-x"
    api_key = "k"
    base_url = "u"
    api_version = None
    extra_headers: dict = {}
    reasoning_effort = None


class _FakeRegistry:
    def build_openai_schemas(self, _names):
        return []

    def build_prompt_text(self, _names, **_kwargs):
        return "- none"

    def get(self, _name):
        return None

    def get_enabled(self, _names):
        return []


def _make_pipeline(**kwargs) -> ResearchPipeline:
    with (
        patch("cognivoy.agents.research.pipeline.get_llm_config", lambda: _FakeLLM()),
        patch("cognivoy.agents.research.pipeline.get_tool_registry", lambda: _FakeRegistry()),
    ):
        return ResearchPipeline(
            language="en", runtime_config={"queue": {"max_length": 5}}, **kwargs
        )


async def _run(pipeline: ResearchPipeline) -> dict:
    async def fake_emit(*_args, **_kwargs):
        return None

    with patch("cognivoy.agents.research.pipeline.emit_capability_result", fake_emit):
        return await pipeline._run_inner(
            context=UnifiedContext(session_id="s1", user_message="research this"),
            topic="Research topic",
            image_attachments=[],
            confirmed_outline=[SubTopicItem(title="A"), SubTopicItem(title="B")],
            stream=StreamBus(),
            client=None,
        )


async def test_failed_block_marks_result_partial() -> None:
    pipeline = _make_pipeline()

    async def fake_research_block(self, *, block, queue, citations, topic, context, stream, client):
        queue.mark_researching(block.block_id)
        if block.block_id == "block_1":
            raise RuntimeError("synthetic block failure")
        queue.mark_completed(block.block_id)
        return ResearchedBlock(block=block, knowledge=f"knowledge for {block.block_id}")

    async def fake_write_report(self, *, topic, blocks, citations, stream, client):
        return "REPORT_OK"

    pipeline._research_block = types.MethodType(fake_research_block, pipeline)
    pipeline._write_report = types.MethodType(fake_write_report, pipeline)

    result = await _run(pipeline)
    meta = result["metadata"]

    assert result["response"] == "REPORT_OK"  # surviving evidence still produces a report
    assert meta["partial"] is True
    assert meta["failed_block_count"] == 1
    assert meta["failed_block_titles"] == ["A"]
    assert meta["block_count"] == 2


async def test_all_blocks_complete_is_not_partial() -> None:
    pipeline = _make_pipeline()

    async def fake_research_block(self, *, block, queue, citations, topic, context, stream, client):
        queue.mark_researching(block.block_id)
        queue.mark_completed(block.block_id)
        return ResearchedBlock(block=block, knowledge=f"knowledge for {block.block_id}")

    async def fake_write_report(self, *, topic, blocks, citations, stream, client):
        return "REPORT_OK"

    pipeline._research_block = types.MethodType(fake_research_block, pipeline)
    pipeline._write_report = types.MethodType(fake_write_report, pipeline)

    result = await _run(pipeline)
    meta = result["metadata"]

    assert meta["partial"] is False
    assert meta["failed_block_count"] == 0
    assert meta["failed_block_titles"] == []


async def test_confirmed_outline_can_exceed_depth_queue_preset() -> None:
    """A user-approved outline must not be rejected by the expansion cap."""
    with (
        patch("cognivoy.agents.research.pipeline.get_llm_config", lambda: _FakeLLM()),
        patch("cognivoy.agents.research.pipeline.get_tool_registry", lambda: _FakeRegistry()),
    ):
        pipeline = ResearchPipeline(language="en", runtime_config={"queue": {"max_length": 2}})

    async def fake_research_block(self, *, block, queue, citations, topic, context, stream, client):
        queue.mark_researching(block.block_id)
        queue.mark_completed(block.block_id)
        return ResearchedBlock(block=block, knowledge=block.sub_topic)

    async def fake_write_report(self, *, topic, blocks, citations, stream, client):
        return "REPORT_OK"

    pipeline._research_block = types.MethodType(fake_research_block, pipeline)
    pipeline._write_report = types.MethodType(fake_write_report, pipeline)
    outline = [SubTopicItem(title=f"Topic {index}") for index in range(5)]

    async def fake_emit(*_args, **_kwargs):
        return None

    with patch("cognivoy.agents.research.pipeline.emit_capability_result", fake_emit):
        result = await pipeline._run_inner(
            context=UnifiedContext(session_id="s-cap", user_message="research"),
            topic="Research topic",
            image_attachments=[],
            confirmed_outline=outline,
            stream=StreamBus(),
            client=None,
        )

    assert result["response"] == "REPORT_OK"
    assert result["metadata"]["block_count"] == 5


async def test_retry_resumes_checkpoint_without_researching_completed_blocks(tmp_path) -> None:
    with (
        patch("cognivoy.agents.research.pipeline.get_llm_config", lambda: _FakeLLM()),
        patch("cognivoy.agents.research.pipeline.get_tool_registry", lambda: _FakeRegistry()),
    ):
        pipeline = ResearchPipeline(
            language="en",
            runtime_config={"queue": {"max_length": 5}},
            checkpoint_id="research_resume123",
            checkpoint_root=tmp_path,
        )

    queue = DynamicTopicQueue("research_resume123", max_length=5)
    first = queue.add_block("Already complete", "")
    second = queue.add_block("Still pending", "")
    queue.mark_completed(first.block_id)
    pipeline.checkpoint.start(topic="Research topic", queue=queue)
    researched_ids = []

    async def fake_research_block(self, *, block, queue, citations, topic, context, stream, client):
        researched_ids.append(block.block_id)
        queue.mark_completed(block.block_id)
        return ResearchedBlock(block=block, knowledge="new evidence")

    async def fake_write_report(self, *, topic, blocks, citations, stream, client):
        return "RESUMED_REPORT"

    pipeline._research_block = types.MethodType(fake_research_block, pipeline)
    pipeline._write_report = types.MethodType(fake_write_report, pipeline)

    async def fake_emit(*_args, **_kwargs):
        return None

    with patch("cognivoy.agents.research.pipeline.emit_capability_result", fake_emit):
        result = await pipeline._run_inner(
            context=UnifiedContext(session_id="resume", user_message="research"),
            topic="Research topic",
            image_attachments=[],
            confirmed_outline=[SubTopicItem(title="ignored on resume")],
            stream=StreamBus(),
            client=None,
        )

    assert researched_ids == [second.block_id]
    assert result["metadata"]["resumed_from_checkpoint"] is True
    assert result["metadata"]["completed_block_count"] == 2
