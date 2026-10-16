import type { RagProviderSummary } from "@/lib/knowledge-api";
import { kbProvider, type KnowledgeBase } from "@/lib/knowledge-helpers";

export type KnowledgeEngineStatus =
  | "ready"
  | "needs_setup"
  | "needs_key"
  | "not_installed";

export interface KnowledgeEngineOverview extends RagProviderSummary {
  status: KnowledgeEngineStatus;
  knowledgeBaseCount: number;
}

/** Convert backend provider discovery into the stable status contract used by
 * the Knowledge overview. Keeping this pure makes availability regressions
 * testable without mounting the page. */
export function buildKnowledgeEngineOverview(
  providers: RagProviderSummary[],
  knowledgeBases: KnowledgeBase[],
): KnowledgeEngineOverview[] {
  const counts = new Map<string, number>();
  for (const kb of knowledgeBases) {
    const provider = kbProvider(kb);
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  }

  return providers.map((provider) => ({
    ...provider,
    status:
      provider.configured !== false
        ? provider.ready === false
          ? "needs_setup"
          : "ready"
        : provider.requires_api_key
          ? "needs_key"
          : "not_installed",
    knowledgeBaseCount: counts.get(provider.id) ?? 0,
  }));
}
