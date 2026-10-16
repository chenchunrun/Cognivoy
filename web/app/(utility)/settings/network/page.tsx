"use client";

import * as React from "react";
import { AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  Skeleton,
  Textarea,
  Toggle,
  useToast,
} from "@/components/ui";
import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
} from "@/components/settings/shared";

interface NetworkSettings {
  backend_port: number;
  frontend_port: number;
  public_api_base: string;
  cors_origins: string[];
  external_network_enabled: boolean;
  external_request_timeout_seconds: number;
  outbound_proxy: string;
}

interface NetworkSettingsPayload {
  settings: NetworkSettings;
  effective: {
    backend_url: string;
    frontend_url: string;
    browser_api_base: string;
    cors_mode: "explicit" | "permissive";
  };
  auth: {
    enabled: boolean;
    cookie_secure: boolean;
    cookie_samesite: string;
    cross_site_cookie_ready: boolean;
  };
  restart_required: boolean;
}

function splitOrigins(value: string): string[] {
  return value
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function NetworkSettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [payload, setPayload] = React.useState<NetworkSettingsPayload | null>(
    null,
  );
  const [draft, setDraft] = React.useState<NetworkSettings | null>(null);
  const [corsText, setCorsText] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [confirmDisable, setConfirmDisable] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/network"));
      const data = (await res.json().catch(() => ({}))) as
        | NetworkSettingsPayload
        | { detail?: string };
      if (!res.ok) {
        throw new Error(
          "detail" in data && data.detail
            ? data.detail
            : t("Failed to load network settings."),
        );
      }
      const next = data as NetworkSettingsPayload;
      setPayload(next);
      setDraft({
        backend_port: next.settings.backend_port,
        frontend_port: next.settings.frontend_port,
        public_api_base: next.settings.public_api_base || "",
        cors_origins: next.settings.cors_origins || [],
        external_network_enabled:
          next.settings.external_network_enabled !== false,
        external_request_timeout_seconds:
          next.settings.external_request_timeout_seconds || 60,
        outbound_proxy: next.settings.outbound_proxy || "",
      });
      setCorsText((next.settings.cors_origins || []).join("\n"));
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
    const current = payload.settings;
    return (
      current.backend_port !== draft.backend_port ||
      current.frontend_port !== draft.frontend_port ||
      (current.public_api_base || "") !== draft.public_api_base ||
      current.external_network_enabled !== draft.external_network_enabled ||
      current.external_request_timeout_seconds !==
        draft.external_request_timeout_seconds ||
      (current.outbound_proxy || "") !== draft.outbound_proxy ||
      JSON.stringify(current.cors_origins || []) !==
        JSON.stringify(splitOrigins(corsText))
    );
  }, [corsText, draft, payload]);

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/network"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          cors_origins: splitOrigins(corsText),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as
        | NetworkSettingsPayload
        | { detail?: string };
      if (!res.ok) {
        throw new Error(
          "detail" in data && data.detail
            ? data.detail
            : t("Failed to save network settings."),
        );
      }
      const next = data as NetworkSettingsPayload;
      setPayload(next);
      setDraft({
        backend_port: next.settings.backend_port,
        frontend_port: next.settings.frontend_port,
        public_api_base: next.settings.public_api_base || "",
        cors_origins: next.settings.cors_origins || [],
        external_network_enabled:
          next.settings.external_network_enabled !== false,
        external_request_timeout_seconds:
          next.settings.external_request_timeout_seconds || 60,
        outbound_proxy: next.settings.outbound_proxy || "",
      });
      setCorsText((next.settings.cors_origins || []).join("\n"));
      toast({
        title: t("Network settings saved"),
        description: t("Changes take effect after restart."),
        variant: "success",
      });
    } catch (err) {
      toast({
        title: t("Failed to save network settings"),
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Network")}
          description={t(
            "Control the browser-facing API URL and CORS origins used by Docker, LAN, and reverse-proxy deployments.",
          )}
        />
        <div className="space-y-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-40" />
        </div>
      </div>
    );
  }

  if (loadError || !payload || !draft) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Network")}
          description={t(
            "Control the browser-facing API URL and CORS origins used by Docker, LAN, and reverse-proxy deployments.",
          )}
        />
        <EmptyState
          icon={AlertCircle}
          title={t("Couldn't load network settings")}
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

  return (
    <div>
      <SettingsPageHeader
        title={t("Network")}
        description={t(
          "Control the browser-facing API URL and CORS origins used by Docker, LAN, and reverse-proxy deployments.",
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

      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <DetailTile
          label={t("Browser API")}
          value={payload.effective.browser_api_base}
        />
        <DetailTile
          label={t("CORS mode")}
          value={
            payload.effective.cors_mode === "permissive"
              ? t("Permissive until auth is enabled")
              : t("Explicit origins required")
          }
        />
        <DetailTile
          label={t("Auth cookie")}
          value={`${payload.auth.cookie_samesite}${
            payload.auth.cookie_secure ? " + Secure" : ""
          }`}
        />
        <DetailTile label={t("Restart")} value={t("Required after save")} />
      </div>

      <SettingSection
        title={t("Outbound network policy")}
        description={t(
          "Control external access for Web Search, Web Fetch, paper and GitHub lookup, Deep Research, and connected agents.",
        )}
      >
        <SettingRow
          title={t("Allow external network access")}
          description={t(
            "Turning this off blocks new external searches, fetches, paper and GitHub requests, and agent consultations before they start.",
          )}
          control={
            <Toggle
              checked={draft.external_network_enabled}
              onCheckedChange={(enabled) => {
                if (!enabled) {
                  setConfirmDisable(true);
                  return;
                }
                setDraft((current) =>
                  current
                    ? { ...current, external_network_enabled: true }
                    : current,
                );
              }}
              aria-label={t("Allow external network access")}
            />
          }
        />
        <SettingRow
          title={t("External request timeout")}
          description={t(
            "Maximum wall-clock time in seconds for supported outbound requests. Individual tools may use a shorter limit.",
          )}
          control={
            <Input
              type="number"
              className="w-28"
              min={5}
              max={600}
              value={draft.external_request_timeout_seconds}
              onChange={(event) =>
                setDraft((current) =>
                  current
                    ? {
                        ...current,
                        external_request_timeout_seconds: Number(
                          event.target.value,
                        ),
                      }
                    : current,
                )
              }
              aria-label={t("External request timeout")}
            />
          }
        />
        <SettingRow
          title={t("Outbound proxy")}
          description={t(
            "Optional HTTP(S) proxy applied to supported outbound HTTP clients. Credentials are stored server-side; prefer a secret-free proxy URL.",
          )}
          control={
            <Input
              className="w-80 max-w-[48vw]"
              placeholder={t("http://proxy.example:8080")}
              value={draft.outbound_proxy}
              onChange={(event) =>
                setDraft((current) =>
                  current
                    ? { ...current, outbound_proxy: event.target.value }
                    : current,
                )
              }
              aria-label={t("Outbound proxy")}
            />
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Runtime ports")}
        description={t(
          "These ports are read during startup. Docker port mappings must match the container-side values.",
        )}
      >
        <SettingRow
          title={t("Backend port")}
          description={t("FastAPI listens on this port.")}
          control={
            <Input
              type="number"
              aria-label={t("Backend port")}
              className="w-28"
              min={1}
              max={65535}
              value={draft.backend_port}
              onChange={(e) =>
                setDraft((current) =>
                  current
                    ? { ...current, backend_port: Number(e.target.value) }
                    : current,
                )
              }
            />
          }
        />
        <SettingRow
          title={t("Frontend port")}
          description={t("Next.js serves the Web UI on this port.")}
          control={
            <Input
              type="number"
              aria-label={t("Frontend port")}
              className="w-28"
              min={1}
              max={65535}
              value={draft.frontend_port}
              onChange={(e) =>
                setDraft((current) =>
                  current
                    ? { ...current, frontend_port: Number(e.target.value) }
                    : current,
                )
              }
            />
          }
        />
      </SettingSection>

      <SettingSection
        title={t("Browser API base")}
        description={t(
          "Set this when the browser cannot reach the backend through localhost, such as remote Docker or a reverse proxy.",
        )}
      >
        <SettingRow
          title={t("Public API base")}
          description={t(
            "Leave blank for local Docker. Use the externally reachable backend URL, including any proxy path.",
          )}
          control={
            <Input
              className="w-80 max-w-[48vw]"
              placeholder="https://api.example.com"
              value={draft.public_api_base}
              onChange={(e) =>
                setDraft((current) =>
                  current
                    ? { ...current, public_api_base: e.target.value }
                    : current,
                )
              }
            />
          }
        />
      </SettingSection>

      <SettingSection
        title={t("CORS origins")}
        description={t(
          "Only required for authenticated cross-origin deployments. Use frontend origins, not API URLs.",
        )}
      >
        <div className="px-4 py-4">
          <Textarea
            className="min-h-28 font-mono text-xs"
            placeholder={"https://learn.example.com\nhttp://10.0.0.5:3782"}
            value={corsText}
            onChange={(e) => setCorsText(e.target.value)}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {t(
              "Comma, semicolon, and newline separators are accepted. Bare host:port values are stored as http://host:port.",
            )}
          </p>
        </div>
      </SettingSection>

      {payload.auth.enabled && !payload.auth.cookie_secure && (
        <div className="flex items-start gap-2">
          <Badge variant="warning">{t("Warning")}</Badge>
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            {t(
              "Auth is enabled but secure cookies are off. Cross-site HTTPS deployments should enable secure cookies and restart so SameSite=None cookies work in modern browsers.",
            )}
          </p>
        </div>
      )}

      <ConfirmDialog
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        onConfirm={() => {
          setDraft((current) =>
            current
              ? { ...current, external_network_enabled: false }
              : current,
          );
          setConfirmDisable(false);
        }}
        title={t("Disable external network access?")}
        description={t(
          "New Search, Fetch, Paper, GitHub, Deep Research, and Agent operations that require external access will be blocked after you save. Existing local data remains available.",
        )}
        confirmText={t("Disable external network")}
        destructive
      />
    </div>
  );
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="surface px-4 py-3">
      <div className="text-[11px] font-medium text-muted-foreground">
        {label}
      </div>
      <div
        className="mt-1.5 truncate text-[13px] font-medium text-foreground"
        title={value}
      >
        {value || "-"}
      </div>
    </div>
  );
}
