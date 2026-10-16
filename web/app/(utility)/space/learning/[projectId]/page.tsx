"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  BookOpenCheck,
  CheckCircle2,
  Circle,
  Clock3,
  LockKeyhole,
  Play,
  Save,
  Target,
  RotateCcw,
  HeartHandshake,
  BarChart3,
  BookOpen,
  Database,
  NotebookTabs,
  ClipboardCheck,
  AlertTriangle,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/shell/PageHeader";
import { LearningLoopProgress } from "@/components/learning/LearningLoopProgress";
import { Button, Skeleton, useToast } from "@/components/ui";
import {
  fetchBaselineAssessment,
  completeProjectReview,
  fetchLearningProject,
  learningTaskLaunchHref,
  startLearningTask,
  reconcileLearningProject,
  submitBaselineAssessment,
  updateLearningProject,
  type AssessmentPayload,
  type KnowledgeNode,
  type LearningProject,
  type LearningTask,
} from "@/lib/learning-project-api";
import { listPartners, type PartnerInfo } from "@/lib/partners-api";
import { bookApi } from "@/lib/book-api";
import { listKnowledgeBases, type KnowledgeBaseSummary } from "@/lib/knowledge-api";
import { listNotebooks, type NotebookSummary } from "@/lib/notebook-api";
import type { Book } from "@/lib/book-types";

function nodeIcon(node: KnowledgeNode) {
  if (node.status === "mastered") return <CheckCircle2 size={18} aria-hidden="true" />;
  if (node.status === "locked") return <LockKeyhole size={18} aria-hidden="true" />;
  return <Circle size={18} aria-hidden="true" />;
}

const DEFAULT_REVIEW_PREFERENCES: NonNullable<LearningProject["review_preferences"]> = {
  intensity: "balanced",
  reminder_time: "19:00",
  daily_question_limit: 10,
  reminder_weekdays: [0, 1, 2, 3, 4, 5, 6],
  reminders_paused_until: null,
};

function ResourceLinks({
  icon,
  title,
  empty,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  items: Array<{ id: string; label: string; href: string }>;
}) {
  return (
    <article className="rounded-xl border border-border p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-primary">{icon}{title}</h3>
      {items.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">{empty}</p> : (
        <ul className="mt-3 space-y-2">
          {items.map((item) => <li key={item.id}><Link href={item.href} className="block truncate text-sm font-medium hover:text-primary hover:underline">{item.label}</Link></li>)}
        </ul>
      )}
    </article>
  );
}

export default function LearningProjectDetailPage() {
  const params = useParams<{ projectId: string }>();
  const router = useRouter();
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [project, setProject] = React.useState<LearningProject | null>(null);
  const [assessment, setAssessment] = React.useState<AssessmentPayload | null>(null);
  const [responses, setResponses] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(true);
  const [savingAssessment, setSavingAssessment] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [savingProject, setSavingProject] = React.useState(false);
  const [savingReviewId, setSavingReviewId] = React.useState("");
  const [reconciling, setReconciling] = React.useState(false);
  const [partners, setPartners] = React.useState<PartnerInfo[]>([]);
  const [knowledgeBases, setKnowledgeBases] = React.useState<KnowledgeBaseSummary[]>([]);
  const [books, setBooks] = React.useState<Book[]>([]);
  const [notebooks, setNotebooks] = React.useState<NotebookSummary[]>([]);
  const [draft, setDraft] = React.useState<{
    title: string;
    motivation: string;
    weekly_minutes: number;
    deadline: string;
    partner_id: string;
    review_preferences: NonNullable<LearningProject["review_preferences"]>;
    knowledge_base_ids: string[];
    book_ids: string[];
    notebook_ids: string[];
    teaching_strategy: LearningProject["teaching_strategy"];
    difficulty_policy: LearningProject["difficulty_policy"];
  }>({
    title: "",
    motivation: "",
    weekly_minutes: 180,
    deadline: "",
    partner_id: "",
    review_preferences: DEFAULT_REVIEW_PREFERENCES,
    knowledge_base_ids: [],
    book_ids: [],
    notebook_ids: [],
    teaching_strategy: "adaptive",
    difficulty_policy: "adaptive",
  });

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchLearningProject(params.projectId),
      fetchBaselineAssessment(params.projectId),
      listPartners().catch(() => []),
      listKnowledgeBases().catch(() => []),
      bookApi.list({ limit: 100 }).then((result) => result.books).catch(() => []),
      listNotebooks().catch(() => []),
    ]).then(([nextProject, nextAssessment, nextPartners, nextKnowledgeBases, nextBooks, nextNotebooks]) => {
      if (cancelled) return;
      setProject(nextProject);
      setAssessment(nextAssessment);
      setResponses(nextAssessment.responses ?? {});
      setPartners(nextPartners);
      setKnowledgeBases(nextKnowledgeBases);
      setBooks(nextBooks);
      setNotebooks(nextNotebooks);
      setDraft({
        title: nextProject.title,
        motivation: nextProject.motivation,
        weekly_minutes: nextProject.weekly_minutes,
        deadline: nextProject.deadline ? new Date(nextProject.deadline * 1000).toISOString().slice(0, 10) : "",
        partner_id: nextProject.partner_id ?? "",
        review_preferences: {
          ...DEFAULT_REVIEW_PREFERENCES,
          ...(nextProject.review_preferences ?? {}),
          reminder_weekdays: nextProject.review_preferences?.reminder_weekdays ?? DEFAULT_REVIEW_PREFERENCES.reminder_weekdays,
        },
        knowledge_base_ids: nextProject.knowledge_base_ids ?? [],
        book_ids: nextProject.book_ids ?? [],
        notebook_ids: nextProject.notebook_ids ?? [],
        teaching_strategy: nextProject.teaching_strategy ?? "adaptive",
        difficulty_policy: nextProject.difficulty_policy ?? "adaptive",
      });
    }).catch((reason) => {
      if (!cancelled) {
        toast({
          variant: "destructive",
          title: t("Learning plan could not be loaded"),
          description: reason instanceof Error ? reason.message : String(reason),
        });
      }
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [params.projectId, t, toast]);

  const submitAssessment = async () => {
    if (!project || !assessment) return;
    if (assessment.questions.some((question) => responses[question.id] === undefined)) {
      toast({ variant: "destructive", title: t("Answer every baseline question first") });
      return;
    }
    setSavingAssessment(true);
    try {
      const next = await submitBaselineAssessment(project.id, project.version, responses);
      setProject(next);
      setAssessment(await fetchBaselineAssessment(project.id));
      toast({ variant: "success", title: t("Baseline saved and knowledge map updated") });
    } catch (reason) {
      toast({
        variant: "destructive",
        title: t("Baseline assessment could not be saved"),
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setSavingAssessment(false);
    }
  };

  const toggleResource = (
    key: "knowledge_base_ids" | "book_ids" | "notebook_ids",
    resourceId: string,
  ) => {
    setDraft((current) => ({
      ...current,
      [key]: current[key].includes(resourceId)
        ? current[key].filter((item) => item !== resourceId)
        : [...current[key], resourceId],
    }));
  };

  const saveProject = async () => {
    if (!project) return;
    setSavingProject(true);
    try {
      const next = await updateLearningProject(project.id, project.version, {
        ...draft,
        deadline: draft.deadline ? new Date(`${draft.deadline}T23:59:59`).getTime() / 1000 : null,
        partner_id: draft.partner_id || null,
      });
      setProject(next);
      setEditing(false);
      toast({ variant: "success", title: t("Learning plan updated") });
    } catch (reason) {
      toast({
        variant: "destructive",
        title: t("Learning plan could not be updated"),
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setSavingProject(false);
    }
  };

  const reconcilePlan = async () => {
    if (!project || reconciling) return;
    setReconciling(true);
    try {
      const next = await reconcileLearningProject(project.id, project.version);
      setProject(next);
      setDraft((current) => ({
        ...current,
        weekly_minutes: next.weekly_minutes,
        deadline: next.deadline ? new Date(next.deadline * 1000).toISOString().slice(0, 10) : "",
      }));
      toast({ variant: "success", title: t("Course plan reconciled") });
    } catch (reason) {
      toast({
        variant: "destructive",
        title: t("Course plan could not be reconciled"),
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setReconciling(false);
    }
  };

  const resume = async () => {
    if (!project) return;
    const action = project.learning_status?.next_action;
    if (action?.kind === "review") {
      document.querySelector("#review-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (action?.kind === "plan") {
      setEditing(true);
      return;
    }
    if (action?.kind === "completed") {
      document.querySelector("#learning-analytics")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    const task = action?.task
      ?? project.tasks.find((item) => item.status === "in_progress")
      ?? project.tasks.find((item) => item.status === "todo");
    if (!task) return;
    if (task.intent === "assessment") {
      document.querySelector("#baseline-assessment")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    try { await startLearningTask({ ...task, project_version: project.version }); } catch { /* safe to resume after a concurrent start */ }
    router.push(learningTaskLaunchHref(task));
  };

  const completeReview = async (reviewId: string, isCorrect: boolean) => {
    if (!project || savingReviewId) return;
    setSavingReviewId(reviewId);
    try {
      const attemptId = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `review-${reviewId}-${project.version}`;
      await completeProjectReview(project.id, reviewId, project.version, isCorrect, attemptId);
      setProject(await fetchLearningProject(project.id));
      toast({ variant: "success", title: isCorrect ? t("Review completed") : t("Review kept in today’s queue") });
    } catch (reason) {
      toast({
        variant: "destructive",
        title: t("Review result could not be saved"),
        description: reason instanceof Error ? reason.message : String(reason),
      });
    } finally {
      setSavingReviewId("");
    }
  };

  if (loading) {
    return <div className="mx-auto max-w-7xl px-6 py-8"><Skeleton className="h-16 w-full" /><Skeleton className="mt-6 h-80 w-full" /></div>;
  }
  if (!project || !assessment) {
    return <div className="mx-auto max-w-3xl px-6 py-12"><p className="text-muted-foreground">{t("This learning plan is unavailable.")}</p><Button className="mt-4" variant="outline" onClick={() => router.push("/space/learning")}>{t("Back to learning space")}</Button></div>;
  }

  const objectiveBaselineIncomplete = project.course_readiness?.issues.some(
    (issue) => issue.code === "baseline_incomplete",
  );
  const isEffectivelyCompleted = (task: LearningTask) =>
    task.status === "completed" &&
    !(objectiveBaselineIncomplete && task.intent === "assessment");
  const learningStatus = project.learning_status;
  const completedTasks = learningStatus?.progress.completed_tasks
    ?? project.tasks.filter(isEffectivelyCompleted).length;
  const totalTasks = learningStatus?.progress.total_tasks
    ?? project.tasks.filter((task) => task.status !== "skipped").length;
  const progress = Math.round(
    (learningStatus?.progress.completion_rate
      ?? (totalTasks ? completedTasks / totalTasks : 0)) * 100,
  );
  const nextAction = learningStatus?.next_action;
  const fallbackNextTask = project.tasks.find((task) => task.status === "in_progress")
    ?? project.tasks.find((task) => task.status === "todo");
  const nextActionKind = nextAction?.kind
    ?? (fallbackNextTask?.intent === "assessment" ? "baseline" : fallbackNextTask ? "continue" : null);
  const completedTaskIds = new Set(
    project.tasks
      .filter(isEffectivelyCompleted)
      .map((task) => task.id),
  );
  const dueReviews = project.review_items
    .filter((item) => item.status === "due" || (item.status === "scheduled" && item.due_at <= (project.server_time ?? project.updated_at)))
    .sort((left, right) => left.due_at - right.due_at);
  const reviewPreferences = project.review_preferences ?? DEFAULT_REVIEW_PREFERENCES;
  const visibleDueReviews = dueReviews.slice(0, reviewPreferences.daily_question_limit);
  const assignedPartner = partners.find((item) => item.partner_id === project.partner_id);
  const teachingDifficulty = project.teaching_profile?.difficulty === "challenge"
    ? t("Challenge")
    : project.teaching_profile?.difficulty === "guided"
      ? t("Guided")
      : t("Foundation");
  const teachingStrategy = project.teaching_profile?.strategy === "visual_first"
    ? t("Visual first")
    : project.teaching_profile?.strategy === "socratic"
      ? t("Socratic dialogue")
      : project.teaching_profile?.strategy === "practice_first"
        ? t("Practice first")
        : project.teaching_profile?.strategy === "example_first"
          ? t("Examples first")
          : t("Structured explanation");

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <Link href="/space/learning" className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft size={15} />{t("Learning space")}</Link>
      <PageHeader
        title={project.title}
        description={project.motivation || t("A structured learning goal")}
        actions={<><Button variant="outline" onClick={() => setEditing((value) => !value)}>{editing ? t("Cancel") : t("Adjust plan")}</Button>{nextActionKind && <Button onClick={() => void resume()}><Play size={15} />{{ baseline: t("Start baseline"), review: t("Review now"), continue: t("Continue learning"), start: t("Start next task"), plan: t("Complete plan"), completed: t("View learning results"), create_plan: t("Create my learning plan") }[nextActionKind]}</Button>}</>}
      />

      <LearningLoopProgress
        projectTitle={project.title}
        planPercent={progress}
        completedTasks={completedTasks}
        totalTasks={totalTasks}
        masteryPercent={(learningStatus?.mastery ?? project.mastery_summary) * 100}
        practiceCount={project.analytics?.quiz_attempts ?? project.events.filter((event) => event.event_type === "quiz_completed").length}
        dueReviews={learningStatus?.due_reviews ?? project.due_review_count}
        weakPointCount={learningStatus?.weak_point_count ?? project.weak_points.length}
      />

      {project.teaching_profile && (
        <section className="surface mt-6 flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between" data-testid="adaptive-teaching-profile" aria-labelledby="adaptive-teaching-heading">
          <div className="min-w-0">
            <h2 id="adaptive-teaching-heading" className="text-lg font-semibold">{t("Adaptive teaching for your next session")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("The tutor adjusts scaffolding from saved assessments, completed tasks, weak points, and your learning preferences.")}</p>
          </div>
          <div className="grid shrink-0 grid-cols-2 gap-2 text-sm">
            <div className="rounded-xl bg-muted-subtle px-4 py-3"><span className="block text-xs text-muted-foreground">{t("Difficulty")}</span><strong className="mt-1 block">{teachingDifficulty}</strong></div>
            <div className="rounded-xl bg-muted-subtle px-4 py-3"><span className="block text-xs text-muted-foreground">{t("Teaching strategy")}</span><strong className="mt-1 block">{teachingStrategy}</strong></div>
          </div>
        </section>
      )}

      {project.course_readiness && (
        <section className="surface mt-6 p-5" data-testid="course-readiness" aria-labelledby="course-readiness-heading">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className={`rounded-xl p-2 ${project.course_readiness.status === "ready" ? "bg-success-muted text-success" : "bg-warning-muted text-warning"}`}>
                {project.course_readiness.status === "ready" ? <ShieldCheck size={20} /> : <AlertTriangle size={20} />}
              </span>
              <div>
                <h2 id="course-readiness-heading" className="text-lg font-semibold">{t("Course readiness")}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t("{{score}}/100 · {{questions}} questions · {{attempted}} attempted", {
                  score: project.course_readiness.score,
                  questions: project.course_readiness.metrics.total_questions,
                  attempted: project.course_readiness.metrics.attempted_questions,
                })}</p>
              </div>
            </div>
            {project.course_readiness.issues.some((issue) => ["deadline_missing", "task_dependencies_missing", "weekly_load_underallocated"].includes(issue.code)) && (
              <Button variant="outline" loading={reconciling} onClick={() => void reconcilePlan()}><Wrench size={15} />{t("Reconcile plan")}</Button>
            )}
          </div>
          {project.course_readiness.issues.length === 0 ? (
            <p className="mt-4 rounded-xl bg-success-muted p-3 text-sm text-success">{t("The course has the evidence, sequence, resources, and schedule needed to start.")}</p>
          ) : (
            <ol className="mt-4 grid gap-3 md:grid-cols-2">
              {project.course_readiness.issues.map((issue) => (
                <li key={issue.code} className="rounded-xl border border-border p-3">
                  <div className="flex items-center gap-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${issue.severity === "blocker" ? "bg-destructive-muted text-destructive" : "bg-warning-muted text-warning"}`}>{t(issue.severity === "blocker" ? "Blocked" : "Needs attention")}</span><strong className="text-sm">{t(issue.message)}</strong></div>
                  <p className="mt-2 text-xs text-muted-foreground">{t(issue.action)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {project.analytics && (
        <section id="learning-analytics" className="surface mt-6 scroll-mt-6 p-5" aria-labelledby="learning-analytics-heading" data-testid="learning-analytics">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="learning-analytics-heading" className="flex items-center gap-2 text-lg font-semibold"><BarChart3 size={18} className="text-primary" />{t("Learning impact · last 7 days")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("Derived from saved learning evidence, so reloads and duplicate submissions do not inflate the totals.")}</p>
            </div>
            <span className="text-xs text-muted-foreground">{t("{{count}} active days", { count: project.analytics.active_days })}</span>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {[
              [t("Study time"), t("{{count}} min", { count: project.analytics.study_minutes })],
              [t("Tasks completed"), String(project.analytics.completed_tasks)],
              [t("Review attempts"), String(project.analytics.review_attempts)],
              [t("Quiz attempts"), String(project.analytics.quiz_attempts)],
              [t("Mastery change"), `${project.analytics.mastery_delta >= 0 ? "+" : ""}${Math.round(project.analytics.mastery_delta * 100)}%`],
            ].map(([label, value]) => <article key={label} className="rounded-xl bg-muted-subtle p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></article>)}
          </div>
          {project.analytics.comparison && (
            <p className="mt-3 text-xs text-muted-foreground" data-testid="learning-period-comparison">
              {t("Compared with the previous 7 days: {{minutes}} min, {{tasks}} tasks, {{days}} active days", {
                minutes: `${project.analytics.comparison.study_minutes_delta >= 0 ? "+" : ""}${project.analytics.comparison.study_minutes_delta}`,
                tasks: `${project.analytics.comparison.completed_tasks_delta >= 0 ? "+" : ""}${project.analytics.comparison.completed_tasks_delta}`,
                days: `${project.analytics.comparison.active_days_delta >= 0 ? "+" : ""}${project.analytics.comparison.active_days_delta}`,
              })}
            </p>
          )}
          <div className="mt-5 grid grid-cols-7 gap-2" aria-label={t("Daily learning activity")}>
            {project.analytics.daily.map((day) => {
              const intensity = Math.min(100, Math.max(8, day.events * 20));
              return <div key={day.date} className="text-center"><div className="flex h-16 items-end rounded-lg bg-muted p-1"><div className="w-full rounded-md bg-primary" style={{ height: `${day.events ? intensity : 0}%` }} title={t("{{date}} · {{count}} learning events", { date: day.date, count: day.events })} /></div><span className="mt-1 block text-[10px] text-muted-foreground">{new Intl.DateTimeFormat(i18n.language, { weekday: "narrow" }).format(new Date(`${day.date}T12:00:00Z`))}</span></div>;
            })}
          </div>
        </section>
      )}

      {editing && (
        <section className="surface mt-6 p-5" aria-labelledby="project-settings-heading">
          <h2 id="project-settings-heading" className="text-lg font-semibold">{t("Adjust learning plan")}</h2>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <label className="text-sm font-medium">{t("Project title")}<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal" /></label>
            <label className="text-sm font-medium">{t("Weekly study time")}<input type="number" min={15} max={10080} value={draft.weekly_minutes} onChange={(event) => setDraft({ ...draft, weekly_minutes: Number(event.target.value) })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal" /></label>
            <label className="text-sm font-medium">{t("Target completion date")}<input type="date" value={draft.deadline} onChange={(event) => setDraft({ ...draft, deadline: event.target.value })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal" /><span className="mt-1.5 block text-xs font-normal text-muted-foreground">{t("Used to detect pacing risk and schedule the final simulation.")}</span></label>
            <label className="text-sm font-medium md:col-span-2">{t("Why is this goal important to you?")}<textarea value={draft.motivation} onChange={(event) => setDraft({ ...draft, motivation: event.target.value })} className="mt-1.5 min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal" /></label>
            <label className="text-sm font-medium md:col-span-2">
              {t("Learning tutor")}
              <select value={draft.partner_id} onChange={(event) => setDraft({ ...draft, partner_id: event.target.value })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal">
                <option value="">{t("No tutor")}</option>
                {partners.map((partner) => <option key={partner.partner_id} value={partner.partner_id}>{partner.name || partner.partner_id}</option>)}
              </select>
              <span className="mt-1.5 block text-xs font-normal text-muted-foreground">{t("An opted-in tutor can remind you when project reviews become due, with evidence and a direct link back here.")}</span>
            </label>
            <fieldset className="rounded-xl border border-border p-4 md:col-span-2">
              <legend className="px-1 text-sm font-semibold">{t("Teaching adaptation")}</legend>
              <p className="mb-4 text-xs text-muted-foreground">{t("Automatic uses saved learning evidence. You can override it when you want a specific teaching style or challenge level.")}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm font-medium">{t("Teaching strategy")}
                  <select value={draft.teaching_strategy} onChange={(event) => setDraft({ ...draft, teaching_strategy: event.target.value as LearningProject["teaching_strategy"] })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal">
                    <option value="adaptive">{t("Automatic")}</option><option value="structured">{t("Structured explanation")}</option><option value="visual_first">{t("Visual first")}</option><option value="socratic">{t("Socratic dialogue")}</option><option value="practice_first">{t("Practice first")}</option><option value="example_first">{t("Examples first")}</option>
                  </select>
                </label>
                <label className="text-sm font-medium">{t("Difficulty policy")}
                  <select value={draft.difficulty_policy} onChange={(event) => setDraft({ ...draft, difficulty_policy: event.target.value as LearningProject["difficulty_policy"] })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal">
                    <option value="adaptive">{t("Automatic")}</option><option value="foundation">{t("Foundation")}</option><option value="guided">{t("Guided")}</option><option value="challenge">{t("Challenge")}</option>
                  </select>
                </label>
              </div>
            </fieldset>
            <fieldset className="rounded-xl border border-border p-4 md:col-span-2">
              <legend className="px-1 text-sm font-semibold">{t("Review preferences")}</legend>
              <p className="mb-4 text-xs text-muted-foreground">{t("Control how often this project reviews weak knowledge without changing your tutor's notification permissions.")}</p>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="text-sm font-medium">{t("Review intensity")}
                  <select value={draft.review_preferences.intensity} onChange={(event) => setDraft({ ...draft, review_preferences: { ...draft.review_preferences, intensity: event.target.value as "light" | "balanced" | "intensive" } })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal">
                    <option value="light">{t("Light")}</option>
                    <option value="balanced">{t("Balanced")}</option>
                    <option value="intensive">{t("Intensive")}</option>
                  </select>
                </label>
                <label className="text-sm font-medium">{t("Preferred reminder time")}<input type="time" value={draft.review_preferences.reminder_time} onChange={(event) => setDraft({ ...draft, review_preferences: { ...draft.review_preferences, reminder_time: event.target.value } })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal" /></label>
                <label className="text-sm font-medium">{t("Daily question limit")}<input type="number" min={1} max={100} value={draft.review_preferences.daily_question_limit} onChange={(event) => setDraft({ ...draft, review_preferences: { ...draft.review_preferences, daily_question_limit: Number(event.target.value) } })} className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 font-normal" /></label>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg bg-muted-subtle p-3" data-testid="project-reminder-pause">
                <span className="mr-auto text-xs text-muted-foreground">
                  {draft.review_preferences.reminders_paused_until && draft.review_preferences.reminders_paused_until > (project?.server_time ?? 0)
                    ? t("Project reminders paused until {{time}}", { time: new Date(draft.review_preferences.reminders_paused_until * 1000).toLocaleString() })
                    : t("Project reminders are active")}
                </span>
                <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, review_preferences: { ...draft.review_preferences, reminders_paused_until: Date.now() / 1000 + 24 * 60 * 60 } })}>{t("Pause 24 hours")}</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setDraft({ ...draft, review_preferences: { ...draft.review_preferences, reminders_paused_until: Date.now() / 1000 + 7 * 24 * 60 * 60 } })}>{t("Pause 7 days")}</Button>
                {Boolean(draft.review_preferences.reminders_paused_until) && <Button type="button" size="sm" variant="ghost" onClick={() => setDraft({ ...draft, review_preferences: { ...draft.review_preferences, reminders_paused_until: null } })}>{t("Resume reminders")}</Button>}
              </div>
              <fieldset className="mt-4 rounded-lg border border-border p-3">
                <legend className="px-1 text-xs font-medium">{t("Reminder days")}</legend>
                <div className="flex flex-wrap gap-2">
                  {[t("Mon"), t("Tue"), t("Wed"), t("Thu"), t("Fri"), t("Sat"), t("Sun")].map((label, index) => {
                    const selected = draft.review_preferences.reminder_weekdays.includes(index);
                    return <label key={index} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs"><input type="checkbox" checked={selected} onChange={(event) => {
                      const next = event.target.checked
                        ? [...draft.review_preferences.reminder_weekdays, index].sort()
                        : draft.review_preferences.reminder_weekdays.filter((day) => day !== index);
                      if (!next.length) return;
                      setDraft({ ...draft, review_preferences: { ...draft.review_preferences, reminder_weekdays: next } });
                    }} />{label}</label>;
                  })}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t("Project reminder days further narrow the tutor's allowed notification window.")}</p>
              </fieldset>
            </fieldset>
            <fieldset className="rounded-xl border border-border p-4 md:col-span-2">
              <legend className="px-1 text-sm font-semibold">{t("Project learning resources")}</legend>
              <p className="mb-4 text-xs text-muted-foreground">{t("Linked knowledge bases are mounted automatically in project learning turns. Books and notebooks remain one click away as stable project evidence.")}</p>
              <div className="grid gap-5 lg:grid-cols-3">
                {[
                  {
                    key: "knowledge_base_ids" as const,
                    title: t("Knowledge bases"),
                    empty: t("No knowledge bases available"),
                    items: knowledgeBases.map((item) => ({ id: item.name, label: item.name })),
                  },
                  {
                    key: "book_ids" as const,
                    title: t("Books"),
                    empty: t("No books available"),
                    items: books.map((item) => ({ id: item.id, label: item.title })),
                  },
                  {
                    key: "notebook_ids" as const,
                    title: t("Notebooks"),
                    empty: t("No notebooks available"),
                    items: notebooks.map((item) => ({ id: item.id, label: item.name })),
                  },
                ].map((group) => (
                  <div key={group.key}>
                    <h3 className="text-sm font-semibold">{group.title}</h3>
                    <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                      {group.items.length === 0 ? <p className="text-xs text-muted-foreground">{group.empty}</p> : group.items.map((item) => (
                        <label key={item.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted-subtle">
                          <input type="checkbox" checked={draft[group.key].includes(item.id)} onChange={() => toggleResource(group.key, item.id)} />
                          <span className="truncate">{item.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>
          </div>
          <Button className="mt-4" loading={savingProject} onClick={() => void saveProject()}><Save size={15} />{t("Save changes")}</Button>
        </section>
      )}

      <section className="surface mt-6 flex flex-wrap items-center justify-between gap-4 p-5" aria-labelledby="learning-tutor-heading">
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-primary-muted p-2 text-foreground"><HeartHandshake size={19} aria-hidden="true" /></span>
          <div>
            <h2 id="learning-tutor-heading" className="font-semibold">{t("Learning tutor")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {assignedPartner
                ? t("{{name}} follows this project’s review evidence and can send policy-controlled reminders.", { name: assignedPartner.name || assignedPartner.partner_id })
                : t("No tutor is assigned. Your project still tracks reviews, but no proactive reminder will be sent.")}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{assignedPartner ? t("Change tutor") : t("Assign tutor")}</Button>
      </section>

      <section className="surface mt-6 p-5" aria-labelledby="project-resources-heading" data-testid="project-learning-resources">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 id="project-resources-heading" className="text-lg font-semibold">{t("Project learning resources")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("Resources stay attached to this goal across chat, practice, and review.")}</p></div>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>{t("Manage resources")}</Button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <ResourceLinks
            icon={<Database size={17} />}
            title={t("Knowledge bases")}
            empty={t("No knowledge base linked")}
            items={(project.knowledge_base_ids ?? []).map((id) => ({ id, label: knowledgeBases.find((item) => item.name === id)?.name ?? id, href: `/knowledge?kb=${encodeURIComponent(id)}` }))}
          />
          <ResourceLinks
            icon={<BookOpen size={17} />}
            title={t("Books")}
            empty={t("No book linked")}
            items={(project.book_ids ?? []).map((id) => ({ id, label: books.find((item) => item.id === id)?.title ?? id, href: `/book?book=${encodeURIComponent(id)}` }))}
          />
          <ResourceLinks
            icon={<NotebookTabs size={17} />}
            title={t("Notebooks")}
            empty={t("No notebook linked")}
            items={(project.notebook_ids ?? []).map((id) => ({ id, label: notebooks.find((item) => item.id === id)?.name ?? id, href: "/notebook" }))}
          />
          <ResourceLinks
            icon={<ClipboardCheck size={17} />}
            title={t("Practice")}
            empty={t("No project practice yet")}
            items={[{
              id: project.id,
              label: t("Open project questions"),
              href: `/question-notebook?project_id=${encodeURIComponent(project.id)}`,
            }]}
          />
        </div>
      </section>

      <section className="mt-6" aria-labelledby="course-tasks-heading" data-testid="course-task-loop">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="course-tasks-heading" className="text-lg font-semibold">{t("Course tasks and practice")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("Each task keeps its prerequisites, learning objective, time budget, and question set together.")}</p>
          </div>
          <Link href={`/question-notebook?project_id=${encodeURIComponent(project.id)}`} className="text-sm font-medium text-primary hover:underline">{t("Open all project questions")}</Link>
        </div>
        <ol className="surface divide-y divide-border px-4">
          {project.tasks.map((task, index) => {
            const locked = (task.prerequisites ?? []).some((id) => !completedTaskIds.has(id));
            let taskStatus = t("Ready");
            if (locked) taskStatus = t("Locked");
            if (task.status === "in_progress") taskStatus = t("In progress");
            if (task.status === "completed") taskStatus = t("Completed");
            if (task.intent === "assessment" && objectiveBaselineIncomplete) taskStatus = t("Baseline questions remaining");
            let stepClass = "bg-primary-muted text-primary";
            let stepContent: React.ReactNode = String(index + 1).padStart(2, "0");
            if (locked) {
              stepClass = "bg-muted text-muted-foreground";
              stepContent = <LockKeyhole size={15} />;
            }
            if (isEffectivelyCompleted(task)) {
              stepClass = "bg-success-muted text-success";
              stepContent = <CheckCircle2 size={16} />;
            }
            const practiceHref = `/question-notebook?project_id=${encodeURIComponent(project.id)}&task_id=${encodeURIComponent(task.id)}`;
            return (
              <li key={task.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${stepClass}`}>
                  {stepContent}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{task.objective}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{t("{{minutes}} min · {{status}}", { minutes: task.expected_minutes, status: taskStatus })}</p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" variant="outline" onClick={() => router.push(practiceHref)}><ClipboardCheck size={14} />{t("Task practice")}</Button>
                  {task.intent === "assessment" ? (
                    <Button size="sm" onClick={() => router.push(practiceHref)}><Target size={14} />{t("Answer baseline questions")}</Button>
                  ) : (
                    <Button size="sm" disabled={locked} onClick={() => {
                      if (task.status === "completed") {
                        router.push(learningTaskLaunchHref(task));
                        return;
                      }
                      void startLearningTask({ ...task, project_version: project.version })
                        .then(() => router.push(learningTaskLaunchHref(task)))
                        .catch((reason) => toast({ variant: "destructive", title: t("Learning task could not be started"), description: reason instanceof Error ? reason.message : String(reason) }));
                    }}><Play size={14} />{task.status === "completed" ? t("Review") : t("Learn")}</Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section id="baseline-assessment" className="surface mt-6 scroll-mt-6 p-5" aria-labelledby="baseline-heading">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 id="baseline-heading" className="flex items-center gap-2 text-lg font-semibold"><Target size={18} className="text-primary" />{t("Baseline assessment")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("Calibrate the starting point so the plan does not reteach what you already know.")}</p></div>{assessment.status === "completed" && <span className="rounded-full bg-success-muted px-3 py-1 text-sm text-success">{t("Completed · {{percent}}%", { percent: Math.round((assessment.score ?? 0) * 100) })}</span>}</div>
        <div className="mt-4 space-y-4">
          {assessment.questions.map((question) => (
            <fieldset key={question.id} className="rounded-xl border border-border p-4">
              <legend className="px-1 font-medium">{question.title}</legend>
              <p className="mb-3 text-sm text-muted-foreground">{question.prompt}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {question.choices.map((choice, index) => <label key={choice} className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${responses[question.id] === index ? "border-primary bg-primary-muted text-foreground" : "border-border"}`}><input type="radio" name={question.id} value={index} checked={responses[question.id] === index} onChange={() => setResponses({ ...responses, [question.id]: index })} />{choice}</label>)}
              </div>
            </fieldset>
          ))}
        </div>
        <Button className="mt-4" loading={savingAssessment} onClick={() => void submitAssessment()}>{assessment.status === "completed" ? t("Recalibrate baseline") : t("Save baseline and build map")}</Button>
      </section>

      <section className="mt-6" aria-labelledby="knowledge-map-heading">
        <div className="mb-3"><h2 id="knowledge-map-heading" className="flex items-center gap-2 text-lg font-semibold"><BookOpenCheck size={18} className="text-primary" />{t("Knowledge map")}</h2><p className="mt-1 text-sm text-muted-foreground">{t("Your route from foundations to independent transfer.")}</p></div>
        <ol className="grid gap-3 md:grid-cols-2">
          {project.knowledge_map.map((node, index) => <li key={node.id} className={`surface p-4 ${node.status === "locked" ? "opacity-60" : ""}`}><div className="flex items-start gap-3"><span className="mt-0.5 text-primary">{nodeIcon(node)}</span><div className="min-w-0"><p className="text-xs text-muted-foreground">{t("Stage {{number}}", { number: index + 1 })}</p><h3 className="mt-0.5 font-semibold">{node.title}</h3><p className="mt-1 text-sm text-muted-foreground">{node.description}</p><div className="mt-3 flex items-center gap-2"><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.round(node.mastery * 100)}%` }} /></div><span className="text-xs text-muted-foreground">{Math.round(node.mastery * 100)}%</span></div></div></div></li>)}
        </ol>
      </section>

      <section id="review-queue" className="mt-6 scroll-mt-6" aria-labelledby="review-queue-heading">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="review-queue-heading" className="flex items-center gap-2 text-lg font-semibold"><RotateCcw size={18} className="text-primary" />{t("Spaced review queue")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("Quiz mistakes return here until repeated evidence shows that they are stable.")}</p>
          </div>
          <Link href={`/question-notebook?project_id=${encodeURIComponent(project.id)}&filter=due`} className="text-sm font-medium text-primary hover:underline">{t("Open due questions")}</Link>
        </div>
        {dueReviews.length === 0 ? (
          <div className="surface p-5 text-sm text-muted-foreground">{t("No project reviews are due. New quiz evidence will appear here automatically.")}</div>
        ) : (
          <ol className="grid gap-3 md:grid-cols-2">
            {visibleDueReviews.map((item) => (
                <li key={item.id} className="surface p-4">
                  <p className="text-xs text-muted-foreground">{item.knowledge_point || t("Review from quiz")}</p>
                  <h3 className="mt-1 font-medium">{item.title}</h3>
                  <div className="mt-2 rounded-lg bg-warning-muted px-3 py-2 text-xs">
                    <span className="font-semibold text-warning">{{
                      concept: t("Concept not mastered"),
                      prerequisite: t("Prerequisite knowledge missing"),
                      calculation: t("Calculation error"),
                      misunderstanding: t("Understanding mismatch"),
                      question_reading: t("Question-reading error"),
                      expression: t("Incomplete expression"),
                      guessing: t("Guessing"),
                      unknown: t("Needs more evidence"),
                    }[item.mistake_category]}</span>
                    {item.diagnostic_reason && <p className="mt-1 text-muted-foreground">{item.diagnostic_reason}</p>}
                    <p className="mt-1 text-muted-foreground">
                      {t("Diagnostic confidence: {{confidence}}% · {{count}} evidence item(s)", {
                        confidence: Math.round((item.diagnostic_confidence || 0) * 100),
                        count: item.diagnostic_evidence_count || 0,
                      })}
                    </p>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{t("{{count}} attempts · current streak {{streak}}", { count: item.attempt_count, streak: item.correct_streak })}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button size="sm" loading={savingReviewId === item.id} onClick={() => void completeReview(item.id, true)}><CheckCircle2 size={14} />{t("I recalled it correctly")}</Button>
                    <Button size="sm" variant="outline" disabled={Boolean(savingReviewId)} onClick={() => void completeReview(item.id, false)}>{t("I still need practice")}</Button>
                  </div>
                </li>
              ))}
          </ol>
        )}
        {dueReviews.length > visibleDueReviews.length && <p className="mt-3 text-xs text-muted-foreground">{t("{{count}} more reviews are held for another day by your daily limit.", { count: dueReviews.length - visibleDueReviews.length })}</p>}
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        <div><h2 className="mb-3 text-lg font-semibold">{t("Weekly plan")}</h2><ol className="surface divide-y divide-border px-4">{project.weekly_plan.map((item, index) => <li key={`${index}-${item}`} className="flex gap-3 py-3 text-sm"><span className="text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><span>{item}</span></li>)}</ol></div>
        <div><h2 className="mb-3 text-lg font-semibold">{t("Learning evidence")}</h2><ol className="surface divide-y divide-border px-4">{[...project.events].sort((a, b) => b.created_at - a.created_at).slice(0, 8).map((event) => <li key={event.id} className="flex gap-3 py-3"><Clock3 size={15} className="mt-0.5 shrink-0 text-muted-foreground" /><div className="min-w-0"><p className="truncate text-sm font-medium">{event.title}</p><p className="text-xs text-muted-foreground">{event.description || t("Learning plan updated")}</p></div></li>)}</ol></div>
      </section>
    </div>
  );
}
