import { apiFetch, apiUrl } from "./api";

export type LearningTaskStatus = "todo" | "in_progress" | "completed" | "skipped";
export type KnowledgeNodeStatus = "locked" | "ready" | "in_progress" | "mastered";

export interface LearningTask {
  id: string;
  project_id: string;
  objective: string;
  expected_minutes: number;
  intent: string;
  status: LearningTaskStatus;
  due_at?: number | null;
  completed_at?: number | null;
  version: number;
  project_version?: number;
  prerequisites?: string[];
  resource_refs?: string[];
}

export interface CourseReadinessIssue {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  action: string;
}

export interface CourseReadiness {
  status: "blocked" | "needs_attention" | "ready";
  score: number;
  issues: CourseReadinessIssue[];
  metrics: {
    planned_weeks: number;
    weekly_minutes: number;
    allocated_minutes: number;
    allocation_ratio: number;
    total_questions: number;
    unique_questions: number;
    duplicate_questions: number;
    attempted_questions: number;
    baseline_questions: number;
    baseline_attempted_questions: number;
    resource_counts: Record<string, number>;
  };
}

export interface LearningEvent {
  id: string;
  project_id: string;
  event_type: "project_created" | "project_updated" | "task_created" | "task_started" | "task_completed" | "task_skipped" | "mastery_updated" | "review_scheduled" | "assessment_completed" | "knowledge_map_updated" | "quiz_completed" | "mistake_recorded" | "review_completed" | "resource_activity" | "tutor_reminder" | "mentor_suggestion";
  title: string;
  description: string;
  task_id?: string | null;
  result_refs: string[];
  mastery_before?: number | null;
  mastery_after?: number | null;
  created_at: number;
}

export interface KnowledgeNode {
  id: string;
  title: string;
  description: string;
  status: KnowledgeNodeStatus;
  mastery: number;
  prerequisite_ids: string[];
  order: number;
}

export interface BaselineAssessment {
  status: "pending" | "completed" | "skipped";
  responses: Record<string, number>;
  score?: number | null;
  inferred_level?: string | null;
  completed_at?: number | null;
}

export interface ProjectReviewItem {
  id: string;
  title: string;
  knowledge_point: string;
  source_ref: string;
  mistake_category: "concept" | "prerequisite" | "calculation" | "misunderstanding" | "question_reading" | "expression" | "guessing" | "unknown";
  diagnostic_reason: string;
  diagnostic_confidence: number;
  diagnostic_evidence_count: number;
  due_at: number;
  status: "due" | "scheduled" | "completed" | "mastered";
  interval_days: number;
  attempt_count: number;
  correct_streak: number;
  last_reviewed_at?: number | null;
}

export interface LearningProject {
  id: string;
  title: string;
  language: "en" | "zh";
  motivation: string;
  current_level: string;
  target_level: string;
  existing_materials: string;
  deadline?: number | null;
  weekly_minutes: number;
  preferred_methods: string[];
  teaching_strategy: "adaptive" | "structured" | "visual_first" | "socratic" | "practice_first" | "example_first";
  difficulty_policy: "adaptive" | "foundation" | "guided" | "challenge";
  partner_id?: string | null;
  status: string;
  weekly_plan: string[];
  knowledge_map: KnowledgeNode[];
  baseline_assessment: BaselineAssessment;
  review_items: ProjectReviewItem[];
  review_preferences?: {
    intensity: "light" | "balanced" | "intensive";
    reminder_time: string;
    daily_question_limit: number;
    reminder_weekdays: number[];
    reminders_paused_until?: number | null;
  };
  knowledge_base_ids: string[];
  book_ids: string[];
  notebook_ids: string[];
  mastery_summary: number;
  weak_points: string[];
  due_review_count: number;
  next_review_at?: number | null;
  tasks: LearningTask[];
  events: LearningEvent[];
  version: number;
  updated_at: number;
  server_time?: number;
  analytics?: LearningProjectAnalytics;
  learning_status?: LearningStatusSnapshot;
  teaching_profile?: AdaptiveTeachingProfile;
  course_readiness?: CourseReadiness;
}

export type LearningNextActionKind =
  | "create_plan"
  | "baseline"
  | "review"
  | "continue"
  | "start"
  | "plan"
  | "completed";

export interface LearningNextAction {
  kind: LearningNextActionKind;
  project_id?: string | null;
  project_title?: string | null;
  title: string;
  reason: string;
  expected_minutes: number;
  task?: LearningTask | null;
}

export interface LearningStatusSnapshot {
  schema_version: 1;
  project_id: string;
  project_version: number;
  status: string;
  progress: {
    completed_tasks: number;
    total_tasks: number;
    completion_rate: number;
  };
  mastery: number;
  due_reviews: number;
  weak_point_count: number;
  next_action: LearningNextAction;
  updated_at: number;
}

export type LearningStatusSummary = Omit<LearningStatusSnapshot, "next_action">;

export interface AdaptiveTeachingProfile {
  difficulty: "foundation" | "guided" | "challenge";
  strategy: "structured" | "visual_first" | "socratic" | "practice_first" | "example_first";
  mastery: number;
  baseline_score?: number | null;
  weak_point_count: number;
  completed_task_count: number;
  reason_codes: string[];
}

export interface LearningProjectAnalytics {
  period_days: number;
  active_days: number;
  completed_tasks: number;
  study_minutes: number;
  review_attempts: number;
  quiz_attempts: number;
  mastery_delta: number;
  task_completion_rate: number;
  comparison?: {
    previous_period_days: number;
    active_days: number;
    completed_tasks: number;
    study_minutes: number;
    active_days_delta: number;
    completed_tasks_delta: number;
    study_minutes_delta: number;
  };
  daily: Array<{
    date: string;
    events: number;
    completed_tasks: number;
    reviews: number;
    quizzes: number;
  }>;
}

/** Minimal project shape used by the home dashboard.
 *
 * Project detail records can contain a long event history, review evidence,
 * and a knowledge graph. None of that belongs on the critical home-page
 * path, so the dashboard contract deliberately exposes only what its cards
 * render.
 */
export interface LearningProjectSummary {
  id: string;
  title: string;
  language: "en" | "zh";
  motivation: string;
  status: string;
  mastery_summary: number;
  weak_points: string[];
  due_review_count: number;
  next_review_at?: number | null;
  version: number;
  updated_at: number;
  analytics?: Pick<LearningProjectAnalytics, "quiz_attempts">;
  learning_status?: LearningStatusSummary;
}

export interface LearningDashboard {
  active_projects: number;
  next_action?: LearningNextAction;
  primary_project?: LearningProjectSummary | null;
  due_reviews: number;
  next_review_at?: number | null;
  weak_points: string[];
  weak_project?: { project_id: string; project_version: number; objective: string } | null;
  review_project?: { project_id: string; project_title: string } | null;
  mentor_suggestion: {
    id: string;
    project_id?: string | null;
    kind: "review" | "strengthen" | "continue" | "plan";
    count?: number;
    objective?: string;
  };
  continue_task: LearningTask | null;
  today_tasks: LearningTask[];
  recent_projects: LearningProjectSummary[];
}

export interface LearningPortfolioMetrics {
  project_count: number;
  first_learning_completed: number;
  completed_tasks: number;
  task_completion_rate: number;
  review_participation_count: number;
  repeated_error_rate: number;
  mastered_knowledge_points: number;
  active_days_7: number;
  active_days_30: number;
  privacy: {
    source: "local_learning_evidence";
    message_content_used: false;
    external_transfer: false;
  };
}

export interface LearningExperimentConsent {
  consent: boolean;
  notice_version: number;
  updated_at?: number | null;
  analytics_scope: "local_aggregate_only";
  content_collection: false;
  external_sharing: false;
}

export interface LearningProjectDraft {
  title: string;
  language?: "en" | "zh";
  motivation: string;
  current_level: string;
  target_level: string;
  existing_materials: string;
  deadline?: number | null;
  weekly_minutes: number;
  preferred_methods: string[];
  partner_id?: string | null;
  knowledge_base_ids?: string[];
  book_ids?: string[];
  notebook_ids?: string[];
}

export function learningTaskLaunchHref(task: LearningTask): string {
  if (task.intent === "assessment") {
    return `/space/learning/${encodeURIComponent(task.project_id)}#baseline-assessment`;
  }
  const query = new URLSearchParams({
    learning_task: task.id,
    project: task.project_id,
    objective: task.objective,
  });
  return `/home?${query.toString()}`;
}

export interface AssessmentQuestion {
  id: string;
  knowledge_node_id: string;
  title: string;
  prompt: string;
  choices: string[];
}

export interface AssessmentPayload {
  status: BaselineAssessment["status"];
  score?: number | null;
  inferred_level?: string | null;
  responses: Record<string, number>;
  questions: AssessmentQuestion[];
}

async function parseOrThrow<T>(response: Response, fallback: string): Promise<T> {
  if (response.ok) return response.json() as Promise<T>;
  const payload = await response.json().catch(() => null) as { message?: string; detail?: string } | null;
  throw new Error(payload?.message || payload?.detail || fallback);
}

export async function fetchLearningDashboard(): Promise<LearningDashboard> {
  const response = await apiFetch(apiUrl("/api/v1/learning/dashboard"));
  const dashboard = await parseOrThrow<LearningDashboard>(
    response,
    "Failed to load the learning dashboard.",
  );
  return dashboard;
}

export async function recordMentorSuggestionEvent(
  suggestion: LearningDashboard["mentor_suggestion"],
  action: "shown" | "adopted",
): Promise<void> {
  if (!suggestion.project_id) return;
  const response = await apiFetch(
    apiUrl(`/api/v1/learning/dashboard/suggestions/${encodeURIComponent(suggestion.id)}/events`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: suggestion.project_id, kind: suggestion.kind, action }),
    },
  );
  await parseOrThrow(response, "Failed to record the tutor suggestion outcome.");
}

export async function fetchLearningPortfolioMetrics(): Promise<LearningPortfolioMetrics> {
  const response = await apiFetch(apiUrl("/api/v1/learning/metrics"));
  return parseOrThrow(response, "Failed to load learning impact metrics.");
}

export async function fetchLearningExperimentConsent(): Promise<LearningExperimentConsent> {
  const response = await apiFetch(apiUrl("/api/v1/learning/experiments/consent"));
  return parseOrThrow(response, "Failed to load experiment preferences.");
}

export async function updateLearningExperimentConsent(consent: boolean): Promise<LearningExperimentConsent> {
  const response = await apiFetch(apiUrl("/api/v1/learning/experiments/consent"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ consent, notice_version: 1 }),
  });
  return parseOrThrow(response, "Failed to update experiment preferences.");
}

export async function fetchLearningProjects(): Promise<LearningProject[]> {
  const response = await apiFetch(apiUrl("/api/v1/learning/projects"));
  const payload = await parseOrThrow<{ items: LearningProject[] }>(response, "Failed to load learning plans.");
  return payload.items;
}

export async function fetchLearningProject(projectId: string): Promise<LearningProject> {
  const response = await apiFetch(apiUrl(`/api/v1/learning/projects/${encodeURIComponent(projectId)}`));
  return parseOrThrow(response, "Failed to load the learning plan.");
}

export async function fetchBaselineAssessment(projectId: string): Promise<AssessmentPayload> {
  const response = await apiFetch(apiUrl(`/api/v1/learning/projects/${encodeURIComponent(projectId)}/assessment`));
  return parseOrThrow(response, "Failed to load the baseline assessment.");
}

export async function completeProjectReview(
  projectId: string,
  reviewId: string,
  projectVersion: number,
  isCorrect: boolean,
  attemptId: string,
): Promise<{ project_version: number; review: ProjectReviewItem; due_review_count: number; next_review_at?: number | null }> {
  const response = await apiFetch(
    apiUrl(`/api/v1/learning/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(reviewId)}/complete`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_project_version: projectVersion,
        is_correct: isCorrect,
        attempt_id: attemptId,
      }),
    },
  );
  return parseOrThrow(response, "Failed to save the review result.");
}

export async function submitBaselineAssessment(
  projectId: string,
  projectVersion: number,
  responses: Record<string, number>,
): Promise<LearningProject> {
  const response = await apiFetch(
    apiUrl(`/api/v1/learning/projects/${encodeURIComponent(projectId)}/assessment`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_project_version: projectVersion, responses }),
    },
  );
  return parseOrThrow(response, "Failed to save the baseline assessment.");
}

export async function updateLearningProject(
  projectId: string,
  projectVersion: number,
  changes: Partial<Pick<LearningProject, "title" | "motivation" | "current_level" | "target_level" | "existing_materials" | "deadline" | "weekly_minutes" | "preferred_methods" | "teaching_strategy" | "difficulty_policy" | "status" | "partner_id" | "review_preferences" | "knowledge_base_ids" | "book_ids" | "notebook_ids">>,
): Promise<LearningProject> {
  const response = await apiFetch(apiUrl(`/api/v1/learning/projects/${encodeURIComponent(projectId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_version: projectVersion, ...changes }),
  });
  return parseOrThrow(response, "Failed to update the learning plan.");
}

export async function reconcileLearningProject(
  projectId: string,
  projectVersion: number,
): Promise<LearningProject> {
  const response = await apiFetch(apiUrl(`/api/v1/learning/projects/${encodeURIComponent(projectId)}/reconcile`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expected_project_version: projectVersion }),
  });
  return parseOrThrow(response, "Failed to reconcile the learning plan.");
}

export async function fetchLearningProjectTimeline(projectId: string): Promise<LearningEvent[]> {
  const response = await apiFetch(apiUrl(`/api/v1/learning/projects/${encodeURIComponent(projectId)}/timeline`));
  const payload = await parseOrThrow<{ items: LearningEvent[] }>(response, "Failed to load learning activity.");
  return payload.items;
}

export async function createLearningProject(
  draft: LearningProjectDraft,
  idempotencyKey: string,
): Promise<LearningProject> {
  const response = await apiFetch(apiUrl("/api/v1/learning/projects"), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(draft),
  });
  return parseOrThrow(response, "Failed to create the learning plan.");
}

export async function createLearningTask(
  projectId: string,
  projectVersion: number,
  objective: string,
  idempotencyKey: string,
): Promise<LearningTask> {
  const response = await apiFetch(
    apiUrl(`/api/v1/learning/projects/${encodeURIComponent(projectId)}/tasks`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        expected_project_version: projectVersion,
        objective,
        expected_minutes: 20,
        intent: "mastery_path",
      }),
    },
  );
  const payload = await parseOrThrow<{ project_version: number; task: LearningTask }>(response, "Failed to create a strengthening task.");
  return { ...payload.task, project_version: payload.project_version };
}

export async function startLearningTask(task: LearningTask): Promise<LearningTask> {
  if (!task.project_version) return task;
  const response = await apiFetch(
    apiUrl(`/api/v1/learning/projects/${encodeURIComponent(task.project_id)}/tasks/${encodeURIComponent(task.id)}`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_project_version: task.project_version,
        expected_task_version: task.version,
        status: "in_progress",
      }),
    },
  );
  const payload = await parseOrThrow<{ task: LearningTask }>(response, "Failed to start the learning task.");
  return payload.task;
}
