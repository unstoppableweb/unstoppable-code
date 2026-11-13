// Chat tab discovery requests (commands/skills) and the coalesced
// worktree discovery refresh queue.
import {
  type AgentProviderType,
  type ChatTabPluginSelections,
  type WorktreeDiscoveryRequest,
} from '@canopy/desktop-shared/types';
import { isWebCoreScope } from '@/lib/chat-authority';
import { resolveAgentChatPluginSelections } from '@/lib/chatPluginSelections';
import { CODEX_DISCOVERY_REFRESH_TTL_MS } from './constants';
import type { ChatTab, WorktreeChatState } from './types';
import { splitWorktreeKey } from './utils';
import {
  loadPluginProviderSupportIndex,
  sanitizePluginSelectionsForProvider,
} from './plugin-provider-support';
import { chatStoreApi } from './store-ref';

import { resolveDiscoveryProviderType } from '@canopy/desktop-shared/lib/slash-invocable-inventory';

export { resolveDiscoveryProviderType };

export function requestTabDiscovery(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  pluginSelections?: ChatTabPluginSelections;
  defaultPluginSelections?: ChatTabPluginSelections;
  providerType?: AgentProviderType;
  selectedRepoId?: string;
}): void {
  // Discovery reads the local runtime's environment. A web core chat's
  // skills come from its catalog instead (CAN-6175 R5).
  if (isWebCoreScope(options.projectId)) return;
  const worktreeChat =
    chatStoreApi().getState().worktreeChats[
      `${options.projectId}/${options.worktreeId}`
    ];
  const currentTab = worktreeChat?.tabs.find(
    (tab) => tab.id === options.chatId,
  );
  if (currentTab?.kind === 'file') {
    return;
  }
  const selectedRepoId = options.selectedRepoId ?? currentTab?.selectedRepoId;
  const pluginSelections = currentTab
    ? resolveDiscoveryPluginSelections({
        tab: currentTab,
        pluginSelections: options.pluginSelections,
        defaultPluginSelections: options.defaultPluginSelections,
      })
    : options.pluginSelections;
  const request: WorktreeDiscoveryRequest = {
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.chatId,
    pluginSelections,
    providerType:
      options.providerType ?? resolveDiscoveryProviderType(currentTab),
  };
  if (selectedRepoId !== undefined) {
    request.selectedRepoId = selectedRepoId;
  }
  void window.api.discoverWorktreeEnv(request);
}

const queuedWorktreeDiscoveryRefreshes = new Set<string>();

let queuedWorktreeDiscoveryRefreshTimer: ReturnType<typeof setTimeout> | null =
  null;

export function enqueueWorktreeTabDiscoveryRefresh(
  projectId: string,
  worktreeId: string,
): void {
  queuedWorktreeDiscoveryRefreshes.add(`${projectId}/${worktreeId}`);
  if (queuedWorktreeDiscoveryRefreshTimer !== null) {
    return;
  }

  // Collapse duplicate setup-phase refresh requests that land in the same tick.
  queuedWorktreeDiscoveryRefreshTimer = setTimeout((): void => {
    queuedWorktreeDiscoveryRefreshTimer = null;
    const queuedKeys = Array.from(queuedWorktreeDiscoveryRefreshes);
    queuedWorktreeDiscoveryRefreshes.clear();
    const chatState = chatStoreApi().getState();
    for (const key of queuedKeys) {
      const parts = splitWorktreeKey(key);
      chatState.refreshWorktreeTabDiscoveries(
        parts.projectId,
        parts.worktreeId,
      );
    }
  }, 0);
}

export function requestDiscoveryForChatTab(options: {
  projectId: string;
  worktreeId: string;
  tab: ChatTab;
  defaultPluginSelections?: ChatTabPluginSelections;
}): void {
  if (options.tab.kind === 'file') {
    return;
  }

  requestTabDiscovery({
    projectId: options.projectId,
    worktreeId: options.worktreeId,
    chatId: options.tab.id,
    defaultPluginSelections: options.defaultPluginSelections,
    providerType: resolveDiscoveryProviderType(options.tab),
    selectedRepoId: options.tab.selectedRepoId,
  });
}

/**
 * Resolve the plugin selections to hand to worktree discovery for a chat tab.
 *
 * When the tab's selected model is a custom Agent model, its auto-enabled
 * plugin selections are merged IN ADDITION to the tab's own (or the workspace
 * default) selections — Agent plugins are additive, exactly as the model
 * pickers communicate. This mirrors the main-process session-resolution merge
 * so Agent-provided plugins are discoverable before the first message is sent.
 * When no Agent is selected the behavior is unchanged.
 */
export function resolveDiscoveryPluginSelections(options: {
  tab: ChatTab;
  pluginSelections?: ChatTabPluginSelections;
  defaultPluginSelections?: ChatTabPluginSelections;
}): ChatTabPluginSelections | undefined {
  const base =
    options.pluginSelections ??
    options.tab.pluginSelections ??
    options.defaultPluginSelections;
  return resolveAgentChatPluginSelections(options.tab.model, base);
}

export function scheduleEmptyTabPluginSelectionSanitization(options: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  providerType?: AgentProviderType;
}): void {
  const key = `${options.projectId}/${options.worktreeId}`;
  const initialTab = chatStoreApi()
    .getState()
    .worktreeChats[key]?.tabs.find((tab) => tab.id === options.chatId);
  if (
    !initialTab ||
    initialTab.kind === 'file' ||
    initialTab.messages.length > 0 ||
    !initialTab.pluginSelections ||
    initialTab.pluginSelections.pluginRefs.length === 0
  ) {
    return;
  }

  void loadPluginProviderSupportIndex().then((supportIndex) => {
    if (!supportIndex) return;

    const currentTab = chatStoreApi()
      .getState()
      .worktreeChats[key]?.tabs.find((tab) => tab.id === options.chatId);
    if (
      !currentTab ||
      currentTab.kind === 'file' ||
      currentTab.messages.length > 0
    ) {
      return;
    }

    const providerType =
      options.providerType ?? resolveDiscoveryProviderType(currentTab);
    const sanitizedSelections = sanitizePluginSelectionsForProvider(
      currentTab.pluginSelections,
      providerType,
      supportIndex,
    );
    if (sanitizedSelections === currentTab.pluginSelections) {
      return;
    }

    chatStoreApi().setState((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;

      const tabToUpdate = currentWc.tabs.find(
        (tab) => tab.id === options.chatId,
      );
      if (
        !tabToUpdate ||
        tabToUpdate.kind === 'file' ||
        tabToUpdate.messages.length > 0
      ) {
        return state;
      }

      const nextProviderType =
        options.providerType ?? resolveDiscoveryProviderType(tabToUpdate);
      const nextSelections = sanitizePluginSelectionsForProvider(
        tabToUpdate.pluginSelections,
        nextProviderType,
        supportIndex,
      );
      if (nextSelections === tabToUpdate.pluginSelections) {
        return state;
      }

      const updated: WorktreeChatState = {
        ...currentWc,
        tabs: currentWc.tabs.map((tab) =>
          tab.id === options.chatId
            ? { ...tab, pluginSelections: nextSelections }
            : tab,
        ),
      };
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: updated,
        },
      };
    });

    const updatedTab = chatStoreApi()
      .getState()
      .worktreeChats[key]?.tabs.find((tab) => tab.id === options.chatId);
    if (!updatedTab || updatedTab.kind === 'file') return;
    requestTabDiscovery({
      projectId: options.projectId,
      worktreeId: options.worktreeId,
      chatId: options.chatId,
      pluginSelections: updatedTab.pluginSelections,
      providerType: resolveDiscoveryProviderType(updatedTab),
      selectedRepoId: updatedTab.selectedRepoId,
    });
  });
}

/** When a Mod's admission last changed; 0 until one changes in this window. */
let claudeModAdmissionChangedAtMs = 0;

/**
 * Discovery decides Mod admission like a launch does, so a Claude tab's
 * commands from before an admission change are stale.
 */
export function noteClaudeModAdmissionChange(nowMs = Date.now()): void {
  claudeModAdmissionChangedAtMs = nowMs;
}

export function shouldRefreshVisibleTabDiscovery(
  tab?: Pick<ChatTab, 'providerType' | 'model' | 'discovery'>,
  nowMs = Date.now(),
): boolean {
  if (!tab) {
    return false;
  }

  if (!tab.discovery) {
    return true;
  }

  const providerType = resolveDiscoveryProviderType(tab);
  if (providerType !== 'codex') {
    return (
      Date.parse(tab.discovery.discoveredAt) < claudeModAdmissionChangedAtMs
    );
  }

  if (tab.discovery.providerType !== 'codex') {
    return true;
  }

  const discoveredAtMs = Date.parse(tab.discovery.discoveredAt);
  if (Number.isNaN(discoveredAtMs) || nowMs < discoveredAtMs) {
    return true;
  }

  return nowMs - discoveredAtMs >= CODEX_DISCOVERY_REFRESH_TTL_MS;
}

export function shouldRequestVisibleTabDiscovery(options: {
  chatId: string;
  tab?: Pick<ChatTab, 'providerType' | 'model' | 'discovery' | 'kind'>;
  tabDiscoveryLoading: ReadonlySet<string>;
  nowMs?: number;
}): boolean {
  // File tabs do not participate in command discovery; bail out immediately so
  // every call site gates on `kind` automatically. Pair this with explicit
  // early-returns in code paths that don't go through this helper (e.g.
  // `syncActiveEmptyTabToDefaults`).
  if (options.tab?.kind === 'file') {
    return false;
  }

  if (options.tabDiscoveryLoading.has(options.chatId)) {
    return false;
  }

  return shouldRefreshVisibleTabDiscovery(options.tab, options.nowMs);
}
