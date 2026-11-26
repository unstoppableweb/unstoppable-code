'use client';

import type { JSX } from 'react';
import { aiCreditsArrivalTitle } from './aiCreditsArrival';
import { MODEL_LIBRARY_UNLOCK_COPY } from './creditsPromptCopy';
import { Notice } from '../primitives/Notice';

export interface ModelUnlockConfirmedNoticeProps {
  /**
   * The refreshed available balance. The host passes only a finite, positive
   * personal balance; anything else is omitted and the notice falls back to
   * the plain unlock confirmation.
   */
  credits?: number;
  /**
   * The observed increase since checkout opened, when a comparable starting
   * balance was read. The title then names it, as every purchase path does
   * (CAN-5160); without it the title names the balance.
   */
  addedCredits?: number;
  /** The chat's model, passed only while it is the one the unlock was for. */
  modelLabel?: string;
  onDismiss: () => void;
  testId?: string;
}

/**
 * The in-chat confirmation after a confirmed advanced-model unlock
 * (CAN-5027). Sits above the composer of the chat the purchase started in.
 *
 * Each fact is its own sentence, and each is stated only when it is true:
 * the balance once a usable one has been read, and the model only while the
 * chat is actually on it. With neither, the notice says the unlock happened.
 */
export function ModelUnlockConfirmedNotice({
  credits,
  addedCredits,
  modelLabel,
  onDismiss,
  testId = 'model-unlock-confirmed-notice',
}: ModelUnlockConfirmedNoticeProps): JSX.Element {
  const hasCredits =
    credits !== undefined && Number.isFinite(credits) && credits > 0;
  // The same title the chat banners give a purchase: the amount added, with
  // the balance only when it reads differently, else the balance alone.
  const lead = hasCredits
    ? aiCreditsArrivalTitle({
        addedCredits: addedCredits ?? null,
        balanceCredits: credits,
      })
    : MODEL_LIBRARY_UNLOCK_COPY.confirmed;
  // The plain confirmation follows a balance sentence that has no model
  // sentence after it, and stands alone when there is neither.
  const message =
    modelLabel !== undefined && modelLabel.length > 0
      ? MODEL_LIBRARY_UNLOCK_COPY.confirmedModelSelected(modelLabel)
      : hasCredits
        ? MODEL_LIBRARY_UNLOCK_COPY.confirmed
        : undefined;
  return (
    <Notice
      intent="positive"
      data-testid={testId}
      onDismiss={onDismiss}
      dismissLabel={MODEL_LIBRARY_UNLOCK_COPY.dismissConfirmation}
      dismissTestId={`${testId}-dismiss`}
      {...(message !== undefined ? { title: lead } : {})}
    >
      {message ?? lead}
    </Notice>
  );
}
