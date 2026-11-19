import type { RuntimeHealthCheck } from '@canopy/core-runtime';
import {
  canopyErrorDiagnostic,
  type CanopyErrorDiagnostic,
} from '@canopy/protocol/canopy-core';

/** The execution accounting's service, and its health check's name. */
const DAEMON_EXECUTION_ACCOUNTING_SERVICE = 'core.execution.accounting';

export interface DaemonExecutionSampleFailures {
  /** The accounting's `onSampleFailure`. */
  readonly record: (error: unknown) => void;
  /** `warn` once a sample failed, so reads may be serving an older one. */
  readonly health: () => RuntimeHealthCheck;
}

/**
 * Where the daemon keeps failed execution samples (CAN-7116). A read keeps
 * the last snapshot and the daemon's timers drop the error, so they surface
 * on the accounting's health check: a count and the last failure's
 * diagnostic (class, system code and V8 frames), never its message. The
 * check stays `warn` once set, as the operation ledger's does; the daemon's
 * guard is off, so a stale sample only delays what it reports.
 */
export function createDaemonExecutionSampleFailures(): DaemonExecutionSampleFailures {
  let failures = 0;
  let last: CanopyErrorDiagnostic | undefined;
  return {
    record: (error): void => {
      failures += 1;
      last = canopyErrorDiagnostic(error);
    },
    health: (): RuntimeHealthCheck =>
      last === undefined
        ? {
            name: DAEMON_EXECUTION_ACCOUNTING_SERVICE,
            status: 'pass',
            message: null,
          }
        : {
            name: DAEMON_EXECUTION_ACCOUNTING_SERVICE,
            status: 'warn',
            message: 'A resource sample failed.',
            reason: 'background_failure',
            details: { failures, diagnostic: last },
          },
  };
}
