/**
 * The desktop's structural-change signal: workspace, worktree and sidebar
 * persistence choke points (`writeWorkspaceWorktreesFile`,
 * `writeWorkspaceIndexEntries`, `deleteWorkspaceById`, ...) call
 * {@link scheduleDesktopStructureChanged} after every durable structural
 * write, whichever surface initiated it.
 *
 * The signal itself refreshes what Remote Control and the cloud inventory
 * read: it invalidates the desktop session snapshot and marks the
 * per-worktree pipeline inventory documents dirty (CAN-2830). It then tells
 * its listeners, which keep their own timing (Portal's overview push is a
 * debounced listener until CAN-5986 deletes it).
 */
import {
  requestDesktopSessionSnapshotInvalidation,
  type StructuralStaleSource,
} from './desktop-session-snapshot-invalidation';
import { notifyDesktopInventoryChanged } from './desktop-inventory-sync-signals';

export interface DesktopStructureListener {
  /** Called synchronously after the signal's own work; must not block. */
  changed(): void;
  /** Cancels the listener's pending work (app shutdown). */
  cancel(): void;
}

const listeners = new Set<DesktopStructureListener>();

/**
 * Registers a listener; returns its removal. Registering the same listener
 * object twice keeps one registration.
 */
export function onDesktopStructureChanged(
  listener: DesktopStructureListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Signals a durable structural write. Safe to call from any persistence write
 * path: it never throws and never blocks the caller. A listener that throws
 * does not stop the snapshot and inventory refresh or the other listeners.
 */
export function scheduleDesktopStructureChanged(
  source: StructuralStaleSource,
): void {
  requestDesktopSessionSnapshotInvalidation(source);
  // Worktree/workspace churn changes which per-worktree pipeline documents
  // exist in the cloud inventory (CAN-2830); the sync service diffs them.
  notifyDesktopInventoryChanged(['pipelines']);
  for (const listener of [...listeners]) {
    try {
      listener.changed();
    } catch {
      // A listener failure must never fail the persistence write that
      // triggered the signal.
    }
  }
}

/**
 * Cancels every listener's pending work. Called from
 * `cleanupRuntimeResources()` on app shutdown so no listener timer outlives
 * the Electron app.
 */
export function cancelDesktopStructureChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener.cancel();
    } catch {
      // Shutdown continues past a listener that cannot cancel.
    }
  }
}
