import type { CodeGraphBuildOptions } from '../../types/code-graph';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { CodeGraphEngine } from '@canopy/code-graph/engine';
import {
  ensureCodeGraphDatabaseCurrent,
  withCodeGraphWriterLease,
  type AcquireCodeGraphWriterLeaseOptions,
} from '@canopy/code-graph/store/writer-lease';
import type {
  CodeGraphBuildResult,
  CodeGraphRepositoryInput,
  CodeGraphStatus,
} from '../../types/code-graph';
import {
  getWorktreeCodeGraphDbPath,
  getWorktreeCodeGraphDir,
} from './worktree-paths';

let writeAdmission: (() => void) | undefined;

/**
 * Sets this process's admission for the graph writes the service makes
 * (CAN-6985): builds, and the create, convert or migrate before a read. It
 * runs before the writer lease is taken, and a throw refuses the write. The
 * CLI sets it; Electron main writes worktree graphs only in utility
 * processes, which its build scheduler admits.
 */
export function setCodeGraphWorktreeWriteAdmission(
  admit: (() => void) | undefined,
): void {
  writeAdmission = admit;
}

function admitted(
  lease: AcquireCodeGraphWriterLeaseOptions | undefined,
): AcquireCodeGraphWriterLeaseOptions | undefined {
  return writeAdmission === undefined
    ? lease
    : { ...lease, admit: writeAdmission };
}

export interface CodeGraphWorktreeDescriptor {
  workspaceId: string;
  worktreeId: string;
  repositories: readonly CodeGraphRepositoryInput[];
  resourcesDir?: string;
  // Root of the worktree checkout — enables the per-build custom language
  // config lookup (`.canopy/code-graph/languages.json`, Phase 6 Task 8).
  // Optional for the same reason `repositories` changes are not reconciled
  // here: the engine is cached per key, and whichever caller opens it first
  // fixes the value until `closeWorktree`.
  worktreeRootPath?: string;
}

function keyFor(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}/${worktreeId}`;
}

function fileIdentity(filePath: string): string | undefined {
  try {
    const stats = statSync(filePath, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * Per-worktree owner of {@link CodeGraphEngine} instances.
 *
 * `CodeGraphEngine.open()` runs a best-effort `git rev-parse` per repository
 * plus a full migration pass — cheap, but not free, so open engines are
 * cached (keyed `${workspaceId}/${worktreeId}`) as a `Promise<CodeGraphEngine>`:
 * concurrent `getEngine` calls for the same worktree share one open, and a
 * rejected open is evicted from the cache so the next call retries instead of
 * replaying the same failure forever.
 *
 * `buildOrUpdate` chains onto a per-key promise queue so two callers never run
 * `engine.buildOrUpdate()` concurrently against the same sqlite database
 * (Phase 1's engine has no reentrancy guard of its own) — including across a
 * close: builds issued while a close is in flight seed their fresh queue
 * chained *behind* that close, so they run strictly after it completes. The
 * queue tail is normalized to always resolve — a failed build is reported to
 * its own caller but never poisons the queue for subsequent callers on the
 * same key.
 *
 * Writes hold the graph's cross-process writer lease (CAN-5084): a build holds
 * it for the whole build, and an open for reads takes it only when opening
 * would create, convert or migrate the database. Another process that owns
 * the graph (the desktop build host) therefore never writes it at the same
 * time.
 *
 * Close guarantee: when `closeWorktree`/`closeAll` resolves, every engine this
 * service opened for the key up to that point has been closed — the close
 * evicts both map entries synchronously, drains the old queue tail, and then
 * closes both the originally cached engine and any engine that old-queue work
 * re-cached while draining. An in-flight close is tracked in `closing`;
 * `getEngine` waits for it before touching the cache and `buildOrUpdate`
 * queues behind it, so work issued mid-close can only reopen after the close
 * completes (such post-close reopens are new work and stay open). Old-queue
 * build bodies intentionally use the close-gate-free {@link getEngineInternal}
 * — the close awaits them, so gating them on the close would deadlock.
 *
 * Descriptor `repositories` may legitimately change between calls (e.g. a repo
 * added to a multi-repo workspace); `getEngine` intentionally keeps serving
 * the cached engine in that case. Picking up a changed repository set
 * requires the caller to `closeWorktree` first so the next `getEngine` reopens
 * with the new descriptor — that reconciliation is not solved here.
 */
export class CodeGraphWorktreeService {
  private readonly engines = new Map<string, Promise<CodeGraphEngine>>();
  private readonly buildQueues = new Map<string, Promise<void>>();
  private readonly closing = new Map<string, Promise<void>>();
  /** The `dev:ino` of the database file each engine opened. */
  private readonly engineFiles = new WeakMap<CodeGraphEngine, string>();

  public hasGraph(workspaceId: string, worktreeId: string): boolean {
    return existsSync(getWorktreeCodeGraphDbPath(workspaceId, worktreeId));
  }

  public async getEngine(
    descriptor: CodeGraphWorktreeDescriptor,
  ): Promise<CodeGraphEngine> {
    const key = keyFor(descriptor.workspaceId, descriptor.worktreeId);
    // Bring the schema current before any engine is cached, so a cached open
    // never waits for the writer lease a build may already hold. It runs
    // before the close gate below, so a close that starts while it waits
    // still holds this open back.
    await ensureCodeGraphDatabaseCurrent(
      getWorktreeCodeGraphDbPath(descriptor.workspaceId, descriptor.worktreeId),
      admitted(undefined),
    );
    // Work issued while a close is in flight must run strictly after that
    // close completes, so it never adopts an engine the close is about to
    // shut down. Loop: a further close may have been chained while awaiting.
    let inFlightClose = this.closing.get(key);
    while (inFlightClose !== undefined) {
      await inFlightClose;
      const next = this.closing.get(key);
      inFlightClose = next === inFlightClose ? undefined : next;
    }
    return this.getEngineInternal(descriptor);
  }

  /**
   * Runs a build/update IN-PROCESS, on whichever thread/process calls it.
   * Desktop-main (Electron) callers must NOT call this directly: a real
   * build can take minutes on a large repo, and running it here blocks the
   * Electron main thread for the whole duration. Desktop-main call sites
   * (the `BuildOrUpdateCodeGraph` tool, the background build scheduler)
   * must instead route through `runCodeGraphWorkerBuild` in
   * `apps/desktop-app/src/main/code-graph/build-runner.ts`, which forks a
   * `utilityProcess` and runs the equivalent build off the main thread. This
   * method remains the correct, intentional entry point for the desktop CLI
   * (no Electron main thread to protect) and is exercised directly by tests
   * that want an in-process build without spawning a worker.
   */
  public async buildOrUpdate(
    descriptor: CodeGraphWorktreeDescriptor,
    options?: CodeGraphBuildOptions,
    lease?: AcquireCodeGraphWriterLeaseOptions,
  ): Promise<CodeGraphBuildResult> {
    const key = keyFor(descriptor.workspaceId, descriptor.worktreeId);
    // Seed a fresh queue behind any in-flight close: a build issued mid-close
    // must run strictly after the close completes, never concurrently with
    // old-queue builds the close is still draining.
    const inFlightClose = this.closing.get(key);
    const previousTail =
      this.buildQueues.get(key) ?? inFlightClose ?? Promise.resolve();
    const run = previousTail
      .catch(() => undefined)
      .then(async () => {
        // Close-gate-free on purpose: builds already chained on the old queue
        // are drained BY the close, so gating them on it would deadlock. The
        // queue position (old tail vs. chained behind `closing`) already
        // encodes the correct ordering relative to any close.
        return withCodeGraphWriterLease(
          getWorktreeCodeGraphDbPath(
            descriptor.workspaceId,
            descriptor.worktreeId,
          ),
          async () => {
            const engine = await this.getEngineForWrite(descriptor);
            return options === undefined
              ? engine.buildOrUpdate()
              : engine.buildOrUpdate(options);
          },
          admitted(lease),
        );
      });
    // The stored tail must never reject, or every later caller on this key
    // would inherit this build's failure instead of getting a fresh attempt.
    this.buildQueues.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  public async getStatus(
    descriptor: CodeGraphWorktreeDescriptor,
  ): Promise<CodeGraphStatus | null> {
    if (!this.hasGraph(descriptor.workspaceId, descriptor.worktreeId)) {
      return null;
    }
    const engine = await this.getEngine(descriptor);
    return engine.getStatus();
  }

  public async closeWorktree(
    workspaceId: string,
    worktreeId: string,
  ): Promise<void> {
    await this.closeByKey(keyFor(workspaceId, worktreeId));
  }

  /**
   * Closes the cached reader and prevents a new one from opening while an
   * external operation replaces the worktree database. The replacement runs
   * under the same close gate used by getEngine/buildOrUpdate, so readers can
   * only reopen after the new database is fully installed.
   */
  public async withWorktreeClosed<T>(
    workspaceId: string,
    worktreeId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runWhileClosed(keyFor(workspaceId, worktreeId), operation);
  }

  public async closeAll(): Promise<void> {
    const keys = new Set<string>([
      ...Array.from(this.engines.keys()),
      ...Array.from(this.buildQueues.keys()),
      ...Array.from(this.closing.keys()),
    ]);
    // allSettled (not Promise.all) so one key's close failure never abandons
    // the others' close work — every engine's fds still get released — then
    // rethrow the first failure so the caller still learns something broke.
    const results = await Promise.allSettled(
      Array.from(keys, (key) => this.closeByKey(key)),
    );
    const firstRejection = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstRejection !== undefined) {
      throw firstRejection.reason instanceof Error
        ? firstRejection.reason
        : new Error(String(firstRejection.reason));
    }
  }

  // Cache check + open, with no close-gate. Callers must either be gated on
  // any in-flight close already (public getEngine) or be positioned in the
  // build queue such that ordering relative to a close is guaranteed
  // (buildOrUpdate bodies).
  private async getEngineInternal(
    descriptor: CodeGraphWorktreeDescriptor,
  ): Promise<CodeGraphEngine> {
    const key = keyFor(descriptor.workspaceId, descriptor.worktreeId);
    const cached = this.engines.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const opening = this.openEngine(descriptor);
    this.engines.set(key, opening);
    try {
      return await opening;
    } catch (error) {
      // A failed open must not poison the cache forever; evict so the next
      // call retries. Only remove our own promise — a concurrent
      // closeWorktree/reopen may have already replaced the cache entry.
      if (this.engines.get(key) === opening) {
        this.engines.delete(key);
      }
      throw error;
    }
  }

  /**
   * The engine a build writes through, opened while the caller holds the
   * writer lease. Another writer may have installed a new database while the
   * build waited for the lease (a seed replaces an incomplete graph), so an
   * engine still on the replaced file is closed and reopened: its WAL frames
   * belong to the old database.
   */
  private async getEngineForWrite(
    descriptor: CodeGraphWorktreeDescriptor,
  ): Promise<CodeGraphEngine> {
    const key = keyFor(descriptor.workspaceId, descriptor.worktreeId);
    const cached = this.engines.get(key);
    const engine = await this.getEngineInternal(descriptor);
    if (
      this.engineFiles.get(engine) ===
      fileIdentity(
        getWorktreeCodeGraphDbPath(
          descriptor.workspaceId,
          descriptor.worktreeId,
        ),
      )
    )
      return engine;
    if (this.engines.get(key) === cached) this.engines.delete(key);
    engine.close();
    return this.getEngineInternal(descriptor);
  }

  private async openEngine(
    descriptor: CodeGraphWorktreeDescriptor,
  ): Promise<CodeGraphEngine> {
    const dir = getWorktreeCodeGraphDir(
      descriptor.workspaceId,
      descriptor.worktreeId,
    );
    // Belt-and-suspenders: CodeGraphEngine.open() also mkdirs the dbPath's
    // parent, but creating it up front keeps this service's directory
    // contract explicit and harmless to repeat.
    mkdirSync(dir, { recursive: true });
    const dbPath = getWorktreeCodeGraphDbPath(
      descriptor.workspaceId,
      descriptor.worktreeId,
    );
    // Readers brought the schema current in getEngine; a build holds the
    // writer lease, so any migration this open runs is its own write.
    const engine = await CodeGraphEngine.open({
      dbPath,
      repositories: descriptor.repositories,
      resourcesDir: descriptor.resourcesDir,
      worktreeRootPath: descriptor.worktreeRootPath,
    });
    const identity = fileIdentity(dbPath);
    if (identity !== undefined) this.engineFiles.set(engine, identity);
    return engine;
  }

  private closeByKey(key: string): Promise<void> {
    return this.runWhileClosed(key, () => Promise.resolve());
  }

  private runWhileClosed<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    // Chain behind any in-flight close for this key so overlapping closes
    // also cover engines opened by builds that were gated on the earlier
    // close. With no in-flight close, performClose is invoked directly so its
    // capture-and-evict prefix runs synchronously within this call.
    const previousClose = this.closing.get(key);
    const closed =
      previousClose === undefined
        ? this.performClose(key)
        : previousClose.then(() => this.performClose(key));
    const run = closed.then(operation);
    // The registered marker must never reject (getEngine/buildOrUpdate await
    // it); the caller still sees performClose failures through `run`.
    const marker = run.then(
      () => undefined,
      () => undefined,
    );
    this.closing.set(key, marker);
    void marker.then(() => {
      if (this.closing.get(key) === marker) {
        this.closing.delete(key);
      }
    });
    return run;
  }

  private async performClose(key: string): Promise<void> {
    // Capture, then evict BOTH map entries synchronously before awaiting
    // anything. A buildOrUpdate issued after this point finds no queue and
    // seeds its fresh queue behind `closing`, and public getEngine waits for
    // `closing`, so no new work can adopt an engine this close will shut down.
    const pendingBuild = this.buildQueues.get(key);
    const enginePromise = this.engines.get(key);
    this.buildQueues.delete(key);
    this.engines.delete(key);

    if (pendingBuild !== undefined) {
      // The stored tail never rejects (see buildOrUpdate), so this always
      // resolves once every build already chained for this key settles.
      await pendingBuild;
    }

    // A build already chained on the old queue may have re-opened and
    // re-cached an engine while the tail drained (its body bypasses the
    // close-gate). Work issued mid-close cannot have — it is queued behind
    // this close — so any cache entry present now belongs to old-queue work.
    // Sweep it too: nothing this service opened for the key survives.
    const reopened = this.engines.get(key);
    if (reopened !== undefined) {
      this.engines.delete(key);
    }

    // Close BOTH captured engines even if the first close throws — otherwise a
    // throwing `enginePromise` close would leak the reopened engine's open fds.
    // Collect any errors, then rethrow the first so the failure still surfaces.
    const firstError = await this.closeEngineCollectingError(enginePromise);
    const secondError = await this.closeEngineCollectingError(reopened);
    const failure = firstError ?? secondError;
    if (failure !== undefined) {
      throw failure;
    }
  }

  private async closeEngineCollectingError(
    enginePromise: Promise<CodeGraphEngine> | undefined,
  ): Promise<Error | undefined> {
    if (enginePromise === undefined) {
      return undefined;
    }
    let engine: CodeGraphEngine;
    try {
      engine = await enginePromise;
    } catch {
      // The open itself failed; there is nothing open to close.
      return undefined;
    }
    try {
      engine.close();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}

let instance: CodeGraphWorktreeService | null = null;

export function getCodeGraphWorktreeService(): CodeGraphWorktreeService {
  if (instance === null) {
    instance = new CodeGraphWorktreeService();
  }
  return instance;
}

/**
 * Test-only reset: closes every engine held by the current singleton (so temp
 * data dirs can be removed immediately afterwards) and then drops the
 * singleton so the next {@link getCodeGraphWorktreeService} call constructs a
 * fresh instance. Await it in test teardown before removing fixture dirs.
 */
export async function resetCodeGraphWorktreeServiceForTests(): Promise<void> {
  const current = instance;
  instance = null;
  if (current !== null) {
    await current.closeAll();
  }
}
