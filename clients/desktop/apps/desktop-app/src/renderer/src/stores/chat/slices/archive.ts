import { resolveTabDefaults } from '../defaults';
import { type ChatTab, type WorktreeChatState } from '../types';
import { fromPersistedTab, relabelFileTabs } from '../persisted-tabs';
import { buildHandoffConversationText } from '../messages';
import { type Descendant } from 'slate';
import { type PersistedChatTab } from '@canopy/desktop-shared/types';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatArchiveSlice } from '../state';
import { chatBackendFor } from '../backend';

export const createArchiveSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatArchiveSlice
> = (set, get) => ({
  archivedChats: {},

  loadArchivedChats: async (projectId, worktreeId): Promise<void> => {
    // Best-effort: the archive transport may not be wired in every host (tests,
    // or before the backend handlers ship). A missing method or a rejected call
    // simply leaves the current list untouched, so the icon stays hidden.
    if (typeof chatBackendFor({ projectId }).chat.loadArchives !== 'function') {
      return;
    }
    const key = `${projectId}/${worktreeId}`;
    try {
      const summaries = await chatBackendFor({ projectId }).chat.loadArchives({
        projectId,
        worktreeId,
      });
      set((state) => ({
        archivedChats: { ...state.archivedChats, [key]: summaries },
      }));
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.warn('Failed to load archived chats', error);
    }
  },

  restoreArchivedChat: async (projectId, worktreeId, chatId): Promise<void> => {
    const key = `${projectId}/${worktreeId}`;
    // Main owns the archive/live-state transaction. Hydrate the returned
    // canonical tab only after that transaction has durably committed.
    const { tab: persisted } = await chatBackendFor({
      projectId,
    }).chat.restoreArchive({
      projectId,
      worktreeId,
      chatId,
    });
    // Mirror the eager-hydration call site so the restored tab adopts the
    // worktree's resolved model defaults. `fromPersistedTab` carries
    // `sdkSessionId` through untouched, so the next send resumes the same
    // provider session.
    const modelDefaults = await get().ensureModelDefaultsLoaded();
    const { thinkingLevel: defaultThinking, modelConfig: defaultModelConfig } =
      resolveTabDefaults(projectId, modelDefaults);
    const restoredTab: ChatTab = {
      ...fromPersistedTab(persisted, {
        modelConfig: defaultModelConfig,
        thinkingLevel: defaultThinking,
      }),
      // A user-initiated restore stops auto-archiving: drop the marker so the
      // chat no longer re-archives when its next turn finishes.
      autoArchive: undefined,
    };

    set((state) => {
      const wc = state.worktreeChats[key];
      const baseTabs = (wc?.tabs ?? []).filter(
        (tab) => tab.id !== restoredTab.id,
      );
      const updated: WorktreeChatState = {
        tabs: relabelFileTabs([...baseTabs, restoredTab]),
        activeTabId: restoredTab.id,
      };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });

    // Refresh the summary list so the popover/modal and the archive icon's
    // visibility update.
    await get().loadArchivedChats(projectId, worktreeId);
  },

  summarizeArchivedChat: async (
    projectId,
    worktreeId,
    chatId,
  ): Promise<void> => {
    const key = `${projectId}/${worktreeId}`;
    // Non-destructive read — the archive entry stays in place after Summarize.
    const { tab: archivedTab } = await chatBackendFor({
      projectId,
    }).chat.readArchive({
      projectId,
      worktreeId,
      chatId,
      fullTranscript: true,
    });
    const conversationText = buildHandoffConversationText(archivedTab.messages);
    const { summary } = await chatBackendFor({
      projectId,
    }).chat.generateHandoffSummary({
      projectId,
      worktreeId,
      conversationText,
      kind: 'archived-chat',
      chatId,
    });
    const trimmedSummary = summary.trim();

    // Open a fresh empty tab in the target worktree; `appendNewTab` sets it
    // active, so the new id is read straight back off `activeTabId`.
    get().createTab({ projectId, worktreeId });
    const newTabId = get().worktreeChats[key]?.activeTabId;
    if (!newTabId) {
      return;
    }

    const handoffDraft = `[SESSION HANDOFF]

This is a continuation of a previous chat session. Below is a summary of what was discussed. Use this context to continue seamlessly.

---
${trimmedSummary}
---`;
    // Prefill the composer draft (a Slate `Descendant[]`) for the user to
    // review/edit before sending, rather than auto-sending.
    const draft: Descendant[] = [
      { type: 'paragraph', children: [{ text: handoffDraft }] },
    ];
    get().saveTabDraft(newTabId, draft);
  },

  setAutoArchiveForActiveTurn: (target, enabled): void => {
    const key = `${target.projectId}/${target.worktreeId}`;
    const previousTab = get().worktreeChats[key]?.tabs.find(
      (tab) => tab.id === target.chatId && tab.kind !== 'file',
    );
    if (!previousTab) return;
    const previousAutoArchive = previousTab.autoArchive;
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      let changed = false;
      const tabs = wc.tabs.map((tab) => {
        if (tab.id !== target.chatId || tab.kind === 'file') return tab;
        const nextAutoArchive = enabled ? true : undefined;
        if (
          tab.autoArchive === nextAutoArchive &&
          tab.autoArchiveToggleVisible === true
        ) {
          return tab;
        }
        changed = true;
        return {
          ...tab,
          autoArchive: nextAutoArchive,
          autoArchiveToggleVisible: true,
        };
      });
      if (!changed) return state;
      const updated: WorktreeChatState = { ...wc, tabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });
    if (get().chatStateSync[key] !== undefined) {
      void get().dispatchChatCommand(
        { projectId: target.projectId, worktreeId: target.worktreeId },
        {
          type: 'chat.patch_tab_settings',
          tabId: target.chatId,
          patch: { autoArchive: enabled ? true : null },
        },
        {
          rollback: () => {
            set((state) => {
              const wc = state.worktreeChats[key];
              if (!wc) return state;
              return {
                worktreeChats: {
                  ...state.worktreeChats,
                  [key]: {
                    ...wc,
                    tabs: wc.tabs.map((tab) =>
                      tab.id === target.chatId && tab.kind !== 'file'
                        ? { ...tab, autoArchive: previousAutoArchive }
                        : tab,
                    ),
                  },
                },
              };
            });
          },
        },
      );
    }
  },

  unarchiveChatForNewResponse: async (
    projectId,
    worktreeId,
    chatId,
  ): Promise<void> => {
    const key = `${projectId}/${worktreeId}`;
    // Already live? Nothing to do (covers races where two events arrive).
    if (get().worktreeChats[key]?.tabs.some((t) => t.id === chatId)) {
      return;
    }
    let persisted: PersistedChatTab;
    try {
      const response = await chatBackendFor({ projectId }).chat.restoreArchive({
        projectId,
        worktreeId,
        chatId,
      });
      persisted = response.tab;
    } catch {
      return;
    }

    const modelDefaults = await get().ensureModelDefaultsLoaded();
    const { thinkingLevel: defaultThinking, modelConfig: defaultModelConfig } =
      resolveTabDefaults(projectId, modelDefaults);
    // Keep the `autoArchive` marker so the chat re-archives once the resumed
    // turn finishes.
    const restoredTab = fromPersistedTab(persisted, {
      modelConfig: defaultModelConfig,
      thinkingLevel: defaultThinking,
    });

    set((state) => {
      const wc = state.worktreeChats[key];
      if (wc?.tabs.some((t) => t.id === chatId)) {
        return state;
      }
      const baseTabs = wc?.tabs ?? [];
      // Background un-archive: do NOT steal focus — keep the current active tab
      // unless there was none.
      const updated: WorktreeChatState = {
        ...(wc ?? { lastActiveEditableChatId: restoredTab.id }),
        tabs: relabelFileTabs([...baseTabs, restoredTab]),
        activeTabId: wc?.activeTabId ?? restoredTab.id,
      };
      return { worktreeChats: { ...state.worktreeChats, [key]: updated } };
    });
    await get().loadArchivedChats(projectId, worktreeId);
  },

  markArchivedChatRead: async (
    projectId,
    worktreeId,
    chatId,
  ): Promise<void> => {
    if (
      typeof chatBackendFor({ projectId }).chat.markArchiveRead !== 'function'
    ) {
      return;
    }
    const key = `${projectId}/${worktreeId}`;
    try {
      const summaries = await chatBackendFor({
        projectId,
      }).chat.markArchiveRead({
        projectId,
        worktreeId,
        chatId,
      });
      set((state) => ({
        archivedChats: { ...state.archivedChats, [key]: summaries },
      }));
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.warn('Failed to mark archived chat read', error);
    }
  },

  markAllArchivedChatsRead: async (projectId, worktreeId): Promise<void> => {
    if (
      typeof chatBackendFor({ projectId }).chat.markAllArchivesRead !==
      'function'
    ) {
      return;
    }
    const key = `${projectId}/${worktreeId}`;
    try {
      const summaries = await chatBackendFor({
        projectId,
      }).chat.markAllArchivesRead({
        projectId,
        worktreeId,
      });
      set((state) => ({
        archivedChats: { ...state.archivedChats, [key]: summaries },
      }));
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.warn('Failed to mark all archived chats read', error);
    }
  },
});
