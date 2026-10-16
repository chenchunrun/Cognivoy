"use client";

/**
 * Soul source selector: start from the shared library, clone a chat persona,
 * or write a custom soul. The chosen text lands in the textarea below — the
 * text IS the partner's SOUL.md, and editing it detaches a private custom
 * copy of the selected source.
 */

import * as React from "react";
import { useTranslation } from "react-i18next";
import { BookHeart, Sparkles, UserRound } from "lucide-react";
import {
  getSoulSources,
  type SoulSources,
  type SoulSpec,
} from "@/lib/partners-api";
import { Skeleton, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

type SourceTab = "library" | "persona" | "custom";

export function SoulPicker({
  value,
  onChange,
}: {
  value: SoulSpec;
  onChange: (next: SoulSpec) => void;
}) {
  const { t } = useTranslation();
  const [sources, setSources] = React.useState<SoulSources | null>(null);
  const [tab, setTab] = React.useState<SourceTab>(
    value.source === "persona"
      ? "persona"
      : value.source === "custom"
        ? "custom"
        : "library",
  );

  React.useEffect(() => {
    void getSoulSources()
      .then(setSources)
      .catch(() => setSources({ library: [], personas: [] }));
  }, []);

  // Untouched form ("default" source) → preselect the first library soul so
  // the editor is visible and the actual content explicit from the start.
  React.useEffect(() => {
    if (value.source !== "default") return;
    const first = sources?.library[0];
    if (first)
      onChange({ source: "library", id: first.id, content: first.content });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once when sources land
  }, [sources]);

  const tabs: { key: SourceTab; label: string; icon: typeof Sparkles }[] = [
    { key: "library", label: t("Soul library"), icon: BookHeart },
    { key: "persona", label: t("Clone a persona"), icon: UserRound },
    { key: "custom", label: t("Write your own"), icon: Sparkles },
  ];

  const selectLibrary = (id: string) => {
    const entry = sources?.library.find((s) => s.id === id);
    onChange({ source: "library", id, content: entry?.content });
  };

  const selectPersona = (name: string) => {
    const entry = sources?.personas.find((p) => p.name === name);
    onChange({ source: "persona", id: name, content: entry?.content });
  };

  // Typing into the editor detaches a private copy of whatever was selected.
  const editContent = (next: string) =>
    onChange({ source: "custom", content: next });

  const showEditor = tab === "custom" || value.content !== undefined;
  const detached = tab !== "custom" && value.source === "custom";

  return (
    <div className="space-y-4">
      <div className="flex w-fit gap-1 rounded-lg bg-muted p-1">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setTab(key);
              if (key === "custom")
                onChange({ source: "custom", content: value.content ?? "" });
            }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors duration-150",
              tab === key
                ? "bg-card font-medium text-foreground shadow-hairline"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {!sources ? (
        <div className="flex flex-wrap gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-24 rounded-full" />
          ))}
        </div>
      ) : tab === "library" ? (
        <div className="flex flex-wrap gap-2">
          {sources.library.map((soul) => (
            <button
              key={soul.id}
              type="button"
              onClick={() => selectLibrary(soul.id)}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm transition-colors duration-150",
                value.source === "library" && value.id === soul.id
                  ? "border-primary bg-primary-muted font-medium text-accent-foreground"
                  : "border-border text-muted-foreground hover:border-ring hover:text-foreground",
              )}
            >
              {soul.name}
            </button>
          ))}
          {sources.library.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("No soul templates yet.")}
            </p>
          )}
        </div>
      ) : tab === "persona" ? (
        <div className="flex flex-wrap gap-2">
          {sources.personas.map((persona) => (
            <button
              key={persona.name}
              type="button"
              onClick={() => selectPersona(persona.name)}
              title={persona.description}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm transition-colors duration-150",
                value.source === "persona" && value.id === persona.name
                  ? "border-primary bg-primary-muted font-medium text-accent-foreground"
                  : "border-border text-muted-foreground hover:border-ring hover:text-foreground",
              )}
            >
              {persona.name}
            </button>
          ))}
          {sources.personas.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {t("No personas in your chat workspace yet.")}
            </p>
          )}
        </div>
      ) : null}

      {showEditor && (
        <div className="space-y-2">
          <Textarea
            value={value.content ?? ""}
            onChange={(e) => editContent(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={t(
              "# Soul\nDescribe who this partner is, how it speaks, what it values…",
            )}
            className="font-mono text-[13px] leading-relaxed"
          />
          {detached && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                "Edited — your version becomes this partner's soul. The original template is untouched.",
              )}
            </p>
          )}
          {tab === "persona" && value.source === "persona" && value.id && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t(
                "The persona's markdown is copied into the partner — later edits to the persona won't affect it.",
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
