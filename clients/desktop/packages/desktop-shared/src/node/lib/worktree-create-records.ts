import { getCanopyDataDir } from '../../canopy-paths';
import { withW5ProcessFileLocks } from '@canopy/execution-engine/node/w5-host-cohort/process-file-lock';
import type { W5FileStore } from '@canopy/core-runtime/node/w5/file-store';
import { withW5RepositoryLocks } from '@canopy/core-runtime/node/w5/repository-locks';
import {
  createWorktreeListRepository,
  WorktreeRegistryUnreadableError,
} from '@canopy/core-runtime/node/w5/worktree-list-repository';
import type { WorktreeData } from '../../types';
import type { WorktreeListRepository } from '@canopy/core-runtime/node/w5/worktree-list-repository';
import { withStorageAdmission } from '@canopy/execution-engine/node/lib/storage-admission';
import {
  getSingleRepoWorktreeDir,
  getWorktreesFilePath,
  normalizeWorktree,
} from './worktree-cli-reads';

/** Read/decide/replace under one list lock; Git never holds it. */
function repositoryFor(
  store: W5FileStore,
): WorktreeListRepository<WorktreeData> {
  return createWorktreeListRepository<WorktreeData>({
    store,
    filePath: getWorktreesFilePath,
    storage: { namespace: 'worktree_list', writer: 'desktop_cli' },
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
  store: W5FileStore,
  workspaceId: string,
): Promise<WorktreeData[]> {
  const read = await repositoryFor(store).read(workspaceId);
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
  store: W5FileStore,
  workspaceId: string,
  decide: (rows: WorktreeData[]) => { rows: WorktreeData[]; value: T },
): Promise<T> {
  const worktreeListRepository = repositoryFor(store);
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

/** A failed create keeps its primary error and names effects needing cleanup. */
export class WorktreeCreationConflictError extends Error {
  constructor(
    readonly worktreeId: string,
    readonly remainingPaths: readonly string[],
    cause?: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : 'This worktree could not be saved safely. Its existing files have been kept.',
    );
    this.name = 'WorktreeCreationConflictError';
    Object.defineProperty(this, 'cause', { value: cause, configurable: true });
  }
}

export const ownedCliWorktreeCreations: Map<string, string> = new Map();

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
