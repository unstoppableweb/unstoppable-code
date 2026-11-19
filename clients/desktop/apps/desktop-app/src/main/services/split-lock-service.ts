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

/**
 * Resolves a worktree to its fence key (CAN-4730): its root through
 * `realpath.native`, so every ID form, symlink or case variant naming one
 * worktree gets one key. `key` is for acquire; `keySync` runs only while a
 * lock is held, to place a guarded target against the held keys.
 */
export interface SplitLockKeyResolver {
  key(workspaceId: string, worktreeId: string): Promise<string>;
  keySync(workspaceId: string, worktreeId: string): string;
}

let keyResolver: SplitLockKeyResolver | undefined;

/**
 * Installs the key resolver; main startup wires it. Without one, acquire
 * refuses and a held lock refuses every guarded target. Returns an undo.
 */
export function setSplitLockKeyResolver(
  resolver: SplitLockKeyResolver,
): () => void {
  const previous = keyResolver;
  keyResolver = resolver;
  return (): void => {
    if (keyResolver === resolver) keyResolver = previous;
  };
}

export interface HeldSplitLock {
  workspaceId: string;
  worktreeId: string;
}

/**
 * Confirms a new lock where other hosts enforce it (CAN-4730 E2-G: the
 * daemon's mutation fence). Resolves once it holds there; rejects otherwise.
 */
export type SplitLockFenceConfirmer = (held: HeldSplitLock) => Promise<void>;

let confirmFence: SplitLockFenceConfirmer | undefined;

/** Installs the fence confirmer; main startup wires it. Returns an undo. */
export function setSplitLockFenceConfirmer(
  confirmer: SplitLockFenceConfirmer,
): () => void {
  const previous = confirmFence;
  confirmFence = confirmer;
  return (): void => {
    if (confirmFence === confirmer) confirmFence = previous;
  };
}

/** Locked worktrees by fence key, with the IDs each lock was taken under. */
const lockedWorktrees = new Map<string, HeldSplitLock>();
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

/** Destination claims stay keyed by the IDs their split reserved. */
function claimKey(workspaceId: string, worktreeId: string): string {
  return `${workspaceId}:${worktreeId}`;
}

function emitChange(event: SplitLockChangeEvent): void {
  for (const listener of Array.from(listeners)) {
    listener(event);
  }
}

/** The held lock with exactly these IDs, found without a filesystem call. */
function heldKeyByIds(
  workspaceId: string,
  worktreeId: string,
): string | undefined {
  for (const [key, held] of lockedWorktrees)
    if (held.workspaceId === workspaceId && held.worktreeId === worktreeId)
      return key;
  return undefined;
}

/** A guarded target's key while a lock is held; null when it can't be placed. */
function targetKey(workspaceId: string, worktreeId: string): string | null {
  if (!keyResolver) return null;
  try {
    return keyResolver.keySync(workspaceId, worktreeId);
  } catch {
    return null;
  }
}

function assertSplitStartAllowed(
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
}

/** A split lock whose key is resolved, taken by `acquire`. */
export interface PreparedSplitLock {
  /**
   * Takes the lock before its first await, so a caller's own checks just
   * before it stay atomic with it, or throws {@link SplitLockError} without
   * taking it. Resolves once the lock's fence is confirmed; if it isn't, the
   * lock is released and the promise rejects with {@link SplitLockError}.
   */
  acquire(): Promise<void>;
}

/**
 * Resolves a worktree's lock key ahead of taking its lock. The key is the
 * worktree's resolved root; a worktree that can't be resolved is refused,
 * never keyed by its raw IDs.
 */
export async function prepareSplitLock(
  workspaceId: string,
  worktreeId: string,
): Promise<PreparedSplitLock> {
  assertSplitStartAllowed(workspaceId, worktreeId);
  let key: string;
  try {
    if (!keyResolver) throw new Error('No split lock key resolver.');
    key = await keyResolver.key(workspaceId, worktreeId);
  } catch {
    throw new SplitLockError(
      "Couldn't find this worktree, so a Split PR can't start.",
      { workspaceId, worktreeId, operation: 'acquire' },
    );
  }
  const take = (): HeldSplitLock => {
    // Deletion and retention leases may have been taken since preparing.
    assertSplitStartAllowed(workspaceId, worktreeId);
    if (lockedWorktrees.has(key)) {
      throw new SplitLockError(
        'A Split PR workflow is already in progress for this worktree.',
        { workspaceId, worktreeId, operation: 'acquire' },
      );
    }
    const held = { workspaceId, worktreeId };
    lockedWorktrees.set(key, held);
    emitChange({ ...held, locked: true });
    return held;
  };
  return {
    // Async, but everything before the first await runs at the call, so the
    // lock is taken synchronously with the caller's own checks.
    acquire: async (): Promise<void> => {
      const held = take();
      const confirm = confirmFence;
      if (!confirm) return;
      try {
        await confirm(held);
      } catch {
        if (lockedWorktrees.get(key) === held) {
          lockedWorktrees.delete(key);
          emitChange({ ...held, locked: false });
        }
        throw new SplitLockError(
          "Couldn't confirm this worktree is locked, so a Split PR can't start. Try again.",
          { workspaceId, worktreeId, operation: 'acquire' },
        );
      }
    },
  };
}

/**
 * Acquire the split lock for a worktree. Throws {@link SplitLockError} if the
 * worktree is already locked (a split is already in progress for it), so a
 * second concurrent start is rejected instead of racing the first.
 */
export async function acquireSplitLock(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  await (await prepareSplitLock(workspaceId, worktreeId)).acquire();
}

/** Read-only admission fence, including deletion before its first journal save. */
export function hasWorkspaceDeletionLease(workspaceId: string): boolean {
  return workspaceDeletionLeases.has(workspaceId);
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
  const key = claimKey(workspaceId, worktreeId);
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
  splitDestinationWorktreeClaims.delete(claimKey(workspaceId, worktreeId));
}

export function isSplitDestinationWorktreeClaimed(
  workspaceId: string,
  worktreeId: string,
): boolean {
  return splitDestinationWorktreeClaims.has(claimKey(workspaceId, worktreeId));
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
  if (lockedWorktrees.size === 0) return;
  // The IDs it was taken under first, so a lock whose directory has vanished
  // is still freed; otherwise any other form naming the same worktree.
  let key = heldKeyByIds(workspaceId, worktreeId);
  if (key === undefined) {
    const resolved = targetKey(workspaceId, worktreeId);
    if (resolved !== null && lockedWorktrees.has(resolved)) key = resolved;
  }
  const held = key === undefined ? undefined : lockedWorktrees.get(key);
  if (key === undefined || !held) return;
  lockedWorktrees.delete(key);
  emitChange({ ...held, locked: false });
}

/**
 * Whether a worktree is split-locked. Returns at once when no lock is held.
 * While one is, a target that can't be resolved counts as locked.
 */
export function isSplitLocked(
  workspaceId: string,
  worktreeId: string,
): boolean {
  if (lockedWorktrees.size === 0) return false;
  if (heldKeyByIds(workspaceId, worktreeId) !== undefined) return true;
  const key = targetKey(workspaceId, worktreeId);
  return key === null || lockedWorktrees.has(key);
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
  for (const [key, held] of Array.from(lockedWorktrees)) {
    if (hasInFlight(held.workspaceId, held.worktreeId)) {
      continue;
    }
    lockedWorktrees.delete(key);
    emitChange({ ...held, locked: false });
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
  return Array.from(lockedWorktrees.values(), (held) => ({ ...held }));
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
