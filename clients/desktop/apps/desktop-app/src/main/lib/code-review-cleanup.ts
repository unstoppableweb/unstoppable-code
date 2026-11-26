import { join } from 'node:path';
import {
  beginDirectoryDeletion,
  directoryRemovalOutcome,
  drainDirectoryEffects,
} from './directory-effect-admission';
import { rm } from 'node:fs/promises';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { terminalPersistenceStore } from '../terminal/persistence';
import { getChatStateService } from '../services/chat-state-service';
import { getChatSearchService } from '../chat-search/service';
import { cleanupWorktreeChatPluginDirs } from '../plugins/plugin-cleanup';
import { logMainProcessWarn } from './main-process-logging';
import {
  detachCodeReviewTarget,
  isAmbiguousHistoricalCodeReviewKey,
  listCodeReviewTargets,
  markCodeReviewTargetRetiring,
  removeCodeReviewTarget,
  type CodeReviewTargetEntry,
} from './code-review-registry';
import {
  assertCodeReviewStorageWriter,
  ensureCodeReviewNamespaceQualification,
  noteCodeReviewNamespaceEffect,
  withCodeReviewTargetLifecycle,
} from './code-review-storage-admission';
import {
  cleanupLiveWorktreeState,
  purgeLiveWorktreeObservabilityData,
} from './worktree-live-cleanup';
import {
  getCodeReviewRegistryFilePath,
  getWorktreeAttachmentsDir,
  getWorktreeDataRootDir,
  withCodeReviewStorageIdentity,
} from './paths';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';

/** Caller holds the root/key lease; restart recovery reuses this exact path. */
export async function retireCodeReviewTarget(
  registryPath: string,
  scopeKey: string,
  owner: CodeReviewTargetEntry,
): Promise<void> {
  const path = join(
    getWorktreeDataRootDir(CODE_REVIEW_CHAT_PROJECT_ID),
    scopeKey,
  );
  const directory = beginDirectoryDeletion(path);
  let committed = false;
  try {
    await retireCodeReviewTargetWithDirectory(
      registryPath,
      scopeKey,
      owner,
      () => {
        committed = true;
      },
    );
  } finally {
    directory.settle(
      committed ? await directoryRemovalOutcome(path) : 'abandoned',
    );
  }
}

async function retireCodeReviewTargetWithDirectory(
  registryPath: string,
  scopeKey: string,
  owner: CodeReviewTargetEntry,
  onCommitted: () => void,
): Promise<void> {
  const scope = {
    projectId: CODE_REVIEW_CHAT_PROJECT_ID,
    worktreeId: scopeKey,
  };
  const attachments = getWorktreeAttachmentsDir(scope.projectId, scopeKey);
  const worktreeDataRootDir = getWorktreeDataRootDir(scope.projectId);
  const assertIdentity = (): void => {
    if (
      getCodeReviewRegistryFilePath() !== registryPath ||
      getWorktreeAttachmentsDir(scope.projectId, scopeKey) !== attachments ||
      getWorktreeDataRootDir(scope.projectId) !== worktreeDataRootDir
    )
      throw new Error('Code review storage routing changed during retirement.');
    for (const namespace of [
      'code_review_chats_dir',
      'code_review_state',
    ] as const)
      assertCodeReviewStorageWriter(namespace, 'main/lib/code-review-cleanup');
  };
  assertIdentity();
  const service = getChatStateService();
  await service.runWithScopeDeletionLifecycle(scope, async () => {
    assertIdentity();
    await markCodeReviewTargetRetiring(registryPath, scopeKey, owner);
    assertIdentity();
    // Service admission is closed, but teardown can still settle repository writes.
    await cleanupLiveWorktreeState(scope.projectId, scopeKey);
    assertIdentity();
    await service.runWithScopeDeletion(scope, async () => {
      await service.deleteScope(scope);
      onCommitted();
      assertIdentity();
      try {
        await getChatSearchService().deleteWorktreeDocs(
          scope.projectId,
          scopeKey,
        );
      } catch (error) {
        // Search rows are rebuildable; keep today's best-effort outcome.
        // eslint-disable-next-line no-console
        console.error(
          `[code-review-cleanup] Failed to remove derived chat search rows for legacy review chat ${scopeKey}`,
          error,
        );
      }
      assertIdentity();
      await purgeLiveWorktreeObservabilityData(scope.projectId, scopeKey);
      assertIdentity();
      cleanupWorktreeChatPluginDirs(scope.projectId, scopeKey);
      // eslint-disable-next-line admitted-writers/no-unadmitted-write -- Removes only the captured attachment directory, never registry.json; remove when cleanup no longer resolves the registry identity.
      await rm(attachments, { recursive: true, force: true });
      assertIdentity();
      // The worktree's terminal record goes with its data (CAN-7051).
      await terminalPersistenceStore.retireTerminalRecord({
        projectId: scope.projectId,
        worktreeId: scopeKey,
      });
      await drainDirectoryEffects(join(worktreeDataRootDir, scopeKey));
      await removePersistedWorktreeDataDirectory(scope.projectId, scopeKey, {
        worktreeDataRootDir,
        removeTree: removeTreeWithoutAsar,
      });
      assertIdentity();
      await removeCodeReviewTarget(scopeKey, owner, registryPath);
    });
  });
}

/**
 * Like retirement, drain admitted scope work first, so a send that resolved
 * the deleted checkout cannot start a session after teardown. Then detach,
 * so no later turn resolves it, and stop the scope's live sessions. Admission
 * reopens afterwards: the kept chats stay readable. Every step repeats on
 * every retry.
 */
async function keepCodeReviewTarget(
  registryPath: string,
  scopeKey: string,
  owner: CodeReviewTargetEntry,
): Promise<void> {
  const scope = {
    projectId: CODE_REVIEW_CHAT_PROJECT_ID,
    worktreeId: scopeKey,
  };
  await getChatStateService().runWithScopeDeletionLifecycle(scope, async () => {
    await detachCodeReviewTarget(registryPath, scopeKey, owner);
    await cleanupLiveWorktreeState(scope.projectId, scopeKey);
  });
}

/** Ordinary cleanup warns; archive purge's caller rejects these warnings. */
export async function removeCodeReviewChatsForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<string[]> {
  return withCodeReviewStorageIdentity(async () => {
    const warnings: string[] = [];
    // Read the registry after any in-flight reconciliation, failed or not.
    await ensureCodeReviewNamespaceQualification();
    noteCodeReviewNamespaceEffect('cleanup');
    const registryPath = getCodeReviewRegistryFilePath();
    for (const [scopeKey, owner] of Object.entries(
      await listCodeReviewTargets(registryPath),
    )) {
      if (owner.projectId !== projectId || owner.worktreeId !== worktreeId)
        continue;
      // CAN-6848 PR 4: leak rather than delete chats another target may own.
      // Not a warning: archive purge would reject it. A committed retirement
      // already authorized deletion, so it still finishes, including one an
      // earlier build (which ignores `detached`) started on a detached row.
      if (
        owner.state !== 'retiring' &&
        (owner.detached === true ||
          isAmbiguousHistoricalCodeReviewKey(scopeKey, owner))
      ) {
        try {
          await withCodeReviewTargetLifecycle(registryPath, scopeKey, () =>
            keepCodeReviewTarget(registryPath, scopeKey, owner),
          );
          logMainProcessWarn(
            '[code-review-cleanup] Kept a legacy review chat whose key another worktree shares',
            { scopeKey, projectId, worktreeId },
          );
        } catch (error) {
          const message = `Failed to detach legacy review chat ${scopeKey}: ${error instanceof Error ? error.message : 'unknown error'}`;
          // Base had already removed a detached row, so only a first
          // detachment, which replaces a retirement, may warn.
          if (owner.detached === true)
            logMainProcessWarn(`[code-review-cleanup] ${message}`);
          else warnings.push(message);
        }
        continue;
      }
      try {
        await withCodeReviewTargetLifecycle(registryPath, scopeKey, () =>
          retireCodeReviewTarget(registryPath, scopeKey, owner),
        );
      } catch (error) {
        warnings.push(
          `Failed to remove legacy review chat ${scopeKey}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
    return warnings;
  });
}
