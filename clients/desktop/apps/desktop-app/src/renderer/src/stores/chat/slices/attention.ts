import { useNavigationStore } from '../../navigationStore';
import { isMainContentCoveredByAppAdvisorDock } from '../../appAdvisorDockCover';
import { getCurrentChatPanelVisible } from '@/lib/worktree-layout-prefs';
import { worktreeKey } from '../utils';
import {
  hasPendingAttentionLanding,
  preservesLandedAttention,
} from '../attention-landing-intent';
import {
  tabNeedsVisibleAcknowledgement,
  tabsStillNeedAttention,
} from '../notifications';
import { clearRecordedUnreadChatAgentResponsePreview } from '../unread-previews';
import { scheduleIdleChatUnload } from '../hydration';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatAttentionSlice } from '../state';
import {
  dropPendingUnread,
  isScopeRevisionedLive,
  persistUnreadWhenScopeLive,
} from './revisioned';

export const createAttentionSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatAttentionSlice
> = (set, get) => ({
  unreadWorktreeKeys: new Set<string>(),
  persistedWorktreeBadges: {},

  seedPersistedWorktreeBadges: (byKey): void => {
    set((state) => {
      let nextBadges: ChatState['persistedWorktreeBadges'] | null = null;
      let nextUnread: Set<string> | null = null;
      for (const [key, summary] of Object.entries(byKey)) {
        // Hydrated worktrees carry authoritative live tab state.
        if (state.worktreeChats[key] !== undefined) {
          continue;
        }
        if (!nextBadges) {
          nextBadges = { ...state.persistedWorktreeBadges };
        }
        nextBadges[key] = summary;
        if (
          summary.unreadChats.length > 0 &&
          !(nextUnread ?? state.unreadWorktreeKeys).has(key)
        ) {
          nextUnread = nextUnread ?? new Set(state.unreadWorktreeKeys);
          nextUnread.add(key);
        }
      }
      if (!nextBadges && !nextUnread) {
        return state;
      }
      return {
        ...(nextBadges ? { persistedWorktreeBadges: nextBadges } : {}),
        ...(nextUnread ? { unreadWorktreeKeys: nextUnread } : {}),
      };
    });
  },

  acknowledgeSelectedWorktreeAttention: (): void => {
    const selected = get().selectedWorktree;
    if (
      !selected ||
      useNavigationStore.getState().activePage !== 'main' ||
      !getCurrentChatPanelVisible() ||
      isMainContentCoveredByAppAdvisorDock()
    ) {
      return;
    }

    const key = worktreeKey(selected);
    if (hasPendingAttentionLanding(key)) return;
    let acknowledgedChatId: string | undefined;

    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;

      const activeTab = wc.tabs.find((tab) => tab.id === wc.activeTabId);
      const activeTabVisible =
        activeTab !== undefined && !state.hiddenChatTabIds.has(activeTab.id);
      const needsTabClear =
        activeTabVisible && tabNeedsVisibleAcknowledgement(activeTab);
      if (needsTabClear) acknowledgedChatId = activeTab.id;

      const dismissedAt = Date.now();
      const tabs = needsTabClear
        ? wc.tabs.map((tab) =>
            tab.id === wc.activeTabId
              ? {
                  ...tab,
                  unread: false,
                  ...(preservesLandedAttention(key, tab.id)
                    ? {}
                    : { attentionDismissedAt: dismissedAt }),
                }
              : tab,
          )
        : wc.tabs;
      const updated = needsTabClear ? { ...wc, tabs } : wc;

      const stillNeedsAttention = tabsStillNeedAttention(updated.tabs);
      const nextUnread =
        !stillNeedsAttention && state.unreadWorktreeKeys.has(key)
          ? new Set(
              Array.from(state.unreadWorktreeKeys).filter(
                (entry) => entry !== key,
              ),
            )
          : state.unreadWorktreeKeys;

      if (!needsTabClear && nextUnread === state.unreadWorktreeKeys) {
        return state;
      }

      return {
        ...(needsTabClear
          ? { worktreeChats: { ...state.worktreeChats, [key]: updated } }
          : {}),
        unreadWorktreeKeys: nextUnread,
      };
    });
    if (acknowledgedChatId) {
      clearRecordedUnreadChatAgentResponsePreview(
        selected.projectId,
        selected.worktreeId,
        acknowledgedChatId,
      );
    }
    if (
      acknowledgedChatId &&
      isScopeRevisionedLive(get(), selected.projectId, selected.worktreeId)
    ) {
      void Promise.all([
        get().dispatchChatCommand(selected, {
          type: 'chat.mark_read',
          chatId: acknowledgedChatId,
        }),
        ...(preservesLandedAttention(key, acknowledgedChatId)
          ? []
          : [
              get().dispatchChatCommand(selected, {
                type: 'chat.dismiss_attention',
                chatId: acknowledgedChatId,
              }),
            ]),
      ]);
    }
  },

  dismissOverviewChatCard: (projectId, worktreeId, tabId): void => {
    const key = `${projectId}/${worktreeId}`;
    clearRecordedUnreadChatAgentResponsePreview(projectId, worktreeId, tabId);
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      const tab = wc.tabs.find((t) => t.id === tabId);
      if (!tab) return state;
      const now = Date.now();
      const tabs = wc.tabs.map((t) =>
        t.id === tabId ? { ...t, unread: false, attentionDismissedAt: now } : t,
      );
      const updated = { ...wc, tabs };
      const worktreeStillNeedsAttention = tabsStillNeedAttention(updated.tabs);
      let nextUnread = state.unreadWorktreeKeys;
      if (!worktreeStillNeedsAttention && nextUnread.has(key)) {
        nextUnread = new Set(Array.from(nextUnread).filter((k) => k !== key));
      }

      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
        unreadWorktreeKeys: nextUnread,
      };
    });
    if (isScopeRevisionedLive(get(), projectId, worktreeId)) {
      void Promise.all([
        get().dispatchChatCommand(
          { projectId, worktreeId },
          { type: 'chat.mark_read', chatId: tabId },
        ),
        get().dispatchChatCommand(
          { projectId, worktreeId },
          { type: 'chat.dismiss_attention', chatId: tabId },
        ),
      ]);
    }
    scheduleIdleChatUnload();
  },

  markTargetRead: (projectId, worktreeId, options): void => {
    const key = `${projectId}/${worktreeId}`;
    const allTabs = options?.allTabs === true;
    const specificTabId = options?.tabId;
    if (!allTabs && !specificTabId) return;
    const existing = get().worktreeChats[key];
    const acknowledgedChatIds = (existing?.tabs ?? [])
      .filter((tab) => allTabs || tab.id === specificTabId)
      .filter(
        (tab) => tab.unread === true || tab.attentionDismissedAt === undefined,
      )
      .map((tab) => tab.id);
    if (allTabs) {
      for (const tab of existing?.tabs ?? []) {
        clearRecordedUnreadChatAgentResponsePreview(
          projectId,
          worktreeId,
          tab.id,
        );
      }
    } else if (specificTabId) {
      clearRecordedUnreadChatAgentResponsePreview(
        projectId,
        worktreeId,
        specificTabId,
      );
    }
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;

      const now = Date.now();
      let tabsChanged = false;
      const tabs = wc.tabs.map((t) => {
        const shouldClear = allTabs || t.id === specificTabId;
        if (!shouldClear) return t;
        const alreadyCleared =
          t.unread !== true && t.attentionDismissedAt !== undefined;
        if (alreadyCleared) return t;
        tabsChanged = true;
        return {
          ...t,
          unread: false,
          unreadMarkedManually: undefined,
          attentionDismissedAt: now,
        };
      });

      const stillNeedsAttention = tabsStillNeedAttention(tabs);
      let nextUnread = state.unreadWorktreeKeys;
      if (!stillNeedsAttention && nextUnread.has(key)) {
        nextUnread = new Set(Array.from(nextUnread).filter((k) => k !== key));
      }

      if (!tabsChanged && nextUnread === state.unreadWorktreeKeys) {
        return state;
      }

      const updated = tabsChanged ? { ...wc, tabs } : wc;
      return {
        ...(tabsChanged
          ? { worktreeChats: { ...state.worktreeChats, [key]: updated } }
          : {}),
        ...(nextUnread !== state.unreadWorktreeKeys
          ? { unreadWorktreeKeys: nextUnread }
          : {}),
      };
    });
    if (
      acknowledgedChatIds.length > 0 &&
      isScopeRevisionedLive(get(), projectId, worktreeId)
    ) {
      const scope = { projectId, worktreeId };
      void Promise.all(
        acknowledgedChatIds.flatMap((chatId) => [
          get().dispatchChatCommand(scope, {
            type: 'chat.mark_read',
            chatId,
          }),
          get().dispatchChatCommand(scope, {
            type: 'chat.dismiss_attention',
            chatId,
          }),
        ]),
      );
    }
  },

  setChatUnread: (projectId, worktreeId, chatId, unread): void => {
    const key = worktreeKey({ projectId, worktreeId });
    const tab = get().worktreeChats[key]?.tabs.find((t) => t.id === chatId);
    if (!tab || (tab.unread === true) === unread) return;
    if (!unread) {
      // A mark queued during a refresh must not re-unread the chat later.
      dropPendingUnread(projectId, worktreeId, chatId);
      get().markTargetRead(projectId, worktreeId, { tabId: chatId });
      return;
    }
    // The viewed chat stays unread: no read path runs on this action, so
    // only a later re-acknowledgement (leaving and returning) clears it.
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      const tabs = wc.tabs.map((t) =>
        t.id === chatId
          ? {
              ...t,
              unread: true,
              unreadMarkedManually: true,
              // The user's mark, not a question, now owns the unread, so
              // answering an earlier question must not clear it.
              unreadRaisedByQuestion: undefined,
              attentionDismissedAt: undefined,
            }
          : t,
      );
      return {
        worktreeChats: { ...state.worktreeChats, [key]: { ...wc, tabs } },
        ...(state.unreadWorktreeKeys.has(key)
          ? {}
          : {
              unreadWorktreeKeys: new Set(state.unreadWorktreeKeys).add(key),
            }),
      };
    });
    if (isScopeRevisionedLive(get(), projectId, worktreeId)) {
      void persistUnreadWhenScopeLive(projectId, worktreeId, chatId, {
        manual: true,
      });
    }
  },
});
