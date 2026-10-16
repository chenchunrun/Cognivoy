"use client";

import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
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

type MinerUMode = "local" | "cloud";
type MinerUModelVersion = "pipeline" | "vlm";
type MinerUDownloadSource = "huggingface" | "modelscope";
type MinerUDownloadType = "pipeline" | "vlm" | "all";

const DEFAULT_BASE_URL = "https://mineru.net";
const DEFAULT_HF_ENDPOINT = "https://huggingface.co";
const TOKEN_MASK = "••••••••••••";
const DOWNLOAD_SOURCES: MinerUDownloadSource[] = ["huggingface", "modelscope"];
const DOWNLOAD_TYPES: MinerUDownloadType[] = ["pipeline", "vlm", "all"];

interface MinerUSettings {
  mode: MinerUMode;
  api_base_url: string;
  local_cli_path: string;
  model_download_source: MinerUDownloadSource;
  model_download_endpoint: string;
  model_version: MinerUModelVersion;
  language: string;
  enable_formula: boolean;
  enable_table: boolean;
  is_ocr: boolean;
  allow_local_model_download: boolean;
}

interface MinerUPayload {
  settings: MinerUSettings & { version?: number };
  api_token_set: boolean;
  local_cli?: {
    found: boolean;
    command: string;
    path: string;
    source?: "configured" | "path";
  };
}

interface DownloadStatus {
  state: "running" | "done" | "failed" | "cancelled" | string;
  lines: string[];
  message: string;
}

function normalizeDraft(payload: MinerUPayload): MinerUSettings {
  const s = payload.settings;
  return {
    mode: s.mode === "cloud" ? "cloud" : "local",
    api_base_url: s.api_base_url || DEFAULT_BASE_URL,
    local_cli_path: s.local_cli_path || "",
    model_download_source:
      s.model_download_source === "modelscope" ? "modelscope" : "huggingface",
    model_download_endpoint: s.model_download_endpoint || "",
    model_version: s.model_version === "vlm" ? "vlm" : "pipeline",
    language: s.language || "auto",
    enable_formula: Boolean(s.enable_formula),
    enable_table: Boolean(s.enable_table),
    is_ocr: Boolean(s.is_ocr),
    allow_local_model_download: Boolean(s.allow_local_model_download),
  };
}

export default function MinerUSettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [payload, setPayload] = React.useState<MinerUPayload | null>(null);
  const [draft, setDraft] = React.useState<MinerUSettings | null>(null);
  // Token is write-only: blank field + set/not-set hint; sent only when edited.
  const [tokenDraft, setTokenDraft] = React.useState("");
  const [tokenTouched, setTokenTouched] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [testResult, setTestResult] = React.useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [download, setDownload] = React.useState<DownloadStatus | null>(null);
  const [downloadType, setDownloadType] =
    React.useState<MinerUDownloadType>("pipeline");
  const [startingDownload, setStartingDownload] = React.useState(false);
  const downloadCursor = React.useRef(0);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/mineru"));
      const data = (await res.json().catch(() => ({}))) as
        | MinerUPayload
        | { detail?: string };
      if (!res.ok) {
        throw new Error(
          "detail" in data && data.detail
            ? data.detail
            : t("Failed to load MinerU settings."),
        );
      }
      const next = data as MinerUPayload;
      setPayload(next);
      setDraft(normalizeDraft(next));
      setTokenDraft("");
      setTokenTouched(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirty = React.useMemo(() => {
    if (!payload || !draft) return false;
    return (
      tokenTouched ||
      JSON.stringify(normalizeDraft(payload)) !== JSON.stringify(draft)
    );
  }, [draft, payload, tokenTouched]);

  function patch(next: Partial<MinerUSettings>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setTestResult(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/mineru"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          api_token: tokenTouched ? tokenDraft : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | MinerUPayload
        | { detail?: string };
      if (!res.ok) {
        throw new Error(
          "detail" in data && data.detail
            ? data.detail
            : t("Failed to save MinerU settings."),
        );
      }
      const next = data as MinerUPayload;
      setPayload(next);
      setDraft(normalizeDraft(next));
      setTokenDraft("");
      setTokenTouched(false);
      toast({ title: t("MinerU settings saved"), variant: "success" });
    } catch (err) {
      toast({
        title: t("Failed to save MinerU settings"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/mineru/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          api_token: tokenTouched ? tokenDraft : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        detail?: string;
      };
      if (!res.ok) {
        throw new Error(data.detail || t("Connection test failed."));
      }
      setTestResult({
        ok: Boolean(data.ok),
        message:
          data.message || (data.ok ? t("OK") : t("Connection test failed.")),
      });
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  // Poll the download job while it runs; the cursor protocol fetches only new
  // log lines each tick.
  React.useEffect(() => {
    if (download?.state !== "running") return;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(
          apiUrl(
            `/api/v1/settings/mineru/models/download/status?cursor=${downloadCursor.current}`,
          ),
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          state?: string;
          lines?: string[];
          next_cursor?: number;
          message?: string;
        };
        downloadCursor.current = data.next_cursor ?? downloadCursor.current;
        setDownload((current) =>
          current
            ? {
                state: data.state || current.state,
                lines: [...current.lines, ...(data.lines || [])].slice(-100),
                message: data.message || "",
              }
            : current,
        );
      } catch {
        // transient network error — keep polling
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [download?.state]);

  async function startDownload() {
    if (!draft) return;
    setStartingDownload(true);
    try {
      const res = await apiFetch(
        apiUrl("/api/v1/settings/mineru/models/download"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model_type: downloadType,
            source: draft.model_download_source,
            endpoint: draft.model_download_endpoint,
            local_cli_path: draft.local_cli_path,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        detail?: string;
      };
      if (!res.ok || !data.ok) {
        setDownload({
          state: "failed",
          lines: [],
          message: data.message || data.detail || t("Download failed."),
        });
        return;
      }
      downloadCursor.current = 0;
      setDownload({ state: "running", lines: [], message: "" });
    } finally {
      setStartingDownload(false);
    }
  }

  async function cancelDownload() {
    try {
      await apiFetch(apiUrl("/api/v1/settings/mineru/models/download/cancel"), {
        method: "POST",
      });
    } catch {
      // status polling surfaces the final state either way
    }
  }

  if (loading) {
    return (
      <div>
        <SettingsPageHeader
          title={t("MinerU")}
          description={t(
            "Configure the MinerU engine used for rich PDF parsing.",
          )}
        />
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  if (loadError || !draft) {
    return (
      <div>
        <SettingsPageHeader
          title={t("MinerU")}
          description={t(
            "Configure the MinerU engine used for rich PDF parsing.",
          )}
        />
        <EmptyState
          icon={AlertCircle}
          title={t("Couldn't load MinerU settings")}
          description={loadError ?? undefined}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("Retry")}
            </Button>
          }
        />
      </div>
    );
  }

  const tokenSet = payload?.api_token_set ?? false;
  const isCloud = draft.mode === "cloud";
  const localCli = payload?.local_cli;

  return (
    <div>
      <SettingsPageHeader
        title={t("MinerU")}
        description={t("Configure the MinerU engine used for rich PDF parsing.")}
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
        title={t("Parsing backend")}
        description={t("Choose where PDF parsing runs.")}
      >
        <SettingRow
          title={t("Mode")}
          description={
            isCloud
              ? t("Documents are uploaded to mineru.net for parsing.")
              : t("Parsing runs on this machine using the local MinerU install.")
          }
          control={
            <div className="inline-flex rounded-lg border border-border p-0.5">
              {(["local", "cloud"] as MinerUMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    patch({ mode: m });
                    setTestResult(null);
                  }}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors duration-150",
                    draft.mode === m
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m === "local" ? t("Local") : t("Cloud API")}
                </button>
              ))}
            </div>
          }
        />
      </SettingSection>

      {!isCloud && (
        <SettingSection
          title={t("Local install")}
          description={t(
            "The MinerU CLI must be reachable by the Cognivoy server process. Reserve >=20 GB of free disk for install, models, and parse cache.",
          )}
        >
          <SettingRow
            title={
              localCli?.found
                ? t("MinerU CLI detected.")
                : localCli?.source === "configured"
                  ? t("Configured CLI path is not executable.")
                  : t("MinerU CLI not found on PATH.")
            }
            description={
              localCli?.found
                ? localCli.path
                : t(
                    'Install into any Python environment: uv pip install -U "mineru[core]" — then set the CLI path below, or install into the server environment for PATH auto-detection.',
                  )
            }
            control={
              <TestControl
                label={t("Check")}
                testing={testing}
                result={testResult}
                onTest={() => void testConnection()}
              />
            }
          />
          <SettingRow
            title={t("CLI path")}
            description={t(
              "Optional. Point to a mineru executable in an isolated environment (uv tool, pipx, conda). Leave blank to auto-detect from PATH.",
            )}
            control={
              <Input
                className="w-80 max-w-[48vw] font-mono text-xs"
                placeholder={t("Auto-detect from PATH")}
                value={draft.local_cli_path}
                onChange={(e) => patch({ local_cli_path: e.target.value })}
              />
            }
          />
        </SettingSection>
      )}

      {!isCloud && (
        <SettingSection
          title={t("Model weights")}
          description={t(
            "Local parsing needs ~1-2 GB of model weights. They are not downloaded automatically unless you allow it.",
          )}
        >
          <SettingRow
            title={t("Allow automatic model download")}
            description={t(
              "Off by default. When off, a local parse fails with guidance instead of silently downloading multi-GB weights on first run.",
            )}
            control={
              <Toggle
                checked={draft.allow_local_model_download}
                onCheckedChange={(v) =>
                  patch({ allow_local_model_download: v })
                }
                aria-label={t("Allow automatic model download")}
              />
            }
          />
          <SettingRow
            title={t("Download source")}
            description={t("ModelScope is usually faster in mainland China.")}
            control={
              <Select
                className="w-44"
                aria-label={t("Download source")}
                value={draft.model_download_source}
                onChange={(e) =>
                  patch({
                    model_download_source: e.target
                      .value as MinerUDownloadSource,
                  })
                }
              >
                {DOWNLOAD_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s === "huggingface" ? "HuggingFace" : "ModelScope"}
                  </option>
                ))}
              </Select>
            }
          />
          {draft.model_download_source === "huggingface" && (
            <SettingRow
              title={t("Download address")}
              description={t(
                "Custom HuggingFace endpoint or mirror. Leave blank for the official address.",
              )}
              control={
                <Input
                  className="w-80 max-w-[48vw] font-mono text-xs"
                  placeholder={DEFAULT_HF_ENDPOINT}
                  value={draft.model_download_endpoint}
                  onChange={(e) =>
                    patch({ model_download_endpoint: e.target.value })
                  }
                />
              }
            />
          )}
          <SettingRow
            title={t("Download models")}
            description={t(
              "Runs mineru-models-download on the server using the source and address above.",
            )}
            control={
              <div className="flex items-center gap-2">
                <Select
                  className="w-28"
                  aria-label={t("Download models")}
                  value={downloadType}
                  onChange={(e) =>
                    setDownloadType(e.target.value as MinerUDownloadType)
                  }
                  disabled={download?.state === "running"}
                >
                  {DOWNLOAD_TYPES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Select>
                {download?.state === "running" ? (
                  <Button variant="outline" size="sm" onClick={() => void cancelDownload()}>
                    {t("Cancel")}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={startingDownload}
                    onClick={() => void startDownload()}
                  >
                    <Download size={13} />
                    {t("Download")}
                  </Button>
                )}
              </div>
            }
          />
          {download && (
            <div className="px-4 py-3.5">
              <div
                className={cn(
                  "mb-2 inline-flex items-center gap-1.5 text-xs",
                  download.state === "done"
                    ? "text-success"
                    : download.state === "running"
                      ? "text-muted-foreground"
                      : "text-destructive",
                )}
              >
                {download.state === "done" ? (
                  <CheckCircle2 size={14} />
                ) : download.state === "running" ? null : (
                  <XCircle size={14} />
                )}
                {download.state === "running"
                  ? t("Downloading models...")
                  : download.message || download.state}
              </div>
              {download.lines.length > 0 && (
                <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {download.lines.join("\n")}
                </pre>
              )}
            </div>
          )}
        </SettingSection>
      )}

      {isCloud && (
        <SettingSection
          title={t("Cloud API")}
          description={t("Get an API token from mineru.net → API management.")}
        >
          <SettingRow
            title={t("API base URL")}
            description={t(
              "Override only if you use a self-hosted MinerU endpoint.",
            )}
            control={
              <Input
                className="w-80 max-w-[48vw]"
                placeholder={DEFAULT_BASE_URL}
                value={draft.api_base_url}
                onChange={(e) => patch({ api_base_url: e.target.value })}
              />
            }
          />
          <SettingRow
            title={t("API token")}
            description={
              tokenSet
                ? t("A token is saved. Type to replace it; leave blank to keep it.")
                : t("No token saved yet.")
            }
            control={
              <Input
                type="password"
                autoComplete="off"
                className="w-80 max-w-[48vw]"
                placeholder={tokenSet ? TOKEN_MASK : t("Paste API token")}
                value={tokenDraft}
                onChange={(e) => {
                  setTokenDraft(e.target.value);
                  setTokenTouched(true);
                }}
              />
            }
          />
          <SettingRow
            title={t("Test connection")}
            description={t(
              "Verifies the token against the MinerU API (no quota used).",
            )}
            control={
              <TestControl
                label={t("Test")}
                testing={testing}
                result={testResult}
                onTest={() => void testConnection()}
              />
            }
          />
        </SettingSection>
      )}

      <SettingSection
        title={t("Parsing options")}
        description={t("Forwarded to MinerU for each document.")}
      >
        <SettingRow
          title={t("Model version")}
          description={t("pipeline is faster; vlm is the vision-language model.")}
          control={
            <Select
              className="w-40"
              aria-label={t("Model version")}
              value={draft.model_version}
              onChange={(e) =>
                patch({ model_version: e.target.value as MinerUModelVersion })
              }
            >
              <option value="pipeline">pipeline</option>
              <option value="vlm">vlm</option>
            </Select>
          }
        />
        <SettingRow
          title={t("Language")}
          description={t(
            'Document language hint. Use "auto" to let MinerU detect it.',
          )}
          control={
            <Input
              className="w-40"
              placeholder="auto"
              value={draft.language}
              onChange={(e) => patch({ language: e.target.value })}
            />
          }
        />
        <SettingRow
          title={t("Extract formulas")}
          control={
            <Toggle
              checked={draft.enable_formula}
              onCheckedChange={(v) => patch({ enable_formula: v })}
              aria-label={t("Extract formulas")}
            />
          }
        />
        <SettingRow
          title={t("Extract tables")}
          control={
            <Toggle
              checked={draft.enable_table}
              onCheckedChange={(v) => patch({ enable_table: v })}
              aria-label={t("Extract tables")}
            />
          }
        />
        <SettingRow
          title={t("Force OCR")}
          description={t(
            "Treat the PDF as scanned images. Slower; only for non-text PDFs.",
          )}
          control={
            <Toggle
              checked={draft.is_ocr}
              onCheckedChange={(v) => patch({ is_ocr: v })}
              aria-label={t("Force OCR")}
            />
          }
        />
      </SettingSection>
    </div>
  );
}

function TestControl({
  label,
  testing,
  result,
  onTest,
}: {
  label: string;
  testing: boolean;
  result: { ok: boolean; message: string } | null;
  onTest: () => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {result && (
        <span
          className={cn(
            "inline-flex max-w-[40vw] items-center gap-1 text-xs",
            result.ok ? "text-success" : "text-destructive",
          )}
        >
          {result.ok ? (
            <CheckCircle2 size={14} className="shrink-0" />
          ) : (
            <XCircle size={14} className="shrink-0" />
          )}
          {result.message}
        </span>
      )}
      <Button variant="outline" size="sm" loading={testing} onClick={onTest}>
        {label}
      </Button>
    </div>
  );
}
