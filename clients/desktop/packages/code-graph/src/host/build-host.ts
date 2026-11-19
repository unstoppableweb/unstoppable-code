import { CodeGraphEngine } from '../engine';
import {
  cloneCompletedCodeGraphDatabase,
  finalizeCodeGraphBaseStaging,
  hasCompletedSeedTarget,
  readPublishedCodeGraphBase,
  seedCodeGraphDatabase,
  seedCodeGraphDatabaseByClone,
  type CodeGraphSeedOutcome,
  type CodeGraphSeedSource,
  type SeedCodeGraphResult,
} from '../base-graph';
import { completeDeferredCodeGraphDerived } from '../deferred-derived';
import {
  openCodeGraphDatabase,
  setMetadataValue,
  withImmediateTransaction,
  type CodeGraphDatabase,
} from '../store/database';
import { CodeGraphStore } from '../store/graph-store';
import {
  acquireCodeGraphWriterLease,
  type CodeGraphWriterLease,
} from '../store/writer-lease';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Session, type Profiler } from 'node:inspector';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { CodeGraphBuildResult } from '../types/code-graph';
import type { CodeGraphHostChannel } from './channel';
import { fingerprintCodeGraphWorktree } from './worktree-fingerprint';
import {
  codeGraphFailureClass,
  errnoOf,
  type CodeGraphFailureClass,
} from '../io-failure';
import type {
  CodeGraphWorkerFingerprintPersist,
  CodeGraphWorkerSummaryRepairRequest,
  CodeGraphWorkerSummaryRepairResponse,
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerDerivedCompletion,
  CodeGraphWorkerEagerSeedRequest,
  CodeGraphWorkerEagerSeedResponse,
} from './build-protocol';

/** Host facts the build host cannot read for itself. */
export interface CodeGraphBuildHostFacts {
  /**
   * Whether open files block replacing a database file, as on Windows; seed
   * installs then copy instead of renaming over a live target.
   */
  readonly openFilesBlockReplacement: boolean;
  /**
   * Whether flushing a file or directory needs a handle opened for writing,
   * as on Windows (`FlushFileBuffers` refuses a read-only handle).
   */
  readonly flushRequiresWriteHandle?: boolean;
  /** Where to write a CPU profile of each build; none without it. */
  readonly cpuProfileDirectory?: string;
  /** The Git executable for the end-of-build worktree fingerprint. */
  readonly gitExecutable: string;
}

const CPU_SAMPLING_INTERVAL_US = 1_000;

interface ActiveCpuProfiler {
  stop(): Promise<void>;
}

function postProfilerEnable(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.enable', (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function postProfilerSamplingInterval(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    session.post(
      'Profiler.setSamplingInterval',
      { interval: CPU_SAMPLING_INTERVAL_US },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

function postProfilerStart(session: Session): Promise<void> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.start', (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function postProfilerStop(session: Session): Promise<Profiler.StopReturnType> {
  return new Promise((resolve, reject) => {
    session.post('Profiler.stop', (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
}

async function startCodeGraphWorkerCpuProfiler(
  directory: string | undefined,
): Promise<ActiveCpuProfiler | undefined> {
  if (directory === undefined) return undefined;

  const session = new Session();
  try {
    await mkdir(directory, { recursive: true });
    session.connect();
    await postProfilerEnable(session);
    await postProfilerSamplingInterval(session);
    await postProfilerStart(session);
  } catch {
    try {
      session.disconnect();
    } catch {
      // Diagnostic profiling must never alter worker completion semantics.
    }
    return undefined;
  }

  return {
    async stop(): Promise<void> {
      try {
        const { profile } = await postProfilerStop(session);
        const outputPath = path.join(
          directory,
          `CPU.code-graph.${process.pid}.${Date.now()}.cpuprofile`,
        );
        await writeFile(outputPath, JSON.stringify(profile), 'utf8');
      } finally {
        session.disconnect();
      }
    },
  };
}

/**
 * Adds base finalization to the returned timings. The finalized database is
 * sealed (checkpointed and integrity-checked), so this phase is reported but
 * never written into it.
 */
function withFinalizeTiming(
  result: CodeGraphBuildResult,
  finalizeMs: number,
): CodeGraphBuildResult {
  if (result.timings === undefined) return result;
  return {
    ...result,
    timings: {
      ...result.timings,
      finalizeMs: Math.round(Math.max(0, finalizeMs) * 10) / 10,
    },
  };
}

/**
 * Seeds a worktree that has no completed graph. A single-repository worktree
 * with its one base clones it, keeping the base's metadata; anything else,
 * or a clone that cannot be used, fuses (row copy into a fresh database).
 */
async function seedWorktreeDatabase(
  request: CodeGraphWorkerBuildRequest,
  preparation: NonNullable<CodeGraphWorkerBuildRequest['preparation']>,
  facts: {
    openFilesBlockReplacement: boolean;
    flushRequiresWriteHandle: boolean;
  },
): Promise<SeedCodeGraphResult> {
  const [onlySource] = preparation.seedSources;
  const [onlyRepository] = request.repositories;
  if (
    onlySource !== undefined &&
    onlyRepository !== undefined &&
    preparation.seedSources.length === 1 &&
    request.repositories.length === 1 &&
    preparation.coldFallbacks.length === 0 &&
    onlySource.repoId === onlyRepository.repoId &&
    onlySource.destinationRootPath === onlyRepository.rootPath
  ) {
    const cloned = await seedCodeGraphDatabaseByClone({
      targetDbPath: request.dbPath,
      source: onlySource,
      customLanguagesFingerprint: preparation.customLanguagesFingerprint,
      ...facts,
    });
    if (cloned !== null) return cloned;
  }
  return seedCodeGraphDatabase({
    targetDbPath: request.dbPath,
    sources: preparation.seedSources,
    customLanguagesFingerprint: preparation.customLanguagesFingerprint,
    ...facts,
  });
}

export interface CodeGraphBuildExecutionOptions {
  /**
   * Set only by the worker transport, which posts the published response
   * and then the derived completion. In-process callers (tests) leave it
   * unset and get today's single response with derived analysis inline.
   */
  allowDeferredDerived?: boolean;
  /** See {@link CodeGraphBuildHostFacts.openFilesBlockReplacement}. */
  openFilesBlockReplacement?: boolean;
  /** See {@link CodeGraphBuildHostFacts.flushRequiresWriteHandle}. */
  flushRequiresWriteHandle?: boolean;
}

/** A failure's closed class and errno; the message stays in process. */
function failureDetail(error: unknown): {
  failureClass: CodeGraphFailureClass;
  errno?: string;
} {
  const errno = errnoOf(error);
  return {
    failureClass: codeGraphFailureClass(error),
    ...(errno === undefined ? {} : { errno }),
  };
}

/**
 * Repairs the worktree's summary projection through an Engine-owned writer.
 * This is intentionally a normal `CodeGraphEngine.open` lifecycle, not a
 * second `openCodeGraphDatabase` handle. Opening a standalone engine can run
 * the usual migrations and initialize the parser runtime; this operation is
 * therefore writer-safe, not a claim that opening it is grammar-free.
 */
export async function executeCodeGraphSummaryRepair(
  request: CodeGraphWorkerSummaryRepairRequest,
): Promise<CodeGraphWorkerSummaryRepairResponse> {
  let engine: CodeGraphEngine | undefined;
  try {
    engine = await CodeGraphEngine.open({
      dbPath: request.dbPath,
      repositories: request.repositories,
      resourcesDir: request.resourcesDir,
      worktreeRootPath: request.worktreeRootPath,
      customLanguagesRootPath: request.customLanguagesRootPath,
    });
    return { ok: true, result: engine.repairSummaryProjection() };
  } catch {
    return {
      ok: false,
      // Do not send paths or SQLite diagnostics over the host
      // boundary. The caller classifies this as a failed repair attempt.
      message: 'The code-graph summary repair could not be completed.',
    };
  } finally {
    try {
      engine?.close();
    } catch {
      // The utility process exits after answering; preserve the repair result.
    }
  }
}

/**
 * The build worker's one job: open a {@link CodeGraphEngine} against the
 * fully-resolved paths in `request`, run one `buildOrUpdate`, and hand back a
 * typed response. Every path is supplied by the caller (main), so this derives
 * nothing from `cwd` or `process.env`. The whole body is wrapped so any
 * failure becomes `{ ok: false }` rather than a thrown error, and the engine
 * is always closed — a live `DatabaseSync` handle would otherwise keep file
 * descriptors open.
 *
 * Exported (not just served on a host channel) so it can be exercised
 * directly, in-process, against a real engine without launching a host.
 */
export async function executeCodeGraphBuild(
  request: CodeGraphWorkerBuildRequest,
  execution?: CodeGraphBuildExecutionOptions,
): Promise<CodeGraphWorkerBuildResponse> {
  // A finalized base must carry its derived analysis, so it never defers.
  const deferDerived =
    execution?.allowDeferredDerived === true &&
    request.deferDerived === true &&
    request.baseFinalization === undefined;
  let engine: CodeGraphEngine | undefined;
  let seedOutcomes: CodeGraphSeedOutcome[] = [];
  let fusionDurationMs = 0;
  let fused = false;
  const flushRequiresWriteHandle = execution?.flushRequiresWriteHandle === true;
  try {
    if (request.preparation !== undefined) {
      if (await hasCompletedSeedTarget(request.dbPath)) {
        seedOutcomes = request.repositories.map((repository) => ({
          repoId: repository.repoId,
          status: 'existing-graph-reused',
        }));
      } else {
        const seeded = await seedWorktreeDatabase(
          request,
          request.preparation,
          {
            openFilesBlockReplacement:
              execution?.openFilesBlockReplacement === true,
            flushRequiresWriteHandle,
          },
        );
        fusionDurationMs = seeded.durationMs;
        fused = true;
        seedOutcomes = [
          ...seeded.outcomes,
          ...request.preparation.coldFallbacks.map((fallback) => ({
            ...fallback,
            status: 'cold-fallback' as const,
          })),
        ];
      }
    }
    engine = await CodeGraphEngine.open({
      dbPath: request.dbPath,
      repositories: request.repositories,
      resourcesDir: request.resourcesDir,
      worktreeRootPath: request.worktreeRootPath,
      customLanguagesRootPath: request.customLanguagesRootPath,
    });
    // The prelude main measured (queue wait, fingerprint, seed copy) and
    // this worker's fusion are persisted with the build's own phase timings.
    const result = await engine.buildOrUpdate({
      ...request.options,
      deferDerived,
      prelude: {
        ...request.timings,
        ...(fused ? { fusionMs: fusionDurationMs } : {}),
      },
    });
    if (request.baseFinalization === undefined) {
      return {
        ok: true,
        result,
        seedOutcomes,
        fusionDurationMs,
        ...(result.derivedDeferred === true
          ? { derivedPending: true as const }
          : {}),
      };
    }
    if (request.baseFinalization.repairSummaryProjection === true) {
      const repair = engine.repairSummaryProjection();
      if (repair.state !== 'ready') {
        throw new Error(
          'The staged base summary projection was not ready for publication.',
        );
      }
    }
    // Finalization reopens the database for its checkpoint and full-page
    // integrity scan, so the build connection must be closed first.
    const builtEngine = engine;
    engine = undefined;
    builtEngine.close();
    const finalizeStartedAt = performance.now();
    await finalizeCodeGraphBaseStaging({
      dbPath: request.dbPath,
      identity: request.baseFinalization.identity,
      gitHead: request.baseFinalization.gitHead,
      flushRequiresWriteHandle,
    });
    return {
      ok: true,
      result: withFinalizeTiming(result, performance.now() - finalizeStartedAt),
      seedOutcomes,
      fusionDurationMs,
      baseFinalized: true,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        request.baseFinalization?.repairSummaryProjection === true
          ? 'The staged base summary repair could not be completed.'
          : error instanceof Error
            ? error.message
            : String(error),
      ...failureDetail(error),
    };
  } finally {
    if (engine !== undefined) {
      try {
        engine.close();
      } catch {
        // Best-effort close; the worker process exits immediately after.
      }
    }
    if (request.preparation !== undefined) {
      await rm(request.preparation.seedStagingDir, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }
}

/**
 * Runs the derived analysis a published worktree build left pending, in the
 * worker that published it (see `deferred-derived.ts`). It opens its own
 * connection and never fails the published build: any error is reported in
 * the completion and the graph keeps reporting stale derived data.
 */
export async function executeDeferredCodeGraphDerived(input: {
  dbPath: string;
}): Promise<CodeGraphWorkerDerivedCompletion> {
  if (!existsSync(input.dbPath)) {
    return {
      kind: 'derived-complete',
      ok: false,
      message: 'The code graph database no longer exists.',
    };
  }
  let db: CodeGraphDatabase | undefined;
  try {
    db = openCodeGraphDatabase(input.dbPath);
    const completed = await completeDeferredCodeGraphDerived({
      db,
      store: new CodeGraphStore(db),
    });
    return { kind: 'derived-complete', ok: true, ...completed };
  } catch (error) {
    return {
      kind: 'derived-complete',
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // The worker exits right after; the completion already says what happened.
    }
  }
}

/** Executes only the eager snapshot install; it never parses source files. */
export async function executeCodeGraphEagerSeed(
  request: CodeGraphWorkerEagerSeedRequest,
  facts: Pick<
    CodeGraphBuildHostFacts,
    'openFilesBlockReplacement' | 'flushRequiresWriteHandle'
  > = {
    openFilesBlockReplacement: false,
  },
): Promise<CodeGraphWorkerEagerSeedResponse> {
  const { openFilesBlockReplacement } = facts;
  const flushRequiresWriteHandle = facts.flushRequiresWriteHandle === true;
  const startedAt = Date.now();
  try {
    if (await hasCompletedSeedTarget(request.targetDbPath)) {
      return {
        ok: true,
        status: 'existing',
        durationMs: Date.now() - startedAt,
      };
    }

    if (request.source.kind === 'base-worktree') {
      const result = await cloneCompletedCodeGraphDatabase({
        sourceDbPath: request.source.dbPath,
        targetDbPath: request.targetDbPath,
        repositories: request.repositories,
        sourceValidation: 'metadata-only',
        targetValidation: 'metadata-only',
        openFilesBlockReplacement,
        flushRequiresWriteHandle,
      });
      return {
        ok: true,
        status: result.installed ? 'seeded' : 'no-compatible-source',
        ...(result.installed ? { source: 'base-worktree' as const } : {}),
        durationMs: Date.now() - startedAt,
      };
    }

    const sources: CodeGraphSeedSource[] = [];
    for (const base of request.source.bases) {
      const published = await readPublishedCodeGraphBase({
        variantDir: base.variantDir,
        identity: base.identity,
        validation: 'metadata-only',
      });
      if (published === null) {
        return {
          ok: true,
          status: 'no-compatible-source',
          durationMs: Date.now() - startedAt,
        };
      }
      sources.push({
        dbPath: published.dbPath,
        repoId: base.identity.repoId,
        canonicalRepoRoot: base.identity.canonicalRepoRoot,
        destinationRootPath: base.destinationRootPath,
        generationId: published.manifest.generationId,
        gitHead: published.manifest.gitHead,
        completedBuildAt: Date.parse(published.manifest.publishedAt),
      });
    }

    if (
      sources.length !== request.repositories.length ||
      sources.length === 0
    ) {
      return {
        ok: true,
        status: 'no-compatible-source',
        durationMs: Date.now() - startedAt,
      };
    }
    if (sources.length === 1) {
      const source = sources[0];
      if (source === undefined) {
        throw new Error('Missing single-repository eager seed source.');
      }
      const result = await cloneCompletedCodeGraphDatabase({
        sourceDbPath: source.dbPath,
        targetDbPath: request.targetDbPath,
        repositories: request.repositories,
        copyMode: 'immutable-file-copy',
        sourceAlreadyValidated: true,
        targetValidation: 'metadata-only',
        openFilesBlockReplacement,
        flushRequiresWriteHandle,
      });
      return {
        ok: true,
        status: result.installed ? 'seeded' : 'existing',
        source: 'workspace-shadow',
        durationMs: Date.now() - startedAt,
      };
    }

    const result = await seedCodeGraphDatabase({
      targetDbPath: request.targetDbPath,
      sources,
      customLanguagesFingerprint:
        request.source.bases[0]?.identity.customLanguagesFingerprint ?? '',
      markCompletedFromSources: true,
      openFilesBlockReplacement,
      flushRequiresWriteHandle,
    });
    // An unflushed seed installed nothing. Answer a failure, not `existing`,
    // so the caller still tries its fallback.
    for (const outcome of result.outcomes) {
      if (
        outcome.status === 'cold-fallback' &&
        outcome.reason === 'seed-flush-failed'
      ) {
        return {
          ok: false,
          message: 'The code graph seed could not be flushed to disk.',
          failureClass: outcome.failureClass ?? 'io',
        };
      }
    }
    return {
      ok: true,
      status: result.installed ? 'seeded' : 'existing',
      source: 'workspace-shadow',
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      ...failureDetail(error),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWorkerBuildRequest(
  value: unknown,
): value is CodeGraphWorkerBuildRequest {
  return (
    isRecord(value) &&
    typeof value.dbPath === 'string' &&
    typeof value.worktreeRootPath === 'string' &&
    typeof value.resourcesDir === 'string' &&
    (value.customLanguagesRootPath === undefined ||
      typeof value.customLanguagesRootPath === 'string') &&
    Array.isArray(value.repositories) &&
    isRecord(value.options) &&
    (value.preparation === undefined || isRecord(value.preparation)) &&
    (value.baseFinalization === undefined ||
      (isRecord(value.baseFinalization) &&
        isRecord(value.baseFinalization.identity))) &&
    (value.deferDerived === undefined ||
      typeof value.deferDerived === 'boolean') &&
    (value.fingerprint === undefined ||
      (isRecord(value.fingerprint) &&
        typeof value.fingerprint.start === 'string'))
  );
}

function isWorkerSummaryRepairRequest(
  value: unknown,
): value is CodeGraphWorkerSummaryRepairRequest {
  return (
    isRecord(value) &&
    value.operation === 'summary-repair' &&
    typeof value.dbPath === 'string' &&
    typeof value.worktreeRootPath === 'string' &&
    typeof value.customLanguagesRootPath === 'string' &&
    typeof value.resourcesDir === 'string' &&
    Array.isArray(value.repositories)
  );
}

function isWorkerEagerSeedRequest(
  value: unknown,
): value is CodeGraphWorkerEagerSeedRequest {
  return (
    isRecord(value) &&
    value.operation === 'eager-seed' &&
    typeof value.targetDbPath === 'string' &&
    Array.isArray(value.repositories) &&
    isRecord(value.source) &&
    (value.source.kind === 'base-worktree' ||
      value.source.kind === 'workspace-shadow')
  );
}

/**
 * The worktree graph a request writes, which its host holds the writer lease
 * for. Base finalization writes a private staging database and takes none.
 */
function worktreeGraphWrittenBy(payload: unknown): string | undefined {
  if (isWorkerEagerSeedRequest(payload)) return payload.targetDbPath;
  if (isWorkerSummaryRepairRequest(payload)) return payload.dbPath;
  if (isWorkerBuildRequest(payload) && payload.baseFinalization === undefined)
    return payload.dbPath;
  return undefined;
}

/**
 * Fingerprints the worktree again after its build published and stores the
 * fingerprint when it still equals the one observed before the build. The
 * caller holds the graph's writer lease.
 */
export async function persistEndOfBuildFingerprint(input: {
  dbPath: string;
  repositories: CodeGraphWorkerBuildRequest['repositories'];
  start: string;
  gitExecutable: string;
}): Promise<CodeGraphWorkerFingerprintPersist> {
  const startedAt = performance.now();
  let end: string;
  try {
    end = await fingerprintCodeGraphWorktree(
      input.repositories,
      input.gitExecutable,
    );
  } catch {
    return { outcome: 'error' };
  }
  const persistStartedAt = performance.now();
  const endFingerprintMs = persistStartedAt - startedAt;
  if (end !== input.start) return { outcome: 'unstable', endFingerprintMs };
  let db: CodeGraphDatabase | undefined;
  try {
    // Opening a missing path would create an empty database.
    if (!existsSync(input.dbPath))
      return { outcome: 'error', endFingerprintMs };
    db = openCodeGraphDatabase(input.dbPath);
    const writer = db;
    withImmediateTransaction(writer, () =>
      setMetadataValue(writer, 'worktree_fingerprint', end),
    );
    try {
      // As at the engine's close: a kept reader would otherwise leave this
      // write in the WAL after the build host exits.
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // SQLite checkpoints later; the fingerprint is already committed.
    }
    return {
      outcome: 'persisted',
      endFingerprintMs,
      persistMs: performance.now() - persistStartedAt,
    };
  } catch {
    return {
      outcome: 'error',
      endFingerprintMs,
      persistMs: performance.now() - persistStartedAt,
    };
  } finally {
    try {
      db?.close();
    } catch {
      // The outcome is already decided.
    }
  }
}

async function respondOnce(
  channel: CodeGraphHostChannel,
  payload: unknown,
  facts: CodeGraphBuildHostFacts,
): Promise<void> {
  const cpuProfiler = isWorkerBuildRequest(payload)
    ? await startCodeGraphWorkerCpuProfiler(facts.cpuProfileDirectory)
    : undefined;
  let lease: CodeGraphWriterLease | undefined;
  try {
    const writtenGraph = worktreeGraphWrittenBy(payload);
    if (writtenGraph !== undefined) {
      try {
        // Another process (the CLI) may be writing this graph; wait for it.
        // The launcher's timeout and cancel still end a host that waits.
        lease = await acquireCodeGraphWriterLease(writtenGraph);
      } catch (error) {
        channel.postMessage({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          ...failureDetail(error),
        });
        return;
      }
    }
    if (isWorkerEagerSeedRequest(payload)) {
      channel.postMessage(await executeCodeGraphEagerSeed(payload, facts));
    } else if (isWorkerSummaryRepairRequest(payload)) {
      channel.postMessage(await executeCodeGraphSummaryRepair(payload));
    } else if (isWorkerBuildRequest(payload)) {
      const response = await executeCodeGraphBuild(payload, {
        allowDeferredDerived: true,
        openFilesBlockReplacement: facts.openFilesBlockReplacement,
        flushRequiresWriteHandle: facts.flushRequiresWriteHandle,
      });
      if (
        response.ok &&
        payload.fingerprint !== undefined &&
        payload.baseFinalization === undefined
      ) {
        response.fingerprint = await persistEndOfBuildFingerprint({
          dbPath: payload.dbPath,
          repositories: payload.repositories,
          start: payload.fingerprint.start,
          gitExecutable: facts.gitExecutable,
        });
      }
      // The caller is answered as soon as the graph is published.
      channel.postMessage(response);
      if (response.ok && response.derivedPending === true) {
        channel.postMessage(
          await executeDeferredCodeGraphDerived({ dbPath: payload.dbPath }),
        );
      }
    } else {
      channel.postMessage({
        ok: false,
        message: 'Malformed code-graph worker request.',
      });
    }
  } finally {
    lease?.release();
    await cpuProfiler?.stop().catch(() => undefined);
    // One response per launch (plus the derived completion after a
    // `derivedPending` response), then exit; the runner treats this exit as
    // the normal completion path.
    channel.exit(0);
  }
}

/**
 * Serves one build host request on `channel`: a build, an eager seed or a
 * summary repair. A host entry calls it once, after installing the bundled
 * resources its process resolves.
 */
export function serveCodeGraphBuildHost(
  channel: CodeGraphHostChannel,
  facts: CodeGraphBuildHostFacts,
): void {
  channel.once('message', (event: unknown): void => {
    const payload = isRecord(event) ? event.data : undefined;
    void respondOnce(channel, payload, facts);
  });
}
