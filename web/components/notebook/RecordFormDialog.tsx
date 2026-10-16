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
import type { NotebookRecordItem } from "@/lib/notebook-api";

export interface RecordFormValues {
  title: string;
  userQuery: string;
  output: string;
  tags: string[];
}

export interface RecordFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set the dialog edits this record; otherwise it adds a new one. */
  record?: NotebookRecordItem | null;
  onSubmit: (values: RecordFormValues) => Promise<void>;
}

export function RecordFormDialog({
  open,
  onClose,
  record,
  onSubmit,
}: RecordFormDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = React.useState("");
  const [userQuery, setUserQuery] = React.useState("");
  const [output, setOutput] = React.useState("");
  const [tags, setTags] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const editing = Boolean(record);

  React.useEffect(() => {
    if (open) {
      setTitle(record?.title ?? "");
      setUserQuery(record?.user_query ?? "");
      setOutput(record?.output ?? "");
      setTags((record?.tags ?? []).join(", "));
    }
  }, [open, record]);

  const handleSubmit = async () => {
    if (!title.trim() || !output.trim() || saving) return;
    setSaving(true);
    try {
      await onSubmit({
        title: title.trim(),
        userQuery: userQuery.trim(),
        output: output.trim(),
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      });
      onClose();
    } catch {
      // The owning page reports the failure. Keeping the dialog open lets the
      // user review a freshly loaded conflict revision or retry a failed save
      // without turning an expected API error into a browser pageerror.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogTitle>
        {editing ? t("Edit record") : t("Add record")}
      </DialogTitle>
      <DialogDescription>
        {editing
          ? t("Update the title or content of this record.")
          : t("Save a note to this notebook. Markdown is supported.")}
      </DialogDescription>
      <div className="mt-4 space-y-3">
        <Input
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder={t("Title")}
          aria-label={t("Title")}
        />
        <Textarea
          value={userQuery}
          onChange={(event) => setUserQuery(event.target.value)}
          placeholder={t("Source question or prompt (optional)")}
          aria-label={t("Source question or prompt (optional)")}
          className="min-h-[56px]"
        />
        <Textarea
          value={output}
          onChange={(event) => setOutput(event.target.value)}
          placeholder={t("Content")}
          aria-label={t("Content")}
          className="min-h-[180px] font-mono text-[13px]"
        />
        <Input
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={t("Tags, separated by commas")}
          aria-label={t("Tags, separated by commas")}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("Cancel")}
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          loading={saving}
          disabled={!title.trim() || !output.trim()}
        >
          {editing ? t("Save") : t("Add record")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
