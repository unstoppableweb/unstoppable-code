import {
  beginDirectoryDeletion,
  directoryRemovalOutcome,
  drainDirectoryEffects,
} from '../lib/directory-effect-admission';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { WorkerTerminalRecordRetireParamsSchema } from '@canopy/protocol/canopy-core';
import {
  removePersistedWorktreeDataDirectory,
  WORKTREE_DATA_REMOVE_MAX_RETRIES,
  WORKTREE_DATA_REMOVE_RETRY_DELAY_MS,
} from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import {
  terminalPersistenceStore,
  recipientTerminalRetirementPath,
} from '../terminal/persistence';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import {
  getSharedContainerRunRootDir,
  getWorktreeDataRootDir,
} from '../lib/paths';
import { removeTreeWithoutAsar } from '../lib/remove-tree-without-asar';
import { getChatStateService } from '../services/chat-state-service';
import { isRecord } from '../lib/type-guards';
import { logMainProcessWarn } from '../lib/main-process-logging';

/** A malformed journal names no retirement, so the sweep scrubs it with the rest. */
function isRetirementJournal(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  return (
    isRecord(value) &&
    value.version === 1 &&
    Object.keys(value).length === 2 &&
    Array.isArray(value.recipientRetirements) &&
    value.recipientRetirements.every(
      (intent) =>
        WorkerTerminalRecordRetireParamsSchema.safeParse(intent).success,
    )
  );
}

/** Remove app-managed panel/view state when its recipient replica is purged. */
export async function cleanupSharedContainerRecipientViewState(
  containerId: string,
): Promise<void> {
  const path = dirname(
    recipientTerminalRetirementPath(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      containerId,
    ),
  );
  const directory = beginDirectoryDeletion(path);
  try {
    await cleanupRecipientViewState(containerId);
  } finally {
    directory.settle(await directoryRemovalOutcome(path));
  }
}

async function cleanupRecipientViewState(containerId: string): Promise<void> {
  await getChatStateService().deleteScope({
    projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    worktreeId: containerId,
  });
  // The viewer's terminal record goes with its data (CAN-7051): queued
  // durably or applied first, within a bound, so the purge is never refused.
  const retirementSaved =
    await terminalPersistenceStore.retireRecipientTerminalRecord(containerId);
  await drainDirectoryEffects(
    dirname(
      recipientTerminalRetirementPath(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
        containerId,
      ),
    ),
  );
  // Keep only a non-sensitive, exact retry fence discoverable by the next purge.
  // Runnable-copy recreation must not authorize the predecessor's history.
  if (!retirementSaved) {
    const path = recipientTerminalRetirementPath(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      containerId,
    );
    let keepFence: boolean;
    try {
      keepFence = isRetirementJournal(await readFile(path, 'utf8'));
    } catch (error) {
      // An unread journal may still name a pending retirement, and admission
      // stays closed on it; keep it. Absence, or a directory there, names nothing.
      keepFence =
        !isRecord(error) ||
        (error.code !== 'ENOENT' && error.code !== 'EISDIR');
      if (keepFence)
        logMainProcessWarn('Could not read the recipient retirement journal');
    }
    const directory = dirname(path);
    const entries = await readdir(directory).catch((error: unknown) => {
      if (!isRecord(error) || error.code !== 'ENOENT')
        logMainProcessWarn('Could not enumerate retired recipient view state');
      return [];
    });
    for (const name of entries) {
      if (keepFence && name === basename(path)) continue;
      await removeTreeWithoutAsar(join(directory, name), {
        recursive: true,
        force: true,
        maxRetries: WORKTREE_DATA_REMOVE_MAX_RETRIES,
        retryDelay: WORKTREE_DATA_REMOVE_RETRY_DELAY_MS,
      }).catch(() =>
        logMainProcessWarn('Could not scrub retired recipient view state'),
      );
    }
    await removeTreeWithoutAsar(getSharedContainerRunRootDir(containerId), {
      recursive: true,
      force: true,
      maxRetries: WORKTREE_DATA_REMOVE_MAX_RETRIES,
      retryDelay: WORKTREE_DATA_REMOVE_RETRY_DELAY_MS,
    });
    return;
  }
  await removePersistedWorktreeDataDirectory(
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
    containerId,
    {
      worktreeDataRootDir: getWorktreeDataRootDir(
        SHARED_CONTAINER_VIEWER_PROJECT_ID,
      ),
      removeTree: removeTreeWithoutAsar,
    },
  );
}
