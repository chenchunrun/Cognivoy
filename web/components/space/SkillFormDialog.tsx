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
import type { SkillDetail } from "@/lib/skills-api";

export interface SkillFormValues {
  name: string;
  description: string;
  content: string;
  tags: string[];
}

export interface SkillFormDialogProps {
  open: boolean;
  onClose: () => void;
  /** When set, the dialog edits this skill (name becomes rename). */
  skill: SkillDetail | null;
  onSubmit: (values: SkillFormValues) => Promise<void>;
}

/** Create/edit dialog for a skill: name, description, tags, and the SKILL.md body. */
export function SkillFormDialog({
  open,
  onClose,
  skill,
  onSubmit,
}: SkillFormDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [tagsText, setTagsText] = React.useState("");
  const [content, setContent] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setTagsText((skill?.tags ?? []).join(", "));
    setContent(skill?.content ?? "");
    setSaving(false);
  }, [open, skill]);

  const canSubmit = name.trim() && content.trim() && !saving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        content,
        tags: tagsText
          .split(",")
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean),
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
      <DialogTitle>{skill ? t("Edit skill") : t("New skill")}</DialogTitle>
      <DialogDescription>
        {t("A skill is a capability playbook the model reads on demand.")}
      </DialogDescription>

      <div className="mt-4 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Name")}
          </label>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("e.g. literature-review")}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Description")}
          </label>
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t("What this skill does")}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Tags")}
          </label>
          <Input
            value={tagsText}
            onChange={(event) => setTagsText(event.target.value)}
            placeholder={t("Comma-separated, e.g. writing, research")}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {t("Content")}
          </label>
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t("The SKILL.md body the model reads...")}
            className="min-h-[200px] font-mono text-xs"
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
          {skill ? t("Save") : t("Create")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
