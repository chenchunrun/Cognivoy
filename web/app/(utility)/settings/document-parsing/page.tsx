"use client";

import * as React from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  ScanLine,
  XCircle,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
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
  SettingsLinkCard,
  SettingsPageHeader,
} from "@/components/settings/shared";

interface EngineMeta {
  id: string;
  name: string;
  description: string;
  needs_local_models: boolean;
  available: boolean;
}

interface Readiness {
  ready: boolean;
  reason: string;
  message: string;
}

interface DocumentParsingPayload {
  engine: string;
  engines: Record<string, Record<string, unknown>>;
  available_engines: EngineMeta[];
  readiness: Record<string, Readiness>;
}

const PIP_HINT: Record<string, string> = {
  markitdown: "pip install cognivoy[parse-markitdown]",
  pymupdf4llm: "pip install cognivoy[parse-pymupdf4llm]",
};

export default function DocumentParsingSettingsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [data, setData] = React.useState<DocumentParsingPayload | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoadError(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/settings/document-parsing"));
      const payload = (await res.json().catch(() => ({}))) as
        | DocumentParsingPayload
        | { detail?: string };
      if (!res.ok) {
        throw new Error(
          "detail" in payload && payload.detail
            ? payload.detail
            : t("Failed to load document parsing settings."),
        );
      }
      setData(payload as DocumentParsingPayload);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const putDocumentParsing = React.useCallback(
    async (body: Record<string, unknown>) => {
      setBusy(true);
      try {
        const res = await apiFetch(
          apiUrl("/api/v1/settings/document-parsing"),
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        const payload = (await res.json().catch(() => ({}))) as
          | DocumentParsingPayload
          | { detail?: string };
        if (!res.ok) {
          throw new Error(
            "detail" in payload && payload.detail
              ? payload.detail
              : t("Failed to save document parsing settings."),
          );
        }
        setData(payload as DocumentParsingPayload);
      } catch (err) {
        toast({
          title: t("Failed to save document parsing settings"),
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setBusy(false);
      }
    },
    [t, toast],
  );

  if (loading) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Document Parsing")}
          description={t(
            "How uploaded documents are converted into text for knowledge bases and question generation.",
          )}
        />
        <div className="space-y-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div>
        <SettingsPageHeader
          title={t("Document Parsing")}
          description={t(
            "How uploaded documents are converted into text for knowledge bases and question generation.",
          )}
        />
        <EmptyState
          icon={AlertCircle}
          title={t("Couldn't load document parsing settings")}
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

  const activeMeta = data.available_engines.find((e) => e.id === data.engine);

  return (
    <div>
      <SettingsPageHeader
        title={t("Document Parsing")}
        description={t(
          "How uploaded documents are converted into text for knowledge bases and question generation. Pick an engine and its options.",
        )}
      />

      <section className="mb-8">
        <h3 className="mb-3 text-sm font-medium text-foreground">
          {t("Engine")}
        </h3>
        <div className="flex flex-col gap-2">
          {data.available_engines.map((engine) => {
            const active = engine.id === data.engine;
            return (
              <button
                key={engine.id}
                type="button"
                disabled={busy || engine.id === "docling"}
                onClick={() =>
                  !active && void putDocumentParsing({ engine: engine.id })
                }
                className={cn(
                  "flex items-start justify-between gap-4 rounded-xl border bg-card px-4 py-3 text-left transition-colors duration-150 disabled:opacity-60",
                  active
                    ? "border-primary"
                    : "border-border hover:border-ring",
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {engine.name}
                    </span>
                    {active && (
                      <Badge variant="primary">{t("Active")}</Badge>
                    )}
                    {!engine.available && (
                      <Badge variant="outline">{engine.id === "docling" ? t("Unavailable") : t("Not installed")}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {engine.description}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {data.engine === "text_only" && (
        <SettingSection
          title={t("Text-only")}
          description={t(
            "Built-in plain text extraction for PDF, Office, and text files. No optional parser package, model download, OCR, or layout reconstruction.",
          )}
        >
          <SettingRow
            title={t("Model status")}
            control={
              <span className="inline-flex items-center gap-1 text-xs text-success">
                <CheckCircle2 size={14} />
                {t("Ready to parse.")}
              </span>
            }
          />
        </SettingSection>
      )}

      {data.engine === "mineru" && (
        <SettingsLinkCard
          href="/settings/mineru"
          icon={ScanLine}
          title={t("MinerU options")}
          description={t(
            "Mode, model weights, API token, and parsing options live on the MinerU page.",
          )}
          actionLabel={t("Open MinerU settings")}
        />
      )}

      {data.engine === "docling" && (
        <DoclingPanel
          slice={data.engines.docling || {}}
          readiness={data.readiness.docling}
          available={activeMeta?.available ?? false}
          busy={busy}
          onInstalled={() => void load()}
          onSave={(patch) =>
            void putDocumentParsing({ engines: { docling: patch } })
          }
        />
      )}

      {data.engine === "markitdown" && (
        <MarkItDownPanel
          slice={data.engines.markitdown || {}}
          available={activeMeta?.available ?? false}
          busy={busy}
          onInstalled={() => void load()}
          onSave={(patch) =>
            void putDocumentParsing({ engines: { markitdown: patch } })
          }
        />
      )}

      {data.engine === "pymupdf4llm" && (
        <PyMuPDF4LLMPanel
          slice={data.engines.pymupdf4llm || {}}
          available={activeMeta?.available ?? false}
          busy={busy}
          onInstalled={() => void load()}
          onSave={(patch) =>
            void putDocumentParsing({ engines: { pymupdf4llm: patch } })
          }
        />
      )}
    </div>
  );
}

// ── Background jobs (install package / download models) ────────────────────

type JobKind = "install" | "models";

interface JobStatus {
  state: "running" | "done" | "failed" | "cancelled" | string;
  lines: string[];
  message: string;
}

function useBackgroundJob(
  kind: JobKind,
  startUrl: string,
  engineId: string,
  onDone: () => void,
) {
  const { t } = useTranslation();
  const [job, setJob] = React.useState<JobStatus | null>(null);
  const [starting, setStarting] = React.useState(false);
  const cursor = React.useRef(0);
  const notifiedDone = React.useRef(false);

  React.useEffect(() => {
    if (job?.state !== "running") return;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(
          apiUrl(
            `/api/v1/settings/document-parsing/job/status?cursor=${cursor.current}`,
          ),
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          state?: string;
          kind?: string;
          lines?: string[];
          next_cursor?: number;
          message?: string;
        };
        // A different kind of job is running — leave our view alone.
        if (data.kind && data.kind !== kind) return;
        cursor.current = data.next_cursor ?? cursor.current;
        setJob((current) =>
          current
            ? {
                state: data.state || current.state,
                lines: [...current.lines, ...(data.lines || [])].slice(-100),
                message: data.message || "",
              }
            : current,
        );
        if (data.state === "done" && !notifiedDone.current) {
          notifiedDone.current = true;
          onDone();
        }
      } catch {
        // transient network error — keep polling
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [job?.state, kind, onDone]);

  async function start() {
    setStarting(true);
    notifiedDone.current = false;
    try {
      const res = await apiFetch(apiUrl(startUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine: engineId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        detail?: string;
      };
      if (!res.ok || !data.ok) {
        setJob({
          state: "failed",
          lines: [],
          message: data.message || data.detail || t("Failed."),
        });
        return;
      }
      cursor.current = 0;
      setJob({ state: "running", lines: [], message: "" });
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    try {
      await apiFetch(apiUrl("/api/v1/settings/document-parsing/job/cancel"), {
        method: "POST",
      });
    } catch {
      // status polling surfaces the final state either way
    }
  }

  return { job, starting, start, cancel };
}

function JobLog({
  job,
  runningLabel,
  doneLabel,
}: {
  job: JobStatus | null;
  runningLabel: string;
  doneLabel: string;
}) {
  if (!job) return null;
  return (
    <div className="px-4 py-3.5">
      <div
        className={cn(
          "mb-2 inline-flex items-center gap-1.5 text-xs",
          job.state === "done"
            ? "text-success"
            : job.state === "running"
              ? "text-muted-foreground"
              : "text-destructive",
        )}
      >
        {job.state === "done" ? (
          <CheckCircle2 size={14} />
        ) : job.state === "running" ? null : (
          <XCircle size={14} />
        )}
        {job.state === "running"
          ? runningLabel
          : job.state === "done"
            ? doneLabel
            : job.message || job.state}
      </div>
      {job.lines.length > 0 && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {job.lines.join("\n")}
        </pre>
      )}
    </div>
  );
}

function ReadinessNotice({ readiness }: { readiness?: Readiness }) {
  const { t } = useTranslation();
  if (!readiness) return null;
  if (readiness.ready) {
    return (
      <div className="flex items-center gap-1.5 px-4 py-3.5 text-xs text-success">
        <CheckCircle2 size={14} />
        {t("Ready to parse.")}
      </div>
    );
  }
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <XCircle size={14} className="mt-0.5 shrink-0 text-warning" />
        <span className="min-w-0">{readiness.message}</span>
      </div>
    </div>
  );
}

// ── Per-engine panels ───────────────────────────────────────────────────────

function NotInstalledSection({
  engineId,
  title,
  onInstalled,
}: {
  engineId: string;
  title: string;
  onInstalled: () => void;
}) {
  const { t } = useTranslation();
  const { job, starting, start, cancel } = useBackgroundJob(
    "install",
    "/api/v1/settings/document-parsing/install",
    engineId,
    onInstalled,
  );
  return (
    <SettingSection
      title={title}
      description={t(
        "Not installed yet. Install the package to use this engine — runs on the server, no terminal needed.",
      )}
    >
      <SettingRow
        title={t("Install package")}
        description={PIP_HINT[engineId]}
        control={
          job?.state === "running" ? (
            <Button variant="outline" size="sm" onClick={() => void cancel()}>
              {t("Cancel")}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              loading={starting}
              onClick={() => void start()}
            >
              <Download size={13} />
              {t("Download & install")}
            </Button>
          )
        }
      />
      <JobLog
        job={job}
        runningLabel={t("Installing {{name}}...", { name: title })}
        doneLabel={t("Installed. Reloading...")}
      />
    </SettingSection>
  );
}

function DoclingPanel({
  slice,
  readiness,
  available,
  busy,
  onInstalled,
  onSave,
}: {
  slice: Record<string, unknown>;
  readiness?: Readiness;
  available: boolean;
  busy: boolean;
  onInstalled: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  // Hook order must stay stable across the available flip (install → reload),
  // so this is hoisted above the early return.
  const models = useBackgroundJob(
    "models",
    "/api/v1/settings/document-parsing/models/download",
    "docling",
    onInstalled,
  );
  if (!available) {
    return (
      <SettingSection title={t("Docling")} description={t("Unavailable")}>
        <ReadinessNotice readiness={readiness} />
      </SettingSection>
    );
  }
  return (
    <SettingSection
      title={t("Docling")}
      description={t(
        "Structured conversion of PDF/Office/HTML/images. Downloads layout/table models on first run.",
      )}
    >
      <ReadinessNotice readiness={readiness} />
      {readiness && !readiness.ready && (
        <>
          <SettingRow
            title={t("Download models")}
            description={t(
              "Fetch the model weights onto the server now — no terminal needed.",
            )}
            control={
              models.job?.state === "running" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void models.cancel()}
                >
                  {t("Cancel")}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={models.starting}
                  onClick={() => void models.start()}
                >
                  <Download size={13} />
                  {t("Download models")}
                </Button>
              )
            }
          />
          <JobLog
            job={models.job}
            runningLabel={t("Downloading models...")}
            doneLabel={t("Downloaded. Reloading...")}
          />
        </>
      )}
      <SettingRow
        title={t("Allow automatic model download")}
        description={t(
          "Off by default. When off, parsing fails with guidance instead of silently downloading models.",
        )}
        control={
          <Toggle
            checked={Boolean(slice.allow_local_model_download)}
            disabled={busy}
            onCheckedChange={(v) => onSave({ allow_local_model_download: v })}
            aria-label={t("Allow automatic model download")}
          />
        }
      />
      <SettingRow
        title={t("Recognize tables")}
        control={
          <Toggle
            checked={slice.do_table_structure !== false}
            disabled={busy}
            onCheckedChange={(v) => onSave({ do_table_structure: v })}
            aria-label={t("Recognize tables")}
          />
        }
      />
      <SettingRow
        title={t("OCR scanned pages")}
        description={t("Slower; enable for image-only PDFs.")}
        control={
          <Toggle
            checked={Boolean(slice.do_ocr)}
            disabled={busy}
            onCheckedChange={(v) => onSave({ do_ocr: v })}
            aria-label={t("OCR scanned pages")}
          />
        }
      />
    </SettingSection>
  );
}

function MarkItDownPanel({
  slice,
  available,
  busy,
  onInstalled,
  onSave,
}: {
  slice: Record<string, unknown>;
  available: boolean;
  busy: boolean;
  onInstalled: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  if (!available) {
    return (
      <NotInstalledSection
        engineId="markitdown"
        title={t("markitdown")}
        onInstalled={onInstalled}
      />
    );
  }
  return (
    <SettingSection
      title={t("markitdown")}
      description={t(
        "Lightweight Markdown conversion with broad format support. No model downloads.",
      )}
    >
      <SettingRow
        title={t("Describe images with the vision model")}
        description={t(
          "Reserved — uses Cognivoy's vision model to caption images during conversion.",
        )}
        control={
          <Toggle
            checked={Boolean(slice.enable_llm_image_description)}
            disabled={busy}
            onCheckedChange={(v) => onSave({ enable_llm_image_description: v })}
            aria-label={t("Describe images with the vision model")}
          />
        }
      />
    </SettingSection>
  );
}

const PYMUPDF4LLM_IMAGE_FORMATS = ["png", "jpg", "jpeg", "webp"];

function PyMuPDF4LLMPanel({
  slice,
  available,
  busy,
  onInstalled,
  onSave,
}: {
  slice: Record<string, unknown>;
  available: boolean;
  busy: boolean;
  onInstalled: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  if (!available) {
    return (
      <NotInstalledSection
        engineId="pymupdf4llm"
        title={t("PyMuPDF4LLM")}
        onInstalled={onInstalled}
      />
    );
  }
  const writeImages = slice.write_images !== false;
  const imageFormat =
    typeof slice.image_format === "string" ? slice.image_format : "png";
  const imageDpi = typeof slice.image_dpi === "number" ? slice.image_dpi : 150;
  return (
    <SettingSection
      title={t("PyMuPDF4LLM")}
      description={t(
        "Lightweight PDF/e-book → Markdown built on PyMuPDF. No model downloads or CUDA, so it runs on low-end machines.",
      )}
    >
      <SettingRow
        title={t("Extract images")}
        description={t(
          "Save embedded images and rendered vector graphics into the parse, referenced from the Markdown.",
        )}
        control={
          <Toggle
            checked={writeImages}
            disabled={busy}
            onCheckedChange={(v) => onSave({ write_images: v })}
            aria-label={t("Extract images")}
          />
        }
      />
      {writeImages && (
        <>
          <SettingRow
            title={t("Image format")}
            control={
              <Select
                className="w-28"
                value={imageFormat}
                disabled={busy}
                onChange={(e) => onSave({ image_format: e.target.value })}
              >
                {PYMUPDF4LLM_IMAGE_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
            }
          />
          <SettingRow
            title={t("Image resolution (DPI)")}
            description={t("Higher is sharper but larger. 72–600.")}
            control={
              <Input
                type="number"
                className="w-24"
                min={72}
                max={600}
                step={1}
                value={imageDpi}
                disabled={busy}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) onSave({ image_dpi: v });
                }}
              />
            }
          />
        </>
      )}
    </SettingSection>
  );
}
