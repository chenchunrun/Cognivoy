"use client";

/**
 * Renders a single book page block and exposes the block-level actions the
 * Book API supports (regenerate / delete) as a hover toolbar. Block bodies
 * lean on the shared chat Markdown renderer for prose, math and diagrams.
 */

import * as React from "react";
import {
  AlertTriangle,
  BookmarkCheck,
  ChevronLeft,
  ChevronRight,
  Compass,
  Download,
  ExternalLink,
  Lightbulb,
  RefreshCw,
  RotateCcw,
  Sparkles,
  StickyNote,
  Trash2,
  ArrowUp,
  ArrowDown,
  Replace,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import DOMPurify from "dompurify";

import { Markdown } from "@/components/chat/Markdown";
import { Spinner, Tooltip } from "@/components/ui";
import { apiUrl } from "@/lib/api";
import { prepareIframeHtml } from "@/lib/iframe-html";
import { isSafeLinkHref } from "@/lib/markdown-display";
import { stripMermaidFence } from "@/lib/mermaid-render";
import type { Block, BlockType } from "@/lib/book-types";
import { cn } from "@/lib/utils";

import { QuizBlockView, type QuizAttemptArgs } from "./QuizBlockView";

export interface BlockViewProps {
  block: Block;
  onRegenerate?: (block: Block) => void;
  onDelete?: (block: Block) => void;
  onMove?: (block: Block, direction: -1 | 1) => void;
  onChangeType?: (block: Block, type: BlockType) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
  onDeepDive?: (topic: string, blockId: string) => Promise<void> | void;
  onQuizAttempt?: (block: Block, args: QuizAttemptArgs) => void;
  pendingDeepDiveTopic?: string | null;
}

function Prose({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("prose-cognivoy", className)}>
      <Markdown content={content} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Individual block bodies                                            */
/* ------------------------------------------------------------------ */

function TextBody({ block }: { block: Block }) {
  return <Prose content={String(block.payload?.body ?? "")} />;
}

interface Subsection {
  heading?: string;
  body?: string;
}

function SectionBody({ block }: { block: Block }) {
  const { t } = useTranslation();
  const payload = block.payload || {};
  const intro = String(payload.intro ?? "").trim();
  const keyTakeaway = String(payload.key_takeaway ?? "").trim();
  const subsections = Array.isArray(payload.subsections)
    ? (payload.subsections as Subsection[])
    : [];

  return (
    <section>
      {intro && <Prose content={intro} className="mb-5 text-[1.02em]" />}
      <div className="space-y-5">
        {subsections.map((sub, idx) => {
          const body = (sub.body || "").trim();
          if (!body) return null;
          return (
            <div key={idx}>
              {sub.heading && (
                <h3 className="display mb-2 text-lg font-medium text-foreground">
                  {sub.heading}
                </h3>
              )}
              <Prose content={body} />
            </div>
          );
        })}
      </div>
      {keyTakeaway && (
        <div className="mt-6 flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="flex-1">
            <span className="mr-1 font-medium">{t("Key takeaway:")}</span>
            <span className="text-foreground">{keyTakeaway}</span>
          </div>
        </div>
      )}
    </section>
  );
}

const CALLOUT_STYLES: Record<
  string,
  { icon: typeof Lightbulb; rule: string; tint: string }
> = {
  key_idea: {
    icon: Lightbulb,
    rule: "border-primary-border",
    tint: "bg-primary-muted text-accent-foreground",
  },
  common_pitfall: {
    icon: AlertTriangle,
    rule: "border-destructive-border",
    tint: "bg-destructive-muted text-foreground",
  },
  summary: {
    icon: BookmarkCheck,
    rule: "border-success-border",
    tint: "bg-success-muted text-foreground",
  },
  tip: {
    icon: Sparkles,
    rule: "border-warning-border",
    tint: "bg-warning-muted text-foreground",
  },
};

function CalloutBody({ block }: { block: Block }) {
  const variant = String(block.payload?.variant || "key_idea");
  const label = String(block.payload?.label || variant.replace(/_/g, " "));
  const body = String(block.payload?.body || "");
  const style = CALLOUT_STYLES[variant] || CALLOUT_STYLES.key_idea;
  const Icon = style.icon;
  return (
    <aside
      className={cn(
        "relative flex gap-3 rounded-r-lg border-l-[3px] py-2.5 pl-4 pr-3",
        style.rule,
        style.tint,
      )}
    >
      <Icon className="mt-[3px] h-4 w-4 shrink-0 opacity-80" />
      <div className="min-w-0 space-y-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] opacity-70">
          {label}
        </div>
        <div className="text-sm leading-relaxed">{body}</div>
      </div>
    </aside>
  );
}

function UserNoteBody({ block }: { block: Block }) {
  const { t } = useTranslation();
  const body = String(block.payload?.body || "");
  return (
    <aside className="flex gap-3 rounded-r-lg border-l-[3px] border-dashed border-primary-border bg-primary-muted py-2.5 pl-4 pr-3">
      <StickyNote className="mt-[3px] h-4 w-4 shrink-0 text-primary" />
      <div className="min-w-0 space-y-1">
        <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
          {t("Your note")}
        </div>
        {body ? (
          <Prose content={body} />
        ) : (
          <div className="text-xs text-muted-foreground">
            {t("Empty note — start writing your own annotation.")}
          </div>
        )}
      </div>
    </aside>
  );
}

function CodeBody({ block }: { block: Block }) {
  const language = String(block.payload?.language || "python");
  const code = String(block.payload?.code || "");
  const explanation = String(block.payload?.explanation || "");
  const fenced = `\`\`\`${language}\n${code}\n\`\`\``;
  return (
    <div className="surface p-4">
      <Prose content={fenced} />
      {explanation && (
        <p className="mt-2 text-xs text-muted-foreground">{explanation}</p>
      )}
    </div>
  );
}

interface TimelineEvent {
  date?: string;
  title?: string;
  description?: string;
}

function TimelineBody({ block }: { block: Block }) {
  const events =
    (block.payload?.events as TimelineEvent[] | undefined) || [];
  if (events.length === 0) return null;
  return (
    <div className="surface p-4">
      <ol className="relative ml-3 space-y-4 border-l border-border pl-4">
        {events.map((ev, idx) => (
          <li key={idx} className="relative">
            <span className="absolute -left-[21px] top-1 inline-flex h-3 w-3 rounded-full border-2 border-card bg-primary" />
            <div className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
              {ev.date || ""}
            </div>
            <div className="text-sm font-semibold text-foreground">
              {ev.title}
            </div>
            {ev.description && (
              <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {ev.description}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

interface FlashCard {
  front?: string;
  back?: string;
  hint?: string;
}

function FlashCardsBody({ block }: { block: Block }) {
  const { t } = useTranslation();
  const cards = (block.payload?.cards as FlashCard[] | undefined) || [];
  const [idx, setIdx] = React.useState(0);
  const [showBack, setShowBack] = React.useState(false);
  if (cards.length === 0) return null;
  const card = cards[Math.min(idx, cards.length - 1)] || {};

  return (
    <div className="surface p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
          {t("Flash cards")}
        </span>
        <span className="text-xs text-muted-foreground">
          {idx + 1} / {cards.length}
        </span>
      </div>
      <button
        type="button"
        onClick={() => setShowBack((v) => !v)}
        className="mt-3 flex h-40 w-full flex-col items-center justify-center gap-2 rounded-lg border border-border bg-background px-6 text-center transition-colors hover:border-primary-border"
      >
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {showBack ? t("Answer") : t("Question")}
        </span>
        <span className="text-base font-medium text-foreground">
          {showBack ? card.back : card.front}
        </span>
        {!showBack && card.hint && (
          <span className="text-xs italic text-muted-foreground">
            {t("Hint")}: {card.hint}
          </span>
        )}
      </button>
      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => {
            setShowBack(false);
            setIdx((i) => Math.max(0, i - 1));
          }}
          disabled={idx === 0}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-30"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> {t("Previous")}
        </button>
        <button
          type="button"
          onClick={() => setShowBack((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:border-primary-border hover:text-primary"
        >
          <RotateCcw className="h-3.5 w-3.5" /> {t("Flip")}
        </button>
        <button
          type="button"
          onClick={() => {
            setShowBack(false);
            setIdx((i) => Math.min(cards.length - 1, i + 1));
          }}
          disabled={idx >= cards.length - 1}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-30"
        >
          {t("Next")} <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

interface DeepDiveSuggestion {
  topic?: string;
  rationale?: string;
}

function DeepDiveBody({
  block,
  onDeepDive,
  pendingTopic,
}: {
  block: Block;
  onDeepDive?: (topic: string, blockId: string) => Promise<void> | void;
  pendingTopic?: string | null;
}) {
  const { t } = useTranslation();
  const suggestions =
    (block.payload?.suggestions as DeepDiveSuggestion[] | undefined) || [];
  const linkedPageId = block.metadata?.deep_dive_page_id as string | undefined;
  const [busy, setBusy] = React.useState<string | null>(null);

  if (suggestions.length === 0) return null;

  return (
    <div className="rounded-xl border border-primary-border bg-primary-muted p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
          {t("Go deeper")}
        </span>
      </div>
      <ul className="space-y-2">
        {suggestions.map((s, i) => {
          const topic = s.topic || "";
          const isPending = busy === topic || pendingTopic === topic;
          return (
            <li key={i}>
              <button
                type="button"
                onClick={async () => {
                  if (!onDeepDive || !topic) return;
                  setBusy(topic);
                  try {
                    await onDeepDive(topic, block.id);
                  } finally {
                    setBusy(null);
                  }
                }}
                disabled={isPending || !!linkedPageId}
                className="group flex w-full items-start justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left transition-colors hover:border-primary-border disabled:opacity-60"
              >
                <div className="flex-1">
                  <div className="text-sm font-medium text-foreground">
                    {topic}
                  </div>
                  {s.rationale && (
                    <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {s.rationale}
                    </div>
                  )}
                </div>
                {isPending ? (
                  <Spinner size={16} className="shrink-0 text-primary" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {linkedPageId && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("A linked sub-page already exists for this dive.")}
        </p>
      )}
    </div>
  );
}

/**
 * LLM-generated SVG is sanitized with DOMPurify (SVG profile: tags and
 * filters allowed, scripts/event handlers/foreignObject stripped) before
 * injection. Sanitizing needs a DOM, so it runs after mount — the block
 * stays empty for the SSR pass, mirroring the async MermaidBlock pattern.
 */
function SanitizedSvg({ content }: { content: string }) {
  const [svg, setSvg] = React.useState<string | null>(null);
  React.useEffect(() => {
    setSvg(
      DOMPurify.sanitize(content, {
        USE_PROFILES: { svg: true, svgFilters: true },
      }),
    );
  }, [content]);
  if (!svg) return null;
  return (
    <div
      className="flex justify-center overflow-x-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function FigureBody({ block }: { block: Block }) {
  const { t } = useTranslation();
  const code =
    (block.payload?.code as { language?: string; content?: string } | undefined) ||
    {};
  const language = String(code.language || "svg").toLowerCase();
  const content = String(code.content || "");
  const description = block.payload?.description
    ? String(block.payload.description)
    : "";

  if (!content.trim()) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-4 text-xs italic text-muted-foreground">
        {t("(Figure payload is empty)")}
      </div>
    );
  }

  let visual: React.ReactNode;
  if (language === "svg" || content.trimStart().startsWith("<svg")) {
    // LLM-generated SVG — sanitized before injection (see SanitizedSvg).
    visual = <SanitizedSvg content={content} />;
  } else if (language === "mermaid") {
    visual = (
      <Prose content={`\`\`\`mermaid\n${stripMermaidFence(content)}\n\`\`\``} />
    );
  } else if (
    language === "javascript" ||
    language === "js" ||
    language === "chart" ||
    language === "chartjs"
  ) {
    visual = <Prose content={`\`\`\`chart\n${content}\n\`\`\``} />;
  } else {
    visual = <Prose content={`\`\`\`${language}\n${content}\n\`\`\``} />;
  }

  return (
    <figure className="surface p-4">
      {visual}
      {description && (
        <figcaption className="mt-3 text-xs leading-snug text-muted-foreground">
          <Prose content={description} />
        </figcaption>
      )}
    </figure>
  );
}

function InteractiveBody({ block }: { block: Block }) {
  const { t } = useTranslation();
  const code =
    (block.payload?.code as { language?: string; content?: string } | undefined) ||
    {};
  const content = String(code.content || "");
  const description = block.payload?.description
    ? String(block.payload.description)
    : "";

  if (!content.trim()) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-4 text-xs italic text-muted-foreground">
        {t("(Interactive payload is empty)")}
      </div>
    );
  }

  return (
    <figure className="surface overflow-hidden">
      <iframe
        title={block.title || t("Interactive figure")}
        sandbox="allow-scripts"
        srcDoc={prepareIframeHtml(content)}
        className="h-96 w-full bg-card"
      />
      {description && (
        <figcaption className="border-t border-border p-3 text-xs leading-snug text-muted-foreground">
          <Prose content={description} />
        </figcaption>
      )}
    </figure>
  );
}

interface AnimationArtifact {
  type?: string;
  url?: string;
  filename?: string;
  content_type?: string;
}

function resolveAssetUrl(url: string): string {
  if (!url) return url;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return apiUrl(url);
}

function AnimationBody({ block }: { block: Block }) {
  const { t } = useTranslation();
  const payload = (block.payload || {}) as Record<string, unknown>;
  const rawVideoUrl = String(payload.video_url || "");
  const summary = String(payload.summary || "");
  const description = String(payload.description || "");
  const artifacts = (payload.artifacts as AnimationArtifact[] | undefined) || [];

  if (!rawVideoUrl && artifacts.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card p-4 text-xs italic text-muted-foreground">
        {t("(Animation payload is empty)")}
      </div>
    );
  }

  const primaryRaw = rawVideoUrl || artifacts[0]?.url || "";
  const primary = resolveAssetUrl(primaryRaw);
  // Only render external-open/download anchors for http(s)/relative URLs;
  // anything with another scheme degrades to inline playback only.
  const primaryHref = isSafeLinkHref(primary) ? primary : null;
  const isVideo =
    primaryRaw.endsWith(".mp4") ||
    primaryRaw.endsWith(".webm") ||
    artifacts.some((a) => (a.content_type || "").startsWith("video/"));
  const filename =
    String(payload.filename || "") || artifacts[0]?.filename || "";

  return (
    <figure className="surface p-3">
      <div className="relative overflow-hidden rounded-lg bg-black">
        {isVideo ? (
          <video
            src={primary}
            controls
            playsInline
            preload="metadata"
            className="aspect-video h-auto w-full object-contain"
          />
        ) : (
          // Backend-generated artifact; not a remote-tracked image.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={primary}
            alt={description || t("Animation frame")}
            className="h-auto w-full"
          />
        )}
        {primaryHref && (
          // DESIGN-SYSTEM EXEMPTION: bg-black/text-white overlay chips sit on
          // top of media (images/video), where a dark scrim reads correctly
          // under both light and dark themes — no token needed.
          <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
            <a
              href={primaryHref}
              target="_blank"
              rel="noopener noreferrer"
              title={t("Open in new tab")}
              className="inline-flex items-center gap-1 rounded-md bg-black/40 px-2 py-1 text-[10px] font-medium text-white/90 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-white"
            >
              <ExternalLink size={11} strokeWidth={1.8} />
              {t("Open")}
            </a>
            {isVideo && (
              <a
                href={primaryHref}
                download={filename || true}
                title={t("Download video")}
                className="inline-flex items-center gap-1 rounded-md bg-black/40 px-2 py-1 text-[10px] font-medium text-white/90 backdrop-blur-sm transition-colors hover:bg-black/60 hover:text-white"
              >
                <Download size={11} strokeWidth={1.8} />
              </a>
            )}
          </div>
        )}
      </div>
      {(summary || description) && (
        <figcaption className="mt-3 text-xs leading-snug text-muted-foreground">
          <Prose content={summary || description} />
        </figcaption>
      )}
    </figure>
  );
}

function ConceptGraphBody({ block }: { block: Block }) {
  const { t } = useTranslation();
  const code =
    (block.payload?.code as { language?: string; content?: string } | undefined) ||
    {};
  const mermaidSrc = stripMermaidFence(String(code.content || ""));
  const graph = block.payload?.graph as
    | { nodes?: unknown[]; edges?: unknown[] }
    | undefined;
  const nodeCount = Array.isArray(graph?.nodes) ? graph.nodes.length : 0;
  const edgeCount = Array.isArray(graph?.edges) ? graph.edges.length : 0;

  const fenced = mermaidSrc
    ? `\`\`\`mermaid\n${mermaidSrc}\n\`\`\``
    : '```mermaid\ngraph TD\n  empty["(no concepts yet)"]\n```';

  return (
    <figure className="surface p-3">
      <header className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Compass className="h-3.5 w-3.5" />
        <span>
          {t("Concept map · {{concepts}} concepts · {{relations}} relations", {
            concepts: nodeCount,
            relations: edgeCount,
          })}
        </span>
      </header>
      <div className="max-h-[60vh] overflow-auto">
        <Prose content={fenced} />
      </div>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/*  Dispatcher + hover toolbar                                         */
/* ------------------------------------------------------------------ */

export function BlockView({
  block,
  onRegenerate,
  onDelete,
  onMove,
  onChangeType,
  canMoveUp = false,
  canMoveDown = false,
  onDeepDive,
  onQuizAttempt,
  pendingDeepDiveTopic,
}: BlockViewProps) {
  const { t } = useTranslation();

  if (block.status === "pending" || block.status === "generating") {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-3 text-sm text-muted-foreground">
        <Spinner size={16} />
        <span>{t("Generating {{type}}…", { type: t(block.type) })}</span>
      </div>
    );
  }

  if (block.status === "error") {
    const failure = block.metadata?.failure as
      | { kind?: string; message?: string }
      | undefined;
    return (
      <div className="rounded-xl border border-destructive-border bg-destructive-muted px-4 py-3 text-sm text-foreground">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <AlertTriangle className="h-4 w-4 text-destructive" />
          {t("{{type}} block failed", { type: t(block.type) })}
        </div>
        <div className="text-xs text-muted-foreground">
          {block.error || failure?.message || t("Unknown error")}
        </div>
        {onRegenerate && (
          <button
            type="button"
            onClick={() => onRegenerate(block)}
            className="mt-2 inline-flex rounded-md border border-destructive-border bg-card px-2 py-1 text-xs font-medium transition-colors hover:bg-muted"
          >
            {t("Retry")}
          </button>
        )}
      </div>
    );
  }

  let body: React.ReactNode;
  switch (block.type) {
    case "text":
      body = <TextBody block={block} />;
      break;
    case "section":
      body = <SectionBody block={block} />;
      break;
    case "callout":
      body = <CalloutBody block={block} />;
      break;
    case "quiz":
      body = <QuizBlockView block={block} onAttempt={onQuizAttempt} />;
      break;
    case "user_note":
      body = <UserNoteBody block={block} />;
      break;
    case "code":
      body = <CodeBody block={block} />;
      break;
    case "timeline":
      body = <TimelineBody block={block} />;
      break;
    case "flash_cards":
      body = <FlashCardsBody block={block} />;
      break;
    case "deep_dive":
      body = (
        <DeepDiveBody
          block={block}
          onDeepDive={onDeepDive}
          pendingTopic={pendingDeepDiveTopic}
        />
      );
      break;
    case "figure":
      body = <FigureBody block={block} />;
      break;
    case "interactive":
      body = <InteractiveBody block={block} />;
      break;
    case "animation":
      body = <AnimationBody block={block} />;
      break;
    case "concept_graph":
      body = <ConceptGraphBody block={block} />;
      break;
    default:
      body = <TextBody block={block} />;
  }

  const hasActions = !!onRegenerate || !!onDelete || !!onMove || !!onChangeType;
  const bridgeText = String(
    (block.payload as Record<string, unknown> | undefined)?.bridge_text ?? "",
  ).trim();

  return (
    <div className="group relative">
      {bridgeText && <Prose content={bridgeText} className="mb-3" />}
      {hasActions && (
        <div className="pointer-events-none absolute -top-3 right-2 z-10 flex translate-y-1 items-center gap-0.5 rounded-md border border-border bg-card px-1 py-0.5 text-muted-foreground opacity-0 shadow-hairline transition duration-150 group-hover:translate-y-0 group-hover:opacity-100">
          {onRegenerate && (
            <Tooltip content={t("Regenerate")}>
              <button
                type="button"
                onClick={() => onRegenerate(block)}
                className="pointer-events-auto rounded p-1 transition-colors hover:bg-muted hover:text-foreground"
                aria-label={t("Regenerate")}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          {onMove && (
            <>
              <Tooltip content={t("Move up")}>
                <button
                  type="button"
                  onClick={() => onMove(block, -1)}
                  disabled={!canMoveUp}
                  className="pointer-events-auto rounded p-1 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                  aria-label={t("Move up")}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <Tooltip content={t("Move down")}>
                <button
                  type="button"
                  onClick={() => onMove(block, 1)}
                  disabled={!canMoveDown}
                  className="pointer-events-auto rounded p-1 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30"
                  aria-label={t("Move down")}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
            </>
          )}
          {onChangeType && (
            <Tooltip content={t("Change block type")}>
              <label className="pointer-events-auto flex items-center rounded p-1 transition-colors hover:bg-muted hover:text-foreground">
                <Replace className="h-3.5 w-3.5" />
                <select
                  aria-label={t("Change block type")}
                  value={block.type}
                  onChange={(event) => onChangeType(block, event.target.value as BlockType)}
                  className="absolute h-5 w-5 cursor-pointer opacity-0"
                >
                  {(["text", "callout", "quiz", "user_note", "figure", "interactive", "animation", "code", "timeline", "flash_cards", "deep_dive", "section", "concept_graph"] as BlockType[]).map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </label>
            </Tooltip>
          )}
          {onDelete && (
            <Tooltip content={t("Delete block")}>
              <button
                type="button"
                onClick={() => onDelete(block)}
                className="pointer-events-auto rounded p-1 transition-colors hover:bg-destructive-muted hover:text-destructive"
                aria-label={t("Delete block")}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
        </div>
      )}
      {body}
    </div>
  );
}

export default BlockView;
