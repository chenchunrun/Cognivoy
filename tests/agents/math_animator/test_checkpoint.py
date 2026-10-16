from __future__ import annotations

from types import SimpleNamespace

import pytest

from cognivoy.agents.math_animator.checkpoint import MathAnimatorCheckpointStore
from cognivoy.agents.math_animator.models import (
    ConceptAnalysis,
    GeneratedCode,
    RenderResult,
    SceneDesign,
    SummaryPayload,
)
from cognivoy.core.context import UnifiedContext
from cognivoy.core.stream import StreamEventType
from cognivoy.core.stream_bus import StreamBus


def test_math_animator_checkpoint_restores_completed_stage_models(tmp_path) -> None:
    store = MathAnimatorCheckpointStore("turn_1", root=tmp_path)
    store.start(fingerprint="request-a")
    store.save_stage(
        "concept_analysis",
        ConceptAnalysis(learning_goal="Understand sine", math_focus=["period"]),
    )
    store.save_stage(
        "code_generation",
        GeneratedCode(code="class Scene: pass", rationale="minimal"),
    )

    reopened = MathAnimatorCheckpointStore("turn_1", root=tmp_path)
    reopened.start(fingerprint="request-a")

    analysis = reopened.load_stage("concept_analysis", ConceptAnalysis)
    generated = reopened.load_stage("code_generation", GeneratedCode)
    assert analysis is not None and analysis.learning_goal == "Understand sine"
    assert generated is not None and generated.code == "class Scene: pass"
    assert reopened.metadata()["resume_count"] == 1


def test_math_animator_checkpoint_drops_stages_for_a_different_request(tmp_path) -> None:
    store = MathAnimatorCheckpointStore("turn_1", root=tmp_path)
    store.start(fingerprint="request-a")
    store.save_stage("concept_analysis", ConceptAnalysis(learning_goal="Old"))

    store.start(fingerprint="request-b")

    assert store.load_stage("concept_analysis", ConceptAnalysis) is None
    assert store.metadata()["fingerprint"] == "request-b"
    assert store.metadata()["resume_count"] == 0


def test_math_animator_checkpoint_marks_terminal_state(tmp_path) -> None:
    store = MathAnimatorCheckpointStore("turn_1", root=tmp_path)
    store.start(fingerprint="request-a")
    store.finish(status="completed")

    assert store.metadata()["status"] == "completed"


@pytest.mark.asyncio
async def test_math_animator_capability_skips_completed_stages_on_resume(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from cognivoy.agents.math_animator import availability, checkpoint, pipeline
    from cognivoy.agents.math_animator.capability import MathAnimatorCapability

    analysis = ConceptAnalysis(learning_goal="Understand sine")
    design = SceneDesign(title="Sine")
    generated = GeneratedCode(code="class SineScene: pass")
    rendered = RenderResult(output_mode="image", artifacts=[])
    summary = SummaryPayload(summary_text="Recovered animation")
    finished: list[str] = []

    class FakeCheckpoint:
        def __init__(self, _turn_id: str) -> None:
            pass

        def start(self, *, fingerprint: str):
            assert fingerprint
            return {"resume_count": 1, "stages": {"concept_analysis": {}}}

        def load_stage(self, stage: str, _model):
            return {
                "concept_analysis": analysis,
                "concept_design": design,
                "code_generation": generated,
                "summary": summary,
            }.get(stage)

        def load_dict(self, stage: str):
            assert stage == "code_retry"
            return {"code": generated.code, "render_result": rendered.model_dump()}

        def save_stage(self, *_args, **_kwargs) -> None:
            raise AssertionError("a restored stage must not be recomputed")

        def finish(self, *, status: str) -> None:
            finished.append(status)

    class FakePipeline:
        def __init__(self, **_kwargs) -> None:
            pass

        def __getattr__(self, name: str):
            if name.startswith("run_"):
                raise AssertionError(f"restored pipeline unexpectedly called {name}")
            raise AttributeError(name)

    monkeypatch.setattr(checkpoint, "MathAnimatorCheckpointStore", FakeCheckpoint)
    monkeypatch.setattr(pipeline, "MathAnimatorPipeline", FakePipeline)
    monkeypatch.setattr(availability, "require_math_animator_ready", lambda: None)
    monkeypatch.setattr(
        "cognivoy.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(
            api_key="test", base_url="http://test", api_version="v1", model="test"
        ),
    )

    bus = StreamBus()
    await MathAnimatorCapability().run(
        UnifiedContext(
            session_id="session-1",
            user_message="animate sine",
            language="en",
            config_overrides={"output_mode": "image"},
            metadata={"turn_id": "turn-1"},
        ),
        bus,
    )

    result = next(event for event in bus.history() if event.type == StreamEventType.RESULT)
    assert result.metadata["render"]["resumed_from_checkpoint"] is True
    assert result.metadata["response"] == "Recovered animation"
    assert finished == ["completed"]
