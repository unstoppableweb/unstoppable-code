import { createHash, randomUUID } from 'node:crypto';
// Explicit commit-log modules only: the commit-log index loads node:sqlite,
// which only the worker opens.
import type {
  W5CommitRequest,
  W5ReceiptLookup,
  W5ReservationFailureDiagnostics,
} from './commit-log/commit-log';
import { W5CommitRefusedError } from './commit-log/errors';
import { isRecord } from './commit-log/is-record';
import type { W5CommitLogFileStore } from './commit-log-file-store';
import type { W5CommitOptions } from './commit-scope';

const preEffectRefusals = new WeakSet<object>();

/** Confirmed pre-effect failure with a durably released reservation. */
export function isW5PreEffectRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && preEffectRefusals.has(error)
  );
}

/** Owned by one keyed attempt; no async-context state leaks into child operations. */
export interface W5KeyedAttempt {
  beforeEffects(this: void): void;
  /** Only after a closed effect is proved absent and its staged decision is removed. */
  confirmEffectsAbsent(this: void, error: Error): Error;
  /** Capture only this boundary's synchronous, read-only validation errors. */
  validate(this: void, check: () => void): void;
  /** Tag an error created by a read-only branch/base validator; preserve identity/copy. */
  validationError(this: void, error: Error): Error;
}

/**
 * CAN-5377: a read-only lifecycle-journal admission, called before the
 * attempt's first effect. Its `recovery-required` refusal describes existing
 * evidence, not this attempt, so it releases a new reservation for a retry
 * after repair. Nothing else is tagged, and after `beforeEffects()` the tag
 * no longer releases.
 */
export async function admitLifecycleJournals<T>(
  attempt: W5KeyedAttempt | undefined,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      attempt &&
      error instanceof W5CommitRefusedError &&
      error.reason === 'recovery-required'
    )
      throw attempt.validationError(error);
    throw error;
  }
}

/** Keyed admission never acquires repository leases or the final decision queue. */
export type W5ReceiptStore = Pick<
  W5CommitLogFileStore,
  | 'lookupReceipt'
  | 'reserve'
  | 'releaseReservation'
  | 'markReservationRecoveryRequired'
>;

export type W5AttemptHold = <R>(run: () => Promise<R>) => Promise<R>;

export interface W5KeyedOperationInput {
  /** Trusted host-composed caller identity, distinct from the writer principal. */
  caller: string;
  operation: string;
  idempotencyKey: string;
  parameters: unknown;
  /** State-dependent read-only admission runs only for a new key. */
  admit?: () => Promise<void>;
  /**
   * Holds what the attempt writes (the host's storage admission) from the
   * reservation until the attempt settles. The lookup and `admit` run before
   * it, so an admission that waits on the network holds nothing.
   */
  hold?: W5AttemptHold;
  /** Boundary-owned typed refusals, only safe before the attempt's first effect. */
  isPreEffectRefusal: (error: unknown) => boolean;
  /** Observes that a saved outcome is returned instead of running the work. */
  onReplay?: () => void;
}

export type W5KeyedOperationRunner = <T>(
  input: W5KeyedOperationInput,
  decode: (outcome: unknown) => T,
  work: (binding: W5CommitOptions, attempt: W5KeyedAttempt) => Promise<T>,
) => Promise<T>;

export interface W5KeyedOperationBindings {
  /** Resolved once per attempt, after the parameters are hashed. */
  getReceiptStore: () => W5ReceiptStore;
}

function failureDiagnostics(
  operation: string,
  error: unknown,
): W5ReservationFailureDiagnostics {
  const diagnostics: W5ReservationFailureDiagnostics = {
    operation,
    errorName: 'UnknownError',
  };
  try {
    if (
      error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
    )
      diagnostics.errorName = error.name;
    if (
      isRecord(error) &&
      typeof error.code === 'string' &&
      /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
    )
      diagnostics.errorCode = error.code;
  } catch {
    // Error accessors are untrusted too. Never substitute the original failure.
  }
  return diagnostics;
}

/** Sorted JSON object keys; array order is semantic. Callers select validated fields. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value))
    return value;
  throw new Error('W5 parameters must be JSON values');
}

/** Shared by the keyed owner and its qualified offline relocation projection. */
export function fingerprintW5Parameters(parameters: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(parameters)))
    .digest('hex');
}

/** No lock spans effects. SQLite reservation uniqueness closes concurrent admission. */
export function createW5KeyedOperationRunner(
  bindings: W5KeyedOperationBindings,
): W5KeyedOperationRunner {
  return async function runKeyedW5Operation<T>(
    input: W5KeyedOperationInput,
    decode: (outcome: unknown) => T,
    work: (binding: W5CommitOptions, attempt: W5KeyedAttempt) => Promise<T>,
  ): Promise<T> {
    const receipt: NonNullable<W5CommitRequest['receipt']> = {
      caller: input.caller,
      operation: input.operation,
      idempotencyKey: input.idempotencyKey,
      fingerprint: fingerprintW5Parameters(input.parameters),
    };
    const store = bindings.getReceiptStore();
    const replay = (outcome: T): T => {
      try {
        input.onReplay?.();
      } catch {
        // An observer failure never changes the saved outcome or its replay.
      }
      return outcome;
    };
    const admit = (
      lookup: W5ReceiptLookup,
    ): { status: 'none' } | { status: 'replay'; outcome: T } => {
      switch (lookup.status) {
        case 'replay':
          return { status: 'replay', outcome: decode(lookup.outcome) };
        case 'key-reused':
          throw new W5CommitRefusedError(
            'key-reused',
            'This request was already completed with different details.',
          );
        case 'replay-expired':
          throw new W5CommitRefusedError(
            'outcome-expired',
            'This request was already completed; its saved outcome has expired.',
            { commitId: lookup.commitId },
          );
        case 'in-progress':
          throw new W5CommitRefusedError(
            'in-progress',
            'This request is still in progress.',
            { reservationId: lookup.reservationId },
          );
        case 'commit-recovery-required':
          throw new W5CommitRefusedError(
            'recovery-required',
            'This request was saved but did not finish and needs recovery.',
            { commitId: lookup.commitId },
          );
        case 'recovery-required':
          throw new W5CommitRefusedError(
            'recovery-required',
            'An earlier attempt of this request was interrupted and needs recovery.',
            { reservationId: lookup.reservationId },
          );
        case 'none':
          return { status: 'none' };
      }
    };
    const admission = admit(await store.lookupReceipt(receipt));
    if (admission.status === 'replay') return replay(admission.outcome);
    try {
      await input.admit?.();
    } catch (error) {
      // A concurrent winner may have changed the state admission reads.
      const latest = admit(await store.lookupReceipt(receipt));
      if (latest.status === 'replay') return replay(latest.outcome);
      throw error;
    }
    const reserveAndRun = async (): Promise<T> => {
      const reservationId = randomUUID();
      // Reclassify a racing winner after a reserve refusal, without retrying work.
      // Never release uncertain reservations.
      try {
        await store.reserve({
          reservationId,
          operation: input.operation,
          receipt,
        });
      } catch (error) {
        if (error instanceof W5CommitRefusedError) {
          const latest = admit(await store.lookupReceipt(receipt));
          if (latest.status === 'replay') return replay(latest.outcome);
        }
        throw error;
      }
      let effectsStarted = false;
      const validationErrors = new Set<unknown>();
      const attempt: W5KeyedAttempt = {
        beforeEffects: () => {
          effectsStarted = true;
        },
        validate: (check) => {
          try {
            check();
          } catch (error) {
            validationErrors.add(error);
            throw error;
          }
        },
        confirmEffectsAbsent: (error) => {
          effectsStarted = false;
          validationErrors.add(error);
          return error;
        },
        validationError: (error) => {
          validationErrors.add(error);
          return error;
        },
      };
      try {
        return await work(
          {
            operation: input.operation,
            receipt,
            reservationId,
            beforeDecision: attempt.beforeEffects,
          },
          attempt,
        );
      } catch (error) {
        try {
          if (
            !effectsStarted &&
            (validationErrors.has(error) || input.isPreEffectRefusal(error))
          ) {
            await store.releaseReservation(reservationId);
            if (typeof error === 'object' && error !== null)
              preEffectRefusals.add(error);
          } else {
            await store.markReservationRecoveryRequired(
              reservationId,
              failureDiagnostics(input.operation, error),
            );
          }
        } catch {
          // Keep the original error, including when a decision already consumed the
          // reservation or the worker is unavailable. Launch recovery is the fallback.
        }
        throw error;
      }
    };
    return input.hold ? input.hold(reserveAndRun) : reserveAndRun();
  };
}
