"use client";

import Link from "next/link";
import { ArrowRight, CalendarCheck, CircleAlert, Clock3, Target } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui";
import type { LearningNextAction, LearningProjectSummary } from "@/lib/learning-project-api";

interface LearningFocusCardProps {
  project: LearningProjectSummary;
  action: LearningNextAction;
  busy?: boolean;
  onAction: () => void;
}

function actionLabel(kind: LearningNextAction["kind"], t: (key: string) => string): string {
  if (kind === "baseline") return t("Start baseline");
  if (kind === "review") return t("Review now");
  if (kind === "continue") return t("Continue learning");
  if (kind === "start") return t("Start next task");
  if (kind === "completed") return t("View learning results");
  return t("Open learning plan");
}

export function LearningFocusCard({
  project,
  action,
  busy = false,
  onAction,
}: LearningFocusCardProps) {
  const { t } = useTranslation();
  const status = project.learning_status;
  const progress = Math.round((status?.progress.completion_rate ?? 0) * 100);
  const mastery = Math.round((status?.mastery ?? project.mastery_summary) * 100);
  const dueReviews = status?.due_reviews ?? project.due_review_count;
  const weakPoints = status?.weak_point_count ?? project.weak_points.length;

  return (
    <section
      className="surface w-full max-w-5xl overflow-hidden border-primary-border"
      aria-labelledby="learning-focus-heading"
      data-testid="learning-focus-card"
    >
      <div className="grid gap-0 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.75fr)]">
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wider text-primary">
              {t("Your learning goal")}
            </p>
            <Link
              href={`/space/learning/${encodeURIComponent(project.id)}`}
              className="text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
            >
              {t("View plan")}
            </Link>
          </div>
          <h2 id="learning-focus-heading" className="display mt-2 text-2xl font-semibold">
            {project.title}
          </h2>
          {project.motivation ? (
            <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{project.motivation}</p>
          ) : null}

          <div className="mt-5 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-muted-subtle p-3">
              <p className="text-xs text-muted-foreground">{t("Plan progress")}</p>
              <p className="mt-1 text-xl font-semibold">{progress}%</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("{{completed}} of {{total}} tasks", {
                  completed: status?.progress.completed_tasks ?? 0,
                  total: status?.progress.total_tasks ?? 0,
                })}
              </p>
            </div>
            <div className="rounded-xl bg-muted-subtle p-3">
              <p className="text-xs text-muted-foreground">{t("Current mastery")}</p>
              <p className="mt-1 text-xl font-semibold">{mastery}%</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("From saved learning evidence")}</p>
            </div>
            <div className="rounded-xl bg-muted-subtle p-3">
              <p className="text-xs text-muted-foreground">{t("Learning signals")}</p>
              <p className="mt-1 text-sm font-semibold">
                {t("{{reviews}} reviews · {{weak}} weak points", {
                  reviews: dueReviews,
                  weak: weakPoints,
                })}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{t("Updated as you learn")}</p>
            </div>
          </div>
        </div>

        <div className="border-t border-border bg-primary-muted p-5 sm:p-6 lg:border-l lg:border-t-0">
          <div className="flex items-center gap-2 text-foreground">
            <Target size={17} className="text-primary" aria-hidden="true" />
            <p className="text-xs font-medium uppercase tracking-wider">{t("Your next step")}</p>
          </div>
          <h3 className="mt-3 text-lg font-semibold">{action.title}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{action.reason}</p>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
            {action.expected_minutes > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Clock3 size={13} aria-hidden="true" />
                {t("About {{minutes}} minutes", { minutes: action.expected_minutes })}
              </span>
            ) : null}
            {dueReviews > 0 ? (
              <span className="inline-flex items-center gap-1">
                <CalendarCheck size={13} aria-hidden="true" />
                {t("{{count}} items due", { count: dueReviews })}
              </span>
            ) : null}
            {weakPoints > 0 ? (
              <span className="inline-flex items-center gap-1">
                <CircleAlert size={13} aria-hidden="true" />
                {t("{{count}} weak points identified", { count: weakPoints })}
              </span>
            ) : null}
          </div>
          <Button className="mt-5 w-full" loading={busy} onClick={onAction}>
            {actionLabel(action.kind, t)}
            <ArrowRight size={15} aria-hidden="true" />
          </Button>
        </div>
      </div>
    </section>
  );
}
