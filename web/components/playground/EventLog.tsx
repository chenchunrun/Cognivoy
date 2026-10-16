"use client";

/**
 * Live event log for a playground run. Each StreamEvent / process-log line is
 * a collapsible row: type badge + one-line preview, expanding to the full
 * content and metadata payload. Auto-scrolls while the run is streaming.
 */

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Badge, Spinner, type BadgeVariant } from "@/components/ui";
import { cn } from "@/lib/utils";

import type { LogEntry } from "./types";

const TYPE_VARIANTS: Record<string, BadgeVariant> = {
  thinking: "default",
  observation: "default",
  progress: "warning",
  tool_call: "primary",
  tool_result: "outline",
  sources: "outline",
  stage_start: "outline",
  stage_end: "outline",
  process_log: "outline",
  result: "success",
  error: "destructive",
  cancelled: "warning",
};

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function preview(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function EventRow({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = React.useState(false);
  const hasMetadata =
    entry.metadata && Object.keys(entry.metadata).length > 0;

  return (
    <div className="rounded-lg border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Badge variant={TYPE_VARIANTS[entry.type] ?? "default"}>
          {entry.type}
        </Badge>
        {entry.stage && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {titleCase(entry.stage)}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {preview(entry.content) || "—"}
        </span>
        <ChevronDown
          size={13}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-2.5 py-2">
          {entry.content && (
            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">
              {entry.content}
            </p>
          )}
          {hasMetadata && (
            <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
              {JSON.stringify(entry.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

export function EventLog({
  entries,
  running,
}: {
  entries: LogEntry[];
  running: boolean;
}) {
  const { t } = useTranslation();
  const scrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!running) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, running]);

  return (
    <section className="surface">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {t("Event log")}
        </h3>
        {entries.length > 0 && (
          <Badge variant="default">{entries.length}</Badge>
        )}
        {running && <Spinner className="ml-auto" />}
      </div>
      {entries.length > 0 ? (
        <div
          ref={scrollRef}
          className="max-h-[380px] space-y-1.5 overflow-y-auto p-2.5"
        >
          {entries.map((entry) => (
            <EventRow key={entry.id} entry={entry} />
          ))}
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">
          {running
            ? t("Waiting for events...")
            : t("Events will appear here while the run executes.")}
        </p>
      )}
    </section>
  );
}
