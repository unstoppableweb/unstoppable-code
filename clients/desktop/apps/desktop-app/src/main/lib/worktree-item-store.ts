import { join } from 'node:path';
import {
  composeCoreItemStore,
  CORE_ITEM_STORE_SOURCE_UNCHANGED,
  type CoreItemStore,
  type CoreItemStoreHost,
  type CoreItemStoreRelocateRequest,
  type CoreItemStoreRelocationDestination,
} from '@canopy/core-runtime/node/worktree/item-store';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import type { installChatPayloads } from './archived-container-restore';
import { getWorktreeDataRootDir } from './paths';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';
import type {
  SplitItemsMigrationTarget,
  SplitWorktreeItemsAnalysis,
} from './split-temporary-workspace-items';
import { lifecycleTreeRemoval } from './w5-destructive-recovery';
import {
  removeWorkspaceDirectoryAfterRecordRemoval,
  removeWorkspaceNonW5Children,
} from './w5-workspace-directory-removal';
import { withLinuxWorktreeRemovalVerification } from './worktree-process-cleanup';

/*
 * Electron's item store host (CAN-4098): today's purges and relocations,
 * unchanged, behind the core-runtime item store port. It contacts no daemon.
 * The relocations still run in the modules that own those writers, loaded on
 * first use; a store that flips to the daemon joins as a participant in
 * `getWorktreeItemStore`, so its call sites do not change.
 */

type ArchiveRestorePayload = Parameters<typeof installChatPayloads>[0];

export type ElectronItemStorePlan =
  | {
      readonly kind: 'split-items';
      readonly workspaceId: string;
      readonly worktreeId: string;
      readonly analysis: SplitWorktreeItemsAnalysis;
      readonly targets: SplitItemsMigrationTarget[];
      readonly hardDeleteRepoIds: ReadonlySet<string>;
    }
  | {
      readonly kind: 'split-executions';
      readonly workspaceId: string;
      readonly worktreeId: string;
      readonly targets: SplitItemsMigrationTarget[];
    }
  | {
      readonly kind: 'archive-restore';
      readonly payload: ArchiveRestorePayload;
    };

type ElectronItemStoreRelocateRequest =
  CoreItemStoreRelocateRequest<ElectronItemStorePlan>;

export function splitRelocationDestination(
  target: SplitItemsMigrationTarget,
): CoreItemStoreRelocationDestination {
  return {
    workspaceId: target.destinationWorkspaceId,
    worktreeId: target.destinationWorktreeId,
    repoId: target.repoId,
  };
}

/** Split's move of repo-owned chats, plans and attachments. */
export function splitItemsRelocation(params: {
  workspaceId: string;
  worktreeId: string;
  analysis: SplitWorktreeItemsAnalysis;
  targets: SplitItemsMigrationTarget[];
  hardDeleteRepoIds: ReadonlySet<string>;
}): ElectronItemStoreRelocateRequest {
  return {
    mode: 'move',
    source: {
      kind: 'worktree',
      workspaceId: params.workspaceId,
      worktreeId: params.worktreeId,
    },
    destinations: params.targets.map(splitRelocationDestination),
    plan: { kind: 'split-items', ...params },
  };
}

/** Split's move of repo-owned pipeline executions. */
export function splitExecutionsRelocation(params: {
  workspaceId: string;
  worktreeId: string;
  targets: SplitItemsMigrationTarget[];
}): ElectronItemStoreRelocateRequest {
  return {
    mode: 'move',
    source: {
      kind: 'worktree',
      workspaceId: params.workspaceId,
      worktreeId: params.worktreeId,
    },
    destinations: params.targets.map(splitRelocationDestination),
    plan: { kind: 'split-executions', ...params },
  };
}

/** Restore's copy of an archive's chats, plans, summary, cost and attachments. */
export function archiveRestoreRelocation(
  payload: ArchiveRestorePayload,
): ElectronItemStoreRelocateRequest {
  return {
    mode: 'copy',
    source: {
      kind: 'archived-container',
      workspaceId: payload.manifest.projectId,
      containerId: payload.manifest.id,
    },
    destinations: [
      {
        workspaceId: payload.manifest.projectId,
        worktreeId: payload.destinationId,
      },
    ],
    plan: { kind: 'archive-restore', payload },
  };
}

function splitTarget(
  targets: readonly SplitItemsMigrationTarget[],
  destination: CoreItemStoreRelocationDestination,
): SplitItemsMigrationTarget {
  const target = targets.find(
    (candidate) =>
      candidate.destinationWorkspaceId === destination.workspaceId &&
      candidate.destinationWorktreeId === destination.worktreeId &&
      candidate.repoId === destination.repoId,
  );
  if (!target)
    throw new Error(
      `No split items went to worktree ${destination.worktreeId} of workspace ${destination.workspaceId}`,
    );
  return target;
}

const electronItemStoreHost: CoreItemStoreHost<ElectronItemStorePlan> = {
  purge: async ({ target, keepStores }) => {
    // Every removal below takes whole folders; none can keep a store yet.
    if (keepStores.length > 0)
      throw new Error(
        `The item store cannot keep ${keepStores.join(', ')} through its removal`,
      );
    if (target.scope === 'worktree') {
      const root = getWorktreeDataRootDir(target.workspaceId);
      const directory = join(root, target.worktreeId);
      // App-managed chat workspaces live under app-workspaces/, not
      // workspaces/ — the resolved root keeps their metadata reclaimable.
      await withLinuxWorktreeRemovalVerification(directory, () =>
        removePersistedWorktreeDataDirectory(
          target.workspaceId,
          target.worktreeId,
          {
            worktreeDataRootDir: root,
            removeTree: lifecycleTreeRemoval(directory, removeTreeWithoutAsar),
          },
        ),
      );
      return;
    }
    if (target.stage === 'items') {
      await removeWorkspaceNonW5Children(target.workspaceId);
      return;
    }
    for (const worktreeId of target.worktreeIds)
      await removePersistedWorktreeDataDirectory(
        target.workspaceId,
        worktreeId,
        { removeTree: removeTreeWithoutAsar },
      );
    await removeWorkspaceDirectoryAfterRecordRemoval(target.workspaceId);
  },
  relocate: async ({ plan }) => {
    if (plan.kind === 'archive-restore') {
      const { installChatPayloads: install } =
        await import('./archived-container-restore');
      await install(plan.payload);
      return CORE_ITEM_STORE_SOURCE_UNCHANGED;
    }
    const items = await import('./split-temporary-workspace-items');
    if (plan.kind === 'split-items') {
      const undo = await items.migrateSplitChatsAndPlans({
        workspaceId: plan.workspaceId,
        worktreeId: plan.worktreeId,
        analysis: plan.analysis,
        targets: plan.targets,
        hardDeleteRepoIds: plan.hardDeleteRepoIds,
      });
      return {
        commit: () => items.finalizeSplitChatsAndPlansMigration(undo),
        revert: () => items.undoSplitChatsAndPlansMigration(undo),
        revertDestination: async (destination) =>
          items.undoSplitChatsAndPlansTargetMigration(
            undo,
            splitTarget(plan.targets, destination),
          ),
      };
    }
    const snapshots = await items.migrateSplitPipelineExecutions({
      workspaceId: plan.workspaceId,
      worktreeId: plan.worktreeId,
      targets: plan.targets,
    });
    return {
      commit: (): Promise<void> => Promise.resolve(),
      revert: () => items.restoreSplitExecutionSnapshots(snapshots),
      revertDestination: async (destination) =>
        items.restoreSplitExecutionSnapshotsForTarget(
          snapshots,
          splitTarget(plan.targets, destination),
        ),
    };
  },
};

const worktreeItemStore = composeCoreItemStore(electronItemStoreHost, []);

/** The item store every Electron purge and relocation goes through. */
export function getWorktreeItemStore(): CoreItemStore<ElectronItemStorePlan> {
  return worktreeItemStore;
}
