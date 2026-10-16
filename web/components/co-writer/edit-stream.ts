import { apiFetch, apiUrl } from "@/lib/api";

export type SelectionEditMode = "rewrite" | "shorten" | "expand" | "none";

export interface SelectionEditStreamRequest {
  selected_text: string;
  instruction: string;
  mode: SelectionEditMode;
  tools: Array<"rag" | "web">;
  kb_name: string | null;
  document_id: string;
}

export interface SelectionEditResult {
  editedText: string;
  operationId: string;
}

export interface SelectionEditTraceEvent {
  type: string;
  stage?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface SelectionEditStreamCallbacks {
  /** Raw `stream` events (tool_call / tool_result / content deltas). */
  onTrace?: (event: SelectionEditTraceEvent) => void;
  signal?: AbortSignal;
}

/**
 * POST /api/v1/co_writer/edit_react/stream — agentic selection edit over SSE.
 *
 * Event names on the wire:
 *   `stream` — intermediate StreamEvent payloads (tool calls, content deltas)
 *   `result` — final payload `{ edited_text: string }`
 *   `error`  — failure payload `{ detail: string }`
 *
 * Resolves with the final edited text; rejects on transport or server error.
 */
export async function streamSelectionEdit(
  request: SelectionEditStreamRequest,
  callbacks: SelectionEditStreamCallbacks = {},
): Promise<SelectionEditResult> {
  const response = await apiFetch(
    apiUrl("/api/v1/co_writer/edit_react/stream"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: callbacks.signal,
      body: JSON.stringify(request),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || `Request failed (${response.status})`);
  }
  if (!response.body) {
    throw new Error("Streaming response body is missing.");
  }

  let finalText: string | undefined;
  let operationId = "";

  const processChunk = (chunk: string) => {
    const lines = chunk.split(/\r?\n/);
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const payload = JSON.parse(dataLines.join("\n"));
    if (eventName === "stream") {
      callbacks.onTrace?.(payload as SelectionEditTraceEvent);
      return;
    }
    if (eventName === "result") {
      finalText = String(
        (payload as { edited_text?: unknown })?.edited_text ?? "",
      );
      operationId = String(
        (payload as { operation_id?: unknown })?.operation_id ?? "",
      );
      return;
    }
    if (eventName === "error") {
      throw new Error(
        String(
          (payload as { detail?: unknown })?.detail ||
            "Failed to edit selected text.",
        ),
      );
    }
  };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (true) {
      const delimiterIndex = buffer.indexOf("\n\n");
      if (delimiterIndex === -1) break;
      const rawEvent = buffer.slice(0, delimiterIndex);
      buffer = buffer.slice(delimiterIndex + 2);
      processChunk(rawEvent);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    processChunk(buffer.trim());
  }

  if (finalText === undefined) {
    throw new Error("Did not receive a final edit result.");
  }
  return { editedText: finalText, operationId };
}
