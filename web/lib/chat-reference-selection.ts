import type {
  HistoryReferencePayload,
  MemoryReferencePayload,
  NotebookReferencePayload,
  QuestionNotebookReferencePayload,
} from "@/lib/chat-types";
import type { BookReferencePayload } from "@/lib/book-references";

export interface ChatReferenceSelection {
  historySessionIds: string[];
  notebooks: Array<{ notebookId: string; recordIds: string[] }>;
  questionEntryIds: number[];
  books: Array<{ bookId: string; pageIds: string[] }>;
  memoryScopes: MemoryReferencePayload;
}

export interface ChatReferencePayload {
  notebookReferences: NotebookReferencePayload[];
  historyReferences: HistoryReferencePayload;
  questionNotebookReferences: QuestionNotebookReferencePayload;
  bookReferences: BookReferencePayload[];
  memoryReferences: MemoryReferencePayload;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function uniqueIntegers(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isInteger(value))));
}

/** Convert the composer's UI selection into the already-supported WS fields. */
export function buildChatReferencePayload(
  selection: ChatReferenceSelection,
): ChatReferencePayload {
  return {
    notebookReferences: selection.notebooks.flatMap((notebook) => {
      const notebookId = notebook.notebookId.trim();
      const recordIds = uniqueStrings(notebook.recordIds);
      return notebookId && recordIds.length
        ? [{ notebook_id: notebookId, record_ids: recordIds }]
        : [];
    }),
    historyReferences: uniqueStrings(selection.historySessionIds),
    questionNotebookReferences: uniqueIntegers(selection.questionEntryIds),
    bookReferences: selection.books.flatMap((book) => {
      const bookId = book.bookId.trim();
      const pageIds = uniqueStrings(book.pageIds);
      return bookId && pageIds.length
        ? [{ book_id: bookId, page_ids: pageIds }]
        : [];
    }),
    memoryReferences: Array.from(new Set(selection.memoryScopes)),
  };
}

/**
 * A turn can target one connected agent. Agent connections are represented by
 * special KB pointers, so replacing the active agent must preserve ordinary
 * document KBs while removing every other agent pointer.
 */
export function toggleExclusiveAgent(
  selectedKnowledgeBases: string[],
  agentNames: string[],
  requestedAgent: string,
): string[] {
  const requested = requestedAgent.trim();
  const agents = new Set(agentNames);
  const withoutAgents = selectedKnowledgeBases.filter((name) => !agents.has(name));
  const alreadySelected = selectedKnowledgeBases.includes(requested);
  return requested && !alreadySelected
    ? [...withoutAgents, requested]
    : withoutAgents;
}

export function countChatReferences(selection: ChatReferenceSelection): number {
  const payload = buildChatReferencePayload(selection);
  return (
    payload.historyReferences.length +
    payload.notebookReferences.reduce(
      (total, item) => total + item.record_ids.length,
      0,
    ) +
    payload.questionNotebookReferences.length +
    payload.bookReferences.reduce(
      (total, item) => total + item.page_ids.length,
      0,
    ) +
    payload.memoryReferences.length
  );
}
