import { CopilotHostSelectionSchema } from '@canopy/protocol/copilot-selection';
import {
  migrateLegacyPlanModeHintRecord,
  normalizeGitHubStarPromptRecord,
  normalizePlanModeHintRecord,
} from '@canopy/protocol/onboarding';
import {
  excludeDisabledInstalledItems,
  normalizeDisabledInstalledItems,
} from '@canopy/protocol/installed-items';
import {
  normalizeClaudeMaxTurns,
  DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
  DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
} from '../../constants/preferences';
import {
  normalizeManagedDelegationMode,
  normalizeManagedDelegationMaxConcurrent,
  normalizeManagedDelegationMaxDepth,
  normalizeManagedDelegationLifetimeLimit,
} from '@canopy/protocol/delegation/discovery';
import { normalizeManagedDelegationModelPolicy } from '@canopy/protocol/delegation/model-policy';
import { normalizeCodexMaxConcurrentSubagents } from '@canopy/execution-engine/lib/codex-multi-agent';
import { normalizeAppAdvisorProjectAgentAccess } from '../../lib/app-advisor-project-agent-access';
import { normalizeCustomBrowserSearchEngines } from '../../lib/browser-search-engines';
import { isAccountProxyRoutingStrategy } from '../../lib/account-proxy';
import { isBillingLane } from '../../lib/default-model-lane';
import { isMergeQueueAgentHandling } from '../../types/github';
import { reconcileSidebarNavLayout } from '../../lib/sidebar-nav-layout';
import {
  DEFAULT_SUMMARY_MODEL,
  DEFAULT_HANDOFF_SUMMARY_MODEL,
  DEFAULT_LOCAL_MEMORY_MODEL,
  defaultLocalMemoryModel,
  defaultSummaryModel,
  isNavigationMode,
  isWorkspaceLayoutMode,
  clampThinkingLevelForModel,
  resolveKnownModel,
  type PreferencesData,
} from '../../types';
import { normalizeApprovalRules } from '../../lib/approval-engine';
import { normalizeFileIndexingPreferences } from '@canopy/core-runtime/node';
import { normalizeGlobalInstructionsConfig } from '@canopy/execution-engine/lib/global-instructions';
import { normalizeStringArray } from '../../lib/string-array';
import { normalizePromotionalNotifications } from '../../lib/promotional-notifications';
import { normalizeSuggestionsState } from '@canopy/protocol/suggestions';
import { normalizeOnboardingTipDismissals } from '@canopy/protocol/onboarding-tips';
import { DEFAULT_PREFERENCES } from './defaults';
import { normalizeTerminalSettingsRevision } from './terminal-settings';
import {
  normalizeClientLocalPreferences,
  type DomainPreferencesData,
} from './client-local-preferences';
import {
  normalizeLastActiveContext,
  isBrowserDrawerTabId,
  isBranchNamePrefixMode,
  isPrInstructionMode,
  isChatEnrichmentMode,
  buildOnboardingProfileFields,
  isAiCreditsRoutingMode,
  isChatBillingFramework,
  normalizeTelemetrySharing,
  normalizeUsageData,
  normalizeString,
  isChatInterfaceMode,
  isBackgroundProcessMode,
  normalizeFileLabels,
  normalizePlanDetectionPreferences,
  normalizeGlobalFocusShortcut,
  normalizeActivationQuietHours,
  isTerminalShellProfileId,
  normalizeTerminalPresets,
  normalizeCodexCompatDisabledPlugins,
  normalizeBoolean,
  isRecord,
} from './field-normalizers';
import {
  normalizeThinkingLevel,
  normalizeOptionalThinkingLevel,
  type ModelSelectionValidation,
  normalizeApprovalDefaults,
  normalizeProviderModelConfigDefaults,
  normalizeLastResolvedLaneByScope,
  normalizePersistableModelSelectionOrDefault,
  normalizeUserSelectedModel,
  normalizePersistablePipelineAdvisorModelOrDefault,
  normalizeFiniteNumber,
  clampNumber,
  normalizeCodeGraphPreferences,
  normalizeProviderDefaults,
  normalizeRuntimeLimits,
} from './model-normalizers';
import {
  normalizeBranchDisplayMappings,
  normalizeChatTabPluginSelections,
  normalizeInAppNotifications,
  normalizeOsNotifications,
  normalizeNativeProviderAccounts,
  normalizeOptInTimestamp,
  normalizeDataSharingOptInHints,
  normalizeDataSharingOptInHistory,
  preserveLegacyPlanModeInput,
  legacyNotificationAnswer,
  normalizeAccountProxyConnection,
  normalizePendingInstalledItemUninstalls,
  normalizeParkedCodexPlugins,
  normalizeChatDetailPreference,
} from './record-normalizers';
import {
  isClaudeModAdmission,
  isClaudeModPluginId,
  type ClaudeModAdmission,
} from '@canopy/execution-engine/types/claude-mod-admission';

/** Valid admissions only; a plugin listed more than once keeps none. */
function normalizeClaudeModAdmissions(value: unknown): ClaudeModAdmission[] {
  if (!Array.isArray(value)) return [];
  const entries: readonly unknown[] = value;
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const pluginId: unknown =
      typeof entry === 'object' && entry !== null && 'pluginId' in entry
        ? entry.pluginId
        : undefined;
    if (isClaudeModPluginId(pluginId)) {
      counts.set(pluginId, (counts.get(pluginId) ?? 0) + 1);
    }
  }
  return entries.flatMap((entry) => {
    if (!isClaudeModAdmission(entry) || counts.get(entry.pluginId) !== 1) {
      return [];
    }
    return [
      {
        pluginId: entry.pluginId,
        contentDigest: entry.contentDigest,
        admittedAt: entry.admittedAt,
      },
    ];
  });
}

/**
 * The account proxy is on unless the user turned it off. A choice made with
 * the Settings switch holds as stored. Earlier builds kept this as a Labs
 * opt-in that every profile stored as `false`, so an unmarked `false` counts
 * as off only beside a saved connection: a profile that never connected is
 * on, and one that connected and then turned it off stays off with its
 * connection kept.
 */
function normalizeAccountProxyEnabled(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
): boolean {
  if (data?.accountProxyEnabledSetByUser === true) {
    return data.accountProxyEnabled !== false;
  }
  return !(
    data?.accountProxyEnabled === false &&
    normalizeAccountProxyConnection(data.accountProxyConnection) !== null
  );
}

/**
 * Organization ID → required-scope signature. Keeps only non-empty string
 * keys and values; keeps an empty object, since "map present" means the
 * member's existing requirements were already seeded.
 */
export function normalizeOrgSharingNoticesSeen(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const seen: Record<string, string> = {};
  for (const [organizationId, signature] of Object.entries(value)) {
    if (organizationId.trim().length === 0) continue;
    if (typeof signature !== 'string' || signature.length === 0) continue;
    seen[organizationId] = signature;
  }
  return seen;
}

/** The whole preferences value: the domain document plus the client-local one. */
export function normalizePreferences(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
  modelSelectionValidation: ModelSelectionValidation = 'runtime',
): PreferencesData {
  return {
    ...normalizeDomainPreferences(data, modelSelectionValidation),
    ...normalizeClientLocalPreferences(data),
  };
}

/**
 * The domain document. Client-local keys (CAN-4472) have no default, field or
 * merge here, so no domain save can write them.
 */
export function normalizeDomainPreferences(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
  modelSelectionValidation: ModelSelectionValidation = 'runtime',
): DomainPreferencesData {
  const providerDefaults = normalizeProviderDefaults(
    data,
    modelSelectionValidation,
  );
  const providerModelConfigDefaults = normalizeProviderModelConfigDefaults(
    data?.providerModelConfigDefaults,
    data?.codexFastModeDefaultEnabled,
  );
  const runtimeLimits = normalizeRuntimeLimits(data);
  const onboardingCompleted = normalizeStringArray(data?.onboardingCompleted);
  // Migrate the raw compatibility entry before checklist normalization can
  // discard it. A persisted marker, including a reset, always wins.
  const planModeHint =
    data?.planModeHint === undefined
      ? migrateLegacyPlanModeHintRecord(data?.homeOnboardingSuggestions)
      : normalizePlanModeHintRecord(data.planModeHint);
  const githubStarPrompt =
    data?.githubStarPrompt === undefined
      ? { version: 1 as const, promptsSent: 0 }
      : normalizeGitHubStarPromptRecord(data.githubStarPrompt);
  const homeOnboardingSuggestions = preserveLegacyPlanModeInput(
    data?.homeOnboardingSuggestions,
  );
  const nativeProviderAccounts = normalizeNativeProviderAccounts(
    data?.nativeProviderAccounts,
  );
  const notificationAnswer = legacyNotificationAnswer(
    data?.homeOnboardingSuggestions,
  );
  const legacyNotificationAnswerTimestamps = [
    normalizeOptInTimestamp(notificationAnswer?.completedAt),
    normalizeOptInTimestamp(notificationAnswer?.dismissedAt),
  ].filter((value): value is string => value !== undefined);
  legacyNotificationAnswerTimestamps.sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  const osNotificationOfferAnsweredAt =
    normalizeOptInTimestamp(data?.osNotificationOfferAnsweredAt) ??
    legacyNotificationAnswerTimestamps[0];
  const dataSharingOptInHints = normalizeDataSharingOptInHints(
    data?.dataSharingOptInHints,
  );
  const dataSharingOptInHistory = normalizeDataSharingOptInHistory(
    data?.dataSharingOptInHistory,
  );
  const prefixMode = isBranchNamePrefixMode(data?.branchNamePrefixMode)
    ? data.branchNamePrefixMode
    : DEFAULT_PREFERENCES.branchNamePrefixMode;
  const summaryModel = normalizeUserSelectedModel(
    data?.summaryModel,
    data?.summaryModelSetByUser,
    { stored: DEFAULT_SUMMARY_MODEL, providerAware: defaultSummaryModel },
    modelSelectionValidation,
  );
  const localMemoryModel = normalizeUserSelectedModel(
    data?.localMemoryModel,
    data?.localMemoryModelSetByUser,
    {
      stored: DEFAULT_LOCAL_MEMORY_MODEL,
      providerAware: defaultLocalMemoryModel,
    },
    modelSelectionValidation,
    // Memory runs refuse an unavailable chosen model (see
    // resolveLocalMemoryHelperModel) instead of sending saved memory to the
    // default's provider.
    { keepUnavailableChoice: true },
  );
  const handoffSummaryModel = normalizePersistableModelSelectionOrDefault(
    data?.handoffSummaryModel,
    DEFAULT_HANDOFF_SUMMARY_MODEL,
    // Keep an unavailable saved local choice. Changed runtime writes are
    // rejected below instead of substituting a cloud default.
    'persisted',
  );
  const handoffThinking = normalizeThinkingLevel(
    data?.handoffSummaryThinkingLevel,
    'off',
  );
  const usageData = normalizeUsageData(data?.usageData);
  const orgSharingNoticesSeen = normalizeOrgSharingNoticesSeen(
    data?.orgSharingNoticesSeen,
  );

  return {
    cursorEnabled: data?.cursorEnabled === true,
    // An absent legacy field keeps existing access. Malformed opt-outs must
    // not silently re-enable a previously disconnected subscription.
    googleSubscriptionDisconnected:
      data?.googleSubscriptionDisconnected !== undefined &&
      data.googleSubscriptionDisconnected !== false,
    copilotEnabled: data?.copilotEnabled === true,
    copilotVaultSelection:
      data?.copilotVaultSelection === undefined
        ? undefined
        : (CopilotHostSelectionSchema.safeParse(data.copilotVaultSelection)
            .data ?? null),
    opencodeEnabled: data?.opencodeEnabled === true,
    accountProxyEnabled: normalizeAccountProxyEnabled(data),
    accountProxyEnabledSetByUser: data?.accountProxyEnabledSetByUser === true,
    // Only a choice is stored. Without one the build default applies at
    // read time, so a later default change reaches people who never chose.
    ...(typeof data?.oneWindowEnabled === 'boolean'
      ? { oneWindowEnabled: data.oneWindowEnabled }
      : {}),
    accountProxyConnection: normalizeAccountProxyConnection(
      data?.accountProxyConnection,
    ),
    accountProxyKeepChatOnOneAccount:
      data?.accountProxyKeepChatOnOneAccount !== false,
    accountProxyRouteClaude: data?.accountProxyRouteClaude !== false,
    accountProxyRouteCodex: data?.accountProxyRouteCodex !== false,
    accountProxyLocalStartWithApp:
      data?.accountProxyLocalStartWithApp !== false,
    ...(isAccountProxyRoutingStrategy(data?.accountProxyLocalRoutingStrategy)
      ? {
          accountProxyLocalRoutingStrategy:
            data.accountProxyLocalRoutingStrategy,
        }
      : {}),
    copilotAccount:
      isRecord(data?.copilotAccount) &&
      typeof data.copilotAccount.login === 'string' &&
      /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(data.copilotAccount.login) &&
      typeof data.copilotAccount.host === 'string' &&
      /^https:\/\/(github\.com|[a-z0-9-]+\.ghe\.com)$/.test(
        data.copilotAccount.host,
      )
        ? { login: data.copilotAccount.login, host: data.copilotAccount.host }
        : undefined,
    orgProjectDefaultDestinationRoot:
      typeof data?.orgProjectDefaultDestinationRoot === 'string'
        ? data.orgProjectDefaultDestinationRoot.trim()
        : undefined,
    orgProjectCloneProtocol:
      data?.orgProjectCloneProtocol === 'ssh' ? 'ssh' : 'https',
    cursorAgentPath:
      typeof data?.cursorAgentPath === 'string'
        ? data.cursorAgentPath.trim()
        : '',
    ...(data?.chatWidth === 'full' ? { chatWidth: 'full' as const } : {}),
    workspaceDefaultLayoutMode: isWorkspaceLayoutMode(
      data?.workspaceDefaultLayoutMode,
    )
      ? data.workspaceDefaultLayoutMode
      : DEFAULT_PREFERENCES.workspaceDefaultLayoutMode,
    navigationMode: isNavigationMode(data?.navigationMode)
      ? data.navigationMode
      : DEFAULT_PREFERENCES.navigationMode,
    sidebarProjectSortMode:
      data?.sidebarProjectSortMode === 'last-updated'
        ? 'last-updated'
        : 'manual',
    sidebarNavLayout:
      typeof data?.sidebarNavLayout === 'object' &&
      data?.sidebarNavLayout !== null
        ? reconcileSidebarNavLayout(data.sidebarNavLayout)
        : reconcileSidebarNavLayout(undefined),
    branchNamePrefixMode: prefixMode,
    branchNameCustomPrefix:
      typeof data?.branchNameCustomPrefix === 'string'
        ? data.branchNameCustomPrefix
        : DEFAULT_PREFERENCES.branchNameCustomPrefix,
    deleteBranchOnArchive:
      typeof data?.deleteBranchOnArchive === 'boolean'
        ? data.deleteBranchOnArchive
        : DEFAULT_PREFERENCES.deleteBranchOnArchive,
    archiveOnMerge:
      typeof data?.archiveOnMerge === 'boolean'
        ? data.archiveOnMerge
        : DEFAULT_PREFERENCES.archiveOnMerge,
    groupChildBranchesWithBase:
      typeof data?.groupChildBranchesWithBase === 'boolean'
        ? data.groupChildBranchesWithBase
        : DEFAULT_PREFERENCES.groupChildBranchesWithBase,
    defaultChatProvider: providerDefaults.defaultChatProvider,
    defaultChatModelByProvider: providerDefaults.defaultChatModelByProvider,
    defaultWorktreeProvider: providerDefaults.defaultWorktreeProvider,
    defaultWorktreeModelByProvider:
      providerDefaults.defaultWorktreeModelByProvider,
    approvalDefaults: normalizeApprovalDefaults(
      data?.approvalDefaults,
      DEFAULT_PREFERENCES.approvalDefaults,
    ),
    claudeModAdmissions: normalizeClaudeModAdmissions(
      data?.claudeModAdmissions,
    ),
    claudeModsDisabled:
      typeof data?.claudeModsDisabled === 'boolean'
        ? data.claudeModsDisabled
        : DEFAULT_PREFERENCES.claudeModsDisabled,
    globalApprovalRules: normalizeApprovalRules(data?.globalApprovalRules),
    approvalsUpgradeNoticeDismissed:
      typeof data?.approvalsUpgradeNoticeDismissed === 'boolean'
        ? data.approvalsUpgradeNoticeDismissed
        : DEFAULT_PREFERENCES.approvalsUpgradeNoticeDismissed,
    onboardingTipsDismissed: normalizeOnboardingTipDismissals(
      data?.onboardingTipsDismissed,
    ),
    ...(isBillingLane(data?.lastResolvedDefaultLane)
      ? { lastResolvedDefaultLane: data.lastResolvedDefaultLane }
      : {}),
    ...normalizeLastResolvedLaneByScope(
      data?.lastResolvedDefaultLaneByScope,
      data?.lastResolvedDefaultLane,
    ),
    summaryModel: summaryModel.model,
    summaryModelSetByUser: summaryModel.setByUser,
    summaryThinkingLevel: normalizeThinkingLevel(
      data?.summaryThinkingLevel,
      DEFAULT_PREFERENCES.summaryThinkingLevel,
    ),
    handoffSummaryModel,
    handoffSummaryThinkingLevel: resolveKnownModel(handoffSummaryModel)
      ? clampThinkingLevelForModel(handoffThinking, handoffSummaryModel)
      : handoffThinking,
    worktreeSummaryEnabled:
      typeof data?.worktreeSummaryEnabled === 'boolean'
        ? data.worktreeSummaryEnabled
        : DEFAULT_PREFERENCES.worktreeSummaryEnabled,
    worktreeSummaryModel: normalizePersistableModelSelectionOrDefault(
      data?.worktreeSummaryModel,
      DEFAULT_PREFERENCES.worktreeSummaryModel,
      modelSelectionValidation,
    ),
    worktreeSummaryThinkingLevel: normalizeThinkingLevel(
      data?.worktreeSummaryThinkingLevel,
      DEFAULT_PREFERENCES.worktreeSummaryThinkingLevel,
    ),
    planDiagramModel: normalizePersistableModelSelectionOrDefault(
      data?.planDiagramModel,
      DEFAULT_PREFERENCES.planDiagramModel,
      modelSelectionValidation,
    ),
    planDiagramThinkingLevel: normalizeThinkingLevel(
      data?.planDiagramThinkingLevel,
      DEFAULT_PREFERENCES.planDiagramThinkingLevel,
    ),
    codeReviewModel: normalizePersistableModelSelectionOrDefault(
      data?.codeReviewModel,
      DEFAULT_PREFERENCES.codeReviewModel,
      modelSelectionValidation,
    ),
    codeReviewThinkingLevel: normalizeThinkingLevel(
      data?.codeReviewThinkingLevel,
      DEFAULT_PREFERENCES.codeReviewThinkingLevel,
    ),
    prGenerationModel: normalizePersistableModelSelectionOrDefault(
      data?.prGenerationModel,
      DEFAULT_PREFERENCES.prGenerationModel,
      modelSelectionValidation,
    ),
    prGenerationThinkingLevel: normalizeThinkingLevel(
      data?.prGenerationThinkingLevel,
    ),
    prInstructions:
      typeof data?.prInstructions === 'string'
        ? data.prInstructions
        : DEFAULT_PREFERENCES.prInstructions,
    prInstructionMode: isPrInstructionMode(data?.prInstructionMode)
      ? data.prInstructionMode
      : DEFAULT_PREFERENCES.prInstructionMode,
    commitGenerationModel: normalizePersistableModelSelectionOrDefault(
      data?.commitGenerationModel,
      DEFAULT_PREFERENCES.commitGenerationModel,
      modelSelectionValidation,
    ),
    commitGenerationThinkingLevel: normalizeThinkingLevel(
      data?.commitGenerationThinkingLevel,
      DEFAULT_PREFERENCES.commitGenerationThinkingLevel,
    ),
    commitInstructions:
      typeof data?.commitInstructions === 'string'
        ? data.commitInstructions
        : DEFAULT_PREFERENCES.commitInstructions,
    commitInstructionMode: isPrInstructionMode(data?.commitInstructionMode)
      ? data.commitInstructionMode
      : DEFAULT_PREFERENCES.commitInstructionMode,
    branchNamingModel: normalizePersistableModelSelectionOrDefault(
      data?.branchNamingModel,
      DEFAULT_PREFERENCES.branchNamingModel,
      modelSelectionValidation,
    ),
    branchNamingThinkingLevel: normalizeThinkingLevel(
      data?.branchNamingThinkingLevel,
      DEFAULT_PREFERENCES.branchNamingThinkingLevel,
    ),
    branchNamingInstructions:
      typeof data?.branchNamingInstructions === 'string'
        ? data.branchNamingInstructions
        : DEFAULT_PREFERENCES.branchNamingInstructions,
    globalInstructions: normalizeGlobalInstructionsConfig(
      data?.globalInstructions,
    ),
    pipelineAdvisorEnabled:
      typeof data?.pipelineAdvisorEnabled === 'boolean'
        ? data.pipelineAdvisorEnabled
        : DEFAULT_PREFERENCES.pipelineAdvisorEnabled,
    // Only an explicit true turns the gate on (CAN-7604).
    slackOrchestratorRequestsEnabled:
      data?.slackOrchestratorRequestsEnabled === true,
    // This intentionally uses a new key instead of reinterpreting the legacy
    // opt-in `orgMemoryEnabled` preference. Existing installs therefore adopt
    // the new enabled-by-default behavior once, while a subsequent opt-out is
    // persisted normally under the new key.
    orgMemoryInjectionEnabled:
      typeof data?.orgMemoryInjectionEnabled === 'boolean'
        ? data.orgMemoryInjectionEnabled
        : DEFAULT_PREFERENCES.orgMemoryInjectionEnabled,
    localMemoryLearnFromChats: data?.localMemoryLearnFromChats === true,
    localMemoryEnabled:
      typeof data?.localMemoryEnabled === 'boolean'
        ? data.localMemoryEnabled
        : DEFAULT_PREFERENCES.localMemoryEnabled,
    localMemoryEnabledSetByUser:
      typeof data?.localMemoryEnabledSetByUser === 'boolean'
        ? data.localMemoryEnabledSetByUser
        : DEFAULT_PREFERENCES.localMemoryEnabledSetByUser,
    localMemoryModel: localMemoryModel.model,
    localMemoryModelSetByUser: localMemoryModel.setByUser,
    localMemoryThinkingLevel: normalizeThinkingLevel(
      data?.localMemoryThinkingLevel,
      DEFAULT_PREFERENCES.localMemoryThinkingLevel,
    ),
    pipelineAdvisorModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.pipelineAdvisorModel,
      DEFAULT_PREFERENCES.pipelineAdvisorModel,
      modelSelectionValidation,
    ),
    pipelineAdvisorThinkingLevel: normalizeThinkingLevel(
      data?.pipelineAdvisorThinkingLevel,
      DEFAULT_PREFERENCES.pipelineAdvisorThinkingLevel,
    ),
    disabledPipelineIds: normalizeStringArray(data?.disabledPipelineIds),
    appAdvisorModel: normalizePersistableModelSelectionOrDefault(
      data?.appAdvisorModel,
      DEFAULT_PREFERENCES.appAdvisorModel,
      modelSelectionValidation,
    ),
    appAdvisorThinkingLevel: normalizeThinkingLevel(
      data?.appAdvisorThinkingLevel,
      DEFAULT_PREFERENCES.appAdvisorThinkingLevel,
    ),
    cronGenerationModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.cronGenerationModel,
      DEFAULT_PREFERENCES.cronGenerationModel,
      modelSelectionValidation,
    ),
    cronGenerationThinkingLevel: normalizeThinkingLevel(
      data?.cronGenerationThinkingLevel,
      DEFAULT_PREFERENCES.cronGenerationThinkingLevel,
    ),
    ifCommandGenerationModel: normalizePersistablePipelineAdvisorModelOrDefault(
      data?.ifCommandGenerationModel,
      DEFAULT_PREFERENCES.ifCommandGenerationModel,
      modelSelectionValidation,
    ),
    ifCommandGenerationThinkingLevel: normalizeThinkingLevel(
      data?.ifCommandGenerationThinkingLevel,
      DEFAULT_PREFERENCES.ifCommandGenerationThinkingLevel,
    ),
    splitPrThresholdLines: clampNumber(
      normalizeFiniteNumber(
        data?.splitPrThresholdLines,
        DEFAULT_PREFERENCES.splitPrThresholdLines,
      ),
      50,
      100_000,
    ),
    splitPrEnabled: normalizeBoolean(
      data?.splitPrEnabled,
      DEFAULT_PREFERENCES.splitPrEnabled,
    ),
    splitPrPlannerModel: normalizePersistableModelSelectionOrDefault(
      data?.splitPrPlannerModel,
      DEFAULT_PREFERENCES.splitPrPlannerModel,
      modelSelectionValidation,
    ),
    splitPrPlannerThinkingLevel: normalizeThinkingLevel(
      data?.splitPrPlannerThinkingLevel,
      DEFAULT_PREFERENCES.splitPrPlannerThinkingLevel,
    ),
    disabledInstalledItems: normalizeDisabledInstalledItems(
      data?.disabledInstalledItems,
    ),
    parkedCodexPlugins: normalizeParkedCodexPlugins(data?.parkedCodexPlugins),
    pendingInstalledItemUninstalls: normalizePendingInstalledItemUninstalls(
      data?.pendingInstalledItemUninstalls,
    ),
    globalPluginSelections: excludeDisabledInstalledItems(
      normalizeChatTabPluginSelections(data?.globalPluginSelections),
      normalizeDisabledInstalledItems(data?.disabledInstalledItems),
    ),
    ...(Array.isArray(data?.initializedCuratedPluginDefaults)
      ? {
          initializedCuratedPluginDefaults: normalizeStringArray(
            data.initializedCuratedPluginDefaults,
          ),
        }
      : {}),
    appAdvisorPluginSelections: normalizeChatTabPluginSelections(
      data?.appAdvisorPluginSelections,
    ),
    pipelineEditorPluginSelections: normalizeChatTabPluginSelections(
      data?.pipelineEditorPluginSelections,
    ),
    codexMultiAgentAppAdvisorEnabled: normalizeBoolean(
      data?.codexMultiAgentAppAdvisorEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentAppAdvisorEnabled,
    ),
    providerModelConfigDefaults,
    codexFastModeDefaultEnabled:
      providerModelConfigDefaults.codex?.fastMode ?? false,
    branchNamingPluginSelections: normalizeChatTabPluginSelections(
      data?.branchNamingPluginSelections,
    ),
    commitGenerationPluginSelections: normalizeChatTabPluginSelections(
      data?.commitGenerationPluginSelections,
    ),
    prGenerationPluginSelections: normalizeChatTabPluginSelections(
      data?.prGenerationPluginSelections,
    ),
    worktreeSummaryPluginSelections: normalizeChatTabPluginSelections(
      data?.worktreeSummaryPluginSelections,
    ),
    codexCompatDisabledPlugins: normalizeCodexCompatDisabledPlugins(
      data?.codexCompatDisabledPlugins,
    ),
    branchDisplayMappings: normalizeBranchDisplayMappings(
      data?.branchDisplayMappings,
    ),
    reviewCommitMessage:
      typeof data?.reviewCommitMessage === 'boolean'
        ? data.reviewCommitMessage
        : DEFAULT_PREFERENCES.reviewCommitMessage,
    agentRebaseResolutionEnabled:
      typeof data?.agentRebaseResolutionEnabled === 'boolean'
        ? data.agentRebaseResolutionEnabled
        : DEFAULT_PREFERENCES.agentRebaseResolutionEnabled,
    agentRebaseResolutionModel: normalizePersistableModelSelectionOrDefault(
      data?.agentRebaseResolutionModel,
      DEFAULT_PREFERENCES.agentRebaseResolutionModel,
      modelSelectionValidation,
    ),
    agentRebaseResolutionThinkingLevel: normalizeOptionalThinkingLevel(
      data?.agentRebaseResolutionThinkingLevel,
    ),
    mergeQueueAgentHandling: isMergeQueueAgentHandling(
      data?.mergeQueueAgentHandling,
    )
      ? data.mergeQueueAgentHandling
      : DEFAULT_PREFERENCES.mergeQueueAgentHandling,
    rtkEnabled:
      typeof data?.rtkEnabled === 'boolean'
        ? data.rtkEnabled
        : DEFAULT_PREFERENCES.rtkEnabled,
    autoRetryTransientErrorsChats:
      typeof data?.autoRetryTransientErrorsChats === 'boolean'
        ? data.autoRetryTransientErrorsChats
        : DEFAULT_PREFERENCES.autoRetryTransientErrorsChats,
    autoRetryTransientErrorsPipelines:
      typeof data?.autoRetryTransientErrorsPipelines === 'boolean'
        ? data.autoRetryTransientErrorsPipelines
        : DEFAULT_PREFERENCES.autoRetryTransientErrorsPipelines,
    scriptTimeoutMinutes: runtimeLimits.scriptTimeoutMinutes,
    codexAppServerIdleTimeoutMinutes:
      runtimeLimits.codexAppServerIdleTimeoutMinutes,
    claudeSessionIdleTimeoutMinutes:
      runtimeLimits.claudeSessionIdleTimeoutMinutes,
    defaultChatInterfaceMode: isChatInterfaceMode(
      data?.defaultChatInterfaceMode,
    )
      ? data.defaultChatInterfaceMode
      : DEFAULT_PREFERENCES.defaultChatInterfaceMode,
    defaultStandaloneChatInterfaceMode: isChatInterfaceMode(
      data?.defaultStandaloneChatInterfaceMode,
    )
      ? data.defaultStandaloneChatInterfaceMode
      : DEFAULT_PREFERENCES.defaultStandaloneChatInterfaceMode,
    defaultAppAdvisorInterfaceMode: isChatInterfaceMode(
      data?.defaultAppAdvisorInterfaceMode,
    )
      ? data.defaultAppAdvisorInterfaceMode
      : DEFAULT_PREFERENCES.defaultAppAdvisorInterfaceMode,
    preventClaudeNativeCaffeinate: normalizeBoolean(
      data?.preventClaudeNativeCaffeinate,
      DEFAULT_PREFERENCES.preventClaudeNativeCaffeinate,
    ),
    claudeMaxTurns: normalizeClaudeMaxTurns(data?.claudeMaxTurns),
    maxActiveChatTurns: runtimeLimits.maxActiveChatTurns,
    maxActivePipelineExecutions: runtimeLimits.maxActivePipelineExecutions,
    canopyBackgroundProcessesMode: isBackgroundProcessMode(
      data?.canopyBackgroundProcessesMode,
    )
      ? data.canopyBackgroundProcessesMode
      : DEFAULT_PREFERENCES.canopyBackgroundProcessesMode,
    pipelinesMode: isBackgroundProcessMode(data?.pipelinesMode)
      ? data.pipelinesMode
      : DEFAULT_PREFERENCES.pipelinesMode,
    workerConcurrencyLimit:
      typeof data?.workerConcurrencyLimit === 'number' &&
      Number.isFinite(data.workerConcurrencyLimit)
        ? clampNumber(Math.round(data.workerConcurrencyLimit), 1, 16)
        : DEFAULT_PREFERENCES.workerConcurrencyLimit,
    memoryPressureGuardEnabled: runtimeLimits.memoryPressureGuardEnabled,
    bypassCodexAppServerIdleTimeoutUnderCriticalPressure:
      runtimeLimits.bypassCodexAppServerIdleTimeoutUnderCriticalPressure,
    memoryPressureWarningThresholdBytes:
      runtimeLimits.memoryPressureWarningThresholdBytes,
    memoryPressureCriticalThresholdBytes:
      runtimeLimits.memoryPressureCriticalThresholdBytes,
    memoryDiagnosticsEnabled:
      typeof data?.memoryDiagnosticsEnabled === 'boolean'
        ? data.memoryDiagnosticsEnabled
        : DEFAULT_PREFERENCES.memoryDiagnosticsEnabled,
    keepSystemAwakeWhileAgentsActive:
      typeof data?.keepSystemAwakeWhileAgentsActive === 'boolean'
        ? data.keepSystemAwakeWhileAgentsActive
        : DEFAULT_PREFERENCES.keepSystemAwakeWhileAgentsActive,
    managedDelegationMaxDepth: normalizeManagedDelegationMaxDepth(
      data?.managedDelegationMaxDepth,
    ),
    managedDelegationMaxConcurrent: normalizeManagedDelegationMaxConcurrent(
      data?.managedDelegationMaxConcurrent,
    ),
    managedDelegationLifetimeLimit: normalizeManagedDelegationLifetimeLimit(
      data?.managedDelegationLifetimeLimit,
    ),
    ...(data?.managedDelegationModelPolicy === undefined
      ? {}
      : {
          managedDelegationModelPolicy: normalizeManagedDelegationModelPolicy(
            data.managedDelegationModelPolicy,
          ),
        }),
    ...(data?.managedDelegationMode === undefined
      ? {}
      : {
          managedDelegationMode: normalizeManagedDelegationMode(
            data.managedDelegationMode,
          ),
        }),
    codexMultiAgentWorktreeChatsEnabled: normalizeBoolean(
      data?.codexMultiAgentWorktreeChatsEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentWorktreeChatsEnabled,
    ),
    codexMultiAgentStandaloneChatsEnabled: normalizeBoolean(
      data?.codexMultiAgentStandaloneChatsEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentStandaloneChatsEnabled,
    ),
    codexMaxConcurrentSubagents: normalizeCodexMaxConcurrentSubagents(
      data?.codexMaxConcurrentSubagents,
    ),
    codexMultiAgentPipelinesEnabled: normalizeBoolean(
      data?.codexMultiAgentPipelinesEnabled,
      DEFAULT_PREFERENCES.codexMultiAgentPipelinesEnabled,
    ),
    deferredToolsWorktreeChatsEnabled: normalizeBoolean(
      data?.deferredToolsWorktreeChatsEnabled,
      DEFAULT_PREFERENCES.deferredToolsWorktreeChatsEnabled ?? true,
    ),
    deferredToolsStandaloneChatsEnabled: normalizeBoolean(
      data?.deferredToolsStandaloneChatsEnabled,
      DEFAULT_PREFERENCES.deferredToolsStandaloneChatsEnabled ?? true,
    ),
    deferredToolsAppAdvisorEnabled: normalizeBoolean(
      data?.deferredToolsAppAdvisorEnabled,
      DEFAULT_PREFERENCES.deferredToolsAppAdvisorEnabled ?? true,
    ),
    deferredToolsPipelineAssistantEnabled: normalizeBoolean(
      data?.deferredToolsPipelineAssistantEnabled,
      DEFAULT_PREFERENCES.deferredToolsPipelineAssistantEnabled ?? true,
    ),
    lastOpenApp:
      typeof data?.lastOpenApp === 'string'
        ? data.lastOpenApp
        : DEFAULT_PREFERENCES.lastOpenApp,
    disabledOpenApps: Array.isArray(data?.disabledOpenApps)
      ? data.disabledOpenApps.filter(
          (v: unknown): v is string => typeof v === 'string',
        )
      : DEFAULT_PREFERENCES.disabledOpenApps,
    lastSelectedWorktreeProjectId:
      typeof data?.lastSelectedWorktreeProjectId === 'string'
        ? data.lastSelectedWorktreeProjectId
        : DEFAULT_PREFERENCES.lastSelectedWorktreeProjectId,
    lastSelectedWorktreeId:
      typeof data?.lastSelectedWorktreeId === 'string'
        ? data.lastSelectedWorktreeId
        : DEFAULT_PREFERENCES.lastSelectedWorktreeId,
    lastActiveContext: normalizeLastActiveContext(data?.lastActiveContext),
    executionDetailViewMode:
      data?.executionDetailViewMode === 'list' ||
      data?.executionDetailViewMode === 'flow'
        ? data.executionDetailViewMode
        : DEFAULT_PREFERENCES.executionDetailViewMode,
    worktreeViewMode:
      data?.worktreeViewMode === 'list' || data?.worktreeViewMode === 'kanban'
        ? data.worktreeViewMode
        : DEFAULT_PREFERENCES.worktreeViewMode,
    worktreeFilterHiddenWorkspaceIds: Array.isArray(
      data?.worktreeFilterHiddenWorkspaceIds,
    )
      ? data.worktreeFilterHiddenWorkspaceIds.filter(
          (v: unknown): v is string => typeof v === 'string',
        )
      : DEFAULT_PREFERENCES.worktreeFilterHiddenWorkspaceIds,
    auditRetentionDays: runtimeLimits.auditRetentionDays,
    automationRunRetentionDays: runtimeLimits.automationRunRetentionDays,
    singleDollarMath:
      typeof data?.singleDollarMath === 'boolean'
        ? data.singleDollarMath
        : DEFAULT_PREFERENCES.singleDollarMath,
    promptSuggestionsEnabled:
      typeof data?.promptSuggestionsEnabled === 'boolean'
        ? data.promptSuggestionsEnabled
        : DEFAULT_PREFERENCES.promptSuggestionsEnabled,
    linearChatEnrichmentMode: isChatEnrichmentMode(
      data?.linearChatEnrichmentMode,
    )
      ? data.linearChatEnrichmentMode
      : DEFAULT_LINEAR_CHAT_ENRICHMENT_MODE,
    githubChatEnrichmentMode: isChatEnrichmentMode(
      data?.githubChatEnrichmentMode,
    )
      ? data.githubChatEnrichmentMode
      : DEFAULT_GITHUB_CHAT_ENRICHMENT_MODE,
    // Always a boolean, on unless the user turned it off: preferences written
    // before the setting existed keep agents recording in the Ledger.
    ledgerAgentRecordingEnabled:
      typeof data?.ledgerAgentRecordingEnabled === 'boolean'
        ? data.ledgerAgentRecordingEnabled
        : DEFAULT_PREFERENCES.ledgerAgentRecordingEnabled,
    // On unless the user turned it off, as for preferences written before
    // the setting existed.
    suggestions: normalizeSuggestionsState(
      data?.suggestions,
      data?.repeatTaskAutomationSuggestionsEnabled,
    ),
    ...(typeof data?.repeatTaskAutomationSuggestionsEnabled === 'boolean'
      ? {
          repeatTaskAutomationSuggestionsEnabled:
            data.repeatTaskAutomationSuggestionsEnabled,
        }
      : {}),
    skillSuggestionsEnabled:
      typeof data?.skillSuggestionsEnabled === 'boolean'
        ? data.skillSuggestionsEnabled
        : DEFAULT_PREFERENCES.skillSuggestionsEnabled,
    // Off unless explicitly on; the next launch moves storage to match.
    rendererCodeCacheSchemeEnabled:
      data?.rendererCodeCacheSchemeEnabled === true,
    chatDetail: normalizeChatDetailPreference(data),
    ollamaServerPort:
      typeof data?.ollamaServerPort === 'number' &&
      Number.isFinite(data.ollamaServerPort) &&
      data.ollamaServerPort > 0 &&
      data.ollamaServerPort <= 65535
        ? Math.round(data.ollamaServerPort)
        : DEFAULT_PREFERENCES.ollamaServerPort,
    // Transport contract: minimal shape normalization so the field is always
    // present. The full migration behavior (Windows/older-macOS compatibility,
    // legacy value mapping) is owned by the backend plan.
    ollamaConnectionMode:
      data?.ollamaConnectionMode === 'managed' ||
      data?.ollamaConnectionMode === 'manual'
        ? data.ollamaConnectionMode
        : DEFAULT_PREFERENCES.ollamaConnectionMode,
    ollamaExecutablePath: normalizeString(
      data?.ollamaExecutablePath,
      DEFAULT_PREFERENCES.ollamaExecutablePath,
    ),
    mcpProxyPort:
      typeof data?.mcpProxyPort === 'number' &&
      Number.isFinite(data.mcpProxyPort) &&
      data.mcpProxyPort > 0 &&
      data.mcpProxyPort <= 65535
        ? Math.round(data.mcpProxyPort)
        : DEFAULT_PREFERENCES.mcpProxyPort,
    hideAnthropicNav:
      typeof data?.hideAnthropicNav === 'boolean'
        ? data.hideAnthropicNav
        : DEFAULT_PREFERENCES.hideAnthropicNav,
    aiCreditsRoutingMode: isAiCreditsRoutingMode(data?.aiCreditsRoutingMode)
      ? data.aiCreditsRoutingMode
      : DEFAULT_PREFERENCES.aiCreditsRoutingMode,
    // Intentionally NOT defaulted: unset must stay unset so users who never
    // touch the "Use AI Credits" toggle preserve today's seeding behavior.
    lastChatBillingFramework: isChatBillingFramework(
      data?.lastChatBillingFramework,
    )
      ? data.lastChatBillingFramework
      : undefined,
    fileAutoSave:
      typeof data?.fileAutoSave === 'boolean'
        ? data.fileAutoSave
        : DEFAULT_PREFERENCES.fileAutoSave,
    inAppBrowserLocalServersOnly:
      typeof data?.inAppBrowserLocalServersOnly === 'boolean'
        ? data.inAppBrowserLocalServersOnly
        : DEFAULT_PREFERENCES.inAppBrowserLocalServersOnly,
    inAppBrowserSearchEngineId:
      typeof data?.inAppBrowserSearchEngineId === 'string' &&
      data.inAppBrowserSearchEngineId.trim().length > 0
        ? data.inAppBrowserSearchEngineId.trim()
        : DEFAULT_PREFERENCES.inAppBrowserSearchEngineId,
    inAppBrowserCustomSearchEngines: normalizeCustomBrowserSearchEngines(
      data?.inAppBrowserCustomSearchEngines,
    ),
    openAppLinksInBuiltInBrowser:
      typeof data?.openAppLinksInBuiltInBrowser === 'boolean'
        ? data.openAppLinksInBuiltInBrowser
        : DEFAULT_PREFERENCES.openAppLinksInBuiltInBrowser,
    useAsSystemDefaultBrowser:
      typeof data?.useAsSystemDefaultBrowser === 'boolean'
        ? data.useAsSystemDefaultBrowser
        : DEFAULT_PREFERENCES.useAsSystemDefaultBrowser,
    inAppNotifications: normalizeInAppNotifications(
      data?.inAppNotifications,
      data?.osNotifications,
    ),
    terminalDrawerActiveTabId: isBrowserDrawerTabId(
      data?.terminalDrawerActiveTabId,
    )
      ? data.terminalDrawerActiveTabId
      : DEFAULT_PREFERENCES.terminalDrawerActiveTabId,
    disabledTerminalShellProfileIds: Array.isArray(
      data?.disabledTerminalShellProfileIds,
    )
      ? Array.from(
          new Set(
            data.disabledTerminalShellProfileIds.filter(
              isTerminalShellProfileId,
            ),
          ),
        )
      : DEFAULT_PREFERENCES.disabledTerminalShellProfileIds,
    terminalPresets: normalizeTerminalPresets(data?.terminalPresets),
    terminalSettingsRevision: normalizeTerminalSettingsRevision(
      data?.terminalSettingsRevision,
    ),
    osNotifications: normalizeOsNotifications(data?.osNotifications),
    voiceDictationEnabled:
      typeof data?.voiceDictationEnabled === 'boolean'
        ? data.voiceDictationEnabled
        : DEFAULT_PREFERENCES.voiceDictationEnabled,
    closeToTray:
      typeof data?.closeToTray === 'boolean'
        ? data.closeToTray
        : DEFAULT_PREFERENCES.closeToTray,
    globalFocusShortcutEnabled:
      typeof data?.globalFocusShortcutEnabled === 'boolean'
        ? data.globalFocusShortcutEnabled
        : DEFAULT_PREFERENCES.globalFocusShortcutEnabled,
    globalFocusShortcut: normalizeGlobalFocusShortcut(
      data?.globalFocusShortcut,
    ),
    activationQuietHours: normalizeActivationQuietHours(
      data?.activationQuietHours,
    ),
    promotionalNotifications: normalizePromotionalNotifications(
      data?.promotionalNotifications,
      normalizeOsNotifications(data?.osNotifications).categories.activation,
    ),
    ...(typeof data?.osNotificationsDeniedAt === 'string'
      ? { osNotificationsDeniedAt: data.osNotificationsDeniedAt }
      : {}),
    ...(osNotificationOfferAnsweredAt !== undefined
      ? { osNotificationOfferAnsweredAt }
      : {}),
    ...(typeof data?.closeToTrayDisclosedAt === 'string'
      ? { closeToTrayDisclosedAt: data.closeToTrayDisclosedAt }
      : {}),
    mcpHttpAuthDefaultHandler:
      data?.mcpHttpAuthDefaultHandler === 'canopy' ||
      data?.mcpHttpAuthDefaultHandler === 'provider' ||
      data?.mcpHttpAuthDefaultHandler === 'account'
        ? data.mcpHttpAuthDefaultHandler
        : DEFAULT_PREFERENCES.mcpHttpAuthDefaultHandler,
    fileIndexing: normalizeFileIndexingPreferences(data?.fileIndexing),
    planDetection: normalizePlanDetectionPreferences(data?.planDetection),
    fileLabels: normalizeFileLabels(data?.fileLabels),
    changedFilesHiddenLabelIds: Array.isArray(data?.changedFilesHiddenLabelIds)
      ? Array.from(
          new Set(
            data.changedFilesHiddenLabelIds.filter(
              (v: unknown): v is string => typeof v === 'string',
            ),
          ),
        )
      : DEFAULT_PREFERENCES.changedFilesHiddenLabelIds,
    autoDownloadUpdates:
      typeof data?.autoDownloadUpdates === 'boolean'
        ? data.autoDownloadUpdates
        : DEFAULT_PREFERENCES.autoDownloadUpdates,
    automaticUpdateChecks:
      typeof data?.automaticUpdateChecks === 'boolean'
        ? data.automaticUpdateChecks
        : DEFAULT_PREFERENCES.automaticUpdateChecks,
    showDiagnosticsPill:
      typeof data?.showDiagnosticsPill === 'boolean'
        ? data.showDiagnosticsPill
        : DEFAULT_PREFERENCES.showDiagnosticsPill,
    onboardingCompleted,
    releaseHighlightsLastSeenVersion:
      typeof data?.releaseHighlightsLastSeenVersion === 'string'
        ? data.releaseHighlightsLastSeenVersion.trim() || null
        : null,
    guestSessionCount: Math.max(
      0,
      Math.floor(
        normalizeFiniteNumber(
          data?.guestSessionCount,
          DEFAULT_PREFERENCES.guestSessionCount ?? 0,
        ),
      ),
    ),
    guestUpgradeNudgeLastShownSessionCount: Math.max(
      0,
      Math.floor(
        normalizeFiniteNumber(
          data?.guestUpgradeNudgeLastShownSessionCount,
          DEFAULT_PREFERENCES.guestUpgradeNudgeLastShownSessionCount ?? 0,
        ),
      ),
    ),
    ...(typeof data?.mobileInstallCueSnoozedUntil === 'string' &&
    data.mobileInstallCueSnoozedUntil.trim().length > 0
      ? { mobileInstallCueSnoozedUntil: data.mobileInstallCueSnoozedUntil }
      : {}),
    ...(homeOnboardingSuggestions !== undefined
      ? { homeOnboardingSuggestions }
      : {}),
    ...(planModeHint !== undefined ? { planModeHint } : {}),
    ...(githubStarPrompt !== undefined ? { githubStarPrompt } : {}),
    ...buildOnboardingProfileFields(data),
    ...(typeof data?.guestConsentAcceptedAt === 'string' &&
    data.guestConsentAcceptedAt.trim().length > 0
      ? { guestConsentAcceptedAt: data.guestConsentAcceptedAt }
      : {}),
    ...(typeof data?.guestConsentTosVersion === 'string' &&
    data.guestConsentTosVersion.trim().length > 0
      ? { guestConsentTosVersion: data.guestConsentTosVersion }
      : {}),
    ...(typeof data?.legalConsentAcceptedAt === 'string' &&
    data.legalConsentAcceptedAt.trim().length > 0
      ? { legalConsentAcceptedAt: data.legalConsentAcceptedAt }
      : {}),
    ...(typeof data?.legalConsentTosVersion === 'string' &&
    data.legalConsentTosVersion.trim().length > 0
      ? { legalConsentTosVersion: data.legalConsentTosVersion }
      : {}),
    ...(typeof data?.dataChoicesConfirmedAt === 'string' &&
    data.dataChoicesConfirmedAt.trim().length > 0
      ? { dataChoicesConfirmedAt: data.dataChoicesConfirmedAt }
      : {}),
    // Only meaningful while Usage analytics stays off: the first commit that
    // turns it on clears the flag, so a later Settings opt-out pings as usual.
    usageAnalyticsDeclinedAtOnboarding:
      data?.usageAnalyticsDeclinedAtOnboarding === true &&
      !usageData.productAnalytics,
    ...(orgSharingNoticesSeen ? { orgSharingNoticesSeen } : {}),
    personalWorkspaceCatalogSync:
      data?.personalWorkspaceCatalogSync === 'private' ? 'private' : 'off',
    personalCatalogOfferSeen: data?.personalCatalogOfferSeen === true,
    personalCatalogNotice:
      data?.personalCatalogNotice === 'collision' ||
      data?.personalCatalogNotice === 'removed' ||
      data?.personalCatalogNotice === 'full' ||
      data?.personalCatalogNotice === 'failed'
        ? data.personalCatalogNotice
        : null,
    ...(dataSharingOptInHints ? { dataSharingOptInHints } : {}),
    ...(dataSharingOptInHistory ? { dataSharingOptInHistory } : {}),
    ...(nativeProviderAccounts ? { nativeProviderAccounts } : {}),
    usageData,
    telemetrySharing: normalizeTelemetrySharing(data?.telemetrySharing),
    // Legacy tier marker: kept as read so older files round-trip; nothing
    // writes it, and plan changes never rewrite `telemetrySharing`.
    ...(data?.telemetrySharingTier === 'free' ||
    data?.telemetrySharingTier === 'paid'
      ? { telemetrySharingTier: data.telemetrySharingTier }
      : {}),
    telemetrySharingPromptSeen:
      typeof data?.telemetrySharingPromptSeen === 'boolean'
        ? data.telemetrySharingPromptSeen
        : DEFAULT_PREFERENCES.telemetrySharingPromptSeen,
    gitExecutablePath: normalizeString(
      data?.gitExecutablePath,
      DEFAULT_PREFERENCES.gitExecutablePath,
    ),
    appAdvisorProjectAgentAccess: normalizeAppAdvisorProjectAgentAccess(
      data?.appAdvisorProjectAgentAccess,
    ),
    codeGraph: normalizeCodeGraphPreferences(data?.codeGraph),
  };
}
