import type { RuntimeHealthCheck } from '@canopy/core-runtime';
import {
  canopyErrorDiagnostic,
  type CanopyErrorDiagnostic,
} from '@canopy/protocol/canopy-core';

/** The operation ledger's service, and its health check's name. */
export const DAEMON_OPERATION_LEDGER_SERVICE = 'core.operation.ledger';

/**
 * What the operation service reports to `onError`; any other context reads
 * as `other`, so the check carries only closed values.
 */
const CONTEXTS = [
  'finish',
  'transition',
  'recover',
  'cancel-child',
  'listener',
] as const;

type FailureContext = (typeof CONTEXTS)[number] | 'other';

export interface DaemonOperationLedgerFailures {
  /** The operation service's `onError`. */
  readonly record: (error: unknown, context: string) => void;
  /** `warn` once a failure nobody could return was recorded. */
  readonly health: () => RuntimeHealthCheck;
}

/**
 * Where the daemon keeps operation ledger failures no caller can see, such
 * as a finish that failed twice and left its record unfinished (CAN-7116).
 * The daemon has no telemetry sink, so they surface on its health check:
 * a count and the last failure's context and diagnostic (class, system code
 * and V8 frames), never its message.
 */
export function createDaemonOperationLedgerFailures(): DaemonOperationLedgerFailures {
  let failures = 0;
  let last:
    | { context: FailureContext; diagnostic: CanopyErrorDiagnostic }
    | undefined;
  return {
    record: (error, context): void => {
      failures += 1;
      last = {
        context: CONTEXTS.find((known) => known === context) ?? 'other',
        diagnostic: canopyErrorDiagnostic(error),
      };
    },
    health: (): RuntimeHealthCheck =>
      last === undefined
        ? {
            name: DAEMON_OPERATION_LEDGER_SERVICE,
            status: 'pass',
            message: null,
          }
        : {
            name: DAEMON_OPERATION_LEDGER_SERVICE,
            status: 'warn',
            message: 'Some operation records could not be updated.',
            reason: 'background_failure',
            details: {
              failures,
              context: last.context,
              diagnostic: last.diagnostic,
            },
          },
  };
}
