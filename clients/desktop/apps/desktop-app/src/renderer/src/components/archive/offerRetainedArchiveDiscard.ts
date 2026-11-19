import { offerWorktreeDiscard } from '@canopy/app-state';
import type { WorktreeDiscardDescription } from '@canopy/protocol/remote-control/shell/worktree-discard';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';

export const ARCHIVED_ITEM_DELETE_FAILED =
  "Couldn't permanently delete this item";

/**
 * CAN-5338: after an archived worktree's permanent deletion failed, offers the
 * discard when the host describes it as discardable, and resolves `true`.
 * Resolves `false` otherwise (an older or Remote Control host that doesn't
 * describe retained archives included), so the caller keeps its own message.
 */
export async function offerRetainedArchiveDiscard(
  workspaceId: string,
  containerId: string,
  retry: () => void,
): Promise<boolean> {
  if (ipcCanopyClient.capabilities.worktreeDiscard !== true) return false;
  let description: WorktreeDiscardDescription;
  try {
    description = await ipcCanopyClient.command('worktree.discard.describe', {
      workspaceId,
      worktreeId: containerId,
      retainedArchives: true,
    });
  } catch {
    return false;
  }
  if (
    description.status !== 'discardable' ||
    !description.targets.some((target) => target.kind === 'retained-archive')
  )
    return false;
  const summary = useArchivedContainersStore
    .getState()
    .byWorkspace[workspaceId]?.find((entry) => entry.id === containerId);
  offerWorktreeDiscard({
    workspaceId,
    worktreeId: containerId,
    worktreeName: summary?.label?.trim() || summary?.name || containerId,
    message: ARCHIVED_ITEM_DELETE_FAILED,
    description,
    retainedArchives: true,
    retry,
  });
  return true;
}
