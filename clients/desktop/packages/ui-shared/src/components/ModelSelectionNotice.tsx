'use client';

import type { JSX } from 'react';
import { Notice } from '../primitives/Notice';
import { CopyDetailsButton } from '../primitives/CopyDetailsButton';

export interface ModelSelectionFailure {
  message: string;
  /** A terminal desktop answer, not proof that no write occurred. */
  reported: boolean;
}

export function ModelSelectionNotice({
  failure,
  onDismiss,
}: {
  failure: ModelSelectionFailure | undefined;
  /** Close icon; the host shows the next failure again. */
  onDismiss?: () => void;
}): JSX.Element | null {
  if (!failure) return null;
  return (
    <Notice
      data-testid="model-selection-failure"
      intent="attention"
      {...(onDismiss !== undefined ? { onDismiss } : {})}
      // The caught message can quote paths, so it rides behind Copy details.
      actions={<CopyDetailsButton details={failure.message} />}
      title={
        failure.reported
          ? "Couldn't change the model"
          : 'Model change not confirmed'
      }
    >
      {null}
    </Notice>
  );
}
