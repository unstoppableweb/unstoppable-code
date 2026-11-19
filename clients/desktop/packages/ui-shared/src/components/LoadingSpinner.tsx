'use client';

import type { JSX } from 'react';
import { cometTone, type SpinnerTone } from './spinner-tone';
import { CometSpinner } from './CometSpinner';

interface LoadingSpinnerProps {
  /** Placement only: margin, alignment, and flex participation. */
  className?: string;
  /** Ink of the ring. Defaults to the surrounding text color. */
  tone?: SpinnerTone;
  /** Reads beneath an adjacent label, such as inside an action button. */
  quiet?: boolean;
  /**
   * Width and height in px, for a spinner that shares a slot with sized
   * icons. Defaults to 10px.
   */
  sizePx?: number;
  /**
   * Stable hook for asserting "this affordance is busy" (CAN-2349 decision 4).
   * The spinner renders inside the button that started the work, so tests
   * scope the query to that button rather than to a page-wide spinner count.
   */
  dataTestId?: string;
  /**
   * Mark the spinner as presentational, for the case where it sits INSIDE a
   * control that is already named.
   *
   * A descendant `aria-label` is folded into the accessible name an ancestor
   * button computes from its contents, so a busy button rendering this spinner
   * next to "Saving…" otherwise announces as "Loading Saving…". Standalone
   * spinners — the common case across the app, and what existing tests query by
   * `[aria-label="Loading"]` — keep the label, so this is opt-in rather than a
   * change of default.
   */
  decorative?: boolean;
}

/** The spinner's box when a host gives no size. */
const DEFAULT_SIZE_PX = 10;

/**
 * The shared "loading" spinner: the comet ring, named "Loading" unless it is
 * decorative.
 */
export function LoadingSpinner({
  className = '',
  tone = 'inherit',
  quiet = false,
  sizePx,
  dataTestId,
  decorative = false,
}: LoadingSpinnerProps): JSX.Element {
  return (
    <CometSpinner
      className={className}
      tone={cometTone(tone)}
      quiet={quiet}
      sizePx={sizePx ?? DEFAULT_SIZE_PX}
      ariaLabel={decorative ? undefined : 'Loading'}
      dataTestId={dataTestId}
    />
  );
}
