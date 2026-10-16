export interface QuizDraftAnswer {
  value: string;
  submitted: boolean;
  correct: boolean | null;
}

export type QuizDraftAnswers = Record<string, QuizDraftAnswer>;

interface QuizDraftEnvelope {
  version: 1;
  answers: QuizDraftAnswers;
}

export function buildQuizDraftKey(sessionId: string, turnId: string): string {
  return `cognivoy.quiz-draft.v1:${encodeURIComponent(sessionId)}:${encodeURIComponent(turnId)}`;
}

export function serializeQuizDraft(answers: QuizDraftAnswers): string {
  const envelope: QuizDraftEnvelope = { version: 1, answers };
  return JSON.stringify(envelope);
}

export function parseQuizDraft(
  raw: string | null | undefined,
  questionIds: string[],
): QuizDraftAnswers {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<QuizDraftEnvelope>;
    if (parsed.version !== 1 || !parsed.answers || typeof parsed.answers !== "object") {
      return {};
    }
    const allowed = new Set(questionIds);
    const result: QuizDraftAnswers = {};
    for (const [questionId, candidate] of Object.entries(parsed.answers)) {
      if (!allowed.has(questionId) || !candidate || typeof candidate !== "object") continue;
      const answer = candidate as Partial<QuizDraftAnswer>;
      if (
        typeof answer.value !== "string" ||
        typeof answer.submitted !== "boolean" ||
        !(
          answer.correct === null ||
          typeof answer.correct === "boolean"
        )
      ) {
        continue;
      }
      result[questionId] = {
        value: answer.value,
        // A subjective answer can be refreshed while the judge stream is in
        // flight. Never restore that as a permanently spinning submission;
        // keep the text and let the learner submit it again.
        submitted: answer.submitted && answer.correct !== null,
        correct: answer.correct,
      };
    }
    return result;
  } catch {
    return {};
  }
}
