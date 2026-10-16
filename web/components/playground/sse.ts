/**
 * Minimal SSE reader for the plugin `execute-stream` endpoints.
 *
 * Frames look like:
 *   event: process_log\n
 *   data: {"message": "..."}\n
 *   \n
 * Supports CRLF, multi-line data fields, and a final frame without a trailing
 * blank line so proxy buffering or an abrupt stream close cannot hide the
 * authoritative result/error event.
 */

export type SseHandler = (
  eventType: string,
  payload: Record<string, unknown>,
) => void;

export async function readSseStream(
  res: Response,
  onEvent: SseHandler,
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (frame: string) => {
    if (!frame.trim()) return;
    const lines = frame.replace(/\r/g, "").split("\n");
    const eventType = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!eventType || !data) return;
    try {
      onEvent(eventType, JSON.parse(data) as Record<string, unknown>);
    } catch {
      // A malformed frame is isolated; later events must still be processed.
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      dispatch(part);
    }
  }
  buffer += decoder.decode();
  dispatch(buffer);
}
