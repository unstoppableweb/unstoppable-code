import { randomUUID } from 'node:crypto';
import { duplexPair, type Duplex } from 'node:stream';
import type { z } from 'zod';
import type * as CoreRuntime from '@canopy/core-runtime';
import { createCanopyClient, type CanopyClient } from '@canopy/core-client';
import type * as CoreRuntimeNode from '@canopy/core-runtime/node';
import type * as CommitEvents from '@canopy/core-runtime/node/w5/commit-events';
import type * as CommitLogHostModule from '@canopy/core-runtime/node/w5/commit-log-host';
import type * as CommitScope from '@canopy/core-runtime/node/w5/commit-scope';
import type * as RepositoryLocks from '@canopy/core-runtime/node/w5/repository-locks';
import type { W5CommitRequest } from '@canopy/core-runtime/node/w5/commit-log';
import type { W5CommitOutcome } from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import type { W5FileRead } from '@canopy/core-runtime/node/w5/file-store';
import type * as FileStore from '@canopy/core-runtime/node/w5/file-store';
import type * as RecordPort from '@canopy/core-runtime/node/w5/record-port';
import type * as HostedMetadata from '@canopy/core-runtime/node/w5/workspace-metadata/module';
import {
  CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
  type CoreWorkspaceMetadataCommandName,
} from '@canopy/core-runtime/node/workspace/metadata-commands';
import type { PlatformByteStream } from '@canopy/core-runtime';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CORE_WORKSPACE_COMMITTED_EVENT,
  CORE_WORKSPACE_EVENT_FAMILY,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  type CanopyEvent,
  type CanopyJsonValue,
} from '@canopy/protocol/canopy-core';
import type { W5RecordPortClient } from '../../w5-daemon-record-store';

/*
 * W5d1 (CAN-5522) test harness: the daemon side of the `core.workspace.*`
 * metadata commands (W7a-3) in its own module registry. It holds a real W5
 * commit-log host, the W5e event source with its `core.events` journal, W6g's
 * record authority and the hosted module, served through the daemon
 * control-stream code to framed clients over in-memory duplexes. Its own registry keeps its repository locks and commit scope
 * apart from Electron's in the default registry, as two processes keep them:
 * shared, a hosted call injected under an Electron lock would wait on it.
 * Mocks are shared, so both sides read the one storage ownership table.
 */

const AUTH = { secret: 'w5d1-hosted-metadata', dataRootHash: '0'.repeat(64) };

export type W5HostedMetadataClient = CanopyClient<
  Record<never, never>,
  typeof CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
  Record<never, never>
>;

/** A `core.events` client, as Electron's W5e subscriber uses its session's. */
export type W5HostedEventsClient = CanopyClient<
  Record<never, never>,
  Pick<
    typeof CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    'core.events.ack' | 'core.client.lease.acquire'
  >,
  Pick<typeof CORE_TRANSPORT_STREAM_DEFINITIONS, 'core.events.subscribe'>
>;

/** One public metadata request, its key beside its params. */
export type W5HostedMetadataRequest = {
  [Name in CoreWorkspaceMetadataCommandName]: {
    operation: Name;
    /** Absent: a fresh key, as a caller that never retries sends. */
    idempotencyKey?: string;
  } & Omit<
    z.input<
      (typeof CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS)[Name]['params']
    >,
    '_meta'
  >;
}[CoreWorkspaceMetadataCommandName];

/** A picker selection, by the id the harness's projection resolves. */
export function pickerSelection(selectionId: string): {
  kind: 'local_picker_selection';
  selectionId: string;
} {
  return { kind: 'local_picker_selection', selectionId };
}

/** Sends `request` under its public name, with its key in `_meta`. */
export function callHostedMetadata(
  client: W5HostedMetadataClient,
  request: W5HostedMetadataRequest,
): Promise<unknown> {
  const { operation, idempotencyKey, ...params } = request;
  return client.instruction(operation, {
    ...params,
    _meta: { idempotencyKey: idempotencyKey ?? randomUUID() },
  });
}

/** Where a hosted command's commit stands when the host hook runs. */
export interface W5HostedCommitHook {
  /** Before the host decides; throwing fails the call before any decision. */
  before?: (request: W5CommitRequest) => Promise<void>;
  /** After the host decided, before the caller sees the outcome. */
  after?: (request: W5CommitRequest, outcome: W5CommitOutcome) => Promise<void>;
}

export interface W5HostedMetadataHarness {
  readonly root: string;
  /** Whether the daemon side's locks and commit scope are its own instances. */
  readonly isolated: boolean;
  /** The commit labels the daemon's host decided, in order. */
  readonly commits: string[];
  readonly hooks: {
    commit: W5HostedCommitHook;
    /**
     * Runs after each direct read the hosted store makes; `staging` is a read
     * inside a commit scope, before the decision's queued preflight.
     */
    afterRead?: (
      filePath: string,
      read: W5FileRead,
      staging: boolean,
    ) => Promise<void>;
    /** Runs after each keyed receipt lookup, before its caller sees it. */
    afterLookup?: () => Promise<void>;
  };
  /**
   * The process's ownership rows, which both registries read: a test that
   * runs Electron's in-process writers flips them between the two sides.
   */
  setDaemonOwned(namespaceIds: readonly string[]): void;
  /** The `core.workspace.committed` payloads published so far, in order. */
  committedEvents(): CanopyJsonValue[];
  /** Every published event, in journal order. */
  events(): CanopyEvent[];
  retryCounts(): ReadonlyMap<string, number>;
  revision(
    resource: Parameters<CommitLogHostModule.W5CommitLogHost['revision']>[0],
  ): Promise<number>;
  host(): CommitLogHostModule.W5CommitLogHost;
  /** A routed record-port client, as Electron's daemon-backed store uses. */
  connectRecords(clientInstanceId?: string): Promise<W5RecordPortClient>;
  /** A `core.events` client: the daemon's journal, served as W5e serves it. */
  connectEvents(clientInstanceId?: string): Promise<W5HostedEventsClient>;
  /** A client of the metadata commands. */
  connectMetadata(
    clientInstanceId?: string,
    principalId?: string,
  ): Promise<W5HostedMetadataClient>;
  close(): Promise<void>;
}

export interface W5HostedMetadataHarnessOptions {
  readonly dbPath: string;
  readonly root: string;
  readonly workerEntry: string;
  readonly epoch?: string;
  /** The trusted selection projection; absent, a repository add is refused. */
  readonly repositorySelections?: ReadonlyMap<string, string>;
  readonly isRepository?: (repoPath: string) => Promise<boolean>;
  /** The W5 namespaces daemon-owned from the start. */
  readonly daemonOwned?: readonly string[];
  /** The journal's retained entries, so a test can evict a cursor. */
  readonly journalMaxEntries?: number;
  /** Entries one subscriber may lag by before its stream ends. */
  readonly eventsMaxPending?: number;
}

/** A platform byte stream over one end of an in-memory duplex. */
function byteStream(wire: Duplex): PlatformByteStream {
  const closed = new AbortController();
  wire.once('close', () => closed.abort());
  const chunks = wire[Symbol.asyncIterator]();
  return {
    signal: closed.signal,
    read: async (): Promise<Uint8Array | null> => {
      const next = await chunks.next();
      if (next.done) return null;
      const value: unknown = next.value;
      if (!(value instanceof Uint8Array)) throw new Error('Expected bytes');
      return value;
    },
    write: (bytes) =>
      new Promise<void>((resolve, reject) =>
        wire.write(bytes, (error) => (error ? reject(error) : resolve())),
      ),
    close: (): Promise<void> => {
      wire.destroy();
      return Promise.resolve();
    },
  };
}

interface DaemonSide {
  runtime: CoreRuntime.RuntimeProfileGraph;
  serve: typeof CoreRuntimeNode.serveCanopyControlStream;
  host: CommitLogHostModule.W5CommitLogHost;
  events: CommitEvents.W5CommitEventSource;
  hosted: HostedMetadata.W5HostedMetadata;
  setDaemonOwned: (namespaceIds: readonly string[]) => void;
}

export async function startW5HostedMetadataHarness(
  options: W5HostedMetadataHarnessOptions,
): Promise<W5HostedMetadataHarness> {
  const commits: string[] = [];
  const hooks: W5HostedMetadataHarness['hooks'] = { commit: {} };
  let side: DaemonSide | undefined;
  // One ownership table for the process, built here first so the isolated
  // registry reads the same mock instance (Jest 30 cascades mock reads).
  const { setDaemonOwnedForTest: setDaemonOwned } = jest.requireMock<{
    setDaemonOwnedForTest: (namespaceIds: readonly string[]) => void;
  }>('@canopy/core-runtime/storage');
  const outerLocks = jest.requireActual<typeof RepositoryLocks>(
    '@canopy/core-runtime/node/w5/repository-locks',
  );
  let isolated = false;
  await jest.isolateModulesAsync(async () => {
    const locks = jest.requireActual<typeof RepositoryLocks>(
      '@canopy/core-runtime/node/w5/repository-locks',
    );
    isolated = locks.withW5RepositoryLock !== outerLocks.withW5RepositoryLock;
    const { createCoreEventsModule, createRuntimeProfileGraph } =
      jest.requireActual<typeof CoreRuntime>('@canopy/core-runtime');
    const { serveCanopyControlStream } = jest.requireActual<
      typeof CoreRuntimeNode
    >('@canopy/core-runtime/node');
    const { W5CommitLogHost } = jest.requireActual<typeof CommitLogHostModule>(
      '@canopy/core-runtime/node/w5/commit-log-host',
    );
    const { createW5CommitEventSource } = jest.requireActual<
      typeof CommitEvents
    >('@canopy/core-runtime/node/w5/commit-events');
    const { createW5RecordPortModule } = jest.requireActual<typeof RecordPort>(
      '@canopy/core-runtime/node/w5/record-port',
    );
    const { createW5HostedMetadata } = jest.requireActual<
      typeof HostedMetadata
    >('@canopy/core-runtime/node/w5/workspace-metadata/module');
    const { readNodeW5File } = jest.requireActual<typeof FileStore>(
      '@canopy/core-runtime/node/w5/file-store',
    );
    const { currentW5CommitScope } = jest.requireActual<typeof CommitScope>(
      '@canopy/core-runtime/node/w5/commit-scope',
    );
    const staging = (): boolean => {
      try {
        return currentW5CommitScope() !== undefined;
      } catch {
        return false;
      }
    };

    const host = new W5CommitLogHost({
      dbPath: options.dbPath,
      root: options.root,
      workerEntry: options.workerEntry,
    });
    // The host the event source watches, recording each decision.
    const recording: CommitEvents.W5CommitEventHost = {
      root: host.root,
      get recoveredWorker(): number {
        return host.recoveredWorker;
      },
      onWorkerExit: (listener) => host.onWorkerExit(listener),
      recoveryReport: () => host.recoveryReport(),
      commit: async (request) => {
        await hooks.commit.before?.(request);
        const outcome = await host.commit(request);
        commits.push(request.operation);
        await hooks.commit.after?.(request, outcome);
        return outcome;
      },
      lookupReceipt: async (receipt) => {
        const lookup = await host.lookupReceipt(receipt);
        await hooks.afterLookup?.();
        return lookup;
      },
      reserve: (input) => host.reserve(input),
      updateReservationDiagnostics: (id, diagnostics) =>
        host.updateReservationDiagnostics(id, diagnostics),
      releaseReservation: (id) => host.releaseReservation(id),
      markReservationRecoveryRequired: (id, diagnostics) =>
        host.markReservationRecoveryRequired(id, diagnostics),
      revision: (resource) => host.revision(resource),
      capture: (request) => host.capture(request),
    };
    const epoch = options.epoch ?? 'runtime:w5d1-test';
    const events = createW5CommitEventSource({
      host: recording,
      epoch,
      ...(options.journalMaxEntries !== undefined && {
        maxEntries: options.journalMaxEntries,
      }),
    });
    const selections = options.repositorySelections;
    const hosted = createW5HostedMetadata({
      host: events.port(),
      pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
      readFile: async (filePath) => {
        const read = await readNodeW5File(filePath);
        await hooks.afterRead?.(filePath, read, staging());
        return read;
      },
      ...(options.isRepository && { isRepository: options.isRepository }),
      ...(selections && {
        projectRepositorySelection: (selectionId: string): string | undefined =>
          selections.get(selectionId),
      }),
    });
    const runtime = createRuntimeProfileGraph({
      profile: 'core',
      identity: {
        runtimeId: 'w5d1-test',
        hostId: 'local',
        authorityId: 'w5d1',
      },
      modules: [
        createW5RecordPortModule({
          host: events.port(),
          portFor: (caller) =>
            events.port({ publishedBy: caller.clientInstanceId }),
        }),
        hosted.module,
        createCoreEventsModule({
          journal: events.journal,
          families: [CORE_WORKSPACE_EVENT_FAMILY],
          ...(options.eventsMaxPending !== undefined && {
            maxPending: options.eventsMaxPending,
          }),
        }),
      ],
      daemonEpoch: epoch,
      principalFor: () => 'interface',
      phaseDeadlineMs: 5_000,
    });
    setDaemonOwned(options.daemonOwned ?? []);
    side = {
      runtime,
      serve: serveCanopyControlStream,
      host,
      events,
      hosted,
      setDaemonOwned,
    };
    return Promise.resolve();
  });
  if (!side) throw new Error('The daemon side did not start');
  const daemon = side;
  await daemon.runtime.start();
  const sessions: { close(): Promise<void> }[] = [];
  const clients: { close(): Promise<void> }[] = [];

  async function connection(
    clientInstanceId: string,
    principalId: string,
  ): Promise<Awaited<ReturnType<typeof createCanopyFramedConnection>>> {
    const [clientWire, serverWire] = duplexPair();
    sessions.push(
      daemon.serve({
        stream: byteStream(serverWire),
        auth: AUTH,
        dispatcher: daemon.runtime.dispatcher,
        operations: daemon.runtime.operations,
        caller: {
          principalId,
          clientInstanceId,
          authorityId: 'w5d1',
          interfaceKind: 'desktop',
          grants: [
            'core.runtime.read',
            'core.workspaceRecords.read',
            'core.workspaceRecords.write',
            'core.workspace.write',
            'core.events.read',
            'core.client.manage',
          ],
        },
        obligations: { hold: () => (): void => undefined },
        buildVersion: 'test',
      }),
    );
    return createCanopyFramedConnection(clientWire, {
      role: 'client',
      auth: AUTH,
    });
  }

  return {
    root: options.root,
    isolated,
    commits,
    hooks,
    setDaemonOwned: (namespaceIds) => daemon.setDaemonOwned(namespaceIds),
    committedEvents: () => {
      const replay = daemon.events.journal.resume({
        daemonEpoch: daemon.events.journal.epoch,
        sequence: 0,
      });
      if (replay.kind !== 'replay') throw new Error(replay.reason);
      return replay.entries
        .filter(({ event }) => event.name === CORE_WORKSPACE_COMMITTED_EVENT)
        .map(({ event }) => ({ ...event.payload }));
    },
    events: () => {
      const replay = daemon.events.journal.resume({
        daemonEpoch: daemon.events.journal.epoch,
        sequence: 0,
      });
      if (replay.kind !== 'replay') throw new Error(replay.reason);
      // As `core.events.subscribe` serves each journal entry.
      return replay.entries.map(({ cursor, event }) => ({
        cursor,
        eventId: `${cursor.daemonEpoch}#${cursor.sequence}`,
        name: event.name,
        scope: { ...event.scope },
        occurredAt: event.occurredAt,
        payload: { ...event.payload },
      }));
    },
    retryCounts: () => daemon.hosted.retry.counts(),
    revision: (resource) => daemon.host.revision(resource),
    host: () => daemon.host,
    async connectRecords(clientInstanceId = 'electron-main') {
      const client = await createCanopyClient({
        connection: await connection(clientInstanceId, 'local-user'),
        clientName: 'w5d1-records',
        clientVersion: '1',
        definitions: {
          queries: CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
          instructions: CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
          streams: {},
        },
      });
      clients.push(client);
      return client;
    },
    async connectEvents(clientInstanceId = 'electron-main') {
      const client = await createCanopyClient({
        connection: await connection(clientInstanceId, 'local-user'),
        clientName: 'w5d1-events',
        clientVersion: '1',
        definitions: {
          queries: {},
          instructions: {
            'core.events.ack':
              CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.ack'],
            'core.client.lease.acquire':
              CORE_TRANSPORT_INSTRUCTION_DEFINITIONS[
                'core.client.lease.acquire'
              ],
          },
          streams: {
            'core.events.subscribe':
              CORE_TRANSPORT_STREAM_DEFINITIONS['core.events.subscribe'],
          },
        },
      });
      clients.push(client);
      // Streams need a live lease on their connection, as Electron's session holds.
      await client.instruction('core.client.lease.acquire', {
        clientInstanceId,
        interfaceKind: 'desktop',
        label: 'Desktop',
        interactive: true,
        foreground: true,
        renewalIntervalMs: 300_000,
        _meta: { idempotencyKey: randomUUID() },
      });
      return client;
    },
    async connectMetadata(
      clientInstanceId = 'electron-main',
      principalId = 'local-user',
    ) {
      const client = await createCanopyClient({
        connection: await connection(clientInstanceId, principalId),
        clientName: 'w5d1-metadata',
        clientVersion: '1',
        definitions: {
          queries: {},
          instructions: CORE_WORKSPACE_METADATA_COMMAND_DEFINITIONS,
          streams: {},
        },
      });
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.splice(0).map((client) => client.close()));
      await Promise.all(sessions.splice(0).map((session) => session.close()));
      await daemon.runtime.shutdown('test');
      await daemon.host.shutdown();
      daemon.setDaemonOwned([]);
    },
  };
}
