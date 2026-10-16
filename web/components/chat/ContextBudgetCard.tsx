"use client";

import { ChevronDown, Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  contextBudgetUsagePercent,
  type ContextBudget,
} from "@/lib/context-budget";

const SEGMENT_LABELS: Record<string, string> = {
  messages: "Conversation",
  system_prompt: "System instructions",
  system_tools: "Built-in tools",
  mcp_tools: "Connected tools",
  capability: "Capability instructions",
  persona: "Persona",
  skills: "Skills",
  memory: "Memory",
  sources: "Sources",
};

function tokens(value: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
}
export default function ContextBudgetCard({ budget }: { budget: ContextBudget }) {
  const { t } = useTranslation();
  const usage = contextBudgetUsagePercent(budget);
  const tone = usage >= 90 ? "bg-destructive" : usage >= 75 ? "bg-warning" : "bg-primary";
  return (
    <details
      className="group mt-2 rounded-lg border border-border bg-muted-subtle px-3 py-2 text-xs"
      data-testid="context-budget"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground">
        <Gauge size={13} className={usage >= 90 ? "text-destructive" : "text-primary"} />
        <span className="font-medium text-foreground">{t("Context budget")}</span>
        <span className="ml-auto tabular-nums">
          {t("{{used}} of {{window}} tokens", {
            used: tokens(budget.usedTokens),
            window: tokens(budget.window),
          })}
        </span>
        <ChevronDown size={13} className="transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 space-y-3">
        <div>
          <div className="mb-1 flex justify-between text-muted-foreground">
            <span>{t("{{percent}}% used", { percent: usage })}</span>
            <span>{t("{{count}} tokens free", { count: tokens(budget.freeTokens) })}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t("Context usage")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={usage}>
            <div className={`h-full rounded-full ${tone}`} style={{ width: `${usage}%` }} />
          </div>
        </div>
        {budget.segments.length > 0 ? (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
            {budget.segments.map((segment) => (
              <div className="contents" key={segment.key}>
                <dt className="truncate text-muted-foreground">
                  {t(SEGMENT_LABELS[segment.key] ?? segment.key)}
                </dt>
                <dd className="tabular-nums text-foreground">{tokens(segment.tokens)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <p className="text-muted-foreground">
          {budget.windowEstimated
            ? t("The model window is estimated; actual provider accounting may differ.")
            : t("Measured from the final model request for this turn.")}
        </p>
      </div>
    </details>
  );
}
