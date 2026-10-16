"use client";

import * as React from "react";
import { FileUp } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Select,
  Textarea,
} from "@/components/ui";

export interface MarkdownImportValues {
  content: string;
  mode: "append" | "replace";
  title: string;
  idempotencyKey?: string;
}

export function MarkdownImportDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: MarkdownImportValues) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [content, setContent] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [mode, setMode] = React.useState<"append" | "replace">("append");
  const [idempotencyKey, setIdempotencyKey] = React.useState<string>();
  const [saving, setSaving] = React.useState(false);

  const resetDraft = () => {
    setContent("");
    setTitle("");
    setMode("append");
    setIdempotencyKey(undefined);
  };

  const close = () => {
    if (saving) return;
    resetDraft();
    onClose();
  };

  const chooseFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setContent(await file.text());
    setTitle(file.name.replace(/\.(md|markdown)$/i, ""));
    setIdempotencyKey(`file:${file.name}:${file.size}:${file.lastModified}`);
  };

  const submit = async () => {
    if (!content.trim() || saving) return;
    setSaving(true);
    try {
      await onSubmit({
        content: content.trim(),
        mode,
        title: title.trim() || t("Imported note"),
        idempotencyKey,
      });
      resetDraft();
      onClose();
    } catch {
      // The page owns the toast. Keep the source text and mode in place for a
      // retry instead of leaking the rejected promise through the click event.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} className="max-w-2xl">
      <DialogTitle>{t("Import Markdown")}</DialogTitle>
      <DialogDescription>
        {t("Second-level headings become separate records. You can also import one document as a single record.")}
      </DialogDescription>
      <div className="mt-4 space-y-4">
        <label className="block text-sm font-medium text-foreground">
          <span className="mb-1.5 block">{t("Markdown file")}</span>
          <Input type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={(event) => void chooseFile(event)} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          <span className="mb-1.5 block">{t("Fallback title")}</span>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("Imported note")} />
        </label>
        <label className="block text-sm font-medium text-foreground">
          <span className="mb-1.5 block">{t("Import mode")}</span>
          <Select value={mode} onChange={(event) => setMode(event.target.value as "append" | "replace")}>
            <option value="append">{t("Append to current records")}</option>
            <option value="replace">{t("Replace all current records")}</option>
          </Select>
        </label>
        {mode === "replace" && (
          <p className="rounded-lg border border-destructive-border bg-destructive-muted p-3 text-sm text-destructive">
            {t("Replace removes every current record after a separate confirmation.")}
          </p>
        )}
        <label className="block text-sm font-medium text-foreground">
          <span className="mb-1.5 block">{t("Markdown content")}</span>
          <Textarea
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setIdempotencyKey(undefined);
            }}
            rows={12}
            className="font-mono text-[13px]"
            placeholder={t("Paste Markdown here…")}
          />
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={close} disabled={saving}>{t("Cancel")}</Button>
        <Button onClick={() => void submit()} disabled={!content.trim()} loading={saving}>
          {!saving && <FileUp size={14} />}
          {t("Continue")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
