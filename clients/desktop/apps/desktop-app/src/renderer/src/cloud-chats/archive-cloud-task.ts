import { webCoreLocalId } from '@/lib/chat-authority';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { cloudCoworkStore } from './cloud-cowork-store';

/** What a confirmation says when the web core didn't archive the task. */
export const CLOUD_TASK_ARCHIVE_FAILED =
  "Couldn't archive the task. Try again.";

/**
 * Archives a cloud task through the web core (CAN-6511): its own chat closes
 * in archive mode, which archives the task with its tabs and keeps it
 * restorable. Once it is archived, an open task is left, so the page never
 * shows a task the web core no longer lists. Rejects when the web core
 * doesn't archive it, leaving the task as it was, so the confirmation that
 * asked can say so.
 */
export async function archiveCloudTask(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const workspaceId = webCoreLocalId(projectId);
  const taskId = webCoreLocalId(worktreeId);
  if (workspaceId === null || taskId === null)
    throw new Error('Not a cloud task.');
  await cloudCoworkStore.getState().archiveTask(workspaceId, taskId);
  leaveCloudTask(projectId, worktreeId);
}

function leaveCloudTask(projectId: string, worktreeId: string): void {
  const standalone = useStandaloneChatStore.getState();
  const active =
    standalone.activeChatProjectId === projectId &&
    standalone.activeWorkEntryId === worktreeId;
  if (active) standalone.clearActiveWorkEntry();
  const chat = useChatStore.getState();
  const selected = chat.selectedWorktree;
  const open =
    selected?.projectId === projectId && selected.worktreeId === worktreeId;
  if (open) chat.deselectWorktree();
  chat.releaseChatScopeRevisioned(projectId, worktreeId);
  chat.cleanupWorktree(projectId, worktreeId);
  // The task's own page has nothing left to load: go home from it, and
  // nowhere else.
  const navigation = useNavigationStore.getState();
  if ((active || open) && navigation.activePage === 'chat')
    navigation.navigate('home');
}
