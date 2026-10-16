"use client";

import * as React from "react";
import { Activity, BookOpen, CalendarDays, ChevronRight, Plus, Target } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";

import { LearningProjectOnboarding } from "@/components/learning/LearningProjectOnboarding";
import { LearningImpactSummary } from "@/components/learning/LearningImpactSummary";
import { Button, Skeleton } from "@/components/ui";
import {
  fetchLearningProjects,
  learningTaskLaunchHref,
  startLearningTask,
  type LearningProject,
} from "@/lib/learning-project-api";

function outcomeLabel(eventType: LearningProject["events"][number]["event_type"]): string {
  const labels: Record<LearningProject["events"][number]["event_type"], string> = {
    project_created: "Project created",
    project_updated: "Plan adjusted",
    task_created: "Task added",
    task_started: "Task started",
    task_completed: "Task completed",
    task_skipped: "Task skipped",
    mastery_updated: "Mastery updated",
    review_scheduled: "Review scheduled",
    assessment_completed: "Baseline completed",
    knowledge_map_updated: "Knowledge map updated",
    quiz_completed: "Quiz completed",
    mistake_recorded: "Weak point diagnosed",
    review_completed: "Review completed",
    resource_activity: "Resource outcome saved",
    tutor_reminder: "Tutor reminder updated",
    mentor_suggestion: "Tutor suggestion followed",
  };
  return labels[eventType];
}


export function LearningProjectsPanel() {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const [projects, setProjects] = React.useState<LearningProject[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [onboardingOpen, setOnboardingOpen] = React.useState(false);
  const recentEvents = React.useMemo(
    () => projects
      .flatMap((project) => project.events.map((event) => ({ event, project })))
      .sort((left, right) => right.event.created_at - left.event.created_at)
      .slice(0, 5),
    [projects],
  );

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await fetchLearningProjects());
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void fetchLearningProjects()
      .then((items) => {
        if (!cancelled) {
          setProjects(items);
          setError(false);
        }
      })
      .catch(() => { if (!cancelled) setError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const resume = async (project: LearningProject) => {
    const task = project.tasks.find((item) => item.status === "in_progress")
      ?? project.tasks.find((item) => item.status === "todo");
    if (!task) return;
    try {
      await startLearningTask({ ...task, project_version: project.version });
    } catch {
      // A conflicting update is harmless here: opening the task remains safe.
    }
    router.push(learningTaskLaunchHref(task));
  };

  return (
    <section className="mb-5" aria-labelledby="learning-projects-heading">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 id="learning-projects-heading" className="text-lg font-semibold">{t("Learning plans")}</h2>
          <p className="text-sm text-muted-foreground">{t("Long-term goals, weekly plans, and the next concrete task.")}</p>
        </div>
        <Button size="sm" onClick={() => setOnboardingOpen(true)}><Plus size={14} />{t("Create learning goal")}</Button>
      </div>
      {loading ? (
        <div className="grid gap-3 md:grid-cols-2">{[0, 1].map((item) => <Skeleton key={item} className="h-40" />)}</div>
      ) : error ? (
        <button type="button" onClick={() => void load()} className="surface w-full p-4 text-left text-sm text-destructive">{t("Learning plans could not be loaded. Retry")}</button>
      ) : projects.length === 0 ? (
        <button type="button" onClick={() => setOnboardingOpen(true)} className="surface flex w-full items-center gap-3 p-5 text-left hover:border-primary-border"><BookOpen className="text-primary" /><span><span className="block font-medium">{t("Turn a goal into your first learning task")}</span><span className="text-sm text-muted-foreground">{t("Answer a few questions and Cognivoy will create the first week.")}</span></span><ChevronRight className="ml-auto text-muted-foreground" size={18} /></button>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {projects.slice(0, 4).map((project) => {
            const completed = project.tasks.filter((task) => task.status === "completed").length;
            const nextTask = project.tasks.find((task) => task.status === "in_progress") ?? project.tasks.find((task) => task.status === "todo");
            const progress = project.tasks.length ? Math.round((completed / project.tasks.length) * 100) : 0;
            return (
              <article key={project.id} className="surface min-w-0 p-4">
                <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate font-semibold">{project.title}</h3><p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{project.motivation || t("A structured learning goal")}</p></div><span className="rounded-full bg-primary-muted px-2 py-1 text-xs text-foreground">{progress}%</span></div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${progress}%` }} /></div>
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><CalendarDays size={13} />{t("{{minutes}} minutes per week", { minutes: project.weekly_minutes })}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{t("{{percent}}% mastery", { percent: Math.round(project.mastery_summary * 100) })}</span>
                  {project.weak_points.length > 0 && (
                    <span className="inline-flex items-center gap-1 text-warning">
                      <Target size={12} aria-hidden="true" />
                      {t("{{count}} weak points", { count: project.weak_points.length })}
                    </span>
                  )}
                  {project.due_review_count > 0 && (
                    <span>{t("{{count}} reviews due", { count: project.due_review_count })}</span>
                  )}
                </div>
                {nextTask && <button type="button" onClick={() => void resume(project)} className="mt-3 flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left text-sm hover:border-primary-border"><span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">{t("Next task")}</span><span className="block truncate font-medium">{nextTask.objective}</span></span><ChevronRight size={15} /></button>}
                <Link href={`/space/learning/${encodeURIComponent(project.id)}`} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">{t("View project details")}<ChevronRight size={14} /></Link>
              </article>
            );
          })}
        </div>
      )}
      {!loading && !error && recentEvents.length > 0 && (
        <section className="surface mt-4 p-4" aria-labelledby="learning-activity-heading">
          <div className="flex items-center gap-2">
            <Activity size={16} className="text-primary" aria-hidden="true" />
            <h3 id="learning-activity-heading" className="font-semibold">{t("Recent learning outcomes")}</h3>
          </div>
          <ol className="mt-3 divide-y divide-border">
            {recentEvents.map(({ event, project }) => (
              <li key={event.id} className="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="truncate text-sm font-medium">{event.title}</span>
                    <time className="text-xs text-muted-foreground" dateTime={new Date(event.created_at * 1000).toISOString()}>
                      {new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(event.created_at * 1000))}
                    </time>
                  </div>
                  <p className="text-xs text-muted-foreground">{project.title} · {t(outcomeLabel(event.event_type))}</p>
                  {event.description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{event.description}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Link href={`/space/learning/${encodeURIComponent(project.id)}`} className="text-xs font-medium text-primary hover:underline">{t("Open project evidence")}</Link>
                    {event.result_refs.length > 0 && <span className="text-[11px] text-muted-foreground">{t("{{count}} saved result references", { count: event.result_refs.length })}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}
      {!loading && !error && projects.length > 0 && <LearningImpactSummary />}
      <LearningProjectOnboarding open={onboardingOpen} onClose={() => setOnboardingOpen(false)} onCreated={() => void load()} />
    </section>
  );
}
