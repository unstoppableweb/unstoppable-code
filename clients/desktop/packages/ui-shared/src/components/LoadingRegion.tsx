'use client';

import type { JSX } from 'react';
import {
  LOADING_PLACEHOLDER_DELAY_MS,
  SLOW_LOAD_NOTE_DELAY_MS,
  useDelayedFlag,
} from '../lib/useDelayedFlag';
import { CenteredLoadingSpinner } from '../primitives/CenteredLoadingSpinner';
import { SlowLoadNote } from './SlowLoadNote';

export interface LoadingRegionProps {
  /** Fill a bounded panel, or reserve the loading body's natural height in a dialog. */
  readonly layout: 'fill' | 'intrinsic';
  /** One sentence naming what is still loading; its wrapped height is reserved. */
  readonly slowNote?: string;
  readonly delayMs?: number;
  readonly slowAfterMs?: number;
}

/**
 * A delayed loading body for content whose shape is unknown (a viewer or
 * lazy panel). The body owns centering and the delayed note's reserved line.
 * Measurable content continues to use a skeleton in DelayedLoadingPlaceholder.
 */
export function LoadingRegion({
  layout,
  slowNote,
  delayMs = LOADING_PLACEHOLDER_DELAY_MS,
  slowAfterMs = SLOW_LOAD_NOTE_DELAY_MS,
}: LoadingRegionProps): JSX.Element {
  const visible = useDelayedFlag(true, delayMs);
  const slow = useDelayedFlag(slowNote !== undefined, slowAfterMs);
  // Preserve an unsized dialog's old 14px indicator plus its two 3rem margins.
  // Bounded panels use their available track instead, without those margins
  // making a full-height spinner overflow its parent.
  const body =
    layout === 'fill'
      ? 'minmax(0, 1fr)'
      : 'minmax(calc(var(--spacing) * 24 + 14px), 1fr)';
  return (
    <div
      data-testid="delayed-loading-placeholder"
      data-loading-region={layout}
      data-visible={visible ? 'true' : 'false'}
      className={`${layout === 'fill' ? 'grid h-full min-h-0 flex-1' : 'grid'} ${slowNote === undefined ? '' : 'gap-3'} ${visible ? '' : 'invisible'}`}
      style={{
        gridTemplateRows: body + (slowNote === undefined ? '' : ' auto'),
      }}
    >
      <CenteredLoadingSpinner />
      {slowNote === undefined ? null : (
        <div className="relative">
          {/* This copy measures the real wrapped line; only SlowLoadNote is announced. */}
          <span
            aria-hidden="true"
            className="invisible block text-pretty text-xs fg-tertiary"
          >
            {slowNote}
          </span>
          <SlowLoadNote show={slow} className="absolute inset-0">
            {slowNote}
          </SlowLoadNote>
        </div>
      )}
    </div>
  );
}
