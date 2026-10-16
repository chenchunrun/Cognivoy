import type { StreamEvent } from "@/lib/unified-ws";

export interface ContextBudgetSegment {
  key: string;
  tokens: number;
}

export interface ContextBudget {
  window: number;
  windowEstimated: boolean;
  usedTokens: number;
  freeTokens: number;
  model: string;
  counter: string;
  deferredToolCount: number;
  segments: ContextBudgetSegment[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

/** Read the accounting emitted by the final capability result.
 *
 * The second `metadata` level is part of the shared result envelope, not a UI
 * convenience. Keeping the parser here prevents result rendering from
 * silently drifting if a malformed or older message is loaded.
 */
export function extractContextBudget(events: StreamEvent[] | undefined): ContextBudget | null {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "result") continue;
    const envelope = record(event.metadata);
    const nested = record(envelope?.metadata);
    const raw = record(nested?.context_budget ?? envelope?.context_budget);
    if (!raw) continue;
    const window = nonNegativeInteger(raw.window);
    const usedTokens = nonNegativeInteger(raw.used_tokens);
    const freeTokens = nonNegativeInteger(raw.free_tokens);
    if (!window || usedTokens === null || freeTokens === null) continue;
    const segments = Array.isArray(raw.segments)
      ? raw.segments.flatMap((value) => {
          const item = record(value);
          const tokens = nonNegativeInteger(item?.tokens);
          const key = typeof item?.key === "string" ? item.key.trim() : "";
          return key && tokens !== null ? [{ key, tokens }] : [];
        })
      : [];
    return {
      window,
      windowEstimated: raw.window_estimated === true,
      usedTokens,
      freeTokens,
      model: typeof raw.model === "string" ? raw.model : "",
      counter: typeof raw.counter === "string" ? raw.counter : "",
      deferredToolCount: nonNegativeInteger(raw.deferred_tool_count) ?? 0,
      segments,
    };
  }
  return null;
}

export function contextBudgetUsagePercent(budget: ContextBudget): number {
  if (budget.window <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((budget.usedTokens / budget.window) * 100)));
}

export interface ComposerContextEstimate {
  estimatedTokens: number;
  contextWindow: number | null;
  usagePercent: number | null;
  level: "normal" | "warning" | "critical";
  estimated: true;
}

/** Conservative pre-send estimate.
 *
 * Exact tokenization only exists after parsing attachments, resolving
 * references, mounting tools, and building the final model request. This
 * estimate deliberately reserves system/tool space and uses bounded per-asset
 * allowances; the completed turn replaces it with authoritative accounting.
 */
export function estimateComposerContext({
  text,
  attachmentBytes,
  referenceCount,
  knowledgeBaseCount,
  contextWindow,
}: {
  text: string;
  attachmentBytes: number;
  referenceCount: number;
  knowledgeBaseCount: number;
  contextWindow?: number | null;
}): ComposerContextEstimate {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const other = Math.max(0, text.length - cjk);
  const textTokens = cjk + Math.ceil(other / 4);
  const attachmentTokens = Math.ceil(Math.max(0, attachmentBytes) / 12);
  const referenceTokens = Math.max(0, referenceCount) * 400;
  const knowledgeTokens = Math.max(0, knowledgeBaseCount) * 800;
  const estimatedTokens = Math.max(
    0,
    Math.round(1_800 + textTokens + attachmentTokens + referenceTokens + knowledgeTokens),
  );
  const validWindow =
    typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      ? Math.round(contextWindow)
      : null;
  const usagePercent = validWindow
    ? Math.max(0, Math.round((estimatedTokens / validWindow) * 100))
    : null;
  return {
    estimatedTokens,
    contextWindow: validWindow,
    usagePercent,
    level:
      usagePercent !== null && usagePercent >= 90
        ? "critical"
        : usagePercent !== null && usagePercent >= 70
          ? "warning"
          : "normal",
    estimated: true,
  };
}
