/**
 * Shared types for Quiz Generation (deep_question capability).
 */

import {
  type NormalizedQuizQuestionType,
  normalizeQuizQuestionType,
} from "./quiz-question-type";

export type DeepQuestionMode = "custom" | "mimic";

export interface DeepQuestionFormConfig {
  mode: DeepQuestionMode;
  topic: string;
  num_questions: number;
  difficulty: string;
  /**
   * Multi-select allowed-types whitelist. Empty list = "auto" (planner
   * picks any type per question). When ≥1 type is selected, the planner
   * is restricted to those types.
   */
  question_types: NormalizedQuizQuestionType[];
  /**
   * Per-type quantity targets (sums to num_questions when non-empty).
   * Only populated when ≥2 types are selected and the user has tweaked
   * the ratio bar; empty means "distribute evenly across allowed types".
   */
  per_type_counts: Partial<Record<NormalizedQuizQuestionType, number>>;
  paper_path: string;
  max_questions: number;
}

export const DEFAULT_QUIZ_CONFIG: DeepQuestionFormConfig = {
  mode: "custom",
  topic: "",
  num_questions: 3,
  difficulty: "auto",
  question_types: [],
  per_type_counts: {},
  paper_path: "",
  max_questions: 10,
};

export interface QuizQuestion {
  question_id: string;
  question: string;
  question_type: NormalizedQuizQuestionType;
  options?: Record<string, string>;
  correct_answer: string;
  explanation: string;
  difficulty?: string;
  concentration?: string;
  knowledge_context?: string;
  knowledge_points?: string[];
  source_refs?: Array<Record<string, unknown>>;
  rubric?: Record<string, unknown>;
  generation_error?: string;
  retryable?: boolean;
}

function structuredQuestionMetadata(
  qa: Record<string, unknown>,
): Record<string, unknown> {
  return qa.metadata && typeof qa.metadata === "object"
    ? (qa.metadata as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return result.length ? result : undefined;
}

function objectList(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
  return result.length ? result : undefined;
}

/** Decode the judge's required leading verdict in both supported locales. */
export function parseQuizJudgeVerdict(text: string): boolean | null {
  const verdict = text.trim().slice(0, 160).toLowerCase();
  if (
    verdict.includes("❌") ||
    verdict.includes("⚠️") ||
    verdict.includes("incorrect") ||
    verdict.includes("partially correct") ||
    verdict.includes("不正确") ||
    verdict.includes("部分正确")
  ) {
    return false;
  }
  if (
    verdict.includes("✅") ||
    /\bcorrect\b/.test(verdict) ||
    verdict.includes("正确")
  ) {
    return true;
  }
  return null;
}

export interface QuizJudgeAssessment {
  verdict: "correct" | "partial" | "incorrect";
  confidence: number;
  score: number;
  max_score: number;
  review_recommended: boolean;
}

export function normalizeQuizJudgeAssessment(
  value: unknown,
): QuizJudgeAssessment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const verdict = candidate.verdict;
  const confidence = Number(candidate.confidence);
  const score = Number(candidate.score);
  const maxScore = Number(candidate.max_score);
  if (
    (verdict !== "correct" && verdict !== "partial" && verdict !== "incorrect") ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1 ||
    !Number.isFinite(score) ||
    !Number.isFinite(maxScore) ||
    maxScore <= 0 ||
    score < 0 ||
    score > maxScore
  ) {
    return null;
  }
  return {
    verdict,
    confidence,
    score,
    max_score: maxScore,
    review_recommended:
      candidate.review_recommended === true || confidence < 0.7 || verdict === "partial",
  };
}

export interface QuizFollowupContext {
  parent_quiz_session_id?: string;
  question_id: string;
  question: string;
  question_type: QuizQuestion["question_type"];
  options?: Record<string, string>;
  correct_answer: string;
  explanation: string;
  difficulty?: string;
  concentration?: string;
  knowledge_context?: string;
  user_answer?: string;
  is_correct?: boolean;
  /**
   * Filenames of the images the learner attached as their answer. Image
   * bytes ride on the first follow-up message as regular attachments so
   * vision-capable models see them; the filenames here let the follow-up
   * system prompt mention them explicitly so the LLM knows the attached
   * images are the learner's answer, not unrelated context.
   */
  user_answer_image_filenames?: string[];
  /** Latest AI judgment text for this question, when one has been run. */
  ai_judgment?: string;
}

/**
 * Extract QuizQuestion[] from per-question ``content`` events emitted live
 * by the new ``QuestionPipeline`` while the quizzing phase is running.
 *
 * The backend tags each event with ``metadata.call_kind ===
 * "quiz_question_emitted"`` and the structured ``qa_pair`` payload. We
 * collect them, dedupe by ``question_id``, and order by
 * ``question_index`` so QuizViewer can render each question the moment
 * it lands — without waiting for the final ``result`` event.
 *
 * Returns ``null`` until at least one valid quiz event has arrived, so
 * the caller can fall back to the legacy ``extractQuizQuestions`` shape
 * for older (mimic) result envelopes.
 */
export function extractStreamingQuizQuestions(
  events: Array<{
    type?: string;
    metadata?: Record<string, unknown> | undefined;
  }>,
): QuizQuestion[] | null {
  if (!Array.isArray(events) || events.length === 0) return null;
  const byId = new Map<string, { idx: number; qa: QuizQuestion }>();
  for (const event of events) {
    if (event.type !== "content") continue;
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    if (meta.call_kind !== "quiz_question_emitted") continue;
    const qa = meta.qa_pair as Record<string, unknown> | undefined;
    if (!qa || typeof qa !== "object" || !qa.question) continue;
    const idx = Number(meta.question_index);
    const question: QuizQuestion = {
      question_id: String(qa.question_id ?? ""),
      question: String(qa.question ?? ""),
      question_type: normalizeQuizQuestionType(qa.question_type),
      options: qa.options as Record<string, string> | undefined,
      correct_answer: String(qa.correct_answer ?? ""),
      explanation: String(qa.explanation ?? ""),
      difficulty: qa.difficulty ? String(qa.difficulty) : undefined,
      concentration: qa.concentration ? String(qa.concentration) : undefined,
      knowledge_context:
        qa.metadata &&
        typeof qa.metadata === "object" &&
        "knowledge_context" in qa.metadata &&
        qa.metadata.knowledge_context
          ? String(qa.metadata.knowledge_context)
          : undefined,
      knowledge_points:
        stringList(qa.knowledge_points) ??
        stringList(structuredQuestionMetadata(qa).knowledge_points) ??
        (qa.concentration ? [String(qa.concentration)] : undefined),
      source_refs:
        objectList(qa.source_refs) ??
        objectList(structuredQuestionMetadata(qa).source_refs),
      rubric:
        qa.rubric && typeof qa.rubric === "object" && !Array.isArray(qa.rubric)
          ? (qa.rubric as Record<string, unknown>)
          : structuredQuestionMetadata(qa).rubric &&
              typeof structuredQuestionMetadata(qa).rubric === "object" &&
              !Array.isArray(structuredQuestionMetadata(qa).rubric)
            ? (structuredQuestionMetadata(qa).rubric as Record<string, unknown>)
            : undefined,
      generation_error:
        typeof structuredQuestionMetadata(qa).error === "string"
          ? String(structuredQuestionMetadata(qa).error)
          : undefined,
      retryable: structuredQuestionMetadata(qa).retryable === true,
    };
    const key = question.question_id || String(idx);
    byId.set(key, {
      idx: Number.isFinite(idx) ? idx : byId.size,
      qa: question,
    });
  }
  if (byId.size === 0) return null;
  return Array.from(byId.values())
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.qa);
}

/**
 * Resolve the turn identity of a quiz message from its event stream.
 *
 * Quiz answer state is scoped per turn: the notebook unique key is
 * ``(session_id, turn_id, question_id)`` and positional question ids
 * (``q_1``..``q_N``) repeat across quizzes in one session. During
 * generation the final ``result`` event hasn't landed yet, so the turn id
 * must come from the streamed events themselves — every unified-WS event
 * carries ``turn_id``. The ``result`` event stays authoritative when
 * present so the settled/persisted path is unchanged (issues #487 / #677).
 *
 * Returns ``null`` only for legacy persisted turns whose events predate
 * ``turn_id``; QuizViewer renders those cards local-only (no notebook
 * reads or writes), so they can never inherit another turn's answers.
 */
export function extractQuizTurnId(
  events: Array<{ type?: string; turn_id?: string }> | undefined,
): string | null {
  if (!Array.isArray(events)) return null;
  const result = events.find(
    (event) => event.type === "result" && event.turn_id,
  );
  if (result?.turn_id) return result.turn_id;
  return events.find((event) => event.turn_id)?.turn_id ?? null;
}

/**
 * Extract QuizQuestion[] from the raw `result` event metadata returned by
 * the deep_question capability.
 */
export function extractQuizQuestions(
  resultMetadata: Record<string, unknown> | undefined,
): QuizQuestion[] | null {
  if (!resultMetadata) return null;
  const summary = resultMetadata.summary as Record<string, unknown> | undefined;
  if (!summary) return null;
  const results = summary.results as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(results) || results.length === 0) return null;

  const parsed: Array<QuizQuestion | null> = results.map((item) => {
    const qa = (item.qa_pair ?? item) as Record<string, unknown>;
    if (!qa.question) return null;
    const itemMetadata =
      item.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata)
        ? (item.metadata as Record<string, unknown>)
        : {};
    const qaMetadata = structuredQuestionMetadata(qa);
    const metadata = { ...itemMetadata, ...qaMetadata };
    const question: QuizQuestion = {
      question_id: String(qa.question_id ?? ""),
      question: String(qa.question ?? ""),
      question_type: normalizeQuizQuestionType(qa.question_type),
      options: qa.options as Record<string, string> | undefined,
      correct_answer: String(qa.correct_answer ?? ""),
      explanation: String(qa.explanation ?? ""),
      difficulty: qa.difficulty ? String(qa.difficulty) : undefined,
      concentration: qa.concentration ? String(qa.concentration) : undefined,
      knowledge_context:
        qa.metadata &&
        typeof qa.metadata === "object" &&
        "knowledge_context" in qa.metadata &&
        qa.metadata.knowledge_context
          ? String(qa.metadata.knowledge_context)
          : undefined,
      knowledge_points:
        stringList(qa.knowledge_points) ??
        stringList(metadata.knowledge_points) ??
        (qa.concentration ? [String(qa.concentration)] : undefined),
      source_refs:
        objectList(qa.source_refs) ??
        objectList(metadata.source_refs),
      rubric:
        qa.rubric && typeof qa.rubric === "object" && !Array.isArray(qa.rubric)
          ? (qa.rubric as Record<string, unknown>)
          : metadata.rubric &&
              typeof metadata.rubric === "object" &&
              !Array.isArray(metadata.rubric)
            ? (metadata.rubric as Record<string, unknown>)
            : undefined,
      generation_error:
        typeof metadata.error === "string" ? String(metadata.error) : undefined,
      retryable: metadata.retryable === true,
    };
    return question;
  });

  return parsed.filter(
    (question): question is QuizQuestion => question !== null,
  );
}

export function buildQuizRecoveryConfig(
  question: QuizQuestion,
): Record<string, unknown> {
  return {
    mode: "custom",
    topic: question.concentration?.trim() || question.question.trim(),
    num_questions: 1,
    difficulty: question.difficulty || "auto",
    question_types: [question.question_type],
  };
}

interface SimilarQuestionEntry {
  question: string;
  question_type: string;
  difficulty?: string;
  correct_answer?: string;
  explanation?: string;
  knowledge_points?: string[];
  source_refs?: Array<Record<string, unknown>>;
}

export function buildSimilarQuestionConfig(
  entry: SimilarQuestionEntry,
): Record<string, unknown> {
  return {
    mode: "custom",
    topic:
      entry.knowledge_points?.map((point) => point.trim()).find(Boolean) ||
      entry.question.trim(),
    num_questions: 1,
    difficulty: entry.difficulty || "auto",
    question_types: [normalizeQuizQuestionType(entry.question_type)],
    similar_to: {
      question: entry.question,
      correct_answer: entry.correct_answer || "",
      explanation: entry.explanation || "",
      source_refs: entry.source_refs || [],
    },
  };
}

export interface QuizFollowupExtras {
  /** Filenames of the learner's image answers (bytes ride on first msg). */
  userAnswerImageFilenames?: string[] | null;
  /** Last AI-judgment text for this question, if the learner ran it. */
  aiJudgment?: string | null;
}

export function buildQuizFollowupConfig(
  question: QuizQuestion,
  userAnswer: string,
  isCorrect: boolean | null,
  parentQuizSessionId?: string | null,
  extras?: QuizFollowupExtras,
): Record<string, unknown> {
  const filenames = (extras?.userAnswerImageFilenames ?? [])
    .map((name) => (typeof name === "string" ? name.trim() : ""))
    .filter((name) => name.length > 0);
  const context: QuizFollowupContext = {
    question_id: question.question_id,
    question: question.question,
    question_type: question.question_type,
    options: question.options,
    correct_answer: question.correct_answer,
    explanation: question.explanation,
    difficulty: question.difficulty,
    concentration: question.concentration,
    knowledge_context: question.knowledge_context,
    user_answer: userAnswer || undefined,
    is_correct: typeof isCorrect === "boolean" ? isCorrect : undefined,
    parent_quiz_session_id: parentQuizSessionId || undefined,
    user_answer_image_filenames: filenames.length > 0 ? filenames : undefined,
    ai_judgment: extras?.aiJudgment?.trim() || undefined,
  };

  return {
    followup_question_context: context,
  };
}

function titleCase(value: string): string {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export const QUIZ_TYPE_LABEL_KEYS: Record<NormalizedQuizQuestionType, string> =
  {
    choice: "Multiple Choice",
    multiple_choice: "Select All That Apply",
    concept: "Concept Question",
    fill_in_blank: "Fill in the Blank",
    short_answer: "Short Answer",
    written: "Essay",
    coding: "Coding",
  };

/**
 * One-line summary of the quiz form, shown next to the collapsed `Settings`
 * chevron in the composer. Pass `translate` (`t` from `react-i18next`) so the
 * summary follows the active UI language.
 */
export function summarizeQuizConfig(
  cfg: DeepQuestionFormConfig,
  translate?: (key: string) => string,
): string {
  const tr = translate ?? ((s: string) => s);
  if (cfg.mode === "mimic") {
    const target = cfg.paper_path.trim() || tr("no paper");
    return [
      tr("Mimic Paper"),
      target,
      `${tr("Max")} ${cfg.max_questions}`,
    ].join(" · ");
  }
  const typeSummary =
    cfg.question_types.length === 0
      ? tr("Auto")
      : cfg.question_types.length === 1
        ? tr(QUIZ_TYPE_LABEL_KEYS[cfg.question_types[0]])
        : `${cfg.question_types.length} ${tr("types")}`;
  return [
    tr("Custom"),
    `${cfg.num_questions} ${tr("questions")}`,
    tr(titleCase(cfg.difficulty || "auto")),
    typeSummary,
  ].join(" · ");
}

/**
 * Build the `config` payload to send over WebSocket for a quiz generation
 * request.
 */
export function buildQuizWSConfig(
  cfg: DeepQuestionFormConfig,
): Record<string, unknown> {
  if (cfg.mode === "mimic") {
    return {
      mode: "mimic",
      paper_path: cfg.paper_path.trim(),
      max_questions: cfg.max_questions,
    };
  }
  // Only forward per-type counts when >=2 types are selected AND the user
  // actually populated counts that sum to num_questions. Otherwise let
  // the backend distribute freely across the allowed set.
  const countsValid =
    cfg.question_types.length >= 2 &&
    Object.keys(cfg.per_type_counts).length > 0 &&
    Object.values(cfg.per_type_counts).reduce((sum, v) => sum + (v || 0), 0) ===
      cfg.num_questions;
  return {
    mode: "custom",
    num_questions: cfg.num_questions,
    difficulty: cfg.difficulty === "auto" ? "" : cfg.difficulty,
    question_types: cfg.question_types,
    per_type_counts: countsValid ? cfg.per_type_counts : {},
  };
}
