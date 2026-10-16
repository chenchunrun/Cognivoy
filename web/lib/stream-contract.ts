import type { StreamEvent, StreamEventType } from "./unified-ws";

const eventTypes = new Set<StreamEventType>([
  "stage_start", "stage_end", "thinking", "observation", "content",
  "tool_call", "tool_result", "progress", "sources", "result", "error",
  "session", "session_meta", "done", "wait_for_input",
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate before touching resume state. Omitted envelope fields are supported
 * for the backend's lightweight errors; supplied fields must have valid types. */
export function parseStreamFrame(frame: unknown): StreamEvent | "heartbeat" | null {
  if (typeof frame !== "string") return null;
  let value: unknown;
  try { value = JSON.parse(frame); } catch { return null; }
  if (!record(value)) return null;
  if (value.type === "ping" || value.type === "pong") return "heartbeat";
  if (!eventTypes.has(value.type as StreamEventType)) return null;
  for (const field of ["source", "stage", "content", "session_id", "turn_id"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") return null;
  }
  if (value.metadata !== undefined && !record(value.metadata)) return null;
  if (value.type === "session" && record(value.metadata)) {
    for (const field of ["session_id", "turn_id"]) {
      if (value.metadata[field] !== undefined && typeof value.metadata[field] !== "string") return null;
    }
  }
  if (value.seq !== undefined &&
      (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0)) return null;
  if (typeof value.seq === "number" && value.seq > 0 && !value.turn_id) return null;
  if (value.timestamp !== undefined &&
      (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp) || value.timestamp < 0)) return null;
  return {
    source: "", stage: "", content: "", metadata: {}, timestamp: 0,
    ...value,
  } as StreamEvent;
}

/** Sequence numbers are scoped to a turn, never to the connection/session. */
export function nextResumeSequence(
  turnId: string | null, seq: number, event: StreamEvent,
): number {
  if (event.turn_id && event.turn_id !== turnId) return event.seq ?? 0;
  return Math.max(seq, event.seq ?? 0);
}
