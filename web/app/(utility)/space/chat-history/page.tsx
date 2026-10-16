"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { History, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";
import { SpaceHeader } from "@/components/space/SpaceHeader";
import {
  deleteSession,
  listSessions,
  resolveUpdatedFrom,
  type SessionSummary,
} from "@/lib/session-api";
import { formatDate, type Language } from "@/lib/datetime";
import { groupSessionsByLearningGoal } from "@/lib/session-groups";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SpaceChatHistoryPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const lang: Language = i18n.language?.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";

  const [sessions, setSessions] = React.useState<SessionSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [query, setQuery] = React.useState("");
  const deferredQuery = React.useDeferredValue(query);
  const [capability, setCapability] = React.useState("");
  const [rangeDays, setRangeDays] = React.useState(0);
  const [deleteTarget, setDeleteTarget] =
    React.useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const filters = {
          query: deferredQuery,
          capability: capability || undefined,
          // Read the clock when the user-triggered/effectful load runs, not
          // while React is rendering. This keeps render deterministic and
          // makes a refresh advance a relative time window as expected.
          updatedFrom: resolveUpdatedFrom(
            rangeDays,
            Math.floor(Date.now() / 1000),
          ),
        };
        setSessions(
          await listSessions(200, 0, { force, filters }),
        );
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("Failed to load chat history"),
          description: errorMessage(error),
        });
      } finally {
        setLoading(false);
      }
    },
    [capability, deferredQuery, rangeDays, t, toast],
  );

  React.useEffect(() => {
    void load(true);
  }, [load]);

  const grouped = React.useMemo(() => groupSessionsByLearningGoal(sessions), [sessions]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteSession(deleteTarget.session_id);
      toast({ variant: "success", title: t("Chat deleted") });
      setSessions((prev) =>
        prev.filter((s) => s.session_id !== deleteTarget.session_id),
      );
      setDeleteTarget(null);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete chat"),
        description: errorMessage(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-8">
      <SpaceHeader
        back
        title={t("Chat History")}
        description={t(
          "Browse, search, and reopen previous conversations from your learning space.",
        )}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(true)}
            disabled={loading}
          >
            <RefreshCw
              size={14}
              aria-hidden="true"
              className={loading ? "animate-spin" : undefined}
            />
            {t("Refresh")}
          </Button>
        }
      />

      <div className="surface">
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("Search chat history...")}
              className="pl-8"
              aria-label={t("Search chat history")}
            />
          </div>
          <select
            value={capability}
            onChange={(event) => setCapability(event.target.value)}
            aria-label={t("Filter by capability")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">{t("All capabilities")}</option>
            <option value="chat">{t("Chat")}</option>
            <option value="mastery_path">{t("Learning plan")}</option>
            <option value="deep_solve">{t("Deep Solve")}</option>
            <option value="deep_question">{t("Practice Questions")}</option>
            <option value="deep_research">{t("Deep Research")}</option>
            <option value="visualize">{t("Visualize")}</option>
            <option value="math_animator">{t("Math Animator")}</option>
          </select>
          <select
            value={rangeDays}
            onChange={(event) => setRangeDays(Number(event.target.value))}
            aria-label={t("Filter by time")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring"
          >
            <option value={0}>{t("Any time")}</option>
            <option value={7}>{t("Last 7 days")}</option>
            <option value={30}>{t("Last 30 days")}</option>
            <option value={90}>{t("Last 90 days")}</option>
          </select>
        </div>

        {loading ? (
          <div className="space-y-2 px-4 py-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={History}
            title={query || capability || rangeDays ? t("No matching conversations") : t("No chat history yet")}
            description={
              query || capability || rangeDays
                ? t("Try a different search term.")
                : t("Start a conversation and it will show up here.")
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {grouped.map((group) => (
              <section key={group.key}>
                <h2 className="bg-muted-subtle px-4 py-2 text-xs font-medium text-muted-foreground">
                  {group.key.startsWith("kb:") ? t("Course: {{name}}", { name: group.label }) : t(group.label === "chat" || group.label === "auto" ? "General tutoring" : group.label)}
                </h2>
                <ul className="divide-y divide-border">
            {group.sessions.map((session) => (
              <li key={session.session_id} className="group flex items-stretch">
                <Link
                  href={`/home/${encodeURIComponent(session.session_id)}`}
                  className="min-w-0 flex-1 px-4 py-3 transition-colors hover:bg-accent"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {session.title || t("Untitled conversation")}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(new Date(session.updated_at * 1000), lang)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {session.last_message || "—"}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {t("{{count}} messages", {
                        count: session.message_count,
                      })}
                    </span>
                  </div>
                </Link>
                <div className="flex items-center pr-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("Delete chat")}
                    onClick={() => setDeleteTarget(session)}
                    className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete chat")}
        description={t(
          'Delete "{{name}}"? This conversation cannot be recovered.',
          { name: deleteTarget?.title ?? "" },
        )}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
      />
    </div>
  );
}
