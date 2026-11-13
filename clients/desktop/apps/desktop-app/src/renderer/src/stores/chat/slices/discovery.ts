import {
  chatSurfaceUsesGlobalPluginDefaults,
  hasAnyTombstones,
  subtractPluginSelections,
  unionPluginSelections,
} from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  enqueueWorktreeTabDiscoveryRefresh,
  requestDiscoveryForChatTab,
  requestTabDiscovery,
  resolveDiscoveryProviderType,
  scheduleEmptyTabPluginSelectionSanitization,
} from '../discovery';
import {
  billingSeedFields,
  chatTabHasConversationContent,
  getDefaultPlugins,
} from '../tab-utils';
import { queueDesktopTryItSelectionUpdate } from '@/lib/tryItContinuationRunner';
import { withRequiredPluginSelectionsForTarget } from '../surface';
import { sanitizePluginSelectionsWithCachedSupport } from '../plugin-provider-support';
import { worktreeKey } from '../utils';
import {
  resolveLaneForTarget,
  resolveBillingSeed,
  resolvePersistedDefaultChatInterfaceMode,
  resolveTabDefaults,
} from '../defaults';
import { getPersistedClaudeChatInterfaceMode } from '@/lib/claude-tui-chats';
import {
  APP_ADVISOR_PROJECT_ID,
  DEFAULT_APP_ADVISOR_MODEL,
  type ChatTabPluginSelections,
  clampThinkingLevelForModel,
  getProviderForModel,
  modelConfigForProviderSupportsFastMode,
  normalizeThinkingForProvider,
  resolveProviderModelConfig,
} from '@canopy/desktop-shared/types';
import { codexSpeedFields, tabRequestedCodexSpeed } from '../codex-speed';
import { type ChatTab } from '../types';
import { getWorktreeChatContext, updateCapturedChatTab } from '../context';
import { isClaudeTerminalEligibleChatTab } from '@/lib/chat-provider';
import type { StateCreator } from 'zustand';
import type { ChatState, ChatDiscoverySlice } from '../state';
import {
  chatBackendFor,
  isCapabilityUnavailable,
  reportUnlessUnavailable,
} from '../backend';

export const createDiscoverySlice: StateCreator<
  ChatState,
  [],
  [],
  ChatDiscoverySlice
> = (set, get) => ({
  worktreeDefaultPlugins: {},

  tabDiscoveryLoading: new Set<string>(),

  setWorktreeDefaultPlugins: (projectId, worktreeId, selections): void => {
    const key = `${projectId}/${worktreeId}`;
    set((state) => {
      const nextDefaults = { ...state.worktreeDefaultPlugins };
      if (selections) {
        nextDefaults[key] = selections;
      } else {
        delete nextDefaults[key];
      }
      return { worktreeDefaultPlugins: nextDefaults };
    });
  },

  handleTabDiscoveryEvent: (event): void => {
    const { chatId } = event;
    if (!chatId) return;

    if (event.discovery === null) {
      // Loading state — add chatId to the loading set.
      const next = new Set(get().tabDiscoveryLoading);
      next.add(chatId);
      set({ tabDiscoveryLoading: next });
      return;
    }

    // Discovery complete — update the tab's discovery and clear loading.
    const { discovery } = event;
    const nextLoading = new Set(get().tabDiscoveryLoading);
    nextLoading.delete(chatId);

    const wtKey = `${event.projectId}/${event.worktreeId}`;

    set((state) => {
      const wc = state.worktreeChats[wtKey];
      if (!wc) {
        return { tabDiscoveryLoading: nextLoading };
      }

      const updatedTabs = wc.tabs.map((t) =>
        t.id === chatId ? { ...t, discovery } : t,
      );
      const updated = { ...wc, tabs: updatedTabs };
      return {
        worktreeChats: { ...state.worktreeChats, [wtKey]: updated },
        tabDiscoveryLoading: nextLoading,
      };
    });
  },

  retriggerTabDiscovery: (
    projectId,
    worktreeId,
    chatId,
    pluginSelections,
    providerType,
    selectedRepoId,
  ): void => {
    requestTabDiscovery({
      projectId,
      worktreeId,
      chatId,
      pluginSelections,
      providerType,
      selectedRepoId,
    });
  },

  refreshWorktreeTabDiscoveries: (projectId, worktreeId): void => {
    const key = `${projectId}/${worktreeId}`;
    const wc = get().worktreeChats[key];
    if (!wc) {
      return;
    }

    const defaultPluginSelections = getDefaultPlugins(
      projectId,
      worktreeId,
      get().worktreeDefaultPlugins,
    );

    for (const tab of wc.tabs) {
      requestDiscoveryForChatTab({
        projectId,
        worktreeId,
        tab,
        defaultPluginSelections,
      });
    }
  },

  queueWorktreeTabDiscoveryRefresh: (projectId, worktreeId): void => {
    enqueueWorktreeTabDiscoveryRefresh(projectId, worktreeId);
  },

  syncEmptyChatPluginSelections: async (
    projectId,
    worktreeId,
    selections,
    options,
  ): Promise<void> => {
    const key = `${projectId}/${worktreeId}`;
    const wc = get().worktreeChats[key];
    if (!wc) return;

    // Inheriting chats pick project defaults up live; only their discovery
    // needs to catch up with the new defaults.
    if (chatSurfaceUsesGlobalPluginDefaults(projectId)) {
      get().queueWorktreeTabDiscoveryRefresh(projectId, worktreeId);
      return;
    }

    const activeTab = wc.tabs.find((tab) => tab.id === wc.activeTabId);
    if (!activeTab || activeTab.messages.length > 0) return;
    if (activeTab.kind === 'file') return;
    if (
      options?.repoId !== undefined &&
      activeTab.selectedRepoId !== options.repoId
    ) {
      return;
    }

    const providerType = resolveDiscoveryProviderType(activeTab);
    const nextSelections = withRequiredPluginSelectionsForTarget(
      projectId,
      worktreeId,
      sanitizePluginSelectionsWithCachedSupport(
        structuredClone(selections),
        providerType,
      ),
    );
    if (!nextSelections) return;
    try {
      await chatBackendFor({ projectId }).chat.updatePlugins({
        projectId,
        worktreeId,
        chatId: activeTab.id,
        pluginSelections: nextSelections,
      });
    } catch (error: unknown) {
      // An authority that serves no plugin selections keeps the tab's.
      if (isCapabilityUnavailable(error)) return;
      throw error;
    }
    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;

      const currentActiveTab = currentWc.tabs.find(
        (tab) => tab.id === currentWc.activeTabId,
      );
      if (
        !currentActiveTab ||
        currentActiveTab.messages.length > 0 ||
        currentActiveTab.kind === 'file'
      ) {
        return state;
      }
      if (
        options?.repoId !== undefined &&
        currentActiveTab.selectedRepoId !== options.repoId
      ) {
        return state;
      }

      const updatedTabs = currentWc.tabs.map((tab) =>
        tab.id === currentWc.activeTabId
          ? { ...tab, pluginSelections: nextSelections }
          : tab,
      );
      const updated = { ...currentWc, tabs: updatedTabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });

    requestTabDiscovery({
      projectId,
      worktreeId,
      chatId: activeTab.id,
      pluginSelections: nextSelections,
      providerType,
      selectedRepoId: activeTab.selectedRepoId,
    });
    scheduleEmptyTabPluginSelectionSanitization({
      projectId,
      worktreeId,
      chatId: activeTab.id,
      providerType,
    });
  },

  syncActiveEmptyTabToDefaults: async (): Promise<void> => {
    const modelDefaults = await get().ensureModelDefaultsLoaded();
    const sel = get().selectedWorktree;
    if (!sel) return;

    const key = worktreeKey(sel);
    const wc = get().worktreeChats[key];
    if (!wc) return;

    const activeTab = wc.tabs.find((t) => t.id === wc.activeTabId);
    if (!activeTab || activeTab.messages.length > 0) return;

    // File tabs are inert for chat-side state — never auto-rewrite their
    // model / providerType / thinkingLevel and never trigger command discovery
    // for them.
    if (activeTab.kind === 'file') return;

    // PRISTINE GATE.
    //
    // `messages.length === 0` alone used to be the whole test, which was safe
    // only while the default was a fixed constant — re-stamping a tab with the
    // same value it already had is a no-op. Now that the default tracks live
    // billing-lane availability, this function re-runs every time an auth probe
    // or the credits read settles, and each of those runs is a chance to
    // overwrite a model the user chose seconds earlier. Every condition below
    // is a distinct way a tab stops being ours to rewrite:
    //
    //  - an explicit pick (`modelExplicitlyChosen`) is never silently reverted;
    //  - a tab no longer holding the model WE stamped was changed by something
    //    else, so we do not know what we would be clobbering;
    //  - queued messages / a non-idle status / a composer draft all mean a turn
    //    is already in flight or being composed against this model;
    //  - an explicit billing toggle pins the lane, so re-resolving it is wrong.
    //
    // Neither a Claude Code terminal tab NOR an explicit model/billing pick is
    // in this list: all three belong to the model-re-stamp half of the split
    // gate below.
    //
    // `createEmptyTab` writes `interfaceMode: 'claude-code'` on every fresh
    // Claude tab whenever the user's default chat interface is the managed
    // terminal, so those tabs are BORN matching it — bailing wholesale here
    // would exclude that entire population from `interfaceMode` reconciliation
    // forever, and drop the `delete nextTab.interfaceMode` correction (default
    // flipped back to `canopy`, or the tab's model became terminal-ineligible)
    // that this function performed for every empty tab before CAN-1929.
    //
    // The same argument applies to an explicit pick. An empty Claude Code tab
    // created through a REAL model choice sets `modelExplicitlyChosen`, and
    // returning here left it stuck on `interfaceMode: 'claude-code'` after the
    // default interface flipped back to Canopy. "Do not re-stamp the model" and
    // "do not reconcile the interface" are different statements; only
    // conversation/in-flight conditions justify the second.
    //
    // `billingExplicitlyChosen` is the ONLY billing condition, deliberately —
    // never the raw `aiCreditsRouting` / `subscriptionBillingOverride` bits.
    // Lane resolution now SEEDS those bits (`billingSeedFields`), so gating on
    // them would freeze every credits-lane tab at its first, possibly
    // provisional, answer: the seed writes `aiCreditsRouting`, the next pass
    // reads it back as "the user chose this", and the cold→warm re-stamp this
    // function exists for never runs again. `selectBillingFramework` sets
    // `billingExplicitlyChosen` on every deliberate toggle, so a real user
    // choice is still pinned — and `resolveBillingSeed`'s remembered
    // `lastChatBillingFramework` no longer masquerades as one.
    //
    // Note the deliberate use of `chatTabHasConversationContent` rather than
    // the bare `messages.length` above: a tab holding only queued messages
    // reads as empty by the old test and was being rewritten.
    //
    // The composer-draft condition is checked further down, once we know
    // whether the model is ours: see `draftPinsTab`.
    if (
      activeTab.queuedMessages.length > 0 ||
      activeTab.status !== 'idle' ||
      chatTabHasConversationContent(activeTab)
    ) {
      return;
    }

    // IS THE MODEL ON THIS TAB OURS TO REWRITE?
    //
    // Only when we stamped it AND it still matches. Two kinds of tab fail that:
    //
    //  - one whose model was changed by something other than this resolver, so
    //    we do not know what we would be clobbering; and
    //  - one persisted BEFORE `defaultStampModel` existed. That case is
    //    indistinguishable from a legacy manual pick, because
    //    `modelExplicitlyChosen` ships in the SAME change as the stamp and so
    //    was never written for those tabs either.
    //
    // Rewriting either would silently discard a choice we cannot see, so the
    // model, provider, thinking level and billing seed are all left alone.
    //
    // The Claude-terminal `interfaceMode` reconciliation still runs for them,
    // which is why this is a split gate rather than an early return: that
    // reconciliation is keyed on the model the tab ALREADY holds, not on a
    // newly resolved default, so it cannot change what the user picked — and
    // this function performed it for every empty tab before CAN-1929. Bailing
    // out wholesale here would silently drop that behavior for every
    // pre-existing install, permanently.
    //
    // A tab with NO model at all is always ours: it cannot be hiding a user
    // choice. `createEmptyTab` derives `defaultStampModel` from `model`, so a
    // tab built while `modelDefaults` was still unloaded (the
    // `applyFallbackWorktreeChatState` / `createNewChat` hydration-failure
    // paths) has neither field — and that is precisely the tab this function
    // existed to repair before CAN-1929. Excluding it would leave the chat with
    // no model indefinitely.
    //
    // An explicit model pick and an explicit billing toggle are excluded HERE
    // rather than above because each pins what this function may REWRITE, while
    // neither pins the `interfaceMode` reconciliation below — that is keyed on
    // the model the tab ALREADY holds and so cannot change anything the user
    // picked.
    //
    // `interfaceMode !== 'claude-code'` is a DIFFERENT kind of exclusion, and
    // deliberately conservative rather than a user pin. Unlike the other two it
    // is not a per-tab choice at all: `createEmptyTab` copies the GLOBAL
    // `defaultChatInterfaceMode` onto every Claude-eligible new tab, so a user
    // whose default interface is the managed terminal has this set on their
    // whole population without ever deciding it per chat.
    //
    // KNOWN LIMITATION (CAN-1929): that population therefore never receives the
    // cold→warm lane correction. If such a user's Claude lane is later confirmed
    // dead, the tab keeps a dead-end Claude model instead of being re-stamped
    // onto credits. Re-stamping it is NOT a silent improvement — the managed
    // terminal harness cannot run a gateway model, so the tab would also have to
    // be dropped out of terminal mode, visibly changing the chat surface the
    // user configured. That trade is a product decision, so this stays
    // conservative until it is made rather than switching surfaces silently.
    const modelIsOurs =
      activeTab.modelExplicitlyChosen !== true &&
      activeTab.billingExplicitlyChosen !== true &&
      activeTab.interfaceMode !== 'claude-code' &&
      (activeTab.model === undefined ||
        (activeTab.defaultStampModel !== undefined &&
          activeTab.model === activeTab.defaultStampModel));

    // `modelConfig` is taken alongside the model because MODELCONFIG WINS AT
    // DISPATCH. `resolveProviderModelConfig` resolves
    // `selectedConfig?.thinkingLevel ?? selection.thinkingLevel`, and the send
    // path forwards both fields — so re-stamping the model and `thinkingLevel`
    // while leaving a stale `modelConfig` behind made the composer show one
    // thinking level and the turn run another (a tab seeded on Claude at `max`,
    // re-stamped onto a gateway model capped at `medium`, still dispatched
    // `max`). Stale `fastMode` rode along the same way.
    const resolvedTabDefaults: ReturnType<typeof resolveTabDefaults> =
      modelIsOurs ? resolveTabDefaults(sel.projectId, modelDefaults) : {};
    const defaultModel = resolvedTabDefaults.model;

    // Only the shipped Advisor default may follow settled lane facts under
    // an early draft. This also covers late native credentials and sign-in;
    // explicit picks/preferences and all other surfaces keep the draft pin.
    const advisorLane =
      sel.projectId === APP_ADVISOR_PROJECT_ID
        ? resolveLaneForTarget(sel.projectId, modelDefaults)
        : undefined;
    const draftPinsTab =
      get().composerTextPresent[activeTab.id] === true &&
      !(
        modelIsOurs &&
        (modelDefaults?.appAdvisorModel ?? DEFAULT_APP_ADVISOR_MODEL) ===
          DEFAULT_APP_ADVISOR_MODEL &&
        advisorLane?.outcome === 'resolved' &&
        !advisorLane.provisional &&
        defaultModel !== undefined &&
        defaultModel !== activeTab.model
      );
    if (draftPinsTab) return;

    const defaultThinking = resolvedTabDefaults.thinkingLevel;
    const defaultModelConfigRaw = resolvedTabDefaults.modelConfig;
    const nextModel = defaultModel ?? activeTab.model;
    // Derived only when the model is ours, so the equality check below and the
    // write further down agree. When they disagreed, a legacy tab whose
    // persisted `providerType` did not match `getProviderForModel(model)` could
    // never reach the early return: the check saw a difference the write was
    // gated out of applying, so every sync re-entered `set()` and queued
    // another legacy snapshot write
    // and fired a discovery request carrying a provider the tab did not hold.
    const nextProviderType =
      modelIsOurs && nextModel
        ? getProviderForModel(nextModel)
        : activeTab.providerType;
    // Persisted defaults can outlive their registry entry. Keep the current
    // usable tab intact until registry initialization or an explicit picker
    // choice supplies a provider; never reinterpret the stale id as Claude.
    if (modelIsOurs && nextModel && !nextProviderType) return;
    const nextThinking = modelIsOurs
      ? nextProviderType
        ? normalizeThinkingForProvider(
            defaultThinking ?? activeTab.thinkingLevel,
            nextProviderType,
          )
        : (defaultThinking ?? activeTab.thinkingLevel)
      : activeTab.thinkingLevel;
    const defaultInterfaceMode = resolvePersistedDefaultChatInterfaceMode(
      sel.projectId,
      modelDefaults,
    );
    const nextInterfaceMode =
      isClaudeTerminalEligibleChatTab({
        model: nextModel,
        providerType: nextProviderType,
      }) && defaultInterfaceMode !== undefined
        ? defaultInterfaceMode
        : undefined;

    // Re-seed billing alongside the model: on the credits lane the two are one
    // decision, and leaving stale routing bits behind would bill the next turn
    // against a lane this tab is no longer on. Skipped entirely when the model
    // is not ours — billing follows the model, so re-seeding it for a tab we
    // are deliberately not re-modelling would move a lane nobody chose to move.
    const nextBillingFields = modelIsOurs
      ? billingSeedFields(resolveBillingSeed(modelDefaults, sel.projectId))
      : undefined;
    // Compare VALUES, not field presence. A tab holding
    // `aiCreditsRouting: { active: false }` is present-but-inactive, so a
    // presence test called it unchanged and the re-stamp never repaired it to
    // the active credits state its resolved lane requires — leaving the tab on
    // a lane it cannot pay for.
    const billingUnchanged =
      nextBillingFields === undefined ||
      ((activeTab.aiCreditsRouting?.active === true) ===
        'aiCreditsRouting' in nextBillingFields &&
        (activeTab.subscriptionBillingOverride === true) ===
          'subscriptionBillingOverride' in nextBillingFields);

    // Resolved through the same helper `createEmptyTab` uses, so the re-stamped
    // config is a real `ResolvedAgentModelConfig` clamped to the NEW model's
    // provider rather than the loose preference shape.
    //
    // The write below applies `modelConfig`, so the check must see it too —
    // otherwise a tab whose ONLY staleness is its `modelConfig` matches every
    // other field, returns early, and is never repaired. That is the exact
    // shape of the composer/dispatch thinking-level split this carries.
    //
    // An EXPLICIT Codex speed is preserved. `modelIsOurs` guards the MODEL,
    // and `setSpeed` (like the legacy `setFastMode` adapter) deliberately does
    // not set `modelExplicitlyChosen` (only `setModelAndWait` does) — it sets
    // `fastModeExplicit`. So rebuilding this purely from global defaults
    // silently reverted a speed the user had just chosen, and because
    // `toPersistedTab` writes `modelConfig.speed` whenever `fastModeExplicit`
    // is set, the revert was written to disk. Before the `modelConfig` carry
    // existed the write never touched this field, so the choice survived;
    // preserving it here keeps that guarantee.
    const resolvedNextModelConfig =
      modelIsOurs && nextModel
        ? resolveProviderModelConfig(
            nextProviderType ?? 'claude',
            {
              ...(nextThinking ? { thinkingLevel: nextThinking } : {}),
              ...(defaultModelConfigRaw
                ? { modelConfig: defaultModelConfigRaw }
                : {}),
            },
            undefined,
          )
        : undefined;
    const nextModelConfig = resolvedNextModelConfig
      ? {
          ...resolvedNextModelConfig,
          // Codex speed: `setSpeed` latches `fastModeExplicit`, so an explicit
          // choice is identifiable and preserved outright — as the exact speed
          // with its derived boolean, wherever the re-stamped provider runs a
          // Codex speed (other providers always resolve to Regular).
          ...(activeTab.fastModeExplicit &&
          modelConfigForProviderSupportsFastMode(nextProviderType ?? 'claude')
            ? codexSpeedFields(tabRequestedCodexSpeed(activeTab))
            : {}),
          // Thinking level: `setThinkingLevel` latches NOTHING — unlike
          // `setModelAndWait` and `setFastMode` — so a tab whose only user edit
          // is the level still reads as "ours" and there is no flag to test.
          //
          // Before `modelConfig` was carried here at all, the write touched
          // `tab.thinkingLevel` but never `tab.modelConfig`, and `modelConfig`
          // is what dispatch reads — so the user's level survived where it
          // mattered. Rebuilding the config from global defaults silently took
          // that away on both the composer and the dispatch side, and this sync
          // now runs on every lane-fact settle rather than only on discovery
          // events. Carrying the tab's level forward restores the prior
          // guarantee.
          //
          // Routed through `clampThinkingLevelForModel` rather than copied raw:
          // a re-stamp can move the tab to a model that does not support the
          // old level, and an unclamped carry would dispatch an unsupported one.
          ...(activeTab.modelConfig?.thinkingLevel && nextModel
            ? {
                thinkingLevel: clampThinkingLevelForModel(
                  activeTab.modelConfig.thinkingLevel,
                  nextModel,
                ),
              }
            : {}),
        }
      : resolvedNextModelConfig;
    const modelConfigUnchanged =
      nextModelConfig === undefined ||
      JSON.stringify(activeTab.modelConfig ?? null) ===
        JSON.stringify(nextModelConfig);

    if (
      activeTab.model === nextModel &&
      activeTab.providerType === nextProviderType &&
      activeTab.thinkingLevel === nextThinking &&
      billingUnchanged &&
      modelConfigUnchanged &&
      (activeTab.interfaceMode ?? 'canopy') === (nextInterfaceMode ?? 'canopy')
    ) {
      return;
    }

    set((state) => {
      const currentWc = state.worktreeChats[key];
      if (!currentWc) return state;
      const updatedTabs = currentWc.tabs.map((tab) => {
        if (tab.id !== currentWc.activeTabId) {
          return tab;
        }
        const nextTab: ChatTab = {
          ...tab,
          thinkingLevel: nextThinking,
          ...(modelIsOurs && nextModel
            ? {
                model: nextModel,
                // Re-arm the stamp so the NEXT pass can still tell our own
                // default from a user edit.
                defaultStampModel: nextModel,
                // Carried with the model, never left stale — see above: this
                // is what dispatch actually reads.
                ...(nextModelConfig ? { modelConfig: nextModelConfig } : {}),
                ...(nextProviderType ? { providerType: nextProviderType } : {}),
              }
            : {}),
        };
        if (nextBillingFields) {
          delete nextTab.aiCreditsRouting;
          delete nextTab.subscriptionBillingOverride;
          Object.assign(nextTab, nextBillingFields);
        }
        const persistedInterfaceMode = isClaudeTerminalEligibleChatTab({
          model: nextModel,
          providerType: nextProviderType,
        })
          ? getPersistedClaudeChatInterfaceMode(nextInterfaceMode)
          : undefined;
        if (persistedInterfaceMode) {
          nextTab.interfaceMode = persistedInterfaceMode;
        } else {
          delete nextTab.interfaceMode;
        }
        return nextTab;
      });
      const updated = { ...currentWc, tabs: updatedTabs };
      return {
        worktreeChats: { ...state.worktreeChats, [key]: updated },
      };
    });

    requestTabDiscovery({
      projectId: sel.projectId,
      worktreeId: sel.worktreeId,
      chatId: activeTab.id,
      pluginSelections: activeTab.pluginSelections,
      providerType: nextProviderType,
    });
  },

  setPluginSelections: (
    selections: ChatTabPluginSelections,
    target,
    deferredToolsAllowed,
    options,
  ): ChatTabPluginSelections | undefined => {
    const context = getWorktreeChatContext(get(), target);
    if (!context) return undefined;
    const { selection: sel, chatId, activeTab, worktreeChat: wc } = context;
    if (activeTab?.kind === 'file') return undefined;
    const effectiveSelections = withRequiredPluginSelectionsForTarget(
      sel.projectId,
      sel.worktreeId,
      selections,
    );
    if (!effectiveSelections) return undefined;

    set((state) =>
      updateCapturedChatTab(state, context, (t) => {
        const next = {
          ...t,
          pluginSelections: effectiveSelections,
          ...(typeof deferredToolsAllowed === 'boolean'
            ? { deferredToolsAllowed }
            : {}),
          ...(options?.sdkSessionId
            ? { sdkSessionId: options.sdkSessionId }
            : {}),
        };
        if (options?.disabledGlobalPluginSelections !== undefined) {
          if (hasAnyTombstones(options.disabledGlobalPluginSelections)) {
            next.disabledGlobalPluginSelections =
              options.disabledGlobalPluginSelections;
          } else {
            delete next.disabledGlobalPluginSelections;
          }
        }
        return next;
      }),
    );

    // Destroy the active session (if any) so the next message creates
    // a new one with the updated plugin selections, then re-run
    // command discovery. Sequenced to avoid cleanup racing with
    // freshly rebuilt discovery artifacts.
    void (async (): Promise<void> => {
      if (
        !options?.runtimeAlreadyUpdated &&
        chatSurfaceUsesGlobalPluginDefaults(sel.projectId)
      ) {
        // Keep the optimistic return/API, but persist this caller's intent
        // after any pending staging or authorization write for the same chat.
        const before = activeTab?.pluginSelections ?? {
          collectionIds: [],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        };
        const removed = subtractPluginSelections(before, effectiveSelections);
        const added = subtractPluginSelections(effectiveSelections, before);
        const destination = { ...sel, chatId };
        await queueDesktopTryItSelectionUpdate(destination, async () => {
          const live = getWorktreeChatContext(get(), destination);
          if (
            !live?.activeTab ||
            live.activeTab.kind === 'file' ||
            live.activeTab.readOnly ||
            live.activeTab.pendingInitialCreation
          )
            return;
          const nextSelections = withRequiredPluginSelectionsForTarget(
            sel.projectId,
            sel.worktreeId,
            unionPluginSelections(
              subtractPluginSelections(
                live.activeTab.pluginSelections ?? {
                  collectionIds: [],
                  skillRefs: [],
                  pluginRefs: [],
                  mcpServerRefs: [],
                },
                removed,
              ),
              added,
            ),
          );
          if (!nextSelections) return;
          await chatBackendFor(sel).chat.updatePlugins({
            projectId: sel.projectId,
            worktreeId: sel.worktreeId,
            chatId,
            pluginSelections: nextSelections,
            ...(options?.disabledGlobalPluginSelections !== undefined
              ? {
                  disabledGlobalPluginSelections:
                    options.disabledGlobalPluginSelections,
                }
              : {}),
            ...(typeof deferredToolsAllowed === 'boolean'
              ? { deferredToolsAllowed }
              : {}),
          });
          get().setPluginSelections(
            nextSelections,
            destination,
            deferredToolsAllowed,
            {
              ...options,
              runtimeAlreadyUpdated: true,
            },
          );
        });
        return;
      }

      // These special surfaces cannot receive Try it drafts. Preserve their
      // existing copy semantics instead of broadening this staging fix.
      if (!options?.runtimeAlreadyUpdated) {
        await chatBackendFor(sel).chat.updatePlugins({
          projectId: sel.projectId,
          worktreeId: sel.worktreeId,
          chatId,
          pluginSelections: effectiveSelections,
          ...(options?.disabledGlobalPluginSelections !== undefined
            ? {
                disabledGlobalPluginSelections:
                  options.disabledGlobalPluginSelections,
              }
            : {}),
          ...(typeof deferredToolsAllowed === 'boolean'
            ? { deferredToolsAllowed }
            : {}),
        });
      }

      requestTabDiscovery({
        projectId: sel.projectId,
        worktreeId: sel.worktreeId,
        chatId,
        pluginSelections: effectiveSelections,
        providerType: resolveDiscoveryProviderType(
          wc.tabs.find((t) => t.id === chatId),
        ),
      });
    })().catch(reportUnlessUnavailable);
    return effectiveSelections;
  },
});
