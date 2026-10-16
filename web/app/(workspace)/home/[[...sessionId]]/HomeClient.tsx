"use client";

/**
 * Chat home — the core conversation screen. Empty state shows the serif
 * greeting, the composer, and capability quick-start chips; once the
 * session has messages it becomes the transcript + sticky composer.
 *
 * Session loading is URL-driven, mirroring the previous frontend's wiring
 * order: initial mount reads the param → param changes reload → a freshly
 * assigned server session id is written back to the URL → the app shell is
 * told which session is active.
 */

import * as React from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  BarChart3,
  BrainCircuit,
  CircleAlert,
  Microscope,
  PenLine,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAppShell } from "@/context/AppShellContext";
import { useUnifiedChat } from "@/context/UnifiedChatContext";
import { Skeleton, Spinner } from "@/components/ui";
import { ChatComposer } from "@/components/chat/ChatComposer";
import { ChatMessages } from "@/components/chat/ChatMessages";
import { LearningFocusCard } from "@/components/learning/LearningFocusCard";
import { LearningJourneyIntro } from "@/components/learning/LearningJourneyIntro";
import { LearningLoopProgress } from "@/components/learning/LearningLoopProgress";
import { LearningProjectOnboarding } from "@/components/learning/LearningProjectOnboarding";
import SessionActivityPanel from "@/components/chat/SessionActivityPanel";
import { buildSessionActivity } from "@/lib/session-activity";
import { getNotebookEntry } from "@/lib/notebook-api";
import { buildSimilarQuestionConfig } from "@/lib/quiz-types";
import {
  fetchLearningDashboard,
  learningTaskLaunchHref,
  startLearningTask,
  type LearningDashboard,
  type LearningNextAction,
} from "@/lib/learning-project-api";
import { shouldPromoteDraftSessionToUrl } from "@/lib/chat-route";

interface QuickChip {
  icon: LucideIcon;
  labelKey: string;
  capability: string;
  prefillKey: string;
}

const QUICK_CHIPS: QuickChip[] = [
  {
    icon: BrainCircuit,
    labelKey: "Deep solve",
    capability: "deep_solve",
    prefillKey: "Solve this step by step: ",
  },
  {
    icon: Microscope,
    labelKey: "Research",
    capability: "deep_research",
    prefillKey: "Research this topic: ",
  },
  {
    icon: BarChart3,
    labelKey: "Visualize",
    capability: "visualize",
    prefillKey: "Visualize: ",
  },
  {
    icon: PenLine,
    labelKey: "Practice questions",
    capability: "deep_question",
    prefillKey: "Create practice questions about ",
  },
];

const OPEN_ACTIVITY_EVENT = "dt:open-session-activity";

function LearningToday({ initialDashboard }: { initialDashboard: LearningDashboard | null }) {
  const { t } = useTranslation();
  const router = useRouter();
  const [dashboard, setDashboard] = React.useState<LearningDashboard | null>(
    initialDashboard,
  );
  const [dashboardError, setDashboardError] = React.useState(false);
  const [onboardingOpen, setOnboardingOpen] = React.useState(false);
  const [actionBusy, setActionBusy] = React.useState(false);
  const load = React.useCallback(() => {
    let cancelled = false;
    void fetchLearningDashboard()
      .then((value) => { if (!cancelled) { setDashboard(value); setDashboardError(false); } })
      .catch(() => { if (!cancelled) setDashboardError(true); });
    return () => { cancelled = true; };
  }, []);
  React.useEffect(() => {
    // Paint the server snapshot immediately, then revalidate after hydration.
    // Conditional private HTTP caching makes unchanged repeat loads a 304.
    return load();
  }, [load]);

  const resolvedNextAction: LearningNextAction | null = dashboard?.next_action
    ?? (dashboard?.continue_task
      ? {
          kind: dashboard.continue_task.intent === "assessment" ? "baseline" : "continue",
          project_id: dashboard.continue_task.project_id,
          title: dashboard.continue_task.objective,
          reason: t("Continue with the highest-priority task in your plan."),
          expected_minutes: dashboard.continue_task.expected_minutes,
          task: dashboard.continue_task,
        }
      : dashboard?.active_projects === 0
        ? {
            kind: "create_plan",
            title: t("Create your first learning plan"),
            reason: t("Set a goal so Cognivoy can build your first task."),
            expected_minutes: 3,
            task: null,
          }
        : null);

  const followNextAction = async () => {
    const action = resolvedNextAction;
    if (!action || action.kind === "create_plan") {
      setOnboardingOpen(true);
      return;
    }
    if (!action.project_id) return;
    if (action.kind === "review") {
      router.push(`/space/learning/${encodeURIComponent(action.project_id)}#review-queue`);
      return;
    }
    if (action.kind === "baseline") {
      router.push(`/space/learning/${encodeURIComponent(action.project_id)}#baseline-assessment`);
      return;
    }
    if (!action.task || action.kind === "completed" || action.kind === "plan") {
      router.push(`/space/learning/${encodeURIComponent(action.project_id)}`);
      return;
    }
    setActionBusy(true);
    try {
      await startLearningTask(action.task);
    } catch {
      // The task remains safe to resume if another surface started it first.
    } finally {
      setActionBusy(false);
    }
    router.push(learningTaskLaunchHref(action.task));
  };

  const primaryProject = dashboard?.primary_project ?? dashboard?.recent_projects?.[0];

  if (!dashboard && !dashboardError) {
    return (
      <section
        className="w-full max-w-5xl"
        aria-label={t("Loading today’s learning")}
        aria-busy="true"
      >
        <Skeleton className="h-72 w-full rounded-xl" />
      </section>
    );
  }
  if (!dashboard) {
    return (
      <button type="button" onClick={() => load()} className="surface flex w-full max-w-5xl items-center gap-3 p-4 text-left hover:border-input">
        <CircleAlert size={18} className="text-destructive" />
        <span className="text-sm">{t("Learning tasks could not be loaded. Retry")}</span>
      </button>
    );
  }
  return (
    <>
      {dashboard.active_projects === 0 ? (
        <LearningJourneyIntro onCreate={() => setOnboardingOpen(true)} />
      ) : primaryProject && resolvedNextAction ? (
        <LearningFocusCard
          project={primaryProject}
          action={resolvedNextAction}
          busy={actionBusy}
          onAction={() => void followNextAction()}
        />
      ) : null}
      {primaryProject && (
        <div className="w-full max-w-5xl">
          <LearningLoopProgress
            compact
            projectTitle={primaryProject.title}
            projectHref={`/space/learning/${encodeURIComponent(primaryProject.id)}`}
            planPercent={(primaryProject.learning_status?.progress.completion_rate ?? 0) * 100}
            completedTasks={primaryProject.learning_status?.progress.completed_tasks ?? 0}
            masteryPercent={(primaryProject.learning_status?.mastery ?? primaryProject.mastery_summary) * 100}
            practiceCount={primaryProject.analytics?.quiz_attempts ?? 0}
            dueReviews={primaryProject.learning_status?.due_reviews ?? primaryProject.due_review_count}
            weakPointCount={primaryProject.learning_status?.weak_point_count ?? primaryProject.weak_points.length}
          />
        </div>
      )}
      <LearningProjectOnboarding
        open={onboardingOpen}
        onClose={() => setOnboardingOpen(false)}
        onCreated={(project) => {
          load();
          router.push(`/space/learning/${encodeURIComponent(project.id)}#baseline-assessment`);
        }}
      />
    </>
  );
}

function openSessionActivity() {
  window.dispatchEvent(new Event(OPEN_ACTIVITY_EVENT));
}

function ActivityPanelHost({
  activity,
}: {
  activity: ReturnType<typeof buildSessionActivity>;
}) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_ACTIVITY_EVENT, show);
    return () => {
      window.removeEventListener(OPEN_ACTIVITY_EVENT, show);
    };
  }, []);
  return open ? (
    <SessionActivityPanel
      activity={activity}
      open
      onClose={() => setOpen(false)}
    />
  ) : null;
}

function TranscriptHost({
  onOpenActivity,
  activityCount,
}: {
  onOpenActivity: () => void;
  activityCount: number;
}) {
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  return ready ? (
    <ChatMessages
      onOpenActivity={onOpenActivity}
      activityCount={activityCount}
    />
  ) : (
    <div className="min-h-0 flex-1" aria-hidden="true" />
  );
}

export default function ChatHomePage({
  initialDashboard,
}: {
  initialDashboard: LearningDashboard | null;
}) {
  const params = useParams<{ sessionId?: string[] }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useTranslation();
  const sessionIdParam = params.sessionId?.[0] ?? null;
  const { setActiveSessionId } = useAppShell();

  const {
    state,
    setCapability,
    newSession,
    loadSession,
    showCachedSession,
    sendMessage,
  } = useUnifiedChat();

  const [sessionLoading, setSessionLoading] = React.useState(false);
  const loadAbortRef = React.useRef<AbortController | null>(null);
  const initialLoadRef = React.useRef(false);
  const similarPracticeRef = React.useRef<number | null>(null);

  // Bridge: ChatComposer registers its prefill function here so the
  // quick-start chips can drop starter text into the textarea.
  const prefillRef = React.useRef<((text: string) => void) | null>(null);
  const pendingLearningPrefillRef = React.useRef<string | null>(null);
  const registerPrefill = React.useCallback((fn: (text: string) => void) => {
    prefillRef.current = fn;
    if (pendingLearningPrefillRef.current) {
      fn(pendingLearningPrefillRef.current);
      pendingLearningPrefillRef.current = null;
    }
  }, []);

  const learningTaskPrefilledRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const taskId = searchParams.get("learning_task");
    const objective = searchParams.get("objective")?.trim();
    if (!taskId || !objective || learningTaskPrefilledRef.current === taskId) return;
    learningTaskPrefilledRef.current = taskId;
    setCapability("mastery_path");
    const prompt = t("Guide me through this learning task: {{objective}}", { objective });
    if (prefillRef.current) prefillRef.current(prompt);
    else pendingLearningPrefillRef.current = prompt;
  }, [searchParams, setCapability, t]);

  const quickStartPrefilledRef = React.useRef("");
  React.useEffect(() => {
    if (sessionIdParam) return;
    const requestedCapability = searchParams.get("quick_start")?.trim() ?? "";
    if (!requestedCapability || quickStartPrefilledRef.current === requestedCapability) return;
    const chip = QUICK_CHIPS.find((item) => item.capability === requestedCapability);
    if (!chip) return;
    quickStartPrefilledRef.current = requestedCapability;
    setCapability(chip.capability);
    const prompt = t(chip.prefillKey);
    if (prefillRef.current) prefillRef.current(prompt);
    else pendingLearningPrefillRef.current = prompt;
  }, [searchParams, sessionIdParam, setCapability, t]);

  const navigateToHome = React.useCallback(() => {
    router.replace("/home", { scroll: false });
  }, [router]);

  /** Kick off a session load; paints the cached copy instantly when we
   *  already hold it and revalidates in the background. */
  const startSessionLoad = React.useCallback(
    (sid: string) => {
      loadAbortRef.current?.abort();
      const ctrl = new AbortController();
      loadAbortRef.current = ctrl;
      const cached = showCachedSession(sid);
      setSessionLoading(!cached);

      void loadSession(sid, { signal: ctrl.signal, revalidate: cached })
        .then(() => {
          if (!ctrl.signal.aborted) {
            loadAbortRef.current = null;
            setSessionLoading(false);
          }
        })
        .catch(() => {
          if (!ctrl.signal.aborted) {
            loadAbortRef.current = null;
            setSessionLoading(false);
            // A failed background refresh leaves the cached copy on screen;
            // only a cold open has nothing to fall back to.
            if (!cached) navigateToHome();
          }
        });
    },
    [loadSession, navigateToHome, showCachedSession],
  );

  // Initial mount — load the session from the URL. The ref flag survives
  // Strict Mode's double-mount; cleanup resets it so the remount restarts
  // cleanly.
  React.useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    if (sessionIdParam) {
      // URL state is the external source this effect synchronizes into chat state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      startSessionLoad(sessionIdParam);
    } else {
      newSession();
    }
    return () => {
      initialLoadRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    const entryId = Number(searchParams.get("practice_similar"));
    if (
      sessionIdParam ||
      !Number.isInteger(entryId) ||
      entryId <= 0 ||
      similarPracticeRef.current === entryId
    ) {
      return;
    }
    similarPracticeRef.current = entryId;
    void getNotebookEntry(entryId)
      .then((entry) => {
        if (
          window.location.pathname !== "/home" ||
          new URLSearchParams(window.location.search).get("practice_similar") !== String(entryId)
        ) {
          similarPracticeRef.current = null;
          return;
        }
        const config = buildSimilarQuestionConfig(entry);
        const topic = entry.knowledge_points[0] || entry.question;
        const content = t("Generate a similar question about {{topic}}", { topic });
        setCapability("deep_question");
        sendMessage(content, [], config, undefined, undefined, {
          requestSnapshotOverride: {
            content,
            capability: "deep_question",
            enabledTools: state.enabledTools,
            knowledgeBases: state.knowledgeBases,
            language: state.language,
            persona: state.personaSelection,
            ...(entry.learning_project_id
              ? {
                  learningContext: {
                    project_id: entry.learning_project_id,
                    task_id: entry.learning_task_id || "practice",
                    objective: topic,
                  },
                }
              : {}),
          },
        });
        router.replace("/home", { scroll: false });
      })
      .catch(() => {
        similarPracticeRef.current = null;
      });
  }, [router, searchParams, sendMessage, sessionIdParam, setCapability, state.enabledTools, state.knowledgeBases, state.language, state.personaSelection, t]);

  // URL param changed (sidebar navigation) — load the matching session.
  const prevSessionIdParam = React.useRef(sessionIdParam);
  React.useEffect(() => {
    if (sessionIdParam === prevSessionIdParam.current) return;
    prevSessionIdParam.current = sessionIdParam;
    loadAbortRef.current?.abort();
    loadAbortRef.current = null;
    if (sessionIdParam) {
      if (sessionIdParam === state.sessionId) {
        // The matching route confirms that the external session load is complete.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSessionLoading(false);
        return;
      }
      startSessionLoad(sessionIdParam);
    } else {
      newSession();
      setSessionLoading(false);
    }
  }, [sessionIdParam, startSessionLoad, newSession, state.sessionId]);

  // Server assigned a session id to a fresh chat — write it into the URL.
  // Track the prior context id so navigating `/home/:id` → `/home` cannot
  // bounce back during the one render before `newSession()` clears state.
  const previousStateSessionIdRef = React.useRef(state.sessionId);
  React.useEffect(() => {
    const previousStateSessionId = previousStateSessionIdRef.current;
    previousStateSessionIdRef.current = state.sessionId;
    if (
      shouldPromoteDraftSessionToUrl(
        state.sessionId,
        sessionIdParam,
        previousStateSessionId,
      )
    ) {
      router.replace(`/home/${state.sessionId}`, { scroll: false });
    }
  }, [state.sessionId, sessionIdParam, router]);

  React.useEffect(() => {
    setActiveSessionId(state.sessionId || sessionIdParam || null);
  }, [state.sessionId, sessionIdParam, setActiveSessionId]);

  const hasMessages = state.messages.length > 0;
  // Activity is secondary UI. Deferring this O(messages + events) fold keeps
  // composer input and streamed answer painting on the urgent render lane.
  const activityMessages = React.useDeferredValue(state.messages);
  const activity = React.useMemo(
    () => buildSessionActivity(activityMessages),
    [activityMessages],
  );
  const activityCount =
    activity.tools.length +
    activity.knowledgeBases.length +
    activity.attachments.length +
    activity.artifacts.length +
    activity.space.historySessionIds.length +
    activity.space.bookIds.length +
    activity.space.notebookIds.length +
    activity.space.questionEntryIds.length +
    activity.space.personas.length +
    activity.space.memoryKinds.length;

  const handleQuickChip = (chip: QuickChip) => {
    setCapability(chip.capability);
    prefillRef.current?.(t(chip.prefillKey));
  };

  return (
    <div className="relative flex h-[calc(100dvh-3.5rem)] min-h-0 flex-1 flex-col md:h-dvh">
      {state.isStreaming && (
        <div
          className="absolute inset-x-0 top-0 z-10 h-px animate-pulse bg-primary"
          aria-hidden="true"
        />
      )}
      {sessionLoading ? (
        <>
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={20} className="text-muted-foreground" />
          </div>
          <ChatComposer registerPrefill={registerPrefill} />
        </>
      ) : hasMessages || state.isStreaming ? (
        <>
          <TranscriptHost
            key={state.sessionId || sessionIdParam || "new"}
            onOpenActivity={openSessionActivity}
            activityCount={activityCount}
          />
          <ChatComposer registerPrefill={registerPrefill} />
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8 md:py-10">
          <div
            className="mx-auto flex min-w-0 w-full max-w-5xl flex-col items-center gap-7"
            data-testid="home-empty-state"
          >
            <LearningToday initialDashboard={initialDashboard} />
            <h1 className="text-center text-3xl font-medium tracking-tight text-foreground">
              {t("How can I help you learn today?")}
            </h1>
            <div className="w-full max-w-4xl">
              <ChatComposer registerPrefill={registerPrefill} wide />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {QUICK_CHIPS.map((chip) => (
                <button
                  key={chip.capability}
                  type="button"
                  onClick={() => handleQuickChip(chip)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-[13px] text-muted-foreground shadow-hairline transition-colors duration-150 hover:border-primary-border hover:text-foreground"
                >
                  <chip.icon size={14} className="text-primary" />
                  {t(chip.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <ActivityPanelHost key={state.sessionId || sessionIdParam || "draft"} activity={activity} />
    </div>
  );
}
