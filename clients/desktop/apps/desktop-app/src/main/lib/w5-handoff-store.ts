import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type { CanopyDaemonRefusal } from '@canopy/core-client/node';
import { nodeW5FileStore } from './w5-file-store';

/*
 * TRANSITIONAL (CAN-5543, GB12): the W5 store the flip launch installs before
 * any W5 call. Calls wait for the startup handoff, then run on the
 * daemon-backed store, or on the degraded store when the handoff failed:
 * direct reads, every write refused. Never the in-process commit log. Remove
 * at W15 with the legacy writers.
 */

/** Why the handoff failed. Additive: later lanes append, never rename. */
export type W5HandoffFailure =
  | CanopyDaemonRefusal
  /** No daemon could be attached or started: shown as its own warning. */
  | 'daemon_unavailable'
  /** The one-time pre-flip backup was refused; `detail` names its reason. */
  | 'backup_refused'
  /** W11 registration failed, so the in-process host refuses the backup. */
  | 'host_admission_failed'
  /** The in-process commit log worker did not stop, so no daemon spawned. */
  | 'in_process_host_running'
  /** The app quit before the handoff finished; no warning. */
  | 'cancelled';

export class W5DaemonHandoffError extends Error {
  declare readonly cause?: unknown;
  constructor(
    readonly reason: W5HandoffFailure,
    /** A path-free sub-reason, such as the backup refusal. */
    readonly detail?: string,
    /** The error behind this one, when there is one. */
    readonly underlying?: unknown,
  ) {
    super(
      `W5 startup handoff failed (${reason}${detail ? `: ${detail}` : ''})`,
    );
    this.name = 'W5DaemonHandoffError';
    if (underlying !== undefined)
      Object.defineProperty(this, 'cause', {
        value: underlying,
        configurable: true,
        writable: true,
      });
  }
}

/** Direct reads, as the legacy store reads; every write and keyed call refuses `error`. */
export function createW5DegradedStore(
  error: W5DaemonHandoffError,
): W5CommitLogFileStore {
  const refuse = (): Promise<never> => Promise.reject(error);
  return {
    read: (path) => nodeW5FileStore.read(path),
    replace: refuse,
    remove: refuse,
    withCommit: refuse,
    lookupReceipt: refuse,
    reserve: refuse,
    readReservations: refuse,
    updateReservationDiagnostics: refuse,
    releaseReservation: refuse,
    markReservationRecoveryRequired: refuse,
    readRevisions: refuse,
    // Query views read live for it (`handoff-degraded`).
    capture: refuse,
    captureForPreparation: refuse,
  };
}

/**
 * Waits once for `outcome`, then forwards every call. A rejected outcome
 * selects the degraded store with the handoff's typed error. Once settled,
 * calls forward synchronously, keeping each one's admission context.
 */
export function createW5HandoffStore(
  outcome: Promise<W5CommitLogFileStore>,
): W5CommitLogFileStore {
  let settled: W5CommitLogFileStore | undefined;
  const ready = outcome.then(
    (store) => (settled = store),
    (error: unknown) =>
      (settled = createW5DegradedStore(
        error instanceof W5DaemonHandoffError
          ? error
          : new W5DaemonHandoffError('daemon_unavailable', undefined, error),
      )),
  );
  const use = <T>(
    call: (store: W5CommitLogFileStore) => Promise<T>,
  ): Promise<T> => (settled ? call(settled) : ready.then(call));
  return {
    read: (path) => use((s) => s.read(path)),
    remove: (path, storage, removal) =>
      use((s) => s.remove(path, storage, removal)),
    replace: (path, contents, storage, replacement) =>
      use((s) => s.replace(path, contents, storage, replacement)),
    withCommit: (options, work) => use((s) => s.withCommit(options, work)),
    lookupReceipt: (receipt) => use((s) => s.lookupReceipt(receipt)),
    reserve: (input) => use((s) => s.reserve(input)),
    readReservations: () => use((s) => s.readReservations()),
    updateReservationDiagnostics: (id, diagnostics) =>
      use((s) => s.updateReservationDiagnostics(id, diagnostics)),
    releaseReservation: (id) => use((s) => s.releaseReservation(id)),
    markReservationRecoveryRequired: (id, diagnostics) =>
      use((s) => s.markReservationRecoveryRequired(id, diagnostics)),
    readRevisions: (...args) => use((s) => s.readRevisions(...args)),
    captureForPreparation: (request) =>
      use((s) =>
        s.captureForPreparation
          ? s.captureForPreparation(request)
          : Promise.resolve({ status: 'unsupported' }),
      ),
    capture: (request) =>
      use((s) =>
        s.capture
          ? s.capture(request)
          : Promise.reject(
              new Error('The W5 store has no capture for query views.'),
            ),
      ),
  };
}
