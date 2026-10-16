const STAGE_LABELS: Record<string, string> = {
  exploring: "Understanding your goal · about 10–20 seconds",
  rephrasing: "Clarifying the research question · about 10–20 seconds",
  decomposing: "Planning the research steps · about 10–20 seconds",
  planning: "Planning the solution · about 10–20 seconds",
  reasoning: "Working through the solution",
  verification: "Checking the answer",
  responding: "Preparing the explanation",
  ideation: "Designing suitable questions · about 10–15 seconds",
  generation: "Creating questions · completed cards appear as they are ready",
  quizzing: "Creating questions · completed cards appear as they are ready",
  generating: "Creating the visualization",
  analyzing: "Analyzing the learning goal · about 10–20 seconds",
  reviewing: "Checking the result",
  reporting: "Writing the research report",
  researching: "Collecting and comparing sources",
  code_generation: "Building the animation",
  code_retry: "Repairing the animation",
  render_output: "Rendering the final animation",
  summary: "Preparing the learning summary",
};

export function learningStageLabel(stage: string, capability = ""): string {
  if (capability === "deep_question" && stage === "responding") {
    return "Creating questions · completed cards appear as they are ready";
  }
  return STAGE_LABELS[stage] || "Preparing the next learning step";
}
