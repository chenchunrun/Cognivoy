import type {
  DeletedKnowledgeReference,
} from "@/lib/knowledge-api";

export function deletedKnowledgeBaseSet(
  tombstones: DeletedKnowledgeReference[],
): Set<string> {
  return new Set(tombstones.map((item) => item.name).filter(Boolean));
}

export function referenceKnowledgeBaseName(
  reference: Record<string, unknown>,
): string | null {
  const kind = String(reference.type ?? reference.kind ?? "").toLowerCase();
  if (!["kb", "knowledge_base", "knowledge-base"].includes(kind)) return null;
  const target = reference.name ?? reference.id ?? reference.kb_name;
  return typeof target === "string" && target.trim() ? target : null;
}
