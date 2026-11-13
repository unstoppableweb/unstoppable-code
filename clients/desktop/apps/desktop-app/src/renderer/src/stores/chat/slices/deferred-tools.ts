import type { StateCreator } from 'zustand';
import type {
  ChatTabPluginSelections,
  DeferredToolsReloadScopeKey,
} from '@canopy/desktop-shared/types';
import { mergeDeferredToolsReloadAdditions } from '@canopy/desktop-shared/lib/chat-plugin-selections-merge';
import {
  createDeferredToolsReloadController,
  type DeferredToolsReloadController,
  type DeferredToolsReloadStoreSurface,
  type DeferredToolsReloadTabPreparation,
} from '../deferred-tool-reload';
import { createEmptySelections } from '@/lib/pluginSelections';
import { nextMsgId } from '../ids';
import {
  requestTabDiscovery,
  resolveDiscoveryProviderType,
} from '../discovery';
import { closeOpenToolUseBlocks, completeTurnTimer } from '../event-transforms';
import {
  getLatestTurnUserMessageId,
  getOpenTurnUserMessageId,
} from '../turn-events';
import {
  isReadOnlyAppAdvisorMirrorTarget,
  isSentinelWriteAllowed,
} from '../surface';
import type { ChatTab, WorktreeChatState } from '../types';
import type { ChatDeferredToolsSlice, ChatState } from '../state';
import { tagStatusWrite } from '../runtime-divergence';
import { isScopeRevisionedLive } from './revisioned';
import {
  selectChildToolLiveness,
  useLiveBackgroundTaskStore,
} from '../../liveBackgroundTaskStore';
import { chatBackendFor } from '../backend';

function deferredReloadKey(scope: DeferredToolsReloadScopeKey): string {
  return `${scope.projectId}/${scope.worktreeId}`;
}

export const createDeferredToolsSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatDeferredToolsSlice
> = (set, get) => {
  const patchReloadMarker = (
    scope: DeferredToolsReloadScopeKey,
    requestId: string,
    updater: (tab: ChatTab) => ChatTab,
  ): void => {
    const key = deferredReloadKey(scope);
    set((state) => {
      const wc = state.worktreeChats[key];
      if (!wc) return state;
      let changed = false;
      const tabs = wc.tabs.map((tab) => {
        if (
          tab.id !== scope.chatId ||
          tab.deferredToolsReload?.requestId !== requestId
        ) {
          return tab;
        }
        changed = true;
        return updater(tab);
      });
      return changed
        ? { worktreeChats: { ...state.worktreeChats, [key]: { ...wc, tabs } } }
        : state;
    });
  };

  const buildSurface = (): DeferredToolsReloadStoreSurface => ({
    api: {
      cancelDeferredToolsReload: (req) =>
        chatBackendFor(req.scope).chat.cancelDeferredToolsReload(req),
    },
    isRevisionedScope: (scope): boolean =>
      isScopeRevisionedLive(get(), scope.projectId, scope.worktreeId),
    beginReloadOnTab: (event): DeferredToolsReloadTabPreparation | null => {
      const { scope } = event;
      const writeAllowed = isSentinelWriteAllowed(
        scope.projectId,
        scope.worktreeId,
      );
      const readOnlyMirror = isReadOnlyAppAdvisorMirrorTarget(
        scope.projectId,
        scope.worktreeId,
      );
      if (!writeAllowed && !readOnlyMirror) return null;
      const key = deferredReloadKey(scope);
      const wc = get().worktreeChats[key];
      const tab = wc?.tabs.find((candidate) => candidate.id === scope.chatId);
      if (!wc || !tab || tab.kind === 'file') return null;
      if (
        tab.deferredToolsReload &&
        tab.deferredToolsReload.requestId !== event.requestId
      ) {
        return null;
      }

      const baseSelections = tab.pluginSelections ?? createEmptySelections();
      const userMessageId =
        getOpenTurnUserMessageId(tab.messages) ??
        getLatestTurnUserMessageId(tab.messages);
      const preparation = {
        baseSelections,
        sdkSessionId: tab.sdkSessionId,
        providerType: resolveDiscoveryProviderType(tab),
        interfaceMode: tab.interfaceMode,
        userMessageId,
      };
      // Main keeps canonical runtime active across the reload's session gap
      // (it drops the internal interrupt's terminal before persistence), so a
      // revisioned scope already projects `streaming`. Only legacy scopes
      // hold the tab streaming locally.
      const holdStreaming = !isScopeRevisionedLive(
        get(),
        scope.projectId,
        scope.worktreeId,
      );
      if (holdStreaming) tagStatusWrite(scope.chatId, 'deferred-tools-reload');
      set((state) => {
        const current = state.worktreeChats[key];
        if (!current) return state;
        const tabs = current.tabs.map((candidate) =>
          candidate.id === scope.chatId
            ? {
                ...candidate,
                ...(holdStreaming ? { status: 'streaming' as const } : {}),
                deferredToolsReload: {
                  requestId: event.requestId,
                  toolCallId: event.toolCallId,
                  userMessageId,
                  lifecycle: event.lifecycle,
                },
              }
            : candidate,
        );
        return {
          worktreeChats: {
            ...state.worktreeChats,
            [key]: { ...current, tabs },
          },
        };
      });
      if (readOnlyMirror) return null;
      return preparation;
    },
    mergeSelectionsOnTab: (
      scope,
      additions,
    ): ChatTabPluginSelections | null => {
      const key = deferredReloadKey(scope);
      const wc = get().worktreeChats[key];
      const tab = wc?.tabs.find((candidate) => candidate.id === scope.chatId);
      if (!wc || !tab || tab.kind === 'file') return null;
      const merged = mergeDeferredToolsReloadAdditions(
        tab.pluginSelections,
        additions,
        scope,
      );
      set((state) => {
        const current = state.worktreeChats[key];
        if (!current) return state;
        const updated: WorktreeChatState = {
          ...current,
          tabs: current.tabs.map((candidate) =>
            candidate.id === scope.chatId
              ? { ...candidate, pluginSelections: merged }
              : candidate,
          ),
        };
        return { worktreeChats: { ...state.worktreeChats, [key]: updated } };
      });
      return merged;
    },
    applyCommittedSessionId: (scope, sdkSessionId): void => {
      const key = deferredReloadKey(scope);
      set((state) => {
        const current = state.worktreeChats[key];
        if (!current) return state;
        const updated: WorktreeChatState = {
          ...current,
          tabs: current.tabs.map((candidate) =>
            candidate.id === scope.chatId
              ? { ...candidate, sdkSessionId }
              : candidate,
          ),
        };
        return { worktreeChats: { ...state.worktreeChats, [key]: updated } };
      });
    },
    refreshDiscovery: (scope, selections, providerType): void => {
      requestTabDiscovery({
        projectId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
        pluginSelections: selections,
        providerType,
      });
    },
    updateReloadLifecycle: (scope, requestId, lifecycle): void => {
      patchReloadMarker(scope, requestId, (tab) => ({
        ...tab,
        deferredToolsReload: tab.deferredToolsReload
          ? { ...tab.deferredToolsReload, lifecycle }
          : tab.deferredToolsReload,
      }));
    },
    clearReloadOnTab: (scope, requestId): void => {
      patchReloadMarker(scope, requestId, (tab) => {
        const next = { ...tab };
        delete next.deferredToolsReload;
        return next;
      });
    },
    failReloadOnTab: (scope, requestId, message): void => {
      const key = deferredReloadKey(scope);
      const failedAt = Date.now();
      const readOnlyMirror = isReadOnlyAppAdvisorMirrorTarget(
        scope.projectId,
        scope.worktreeId,
      );
      tagStatusWrite(scope.chatId, 'deferred-tools-reload');
      set((state) => {
        const wc = state.worktreeChats[key];
        if (!wc) return state;
        let changed = false;
        const tabs = wc.tabs.map((tab) => {
          if (
            tab.id !== scope.chatId ||
            tab.deferredToolsReload?.requestId !== requestId
          ) {
            return tab;
          }
          changed = true;
          const next: ChatTab = {
            ...tab,
            status: 'idle',
            messages: readOnlyMirror
              ? tab.messages
              : [
                  ...closeOpenToolUseBlocks(
                    completeTurnTimer(tab.messages, failedAt),
                    {
                      liveness: selectChildToolLiveness(
                        useLiveBackgroundTaskStore.getState(),
                        scope.projectId,
                        scope.worktreeId,
                        scope.chatId,
                      ),
                      codexRootThreadId: tab.sdkSessionId,
                    },
                  ),
                  {
                    id: nextMsgId(),
                    role: 'system',
                    blocks: [{ type: 'text', text: message }],
                    timestamp: failedAt,
                  },
                ],
            currentTodos: undefined,
            currentTaskTodos: undefined,
          };
          delete next.deferredToolsReload;
          return next;
        });
        if (!changed) return state;
        const updated: WorktreeChatState = { ...wc, tabs };
        return { worktreeChats: { ...state.worktreeChats, [key]: updated } };
      });
    },
  });

  let controller: DeferredToolsReloadController | null = null;
  const getController = (): DeferredToolsReloadController => {
    controller ??= createDeferredToolsReloadController(buildSurface());
    return controller;
  };

  return {
    deferredToolsDefaults: null,
    handleDeferredToolsReloadEvent: (event): void => {
      getController().handleEvent(event);
    },
    cancelDeferredToolsReload: (scope, request): void => {
      getController().cancel(scope, request);
    },
    applyDeferredToolsDefaults: (preferences): void => {
      set({
        deferredToolsDefaults: {
          deferredToolsWorktreeChatsEnabled:
            preferences.deferredToolsWorktreeChatsEnabled ?? true,
          deferredToolsStandaloneChatsEnabled:
            preferences.deferredToolsStandaloneChatsEnabled ?? true,
          deferredToolsAppAdvisorEnabled:
            preferences.deferredToolsAppAdvisorEnabled ?? true,
          deferredToolsPipelineAssistantEnabled:
            preferences.deferredToolsPipelineAssistantEnabled ?? true,
        },
      });
    },
  };
};
