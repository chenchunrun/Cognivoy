"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  getBackendOptions,
  getSubagentSettings,
  updateSubagentSettings,
  type SubagentBackendConfig,
  type SubagentSettings,
} from "@/lib/subagents-api";
import { Button, EmptyState, Input, Select, Skeleton, Toggle, useToast } from "@/components/ui";
import { SettingRow, SettingSection, SettingsPageHeader } from "@/components/settings/shared";

export default function AgentBackendSettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const kind = String(useParams<{ kind: string }>().kind || "");
  const [settings, setSettings] = React.useState<SubagentSettings | null>(null);
  const [draft, setDraft] = React.useState<SubagentBackendConfig>({});
  const [models, setModels] = React.useState<Array<{ slug: string; display_name: string }>>([]);
  const [efforts, setEfforts] = React.useState<string[]>([]);
  const [label, setLabel] = React.useState(kind);
  const [saving, setSaving] = React.useState(false);
  const [unknownKind, setUnknownKind] = React.useState(false);
  const [loadedKind, setLoadedKind] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([getSubagentSettings({ force: true }), getBackendOptions()])
      .then(([current, options]) => {
        if (cancelled) return;
        setLoadError(null);
        const option = options.find((item) => item.kind === kind);
        setLoadedKind(kind);
        if (!option) {
          setUnknownKind(true);
          setSettings(null);
          return;
        }
        setUnknownKind(false);
        setSettings(current);
        setDraft(current.backends[kind] ?? {});
        setModels(option.models ?? []);
        setEfforts(option.efforts ?? []);
        setLabel(option.display_name);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setLoadedKind(kind);
        setLoadError(reason instanceof Error ? reason.message : String(reason));
        setSettings(null);
      });
    return () => { cancelled = true; };
  }, [kind, reloadVersion]);

  const patch = (next: Partial<SubagentBackendConfig>) => setDraft((current) => ({ ...current, ...next }));
  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      const updated = await updateSubagentSettings({ ...settings, backends: { ...settings.backends, [kind]: draft } });
      setSettings(updated);
      setDraft(updated.backends[kind] ?? {});
      toast({ title: t("Agent settings saved"), variant: "success" });
    } catch (reason) { toast({ title: t("Failed to save agent settings"), description: reason instanceof Error ? reason.message : String(reason), variant: "destructive" }); }
    finally { setSaving(false); }
  };

  if (loadedKind !== kind) return <div><Skeleton className="h-12" /><Skeleton className="mt-5 h-72" /></div>;
  if (loadError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title={t("Couldn't load agent settings")}
        description={loadError}
        action={<Button onClick={() => setReloadVersion((current) => current + 1)}>{t("Retry")}</Button>}
      />
    );
  }
  if (unknownKind) {
    return (
      <div>
        <Link href="/settings/agents" className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={13} />{t("All agents")}</Link>
        <EmptyState
          icon={AlertTriangle}
          title={t("Agent backend not found")}
          description={t("This agent backend is not available and no settings were changed.")}
          action={<Link href="/settings/agents" className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm text-primary-foreground shadow-hairline hover:brightness-105">{t("Back to agent settings")}</Link>}
        />
      </div>
    );
  }
  if (!settings) return null;
  return (
    <div>
      <Link href="/settings/agents" className="mb-4 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft size={13} />{t("All agents")}</Link>
      <SettingsPageHeader title={label} description={t("Backend-specific model, permissions, and execution defaults.")} action={<Button size="sm" onClick={() => void save()} loading={saving}>{t("Save")}</Button>} />
      <SettingSection title={t("Runtime")}>
        <SettingRow title={t("Enabled")} control={<Toggle checked={draft.enabled !== false} onCheckedChange={(enabled) => patch({ enabled })} aria-label={t("Enabled")} />} />
        <SettingRow title={t("Runtime limit (seconds)")} description={t("Stops an agent run that exceeds this total wall-clock budget. Completed streamed output is preserved.")} control={<Input aria-label={t("Runtime limit (seconds)")} className="w-64" type="number" min={30} max={3600} value={draft.runtime_timeout_seconds ?? 900} onChange={(event) => patch({ runtime_timeout_seconds: Number(event.target.value) })} />} />
        <SettingRow title={t("Model")} control={<Select aria-label={t("Model")} className="w-64" value={draft.model || ""} onChange={(event) => patch({ model: event.target.value })}><option value="">{t("CLI default")}</option>{models.map((model) => <option key={model.slug} value={model.slug}>{model.display_name}</option>)}</Select>} />
        {efforts.length > 0 && <SettingRow title={t("Reasoning effort")} control={<Select aria-label={t("Reasoning effort")} className="w-64" value={draft.effort || ""} onChange={(event) => patch({ effort: event.target.value })}><option value="">{t("CLI default")}</option>{efforts.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</Select>} />}
        <SettingRow title={t("System prompt")} description={t("Additional instructions used whenever this backend is consulted.")} control={<textarea aria-label={t("System prompt")} value={draft.system_prompt || ""} onChange={(event) => patch({ system_prompt: event.target.value })} rows={4} className="w-full max-w-md rounded-lg border border-border bg-background p-2 text-sm text-foreground" />} />
      </SettingSection>
      <SettingSection title={t("Permissions")}>
        <SettingRow title={t("Permission mode")} control={<Input aria-label={t("Permission mode")} className="w-64" value={draft.permission_mode || ""} onChange={(event) => patch({ permission_mode: event.target.value })} placeholder={t("CLI default")} />} />
        <SettingRow title={t("Sandbox")} control={<Input aria-label={t("Sandbox")} className="w-64" value={draft.sandbox || ""} onChange={(event) => patch({ sandbox: event.target.value })} placeholder={t("CLI default")} />} />
        <SettingRow title={t("Approval policy")} control={<Input aria-label={t("Approval policy")} className="w-64" value={draft.approval || ""} onChange={(event) => patch({ approval: event.target.value })} placeholder={t("CLI default")} />} />
        <SettingRow title={t("Network access")} control={<Toggle checked={draft.network_access === true} onCheckedChange={(network_access) => patch({ network_access })} aria-label={t("Network access")} />} />
        <SettingRow title={t("Auto approve")} control={<Toggle checked={draft.auto_approve === true} onCheckedChange={(auto_approve) => patch({ auto_approve })} aria-label={t("Auto approve")} />} />
        <SettingRow title={t("Forward images")} control={<Toggle checked={draft.forward_images === true} onCheckedChange={(forward_images) => patch({ forward_images })} aria-label={t("Forward images")} />} />
      </SettingSection>
    </div>
  );
}
