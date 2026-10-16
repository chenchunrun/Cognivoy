"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Database,
  RefreshCw,
  RotateCcw,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  EmptyState,
  useToast,
} from "@/components/ui";
import {
  preflightKnowledgeUpload,
  type DuplicateUploadStrategy,
  type KnowledgeUploadPolicy,
  type UploadPreflightResult,
} from "@/lib/knowledge-api";
import {
  kbCanReindex,
  kbHasLiveProgress,
  kbIsUploadable,
  kbNeedsReindex,
  resolveKbStatus,
  resolveProgressPercent,
  type KnowledgeBase,
} from "@/lib/knowledge-helpers";
import {
  knowledgeErrorGuidance,
  persistedKnowledgeError,
} from "@/lib/knowledge-readiness";
import { FileDropZone } from "./file-drop-zone";
import { KbFileList } from "./kb-file-list";
import { KbIndexVersions } from "./kb-index-versions";
import { EngineBadge, KbStatusBadge } from "./kb-badges";
import type { TaskState } from "./use-knowledge-progress";

interface KbDetailProps {
  kb: KnowledgeBase | null;
  uploadPolicy: KnowledgeUploadPolicy;
  task?: TaskState;
  fileListRefreshKey: number;
  actionBusy: string | null;
  onUpload: (
    kbName: string,
    files: File[],
    provider?: string,
    duplicateStrategy?: DuplicateUploadStrategy,
  ) => Promise<unknown>;
  onReindex: (kbName: string) => void;
  onRetry: (kbName: string) => void;
  onCancelTask: (kbName: string) => void;
  onSetDefault: (kbName: string) => void;
  onDelete: (kb: KnowledgeBase) => void;
  onDismissTask: (kbName: string) => void;
  onCreate: () => void;
}

/** Right pane: status, live progress, upload zone, and the document list. */
export function KbDetail({
  kb,
  uploadPolicy,
  task,
  fileListRefreshKey,
  actionBusy,
  onUpload,
  onReindex,
  onRetry,
  onCancelTask,
  onSetDefault,
  onDelete,
  onDismissTask,
  onCreate,
}: KbDetailProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [duplicateReport, setDuplicateReport] =
    useState<UploadPreflightResult | null>(null);

  if (!kb) {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          icon={Database}
          title={t("Select a knowledge base")}
          description={t(
            "Pick one on the left, or create a new one to get started.",
          )}
          action={
            <Button size="sm" onClick={onCreate}>
              {t("Create knowledge base")}
            </Button>
          }
        />
      </div>
    );
  }

  const status = resolveKbStatus(kb);
  const live = kbHasLiveProgress(kb) || task?.executing === true;
  const percent = resolveProgressPercent(kb.progress);
  const progressMessage = kb.progress?.message;
  const uploadable = kbIsUploadable(kb) && !live;
  const reindexable = kbCanReindex(kb) && !live;
  const lastError =
    task && !task.executing && task.error
      ? task.error
      : persistedKnowledgeError(kb);
  const errorGuidance = knowledgeErrorGuidance(lastError);
  const errorTimestamp = kb.metadata?.last_error_at || kb.progress?.timestamp;
  const displayedError =
    errorGuidance.code === "embedding"
      ? t("No active embedding model is configured. Configure one under Settings → Embedding.")
      : errorGuidance.code === "llm"
        ? t("No active chat model is configured. Configure one under Settings → LLM.")
        : lastError;

  const submitUpload = async (
    strategy: DuplicateUploadStrategy,
    files = pendingFiles,
  ) => {
    const selectedFiles =
      strategy === "skip" && duplicateReport
        ? files.filter((_, index) => {
            const result = duplicateReport.files[index];
            return !result?.path_exists && !result?.same_content_paths.length;
          })
        : files;
    setDuplicateReport(null);
    if (!selectedFiles.length) {
      setPendingFiles([]);
      toast({ title: t("All selected files were already present and were skipped.") });
      return;
    }
    await onUpload(kb.name, selectedFiles, undefined, strategy);
    setPendingFiles([]);
  };

  const handleUpload = async () => {
    if (!pendingFiles.length || uploading) return;
    setUploading(true);
    try {
      const report = await preflightKnowledgeUpload(kb.name, pendingFiles);
      if (report.has_duplicates) {
        setDuplicateReport(report);
      } else {
        await submitUpload("error");
      }
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("Failed to upload files"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  };

  const handleDuplicateStrategy = async (strategy: DuplicateUploadStrategy) => {
    if (uploading) return;
    setUploading(true);
    try {
      await submitUpload(strategy);
    } catch (err) {
      toast({
        variant: "destructive",
        title: t("Failed to upload files"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="display truncate text-lg font-medium text-foreground">
              {kb.name}
            </h2>
            {kb.is_default && (
              <Star
                size={14}
                aria-label={t("Default knowledge base")}
                className="shrink-0 fill-primary text-primary"
              />
            )}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <EngineBadge kb={kb} />
            <KbStatusBadge kb={kb} />
            {kb.metadata?.vault_path && (
              <span className="truncate font-mono text-[11px] text-muted-foreground">
                {kb.metadata.vault_path}
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!kb.is_default && (
            <Button
              variant="outline"
              size="sm"
              loading={actionBusy === "default"}
              disabled={live}
              onClick={() => onSetDefault(kb.name)}
            >
              <Star size={13} aria-hidden="true" />
              {t("Set as default")}
            </Button>
          )}
          {(status === "error" || status === "cancelled") && (
            <Button
              variant="outline"
              size="sm"
              loading={actionBusy === "retry"}
              disabled={live}
              onClick={() => onRetry(kb.name)}
            >
              <RotateCcw size={13} aria-hidden="true" />
              {t("Retry")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            loading={actionBusy === "reindex"}
            disabled={!reindexable && status !== "error"}
            onClick={() => onReindex(kb.name)}
          >
            <RefreshCw size={13} aria-hidden="true" />
            {t("Re-index")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => onDelete(kb)}
          >
            <Trash2 size={13} aria-hidden="true" />
            {t("Delete")}
          </Button>
        </div>
      </div>

      {kbNeedsReindex(kb) && !live && (
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          <AlertTriangle size={13} className="shrink-0" />
          {t(
            "The index is out of date with the source documents. Re-index to refresh it.",
          )}
        </div>
      )}

      {/* Live progress */}
      {live && (
        <div className="surface p-3">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate text-foreground">
              {progressMessage || task?.label || t("Working...")}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {percent}%
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-150"
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
          {(task?.executing || kb.progress?.task_id) && (
            <div className="mt-3 flex justify-end">
              <Button
                variant="outline"
                size="sm"
                loading={actionBusy === "cancel"}
                disabled={actionBusy === "cancel"}
                onClick={() => onCancelTask(kb.name)}
              >
                <Square size={12} aria-hidden="true" />
                {t("Stop indexing")}
              </Button>
            </div>
          )}
        </div>
      )}

      {task && !task.executing && task.cancelled && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          <span>{t("Indexing was cancelled. You can retry when ready.")}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => onDismissTask(kb.name)}
            aria-label={t("Dismiss")}
          >
            <X size={13} aria-hidden="true" />
          </Button>
        </div>
      )}

      {/* Persisted task error: survives refresh and remains actionable. */}
      {!live && lastError && (
        <div className="rounded-lg border border-destructive bg-card px-3 py-2 text-xs text-destructive">
          <div className="flex items-start justify-between gap-2">
            <span className="flex items-center gap-1.5 font-medium">
              <AlertTriangle size={13} className="shrink-0" />
              {t("The last task failed")}
            </span>
            {task?.error && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 shrink-0"
                onClick={() => onDismissTask(kb.name)}
                aria-label={t("Dismiss")}
              >
                <X size={13} aria-hidden="true" />
              </Button>
            )}
          </div>
          <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
            {displayedError}
          </pre>
          {(errorTimestamp || kb.progress?.task_id) && (
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              {errorTimestamp && (
                <span>{t("Failed at {{time}}", { time: new Date(errorTimestamp).toLocaleString() })}</span>
              )}
              {kb.progress?.task_id && (
                <span className="font-mono">{kb.progress.task_id}</span>
              )}
            </div>
          )}
          {errorGuidance.settingsPath && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Link
                href={errorGuidance.settingsPath}
                className="inline-flex min-h-8 items-center rounded-lg border border-border bg-background px-3 font-medium text-foreground hover:bg-muted"
              >
                {errorGuidance.code === "embedding"
                  ? t("Open embedding settings")
                  : t("Open LLM settings")}
              </Link>
              <span className="text-muted-foreground">
                {t("Complete the setup, then return and retry indexing.")}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Upload */}
      {uploadable && (
        <div className="space-y-2">
          <FileDropZone
            files={pendingFiles}
            onChange={setPendingFiles}
            uploadPolicy={uploadPolicy}
            disabled={uploading}
            compact
          />
          {pendingFiles.length > 0 && (
            <div className="flex justify-end">
              <Button
                size="sm"
                loading={uploading}
                onClick={() => void handleUpload()}
              >
                {t("Upload {{count}} files", { count: pendingFiles.length })}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Documents */}
      <KbIndexVersions kb={kb} />

      <div className="min-h-0 flex-1">
        <KbFileList kb={kb} refreshKey={fileListRefreshKey} />
      </div>

      <Dialog open={duplicateReport !== null} onClose={() => setDuplicateReport(null)}>
        <DialogTitle>{t("Duplicate files detected")}</DialogTitle>
        <DialogDescription>
          {t("Choose how Cognivoy should handle files that already exist or have identical content.")}
        </DialogDescription>
        <ul className="mt-4 max-h-48 space-y-2 overflow-y-auto rounded-lg border border-border p-3 text-xs">
          {duplicateReport?.files
            .filter((file) => file.path_exists || file.same_content_paths.length)
            .map((file) => (
              <li key={file.relative_path} className="text-muted-foreground">
                <span className="font-medium text-foreground">{file.relative_path}</span>
                {file.path_exists ? ` · ${t("same path")}` : ""}
                {file.same_content_paths.length
                  ? ` · ${t("same content as {{path}}", { path: file.same_content_paths.join(", ") })}`
                  : ""}
              </li>
            ))}
        </ul>
        <DialogFooter className="flex-wrap">
          <Button variant="ghost" onClick={() => setDuplicateReport(null)}>
            {t("Cancel")}
          </Button>
          <Button variant="outline" loading={uploading} onClick={() => void handleDuplicateStrategy("skip")}>
            {t("Skip duplicates")}
          </Button>
          <Button variant="outline" disabled={uploading} onClick={() => void handleDuplicateStrategy("rename")}>
            {t("Keep both")}
          </Button>
          <Button disabled={uploading} onClick={() => void handleDuplicateStrategy("replace")}>
            {t("Replace existing")}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
