import {
  createW5KeyedOperationRunner,
  type W5KeyedAttempt,
  type W5KeyedOperationInput,
} from '@canopy/core-runtime/node/w5/keyed-operation';
import { getW5ReceiptStore } from './w5-commit-log-file-store';
import type { W5CommitOptions } from './w5-commit-scope';
import {
  workspaceCreationDiagnosticsSchema,
  type WorkspaceCreationDiagnostics,
} from '@canopy/core-runtime/node/w5/commit-log/reservation-diagnostics';

export {
  admitLifecycleJournals,
  type W5KeyedAttempt,
} from '@canopy/core-runtime/node/w5/keyed-operation';

/**
 * The core keyed runner over desktop main's receipt store, resolved at call
 * time so test injection and spies still intercept. A hoisted declaration
 * with no module-level runner, so import cycles cannot reach it uninitialized.
 */
export function runKeyedW5Operation<T>(
  input: W5KeyedOperationInput,
  decode: (outcome: unknown) => T,
  work: (binding: W5CommitOptions, attempt: W5KeyedAttempt) => Promise<T>,
  diagnostics?: WorkspaceCreationDiagnostics,
): Promise<T> {
  return createW5KeyedOperationRunner({
    getReceiptStore: () => {
      const store = getW5ReceiptStore();
      const seed = workspaceCreationDiagnosticsSchema.safeParse(diagnostics);
      if (!seed.success) return store;
      return {
        lookupReceipt: (receipt) => store.lookupReceipt(receipt),
        releaseReservation: (id) => store.releaseReservation(id),
        markReservationRecoveryRequired: (id, failure) =>
          store.markReservationRecoveryRequired(id, failure),
        reserve: (input) =>
          store.reserve({
            ...input,
            // Diagnostics must never introduce a new admission prerequisite.
            diagnostics: seed.data,
          }),
      };
    },
  })(input, decode, work);
}
