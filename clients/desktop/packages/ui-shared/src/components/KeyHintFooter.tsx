import type { JSX } from 'react';
import { Kbd } from '../primitives/Kbd';

export interface KeyHint {
  /** The keys, as for `Kbd`. */
  readonly shortcut: string | readonly string[];
  /** What the keys do, as a short verb (`move`, `open`, `close`). */
  readonly label: string;
}

export interface KeyHintFooterProps {
  hints: readonly KeyHint[];
  'data-testid'?: string;
}

/**
 * The key legend along the bottom of a picker or palette: each hint is its
 * caps followed by a one-word verb, left aligned above a hairline.
 */
export function KeyHintFooter({
  hints,
  'data-testid': testId = 'key-hint-footer',
}: KeyHintFooterProps): JSX.Element {
  return (
    <div
      className="flex shrink-0 items-center gap-4 border-t px-4 py-2.5 text-xs fg-quaternary"
      data-testid={testId}
    >
      {hints.map((hint, index) => (
        <span
          key={`${hint.label}-${index}`}
          className="inline-flex items-center gap-1.5"
        >
          <Kbd shortcut={hint.shortcut} data-testid="key-hint-keys" />
          <span>{hint.label}</span>
        </span>
      ))}
    </div>
  );
}
