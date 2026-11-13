/**
 * Split PR lockdown authority.
 *
 * While a Split PR workflow is running (from resource termination through plan
 * review and execution) the target worktree must be frozen: no hooks, pipelines,
 * scripts, terminals, browsers, or worktree-targeted chat sends may start
 * against it. Temporary-workspace splits also claim each destination worktree
 * here until their background phase settles, preventing archive/delete races.
 * This service is the single in-memory authority for both lock types.
 *
 * The lock is intentionally NOT persisted. If the app restarts mid-split the
 * lock is dropped and the persisted split map (see `split-pr-persistence.ts`)
 * governs resume behavior instead.
 */

import { assertWorkspaceTargetRuntimeStartAllowed } from '../lib/workspace-target-exclusion';

/** Locked worktrees keyed by `${workspaceId}:${worktreeId}`. */
const lockedWorktrees = new Set<string>();
/** Workspace deletions exclude split starts for the full deletion lifetime. */
const workspaceDeletionLeases = new Set<string>();
/** Archive-retention writes exclude split planning for the same workspace. */
const workspaceArchiveRetentionLeases = new Set<string>();
/** Destination worktrees reserved by an active temporary-workspace split. */
const splitDestinationWorktreeClaims = new Set<string>();

export interface SplitLockChangeEvent {
  workspaceId: string;
  worktreeId: string;
  locked: boolean;
}

type SplitLockChangeListener = (event: SplitLockChangeEvent) => void;

const listeners = new Set<SplitLockChangeListener>();

/**
 * Error thrown when a guarded chokepoint operation is attempted against a
 * split-locked or destination-claimed worktree, or when a second acquire races
 * the first. Named
 * distinguishably (`SplitLockError`) so callers/tests can `instanceof`-match it
 * apart from generic `Error`s. Carries the lock coordinates and the guarded
 * operation label so refusal messaging can be specific.
 */
export class SplitLockError extends Error {
  public readonly workspaceId: string;
  public readonly worktreeId: string;
  public readonly operation: string;

  constructor(
    message: string,
    context: { workspaceId: string; worktreeId: string; operation: string },
  ) {
    super(message);
    this.name = 'SplitLockError';
    this.workspaceId = context.workspaceId;
    this.worktreeId = context.worktreeId;
    this.operation = context.operation;
  }
}

/**
 * Error thrown when a Split PR start is refused main-side because the worktree
 * still has in-flight work (an active chat turn or a running pipeline
 * execution) that the renderer's own pre-gate should have blocked, but which a
 * race or a direct IPC call bypassed. Named distinguishably so callers/tests
 * can `instanceof`-match it apart from the acquire-race {@link SplitLockError}.
 * Carries the worktree coordinates and the specific blocker kind.
 */
export class SplitStartBlockedError extends Error {
  public readonly workspaceId: string;
  public readonly worktreeId: string;
  public readonly blocker:
    | 'active-chat'
    | 'running-pipeline'
    | 'active-git-action';

  constructor(
    message: string,
    context: {
      workspaceId: string;
      worktreeId: string;
      blocker: 'active-chat' | 'running-pipeline' | 'active-git-action';
    },
  ) {
    super(message);
    this.name = 'SplitStartBlockedError';
    this.workspaceId = context.workspaceId;
    this.worktreeId = context.worktreeId;
    this.blocker = context.blocker;
  }
}

function lockKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}:${worktreeId}`;
}

function emitChange(event: SplitLockChangeEvent): void {
  for (const listener of Array.from(listeners)) {
    listener(event);
  }
}

/**
 * Acquire the split lock for a worktree. Throws {@link SplitLockError} if the
 * worktree is already locked (a split is already in progress for it), so a
 * second concurrent start is rejected instead of racing the first.
 */
export function acquireSplitLock(
  workspaceId: string,
  worktreeId: string,
): void {
  try {
    assertWorkspaceTargetRuntimeStartAllowed(workspaceId, worktreeId);
  } catch (error) {
    throw new SplitLockError(
      error instanceof Error
        ? error.message
        : 'This worktree cannot start a split while it is being archived.',
      { workspaceId, worktreeId, operation: 'acquire' },
    );
  }
  if (workspaceDeletionLeases.has(workspaceId)) {
    throw new SplitLockError(
      'This project is being deleted and cannot start a split.',
      { workspaceId, worktreeId, operation: 'acquire' },
    );
  }
  if (workspaceArchiveRetentionLeases.has(workspaceId)) {
    throw new SplitLockError(
      'This project is busy with a project split or archive-retention change; try again once it finishes.',
      { workspaceId, worktreeId, operation: 'acquire' },
    );
  }
  const key = lockKey(workspaceId, worktreeId);
  if (lockedWorktrees.has(key)) {
    throw new SplitLockError(
      'A Split PR workflow is already in progress for this worktree.',
      { workspaceId, worktreeId, operation: 'acquire' },
    );
  }
  lockedWorktrees.add(key);
  emitChange({ workspaceId, worktreeId, locked: true });
}

/**
 * Atomically exclude split starts while canonical workspace deletion runs.
 * Throws before any deletion side effect when a worktree in the workspace is
 * already split-locked. The returned release is idempotent.
 */
export function acquireWorkspaceDeletionLease(workspaceId: string): () => void {
  if (
    workspaceDeletionLeases.has(workspaceId) ||
    workspaceArchiveRetentionLeases.has(workspaceId) ||
    getSplitLockedWorktrees().some(
      (lock) => lock.workspaceId === workspaceId,
    ) ||
    Array.from(splitDestinationWorktreeClaims).some((key) =>
      key.startsWith(`${workspaceId}:`),
    )
  ) {
    throw new Error(
      'Cannot delete a project while one of its worktrees is being split.',
    );
  }
  workspaceDeletionLeases.add(workspaceId);
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    workspaceDeletionLeases.delete(workspaceId);
  };
}

/** Hold a destination row against archive/delete until split settlement. */
export function acquireSplitDestinationWorktreeClaim(
  workspaceId: string,
  worktreeId: string,
): void {
  if (workspaceDeletionLeases.has(workspaceId)) {
    throw new SplitLockError(
      'This project is busy with another split or deletion; try again once it finishes.',
      { workspaceId, worktreeId, operation: 'claim split destination' },
    );
  }
  const key = lockKey(workspaceId, worktreeId);
  if (splitDestinationWorktreeClaims.has(key)) {
    throw new SplitLockError(
      'This split destination is already claimed by an active split.',
      { workspaceId, worktreeId, operation: 'claim split destination' },
    );
  }
  splitDestinationWorktreeClaims.add(key);
}

/** Release a split destination claim. Safe to call more than once. */
export function releaseSplitDestinationWorktreeClaim(
  workspaceId: string,
  worktreeId: string,
): void {
  splitDestinationWorktreeClaims.delete(lockKey(workspaceId, worktreeId));
}

export function isSplitDestinationWorktreeClaimed(
  workspaceId: string,
  worktreeId: string,
): boolean {
  return splitDestinationWorktreeClaims.has(lockKey(workspaceId, worktreeId));
}

/** Refuse destructive operations against a split-owned destination row. */
export function assertNotSplitDestinationWorktreeClaimed(
  workspaceId: string,
  worktreeId: string,
  operation: string,
): void {
  if (isSplitDestinationWorktreeClaimed(workspaceId, worktreeId)) {
    throw new SplitLockError(
      `This worktree is reserved by an active project split; ${operation} is unavailable until it finishes.`,
      { workspaceId, worktreeId, operation },
    );
  }
}

/**
 * Atomically exclude split planning while archive-retention configuration is
 * being changed. Split execution holds this lease for each existing
 * destination whose retention policy was used to choose archive vs delete.
 */
export function acquireWorkspaceArchiveRetentionLease(
  workspaceId: string,
): () => void {
  if (
    workspaceDeletionLeases.has(workspaceId) ||
    workspaceArchiveRetentionLeases.has(workspaceId) ||
    getSplitLockedWorktrees().some((lock) => lock.workspaceId === workspaceId)
  ) {
    throw new Error(
      'Cannot change deletion retention while this project is being split or deleted.',
    );
  }
  workspaceArchiveRetentionLeases.add(workspaceId);
  let released = false;
  return (): void => {
    if (released) {
      return;
    }
    released = true;
    workspaceArchiveRetentionLeases.delete(workspaceId);
  };
}

/**
 * Release the split lock for a worktree. No-op (and emits no change) when the
 * worktree was not locked, so double-release from overlapping settle paths is
 * safe.
 */
export function releaseSplitLock(
  workspaceId: string,
  worktreeId: string,
): void {
  const key = lockKey(workspaceId, worktreeId);
  if (!lockedWorktrees.has(key)) {
    return;
  }
  lockedWorktrees.delete(key);
  emitChange({ workspaceId, worktreeId, locked: false });
}

export function isSplitLocked(
  workspaceId: string,
  worktreeId: string,
): boolean {
  return lockedWorktrees.has(lockKey(workspaceId, worktreeId));
}

/**
 * Release every held split lock that has NO split execute in flight for its
 * key, broadcasting a change for each released lock. Returns the number of
 * locks released.
 *
 * This is the renderer-lifecycle recovery path: a crash or reload while a
 * worktree is locked in the plan-review phase leaves the lock held but the
 * renderer's mirrored set empty and no UI to clear it. Releasing idle locks on
 * renderer gone/reload keeps the lock state truthful.
 *
 * Locks WITH an execute in flight are intentionally kept: during EXECUTE the
 * run is main-side and survives a renderer reload, and the approve handler's
 * `finally` releases (and broadcasts) when that run settles. Releasing here
 * would desync the lock from the still-running execute.
 *
 * `hasInFlight` reports whether a main-side split execute is currently running
 * for a given `(workspaceId, worktreeId)`.
 */
export function releaseIdleSplitLocks(
  hasInFlight: (workspaceId: string, worktreeId: string) => boolean,
): number {
  let released = 0;
  // Snapshot before mutating so we can iterate safely while releasing.
  for (const key of Array.from(lockedWorktrees)) {
    const separatorIndex = key.indexOf(':');
    if (separatorIndex < 0) {
      continue;
    }
    const workspaceId = key.slice(0, separatorIndex);
    const worktreeId = key.slice(separatorIndex + 1);
    if (hasInFlight(workspaceId, worktreeId)) {
      continue;
    }
    lockedWorktrees.delete(key);
    emitChange({ workspaceId, worktreeId, locked: false });
    released += 1;
  }
  return released;
}

/**
 * Snapshot the currently held split locks as `{ workspaceId, worktreeId }`
 * pairs. Used by the lightweight lock-state hydration IPC so the renderer can
 * seed its mirrored set once when wiring the change subscription.
 */
export function getSplitLockedWorktrees(): Array<{
  workspaceId: string;
  worktreeId: string;
}> {
  const result: Array<{ workspaceId: string; worktreeId: string }> = [];
  for (const key of Array.from(lockedWorktrees)) {
    const separatorIndex = key.indexOf(':');
    if (separatorIndex < 0) {
      continue;
    }
    result.push({
      workspaceId: key.slice(0, separatorIndex),
      worktreeId: key.slice(separatorIndex + 1),
    });
  }
  return result;
}

/**
 * Chokepoint guard. Throws {@link SplitLockError} carrying the operation label
 * when the worktree is split-locked; returns silently otherwise. Callers place
 * this early so the typed error surfaces to the invoker before any side effect.
 */
export function assertNotSplitLocked(
  workspaceId: string,
  worktreeId: string,
  operation: string,
): void {
  if (isSplitLocked(workspaceId, worktreeId)) {
    throw new SplitLockError(
      `This worktree is locked while a Split PR is in progress; ${operation} is unavailable until it finishes.`,
      { workspaceId, worktreeId, operation },
    );
  }
}

/**
 * Subscribe to lock transitions. Returns an unsubscribe function. Used by the
 * IPC layer to broadcast `{workspaceId, worktreeId, locked}` to the renderer on
 * every acquire/release.
 */
export function onSplitLockChange(cb: SplitLockChangeListener): () => void {
  listeners.add(cb);
  return (): void => {
    listeners.delete(cb);
  };
}
