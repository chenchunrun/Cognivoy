import { apiUrl, apiFetch } from "./api";

export interface ModuleInit {
  id: string;
  name: string;
  order: number;
  pass_threshold?: number;
  knowledge_points: {
    id: string;
    name: string;
    type: string;
    module_id: string;
  }[];
}

export interface LearningKnowledgePoint {
  id: string;
  name: string;
  type: string;
}

export interface LearningModule {
  id: string;
  name: string;
  order: number;
  pass_threshold: number;
  knowledge_points: LearningKnowledgePoint[];
}

export interface ProgressDetail {
  book_id: string;
  modules: LearningModule[];
  mastery_levels: Record<string, number>;
  current_module_id?: string;
  current_stage?: string;
  diagnostic?: unknown;
}

export async function fetchProgress(bookId: string): Promise<ProgressDetail> {
  const res = await apiFetch(
    apiUrl(`/api/v1/learning/progress/${encodeURIComponent(bookId)}`),
  );
  if (!res.ok) throw new Error(`Failed to fetch progress: ${res.status}`);
  return res.json() as Promise<ProgressDetail>;
}

export async function initModules(bookId: string, modules: ModuleInit[]) {
  const res = await apiFetch(
    apiUrl(`/api/v1/learning/progress/${encodeURIComponent(bookId)}/init-modules`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules }),
    },
  );
  if (!res.ok) throw new Error(`Failed to init modules: ${res.status}`);
  return res.json();
}

// ── Mastery map (the dashboard view) ──────────────────────────────────────
// Mirrors cognivoy/learning/policy.py map_summary + next_objective.

export type ObjectiveStatus = "new" | "learning" | "mastered";

export interface MapKnowledgePoint {
  id: string;
  name: string;
  type: string;
  status: ObjectiveStatus;
  mastery: number;
  evidence_count: number;
  recent_evidence?: {
    question_id: string;
    is_correct: boolean;
    timestamp: number;
    hints_used: number;
    elapsed_ms?: number | null;
    source_refs: string[];
    judge_confidence?: number | null;
  } | null;
  next_review_at?: number | null;
  reason: string;
}

export interface MapModule {
  id: string;
  name: string;
  order: number;
  depends_on: string[];
  locked: boolean;
  mastered: number;
  total: number;
  knowledge_points: MapKnowledgePoint[];
}

export interface MasteryMap {
  counts: { mastered: number; learning: number; new: number; total: number };
  due_reviews: number;
  complete: boolean;
  mastery_score_version: string;
  evidence_count: number;
  current_streak_days: number;
  edges: { from: string; to: string }[];
  modules: MapModule[];
}

export interface NextStep {
  action: string;
  knowledge_point_name: string;
  knowledge_point_type: string;
  status: string;
  mastery: number;
  threshold: number;
  reason: string;
}

export interface MasteryMapResult {
  book_id: string;
  next: NextStep;
  map: MasteryMap;
}

export async function fetchMasteryMap(
  pathId: string,
): Promise<MasteryMapResult> {
  const res = await apiFetch(
    apiUrl(`/api/v1/learning/progress/${encodeURIComponent(pathId)}/map`),
  );
  if (!res.ok) throw new Error(`Failed to fetch mastery map: ${res.status}`);
  return res.json() as Promise<MasteryMapResult>;
}

export interface ProgressSummary {
  book_id: string;
  name: string;
  modules_count: number;
  kp_count: number;
  current_stage: string;
  avg_mastery_pct: number;
  due_reviews: number;
  evidence_count: number;
  current_streak_days: number;
  updated_at: number;
}

export interface ProgressListResult {
  summaries: ProgressSummary[];
  errors: { book_id: string; error: string }[];
}

export interface ProgressSummaryGroup {
  key: string;
  name: string;
  items: ProgressSummary[];
}

/** Group equivalent path names without hiding or deleting historical paths. */
export function groupProgressSummaries(
  summaries: ProgressSummary[],
): ProgressSummaryGroup[] {
  const groups = new Map<string, ProgressSummaryGroup>();
  for (const summary of summaries) {
    const normalized = summary.name.trim().replace(/\s+/g, " ").toLocaleLowerCase();
    const key = normalized || summary.book_id;
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(summary);
    } else {
      groups.set(key, { key, name: summary.name, items: [summary] });
    }
  }
  return [...groups.values()];
}

export async function fetchAllProgress(): Promise<ProgressListResult> {
  const res = await apiFetch(apiUrl("/api/v1/learning/progress"));
  if (!res.ok) throw new Error(`Failed to fetch all progress: ${res.status}`);
  return res.json();
}

export async function deleteProgress(bookId: string) {
  const res = await apiFetch(
    apiUrl(`/api/v1/learning/progress/${encodeURIComponent(bookId)}`),
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Failed to delete progress: ${res.status}`);
  return res.json();
}

export async function redoProgress(bookId: string) {
  const res = await apiFetch(
    apiUrl(`/api/v1/learning/progress/${encodeURIComponent(bookId)}/redo`),
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to redo progress: ${res.status}`);
  return res.json();
}

export interface RedoArchiveSummary {
  id: string;
  book_id: string;
  reason: string;
  created_at: number;
  source_version: number;
  mastery_count: number;
  attempt_count: number;
  error_count: number;
  restore_count: number;
  last_restored_at?: number | null;
}

export async function fetchRedoHistory(
  bookId: string,
): Promise<RedoArchiveSummary[]> {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/learning/progress/${encodeURIComponent(bookId)}/redo-history`,
    ),
  );
  if (!res.ok) throw new Error(`Failed to fetch reset history: ${res.status}`);
  const data = (await res.json()) as { items?: RedoArchiveSummary[] };
  return data.items ?? [];
}

export async function restoreRedoArchive(bookId: string, auditId: string) {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/learning/progress/${encodeURIComponent(bookId)}/redo/${encodeURIComponent(auditId)}/restore`,
    ),
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to restore progress: ${res.status}`);
  return res.json();
}

export async function importFromBook(
  bookId: string,
  chapters: { title: string; knowledge_points: string[] }[],
) {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/learning/progress/${encodeURIComponent(bookId)}/import-from-book`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapters }),
    },
  );
  if (!res.ok) throw new Error(`Failed to import from book: ${res.status}`);
  return res.json();
}

export async function generateModulesFromNotebook(
  bookId: string,
  notebookId: string,
  records: { id: string; type: string; title: string; output: string }[],
): Promise<{ modules: ModuleInit[] }> {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/learning/progress/${encodeURIComponent(bookId)}/generate-from-notebook`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notebook_id: notebookId, records }),
    },
  );
  if (!res.ok)
    throw new Error(`Failed to generate modules from notebook: ${res.status}`);
  return res.json();
}
