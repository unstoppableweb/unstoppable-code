import { realpath, lstat } from 'node:fs/promises';
import { getCanopyDataDir } from '@canopy/desktop-shared/canopy-paths';
import {
  ArchiveRecoveryStore,
  classifyArchiveRecovery,
  ArchiveRecoveryRefusedError,
  type ArchiveRecoveryReceipt,
} from '@canopy/desktop-shared/node/archive-recovery-store';

export function archiveRecoveryStore(): ArchiveRecoveryStore {
  return new ArchiveRecoveryStore(getCanopyDataDir());
}

export async function archiveRecoveryRepositoryIdentity(
  path: string,
): Promise<string> {
  const canonical = await realpath(path);
  const info = await lstat(canonical);
  if (!info.isDirectory())
    throw new ArchiveRecoveryRefusedError(
      'Recovery repository is not a directory.',
    );
  return `${canonical}:${info.dev}:${info.ino}:${info.birthtimeMs}`;
}

export async function readArchiveRecoveryHolds(
  workspaceId: string,
): Promise<ArchiveRecoveryReceipt[]> {
  return archiveRecoveryStore().list(workspaceId);
}

/** Cancellation leaves protection with the source journal until its completion is proved. */
export async function isArchiveRecoveryRefProtectionActive(
  receipt: ArchiveRecoveryReceipt,
): Promise<boolean> {
  if (receipt.retention === 'deleted') return false;
  if (!receipt.cancelled) return true;
  const scan = await (
    await import('./stranded-archive-journals')
  ).readArchiveJournalOperations(receipt.workspaceId);
  if (!scan.readable)
    throw new ArchiveRecoveryRefusedError(
      'Cancelled source-journal ownership is unreadable.',
    );
  const source = scan.operations.find(
    (operation) => operation.record.operationId === receipt.operationId,
  );
  if (!source) return true; // Missing evidence is not permission to release the source refs.
  if (!source.consistent)
    throw new ArchiveRecoveryRefusedError(
      'Cancelled source-journal copies conflict.',
    );
  return source.records.some(
    (record) => record.state !== 'completed' || record.cleanupRequired,
  );
}

/** Every ordinary release path uses this guard, including recapture, expiry and purge. */
export async function isArchiveRecoveryRefHeld(
  repoPath: string,
  refName: string,
  excludingOperationId?: string,
): Promise<boolean> {
  const workspaceId = /^refs\/app\/archived-containers\/([^/]+)\//.exec(
    refName,
  )?.[1];
  if (!workspaceId) return false;
  const holds = await readArchiveRecoveryHolds(workspaceId);
  const relevant = [];
  for (const hold of holds) {
    if (hold.operationId === excludingOperationId) continue;
    const repositories = hold.repositories.filter((repository) =>
      repository.refs.some((ref) => ref.name === refName),
    );
    if (
      repositories.length &&
      (await isArchiveRecoveryRefProtectionActive(hold))
    )
      relevant.push(...repositories);
  }
  if (relevant.length === 0) return false;
  const commonDir = await (await import('./git')).getGitCommonDir(repoPath);
  for (const repository of relevant) {
    const heldCommonDir = await realpath(repository.commonDir);
    if (
      (await archiveRecoveryRepositoryIdentity(heldCommonDir)) !==
      repository.identity
    )
      throw new ArchiveRecoveryRefusedError(
        'Retained recovery repository identity changed.',
      );
    if (heldCommonDir === commonDir) return true;
  }
  return false;
}

export async function assertNoArchiveResolution(
  workspaceId: string,
  worktreeId?: string,
  parentOperation?: 'workspace-delete',
): Promise<void> {
  const holds = await readArchiveRecoveryHolds(workspaceId);
  const pending = holds.find(
    (receipt) =>
      (worktreeId === undefined || parentOperation === 'workspace-delete'
        ? classifyArchiveRecovery(receipt).projectFence
        : classifyArchiveRecovery(receipt).worktreeFence) &&
      (worktreeId === undefined || worktreeId === receipt.worktreeId),
  );
  if (pending)
    throw new ArchiveRecoveryRefusedError(
      `Archive resolution ${pending.operationId} at ${pending.stage} must be resumed before another removal.`,
    );
}
