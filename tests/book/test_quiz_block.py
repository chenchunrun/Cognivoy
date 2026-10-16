from __future__ import annotations

import pytest

from cognivoy.book.blocks.base import BlockContext
from cognivoy.book.blocks.quiz import QuizGenerator
from cognivoy.book.models import Block, BlockStatus, BlockType, Chapter, Page


def test_extract_questions_keeps_valid_degraded_fallback() -> None:
    summary = {
        "results": [
            {
                "success": False,
                "metadata": {
                    "error": "question_generation_timeout",
                    "retryable": True,
                },
                "qa_pair": {
                    "question_id": "q_1",
                    "question": "请解释智能体的工具调用循环。",
                    "question_type": "written",
                    "correct_answer": "应说明选择工具、执行、观察和继续决策。",
                    "explanation": "这是超时后的可作答降级题。",
                    "difficulty": "medium",
                },
            }
        ]
    }

    questions = QuizGenerator._extract_questions(summary)

    assert len(questions) == 1
    assert questions[0]["question_id"] == "q_1"
    assert questions[0]["question"].startswith("请解释")
    assert questions[0]["generation_metadata"] == {
        "error": "question_generation_timeout",
        "retryable": True,
    }


def test_extract_questions_keeps_normal_success_and_normalizes_missing_id() -> None:
    summary = {
        "results": [
            {
                "success": True,
                "qa_pair": {
                    "question": "Which component executes tools?",
                    "question_type": "choice",
                    "options": {"A": "Planner", "B": "Executor"},
                    "correct_answer": "B",
                },
            }
        ]
    }

    questions = QuizGenerator._extract_questions(summary)

    assert questions == [
        {
            "question_id": "q_1",
            "question": "Which component executes tools?",
            "question_type": "choice",
            "options": {"A": "Planner", "B": "Executor"},
            "correct_answer": "B",
            "explanation": "",
            "difficulty": "",
            "concentration": "",
            "generation_metadata": {},
        }
    ]


def test_extract_questions_rejects_unusable_result() -> None:
    summary = {
        "results": [
            {"success": False, "qa_pair": {}},
            {"success": True, "qa_pair": {"question": "Missing answer"}},
            {"success": True, "qa_pair": {"correct_answer": "Missing question"}},
            {"success": True, "qa_pair": "not-an-object"},
        ]
    }

    assert QuizGenerator._extract_questions(summary) == []


def test_repair_degraded_questions_are_distinct_and_hide_internal_context() -> None:
    degraded = [
        {
            "question_id": f"q_{index}",
            "question": "请解释主题。[Chapter context: internal]",
            "question_type": "written",
            "options": {},
            "correct_answer": "fallback",
            "explanation": "timeout",
            "difficulty": "medium",
            "concentration": "internal",
            "generation_metadata": {"error": "question_generation_timeout"},
        }
        for index in range(1, 4)
    ]

    repaired = QuizGenerator._repair_degraded_questions(
        degraded,
        chapter_title="工具调用",
        objectives=["理解工具契约", "处理调用失败", "验证工具结果"],
        language="zh",
    )

    assert len({item["question"] for item in repaired}) == 3
    assert all("Chapter context" not in item["question"] for item in repaired)
    assert [item["concentration"] for item in repaired] == [
        "理解工具契约",
        "处理调用失败",
        "验证工具结果",
    ]
    assert [item["generation_metadata"]["book_fallback_variant"] for item in repaired] == [
        1,
        2,
        3,
    ]


def test_repair_degraded_questions_preserves_successful_model_output() -> None:
    successful = {
        "question_id": "q_1",
        "question": "模型生成的问题",
        "question_type": "choice",
        "options": {"A": "正确", "B": "错误"},
        "correct_answer": "A",
        "explanation": "模型解释",
        "difficulty": "medium",
        "concentration": "工具调用",
        "generation_metadata": {},
    }

    assert QuizGenerator._repair_degraded_questions(
        [successful],
        chapter_title="工具调用",
        objectives=[],
        language="zh",
    ) == [successful]


@pytest.mark.asyncio
async def test_generate_marks_valid_fallback_quiz_ready(monkeypatch) -> None:
    from cognivoy.agents.question.coordinator import AgentCoordinator

    async def fake_generate_from_topic(self, **_kwargs):
        return {
            "completed": 0,
            "failed": 1,
            "results": [
                {
                    "success": False,
                    "metadata": {
                        "error": "question_generation_timeout",
                        "retryable": True,
                    },
                    "qa_pair": {
                        "question_id": "q_1",
                        "question": "请说明智能体如何选择并调用工具。",
                        "question_type": "written",
                        "correct_answer": "根据目标选择工具，校验参数并处理观察结果。",
                        "explanation": "降级题仍满足书籍测验契约。",
                        "difficulty": "medium",
                    },
                }
            ],
        }

    monkeypatch.setattr(AgentCoordinator, "generate_from_topic", fake_generate_from_topic)
    chapter = Chapter(id="chapter-1", title="工具调用")
    page = Page(id="page-1", book_id="book-1", chapter_id=chapter.id)
    block = Block(type=BlockType.QUIZ, params={"num_questions": 1})
    context = BlockContext(
        book_id="book-1",
        chapter=chapter,
        page=page,
        block=block,
        language="zh",
        rag_enabled=False,
    )

    generated = await QuizGenerator().generate(context)

    assert generated.status == BlockStatus.READY
    assert generated.error == ""
    assert generated.payload["questions"][0]["question_id"] == "q_1"
    assert generated.metadata["completed"] == 1
    assert generated.metadata["failed"] == 0
    assert generated.metadata["degraded"] == 1
    assert generated.metadata["upstream_completed"] == 0
    assert generated.metadata["upstream_failed"] == 1
