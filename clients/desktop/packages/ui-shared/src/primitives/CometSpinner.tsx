'use client';

import { useContinuousMotion } from '../lib/continuous-motion';
import type { CSSProperties, JSX } from 'react';
import { spinnerClassName, type SpinnerTone } from './spinner-tone';

interface CometSpinnerProps {
  /** Placement only: margin, alignment, and flex participation. */
  className?: string;
  /** Ink of the ring. Defaults to the surrounding text color. */
  tone?: SpinnerTone;
  /** Reads beneath an adjacent label, such as inside an action button. */
  quiet?: boolean;
  /** Width and height in px. Defaults to 12, the sidebar status slot. */
  sizePx?: number;
  /** Accessible name. Omit for a decorative spinner (hidden from AT). */
  ariaLabel?: string;
  dataTestId?: string;
}

/**
 * Pure display "comet" spinner: a ring whose ink fades in toward a round head,
 * turning once every 1.2s on `--animate-comet-spin`. The ring geometry and
 * its MIT notice (adapted from loading-dev's `Comet`) live with the
 * `.canopy-comet-*` rules in `canopy-tokens.css`. Reduced motion holds the
 * ring still.
 */
export function CometSpinner({
  className = '',
  tone = 'inherit',
  quiet = false,
  sizePx = 12,
  ariaLabel,
  dataTestId,
}: CometSpinnerProps): JSX.Element {
  const motionRef = useContinuousMotion<HTMLSpanElement>();
  const style: CSSProperties & Record<'--canopy-comet-stroke', string> = {
    width: sizePx,
    height: sizePx,
    '--canopy-comet-stroke': `max(1.5px, ${sizePx * 0.12}px)`,
  };
  return (
    <span
      ref={motionRef}
      className={`relative inline-block shrink-0 ${spinnerClassName(tone, quiet)} ${className}`}
      style={style}
      {...(ariaLabel === undefined
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': ariaLabel })}
      data-spinner="comet"
      data-testid={dataTestId}
    >
      <span className="absolute inset-0 animate-comet-spin motion-reduce:animate-none">
        <span className="canopy-comet-tail" />
        <span className="canopy-comet-head" />
      </span>
    </span>
  );
}
