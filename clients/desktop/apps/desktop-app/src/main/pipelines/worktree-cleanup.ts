import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncTreeDurably } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  deleteExecutionState,
  listExecutionSummaries,
  listExecutionSummariesForArchival,
  loadExecutionState,
  saveExecutionState,
} from '@canopy/execution-engine/node/pipelines/executor/execution-state';
import type {
  ExecutionRuntime,
  ExecutionSummary,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';
import { relocateExecutionStateArtifactPaths } from './execution-state-relocation';

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'code') === 'ENOENT'
    )
      return false;
    throw error;
  }
}

interface CleanupResult {
  warnings: string[];
  relocatedCount: number;
  failedRelocationIds: string[];
}

export interface CleanupWorktreePipelinesOptions {
  relocateArtifactsTo?: string;
  archiveCaptureExecutor?: (
    executionId: string,
    input: Extract<
      ArchiveIoOperationRequest,
      { type: 'copy-payload' }
    >['input'],
  ) => Promise<void>;
}

export async function deleteExecutionArtifacts(
  executionId: string,
  executionsDir: string,
): Promise<void> {
  await deleteExecutionState(executionId, executionsDir);
  await fs.rm(path.join(executionsDir, executionId), {
    recursive: true,
    force: true,
  });
}

function isCleanableStatus(status: ExecutionSummary['status']): boolean {
  return ['pending', 'success', 'failure', 'cancelled', 'paused'].includes(
    status,
  );
}

async function cancelRunningExecutions(
  running: ExecutionSummary[],
): Promise<PromiseSettledResult<ExecutionSummary>[]> {
  // Local import: the dispatch path reaches back into the desktop runtime.
  const { drainPipelineThroughLocalWorker } =
    await import('./pipeline-worker-dispatch');
  return Promise.allSettled(
    running.map(async (summary) => {
      try {
        // The worker's drain waits a bounded time and never force-writes a
        // terminal state, so a run still stopping keeps its cancellation
        // marker and running state for a later archive retry.
        await drainPipelineThroughLocalWorker(summary.id);
        return summary;
      } catch {
        throw new Error(summary.id);
      }
    }),
  );
}

/** Stop live pipeline processes while retaining their state for archival. */
export async function drainWorktreePipelines(
  projectId: string,
  worktreeId: string,
  runtime: ExecutionRuntime,
): Promise<void> {
  const { summaries } = await listExecutionSummariesForArchival(
    runtime.executionsDir,
  );
  const running = summaries.filter(
    (summary) =>
      summary.project_id === projectId &&
      summary.worktree_id === worktreeId &&
      summary.status === 'running',
  );
  const results = await cancelRunningExecutions(running);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    const executionId =
      failed.reason instanceof Error ? failed.reason.message : 'unknown';
    throw new Error(
      `Failed to drain workflow execution '${executionId}' before worktree teardown.`,
    );
  }
}

export async function cleanupWorktreePipelines(
  projectId: string,
  worktreeId: string,
  runtime: ExecutionRuntime,
  options?: CleanupWorktreePipelinesOptions,
): Promise<CleanupResult> {
  const warnings: string[] = [];

  let summaries: ExecutionSummary[];
  try {
    if (options?.relocateArtifactsTo) {
      const listed = await listExecutionSummariesForArchival(
        runtime.executionsDir,
      );
      summaries = listed.summaries;
      if (listed.unreadableFiles.length > 0) {
        // Unreadable state files cannot be attributed to any worktree, so
        // this cleanup never deletes them — leaving them in place loses
        // nothing, and failing the archive here would brick every worktree
        // deletion over a single foreign file in the shared executions dir.
        warnings.push(
          `Skipped ${listed.unreadableFiles.length} unreadable workflow execution state file(s) left in place: ${listed.unreadableFiles.join(', ')}`,
        );
      }
    } else {
      summaries = await listExecutionSummaries(runtime.executionsDir);
    }
  } catch (error) {
    if (options?.relocateArtifactsTo) {
      throw error;
    }
    return {
      warnings: ['Failed to list workflow executions for cleanup'],
      relocatedCount: 0,
      failedRelocationIds: [],
    };
  }

  const worktreeExecutions = summaries.filter(
    (s) => s.project_id === projectId && s.worktree_id === worktreeId,
  );

  if (worktreeExecutions.length === 0) {
    return { warnings, relocatedCount: 0, failedRelocationIds: [] };
  }

  const running = worktreeExecutions.filter((s) => s.status === 'running');
  const cleanable = worktreeExecutions.filter((s) =>
    isCleanableStatus(s.status),
  );

  // Cancel running executions concurrently, each with a 10s timeout
  const cancelResults = await cancelRunningExecutions(running);

  for (const result of cancelResults) {
    if (result.status === 'fulfilled') {
      // Successfully cancelled — add to cleanable set
      cleanable.push(result.value);
    } else {
      const failedId =
        result.reason instanceof Error ? result.reason.message : 'unknown';
      const failedSummary = running.find((s) => s.id === failedId);
      const name = failedSummary?.pipeline_name ?? 'unknown';
      warnings.push(
        `Failed to cancel workflow execution '${failedId}' (workflow: ${name}). It may still be running.`,
      );
    }
  }

  let relocatedCount = 0;
  const failedRelocationIds: string[] = [];
  const artifactResults = await Promise.allSettled(
    cleanable.map(async (summary) => {
      if (options?.relocateArtifactsTo) {
        const destinationRoot = options.relocateArtifactsTo;
        try {
          await fs.mkdir(destinationRoot, { recursive: true });
          const state = await loadExecutionState(
            summary.id,
            runtime.executionsDir,
          );
          if (!state) throw new Error('Execution state disappeared');
          const source = path.join(runtime.executionsDir, summary.id);
          const destination = path.join(destinationRoot, summary.id);
          if (options.archiveCaptureExecutor) {
            await options.archiveCaptureExecutor(summary.id, {
              sourceRoots: [runtime.executionsDir],
              destinationRoot,
              entries: [
                {
                  kind: 'directory',
                  source,
                  destination,
                  missingSource: 'ignore',
                },
              ],
            });
          } else {
            await fs
              .cp(source, destination, { recursive: true, force: true })
              .catch((error: unknown) => {
                if (
                  typeof error === 'object' &&
                  error !== null &&
                  Reflect.get(error, 'code') === 'ENOENT'
                ) {
                  return;
                }
                throw error;
              });
          }
          // The live artifacts are deleted next; the copy must survive power loss.
          if (await pathExists(destination)) await syncTreeDurably(destination);
          await saveExecutionState(
            relocateExecutionStateArtifactPaths(
              state,
              runtime.executionsDir,
              destinationRoot,
              summary.id,
            ),
            destinationRoot,
            { durable: true },
          );
          relocatedCount += 1;
        } catch {
          // A manifest may still be committed for other successfully copied
          // executions. Do not leave a partial state file or artifact tree in
          // that visible container: the live copy remains authoritative and a
          // later delete attempt can retry the relocation from scratch.
          await deleteExecutionArtifacts(summary.id, destinationRoot).catch(
            () => undefined,
          );
          throw new Error(`relocate:${summary.id}`);
        }
      }
      await deleteExecutionArtifacts(summary.id, runtime.executionsDir);
    }),
  );

  artifactResults.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      return;
    }
    const summary = cleanable[index];
    if (
      result.reason instanceof Error &&
      result.reason.message === `relocate:${summary.id}`
    ) {
      failedRelocationIds.push(summary.id);
      warnings.push(
        `Failed to archive workflow execution '${summary.id}' artifacts; the live artifacts were preserved.`,
      );
      return;
    }
    warnings.push(
      `Failed to delete workflow execution '${summary.id}' artifacts. They may need manual cleanup.`,
    );
  });

  return { warnings, relocatedCount, failedRelocationIds };
}
