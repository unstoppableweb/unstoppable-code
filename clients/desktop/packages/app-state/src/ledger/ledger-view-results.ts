import type {
  LedgerActorLabel,
  LedgerErrorReason,
} from '@canopy/protocol/canopy-core';
import type {
  LedgerViewResult,
  LedgerViewUnavailableReason,
} from '@canopy/protocol/ledger-view';
import { sameLedgerValue } from './ledger-structural-sharing';

/*
 * What the Ledger panel's and the Feed's stores share: how a read's result
 * becomes something to show, and the search text the Ledger accepts.
 */

/** Why a read gave nothing to show. Never an empty result. */
export type LedgerViewProblem =
  | {
      readonly kind: 'unavailable';
      readonly reason: LedgerViewUnavailableReason;
    }
  | {
      readonly kind: 'error';
      readonly reason: LedgerErrorReason | 'UNKNOWN';
      readonly message: string;
    };

/** What a read that failed means to a view. */
export function problemOf(
  result: Exclude<LedgerViewResult<unknown>, { status: 'ok' }>,
): LedgerViewProblem {
  return result.status === 'unavailable'
    ? { kind: 'unavailable', reason: result.reason }
    : keepCause(
        { kind: 'error', reason: result.reason, message: result.message },
        result,
      );
}

/**
 * Carries a {@link thrownResult}'s non-enumerable `cause` onto the problem a
 * view keeps, so the caught error stays reachable for local debugging without
 * reaching what is rendered, serialized or recorded.
 */
export function keepCause<T extends object>(value: T, from: object): T {
  const cause: unknown = Reflect.get(from, 'cause');
  if (cause !== undefined)
    Object.defineProperty(value, 'cause', { value: cause, enumerable: false });
  return value;
}

/**
 * A transport failure the client did not turn into a result. The message is
 * fixed copy: a caught message can quote paths and command output, so it
 * stays out of what the views render and replay records. The caught error
 * stays on a non-enumerable `cause` for local debugging.
 */
export function thrownResult(error: unknown): LedgerViewResult<never> {
  const result: LedgerViewResult<never> = {
    status: 'error',
    reason: 'UNKNOWN',
    message: "Couldn't complete this action.",
  };
  Object.defineProperty(result, 'cause', { value: error, enumerable: false });
  return result;
}

/** Query text as the Ledger accepts it: no control characters, bounded. */
export { normalizeLedgerViewQuery as normalizeQuery } from '@canopy/protocol/ledger-view';

/** Adds labels to those a view already holds. */
export function withActors(
  current: Readonly<Record<string, LedgerActorLabel>>,
  labels: readonly LedgerActorLabel[] | undefined,
): Readonly<Record<string, LedgerActorLabel>> {
  if (labels === undefined || labels.length === 0) return current;
  // Unchanged labels keep the same object, so a refresh redraws nothing.
  const changed = labels.filter(
    (label) => !sameLedgerValue(current[label.actorId], label),
  );
  if (changed.length === 0) return current;
  const next: Record<string, LedgerActorLabel> = { ...current };
  for (const label of changed) next[label.actorId] = label;
  return next;
}
