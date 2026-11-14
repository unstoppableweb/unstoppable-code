import type { JSX } from 'react';
import { Kbd } from './Kbd';

/**
 * The key hint after an offered prompt suggestion in the composer's
 * placeholder: one Tab cap. The placeholder spaces it from the text. Screen
 * readers hear the instruction rather than the key cap.
 */
export function PromptSuggestionKeyHint(): JSX.Element {
  return (
    <span className="inline-flex" data-testid="prompt-suggestion-key-hint">
      <Kbd shortcut={['Tab']} aria-hidden />
      <span className="sr-only">Press Tab to use this suggestion</span>
    </span>
  );
}
