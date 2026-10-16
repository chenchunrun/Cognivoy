"use client";

import { useCallback } from "react";
import i18n from "i18next";
import { useAppShell } from "@/context/AppShellContext";
import type { AppLanguage } from "@/context/app-shell-storage";
import { ensureLanguage } from "@/i18n/init";

/**
 * Shared language switch used by the sidebar toggle and Settings →
 * Appearance. Persists the choice in three places: localStorage (via
 * AppShellContext), the ``cognivoy-lang`` cookie (so the server layout
 * picks the right ``lang`` + initial bundle on the next request), and the
 * live i18next instance.
 */
export function useLanguageSwitch() {
  const { language, setLanguage } = useAppShell();

  const switchLanguage = useCallback(
    (next: AppLanguage) => {
      if (next === language) return;
      setLanguage(next);
      document.cookie = `cognivoy-lang=${next};path=/;max-age=31536000`;
      void ensureLanguage(next).then(() => {
        if (i18n.language !== next) void i18n.changeLanguage(next);
        document.documentElement.lang = next;
      });
    },
    [language, setLanguage],
  );

  return { language, switchLanguage };
}
