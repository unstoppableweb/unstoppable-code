import { join } from 'node:path';
import {
  beginDirectoryDeletion,
  directoryRemovalOutcome,
  drainDirectoryEffects,
} from '../lib/directory-effect-admission';
import { removePersistedWorktreeDataDirectory } from '@canopy/desktop-shared/node/lib/worktree-data-cleanup';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getWorktreeDataRootDir } from '../lib/paths';
import { removeTreeWithoutAsar } from '../lib/remove-tree-without-asar';
import { getChatStateService } from '../services/chat-state-service';
import { terminalPersistenceStore } from '../terminal/persistence';

/** Remove app-managed panel/view state when its recipient replica is purged. */
export async function cleanupSharedContainerRecipientViewState(
  containerId: string,
): Promise<void> {
  const worktreeDataRootDir = getWorktreeDataRootDir(
    SHARED_CONTAINER_VIEWER_PROJECT_ID,
  );
  const path = join(worktreeDataRootDir, containerId);
  const directory = beginDirectoryDeletion(path);
  try {
    await getChatStateService().deleteScope({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: containerId,
    });
    // The viewer's terminal record goes with its data (CAN-7051): queued
    // durably or applied first, within a bound, so the purge is never refused.
    await terminalPersistenceStore.retireTerminalRecord({
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
      worktreeId: containerId,
    });
    await drainDirectoryEffects(path);
    await removePersistedWorktreeDataDirectory(
      SHARED_CONTAINER_VIEWER_PROJECT_ID,
      containerId,
      { worktreeDataRootDir, removeTree: removeTreeWithoutAsar },
    );
  } finally {
    directory.settle(await directoryRemovalOutcome(path));
  }
}
