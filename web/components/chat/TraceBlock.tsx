"use client";

/**
 * Learner-safe progress rendered above an assistant answer. Raw model
 * reasoning, prompt/protocol text, tool arguments, and raw tool results never
 * enter this view; only curated stage updates, tool names, and sources do.
 */

import * as React from "react";
import {
  Check,
  ChevronDown,
  ExternalLink,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { StreamEvent } from "@/lib/unified-ws";
import { isSafeLinkHref } from "@/lib/markdown-display";
import {
  buildLearnerTraceItems,
  type LearnerTraceItem,
} from "@/lib/learner-trace";
import { cn } from "@/lib/utils";
import { recordSloEvent } from "@/lib/slo-api";
import { extractExplorationBudget } from "@/lib/exploration-budget";

function ToolRow({ item }: { item: Extract<LearnerTraceItem, { kind: "tool" }> }) {
  return (
    <div className="rounded-md border border-border bg-muted-subtle px-2.5 py-1.5">
      <div className="flex w-full items-center gap-2 text-left">
        {item.pending ? (
          <Loader2 size={13} className="shrink-0 animate-spin text-primary" />
        ) : item.failed ? (
          <X size={13} className="shrink-0 text-destructive" />
        ) : (
          <Check size={13} className="shrink-0 text-success" />
        )}
        <span className="font-mono text-xs text-foreground">{item.name}</span>
      </div>
    </div>
  );
}

export function TraceBlock({
  events,
  live = false,
}: {
  events: StreamEvent[] | undefined;
  live?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(live);
  const wasLiveRef = React.useRef(live);
  React.useEffect(() => {
    // A turn that just went live opens its trace once; the user can still
    // collapse it, and we don't re-open on subsequent renders.
    if (live && !wasLiveRef.current) setOpen(true);
    wasLiveRef.current = live;
  }, [live]);

  const items = React.useMemo(
    () => buildLearnerTraceItems(events ?? [], live),
    [events, live],
  );
  const budget = React.useMemo(() => extractExplorationBudget(events), [events]);
  if (!items.length && !budget) return null;

  return (
    <div className="mb-2 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-muted-foreground transition-colors duration-150 hover:text-foreground"
        aria-expanded={open}
      >
        <ChevronDown
          size={14}
          className={cn(
            "transition-transform duration-150",
            !open && "-rotate-90",
          )}
        />
        <span className="text-[13px]">{t("Learning progress")}</span>
        {budget ? (
          <span className="text-xs tabular-nums" data-testid="exploration-budget">
            {t("Exploration {{used}} / {{limit}} rounds", { used: budget.used, limit: budget.limit })}
          </span>
        ) : null}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-1.5 border-l border-border pl-3">
          {budget ? (
            <p className="text-xs text-muted-foreground" data-testid="exploration-budget-detail">
              {t("Initial {{initial}}; maximum {{maximum}} exploration rounds. Separate from context tokens.", { initial: budget.initial, maximum: budget.maximum })}
              {budget.settlementRounds > 0 ? ` ${t("Finalizing: {{count}} rounds", { count: budget.settlementRounds })}` : null}
            </p>
          ) : null}
          {items.map((item) => {
            switch (item.kind) {
              case "tool":
                return <ToolRow key={item.key} item={item} />;
              case "sources":
                return (
                  <ol
                    key={item.key}
                    className="flex flex-col gap-1"
                    aria-label={t("Sources")}
                  >
                    {item.sources.map((source, index) => {
                      // Only http(s)/relative source URLs become links;
                      // anything else degrades to a plain-text chip.
                      const href = isSafeLinkHref(source.url)
                        ? source.url
                        : null;
                      const chipClass =
                        "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-muted-foreground transition-colors duration-150";
                      const chipBody = (
                        <>
                          <span className="shrink-0 font-mono text-[10px] text-primary">
                            {index + 1}
                          </span>
                          <span className="truncate">{source.title}</span>
                          {href && <ExternalLink size={11} className="shrink-0" />}
                        </>
                      );
                      return (
                        <li key={`${item.key}-${index}`}>
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer"
                              onClick={() => void recordSloEvent("reference_clicked")}
                              className={cn(
                                chipClass,
                                "hover:border-primary hover:text-foreground",
                              )}
                            >
                              {chipBody}
                            </a>
                          ) : (
                            <span className={chipClass}>{chipBody}</span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                );
              case "progress":
                return (
                  <p key={item.key} className="text-xs text-muted-foreground">
                    {item.text}
                  </p>
                );
              case "warning":
                return (
                  <p
                    key={item.key}
                    className="flex items-start gap-1.5 rounded-md border border-warning-border bg-warning-muted px-2.5 py-2 text-xs text-foreground"
                  >
                    <TriangleAlert size={13} className="mt-0.5 shrink-0 text-warning" />
                    <span>{item.text}</span>
                  </p>
                );
              case "error":
                return (
                  <p key={item.key} className="text-[13px] text-destructive">
                    {item.text}
                  </p>
                );
              default:
                return null;
            }
          })}
        </div>
      )}
    </div>
  );
}

export default TraceBlock;
