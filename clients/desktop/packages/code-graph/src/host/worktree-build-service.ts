import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CodeGraphColdFallback, CodeGraphSeedSource } from '../base-graph';
import {
  codeGraphFailureClass,
  type CodeGraphFailureClass,
} from '../io-failure';
import { fingerprintCustomLanguageInputs } from '../languages/custom-config';
import type {
  CodeGraphBuildOptions,
  CodeGraphBuildPrelude,
  CodeGraphRepositoryInput,
} from '../types/code-graph';
import type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerFingerprintPersist,
} from './build-protocol';
import {
  CodeGraphWorkerBuildError,
  type CodeGraphBuildSchedulingOptions,
  type CodeGraphWorkerBuildHandle,
} from './build-scheduler';
import type { CodeGraphFingerprintWorkerResponse } from './fingerprint-host';
import {
  CodeGraphReadFailureError,
  codeGraphReadFailure,
} from './read-failure';

/*
 * One worktree graph generation: resolve the worktree's repositories,
 * fingerprint them, seed a first graph from published base graphs where the
 * host offers them, then build through the host's build scheduler. Electron
 * main and the core daemon compose it; each injects its paths, availability,
 * schedulers and observer.
 */

/** Why a worktree generation ran; `manual` and `tool-request` wait on it. */
export type CodeGraphWorktreeBuildTrigger =
  | 'worktree-created'
  | 'refresh'
  | 'tool-request'
  | 'manual';

/** The generation stage a failure is attributed to. */
export type CodeGraphWorktreeBuildStage =
  | 'preflight'
  | 'seed-preparation'
  | 'worker-build';

/** The build queue class a worktree generation runs in. */
export type CodeGraphWorktreeQueuePriority =
  | 'agent'
  | 'first-build'
  | 'worktree';

/**
 * What failed, for the observer to classify. A worker response carries only
 * its failure class and errno, never its message.
 */
export type CodeGraphWorktreeBuildFailureCause =
  | { kind: 'unavailable' }
  | {
      kind: 'worker-response';
      failureClass?: CodeGraphFailureClass;
      errno?: string;
    }
  | { kind: 'error'; error: unknown };

/** One generation, as the host's telemetry and diagnostics observe it. */
export interface CodeGraphWorktreeBuildObservation {
  setRepositoryCount(count: number): void;
  succeeded(input: {
    response: Extract<CodeGraphWorkerBuildResponse, { ok: true }>;
    seededRepositoryCount: number;
    coldFallbackRepositoryCount: number;
    /** The first cold fallback's closed reason and class, if any. */
    coldFallback?: Omit<CodeGraphColdFallback, 'repoId'>;
    reusedRepositoryCount: number;
    preparationFailed: boolean;
    attemptId: string | undefined;
    queuePriority: CodeGraphWorktreeQueuePriority | undefined;
    totalMs: number;
    endFingerprintMs: number | undefined;
    fingerprintPersistMs: number | undefined;
    fingerprintPersistOutcome: CodeGraphWorkerFingerprintPersist['outcome'];
  }): void;
  failed(input: {
    stage: CodeGraphWorktreeBuildStage;
    cause: CodeGraphWorktreeBuildFailureCause;
    attemptId: string | undefined;
    queuePriority: CodeGraphWorktreeQueuePriority | undefined;
    totalMs: number;
  }): void;
}

/** Copies a compatible published base graph for one repository, or `null`. */
export type CodeGraphWorktreeSeedCopy = (input: {
  canonicalRepoPath: string;
  repoId: string;
  customLanguagesFingerprint: string;
  destinationRootPath: string;
  seedStagingDir: string;
}) => Promise<CodeGraphSeedSource | null>;

export interface CodeGraphWorktreeBuildHost {
  isAvailable(workspaceId: string): boolean;
  /** The fixed message an unavailable build answers with. */
  readonly unavailableMessage: string;
  worktreeGraphDir(workspaceId: string, worktreeId: string): string;
  worktreeDbPath(workspaceId: string, worktreeId: string): string;
  resourcesDir(): string;
  worktreeRoot(workspaceId: string, worktreeId: string): string;
  repositories(
    workspaceId: string,
    worktreeId: string,
    worktreeRootPath: string,
  ): Promise<CodeGraphRepositoryInput[]>;
  /** The workspace's display name, or `null` when it can't be read. */
  workspaceLabel(workspaceId: string): Promise<string | null>;
  /**
   * Seeding from published base graphs: each repository's canonical source
   * checkout and the copy. Absent: every first graph builds cold.
   */
  readonly seeds?: {
    canonicalSources(workspaceId: string): Promise<ReadonlyMap<string, string>>;
    copy: CodeGraphWorktreeSeedCopy;
  };
  beginBuild(
    key: string,
    request: CodeGraphWorkerBuildRequest,
    scheduling: CodeGraphBuildSchedulingOptions,
  ): CodeGraphWorkerBuildHandle;
  fingerprint(
    key: string,
    repositories: readonly CodeGraphRepositoryInput[],
    options: { background: boolean },
  ): Promise<CodeGraphFingerprintWorkerResponse>;
  /** Whether the worktree graph ever completed; rejects with a read failure. */
  readCompletion(dbPath: string, key: string): Promise<boolean>;
  clearFingerprintCache(dbPath: string): void;
  withWorktreeClosed<T>(
    workspaceId: string,
    worktreeId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  /** The worktree changed while it built: queue one more refresh. */
  scheduleFollowup(workspaceId: string, worktreeId: string): void;
  /** Time to first graph: the earliest request for a graph never completed. */
  readonly firstRequests: {
    note(key: string, requestedAt: number): void;
    clear(key: string): void;
    at(key: string): number | undefined;
  };
  observe(input: {
    projectId: string;
    worktreeId: string;
    trigger: CodeGraphWorktreeBuildTrigger;
  }): CodeGraphWorktreeBuildObservation;
}

export interface CodeGraphWorktreeBuildInput {
  projectId: string;
  worktreeId: string;
  reason: CodeGraphWorktreeBuildTrigger;
  options?: CodeGraphBuildOptions;
  /** Fingerprint already observed by the automatic scheduler immediately before this build. */
  observedFingerprint?: string;
  /** How long the scheduler's fingerprint read took, when it supplied one. */
  observedFingerprintMs?: number;
  /** Cancels the generation while it prepares, before its build queues. */
  signal?: AbortSignal;
  /** Called once the generation's build is in the queue. */
  onQueued?: () => void;
}

export interface CodeGraphWorktreeBuildService {
  run(
    input: CodeGraphWorktreeBuildInput,
  ): Promise<CodeGraphWorkerBuildResponse>;
}

function roundMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.round(Math.max(0, value) * 10) / 10, 86_400_000);
}

/**
 * The build queue class for a worktree build: agent requests keep `agent`;
 * an automatic build for a worktree with no completed graph is a first build.
 */
export function worktreeQueuePriority(
  requested: 'agent' | 'worktree',
  graphCompleted: boolean,
): CodeGraphWorktreeQueuePriority {
  if (requested === 'agent') return 'agent';
  return graphCompleted ? 'worktree' : 'first-build';
}

/** An existing graph is not a first graph: drop its request time. */
function withoutFirstGraphRequest(
  timings: CodeGraphBuildPrelude,
): CodeGraphBuildPrelude {
  const kept: CodeGraphBuildPrelude = { ...timings };
  delete kept.firstGraphRequestedAt;
  return kept;
}

export function createCodeGraphWorktreeBuildService(
  host: CodeGraphWorktreeBuildHost,
): CodeGraphWorktreeBuildService {
  /**
   * Seed staging directories owned by builds that are still preparing or
   * running. Copies left behind by a quit or crash mid-build (each 1–1.6 GB)
   * are removed before the next preparation for that worktree.
   */
  const activeSeedStagingDirs = new Set<string>();

  async function removeAbandonedSeedStaging(
    seedStagingRoot: string,
  ): Promise<void> {
    const entries = await readdir(seedStagingRoot, {
      withFileTypes: true,
    }).catch(() => []);
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(seedStagingRoot, entry.name))
        .filter((directory) => !activeSeedStagingDirs.has(directory))
        .map((directory) =>
          rm(directory, { recursive: true, force: true }).catch(
            () => undefined,
          ),
        ),
    );
  }

  async function runAdmittedWorktreeBuild(input: {
    key: string;
    request: CodeGraphWorkerBuildRequest;
    scheduling: CodeGraphBuildSchedulingOptions;
    onAttemptId: (attemptId: string | null) => void;
    signal: AbortSignal | undefined;
    onQueued: (() => void) | undefined;
  }): Promise<CodeGraphWorkerBuildResponse> {
    // A generation canceled while it prepared never queues its build.
    if (input.signal?.aborted)
      throw new CodeGraphWorkerBuildError(
        'canceled',
        'The code graph build was canceled before it queued.',
      );
    const handle = host.beginBuild(input.key, input.request, input.scheduling);
    input.onQueued?.();
    // The runner returns the stable id of its coalesced BuildRecord. Never
    // invent a caller id: two callers coalesced onto one record must agree.
    input.onAttemptId(handle.attemptId);
    try {
      return await handle.promise;
    } finally {
      input.onAttemptId(handle.attemptId);
    }
  }

  async function fingerprintWorktree(
    key: string,
    repositories: readonly CodeGraphRepositoryInput[],
    background: boolean,
  ): Promise<string> {
    const response = await host.fingerprint(key, repositories, {
      background,
    });
    if (!response.ok) {
      throw new Error(response.message);
    }
    return response.fingerprint;
  }

  async function runColdFallback(input: {
    projectId: string;
    worktreeId: string;
    worktreePath: string;
    repositories: CodeGraphRepositoryInput[];
    options?: CodeGraphBuildOptions;
    fallback: Omit<CodeGraphColdFallback, 'repoId'>;
    workspaceLabel: string;
    priority: 'agent' | 'worktree';
    startFingerprint: string;
    timings: CodeGraphBuildPrelude;
    onQueuePriority: (priority: CodeGraphWorktreeQueuePriority) => void;
    onAttemptId: (attemptId: string | null) => void;
    signal: AbortSignal | undefined;
    onQueued: (() => void) | undefined;
  }): Promise<CodeGraphWorkerBuildResponse> {
    if (!host.isAvailable(input.projectId)) {
      return { ok: false, message: host.unavailableMessage };
    }
    const existingGraph = await host.readCompletion(
      host.worktreeDbPath(input.projectId, input.worktreeId),
      `${input.projectId}/${input.worktreeId}`,
    );
    const queuePriority = worktreeQueuePriority(input.priority, existingGraph);
    input.onQueuePriority(queuePriority);
    const response = await runAdmittedWorktreeBuild({
      key: `${input.projectId}/${input.worktreeId}`,
      request: {
        dbPath: host.worktreeDbPath(input.projectId, input.worktreeId),
        worktreeRootPath: input.worktreePath,
        resourcesDir: host.resourcesDir(),
        repositories: input.repositories,
        options: input.options ?? {},
        // Answer at publication; derived analysis follows in the worker.
        deferDerived: true,
        fingerprint: { start: input.startFingerprint },
        timings: existingGraph
          ? withoutFirstGraphRequest(input.timings)
          : input.timings,
      },
      scheduling: {
        priority: queuePriority,
        metadata: {
          scope: 'worktree',
          workspaceIds: [input.projectId],
          workspaceLabel: input.workspaceLabel,
          worktreeId: input.worktreeId,
          label: input.worktreeId,
          trigger: 'seed-preparation-fallback',
        },
      },
      onAttemptId: input.onAttemptId,
      signal: input.signal,
      onQueued: input.onQueued,
    });
    if (response.ok) {
      response.seedOutcomes = input.repositories.map((repository) =>
        existingGraph
          ? {
              repoId: repository.repoId,
              status: 'existing-graph-reused' as const,
            }
          : {
              ...input.fallback,
              repoId: repository.repoId,
              status: 'cold-fallback' as const,
            },
      );
    }
    return response;
  }

  async function run(
    input: CodeGraphWorktreeBuildInput,
  ): Promise<CodeGraphWorkerBuildResponse> {
    if (!host.isAvailable(input.projectId)) {
      return { ok: false, message: host.unavailableMessage };
    }
    const buildKey = `${input.projectId}/${input.worktreeId}`;
    const observation = host.observe({
      projectId: input.projectId,
      worktreeId: input.worktreeId,
      trigger: input.reason,
    });
    const requestedAt = Date.now();
    const flowStartedAt = performance.now();
    let seedStagingDir: string | undefined;
    let workerStarted = false;
    let preparationFailed = false;
    let preparationFallback: Omit<CodeGraphColdFallback, 'repoId'> | undefined;
    let failureStage: CodeGraphWorktreeBuildStage = 'preflight';
    // The queue class the worker build was enqueued with, once known.
    let queuePriority: CodeGraphWorktreeQueuePriority | undefined;
    let attemptId: string | undefined;
    const fail = (cause: CodeGraphWorktreeBuildFailureCause): void => {
      observation.failed({
        stage: failureStage,
        cause,
        attemptId,
        queuePriority,
        totalMs: roundMs(performance.now() - flowStartedAt),
      });
    };
    const unavailableResponse = (): CodeGraphWorkerBuildResponse => {
      fail({ kind: 'unavailable' });
      return { ok: false, message: host.unavailableMessage };
    };

    try {
      const worktreePath = host.worktreeRoot(input.projectId, input.worktreeId);
      const repositories = await host.repositories(
        input.projectId,
        input.worktreeId,
        worktreePath,
      );
      observation.setRepositoryCount(repositories.length);
      const workspaceLabel =
        (
          await host.workspaceLabel(input.projectId).catch(() => null)
        )?.trim() || input.projectId;
      if (!host.isAvailable(input.projectId)) {
        return unavailableResponse();
      }
      const workerPriority =
        input.reason === 'tool-request' || input.reason === 'manual'
          ? 'agent'
          : 'worktree';
      const backgroundFingerprint = workerPriority !== 'agent';
      const fingerprintStartedAt = performance.now();
      const startFingerprint =
        input.observedFingerprint ??
        (await fingerprintWorktree(
          buildKey,
          repositories,
          backgroundFingerprint,
        ));
      const fingerprintMs =
        input.observedFingerprint === undefined
          ? performance.now() - fingerprintStartedAt
          : input.observedFingerprintMs;
      let seedCopyMs = 0;
      const preludeTimings = (
        graphCompleted: boolean,
      ): CodeGraphBuildPrelude => {
        // Time to first graph runs from the earliest request for a graph this
        // worktree has never completed.
        if (graphCompleted) host.firstRequests.clear(buildKey);
        else host.firstRequests.note(buildKey, requestedAt);
        const firstGraphRequestedAt = graphCompleted
          ? undefined
          : host.firstRequests.at(buildKey);
        return {
          ...(fingerprintMs === undefined
            ? {}
            : { fingerprintMs: roundMs(fingerprintMs) }),
          seedCopyMs: roundMs(seedCopyMs),
          ...(firstGraphRequestedAt === undefined
            ? {}
            : { firstGraphRequestedAt }),
        };
      };
      const seedStagingRoot = path.join(
        host.worktreeGraphDir(input.projectId, input.worktreeId),
        'seed-staging',
      );

      const coldFallback = (
        fallback: Omit<CodeGraphColdFallback, 'repoId'>,
      ): Promise<CodeGraphWorkerBuildResponse> =>
        runColdFallback({
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          worktreePath,
          repositories,
          options: input.options,
          fallback,
          workspaceLabel,
          priority: workerPriority,
          startFingerprint,
          timings: preludeTimings(false),
          onQueuePriority: (priority) => {
            queuePriority = priority;
          },
          onAttemptId: (id) => {
            attemptId = id ?? undefined;
            failureStage = 'worker-build';
          },
          signal: input.signal,
          onQueued: input.onQueued,
        });

      let response: CodeGraphWorkerBuildResponse;
      const seeds = host.seeds;
      if (seeds === undefined) {
        // Without seeding, a first graph builds cold, with no staging copy.
        response = await coldFallback({ reason: 'no-seed-source' });
      } else {
        await removeAbandonedSeedStaging(seedStagingRoot);
        const preparedSeedStagingDir = path.join(seedStagingRoot, randomUUID());
        seedStagingDir = preparedSeedStagingDir;
        activeSeedStagingDirs.add(preparedSeedStagingDir);
        await mkdir(preparedSeedStagingDir, { recursive: true });
        failureStage = 'seed-preparation';
        try {
          const customLanguagesFingerprint =
            await fingerprintCustomLanguageInputs(worktreePath);
          const sourceByRepoId = await seeds.canonicalSources(input.projectId);
          const seedSources: CodeGraphSeedSource[] = [];
          const coldFallbacks: CodeGraphColdFallback[] = [];
          failureStage = 'preflight';
          const graphAlreadyCompleted = await host.readCompletion(
            host.worktreeDbPath(input.projectId, input.worktreeId),
            buildKey,
          );
          failureStage = 'seed-preparation';
          for (const repository of graphAlreadyCompleted ? [] : repositories) {
            if (!host.isAvailable(input.projectId)) {
              return unavailableResponse();
            }
            const canonicalRepoPath = sourceByRepoId.get(repository.repoId);
            if (canonicalRepoPath === undefined) {
              coldFallbacks.push({
                repoId: repository.repoId,
                reason: 'no-canonical-source',
              });
              continue;
            }
            const copyStartedAt = performance.now();
            try {
              const source = await seeds.copy({
                canonicalRepoPath,
                repoId: repository.repoId,
                customLanguagesFingerprint: customLanguagesFingerprint.value,
                destinationRootPath: repository.rootPath,
                seedStagingDir: preparedSeedStagingDir,
              });
              seedCopyMs += performance.now() - copyStartedAt;
              if (source === null) {
                coldFallbacks.push({
                  repoId: repository.repoId,
                  reason: 'no-compatible-base',
                });
              } else {
                seedSources.push(source);
              }
            } catch (error) {
              seedCopyMs += performance.now() - copyStartedAt;
              coldFallbacks.push({
                repoId: repository.repoId,
                reason: 'seed-copy-failed',
                failureClass: codeGraphFailureClass(error),
              });
            }
          }

          const timings = preludeTimings(graphAlreadyCompleted);
          workerStarted = true;
          failureStage = 'worker-build';
          queuePriority = worktreeQueuePriority(
            workerPriority,
            graphAlreadyCompleted,
          );
          const preparedQueuePriority = queuePriority;
          const runPreparedBuild = (): Promise<CodeGraphWorkerBuildResponse> =>
            host.isAvailable(input.projectId)
              ? runAdmittedWorktreeBuild({
                  key: buildKey,
                  request: {
                    dbPath: host.worktreeDbPath(
                      input.projectId,
                      input.worktreeId,
                    ),
                    worktreeRootPath: worktreePath,
                    resourcesDir: host.resourcesDir(),
                    repositories,
                    options: input.options ?? {},
                    // Answer at publication; derived analysis follows in the
                    // worker (see the build scheduler, the drain).
                    deferDerived: true,
                    fingerprint: { start: startFingerprint },
                    preparation: {
                      seedSources,
                      coldFallbacks,
                      customLanguagesFingerprint:
                        customLanguagesFingerprint.value,
                      seedStagingDir: preparedSeedStagingDir,
                    },
                    timings,
                  },
                  scheduling: {
                    priority: preparedQueuePriority,
                    metadata: {
                      scope: 'worktree',
                      workspaceIds: [input.projectId],
                      workspaceLabel,
                      worktreeId: input.worktreeId,
                      label: input.worktreeId,
                      trigger: input.reason,
                    },
                  },
                  onAttemptId: (id) => {
                    attemptId = id ?? undefined;
                  },
                  signal: input.signal,
                  onQueued: input.onQueued,
                })
              : Promise.resolve({
                  ok: false,
                  message: host.unavailableMessage,
                });
          response = graphAlreadyCompleted
            ? await runPreparedBuild()
            : await host.withWorktreeClosed(
                input.projectId,
                input.worktreeId,
                runPreparedBuild,
              );
        } catch (error) {
          // Read-worker saturation says freshness is unknown, not that the graph
          // is absent. In particular, do not fall back to a cold seed build when
          // completion metadata could not be admitted; let a later scheduler
          // tick retry the read after the lane has capacity.
          if (
            error instanceof CodeGraphReadFailureError &&
            codeGraphReadFailure(error) === 'busy'
          ) {
            throw error;
          }
          if (workerStarted) {
            throw error;
          }
          preparationFailed = true;
          failureStage = 'preflight';
          preparationFallback = {
            reason: 'seed-preparation-failed',
            failureClass: codeGraphFailureClass(error),
          };
          response = await coldFallback(preparationFallback);
        }
      }

      if (response.ok) {
        // A completed build means the worktree has its graph.
        host.firstRequests.clear(buildKey);
        // The build host fingerprinted the worktree again after publishing and
        // stored the fingerprint itself when it was unchanged (CAN-5084).
        host.clearFingerprintCache(
          host.worktreeDbPath(input.projectId, input.worktreeId),
        );
        const fingerprintPersist = response.fingerprint;
        const fingerprintPersistOutcome =
          fingerprintPersist?.outcome ?? 'error';
        if (fingerprintPersistOutcome === 'unstable') {
          host.scheduleFollowup(input.projectId, input.worktreeId);
        }
        const outcomes = response.seedOutcomes ?? [];
        const firstColdFallback = outcomes.find(
          (outcome) => outcome.status === 'cold-fallback',
        );
        // A failed preparation built every repository cold for its reason.
        const coldFallback =
          preparationFallback ??
          (firstColdFallback?.status === 'cold-fallback'
            ? {
                reason: firstColdFallback.reason,
                ...(firstColdFallback.failureClass === undefined
                  ? {}
                  : { failureClass: firstColdFallback.failureClass }),
              }
            : undefined);
        observation.succeeded({
          response,
          seededRepositoryCount: outcomes.filter(
            (outcome) => outcome.status === 'seeded',
          ).length,
          coldFallbackRepositoryCount: preparationFailed
            ? repositories.length
            : outcomes.filter((outcome) => outcome.status === 'cold-fallback')
                .length,
          ...(coldFallback === undefined ? {} : { coldFallback }),
          reusedRepositoryCount: outcomes.filter(
            (outcome) => outcome.status === 'existing-graph-reused',
          ).length,
          preparationFailed,
          attemptId,
          queuePriority,
          totalMs: roundMs(performance.now() - flowStartedAt),
          endFingerprintMs:
            fingerprintPersist?.endFingerprintMs === undefined
              ? undefined
              : roundMs(fingerprintPersist.endFingerprintMs),
          fingerprintPersistMs:
            fingerprintPersist?.persistMs === undefined
              ? undefined
              : roundMs(fingerprintPersist.persistMs),
          fingerprintPersistOutcome,
        });
      } else {
        // The worker's message stays here; only its class and errno go on.
        fail({
          kind: 'worker-response',
          ...(response.failureClass === undefined
            ? {}
            : { failureClass: response.failureClass }),
          ...(response.errno === undefined ? {} : { errno: response.errno }),
        });
      }
      return response;
    } catch (error) {
      fail({ kind: 'error', error });
      throw error;
    } finally {
      if (seedStagingDir) {
        await rm(seedStagingDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
        activeSeedStagingDirs.delete(seedStagingDir);
      }
    }
  }

  return { run };
}

/**
 * Stops a worktree key's fingerprint and builds together and resolves once
 * each of their hosts has exited. The build stop must not wait behind the
 * fingerprint host's exit: a build left running meanwhile could finish after
 * the caller counted it as canceled.
 */
export async function cancelCodeGraphWorktreeHosts(
  key: string,
  schedulers: {
    readonly fingerprints: { cancel(key: string): Promise<void> };
    readonly builds: { cancel(key: string): Promise<void> };
  },
): Promise<void> {
  await Promise.all([
    schedulers.fingerprints.cancel(key),
    schedulers.builds.cancel(key),
  ]);
}

/**
 * Worktree generations a host has started and not yet seen settle, so a
 * worktree's builds can be stopped while they prepare, before any queue item
 * names them. Each generation registers before it resolves its scope.
 */
export class CodeGraphPreparingGenerations {
  private readonly byKey = new Map<
    string,
    Map<AbortController, { queued: boolean }>
  >();

  /**
   * Runs one generation under a signal that `abort` for its worktree trips;
   * the generation calls `queued` once its build is in the queue.
   */
  async run<T>(
    workspaceId: string,
    worktreeId: string,
    generation: (signal: AbortSignal, queued: () => void) => Promise<T>,
  ): Promise<T> {
    const key = `${workspaceId}/${worktreeId}`;
    const controller = new AbortController();
    const state = { queued: false };
    const generations =
      this.byKey.get(key) ?? new Map<AbortController, { queued: boolean }>();
    this.byKey.set(key, generations);
    generations.set(controller, state);
    try {
      return await generation(controller.signal, () => {
        state.queued = true;
      });
    } finally {
      generations.delete(controller);
      if (generations.size === 0 && this.byKey.get(key) === generations)
        this.byKey.delete(key);
    }
  }

  /**
   * Trips every running generation of the worktree. Returns how many had not
   * queued their build yet: the ones a queue count leaves out.
   */
  abort(workspaceId: string, worktreeId: string): number {
    let unqueued = 0;
    for (const [controller, state] of this.byKey.get(
      `${workspaceId}/${worktreeId}`,
    ) ?? []) {
      if (!state.queued) unqueued += 1;
      controller.abort();
    }
    return unqueued;
  }
}
