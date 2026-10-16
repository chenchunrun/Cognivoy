"use client";

/**
 * Final-result panel for a playground run: status badge, elapsed time, the
 * answer rendered as markdown (live while streaming), sources, and any extra
 * result payload as collapsible JSON.
 */

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui";
import { Markdown } from "@/components/chat/Markdown";
import { cn } from "@/lib/utils";

import type { RunResult } from "./types";

function Collapsible({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-foreground"
      >
        {title}
        <ChevronDown
          size={13}
          className={cn(
            "text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2.5">{children}</div>
      )}
    </div>
  );
}

export function ResultPanel({
  answer,
  result,
  error,
  running,
}: {
  answer: string;
  result: RunResult | null;
  error: string | null;
  running: boolean;
}) {
  const { t } = useTranslation();

  const content = result?.content || answer;
  const extra = result?.extra && Object.keys(result.extra).length > 0
    ? result.extra
    : null;

  if (!result && !error && !content) return null;

  return (
    <section className="surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("Result")}
        </h3>
        {result && (
          <Badge variant={result.success ? "success" : "destructive"}>
            {result.success ? t("Success") : t("Failed")}
          </Badge>
        )}
        {typeof result?.elapsedMs === "number" && (
          <span className="text-[11px] text-muted-foreground">
            {Math.round(result.elapsedMs)} ms
          </span>
        )}
      </div>

      <div className="space-y-3 p-4">
        {error && (
          <div className="rounded-lg border border-destructive-border bg-destructive-muted px-3 py-2.5 text-sm text-destructive">
            {error}
          </div>
        )}

        {content && (
          <div className="prose-cognivoy text-sm">
            <Markdown content={content} />
          </div>
        )}
        {!content && running && !error && (
          <p className="text-sm text-muted-foreground">
            {t("Streaming response...")}
          </p>
        )}

        {result && result.sources.length > 0 && (
          <Collapsible
            title={t("Sources ({{count}})", {
              count: result.sources.length,
            })}
          >
            <div className="space-y-1.5">
              {result.sources.map((source, i) => (
                <div
                  key={`source-${i}`}
                  className="rounded-md bg-muted px-2.5 py-1.5 text-xs"
                >
                  <div className="font-medium text-foreground">
                    {source.title || source.query || source.type || t("Source")}
                  </div>
                  {source.url && (
                    <div className="mt-0.5 break-all text-[11px] text-muted-foreground">
                      {source.url}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Collapsible>
        )}

        {extra && (
          <Collapsible title={t("Metadata")}>
            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(extra, null, 2)}
            </pre>
          </Collapsible>
        )}
      </div>
    </section>
  );
}
