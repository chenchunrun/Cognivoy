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
  Select,
  Textarea,
} from "@/components/ui";
import type { PersonaDetail } from "@/lib/personas-api";

export interface PersonaFormValues {
  name: string;
  description: string;
  content: string;
  language: "auto" | "en" | "zh";
  style: string;
  icon: string;
}

export interface PersonaFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this persona (name becomes rename). */
  persona: PersonaDetail | null;
  onSubmit: (values: PersonaFormValues) => Promise<void>;
}

/** Create/edit dialog for a persona: name, short description, and the prompt body. */
export function PersonaFormDialog({
  open,
  onClose,
  persona,
  onSubmit,
}: PersonaFormDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [content, setContent] = React.useState("");
  const [language, setLanguage] = React.useState<"auto" | "en" | "zh">("auto");
  const [style, setStyle] = React.useState("");
  const [icon, setIcon] = React.useState("user-round");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(persona?.name ?? "");
    setDescription(persona?.description ?? "");
    setContent(persona?.content ?? "");
    setLanguage(persona?.language ?? "auto");
    setStyle(persona?.style ?? "");
    setIcon(persona?.icon ?? "user-round");
    setSaving(false);
  }, [open, persona]);

  const canSubmit = name.trim() && content.trim() && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        content,
        language,
        style: style.trim(),
        icon,
      });
      onClose();
    } catch {
      // The page reports the error via toast; keep the dialog open.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <DialogTitle>
        {persona ? t("Edit persona") : t("New persona")}
      </DialogTitle>
      <DialogDescription>
        {t(
          "A persona is a behavior preset the model applies for a conversation.",
        )}
      </DialogDescription>

      <div className="mt-4 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Name")}
          </label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("e.g. Socratic tutor")}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("Response language")}
            </label>
            <Select value={language} onChange={(event) => setLanguage(event.target.value as "auto" | "en" | "zh")}>
              <option value="auto">{t("Follow user language")}</option>
              <option value="zh">{t("Chinese")}</option>
              <option value="en">{t("English")}</option>
            </Select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t("Icon")}
            </label>
            <Select value={icon} onChange={(event) => setIcon(event.target.value)}>
              <option value="user-round">{t("Person")}</option>
              <option value="graduation-cap">{t("Tutor")}</option>
              <option value="messages-square">{t("Conversation")}</option>
              <option value="book-open">{t("Reader")}</option>
              <option value="microscope">{t("Researcher")}</option>
              <option value="sparkles">{t("Creative")}</option>
            </Select>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Communication style")}
          </label>
          <Input
            value={style}
            onChange={(event) => setStyle(event.target.value)}
            maxLength={80}
            placeholder={t("e.g. concise, warm, Socratic")}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Description")}
          </label>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("What this persona is for")}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Prompt")}
          </label>
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t(
              "Instructions the model follows when this persona is active...",
            )}
            className="min-h-[180px] font-mono text-xs"
          />
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          {t("Cancel")}
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          loading={saving}
        >
          {persona ? t("Save") : t("Create")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
