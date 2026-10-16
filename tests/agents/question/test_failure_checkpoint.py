"""Quiz retries and cancellation must not preserve failed cards or orphan calls."""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from types import SimpleNamespace

import pytest

from cognivoy.agents.question import pipeline as pipeline_module
from cognivoy.agents.question.capability import DeepQuestionCapability
from cognivoy.agents.question.pipeline import QuestionPipeline, QuizPair
from cognivoy.core.context import UnifiedContext
from cognivoy.core.errors import CapabilityGenerationError
from cognivoy.core.stream import StreamEventType
from cognivoy.core.stream_bus import StreamBus
from cognivoy.services.session.stage_checkpoint import StageCheckpointStore


def _pair(question_id: str, **metadata) -> QuizPair:
    return QuizPair(
        question_id=question_id,
        question="What is 2 + 2?",
        question_type="short_answer",
        correct_answer="4",
        explanation="Addition.",
        topic="algebra",
        difficulty="medium",
        metadata=metadata,
    )


@pytest.fixture
def quiz(monkeypatch):
    monkeypatch.setattr(pipeline_module, "build_openai_client", lambda *_args: object())
    return QuestionPipeline(language="en")


def _checkpoint(quiz, tmp_path):
    store = StageCheckpointStore("deep_question", "failure-test", root=tmp_path)
    store.start(fingerprint="test")
    plan = quiz._build_fast_plan(
        topic="algebra",
        num_questions=3,
        difficulty="medium",
        allowed_types=["short_answer"],
        per_type_counts={},
    )
    store.save_stage("plan", {"templates": [asdict(template) for template in plan.templates]})
    return store


async def _run(quiz, *, fast_path=True, checkpoint=None, stream=None):
    return await quiz.run(
        context=UnifiedContext(
            user_message="algebra", config_overrides={"force_exploration": not fast_path}
        ),
        user_message="algebra",
        num_questions=3,
        stream=stream or StreamBus(),
        checkpoint=checkpoint,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("fast_path", [True, False])
async def test_retry_restores_only_successful_questions(quiz, monkeypatch, tmp_path, fast_path):
    checkpoint = _checkpoint(quiz, tmp_path)
    checkpoint.append_item("questions", "q_1", asdict(_pair("q_1")))
    checkpoint.append_item("questions", "q_2", asdict(_pair("q_2", error="generation_timeout")))
    checkpoint.append_item("questions", "q_3", asdict(_pair("q_3", retryable=True)))
    checkpoint.finish(status="completed")  # A legacy, incorrectly completed manifest.
    generated = []

    async def generate(*, template, **_kwargs):
        generated.append(template.question_id)
        return _pair(template.question_id)

    monkeypatch.setattr(quiz, "_quiz_one_direct", generate)
    monkeypatch.setattr(quiz, "_quiz_one_with_recovery", generate)
    result = await _run(quiz, fast_path=fast_path, checkpoint=checkpoint)

    assert generated == ["q_2", "q_3"]
    assert result["summary"]["completed"] == 3
    assert result["summary"]["success"] is True
    assert checkpoint.metadata()["status"] == "completed"
    assert all(not item["metadata"] for item in checkpoint.load_items("questions"))


@pytest.mark.asyncio
@pytest.mark.parametrize("fast_path", [True, False])
async def test_failed_questions_are_not_saved_as_completed(quiz, monkeypatch, tmp_path, fast_path):
    checkpoint = _checkpoint(quiz, tmp_path)

    async def generate(*, template, **_kwargs):
        return (
            _pair(template.question_id)
            if template.question_id == "q_1"
            else _pair(template.question_id, error="generation_timeout", retryable=True)
        )

    monkeypatch.setattr(quiz, "_quiz_one_direct", generate)
    monkeypatch.setattr(quiz, "_quiz_one_with_recovery", generate)
    result = await _run(quiz, fast_path=fast_path, checkpoint=checkpoint)

    assert result["summary"]["completed"] == 1
    assert result["summary"]["failed"] == 2
    assert result["metadata"]["partial"] is True
    assert result["metadata"]["checkpoint_resumable"] is True
    assert checkpoint.metadata()["status"] == "failed"
    assert [item["question_id"] for item in checkpoint.load_items("questions")] == ["q_1"]


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["cancel", "child_error", "emit_error"])
async def test_fast_quiz_cleans_up_all_owned_tasks(quiz, monkeypatch, failure):
    all_started = asyncio.Event()
    started = set()
    finished = set()
    bus = StreamBus()

    async def generate(*, template, **_kwargs):
        question_id = template.question_id
        started.add(question_id)
        if len(started) == 3:
            all_started.set()
        try:
            await all_started.wait()
            if question_id == "q_1" and failure == "child_error":
                raise RuntimeError("fake generation failure")
            if question_id == "q_1" and failure == "emit_error":
                return _pair(question_id)
            await asyncio.Event().wait()
        finally:
            finished.add(question_id)

    async def failed_emit(**_kwargs):
        raise RuntimeError("fake stream failure")

    monkeypatch.setattr(quiz, "_quiz_one_direct", generate)
    if failure == "emit_error":
        monkeypatch.setattr(quiz, "_emit_quiz_question", failed_emit)
    task = asyncio.create_task(_run(quiz, stream=bus))
    try:
        await asyncio.wait_for(all_started.wait(), timeout=1)
        if failure == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=1)
        else:
            with pytest.raises(RuntimeError, match="fake"):
                await asyncio.wait_for(task, timeout=1)
        assert finished == started == {"q_1", "q_2", "q_3"}
        assert not any(event.type == StreamEventType.RESULT for event in bus.history())
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("fast_path", [True, False])
async def test_no_usable_questions_fails_turn_but_preserves_retry_cards(
    quiz, monkeypatch, tmp_path, fast_path
):
    checkpoint = _checkpoint(quiz, tmp_path)

    async def generate(*, template, **_kwargs):
        return _pair(template.question_id, error="generation_timeout", retryable=True)

    monkeypatch.setattr(quiz, "_quiz_one_direct", generate)
    monkeypatch.setattr(quiz, "_quiz_one_with_recovery", generate)
    bus = StreamBus()
    with pytest.raises(CapabilityGenerationError) as caught:
        await _run(quiz, fast_path=fast_path, checkpoint=checkpoint, stream=bus)
    assert caught.value.reason == "empty_quiz"
    assert checkpoint.metadata()["status"] == "failed"
    assert checkpoint.load_items("questions") == []
    result = next(e.metadata for e in bus.history() if e.type == StreamEventType.RESULT)
    assert result["summary"]["completed"] == 0
    assert result["metadata"]["partial"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("language", ["en", "zh"])
@pytest.mark.parametrize("answer", [None, "", " \n "])
async def test_empty_followup_is_retryable_failure(monkeypatch, tmp_path, language, answer):
    class EmptyFollowup:
        def __init__(self, **_kwargs):
            pass

        def set_trace_callback(self, _callback):
            pass

        async def process(self, **_kwargs):
            return answer

    monkeypatch.setattr(
        "cognivoy.agents.question.agents.followup_agent.FollowupAgent", EmptyFollowup
    )
    monkeypatch.setattr(
        "cognivoy.services.llm.config.get_llm_config",
        lambda: SimpleNamespace(api_key="test", base_url="test", api_version="test"),
    )
    monkeypatch.setattr(
        "cognivoy.services.path_service.get_path_service",
        lambda: SimpleNamespace(get_task_workspace=lambda *_args: tmp_path),
    )
    bus = StreamBus()
    with pytest.raises(CapabilityGenerationError) as caught:
        await DeepQuestionCapability().run(
            UnifiedContext(
                user_message="Explain the answer.",
                language=language,
                metadata={"question_followup_context": {"question": "What is 2 + 2?"}},
            ),
            bus,
        )
    assert caught.value.reason == "empty_followup"
    assert not any(event.type == StreamEventType.RESULT for event in bus.history())
