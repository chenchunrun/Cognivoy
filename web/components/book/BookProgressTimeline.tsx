"use client";

/**
 * Presentational timeline for the BookEngine stage stream. The state it
 * renders comes from the `reduceBookEvent` reducer in lib/book-progress.ts;
 * WS events are fed in by the page while a long-running operation
 * (create / confirm proposal / compile / regenerate) is in flight.
 */

import * as React from "react";
import {
  AlertTriangle,
  BookMarked,
  Check,
  LayoutList,
  Lightbulb,
  Network,
  ScanSearch,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Spinner } from "@/components/ui";
import type { BookProgress, StageId, StageState } from "@/lib/book-progress";
import { cn } from "@/lib/utils";

const STAGE_ICONS: Record<StageId, React.ComponentType<{ className?: string }>> = {
  ideation: Lightbulb,
  exploration: Search,
  synthesis: Network,
  critique: ScanSearch,
  overview: BookMarked,
  compilation: LayoutList,
};

function stateRowTone(state: StageState): string {
  switch (state) {
    case "running":
      return "text-foreground";
    case "completed":
      return "text-muted-foreground";
    case "error":
      return "text-destructive";
    default:
      return "text-muted-foreground";
  }
}

function StageGlyph({ id, state }: { id: StageId; state: StageState }) {
  const cls = "h-3.5 w-3.5";
  if (state === "running") return <Spinner size={14} className="text-primary" />;
  if (state === "completed") return <Check className={cn(cls, "text-success")} />;
  if (state === "error")
    return <AlertTriangle className={cn(cls, "text-destructive")} />;
  const Icon = STAGE_ICONS[id];
  return <Icon className={cls} />;
}

export interface BookProgressTimelineProps {
  progress: BookProgress;
  /** Mini mode — single-line floating chip shown while work is in flight. */
  mini?: boolean;
  className?: string;
}

export function BookProgressTimeline({
  progress,
  mini = false,
  className,
}: BookProgressTimelineProps) {
  const { t } = useTranslation();

  if (mini) {
    return (
      <div
        className={cn(
          "pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground shadow-lift",
          className,
        )}
      >
        <Spinner size={12} className="text-primary" />
        <span className="max-w-[280px] truncate">
          {progress.message || t("Working…")}
        </span>
      </div>
    );
  }

  return (
    <div className={cn("surface p-4", className)}>
      <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
        {t("Generation progress")}
      </div>
      <ol className="space-y-2">
        {progress.ordered.map((id) => {
          const stage = progress.stages[id];
          return (
            <li
              key={id}
              className={cn(
                "flex items-start gap-2.5 text-sm",
                stateRowTone(stage.state),
              )}
            >
              <span className="mt-0.5 shrink-0">
                <StageGlyph id={id} state={stage.state} />
              </span>
              <div className="min-w-0">
                <div className="font-medium">{t(stage.label)}</div>
                <div className="text-xs text-muted-foreground">
                  {stage.detail || t(stage.description)}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {progress.message && (
        <div className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
          {progress.message}
        </div>
      )}
    </div>
  );
}

export default BookProgressTimeline;
