import { W5AuthorityUnreachableError } from '../lib/w5-file-store';
import { getElectronDaemonHealth } from './electron-daemon-health';
import { scheduleDesktopStructureChanged } from '../services/desktop-structure-signal';
import { refreshWorkspaceRegistries } from '../lib/sidebar-items';
import { readWorkspaceWorktreesUnlocked } from '../lib/workspace-persistence';
import { reconcileManifestPluginDefaults } from '../lib/workspace-plugin-defaults';
import { listRegisteredWorkspaceIds } from '../lib/workspace-registry';
import {
  publishWorktreeLifecycleChange,
  publishWorktreeListWrite,
} from '../lib/worktree-lifecycle-signals';
import type { WorkspaceCommitEventHandlers } from './workspace-commit-events';

/** No read of the manifest decided its plugin layer; the revision may lag. */
export class ManifestPluginDefaultsUndecidedError extends Error {
  constructor(readonly workspaceId: string) {
    super('The manifest plugin defaults were not reconciled.');
    this.name = 'ManifestPluginDefaultsUndecidedError';
  }
}

/**
 * Main's handlers for W5e commit events from other origins (CAN-5497): the
 * same refreshes Electron's own writers run after their commits, minus the
 * self-write record, the sidecar `afterWrite`, telemetry and the sidebar
 * group signal, which stay with the issuing writer (W8 moves the first two).
 */
export function createDesktopWorkspaceCommitEventHandlers(): WorkspaceCommitEventHandlers {
  const requireReachable = (): void => {
    if (getElectronDaemonHealth().isLatched())
      throw new W5AuthorityUnreachableError('refused', 'held');
  };
  return {
    scheduleDesktopStructureChanged: (): void =>
      scheduleDesktopStructureChanged('structural.w5-commit-event'),
    refreshWorkspaceRegistries: async () => {
      requireReachable();
      await refreshWorkspaceRegistries();
    },
    // An undecided reconcile leaves the session revision behind the file.
    // Past its bound it also returns undecided, so a stalled commit of the
    // manifest holds later events no longer than the bridge's retries.
    reconcileManifestPluginDefaults: async (workspaceId) => {
      requireReachable();
      if (!(await reconcileManifestPluginDefaults(workspaceId, false)))
        throw new ManifestPluginDefaultsUndecidedError(workspaceId);
    },
    listWorkspaceIds: listRegisteredWorkspaceIds,
    readWorktreeList: async (workspaceId) => {
      requireReachable();
      return readWorkspaceWorktreesUnlocked(workspaceId);
    },
    publishWorktreeListWrite: (previous, next) =>
      publishWorktreeListWrite(previous, next),
    publishWorktreeMembershipChange: () =>
      publishWorktreeLifecycleChange('worktree-list-membership'),
  };
}
