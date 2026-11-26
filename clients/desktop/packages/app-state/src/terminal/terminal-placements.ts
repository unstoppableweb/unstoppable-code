import { registerTerminalClientReset } from './terminal-client-binding';

type PlacementsSettledListener = (
  projectId: string,
  worktreeId: string,
) => void;

const pendingPlacements = new Map<string, Set<symbol>>();
const settledListeners = new Set<PlacementsSettledListener>();

const placementKey = (projectId: string, worktreeId: string): string =>
  `${projectId}/${worktreeId}`;

// Leases belong to one client lifetime; an old request's release is inert.
registerTerminalClientReset((): void => {
  for (const pending of pendingPlacements.values()) pending.clear();
  pendingPlacements.clear();
});

/**
 * Mark an explicit spawn-then-bind as in flight. Main can publish the shell
 * (for example in a recovered history load) before the spawn reply, so passive
 * placement defers until the returned callback runs after the bind or cleanup.
 */
export function beginTerminalPlacement(
  projectId: string,
  worktreeId: string,
): () => void {
  const key = placementKey(projectId, worktreeId);
  const token = Symbol('terminal-placement');
  const pending = pendingPlacements.get(key) ?? new Set<symbol>();
  pending.add(token);
  pendingPlacements.set(key, pending);
  return (): void => {
    if (!pending.delete(token) || pending.size > 0) return;
    if (pendingPlacements.get(key) === pending) pendingPlacements.delete(key);
    for (const listener of Array.from(settledListeners))
      listener(projectId, worktreeId);
  };
}

export function hasPendingTerminalPlacement(
  projectId: string,
  worktreeId: string,
): boolean {
  return pendingPlacements.has(placementKey(projectId, worktreeId));
}

/** Notified when a worktree's last in-flight explicit placement settles. */
export function onTerminalPlacementsSettled(
  listener: PlacementsSettledListener,
): () => void {
  settledListeners.add(listener);
  return (): void => {
    settledListeners.delete(listener);
  };
}
