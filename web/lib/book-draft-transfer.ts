export const BOOK_DRAFT_PREFIX = "cognivoy:book-draft:";

export interface BookDraftTransfer {
  version: 1;
  key: string;
  sourceType: "deep_research" | "chat" | "co_writer";
  sourceId: string;
  title: string;
  content: string;
  intent: string;
  createdAt: number;
}

export function buildBookDraftTransfer(input: {
  sourceType: BookDraftTransfer["sourceType"];
  sourceId: string;
  title: string;
  content: string;
}): BookDraftTransfer {
  const sourceId = input.sourceId.trim() || "unsaved";
  const key = `book-draft:${input.sourceType}:${sourceId}:${Date.now()}`;
  const title = input.title.trim() || "Learning book";
  // Preserve the authored report byte-for-byte; only the derived prompt may
  // normalize its outer whitespace.
  const content = input.content;
  return {
    version: 1,
    key,
    sourceType: input.sourceType,
    sourceId,
    title,
    content,
    intent: [
      `Build a structured learning book from \"${title}\".`,
      "Preserve the report's evidence and citations, teach prerequisite concepts before dependent ones, and add retrieval practice.",
      "",
      content.trim(),
    ].join("\n"),
    createdAt: Date.now(),
  };
}

export function parseBookDraftTransfer(raw: string | null): BookDraftTransfer | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<BookDraftTransfer>;
    if (
      value.version !== 1 ||
      typeof value.key !== "string" ||
      typeof value.sourceType !== "string" ||
      !["deep_research", "chat", "co_writer"].includes(value.sourceType) ||
      typeof value.sourceId !== "string" ||
      typeof value.title !== "string" ||
      typeof value.content !== "string" ||
      typeof value.intent !== "string" ||
      typeof value.createdAt !== "number"
    ) {
      return null;
    }
    return value as BookDraftTransfer;
  } catch {
    return null;
  }
}

export function storeBookDraftTransfer(transfer: BookDraftTransfer): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(`${BOOK_DRAFT_PREFIX}${transfer.key}`, JSON.stringify(transfer));
}

export function consumeBookDraftTransfer(key: string): BookDraftTransfer | null {
  if (typeof window === "undefined" || !key) return null;
  const storageKey = `${BOOK_DRAFT_PREFIX}${key}`;
  const transfer = parseBookDraftTransfer(window.sessionStorage.getItem(storageKey));
  if (transfer) window.sessionStorage.removeItem(storageKey);
  return transfer;
}
