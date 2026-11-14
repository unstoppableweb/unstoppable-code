'use client';

import type { JSX } from 'react';
import { Notice, NoticeButton, type NoticeIntent } from '../Notice';

export interface TurnResumeNoticeProps {
  /** The state in a few words, for example `Turn stopped`. */
  title: string;
  /** What Resume does, as one short sentence. */
  message: string;
  /** Resting intent; an error always raises it to `attention`. */
  intent?: Extract<NoticeIntent, 'neutral' | 'attention'>;
  /** Label of the primary action, for example `Resume`. */
  resumeLabel: string;
  onResume: () => void;
  /**
   * A resume is in flight: Resume spins with `busyLabel`, both actions stop
   * taking presses, and the notice announces `aria-busy`.
   */
  busy?: boolean;
  busyLabel?: string;
  /** Failure text from the last attempt; Resume stays available. */
  error?: string;
  /** Secondary action that hides the offer. Omit to show Resume alone. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Root test id; actions use `-button` and `-dismiss` suffixes. */
  'data-testid'?: string;
}

/**
 * The composer offer to resume a turn that did not finish: one the user
 * stopped, or one cut off when the app closed. Pure display: the host owns
 * the copy, whether the offer applies, and what each action does.
 *
 * Resume is the primary action and sits right-most; Dismiss, when offered,
 * sits before it.
 */
export function TurnResumeNotice({
  title,
  message,
  intent = 'neutral',
  resumeLabel,
  onResume,
  busy = false,
  busyLabel,
  error,
  onDismiss,
  dismissLabel = 'Dismiss',
  'data-testid': testId = 'turn-resume',
}: TurnResumeNoticeProps): JSX.Element {
  return (
    <Notice
      errorSource="turn-resume-title"
      intent={error ? 'attention' : intent}
      title={title}
      aria-busy={busy || undefined}
      data-testid={testId}
      {...(error ? { detail: error } : {})}
      actions={
        <>
          {onDismiss !== undefined && (
            <NoticeButton
              variant="secondary"
              disabled={busy}
              onClick={onDismiss}
              data-testid={`${testId}-dismiss`}
            >
              {dismissLabel}
            </NoticeButton>
          )}
          <NoticeButton
            variant="primary"
            busy={busy}
            {...(busyLabel !== undefined ? { busyLabel } : {})}
            onClick={onResume}
            data-testid={`${testId}-button`}
          >
            {resumeLabel}
          </NoticeButton>
        </>
      }
    >
      {message}
    </Notice>
  );
}
