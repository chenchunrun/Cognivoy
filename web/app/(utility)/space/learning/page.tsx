"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  Circle,
  CircleCheck,
  CircleDot,
  GraduationCap,
  History,
  Flame,
  GitBranch,
  LockKeyhole,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  useToast,
} from "@/components/ui";
import { SpaceHeader } from "@/components/space/SpaceHeader";
import { LearningProjectsPanel } from "@/components/learning/LearningProjectsPanel";
import {
  deleteProgress,
  fetchAllProgress,
  fetchMasteryMap,
  fetchRedoHistory,
  groupProgressSummaries,
  redoProgress,
  restoreRedoArchive,
  type MasteryMapResult,
  type ObjectiveStatus,
  type ProgressSummary,
  type ProgressSummaryGroup,
  type RedoArchiveSummary,
} from "@/lib/learning-api";
import { formatDate, formatTime, type Language } from "@/lib/datetime";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const STATUS_LABEL: Record<ObjectiveStatus, string> = {
  mastered: "Mastered",
  learning: "Learning",
  new: "Not started",
};

const ACTION_LABEL: Record<string, string> = {
  probe: "Probe — test out first",
  practice: "Practice until the gate clears",
  assess: "Explain it in your own words",
  review: "Due for review",
  answer_pending: "A question is awaiting your answer",
  complete: "All objectives mastered",
  blocked: "Complete the prerequisite modules first",
};

export default function SpaceLearningPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();

  const [paths, setPaths] = React.useState<ProgressSummary[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<MasteryMapResult | null>(null);
  const [loadingList, setLoadingList] = React.useState(true);
  const [loadingDetail, setLoadingDetail] = React.useState(false);
  const [deleteTarget, setDeleteTarget] =
    React.useState<ProgressSummary | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [redoTarget, setRedoTarget] = React.useState<ProgressSummary | null>(
    null,
  );
  const [redoing, setRedoing] = React.useState(false);
  const [redoHistory, setRedoHistory] = React.useState<RedoArchiveSummary[]>([]);
  const [loadingRedoHistory, setLoadingRedoHistory] = React.useState(false);
  const [restoreTarget, setRestoreTarget] =
    React.useState<RedoArchiveSummary | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  const lang: Language = i18n.language?.toLowerCase().startsWith("zh")
    ? "zh"
    : "en";
  const pathGroups = React.useMemo(() => groupProgressSummaries(paths), [paths]);

  const loadList = React.useCallback(async () => {
    setLoadingList(true);
    try {
      const result = await fetchAllProgress();
      const withContent = result.summaries
        .filter((s) => s.kp_count > 0)
        .sort((a, b) => b.updated_at - a.updated_at);
      setPaths(withContent);
      setSelected((prev) =>
        prev && withContent.some((p) => p.book_id === prev)
          ? prev
          : (withContent[0]?.book_id ?? null),
      );
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load learning progress"),
        description: errorMessage(error),
      });
      setPaths([]);
    } finally {
      setLoadingList(false);
    }
  }, [t, toast]);

  React.useEffect(() => {
    void loadList();
  }, [loadList]);

  React.useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    fetchMasteryMap(selected)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((error) => {
        if (!cancelled) {
          setDetail(null);
          toast({
            variant: "destructive",
            title: t("Failed to load the mastery map"),
            description: errorMessage(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, t, toast]);

  const loadRedoHistory = React.useCallback(async (bookId: string) => {
    setLoadingRedoHistory(true);
    try {
      setRedoHistory(await fetchRedoHistory(bookId));
    } catch (error) {
      setRedoHistory([]);
      toast({
        variant: "destructive",
        title: t("Failed to load reset history"),
        description: errorMessage(error),
      });
    } finally {
      setLoadingRedoHistory(false);
    }
  }, [t, toast]);

  React.useEffect(() => {
    if (!selected) {
      setRedoHistory([]);
      return;
    }
    void loadRedoHistory(selected);
  }, [loadRedoHistory, selected]);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteProgress(deleteTarget.book_id);
      toast({ variant: "success", title: t("Learning plan deleted") });
      setDeleteTarget(null);
      await loadList();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete learning plan"),
        description: errorMessage(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleRedo = async () => {
    if (!redoTarget) return;
    setRedoing(true);
    try {
      const bookId = redoTarget.book_id;
      await redoProgress(bookId);
      toast({ variant: "success", title: t("Progress reset") });
      setRedoTarget(null);
      const [nextMap] = await Promise.all([
        fetchMasteryMap(bookId),
        loadRedoHistory(bookId),
        loadList(),
      ]);
      setDetail(nextMap);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to reset progress"),
        description: errorMessage(error),
      });
    } finally {
      setRedoing(false);
    }
  };

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const bookId = restoreTarget.book_id;
      await restoreRedoArchive(bookId, restoreTarget.id);
      setRestoreTarget(null);
      const [nextMap] = await Promise.all([
        fetchMasteryMap(bookId),
        loadRedoHistory(bookId),
        loadList(),
      ]);
      setDetail(nextMap);
      toast({ variant: "success", title: t("Progress restored") });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to restore progress"),
        description: errorMessage(error),
      });
    } finally {
      setRestoring(false);
    }
  };

  const selectedPath = paths.find((p) => p.book_id === selected) ?? null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <SpaceHeader
        back
        title={t("Learning plans")}
        description={t(
          "Turn a long-term goal into a plan, concrete learning tasks, and timely review.",
        )}
      />

      <LearningProjectsPanel />

      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* Path list */}
        <aside className="surface min-w-0">
          {loadingList ? (
            <div className="space-y-2 p-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : paths.length === 0 ? (
            <EmptyState
              icon={GraduationCap}
              title={t("No learning plans yet")}
              description={t(
                "Create a learning goal above. Cognivoy will build the plan, first task, and mastery map with you.",
              )}
            />
          ) : (
            <ul className="space-y-1 p-2">
              {pathGroups.map((group) => (
                <li key={group.key}>
                  {group.items.length > 1 ? (
                    <DuplicatePathGroup
                      group={group}
                      selected={selected}
                      lang={lang}
                      onSelect={setSelected}
                    />
                  ) : (
                    <PathButton
                      path={group.items[0]}
                      selected={selected === group.items[0].book_id}
                      onSelect={() => setSelected(group.items[0].book_id)}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Selected path map */}
        <section className="surface min-w-0 min-h-[320px] p-5">
          {loadingDetail ? (
            <div className="space-y-3">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-2 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : !detail || !selectedPath ? (
            <EmptyState
              icon={GraduationCap}
              title={t("Select a path")}
              description={t(
                "Pick a learning plan on the left to see its progress map.",
              )}
            />
          ) : (
            <MapView
              result={detail}
              onContinue={() =>
                router.push(`/home/${encodeURIComponent(selectedPath.book_id)}`)
              }
              onRedo={() => setRedoTarget(selectedPath)}
              onDelete={() => setDeleteTarget(selectedPath)}
              redoHistory={redoHistory}
              loadingRedoHistory={loadingRedoHistory}
              lang={lang}
              onRestore={setRestoreTarget}
            />
          )}
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete learning plan")}
        description={t(
          'Delete "{{name}}" and all of its progress? This cannot be undone.',
          { name: deleteTarget?.name ?? "" },
        )}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
      />
      <ConfirmDialog
        open={Boolean(redoTarget)}
        onClose={() => setRedoTarget(null)}
        onConfirm={() => void handleRedo()}
        title={t("Reset progress")}
        description={t(
          "Reset progress for {{name}}? Objectives are kept, but mastery and review schedules are cleared.",
          { name: redoTarget?.name ?? "" },
        )}
        confirmText={t("Reset")}
        destructive
        loading={redoing}
      />
      <ConfirmDialog
        open={Boolean(restoreTarget)}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => void handleRestore()}
        title={t("Restore archived progress")}
        description={t(
          "Restore this snapshot? Your current mastery progress will be replaced by the archived state.",
        )}
        confirmText={t("Restore")}
        loading={restoring}
      />
    </div>
  );
}

function DuplicatePathGroup({
  group,
  selected,
  lang,
  onSelect,
}: {
  group: ProgressSummaryGroup;
  selected: string | null;
  lang: Language;
  onSelect: (bookId: string) => void;
}) {
  const containsSelection = group.items.some((path) => path.book_id === selected);
  const [expanded, setExpanded] = React.useState(containsSelection);

  React.useEffect(() => {
    if (containsSelection) setExpanded(true);
  }, [containsSelection]);

  return (
    <details
      className="rounded-lg border border-border"
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-accent">
        <span className="truncate">{group.name}</span>
        <Badge variant="outline">×{group.items.length}</Badge>
      </summary>
      <ul className="border-t border-border p-1">
        {group.items.map((path) => (
          <li key={path.book_id}>
            <PathButton
              path={path}
              selected={selected === path.book_id}
              secondary={formatDate(new Date(path.updated_at * 1000), lang)}
              onSelect={() => onSelect(path.book_id)}
            />
          </li>
        ))}
      </ul>
    </details>
  );
}

function PathButton({
  path,
  selected,
  secondary,
  onSelect,
}: {
  path: ProgressSummary;
  selected: boolean;
  secondary?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
        selected
          ? "bg-primary-muted text-accent-foreground"
          : "text-foreground hover:bg-accent"
      }`}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{path.name}</span>
        {secondary && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {secondary}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-success transition-all"
            style={{ width: `${path.avg_mastery_pct}%` }}
          />
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {path.avg_mastery_pct}%
        </span>
      </div>
    </button>
  );
}

function StatusIcon({ status }: { status: ObjectiveStatus }) {
  const className =
    status === "mastered"
      ? "text-success"
      : status === "learning"
        ? "text-warning"
        : "text-muted-foreground";
  if (status === "mastered")
    return <CircleCheck size={13} className={className} aria-hidden="true" />;
  if (status === "learning")
    return <CircleDot size={13} className={className} aria-hidden="true" />;
  return <Circle size={13} className={className} aria-hidden="true" />;
}

function MapView({
  result,
  onContinue,
  onRedo,
  onDelete,
  redoHistory,
  loadingRedoHistory,
  lang,
  onRestore,
}: {
  result: MasteryMapResult;
  onContinue: () => void;
  onRedo: () => void;
  onDelete: () => void;
  redoHistory: RedoArchiveSummary[];
  loadingRedoHistory: boolean;
  lang: Language;
  onRestore: (archive: RedoArchiveSummary) => void;
}) {
  const { t } = useTranslation();
  const { map, next } = result;
  const pct = map.counts.total
    ? Math.round((map.counts.mastered / map.counts.total) * 100)
    : 0;

  return (
    <div className="min-w-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>
              {t("{{mastered}} of {{total}} mastered", {
                mastered: map.counts.mastered,
                total: map.counts.total,
              })}
            </span>
            {map.due_reviews > 0 && (
              <Badge variant="warning">
                {t("{{count}} due for review", { count: map.due_reviews })}
              </Badge>
            )}
            <Badge variant="outline">
              <Flame size={12} aria-hidden="true" />
              {t("{{count}} day streak", { count: map.current_streak_days })}
            </Badge>
            <Badge variant="outline">
              {t("{{count}} evidence records", { count: map.evidence_count })}
            </Badge>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-success transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Reset progress")}
            onClick={onRedo}
          >
            <RotateCcw size={14} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("Delete learning plan")}
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 size={14} aria-hidden="true" />
          </Button>
        </div>
      </div>

      <button
        type="button"
        onClick={onContinue}
        className="mt-4 w-full rounded-lg border border-border p-3 text-left transition-colors hover:border-primary-border hover:bg-accent"
      >
        <div className="text-xs text-muted-foreground">{t("Next up")}</div>
        <div className="mt-0.5 text-sm font-medium text-foreground">
          {next.action === "complete" || next.action === "blocked"
            ? t(ACTION_LABEL[next.action])
            : `${next.knowledge_point_name} — ${t(ACTION_LABEL[next.action] ?? next.reason)}`}
        </div>
        <div className="mt-1 text-xs text-primary">
          {t("Continue tutoring in Chat")}
        </div>
      </button>

      <div className="mt-5 space-y-4">
        {map.modules.map((module) => (
          <div
            key={module.id}
            className={module.locked ? "rounded-lg border border-border bg-muted-subtle p-3" : ""}
          >
            <div className="flex items-center justify-between">
              <div className="flex min-w-0 items-center gap-2">
                {module.locked ? (
                  <LockKeyhole size={14} className="text-muted-foreground" aria-hidden="true" />
                ) : module.depends_on.length > 0 ? (
                  <GitBranch size={14} className="text-primary" aria-hidden="true" />
                ) : null}
                <h3 className="truncate text-sm font-medium text-foreground">
                  {module.name}
                </h3>
              </div>
              <span className="text-xs text-muted-foreground">
                {t("{{mastered}} of {{total}}", {
                  mastered: module.mastered,
                  total: module.total,
                })}
              </span>
            </div>
            {module.depends_on.length > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Prerequisites: {{modules}}", {
                  modules: module.depends_on
                    .map((id) => map.modules.find((item) => item.id === id)?.name ?? id)
                    .join(", "),
                })}
              </p>
            )}
            <div className="mt-1.5 min-w-0 space-y-1">
              {module.knowledge_points.map((kp) => (
                <div
                  key={kp.id}
                  className="flex min-w-0 flex-wrap items-center gap-2 rounded-md px-2 py-1 sm:flex-nowrap"
                >
                  <StatusIcon status={kp.status} />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {kp.name}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {t("{{count}} evidence", { count: kp.evidence_count })}
                  </span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {kp.type}
                  </span>
                  <span
                    className={`shrink-0 text-xs ${
                      kp.status === "mastered"
                        ? "text-success"
                        : kp.status === "learning"
                          ? "text-warning"
                          : "text-muted-foreground"
                    }`}
                  >
                    {t(STATUS_LABEL[kp.status])}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <section className="mt-6 border-t border-border pt-5" aria-labelledby="reset-history-heading">
        <div className="flex items-center gap-2">
          <History size={15} className="text-muted-foreground" aria-hidden="true" />
          <h3 id="reset-history-heading" className="text-sm font-medium text-foreground">
            {t("Reset history")}
          </h3>
        </div>
        {loadingRedoHistory ? (
          <div className="mt-3 space-y-2">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : redoHistory.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            {t("No archived progress yet. Resetting a path creates a recoverable snapshot.")}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {redoHistory.map((archive) => {
              const created = new Date(archive.created_at * 1000);
              return (
                <li
                  key={archive.id}
                  className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {formatDate(created, lang)} · {formatTime(created, lang)}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t("{{count}} mastery records", { count: archive.mastery_count })}
                      {" · "}
                      {t("{{count}} attempts", { count: archive.attempt_count })}
                      {" · "}
                      {t("{{count}} errors", { count: archive.error_count })}
                    </div>
                    {archive.reason && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {archive.reason}
                      </p>
                    )}
                    {archive.restore_count > 0 && (
                      <Badge variant="outline" className="mt-2">
                        {t("Restored {{count}} times", { count: archive.restore_count })}
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRestore(archive)}
                    aria-label={t("Restore this progress")}
                  >
                    <RotateCcw size={14} aria-hidden="true" />
                    {t("Restore")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
