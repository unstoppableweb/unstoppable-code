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
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../constants/preferences';
import {
  normalizeManagedDelegationMode,
  normalizeManagedDelegationMaxConcurrent,
  normalizeManagedDelegationMaxDepth,
  normalizeManagedDelegationLifetimeLimit,
} from '@canopy/protocol/delegation/discovery';
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
  MAX_TERMINAL_DRAWER_HEIGHT,
  MIN_TERMINAL_DRAWER_HEIGHT,
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
import { clampUiScale } from '../../lib/ui-scale';
import { DEFAULT_PREFERENCES } from './defaults';
import { normalizeTerminalSettingsRevision } from './terminal-settings';
import {
  normalizeLastActiveContext,
  isBrowserDrawerTabId,
  isBranchNamePrefixMode,
  isPrInstructionMode,
  isThemeName,
  isColorMode,
  isSidebarAppearance,
  isWorktreeDiffStatsStyle,
  isScrollbarBehavior,
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
  normalizeLayoutPreferences,
  normalizeProviderDefaults,
  normalizeRuntimeLimits,
} from './model-normalizers';
import {
  normalizeWindowBounds,
  normalizeAppAdvisorDialogBounds,
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

export function normalizePreferences(
  data: Partial<PreferencesData> | Record<string, unknown> | undefined,
  modelSelectionValidation: ModelSelectionValidation = 'runtime',
): PreferencesData {
  const layout = normalizeLayoutPreferences(data);
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

  return {
    cursorEnabled: data?.cursorEnabled === true,
    copilotEnabled: data?.copilotEnabled === true,
    opencodeEnabled: data?.opencodeEnabled === true,
    accountProxyEnabled: data?.accountProxyEnabled === true,
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
    worktreePanelPercent: layout.worktreePanelPercent,
    activityPanelExpanded:
      typeof data?.activityPanelExpanded === 'boolean'
        ? data.activityPanelExpanded
        : DEFAULT_PREFERENCES.activityPanelExpanded,
    activityPanelWidthPercent: layout.activityPanelWidthPercent,
    kanbanWorktreePanelPercent: layout.kanbanWorktreePanelPercent,
    kanbanActivityPanelExpanded:
      typeof data?.kanbanActivityPanelExpanded === 'boolean'
        ? data.kanbanActivityPanelExpanded
        : DEFAULT_PREFERENCES.kanbanActivityPanelExpanded,
    kanbanActivityPanelWidthPercent: layout.kanbanActivityPanelWidthPercent,
    kanbanChatPanelVisible:
      typeof data?.kanbanChatPanelVisible === 'boolean'
        ? data.kanbanChatPanelVisible
        : DEFAULT_PREFERENCES.kanbanChatPanelVisible,
    pipelineChatPanelVisible:
      typeof data?.pipelineChatPanelVisible === 'boolean'
        ? data.pipelineChatPanelVisible
        : DEFAULT_PREFERENCES.pipelineChatPanelVisible,
    pipelineChatPanelWidthPercent: clampNumber(
      normalizeFiniteNumber(
        data?.pipelineChatPanelWidthPercent,
        DEFAULT_PREFERENCES.pipelineChatPanelWidthPercent ?? 30,
      ),
      20,
      65,
    ),
    sidebarCollapsed:
      typeof data?.sidebarCollapsed === 'boolean'
        ? data.sidebarCollapsed
        : DEFAULT_PREFERENCES.sidebarCollapsed,
    sidebarProjectSortMode:
      data?.sidebarProjectSortMode === 'last-updated'
        ? 'last-updated'
        : 'manual',
    sidebarWidth: clampNumber(
      normalizeFiniteNumber(
        data?.sidebarWidth,
        DEFAULT_PREFERENCES.sidebarWidth,
      ),
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
    ),
    sidebarCodeSectionCollapsed:
      typeof data?.sidebarCodeSectionCollapsed === 'boolean'
        ? data.sidebarCodeSectionCollapsed
        : DEFAULT_PREFERENCES.sidebarCodeSectionCollapsed,
    sidebarCoworkSectionCollapsed:
      typeof data?.sidebarCoworkSectionCollapsed === 'boolean'
        ? data.sidebarCoworkSectionCollapsed
        : DEFAULT_PREFERENCES.sidebarCoworkSectionCollapsed,
    sidebarOrchestratorCollapsed:
      typeof data?.sidebarOrchestratorCollapsed === 'boolean'
        ? data.sidebarOrchestratorCollapsed
        : DEFAULT_PREFERENCES.sidebarOrchestratorCollapsed,
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
    // This intentionally uses a new key instead of reinterpreting the legacy
    // opt-in `orgMemoryEnabled` preference. Existing installs therefore adopt
    // the new enabled-by-default behavior once, while a subsequent opt-out is
    // persisted normally under the new key.
    orgMemoryInjectionEnabled:
      typeof data?.orgMemoryInjectionEnabled === 'boolean'
        ? data.orgMemoryInjectionEnabled
        : DEFAULT_PREFERENCES.orgMemoryInjectionEnabled,
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
    appAdvisorDialogBounds: normalizeAppAdvisorDialogBounds(
      data?.appAdvisorDialogBounds,
    ),
    // Optional: only persisted once the user has toggled the App Advisor
    // popout nav (absent = expanded default).
    ...(typeof data?.appAdvisorNavCollapsed === 'boolean'
      ? { appAdvisorNavCollapsed: data.appAdvisorNavCollapsed }
      : {}),
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
    theme: isThemeName(data?.theme) ? data.theme : DEFAULT_PREFERENCES.theme,
    colorMode: isColorMode(data?.colorMode)
      ? data.colorMode
      : DEFAULT_PREFERENCES.colorMode,
    sidebarAppearance: isSidebarAppearance(data?.sidebarAppearance)
      ? data.sidebarAppearance
      : DEFAULT_PREFERENCES.sidebarAppearance,
    worktreeDiffStatsStyle: isWorktreeDiffStatsStyle(
      data?.worktreeDiffStatsStyle,
    )
      ? data.worktreeDiffStatsStyle
      : DEFAULT_PREFERENCES.worktreeDiffStatsStyle,
    scrollbarBehavior: isScrollbarBehavior(data?.scrollbarBehavior)
      ? data.scrollbarBehavior
      : DEFAULT_PREFERENCES.scrollbarBehavior,
    singleDollarMath:
      typeof data?.singleDollarMath === 'boolean'
        ? data.singleDollarMath
        : DEFAULT_PREFERENCES.singleDollarMath,
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
    // Clamped and snapped through the shared helper the Display slider and
    // the View-menu zoom items also use, so no surface can offer a scale the
    // store would rewrite behind it.
    uiScale: clampUiScale(
      typeof data?.uiScale === 'number' ? data.uiScale : undefined,
    ),
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
    // On unless the user turned it off.
    remoteControlEnabled: data?.remoteControlEnabled !== false,
    windowBounds: normalizeWindowBounds(data?.windowBounds),
    windowMaximized:
      typeof data?.windowMaximized === 'boolean'
        ? data.windowMaximized
        : DEFAULT_PREFERENCES.windowMaximized,
    windowFullScreen:
      typeof data?.windowFullScreen === 'boolean'
        ? data.windowFullScreen
        : DEFAULT_PREFERENCES.windowFullScreen,
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
    terminalDrawerCollapsed:
      typeof data?.terminalDrawerCollapsed === 'boolean'
        ? data.terminalDrawerCollapsed
        : DEFAULT_PREFERENCES.terminalDrawerCollapsed,
    terminalDrawerHeight:
      typeof data?.terminalDrawerHeight === 'number' &&
      Number.isFinite(data.terminalDrawerHeight)
        ? Math.min(
            MAX_TERMINAL_DRAWER_HEIGHT,
            Math.max(
              MIN_TERMINAL_DRAWER_HEIGHT,
              Math.round(data.terminalDrawerHeight),
            ),
          )
        : DEFAULT_PREFERENCES.terminalDrawerHeight,
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
    usageData: normalizeUsageData(data?.usageData),
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
