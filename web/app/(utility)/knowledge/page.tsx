"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslation } from "react-i18next";
import { Database, Plus, Square } from "lucide-react";
import { Button, ConfirmDialog, EmptyState, Skeleton, useToast } from "@/components/ui";
import { kbHasLiveProgress, type KnowledgeBase } from "@/lib/knowledge-helpers";
import { useKnowledgeBases } from "@/components/knowledge/use-knowledge-bases";
import { KbList } from "@/components/knowledge/kb-list";
import { KbDetail } from "@/components/knowledge/kb-detail";
import { CreateKbDialog } from "@/components/knowledge/create-kb-dialog";
import { KnowledgeEngineOverview } from "@/components/knowledge/engine-overview";
import { PageHeader } from "@/components/shell/PageHeader";
import {
  getKnowledgeDeletionImpact,
  type KnowledgeDeletionImpact,
} from "@/lib/knowledge-api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function KnowledgePageContent() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialKb = searchParams.get("kb");

  const {
    kbs: allKbs,
    providers,
    uploadPolicy,
    loading,
    error,
    setError,
    tasksByKb,
    dismissTask,
    createKb,
    uploadFiles,
    setDefault,
    reindex,
    retry,
    cancelTask,
    deleteKb,
    connectObsidian,
    connectLinkedFolder,
    connectLightRagServer,
    connectIma,
  } = useKnowledgeBases();

  // Connected subagents are stored as ``type: subagent`` KBs so the chat
  // composer can select them, but they are agents, not knowledge bases.
  const kbs = React.useMemo(
    () => allKbs.filter((kb) => kb.metadata?.type !== "subagent"),
    [allKbs],
  );

  const [explicitSelection, setExplicitSelection] = React.useState<
    string | null
  >(initialKb);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createProvider, setCreateProvider] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<KnowledgeBase | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState(false);
  const [deleteImpact, setDeleteImpact] = React.useState<KnowledgeDeletionImpact | null>(null);
  const [deleteImpactError, setDeleteImpactError] = React.useState<string | null>(null);
  const [deleteImpactLoading, setDeleteImpactLoading] = React.useState(false);
  const [actionBusy, setActionBusy] = React.useState<string | null>(null);
  const [fileListRefreshKey, setFileListRefreshKey] = React.useState(0);
  const activeKbNames = React.useMemo(
    () =>
      kbs
        .filter((kb) => tasksByKb[kb.name]?.executing || kbHasLiveProgress(kb))
        .map((kb) => kb.name),
    [kbs, tasksByKb],
  );

  // Surface load failures as toasts.
  React.useEffect(() => {
    if (!error) return;
    toast({ variant: "destructive", title: t("Failed to load"), description: error });
    setError(null);
  }, [error, setError, t, toast]);

  // Derive the effective selection: respect the user's pick if it still
  // exists, otherwise fall back to the default KB (or the first one).
  const selectedKbName = React.useMemo<string | null>(() => {
    if (explicitSelection && kbs.some((kb) => kb.name === explicitSelection)) {
      return explicitSelection;
    }
    if (!kbs.length) return null;
    return kbs.find((kb) => kb.is_default)?.name ?? kbs[0].name;
  }, [explicitSelection, kbs]);

  const selectedKb = React.useMemo(
    () => kbs.find((kb) => kb.name === selectedKbName) ?? null,
    [kbs, selectedKbName],
  );

  // Keep ?kb in sync with the effective selection so deep links work.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (searchParams.get("kb") === selectedKbName) return;
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (selectedKbName) params.set("kb", selectedKbName);
    else params.delete("kb");
    const search = params.toString();
    router.replace(search ? `?${search}` : "?", { scroll: false });
  }, [router, searchParams, selectedKbName]);

  // Bump the file list when the selected KB's task settles so newly indexed
  // files appear automatically.
  const selectedTask = selectedKb ? tasksByKb[selectedKb.name] : undefined;
  const taskExecuting = selectedTask?.executing === true;
  const wasExecutingRef = React.useRef(false);
  React.useEffect(() => {
    if (wasExecutingRef.current && !taskExecuting) {
      setFileListRefreshKey((n) => n + 1);
    }
    wasExecutingRef.current = taskExecuting;
  }, [taskExecuting]);

  const runAction = React.useCallback(
    async (kind: string, action: () => Promise<unknown>, failure: string) => {
      setActionBusy(kind);
      try {
        await action();
      } catch (err) {
        toast({
          variant: "destructive",
          title: failure,
          description: errorMessage(err),
        });
      } finally {
        setActionBusy(null);
      }
    },
    [toast],
  );

  const handleCreate = React.useCallback(
    async (params: { name: string; provider: string; files: File[] }) => {
      await createKb(params);
      toast({ variant: "success", title: t("Knowledge base created") });
      setExplicitSelection(params.name);
    },
    [createKb, t, toast],
  );

  const openCreate = React.useCallback((provider?: string) => {
    setCreateProvider(provider ?? null);
    setCreateOpen(true);
  }, []);

  const requestDelete = React.useCallback((kb: KnowledgeBase) => {
    setDeleteImpact(null);
    setDeleteImpactError(null);
    setDeleteImpactLoading(true);
    setDeleteTarget(kb);
  }, []);

  const withConnectedToast = React.useCallback(
    async (action: () => Promise<unknown>) => {
      await action();
      toast({ variant: "success", title: t("Source connected") });
    },
    [t, toast],
  );

  const handleDelete = async () => {
    if (!deleteTarget || !deleteImpact) return;
    setDeleting(true);
    try {
      await deleteKb(deleteTarget.name, deleteImpact.confirmation_token);
      toast({ variant: "success", title: t("Knowledge base deleted") });
      if (explicitSelection === deleteTarget.name) setExplicitSelection(null);
      setDeleteTarget(null);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("Failed to delete knowledge base"),
        description: errorMessage(err),
      });
    } finally {
      setDeleting(false);
    }
  };

  React.useEffect(() => {
    if (!deleteTarget) return;
    let cancelled = false;
    void getKnowledgeDeletionImpact(deleteTarget.name)
      .then((impact) => {
        if (!cancelled) setDeleteImpact(impact);
      })
      .catch((error) => {
        if (!cancelled) setDeleteImpactError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setDeleteImpactLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deleteTarget]);

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col px-6 py-8">
      <PageHeader
        title={t("Knowledge")}
        description={t(
          "Index your documents so answers can be grounded in your own sources.",
        )}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {activeKbNames.length > 1 && (
              <Button
                variant="outline"
                loading={actionBusy === "cancel-all"}
                onClick={() =>
                  void runAction(
                    "cancel-all",
                    async () => {
                      const results = await Promise.allSettled(
                        activeKbNames.map((name) => cancelTask(name)),
                      );
                      const failed = results.filter((result) => result.status === "rejected");
                      if (failed.length) {
                        throw new Error(t("{{count}} indexing tasks could not be stopped.", { count: failed.length }));
                      }
                    },
                    t("Failed to stop indexing tasks"),
                  )
                }
              >
                <Square size={14} aria-hidden="true" />
                {t("Stop all indexing ({{count}})", { count: activeKbNames.length })}
              </Button>
            )}
            <Button onClick={() => openCreate()}>
              <Plus size={15} aria-hidden="true" />
              {t("Create knowledge base")}
            </Button>
          </div>
        }
      />

      {!loading ? (
        <details data-testid="advanced-engine-overview" className="mb-7 rounded-xl border border-border bg-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            {t("Advanced retrieval engines")}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {t("Choose this only when you need a specific indexing strategy.")}
            </span>
          </summary>
          <div className="pt-4">
            <KnowledgeEngineOverview
              providers={providers}
              knowledgeBases={kbs}
              onCreate={openCreate}
            />
          </div>
        </details>
      ) : null}

      {loading ? (
        <div className="grid min-h-0 flex-1 items-start gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-20 w-full rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : kbs.length === 0 ? (
        <div className="surface flex min-h-[360px] flex-1 items-center justify-center border-dashed">
          <EmptyState
            icon={Database}
            title={t("Learn from your own materials")}
            description={t(
              "Upload a textbook, notes, slides, or other documents. Cognivoy will index them so answers can cite the original source.",
            )}
            action={
              <Button onClick={() => openCreate()}>
                <Plus size={15} aria-hidden="true" />
                {t("Upload your first source")}
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 items-stretch gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          <KbList
            kbs={kbs}
            loading={false}
            selectedName={selectedKbName}
            onSelect={setExplicitSelection}
            onCreate={() => openCreate()}
            onSetDefault={(name) =>
              void runAction(
                "default",
                () => setDefault(name),
                t("Failed to set default"),
              )
            }
            onDelete={requestDelete}
          />
          <div className="min-h-0 overflow-y-auto pr-1">
            <KbDetail
              kb={selectedKb}
              uploadPolicy={uploadPolicy}
              task={selectedTask}
              fileListRefreshKey={fileListRefreshKey}
              actionBusy={actionBusy}
              onUpload={uploadFiles}
              onReindex={(name) =>
                void runAction(
                  "reindex",
                  () => reindex(name),
                  t("Failed to re-index"),
                )
              }
              onRetry={(name) =>
                void runAction("retry", () => retry(name), t("Retry failed"))
              }
              onCancelTask={(name) =>
                void runAction(
                  "cancel",
                  () => cancelTask(name),
                  t("Failed to stop indexing"),
                )
              }
              onSetDefault={(name) =>
                void runAction(
                  "default",
                  () => setDefault(name),
                  t("Failed to set default"),
                )
              }
              onDelete={requestDelete}
              onDismissTask={dismissTask}
              onCreate={() => openCreate()}
            />
          </div>
        </div>
      )}

      <CreateKbDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        providers={providers}
        initialProvider={createProvider}
        uploadPolicy={uploadPolicy}
        onCreate={handleCreate}
        onConnectLinkedFolder={(params) =>
          withConnectedToast(() => connectLinkedFolder(params))
        }
        onConnectObsidian={(params) =>
          withConnectedToast(() => connectObsidian(params))
        }
        onConnectLightRagServer={(params) =>
          withConnectedToast(() => connectLightRagServer(params))
        }
        onConnectIma={(params) =>
          withConnectedToast(() => connectIma(params))
        }
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete knowledge base")}
        description={t(
          'Delete "{{name}}" and its index? This cannot be undone.',
          { name: deleteTarget?.name ?? "" },
        )}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
        confirmDisabled={deleteImpactLoading || !deleteImpact}
      >
        <div className="mt-4 rounded-xl border border-border bg-muted-subtle p-4 text-sm">
          {deleteImpactLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Skeleton className="h-4 w-4 rounded-full" />
              {t("Checking where this knowledge base is used…")}
            </div>
          ) : deleteImpactError ? (
            <p className="text-destructive">
              {t("Impact analysis failed: {{message}}", { message: deleteImpactError })}
            </p>
          ) : deleteImpact ? (
            <div className="space-y-2">
              <p className="font-medium text-foreground">
                {deleteImpact.total_references > 0
                  ? t("This knowledge base is still referenced in {{count}} places.", {
                      count: deleteImpact.total_references,
                    })
                  : t("No saved references were found.")}
              </p>
              <ul className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <li>{t("{{count}} sessions", { count: deleteImpact.counts.sessions })}</li>
                <li>{t("{{count}} notebook records", { count: deleteImpact.counts.notebook_records })}</li>
                <li>{t("{{count}} workspace files", { count: deleteImpact.counts.workspace_files })}</li>
              </ul>
              {deleteImpact.total_references > 0 ? (
                <p className="text-xs text-warning">
                  {t("Existing records will be kept and marked as referencing a deleted source.")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}

export default function KnowledgePage() {
  return (
    <React.Suspense
      fallback={
        <div className="mx-auto max-w-7xl px-6 py-8">
          <Skeleton className="h-8 w-48 rounded-lg" />
          <Skeleton className="mt-2 h-4 w-72 rounded-lg" />
          <Skeleton className="mt-8 h-64 w-full rounded-xl" />
        </div>
      }
    >
      <KnowledgePageContent />
    </React.Suspense>
  );
}
