'use client';
import { useState, type JSX } from 'react';
import { Notice, NoticeButton } from '../primitives/Notice';
import { FIRST_SEND_FAILED_CHOOSE_MODEL_LABEL } from './chat/FirstSendFailedNotice';

export interface ModelUnavailableNoticeProps {
  /** The composer's current model, by display name. */
  readonly modelLabel: string;
  /** Why it can't run, as the picker row and chip say it. */
  readonly reason: string;
  /** Open the composer's model picker. */
  readonly onChooseModel: () => void;
  readonly testId?: string;
}

/**
 * The composer's model can't run for this account (CAN-6444). Shown before
 * send, in the composer notice stack, with a button that opens the model
 * picker beside it. Closing it hides it until the model changes.
 */
export function ModelUnavailableNotice({
  modelLabel,
  reason,
  onChooseModel,
  testId = 'model-unavailable-notice',
}: ModelUnavailableNoticeProps): JSX.Element | null {
  const [dismissedModel, setDismissedModel] = useState<string | null>(null);
  if (dismissedModel === modelLabel) return null;
  return (
    <Notice
      intent="attention"
      title={`Can’t use ${modelLabel}`}
      data-testid={testId}
      onDismiss={(): void => setDismissedModel(modelLabel)}
      actions={
        <NoticeButton
          variant="primary"
          onClick={onChooseModel}
          data-testid={`${testId}-choose-model`}
        >
          {FIRST_SEND_FAILED_CHOOSE_MODEL_LABEL}
        </NoticeButton>
      }
    >
      {reason}
    </Notice>
  );
}
