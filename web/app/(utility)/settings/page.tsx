"use client";

import * as React from "react";
import { Activity, Cpu, MessageSquare, RotateCcw, Undo2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import { Badge, Button, ConfirmDialog, Skeleton, useToast } from "@/components/ui";
import { SettingsLinkCard, SettingsPageHeader } from "@/components/settings/shared";
import {
  normalizeDefaultCapability,
  normalizeLanguage,
  resolveResponseLanguage,
  writeStoredChatResponseTimeout,
  writeStoredDefaultCapability,
  writeStoredLanguage,
  writeStoredResponseLanguage,
} from "@/context/app-shell-storage";
import { setTheme } from "@/lib/theme";

interface OverviewStatus {
  backend?: { status?: string };
  llm?: { status?: string };
  embeddings?: { status?: string };
  search?: { status?: string };
}

interface ResetPreview {
  changed_keys: string[];
  changed_count: number;
  backup_will_be_created: boolean;
  description: string;
}

interface InterfaceSettings {
  theme?: string;
  language?: string;
  response_language?: string;
  default_capability?: string;
  chat_response_timeout?: number;
}

interface ResetResponse {
  settings: InterfaceSettings;
  backup_id: string;
}

const ready = (status?: string) => status === "online" || status === "configured";

export default function SettingsIndexPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [status, setStatus] = React.useState<OverviewStatus | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [resetPreview, setResetPreview] = React.useState<ResetPreview | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [backupId, setBackupId] = React.useState("");
  const [restoring, setRestoring] = React.useState(false);

  const applyInterfaceSettings = React.useCallback(
    (settings: InterfaceSettings) => {
      const language = normalizeLanguage(settings.language);
      const responseLanguage = resolveResponseLanguage(
        settings.response_language,
        language,
      );
      writeStoredLanguage(language);
      writeStoredResponseLanguage(responseLanguage);
      writeStoredDefaultCapability(
        normalizeDefaultCapability(settings.default_capability),
      );
      if (typeof settings.chat_response_timeout === "number") {
        writeStoredChatResponseTimeout(settings.chat_response_timeout);
      }
      setTheme(settings.theme === "dark" || settings.theme === "glass" ? "dark" : "light");
      void i18n.changeLanguage(language);
    },
    [i18n],
  );

  const reviewReset = async () => {
    try {
      const response = await apiFetch(apiUrl("/api/v1/settings/reset/preview"));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setResetPreview((await response.json()) as ResetPreview);
      setResetOpen(true);
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Unable to review reset"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const resetInterfaceSettings = async () => {
    setResetting(true);
    try {
      const response = await apiFetch(apiUrl("/api/v1/settings/reset"), {
        method: "POST",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as ResetResponse;
      setBackupId(payload.backup_id);
      applyInterfaceSettings(payload.settings);
      setResetOpen(false);
      toast({ variant: "success", title: t("Interface preferences reset") });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Reset failed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResetting(false);
    }
  };

  const undoReset = async () => {
    if (!backupId) return;
    setRestoring(true);
    try {
      const response = await apiFetch(
        apiUrl(`/api/v1/settings/reset/backups/${encodeURIComponent(backupId)}/restore`),
        { method: "POST" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { settings: InterfaceSettings };
      applyInterfaceSettings(payload.settings);
      setBackupId("");
      toast({ variant: "success", title: t("Interface preferences restored") });
    } catch (error) {
      toast({
        variant: "destructive",
        title: t("Restore failed"),
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRestoring(false);
    }
  };

  React.useEffect(() => {
    const controller = new AbortController();
    void apiFetch(apiUrl("/api/v1/system/status"), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setStatus((await response.json()) as OverviewStatus);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, []);

  const checks = status
    ? [status.backend?.status, status.llm?.status, status.embeddings?.status, status.search?.status]
    : [];
  const readyCount = checks.filter(ready).length;
  let healthBadge: React.ReactNode = <Skeleton className="h-7 w-28" />;
  if (failed) {
    healthBadge = <Badge variant="destructive">{t("Unavailable")}</Badge>;
  } else if (status) {
    healthBadge = (
      <Badge variant={readyCount === checks.length ? "success" : "warning"}>
        {t("{{ready}} of {{total}} ready", { ready: readyCount, total: checks.length })}
      </Badge>
    );
  }

  return (
    <div>
      <SettingsPageHeader
        title={t("Overview")}
        description={t("Configure Cognivoy and verify the services required by your learning workflows.")}
      />

      <section className="surface mb-6 p-4" aria-labelledby="settings-health-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="settings-health-title" className="text-sm font-medium text-foreground">{t("System health")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("Backend, model, embedding, and search readiness.")}</p>
          </div>
          {healthBadge}
        </div>
        {status && (
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Backend", value: status.backend?.status },
              { label: "LLM", value: status.llm?.status },
              { label: "Embedding", value: status.embeddings?.status },
              { label: "Search", value: status.search?.status },
            ].map((item) => (
              <div key={item.label} className="rounded-lg border border-border bg-muted-subtle px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{t(item.label)}</div>
                <div className="mt-1 text-xs font-medium text-foreground">{t(item.value || "unknown")}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-3 sm:grid-cols-2">
        <SettingsLinkCard href="/settings/llm" icon={Cpu} title={t("Models and providers")} description={t("Choose and test the language model used across capabilities.")} actionLabel={t("Configure LLM")} />
        <SettingsLinkCard href="/settings/chat" icon={MessageSquare} title={t("Chat defaults")} description={t("Set the default capability, timeout, voice playback, and attachment limits.")} actionLabel={t("Configure chat")} />
        <SettingsLinkCard href="/settings/capabilities" icon={Wrench} title={t("Capabilities and tools")} description={t("Control advanced workflows, dependencies, and tool permissions.")} actionLabel={t("Review capabilities")} />
        <SettingsLinkCard href="/settings/status" icon={Activity} title={t("Dependency status")} description={t("Inspect parsing, Manim, media, and Agent CLI readiness.")} actionLabel={t("View status")} />
      </div>

      <section className="surface mt-6 p-4" aria-labelledby="settings-reset-title">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="rounded-lg bg-primary-muted p-2 text-primary"><RotateCcw className="h-4 w-4" /></div>
            <div>
              <h2 id="settings-reset-title" className="text-sm font-medium text-foreground">{t("Reset interface preferences")}</h2>
              <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                {t("Review the exact impact first. A recoverable backup is created before any preference changes.")}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            {backupId && (
              <Button variant="outline" onClick={() => void undoReset()} loading={restoring}>
                <Undo2 className="h-4 w-4" /> {t("Undo reset")}
              </Button>
            )}
            <Button variant="outline" onClick={() => void reviewReset()}>
              {t("Review reset")}
            </Button>
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={() => void resetInterfaceSettings()}
        title={t("Reset interface preferences?")}
        description={t("{{count}} preferences will be reset. A recoverable backup will be created. {{details}}", {
          count: resetPreview?.changed_count ?? 0,
          details: resetPreview?.description ?? "",
        })}
        confirmText={t("Reset interface preferences")}
        destructive
        loading={resetting}
      />
    </div>
  );
}
