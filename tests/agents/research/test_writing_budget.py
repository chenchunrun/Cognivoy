"""Writing budgets must yield report bodies, not implicit provider reasoning only."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from cognivoy.agents.research import pipeline as pipeline_module
from cognivoy.agents.research.data_structures import DynamicTopicQueue
from cognivoy.agents.research.pipeline import ReportOutline, ReportSectionPlan, ResearchedBlock
from cognivoy.agents.research.utils.citation_manager import CitationManager
from cognivoy.core.stream_bus import StreamBus
from tests.agents.research.test_pipeline_partial_failure import _make_pipeline, _run
from tests.agents.research.test_pipeline_recovery import complete_blocks

pytestmark = pytest.mark.asyncio


@pytest.fixture
def pipeline(tmp_path):
    pipeline = _make_pipeline(checkpoint_id="research_budget123", checkpoint_root=tmp_path)
    pipeline.binding = "deepseek"
    pipeline.model = "deepseek-v4-pro"
    return pipeline


def assert_thinking(kwargs, *, enabled, budget):
    assert kwargs["max_tokens"] == budget
    assert kwargs["extra_body"] == {"thinking": {"type": "enabled" if enabled else "disabled"}}
    if enabled:
        assert kwargs["reasoning_effort"] == "high"
    else:
        assert "reasoning_effort" not in kwargs


@pytest.mark.parametrize("depth", ["quick", "standard"])
@pytest.mark.parametrize("effort", [None, "high", "minimal"])
async def test_actual_report_steps_preserve_output_caps_and_explicit_effort(
    pipeline, monkeypatch, depth, effort
):
    pipeline.research_depth = depth
    pipeline.reasoning_effort = effort
    run_step = AsyncMock(return_value=SimpleNamespace(text="BODY"))
    monkeypatch.setattr(pipeline_module, "run_labeled_step", run_step)
    queue = DynamicTopicQueue("budget")
    block = queue.add_block("Evidence", "")
    blocks = [ResearchedBlock(block=block, knowledge="SOURCE")]
    citations = CitationManager("budget", cache_dir=pipeline.checkpoint.directory)
    outline = ReportOutline("Report", (ReportSectionPlan("a", "Section", "", (block.block_id,)),))
    common = dict(topic="Topic", stream=StreamBus(), client=None)
    await pipeline._gen_report_outline(blocks=blocks, citations=citations, **common)
    await pipeline._write_intro(outline=outline, **common)
    await pipeline._write_section(
        section=outline.sections[0],
        section_index=1,
        section_count=1,
        section_number=2,
        outline=outline,
        blocks=blocks,
        citations=citations,
        **common,
    )
    await pipeline._write_conclusion(
        outline=outline,
        section_bodies=["BODY"],
        section_number=3,
        **common,
    )
    budgets = [1000, 1200, 2500, 1200] if depth == "quick" else [2000, 3000, 6000, 3000]
    enabled = effort == "high" or (effort is None and depth != "quick")
    for call, budget in zip(run_step.call_args_list, budgets, strict=True):
        assert call.kwargs["stage"] == "reporting"
        assert_thinking(call.kwargs["completion_kwargs"], enabled=enabled, budget=budget)


@pytest.mark.parametrize("stage", ["rephrasing", "decomposing", "researching"])
async def test_quick_research_phases_keep_provider_default_thinking(pipeline, monkeypatch, stage):
    pipeline.research_depth = "quick"
    run_step = AsyncMock(return_value=SimpleNamespace(text="BODY"))
    monkeypatch.setattr(pipeline_module, "run_labeled_step", run_step)
    await pipeline._run_labeled_step(
        client=None,
        messages=[],
        tool_schemas=None,
        protocol=pipeline_module._PROTOCOL_BLOCK,
        stream=StreamBus(),
        stage=stage,
        iter_meta={},
        max_tokens=321,
    )
    assert_thinking(run_step.call_args.kwargs["completion_kwargs"], enabled=True, budget=321)
    # Native block loops also use this unmodified path directly.
    assert_thinking(pipeline._completion_kwargs(500), enabled=True, budget=500)


@pytest.mark.parametrize("effort", [None, "high", "minimal"])
async def test_note_sidecar_uses_direct_output_unless_user_overrides(pipeline, effort):
    pipeline.reasoning_effort = effort
    create = AsyncMock(return_value=SimpleNamespace(choices=[]))
    client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
    assert (
        await pipeline._summarise_tool_result(
            tool_name="web_search",
            query="Topic",
            raw_answer="SOURCE",
            client=client,
        )
        == "SOURCE"
    )
    assert_thinking(
        create.call_args.kwargs,
        enabled=effort == "high",
        budget=pipeline_module.DEFAULT_NOTE_MAX_TOKENS,
    )


async def test_direct_output_does_not_add_unsupported_reasoning_to_regular_models(pipeline):
    pipeline.binding = "openai"
    pipeline.model = "gpt-4o"
    assert pipeline._completion_kwargs(100, prefer_direct_output=True) == {
        "temperature": 0.3,
        "max_completion_tokens": 100,
    }


@pytest.mark.parametrize("missing", ["intro", "section:a", "conclusion"])
@pytest.mark.parametrize("empty", ["", " \n ", "## Empty heading\n"])
async def test_empty_report_part_is_partial_and_resume_only_retries_missing_part(
    pipeline, monkeypatch, missing, empty
):
    complete_blocks(pipeline, monkeypatch)
    outline = ReportOutline("Report", (ReportSectionPlan("a", "Section", "", ("block_1",)),))
    monkeypatch.setattr(pipeline, "_gen_report_outline", AsyncMock(return_value=outline))
    writers = {}
    for key, method in (
        ("intro", "_write_intro"),
        ("section:a", "_write_section"),
        ("conclusion", "_write_conclusion"),
    ):
        writer = AsyncMock(return_value=empty if key == missing else f"BODY {key}")
        writers[key] = writer
        monkeypatch.setattr(pipeline, method, writer)

    first = await _run(pipeline)
    assert first["response"].strip()  # The title must not turn missing body into success.
    assert first["metadata"]["partial"] is True
    assert first["metadata"]["report_complete"] is False
    assert first["metadata"]["incomplete_report_steps"] == [missing]
    assert first["metadata"]["partial_reasons"] == ["incomplete_report_steps"]
    assert first["metadata"]["checkpoint_resumable"] is True
    assert pipeline.checkpoint.metadata()["status"] == "partial"

    writers[missing].return_value = f"RECOVERED {missing}"
    second = await _run(pipeline)
    assert second["metadata"]["partial"] is False
    assert second["metadata"]["report_complete"] is True
    assert second["metadata"]["incomplete_report_steps"] == []
    assert second["metadata"]["resumed_from_checkpoint"] is True
    for key, writer in writers.items():
        assert writer.await_count == (2 if key == missing else 1)
