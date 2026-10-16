export interface CoWriterLocalDraft {
  version: 1;
  documentId: string;
  title: string;
  content: string;
  baseRevision: number;
  savedAt: number;
}
const PREFIX = "cognivoy:co-writer:draft:";
const MAX_SERIALIZED_BYTES = 1_500_000;

export function coWriterDraftKey(documentId: string): string {
  return `${PREFIX}${encodeURIComponent(documentId)}`;
}

export function serializeCoWriterDraft(
  draft: Omit<CoWriterLocalDraft, "version">,
): string | null {
  const serialized = JSON.stringify({ version: 1, ...draft });
  return new TextEncoder().encode(serialized).byteLength <= MAX_SERIALIZED_BYTES
    ? serialized
    : null;
}

export function parseCoWriterDraft(
  raw: string | null,
  documentId: string,
): CoWriterLocalDraft | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<CoWriterLocalDraft>;
    if (
      value.version !== 1 ||
      value.documentId !== documentId ||
      typeof value.title !== "string" ||
      typeof value.content !== "string" ||
      !Number.isInteger(value.baseRevision) ||
      Number(value.baseRevision) < 1 ||
      !Number.isFinite(value.savedAt)
    ) {
      return null;
    }
    return value as CoWriterLocalDraft;
  } catch {
    return null;
  }
}
