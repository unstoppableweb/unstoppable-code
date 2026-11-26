'use client';

import type { JSX, ReactNode } from 'react';
import { Notice } from '../primitives/Notice';

/**
 * Bounded diff states, defined once so every diff surface (the shared
 * DiffViewer and desktop's line diff view) says the same thing the same way
 * (REG-3024). Copy is catalogued in docs/ux-writing.md.
 */

/** Why a diff answer is incomplete. */
export type DiffBoundKind = 'oversized' | 'truncated';

const DIFF_BOUND_COPY: Record<DiffBoundKind, string> = {
  oversized: 'This diff is too large to show in full. Showing the beginning.',
  truncated: 'Not every changed file is listed.',
};

export interface DiffBoundNoticeProps {
  readonly kind: DiffBoundKind;
  readonly className?: string;
}

/**
 * The inline notice above a cut patch (`oversized`) or a cut file list
 * (`truncated`): the shared `Notice`, neutral, static page content.
 */
export function DiffBoundNotice({
  kind,
  className = '',
}: DiffBoundNoticeProps): JSX.Element {
  return (
    <Notice
      intent="neutral"
      role="none"
      className={className}
      data-testid={`diff-viewer-notice-${kind}`}
    >
      {DIFF_BOUND_COPY[kind]}
    </Notice>
  );
}

export interface DiffBinaryStateProps {
  readonly className?: string;
}

/** The diff area of a binary file, which has no text diff. */
export function DiffBinaryState({
  className = '',
}: DiffBinaryStateProps): JSX.Element {
  return (
    <div
      className={`flex min-h-0 flex-1 items-center justify-center px-6 text-s fg-secondary ${className}`}
      data-testid="diff-viewer-notice-binary"
    >
      Binary file. There is no text diff to show.
    </div>
  );
}

export interface DiffTurnUnavailableStateProps {
  /** The way to the comparison that is available, such as the branch's. */
  readonly action?: ReactNode;
  readonly className?: string;
}

/**
 * The diff area of a turn whose before and after trees were not saved. No
 * other comparison stands in for it; `action` offers one explicitly.
 */
export function DiffTurnUnavailableState({
  action,
  className = '',
}: DiffTurnUnavailableStateProps): JSX.Element {
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-s fg-secondary ${className}`}
      data-testid="diff-viewer-notice-turn-unavailable"
    >
      <p>{"This turn's changes weren't saved, so they can't be shown."}</p>
      {action}
    </div>
  );
}
