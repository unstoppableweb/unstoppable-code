import { rm } from 'node:fs/promises';
import { CODE_REVIEW_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { getChatStateService } from '../services/chat-state-service';
import { getChatSearchService } from '../chat-search/service';
import { cleanupWorktreeChatPluginDirs } from '../plugins/plugin-cleanup';
import {
  listCodeReviewTargets,
  markCodeReviewTargetRetiring,
  removeCodeReviewTarget,
  type CodeReviewTargetEntry,
} from './code-review-registry';
import {
  assertCodeReviewStorageWriter,
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
} from './paths';
import { removeTreeWithoutAsar } from './remove-tree-without-asar';

/** Caller holds the root/key lease; restart recovery reuses this exact path. */
export async function retireCodeReviewTarget(
  registryPath: string,
  scopeKey: string,
  owner: CodeReviewTargetEntry,
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
      await removePersistedWorktreeDataDirectory(scope.projectId, scopeKey, {
        worktreeDataRootDir,
        removeTree: removeTreeWithoutAsar,
      });
      assertIdentity();
      await removeCodeReviewTarget(scopeKey, owner, registryPath);
    });
  });
}

/** Ordinary cleanup warns; archive purge's caller rejects these warnings. */
export async function removeCodeReviewChatsForWorktree(
  projectId: string,
  worktreeId: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const registryPath = getCodeReviewRegistryFilePath();
  for (const [scopeKey, owner] of Object.entries(
    await listCodeReviewTargets(registryPath),
  )) {
    if (owner.projectId !== projectId || owner.worktreeId !== worktreeId)
      continue;
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
}
