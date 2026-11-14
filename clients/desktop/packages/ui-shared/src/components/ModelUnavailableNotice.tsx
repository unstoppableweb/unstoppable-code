'use client';
import type { JSX } from 'react';
import { Notice, NoticeButton } from './Notice';

export interface ModelUnavailableNoticeProps {
  /** The composer's current model, by display name. */
  readonly modelLabel: string;
  /** Why it can't run, as the picker row and chip say it. */
  readonly reason: string;
  /** A model this account can run, by display name. */
  readonly switchModelLabel: string;
  /** Switch the composer to that model. */
  readonly onSwitch: () => void;
  readonly testId?: string;
}

/**
 * The composer's model can't run for this account, with a one-click switch to
 * one that can (CAN-6444). Shown before send, in the composer notice stack, so
 * a user whose only working models are on their own AI gateway isn't sent
 * into a billing dead end.
 */
export function ModelUnavailableNotice({
  modelLabel,
  reason,
  switchModelLabel,
  onSwitch,
  testId = 'model-unavailable-notice',
}: ModelUnavailableNoticeProps): JSX.Element {
  return (
    <Notice
      intent="attention"
      title={`Can’t use ${modelLabel}`}
      data-testid={testId}
      actions={
        <NoticeButton
          variant="primary"
          onClick={onSwitch}
          data-testid={`${testId}-switch`}
        >
          {`Use ${switchModelLabel}`}
        </NoticeButton>
      }
    >
      {reason}
    </Notice>
  );
}
