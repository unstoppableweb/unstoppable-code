import {
  createW5RecordImageRepositories,
  createW5RecordImageReaders,
  type W5RecordImageStore,
} from '@canopy/core-runtime/node/w5/record-image-repositories';
import { getCanopyDataDir } from '../../canopy-paths';
import { withW5ProcessFileLocks } from '@canopy/execution-engine/node/w5-host-cohort/process-file-lock';
import type { W5FileStore } from '@canopy/core-runtime/node/w5/file-store';
import { withW5RepositoryLocks } from '@canopy/core-runtime/node/w5/repository-locks';
import { WorktreeRegistryUnreadableError } from '@canopy/core-runtime/node/w5/worktree-list-repository';
import type { WorktreeData } from '../../types';
import type { WorktreeListRepository } from '@canopy/core-runtime/node/w5/worktree-list-repository';
import { withStorageAdmission } from '@canopy/execution-engine/node/lib/storage-admission';
import { getWorkspacesRootDir } from './workspace-cli-reads';
import {
  getSingleRepoWorktreeDir,
  getWorktreesFilePath,
  normalizeWorktree,
} from './worktree-cli-reads';

/** Read/decide/replace under one list lock; Git never holds it. */
function repositoryFor(
  store: W5RecordImageStore,
): WorktreeListRepository<WorktreeData> {
  return createW5RecordImageRepositories({
    root: getWorkspacesRootDir,
    store,
  }).worktrees<WorktreeData>({
    writer: 'desktop_cli',
    // Full rows, including fields this CLI cannot interpret, survive a save.
    knownRowFields: new Set([
      'creation',
      'setupPhase',
      'trackedBaseBranch',
      'trackedRepoBaseBranches',
    ]),
    readRow: (row) => ({ ...row, ...normalizeWorktree(row) }),
  });
}

export async function readCliWorktreeList(
  store: Pick<W5FileStore, 'read'>,
  workspaceId: string,
): Promise<WorktreeData[]> {
  const read = await createW5RecordImageReaders({
    root: getWorkspacesRootDir,
    store,
  })
    .worktrees<WorktreeData>((row) => ({ ...row, ...normalizeWorktree(row) }))
    .read(workspaceId);
  if (
    read.authority === 'unreadable' ||
    (read.authority === 'ok' && !read.complete)
  )
    throw new WorktreeRegistryUnreadableError(
      read.authority === 'unreadable' ? read.error : undefined,
    );
  return read.authority === 'ok' ? read.worktrees : [];
}

export function updateCliWorktreeList<T>(
  store: W5RecordImageStore,
  workspaceId: string,
  decide: (rows: WorktreeData[]) => { rows: WorktreeData[]; value: T },
): Promise<T> {
  return updateCliWorktreeListRepository(
    repositoryFor(store),
    workspaceId,
    decide,
  );
}

/** Shared staging lock/admission policy over the routed image repository. */
export function updateCliWorktreeListRepository<T>(
  worktreeListRepository: WorktreeListRepository<WorktreeData>,
  workspaceId: string,
  decide: (rows: WorktreeData[]) => { rows: WorktreeData[]; value: T },
): Promise<T> {
  return withStorageAdmission(
    [{ namespace: 'worktree_list', writer: 'desktop_cli' }],
    () =>
      withW5RepositoryLocks(
        [{ kind: 'list', path: getWorktreesFilePath(workspaceId) }],
        async () => {
          const previous = await worktreeListRepository.read(workspaceId);
          if (
            previous.authority === 'unreadable' ||
            (previous.authority === 'ok' && !previous.complete)
          )
            throw new WorktreeRegistryUnreadableError(
              previous.authority === 'unreadable' ? previous.error : undefined,
            );
          const decided = decide(
            previous.authority === 'ok' ? previous.worktrees : [],
          );
          await worktreeListRepository.replace(
            workspaceId,
            decided.rows,
            previous,
          );
          return decided.value;
        },
      ),
  );
}

/** CLI lifecycle order: checkout resource, then list. Git holds no list lock. */
export function lockCheckout<T>(
  workspaceId: string,
  worktreeId: string,
  work: () => Promise<T>,
): Promise<T> {
  return withW5ProcessFileLocks(
    [getSingleRepoWorktreeDir(workspaceId, worktreeId)],
    { dataRoot: getCanopyDataDir() },
    work,
  );
}
