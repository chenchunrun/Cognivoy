import { apiFetch, apiUrl } from "@/lib/api";
import { invalidateClientCache, withClientCache } from "@/lib/client-cache";
import type { LLMSelection, StreamEvent } from "@/lib/unified-ws";

export const SESSION_RUNTIME_STATUSES = [
  "idle",
  "queued",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  "rejected",
] as const;

export type SessionRuntimeStatus = (typeof SESSION_RUNTIME_STATUSES)[number];

const SESSION_RUNTIME_STATUS_SET = new Set<string>(SESSION_RUNTIME_STATUSES);

export function isSessionRuntimeStatus(value: unknown): value is SessionRuntimeStatus {
  return typeof value === "string" && SESSION_RUNTIME_STATUS_SET.has(value);
}

export interface SessionMessage {
  id: number;
  session_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  capability?: string;
  events: StreamEvent[];
  attachments: Array<{
    type: string;
    filename?: string;
    base64?: string;
    url?: string;
    mime_type?: string;
    id?: string;
    extracted_text?: string;
    generated?: boolean;
    size_bytes?: number;
  }>;
  metadata?: Record<string, unknown>;
  created_at: number;
  /** Edit-branching: id of the message this row continues. `null` for the
   *  first message in a session. Siblings share the same parent. */
  parent_message_id?: number | null;
}

export interface SessionSummary {
  id: string;
  session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  message_count: number;
  last_message: string;
  status?: SessionRuntimeStatus;
  active_turn_id?: string;
  preferences?: {
    capability?: string;
    tools?: string[];
    knowledge_bases?: string[];
    language?: string;
    llm_selection?: LLMSelection | null;
    /** Session-level persona preference; "" / absent = Default (no persona). */
    persona?: string;
    /** Edit-branching: maps a parent_message_id → the child id currently
     *  shown at that branch point. Missing keys default to the latest
     *  sibling (most recently created child). */
    selected_branches?: Record<string, number>;
    import?: {
      source?: string;
      source_cwd?: string;
      external_id?: string;
      agent_id?: string;
      agent_name?: string;
    };
  };
}

export interface ActiveTurnSummary {
  id: string;
  turn_id: string;
  session_id: string;
  capability: string;
  status: Exclude<SessionRuntimeStatus, "idle">;
  error: string;
  created_at: number;
  updated_at: number;
  finished_at?: number | null;
  last_seq: number;
}

export interface SessionDetail {
  id: string;
  session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  status?: SessionRuntimeStatus;
  active_turn_id?: string;
  compressed_summary?: string;
  summary_up_to_msg_id?: number;
  preferences?: {
    capability?: string;
    tools?: string[];
    knowledge_bases?: string[];
    language?: string;
    llm_selection?: LLMSelection | null;
    /** Session-level persona preference; "" / absent = Default (no persona). */
    persona?: string;
    /** Edit-branching: maps a parent_message_id → the child id currently
     *  shown at that branch point. Missing keys default to the latest
     *  sibling (most recently created child). */
    selected_branches?: Record<string, number>;
    import?: {
      source?: string;
      source_cwd?: string;
      external_id?: string;
      agent_id?: string;
      agent_name?: string;
    };
  };
  messages: SessionMessage[];
  active_turns?: ActiveTurnSummary[];
}

export interface QuizResultItem {
  question_id?: string;
  question: string;
  question_type?: string;
  options?: Record<string, string>;
  user_answer: string;
  correct_answer: string;
  explanation?: string;
  difficulty?: string;
  knowledge_points?: string[];
  source_refs?: Array<Record<string, unknown>>;
  rubric?: Record<string, unknown>;
  user_answer_images?: Array<{
    id?: string;
    base64?: string | null;
    url?: string | null;
    filename: string;
    mime_type: string;
  }>;
  is_correct: boolean;
  error_type?: "concept" | "prerequisite" | "calculation" | "misunderstanding" | "question_reading" | "expression" | "guessing" | "unknown";
  diagnostic_reason?: string;
  was_guess?: boolean;
}

async function expectJson<T>(response: Response): Promise<T> {
  if (response.status === 401 && typeof window !== "undefined") {
    const next = encodeURIComponent(window.location.pathname);
    window.location.href = `/login?next=${next}`;
    return new Promise(() => {});
  }
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export interface SessionListFilters {
  query?: string;
  capability?: string;
  updatedFrom?: number;
  updatedTo?: number;
}

export function resolveUpdatedFrom(
  rangeDays: number,
  nowSeconds: number,
): number | undefined {
  if (!Number.isFinite(rangeDays) || rangeDays <= 0) return undefined;
  return Math.floor(nowSeconds) - Math.floor(rangeDays) * 24 * 60 * 60;
}

export function buildSessionListQuery(
  limit = 50,
  offset = 0,
  filters: SessionListFilters = {},
): URLSearchParams {
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });
  const query = filters.query?.trim();
  const capability = filters.capability?.trim();
  if (query) qs.set("q", query);
  if (capability) qs.set("capability", capability);
  if (filters.updatedFrom !== undefined)
    qs.set("updated_from", String(filters.updatedFrom));
  if (filters.updatedTo !== undefined)
    qs.set("updated_to", String(filters.updatedTo));
  return qs;
}

export async function listSessions(
  limit = 50,
  offset = 0,
  options?: { force?: boolean; filters?: SessionListFilters },
): Promise<SessionSummary[]> {
  const qs = buildSessionListQuery(limit, offset, options?.filters);
  return withClientCache<SessionSummary[]>(
    `sessions:${qs.toString()}`,
    async () => {
      const response = await apiFetch(
        apiUrl(`/api/v1/sessions?${qs.toString()}`),
        {
          cache: "no-store",
        },
      );
      const data = await expectJson<{ sessions: SessionSummary[] }>(response);
      return data.sessions ?? [];
    },
    {
      force: options?.force,
      ttlMs: 15_000,
    },
  );
}

export async function getSessionStats(options?: { force?: boolean }): Promise<{
  total: number;
  updated_at?: number | null;
}> {
  return withClientCache(
    "sessions:stats",
    async () => {
      const response = await apiFetch(apiUrl("/api/v1/sessions/stats"), {
        cache: "no-store",
      });
      return expectJson<{ total: number; updated_at?: number | null }>(response);
    },
    { force: options?.force, ttlMs: 15_000 },
  );
}

export async function getSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionDetail> {
  const response = await apiFetch(apiUrl(`/api/v1/sessions/${encodeURIComponent(sessionId)}`), {
    cache: "no-store",
    signal,
  });
  return expectJson<SessionDetail>(response);
}

export async function updateSessionTitle(
  sessionId: string,
  title: string,
): Promise<SessionDetail> {
  const response = await apiFetch(apiUrl(`/api/v1/sessions/${encodeURIComponent(sessionId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const data = await expectJson<{ session: SessionDetail }>(response);
  invalidateClientCache("sessions:");
  return data.session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await apiFetch(apiUrl(`/api/v1/sessions/${encodeURIComponent(sessionId)}`), {
    method: "DELETE",
  });
  await expectJson<{ deleted: boolean }>(response);
  invalidateClientCache("sessions:");
}

export async function recordQuizResults(
  sessionId: string,
  answers: QuizResultItem[],
  turnId?: string | null,
  submissionId?: string,
): Promise<{
  recorded: boolean;
  history_message_created: boolean;
  duplicate_submission: boolean;
  proactive_job_ids: string[];
}> {
  const response = await apiFetch(
    apiUrl(`/api/v1/sessions/${encodeURIComponent(sessionId)}/quiz-results`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        answers,
        turn_id: turnId || "",
        submission_id: submissionId || "",
      }),
    },
  );
  return expectJson<{
    recorded: boolean;
    history_message_created: boolean;
    duplicate_submission: boolean;
    proactive_job_ids: string[];
  }>(response);
}

export async function deleteMessage(
  sessionId: string,
  messageId: number,
): Promise<void> {
  const response = await apiFetch(
    apiUrl(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`),
    { method: "DELETE" },
  );
  await expectJson<{ deleted: boolean }>(response);
}

export async function updateBranchSelection(
  sessionId: string,
  selectedBranches: Record<string, number>,
): Promise<void> {
  const response = await apiFetch(
    apiUrl(`/api/v1/sessions/${encodeURIComponent(sessionId)}/branch-selection`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected_branches: selectedBranches }),
    },
  );
  await expectJson<{ selected_branches: Record<string, number> }>(response);
}
