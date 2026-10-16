/**
 * Server-safe language helpers — no i18next/react imports, so Server
 * Components (e.g. the root layout) can use them freely.
 */

export type AppLanguage = "en" | "zh";

export function normalizeLanguage(lang: unknown): AppLanguage {
  if (!lang) return "en";
  const s = String(lang).toLowerCase();
  if (s === "zh" || s === "cn" || s === "chinese") return "zh";
  return "en";
}
