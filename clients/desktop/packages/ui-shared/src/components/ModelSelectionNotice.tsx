'use client';

import type { JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
import { Notice } from './Notice';

export interface ModelSelectionFailure {
  message: string;
  /** A terminal desktop answer, not proof that no write occurred. */
  reported: boolean;
}

export function ModelSelectionNotice({
  failure,
}: {
  failure: ModelSelectionFailure | undefined;
}): JSX.Element | null {
  if (!failure) return null;
  return (
    <Notice
      data-testid="model-selection-failure"
      intent="attention"
      title={
        failure.reported ? 'Model change failed' : 'Model change not confirmed'
      }
    >
      {/* A caught message can quote paths: replay skips it (CAN-7102). */}
      <span className={REPLAY_BLOCK_CLASS}>{failure.message}</span>
    </Notice>
  );
}
