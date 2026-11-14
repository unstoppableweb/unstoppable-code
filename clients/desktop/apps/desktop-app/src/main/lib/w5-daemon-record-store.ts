import type { CanopyClient } from '@canopy/core-client';
import {
  createW5CommitLogFileStore,
  type W5CommitLogFileStore,
} from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  createW5RecordHostPort,
  type W5RecordPortTransport,
} from '@canopy/core-runtime/node/w5/record-port';
import type {
  CoreWorkspaceRecordsCommitParams,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import { admitStorageWrite } from '@canopy/execution-engine/node/lib/storage-admission';
import { logMainProcessWarn } from './main-process-logging';
import { getWorkspacesRootDir } from './paths';
import { __setDesktopW5FileStoreForTests } from './w5-commit-log-file-store';
import {
  recordW5PortConflict,
  setW5PreEffectAttempts,
  W5_DAEMON_PRE_EFFECT_ATTEMPTS,
} from './w5-pre-effect-retry';
import { recordW5RecordUnserved } from './w5-record-unserved';
import { admitW5Storage } from './w5-storage';
import { countingW5RecordPortTransport } from './w5-work-counters';
import { recordW5Work } from '@canopy/desktop-shared/node/work-counters';

/*
 * TRANSITIONAL (CAN-5498, W6g): Electron main's W5 store over a daemon that
 * hosts the commit log, through the trusted `core.workspaceRecords.*` port.
 * Tombstones, the sidebar group reconciler, publication and the destructive
 * journals stay here; the daemon decides, and holds receipts and reservations
 * (CAN-5506), whose diagnostics this store builds and alone reads back
 * (DQ-7 reading (i)). The daemon opens the log exclusively and a scope cannot
 * span stores, so once it hosts the log every W5 write must take this store.
 * Production installs it only on a flip build, behind the startup handoff
 * (CAN-5543, `w5-flip-handoff.ts`), with its client from
 * `leaseElectronW5RecordPort`, so W5e skips this store's commits as
 * Electron's own (CAN-5528). Test and qualification compositions, including
 * the E2E-only performance arm (CAN-5532,
 * `e2e-fixtures/w5-daemon-record-store-arm.ts`), also install it. Remove at W15.
 */

export type W5RecordPortClient = CanopyClient<
  typeof CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  typeof CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  Record<never, never>
>;

/** One record-port call: its operation, whether it is an instruction, and its run. */
export type W5RecordRecoveryTarget =
  CoreWorkspaceRecordsCommitParams['files'][number]['target'];

export type W5RecordPortCall<T> = (
  | {
      readonly kind: 'query';
      readonly operation: keyof typeof CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS;
      run(client: W5RecordPortClient): Promise<T>;
    }
  | {
      readonly kind: 'instruction';
      readonly operation: keyof typeof CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS;
      run(client: W5RecordPortClient): Promise<T>;
    }
) & { readonly recoveryTargets?: readonly W5RecordRecoveryTarget[] };

/** Runs each record-port call over the client it resolves for that call. */
export type W5RecordPortRunner = <T>(call: W5RecordPortCall<T>) => Promise<T>;

/**
 * The record port over `client`. A resolver is called once per call, so a
 * leased session's replacement connection serves every call after a drop.
 */
export function w5RecordPortTransport(
  client: W5RecordPortClient | (() => Promise<W5RecordPortClient>),
): W5RecordPortTransport {
  return w5RecordPortTransportOver((call) =>
    typeof client === 'function'
      ? client().then((resolved) => call.run(resolved))
      : call.run(client),
  );
}

/** The record port over `run`, which sees each call's operation and kind. */
export function w5RecordPortTransportOver(
  run: W5RecordPortRunner,
): W5RecordPortTransport {
  return {
    capture: (request) =>
      run({
        kind: 'query',
        operation: 'core.workspaceRecords.capture',
        run: (c) =>
          c.query('core.workspaceRecords.capture', {
            files: request.files.map((file) => ({ ...file })),
            discoverWorkspaces: request.discoverWorkspaces,
          }),
      }),
    recovery: () =>
      run({
        kind: 'query',
        operation: 'core.workspaceRecords.recovery.get',
        run: (c) => c.query('core.workspaceRecords.recovery.get', {}),
      }),
    commit: (request) =>
      run({
        kind: 'instruction',
        operation: 'core.workspaceRecords.commit',
        recoveryTargets: request.files.map(({ target }) => ({ ...target })),
        run: (c) => c.instruction('core.workspaceRecords.commit', request),
      }),
    lookupReceipt: (receipt) =>
      run({
        kind: 'query',
        operation: 'core.workspaceRecords.receipt.lookup',
        run: (c) =>
          c.query('core.workspaceRecords.receipt.lookup', { receipt }),
      }),
    listReservations: () =>
      run({
        kind: 'query',
        operation: 'core.workspaceRecords.reservation.list',
        run: (c) => c.query('core.workspaceRecords.reservation.list', {}),
      }),
    reserve: (params) =>
      run({
        kind: 'instruction',
        operation: 'core.workspaceRecords.reservation.reserve',
        run: async (c) => {
          await c.instruction(
            'core.workspaceRecords.reservation.reserve',
            params,
          );
        },
      }),
    updateReservationDiagnostics: (params) =>
      run({
        kind: 'instruction',
        operation: 'core.workspaceRecords.reservation.updateDiagnostics',
        run: async (c) => {
          await c.instruction(
            'core.workspaceRecords.reservation.updateDiagnostics',
            params,
          );
        },
      }),
    releaseReservation: (reservationId) =>
      run({
        kind: 'instruction',
        operation: 'core.workspaceRecords.reservation.release',
        run: async (c) => {
          await c.instruction('core.workspaceRecords.reservation.release', {
            reservationId,
          });
        },
      }),
    markReservationRecoveryRequired: (params) =>
      run({
        kind: 'instruction',
        operation: 'core.workspaceRecords.reservation.markRecoveryRequired',
        run: async (c) => {
          await c.instruction(
            'core.workspaceRecords.reservation.markRecoveryRequired',
            params,
          );
        },
      }),
  };
}

/** The core store with the record port as its host, Electron's root and reads. */
export function createW5DaemonRecordStore(options: {
  readonly transport: W5RecordPortTransport;
  /** Electron's W5 root; defaults to the data root's `workspaces`. */
  readonly root?: string;
}): W5CommitLogFileStore {
  const root = options.root ?? getWorkspacesRootDir();
  const port = createW5RecordHostPort({
    root,
    transport: countingW5RecordPortTransport(options.transport),
    onConflict: ({ operation, kind }) => recordW5PortConflict(operation, kind),
    onUnserved: ({ operation, reason }) =>
      recordW5RecordUnserved(operation, reason),
  });
  return createW5CommitLogFileStore({
    getHost: () => port,
    warn: (message, context) => logMainProcessWarn(message, context),
    readFile: (path) => {
      recordW5Work('read.backend.capture');
      return port.readFile(path);
    },
    readFileForCommit: (path) => {
      recordW5Work('read.backend.capture');
      return port.readFile(path, true);
    },
    admit: (targets, operation) => admitW5Storage(targets, operation),
    admitWrite: (target, write) => admitStorageWrite(target, write),
    // The authority checks ownership as `daemon`.
    assertWrite: () => undefined,
  });
}

/**
 * Explicit test injection plus bounded retry. Admission remains callback-scoped;
 * the caller resets the store when restoring its test fixture.
 */
export function installW5DaemonRecordStoreForTests(
  store: W5CommitLogFileStore,
): () => void {
  __setDesktopW5FileStoreForTests(store);
  const unretry = setW5PreEffectAttempts(W5_DAEMON_PRE_EFFECT_ATTEMPTS);
  return (): void => {
    unretry();
  };
}
