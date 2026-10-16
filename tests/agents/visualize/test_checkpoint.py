from __future__ import annotations

from types import SimpleNamespace

import pytest

from cognivoy.agents.math_animator.models import (
    ConceptAnalysis,
    GeneratedCode,
    RenderResult,
    SceneDesign,
    SummaryPayload,
)
from cognivoy.agents.visualize.models import ReviewResult, VisualizationAnalysis
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream import StreamEventType
from cognivoy.core.stream_bus import StreamBus


@pytest.mark.asyncio
async def test_visualize_restores_completed_lightweight_stages_without_llm(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cognivoy.agents.visualize import pipeline
    from cognivoy.agents.visualize.capability import VisualizeCapability
    from cognivoy.services.session import stage_checkpoint

    analysis = VisualizationAnalysis(render_type="svg", description="Recovered")
    review = ReviewResult(
        optimized_code="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'><circle r='5'/></svg>",
        changed=False,
        review_notes="restored",
    )
    finished: list[str] = []

    class FakeCheckpoint:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def start(self, *, fingerprint: str):
            assert fingerprint
            return {"resume_count": 1, "stages": {"reviewing": {}}}

        def load_stage(self, stage: str):
            return {
                "analyzing": {"analysis": analysis.model_dump(mode="json")},
                "generating": {
                    "code": review.optimized_code,
                    "render_type": "svg",
                },
                "reviewing": {
                    "final_code": review.optimized_code,
                    "render_type": "svg",
                    "review": review.model_dump(mode="json"),
                },
            }.get(stage)

        def save_stage(self, *_args, **_kwargs) -> None:
            raise AssertionError("restored stage must not be recomputed")

        def finish(self, *, status: str) -> None:
            finished.append(status)

    class FakePipeline:
        def __init__(self, **_kwargs) -> None:
            pass

        def __getattr__(self, name: str):
            if name.startswith("run_"):
                raise AssertionError(f"restored pipeline unexpectedly called {name}")
            raise AttributeError(name)

    monkeypatch.setattr(stage_checkpoint, "StageCheckpointStore", FakeCheckpoint)
    monkeypatch.setattr(pipeline, "VisualizePipeline", FakePipeline)
    monkeypatch.setattr(
        "cognivoy.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(
            api_key="test", base_url="http://test", api_version="v1", model="test"
        ),
    )

    bus = StreamBus()
    await VisualizeCapability().run(
        UnifiedContext(
            session_id="session-1",
            user_message="draw a circle",
            language="en",
            metadata={"turn_id": "turn-1"},
        ),
        bus,
    )

    result = next(event for event in bus.history() if event.type == StreamEventType.RESULT)
    assert result.metadata["render_type"] == "svg"
    assert result.metadata["review"]["review_notes"] == "restored"
    assert result.metadata["resumed_from_checkpoint"] is True
    assert finished == ["completed"]


@pytest.mark.asyncio
async def test_visualize_manim_branch_restores_render_checkpoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cognivoy.agents.math_animator import availability
    from cognivoy.agents.math_animator import pipeline as manim_pipeline
    from cognivoy.agents.visualize import pipeline as visualize_pipeline
    from cognivoy.agents.visualize.capability import VisualizeCapability
    from cognivoy.services.session import stage_checkpoint

    finished: list[str] = []
    values = {
        "analyzing": {
            "analysis": VisualizationAnalysis(
                render_type="manim_video", description="Recovered"
            ).model_dump(mode="json")
        },
        "manim_concept_analysis": ConceptAnalysis(learning_goal="sine").model_dump(),
        "manim_concept_design": SceneDesign(title="Sine").model_dump(),
        "manim_code_generation": GeneratedCode(code="class Sine: pass").model_dump(),
        "manim_code_retry": {
            "code": "class Sine: pass",
            "render_result": RenderResult(output_mode="video", artifacts=[]).model_dump(),
        },
        "manim_summary": SummaryPayload(summary_text="Recovered video").model_dump(),
    }

    class FakeCheckpoint:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        def start(self, *, fingerprint: str):
            return {"resume_count": 1, "status": "running", "stages": values}

        def load_stage(self, stage: str):
            return values.get(stage)

        def save_stage(self, *_args, **_kwargs):
            raise AssertionError("restored Manim stage must not run again")

        def finish(self, *, status: str):
            finished.append(status)

    class NoCallsPipeline:
        def __init__(self, **_kwargs) -> None:
            pass

        def __getattr__(self, name: str):
            if name.startswith("run_"):
                raise AssertionError(f"restored pipeline unexpectedly called {name}")
            raise AttributeError(name)

    monkeypatch.setattr(stage_checkpoint, "StageCheckpointStore", FakeCheckpoint)
    monkeypatch.setattr(visualize_pipeline, "VisualizePipeline", NoCallsPipeline)
    monkeypatch.setattr(manim_pipeline, "MathAnimatorPipeline", NoCallsPipeline)
    monkeypatch.setattr(availability, "require_math_animator_ready", lambda: None)
    monkeypatch.setattr(
        "cognivoy.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(
            api_key="test", base_url="http://test", api_version="v1", model="test"
        ),
    )

    bus = StreamBus()
    await VisualizeCapability().run(
        UnifiedContext(
            session_id="session-1",
            user_message="animate sine",
            language="en",
            config_overrides={"render_mode": "manim_video"},
            metadata={"turn_id": "turn-manim"},
        ),
        bus,
    )

    result = next(event for event in bus.history() if event.type == StreamEventType.RESULT)
    assert result.metadata["render_type"] == "manim_video"
    assert result.metadata["render"]["resumed_from_checkpoint"] is True
    assert finished == ["completed"]
