import type { MessageRequestSnapshot } from "@/lib/chat-types";
import type { StreamEvent } from "@/lib/unified-ws";

export interface TerminalRecovery {
  reason: string;
  status: string;
  retryable: boolean;
  timeoutSeconds: number | null;
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function extractTerminalRecovery(events: StreamEvent[] | undefined): TerminalRecovery | null {
  if (!Array.isArray(events)) return null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type !== "error") continue;
    const metadata = record(event.metadata);
    if (metadata?.turn_terminal !== true) continue;
    const reason = typeof metadata.reason === "string" ? metadata.reason : "turn_failed";
    const status = typeof metadata.status === "string" ? metadata.status : "failed";
    const seconds = metadata.timeout_seconds;
    return {
      reason,
      status,
      retryable:
        typeof metadata.retryable === "boolean"
          ? metadata.retryable
          : status === "timed_out" || reason.includes("timeout"),
      timeoutSeconds:
        typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
          ? Math.round(seconds)
          : null,
    };
  }
  return null;
}

/** Preserve the exact prior request while reducing the expensive dimension
 * understood by each long-running capability. Unknown fields are retained so
 * retry never drops citations, output format, or user constraints.
 */
export function buildQuickRetrySnapshot(
  snapshot: MessageRequestSnapshot,
): MessageRequestSnapshot {
  const config = { ...(snapshot.config ?? {}) };
  switch (snapshot.capability) {
    case "deep_research":
      config.depth = "quick";
      config.max_sources = Math.min(
        typeof config.max_sources === "number" ? config.max_sources : 12,
        12,
      );
      break;
    case "deep_solve":
      config.depth = "quick";
      config.max_rounds = Math.min(
        typeof config.max_rounds === "number" ? config.max_rounds : 6,
        6,
      );
      break;
    case "visualize":
    case "math_animator":
      config.quality = "low";
      break;
    default:
      break;
  }
  return {
    ...snapshot,
    enabledTools: [...snapshot.enabledTools],
    knowledgeBases: [...snapshot.knowledgeBases],
    config,
  };
}
