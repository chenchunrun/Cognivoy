"use client";

/**
 * Embedded web chat with a partner over `WS /api/v1/partners/{id}/ws`.
 *
 * The socket forwards chat-loop StreamEvents verbatim (`stream_event` frames
 * carry the backend event dict, which IS the `StreamEvent` shape), so the
 * answer text is accumulated with the same narration-demotion rules as the
 * main chat (lib/stream). The composer is a plain textarea — attachments and
 * slash commands are intentionally left to the channels / Sessions tab.
 */

import * as React from "react";
import { ArrowUp, Plus, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { wsUrl } from "@/lib/api";
import {
  archivePartnerSession,
  getPartnerHistory,
} from "@/lib/partners-api";
import { freshPartnerSessionKey } from "@/lib/partner-session";
import { partnerProgressLabel } from "@/lib/partner-progress";
import type { StreamEvent } from "@/lib/unified-ws";
import {
  isNarrationMarker,
  recomputeAnswerContent,
  shouldAppendEventContent,
} from "@/lib/stream";
import { Avatar, Button, Textarea, useToast } from "@/components/ui";
import { Markdown } from "@/components/chat/Markdown";
import { cn } from "@/lib/utils";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
}

interface LiveDraft {
  events: StreamEvent[];
  content: string;
}

export function PartnerChat({
  partnerId,
  partnerName,
  partnerAvatar,
  running,
  sessionKey,
  onSessionKeyChange,
}: {
  partnerId: string;
  partnerName: string;
  partnerAvatar?: string;
  running: boolean;
  /** The active web session key (canonical id), owned by the page so the
   *  Sessions tab can point this chat at a different conversation. */
  sessionKey: string;
  onSessionKeyChange: (key: string) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [messages, setMessages] = React.useState<ChatMsg[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(true);
  const [streaming, setStreaming] = React.useState(false);
  const [connected, setConnected] = React.useState(false);
  const [input, setInput] = React.useState("");
  const [draft, setDraft] = React.useState<LiveDraft | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);

  const wsRef = React.useRef<WebSocket | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = React.useRef(true);
  // Mirror the active session into a ref so the socket's onopen (which closes
  // over the effect's first render) attaches to the CURRENT session.
  const sessionKeyRef = React.useRef(sessionKey);
  React.useEffect(() => {
    sessionKeyRef.current = sessionKey;
  }, [sessionKey]);
  // Attach to an in-flight turn only AFTER history has loaded, so the replay's
  // echoed question + answer aren't clobbered by the history replace.
  const historyReadyRef = React.useRef(false);
  const attachedRef = React.useRef(false);

  const scrollToBottom = React.useCallback((instant = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: instant ? "instant" : "smooth" });
  }, []);

  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Follow the stream while the user is pinned to the bottom.
  React.useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom(true);
  }, [messages, draft, scrollToBottom]);

  const tryAttach = React.useCallback(() => {
    if (attachedRef.current) return;
    if (!historyReadyRef.current || !sessionKeyRef.current) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    attachedRef.current = true;
    wsRef.current.send(
      JSON.stringify({ action: "attach", session_key: sessionKeyRef.current }),
    );
  }, []);

  // Restore the active session's history; re-runs when the page switches the
  // active session (resume from the Sessions tab).
  React.useEffect(() => {
    if (!sessionKey) return;
    let cancelled = false;
    historyReadyRef.current = false;
    setHistoryLoading(true);
    void getPartnerHistory(partnerId, { sessionKey, limit: 60 })
      .then((history) => {
        if (cancelled) return;
        stickToBottomRef.current = true;
        setMessages(
          history
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
            })),
        );
      })
      .catch(() => {
        /* a fresh session has no history yet — start empty */
      })
      .finally(() => {
        if (cancelled) return;
        historyReadyRef.current = true;
        setHistoryLoading(false);
        tryAttach();
        requestAnimationFrame(() => scrollToBottom(true));
      });
    return () => {
      cancelled = true;
    };
  }, [partnerId, sessionKey, scrollToBottom, tryAttach]);

  // Socket lifecycle — one connection per partner, torn down when stopped.
  React.useEffect(() => {
    if (!running) {
      wsRef.current?.close();
      wsRef.current = null;
      setConnected(false);
      setStreaming(false);
      setDraft(null);
      return;
    }

    attachedRef.current = false;
    const ws = new WebSocket(wsUrl(`/api/v1/partners/${partnerId}/ws`));
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      // Reattach to an in-flight turn (survives a page refresh): the server
      // replays its buffered stream, so a mid-answer reload keeps streaming.
      tryAttach();
    };

    // Authoritative live-turn accumulator; renders see snapshots only.
    let live: LiveDraft | null = null;
    const publish = () => {
      setDraft(live ? { events: [...live.events], content: live.content } : null);
    };

    ws.onmessage = (e) => {
      let data: { type: string; content?: string; event?: StreamEvent };
      try {
        data = JSON.parse(e.data as string) as typeof data;
      } catch {
        return;
      }
      if (data.type === "resuming") {
        live = { events: [], content: "" };
        setStreaming(true);
        publish();
      } else if (data.type === "user_echo") {
        setMessages((msgs) => [...msgs, { role: "user", content: data.content ?? "" }]);
      } else if (data.type === "stream_event" && data.event) {
        const event = data.event;
        live ??= { events: [], content: "" };
        live.events.push(event);
        if (shouldAppendEventContent(event)) {
          live.content += event.content;
        } else if (isNarrationMarker(event)) {
          // A round resolved as narration — its streamed text belongs to the
          // trace, not the answer. Same demotion rule as product chat.
          live.content = recomputeAnswerContent(live.events);
        }
        publish();
      } else if (data.type === "content") {
        // Authoritative final text from the runner.
        const finished = live;
        live = null;
        setMessages((msgs) => [
          ...msgs,
          { role: "assistant", content: data.content || finished?.content || "" },
        ]);
        publish();
      } else if (data.type === "done") {
        setStreaming(false);
        live = null;
        publish();
      } else if (data.type === "stopped") {
        // Server cancelled the turn. Keep any partial answer already shown.
        const finished = live;
        live = null;
        if (finished?.content) {
          setMessages((msgs) => [
            ...msgs,
            { role: "assistant", content: finished.content },
          ]);
        }
        setStreaming(false);
        publish();
      } else if (data.type === "proactive") {
        setMessages((msgs) => [
          ...msgs,
          { role: "assistant", content: data.content ?? "" },
        ]);
      } else if (data.type === "error") {
        setMessages((msgs) => [
          ...msgs,
          { role: "assistant", content: data.content ?? "Error", error: true },
        ]);
        live = null;
        publish();
        setStreaming(false);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setStreaming(false);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [partnerId, running, tryAttach]);

  const sendStop = React.useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(
        JSON.stringify({ action: "stop", session_key: sessionKeyRef.current }),
      );
    }
  }, []);

  React.useEffect(() => {
    if (!streaming) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  const startNewConversation = React.useCallback(() => {
    void archivePartnerSession(partnerId, sessionKey).catch(() => {});
    setMessages([]);
    setDraft(null);
    onSessionKeyChange(freshPartnerSessionKey());
  }, [partnerId, sessionKey, onSessionKeyChange]);

  const handleSend = React.useCallback(() => {
    const content = input.trim();
    if (!content || streaming || !running) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      toast({
        title: t("Not connected to the partner yet — try again in a moment."),
        variant: "destructive",
      });
      return;
    }
    stickToBottomRef.current = true;
    wsRef.current.send(
      JSON.stringify({ content, session_key: sessionKeyRef.current }),
    );
    setMessages((msgs) => [...msgs, { role: "user", content }]);
    setDraft({ events: [], content: "" });
    setStreaming(true);
    setInput("");
    requestAnimationFrame(() => scrollToBottom(true));
  }, [input, streaming, running, scrollToBottom, t, toast]);

  const canSend = connected && running && !streaming && input.trim().length > 0;
  const progressLabel = partnerProgressLabel(draft?.events ?? []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-1 py-5"
      >
        {historyLoading ? (
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {[0, 1].map((i) => (
              <div key={i} className="flex items-start gap-2.5">
                <span className="h-7 w-7 animate-pulse rounded-full bg-muted" />
                <span className="h-16 flex-1 animate-pulse rounded-xl bg-muted" />
              </div>
            ))}
          </div>
        ) : messages.length === 0 && !draft ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <Avatar
              src={partnerAvatar || null}
              alt={partnerName}
              size="lg"
              className="h-14 w-14 text-base"
            />
            <div>
              <p className="display text-base font-medium text-foreground">
                {partnerName}
              </p>
              <p className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
                {running
                  ? t(
                      "Say hello — this conversation shares the same memory your partner has on its connected channels.",
                    )
                  : t("Partner is stopped. Start it before chatting.")}
              </p>
            </div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {messages.map((msg, i) =>
              msg.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[75%] whitespace-pre-wrap rounded-2xl bg-secondary px-4 py-2.5 text-sm leading-relaxed text-foreground shadow-hairline">
                    {msg.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex items-start gap-2.5">
                  <Avatar
                    src={partnerAvatar || null}
                    alt={partnerName}
                    size="sm"
                  />
                  <div className="min-w-0 flex-1 pt-0.5">
                    {msg.error ? (
                      <p className="text-sm text-destructive">{msg.content}</p>
                    ) : (
                      <div className="prose-cognivoy text-sm">
                        <Markdown content={msg.content} />
                      </div>
                    )}
                  </div>
                </div>
              ),
            )}

            {draft && (
              <div className="flex items-start gap-2.5">
                <Avatar
                  src={partnerAvatar || null}
                  alt={partnerName}
                  size="sm"
                />
                <div className="min-w-0 flex-1 pt-0.5">
                  {draft.content ? (
                    <div className="prose-cognivoy text-sm">
                      <Markdown content={draft.content} />
                    </div>
                  ) : (
                    <span
                      className="inline-flex items-center gap-2 text-sm text-muted-foreground"
                      role="status"
                      aria-live="polite"
                    >
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                      {t(progressLabel)}
                      {elapsedSeconds >= 5 && (
                        <span className="tabular-nums text-muted-foreground">
                          · {t("{{seconds}} seconds elapsed", { seconds: elapsedSeconds })}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="mx-auto w-full max-w-2xl px-1 pb-4">
        <div className="mb-1.5 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {!running
              ? t("Partner is stopped. Start it before chatting.")
              : !connected
                ? t("Connecting…")
                : streaming
                  ? t(progressLabel)
                  : ""}
          </p>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={startNewConversation}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <Plus className="h-3 w-3" />
              {t("New conversation")}
            </button>
          )}
        </div>
        <div
          className={cn(
            "flex items-end gap-2 rounded-xl border border-border bg-card p-2 transition-colors",
            "focus-within:ring-2 focus-within:ring-ring",
          )}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                handleSend();
              }
            }}
            autoResize
            rows={1}
            disabled={!connected || !running}
            placeholder={
              running ? t("Message your partner…") : t("Start the partner to chat")
            }
            className="max-h-40 min-h-[36px] flex-1 resize-none border-0 bg-transparent shadow-none focus-visible:ring-0"
          />
          {streaming ? (
            <Button
              size="icon"
              variant="secondary"
              onClick={sendStop}
              aria-label={t("Stop")}
              title={t("Stop")}
            >
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!canSend}
              aria-label={t("Send")}
              title={t("Send")}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
