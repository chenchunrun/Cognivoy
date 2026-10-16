import { apiFetch, apiUrl, wsUrl } from "@/lib/api";
import {
  runBookSocketOperation,
  type BookWsEvent,
} from "@/lib/book-ws-operation";
import type {
  Book,
  BookDetail,
  BookProposal,
  Page,
  Spine,
  Block,
  Progress,
} from "@/lib/book-types";

const BASE = "/api/v1/book";

function requestOverSocket<T extends BookWsEvent>(
  message: BookWsEvent,
  resultType: string,
  onEvent?: (event: BookWsEvent) => void,
): Promise<T> {
  return runBookSocketOperation<T>(() => new WebSocket(wsUrl(`${BASE}/ws`)), {
    message,
    resultType,
    onEvent,
  });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(apiUrl(`${BASE}${path}`), {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!res.ok) {
    let detail: string;
    try {
      const data = await res.json();
      detail = (data && (data.detail || data.message)) || res.statusText;
    } catch {
      detail = res.statusText;
    }
    throw new Error(`book api ${path} → ${res.status}: ${detail}`);
  }
  return (await res.json()) as T;
}

export interface CreateBookPayload {
  user_intent: string;
  chat_session_id?: string;
  chat_selections?: Array<{ session_id: string; message_ids: number[] }>;
  notebook_refs?: Array<Record<string, unknown>>;
  knowledge_bases?: string[];
  question_categories?: number[];
  question_entries?: number[];
  language?: string;
}

export interface BookListParams {
  q?: string;
  status?: string;
  sort?: "recent" | "title" | "progress" | "reading_time";
  limit?: number;
  offset?: number;
}

export interface BookListResponse {
  books: Book[];
  total: number;
  limit: number;
  offset: number;
  summary: {
    total: number;
    ready: number;
    in_progress: number;
    chapters: number;
  };
}

export interface BookStageReview {
  id: string;
  book_id: string;
  stage: "outline" | "proofread";
  revision: number;
  decision: "draft" | "approved" | "changes_requested";
  notes: string;
  snapshot: {
    chapter_count?: number;
    page_count?: number;
    block_count?: number;
    source_anchor_count?: number;
    issue_count?: number;
    error_count?: number;
    warning_count?: number;
    issues?: Array<{ severity: string; message: string; page_title?: string }>;
    [key: string]: unknown;
  };
  created_at: string;
}

function bookListPath(params: BookListParams = {}): string {
  const query = new URLSearchParams();
  if (params.q?.trim()) query.set("q", params.q.trim());
  if (params.status && params.status !== "all") query.set("status", params.status);
  if (params.sort) query.set("sort", params.sort);
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.offset !== undefined) query.set("offset", String(params.offset));
  const serialized = query.toString();
  return `/books${serialized ? `?${serialized}` : ""}`;
}

export const bookApi = {
  list: (params: BookListParams = {}) => request<BookListResponse>(bookListPath(params)),
  get: (book_id: string) =>
    request<BookDetail>(`/books/${encodeURIComponent(book_id)}`),
  downloadExport: async (book_id: string, format: "markdown" | "epub") => {
    const res = await apiFetch(
      apiUrl(`${BASE}/books/${encodeURIComponent(book_id)}/export?format=${format}`),
    );
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const payload = await res.json();
        detail = payload?.message || payload?.detail || detail;
      } catch { /* response is not JSON */ }
      throw new Error(`book export → ${res.status}: ${detail}`);
    }
    const disposition = res.headers.get("content-disposition") || "";
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    return {
      blob: await res.blob(),
      filename: encoded ? decodeURIComponent(encoded) : `cognivoy-book.${format === "epub" ? "epub" : "md"}`,
    };
  },
  delete: (book_id: string) =>
    request<{ deleted: boolean; book_id: string }>(
      `/books/${encodeURIComponent(book_id)}`,
      { method: "DELETE" },
    ),
  generateCover: (book_id: string, options?: { theme?: string; accent?: string }) =>
    request<{ cover_url: string; mime_type: string; source: string }>(
      `/books/${encodeURIComponent(book_id)}/cover/generate`,
      { method: "POST", body: JSON.stringify(options || {}) },
    ),
  uploadCover: async (book_id: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await apiFetch(
      apiUrl(`${BASE}/books/${encodeURIComponent(book_id)}/cover/upload`),
      { method: "POST", body: form },
    );
    if (!res.ok) {
      let detail = res.statusText;
      try { detail = (await res.json())?.detail || detail; } catch { /* response is not JSON */ }
      throw new Error(`book cover upload → ${res.status}: ${detail}`);
    }
    return (await res.json()) as { cover_url: string; mime_type: string; source: string };
  },
  getSpine: (book_id: string) =>
    request<{ spine: Spine }>(`/books/${encodeURIComponent(book_id)}/spine`),
  listStageReviews: (book_id: string) =>
    request<{ reviews: BookStageReview[] }>(
      `/books/${encodeURIComponent(book_id)}/stage-reviews`,
    ),
  createStageReview: (
    book_id: string,
    payload: {
      stage: "outline" | "proofread";
      decision?: "draft" | "approved" | "changes_requested";
      notes?: string;
      expected_revision: number;
    },
  ) =>
    request<{ review: BookStageReview }>(
      `/books/${encodeURIComponent(book_id)}/stage-reviews`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  getPage: (book_id: string, page_id: string) =>
    request<{ page: Page }>(
      `/books/${encodeURIComponent(book_id)}/pages/${encodeURIComponent(page_id)}`,
    ),
  listPageRevisions: (book_id: string, page_id: string) =>
    request<{
      revisions: Array<{
        revision_id: string;
        created_at?: string;
        title?: string;
        status?: string;
        block_count?: number;
      }>;
    }>(`/books/${encodeURIComponent(book_id)}/pages/${encodeURIComponent(page_id)}/revisions`),
  restorePageRevision: (book_id: string, page_id: string, revision_id: string) =>
    request<{ page: Page; restored_revision_id: string }>(
      `/books/${encodeURIComponent(book_id)}/pages/${encodeURIComponent(page_id)}/revisions/restore`,
      { method: "POST", body: JSON.stringify({ revision_id }) },
    ),
  create: (
    payload: CreateBookPayload,
    onEvent?: (event: BookWsEvent) => void,
  ) =>
    requestOverSocket<{
      type: "create_result";
      book: Book;
      proposal: BookProposal;
    }>({ type: "create", ...payload }, "create_result", onEvent),
  confirmProposal: (
    book_id: string,
    proposal?: BookProposal,
    onEvent?: (event: BookWsEvent) => void,
  ) =>
    requestOverSocket<{
      type: "confirm_proposal_result";
      book: Book;
      spine: Spine;
    }>(
      { type: "confirm_proposal", book_id, proposal: proposal ?? null },
      "confirm_proposal_result",
      onEvent,
    ),
  confirmSpine: (book_id: string, spine?: Spine, auto_compile = true) =>
    request<{ pages: Page[] }>("/books/confirm-spine", {
      method: "POST",
      body: JSON.stringify({ book_id, spine: spine ?? null, auto_compile }),
    }),
  compilePage: (
    book_id: string,
    page_id: string,
    force = false,
    onEvent?: (event: BookWsEvent) => void,
  ) =>
    requestOverSocket<{ type: "compile_page_result"; page: Page }>(
      { type: "compile_page", book_id, page_id, force },
      "compile_page_result",
      onEvent,
    ),
  regenerateBlock: (
    book_id: string,
    page_id: string,
    block_id: string,
    params_override?: Record<string, unknown>,
    onEvent?: (event: BookWsEvent) => void,
  ) =>
    requestOverSocket<{
      type: "regenerate_block_result";
      block: Block | null;
    }>(
      {
        type: "regenerate_block",
        book_id,
        page_id,
        block_id,
        params_override: params_override ?? null,
      },
      "regenerate_block_result",
      onEvent,
    ),

  insertBlock: (params: {
    book_id: string;
    page_id: string;
    block_type: string;
    params?: Record<string, unknown>;
    position?: number;
    compile_now?: boolean;
  }) =>
    request<{ block: Block }>("/books/insert-block", {
      method: "POST",
      body: JSON.stringify({
        compile_now: true,
        ...params,
      }),
    }),

  deleteBlock: (book_id: string, page_id: string, block_id: string) =>
    request<{ ok: boolean }>("/books/delete-block", {
      method: "POST",
      body: JSON.stringify({ book_id, page_id, block_id }),
    }),

  moveBlock: (
    book_id: string,
    page_id: string,
    block_id: string,
    new_position: number,
  ) =>
    request<{ ok: boolean }>("/books/move-block", {
      method: "POST",
      body: JSON.stringify({ book_id, page_id, block_id, new_position }),
    }),

  changeBlockType: (params: {
    book_id: string;
    page_id: string;
    block_id: string;
    new_type: string;
    params_override?: Record<string, unknown>;
  }) =>
    request<{ block: Block }>("/books/change-block-type", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  deepDive: (params: {
    book_id: string;
    parent_page_id: string;
    topic: string;
    block_id?: string;
    content_type?: string;
  }) =>
    request<{ page: Page }>("/books/deep-dive", {
      method: "POST",
      body: JSON.stringify({ content_type: "concept", ...params }),
    }),

  recordQuizAttempt: (params: {
    book_id: string;
    page_id: string;
    block_id: string;
    question_id?: string;
    user_answer?: string;
    is_correct: boolean;
  }) =>
    request<{ progress: Record<string, unknown> }>("/books/quiz-attempt", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  recordPageVisit: (book_id: string, page_id: string) =>
    request<{ progress: Progress }>("/books/page-visit", {
      method: "POST",
      body: JSON.stringify({ book_id, page_id }),
    }),

  supplement: (book_id: string, page_id: string, topic: string) =>
    request<{ block: Block }>("/books/supplement", {
      method: "POST",
      body: JSON.stringify({ book_id, page_id, topic }),
    }),

  setPageChatSession: (book_id: string, page_id: string, session_id: string) =>
    request<{ book: Book }>("/books/page-chat-session", {
      method: "POST",
      body: JSON.stringify({ book_id, page_id, session_id }),
    }),

  rebuild: (book_id: string, auto_compile = true) =>
    request<{ pages: Page[] }>("/books/rebuild", {
      method: "POST",
      body: JSON.stringify({ book_id, auto_compile }),
    }),
  rebuildPreview: (book_id: string) =>
    request<{
      book_id: string;
      page_count: number;
      generated_block_count: number;
      user_note_count: number;
      visited_page_count: number;
      bookmarked_page_count: number;
      page_chat_count: number;
      page_titles: string[];
      preserves_user_notes: boolean;
      preserves_learning_state: boolean;
    }>("/books/rebuild-preview", {
      method: "POST",
      body: JSON.stringify({ book_id, auto_compile: false }),
    }),

  health: (book_id: string) =>
    request<{
      kb_drift: {
        book_id: string;
        has_drift: boolean;
        new_kbs?: string[];
        removed_kbs?: string[];
        changed_kbs?: string[];
        stale_page_ids?: string[];
      };
      log_health: {
        book_id: string;
        total_entries: number;
        error_entries: number;
        block_failures: number;
        last_compile_at?: string;
        last_error_at?: string;
        repeated_failures?: { signature: string; count: number }[];
      };
    }>(`/books/${encodeURIComponent(book_id)}/health`),

  refreshFingerprints: (book_id: string) =>
    request<{
      book_id: string;
      kb_fingerprints: Record<string, string>;
      stale_page_ids: string[];
    }>(`/books/${encodeURIComponent(book_id)}/refresh-fingerprints`, {
      method: "POST",
    }),
};

export interface LegacyChatSession {
  session_id: string;
  messages?: Array<{ role: string; content: string }>;
}

export async function getLegacyChatSession(
  session_id: string,
): Promise<LegacyChatSession | null> {
  const res = await apiFetch(
    apiUrl(`/api/v1/chat/sessions/${encodeURIComponent(session_id)}`),
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`chat session ${session_id} → ${res.status}`);
  return (await res.json()) as LegacyChatSession;
}

// Re-exported so callers can keep importing the event type from book-api.
export type { BookWsEvent } from "@/lib/book-ws-operation";
