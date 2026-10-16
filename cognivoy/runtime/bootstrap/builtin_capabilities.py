"""Built-in capability class paths."""

BUILTIN_CAPABILITY_CLASSES: dict[str, str] = {
    "chat": "cognivoy.agents.chat.capability:ChatCapability",
    "deep_solve": "cognivoy.capabilities.solve.capability:DeepSolveCapability",
    "deep_question": "cognivoy.agents.question.capability:DeepQuestionCapability",
    "deep_research": "cognivoy.agents.research.capability:DeepResearchCapability",
    "math_animator": "cognivoy.agents.math_animator.capability:MathAnimatorCapability",
    "visualize": "cognivoy.agents.visualize.capability:VisualizeCapability",
    "mastery_path": "cognivoy.capabilities.mastery.capability:MasteryPathCapability",
}
