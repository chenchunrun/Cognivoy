"""Deterministic, zero-latency routing for the learner-facing Auto mode."""

from __future__ import annotations

import re

from cognivoy.core.context import UnifiedContext

_QUIZ = re.compile(r"(出题|测验|练习题|题目卡|quiz|practice questions?|test me)", re.I)
_RESEARCH = re.compile(r"(深度研究|调研|文献综述|论文检索|research|literature review)", re.I)
_VISUALIZE = re.compile(r"(可视化|画图|图表|流程图|动画|visuali[sz]e|diagram|chart|animate)", re.I)
_SOLVE = re.compile(
    r"(求解|解方程|证明|计算|推导|验证.*解|solve|prove|calculate|derive|equation)", re.I
)
_MASTERY = re.compile(r"(精通之路|掌握.*知识点|学习路径|mastery path|guided learning)", re.I)


def route_capability(context: UnifiedContext) -> str:
    """Return the best built-in capability, defaulting safely to chat."""
    text = str(context.user_message or "").strip()
    if _QUIZ.search(text):
        return "deep_question"
    if _RESEARCH.search(text):
        return "deep_research"
    if _VISUALIZE.search(text):
        return "visualize"
    if _MASTERY.search(text):
        return "mastery_path"
    if _SOLVE.search(text):
        return "deep_solve"
    return "chat"


__all__ = ["route_capability"]
