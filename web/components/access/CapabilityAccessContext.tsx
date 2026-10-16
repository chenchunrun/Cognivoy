"use client";

import * as React from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import type { Capability } from "@/lib/capability-routes";
import { listLLMOptions } from "@/lib/llm-options";

interface CapabilityAccessValue {
  loading: boolean;
  isAdmin: boolean;
  hasLlm: boolean;
  verificationError: string | null;
  has: (capability: Capability) => boolean;
  refresh: () => Promise<void>;
}

const CapabilityAccessContext = React.createContext<CapabilityAccessValue>({
  loading: false,
  isAdmin: true,
  hasLlm: true,
  verificationError: null,
  has: () => true,
  refresh: async () => undefined,
});

export function useCapabilityAccess(): CapabilityAccessValue {
  return React.useContext(CapabilityAccessContext);
}

export function CapabilityAccessProvider({ children }: { children: React.ReactNode }) {
  const requestSequence = React.useRef(0);
  const [state, setState] = React.useState({
    loading: true,
    isAdmin: false,
    hasLlm: false,
    verificationError: null as string | null,
  });
  const refresh = React.useCallback(async () => {
    const requestId = ++requestSequence.current;
    const commit = (next: typeof state) => {
      if (requestSequence.current === requestId) setState(next);
    };
    setState((current) => ({ ...current, loading: true, verificationError: null }));
    try {
      const settings = await apiFetch(apiUrl("/api/v1/settings"));
      if (!settings.ok) throw new Error(`settings_${settings.status}`);
      const payload = (await settings.json()) as { catalog?: unknown };
      if (payload.catalog) {
        commit({ loading: false, isAdmin: true, hasLlm: true, verificationError: null });
        return;
      }
      const { options } = await listLLMOptions({ force: true });
      commit({
        loading: false,
        isAdmin: false,
        hasLlm: options.length > 0,
        verificationError: null,
      });
    } catch (reason) {
      commit({
        loading: false,
        isAdmin: false,
        hasLlm: false,
        verificationError: reason instanceof Error ? reason.message : "access_check_failed",
      });
    }
  }, []);
  React.useEffect(() => {
    queueMicrotask(() => void refresh());
  }, [refresh]);
  React.useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);
  const has = React.useCallback(
    () => !state.verificationError && (state.loading || state.isAdmin || state.hasLlm),
    [state.hasLlm, state.isAdmin, state.loading, state.verificationError],
  );
  return <CapabilityAccessContext.Provider value={{ ...state, has, refresh }}>{children}</CapabilityAccessContext.Provider>;
}
