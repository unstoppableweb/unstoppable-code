import type { JSX, ReactNode } from 'react';

/**
 * The state a row status label reports. `destructive` (failed, expired,
 * disconnected) is the default; `attention` asks the user to act; `positive`
 * confirms a good outcome.
 */
export type StatusLabelTone = 'destructive' | 'attention' | 'positive';

/**
 * Type size of the label. `inherit` (the default) takes the row's own text
 * size, so the label reads as part of the row.
 */
export type StatusLabelSize = 'inherit' | '3xs' | '2xs' | 'xs' | 's';

const TONE_CLASS: Record<StatusLabelTone, string> = {
  destructive: 'fg-destructive',
  attention: 'fg-warning',
  positive: 'fg-success',
};

const SIZE_CLASS: Record<StatusLabelSize, string> = {
  inherit: '',
  '3xs': 'text-3xs',
  '2xs': 'text-2xs',
  xs: 'text-xs',
  s: 'text-s',
};

export interface StatusLabelProps {
  readonly children: ReactNode;
  readonly tone?: StatusLabelTone;
  readonly size?: StatusLabelSize;
  /** Placement only: margin, truncation, flex participation. */
  readonly className?: string;
  readonly title?: string;
  readonly id?: string;
  readonly 'data-testid'?: string;
}

/**
 * A failed (or attention, or good) status on a list row, in the state's ink:
 * `Expired`, `Disconnected`, `Failed`. This is the one place copy is tinted,
 * a deliberate exception to the notice rule (docs/design/feedback.md, "Row
 * status labels"). A failure that needs explaining or a retry is an
 * `ErrorBanner`, not a label.
 */
export function StatusLabel({
  children,
  tone = 'destructive',
  size = 'inherit',
  className = '',
  title,
  id,
  'data-testid': dataTestId,
}: StatusLabelProps): JSX.Element {
  const classes = [SIZE_CLASS[size], TONE_CLASS[tone], className]
    .filter(Boolean)
    .join(' ');
  return (
    <span id={id} title={title} data-testid={dataTestId} className={classes}>
      {children}
    </span>
  );
}
