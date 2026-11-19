import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  CanopyOperationError,
  defineRuntimeModule,
  type ExecutionAccounting,
  type GenericResourceMetadata,
  type RuntimeModule,
} from '@canopy/core-runtime';
import {
  filesystemScopeError,
  filesystemSnapshotFailure,
  isFilesystemSnapshotUnavailable,
  isUnreadablePathError,
  readFilesystemScope,
  readFilesystemWorkspaceIndexEntry,
  type FilesystemScopeResolver,
} from '@canopy/core-runtime/node';
import {
  codeGraphBuildFailedError,
  codeGraphBuildRefusal,
  codeGraphScopeNotFoundError,
  codeGraphUnavailableError,
  codeGraphWorktreeBuildResult,
  codeGraphWorktreeGenerationStart,
  CodeGraphFirstGraphRequests,
  CodeGraphReadReportCollector,
  createCodeGraphBuildQueueWorker,
  createCodeGraphGenerationReporter,
  createCodeGraphQueueListeners,
  createWorkerCodeGraphHandlers,
  createWorkerCodeGraphQueueStreamHandlers,
  createWorkerCodeGraphReadHandlers,
  DEFAULT_CODE_GRAPH_PREFERENCES,
  isCodeGraphPreferenceEnabledForWorkspace,
  readCodeGraphWorkspaceSources,
  sameCodeGraphPreferences,
  withCodeGraphGenerationReport,
  withCodeGraphReadReport,
  type CodeGraphPreferenceSource,
} from '@canopy/core-runtime/node/code-graph';
import type {
  ExecutionHostBudget,
  ExecutionHostProcess,
  OwnedExecutionHostPort,
} from '@canopy/core-platform/execution-host';
import {
  leaveBackgroundProcessPolicy,
  lowerSpawnedProcessPriority,
} from '@canopy/core-platform/execution-host/process-priority';
import type * as BaseSeed from '@canopy/code-graph/host/base-seed';
import type * as Budgets from '@canopy/code-graph/host/budgets';
import type * as BuildScheduler from '@canopy/code-graph/host/build-scheduler';
import type * as FingerprintScheduler from '@canopy/code-graph/host/fingerprint-scheduler';
import type * as ReadFailure from '@canopy/code-graph/host/read-failure';
import type * as ReadScheduler from '@canopy/code-graph/host/read-scheduler';
import type * as ReadService from '@canopy/code-graph/host/read-service';
import type * as ReadWorker from '@canopy/code-graph/host/read-worker';
import type * as WorktreeBuildService from '@canopy/code-graph/host/worktree-build-service';
import type * as WorktreeFingerprintReads from '@canopy/code-graph/host/worktree-fingerprint-reads';
import type * as WorktreeRepositories from '@canopy/code-graph/host/worktree-repositories';
import type { CodeGraphReadWorkerOutcome } from '@canopy/code-graph/host/read-worker';
import type { CodeGraphFingerprintMetadataReader } from '@canopy/code-graph/host/worktree-fingerprint-reads';
import type { CodeGraphWorktreeLayout } from '@canopy/code-graph/host/worktree-repositories';
import type { CodeGraphSeedSource } from '@canopy/code-graph/base-graph';
import type { CodeGraphRepositoryInput } from '@canopy/code-graph/types/code-graph';
import {
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_STREAM_DEFINITIONS,
  WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
  type WorkerCodeGraphBuildParams,
  type WorkerCodeGraphBuildResult,
  type WorkerCodeGraphGenerationReport,
} from '@canopy/protocol/canopy-core';
import { accountExecutionHost } from './execution';

/** Every `worker.codeGraph.*` operation the daemon serves (CAN-5089). */
export const DAEMON_CODE_GRAPH_DEFINITIONS = {
  queries: {
    ...WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
    ...WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  },
  instructions: {
    ...WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
    ...WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
  },
  streams: { ...WORKER_CODE_GRAPH_STREAM_DEFINITIONS },
};

const PREFERENCE_READ_TIMEOUT_MS = 2_000;
const PREFERENCE_POLL_MS = 5_000;
const UNAVAILABLE_MESSAGE = 'Code graph generation is unavailable.';

type CodeGraphHost = typeof BaseSeed &
  typeof Budgets &
  typeof BuildScheduler &
  typeof FingerprintScheduler &
  typeof ReadFailure &
  typeof ReadScheduler &
  typeof ReadService &
  typeof ReadWorker &
  typeof WorktreeBuildService &
  typeof WorktreeFingerprintReads &
  typeof WorktreeRepositories;

/**
 * `@canopy/code-graph` is a CommonJS package, and an ES module's static named
 * imports of one fail in the daemon's source runs under tsx, while a dynamic
 * import sees every export. The single executable bundles both alike.
 */
async function loadCodeGraphHost(): Promise<CodeGraphHost> {
  const [
    baseSeed,
    budgets,
    buildScheduler,
    fingerprintScheduler,
    readFailure,
    readScheduler,
    readService,
    readWorker,
    worktreeBuildService,
    worktreeFingerprintReads,
    worktreeRepositories,
  ] = await Promise.all([
    import('@canopy/code-graph/host/base-seed'),
    import('@canopy/code-graph/host/budgets'),
    import('@canopy/code-graph/host/build-scheduler'),
    import('@canopy/code-graph/host/fingerprint-scheduler'),
    import('@canopy/code-graph/host/read-failure'),
    import('@canopy/code-graph/host/read-scheduler'),
    import('@canopy/code-graph/host/read-service'),
    import('@canopy/code-graph/host/read-worker'),
    import('@canopy/code-graph/host/worktree-build-service'),
    import('@canopy/code-graph/host/worktree-fingerprint-reads'),
    import('@canopy/code-graph/host/worktree-repositories'),
  ]);
  return {
    ...baseSeed,
    ...budgets,
    ...buildScheduler,
    ...fingerprintScheduler,
    ...readFailure,
    ...readScheduler,
    ...readService,
    ...readWorker,
    ...worktreeBuildService,
    ...worktreeFingerprintReads,
    ...worktreeRepositories,
  };
}

const SEED_ROOT_TIMEOUT_MS = 30_000;

const ENTRIES = {
  build: 'code-graph-build-host.js',
  read: 'code-graph-read-host.js',
  fingerprint: 'code-graph-fingerprint-host.js',
} as const;

export interface DaemonCodeGraphOptions {
  /** Launches budgeted execution hosts: the daemon relaunched in entry mode. */
  readonly hosts: OwnedExecutionHostPort;
  /** Stops what the hosts ran on, after they stopped. */
  readonly shutdown?: () => Promise<void>;
  /** Resolves the selected scope and its trusted owner on every request. */
  readonly resolveScope: FilesystemScopeResolver;
  /** The canonical data root; graphs live under its `workspaces/` tree. */
  readonly dataRoot: string;
  /** The staged code-graph runtime the hosts parse with. */
  readonly resourcesDir: string;
  /** The Git the hosts run, as the daemon selects it. */
  readonly gitExecutable: (signal: AbortSignal) => Promise<string>;
  /** Whether a directory is a Git checkout, read with that Git. */
  readonly isGitRepo: (directory: string) => Promise<boolean>;
  /**
   * The main repository root Git names for a configured source checkout,
   * or the path as configured when Git cannot say (desktop
   * `resolveWorkspaceReferenceRepoPath`). Seeds first graphs (CAN-5626).
   */
  readonly canonicalRepoRoot: (
    configured: string,
    signal: AbortSignal,
  ) => Promise<string>;
  /**
   * The daemon's execution accounting: each graph host holds a `codeGraph`
   * lease and a process registration while it runs (CAN-5627).
   */
  readonly accounting?: ExecutionAccounting<GenericResourceMetadata>;
  /** Test seam: the machine memory the host budgets scale to. */
  readonly totalMemoryBytes?: number;
  /**
   * The desktop's code-graph preferences, read before each build and while
   * builds run (CAN-5629). Absent: every workspace is available with the
   * default 30-minute timeout.
   */
  readonly preferences?: CodeGraphPreferenceSource;
}

interface ResolvedWorktree {
  readonly root: string;
  readonly layout: CodeGraphWorktreeLayout;
}

/**
 * `worker.codeGraph.*` from the daemon (CAN-5089): builds, the build queue,
 * reads, snapshots and fingerprints, each in a host the daemon relaunches in
 * its execution host entry mode under its CAN-5085 budget. Worktree scopes
 * resolve through the same tracking records as the Files reads, and graphs
 * live where Electron main keeps them, so either host reads what the other
 * wrote; the CAN-5084 writer lease keeps one writer per graph. Workspace
 * base graphs stay with Electron main, which keeps their shadow checkouts; a
 * worktree's first graph seeds from the bases it published (CAN-5626).
 * Availability and generation timeout follow the desktop's saved
 * preferences, which the daemon reads itself (CAN-5629); the Code Graph
 * feature flag stays with the requesting client.
 */
export async function createDaemonCodeGraphModule(
  options: DaemonCodeGraphOptions,
): Promise<RuntimeModule> {
  const {
    CODE_GRAPH_BUILD_CONCURRENCY_CAP,
    CodeGraphPreparingGenerations,
    CodeGraphReadFailureError,
    cancelCodeGraphWorktreeHosts,
    codeGraphBuildRepositories,
    codeGraphHostBudget,
    codeGraphRepoShadowDir,
    copyPublishedCodeGraphBaseForSeed,
    codeGraphReadRepositories,
    createCodeGraphBuildScheduler,
    createCodeGraphFingerprintScheduler,
    createCodeGraphReadScheduler,
    createCodeGraphReadService,
    createCodeGraphReadServiceWorker,
    createCodeGraphWorktreeBuildService,
    createCodeGraphWorktreeFingerprintReads,
    listCodeGraphWorktreeRepositories,
  } = await loadCodeGraphHost();
  const budget = (
    kind: 'build' | 'read' | 'fingerprint',
    totalMemoryBytes: number,
  ): ExecutionHostBudget => codeGraphHostBudget(kind, { totalMemoryBytes });
  const memory = options.totalMemoryBytes ?? totalmem();
  const graphDir = (workspaceId: string, worktreeId: string): string =>
    join(
      options.dataRoot,
      'workspaces',
      workspaceId,
      'worktree-data',
      worktreeId,
      'code-graph',
    );
  const dbPath = (workspaceId: string, worktreeId: string): string =>
    join(graphDir(workspaceId, worktreeId), 'graph.db');
  const launchSignal = new AbortController();

  const accounted = (
    host: ExecutionHostProcess,
    label: string,
  ): ExecutionHostProcess =>
    accountExecutionHost(options.accounting, host, {
      family: 'codeGraph',
      label,
      groupId: 'other',
      kind: 'other',
    });

  /**
   * The worktree's directory and layout from the tracking records. Every
   * selector is validated there before a path is built; an unknown worktree
   * is not a scope this daemon serves. Records the system refused to read
   * (`EACCES`, `EIO`) are a failed build, not a missing worktree; the error
   * names no path.
   */
  async function resolveWorktree(
    workspaceId: string,
    worktreeId: string,
  ): Promise<ResolvedWorktree> {
    const scope = { workspaceId, worktreeId };
    let roots;
    try {
      roots = (
        await readFilesystemScope(
          scope,
          await options.resolveScope(scope, 'roots'),
          'roots',
        )
      ).roots;
    } catch (error) {
      if (isFilesystemSnapshotUnavailable(error))
        throw codeGraphBuildFailedError('internal', error);
      if (isUnreadablePathError(error))
        throw codeGraphBuildFailedError(
          'internal',
          filesystemScopeError('roots', 'snapshotUnavailable', error),
        );
      throw codeGraphScopeNotFoundError();
    }
    const workspaceRoot = roots.find((root) => root.kind === 'workspace-root');
    if (workspaceRoot)
      return {
        root: workspaceRoot.absolutePath,
        layout: { multiRepo: true, hasSourceRepo: workspaceRoot.gitAware },
      };
    const repository = roots.find((root) => root.kind === 'git-repo');
    if (repository)
      return {
        root: repository.absolutePath,
        layout: { multiRepo: false, hasSourceRepo: false },
      };
    throw codeGraphScopeNotFoundError();
  }

  async function listed(
    worktree: ResolvedWorktree,
  ): Promise<CodeGraphRepositoryInput[]> {
    return listCodeGraphWorktreeRepositories(
      worktree.root,
      worktree.layout,
      options.isGitRepo,
    );
  }

  // The worktree roots this daemon resolved, for the synchronous ports.
  const roots = new Map<string, ResolvedWorktree>();
  const remember = async (
    workspaceId: string,
    worktreeId: string,
  ): Promise<ResolvedWorktree> => {
    const worktree = await resolveWorktree(workspaceId, worktreeId);
    roots.set(`${workspaceId}/${worktreeId}`, worktree);
    return worktree;
  };
  const rootOf = (workspaceId: string, worktreeId: string): string => {
    const worktree = roots.get(`${workspaceId}/${worktreeId}`);
    if (!worktree) throw codeGraphScopeNotFoundError();
    return worktree.root;
  };

  let preferences = DEFAULT_CODE_GRAPH_PREFERENCES;
  const available = (workspaceId: string): boolean =>
    isCodeGraphPreferenceEnabledForWorkspace(preferences, workspaceId);
  const timeoutMs = (): number => preferences.generationTimeoutMinutes * 60_000;

  const reads = createCodeGraphReadScheduler({
    launchReadHost: () =>
      accounted(
        options.hosts.launch({
          entry: ENTRIES.read,
          serviceName: 'Code graph read host',
          budget: budget('read', memory),
          env: { CANOPY_CODE_GRAPH_RESOURCES_DIR: options.resourcesDir },
        }),
        'Code graph read host',
      ),
    // Read diagnostics stay host-side.
    recordReadDiagnostic: () => undefined,
    flushTelemetry: () => undefined,
  });

  const builds = createCodeGraphBuildScheduler({
    launchBuildHost: () =>
      accounted(
        options.hosts.launch({
          entry: ENTRIES.build,
          serviceName: 'Code graph build host',
          budget: budget('build', memory),
          env: {
            CANOPY_GIT_EXECUTABLE: gitExecutable,
            CANOPY_CODE_GRAPH_RESOURCES_DIR: options.resourcesDir,
          },
        }),
        'Code graph build host',
      ),
    trackBuildHost: () => undefined,
    applyProcessPriority: (pid, priority) =>
      lowerSpawnedProcessPriority(pid, priority),
    leaveBackgroundPolicy: (pid) => leaveBackgroundProcessPolicy(pid),
    isWorkspaceAvailable: available,
    generationTimeoutMs: timeoutMs,
    concurrencyCap: () => CODE_GRAPH_BUILD_CONCURRENCY_CAP,
    worktreeDbPath: dbPath,
    withWorktreeClosed: (_workspaceId, _worktreeId, operation) => operation(),
    resolveSummaryRepairPlace: async (workspaceId, worktreeId) => {
      const worktree = await remember(workspaceId, worktreeId);
      return {
        worktreeRootPath: worktree.root,
        repositories: codeGraphBuildRepositories(
          worktree.root,
          worktree.layout.multiRepo,
          await listed(worktree),
        ),
        resourcesDir: options.resourcesDir,
      };
    },
    readSummaryProjection: async ({ key, dbPath: path, diagnosticOwner }) => {
      const response = await reads.run({
        key,
        kind: 'base-validation',
        ...(diagnosticOwner === undefined ? {} : { diagnosticOwner }),
        request: { dbPath: path, task: { kind: 'readonly-summary' } },
      });
      if (!response.ok)
        return {
          ok: false,
          error: new CodeGraphReadFailureError(response.code),
        };
      if (response.result.kind !== 'readonly-summary')
        return {
          ok: false,
          error: new CodeGraphReadFailureError('invalid-response'),
        };
      return { ok: true, value: response.result.value };
    },
  });
  const queueListeners = createCodeGraphQueueListeners();
  builds.setQueueListener(() => queueListeners.notify());

  /**
   * Reads the saved preferences; a changed answer stops the builds of every
   * workspace it turned off. A failed or slow read keeps the last answer.
   */
  async function refreshPreferences(): Promise<void> {
    if (!options.preferences) return;
    let next;
    try {
      next = await options.preferences.read(
        AbortSignal.timeout(PREFERENCE_READ_TIMEOUT_MS),
      );
    } catch {
      return;
    }
    if (sameCodeGraphPreferences(next, preferences)) return;
    preferences = next;
    await builds.reconcileAvailability(available);
  }

  // While any build prepares, queues or runs, a turned-off preference stops
  // it within one poll; an idle daemon reads nothing.
  let activeBuilds = 0;
  let poll: ReturnType<typeof setInterval> | undefined;
  const tick = (): void => {
    void refreshPreferences();
    if (activeBuilds === 0 && builds.queueStatus().entries.length === 0) {
      clearInterval(poll);
      poll = undefined;
    }
  };

  // The Git the next build or fingerprint host runs; selected before launch.
  let gitExecutable = 'git';
  const selectGit = async (): Promise<string> => {
    gitExecutable = await options.gitExecutable(launchSignal.signal);
    return gitExecutable;
  };

  const fingerprints = createCodeGraphFingerprintScheduler({
    resolveGitExecutable: selectGit,
    launchFingerprintHost: (git) =>
      accounted(
        options.hosts.launch({
          entry: ENTRIES.fingerprint,
          serviceName: 'Code graph fingerprint host',
          budget: budget('fingerprint', memory),
          env: { CANOPY_GIT_EXECUTABLE: git },
        }),
        'Code graph fingerprint host',
      ),
    applyProcessPriority: (pid, priority) =>
      lowerSpawnedProcessPriority(pid, priority),
    leaveBackgroundPolicy: (pid) => leaveBackgroundProcessPolicy(pid),
    timeoutMs,
  });

  const readFingerprintMetadata: CodeGraphFingerprintMetadataReader = async (
    path,
    cancellationKey,
  ) => {
    const response = await reads.run({
      key: cancellationKey,
      kind: 'fingerprint-metadata',
      request: { dbPath: path, task: { kind: 'fingerprint-metadata' } },
    });
    if (!response.ok) throw new CodeGraphReadFailureError(response.code);
    if (response.result.kind !== 'fingerprint-metadata')
      throw new CodeGraphReadFailureError('invalid-response');
    return response.result.value;
  };
  const fingerprintReads = createCodeGraphWorktreeFingerprintReads(
    () => readFingerprintMetadata,
  );

  const firstRequests = new CodeGraphFirstGraphRequests();
  const generationReports = new AsyncLocalStorage<
    (report: WorkerCodeGraphGenerationReport) => void
  >();
  // Each generation's signal reaches its seed copies, and a cancel waits for
  // the worktree's generations, so no seed staging lands after cleanup
  // (CAN-5626).
  const seedSignals = new AsyncLocalStorage<AbortSignal>();
  const runningGenerations = new Map<string, Set<Promise<unknown>>>();
  const trackGeneration = (key: string, running: Promise<unknown>): void => {
    const tracked = runningGenerations.get(key) ?? new Set<Promise<unknown>>();
    runningGenerations.set(key, tracked);
    tracked.add(running);
    const settle = (): void => {
      tracked.delete(running);
      if (tracked.size === 0 && runningGenerations.get(key) === tracked)
        runningGenerations.delete(key);
    };
    void running.then(settle, settle);
  };
  const generation = createCodeGraphWorktreeBuildService({
    isAvailable: available,
    unavailableMessage: UNAVAILABLE_MESSAGE,
    worktreeGraphDir: graphDir,
    worktreeDbPath: dbPath,
    resourcesDir: () => options.resourcesDir,
    worktreeRoot: rootOf,
    repositories: async (workspaceId, worktreeId, worktreeRootPath) => {
      const worktree = await remember(workspaceId, worktreeId);
      return codeGraphBuildRepositories(
        worktreeRootPath,
        worktree.layout.multiRepo,
        await listed(worktree),
      );
    },
    // The workspace's display name from the trusted index, as Electron main
    // labels its queue items (CAN-5628); null when it can't be read.
    workspaceLabel: async (workspaceId) => {
      try {
        const raw = await readFile(
          join(options.dataRoot, 'workspaces', 'index.json'),
          'utf8',
        );
        return readFilesystemWorkspaceIndexEntry(workspaceId, {
          state: 'present',
          raw,
        }).name;
      } catch {
        return null;
      }
    },
    // First graphs seed from the bases Electron main publishes (CAN-5626),
    // through the copy Electron main uses, without its in-memory lock.
    seeds: {
      canonicalSources: (workspaceId) =>
        readCodeGraphWorkspaceSources({
          dataRoot: options.dataRoot,
          workspaceId,
          paths: { join, isAbsolute },
        }),
      copy: async (input): Promise<CodeGraphSeedSource | null> => {
        const signal = seedSignals.getStore();
        const canonicalRepoRoot = await options.canonicalRepoRoot(
          input.canonicalRepoPath,
          AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(SEED_ROOT_TIMEOUT_MS),
          ]),
        );
        signal?.throwIfAborted();
        return copyPublishedCodeGraphBaseForSeed({
          shadowDir: codeGraphRepoShadowDir(
            options.dataRoot,
            canonicalRepoRoot,
          ),
          identity: {
            repoId: input.repoId,
            canonicalRepoRoot,
            customLanguagesFingerprint: input.customLanguagesFingerprint,
          },
          destinationRootPath: input.destinationRootPath,
          seedStagingDir: input.seedStagingDir,
        });
      },
    },
    beginBuild: (key, request, scheduling) =>
      builds.beginBuild(key, request, scheduling),
    fingerprint: (key, repositories, { background }) =>
      fingerprints.run(key, repositories, { background }),
    readCompletion: (path, key) => fingerprintReads.completion(path, key),
    clearFingerprintCache: (path) => fingerprintReads.clear(path),
    withWorktreeClosed: (_workspaceId, _worktreeId, operation) => operation(),
    // Electron main's automatic scheduler notices the change on its own tick.
    scheduleFollowup: () => undefined,
    firstRequests: {
      note: (key, requestedAt) => firstRequests.note(key, requestedAt),
      clear: (key) => firstRequests.clear(key),
      at: (key) => firstRequests.at(key),
    },
    // The report goes back with the answer; the requester records it with
    // its own consent and telemetry configuration (CAN-5627).
    observe: ({ trigger }) => {
      const report = generationReports.getStore();
      return createCodeGraphGenerationReporter(trigger, (settled) =>
        report?.(settled),
      );
    },
  });

  const preparing = new CodeGraphPreparingGenerations();

  /**
   * Every build of one worktree; resolves once each of its fingerprint and
   * build hosts has exited, including one that answered and is still exiting.
   */
  async function cancelWorktree(
    workspaceId: string,
    worktreeId: string,
  ): Promise<number> {
    const key = `${workspaceId}/${worktreeId}`;
    // Generations still preparing, then the queue items for the rest.
    const unqueued = preparing.abort(workspaceId, worktreeId);
    const queued = builds
      .queueStatus()
      .entries.filter(
        (entry) =>
          entry.scope === 'worktree' &&
          entry.worktreeId === worktreeId &&
          entry.workspaceIds.includes(workspaceId),
      ).length;
    await Promise.all([
      Promise.allSettled([
        ...(runningGenerations.get(key) ?? new Set<Promise<unknown>>()),
      ]),
      cancelCodeGraphWorktreeHosts(key, { fingerprints, builds }),
    ]);
    return unqueued + queued;
  }

  async function buildWorktree(
    scope: Extract<
      WorkerCodeGraphBuildParams['graphScope'],
      { kind: 'worktree' }
    >,
  ): Promise<WorkerCodeGraphBuildResult> {
    activeBuilds += 1;
    if (!poll) {
      poll = setInterval(tick, PREFERENCE_POLL_MS);
      poll.unref();
    }
    try {
      // Registered before anything else, so a cancel never misses it.
      const running = preparing.run(
        scope.workspaceId,
        scope.worktreeId,
        async (signal, queued) => {
          await refreshPreferences();
          if (!available(scope.workspaceId)) throw codeGraphUnavailableError();
          const worktree = await remember(scope.workspaceId, scope.worktreeId);
          let report: WorkerCodeGraphGenerationReport | undefined;
          let response;
          try {
            // The build host runs the Git the daemon selects as the build starts.
            await selectGit();
            response = await seedSignals.run(signal, () =>
              generationReports.run(
                (settled) => {
                  report = settled;
                },
                () =>
                  generation.run({
                    projectId: scope.workspaceId,
                    worktreeId: scope.worktreeId,
                    ...codeGraphWorktreeGenerationStart(scope),
                    signal,
                    onQueued: queued,
                  }),
              ),
            );
          } catch (error) {
            throw withCodeGraphGenerationReport(
              codeGraphBuildRefusal(error),
              report,
            );
          }
          // The host's message stays here; its class and errno go on the
          // generation report.
          if (!response.ok)
            throw withCodeGraphGenerationReport(
              response.message === UNAVAILABLE_MESSAGE
                ? codeGraphUnavailableError()
                : codeGraphBuildFailedError('build_error'),
              report,
            );
          return {
            ...codeGraphWorktreeBuildResult(response.result, worktree.root),
            ...(report && { generation: report }),
          };
        },
      );
      trackGeneration(`${scope.workspaceId}/${scope.worktreeId}`, running);
      return await running;
    } finally {
      activeBuilds -= 1;
    }
  }

  // Each read reports to the request that ran it, which returns the report
  // with its answer; the requester records it (CAN-5691).
  const readReports = new AsyncLocalStorage<CodeGraphReadReportCollector>();
  const readService = createCodeGraphReadService({
    scheduler: {
      run: (input): ReturnType<typeof reads.run> => {
        const collector = readReports.getStore();
        return reads.run(
          collector
            ? {
                ...input,
                observe: (observation) => collector.observe(observation),
              }
            : input,
        );
      },
    },
    dbPath: ({ workspaceId, worktreeId }) => dbPath(workspaceId, worktreeId),
    hasGraph: ({ workspaceId, worktreeId }) =>
      existsSync(dbPath(workspaceId, worktreeId)),
    buildState: ({ workspaceId, worktreeId }) =>
      builds.sourceBuildState(`${workspaceId}/${worktreeId}`),
    worktreeRoot: ({ workspaceId, worktreeId }) =>
      rootOf(workspaceId, worktreeId),
    repositories: async ({ workspaceId, worktreeId }) => {
      const worktree = await remember(workspaceId, worktreeId);
      return codeGraphReadRepositories(worktree.root, await listed(worktree));
    },
    resourcesDir: () => options.resourcesDir,
    now: () => new Date(),
  });
  const readWorker = createCodeGraphReadServiceWorker(readService);

  const queueWorker = createCodeGraphBuildQueueWorker({
    build: (graphScope) =>
      graphScope.kind === 'worktree'
        ? buildWorktree(graphScope)
        : // Workspace base graphs need their shadow checkouts, which
          // Electron main keeps (CAN-4738).
          Promise.reject(codeGraphUnavailableError()),
    queueStatus: () => builds.queueStatus(),
    reorderQueue: (request) => builds.reorderQueue(request),
    cancelQueueItem: (queueItemId) => builds.cancelQueueItem(queueItemId),
    cancelWorktree,
  });
  const buildHandlers = createWorkerCodeGraphHandlers(queueWorker);
  const queueStreams = createWorkerCodeGraphQueueStreamHandlers({
    queue: () => queueWorker.queue(),
    subscribe: (listener) => queueListeners.subscribe(listener),
  });
  /**
   * Every read resolves its worktree first, so the synchronous ports find it;
   * a worktree this daemon can't resolve is the reads' own not-found refusal.
   * Records the system refused to read are the Files reads' codeless
   * `snapshotUnavailable` failure, not `invalidState`, which callers read as
   * a missing graph.
   */
  async function scoped<Value>(
    scope: { workspaceId: string; worktreeId: string },
    read: () => Promise<CodeGraphReadWorkerOutcome<Value>>,
  ): Promise<CodeGraphReadWorkerOutcome<Value>> {
    try {
      await remember(scope.workspaceId, scope.worktreeId);
    } catch (error) {
      const cause =
        error instanceof CanopyOperationError ? error.runtimeCause : undefined;
      if (isFilesystemSnapshotUnavailable(cause))
        throw filesystemSnapshotFailure(cause);
      return {
        ok: false,
        request: 'not-found',
        message: 'The project or worktree does not exist.',
      };
    }
    return read();
  }
  const readHandlers = createWorkerCodeGraphReadHandlers({
    status: (scope) => scoped(scope, () => readWorker.status(scope)),
    // A workspace base has no worktree to resolve; the read service, which
    // holds no base graphs here, refuses it (CAN-5621).
    query: (params, signal) =>
      'kind' in params.scope
        ? readWorker.query(params, signal)
        : scoped(params.scope, () => readWorker.query(params, signal)),
    exportSnapshot: (params, signal) =>
      scoped(params.scope, () => readWorker.exportSnapshot(params, signal)),
    importSnapshot: (params, signal) =>
      scoped(params.scope, () => readWorker.importSnapshot(params, signal)),
    validateLanguages: (params, signal) =>
      scoped(params.scope, () => readWorker.validateLanguages(params, signal)),
  });

  return defineRuntimeModule({
    name: 'worker.codeGraph',
    plane: 'worker',
    services: [
      {
        name: 'worker.codeGraph.hosts',
        plane: 'worker',
        stop: {
          5: async (): Promise<void> => {
            clearInterval(poll);
            poll = undefined;
            launchSignal.abort();
            await Promise.all([
              builds.cancelAll().then(() => builds.setQueueListener(null)),
              reads.shutdown(),
              fingerprints.shutdown(),
            ]);
            await options.hosts.shutdown();
            await options.shutdown?.();
          },
        },
      },
    ],
    definitions: DAEMON_CODE_GRAPH_DEFINITIONS,
    handlers: {
      queries: {
        ...buildHandlers.queries,
        ...readHandlers.queries,
        'worker.codeGraph.query': async (params, context) => {
          const collector = new CodeGraphReadReportCollector();
          let result;
          try {
            result = await readReports.run(collector, () =>
              readHandlers.queries['worker.codeGraph.query'](params, context),
            );
          } catch (error) {
            throw withCodeGraphReadReport(error, collector.report());
          }
          const report = collector.report();
          return report ? { ...result, read: report } : result;
        },
      },
      instructions: {
        ...buildHandlers.instructions,
        ...readHandlers.instructions,
      },
      streams: { ...queueStreams.streams },
    },
  });
}
