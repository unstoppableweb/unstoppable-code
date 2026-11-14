import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { SidebarItem } from '../../../../types';
import type { CreateWorktreeServiceOptions } from '../../../lib/worktree-service';
import { getWorkspaceItem } from '../../../lib/workspace-cli-reads';
import type {
  W5RecordPortTransport,
  W5CommitLogFileStore,
} from '../../record-store';
import type {
  W5RecordPortClient,
  W5DaemonRecordHarness,
} from './w5-daemon-record-harness';
import type { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import type { RoutedWorkspaceCreateContext } from '../../workspace-create';
import { createScopedW5RoutedRecordStore } from '../../record-store';
import {
  createRoutedCliWorkspace,
  type RoutedWorkspaceCreateRequest,
} from '../../workspace-create';
import { createRoutedCliWorktree } from '../../worktree-create';
import { deleteRoutedCliWorktree } from '../../worktree-delete';
import { startW5DaemonRecordHarness } from './w5-daemon-record-harness';
import { startW5TestCommitLogHost } from './w5-test-commit-log-host';

export interface W5ServiceAdapter {
  readonly host: W5CommitLogHost;
  readonly harness: W5DaemonRecordHarness;
  readonly transport: W5RecordPortTransport;
  readonly store: W5CommitLogFileStore;
  durableState(this: void): Promise<ReturnType<typeof readW5ServiceState>>;
  createWorkspace(request: RoutedWorkspaceCreateRequest): Promise<SidebarItem>;
  createWorktree(
    options: CreateWorktreeServiceOptions,
  ): ReturnType<typeof createRoutedCliWorktree>;
  deleteWorktree(options: {
    workspaceId: string;
    worktreeId: string;
  }): ReturnType<typeof deleteRoutedCliWorktree>;
  close(): Promise<void>;
}

/** Legacy-API goldens keep their effects; only their call path becomes routed. */
export async function startW5ServiceAdapter(
  dataRoot: string,
): Promise<W5ServiceAdapter> {
  const root = join(dataRoot, 'workspaces');
  const host = startW5TestCommitLogHost({
    root,
    logDirectory: join(dataRoot, 'w5'),
  });
  const harness = await startW5DaemonRecordHarness({ host });
  const client = await harness.connect('service-golden');
  const transport = serviceRecordTransport(client);
  const opened = createScopedW5RoutedRecordStore({
    root,
    transport,
    warn: () => undefined,
  });
  const signal = new AbortController().signal;
  const context = (): RoutedWorkspaceCreateContext => ({
    store: opened.store,
    idempotencyKey: randomUUID(),
    signal,
  });
  return {
    host,
    harness,
    transport,
    store: opened.store,
    durableState: async (): Promise<ReturnType<typeof readW5ServiceState>> => {
      await host.shutdown();
      return readW5ServiceState(dataRoot);
    },
    async createWorkspace(
      request: RoutedWorkspaceCreateRequest,
    ): Promise<SidebarItem> {
      return opened.run(async (store) => {
        const record = await createRoutedCliWorkspace(request, context());
        return getWorkspaceItem(record.id, store);
      });
    },
    createWorktree(
      options: CreateWorktreeServiceOptions,
    ): ReturnType<typeof createRoutedCliWorktree> {
      return opened.run(() => createRoutedCliWorktree(options, context()));
    },
    deleteWorktree(options: {
      workspaceId: string;
      worktreeId: string;
    }): ReturnType<typeof deleteRoutedCliWorktree> {
      return opened.run(() => deleteRoutedCliWorktree(options, context()));
    },
    async close(): Promise<void> {
      opened.close();
      await harness.close();
      await host.shutdown();
    },
  };
}

export function serviceRecordTransport(
  client: W5RecordPortClient,
): W5RecordPortTransport {
  return {
    capture: (request: Parameters<W5RecordPortTransport['capture']>[0]) =>
      client.query('core.workspaceRecords.capture', {
        files: request.files.map((file) => ({ ...file })),
        discoverWorkspaces: request.discoverWorkspaces,
      }),
    recovery: () => client.query('core.workspaceRecords.recovery.get', {}),
    lookupReceipt: (
      receipt: Parameters<W5RecordPortTransport['lookupReceipt']>[0],
    ) => client.query('core.workspaceRecords.receipt.lookup', { receipt }),
    listReservations: () =>
      client.query('core.workspaceRecords.reservation.list', {}),
    commit: (request: Parameters<W5RecordPortTransport['commit']>[0]) =>
      client.instruction('core.workspaceRecords.commit', request),
    reserve: async (
      request: Parameters<W5RecordPortTransport['reserve']>[0],
    ): Promise<void> => {
      await client.instruction(
        'core.workspaceRecords.reservation.reserve',
        request,
      );
    },
    updateReservationDiagnostics: async (
      request: Parameters<
        W5RecordPortTransport['updateReservationDiagnostics']
      >[0],
    ): Promise<void> => {
      await client.instruction(
        'core.workspaceRecords.reservation.updateDiagnostics',
        request,
      );
    },
    releaseReservation: async (reservationId: string): Promise<void> => {
      await client.instruction('core.workspaceRecords.reservation.release', {
        reservationId,
      });
    },
    markReservationRecoveryRequired: async (
      request: Parameters<
        W5RecordPortTransport['markReservationRecoveryRequired']
      >[0],
    ): Promise<void> => {
      await client.instruction(
        'core.workspaceRecords.reservation.markRecoveryRequired',
        request,
      );
    },
  };
}

/** Independent SQLite reader: assertions observe durable state, not an RPC cache. */
export function readW5ServiceState(dataRoot: string): {
  commitId: number;
  reservations: Array<{
    reservationId: string;
    operation: string;
    state: string;
    diagnostics: unknown;
  }>;
} {
  const db = new DatabaseSync(join(dataRoot, 'w5/commit-log.sqlite'), {
    readOnly: true,
  });
  try {
    db.exec('BEGIN');
    const latest = db
      .prepare('SELECT COALESCE(MAX(commit_id),0) AS id FROM w5_commits')
      .get();
    const commitId = Number(latest?.id);
    if (!Number.isSafeInteger(commitId))
      throw new Error('Invalid durable position');
    const reservations = db
      .prepare(
        'SELECT reservation_id, operation, state, diagnostics_json FROM w5_reservations ORDER BY reservation_id',
      )
      .all()
      .map((row) => {
        if (
          typeof row.reservation_id !== 'string' ||
          typeof row.operation !== 'string' ||
          typeof row.state !== 'string' ||
          typeof row.diagnostics_json !== 'string'
        )
          throw new Error('Invalid durable reservation');
        const diagnostics: unknown = JSON.parse(row.diagnostics_json);
        return {
          reservationId: row.reservation_id,
          operation: row.operation,
          state: row.state,
          diagnostics,
        };
      });
    return { commitId, reservations };
  } finally {
    db.close();
  }
}
