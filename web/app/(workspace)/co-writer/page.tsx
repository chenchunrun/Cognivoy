"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import {
  FileText,
  LayoutTemplate,
  MoreHorizontal,
  PenLine,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Dropdown,
  DropdownItem,
  DropdownSeparator,
  EmptyState,
  Input,
  Skeleton,
  useToast,
} from "@/components/ui";
import {
  createCoWriterDocument,
  deleteCoWriterDocument,
  listCoWriterDocuments,
  updateCoWriterDocument,
  type CoWriterDocumentSummary,
} from "@/lib/co-writer-api";
import {
  CO_WRITER_TEMPLATES,
  coWriterTemplateLocale,
} from "@/lib/co-writer-templates";
import { notifyCoWriterChanged } from "@/lib/co-writer-events";
import { formatRelativeTime } from "@/lib/relative-time";
import { PageHeader } from "@/components/shell/PageHeader";

export default function CoWriterPage() {
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();

  const [documents, setDocuments] = useState<CoWriterDocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createTitle, setCreateTitle] = useState("");
  const [createTemplateId, setCreateTemplateId] = useState<string>("");
  const [creating, setCreating] = useState(false);
  const templateLocale = coWriterTemplateLocale(i18n.language);

  const [renameDoc, setRenameDoc] = useState<CoWriterDocumentSummary | null>(
    null,
  );
  const [renameTitle, setRenameTitle] = useState("");
  const [renaming, setRenaming] = useState(false);

  const [deleteDoc, setDeleteDoc] = useState<CoWriterDocumentSummary | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);

  const showError = useCallback(
    (err: unknown, fallback: string) => {
      toast({
        title: fallback,
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    },
    [toast],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const docs = await listCoWriterDocuments();
      setDocuments(docs);
    } catch (err) {
      showError(err, t("Failed to load documents."));
    } finally {
      setLoading(false);
    }
  }, [showError, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openCreateDialog = useCallback((withTemplates = false) => {
    const template = withTemplates ? CO_WRITER_TEMPLATES[0] : null;
    const locale = coWriterTemplateLocale(i18n.language);
    setCreateTemplateId(template?.id ?? "");
    setCreateTitle(template?.defaultTitle[locale] ?? "");
    setCreateOpen(true);
  }, [i18n.language]);

  const selectTemplate = useCallback((templateId: string) => {
    const template = CO_WRITER_TEMPLATES.find((item) => item.id === templateId);
    const locale = coWriterTemplateLocale(i18n.language);
    setCreateTemplateId(templateId);
    if (template) setCreateTitle(template.defaultTitle[locale]);
  }, [i18n.language]);

  const handleCreate = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const document = await createCoWriterDocument({
        title: createTitle.trim() || undefined,
        content: CO_WRITER_TEMPLATES.find((item) => item.id === createTemplateId)
          ?.content[coWriterTemplateLocale(i18n.language)] ?? "",
      });
      notifyCoWriterChanged();
      setCreateOpen(false);
      router.push(`/co-writer/${document.id}`);
    } catch (err) {
      showError(err, t("Failed to create document."));
      setCreating(false);
    }
  }, [creating, createTemplateId, createTitle, i18n.language, router, showError, t]);

  const openRenameDialog = useCallback((doc: CoWriterDocumentSummary) => {
    setRenameDoc(doc);
    setRenameTitle(doc.title);
  }, []);

  const handleRename = useCallback(async () => {
    if (!renameDoc || renaming) return;
    const next = renameTitle.trim();
    setRenaming(true);
    try {
      const updated = await updateCoWriterDocument(renameDoc.id, {
        title: next,
      });
      setDocuments((prev) =>
        prev.map((doc) =>
          doc.id === renameDoc.id
            ? {
                ...doc,
                title: updated.title,
                updated_at: updated.updated_at,
              }
            : doc,
        ),
      );
      notifyCoWriterChanged();
      setRenameDoc(null);
    } catch (err) {
      showError(err, t("Failed to rename document."));
    } finally {
      setRenaming(false);
    }
  }, [renameDoc, renameTitle, renaming, showError, t]);

  const handleDelete = useCallback(async () => {
    if (!deleteDoc || deleting) return;
    setDeleting(true);
    try {
      await deleteCoWriterDocument(deleteDoc.id);
      setDocuments((prev) => prev.filter((doc) => doc.id !== deleteDoc.id));
      notifyCoWriterChanged();
      setDeleteDoc(null);
      toast({ title: t("Document deleted."), variant: "success" });
    } catch (err) {
      showError(err, t("Failed to delete document."));
    } finally {
      setDeleting(false);
    }
  }, [deleteDoc, deleting, showError, t, toast]);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-6 py-8">
        <PageHeader
          title={t("Co-Writer")}
          description={t("Draft long-form writing with an AI editing partner.")}
          actions={
            <>
              <Button variant="outline" onClick={() => openCreateDialog(true)}>
                <LayoutTemplate size={15} />
                {t("From template")}
              </Button>
              <Button onClick={() => openCreateDialog(false)}>
                <Plus size={15} />
                {t("New document")}
              </Button>
            </>
          }
        />

        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="surface h-44 p-5">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="mt-2 h-3 w-1/3" />
                <Skeleton className="mt-5 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-4/5" />
              </div>
            ))}
          </div>
        ) : documents.length === 0 ? (
          <div className="surface">
            <EmptyState
              icon={PenLine}
              title={t("No documents yet")}
              description={t(
                "Create your first document and let the AI help you refine it.",
              )}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" onClick={() => openCreateDialog(true)}>
                    <LayoutTemplate size={15} />
                    {t("From template")}
                  </Button>
                  <Button onClick={() => openCreateDialog(false)}>
                    <Plus size={15} />
                    {t("New document")}
                  </Button>
                </div>
              }
              className="py-16"
            />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="surface group relative flex h-44 cursor-pointer flex-col p-5 text-left transition-colors duration-150 hover:border-primary-border"
              >
                <button
                  type="button"
                  className="absolute inset-0 z-10 rounded-xl"
                  aria-label={t("Open {{title}}", { title: doc.title || t("Untitled document") })}
                  onClick={() => router.push(`/co-writer/${doc.id}`)}
                />
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <FileText
                      size={15}
                      className="mt-1 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <div className="min-w-0">
                      <div
                        className="truncate text-sm font-medium text-foreground"
                        title={doc.title || t("Untitled document")}
                      >
                        {doc.title || t("Untitled document")}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {t("Updated {{time}}", {
                          time: formatRelativeTime(
                            doc.updated_at,
                            i18n.language,
                          ),
                        })}
                      </div>
                    </div>
                  </div>
                  <div className="relative z-20">
                  <Dropdown
                    align="end"
                    trigger={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="-mr-2 -mt-1 h-8 w-8 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={t("Document actions")}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <MoreHorizontal size={15} />
                      </Button>
                    }
                  >
                    <DropdownItem
                      icon={Pencil}
                      label={t("Rename")}
                      onClick={() => openRenameDialog(doc)}
                    />
                    <DropdownSeparator />
                    <DropdownItem
                      icon={Trash2}
                      label={t("Delete")}
                      destructive
                      onClick={() => setDeleteDoc(doc)}
                    />
                  </Dropdown>
                  </div>
                </div>
                <p className="mt-3 line-clamp-4 flex-1 text-xs leading-relaxed text-muted-foreground">
                  {doc.preview || t("Empty document")}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <DialogTitle>{t("New document")}</DialogTitle>
          <DialogDescription>
            {t("Start blank or choose a structured writing template.")}
          </DialogDescription>
          <div className="mt-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label={t("Document template")}>
            <button
              type="button"
              role="radio"
              aria-checked={!createTemplateId}
              onClick={() => selectTemplate("")}
              className={`rounded-xl border p-3 text-left transition-colors ${!createTemplateId ? "border-primary bg-primary-muted" : "border-border hover:bg-muted"}`}
            >
              <FileText size={16} className="text-muted-foreground" />
              <span className="mt-2 block text-sm font-medium text-foreground">{t("Blank document")}</span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{t("Begin with an empty writing canvas.")}</span>
            </button>
            {CO_WRITER_TEMPLATES.map((template) => (
              <button
                key={template.id}
                type="button"
                role="radio"
                aria-checked={createTemplateId === template.id}
                onClick={() => selectTemplate(template.id)}
                className={`rounded-xl border p-3 text-left transition-colors ${createTemplateId === template.id ? "border-primary bg-primary-muted" : "border-border hover:bg-muted"}`}
              >
                <LayoutTemplate size={16} className="text-muted-foreground" />
                <span className="mt-2 block text-sm font-medium text-foreground">{template.title[templateLocale]}</span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{template.description[templateLocale]}</span>
              </button>
            ))}
          </div>
          <Input
            className="mt-4"
            aria-label={t("Document title")}
            value={createTitle}
            onChange={(event) => setCreateTitle(event.target.value)}
            placeholder={t("Untitled document")}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={creating}>
              {t("Create")}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog open={renameDoc !== null} onClose={() => setRenameDoc(null)}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleRename();
          }}
        >
          <DialogTitle>{t("Rename document")}</DialogTitle>
          <Input
            className="mt-4"
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            placeholder={t("Untitled document")}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameDoc(null)}
              disabled={renaming}
            >
              {t("Cancel")}
            </Button>
            <Button type="submit" loading={renaming}>
              {t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      <ConfirmDialog
        open={deleteDoc !== null}
        onClose={() => setDeleteDoc(null)}
        onConfirm={() => void handleDelete()}
        title={t("Delete this document?")}
        description={t(
          "This will permanently delete “{{title}}”. This action cannot be undone.",
          { title: deleteDoc?.title || t("Untitled document") },
        )}
        confirmText={t("Delete")}
        cancelText={t("Cancel")}
        destructive
        loading={deleting}
      />
    </div>
  );
}
