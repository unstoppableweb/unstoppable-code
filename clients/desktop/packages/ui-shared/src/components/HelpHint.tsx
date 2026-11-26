import type { JSX } from 'react';
import { QuestionMarkIcon } from '../icons/AppIcons';
import { Tooltip } from '../primitives/Tooltip';

/**
 * A small muted question mark after a label that explains it (New
 * Customize's filter sections). Hovering, pressing or keyboard focus shows
 * the explanation; screen readers read it as the mark's name.
 */
export function HelpHint({
  label,
  help,
  testId,
}: {
  /** What the hint explains, for its accessible name: "About Status". */
  readonly label: string;
  readonly help: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <Tooltip label={help} clamp={false} showOnPress>
      <span
        role="img"
        tabIndex={0}
        aria-label={`About ${label}: ${help}`}
        data-testid={testId}
        className="focus-ring inline-flex shrink-0 items-center justify-center rounded-full fg-tertiary hover:fg-secondary"
      >
        <QuestionMarkIcon size="xs" aria-hidden />
      </span>
    </Tooltip>
  );
}
