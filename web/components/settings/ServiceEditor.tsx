"use client";

import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Eye,
  EyeOff,
  Plus,
  Terminal,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import { invalidateLLMOptionsCache } from "@/lib/llm-options";
import { defaultSearchProvider } from "@/lib/service-defaults";
import { cn } from "@/lib/utils";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Select,
  Skeleton,
  Toggle,
  useToast,
} from "@/components/ui";
import { SettingsPageHeader } from "./shared";
import {
  type Catalog,
  type CatalogModel,
  type CatalogProfile,
  type ProviderOption,
  type ServiceName,
  cloneCatalog,
  getActiveModel,
  getActiveProfile,
  isGenerationService,
  isVoiceService,
} from "./catalog";

const TTS_FORMATS = ["mp3", "wav", "opus", "aac", "flac", "pcm"] as const;

interface SettingsPayload {
  catalog?: Catalog;
  providers?: Record<ServiceName, ProviderOption[]>;
}

function FieldLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor: string;
}) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs text-muted-foreground">
      {children}
    </label>
  );
}

/**
 * Shared editor for the seven model services (llm / embedding / search / tts /
 * stt / imagegen / videogen). Loads the model catalog once, edits the slice for
 * `service`, persists only that service via POST /settings/apply-service, and
 * streams a connection test from /settings/tests/{service}/start over SSE.
 */
export function ServiceEditor({
  service,
  title,
  description,
}: {
  service: ServiceName;
  title: string;
  description: string;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [draft, setDraft] = React.useState<Catalog | null>(null);
  const [snapshot, setSnapshot] = React.useState<Catalog | null>(null);
  const [providers, setProviders] = React.useState<ProviderOption[]>([]);
  const [editable, setEditable] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const [showApiKey, setShowApiKey] = React.useState(false);
  const [confirmDeleteProfile, setConfirmDeleteProfile] = React.useState(false);
  const [confirmDeleteModel, setConfirmDeleteModel] = React.useState(false);

  const [testRunning, setTestRunning] = React.useState(false);
  const [logs, setLogs] = React.useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
  const eventSourceRef = React.useRef<EventSource | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as SettingsPayload;
      if (payload.catalog) {
        setDraft(cloneCatalog(payload.catalog));
        setSnapshot(cloneCatalog(payload.catalog));
        setEditable(true);
      } else {
        setEditable(false);
      }
      setProviders(payload.providers?.[service] ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [service]);

  React.useEffect(() => {
    void load();
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [load]);

  const mutate = React.useCallback(
    (mutator: (next: Catalog) => void) => {
      setDraft((current) => {
        if (!current) return current;
        const next = cloneCatalog(current);
        mutator(next);
        return next;
      });
    },
    [],
  );

  const dirty = React.useMemo(() => {
    if (!draft || !snapshot) return false;
    return (
      JSON.stringify(draft.services[service]) !==
      JSON.stringify(snapshot.services[service])
    );
  }, [draft, snapshot, service]);

  const activeProfile = draft ? getActiveProfile(draft, service) : null;
  const activeModel = draft ? getActiveModel(draft, service) : null;
  const activeProviderValue =
    service === "search"
      ? (activeProfile?.provider ?? "")
      : (activeProfile?.binding ?? "");
  const activeProviderOption = providers.find(
    (option) => option.value === activeProviderValue,
  );

  // ── Mutations ────────────────────────────────────────────────────────────

  function selectProfile(profileId: string) {
    mutate((next) => {
      const slice = next.services[service];
      slice.active_profile_id = profileId;
      if (service !== "search") {
        const profile = slice.profiles.find((p) => p.id === profileId);
        slice.active_model_id = profile?.models[0]?.id ?? null;
      }
    });
    setShowApiKey(false);
  }

  function addProfile() {
    mutate((next) => {
      const slice = next.services[service];
      const providerKey =
        service === "search"
          ? defaultSearchProvider(providers)
          : (providers.find((p) => p.value === "openai")?.value ??
            providers[0]?.value ??
            "");
      const providerOption = providers.find((p) => p.value === providerKey);
      const profileId = `${service}-profile-${Date.now()}`;
      const profile: CatalogProfile = {
        id: profileId,
        name: providerOption?.label ?? t("New Profile"),
        binding: service === "search" ? undefined : providerKey,
        provider: service === "search" ? providerKey : undefined,
        base_url: "",
        api_key: "",
        api_version: "",
        proxy: service === "search" ? "" : undefined,
        models: [],
      };
      if (service !== "search") {
        const modelId = `${service}-model-${Date.now()}`;
        profile.models.push({
          id: modelId,
          name: t("Model {{index}}", { index: 1 }),
          model:
            isVoiceService(service) || isGenerationService(service)
              ? (providerOption?.default_model ?? "")
              : "",
          ...(service === "embedding"
            ? {
                dimension: providerOption?.default_dim ?? "",
                send_dimensions: true,
              }
            : {}),
          ...(service === "tts"
            ? {
                voice: providerOption?.default_voice ?? "",
                response_format: "mp3",
              }
            : {}),
        });
        slice.active_model_id = modelId;
      }
      slice.profiles.push(profile);
      slice.active_profile_id = profileId;
    });
    setShowApiKey(false);
  }

  function deleteActiveProfile() {
    mutate((next) => {
      const slice = next.services[service];
      slice.profiles = slice.profiles.filter(
        (p) => p.id !== slice.active_profile_id,
      );
      slice.active_profile_id = slice.profiles[0]?.id ?? null;
      if (service !== "search") {
        slice.active_model_id = slice.profiles[0]?.models[0]?.id ?? null;
      }
    });
  }

  function addModel() {
    if (service === "search") return;
    mutate((next) => {
      const slice = next.services[service];
      const profile = getActiveProfile(next, service);
      if (!profile) return;
      const providerOption = providers.find((p) => p.value === profile.binding);
      const modelId = `${service}-model-${Date.now()}`;
      profile.models.push({
        id: modelId,
        name: t("Model {{index}}", { index: profile.models.length + 1 }),
        model:
          isVoiceService(service) || isGenerationService(service)
            ? (providerOption?.default_model ?? "")
            : "",
        ...(service === "embedding"
          ? {
              dimension:
                providerOption?.default_dim ??
                providers.find((p) => p.value === profile.binding)
                  ?.default_dim ??
                "",
              send_dimensions: true,
            }
          : {}),
        ...(service === "tts"
          ? { voice: providerOption?.default_voice ?? "", response_format: "mp3" }
          : {}),
      });
      slice.active_model_id = modelId;
    });
  }

  function deleteActiveModel() {
    if (service === "search") return;
    mutate((next) => {
      const slice = next.services[service];
      const profile = getActiveProfile(next, service);
      if (!profile) return;
      profile.models = profile.models.filter(
        (m) => m.id !== slice.active_model_id,
      );
      slice.active_model_id = profile.models[0]?.id ?? null;
    });
  }

  function updateProfileField(field: keyof CatalogProfile, value: string) {
    mutate((next) => {
      const profile = getActiveProfile(next, service);
      if (!profile) return;
      (profile[field] as string | undefined) = value;
    });
  }

  function updateProvider(value: string) {
    mutate((next) => {
      const profile = getActiveProfile(next, service);
      if (!profile) return;
      if (service === "search") {
        profile.provider = value;
      } else {
        profile.binding = value;
      }
      if (!profile.name || providers.some((p) => p.label === profile.name)) {
        profile.name =
          providers.find((p) => p.value === value)?.label ?? profile.name;
      }
    });
  }

  function updateModelField(field: keyof CatalogModel, value: string) {
    mutate((next) => {
      const model = getActiveModel(next, service);
      if (!model) return;
      (model[field] as string | undefined) = value;
    });
  }

  // ── Save / test ──────────────────────────────────────────────────────────

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/apply-service"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service,
          service_catalog: draft.services[service],
          expected_service_catalog: snapshot?.services[service],
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        catalog?: Catalog;
        detail?: string;
      };
      if (!res.ok || !payload.catalog) {
        throw new Error(payload.detail || `HTTP ${res.status}`);
      }
      setSnapshot(cloneCatalog(payload.catalog));
      setDraft(cloneCatalog(payload.catalog));
      invalidateLLMOptionsCache();
      toast({ title: t("Settings applied"), variant: "success" });
    } catch (err) {
      toast({
        title: t("Failed to save settings"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    if (!draft || testRunning) return;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setDiagnosticsOpen(true);
    setLogs("");
    setTestRunning(true);
    try {
      const res = await apiFetch(
        apiUrl(`/api/v1/settings/tests/${service}/start`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ catalog: draft }),
        },
      );
      const payload = (await res.json().catch(() => ({}))) as {
        run_id?: string;
        detail?: string;
      };
      if (!res.ok || !payload.run_id) {
        throw new Error(payload.detail || t("Could not start diagnostics."));
      }
      const source = new EventSource(
        apiUrl(`/api/v1/settings/tests/${service}/${payload.run_id}/events`),
        { withCredentials: true },
      );
      eventSourceRef.current = source;
      source.onmessage = (event) => {
        const entry = JSON.parse(event.data) as {
          type: string;
          message: string;
        };
        setLogs((current) => `${current}[${entry.type}] ${entry.message}\n`);
        if (entry.type === "completed" || entry.type === "failed") {
          source.close();
          eventSourceRef.current = null;
          setTestRunning(false);
          toast({
            title: entry.message,
            variant: entry.type === "completed" ? "success" : "destructive",
          });
        }
      };
      source.onerror = () => {
        source.close();
        eventSourceRef.current = null;
        setTestRunning(false);
        setLogs(
          (current) =>
            `${current}[failed] ${t("Diagnostics stream disconnected.")}\n`,
        );
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLogs((current) => `${current}[failed] ${message}\n`);
      setTestRunning(false);
      toast({ title: message, variant: "destructive" });
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div>
        <SettingsPageHeader title={title} description={description} />
        <div className="flex flex-col gap-4 md:flex-row">
          <Skeleton className="h-64 md:w-52" />
          <div className="flex-1 space-y-4">
            <Skeleton className="h-56" />
            <Skeleton className="h-40" />
          </div>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div>
        <SettingsPageHeader title={title} description={description} />
        <EmptyState
          icon={AlertCircle}
          title={t("Couldn't load settings")}
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

  if (!editable || !draft) {
    return (
      <div>
        <SettingsPageHeader title={title} description={description} />
        <EmptyState
          icon={AlertCircle}
          title={t("Model endpoints are managed by your administrator")}
          description={t(
            "You can still personalize theme and language under Appearance.",
          )}
        />
      </div>
    );
  }

  return (
    <div>
      <SettingsPageHeader
        title={title}
        description={description}
        action={
          <Button
            size="sm"
            onClick={() => void save()}
            loading={saving}
            disabled={!dirty}
          >
            {t("Save & apply")}
          </Button>
        }
      />

      {!activeProfile ? (
        <EmptyState
          icon={service === "search" ? CheckCircle2 : Plus}
          title={
            service === "search"
              ? t("Built-in search is active")
              : t("No profiles configured")
          }
          description={
            service === "search"
              ? t(
                  "DuckDuckGo is available without an API key. Create a profile only when you want to override the default provider.",
                )
              : t("Add a profile to connect a provider.")
          }
          action={
            <Button variant="outline" size="sm" onClick={addProfile}>
              <Plus size={14} />
              {service === "search"
                ? t("Create custom configuration")
                : t("Add profile")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-5 md:flex-row">
          {/* Profile list */}
          <aside className="surface shrink-0 self-start p-2 md:w-52">
            <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {t("Profiles")}
            </div>
            <div className="space-y-0.5">
              {draft.services[service].profiles.map((profile) => {
                const isActive =
                  profile.id === draft.services[service].active_profile_id;
                const detail =
                  service === "search" ? profile.provider : profile.binding;
                return (
                  <button
                    key={profile.id}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => selectProfile(profile.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors duration-150",
                      isActive
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full border",
                        isActive
                          ? "border-primary bg-primary"
                          : "border-border bg-transparent",
                      )}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium leading-tight">
                        {profile.name}
                      </span>
                      {detail && (
                        <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">
                          {detail}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              <Button variant="ghost" size="sm" onClick={addProfile}>
                <Plus size={13} />
                {t("Profile")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => setConfirmDeleteProfile(true)}
                aria-label={t("Delete profile")}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          </aside>

          {/* Editor column */}
          <div className="min-w-0 flex-1 space-y-5">
            {/* Provider connection */}
            <section className="surface p-5">
              <h3 className="mb-4 text-sm font-medium text-foreground">
                {t("Provider connection")}
              </h3>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <FieldLabel htmlFor={`${service}-profile-name`}>{t("Profile name")}</FieldLabel>
                  <Input
                    id={`${service}-profile-name`}
                    value={activeProfile.name}
                    onChange={(e) =>
                      updateProfileField("name", e.target.value)
                    }
                  />
                </div>
                <div>
                  <FieldLabel htmlFor={`${service}-provider`}>{t("Provider")}</FieldLabel>
                  <Select
                    id={`${service}-provider`}
                    value={activeProviderValue}
                    onChange={(e) => updateProvider(e.target.value)}
                  >
                    {!providers.some((p) => p.value === activeProviderValue) && (
                      <option value={activeProviderValue}>
                        {activeProviderValue || t("Select a provider")}
                      </option>
                    )}
                    {providers.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <FieldLabel htmlFor={`${service}-api-key`}>{t("API key")}</FieldLabel>
                  <div className="relative">
                    <Input
                      id={`${service}-api-key`}
                      type={showApiKey ? "text" : "password"}
                      autoComplete="off"
                      className="pr-9"
                      placeholder={t("Paste API key")}
                      value={activeProfile.api_key}
                      onChange={(e) =>
                        updateProfileField("api_key", e.target.value)
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey((v) => !v)}
                      aria-label={
                        showApiKey ? t("Hide API key") : t("Show API key")
                      }
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
                <div>
                  <FieldLabel htmlFor={`${service}-base-url`}>{t("Base URL")}</FieldLabel>
                  <Input
                    id={`${service}-base-url`}
                    placeholder={activeProviderOption?.base_url ?? "https://"}
                    value={activeProfile.base_url}
                    onChange={(e) =>
                      updateProfileField("base_url", e.target.value)
                    }
                  />
                  {activeProviderOption?.base_url && (
                    <p className="mt-1.5 text-[11px] text-muted-foreground">
                      {t("Leave blank to use the provider default.")}
                    </p>
                  )}
                </div>
                {service === "search" && (
                  <>
                    <div>
                      <FieldLabel htmlFor={`${service}-max-results`}>{t("Max results")}</FieldLabel>
                      <Input
                        id={`${service}-max-results`}
                        type="number"
                        min={1}
                        max={50}
                        value={activeProfile.max_results ?? ""}
                        onChange={(e) =>
                          mutate((next) => {
                            const profile = getActiveProfile(next, service);
                            if (!profile) return;
                            const value = Number.parseInt(e.target.value, 10);
                            if (Number.isFinite(value)) {
                              profile.max_results = value;
                            } else {
                              delete profile.max_results;
                            }
                          })
                        }
                      />
                    </div>
                    <div>
                      <FieldLabel htmlFor={`${service}-proxy`}>{t("Proxy")}</FieldLabel>
                      <Input
                        id={`${service}-proxy`}
                        placeholder="http://127.0.0.1:7890"
                        value={activeProfile.proxy ?? ""}
                        onChange={(e) =>
                          updateProfileField("proxy", e.target.value)
                        }
                      />
                      <p className="mt-1.5 text-[11px] text-muted-foreground">
                        {t("Optional. Only used by providers that route through a proxy.")}
                      </p>
                    </div>
                  </>
                )}
              </div>
            </section>

            {/* Models */}
            {service !== "search" && (
              <section className="surface p-5">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium text-foreground">
                    {t("Models")}
                  </h3>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={addModel}>
                      <Plus size={13} />
                      {t("Model")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      disabled={!activeModel}
                      onClick={() => setConfirmDeleteModel(true)}
                      aria-label={t("Delete model")}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>

                {activeProfile.models.length > 0 && (
                  <div className="mb-4 flex flex-wrap items-center gap-1.5">
                    {activeProfile.models.map((model) => {
                      const isActive =
                        model.id === draft.services[service].active_model_id;
                      return (
                        <button
                          key={model.id}
                          type="button"
                          role="radio"
                          aria-checked={isActive}
                          onClick={() =>
                            mutate((next) => {
                              next.services[service].active_model_id = model.id;
                            })
                          }
                          className={cn(
                            "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] transition-colors duration-150",
                            isActive
                              ? "bg-muted font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {isActive && (
                            <CheckCircle2 size={13} className="text-primary" />
                          )}
                          <span className="max-w-56 truncate leading-none">
                            {model.name || model.model || t("Untitled model")}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {activeModel && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <FieldLabel htmlFor={`${service}-model-name`}>{t("Display name")}</FieldLabel>
                      <Input
                        id={`${service}-model-name`}
                        value={activeModel.name}
                        onChange={(e) =>
                          updateModelField("name", e.target.value)
                        }
                      />
                    </div>
                    <div>
                      <FieldLabel htmlFor={`${service}-model-id`}>{t("Model ID")}</FieldLabel>
                      <Input
                        id={`${service}-model-id`}
                        placeholder="gpt-4o"
                        value={activeModel.model}
                        onChange={(e) =>
                          updateModelField("model", e.target.value)
                        }
                      />
                    </div>

                    {service === "llm" && (
                      <div>
                        <FieldLabel htmlFor={`${service}-context-window`}>{t("Context window")}</FieldLabel>
                        <Input
                          id={`${service}-context-window`}
                          inputMode="numeric"
                          placeholder="65536"
                          value={activeModel.context_window ?? ""}
                          onChange={(e) =>
                            updateModelField(
                              "context_window",
                              e.target.value.replace(/[^\d]/g, ""),
                            )
                          }
                        />
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {t("Optional. Leave blank to use the detected or default window.")}
                        </p>
                      </div>
                    )}

                    {service === "embedding" && (
                      <div>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">
                            {t("Dimension")}
                          </span>
                          <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <Toggle
                              checked={activeModel.send_dimensions !== false}
                              onCheckedChange={(checked) =>
                                mutate((next) => {
                                  const model = getActiveModel(next, service);
                                  if (model) model.send_dimensions = checked;
                                })
                              }
                              aria-label={t("Send dimensions")}
                              className="scale-90"
                            />
                            {t("Send dimensions")}
                          </label>
                        </div>
                        <Input
                          aria-label={t("Dimension")}
                          inputMode="numeric"
                          placeholder={
                            providers.find(
                              (p) => p.value === activeProfile.binding,
                            )?.default_dim ?? "3072"
                          }
                          value={activeModel.dimension ?? ""}
                          onChange={(e) =>
                            updateModelField(
                              "dimension",
                              e.target.value.replace(/[^\d]/g, ""),
                            )
                          }
                        />
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {t(
                            "Some providers reject the dimensions parameter — turn off Send dimensions on HTTP 400.",
                          )}
                        </p>
                      </div>
                    )}

                    {service === "tts" && (
                      <>
                        <div>
                          <FieldLabel htmlFor={`${service}-voice`}>{t("Voice")}</FieldLabel>
                          <Input
                            id={`${service}-voice`}
                            placeholder="alloy"
                            value={activeModel.voice ?? ""}
                            onChange={(e) =>
                              updateModelField("voice", e.target.value)
                            }
                          />
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            {t(
                              "Provider-specific voice name, e.g. alloy (OpenAI) or model:voice (SiliconFlow).",
                            )}
                          </p>
                        </div>
                        <div>
                          <FieldLabel htmlFor={`${service}-output-format`}>{t("Output format")}</FieldLabel>
                          <Select
                            id={`${service}-output-format`}
                            value={activeModel.response_format || "mp3"}
                            onChange={(e) =>
                              updateModelField(
                                "response_format",
                                e.target.value,
                              )
                            }
                          >
                            {TTS_FORMATS.map((format) => (
                              <option key={format} value={format}>
                                {format}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </>
                    )}

                    {service === "stt" && (
                      <div>
                        <FieldLabel htmlFor={`${service}-language`}>{t("Language")}</FieldLabel>
                        <Input
                          id={`${service}-language`}
                          placeholder={t("auto")}
                          value={activeModel.language ?? ""}
                          onChange={(e) =>
                            updateModelField("language", e.target.value)
                          }
                        />
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {t("Optional transcription language hint.")}
                        </p>
                      </div>
                    )}

                    {service === "imagegen" && (
                      <>
                        <div>
                          <FieldLabel htmlFor={`${service}-image-size`}>{t("Image size")}</FieldLabel>
                          <Input
                            id={`${service}-image-size`}
                            placeholder="1024x1024"
                            value={activeModel.size ?? ""}
                            onChange={(e) =>
                              updateModelField("size", e.target.value)
                            }
                          />
                          <p className="mt-1.5 text-[11px] text-muted-foreground">
                            {t(
                              "Default pixel size sent with each request. Leave empty for the provider default.",
                            )}
                          </p>
                        </div>
                        <div>
                          <FieldLabel htmlFor={`${service}-quality`}>{t("Quality / Style")}</FieldLabel>
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              id={`${service}-quality`}
                              aria-label={t("Quality")}
                              placeholder={t("quality (e.g. hd)")}
                              value={activeModel.quality ?? ""}
                              onChange={(e) =>
                                updateModelField("quality", e.target.value)
                              }
                            />
                            <Input
                              aria-label={t("Style")}
                              placeholder={t("style (e.g. vivid)")}
                              value={activeModel.style ?? ""}
                              onChange={(e) =>
                                updateModelField("style", e.target.value)
                              }
                            />
                          </div>
                        </div>
                      </>
                    )}

                    {service === "videogen" && (
                      <>
                        <div>
                          <FieldLabel htmlFor={`${service}-aspect-ratio`}>{t("Aspect ratio")}</FieldLabel>
                          <Input
                            id={`${service}-aspect-ratio`}
                            placeholder="16:9"
                            value={activeModel.aspect_ratio ?? ""}
                            onChange={(e) =>
                              updateModelField("aspect_ratio", e.target.value)
                            }
                          />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`${service}-duration`}>{t("Duration / Resolution")}</FieldLabel>
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              id={`${service}-duration`}
                              aria-label={t("Duration")}
                              inputMode="numeric"
                              placeholder={t("seconds")}
                              value={activeModel.duration ?? ""}
                              onChange={(e) =>
                                updateModelField("duration", e.target.value)
                              }
                            />
                            <Input
                              aria-label={t("Resolution")}
                              placeholder="720p"
                              value={activeModel.resolution ?? ""}
                              onChange={(e) =>
                                updateModelField("resolution", e.target.value)
                              }
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Diagnostics */}
            <section className="surface">
              <div className="flex items-center justify-between px-5 py-3.5">
                <button
                  type="button"
                  onClick={() => setDiagnosticsOpen((v) => !v)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-expanded={diagnosticsOpen}
                >
                  <Terminal size={14} className="text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    {t("Diagnostics")}
                  </span>
                  {testRunning && (
                    <Badge variant="primary">{t("Running")}</Badge>
                  )}
                </button>
                <div className="ml-3 flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void runTest()}
                    loading={testRunning}
                  >
                    {t("Test connection")}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setDiagnosticsOpen((v) => !v)}
                    aria-label={
                      diagnosticsOpen
                        ? t("Collapse diagnostics")
                        : t("Expand diagnostics")
                    }
                    className="text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown
                      size={16}
                      className={cn(
                        "transition-transform duration-150",
                        diagnosticsOpen && "rotate-180",
                      )}
                    />
                  </button>
                </div>
              </div>
              {diagnosticsOpen && (
                <div className="border-t border-border px-5 py-4">
                  <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                    {t(
                      "Runs a live request against the active profile and streams config snapshot, request target, and validation results. Save first so the applied configuration is tested.",
                    )}
                  </p>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-mono text-xs leading-6 text-muted-foreground">
                    {logs || t("Waiting for test run...")}
                  </pre>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmDeleteProfile}
        onClose={() => setConfirmDeleteProfile(false)}
        onConfirm={() => {
          deleteActiveProfile();
          setConfirmDeleteProfile(false);
        }}
        title={t("Delete profile")}
        description={t("Delete “{{name}}”? This cannot be undone.", {
          name: activeProfile?.name ?? "",
        })}
        confirmText={t("Delete")}
        destructive
      />
      <ConfirmDialog
        open={confirmDeleteModel}
        onClose={() => setConfirmDeleteModel(false)}
        onConfirm={() => {
          deleteActiveModel();
          setConfirmDeleteModel(false);
        }}
        title={t("Delete model")}
        description={t("Delete “{{name}}”? This cannot be undone.", {
          name: activeModel?.name ?? "",
        })}
        confirmText={t("Delete")}
        destructive
      />
    </div>
  );
}
