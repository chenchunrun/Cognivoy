"use client";

import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, Moon, Sun } from "lucide-react";

import { useAppShell } from "@/context/AppShellContext";
import {
  readStoredResponseLanguage,
  writeStoredResponseLanguage,
  type AppLanguage,
} from "@/context/app-shell-storage";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { useLanguageSwitch } from "@/components/shell/use-language-switch";
import { Toggle } from "@/components/ui";
import { apiFetch, apiUrl } from "@/lib/api";

function ThemePreview({ theme }: { theme: Theme }) {
  const dark = theme === "dark";
  // DESIGN-SYSTEM EXEMPTION: the raw hexes below are intentional — this card
  // previews *each* theme (including the inactive one), so it must render the
  // target theme's literal palette rather than the current theme's CSS vars.
  return (
    <div
      aria-hidden="true"
      className="h-20 w-full overflow-hidden rounded-lg border border-border"
      style={{ backgroundColor: dark ? "#191713" : "#faf9f5" }}
    >
      <div className="flex h-full">
        <div
          className="w-1/4 border-r"
          style={{
            backgroundColor: dark ? "#1e1b16" : "#f4f1e9",
            borderColor: dark ? "#37322a" : "#e8e2d6",
          }}
        />
        <div className="flex flex-1 flex-col gap-1.5 p-2.5">
          <div
            className="h-1.5 w-2/3 rounded-full"
            style={{ backgroundColor: dark ? "#453e33" : "#ded6c6" }}
          />
          <div
            className="h-1.5 w-1/2 rounded-full"
            style={{ backgroundColor: dark ? "#453e33" : "#ded6c6" }}
          />
          <div
            className="mt-auto h-4 w-12 rounded-md"
            style={{ backgroundColor: dark ? "#da7a50" : "#c15a2e" }}
          />
        </div>
      </div>
    </div>
  );
}

export default function AppearanceSettingsPage() {
  const { t } = useTranslation();
  const {
    theme,
    setTheme,
    codeBlockShowLineNumbers,
    setCodeBlockShowLineNumbers,
    codeBlockWrapLongLines,
    setCodeBlockWrapLongLines,
  } = useAppShell();
  const { language, switchLanguage } = useLanguageSwitch();
  const [responseLanguage, setResponseLanguage] = React.useState<AppLanguage>(() => readStoredResponseLanguage());

  const themes: Array<{ value: Theme; nameKey: string; modeKey: string }> = [
    { value: "light", nameKey: "Paper", modeKey: "Light" },
    { value: "dark", nameKey: "Ink", modeKey: "Dark" },
  ];
  const languages: Array<{ value: AppLanguage; label: string }> = [
    { value: "en", label: t("English") },
    { value: "zh", label: t("Chinese") },
  ];

  const updateResponseLanguage = (next: AppLanguage) => {
    setResponseLanguage(next);
    writeStoredResponseLanguage(next);
    void apiFetch(apiUrl("/api/v1/settings/ui"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_language: next }),
    });
  };

  return (
    <div className="max-w-xl">
      <h2 className="display text-xl font-medium text-foreground">
        {t("Appearance")}
      </h2>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {t(
          "Tune the visual theme and interface language. Changes apply immediately and are stored in your account.",
        )}
      </p>

      <section className="mt-8">
        <h3 className="text-sm font-medium text-foreground">{t("Theme")}</h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {themes.map((item) => {
            const selected = theme === item.value;
            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(item.value)}
                className={cn(
                  "rounded-xl border bg-card p-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-primary"
                    : "border-border hover:border-input",
                )}
              >
                <ThemePreview theme={item.value} />
                <div className="mt-3 flex items-center justify-between">
                  <div>
                    <div className="display text-sm font-medium text-foreground">
                      {t(item.nameKey)}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                      {item.value === "dark" ? (
                        <Moon size={11} />
                      ) : (
                        <Sun size={11} />
                      )}
                      {t(item.modeKey)}
                    </div>
                  </div>
                  {selected && (
                    <span className="rounded-full bg-primary-muted p-1 text-accent-foreground">
                      <Check size={12} />
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <h3 className="text-sm font-medium text-foreground">
          {t("Interface language")}
        </h3>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {languages.map((item) => {
            const selected = language === item.value;
            return (
              <button
                key={item.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => switchLanguage(item.value)}
                className={cn(
                  "flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  selected
                    ? "border-primary"
                    : "border-border hover:border-input",
                )}
              >
                <span className="text-sm text-foreground">{item.label}</span>
                {selected && (
                  <span className="rounded-full bg-primary-muted p-1 text-accent-foreground">
                    <Check size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-8">
        <h3 className="text-sm font-medium text-foreground">{t("Model output language")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Sets the default language for chat and capability responses.")}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          {languages.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={responseLanguage === item.value}
              onClick={() => updateResponseLanguage(item.value)}
              className={cn(
                "flex items-center justify-between rounded-xl border bg-card px-4 py-3 text-left text-sm transition-colors",
                responseLanguage === item.value ? "border-primary" : "border-border hover:border-input",
              )}
            >
              {item.label}
              {responseLanguage === item.value && <Check size={13} className="text-accent-foreground" />}
            </button>
          ))}
        </div>
      </section>

      <section className="mt-8 border-t border-border pt-8">
        <h3 className="text-sm font-medium text-foreground">{t("Code blocks")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Choose how code snippets render across chat, Book and Co-Writer.")}
        </p>
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
            <div>
              <div className="text-sm text-foreground">{t("Show line numbers")}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t("Display a gutter beside every fenced code block.")}</div>
            </div>
            <Toggle
              checked={codeBlockShowLineNumbers}
              onCheckedChange={setCodeBlockShowLineNumbers}
              aria-label={t("Show line numbers")}
            />
          </div>
          <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3">
            <div>
              <div className="text-sm text-foreground">{t("Wrap long lines")}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t("Wrap long code lines instead of scrolling horizontally.")}</div>
            </div>
            <Toggle
              checked={codeBlockWrapLongLines}
              onCheckedChange={setCodeBlockWrapLongLines}
              aria-label={t("Wrap long lines")}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
