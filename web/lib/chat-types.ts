/**
 * Shared chat message types. These used to live in the chat context module;
 * extracted so UI-agnostic helpers (lib/) can import them without pulling in
 * React state machinery.
 */

import type { StreamEvent, LLMSelection } from "@/lib/unified-ws";
import type { BookReferencePayload } from "@/lib/book-references";

export interface NotebookReferencePayload {
  notebook_id: string;
  record_ids: string[];
}

export type HistoryReferencePayload = string[];

export type QuestionNotebookReferencePayload = number[];

export type MemoryReferencePayload = Array<"summary" | "profile">;

export interface MessageAttachment {
  type: string;
  filename?: string;
  base64?: string;
  url?: string;
  /** Structured slide layout preview endpoint for PPTX files. */
  slide_preview_url?: string;
  /** Extracted model-readable plain-text preview endpoint. */
  text_preview_url?: string;
  mime_type?: string;
  /** Stable per-attachment id; matches the URL segment served by /api/attachments. */
  id?: string;
  /** Plain-text rendering of office docs, populated by the backend extractor. */
  extracted_text?: string;
  /** Set on files the assistant produced this turn rather than user uploads. */
  generated?: boolean;
  /** Byte size of the generated file, for the card's subtitle. */
  size_bytes?: number;
  /** Optional retrieval anchor used to focus the preview on cited evidence. */
  preview_page?: number;
  preview_section?: string;
  preview_focus_text?: string;
}

export interface MessageRequestSnapshot {
  content: string;
  capability?: string | null;
  enabledTools: string[];
  knowledgeBases: string[];
  language: string;
  attachments?: MessageAttachment[];
  config?: Record<string, unknown>;
  notebookReferences?: NotebookReferencePayload[];
  historyReferences?: HistoryReferencePayload;
  questionNotebookReferences?: QuestionNotebookReferencePayload;
  bookReferences?: BookReferencePayload[];
  persona?: string;
  memoryReferences?: MemoryReferencePayload;
  llmSelection?: LLMSelection | null;
  learningContext?: {
    project_id: string;
    task_id: string;
    objective: string;
  };
}

export interface MessageItem {
  id?: number;
  role: "user" | "assistant" | "system";
  content: string;
  capability?: string;
  events?: StreamEvent[];
  attachments?: MessageAttachment[];
  requestSnapshot?: MessageRequestSnapshot;
  /** Edit-branching: id of the message this row continues. */
  parentMessageId?: number | null;
}
