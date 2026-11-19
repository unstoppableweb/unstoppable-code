import {
  worktreeFenceKey,
  worktreeFenceKeySync,
  type WorktreeRootLookupSync,
} from '@canopy/core-runtime/node';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import {
  setSplitLockKeyResolver,
  type SplitLockKeyResolver,
} from './split-lock-service';

/** Split locks keyed by the daemon's fence key over a worktree-root lookup. */
export function splitLockKeyResolverFor(
  lookup: WorktreeRootLookupSync,
): SplitLockKeyResolver {
  return {
    key: (workspaceId, worktreeId) =>
      worktreeFenceKey(workspaceId, worktreeId, lookup),
    keySync: (workspaceId, worktreeId) =>
      worktreeFenceKeySync(workspaceId, worktreeId, lookup),
  };
}

/** A worktree's root as every desktop host finds it; undefined if unknown. */
function desktopWorktreeRoot(
  workspaceId: string,
  worktreeId: string,
): string | undefined {
  try {
    return resolveWorktreeCwd(workspaceId, worktreeId);
  } catch {
    return undefined;
  }
}

/** Main startup: key split locks before any Split PR can start. */
export function installSplitLockKeyResolver(): () => void {
  return setSplitLockKeyResolver(splitLockKeyResolverFor(desktopWorktreeRoot));
}
