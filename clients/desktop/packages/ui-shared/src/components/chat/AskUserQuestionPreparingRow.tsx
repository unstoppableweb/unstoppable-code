import type { JSX } from 'react';
import { ThinkingSpinner } from '../ThinkingSpinner';

/**
 * The agent's question is on its way: an answer was given or the question
 * hasn't reached the composer yet. One line, as wide as its text.
 */
export function AskUserQuestionPreparingRow(): JSX.Element {
  return (
    <div
      className="flex items-center gap-1.5 py-1 text-xs fg-secondary"
      data-testid="ask-user-question-preparing"
    >
      <ThinkingSpinner tone="accent" />
      <span>Preparing question…</span>
    </div>
  );
}
