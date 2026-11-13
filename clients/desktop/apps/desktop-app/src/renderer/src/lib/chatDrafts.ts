import type { Descendant } from 'slate';
import { useChatStore, type WorktreeChatState } from '@/stores/chatStore';

/**
 * Asks the composer showing `detail.tabId` to empty itself, as Discard in an
 * unsaved-changes prompt does to a draft it counted.
 */
export const DISCARD_CHAT_DRAFT_EVENT = 'canopy:discard-chat-draft';

/** Drops a chat tab's unsent draft: the saved copy and the composer's text. */
export function discardChatDraft(tabId: string): void {
  useChatStore.getState().clearTabDraft(tabId);
  document.dispatchEvent(
    new CustomEvent(DISCARD_CHAT_DRAFT_EVENT, { detail: { tabId } }),
  );
}

/** Asks every mounted composer to save its tab's draft now. */
export const SAVE_CHAT_DRAFTS_EVENT = 'canopy:save-chat-drafts';

/**
 * Saves the text in every open composer before its tab leaves the store. A
 * composer saves on its own only when its tab changes or it unmounts, and
 * by then a dropped tab is gone and the save is skipped.
 */
export function saveOpenChatDrafts(): void {
  document.dispatchEvent(new CustomEvent(SAVE_CHAT_DRAFTS_EVENT));
}

export interface ChatDraftStoreSnapshot {
  worktreeChats: Record<string, WorktreeChatState>;
  saveTabDraft: (tabId: string, content: Descendant[]) => void;
}

export function tabExistsInWorktreeChats(
  tabId: string,
  worktreeChats: Record<string, WorktreeChatState>,
): boolean {
  return Object.values(worktreeChats).some((wc) =>
    wc.tabs.some((tab) => tab.id === tabId),
  );
}

export function saveDraftForExistingTab(
  state: ChatDraftStoreSnapshot,
  tabId: string | null,
  content: Descendant[],
): void {
  if (tabId === null) {
    return;
  }

  if (!tabExistsInWorktreeChats(tabId, state.worktreeChats)) {
    return;
  }

  state.saveTabDraft(tabId, structuredClone(content));
}
