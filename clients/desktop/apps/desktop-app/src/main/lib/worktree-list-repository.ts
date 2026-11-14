import {
  parseWorktreeList as parseCoreWorktreeList,
  type W5WorktreeListReadRow,
  type WorktreeListRead as CoreWorktreeListRead,
  type WorktreeListRepository as CoreWorktreeListRepository,
} from '@canopy/core-runtime/node/w5/worktree-list-repository';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { afterW5Apply } from './w5-commit-scope';
import {
  forgetWorktreeDiscovery,
  storeWorktreeDiscovery,
  withCachedWorktreeDiscovery,
  type WorktreeDiscoveryPath,
} from './worktree-discovery-cache';

export { WorktreeRegistryUnreadableError } from '@canopy/core-runtime/node/w5/worktree-list-repository';

export type WorktreeListRead = CoreWorktreeListRead<WorktreeData>;
export type WorktreeListRepository = CoreWorktreeListRepository<WorktreeData>;
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
  list: WorktreeListRepository,
  discoveryFilePath: WorktreeDiscoveryPath,
): WorktreeListRepository {
  const ids = (read: WorktreeListRead): string[] =>
    read.authority === 'ok' ? read.worktrees.map((row) => row.id) : [];
  return {
    async read(workspaceId): Promise<WorktreeListRead> {
      const read = await list.read(workspaceId);
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
