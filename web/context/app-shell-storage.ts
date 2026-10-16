"use client";

export type AppLanguage = "en" | "zh";
export type DefaultCapability =
  | "auto"
  | "chat"
  | "deep_solve"
  | "deep_question"
  | "deep_research"
  | "visualize"
  | "math_animator"
  | "mastery_path";

export const ACTIVE_SESSION_STORAGE_KEY = "cognivoy.activeSessionId.tab";
export const LANGUAGE_STORAGE_KEY = "cognivoy-language";
export const RESPONSE_LANGUAGE_STORAGE_KEY = "cognivoy-response-language";
export const SIDEBAR_COLLAPSED_STORAGE_KEY = "cognivoy.sidebarCollapsed";
export const CHAT_RESPONSE_TIMEOUT_STORAGE_KEY =
  "cognivoy.chatResponseTimeout";
export const DEFAULT_CAPABILITY_STORAGE_KEY = "cognivoy.defaultCapability";
export const CODE_BLOCK_THEME_STORAGE_KEY = "cognivoy.code-block-theme";
export const CODE_BLOCK_SHOW_LINE_NUMBERS_STORAGE_KEY =
  "cognivoy.code-block-show-line-numbers";
export const CODE_BLOCK_WRAP_LONG_LINES_STORAGE_KEY =
  "cognivoy.code-block-wrap-long-lines";

// Mirror of the per-user ``chat_response_timeout`` UI preference. Cached in
// localStorage so the chat watchdog (a separate provider from Settings) can
// read it synchronously without its own fetch. Kept in sync on settings load.
export const DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS = 180;
export const MIN_CHAT_RESPONSE_TIMEOUT_SECONDS = 30;
export const MAX_CHAT_RESPONSE_TIMEOUT_SECONDS = 1800;

const CAPABILITY_IDLE_TIMEOUT_MINIMUMS: Readonly<Record<string, number>> = {
  visualize: 300,
  deep_research: 600,
  math_animator: 600,
};

export function clampChatResponseTimeout(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS;
  return Math.min(
    MAX_CHAT_RESPONSE_TIMEOUT_SECONDS,
    Math.max(MIN_CHAT_RESPONSE_TIMEOUT_SECONDS, Math.round(seconds)),
  );
}

export function readStoredChatResponseTimeout(): number {
  if (typeof window === "undefined")
    return DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS;
  try {
    const raw = window.localStorage.getItem(CHAT_RESPONSE_TIMEOUT_STORAGE_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? clampChatResponseTimeout(parsed)
      : DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS;
  } catch {
    return DEFAULT_CHAT_RESPONSE_TIMEOUT_SECONDS;
  }
}

/** Resolve the no-event watchdog for the active capability.
 *
 * Deep research and Manim regularly spend several minutes inside one remote
 * search/render operation.  A user's general chat preference remains the
 * baseline, but must not make those explicitly selected long-running modes
 * fail before their server-side capability budget expires.
 */
export function resolveChatIdleTimeoutSeconds(
  configuredSeconds: number,
  capability: string | null | undefined,
): number {
  const configured = clampChatResponseTimeout(configuredSeconds);
  const minimum = CAPABILITY_IDLE_TIMEOUT_MINIMUMS[capability || ""] || 0;
  return Math.max(configured, minimum);
}

export function clientIdleTimeoutMetadata(seconds: number): Record<string, unknown> {
  return {
    turn_terminal: true,
    status: "failed",
    reason: "client_idle_timeout",
    retryable: true,
    timeout_seconds: seconds,
  };
}

export function writeStoredChatResponseTimeout(seconds: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CHAT_RESPONSE_TIMEOUT_STORAGE_KEY,
      String(clampChatResponseTimeout(seconds)),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export const ACTIVE_SESSION_EVENT = "cognivoy:active-session";
export const LANGUAGE_EVENT = "cognivoy:language";
export const RESPONSE_LANGUAGE_EVENT = "cognivoy:response-language";
export const DEFAULT_CAPABILITY_EVENT = "cognivoy:default-capability";
export const SIDEBAR_COLLAPSED_EVENT = "cognivoy:sidebar-collapsed";
export const CODE_BLOCK_SETTINGS_EVENT = "cognivoy:code-block-settings";

export function normalizeLanguage(
  value: string | null | undefined,
): AppLanguage {
  return value === "zh" ? "zh" : "en";
}

const DEFAULT_CAPABILITIES = new Set<DefaultCapability>([
  "auto",
  "chat",
  "deep_solve",
  "deep_question",
  "deep_research",
  "visualize",
  "math_animator",
  "mastery_path",
]);

export function normalizeDefaultCapability(
  value: string | null | undefined,
): DefaultCapability {
  return DEFAULT_CAPABILITIES.has(value as DefaultCapability)
    ? (value as DefaultCapability)
    : "auto";
}

export function readStoredDefaultCapability(): DefaultCapability {
  if (typeof window === "undefined") return "auto";
  try {
    return normalizeDefaultCapability(
      window.localStorage.getItem(DEFAULT_CAPABILITY_STORAGE_KEY),
    );
  } catch {
    return "auto";
  }
}

export function writeStoredDefaultCapability(capability: DefaultCapability): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      DEFAULT_CAPABILITY_STORAGE_KEY,
      normalizeDefaultCapability(capability),
    );
    window.dispatchEvent(
      new CustomEvent(DEFAULT_CAPABILITY_EVENT, { detail: { capability } }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function resolveResponseLanguage(
  value: string | null | undefined,
  legacyLanguage: string | null | undefined = "en",
): AppLanguage {
  return value === "zh" || value === "en"
    ? value
    : normalizeLanguage(legacyLanguage);
}

export function readStoredLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en";
  try {
    return normalizeLanguage(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "en";
  }
}

/** Whether this browser has ever recorded a choice.
 *
 * ``readStoredLanguage`` cannot answer this: it normalizes a missing value to
 * "en", which is indistinguishable from an explicit English selection. The
 * bootstrap needs the difference — it may only consult the server-side
 * preference when the browser has no choice of its own to honour.
 */
export function hasStoredLanguage(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(LANGUAGE_STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

export function writeStoredLanguage(language: AppLanguage): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    window.dispatchEvent(
      new CustomEvent(LANGUAGE_EVENT, {
        detail: { language },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function readStoredResponseLanguage(): AppLanguage {
  if (typeof window === "undefined") return "en";
  try {
    return resolveResponseLanguage(
      window.localStorage.getItem(RESPONSE_LANGUAGE_STORAGE_KEY),
      window.localStorage.getItem(LANGUAGE_STORAGE_KEY),
    );
  } catch {
    return "en";
  }
}

export function writeStoredResponseLanguage(language: AppLanguage): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(RESPONSE_LANGUAGE_STORAGE_KEY, language);
    window.dispatchEvent(
      new CustomEvent(RESPONSE_LANGUAGE_EVENT, {
        detail: { language },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function readStoredActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredActiveSessionId(sessionId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (sessionId) {
      window.sessionStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
    } else {
      window.sessionStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
    window.dispatchEvent(
      new CustomEvent(ACTIVE_SESSION_EVENT, {
        detail: { sessionId },
      }),
    );
  } catch {
    // sessionStorage may be unavailable
  }
}

export function readStoredSidebarCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeStoredSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
    window.dispatchEvent(
      new CustomEvent(SIDEBAR_COLLAPSED_EVENT, {
        detail: { collapsed },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

// Code block settings defaults
export const DEFAULT_CODE_BLOCK_THEME = "oneDark";
export const DEFAULT_CODE_BLOCK_SHOW_LINE_NUMBERS = false;
export const DEFAULT_CODE_BLOCK_WRAP_LONG_LINES = false;

export function normalizeCodeBlockTheme(
  value: string | null | undefined,
): string {
  if (!value || value.trim() === "") return DEFAULT_CODE_BLOCK_THEME;
  return value.trim();
}

export function readStoredCodeBlockTheme(): string {
  if (typeof window === "undefined") return DEFAULT_CODE_BLOCK_THEME;
  try {
    const raw = window.localStorage.getItem(CODE_BLOCK_THEME_STORAGE_KEY);
    return normalizeCodeBlockTheme(raw);
  } catch {
    return DEFAULT_CODE_BLOCK_THEME;
  }
}

export function writeStoredCodeBlockTheme(theme: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CODE_BLOCK_THEME_STORAGE_KEY,
      normalizeCodeBlockTheme(theme),
    );
    window.dispatchEvent(
      new CustomEvent(CODE_BLOCK_SETTINGS_EVENT, {
        detail: { codeBlockTheme: normalizeCodeBlockTheme(theme) },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function normalizeCodeBlockShowLineNumbers(
  value: string | null | undefined,
): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return DEFAULT_CODE_BLOCK_SHOW_LINE_NUMBERS;
}

export function readStoredCodeBlockShowLineNumbers(): boolean {
  if (typeof window === "undefined")
    return DEFAULT_CODE_BLOCK_SHOW_LINE_NUMBERS;
  try {
    const raw = window.localStorage.getItem(
      CODE_BLOCK_SHOW_LINE_NUMBERS_STORAGE_KEY,
    );
    return normalizeCodeBlockShowLineNumbers(raw);
  } catch {
    return DEFAULT_CODE_BLOCK_SHOW_LINE_NUMBERS;
  }
}

export function writeStoredCodeBlockShowLineNumbers(show: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CODE_BLOCK_SHOW_LINE_NUMBERS_STORAGE_KEY,
      String(show),
    );
    window.dispatchEvent(
      new CustomEvent(CODE_BLOCK_SETTINGS_EVENT, {
        detail: { codeBlockShowLineNumbers: show },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}

export function normalizeCodeBlockWrapLongLines(
  value: string | null | undefined,
): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return DEFAULT_CODE_BLOCK_WRAP_LONG_LINES;
}

export function readStoredCodeBlockWrapLongLines(): boolean {
  if (typeof window === "undefined") return DEFAULT_CODE_BLOCK_WRAP_LONG_LINES;
  try {
    const raw = window.localStorage.getItem(
      CODE_BLOCK_WRAP_LONG_LINES_STORAGE_KEY,
    );
    return normalizeCodeBlockWrapLongLines(raw);
  } catch {
    return DEFAULT_CODE_BLOCK_WRAP_LONG_LINES;
  }
}

export function writeStoredCodeBlockWrapLongLines(wrap: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CODE_BLOCK_WRAP_LONG_LINES_STORAGE_KEY,
      String(wrap),
    );
    window.dispatchEvent(
      new CustomEvent(CODE_BLOCK_SETTINGS_EVENT, {
        detail: { codeBlockWrapLongLines: wrap },
      }),
    );
  } catch {
    // localStorage may be unavailable
  }
}
