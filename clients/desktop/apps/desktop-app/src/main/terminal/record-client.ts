import {
  WORKER_TERMINAL_RECORD_SCHEMA_REVISION,
  type WorkerTerminalRecordApplyParams,
  type WorkerTerminalRecordApplyResult,
  type WorkerTerminalRecordClient,
  type WorkerTerminalRecordHistoryReadParams,
  type WorkerTerminalRecordHistoryReadResult,
  type WorkerTerminalRecordOpenResult,
  type WorkerTerminalRecordRetireParams,
  type WorkerTerminalRecordShutdownParams,
} from '@canopy/protocol/canopy-core';
import type { ElectronDaemonClient } from '../canopy-runtime/electron-daemon-host';
import { getElectronDaemonHealth } from '../canopy-runtime/electron-daemon-health';

/**
 * Main's calls to the daemon's terminal record authority (CAN-7051), over
 * main's own terminal session. Each call resolves the current session and
 * checks its manifest; a daemon that cannot be reached, or that does not
 * serve the record, answers `null` and the caller defers.
 */
export interface TerminalRecordClientPort {
  /** Whether the current daemon keeps terminal records; never throws. */
  available(): Promise<boolean>;
  /** Cached reachability only: no connection attempt, record read or disk I/O. */
  peekAvailable?(): boolean;
  open(
    client: WorkerTerminalRecordClient,
  ): Promise<WorkerTerminalRecordOpenResult>;
  historyRead(
    params: WorkerTerminalRecordHistoryReadParams,
  ): Promise<WorkerTerminalRecordHistoryReadResult>;
  apply(
    params: WorkerTerminalRecordApplyParams,
  ): Promise<WorkerTerminalRecordApplyResult>;
  retire(
    params: WorkerTerminalRecordRetireParams,
  ): Promise<{ retired: number } | void>;
  shutdown(signal: WorkerTerminalRecordShutdownParams['signal']): Promise<void>;
}

/** The connection serves the record and its revision 2 attribution. */
export function keepsTerminalRecords(
  session: Pick<ElectronDaemonClient, 'manifest'>,
): boolean {
  const { manifest } = session;
  return (
    manifest.has('operations', 'worker.terminal.record.open') &&
    manifest.has('operations', 'worker.terminal.record.apply') &&
    (manifest.schemaRevisions?.get('worker.terminal.create') ?? 0) >=
      WORKER_TERMINAL_RECORD_SCHEMA_REVISION
  );
}

class RecordUnavailableError extends Error {
  public constructor() {
    super('The terminal record authority is unavailable.');
    this.name = 'RecordUnavailableError';
  }
}

let negotiatedSession:
  | { signal: AbortSignal; keepsRecords: boolean }
  | undefined;

/** Updated by every terminal-session negotiation, including non-record callers. */
export function noteTerminalRecordSession(
  session: Pick<ElectronDaemonClient, 'manifest' | 'signal'>,
): void {
  negotiatedSession = {
    signal: session.signal,
    keepsRecords: keepsTerminalRecords(session),
  };
}

async function recordSession(): Promise<ElectronDaemonClient> {
  // A latched daemon is not contacted: each read would respawn it.
  if (getElectronDaemonHealth().isLatched()) throw new RecordUnavailableError();
  const route = await import('./daemon-terminal-route');
  const session = await route.daemonTerminalSession();
  noteTerminalRecordSession(session);
  if (!keepsTerminalRecords(session)) throw new RecordUnavailableError();
  return session;
}

export const daemonTerminalRecordClient: TerminalRecordClientPort = {
  // The existing terminal lease owns reconnect. Probes must not acquire one,
  // which can prepare the data root or relaunch a failed daemon.
  peekAvailable: () =>
    negotiatedSession !== undefined &&
    !negotiatedSession.signal.aborted &&
    negotiatedSession.keepsRecords &&
    getElectronDaemonHealth().getStatus().state === 'ok',
  available: async () => {
    try {
      await recordSession();
      return true;
    } catch {
      return false;
    }
  },
  open: async (client) =>
    (await recordSession()).instruction('worker.terminal.record.open', {
      client,
    }),
  historyRead: async (params) =>
    (await recordSession()).query(
      'worker.terminal.record.history.read',
      params,
    ),
  apply: async (params) =>
    (await recordSession()).instruction('worker.terminal.record.apply', params),
  retire: async (params) => {
    return await (
      await recordSession()
    ).instruction('worker.terminal.record.retire', params);
  },
  shutdown: async (signal) => {
    await (
      await recordSession()
    ).instruction('worker.terminal.record.shutdown', { signal });
  },
};
