import type { JSX } from 'react';
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CirclePauseIcon,
  CircleStopIcon,
  CircleXIcon,
  GitMergeIcon,
  QuestionMarkIcon,
  type AppIcon,
} from '../icons/AppIcons';
import {
  STATUS_GLYPHS,
  type StatusGlyphShape,
  type StatusGlyphState,
} from '../lib/status-glyph';
import { ThinkingSpinner } from './ThinkingSpinner';

/**
 * Glyph boxes: 12px for dense strips and tables, the compact 14px tier for
 * rows and tabs, and the regular 20px tier.
 */
export type StatusGlyphSize = 12 | 14 | 20;

/** Small glyphs draw a visible 1.5px line rather than 2 of 24 units. */
const STROKE_PX = 1.5;

const BOX_CLASS: Readonly<Record<StatusGlyphSize, string>> = {
  12: 'h-3 w-3',
  14: 'h-3.5 w-3.5',
  20: 'h-5 w-5',
};

const DOT_CLASS: Readonly<Record<StatusGlyphSize, string>> = {
  12: 'h-1.5 w-1.5',
  14: 'h-1.5 w-1.5',
  20: 'h-2 w-2',
};

const ICONS: Readonly<
  Record<Exclude<StatusGlyphShape, 'spinner' | 'dot'>, AppIcon>
> = {
  'circle-help': QuestionMarkIcon,
  'circle-dashed': CircleDashedIcon,
  'circle-check': CircleCheckIcon,
  'git-merge': GitMergeIcon,
  'circle-x': CircleXIcon,
  'circle-pause': CirclePauseIcon,
  'circle-stop': CircleStopIcon,
};

/**
 * The running spinner's box, so it reads the same size as the stroke glyphs
 * beside it. A 16px outline glyph fills about 82% of its box (13.2px across):
 * the ring matches it at 13px.
 */
const SPINNER_PX: Readonly<Record<StatusGlyphSize, number>> = {
  12: 11,
  14: 13,
  20: 18,
};

export interface StatusGlyphProps {
  readonly state: StatusGlyphState;
  /** Glyph box in px. Defaults to the compact 14px tier. */
  readonly size?: StatusGlyphSize;
  /**
   * The running spinner's box, when it must match a smaller spinner beside
   * it (a sidebar row's 10px ring). Defaults to the optical size
   * for `size` ({@link SPINNER_PX}).
   */
  readonly spinnerSize?: number;
  /**
   * Accessible name. Omit when the status is named in adjacent text or a
   * tooltip; the glyph is then hidden from assistive technology.
   */
  readonly label?: string;
  /** Placement only: margin, alignment and flex participation. */
  readonly className?: string;
  readonly dataTestId?: string;
  /** Keep state color, or neutralize every state except failures. */
  readonly tone?: 'state' | 'neutral-except-failure';
}

/**
 * The one status glyph for runs, subagents and every other surface that
 * shows where work stands: one glyph and one ink per state, from
 * {@link STATUS_GLYPHS}. Running is the shared spinner, so it follows the
 * host's spinner style like the sidebar does. Pair it with the status name
 * in text, or a tooltip when it stands alone.
 */
export function StatusGlyph({
  state,
  size = 14,
  spinnerSize,
  label,
  className = '',
  dataTestId,
  tone = 'state',
}: StatusGlyphProps): JSX.Element {
  const spec = STATUS_GLYPHS[state];
  const box = BOX_CLASS[size];
  const spinnerPx = spinnerSize ?? SPINNER_PX[size];
  const ink =
    tone === 'neutral-except-failure' && state !== 'failed'
      ? 'fg-tertiary'
      : spec.ink;
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ${box} ${ink} ${className}`}
      data-status-glyph={state}
      data-testid={dataTestId}
      {...(label === undefined
        ? { 'aria-hidden': true }
        : { role: 'img', 'aria-label': label })}
    >
      {renderShape(spec.shape, size, spinnerPx)}
    </span>
  );
}

function renderShape(
  shape: StatusGlyphShape,
  size: StatusGlyphSize,
  spinnerSize: number,
): JSX.Element {
  switch (shape) {
    case 'spinner':
      return <ThinkingSpinner sizePx={spinnerSize} tone="secondary" />;
    case 'dot':
      return <span className={`${DOT_CLASS[size]} rounded-full bg-current`} />;
    default: {
      const Icon = ICONS[shape];
      // 12px sits below the 14px compact tier, so it is drawn exactly, as
      // a badge's leading glyph is.
      return (
        <Icon
          size={size}
          exactSize={size === 12}
          drawnStrokeWidth={STROKE_PX}
          aria-hidden
        />
      );
    }
  }
}
