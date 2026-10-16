"use client";

import { ArrowRight, BookOpen, CalendarCheck, PenLine, Target } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui";

interface LearningJourneyIntroProps {
  onCreate: () => void;
}

export function LearningJourneyIntro({ onCreate }: LearningJourneyIntroProps) {
  const { t } = useTranslation();

  const steps = [
    [Target, t("Set a goal"), t("Turn an outcome into a realistic weekly plan.")],
    [BookOpen, t("Learn with evidence"), t("Use your materials, a tutor, and focused tasks.")],
    [PenLine, t("Practice and diagnose"), t("Answers reveal mastery and weak points.")],
    [CalendarCheck, t("Review at the right time"), t("Cognivoy schedules what to revisit next.")],
  ] as const;

  return (
    <section className="surface relative w-full max-w-5xl overflow-hidden border-primary-border bg-primary-muted p-5" aria-labelledby="learning-journey-intro-heading" data-testid="learning-journey-intro">
      <div className="max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-wider text-foreground">{t("Start with a learning goal")}</p>
        <h2 id="learning-journey-intro-heading" className="display mt-1 text-xl font-semibold">{t("Build a learning loop, not just another chat")}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{t("Cognivoy connects every task, answer, and review to one goal so you always know what to do next.")}</p>
      </div>
      <ol className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map(([Icon, title, description], index) => (
          <li key={title} className="rounded-xl border border-primary-border bg-background p-3">
            <div className="flex items-center gap-2"><span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary-muted text-primary"><Icon size={14} aria-hidden="true" /></span><span className="text-xs text-muted-foreground">{index + 1}</span></div>
            <p className="mt-2 text-sm font-semibold">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          </li>
        ))}
      </ol>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button onClick={onCreate}>{t("Create my learning plan")}<ArrowRight size={15} /></Button>
        <span className="text-sm text-muted-foreground">{t("It takes about three minutes.")}</span>
      </div>
    </section>
  );
}
