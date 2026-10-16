"use client";

import * as React from "react";
import {
  Check,
  CircleAlert,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RotateCcw,
  Sparkles,
  Bookmark,
  MessageCircleQuestion,
  ImagePlus,
  Trash2,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { Markdown } from "@/components/chat/Markdown";
import { Badge, Button, Textarea } from "@/components/ui";
import {
  areMultipleChoiceAnswersEqual,
  isChoiceQuizQuestion,
  isConceptQuizQuestion,
  isFillInBlankQuizQuestion,
  isMultipleChoiceQuizQuestion,
  resolveChoiceAnswerKey,
  resolveConceptAnswer,
  resolveMultipleChoiceAnswerKeys,
} from "@/lib/quiz-question-type";
import {
  readFileAsBase64,
  startQuizJudge,
  type QuizJudgeHandle,
  type QuizJudgeImage,
} from "@/lib/quiz-judge";
import type { QuizJudgeAssessment, QuizQuestion } from "@/lib/quiz-types";
import { parseQuizJudgeVerdict } from "@/lib/quiz-types";
import { recordQuizResults, type QuizResultItem } from "@/lib/session-api";
import {
  addEntryToCategory,
  listCategories,
  lookupNotebookEntry,
  updateNotebookEntry,
  type NotebookCategory,
  type NotebookEntry,
} from "@/lib/notebook-api";
import { cn } from "@/lib/utils";
import {
  buildQuizDraftKey,
  parseQuizDraft,
  serializeQuizDraft,
} from "@/lib/quiz-draft";

interface QuizViewerProps {
  questions: QuizQuestion[];
  sessionId?: string | null;
  turnId?: string | null;
  language?: string;
  onFollowup?: (
    question: QuizQuestion,
    answer: string,
    correct: boolean | null,
    judgment: string,
  ) => void;
  onRegenerateMissing?: (question: QuizQuestion) => void;
}

interface AnswerState {
  value: string;
  submitted: boolean;
  correct: boolean | null;
}

interface JudgeState {
  text: string;
  loading: boolean;
  error: string;
  assessment: QuizJudgeAssessment | null;
}

interface AnswerImageState extends QuizJudgeImage {
  id: string;
  preview: string;
}

function isChoice(question: QuizQuestion): boolean {
  return (
    isChoiceQuizQuestion(question.question_type) &&
      Boolean(question.options && Object.keys(question.options).length)
  ) || (
    isMultipleChoiceQuizQuestion(question.question_type) &&
    Boolean(question.options && Object.keys(question.options).length)
  );
}

function normalizedCorrectAnswer(question: QuizQuestion): string {
  if (isChoice(question)) {
    if (isMultipleChoiceQuizQuestion(question.question_type)) {
      return resolveMultipleChoiceAnswerKeys(
        question.correct_answer,
        question.options,
      ).join(",");
    }
    return resolveChoiceAnswerKey(question.correct_answer, question.options);
  }
  if (isConceptQuizQuestion(question.question_type)) {
    return resolveConceptAnswer(question.correct_answer);
  }
  return question.correct_answer.trim().toLowerCase();
}

function gradeAnswer(question: QuizQuestion, value: string): boolean {
  if (isMultipleChoiceQuizQuestion(question.question_type)) {
    return areMultipleChoiceAnswersEqual(value, question.correct_answer);
  }
  const submitted = value.trim().toLowerCase();
  if (!submitted) return false;
  return submitted === normalizedCorrectAnswer(question).toLowerCase();
}

function resultFor(
  question: QuizQuestion,
  answer: AnswerState & { correct: boolean },
  images: AnswerImageState[] = [],
): QuizResultItem {
  return {
    question_id: question.question_id,
    question: question.question,
    question_type: question.question_type,
    options: question.options ?? {},
    user_answer: answer.value,
    correct_answer: question.correct_answer,
    explanation: question.explanation,
    difficulty: question.difficulty,
    knowledge_points: question.knowledge_points,
    source_refs: question.source_refs,
    rubric: question.rubric,
    user_answer_images: images.map(({ id, base64, url, filename, mime_type }) => ({
      id,
      base64,
      url,
      filename,
      mime_type,
    })),
    is_correct: answer.correct,
  };
}

function requiresAiGrading(question: QuizQuestion): boolean {
  return ["short_answer", "written", "coding"].includes(
    question.question_type,
  );
}

export default function QuizViewer({
  questions,
  sessionId,
  turnId,
  language = "en",
  onFollowup,
  onRegenerateMissing,
}: QuizViewerProps) {
  const { t } = useTranslation();
  const [index, setIndex] = React.useState(0);
  const [answers, setAnswers] = React.useState<Record<string, AnswerState>>({});
  const [judgments, setJudgments] = React.useState<Record<string, JudgeState>>(
    {},
  );
  const [saveState, setSaveState] = React.useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [scheduledReviews, setScheduledReviews] = React.useState(0);
  const [notebookEntries, setNotebookEntries] = React.useState<
    Record<string, NotebookEntry>
  >({});
  const [categories, setCategories] = React.useState<NotebookCategory[]>([]);
  const [draftReady, setDraftReady] = React.useState(false);
  const [durableHydrationReady, setDurableHydrationReady] = React.useState(false);
  const [answerImages, setAnswerImages] = React.useState<
    Record<string, AnswerImageState[]>
  >({});
  const [imageError, setImageError] = React.useState("");
  const savedSignatureRef = React.useRef("");
  const submissionIdsRef = React.useRef(new Map<string, string>());
  const judgeHandleRef = React.useRef<QuizJudgeHandle | null>(null);
  const draftKey = React.useMemo(
    () => (sessionId && turnId ? buildQuizDraftKey(sessionId, turnId) : null),
    [sessionId, turnId],
  );
  const draftQuestionIds = React.useMemo(
    () => questions.map((item, itemIndex) => item.question_id || `q-${itemIndex + 1}`),
    [questions],
  );

  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!draftKey) {
        setDraftReady(true);
        return;
      }
      let restored: Record<string, AnswerState> = {};
      try {
        restored = parseQuizDraft(
          window.localStorage.getItem(draftKey),
          draftQuestionIds,
        );
      } catch {
        // Storage can be disabled by browser policy. Quiz interaction remains
        // available for this tab even when durable drafts are unavailable.
      }
      if (Object.keys(restored).length > 0) setAnswers(restored);
      setDraftReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [draftKey, draftQuestionIds]);

  React.useEffect(() => {
    if (!draftReady || !draftKey) return;
    try {
      if (Object.keys(answers).length === 0) {
        window.localStorage.removeItem(draftKey);
      } else {
        window.localStorage.setItem(draftKey, serializeQuizDraft(answers));
      }
    } catch {
      // See hydration note above; localStorage failure is non-fatal.
    }
  }, [answers, draftKey, draftReady]);

  React.useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!sessionId || !turnId || questions.length === 0) {
        if (!cancelled) setDurableHydrationReady(true);
        return;
      }
      setDurableHydrationReady(false);
      void Promise.all(
        questions.map(async (item, itemIndex) => {
          const key = item.question_id || `q-${itemIndex + 1}`;
          const entry = await lookupNotebookEntry(sessionId, key, turnId);
          return entry ? ([key, item, entry] as const) : null;
        }),
      )
        .then((items) => {
          if (cancelled) return;
          const persisted = items.filter(
            (item): item is NonNullable<typeof item> => item !== null,
          );
          if (persisted.length === 0) {
            setDurableHydrationReady(true);
            return;
          }
          const restoredAnswers: Record<string, AnswerState> = {};
          const restoredImages: Record<string, AnswerImageState[]> = {};
          for (const [key, , entry] of persisted) {
            restoredAnswers[key] = {
              value: entry.user_answer,
              submitted: true,
              correct: entry.is_correct,
            };
            restoredImages[key] = (entry.user_answer_images ?? []).map((image) => ({
              id: image.id,
              base64: null,
              url: image.url,
              filename: image.filename,
              mime_type: image.mime_type,
              preview: image.url,
            }));
          }
          if (persisted.length === questions.length) {
            const persistedResults = persisted.map(([key, item]) =>
              resultFor(
                item,
                restoredAnswers[key] as AnswerState & { correct: boolean },
                restoredImages[key],
              ),
            );
            savedSignatureRef.current = JSON.stringify(persistedResults);
            setSaveState("saved");
          }
          setAnswers((current) => ({ ...current, ...restoredAnswers }));
          setAnswerImages((current) => ({ ...current, ...restoredImages }));
          setNotebookEntries(
            Object.fromEntries(persisted.map(([key, , entry]) => [key, entry])),
          );
          setDurableHydrationReady(true);
        })
        .catch(() => {
          if (!cancelled) setDurableHydrationReady(true);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [questions, sessionId, turnId]);

  React.useEffect(
    () => () => {
      judgeHandleRef.current?.close();
    },
    [],
  );

  const safeIndex = Math.min(index, Math.max(questions.length - 1, 0));
  const question = questions[safeIndex];
  const questionKey = question?.question_id || `q-${safeIndex + 1}`;
  const answer = answers[questionKey] ?? {
    value: "",
    submitted: false,
    correct: null,
  };
  const currentImages = answerImages[questionKey] ?? [];
  const judgment = judgments[questionKey] ?? {
    text: "",
    loading: false,
    error: "",
    assessment: null,
  };
  const completed = Object.values(answers).filter(
    (item) => item.submitted,
  ).length;

  const results = React.useMemo(
    () =>
      questions.flatMap((item, itemIndex) => {
        const key = item.question_id || `q-${itemIndex + 1}`;
        const current = answers[key];
        return current?.submitted && typeof current.correct === "boolean"
          ? [
              resultFor(
                item,
                current as AnswerState & { correct: boolean },
                answerImages[key] ?? [],
              ),
            ]
          : [];
      }),
    [answerImages, answers, questions],
  );

  React.useEffect(() => {
    if (
      !sessionId ||
      !turnId ||
      !durableHydrationReady ||
      questions.length === 0 ||
      results.length !== questions.length
    ) {
      return;
    }
    const signature = JSON.stringify(results);
    if (signature === savedSignatureRef.current) return;
    savedSignatureRef.current = signature;
    let submissionId = submissionIdsRef.current.get(signature);
    if (!submissionId) {
      submissionId =
        typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `quiz-${turnId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      submissionIdsRef.current.set(signature, submissionId);
    }
    setSaveState("saving");
    void recordQuizResults(sessionId, results, turnId, submissionId)
      .then((response) => {
        setScheduledReviews(response.proactive_job_ids?.length ?? 0);
        // The quiz result is durable as soon as the write above succeeds.
        // Notebook metadata is optional enrichment and may be slower (or
        // temporarily unavailable), so it must not hold the save indicator in
        // "Saving…" or turn a successful result write into "Save failed".
        setSaveState("saved");
        void Promise.allSettled(
          questions.map(async (item, itemIndex) => {
            const key = item.question_id || `q-${itemIndex + 1}`;
            const entry = await lookupNotebookEntry(sessionId, key, turnId);
            return entry ? ([key, entry] as const) : null;
          }),
        ).then((settled) => {
          const persisted = settled.flatMap((item) =>
            item.status === "fulfilled" && item.value !== null
              ? [item.value]
              : [],
          );
          setNotebookEntries(Object.fromEntries(persisted));
        });
        void listCategories().then(setCategories).catch(() => undefined);
      })
      .catch(() => {
        savedSignatureRef.current = "";
        setSaveState("error");
      });
  }, [durableHydrationReady, questions, results, sessionId, turnId]);

  if (!question) return null;

  const updateValue = (value: string) => {
    setAnswers((current) => ({
      ...current,
      [questionKey]: { value, submitted: false, correct: null },
    }));
    setSaveState("idle");
  };

  const addAnswerImages = async (files: FileList | null) => {
    if (!files?.length) return;
    setImageError("");
    const available = Math.max(0, 4 - currentImages.length);
    const selected = Array.from(files).slice(0, available);
    if (selected.some((file) => file.size > 5 * 1024 * 1024)) {
      setImageError(t("Each answer image must be 5 MB or smaller"));
      return;
    }
    try {
      const loaded = await Promise.all(selected.map(readFileAsBase64));
      const additions = loaded.map((image) => {
        const id =
          typeof globalThis.crypto?.randomUUID === "function"
            ? globalThis.crypto.randomUUID()
            : `answer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return {
          id,
          base64: image.base64,
          url: null,
          filename: image.name,
          mime_type: image.mime,
          preview: `data:${image.mime};base64,${image.base64}`,
        } satisfies AnswerImageState;
      });
      setAnswerImages((current) => ({
        ...current,
        [questionKey]: [...(current[questionKey] ?? []), ...additions],
      }));
      setSaveState("idle");
    } catch {
      setImageError(t("Could not read the selected answer image"));
    }
  };

  const removeAnswerImage = (id: string) => {
    setAnswerImages((current) => ({
      ...current,
      [questionKey]: (current[questionKey] ?? []).filter((image) => image.id !== id),
    }));
    setSaveState("idle");
  };

  const submit = () => {
    if (!answer.value.trim() && !(requiresAiGrading(question) && currentImages.length)) {
      return;
    }
    const aiGraded = requiresAiGrading(question);
    setAnswers((current) => ({
      ...current,
      [questionKey]: {
        ...answer,
        submitted: true,
        correct: aiGraded ? null : gradeAnswer(question, answer.value),
      },
    }));
    if (aiGraded) judge(true);
  };

  const retry = () => {
    judgeHandleRef.current?.close();
    setAnswers((current) => ({
      ...current,
      [questionKey]: { value: "", submitted: false, correct: null },
    }));
    setJudgments((current) => {
      const next = { ...current };
      delete next[questionKey];
      return next;
    });
    setAnswerImages((current) => {
      const next = { ...current };
      delete next[questionKey];
      return next;
    });
    savedSignatureRef.current = "";
    setSaveState("idle");
  };

  const judge = (gradeAnswerFromVerdict = false) => {
    judgeHandleRef.current?.close();
    setJudgments((current) => ({
      ...current,
      [questionKey]: { text: "", loading: true, error: "", assessment: null },
    }));
    judgeHandleRef.current = startQuizJudge(
      {
        question: question.question,
        question_type: question.question_type,
        options: question.options ?? null,
        correct_answer: question.correct_answer,
        explanation: question.explanation,
        user_answer: answer.value,
        user_answer_images: currentImages.map(
          ({ base64, url, filename, mime_type }) => ({
            base64,
            url,
            filename,
            mime_type,
          }),
        ),
        language: language.startsWith("zh") ? "zh" : "en",
        rubric: question.rubric,
      },
      {
        onChunk: (chunk) =>
          setJudgments((current) => ({
            ...current,
            [questionKey]: {
              text: (current[questionKey]?.text ?? "") + chunk,
              loading: true,
              error: "",
              assessment: current[questionKey]?.assessment ?? null,
            },
          })),
        onDone: (text, assessment) => {
          setJudgments((current) => ({
            ...current,
            [questionKey]: { text, loading: false, error: "", assessment },
          }));
          if (gradeAnswerFromVerdict) {
            const verdict = assessment
              ? assessment.verdict === "correct"
              : parseQuizJudgeVerdict(text);
            setAnswers((current) => ({
              ...current,
              [questionKey]: {
                ...(current[questionKey] ?? answer),
                submitted: true,
                correct: verdict,
              },
            }));
          }
        },
        onError: (error) =>
          setJudgments((current) => ({
            ...current,
            [questionKey]: {
              text: "",
              loading: false,
              error,
              assessment: null,
            },
          })),
      },
    );
  };

  const choiceOptions = isChoice(question)
    ? Object.entries(question.options ?? {})
    : isConceptQuizQuestion(question.question_type)
      ? [
          ["true", t("True")],
          ["false", t("False")],
        ]
      : null;
  const score = results.filter((item) => item.is_correct).length;
  const notebookEntry = notebookEntries[questionKey];
  const multipleChoice = isMultipleChoiceQuizQuestion(question.question_type);
  const selectedChoiceKeys = multipleChoice
    ? resolveMultipleChoiceAnswerKeys(answer.value, question.options)
    : [];
  // A timeout fallback may still be a complete, automatically gradable
  // concept check. Only hide answer controls for genuinely missing cards.
  const blockingGenerationError = Boolean(
    question.generation_error &&
      (!question.correct_answer.trim() || question.correct_answer.trim().toUpperCase() === "N/A"),
  );

  const toggleBookmark = async () => {
    if (!notebookEntry) return;
    const next = !notebookEntry.bookmarked;
    await updateNotebookEntry(notebookEntry.id, { bookmarked: next });
    setNotebookEntries((current) => ({
      ...current,
      [questionKey]: { ...notebookEntry, bookmarked: next },
    }));
  };

  const assignCategory = async (categoryId: number) => {
    if (!notebookEntry || !categoryId) return;
    await addEntryToCategory(notebookEntry.id, categoryId);
    const category = categories.find((item) => item.id === categoryId);
    if (!category) return;
    setNotebookEntries((current) => ({
      ...current,
      [questionKey]: {
        ...notebookEntry,
        categories: [
          ...(notebookEntry.categories ?? []).filter((item) => item.id !== categoryId),
          category,
        ],
      },
    }));
  };

  return (
    <section
      className="surface overflow-hidden"
      data-testid="quiz-viewer"
      aria-label={t("Practice Questions")}
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Badge variant="primary">
            {t("Question")} {safeIndex + 1}/{questions.length}
          </Badge>
          {question.difficulty && (
            <span className="text-xs text-muted-foreground">
              {t(question.difficulty)}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {completed}/{questions.length} {t("Answered")}
          {draftReady &&
          Object.values(answers).some((item) => item.value.trim() && !item.submitted)
            ? ` · ${t("Draft saved")}`
            : ""}
        </span>
      </header>

      <div className="space-y-4 p-4">
        <div className="prose-cognivoy text-[15px] font-medium">
          <Markdown content={question.question} />
        </div>

        {blockingGenerationError ? (
          <div className="rounded-xl border border-warning-border bg-warning-muted p-4 text-sm text-foreground">
            <div className="flex items-center gap-2 font-medium text-warning">
              <CircleAlert size={16} />
              {t("This question could not be generated")}
            </div>
            <p className="mt-2 text-muted-foreground">{question.explanation}</p>
            {question.retryable && onRegenerateMissing && (
              <Button
                className="mt-3"
                variant="outline"
                size="sm"
                onClick={() => onRegenerateMissing(question)}
              >
                <RotateCcw size={13} />
                {t("Regenerate missing question")}
              </Button>
            )}
          </div>
        ) : choiceOptions ? (
          <div
            className="grid gap-2"
            role={multipleChoice ? "group" : "radiogroup"}
            aria-label={multipleChoice ? t("Select all that apply") : undefined}
          >
            {choiceOptions.map(([key, label]) => (
              <button
                key={key}
                type="button"
                role={multipleChoice ? "checkbox" : "radio"}
                aria-checked={
                  multipleChoice
                    ? selectedChoiceKeys.includes(key.toUpperCase())
                    : answer.value === key
                }
                disabled={answer.submitted}
                onClick={() => {
                  if (!multipleChoice) {
                    updateValue(key);
                    return;
                  }
                  const normalizedKey = key.toUpperCase();
                  const next = selectedChoiceKeys.includes(normalizedKey)
                    ? selectedChoiceKeys.filter((item) => item !== normalizedKey)
                    : [...selectedChoiceKeys, normalizedKey].sort();
                  updateValue(next.join(","));
                }}
                className={cn(
                  "flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left text-sm transition-colors",
                  (multipleChoice
                    ? selectedChoiceKeys.includes(key.toUpperCase())
                    : answer.value === key)
                    ? "border-primary bg-primary-muted text-foreground"
                    : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="font-semibold">{key.toUpperCase()}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        ) : (
          <Textarea
            value={answer.value}
            disabled={answer.submitted}
            onChange={(event) => updateValue(event.target.value)}
            rows={isFillInBlankQuizQuestion(question.question_type) ? 1 : 4}
            placeholder={t("Your answer")}
            aria-label={t("Your answer")}
          />
        )}

        {!blockingGenerationError && !choiceOptions && (
          <div className="space-y-2">
            {currentImages.length > 0 && (
              <div
                className="flex flex-wrap gap-2"
                aria-label={t("Answer images")}
                data-testid="quiz-answer-images"
              >
                {currentImages.map((image) => (
                  <figure
                    key={image.id}
                    className="group relative h-20 w-20 overflow-hidden rounded-lg border border-border bg-muted-subtle"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- data/attachment preview */}
                    <img
                      src={image.preview}
                      alt={image.filename}
                      className="h-full w-full object-cover"
                    />
                    {!answer.submitted && (
                      <button
                        type="button"
                        onClick={() => removeAnswerImage(image.id)}
                        className="absolute right-1 top-1 rounded-md bg-background p-1 text-muted-foreground shadow-hairline hover:text-destructive"
                        aria-label={`${t("Remove")} ${image.filename}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </figure>
                ))}
              </div>
            )}
            {!answer.submitted && currentImages.length < 4 && (
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground hover:text-foreground">
                <ImagePlus size={14} />
                {t("Attach answer image")}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="sr-only"
                  aria-label={t("Attach answer image")}
                  onChange={(event) => {
                    void addAnswerImages(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
            )}
            {imageError && (
              <p className="text-xs text-destructive" role="alert">
                {imageError}
              </p>
            )}
          </div>
        )}

        {!blockingGenerationError && !answer.submitted ? (
          <Button
            onClick={submit}
            disabled={
              !answer.value.trim() &&
              !(requiresAiGrading(question) && currentImages.length > 0)
            }
            data-testid="quiz-submit-answer"
          >
            <Check size={14} />
            {t("Submit")}
          </Button>
        ) : !blockingGenerationError ? (
          <div className="space-y-3">
            <div
              className={cn(
                "rounded-xl border p-3 text-sm",
                answer.correct === null
                  ? "border-border bg-muted-subtle text-muted-foreground"
                  : answer.correct
                  ? "border-success-border bg-success-muted text-success"
                  : "border-destructive-border bg-destructive-muted text-destructive",
              )}
              data-testid="quiz-answer-result"
            >
              <div className="flex items-center gap-2 font-medium">
                {answer.correct === null ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : answer.correct ? (
                  <Check size={15} />
                ) : (
                  <X size={15} />
                )}
                {answer.correct === null
                  ? t("AI is grading your answer…")
                  : answer.correct
                    ? t("Correct")
                    : t("Incorrect")}
              </div>
              {answer.correct === false && (
                <p className="mt-2 text-foreground">
                  {t("Reference answer")}: {question.correct_answer}
                </p>
              )}
              {question.explanation && (
                <div className="mt-2 text-foreground">
                  <Markdown content={question.explanation} />
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => judge(requiresAiGrading(question))}
                disabled={judgment.loading}
              >
                {judgment.loading ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Sparkles size={13} />
                )}
                {t("AI feedback")}
              </Button>
              <Button variant="ghost" size="sm" onClick={retry}>
                <RotateCcw size={13} />
                {t("Try again")}
              </Button>
              {notebookEntry && (
                <Button variant="ghost" size="sm" onClick={toggleBookmark}>
                  <Bookmark
                    size={13}
                    className={notebookEntry.bookmarked ? "fill-current" : ""}
                  />
                  {notebookEntry.bookmarked ? t("Bookmarked") : t("Bookmark")}
                </Button>
              )}
              {onFollowup && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    onFollowup(
                      question,
                      answer.value,
                      answer.correct,
                      judgment.text,
                    )
                  }
                >
                  <MessageCircleQuestion size={13} />
                  {t("Ask a follow-up")}
                </Button>
              )}
              {notebookEntry && categories.length > 0 && (
                <select
                  aria-label={t("Add to category")}
                  defaultValue=""
                  onChange={(event) => {
                    const categoryId = Number(event.target.value);
                    if (categoryId) void assignCategory(categoryId);
                    event.target.value = "";
                  }}
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                >
                  <option value="">{t("Add to category")}</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {(judgment.text || judgment.error) && (
              <div className="rounded-xl bg-muted-subtle p-3 text-sm text-foreground">
                {judgment.assessment && (
                  <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="outline">{t("AI assessment")}</Badge>
                    <span>
                      {t("Score")}: {judgment.assessment.score}/
                      {judgment.assessment.max_score}
                    </span>
                    <span>
                      {t("Confidence")}: {Math.round(judgment.assessment.confidence * 100)}%
                    </span>
                    {judgment.assessment.review_recommended && (
                      <span className="font-medium text-warning">
                        {t("Review recommended")}
                      </span>
                    )}
                  </div>
                )}
                {judgment.error || <Markdown content={judgment.text} />}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <footer className="flex items-center justify-between border-t border-border px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          disabled={safeIndex === 0}
          onClick={() => setIndex((current) => current - 1)}
          aria-label={t("Previous question")}
        >
          <ChevronLeft size={14} />
          {t("Previous question")}
        </Button>
        {results.length === questions.length && questions.length > 0 && (
          <span className="text-xs font-medium text-foreground" data-testid="quiz-score">
            {t("Score")}: {score}/{questions.length}
            {saveState === "saving" ? ` · ${t("Saving…")}` : ""}
            {saveState === "saved" ? ` · ${t("Saved")}` : ""}
            {scheduledReviews > 0
              ? ` · ${t("Review reminder scheduled")}`
              : ""}
            {saveState === "error" ? ` · ${t("Save failed")}` : ""}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={
            safeIndex >= questions.length - 1 ||
            (answer.submitted && answer.correct === null)
          }
          onClick={() => setIndex((current) => current + 1)}
          aria-label={t("Next question")}
        >
          {t("Next question")}
          <ChevronRight size={14} />
        </Button>
      </footer>
    </section>
  );
}
