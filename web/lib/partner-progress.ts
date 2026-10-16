import type { StreamEvent } from "@/lib/unified-ws";

export function partnerProgressLabel(events: StreamEvent[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const toolName = String(
      event.metadata?.tool_name ??
        event.metadata?.name ??
        event.metadata?.tool ??
        (event.type === "tool_call" ? event.content : ""),
    );

    if (toolName === "rag" || event.stage === "rag_retrieval") {
      return "Searching the knowledge base…";
    }
    if (toolName === "partner_read") return "Reading tutor memory…";
    if (toolName === "list_notebook") return "Reading learning notes…";
    if (toolName === "partner_search") return "Searching past conversations…";
    if (toolName === "partner_memorize") return "Updating your learning profile…";
    if (toolName === "ask_user") return "Preparing diagnostic questions…";
    if (event.type === "thinking" || event.type === "stage_start") {
      return "Analyzing and organizing the response…";
    }
  }
  return "Thinking…";
}
