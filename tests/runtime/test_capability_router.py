from cognivoy.core.context import UnifiedContext
from cognivoy.runtime.capability_router import route_capability


def _route(text: str) -> str:
    return route_capability(UnifiedContext(user_message=text, language="zh"))


def test_auto_router_covers_explicit_learning_intents() -> None:
    assert _route("请给我出三道二次方程练习题") == "deep_question"
    assert _route("深度研究 RAG 的最新论文") == "deep_research"
    assert _route("把正弦函数画成可视化动画") == "visualize"
    assert _route("求解 x²-5x+6=0 并验证") == "deep_solve"
    assert _route("为线性代数建立精通之路") == "mastery_path"


def test_auto_router_defaults_ordinary_tutoring_to_chat() -> None:
    assert _route("用苏格拉底式教学帮助我理解判别式") == "chat"
    assert _route("简单讲一下 Transformer 架构") == "chat"


def test_auto_router_keeps_continuous_technical_followups_in_chat() -> None:
    # Technical follow-ups need the preceding conversational subject. The chat
    # prompt applies the deep-dive evidence policy without switching into the
    # outline-oriented deep-research workflow.
    assert _route("深入讲并行采样的技术原理") == "chat"
    assert _route("深入讲 RLCD 训练") == "chat"
    assert _route("解释 Jev 的底层实现机制") == "chat"
    assert _route("Show me the implementation details under the hood") == "chat"


def test_auto_router_keeps_math_derivation_in_deep_solve() -> None:
    assert _route("深入推导这个方程并验证解") == "deep_solve"
