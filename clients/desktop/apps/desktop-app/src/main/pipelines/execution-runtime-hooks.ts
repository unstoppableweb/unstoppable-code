import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type {
  ExecutionLifecycleHooks,
  PipelineStepNotification,
  StepPostProcessContext,
} from '@canopy/execution-engine/node/pipelines/executor/types';
import { getExecutionAccounting } from '../execution-accounting';
import {
  finishPipelineExecutionTelemetry,
  startPipelineExecutionTelemetry,
} from './instrumentation';
import { showOsNotification } from '../ipc/os-notifications';
import { isSpaceNotificationDeliverable } from '../lib/space-notification-gate';

export function createDesktopLifecycleHooks(): ExecutionLifecycleHooks {
  const settled = new Set<string>();
  const awake = new Map<string, () => void>();

  return {
    onExecutionStart: (state): void => {
      // Core accounting owns which execution families keep the computer awake.
      awake.get(state.id)?.();
      awake.set(
        state.id,
        getExecutionAccounting().keepAwake('pipeline', state.id),
      );
      startPipelineExecutionTelemetry(state);
    },
    onExecutionSettled: (state): void => {
      if (settled.has(state.id)) {
        return;
      }
      settled.add(state.id);
      finishPipelineExecutionTelemetry(state);
      awake.get(state.id)?.();
      awake.delete(state.id);
    },
  };
}

export interface GitCommitPushRepoOutput {
  repoId?: string;
  repoName?: string;
  repoPath?: string;
  status?: string;
  error?: string;
  failurePhase?: string;
  precommitFailureError?: string;
  commitMessage?: string;
}

/** A `git-commit-push` step's per-repo results; null when they are absent or unreadable. */
export function readGitCommitPushResults(
  outputs: Readonly<Record<string, string>> | undefined,
): GitCommitPushRepoOutput[] | null {
  const rawResults = outputs?.results_json;
  if (!rawResults) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawResults);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter(
      (entry): entry is GitCommitPushRepoOutput =>
        typeof entry === 'object' && entry !== null,
    );
  } catch {
    return null;
  }
}

/** Runs the worktree's precommit-failure hook for each repo whose commit failed. */
export async function firePrecommitFailureHooks(args: {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly results: readonly GitCommitPushRepoOutput[];
  readonly getWindow?: () => BrowserWindow | null;
}): Promise<void> {
  const failedCommitResults = args.results.filter(
    (result) =>
      result.status === 'failed' &&
      result.failurePhase === 'commit' &&
      typeof result.repoPath === 'string' &&
      typeof result.repoName === 'string',
  );

  if (failedCommitResults.length === 0) {
    return;
  }

  const { triggerWorktreePrecommitFailureHook } =
    await import('../lib/worktree-precommit-failure-hook');

  await Promise.all(
    failedCommitResults.map((result) =>
      triggerWorktreePrecommitFailureHook({
        projectId: args.projectId,
        worktreeId: args.worktreeId,
        repo: {
          repoPath: result.repoPath ?? '',
          repoId: result.repoId,
          repoName: result.repoName ?? '',
        },
        error: result.precommitFailureError ?? result.error ?? '',
        commitMessage: result.commitMessage,
        getWindow: args.getWindow,
      }).catch(() => {}),
    ),
  );
}

/**
 * Shows a step's desktop notifications, for in-process runs and for daemon
 * runs Electron main follows (CAN-5868).
 */
export function deliverPipelineStepNotifications(
  notifications: readonly PipelineStepNotification[],
  scope: { projectId?: string; worktreeId?: string },
  getWindow?: () => BrowserWindow | null,
): void {
  // A custom notification step carries no typed attention or failure
  // reason, so it is routine activity in the run's space (CAN-3615).
  if (
    scope.projectId &&
    scope.worktreeId &&
    !isSpaceNotificationDeliverable(
      { projectId: scope.projectId, worktreeId: scope.worktreeId },
      'routine',
    )
  )
    return;
  for (const notification of notifications) {
    showOsNotification(
      {
        id: `pipeline-${randomUUID()}`,
        title: notification.title,
        body: notification.body,
      },
      () => getWindow?.() ?? null,
    );
  }
}

export function createDesktopStepPostProcess(
  getWindow?: () => BrowserWindow | null,
): (ctx: StepPostProcessContext) => Promise<void> {
  return async (ctx) => {
    deliverPipelineStepNotifications(ctx.notifications ?? [], ctx, getWindow);

    if (
      ctx.step.uses !== 'builtin/git-commit-push' ||
      !ctx.projectId ||
      !ctx.worktreeId
    ) {
      return;
    }

    await firePrecommitFailureHooks({
      projectId: ctx.projectId,
      worktreeId: ctx.worktreeId,
      results: readGitCommitPushResults(ctx.outputs) ?? [],
      getWindow,
    });
  };
}
