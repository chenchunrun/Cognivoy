"use client";

// One consolidator run per (layer, key) doc. The run lives server-side and
// survives page refreshes — we persist the active run_id in localStorage and
// re-attach on mount, replaying events via GET /runs/{id}/events?since=N
// (SSE stream). Ported from the previous frontend's useMemoryRun.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import i18n from "i18next";

import { apiFetch, apiUrl } from "@/lib/api";
import type { LLMSelection } from "@/lib/unified-ws";
import {
  cancelRun,
  getRun,
  listRuns,
  retryRun,
  startRun,
  undoRun,
  type MemoryLayer,
  type RunHandle,
  type RunMode,
  type RunStatus,
} from "./api";

export type { RunMode, RunStatus, RunHandle };

export interface RunEventPayload {
  stage: string;
  [key: string]: unknown;
}

export interface RunEvent {
  seq: number;
  ts: string;
  payload: RunEventPayload;
}

export interface StartArgs {
  mode: RunMode;
  budget?: number;
  iterations?: number;
  llmSelection?: LLMSelection | null;
  language?: string;
}

interface State {
  run: RunHandle | null;
  events: RunEvent[];
  status: RunStatus | "idle";
  error: string | null;
}

const STORAGE_PREFIX = "dt:memory:active-run";

function storageKey(layer: string, key: string) {
  return `${STORAGE_PREFIX}:${layer}:${key}`;
}

function readPersistedRunId(layer: string, key: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(storageKey(layer, key));
}

function writePersistedRunId(layer: string, key: string, runId: string | null) {
  if (typeof window === "undefined") return;
  if (runId) {
    window.localStorage.setItem(storageKey(layer, key), runId);
  } else {
    window.localStorage.removeItem(storageKey(layer, key));
  }
}

export function useMemoryRun(layer: MemoryLayer, key: string) {
  const [state, setState] = useState<State>({
    run: null,
    events: [],
    status: "idle",
    error: null,
  });
  const abortRef = useRef<AbortController | null>(null);
  const cursorRef = useRef<number>(0);
  // Track if we've initialised for this (layer, key) so a parent re-render
  // doesn't trigger duplicate reconnects.
  const initialisedFor = useRef<string>("");

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const attach = useCallback(
    async (runId: string, since = 0): Promise<void> => {
      try {
        const run = await getRun(runId);
        setState((s) => ({ ...s, run, status: run.status }));
      } catch {
        writePersistedRunId(layer, key, null);
        return;
      }

      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      cursorRef.current = since;

      try {
        const res = await apiFetch(
          apiUrl(`/api/v1/memory/runs/${runId}/events?since=${since}`),
          { signal: ctl.signal, cache: "no-store" },
        );
        const reader = res.body?.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (reader) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl = buffer.indexOf("\n\n");
          while (nl !== -1) {
            const chunk = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 2);
            const line = chunk
              .split("\n")
              .find((l) => l.startsWith("data:"))
              ?.replace(/^data:\s?/, "");
            if (line) {
              try {
                const parsed = JSON.parse(line);
                const seq =
                  typeof parsed.seq === "number"
                    ? parsed.seq
                    : cursorRef.current;
                const ts =
                  typeof parsed.ts === "string"
                    ? parsed.ts
                    : new Date().toISOString();
                const { seq: _s, ts: _t, ...payload } = parsed;
                void _s;
                void _t;
                cursorRef.current = seq + 1;
                setState((s) => {
                  const undoDepth =
                    typeof payload.undo_depth === "number"
                      ? payload.undo_depth
                      : null;
                  const endedStatus =
                    payload.stage === "run_ended" &&
                    typeof payload.status === "string"
                      ? (payload.status as RunStatus)
                      : null;
                  return {
                    ...s,
                    status: endedStatus ?? s.status,
                    run: s.run
                      ? {
                          ...s.run,
                          status: endedStatus ?? s.run.status,
                          undo_count: undoDepth ?? s.run.undo_count,
                        }
                      : s.run,
                    events: s.events.some((ev) => ev.seq === seq)
                      ? s.events
                      : [
                          ...s.events,
                          { seq, ts, payload: payload as RunEventPayload },
                        ],
                  };
                });
                if (
                  payload.stage === "run_ended" &&
                  typeof payload.status === "string"
                ) {
                  writePersistedRunId(layer, key, null);
                }
              } catch {
                // ignore malformed chunks
              }
            }
            nl = buffer.indexOf("\n\n");
          }
        }
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
        setState((s) => ({
          ...s,
          error: e instanceof Error ? e.message : i18n.t("stream failed"),
        }));
      }
    },
    [layer, key],
  );

  // Reset when the doc changes; re-attach to that doc's persisted run if any.
  useEffect(() => {
    const tag = `${layer}:${key}`;
    if (initialisedFor.current === tag) return;
    initialisedFor.current = tag;
    close();
    cursorRef.current = 0;
    setState({ run: null, events: [], status: "idle", error: null });

    void (async () => {
      let runId = readPersistedRunId(layer, key);
      try {
        if (runId) {
          try {
            await getRun(runId);
          } catch {
            runId = null;
          }
        }
        if (!runId) {
          const runs = await listRuns(layer, key);
          const active = runs.find(
            (r) => r.status === "running" || r.status === "queued",
          );
          if (active) {
            runId = active.id;
            writePersistedRunId(layer, key, runId);
          }
        }
      } catch {
        // best-effort recovery — if the API is unreachable we'll just start
        // a new run when the user clicks Run.
      }
      if (runId) await attach(runId);
    })();

    return () => close();
  }, [layer, key, close, attach]);

  const start = useCallback(
    async (args: StartArgs): Promise<void> => {
      setState((s) => ({ ...s, error: null, events: [], status: "queued" }));
      try {
        const run = await startRun({
          layer,
          key,
          mode: args.mode,
          budget: args.budget,
          iterations: args.iterations,
          llmSelection: args.llmSelection ?? null,
          language: args.language ?? "en",
        });
        writePersistedRunId(layer, key, run.id);
        await attach(run.id, 0);
      } catch (e) {
        setState((s) => ({
          ...s,
          status: "error",
          error: e instanceof Error ? e.message : i18n.t("start failed"),
        }));
      }
    },
    [layer, key, attach],
  );

  const cancel = useCallback(async (): Promise<void> => {
    if (!state.run) return;
    try {
      await cancelRun(state.run.id);
    } catch {
      // ignore: the server may already have terminated naturally.
    }
  }, [state.run]);

  const retry = useCallback(async (): Promise<void> => {
    if (!state.run || state.run.status === "running" || state.run.status === "queued") return;
    setState((s) => ({ ...s, error: null, events: [], status: "queued" }));
    try {
      const run = await retryRun(state.run.id);
      writePersistedRunId(layer, key, run.id);
      await attach(run.id, 0);
    } catch (e) {
      setState((s) => ({
        ...s,
        status: "error",
        error: e instanceof Error ? e.message : i18n.t("retry failed"),
      }));
    }
  }, [state.run, layer, key, attach]);

  const undo = useCallback(async (): Promise<boolean> => {
    if (!state.run) return false;
    try {
      const data = await undoRun(state.run.id);
      const ev = data.event;
      setState((s) => {
        const nextRun = s.run
          ? { ...s.run, undo_count: data.undo_count ?? s.run.undo_count }
          : s.run;
        if (!ev || typeof ev.seq !== "number") return { ...s, run: nextRun };
        const { seq, ts, ...payload } = ev;
        return {
          ...s,
          run: nextRun,
          events: s.events.some((item) => item.seq === seq)
            ? s.events
            : [
                ...s.events,
                {
                  seq,
                  ts: typeof ts === "string" ? ts : new Date().toISOString(),
                  payload: payload as RunEventPayload,
                },
              ],
        };
      });
      return true;
    } catch (e) {
      setState((s) => ({
        ...s,
        error: e instanceof Error ? e.message : i18n.t("undo failed"),
      }));
      return false;
    }
  }, [state.run]);

  const clear = useCallback(() => {
    setState({ run: null, events: [], status: "idle", error: null });
    writePersistedRunId(layer, key, null);
    close();
  }, [layer, key, close]);

  const isRunning = useMemo(
    () => state.status === "queued" || state.status === "running",
    [state.status],
  );

  return {
    run: state.run,
    events: state.events,
    status: state.status,
    error: state.error,
    isRunning,
    start,
    cancel,
    retry,
    undo,
    clear,
  };
}
