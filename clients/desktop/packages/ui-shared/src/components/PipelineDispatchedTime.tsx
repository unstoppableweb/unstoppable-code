import type { ReactElement } from 'react';
import { formatRelativeTime } from '../lib/format-relative-time';
import {
  formatTimingTimestamp,
  parseIsoToEpoch,
} from '../lib/pipeline-timing-display';
import { Tooltip } from '../primitives/Tooltip';

export interface PipelineDispatchedTimeProps {
  /** ISO start of the run. */
  readonly startedAt: string | undefined;
  /**
   * `row` (default) sits among a run row's badges; `menu` right-aligns in a
   * linked-runs menu entry after the run's name and status.
   */
  readonly variant?: 'row' | 'menu';
  /** Epoch ms; tests pass a fixed value. Defaults to Date.now(). */
  readonly now?: number;
  readonly testId?: string;
}

/**
 * "Dispatched 2h ago" whose tooltip shows the full local date and time, in the
 * same format as the run detail's Started field. Renders nothing until the
 * run's start is known, so a missing start never reads as "just now".
 *
 * Deliberate DESIGN.md deviation (Accessibility: "Hover tooltips belong to
 * icon-only controls…"): the hover adds the exact time and never repeats the
 * label, the same exception the Ledger's row times use. Keyboard users get the
 * exact time from the run detail instead.
 */
export function PipelineDispatchedTime({
  startedAt,
  variant = 'row',
  now,
  testId,
}: PipelineDispatchedTimeProps): ReactElement | null {
  if (startedAt === undefined || parseIsoToEpoch(startedAt) === null) {
    return null;
  }
  return (
    <Tooltip
      label={formatTimingTimestamp(startedAt)}
      className={variant === 'menu' ? 'ml-auto' : undefined}
    >
      <time
        dateTime={startedAt}
        className={
          variant === 'menu'
            ? 'pl-4 text-3xs fg-secondary'
            : 'text-2xs fg-secondary/60'
        }
        data-testid={testId}
      >
        Dispatched {formatRelativeTime(startedAt, now)}
      </time>
    </Tooltip>
  );
}
