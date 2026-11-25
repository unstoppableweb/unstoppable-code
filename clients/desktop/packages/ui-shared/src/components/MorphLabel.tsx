import type { JSX, ReactNode } from 'react';

/**
 * The container breakpoint a {@link MorphLabel} switches at. Each pairs a
 * named container with a width, matching a rule in `canopy-tokens-core.css`:
 * `topbar-640` is 640px of `@container/topbar`, `prbar-560` 560px of
 * `@container/prbar`.
 */
export type MorphLabelBreakpoint = 'topbar-640' | 'prbar-560';

export interface MorphLabelProps {
  readonly at: MorphLabelBreakpoint;
  /**
   * When the content shows: `wide` from the breakpoint up (a label), or
   * `narrow` below it (the icon a label replaces).
   */
  readonly show?: 'wide' | 'narrow';
  /**
   * Which side's 6px parent gap folds away with the content. Without it the
   * content sits in a parent with no gap.
   */
  readonly gap?: 'start' | 'end';
  readonly children: ReactNode;
}

/**
 * A label or icon that folds away and back as its container crosses a
 * width, easing its width, fade, scale and blur instead of popping (the
 * motion lives in `canopy-tokens-core.css`). Pure display: the container
 * query decides, so nothing measures or re-renders on resize.
 */
export function MorphLabel({
  at,
  show = 'wide',
  gap,
  children,
}: MorphLabelProps): JSX.Element {
  return (
    <span
      className="canopy-morph"
      data-morph-at={at}
      data-morph-show={show}
      data-morph-gap={gap}
    >
      <span className="canopy-morph-clip">
        <span className="canopy-morph-ink">{children}</span>
      </span>
    </span>
  );
}
