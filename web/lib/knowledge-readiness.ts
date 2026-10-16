import type { EnginePreflight } from "@/lib/knowledge-api";
import type { KnowledgeBase } from "@/lib/knowledge-helpers";

export interface KnowledgeErrorGuidance {
  code: "embedding" | "llm" | "credentials" | "dependency" | "unknown";
  settingsPath: string | null;
}

export function failedRequiredPreflightChecks(preflight: EnginePreflight | null) {
  return preflight?.checks.filter((check) => !check.ok && !check.optional) ?? [];
}

export function enginePreflightReady(
  preflight: EnginePreflight | null,
  loading: boolean,
  loadError: string | null,
): boolean {
  return !loading && !loadError && preflight?.ok === true;
}

export function persistedKnowledgeError(kb: KnowledgeBase): string | null {
  const values = [kb.progress?.error, kb.metadata?.last_error];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function knowledgeErrorGuidance(error: string | null): KnowledgeErrorGuidance {
  const normalized = (error || "").toLowerCase();
  if (normalized.includes("embedding")) {
    return { code: "embedding", settingsPath: "/settings/embedding" };
  }
  if (
    normalized.includes("chat model") ||
    normalized.includes("llm model") ||
    normalized.includes("active llm")
  ) {
    return { code: "llm", settingsPath: "/settings/llm" };
  }
  if (normalized.includes("api key") || normalized.includes("credential")) {
    return { code: "credentials", settingsPath: null };
  }
  if (normalized.includes("not installed") || normalized.includes("pip install")) {
    return { code: "dependency", settingsPath: null };
  }
  return { code: "unknown", settingsPath: null };
}
