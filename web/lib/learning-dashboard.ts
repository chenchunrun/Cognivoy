import type { ProgressSummary } from "@/lib/learning-api";
import type { NotebookEntry } from "@/lib/notebook-api";
import type { SessionSummary } from "@/lib/session-api";

export interface LearningDashboardSummary {
  dueReviews: number;
  weakTopics: string[];
  continueSession: SessionSummary | null;
  continuePath: ProgressSummary | null;
}

export function buildLearningDashboardSummary(
  sessions: SessionSummary[],
  paths: ProgressSummary[],
  wrongEntries: NotebookEntry[],
  dueReviews: number,
): LearningDashboardSummary {
  const weakTopics = [...new Set(wrongEntries.map((entry) => entry.question.trim()).filter(Boolean))]
    .slice(0, 3);
  const continueSession = [...sessions]
    .filter((session) => session.message_count > 0)
    .sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
  const continuePath = [...paths]
    .filter((path) => path.kp_count > 0 && path.avg_mastery_pct < 100)
    .sort((a, b) => b.updated_at - a.updated_at)[0] ?? null;
  return { dueReviews, weakTopics, continueSession, continuePath };
}
