'use client';

import type { JSX, ReactNode } from 'react';
import { useContinuousMotion } from '../lib/continuous-motion';

/**
 * A glyph that turns while its work runs, such as the Orchestrator's orbit in
 * the sidebar and its minimized bubble: one unhurried turn every 2.4s, so the
 * glyph itself says "working" instead of a spinner drawn over it. The host
 * keeps the glyph's size and status ink; reduced motion holds it still.
 */
export function RunningGlyph({
  running,
  children,
}: {
  readonly running: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const motionRef = useContinuousMotion<HTMLSpanElement>(running);
  return (
    <span
      ref={motionRef}
      className={`inline-flex${running ? ' animate-glyph-spin motion-reduce:animate-none' : ''}`}
      data-running={running ? '' : undefined}
    >
      {children}
    </span>
  );
}
