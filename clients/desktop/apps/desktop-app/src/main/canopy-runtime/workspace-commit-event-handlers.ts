import type { W5CaptureRequest } from '@canopy/core-runtime/node/w5/commit-log/capture-contract';
import {
  IPC_CHANNELS,
  type WorkspaceWorktreesUpdatedEvent,
} from '@canopy/desktop-shared/types';
import { trackDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { runWithW5Caller } from '@canopy/desktop-shared/node/work-counters';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { sendToAllWindows } from '../lib/window-send';
import { reconcileExternalWorktreeSnapshot } from '../lib/worktree-registry-reconciliation';
import { readWorktreesFileContent } from '../lib/worktrees-file-watcher';
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
import {
  readThroughDesktopW5Cache,
  W5_DISCOVER_REQUEST,
  w5WorkspaceFileRequest,
} from './w5-read-cache-server';

function serveW5eRead<T>(
  request: W5CaptureRequest,
  read: () => Promise<T>,
): Promise<T> {
  return runWithW5Caller('background:w5e-handlers', () =>
    readThroughDesktopW5Cache(request, read),
  );
}

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
 * sidecar `afterWrite`, telemetry and the sidebar group signal, which stay
 * with the issuing writer (W8 moves the first). A worktree list also gets the
 * outside-change cleanup and renderer reload (CAN-7156).
 */
export function createDesktopWorkspaceCommitEventHandlers(): WorkspaceCommitEventHandlers {
  const requireReachable = (): void => {
    if (getElectronDaemonHealth().isLatched())
      throw new W5AuthorityUnreachableError('refused', 'held');
  };
  return {
    scheduleDesktopStructureChanged: (): void =>
      scheduleDesktopStructureChanged('structural.w5-commit-event'),
    // The cache step ran first, so a manifest-only plan is served; an index
    // plan leaves the manifests lagging, and this reads as today.
    refreshWorkspaceRegistries: async () => {
      requireReachable();
      await serveW5eRead(W5_DISCOVER_REQUEST, refreshWorkspaceRegistries);
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
      return serveW5eRead(
        w5WorkspaceFileRequest('worktrees', workspaceId),
        () => readWorkspaceWorktreesUnlocked(workspaceId),
      );
    },
    readWorktreeListContent: readWorktreesFileContent,
    publishWorktreeListWrite: (previous, next) =>
      publishWorktreeListWrite(previous, next),
    publishWorktreeMembershipChange: () =>
      publishWorktreeLifecycleChange('worktree-list-membership'),
    handleExternalWorktreeList: (workspaceId, read) => {
      // Only a complete list can tell a removed worktree from an unread row.
      if (read.authority === 'ok') {
        const worktrees = read.worktrees;
        trackDetachedWork(() =>
          reconcileExternalWorktreeSnapshot(workspaceId, worktrees).catch(
            (error: unknown) =>
              logMainProcessWarn(
                '[workspace-commit-events] external worktree cleanup failed',
                { error },
              ),
          ),
        );
      }
      // `satisfies`, not an annotation: the controller-shape fingerprint
      // must see the sent `{ workspaceId }`, not the full event interface.
      sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {
        workspaceId,
      } satisfies WorkspaceWorktreesUpdatedEvent);
    },
  };
}
