"use client";

/**
 * Interactive quiz block: choice questions report attempts back to the Book
 * API (which the page may follow up with a supplement block on wrong picks).
 */

import * as React from "react";
import { CheckCircle2, Eye, EyeOff, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Markdown } from "@/components/chat/Markdown";
import type { Block } from "@/lib/book-types";
import {
  isChoiceQuizQuestion,
  normalizeQuizQuestionType,
  resolveChoiceAnswerKey,
} from "@/lib/quiz-question-type";
import { cn } from "@/lib/utils";

export interface QuizAttemptArgs {
  questionId?: string;
  userAnswer?: string;
  isCorrect: boolean;
}

interface QuizQuestion {
  question_id?: string;
  question?: string;
  question_type?: string;
  options?: Record<string, string> | null;
  correct_answer?: string;
  explanation?: string;
  difficulty?: string;
}

export interface QuizBlockViewProps {
  block: Block;
  onAttempt?: (block: Block, args: QuizAttemptArgs) => void;
}

export function QuizBlockView({ block, onAttempt }: QuizBlockViewProps) {
  const { t } = useTranslation();
  const questions =
    (block.payload?.questions as QuizQuestion[] | undefined) || [];
  if (questions.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        {t("No quiz questions generated.")}
      </div>
    );
  }
  return (
    <section>
      <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
        <span className="h-px flex-1 bg-primary-muted" />
        {t("Quick check")}
        <span className="h-px flex-1 bg-primary-muted" />
      </div>
      <div className="space-y-3">
        {questions.map((q, idx) => (
          <QuizQuestionCard
            key={q.question_id || idx}
            index={idx}
            question={q}
            onAttempt={(args) => onAttempt?.(block, args)}
          />
        ))}
      </div>
    </section>
  );
}

function QuizQuestionCard({
  index,
  question,
  onAttempt,
}: {
  index: number;
  question: QuizQuestion;
  onAttempt?: (args: QuizAttemptArgs) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState(false);
  const reportedRef = React.useRef<string | null>(null);
  const normalizedType = normalizeQuizQuestionType(question.question_type);
  const options = question.options || {};
  const isChoice = isChoiceQuizQuestion(normalizedType);
  const correct = String(question.correct_answer || "").trim();
  const correctChoiceKey = resolveChoiceAnswerKey(correct, options);
  const reportKey = `${question.question_id || index}:${selected || ""}`;

  React.useEffect(() => {
    if (
      revealed &&
      selected &&
      reportedRef.current !== reportKey &&
      onAttempt
    ) {
      reportedRef.current = reportKey;
      onAttempt({
        questionId: question.question_id,
        userAnswer: selected,
        isCorrect: selected.toUpperCase() === correctChoiceKey,
      });
    }
  }, [
    reportKey,
    revealed,
    selected,
    onAttempt,
    question.question_id,
    correctChoiceKey,
  ]);

  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span className="pt-0.5 text-sm font-medium text-foreground">
            {index + 1}.
          </span>
          <div className="prose-cognivoy min-w-0 flex-1 text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_p]:my-1.5">
            <Markdown content={String(question.question || t("(missing)"))} />
          </div>
        </div>
        {question.difficulty && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {question.difficulty}
          </span>
        )}
      </div>

      {isChoice && Object.keys(options).length > 0 ? (
        <div className="mt-3 space-y-1.5">
          {Object.entries(options).map(([key, label]) => {
            const upperKey = key.toUpperCase();
            const isSelected = selected === upperKey;
            const isCorrect = revealed && upperKey === correctChoiceKey;
            const isWrongPick =
              revealed && isSelected && upperKey !== correctChoiceKey;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelected(upperKey)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  isCorrect
                    ? "border-success-border bg-success-muted text-foreground"
                    : isWrongPick
                      ? "border-destructive-border bg-destructive-muted text-foreground"
                      : isSelected
                        ? "border-primary bg-primary-muted text-foreground"
                        : "border-border bg-card text-foreground hover:border-primary-border",
                )}
              >
                <span className="font-mono text-xs uppercase text-muted-foreground">
                  {upperKey}.
                </span>
                <span className="flex-1 whitespace-pre-wrap break-words">
                  {label}
                </span>
                {isCorrect && (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" />
                )}
                {isWrongPick && (
                  <XCircle className="mt-0.5 h-4 w-4 text-destructive" />
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="mt-2 text-xs text-muted-foreground">
          {t("Think about your answer, then reveal the solution.")}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-primary-border hover:text-primary"
        >
          {revealed ? (
            <EyeOff className="h-3.5 w-3.5" />
          ) : (
            <Eye className="h-3.5 w-3.5" />
          )}
          {revealed ? t("Hide answer") : t("Reveal answer")}
        </button>
        {revealed && correct && isChoice && (
          <span className="text-xs text-muted-foreground">
            {t("Answer")}:{" "}
            <span className="font-mono text-foreground">
              {correctChoiceKey || correct}
            </span>
          </span>
        )}
      </div>

      {revealed && correct && !isChoice && (
        <div className="mt-2 rounded-lg border border-border bg-card p-2">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {t("Answer")}
          </div>
          <div className="prose-cognivoy text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_p]:my-1.5">
            <Markdown content={correct} />
          </div>
        </div>
      )}

      {revealed && question.explanation && (
        <div className="prose-cognivoy mt-2 rounded-lg border border-border bg-muted p-2 text-sm [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
          <Markdown content={String(question.explanation)} />
        </div>
      )}
    </div>
  );
}

export default QuizBlockView;
