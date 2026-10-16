"use client";

/**
 * Soul tab: the partner's SOUL.md as a markdown editor with an edit/preview
 * toggle, saved via `PUT /api/v1/partners/{id}/soul`.
 */

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Eye, History, PencilLine, RotateCcw, Save } from "lucide-react";
import {
  getPartnerSoul,
  getPartnerSoulVersions,
  restorePartnerSoulVersion,
  savePartnerSoul,
  type SoulVersion,
} from "@/lib/partners-api";
import {
  Badge,
  Button,
  ConfirmDialog,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/ui";
import { Markdown } from "@/components/chat/Markdown";
import { cn } from "@/lib/utils";

type Mode = "edit" | "preview";

export function SoulEditor({ partnerId }: { partnerId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [mode, setMode] = React.useState<Mode>("edit");
  const [content, setContent] = React.useState("");
  const [savedContent, setSavedContent] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [versions, setVersions] = React.useState<SoulVersion[]>([]);
  const [restoreTarget, setRestoreTarget] = React.useState<SoulVersion | null>(null);
  const [restoring, setRestoring] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([getPartnerSoul(partnerId), getPartnerSoulVersions(partnerId)])
      .then(([soul, history]) => {
        if (cancelled) return;
        setContent(soul);
        setSavedContent(soul);
        setVersions(history);
      })
      .catch((e) => {
        if (cancelled) return;
        setSavedContent("");
        toast({
          title: e instanceof Error ? e.message : t("Failed to load the soul"),
          variant: "destructive",
        });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [partnerId, t, toast]);

  const dirty = savedContent !== null && content !== savedContent;

  const save = async () => {
    setSaving(true);
    try {
      await savePartnerSoul(partnerId, content);
      setSavedContent(content);
      setVersions(await getPartnerSoulVersions(partnerId));
      toast({ title: t("Soul saved"), variant: "success" });
    } catch (e) {
      toast({
        title: e instanceof Error ? e.message : t("Save failed"),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const restore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const restored = await restorePartnerSoulVersion(partnerId, restoreTarget.id);
      setContent(restored);
      setSavedContent(restored);
      setVersions(await getPartnerSoulVersions(partnerId));
      setRestoreTarget(null);
      toast({ title: t("Soul version restored"), variant: "success" });
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t("Restore failed"),
        variant: "destructive",
      });
    } finally {
      setRestoring(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const segments: { key: Mode; label: string; icon: typeof PencilLine }[] = [
    { key: "edit", label: t("Edit"), icon: PencilLine },
    { key: "preview", label: t("Preview"), icon: Eye },
  ];

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border bg-muted-subtle py-1.5 pl-4 pr-1.5">
          <span className="font-mono text-xs tracking-wide text-muted-foreground">
            SOUL.md
          </span>
          <div className="flex items-center gap-2">
            <div className="grid grid-cols-2 rounded-lg bg-muted p-0.5">
              {segments.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  aria-pressed={mode === key}
                  className={cn(
                    "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors duration-150",
                    mode === key
                      ? "bg-card font-medium text-foreground shadow-hairline"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {label}
                </button>
              ))}
            </div>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!dirty}
              loading={saving}
            >
              <Save className="h-3.5 w-3.5" />
              {t("Save")}
            </Button>
          </div>
        </div>

        {mode === "edit" ? (
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            placeholder={t(
              "# Soul\nDescribe who this partner is, how it speaks, what it values…",
            )}
            className="h-[380px] resize-none rounded-none border-0 bg-transparent font-mono text-[13px] leading-[1.7] focus-visible:ring-0"
          />
        ) : (
          <div className="h-[380px] overflow-y-auto px-5 py-4">
            {content.trim() ? (
              <div className="prose-cognivoy">
                <Markdown content={content} />
              </div>
            ) : (
              <p className="text-sm italic text-muted-foreground">
                {t("Nothing to preview yet.")}
              </p>
            )}
          </div>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "The soul is who this partner is — its voice, values, and boundaries. Changes apply to new conversations.",
        )}
      </p>

      <section className="surface p-4">
        <div className="mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-medium text-foreground">{t("Version history")}</h3>
          <Badge variant="outline">{versions.length}</Badge>
        </div>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("No saved versions yet.")}</p>
        ) : (
          <ol className="divide-y divide-border rounded-lg border border-border">
            {versions.map((version, index) => {
              const summary =
                version.content
                  .split("\n")
                  .map((line) => line.replace(/^#+\s*/, "").trim())
                  .find(Boolean) || t("Empty Soul");
              return (
                <li key={version.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm text-foreground">{summary}</p>
                      {index === 0 && <Badge variant="primary">{t("Current")}</Badge>}
                    </div>
                    <time className="text-xs text-muted-foreground">
                      {new Date(version.saved_at).toLocaleString()}
                    </time>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={index === 0}
                    title={t("Restore this version")}
                    onClick={() => setRestoreTarget(version)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    {t("Restore")}
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <ConfirmDialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        onConfirm={() => void restore()}
        title={t("Restore this Soul version?")}
        description={t(
          "The current Soul remains in version history, so this rollback can be reversed.",
        )}
        confirmText={t("Restore")}
        cancelText={t("Cancel")}
        loading={restoring}
      />
    </div>
  );
}
