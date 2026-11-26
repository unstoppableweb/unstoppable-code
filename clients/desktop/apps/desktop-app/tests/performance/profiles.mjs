import {
  HEADLESS_STUDY_MODE,
  HEADLESS_STUDY_VIEWPORT,
} from './browser-profiles-evidence.mjs';
import {
  REMOTE_CONTROL_USAGE,
  isRemoteControlOption,
  recordRemoteControlOption,
  remoteControlConfig,
} from './remote-control-connected/options.mjs';
export const RESPONSIVENESS_THRESHOLDS = Object.freeze({
  rendererFrameDelayMaxMs: 100,
  rendererKeyToPaintConfirmationP95Ms: 100,
  rendererKeyToPaintConfirmationMaxMs: 250,
  rendererLongTaskMaxMs: 100,
  ipcOuterMaxMs: 250,
});

const WORKLOAD_PROFILES = Object.freeze({
  smoke: Object.freeze({
    loadedChatTabs: 8,
    loadedTurnsPerChat: 6,
    loadedPipelineExecutions: 8,
    pipelineHistoryExecutions: 60,
    pipelineHistoryTotalBytes: 8_000_000,
    pipelineHistoryListIterations: 2,
    browserHistoricalPartitions: 16,
    browserActionWarmups: 2,
    browserActionIterations: 5,
    browserAgentActionsWarmups: 2,
    browserAgentActionsIterations: 3,
    browserPostCloseSettleMs: 500,
    archivePayloadBytes: 8 * 1024 * 1024,
    codeReviewRegistryDeleteCycles: 1,
    codeReviewRegistryMissingDeletes: 1,
    codeReviewRegistryMatchingRows: 1,
    codeReviewRegistryUnrelatedRows: 10,
    codeReviewRegistryRegisterIterations: 5,
    innerPanelCollapseWarmups: 1,
    innerPanelCollapseIterations: 3,
    planOpenSections: 12,
    planOpenTasksPerSection: 4,
    planOpenParagraphBytes: 480,
    planOpenDiagramTasksPerSection: 2,
    planOpenCommentThreads: 6,
    planOpenIterations: 3,
    chatSearchIndexBodyBytes: 8_000_000,
    pluginPickerPlugins: 170,
    pluginPickerSkills: 20,
    pluginPickerMcpServers: 10,
    pluginPickerSearchIterations: 3,
    fileExplorerDirectories: 24,
    fileExplorerFilesPerDirectory: 80,
    fileExplorerMutationBurst: 40,
    menuSurfacesIterations: 3,
    frameSmoothnessIterations: 3,
    frameSmoothnessSidebarEntries: 40,
    startupSettleMs: 8_000,
    startupTypingIntervalMs: 250,
    startupBackgroundIdleDwellMs: 5_500,
    startupBackgroundProbeMs: 3_000,
    startupWorktrees: 8,
    startupWorkspaces: 4,
    realisticStartupWorktrees: 8,
    realisticStartupWorkspaces: 4,
    realisticStartupRepositories: 3,
    realisticStartupGraphFilesPerRepo: 300,
    realisticStartupObserveMs: 20_000,
    powerUserWorkspaces: 8,
    powerUserWorktrees: 12,
    powerUserRepositories: 3,
    powerUserCoworkWorkspaces: 2,
    powerUserCoworkEntries: 10,
    powerUserChatTabs: 80,
    powerUserMessages: 6_000,
    powerUserPipelineExecutions: 60,
    powerUserPipelineTotalBytes: 8_000_000,
    powerUserPanelLayouts: 12,
    powerUserFiredWatchers: 100,
    powerUserAutomations: 8,
    powerUserAutomationRuns: 10,
    powerUserGraphFilesPerRepo: 150,
    powerUserObserveMs: 15_000,
    // CAN-6932: a desktop holding many retained worktrees, mostly in
    // one project, with chats and fired watchers.
    retainedWorktrees: 30,
    retainedSettleMs: 10_000,
    retainedIdleMs: 10_000,
    retainedActiveMs: 10_000,
    retainedStaleIntervalMs: 500,
    retainedFocusIntervalMs: 1_000,
    navigationIterations: 3,
    interactionIterations: 2,
    stressTranscriptTurns: 25,
    stressTranscriptBatches: 160,
    stressTranscriptFinalBytes: 26_000,
    largeTranscriptWorktrees: 3,
    largeTranscriptLiveChatsPerWorktree: 2,
    largeTranscriptArchivedChatsPerWorktree: 3,
    largeTranscriptNavigationIterations: 3,
    largeTranscriptArchiveViews: 1,
    largeTranscriptDenseMessages: 600,
    largeTranscriptDenseMessageBytes: 256,
    largeTranscriptRichMessages: 240,
    largeTranscriptRichMessageBytes: 1_024,
    largeTranscriptArchiveMessages: 60,
    largeTranscriptArchiveMessageBytes: 1_024,
    coworkDefaultShortMessages: 6,
    coworkDefaultShortMessageBytes: 256,
    coworkDefaultLongMessages: 24,
    coworkDefaultLongMessageBytes: 512,
    coworkDefaultPipelineMessages: 8,
    coworkDefaultPipelineMessageBytes: 512,
    mathTranscriptLightElements: 12,
    mathTranscriptMediumElements: 8,
    mathTranscriptHeavyElements: 4,
    mathTranscriptNavigationIterations: 3,
    linearReferenceMessages: 80,
    linearReferenceNavigationIterations: 2,
    typingCharacters: 48,
    responsivenessBudgetMs: 5_000,
    responsivenessThresholds: RESPONSIVENESS_THRESHOLDS,
    concurrentChats: 2,
    chatStreamMs: 60_000,
    chatReplyCharacters: 500,
    transcriptStreamMs: 12_000,
    transcriptStreamCharacters: 16_000,
    transcriptStreamChunkCharacters: 64,
    transcriptActiveTurnCharacters: 32_000,
    transcriptToolExchanges: 24,
    transcriptRetentionCycles: 4,
    concurrentPipelines: 2,
    pipelineHoldMs: 5_000,
    scriptHoldMs: 10_000,
    scriptCpuWorkers: 2,
    scriptOutputIntervalMs: 25,
    scriptOutputLinesPerTick: 32,
    scriptFilesPerTick: 8,
    scriptFileBytes: 8_192,
    scriptSpawnIntervalMs: 250,
    gitCheckoutFiles: 6_000,
    gitCheckoutFileBytes: 512,
    gitTypingCharacters: 16,
    sustainedTypingIntervalMs: 500,
    gitGateReleaseAfterKeys: 4,
    gitGateMaxHoldMs: 180_000,
    worktreesToCreate: 2,
    preexistingWorktrees: 52,
    w5StoreWorkspaces: 5,
    w5StoreLargeWorkspaceWorktrees: 30,
    w5StoreReloads: 3,
    w5StoreWriteCycles: 1,
    w5StoreBurstSequential: 20,
    w5StoreBurstWarmup: 5,
    w5StoreBurstConcurrent: 5,
    codeGraphBuildWorktrees: 3,
    codeGraphFixtureFilesPerWorktree: 1_200,
    ledgerScopeEntries: 1_000,
    ledgerOtherScopes: 9,
    ledgerOtherScopeEntries: 100,
    ledgerRoundTrips: 10,
    ledgerIdleDwellMs: 5_000,
    costIndexAuditDays: 2,
    costIndexAuditLinesPerDay: 10_000,
    costIndexAuditTurnsPerDay: 100,
    costIndexDwellMs: 75_000,
    costIndexTypingIntervalMs: 10_000,
    transcriptToolActiveTurnSizes: Object.freeze([10, 100, 1_000]),
    multiChatStreamingChats: 5,
    multiChatStreamingMs: 20_000,
    multiChatStreamingToolIntervalMs: 300,
    multiChatStreamingLargeOutputs: 1,
    multiChatStreamingLargeOutputBytes: 72 * 1024,
    multiChatStreamingCommandOutputDeltas: 40,
    multiChatStreamingCommandOutputDeltaBytes: 4_096,
    multiChatStreamingCommandOutputIntervalMs: 100,
    multiChatStreamingRatioBracketUpdates: 8,
    chatSwitchCatchUpEvents: 4,
    managedDelegationTranscriptBytes: 1024 * 1024,
    managedDelegationChildSteps: 6,
    managedDelegationChildStepMs: 400,
    delegationCyclesTranscriptBytes: 8 * 1024 * 1024,
    delegationCyclesHistoryCards: 60,
    delegationCycles: 2,
    projectsReloadCycles: 40,
    ownedAutomations: 770,
    ownedAutomationListSamples: 3,
    ownedAutomationWrites: 2,
    pipelineDefinitions: 50,
    pipelineDefinitionSamples: 5,
    delegationCyclesDelegates: 3,
    delegationCyclesChildSteps: 60,
    delegationCyclesChildStepMs: 500,
    delegationCyclesParentStreamMs: 90_000,
    codeGraphQueuedRefreshes: 3,
    codeGraphNewWorktreeFiles: 300,
    codeGraphAgentReadsLaterTurns: 6,
    codeGraphAgentReadsFixtureFiles: 120,
    codeGraphSmallEditSmallFiles: 100,
    codeGraphSmallEditLargeFiles: 1_300,
    claudeGraphOrientationLaterTurns: 6,
    claudeGraphOrientationSearchesPerTurn: 6,
    claudeGraphOrientationFixtureFiles: 120,
    sampleIntervalMs: 250,
  }),
  baseline: Object.freeze({
    loadedChatTabs: 40,
    loadedTurnsPerChat: 20,
    loadedPipelineExecutions: 50,
    pipelineHistoryExecutions: 424,
    pipelineHistoryTotalBytes: 62_000_000,
    pipelineHistoryListIterations: 3,
    browserHistoricalPartitions: 270,
    browserActionWarmups: 3,
    browserActionIterations: 50,
    browserAgentActionsWarmups: 3,
    browserAgentActionsIterations: 30,
    browserPostCloseSettleMs: 2_000,
    archivePayloadBytes: 64 * 1024 * 1024,
    codeReviewRegistryDeleteCycles: 3,
    codeReviewRegistryMissingDeletes: 3,
    codeReviewRegistryMatchingRows: 2,
    codeReviewRegistryUnrelatedRows: 100,
    codeReviewRegistryRegisterIterations: 20,
    innerPanelCollapseWarmups: 3,
    innerPanelCollapseIterations: 20,
    planOpenSections: 40,
    planOpenTasksPerSection: 8,
    planOpenParagraphBytes: 1200,
    planOpenDiagramTasksPerSection: 3,
    planOpenCommentThreads: 24,
    planOpenIterations: 10,
    chatSearchIndexBodyBytes: 65_000_000,
    pluginPickerPlugins: 850,
    pluginPickerSkills: 100,
    pluginPickerMcpServers: 50,
    pluginPickerSearchIterations: 8,
    fileExplorerDirectories: 80,
    fileExplorerFilesPerDirectory: 120,
    fileExplorerMutationBurst: 200,
    menuSurfacesIterations: 20,
    frameSmoothnessIterations: 6,
    frameSmoothnessSidebarEntries: 80,
    startupSettleMs: 15_000,
    startupTypingIntervalMs: 250,
    startupBackgroundIdleDwellMs: 5_500,
    startupBackgroundProbeMs: 5_000,
    startupWorktrees: 52,
    startupWorkspaces: 30,
    realisticStartupWorktrees: 44,
    realisticStartupWorkspaces: 22,
    realisticStartupRepositories: 8,
    realisticStartupGraphFilesPerRepo: 1_200,
    realisticStartupObserveMs: 60_000,
    powerUserWorkspaces: 25,
    powerUserWorktrees: 45,
    powerUserRepositories: 8,
    powerUserCoworkWorkspaces: 3,
    powerUserCoworkEntries: 17,
    powerUserChatTabs: 560,
    powerUserMessages: 100_000,
    powerUserPipelineExecutions: 482,
    powerUserPipelineTotalBytes: 90_000_000,
    powerUserPanelLayouts: 47,
    powerUserFiredWatchers: 1_108,
    powerUserAutomations: 34,
    powerUserAutomationRuns: 42,
    powerUserGraphFilesPerRepo: 600,
    powerUserObserveMs: 60_000,
    // CAN-6932: a desktop holding many retained worktrees, mostly in
    // one project, with chats and fired watchers.
    retainedWorktrees: 110,
    retainedSettleMs: 20_000,
    retainedIdleMs: 30_000,
    retainedActiveMs: 20_000,
    retainedStaleIntervalMs: 500,
    retainedFocusIntervalMs: 1_000,
    navigationIterations: 10,
    interactionIterations: 8,
    stressTranscriptTurns: 25,
    stressTranscriptBatches: 160,
    stressTranscriptFinalBytes: 26_000,
    largeTranscriptWorktrees: 6,
    largeTranscriptLiveChatsPerWorktree: 4,
    largeTranscriptArchivedChatsPerWorktree: 10,
    largeTranscriptNavigationIterations: 8,
    largeTranscriptArchiveViews: 3,
    largeTranscriptDenseMessages: 11_500,
    largeTranscriptDenseMessageBytes: 1_200,
    largeTranscriptRichMessages: 1_800,
    largeTranscriptRichMessageBytes: 6_000,
    largeTranscriptArchiveMessages: 180,
    largeTranscriptArchiveMessageBytes: 6_000,
    coworkDefaultShortMessages: 12,
    coworkDefaultShortMessageBytes: 1_024,
    coworkDefaultLongMessages: 120,
    coworkDefaultLongMessageBytes: 2_048,
    coworkDefaultPipelineMessages: 16,
    coworkDefaultPipelineMessageBytes: 2_048,
    mathTranscriptLightElements: 160,
    mathTranscriptMediumElements: 96,
    mathTranscriptHeavyElements: 48,
    mathTranscriptNavigationIterations: 6,
    linearReferenceMessages: 240,
    linearReferenceNavigationIterations: 3,
    typingCharacters: 96,
    responsivenessBudgetMs: 5_000,
    responsivenessThresholds: RESPONSIVENESS_THRESHOLDS,
    concurrentChats: 8,
    chatStreamMs: 30_000,
    chatReplyCharacters: 2_000,
    transcriptStreamMs: 30_000,
    transcriptStreamCharacters: 48_000,
    transcriptStreamChunkCharacters: 64,
    transcriptActiveTurnCharacters: 96_000,
    transcriptToolExchanges: 96,
    transcriptRetentionCycles: 8,
    concurrentPipelines: 4,
    pipelineHoldMs: 15_000,
    scriptHoldMs: 30_000,
    scriptCpuWorkers: 2,
    scriptOutputIntervalMs: 25,
    scriptOutputLinesPerTick: 32,
    scriptFilesPerTick: 8,
    scriptFileBytes: 8_192,
    scriptSpawnIntervalMs: 250,
    gitCheckoutFiles: 10_000,
    gitCheckoutFileBytes: 512,
    gitTypingCharacters: 32,
    sustainedTypingIntervalMs: 500,
    gitGateReleaseAfterKeys: 4,
    gitGateMaxHoldMs: 180_000,
    worktreesToCreate: 8,
    preexistingWorktrees: 52,
    w5StoreWorkspaces: 25,
    w5StoreLargeWorkspaceWorktrees: 250,
    w5StoreReloads: 10,
    w5StoreWriteCycles: 3,
    w5StoreBurstSequential: 200,
    w5StoreBurstWarmup: 20,
    w5StoreBurstConcurrent: 20,
    codeGraphBuildWorktrees: 9,
    codeGraphFixtureFilesPerWorktree: 3_000,
    ledgerScopeEntries: 10_000,
    ledgerOtherScopes: 99,
    ledgerOtherScopeEntries: 910,
    ledgerRoundTrips: 20,
    ledgerIdleDwellMs: 10_000,
    costIndexAuditDays: 7,
    costIndexAuditLinesPerDay: 30_000,
    costIndexAuditTurnsPerDay: 300,
    costIndexDwellMs: 110_000,
    costIndexTypingIntervalMs: 10_000,
    transcriptToolActiveTurnSizes: Object.freeze([10, 100, 1_000]),
    multiChatStreamingChats: 5,
    multiChatStreamingMs: 180_000,
    multiChatStreamingToolIntervalMs: 300,
    multiChatStreamingLargeOutputs: 4,
    multiChatStreamingLargeOutputBytes: 72 * 1024,
    multiChatStreamingCommandOutputDeltas: 60,
    multiChatStreamingCommandOutputDeltaBytes: 4_096,
    multiChatStreamingCommandOutputIntervalMs: 100,
    multiChatStreamingRatioBracketUpdates: 8,
    chatSwitchCatchUpEvents: 8,
    managedDelegationTranscriptBytes: 8 * 1024 * 1024,
    managedDelegationChildSteps: 16,
    managedDelegationChildStepMs: 600,
    delegationCyclesTranscriptBytes: 64 * 1024 * 1024,
    delegationCyclesHistoryCards: 300,
    delegationCycles: 4,
    projectsReloadCycles: 120,
    ownedAutomations: 770,
    ownedAutomationListSamples: 10,
    ownedAutomationWrites: 5,
    pipelineDefinitions: 400,
    pipelineDefinitionSamples: 20,
    delegationCyclesDelegates: 4,
    delegationCyclesChildSteps: 80,
    delegationCyclesChildStepMs: 600,
    delegationCyclesParentStreamMs: 90_000,
    codeGraphQueuedRefreshes: 6,
    codeGraphNewWorktreeFiles: 1_200,
    codeGraphAgentReadsLaterTurns: 12,
    codeGraphAgentReadsFixtureFiles: 400,
    codeGraphSmallEditSmallFiles: 1_000,
    codeGraphSmallEditLargeFiles: 13_000,
    claudeGraphOrientationLaterTurns: 12,
    claudeGraphOrientationSearchesPerTurn: 8,
    claudeGraphOrientationFixtureFiles: 400,
    sampleIntervalMs: 200,
  }),
  stress: Object.freeze({
    loadedChatTabs: 100,
    loadedTurnsPerChat: 50,
    loadedPipelineExecutions: 200,
    pipelineHistoryExecutions: 1_000,
    pipelineHistoryTotalBytes: 150_000_000,
    pipelineHistoryListIterations: 3,
    browserHistoricalPartitions: 1_000,
    browserActionWarmups: 3,
    browserActionIterations: 100,
    browserAgentActionsWarmups: 5,
    browserAgentActionsIterations: 60,
    browserPostCloseSettleMs: 5_000,
    archivePayloadBytes: 256 * 1024 * 1024,
    codeReviewRegistryDeleteCycles: 5,
    codeReviewRegistryMissingDeletes: 5,
    codeReviewRegistryMatchingRows: 4,
    codeReviewRegistryUnrelatedRows: 500,
    codeReviewRegistryRegisterIterations: 50,
    innerPanelCollapseWarmups: 5,
    innerPanelCollapseIterations: 50,
    planOpenSections: 80,
    planOpenTasksPerSection: 12,
    planOpenParagraphBytes: 2400,
    planOpenDiagramTasksPerSection: 4,
    planOpenCommentThreads: 60,
    planOpenIterations: 20,
    chatSearchIndexBodyBytes: 100_000_000,
    pluginPickerPlugins: 1_700,
    pluginPickerSkills: 200,
    pluginPickerMcpServers: 100,
    pluginPickerSearchIterations: 12,
    fileExplorerDirectories: 160,
    fileExplorerFilesPerDirectory: 160,
    fileExplorerMutationBurst: 500,
    menuSurfacesIterations: 30,
    frameSmoothnessIterations: 10,
    frameSmoothnessSidebarEntries: 160,
    startupSettleMs: 30_000,
    startupTypingIntervalMs: 250,
    startupBackgroundIdleDwellMs: 5_500,
    startupBackgroundProbeMs: 10_000,
    startupWorktrees: 125,
    startupWorkspaces: 71,
    realisticStartupWorktrees: 125,
    realisticStartupWorkspaces: 40,
    realisticStartupRepositories: 9,
    realisticStartupGraphFilesPerRepo: 3_000,
    realisticStartupObserveMs: 120_000,
    powerUserWorkspaces: 40,
    powerUserWorktrees: 75,
    powerUserRepositories: 9,
    powerUserCoworkWorkspaces: 5,
    powerUserCoworkEntries: 30,
    powerUserChatTabs: 1_000,
    powerUserMessages: 150_000,
    powerUserPipelineExecutions: 1_000,
    powerUserPipelineTotalBytes: 150_000_000,
    powerUserPanelLayouts: 75,
    powerUserFiredWatchers: 2_000,
    powerUserAutomations: 60,
    powerUserAutomationRuns: 100,
    powerUserGraphFilesPerRepo: 1_200,
    powerUserObserveMs: 120_000,
    // CAN-6932: a desktop holding many retained worktrees, mostly in
    // one project, with chats and fired watchers.
    retainedWorktrees: 170,
    retainedSettleMs: 30_000,
    retainedIdleMs: 60_000,
    retainedActiveMs: 30_000,
    retainedStaleIntervalMs: 500,
    retainedFocusIntervalMs: 1_000,
    navigationIterations: 25,
    interactionIterations: 20,
    stressTranscriptTurns: 25,
    stressTranscriptBatches: 160,
    stressTranscriptFinalBytes: 26_000,
    largeTranscriptWorktrees: 8,
    largeTranscriptLiveChatsPerWorktree: 6,
    largeTranscriptArchivedChatsPerWorktree: 16,
    largeTranscriptNavigationIterations: 12,
    largeTranscriptArchiveViews: 4,
    largeTranscriptDenseMessages: 14_000,
    largeTranscriptDenseMessageBytes: 1_500,
    largeTranscriptRichMessages: 3_000,
    largeTranscriptRichMessageBytes: 8_000,
    largeTranscriptArchiveMessages: 300,
    largeTranscriptArchiveMessageBytes: 8_000,
    coworkDefaultShortMessages: 20,
    coworkDefaultShortMessageBytes: 2_048,
    coworkDefaultLongMessages: 300,
    coworkDefaultLongMessageBytes: 4_096,
    coworkDefaultPipelineMessages: 24,
    coworkDefaultPipelineMessageBytes: 4_096,
    mathTranscriptLightElements: 480,
    mathTranscriptMediumElements: 288,
    mathTranscriptHeavyElements: 144,
    mathTranscriptNavigationIterations: 12,
    linearReferenceMessages: 600,
    linearReferenceNavigationIterations: 4,
    typingCharacters: 192,
    responsivenessBudgetMs: 10_000,
    responsivenessThresholds: RESPONSIVENESS_THRESHOLDS,
    concurrentChats: 10,
    chatStreamMs: 60_000,
    chatReplyCharacters: 5_000,
    transcriptStreamMs: 60_000,
    transcriptStreamCharacters: 96_000,
    transcriptStreamChunkCharacters: 32,
    transcriptActiveTurnCharacters: 256_000,
    transcriptToolExchanges: 240,
    transcriptRetentionCycles: 12,
    concurrentPipelines: 5,
    pipelineHoldMs: 30_000,
    scriptHoldMs: 60_000,
    scriptCpuWorkers: 3,
    scriptOutputIntervalMs: 25,
    scriptOutputLinesPerTick: 32,
    scriptFilesPerTick: 8,
    scriptFileBytes: 8_192,
    scriptSpawnIntervalMs: 250,
    gitCheckoutFiles: 20_000,
    gitCheckoutFileBytes: 512,
    gitTypingCharacters: 48,
    sustainedTypingIntervalMs: 500,
    gitGateReleaseAfterKeys: 4,
    gitGateMaxHoldMs: 180_000,
    worktreesToCreate: 16,
    preexistingWorktrees: 75,
    w5StoreWorkspaces: 40,
    w5StoreLargeWorkspaceWorktrees: 250,
    w5StoreReloads: 10,
    w5StoreWriteCycles: 5,
    w5StoreBurstSequential: 400,
    w5StoreBurstWarmup: 40,
    w5StoreBurstConcurrent: 40,
    codeGraphBuildWorktrees: 15,
    codeGraphFixtureFilesPerWorktree: 6_000,
    ledgerScopeEntries: 20_000,
    ledgerOtherScopes: 99,
    ledgerOtherScopeEntries: 1_820,
    ledgerRoundTrips: 20,
    ledgerIdleDwellMs: 10_000,
    costIndexAuditDays: 7,
    costIndexAuditLinesPerDay: 65_000,
    costIndexAuditTurnsPerDay: 400,
    costIndexDwellMs: 150_000,
    costIndexTypingIntervalMs: 10_000,
    transcriptToolActiveTurnSizes: Object.freeze([10, 100, 1_000]),
    multiChatStreamingChats: 5,
    multiChatStreamingMs: 300_000,
    multiChatStreamingToolIntervalMs: 300,
    multiChatStreamingLargeOutputs: 6,
    multiChatStreamingLargeOutputBytes: 72 * 1024,
    multiChatStreamingCommandOutputDeltas: 60,
    multiChatStreamingCommandOutputDeltaBytes: 4_096,
    multiChatStreamingCommandOutputIntervalMs: 100,
    multiChatStreamingRatioBracketUpdates: 8,
    chatSwitchCatchUpEvents: 8,
    managedDelegationTranscriptBytes: 16 * 1024 * 1024,
    managedDelegationChildSteps: 32,
    managedDelegationChildStepMs: 600,
    delegationCyclesTranscriptBytes: 128 * 1024 * 1024,
    delegationCyclesHistoryCards: 600,
    delegationCycles: 6,
    projectsReloadCycles: 240,
    ownedAutomations: 770,
    ownedAutomationListSamples: 20,
    ownedAutomationWrites: 10,
    pipelineDefinitions: 1500,
    pipelineDefinitionSamples: 40,
    delegationCyclesDelegates: 6,
    delegationCyclesChildSteps: 100,
    delegationCyclesChildStepMs: 600,
    delegationCyclesParentStreamMs: 90_000,
    codeGraphQueuedRefreshes: 10,
    codeGraphNewWorktreeFiles: 3_000,
    codeGraphAgentReadsLaterTurns: 20,
    codeGraphAgentReadsFixtureFiles: 1_000,
    codeGraphSmallEditSmallFiles: 1_000,
    codeGraphSmallEditLargeFiles: 13_000,
    claudeGraphOrientationLaterTurns: 20,
    claudeGraphOrientationSearchesPerTurn: 8,
    claudeGraphOrientationFixtureFiles: 1_000,
    sampleIntervalMs: 150,
  }),
});

const MULTI_CHAT_STREAMING_SCENARIOS = Object.freeze([
  'multi-chat-streaming',
  'multi-chat-streaming-sequential',
  'background-streaming',
  'chat-switch-catch-up',
]);

const MANAGED_DELEGATION_SCENARIOS = Object.freeze([
  'managed-delegation-concurrency',
]);

const DELEGATION_RESTART_CYCLES_SCENARIOS = Object.freeze([
  'delegation-restart-cycles',
]);

/**
 * W5 store arms (CAN-5532): the launch's W5 store, a treatment rather than
 * workload configuration (`w5-store-arms.mjs`). Kept here so the release
 * study's helper closure gains no file.
 */
export const W5_STORE_ARMS = Object.freeze([
  'in-process',
  'daemon-record-port',
]);

export function parseW5StoreArm(value, option = '--w5-store') {
  if (!W5_STORE_ARMS.includes(value))
    throw new Error(`${option} expects ${W5_STORE_ARMS.join(' or ')}`);
  return value;
}

/** W5 store arm workloads (CAN-5532): startup, sidebar reloads, writes. */
export const W5_STORE_SCENARIOS = Object.freeze([
  'w5-store-startup',
  'w5-store-reload',
  'w5-store-writes',
]);

/** The uninstrumented workload and its separately named traced variant. */
const CODE_REVIEW_REGISTRY_SCENARIOS = Object.freeze([
  'code-review-registry-cleanup',
  'code-review-registry-cleanup-trace',
]);

/**
 * Sizing keys that only these scenarios read. A key enters a run's `config`
 * only when one of its scenarios runs, so adding an opt-in scenario leaves
 * every other run's configuration, and with it the comparator's workload
 * check and the work ratchet's `configSha256`, unchanged.
 */
export const SCENARIO_SCOPED_CONFIG_KEYS = Object.freeze({
  retainedWorktrees: Object.freeze(['retained-worktrees-idle']),
  retainedSettleMs: Object.freeze(['retained-worktrees-idle']),
  retainedIdleMs: Object.freeze(['retained-worktrees-idle']),
  retainedActiveMs: Object.freeze(['retained-worktrees-idle']),
  retainedStaleIntervalMs: Object.freeze(['retained-worktrees-idle']),
  retainedFocusIntervalMs: Object.freeze(['retained-worktrees-idle']),
  // Opt-in, so no profile sizes it and default runs keep their fingerprint.
  retainedActiveChatWatchers: Object.freeze(['retained-worktrees-idle']),
  browserActionWarmups: Object.freeze(['browser-actions']),
  browserActionIterations: Object.freeze(['browser-actions']),
  browserAgentActionsWarmups: Object.freeze(['browser-agent-actions']),
  browserAgentActionsIterations: Object.freeze(['browser-agent-actions']),
  transcriptToolActiveTurnSizes: Object.freeze([
    'transcript-active-turn-tools',
  ]),
  multiChatStreamingChats: MULTI_CHAT_STREAMING_SCENARIOS,
  multiChatStreamingMs: MULTI_CHAT_STREAMING_SCENARIOS,
  multiChatStreamingToolIntervalMs: MULTI_CHAT_STREAMING_SCENARIOS,
  multiChatStreamingLargeOutputs: MULTI_CHAT_STREAMING_SCENARIOS,
  multiChatStreamingLargeOutputBytes: MULTI_CHAT_STREAMING_SCENARIOS,
  multiChatStreamingCommandOutputDeltas: MULTI_CHAT_STREAMING_SCENARIOS,
  multiChatStreamingCommandOutputDeltaBytes: MULTI_CHAT_STREAMING_SCENARIOS,
  multiChatStreamingCommandOutputIntervalMs: MULTI_CHAT_STREAMING_SCENARIOS,
  multiChatStreamingRatioBracketUpdates: MULTI_CHAT_STREAMING_SCENARIOS,
  chatSwitchCatchUpEvents: Object.freeze(['chat-switch-catch-up']),
  managedDelegationTranscriptBytes: MANAGED_DELEGATION_SCENARIOS,
  managedDelegationChildSteps: MANAGED_DELEGATION_SCENARIOS,
  managedDelegationChildStepMs: MANAGED_DELEGATION_SCENARIOS,
  delegationCyclesTranscriptBytes: DELEGATION_RESTART_CYCLES_SCENARIOS,
  delegationCyclesHistoryCards: DELEGATION_RESTART_CYCLES_SCENARIOS,
  delegationCycles: DELEGATION_RESTART_CYCLES_SCENARIOS,
  projectsReloadCycles: Object.freeze(['projects-reload-retention']),
  ownedAutomations: Object.freeze(['owned-automations-list']),
  ownedAutomationListSamples: Object.freeze(['owned-automations-list']),
  ownedAutomationWrites: Object.freeze(['owned-automations-list']),
  pipelineDefinitions: Object.freeze(['pipeline-definitions']),
  pipelineDefinitionSamples: Object.freeze(['pipeline-definitions']),
  delegationCyclesDelegates: DELEGATION_RESTART_CYCLES_SCENARIOS,
  delegationCyclesChildSteps: DELEGATION_RESTART_CYCLES_SCENARIOS,
  delegationCyclesChildStepMs: DELEGATION_RESTART_CYCLES_SCENARIOS,
  delegationCyclesParentStreamMs: DELEGATION_RESTART_CYCLES_SCENARIOS,
  codeGraphQueuedRefreshes: Object.freeze(['code-graph-new-worktree']),
  codeGraphNewWorktreeFiles: Object.freeze(['code-graph-new-worktree']),
  codeGraphAgentReadsLaterTurns: Object.freeze(['code-graph-agent-reads']),
  codeGraphAgentReadsFixtureFiles: Object.freeze(['code-graph-agent-reads']),
  codeGraphSmallEditSmallFiles: Object.freeze(['code-graph-small-edit']),
  codeGraphSmallEditLargeFiles: Object.freeze(['code-graph-small-edit']),
  claudeGraphOrientationLaterTurns: Object.freeze(['claude-graph-orientation']),
  claudeGraphOrientationSearchesPerTurn: Object.freeze([
    'claude-graph-orientation',
  ]),
  claudeGraphOrientationFixtureFiles: Object.freeze([
    'claude-graph-orientation',
  ]),
  menuSurfacesIterations: Object.freeze(['menu-surfaces']),
  frameSmoothnessIterations: Object.freeze(['frame-smoothness']),
  frameSmoothnessSidebarEntries: Object.freeze(['frame-smoothness']),
  ledgerScopeEntries: Object.freeze(['ledger-panel', 'ledger-feed-overview']),
  ledgerOtherScopes: Object.freeze(['ledger-panel', 'ledger-feed-overview']),
  ledgerOtherScopeEntries: Object.freeze([
    'ledger-panel',
    'ledger-feed-overview',
  ]),
  ledgerRoundTrips: Object.freeze(['ledger-panel', 'ledger-feed-overview']),
  ledgerIdleDwellMs: Object.freeze(['ledger-disabled-idle']),
  costIndexAuditDays: Object.freeze(['cost-index-first-build']),
  costIndexAuditLinesPerDay: Object.freeze(['cost-index-first-build']),
  costIndexAuditTurnsPerDay: Object.freeze(['cost-index-first-build']),
  costIndexDwellMs: Object.freeze(['cost-index-first-build']),
  costIndexTypingIntervalMs: Object.freeze(['cost-index-first-build']),
  linearReferenceMessages: Object.freeze(['linear-reference-transcripts']),
  linearReferenceNavigationIterations: Object.freeze([
    'linear-reference-transcripts',
  ]),
  codeReviewRegistryDeleteCycles: CODE_REVIEW_REGISTRY_SCENARIOS,
  codeReviewRegistryMissingDeletes: CODE_REVIEW_REGISTRY_SCENARIOS,
  codeReviewRegistryMatchingRows: CODE_REVIEW_REGISTRY_SCENARIOS,
  codeReviewRegistryUnrelatedRows: CODE_REVIEW_REGISTRY_SCENARIOS,
  codeReviewRegistryRegisterIterations: CODE_REVIEW_REGISTRY_SCENARIOS,
  w5StoreWorkspaces: W5_STORE_SCENARIOS,
  w5StoreLargeWorkspaceWorktrees: W5_STORE_SCENARIOS,
  w5StoreReloads: Object.freeze(['w5-store-reload']),
  w5StoreWriteCycles: Object.freeze(['w5-store-writes']),
  w5StoreBurstSequential: Object.freeze(['w5-store-writes']),
  w5StoreBurstWarmup: Object.freeze(['w5-store-writes']),
  w5StoreBurstConcurrent: Object.freeze(['w5-store-writes']),
});

/**
 * The command-line options that set a scenario-scoped key, by the override key
 * they set. A caller that forwards options to one scenario at a time (the
 * interleaved compare driver) passes each of these only to the scenarios that
 * own its key: `parsePerformanceArgs` rejects the rest.
 */
export const SCENARIO_SCOPED_OPTIONS = Object.freeze({
  '--browser-actions-iterations': 'browserActionIterations',
  '--menu-surfaces-iterations': 'menuSurfacesIterations',
  '--browser-agent-actions-iterations': 'browserAgentActionsIterations',
  '--multi-chat-streaming-ms': 'multiChatStreamingMs',
  '--code-graph-queued-refreshes': 'codeGraphQueuedRefreshes',
  '--w5-store-workspaces': 'w5StoreWorkspaces',
  '--retained-active-watchers': 'retainedActiveChatWatchers',
});

/** Opt-in switches only some scenarios read; no profile sizes them. */
export const SCENARIO_SCOPED_SWITCHES = Object.freeze({
  '--cold-background-streams': Object.freeze(['background-streaming']),
  '--chat-switch-hover-ms': Object.freeze(['chat-switch-catch-up']),
});

/**
 * Heavy workloads that run only when selected with `--scenarios`, so the
 * default suite and `perf:desktop:smoke` keep their current duration.
 */
export const OPT_IN_SCENARIO_NAMES = Object.freeze([
  'sidebar-reorder',
  'cloud-cowork-first-open',
  'projects-retention',
  'browser-actions',
  'browser-agent-actions',
  ...MULTI_CHAT_STREAMING_SCENARIOS,
  ...MANAGED_DELEGATION_SCENARIOS,
  ...DELEGATION_RESTART_CYCLES_SCENARIOS,
  'code-graph-new-worktree',
  'code-graph-agent-reads',
  'code-graph-small-edit',
  'claude-graph-orientation',
  'linear-reference-transcripts',
  'frame-smoothness',
  'menu-surfaces',
  'cost-index-first-build',
  'skill-suggestions-backfill',
  'lab-transcript-onscreen',
  'lab-transcript-offscreen',
  'lab-transcript-checkpoint',
  'many-chat-residency',
  'many-worktree-file-index',
  'retained-worktrees-idle',
  'scope-residency',
  'projects-reload-retention',
  'owned-automations-list',
  'pipeline-definitions',
  'attachments-list-scroll',
  ...CODE_REVIEW_REGISTRY_SCENARIOS,
  ...W5_STORE_SCENARIOS,
]);

/**
 * The most unmeasured launches `--warm-launches` runs on a startup
 * scenario's profile before its measured launch. Chromium writes a script's
 * code cache on its second load and reads it from the third, so two warm
 * launches leave a measured launch that can consume it.
 */
const MAX_WARM_LAUNCHES = 3;

/** The most launches `--repeat` runs of each scenario. */
export const MAX_REPEAT = 100;

/** The work-counter ratchet profile; see `work-ratchet.mjs`. */
export const WORK_RATCHET_PROFILE = 'counters';

/**
 * The ratchet's fixed scenario set (methodology R3), run at smoke size. Its
 * ceilings in `work-ceilings.json` hold only for this workload.
 */
export const WORK_RATCHET_SCENARIO_NAMES = Object.freeze([
  'startup-settle',
  'loaded-ui',
  'stress-transcript',
  'transcript-streaming-tail',
  'plugin-picker',
  'file-explorer',
  'cowork-default-50',
]);

export const PERFORMANCE_PROFILES = Object.freeze({
  ...WORKLOAD_PROFILES,
  [WORK_RATCHET_PROFILE]: WORKLOAD_PROFILES.smoke,
});

export const SCENARIO_NAMES = Object.freeze([
  'sidebar-reorder',
  'cloud-cowork-first-open',
  'projects-retention',
  'startup-settle',
  'startup-realistic',
  'power-user-idle',
  'power-user-active',
  'loaded-ui',
  'pipeline-history',
  'large-transcripts',
  'stress-transcript',
  'transcript-streaming-tail',
  'transcript-streaming-history',
  'transcript-active-turn',
  'transcript-active-turn-stop',
  'transcript-active-turn-tools',
  'transcript-retention-cycle',
  'home-cowork-legacy',
  'cowork-default-50',
  'cowork-default-100',
  'cowork-default-500',
  'math-transcripts',
  'linear-reference-transcripts',
  'frame-smoothness',
  'chat-search-indexing',
  'plugin-picker',
  'menu-surfaces',
  'file-explorer',
  'browser-panels',
  'browser-actions',
  'browser-agent-actions',
  'archive-responsiveness',
  'inner-panels-collapse',
  'plan-open',
  'chats',
  'mixed-provider-agent-concurrency',
  'managed-delegation-concurrency',
  'delegation-restart-cycles',
  'multi-chat-streaming',
  'multi-chat-streaming-sequential',
  'background-streaming',
  'chat-switch-catch-up',
  'pipelines',
  'scripts',
  'worktrees',
  'worktree-concurrency',
  'large-transcript-concurrency',
  'code-graph-concurrency',
  'code-graph-background-concurrency',
  'ledger-panel',
  'ledger-feed-overview',
  'ledger-disabled-idle',
  'code-graph-new-worktree',
  'code-graph-agent-reads',
  'code-graph-small-edit',
  'claude-graph-orientation',
  'cost-index-first-build',
  'skill-suggestions-backfill',
  'lab-transcript-onscreen',
  'lab-transcript-offscreen',
  'lab-transcript-checkpoint',
  'many-chat-residency',
  'many-worktree-file-index',
  'retained-worktrees-idle',
  'scope-residency',
  'projects-reload-retention',
  'owned-automations-list',
  'pipeline-definitions',
  'attachments-list-scroll',
  ...CODE_REVIEW_REGISTRY_SCENARIOS,
  ...W5_STORE_SCENARIOS,
]);

export const DEFAULT_SCENARIO_NAMES = Object.freeze(
  SCENARIO_NAMES.filter(
    (scenario) =>
      scenario !== 'home-cowork-legacy' &&
      scenario !== 'startup-realistic' &&
      scenario !== 'power-user-idle' &&
      scenario !== 'power-user-active' &&
      scenario !== 'inner-panels-collapse' &&
      scenario !== 'plan-open' &&
      !scenario.startsWith('transcript-') &&
      scenario !== 'archive-responsiveness' &&
      !scenario.startsWith('cowork-default-') &&
      !scenario.startsWith('ledger-') &&
      !OPT_IN_SCENARIO_NAMES.includes(scenario),
  ),
);

/** Startup scenarios that record the J1 milestones and App Advisor opening. */
export const STARTUP_JOURNEY_SCENARIO_NAMES = Object.freeze([
  'startup-settle',
  'startup-realistic',
]);

/**
 * The run's workload configuration: the profile's values and the command
 * line's overrides, without the scoped keys of scenarios this run does not
 * select.
 */
export function scopedScenarioConfig(profileValues, scenarios, overrides = {}) {
  const config = { ...profileValues, ...overrides };
  for (const [key, owners] of Object.entries(SCENARIO_SCOPED_CONFIG_KEYS)) {
    if (!owners.some((scenario) => scenarios.includes(scenario))) {
      delete config[key];
    }
  }
  return config;
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} expects a positive integer`);
  }
  return parsed;
}

function readOptionValue(argv, index, option) {
  const inlinePrefix = `${option}=`;
  if (argv[index].startsWith(inlinePrefix)) {
    return { value: argv[index].slice(inlinePrefix.length), nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

export function parsePerformanceArgs(argv) {
  const options = {
    profile: 'baseline',
    scenarios: [...DEFAULT_SCENARIO_NAMES],
    output: '',
    label: '',
    keepData: false,
    showWindow: false,
    diagnosticsMode: 'on-failure',
    liveStartupBackground: false,
    startupTrace: false,
    gitAttribution: false,
    rendererCodeCacheScheme: false,
    warmLaunches: 0,
    releaseLike: false,
    releaseLikeRoot: '',
    e2eRoot: '',
    // The W5 store arm (`w5-store-arms.mjs`); a launch treatment, not config.
    w5Store: '',
    repeat: 1,
    overrides: {},
  };

  let explicitHeadless = false;
  let explicitHeaded = false;
  let explicitScenarios = false;
  // `--remote-control*`; validated once every option is read.
  const remoteControlOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const option = raw.split('=')[0];
    if (option === '--help') {
      options.help = true;
    } else if (option === '--keep-data') {
      options.keepData = true;
    } else if (option === '--headless') {
      explicitHeadless = true;
      options.showWindow = false;
    } else if (option === '--headed') {
      explicitHeaded = true;
      options.showWindow = true;
    } else if (option === '--diagnose') {
      options.diagnosticsMode = 'always';
    } else if (option === '--no-diagnostics') {
      options.diagnosticsMode = 'off';
    } else if (option === '--live-startup-background') {
      options.liveStartupBackground = true;
    } else if (option === '--startup-trace') {
      options.startupTrace = true;
    } else if (option === '--git-attribution') {
      options.gitAttribution = true;
    } else if (option === '--renderer-code-cache-scheme') {
      options.rendererCodeCacheScheme = true;
    } else if (option === '--cold-background-streams') {
      options.overrides.backgroundStreamingColdStart = true;
    } else if (option === '--warm-launches') {
      const result = readOptionValue(argv, index, option);
      index = result.nextIndex;
      const value = Number(result.value);
      if (!Number.isInteger(value) || value < 1 || value > MAX_WARM_LAUNCHES) {
        throw new Error(
          `--warm-launches expects an integer from 1 to ${MAX_WARM_LAUNCHES}`,
        );
      }
      options.warmLaunches = value;
    } else if (option === '--release-like') {
      options.releaseLike = true;
    } else if (isRemoteControlOption(option)) {
      const result = readOptionValue(argv, index, option);
      index = result.nextIndex;
      recordRemoteControlOption(remoteControlOptions, option, result.value);
    } else if (
      option === '--profile' ||
      option === '--scenarios' ||
      option === '--output' ||
      option === '--label' ||
      option === '--browser-panels-viewport' ||
      option === '--study-window-mode' ||
      option === '--release-like-root' ||
      option === '--e2e-root' ||
      option === '--w5-store'
    ) {
      const result = readOptionValue(argv, index, option);
      index = result.nextIndex;
      if (option === '--w5-store')
        options.w5Store = parseW5StoreArm(result.value);
      if (option === '--profile') options.profile = result.value;
      if (option === '--output') options.output = result.value;
      if (option === '--label') options.label = result.value;
      if (option === '--study-window-mode') {
        if (
          options.studyWindowMode !== undefined ||
          result.value !== 'headless'
        )
          throw new Error('--study-window-mode accepts headless once only');
        options.studyWindowMode = HEADLESS_STUDY_MODE;
      }
      if (option === '--browser-panels-viewport')
        options.browserPanelsViewport = result.value;
      if (option === '--release-like-root') {
        options.releaseLikeRoot = result.value;
      }
      if (option === '--e2e-root') options.e2eRoot = result.value;
      if (option === '--scenarios') {
        explicitScenarios = true;
        options.scenarios = result.value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
    } else if (
      option === '--chats' ||
      option === '--pipelines' ||
      option === '--worktrees' ||
      option === '--preexisting-worktrees' ||
      option === '--startup-worktrees' ||
      option === '--startup-workspaces' ||
      option === '--startup-settle-ms' ||
      option === '--realistic-startup-worktrees' ||
      option === '--realistic-startup-workspaces' ||
      option === '--realistic-startup-repositories' ||
      option === '--realistic-startup-graph-files' ||
      option === '--realistic-startup-observe-ms' ||
      option === '--pipeline-history-executions' ||
      option === '--pipeline-history-bytes' ||
      option === '--plugin-picker-plugins' ||
      option === '--plugin-picker-skills' ||
      option === '--plugin-picker-mcp-servers' ||
      option === '--browser-actions-iterations' ||
      option === '--menu-surfaces-iterations' ||
      option === '--browser-agent-actions-iterations' ||
      option === '--code-graph-worktrees' ||
      option === '--code-graph-files' ||
      option === '--code-graph-queued-refreshes' ||
      option === '--multi-chat-streaming-ms' ||
      option === '--chat-switch-hover-ms' ||
      option === '--w5-store-workspaces' ||
      option === '--retained-active-watchers' ||
      option === '--sample-interval-ms' ||
      option === '--repeat'
    ) {
      const result = readOptionValue(argv, index, option);
      index = result.nextIndex;
      const value = parsePositiveInteger(result.value, option);
      // Samples are not workload: `repeat` stays out of `config`.
      if (option === '--repeat') options.repeat = value;
      if (option === '--chats') options.overrides.concurrentChats = value;
      if (option === '--chat-switch-hover-ms')
        options.overrides.chatSwitchHoverMs = value;
      if (option === '--pipelines') {
        options.overrides.concurrentPipelines = value;
      }
      if (option === '--worktrees') {
        options.overrides.worktreesToCreate = value;
      }
      if (option === '--preexisting-worktrees') {
        options.overrides.preexistingWorktrees = value;
      }
      if (option === '--startup-worktrees') {
        options.overrides.startupWorktrees = value;
      }
      if (option === '--startup-workspaces') {
        options.overrides.startupWorkspaces = value;
      }
      if (option === '--startup-settle-ms') {
        options.overrides.startupSettleMs = value;
      }
      if (option === '--realistic-startup-worktrees') {
        options.overrides.realisticStartupWorktrees = value;
      }
      if (option === '--realistic-startup-workspaces') {
        options.overrides.realisticStartupWorkspaces = value;
      }
      if (option === '--realistic-startup-repositories') {
        options.overrides.realisticStartupRepositories = value;
      }
      if (option === '--realistic-startup-graph-files') {
        options.overrides.realisticStartupGraphFilesPerRepo = value;
      }
      if (option === '--realistic-startup-observe-ms') {
        options.overrides.realisticStartupObserveMs = value;
      }
      if (option === '--pipeline-history-executions') {
        options.overrides.pipelineHistoryExecutions = value;
      }
      if (option === '--pipeline-history-bytes') {
        options.overrides.pipelineHistoryTotalBytes = value;
      }
      if (option === '--plugin-picker-plugins') {
        options.overrides.pluginPickerPlugins = value;
      }
      if (option === '--plugin-picker-skills') {
        options.overrides.pluginPickerSkills = value;
      }
      if (option === '--plugin-picker-mcp-servers') {
        options.overrides.pluginPickerMcpServers = value;
      }
      if (option === '--menu-surfaces-iterations') {
        options.overrides.menuSurfacesIterations = value;
      }
      if (option === '--browser-actions-iterations') {
        options.overrides.browserActionIterations = value;
      }
      if (option === '--browser-agent-actions-iterations') {
        options.overrides.browserAgentActionsIterations = value;
      }
      if (option === '--code-graph-worktrees') {
        options.overrides.codeGraphBuildWorktrees = value;
      }
      if (option === '--code-graph-files') {
        options.overrides.codeGraphFixtureFilesPerWorktree = value;
      }
      if (option === '--code-graph-queued-refreshes') {
        options.overrides.codeGraphQueuedRefreshes = value;
      }
      if (option === '--multi-chat-streaming-ms') {
        options.overrides.multiChatStreamingMs = value;
      }
      if (option === '--w5-store-workspaces') {
        options.overrides.w5StoreWorkspaces = value;
      }
      if (option === '--retained-active-watchers') {
        options.overrides.retainedActiveChatWatchers = value;
      }
      if (option === '--sample-interval-ms') {
        options.overrides.sampleIntervalMs = value;
      }
    } else {
      throw new Error(`Unknown option: ${raw}`);
    }
  }

  if (!Object.hasOwn(PERFORMANCE_PROFILES, options.profile)) {
    throw new Error(
      `Unknown profile ${options.profile}; expected ${Object.keys(PERFORMANCE_PROFILES).join(', ')}`,
    );
  }
  if (!explicitScenarios && options.profile === WORK_RATCHET_PROFILE) {
    options.scenarios = [...WORK_RATCHET_SCENARIO_NAMES];
  }
  if (options.repeat > MAX_REPEAT) {
    throw new Error(`--repeat cannot exceed ${MAX_REPEAT}`);
  }
  if (options.repeat > 1 && options.profile === WORK_RATCHET_PROFILE) {
    throw new Error(
      'The counters profile judges one run; --repeat applies to timing comparisons',
    );
  }
  if (options.e2eRoot && options.releaseLike) {
    throw new Error(
      '--e2e-root names an E2E build; use --release-like-root with --release-like',
    );
  }
  if (options.w5Store && options.releaseLike) {
    throw new Error(
      '--w5-store selects an E2E-only W5 store arm and cannot be used with --release-like',
    );
  }
  if (options.scenarios.length === 0) {
    throw new Error('At least one scenario is required');
  }
  const unknownScenarios = options.scenarios.filter(
    (scenario) => !SCENARIO_NAMES.includes(scenario),
  );
  if (unknownScenarios.length > 0) {
    throw new Error(`Unknown scenario(s): ${unknownScenarios.join(', ')}`);
  }
  if (
    options.liveStartupBackground &&
    !options.scenarios.includes('startup-settle')
  ) {
    throw new Error(
      '--live-startup-background requires the startup-settle scenario',
    );
  }
  if (
    options.startupTrace &&
    !options.scenarios.some((scenario) =>
      STARTUP_JOURNEY_SCENARIO_NAMES.includes(scenario),
    )
  ) {
    throw new Error(
      '--startup-trace requires the startup-settle or startup-realistic scenario',
    );
  }
  if (
    options.warmLaunches > 0 &&
    !options.scenarios.some((scenario) =>
      STARTUP_JOURNEY_SCENARIO_NAMES.includes(scenario),
    )
  ) {
    throw new Error(
      '--warm-launches requires the startup-settle or startup-realistic scenario',
    );
  }
  if (
    options.overrides.backgroundStreamingColdStart === true &&
    !options.scenarios.includes('background-streaming')
  ) {
    throw new Error(
      'The backgroundStreamingColdStart override requires the background-streaming scenario',
    );
  }
  if (
    options.overrides.chatSwitchHoverMs !== undefined &&
    !options.scenarios.includes('chat-switch-catch-up')
  ) {
    throw new Error(
      'The chatSwitchHoverMs override requires the chat-switch-catch-up scenario',
    );
  }
  for (const key of Object.keys(options.overrides)) {
    const owners = SCENARIO_SCOPED_CONFIG_KEYS[key];
    if (
      owners &&
      !owners.some((scenario) => options.scenarios.includes(scenario))
    ) {
      throw new Error(
        `The ${key} override requires the ${owners.join(' or ')} scenario`,
      );
    }
  }
  const remoteControl = remoteControlConfig(remoteControlOptions, {
    scenarios: options.scenarios,
    releaseLike: options.releaseLike,
  });
  const config = {
    ...scopedScenarioConfig(
      PERFORMANCE_PROFILES[options.profile],
      options.scenarios,
      options.overrides,
    ),
    startupBackgroundMode: options.liveStartupBackground
      ? 'live'
      : 'suppressed',
    // Present only when requested, so untraced runs keep their fingerprint.
    ...(options.startupTrace ? { startupTraceMode: 'v8-compile' } : {}),
    // Repeat-state startup is a different workload from a first launch;
    // present only when requested, like the trace mode.
    ...(options.warmLaunches > 0
      ? { startupWarmLaunches: options.warmLaunches }
      : {}),
    // Remote Control connected is a different workload; present only when
    // requested, so unconnected runs keep their fingerprint.
    ...(remoteControl ? { remoteControl } : {}),
  };
  if (
    options.scenarios.includes('startup-realistic') &&
    (config.realisticStartupRepositories > 9 ||
      config.realisticStartupRepositories > config.realisticStartupWorktrees ||
      config.realisticStartupRepositories + 1 >
        config.realisticStartupWorkspaces)
  ) {
    throw new Error(
      'startup-realistic requires 1-9 repositories, at least one worktree per repository, and workspace capacity for every repository plus the startup cowork workspace',
    );
  }
  if (config.concurrentChats > 10) {
    throw new Error(
      '--chats cannot exceed the product default concurrency cap of 10',
    );
  }
  if (
    options.scenarios.includes('mixed-provider-agent-concurrency') &&
    config.concurrentChats < 2
  ) {
    throw new Error(
      'mixed-provider-agent-concurrency requires at least two chats so both providers are active',
    );
  }
  if (config.concurrentPipelines > 5) {
    throw new Error(
      '--pipelines cannot exceed the product default concurrency cap of 5',
    );
  }
  if (
    options.scenarios.includes('plugin-picker') &&
    config.pluginPickerPlugins < config.pluginPickerSearchIterations - 2
  ) {
    throw new Error(
      'plugin-picker requires enough plugin rows for distinct search targets',
    );
  }
  if (
    options.scenarios.includes('plugin-picker') &&
    config.pluginPickerMcpServers < 2
  ) {
    throw new Error(
      'plugin-picker requires at least two MCP rows so the full-list selection target differs from the searched one',
    );
  }
  if (config.preexistingWorktrees <= 50) {
    throw new Error('--preexisting-worktrees must be greater than 50');
  }
  if (
    options.scenarios.some((scenario) =>
      ['code-graph-concurrency', 'code-graph-background-concurrency'].includes(
        scenario,
      ),
    ) &&
    config.codeGraphBuildWorktrees < 3
  ) {
    throw new Error(
      'code-graph-concurrency requires at least three worktrees so running and queued builds overlap',
    );
  }
  if (
    W5_STORE_SCENARIOS.some((scenario) =>
      options.scenarios.includes(scenario),
    ) &&
    config.w5StoreWorkspaces < 2
  ) {
    throw new Error(
      '--w5-store-workspaces must be at least 2, so the large workspace has peers',
    );
  }
  if (config.startupWorkspaces > config.startupWorktrees) {
    throw new Error(
      '--startup-workspaces cannot exceed the startup worktree count',
    );
  }
  if (
    options.scenarios.includes('code-graph-new-worktree') &&
    config.codeGraphQueuedRefreshes < 2
  ) {
    throw new Error(
      'code-graph-new-worktree requires at least two queued refreshes so the new worktree waits behind running and queued work',
    );
  }
  if (
    MULTI_CHAT_STREAMING_SCENARIOS.some((scenario) =>
      options.scenarios.includes(scenario),
    ) &&
    config.multiChatStreamingMs < 5_000
  ) {
    throw new Error(
      '--multi-chat-streaming-ms must be at least 5000 so every chat streams a tool loop and a command output',
    );
  }

  if (options.studyWindowMode !== undefined) {
    if (
      !explicitHeadless ||
      explicitHeaded ||
      options.showWindow ||
      options.browserPanelsViewport !== undefined ||
      options.scenarios.length !== 1 ||
      options.scenarios[0] !== 'browser-panels'
    )
      throw new Error(
        '--study-window-mode headless requires --headless browser-panels-only without a headed preset',
      );
    options.viewport = HEADLESS_STUDY_VIEWPORT;
    options.studyViewportPreset = HEADLESS_STUDY_MODE;
  }
  if (options.browserPanelsViewport !== undefined) {
    if (
      options.browserPanelsViewport !== '1000x640' ||
      !options.showWindow ||
      options.scenarios.length !== 1 ||
      options.scenarios[0] !== 'browser-panels'
    )
      throw new Error(
        '--browser-panels-viewport accepts only 1000x640 for headed browser-panels-only execution',
      );
    options.viewport = { width: 1000, height: 640 };
    options.studyViewportPreset = 'headed-native-1000x640';
  }
  return { ...options, config };
}

export function performanceUsage() {
  return `Usage: npm run perf:desktop -- [options]

Options:
  --profile <smoke|baseline|stress|counters> Workload size (default baseline); counters runs the smoke-sized work-counter ratchet
  --scenarios <csv>                  sidebar-reorder,cloud-cowork-first-open,projects-retention,startup-settle,startup-realistic,power-user-idle,power-user-active,loaded-ui,pipeline-history,large-transcripts,stress-transcript,transcript-streaming-tail,transcript-streaming-history,transcript-active-turn,transcript-active-turn-stop,transcript-active-turn-tools,transcript-retention-cycle,math-transcripts,linear-reference-transcripts,frame-smoothness,chat-search-indexing,plugin-picker,menu-surfaces,file-explorer,browser-panels,browser-actions,browser-agent-actions,inner-panels-collapse,plan-open,chats,mixed-provider-agent-concurrency,managed-delegation-concurrency,delegation-restart-cycles,multi-chat-streaming,multi-chat-streaming-sequential,background-streaming,chat-switch-catch-up,pipelines,scripts,worktrees,worktree-concurrency,large-transcript-concurrency,code-graph-concurrency,code-graph-background-concurrency,code-graph-new-worktree,code-graph-small-edit,claude-graph-orientation,ledger-panel,ledger-feed-overview,ledger-disabled-idle,cost-index-first-build,skill-suggestions-backfill,lab-transcript-onscreen,lab-transcript-offscreen,lab-transcript-checkpoint,many-chat-residency,many-worktree-file-index,scope-residency,projects-reload-retention,owned-automations-list,attachments-list-scroll,code-review-registry-cleanup,code-review-registry-cleanup-trace,w5-store-startup,w5-store-reload,w5-store-writes
  --output <path>                    JSON result path
  --label <text>                     Human-readable run label
  --repeat <n>                       Run every scenario n times, each a fresh launch, and keep every sample (default 1)
  --chats <1-10>                     Override concurrent chat count
  --pipelines <1-5>                  Override concurrent pipeline count
  --worktrees <count>                Override created worktree count
  --preexisting-worktrees <count>    Override pre-existing worktree count
  --startup-worktrees <count>        Override established-user startup worktree count
  --startup-workspaces <count>       Override established-user startup workspace count
  --startup-settle-ms <ms>           Override the post-shell startup sampling window
  --realistic-startup-worktrees <n>  Override realistic startup worktree count
  --realistic-startup-workspaces <n> Override realistic startup workspace count
  --realistic-startup-repositories <n> Override realistic startup repository count (maximum 9)
  --realistic-startup-graph-files <n> Override generated files per startup shadow graph
  --realistic-startup-observe-ms <ms> Override realistic startup observation window
  --pipeline-history-executions <n>  Override persisted pipeline execution count
  --pipeline-history-bytes <bytes>   Override aggregate execution-state bytes
  --plugin-picker-plugins <count>    Override marketplace plugin rows
  --plugin-picker-skills <count>     Override installed skill rows
  --plugin-picker-mcp-servers <n>    Override enabled standalone MCP rows
  --menu-surfaces-iterations <n>     Override menu-surfaces passes over each surface (baseline 20)
  --browser-actions-iterations <n>   Override measured browser action cycles (baseline 50; 3 warmups excluded)
  --browser-agent-actions-iterations <n> Override measured browser page-model builds per group (baseline 30; 3 warmups excluded)
  --code-graph-worktrees <count>     Override concurrent Code Graph build requests (minimum 3)
  --code-graph-files <count>         Override generated source files per graph worktree
  --code-graph-queued-refreshes <n>  Override refreshes queued ahead of code-graph-new-worktree (minimum 2)
  --multi-chat-streaming-ms <ms>     Override the multi-chat-streaming event script length
  --sample-interval-ms <ms>          IPC/resource sampling interval
  --study-window-mode headless       Strict hidden native 1400x900 browser-panels study
  --headless                         Keep the E2E BrowserWindow hidden (default)
  --browser-panels-viewport 1000x640  Fixed headed browser-panels study preset
  --headed                           Show and focus the E2E BrowserWindow
  --diagnose                         Profile every scenario in a separate replay
  --no-diagnostics                   Disable automatic failed-scenario profiling
  --live-startup-background          Run real skill/plugin startup refreshes (diagnostic)
  --startup-trace                    Record Chromium v8.compile trace events for startup and App Advisor opening (lab diagnostic)
  --git-attribution                  Wrap Git for bounded source/request diagnostics (macOS and Linux; timings are non-comparable)
  --renderer-code-cache-scheme       Seed the rendererCodeCacheSchemeEnabled Experiments preference on (renderer loads from the code-cache scheme)
  --cold-background-streams          background-streaming: start each stream through chat IPC without opening its chat, so no stream is focused or warm
  --chat-switch-hover-ms <ms>        chat-switch-catch-up: rest the pointer on each target worktree row for <ms> before the timed click (prefetch on intent)
  --warm-launches <1-3>              Before each startup scenario's measured launch, launch that profile n times unmeasured (repeat-state startup)
  --w5-store <${W5_STORE_ARMS.join('|')}> Launch every scenario with this W5 store arm (E2E builds only; recorded as the result's treatment)
  --w5-store-workspaces <n>          w5-store-* scenarios: seeded workspaces (at least 2; above 127 passes the capture limit)
  --retained-active-watchers <n>     retained-worktrees-idle: seed n active chat-completion watchers on retained worktree chats (default none)
${REMOTE_CONTROL_USAGE}
  --release-like                     Launch the existing production bundle under the deterministic scenario driver
  --release-like-root <path>         Checkout containing the production out/ bundle (default current checkout)
  --e2e-root <path>                  Checkout containing the E2E out-e2e/ bundle (default current checkout)
  --keep-data                        Preserve scenario CANOPY_DATA_DIR folders
  --help                             Show this help
`;
}
