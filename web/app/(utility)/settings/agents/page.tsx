"use client";

import * as React from "react";
import Link from "next/link";
import { AlertCircle, Bot } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  getBackendOptions,
  getSubagentSettings,
  getSubagentRuntimeStatus,
  updateSubagentSettings,
  updateSubagentRuntimePolicy,
  type SubagentBackendConfig,
  type SubagentBackendOptions,
  type SubagentRuntimeMetrics,
  type SubagentRuntimePolicy,
} from "@/lib/subagents-api";
import { cn } from "@/lib/utils";
import {
  Badge,
  Button,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Toggle,
  useToast,
} from "@/components/ui";
import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
} from "@/components/settings/shared";

const CLI_DEFAULT = "__cli_default__";

interface BackendDraft {
  enabled: boolean;
  model: string;
  effort: string;
}

export default function AgentsSettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [options, setOptions] = React.useState<SubagentBackendOptions[] | null>(
    null,
  );
  const [consultBudget, setConsultBudget] = React.useState(1);
  const [drafts, setDrafts] = React.useState<Record<string, BackendDraft>>({});
  const [snapshot, setSnapshot] = React.useState("");
  const [runtimePolicy, setRuntimePolicy] = React.useState<SubagentRuntimePolicy | null>(null);
  const [runtimeMetrics, setRuntimeMetrics] = React.useState<SubagentRuntimeMetrics | null>(null);
  const [policyManaged, setPolicyManaged] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const [backendOptions, settings] = await Promise.all([
        getBackendOptions(),
        getSubagentSettings({ force: true }),
      ]);
      setOptions(backendOptions);
      setConsultBudget(settings.consult_budget);
      const nextDrafts: Record<string, BackendDraft> = {};
      for (const option of backendOptions) {
        const stored: SubagentBackendConfig =
          settings.backends[option.kind] ?? {};
        nextDrafts[option.kind] = {
          enabled: stored.enabled !== false,
          model: stored.model ?? "",
          effort: stored.effort ?? "",
        };
      }
      setDrafts(nextDrafts);
      let nextPolicy: SubagentRuntimePolicy | null = null;
      try {
        const runtime = await getSubagentRuntimeStatus();
        nextPolicy = runtime.policy;
        setRuntimePolicy(runtime.policy);
        setRuntimeMetrics(runtime.runtime);
        setPolicyManaged(false);
      } catch {
        setRuntimePolicy(null);
        setRuntimeMetrics(null);
        setPolicyManaged(true);
      }
      setSnapshot(JSON.stringify({ b: settings.consult_budget, d: nextDrafts, p: nextPolicy }));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    snapshot !== "" &&
    snapshot !== JSON.stringify({ b: consultBudget, d: drafts, p: runtimePolicy });

  function patch(kind: string, value: Partial<BackendDraft>) {
    setDrafts((current) => ({
      ...current,
      [kind]: { ...current[kind], ...value },
    }));
  }

  async function save() {
    setSaving(true);
    try {
      const backends: Record<string, SubagentBackendConfig> = {};
      for (const [kind, draft] of Object.entries(drafts)) {
        backends[kind] = {
          enabled: draft.enabled,
          model: draft.model,
          effort: draft.effort,
        };
      }
      const updated = await updateSubagentSettings({
        consult_budget: consultBudget,
        backends,
      });
      let updatedPolicy = runtimePolicy;
      if (runtimePolicy) {
        const runtime = await updateSubagentRuntimePolicy(runtimePolicy);
        updatedPolicy = runtime.policy;
        setRuntimePolicy(runtime.policy);
        setRuntimeMetrics(runtime.runtime);
      }
      setConsultBudget(updated.consult_budget);
      setSnapshot(JSON.stringify({ b: updated.consult_budget, d: drafts, p: updatedPolicy }));
      toast({ title: t("Agent settings saved"), variant: "success" });
    } catch (err) {
      toast({
        title: t("Failed to save agent settings"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  if (loadError) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Agents")}
          description={t(
            "External agent CLIs the chat agent can consult for coding tasks.",
          )}
        />
        <EmptyState
          icon={AlertCircle}
          title={t("Couldn't load agent settings")}
          description={loadError}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("Retry")}
            </Button>
          }
        />
      </div>
    );
  }

  if (!options) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Agents")}
          description={t(
            "External agent CLIs the chat agent can consult for coding tasks.",
          )}
        />
        <div className="space-y-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      </div>
    );
  }

  return (
    <div>
      <SettingsPageHeader
        title={t("Agents")}
        description={t(
          "External agent CLIs the chat agent can consult for coding tasks.",
        )}
        action={
          <Button
            size="sm"
            onClick={() => void save()}
            loading={saving}
            disabled={!dirty}
          >
            {t("Save")}
          </Button>
        }
      />

      <SettingSection
        title={t("Consultation")}
        description={t(
          "How many times the chat agent may consult an external agent within one turn.",
        )}
      >
        <SettingRow
          title={t("Consult budget")}
          control={
            <Input
              aria-label={t("Consult budget")}
              type="number"
              className="w-24"
              min={0}
              max={20}
              value={consultBudget}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setConsultBudget(v);
              }}
            />
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Deployment resource policy")}
        description={t("Shared limits protect the host across direct Agent chats and Chat consultations.")}
      >
        {policyManaged || !runtimePolicy ? (
          <p className="text-sm text-muted-foreground">
            {t("Deployment resource policy is managed by an administrator.")}
          </p>
        ) : (
          <>
            {runtimeMetrics && (
              <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">
                  {t("{{active}} active · {{queued}} queued", {
                    active: runtimeMetrics.active_runs,
                    queued: runtimeMetrics.queued_runs,
                  })}
                </Badge>
                <Badge variant="outline">
                  {t("{{count}} completed", { count: runtimeMetrics.completed_runs })}
                </Badge>
                {(runtimeMetrics.rejected_runs + runtimeMetrics.queue_timed_out_runs + runtimeMetrics.output_limited_runs) > 0 && (
                  <Badge variant="warning">
                    {t("{{count}} limited", {
                      count: runtimeMetrics.rejected_runs + runtimeMetrics.queue_timed_out_runs + runtimeMetrics.output_limited_runs,
                    })}
                  </Badge>
                )}
              </div>
            )}
            <SettingRow
              title={t("Maximum concurrent runs")}
              description={t("Runs above this deployment-wide limit wait in a FIFO queue.")}
              control={<Input aria-label={t("Maximum concurrent runs")} type="number" className="w-28" min={1} max={16} value={runtimePolicy.max_concurrent_runs} onChange={(event) => setRuntimePolicy({ ...runtimePolicy, max_concurrent_runs: Number(event.target.value) })} />}
            />
            <SettingRow
              title={t("Queue capacity")}
              description={t("New runs are rejected before spawning when the queue is full.")}
              control={<Input aria-label={t("Queue capacity")} type="number" className="w-28" min={0} max={200} value={runtimePolicy.max_queued_runs} onChange={(event) => setRuntimePolicy({ ...runtimePolicy, max_queued_runs: Number(event.target.value) })} />}
            />
            <SettingRow
              title={t("Queue timeout")}
              description={t("Maximum seconds a run may wait for an execution slot.")}
              control={<Input aria-label={t("Queue timeout")} type="number" className="w-28" min={1} max={600} value={runtimePolicy.queue_timeout_seconds} onChange={(event) => setRuntimePolicy({ ...runtimePolicy, queue_timeout_seconds: Number(event.target.value) })} />}
            />
            <SettingRow
              title={t("Maximum output characters")}
              description={t("The allowed prefix is preserved, then the Agent process is cancelled.")}
              control={<Input aria-label={t("Maximum output characters")} type="number" className="w-32" min={1000} max={2000000} step={1000} value={runtimePolicy.max_output_chars} onChange={(event) => setRuntimePolicy({ ...runtimePolicy, max_output_chars: Number(event.target.value) })} />}
            />
          </>
        )}
      </SettingSection>

      {options.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={t("No agent CLIs detected")}
          description={t(
            "Install a supported agent CLI (Claude Code, Codex, Gemini, Kimi, MiMo, opencode) on the server to enable consultation.",
          )}
        />
      ) : (
        <div className="space-y-3">
          {options.map((option) => {
            const draft = drafts[option.kind];
            if (!draft) return null;
            const modelValues = option.models.map((m) => m.slug);
            const modelIsKnown =
              draft.model === "" || modelValues.includes(draft.model);
            return (
              <section key={option.kind} className="surface p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {option.display_name}
                      </span>
                      {option.available ? (
                        <Badge variant="success">
                          {t("Installed")}
                          {option.version ? ` · ${option.version}` : ""}
                        </Badge>
                      ) : (
                        <Badge variant="outline">{t("Not installed")}</Badge>
                      )}
                    </div>
                    {option.detail && !option.available && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {option.detail}
                      </p>
                    )}
                  </div>
                  <Toggle
                    checked={draft.enabled}
                    onCheckedChange={(v) => patch(option.kind, { enabled: v })}
                    disabled={!option.available}
                    aria-label={t("Enable {{name}}", {
                      name: option.display_name,
                    })}
                  />
                </div>

                {draft.enabled && option.available && (
                  <div
                    className={cn(
                      "mt-4 grid gap-4 border-t border-border pt-4",
                      option.efforts.length > 0
                        ? "sm:grid-cols-2"
                        : "sm:grid-cols-1",
                    )}
                  >
                    <div>
                      <div className="mb-1.5 text-xs text-muted-foreground">
                        {t("Model")}
                      </div>
                      <Select
                        aria-label={`${option.display_name} · ${t("Model")}`}
                        value={
                          modelIsKnown ? draft.model || CLI_DEFAULT : draft.model
                        }
                        onChange={(e) =>
                          patch(option.kind, {
                            model:
                              e.target.value === CLI_DEFAULT
                                ? ""
                                : e.target.value,
                          })
                        }
                      >
                        <option value={CLI_DEFAULT}>
                          {t("CLI default ({{model}})", {
                            model: option.default_model || "—",
                          })}
                        </option>
                        {option.models.map((m) => (
                          <option key={m.slug} value={m.slug}>
                            {m.display_name}
                          </option>
                        ))}
                        {!modelIsKnown && (
                          <option value={draft.model}>{draft.model}</option>
                        )}
                      </Select>
                    </div>
                    {option.efforts.length > 0 && (
                      <div>
                        <div className="mb-1.5 text-xs text-muted-foreground">
                          {t("Reasoning effort")}
                        </div>
                        <Select
                          aria-label={`${option.display_name} · ${t("Reasoning effort")}`}
                          value={draft.effort || CLI_DEFAULT}
                          onChange={(e) =>
                            patch(option.kind, {
                              effort:
                                e.target.value === CLI_DEFAULT
                                  ? ""
                                  : e.target.value,
                            })
                          }
                        >
                          <option value={CLI_DEFAULT}>
                            {t("CLI default")}
                          </option>
                          {option.efforts.map((effort) => (
                            <option key={effort} value={effort}>
                              {effort}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </div>
                )}
                <div className="mt-3 border-t border-border pt-3 text-right">
                  <Link href={`/settings/agents/${encodeURIComponent(option.kind)}`} className="text-xs font-medium text-primary hover:underline">
                    {t("Advanced settings")}
                  </Link>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
