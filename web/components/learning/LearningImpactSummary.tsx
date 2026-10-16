"use client";

import * as React from "react";
import { BarChart3, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, Skeleton, useToast } from "@/components/ui";
import {
  fetchLearningExperimentConsent,
  fetchLearningPortfolioMetrics,
  updateLearningExperimentConsent,
  type LearningExperimentConsent,
  type LearningPortfolioMetrics,
} from "@/lib/learning-project-api";

export function LearningImpactSummary() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [metrics, setMetrics] = React.useState<LearningPortfolioMetrics | null>(null);
  const [consent, setConsent] = React.useState<LearningExperimentConsent | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [savingConsent, setSavingConsent] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [nextMetrics, nextConsent] = await Promise.all([
        fetchLearningPortfolioMetrics(),
        fetchLearningExperimentConsent(),
      ]);
      setMetrics(nextMetrics);
      setConsent(nextConsent);
    } catch (error) {
      toast({
        title: t("Failed to load learning impact metrics."),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [t, toast]);

  React.useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchLearningPortfolioMetrics(),
      fetchLearningExperimentConsent(),
    ]).then(([nextMetrics, nextConsent]) => {
      if (cancelled) return;
      setMetrics(nextMetrics);
      setConsent(nextConsent);
    }).catch((error) => {
      if (cancelled) return;
      toast({
        title: t("Failed to load learning impact metrics."),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [t, toast]);

  const toggleConsent = async () => {
    if (!consent || savingConsent) return;
    setSavingConsent(true);
    try {
      const updated = await updateLearningExperimentConsent(!consent.consent);
      setConsent(updated);
      toast({
        title: updated.consent
          ? t("Learning improvement participation enabled.")
          : t("Learning improvement participation disabled."),
        variant: "success",
      });
    } catch (error) {
      toast({
        title: t("Failed to update experiment preferences."),
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setSavingConsent(false);
    }
  };

  if (loading) return <Skeleton className="mt-4 h-44 w-full" />;
  if (!metrics || !consent) return null;

  const items = [
    [t("First learning sessions"), metrics.first_learning_completed],
    [t("Tasks completed"), metrics.completed_tasks],
    [t("Knowledge points mastered"), metrics.mastered_knowledge_points],
    [t("Active days · 30d"), metrics.active_days_30],
  ] as const;

  return (
    <section className="surface mt-4 p-4" aria-labelledby="learning-impact-heading" data-testid="learning-impact-summary">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="learning-impact-heading" className="flex items-center gap-2 font-semibold">
            <BarChart3 size={16} className="text-primary" aria-hidden="true" />
            {t("Learning impact")}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("Calculated from local learning evidence. Message content is not inspected or sent elsewhere.")}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()}>{t("Refresh")}</Button>
      </div>
      <dl className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-border bg-background p-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-xl font-semibold text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted-subtle p-3">
        <ShieldCheck size={18} className="text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t("Optional learning improvement program")}</p>
          <p className="text-xs text-muted-foreground">
            {t("No experiment changes your learning experience until you opt in. Participation can be withdrawn at any time; raw messages and documents are never shared.")}
          </p>
        </div>
        <Button
          variant={consent.consent ? "outline" : "primary"}
          size="sm"
          loading={savingConsent}
          onClick={() => void toggleConsent()}
          aria-pressed={consent.consent}
        >
          {consent.consent ? t("Withdraw consent") : t("Allow participation")}
        </Button>
      </div>
    </section>
  );
}
