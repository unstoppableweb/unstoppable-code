import { join } from 'node:path';
import {
  beginDirectoryDeletion,
  directoryRemovalOutcome,
  drainDirectoryEffects,
} from './directory-effect-admission';
import { rm, stat } from 'node:fs/promises';
import { PLAN_EXPLORE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { terminalPersistenceStore } from '../terminal/persistence';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';
import { getChatSearchService } from '../chat-search/service';
import { getChatStateService } from '../services/chat-state-service';
import { ChatStorageV2 } from './chat-storage-v2';
import {
  getPlanExploreFileDir,
  getWorktreeAttachmentsDir,
  getWorktreeDataRootDir,
} from './paths';
import {
  getPlanExploreTarget,
  isSamePlanExploreScope,
  listPlanExploreTargetIdsForScope,
  removePlanExploreTarget,
  type PlanExploreTargetRef,
} from './plan-explore-registry';
import { getPlanFileSyncService } from './plan-file-sync';
import {
  resolveChatArchivesFilePath,
  resolveChatJournalFilePath,
  resolveChatTabsFilePath,
} from './resolve-worktree';
import { validateId } from './validation';
import { cleanupLiveWorktreeState } from './worktree-live-cleanup';

/**
 * Reclaims everything a tracked plan's explore/plan-file state owns. The
 * legacy takeover chat is keyed `(PLAN_EXPLORE_CHAT_PROJECT_ID, planId)`, so
 * its data is spread across:
 *
 * - `{dataDir}/plan-explore-chats/registry.json` (the target row)
 * - `{dataDir}/chat-storage-manifests/plan-explore-chats-{planId}.json` and
 *   `{dataDir}/chat-storage-v2/plan-explore-chats-{planId}/` (canonical chat)
 * - `app-workspaces/plan-explore-chat/attachments/{planId}/`
 * - `app-workspaces/plan-explore-chat/worktree-data/{planId}/`
 *
 * The materialized `plan.md` is scoped to the REAL owner:
 * `worktree-data/{worktreeId}/plan-explore/{planId}/`.
 *
 * Plan ids are unique only within one worktree, so every removal names the
 * owning `(projectId, worktreeId)`. The sentinel pieces above are reclaimed
 * only when the registry row is absent or belongs to that owner; another
 * worktree's same-id plan keeps its row, takeover chat, and plan file.
 *
 * Nothing else ever removes these, so plan deletion and worktree cleanup both
 * route through here. Every step is idempotent: missing pieces are fine and
 * other plans' data is never touched.
 */

interface CleanupStep {
  label: string;
  run: () => Promise<void>;
}

function sanitizeMessage(message: string): string {
  return message
    .trim()
    .replace(/'\/[^'\n]+'/g, "'<path>'")
    .replace(/"\/[^"\n]+"/g, '"<path>"');
}

function buildWarning(planId: string, label: string, error: unknown): string {
  const detail =
    error instanceof Error && error.message.trim().length > 0
      ? sanitizeMessage(error.message)
      : 'unknown error';
  return `Failed to remove plan-explore ${label} for plan ${planId}: ${detail}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function hasPlanExploreChatStorage(planId: string): Promise<boolean> {
  const store = ChatStorageV2.fromLegacyPaths({
    tabs: resolveChatTabsFilePath(PLAN_EXPLORE_CHAT_PROJECT_ID, planId),
    archives: resolveChatArchivesFilePath(PLAN_EXPLORE_CHAT_PROJECT_ID, planId),
    journal: resolveChatJournalFilePath(PLAN_EXPLORE_CHAT_PROJECT_ID, planId),
  });
  return (
    (await pathExists(store.manifestPath)) ||
    (await pathExists(store.directory))
  );
}

function buildSentinelSteps(
  planId: string,
  hasChatScope: boolean,
): CleanupStep[] {
  const scope = { projectId: PLAN_EXPLORE_CHAT_PROJECT_ID, worktreeId: planId };
  const steps: CleanupStep[] = [];
  let chatScopeRemoved = !hasChatScope;
  if (hasChatScope) {
    // Sessions (and any claude-terminal sidecars) must be gone before the
    // chat-state deletion boundary; the scope key is the sentinel + plan id.
    steps.push({
      label: 'live sessions',
      run: (): Promise<void> =>
        cleanupLiveWorktreeState(scope.projectId, scope.worktreeId),
    });
    // Commits removal of live/archived chats under the deletion fence, then
    // drops the manifest and the whole v2 storage closure.
    steps.push({
      label: 'chat state',
      run: async (): Promise<void> => {
        await getChatStateService().deleteScope(scope);
        chatScopeRemoved = true;
      },
    });
    steps.push({
      label: 'chat search index',
      run: async (): Promise<void> => {
        try {
          await getChatSearchService().deleteWorktreeDocs(
            scope.projectId,
            scope.worktreeId,
          );
        } catch (error) {
          // Search rows are rebuildable derived data. Their worker becoming
          // unavailable must not retain the canonical plan ownership row.
          // eslint-disable-next-line no-console
          console.error(
            '[plan-explore-cleanup] Failed to remove derived chat search rows',
            error,
          );
        }
      },
    });
  }
  steps.push({
    label: 'attachments',
    run: (): Promise<void> =>
      rm(getWorktreeAttachmentsDir(scope.projectId, scope.worktreeId), {
        recursive: true,
        force: true,
      }),
  });
  steps.push({
    label: 'runtime metadata',
    run: async (): Promise<void> => {
      // A refused canonical deletion retains its terminal history and metadata.
      if (!chatScopeRemoved) return;
      const path = join(
        getWorktreeDataRootDir(scope.projectId),
        scope.worktreeId,
      );
      const directory = beginDirectoryDeletion(path);
      try {
        await terminalPersistenceStore.retireTerminalRecord(scope);
        await drainDirectoryEffects(path);
        await removePersistedWorktreeDataDirectory(
          scope.projectId,
          scope.worktreeId,
          {
            worktreeDataRootDir: getWorktreeDataRootDir(scope.projectId),
            removeTree: removeTreeWithoutAsar,
          },
        );
      } finally {
        directory.settle(await directoryRemovalOutcome(path));
      }
    },
  });
  return steps;
}

function buildPlanFileStep(
  planId: string,
  owner: PlanExploreTargetRef,
): CleanupStep {
  return {
    label: 'materialized plan file',
    run: async (): Promise<void> => {
      // Drop the sync state (pending debounce, baseline, visibility) first so
      // nothing refreshes the working copy after its directory is removed.
      getPlanFileSyncService().forgetPlanFile({
        projectId: owner.projectId,
        worktreeId: owner.worktreeId,
        planId,
      });
      await rm(
        getPlanExploreFileDir(owner.projectId, owner.worktreeId, planId),
        {
          recursive: true,
          force: true,
        },
      );
    },
  };
}

/**
 * Remove one plan's explore chat scope and everything keyed by it, on behalf
 * of the worktree that owns the plan. Returns human-readable warnings for
 * steps that failed; it never throws for a plan that was never explored.
 */
export async function removePlanExploreChat(
  planId: string,
  owner: PlanExploreTargetRef,
): Promise<string[]> {
  validateId(planId, 'planId');
  const row = await getPlanExploreTarget(planId);
  // A row registered to another worktree names that worktree's same-id plan:
  // its sentinel takeover chat is not this owner's to reclaim.
  const ownsSentinel = row === null || isSamePlanExploreScope(row, owner);
  const steps: CleanupStep[] = [];
  if (ownsSentinel) {
    const hasChatScope =
      row !== null || (await hasPlanExploreChatStorage(planId));
    steps.push(...buildSentinelSteps(planId, hasChatScope));
  }
  steps.push(buildPlanFileStep(planId, owner));
  const warnings: string[] = [];
  // Sequential on purpose: live teardown precedes the chat-state deletion
  // boundary, and the registry row is dropped last so a failed run stays
  // discoverable by the next worktree cleanup sweep.
  for (const step of steps) {
    try {
      await step.run();
    } catch (error) {
      warnings.push(buildWarning(planId, step.label, error));
    }
  }
  if (warnings.length === 0) {
    try {
      // Owner-validated: a foreign row reports `'other-scope'` and stays.
      await removePlanExploreTarget(planId, owner);
    } catch (error) {
      warnings.push(buildWarning(planId, 'registry entry', error));
    }
  }
  return warnings;
}

/**
 * Remove every plan-explore chat that belongs to `(projectId, worktreeId)`.
 * `knownPlanIds` are the worktree's tracked plan ids read before their file
 * is deleted; the registry sweep additionally catches takeover rows owned by
 * this worktree whose plan row is already gone. Ends by dropping every
 * plan-file sync state held for the scope.
 */
export async function removePlanExploreChatsForWorktree(
  projectId: string,
  worktreeId: string,
  knownPlanIds: readonly string[],
): Promise<string[]> {
  const owner: PlanExploreTargetRef = { projectId, worktreeId };
  const planIds = new Set(knownPlanIds);
  for (const planId of await listPlanExploreTargetIdsForScope(owner)) {
    planIds.add(planId);
  }
  const warnings: string[] = [];
  for (const planId of Array.from(planIds)) {
    warnings.push(...(await removePlanExploreChat(planId, owner)));
  }
  getPlanFileSyncService().forgetScope(owner);
  return warnings;
}

/**
 * Drop the worktree's plan-file sync state without touching its legacy plan
 * chats. Archiving a worktree keeps those chats with the retained archive:
 * a restore gives them back, and a permanent delete reclaims them from the
 * archive's captured plan ids.
 */
export function releasePlanFileSyncForWorktree(
  projectId: string,
  worktreeId: string,
): void {
  getPlanFileSyncService().forgetScope({ projectId, worktreeId });
}
