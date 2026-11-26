import type { JSX, ReactNode } from 'react';
import { statusBadgeClassName, type StatusBadgeTone } from '../lib/row-chips';

/**
 * Visual variants for {@link StatusBadge}. Mirrors the desktop pipeline /
 * background-process palette so both apps can render identical pill styling.
 */
export type StatusBadgeVariant =
  | 'active'
  | 'muted'
  | 'warning'
  | 'destructive'
  | 'success';

export interface StatusBadgeProps {
  /** Variant chooses the color palette. */
  variant: StatusBadgeVariant;
  /** Render the badge in a low-opacity "muted" form (used for completed-row
   * status pills next to a deemphasized timestamp). */
  muted?: boolean;
  /** Label rendered inside the pill. Falls back to children. */
  label?: ReactNode;
  /** Test ID hook for automation. */
  dataTestId?: string;
  /** Optional override for the rounded-full chrome (extremely rare). */
  className?: string;
  children?: ReactNode;
}

/**
 * Variant → shared status-badge tone. `warning` is the warning tone; it used
 * to paint the unread blue, which made "Invited" read as a run state.
 */
function toStatusBadgeTone(variant: StatusBadgeVariant): StatusBadgeTone {
  switch (variant) {
    case 'active':
      return 'active';
    case 'success':
      return 'success';
    case 'destructive':
      return 'failed';
    case 'warning':
      return 'warning';
    case 'muted':
    default:
      return 'paused';
  }
}

/**
 * Pill-shaped status badge used across pipeline runs, background processes,
 * scripts/hooks ribbons, and other ad-hoc status callouts. Pure display:
 * caller supplies the variant and label text. Geometry and tint come from
 * the shared `statusBadgeClassName` builder so this badge matches every
 * other chip in a pipeline run row.
 */
export function StatusBadge({
  variant,
  muted = false,
  label,
  children,
  dataTestId,
  className,
}: StatusBadgeProps): JSX.Element {
  const content = label ?? children;
  const classes = className
    ? className
    : `shrink-0 ${statusBadgeClassName(toStatusBadgeTone(variant), { muted })}`;
  return (
    <span data-testid={dataTestId} className={classes}>
      {content}
    </span>
  );
}
