import { AsyncLocalStorage } from 'node:async_hooks';
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
  'sweep_pass_completed',
  'sweep_paused',
  'sweep_scope_backed_off',
  'prehandoff_completed',
  'prehandoff_bound_exceeded',
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

/** Why the background sweep (CAN-7178) is waiting, from its own checks only. */
export const CHAT_FORMAT4_PAUSE_REASONS = [
  'none',
  'activity',
  'battery',
  'disk',
  'switch_off',
  'sweep_switch_off',
] as const;
export type ChatFormat4PauseReason = Exclude<
  (typeof CHAT_FORMAT4_PAUSE_REASONS)[number],
  'none'
>;

/**
 * What started the work an event reports (CAN-7178): the background sweep,
 * an ordinary load, or the flip build's pre-handoff pass (CAN-7178 PR 3).
 * Exactly these three values; never an identifier.
 */
export const CHAT_FORMAT4_TRIGGERS = ['sweep', 'load', 'pre-handoff'] as const;
export type ChatFormat4Trigger = (typeof CHAT_FORMAT4_TRIGGERS)[number];

/** Scopes a sweep pass left below format 4, bucketed; never a count or name. */
export const CHAT_FORMAT4_REMAINING_BUCKETS = [
  'none',
  '0',
  '1_5',
  '6_20',
  '21_100',
  'gt_100',
] as const;
export type ChatFormat4RemainingBucket =
  (typeof CHAT_FORMAT4_REMAINING_BUCKETS)[number];

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

export type ChatFormat4Outcome = (
  | { readonly event: 'promoted'; readonly attempt: number }
  | {
      readonly event: 'promotion_failed';
      readonly attempt: number;
      readonly error: unknown;
    }
  | { readonly event: 'retries_exhausted'; readonly attempt: number }
  | { readonly event: 'newer_format_refused' }
  | { readonly event: 'slow_checkpoint'; readonly durationMs: number }
  | { readonly event: 'sweep_pass_completed'; readonly remaining: number }
  | { readonly event: 'sweep_paused'; readonly reason: ChatFormat4PauseReason }
  | {
      readonly event: 'sweep_scope_backed_off';
      readonly reason: ChatFormat4Reason;
    }
  | {
      readonly event: 'prehandoff_completed' | 'prehandoff_bound_exceeded';
      readonly durationMs: number;
      /** Unknown when the pass abandoned its scan; sent as `none`. */
      readonly remaining: number | undefined;
    }
) & {
  /** Set by whoever reports the outcome; see `chatFormat4TriggerLabel`. */
  readonly trigger?: ChatFormat4Trigger;
};

export type ChatFormat4Labels = {
  readonly format4_event: ChatFormat4Event;
  readonly format4_reason: ChatFormat4Reason;
  readonly format4_attempt: number;
  readonly format4_duration_bucket: ChatFormat4DurationBucket;
  readonly format4_remaining_bucket: ChatFormat4RemainingBucket;
  readonly format4_pause_reason: (typeof CHAT_FORMAT4_PAUSE_REASONS)[number];
  readonly format4_trigger: ChatFormat4Trigger;
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

export function chatFormat4RemainingBucket(
  remaining: number,
): ChatFormat4RemainingBucket {
  if (!Number.isFinite(remaining) || remaining <= 0) return '0';
  if (remaining <= 5) return '1_5';
  if (remaining <= 20) return '6_20';
  if (remaining <= 100) return '21_100';
  return 'gt_100';
}

const SWEEP_NONE = {
  format4_remaining_bucket: 'none',
  format4_pause_reason: 'none',
} as const;

function attemptLabel(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) return 1;
  return Math.min(attempt, CHAT_FORMAT4_MAX_ATTEMPT);
}

/**
 * The trigger an outcome is labelled with: its own when it is one of the
 * three fixed values, else the sweep for the sweep's own events and a load
 * for everything else.
 */
export function chatFormat4TriggerLabel(
  outcome: ChatFormat4Outcome,
): ChatFormat4Trigger {
  const trigger = CHAT_FORMAT4_TRIGGERS.find(
    (value) => value === outcome.trigger,
  );
  if (trigger) return trigger;
  if (outcome.event.startsWith('prehandoff_')) return 'pre-handoff';
  return outcome.event.startsWith('sweep_') ? 'sweep' : 'load';
}

/**
 * The labels one outcome sends: exactly the seven declared keys, each a
 * fixed code or a bounded number, whatever the caller passed.
 */
export function chatFormat4Labels(
  outcome: ChatFormat4Outcome,
): ChatFormat4Labels {
  return {
    ...outcomeLabels(outcome),
    format4_trigger: chatFormat4TriggerLabel(outcome),
  };
}

function outcomeLabels(
  outcome: ChatFormat4Outcome,
): Omit<ChatFormat4Labels, 'format4_trigger'> {
  switch (outcome.event) {
    case 'promoted':
    case 'retries_exhausted':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: attemptLabel(outcome.attempt),
        format4_duration_bucket: 'none',
        ...SWEEP_NONE,
      };
    case 'promotion_failed':
      return {
        format4_event: outcome.event,
        format4_reason: chatFormat4FailureReason(outcome.error),
        format4_attempt: attemptLabel(outcome.attempt),
        format4_duration_bucket: 'none',
        ...SWEEP_NONE,
      };
    case 'newer_format_refused':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: 'none',
        ...SWEEP_NONE,
      };
    case 'slow_checkpoint':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: chatFormat4DurationBucket(outcome.durationMs),
        ...SWEEP_NONE,
      };
    case 'sweep_pass_completed':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: 'none',
        format4_remaining_bucket: chatFormat4RemainingBucket(outcome.remaining),
        format4_pause_reason: 'none',
      };
    case 'sweep_paused':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: 'none',
        format4_remaining_bucket: 'none',
        format4_pause_reason: pauseLabel(outcome.reason),
      };
    case 'sweep_scope_backed_off':
      return {
        format4_event: outcome.event,
        format4_reason: reasonLabel(outcome.reason),
        format4_attempt: 0,
        format4_duration_bucket: 'none',
        format4_remaining_bucket: 'none',
        format4_pause_reason: 'none',
      };
    case 'prehandoff_completed':
    case 'prehandoff_bound_exceeded':
      return {
        format4_event: outcome.event,
        format4_reason: 'none',
        format4_attempt: 0,
        format4_duration_bucket: chatFormat4DurationBucket(outcome.durationMs),
        format4_remaining_bucket:
          outcome.remaining === undefined
            ? 'none'
            : chatFormat4RemainingBucket(outcome.remaining),
        format4_pause_reason: 'none',
      };
  }
}

function pauseLabel(
  reason: unknown,
): (typeof CHAT_FORMAT4_PAUSE_REASONS)[number] {
  return CHAT_FORMAT4_PAUSE_REASONS.find((value) => value === reason) ?? 'none';
}

function reasonLabel(reason: unknown): ChatFormat4Reason {
  return CHAT_FORMAT4_REASONS.find((value) => value === reason) ?? 'other';
}

const preHandoffWork = new AsyncLocalStorage<true>();

/**
 * Runs `work` so every format 4 outcome recorded while it runs, the
 * repository's own promotion outcomes included, is labelled `pre-handoff`.
 */
export function withChatFormat4PreHandoffTrigger<T>(
  work: () => Promise<T>,
): Promise<T> {
  return preHandoffWork.run(true, work);
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
  const recorded: ChatFormat4Outcome =
    preHandoffWork.getStore() === true
      ? { ...outcome, trigger: 'pre-handoff' }
      : outcome;
  setImmediate(() => {
    try {
      const context = chatFormat4Labels(recorded);
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
