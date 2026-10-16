"use client";

import * as React from "react";
import {
  BookOpen,
  Bot,
  Brain,
  History,
  Library,
  Link2,
  ListChecks,
  LoaderCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Dropdown, Toggle } from "@/components/ui";
import { bookApi } from "@/lib/book-api";
import type { Book } from "@/lib/book-types";
import type { ChatReferenceSelection } from "@/lib/chat-reference-selection";
import { toggleExclusiveAgent } from "@/lib/chat-reference-selection";
import {
  getNotebook,
  listNotebookEntries,
  listNotebooks,
  type NotebookEntry,
  type NotebookSummary,
} from "@/lib/notebook-api";
import { listSessions, type SessionSummary } from "@/lib/session-api";
import {
  listSubagentConnections,
  type SubagentConnection,
} from "@/lib/subagents-api";
import { cn } from "@/lib/utils";

type Section = "agents" | "history" | "notebooks" | "questions" | "books" | "memory";

const SECTIONS: Array<{
  key: Section;
  label: string;
  icon: typeof Link2;
}> = [
  { key: "agents", label: "Assistants", icon: Bot },
  { key: "history", label: "History", icon: History },
  { key: "notebooks", label: "Notebooks", icon: Library },
  { key: "questions", label: "Questions", icon: ListChecks },
  { key: "books", label: "Books", icon: BookOpen },
  { key: "memory", label: "Memory", icon: Brain },
];

interface Props {
  selection: ChatReferenceSelection;
  onSelectionChange: (selection: ChatReferenceSelection) => void;
  selectedKnowledgeBases: string[];
  activeAgentName: string;
  onAgentSelectionChange: (name: string, knowledgeBases?: string[]) => void;
  onAgentNamesChange?: (names: string[]) => void;
  referenceCount: number;
  triggerClassName?: string;
}

function toggleValue<T>(values: T[], value: T): T[] {
  return values.includes(value)
    ? values.filter((item) => item !== value)
    : [...values, value];
}

function clipped(value: string | undefined, limit = 120): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function SelectionRow({
  title,
  description,
  checked,
  disabled,
  loading,
  onToggle,
}: {
  title: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  loading?: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-2",
        disabled ? "opacity-50" : "hover:bg-muted",
      )}
    >
      <button
        type="button"
        disabled={disabled || loading}
        onClick={onToggle}
        className="min-w-0 flex-1 text-left"
      >
        <span className="block truncate text-sm text-foreground">{title}</span>
        {description && (
          <span className="block truncate text-[11px] text-muted-foreground">
            {description}
          </span>
        )}
      </button>
      {loading ? (
        <LoaderCircle size={14} className="animate-spin text-muted-foreground" />
      ) : (
        <Toggle
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={title}
        />
      )}
    </div>
  );
}

/** Unified picker for sticky Agent selection and one-turn learning references. */
export function ChatReferencePicker({
  selection,
  onSelectionChange,
  selectedKnowledgeBases,
  activeAgentName,
  onAgentSelectionChange,
  onAgentNamesChange,
  referenceCount,
  triggerClassName,
}: Props) {
  const { t } = useTranslation();
  const [section, setSection] = React.useState<Section>("agents");
  const [loading, setLoading] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const [loadingKey, setLoadingKey] = React.useState("");
  const [failed, setFailed] = React.useState(false);
  const [agents, setAgents] = React.useState<SubagentConnection[]>([]);
  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [notebooks, setNotebooks] = React.useState<NotebookSummary[]>([]);
  const [questions, setQuestions] = React.useState<NotebookEntry[]>([]);
  const [books, setBooks] = React.useState<Book[]>([]);

  const loadReferences = React.useCallback(async (force = false) => {
    if ((!force && loaded) || loading) return;
    setLoading(true);
    if (force) setFailed(false);
    const results = await Promise.allSettled([
      listSubagentConnections(),
      listSessions(50, 0),
      listNotebooks(),
      listNotebookEntries({ limit: 50, offset: 0 }),
      bookApi.list(),
    ]);
    const [agentResult, sessionResult, notebookResult, questionResult, bookResult] = results;
    const nextAgents = agentResult.status === "fulfilled" ? agentResult.value : [];
    setAgents(nextAgents);
    onAgentNamesChange?.(nextAgents.map((item) => item.name));
    if (!activeAgentName) {
      const restored = nextAgents.find((agent) =>
        selectedKnowledgeBases.includes(agent.name),
      );
      if (restored) onAgentSelectionChange(restored.name);
    }
    setSessions(sessionResult.status === "fulfilled" ? sessionResult.value : []);
    setNotebooks(notebookResult.status === "fulfilled" ? notebookResult.value : []);
    setQuestions(questionResult.status === "fulfilled" ? questionResult.value.items : []);
    setBooks(bookResult.status === "fulfilled" ? bookResult.value.books : []);
    setFailed(results.some((result) => result.status === "rejected"));
    setLoading(false);
    setLoaded(true);
  }, [
    activeAgentName,
    loaded,
    loading,
    onAgentNamesChange,
    onAgentSelectionChange,
    selectedKnowledgeBases,
  ]);

  const toggleNotebook = async (notebook: NotebookSummary) => {
    const selected = selection.notebooks.some((item) => item.notebookId === notebook.id);
    if (selected) {
      onSelectionChange({
        ...selection,
        notebooks: selection.notebooks.filter((item) => item.notebookId !== notebook.id),
      });
      return;
    }
    setLoadingKey(`notebook:${notebook.id}`);
    try {
      const detail = await getNotebook(notebook.id);
      const recordIds = detail.records.map((record) => record.id).filter(Boolean);
      if (!recordIds.length) return;
      onSelectionChange({
        ...selection,
        notebooks: [...selection.notebooks, { notebookId: notebook.id, recordIds }],
      });
    } catch {
      setFailed(true);
    } finally {
      setLoadingKey("");
    }
  };

  const toggleBook = async (book: Book) => {
    const selected = selection.books.some((item) => item.bookId === book.id);
    if (selected) {
      onSelectionChange({
        ...selection,
        books: selection.books.filter((item) => item.bookId !== book.id),
      });
      return;
    }
    setLoadingKey(`book:${book.id}`);
    try {
      const detail = await bookApi.get(book.id);
      const pageIds = detail.pages.map((page) => page.id).filter(Boolean);
      if (!pageIds.length) return;
      onSelectionChange({
        ...selection,
        books: [...selection.books, { bookId: book.id, pageIds }],
      });
    } catch {
      setFailed(true);
    } finally {
      setLoadingKey("");
    }
  };

  const empty = (label: string) => (
    <div className="px-3 py-8 text-center text-xs text-muted-foreground">
      {t(label)}
    </div>
  );

  return (
    <Dropdown
      trigger={
        <button
          type="button"
          onClick={() => void loadReferences()}
          data-testid="chat-reference-picker"
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            triggerClassName,
          )}
          aria-label={t("Learning sources")}
        >
          {activeAgentName ? <Bot size={14} /> : <Link2 size={14} />}
          <span className="max-w-24 truncate">
            {activeAgentName || t("Sources")}
          </span>
          {referenceCount > 0 && (
            <span
              data-testid="chat-reference-count"
              className="rounded-full bg-primary-muted px-1.5 text-[10px] text-primary"
            >
              {referenceCount}
            </span>
          )}
        </button>
      }
      className="bottom-full mb-1 w-[28rem] max-w-[calc(100vw-2rem)]"
    >
      <div className="flex gap-1 overflow-x-auto border-b border-border p-1 pb-2">
        {SECTIONS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => setSection(item.key)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px]",
                section === item.key
                  ? "bg-primary-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon size={12} />
              {t(item.label)}
            </button>
          );
        })}
      </div>
      {failed && (
        <div className="mx-2 mt-2 flex items-center gap-2 rounded-md bg-warning-muted px-2 py-1 text-[11px] text-foreground">
          <span className="flex-1">{t("Some reference sources could not be loaded.")}</span>
          <button
            type="button"
            disabled={loading}
            onClick={() => void loadReferences(true)}
            className="font-medium text-primary hover:underline disabled:opacity-50"
          >
            {t("Retry reference sources")}
          </button>
        </div>
      )}
      <div className="max-h-72 overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground">
            <LoaderCircle size={14} className="animate-spin" />
            {t("Loading references…")}
          </div>
        ) : section === "agents" ? (
          agents.length ? agents.map((agent) => (
            <SelectionRow
              key={agent.name}
              title={agent.name}
              description={`${agent.agent_kind}${agent.description ? ` · ${agent.description}` : ""}`}
              checked={selectedKnowledgeBases.includes(agent.name)}
              onToggle={() => {
                const alreadySelected = selectedKnowledgeBases.includes(agent.name);
                onAgentSelectionChange(
                  alreadySelected ? "" : agent.name,
                  toggleExclusiveAgent(
                    selectedKnowledgeBases,
                    agents.map((item) => item.name),
                    agent.name,
                  ),
                );
              }}
            />
          )) : empty("No connected assistants yet")
        ) : section === "history" ? (
          sessions.length ? sessions.map((sessionItem) => (
            <SelectionRow
              key={sessionItem.session_id}
              title={sessionItem.title || t("Untitled session")}
              description={clipped(sessionItem.last_message)}
              checked={selection.historySessionIds.includes(sessionItem.session_id)}
              onToggle={() =>
                onSelectionChange({
                  ...selection,
                  historySessionIds: toggleValue(selection.historySessionIds, sessionItem.session_id),
                })
              }
            />
          )) : empty("No chat history yet")
        ) : section === "notebooks" ? (
          notebooks.length ? notebooks.map((notebook) => (
            <SelectionRow
              key={notebook.id}
              title={notebook.name}
              description={t("{{count}} records", { count: notebook.record_count ?? 0 })}
              checked={selection.notebooks.some((item) => item.notebookId === notebook.id)}
              disabled={(notebook.record_count ?? 0) === 0}
              loading={loadingKey === `notebook:${notebook.id}`}
              onToggle={() => void toggleNotebook(notebook)}
            />
          )) : empty("No notebooks yet")
        ) : section === "questions" ? (
          questions.length ? questions.map((question) => (
            <SelectionRow
              key={question.id}
              title={clipped(question.question, 160) || t("Saved question")}
              description={question.session_title || question.difficulty}
              checked={selection.questionEntryIds.includes(question.id)}
              onToggle={() =>
                onSelectionChange({
                  ...selection,
                  questionEntryIds: toggleValue(selection.questionEntryIds, question.id),
                })
              }
            />
          )) : empty("No saved questions yet")
        ) : section === "books" ? (
          books.length ? books.map((book) => (
            <SelectionRow
              key={book.id}
              title={book.title}
              description={t("{{count}} pages", { count: book.page_count })}
              checked={selection.books.some((item) => item.bookId === book.id)}
              disabled={book.page_count === 0}
              loading={loadingKey === `book:${book.id}`}
              onToggle={() => void toggleBook(book)}
            />
          )) : empty("No books yet")
        ) : (
          <>
            <SelectionRow
              title={t("Learning summary")}
              description={t("Recent learning across modules")}
              checked={selection.memoryScopes.includes("summary")}
              onToggle={() =>
                onSelectionChange({
                  ...selection,
                  memoryScopes: toggleValue(selection.memoryScopes, "summary"),
                })
              }
            />
            <SelectionRow
              title={t("Learner profile")}
              description={t("Long-term preferences and learning profile")}
              checked={selection.memoryScopes.includes("profile")}
              onToggle={() =>
                onSelectionChange({
                  ...selection,
                  memoryScopes: toggleValue(selection.memoryScopes, "profile"),
                })
              }
            />
          </>
        )}
      </div>
      <div className="border-t border-border px-2 py-2 text-[11px] text-muted-foreground">
        {section === "agents"
          ? t("The selected assistant stays active for this conversation.")
          : t("Selected references apply to the next message only.")}
      </div>
    </Dropdown>
  );
}
