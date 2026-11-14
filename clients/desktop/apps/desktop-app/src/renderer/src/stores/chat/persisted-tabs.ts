import { isFileDiffContext } from '@canopy/desktop-shared/types/code-review';
// Serialization between runtime ChatTab state and persisted chat-tab shapes.
import type {
  ChatBillingFramework,
  ChatInterfaceMode,
  ChatModel,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import {
  chatTabHasConversationContent,
  emptyWorktreeChat,
  resolveTabProviderType,
} from './tab-utils';
import { persistableProvisionalFirstSendView } from './provisional-first-send';
import { hasAnyTombstones } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import {
  EXTERNAL_PROJECT_PROVIDERS,
  getProviderForModel,
  inferLegacyExecutionHarness,
  hasAnySelections,
  normalizeAgentModelConfig,
  normalizePersistedThinkingLevel,
  resolveKnownModel,
  resolveProviderModelConfig,
  type AgentModelConfig,
  type AgentProviderType,
  type ChatTabsFile,
  type ExternalProjectProvider,
  type FileTabViewMode,
  type PersistedChatMessage,
  type PersistedChatTab,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import {
  deriveCurrentTaskTodosFromMessages,
  deriveCurrentTodosFromMessages,
} from '@/lib/transcript-parser';
import { sanitizePersistedChatMessages } from '@/lib/chatMessageSanitization';
import { normalizePersistedUsage } from '@/lib/chatUsageNormalization';
import { isClaudeTerminalEligibleChatTab } from '@/lib/chat-provider';
import { isGatewayOnlyModel } from '@canopy/execution-engine/lib/gateway-model-availability';
import { normalizePluginSelections } from '@canopy/execution-engine/lib/plugin-selections-normalization';
import { normalizeAgentArtifactCarryByTurn } from '@canopy/desktop-shared/lib/agent-artifacts';
import { readCodexSpeedRecord } from '@canopy/execution-engine/lib/codex-speed';
import {
  persistedRowExtensionFields,
  readLegacyUsageLimitBannerFields,
} from '@/lib/chatTabPersistence';
import {
  codexSpeedFields,
  retainedCodexSpeedFields,
  tabRequestedCodexSpeed,
  withoutCodexSpeed,
} from './codex-speed';
import { toPersistedPendingQuestions } from './pending-questions';
import { toPersistedPendingApprovals } from './pending-approvals';
import type { ApprovalRequestEvent } from '@canopy/desktop-shared/types';
import {
  normalizeMemoryByMessageId,
  readPersistedMemoryByMessageId,
} from './memory';
import { normalizePendingClaudeTerminalWatcherMessages } from './pendingClaudeTerminalWatchers';
import type {
  ChatMessage,
  ChatTab,
  PendingQuestion,
  WorktreeChatState,
} from './types';
import {
  isApprovalMode,
  normalizeApprovalRules,
} from '@canopy/desktop-shared/lib/approval-engine';
import { parseAgentSentInfo } from '@canopy/protocol/portal/external-agent-sender';

/** A persisted `importedFrom` is kept only when it names a known import source. */
function isExternalProjectProvider(
  value: unknown,
): value is ExternalProjectProvider {
  return EXTERNAL_PROJECT_PROVIDERS.some((provider) => provider === value);
}

export function isFileTabViewMode(value: unknown): value is FileTabViewMode {
  return (
    value === 'raw' ||
    value === 'preview' ||
    value === 'table' ||
    value === 'diff'
  );
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

export function toPersistedMessage(msg: ChatMessage): PersistedChatMessage {
  const agentSent =
    msg.role === 'user'
      ? (parseAgentSentInfo(msg.agentSent) ?? undefined)
      : undefined;
  return {
    ...persistedRowExtensionFields(msg),
    id: msg.id,
    role: msg.role,
    ...(msg.hidden ? { hidden: true } : {}),
    // A prompt deleted from a cloud chat's queue reads Cancelled (CAN-6689).
    ...(msg.cancelled ? { cancelled: true } : {}),
    blocks: msg.blocks,
    timestamp: msg.timestamp,
    ...(msg.parentToolUseId ? { parentToolUseId: msg.parentToolUseId } : {}),
    ...(msg.parentBlockId ? { parentBlockId: msg.parentBlockId } : {}),
    ...(msg.codexThreadId ? { codexThreadId: msg.codexThreadId } : {}),
    ...(msg.codexTurnId ? { codexTurnId: msg.codexTurnId } : {}),
    ...(msg.attachmentPaths?.length
      ? { attachmentPaths: msg.attachmentPaths }
      : {}),
    ...(msg.attachmentPromptContexts?.length
      ? { attachmentPromptContexts: msg.attachmentPromptContexts }
      : {}),
    ...(msg.inputMode ? { inputMode: msg.inputMode } : {}),
    ...(msg.watcherFired ? { watcherFired: msg.watcherFired } : {}),
    ...(msg.userMessageSource
      ? { userMessageSource: msg.userMessageSource }
      : {}),
    ...(msg.autoResume ? { autoResume: msg.autoResume } : {}),
    ...(agentSent ? { agentSent } : {}),
    // Load-bearing both ways: this projection also runs on the way IN from
    // main (`fromPersistedTab`), so dropping the Claude chain uuid here would
    // leave a forked tab unable to resolve its point-in-time resume anchor on
    // the very send that needs it.
    ...(msg.claudeUuid ? { claudeUuid: msg.claudeUuid } : {}),
  };
}

export function toPersistedTab(tab: ChatTab): PersistedChatTab {
  const normalizedPluginSelections = tab.pluginSelections
    ? normalizePluginSelections(tab.pluginSelections)
    : undefined;
  const shouldPersistPluginSelections =
    normalizedPluginSelections !== undefined &&
    hasAnySelections(normalizedPluginSelections);
  const userMessageIds = new Set(
    tab.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
  );
  const persistedMemory = normalizeMemoryByMessageId(
    tab.memoryByMessageId,
    tab.transcript ? undefined : userMessageIds,
  );
  const artifactCarry = normalizeAgentArtifactCarryByTurn(
    tab.agentArtifactCarryByTurn,
    tab.transcript ? undefined : userMessageIds,
  );
  // An explicit speed is written in canonical form: the exact speed with its
  // derived boolean, re-derived here so a stale runtime boolean can never
  // persist `fastMode: true` beside Ultra fast.
  const persistedModelConfig: AgentModelConfig = tab.fastModeExplicit
    ? codexSpeedFields(tabRequestedCodexSpeed(tab))
    : {};
  if (tab.thinkingLevel !== 'high') {
    persistedModelConfig.thinkingLevel = tab.thinkingLevel;
  }
  const hasModelConfig = Object.keys(persistedModelConfig).length > 0;
  const pendingClaudeTerminalWatcherMessages =
    normalizePendingClaudeTerminalWatcherMessages(
      tab.pendingClaudeTerminalWatcherMessages,
    );

  // A Home first send that has not dispatched yet is presentation only.
  const persistable = persistableProvisionalFirstSendView(tab);

  return {
    id: tab.id,
    title: persistable.title,
    ...(tab.kind === 'file' ? { kind: tab.kind } : {}),
    ...(tab.filePath ? { filePath: tab.filePath } : {}),
    ...(tab.fileViewMode ? { fileViewMode: tab.fileViewMode } : {}),
    ...(tab.fileDiffContext ? { fileDiffContext: tab.fileDiffContext } : {}),
    ...(tab.pinned ? { pinned: true } : {}),
    ...(tab.customTitle ? { customTitle: tab.customTitle } : {}),
    ...(persistable.automaticTitleState
      ? { automaticTitleState: persistable.automaticTitleState }
      : {}),
    ...(tab.description ? { description: tab.description } : {}),
    messages: sanitizePersistedChatMessages(persistable.messages).map(
      toPersistedMessage,
    ),
    ...(persistedMemory ? { memoryByMessageId: persistedMemory } : {}),
    ...(artifactCarry ? { agentArtifactCarryByTurn: artifactCarry } : {}),
    ...(tab.inputDelivery ? { inputDelivery: tab.inputDelivery } : {}),
    createdAt: tab.createdAt,
    ...(tab.planMode ? { planMode: true } : {}),
    ...(tab.approvalMode ? { approvalMode: tab.approvalMode } : {}),
    ...(tab.sessionApprovalRules?.length
      ? { sessionApprovalRules: tab.sessionApprovalRules }
      : {}),
    ...(tab.thinkingLevel !== 'high'
      ? { thinkingLevel: tab.thinkingLevel }
      : {}),
    ...(hasModelConfig ? { modelConfig: persistedModelConfig } : {}),
    // Main-owned; mirrored so a compatibility snapshot never erases it.
    ...retainedCodexSpeedFields(tab.retainedCodexSpeed),
    ...(tab.model ? { model: tab.model } : {}),
    // CAN-1929 pristine-gate inputs. These MUST survive a reload: lane-aware
    // defaults re-stamp any tab that still looks like ours, and both signals
    // that say "this one is not ours" live only in these fields. Dropping them
    // here means every restart hands the resolver a clean slate and it reverts
    // the model (and the billing framework) the user deliberately picked.
    ...(tab.modelExplicitlyChosen ? { modelExplicitlyChosen: true } : {}),
    ...(tab.billingExplicitlyChosen ? { billingExplicitlyChosen: true } : {}),
    ...(tab.defaultStampModel
      ? { defaultStampModel: tab.defaultStampModel }
      : {}),
    ...(tab.autoArchive === true ? { autoArchive: true } : {}),
    ...(tab.providerType ? { providerType: tab.providerType } : {}),
    ...((chatTabHasConversationContent(tab) ||
      tab.executionHarnessExplicitlyChosen === true) &&
    tab.executionHarness
      ? { executionHarness: tab.executionHarness }
      : {}),
    ...(tab.executionHarnessExplicitlyChosen === true
      ? { executionHarnessExplicitlyChosen: true }
      : {}),
    ...(tab.modelSelectionMode === 'auto'
      ? { modelSelectionMode: 'auto' as const }
      : {}),
    ...(tab.autoRoutedModels ? { autoRoutedModels: tab.autoRoutedModels } : {}),
    ...(tab.turnEnds ? { turnEnds: tab.turnEnds } : {}),
    ...(tab.unacceptedTurnEnds
      ? { unacceptedTurnEnds: tab.unacceptedTurnEnds }
      : {}),
    ...(tab.unread === true ? { unread: true } : {}),
    ...(tab.unread === true && tab.unreadMarkedManually === true
      ? { unreadMarkedManually: true }
      : {}),
    ...(tab.pendingPlanExit ? { pendingPlanExit: tab.pendingPlanExit } : {}),
    ...(tab.pendingPlanExitRequestId
      ? { pendingPlanExitRequestId: tab.pendingPlanExitRequestId }
      : {}),
    ...(tab.trackedPlanId ? { trackedPlanId: tab.trackedPlanId } : {}),
    ...(tab.trackedPlanImplementation
      ? { trackedPlanImplementation: tab.trackedPlanImplementation }
      : {}),
    ...(tab.trackedPlanSource
      ? { trackedPlanSource: tab.trackedPlanSource }
      : {}),
    ...(tab.trackedPlanReviewStatus
      ? { trackedPlanReviewStatus: tab.trackedPlanReviewStatus }
      : {}),
    ...(tab.pendingSystemInstructions?.length
      ? { pendingSystemInstructions: tab.pendingSystemInstructions }
      : {}),
    ...(tab.hasOutstandingProposal ? { hasOutstandingProposal: true } : {}),
    ...(tab.latestRevisionNumber !== undefined
      ? { latestRevisionNumber: tab.latestRevisionNumber }
      : {}),
    ...(tab.proposalMode !== 'optional'
      ? { proposalMode: tab.proposalMode }
      : {}),
    ...(tab.sdkSessionId ? { sdkSessionId: tab.sdkSessionId } : {}),
    ...(tab.globalInstructionsSnapshot !== undefined
      ? { globalInstructionsSnapshot: tab.globalInstructionsSnapshot }
      : {}),
    ...(tab.codexReconstructionSeedId
      ? { codexReconstructionSeedId: tab.codexReconstructionSeedId }
      : {}),
    ...(tab.claudeForkSessionOnNextSend
      ? { claudeForkSessionOnNextSend: true }
      : {}),
    ...(tab.newChatStartedWatcherPending
      ? { newChatStartedWatcherPending: true }
      : {}),
    ...(tab.newChatStartedWatcherFiredAt
      ? { newChatStartedWatcherFiredAt: tab.newChatStartedWatcherFiredAt }
      : {}),
    ...(tab.pendingRevertAttachmentPath
      ? { pendingRevertAttachmentPath: tab.pendingRevertAttachmentPath }
      : {}),
    ...(pendingClaudeTerminalWatcherMessages?.length
      ? { pendingClaudeTerminalWatcherMessages }
      : {}),
    ...(tab.scheduledSendDraft?.runAt
      ? { scheduledSendDraft: { runAt: tab.scheduledSendDraft.runAt } }
      : {}),
    ...(tab.readOnly ? { readOnly: true } : {}),
    ...(tab.importedFrom ? { importedFrom: tab.importedFrom } : {}),
    ...(tab.staleSessionDetected
      ? { staleSessionDetected: tab.staleSessionDetected }
      : {}),
    ...(tab.llmProviderUsageLimitBanner
      ? { llmProviderUsageLimitBanner: tab.llmProviderUsageLimitBanner }
      : {}),
    ...(tab.dismissedLlmProviderUsageLimitBannerKey
      ? {
          dismissedLlmProviderUsageLimitBannerKey:
            tab.dismissedLlmProviderUsageLimitBannerKey,
        }
      : {}),
    // Banner-only metadata, persisted so the recovery banner survives a reload
    // (CAN-2413). Cleared on the next dispatched user message.
    ...(tab.aiCreditsNoBillingSource
      ? { aiCreditsNoBillingSource: tab.aiCreditsNoBillingSource }
      : {}),
    ...(tab.aiCreditsRouting ? { aiCreditsRouting: tab.aiCreditsRouting } : {}),
    ...(typeof tab.aiCreditsRouted === 'boolean'
      ? { aiCreditsRouted: tab.aiCreditsRouted }
      : {}),
    ...(tab.subscriptionBillingOverride
      ? { subscriptionBillingOverride: tab.subscriptionBillingOverride }
      : {}),
    ...(shouldPersistPluginSelections
      ? { pluginSelections: normalizedPluginSelections }
      : {}),
    ...(hasAnyTombstones(tab.disabledGlobalPluginSelections)
      ? { disabledGlobalPluginSelections: tab.disabledGlobalPluginSelections }
      : {}),
    ...(tab.inheritedPluginDefaultsVersion !== undefined
      ? { inheritedPluginDefaultsVersion: tab.inheritedPluginDefaultsVersion }
      : {}),
    ...(typeof tab.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: tab.deferredToolsAllowed }
      : {}),
    ...(tab.discovery ? { discovery: tab.discovery } : {}),
    ...(tab.usage ? { usage: tab.usage } : {}),
    ...(tab.agentUsage && Object.keys(tab.agentUsage).length > 0
      ? { agentUsage: tab.agentUsage }
      : {}),
    ...(tab.turnDiffs && Object.keys(tab.turnDiffs).length > 0
      ? { turnDiffs: tab.turnDiffs }
      : {}),
    ...(tab.turnFeedback && Object.keys(tab.turnFeedback).length > 0
      ? { turnFeedback: tab.turnFeedback }
      : {}),
    ...(tab.attentionDismissedAt !== undefined
      ? { attentionDismissedAt: tab.attentionDismissedAt }
      : {}),
    ...(tab.selectedRepoId ? { selectedRepoId: tab.selectedRepoId } : {}),
    ...(tab.adhocMigrationSource
      ? { adhocMigrationSource: tab.adhocMigrationSource }
      : {}),
    ...(tab.forkedFrom ? { forkedFrom: tab.forkedFrom } : {}),
    ...(tab.sharedRun ? { sharedRun: tab.sharedRun } : {}),
    // Persist the chosen chat-interface surface and the last-known
    // Claude Code terminal runtime snapshot so the renderer can rehydrate
    // both the toggle and idle-gating UX without round-tripping to main.
    ...(tab.interfaceMode ? { interfaceMode: tab.interfaceMode } : {}),
    ...(tab.claudeTerminal ? { claudeTerminal: tab.claudeTerminal } : {}),
  };
}

export function toPersistedTabs(
  state: WorktreeChatState,
  options?: {
    projectId: string;
    worktreeId: string;
    pendingQuestions: Record<string, PendingQuestion>;
    pendingApprovals?: Record<string, ApprovalRequestEvent>;
  },
): ChatTabsFile {
  // Strip transient hook-chat queued placeholders before serializing so a
  // projection built while the hook is queued never carries an empty
  // placeholder tab.
  const persistableTabs = state.tabs.filter(
    (tab) => tab.queuedHookPlaceholder !== true,
  );
  // If the current `activeTabId` points at a stripped placeholder, fall back
  // to the last remaining real tab id (or empty string when none survive).
  // Mirrors the `rollbackHookChatTab` activeTabId fallback in main and keeps
  // the persisted activeTabId from referencing a tab that no longer exists
  // on disk.
  const persistedActiveTabId = persistableTabs.some(
    (tab) => tab.id === state.activeTabId,
  )
    ? state.activeTabId
    : (persistableTabs[persistableTabs.length - 1]?.id ?? '');

  const tabs: PersistedChatTab[] = persistableTabs.map(toPersistedTab);
  const pendingQuestions = options
    ? toPersistedPendingQuestions(
        options.projectId,
        options.worktreeId,
        { ...state, tabs: persistableTabs },
        options.pendingQuestions,
      )
    : undefined;
  const pendingApprovals = options
    ? toPersistedPendingApprovals(
        options.projectId,
        options.worktreeId,
        { ...state, tabs: persistableTabs },
        options.pendingApprovals ?? {},
      )
    : undefined;

  return {
    version: 1,
    tabs,
    activeTabId: persistedActiveTabId,
    ...(state.lastActiveEditableChatId &&
    persistableTabs.some(
      (tab) =>
        tab.id === state.lastActiveEditableChatId &&
        tab.kind !== 'file' &&
        !tab.readOnly,
    )
      ? { lastActiveEditableChatId: state.lastActiveEditableChatId }
      : {}),
    ...(state.lastActiveChatProvider
      ? { lastActiveChatProvider: state.lastActiveChatProvider }
      : {}),
    ...(pendingQuestions ? { pendingQuestions } : {}),
    ...(pendingApprovals ? { pendingApprovals } : {}),
  };
}

export interface PersistedTabsChangedEntry {
  tab: ChatTab;
  persisted: PersistedChatTab;
}

export interface PersistedTabsDelta {
  file: ChatTabsFile;
  /**
   * Tabs whose persisted payload was rebuilt this call (cache misses), paired
   * with their runtime tab objects. The caller commits these into its cache
   * only AFTER a successful save — committing eagerly would mark the tabs
   * clean even when the save failed, silently dropping the change from every
   * subsequent incremental save.
   */
  changedEntries: PersistedTabsChangedEntry[];
  /** Ids present in `previousTabIds` but absent from the current file. */
  removedTabIds: string[];
}

/**
 * Delta-aware variant of {@link toPersistedTabs}. Tab objects are updated
 * immutably in the chat store (unchanged tabs keep referential identity across
 * `set()` calls), so a WeakMap keyed by the runtime tab object memoizes each
 * tab's persisted payload: only tabs that actually changed since the last save
 * are re-serialized, and exactly those are reported as `changedEntries` for
 * the incremental IPC save path. Large idle transcripts therefore cost
 * nothing on the streaming-save hot path. The cache is read-only here.
 */
export function toPersistedTabsWithCache(
  state: WorktreeChatState,
  options: {
    projectId: string;
    worktreeId: string;
    pendingQuestions: Record<string, PendingQuestion>;
    pendingApprovals?: Record<string, ApprovalRequestEvent>;
  },
  cache: WeakMap<ChatTab, PersistedChatTab>,
  previousTabIds: ReadonlySet<string>,
): PersistedTabsDelta {
  // Mirrors toPersistedTabs: strip transient hook-chat queued placeholders and
  // keep the persisted activeTabId pointing at a surviving tab.
  const persistableTabs = state.tabs.filter(
    (tab) => tab.queuedHookPlaceholder !== true,
  );
  const persistedActiveTabId = persistableTabs.some(
    (tab) => tab.id === state.activeTabId,
  )
    ? state.activeTabId
    : (persistableTabs[persistableTabs.length - 1]?.id ?? '');

  const changedEntries: PersistedTabsChangedEntry[] = [];
  const tabs: PersistedChatTab[] = persistableTabs.map((tab) => {
    const cached = cache.get(tab);
    if (cached) {
      return cached;
    }
    const persisted = toPersistedTab(tab);
    changedEntries.push({ tab, persisted });
    return persisted;
  });

  const currentTabIds = new Set(tabs.map((tab) => tab.id));
  const removedTabIds = Array.from(previousTabIds).filter(
    (id) => !currentTabIds.has(id),
  );

  const pendingQuestions = toPersistedPendingQuestions(
    options.projectId,
    options.worktreeId,
    { ...state, tabs: persistableTabs },
    options.pendingQuestions,
  );
  const pendingApprovals = toPersistedPendingApprovals(
    options.projectId,
    options.worktreeId,
    { ...state, tabs: persistableTabs },
    options.pendingApprovals ?? {},
  );

  return {
    file: {
      version: 1,
      tabs,
      activeTabId: persistedActiveTabId,
      ...(state.lastActiveEditableChatId &&
      persistableTabs.some(
        (tab) =>
          tab.id === state.lastActiveEditableChatId &&
          tab.kind !== 'file' &&
          !tab.readOnly,
      )
        ? { lastActiveEditableChatId: state.lastActiveEditableChatId }
        : {}),
      ...(state.lastActiveChatProvider
        ? { lastActiveChatProvider: state.lastActiveChatProvider }
        : {}),
      ...(pendingQuestions ? { pendingQuestions } : {}),
      ...(pendingApprovals ? { pendingApprovals } : {}),
    },
    changedEntries,
    removedTabIds,
  };
}

export function fromPersistedTab(
  pt: PersistedChatTab,
  defaults?: { modelConfig?: AgentModelConfig; thinkingLevel?: ThinkingLevel },
): ChatTab {
  const validModel = pt.model ? resolveKnownModel(pt.model) : undefined;
  // Preserve an unresolved persisted id (custom Agent overlays that load after
  // hydrate, and flag-gated models registered only once LaunchDarkly returns
  // live flags) instead of dropping it to the provider default. Display falls
  // back to the raw id and send-time `resolveKnownModel` gating still protects
  // the agent invocation.
  const hydratedModel = validModel ?? pt.model;
  // Resolved exactly like `model` above, so the CAN-1929 pristine check
  // (`tab.model === tab.defaultStampModel`) still compares like for like after
  // a reload instead of tripping on one side being an unresolved alias.
  const hydratedDefaultStampModel = pt.defaultStampModel
    ? (resolveKnownModel(pt.defaultStampModel) ?? pt.defaultStampModel)
    : undefined;
  const aiCreditsRouted =
    pt.aiCreditsRouted ??
    (pt.aiCreditsRouting?.active === true ||
      (validModel !== undefined && isGatewayOnlyModel(validModel)));
  const usage = normalizePersistedUsage(
    pt.usage,
    validModel,
    aiCreditsRouted,
    pt.executionHarness ??
      (pt.providerType === 'opencode' ? 'opencode' : undefined),
  );
  const messages = sanitizePersistedChatMessages(pt.messages).map(
    toPersistedMessage,
  );
  const userMessageIds = new Set(
    messages
      .filter((message) => message.role === 'user')
      .map((message) => message.id),
  );
  const persistedMemory = readPersistedMemoryByMessageId(
    pt,
    pt.transcript ? undefined : userMessageIds,
  );
  const artifactCarry = normalizeAgentArtifactCarryByTurn(
    pt.agentArtifactCarryByTurn,
    pt.transcript ? undefined : userMessageIds,
  );
  const currentTodos = pt.transcript
    ? pt.transcript.todos
    : deriveCurrentTodosFromMessages(messages);
  const currentTaskTodos = pt.transcript
    ? pt.transcript.taskTodos
    : deriveCurrentTaskTodosFromMessages(messages);
  const pendingClaudeTerminalWatcherMessages =
    normalizePendingClaudeTerminalWatcherMessages(
      pt.pendingClaudeTerminalWatcherMessages,
    );

  const providerType: AgentProviderType | undefined =
    pt.providerType ??
    (validModel ? getProviderForModel(validModel) : undefined);
  const executionHarness =
    (pt.transcript?.messageCount ??
      pt.transcript?.committedMessageCount ??
      messages.length) > 0 || pt.executionHarnessExplicitlyChosen === true
      ? (pt.executionHarness ??
        inferLegacyExecutionHarness({
          model: hydratedModel,
          providerType,
          hasStarted: true,
        }))
      : undefined;

  // Migrate any legacy persisted thinking level (e.g. 'auto') through the
  // shared normalizer; fall back to 'high' when the field is missing.
  const persistedModelConfig = normalizeAgentModelConfig(pt.modelConfig);
  // An authoritative record is read speed-first, never merged as a command
  // patch: the tab's own record (speed, then its boolean, then the legacy
  // `codexFastModeEnabled` alias) wins over the default record, so a persisted
  // Ultra fast stays Ultra fast and an explicit legacy `false` still beats an
  // Ultra fast default. Any speed on the tab's record is an explicit choice.
  const persistedSpeed = readCodexSpeedRecord(
    persistedModelConfig,
    pt.codexFastModeEnabled,
  );
  const requestedSpeed =
    persistedSpeed ?? readCodexSpeedRecord(defaults?.modelConfig);
  const modelConfigInput: AgentModelConfig = {
    ...withoutCodexSpeed(defaults?.modelConfig),
    ...withoutCodexSpeed(persistedModelConfig),
    ...(requestedSpeed === undefined ? {} : codexSpeedFields(requestedSpeed)),
  };
  const fastModeExplicit = persistedSpeed !== undefined;
  const thinkingLevel: ThinkingLevel = normalizePersistedThinkingLevel(
    persistedModelConfig?.thinkingLevel ?? pt.thinkingLevel,
    modelConfigInput.thinkingLevel ?? defaults?.thinkingLevel ?? 'high',
  );
  const modelConfig = resolveProviderModelConfig(
    executionHarness ?? providerType ?? 'claude',
    {
      thinkingLevel,
      modelConfig: {
        ...modelConfigInput,
        thinkingLevel: persistedModelConfig?.thinkingLevel ?? thinkingLevel,
      },
    },
    undefined,
  );

  // Read-compat: prefer the new key, fall back to the legacy
  // `claudeUsageLimitBanner` / `dismissedClaudeUsageLimitBannerKey` keys for
  // tabs persisted before the `LlmProvider*` rename.
  const legacyUsageLimitBanner = readLegacyUsageLimitBannerFields(pt);
  const llmProviderUsageLimitBanner =
    pt.llmProviderUsageLimitBanner ?? legacyUsageLimitBanner.banner;
  const dismissedLlmProviderUsageLimitBannerKey =
    pt.dismissedLlmProviderUsageLimitBannerKey ??
    legacyUsageLimitBanner.dismissedKey;
  const sessionApprovalRules = normalizeApprovalRules(pt.sessionApprovalRules);

  return {
    transcript: pt.transcript,
    transcriptLoaded: pt.transcriptLoaded,
    transcriptWindow: pt.transcriptWindow,
    id: pt.id,
    title: pt.title,
    ...(pt.kind === 'file' ? { kind: pt.kind } : {}),
    ...(pt.filePath ? { filePath: pt.filePath } : {}),
    ...(isFileTabViewMode(pt.fileViewMode)
      ? { fileViewMode: pt.fileViewMode }
      : {}),
    ...(isFileDiffContext(pt.fileDiffContext)
      ? { fileDiffContext: pt.fileDiffContext }
      : {}),
    ...(pt.pinned ? { pinned: true } : {}),
    ...(pt.customTitle ? { customTitle: pt.customTitle } : {}),
    ...(pt.automaticTitleState === 'pending' ||
    pt.automaticTitleState === 'closed'
      ? { automaticTitleState: pt.automaticTitleState }
      : {}),
    ...(pt.description ? { description: pt.description } : {}),
    messages,
    ...(persistedMemory ? { memoryByMessageId: persistedMemory } : {}),
    ...(artifactCarry ? { agentArtifactCarryByTurn: artifactCarry } : {}),
    ...(pt.inputDelivery ? { inputDelivery: pt.inputDelivery } : {}),
    status: 'idle',
    error: null,
    createdAt: pt.createdAt,
    queuedMessages: [],
    planMode: pt.planMode ?? false,
    ...(isApprovalMode(pt.approvalMode)
      ? { approvalMode: pt.approvalMode }
      : {}),
    ...(sessionApprovalRules.length ? { sessionApprovalRules } : {}),
    proposalMode: pt.proposalMode ?? 'optional',
    thinkingLevel: modelConfig.thinkingLevel,
    modelConfig,
    fastModeExplicit,
    ...(pt.kind !== 'file' && providerType === 'codex'
      ? { codexFastModeEnabled: modelConfig.fastMode }
      : {}),
    ...retainedCodexSpeedFields(pt.retainedCodexSpeed),
    ...(pt.autoArchive === true ? { autoArchive: true } : {}),
    ...(hydratedModel ? { model: hydratedModel } : {}),
    ...(pt.modelSelectionMode === 'auto'
      ? { modelSelectionMode: 'auto' as const }
      : {}),
    ...(pt.autoRoutedModels ? { autoRoutedModels: pt.autoRoutedModels } : {}),
    // Main owns this anchor. Retain it on read so completion presentation can
    // correlate the canonical end without inferring success from idle state.
    ...(pt.lastAcceptedUserMessageId !== undefined
      ? { lastAcceptedUserMessageId: pt.lastAcceptedUserMessageId }
      : {}),
    ...(pt.turnEnds ? { turnEnds: pt.turnEnds } : {}),
    ...(pt.unacceptedTurnEnds
      ? { unacceptedTurnEnds: pt.unacceptedTurnEnds }
      : {}),
    // Main-owned restart evidence drives interrupted outcomes and the resume
    // offer. The renderer reads it without writing it back.
    ...(pt.interruptedTurns ? { interruptedTurns: pt.interruptedTurns } : {}),
    ...(pt.modelExplicitlyChosen ? { modelExplicitlyChosen: true } : {}),
    ...(pt.billingExplicitlyChosen ? { billingExplicitlyChosen: true } : {}),
    ...(hydratedDefaultStampModel
      ? { defaultStampModel: hydratedDefaultStampModel }
      : {}),
    ...(providerType ? { providerType } : {}),
    ...(executionHarness ? { executionHarness } : {}),
    ...(pt.executionHarnessExplicitlyChosen === true
      ? { executionHarnessExplicitlyChosen: true }
      : {}),
    ...(pt.unread === true ? { unread: true } : {}),
    ...(pt.unread === true && pt.unreadMarkedManually === true
      ? { unreadMarkedManually: true }
      : {}),
    ...(pt.pendingPlanExit ? { pendingPlanExit: pt.pendingPlanExit } : {}),
    ...(pt.pendingPlanExitRequestId
      ? { pendingPlanExitRequestId: pt.pendingPlanExitRequestId }
      : {}),
    ...(pt.trackedPlanId ? { trackedPlanId: pt.trackedPlanId } : {}),
    // Main-owned implementation link: outcome and end time settle there.
    ...(pt.trackedPlanImplementation
      ? { trackedPlanImplementation: pt.trackedPlanImplementation }
      : {}),
    ...(pt.trackedPlanSource
      ? { trackedPlanSource: pt.trackedPlanSource }
      : {}),
    ...(pt.trackedPlanReviewStatus
      ? { trackedPlanReviewStatus: pt.trackedPlanReviewStatus }
      : {}),
    ...(pt.pendingSystemInstructions?.length
      ? { pendingSystemInstructions: pt.pendingSystemInstructions }
      : {}),
    ...(pt.hasOutstandingProposal ? { hasOutstandingProposal: true } : {}),
    ...(pt.latestRevisionNumber !== undefined
      ? { latestRevisionNumber: pt.latestRevisionNumber }
      : {}),
    ...(pt.sdkSessionId ? { sdkSessionId: pt.sdkSessionId } : {}),
    ...(pt.globalInstructionsSnapshot !== undefined
      ? { globalInstructionsSnapshot: pt.globalInstructionsSnapshot }
      : {}),
    ...(pt.codexReconstructionSeedId
      ? { codexReconstructionSeedId: pt.codexReconstructionSeedId }
      : {}),
    ...(pt.claudeForkSessionOnNextSend
      ? { claudeForkSessionOnNextSend: true }
      : {}),
    ...(pt.newChatStartedWatcherPending
      ? { newChatStartedWatcherPending: true }
      : {}),
    ...(pt.newChatStartedWatcherFiredAt
      ? { newChatStartedWatcherFiredAt: pt.newChatStartedWatcherFiredAt }
      : {}),
    ...(pt.adhocMigrationSource
      ? { adhocMigrationSource: pt.adhocMigrationSource }
      : {}),
    ...(pt.forkedFrom ? { forkedFrom: pt.forkedFrom } : {}),
    ...(pt.sharedRun ? { sharedRun: pt.sharedRun } : {}),
    ...(pt.pendingRevertAttachmentPath
      ? { pendingRevertAttachmentPath: pt.pendingRevertAttachmentPath }
      : {}),
    ...(pendingClaudeTerminalWatcherMessages?.length
      ? { pendingClaudeTerminalWatcherMessages }
      : {}),
    ...(typeof pt.scheduledSendDraft?.runAt === 'string'
      ? { scheduledSendDraft: { runAt: pt.scheduledSendDraft.runAt } }
      : {}),
    ...(pt.readOnly ? { readOnly: true } : {}),
    // Read from disk unchecked; an unknown source would name no provider.
    ...(isExternalProjectProvider(pt.importedFrom)
      ? { importedFrom: pt.importedFrom }
      : {}),
    ...(pt.staleSessionDetected
      ? { staleSessionDetected: pt.staleSessionDetected }
      : {}),
    ...(llmProviderUsageLimitBanner ? { llmProviderUsageLimitBanner } : {}),
    ...(dismissedLlmProviderUsageLimitBannerKey
      ? {
          dismissedLlmProviderUsageLimitBannerKey,
        }
      : {}),
    ...(pt.aiCreditsNoBillingSource
      ? { aiCreditsNoBillingSource: pt.aiCreditsNoBillingSource }
      : {}),
    ...(pt.aiCreditsRouting ? { aiCreditsRouting: pt.aiCreditsRouting } : {}),
    ...(typeof pt.aiCreditsRouted === 'boolean' || aiCreditsRouted
      ? { aiCreditsRouted }
      : {}),
    // Self-heal the mutual-exclusivity contract: if older/buggy persisted
    // metadata carries both an active routing state and the "Subscription"
    // override, active routing wins and the override is dropped so the tab is
    // never rehydrated in a contradictory state.
    ...(pt.subscriptionBillingOverride && !pt.aiCreditsRouting?.active
      ? { subscriptionBillingOverride: pt.subscriptionBillingOverride }
      : {}),
    ...(pt.pluginSelections
      ? { pluginSelections: normalizePluginSelections(pt.pluginSelections) }
      : {}),
    ...(pt.disabledGlobalPluginSelections
      ? { disabledGlobalPluginSelections: pt.disabledGlobalPluginSelections }
      : {}),
    ...(pt.inheritedPluginDefaultsVersion !== undefined
      ? { inheritedPluginDefaultsVersion: pt.inheritedPluginDefaultsVersion }
      : {}),
    ...(typeof pt.deferredToolsAllowed === 'boolean'
      ? { deferredToolsAllowed: pt.deferredToolsAllowed }
      : {}),
    ...(pt.discovery ? { discovery: pt.discovery } : {}),
    ...(usage ? { usage } : {}),
    ...(pt.agentUsage ? { agentUsage: pt.agentUsage } : {}),
    ...(currentTodos && currentTodos.length > 0 ? { currentTodos } : {}),
    ...(currentTaskTodos && currentTaskTodos.length > 0
      ? { currentTaskTodos }
      : {}),
    ...(pt.turnDiffs ? { turnDiffs: pt.turnDiffs } : {}),
    ...(pt.turnFeedback ? { turnFeedback: pt.turnFeedback } : {}),
    ...(pt.attentionDismissedAt !== undefined
      ? { attentionDismissedAt: pt.attentionDismissedAt }
      : {}),
    ...(pt.selectedRepoId ? { selectedRepoId: pt.selectedRepoId } : {}),
    // Chat-interface mode and managed-terminal runtime snapshot. Missing
    // values default to `'canopy'` (the legacy Canopy-native chat) so older
    // persisted tabs hydrate without the toggle flipping unexpectedly.
    ...(pt.interfaceMode && isClaudeTerminalEligibleChatTab(pt)
      ? { interfaceMode: pt.interfaceMode }
      : {}),
    ...(pt.claudeTerminal ? { claudeTerminal: pt.claudeTerminal } : {}),
  };
}

export function applyQueuedHookPlaceholderTabSettings(
  nextTab: ChatTab,
  placeholderTab?: ChatTab,
): ChatTab {
  if (placeholderTab?.queuedHookPlaceholder !== true) {
    return nextTab;
  }

  return {
    ...nextTab,
    planMode: placeholderTab.planMode,
    thinkingLevel: placeholderTab.thinkingLevel,
    modelConfig: placeholderTab.modelConfig,
    fastModeExplicit: placeholderTab.fastModeExplicit,
    proposalMode: placeholderTab.proposalMode,
    codexFastModeEnabled: placeholderTab.codexFastModeEnabled,
    ...(placeholderTab.model ? { model: placeholderTab.model } : {}),
    ...(placeholderTab.providerType
      ? { providerType: placeholderTab.providerType }
      : {}),
    ...(placeholderTab.pluginSelections
      ? { pluginSelections: placeholderTab.pluginSelections }
      : {}),
    ...(placeholderTab.selectedRepoId
      ? { selectedRepoId: placeholderTab.selectedRepoId }
      : {}),
  };
}

export function splitFilePathSegments(filePath: string): string[] {
  const windowsPath =
    /^[a-z]:[\\/]/i.test(filePath) ||
    filePath.startsWith('\\\\') ||
    filePath.startsWith('//');
  return filePath
    .split(windowsPath ? /[\\/]+/ : /\/+/)
    .filter((segment) => segment.length > 0);
}

export function getFilePathSuffix(
  filePath: string,
  segmentCount: number,
): string {
  const segments = splitFilePathSegments(filePath);
  return segments.slice(-segmentCount).join('/');
}

export function buildFileTabTitle(
  filePath: string,
  allFilePaths: readonly string[],
): string {
  const segments = splitFilePathSegments(filePath);
  if (segments.length === 0) {
    return filePath;
  }

  for (
    let segmentCount = 1;
    segmentCount <= segments.length;
    segmentCount += 1
  ) {
    const suffix = getFilePathSuffix(filePath, segmentCount);
    const duplicateCount = allFilePaths.filter(
      (candidatePath) =>
        getFilePathSuffix(candidatePath, segmentCount) === suffix,
    ).length;
    if (duplicateCount === 1) {
      return suffix;
    }
  }

  return filePath;
}

export function relabelFileTabs(tabs: readonly ChatTab[]): ChatTab[] {
  const filePaths = tabs.flatMap((tab) =>
    tab.kind === 'file' && tab.filePath ? [tab.filePath] : [],
  );

  return tabs.map((tab) => {
    if (tab.kind !== 'file' || !tab.filePath) {
      return tab;
    }

    const title = buildFileTabTitle(tab.filePath, filePaths);
    const description = tab.filePath;
    if (tab.title === title && tab.description === description) {
      return tab;
    }

    return {
      ...tab,
      title,
      description,
    };
  });
}

export function fromPersistedTabs(
  file: ChatTabsFile,
  defaultPluginSelections?: ChatTabPluginSelections,
  defaultModel?: ChatModel,
  defaultThinking?: ThinkingLevel,
  defaultChatInterfaceMode?: ChatInterfaceMode,
  defaultModelConfig?: AgentModelConfig,
  defaultDeferredToolsAllowed = true,
  defaultBillingSeed?: ChatBillingFramework,
  defaultProviderType?: AgentProviderType,
  materializeEmpty = true,
  newTabPluginDefaultsStamp: { inheritedPluginDefaultsVersion?: number } = {},
): WorktreeChatState {
  if (file.tabs.length === 0) {
    if (!materializeEmpty) {
      return { tabs: [], activeTabId: '' };
    }
    return emptyWorktreeChat({
      pluginSelections: defaultPluginSelections,
      model: defaultModel,
      thinkingLevel: defaultThinking,
      defaultChatInterfaceMode,
      modelConfig: defaultModelConfig,
      deferredToolsAllowed: defaultDeferredToolsAllowed,
      billingSeed: defaultBillingSeed,
      providerTypeHint: defaultProviderType,
      ...newTabPluginDefaultsStamp,
    });
  }

  const tabs = relabelFileTabs(
    file.tabs.map((tab) =>
      fromPersistedTab(tab, {
        modelConfig: defaultModelConfig,
        thinkingLevel: defaultThinking,
      }),
    ),
  );

  const activeTabId =
    tabs.find((t) => t.id === file.activeTabId)?.id ?? tabs[0].id;

  const activeChatProvider = resolveTabProviderType(
    tabs.find((tab) => tab.id === activeTabId),
  );
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const editableTabs = tabs.filter(
    (tab) => tab.kind !== 'file' && !tab.readOnly,
  );
  const lastActiveEditableChatId =
    activeTab && activeTab.kind !== 'file' && !activeTab.readOnly
      ? activeTab.id
      : editableTabs.some((tab) => tab.id === file.lastActiveEditableChatId)
        ? file.lastActiveEditableChatId
        : editableTabs.length === 1
          ? editableTabs[0]?.id
          : undefined;
  const lastActiveChatProvider =
    activeChatProvider ?? file.lastActiveChatProvider;

  return {
    tabs,
    activeTabId,
    ...(lastActiveEditableChatId ? { lastActiveEditableChatId } : {}),
    ...(lastActiveChatProvider ? { lastActiveChatProvider } : {}),
  };
}
