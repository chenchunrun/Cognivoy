"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Dialog,
  DialogFooter,
  DialogTitle,
  Skeleton,
} from "@/components/ui";
import { getSkill, type SkillDetail, type SkillInfo } from "@/lib/skills-api";

export interface SkillDetailDialogProps {
  open: boolean;
  onClose: () => void;
  /** The list row to open; the full body is fetched on open. */
  skill: SkillInfo | null;
}

/** Read-only view of one skill: metadata plus the full SKILL.md body. */
export function SkillDetailDialog({
  open,
  onClose,
  skill,
}: SkillDetailDialogProps) {
  const { t } = useTranslation();
  const [detail, setDetail] = React.useState<SkillDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!open || !skill) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setDetail(null);
    getSkill(skill.name)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, skill]);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-2xl">
      <DialogTitle>{skill?.name}</DialogTitle>
      {skill && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {skill.source && (
            <Badge variant="outline">{t(skill.source)}</Badge>
          )}
          {skill.tags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </div>
      )}
      {(detail?.description ?? skill?.description) && (
        <p className="mt-2 text-sm text-muted-foreground">
          {detail?.description ?? skill?.description}
        </p>
      )}

      <div className="mt-4">
        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 font-mono text-xs leading-relaxed text-foreground">
            {detail?.content || t("No content")}
          </pre>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t("Close")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
