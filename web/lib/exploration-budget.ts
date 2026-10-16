import type { StreamEvent } from "@/lib/unified-ws";

export interface ExplorationBudget {
  used: number;
  initial: number;
  limit: number;
  maximum: number;
  settlementRounds: number;
  phase: string;
  reason: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** The same round snapshot is sent during streaming and in the final result.
 * Ignore older/malformed records; never derive rounds from tool-card counts.
 */
export function extractExplorationBudget(events: StreamEvent[] | undefined): ExplorationBudget | null {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event) continue;
    if (event.type !== "progress" && event.type !== "result") continue;
    const envelope = record(event.metadata);
    const nested = record(envelope?.metadata);
    const raw = record(nested?.exploration_budget ?? envelope?.exploration_budget);
    if (!raw) continue;
    const values = [raw.used, raw.initial, raw.limit, raw.maximum, raw.settlement_rounds];
    if (!values.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)) continue;
    const [used, initial, limit, maximum, settlementRounds] = values as number[];
    if (initial < 1 || initial > limit || used > limit || limit > maximum) continue;
    return {
      used, initial, limit, maximum, settlementRounds,
      phase: typeof raw.phase === "string" ? raw.phase : "",
      reason: typeof raw.reason === "string" ? raw.reason : "",
    };
  }
  return null;
}
