export function questionOptionFeedbackState({
  answerVisible,
  isCorrectAnswer,
  isUserAnswer,
  entryIsCorrect,
}: {
  answerVisible: boolean;
  isCorrectAnswer: boolean;
  isUserAnswer: boolean;
  entryIsCorrect: boolean;
}) {
  return {
    revealCorrectAnswer: answerVisible && isCorrectAnswer,
    revealWrongPick: answerVisible && isUserAnswer && !entryIsCorrect,
  };
}
