import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  SINGLE_REPO_USAGE_REPO_ID,
  WORKSPACE_ROOT_REPO_ID,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { getCurrentBranch } from './git';
import { getWorkspaceWorktreeDir, getWorkspaceWorktreeRepoDir } from './paths';
import { isErrnoException } from './type-guards';
import { readWorkspaceConfig } from './workspace-persistence';
import { readEffectiveWorkspaceConfig } from './workspace-source';

export interface AutoArchiveBranchPin {
  repoId: string;
  /** Null pins detached HEAD. Undefined means Git metadata could not be read. */
  branchName: string | null | undefined;
}

interface AutoArchiveCheckout extends AutoArchiveBranchPin {
  referenceRepoPath: string;
}

export async function readAutoArchiveBranches(
  workspaceId: string,
  worktreeId: string,
  surface: 'single-repo' | 'multi-repo',
  worktree?: WorktreeData,
): Promise<AutoArchiveCheckout[]> {
  const rootPath = getWorkspaceWorktreeDir(workspaceId, worktreeId);
  const observations: AutoArchiveCheckout[] = [];
  const observe = async (
    repoId: string,
    checkout: string,
    referenceRepoPath: string,
  ): Promise<void> => {
    // Missing and files-only checkouts still go through archive's existing
    // recovery admission. Git must never discover an enclosing checkout here.
    const dotGit = join(checkout, '.git');
    const entry = await lstat(dotGit).catch((error: unknown) => {
      if (
        isErrnoException(error) &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR')
      )
        return null;
      throw error;
    });
    if (!entry) {
      const checkoutEntry = await lstat(checkout).catch((error: unknown) => {
        if (isErrnoException(error) && error.code === 'ENOENT') return null;
        throw error;
      });
      if (checkoutEntry?.isDirectory() || checkoutEntry?.isFile())
        observations.push({ repoId, branchName: undefined, referenceRepoPath });
      return;
    }
    const branch = await getCurrentBranch(checkout).catch(
      async (error: unknown) => {
        if (!entry.isFile()) throw error;
        const pointer = /^gitdir:\s*(.+)$/i.exec(
          (await readFile(dotGit, 'utf8')).trim(),
        )?.[1];
        if (!pointer) throw error;
        try {
          await lstat(resolve(checkout, pointer, 'HEAD'));
        } catch (metadataError) {
          if (
            isErrnoException(metadataError) &&
            metadataError.code === 'ENOENT'
          )
            return undefined;
          throw metadataError;
        }
        throw error;
      },
    );
    observations.push({
      repoId,
      branchName: branch === 'HEAD' ? null : branch,
      referenceRepoPath,
    });
  };

  if (surface === 'single-repo') {
    const config = await readWorkspaceConfig(workspaceId);
    if (!config.repoPath)
      throw new Error('The main checkout is unavailable for branch preflight');
    await observe(SINGLE_REPO_USAGE_REPO_ID, rootPath, config.repoPath);
  } else {
    const config = await readEffectiveWorkspaceConfig(workspaceId);
    for (const repo of config.repos) {
      if (
        worktree?.includedRepoIds &&
        !worktree.includedRepoIds.includes(repo.id)
      )
        continue;
      await observe(
        repo.id,
        getWorkspaceWorktreeRepoDir(workspaceId, worktreeId, repo.id),
        repo.repoPath,
      );
    }
    if (config.sourceRepoPath)
      await observe(WORKSPACE_ROOT_REPO_ID, rootPath, config.sourceRepoPath);
  }
  return observations;
}

export function autoArchiveBranchesMatch(
  expected: readonly AutoArchiveBranchPin[],
  actual: readonly AutoArchiveBranchPin[],
  allowUnreadable = false,
): boolean {
  return (
    expected.length === actual.length &&
    expected.every(({ repoId, branchName }) =>
      actual.some(
        (branch) =>
          branch.repoId === repoId &&
          (branch.branchName === branchName ||
            (allowUnreadable && branchName === undefined)),
      ),
    )
  );
}
