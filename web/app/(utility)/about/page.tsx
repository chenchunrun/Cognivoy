"use client";

import Link from "next/link";
import {
  Compass,
  Layers3,
  Route,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/shell/PageHeader";

export default function AboutPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8 sm:py-10">
      <PageHeader
        title={t("About Cognivoy")}
        description={t(
          "Our product positioning, learning philosophy, and the principles behind an agent-native companion.",
        )}
      />

      <section
        className="overflow-hidden rounded-xl border border-primary-border bg-primary-muted p-6 shadow-hairline sm:p-9"
        aria-labelledby="about-positioning-title"
      >
        <div className="max-w-3xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary-border bg-card px-3 py-1 text-xs font-medium text-primary">
            <Sparkles size={13} aria-hidden="true" />
            {t("个人智能学习伙伴")}
          </div>
          <h2
            id="about-positioning-title"
            className="display mt-5 text-3xl font-semibold leading-tight tracking-tight text-foreground sm:text-4xl"
          >
            {t("Learning is a journey. Your AI should travel with you.")}
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
            {t(
              "Cognivoy is a personal intelligent learning companion that turns goals, trusted knowledge, deliberate practice, feedback, and memory into one continuous learning journey.",
            )}
          </p>
          <p className="mt-6 display text-lg font-medium italic text-foreground">
            {t("Your agent-native learning journey.")}
          </p>
        </div>
      </section>

      <section className="mt-10" aria-labelledby="about-beliefs-title">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            {t("What we believe")}
          </p>
          <h2
            id="about-beliefs-title"
            className="display mt-2 text-2xl font-semibold text-foreground"
          >
            {t("Built for learning, not just answering")}
          </h2>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <article className="surface p-5">
            <Compass className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 className="display mt-4 text-base font-semibold text-foreground">
              {t("Companion over answer machine")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t(
                "We help learners understand, practice, reflect, and progress instead of merely producing a final answer.",
              )}
            </p>
          </article>

          <article className="surface p-5">
            <Route className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 className="display mt-4 text-base font-semibold text-foreground">
              {t("Journey over isolated prompts")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t(
                "Each conversation can build on goals, learning history, knowledge sources, and what should happen next.",
              )}
            </p>
          </article>

          <article className="surface p-5">
            <ShieldCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 className="display mt-4 text-base font-semibold text-foreground">
              {t("Evidence over illusion")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t(
                "Knowledge grounding, citations, visible progress, and recoverable actions make the learning process inspectable.",
              )}
            </p>
          </article>

          <article className="surface p-5">
            <UserRoundCheck className="h-5 w-5 text-primary" aria-hidden="true" />
            <h3 className="display mt-4 text-base font-semibold text-foreground">
              {t("Learner agency over automation")}
            </h3>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {t(
                "The learner chooses the destination. Cognivoy proposes, explains, remembers with consent, and keeps important actions under human control.",
              )}
            </p>
          </article>
        </div>
      </section>

      <section
        className="mt-10 grid gap-6 rounded-xl border border-border bg-muted-subtle p-6 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] sm:p-8"
        aria-labelledby="about-agent-native-title"
      >
        <div>
          <Layers3 className="h-6 w-6 text-primary" aria-hidden="true" />
          <h2
            id="about-agent-native-title"
            className="display mt-4 text-2xl font-semibold text-foreground"
          >
            {t("What agent-native means")}
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {t(
              "Cognivoy does not force every learning need through one chat pattern. It composes the right capabilities, tools, context, and checkpoints for the learner's intent.",
            )}
          </p>
        </div>

        <ol className="space-y-3">
          {[
            {
              number: "01",
              title: t("Understand the learning intent"),
              body: t("Clarify the goal, current level, constraints, and desired outcome."),
            },
            {
              number: "02",
              title: t("Compose the right learning process"),
              body: t("Bring together conversation, research, solving, visualization, practice, and trusted sources as needed."),
            },
            {
              number: "03",
              title: t("Preserve continuity and ownership"),
              body: t("Carry forward useful context and progress while keeping decisions, data, and recovery visible to the learner."),
            },
          ].map((step) => (
            <li key={step.number} className="surface flex gap-4 p-4">
              <span className="font-mono text-xs font-semibold text-primary">
                {step.number}
              </span>
              <div>
                <h3 className="text-sm font-semibold text-foreground">{step.title}</h3>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <aside className="mt-10 border-t border-border pt-6 text-sm leading-6 text-muted-foreground">
        <p>
          {t(
            "Cognivoy is an independent derivative of the open-source DeepTutor project. It is not affiliated with, sponsored by, or endorsed by HKUDS, the Data Intelligence Lab, or The University of Hong Kong.",
          )}{" "}
          <Link
            href="https://github.com/HKUDS/DeepTutor"
            target="_blank"
            rel="noreferrer"
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {t("View the upstream project")}
          </Link>
        </p>
      </aside>
    </div>
  );
}
