"use client";

import * as React from "react";
import { ExternalLink, NotebookPen, Plus, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Textarea,
  useToast,
} from "@/components/ui";
import {
  listNotebooks,
  createNotebook,
  type NotebookRecordType,
  type NotebookSummary,
} from "@/lib/notebook-api";
import { addNotebookRecord } from "@/components/notebook/record-api";
import type { MessageItem } from "@/lib/chat-types";
import { recordSloEvent } from "@/lib/slo-api";

export function SaveMessageToNotebookDialog({
  message,
  userQuery,
  onClose,
}: {
  message: MessageItem | null;
  userQuery: string;
  onClose: () => void;
}) {
  if (!message) return null;
  return (
    <SaveContentToNotebookDialog
      key={message.id ?? `${message.capability}:${message.content.slice(0, 32)}`}
      content={message.content}
      defaultTitle={(userQuery || message.content).replace(/\s+/g, " ").trim().slice(0, 80)}
      recordType={message.capability === "deep_research" ? "research" : "chat"}
      userQuery={userQuery}
      idempotencyKey={message.id ? `chat-message:${message.id}` : undefined}
      references={message.id ? [{ type: "message", id: String(message.id) }] : []}
      onClose={onClose}
    />
  );
}

export function SaveContentToNotebookDialog({
  content,
  defaultTitle,
  recordType,
  userQuery,
  idempotencyKey,
  references = [],
  onClose,
}: {
  content: string;
  defaultTitle: string;
  recordType: NotebookRecordType;
  userQuery?: string;
  idempotencyKey?: string;
  references?: Array<{ type: string; id: string }>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [notebooks, setNotebooks] = React.useState<NotebookSummary[]>([]);
  const [notebookId, setNotebookId] = React.useState("");
  const [title, setTitle] = React.useState(() => defaultTitle.slice(0, 120));
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [notebookName, setNotebookName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [createError, setCreateError] = React.useState<string | null>(null);
  const listRequest = React.useRef(0);
  const mutationPending = React.useRef(false);
  const notebookSelect = React.useRef<HTMLSelectElement | null>(null);
  const restoreSelectionFocus = React.useRef(false);
  const busy = creating || saving;
  const canSave = !loading && !busy && !createOpen && Boolean(title.trim())
    && notebooks.some((notebook) => notebook.id === notebookId);

  const loadNotebooks = React.useCallback(() => {
    if (mutationPending.current) return;
    const request = ++listRequest.current;
    return listNotebooks()
      .then((items) => {
        if (request !== listRequest.current) return;
        setNotebooks(items);
        setNotebookId((current) => items.some((item) => item.id === current) ? current : "");
      })
      .catch((error: unknown) => {
        if (request !== listRequest.current) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setNotebooks([]);
        setNotebookId("");
      })
      .finally(() => {
        if (request === listRequest.current) setLoading(false);
      });
  }, []);

  const refreshNotebooks = () => {
    if (mutationPending.current) return;
    setLoading(true);
    setLoadError(null);
    void loadNotebooks();
  };

  React.useEffect(() => {
    void loadNotebooks();
    return () => { listRequest.current += 1; };
  }, [loadNotebooks]);

  React.useEffect(() => {
    if (!createOpen && !creating && restoreSelectionFocus.current) {
      restoreSelectionFocus.current = false;
      notebookSelect.current?.focus();
    }
  }, [createOpen, creating]);

  const close = React.useCallback(() => {
    if (!mutationPending.current) onClose();
  }, [onClose]);

  const create = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!notebookName.trim() || mutationPending.current || loading) return;
    mutationPending.current = true;
    // A stale list response must never remove the notebook just created.
    listRequest.current += 1;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await createNotebook({
        name: notebookName.trim(),
        description: description.trim(),
      });
      setNotebooks((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setNotebookId(created.id);
      restoreSelectionFocus.current = true;
      setCreateOpen(false);
      setNotebookName("");
      setDescription("");
      toast({ title: t("Notebook created"), variant: "success" });
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error));
    } finally {
      mutationPending.current = false;
      setCreating(false);
    }
  };

  const save = async () => {
    if (!canSave || mutationPending.current) return;
    mutationPending.current = true;
    setSaving(true);
    try {
      await addNotebookRecord({
        notebookId,
        recordType,
        title: title.trim(),
        userQuery: userQuery ?? "",
        output: content,
        idempotencyKey,
        references,
      });
      void recordSloEvent("asset_saved");
      toast({ title: t("Saved to notebook"), variant: "success" });
      onClose();
    } catch (error) {
      toast({
        title: t("Failed to save to notebook"),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      mutationPending.current = false;
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={close} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogTitle>{t("Save to notebook")}</DialogTitle>
      <DialogDescription>
        {t("Keep this answer as reusable learning context.")}
      </DialogDescription>
      <div className="mt-5 space-y-4">
        <label className="block text-sm text-foreground">
          <span className="mb-1.5 block text-xs text-muted-foreground">{t("Notebook")}</span>
          <select
            ref={notebookSelect}
            value={notebookId}
            onChange={(event) => setNotebookId(event.target.value)}
            disabled={loading || busy || createOpen}
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground"
          >
            <option value="">{loading ? t("Loading…") : t("Select a notebook")}</option>
            {notebooks.map((notebook) => (
              <option key={notebook.id} value={notebook.id}>{notebook.name}</option>
            ))}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading || busy || createOpen}
            onClick={() => { setCreateError(null); setCreateOpen(true); }}
          >
            <Plus size={14} aria-hidden="true" />
            {t("New notebook")}
          </Button>
          <a
            href="/notebook"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("Manage notebooks")}
            <ExternalLink size={13} aria-hidden="true" />
            <span className="sr-only">{t("Opens in a new tab")}</span>
          </a>
          <Button
            variant="ghost"
            size="sm"
            disabled={loading || busy || createOpen}
            onClick={refreshNotebooks}
            aria-label={t("Refresh notebooks")}
          >
            <RefreshCw size={13} aria-hidden="true" />
            {t("Refresh")}
          </Button>
        </div>
        {loadError && (
          <div role="alert" className="rounded-lg border border-destructive bg-destructive-muted p-3 text-xs text-foreground">
            <p className="font-medium">{t("Failed to load notebooks")}</p>
            <p className="mt-1 break-words">{loadError}</p>
            <Button
              className="mt-2"
              variant="outline"
              size="sm"
              disabled={loading || busy || createOpen}
              onClick={refreshNotebooks}
            >
              {t("Retry")}
            </Button>
          </div>
        )}
        {!loading && !loadError && notebooks.length === 0 && !createOpen && (
          <p role="status" className="rounded-lg bg-muted-subtle p-3 text-xs text-muted-foreground">
            {t("No notebooks yet")} {t("Create a notebook here, then save your answer.")}
          </p>
        )}
        {createOpen && (
          <form onSubmit={(event) => void create(event)} className="rounded-lg border border-border bg-muted-subtle p-3">
            <fieldset disabled={creating} className="min-w-0 space-y-3">
              <legend className="mb-2 text-sm font-medium">{t("New notebook")}</legend>
              <label className="block text-xs text-muted-foreground">
                <span className="mb-1.5 block">{t("Notebook name")}</span>
                <Input
                  autoFocus
                  value={notebookName}
                  onChange={(event) => setNotebookName(event.target.value)}
                  maxLength={120}
                  required
                />
              </label>
              <label className="block text-xs text-muted-foreground">
                <span className="mb-1.5 block">{t("Description (optional)")}</span>
                <Textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={1000}
                  rows={2}
                />
              </label>
              {createError && (
                <div role="alert" className="text-xs text-destructive">
                  <p className="font-medium">{t("Failed to create notebook")}</p>
                  <p className="mt-1 break-words">{createError}</p>
                </div>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    restoreSelectionFocus.current = true;
                    setCreateOpen(false);
                    setCreateError(null);
                  }}
                >
                  {t("Cancel creation")}
                </Button>
                <Button type="submit" size="sm" loading={creating} disabled={!notebookName.trim()}>
                  {t("Create and select")}
                </Button>
              </div>
            </fieldset>
          </form>
        )}
        <label className="block text-sm text-foreground">
          <span className="mb-1.5 block text-xs text-muted-foreground">{t("Title")}</span>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} disabled={busy} />
        </label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={close} disabled={busy}>{t("Cancel")}</Button>
        <Button onClick={() => void save()} disabled={!canSave} loading={saving}>
          {!saving && <NotebookPen size={14} />}
          {t("Save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

export default SaveMessageToNotebookDialog;
