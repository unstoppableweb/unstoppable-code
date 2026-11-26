'use client';

import type { JSX } from 'react';
import { Notice } from '../primitives/Notice';

export interface CatchingUpNoticeProps {
  lagMs: number;
}

/** Returns the lag description that is visible for the current copy range. */
export function catchingUpMessage(lagMs: number): string {
  if (!Number.isFinite(lagMs) || lagMs < 60_000) {
    return 'Updates are a few seconds behind the agent.';
  }

  if (lagMs < 120_000) {
    return 'Updates are about 1 minute behind the agent.';
  }

  const minutes = Math.floor(lagMs / 60_000);
  return `Updates are about ${String(minutes)} minutes behind the agent.`;
}

/**
 * Renders only the visible copy range, so new lag samples within that range
 * leave the live region unchanged and do not cause another announcement.
 */
export function CatchingUpNotice({
  lagMs,
}: CatchingUpNoticeProps): JSX.Element {
  const message = catchingUpMessage(lagMs);

  return (
    <Notice
      intent="neutral"
      title="Catching up"
      data-testid="catching-up-notice"
    >
      {message}
    </Notice>
  );
}
