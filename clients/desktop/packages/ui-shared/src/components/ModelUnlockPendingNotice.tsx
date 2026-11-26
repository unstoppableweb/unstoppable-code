'use client';

import type { JSX } from 'react';
import { TimeslotIcon } from '../icons/AppIcons';
import { Notice, NoticeButton } from '../primitives/Notice';
import {
  MODEL_LIBRARY_UNLOCK_COPY,
  modelLibraryPendingBody,
} from './creditsPromptCopy';

/** The pending phases a composer notice narrates. */
export type ModelUnlockPendingPhase = 'waiting' | 'timed-out';

export interface ModelUnlockPendingNoticeProps {
  readonly phase: ModelUnlockPendingPhase;
  /** The model the purchase will switch to; omit when the host cannot name it. */
  readonly modelLabel?: string;
  /** A check the user asked for is in flight. */
  readonly checking?: boolean;
  readonly onCheckNow: () => void;
  /**
   * Stop tracking this purchase, from the close icon. Offered in both phases:
   * `detail` says that closing stops tracking but keeps the purchase.
   */
  readonly onDismiss?: () => void;
  readonly dataTestId?: string;
}

/**
 * The composer cue for an advanced-model purchase finishing in the browser
 * (CAN-5030). It stays while the dialog that started the purchase is closed,
 * and only ever checks: it never opens another checkout.
 *
 * The content changes only with the phase, so polling behind it does not
 * re-announce the `Notice`'s own polite live region.
 */
export function ModelUnlockPendingNotice({
  phase,
  modelLabel,
  checking = false,
  onCheckNow,
  onDismiss,
  dataTestId = 'model-unlock-pending-notice',
}: ModelUnlockPendingNoticeProps): JSX.Element {
  const waiting = phase === 'waiting';
  return (
    <Notice
      intent={waiting ? 'neutral' : 'attention'}
      // The clock every purchase in the browser shows (CAN-5160), and the
      // intent's warning glyph once checks stop.
      {...(waiting
        ? { icon: <TimeslotIcon size={16} aria-hidden="true" /> }
        : {})}
      title={
        waiting
          ? MODEL_LIBRARY_UNLOCK_COPY.pendingTitle
          : MODEL_LIBRARY_UNLOCK_COPY.timedOutTitle
      }
      {...(onDismiss === undefined
        ? {}
        : {
            detail: MODEL_LIBRARY_UNLOCK_COPY.dismissHelp,
            onDismiss,
            dismissLabel: MODEL_LIBRARY_UNLOCK_COPY.dismissPaymentAction,
            dismissTestId: 'model-unlock-pending-dismiss',
          })}
      actions={
        <NoticeButton
          variant={waiting ? 'secondary' : 'primary'}
          data-testid="model-unlock-pending-check-now"
          busy={checking}
          busyLabel={MODEL_LIBRARY_UNLOCK_COPY.checkingAction}
          onClick={onCheckNow}
        >
          {MODEL_LIBRARY_UNLOCK_COPY.checkNowAction}
        </NoticeButton>
      }
      data-testid={dataTestId}
      data-phase={phase}
    >
      {waiting
        ? modelLibraryPendingBody(modelLabel)
        : MODEL_LIBRARY_UNLOCK_COPY.timedOutBody}
    </Notice>
  );
}
