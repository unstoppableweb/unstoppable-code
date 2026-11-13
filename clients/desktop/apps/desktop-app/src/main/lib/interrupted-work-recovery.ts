import { reconcileStoredPipelineIndex } from '@canopy/execution-engine/pipelines/store';
import { logMainProcessWarn } from './main-process-logging';
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import { getAppWorkspacesRootDir, getWorkspacesRootDir } from './paths';
import { getChatStateService } from '../services/chat-state-service';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import { whenPipelineInstallsRecovered } from '../pipelines/pipeline-install-intents';
import { configureDesktopPipelineOwnerFence } from '../pipelines/pipeline-owner-fence';
import { sweepOrphanedPipelinesThroughLocalWorker } from '../pipelines/pipeline-worker-dispatch';
import type { InterruptedWorkScan } from './interrupted-work-scan-worker';

function scan(executionsDir: string): Promise<InterruptedWorkScan> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(
      join(__dirname, 'interrupted-work-scan-worker.js'),
      [],
      { serviceName: 'interrupted-work-scan' },
    );
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error('Interrupted work scan timed out')),
      120_000,
    );
    const finish = (error?: Error, result?: InterruptedWorkScan): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else if (result) resolve(result);
    };
    child.once('exit', (code) =>
      finish(new Error(`Interrupted work scan exited (${code})`)),
    );
    child.once(
      'message',
      (message: { error?: string; result?: InterruptedWorkScan }) => {
        if (message.result) finish(undefined, message.result);
        else
          finish(
            new Error(message.error ?? 'Invalid interrupted work scan result'),
          );
      },
    );
    child.postMessage({
      roots: [getWorkspacesRootDir(), getAppWorkspacesRootDir()],
      executionsDir,
    });
  });
}

/** Executions the startup scan found, for the orphan sweep once core runs. */
let interruptedPipelineIds: string[] = [];
let daemonCommitHookIds: string[] = [];

/**
 * Recover interrupted chats before the first window can admit new work, and
 * find the pipeline executions the orphan sweep checks. The sweep runs
 * through core once the desktop runtime exists, still before any pipeline
 * can start (`sweepInterruptedPipelinesAtStartup`). Pipeline installs an
 * exit interrupted are rolled back alongside; installs wait for that
 * themselves. Each item is retryable.
 */
export async function recoverInterruptedWorkAtStartup(): Promise<void> {
  // Recovered queued chats wait for the core to accept turns (CAN-4112);
  // index.ts releases the hold once the desktop runtime is installed.
  const { getChatQueueService } =
    await import('../services/chat-queue-service');
  getChatQueueService().holdDrainsForStartup();
  const reconciled = reconcileStoredPipelineIndex();
  if (!reconciled.ok)
    logMainProcessWarn(
      '[pipelines] Pipeline index reconcile skipped',
      reconciled.message,
    );
  const runtime = createElectronExecutionRuntime();
  // The inspector is installed before recovery; this process's own start
  // identity resolves in the background, and runs that start first record
  // only their PID.
  configureDesktopPipelineOwnerFence().catch(() => undefined);
  const installs = whenPipelineInstallsRecovered();
  const found = await scan(runtime.executionsDir);
  interruptedPipelineIds = found.pipelineIds;
  daemonCommitHookIds = found.daemonCommitHookIds;
  const errors = [...found.errors];
  for (const scope of found.chatScopes) {
    try {
      await getChatStateService().getState(scope);
    } catch (error) {
      errors.push(
        `Chat ${scope.projectId}/${scope.worktreeId}: ${String(error)}`,
      );
    }
  }
  await installs;
  if (errors.length) throw new Error(errors.join('\n'));
}

/**
 * The startup orphan sweep through core and the local worker (CAN-4141),
 * over the executions startup recovery found. `null` when there are none, so
 * a clean start neither waits nor opens a ledger.
 */
export function sweepInterruptedPipelinesAtStartup(): Promise<void> | null {
  const pipelineIds = interruptedPipelineIds;
  const commitHookIds = daemonCommitHookIds;
  interruptedPipelineIds = [];
  daemonCommitHookIds = [];
  if (pipelineIds.length === 0 && commitHookIds.length === 0) return null;
  const swept: Promise<string[]> =
    pipelineIds.length === 0
      ? Promise.resolve([])
      : sweepOrphanedPipelinesThroughLocalWorker(pipelineIds);
  return swept.then(async (errors) => {
    const { catchUpDaemonCommitHooksFor, followSurvivingDaemonRuns } =
      await import('../pipelines/daemon-pipeline-route');
    const executionsDir = createElectronExecutionRuntime().executionsDir;
    // What the sweep left running belongs to a live owner such as the
    // daemon: it stays active work (CAN-5086).
    if (pipelineIds.length > 0)
      await followSurvivingDaemonRuns(pipelineIds, executionsDir);
    // Commit results that settled while nothing followed their run (CAN-6012 D3).
    await catchUpDaemonCommitHooksFor(commitHookIds, executionsDir);
    if (errors.length) throw new Error(errors.join('\n'));
  });
}
