import type { WorktreeData } from '@canopy/desktop-shared/types';
import { reconcileTrackedWorkspaceWorktrees } from './github-poller';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from './worktree-live-cleanup';
import { cleanupPersistedWorktreeData } from './worktree-data-cleanup';
import { withLinuxWorktreeWriterTracking } from './worktree-process-cleanup';
import { notifyDesktopInventoryChanged } from '../services/desktop-inventory-sync-signals';
import { notifyLedgerContainerRemovedExternally } from '../ledger/lifecycle';
import { publishWorktreeLifecycleChange } from './worktree-lifecycle-signals';

const inFlightCleanup = new Map<string, Promise<void>>();

/**
 * Tells the Ledger that a worktree was deleted outside the app, such as
 * through the CLI, which never opens the Ledger database. The snapshot carries
 * only the worktrees that remain, so the removed record's creation time is
 * unknown. The participant returns at once and never waits on storage.
 */
function notifyLedgerOfExternalRemoval(
  workspaceId: string,
  worktreeId: string,
): void {
  try {
    notifyLedgerContainerRemovedExternally(
      { kind: 'code_worktree', workspaceId, worktreeId },
      null,
    );
  } catch {
    // The participant never throws. A defect in it must not stop the cleanup;
    // startup reconciliation settles the scope.
  }
}

async function cleanupRemovedWorktree(
  workspaceId: string,
  worktreeId: string,
): Promise<void> {
  try {
    await cleanupLiveWorktreeState(workspaceId, worktreeId);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('External worktree live cleanup failed', {
      workspaceId,
      worktreeId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
  // After live cleanup stops the worktree's writers. Notify whether or not
  // either cleanup succeeds: the worktree is gone regardless.
  notifyLedgerOfExternalRemoval(workspaceId, worktreeId);
  let warnings: string[];
  try {
    warnings = await cleanupPersistedWorktreeData(workspaceId, worktreeId, {
      observabilityMode: 'live-service',
      purgeObservabilityData: purgeLiveWorktreeObservabilityData,
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('External worktree persisted cleanup failed', {
      workspaceId,
      worktreeId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return;
  }
  for (const warning of warnings) {
    // eslint-disable-next-line no-console
    console.warn('External worktree persisted cleanup warning', {
      workspaceId,
      worktreeId,
      warning,
    });
  }
}

export async function reconcileExternalWorktreeSnapshot(
  workspaceId: string,
  worktrees: readonly WorktreeData[],
): Promise<void> {
  const { removedWorktreeIds } = reconcileTrackedWorkspaceWorktrees(
    workspaceId,
    worktrees,
  );
  // An external writer (the CLI) changed which worktrees exist, and with
  // them which per-worktree pipeline documents the cloud inventory should
  // hold (CAN-2830); the in-app write paths notify through
  // scheduleDesktopStructureChanged, this is the watcher's counterpart.
  notifyDesktopInventoryChanged(['pipelines']);
  publishWorktreeLifecycleChange('external-snapshot');
  const cleanups: Promise<void>[] = [];
  for (const worktreeId of removedWorktreeIds) {
    const key = `${workspaceId}/${worktreeId}`;
    let cleanup = inFlightCleanup.get(key);
    if (!cleanup) {
      cleanup = withLinuxWorktreeWriterTracking(
        () => cleanupRemovedWorktree(workspaceId, worktreeId),
        JSON.stringify([workspaceId, worktreeId]),
      ).finally(() => {
        inFlightCleanup.delete(key);
      });
      inFlightCleanup.set(key, cleanup);
    }
    cleanups.push(cleanup);
  }
  await Promise.all(cleanups);
}
