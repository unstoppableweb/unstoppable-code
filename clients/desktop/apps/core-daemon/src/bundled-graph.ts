import { WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS } from '@canopy/protocol/canopy-core';
import { createWorkerGitWorktreeWriteHandlers } from '@canopy/core-runtime/node/git';
import {
  createDaemonFilesystemWatch,
  type DaemonFilesystemWatchOptions,
} from './filesystem-watch';
import { randomBytes } from 'node:crypto';
import {
  createRuntimeProfileGraph,
  defineRuntimeModule,
  type CanopyHandlerContext,
  type CanopyRuntimeIdentity,
  type RuntimeInstructionGuard,
  type RuntimeModule,
  type RuntimePrincipal,
  type RuntimeProfileGraph,
  type RuntimeService,
  type PlatformOperatingSystem,
  type PlatformTrashServices,
  type SupervisedLocalWorker,
  type SupervisedWorkerModule,
} from '@canopy/core-runtime';
import {
  createFilesystemSearchEngine,
  createFilesystemDirectory,
  writeFilesystemFile,
  copyFilesystemEntry,
  deleteFilesystemEntry,
  moveFilesystemEntry,
  listFilesystemScopeDirectory,
  listFilesystemScopeRoots,
  readFilesystemScopeFile,
  resolveFilesystemScopeLink,
  searchFilesystemScope,
  type FilesystemScopeResolver,
  type FilesystemEntryDeleteIo,
  type FilesystemEntryTransferIo,
  type ReadOnlyDirectoryInputs,
} from '@canopy/core-runtime/node';
import {
  createWorkerGitBranchListHandlers,
  createWorkerGitBranchWriteHandlers,
  createWorkerGitDiffHandlers,
  createWorkerGitExecutableHandlers,
  createWorkerGitRemoteHandlers,
  createWorkerGitSyncWriteHandlers,
  createWorkerGitCommitPushHandlers,
  createWorkerGitMergeHandlers,
  createWorkerGitWorktreeHealthHandlers,
  type RecordedWorkerGitHosts,
} from '@canopy/core-runtime/node/git';
import {
  CANOPY_MAX_MESSAGE_BYTES,
  createInMemoryFramedPair,
  type CanopyFramedPair,
  type CanopyInMemoryFramedPairOptions,
} from '@canopy/core-transport';
import {
  WORKER_FILESYSTEM_FILE_READ_MAX_RESULT_BYTES,
  WORKER_FILESYSTEM_QUERY_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_STREAM_DEFINITIONS,
  WORKER_FILESYSTEM_SEARCH_MAX_RESULT_BYTES,
  WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_DIFF_QUERY_DEFINITIONS,
  WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS,
  WORKER_GIT_GRANTS,
  WORKER_GIT_QUERY_DEFINITIONS,
  WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
  WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_COMMIT_PUSH_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_MERGE_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_GRANTS,
  WORKER_SCRIPT_GRANTS,
  WORKER_PIPELINE_GRANTS,
  PIPELINE_DEFINITION_IMPORT_GRANTS,
  WORKER_TERMINAL_GRANTS,
  WORKER_OPERATION_RECEIPT_INSTRUCTION_DEFINITIONS,
  WORKER_OPERATION_RECEIPT_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { createDaemonEntryMutationHost } from './filesystem-entry-host';
import { createDaemonFilesystemWriteHost } from './filesystem-writes';

const DAEMON_FILESYSTEM_STREAM_DEFINITIONS = {
  'worker.filesystem.watch':
    WORKER_STREAM_DEFINITIONS['worker.filesystem.watch'],
};

const NONE = { queries: {}, instructions: {}, streams: {} };

/** The grants terminal clients hold where the daemon serves terminals. */
export const WORKER_TERMINAL_CALLER_GRANTS = [
  WORKER_TERMINAL_GRANTS.read,
  WORKER_TERMINAL_GRANTS.write,
] as const;

/** The grants code-graph clients hold where the daemon serves the code graph. */
export const WORKER_CODE_GRAPH_CALLER_GRANTS = [
  WORKER_CODE_GRAPH_GRANTS.read,
  WORKER_CODE_GRAPH_GRANTS.write,
] as const;

/** The grants script clients hold where the daemon serves scripts (CAN-5087). */
export const WORKER_SCRIPT_CALLER_GRANTS = [
  WORKER_SCRIPT_GRANTS.execute,
  WORKER_SCRIPT_GRANTS.read,
] as const;

/** The grants workflow clients hold where the daemon serves workflows (CAN-5086). */
export const WORKER_PIPELINE_CALLER_GRANTS = [
  WORKER_PIPELINE_GRANTS.read,
  WORKER_PIPELINE_GRANTS.write,
] as const;

/**
 * The keyed instructions each daemon peer replays alone: code graph
 * (CAN-5629), scripts (CAN-5087, CAN-6482), workflows (CAN-5090), terminals (CAN-5093),
 * and Git commit and push and the filesystem writes (CAN-6172). The bundled
 * worker sees every peer as the owning core, so the core keys them first.
 */
export const DAEMON_PEER_SCOPED_IDEMPOTENCY: ReadonlySet<string> = new Set([
  'worker.codeGraph.build',
  'worker.codeGraph.build.cancel',
  'worker.codeGraph.builds.cancel',
  'worker.codeGraph.buildQueue.update',
  'worker.codeGraph.snapshot.import',
  'worker.script.execute',
  'worker.script.execution.cancel',
  'worker.script.execution.clear',
  'worker.script.execution.stop',
  'worker.pipeline.execution.start',
  'worker.pipeline.execution.cancel',
  'worker.terminal.create',
  'worker.terminal.restore',
  'worker.git.commit',
  'worker.git.push',
  'worker.filesystem.file.write',
  'worker.filesystem.directory.create',
  'worker.filesystem.entry.copy',
  'worker.filesystem.entry.move',
  'worker.filesystem.entry.delete',
]);

/**
 * Keyed worker instructions whose repeated key replays the first request's
 * settlement instead of running again (CAN-4733, Phase 3 q-22(d)). The
 * worker keeps that settlement in memory for this daemon epoch only.
 */
export const DAEMON_REPLAYED_KEYED_INSTRUCTIONS: ReadonlySet<string> = new Set([
  'worker.filesystem.file.write',
  'worker.filesystem.directory.create',
  'worker.filesystem.entry.copy',
  'worker.filesystem.entry.move',
  'worker.filesystem.entry.delete',
]);

/** The caller principal id only a proven owner connection gets (CAN-5771). */
export const DAEMON_OWNER_PRINCIPAL_ID = 'desktop-owner';

/**
 * The grants the daemon's owner holds where it serves workflows (CAN-5771), and
 * the definitions import (CAN-7523). Owner proof alone grants the import: a
 * deliberate, approved exception to the rule that owner proof does not
 * establish trust, until E1 (CAN-4729) designates trusted connections and this
 * grant moves to that designation. Sent only over Electron main's owner
 * connection; Portal and remote installs go through main.
 */
export const WORKER_PIPELINE_OWNER_GRANTS = [
  WORKER_PIPELINE_GRANTS.host,
  ...PIPELINE_DEFINITION_IMPORT_GRANTS,
] as const;

/**
 * The runtime principal of a control-plane caller: `owning-core` for the
 * proven owner, `interface` for everyone else. Resolved from the trusted
 * caller the control plane built, never from a payload.
 */
export function daemonPrincipalFor(
  context: CanopyHandlerContext,
): RuntimePrincipal {
  return context.caller.principalId === DAEMON_OWNER_PRINCIPAL_ID
    ? 'owning-core'
    : 'interface';
}

export interface CanopyDaemonFilesystemOptions {
  readonly os: PlatformOperatingSystem;
  readonly trash?: PlatformTrashServices;
  /** Fault injection around effects; production uses Node filesystem I/O. */
  readonly entryDeleteIo?: FilesystemEntryDeleteIo;
  readonly entryTransferIo?: FilesystemEntryTransferIo;
  /** Resolves the selected scope and its trusted owner on every request. */
  readonly resolveScope: FilesystemScopeResolver;
  readonly watch?: DaemonFilesystemWatchOptions;
  /** Per-request indexing policy and Git ignore inputs for directory reads and searches. */
  readonly directoryInputs: ReadOnlyDirectoryInputs;
  /** Worker-plane services behind those inputs, such as the Git read host. */
  readonly services?: readonly RuntimeService[];
}

// Declares only the `worker.filesystem.*` partition; other worker domains,
// such as `worker.git.*`, join through their own modules.
export function createDaemonFilesystemModule({
  resolveScope,
  directoryInputs,
  watch,
  services = [],
  os,
  trash,
  entryDeleteIo,
  entryTransferIo,
}: CanopyDaemonFilesystemOptions): RuntimeModule {
  // Paused search walks behind this module's cursors, for every peer.
  const searches = createFilesystemSearchEngine();
  const writeHost = createDaemonFilesystemWriteHost(resolveScope);
  const host = createDaemonEntryMutationHost({
    resolveScope,
    os,
    ...(trash && { trash }),
  });
  return defineRuntimeModule({
    name: 'worker.filesystem',
    plane: 'worker',
    services,
    definitions: {
      ...NONE,
      queries: WORKER_FILESYSTEM_QUERY_DEFINITIONS,
      instructions: {
        ...WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
        ...WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
      },
      streams: DAEMON_FILESYSTEM_STREAM_DEFINITIONS,
    },
    handlers: {
      ...NONE,
      streams: {
        'worker.filesystem.watch': createDaemonFilesystemWatch(
          resolveScope,
          watch,
        ),
      },
      queries: {
        'worker.filesystem.roots.list': async (params) =>
          listFilesystemScopeRoots(
            params,
            await resolveScope(params.scope, 'roots'),
          ),
        'worker.filesystem.directory.list': async (params, { signal }) => {
          const dependencies = await resolveScope(params.scope, 'directory');
          const result = await listFilesystemScopeDirectory(
            params,
            dependencies,
            await directoryInputs.readOptions(signal),
          );
          // An aborted ignore check reads as "nothing ignored" (CAN-4341).
          signal.throwIfAborted();
          return result;
        },
        // Served to leased peers; Electron's Files route never selects it
        // before CAN-4729. Results cross the framed worker hop and the
        // connection, so the encoded result is bounded below one frame.
        'worker.filesystem.file.read': async (params) =>
          readFilesystemScopeFile(
            params,
            await resolveScope(params.scope, 'file'),
            { maxResultBytes: WORKER_FILESYSTEM_FILE_READ_MAX_RESULT_BYTES },
          ),
        // Served to leased peers and never selected by Electron's Files route
        // before CAN-4729. Each page is bounded below one frame.
        'worker.filesystem.search': async (params, { signal }) => {
          const result = await searchFilesystemScope(
            params,
            await resolveScope(params.scope, 'search'),
            {
              engine: searches,
              inputs: () =>
                directoryInputs.searchOptions(
                  signal,
                  params.purpose ?? 'mentions',
                ),
              maxResultBytes: WORKER_FILESYSTEM_SEARCH_MAX_RESULT_BYTES,
              signal,
            },
          );
          // An aborted ignored listing reads as "nothing ignored".
          signal.throwIfAborted();
          return result;
        },
        // Served to leased peers under `worker.filesystem.read`; never
        // route-selected before CAN-4729. Results are ids, never host paths.
        'worker.filesystem.link.resolve': async (params) =>
          resolveFilesystemScopeLink(
            params,
            await resolveScope(params.scope, 'link'),
          ),
      },
      instructions: {
        'worker.filesystem.entry.delete': (params, { signal }) =>
          deleteFilesystemEntry(params, {
            host,
            signal,
            ...(entryDeleteIo && { io: entryDeleteIo }),
          }),
        'worker.filesystem.entry.copy': (params, { signal }) =>
          copyFilesystemEntry(params, {
            host,
            signal,
            ...(entryTransferIo && { io: entryTransferIo }),
          }),
        'worker.filesystem.entry.move': (params, { signal }) =>
          moveFilesystemEntry(params, {
            host,
            signal,
            ...(entryTransferIo && { io: entryTransferIo }),
          }),
        'worker.filesystem.file.write': (params, { signal }) =>
          writeFilesystemFile(params, { host: writeHost, signal }),
        'worker.filesystem.directory.create': (params, { signal }) =>
          createFilesystemDirectory(params, { host: writeHost, signal }),
      },
    },
  });
}

/** Every `worker.git.*` query the daemon declares. */
export const DAEMON_GIT_QUERY_DEFINITIONS = {
  ...WORKER_GIT_QUERY_DEFINITIONS,
  ...WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS,
  ...WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
  ...WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS,
  ...WORKER_GIT_DIFF_QUERY_DEFINITIONS,
};

/** Every `worker.git.*` instruction the daemon declares (CAN-4108, CAN-5516, CAN-5517, CAN-5882, CAN-5884). */
export const DAEMON_GIT_INSTRUCTION_DEFINITIONS = {
  ...WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
  ...WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
  // CAN-5517: fetch and pull, ungranted and unrouted like the branch writes.
  ...WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
  ...WORKER_GIT_COMMIT_PUSH_INSTRUCTION_DEFINITIONS,
  ...WORKER_GIT_MERGE_INSTRUCTION_DEFINITIONS,
  ...WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS,
};

/**
 * The `worker.git.*` partition over the Files module's Git read and write
 * hosts. It owns no service: those hosts' lifecycles and phase-5 stops stay
 * with the Files module. Production callers hold `worker.git.read` (CAN-4729)
 * but not `worker.git.write`, so no instruction routes here before CAN-4731
 * (W7); `worker.git.diff.get` serves changed files only (CAN-4103).
 * The worktree add/remove/prune instructions need
 * `worker.git.worktree.write` instead, which no daemon caller holds (CAN-7197).
 */
export function createDaemonGitModule(
  hosts: RecordedWorkerGitHosts,
): RuntimeModule {
  return defineRuntimeModule({
    name: 'worker.git',
    plane: 'worker',
    definitions: {
      ...NONE,
      queries: DAEMON_GIT_QUERY_DEFINITIONS,
      instructions: DAEMON_GIT_INSTRUCTION_DEFINITIONS,
    },
    handlers: {
      ...NONE,
      queries: {
        ...createWorkerGitBranchListHandlers(hosts.branchList),
        ...createWorkerGitExecutableHandlers(hosts.executable),
        ...createWorkerGitRemoteHandlers(hosts.remote),
        ...createWorkerGitWorktreeHealthHandlers(hosts.worktreeHealth),
        ...createWorkerGitDiffHandlers(hosts.diff),
      },
      instructions: {
        ...createWorkerGitBranchWriteHandlers(hosts.branchWrite),
        ...createWorkerGitSyncWriteHandlers(hosts.syncWrite),
        ...createWorkerGitCommitPushHandlers(hosts.commitPush),
        ...createWorkerGitMergeHandlers(hosts.mergeWrite),
        ...createWorkerGitWorktreeWriteHandlers(hosts.worktreeWrite),
      },
    },
  });
}

/**
 * The worker binding: the real L0 codec and nonce handshake over an in-process
 * duplex (doc 18 bundled discipline 1). The secret never leaves this process.
 * Both ends reassemble message parts, so a result larger than one frame
 * crosses as in-process callers get it (CAN-5630).
 */
export function createBundledWorkerPair(
  options: CanopyInMemoryFramedPairOptions = {},
): Promise<CanopyFramedPair> {
  return createInMemoryFramedPair({
    secret: randomBytes(32).toString('hex'),
    dataRootHash: randomBytes(32).toString('hex'),
    maxMessageBytes: CANOPY_MAX_MESSAGE_BYTES,
    ...options,
  });
}

/** The trusted owning core every worker request runs as, bundled or split. */
export function daemonWorkerCaller(
  authorityId: string,
  options: {
    readonly terminals?: boolean;
    readonly codeGraph?: boolean;
    readonly scripts?: boolean;
    readonly pipelines?: boolean;
  } = {},
): CanopyCallerDescriptor {
  return {
    principalId: 'core',
    clientInstanceId: 'bundled-core',
    authorityId,
    interfaceKind: 'daemon',
    grants: [
      'worker.filesystem.read',
      // CAN-4729: and the Git reads its interface callers hold.
      WORKER_GIT_GRANTS.read,
      // CAN-5088: the owning core forwards interface terminal calls.
      ...(options.terminals ? WORKER_TERMINAL_CALLER_GRANTS : []),
      // CAN-5089: and its code-graph builds and reads.
      ...(options.codeGraph ? WORKER_CODE_GRAPH_CALLER_GRANTS : []),
      // CAN-5087: and its script runs, reads and output streams.
      ...(options.scripts ? WORKER_SCRIPT_CALLER_GRANTS : []),
      // CAN-5086: and its workflow starts, reads and cancels.
      ...(options.pipelines ? WORKER_PIPELINE_CALLER_GRANTS : []),
      // CAN-5771: and the owner's host request settlement.
      ...(options.pipelines ? WORKER_PIPELINE_OWNER_GRANTS : []),
    ],
  };
}

/**
 * The worker modules' operations, as a split core declares them for its
 * supervised worker process (CAN-5073). The worker graph declares exactly these.
 */
export const DAEMON_WORKER_MODULES: readonly SupervisedWorkerModule[] =
  Object.freeze([
    {
      name: 'worker.filesystem',
      definitions: {
        ...NONE,
        queries: WORKER_FILESYSTEM_QUERY_DEFINITIONS,
        instructions: {
          ...WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
          ...WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
        },
        streams: DAEMON_FILESYSTEM_STREAM_DEFINITIONS,
      },
    },
    {
      name: 'worker.git',
      definitions: {
        ...NONE,
        queries: DAEMON_GIT_QUERY_DEFINITIONS,
        instructions: DAEMON_GIT_INSTRUCTION_DEFINITIONS,
      },
    },
    {
      name: 'worker.operation.receipts',
      definitions: {
        ...NONE,
        queries: WORKER_OPERATION_RECEIPT_QUERY_DEFINITIONS,
        instructions: WORKER_OPERATION_RECEIPT_INSTRUCTION_DEFINITIONS,
      },
    },
  ]);

interface DaemonCoreOptions {
  /** Daemon-only vault; never part of the Electron in-process graph. */
  readonly vault?: RuntimeModule;
  readonly credentials?: RuntimeModule;
  /** The owner's mutation fence (CAN-4730 E2-G): its publish operation. */
  readonly mutationFence?: RuntimeModule;
  /** Runs on the core before any forwarded worker instruction. */
  readonly instructionGuard?: RuntimeInstructionGuard;
  readonly identity: CanopyRuntimeIdentity;
  /** Extra core services; tests use one to drive health-change events. */
  readonly services?: readonly RuntimeService[];
  /**
   * The W5 qualification host's core services (W5b) and modules, such as the
   * trusted record port (W6g), W5e's `core.events` (CAN-5497) and the
   * `core.workspace.*` metadata commands over W5d1's command cores (W7a-3,
   * CAN-5548). Production composes none.
   */
  readonly w5?: {
    readonly services: readonly RuntimeService[];
    readonly modules?: readonly RuntimeModule[];
  };
  /** The runtime's epoch when a composed journal shares it (W5e). */
  readonly daemonEpoch?: string;
}

export interface CanopyDaemonGraphOptions extends DaemonCoreOptions {
  readonly filesystem: CanopyDaemonFilesystemOptions;
  /** Hosts over the Files module's Git read and write hosts; never a second host. */
  readonly git: RecordedWorkerGitHosts;
  /** Test seam for observing the binding; production uses the default. */
  readonly createWorkerPair?: () => Promise<CanopyFramedPair>;
  /**
   * `worker.terminal.*` over the supervised terminal host (CAN-5088; on
   * Windows CAN-5091). The bundled composition only.
   */
  readonly terminals?: RuntimeModule;
  /**
   * `worker.codeGraph.*` over budgeted graph hosts (CAN-5089; on Windows
   * CAN-5091). The bundled composition only.
   */
  readonly codeGraph?: RuntimeModule;
  /**
   * `worker.script.*` over a script worker in the daemon (CAN-5087; on
   * Windows CAN-5091). The bundled composition only.
   */
  readonly scripts?: RuntimeModule;
  /**
   * `worker.pipeline.execution.*` over a supervised pipeline host
   * (CAN-5086; on Windows CAN-5091). The bundled composition only.
   */
  readonly pipelines?: RuntimeModule;
  /**
   * `core.execution.status.*` over the daemon's execution accounting
   * (CAN-5627). The bundled composition only.
   */
  readonly execution?: RuntimeModule;
  /**
   * `core.operation.*` over the daemon's operation ledger (CAN-5092), only
   * where compiled ownership makes the daemon its writer. The bundled
   * composition only; production composes none.
   */
  readonly operations?: RuntimeModule;
  /**
   * `core.pipeline.definition.*` over the local store (CAN-5092 S1b), only
   * where the trusted seam makes the daemon the definitions' writer. The
   * bundled composition only; production composes none.
   */
  readonly pipelineDefinitions?: RuntimeModule;
}

function authorityOf({ authorityId }: CanopyRuntimeIdentity): string {
  if (authorityId === null || authorityId.trim() === '')
    throw new Error('Daemon core authority required.');
  return authorityId;
}

function coreModules(options: DaemonCoreOptions): RuntimeModule[] {
  return [
    {
      name: 'core.daemon',
      plane: 'core',
      services: [...(options.services ?? []), ...(options.w5?.services ?? [])],
      definitions: NONE,
      handlers: NONE,
    },
    ...(options.w5?.modules ?? []),
    ...(options.vault ? [options.vault] : []),
    ...(options.credentials ? [options.credentials] : []),
    ...(options.mutationFence ? [options.mutationFence] : []),
  ];
}

const GRAPH_TIMING = { phaseDeadlineMs: 5_000, shutdownTimeoutMs: 2_000 };

/**
 * The bundled `core+worker` graph the daemon serves. Its `localWorker` is the
 * transport dispatch records use once core execution is placed here (CAN-5092).
 */
export async function createCanopyDaemonGraph(
  options: CanopyDaemonGraphOptions,
): Promise<RuntimeProfileGraph> {
  const workerCaller = daemonWorkerCaller(authorityOf(options.identity), {
    terminals: options.terminals !== undefined,
    codeGraph: options.codeGraph !== undefined,
    scripts: options.scripts !== undefined,
    pipelines: options.pipelines !== undefined,
  });
  const workerBinding = await (
    options.createWorkerPair ?? createBundledWorkerPair
  )();
  return createRuntimeProfileGraph({
    profile: 'core+worker',
    identity: options.identity,
    modules: [
      createDaemonFilesystemModule(options.filesystem),
      createDaemonGitModule(options.git),
      ...(options.terminals ? [options.terminals] : []),
      ...(options.codeGraph ? [options.codeGraph] : []),
      ...(options.scripts ? [options.scripts] : []),
      ...(options.pipelines ? [options.pipelines] : []),
      ...(options.execution ? [options.execution] : []),
      ...(options.operations ? [options.operations] : []),
      ...(options.pipelineDefinitions ? [options.pipelineDefinitions] : []),
      ...coreModules(options),
    ],
    daemonEpoch: options.daemonEpoch,
    // Control-plane connections are interfaces, except the proven owner (CAN-5771); the host resolves this, never the caller.
    principalFor: daemonPrincipalFor,
    workerCaller,
    workerBinding,
    peerScopedIdempotency: DAEMON_PEER_SCOPED_IDEMPOTENCY,
    replayedKeyedInstructions: DAEMON_REPLAYED_KEYED_INSTRUCTIONS,
    ...(options.instructionGuard && {
      instructionGuard: options.instructionGuard,
    }),
    operationReceipts: true,
    ...GRAPH_TIMING,
  });
}

export interface CanopyDaemonSplitGraphOptions extends DaemonCoreOptions {
  /** The route to the supervised worker process; its supervisor attaches each start. */
  readonly worker: SupervisedLocalWorker;
}

/**
 * The split composition (CAN-5073): the same `core+worker` graph and
 * manifest, with the worker modules in a supervised `--profile worker`
 * process behind a socket or pipe binding instead of the in-process pair.
 */
export function createCanopyDaemonSplitGraph(
  options: CanopyDaemonSplitGraphOptions,
): RuntimeProfileGraph {
  authorityOf(options.identity);
  return createRuntimeProfileGraph({
    profile: 'core+worker',
    identity: options.identity,
    modules: coreModules(options),
    supervisedWorker: {
      modules: DAEMON_WORKER_MODULES,
      worker: options.worker,
    },
    daemonEpoch: options.daemonEpoch,
    principalFor: daemonPrincipalFor,
    peerScopedIdempotency: DAEMON_PEER_SCOPED_IDEMPOTENCY,
    ...(options.instructionGuard && {
      instructionGuard: options.instructionGuard,
    }),
    operationReceipts: true,
    ...GRAPH_TIMING,
  });
}

export interface CanopyDaemonWorkerGraphOptions {
  readonly identity: CanopyRuntimeIdentity;
  readonly filesystem: CanopyDaemonFilesystemOptions;
  readonly git: RecordedWorkerGitHosts;
}

/** The `--profile worker` graph a split daemon supervises: the worker modules only. */
export function createCanopyDaemonWorkerGraph(
  options: CanopyDaemonWorkerGraphOptions,
): RuntimeProfileGraph {
  return createRuntimeProfileGraph({
    profile: 'worker',
    identity: options.identity,
    modules: [
      createDaemonFilesystemModule(options.filesystem),
      createDaemonGitModule(options.git),
    ],
    replayedKeyedInstructions: DAEMON_REPLAYED_KEYED_INSTRUCTIONS,
    operationReceipts: true,
    ...GRAPH_TIMING,
  });
}
