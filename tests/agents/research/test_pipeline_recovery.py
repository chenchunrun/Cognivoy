"""Research, report settlement, and retry share one completeness contract."""

from __future__ import annotations

import asyncio
from collections import Counter
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cognivoy.agents.research import pipeline as pipeline_module
from cognivoy.agents.research.data_structures import DynamicTopicQueue, TopicStatus
from cognivoy.agents.research.pipeline import (
    ReportOutline,
    ReportSectionPlan,
    ResearchedBlock,
)
from cognivoy.agents.research.utils.citation_manager import CitationManager
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream_bus import StreamBus
from tests.agents.research.test_pipeline_partial_failure import _make_pipeline, _run

pytestmark = pytest.mark.asyncio


@pytest.fixture
def pipeline(tmp_path):
    return _make_pipeline(checkpoint_id="research_recovery123", checkpoint_root=tmp_path)


def complete_blocks(pipeline, monkeypatch):
    calls = []

    async def research(*, block, queue, **kwargs):
        calls.append(block.block_id)
        block.metadata["knowledge"] = f"completed synthesis {block.block_id}"
        queue.mark_completed(block.block_id)
        return ResearchedBlock(block=block, knowledge=block.metadata["knowledge"])

    monkeypatch.setattr(pipeline, "_research_block", research)
    return calls


async def test_report_timeout_is_partial_and_resume_keeps_completed_research(pipeline, monkeypatch):
    calls = complete_blocks(pipeline, monkeypatch)
    monkeypatch.setattr(pipeline, "_write_report", AsyncMock(side_effect=asyncio.TimeoutError))
    first = await _run(pipeline)
    meta = first["metadata"]
    assert meta["failed_block_count"] == 0
    assert meta["evidence_coverage"]["complete"] is True
    assert meta["partial"] is True
    assert meta["report_complete"] is False
    assert meta["partial_reasons"] == ["reporting_timeout"]
    assert meta["timed_out_stages"] == ["reporting"]
    assert meta["checkpoint_resumable"] is True
    assert pipeline.checkpoint.metadata()["status"] == "partial"

    async def report(**kwargs):
        assert [item.knowledge for item in kwargs["blocks"]] == [
            "completed synthesis block_1",
            "completed synthesis block_2",
        ]
        return "REPORT_OK"

    monkeypatch.setattr(pipeline, "_write_report", report)
    second = await _run(pipeline)
    assert calls == ["block_1", "block_2"]
    assert second["metadata"]["resumed_from_checkpoint"] is True
    assert second["metadata"]["partial"] is False
    assert second["metadata"]["report_complete"] is True
    assert second["metadata"]["timed_out_stages"] == []
    assert second["metadata"]["checkpoint_resumable"] is False
    assert pipeline.checkpoint.metadata()["status"] == "complete"


async def test_missing_evidence_keeps_checkpoint_resumable(pipeline, monkeypatch):
    complete_blocks(pipeline, monkeypatch)
    monkeypatch.setattr(pipeline, "_write_report", AsyncMock(return_value="REPORT"))
    monkeypatch.setattr(pipeline, "_backfill_missing_evidence", AsyncMock())
    monkeypatch.setattr(
        pipeline,
        "_evidence_coverage",
        lambda _: {
            "expected": ["web_search"],
            "observed": [],
            "missing": ["web_search"],
            "complete": False,
        },
    )
    result = await _run(pipeline)
    assert result["metadata"]["partial_reasons"] == ["missing_evidence_channels"]
    assert result["metadata"]["checkpoint_resumable"] is True
    assert pipeline.checkpoint.metadata()["status"] == "partial"


async def test_research_timeout_resumes_only_unfinished_blocks(pipeline, monkeypatch):
    cancelled = asyncio.Event()

    async def research(*, block, queue, **kwargs):
        queue.mark_researching(block.block_id)
        if block.block_id == "block_2":
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        block.metadata["knowledge"] = "durable completed synthesis"
        queue.mark_completed(block.block_id)
        return ResearchedBlock(block=block, knowledge=block.metadata["knowledge"])

    monkeypatch.setattr(pipeline, "_research_block", research)
    monkeypatch.setattr(pipeline_module, "RESEARCH_BLOCKS_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(pipeline, "_write_report", AsyncMock(return_value="REPORT"))
    first = await _run(pipeline)
    assert cancelled.is_set()
    assert first["metadata"]["partial"] is True
    assert first["metadata"]["failed_block_count"] == 1
    assert first["metadata"]["timed_out_stages"] == ["researching"]
    calls = complete_blocks(pipeline, monkeypatch)
    second = await _run(pipeline)
    assert calls == ["block_2"]
    assert second["metadata"]["partial"] is False
    assert second["metadata"]["completed_block_count"] == 2


async def test_report_retry_reuses_finished_steps_and_invalidates_changed_evidence(
    pipeline,
    monkeypatch,
):
    queue = DynamicTopicQueue("report")
    block = queue.add_block("A", "")
    queue.mark_completed(block.block_id)
    blocks = [ResearchedBlock(block=block, knowledge="SYNTHESIS")]
    citations = CitationManager("report", cache_dir=pipeline.checkpoint.directory)
    calls = Counter()
    outline = ReportOutline(
        "Report",
        (
            ReportSectionPlan("a", "First", "", (block.block_id,)),
            ReportSectionPlan("b", "Second", "", (block.block_id,)),
        ),
    )

    async def gen_outline(**kwargs):
        calls["outline"] += 1
        return outline

    async def intro(**kwargs):
        calls["intro"] += 1
        return "INTRO"

    async def section(*, section, **kwargs):
        calls[section.id] += 1
        if section.id == "b" and calls["b"] == 1:
            raise asyncio.TimeoutError
        return f"BODY_{section.id}"

    monkeypatch.setattr(pipeline, "_gen_report_outline", gen_outline)
    monkeypatch.setattr(pipeline, "_write_intro", intro)
    monkeypatch.setattr(pipeline, "_write_section", section)
    monkeypatch.setattr(pipeline, "_write_conclusion", AsyncMock(return_value="CONCLUSION"))
    kwargs = dict(
        topic="Topic", blocks=blocks, citations=citations, stream=StreamBus(), client=None
    )
    with pytest.raises(asyncio.TimeoutError):
        await pipeline._write_report(**kwargs)
    report = await pipeline._write_report(**kwargs)
    assert all(text in report for text in ("INTRO", "BODY_a", "BODY_b", "CONCLUSION"))
    assert calls == {"outline": 1, "intro": 1, "a": 1, "b": 2}

    blocks[0].knowledge = "New evidence from recovered block"
    await pipeline._write_report(**kwargs)
    assert calls == {"outline": 2, "intro": 2, "a": 2, "b": 3}


async def test_block_finish_synthesis_is_persisted_before_marking_complete(pipeline, monkeypatch):
    queue = DynamicTopicQueue("research_recovery123")
    block = queue.add_block("A", "")
    pipeline.checkpoint.start(topic="Topic", queue=queue)
    monkeypatch.setattr(
        pipeline_module,
        "run_agentic_loop",
        AsyncMock(
            return_value=SimpleNamespace(
                final_text="Final integrated evidence",
                completed=True,
                iterations=3,
            )
        ),
    )
    await pipeline._research_block(
        block=block,
        queue=queue,
        citations=CitationManager(queue.research_id, cache_dir=pipeline.checkpoint.directory),
        topic="Topic",
        context=UnifiedContext(session_id="test", user_message="Topic"),
        stream=StreamBus(),
        client=None,
    )
    restored = pipeline.checkpoint.resume(topic="Topic")
    assert restored.blocks[0].status == TopicStatus.COMPLETED
    assert restored.blocks[0].metadata["knowledge"] == "Final integrated evidence"
    assert restored.blocks[0].iteration_count == 3


async def test_slow_note_sidecar_cancels_and_keeps_raw_evidence(pipeline, monkeypatch):
    cancelled = asyncio.Event()

    async def create(**kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    monkeypatch.setattr(pipeline_module, "NOTE_TIMEOUT_SECONDS", 0.01)
    summary = await pipeline._summarise_tool_result(
        tool_name="web_search",
        query="topic",
        raw_answer="REAL SOURCE EVIDENCE",
        client=client,
    )
    assert summary == "REAL SOURCE EVIDENCE"
    assert cancelled.is_set()
