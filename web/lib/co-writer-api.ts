import { apiFetch, apiUrl } from "@/lib/api";

const BASE = "/api/v1/co_writer";

export interface CoWriterDocumentSummary {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  preview: string;
}

export interface CoWriterDocument {
  id: string;
  title: string;
  content: string;
  revision: number;
  created_at: number;
  updated_at: number;
}

export interface CoWriterDocumentRevision {
  revision: number;
  title: string;
  preview: string;
  created_at: number;
  updated_at: number;
  current: boolean;
}

export interface CoWriterOperation {
  id: string;
  document_id?: string | null;
  timestamp: string;
  action: string;
  mode?: string;
  source?: string | null;
  tools?: string[];
  kb_name?: string | null;
  model?: string;
  decision?: "accepted" | "rejected";
  decision_timestamp?: string;
  partial?: boolean;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

export class CoWriterRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(message: string, currentRevision: number) {
    super(message);
    this.name = "CoWriterRevisionConflictError";
    this.currentRevision = currentRevision;
  }
}

export class CoWriterMergeConflictError extends Error {
  constructor(public readonly conflicts: Array<{ field?: string; start_line: number; end_line: number; local: string; remote: string }>) {
    super("Local and remote edits overlap");
    this.name = "CoWriterMergeConflictError";
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Request failed (${res.status}): ${text || res.statusText}`,
    );
  }
  return res.json() as Promise<T>;
}

export async function listCoWriterDocuments(): Promise<
  CoWriterDocumentSummary[]
> {
  const res = await apiFetch(apiUrl(`${BASE}/documents`), {
    cache: "no-store",
  });
  const data = await jsonOrThrow<{ documents: CoWriterDocumentSummary[] }>(res);
  return Array.isArray(data?.documents) ? data.documents : [];
}

export async function createCoWriterDocument(payload?: {
  title?: string;
  content?: string;
}): Promise<CoWriterDocument> {
  const res = await apiFetch(apiUrl(`${BASE}/documents`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: payload?.title ?? null,
      content: payload?.content ?? "",
    }),
  });
  return jsonOrThrow<CoWriterDocument>(res);
}

export async function getCoWriterDocument(
  docId: string,
): Promise<CoWriterDocument> {
  const res = await apiFetch(
    apiUrl(`${BASE}/documents/${encodeURIComponent(docId)}`),
    {
      cache: "no-store",
    },
  );
  return jsonOrThrow<CoWriterDocument>(res);
}

export async function downloadCoWriterDocument(
  docId: string,
  format: "markdown" | "docx" | "pdf",
): Promise<{ blob: Blob; filename: string }> {
  const res = await apiFetch(
    apiUrl(`${BASE}/documents/${encodeURIComponent(docId)}/export?format=${format}`),
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Export failed (${res.status}): ${text || res.statusText}`);
  }
  const disposition = res.headers.get("content-disposition") || "";
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const extension = format === "markdown" ? "md" : format;
  return {
    blob: await res.blob(),
    filename: encoded ? decodeURIComponent(encoded) : `cognivoy-document.${extension}`,
  };
}

export async function updateCoWriterDocument(
  docId: string,
  payload: {
    title?: string | null;
    content?: string | null;
    expectedRevision?: number | null;
  },
): Promise<CoWriterDocument> {
  const res = await apiFetch(
    apiUrl(`${BASE}/documents/${encodeURIComponent(docId)}`),
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: payload.title ?? null,
        content: payload.content ?? null,
        expected_revision: payload.expectedRevision ?? null,
      }),
    },
  );
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    throw new CoWriterRevisionConflictError(
      String(detail?.message || "The document changed since it was loaded."),
      Number(detail?.current_revision || 0),
    );
  }
  return jsonOrThrow<CoWriterDocument>(res);
}

export async function mergeCoWriterDocument(
  docId: string,
  payload: {
    baseRevision: number;
    expectedCurrentRevision: number;
    localTitle: string;
    localContent: string;
  },
): Promise<CoWriterDocument> {
  const res = await apiFetch(apiUrl(`${BASE}/documents/${encodeURIComponent(docId)}/merge`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base_revision: payload.baseRevision,
      expected_current_revision: payload.expectedCurrentRevision,
      local_title: payload.localTitle,
      local_content: payload.localContent,
    }),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    if (detail?.code === "document_merge_conflict") {
      throw new CoWriterMergeConflictError(Array.isArray(detail.conflicts) ? detail.conflicts : []);
    }
    throw new CoWriterRevisionConflictError(
      String(detail?.message || "The document changed while merging."),
      Number(detail?.current_revision || 0),
    );
  }
  return jsonOrThrow<CoWriterDocument>(res);
}

export async function deleteCoWriterDocument(docId: string): Promise<boolean> {
  const res = await apiFetch(
    apiUrl(`${BASE}/documents/${encodeURIComponent(docId)}`),
    {
      method: "DELETE",
    },
  );
  const data = await jsonOrThrow<{ deleted: boolean }>(res);
  return Boolean(data?.deleted);
}

export async function listCoWriterRevisions(
  docId: string,
): Promise<CoWriterDocumentRevision[]> {
  const res = await apiFetch(
    apiUrl(`${BASE}/documents/${encodeURIComponent(docId)}/revisions`),
    { cache: "no-store" },
  );
  const data = await jsonOrThrow<{ revisions: CoWriterDocumentRevision[] }>(res);
  return Array.isArray(data.revisions) ? data.revisions : [];
}

export async function restoreCoWriterRevision(
  docId: string,
  revision: number,
  expectedRevision: number,
): Promise<CoWriterDocument> {
  const res = await apiFetch(
    apiUrl(
      `${BASE}/documents/${encodeURIComponent(docId)}/revisions/${revision}/restore`,
    ),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_revision: expectedRevision }),
    },
  );
  if (res.status === 409) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    throw new CoWriterRevisionConflictError(
      String(detail?.message || "The document changed since it was loaded."),
      Number(detail?.current_revision || 0),
    );
  }
  return jsonOrThrow<CoWriterDocument>(res);
}

export async function listCoWriterOperations(
  docId: string,
): Promise<CoWriterOperation[]> {
  const res = await apiFetch(
    apiUrl(`${BASE}/history?document_id=${encodeURIComponent(docId)}`),
    { cache: "no-store" },
  );
  const data = await jsonOrThrow<{ history: CoWriterOperation[] }>(res);
  return Array.isArray(data.history) ? [...data.history].reverse() : [];
}

export async function recordCoWriterOperationDecision(
  operationId: string,
  payload: {
    decision: "accepted" | "rejected";
    appliedText?: string;
    partial?: boolean;
  },
): Promise<CoWriterOperation> {
  const res = await apiFetch(
    apiUrl(`${BASE}/history/${encodeURIComponent(operationId)}/decision`),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: payload.decision,
        applied_text: payload.appliedText ?? "",
        partial: payload.partial ?? false,
      }),
    },
  );
  return jsonOrThrow<CoWriterOperation>(res);
}
