"use client";

import * as React from "react";
import { AlarmClock, Play, RefreshCw, SkipForward, TimerReset, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  cancelProactiveReminder,
  actOnProactiveReminder,
  getProactiveReminders,
  type ProactiveReminderState,
} from "@/lib/partners-api";
import { Button, ConfirmDialog, EmptyState, Skeleton, useToast } from "@/components/ui";

function formatWhen(value: string | null | undefined, language: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat(language.startsWith("zh") ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function PartnerProactive({ partnerId }: { partnerId: string }) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [state, setState] = React.useState<ProactiveReminderState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [cancelling, setCancelling] = React.useState<string | null>(null);
  const [actionBusy, setActionBusy] = React.useState<string | null>(null);
  const [disableJob, setDisableJob] = React.useState<string | null>(null);
  const viewedJobs = React.useRef(new Set<string>());

  const recordViews = React.useCallback((next: ProactiveReminderState) => {
    for (const reminder of next.pending) {
      if (viewedJobs.current.has(reminder.id)) continue;
      viewedJobs.current.add(reminder.id);
      void actOnProactiveReminder(partnerId, reminder.id, "view").catch(() => {
        viewedJobs.current.delete(reminder.id);
      });
    }
  }, [partnerId]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const next = await getProactiveReminders(partnerId);
      setState(next);
      recordViews(next);
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t("Failed to load reminders"),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [partnerId, recordViews, t, toast]);

  React.useEffect(() => {
    let cancelled = false;
    void getProactiveReminders(partnerId)
      .then((next) => {
        if (!cancelled) {
          setState(next);
          recordViews(next);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          toast({
            title:
              error instanceof Error
                ? error.message
                : t("Failed to load reminders"),
            variant: "destructive",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [partnerId, recordViews, t, toast]);

  const cancel = async (jobId: string) => {
    setCancelling(jobId);
    try {
      await cancelProactiveReminder(partnerId, jobId);
      await load();
      toast({ title: t("Reminder cancelled"), variant: "success" });
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t("Cancel failed"),
        variant: "destructive",
      });
    } finally {
      setCancelling(null);
    }
  };

  const act = async (
    jobId: string,
    action: "start" | "later" | "skip" | "disable",
  ) => {
    setActionBusy(`${jobId}:${action}`);
    try {
      await actOnProactiveReminder(partnerId, jobId, action);
      await load();
      toast({ title: t("Reminder updated"), variant: "success" });
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t("Action failed"),
        variant: "destructive",
      });
    } finally {
      setActionBusy(null);
      setDisableJob(null);
    }
  };

  if (loading && !state) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const pending = state?.pending ?? [];
  const audit = [...(state?.audit ?? [])].reverse();
  const analytics = state?.analytics;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-lg font-medium text-foreground">
            {t("Proactive tutor")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("Review pending outreach and the complete scheduling audit trail.")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} loading={loading}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("Refresh")}
        </Button>
      </div>

      <section className="surface p-5">
        <h3 className="mb-3 text-sm font-medium text-foreground">
          {t("Pending reminders")} · {pending.length}
        </h3>
        {pending.length === 0 ? (
          <EmptyState
            icon={AlarmClock}
            title={t("No pending reminders")}
            description={t("Eligible learning events will appear here before delivery.")}
            className="min-h-40"
          />
        ) : (
          <div className="space-y-2">
            {pending.map((item) => (
              <article key={item.id} className="rounded-lg border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {formatWhen(item.scheduled_for, i18n.language)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("Channel")}: {item.channel || t("Automatic")} · {t("Merged events")}: {item.merged_events}
                    </p>
                    {(item.attempt_count ?? 0) > 0 && (
                      <p className="mt-1 text-xs text-warning">
                        {t("Delivery attempt {{current}} of {{max}}", {
                          current: item.attempt_count,
                          max: item.max_attempts,
                        })}
                        {item.last_error ? ` · ${item.last_error}` : ""}
                      </p>
                    )}
                    <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-foreground">
                      {item.message}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      loading={actionBusy === `${item.id}:start`}
                      onClick={() => void act(item.id, "start")}
                    >
                      <Play className="h-3.5 w-3.5" />
                      {t("Start now")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      loading={actionBusy === `${item.id}:later`}
                      onClick={() => void act(item.id, "later")}
                    >
                      <TimerReset className="h-3.5 w-3.5" />
                      {t("Later")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={actionBusy === `${item.id}:skip`}
                      onClick={() => void act(item.id, "skip")}
                    >
                      <SkipForward className="h-3.5 w-3.5" />
                      {t("Skip")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={cancelling === item.id}
                      onClick={() => void cancel(item.id)}
                      aria-label={t("Cancel reminder")}
                      title={t("Cancel reminder")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setDisableJob(item.id)}
                    >
                      {t("Disable reminders")}
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {analytics && (
        <section className="surface p-5" aria-labelledby="reminder-effectiveness-heading" data-testid="reminder-effectiveness">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 id="reminder-effectiveness-heading" className="text-sm font-medium text-foreground">{t("Reminder effectiveness")}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{t("Based on learner actions in the reminder audit, without inferring intent from message content.")}</p>
            </div>
            <span className="text-xs text-muted-foreground">{t("{{percent}}% started", { percent: Math.round(analytics.engagement_rate * 100) })}</span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              [t("Viewed"), analytics.viewed],
              [t("Started"), analytics.started],
              [t("Snoozed"), analytics.snoozed],
              [t("Skipped"), analytics.skipped],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-muted-subtle p-3">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-xl font-semibold text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="surface p-5">
        <h3 className="mb-3 text-sm font-medium text-foreground">{t("Reminder audit")}</h3>
        {audit.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("No scheduling decisions yet.")}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {audit.map((item, index) => (
              <div key={`${item.at}-${item.job_id ?? index}`} className="grid gap-1 py-3 sm:grid-cols-[10rem_8rem_1fr] sm:gap-3">
                <span className="text-xs text-muted-foreground">
                  {formatWhen(item.at, i18n.language)}
                </span>
                <span className="text-xs font-medium text-foreground">
                  {t(item.decision)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {item.reason ? t(item.reason) : item.error || item.channel || "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
      <ConfirmDialog
        open={disableJob !== null}
        onClose={() => setDisableJob(null)}
        onConfirm={() => disableJob && void act(disableJob, "disable")}
        title={t("Disable proactive reminders?")}
        description={t("This cancels all pending reminders for this partner. You can enable them again in Config.")}
        confirmText={t("Disable")}
        cancelText={t("Cancel")}
        destructive
        loading={Boolean(disableJob && actionBusy === `${disableJob}:disable`)}
      />
    </div>
  );
}
