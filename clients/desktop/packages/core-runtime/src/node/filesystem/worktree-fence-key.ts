import { realpath, realpathSync } from 'node:fs';
import { CanopyOperationError } from '../../runtime/errors';

/**
 * Finds a worktree's root directory from a workspace and a worktree
 * reference: today's worktree id, or any other form the host's records accept
 * (CAN-4730). No reference names a Cowork workspace's home. Undefined when
 * the reference names no worktree.
 */
export type WorktreeRootLookup<Ref extends string | undefined = string> = (
  workspaceId: string,
  worktreeRef: Ref,
) => string | undefined | Promise<string | undefined>;

export type WorktreeRootLookupSync = (
  workspaceId: string,
  worktreeRef: string,
) => string | undefined;

/** `fs.realpath.native`, which only the callback API offers. */
function realpathNative(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpath.native(path, (error, resolved) => {
      if (error) reject(error);
      else resolve(resolved);
    });
  });
}

function unresolved(cause?: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      message:
        'This worktree could not be resolved, so it is treated as fenced.',
      details: { fence: 'unresolved' },
      retry: { kind: 'never' },
    },
    cause,
  );
}

/**
 * The one key every mutation fence uses for a worktree: its root, resolved
 * through symlinks and, on case-insensitive volumes, to the case it is
 * stored with (`realpath.native`). Two references to the same worktree get
 * the same key, whatever form they take; a reference that cannot be
 * resolved is refused, never keyed by its raw id.
 */
export async function worktreeFenceKey<Ref extends string | undefined = string>(
  workspaceId: string,
  worktreeRef: Ref,
  lookupWorktreeRoot: WorktreeRootLookup<Ref>,
): Promise<string> {
  const root = await lookupWorktreeRoot(workspaceId, worktreeRef);
  if (!root) throw unresolved();
  try {
    return await realpathNative(root);
  } catch (error) {
    throw unresolved(error);
  }
}

/** `worktreeFenceKey` for synchronous hosts, such as the desktop split lock. */
export function worktreeFenceKeySync(
  workspaceId: string,
  worktreeRef: string,
  lookupWorktreeRoot: WorktreeRootLookupSync,
): string {
  const root = lookupWorktreeRoot(workspaceId, worktreeRef);
  if (!root) throw unresolved();
  try {
    return realpathSync.native(root);
  } catch (error) {
    throw unresolved(error);
  }
}
