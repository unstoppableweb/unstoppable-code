import { createHash } from 'node:crypto';
import { stableStringify } from '@canopy/protocol/plans';
import type { CanopyHandlerContext } from '../../runtime/types';

/** Keyed outcomes this worker keeps for replay; the oldest are dropped. */
export const MAX_KEYED_OUTCOMES = 512;

/**
 * Keyed replay for this worker's instructions: a repeat with the same caller,
 * key and parameters returns the first outcome, joining it while it runs,
 * instead of running the script again; other parameters are refused. Kept in
 * memory: across a restart the core's dispatch record resolves the outcome.
 * A rejection `forget` accepts is dropped once it settles, so a retry with
 * the same key runs again instead of replaying it.
 */
export class KeyedOutcomes<T> {
  constructor(
    private readonly options: {
      reusedError: () => Error;
      max?: number;
      forget?: (error: unknown) => boolean;
    },
  ) {}

  private readonly outcomes = new Map<
    string,
    { fingerprint: string; outcome: Promise<T> }
  >();

  run(
    context: CanopyHandlerContext,
    params: unknown,
    start: () => Promise<T>,
  ): Promise<T> {
    const key = context.metadata.idempotencyKey;
    if (key === undefined) return start();
    const id = `${context.caller.principalId}\0${key}`;
    const fingerprint = createHash('sha256')
      .update(stableStringify(params) ?? 'null')
      .digest('hex');
    const existing = this.outcomes.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        return Promise.reject(this.options.reusedError());
      return existing.outcome;
    }
    const outcome = start();
    this.outcomes.set(id, { fingerprint, outcome });
    outcome.catch((error: unknown) => {
      if (
        this.options.forget?.(error) &&
        this.outcomes.get(id)?.outcome === outcome
      )
        this.outcomes.delete(id);
    });
    while (this.outcomes.size > (this.options.max ?? MAX_KEYED_OUTCOMES)) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      this.outcomes.delete(oldest);
    }
    return outcome;
  }
}
