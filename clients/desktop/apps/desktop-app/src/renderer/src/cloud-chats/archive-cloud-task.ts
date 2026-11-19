import { webCoreLocalId } from '@/lib/chat-authority';
import { webCoreServesTaskDelete } from '@/lib/web-core-served-operations';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import { useCloudArchivedTasksStore } from './cloud-archived-tasks';
import { cloudCoworkStore } from './cloud-cowork-store';

/** What a confirmation says when the web core didn't archive the task. */
export const CLOUD_TASK_ARCHIVE_FAILED =
  "Couldn't archive the task. Try again.";

/** What a confirmation says when the web core didn't delete the task. */
export const CLOUD_TASK_DELETE_FAILED = "Couldn't delete the task. Try again.";

/**
 * Archives a cloud task through the web core (CAN-6511): its own chat closes
 * in archive mode, which archives the task with its tabs and keeps it
 * restorable. Once it is archived, an open task is left, so the page never
 * shows a task the web core no longer lists. Rejects when the web core
 * doesn't archive it, leaving the task as it was, so the confirmation that
 * asked can say so.
 */
export function archiveCloudTask(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  return retireCloudTask(projectId, worktreeId, 'archive');
}

/**
 * Deletes a cloud task through the web core (CAN-7052): its own chat closes
 * in discard mode, which moves the task with its tabs to the Trash, where it
 * stays restorable until its retention ends. Otherwise as `archiveCloudTask`.
 */
export function deleteCloudTask(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  return retireCloudTask(projectId, worktreeId, 'delete');
}

/**
 * How many days a cloud project keeps a deleted task, as the web core lists
 * it, for the Delete confirmation; undefined when it doesn't say.
 */
export function cloudTaskDeletionRetentionDays(
  projectId: string,
): number | undefined {
  const workspaceId = webCoreLocalId(projectId);
  if (workspaceId === null) return undefined;
  return cloudCoworkStore
    .getState()
    .projects.find((project) => project.workspaceId === workspaceId)
    ?.deletionRetentionDays;
}

async function retireCloudTask(
  projectId: string,
  worktreeId: string,
  removal: 'archive' | 'delete',
): Promise<void> {
  const workspaceId = webCoreLocalId(projectId);
  const taskId = webCoreLocalId(worktreeId);
  if (workspaceId === null || taskId === null)
    throw new Error('Not a cloud task.');
  // Checked here too, not only by the row that offers Delete: a menu or a
  // selection opened before the manifest changed never sends one.
  if (removal === 'delete' && !webCoreServesTaskDelete())
    throw new Error('Deleting a cloud task is not available.');
  const store = cloudCoworkStore.getState();
  await (removal === 'delete'
    ? store.deleteTask(workspaceId, taskId)
    : store.archiveTask(workspaceId, taskId));
  leaveCloudTask(projectId, worktreeId);
  // The project's More row counts it now.
  void useCloudArchivedTasksStore.getState().load(projectId);
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
