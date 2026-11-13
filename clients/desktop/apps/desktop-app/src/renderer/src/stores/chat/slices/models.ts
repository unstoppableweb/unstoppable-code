import { resolveChatModelChangeHarness } from '@canopy/desktop-shared/lib/chat-model-selection';
import {
  type AgentProviderType,
  type ChatModelChangeNotice,
  type ChatModel,
  type ChatTabPluginSelections,
  getEffectiveSupportedThinkingLevelsForModel,
  getModelDisplayName,
  getExecutionHarnessForModel,
  getProviderForModel,
  getProviderForChatModel,
  isOllamaModel,
  isSupportedOllamaModelEntry,
  modelConfigForProviderSupportsFastMode,
  type ModelRegistrySnapshot,
  normalizeThinkingForProvider,
  pinInheritingAgentModel,
  resolveProviderModelConfig,
} from '@canopy/desktop-shared/types';
import { clampModelThinkingLevel } from '@canopy/protocol/thinking';
import { advanceThinkingControlLevel } from '@canopy/ui-shared/lib';
import { isModelBlocked } from '@canopy/desktop-shared/lib/model-policy';
import {
  DEFAULT_CODEX_SPEED,
  codexSpeedFastMode,
  codexSpeedFromFastMode,
  isCodexSpeed,
  readCodexSpeedRecord,
  type CodexSpeed,
} from '@canopy/execution-engine/lib/codex-speed';
import { resolveOwnerScopedModelId } from '@canopy/execution-engine/lib/gateway-model-availability';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { getWorktreeChatContext, updateCapturedChatTab } from '../context';
import {
  beginLocalCodexSpeedWrite,
  codexSpeedFields,
  tabRequestedCodexSpeed,
} from '../codex-speed';
import {
  billingSeedFields,
  chatTabHasConversationContent,
  isTabAiCreditsRouted,
  resolveTabProviderType,
} from '../tab-utils';
import { getLockedHarness } from '@/lib/chatProviderLock';
import {
  resolveFallbackModelForDeletedOllama,
  resolvePersistedDefaultChatInterfaceMode,
  resolveProviderDefaults,
  resolveTabDefaults,
} from '../defaults';
import { setRendererLastResolvedLane } from '@/stores/billingLaneRuntime';
import { resolveTabUsageForModel } from '@/lib/chatUsageNormalization';
import { getPersistedClaudeChatInterfaceMode } from '@/lib/claude-tui-chats';
import { isClaudeTerminalEligibleChatTab } from '@/lib/chat-provider';
import { type ChatTab, type WorktreeChatState } from '../types';
import { useClaudeTerminalStore } from '@/stores/claudeTerminalStore';
import { restartClaudeTerminalForSettingsChange } from '../claudeTerminalPrompt';
import {
  requestTabDiscovery,
  resolveDiscoveryProviderType,
} from '../discovery';
import { parseWorktreeChatKey, splitWorktreeKey } from '../utils';
import { nextMsgId } from '../ids';
import type { StateCreator } from 'zustand';
import type {
  ChatState,
  ChatModelsSlice,
  ModelRegistryOwnerScope,
} from '../state';
import { isScopeRevisionedLive, waitForChatScopeLive } from './revisioned';
import {
  loadingKeys,
  waitForWorktreeHydration,
  pendingEagerChatCreation,
} from '../hydration';
import { pendingTabCreation } from '../pending-tab-creation';
import {
  chatBackendFor,
  ignoreUnavailable,
  reportUnlessUnavailable,
} from '../backend';
import { isWebCoreScope } from '@/lib/chat-authority';
import type { ChatCommandDisposition } from '../revisioned-commands';
import {
  useWebCoreModelCatalogStore,
  webCoreModelOption,
  webCoreModelProvider,
  webCoreThinkingLevels,
} from '../web-core/model-catalog';
import { pickWebCoreTabModel, webCoreTabModel } from '../web-core';
import { useWebCoreFastModeStore } from '../web-core/fast-mode';

/** Whether a cloud chat's model runs fast mode, as its catalog lists it. */
function webCoreModelRunsFastMode(
  projectId: string,
  model: string | undefined,
): boolean {
  return (
    webCoreModelOption(useWebCoreModelCatalogStore.getState(), projectId, model)
      ?.supportsFastMode === true
  );
}

/**
 * Synthetic selection-failure state stamped on a tab when a chosen or fallback
 * model resolves no provider. Identified by message prefix so clearing it can
 * never swallow a genuine turn/session error (which carries different text).
 */
const UNRESOLVED_PROVIDER_ERROR_PREFIX = 'Unknown model provider:';

let nextPersistedModelSyncRequestId = 0;
const persistedModelSyncRequests = new Map<string, number>();

const persistedModelSyncKey = (projectId: string, chatId: string): string =>
  `${projectId}/${chatId}`;

function invalidatePersistedModelSync(projectId: string, chatId: string): void {
  persistedModelSyncRequests.delete(persistedModelSyncKey(projectId, chatId));
}

const unresolvedProviderError = (model: ChatModel): string =>
  `${UNRESOLVED_PROVIDER_ERROR_PREFIX} ${model}`;

/**
 * Fields that transition a tab out of the synthetic selection-failure state,
 * or `undefined` when the tab carries no such state (including genuine
 * errors, which must survive model changes untouched).
 */
const clearedUnresolvedProviderError = (
  tab: Pick<ChatTab, 'status' | 'error'>,
): Pick<ChatTab, 'status' | 'error'> | undefined =>
  tab.status === 'error' &&
  tab.error !== null &&
  tab.error.startsWith(UNRESOLVED_PROVIDER_ERROR_PREFIX)
    ? { status: 'idle', error: null }
    : undefined;

interface CloudModelChoice {
  readonly model: ChatModel | undefined;
  readonly providerType: AgentProviderType | undefined;
}

/** Per tab, the cloud model the web core last confirmed while changes overlap. */
const confirmedCloudModels = new Map<string, CloudModelChoice>();
/** Per tab, the cloud model change in flight, which the next one waits for. */
const cloudModelWrites = new Map<string, Promise<void>>();
/**
 * Per tab, the request id of the newest cloud pick the composer showed. Only
 * it sends, shows the model the web core runs and clears the backend's
 * note, also when a later request for the tab returned before picking.
 */
const cloudPickOwners = new Map<string, string>();

export const createModelsSlice: StateCreator<
  ChatState,
  [],
  [],
  ChatModelsSlice
> = (set, get) => ({
  pendingModelChanges: {},
  modelDefaults: null,

  loadModelDefaults: async (): Promise<void> => {
    const prefs = await window.api.loadPreferences();
    get().applyModelDefaults(prefs);
    get().applyDeferredToolsDefaults(prefs);
  },

  applyModelDefaults: (prefs): void => {
    set({
      modelDefaults: {
        chatProvider: prefs.defaultChatProvider,
        chatModelByProvider: prefs.defaultChatModelByProvider,
        worktreeProvider: prefs.defaultWorktreeProvider,
        worktreeModelByProvider: prefs.defaultWorktreeModelByProvider,
        defaultChatInterfaceMode: prefs.defaultChatInterfaceMode,
        defaultStandaloneChatInterfaceMode:
          prefs.defaultStandaloneChatInterfaceMode,
        defaultAppAdvisorInterfaceMode: prefs.defaultAppAdvisorInterfaceMode,
        appAdvisorModel: prefs.appAdvisorModel,
        appAdvisorThinkingLevel: prefs.appAdvisorThinkingLevel,
        codexFastModeDefaultEnabled: prefs.codexFastModeDefaultEnabled,
        modelConfigDefaultsByProvider: prefs.providerModelConfigDefaults,
        billingFramework: prefs.lastChatBillingFramework,
        lastResolvedLaneByScope: prefs.lastResolvedDefaultLaneByScope,
      },
    });
    setRendererLastResolvedLane(prefs.lastResolvedDefaultLane);
  },

  ensureModelDefaultsLoaded: async (): Promise<ChatState['modelDefaults']> => {
    let modelDefaults = get().modelDefaults;
    if (!modelDefaults) {
      try {
        await get().loadModelDefaults();
        modelDefaults = get().modelDefaults;
      } catch {
        // Proceed with null defaults; consumers use built-in fallbacks
      }
    }
    return modelDefaults;
  },

  setModel: (model: ChatModel, target): void => {
    void get().setModelAndWait(model, target);
  },

  syncPersistedTabModel: async (
    projectId: string,
    chatId: string,
  ): Promise<boolean> => {
    // The event names the workspace and the chat, not the scope. Cowork chats
    // key as `${workspaceId}/${workEntryId}`, so find the hydrated scope under
    // this workspace that actually holds the chat.
    const hydratedKey = Object.keys(get().worktreeChats).find((key) => {
      const selection = parseWorktreeChatKey(key);
      if (!selection || selection.projectId !== projectId) return false;
      return (
        get().worktreeChats[key]?.tabs.some((tab) => tab.id === chatId) === true
      );
    });
    if (!hydratedKey) return false;
    const selection = parseWorktreeChatKey(hydratedKey);
    if (!selection) return false;

    const syncKey = persistedModelSyncKey(projectId, chatId);
    const requestId = ++nextPersistedModelSyncRequestId;
    persistedModelSyncRequests.set(syncKey, requestId);
    try {
      const file = await chatBackendFor(selection)
        .chat.loadTabs({
          projectId: selection.projectId,
          worktreeId: selection.worktreeId,
        })
        .catch(ignoreUnavailable);
      if (file === undefined) return false;
      if (persistedModelSyncRequests.get(syncKey) !== requestId) return false;
      const persisted = file.tabs.find((tab) => tab.id === chatId);
      if (!persisted?.model) return false;

      const context = getWorktreeChatContext(get(), {
        projectId: selection.projectId,
        worktreeId: selection.worktreeId,
        chatId,
      });
      // File tabs carry no chat-side model; never stamp one onto them.
      if (!context?.activeTab || context.activeTab.kind === 'file')
        return false;

      // Only `portal.standalone_chat.set_model` writes all three fields; the
      // other `standaloneChatMetaUpdated` emitters leave whatever the tab file
      // already had. An absent persisted provider/harness therefore means "keep
      // the tab's own value", never "clear it" — so compare against the values
      // that would actually be applied. Comparing the raw persisted fields
      // instead re-wrote a tab with identical content (and a fresh object
      // identity, re-rendering the chat surface) on every unrelated nudge.
      const providerType =
        persisted.providerType ?? getProviderForModel(persisted.model);
      const nextProviderType = providerType ?? context.activeTab.providerType;
      const nextExecutionHarness =
        persisted.executionHarness ?? context.activeTab.executionHarness;
      if (
        context.activeTab.model === persisted.model &&
        context.activeTab.providerType === nextProviderType &&
        context.activeTab.executionHarness === nextExecutionHarness
      ) {
        return false;
      }

      set((state) =>
        updateCapturedChatTab(state, context, (tab) => ({
          ...tab,
          model: persisted.model,
          ...(nextProviderType ? { providerType: nextProviderType } : {}),
          ...(nextExecutionHarness
            ? { executionHarness: nextExecutionHarness }
            : {}),
        })),
      );
      return true;
    } finally {
      if (persistedModelSyncRequests.get(syncKey) === requestId) {
        persistedModelSyncRequests.delete(syncKey);
      }
    }
  },

  /**
   * Returns whether the model change was accepted, persisted, and not superseded.
   *
   * A locked cross-provider change can be refused by main. Recovery callers
   * need that verdict so they do not close over a model change that never
   * landed. Pre-flight bail-outs and rejected IPC calls likewise return false.
   */
  setModelAndWait: async (
    requestedModel: ChatModel,
    target,
    executionHarness,
    billingFramework,
  ): Promise<boolean> => {
    const pendingContext = getWorktreeChatContext(get(), target);
    if (!pendingContext) return false;
    const capturedTarget = {
      ...pendingContext.selection,
      chatId: pendingContext.chatId,
    };
    const requestKey = `${pendingContext.key}/${pendingContext.chatId}`;
    const requestId = nextMsgId();
    const isCurrentRequest = (): boolean =>
      get().pendingModelChanges[requestKey]?.requestId === requestId;
    set((state) => ({
      pendingModelChanges: {
        ...state.pendingModelChanges,
        [requestKey]: { requestId, model: requestedModel },
      },
    }));
    try {
      const eagerCreation = pendingEagerChatCreation(capturedTarget);
      if (eagerCreation && !(await eagerCreation)) return false;
      // Worktree selection starts hydration asynchronously. A model click can
      // otherwise outrun it, causing the legacy model channel and the typed
      // settings patch to target a renderer-only starter tab. Wait for that
      // in-flight load, then make the active chat canonical before capturing
      // the context used by both writes.
      if (loadingKeys.has(pendingContext.key)) {
        await waitForWorktreeHydration(pendingContext.key);
        await get().ensureWorktreeHasChatTab(pendingContext.selection);
      }
      // A newly exposed composer can belong to a tab whose canonical creation
      // is still resolving its approval default. Typed commands join this same
      // barrier in dispatchChatCommand, but the compatibility model channel is
      // sent first and used to race main with a renderer-only tab id. Main
      // tolerated that as not_found, then the typed settings patch surfaced the
      // conflict and refreshed the unsaved draft away. Do not start either half
      // of the model change until the tab exists canonically.
      const creation = pendingTabCreation(
        pendingContext.selection.projectId,
        pendingContext.selection.worktreeId,
        pendingContext.chatId,
      );
      if (creation && (await creation) !== 'accepted') return false;
      if (!isCurrentRequest()) return false;
      const context = getWorktreeChatContext(get(), capturedTarget);
      if (!context?.activeTab) return false;
      const { selection: sel, key, chatId, activeTab: currentTab } = context;
      // File tabs are inert for chat-side state.
      if (currentTab?.kind === 'file') return false;
      // A cloud chat's model is a web core catalog entry the desktop model
      // registry does not know: the web core sets it (CAN-6175 R5).
      if (isWebCoreScope(sel.projectId)) {
        const option = webCoreModelOption(
          useWebCoreModelCatalogStore.getState(),
          sel.projectId,
          requestedModel,
        );
        if (option === undefined) return false;
        const providerType = webCoreModelProvider(option);
        const show = (choice: CloudModelChoice): void =>
          set((state) =>
            updateCapturedChatTab(state, context, (shown) => ({
              ...shown,
              model: choice.model,
              providerType: choice.providerType,
            })),
          );
        // A tab's model changes reach the web core one at a time, so the model
        // it last confirmed is always its newest answer. A pick a newer one
        // replaced before it was sent is never sent, and only the newest pick
        // rolls back, to that confirmed model.
        if (!confirmedCloudModels.has(requestKey))
          confirmedCloudModels.set(requestKey, {
            model: currentTab.model,
            providerType: currentTab.providerType,
          });
        show({ model: requestedModel, providerType });
        // A refresh while this pick waits behind an older one keeps it shown.
        cloudPickOwners.set(requestKey, requestId);
        const ownsPick = (): boolean =>
          cloudPickOwners.get(requestKey) === requestId;
        pickWebCoreTabModel(
          { ...sel, chatId },
          { model: requestedModel, providerType },
        );
        const previous = cloudModelWrites.get(requestKey) ?? Promise.resolve();
        let release = (): void => undefined;
        const write = previous.then(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        cloudModelWrites.set(requestKey, write);
        try {
          await previous;
          let outcome: ChatCommandDisposition | null = null;
          if (ownsPick()) {
            outcome = await get().dispatchChatCommand(sel, {
              type: 'chat.set_model',
              tabId: chatId,
              model: requestedModel,
              providerType,
            });
            if (outcome === 'accepted')
              confirmedCloudModels.set(requestKey, {
                model: requestedModel,
                providerType,
              });
          }
          if (!ownsPick()) return outcome === 'accepted';
          const confirmed = confirmedCloudModels.get(requestKey);
          confirmedCloudModels.delete(requestKey);
          // The web core backend orders the tab's model by revision, so after
          // the reply it names the model the web core runs, whatever reached
          // the tab meanwhile (CAN-6345). Before it has read the tab, a
          // refused pick rolls back to the model the web core last confirmed.
          const runs = webCoreTabModel({ ...sel, chatId });
          if (runs !== undefined) show(runs);
          else if (outcome !== 'accepted' && confirmed !== undefined)
            show(confirmed);
          return outcome === 'accepted';
        } finally {
          release();
          if (cloudModelWrites.get(requestKey) === write)
            cloudModelWrites.delete(requestKey);
          if (ownsPick()) {
            cloudPickOwners.delete(requestKey);
            pickWebCoreTabModel({ ...sel, chatId }, null);
          }
        }
      }
      const model = pinInheritingAgentModel(
        requestedModel,
        resolveTabDefaults(sel.projectId, get().modelDefaults).model,
      );
      const selectedHarness = resolveChatModelChangeHarness(
        currentTab,
        model,
        executionHarness,
      );
      const newProviderType = getProviderForChatModel(model, selectedHarness);
      if (!newProviderType) {
        set((state) =>
          updateCapturedChatTab(state, context, (tab) => ({
            ...tab,
            status: 'error',
            error: unresolvedProviderError(model),
          })),
        );
        return false;
      }
      const previousProviderType = currentTab
        ? (currentTab.providerType ??
          (currentTab.model
            ? (getProviderForModel(currentTab.model) ?? newProviderType)
            : newProviderType))
        : newProviderType;
      const currentTabHasContent = chatTabHasConversationContent(currentTab);
      const shouldCleanupEmptyClaudeTerminal =
        previousProviderType === 'claude' &&
        newProviderType !== 'claude' &&
        currentTab !== undefined &&
        !currentTabHasContent;

      return await chatBackendFor(sel)
        .chat.changeModel({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
          model,
          lockedHarness: getLockedHarness(currentTab),
          ...(executionHarness ? { executionHarness } : {}),
        })
        .then(async (accepted: boolean) => {
          // Main may commit a newer click before an older IPC reply reaches
          // this renderer. Never replay that older reply into the UI or issue
          // its compatibility settings write over the newer canonical model.
          if (!accepted || !isCurrentRequest()) return false;
          const selectedBilling = billingFramework
            ? {
                aiCreditsRouting: undefined,
                subscriptionBillingOverride: undefined,
                ...billingSeedFields(billingFramework),
                billingExplicitlyChosen: true,
              }
            : {};
          invalidatePersistedModelSync(sel.projectId, chatId);
          set((state) =>
            updateCapturedChatTab(state, context, (t) => {
              // When the provider changes, swap in the per-provider default
              // thinking level from preferences so each provider honors its
              // own configured default. When the provider is unchanged, keep
              // the user's current level (clamped for the provider).
              const providerChanged = previousProviderType !== newProviderType;
              const perProviderDefault = providerChanged
                ? resolveProviderDefaults(
                    sel.projectId,
                    state.modelDefaults,
                    newProviderType,
                  ).thinkingLevel
                : undefined;
              const selectionHarness =
                resolveChatModelChangeHarness(t, model, executionHarness) ??
                newProviderType;
              const baseLevel = perProviderDefault ?? t.thinkingLevel;
              const thinkingLevel = normalizeThinkingForProvider(
                baseLevel,
                selectionHarness,
              );
              // Provider swapping into Claude on a not-yet-started chat is
              // morally a "new Claude chat" — apply the default chat
              // interface mode so the managed terminal experience kicks in
              // when the user has selected it. Restrict to fresh tabs (no
              // messages or queued messages) so we never surprise an
              // in-progress chat with a mid-conversation surface switch.
              //
              // A Claude Code terminal launch may preallocate `sdkSessionId`
              // before the user has sent anything; that empty runtime does
              // not make the tab non-fresh.
              const tabIsFresh = !chatTabHasConversationContent(t);
              const switchedIntoClaude =
                providerChanged && newProviderType === 'claude';
              const defaultInterfaceMode =
                resolvePersistedDefaultChatInterfaceMode(
                  sel.projectId,
                  state.modelDefaults,
                );
              const nextInterfaceMode =
                switchedIntoClaude &&
                tabIsFresh &&
                defaultInterfaceMode !== undefined
                  ? defaultInterfaceMode
                  : t.interfaceMode;
              // Codex speed across the change (main's canonical `chat.set_model`
              // is authoritative and applies the same rules): a Codex model
              // change keeps the requested speed; returning to Codex restores
              // the speed retained when the tab left it, before any default; a
              // provider change on a tab without an explicit speed takes the new
              // provider's default record (speed-first).
              const leavingCodex =
                providerChanged && previousProviderType === 'codex';
              const enteringCodex =
                providerChanged && newProviderType === 'codex';
              const restoredSpeed = enteringCodex
                ? t.retainedCodexSpeed
                : undefined;
              const requestedSpeed: CodexSpeed | undefined =
                restoredSpeed ??
                (providerChanged && !t.fastModeExplicit
                  ? (readCodexSpeedRecord(
                      state.modelDefaults?.modelConfigDefaultsByProvider?.[
                        newProviderType
                      ],
                    ) ?? DEFAULT_CODEX_SPEED)
                  : undefined);
              const nextModelConfig = resolveProviderModelConfig(
                selectionHarness,
                {
                  thinkingLevel,
                  modelConfig:
                    requestedSpeed === undefined
                      ? t.modelConfig
                      : {
                          ...t.modelConfig,
                          ...codexSpeedFields(requestedSpeed),
                        },
                },
                state.modelDefaults?.modelConfigDefaultsByProvider,
              );
              const nextTab: ChatTab = {
                ...t,
                ...selectedBilling,
                // The accepted change resolved a provider, so a synthetic
                // selection-failure banner from an earlier rejected pick is stale.
                ...clearedUnresolvedProviderError(t),
                model,
                providerType: newProviderType,
                thinkingLevel: nextModelConfig.thinkingLevel,
                modelConfig: nextModelConfig,
                codexFastModeEnabled: nextModelConfig.fastMode,
                modelExplicitlyChosen: true,
                // The context meter must not keep the OLD model's window until
                // the next result event (CAN-2799): counters carry, the window
                // follows the model. Undefined stays undefined only when the
                // model has no configured window.
                usage: resolveTabUsageForModel(
                  t.usage,
                  model,
                  isTabAiCreditsRouted({ ...t, model, ...selectedBilling }),
                  selectionHarness === 'ollama' ? undefined : selectionHarness,
                ),
              };
              if (
                newProviderType === 'cursor' ||
                newProviderType === 'copilot' ||
                newProviderType === 'opencode'
              ) {
                delete nextTab.aiCreditsRouting;
                delete nextTab.subscriptionBillingOverride;
                delete nextTab.billingExplicitlyChosen;
              }
              // Optimistic mirror of the main-owned retained Codex speed. When
              // main's canonical change already replaced the tab, its mirrored
              // value is authoritative and stays untouched.
              if (leavingCodex) {
                if (resolveTabProviderType(t) === 'codex') {
                  if (t.fastModeExplicit) {
                    nextTab.retainedCodexSpeed = tabRequestedCodexSpeed(t);
                  } else {
                    delete nextTab.retainedCodexSpeed;
                  }
                }
              } else if (enteringCodex) {
                delete nextTab.retainedCodexSpeed;
                if (restoredSpeed !== undefined)
                  nextTab.fastModeExplicit = true;
              }
              const persistedInterfaceMode = isClaudeTerminalEligibleChatTab({
                model,
                providerType: newProviderType,
              })
                ? getPersistedClaudeChatInterfaceMode(nextInterfaceMode)
                : undefined;
              if (persistedInterfaceMode) {
                nextTab.interfaceMode = persistedInterfaceMode;
              } else {
                delete nextTab.interfaceMode;
              }
              if (selectionHarness === 'opencode') {
                nextTab.executionHarness = 'opencode';
                nextTab.executionHarnessExplicitlyChosen = true;
              } else if (tabIsFresh) {
                // A preallocated provider session does not capture a harness.
                // Resolve the current assignment when the first turn starts.
                if (executionHarness) {
                  nextTab.executionHarness = executionHarness;
                  nextTab.executionHarnessExplicitlyChosen = true;
                } else if (
                  t.model !== model ||
                  !t.executionHarnessExplicitlyChosen
                ) {
                  delete nextTab.executionHarness;
                  delete nextTab.executionHarnessExplicitlyChosen;
                }
              }
              if (providerChanged && tabIsFresh) {
                delete nextTab.sdkSessionId;
                delete nextTab.claudeForkSessionOnNextSend;
                delete nextTab.claudeTerminal;
                delete nextTab.lastTurnWasResumeAttempt;
              }
              return nextTab;
            }),
          );
          if (shouldCleanupEmptyClaudeTerminal) {
            void useClaudeTerminalStore
              .getState()
              .cleanup(sel.projectId, sel.worktreeId, chatId, 'provider-switch')
              .catch(() => undefined);
          } else {
            // A live managed terminal only honors the new model after a
            // relaunch with fresh CLI args.
            void restartClaudeTerminalForSettingsChange(sel, chatId).catch(
              () => undefined,
            );
          }

          const updatedTab = get().worktreeChats[key]?.tabs.find(
            (t) => t.id === chatId,
          );
          if (!isCurrentRequest()) return false;
          if (
            updatedTab &&
            isScopeRevisionedLive(get(), sel.projectId, sel.worktreeId)
          ) {
            const command = {
              type: 'chat.patch_tab_settings',
              tabId: chatId,
              patch: {
                model,
                providerType: newProviderType,
                modelExplicitlyChosen: true,
                modelConfig: updatedTab.modelConfig,
                thinkingLevel: updatedTab.thinkingLevel,
                codexFastModeEnabled: updatedTab.codexFastModeEnabled ?? null,
                interfaceMode: updatedTab.interfaceMode ?? null,
                ...(billingFramework
                  ? {
                      billingExplicitlyChosen: true,
                      aiCreditsRouting: updatedTab.aiCreditsRouting ?? null,
                      subscriptionBillingOverride:
                        updatedTab.subscriptionBillingOverride ?? false,
                    }
                  : {}),
                ...(newProviderType === 'cursor' ||
                newProviderType === 'copilot' ||
                newProviderType === 'opencode'
                  ? {
                      aiCreditsRouting: null,
                      subscriptionBillingOverride: false,
                      billingExplicitlyChosen: false,
                    }
                  : {}),
              },
            } as const;
            // A fresh starter can still be renderer-only if its bounded
            // hydration wait expires before canonical creation settles. That
            // creation reads the latest local tab settings, so not_found here is
            // an expected sequencing result—not an external edit. Treating it
            // as a conflict forces a canonical refresh that erases the unsent
            // composer draft. Content-bearing tabs remain strict.
            const commandOptions = {
              acceptNotFound: !currentTabHasContent,
            } as const;
            let disposition = await get().dispatchChatCommand(
              sel,
              command,
              commandOptions,
            );
            if (
              isCurrentRequest() &&
              (disposition === 'transport_failed' ||
                disposition === 'conflict') &&
              (await waitForChatScopeLive(sel.projectId, sel.worktreeId))
            ) {
              if (!isCurrentRequest()) return false;
              disposition = await get().dispatchChatCommand(
                sel,
                command,
                commandOptions,
              );
            }
            if (disposition === 'accepted') {
              get().dismissChatStateNotice(sel.projectId, sel.worktreeId);
            } else if (billingFramework) {
              return false;
            }
          }
          if (!isCurrentRequest()) return false;
          if (billingFramework)
            get().rememberBillingFramework(billingFramework);
          const failureId = currentTab.provisionalFirstSend?.failure?.failureId;
          if (failureId) {
            set((state) =>
              updateCapturedChatTab(state, context, (tab) => {
                const record = tab.provisionalFirstSend;
                if (
                  record?.phase !== 'failed' ||
                  record.failure?.failureId !== failureId
                )
                  return tab;
                return {
                  ...tab,
                  provisionalFirstSend: {
                    ...record,
                    failure: {
                      ...record.failure,
                      recoveryModelSelectionAccepted: true,
                    },
                  },
                };
              }),
            );
          }
          requestTabDiscovery({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            chatId,
            pluginSelections: updatedTab?.pluginSelections,
            providerType: resolveDiscoveryProviderType(updatedTab),
          });
          return true;
        })
        .catch(() => false);
    } finally {
      if (isCurrentRequest()) {
        set((state) => {
          const pendingModelChanges = { ...state.pendingModelChanges };
          delete pendingModelChanges[requestKey];
          return { pendingModelChanges };
        });
      }
    }
  },

  reconcileModelRegistry: (
    snapshot: ModelRegistrySnapshot,
    modelPolicy?: ReadonlySet<string>,
    ownerScope?: ModelRegistryOwnerScope,
  ): void => {
    const owner = ownerScope?.owner;
    const blockedByLabel = ownerScope?.organizationName ?? 'Your organization';
    const routedModelIds = new Set(
      (snapshot.gatewayRoutes ?? []).map((route) => route.modelId),
    );
    const ownerOrganizationId =
      owner?.kind === 'organization'
        ? normalizeUuid(owner.organizationId)
        : null;
    const foreignOrgRouteIds = new Set(
      owner === undefined
        ? []
        : (snapshot.gatewayRoutes ?? [])
            .filter(
              (route) =>
                route.origin === 'org-gateway' &&
                (ownerOrganizationId === null ||
                  normalizeUuid(route.organizationId) !== ownerOrganizationId),
            )
            .map((route) => route.modelId),
    );
    const enforcingOrganizationIds = new Set(
      (ownerScope?.gatewayEnforcingOrganizationIds ?? []).flatMap((id) => {
        const normalized = normalizeUuid(id);
        return normalized ? [normalized] : [];
      }),
    );
    const enforcedOwnerGatewayRouteIds =
      ownerScope?.gatewayEnforced === true
        ? new Set(
            (snapshot.gatewayRoutes ?? [])
              .filter((route) => {
                if (route.origin !== 'org-gateway') return false;
                const routeOrganizationId = normalizeUuid(route.organizationId);
                if (routeOrganizationId === null) return false;
                if (ownerOrganizationId !== null) {
                  return routeOrganizationId === ownerOrganizationId;
                }
                return (
                  enforcingOrganizationIds.size === 0 ||
                  enforcingOrganizationIds.has(routeOrganizationId)
                );
              })
              .map((route) => route.modelId),
          )
        : null;
    const availableOllamaModels = snapshot.ollama
      .filter((entry) => isSupportedOllamaModelEntry(entry))
      .map((entry) => entry.id);
    const availableOllamaModelSet = new Set(availableOllamaModels);
    /**
     * The first model the org still allows, in catalog order — the same
     * `allowed[0]` rule the picker sorts to the top, so a chat that falls back
     * lands on the row the member is about to see rather than on some other
     * deterministic-but-surprising pick.
     *
     * `undefined` when nothing is blocked (the overwhelming majority) or when
     * the org has blocked its entire catalog, which is deliberately not
     * special-cased: the tab keeps its model and the main-process session guard
     * refuses the turn with a real message.
     */
    const policy = modelPolicy;
    const firstAllowedModel: ChatModel | undefined =
      policy && policy.size > 0
        ? [
            ...snapshot.claude,
            ...snapshot.codex,
            ...(snapshot.aiGatewayModels ?? []),
          ]
            .map((entry) => entry.id)
            .find(
              (id) =>
                !foreignOrgRouteIds.has(id) &&
                (enforcedOwnerGatewayRouteIds === null ||
                  enforcedOwnerGatewayRouteIds.has(id)) &&
                !isModelBlocked(id, policy),
            )
        : undefined;
    const resolveSnapshotHarness = (
      model: ChatModel,
      providerType: AgentProviderType,
    ): 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' | undefined =>
      snapshot.harnessAssignments?.assignments.find(
        (assignment) => assignment.modelId === model,
      )?.harness ??
      snapshot.aiGatewayModels?.find((entry) => entry.id === model)
        ?.recommendedHarness ??
      getExecutionHarnessForModel(model) ??
      (providerType === 'claude' || providerType === 'codex'
        ? providerType
        : undefined);
    const pendingDiscovery: Array<{
      projectId: string;
      worktreeId: string;
      chatId: string;
      pluginSelections?: ChatTabPluginSelections;
      providerType?: AgentProviderType;
      model: ChatModel;
      notice?: ChatModelChangeNotice;
    }> = [];

    set((state) => {
      let changed = false;
      const nextChats: Record<string, WorktreeChatState> = {};

      for (const [key, worktreeChat] of Object.entries(state.worktreeChats)) {
        const { projectId, worktreeId } = splitWorktreeKey(key);
        // `modelPolicy` is the ACTIVE owner's policy, so it may only rewrite
        // tabs that owner covers. A tab of another owner keeps its model here;
        // main's session gate decides against that tab's real owner.
        let worktreeChanged = false;
        const tabs = worktreeChat.tabs.map((tab) => {
          // OpenCode resume binds the model and funding authority. A policy or
          // catalog refresh cannot substitute another runtime or paid route.
          // Preserve the choice; send-time admission explains its unavailability.
          if (
            tab.executionHarness === 'opencode' ||
            tab.providerType === 'opencode'
          )
            return tab;
          const inOwnerScope =
            ownerScope === undefined ||
            ownerScope.isTabInOwnerScope(
              projectId,
              tab.executionContext,
              chatTabHasConversationContent(tab),
            );
          // A chat saved on a bare org model id whose row is now namespaced
          // (`<id>@<orgId>`, because another org or a hosted model shares the
          // id) moves to the owner's own row. Only when the bare id can no
          // longer serve the chat — it no longer routes, or the owner's org
          // makes its gateway the only route — so a deliberate pick of a
          // hosted model under an additive gateway is left alone.
          const scopedModel =
            inOwnerScope &&
            tab.model &&
            (ownerScope?.gatewayEnforced === true ||
              !getProviderForModel(tab.model))
              ? resolveOwnerScopedModelId(tab.model, owner)
              : tab.model;
          if (
            scopedModel &&
            scopedModel !== tab.model &&
            routedModelIds.has(scopedModel) &&
            !(policy && isModelBlocked(scopedModel, policy))
          ) {
            const scopedProviderType = getProviderForModel(scopedModel);
            if (scopedProviderType) {
              worktreeChanged = true;
              pendingDiscovery.push({
                projectId,
                worktreeId,
                chatId: tab.id,
                pluginSelections: tab.pluginSelections,
                providerType: scopedProviderType,
                model: scopedModel,
              });
              return {
                ...tab,
                ...clearedUnresolvedProviderError(tab),
                model: scopedModel,
                providerType: scopedProviderType,
                executionHarness: resolveSnapshotHarness(
                  scopedModel,
                  scopedProviderType,
                ),
              };
            }
          }
          /*
           * An interactive chat whose persisted model just became org-blocked
           * falls back to the first allowed model, deliberately the OPPOSITE of
           * what pipelines and Agents do (they refuse). A human is present to
           * read the change, and falling back TOWARD the allowed set is safe by
           * construction — whereas refusing here would strand the member in a
           * chat they cannot send from and cannot obviously fix.
           */
          if (
            inOwnerScope &&
            firstAllowedModel &&
            policy &&
            tab.model &&
            isModelBlocked(tab.model, policy)
          ) {
            const nextProviderType =
              getProviderForModel(firstAllowedModel) ??
              snapshot.aiGatewayModels?.find(
                (entry) => entry.id === firstAllowedModel,
              )?.recommendedHarness;
            if (!nextProviderType) {
              // Mark the worktree changed so the error tab is committed and
              // persisted — without this the mapped tabs array is discarded
              // and the tab silently keeps its blocked model.
              worktreeChanged = true;
              return {
                ...tab,
                status: 'error' as const,
                error: unresolvedProviderError(firstAllowedModel),
              };
            }
            const notice: ChatModelChangeNotice = {
              id: nextMsgId(),
              timestamp: Date.now(),
              text: `${blockedByLabel} blocked ${getModelDisplayName(tab.model)}, so this chat switched to ${getModelDisplayName(firstAllowedModel)}.`,
            };
            worktreeChanged = true;
            pendingDiscovery.push({
              projectId,
              worktreeId,
              chatId: tab.id,
              pluginSelections: tab.pluginSelections,
              providerType: nextProviderType,
              model: firstAllowedModel,
              notice,
            });
            return {
              ...tab,
              // The fallback model resolved a provider, so any synthetic
              // selection-failure banner is stale from here on.
              ...clearedUnresolvedProviderError(tab),
              messages: [
                ...tab.messages,
                {
                  id: notice.id,
                  role: 'system' as const,
                  timestamp: notice.timestamp,
                  blocks: [
                    {
                      type: 'text' as const,
                      text: notice.text,
                    },
                  ],
                },
              ],
              model: firstAllowedModel,
              providerType: nextProviderType,
              executionHarness: resolveSnapshotHarness(
                firstAllowedModel,
                nextProviderType,
              ),
              thinkingLevel: normalizeThinkingForProvider(
                tab.thinkingLevel,
                nextProviderType,
              ),
              // The old session ran on the blocked model; resuming it would
              // carry that model straight back into the next turn.
              sdkSessionId: undefined,
              claudeForkSessionOnNextSend: undefined,
              usage: resolveTabUsageForModel(
                tab.usage,
                firstAllowedModel,
                isTabAiCreditsRouted({ ...tab, model: firstAllowedModel }),
              ),
            };
          }

          if (!tab.model || !isOllamaModel(tab.model)) {
            // A tab can be stranded on the synthetic selection-failure state
            // by a rejected pick that never changed its model. Once the
            // registry confirms the model it kept still routes to a provider,
            // that banner is stale — reconcile it away. Genuine errors carry
            // different text and pass through untouched.
            const cleared = clearedUnresolvedProviderError(tab);
            if (cleared && tab.model && getProviderForModel(tab.model)) {
              worktreeChanged = true;
              return { ...tab, ...cleared };
            }
            return tab;
          }
          if (availableOllamaModelSet.has(tab.model)) {
            const cleared = clearedUnresolvedProviderError(tab);
            if (cleared) {
              worktreeChanged = true;
              return { ...tab, ...cleared };
            }
            return tab;
          }

          const nextModel = resolveFallbackModelForDeletedOllama(
            projectId,
            state.modelDefaults,
            availableOllamaModels,
          );
          const nextProviderType =
            getProviderForModel(nextModel) ??
            resolveTabDefaults(projectId, state.modelDefaults).providerType;
          if (!nextProviderType) {
            worktreeChanged = true;
            const unresolvedTab: ChatTab = {
              ...tab,
              status: 'error',
              error: unresolvedProviderError(nextModel),
            };
            return unresolvedTab;
          }
          worktreeChanged = true;
          pendingDiscovery.push({
            projectId,
            worktreeId,
            chatId: tab.id,
            pluginSelections: tab.pluginSelections,
            providerType: nextProviderType,
            model: nextModel,
          });
          return {
            ...tab,
            // The fallback resolved a provider; drop any stale synthetic
            // selection-failure banner along with the dead model.
            ...clearedUnresolvedProviderError(tab),
            model: nextModel,
            providerType: nextProviderType,
            executionHarness: resolveSnapshotHarness(
              nextModel,
              nextProviderType,
            ),
            thinkingLevel: normalizeThinkingForProvider(
              tab.thinkingLevel,
              nextProviderType,
            ),
            sdkSessionId: undefined,
            claudeForkSessionOnNextSend: undefined,
            usage: resolveTabUsageForModel(
              tab.usage,
              nextModel,
              isTabAiCreditsRouted({ ...tab, model: nextModel }),
            ),
          };
        });

        if (worktreeChanged) {
          const updated = { ...worktreeChat, tabs };
          nextChats[key] = updated;
          changed = true;
        } else {
          nextChats[key] = worktreeChat;
        }
      }

      if (!changed) {
        return state;
      }

      return {
        worktreeChats: nextChats,
      };
    });

    for (const change of pendingDiscovery) {
      void chatBackendFor(change)
        .chat.changeModel({
          projectId: change.projectId,
          worktreeId: change.worktreeId,
          chatId: change.chatId,
          model: change.model,
          notice: change.notice,
        })
        .catch(() => {});

      requestTabDiscovery({
        projectId: change.projectId,
        worktreeId: change.worktreeId,
        chatId: change.chatId,
        pluginSelections: change.pluginSelections,
        providerType: change.providerType,
      });
    }
  },

  applyModelConfigDefaults: (defaults): void => {
    set((state) => {
      const nextDefaults = {
        ...(state.modelDefaults?.modelConfigDefaultsByProvider ?? {}),
        ...defaults,
      };
      const nextChats: Record<string, WorktreeChatState> = {};
      let changed = false;

      for (const [key, worktreeChat] of Object.entries(state.worktreeChats)) {
        const nextTabs = worktreeChat.tabs.map((tab) => {
          if (tab.kind === 'file' || tab.fastModeExplicit) return tab;
          const provider =
            tab.providerType ??
            (tab.model ? getProviderForModel(tab.model) : undefined);
          if (!provider) return tab;
          // A tab without an explicit speed follows its provider's default
          // record, read speed-first so an Ultra fast default (whose boolean
          // projection is `false`) still reaches it.
          const defaultSpeed =
            readCodexSpeedRecord(nextDefaults[provider]) ?? DEFAULT_CODEX_SPEED;
          const modelConfig = resolveProviderModelConfig(
            provider,
            {
              thinkingLevel: tab.thinkingLevel,
              modelConfig: {
                ...tab.modelConfig,
                ...codexSpeedFields(defaultSpeed),
              },
            },
            nextDefaults,
          );
          if (
            modelConfig.speed === tab.modelConfig.speed &&
            modelConfig.fastMode === tab.modelConfig.fastMode &&
            modelConfig.thinkingLevel === tab.modelConfig.thinkingLevel
          ) {
            return tab;
          }
          changed = true;
          return {
            ...tab,
            thinkingLevel: modelConfig.thinkingLevel,
            modelConfig,
            codexFastModeEnabled: modelConfig.fastMode,
          };
        });
        nextChats[key] =
          nextTabs === worktreeChat.tabs
            ? worktreeChat
            : { ...worktreeChat, tabs: nextTabs };
      }

      return {
        modelDefaults: state.modelDefaults
          ? {
              ...state.modelDefaults,
              modelConfigDefaultsByProvider: nextDefaults,
            }
          : state.modelDefaults,
        ...(changed ? { worktreeChats: nextChats } : {}),
      };
    });
  },

  setModelSelectionMode: async (mode, target): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const { activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return;
    if ((activeTab.modelSelectionMode === 'auto') === (mode === 'auto')) return;

    set((state) =>
      updateCapturedChatTab(state, context, (tab) => {
        const next = { ...tab };
        if (mode === 'auto') next.modelSelectionMode = 'auto';
        else delete next.modelSelectionMode;
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
      // `null` is the canonical "return to manual" signal on
      // `ChatTabSettingsPatch.modelSelectionMode`; omitting the key would mean
      // "unchanged" and leave a stale Auto chat routing after a durable loss.
      await get().dispatchChatCommand(context.selection, {
        type: 'chat.patch_tab_settings',
        tabId: context.chatId,
        patch: { modelSelectionMode: mode === 'auto' ? 'auto' : null },
      });
    }
  },

  setSpeed: async (speed, target): Promise<void> => {
    if (!isCodexSpeed(speed)) return;
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const capturedTarget = { ...context.selection, chatId: context.chatId };
    const eagerCreation = pendingEagerChatCreation(capturedTarget);
    if (eagerCreation) {
      if (await eagerCreation) await get().setSpeed(speed, capturedTarget);
      return;
    }
    const { selection: sel, chatId, activeTab } = context;
    if (!activeTab || activeTab.kind === 'file') return;
    // A cloud chat's fast mode is the window's choice for its sends, not the
    // tab's Codex speed, and runs only where the model's catalog says so
    // (CAN-6322).
    if (isWebCoreScope(sel.projectId)) {
      if (!webCoreModelRunsFastMode(sel.projectId, activeTab.model)) return;
      await chatBackendFor(sel).chat.toggleCodexFastMode({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        enabled: codexSpeedFastMode(speed),
        speed,
      });
      return;
    }
    const provider = resolveDiscoveryProviderType(activeTab);
    if (!provider || !modelConfigForProviderSupportsFastMode(provider)) return;
    const enabled = codexSpeedFastMode(speed);
    const showSpeed = (next: CodexSpeed): void =>
      set((state) =>
        updateCapturedChatTab(state, context, (tab) => ({
          ...tab,
          modelConfig: { ...tab.modelConfig, ...codexSpeedFields(next) },
          fastModeExplicit: true,
          codexFastModeEnabled: codexSpeedFastMode(next),
        })),
      );
    const release = beginLocalCodexSpeedWrite(
      sel.projectId,
      sel.worktreeId,
      chatId,
      tabRequestedCodexSpeed(activeTab),
    );

    // Speed and its derived boolean change together; Ultra fast never
    // projects `fastMode: true`.
    showSpeed(speed);

    // The existing canonical channel: main treats `speed` as authoritative
    // and requires `enabled` to equal its projection.
    try {
      await chatBackendFor(sel).chat.toggleCodexFastMode({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        enabled,
        speed,
      });
    } catch (error: unknown) {
      // Echoes were held back while writes were pending; once the newest
      // one is refused, show the speed main last confirmed.
      const rollback = release(true);
      if (rollback !== undefined) showSpeed(rollback);
      throw error;
    }
    const rollback = release(false);
    if (rollback !== undefined) showSpeed(rollback);
  },

  setContextWindow: async (contextWindow, target): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context?.activeTab || context.activeTab.kind === 'file') return;
    const previous = context.activeTab.modelConfig?.contextWindow;
    const show = (next: typeof previous): void =>
      set((state) =>
        updateCapturedChatTab(state, context, (tab) => {
          const modelConfig = { ...tab.modelConfig };
          if (next === undefined) delete modelConfig.contextWindow;
          else modelConfig.contextWindow = next;
          return { ...tab, modelConfig };
        }),
      );
    show(contextWindow);
    await get().dispatchChatCommand(
      context.selection,
      {
        type: 'chat.patch_tab_settings',
        tabId: context.chatId,
        patch: { modelConfig: { contextWindow } },
      },
      { rollback: () => show(previous) },
    );
  },

  setFastMode: async (enabled, target): Promise<void> => {
    // Legacy boolean command: an explicit boolean replaces the speed, so
    // `false` moves Ultra fast to Regular rather than keeping it.
    await get().setSpeed(codexSpeedFromFastMode(enabled), target);
  },

  toggleFastMode: (target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context?.activeTab || context.activeTab.kind === 'file') return;
    if (isWebCoreScope(context.selection.projectId)) {
      const on =
        useWebCoreFastModeStore.getState().byChat[context.chatId] === true;
      void get().setFastMode(!on, target);
      return;
    }
    const provider = resolveDiscoveryProviderType(context.activeTab);
    if (!provider || !modelConfigForProviderSupportsFastMode(provider)) return;
    // Flips the derived boolean: Ultra fast (projected `false`) becomes Fast.
    const fastMode = codexSpeedFastMode(
      tabRequestedCodexSpeed(context.activeTab),
    );
    void get().setFastMode(!fastMode, target);
  },

  setCodexFastMode: (enabled, target): void => {
    void get().setFastMode(enabled, target);
  },

  toggleCodexFastMode: (target): void => {
    get().toggleFastMode(target);
  },

  cycleThinkingLevel: (target): void => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const capturedTarget = { ...context.selection, chatId: context.chatId };
    const eagerCreation = pendingEagerChatCreation(capturedTarget);
    if (eagerCreation) {
      void eagerCreation.then((ready) => {
        if (ready) get().cycleThinkingLevel(capturedTarget);
      });
      return;
    }
    const { selection: sel, chatId, activeTab: tab } = context;
    if (!tab) return;
    if (tab.kind === 'file') return;

    // Cycle the model's canonical set using the same helper as the shared
    // effort controls. Legacy capability fallbacks still exclude Low.
    const providerType =
      tab.executionHarness ??
      (tab.model ? getExecutionHarnessForModel(tab.model) : undefined) ??
      resolveDiscoveryProviderType(tab) ??
      'claude';
    // The cycle must honor the billing route the session actually executes
    // on: an AI-Credits-routed chat is constrained to the gateway-advertised
    // set, not the model's native tiers.
    // A cloud chat's model runs the levels its web core catalog lists; none
    // until the catalog is read.
    const webCore = isWebCoreScope(sel.projectId);
    const cycle = webCore
      ? webCoreThinkingLevels(
          useWebCoreModelCatalogStore.getState(),
          sel.projectId,
          tab.model,
        )
      : getEffectiveSupportedThinkingLevelsForModel(
          tab.model,
          isTabAiCreditsRouted(tab),
          providerType,
          tab.executionHarness,
        );
    if (webCore && cycle.length === 0) return;
    const next = advanceThinkingControlLevel(
      clampModelThinkingLevel(tab.thinkingLevel, cycle),
      cycle,
      cycle.includes('low'),
    );

    set((state) =>
      updateCapturedChatTab(state, context, (t) => ({
        ...t,
        thinkingLevel: next,
        modelConfig: { ...t.modelConfig, thinkingLevel: next },
      })),
    );

    void chatBackendFor(sel)
      .chat.toggleThinkingLevel({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        level: next,
      })
      .catch(reportUnlessUnavailable);
    // A live managed terminal only honors the new thinking level after a
    // relaunch with fresh CLI args.
    void restartClaudeTerminalForSettingsChange(sel, chatId).catch(
      () => undefined,
    );
  },

  setThinkingLevel: async (level, target): Promise<void> => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return;
    const capturedTarget = { ...context.selection, chatId: context.chatId };
    const eagerCreation = pendingEagerChatCreation(capturedTarget);
    if (eagerCreation) {
      if (await eagerCreation)
        await get().setThinkingLevel(level, capturedTarget);
      return;
    }
    const { selection: sel, chatId, activeTab: tab } = context;
    if (!tab) return;
    if (tab.kind === 'file') return;

    // Normalize against the captured/effective execution harness so Codex
    // effort semantics apply whenever the chat runs on the Codex harness.
    const providerType =
      tab.executionHarness ??
      (tab.model ? getExecutionHarnessForModel(tab.model) : undefined) ??
      resolveDiscoveryProviderType(tab) ??
      'claude';
    const next = normalizeThinkingForProvider(level, providerType);

    set((state) =>
      updateCapturedChatTab(state, context, (t) => ({
        ...t,
        thinkingLevel: next,
        modelConfig: { ...t.modelConfig, thinkingLevel: next },
      })),
    );

    await chatBackendFor(sel)
      .chat.toggleThinkingLevel({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        level: next,
      })
      .catch(ignoreUnavailable);
    // A live managed terminal only honors the new thinking level after a
    // relaunch with fresh CLI args.
    void restartClaudeTerminalForSettingsChange(sel, chatId).catch(
      () => undefined,
    );
  },
});
