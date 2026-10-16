"use client";

/**
 * Capability playground — run any registered tool or capability against the
 * live backend, tune its JSON parameters, and inspect the streamed event log
 * plus the final rendered result.
 *
 * Data flow (mirrors the previous frontend):
 *   GET  /api/v1/plugins/list                                  → catalog
 *   POST /api/v1/plugins/tools/{name}/execute-stream           → SSE (tools)
 *   POST /api/v1/plugins/capabilities/{name}/execute-stream    → SSE (caps)
 */

import * as React from "react";
import { Copy, FlaskConical, History, Play, Square, Terminal, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import { loadFromStorage, saveToStorage } from "@/lib/persistence";
import { filterFrontendTools, FRONTEND_HIDDEN_TOOLS } from "@/lib/playground-config";
import type { StreamEvent } from "@/lib/unified-ws";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Select,
  Skeleton,
  Textarea,
  useToast,
} from "@/components/ui";

import { EventLog } from "@/components/playground/EventLog";
import { JsonConfigEditor } from "@/components/playground/JsonConfigEditor";
import { ResultPanel } from "@/components/playground/ResultPanel";
import { readSseStream } from "@/components/playground/sse";
import { PageHeader } from "@/components/shell/PageHeader";
import type {
  CapabilityInfo,
  LogEntry,
  PluginSelection,
  PluginsListResponse,
  RunResult,
  ToolInfo,
} from "@/components/playground/types";

const DRAFTS_STORAGE_KEY = "playground_config_drafts";
const HISTORY_STORAGE_KEY = "playground_run_history";
const HISTORY_LIMIT = 20;

interface PlaygroundRunRecord {
  id: string;
  createdAt: number;
  selection: PluginSelection;
  request: Record<string, unknown>;
  result: RunResult | null;
  error: string;
}

interface PlaygroundErrorEnvelope {
  code?: string;
  message?: string;
  detail?: string | PlaygroundErrorEnvelope;
  details?: Record<string, unknown>;
  retryable?: boolean;
  trace_id?: string;
}

function playgroundErrorMessage(
  payload: PlaygroundErrorEnvelope | null,
  fallback: string,
): string {
  if (!payload) return fallback;
  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }
  if (typeof payload.detail === "string" && payload.detail.trim()) {
    return payload.detail;
  }
  if (payload.detail && typeof payload.detail === "object") {
    return playgroundErrorMessage(payload.detail, fallback);
  }
  return fallback;
}

function selectionKey(selection: PluginSelection): string {
  return `${selection.kind}:${selection.name}`;
}

/** Scaffold a JSON params object from a tool's manifest parameters. */
function scaffoldToolParams(tool: ToolInfo): Record<string, unknown> {
  const scaffold: Record<string, unknown> = {};
  for (const param of tool.parameters ?? []) {
    if (param.default !== null && param.default !== undefined) {
      scaffold[param.name] = param.default;
    } else if (param.type === "integer" || param.type === "number") {
      scaffold[param.name] = 0;
    } else if (param.type === "boolean") {
      scaffold[param.name] = false;
    } else {
      scaffold[param.name] = "";
    }
  }
  return scaffold;
}

export default function PlaygroundPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();

  const [tools, setTools] = React.useState<ToolInfo[]>([]);
  const [capabilities, setCapabilities] = React.useState<CapabilityInfo[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [executionEnabled, setExecutionEnabled] = React.useState(true);
  const [selection, setSelection] = React.useState<PluginSelection | null>(
    null,
  );

  const [content, setContent] = React.useState("");
  const [config, setConfig] = React.useState<Record<string, unknown> | null>(
    {},
  );

  const [running, setRunning] = React.useState(false);
  const [entries, setEntries] = React.useState<LogEntry[]>([]);
  const [answer, setAnswer] = React.useState("");
  const [result, setResult] = React.useState<RunResult | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [history, setHistory] = React.useState<PlaygroundRunRecord[]>([]);

  const abortRef = React.useRef<AbortController | null>(null);
  const entryIdRef = React.useRef(0);
  const [drafts, setDrafts] = React.useState<
    Record<string, Record<string, unknown>>
  >({});

  const loadPlugins = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(apiUrl("/api/v1/plugins/list"));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as PluginsListResponse;
      setExecutionEnabled(data.execution_enabled !== false);

      const visibleTools = (data.tools ?? []).filter(
        (tool) => !FRONTEND_HIDDEN_TOOLS.has(tool.name),
      );
      const visibleCapabilities = (data.capabilities ?? []).map((cap) => ({
        ...cap,
        tools_used: filterFrontendTools(cap.tools_used ?? []),
      }));
      setTools(visibleTools);
      setCapabilities(visibleCapabilities);

      setDrafts(loadFromStorage(DRAFTS_STORAGE_KEY, {}));
      setSelection((prev) => {
        if (prev) return prev;
        if (visibleCapabilities.length) {
          return { kind: "capability", name: visibleCapabilities[0].name };
        }
        if (visibleTools.length) {
          return { kind: "tool", name: visibleTools[0].name };
        }
        return null;
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  React.useEffect(() => {
    setHistory(loadFromStorage<PlaygroundRunRecord[]>(HISTORY_STORAGE_KEY, []));
  }, []);

  React.useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const activeTool =
    selection?.kind === "tool"
      ? (tools.find((tool) => tool.name === selection.name) ?? null)
      : null;
  const activeCapability =
    selection?.kind === "capability"
      ? (capabilities.find((cap) => cap.name === selection.name) ?? null)
      : null;

  const initialConfigText = React.useMemo(() => {
    if (!selection) return "{}";
    const draft = drafts[selectionKey(selection)];
    if (draft && typeof draft === "object") {
      return JSON.stringify(draft, null, 2);
    }
    const scaffold =
      selection.kind === "tool" && activeTool
        ? scaffoldToolParams(activeTool)
        : {};
    return JSON.stringify(scaffold, null, 2);
  }, [selection, activeTool, drafts]);

  const resetOutput = React.useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
    setEntries([]);
    setAnswer("");
    setResult(null);
    setRunError(null);
  }, []);

  const handleSelectionChange = (value: string) => {
    const [kind, ...rest] = value.split(":");
    const name = rest.join(":");
    if ((kind !== "tool" && kind !== "capability") || !name) return;
    resetOutput();
    setContent("");
    setSelection({ kind, name });
  };

  const handleConfigParsed = React.useCallback(
    (parsed: Record<string, unknown> | null) => {
      setConfig(parsed);
      if (!selection || !parsed) return;
      setDrafts((current) => {
        const next = { ...current, [selectionKey(selection)]: parsed };
        saveToStorage(DRAFTS_STORAGE_KEY, next);
        return next;
      });
    },
    [selection],
  );

  const pushEntry = (
    type: string,
    entryContent: string,
    stage?: string,
    metadata?: Record<string, unknown>,
  ) => {
    entryIdRef.current += 1;
    setEntries((prev) => [
      ...prev,
      { id: entryIdRef.current, type, content: entryContent, stage, metadata },
    ]);
  };

  const appendHistory = React.useCallback((record: PlaygroundRunRecord) => {
    setHistory((current) => {
      const next = [record, ...current].slice(0, HISTORY_LIMIT);
      saveToStorage(HISTORY_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const copyJson = React.useCallback(async (value: unknown, label: string) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
      toast({ title: t("{{label}} copied", { label }), variant: "success" });
    } catch {
      toast({ title: t("Copy failed"), variant: "destructive" });
    }
  }, [t, toast]);

  const run = async () => {
    if (!selection || running || config === null) return;
    const current = selection;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setEntries([]);
    setAnswer("");
    setResult(null);
    setRunError(null);

    let requestBody: Record<string, unknown> = {};
    let streamedAnswer = "";
    let completedResult: RunResult | null = null;
    let completedError = "";

    try {
      const isTool = current.kind === "tool";
      const path = isTool
        ? `/api/v1/plugins/tools/${current.name}/execute-stream`
        : `/api/v1/plugins/capabilities/${current.name}/execute-stream`;
      const body: Record<string, unknown> = isTool
        ? { params: config }
        : {
            content: content.trim(),
            config,
            language: i18n.language,
          };
      requestBody = body;

      const res = await apiFetch(apiUrl(path), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res
          .json()
          .catch(() => null)) as PlaygroundErrorEnvelope | null;
        throw new Error(playgroundErrorMessage(data, `HTTP ${res.status}`));
      }

      await readSseStream(res, (eventType, payload) => {
        if (eventType === "process_log") {
          pushEntry("process_log", String(payload.message ?? ""));
          return;
        }

        if (eventType === "stream") {
          const event = payload as unknown as StreamEvent;
          if (
            event.type === "session" ||
            event.type === "session_meta" ||
            event.type === "done"
          ) {
            return;
          }
          if (event.type === "content") {
            streamedAnswer += event.content;
            setAnswer((prev) => prev + event.content);
            return;
          }
          pushEntry(
            event.type,
            event.content ?? "",
            event.stage || undefined,
            event.metadata,
          );
          return;
        }

        if (eventType === "result") {
          if (isTool) {
            completedResult = {
              success: Boolean(payload.success),
              content: String(payload.content ?? ""),
              sources:
                (payload.sources as Array<Record<string, string>>) ?? [],
              extra: (payload.metadata as Record<string, unknown>) ?? {},
            };
            setResult(completedResult);
          } else {
            const data = (payload.data as Record<string, unknown>) ?? {};
            const response =
              typeof data.response === "string" ? data.response : "";
            const extra = Object.fromEntries(
              Object.entries(data).filter(([key]) => key !== "response"),
            );
            completedResult = {
              success: Boolean(payload.success),
              content: response || streamedAnswer,
              elapsedMs:
                typeof payload.elapsed_ms === "number"
                  ? payload.elapsed_ms
                  : undefined,
              sources: [],
              extra,
            };
            setResult(completedResult);
          }
          return;
        }

        if (eventType === "error") {
          const envelope = payload as PlaygroundErrorEnvelope;
          const detail = playgroundErrorMessage(envelope, t("Unknown error"));
          completedError = detail;
          setRunError(detail);
          pushEntry("error", detail, undefined, {
            code: envelope.code,
            retryable: envelope.retryable,
            trace_id: envelope.trace_id,
            ...(envelope.details ?? {}),
          });
        }
      });
      appendHistory({
        id: `${Date.now()}-${current.kind}-${current.name}`,
        createdAt: Date.now(),
        selection: current,
        request: requestBody,
        result: completedResult,
        error: completedError,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      completedError = message;
      setRunError(message);
      toast({
        title: t("Run failed"),
        description: message,
        variant: "destructive",
      });
      appendHistory({
        id: `${Date.now()}-${current.kind}-${current.name}`,
        createdAt: Date.now(),
        selection: current,
        request: requestBody,
        result: completedResult,
        error: completedError,
      });
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setRunning(false);
    setRunError(t("Run cancelled"));
    pushEntry("cancelled", t("Run cancelled"));
  };

  const canRun =
    !running &&
    config !== null &&
    selection !== null &&
    (selection.kind === "tool" || content.trim().length > 0) &&
    executionEnabled &&
    (selection.kind === "tool" ||
      activeCapability?.availability?.available !== false);

  const hasOutput =
    running || entries.length > 0 || answer.length > 0 || result !== null || runError !== null;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <PageHeader
        title={t("Playground")}
        description={t(
          "Run any tool or capability directly, tune its parameters, and inspect the live event stream.",
        )}
      />

      {!executionEnabled ? (
        <div role="alert" className="mb-5 rounded-xl border border-warning bg-warning-muted px-4 py-3 text-sm text-foreground">
          {t("Direct Playground execution has been disabled by an administrator.")}
        </div>
      ) : null}

      {loading ? (
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="w-full space-y-3 lg:max-w-sm">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
          <div className="flex-1 space-y-3">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      ) : loadError ? (
        <EmptyState
          icon={FlaskConical}
          title={t("Could not load plugins")}
          description={loadError}
          action={
            <Button variant="outline" size="sm" onClick={() => void loadPlugins()}>
              {t("Retry")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          {/* Left: configuration */}
          <Card className="w-full shrink-0 lg:max-w-sm">
            <CardContent className="space-y-4 pt-5">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-foreground">
                  {t("Tool or capability")}
                </label>
                <Select
                  value={selection ? selectionKey(selection) : ""}
                  onChange={(e) => handleSelectionChange(e.target.value)}
                  disabled={running}
                  aria-label={t("Tool or capability")}
                >
                  {capabilities.length > 0 && (
                    <optgroup label={t("Capabilities")}>
                      {capabilities.map((cap) => (
                        <option
                          key={`capability-${cap.name}`}
                          value={`capability:${cap.name}`}
                        >
                          {cap.name}
                          {cap.availability?.available === false
                            ? ` — ${t("Unavailable")}`
                            : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {tools.length > 0 && (
                    <optgroup label={t("Tools")}>
                      {tools.map((tool) => (
                        <option
                          key={`tool-${tool.name}`}
                          value={`tool:${tool.name}`}
                        >
                          {tool.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </div>

              {/* Manifest */}
              {(activeTool || activeCapability) && (
                <div className="rounded-lg border border-border bg-muted-subtle px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <Terminal size={13} className="text-muted-foreground" />
                    <span className="font-mono text-xs font-medium text-foreground">
                      {selection?.name}
                    </span>
                    <Badge variant="primary">
                      {selection?.kind === "tool" ? t("Tool") : t("Capability")}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {activeTool?.description ?? activeCapability?.description}
                  </p>
                  {activeCapability?.stages &&
                    activeCapability.stages.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {activeCapability.stages.map((stage) => (
                          <Badge key={stage} variant="outline">
                            {stage}
                          </Badge>
                        ))}
                      </div>
                    )}
                  {activeCapability?.tools_used &&
                    activeCapability.tools_used.length > 0 && (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {t("Uses tools: {{tools}}", {
                          tools: activeCapability.tools_used.join(", "),
                        })}
                      </p>
                    )}
                  {activeCapability?.availability?.available === false && (
                    <p className="mt-2 rounded-md bg-destructive-muted px-2 py-1.5 text-[11px] text-destructive">
                      {t("Unavailable")}: {activeCapability.availability.install_hint}
                    </p>
                  )}
                </div>
              )}

              {/* Capability content input */}
              {selection?.kind === "capability" && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-foreground">
                    {t("Content")}
                  </label>
                  <Textarea
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void run();
                      }
                    }}
                    autoResize
                    rows={3}
                    disabled={running}
                    placeholder={t("Ask something or describe the task...")}
                    aria-label={t("Content")}
                  />
                </div>
              )}

              {/* JSON config editor */}
              {selection && (
                <JsonConfigEditor
                  resetKey={selectionKey(selection)}
                  initialText={initialConfigText}
                  label={
                    selection.kind === "tool"
                      ? t("Parameters (JSON)")
                      : t("Config (JSON)")
                  }
                  disabled={running}
                  rows={selection.kind === "tool" ? 8 : 6}
                  onParsed={handleConfigParsed}
                />
              )}

              <div className="flex items-center gap-2">
                <Button
                  onClick={() => void run()}
                  disabled={!canRun}
                  loading={running}
                  size="sm"
                >
                  {!running && <Play size={14} />}
                  {running ? t("Running...") : t("Run")}
                </Button>
                {running && (
                  <Button variant="outline" size="sm" onClick={stop}>
                    <Square size={13} />
                    {t("Stop")}
                  </Button>
                )}
                {!running && runError && (
                  <Button variant="outline" size="sm" onClick={() => void run()} disabled={!canRun}>
                    {t("Retry run")}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Right: output */}
          <div className="min-w-0 flex-1 space-y-4">
            {hasOutput ? (
              <>
                <EventLog entries={entries} running={running} />
                <ResultPanel
                  answer={answer}
                  result={result}
                  error={runError}
                  running={running}
                />
              </>
            ) : (
              <EmptyState
                icon={FlaskConical}
                title={t("Nothing here yet")}
                description={t(
                  "Pick a tool or capability, adjust its parameters, and press Run to see the event stream and result.",
                )}
              />
            )}
            {history.length ? (
              <Card data-testid="playground-history">
                <CardContent className="pt-5">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <History size={15} className="text-muted-foreground" />
                      <h2 className="text-sm font-medium text-foreground">
                        {t("Run history")}
                      </h2>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setHistory([]);
                        saveToStorage(HISTORY_STORAGE_KEY, []);
                      }}
                    >
                      <Trash2 size={13} />
                      {t("Clear")}
                    </Button>
                  </div>
                  <div className="divide-y divide-border">
                    {history.map((record) => (
                      <div key={record.id} className="flex flex-wrap items-center gap-2 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-xs text-foreground">
                            {record.selection.kind}:{record.selection.name}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted-foreground">
                            {new Date(record.createdAt).toLocaleString()} · {record.error ? t("Failed") : t("Completed")}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void copyJson(record.request, t("Request"))}
                        >
                          <Copy size={12} />
                          {t("Copy request")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void copyJson(record.result ?? { error: record.error }, t("Result"))}
                        >
                          <Copy size={12} />
                          {t("Copy result")}
                        </Button>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
