import type {
  LocalMemoryRebuildResult,
  LocalMemoryScopeRequest,
  LocalMemorySnapshotRestoreResponse,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  BACKGROUND_HELPER_PRIORITIES,
  enqueueBackgroundHelperTask,
} from '../../lib/background-helper-queue';
import { logMainProcessWarn } from '../../lib/main-process-logging';
import { readPreferencesFile } from '../../lib/preferences-store';
import { broadcastLocalMemoryChanged } from './change-events';
import { LOCAL_MEMORY_SYNCED_REBUILD_MESSAGE } from '@canopy/protocol/local-memory';
import { localMemoryScopeDir } from './scope-resolver';
import {
  assertReplicaStillSyncing,
  isSyncedMemoryReplica,
  LocalMemoryReplicaUnavailableError,
  localMemoryReplicaHooks,
} from './replica-hooks';
import {
  beginLocalMemoryConsolidationRun,
  endLocalMemoryConsolidationRun,
} from './consolidation-run-tracker';
import {
  consolidationRunOutcome,
  recordConsolidationRun,
  type ConsolidationRunOutcome,
} from './consolidation-state';
import type {
  RunConsolidationOptions,
  RunConsolidationResult,
} from './consolidation-task';
import {
  LocalMemoryPreconditionError,
  recordMemoryEdit,
  withMemoryWriteLock,
} from './edit-coordination';
import {
  resolveLocalMemoryRunModel,
  type LocalMemoryHelperModel,
} from './helper-model';
import {
  clearConsolidatedMemory,
  consolidatedMemoryClearedState,
  consolidatedSourcesFullyRestored,
  drainConsolidation,
  planConsolidatedSourceRestore,
  REBUILD_IMPORTS_NOT_RESTAGED_REASON,
  REBUILD_SOURCES_NOT_RESTORED_REASON,
  REBUILD_SOURCES_UNREADABLE_REASON,
  restoreConsolidatedSources,
  SourceRestoreError,
  stageImportOriginalsAgain,
  trackRebuildSources,
  type ImportRestorePlan,
  type RebuildSourceTracker,
  type RestoredSourcesHandle,
  type StagedImportOriginals,
} from './rebuild';
import {
  isLocalMemorySnapshotId,
  LocalMemoryScopeChangedError,
  localMemorySnapshotHoldsState,
  readLocalMemoryState,
  restoreLocalMemorySnapshot,
  runVerifiedLocalMemoryWrite,
  saveLocalMemorySnapshot,
  writeLocalMemoryStateExactly,
  type LocalMemoryState,
} from './snapshots';

// Rebuild failures after the source checks, shown after "Couldn't finish
// rebuilding memories: " (docs/ux-writing.md).
const REBUILD_SNAPSHOT_FAILED_REASON =
  "the snapshot of current memories couldn't be saved, so nothing was changed";
const REBUILD_SNAPSHOT_UNVERIFIED_REASON =
  "the snapshot of current memories couldn't be checked, so nothing was changed";
const REBUILD_SOURCES_LEFT_PENDING_REASON =
  "some saved notes or imports couldn't be put back in their archive; memories weren't changed, and those sources will be consolidated again";
const REBUILD_CLEAR_ROLLED_BACK_REASON =
  "current memories couldn't be cleared, so they were put back as they were";
const REBUILD_CLEAR_NOT_ROLLED_BACK_REASON =
  "current memories couldn't be cleared; restore the snapshot saved before the rebuild to get them back";
const REBUILD_CLEAR_LEFT_AS_IS_REASON =
  "current memories couldn't be cleared and changed meanwhile, so they were left as they are";
const REBUILD_MEMORY_CHANGED_REASON =
  'memories changed while the rebuild was getting ready, so nothing was changed';
const REBUILD_IMPORTS_UNUSABLE_REASON =
  "some imports couldn't be read back, so they weren't rebuilt";

/**
 * Everything a rebuild needs, resolved and verified before anything
 * destructive runs: the memory model may run and the organization allows
 * it, every staged and archived import maps to the ledger, imports with only
 * their original left are staged again, and the index and topics are read
 * once and saved as a snapshot that reads back byte for byte the same.
 */
interface RebuildPlan {
  ok: true;
  /** Null when the scope holds no index and no topic. */
  snapshotId: string | null;
  /**
   * The index and topics the snapshot holds, read once; empty is
   * `{ memoryMd: null, topicFiles: [] }`. The clear runs only while the
   * scope is still exactly this, and a failed clear writes it back.
   */
  prior: LocalMemoryState;
  sources: ImportRestorePlan;
  /** Imports the plan staged again from their originals, if any. */
  restaged: StagedImportOriginals | null;
}

/** Why a rebuild refused. Memory is as it was before the rebuild. */
interface RebuildRefusal {
  ok: false;
  status: 'skipped' | 'failed';
  reason: string;
  snapshotId: string | null;
}

type RebuildExecution =
  | {
      ok: true;
      restored: RestoredSourcesHandle;
      tracker: RebuildSourceTracker;
    }
  | { ok: false; reason: string };

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeWorkspaceId(
  request: LocalMemoryScopeRequest,
): string | undefined {
  return request.scope === 'workspace' ? request.workspaceId : undefined;
}

/**
 * The model a manual run or rebuild uses, or the outcome recorded when it
 * cannot run: memory is off, or {@link resolveLocalMemoryRunModel} refuses
 * (the chosen model is unavailable, or the organization policy blocks it
 * for the scope).
 */
async function resolveManualRunModel(
  preferences: PreferencesData,
  request: LocalMemoryScopeRequest,
): Promise<
  { helperModel: LocalMemoryHelperModel } | { refusal: ConsolidationRunOutcome }
> {
  if (!preferences.localMemoryEnabled) {
    return { refusal: { result: 'skipped', reason: 'local-memory-disabled' } };
  }
  return resolveLocalMemoryRunModel(preferences, scopeWorkspaceId(request));
}

/**
 * The model for a run that is about to start, from the preferences saved now.
 * A run waits in the background helper queue, and the user can choose another
 * memory model or turn memory off meanwhile; resolving here keeps saved
 * memory from going to a model the user has since replaced.
 */
async function resolveQueuedRunModel(
  request: LocalMemoryScopeRequest,
): Promise<
  { helperModel: LocalMemoryHelperModel } | { refusal: ConsolidationRunOutcome }
> {
  let preferences: PreferencesData;
  try {
    preferences = await readPreferencesFile();
  } catch (error) {
    return { refusal: { result: 'failed', reason: failureReason(error) } };
  }
  return resolveManualRunModel(preferences, request);
}

/**
 * Phase one of a rebuild, under the scope's write lock: resolves and
 * verifies everything the rebuild needs, and changes no memory. Staging an
 * import again from its original only adds a pending source, and any later
 * refusal in this phase takes it back out. Returns the verified plan, or a
 * refusal with the reason to show.
 */
async function planRebuild(
  request: LocalMemoryScopeRequest,
  scopeDir: string,
): Promise<RebuildPlan | RebuildRefusal> {
  const refuse = (
    reason: string,
    snapshotId: string | null = null,
    status: RebuildRefusal['status'] = 'failed',
  ): RebuildRefusal => ({ ok: false, status, reason, snapshotId });

  let preferences: PreferencesData;
  try {
    preferences = await readPreferencesFile();
  } catch (error) {
    return refuse(failureReason(error));
  }
  const run = await resolveManualRunModel(preferences, request);
  if ('refusal' in run) {
    return refuse(
      run.refusal.reason ?? run.refusal.result,
      null,
      run.refusal.result === 'skipped' ? 'skipped' : 'failed',
    );
  }

  const planSources = async (): Promise<
    Awaited<ReturnType<typeof planConsolidatedSourceRestore>>
  > => {
    try {
      return await planConsolidatedSourceRestore(scopeDir);
    } catch (error) {
      logMainProcessWarn('Local memory rebuild could not read its sources', {
        scopeDir,
        error: failureReason(error),
      });
      return { ok: false, reason: REBUILD_SOURCES_UNREADABLE_REASON };
    }
  };
  let sources = await planSources();
  if (!sources.ok) return refuse(sources.reason);

  let restaged: StagedImportOriginals | null = null;
  // Takes back what this plan staged; a staged copy that cannot be removed
  // stays pending and is consolidated again, so the reason says so.
  const abandon = async (
    reason: string,
    snapshotId: string | null = null,
  ): Promise<RebuildRefusal> =>
    refuse(
      restaged === null || (await restaged.undo())
        ? reason
        : REBUILD_SOURCES_LEFT_PENDING_REASON,
      snapshotId,
    );
  if (sources.imports.restages.length > 0) {
    try {
      restaged = await stageImportOriginalsAgain(
        scopeDir,
        request,
        sources.imports.restages,
      );
    } catch (error) {
      logMainProcessWarn('Local memory rebuild could not stage imports', {
        scopeDir,
        error: failureReason(error),
      });
      return refuse(
        error instanceof SourceRestoreError
          ? error.undone
            ? (error.reason ?? REBUILD_IMPORTS_NOT_RESTAGED_REASON)
            : REBUILD_SOURCES_LEFT_PENDING_REASON
          : REBUILD_IMPORTS_NOT_RESTAGED_REASON,
      );
    }
    // Plan again from the ledger as it is now: every restaged import must
    // read back as an ordinary pending import.
    sources = await planSources();
    if (!sources.ok) return abandon(sources.reason);
    if (sources.imports.restages.length > 0) {
      return abandon(REBUILD_IMPORTS_NOT_RESTAGED_REASON);
    }
  }

  let prior: LocalMemoryState;
  let snapshotId: string | null;
  try {
    // Read once: the snapshot saves this state, the clear checks the scope
    // against it, and a failed clear writes it back, empty or not.
    prior = await readLocalMemoryState(scopeDir);
    snapshotId =
      (await saveLocalMemorySnapshot(scopeDir, prior, 'rebuild'))?.id ?? null;
  } catch (error) {
    logMainProcessWarn('Local memory rebuild could not save a snapshot', {
      scopeDir,
      error: failureReason(error),
    });
    return abandon(REBUILD_SNAPSHOT_FAILED_REASON);
  }
  if (
    snapshotId !== null &&
    !(await localMemorySnapshotHoldsState(scopeDir, snapshotId, prior))
  ) {
    return abandon(REBUILD_SNAPSHOT_UNVERIFIED_REASON, snapshotId);
  }
  return { ok: true, snapshotId, prior, sources: sources.imports, restaged };
}

/**
 * Phase two of a rebuild, under the same write lock hold as its plan: runs
 * only a verified plan. Sources go back to the pending queue and are checked
 * before the index and topics are cleared. The clear runs only while the
 * scope is still exactly the plan's snapshotted state; when it changed, the
 * rebuild stops and puts sources and restaged imports back with memory
 * untouched. A failure up to and including the clear puts sources, restaged
 * imports, and memory back. Every source the drain must consume is tracked
 * from here on (see {@link trackRebuildSources}).
 */
async function executeRebuildPlan(
  scopeDir: string,
  plan: RebuildPlan,
): Promise<RebuildExecution> {
  const undoRestaged = async (): Promise<boolean> =>
    plan.restaged === null ? true : plan.restaged.undo();

  let restored: RestoredSourcesHandle;
  try {
    // Undoes its own moves when it fails part way.
    restored = await restoreConsolidatedSources(scopeDir, plan.sources);
  } catch (error) {
    logMainProcessWarn('Local memory rebuild could not restore its sources', {
      scopeDir,
      error: failureReason(error),
    });
    const restagedUndone = await undoRestaged();
    const sourcesUndone = !(
      error instanceof SourceRestoreError && !error.undone
    );
    return {
      ok: false,
      reason:
        sourcesUndone && restagedUndone
          ? REBUILD_SOURCES_NOT_RESTORED_REASON
          : REBUILD_SOURCES_LEFT_PENDING_REASON,
    };
  }
  const undoSources = async (): Promise<boolean> => {
    // Sources first: their undo writes back the ledger the plan saw, and the
    // restaged imports' undo then writes back the one before them.
    const sourcesUndone = await restored.undo();
    return (await undoRestaged()) && sourcesUndone;
  };

  let complete = false;
  try {
    complete = await consolidatedSourcesFullyRestored(scopeDir, restored);
  } catch (error) {
    logMainProcessWarn('Local memory rebuild could not check its sources', {
      scopeDir,
      error: failureReason(error),
    });
  }
  if (!complete) {
    return {
      ok: false,
      reason: (await undoSources())
        ? REBUILD_SOURCES_NOT_RESTORED_REASON
        : REBUILD_SOURCES_LEFT_PENDING_REASON,
    };
  }

  // Every import the drain must consume: those already staged when the
  // rebuild was planned as well as those it restored or staged again.
  // Tracked before the clear, so a rebuild never clears memory it cannot
  // then account for.
  let tracker: RebuildSourceTracker;
  try {
    tracker = await trackRebuildSources(scopeDir, [
      ...plan.sources.staged,
      ...restored.restoredImports,
      ...(plan.restaged?.stagedImports ?? []),
    ]);
  } catch (error) {
    logMainProcessWarn('Local memory rebuild could not track its sources', {
      scopeDir,
      error: failureReason(error),
    });
    return {
      ok: false,
      reason: (await undoSources())
        ? REBUILD_SOURCES_NOT_RESTORED_REASON
        : REBUILD_SOURCES_LEFT_PENDING_REASON,
    };
  }

  try {
    await runVerifiedLocalMemoryWrite(scopeDir, [plan.prior], (guard) =>
      clearConsolidatedMemory(scopeDir, guard),
    );
  } catch (error) {
    if (error instanceof LocalMemoryScopeChangedError && !error.changedMemory) {
      // Nothing was cleared: memory is whatever changed it, and the rebuild
      // takes back its own steps.
      logMainProcessWarn('Local memory rebuild stopped: memory changed', {
        scopeDir,
      });
      return {
        ok: false,
        reason: (await undoSources())
          ? REBUILD_MEMORY_CHANGED_REASON
          : REBUILD_SOURCES_LEFT_PENDING_REASON,
      };
    }
    logMainProcessWarn('Local memory rebuild could not clear memory', {
      scopeDir,
      error: failureReason(error),
    });
    // The clear started from exactly the plan's state, so writing it back
    // undoes the clear, but only while every file still holds its state
    // before or after the clear.
    let rollback: 'rolled-back' | 'changed' | 'failed' = 'rolled-back';
    try {
      await runVerifiedLocalMemoryWrite(
        scopeDir,
        [plan.prior, consolidatedMemoryClearedState(plan.prior)],
        (guard) => writeLocalMemoryStateExactly(scopeDir, plan.prior, guard),
      );
    } catch (rollbackError) {
      rollback =
        rollbackError instanceof LocalMemoryScopeChangedError
          ? 'changed'
          : 'failed';
    }
    // Same rule as a refusal before the clear: sources that could not go
    // back to their archive will be consolidated again, so say so.
    const sourcesUndone = await undoSources();
    return {
      ok: false,
      reason:
        rollback === 'rolled-back'
          ? sourcesUndone
            ? REBUILD_CLEAR_ROLLED_BACK_REASON
            : REBUILD_SOURCES_LEFT_PENDING_REASON
          : rollback === 'changed' && plan.snapshotId === null
            ? REBUILD_CLEAR_LEFT_AS_IS_REASON
            : REBUILD_CLEAR_NOT_ROLLED_BACK_REASON,
    };
  }
  return { ok: true, restored, tracker };
}

export interface ManualConsolidationOutcome {
  status: 'completed' | 'failed' | 'skipped';
  reason?: string;
  /** What this call recorded (or tried to record) for the scope. */
  outcome: ConsolidationRunOutcome;
  /** When the run finished; also the `at` used for the persisted record. */
  finishedAt: string;
  /**
   * False when nothing ran and nothing was recorded (another run owns the
   * scope, or preferences could not be read), so callers keep the stored
   * status as is.
   */
  recorded: boolean;
}

function scopeDirectory(request: LocalMemoryScopeRequest): string {
  return localMemoryScopeDir(request);
}

async function runConsolidationTask(
  request: LocalMemoryScopeRequest,
  scopeDir: string,
  helperModel: LocalMemoryHelperModel,
  overrides: Pick<
    RunConsolidationOptions,
    'snapshotBeforeWrite' | 'leaseReason'
  > = {},
): Promise<RunConsolidationResult> {
  // Keep the structured-helper/provider stack off Electron's startup import
  // path, matching consolidation-scheduler.ts: the task module is only
  // needed when a run actually fires; local dynamic imports are safe in
  // packaged main.
  const { runLocalMemoryConsolidation } = await import('./consolidation-task');
  return runLocalMemoryConsolidation({
    scopeDir,
    ...(request.scope === 'workspace'
      ? { workspaceId: request.workspaceId }
      : {}),
    ...helperModel,
    ...overrides,
  });
}

function manualOutcome(
  outcome: ConsolidationRunOutcome,
  finishedAt: string,
  recorded: boolean,
): ManualConsolidationOutcome {
  const status =
    outcome.result === 'success'
      ? 'completed'
      : outcome.result === 'failed'
        ? 'failed'
        : 'skipped';
  return {
    status,
    ...(status !== 'completed' && outcome.reason !== undefined
      ? { reason: outcome.reason }
      : {}),
    outcome,
    finishedAt,
    recorded,
  };
}

async function persistOutcome(
  scopeDir: string,
  outcome: ConsolidationRunOutcome,
  at: string,
): Promise<void> {
  try {
    await recordConsolidationRun(scopeDir, { ...outcome, at });
  } catch (error) {
    logMainProcessWarn('Local memory consolidation outcome was not saved', {
      scopeDir,
      error: failureReason(error),
    });
  }
}

/**
 * Runs consolidation for one scope right away (through the background
 * helper queue), records the outcome for the explorer status line, and
 * broadcasts a change event when the run starts and finishes. A scope that
 * is already running is left alone and reported as skipped: nothing is
 * recorded or broadcast, so the owning run's status stays as it saves it.
 */
export async function runManualLocalMemoryConsolidation(
  request: LocalMemoryScopeRequest,
): Promise<ManualConsolidationOutcome> {
  const scopeDir = scopeDirectory(request);
  // The scope is held before anything about this request is decided, so a
  // refusal below can never overwrite the status of a consolidation,
  // rebuild or restore that owns the scope.
  if (!beginLocalMemoryConsolidationRun(scopeDir)) {
    return manualOutcome(
      { result: 'skipped', reason: 'already-running' },
      new Date().toISOString(),
      false,
    );
  }
  // Every return before the run is queued releases the scope.
  let preferences: PreferencesData;
  try {
    preferences = await readPreferencesFile();
  } catch (error) {
    endLocalMemoryConsolidationRun(scopeDir);
    return manualOutcome(
      { result: 'failed', reason: failureReason(error) },
      new Date().toISOString(),
      false,
    );
  }
  // Checked before the run is queued, so a model that cannot run or that the
  // organization blocks is reported as skipped without waiting in the queue.
  let run: Awaited<ReturnType<typeof resolveManualRunModel>>;
  try {
    run = await resolveManualRunModel(preferences, request);
  } catch (error) {
    endLocalMemoryConsolidationRun(scopeDir);
    throw error;
  }
  if ('refusal' in run) {
    const finishedAt = new Date().toISOString();
    try {
      await persistOutcome(scopeDir, run.refusal, finishedAt);
    } finally {
      endLocalMemoryConsolidationRun(scopeDir);
    }
    broadcastLocalMemoryChanged(request);
    return manualOutcome(run.refusal, finishedAt, true);
  }
  broadcastLocalMemoryChanged(request);
  let outcome: ConsolidationRunOutcome;
  try {
    outcome = await enqueueBackgroundHelperTask({
      priority: BACKGROUND_HELPER_PRIORITIES.memoryConsolidation,
      task: async (): Promise<ConsolidationRunOutcome> => {
        const queued = await resolveQueuedRunModel(request);
        if ('refusal' in queued) return queued.refusal;
        return consolidationRunOutcome(
          await runConsolidationTask(request, scopeDir, queued.helperModel, {
            leaseReason: 'manual',
          }),
        );
      },
    });
  } catch (error) {
    outcome = { result: 'failed', reason: failureReason(error) };
  }
  const finishedAt = new Date().toISOString();
  try {
    await persistOutcome(scopeDir, outcome, finishedAt);
  } finally {
    endLocalMemoryConsolidationRun(scopeDir);
    broadcastLocalMemoryChanged(request);
  }
  return manualOutcome(outcome, finishedAt, true);
}

function rebuildResult(
  status: LocalMemoryRebuildResult['status'],
  reason: string | undefined,
  progress: Partial<Omit<LocalMemoryRebuildResult, 'status' | 'reason'>> = {},
): LocalMemoryRebuildResult {
  return {
    status,
    ...(reason !== undefined ? { reason } : {}),
    snapshotId: progress.snapshotId ?? null,
    restoredInboxNotes: progress.restoredInboxNotes ?? 0,
    restoredImports: progress.restoredImports ?? 0,
    runs: progress.runs ?? 0,
  };
}

async function localMemoryStillEnabled(): Promise<boolean> {
  const preferences = await readPreferencesFile().catch(() => null);
  return preferences?.localMemoryEnabled === true;
}

/**
 * Rebuilds one scope from its sources in two phases, holding the scope for
 * the whole rebuild so neither the idle scheduler nor a manual run can
 * consolidate the half-restored state. {@link planRebuild} resolves and
 * verifies everything first and changes no memory; any refusal there
 * returns with memory as it was. {@link executeRebuildPlan} then runs only
 * that verified plan: archived inbox notes and imports go back to the
 * pending queue, and the consolidated index and topics are cleared (keeping
 * the chat history profile). Consolidation then runs until nothing is
 * pending. Each run resolves the model and policy again when its queued
 * slot starts, so a model chosen meanwhile is used, and a model that can no
 * longer run, or that the organization now blocks, stops the rebuild
 * instead of being replaced.
 */
export async function runManualLocalMemoryRebuild(
  request: LocalMemoryScopeRequest,
  precondition?: () => Promise<void>,
): Promise<LocalMemoryRebuildResult> {
  const scopeDir = scopeDirectory(request);
  if (await isSyncedMemoryReplica(scopeDir)) {
    return rebuildResult('skipped', LOCAL_MEMORY_SYNCED_REBUILD_MESSAGE);
  }
  if (!beginLocalMemoryConsolidationRun(scopeDir, 'rebuild')) {
    return rebuildResult('skipped', 'already-running');
  }
  broadcastLocalMemoryChanged(request);
  try {
    let prepared:
      | RebuildRefusal
      | {
          ok: true;
          plan: RebuildPlan;
          restored: RestoredSourcesHandle;
          tracker: RebuildSourceTracker;
        }
      | {
          ok: false;
          status: 'failed';
          reason: string;
          snapshotId: string | null;
        };
    try {
      prepared = await withMemoryWriteLock(scopeDir, async () => {
        await precondition?.();
        await recordMemoryEdit(scopeDir);
        const plan = await planRebuild(request, scopeDir);
        if (!plan.ok) return plan;
        const executed = await executeRebuildPlan(scopeDir, plan);
        return executed.ok
          ? {
              ok: true,
              plan,
              restored: executed.restored,
              tracker: executed.tracker,
            }
          : {
              ok: false,
              status: 'failed',
              reason: executed.reason,
              snapshotId: plan.snapshotId,
            };
      });
    } catch (error) {
      if (error instanceof LocalMemoryPreconditionError) throw error;
      return rebuildResult('failed', failureReason(error));
    }
    if (!prepared.ok) {
      return rebuildResult(prepared.status, prepared.reason, {
        snapshotId: prepared.snapshotId,
      });
    }
    const { plan, restored, tracker } = prepared;
    const restagedImports = plan.restaged?.stagedImports ?? [];
    broadcastLocalMemoryChanged(request);
    let unusableRebuildImports = 0;
    // Set when a queued run found it could not start; recorded in place of
    // the stand-in result the drain sees.
    let refusal: ConsolidationRunOutcome | null = null;
    const drained = await drainConsolidation({
      countPending: async () => {
        const pending = await tracker.count();
        if ('stop' in pending) return pending;
        unusableRebuildImports = pending.unusableRebuildImports;
        return pending.total;
      },
      mayContinue: localMemoryStillEnabled,
      stopReason: 'local-memory-disabled',
      runOnce: () =>
        enqueueBackgroundHelperTask({
          priority: BACKGROUND_HELPER_PRIORITIES.memoryConsolidation,
          task: async (): Promise<RunConsolidationResult> => {
            const queued = await resolveQueuedRunModel(request);
            if ('refusal' in queued) {
              refusal = queued.refusal;
              // Any status but success or clean stops the drain with this
              // reason.
              return { status: 'failed', reason: queued.refusal.reason };
            }
            return runConsolidationTask(request, scopeDir, queued.helperModel, {
              snapshotBeforeWrite: false,
            });
          },
        }),
      onRun: async (result) => {
        tracker.recordRun(result);
        const outcome = refusal ?? consolidationRunOutcome(result);
        refusal = null;
        await persistOutcome(scopeDir, outcome, new Date().toISOString());
        broadcastLocalMemoryChanged(request);
      },
    });
    // A run that cannot use the rebuild's imports reads as no progress or an
    // undrainable queue; name the cause instead.
    const reason =
      unusableRebuildImports > 0 &&
      (drained.reason === 'undrainable' || drained.reason === 'no-progress')
        ? REBUILD_IMPORTS_UNUSABLE_REASON
        : drained.reason;
    return rebuildResult(drained.status, reason, {
      snapshotId: plan.snapshotId,
      restoredInboxNotes: restored.inboxNotes,
      restoredImports: restored.imports + restagedImports.length,
      runs: drained.runs,
    });
  } finally {
    endLocalMemoryConsolidationRun(scopeDir);
    broadcastLocalMemoryChanged(request);
  }
}

/**
 * Replaces the scope's index and topics with a snapshot, after snapshotting
 * what it replaces. A scope that is consolidating or rebuilding is left
 * alone and reported as skipped.
 */
export async function restoreManualLocalMemorySnapshot(
  request: LocalMemoryScopeRequest,
  snapshotId: string,
  precondition?: () => Promise<void>,
): Promise<LocalMemorySnapshotRestoreResponse> {
  if (!isLocalMemorySnapshotId(snapshotId)) {
    throw new Error('Choose a memory snapshot.');
  }
  const scopeDir = scopeDirectory(request);
  const cancelled: LocalMemorySnapshotRestoreResponse = {
    status: 'skipped',
    reason: 'cancelled',
    previousSnapshotId: null,
  };
  // A synced replica's restore is a manual edit its engine commits, so a
  // replica no engine keeps now (signed out, another account) is left alone,
  // also when that changes while the restore waits for the lock.
  const target = {
    dir: scopeDir,
    accountId: localMemoryReplicaHooks()?.replicaAccountId(scopeDir) ?? null,
  };
  if (target.accountId === null && (await isSyncedMemoryReplica(scopeDir))) {
    return cancelled;
  }
  if (!beginLocalMemoryConsolidationRun(scopeDir, 'restore')) {
    return {
      status: 'skipped',
      reason: 'already-running',
      previousSnapshotId: null,
    };
  }
  try {
    let previousSnapshotId: string | null;
    try {
      ({ previousSnapshotId } = await restoreLocalMemorySnapshot(
        scopeDir,
        snapshotId,
        () => assertReplicaStillSyncing(target),
        precondition,
      ));
    } catch (error) {
      if (error instanceof LocalMemoryReplicaUnavailableError) return cancelled;
      throw error;
    }
    // In a synced replica the restored documents are a manual edit against
    // the base they were restored on (design §14.1).
    localMemoryReplicaHooks()?.noteChanged(scopeDir);
    return { status: 'restored', previousSnapshotId };
  } finally {
    endLocalMemoryConsolidationRun(scopeDir);
    broadcastLocalMemoryChanged(request);
  }
}
