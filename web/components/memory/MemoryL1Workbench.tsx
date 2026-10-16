"use client";

// L1 workbench — live workspace mirror per surface.
// Modes: Snapshot (entities), Changes (committed + pending diff log),
// Queries (KB-only RAG query trace). Refresh reconciles the persisted
// snapshot with the workspace and commits pending changes.
// Data flow ported from the previous frontend's MemorySection L1View.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ExternalLink,
  GitCommit,
  Layers,
  RefreshCw,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { SURFACES, type Surface } from "@/lib/memory-graph";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
  Tooltip,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  getKbTrace,
  getSnapshot,
  getSnapshotChanges,
  refreshSnapshot,
  type ChangeEntry,
  type KbQueryEvent,
  type MemoryEntity,
  type SnapshotResponse,
} from "./api";
import { formatTimestamp, shorten, SURFACE_META } from "./meta";
import { MemorySubNav } from "./MemorySubNav";

type L1Mode = "snapshot" | "changes" | "queries";

export interface MemoryL1WorkbenchProps {
  initialSurface?: Surface;
  initialFocusRef?: string;
}

export function MemoryL1Workbench({
  initialSurface,
  initialFocusRef,
}: MemoryL1WorkbenchProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [surface, setSurface] = useState<Surface>(initialSurface ?? "notebook");
  const [counts, setCounts] = useState<Partial<Record<Surface, number>>>({});
  const [pendingCounts, setPendingCounts] = useState<
    Partial<Record<Surface, number>>
  >({});
  const [focusRef, setFocusRef] = useState<string | null>(
    initialFocusRef ?? null,
  );
  const choseDefaultSurface = useRef(Boolean(initialSurface));

  const onToast = useCallback(
    (msg: string) => toast({ variant: "destructive", title: msg }),
    [toast],
  );

  // Counts + pending badges for the left rail, fetched in parallel.
  const loadCounts = useCallback(async () => {
    const entries = await Promise.all(
      SURFACES.map(async (key) => {
        try {
          const data = await getSnapshot(key);
          return [
            key,
            data.entities?.length ?? 0,
            data.pending_changes?.length ?? 0,
          ] as const;
        } catch {
          return [key, 0, 0] as const;
        }
      }),
    );
    setCounts(Object.fromEntries(entries.map(([k, n]) => [k, n])));
    setPendingCounts(Object.fromEntries(entries.map(([k, , p]) => [k, p])));
    if (!choseDefaultSurface.current) {
      choseDefaultSurface.current = true;
      const best = [...entries].sort(
        (a, b) => b[1] - a[1] || b[2] - a[2] || SURFACES.indexOf(a[0]) - SURFACES.indexOf(b[0]),
      )[0];
      if (best) setSurface(best[0]);
    }
  }, []);

  useEffect(() => {
    void loadCounts();
  }, [loadCounts]);

  // Re-fetch counts when the tab regains focus so the rail stays in sync.
  useEffect(() => {
    const refetch = () => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadCounts();
    };
    window.addEventListener("focus", refetch);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      window.removeEventListener("focus", refetch);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [loadCounts]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6">
        <h1 className="display flex items-center gap-2.5 text-2xl font-semibold text-foreground">
          <Layers size={22} className="text-primary" />
          {t("L1 · Workspace mirror")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "A live snapshot of your workspace per surface. Refresh records what changed since the last scan.",
          )}
        </p>
        <div className="mt-4">
          <MemorySubNav />
        </div>
      </header>

      <div className="grid items-start gap-5 lg:grid-cols-[210px_minmax(0,1fr)]">
        <Card className="p-2">
          <ul className="space-y-0.5">
            {SURFACES.map((key) => {
              const meta = SURFACE_META[key];
              const Icon = meta.icon;
              const active = key === surface;
              const c = counts[key];
              const p = pendingCounts[key] ?? 0;
              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => {
                      setSurface(key);
                      setFocusRef(null);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-150",
                      active
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted-subtle hover:text-foreground",
                    )}
                  >
                    <Icon size={14} className="shrink-0" />
                    <span className="flex-1 truncate">{t(meta.label)}</span>
                    {p > 0 ? (
                      <Badge variant="warning" className="px-1.5 text-[10px]">
                        {p}
                      </Badge>
                    ) : typeof c === "number" ? (
                      <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {c}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        <div className="min-w-0">
          <L1Panel
            key={surface}
            surface={surface}
            focusRef={focusRef}
            onClearFocus={() => setFocusRef(null)}
            onToast={onToast}
            onCountsChanged={loadCounts}
          />
        </div>
      </div>
    </div>
  );
}

// ── Per-surface panel ────────────────────────────────────────────────

function L1Panel({
  surface,
  focusRef,
  onClearFocus,
  onToast,
  onCountsChanged,
}: {
  surface: Surface;
  focusRef: string | null;
  onClearFocus: () => void;
  onToast: (msg: string) => void;
  onCountsChanged: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [mode, setMode] = useState<L1Mode>("snapshot");
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [kbQueries, setKbQueries] = useState<KbQueryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [snap, chg, queries] = await Promise.all([
        getSnapshot(surface),
        getSnapshotChanges(surface).catch(() => null),
        surface === "kb" ? getKbTrace().catch(() => []) : Promise.resolve([]),
      ]);
      setSnapshot(snap);
      setChanges(chg?.changes ?? []);
      setKbQueries(queries);
    } catch (e) {
      onToast(e instanceof Error ? e.message : "Failed to load snapshot");
    } finally {
      setLoading(false);
    }
  }, [surface, onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-scroll to the focused entity once the snapshot is in the DOM.
  useEffect(() => {
    if (!focusRef || !snapshot || !containerRef.current) return;
    const el = containerRef.current.querySelector(
      `[data-entity-ref="${focusRef}"]`,
    );
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focusRef, snapshot]);

  const pending = useMemo(
    () => snapshot?.pending_changes ?? [],
    [snapshot?.pending_changes],
  );
  const pendingByEntity = useMemo(() => {
    const m = new Map<string, ChangeEntry["kind"]>();
    for (const c of pending) m.set(c.entity_id, c.kind);
    return m;
  }, [pending]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const data = await refreshSnapshot(surface);
      const n = data.changes?.length ?? 0;
      toast({
        variant: "success",
        title:
          n > 0
            ? t("Refreshed: {{n}} changes", { n })
            : t("Refreshed: no changes"),
      });
      await load();
      onCountsChanged();
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("Refresh failed"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRefreshing(false);
    }
  }, [surface, load, onCountsChanged, t, toast]);

  return (
    <div className="space-y-3" ref={containerRef}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={mode} onValueChange={(v) => setMode(v as L1Mode)}>
          <TabsList>
            <TabsTrigger value="snapshot">{t("Snapshot")}</TabsTrigger>
            <TabsTrigger value="changes">{t("Changes")}</TabsTrigger>
            {surface === "kb" && (
              <TabsTrigger value="queries">{t("Queries")}</TabsTrigger>
            )}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          {pending.length > 0 && (
            <Tooltip
              content={t(
                "Workspace changed since last refresh. Click Refresh to commit these to the changes log.",
              )}
            >
              <Badge variant="warning">
                {t("{{n}} pending", { n: pending.length })}
              </Badge>
            </Tooltip>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRefresh()}
            loading={refreshing}
            title={t("Re-scan workspace and record any changes")}
          >
            {!refreshing && <RefreshCw size={14} />}
            {t("Refresh")}
          </Button>
        </div>
      </div>

      {mode === "snapshot" && (
        <SnapshotList
          surface={surface}
          loading={loading}
          snapshot={snapshot}
          pendingByEntity={pendingByEntity}
          focusRef={focusRef}
          onClearFocus={onClearFocus}
        />
      )}
      {mode === "changes" && (
        <ChangesList loading={loading} changes={changes} pending={pending} />
      )}
      {mode === "queries" && surface === "kb" && (
        <KbQueriesList loading={loading} queries={kbQueries} />
      )}
    </div>
  );
}

// ── Snapshot list ────────────────────────────────────────────────────

function SnapshotList({
  surface,
  loading,
  snapshot,
  pendingByEntity,
  focusRef,
  onClearFocus,
}: {
  surface: Surface;
  loading: boolean;
  snapshot: SnapshotResponse | null;
  pendingByEntity: Map<string, ChangeEntry["kind"]>;
  focusRef: string | null;
  onClearFocus: () => void;
}) {
  const { t } = useTranslation();
  const entities = snapshot?.entities ?? [];

  if (loading && entities.length === 0) {
    return (
      <Card className="p-4">
        <div className="space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </Card>
    );
  }
  if (entities.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Search}
          title={t("Nothing in workspace yet")}
          description={t(
            "Entities appear here as you use this surface — chats, notes, quizzes, and more.",
          )}
        />
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>
          {t("{{n}} entities", { n: entities.length })}
          {snapshot?.last_refresh && (
            <>
              {" · "}
              {t("last refresh {{ts}}", {
                ts: formatTimestamp(snapshot.last_refresh),
              })}
            </>
          )}
        </span>
        {focusRef && (
          <button
            type="button"
            onClick={onClearFocus}
            className="text-primary hover:underline"
          >
            {t("Clear focus")}
          </button>
        )}
      </div>
      <Card className="overflow-hidden">
        <ol>
          {entities.map((ent, idx) => (
            <EntityRow
              key={`${ent.id}#${idx}`}
              surface={surface}
              ent={ent}
              focused={focusRef === `${surface}:${ent.id}`}
              pendingKind={pendingByEntity.get(ent.id) ?? null}
            />
          ))}
        </ol>
      </Card>
    </div>
  );
}

function entityDeepLink(surface: Surface, ent: MemoryEntity): string | null {
  const m = ent.metadata ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (surface) {
    case "chat":
      return `/home/${encodeURIComponent(ent.id)}`;
    case "cowriter":
      return `/co-writer/${encodeURIComponent(ent.id)}`;
    case "notebook": {
      const nbId = str(m.notebook_id);
      return nbId
        ? `/notebook?notebook=${encodeURIComponent(nbId)}`
        : "/notebook";
    }
    case "book":
      return `/book?book=${encodeURIComponent(ent.id)}`;
    case "partner": {
      const partnerId = str(m.partner_id) || ent.id.split(":")[0];
      return partnerId ? `/partners/${encodeURIComponent(partnerId)}` : "/partners";
    }
    case "quiz": {
      const sessionId = str(m.session_id) || ent.id.split(":")[0];
      return sessionId
        ? `/home/${encodeURIComponent(sessionId)}`
        : "/question-notebook";
    }
    case "kb":
      return `/knowledge?kb=${encodeURIComponent(ent.id)}`;
  }
}

function EntityRow({
  surface,
  ent,
  focused,
  pendingKind,
}: {
  surface: Surface;
  ent: MemoryEntity;
  focused: boolean;
  pendingKind: ChangeEntry["kind"] | null;
}) {
  const { t } = useTranslation();
  const url = entityDeepLink(surface, ent);
  const meta = SURFACE_META[surface];
  const Icon = meta.icon;
  const preview = shorten(ent.content ?? "", 220);

  const inner = (
    <>
      <span
        className={cn(
          "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded",
          focused
            ? "bg-primary-muted text-accent-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Icon size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          <span className="min-w-0 max-w-full truncate text-[13px] font-medium text-foreground">
            {ent.label || ent.id}
          </span>
          <span className="max-w-full break-all font-mono text-muted-foreground">
            {ent.id}
          </span>
          {ent.ts && <span>{formatTimestamp(ent.ts)}</span>}
          {pendingKind && <PendingBadge kind={pendingKind} />}
        </div>
        {preview && (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {preview}
          </p>
        )}
      </div>
      {url && (
        <ExternalLink
          size={14}
          className="mt-1 shrink-0 text-muted-foreground group-hover:text-primary"
        />
      )}
    </>
  );

  const rowClass = cn(
    "group flex items-start gap-3 border-b border-border px-4 py-2.5 transition-colors duration-150 last:border-0",
    focused
      ? "border-l-[3px] border-l-primary bg-primary-muted"
      : pendingKind === "added"
        ? "border-l-[3px] border-l-success bg-success-muted hover:brightness-95"
        : pendingKind === "modified"
          ? "border-l-[3px] border-l-warning bg-warning-muted hover:brightness-95"
          : "border-l-[3px] border-l-transparent hover:bg-muted-subtle",
  );

  return (
    <li
      data-entity-ref={`${surface}:${ent.id}`}
      title={t("Open in {{label}}", { label: t(meta.label) })}
    >
      {url ? (
        <Link href={url} className={rowClass}>
          {inner}
        </Link>
      ) : (
        <div className={rowClass}>{inner}</div>
      )}
    </li>
  );
}

function PendingBadge({ kind }: { kind: ChangeEntry["kind"] }) {
  const { t } = useTranslation();
  const map = {
    added: { label: t("new"), variant: "success" as const },
    modified: { label: t("modified"), variant: "warning" as const },
    removed: { label: t("removed"), variant: "destructive" as const },
  };
  const cfg = map[kind];
  return (
    <Tooltip content={t("Pending — not yet committed to changes log")}>
      <Badge variant={cfg.variant} className="px-1.5 py-0 text-[10px]">
        {cfg.label}
      </Badge>
    </Tooltip>
  );
}

// ── Changes list (git-log style) ─────────────────────────────────────

function ChangesList({
  loading,
  changes,
  pending,
}: {
  loading: boolean;
  changes: ChangeEntry[];
  pending: ChangeEntry[];
}) {
  const { t } = useTranslation();
  if (loading && changes.length === 0 && pending.length === 0) {
    return (
      <Card className="p-4">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </Card>
    );
  }
  if (changes.length === 0 && pending.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={GitCommit}
          title={t("No changes recorded yet")}
          description={t("Run Refresh to capture the baseline.")}
        />
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      {pending.length > 0 && (
        <Card className="overflow-hidden border-warning-border">
          <div className="flex items-center justify-between border-b border-warning-border bg-warning-muted px-4 py-1.5 text-[11px] font-medium text-warning-foreground">
            <span>
              {t("Pending — {{n}} change(s) since last refresh", {
                n: pending.length,
              })}
            </span>
            <span className="opacity-70">{t("Click Refresh to commit")}</span>
          </div>
          <ol>
            {pending.map((c, i) => (
              <ChangeRow key={`pending-${c.entity_id}-${i}`} c={c} />
            ))}
          </ol>
        </Card>
      )}
      {changes.length > 0 && (
        <Card className="overflow-hidden">
          <ol>
            {changes.map((c, i) => (
              <ChangeRow key={`${c.ts}-${c.entity_id}-${i}`} c={c} />
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

function ChangeRow({ c }: { c: ChangeEntry }) {
  return (
    <li className="flex items-start gap-3 border-b border-border px-4 py-2 last:border-0">
      <ChangeGlyph kind={c.kind} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">
            {c.label || c.entity_id}
          </span>
          <span className="max-w-full break-all font-mono text-muted-foreground">
            {c.entity_id}
          </span>
          <span>{formatTimestamp(c.ts)}</span>
        </div>
      </div>
    </li>
  );
}

function ChangeGlyph({ kind }: { kind: ChangeEntry["kind"] }) {
  const map = {
    added: { ch: "+", cls: "bg-success/15 text-success" },
    modified: { ch: "~", cls: "bg-warning/15 text-warning" },
    removed: { ch: "−", cls: "bg-destructive/15 text-destructive" },
  } as const;
  const cfg = map[kind];
  return (
    <span
      className={cn(
        "mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-xs font-bold",
        cfg.cls,
      )}
    >
      {cfg.ch}
    </span>
  );
}

// ── KB query trace ───────────────────────────────────────────────────

function KbQueriesList({
  loading,
  queries,
}: {
  loading: boolean;
  queries: KbQueryEvent[];
}) {
  const { t } = useTranslation();
  if (loading && queries.length === 0) {
    return (
      <Card className="p-4">
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </Card>
    );
  }
  if (queries.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={Search}
          title={t("No RAG queries recorded yet")}
          description={t(
            "Knowledge-base lookups from chat appear here once the RAG tool runs.",
          )}
        />
      </Card>
    );
  }
  return (
    <Card className="overflow-hidden">
      <ol>
        {queries.map((q) => {
          const kb =
            typeof q.payload?.kb_name === "string" ? q.payload.kb_name : "?";
          const query =
            typeof q.payload?.query === "string" ? q.payload.query : "";
          return (
            <li
              key={q.id}
              className="flex items-start gap-3 border-b border-border px-4 py-2 last:border-0"
            >
              <GitCommit
                size={14}
                className="mt-0.5 shrink-0 text-muted-foreground"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{kb}</span>
                  <span>{formatTimestamp(q.ts)}</span>
                </div>
                <p className="mt-0.5 truncate text-[13px] text-foreground">
                  {query}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
