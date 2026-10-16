"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  Textarea,
} from "@/components/ui";
import type { NotebookEntry } from "@/lib/notebook-api";

export interface EntryEditValues {
  userAnswer: string;
  correctAnswer: string;
  explanation: string;
}

export interface EntryEditDialogProps {
  open: boolean;
  onClose: () => void;
  entry: NotebookEntry | null;
  onSubmit: (values: EntryEditValues) => Promise<void>;
}

/** Edit an entry's answers/explanation in place (persisted via upsert). */
export function EntryEditDialog({
  open,
  onClose,
  entry,
  onSubmit,
}: EntryEditDialogProps) {
  const { t } = useTranslation();
  const [userAnswer, setUserAnswer] = React.useState("");
  const [correctAnswer, setCorrectAnswer] = React.useState("");
  const [explanation, setExplanation] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open && entry) {
      setUserAnswer(entry.user_answer ?? "");
      setCorrectAnswer(entry.correct_answer ?? "");
      setExplanation(entry.explanation ?? "");
    }
  }, [open, entry]);

  const handleSubmit = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSubmit({
        userAnswer: userAnswer.trim(),
        correctAnswer: correctAnswer.trim(),
        explanation: explanation.trim(),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogTitle>{t("Edit entry")}</DialogTitle>
      <DialogDescription>
        {t("Update the answers or explanation for this question.")}
      </DialogDescription>
      <div className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("Your answer")}
          </span>
          <Textarea
            value={userAnswer}
            onChange={(event) => setUserAnswer(event.target.value)}
            className="min-h-[64px]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("Reference answer")}
          </span>
          <Textarea
            value={correctAnswer}
            onChange={(event) => setCorrectAnswer(event.target.value)}
            className="min-h-[64px]"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("Explanation")}
          </span>
          <Textarea
            value={explanation}
            onChange={(event) => setExplanation(event.target.value)}
            className="min-h-[96px]"
          />
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("Cancel")}
        </Button>
        <Button onClick={() => void handleSubmit()} loading={saving}>
          {t("Save")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
