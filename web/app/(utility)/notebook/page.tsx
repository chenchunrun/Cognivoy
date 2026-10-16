"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog, useToast } from "@/components/ui";
import {
  createNotebook,
  deleteNotebook,
  deleteNotebookRecord,
  listNotebookRecords,
  listNotebooks,
  updateNotebook,
  importNotebookMarkdown,
  type NotebookDetail,
  type NotebookRecordItem,
  type NotebookSummary,
} from "@/lib/notebook-api";
import { NotebookFormDialog } from "@/components/notebook/NotebookFormDialog";
import { NotebookList } from "@/components/notebook/NotebookList";
import { NotebookRecords } from "@/components/notebook/NotebookRecords";
import { RecordFormDialog } from "@/components/notebook/RecordFormDialog";
import { MarkdownImportDialog, type MarkdownImportValues } from "@/components/notebook/MarkdownImportDialog";
import {
  addNotebookRecord,
  NotebookRevisionConflictError,
  updateNotebookRecord,
} from "@/components/notebook/record-api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function NotebookPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [notebooks, setNotebooks] = React.useState<NotebookSummary[]>([]);
  const [listLoading, setListLoading] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<NotebookDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [recordTotal, setRecordTotal] = React.useState(0);
  const [recordPage, setRecordPage] = React.useState(0);
  const [recordQuery, setRecordQuery] = React.useState("");

  const [formOpen, setFormOpen] = React.useState(false);
  const [formTarget, setFormTarget] = React.useState<NotebookSummary | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = React.useState<NotebookSummary | null>(
    null,
  );
  const [deleting, setDeleting] = React.useState(false);

  const [recordFormOpen, setRecordFormOpen] = React.useState(false);
  const [recordFormTarget, setRecordFormTarget] =
    React.useState<NotebookRecordItem | null>(null);
  const [recordDeleteTarget, setRecordDeleteTarget] =
    React.useState<NotebookRecordItem | null>(null);
  const [recordDeleting, setRecordDeleting] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [pendingReplace, setPendingReplace] = React.useState<MarkdownImportValues | null>(null);
  const [importing, setImporting] = React.useState(false);

  const loadDetail = React.useCallback(
    async (notebookId: string) => {
      setDetailLoading(true);
      try {
        const result = await listNotebookRecords(notebookId, {
          q: recordQuery,
          limit: 50,
          offset: recordPage * 50,
        });
        setDetail({ ...result.notebook, records: result.items });
        setRecordTotal(result.total);
      } catch (error) {
        setDetail(null);
        toast({
          variant: "destructive",
          title: t("Failed to load notebook"),
          description: errorMessage(error),
        });
      } finally {
        setDetailLoading(false);
      }
    },
    [recordPage, recordQuery, t, toast],
  );

  const loadList = React.useCallback(async () => {
    setListLoading(true);
    try {
      const list = await listNotebooks();
      setNotebooks(list);
      setSelectedId((current) => {
        if (current && list.some((n) => n.id === current)) return current;
        return list[0]?.id ?? null;
      });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to load notebooks"),
        description: errorMessage(error),
      });
    } finally {
      setListLoading(false);
    }
  }, [t, toast]);

  React.useEffect(() => {
    void loadList();
  }, [loadList]);

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setRecordTotal(0);
      return;
    }
    const handle = window.setTimeout(
      () => void loadDetail(selectedId),
      recordQuery ? 200 : 0,
    );
    return () => window.clearTimeout(handle);
  }, [selectedId, loadDetail, recordQuery]);

  const handleFormSubmit = async (values: {
    name: string;
    description: string;
  }) => {
    try {
      if (formTarget) {
        await updateNotebook(formTarget.id, values);
        toast({ variant: "success", title: t("Notebook updated") });
      } else {
        const created = await createNotebook(values);
        toast({ variant: "success", title: t("Notebook created") });
        setSelectedId(created.id);
      }
      await loadList();
      if (formTarget && selectedId === formTarget.id) {
        await loadDetail(formTarget.id);
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: formTarget
          ? t("Failed to update notebook")
          : t("Failed to create notebook"),
        description: errorMessage(error),
      });
      throw error;
    }
  };

  const handleDeleteNotebook = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteNotebook(deleteTarget.id);
      toast({ variant: "success", title: t("Notebook deleted") });
      setDeleteTarget(null);
      await loadList();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete notebook"),
        description: errorMessage(error),
      });
    } finally {
      setDeleting(false);
    }
  };

  const handleRecordFormSubmit = async (values: {
    title: string;
    userQuery: string;
    output: string;
    tags: string[];
  }) => {
    if (!selectedId) return;
    try {
      if (recordFormTarget) {
        await updateNotebookRecord(selectedId, recordFormTarget.id, {
          title: values.title,
          user_query: values.userQuery,
          output: values.output,
          tags: values.tags,
          expected_revision: recordFormTarget.revision ?? 1,
        });
        toast({ variant: "success", title: t("Record updated") });
      } else {
        await addNotebookRecord({
          notebookId: selectedId,
          title: values.title,
          userQuery: values.userQuery,
          output: values.output,
          tags: values.tags,
        });
        toast({ variant: "success", title: t("Record added") });
      }
      await loadDetail(selectedId);
      void loadList();
    } catch (error) {
      if (error instanceof NotebookRevisionConflictError) {
        setRecordFormTarget(error.current);
        setDetail((current) => current ? {
          ...current,
          records: current.records.map((record) =>
            record.id === error.current.id ? error.current : record,
          ),
        } : current);
        toast({
          variant: "destructive",
          title: t("Record changed in another session"),
          description: t("The latest version has been loaded. Review it before saving again."),
        });
        throw error;
      }
      toast({
        variant: "destructive",
        title: recordFormTarget
          ? t("Failed to update record")
          : t("Failed to add record"),
        description: errorMessage(error),
      });
      throw error;
    }
  };

  const executeImport = async (values: MarkdownImportValues) => {
    if (!selectedId) return;
    setImporting(true);
    try {
      const result = await importNotebookMarkdown(selectedId, {
        content: values.content,
        mode: values.mode,
        title: values.title,
        idempotency_key: values.idempotencyKey,
      });
      toast({
        variant: "success",
        title: t("Markdown imported"),
        description: t("Imported {{count}} records.", { count: result.imported_count }),
      });
      setPendingReplace(null);
      await loadDetail(selectedId);
      void loadList();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to import Markdown"),
        description: errorMessage(error),
      });
      throw error;
    } finally {
      setImporting(false);
    }
  };

  const handleImport = async (values: MarkdownImportValues) => {
    if (values.mode === "replace") {
      setPendingReplace(values);
      return;
    }
    await executeImport(values);
  };

  const handleDeleteRecord = async () => {
    if (!recordDeleteTarget || !selectedId) return;
    setRecordDeleting(true);
    try {
      await deleteNotebookRecord(selectedId, recordDeleteTarget.id);
      toast({ variant: "success", title: t("Record deleted") });
      setRecordDeleteTarget(null);
      await loadDetail(selectedId);
      void loadList();
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Failed to delete record"),
        description: errorMessage(error),
      });
    } finally {
      setRecordDeleting(false);
    }
  };

  return (
    <div className="mx-auto min-w-0 max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <h1 className="display text-2xl font-semibold text-foreground">
          {t("Notebooks")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t(
            "Save and organize outputs from chat, research, and Co-Writer sessions.",
          )}
        </p>
      </header>

      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <NotebookList
          notebooks={notebooks}
          loading={listLoading}
          selectedId={selectedId}
          onSelect={(notebookId) => {
            setRecordPage(0);
            setRecordQuery("");
            setSelectedId(notebookId);
          }}
          onCreate={() => {
            setFormTarget(null);
            setFormOpen(true);
          }}
          onRename={(notebook) => {
            setFormTarget(notebook);
            setFormOpen(true);
          }}
          onDelete={setDeleteTarget}
        />
        <NotebookRecords
          notebook={detail}
          loading={detailLoading}
          total={recordTotal}
          page={recordPage}
          query={recordQuery}
          onPageChange={setRecordPage}
          onQueryChange={(value) => {
            setRecordPage(0);
            setRecordQuery(value);
          }}
          onAddRecord={() => {
            setRecordFormTarget(null);
            setRecordFormOpen(true);
          }}
          onImportMarkdown={() => setImportOpen(true)}
          onEditRecord={(record) => {
            setRecordFormTarget(record);
            setRecordFormOpen(true);
          }}
          onDeleteRecord={setRecordDeleteTarget}
        />
      </div>

      <NotebookFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        notebook={formTarget}
        onSubmit={handleFormSubmit}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => void handleDeleteNotebook()}
        title={t("Delete notebook")}
        description={t(
          'Delete "{{name}}" and all of its records? This cannot be undone.',
          { name: deleteTarget?.name ?? "" },
        )}
        confirmText={t("Delete")}
        destructive
        loading={deleting}
      />
      <RecordFormDialog
        open={recordFormOpen}
        onClose={() => setRecordFormOpen(false)}
        record={recordFormTarget}
        onSubmit={handleRecordFormSubmit}
      />
      <MarkdownImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onSubmit={handleImport}
      />
      <ConfirmDialog
        open={pendingReplace !== null}
        onClose={() => setPendingReplace(null)}
        onConfirm={() => {
          if (pendingReplace) {
            void executeImport(pendingReplace).catch(() => undefined);
          }
        }}
        title={t("Replace all notebook records?")}
        description={t("Every current record in this notebook will be replaced by the imported Markdown. This cannot be undone.")}
        confirmText={t("Replace records")}
        destructive
        loading={importing}
      />
      <ConfirmDialog
        open={Boolean(recordDeleteTarget)}
        onClose={() => setRecordDeleteTarget(null)}
        onConfirm={() => void handleDeleteRecord()}
        title={t("Delete record")}
        description={t(
          'Delete the record "{{name}}"? This cannot be undone.',
          { name: recordDeleteTarget?.title ?? "" },
        )}
        confirmText={t("Delete")}
        destructive
        loading={recordDeleting}
      />
    </div>
  );
}
