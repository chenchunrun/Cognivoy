"""Callout block – key idea / common pitfall / summary highlight.

Prompts live in ``cognivoy/book/prompts/{en,zh}/callout.yaml``.
"""

from __future__ import annotations

from typing import Any

from ..models import BlockType, SourceAnchor
from ._llm_writer import llm_text
from ._prompts import get_book_prompt, load_book_prompts
from .base import BlockContext, BlockGenerator

_VARIANT_LABELS = {
    "key_idea": ("Key Idea", "核心要点"),
    "common_pitfall": ("Watch Out", "常见误区"),
    "summary": ("Summary", "小结"),
    "tip": ("Tip", "小提示"),
}


class CalloutGenerator(BlockGenerator):
    block_type = BlockType.CALLOUT

    async def _generate(
        self, ctx: BlockContext
    ) -> tuple[dict[str, Any], list[SourceAnchor], dict[str, Any]]:
        params = ctx.block.params
        variant = str(params.get("variant") or "key_idea")
        labels = _VARIANT_LABELS.get(variant, _VARIANT_LABELS["key_idea"])
        label = labels[1] if ctx.language == "zh" else labels[0]

        chapter_title = params.get("chapter_title", ctx.chapter.title)
        chapter_summary = params.get("chapter_summary", ctx.chapter.summary)
        objectives = params.get("objectives") or ctx.chapter.learning_objectives

        prompts = load_book_prompts("callout", ctx.language)
        none_label = "(无)" if ctx.language == "zh" else "(none)"
        user_prompt = get_book_prompt(prompts, "user_template").format(
            chapter_title=chapter_title,
            chapter_summary=chapter_summary or none_label,
            objectives_inline="; ".join(objectives) or none_label,
            variant=variant,
            label=label,
        )
        body = await llm_text(
            user_prompt=user_prompt,
            system_prompt=get_book_prompt(prompts, "system"),
            max_tokens=250,
            temperature=0.5,
            language=ctx.language,
        )
        degraded = not body.strip()
        if degraded:
            body = self._fallback_body(
                variant=variant,
                chapter_title=str(chapter_title),
                chapter_summary=str(chapter_summary or ""),
                objectives=[str(item).strip() for item in objectives if str(item).strip()],
                language=ctx.language,
            )
        return (
            {"variant": variant, "label": label, "body": body},
            [],
            {"degraded": degraded},
        )

    @staticmethod
    def _fallback_body(
        *,
        variant: str,
        chapter_title: str,
        chapter_summary: str,
        objectives: list[str],
        language: str,
    ) -> str:
        """Provide useful copy when the bounded callout model call is empty."""

        zh = str(language).lower().startswith("zh")
        title = chapter_title.strip() or ("本章主题" if zh else "the chapter topic")
        focus = objectives[0] if objectives else chapter_summary.strip()
        if not focus:
            focus = title

        if zh:
            templates = {
                "common_pitfall": (
                    f"不要只记住“{title}”的术语而忽略适用边界。实践时应围绕“{focus}”"
                    "明确输入、输出、失败条件和验证方法，并为异常路径准备降级或回滚方案。"
                ),
                "summary": f"本章围绕“{title}”展开，核心是：{focus}。请把概念、实现步骤与验证证据连成闭环。",
                "tip": f"先用最小可运行示例验证“{focus}”，再逐步增加工具、状态和生产约束。",
                "key_idea": f"理解“{title}”时，应抓住这一主线：{focus}，并用可执行示例和测试验证它。",
            }
        else:
            templates = {
                "common_pitfall": (
                    f"Do not memorize the terminology of “{title}” without its operating boundaries. "
                    f"For “{focus}”, define inputs, outputs, failure conditions, verification, and a fallback or rollback path."
                ),
                "summary": f"This chapter centers on “{title}”. The key objective is: {focus}. Connect the concept, implementation, and verification evidence.",
                "tip": f"Validate “{focus}” with the smallest runnable example before adding tools, state, and production constraints.",
                "key_idea": f"The main thread of “{title}” is: {focus}. Confirm it with an executable example and tests.",
            }
        return templates.get(variant, templates["key_idea"])


__all__ = ["CalloutGenerator"]
