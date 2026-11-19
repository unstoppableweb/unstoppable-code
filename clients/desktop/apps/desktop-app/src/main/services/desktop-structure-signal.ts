/**
 * The desktop's structural-change signal: workspace, worktree and sidebar
 * persistence choke points (`writeWorkspaceWorktreesFile`,
 * `writeWorkspaceIndexEntries`, `deleteWorkspaceById`, ...) call
 * {@link scheduleDesktopStructureChanged} after every durable structural
 * write, whichever surface initiated it.
 *
 * The signal refreshes what Remote Control and the cloud inventory read: it
 * invalidates the desktop session snapshot and marks the per-worktree
 * pipeline inventory documents dirty (CAN-2830).
 */
import {
  requestDesktopSessionSnapshotInvalidation,
  type StructuralStaleSource,
} from './desktop-session-snapshot-invalidation';
import { notifyDesktopInventoryChanged } from './desktop-inventory-sync-signals';

/**
 * Signals a durable structural write. Safe to call from any persistence write
 * path: it never throws and never blocks the caller.
 */
export function scheduleDesktopStructureChanged(
  source: StructuralStaleSource,
): void {
  requestDesktopSessionSnapshotInvalidation(source);
  // Worktree/workspace churn changes which per-worktree pipeline documents
  // exist in the cloud inventory (CAN-2830); the sync service diffs them.
  notifyDesktopInventoryChanged(['pipelines']);
}
