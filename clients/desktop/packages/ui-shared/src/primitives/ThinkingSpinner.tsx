'use client';

import type { JSX } from 'react';
import { cometTone, type SpinnerTone } from './spinner-tone';
import { CometSpinner } from './CometSpinner';

interface ThinkingSpinnerProps {
  /** Placement only: margin, alignment, and flex participation. */
  className?: string;
  /** Ink of the ring. Defaults to the surrounding text color. */
  tone?: SpinnerTone;
  /** Reads beneath an adjacent label, such as inside an action button. */
  quiet?: boolean;
  /**
   * Width and height in px. Set it where the spinner shares a slot with
   * sized icons and must not read narrower than them; omit it everywhere
   * else, for the 10px default.
   */
  sizePx?: number;
}

/** The spinner's box when a host gives no size. */
const DEFAULT_SIZE_PX = 10;

/**
 * The shared "thinking" spinner: the comet ring, named "Thinking". Hosts set
 * its ink with `tone` and its slot with `sizePx`; `className` is for
 * placement.
 */
export function ThinkingSpinner({
  className = '',
  tone = 'inherit',
  quiet = false,
  sizePx,
}: ThinkingSpinnerProps): JSX.Element {
  return (
    <CometSpinner
      className={className}
      tone={cometTone(tone)}
      quiet={quiet}
      sizePx={sizePx ?? DEFAULT_SIZE_PX}
      ariaLabel="Thinking"
    />
  );
}
