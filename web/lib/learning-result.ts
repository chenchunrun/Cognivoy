import type { StreamEvent } from "@/lib/unified-ws";

export interface LearningResult {
  projectId: string;
  taskId: string;
  objective: string;
  masteryBefore: number | null;
  masteryAfter: number | null;
  evidenceConfidence: "high";
  evidenceRefs: string[];
  reviewDueCount: number;
  nextReviewAt: number | null;
  nextTask: { id: string; objective: string } | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function extractLearningResult(
  events: StreamEvent[] | undefined,
): LearningResult | null {
  const done = [...(events ?? [])]
    .reverse()
    .find((event) => event.type === "done");
  const raw = record(done?.metadata?.learning_result);
  if (!raw) return null;
  const projectId = typeof raw.project_id === "string" ? raw.project_id : "";
  const taskId = typeof raw.task_id === "string" ? raw.task_id : "";
  const objective = typeof raw.objective === "string" ? raw.objective : "";
  if (!projectId || !taskId || !objective || raw.evidence_confidence !== "high") {
    return null;
  }
  const next = record(raw.next_task);
  const nextId = typeof next?.id === "string" ? next.id : "";
  const nextObjective = typeof next?.objective === "string" ? next.objective : "";
  return {
    projectId,
    taskId,
    objective,
    masteryBefore: finiteNumber(raw.mastery_before),
    masteryAfter: finiteNumber(raw.mastery_after),
    evidenceConfidence: "high",
    evidenceRefs: Array.isArray(raw.evidence_refs)
      ? raw.evidence_refs.filter((item): item is string => typeof item === "string")
      : [],
    reviewDueCount:
      typeof raw.review_due_count === "number" && raw.review_due_count >= 0
        ? raw.review_due_count
        : 0,
    nextReviewAt: finiteNumber(raw.next_review_at),
    nextTask:
      nextId && nextObjective ? { id: nextId, objective: nextObjective } : null,
  };
}
