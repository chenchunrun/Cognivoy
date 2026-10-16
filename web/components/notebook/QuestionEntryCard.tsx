"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslation } from "react-i18next";
import {
  Bookmark,
  ChevronDown,
  Eye,
  EyeOff,
  FolderPlus,
  GraduationCap,
  Pencil,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  Badge,
  type BadgeVariant,
  Button,
  Dropdown,
  DropdownItem,
  DropdownLabel,
  Tooltip,
  Input,
} from "@/components/ui";
import { cn } from "@/lib/utils";
import type { NotebookCategory, NotebookEntry } from "@/lib/notebook-api";
import {
  isMultipleChoiceQuizQuestion,
  resolveMultipleChoiceAnswerKeys,
} from "@/lib/quiz-question-type";
import Markdown from "@/components/chat/Markdown";
import { questionOptionFeedbackState } from "@/lib/question-feedback";

const DIFFICULTY_VARIANT: Record<string, BadgeVariant> = {
  hard: "destructive",
  medium: "warning",
  easy: "success",
};

const REVIEW_VARIANT: Record<NotebookEntry["review_status"], BadgeVariant> = {
  new: "outline",
  due: "warning",
  scheduled: "default",
  mastered: "success",
};

export interface QuestionEntryCardProps {
  entry: NotebookEntry;
  projectTitle?: string;
  categories: NotebookCategory[];
  /** When set, the list is filtered to this category and entries can be removed from it. */
  activeCategoryId: number | null;
  pending: boolean;
  onToggleBookmark: (entry: NotebookEntry) => void;
  onEdit: (entry: NotebookEntry) => void;
  onDelete: (entry: NotebookEntry) => void;
  onAddToCategory: (entry: NotebookEntry, categoryId: number) => void;
  onRemoveFromCategory: (entry: NotebookEntry, categoryId: number) => void;
  onGenerateSimilar: (entry: NotebookEntry) => void;
  onSubmitAnswer?: (entry: NotebookEntry, answer: string) => Promise<void>;
}

export function QuestionEntryCard({
  entry,
  projectTitle,
  categories,
  activeCategoryId,
  pending,
  onToggleBookmark,
  onEdit,
  onDelete,
  onAddToCategory,
  onRemoveFromCategory,
  onGenerateSimilar,
  onSubmitAnswer,
}: QuestionEntryCardProps) {
  const { t } = useTranslation();
  const [answerVisible, setAnswerVisible] = React.useState(false);
  const [draftAnswer, setDraftAnswer] = React.useState("");
  const [submittingAnswer, setSubmittingAnswer] = React.useState(false);

  const options = Object.entries(entry.options ?? {});
  const multipleChoice = isMultipleChoiceQuizQuestion(entry.question_type);
  const selectedKeys = multipleChoice
    ? resolveMultipleChoiceAnswerKeys(entry.user_answer, entry.options)
    : [];
  const correctKeys = multipleChoice
    ? resolveMultipleChoiceAnswerKeys(entry.correct_answer, entry.options)
    : [];
  const entryCategoryIds = new Set(
    (entry.categories ?? []).map((category) => category.id),
  );
  const availableCategories = categories.filter(
    (category) => !entryCategoryIds.has(category.id),
  );

  return (
    <li
      className={cn(
        "surface p-5 transition-opacity duration-150",
        pending && "pointer-events-none opacity-60",
      )}
    >
      {/* Header: badges + actions */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {entry.difficulty && (
            <Badge
              variant={DIFFICULTY_VARIANT[entry.difficulty] ?? "default"}
              className="uppercase"
            >
              {t(entry.difficulty)}
            </Badge>
          )}
          {entry.question_type && (
            <Badge variant="outline">{t(entry.question_type)}</Badge>
          )}
          {entry.attempt_count > 0 ? (
            <Badge variant={entry.is_correct ? "success" : "destructive"}>
              {entry.is_correct ? t("Correct") : t("Incorrect")}
            </Badge>
          ) : (
            <Badge variant="outline">{t("Not attempted")}</Badge>
          )}
          <Badge variant={REVIEW_VARIANT[entry.review_status] ?? "outline"}>
            {entry.review_status === "due"
              ? t("Due for review")
              : entry.review_status === "mastered"
                ? t("Mastered")
                : entry.review_status === "scheduled"
                  ? t("Review scheduled")
                  : t("New")}
          </Badge>
          {(entry.categories ?? []).map((category) => (
            <Badge key={category.id} variant="default">
              {category.name}
            </Badge>
          ))}
          {entry.learning_project_id && (
            <Link
              href={`/space/learning/${encodeURIComponent(entry.learning_project_id)}`}
              className="inline-flex items-center gap-1 rounded-full border border-primary-border bg-primary-muted px-2 py-0.5 text-xs font-medium text-foreground hover:underline"
            >
              <GraduationCap size={11} aria-hidden="true" />
              {projectTitle || t("Learning plan")}
            </Link>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Tooltip
            content={entry.bookmarked ? t("Remove bookmark") : t("Bookmark")}
          >
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-8 w-8",
                entry.bookmarked
                  ? "text-primary"
                  : "text-muted-foreground",
              )}
              aria-label={entry.bookmarked ? t("Remove bookmark") : t("Bookmark")}
              onClick={() => onToggleBookmark(entry)}
            >
              <Bookmark
                size={15}
                fill={entry.bookmarked ? "currentColor" : "none"}
              />
            </Button>
          </Tooltip>
          {availableCategories.length > 0 && (
            <Dropdown
              align="end"
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground"
                  aria-label={t("Add to category")}
                >
                  <FolderPlus size={15} />
                </Button>
              }
            >
              <DropdownLabel>{t("Add to category")}</DropdownLabel>
              {availableCategories.map((category) => (
                <DropdownItem
                  key={category.id}
                  label={category.name}
                  onClick={() => onAddToCategory(entry, category.id)}
                />
              ))}
            </Dropdown>
          )}
          {activeCategoryId !== null && (
            <Tooltip content={t("Remove from category")}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                aria-label={t("Remove from category")}
                onClick={() => onRemoveFromCategory(entry, activeCategoryId)}
              >
                <X size={15} />
              </Button>
            </Tooltip>
          )}
          <Tooltip content={t("Edit entry")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              aria-label={t("Edit entry")}
              onClick={() => onEdit(entry)}
            >
              <Pencil size={14} />
            </Button>
          </Tooltip>
          <Tooltip content={t("Delete entry")}>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              aria-label={t("Delete entry")}
              onClick={() => onDelete(entry)}
            >
              <Trash2 size={14} />
            </Button>
          </Tooltip>
        </div>
      </div>

      {/* Question stem */}
      <div className="prose-cognivoy text-[15px] font-medium text-foreground">
        <Markdown content={entry.question} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>{t("{{count}} attempts", { count: entry.attempt_count })}</span>
        {entry.review_due_at && entry.review_status !== "due" && (
          <span>
            · {t("Next review {{date}}", {
              date: new Date(entry.review_due_at * 1000).toLocaleDateString(),
            })}
          </span>
        )}
        {entry.knowledge_points.map((point) => (
          <span
            key={point}
            className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground"
          >
            {point}
          </span>
        ))}
      </div>

      {/* Choice options */}
      {options.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {options.map(([key, text]) => {
            const isUserAnswer =
              multipleChoice
                ? selectedKeys.includes(key.toUpperCase())
                : entry.user_answer?.toUpperCase() === key.toUpperCase();
            const isCorrectAnswer =
              multipleChoice
                ? correctKeys.includes(key.toUpperCase())
                : entry.correct_answer?.toUpperCase() === key.toUpperCase();
            const { revealCorrectAnswer, revealWrongPick } =
              questionOptionFeedbackState({
                answerVisible,
                isCorrectAnswer,
                isUserAnswer,
                entryIsCorrect: entry.is_correct,
              });
            const chosen = draftAnswer.split(",").includes(key);
            return (
              <button
                type="button"
                key={key}
                disabled={!onSubmitAnswer || submittingAnswer}
                onClick={() => {
                  if (!onSubmitAnswer) return;
                  if (multipleChoice) {
                    const next = new Set(draftAnswer.split(",").filter(Boolean));
                    if (next.has(key)) next.delete(key); else next.add(key);
                    setDraftAnswer(Array.from(next).join(","));
                  } else {
                    setDraftAnswer(key);
                  }
                }}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm",
                  revealCorrectAnswer
                    ? "border-success-border bg-success-muted"
                    : revealWrongPick
                      ? "border-destructive-border bg-destructive-muted"
                      : chosen
                        ? "border-primary bg-primary-muted"
                        : "border-transparent bg-muted",
                  onSubmitAnswer && "cursor-pointer hover:border-primary-border",
                )}
              >
                <span
                  className={cn(
                    "mt-px shrink-0 font-semibold",
                    revealCorrectAnswer
                      ? "text-success"
                      : revealWrongPick
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {key}.
                </span>
                <span
                  className={cn(
                    "flex-1",
                    revealCorrectAnswer || revealWrongPick
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {text}
                </span>
                {revealCorrectAnswer && (
                  <span className="mt-px shrink-0 text-xs font-medium text-success">
                    {t("Correct answer")}
                  </span>
                )}
                {revealWrongPick && (
                  <span className="mt-px shrink-0 text-xs font-medium text-destructive">
                    {t("Your pick")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {onSubmitAnswer && options.length === 0 && (
        <Input
          className="mt-3"
          value={draftAnswer}
          onChange={(event) => setDraftAnswer(event.target.value)}
          placeholder={t("Enter your answer")}
          disabled={submittingAnswer}
        />
      )}

      {onSubmitAnswer && (
        <div className="mt-3 flex items-center gap-2">
          <Button
            size="sm"
            disabled={!draftAnswer.trim() || submittingAnswer}
            onClick={async () => {
              setSubmittingAnswer(true);
              try {
                await onSubmitAnswer(entry, draftAnswer);
                setDraftAnswer("");
                setAnswerVisible(true);
              } finally {
                setSubmittingAnswer(false);
              }
            }}
          >
            {submittingAnswer ? t("Submitting") : t("Submit answer")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("Your attempt updates course progress and the review schedule.")}
          </span>
        </div>
      )}

      {/* Expandable answer */}
      <div className="mt-3">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 text-muted-foreground"
          onClick={() => setAnswerVisible((value) => !value)}
          disabled={Boolean(onSubmitAnswer) && entry.attempt_count === 0 && !answerVisible}
          aria-expanded={answerVisible}
        >
          {answerVisible ? <EyeOff size={13} /> : <Eye size={13} />}
          {answerVisible ? t("Hide answer") : t("Show answer")}
          <ChevronDown
            size={13}
            className={cn(
              "transition-transform duration-150",
              answerVisible && "rotate-180",
            )}
          />
        </Button>

        {answerVisible && (
          <div className="mt-2 space-y-2 text-sm">
            <div
              className={cn(
                "rounded-lg border px-3 py-2.5",
                entry.is_correct
                  ? "border-success-border bg-success-muted"
                  : "border-destructive-border bg-destructive-muted",
              )}
            >
              <div
                className={cn(
                  "mb-1 text-xs font-medium uppercase tracking-wide",
                  entry.is_correct ? "text-success" : "text-destructive",
                )}
              >
                {t("Your answer")}
              </div>
              {entry.user_answer ? (
                <div className="prose-cognivoy text-foreground">
                  <Markdown
                    content={
                      entry.question_type === "coding"
                        ? `\`\`\`python\n${entry.user_answer}\n\`\`\``
                        : entry.user_answer
                    }
                  />
                </div>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            <div className="rounded-lg border border-success-border bg-success-muted px-3 py-2.5">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-success">
                {t("Reference answer")}
              </div>
              {entry.correct_answer ? (
                <div className="prose-cognivoy text-foreground">
                  <Markdown
                    content={
                      entry.question_type === "coding" &&
                      !entry.correct_answer.trimStart().startsWith("```")
                        ? `\`\`\`python\n${entry.correct_answer}\n\`\`\``
                        : entry.correct_answer
                    }
                  />
                </div>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            {entry.explanation && (
              <div className="rounded-lg border border-border bg-muted px-3 py-2.5">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t("Explanation")}
                </div>
                <div className="prose-cognivoy text-foreground">
                  <Markdown content={entry.explanation} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate">
            {entry.session_title || t("Original session")}
          </span>
          {!entry.is_correct && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onGenerateSimilar(entry)}
            >
              <Sparkles size={13} />
              {t("Generate similar question")}
            </Button>
          )}
        </div>
        <span className="shrink-0 tabular-nums">
          {new Date(entry.created_at * 1000).toLocaleString()}
        </span>
      </div>
    </li>
  );
}
