import type { JSX, ReactNode } from 'react';

// A segmented strip needs no frame: SegmentedControl draws its own track.
export type ScrollableTabFrameVariant = 'underline';

const FRAME_CLASS: Record<ScrollableTabFrameVariant, string> = {
  underline: 'border-b',
};

/** Outer frame for a scrolling tab strip. The strip owns the overflow mask. */
export function ScrollableTabFrame({
  variant,
  children,
}: {
  readonly variant: ScrollableTabFrameVariant;
  readonly children: ReactNode;
}): JSX.Element {
  return <div className={FRAME_CLASS[variant]}>{children}</div>;
}
