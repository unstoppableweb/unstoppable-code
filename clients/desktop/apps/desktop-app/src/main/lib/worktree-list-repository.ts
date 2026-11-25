import {
  parseWorktreeList as parseCoreWorktreeList,
  type W5WorktreeListReadRow,
  type WorktreeListRead as CoreWorktreeListRead,
  type WorktreeListRepository as CoreWorktreeListRepository,
} from '@canopy/core-runtime/node/w5/worktree-list-repository';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { afterW5Apply } from './w5-commit-scope';
import { createW5ImageReadCache } from './w5-read-view';
import { w5RecordReadPaths } from './paths';
import {
  forgetWorktreeDiscovery,
  storeWorktreeDiscovery,
  withCachedWorktreeDiscovery,
  type WorktreeDiscoveryPath,
} from './worktree-discovery-cache';

export { WorktreeRegistryUnreadableError } from '@canopy/core-runtime/node/w5/worktree-list-repository';

export type WorktreeListRead = CoreWorktreeListRead<WorktreeData>;
export interface WorktreeListRepository extends CoreWorktreeListRepository<WorktreeData> {
  /** The committed registry alone, without provider discovery enrichment. */
  readCommitted(workspaceId: string): Promise<WorktreeListRead>;
}
// The row keeps every stored field, as the list reader always has.
function readRow(row: W5WorktreeListReadRow): WorktreeData {
  return row;
}

export function parseWorktreeList(
  raw: string,
  workspaceId: string,
): WorktreeListRead {
  return parseCoreWorktreeList(raw, workspaceId, readRow);
}

/** Discovery sidecars are non-W5 effects, applied only after the list commits. */
export function withWorktreeDiscovery(
  list: CoreWorktreeListRepository<WorktreeData>,
  discoveryFilePath: WorktreeDiscoveryPath,
): WorktreeListRepository {
  const cachedRead = createW5ImageReadCache<WorktreeListRead>();
  const readCommitted = (workspaceId: string): Promise<WorktreeListRead> =>
    cachedRead(w5RecordReadPaths.worktrees(workspaceId), () =>
      list.read(workspaceId),
    );
  const ids = (read: WorktreeListRead): string[] =>
    read.authority === 'ok' ? read.worktrees.map((row) => row.id) : [];
  return {
    readCommitted,
    async read(workspaceId): Promise<WorktreeListRead> {
      const read = await readCommitted(workspaceId);
      return read.authority === 'ok'
        ? {
            ...read,
            worktrees: await withCachedWorktreeDiscovery(
              workspaceId,
              read.worktrees,
              discoveryFilePath,
            ),
          }
        : read;
    },
    // The files follow the list only once its commit applies, so a refused
    // or aborted decision leaves both as they were.
    async remove(workspaceId): Promise<void> {
      const removed = ids(await list.read(workspaceId));
      await list.remove(workspaceId);
      await afterW5Apply(() =>
        forgetWorktreeDiscovery(workspaceId, removed, discoveryFilePath),
      );
    },
    async replace(workspaceId, worktrees, previous): Promise<string> {
      const contents = await list.replace(
        workspaceId,
        worktrees.map(({ discovery: _discovery, ...row }) => {
          void _discovery;
          return row;
        }),
        previous,
      );
      const kept = new Set(worktrees.map((row) => row.id));
      const removed = ids(previous).filter((id) => !kept.has(id));
      await afterW5Apply(async () => {
        await storeWorktreeDiscovery(workspaceId, worktrees, discoveryFilePath);
        // A removed row's file goes with its data directory; a reused id
        // must not see what this process read for the old worktree.
        await forgetWorktreeDiscovery(workspaceId, removed, discoveryFilePath);
      });
      return contents;
    },
  };
}
