import type {
  RemoteControlAskUserQuestion,
  RemoteControlAskUserQuestionAnswer,
} from './index';

/** Validate explicit controls against the stored prompt, before accepting answers. */
export function validateQuestionControlAnswers(
  questions: readonly RemoteControlAskUserQuestion[],
  answers: readonly RemoteControlAskUserQuestionAnswer[],
): string | undefined {
  if (!questions.some((q) => q.control !== undefined || q.required))
    return undefined;
  if (answers.length !== questions.length)
    return 'Answer every question before submitting.';
  for (let index = 0; index < questions.length; index++) {
    const question = questions[index];
    const answer = answers[index];
    const text = answer.freeformText?.trim() ?? '';
    const selected = answer.selectedOptions;
    if (answer.questionId !== undefined && answer.questionId !== question.id)
      return 'The answer does not match this question.';
    if (question.required && !text && !selected.length)
      return `Answer “${question.question}” before submitting.`;
    if (!question.control) continue;
    if (question.control === 'buttons' || question.control === 'select') {
      // A typed answer stands beside the options unless the provider cannot
      // accept one.
      if (
        (text && question.allowOther === false) ||
        (!question.multiSelect && selected.length > 1) ||
        new Set(selected).size !== selected.length ||
        selected.some((option) => !question.options.includes(option))
      )
        return `Choose an available option for “${question.question}”.`;
    } else {
      if (selected.length) return `Enter a value for “${question.question}”.`;
      if (
        text &&
        question.control === 'number' &&
        (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) ||
          !Number.isFinite(Number(text)))
      )
        return `Enter a valid number for “${question.question}”.`;
      if (text && question.control === 'date') {
        const date = new Date(`${text}T00:00:00.000Z`);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
          !Number.isFinite(date.getTime()) ||
          date.toISOString().slice(0, 10) !== text
        )
          return `Enter a valid date for “${question.question}”.`;
      }
    }
  }
  return undefined;
}
