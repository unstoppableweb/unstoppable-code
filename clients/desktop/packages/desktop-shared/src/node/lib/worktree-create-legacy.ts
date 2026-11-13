import { randomUUID } from 'node:crypto';
import { getCanopyDataDir } from '../../canopy-paths';
import { worktreeListProcessLock } from '@canopy/execution-engine/node/w5-host-cohort/process-file-lock';
import { createNodeW5FileStore } from '@canopy/core-runtime/node/w5/file-store';
import type {
  CreateWorktreeResponse,
  CreateWorkspaceWorktreeResponse,
  WorktreeData,
} from '../../types';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';
import { withStorageAdmission } from '@canopy/execution-engine/node/lib/storage-admission';
import { getWorkspaceItem } from './workspace-cli-reads';
import {
  multiRepoGitEntries,
  getSingleRepoWorktreeDir,
  getMultiRepoWorktreeDir,
  getWorktreesFilePath,
} from './worktree-cli-reads';
import type { CreateWorktreeServiceOptions } from './worktree-service';
import {
  lockCheckout,
  ownedCliWorktreeCreations,
  WorktreeCreationConflictError,
  updateCliWorktreeList,
  readCliWorktreeList,
} from './worktree-create-records';
import {
  buildTrackedRepoBaseBranches,
  createWorktreeGit,
  makeWorktreeId,
  normalizeBranchName,
  seedCreatedWorktreePanelLayoutMode,
} from './worktree-create-effects';

// B7 deletes this composition when CLI creation is daemon-only.
async function createLegacyWorktree(
  options: CreateWorktreeServiceOptions,
  kind: 'single-repo' | 'multi-repo',
): Promise<WorktreeData & { needsRepair?: false }> {
  return withStorageAdmission(
    [{ namespace: 'worktree_list', writer: 'desktop_cli' }],
    async () => {
      const workspace = await getWorkspaceItem(options.workspaceId);
      if (workspace.type !== kind)
        throw new Error(`Project ${options.workspaceId} is not ${kind}`);
      const store = createNodeW5FileStore(writeFileAtomically);
      // Git holds only the checkout lock; publication rereads under the list lock.
      const current = await readCliWorktreeList(store, workspace.id);
      const explicitBranch = normalizeBranchName(options.branchName);
      const id = makeWorktreeId(
        [
          ...current.map((row) => row.id),
          ...(options.existingWorktreeIds ?? []),
        ],
        explicitBranch,
      );
      const worktree: WorktreeData & { cliCreationToken: string } = {
        id,
        cliCreationToken: randomUUID(),
        branchName: explicitBranch ?? id,
        createdAt: new Date().toISOString(),
        ...(workspace.type === 'single-repo'
          ? { trackedBaseBranch: options.baseBranch }
          : {
              trackedRepoBaseBranches: buildTrackedRepoBaseBranches(
                multiRepoGitEntries(workspace, id),
                options.baseBranch,
              ),
            }),
      };
      return lockCheckout(workspace.id, id, async () => {
        try {
          await createWorktreeGit(workspace, worktree, options);
          await worktreeListProcessLock(getCanopyDataDir())(
            [getWorktreesFilePath(workspace.id)],
            async () => {
              await updateCliWorktreeList(store, workspace.id, (rows) => {
                if (
                  rows.some(
                    (row) =>
                      row.id === id || row.branchName === worktree.branchName,
                  )
                )
                  throw new WorktreeCreationConflictError(id, []);
                return { rows: [worktree, ...rows], value: undefined };
              });
              ownedCliWorktreeCreations.set(
                getWorktreesFilePath(workspace.id) + ':' + id,
                worktree.cliCreationToken,
              );
            },
          );
        } catch (error) {
          // Git can leave partial effects; an unowned checkout must never be removed.
          throw new WorktreeCreationConflictError(
            id,
            workspace.type === 'single-repo'
              ? [getSingleRepoWorktreeDir(workspace.id, id)]
              : [
                  getMultiRepoWorktreeDir(workspace.id, id),
                  ...multiRepoGitEntries(workspace, id).map(
                    (entry) => entry.worktreePath,
                  ),
                ],
            error,
          );
        }
        await seedCreatedWorktreePanelLayoutMode(options, id);
        const { cliCreationToken, ...result } = worktree;
        void cliCreationToken;
        return {
          ...result,
          ...(workspace.type === 'multi-repo' ? { needsRepair: false } : {}),
        };
      });
    },
  );
}

export function createSingleRepoWorktree(
  options: CreateWorktreeServiceOptions,
): Promise<CreateWorktreeResponse> {
  return createLegacyWorktree(options, 'single-repo');
}
export function createMultiRepoWorktree(
  options: CreateWorktreeServiceOptions,
): Promise<CreateWorkspaceWorktreeResponse> {
  return createLegacyWorktree(options, 'multi-repo');
}
