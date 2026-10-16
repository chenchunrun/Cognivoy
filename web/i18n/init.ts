import i18n, {
  type InitOptions,
  type Resource,
  type i18n as I18nInstance,
} from "i18next";
import { initReactI18next } from "react-i18next";

import enApp from "@/locales/en/app.json";
import { normalizeLanguage, type AppLanguage } from "./language";

export { normalizeLanguage } from "./language";
export type { AppLanguage } from "./language";

let _initialized = false;

const baseOptions: InitOptions = {
  fallbackLng: "en",
  // Use a single default namespace to keep lookups simple.
  // We intentionally keep keySeparator disabled so keys like "Generating..." remain valid.
  defaultNS: "app",
  ns: ["app"],
  keySeparator: false,
  interpolation: {
    escapeValue: false,
  },
  returnEmptyString: false,
  returnNull: false,
};

export function initI18n(language?: unknown) {
  if (_initialized) return i18n;

  const resources: Resource = {
    en: { app: enApp },
  };

  i18n.use(initReactI18next).init({
    ...baseOptions,
    resources,
    lng: normalizeLanguage(language),
  });

  _initialized = true;
  return i18n;
}

/**
 * Create an isolated i18next instance for a single server render. The
 * module-level singleton above is shared across requests, so setting one
 * request's language on it would leak that language into concurrent
 * requests — each SSR pass gets its own instance instead, pre-loaded with
 * the request's language bundle so the first render is already translated.
 *
 * Deliberately does NOT ``use(initReactI18next)``: that plugin binds a
 * module-level "current instance" which would race between requests, and
 * consumers receive this instance through ``I18nextProvider`` context
 * anyway, so the plugin's binding is never consulted on the server.
 */
export function createRequestI18n(
  language: AppLanguage,
  languageBundle?: Record<string, unknown>,
): I18nInstance {
  const instance = i18n.createInstance();
  instance.init({
    ...baseOptions,
    resources: {
      en: { app: enApp },
      ...(languageBundle ? { [language]: { app: languageBundle } } : {}),
    },
    lng: language,
  });
  return instance;
}

export async function ensureLanguage(language: AppLanguage) {
  if (i18n.hasResourceBundle(language, "app")) return;
  if (language === "zh") {
    const zhApp = (await import("@/locales/zh/app.json")).default;
    i18n.addResourceBundle("zh", "app", zhApp, true, true);
  }
}
