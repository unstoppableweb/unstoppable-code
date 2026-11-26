import type { JSX } from 'react';
import type { LedgerStatus } from '@canopy/protocol/canopy-core';
import { OPERATIONAL_STATUS_COLORS } from '../lib/operational-status-colors';
import { Tooltip } from '../primitives/Tooltip';

export const PROGRESS_DOTS_MAX = 24;

export interface ProgressDotsProps {
  /** Leaf task statuses in tree order; at most the first PROGRESS_DOTS_MAX are drawn. */
  readonly statuses: readonly LedgerStatus[];
  /** Counts by status over every leaf task; defaults to counting `statuses`. Its sum is the total. */
  readonly counts?: Readonly<Partial<Record<LedgerStatus, number>>>;
  /** The cell's width class; default `w-28`. Applies to empty, dotted and text cells. */
  readonly width?: string;
  readonly testId?: string;
}

const DOT_INK: Readonly<Partial<Record<LedgerStatus, string>>> = {
  COMPLETED: OPERATIONAL_STATUS_COLORS.success.foreground,
  IN_PROGRESS: OPERATIONAL_STATUS_COLORS.active.foreground,
  BLOCKED: OPERATIONAL_STATUS_COLORS.failed.foreground,
  FAILED: OPERATIONAL_STATUS_COLORS.failed.foreground,
  NEEDS_REVIEW: 'fg-warning',
};

function countOf(
  statuses: readonly LedgerStatus[],
  counts: ProgressDotsProps['counts'],
  status: LedgerStatus,
): number {
  return counts === undefined
    ? statuses.filter((entry) => entry === status).length
    : (counts[status] ?? 0);
}

function progressLabel(
  statuses: readonly LedgerStatus[],
  counts: ProgressDotsProps['counts'],
  total: number,
): string {
  const parts = [
    `${countOf(statuses, counts, 'COMPLETED')} of ${total} tasks done`,
  ];
  const blocked = countOf(statuses, counts, 'BLOCKED');
  const failed = countOf(statuses, counts, 'FAILED');
  const review = countOf(statuses, counts, 'NEEDS_REVIEW');
  if (blocked > 0) parts.push(`${blocked} blocked`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (review > 0) parts.push(`${review} to review`);
  return parts.join(' · ');
}

function Dot({ status }: { readonly status: LedgerStatus }): JSX.Element {
  const ink = DOT_INK[status];
  const hollow = ink === undefined;
  return (
    <svg
      width={6}
      height={6}
      viewBox="0 0 6 6"
      aria-hidden="true"
      className={`shrink-0 ${ink ?? 'fg-tertiary'}`}
    >
      <circle
        cx={3}
        cy={3}
        r={hollow ? 2.5 : 3}
        fill={hollow ? 'none' : 'currentColor'}
        stroke="currentColor"
        strokeWidth={hollow ? 1 : 0}
      />
    </svg>
  );
}

/** Leaf task status dots with an accessible summary; the caller owns the data. */
export function ProgressDots({
  statuses,
  counts,
  width = 'w-28',
  testId,
}: ProgressDotsProps): JSX.Element {
  const total =
    counts === undefined
      ? statuses.length
      : Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);

  if (total === 0) {
    return (
      <span data-testid={testId} className={`flex h-6 shrink-0 ${width}`} />
    );
  }

  const label = progressLabel(statuses, counts, total);
  return (
    <Tooltip label={label}>
      <span
        role="img"
        aria-label={label}
        data-testid={testId}
        className={`flex h-6 shrink-0 cursor-default items-center ${width}`}
      >
        {total > PROGRESS_DOTS_MAX ? (
          <span className="text-2xs tabular-nums fg-tertiary">
            {countOf(statuses, counts, 'COMPLETED')} of {total} done
          </span>
        ) : (
          <span className="inline-flex flex-wrap items-center gap-0.5">
            {statuses.slice(0, PROGRESS_DOTS_MAX).map((status, index) => (
              <Dot key={`${status}-${index}`} status={status} />
            ))}
          </span>
        )}
      </span>
    </Tooltip>
  );
}
