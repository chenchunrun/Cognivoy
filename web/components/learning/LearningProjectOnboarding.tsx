"use client";

import * as React from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui";
import {
  createLearningProject,
  type LearningProject,
  type LearningProjectDraft,
} from "@/lib/learning-project-api";

const DEFAULT_DRAFT: LearningProjectDraft = {
  title: "",
  motivation: "",
  current_level: "beginner",
  target_level: "practical",
  existing_materials: "",
  weekly_minutes: 180,
  preferred_methods: ["guided"],
};

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (project: LearningProject) => void;
}

export function LearningProjectOnboarding({ open, onClose, onCreated }: Props) {
  const { t, i18n } = useTranslation();
  const [step, setStep] = React.useState(0);
  const [draft, setDraft] = React.useState(DEFAULT_DRAFT);
  const [deadline, setDeadline] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState("");
  const keyRef = React.useRef(crypto.randomUUID());

  const closeDialog = () => {
    setStep(0);
    setError("");
    onClose();
  };

  if (!open) return null;

  const toggleMethod = (method: string) => {
    setDraft((current) => ({
      ...current,
      preferred_methods: current.preferred_methods.includes(method)
        ? current.preferred_methods.filter((item) => item !== method)
        : [...current.preferred_methods, method],
    }));
  };

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const project = await createLearningProject(
        {
          ...draft,
          language: i18n.language.toLowerCase().startsWith("zh") ? "zh" : "en",
          deadline: deadline ? new Date(`${deadline}T23:59:59`).getTime() / 1000 : null,
        },
        keyRef.current,
      );
      onCreated(project);
      closeDialog();
      setDraft(DEFAULT_DRAFT);
      setDeadline("");
      keyRef.current = crypto.randomUUID();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("The learning plan could not be created."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4" role="dialog" aria-modal="true" aria-labelledby="learning-project-title">
      <div className="surface w-full max-w-xl bg-card p-6 shadow-overlay">
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-primary">{t("Step {{current}} of {{total}}", { current: step + 1, total: 3 })}</p>
            <h2 id="learning-project-title" className="mt-1 text-xl font-semibold">{t("Create a learning plan")}</h2>
          </div>
          <button type="button" onClick={closeDialog} className="rounded-md p-1 text-muted-foreground hover:bg-muted" aria-label={t("Close")}><X size={18} /></button>
        </div>

        {step === 0 ? (
          <div className="space-y-4">
            <label className="block text-sm font-medium">{t("What do you want to learn?")}<input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} className="mt-1.5 w-full rounded-xl border border-input bg-background px-3 py-2.5 font-normal" placeholder={t("For example: linear algebra or RAG development")} /></label>
            <label className="block text-sm font-medium">{t("Why is this goal important to you?")}<textarea value={draft.motivation} onChange={(event) => setDraft({ ...draft, motivation: event.target.value })} className="mt-1.5 min-h-24 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 font-normal" /></label>
          </div>
        ) : step === 1 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-medium">{t("Current level")}<select value={draft.current_level} onChange={(event) => setDraft({ ...draft, current_level: event.target.value })} className="mt-1.5 w-full rounded-xl border border-input bg-background px-3 py-2.5 font-normal"><option value="beginner">{t("Beginner")}</option><option value="intermediate">{t("Intermediate")}</option><option value="advanced">{t("Advanced")}</option></select></label>
            <label className="text-sm font-medium">{t("Target level")}<select value={draft.target_level} onChange={(event) => setDraft({ ...draft, target_level: event.target.value })} className="mt-1.5 w-full rounded-xl border border-input bg-background px-3 py-2.5 font-normal"><option value="overview">{t("Understand the basics")}</option><option value="practical">{t("Apply it independently")}</option><option value="mastery">{t("Master and teach it")}</option></select></label>
            <label className="text-sm font-medium sm:col-span-2">{t("Target completion date")}<input type="date" value={deadline} onChange={(event) => setDeadline(event.target.value)} className="mt-1.5 w-full rounded-xl border border-input bg-background px-3 py-2.5 font-normal" /><span className="mt-1 block text-xs font-normal text-muted-foreground">{t("Optional. Cognivoy uses it to keep the weekly plan realistic.")}</span></label>
            <label className="text-sm font-medium sm:col-span-2">{t("Weekly study time")}<input type="range" min="30" max="900" step="30" value={draft.weekly_minutes} onChange={(event) => setDraft({ ...draft, weekly_minutes: Number(event.target.value) })} className="mt-2 w-full accent-primary" /><span className="mt-1 block font-normal text-muted-foreground">{t("{{hours}} hours per week", { hours: (draft.weekly_minutes / 60).toFixed(1) })}</span></label>
          </div>
        ) : (
          <div className="space-y-5">
            <label className="block text-sm font-medium">{t("Do you already have materials?")}<textarea value={draft.existing_materials} onChange={(event) => setDraft({ ...draft, existing_materials: event.target.value })} className="mt-1.5 min-h-20 w-full resize-y rounded-xl border border-input bg-background px-3 py-2.5 font-normal" placeholder={t("Books, courses, files, or leave blank")} /></label>
            <fieldset><legend className="text-sm font-medium">{t("How do you prefer to learn?")}</legend><div className="mt-2 flex flex-wrap gap-2">{[["guided", "Guided explanation"], ["visual", "Visual examples"], ["practice", "Practice first"], ["reading", "Structured reading"]].map(([value, label]) => { const selected = draft.preferred_methods.includes(value); return <button key={value} type="button" aria-pressed={selected} onClick={() => toggleMethod(value)} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm ${selected ? "border-primary bg-primary-muted text-primary" : "border-border bg-background text-muted-foreground"}`}>{selected && <Check size={14} />}{t(label)}</button>; })}</div></fieldset>
          </div>
        )}

        {error && <p role="alert" className="mt-4 rounded-lg bg-destructive-muted px-3 py-2 text-sm text-destructive">{error}</p>}
        <div className="mt-6 flex items-center justify-between">
          {step > 0 ? <Button variant="outline" onClick={() => setStep((value) => value - 1)}><ArrowLeft size={15} />{t("Back")}</Button> : <Button variant="ghost" onClick={closeDialog}>{t("Skip for now")}</Button>}
          {step < 2 ? <Button onClick={() => setStep((value) => value + 1)} disabled={step === 0 && !draft.title.trim()}>{t("Continue")}<ArrowRight size={15} /></Button> : <Button onClick={() => void submit()} disabled={submitting || !draft.title.trim()}>{submitting ? t("Creating…") : t("Create plan and first task")}</Button>}
        </div>
      </div>
    </div>
  );
}
