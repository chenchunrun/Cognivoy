"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowRight,
  Bookmark,
  CalendarClock,
  CircleHelp,
  Gauge,
} from "lucide-react";

import { EmptyState, Skeleton, useToast } from "@/components/ui";
import { SpaceHeader } from "@/components/space/SpaceHeader";
import {
  fetchQuestionNotebookStatistics,
  type QuestionNotebookStatistics,
} from "@/lib/notebook-api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SpaceQuestionsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [statistics, setStatistics] =
    React.useState<QuestionNotebookStatistics | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    fetchQuestionNotebookStatistics()
      .then((result) => {
        if (!cancelled) setStatistics(result);
      })
      .catch((error) => {
        if (!cancelled) {
          toast({
            variant: "destructive",
            title: t("Failed to load question statistics"),
            description: errorMessage(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t, toast]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <SpaceHeader
        back
        title={t("Question Review")}
        description={t(
          "See what is due, where errors cluster, and continue deliberate practice.",
        )}
        actions={
          <Link
            href="/question-notebook"
            className="inline-flex h-8 items-center gap-2 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground transition hover:brightness-105"
          >
            <CircleHelp size={14} aria-hidden="true" />
            {t("Open question notebook")}
          </Link>
        }
      />

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-28 w-full" />
          ))}
        </div>
      ) : !statistics || statistics.total === 0 ? (
        <div className="surface">
          <EmptyState
            icon={CircleHelp}
            title={t("No saved questions yet")}
            description={t("Complete a quiz to build your review queue.")}
            action={
              <Link
                href="/home"
                className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:brightness-105"
              >
                {t("Generate a quiz")}
              </Link>
            }
            className="py-20"
          />
        </div>
      ) : (
        <div className="min-w-0 space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <SummaryLink
              href="/question-notebook?filter=due"
              icon={CalendarClock}
              label={t("Due for review")}
              value={statistics.due_review}
              description={t("Incorrect questions ready to practice again")}
            />
            <SummaryLink
              href="/question-notebook"
              icon={Gauge}
              label={t("Overall accuracy")}
              value={`${statistics.accuracy_percent}%`}
              description={t("{{correct}} correct out of {{total}} attempts", {
                correct: statistics.correct,
                total: statistics.total,
              })}
            />
            <SummaryLink
              href="/question-notebook?filter=bookmarked"
              icon={Bookmark}
              label={t("Bookmarked")}
              value={statistics.bookmarked}
              description={t("Questions saved for focused review")}
            />
          </div>

          <div className="grid min-w-0 items-start gap-5 lg:grid-cols-2">
            <section className="surface min-w-0 p-5" aria-labelledby="recent-errors-heading">
              <div className="flex items-center gap-2">
                <AlertCircle size={16} className="text-warning" aria-hidden="true" />
                <h2 id="recent-errors-heading" className="text-sm font-semibold text-foreground">
                  {t("Recent errors")}
                </h2>
              </div>
              {statistics.recent_errors.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">
                  {t("No recent errors. Keep practising to retain mastery.")}
                </p>
              ) : (
                <ul className="mt-3 divide-y divide-border">
                  {statistics.recent_errors.map((entry) => (
                    <li key={entry.id}>
                      <Link
                        href={`/question-notebook?q=${encodeURIComponent(entry.question)}`}
                        className="flex min-w-0 items-center gap-3 py-3 text-sm transition-colors hover:text-primary"
                      >
                        <span className="min-w-0 flex-1 truncate">{entry.question}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {t(entry.difficulty || entry.question_type || "Question")}
                        </span>
                        <ArrowRight size={14} aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="surface min-w-0 p-5" aria-labelledby="difficulty-heading">
              <h2 id="difficulty-heading" className="text-sm font-semibold text-foreground">
                {t("Practice distribution")}
              </h2>
              <div className="mt-4 space-y-3">
                {Object.entries(statistics.difficulties).map(([difficulty, count]) => {
                  const percent = statistics.total
                    ? Math.round((count / statistics.total) * 100)
                    : 0;
                  return (
                    <div key={difficulty}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="capitalize text-foreground">{t(difficulty)}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {count} · {percent}%
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryLink({
  href,
  icon: Icon,
  label,
  value,
  description,
}: {
  href: string;
  icon: React.ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  label: string;
  value: number | string;
  description: string;
}) {
  return (
    <Link href={href} className="surface group p-4 transition hover:border-primary-border hover:shadow-lift">
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary-muted p-2 text-primary">
          <Icon size={17} aria-hidden={true} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{value}</div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <ArrowRight size={15} className="text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
    </Link>
  );
}
