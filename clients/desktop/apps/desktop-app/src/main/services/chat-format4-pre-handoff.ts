/**
 * The flip build's bounded pre-handoff format 4 pass (CAN-7178 PR 3).
 *
 * The daemon never writes format 3, so before the in-app host hands chat
 * storage over (CAN-7085), every start of the flip build promotes each stored
 * scope still below format 4, inside one shared deadline. It reads manifests
 * alone to find them, promotes only through the repository's own per-scope
 * lease, records nothing of its own, and reports only its duration and a
 * count bucket. A scope it can't reach in time, or can't promote, is left as
 * it was and counted as pending, for the next start.
 *
 * Dormant: nothing in the app calls it yet; the handoff wires it (CAN-7085).
 */
import {
  ChatDeltaJournalIntegrityError,
  ChatStorageNewerFormatError,
} from '../lib/chat-delta-journal/format';
import type { ChatStorageV2 } from '../lib/chat-storage-v2';
import { ChatTranscriptIntegrityError } from '../lib/chat-transcript-log';
import type { ChatScopeKey } from './chat-state-contracts';
import type { ChatStateV2Repository } from './chat-state-v2-repository';
import {
  chatFormat4CandidateHasRoom,
  chatFormat4FreeBytes,
  chatFormat4ScopeAdmitted,
  listChatFormat4SweepCandidates,
  orderChatFormat4SweepCandidates,
  type ChatFormat4SweepAdmission,
  type ChatFormat4SweepCandidate,
  type ChatFormat4SweepFormat,
} from './chat-format4-sweep';
import {
  recordChatFormat4Outcome,
  withChatFormat4PreHandoffTrigger,
  type ChatFormat4Outcome,
} from './chat-format4-telemetry';

/** The pass's whole time budget, from the start of the flip build. */
export const CHAT_FORMAT4_PRE_HANDOFF_BOUND_MS = 20_000;

/**
 * Past the deadline, each remaining manifest read is refused at once and its
 * scope counts as pending. The whole scan is abandoned only when it runs this
 * much past the later of the deadline and the pass's start, as when listing a
 * folder never returns.
 */
const SCAN_GRACE_MS = 1_000;

/** The longest delay a Node timer takes; a later deadline waits in steps. */
const MAX_TIMER_MS = 2_147_483_647;

/** One scope's outcome; every non-format-4 result leaves its bytes as they were. */
export type EnsureFormat4Result =
  | { readonly kind: 'format4'; readonly promoted: boolean }
  | {
      readonly kind: 'still_format3';
      readonly reason: 'deadline' | 'busy' | 'disk' | 'promotion_fault';
    }
  | {
      readonly kind: 'failed';
      readonly reason:
        | 'io'
        | 'unreadable'
        | 'newer_format'
        | 'legacy_migration';
      readonly retryable: boolean;
    };

/** One absolute deadline, shared by every read and scope of a pass. */
export interface EnsureFormat4Bound {
  readonly deadlineAt: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface EnsureFormat4Options {
  readonly repository: Pick<ChatStateV2Repository, 'sweepFormat4'>;
  /** Reads a scope's format from its manifest before the attempt. */
  readonly resolveStore: (scope: ChatScopeKey) => ChatStorageV2;
  readonly admission?: ChatFormat4SweepAdmission;
}

const PAST_DEADLINE = Symbol('past deadline');

function pastDeadline(bound: EnsureFormat4Bound): boolean {
  return (
    bound.signal?.aborted === true ||
    (bound.now ?? Date.now)() >= bound.deadlineAt
  );
}

/**
 * `work`, unless the deadline passes or the signal aborts first. A read that
 * never settles can't hold the pass past its bound; it is abandoned, and its
 * late result or error is ignored.
 */
async function beforeDeadline<T>(
  work: () => Promise<T>,
  bound: EnsureFormat4Bound,
): Promise<T | typeof PAST_DEADLINE> {
  if (pastDeadline(bound)) return PAST_DEADLINE;
  const running = work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const deadline = new Promise<typeof PAST_DEADLINE>((resolve) => {
    const wait = (): void => {
      const left = bound.deadlineAt - (bound.now ?? Date.now)();
      if (left <= 0) {
        resolve(PAST_DEADLINE);
        return;
      }
      timer = setTimeout(wait, Math.min(left, MAX_TIMER_MS));
      timer.unref();
    };
    onAbort = (): void => resolve(PAST_DEADLINE);
    bound.signal?.addEventListener('abort', onAbort, { once: true });
    wait();
  });
  running.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined)
      bound.signal?.removeEventListener('abort', onAbort);
  }
}

function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    chain.push(current);
    current =
      typeof current === 'object' && current !== null
        ? Reflect.get(current, 'cause')
        : undefined;
  }
  return chain;
}

function hasErrnoCode(error: unknown): boolean {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code);
}

/**
 * A manifest that can't be read. A newer format is refused; an errno from
 * the file system is retryable; anything else means the manifest itself is
 * damaged, a truncated format 4 one included, and is never converted.
 */
function unreadableManifest(error: unknown): EnsureFormat4Result {
  const chain = causes(error);
  if (chain.some((cause) => cause instanceof ChatStorageNewerFormatError))
    return { kind: 'failed', reason: 'newer_format', retryable: false };
  if (chain.some(hasErrnoCode))
    return { kind: 'failed', reason: 'io', retryable: true };
  return { kind: 'failed', reason: 'unreadable', retryable: false };
}

/**
 * A promotion attempt that failed after its manifest read fine. A newer
 * format is refused; a damaged journal, transcript or index is unreadable; an
 * errno from the file system is retryable, as is a legacy scope's migration;
 * anything else is unreadable too, as for a manifest, so a failure that can't
 * be named never reads as a retry that could succeed.
 */
function failedAttempt(
  cause: unknown,
  before: ChatFormat4SweepFormat,
): EnsureFormat4Result {
  const chain = causes(cause);
  if (chain.some((error) => error instanceof ChatStorageNewerFormatError))
    return { kind: 'failed', reason: 'newer_format', retryable: false };
  if (
    chain.some(
      (error) =>
        error instanceof ChatDeltaJournalIntegrityError ||
        error instanceof ChatTranscriptIntegrityError ||
        error instanceof SyntaxError,
    )
  )
    return { kind: 'failed', reason: 'unreadable', retryable: false };
  if (chain.some(hasErrnoCode))
    return { kind: 'failed', reason: 'io', retryable: true };
  if (before === 'v1')
    return { kind: 'failed', reason: 'legacy_migration', retryable: true };
  return { kind: 'failed', reason: 'unreadable', retryable: false };
}

/**
 * Brings one scope to format 4 if it can, before `bound.deadlineAt`. It is
 * idempotent: a scope already at format 4 answers `promoted: false` and is
 * not written. A scope another holder has is `busy` and never waited for.
 * The deadline bounds the manifest read and is checked before the scope's
 * lease is taken; a promotion already started always finishes, since it
 * can't stop part way through a write. A manifest that can't be parsed is
 * `unreadable`, and its scope is never loaded.
 */
export async function ensureFormat4(
  scope: ChatScopeKey,
  bound: EnsureFormat4Bound,
  options: EnsureFormat4Options,
): Promise<EnsureFormat4Result> {
  const admission = options.admission ?? {};
  if (pastDeadline(bound)) return { kind: 'still_format3', reason: 'deadline' };
  if (!chatFormat4ScopeAdmitted(scope, admission))
    return { kind: 'still_format3', reason: 'busy' };
  const store = options.resolveStore(scope);
  let before: ChatFormat4SweepFormat | typeof PAST_DEADLINE;
  try {
    before = await beforeDeadline(() => store.format(), bound);
  } catch (error) {
    return unreadableManifest(error);
  }
  if (before === PAST_DEADLINE || pastDeadline(bound))
    return { kind: 'still_format3', reason: 'deadline' };
  if (before === 'v4') return { kind: 'format4', promoted: false };
  // The repository reads the manifest again under the lease before it asks
  // `admit`, so the deadline is checked there too.
  const attempt = await options.repository.sweepFormat4(scope, {
    admit: () =>
      !pastDeadline(bound) && chatFormat4ScopeAdmitted(scope, admission),
  });
  switch (attempt.outcome) {
    case 'promoted':
      return { kind: 'format4', promoted: true };
    case 'already_format4':
      return { kind: 'format4', promoted: false };
    case 'held':
      return {
        kind: 'still_format3',
        reason: pastDeadline(bound) ? 'deadline' : 'busy',
      };
    case 'withheld':
      return { kind: 'still_format3', reason: 'promotion_fault' };
    case 'failed':
      // A promotion the backend undid leaves the scope at format 3.
      return attempt.cause === undefined
        ? { kind: 'still_format3', reason: 'promotion_fault' }
        : failedAttempt(attempt.cause, before);
  }
}

export interface ChatFormat4PreHandoffPassOptions
  extends EnsureFormat4Options, EnsureFormat4Bound {
  readonly dataDir: string;
  readonly report?: (outcome: ChatFormat4Outcome) => void;
  /** Free bytes on the volume holding a path; unknown is not room. */
  readonly freeBytes?: (path: string) => Promise<number | undefined>;
  /** Scopes promoted at once; one unless measured otherwise. */
  readonly concurrency?: number;
}

export interface ChatFormat4PreHandoffPassResult {
  /**
   * `complete` only when every stored scope was read and is at format 4;
   * `bound_exceeded` when the deadline left any scope unread or unstarted;
   * `incomplete` when every scope was tried but some are still pending.
   */
  readonly status: 'complete' | 'incomplete' | 'bound_exceeded';
  /** Each scope the pass found below format 4, or couldn't read, with its outcome. */
  readonly results: readonly {
    readonly scope: ChatScopeKey;
    readonly result: EnsureFormat4Result;
  }[];
  /** Scopes promoted to format 4 by this pass. */
  readonly promoted: number;
  /**
   * Stored scopes still pending: below format 4 or unread, plus any it
   * couldn't map. Unknown when the pass abandoned its scan of stored scopes.
   */
  readonly remaining: number | undefined;
  /** The deadline left a scope unread or unstarted. */
  readonly deadlineHit: boolean;
  readonly durationMs: number;
}

/**
 * One scope of a pass: past the deadline it isn't started, and without room
 * for twice its size plus the margin it is left as it is.
 */
async function promoteCandidate(
  candidate: ChatFormat4SweepCandidate,
  options: ChatFormat4PreHandoffPassOptions,
): Promise<EnsureFormat4Result> {
  if (pastDeadline(options))
    return { kind: 'still_format3', reason: 'deadline' };
  const room = await beforeDeadline(
    () =>
      chatFormat4CandidateHasRoom(
        candidate,
        options.freeBytes ?? chatFormat4FreeBytes,
      ),
    options,
  );
  if (room === PAST_DEADLINE)
    return { kind: 'still_format3', reason: 'deadline' };
  if (!room) return { kind: 'still_format3', reason: 'disk' };
  return ensureFormat4(candidate.scope, options, options);
}

/**
 * One pre-handoff pass: every stored scope below format 4, in the sweep's
 * order (the most recently used first, then the smallest), inside the shared
 * deadline. A manifest it can't read before the deadline, and a scope it
 * can't start, is busy or can't promote, counts as pending, never as done.
 * It writes nothing of its own: the next start's pass finds whatever is left
 * from the manifests again.
 */
export function runChatFormat4PreHandoffPass(
  options: ChatFormat4PreHandoffPassOptions,
): Promise<ChatFormat4PreHandoffPassResult> {
  return withChatFormat4PreHandoffTrigger(async () => {
    const now = options.now ?? Date.now;
    const report = options.report ?? recordChatFormat4Outcome;
    const startedAt = now();
    const inventory = await beforeDeadline(
      () =>
        listChatFormat4SweepCandidates(options.dataDir, options.resolveStore, {
          formatOnly: true,
          readFormat: async (store) => {
            const format = await beforeDeadline(() => store.format(), options);
            if (format === PAST_DEADLINE)
              throw new Error('The pre-handoff deadline passed');
            return format;
          },
        }),
      {
        ...options,
        deadlineAt: Math.max(options.deadlineAt, startedAt) + SCAN_GRACE_MS,
      },
    );
    const queue =
      inventory === PAST_DEADLINE
        ? []
        : orderChatFormat4SweepCandidates(
            inventory.candidates.filter(({ format }) => format !== 'v4'),
          );
    type ScopeResult = {
      readonly scope: ChatScopeKey;
      readonly result: EnsureFormat4Result;
    };
    const slots: (ScopeResult | undefined)[] = queue.map(() => undefined);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let index = next; index < queue.length; index = next) {
        next += 1;
        const candidate = queue[index];
        if (candidate === undefined) continue;
        slots[index] = {
          scope: candidate.scope,
          result: await promoteCandidate(candidate, options),
        };
      }
    };
    await Promise.all(
      Array.from(
        {
          length: Math.max(1, Math.min(options.concurrency ?? 1, queue.length)),
        },
        worker,
      ),
    );
    const results = slots.filter(
      (slot): slot is ScopeResult => slot !== undefined,
    );
    const pending = results.filter(({ result }) => result.kind !== 'format4');
    const promoted = results.filter(
      ({ result }) => result.kind === 'format4' && result.promoted,
    ).length;
    const remaining =
      inventory === PAST_DEADLINE
        ? undefined
        : pending.length + inventory.unmapped;
    const boundExceeded =
      inventory === PAST_DEADLINE ||
      pending.some(
        ({ result }) =>
          result.kind === 'still_format3' && result.reason === 'deadline',
      );
    const status = boundExceeded
      ? 'bound_exceeded'
      : remaining === 0
        ? 'complete'
        : 'incomplete';
    const durationMs = Math.max(0, now() - startedAt);
    report({
      event: boundExceeded
        ? 'prehandoff_bound_exceeded'
        : 'prehandoff_completed',
      durationMs,
      remaining,
    });
    return {
      status,
      results,
      promoted,
      remaining,
      deadlineHit: boundExceeded,
      durationMs,
    };
  });
}
