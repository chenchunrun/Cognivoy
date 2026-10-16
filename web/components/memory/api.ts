// Memory workbench API layer — DTOs + fetch helpers for the
// /api/v1/memory/* endpoints. Data flow mirrors the previous frontend's
// web/components/memory/*; see cognivoy/api/routers/memory.py for the
// server contract.

import { apiFetch, apiUrl } from "@/lib/api";
import type { LLMSelection } from "@/lib/unified-ws";

export type MemoryLayer = "L2" | "L3";

export interface DocOverview {
  layer: MemoryLayer;
  key: string;
  exists: boolean;
  updated_at: string | null;
  entry_count: number;
  backlog: number;
}

export interface OverviewResponse {
  docs: DocOverview[];
  backups: string[];
}

export interface MemoryEntity {
  id: string;
  label: string;
  ts: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ChangeEntry {
  ts: string;
  kind: "added" | "modified" | "removed";
  entity_id: string;
  label: string;
  prev_fingerprint: string | null;
  new_fingerprint: string | null;
}

export interface SnapshotResponse {
  surface: string;
  entities: MemoryEntity[];
  last_refresh: string | null;
  pending_changes: ChangeEntry[];
}

export interface ChangesResponse {
  surface: string;
  changes: ChangeEntry[];
}

export interface KbQueryEvent {
  id: string;
  ts: string;
  surface: string;
  kind: string;
  payload: Record<string, unknown>;
  session_id: string | null;
  turn_id: string | null;
}

export interface DocResponse {
  layer: MemoryLayer;
  key: string;
  content: string;
  version: string;
}

export class MemoryVersionConflictError extends Error {
  constructor(public readonly currentVersion: string) {
    super("Memory document changed since it was loaded");
    this.name = "MemoryVersionConflictError";
  }
}

export interface LineRow {
  number: number;
  kind: "title" | "blank" | "section" | "bullet";
  text: string;
  entry_id: string | null;
  section: string | null;
}

export interface MemorySettings {
  collection: {
    enabled: boolean;
    auto_capture: boolean;
    retention_days: number;
  };
  partner: {
    shared_owner_read: boolean;
    private_partner_write: boolean;
  };
  automation: {
    enabled: boolean;
    interval_minutes: number;
    min_backlog: number;
    max_retries: number;
    retry_delay_seconds: number;
  };
  update: { l2_budget: number; l3_budget: number };
  audit: { l2_budget: number; l3_budget: number };
  dedup: { iterations: number; auto_after_update: boolean };
  merge: {
    auto_after_update: boolean;
    auto_after_audit: boolean;
    auto_after_dedup: boolean;
  };
  chunking: {
    overlap_ratio: number;
    boundary: "paragraph" | "sentence";
    min_chunk_chars: number;
    max_chunk_chars: number;
  };
  reference: {
    enforce_required: boolean;
    drop_invalid_refs: boolean;
  };
}

const DEFAULT_MEMORY_AUTOMATION: MemorySettings["automation"] = {
  enabled: false,
  interval_minutes: 60,
  min_backlog: 10,
  max_retries: 2,
  retry_delay_seconds: 60,
};

function normalizeMemorySettings(
  settings: Omit<MemorySettings, "automation"> & {
    automation?: Partial<MemorySettings["automation"]>;
  },
): MemorySettings {
  return {
    ...settings,
    automation: {
      ...DEFAULT_MEMORY_AUTOMATION,
      ...settings.automation,
    },
  };
}

export interface DeletedMemoryEntry {
  layer: MemoryLayer;
  key: string;
  deleted_at: string;
  entry: {
    id: string;
    section: string;
    text: string;
    refs: string[];
  };
}

export interface MemoryTrashResponse {
  items: DeletedMemoryEntry[];
  total: number;
}

export interface MemoryConflictStatement {
  id: string;
  section: string;
  text: string;
  refs: string[];
  ref_count: number;
  valid_ref_count: number;
  confidence: number;
}

export interface MemoryConflict {
  id: string;
  layer: "L3";
  key: string;
  section: string;
  reason: "shared_evidence_distinct_claims";
  shared_refs: string[];
  left: MemoryConflictStatement;
  right: MemoryConflictStatement;
}

export interface MemoryConflictResponse {
  schema_version: number;
  items: MemoryConflict[];
  total: number;
}

export type MemoryConflictAction =
  | "keep_left"
  | "keep_right"
  | "merge"
  | "delete_both";

export interface ResolveMemoryConflictRequest {
  conflict_id: string;
  layer: "L3";
  key: string;
  left_id: string;
  right_id: string;
  action: MemoryConflictAction;
  merged_text?: string;
  reason?: string;
}

export interface MemoryConflictAuditRecord {
  id: string;
  conflict_id: string;
  resolved_at: string;
  layer: "L3";
  key: string;
  section: string;
  action: MemoryConflictAction;
  left_id: string;
  right_id: string;
  shared_refs: string[];
  kept_ids: string[];
  deleted_ids: string[];
  reason: string;
}

export interface MemoryResource {
  id: string;
  layer: MemoryLayer;
  key: string;
  section: string;
  text: string;
  refs: string[];
  source_count: number;
  confidence: number;
  created_at?: string | null;
  updated_at: string | null;
  deleted_at?: string | null;
  reason?: string;
  status: "active" | "deleted";
  version: string;
  paused: boolean;
  flagged_incorrect: boolean;
  state_reason?: string;
  state_updated_at?: string | null;
  last_used_at?: string | null;
  project_ids: string[];
  project_links_updated_at?: string | null;
  project_link_revision: number;
}

export interface MemoryResourcePage {
  schema_version: number;
  items: MemoryResource[];
  total: number;
  cursor: string | null;
}

function normalizeMemoryResource(item: MemoryResource): MemoryResource {
  return {
    ...item,
    refs: Array.isArray(item.refs) ? item.refs : [],
    paused: Boolean(item.paused),
    flagged_incorrect: Boolean(item.flagged_incorrect),
    project_ids: Array.isArray(item.project_ids) ? item.project_ids : [],
    project_link_revision: Number(item.project_link_revision || 0),
  };
}

export type RunMode = "update" | "audit" | "dedup";
export type RunStatus = "queued" | "running" | "cancelled" | "done" | "error";

export interface RunHandle {
  id: string;
  layer: MemoryLayer;
  key: string;
  mode: RunMode;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  error: string | null;
  event_count: number;
  undo_count: number;
}

async function readJson<T>(res: Response, fallback: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(detail || `${fallback} (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function getOverview(): Promise<OverviewResponse> {
  const res = await apiFetch(apiUrl("/api/v1/memory/overview"));
  return readJson<OverviewResponse>(res, "Failed to load memory overview");
}

export async function getSnapshot(surface: string): Promise<SnapshotResponse> {
  const res = await apiFetch(apiUrl(`/api/v1/memory/snapshot/${surface}`));
  return readJson<SnapshotResponse>(res, "Failed to load snapshot");
}

export async function getSnapshotChanges(
  surface: string,
): Promise<ChangesResponse> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/snapshot/${surface}/changes`),
  );
  return readJson<ChangesResponse>(res, "Failed to load changes");
}

export async function refreshSnapshot(
  surface: string,
): Promise<{ changes: ChangeEntry[]; last_refresh: string | null }> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/snapshot/${surface}/refresh`),
    { method: "POST" },
  );
  return readJson(res, "Refresh failed");
}

export async function getKbTrace(limit = 200): Promise<KbQueryEvent[]> {
  const res = await apiFetch(apiUrl(`/api/v1/memory/trace/kb?limit=${limit}`));
  const data = await readJson<{ events: KbQueryEvent[] }>(
    res,
    "Failed to load queries",
  );
  return data.events ?? [];
}

export async function getDoc(
  layer: MemoryLayer,
  key: string,
): Promise<DocResponse> {
  const res = await apiFetch(apiUrl(`/api/v1/memory/doc/${layer}/${key}`));
  return readJson<DocResponse>(res, "Failed to load document");
}

export async function putDoc(
  layer: MemoryLayer,
  key: string,
  content: string,
  expectedVersion: string,
): Promise<{ version: string }> {
  const res = await apiFetch(apiUrl(`/api/v1/memory/doc/${layer}/${key}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, expected_version: expectedVersion }),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      detail?: { current_version?: string };
    };
    throw new MemoryVersionConflictError(body.detail?.current_version ?? "");
  }
  return readJson<{ version: string }>(res, "Failed to save document");
}

export async function getDocLines(
  layer: MemoryLayer,
  key: string,
): Promise<LineRow[]> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/doc/${layer}/${key}/lines`),
  );
  const data = await readJson<{ lines: LineRow[] }>(
    res,
    "Failed to load line view",
  );
  return data.lines ?? [];
}

export async function resetDoc(
  layer: MemoryLayer,
  key: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/doc/${layer}/${encodeURIComponent(key)}/reset`),
    { method: "POST" },
  );
  await readJson(res, "Reset failed");
}

export async function getMemorySettings(): Promise<MemorySettings> {
  const res = await apiFetch(apiUrl("/api/v1/memory/settings"));
  const settings = await readJson<
    Omit<MemorySettings, "automation"> & {
      automation?: Partial<MemorySettings["automation"]>;
    }
  >(res, "Failed to load memory settings");
  return normalizeMemorySettings(settings);
}

export async function putMemorySettings(
  settings: MemorySettings,
): Promise<MemorySettings> {
  const res = await apiFetch(apiUrl("/api/v1/memory/settings"), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  const saved = await readJson<
    Omit<MemorySettings, "automation"> & {
      automation?: Partial<MemorySettings["automation"]>;
    }
  >(res, "Failed to save memory settings");
  return normalizeMemorySettings(saved);
}

export async function listMemoryResources(params: {
  layer?: MemoryLayer;
  status?: "active" | "deleted" | "all";
  limit?: number;
} = {}): Promise<MemoryResourcePage> {
  const query = new URLSearchParams();
  if (params.layer) query.set("layer", params.layer);
  if (params.status) query.set("status", params.status);
  query.set("limit", String(params.limit ?? 500));
  const res = await apiFetch(apiUrl(`/api/v1/memory/resources?${query.toString()}`), {
    cache: "no-store",
  });
  const page = await readJson<MemoryResourcePage>(res, "Failed to load memories");
  return {
    ...page,
    items: Array.isArray(page.items) ? page.items.map(normalizeMemoryResource) : [],
  };
}

export async function updateMemoryResource(
  resource: MemoryResource,
  text: string,
  section: string,
): Promise<{ item: MemoryResource; version: string }> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/resources/${resource.layer}/${encodeURIComponent(resource.key)}/${encodeURIComponent(resource.id)}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expected_version: resource.version,
        text,
        section,
        refs: resource.refs,
      }),
    },
  );
  return readJson(res, "Failed to update memory");
}

export async function deleteMemoryResource(
  resource: MemoryResource,
  reason: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/resources/${resource.layer}/${encodeURIComponent(resource.key)}/${encodeURIComponent(resource.id)}`),
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_version: resource.version, reason }),
    },
  );
  await readJson(res, "Failed to delete memory");
}

export async function updateMemoryResourceState(
  resource: MemoryResource,
  state: { paused?: boolean; flagged_incorrect?: boolean; reason?: string },
): Promise<{ item: MemoryResource }> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/resources/${resource.layer}/${encodeURIComponent(resource.key)}/${encodeURIComponent(resource.id)}/state`),
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    },
  );
  return readJson(res, "Failed to update memory state");
}

export async function updateMemoryResourceProjects(
  resource: MemoryResource,
  projectIds: string[],
): Promise<{ item: MemoryResource; added_project_ids: string[]; removed_project_ids: string[] }> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/resources/${resource.layer}/${encodeURIComponent(resource.key)}/${encodeURIComponent(resource.id)}/projects`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_ids: projectIds }),
    },
  );
  return readJson(res, "Failed to update memory projects");
}

export async function mergeMemoryResources(
  resources: MemoryResource[],
): Promise<{ kept_id: string; merged_ids: string[]; version: string; item: MemoryResource }> {
  const first = resources[0];
  if (!first || resources.length < 2) throw new Error("Select at least two memories");
  if (resources.some((item) => item.layer !== first.layer || item.key !== first.key)) {
    throw new Error("Memories must belong to the same document");
  }
  const res = await apiFetch(apiUrl("/api/v1/memory/resources/merge"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      layer: first.layer,
      key: first.key,
      entry_ids: resources.map((item) => item.id),
      expected_version: first.version,
    }),
  });
  return readJson(res, "Failed to merge memories");
}

export async function exportMemoryResources(includeDeleted = false): Promise<Record<string, unknown>> {
  const query = includeDeleted ? "?include_deleted=true" : "";
  const res = await apiFetch(apiUrl(`/api/v1/memory/resources/export${query}`), {
    cache: "no-store",
  });
  return readJson(res, "Failed to export memories");
}

export async function getDeletedMemoryEntries(
  layer?: MemoryLayer,
  key?: string,
): Promise<MemoryTrashResponse> {
  const params = new URLSearchParams();
  if (layer) params.set("layer", layer);
  if (key) params.set("key", key);
  const suffix = params.size ? `?${params.toString()}` : "";
  const res = await apiFetch(apiUrl(`/api/v1/memory/trash${suffix}`));
  return readJson<MemoryTrashResponse>(res, "Failed to load deleted memories");
}

export async function restoreDeletedMemoryEntry(
  layer: MemoryLayer,
  key: string,
  entryId: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/memory/trash/${layer}/${encodeURIComponent(key)}/${encodeURIComponent(entryId)}/restore`,
    ),
    { method: "POST" },
  );
  await readJson(res, "Failed to restore memory");
}

export async function permanentlyDeleteMemoryEntry(
  layer: MemoryLayer,
  key: string,
  entryId: string,
): Promise<void> {
  const res = await apiFetch(
    apiUrl(
      `/api/v1/memory/trash/${layer}/${encodeURIComponent(key)}/${encodeURIComponent(entryId)}`,
    ),
    { method: "DELETE" },
  );
  await readJson(res, "Failed to permanently delete memory");
}

export async function getMemoryConflicts(): Promise<MemoryConflictResponse> {
  const res = await apiFetch(apiUrl("/api/v1/memory/conflicts"));
  return readJson<MemoryConflictResponse>(res, "Failed to load memory conflicts");
}

export async function resolveMemoryConflict(
  request: ResolveMemoryConflictRequest,
): Promise<MemoryConflictAuditRecord> {
  const res = await apiFetch(apiUrl("/api/v1/memory/conflicts/resolve"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  return readJson<MemoryConflictAuditRecord>(res, "Failed to resolve memory conflict");
}

export async function getMemoryConflictAudit(
  limit = 100,
): Promise<{ items: MemoryConflictAuditRecord[]; total: number }> {
  const suffix = limit === 100 ? "" : `?limit=${encodeURIComponent(String(limit))}`;
  const res = await apiFetch(apiUrl(`/api/v1/memory/conflicts/audit${suffix}`));
  return readJson(res, "Failed to load conflict audit");
}

export async function resolveEntry(
  entryId: string,
): Promise<{ layer: MemoryLayer; key: string; entry_id: string }> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/resolve_entry/${encodeURIComponent(entryId)}`),
  );
  return readJson(res, "Resolver failed");
}

export async function listRuns(
  layer: MemoryLayer,
  key: string,
): Promise<RunHandle[]> {
  const res = await apiFetch(
    apiUrl(`/api/v1/memory/runs?layer=${layer}&key=${encodeURIComponent(key)}`),
  );
  const data = await readJson<{ runs: RunHandle[] }>(
    res,
    "Failed to list runs",
  );
  return data.runs ?? [];
}

export async function getRun(runId: string): Promise<RunHandle> {
  const res = await apiFetch(apiUrl(`/api/v1/memory/runs/${runId}`));
  return readJson<RunHandle>(res, "Unknown run");
}

export interface StartRunArgs {
  layer: MemoryLayer;
  key: string;
  mode: RunMode;
  budget?: number;
  iterations?: number;
  llmSelection?: LLMSelection | null;
  language?: string;
}

export async function startRun(args: StartRunArgs): Promise<RunHandle> {
  const res = await apiFetch(apiUrl("/api/v1/memory/runs/start"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      layer: args.layer,
      key: args.key,
      mode: args.mode,
      budget: args.budget ?? null,
      iterations: args.iterations ?? null,
      llm_selection: args.llmSelection ?? null,
      language: args.language ?? "en",
    }),
  });
  return readJson<RunHandle>(res, "Failed to start run");
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await apiFetch(apiUrl(`/api/v1/memory/runs/${runId}/cancel`), {
    method: "POST",
  });
  await readJson(res, "Failed to cancel run");
}

export async function retryRun(runId: string): Promise<RunHandle> {
  const res = await apiFetch(apiUrl(`/api/v1/memory/runs/${runId}/retry`), {
    method: "POST",
  });
  return readJson<RunHandle>(res, "Failed to retry run");
}

export interface UndoResult {
  undo_count: number;
  event?: { seq: number; ts: string; [key: string]: unknown };
}

export async function undoRun(runId: string): Promise<UndoResult> {
  const res = await apiFetch(apiUrl(`/api/v1/memory/runs/${runId}/undo`), {
    method: "POST",
  });
  return readJson<UndoResult>(res, "Undo failed");
}
