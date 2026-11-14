'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import { Notice, NoticeButton } from './Notice';

/**
 * Why automatic replies to background work are paused. `delegation_limit`:
 * the agent replied to its delegates' results the most times in a row the
 * delegation tree allows without the user.
 */
export type WakeParkedReason =
  | 'consecutive_limit'
  | 'daily_limit'
  | 'delegation_limit'
  | 'other';

export interface WakeParkedNoticeProps {
  reason: WakeParkedReason;
  /**
   * Lets the agent reply to finished background work again. Absent for a
   * viewer who may not prompt the chat: the notice then only explains.
   */
  onContinue?: () => Promise<void>;
}

export const WAKE_PARKED_TITLE = 'Automatic replies paused';

const WAKE_PARKED_MESSAGES: Record<WakeParkedReason, string> = {
  consecutive_limit:
    'The agent replied to finished background work several times in a row. Continue to let it reply again.',
  daily_limit:
    'The agent replied to finished background work many times today. Continue to let it reply again.',
  // The delegates' results wait; a message to the chat or to a delegate
  // lets the agent read them too.
  delegation_limit:
    'The agent replied to its delegates several times in a row without you. Their results wait until you continue or send a message.',
  other:
    "The agent won't reply to finished background work for now. Continue to let it reply again.",
};

/**
 * Composer notice for a chat whose agent stopped replying on its own to
 * finished background work, because it already did so many times. Pure
 * display: the host decides when to mount it and what Continue does.
 */
export function WakeParkedNotice({
  reason,
  onContinue,
}: WakeParkedNoticeProps): JSX.Element {
  const [state, setState] = useState<'idle' | 'continuing' | 'failed'>('idle');
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return (): void => {
      mountedRef.current = false;
    };
  }, []);

  const handleContinue = async (): Promise<void> => {
    if (onContinue === undefined || state === 'continuing') return;
    setState('continuing');
    try {
      await onContinue();
      if (mountedRef.current) setState('idle');
    } catch {
      if (mountedRef.current) setState('failed');
    }
  };

  return (
    <Notice
      intent="attention"
      title={WAKE_PARKED_TITLE}
      data-testid="wake-parked-notice"
      {...(state === 'failed' ? { detail: "Couldn't continue." } : {})}
      {...(onContinue === undefined
        ? {}
        : {
            actions: (
              <NoticeButton
                variant="primary"
                busy={state === 'continuing'}
                busyLabel="Continuing…"
                onClick={(): void => {
                  void handleContinue();
                }}
                data-testid="wake-parked-continue"
              >
                Continue
              </NoticeButton>
            ),
          })}
    >
      {WAKE_PARKED_MESSAGES[reason]}
    </Notice>
  );
}
