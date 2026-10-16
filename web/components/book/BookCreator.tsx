"use client";

/**
 * Guided new-book flow: (1) describe the intent, (2) review the generated
 * proposal, (3) review the spine outline and kick off compilation. The heavy
 * lifting streams over the Book WebSocket; the page feeds events into the
 * shared progress reducer and passes the snapshot down for the timeline.
 */

import * as React from "react";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardList,
  Database,
  Layers,
  MessagesSquare,
  NotebookPen,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, Button, Input, Textarea } from "@/components/ui";
import { useAppShell } from "@/context/AppShellContext";
import type { CreateBookPayload } from "@/lib/book-api";
import type { BookProposal, Spine } from "@/lib/book-types";
import type { BookProgress } from "@/lib/book-progress";
import { progressHasActivity } from "@/lib/book-progress";
import {
  listKnowledgeBases,
  type KnowledgeBaseSummary,
} from "@/lib/knowledge-api";
import {
  listCategories,
  listNotebooks,
  type NotebookCategory,
  type NotebookSummary,
} from "@/lib/notebook-api";
import { listSessions, type SessionSummary } from "@/lib/session-api";

import { BookProgressTimeline } from "./BookProgressTimeline";

export interface BookCreatorProps {
  initialIntent?: string;
  onCreate: (payload: CreateBookPayload) => void;
  creating: boolean;
  proposal: BookProposal | null;
  onConfirmProposal: (edited: BookProposal) => void;
  confirmingProposal: boolean;
  spine: Spine | null;
  onConfirmSpine: (spine: Spine) => void;
  confirmingSpine: boolean;
  progress: BookProgress;
  onCancel: () => void;
}

export function BookCreator({
  initialIntent = "",
  onCreate,
  creating,
  proposal,
  onConfirmProposal,
  confirmingProposal,
  spine,
  onConfirmSpine,
  confirmingSpine,
  progress,
  onCancel,
}: BookCreatorProps) {
  const { t } = useTranslation();
  const { language: appLanguage } = useAppShell();
  const [intent, setIntent] = React.useState(initialIntent);
  const [draftTitle, setDraftTitle] = React.useState("");
  const [draftDescription, setDraftDescription] = React.useState("");
  const [language, setLanguage] = React.useState(appLanguage);
  const [sourceTab, setSourceTab] = React.useState<
    "knowledge" | "notebooks" | "questions" | "chats"
  >("knowledge");
  const [sourcesLoading, setSourcesLoading] = React.useState(true);
  const [knowledgeBases, setKnowledgeBases] = React.useState<KnowledgeBaseSummary[]>([]);
  const [notebooks, setNotebooks] = React.useState<NotebookSummary[]>([]);
  const [categories, setCategories] = React.useState<NotebookCategory[]>([]);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [selectedKnowledgeBases, setSelectedKnowledgeBases] = React.useState<Set<string>>(new Set());
  const [selectedNotebooks, setSelectedNotebooks] = React.useState<Set<string>>(new Set());
  const [selectedCategories, setSelectedCategories] = React.useState<Set<number>>(new Set());
  const [selectedSessions, setSelectedSessions] = React.useState<Set<string>>(new Set());

  // Seed the editable proposal fields whenever a fresh proposal arrives.
  React.useEffect(() => {
    setDraftTitle(proposal?.title || "");
    setDraftDescription(proposal?.description || "");
  }, [proposal]);

  const loadSources = React.useCallback(async () => {
    setSourcesLoading(true);
    try {
      const [nextKbs, nextNotebooks, nextCategories, nextSessions] = await Promise.all([
        listKnowledgeBases({ force: true }),
        listNotebooks(),
        listCategories(),
        listSessions(50, 0, { force: true }),
      ]);
      setKnowledgeBases(nextKbs);
      setNotebooks(nextNotebooks);
      setCategories(nextCategories);
      setSessions(nextSessions);
    } finally {
      setSourcesLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadSources();
  }, [loadSources]);

  React.useEffect(() => setLanguage(appLanguage), [appLanguage]);

  React.useEffect(() => {
    if (initialIntent) setIntent(initialIntent);
  }, [initialIntent]);

  const toggleSelection = React.useCallback(
    <T,>(setter: React.Dispatch<React.SetStateAction<Set<T>>>, value: T) => {
      setter((current) => {
        const next = new Set(current);
        if (next.has(value)) next.delete(value);
        else next.add(value);
        return next;
      });
    },
    [],
  );

  const selectedSourceCount = selectedKnowledgeBases.size + selectedNotebooks.size + selectedCategories.size + selectedSessions.size;

  const createPayload = React.useCallback(
    (): CreateBookPayload => ({
      user_intent: intent.trim(),
      knowledge_bases: [...selectedKnowledgeBases],
      notebook_refs: [...selectedNotebooks].map((notebookId) => ({ notebook_id: notebookId, record_ids: [] })),
      question_categories: [...selectedCategories],
      chat_selections: [...selectedSessions].map((sessionId) => ({ session_id: sessionId, message_ids: [] })),
      language,
    }),
    [intent, language, selectedCategories, selectedKnowledgeBases, selectedNotebooks, selectedSessions],
  );

  const step: "intent" | "proposal" | "spine" = spine
    ? "spine"
    : proposal
      ? "proposal"
      : "intent";

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <button
          type="button"
          onClick={onCancel}
          className="mb-6 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> {t("Back to library")}
        </button>

        <h1 className="display text-2xl font-medium text-foreground">
          {step === "intent" && t("Create a new book")}
          {step === "proposal" && t("Review the proposal")}
          {step === "spine" && t("Review the outline")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {step === "intent" &&
            t(
              "Describe what you want to learn — the Book Engine drafts a proposal, then an outline, then writes every page.",
            )}
          {step === "proposal" &&
            t("The engine drafted this plan. Edit it, or confirm to build the outline.")}
          {step === "spine" &&
            t("Confirm the chapter outline to start compiling pages.")}
        </p>

        {progressHasActivity(progress) && (
          <BookProgressTimeline progress={progress} className="mt-6" />
        )}

        {step === "intent" && (
          <div className="surface mt-6 p-5">
            <label
              htmlFor="book-intent"
              className="mb-2 block text-sm font-medium text-foreground"
            >
              {t("What should this book teach?")}
            </label>
            <Textarea
              id="book-intent"
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder={t(
                "e.g. A gentle introduction to Fourier transforms for someone with basic calculus…",
              )}
              autoResize
              rows={4}
              disabled={creating}
            />

            <div className="mt-5 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium text-foreground">{t("Knowledge sources")}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {selectedSourceCount
                    ? t("{{count}} selected", { count: selectedSourceCount })
                    : t("Optional — leave empty to use general knowledge.")}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void loadSources()} disabled={sourcesLoading}>
                <RefreshCw size={13} className={sourcesLoading ? "animate-spin" : ""} />
                {t("Refresh")}
              </Button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 sm:grid-cols-4">
              {([
                ["knowledge", Database, "Knowledge bases", selectedKnowledgeBases.size],
                ["notebooks", NotebookPen, "Notebooks", selectedNotebooks.size],
                ["questions", ClipboardList, "Questions", selectedCategories.size],
                ["chats", MessagesSquare, "Chats", selectedSessions.size],
              ] as const).map(([key, Icon, label, count]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSourceTab(key)}
                  className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors ${
                    sourceTab === key
                      ? "bg-card text-foreground shadow-hairline"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon size={13} />
                  {t(label)}
                  {count > 0 && <span className="rounded-full bg-primary-muted px-1.5 text-[10px] text-accent-foreground">{count}</span>}
                </button>
              ))}
            </div>

            <div className="mt-2 max-h-56 overflow-y-auto rounded-lg border border-border bg-background p-1">
              {sourcesLoading ? (
                <div className="flex justify-center py-8 text-xs text-muted-foreground">{t("Loading…")}</div>
              ) : sourceTab === "knowledge" ? (
                <SourceList
                  empty={t("No knowledge bases yet.")}
                  items={knowledgeBases.map((item) => ({
                    id: item.name,
                    title: item.name,
                    detail: item.is_default ? t("Default") : item.status || "",
                    selected: selectedKnowledgeBases.has(item.name),
                    onToggle: () => toggleSelection(setSelectedKnowledgeBases, item.name),
                  }))}
                />
              ) : sourceTab === "notebooks" ? (
                <SourceList
                  empty={t("No notebooks yet.")}
                  items={notebooks.map((item) => ({
                    id: item.id,
                    title: item.name,
                    detail: t("{{count}} records", { count: item.record_count ?? 0 }),
                    selected: selectedNotebooks.has(item.id),
                    onToggle: () => toggleSelection(setSelectedNotebooks, item.id),
                  }))}
                />
              ) : sourceTab === "questions" ? (
                <SourceList
                  empty={t("No question categories yet.")}
                  items={categories.map((item) => ({
                    id: String(item.id),
                    title: item.name,
                    detail: t("{{count}} entries", { count: item.entry_count }),
                    selected: selectedCategories.has(item.id),
                    onToggle: () => toggleSelection(setSelectedCategories, item.id),
                  }))}
                />
              ) : (
                <SourceList
                  empty={t("No chat sessions yet.")}
                  items={sessions.map((item) => ({
                    id: item.session_id,
                    title: item.title || t("Untitled chat"),
                    detail: t("{{count}} messages", { count: item.message_count ?? 0 }),
                    selected: selectedSessions.has(item.session_id),
                    onToggle: () => toggleSelection(setSelectedSessions, item.session_id),
                  }))}
                />
              )}
            </div>

            <div className="mt-4 flex items-center justify-between gap-4">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                {t("Language")}
                <select
                  value={language}
                  onChange={(event) => setLanguage(event.target.value as "en" | "zh")}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
                >
                  <option value="en">English</option>
                  <option value="zh">中文</option>
                </select>
              </label>
              <Button
                onClick={() => onCreate(createPayload())}
                disabled={!intent.trim()}
                loading={creating}
              >
                {!creating && <Sparkles size={14} />}
                {creating ? t("Drafting proposal…") : t("Draft proposal")}
              </Button>
            </div>
          </div>
        )}

        {step === "proposal" && proposal && (
          <div className="surface mt-6 space-y-4 p-5">
            <div>
              <label
                htmlFor="book-proposal-title"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                {t("Title")}
              </label>
              <Input
                id="book-proposal-title"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                disabled={confirmingProposal}
              />
            </div>
            <div>
              <label
                htmlFor="book-proposal-description"
                className="mb-1.5 block text-sm font-medium text-foreground"
              >
                {t("Description")}
              </label>
              <Textarea
                id="book-proposal-description"
                value={draftDescription}
                onChange={(e) => setDraftDescription(e.target.value)}
                autoResize
                rows={3}
                disabled={confirmingProposal}
              />
            </div>
            <dl className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-muted-subtle p-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {t("Scope")}
                </dt>
                <dd className="mt-0.5 text-foreground">{proposal.scope}</dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {t("Level")}
                </dt>
                <dd className="mt-0.5 text-foreground">
                  {proposal.target_level}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  {t("Chapters")}
                </dt>
                <dd className="mt-0.5 text-foreground">
                  {proposal.estimated_chapters}
                </dd>
              </div>
            </dl>
            {proposal.rationale && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {proposal.rationale}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                onClick={() =>
                  onConfirmProposal({
                    ...proposal,
                    title: draftTitle.trim() || proposal.title,
                    description: draftDescription.trim() || proposal.description,
                  })
                }
                loading={confirmingProposal}
              >
                {confirmingProposal
                  ? t("Building outline…")
                  : t("Confirm and build outline")}
              </Button>
            </div>
          </div>
        )}

        {step === "spine" && spine && (
          <SpineEditor
            key={`${spine.book_id}:${spine.version}`}
            spine={spine}
            confirming={confirmingSpine}
            onConfirm={onConfirmSpine}
          />
        )}
      </div>
    </div>
  );
}

function SpineEditor({
  spine,
  confirming,
  onConfirm,
}: {
  spine: Spine;
  confirming: boolean;
  onConfirm: (spine: Spine) => void;
}) {
  const { t } = useTranslation();
  const [chapters, setChapters] = React.useState(spine.chapters);

  const updateChapter = (index: number, patch: Partial<Spine["chapters"][number]>) => {
    setChapters((current) =>
      current.map((chapter, chapterIndex) =>
        chapterIndex === index ? { ...chapter, ...patch } : chapter,
      ),
    );
  };

  const moveChapter = (index: number, direction: -1 | 1) => {
    setChapters((current) => {
      const destination = index + direction;
      if (destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next.map((chapter, order) => ({ ...chapter, order }));
    });
  };

  return (
    <div className="mt-6 space-y-3">
      {chapters.map((chapter, idx) => (
        <div key={chapter.id} className="surface p-4">
          <div className="flex items-start gap-3">
            <span className="pt-2 font-mono text-xs text-muted-foreground">
              {String(idx + 1).padStart(2, "0")}
            </span>
            <div className="min-w-0 flex-1 space-y-2">
              <Input
                value={chapter.title}
                onChange={(event) => updateChapter(idx, { title: event.target.value })}
                aria-label={t("Chapter {{number}} title", { number: idx + 1 })}
                disabled={confirming}
              />
              <Textarea
                value={chapter.summary}
                onChange={(event) => updateChapter(idx, { summary: event.target.value })}
                aria-label={t("Chapter {{number}} summary", { number: idx + 1 })}
                placeholder={t("Chapter summary")}
                rows={2}
                disabled={confirming}
              />
              <Textarea
                value={chapter.learning_objectives.join("\n")}
                onChange={(event) =>
                  updateChapter(idx, {
                    learning_objectives: event.target.value
                      .split("\n")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
                aria-label={t("Chapter {{number}} learning objectives", { number: idx + 1 })}
                placeholder={t("One learning objective per line")}
                rows={3}
                disabled={confirming}
              />
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <div className="flex items-center gap-1.5">
                <Badge variant="outline">{t(chapter.content_type)}</Badge>
                <Badge variant="default"><Layers size={11} />{t("{{count}} pages", { count: chapter.page_ids.length })}</Badge>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" onClick={() => moveChapter(idx, -1)} disabled={confirming || idx === 0} aria-label={t("Move chapter up")}><ArrowUp size={14} /></Button>
                <Button variant="ghost" size="icon" onClick={() => moveChapter(idx, 1)} disabled={confirming || idx === chapters.length - 1} aria-label={t("Move chapter down")}><ArrowDown size={14} /></Button>
              </div>
            </div>
          </div>
        </div>
      ))}
      <div className="flex justify-end pt-2">
        <Button
          onClick={() => onConfirm({ ...spine, chapters })}
          disabled={chapters.some((chapter) => !chapter.title.trim())}
          loading={confirming}
        >
          {confirming ? t("Starting compilation…") : t("Confirm outline and compile")}
        </Button>
      </div>
    </div>
  );
}

interface SourceListItem {
  id: string;
  title: string;
  detail: string;
  selected: boolean;
  onToggle: () => void;
}

function SourceList({ empty, items }: { empty: string; items: SourceListItem[] }) {
  if (items.length === 0) {
    return <p className="px-3 py-8 text-center text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="space-y-0.5">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={item.onToggle}
            aria-pressed={item.selected}
            className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
              item.selected ? "bg-primary-muted" : "hover:bg-muted"
            }`}
          >
            <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
              item.selected ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background"
            }`}>
              {item.selected && <Check size={11} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">{item.title}</span>
              {item.detail && <span className="block truncate text-xs text-muted-foreground">{item.detail}</span>}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export default BookCreator;
