/** Typed client for the /api/v1/partners backend. */

import { apiFetch, apiUrl } from "@/lib/api";
import type { LLMSelection } from "@/lib/unified-ws";

export interface PartnerInfo {
  partner_id: string;
  name: string;
  description: string;
  /** List endpoints: channel name keys only. Detail: full (masked) dict. */
  channels: string[] | Record<string, unknown>;
  llm_selection?: LLMSelection | null;
  backup_llm_selection?: LLMSelection | null;
  model?: string | null;
  language?: string;
  emoji?: string;
  color?: string;
  avatar?: string;
  soul_origin?: { type?: string; id?: string };
  enabled_tools?: string[] | null;
  builtin_tools?: string[] | null;
  mcp_tools?: string[] | null;
  proactive_learning?: boolean;
  proactive_review_delay_hours?: number;
  proactive_low_score_threshold?: number;
  proactive_goal?: string;
  proactive_timezone?: string;
  proactive_allowed_start?: string;
  proactive_allowed_end?: string;
  proactive_allowed_weekdays?: number[];
  proactive_frequency?: "as_needed" | "daily" | "weekly";
  proactive_preferred_channel?: string;
  proactive_paused_until?: string;
  proactive_min_interval_hours?: number;
  proactive_max_per_day?: number;
  proactive_merge_window_hours?: number;
  running: boolean;
  started_at: string | null;
  last_reload_error?: string | null;
  provisioning?: ProvisioningReport;
  start_error?: string;
}

export interface ProvisioningReport {
  copied: Record<string, string[]>;
  errors: { type: string; name: string; error: string }[];
}

export interface SoulTemplate {
  id: string;
  name: string;
  content: string;
}

export interface SoulSources {
  library: SoulTemplate[];
  personas: { name: string; description: string; content?: string }[];
}

export interface ToolOption {
  name: string;
  description: string;
}

export interface McpToolOption extends ToolOption {
  /** Provider grouping key; `server` is its pre-provider spelling. */
  provider_id: string;
  server: string;
  /** `"mcp"` today, `"cli"` once CLI-app providers land. */
  kind: string;
}

export interface ToolOptions {
  tools: ToolOption[];
  /** Auto-mounted built-in tools an owner may allow/deny (default: all). */
  builtin_tools: ToolOption[];
  mcp_tools: McpToolOption[];
}

export interface PartnerAssets {
  knowledge_bases: { name: string; documents?: number }[];
  skills: { name: string }[];
  notebooks: { id: string; name: string; record_count?: number }[];
}

export interface PartnerSessionInfo {
  session_key: string;
  /** Opening user message, trimmed — the conversation's human label. */
  title?: string;
  message_count: number;
  updated_at: string;
  last_message: string;
  archived?: boolean;
}

export interface PartnerChannelHealth {
  enabled: boolean;
  status: "healthy" | "unhealthy" | "stopped" | string;
  running: boolean;
  error_type?: string;
  capabilities: {
    text: boolean;
    inbound_attachments: boolean;
    outbound_attachments: boolean;
    streaming: boolean;
  };
}

export interface PartnerChannelStatus {
  partner_id: string;
  running: boolean;
  channels: Record<string, PartnerChannelHealth>;
}

export interface PartnerDeadLetter {
  id: string;
  created_at: string;
  status: "pending" | "replayed" | "discarded";
  channel: string;
  chat_id: string;
  content: string;
  media: string[];
  attempts: number;
  error_type: string;
  error_message: string;
  resolved_at?: string;
  resolution_note?: string;
}

export interface PartnerCommandInfo {
  command: string;
  description: string;
  arg_hint?: string;
}

export interface SoulSpec {
  source: "default" | "library" | "persona" | "custom";
  id?: string;
  content?: string;
}

export interface SoulVersion {
  id: string;
  saved_at: string;
  content: string;
}

export interface CreatePartnerPayload {
  partner_id?: string;
  name: string;
  description?: string;
  soul?: SoulSpec;
  channels?: Record<string, unknown>;
  llm_selection?: LLMSelection | null;
  backup_llm_selection?: LLMSelection | null;
  language?: string;
  emoji?: string;
  color?: string;
  avatar?: string;
  enabled_tools?: string[] | null;
  builtin_tools?: string[] | null;
  mcp_tools?: string[] | null;
  proactive_learning?: boolean;
  proactive_review_delay_hours?: number;
  proactive_low_score_threshold?: number;
  proactive_goal?: string;
  proactive_timezone?: string;
  proactive_allowed_start?: string;
  proactive_allowed_end?: string;
  proactive_allowed_weekdays?: number[];
  proactive_frequency?: "as_needed" | "daily" | "weekly";
  proactive_preferred_channel?: string;
  proactive_paused_until?: string;
  proactive_min_interval_hours?: number;
  proactive_max_per_day?: number;
  proactive_merge_window_hours?: number;
  assets?: {
    knowledge_bases?: string[];
    skills?: string[];
    notebooks?: string[];
  };
  start?: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      detail?: string | { message?: string };
    };
    const detail = body.detail;
    const msg =
      typeof detail === "string"
        ? detail
        : (detail?.message ?? `Request failed: ${res.status}`);
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function listPartners(): Promise<PartnerInfo[]> {
  return json(
    await apiFetch(apiUrl("/api/v1/partners"), { cache: "no-store" }),
  );
}

export async function getPartner(
  partnerId: string,
  options?: { includeSecrets?: boolean },
): Promise<PartnerInfo> {
  const query = options?.includeSecrets ? "?include_secrets=true" : "";
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}${query}`),
    ),
  );
}

export async function createPartner(
  payload: CreatePartnerPayload,
): Promise<PartnerInfo> {
  return json(
    await apiFetch(apiUrl("/api/v1/partners"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

export async function updatePartner(
  partnerId: string,
  payload: Partial<CreatePartnerPayload> & {
    channels?: Record<string, unknown>;
  },
): Promise<PartnerInfo> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}`),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
    ),
  );
}

export interface ProactiveReminder {
  id: string;
  name: string;
  message: string;
  scheduled_for: string | null;
  channel: string;
  weak_questions: string[];
  merged_events: number;
  attempt_count: number;
  max_attempts: number;
  last_error?: string | null;
}

export interface ProactiveAuditRecord {
  at: string;
  event: string;
  decision: string;
  reason?: string;
  job_id?: string;
  scheduled_for?: string;
  channel?: string;
  score?: number;
  error?: string;
}

export interface ProactiveReminderState {
  pending: ProactiveReminder[];
  audit: ProactiveAuditRecord[];
  analytics: {
    scheduled: number;
    viewed: number;
    started: number;
    snoozed: number;
    skipped: number;
    disabled: number;
    delivered: number;
    failed: number;
    engagement_rate: number;
  };
}

export interface ProactivePartnerOverview {
  partner_id: string;
  partner_name: string;
  enabled: boolean;
  pending: ProactiveReminder[];
  audit: ProactiveAuditRecord[];
}

export interface ProactiveOverview {
  pending_count: number;
  partners: ProactivePartnerOverview[];
}

export async function getProactiveOverview(): Promise<ProactiveOverview> {
  return json(
    await apiFetch(apiUrl("/api/v1/partners/reminders/overview"), {
      cache: "no-store",
    }),
  );
}

export async function getProactiveReminders(
  partnerId: string,
): Promise<ProactiveReminderState> {
  return json(
    await apiFetch(
      apiUrl(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/proactive-reminders`,
      ),
      { cache: "no-store" },
    ),
  );
}

export async function getPartnerChannelStatus(
  partnerId: string,
): Promise<PartnerChannelStatus> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/channels/status`),
      { cache: "no-store" },
    ),
  );
}

export async function getPartnerDeadLetters(
  partnerId: string,
  status: PartnerDeadLetter["status"] | "" = "pending",
): Promise<PartnerDeadLetter[]> {
  const query = status ? `?status=${status}` : "";
  const result = await json<{ records: PartnerDeadLetter[] }>(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/dead-letters${query}`),
      { cache: "no-store" },
    ),
  );
  return result.records;
}

export async function retryPartnerDeadLetter(
  partnerId: string,
  recordId: string,
): Promise<PartnerDeadLetter> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/dead-letters/${encodeURIComponent(recordId)}/retry`),
      { method: "POST" },
    ),
  );
}

export async function discardPartnerDeadLetter(
  partnerId: string,
  recordId: string,
  note = "",
): Promise<PartnerDeadLetter> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/dead-letters/${encodeURIComponent(recordId)}/discard`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      },
    ),
  );
}

export async function cancelProactiveReminder(
  partnerId: string,
  jobId: string,
): Promise<void> {
  await json(
    await apiFetch(
      apiUrl(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/proactive-reminders/${encodeURIComponent(jobId)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

export async function actOnProactiveReminder(
  partnerId: string,
  jobId: string,
  action: "view" | "start" | "later" | "skip" | "disable",
  laterHours = 4,
): Promise<void> {
  await json(
    await apiFetch(
      apiUrl(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/proactive-reminders/${encodeURIComponent(jobId)}/action`,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, later_hours: laterHours }),
      },
    ),
  );
}

export async function startPartner(partnerId: string): Promise<PartnerInfo> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/start`),
      { method: "POST" },
    ),
  );
}

export async function stopPartner(partnerId: string): Promise<void> {
  await json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/stop`),
      { method: "POST" },
    ),
  );
}

export async function destroyPartner(partnerId: string): Promise<void> {
  await json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}`),
      {
        method: "DELETE",
      },
    ),
  );
}

export async function getPartnerSoul(partnerId: string): Promise<string> {
  const data = await json<{ content: string }>(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/soul`),
    ),
  );
  return data.content ?? "";
}

export async function savePartnerSoul(
  partnerId: string,
  content: string,
): Promise<void> {
  await json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/soul`),
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
    ),
  );
}

export async function getPartnerSoulVersions(
  partnerId: string,
): Promise<SoulVersion[]> {
  const data = await json<{ versions: SoulVersion[] }>(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/soul/versions`),
      { cache: "no-store" },
    ),
  );
  return data.versions;
}

export async function restorePartnerSoulVersion(
  partnerId: string,
  versionId: string,
): Promise<string> {
  const data = await json<{ content: string }>(
    await apiFetch(
      apiUrl(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/soul/versions/${encodeURIComponent(versionId)}/restore`,
      ),
      { method: "POST" },
    ),
  );
  return data.content;
}

export async function getSoulSources(): Promise<SoulSources> {
  return json(await apiFetch(apiUrl("/api/v1/partners/soul-sources")));
}

export async function createSoulTemplate(
  id: string,
  name: string,
  content: string,
): Promise<SoulTemplate> {
  return json(
    await apiFetch(apiUrl("/api/v1/partners/souls"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, content }),
    }),
  );
}

export async function getToolOptions(): Promise<ToolOptions> {
  return json(await apiFetch(apiUrl("/api/v1/partners/tool-options")));
}

export async function getPartnerCommands(): Promise<PartnerCommandInfo[]> {
  const data = await json<{ commands: PartnerCommandInfo[] }>(
    await apiFetch(apiUrl("/api/v1/partners/commands/palette")),
  );
  return data.commands;
}

export async function getPartnerAssets(
  partnerId: string,
): Promise<PartnerAssets> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/assets`),
    ),
  );
}

export async function addPartnerAssets(
  partnerId: string,
  assets: {
    knowledge_bases?: string[];
    skills?: string[];
    notebooks?: string[];
  },
): Promise<{ assets: PartnerAssets } & ProvisioningReport> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/assets`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(assets),
      },
    ),
  );
}

export async function removePartnerAsset(
  partnerId: string,
  assetType: "knowledge_base" | "skill" | "notebook",
  name: string,
): Promise<{ assets: PartnerAssets }> {
  return json(
    await apiFetch(
      apiUrl(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/assets/${assetType}/${encodeURIComponent(name)}`,
      ),
      { method: "DELETE" },
    ),
  );
}

export interface ChannelSchemaEntry {
  name: string;
  display_name: string;
  default_config: Record<string, unknown>;
  secret_fields: string[];
  /** Fields that must be non-empty whenever this channel is enabled. */
  required_when_enabled: string[];
  // null when the channel module failed to import (missing optional
  // dependency); `unavailable_reason` then carries the import error.
  json_schema: Record<string, unknown> | null;
  available?: boolean;
  unavailable_reason?: string;
}

export interface ChannelsSchemaResponse {
  channels: Record<string, ChannelSchemaEntry>;
}

export async function getChannelSchemas(): Promise<ChannelsSchemaResponse> {
  // no-store: availability reflects live server imports (e.g. a dependency
  // installed minutes ago) — a cached copy here shows phantom-missing channels.
  return json(
    await apiFetch(apiUrl("/api/v1/partners/channels/schema"), {
      cache: "no-store",
    }),
  );
}

export async function getPartnerHistory(
  partnerId: string,
  options?: { sessionKey?: string; sessionId?: string; limit?: number },
): Promise<
  {
    role: string;
    content: string;
    timestamp?: string;
    channel?: string;
    attachments?: Record<string, unknown>[];
    /** Persisted turn trace (assistant rows only) for rehydrating activity. */
    events?: Record<string, unknown>[];
  }[]
> {
  const params = new URLSearchParams();
  if (options?.sessionKey) params.set("session_key", options.sessionKey);
  if (options?.sessionId) params.set("session_id", options.sessionId);
  if (options?.limit) params.set("limit", String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : "";
  return json(
    await apiFetch(
      apiUrl(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/history${query}`,
      ),
    ),
  );
}

export async function getPartnerSessions(
  partnerId: string,
): Promise<PartnerSessionInfo[]> {
  return json(
    await apiFetch(
      apiUrl(`/api/v1/partners/${encodeURIComponent(partnerId)}/sessions`),
      { cache: "no-store" },
    ),
  );
}

async function postSessionAction(
  partnerId: string,
  action: "archive" | "resume" | "delete",
  sessionKey: string,
): Promise<void> {
  await apiFetch(
    apiUrl(
      `/api/v1/partners/${encodeURIComponent(partnerId)}/sessions/${action}`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_key: sessionKey }),
    },
  );
}

export function archivePartnerSession(partnerId: string, sessionKey: string) {
  return postSessionAction(partnerId, "archive", sessionKey);
}

export function resumePartnerSession(partnerId: string, sessionKey: string) {
  return postSessionAction(partnerId, "resume", sessionKey);
}

export function deletePartnerSession(partnerId: string, sessionKey: string) {
  return postSessionAction(partnerId, "delete", sessionKey);
}

export async function branchPartnerSession(
  partnerId: string,
  sourceKey: string,
  newKey: string,
): Promise<{ session: PartnerSessionInfo }> {
  return json(
    await apiFetch(
      apiUrl(
        `/api/v1/partners/${encodeURIComponent(partnerId)}/sessions/branch`,
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source_key: sourceKey, new_key: newKey }),
      },
    ),
  );
}
