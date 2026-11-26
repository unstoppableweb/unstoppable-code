/**
 * Dependency-free signal that persisted worktree membership may have changed
 * (CAN-4899). Main's branch observer subscribes and rereads membership on a
 * debounce. A `worktrees.json` write publishes only when it changes which
 * checkouts the observer watches: the GitHub poller's PR status and the
 * observer's own branch recording change no membership, so they never
 * re-sync it.
 *
 * Git-ready keeps its own hook (`worktree-git-ready-hooks.ts`), which names
 * the worktree whose checkout became ready while its row is still pending.
 */
export type WorktreeLifecycleChange =
  /** A `projects:load` completed; the first one starts enrollment. */
  | 'projects-loaded'
  | 'projects-saved'
  /**
   * A worktree list write added, removed, or finished setting up a row, or
   * another writer (the CLI) changed a list's membership.
   */
  | 'worktree-list-membership'
  /** An archive or delete settled, whether or not it removed the row. */
  | 'worktree-removal-settled'
  | 'workspace-deleted';

type Listener = (change: WorktreeLifecycleChange) => void;

/** The row fields that decide whether the observer watches a checkout. */
export interface WorktreeMembershipRow {
  id: string;
  setupPhase?: string;
}

const listeners = new Set<Listener>();
let listChangeSequence = 0;

/**
 * Advances on every signal except `projects-loaded`, and on every worktree
 * list write, membership change or not, so a read taken at one value has
 * seen every row a later write changes.
 */
export function worktreeLifecycleSequence(): number {
  return listChangeSequence;
}

export function subscribeWorktreeLifecycleChanges(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

/** Never throws: a listener failure must not fail the lifecycle step. */
export function publishWorktreeLifecycleChange(
  change: WorktreeLifecycleChange,
): void {
  if (change !== 'projects-loaded') listChangeSequence += 1;
  listeners.forEach((listener): void => {
    try {
      listener(change);
    } catch {
      // Observational only; see the module comment.
    }
  });
}

function membershipKeys(rows: readonly WorktreeMembershipRow[]): Set<string> {
  return new Set(
    rows.map(
      (row) =>
        `${row.id}:${row.setupPhase === 'git-pending' ? 'pending' : 'ready'}`,
    ),
  );
}

/** Publishes `worktree-list-membership` when a list write changes membership. */
export function publishWorktreeListWrite(
  previous: readonly WorktreeMembershipRow[],
  next: readonly WorktreeMembershipRow[],
): void {
  listChangeSequence += 1;
  const before = membershipKeys(previous);
  const after = membershipKeys(next);
  if (
    before.size === after.size &&
    Array.from(after).every((key) => before.has(key))
  )
    return;
  publishWorktreeLifecycleChange('worktree-list-membership');
}
