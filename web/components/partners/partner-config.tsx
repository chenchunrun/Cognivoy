"use client";

/**
 * Config tab: edit the partner's identity (name / description / reply
 * language), model routing (primary + backup), tool surface (system /
 * built-in / MCP), and channel wiring (schema-driven per channel).
 *
 * Saves go through `PATCH /api/v1/partners/{id}` per section so a failed
 * section (e.g. a 422 on channel validation) doesn't roll back the rest.
 */

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import {
  getChannelSchemas,
  getPartner,
  getToolOptions,
  updatePartner,
  type ChannelSchemaEntry,
  type ChannelsSchemaResponse,
  type PartnerInfo,
  type ToolOptions,
} from "@/lib/partners-api";
import {
  listLLMOptions,
  llmSelectionKey,
  type LLMOption,
} from "@/lib/llm-options";
import type { LLMSelection } from "@/lib/unified-ws";
import {
  Button,
  Input,
  Select,
  Skeleton,
  useToast,
} from "@/components/ui";
import {
  ChannelConfigFields,
  useSecretReveal,
} from "./channel-config-fields";
import { validateChannelConfig } from "@/lib/partner-channel-validation";

const LEGACY_GLOBAL_DELIVERY_KEYS = new Set([
  "send_progress",
  "send_tool_hints",
  "sendProgress",
  "sendToolHints",
]);

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

function toLocalDateTimeInput(value: string | undefined) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return "";
  const local = new Date(parsed.valueOf() - parsed.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function stripLegacyGlobalDelivery(channels: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(channels).filter(
      ([key]) => !LEGACY_GLOBAL_DELIVERY_KEYS.has(key),
    ),
  );
}

function Section({
  title,
  description,
  children,
  action,
  visible = true,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  visible?: boolean;
}) {
  if (!visible) return null;
  return (
    <section className="surface p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {description && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function ToggleRow({
  name,
  description,
  checked,
  onToggle,
}: {
  name: string;
  description?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 accent-[var(--primary)]"
      />
      <span className="min-w-0">
        <span className="block text-sm text-foreground">{name}</span>
        {description && (
          <span className="block truncate text-xs text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export function PartnerConfig({
  partner,
  onUpdated,
  view = "all",
}: {
  partner: PartnerInfo;
  onUpdated: (next: PartnerInfo) => void;
  view?: "all" | "overview" | "capabilities" | "channels" | "proactive";
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const partnerId = partner.partner_id;

  // ── identity ────────────────────────────────────────────────────
  const [name, setName] = React.useState(partner.name);
  const [description, setDescription] = React.useState(partner.description ?? "");
  const [language, setLanguage] = React.useState(partner.language ?? "");
  const [savingIdentity, setSavingIdentity] = React.useState(false);
  const [proactiveLearning, setProactiveLearning] = React.useState(
    partner.proactive_learning ?? false,
  );
  const [reviewDelay, setReviewDelay] = React.useState(
    partner.proactive_review_delay_hours ?? 24,
  );
  const [lowScoreThreshold, setLowScoreThreshold] = React.useState(
    Math.round((partner.proactive_low_score_threshold ?? 0.6) * 100),
  );
  const [proactiveGoal, setProactiveGoal] = React.useState(
    partner.proactive_goal ?? "",
  );
  const [proactiveTimezone, setProactiveTimezone] = React.useState(
    partner.proactive_timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC",
  );
  const [allowedStart, setAllowedStart] = React.useState(
    partner.proactive_allowed_start ?? "09:00",
  );
  const [allowedEnd, setAllowedEnd] = React.useState(
    partner.proactive_allowed_end ?? "21:00",
  );
  const [allowedWeekdays, setAllowedWeekdays] = React.useState<number[]>(
    partner.proactive_allowed_weekdays ?? [0, 1, 2, 3, 4, 5, 6],
  );
  const [proactiveFrequency, setProactiveFrequency] = React.useState<
    "as_needed" | "daily" | "weekly"
  >(partner.proactive_frequency ?? "as_needed");
  const [preferredChannel, setPreferredChannel] = React.useState(
    partner.proactive_preferred_channel ?? "",
  );
  const [pausedUntil, setPausedUntil] = React.useState(
    toLocalDateTimeInput(partner.proactive_paused_until),
  );
  const [minInterval, setMinInterval] = React.useState(
    partner.proactive_min_interval_hours ?? 24,
  );
  const [maxPerDay, setMaxPerDay] = React.useState(
    partner.proactive_max_per_day ?? 1,
  );
  const [mergeWindow, setMergeWindow] = React.useState(
    partner.proactive_merge_window_hours ?? 6,
  );
  const [savingProactive, setSavingProactive] = React.useState(false);

  // ── model ───────────────────────────────────────────────────────
  const [llmOptions, setLLMOptions] = React.useState<LLMOption[] | null>(null);
  const [selection, setSelection] = React.useState<LLMSelection | null>(
    partner.llm_selection ?? null,
  );
  const [backupSelection, setBackupSelection] =
    React.useState<LLMSelection | null>(partner.backup_llm_selection ?? null);
  const [savingModel, setSavingModel] = React.useState(false);

  // ── tools ───────────────────────────────────────────────────────
  const [toolOptions, setToolOptions] = React.useState<ToolOptions | null>(null);
  const [enabledTools, setEnabledTools] = React.useState<string[]>([]);
  const [builtinTools, setBuiltinTools] = React.useState<string[]>([]);
  const [mcpTools, setMcpTools] = React.useState<string[]>([]);
  const [savingTools, setSavingTools] = React.useState(false);

  // ── channels ────────────────────────────────────────────────────
  const [catalog, setCatalog] = React.useState<ChannelsSchemaResponse | null>(
    null,
  );
  const [channels, setChannels] = React.useState<Record<string, unknown>>({});
  const [activeChannel, setActiveChannel] = React.useState<string>("");
  const [channelsLoading, setChannelsLoading] = React.useState(true);
  const [savingChannels, setSavingChannels] = React.useState(false);
  const { revealed, toggleSecret } = useSecretReveal();

  React.useEffect(() => {
    void listLLMOptions()
      .then((payload) => setLLMOptions(payload.options))
      .catch(() => setLLMOptions([]));
    void getToolOptions()
      .then((options) => {
        setToolOptions(options);
        setEnabledTools(
          partner.enabled_tools ?? options.tools.map((tool) => tool.name),
        );
        setBuiltinTools(
          partner.builtin_tools ?? options.builtin_tools.map((tool) => tool.name),
        );
        setMcpTools(partner.mcp_tools ?? []);
      })
      .catch(() => setToolOptions(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per partner
  }, [partnerId]);

  // Channel edit needs raw secrets to populate fields; the default GET masks
  // them, so load the detail with include_secrets.
  React.useEffect(() => {
    let cancelled = false;
    setChannelsLoading(true);
    void Promise.all([
      getChannelSchemas(),
      getPartner(partnerId, { includeSecrets: true }),
    ])
      .then(([schemaCatalog, detail]) => {
        if (cancelled) return;
        setCatalog(schemaCatalog);
        const raw =
          detail.channels && !Array.isArray(detail.channels)
            ? (detail.channels as Record<string, unknown>)
            : {};
        const cleaned = stripLegacyGlobalDelivery(raw);
        setChannels(cleaned);
        const names = Object.keys(schemaCatalog.channels);
        const enabled = names.find((n) => {
          const cfg = cleaned[n];
          return (
            cfg &&
            typeof cfg === "object" &&
            (cfg as Record<string, unknown>).enabled === true
          );
        });
        setActiveChannel(enabled ?? names[0] ?? "");
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      })
      .finally(() => {
        if (!cancelled) setChannelsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [partnerId]);

  const fail = (e: unknown, fallback: string) =>
    toast({
      title: e instanceof Error ? e.message : fallback,
      variant: "destructive",
    });

  const saveIdentity = async () => {
    if (!name.trim()) return;
    setSavingIdentity(true);
    try {
      const next = await updatePartner(partnerId, {
        name: name.trim(),
        description: description.trim() || undefined,
        language: language || undefined,
      });
      onUpdated(next);
      toast({ title: t("Partner updated"), variant: "success" });
    } catch (e) {
      fail(e, t("Save failed"));
    } finally {
      setSavingIdentity(false);
    }
  };

  const saveModel = async () => {
    setSavingModel(true);
    try {
      const next = await updatePartner(partnerId, {
        llm_selection: selection,
        backup_llm_selection: backupSelection,
      });
      onUpdated(next);
      toast({ title: t("Model routing saved"), variant: "success" });
    } catch (e) {
      fail(e, t("Save failed"));
    } finally {
      setSavingModel(false);
    }
  };

  const saveProactiveLearning = async () => {
    setSavingProactive(true);
    try {
      const next = await updatePartner(partnerId, {
        proactive_learning: proactiveLearning,
        proactive_review_delay_hours: reviewDelay,
        proactive_low_score_threshold: lowScoreThreshold / 100,
        proactive_goal: proactiveGoal.trim(),
        proactive_timezone: proactiveTimezone.trim() || "UTC",
        proactive_allowed_start: allowedStart,
        proactive_allowed_end: allowedEnd,
        proactive_allowed_weekdays: allowedWeekdays,
        proactive_frequency: proactiveFrequency,
        proactive_preferred_channel: preferredChannel,
        proactive_paused_until: pausedUntil
          ? new Date(pausedUntil).toISOString()
          : "",
        proactive_min_interval_hours: minInterval,
        proactive_max_per_day: maxPerDay,
        proactive_merge_window_hours: mergeWindow,
      });
      onUpdated(next);
      toast({ title: t("Proactive learning saved"), variant: "success" });
    } catch (e) {
      fail(e, t("Save failed"));
    } finally {
      setSavingProactive(false);
    }
  };

  const saveTools = async () => {
    if (!toolOptions) return;
    setSavingTools(true);
    try {
      const allTools = toolOptions.tools.map((tool) => tool.name);
      const allBuiltin = toolOptions.builtin_tools.map((tool) => tool.name);
      const next = await updatePartner(partnerId, {
        // Everything selected → persist null so newly configured tools are
        // picked up automatically later.
        enabled_tools:
          enabledTools.length === allTools.length ? null : enabledTools,
        builtin_tools:
          builtinTools.length === allBuiltin.length ? null : builtinTools,
        // Never null for MCP: the list stays explicit so a server configured
        // later is not silently inherited by this partner.
        mcp_tools: mcpTools,
      });
      onUpdated(next);
      toast({ title: t("Tools saved"), variant: "success" });
    } catch (e) {
      fail(e, t("Save failed"));
    } finally {
      setSavingTools(false);
    }
  };

  const saveChannels = async () => {
    if (!catalog) return;
    const invalid = Object.entries(channels).flatMap(([channel, raw]) => {
      const entry = catalog.channels[channel];
      if (!entry || !raw || typeof raw !== "object") return [channel];
      return validateChannelConfig(
        entry,
        raw as Record<string, unknown>,
      ).map((field) => `${entry.display_name || channel}: ${field}`);
    });
    if (invalid.length > 0) {
      toast({
        title: t("Complete required channel settings"),
        description: invalid.join(", "),
        variant: "destructive",
      });
      return;
    }
    setSavingChannels(true);
    try {
      const next = await updatePartner(partnerId, {
        channels: stripLegacyGlobalDelivery(channels),
      });
      onUpdated(next);
      toast({ title: t("Channels saved"), variant: "success" });
    } catch (e) {
      fail(e, t("Invalid channel configuration"));
    } finally {
      setSavingChannels(false);
    }
  };

  const toggleInList = (
    list: string[],
    nameToToggle: string,
    setter: (next: string[]) => void,
  ) => {
    setter(
      list.includes(nameToToggle)
        ? list.filter((n) => n !== nameToToggle)
        : [...list, nameToToggle],
    );
  };

  const channelEntries: [string, ChannelSchemaEntry][] = catalog
    ? Object.entries(catalog.channels)
    : [];
  const activeEntry = catalog?.channels[activeChannel];
  const activeConfigured = activeChannel
    ? channels[activeChannel] !== undefined
    : false;

  const addChannel = () => {
    if (!activeEntry) return;
    setChannels((prev) => ({
      ...prev,
      [activeChannel]: { ...activeEntry.default_config, enabled: true },
    }));
  };

  const removeChannel = () => {
    setChannels((prev) => {
      const next = { ...prev };
      delete next[activeChannel];
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <Section
        visible={view === "all" || view === "overview"}
        title={t("Identity")}
        action={
          <Button
            size="sm"
            onClick={() => void saveIdentity()}
            loading={savingIdentity}
            disabled={!name.trim()}
          >
            {t("Save")}
          </Button>
        }
      >
        <div className="space-y-4">
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              {t("Name")}
            </span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              {t("Description")}
            </span>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("What is this partner for?")}
            />
          </div>
          <div>
            <span className="mb-1.5 block text-sm font-medium text-foreground">
              {t("Reply language")}
            </span>
            <Select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="w-48"
            >
              <option value="">{t("Auto (English)")}</option>
              <option value="en">English</option>
              <option value="zh">中文</option>
            </Select>
          </div>
        </div>
      </Section>

      <Section
        visible={view === "all" || view === "proactive"}
        title={t("Proactive learning")}
        description={t(
          "Schedule a spaced-review message after a low quiz score. This is opt-in and uses the partner's existing delivery channel.",
        )}
        action={
          <Button
            size="sm"
            onClick={() => void saveProactiveLearning()}
            loading={savingProactive}
          >
            {t("Save")}
          </Button>
        }
      >
        <div className="space-y-4">
          <ToggleRow
            name={t("Enable proactive review reminders")}
            description={t(
              "Low scores create one deduplicated review reminder for this partner.",
            )}
            checked={proactiveLearning}
            onToggle={() => setProactiveLearning((current) => !current)}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Review delay (hours)")}
              </span>
              <Input
                type="number"
                min={1}
                max={720}
                value={reviewDelay}
                disabled={!proactiveLearning}
                onChange={(event) =>
                  setReviewDelay(
                    Math.min(720, Math.max(1, Number(event.target.value) || 1)),
                  )
                }
              />
            </label>
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Low-score threshold (%)")}
              </span>
              <Input
                type="number"
                min={0}
                max={100}
                value={lowScoreThreshold}
                disabled={!proactiveLearning}
                onChange={(event) =>
                  setLowScoreThreshold(
                    Math.min(100, Math.max(0, Number(event.target.value) || 0)),
                  )
                }
              />
            </label>
          </div>
          <div>
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("Learning goal")}
            </span>
            <Input
              value={proactiveGoal}
              disabled={!proactiveLearning}
              maxLength={500}
              onChange={(event) => setProactiveGoal(event.target.value)}
              placeholder={t("What long-term outcome should this tutor help achieve?")}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Timezone")}
              </span>
              <Input
                value={proactiveTimezone}
                disabled={!proactiveLearning}
                onChange={(event) => setProactiveTimezone(event.target.value)}
              />
            </label>
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Allowed from")}
              </span>
              <Input
                type="time"
                value={allowedStart}
                disabled={!proactiveLearning}
                onChange={(event) => setAllowedStart(event.target.value)}
              />
            </label>
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Allowed until")}
              </span>
              <Input
                type="time"
                value={allowedEnd}
                disabled={!proactiveLearning}
                onChange={(event) => setAllowedEnd(event.target.value)}
              />
            </label>
          </div>
          <div>
            <span className="mb-1.5 block text-xs text-muted-foreground">
              {t("Allowed weekdays")}
            </span>
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((day, index) => {
                const selected = allowedWeekdays.includes(index);
                return (
                  <Button
                    key={day}
                    type="button"
                    size="sm"
                    variant={selected ? "secondary" : "outline"}
                    disabled={!proactiveLearning || (selected && allowedWeekdays.length === 1)}
                    aria-pressed={selected}
                    onClick={() =>
                      setAllowedWeekdays((current) =>
                        selected
                          ? current.filter((value) => value !== index)
                          : [...current, index].sort(),
                      )
                    }
                  >
                    {t(day).slice(0, 3)}
                  </Button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Frequency")}
              </span>
              <Select
                value={proactiveFrequency}
                disabled={!proactiveLearning}
                onChange={(event) =>
                  setProactiveFrequency(
                    event.target.value as "as_needed" | "daily" | "weekly",
                  )
                }
              >
                <option value="as_needed">{t("As needed")}</option>
                <option value="daily">{t("At most daily")}</option>
                <option value="weekly">{t("At most weekly")}</option>
              </Select>
            </label>
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Delivery channel")}
              </span>
              <Select
                value={preferredChannel}
                disabled={!proactiveLearning}
                onChange={(event) => setPreferredChannel(event.target.value)}
              >
                <option value="">{t("Automatic")}</option>
                {Object.keys(channels).map((channel) => (
                  <option key={channel} value={channel}>{channel}</option>
                ))}
              </Select>
            </label>
          </div>
          <div>
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("Do not disturb until")}
            </span>
            <Input
              type="datetime-local"
              value={pausedUntil}
              disabled={!proactiveLearning}
              onChange={(event) => setPausedUntil(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Leave empty to allow reminders under the normal schedule.")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Minimum interval (hours)")}
              </span>
              <Input
                type="number"
                min={0}
                max={720}
                value={minInterval}
                disabled={!proactiveLearning}
                onChange={(event) => setMinInterval(Math.min(720, Math.max(0, Number(event.target.value) || 0)))}
              />
            </label>
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Daily limit")}
              </span>
              <Input
                type="number"
                min={1}
                max={24}
                value={maxPerDay}
                disabled={!proactiveLearning}
                onChange={(event) => setMaxPerDay(Math.min(24, Math.max(1, Number(event.target.value) || 1)))}
              />
            </label>
            <label className="text-sm text-foreground">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("Merge window (hours)")}
              </span>
              <Input
                type="number"
                min={0}
                max={72}
                value={mergeWindow}
                disabled={!proactiveLearning}
                onChange={(event) => setMergeWindow(Math.min(72, Math.max(0, Number(event.target.value) || 0)))}
              />
            </label>
          </div>
        </div>
      </Section>

      <Section
        visible={view === "all" || view === "overview"}
        title={t("Model")}
        description={t("The model this partner thinks with.")}
        action={
          <Button
            size="sm"
            onClick={() => void saveModel()}
            loading={savingModel}
          >
            {t("Save")}
          </Button>
        }
      >
        {!llmOptions ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <span className="mb-1.5 block text-sm font-medium text-foreground">
                {t("Primary model")}
              </span>
              <Select
                value={llmSelectionKey(selection)}
                onChange={(e) => {
                  const opt = llmOptions.find(
                    (o) => llmSelectionKey(o) === e.target.value,
                  );
                  setSelection(
                    opt
                      ? { profile_id: opt.profile_id, model_id: opt.model_id }
                      : null,
                  );
                }}
              >
                <option value="">{t("System default")}</option>
                {llmOptions.map((opt) => (
                  <option
                    key={llmSelectionKey(opt)}
                    value={llmSelectionKey(opt)}
                  >
                    {opt.profile_name} · {opt.model_name || opt.model}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <span className="mb-1.5 block text-sm font-medium text-foreground">
                {t("Backup model")}
              </span>
              <Select
                value={llmSelectionKey(backupSelection)}
                onChange={(e) => {
                  const opt = llmOptions.find(
                    (o) => llmSelectionKey(o) === e.target.value,
                  );
                  setBackupSelection(
                    opt
                      ? { profile_id: opt.profile_id, model_id: opt.model_id }
                      : null,
                  );
                }}
              >
                <option value="">{t("No backup")}</option>
                {llmOptions.map((opt) => (
                  <option
                    key={llmSelectionKey(opt)}
                    value={llmSelectionKey(opt)}
                  >
                    {opt.profile_name} · {opt.model_name || opt.model}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("Used to retry a failed turn before giving up.")}
              </p>
            </div>
          </div>
        )}
      </Section>

      <Section
        visible={view === "all" || view === "capabilities"}
        title={t("Tools")}
        description={t(
          "The tools this partner may use. Everything selected inherits new tools automatically.",
        )}
        action={
          <Button
            size="sm"
            onClick={() => void saveTools()}
            loading={savingTools}
            disabled={!toolOptions}
          >
            {t("Save")}
          </Button>
        }
      >
        {!toolOptions ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-4">
            <div>
              <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("System tools")}
              </h4>
              <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                {toolOptions.tools.map((tool) => (
                  <ToggleRow
                    key={tool.name}
                    name={tool.name}
                    description={tool.description}
                    checked={enabledTools.includes(tool.name)}
                    onToggle={() =>
                      toggleInList(enabledTools, tool.name, setEnabledTools)
                    }
                  />
                ))}
              </div>
            </div>
            {toolOptions.builtin_tools.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("Built-in tools")}
                </h4>
                <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                  {toolOptions.builtin_tools.map((tool) => (
                    <ToggleRow
                      key={tool.name}
                      name={tool.name}
                      description={tool.description}
                      checked={builtinTools.includes(tool.name)}
                      onToggle={() =>
                        toggleInList(builtinTools, tool.name, setBuiltinTools)
                      }
                    />
                  ))}
                </div>
              </div>
            )}
            {toolOptions.mcp_tools.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("MCP tools")}
                </h4>
                <div className="grid grid-cols-1 gap-0.5 sm:grid-cols-2">
                  {toolOptions.mcp_tools.map((tool) => (
                    <ToggleRow
                      key={tool.name}
                      name={tool.name}
                      description={tool.description}
                      checked={mcpTools.includes(tool.name)}
                      onToggle={() =>
                        toggleInList(mcpTools, tool.name, setMcpTools)
                      }
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Section>

      <Section
        visible={view === "all" || view === "channels"}
        title={t("Channels")}
        description={t(
          "Where this partner listens and replies — Feishu, Telegram, Slack and more.",
        )}
        action={
          <Button
            size="sm"
            onClick={() => void saveChannels()}
            loading={savingChannels}
            disabled={channelsLoading || !catalog}
          >
            {t("Save")}
          </Button>
        }
      >
        {channelsLoading || !catalog ? (
          <Skeleton className="h-32 w-full" />
        ) : channelEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("No channels are available on the server.")}
          </p>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Select
                value={activeChannel}
                onChange={(e) => setActiveChannel(e.target.value)}
                className="w-56"
              >
                {channelEntries.map(([key, entry]) => (
                  <option key={key} value={key}>
                    {entry.display_name || key}
                    {channels[key] !== undefined ? " ✓" : ""}
                  </option>
                ))}
              </Select>
              {activeConfigured ? (
                <Button size="sm" variant="outline" onClick={removeChannel}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("Disconnect")}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={addChannel}>
                  <Plus className="h-3.5 w-3.5" />
                  {t("Connect")}
                </Button>
              )}
            </div>
            {activeEntry &&
              (activeConfigured ? (
                <ChannelConfigFields
                  entry={activeEntry}
                  value={
                    (channels[activeChannel] as Record<string, unknown>) ?? {}
                  }
                  onChange={(next) =>
                    setChannels((prev) => ({ ...prev, [activeChannel]: next }))
                  }
                  revealed={revealed}
                  toggleSecret={toggleSecret}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t(
                    "This channel is not connected yet. Connect it to configure its credentials.",
                  )}
                </p>
              ))}
          </div>
        )}
      </Section>
    </div>
  );
}
