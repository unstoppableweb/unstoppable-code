import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import { ChatDeltaJournalIntegrityError } from '../lib/chat-delta-journal/format';

/**
 * Field evidence for chat storage format 4 promotion (CAN-6217): one
 * `chat:storage_format4_update` event per outcome, carrying only the fixed
 * codes below. Never a chat, worktree, scope or path identifier, a file name,
 * or an error message.
 */

export const CHAT_FORMAT4_EVENTS = [
  'promoted',
  'promotion_failed',
  'retries_exhausted',
  'newer_format_refused',
  'slow_checkpoint',
] as const;
export type ChatFormat4Event = (typeof CHAT_FORMAT4_EVENTS)[number];

/** Why a promotion attempt failed, from the error's class and code only. */
export const CHAT_FORMAT4_REASONS = [
  'none',
  'disk_full',
  'permission',
  'io',
  'integrity',
  'other',
] as const;
export type ChatFormat4Reason = (typeof CHAT_FORMAT4_REASONS)[number];

/** Format 4 checkpoints faster than the first bucket are not sent. */
export const CHAT_FORMAT4_SLOW_CHECKPOINT_MS = 1_000;
export const CHAT_FORMAT4_DURATION_BUCKETS = [
  'none',
  '1s_5s',
  '5s_30s',
  'gte_30s',
] as const;
export type ChatFormat4DurationBucket =
  (typeof CHAT_FORMAT4_DURATION_BUCKETS)[number];

/** Attempts are numbered 1 to 6 (an initial attempt and five retries). */
export const CHAT_FORMAT4_MAX_ATTEMPT = 6;

export type ChatFormat4Outcome =
  | { readonly event: 'promoted'; readonly attempt: number }
  | {
      readonly event: 'promotion_failed';
      readonly attempt: number;
      readonly error: unknown;
    }
  | { readonly event: 'retries_exhausted'; readonly attempt: number }
  | { readonly event: 'newer_format_refused' }
  | { readonly event: 'slow_checkpoint'; readonly durationMs: number };

export type ChatFormat4Labels = {
  readonly format4_event: ChatFormat4Event;
  readonly format4_reason: ChatFormat4Reason;
  readonly format4_attempt: number;
  readonly format4_duration_bucket: ChatFormat4DurationBucket;
};

const OPERATION = 'canopy.chat_storage_format4';

/** The failure class of a promotion error: its type and code, never its text. */
export function chatFormat4FailureReason(error: unknown): ChatFormat4Reason {
  if (error instanceof ChatDeltaJournalIntegrityError) return 'integrity';
  const code: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk_full';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'permission';
  if (typeof code === 'string' && /^E[A-Z]+$/.test(code)) return 'io';
  return 'other';
}

export function chatFormat4DurationBucket(
  durationMs: number,
): ChatFormat4DurationBucket {
  if (!Number.isFinite(durationMs) || durationMs < 1_000) return 'none';
  if (durationMs < 5_000) return '1s_5s';
  if (durationMs < 30_000) return '5s_30s';
  return 'gte_30s';
}

function attemptLabel(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) return 1;
  return Math.min(attempt, CHAT_FORMAT4_MAX_ATTEMPT);
}

/**
 * The labels one outcome sends: exactly the four declared keys, each a fixed
 * code or a bounded number, whatever the caller passed.
 */
export function chatFormat4Labels(
  outcome: ChatFormat4Outcome,
): ChatFormat4Labels {
  switch (outcome.event) {
    case 'promoted':
    case 'retries_exhausted':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: attemptLabel(outcome.attempt),
        format4_duration_bucket: 'none',
      };
    case 'promotion_failed':
      return {
        format4_event: outcome.event,
        format4_reason: chatFormat4FailureReason(outcome.error),
        format4_attempt: attemptLabel(outcome.attempt),
        format4_duration_bucket: 'none',
      };
    case 'newer_format_refused':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: 'none',
      };
    case 'slow_checkpoint':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: chatFormat4DurationBucket(outcome.durationMs),
      };
  }
}

/**
 * Records one format 4 outcome after the current task, so it never delays or
 * changes the storage work. Checkpoints under one second are not sent.
 */
export function recordChatFormat4Outcome(outcome: ChatFormat4Outcome): void {
  if (
    outcome.event === 'slow_checkpoint' &&
    !(outcome.durationMs >= CHAT_FORMAT4_SLOW_CHECKPOINT_MS)
  )
    return;
  setImmediate(() => {
    try {
      const context = chatFormat4Labels(outcome);
      const operationKey = createDesktopInstrumentationOperationKey(
        `${OPERATION}:${context.format4_event}:${Date.now()}`,
      );
      startDesktopOperation(OPERATION, { operationKey, context });
      succeedDesktopOperation(OPERATION, { operationKey, context });
    } catch {
      // Telemetry never affects chat storage.
    }
  });
}
