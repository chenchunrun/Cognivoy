"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { LearningResult } from "@/lib/learning-result";

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function LearningResultCard({ result }: { result: LearningResult }) {
  const { t } = useTranslation();
  const masteryChanged =
    result.masteryBefore != null && result.masteryAfter != null;

  return (
    <section
      className="surface mt-3 overflow-hidden border-success-border bg-success-muted"
      data-testid="learning-result-card"
      aria-label={t("Learning result")}
    >
      <div className="flex items-start gap-3 p-4">
        <CheckCircle2 size={22} className="mt-0.5 shrink-0 text-success" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-success">
            {t("Learning task verified")}
          </p>
          <h3 className="mt-1 font-medium text-foreground">{result.objective}</h3>
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <span className="block text-xs text-muted-foreground">{t("Mastery")}</span>
              <span className="font-medium text-foreground">
                {masteryChanged
                  ? `${percent(result.masteryBefore!)} → ${percent(result.masteryAfter!)}`
                  : t("Verified by exit and transfer checks")}
              </span>
            </div>
            <div>
              <span className="block text-xs text-muted-foreground">{t("Evidence")}</span>
              <span className="inline-flex items-center gap-1 font-medium text-foreground">
                <ShieldCheck size={14} className="text-success" />
                {t("High confidence · {{count}} records", {
                  count: result.evidenceRefs.length,
                })}
              </span>
            </div>
            <div>
              <span className="block text-xs text-muted-foreground">{t("Review queue")}</span>
              <span className="font-medium text-foreground">
                {t("{{count}} due now", { count: result.reviewDueCount })}
              </span>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-success-border px-4 py-3">
        <Link
          href={`/space/learning/${encodeURIComponent(result.projectId)}`}
          className="text-sm font-medium text-primary hover:underline"
        >
          {t("View learning results")}
        </Link>
        {result.nextTask ? (
          <Link
            href={`/home?learning_task=${encodeURIComponent(result.nextTask.id)}&project=${encodeURIComponent(result.projectId)}&objective=${encodeURIComponent(result.nextTask.objective)}`}
            className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            {t("Start next task")}
            <ArrowRight size={14} />
          </Link>
        ) : null}
      </div>
    </section>
  );
}
