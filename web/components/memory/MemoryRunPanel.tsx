"use client";

// LLM workspace for one memory doc: pick a mode (Update / Audit / Dedup),
// override budget/iterations + model, run, watch the event stream live,
// cancel, undo the last write, or reset the doc entirely.
// Ported from the previous frontend's MemoryRunPanel; styling on the new
// UI kit. Note: without a configured LLM profile the run fails server-side
// and the error surfaces inline in the trace — expected in dev.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  GitBranch,
  Loader2,
  PlayCircle,
  RotateCcw,
  ScanSearch,
  Sparkles,
  Trash2,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { listLLMOptions, type LLMOption } from "@/lib/llm-options";
import type { LLMSelection } from "@/lib/unified-ws";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  Select,
  Tooltip,
  useToast,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import {
  getMemorySettings,
  resetDoc,
  type MemoryLayer,
  type MemorySettings,
} from "./api";
import { useMemoryRun, type RunEvent, type RunMode } from "./use-memory-run";

const MODE_META: { key: RunMode; icon: LucideIcon; tKey: string }[] = [
  { key: "update", icon: Sparkles, tKey: "Update memory" },
  { key: "audit", icon: ScanSearch, tKey: "Audit memory" },
  { key: "dedup", icon: GitBranch, tKey: "Dedup" },
];

export interface MemoryRunPanelProps {
  layer: MemoryLayer;
  docKey: string;
  onRunComplete?: () => void;
  onDocUpdated?: () => void;
}

export function MemoryRunPanel({
  layer,
  docKey,
  onRunComplete,
  onDocUpdated,
}: MemoryRunPanelProps) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { run, events, status, error, isRunning, start, cancel, retry, undo, clear } =
    useMemoryRun(layer, docKey);

  const [mode, setMode] = useState<RunMode>("update");
  // Per-mode overrides keep typed values stable while the user flips between
  // modes — each mode has its own input value, defaulting to the settings
  // value when no override exists.
  const [overrides, setOverrides] = useState<Record<RunMode, number | null>>({
    update: null,
    audit: null,
    dedup: null,
  });
  const budgetOverride = mode === "dedup" ? null : overrides[mode];
  const iterationsOverride = mode === "dedup" ? overrides.dedup : null;
  const [selection, setSelection] = useState<LLMSelection | null>(null);
  const [activeDefault, setActiveDefault] = useState<LLMSelection | null>(null);
  const [modelOptions, setModelOptions] = useState<LLMOption[]>([]);
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    void listLLMOptions()
      .then((data) => {
        setModelOptions(data.options);
        setActiveDefault(data.active);
      })
      .catch(() => setModelOptions([]));
    void getMemorySettings()
      .then(setSettings)
      .catch(() => setSettings(null));
  }, []);

  const defaultBudget = useMemo(() => {
    if (!settings) return null;
    if (mode === "update") {
      return layer === "L2"
        ? settings.update.l2_budget
        : settings.update.l3_budget;
    }
    if (mode === "audit") {
      return layer === "L2"
        ? settings.audit.l2_budget
        : settings.audit.l3_budget;
    }
    return null;
  }, [settings, mode, layer]);
  const defaultIterations = settings?.dedup.iterations ?? null;
  const budget = budgetOverride ?? defaultBudget;
  const iterations = iterationsOverride ?? defaultIterations;

  const effectiveSelection = selection ?? activeDefault ?? null;
  const handleRun = useCallback(() => {
    if (isRunning) return;
    const llmSelection = effectiveSelection
      ? {
          profile_id: effectiveSelection.profile_id,
          model_id: effectiveSelection.model_id,
        }
      : null;
    if (mode === "dedup") {
      void start({
        mode,
        iterations: typeof iterations === "number" ? iterations : undefined,
        llmSelection,
        language: i18n.language || "en",
      });
    } else {
      void start({
        mode,
        budget: typeof budget === "number" ? budget : undefined,
        llmSelection,
        language: i18n.language || "en",
      });
    }
  }, [isRunning, mode, iterations, budget, effectiveSelection, i18n.language, start]);

  // Notify parent when a run finishes so the doc preview can refresh.
  const lastCompleted = useRef<string | null>(null);
  useEffect(() => {
    if (!run || isRunning) return;
    if (
      run.status === "done" ||
      run.status === "cancelled" ||
      run.status === "error"
    ) {
      if (lastCompleted.current !== run.id) {
        lastCompleted.current = run.id;
        onRunComplete?.();
      }
    }
  }, [run, isRunning, onRunComplete]);

  const lastDocEvent = useRef<number | null>(null);
  useEffect(() => {
    if (!onDocUpdated) return;
    const latest = [...events]
      .reverse()
      .find(
        (ev) =>
          ev.payload.stage === "doc_updated" ||
          ev.payload.stage === "undo_applied",
      );
    if (!latest || lastDocEvent.current === latest.seq) return;
    lastDocEvent.current = latest.seq;
    onDocUpdated();
  }, [events, onDocUpdated]);

  const undoDepth = useMemo(() => {
    let depth = run?.undo_count ?? 0;
    for (const ev of events) {
      const value = ev.payload.undo_depth;
      if (
        (ev.payload.stage === "doc_updated" ||
          ev.payload.stage === "undo_applied") &&
        typeof value === "number"
      ) {
        depth = value;
      }
    }
    return depth;
  }, [events, run?.undo_count]);

  const handleReset = useCallback(async () => {
    setResetting(true);
    try {
      await resetDoc(layer, docKey);
      clear();
      onDocUpdated?.();
      setResetOpen(false);
      toast({ variant: "success", title: t("Memory doc reset") });
    } catch (e) {
      toast({
        variant: "destructive",
        title: t("Reset failed"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setResetting(false);
    }
  }, [layer, docKey, clear, onDocUpdated, t, toast]);

  const turns = useMemo(() => groupByTurn(events), [events]);
  const selectedModelKey = effectiveSelection
    ? `${effectiveSelection.profile_id}:${effectiveSelection.model_id}`
    : "";

  return (
    <Card className="flex min-h-[420px] flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <Bot size={14} className="text-muted-foreground" />
          {t("LLM workspace")}
          {isRunning && (
            <Badge variant="primary" className="text-[10px]">
              {status === "queued" ? t("Queued") : t("Running")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          {run && events.length > 0 && (
            <>
              {(run.status === "error" || run.status === "cancelled") && (
                <Tooltip content={t("Retry with the same settings")}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 text-[11px]"
                    onClick={() => void retry()}
                    disabled={isRunning}
                  >
                    <RotateCcw size={12} />
                    {t("Retry")}
                  </Button>
                </Tooltip>
              )}
              <Tooltip content={t("Undo last memory edit")}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-[11px]"
                  onClick={() => void undo()}
                  disabled={isRunning || undoDepth <= 0}
                >
                  <Undo2 size={12} />
                  {undoDepth > 0 && <span>{undoDepth}</span>}
                </Button>
              </Tooltip>
              <Tooltip content={t("Clear trace")}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5"
                  onClick={clear}
                  disabled={isRunning}
                >
                  <Trash2 size={12} />
                </Button>
              </Tooltip>
            </>
          )}
          <Tooltip content={t("Reset memory (delete md + seen-id state)")}>
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-warning-border text-[11px] text-warning hover:bg-warning-muted"
              onClick={() => setResetOpen(true)}
              disabled={isRunning}
            >
              <RotateCcw size={12} />
              {t("Reset")}
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* Composer */}
      <div className="space-y-2 border-b border-border bg-muted-subtle px-3 py-2.5">
        <div className="grid grid-cols-3 gap-1.5">
          {MODE_META.map(({ key, icon: Icon, tKey }) => (
            <button
              key={key}
              type="button"
              disabled={isRunning}
              onClick={() => setMode(key)}
              className={cn(
                "inline-flex min-w-0 items-center justify-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs transition-colors duration-150 disabled:opacity-50",
                mode === key
                  ? "bg-muted font-medium text-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon size={12} className="shrink-0" />
              <span className="truncate">{t(tKey)}</span>
            </button>
          ))}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5">
          {mode === "dedup" ? (
            <NumberField
              value={iterations}
              onChange={(v) =>
                setOverrides((prev) => ({ ...prev, dedup: v }))
              }
              label={t("Iter")}
              min={1}
              max={20}
              disabled={isRunning}
            />
          ) : (
            <NumberField
              value={budget}
              onChange={(v) =>
                setOverrides((prev) => ({ ...prev, [mode]: v }))
              }
              label={t("Budget")}
              min={1}
              max={200}
              disabled={isRunning}
            />
          )}
          <Select
            aria-label={t("Model")}
            value={selectedModelKey}
            disabled={isRunning || modelOptions.length === 0}
            onChange={(e) => {
              const opt = modelOptions.find(
                (o) => `${o.profile_id}:${o.model_id}` === e.target.value,
              );
              setSelection(
                opt
                  ? { profile_id: opt.profile_id, model_id: opt.model_id }
                  : null,
              );
            }}
            className="h-8 text-xs"
          >
            {modelOptions.length === 0 && (
              <option value="">{t("Default model")}</option>
            )}
            {modelOptions.map((opt) => (
              <option
                key={`${opt.profile_id}:${opt.model_id}`}
                value={`${opt.profile_id}:${opt.model_id}`}
              >
                {opt.model_name}
                {opt.is_active_default ? ` · ${t("default")}` : ""}
              </option>
            ))}
          </Select>
          {isRunning ? (
            <Button
              variant="secondary"
              size="sm"
              className="h-8 w-9 px-0"
              onClick={() => void cancel()}
              title={t("Cancel")}
            >
              <CircleSlash size={14} />
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 w-9 px-0"
              onClick={handleRun}
              title={t("Run")}
            >
              <PlayCircle size={14} />
            </Button>
          )}
        </div>
      </div>

      {/* Event stream */}
      <div className="max-h-[520px] min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {events.length === 0 && status === "idle" ? (
          <div className="grid h-full min-h-[200px] place-items-center text-center text-xs text-muted-foreground">
            <div className="max-w-xs space-y-1.5">
              <Bot size={20} className="mx-auto opacity-60" />
              <p>
                {t(
                  "Pick a mode and click Run. The LLM trace — system prompt, user prompt, response — appears here, turn by turn.",
                )}
              </p>
            </div>
          </div>
        ) : (
          <ol className="space-y-2">
            {turns.map((turn) => (
              <TurnCard key={`${turn.kind}-${turn.id}`} turn={turn} />
            ))}
            {isRunning && (
              <li className="flex items-center gap-2 rounded-md bg-muted-subtle px-2.5 py-1.5 text-xs text-muted-foreground">
                <Loader2 size={12} className="animate-spin" />
                {t("Working…")}
              </li>
            )}
            {error && (
              <li className="flex items-start gap-2 rounded-md border border-destructive-border bg-destructive-muted px-2.5 py-1.5 text-xs text-destructive">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                {error}
              </li>
            )}
          </ol>
        )}
      </div>

      <ConfirmDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={() => void handleReset()}
        title={t("Reset memory doc")}
        description={t(
          "Reset will delete the current memory file AND its seen-id state. The next Update will re-ingest every L1 entity from scratch. Continue?",
        )}
        confirmText={t("Reset")}
        destructive
        loading={resetting}
      />
    </Card>
  );
}

// ── Composer pieces ──────────────────────────────────────────────────

function NumberField({
  value,
  onChange,
  label,
  min,
  max,
  disabled,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  label: string;
  min: number;
  max: number;
  disabled: boolean;
}) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
        {label}
      </span>
      <Input
        type="number"
        aria-label={label}
        value={value ?? ""}
        min={min}
        max={max}
        disabled={disabled}
        placeholder="—"
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(null);
          const n = parseInt(raw, 10);
          if (!Number.isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className="h-8 pl-14 text-right text-xs"
      />
    </div>
  );
}

// ── Trace pieces ─────────────────────────────────────────────────────

type Turn =
  | { kind: "system"; id: string; ts: string; payload: RunEvent["payload"] }
  | {
      kind: "llm";
      id: string;
      ts: string;
      turn: number;
      chunkIndex: number | null;
      system_prompt: string;
      user_prompt: string;
      response: string;
      error: string | null;
      label: string | null;
    };

function groupByTurn(events: RunEvent[]): Turn[] {
  const out: Turn[] = [];
  const pending: Record<string, Turn & { kind: "llm" }> = {};
  for (const ev of events) {
    const p = ev.payload as Record<string, unknown>;
    const stage = String(p.stage || "");
    if (stage === "llm_io_start") {
      const turn = typeof p.turn === "number" ? p.turn : 0;
      const chunkIndex =
        typeof p.chunk_index === "number" ? (p.chunk_index as number) : null;
      const key = `${turn}:${chunkIndex}:${ev.seq}`;
      const card: Turn & { kind: "llm" } = {
        kind: "llm",
        id: key,
        ts: ev.ts,
        turn,
        chunkIndex,
        system_prompt: String(p.system_prompt || ""),
        user_prompt: String(p.user_prompt || ""),
        response: "",
        error: null,
        label: typeof p.label === "string" ? p.label : null,
      };
      pending[`${turn}:${chunkIndex}`] = card;
      out.push(card);
      continue;
    }
    if (stage === "llm_io_end") {
      const turn = typeof p.turn === "number" ? p.turn : 0;
      const chunkIndex =
        typeof p.chunk_index === "number" ? (p.chunk_index as number) : null;
      const card = pending[`${turn}:${chunkIndex}`];
      if (card) {
        card.response = String(p.response || "");
        card.error = typeof p.error === "string" ? p.error : null;
        delete pending[`${turn}:${chunkIndex}`];
      }
      continue;
    }
    if (stage === "llm_io_delta") {
      const turn = typeof p.turn === "number" ? p.turn : 0;
      const chunkIndex =
        typeof p.chunk_index === "number" ? (p.chunk_index as number) : null;
      const card = pending[`${turn}:${chunkIndex}`];
      if (card) card.response += String(p.delta || "");
      continue;
    }
    out.push({
      kind: "system",
      id: `sys-${ev.seq}`,
      ts: ev.ts,
      payload: ev.payload,
    });
  }
  return out;
}

function TurnCard({ turn }: { turn: Turn }) {
  if (turn.kind === "system") return <SystemEventRow event={turn.payload} />;
  return <LLMTurnCard turn={turn} />;
}

function SystemEventRow({ event }: { event: RunEvent["payload"] }) {
  const { t } = useTranslation();
  const stage = String(event.stage || "");
  const display = systemEventDisplay(stage, event, t);
  if (!display) return null;
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1.5 text-xs",
        display.tone === "ok"
          ? "border border-success-border bg-success-muted text-success"
          : display.tone === "warn"
            ? "border border-warning-border bg-warning-muted text-warning-foreground"
            : "bg-muted-subtle text-muted-foreground",
      )}
    >
      <display.icon size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-mono text-[10.5px] uppercase tracking-wide">
          {display.title}
        </div>
        {display.detail && (
          <div className="mt-0.5 break-words leading-snug">
            {display.detail}
          </div>
        )}
      </div>
    </li>
  );
}

function systemEventDisplay(
  stage: string,
  event: RunEvent["payload"],
  t: (k: string) => string,
): {
  icon: LucideIcon;
  title: string;
  detail: string;
  tone: "ok" | "warn" | "muted";
} | null {
  const num = (k: string) =>
    typeof event[k] === "number" ? String(event[k]) : null;
  const str = (k: string) =>
    typeof event[k] === "string" ? String(event[k]) : null;
  switch (stage) {
    case "run_started":
      return {
        icon: PlayCircle,
        title: t("Run started"),
        detail: `${event.mode}`,
        tone: "muted",
      };
    case "trace_loaded": {
      const total = num("total") ?? num("total_l2_entries");
      const fresh = num("new") ?? num("new_l2_entries");
      const parts = [
        total ? `total=${total}` : null,
        fresh ? `new=${fresh}` : null,
      ].filter(Boolean);
      return {
        icon: PlayCircle,
        title: t("Traces loaded"),
        detail: parts.join(" · "),
        tone: "muted",
      };
    }
    case "chunked":
      return {
        icon: PlayCircle,
        title: t("Chunked"),
        detail: [
          num("chunks") ? `chunks=${num("chunks")}` : null,
          num("budget") ? `budget=${num("budget")}` : null,
          num("chars") ? `chars=${num("chars")}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        tone: "muted",
      };
    case "progress": {
      const turn = num("turn");
      const total = num("total");
      return {
        icon: PlayCircle,
        title: t("Progress"),
        detail: turn && total ? `${turn}/${total}` : "",
        tone: "muted",
      };
    }
    case "facts_extracted":
      return {
        icon: CheckCircle2,
        title: t("Facts extracted"),
        detail: [
          num("kept") ? `kept=${num("kept")}` : null,
          num("added") ? `added=${num("added")}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        tone: "ok",
      };
    case "refs_dropped":
      return {
        icon: CircleSlash,
        title: t("Ref dropped"),
        detail: `${str("reason") || "?"} :: ${str("text") || ""}`,
        tone: "warn",
      };
    case "op_applied":
      return {
        icon: CheckCircle2,
        title: t("Edit applied"),
        detail: [str("op"), str("detail")].filter(Boolean).join(" · "),
        tone: "ok",
      };
    case "op_rejected":
      return {
        icon: CircleSlash,
        title: t("Edit rejected"),
        detail: [str("op"), str("detail")].filter(Boolean).join(" · "),
        tone: "warn",
      };
    case "doc_updated":
      return {
        icon: CheckCircle2,
        title: t("Markdown updated"),
        detail: [
          str("action"),
          num("turn") ? `turn=${num("turn")}` : null,
          num("undo_depth") ? `undo=${num("undo_depth")}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        tone: "ok",
      };
    case "undo_applied":
      return {
        icon: Undo2,
        title: t("Undo applied"),
        detail: [
          str("action"),
          num("undo_depth") ? `remaining=${num("undo_depth")}` : "remaining=0",
        ]
          .filter(Boolean)
          .join(" · "),
        tone: "warn",
      };
    case "done":
      return {
        icon: CheckCircle2,
        title: t("Done"),
        detail: [
          num("facts_added") ? `+${num("facts_added")} facts` : null,
          num("edits_applied") ? `+${num("edits_applied")} edits` : null,
          num("refs_dropped") ? `dropped=${num("refs_dropped")}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        tone: "ok",
      };
    case "run_ended":
      return {
        icon: CheckCircle2,
        title: t("Run ended"),
        detail: str("status") || "",
        tone: "muted",
      };
    case "cancelled":
      return { icon: CircleSlash, title: t("Cancelled"), detail: "", tone: "warn" };
    case "error":
      return {
        icon: AlertCircle,
        title: t("Error"),
        detail: str("message") || "",
        tone: "warn",
      };
    default:
      return null;
  }
}

function LLMTurnCard({ turn }: { turn: Extract<Turn, { kind: "llm" }> }) {
  const { t } = useTranslation();
  const tag =
    turn.chunkIndex !== null
      ? `t${turn.turn} · chunk ${turn.chunkIndex + 1}`
      : `t${turn.turn}`;
  return (
    <li className="space-y-1.5 rounded-md border border-border bg-card px-2.5 py-2">
      <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-wide text-muted-foreground">
        <Bot size={12} />
        <span>{turn.label || "llm"}</span>
        <span>·</span>
        <span>{tag}</span>
      </div>

      <Disclosure label={t("System prompt")} body={turn.system_prompt} />
      <Disclosure label={t("User prompt")} body={turn.user_prompt} />

      <div className="text-xs text-foreground">
        {turn.response ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed">
            {turn.response}
          </pre>
        ) : turn.error ? (
          <div className="rounded border border-destructive-border bg-destructive-muted px-2 py-1 text-[11px] text-destructive">
            {turn.error}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            {t("Streaming…")}
          </div>
        )}
      </div>
    </li>
  );
}

function Disclosure({ label, body }: { label: string; body: string }) {
  const [open, setOpen] = useState(false);
  if (!body) return null;
  return (
    <div className="text-[11px] text-muted-foreground">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted-subtle hover:text-foreground"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
        <span className="opacity-60">·&nbsp;{body.length}</span>
      </button>
      {open && (
        <pre className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted-subtle px-2 py-1.5 font-mono text-[10.5px] text-foreground">
          {body}
        </pre>
      )}
    </div>
  );
}
