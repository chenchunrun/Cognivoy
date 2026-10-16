"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { GitCompareArrows, History, Merge, RefreshCw, Scale, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/ui";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  getMemoryConflictAudit,
  getMemoryConflicts,
  resolveMemoryConflict,
  type MemoryConflict,
  type MemoryConflictAction,
  type MemoryConflictAuditRecord,
  type MemoryConflictStatement,
} from "./api";
import { MemorySubNav } from "./MemorySubNav";

interface PendingResolution {
  conflict: MemoryConflict;
  action: Exclude<MemoryConflictAction, "merge">;
}

export function MemoryConflictWorkbench() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [conflicts, setConflicts] = useState<MemoryConflict[]>([]);
  const [audit, setAudit] = useState<MemoryConflictAuditRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingResolution | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [conflictResult, auditResult] = await Promise.all([
        getMemoryConflicts(),
        getMemoryConflictAudit(),
      ]);
      setConflicts(conflictResult.items);
      setAudit(auditResult.items);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load memory conflicts"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getMemoryConflicts(), getMemoryConflictAudit()])
      .then(([conflictResult, auditResult]) => {
        if (cancelled) return;
        setConflicts(conflictResult.items);
        setAudit(auditResult.items);
      })
      .catch((error) => {
        if (cancelled) return;
        toast({
          variant: "destructive",
          title: t("Failed to load memory conflicts"),
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  const resolve = useCallback(
    async (
      conflict: MemoryConflict,
      action: MemoryConflictAction,
      mergedText?: string,
      reason?: string,
    ) => {
      setResolving(conflict.id);
      try {
        await resolveMemoryConflict({
          conflict_id: conflict.id,
          layer: "L3",
          key: conflict.key,
          left_id: conflict.left.id,
          right_id: conflict.right.id,
          action,
          merged_text: mergedText,
          reason,
        });
        toast({ variant: "success", title: t("Memory conflict resolved") });
        setPending(null);
        await load();
      } catch (error) {
        toast({
          variant: "destructive",
          title: t("Failed to resolve memory conflict"),
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setResolving(null);
      }
    },
    [load, t, toast],
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <PageHeader
        title={t("Memory conflicts")}
        description={t(
          "Review distinct L3 statements that cite the same evidence. Cognivoy never resolves these silently.",
        )}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} loading={loading}>
            {!loading && <RefreshCw size={14} />}
            {t("Refresh")}
          </Button>
        }
      />
      <div className="mb-6">
        <MemorySubNav />
      </div>

      <div className="mb-5 rounded-xl border border-border bg-muted-subtle p-4 text-sm text-muted-foreground">
        <div className="flex items-start gap-2">
          <Scale size={18} className="mt-0.5 shrink-0 text-primary" />
          <p>
            {t(
              "Evidence coverage is not semantic certainty. It is the share of this statement's references that still resolve to L2 evidence.",
            )}
          </p>
        </div>
      </div>

      {loading && conflicts.length === 0 ? (
        <div className="space-y-4">
          {[0, 1].map((index) => (
            <Card key={index} className="space-y-4 p-5">
              <Skeleton className="h-4 w-48" />
              <div className="grid gap-4 md:grid-cols-2">
                <Skeleton className="h-40 w-full" />
                <Skeleton className="h-40 w-full" />
              </div>
            </Card>
          ))}
        </div>
      ) : conflicts.length === 0 ? (
        <EmptyState
          icon={GitCompareArrows}
          title={t("No memory conflicts")}
          description={t("Distinct L3 statements with shared evidence will appear here for review.")}
        />
      ) : (
        <div className="space-y-4" data-memory-conflicts="true">
          {conflicts.map((conflict) => (
            <ConflictCard
              key={conflict.id}
              conflict={conflict}
              resolving={resolving === conflict.id}
              onResolve={(action) => setPending({ conflict, action })}
              onMerge={(text, reason) => void resolve(conflict, "merge", text, reason)}
            />
          ))}
        </div>
      )}

      <section className="mt-8" aria-labelledby="memory-conflict-audit-heading">
        <div className="mb-3 flex items-center gap-2">
          <History size={17} className="text-primary" />
          <h2 id="memory-conflict-audit-heading" className="display text-lg font-semibold text-foreground">
            {t("Resolution audit")}
          </h2>
          <Badge variant="outline">{audit.length}</Badge>
        </div>
        {audit.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No conflict decisions recorded yet.")}</p>
        ) : (
          <div className="space-y-2" data-memory-conflict-audit="true">
            {[...audit].reverse().map((record) => (
              <Card key={record.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline">{t(actionLabel(record.action))}</Badge>
                  <span className="font-medium text-foreground">{record.key} · {record.section}</span>
                  <time className="text-xs text-muted-foreground" dateTime={record.resolved_at}>
                    {new Date(record.resolved_at).toLocaleString()}
                  </time>
                </div>
                {record.reason && <p className="mt-2 text-sm text-muted-foreground">{record.reason}</p>}
              </Card>
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) void resolve(pending.conflict, pending.action);
        }}
        title={t(pending?.action === "delete_both" ? "Delete both statements?" : "Apply this memory decision?")}
        description={t(
          "Discarded statements move to Recently deleted and can be restored from Memory settings.",
        )}
        confirmText={t(pending ? actionLabel(pending.action) : "Confirm")}
        destructive={pending?.action === "delete_both"}
        loading={Boolean(pending && resolving === pending.conflict.id)}
      />
    </div>
  );
}

function ConflictCard({
  conflict,
  resolving,
  onResolve,
  onMerge,
}: {
  conflict: MemoryConflict;
  resolving: boolean;
  onResolve: (action: Exclude<MemoryConflictAction, "merge">) => void;
  onMerge: (text: string, reason: string) => void;
}) {
  const { t } = useTranslation();
  const [merging, setMerging] = useState(false);
  const [mergedText, setMergedText] = useState("");
  const [reason, setReason] = useState("");

  return (
    <Card className="p-5" data-conflict-id={conflict.id}>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge variant="outline">L3 · {conflict.key}</Badge>
        <span className="text-sm font-medium text-foreground">{conflict.section}</span>
        <span className="text-xs text-muted-foreground">
          {t("{{count}} shared evidence", { count: conflict.shared_refs.length })}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <StatementCard side={t("Statement A")} statement={conflict.left} />
        <StatementCard side={t("Statement B")} statement={conflict.right} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => onResolve("keep_left")} disabled={resolving}>
          {t("Keep statement A")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onResolve("keep_right")} disabled={resolving}>
          {t("Keep statement B")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setMerging((value) => !value)} disabled={resolving}>
          <Merge size={14} />
          {t("Merge statements")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onResolve("delete_both")} disabled={resolving}>
          <Trash2 size={14} />
          {t("Delete both")}
        </Button>
      </div>

      {merging && (
        <div className="mt-4 space-y-3 rounded-xl border border-border bg-muted-subtle p-4">
          <label className="block text-sm font-medium text-foreground" htmlFor={`merge-${conflict.left.id}`}>
            {t("Reconciled statement")}
          </label>
          <Textarea
            id={`merge-${conflict.left.id}`}
            value={mergedText}
            onChange={(event) => setMergedText(event.target.value)}
            placeholder={t("Write the statement that should replace both observations…")}
            rows={3}
          />
          <label className="block text-sm font-medium text-foreground" htmlFor={`reason-${conflict.left.id}`}>
            {t("Decision note (optional)")}
          </label>
          <Textarea
            id={`reason-${conflict.left.id}`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("Record why this resolution was chosen…")}
            rows={2}
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setMerging(false)} disabled={resolving}>
              {t("Cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => onMerge(mergedText.trim(), reason.trim())}
              disabled={!mergedText.trim() || resolving}
              loading={resolving}
            >
              {t("Save merged statement")}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function StatementCard({ side, statement }: { side: string; statement: MemoryConflictStatement }) {
  const { t } = useTranslation();
  const percent = Math.round(statement.confidence * 100);
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{side}</span>
        <Badge variant="outline">{t("{{percent}}% evidence coverage", { percent })}</Badge>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{statement.text}</p>
      <div className="mt-4">
        <p className="text-xs text-muted-foreground">
          {t("{{valid}} of {{total}} references resolve", {
            valid: statement.valid_ref_count,
            total: statement.ref_count,
          })}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {statement.refs.map((reference) => (
            <Link
              key={reference}
              href={`/memory/resolve?id=${encodeURIComponent(reference)}`}
              className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-primary hover:bg-primary-muted"
            >
              {reference}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

function actionLabel(action: MemoryConflictAction): string {
  if (action === "keep_left") return "Keep statement A";
  if (action === "keep_right") return "Keep statement B";
  if (action === "merge") return "Merge statements";
  return "Delete both";
}
