import type { JSX } from 'react';
import { useContinuousMotion } from '../lib/continuous-motion';
import { Dot } from '../primitives/Badge';
import { ThinkingSpinner } from '../primitives/ThinkingSpinner';
import { Tooltip } from '../primitives/Tooltip';

/**
 * What an agent is doing, as a row or tab shows it (turn-state D15): a turn
 * is running, or only background work is.
 */
export type AgentState = 'working' | 'background';

export function backgroundTasksLabel(count: number): string {
  return count === 1
    ? '1 background task running'
    : `${count} background tasks running`;
}

export interface AgentStateGlyphProps {
  state: AgentState;
  /** Live background tasks, which name the background state. */
  backgroundTasks?: number;
  /** `row`: a sidebar row's 24px status slot; `inline`: its own size. */
  slot?: 'row' | 'inline';
  /**
   * The working spinner's own size, to match the glyphs it alternates with.
   * The background dot keeps its 6px size.
   */
  sizePx?: number;
  /**
   * The chat has output the user hasn't viewed. A tab has no separate unread
   * dot, so its glyph carries the unread ink.
   */
  unread?: boolean;
  /**
   * Off where a label beside the glyph already says it (a drawer tab's
   * "Background 6"): no tooltip, and the glyph is decorative.
   */
  tooltip?: boolean;
  testId?: string;
}

const SLOT_CLASS_NAMES = {
  row: 'inline-flex h-5 w-6 shrink-0 items-center justify-center',
  inline: 'inline-flex shrink-0 items-center justify-center',
} as const;

/**
 * The accent spinner while a turn runs; a pulsing grey dot while only
 * background work does (a grey ring under reduced motion), so the two differ
 * in shape, not only in ink.
 */
export function AgentStateGlyph({
  state,
  backgroundTasks = 0,
  slot = 'inline',
  sizePx,
  unread = false,
  tooltip = true,
  testId,
}: AgentStateGlyphProps): JSX.Element {
  // The blink pauses offscreen and in hidden windows, as the spinner does.
  const pulseRef = useContinuousMotion<HTMLSpanElement>(state === 'background');
  const label =
    state === 'working' ? 'Working' : backgroundTasksLabel(backgroundTasks);
  const spinner =
    state === 'working' ? (
      <span className="inline-flex h-3 w-3 items-center justify-center">
        <ThinkingSpinner tone={unread ? 'unread' : 'accent'} sizePx={sizePx} />
      </span>
    ) : (
      <>
        {/* The blink rides on the wrapper: the dot itself takes no restyle. */}
        <span
          ref={pulseRef}
          className="canopy-background-pulse inline-flex h-3 w-3 items-center justify-center motion-reduce:hidden"
        >
          <Dot tone={unread ? 'unread' : 'filter'} />
        </span>
        {/* Without the blink a solid dot would match an idle row's, so
            reduced motion draws the ring instead: a still, different shape. */}
        <span className="hidden h-3 w-3 items-center justify-center motion-reduce:inline-flex">
          <Dot
            tone={unread ? 'unread' : 'filter'}
            variant="ring"
            size="large"
          />
        </span>
      </>
    );
  if (!tooltip) {
    return (
      <span
        className={SLOT_CLASS_NAMES[slot]}
        aria-hidden="true"
        data-testid={testId}
      >
        {spinner}
      </span>
    );
  }
  // Rich tooltips, never native `title` (CAN-2799): the native one lags on macOS.
  return (
    <Tooltip label={label}>
      {/* An image role names the glyph by its state and hides the
          working spinner's own "Thinking" name from assistive technology. */}
      <span
        className={SLOT_CLASS_NAMES[slot]}
        role="img"
        aria-label={label}
        data-testid={testId}
      >
        {spinner}
      </span>
    </Tooltip>
  );
}
