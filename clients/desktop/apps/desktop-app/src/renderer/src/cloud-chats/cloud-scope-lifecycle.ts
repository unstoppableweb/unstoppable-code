import { saveOpenChatDrafts } from '@/lib/chatDrafts';
import { isWebCoreScope } from '@/lib/chat-authority';
import {
  isWebCoreCoworkOnline,
  subscribeWebCoreCoworkDirectory,
} from '@/lib/cowork-directory';
import { closeWebCoreChatBackend } from '@/stores/chat/web-core';
import { splitWorktreeKey } from '@/stores/chat/utils';
import { useChatStore } from '@/stores/chatStore';

let installed = false;

/**
 * Cloud chat scopes leave the desktop chat store when the cloud goes offline
 * or is turned off (CAN-4185 D7): their streams end and their chats are
 * dropped, so nothing from an earlier connection or account is shown again.
 * Each scope also stops being tracked as live, so selecting it after the
 * cloud returns loads a fresh snapshot. Unsent drafts stay, keyed by their
 * chat, so a task that comes back has them again. Idempotent.
 */
export function ensureCloudScopeLifecycle(): void {
  if (installed) return;
  installed = true;
  subscribeWebCoreCoworkDirectory(() => {
    if (isWebCoreCoworkOnline()) return;
    closeWebCoreChatBackend();
    saveOpenChatDrafts();
    const chatStore = useChatStore.getState();
    for (const [key, chats] of Object.entries(chatStore.worktreeChats)) {
      const { projectId, worktreeId } = splitWorktreeKey(key);
      if (!isWebCoreScope(projectId)) continue;
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
