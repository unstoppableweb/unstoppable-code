'use client';

import { useEffect, useRef, type JSX } from 'react';
import { Notice, NoticeButton } from '../Notice';

export const FIRST_SEND_FAILED_CHOOSE_MODEL_LABEL = 'Choose another model';
export const FIRST_SEND_FAILED_RETRY_LABEL = 'Try again';
export const FIRST_SEND_FAILED_RETRYING_LABEL = 'Trying again…';

export interface FirstSendFailedNoticeProps {
  /** The state in a few words, for example `Couldn’t send`. */
  title: string;
  /** The explanation and the way out, as one or two short sentences. */
  message: string;
  /** Primary recovery: open the model picker. */
  onChooseModel: () => void;
  /** Secondary recovery: send the same prompt again. Omit to hide the action. */
  onRetry?: () => void;
  /**
   * A retry is in flight: both actions stop taking presses, `Try again` spins
   * inside its capsule, and the notice announces `aria-busy`.
   */
  busy?: boolean;
  /**
   * Host-controlled focus: when this value changes to a non-null value, the
   * primary action is focused once. `null` or `undefined` never auto-focuses.
   * A key that arrives while `busy` is applied once the retry settles.
   */
  focusKey?: string | null;
  /** Placement only (margins, width); the surface is the shared `Notice`. */
  className?: string;
  'data-testid'?: string;
}

/**
 * The recovery notice for a chat's first message that could not be sent, for
 * example because the selected model was refused. Pure display: the host owns
 * the copy, the failure identity, and what each action does.
 *
 * It is the shared destructive `Notice`, so it is the one `role="alert"` on
 * the failure and adds no live region of its own. The recommended action,
 * `Choose another model`, is the right-most button; `Try again` sits before
 * it. The host decides when focus moves to the primary action through
 * `focusKey`, so a background failure never steals focus.
 */
export function FirstSendFailedNotice({
  title,
  message,
  onChooseModel,
  onRetry,
  busy = false,
  focusKey,
  className,
  'data-testid': testId = 'first-send-failed-notice',
}: FirstSendFailedNoticeProps): JSX.Element {
  const chooseModelRef = useRef<HTMLButtonElement>(null);
  const focusedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (focusKey === null || focusKey === undefined) return;
    if (focusKey === focusedKeyRef.current) return;
    // A disabled button cannot take focus; keep the key pending until the
    // retry settles instead of spending it on a no-op.
    if (busy) return;
    const button = chooseModelRef.current;
    if (button === null) return;
    focusedKeyRef.current = focusKey;
    button.focus();
  }, [focusKey, busy]);

  return (
    <Notice
      errorSource="first-send-failed-title"
      intent="destructive"
      title={title}
      aria-busy={busy || undefined}
      className={className}
      data-testid={testId}
      actions={
        <>
          {onRetry !== undefined && (
            <NoticeButton
              variant="secondary"
              busy={busy}
              busyLabel={FIRST_SEND_FAILED_RETRYING_LABEL}
              onClick={onRetry}
              data-testid={`${testId}-retry`}
            >
              {FIRST_SEND_FAILED_RETRY_LABEL}
            </NoticeButton>
          )}
          <NoticeButton
            ref={chooseModelRef}
            variant="primary"
            disabled={busy}
            onClick={onChooseModel}
            data-testid={`${testId}-choose-model`}
          >
            {FIRST_SEND_FAILED_CHOOSE_MODEL_LABEL}
          </NoticeButton>
        </>
      }
    >
      {message}
    </Notice>
  );
}
