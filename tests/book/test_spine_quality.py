from cognivoy.book.agents.spine_synthesizer import _ensure_learning_objectives
from cognivoy.book.models import Chapter


def test_empty_chapter_objectives_receive_structural_fallback() -> None:
    chapters = [Chapter(title="访问控制审计")]

    _ensure_learning_objectives(chapters, language="zh")

    assert len(chapters[0].learning_objectives) == 3
    assert all("来源" not in item for item in chapters[0].learning_objectives)


def test_existing_objectives_are_preserved() -> None:
    chapters = [Chapter(title="Access control", learning_objectives=["Verify IAM evidence"])]

    _ensure_learning_objectives(chapters, language="en")

    assert chapters[0].learning_objectives == ["Verify IAM evidence"]
