import { noteChatCreatedInSession } from './created-in-session';
// Tab creation/fork lifecycle helpers that need chat-store state types.
import {
  APP_ADVISOR_PROJECT_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  getProviderForModel,
  isInheritingAgentModel,
  pinInheritingAgentModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type ChatTabPluginSelections,
  type WorktreeSelection,
} from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from '@/lib/cowork';
import { newChatPluginDefaultsStamp } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  DEFAULT_CODEX_SPEED,
  mergeAgentModelConfig,
  readCodexSpeedRecord,
} from '@canopy/execution-engine/lib/codex-speed';
import { codexSpeedFields, withoutCodexSpeed } from './codex-speed';
import type { ClaudeTerminalClientState } from '@/stores/claudeTerminalStore';
import { useProjectsStore } from '../projectsStore';
import type { ChatState } from './state';
import type { ChatTab, CreateTabTarget, WorktreeChatState } from './types';
import { worktreeKey } from './utils';
import {
  isAppAdvisorChatTarget,
  withRequiredPluginSelectionsForTarget,
} from './surface';
import {
  chatTabHasConversationContent,
  createEmptyTab,
  emptyWorktreeChat,
  getDefaultPlugins,
  isPristineChatTab,
  resolveTabProviderType,
} from './tab-utils';
import { sanitizePluginSelectionsWithCachedSupport } from './plugin-provider-support';
import {
  requestTabDiscovery,
  resolveDiscoveryProviderType,
  scheduleEmptyTabPluginSelectionSanitization,
} from './discovery';
import {
  resolveBillingSeed,
  resolveDefaultChatInterfaceMode,
  resolveDeferredToolsAllowedDefault,
  resolveTabDefaults,
} from './defaults';
import { hydratedKeys, recordWorktreeChatTouch } from './hydration';
import { chatStoreApi } from './store-ref';
import {
  beginOptimisticActiveTabSelection,
  confirmOptimisticActiveTabSelection,
  isScopeRevisionedLive,
  rollbackOptimisticActiveTabSelection,
} from './slices/revisioned';
import { applyResolvedApprovalModeForNewTab } from './approval-defaults';
import {
  pendingTabCreationDetails,
  registerPendingTabCreation,
} from './pending-tab-creation';
import type { ChatCommandDisposition } from './revisioned-commands';
import { chatBackendFor } from './backend';
import { isWebCoreScope } from '@/lib/chat-authority';
import { isCloudTaskDeleted } from './web-core/task-deletions';

export function shouldEmitNewChatStartedWatcher(
  tab: ChatTab | undefined,
): boolean {
  if (!tab || tab.kind === 'file') return false;
  if (tab.newChatStartedWatcherFiredAt) return false;
  return tab.newChatStartedWatcherPending === true || tab.messages.length === 0;
}

export function scheduleTaskBranchNamingFromInitialInput(
  projectId: string,
  worktreeId: string,
  chatId: string,
  text: string,
  selectedRepoId?: string,
): void {
  if (
    isCoworkChatTarget(projectId) ||
    projectId === APP_ADVISOR_PROJECT_ID ||
    projectId === PLAN_EXPLORE_CHAT_PROJECT_ID ||
    text.trim().length === 0
  ) {
    return;
  }

  useProjectsStore
    .getState()
    .enqueuePendingTaskBranchNaming(projectId, worktreeId, text, {
      chatId,
      ...(selectedRepoId ? { selectedRepoId } : {}),
    });
}

export function resolveNativeSendSdkSessionId(
  tab: ChatTab | undefined,
  terminalSnapshot: ClaudeTerminalClientState | undefined,
): string | undefined {
  const tabSessionId = tab?.sdkSessionId;
  const providerType = resolveTabProviderType(tab);
  if (providerType !== 'claude') {
    return tabSessionId;
  }
  const terminalSessionId =
    terminalSnapshot?.sdkSessionId ?? tab?.claudeTerminal?.sdkSessionId;
  if (!chatTabHasConversationContent(tab) && terminalSessionId) {
    return undefined;
  }
  return tabSessionId ?? terminalSessionId;
}

export function shouldStartFreshNativeAppAdvisorSessionAfterTerminal(
  sel: WorktreeSelection,
  tab: ChatTab | undefined,
  terminalSnapshot: ClaudeTerminalClientState | undefined,
): boolean {
  if (
    !isAppAdvisorChatTarget(sel.projectId, sel.worktreeId) ||
    resolveTabProviderType(tab) !== 'claude'
  ) {
    return false;
  }
  return Boolean(terminalSnapshot?.sdkSessionId ?? tab?.claudeTerminal);
}

/**
 * Last-resort hydration fallback: when `loadTabs`/`loadAllWorktreeTabs` fails
 * before populating `worktreeChats[key]`, the selected worktree would render a
 * chat panel with no visible tab (and "add chat" would surface two tabs). This
 * populates a default tab built from cached defaults so the panel is always
 * usable, but intentionally:
 * - does NOT mark the key hydrated, so the next `loadTabs` retries and merges
 *   real persisted tabs, and
 * - does NOT schedule persistence, so a transient read failure can never
 *   overwrite the on-disk tabs file with just the fallback tab.
 */
export async function applyFallbackWorktreeChatState(
  projectId: string,
  worktreeId: string,
): Promise<void> {
  const key = `${projectId}/${worktreeId}`;
  const state = chatStoreApi().getState();
  if (state.worktreeChats[key]) {
    recordWorktreeChatTouch(key);
    return;
  }

  // The fallback must be unconditionally safe: defaults resolution reads
  // loaded preference state that may itself be the reason hydration failed,
  // so degrade to a bare default tab rather than let the fallback throw.
  let fallbackState: WorktreeChatState;
  try {
    const modelDefaults = state.modelDefaults;
    const { model, providerType, thinkingLevel, modelConfig } =
      resolveTabDefaults(projectId, modelDefaults);
    const rawDefaultPluginSelections = getDefaultPlugins(
      projectId,
      worktreeId,
      state.worktreeDefaultPlugins,
    );
    const resolvedProviderType = model
      ? (getProviderForModel(model) ?? providerType)
      : providerType;
    fallbackState = emptyWorktreeChat({
      pluginSelections: sanitizePluginSelectionsWithCachedSupport(
        rawDefaultPluginSelections,
        resolvedProviderType,
      ),
      model,
      thinkingLevel,
      defaultChatInterfaceMode: resolveDefaultChatInterfaceMode(
        projectId,
        modelDefaults,
      ),
      modelConfig,
      deferredToolsAllowed: resolveDeferredToolsAllowedDefault(
        projectId,
        worktreeId,
        state.deferredToolsDefaults,
      ),
      billingSeed: resolveBillingSeed(modelDefaults, projectId),
      ...newChatPluginDefaultsStamp(projectId),
    });
  } catch {
    fallbackState = emptyWorktreeChat(newChatPluginDefaultsStamp(projectId));
  }

  const fallbackTabId = fallbackState.tabs[0]?.id;
  let installedFallback = false;
  chatStoreApi().setState((current) => {
    if (current.worktreeChats[key]) {
      return {};
    }
    installedFallback = true;
    return {
      worktreeChats: {
        ...current.worktreeChats,
        [key]: fallbackState,
      },
    };
  });

  if (installedFallback && fallbackTabId) {
    await applyResolvedApprovalModeForNewTab(
      { projectId, worktreeId },
      fallbackTabId,
      chatStoreApi().setState,
      chatStoreApi().getState,
    );
  }
  recordWorktreeChatTouch(key);
}

/**
 * Shared body of `createTab` / `createTabWithId`: build the tab with the
 * worktree's default plugins and model, install it into that worktree's tabs,
 * schedule persistence, and trigger initial command discovery. The two store
 * actions only differ by whether the caller pins a specific tab id. Explicit
 * initiating flows may replace the active pristine fallback tab instead of
 * appending a sibling.
 */
export function appendNewTab(
  sel: CreateTabTarget,
  set: (
    partial:
      | ChatState
      | Partial<ChatState>
      | ((state: ChatState) => ChatState | Partial<ChatState>),
  ) => void,
  get: () => ChatState,
  id?: string,
): void {
  // A cloud task deleted on another device takes no new chat (CAN-6614).
  if (isCloudTaskDeleted(sel)) return;
  const key = worktreeKey(sel);
  const pluginDefaults = getDefaultPlugins(
    sel.projectId,
    sel.worktreeId,
    get().worktreeDefaultPlugins,
  );
  // A cloud chat starts on the web core's own default model until one is
  // picked; this computer's defaults never stand in for it (CAN-6365).
  const resolvedDefaults =
    (sel.model && sel.thinkingLevel) || isWebCoreScope(sel.projectId)
      ? {}
      : resolveTabDefaults(sel.projectId, get().modelDefaults);
  const defaultModel = resolvedDefaults.model;
  const defaultProviderType = resolvedDefaults.providerType;
  const defaultThinking = resolvedDefaults.thinkingLevel;
  const defaultModelConfig = resolvedDefaults.modelConfig;
  // An Agent that inherits the default starts pinned to this chat's default.
  const requestedModel =
    sel.model !== undefined && isInheritingAgentModel(sel.model)
      ? pinInheritingAgentModel(
          sel.model,
          defaultModel ??
            resolveTabDefaults(sel.projectId, get().modelDefaults).model,
        )
      : sel.model;
  const model = requestedModel ?? defaultModel;
  // The caller's selection is an explicit choice over the resolved defaults:
  // its exact speed wins, its legacy boolean (or the deprecated alias)
  // replaces the default speed, and a thinking-only selection keeps it.
  const selectedSpeed = readCodexSpeedRecord(
    sel.modelConfig,
    sel.codexFastModeEnabled,
  );
  const selectionModelConfig = mergeAgentModelConfig(defaultModelConfig, {
    ...withoutCodexSpeed(sel.modelConfig),
    ...(selectedSpeed === undefined ? {} : { speed: selectedSpeed }),
  });
  const thinkingLevel =
    sel.thinkingLevel ?? selectionModelConfig.thinkingLevel ?? defaultThinking;
  const provider = model
    ? (getProviderForModel(model) ??
      (sel.model === undefined ? defaultProviderType : undefined))
    : defaultProviderType;
  const modelConfig = provider
    ? resolveProviderModelConfig(
        provider,
        { thinkingLevel, modelConfig: selectionModelConfig },
        get().modelDefaults?.modelConfigDefaultsByProvider,
      )
    : {
        thinkingLevel:
          selectionModelConfig.thinkingLevel ?? thinkingLevel ?? 'high',
        ...codexSpeedFields(DEFAULT_CODEX_SPEED),
      };
  const pluginSelections = withRequiredPluginSelectionsForTarget(
    sel.projectId,
    sel.worktreeId,
    sel.pluginSelections ?? pluginDefaults,
  );
  const defaultChatInterfaceMode = resolveDefaultChatInterfaceMode(
    sel.projectId,
    get().modelDefaults,
  );
  const requestedInterfaceMode = sel.interfaceMode ?? defaultChatInterfaceMode;
  const baseTab = createEmptyTab({
    pluginSelections,
    model,
    thinkingLevel,
    defaultChatInterfaceMode: requestedInterfaceMode,
    modelConfig,
    // Inherited workspace defaults keep their computed provider fallback even
    // when the model is missing from the registry; `provider` is already
    // undefined for explicit stale selections, which stay providerless.
    providerTypeHint: provider,
    fastModeExplicit: selectedSpeed !== undefined,
    deferredToolsAllowed:
      sel.deferredToolsAllowed ??
      resolveDeferredToolsAllowedDefault(
        sel.projectId,
        sel.worktreeId,
        get().deferredToolsDefaults,
      ),
    billingSeed: resolveBillingSeed(get().modelDefaults, sel.projectId),
    modelExplicitlyChosen: sel.modelExplicitlyChosen === true,
    // A SEED path: whatever model this tab is born with is ours to re-stamp
    // later, unless the caller marked it an explicit pick above.
    defaultStampModel: model,
    ...newChatPluginDefaultsStamp(sel.projectId),
  });
  const resolvedId = id ?? sel.id;
  const tab: ChatTab = {
    ...baseTab,
    ...(sel.planMode !== undefined ? { planMode: sel.planMode } : {}),
    ...(resolvedId ? { id: resolvedId } : {}),
    ...(sel.title ? { title: sel.title } : {}),
    ...(sel.selectedRepoId && sel.selectedRepoId !== WORKSPACE_ROOT_REPO_ID
      ? { selectedRepoId: sel.selectedRepoId }
      : {}),
  };
  // Creation is a newer selection too. Older activation broadcasts must not
  // pull focus away while approval defaults and canonical creation settle.
  const activationToken = isScopeRevisionedLive(
    get(),
    sel.projectId,
    sel.worktreeId,
  )
    ? beginOptimisticActiveTabSelection(sel.projectId, sel.worktreeId, tab.id)
    : undefined;
  let replacedEmptyTabId: string | undefined;
  noteChatCreatedInSession(tab.id);
  set((state) => {
    // When the worktree has no store entry yet (hydration failed, is still in
    // flight, or was never triggered), the user's click means "give me one new
    // tab" — create exactly that tab instead of synthesizing an implicit
    // default tab alongside it, which used to surface as two tabs appearing
    // from an empty panel. If an in-flight hydration later completes,
    // mergeHydratedWorktreeChatState treats this tab as the worktree's local
    // chat tab and merges persisted tabs around it.
    const wc = state.worktreeChats[key];
    const activeTab = wc?.tabs.find(
      (candidate) => candidate.id === wc.activeTabId,
    );
    const replaceActiveEmpty =
      sel.replaceActiveEmpty === true && isPristineChatTab(activeTab, state);
    replacedEmptyTabId = replaceActiveEmpty ? activeTab.id : undefined;
    const updated = {
      ...wc,
      tabs: replaceActiveEmpty
        ? (wc?.tabs.map((candidate) =>
            candidate.id === activeTab.id ? tab : candidate,
          ) ?? [tab])
        : [...(wc?.tabs ?? []), tab],
      activeTabId: tab.id,
      lastActiveEditableChatId: tab.id,
      ...(resolveTabProviderType(tab)
        ? { lastActiveChatProvider: resolveTabProviderType(tab) }
        : {}),
    };
    return {
      worktreeChats: { ...state.worktreeChats, [key]: updated },
    };
  });
  const approvalModePromise = applyResolvedApprovalModeForNewTab(
    sel,
    tab.id,
    set,
    get,
  );
  const replacedTabCreation = replacedEmptyTabId
    ? pendingTabCreationDetails(
        sel.projectId,
        sel.worktreeId,
        replacedEmptyTabId,
      )
    : undefined;

  // Durable tab identity is main-owned: commit the draft (and the discarded
  // empty starter it replaced) through the canonical command port so a later
  // activation, reload, or restart sees the tab main-side instead of hitting
  // `not_found` and refreshing the draft away.
  if (isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)) {
    const scope = { projectId: sel.projectId, worktreeId: sel.worktreeId };
    let creationRevision: number | undefined;
    const creation = (async (): Promise<ChatCommandDisposition> => {
      const approvalMode = await approvalModePromise;
      const latestTab = get().worktreeChats[key]?.tabs.find(
        (candidate) => candidate.id === tab.id,
      );
      if (!latestTab || latestTab.kind === 'file') {
        return 'transport_failed' as const;
      }
      const providerType = resolveTabProviderType(latestTab);
      const createCommand = {
        type: 'chat.create_tab',
        tabId: latestTab.id,
        title: latestTab.title,
        ...(providerType ? { providerType } : {}),
        ...(latestTab.model ? { model: latestTab.model } : {}),
        ...(sel.projectId === APP_ADVISOR_PROJECT_ID &&
        latestTab.defaultStampModel
          ? { defaultStampModel: latestTab.defaultStampModel }
          : {}),
        ...(latestTab.modelConfig
          ? { modelConfig: latestTab.modelConfig }
          : {}),
        ...(latestTab.planMode ? { planMode: true } : {}),
        ...(latestTab.proposalMode
          ? { proposalMode: latestTab.proposalMode }
          : {}),
        ...(latestTab.pluginSelections
          ? { pluginSelections: latestTab.pluginSelections }
          : {}),
        ...(typeof latestTab.deferredToolsAllowed === 'boolean'
          ? { deferredToolsAllowed: latestTab.deferredToolsAllowed }
          : {}),
        ...(latestTab.interfaceMode
          ? { interfaceMode: latestTab.interfaceMode }
          : {}),
        ...(latestTab.selectedRepoId
          ? { selectedRepoId: latestTab.selectedRepoId }
          : {}),
        ...((latestTab.approvalMode ?? approvalMode)
          ? { approvalMode: latestTab.approvalMode ?? approvalMode }
          : {}),
        ...(latestTab.aiCreditsRouting
          ? { aiCreditsRouting: latestTab.aiCreditsRouting }
          : {}),
        ...(typeof latestTab.subscriptionBillingOverride === 'boolean'
          ? {
              subscriptionBillingOverride:
                latestTab.subscriptionBillingOverride,
            }
          : {}),
      } as const;
      let expectedRevision: number | undefined;
      if (replacedEmptyTabId !== undefined) {
        const replacedCreationDisposition = await replacedTabCreation?.promise;
        if (
          replacedCreationDisposition === undefined ||
          replacedCreationDisposition === 'accepted'
        ) {
          const closeExpectedRevision =
            replacedTabCreation?.getRevision() ??
            get().chatStateSync[key]?.revision;
          const closeDisposition = await get().dispatchChatCommand(
            scope,
            {
              type: 'chat.close_tab',
              tabId: replacedEmptyTabId,
              mode: 'discard_empty',
            },
            {
              ...(closeExpectedRevision !== null &&
              closeExpectedRevision !== undefined
                ? { expectedRevision: closeExpectedRevision }
                : {}),
              acceptNotFound: true,
              onResult: (result): void => {
                expectedRevision = result.revision;
              },
            },
          );
          if (closeDisposition !== 'accepted') {
            return closeDisposition;
          }
        }
      }
      return get().dispatchChatCommand(scope, createCommand, {
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        onResult: (result): void => {
          creationRevision = result.revision;
        },
        ...(activationToken === undefined
          ? {}
          : {
              reconcile: (result): void =>
                confirmOptimisticActiveTabSelection(
                  sel.projectId,
                  sel.worktreeId,
                  activationToken,
                  result.revision,
                ),
              rollback: (): void =>
                rollbackOptimisticActiveTabSelection(
                  sel.projectId,
                  sel.worktreeId,
                  activationToken,
                ),
            }),
      });
    })();
    if (activationToken !== undefined) {
      void creation.then((disposition) => {
        if (disposition !== 'accepted')
          rollbackOptimisticActiveTabSelection(
            sel.projectId,
            sel.worktreeId,
            activationToken,
          );
      });
    }
    registerPendingTabCreation(
      sel.projectId,
      sel.worktreeId,
      tab.id,
      creation,
      () => creationRevision,
    );
  } else {
    // The default still needs to stamp the local draft while hydration is in
    // flight or revisioned state is unavailable. Consume failures so this
    // fire-and-forget path cannot surface an unhandled rejection.
    void approvalModePromise.catch(() => undefined);
  }

  if (!hydratedKeys.has(key)) {
    void get().loadTabsForTarget(sel.projectId, sel.worktreeId);
  }

  // Refresh command discovery so default plugins/skills are picked up.
  scheduleEmptyTabPluginSelectionSanitization({
    projectId: sel.projectId,
    worktreeId: sel.worktreeId,
    chatId: tab.id,
    providerType: resolveDiscoveryProviderType(tab),
  });
  requestTabDiscovery({
    projectId: sel.projectId,
    worktreeId: sel.worktreeId,
    chatId: tab.id,
    pluginSelections: tab.pluginSelections,
    providerType: resolveDiscoveryProviderType(tab),
  });
}

export interface ForkCodexThreadRequestArgs {
  projectId: string;
  worktreeId: string;
  clonedTabId: string;
  sourceThreadId: string;
  sourceProjectId?: string;
  sourceWorktreeId?: string;
  sourceChatId?: string;
  selectedRepoId?: string;
  pluginSelections?: ChatTabPluginSelections;
  /** Carries the source's exact Codex speed onto the forked thread. */
  modelConfig?: AgentModelConfig;
  /** @deprecated Use modelConfig.speed. */
  codexFastModeEnabled?: boolean;
}

export interface ForkCodexThreadForClonedTabArgs extends ForkCodexThreadRequestArgs {
  /**
   * Message count on the cloned tab at the time of fork. Used to avoid
   * stomping a newer `sdkSessionId` if the user has already sent a fresh
   * turn before the fork resolves.
   */
  baselineMessageCount: number;
}

export async function requestCodexThreadForClonedTab(
  args: ForkCodexThreadRequestArgs,
  log: string,
): Promise<string | undefined> {
  try {
    const { forkedThreadId } = await chatBackendFor(args).chat.forkCodexThread({
      projectId: args.projectId,
      worktreeId: args.worktreeId,
      chatId: args.clonedTabId,
      ...(args.selectedRepoId ? { selectedRepoId: args.selectedRepoId } : {}),
      sourceThreadId: args.sourceThreadId,
      ...(args.sourceProjectId
        ? { sourceProjectId: args.sourceProjectId }
        : {}),
      ...(args.sourceWorktreeId
        ? { sourceWorktreeId: args.sourceWorktreeId }
        : {}),
      ...(args.sourceChatId ? { sourceChatId: args.sourceChatId } : {}),
      ...(args.pluginSelections
        ? { pluginSelections: args.pluginSelections }
        : {}),
      ...(args.modelConfig ? { modelConfig: args.modelConfig } : {}),
      codexFastModeEnabled: args.codexFastModeEnabled,
    });
    return forkedThreadId;
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.warn(log, error);
    return undefined;
  }
}

/**
 * Background Codex thread/fork for a cloned tab. On success, patches the
 * destination tab with the forked thread id when no fresher session id has
 * landed and the tab is still at its baseline message count. Failures are
 * logged but non-fatal — the cloned tab simply starts a fresh session.
 */
export function forkCodexThreadForClonedTab(
  args: ForkCodexThreadForClonedTabArgs,
  set: (
    partial:
      | ChatState
      | Partial<ChatState>
      | ((state: ChatState) => ChatState | Partial<ChatState>),
  ) => void,
  log = '[chat-adhoc-migrate] Codex thread/fork failed; cloned tab will start a fresh session.',
): void {
  const target = { projectId: args.projectId, worktreeId: args.worktreeId };
  void (async (): Promise<void> => {
    const forkedThreadId = await requestCodexThreadForClonedTab(args, log);
    if (!forkedThreadId) return;
    set((state) => {
      const key = worktreeKey(target);
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;
      const currentTab = currentWc.tabs.find(
        (tab) => tab.id === args.clonedTabId,
      );
      if (!currentTab) return state;
      const shouldBackfill =
        !currentTab.sdkSessionId &&
        currentTab.messages.length === args.baselineMessageCount;
      if (!shouldBackfill) {
        return state;
      }
      const updatedTabs = currentWc.tabs.map((tab) =>
        tab.id === args.clonedTabId
          ? { ...tab, sdkSessionId: forkedThreadId }
          : tab,
      );
      const updated: WorktreeChatState = {
        ...currentWc,
        tabs: updatedTabs,
      };
      return {
        worktreeChats: {
          ...state.worktreeChats,
          [key]: updated,
        },
      };
    });
  })();
}
