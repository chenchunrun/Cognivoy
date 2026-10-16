"""Tests for mastery loop hooks that bind persisted pending questions."""

from __future__ import annotations

from pathlib import Path

from cognivoy.capabilities.mastery.loop import MasteryLoopCapability
from cognivoy.core.context import UnifiedContext
from cognivoy.learning.models import LearningProgress, PendingQuestion
from cognivoy.learning.storage import LearningStore


def _use_store_root(monkeypatch, root: Path) -> None:
    def _init(self, root_arg=None):
        self._root = root / "learning"
        self._root.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(LearningStore, "__init__", _init)


def _context() -> UnifiedContext:
    return UnifiedContext(
        user_message="continue",
        session_id="session-1",
        metadata={"mastery_mode": True, "mastery_path_id": "path-1", "turn_id": "turn-2"},
    )


def test_pending_question_overrides_reauthored_ask_user_mapping(tmp_path, monkeypatch):
    _use_store_root(monkeypatch, tmp_path)
    progress = LearningProgress(book_id="path-1")
    progress.pending_question = PendingQuestion(
        question_id="stable-question",
        knowledge_point_id="kp-1",
        prompt="Which colour?",
        question_type="choice",
        expected_answer="B",
        options=["A: red", "B: blue"],
    )
    LearningStore().save(progress)

    rebound = MasteryLoopCapability().augment_kwargs(
        "ask_user",
        {
            "intro": "Keep this lead-in",
            "questions": [
                {
                    "id": "new-question",
                    "prompt": "Rewritten question",
                    "options": [
                        {"label": "A", "description": "blue"},
                        {"label": "B", "description": "red"},
                    ],
                }
            ],
        },
        _context(),
    )

    assert rebound == {
        "intro": "Keep this lead-in",
        "questions": [
            {
                "id": "stable-question",
                "prompt": "Which colour?",
                "options": [
                    {"label": "A", "description": "red"},
                    {"label": "B", "description": "blue"},
                ],
                "multi_select": False,
                "allow_free_text": True,
            }
        ],
    }


def test_ask_user_is_untouched_without_pending_question(tmp_path, monkeypatch):
    _use_store_root(monkeypatch, tmp_path)
    LearningStore().save(LearningProgress(book_id="path-1"))
    authored = {"questions": [{"id": "clarify", "prompt": "Which scope?"}]}

    assert MasteryLoopCapability().augment_kwargs("ask_user", authored, _context()) == authored


def test_mastery_tools_receive_trusted_learning_task_context():
    context = _context()
    context.metadata["learning_context"] = {
        "project_id": "project-1",
        "task_id": "task-1",
        "objective": "Explain the concept",
    }

    rebound = MasteryLoopCapability().augment_kwargs(
        "learning_session_checkpoint",
        {"phase": "goal"},
        context,
    )

    assert rebound["_session_id"] == "session-1"
    assert rebound["_turn_id"] == "turn-2"
    assert rebound["_learning_context"] == context.metadata["learning_context"]
