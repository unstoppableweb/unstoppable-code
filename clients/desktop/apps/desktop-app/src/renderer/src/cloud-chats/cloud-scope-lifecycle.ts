import { saveOpenChatDrafts } from '@/lib/chatDrafts';
import { isWebCoreScope } from '@/lib/chat-authority';
import {
  isWebCoreCoworkOnline,
  subscribeWebCoreCoworkDirectory,
} from '@/lib/cowork-directory';
import { closeWebCoreChatBackend } from '@/stores/chat/web-core';
import { splitWorktreeKey } from '@/stores/chat/utils';
import { useChatStore } from '@/stores/chatStore';
import { installWebCoreAgentTasksPublisher } from './web-core-agent-tasks-publisher';
import {
  deletedChatsKeptThroughOffline,
  deletedTasksKeptThroughOffline,
  installCloudTaskDeletionHandler,
  rekeepDeletedChats,
  remarkDeletedTasks,
} from './cloud-task-deletion';

let installed = false;

/**
 * Cloud chat scopes leave the desktop chat store when the cloud goes offline
 * or is turned off (CAN-4185 D7): their streams end and their chats are
 * dropped, so nothing from an earlier connection or account is shown again.
 * Each scope also stops being tracked as live, so selecting it after the
 * cloud returns loads a fresh snapshot. Unsent drafts stay, keyed by their
 * chat, so a task that comes back has them again. A task deleted on another
 * device keeps its chat, which nothing can read again. Idempotent.
 */
export function ensureCloudScopeLifecycle(): void {
  if (installed) return;
  installed = true;
  installWebCoreAgentTasksPublisher();
  installCloudTaskDeletionHandler();
  subscribeWebCoreCoworkDirectory(() => {
    if (isWebCoreCoworkOnline()) return;
    // A task deleted on another device can't be read again: its chat, with
    // its draft and attachments, stays through offline for the same account,
    // and its row comes back with the cloud (CAN-6614).
    const deleted = deletedTasksKeptThroughOffline();
    // A chat deleted on its own keeps its mark and tab; its live task goes
    // as usual and brings the chat back when it is read again.
    const deletedChats = deletedChatsKeptThroughOffline();
    const keep = new Set(
      deleted.map((scope) => `${scope.projectId}/${scope.worktreeId}`),
    );
    closeWebCoreChatBackend();
    remarkDeletedTasks(deleted);
    rekeepDeletedChats(deletedChats);
    saveOpenChatDrafts();
    const chatStore = useChatStore.getState();
    for (const [key, chats] of Object.entries(chatStore.worktreeChats)) {
      const { projectId, worktreeId } = splitWorktreeKey(key);
      if (!isWebCoreScope(projectId) || keep.has(key)) continue;
      const drafts = chats.tabs.flatMap((tab) => {
        const draft = chatStore.tabDrafts[tab.id];
        return draft === undefined ? [] : [{ tabId: tab.id, draft }];
      });
      chatStore.releaseChatScopeRevisioned(projectId, worktreeId);
      chatStore.cleanupWorktree(projectId, worktreeId);
      for (const { tabId, draft } of drafts) {
        chatStore.saveTabDraft(tabId, draft);
      }
    }
  });
}
