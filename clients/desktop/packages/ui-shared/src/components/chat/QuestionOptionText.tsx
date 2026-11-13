import type { JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

/** Full option text shared by composer questions and transcript questions. */
export function QuestionOptionText({
  id,
  label,
  description,
  descriptionStyle = 'standard',
}: {
  /** Names the option's control through `aria-labelledby`. */
  readonly id?: string;
  readonly label: string;
  readonly description?: string;
  readonly descriptionStyle?: 'standard' | 'caption';
}): JSX.Element {
  // The text is conversation content: replay blocks it, and the control
  // takes its name from it rather than from an attribute replay records.
  return (
    <>
      <span
        id={id}
        className={`${REPLAY_BLOCK_CLASS} block whitespace-normal wrap-anywhere`}
      >
        {label}
      </span>
      {description && (
        <span
          className={`${REPLAY_BLOCK_CLASS} block whitespace-normal wrap-anywhere ${descriptionStyle === 'caption' ? 'text-xs fg-secondary' : 'fg-tertiary'}`}
        >
          {description}
        </span>
      )}
    </>
  );
}
