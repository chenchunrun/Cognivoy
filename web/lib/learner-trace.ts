import type { StreamEvent } from "@/lib/unified-ws";

export type LearnerTraceItem =
  | { kind: "tool"; key: string; name: string; pending: boolean; failed?: boolean }
  | { kind: "sources"; key: string; sources: Array<{ title: string; url: string }> }
  | { kind: "progress"; key: string; text: string }
  | { kind: "warning"; key: string; text: string }
  | { kind: "error"; key: string; text: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseSources(meta: Record<string, unknown> | null) {
  const raw = Array.isArray(meta?.sources) ? meta.sources : [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record) return [];
    const url = typeof record.url === "string" ? record.url : typeof record.link === "string" ? record.link : "";
    const candidates = [
      record.title,
      record.filename,
      record.source,
      record.chunk_id,
      record.kb_name,
      url,
    ];
    const title = candidates.find(
      (candidate): candidate is string =>
        typeof candidate === "string" && Boolean(candidate.trim()),
    )?.trim() ?? "";
    // Local RAG chunks often have a stable document/chunk identity but no
    // browser-accessible URL. Keep those as plain provenance chips instead of
    // silently making a grounded answer look uncited.
    if (!title) return [];
    return [{ title, url }];
  });
}

function normalizedProgressText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isUnsafeDiagnostic(text: string): boolean {
  return (
    text.includes("Traceback (most recent call last)") ||
    text.includes("[isolated worker]") ||
    text.includes("site-packages/") ||
    /^File ["'].+line \d+/m.test(text)
  );
}

/** Hide obsolete success copy only for an already-identified legacy placeholder.
 * Keep the original stored events intact, including the actual timeout warning.
 */
export function hideLegacyVisualizeSuccessEvents(
  events: StreamEvent[] | undefined,
  legacyFallback: boolean,
): StreamEvent[] | undefined {
  if (!events || !legacyFallback) return events;
  return events.filter((event) => !(
    event.type === "progress" && event.source === "visualize" && (
      (event.stage === "generating" && ["Code generated.", "代码已生成。"].includes((event.content || "").trim())) ||
      (event.stage === "reviewing" && ["Looks good — passed local checks.", "通过本地校验，看起来没问题。"].includes((event.content || "").trim()))
    )
  ));
}

/** Convert raw runtime events into the only process details learners may see. */
export function buildLearnerTraceItems(
  events: StreamEvent[],
  live: boolean,
): LearnerTraceItem[] {
  const items: LearnerTraceItem[] = [];
  const seenProgress = new Set<string>();
  const resultByCallId = new Map<string, StreamEvent>();
  const anonymousResults: StreamEvent[] = [];
  for (const event of events) {
    if (event.type !== "tool_result") continue;
    const callId = asRecord(event.metadata)?.tool_call_id;
    if (typeof callId === "string" && callId) resultByCallId.set(callId, event);
    else anonymousResults.push(event);
  }

  let seq = 0;
  for (const event of events) {
    const meta = asRecord(event.metadata);
    switch (event.type) {
      case "thinking":
      case "content":
      case "observation":
        // Never expose chain-of-thought, protocol narration, or raw tool output.
        break;
      case "tool_call": {
        const name =
          (typeof meta?.tool_name === "string" && meta.tool_name) ||
          (typeof meta?.tool === "string" && meta.tool) ||
          "tool";
        const callId = typeof meta?.tool_call_id === "string" ? meta.tool_call_id : "";
        const result = (callId && resultByCallId.get(callId)) || anonymousResults.shift();
        const resultMeta = asRecord(result?.metadata);
        const toolMeta = asRecord(resultMeta?.tool_metadata);
        items.push({
          kind: "tool",
          key: `c${seq++}`,
          name,
          pending: !result && live,
          failed: Boolean(
            resultMeta?.success === false || resultMeta?.error ||
            toolMeta?.success === false || toolMeta?.error || (!result && !live)
          ),
        });
        break;
      }
      case "sources": {
        const sources = parseSources(meta);
        if (sources.length) items.push({ kind: "sources", key: `s${seq++}`, sources });
        break;
      }
      case "progress": {
        if (meta?.ask_user_resolved) break;
        if (meta?.trace_kind === "exploration_budget") break;
        const text = event.content || "";
        // Raw provider/process logs belong to diagnostics, not the learning
        // narrative. The defensive text check also protects older persisted
        // events that predate trace-layer metadata.
        if (
          meta?.trace_layer === "raw" ||
          meta?.trace_kind === "raw_log" ||
          isUnsafeDiagnostic(text)
        ) {
          break;
        }
        const normalized = normalizedProgressText(text);
        if (normalized && !seenProgress.has(normalized)) {
          seenProgress.add(normalized);
          items.push({
            kind: meta?.trace_kind === "warning" ? "warning" : "progress",
            key: `p${seq++}`,
            text: text.trim(),
          });
        }
        break;
      }
      case "error":
        if (event.content) items.push({ kind: "error", key: `e${seq++}`, text: event.content });
        break;
      default:
        break;
    }
  }
  return items;
}
