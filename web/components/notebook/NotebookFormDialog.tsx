"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Input,
  Textarea,
} from "@/components/ui";
import type { NotebookSummary } from "@/lib/notebook-api";

export interface NotebookFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set the dialog edits this notebook; otherwise it creates one. */
  notebook?: NotebookSummary | null;
  onSubmit: (values: { name: string; description: string }) => Promise<void>;
}

export function NotebookFormDialog({
  open,
  onClose,
  notebook,
  onSubmit,
}: NotebookFormDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const editing = Boolean(notebook);

  React.useEffect(() => {
    if (open) {
      setName(notebook?.name ?? "");
      setDescription(notebook?.description ?? "");
    }
  }, [open, notebook]);

  const handleSubmit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onSubmit({ name: name.trim(), description: description.trim() });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogTitle>
        {editing ? t("Rename notebook") : t("New notebook")}
      </DialogTitle>
      <DialogDescription>
        {editing
          ? t("Update the name or description of this notebook.")
          : t("Notebooks collect saved outputs from chat, research, and more.")}
      </DialogDescription>
      <div className="mt-4 space-y-3">
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void handleSubmit();
          }}
          placeholder={t("Notebook name")}
          aria-label={t("Notebook name")}
        />
        <Textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={t("Description (optional)")}
          aria-label={t("Description (optional)")}
          className="min-h-[64px]"
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("Cancel")}
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          loading={saving}
          disabled={!name.trim()}
        >
          {editing ? t("Save") : t("Create")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
