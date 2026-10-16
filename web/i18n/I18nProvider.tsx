"use client";

import { useEffect } from "react";
import i18n, { type i18n as I18nInstance } from "i18next";
import { I18nextProvider } from "react-i18next";

import {
  createRequestI18n,
  ensureLanguage,
  initI18n,
  normalizeLanguage,
  type AppLanguage,
} from "./init";

// Initialize i18next at module load (before any React render) so that the
// `init()` call — which fires `initialized` / `languageChanged` events that
// trigger setState on subscribed components — never happens during another
// component's render phase. Calling `initI18n` from the render body would
// produce the React warning:
//   "Cannot update a component (`X`) while rendering a different component
//   (`I18nProvider`)."
//
// On the client the module loads exactly once, and document.cookie holds the
// same ``cognivoy-lang`` cookie the server read for this page — seeding the
// singleton with it makes the first client render match the SSR HTML instead
// of flashing English until the mount effect runs. On the server the
// singleton stays unused: every request renders through its own instance
// (see below), so concurrent requests never share language state.
function readCookieLanguage(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.match(/(?:^|;\s*)cognivoy-lang=([^;]*)/);
  return match?.[1];
}
initI18n(readCookieLanguage());

export function I18nProvider({
  language,
  initialResources,
  children,
}: {
  language: AppLanguage | string;
  /** Resource bundle for the request language, forwarded by the server
   *  layout for non-default languages so both the SSR pass and the first
   *  client render have the translated strings synchronously. */
  initialResources?: Record<string, unknown> | null;
  children: React.ReactNode;
}) {
  const nextLang = normalizeLanguage(language);

  let instance: I18nInstance;
  if (typeof window === "undefined") {
    // Server render: the module singleton is shared across requests — never
    // set a request's language on it. Each request gets an isolated instance
    // pre-loaded with its own language bundle.
    instance = createRequestI18n(nextLang, initialResources ?? undefined);
  } else {
    // Client: make the SSR-provided bundle available before children render
    // (module-load init already selected the cookie language). No-ops once
    // the bundle is present.
    if (
      initialResources &&
      nextLang !== "en" &&
      !i18n.hasResourceBundle(nextLang, "app")
    ) {
      i18n.addResourceBundle(nextLang, "app", initialResources, true, true);
    }
    instance = i18n;
  }

  useEffect(() => {
    let cancelled = false;
    void ensureLanguage(nextLang).then(() => {
      if (cancelled) return;
      if (i18n.language !== nextLang) {
        i18n.changeLanguage(nextLang);
      }
      // Keep <html lang="..."> in sync for accessibility & Intl defaults.
      document.documentElement.lang = nextLang;
    });
    return () => {
      cancelled = true;
    };
  }, [nextLang]);

  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>;
}
