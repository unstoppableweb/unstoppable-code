import {
  inspectWorktreeCreationRecovery,
  repairOrphanedWorktreeRegistration,
} from './worktree-create-recovery';
import { readWorkspaceConfig } from './workspace-persistence';
import { logMainProcessWarn } from './main-process-logging';
import { reportDestructiveRecovery } from './w5-destructive-recovery';
import { rm, stat } from 'node:fs/promises';
import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type MultiRepoSidebarItem,
  type SingleRepoSidebarItem,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { getCurrentBranch, listRegisteredWorktreePaths } from './git';
import {
  getWorktreeDataDir,
  getWorktreeDir,
  getWorkspaceWorktreeDir,
  getWorkspaceWorktreeRepoDir,
  getWorkspaceWorktreeRootRepoDir,
} from './paths';
import { resolveProjectReferenceRepoPath } from './project-reference-repo';
import { startProjectWorktreePostCreateSetup } from './project-worktree-runtime';
import { resolveWorkspaceReferenceRepoPath } from './workspace-reference-repo';
import { listWorkspaceItems } from './workspace-service';
import { startWorkspaceWorktreePostCreateSetup } from './workspace-worktree-runtime';
import { mapWithConcurrency } from './concurrency';
import { reconcileWorktreeRecovery } from './worktree-repair';
import { sendToWindow } from './window-send';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from './w5-storage';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  rollbackPersistedReservation,
  rollbackWorkspaceWorktree,
} from './worktree-service';
import {
  detachedWorkCallback,
  settleAll,
} from '@canopy/desktop-shared/node/lib/detached-work';

type PendingReconcileResult = 'kept' | 'removed';

const MISSING_WORKTREE_RECONCILE_CONCURRENCY = 8;

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isRegisteredWorktree(
  repoPath: string,
  worktreePath: string,
): Promise<boolean> {
  const registeredPaths = await listRegisteredWorktreePaths(repoPath);
  return registeredPaths.has(worktreePath);
}

function startRecoveredSingleRepoPostCreateSetup(
  workspace: SingleRepoSidebarItem,
  worktreeId: string,
  getWindow: () => BrowserWindow | null,
): void {
  try {
    detachedWorkCallback(() =>
      startProjectWorktreePostCreateSetup({
        projectId: workspace.id,
        worktreeId,
        project: {
          repoPath: workspace.repoPath,
          scripts: workspace.scripts,
        },
        getWindow,
      }),
    )();
  } catch {
    // Recovery should never fail merely because the follow-up setup crashed.
  }
}

function startRecoveredWorkspacePostCreateSetup(
  workspace: MultiRepoSidebarItem,
  worktree: WorktreeData,
  getWindow: () => BrowserWindow | null,
): void {
  const includedRepoIds = worktree.includedRepoIds;
  const repos =
    includedRepoIds === undefined
      ? workspace.repos
      : workspace.repos.filter((repo) => includedRepoIds.includes(repo.id));
  try {
    detachedWorkCallback(() =>
      startWorkspaceWorktreePostCreateSetup({
        workspaceId: workspace.id,
        worktreeId: worktree.id,
        repos,
        getWindow,
      }),
    )();
  } catch {
    // Recovery should never fail merely because the follow-up setup crashed.
  }
}

/**
 * Promotes the pending row launch read, through
 * `internal.worktree.recovery.reconcile`. Returns false when the row was
 * archived, recreated or promoted since, so its setup is not started again.
 */
async function promotePendingWorktree(
  workspaceId: string,
  worktree: WorktreeData,
  branchName: string,
): Promise<boolean> {
  const { status } = await reconcileWorktreeRecovery({
    kind: 'promote-pending',
    workspaceId,
    worktreeId: worktree.id,
    createdAt: worktree.createdAt,
    branchName,
  });
  return status === 'recorded';
}

function rollbackPendingSingleRepoWorktree(
  ...args: Parameters<typeof rollbackAdmittedSingleRepoWorktree>
): Promise<void> {
  // Admitted before removing the reservation, checkout or git worktrees.
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    rollbackAdmittedSingleRepoWorktree(...args),
  );
}

async function rollbackAdmittedSingleRepoWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  const worktreePath = getWorktreeDir(workspaceId, worktreeId);
  await rollbackPersistedReservation(
    workspaceId,
    worktreeId,
    getWorktreeDataDir(workspaceId, worktreeId),
  );
  await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
}

function rollbackPendingMultiRepoWorktree(
  ...args: Parameters<typeof rollbackAdmittedMultiRepoWorktree>
): Promise<void> {
  // Admitted before removing the reservation, checkout or git worktrees.
  return withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    rollbackAdmittedMultiRepoWorktree(...args),
  );
}

async function rollbackAdmittedMultiRepoWorktree(
  workspace: MultiRepoSidebarItem,
  worktree: WorktreeData,
  referenceRepoPath?: string,
): Promise<void> {
  const includedRepoIds = worktree.includedRepoIds;
  const repos =
    includedRepoIds === undefined
      ? workspace.repos
      : workspace.repos.filter((repo) => includedRepoIds.includes(repo.id));
  await rollbackWorkspaceWorktree(
    workspace.id,
    worktree.id,
    getWorkspaceWorktreeDir(workspace.id, worktree.id),
    repos,
    repos.map((repo) => repo.id),
    referenceRepoPath,
  ).catch(() => {});
  await rollbackPersistedReservation(
    workspace.id,
    worktree.id,
    getWorktreeDataDir(workspace.id, worktree.id),
  );
}

async function reconcileSingleRepoPendingWorktree(
  workspace: SingleRepoSidebarItem,
  worktree: WorktreeData,
  getWindow: () => BrowserWindow | null,
): Promise<PendingReconcileResult> {
  const referenceRepoPath = await resolveProjectReferenceRepoPath(
    workspace.repoPath,
  );
  const worktreePath = getWorktreeDir(workspace.id, worktree.id);
  const valid =
    (await pathExists(worktreePath)) &&
    (await isRegisteredWorktree(referenceRepoPath, worktreePath));

  if (valid) {
    const canonicalBranchName =
      (await getCurrentBranch(worktreePath).catch(() => undefined)) ||
      worktree.branchName;
    if (
      await promotePendingWorktree(workspace.id, worktree, canonicalBranchName)
    ) {
      startRecoveredSingleRepoPostCreateSetup(
        workspace,
        worktree.id,
        getWindow,
      );
    }
    return 'kept';
  }

  await rollbackPendingSingleRepoWorktree(workspace.id, worktree.id);
  return 'removed';
}

async function reconcileMultiRepoPendingWorktree(
  workspace: MultiRepoSidebarItem,
  worktree: WorktreeData,
  getWindow: () => BrowserWindow | null,
): Promise<PendingReconcileResult> {
  if (!workspace.sourceRepoPath) {
    await rollbackPendingMultiRepoWorktree(workspace, worktree);
    return 'removed';
  }

  const referenceRepoPath = await resolveWorkspaceReferenceRepoPath(
    workspace.sourceRepoPath,
  );
  const rootWorktreePath = getWorkspaceWorktreeRootRepoDir(
    workspace.id,
    worktree.id,
  );
  const includedRepoIds = worktree.includedRepoIds;
  const repos =
    includedRepoIds === undefined
      ? workspace.repos
      : workspace.repos.filter((repo) => includedRepoIds.includes(repo.id));
  const childChecks = await settleAll(
    repos.map(async (repo) => {
      const repoWorktreePath = getWorkspaceWorktreeRepoDir(
        workspace.id,
        worktree.id,
        repo.id,
      );
      return (
        (await pathExists(repoWorktreePath)) &&
        (await isRegisteredWorktree(repo.repoPath, repoWorktreePath))
      );
    }),
  );
  const valid =
    (await pathExists(rootWorktreePath)) &&
    (await isRegisteredWorktree(referenceRepoPath, rootWorktreePath)) &&
    childChecks.every(Boolean);

  if (valid) {
    const resolvedBranchName =
      (await getCurrentBranch(rootWorktreePath)
        .then((branchName) =>
          branchName && branchName !== 'HEAD' ? branchName : undefined,
        )
        .catch(() => undefined)) ?? worktree.branchName;
    if (
      await promotePendingWorktree(workspace.id, worktree, resolvedBranchName)
    ) {
      startRecoveredWorkspacePostCreateSetup(workspace, worktree, getWindow);
    }
    return 'kept';
  }

  await rollbackPendingMultiRepoWorktree(
    workspace,
    worktree,
    referenceRepoPath,
  );
  return 'removed';
}

async function exposeInterruptedSplitReservation(
  workspace: SingleRepoSidebarItem | MultiRepoSidebarItem,
  worktree: WorktreeData,
): Promise<void> {
  const worktreePath =
    workspace.type === 'single-repo'
      ? getWorktreeDir(workspace.id, worktree.id)
      : getWorkspaceWorktreeDir(workspace.id, worktree.id);
  await reconcileWorktreeRecovery({
    kind: 'expose-split-reservation',
    workspaceId: workspace.id,
    worktreeId: worktree.id,
    createdAt: worktree.createdAt,
    worktreePath,
  });
}

function createWorktreeReconcileKey(
  workspaceId: string,
  worktreeId: string,
): string {
  return `${workspaceId}/${worktreeId}`;
}

function logReconcileError(
  workspaceId: string,
  worktreeId: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[worktree-boot-recovery] Failed to reconcile ${workspaceId}/${worktreeId}: ${message}\n`,
  );
}

async function reconcileMissingReadyWorktree(
  workspace: SingleRepoSidebarItem | MultiRepoSidebarItem,
  worktree: WorktreeData,
): Promise<boolean> {
  if (worktree.creation && worktree.creation.state !== 'complete') return false;
  if (worktree.setupPhase === 'git-pending') {
    return false;
  }
  if (worktree.splitRecoveryRequired === true) {
    // A split rollback failure can retain migrated data without a usable Git
    // checkout. Keep that durable recovery row intact for explicit repair;
    // generic missing-worktree recovery must not archive or reap it.
    return false;
  }

  const worktreePath =
    workspace.type === 'single-repo'
      ? getWorktreeDir(workspace.id, worktree.id)
      : getWorkspaceWorktreeDir(workspace.id, worktree.id);
  if (await pathExists(worktreePath)) {
    return false;
  }

  // The checkout is gone but the worktree's chats/summaries/pipeline data
  // live outside it and are intact — honor the workspace's retention setting
  // so recovery archives them instead of silently hard-deleting.
  if (workspace.type === 'single-repo') {
    await archiveSingleRepoWorktree({
      archiveTrigger: 'internal-rollback',
      workspaceId: workspace.id,
      worktreeId: worktree.id,
      repoPath: workspace.repoPath,
    });
    return true;
  }

  await archiveMultiRepoWorktree({
    archiveTrigger: 'internal-rollback',
    workspaceId: workspace.id,
    worktreeId: worktree.id,
  });
  return true;
}

export async function reconcileGitPendingWorktrees(
  getWindow: () => BrowserWindow | null = () => null,
): Promise<void> {
  const recovery = await reportDestructiveRecovery();
  for (const record of recovery) {
    if (!record.archiveRecoveryCleanup?.some((entry) => !entry.done)) continue;
    await (
      await import('./chat-project-operation-queue')
    )
      .serializeWorkspaceMutation(async () => {
        await (
          await import('./workspace-deletion')
        ).settleWorkspaceArchiveRecoveryCleanup(record);
      })
      .catch((error: unknown) => {
        // A committed parent keeps cleanup debt; missing Git is never reported as deleted refs.
        logMainProcessWarn(
          'Archive recovery parent cleanup remains incomplete',
          {
            operationId: record.operationId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      });
  }
  const interrupted = (workspaceId: string, worktreeId: string): boolean =>
    recovery.some(
      (record) =>
        record.state !== 'completed' &&
        record.workspaceId === workspaceId &&
        (record.worktreeId === undefined || record.worktreeId === worktreeId),
    );
  const workspaces = await listWorkspaceItems();

  for (const workspace of workspaces) {
    if (workspace.type === 'cowork') {
      continue;
    }

    const pendingWorktrees = workspace.worktrees.filter(
      (worktree) =>
        worktree.setupPhase === 'git-pending' &&
        !interrupted(workspace.id, worktree.id),
    );
    const removedPendingWorktreeKeys = new Set<string>();

    for (const worktree of pendingWorktrees) {
      try {
        if (worktree.creation) {
          await reconcileWorktreeRecovery({
            kind: 'expose-create-reservation',
            workspaceId: workspace.id,
            worktreeId: worktree.id,
            createdAt: worktree.createdAt,
            operationId: worktree.creation.operationId,
            worktreePath: getWorktreeDir(workspace.id, worktree.id),
          });
          continue;
        }
        if (worktree.splitRecoveryRequired === true) {
          await exposeInterruptedSplitReservation(workspace, worktree);
          continue;
        }
        const result =
          workspace.type === 'single-repo'
            ? await reconcileSingleRepoPendingWorktree(
                workspace,
                worktree,
                getWindow,
              )
            : await reconcileMultiRepoPendingWorktree(
                workspace,
                worktree,
                getWindow,
              );
        if (result === 'removed') {
          removedPendingWorktreeKeys.add(
            createWorktreeReconcileKey(workspace.id, worktree.id),
          );
        }
      } catch (error) {
        logReconcileError(workspace.id, worktree.id, error);
      }
    }

    try {
      const issues = await inspectWorktreeCreationRecovery(
        workspace.id,
        await readWorkspaceConfig(workspace.id),
      );
      for (const issue of issues) {
        if (issue.recovery?.phase === 'orphan-checkout') {
          try {
            if (
              await repairOrphanedWorktreeRegistration(
                workspace.id,
                await readWorkspaceConfig(workspace.id),
                issue.recovery,
              )
            )
              continue;
          } catch (error) {
            logReconcileError(
              workspace.id,
              'orphan-registration-repair',
              error,
            );
          }
        }
        logMainProcessWarn(
          'Worktree creation requires recovery',
          issue.recovery,
        );
      }
    } catch (error) {
      logReconcileError(workspace.id, 'recovery-inspection', error);
    }

    const missingReadyCandidates = workspace.worktrees.filter(
      (worktree) =>
        !interrupted(workspace.id, worktree.id) &&
        !removedPendingWorktreeKeys.has(
          createWorktreeReconcileKey(workspace.id, worktree.id),
        ),
    );
    const recoveredReadyWorktrees = await mapWithConcurrency(
      missingReadyCandidates,
      MISSING_WORKTREE_RECONCILE_CONCURRENCY,
      async (worktree) => {
        try {
          return await reconcileMissingReadyWorktree(workspace, worktree);
        } catch (error) {
          logReconcileError(workspace.id, worktree.id, error);
          return false;
        }
      },
    );
    if (pendingWorktrees.length > 0 || recoveredReadyWorktrees.some(Boolean)) {
      // Startup no longer awaits recovery. Persistence suppresses self-write
      // watcher echoes, so explicitly refresh the already visible inventory.
      sendToWindow(getWindow(), IPC_CHANNELS.worktreesFileChanged, {
        workspaceId: workspace.id,
      });
    }
  }
}
