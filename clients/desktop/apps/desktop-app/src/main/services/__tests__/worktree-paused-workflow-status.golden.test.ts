// Persistence compatibility contract golden (docs/golden-tests.md): exercises
// real on-disk pipeline-executions state files through saveExecutionState /
// deleteExecutionState to verify restart hydration, unreadable-file recovery,
// archive/restore cache invalidation, and Auto Delete busy semantics.
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import {
  createInitialState,
  normalizePipeline,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor';
import * as executionStateModule from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type {
  ExecutionHandle,
  ExecutionRuntime,
  ExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import {
  isAutoArchiveRuntimeBusy,
  type AutoArchiveCandidate,
} from '../../lib/auto-archive';
import { notifyDurablePausedPipelinesChanged } from '../../pipelines/paused-pipeline-cache-signal';
import {
  broadcastPipelineExecutionEvent,
  resetPipelineExecutionEventBroadcasterForTests,
} from '../../pipelines/pipeline-execution-event-broadcaster';
import {
  reserveExecution,
  trackExecution,
} from '../../pipelines/pipeline-execution-registry';
import {
  cancelDesktopSessionSnapshotInvalidation,
  subscribeDesktopSessionSnapshotInvalidation,
} from '../desktop-session-snapshot-invalidation';
import {
  getWorktreeRuntimeStatuses,
  resetWorktreeRuntimeStatusServiceForTests,
  stopWorktreeRuntimeStatusService,
} from '../worktree-runtime-status-service';

function makeRuntime(executionsDir: string, rootDir: string): ExecutionRuntime {
  return {
    isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
    isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    executionsDir,
    tempRootDir: rootDir,
    bundledActionsDir: rootDir,
    getProjectActionsDir: (repoPath: string): string => repoPath,
    getProjectPipelinesDir: (repoPath: string): string => repoPath,
  };
}

function makeWorktree(id: string): WorktreeData {
  return {
    id,
    branchName: `feature/${id}`,
    createdAt: '2026-11-26T00:00:00.000Z',
  };
}

function makeCandidate(
  workspaceId: string,
  worktree: WorktreeData,
): AutoArchiveCandidate {
  return {
    surface: 'single-repo',
    workspaceId,
    workspaceName: workspaceId,
    targetId: worktree.id,
    targetName: worktree.branchName,
    createdAt: worktree.createdAt,
    inactivityDays: 14,
    worktree,
  };
}

function makeExecutionState(args: {
  id: string;
  projectId: string;
  worktreeId: string;
  status: ExecutionState['status'];
  parentExecutionId?: string;
  executionsDir: string;
  rootDir: string;
}): ExecutionState {
  const state = createInitialState(
    normalizePipeline({
      name: `Workflow ${args.id}`,
      on: 'dispatch',
      jobs: { main: { steps: [{ id: 'step1', run: 'echo ok' }] } },
    }),
    {
      cwd: args.rootDir,
      pipelineId: `pipeline-${args.id}`,
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      runtime: makeRuntime(args.executionsDir, args.rootDir),
    },
    args.id,
  );
  if (args.parentExecutionId !== undefined) {
    state.parent_execution_id = args.parentExecutionId;
  }
  state.status = args.status;
  state.jobs.main.status =
    args.status === 'paused'
      ? 'paused'
      : args.status === 'running'
        ? 'running'
        : args.status === 'pending'
          ? 'pending'
          : 'success';
  state.jobs.main.steps.step1.status = state.jobs.main.status;
  return state;
}

function makeActiveHandle(state: ExecutionState): {
  handle: ExecutionHandle;
  finish: () => void;
} {
  let resolveCompletion: ((finalState: ExecutionState) => void) | null = null;
  const completion = new Promise<ExecutionState>((resolve) => {
    resolveCompletion = resolve;
  });
  const handle: ExecutionHandle = {
    id: state.id,
    getState: (): ExecutionState => state,
    cancel: (): Promise<ExecutionState> => Promise.resolve(state),
    waitForCompletion: (): Promise<ExecutionState> => completion,
  };
  return {
    handle,
    finish: (): void => {
      resolveCompletion?.(state);
    },
  };
}

describe('durable paused-workflow runtime status (CAN-7945)', () => {
  let rootDir = '';
  let executionsDir = '';
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.CANOPY_DATA_DIR;
    rootDir = await fs.mkdtemp(join(tmpdir(), 'can-7945-paused-status-'));
    executionsDir = join(rootDir, 'pipeline-executions');
    await fs.mkdir(executionsDir, { recursive: true });
    process.env.CANOPY_DATA_DIR = rootDir;
    resetWorktreeRuntimeStatusServiceForTests();
    resetPipelineExecutionEventBroadcasterForTests();
    cancelDesktopSessionSnapshotInvalidation();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    stopWorktreeRuntimeStatusService();
    resetWorktreeRuntimeStatusServiceForTests();
    resetPipelineExecutionEventBroadcasterForTests();
    cancelDesktopSessionSnapshotInvalidation();
    if (previousDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = previousDataDir;
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it('hydrates persisted paused workflows once, survives restart, keeps running ahead of paused, and ignores settled pauses in Auto Delete', async () => {
    const wtPaused = makeWorktree('wt-paused');
    const wtDone = makeWorktree('wt-done');

    await saveExecutionState(
      makeExecutionState({
        id: 'exec-paused-1',
        projectId: 'ws-1',
        worktreeId: wtPaused.id,
        status: 'paused',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );
    await saveExecutionState(
      makeExecutionState({
        id: 'exec-done-1',
        projectId: 'ws-1',
        worktreeId: wtDone.id,
        status: 'success',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );

    const listSpy = jest.spyOn(
      executionStateModule,
      'listExecutionSummariesForArchival',
    );

    const first = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtPaused },
      { workspaceId: 'ws-1', worktree: wtDone },
    ]);
    expect(first.get('ws-1\0wt-paused')?.pipelineStatus).toBe('paused');
    expect(first.get('ws-1\0wt-done')?.pipelineStatus).toBeUndefined();
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Subsequent polls reuse the hydrated index without full history rescans.
    const second = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtPaused },
    ]);
    expect(second.get('ws-1\0wt-paused')?.pipelineStatus).toBe('paused');
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Auto Delete ignores settled paused workflows.
    await expect(
      isAutoArchiveRuntimeBusy(makeCandidate('ws-1', wtPaused)),
    ).resolves.toBe(false);

    // An active running workflow takes precedence over a durable paused one
    // and DOES block Auto Delete.
    const runningState = makeExecutionState({
      id: 'exec-running-1',
      projectId: 'ws-1',
      worktreeId: wtPaused.id,
      status: 'running',
      executionsDir,
      rootDir,
    });
    const active = makeActiveHandle(runningState);
    reserveExecution(runningState.id);
    trackExecution(active.handle);
    try {
      const whileRunning = await getWorktreeRuntimeStatuses([
        { workspaceId: 'ws-1', worktree: wtPaused },
      ]);
      expect(whileRunning.get('ws-1\0wt-paused')?.pipelineStatus).toBe(
        'running',
      );
      expect(whileRunning.get('ws-1\0wt-paused')?.isRunningRun).toBe(true);
      await expect(
        isAutoArchiveRuntimeBusy(makeCandidate('ws-1', wtPaused)),
      ).resolves.toBe(true);
    } finally {
      active.finish();
      await Promise.resolve();
    }

    // An active handle that has already flipped to paused while still settling
    // its durable save MUST still block Auto Delete until it leaves activeExecutions.
    const settlingPausedState = makeExecutionState({
      id: 'exec-settling-paused-1',
      projectId: 'ws-1',
      worktreeId: wtDone.id,
      status: 'paused',
      executionsDir,
      rootDir,
    });
    const settlingHandle = makeActiveHandle(settlingPausedState);
    reserveExecution(settlingPausedState.id);
    trackExecution(settlingHandle.handle);
    try {
      await expect(
        isAutoArchiveRuntimeBusy(makeCandidate('ws-1', wtDone)),
      ).resolves.toBe(true);
    } finally {
      settlingHandle.finish();
      await Promise.resolve();
    }
    await expect(
      isAutoArchiveRuntimeBusy(makeCandidate('ws-1', wtDone)),
    ).resolves.toBe(false);

    // Once the active run exits, the durable paused badge remains.
    const afterRunning = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtPaused },
    ]);
    expect(afterRunning.get('ws-1\0wt-paused')?.pipelineStatus).toBe('paused');
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Simulated app restart rehydrates the persisted paused workflow from disk.
    resetWorktreeRuntimeStatusServiceForTests();
    resetPipelineExecutionEventBroadcasterForTests();
    const afterRestart = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtPaused },
    ]);
    expect(afterRestart.get('ws-1\0wt-paused')?.pipelineStatus).toBe('paused');
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('tracks live pause, resume, and terminal broadcasts without rescanning disk', async () => {
    const wt = makeWorktree('wt-live');
    const listSpy = jest.spyOn(
      executionStateModule,
      'listExecutionSummariesForArchival',
    );

    const initial = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wt },
    ]);
    expect(initial.get('ws-1\0wt-live')?.pipelineStatus).toBeUndefined();
    expect(listSpy).toHaveBeenCalledTimes(1);

    const pausedState = makeExecutionState({
      id: 'exec-live-1',
      projectId: 'ws-1',
      worktreeId: wt.id,
      status: 'paused',
      executionsDir,
      rootDir,
    });
    broadcastPipelineExecutionEvent({
      executionId: pausedState.id,
      type: 'execution.updated',
      timestamp: '2026-11-26T00:01:00.000Z',
      state: pausedState,
    });

    const afterPause = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wt },
    ]);
    expect(afterPause.get('ws-1\0wt-live')?.pipelineStatus).toBe('paused');
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Resuming (running) clears the settled paused state.
    broadcastPipelineExecutionEvent({
      executionId: pausedState.id,
      type: 'execution.updated',
      timestamp: '2026-11-26T00:02:00.000Z',
      state: { ...pausedState, status: 'running' },
    });
    const afterResume = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wt },
    ]);
    expect(afterResume.get('ws-1\0wt-live')?.pipelineStatus).toBeUndefined();

    // Pausing again and then completing clears paused cleanly.
    broadcastPipelineExecutionEvent({
      executionId: pausedState.id,
      type: 'execution.updated',
      timestamp: '2026-11-26T00:03:00.000Z',
      state: pausedState,
    });
    expect(
      (
        await getWorktreeRuntimeStatuses([
          { workspaceId: 'ws-1', worktree: wt },
        ])
      ).get('ws-1\0wt-live')?.pipelineStatus,
    ).toBe('paused');

    broadcastPipelineExecutionEvent({
      executionId: pausedState.id,
      type: 'execution.completed',
      timestamp: '2026-11-26T00:04:00.000Z',
      state: { ...pausedState, status: 'success' },
    });
    const afterComplete = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wt },
    ]);
    expect(afterComplete.get('ws-1\0wt-live')?.pipelineStatus).toBeUndefined();
    expect(listSpy).toHaveBeenCalledTimes(1);
  });

  it('lets live broadcasts arriving during cold-start hydration win over stale disk summaries', async () => {
    const wtFinished = makeWorktree('wt-finished-mid-hydration');
    const wtPaused = makeWorktree('wt-paused-mid-hydration');

    const diskPaused = makeExecutionState({
      id: 'exec-disk-paused',
      projectId: 'ws-1',
      worktreeId: wtFinished.id,
      status: 'paused',
      executionsDir,
      rootDir,
    });
    await saveExecutionState(diskPaused, executionsDir);

    let listEntered: (() => void) | undefined;
    let releaseList: (() => void) | undefined;
    const listEnteredPromise = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });

    const realList = executionStateModule.listExecutionSummariesForArchival;
    jest
      .spyOn(executionStateModule, 'listExecutionSummariesForArchival')
      .mockImplementationOnce(async (dir) => {
        const summaries = await realList(dir);
        listEntered?.();
        await listGate;
        return summaries;
      });

    const readPromise = getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtFinished },
      { workspaceId: 'ws-1', worktree: wtPaused },
    ]);
    await listEnteredPromise;

    // While hydration is suspended with stale summaries:
    // 1. exec-disk-paused finishes live.
    broadcastPipelineExecutionEvent({
      executionId: diskPaused.id,
      type: 'execution.completed',
      timestamp: '2026-11-26T00:05:00.000Z',
      state: { ...diskPaused, status: 'success' },
    });
    // 2. exec-live-paused enters paused live.
    const livePaused = makeExecutionState({
      id: 'exec-live-paused',
      projectId: 'ws-1',
      worktreeId: wtPaused.id,
      status: 'paused',
      executionsDir,
      rootDir,
    });
    broadcastPipelineExecutionEvent({
      executionId: livePaused.id,
      type: 'execution.updated',
      timestamp: '2026-11-26T00:05:01.000Z',
      state: livePaused,
    });

    releaseList?.();
    const statuses = await readPromise;
    expect(
      statuses.get('ws-1\0wt-finished-mid-hydration')?.pipelineStatus,
    ).toBeUndefined();
    expect(statuses.get('ws-1\0wt-paused-mid-hydration')?.pipelineStatus).toBe(
      'paused',
    );
  });

  it('reloads paused state and invalidates snapshots when notifyDurablePausedPipelinesChanged fires after archive delete or restore', async () => {
    const wt = makeWorktree('wt-archive');
    const pausedState = makeExecutionState({
      id: 'exec-archived-1',
      projectId: 'ws-1',
      worktreeId: wt.id,
      status: 'paused',
      executionsDir,
      rootDir,
    });
    await saveExecutionState(pausedState, executionsDir);
    broadcastPipelineExecutionEvent({
      executionId: pausedState.id,
      type: 'execution.updated',
      timestamp: '2026-11-26T00:06:00.000Z',
      state: pausedState,
    });

    let invalidations = 0;
    const unsubscribe = subscribeDesktopSessionSnapshotInvalidation(() => {
      invalidations += 1;
    });
    try {
      const beforeDelete = await getWorktreeRuntimeStatuses([
        { workspaceId: 'ws-1', worktree: wt },
      ]);
      expect(beforeDelete.get('ws-1\0wt-archive')?.pipelineStatus).toBe(
        'paused',
      );

      await executionStateModule.deleteExecutionState(
        pausedState.id,
        executionsDir,
      );
      notifyDurablePausedPipelinesChanged([pausedState.id]);
      const deadline = Date.now() + 2000;
      while (invalidations === 0 && Date.now() < deadline) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
      expect(invalidations).toBeGreaterThan(0);

      const afterDelete = await getWorktreeRuntimeStatuses([
        { workspaceId: 'ws-1', worktree: wt },
      ]);
      expect(
        afterDelete.get('ws-1\0wt-archive')?.pipelineStatus,
      ).toBeUndefined();

      // Restoring the state file and notifying reloads the paused badge.
      await saveExecutionState(pausedState, executionsDir);
      notifyDurablePausedPipelinesChanged([pausedState.id]);

      const afterRestore = await getWorktreeRuntimeStatuses([
        { workspaceId: 'ws-1', worktree: wt },
      ]);
      expect(afterRestore.get('ws-1\0wt-archive')?.pipelineStatus).toBe(
        'paused',
      );
    } finally {
      unsubscribe();
    }
  });

  it('handles missing or unreadable pipeline-executions directory gracefully and retries on next read', async () => {
    const wt = makeWorktree('wt-missing');
    const listSpy = jest
      .spyOn(executionStateModule, 'listExecutionSummariesForArchival')
      .mockRejectedValueOnce(new Error('transient read error'));

    const first = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wt },
    ]);
    expect(first.get('ws-1\0wt-missing')?.pipelineStatus).toBeUndefined();
    expect(listSpy).toHaveBeenCalledTimes(1);

    await saveExecutionState(
      makeExecutionState({
        id: 'exec-recovered-1',
        projectId: 'ws-1',
        worktreeId: wt.id,
        status: 'paused',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );

    const second = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wt },
    ]);
    expect(second.get('ws-1\0wt-missing')?.pipelineStatus).toBe('paused');
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('keeps hydration retryable when an execution file is temporarily unreadable and picks up its pause once readable', async () => {
    const wtReadable = makeWorktree('wt-readable');
    const wtTransient = makeWorktree('wt-transient-unreadable');

    await saveExecutionState(
      makeExecutionState({
        id: 'exec-readable-1',
        projectId: 'ws-1',
        worktreeId: wtReadable.id,
        status: 'paused',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );
    // Simulate a partially written / transiently unreadable state file during
    // cold-start hydration.
    await fs.writeFile(
      join(executionsDir, 'exec-transient-1.json'),
      '{truncated-json',
      'utf8',
    );

    const listSpy = jest.spyOn(
      executionStateModule,
      'listExecutionSummariesForArchival',
    );

    const first = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtReadable },
      { workspaceId: 'ws-1', worktree: wtTransient },
    ]);
    expect(first.get('ws-1\0wt-readable')?.pipelineStatus).toBe('paused');
    expect(
      first.get('ws-1\0wt-transient-unreadable')?.pipelineStatus,
    ).toBeUndefined();
    expect(listSpy).toHaveBeenCalledTimes(1);

    // Once the unreadable file becomes valid paused state, the next read
    // retries hydration, picks up the pause, and seals the cache.
    await saveExecutionState(
      makeExecutionState({
        id: 'exec-transient-1',
        projectId: 'ws-1',
        worktreeId: wtTransient.id,
        status: 'paused',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );

    const second = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtReadable },
      { workspaceId: 'ws-1', worktree: wtTransient },
    ]);
    expect(second.get('ws-1\0wt-readable')?.pipelineStatus).toBe('paused');
    expect(second.get('ws-1\0wt-transient-unreadable')?.pipelineStatus).toBe(
      'paused',
    );
    expect(listSpy).toHaveBeenCalledTimes(2);

    // Now that all files were readable, subsequent reads reuse the cache.
    const third = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtTransient },
    ]);
    expect(third.get('ws-1\0wt-transient-unreadable')?.pipelineStatus).toBe(
      'paused',
    );
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('ignores nested paused children whose ancestor chain is terminal, missing, or cyclic across restart and live cancel', async () => {
    const wtCancelledParent = makeWorktree('wt-cancelled-parent');
    const wtMissingParent = makeWorktree('wt-missing-parent');
    const wtCyclicParent = makeWorktree('wt-cyclic-parent');
    const wtActiveNested = makeWorktree('wt-active-nested');

    // 1. Parent cancelled on disk while its nested child state file remains paused
    // (mirrors cancelPipelineExecution saving only the parent state).
    await saveExecutionState(
      makeExecutionState({
        id: 'exec-parent-cancelled',
        projectId: 'ws-1',
        worktreeId: wtCancelledParent.id,
        status: 'cancelled',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );
    await saveExecutionState(
      makeExecutionState({
        id: 'exec-child-after-parent-cancel',
        projectId: 'ws-1',
        worktreeId: wtCancelledParent.id,
        status: 'paused',
        parentExecutionId: 'exec-parent-cancelled',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );

    // 2. Paused child whose parent state file is missing.
    await saveExecutionState(
      makeExecutionState({
        id: 'exec-child-missing-parent',
        projectId: 'ws-1',
        worktreeId: wtMissingParent.id,
        status: 'paused',
        parentExecutionId: 'exec-does-not-exist',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );

    // 3. Cyclic parent_execution_id chain on disk must not loop or admit paused.
    await saveExecutionState(
      makeExecutionState({
        id: 'exec-cycle-a',
        projectId: 'ws-1',
        worktreeId: wtCyclicParent.id,
        status: 'paused',
        parentExecutionId: 'exec-cycle-b',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );
    await saveExecutionState(
      makeExecutionState({
        id: 'exec-cycle-b',
        projectId: 'ws-1',
        worktreeId: wtCyclicParent.id,
        status: 'paused',
        parentExecutionId: 'exec-cycle-a',
        executionsDir,
        rootDir,
      }),
      executionsDir,
    );

    // 4. Active nested pause where the parent is still paused on disk IS kept
    // until the parent is cancelled live.
    const liveParent = makeExecutionState({
      id: 'exec-parent-paused',
      projectId: 'ws-1',
      worktreeId: wtActiveNested.id,
      status: 'paused',
      executionsDir,
      rootDir,
    });
    const liveChild = makeExecutionState({
      id: 'exec-child-paused',
      projectId: 'ws-1',
      worktreeId: wtActiveNested.id,
      status: 'paused',
      parentExecutionId: liveParent.id,
      executionsDir,
      rootDir,
    });
    await saveExecutionState(liveParent, executionsDir);
    await saveExecutionState(liveChild, executionsDir);

    const hydrated = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtCancelledParent },
      { workspaceId: 'ws-1', worktree: wtMissingParent },
      { workspaceId: 'ws-1', worktree: wtCyclicParent },
      { workspaceId: 'ws-1', worktree: wtActiveNested },
    ]);
    expect(
      hydrated.get('ws-1\0wt-cancelled-parent')?.pipelineStatus,
    ).toBeUndefined();
    expect(
      hydrated.get('ws-1\0wt-missing-parent')?.pipelineStatus,
    ).toBeUndefined();
    expect(
      hydrated.get('ws-1\0wt-cyclic-parent')?.pipelineStatus,
    ).toBeUndefined();
    expect(hydrated.get('ws-1\0wt-active-nested')?.pipelineStatus).toBe(
      'paused',
    );

    // Cancelling the parent live clears its paused nested child immediately
    // even though the child itself never broadcasts a terminal event.
    broadcastPipelineExecutionEvent({
      executionId: liveParent.id,
      type: 'execution.cancelled',
      timestamp: '2026-11-26T00:07:00.000Z',
      state: { ...liveParent, status: 'cancelled' },
    });
    const afterLiveParentCancel = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtActiveNested },
    ]);
    expect(
      afterLiveParentCancel.get('ws-1\0wt-active-nested')?.pipelineStatus,
    ).toBeUndefined();

    // A stray live paused broadcast for a child whose parent is missing/terminal
    // must also be ignored.
    broadcastPipelineExecutionEvent({
      executionId: 'exec-live-orphan-child',
      type: 'execution.updated',
      timestamp: '2026-11-26T00:07:01.000Z',
      state: makeExecutionState({
        id: 'exec-live-orphan-child',
        projectId: 'ws-1',
        worktreeId: wtActiveNested.id,
        status: 'paused',
        parentExecutionId: liveParent.id,
        executionsDir,
        rootDir,
      }),
    });
    const afterOrphanBroadcast = await getWorktreeRuntimeStatuses([
      { workspaceId: 'ws-1', worktree: wtActiveNested },
    ]);
    expect(
      afterOrphanBroadcast.get('ws-1\0wt-active-nested')?.pipelineStatus,
    ).toBeUndefined();
  });
});
