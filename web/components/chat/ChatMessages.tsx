"use client";

/**
 * The scrollable chat transcript. Renders the visible branch path of the
 * session (user bubbles right-aligned, assistant answers full-width with a
 * collapsible thought-process trace), inline ask_user cards, per-branch
 * navigators, and hover actions (copy / regenerate / edit). Sticks to the
 * bottom while streaming until the user scrolls away, then offers a
 * floating "back to bottom" button.
 */

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowDown,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileImage,
  Pencil,
  RotateCcw,
  Loader2,
  Square,
  Volume2,
  VolumeX,
  Download,
  NotebookPen,
  FilePenLine,
  HelpCircle,
  Shuffle,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useUnifiedChat } from "@/context/UnifiedChatContext";
import { useChatScroll } from "@/hooks/useChatScroll";
import type { MessageAttachment, MessageItem } from "@/lib/chat-types";
import { buildVisiblePath, type SiblingInfo } from "@/lib/message-branches";
import { docIconFor } from "@/lib/doc-attachments";
import { extractMathAnimatorResult } from "@/lib/math-animator-types";
import { extractVisualizeResult, isManimResult } from "@/lib/visualize-types";
import { hideLegacyVisualizeSuccessEvents } from "@/lib/learner-trace";
import { extractResearchOutlineResult } from "@/lib/deep-research-types";
import {
  extractQuizQuestions,
  extractQuizTurnId,
  extractStreamingQuizQuestions,
  buildQuizFollowupConfig,
  buildQuizRecoveryConfig,
  type QuizQuestion,
} from "@/lib/quiz-types";
import { createResearchCheckpointId, type OutlineItem } from "@/lib/research-types";
import { Badge, Button, Spinner, Textarea, useToast } from "@/components/ui";
import { cn } from "@/lib/utils";

import { Markdown } from "./Markdown";
import { TraceBlock } from "./TraceBlock";
import { learningStageLabel } from "@/lib/learning-stage";
import { AskUserCard, extractAskUserCardData } from "./AskUserCard";
import FilePreviewDrawer from "./FilePreviewDrawer";
import ResearchOutlinePreview from "./ResearchOutlinePreview";
import { apiFetch, apiUrl } from "@/lib/api";
import { downloadChatMarkdown } from "@/lib/chat-export";
import { createCoWriterDocument } from "@/lib/co-writer-api";
import {
  buildBookDraftTransfer,
  storeBookDraftTransfer,
} from "@/lib/book-draft-transfer";
import { downloadTextAsset } from "@/lib/visualization-assets";
import { extractContextBudget } from "@/lib/context-budget";
import { extractTerminalRecovery } from "@/lib/chat-recovery";
import { extractLearningResult } from "@/lib/learning-result";
import { LearningResultCard } from "@/components/learning/LearningResultCard";
import SaveMessageToNotebookDialog from "./SaveMessageToNotebookDialog";
import ContextBudgetCard from "./ContextBudgetCard";
import TurnRecoveryCard from "./TurnRecoveryCard";
import {
  effectiveVoiceAutoplay,
  isMissingTtsConfiguration,
  loadVoiceAutoplayOverride,
  saveVoiceAutoplayOverride,
  ttsConfiguredFromDependencies,
  type VoiceAutoplayOverride,
} from "@/lib/voice-autoplay";

const VisualizationViewer = dynamic(() => import("./VisualizationViewer"), {
  ssr: false,
});
const MathAnimatorViewer = dynamic(() => import("./MathAnimatorViewer"), {
  ssr: false,
});
const QuizViewer = dynamic(() => import("@/components/quiz/QuizViewer"), {
  ssr: false,
});

let deferredMarkdownObserver: IntersectionObserver | null = null;
const deferredMarkdownCallbacks = new WeakMap<Element, () => void>();

function observeDeferredMarkdown(element: Element, reveal: () => void) {
  if (typeof IntersectionObserver === "undefined") {
    reveal();
    return () => undefined;
  }
  deferredMarkdownObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = deferredMarkdownCallbacks.get(entry.target);
        deferredMarkdownObserver?.unobserve(entry.target);
        deferredMarkdownCallbacks.delete(entry.target);
        callback?.();
      }
    },
    { rootMargin: "600px 0px" },
  );
  deferredMarkdownCallbacks.set(element, reveal);
  deferredMarkdownObserver.observe(element);
  return () => {
    deferredMarkdownObserver?.unobserve(element);
    deferredMarkdownCallbacks.delete(element);
  };
}

function DeferredMarkdown({ content, urgent }: { content: string; urgent: boolean }) {
  const [rich, setRich] = React.useState(urgent);
  const cleanupRef = React.useRef<(() => void) | null>(null);
  const hostRef = React.useCallback(
    (element: HTMLDivElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (element && !urgent && !rich) {
        cleanupRef.current = observeDeferredMarkdown(element, () => setRich(true));
      }
    },
    [rich, urgent],
  );
  return (
    <div ref={hostRef}>
      {rich ? <Markdown content={content} /> : <div className="whitespace-pre-wrap">{content}</div>}
    </div>
  );
}

const CAPABILITY_LABEL_KEYS: Record<string, string> = {
  chat: "Chat",
  mastery_path: "Learning plan",
  deep_solve: "Deep Solve",
  deep_question: "Practice Questions",
  deep_research: "Deep Research",
  visualize: "Visualize",
  math_animator: "Math Animator",
};
const INITIAL_HISTORY_SIZE = 20;
const HISTORY_PAGE_SIZE = 50;

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function StreamingStatus({
  stageLabel,
  capability,
}: {
  stageLabel: string;
  capability: string | null;
}) {
  const { t } = useTranslation();
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  React.useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const longRunningHint =
    capability === "deep_research"
      ? t(
          "Source searches may time out; the report will continue with available evidence and clearly mark partial results.",
        )
      : capability === "math_animator"
        ? t(
            "Rendering and repair can take 5–10 minutes; this stage updates as the animation progresses.",
          )
        : capability === "visualize"
          ? t("Complex visualizations may take several minutes to generate and review.")
          : null;

  return (
    <div className="flex items-start gap-2 text-sm text-muted-foreground" aria-live="polite">
      <Spinner size={14} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block">
          {stageLabel || t("Working…")}
          <span className="ml-2 tabular-nums text-xs">
            {t("{{elapsed}} elapsed", { elapsed: formatElapsed(elapsedSeconds) })}
          </span>
        </span>
        {longRunningHint ? (
          <span className="mt-0.5 block max-w-2xl text-xs text-muted-foreground">
            {longRunningHint}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function capabilityLabel(
  t: (key: string) => string,
  capability: string | undefined,
): string | null {
  if (!capability || capability === "chat") return null;
  const key = CAPABILITY_LABEL_KEYS[capability];
  return key ? t(key) : capability;
}

/* ------------------------------------------------------------------ */
/*  Branch navigator (‹ 1/3 ›)                                        */
/* ------------------------------------------------------------------ */

function BranchNavigator({
  info,
  onSwitch,
}: {
  info: SiblingInfo;
  onSwitch: (parentId: number | null, childId: number) => void;
}) {
  const { t } = useTranslation();
  const prevId = info.index > 1 ? info.siblingIds[info.index - 2] : null;
  const nextId =
    info.index < info.total ? info.siblingIds[info.index] : null;
  return (
    <div className="flex items-center gap-0.5 text-xs text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      <button
        type="button"
        aria-label={t("Previous branch")}
        disabled={prevId == null}
        onClick={() => prevId != null && onSwitch(info.parentId, prevId)}
        className="rounded p-0.5 transition-colors duration-150 hover:bg-muted disabled:opacity-30"
      >
        <ChevronLeft size={14} />
      </button>
      <span className="min-w-8 text-center tabular-nums">
        {info.index}/{info.total}
      </span>
      <button
        type="button"
        aria-label={t("Next branch")}
        disabled={nextId == null}
        onClick={() => nextId != null && onSwitch(info.parentId, nextId)}
        className="rounded p-0.5 transition-colors duration-150 hover:bg-muted disabled:opacity-30"
      >
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Attachments                                                       */
/* ------------------------------------------------------------------ */

function AttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  const filename = attachment.filename || "file";
  const isImage =
    attachment.type === "image" || attachment.mime_type?.startsWith("image/");
  const { Icon, tint } = isImage
    ? { Icon: FileImage, tint: "text-file-image" }
    : docIconFor(filename);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const body = (
    <>
      <Icon size={13} className={cn("shrink-0", tint)} />
      <span className="max-w-48 truncate">{filename}</span>
    </>
  );
  const className =
    "inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors duration-150";
  // Only http(s)/relative attachment URLs become links; other schemes
  // degrade to a plain-text chip.
  const canPreview = Boolean(attachment.url || attachment.base64 || attachment.extracted_text);
  return (
    <>
      <button type="button" disabled={!canPreview} onClick={() => setPreviewOpen(true)} className={cn(className, canPreview && "hover:border-primary hover:text-foreground", !canPreview && "cursor-default")}>
        {body}
      </button>
      {previewOpen && <FilePreviewDrawer source={attachment} onClose={() => setPreviewOpen(false)} />}
    </>
  );
}

function PlayAudioButton({
  content,
  autoPlay,
  ttsConfigured,
  onTtsUnavailable,
}: {
  content: string;
  autoPlay: boolean;
  ttsConfigured: boolean | null;
  onTtsUnavailable: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [status, setStatus] = React.useState<"idle" | "loading" | "playing">("idle");
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const urlRef = React.useRef<string | null>(null);
  const autoPlayedRef = React.useRef(false);
  const cleanup = React.useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
  }, []);
  const play = React.useCallback(async () => {
    if (!content.trim()) return;
    if (ttsConfigured === false) {
      onTtsUnavailable();
      return;
    }
    setStatus("loading");
    try {
      const response = await apiFetch(apiUrl("/api/v1/voice/tts"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: content }) });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as {
          message?: string;
          detail?: string;
        } | null;
        const detail = payload?.message || payload?.detail || String(response.status);
        if (isMissingTtsConfiguration(response.status, detail)) {
          onTtsUnavailable();
          return;
        }
        throw new Error(detail);
      }
      const url = URL.createObjectURL(await response.blob());
      cleanup();
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { cleanup(); setStatus("idle"); };
      audio.onerror = () => { cleanup(); setStatus("idle"); };
      await audio.play();
      setStatus("playing");
    } catch (error) {
      cleanup();
      setStatus("idle");
      toast({
        title: t("Could not play audio"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }
  }, [cleanup, content, onTtsUnavailable, t, toast, ttsConfigured]);
  React.useEffect(() => {
    if (!autoPlay || autoPlayedRef.current || !content.trim()) return;
    autoPlayedRef.current = true;
    const timer = window.setTimeout(() => void play(), 0);
    return () => window.clearTimeout(timer);
  }, [autoPlay, content, play]);
  React.useEffect(() => cleanup, [cleanup]);
  const toggle = () => {
    if (status !== "idle") { cleanup(); setStatus("idle"); }
    else void play();
  };
  return <button type="button" onClick={toggle} aria-label={status === "playing" ? t("Stop") : t("Play aloud")} className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">{status === "loading" ? <Loader2 size={14} className="animate-spin" /> : status === "playing" ? <Square size={12} fill="currentColor" /> : <Volume2 size={14} />}</button>;
}

/* ------------------------------------------------------------------ */
/*  User message                                                      */
/* ------------------------------------------------------------------ */

const UserMessage = React.memo(function UserMessage({
  message,
  siblingInfo,
  canEdit,
  onEdit,
  onSwitchBranch,
}: {
  message: MessageItem;
  siblingInfo?: SiblingInfo;
  canEdit: boolean;
  onEdit: (messageId: number, content: string) => void;
  onSwitchBranch: (parentId: number | null, childId: number) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(message.content);

  const startEdit = () => {
    setDraft(message.content);
    setEditing(true);
  };
  const saveEdit = () => {
    const trimmed = draft.trim();
    if (!trimmed || message.id === undefined) return;
    setEditing(false);
    if (trimmed !== message.content.trim()) onEdit(message.id, trimmed);
  };

  if (editing) {
    return (
      <div className="chat-message-row flex w-full flex-col items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoResize
          rows={2}
          className="w-full max-w-[85%] text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              saveEdit();
            } else if (e.key === "Escape") {
              setEditing(false);
            }
          }}
        />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            onClick={saveEdit}
            disabled={!draft.trim()}
          >
            {t("Save & resend")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="chat-message-row group flex flex-col items-end gap-1.5"
      data-chat-message="user"
    >
      {message.attachments && message.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {message.attachments.map((attachment, index) => (
            <AttachmentChip
              key={`${attachment.filename ?? "file"}-${index}`}
              attachment={attachment}
            />
          ))}
        </div>
      )}
      <div className="flex w-full items-start justify-end gap-1.5">
        {canEdit && message.id !== undefined && (
          <button
            type="button"
            onClick={startEdit}
            aria-label={t("Edit message")}
            className="mt-2 rounded-md p-1.5 text-muted-foreground opacity-0 transition-all duration-150 hover:bg-muted hover:text-foreground group-hover:opacity-100"
          >
            <Pencil size={13} />
          </button>
        )}
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-primary-muted px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
          {message.content}
        </div>
      </div>
      {siblingInfo && (
        <BranchNavigator info={siblingInfo} onSwitch={onSwitchBranch} />
      )}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Assistant message                                                 */
/* ------------------------------------------------------------------ */

const AssistantMessage = React.memo(function AssistantMessage({
  message,
  siblingInfo,
  isLast,
  isStreamingTurn,
  onRegenerate,
  onQuickRetry,
  onSubmitReply,
  onStartResearch,
  onSwitchBranch,
  autoPlayAudio,
  ttsConfigured,
  onTtsUnavailable,
  onSaveToNotebook,
  onQuizFollowup,
  onQuizRecovery,
  onLearningAction,
  sessionId,
  language,
}: {
  message: MessageItem;
  siblingInfo?: SiblingInfo;
  isLast: boolean;
  isStreamingTurn: boolean;
  onRegenerate: () => void;
  onQuickRetry: () => void;
  onSubmitReply: (reply: {
    text?: string;
    answers?: Array<{ questionId: string; text: string }>;
  }) => void;
  onStartResearch: (
    topic: string,
    config: Record<string, unknown>,
    outline: OutlineItem[],
  ) => void;
  onSwitchBranch: (parentId: number | null, childId: number) => void;
  autoPlayAudio: boolean;
  ttsConfigured: boolean | null;
  onTtsUnavailable: () => void;
  onSaveToNotebook: (message: MessageItem) => void;
  onQuizFollowup: (
    question: QuizQuestion,
    answer: string,
    correct: boolean | null,
    judgment: string,
  ) => void;
  onQuizRecovery: (question: QuizQuestion) => void;
  onLearningAction: (capability: "deep_question" | "mastery_path" | "deep_solve", content: string) => void;
  sessionId: string | null;
  language: string;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { toast } = useToast();
  const [creatingDocument, setCreatingDocument] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const capLabel = capabilityLabel(t, message.capability);
  const askUserData = React.useMemo(
    () => extractAskUserCardData(message.events),
    [message.events],
  );
  const resultEvent = React.useMemo(
    () => [...(message.events ?? [])].reverse().find((event) => event.type === "result"),
    [message.events],
  );
  const visualizeResult = React.useMemo(
    () =>
      message.capability === "visualize"
        ? extractVisualizeResult(resultEvent?.metadata)
        : null,
    [message.capability, resultEvent],
  );
  const traceEvents = React.useMemo(
    () => hideLegacyVisualizeSuccessEvents(
      message.events,
      Boolean(visualizeResult && !isManimResult(visualizeResult) && visualizeResult.generation?.legacy_fallback),
    ),
    [message.events, visualizeResult],
  );
  const mathAnimatorResult = React.useMemo(
    () =>
      message.capability === "math_animator"
        ? extractMathAnimatorResult(resultEvent?.metadata)
        : null,
    [message.capability, resultEvent],
  );
  const researchOutline = React.useMemo(
    () =>
      message.capability === "deep_research"
        ? extractResearchOutlineResult(resultEvent)
        : null,
    [message.capability, resultEvent],
  );
  const contextBudget = React.useMemo(
    () => extractContextBudget(message.events),
    [message.events],
  );
  const terminalRecovery = React.useMemo(
    () => extractTerminalRecovery(message.events),
    [message.events],
  );
  const learningResult = React.useMemo(
    () => extractLearningResult(message.events),
    [message.events],
  );
  const quizQuestions = React.useMemo(() => {
    if (message.capability !== "deep_question") return null;
    return (
      extractStreamingQuizQuestions(message.events ?? []) ??
      extractQuizQuestions(resultEvent?.metadata)
    );
  }, [message.capability, message.events, resultEvent]);
  const quizTurnId = React.useMemo(
    () => extractQuizTurnId(message.events),
    [message.events],
  );
  const streamingHere = isLast && isStreamingTurn;

  const copyContent = async () => {
    if (!message.content.trim()) return;
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — non-fatal */
    }
  };

  const convertResearchToDocument = async () => {
    if (!message.content.trim() || creatingDocument) return;
    setCreatingDocument(true);
    try {
      const document = await createCoWriterDocument({
        title: t("Research report"),
        content: message.content,
      });
      router.push(`/co-writer/${encodeURIComponent(document.id)}`);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to create writing document"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCreatingDocument(false);
    }
  };

  const continueResearchAsBook = () => {
    if (!message.content.trim()) return;
    const transfer = buildBookDraftTransfer({
      sourceType: "deep_research",
      sourceId: String(message.id ?? resultEvent?.turn_id ?? "research"),
      title: t("Research report"),
      content: message.content,
    });
    try {
      storeBookDraftTransfer(transfer);
      router.push(`/book?create=${encodeURIComponent(transfer.key)}`);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to open book creator"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  React.useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  return (
    <div
      className="chat-message-row group flex flex-col gap-1"
      data-chat-message="assistant"
      data-capability={message.capability || "chat"}
    >
      {capLabel && (
        <div>
          <Badge variant="primary">{t(capLabel)}</Badge>
        </div>
      )}
      <TraceBlock events={traceEvents} live={streamingHere} />
      {visualizeResult ? (
        <VisualizationViewer result={visualizeResult} parentTurnId={resultEvent?.turn_id} />
      ) : mathAnimatorResult ? (
        <MathAnimatorViewer result={mathAnimatorResult} parentTurnId={resultEvent?.turn_id} />
      ) : quizQuestions ? (
        <QuizViewer
          questions={quizQuestions}
          sessionId={sessionId}
          turnId={quizTurnId}
          language={language}
          onFollowup={onQuizFollowup}
          onRegenerateMissing={onQuizRecovery}
        />
      ) : researchOutline ? (
        <ResearchOutlinePreview
          result={researchOutline}
          onStart={(outline) =>
            onStartResearch(
              researchOutline.topic,
              researchOutline.config,
              outline,
            )
          }
        />
      ) : message.content ? (
        <div
          className={cn("prose-cognivoy", streamingHere && "stream-caret")}
        >
          <DeferredMarkdown content={message.content} urgent={streamingHere || isLast} />
        </div>
      ) : null}
      {askUserData && (
        <AskUserCard
          data={askUserData}
          onSubmit={onSubmitReply}
          active={streamingHere}
        />
      )}
      {contextBudget ? <ContextBudgetCard budget={contextBudget} /> : null}
      {learningResult ? <LearningResultCard result={learningResult} /> : null}
      {terminalRecovery ? (
        <TurnRecoveryCard
          recovery={terminalRecovery}
          capability={message.capability}
          onRetry={onRegenerate}
          onQuickRetry={onQuickRetry}
        />
      ) : null}
      {!isStreamingTurn && message.content && message.capability === "deep_solve" && (
        <div className="flex flex-wrap gap-2 pt-1" data-testid="deep-solve-actions">
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("dt:chat-prefill", { detail: t("I have a question about this step: ") }))} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            <HelpCircle size={12} className="mr-1 inline" />{t("Ask about a step")}
          </button>
          <button type="button" onClick={() => onLearningAction("deep_solve", t("Solve the same problem using a different method."))} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            <Shuffle size={12} className="mr-1 inline" />{t("Try another method")}
          </button>
          <button type="button" onClick={() => onLearningAction("deep_question", t("Create a similar practice problem based on this solution."))} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            <Sparkles size={12} className="mr-1 inline" />{t("Generate a similar problem")}
          </button>
          <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("dt:visualize-prompt", { detail: `${t("Visualize this solution step by step.")}\n\n${message.content}` }))} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            {t("Visualize solution")}
          </button>
          <button type="button" onClick={() => onSaveToNotebook(message)} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            <NotebookPen size={12} className="mr-1 inline" />{t("Save to notebook")}
          </button>
        </div>
      )}
      {!isStreamingTurn && message.content && message.capability === "deep_research" && !researchOutline && (
        <div className="flex flex-wrap gap-2 pt-1" data-testid="deep-research-actions">
          <button type="button" onClick={() => downloadTextAsset({ filename: "research-report.md", mimeType: "text/markdown;charset=utf-8", content: message.content })} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            <Download size={12} className="mr-1 inline" />{t("Export report")}
          </button>
          <button type="button" onClick={() => onSaveToNotebook(message)} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            <NotebookPen size={12} className="mr-1 inline" />{t("Save to notebook")}
          </button>
          <button type="button" disabled={creatingDocument} onClick={() => void convertResearchToDocument()} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground disabled:opacity-50">
            <FilePenLine size={12} className="mr-1 inline" />{creatingDocument ? t("Creating…") : t("Continue in Co-Writer")}
          </button>
          <button type="button" onClick={() => onLearningAction("deep_question", t("Create a quiz from this research report."))} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            <Sparkles size={12} className="mr-1 inline" />{t("Generate quiz")}
          </button>
          <button type="button" onClick={continueResearchAsBook} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            <BookOpen size={12} className="mr-1 inline" />{t("Create book")}
          </button>
        </div>
      )}
      {isLast && !isStreamingTurn && message.capability === "chat" && message.content && (
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" onClick={() => onLearningAction("deep_question", t("Create practice questions about this answer."))} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            {t("Generate practice")}
          </button>
          <button type="button" onClick={() => onLearningAction("mastery_path", t("Add this topic to my learning plan."))} className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground hover:border-primary-border hover:text-foreground">
            {t("Add to learning plan")}
          </button>
        </div>
      )}
      <div className="flex items-center gap-1">
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {message.content && (
            <PlayAudioButton
              content={message.content}
              autoPlay={autoPlayAudio}
              ttsConfigured={ttsConfigured}
              onTtsUnavailable={onTtsUnavailable}
            />
          )}
          {message.content && (
            <button
              type="button"
              onClick={() => onSaveToNotebook(message)}
              aria-label={t("Save to notebook")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <NotebookPen size={14} />
            </button>
          )}
          {message.content && (
            <button
              type="button"
              onClick={copyContent}
              aria-label={t("Copy")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              {copied ? (
                <Check size={14} className="text-success" />
              ) : (
                <Copy size={14} />
              )}
            </button>
          )}
          {isLast && !isStreamingTurn && (
            <button
              type="button"
              onClick={onRegenerate}
              aria-label={t("Regenerate")}
              className="rounded-md p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
        {siblingInfo && (
          <BranchNavigator info={siblingInfo} onSwitch={onSwitchBranch} />
        )}
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------ */
/*  Message list                                                      */
/* ------------------------------------------------------------------ */

export function ChatMessages({
  onOpenActivity,
  activityCount = 0,
}: {
  onOpenActivity?: () => void;
  activityCount?: number;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { toast } = useToast();
  const {
    state,
    editMessage,
    regenerateLastMessage,
    retryLastMessageQuick,
    submitUserReply,
    sendMessage,
    switchBranch,
  } = useUnifiedChat();

  const startResearch = React.useCallback(
    (topic: string, config: Record<string, unknown>, outline: OutlineItem[]) => {
      sendMessage(
        topic,
        [],
        {
          ...config,
          confirmed_outline: outline,
          checkpoint_id:
            typeof config.checkpoint_id === "string"
              ? config.checkpoint_id
              : createResearchCheckpointId(),
        },
        undefined,
        undefined,
        { displayUserMessage: false, persistUserMessage: false },
      );
    },
    [sendMessage],
  );

  const startQuizFollowup = React.useCallback(
    (
      question: QuizQuestion,
      answer: string,
      correct: boolean | null,
      judgment: string,
    ) => {
      sendMessage(
        t("Help me understand this question and my answer."),
        [],
        buildQuizFollowupConfig(
          question,
          answer,
          correct,
          state.sessionId,
          { aiJudgment: judgment },
        ),
      );
    },
    [sendMessage, state.sessionId, t],
  );

  const startQuizRecovery = React.useCallback(
    (question: QuizQuestion) => {
      const config = buildQuizRecoveryConfig(question);
      const topic = question.concentration?.trim() || question.question;
      const content = t("Regenerate one missing question about {{topic}}", { topic });
      sendMessage(content, [], config, undefined, undefined, {
        requestSnapshotOverride: {
          content,
          capability: "deep_question",
          enabledTools: state.enabledTools,
          knowledgeBases: state.knowledgeBases,
          language: state.language,
          persona: state.personaSelection,
        },
      });
    },
    [sendMessage, state.enabledTools, state.knowledgeBases, state.language, state.personaSelection, t],
  );

  const startLearningAction = React.useCallback(
    (capability: "deep_question" | "mastery_path" | "deep_solve", content: string) => {
      // The per-message request snapshot remains authoritative; restoring the
      // composer selection avoids surprising the learner's next manual turn.
      sendMessage(content, [], capability === "deep_question" ? { num_questions: 3 } : undefined, undefined, undefined, {
        requestSnapshotOverride: {
          content,
          capability,
          enabledTools: state.enabledTools,
          knowledgeBases: state.knowledgeBases,
          language: state.language,
          persona: state.personaSelection,
        },
      });
    },
    [sendMessage, state.enabledTools, state.knowledgeBases, state.language, state.personaSelection],
  );

  const [globalVoiceAutoplay, setGlobalVoiceAutoplay] = React.useState(false);
  const [ttsConfigured, setTtsConfigured] = React.useState<boolean | null>(null);
  const [voiceAutoplayPreference, setVoiceAutoplayPreference] = React.useState<{
    sessionId: string | null;
    override: VoiceAutoplayOverride;
  }>(() => ({
    sessionId: state.sessionId,
    override: loadVoiceAutoplayOverride(state.sessionId),
  }));
  const [messageToSave, setMessageToSave] = React.useState<MessageItem | null>(null);
  const [freshAudioMessageId, setFreshAudioMessageId] = React.useState<number | null>(null);
  const [historyWindow, setHistoryWindow] = React.useState({
    sessionId: state.sessionId,
    limit: INITIAL_HISTORY_SIZE,
  });
  const wasStreamingRef = React.useRef(state.isStreaming);

  const { messages: visibleMessages, siblingsByMessageId } = React.useMemo(
    () => buildVisiblePath(state.messages, state.selectedBranches),
    [state.messages, state.selectedBranches],
  );
  if (historyWindow.sessionId !== state.sessionId) {
    setHistoryWindow({ sessionId: state.sessionId, limit: INITIAL_HISTORY_SIZE });
  }
  const historyLimit =
    historyWindow.sessionId === state.sessionId
      ? historyWindow.limit
      : INITIAL_HISTORY_SIZE;
  const historyStart = Math.max(0, visibleMessages.length - historyLimit);
  const renderedMessages = visibleMessages.slice(historyStart);
  const { containerRef, contentRef, showJump, handleScroll: trackScroll, preservePrepend, scrollToBottom } =
    useChatScroll(state.sessionId, historyStart);

  React.useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([
      apiFetch(apiUrl("/api/v1/settings")).then((response) => response.ok ? response.json() : null),
      apiFetch(apiUrl("/api/v1/system/dependencies")).then((response) => response.ok ? response.json() : null),
    ]).then(([settingsResult, dependenciesResult]) => {
      if (cancelled) return;
      if (settingsResult.status === "fulfilled") {
        setGlobalVoiceAutoplay(Boolean(settingsResult.value?.ui?.voice_autoplay));
      }
      if (dependenciesResult.status === "fulfilled" && dependenciesResult.value) {
        setTtsConfigured(ttsConfiguredFromDependencies(dependenciesResult.value));
      }
    });
    return () => { cancelled = true; };
  }, []);

  const promptTtsSetup = React.useCallback(() => {
    toast({
      title: t("Set up text-to-speech first"),
      description: t("If your current multimodal model supports audio output, bind it as Text-to-Speech in Settings. Otherwise, add a dedicated speech model."),
      durationMs: 7000,
    });
    router.push("/settings/tts");
  }, [router, t, toast]);

  const voiceAutoplayOverride =
    voiceAutoplayPreference.sessionId === state.sessionId
      ? voiceAutoplayPreference.override
      : loadVoiceAutoplayOverride(state.sessionId);

  const voiceAutoplay = effectiveVoiceAutoplay(
    globalVoiceAutoplay,
    voiceAutoplayOverride,
  );
  const cycleVoiceAutoplay = () => {
    const next: VoiceAutoplayOverride =
      voiceAutoplayOverride === "default"
        ? voiceAutoplay
          ? "off"
          : "on"
        : "default";
    setVoiceAutoplayPreference({ sessionId: state.sessionId, override: next });
    saveVoiceAutoplayOverride(state.sessionId, next);
  };

  React.useEffect(() => {
    if (wasStreamingRef.current && !state.isStreaming) {
      const lastAssistant = [...visibleMessages].reverse().find((message) => message.role === "assistant");
      setFreshAudioMessageId(lastAssistant?.id ?? null);
    }
    wasStreamingRef.current = state.isStreaming;
  }, [state.isStreaming, visibleMessages]);

  const loadEarlier = React.useCallback(() => {
    preservePrepend();
    setHistoryWindow((current) => ({
      sessionId: state.sessionId,
      limit: Math.min(visibleMessages.length, current.limit + HISTORY_PAGE_SIZE),
    }));
  }, [preservePrepend, state.sessionId, visibleMessages.length]);

  const handleScroll = React.useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    trackScroll();
    if (el.scrollTop < 80 && historyLimit < visibleMessages.length) {
      loadEarlier();
    }
  }, [containerRef, trackScroll, historyLimit, loadEarlier, visibleMessages.length]);

  const lastIndex = visibleMessages.length - 1;
  const stageLabel = state.currentStage
    ? t(learningStageLabel(state.currentStage, state.activeCapability || ""))
    : "";
  const saveMessageIndex = messageToSave
    ? visibleMessages.findIndex((message) => message === messageToSave)
    : -1;
  const saveUserQuery = saveMessageIndex > 0
    ? [...visibleMessages.slice(0, saveMessageIndex)].reverse().find((message) => message.role === "user")?.content || ""
    : "";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {visibleMessages.length > 0 && (
        <div className="z-20 flex shrink-0 items-center justify-end gap-2 border-b border-border px-4 py-2">
          <button
            type="button"
            onClick={ttsConfigured === false ? promptTtsSetup : cycleVoiceAutoplay}
            aria-pressed={ttsConfigured === false ? false : voiceAutoplay}
            aria-label={ttsConfigured === false ? t("Configure voice") : t("Auto-play for this chat")}
            title={
              ttsConfigured === false
                ? t("Set up text-to-speech first")
                : voiceAutoplayOverride === "default"
                ? t("Using chat default: {{state}}", {
                    state: voiceAutoplay ? t("On") : t("Off"),
                  })
                : t("Session override: {{state}}. Click to use the chat default.", {
                    state: voiceAutoplay ? t("On") : t("Off"),
                  })
            }
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-hairline transition-colors",
              voiceAutoplay && ttsConfigured !== false
                ? "border-primary bg-primary-muted text-accent-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {voiceAutoplay && ttsConfigured !== false ? <Volume2 size={13} /> : <VolumeX size={13} />}
            {t(ttsConfigured === false ? "Configure voice" : "Auto-play")}
          </button>
          {onOpenActivity ? (
            <button
              type="button"
              onClick={onOpenActivity}
              aria-label={t("Activity")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-hairline transition-colors hover:text-foreground"
            >
              <Activity size={13} />
              {t("Activity")}
              {activityCount > 0 ? (
                <span className="rounded-full bg-primary-muted px-1.5 text-[10px] text-accent-foreground">
                  {activityCount}
                </span>
              ) : null}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => downloadChatMarkdown(visibleMessages, { title: state.sessionTitle || t("Chat Session") })}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground shadow-hairline transition-colors hover:text-foreground"
          >
            <Download size={13} />
            {t("Export Markdown")}
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-chat-scroll
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div ref={contentRef} className="mx-auto flex max-w-3xl flex-col gap-7 px-4 pb-8 pt-6">
          {historyStart > 0 ? (
            <button
              type="button"
              onClick={loadEarlier}
              className="self-center rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-hairline hover:text-foreground"
            >
              {t("Load {{count}} earlier messages", { count: Math.min(HISTORY_PAGE_SIZE, historyStart) })}
            </button>
          ) : null}
          {renderedMessages.map((message, renderedIndex) => {
            const index = historyStart + renderedIndex;
            const siblingInfo =
              message.id !== undefined
                ? siblingsByMessageId.get(message.id)
                : undefined;
            const isLast = index === lastIndex;
            if (message.role === "user") {
              return (
                <UserMessage
                  key={message.id ?? `u-${index}`}
                  message={message}
                  siblingInfo={siblingInfo}
                  canEdit={!state.isStreaming}
                  onEdit={(id, content) => void editMessage(id, content)}
                  onSwitchBranch={switchBranch}
                />
              );
            }
            if (message.role === "assistant") {
              return (
                <AssistantMessage
                  key={message.id ?? `a-${index}`}
                  message={message}
                  siblingInfo={siblingInfo}
                  isLast={isLast}
                  isStreamingTurn={state.isStreaming}
                  onRegenerate={regenerateLastMessage}
                  onQuickRetry={retryLastMessageQuick}
                  onSubmitReply={submitUserReply}
                  onStartResearch={startResearch}
                  onSwitchBranch={switchBranch}
                  autoPlayAudio={voiceAutoplay && message.id === freshAudioMessageId}
                  ttsConfigured={ttsConfigured}
                  onTtsUnavailable={promptTtsSetup}
                  onSaveToNotebook={setMessageToSave}
                  onQuizFollowup={startQuizFollowup}
                  onQuizRecovery={startQuizRecovery}
                  onLearningAction={startLearningAction}
                  sessionId={state.sessionId}
                  language={state.language}
                />
              );
            }
            return null;
          })}
          {state.isStreaming ? (
            <StreamingStatus
              stageLabel={stageLabel}
              capability={state.activeCapability}
            />
          ) : null}
          <div className="h-px" />
        </div>
      </div>
      {showJump && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          aria-label={t("Scroll to bottom")}
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-card p-2 text-muted-foreground shadow-lift transition-colors duration-150 hover:text-foreground"
        >
          <ArrowDown size={15} />
        </button>
      )}
      <SaveMessageToNotebookDialog
        message={messageToSave}
        userQuery={saveUserQuery}
        onClose={() => setMessageToSave(null)}
      />
    </div>
  );
}

export default ChatMessages;
