import {
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
  type StorageWriterPrincipal,
} from '../../storage';
import type { W5StorageTarget } from './storage-target';

/** Compiled ownership, never a runtime opt-in; mixed ownership is not activation. */
export function isW5DaemonHostingRequired(): boolean {
  return (
    ['workspace_index', 'workspace_manifest', 'worktree_list'] as const
  ).every(
    (namespace) =>
      evaluateStorageWrite(namespace, 'daemon', STORAGE_OWNERSHIP).allowed,
  );
}

/**
 * The host's storage admission: admits every target before the operation's
 * first write and holds their ownership until it settles. The host keeps the
 * implementation and its process-local state.
 */
export type W5StorageAdmission = <T>(
  targets: readonly W5StorageTarget[],
  operation: () => Promise<T>,
) => Promise<T>;

export interface W5StorageBinding {
  workspaceIndex: W5StorageTarget;
  workspaceManifest: W5StorageTarget;
  worktreeList: W5StorageTarget;
  /**
   * Every W5 namespace. Cowork operations admit it too: the sidebar writer
   * rewrites each repository sibling's worktree list.
   */
  project: W5StorageTarget[];
  /** The injected admission, unchanged. */
  admit: W5StorageAdmission;
}

/** `writer` must come from trusted host composition, never a request. */
export function bindW5Storage(
  writer: StorageWriterPrincipal,
  admit: W5StorageAdmission,
): W5StorageBinding {
  const workspaceIndex: W5StorageTarget = {
    namespace: 'workspace_index',
    writer,
  };
  const workspaceManifest: W5StorageTarget = {
    namespace: 'workspace_manifest',
    writer,
  };
  const worktreeList: W5StorageTarget = { namespace: 'worktree_list', writer };
  return {
    workspaceIndex,
    workspaceManifest,
    worktreeList,
    project: [workspaceIndex, workspaceManifest, worktreeList],
    admit,
  };
}
