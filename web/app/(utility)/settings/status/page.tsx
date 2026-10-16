"use client";

import * as React from "react";
import Link from "next/link";
import { Activity, AlertCircle, Bot, Cpu, FileText, Film, Globe, Image, Layers, Mic, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import { isLongRunningRouteGroup, routeGroupsWithServerErrors } from "@/lib/slo-display";
import { cn } from "@/lib/utils";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { CodexOAuthCard } from "@/components/settings/CodexOAuthCard";
import { SettingsPageHeader } from "@/components/settings/shared";

interface SystemStatus {
  backend: { status: string; timestamp: string };
  llm: { status: string; model?: string | null; error?: string };
  embeddings: { status: string; model?: string | null; error?: string };
  search: { status: string; provider?: string | null; error?: string };
}

interface DependencyItem {
  status: string;
  detail?: string | null;
  engine?: string | null;
  profile?: string | null;
  available?: number;
  total?: number;
  missing_dependencies?: string[];
  install_hint?: string | null;
  missing_configuration?: string[];
  verification?: string;
  setup_path?: string;
}

interface DependencyStatus {
  timestamp: string;
  dependencies: {
    parser: DependencyItem;
    manim: DependencyItem;
    agents: DependencyItem;
    media: Record<"tts" | "stt" | "imagegen" | "videogen", DependencyItem>;
  };
}

interface SloStatus {
  generated_at: string;
  window_seconds: number;
  targets: { availability_percent: number; p95_ms: number; minimum_samples: number };
  requests: number;
  successful_requests: number;
  server_errors: number;
  availability_percent: number | null;
  latency_ms: { p50: number | null; p95: number | null };
  alerts: Array<{ code: string; severity: string; actual: number; target: number }>;
  business_metrics: Record<"asset_saved" | "learning_completed" | "reference_clicked" | "turn_recovered", number>;
  route_groups: Array<{ name: string; requests: number; server_errors: number; availability_percent: number; p95_ms: number | null }>;
}

type Tone = "ok" | "warn" | "bad" | "neutral";

function statusTone(status: string): Tone {
  if (status === "online" || status === "configured") return "ok";
  if (status === "error" || status === "unsupported") return "bad";
  if (status === "unavailable") return "bad";
  if (status === "not_configured" || status === "deprecated" || status === "disabled" || status === "fallback") return "warn";
  return "neutral";
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  online: "Online",
  configured: "Configured",
  not_configured: "Not configured",
  optional: "Optional",
  error: "Error",
  unsupported: "Unsupported",
  deprecated: "Deprecated",
  unavailable: "Unavailable",
  disabled: "Disabled",
  fallback: "Fallback",
  unknown: "Unknown",
};

export default function StatusSettingsPage() {
  const { t } = useTranslation();
  const [status, setStatus] = React.useState<SystemStatus | null>(null);
  const [dependencies, setDependencies] = React.useState<DependencyStatus | null>(null);
  const [slo, setSlo] = React.useState<SloStatus | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [dependencyError, setDependencyError] = React.useState<string | null>(null);
  const [sloError, setSloError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoadError(null);
    setDependencyError(null);
    setSloError(null);
    const [systemResult, dependencyResult, sloResult] = await Promise.allSettled([
      apiFetch(apiUrl("/api/v1/system/status")).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as SystemStatus;
      }),
      apiFetch(apiUrl("/api/v1/system/dependencies")).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as DependencyStatus;
      }),
      apiFetch(apiUrl("/api/v1/system/slo?window_seconds=86400")).then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as SloStatus;
      }),
    ]);
    if (systemResult.status === "fulfilled") setStatus(systemResult.value);
    else setLoadError(systemResult.reason instanceof Error ? systemResult.reason.message : String(systemResult.reason));
    if (dependencyResult.status === "fulfilled") setDependencies(dependencyResult.value);
    else setDependencyError(dependencyResult.reason instanceof Error ? dependencyResult.reason.message : String(dependencyResult.reason));
    if (sloResult.status === "fulfilled") setSlo(sloResult.value);
    else setSloError(sloResult.reason instanceof Error ? sloResult.reason.message : String(sloResult.reason));
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const errorDomains = slo ? routeGroupsWithServerErrors(slo.route_groups) : [];

  return (
    <div>
      <SettingsPageHeader
        title={t("Status")}
        description={t(
          "Live health of the backend and the configured model services.",
        )}
        action={
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("Refresh")}
          </Button>
        }
      />

      {loadError && (
        <EmptyState
          icon={AlertCircle}
          title={t("Couldn't load system status")}
          description={loadError}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t("Retry")}
            </Button>
          }
        />
      )}

      {!status && !loadError && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
      )}

      {status && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatusCard
            icon={Activity}
            title={t("Backend")}
            value={t(STATUS_LABEL_KEYS[status.backend.status] ?? status.backend.status)}
            tone={statusTone(status.backend.status)}
            detail={formatTimestamp(status.backend.timestamp)}
          />
          <StatusCard
            icon={Cpu}
            title={t("LLM")}
            value={t(
              STATUS_LABEL_KEYS[status.llm.status] ?? status.llm.status,
            )}
            tone={statusTone(status.llm.status)}
            detail={status.llm.model ?? status.llm.error}
          />
          <StatusCard
            icon={Layers}
            title={t("Embedding")}
            value={t(
              STATUS_LABEL_KEYS[status.embeddings.status] ??
                status.embeddings.status,
            )}
            tone={statusTone(status.embeddings.status)}
            detail={status.embeddings.model ?? status.embeddings.error}
          />
          <StatusCard
            icon={Globe}
            title={t("Search")}
            value={t(
              STATUS_LABEL_KEYS[status.search.status] ?? status.search.status,
            )}
            tone={statusTone(status.search.status)}
            detail={status.search.provider ?? status.search.error}
          />
        </div>
      )}

      <section className="mt-8" aria-labelledby="slo-status-title">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="slo-status-title" className="display text-lg text-foreground">{t("Service objectives")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("Rolling 24-hour availability, latency, recovery, and learning indicators.")}</p>
          </div>
          {slo?.generated_at && <span className="text-[11px] text-muted-foreground">{t("Checked {{date}}", { date: formatTimestamp(slo.generated_at) })}</span>}
        </div>
        {sloError && (
          <div role="alert" className="rounded-xl border border-warning-border bg-warning-muted p-3 text-xs text-warning">
            {t("Service objectives are temporarily unavailable")}: {sloError}
          </div>
        )}
        {!slo && !sloError && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-24" />)}</div>}
        {slo && (
          <>
            {slo.alerts.length > 0 && (
              <div role="alert" className="mb-3 rounded-xl border border-destructive-border bg-destructive-muted p-3 text-xs text-destructive">
                {slo.alerts.map((alert) => (
                  <p key={alert.code}>{t(alert.code === "availability_below_target" ? "Availability is below its target" : "P95 latency is above its target")}: {alert.actual} / {alert.target}</p>
                ))}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatusCard icon={Activity} title={t("Availability (24h)")} value={slo.availability_percent == null ? t("Collecting") : `${slo.availability_percent}%`} tone={slo.alerts.some((alert) => alert.code === "availability_below_target") ? "bad" : slo.requests < slo.targets.minimum_samples ? "neutral" : "ok"} detail={t("Target {{target}}% · {{count}} requests", { target: slo.targets.availability_percent, count: slo.requests })} />
              <StatusCard icon={Cpu} title={t("P95 API latency")} value={slo.latency_ms.p95 == null ? t("Collecting") : `${Math.round(slo.latency_ms.p95)} ms`} tone={slo.alerts.some((alert) => alert.code === "p95_above_target") ? "warn" : slo.requests < slo.targets.minimum_samples ? "neutral" : "ok"} detail={t("Target under {{target}} ms; long-running workflows are listed separately below", { target: slo.targets.p95_ms })} />
              <StatusCard icon={AlertCircle} title={t("Server errors")} value={String(slo.server_errors)} tone={slo.server_errors > 0 ? "warn" : "ok"} detail={slo.server_errors > 0 ? t("{{count}} HTTP 5xx across {{domains}} in the rolling window", { count: slo.server_errors, domains: errorDomains.join(", ") || t("unknown domains") }) : t("No HTTP 5xx responses in the rolling window")} />
              <StatusCard icon={Layers} title={t("Learning outcomes")} value={String(slo.business_metrics.learning_completed)} tone="neutral" detail={t("{{saved}} saved · {{references}} reference opens · {{recovered}} recoveries", { saved: slo.business_metrics.asset_saved, references: slo.business_metrics.reference_clicked, recovered: slo.business_metrics.turn_recovered })} />
            </div>
            {slo.route_groups.length > 0 && (
              <div
                className="surface mt-3 overflow-x-auto p-4"
                role="region"
                aria-label={t("API domains")}
                tabIndex={0}
              >
                <table className="w-full min-w-[640px] text-left text-xs">
                  <caption className="mb-2 text-left font-medium text-foreground">{t("API domains")}</caption>
                  <thead className="text-muted-foreground"><tr><th className="py-2 pr-4">{t("Domain")}</th><th className="py-2 pr-4">{t("Requests")}</th><th className="py-2 pr-4">{t("Errors")}</th><th className="py-2 pr-4">{t("Availability")}</th><th className="py-2">{t("P95 latency")}</th></tr></thead>
                  <tbody>{slo.route_groups.map((group) => <tr key={group.name} className="border-t border-border"><td className="py-2 pr-4 font-medium text-foreground">{group.name}</td><td className="py-2 pr-4">{group.requests}</td><td className={cn("py-2 pr-4", group.server_errors > 0 && "font-medium text-warning")}>{group.server_errors}</td><td className="py-2 pr-4">{group.availability_percent}%</td><td className="py-2"><span>{group.p95_ms == null ? "—" : `${Math.round(group.p95_ms)} ms`}</span>{isLongRunningRouteGroup(group.name) && <span className="ml-2 inline-block rounded-full bg-warning-muted px-2 py-0.5 text-[10px] text-warning">{t("Includes long-running workflows")}</span>}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>

      <section className="mt-8" aria-labelledby="dependency-status-title">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="dependency-status-title" className="display text-lg text-foreground">{t("Capability dependencies")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t("Live readiness for parsing, media, animation, and external Agent features.")}</p>
          </div>
          {dependencies?.timestamp && <span className="text-[11px] text-muted-foreground">{t("Checked {{date}}", { date: formatTimestamp(dependencies.timestamp) })}</span>}
        </div>
        {dependencyError && (
          <div className="rounded-xl border border-warning-border bg-warning-muted p-3 text-xs text-warning">
            {t("Dependency status is temporarily unavailable")}: {dependencyError}
          </div>
        )}
        {!dependencies && !dependencyError && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 7 }, (_, index) => <Skeleton key={index} className="h-24" />)}</div>
        )}
        {dependencies && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <DependencyCard icon={FileText} title={t("Document parser")} dependency={dependencies.dependencies.parser} usage={t("Required by Knowledge and RAG")} detail={dependencies.dependencies.parser.engine} />
            <DependencyCard icon={Film} title={t("Manim renderer")} dependency={dependencies.dependencies.manim} usage={t("Required by Math Animator")} detail={dependencies.dependencies.manim.missing_dependencies?.join(", ") || dependencies.dependencies.manim.install_hint} />
            <DependencyCard icon={Bot} title={t("Agent CLIs")} dependency={dependencies.dependencies.agents} usage={t("Required by My Agents")} detail={typeof dependencies.dependencies.agents.available === "number" ? t("{{available}} of {{total}} available", { available: dependencies.dependencies.agents.available, total: dependencies.dependencies.agents.total ?? 0 }) : undefined} />
            <DependencyCard icon={Volume2} title={t("Text to speech")} dependency={dependencies.dependencies.media.tts} usage={t("Required by voice playback")} detail={dependencies.dependencies.media.tts.profile} />
            <DependencyCard icon={Mic} title={t("Speech to text")} dependency={dependencies.dependencies.media.stt} usage={t("Required by voice input")} detail={dependencies.dependencies.media.stt.profile} />
            <DependencyCard icon={Image} title={t("Image generation")} dependency={dependencies.dependencies.media.imagegen} usage={t("Used by Visualize and Chat")} detail={dependencies.dependencies.media.imagegen.profile} />
            <DependencyCard icon={Film} title={t("Video generation")} dependency={dependencies.dependencies.media.videogen} usage={t("Used by Visualize and Chat")} detail={dependencies.dependencies.media.videogen.profile} />
          </div>
        )}
      </section>

      <div className="mt-8">
        <CodexOAuthCard />
      </div>
    </div>
  );
}

function DependencyCard({ icon, title, dependency, usage, detail }: { icon: typeof Activity; title: string; dependency: DependencyItem; usage: string; detail?: string | null }) {
  const { t } = useTranslation();
  const tone = statusTone(dependency.status);
  const missingLabels: Record<string, string> = {
    profile: t("Provider"),
    model: t("Active model"),
    endpoint: t("Endpoint URL"),
    credentials: t("Credentials"),
  };
  const setupPath = ["/settings/tts", "/settings/stt", "/settings/image", "/settings/video"].includes(dependency.setup_path ?? "")
    ? dependency.setup_path
    : undefined;
  return (
    <div className="surface px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">{React.createElement(icon, { size: 14 })}{title}</div>
        <Badge variant={TONE_BADGE[tone]}>{t(STATUS_LABEL_KEYS[dependency.status] ?? dependency.status)}</Badge>
      </div>
      <p className="mt-3 text-xs font-medium text-foreground">{usage}</p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground" title={detail || dependency.detail || undefined}>{detail || dependency.detail || "—"}</p>
      {!!dependency.missing_configuration?.length && (
        <p className="mt-2 text-xs text-foreground">
          {t("Missing configuration: {{fields}}", {
            fields: dependency.missing_configuration.map((field) => missingLabels[field] ?? field).join(", "),
          })}
        </p>
      )}
      {dependency.verification === "not_run" && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {t("Configuration check only. Complete media generation has not been verified.")}
        </p>
      )}
      {dependency.install_hint && (
        <p className="mt-2 break-words text-[11px] text-muted-foreground">{dependency.install_hint}</p>
      )}
      {setupPath && (
        <Link href={setupPath} className="mt-2 inline-block text-xs text-foreground underline underline-offset-2">
          {t("Configure")}
        </Link>
      )}
    </div>
  );
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground",
};

const TONE_BADGE: Record<Tone, "success" | "warning" | "destructive" | "default"> =
  {
    ok: "success",
    warn: "warning",
    bad: "destructive",
    neutral: "default",
  };

function StatusCard({
  icon: Icon,
  title,
  value,
  detail,
  tone,
}: {
  icon: typeof Activity;
  title: string;
  value: string;
  detail?: string | null;
  tone: Tone;
}) {
  return (
    <div className="surface px-4 py-3.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon size={14} />
          {title}
        </div>
        <Badge variant={TONE_BADGE[tone]}>
          <span
            className={cn("h-1.5 w-1.5 rounded-full", TONE_DOT[tone])}
            aria-hidden="true"
          />
          {value}
        </Badge>
      </div>
      <div
        className="mt-3 truncate text-[13px] font-medium text-foreground"
        title={detail ?? undefined}
      >
        {detail || "—"}
      </div>
    </div>
  );
}
