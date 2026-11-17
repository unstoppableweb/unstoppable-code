import { totalmem } from 'node:os';
import type {
  CodeGraphGenerationQueueSnapshot,
  CodeGraphQueueEntryStatus,
  CodeGraphReorderGenerationQueueRequest,
} from '@canopy/desktop-shared/types';
import { getCodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import { getWorktreeCodeGraphDbPath } from '@canopy/desktop-shared/node/code-graph/worktree-paths';
import {
  getCodeGraphGenerationTimeoutMs,
  isCodeGraphAvailableForWorkspace,
} from '../lib/code-graph-availability';
import { getBundledCodeGraphDir } from '@canopy/execution-engine/pipelines/config-paths';
import { getExecutionAccounting } from '../execution-accounting';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { resolveWorktreeCodeGraphRepositories } from '../lib/worktree-repo-entries';
import {
  leaveBackgroundProcessPolicy,
  lowerSpawnedProcessPriority,
} from '../lib/background-process';
import { getExecutionHostPort } from '../execution-host/utility-process-host';
import { codeGraphHostBudget } from '@canopy/code-graph/host/budgets';
import {
  CODE_GRAPH_BUILD_CONCURRENCY_CAP,
  CodeGraphWorkerBuildError,
  createCodeGraphBuildScheduler,
  type CodeGraphBuildCancelOptions,
  type CodeGraphBuildQueueStatus,
  type CodeGraphReorderGenerationQueueResult,
  type CodeGraphBuildSchedulingOptions,
  type CodeGraphBuildState,
  type CodeGraphBuildStatusListener,
  type CodeGraphGenerationQueueListener,
  type CodeGraphSummaryRepairRequest,
  type CodeGraphSummaryRepairResult,
  type CodeGraphWorkerBuildHandle,
} from '@canopy/code-graph/host/build-scheduler';
import type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerEagerSeedRequest,
  CodeGraphWorkerEagerSeedResponse,
} from '@canopy/code-graph/host/build-protocol';
import {
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
  StorageWriteRefusedError,
} from '@canopy/core-runtime/storage';
import { isCodeGraphBaseRunnerKey } from './base-runner-key';

// The build host protocol lives with the host in `@canopy/code-graph/host`,
// and the scheduler beside it. This module composes the scheduler for
// Electron main: utility-process build hosts, core execution accounting, the
// availability preference and the desktop graph service.

export type {
  CodeGraphWorkerBuildRequest,
  CodeGraphWorkerSummaryRepairRequest,
  CodeGraphWorkerSummaryRepairResponse,
  CodeGraphWorkerEagerSeedRequest,
  CodeGraphWorkerBuildResponse,
  CodeGraphWorkerDerivedCompletion,
  CodeGraphWorkerEagerSeedResponse,
} from '@canopy/code-graph/host/build-protocol';
export {
  CODE_GRAPH_FIRST_BUILD_OVERTAKE_LIMIT,
  CodeGraphWorkerBuildError,
} from '@canopy/code-graph/host/build-scheduler';
export type {
  CodeGraphBuildPriority,
  CodeGraphBuildQueueMetadata,
  CodeGraphBuildSchedulingOptions,
  CodeGraphBuildState,
  CodeGraphBuildStatus,
  CodeGraphSummaryRepairRequest,
  CodeGraphSummaryRepairResult,
  CodeGraphWorkerBuildErrorReason,
  CodeGraphWorkerBuildHandle,
} from '@canopy/code-graph/host/build-scheduler';

const WORKER_SERVICE_NAME = 'code-graph-build';
const WORKER_ENTRY_FILENAME = 'code-graph-build-worker.js';

export function codeGraphBuildConcurrencyCap(
  e2eEnabled = __CANOPY_E2E__,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return e2eEnabled && env.CANOPY_PERFORMANCE_CODE_GRAPH_CONCURRENCY === '1'
    ? 1
    : CODE_GRAPH_BUILD_CONCURRENCY_CAP;
}

const scheduler = createCodeGraphBuildScheduler({
  launchBuildHost: () =>
    getExecutionHostPort().launch({
      entry: WORKER_ENTRY_FILENAME,
      serviceName: WORKER_SERVICE_NAME,
      budget: codeGraphHostBudget('build', {
        totalMemoryBytes: totalmem(),
      }),
    }),
  // Core accounting counts the build until its worker exits, however it ends.
  trackBuildHost: (buildId, exited) => {
    getExecutionAccounting()
      .track('codeGraph', buildId)
      .releaseWhenSettled(exited);
  },
  applyProcessPriority: (pid, options) =>
    lowerSpawnedProcessPriority(pid, options),
  leaveBackgroundPolicy: (pid) => leaveBackgroundProcessPolicy(pid),
  isWorkspaceAvailable: (workspaceId) =>
    isCodeGraphAvailableForWorkspace(workspaceId),
  generationTimeoutMs: () => getCodeGraphGenerationTimeoutMs(),
  concurrencyCap: () => codeGraphBuildConcurrencyCap(),
  worktreeDbPath: (workspaceId, worktreeId) =>
    getWorktreeCodeGraphDbPath(workspaceId, worktreeId),
  withWorktreeClosed: (workspaceId, worktreeId, operation) =>
    getCodeGraphWorktreeService().withWorktreeClosed(
      workspaceId,
      worktreeId,
      operation,
    ),
  resolveSummaryRepairPlace: async (workspaceId, worktreeId) => {
    const worktreeRootPath = resolveWorktreeCwd(workspaceId, worktreeId);
    const repositories = await resolveWorktreeCodeGraphRepositories(
      workspaceId,
      worktreeRootPath,
    );
    return {
      worktreeRootPath,
      repositories,
      resourcesDir: getBundledCodeGraphDir(),
    };
  },
  readSummaryProjection: async ({ key, dbPath, diagnosticOwner }) => {
    // Repair is invoked after runner initialization; keep telemetry's build-error import acyclic.
    const { runCodeGraphWorkerRead, CodeGraphReadFailureError } =
      await import('./read-runner');
    const response = await runCodeGraphWorkerRead({
      key,
      kind: 'base-validation',
      ...(diagnosticOwner === undefined ? {} : { diagnosticOwner }),
      request: { dbPath, task: { kind: 'readonly-summary' } },
    });
    if (!response.ok)
      return { ok: false, error: new CodeGraphReadFailureError(response.code) };
    if (response.result.kind !== 'readonly-summary')
      return {
        ok: false,
        error: new CodeGraphReadFailureError('invalid-response'),
      };
    return { ok: true, value: response.result.value };
  },
});

export const codeGraphBuildRunnerTestExports = scheduler.testHooks;

/**
 * Install (or clear, via `null`) the single build-status listener. Call sites
 * wire this once at app startup; a second call replaces the previous
 * listener rather than stacking listeners.
 */
export function setCodeGraphBuildStatusListener(
  listener: CodeGraphBuildStatusListener | null,
): void {
  scheduler.setBuildStatusListener(listener);
}

export function setCodeGraphGenerationQueueListener(
  listener: CodeGraphGenerationQueueListener | null,
): void {
  scheduler.setQueueListener(listener);
}

export function getCodeGraphGenerationQueueSnapshot(): CodeGraphGenerationQueueSnapshot {
  return scheduler.queueSnapshot();
}

/** The queue with each entry's scheduling class, for the worker's queue controls. */
export function getCodeGraphBuildQueueStatus(): CodeGraphBuildQueueStatus {
  return scheduler.queueStatus();
}

/**
 * Cancels one queued or running queue entry, resolving with the state it was
 * in once its build host has exited; `null` for an unknown entry.
 */
export function cancelCodeGraphQueueItem(
  queueItemId: string,
): Promise<CodeGraphQueueEntryStatus | null> {
  return scheduler.cancelQueueItem(queueItemId);
}

/** True while a worktree graph build is queued or running. Read-side tooling
 * uses this to distinguish an in-progress refresh from a genuinely absent
 * graph during the brief pre-install window. */
export function isCodeGraphBuildPending(key: string): boolean {
  return scheduler.isBuildPending(key);
}

/** Source-generation state intentionally ignores hidden repairs and drains. */
export function getCodeGraphSourceBuildState(key: string): CodeGraphBuildState {
  return scheduler.sourceBuildState(key);
}

export function reorderCodeGraphGenerationQueue(
  request: CodeGraphReorderGenerationQueueRequest,
): CodeGraphReorderGenerationQueueResult {
  return scheduler.reorderQueue(request);
}

/**
 * Admits a worktree graph write by this scheduler's build utility process
 * (CAN-6985): builds, eager seeds and summary repairs. It admits them while
 * `worktree_code_graph` stays legacy and refuses them once the daemon owns
 * the store. Workspace base graphs share the scheduler but are another store,
 * so their keys are not checked here.
 */
function worktreeGraphWriteRefusal(
  key: string,
): StorageWriteRefusedError | null {
  if (isCodeGraphBaseRunnerKey(key)) return null;
  const decision = evaluateStorageWrite(
    'worktree_code_graph',
    'utility_process',
    STORAGE_OWNERSHIP,
  );
  return decision.allowed
    ? null
    : new StorageWriteRefusedError(
        'worktree_code_graph',
        'utility_process',
        decision.reason,
      );
}

/** A refused write fails the way the scheduler fails an unavailable build. */
function refusedBuild(
  refusal: StorageWriteRefusedError,
): CodeGraphWorkerBuildError {
  return new CodeGraphWorkerBuildError('unavailable', refusal.message);
}

/** See {@link CodeGraphBuildScheduler.runBuild}. */
export function runCodeGraphWorkerBuild(
  key: string,
  request: CodeGraphWorkerBuildRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
): Promise<CodeGraphWorkerBuildResponse> {
  const refusal = worktreeGraphWriteRefusal(key);
  if (refusal) return Promise.reject(refusedBuild(refusal));
  return scheduler.runBuild(key, request, scheduling);
}

export function beginCodeGraphWorkerBuild(
  key: string,
  request: CodeGraphWorkerBuildRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
): CodeGraphWorkerBuildHandle {
  const refusal = worktreeGraphWriteRefusal(key);
  if (refusal)
    return { attemptId: null, promise: Promise.reject(refusedBuild(refusal)) };
  return scheduler.beginBuild(key, request, scheduling);
}

export function runCodeGraphWorkerEagerSeed(
  key: string,
  request: CodeGraphWorkerEagerSeedRequest,
  scheduling?: CodeGraphBuildSchedulingOptions,
): Promise<CodeGraphWorkerEagerSeedResponse> {
  const refusal = worktreeGraphWriteRefusal(key);
  if (refusal) return Promise.reject(refusedBuild(refusal));
  return scheduler.runEagerSeed(key, request, scheduling);
}

export function updateCodeGraphBuildOwners(
  key: string,
  workspaceIds: readonly string[],
): void {
  scheduler.updateBuildOwners(key, workspaceIds);
}

export function reconcileCodeGraphBuildAvailability(
  isAvailable: (workspaceId: string) => boolean,
): Promise<void> {
  return scheduler.reconcileAvailability(isAvailable);
}

/**
 * True while an admitted summary repair for `key` has not settled. A request
 * that was refused, or that arrived during the cooldown after a failed
 * attempt, leaves nothing working on the summary.
 */
export function isCodeGraphSummaryRepairActive(key: string): boolean {
  return scheduler.isSummaryRepairActive(key);
}

/**
 * The service close gate is registered before this operation admits a runner
 * repair. Never reserve a repair runner record before acquiring the service
 * close gate.
 */
export function requestCodeGraphSummaryRepair(
  input: CodeGraphSummaryRepairRequest,
): Promise<CodeGraphSummaryRepairResult> {
  const refusal = worktreeGraphWriteRefusal(input.key);
  if (refusal)
    return Promise.resolve({
      ok: false,
      attemptId: null,
      reason: 'unavailable',
      message: refusal.message,
    });
  return scheduler.requestSummaryRepair(input);
}

/**
 * Cancel a queued or running build for `key`. Resolves once the killed worker
 * has exited, so worktree cleanup can safely close engines and remove the
 * database afterwards; see the scheduler for the exit-wait rules.
 */
export function cancelBuild(
  key: string,
  options?: CodeGraphBuildCancelOptions,
): Promise<void> {
  return scheduler.cancel(key, options);
}

/**
 * Reject and tear down every in-flight and queued build. Called on app
 * teardown so no worker outlives the desktop app.
 */
export function killAllBuilds(): Promise<void> {
  return scheduler.cancelAll();
}
