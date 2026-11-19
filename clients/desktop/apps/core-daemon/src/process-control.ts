import { CanopyEndpointRepairRequiredError } from '@canopy/core-runtime/node';
import { CANOPY_DAEMON_EXIT_ENDPOINT_REPAIR_REQUIRED } from '@canopy/core-transport/node';
import { BuildStorageStartupRefused } from '@canopy/core-runtime/node/build-storage-startup';
import { W5MaintenanceRefusedError } from '@canopy/core-runtime/node/w5/maintenance-types';
import { w5RecoveryRefusalExitCode } from '@canopy/core-transport';
import { LocalAuthorityIdentityError } from '@canopy/core-platform';

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

export interface StopRequests {
  readonly signal: AbortSignal;
  /**
   * Resolves with the first stop reason: a signal (even one received
   * earlier), or the host's own request, named by its string or `idle`.
   */
  next(idle: Promise<unknown>): Promise<string>;
}

/**
 * Listens before startup so a signal that lands mid-startup still runs the
 * bounded startup cancellation or phased stop, instead of Node's default termination.
 * Listeners stay for the process lifetime, so a repeated signal during the
 * stop is ignored instead of falling through to the default handler.
 */
export function listenForStopSignals(host: {
  on(signal: (typeof STOP_SIGNALS)[number], listener: () => void): unknown;
}): StopRequests {
  const cancellation = new AbortController();
  let received: string | undefined;
  let waiting: ((reason: string) => void) | undefined;
  for (const signal of STOP_SIGNALS)
    host.on(signal, () => {
      received ??= `signal ${signal}`;
      cancellation.abort();
      waiting?.(received);
    });
  return {
    signal: cancellation.signal,
    next: (idle) =>
      received === undefined
        ? new Promise<string>((resolve) => {
            waiting = resolve;
            void idle.then((reason) =>
              resolve(typeof reason === 'string' ? reason : 'idle'),
            );
          })
        : Promise.resolve(received),
  };
}

/**
 * Composition errors are fixed text. Node system errors embed paths, and
 * anything else is unknown, so neither is printed verbatim.
 */
export function publicErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'Daemon failed.';
  if ('syscall' in error)
    return 'code' in error && typeof error.code === 'string'
      ? `Daemon failed: ${error.code}.`
      : 'Daemon failed.';
  return Object.getPrototypeOf(error) === Error.prototype
    ? error.message
    : 'Daemon failed.';
}

/** Recovery refusals have private status codes; other lifecycle failures exit 1. */
export function failureOutcome(error: unknown): {
  readonly code: number;
  readonly message: string;
} {
  return {
    code:
      error instanceof CanopyEndpointRepairRequiredError
        ? CANOPY_DAEMON_EXIT_ENDPOINT_REPAIR_REQUIRED
        : error instanceof W5MaintenanceRefusedError
          ? (w5RecoveryRefusalExitCode(error.reason) ?? 1)
          : 1,
    message:
      error instanceof LocalAuthorityIdentityError ||
      error instanceof CanopyEndpointRepairRequiredError ||
      error instanceof BuildStorageStartupRefused
        ? error.message
        : publicErrorMessage(error),
  };
}
