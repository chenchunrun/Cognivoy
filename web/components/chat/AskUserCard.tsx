"use client";

/**
 * Inline card for a turn paused on the ``ask_user`` tool. Extracts the v3
 * question payload from the assistant message's event stream (legacy
 * single-question / plain-string shapes are normalised), lets the user
 * answer per question (option chips and/or free text), and submits through
 * the context's ``submitUserReply``. Once the matching
 * ``ask_user_resolved`` progress event arrives the card collapses to a
 * small "Answered" chip.
 */

import * as React from "react";
import { Check, MessageCircleQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { StreamEvent } from "@/lib/unified-ws";
import { Badge, Button, Card, Textarea } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface AskUserOption {
  label: string;
  description: string | null;
}

export interface AskUserQuestion {
  id: string;
  prompt: string;
  multi_select: boolean;
  options: AskUserOption[];
  allow_free_text: boolean;
  placeholder: string | null;
}

export interface AskUserPayload {
  intro: string | null;
  questions: AskUserQuestion[];
}

export interface AskUserAnswer {
  questionId: string;
  text: string;
}

export interface AskUserCardData {
  payload: AskUserPayload;
  answers: AskUserAnswer[] | null;
  resolved: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normaliseOption(raw: unknown): AskUserOption | null {
  if (typeof raw === "string" && raw.trim()) {
    return { label: raw, description: null };
  }
  const record = asRecord(raw);
  if (!record) return null;
  const label = String(record.label ?? record.title ?? "").trim();
  if (!label) return null;
  return {
    label,
    description:
      typeof record.description === "string" && record.description
        ? record.description
        : null,
  };
}

function normaliseQuestion(raw: unknown, index: number): AskUserQuestion | null {
  const record = asRecord(raw);
  if (!record) return null;
  const prompt = String(
    record.prompt ?? record.question ?? record.text ?? "",
  ).trim();
  if (!prompt) return null;
  const options = Array.isArray(record.options)
    ? record.options
        .map(normaliseOption)
        .filter((o): o is AskUserOption => o !== null)
    : [];
  return {
    id: String(record.id ?? record.questionId ?? `q${index + 1}`),
    prompt,
    multi_select: Boolean(record.multi_select),
    options,
    // Free text is always allowed unless explicitly disabled, so a card
    // with no options still has an input.
    allow_free_text:
      record.allow_free_text !== undefined
        ? Boolean(record.allow_free_text)
        : true,
    placeholder:
      typeof record.placeholder === "string" && record.placeholder
        ? record.placeholder
        : null,
  };
}

function normalisePayload(raw: unknown): AskUserPayload | null {
  if (typeof raw === "string" && raw.trim()) {
    return {
      intro: null,
      questions: [
        {
          id: "q1",
          prompt: raw,
          multi_select: false,
          options: [],
          allow_free_text: true,
          placeholder: null,
        },
      ],
    };
  }
  const record = asRecord(raw);
  if (!record) return null;
  if (Array.isArray(record.questions)) {
    const questions = record.questions
      .map((q, i) => normaliseQuestion(q, i))
      .filter((q): q is AskUserQuestion => q !== null);
    if (!questions.length) return null;
    return {
      intro:
        typeof record.intro === "string" && record.intro
          ? record.intro
          : null,
      questions,
    };
  }
  // Legacy single-question shape.
  const question = normaliseQuestion(record, 0);
  return question ? { intro: null, questions: [question] } : null;
}

/**
 * Read the most recent ``ask_user`` card from an assistant message's event
 * stream, plus its resolution (when the matching ``ask_user_resolved``
 * progress event has landed). Returns null when no ask_user call exists.
 */
export function extractAskUserCardData(
  events: StreamEvent[] | undefined,
): AskUserCardData | null {
  if (!events?.length) return null;

  let latest: { payload: AskUserPayload; toolCallId: string | null } | null =
    null;
  let resolution: {
    toolCallId: string | null;
    answers: AskUserAnswer[];
    text: string;
  } | null = null;

  for (const event of events) {
    const meta = asRecord(event.metadata);
    if (event.type === "tool_result") {
      const toolMetadata = asRecord(meta?.tool_metadata);
      const askUser = toolMetadata?.ask_user ?? meta?.ask_user;
      const payload = normalisePayload(askUser);
      if (!payload) continue;
      latest = {
        payload,
        toolCallId:
          typeof meta?.tool_call_id === "string" ? meta.tool_call_id : null,
      };
      resolution = null;
      continue;
    }
    if (event.type === "progress" && meta?.ask_user_resolved) {
      const answersRaw = Array.isArray(meta.answers) ? meta.answers : [];
      resolution = {
        toolCallId:
          typeof meta.ask_user_tool_call_id === "string"
            ? meta.ask_user_tool_call_id
            : null,
        answers: answersRaw.flatMap((entry) => {
          const record = asRecord(entry);
          if (!record) return [];
          const questionId = String(
            record.questionId ?? record.id ?? "",
          ).trim();
          if (!questionId) return [];
          return [{ questionId, text: String(record.text ?? "") }];
        }),
        text:
          typeof meta.reply_preview === "string" ? meta.reply_preview : "",
      };
    }
  }

  if (!latest) return null;

  if (
    resolution &&
    (resolution.toolCallId === latest.toolCallId || latest.toolCallId === null)
  ) {
    const answers =
      resolution.answers.length > 0
        ? resolution.answers
        : latest.payload.questions.length > 0
          ? [
              {
                questionId: latest.payload.questions[0].id,
                text: resolution.text || "",
              },
            ]
          : [];
    return { payload: latest.payload, answers, resolved: true };
  }
  return { payload: latest.payload, answers: null, resolved: false };
}

/* ------------------------------------------------------------------ */
/*  Card                                                              */
/* ------------------------------------------------------------------ */

function QuestionBlock({
  question,
  selected,
  freeText,
  onToggleOption,
  onFreeText,
}: {
  question: AskUserQuestion;
  selected: Set<string>;
  freeText: string;
  onToggleOption: (label: string) => void;
  onFreeText: (text: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2" data-ask-user-question={question.id}>
      <p className="text-sm font-medium text-foreground">{question.prompt}</p>
      {question.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {question.options.map((option) => {
            const active = selected.has(option.label);
            return (
              <button
                key={option.label}
                type="button"
                onClick={() => onToggleOption(option.label)}
                title={option.description ?? undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] transition-colors duration-150",
                  active
                    ? "border-primary bg-primary-muted text-accent-foreground"
                    : "border-border bg-card text-muted-foreground hover:border-primary-border hover:text-foreground",
                )}
              >
                {active && <Check size={12} />}
                {option.label}
              </button>
            );
          })}
        </div>
      )}
      {question.allow_free_text && (
        <Textarea
          value={freeText}
          onChange={(e) => onFreeText(e.target.value)}
          placeholder={question.placeholder ?? t("Type your answer…")}
          rows={2}
          className="min-h-[56px] text-sm"
        />
      )}
    </div>
  );
}

export function AskUserCard({
  data,
  onSubmit,
  active = true,
}: {
  data: AskUserCardData;
  active?: boolean;
  onSubmit: (reply: {
    text?: string;
    answers?: Array<{ questionId: string; text: string }>;
  }) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = React.useState<
    Record<string, Set<string>>
  >({});
  const [freeText, setFreeText] = React.useState<Record<string, string>>({});
  const [submitted, setSubmitted] = React.useState(false);

  if (data.resolved) {
    const preview = (data.answers ?? [])
      .map((a) => a.text)
      .filter(Boolean)
      .join(" · ");
    return (
      <Badge variant="default" className="mt-2" title={preview || undefined}>
        <Check size={12} />
        {t("Answered")}
        {preview && (
          <span className="max-w-56 truncate font-normal">{preview}</span>
        )}
      </Badge>
    );
  }

  const toggleOption = (question: AskUserQuestion, label: string) => {
    setSelected((prev) => {
      const current = new Set(prev[question.id] ?? []);
      if (current.has(label)) {
        current.delete(label);
      } else if (question.multi_select) {
        current.add(label);
      } else {
        current.clear();
        current.add(label);
      }
      return { ...prev, [question.id]: current };
    });
  };

  const buildAnswers = (): AskUserAnswer[] =>
    data.payload.questions.map((question) => {
      const picked = Array.from(selected[question.id] ?? []);
      const text = (freeText[question.id] ?? "").trim();
      const combined = [...picked, ...(text ? [text] : [])].join(", ");
      return { questionId: question.id, text: combined };
    });

  const answers = buildAnswers();
  const hasAnyAnswer = answers.some((a) => a.text.trim().length > 0);

  const handleSubmit = () => {
    if (!active || !hasAnyAnswer || submitted) return;
    setSubmitted(true);
    onSubmit({ answers });
  };

  return (
    <Card className="mt-3 flex flex-col gap-3 p-4" data-ask-user-card="pending">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <MessageCircleQuestion size={15} className="text-primary" />
        {data.payload.intro ?? t("A quick question before I continue")}
      </div>
      {data.payload.questions.map((question) => (
        <QuestionBlock
          key={question.id}
          question={question}
          selected={selected[question.id] ?? new Set()}
          freeText={freeText[question.id] ?? ""}
          onToggleOption={(label) => toggleOption(question, label)}
          onFreeText={(text) =>
            setFreeText((prev) => ({ ...prev, [question.id]: text }))
          }
        />
      ))}
      {!active ? (
        <p role="status" className="text-xs text-destructive">
          {t("This question has expired because the task ended. Retry the message to continue.")}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={!active || !hasAnyAnswer || submitted}
          loading={active && submitted}
        >
          {t("Submit")}
        </Button>
      </div>
    </Card>
  );
}

export default AskUserCard;
