"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, wsUrl } from "@/lib/api";
import {
  formatKnowledgeTaskFailure,
  type KnowledgeTaskFailure,
  type ProgressInfo,
} from "@/lib/knowledge-helpers";

export type TaskKind = "create" | "upload" | "reindex" | "retry";

export interface TaskState {
  taskId: string;
  kind: TaskKind;
  label: string;
  logs: string[];
  executing: boolean;
  error: string | null;
  cancelled: boolean;
}

interface UseKnowledgeProgressOptions {
  /** Called when a KB's task reaches a terminal stage (completed or error). */
  onComplete?: (kbName: string) => void;
}

/**
 * Tracks live indexing progress for knowledge bases over two channels:
 * the per-KB progress WebSocket (`/api/v1/knowledge/{kb}/progress/ws`) and
 * the per-task SSE log stream (`/api/v1/knowledge/tasks/{id}/stream`).
 */
export function useKnowledgeProgress(options?: UseKnowledgeProgressOptions) {
  const onCompleteRef = useRef(options?.onComplete);
  useEffect(() => {
    onCompleteRef.current = options?.onComplete;
  }, [options?.onComplete]);

  const [progressByKb, setProgressByKb] = useState<
    Record<string, ProgressInfo>
  >({});
  const [tasksByKb, setTasksByKb] = useState<Record<string, TaskState>>({});

  const socketsRef = useRef<Record<string, WebSocket>>({});
  const sourcesRef = useRef<Record<string, EventSource>>({});

  const closeSocket = useCallback((kbName: string) => {
    socketsRef.current[kbName]?.close();
    delete socketsRef.current[kbName];
  }, []);

  const closeSource = useCallback((kbName: string) => {
    sourcesRef.current[kbName]?.close();
    delete sourcesRef.current[kbName];
  }, []);

  const closeAll = useCallback(() => {
    Object.values(socketsRef.current).forEach((s) => s.close());
    socketsRef.current = {};
    Object.values(sourcesRef.current).forEach((s) => s.close());
    sourcesRef.current = {};
  }, []);

  const setProgress = useCallback((kbName: string, info: ProgressInfo) => {
    setProgressByKb((prev) => ({ ...prev, [kbName]: info }));
  }, []);

  const clearProgress = useCallback((kbName: string) => {
    setProgressByKb((prev) => {
      if (!(kbName in prev)) return prev;
      const next = { ...prev };
      delete next[kbName];
      return next;
    });
  }, []);

  const subscribeWs = useCallback(
    (kbName: string, expectedTaskId?: string) => {
      closeSocket(kbName);
      const query = expectedTaskId
        ? `?task_id=${encodeURIComponent(expectedTaskId)}`
        : "";
      const socket = new WebSocket(
        wsUrl(
          `/api/v1/knowledge/${encodeURIComponent(kbName)}/progress/ws${query}`,
        ),
      );
      socketsRef.current[kbName] = socket;

      socket.onmessage = (event) => {
        try {
          const raw = JSON.parse(event.data) as {
            type?: string;
            data?: ProgressInfo;
          } & ProgressInfo;
          const progress: ProgressInfo =
            raw?.type === "progress" && raw.data ? raw.data : raw;
          if (!progress || typeof progress !== "object") return;
          if (
            expectedTaskId &&
            progress.task_id &&
            progress.task_id !== expectedTaskId
          ) {
            return;
          }
          setProgress(kbName, progress);
          const stage = progress.stage;
          if (stage === "completed" || stage === "error") {
            closeSocket(kbName);
            onCompleteRef.current?.(kbName);
          }
        } catch {
          // ignore malformed event
        }
      };

      socket.onerror = () => closeSocket(kbName);
      socket.onclose = () => {
        delete socketsRef.current[kbName];
      };
    },
    [closeSocket, setProgress],
  );

  const openTaskStream = useCallback(
    (
      kbName: string,
      taskId: string,
      kind: TaskKind,
      label: string,
      initialLogs: string[] = [],
    ) => {
      closeSource(kbName);
      setTasksByKb((prev) => ({
        ...prev,
        [kbName]: {
          taskId,
          kind,
          label,
          logs: initialLogs,
          executing: true,
          error: null,
          cancelled: false,
        },
      }));

      const source = new EventSource(
        apiUrl(`/api/v1/knowledge/tasks/${encodeURIComponent(taskId)}/stream`),
        { withCredentials: true },
      );
      sourcesRef.current[kbName] = source;

      let settled = false;

      source.addEventListener("process_log", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as {
            message?: string;
          };
          if (!payload.message) return;
          setTasksByKb((prev) => {
            const current = prev[kbName];
            if (!current || current.taskId !== taskId) return prev;
            return {
              ...prev,
              [kbName]: {
                ...current,
                logs: [...current.logs, payload.message!],
              },
            };
          });
        } catch {
          // ignore malformed process log
        }
      });

      source.addEventListener("progress", (event) => {
        try {
          const payload = JSON.parse(
            (event as MessageEvent).data,
          ) as ProgressInfo;
          setProgress(kbName, payload);
        } catch {
          // ignore malformed progress
        }
      });

      source.addEventListener("complete", () => {
        settled = true;
        setTasksByKb((prev) => {
          const current = prev[kbName];
          if (!current || current.taskId !== taskId) return prev;
          return {
            ...prev,
            [kbName]: { ...current, executing: false, cancelled: false },
          };
        });
        closeSource(kbName);
        onCompleteRef.current?.(kbName);
      });

      source.addEventListener("failed", (event) => {
        settled = true;
        let composed = "Task failed";
        try {
          const payload = JSON.parse(
            (event as MessageEvent).data,
          ) as KnowledgeTaskFailure;
          composed = formatKnowledgeTaskFailure(payload);
        } catch {
          // ignore malformed failure event
        }
        setTasksByKb((prev) => {
          const current = prev[kbName];
          if (!current || current.taskId !== taskId) return prev;
          return {
            ...prev,
            [kbName]: {
              ...current,
              executing: false,
              error: composed,
              cancelled: false,
            },
          };
        });
        closeSource(kbName);
        onCompleteRef.current?.(kbName);
      });

      source.addEventListener("cancelled", (event) => {
        settled = true;
        let detail = "Task cancelled";
        try {
          const payload = JSON.parse((event as MessageEvent).data) as {
            detail?: string;
          };
          detail = payload.detail || detail;
        } catch {
          // ignore malformed cancellation event
        }
        setTasksByKb((prev) => {
          const current = prev[kbName];
          if (!current || current.taskId !== taskId) return prev;
          return {
            ...prev,
            [kbName]: {
              ...current,
              logs: [...current.logs, detail],
              executing: false,
              error: null,
              cancelled: true,
            },
          };
        });
        closeSource(kbName);
        onCompleteRef.current?.(kbName);
      });

      source.onerror = () => {
        if (settled) return;
        setTasksByKb((prev) => {
          const current = prev[kbName];
          if (!current || current.taskId !== taskId) return prev;
          if (!current.executing) return prev;
          return {
            ...prev,
            [kbName]: {
              ...current,
              executing: false,
              error: current.error || "Process log stream disconnected.",
            },
          };
        });
        closeSource(kbName);
      };
    },
    [closeSource, setProgress],
  );

  const startTask = useCallback(
    (params: {
      kbName: string;
      taskId: string;
      kind: TaskKind;
      label: string;
      seed?: ProgressInfo;
      initialLogs?: string[];
    }) => {
      const { kbName, taskId, kind, label, seed, initialLogs } = params;
      if (seed) setProgress(kbName, { ...seed, task_id: taskId });
      openTaskStream(kbName, taskId, kind, label, initialLogs);
      subscribeWs(kbName, taskId);
    },
    [openTaskStream, setProgress, subscribeWs],
  );

  const dismissTask = useCallback(
    (kbName: string) => {
      closeSource(kbName);
      setTasksByKb((prev) => {
        if (!(kbName in prev)) return prev;
        const next = { ...prev };
        delete next[kbName];
        return next;
      });
    },
    [closeSource],
  );

  const cleanupKb = useCallback(
    (kbName: string) => {
      closeSocket(kbName);
      closeSource(kbName);
      clearProgress(kbName);
      setTasksByKb((prev) => {
        if (!(kbName in prev)) return prev;
        const next = { ...prev };
        delete next[kbName];
        return next;
      });
    },
    [clearProgress, closeSocket, closeSource],
  );

  useEffect(() => {
    return () => {
      closeAll();
    };
  }, [closeAll]);

  return {
    progressByKb,
    tasksByKb,
    setProgress,
    clearProgress,
    subscribeWs,
    startTask,
    dismissTask,
    cleanupKb,
  };
}
