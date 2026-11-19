import { requestDesktopSessionSnapshotInvalidation } from './desktop-session-snapshot-invalidation';

/**
 * Host presentation state for the window between a desktop-created worktree's
 * Git readiness and the settle of its post-create setup. The persisted
 * `git-pending` phase covers reservation through Git readiness; this covers
 * the rest, so the session snapshot projects `running-setup` with no idle gap
 * before the setup script's own run state reaches a client.
 *
 * In-memory only: after an app restart the setup process is gone and the row
 * is correctly idle. Not a canonical write.
 */
const activeSetups = new Map<string, symbol>();

function key(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}\u0000${worktreeId}`;
}

/**
 * Marks the worktree's post-create setup active and returns its idempotent
 * end function. A second begin for the same worktree replaces the first; the
 * stale end function then does nothing.
 */
export function beginWorktreePostCreateSetup(
  workspaceId: string,
  worktreeId: string,
): () => void {
  const setupKey = key(workspaceId, worktreeId);
  const token = Symbol(setupKey);
  const replaced = activeSetups.has(setupKey);
  activeSetups.set(setupKey, token);
  if (!replaced)
    requestDesktopSessionSnapshotInvalidation('worktree-setup.begin');
  return (): void => {
    if (activeSetups.get(setupKey) !== token) return;
    activeSetups.delete(setupKey);
    requestDesktopSessionSnapshotInvalidation('worktree-setup.end');
  };
}

/** Ends any active post-create setup for the worktree, such as on teardown. */
export function endWorktreePostCreateSetup(
  workspaceId: string,
  worktreeId: string,
): void {
  if (activeSetups.delete(key(workspaceId, worktreeId))) {
    requestDesktopSessionSnapshotInvalidation('worktree-setup.end');
  }
}

export function isWorktreePostCreateSetupActive(
  workspaceId: string,
  worktreeId: string,
): boolean {
  return activeSetups.has(key(workspaceId, worktreeId));
}
