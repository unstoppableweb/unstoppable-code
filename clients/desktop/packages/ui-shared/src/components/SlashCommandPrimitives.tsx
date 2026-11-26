import type { JSX } from 'react';
import { Badge } from '../primitives/Badge';
import { LoadingSpinner } from '../primitives/LoadingSpinner';

/** Selecting this row explicitly enables it before insertion. */
export function SlashCommandAvailabilityTag(): JSX.Element {
  return (
    <Badge
      muted
      className="shrink-0"
      data-testid="slash-command-availability-tag"
    >
      Available · enable
    </Badge>
  );
}

/** Pending spinner while a slash command enables. */
export function SlashCommandPendingSpinner(): JSX.Element {
  return <LoadingSpinner decorative sizePx={14} />;
}

export interface SlashCommandAvailableDividerProps {
  testId?: string;
}

/**
 * The "Available to enable" section divider rendered once before the first
 * `section: 'available'` row, so slash-row surfaces cannot let the divider
 * markup drift.
 */
export function SlashCommandAvailableDivider({
  testId = 'slash-command-available-divider',
}: SlashCommandAvailableDividerProps): JSX.Element {
  return (
    <SlashCommandGroupHeading
      label="Available to enable"
      divider
      testId={testId}
    />
  );
}

/** Shared heading for collected groups and contiguous ranked runs. */
export function SlashCommandGroupHeading({
  label,
  compact = false,
  divider = false,
  testId,
}: {
  label: string;
  compact?: boolean;
  divider?: boolean;
  testId?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      role="presentation"
      className={
        compact
          ? 'px-2 pb-0.5 pt-2 text-xs fg-tertiary'
          : `px-3 pb-1 ${divider ? 'relative pt-3 before:pointer-events-none before:absolute before:inset-x-0 before:top-1 before:h-[var(--border-hairline)] before:bg-line-base' : 'pt-2'} text-xs font-medium fg-secondary`
      }
    >
      {label}
    </div>
  );
}
