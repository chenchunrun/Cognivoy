"use client";

import { BookOpen, CalendarCheck, Check, ChevronRight, ClipboardList, PenLine } from "lucide-react";
import Link from "next/link";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

interface LearningLoopProgressProps {
  projectTitle: string;
  projectHref?: string;
  planPercent: number;
  completedTasks: number;
  totalTasks?: number;
  masteryPercent: number;
  practiceCount: number;
  dueReviews: number;
  weakPointCount?: number;
  compact?: boolean;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function LearningLoopProgress({
  projectTitle,
  projectHref,
  planPercent,
  completedTasks,
  totalTasks,
  masteryPercent,
  practiceCount,
  dueReviews,
  weakPointCount = 0,
  compact = false,
}: LearningLoopProgressProps) {
  const { t } = useTranslation();
  const safePlanPercent = clampPercent(planPercent);
  const safeMasteryPercent = clampPercent(masteryPercent);
  const stages = [
    {
      label: t("Plan"),
      value: t("{{percent}}% complete", { percent: safePlanPercent }),
      detail: totalTasks === undefined
        ? t("{{count}} tasks completed", { count: completedTasks })
        : t("{{completed}} of {{total}} tasks", { completed: completedTasks, total: totalTasks }),
      icon: ClipboardList,
      active: completedTasks > 0 || safePlanPercent > 0,
    },
    {
      label: t("Learn"),
      value: t("{{percent}}% mastery", { percent: safeMasteryPercent }),
      detail: weakPointCount > 0
        ? t("{{count}} weak points identified", { count: weakPointCount })
        : t("Understanding updates from saved evidence"),
      icon: BookOpen,
      active: safeMasteryPercent > 0,
    },
    {
      label: t("Practice"),
      value: t("{{count}} attempts", { count: practiceCount }),
      detail: t("Answers feed back into your plan"),
      icon: PenLine,
      active: practiceCount > 0,
    },
    {
      label: t("Review & retain"),
      value: dueReviews > 0 ? t("{{count}} due now", { count: dueReviews }) : t("Up to date"),
      detail: t("Spaced review keeps knowledge active"),
      icon: CalendarCheck,
      active: dueReviews > 0 || practiceCount > 0,
    },
  ];

  return (
    <section
      className={cn("surface", compact ? "p-3" : "p-5")}
      aria-labelledby={compact ? "home-learning-loop-heading" : "learning-loop-heading"}
      data-testid="learning-loop-progress"
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-primary">{t("Your learning loop")}</p>
          <h2 id={compact ? "home-learning-loop-heading" : "learning-loop-heading"} className={cn("truncate font-semibold", compact ? "mt-0.5 text-sm" : "mt-1 text-lg")}>{projectTitle}</h2>
        </div>
        {projectHref && (
          <Link href={projectHref} className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline">
            {t("View plan")}<ChevronRight size={13} aria-hidden="true" />
          </Link>
        )}
      </div>

      <ol className={cn("grid gap-2", compact ? "mt-3 grid-cols-2 xl:grid-cols-4" : "mt-4 sm:grid-cols-2 lg:grid-cols-4")}>
        {stages.map((stage, index) => {
          const Icon = stage.icon;
          return (
            <li key={stage.label} className="relative rounded-xl bg-muted-subtle p-3">
              <div className="flex items-center gap-2">
                <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-full", stage.active ? "bg-primary-muted text-primary" : "bg-muted text-muted-foreground")}>
                  {stage.active ? <Check size={14} aria-hidden="true" /> : <Icon size={14} aria-hidden="true" />}
                </span>
                <span className="text-xs text-muted-foreground">{index + 1}. {stage.label}</span>
              </div>
              <p className="mt-2 text-sm font-semibold">{stage.value}</p>
              {!compact && <p className="mt-1 text-xs text-muted-foreground">{stage.detail}</p>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
