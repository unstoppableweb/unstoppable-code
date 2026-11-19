import {
  CoreCoworkRequestError,
  isQueueRetryExpired,
  isUnknownKeyedWriteOutcome,
} from '@canopy/app-state/core-cowork';
import type { CanopyErrorPayload } from '@canopy/protocol/canopy-core';

/** A queued message's Cancel or Run now that may have landed (CAN-7196). */
export const QUEUE_COMMAND_UNCONFIRMED_NOTICE =
  "Couldn't confirm that. The queue now shows where things stand.";

/** A queued message's edit that may have saved (CAN-7196). */
export const QUEUE_EDIT_UNCONFIRMED_NOTICE =
  'Your edit may have saved. The queue now shows the current text.';

/** A queued message's command retried after Core forgot it (CAN-7196). */
export const QUEUE_RETRY_EXPIRED_NOTICE = 'Your view has been refreshed.';

/**
 * A queued message's Cancel or Run now that may have landed, or that Core
 * forgot, while its queue is still being read again (CAN-7196).
 */
export const QUEUE_COMMAND_UNREAD_NOTICE =
  "Couldn't confirm that yet. Still checking the queue.";

/** A queued message's edit that may have saved, while its queue is still being read again (CAN-7196). */
export const QUEUE_EDIT_UNREAD_NOTICE =
  'Your edit may have saved. Still checking the queue.';

/**
 * A failed queue re-read after a queued message's command that may have
 * landed is tried again after 250 ms, doubling to 8 s, then every 8 s with no
 * last try, as the web's store reads its snapshot again (CAN-7196).
 */
export const QUEUE_REREAD_MS = { base: 250, max: 8_000 } as const;

/** The wait before a queue re-read that follows `failed` failed ones. */
export function queueRereadDelayMs(
  failed: number,
  backoff: { readonly base: number; readonly max: number } = QUEUE_REREAD_MS,
): number {
  return Math.min(
    backoff.base * 2 ** Math.min(Math.max(failed, 1) - 1, 30),
    backoff.max,
  );
}

/** The queue read a queued message command that can't be confirmed answered after. */
export interface QueueRead {
  /** Whether a read of the queue was in when the command answered. */
  readonly installed: boolean;
  /** Settles once a read is in. */
  readonly shown: Promise<void>;
}

/**
 * A queued message's Cancel, Run now or edit that can't tell what happened,
 * answered after the web core backend read its queue again (CAN-7196).
 */
export class WebCoreQueueCommandUnsettledError extends CoreCoworkRequestError {
  readonly queueRead: QueueRead;

  constructor(payload: CanopyErrorPayload, queueRead: QueueRead) {
    super(payload);
    this.name = 'WebCoreQueueCommandUnsettledError';
    this.queueRead = queueRead;
  }
}

/** The read a queued message command's error waits on, if none was in. */
export function pendingQueueRead(error: unknown): Promise<void> | undefined {
  return error instanceof WebCoreQueueCommandUnsettledError &&
    !error.queueRead.installed
    ? error.queueRead.shown
    : undefined;
}

/** Whether a queued message's write may have landed: its answer never came. */
export function isUnconfirmedQueueWrite(error: unknown): boolean {
  return (
    error instanceof CoreCoworkRequestError &&
    isUnknownKeyedWriteOutcome(error.payload)
  );
}

/**
 * Whether a queued message command's error can't tell what happened: its
 * answer never came, or Core forgot the first attempt of a retry. The web
 * core backend reads the queue again before passing it on (CAN-7196).
 */
export function isQueueCommandUnsettled(
  error: unknown,
): error is CoreCoworkRequestError {
  return (
    error instanceof CoreCoworkRequestError &&
    (isQueueRetryExpired(error.payload) ||
      isUnknownKeyedWriteOutcome(error.payload))
  );
}

/**
 * What a cloud queued message's Cancel, Run now or edit says once its queue
 * was read again after an error that can't tell what happened: what the
 * queue now shows, never that it failed (CAN-7196).
 */
export function queueShownNotice(
  error: unknown,
  command: 'cancel' | 'force' | 'edit',
): string {
  if (
    error instanceof CoreCoworkRequestError &&
    isQueueRetryExpired(error.payload)
  )
    return QUEUE_RETRY_EXPIRED_NOTICE;
  return command === 'edit'
    ? QUEUE_EDIT_UNCONFIRMED_NOTICE
    : QUEUE_COMMAND_UNCONFIRMED_NOTICE;
}

/**
 * What a cloud queued message's Cancel, Run now or edit says when it can't
 * tell what happened. Once the queue was read again it says what the queue
 * shows; while that read is still out it says it is still checking, and
 * never that the queue is current (CAN-7196). Null for any other error,
 * which keeps its own handling.
 */
export function queueCommandNotice(
  error: unknown,
  command: 'cancel' | 'force' | 'edit',
): string | null {
  if (!isQueueCommandUnsettled(error)) return null;
  if (pendingQueueRead(error) === undefined)
    return queueShownNotice(error, command);
  return command === 'edit'
    ? QUEUE_EDIT_UNREAD_NOTICE
    : QUEUE_COMMAND_UNREAD_NOTICE;
}
