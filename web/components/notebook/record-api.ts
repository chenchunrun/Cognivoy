// Record-level notebook endpoints not yet wrapped by lib/notebook-api.ts:
// add a record manually, and update a record in place. Both exist on the
// backend (cognivoy/api/routers/notebook.py).

import { apiFetch, apiUrl } from "@/lib/api";
import type { NotebookRecordItem, NotebookRecordType } from "@/lib/notebook-api";

export async function addNotebookRecord(payload: {
  notebookId: string;
  recordType?: NotebookRecordType;
  title: string;
  userQuery: string;
  output: string;
  summary?: string;
  tags?: string[];
  references?: Array<Record<string, unknown>>;
  idempotencyKey?: string;
}): Promise<NotebookRecordItem> {
  const response = await apiFetch(apiUrl("/api/v1/notebook/add_record"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      notebook_ids: [payload.notebookId],
      record_type: payload.recordType ?? "chat",
      title: payload.title,
      // Always send a summary: when it is empty the backend falls back to an
      // LLM-generated one, which fails on deployments without an API key.
      summary:
        payload.summary ?? payload.output.replace(/\s+/g, " ").slice(0, 200),
      user_query: payload.userQuery,
      output: payload.output,
      metadata: {},
      tags: payload.tags ?? [],
      references: payload.references ?? [],
      idempotency_key: payload.idempotencyKey,
    }),
  });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  const data = (await response.json()) as { record: NotebookRecordItem };
  return data.record;
}

export async function updateNotebookRecord(
  notebookId: string,
  recordId: string,
  updates: {
    title?: string;
    summary?: string;
    user_query?: string;
    output?: string;
    tags?: string[];
    references?: Array<Record<string, unknown>>;
    expected_revision?: number;
  },
): Promise<NotebookRecordItem> {
  const response = await apiFetch(
    apiUrl(`/api/v1/notebook/${notebookId}/records/${recordId}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    },
  );
  if (response.status === 409) {
    const payload = (await response.json().catch(() => null)) as {
      detail?: { code?: string; current?: NotebookRecordItem };
    } | null;
    if (payload?.detail?.code === "revision_conflict" && payload.detail.current) {
      throw new NotebookRevisionConflictError(payload.detail.current);
    }
  }
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  const data = (await response.json()) as { record: NotebookRecordItem };
  return data.record;
}

export class NotebookRevisionConflictError extends Error {
  current: NotebookRecordItem;

  constructor(current: NotebookRecordItem) {
    super("Notebook record changed since it was opened.");
    this.name = "NotebookRevisionConflictError";
    this.current = current;
  }
}
