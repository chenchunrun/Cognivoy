"use client";

import {
  BarChart3,
  Blocks,
  BookOpenText,
  CircleHelp,
  Clock3,
  Code2,
  FileText,
  Link2,
  Sigma,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import type { BookStatistics } from "@/lib/book-statistics";

interface BookOverviewStatsProps {
  statistics: BookStatistics;
}

export function BookOverviewStats({ statistics }: BookOverviewStatsProps) {
  const { t, i18n } = useTranslation();
  const formatter = new Intl.NumberFormat(i18n.resolvedLanguage || i18n.language);
  const maxChapterUnits = Math.max(
    1,
    ...statistics.chapters.map((chapter) => chapter.contentUnits),
  );
  const metrics = [
    {
      icon: BookOpenText,
      label: t("Chapters"),
      value: formatter.format(statistics.chapterCount),
      detail: t("{{count}} content pages", { count: statistics.pageCount }),
    },
    {
      icon: FileText,
      label: t("Content length"),
      value: formatter.format(statistics.contentUnits),
      detail: t("words / characters"),
    },
    {
      icon: Blocks,
      label: t("Content blocks"),
      value: formatter.format(statistics.blockCount),
      detail: t("{{ready}} of {{total}} pages compiled", {
        ready: statistics.readyPageCount,
        total: statistics.pageCount,
      }),
    },
    {
      icon: Clock3,
      label: t("Estimated reading time"),
      value: t("~{{count}} min", {
        count: statistics.estimatedReadingMinutes,
      }),
      detail: t("Based on the generated content"),
    },
  ];

  return (
    <section
      data-testid="book-overview-statistics"
      aria-labelledby="book-statistics-heading"
      className="surface overflow-hidden"
    >
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" aria-hidden="true" />
          <h2
            id="book-statistics-heading"
            className="text-sm font-semibold text-foreground"
          >
            {t("Book at a glance")}
          </h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Statistics update automatically as chapters are generated and read.")}
        </p>
      </div>

      <dl
        data-testid="book-primary-statistics"
        className="grid grid-cols-2 divide-x divide-y divide-border lg:grid-cols-4 lg:divide-y-0"
      >
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.label} className="min-w-0 p-4">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {metric.label}
              </dt>
              <dd className="mt-1.5 text-xl font-semibold tabular-nums text-foreground">
                {metric.value}
              </dd>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {metric.detail}
              </div>
            </div>
          );
        })}
      </dl>

      <dl className="grid grid-cols-2 border-t border-border sm:grid-cols-4">
        {[
          { icon: Code2, label: t("Code lines"), value: statistics.codeLineCount },
          { icon: Sigma, label: t("Formulas"), value: statistics.formulaCount },
          { icon: CircleHelp, label: t("Quizzes"), value: statistics.quizCount },
          { icon: Link2, label: t("Sources"), value: statistics.sourceCount },
        ].map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.label} className="border-b border-r border-border p-3 last:border-r-0 sm:border-b-0">
              <dt className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {metric.label}
              </dt>
              <dd className="mt-1 text-base font-semibold tabular-nums text-foreground">
                {formatter.format(metric.value)}
              </dd>
            </div>
          );
        })}
      </dl>

      <div className="border-t border-border px-4 py-4">
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="font-medium text-foreground">{t("Reading progress")}</span>
          <span className="tabular-nums text-muted-foreground">
            {t("{{visited}} of {{total}} pages", {
              visited: statistics.visitedPageCount,
              total: statistics.pageCount,
            })} · {statistics.readingProgressPercent}%
          </span>
        </div>
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={t("Reading progress")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={statistics.readingProgressPercent}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${statistics.readingProgressPercent}%` }}
          />
        </div>
      </div>

      {statistics.chapters.length > 0 && (
        <div className="border-t border-border px-4 py-4">
          <h3 className="text-xs font-medium text-foreground">
            {t("Chapter content distribution")}
          </h3>
          <div className="mt-3 space-y-3">
            {statistics.chapters.map((chapter, index) => (
              <div key={chapter.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                <div className="truncate text-xs text-foreground" title={chapter.title}>
                  <span className="mr-2 tabular-nums text-muted-foreground">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {chapter.title}
                </div>
                <div className="text-[11px] tabular-nums text-muted-foreground">
                  {t("{{pages}} pages · {{count}} words / characters", {
                    pages: chapter.pageCount,
                    count: formatter.format(chapter.contentUnits),
                  })}
                </div>
                <div className="col-span-2 h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary-muted"
                    style={{
                      width: `${Math.round((chapter.contentUnits / maxChapterUnits) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
