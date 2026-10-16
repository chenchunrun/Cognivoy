"use client";

import * as React from "react";
import { Loader2, MessageSquare, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Markdown } from "@/components/chat/Markdown";
import { readStoredResponseLanguage } from "@/context/app-shell-storage";
import type { Book, Page } from "@/lib/book-types";
import { getSession } from "@/lib/session-api";
import { shouldAppendEventContent } from "@/lib/stream";
import {
  UnifiedWSClient,
  type StartTurnMessage,
  type StreamEvent,
} from "@/lib/unified-ws";

interface PageChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function BookPageChat({
  book,
  page,
  sessionId,
  onSessionResolved,
  onClose,
}: {
  book: Book;
  page: Page;
  sessionId?: string | null;
  onSessionResolved: (sessionId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [messages, setMessages] = React.useState<PageChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const sessionRef = React.useRef(sessionId || null);
  const clientRef = React.useRef<UnifiedWSClient | null>(null);
  const retryTimerRef = React.useRef<number | null>(null);
  const scrollerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    sessionRef.current = sessionId || null;
    if (!sessionId) return;
    const controller = new AbortController();
    void getSession(sessionId, controller.signal)
      .then((detail) =>
        setMessages(
          detail.messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .map((message) => ({ role: message.role as "user" | "assistant", content: message.content })),
        ),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, [sessionId]);

  React.useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      clientRef.current?.disconnect();
    };
  }, []);

  React.useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  const handleEvent = React.useCallback(
    (event: StreamEvent) => {
      if (event.type === "session") {
        const metadata = (event.metadata || {}) as Record<string, unknown>;
        const nextId = typeof metadata.session_id === "string" ? metadata.session_id : event.session_id;
        if (nextId) {
          sessionRef.current = nextId;
          onSessionResolved(nextId);
        }
        return;
      }
      if (event.type === "done" || event.type === "error") {
        if (event.type === "error" && event.content) {
          setMessages((current) => [...current, { role: "assistant", content: event.content || t("Error") }]);
        }
        setBusy(false);
        return;
      }
      if (!shouldAppendEventContent(event) || !event.content) return;
      setMessages((current) => {
        const last = current[current.length - 1];
        if (last?.role === "assistant") {
          return [...current.slice(0, -1), { ...last, content: last.content + event.content }];
        }
        return [...current, { role: "assistant", content: event.content || "" }];
      });
    },
    [onSessionResolved, t],
  );

  const send = () => {
    const content = input.trim();
    if (!content || busy) return;
    setMessages((current) => [...current, { role: "user", content }]);
    setInput("");
    setBusy(true);
    let client = clientRef.current;
    if (!client) {
      client = new UnifiedWSClient(handleEvent, () => setBusy(false));
      clientRef.current = client;
      client.connect();
    }
    const payload: StartTurnMessage = {
      type: "start_turn",
      content,
      session_id: sessionRef.current,
      capability: "chat",
      tools: book.knowledge_bases.length ? ["rag"] : [],
      knowledge_bases: book.knowledge_bases,
      language: readStoredResponseLanguage(),
      book_references: [{ book_id: book.id, page_ids: [page.id] }],
    };
    const sendWhenReady = (attempt = 0) => {
      if (client?.connected) client.send(payload);
      else if (attempt < 20) retryTimerRef.current = window.setTimeout(() => sendWhenReady(attempt + 1), 100);
      else setBusy(false);
    };
    sendWhenReady();
  };

  return (
    <aside className="flex h-full w-[min(26rem,45vw)] shrink-0 flex-col border-l border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground"><MessageSquare size={15} />{t("Page Chat")}</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">{page.title}</div>
        </div>
        <button type="button" onClick={onClose} aria-label={t("Close")} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><X size={15} /></button>
      </header>
      <div ref={scrollerRef} className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-xs leading-relaxed text-muted-foreground">{t("Ask about this page. Its content is attached as context automatically.")}</p>
        ) : (
          <div className="space-y-4">
            {messages.map((message, index) => (
              <div key={index} className={message.role === "user" ? "ml-8 rounded-xl bg-primary-muted p-3 text-sm text-foreground" : "prose-cognivoy text-sm"}>
                {message.role === "assistant" ? <Markdown content={message.content} /> : message.content}
              </div>
            ))}
          </div>
        )}
      </div>
      <form onSubmit={(event) => { event.preventDefault(); send(); }} className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <textarea value={input} onChange={(event) => setInput(event.target.value)} rows={2} placeholder={t("Ask about this page…")} className="max-h-28 flex-1 resize-none bg-transparent px-1 text-sm text-foreground outline-none" />
          <button type="submit" disabled={busy || !input.trim()} aria-label={t("Send")} className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground disabled:opacity-40">{busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}</button>
        </div>
      </form>
    </aside>
  );
}

export default BookPageChat;
