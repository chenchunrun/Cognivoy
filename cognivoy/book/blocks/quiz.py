"""Quiz block – delegates to the existing question generation coordinator."""

from __future__ import annotations

import logging
from typing import Any

from ..models import BlockType, SourceAnchor
from .base import BlockContext, BlockGenerator, GenerationFailure

logger = logging.getLogger(__name__)


class QuizGenerator(BlockGenerator):
    block_type = BlockType.QUIZ

    async def _generate(
        self, ctx: BlockContext
    ) -> tuple[dict[str, Any], list[SourceAnchor], dict[str, Any]]:
        params = ctx.block.params
        chapter_title = params.get("chapter_title", ctx.chapter.title)
        chapter_summary = params.get("chapter_summary", ctx.chapter.summary)
        objectives = params.get("objectives") or ctx.chapter.learning_objectives
        num_questions = max(1, min(8, int(params.get("num_questions") or 3)))
        difficulty = str(params.get("difficulty") or "medium")
        question_type = str(params.get("question_type") or "")

        topic = chapter_title.strip() or ctx.book_id
        # Fold chapter context directly into the topic so the planner sees
        # it without needing a separate "preference" channel.
        extra_context = "; ".join(filter(None, [chapter_summary, *objectives]))
        if extra_context:
            topic = f"{topic}\n\n[Chapter context: {extra_context}]"
        question_types = [question_type] if question_type else []

        try:
            from cognivoy.agents.question.coordinator import AgentCoordinator

            coordinator = AgentCoordinator(
                kb_name=ctx.primary_kb,
                language=ctx.language,
                enable_idea_rag=ctx.rag_enabled and bool(ctx.primary_kb),
            )
            summary = await coordinator.generate_from_topic(
                user_topic=topic,
                num_questions=num_questions,
                difficulty=difficulty,
                question_types=question_types,
            )
        except Exception as exc:
            logger.warning(f"QuizGenerator failed: {exc}", exc_info=True)
            raise GenerationFailure(f"quiz generation failed: {exc}") from exc

        questions = self._extract_questions(summary)
        if not questions:
            raise GenerationFailure("no questions generated")

        questions = self._repair_degraded_questions(
            questions,
            chapter_title=chapter_title,
            objectives=[str(item).strip() for item in objectives if str(item).strip()],
            language=ctx.language,
        )

        degraded_questions = sum(
            1
            for question in questions
            if isinstance(question.get("generation_metadata"), dict)
            and question["generation_metadata"].get("error")
        )

        return (
            {"questions": questions, "topic": topic},
            [],
            {
                # The question pipeline deliberately returns a usable,
                # deterministic fallback card when the provider times out or
                # emits invalid structured output.  Its legacy ``success``
                # flag remains false so callers can observe the degradation,
                # but the Book surface must not discard a structurally valid
                # card and turn the whole block into ``no questions
                # generated``.
                "completed": len(questions),
                "failed": 0,
                "degraded": degraded_questions,
                "upstream_completed": summary.get("completed", 0),
                "upstream_failed": summary.get("failed", 0),
                "kb": ctx.primary_kb,
            },
        )

    @staticmethod
    def _extract_questions(summary: dict[str, Any]) -> list[dict[str, Any]]:
        results = summary.get("results") or []
        if not isinstance(results, list):
            return []
        out: list[dict[str, Any]] = []
        for idx, item in enumerate(results, start=1):
            if not isinstance(item, dict):
                continue
            qa = item.get("qa_pair") or {}
            if not isinstance(qa, dict):
                continue

            question = str(qa.get("question") or "").strip()
            correct_answer = str(qa.get("correct_answer") or "").strip()
            if not question or not correct_answer:
                continue

            raw_options = qa.get("options") or {}
            options = raw_options if isinstance(raw_options, dict) else {}
            generation_metadata = (
                dict(item.get("metadata")) if isinstance(item.get("metadata"), dict) else {}
            )
            out.append(
                {
                    "question_id": str(qa.get("question_id") or f"q_{idx}"),
                    "question": question,
                    "question_type": qa.get("question_type", "written"),
                    "options": options,
                    "correct_answer": correct_answer,
                    "explanation": qa.get("explanation", ""),
                    "difficulty": qa.get("difficulty", ""),
                    "concentration": qa.get("concentration", ""),
                    "generation_metadata": generation_metadata,
                }
            )
        return out

    @staticmethod
    def _repair_degraded_questions(
        questions: list[dict[str, Any]],
        *,
        chapter_title: str,
        objectives: list[str],
        language: str,
    ) -> list[dict[str, Any]]:
        """Turn provider-timeout cards into distinct, chapter-scoped checks.

        The question pipeline deliberately returns a usable fallback when its
        bounded model call times out.  A Book quiz asks for several cards with
        the same topic, though, so that generic fallback can repeat verbatim
        and expose the internal ``[Chapter context: ...]`` suffix.  Preserve
        successful model output and only rewrite cards explicitly marked as
        degraded.
        """

        zh = str(language).lower().startswith("zh")
        title = str(chapter_title).strip() or ("本章" if zh else "this chapter")
        repaired: list[dict[str, Any]] = []

        for index, original in enumerate(questions):
            question = dict(original)
            metadata = question.get("generation_metadata")
            if not isinstance(metadata, dict) or not metadata.get("error"):
                repaired.append(question)
                continue

            focus = objectives[index % len(objectives)] if objectives else title
            variant = index % 3
            if zh:
                prompts = (
                    f"围绕“{focus}”，解释其中最重要的概念，并给出一个具体应用示例。",
                    f"围绕“{focus}”，比较两种可行方案，说明各自适用条件与关键权衡。",
                    f"围绕“{focus}”，设计一个可实施方案，并说明失败风险、验证方法和改进措施。",
                )
                answers = (
                    "答案应准确定义核心概念，并给出与本章主题一致的具体示例。",
                    "答案应给出两种合理方案，从适用条件、收益、成本或风险等维度完成比较。",
                    "答案应包含实施步骤、至少一种失败风险、可验证的检查方法及对应改进措施。",
                )
                explanation = "模型生成超时，已按本章学习目标生成一组互不重复的降级自测题。"
            else:
                prompts = (
                    f"Explain the most important concept in “{focus}” and give one concrete application example.",
                    f"For “{focus}”, compare two viable approaches, including when to use each and the key trade-offs.",
                    f"For “{focus}”, design an implementable approach and describe a failure risk, a verification method, and a mitigation.",
                )
                answers = (
                    "A strong answer defines the core concept accurately and gives a concrete example relevant to the chapter.",
                    "A strong answer compares two reasonable approaches across applicability, benefits, cost, or risk.",
                    "A strong answer includes implementation steps, at least one failure risk, a verifiable check, and a mitigation.",
                )
                explanation = "Generation timed out, so distinct fallback checks were derived from the chapter objectives."

            question.update(
                {
                    "question": prompts[variant],
                    "question_type": "written",
                    "options": {},
                    "correct_answer": answers[variant],
                    "explanation": explanation,
                    "concentration": focus,
                    "generation_metadata": {
                        **metadata,
                        "book_fallback_variant": variant + 1,
                    },
                }
            )
            repaired.append(question)

        return repaired


__all__ = ["QuizGenerator"]
