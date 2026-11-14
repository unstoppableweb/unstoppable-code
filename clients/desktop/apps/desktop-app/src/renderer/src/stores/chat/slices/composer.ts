import { type Descendant } from 'slate';
import { appendSelectionToList } from '@/lib/editorSelectionContext';
import {
  getWorktreeChatContext,
  updateActiveTabInWorktree,
  updateCapturedChatTab,
} from '../context';
import { worktreeKey } from '../utils';
import { appendUniquePendingAttachments } from '../attachments';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatComposerSlice } from '../state';
import { isScopeRevisionedLive } from './revisioned';
import { saveTryItDraft, clearTryItDraft } from '@/lib/tryItDraftStorage';
import {
  cancelChatDraftWrite,
  claimChatDraftSaveFailureReport,
  readStoredTabDraft,
  removeChatDraft,
  scheduleChatDraftWrite,
  writeChatDraft,
} from '@/lib/chatDraftStorage';

type ComposerSet = Parameters<
  StateCreator<ChatState, [], [], ChatComposerSlice>
>[0];

// Typing goes on: a draft that couldn't be stored stays in memory.
function reportDraftSaveFailure(set: ComposerSet, tabId: string): void {
  if (claimChatDraftSaveFailureReport()) set({ tabDraftSaveFailure: tabId });
}

export const createComposerSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatComposerSlice
> = (set, get) => ({
  tabDrafts: {},

  tabDraftRestoreFailures: {},

  dismissTabDraftRestoreFailure: (tabId): void => {
    set((state) => {
      if (!(tabId in state.tabDraftRestoreFailures)) return state;
      const next = { ...state.tabDraftRestoreFailures };
      delete next[tabId];
      return { tabDraftRestoreFailures: next };
    });
  },

  tabDraftSaveFailure: null,

  dismissTabDraftSaveFailure: (): void => {
    set((state) =>
      state.tabDraftSaveFailure === null
        ? state
        : { tabDraftSaveFailure: null },
    );
  },

  composerTextPresent: {},

  setComposerTextPresent: (tabId, present): void => {
    set((state) => {
      const current = state.composerTextPresent[tabId] === true;
      if (current === present) return state;
      const next = { ...state.composerTextPresent };
      if (present) {
        next[tabId] = true;
      } else {
        delete next[tabId];
      }
      return { composerTextPresent: next };
    });
  },

  saveTabDraft: (tabId, content): void => {
    cancelChatDraftWrite(tabId);
    let stagedTryIt = true;
    try {
      stagedTryIt = saveTryItDraft(tabId, content);
    } catch {
      /* Keep edits in memory if browser storage becomes unavailable. */
    }
    if (stagedTryIt) {
      removeChatDraft(tabId);
    } else if (writeChatDraft(tabId, content) === 'failed') {
      reportDraftSaveFailure(set, tabId);
    }
    set((state) => ({
      tabDrafts: { ...state.tabDrafts, [tabId]: content },
    }));
  },

  scheduleTabDraftWrite: (tabId, content): void => {
    scheduleChatDraftWrite(tabId, content, () =>
      reportDraftSaveFailure(set, tabId),
    );
  },

  getTabDraft: (tabId): Descendant[] | undefined => {
    const inMemory = get().tabDrafts[tabId];
    if (inMemory) return inMemory;
    const stored = readStoredTabDraft(tabId);
    return stored.kind === 'draft' ? stored.content : undefined;
  },

  clearTabDraft: (tabId): void => {
    clearTryItDraft(tabId);
    removeChatDraft(tabId);
    set((state) => {
      if (
        !(tabId in state.tabDrafts) &&
        !(tabId in state.tabDraftRestoreFailures)
      )
        return state;
      const next = { ...state.tabDrafts };
      delete next[tabId];
      const failures = { ...state.tabDraftRestoreFailures };
      delete failures[tabId];
      return { tabDrafts: next, tabDraftRestoreFailures: failures };
    });
  },

  pendingEditorSelections: {},

  addPendingEditorSelection: (tabId, selection): void => {
    set((state) => {
      const existing = state.pendingEditorSelections[tabId];
      const next = appendSelectionToList(existing, selection);
      if (next === existing) return state;
      return {
        pendingEditorSelections: {
          ...state.pendingEditorSelections,
          [tabId]: next,
        },
      };
    });
  },

  removePendingEditorSelection: (tabId, selectionId): void => {
    set((state) => {
      const existing = state.pendingEditorSelections[tabId];
      if (!existing) return state;
      const next = existing.filter((entry) => entry.id !== selectionId);
      if (next.length === existing.length) return state;
      const record = { ...state.pendingEditorSelections };
      if (next.length === 0) {
        delete record[tabId];
      } else {
        record[tabId] = next;
      }
      return { pendingEditorSelections: record };
    });
  },

  clearPendingEditorSelections: (tabId): void => {
    set((state) => {
      if (!(tabId in state.pendingEditorSelections)) return state;
      const record = { ...state.pendingEditorSelections };
      delete record[tabId];
      return { pendingEditorSelections: record };
    });
  },

  reservePendingRevertAttachment: (target): string | undefined => {
    const context = getWorktreeChatContext(get(), target);
    const path = context?.activeTab?.pendingRevertAttachmentPath;
    if (!context || !path) return undefined;
    set((state) =>
      updateCapturedChatTab(state, context, (tab) => {
        if (tab.pendingRevertAttachmentPath !== path) return tab;
        const next = { ...tab };
        delete next.pendingRevertAttachmentPath;
        return next;
      }),
    );
    return path;
  },

  restorePendingRevertAttachment: (absolutePath, target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    set((state) =>
      updateCapturedChatTab(state, context, (tab) =>
        tab.pendingRevertAttachmentPath
          ? tab
          : { ...tab, pendingRevertAttachmentPath: absolutePath },
      ),
    );
  },

  scheduledSendModalOpen: false,

  setScheduledSendModalOpen: (open: boolean): void => {
    set((state) =>
      state.scheduledSendModalOpen === open
        ? state
        : { scheduledSendModalOpen: open },
    );
  },

  setScheduledSendDraft: async (draft, target): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return;
    set((state) =>
      updateCapturedChatTab(state, context, (t) => {
        const next = { ...t };
        if (draft) {
          next.scheduledSendDraft = draft;
        } else {
          delete next.scheduledSendDraft;
        }
        return next;
      }),
    );
    if (
      isScopeRevisionedLive(
        get(),
        context.selection.projectId,
        context.selection.worktreeId,
      )
    ) {
      await get().dispatchChatCommand(context.selection, {
        type: 'chat.set_scheduled_send_draft',
        chatId: context.chatId,
        draft: draft ?? null,
      });
    }
  },

  clearScheduledSendComposerState: (target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return;
    set((state) => {
      const next = updateCapturedChatTab(state, context, (t) => {
        const tab = { ...t };
        tab.pendingAttachments = undefined;
        delete tab.pendingRevertAttachmentPath;
        delete tab.scheduledSendDraft;
        return tab;
      });
      return next;
    });
    if (
      isScopeRevisionedLive(
        get(),
        context.selection.projectId,
        context.selection.worktreeId,
      )
    ) {
      void get().dispatchChatCommand(context.selection, {
        type: 'chat.set_scheduled_send_draft',
        chatId: context.chatId,
        draft: null,
        clearPendingRevertAttachment: true,
      });
    }
  },

  addPendingAttachments: (attachments, target): void => {
    const sel = target
      ? { projectId: target.projectId, worktreeId: target.worktreeId }
      : get().selectedWorktree;
    if (!sel) return;
    const key = worktreeKey(sel);
    set((state) => {
      if (!target) {
        return updateActiveTabInWorktree(state, key, (tab) => ({
          ...tab,
          pendingAttachments: appendUniquePendingAttachments(
            tab.pendingAttachments,
            attachments,
          ),
        }));
      }

      const worktreeChat = state.worktreeChats[key];
      if (!worktreeChat) return state;

      return updateCapturedChatTab(
        state,
        {
          selection: sel,
          key,
          worktreeChat,
          chatId: target.chatId,
          activeTab: worktreeChat.tabs.find((tab) => tab.id === target.chatId),
        },
        (tab) => ({
          ...tab,
          pendingAttachments: appendUniquePendingAttachments(
            tab.pendingAttachments,
            attachments,
          ),
        }),
      );
    });
  },

  removePendingAttachment: (absolutePath, target): void => {
    const sel = target
      ? { projectId: target.projectId, worktreeId: target.worktreeId }
      : get().selectedWorktree;
    if (!sel) return;
    const key = worktreeKey(sel);
    set((state) => {
      if (!target) {
        return updateActiveTabInWorktree(state, key, (tab) => ({
          ...tab,
          pendingAttachments: (tab.pendingAttachments ?? []).filter(
            (attachment) => attachment.absolutePath !== absolutePath,
          ),
        }));
      }

      const worktreeChat = state.worktreeChats[key];
      if (!worktreeChat) return state;

      return updateCapturedChatTab(
        state,
        {
          selection: sel,
          key,
          worktreeChat,
          chatId: target.chatId,
          activeTab: worktreeChat.tabs.find((tab) => tab.id === target.chatId),
        },
        (tab) => ({
          ...tab,
          pendingAttachments: (tab.pendingAttachments ?? []).filter(
            (attachment) => attachment.absolutePath !== absolutePath,
          ),
        }),
      );
    });
  },

  clearPendingAttachments: (): void => {
    const sel = get().selectedWorktree;
    if (!sel) return;
    const key = worktreeKey(sel);
    set((state) =>
      updateActiveTabInWorktree(state, key, (tab) => ({
        ...tab,
        pendingAttachments: undefined,
      })),
    );
  },
});
