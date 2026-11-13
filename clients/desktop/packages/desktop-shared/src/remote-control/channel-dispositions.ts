/**
 * Remote-control disposition of every renderer IPC channel.
 *
 * When this computer controls another one, the window showing the other
 * computer runs the normal renderer and preload. The preload routes each IPC
 * call and subscription by the channel's disposition:
 *
 * - `tunnel`: forwarded to the controlled computer's main process; its push
 *   events are forwarded back. Handlers there that raise a file dialog ask
 *   the controlling computer to show a picker instead.
 * - `local`: handled by this computer's main process (window chrome, updates,
 *   notifications, voice, the remote-control feature itself).
 * - `blocked`: unavailable while controlling another computer. Invokes reject
 *   and pushes are not forwarded.
 *
 * Every catalog table is a mapped type over its channel catalog, so adding a
 * channel without classifying it fails type checking. Unknown channels are
 * blocked at runtime.
 *
 * Tunneled channels form the contract between two releases: changing one can
 * require bumping the remote-control protocol version, and
 * `pnpm run check:remote-control-contract` fails until the change is recorded.
 * See docs/remote-control-protocol.md.
 *
 * Design: docs/planning/2026-10-05-device-remote-control/README.md
 */
import { IPC_CHANNELS } from '../types';
import { PIPELINE_CHANNELS } from '../constants/ipc-channels';
import { MCP_SERVER_CHANNELS } from '../constants/mcp-server-channels';
import { SKILLS_CHANNELS } from '../constants/skill-channels';
import { PLUGINS_CHANNELS } from '../constants/plugin-channels';
import { COLLECTIONS_CHANNELS } from '../constants/collection-channels';
import { INVOCABLE_INVENTORY_CHANNELS } from '../constants/invocable-inventory-channels';
import { INSTALLED_ITEM_CHANNELS } from '../types/installed-items';
import { BUNDLES_CHANNELS } from '../constants/bundle-channels';
import { SKILL_SHARE_NUDGE_CHANNELS } from '../lib/skill-share-nudge';
import { SKILL_SUGGESTION_CHANNELS } from '../lib/skill-suggestions';

export type RemoteChannelDisposition = 'tunnel' | 'local' | 'blocked';

type RemoteDispositions<Catalog extends Record<string, string>> = {
  readonly [Key in keyof Catalog]: RemoteChannelDisposition;
};

export const IPC_REMOTE_DISPOSITIONS: RemoteDispositions<typeof IPC_CHANNELS> =
  {
    // The generic relay admits only tracked local renderer surfaces; no
    // domain caller has moved to it yet. Remote calls use compatibility IPC.
    canopyCoreRelay: 'blocked',
    scriptActionsList: 'tunnel',
    scriptActionsRescan: 'tunnel',
    scriptActionsReview: 'tunnel',
    scriptActionsSetShortcut: 'tunnel',
    scriptActionsSetPinned: 'tunnel',
    scriptActionsEnableShellAliasScan: 'tunnel',
    scriptActionsReceipt: 'tunnel',
    scriptActionsChanged: 'tunnel',
    scriptActionsFound: 'tunnel',

    // The account proxy routes the controlled computer's provider calls, so
    // it is that computer's setting, like the provider connections around it.
    accountProxyStatus: 'tunnel',
    accountProxyChanged: 'tunnel',
    accountProxyConnect: 'tunnel',
    accountProxyDisconnect: 'tunnel',
    accountProxySessionAccounts: 'tunnel',
    accountProxySetAccountDisabled: 'tunnel',
    accountProxyRemoveAccount: 'tunnel',
    accountProxySetRoutingStrategy: 'tunnel',
    accountProxySetUpLocal: 'tunnel',
    accountProxyControlLocal: 'tunnel',
    accountProxySignIn: 'tunnel',
    // Model access belongs to the controlled computer's account and work owner.
    modelLibraryWatch: 'tunnel',
    modelLibraryUnwatch: 'tunnel',
    modelLibraryChanged: 'tunnel',
    opencodeConnectionModels: 'tunnel',
    opencodeConnectionStatus: 'tunnel',
    opencodeConnectionConnect: 'tunnel',
    opencodeConnectionCancel: 'tunnel',
    opencodeConnectionDisconnect: 'tunnel',
    opencodeConnectionProgress: 'tunnel',
    managedDelegationMessage: 'tunnel',
    managedDelegationTree: 'tunnel',
    managedDelegationTranscriptPage: 'tunnel',
    managedDelegationRoots: 'tunnel',
    managedDelegationWorktreeSummary: 'tunnel',
    managedDelegationExtendLifetimeLimit: 'tunnel',
    managedDelegationLifetimeStatus: 'tunnel',
    managedDelegationLifetimeChanged: 'tunnel',
    nativeSubagentInterrupt: 'tunnel',
    personalOrganizationUpgradePromote: 'tunnel',
    personalOrganizationUpgradeInvite: 'tunnel',
    personalOrganizationUpgradeList: 'tunnel',
    personalOrganizationUpgradeConvert: 'tunnel',
    personalOrganizationUpgradeStatus: 'tunnel',
    personalOrganizationUpgradeInviteStatus: 'tunnel',
    // Hosted settings stream to the calling window and open payment pages in
    // the browser of the computer that runs them, so they are not offered
    // while controlling another computer.
    accountOrganizationSettingsRead: 'blocked',
    accountOrganizationSettingsWrite: 'blocked',
    accountOrganizationSettingsSubscribe: 'blocked',
    accountOrganizationSettingsUnsubscribe: 'blocked',
    accountOrganizationSettingsEvent: 'blocked',
    accountOrganizationSettingsPaymentHandoff: 'blocked',
    accountOrganizationSettingsPaymentHandoffAvailability: 'blocked',
    accountOrganizationSettingsOpen: 'blocked',
    referencePreviewGitHubScope: 'tunnel',
    referencePreviewGitHubOrigin: 'tunnel',
    referencePreviewGitHub: 'tunnel',
    // The App Advisor window that shows another computer has no floating
    // panel and no docked page.
    appAdvisorWindowSetFloatingSize: 'blocked',
    appAdvisorWindowSetDock: 'blocked',
    // reloads the physical window
    appWindowReload: 'local',
    // relaunches this machine's app
    appWindowRestart: 'local',
    // the dictionary for a selection in this machine's window
    appWindowLookUpSelection: 'local',
    // unsaved-edit report for this machine's main window
    appWindowSetUnsavedChanges: 'local',
    // asks this machine's main window before close or quit
    appWindowConfirmClose: 'local',
    // this machine's main window answers its close or quit prompt
    appWindowConfirmCloseResponse: 'local',
    // app startup lifecycle signal of this machine
    appStartupUnlocked: 'local',
    // global focus shortcut is OS-level on this machine
    globalFocusShortcutGetStatus: 'local',
    // global focus shortcut is OS-level on this machine
    globalFocusShortcutUpdate: 'local',
    // global focus shortcut status push for this window
    globalFocusShortcutStatusChanged: 'local',
    launchAtLoginGetStatus: 'tunnel',
    // changes B OS login item
    launchAtLoginSetEnabled: 'blocked',
    // opens B OS settings on its screen
    launchAtLoginOpenSystemSettings: 'blocked',
    launchAtLoginStatusChanged: 'tunnel',
    // This computer's own daemon health; a window showing another computer
    // reads Files through the bridge, never a daemon (CAN-5541).
    w5RecoveryStatus: 'blocked',
    w5RecoveryPrepare: 'blocked',
    backgroundServiceStatus: 'blocked',
    backgroundServiceRetry: 'blocked',
    backgroundServiceStatusChanged: 'blocked',
    codexSpeedRead: 'tunnel',
    codexSpeedReadRoute: 'tunnel',
    codexSpeedSetActive: 'tunnel',
    codexSpeedChanged: 'tunnel',
    projectsLoad: 'tunnel',
    projectsSave: 'tunnel',
    preferencesLoad: 'tunnel',
    preferencesAcknowledgeLoadError: 'tunnel',
    preferencesSave: 'tunnel',
    preferencesSetPipelineDisabled: 'tunnel',
    preferencesUpdateSuggestions: 'tunnel',
    preferencesUpdateOnboardingTips: 'tunnel',
    // The controlled computer's Mod admission preferences.
    claudeModsGet: 'tunnel',
    claudeModsUpdate: 'tunnel',
    preferencesSetApprovalDefault: 'tunnel',
    // creates B install data dir and adoption marker; install-level
    preferencesCreatePrimaryDataDir: 'blocked',
    // shell.openPath on B (preferences.ts:511)
    preferencesOpenMemoryDir: 'blocked',
    preferencesImportClaudeMemory: 'tunnel',
    localMemoryList: 'tunnel',
    localMemoryRead: 'tunnel',
    localMemoryUpdateItem: 'tunnel',
    localMemoryDeleteItem: 'tunnel',
    localMemoryUpdateFile: 'tunnel',
    localMemoryDeleteFile: 'tunnel',
    localMemoryChanged: 'tunnel',
    localMemoryWatch: 'tunnel',
    localMemoryUnwatch: 'tunnel',
    localMemoryConsolidationStatus: 'tunnel',
    localMemoryConsolidate: 'tunnel',
    copilotConnectionUsage: 'tunnel',
    copilotConnectionModels: 'tunnel',
    copilotConnectionStatus: 'tunnel',
    copilotConnectionConnect: 'tunnel',
    copilotConnectionCancel: 'tunnel',
    copilotConnectionDisconnect: 'tunnel',
    copilotConnectionAccount: 'tunnel',
    copilotConnectionChangeAccount: 'tunnel',
    copilotConnectionProgress: 'tunnel',
    cursorConnectionModels: 'tunnel',
    cursorConnectionStatus: 'tunnel',
    cursorConnectionConnect: 'tunnel',
    cursorConnectionCancel: 'tunnel',
    cursorConnectionDisconnect: 'tunnel',
    cursorConnectionAccount: 'tunnel',
    cursorConnectionChangeAccount: 'tunnel',
    cursorConnectionProgress: 'tunnel',
    cursorApprovalCheckAvailable: 'tunnel',
    cursorApprovalCheckRun: 'tunnel',
    cursorApprovalCheckCancel: 'tunnel',
    preferencesChanged: 'tunnel',
    telemetrySharingEnableForFeature: 'tunnel',
    telemetrySharingDismissOptInHint: 'tunnel',
    preferencesSynced: 'tunnel',
    activityChangedFiles: 'tunnel',
    activityRevertFile: 'tunnel',
    activityFileDiff: 'tunnel',
    activityTurnFileDiff: 'tunnel',
    trackedPlansList: 'tunnel',
    trackedPlansGet: 'tunnel',
    trackedPlansCreate: 'tunnel',
    trackedPlansUpdate: 'tunnel',
    trackedPlansDelete: 'tunnel',
    trackedPlansSaveComments: 'tunnel',
    trackedPlansGenerateDiagrams: 'tunnel',
    trackedPlansShare: 'tunnel',
    // CAN-5904: stopping sharing is not tunneled yet, so the remote-control
    // contract and its protocol version are unchanged.
    trackedPlansUnshare: 'blocked',
    trackedPlansImport: 'tunnel',
    detectedPlansScan: 'tunnel',
    detectedPlansList: 'tunnel',
    detectedPlansUpdate: 'tunnel',
    detectedPlansUpdated: 'tunnel',
    trackedPlansRefreshComments: 'tunnel',
    trackedPlansUpdated: 'tunnel',
    trackedPlansFileVisibility: 'tunnel',
    runsShare: 'tunnel',
    runsShareEligibility: 'tunnel',
    runsUnshare: 'tunnel',
    runsCommentsList: 'tunnel',
    runsCommentsCreate: 'tunnel',
    runsCommentsReply: 'tunnel',
    runsCommentsSetStatus: 'tunnel',
    runsCommentsMarkSeen: 'tunnel',
    runsCommentsUpdated: 'tunnel',
    sharedContainersEligibility: 'tunnel',
    sharedContainersPrepareGithub: 'tunnel',
    sharedContainersPreview: 'tunnel',
    sharedContainersSaveFileScope: 'tunnel',
    sharedContainersInvite: 'tunnel',
    sharedContainersGetLink: 'tunnel',
    sharedContainersSetLink: 'tunnel',
    sharedContainersResetLink: 'tunnel',
    sharedContainersResolveLink: 'tunnel',
    sharedContainersClaimLink: 'tunnel',
    sharedContainersSearchMembers: 'tunnel',
    sharedContainersListRecipients: 'tunnel',
    sharedContainersRevokeRecipient: 'tunnel',
    sharedContainersListByMe: 'tunnel',
    sharedContainersListOwnedTargets: 'tunnel',
    sharedContainersListWithMe: 'tunnel',
    sharedContainersOpen: 'tunnel',
    sharedContainersReplicaState: 'tunnel',
    sharedContainersListAccepted: 'tunnel',
    sharedContainersAccept: 'tunnel',
    sharedContainersRunStatus: 'tunnel',
    sharedContainersAllowRun: 'tunnel',
    sharedContainersRevokeRun: 'tunnel',
    sharedContainersSaveRunEnvironment: 'tunnel',
    sharedContainersRefreshRunCopy: 'tunnel',
    sharedContainersFork: 'tunnel',
    sharedContainersReadForkProvenance: 'tunnel',
    sharedContainersDismiss: 'tunnel',
    sharedContainersListDismissed: 'tunnel',
    sharedContainersListOwnerDepartures: 'tunnel',
    sharedContainersDismissOwnerDeparture: 'tunnel',
    sharedContainersRestore: 'tunnel',
    sharedContainersRetry: 'tunnel',
    sharedContainersClose: 'tunnel',
    sharedContainersReadRevisionMetadata: 'tunnel',
    sharedContainersListChats: 'tunnel',
    sharedContainersReadChat: 'tunnel',
    sharedContainersListPlans: 'tunnel',
    sharedContainersReadPlan: 'tunnel',
    sharedContainersListNotes: 'tunnel',
    sharedContainersReadNote: 'tunnel',
    sharedContainersListPrompts: 'tunnel',
    sharedContainersReadPrompt: 'tunnel',
    sharedContainersListAttachments: 'tunnel',
    sharedContainersReadAttachment: 'tunnel',
    sharedContainersListRepositories: 'tunnel',
    sharedContainersListRepositoryTree: 'tunnel',
    sharedContainersReadOverlayDiff: 'tunnel',
    sharedContainersReplicaChanged: 'tunnel',
    sharedContainersSyncPhase: 'tunnel',
    sharedContainersPublicationChanged: 'tunnel',
    sharedContainersInboxChanged: 'tunnel',
    worktreeSummaryLoad: 'tunnel',
    worktreeSummaryLoadBatch: 'tunnel',
    worktreeSummaryRefresh: 'tunnel',
    worktreeSummaryUpdated: 'tunnel',
    worktreeSummaryGenerating: 'tunnel',
    activityStopBgProcess: 'tunnel',
    activityStartOutputPolling: 'tunnel',
    activityStopOutputPolling: 'tunnel',
    activityReadFullOutput: 'tunnel',
    activityListLiveBgTasks: 'tunnel',
    activityLiveBgTasksChanged: 'tunnel',
    activityBgProcessOutput: 'tunnel',
    activityReadWorkflowRun: 'tunnel',
    activityReadWorkflowAgentTranscript: 'tunnel',
    repoBrowse: 'tunnel',
    repoDefaultCloneDir: 'tunnel',
    repoListDefaultRepos: 'tunnel',
    repoProbeCloneDestination: 'tunnel',
    repoAddLocal: 'tunnel',
    repoAddRemote: 'tunnel',
    repoInitLocal: 'tunnel',
    repoGetRemoteUrl: 'tunnel',
    repoLinkRemote: 'tunnel',
    canopyJsonRead: 'tunnel',
    repoBrowseDir: 'tunnel',
    worktreeCreate: 'tunnel',
    worktreeArchive: 'tunnel',
    // A worktree's plan, script, hook, pipeline and summary rows: the
    // entities Portal's worktree snapshot carries (CAN-5985).
    worktreeActivityEntities: 'tunnel',
    worktreeCheckRemovalAdmission: 'tunnel',
    // CAN-6476: local diagnosis contract; paired UI wiring follows in CAN-6479.
    worktreeRecoveryList: 'blocked',
    worktreeDiscardDescribe: 'tunnel',
    worktreeDiscard: 'tunnel',
    workspaceDeleteDiscardDescribe: 'tunnel',
    worktreeDiffStats: 'tunnel',
    worktreeDiffStatsBatch: 'tunnel',
    worktreeHealthCheck: 'tunnel',
    worktreeRenameBranch: 'tunnel',
    worktreeSetTrackedBaseBranch: 'tunnel',
    worktreeScheduleTaskBranchNaming: 'tunnel',
    worktreeListBranches: 'tunnel',
    homeListBranchTargets: 'tunnel',
    homeDiscoverEnvironment: 'tunnel',
    configurationComposerAdvisorEnvironment: 'tunnel',
    homeGetCoworkRoot: 'tunnel',
    homeFileIndex: 'tunnel',
    worktreeSwitchBranch: 'tunnel',
    worktreeCreateBranch: 'tunnel',
    worktreeDiscover: 'tunnel',
    worktreeDiscoveryEvent: 'tunnel',
    worktreeGitReady: 'tunnel',
    worktreeGitFailed: 'tunnel',
    worktreeNeedsRepair: 'tunnel',
    worktreeBranchChanged: 'tunnel',
    worktreesFileChanged: 'tunnel',
    workspaceWorktreesUpdated: 'tunnel',
    fileIndexGet: 'tunnel',
    fileTreeRoots: 'tunnel',
    fileTreeDirectory: 'tunnel',
    fileTreeMutate: 'tunnel',
    fileTreeWatchStart: 'tunnel',
    fileTreeWatchStop: 'tunnel',
    fileTreeChanged: 'tunnel',
    fileReferenceResolve: 'tunnel',
    worktreeImportAttachments: 'tunnel',
    workspaceAddFromFolder: 'tunnel',
    workspaceAddFromRemote: 'tunnel',
    cloneJobsList: 'tunnel',
    cloneJobsBackground: 'tunnel',
    cloneJobsCancel: 'tunnel',
    cloneJobsDismiss: 'tunnel',
    cloneJobsChanged: 'tunnel',
    workspaceCreateNew: 'tunnel',
    workspaceConvertType: 'tunnel',
    workspaceReadDriftSummary: 'tunnel',
    workspaceCreate: 'tunnel',
    workspaceCreateTemporaryFromRepos: 'tunnel',
    workspaceCreateTemporaryWorktreeFromRepos: 'tunnel',
    workspaceCreateTemporaryWorktreeFromWorkspaces: 'tunnel',
    workspaceAddRepo: 'tunnel',
    workspaceRemoveRepo: 'tunnel',
    workspaceInitGit: 'tunnel',
    workspaceAttachOrigin: 'tunnel',
    workspaceImportFromRepo: 'tunnel',
    workspaceCombineWorktreeWithWorkspace: 'tunnel',
    workspaceListAdhocMultiRepoJoinOptions: 'tunnel',
    workspaceCombineWorktreeWithExistingWorktree: 'tunnel',
    workspaceListExistingWorktreeJoinOptions: 'tunnel',
    workspacePromoteTemporary: 'tunnel',
    workspaceSplitTemporaryPreview: 'tunnel',
    workspaceSplitTemporaryApproveDestructive: 'tunnel',
    workspaceSplitTemporary: 'tunnel',
    workspaceSplitTemporaryComplete: 'tunnel',
    workspaceReadSettingsData: 'tunnel',
    workspaceReadReadiness: 'tunnel',
    workspaceSetArchiveRetention: 'tunnel',
    workspaceSetStartPage: 'tunnel',
    workspaceSetPrivateMemory: 'tunnel',
    workspacePrivateMemoryChanged: 'tunnel',
    startPageResolve: 'tunnel',
    archivedContainersList: 'tunnel',
    archivedContainersListChanges: 'tunnel',
    archivedContainersReadChangeDiff: 'tunnel',
    archivedContainersRefreshPullRequests: 'tunnel',
    archivedContainersListChats: 'tunnel',
    archivedContainersReadChat: 'tunnel',
    archivedContainersListExecutions: 'tunnel',
    archivedContainersListAttachments: 'tunnel',
    archivedContainersListPlans: 'tunnel',
    archivedContainersReadExecution: 'tunnel',
    archivedContainersReadExecutionReport: 'tunnel',
    archivedContainersReadExecutionStepLog: 'tunnel',
    archivedContainersRestore: 'tunnel',
    archivedContainersDelete: 'tunnel',
    archivedContainersSetLocked: 'tunnel',
    archivedContainersChanged: 'tunnel',
    autoArchiveCompleted: 'tunnel',
    workspaceCreateWorktree: 'tunnel',
    workspaceRepairWorktree: 'tunnel',
    workspaceArchiveWorktree: 'tunnel',
    workspaceDelete: 'tunnel',
    lifecycleJournalInspect: 'tunnel',
    lifecycleJournalQuarantine: 'tunnel',
    workspaceAddRepoToWorktree: 'tunnel',
    workspaceRemoveRepoFromWorktree: 'tunnel',
    workspaceReferenceRepoStatusEvent: 'tunnel',
    workspaceSourceChangesApplied: 'tunnel',
    workspaceResolveReferenceRepoWarning: 'tunnel',
    workspaceRequestReferenceRepoRefresh: 'tunnel',
    workspaceApplySourceChanges: 'tunnel',
    projectSourceChangesApplied: 'tunnel',
    projectApplySourceChanges: 'tunnel',
    workspaceLoadClaudeMd: 'tunnel',
    workspaceSaveClaudeMd: 'tunnel',
    projectDelete: 'tunnel',
    projectSaveScripts: 'tunnel',
    projectSaveDefaultPlugins: 'tunnel',
    desktopSessionSnapshot: 'tunnel',
    desktopSessionSnapshotStale: 'tunnel',
    desktopSessionSnapshotInvalidate: 'tunnel',
    // OS deep link delivered to this machine window
    deepLinkShareOpen: 'local',
    // remote-control deep link, feature itself
    deepLinkRemoteControlOpen: 'local',
    // OS deep link delivered to this machine window
    deepLinkSettingsOpen: 'local',
    deepLinkBillingUnlocked: 'local',
    deepLinkPrivacyOptInOpen: 'local',
    // OS deep link delivered to this machine window
    deepLinkOrgProjectOpen: 'local',
    // resolves share link opened on this machine
    deepLinkResolveShare: 'local',
    // handoff telemetry for deep link on this machine
    deepLinkReportHandoffEvent: 'local',
    workspaceUpdateMetadata: 'tunnel',
    workspaceReorder: 'tunnel',
    worktreeReorder: 'tunnel',
    workspaceReadScripts: 'tunnel',
    workspaceMergeScripts: 'tunnel',
    workspaceSaveDefaultPlugins: 'tunnel',
    workspaceSaveScripts: 'tunnel',
    workspaceSavePlanDetection: 'tunnel',
    workspaceSaveRepoScripts: 'tunnel',
    scriptRun: 'tunnel',
    scriptStarted: 'tunnel',
    scriptStop: 'tunnel',
    scriptCancelWorktreeSetup: 'tunnel',
    scriptLoadWorktreeRuns: 'tunnel',
    // One run's log tail for browser controllers, the read Portal's log
    // request runs (CAN-5985).
    scriptReadRunLog: 'tunnel',
    scriptOutput: 'tunnel',
    scriptComplete: 'tunnel',
    scriptSourceInfo: 'tunnel',
    projectSaveHooks: 'tunnel',
    workspaceSaveHooks: 'tunnel',
    workspaceSaveRepoHooks: 'tunnel',
    hookRun: 'tunnel',
    hookStarted: 'tunnel',
    hookStop: 'tunnel',
    hookLoadWorktreeRuns: 'tunnel',
    // Pause or resume hooks on the latest worktree row, as Portal's
    // hook pause applies it (CAN-5985).
    hookChangePause: 'tunnel',
    hookOutput: 'tunnel',
    hookComplete: 'tunnel',
    hookSourceInfo: 'tunnel',
    hookChatPluginDependenciesInspect: 'tunnel',
    recommendedPluginsInspect: 'tunnel',
    recommendedPluginsApply: 'tunnel',
    hookSkippedPaused: 'tunnel',
    worktreeSetPausedHooks: 'tunnel',
    worktreeSetHidden: 'tunnel',
    worktreeSetLabel: 'tunnel',
    worktreeSetPinned: 'tunnel',
    worktreeSetBranchGrouping: 'tunnel',
    chatSendMessage: 'tunnel',
    chatGetContextUsage: 'tunnel',
    chatGetState: 'tunnel',
    chatSearchTranscript: 'tunnel',
    chatCancelTranscriptSearch: 'tunnel',
    chatGetTranscriptPage: 'tunnel',
    chatReadToolOutput: 'tunnel',
    chatCancelToolOutput: 'tunnel',
    chatReadVisual: 'tunnel',
    chatCommand: 'tunnel',
    chatStateChanged: 'tunnel',
    chatQueueUpdated: 'tunnel',
    chatQueueEdit: 'tunnel',
    chatQueueCancel: 'tunnel',
    chatQueueForce: 'tunnel',
    chatQueueSetEditLock: 'tunnel',
    chatQueueGetSnapshot: 'tunnel',
    chatCancel: 'tunnel',
    chatResumeStoppedTurn: 'tunnel',
    chatDestroySession: 'tunnel',
    chatResetToPoint: 'tunnel',
    chatTransientRetryCancel: 'tunnel',
    chatTransientRetryGetSnapshot: 'tunnel',
    chatEvent: 'tunnel',
    // B renderer executes it; forwarding would apply twice
    chatWindowCommand: 'blocked',
    // B renderer executes it; forwarding would apply twice
    chatPortalComposerCommand: 'blocked',
    // answered by B renderer only
    chatPortalComposerCommandResult: 'blocked',
    chatLoadTabs: 'tunnel',
    chatFlushScope: 'tunnel',
    chatForkOpenWorktreeTabs: 'tunnel',
    chatAdhocMigrateTabs: 'tunnel',
    chatArchiveTab: 'tunnel',
    chatLoadArchives: 'tunnel',
    chatReadArchive: 'tunnel',
    chatRestoreArchive: 'tunnel',
    chatMarkArchiveRead: 'tunnel',
    chatMarkAllArchivesRead: 'tunnel',
    chatActiveSessions: 'tunnel',
    chatGenerateHandoffSummary: 'tunnel',
    chatForkCodexThread: 'tunnel',
    chatSessionExport: 'tunnel',
    chatSessionCloudExportList: 'tunnel',
    chatSessionCloudExportDelete: 'tunnel',
    chatSessionImportInspect: 'tunnel',
    chatSessionImport: 'tunnel',
    chatSessionImportDiscard: 'tunnel',
    chatSessionImported: 'tunnel',
    chatUpdatePlugins: 'tunnel',
    chatHookTabStarted: 'tunnel',
    chatHookQueueRemoved: 'tunnel',
    chatTabDescriptionUpdated: 'tunnel',
    chatCancelQueuedHookChat: 'tunnel',
    chatForceQueuedHookChat: 'tunnel',
    chatSetQueuedHookChatInterfaceMode: 'tunnel',
    chatPreparePlanFileSystemInstruction: 'tunnel',
    chatDeferredToolsReloadBegin: 'tunnel',
    chatDeferredToolsReloadFinish: 'tunnel',
    chatDeferredToolsReloadCancel: 'tunnel',
    chatDeferredToolsReloadEvent: 'tunnel',
    codeReviewGet: 'tunnel',
    codeReviewArm: 'tunnel',
    codeReviewGenerate: 'tunnel',
    codeReviewSaveComments: 'tunnel',
    codeReviewRegister: 'tunnel',
    codeReviewModalOpen: 'tunnel',
    codeReviewUpdated: 'tunnel',
    fileAnnotationsGet: 'tunnel',
    fileAnnotationsSave: 'tunnel',
    fileAnnotationsAppend: 'tunnel',
    fileAnnotationsDismiss: 'tunnel',
    fileAnnotationsUpdated: 'tunnel',
    mcpAskUser: 'tunnel',
    mcpAnswerUser: 'tunnel',
    mcpDismissUser: 'tunnel',
    mcpExpireAskUser: 'tunnel',
    approvalRequest: 'tunnel',
    approvalCancelled: 'tunnel',
    approvalAutoResolved: 'tunnel',
    approvalSecretInput: 'blocked',
    approvalRespond: 'tunnel',
    approvalDismiss: 'tunnel',
    approvalPendingRequests: 'tunnel',
    approvalModeSet: 'tunnel',
    approvalResolvedDefault: 'tunnel',
    approvalRuleAdded: 'tunnel',
    approvalRulesList: 'tunnel',
    approvalRuleRemove: 'tunnel',
    approvalRuleAdd: 'tunnel',
    planExitRequest: 'tunnel',
    planExitApprove: 'tunnel',
    planExitDeny: 'tunnel',
    planModeToggle: 'tunnel',
    chatCodexFastModeToggle: 'tunnel',
    thinkingLevelToggle: 'tunnel',
    chatModelChange: 'tunnel',
    listUsageLimitedIdleChats: 'tunnel',
    resumeUsageLimitedChats: 'tunnel',
    listUsageLimitedIdleSessions: 'tunnel',
    getResumeQueue: 'tunnel',
    enqueueResumeQueue: 'tunnel',
    controlResumeQueue: 'tunnel',
    resumeQueueChanged: 'tunnel',
    resumeUsageLimitedSessions: 'tunnel',
    chatProjectList: 'tunnel',
    chatProjectEnsureOrgDefaultCowork: 'tunnel',
    chatProjectGetOrgDefaultCoworkEligibility: 'tunnel',
    chatProjectBlueprintsList: 'tunnel',
    chatProjectBlueprintsRefresh: 'tunnel',
    chatProjectSharedTemplatesList: 'tunnel',
    chatProjectCreateOrgCowork: 'tunnel',
    chatProjectCreate: 'tunnel',
    chatProjectCreateFromTemplate: 'tunnel',
    chatProjectTemplateBuild: 'tunnel',
    chatProjectTemplateShareGet: 'tunnel',
    chatProjectTemplateSharePublish: 'tunnel',
    chatProjectTemplatePackageAnalyze: 'tunnel',
    chatProjectTemplatePackageCancelAnalysis: 'tunnel',
    chatProjectTemplatePackageCommit: 'tunnel',
    chatProjectTemplatePackageReadiness: 'tunnel',
    chatProjectTemplateShareRevoke: 'tunnel',
    chatProjectUpdate: 'tunnel',
    chatProjectDelete: 'tunnel',
    chatProjectCheckFolder: 'tunnel',
    chatProjectRollbackUnstartedSend: 'tunnel',
    chatProjectRevealFolderLocation: 'blocked',
    chatProjectLoadClaudeMd: 'tunnel',
    chatProjectSaveClaudeMd: 'tunnel',
    chatSearchCatalog: 'tunnel',
    chatSearchQuery: 'tunnel',
    chatSearchUpdated: 'tunnel',
    standaloneChatInit: 'tunnel',
    standaloneChatList: 'tunnel',
    standaloneChatReadSummary: 'tunnel',
    standaloneChatReadArchive: 'tunnel',
    standaloneChatResumeArchive: 'tunnel',
    standaloneChatLoadWorkspace: 'tunnel',
    standaloneChatExportProject: 'tunnel',
    standaloneChatImportProject: 'tunnel',
    standaloneChatMetaUpdated: 'tunnel',
    // Agent Ledger: the controlled computer's entries.
    ledgerSearchEntries: 'tunnel',
    ledgerGetEntry: 'tunnel',
    ledgerAddEntry: 'tunnel',
    ledgerUpdateEntry: 'tunnel',
    ledgerListOwners: 'tunnel',
    ledgerEntriesChanged: 'tunnel',
    ledgerFeedSearch: 'tunnel',
    ledgerFeedGetEntry: 'tunnel',
    ledgerFeedWork: 'tunnel',
    workEntriesList: 'tunnel',
    workEntriesCreate: 'tunnel',
    workEntriesUpdate: 'tunnel',
    workEntriesReorder: 'tunnel',
    workEntriesDelete: 'tunnel',
    workEntriesResolveChat: 'tunnel',
    // Agent-armed auto-delete is not in the remote-control contract yet; a
    // controlling window shows no armed badges until these are tunneled.
    workEntryAutoDeleteList: 'blocked',
    workEntryAutoDeleteDisarm: 'blocked',
    workEntryAutoDeleteResolveBranch: 'blocked',
    workEntryAutoDeleteChanged: 'blocked',
    settingsClaudeAuthStatus: 'tunnel',
    settingsProviderCarryover: 'tunnel',
    settingsCodexAuthStatus: 'tunnel',
    settingsGitHubCliStatus: 'tunnel',
    // the star is a personal action of the person at the keyboard: it runs
    // with the controlling computer's gh account, never the controlled one's
    settingsStarSourceRepository: 'local',
    settingsGitHubPermissions: 'tunnel',
    // returns raw secret/API key to caller
    settingsLoadGitHubPat: 'blocked',
    settingsSaveGitHubPat: 'tunnel',
    settingsRefreshGitHubCredentials: 'tunnel',
    // returns raw secret/API key to caller
    settingsLoadLinearToken: 'blocked',
    settingsSaveLinearToken: 'tunnel',
    settingsValidateLinearToken: 'tunnel',
    // returns raw secret/API key to caller
    modelGatewayLoadCredential: 'blocked',
    // The device AI gateway's config belongs to this computer: a controller
    // never reads or edits it. Key save and validate below tunnel as for any
    // gateway the host routes, so a paired controller can set the key for the
    // host's active Personal gateway, device or account, but never read it.
    localModelGatewayRead: 'blocked',
    localModelGatewayUpdate: 'blocked',
    localModelGatewayConnect: 'blocked',
    localModelGatewayChanged: 'blocked',
    localModelGatewayMigrationConflict: 'blocked',
    modelGatewaySaveCredential: 'tunnel',
    modelGatewayValidateCredential: 'tunnel',
    modelGatewayCredentialChanged: 'tunnel',
    settingsLoadCanopyCloudAccount: 'tunnel',
    // Local invalidation cannot accompany an account read tunneled to another host.
    settingsCanopyCloudSessionStatusChanged: 'blocked',
    settingsGetCanopyCloudBaseUrl: 'tunnel',
    // opens authenticated URL in system browser on A
    settingsOpenAuthenticatedPortalPage: 'local',
    settingsLoadCanopyCloudAiCredits: 'tunnel',
    settingsLoadCanopyCloudEntitlements: 'tunnel',
    settingsLoadCloudReleaseNotes: 'tunnel',
    settingsLoadCloudDigestPreferences: 'tunnel',
    settingsSaveCloudDigestPreferences: 'tunnel',
    settingsLoadInstallUpdateEmailPreference: 'tunnel',
    settingsSaveInstallUpdateEmailPreference: 'tunnel',
    settingsLoadDailyCreditDrip: 'tunnel',
    settingsSaveDailyCreditDrip: 'tunnel',
    canopyCloudMobileActivationLoad: 'tunnel',
    settingsLoadNativeAiCreditsAvailability: 'tunnel',
    // returns raw secret/API key to caller
    settingsLoadCanopyCloudApiKey: 'blocked',
    // Re-checks this computer's credential store; never another host's.
    secureStorageRecheck: 'local',
    settingsSaveCanopyCloudApiKey: 'tunnel',
    // would sever B's cloud identity, breaking the remote session
    settingsClearCanopyCloudApiKey: 'blocked',
    // OAuth browser/callback happens on B's machine
    settingsStartCanopyCloudOAuthLogin: 'blocked',
    // OAuth browser/callback happens on B's machine
    settingsCancelCanopyCloudOAuthLogin: 'blocked',
    // would sever B's cloud identity, breaking the remote session
    settingsDisconnectCanopyCloudAccount: 'blocked',
    // would sever B's cloud identity, breaking the remote session
    settingsResetUnreadableCanopyCloudAccount: 'blocked',
    settingsStartCanopyGuestSession: 'tunnel',
    settingsValidateCanopyCloudApiKey: 'tunnel',
    settingsRefreshCanopyCloudEnforcedSettings: 'tunnel',
    settingsSearchLinearIssues: 'tunnel',
    referencePreviewLinearScope: 'tunnel',
    referencePreviewLinearIssue: 'tunnel',
    referencePreviewLinearTeams: 'tunnel',
    feedbackDiagnosticsPrepare: 'tunnel',
    feedbackDiagnosticsRead: 'tunnel',
    feedbackDiagnosticsSave: 'tunnel',
    feedbackDiagnosticsRelease: 'tunnel',
    feedbackReportSubmit: 'tunnel',
    feedbackDiagnosticsCapabilities: 'tunnel',
    feedbackPrepare: 'tunnel',
    feedbackSubmit: 'tunnel',
    turnFeedbackRate: 'tunnel',
    turnFeedbackDetail: 'tunnel',
    turnFeedbackClear: 'tunnel',
    turnFeedbackList: 'tunnel',
    orgMemoryFeedbackSubmit: 'tunnel',
    orgMemoryFeedbackGet: 'tunnel',
    // installs/inspects app CLI on PATH of user's own machine
    cliGetStatus: 'local',
    // installs/inspects app CLI on PATH of user's own machine
    cliInstallToPath: 'local',
    // installs/inspects app CLI on PATH of user's own machine
    cliUninstallFromPath: 'local',
    // app updater/version of machine in use
    updateCheck: 'local',
    // app updater/version of machine in use
    updateCheckVersion: 'local',
    // app updater/version of machine in use
    updateListVersions: 'local',
    // app updater/version of machine in use
    updateDownload: 'local',
    // app updater/version of machine in use
    updateInstall: 'local',
    // app updater/version of machine in use
    updateSchedule: 'local',
    // app updater/version of machine in use
    updateCancelScheduled: 'local',
    // app updater/version of machine in use
    updateReportBusy: 'local',
    // app updater/version of machine in use
    updateGetVersion: 'local',
    // app updater/version of machine in use
    updateGetDependencyVersions: 'local',
    // app updater/version of machine in use
    updateGetState: 'local',
    // app updater/version of machine in use
    updateEvent: 'local',
    telemetrySyncGetStatus: 'tunnel',
    telemetrySyncRecordActivity: 'tunnel',
    telemetrySyncStatusEvent: 'tunnel',
    observabilityLoadSnapshot: 'tunnel',
    observabilityLoadHistory: 'tunnel',
    observabilityLoadTranscript: 'tunnel',
    observabilityLoadUsageTimeseries: 'tunnel',
    observabilityLoadUsageMetrics: 'tunnel',
    observabilityLoadUsageMetricsView: 'tunnel',
    observabilityLoadUsageTabSummary: 'tunnel',
    observabilityRefreshUsage: 'tunnel',
    // renderer PostHog/diagnostics identity of this window
    observabilityRecordDesktopInstrumentationInitFailure: 'local',
    // A remote window's renderer diagnostics stay on the controlling computer.
    observabilityRecordRendererSummary: 'local',
    // renderer PostHog/diagnostics identity of this window
    observabilityGetPostHogAnonymousId: 'local',
    // renderer PostHog/diagnostics identity of this window
    observabilityGetPostHogEmailDomain: 'local',
    // renderer PostHog/diagnostics identity of this window
    observabilityPostHogEmailDomainUpdate: 'local',
    // renderer PostHog/diagnostics identity of this window
    observabilityGetPostHogSession: 'local',
    // renderer PostHog/diagnostics identity of this window
    observabilityReportPostHogSessionRotation: 'local',
    // renderer PostHog/diagnostics identity of this window
    observabilityPostHogSessionUpdate: 'local',
    // this computer's effective usage-data policy for its own telemetry
    observabilityGetUsageDataPolicy: 'local',
    // this computer's effective usage-data policy for its own telemetry
    observabilityUsageDataPolicyChanged: 'local',
    observabilityEvent: 'tunnel',
    githubCreatePr: 'tunnel',
    githubRequestRefresh: 'tunnel',
    githubRequestFastRefresh: 'tunnel',
    githubRequestKnownPrFastRefresh: 'tunnel',
    githubSetForegroundWorktree: 'tunnel',
    githubPrStatusEvent: 'tunnel',
    githubDependentBaseBranchesUpdated: 'tunnel',
    githubRateLimitEvent: 'tunnel',
    githubPrCreationProgress: 'tunnel',
    githubGenerateCommitMessages: 'tunnel',
    githubCancelGitAction: 'tunnel',
    githubCommitAndPush: 'tunnel',
    githubCommitPushProgress: 'tunnel',
    githubPushOnly: 'tunnel',
    githubPull: 'tunnel',
    githubMergeLocalBranches: 'tunnel',
    githubMergePr: 'tunnel',
    githubMergePrProgress: 'tunnel',
    githubStartMergeConflictResolution: 'tunnel',
    githubStartPrCommentTriage: 'tunnel',
    githubStartCiCheckFix: 'tunnel',
    githubUpdatePrBaseBranch: 'tunnel',
    githubListUserRepos: 'tunnel',
    githubResolvePullRequest: 'tunnel',
    githubListPullRequests: 'tunnel',
    githubSearchPullRequests: 'tunnel',
    githubGetRepoSlug: 'tunnel',
    githubSplitPrPlan: 'tunnel',
    githubSplitPrCancel: 'tunnel',
    githubSplitPrDiscard: 'tunnel',
    githubSplitPrProgress: 'tunnel',
    githubSplitPrGetMap: 'tunnel',
    githubSplitWorkflowStart: 'tunnel',
    githubSplitWorkflowApprove: 'tunnel',
    githubSplitWorkflowExit: 'tunnel',
    githubSplitLockEvent: 'tunnel',
    githubSplitLockState: 'tunnel',
    githubGetMergeQueue: 'tunnel',
    githubGetPrState: 'tunnel',
    // lists B's apps for open-in, which is blocked
    worktreeDetectApps: 'blocked',
    // lists B's apps for open-in, which is blocked
    worktreeRefreshDetectedApps: 'blocked',
    // opens path in external app on B's screen
    worktreeOpenIn: 'blocked',
    worktreeGetPath: 'tunnel',
    worktreeListRepoEntries: 'tunnel',
    // opens path in external app on B's screen
    fileShowInFinder: 'blocked',
    // opens path in external app on B's screen; the controller copies the
    // file with `file.read` and opens it itself (RemoteControlService)
    fileOpenExternal: 'blocked',
    fileReadPreview: 'tunnel',
    fileReadContent: 'tunnel',
    fileReadDocumentBytes: 'tunnel',
    fileSaveContent: 'tunnel',
    modelRegistryGet: 'tunnel',
    modelRegistryUpdated: 'tunnel',
    aiGatewayModelCatalogRetry: 'tunnel',
    harnessAssignmentsLoad: 'tunnel',
    harnessAssignmentsSet: 'tunnel',
    harnessAssignmentsReset: 'tunnel',
    agentsList: 'tunnel',
    agentsGet: 'tunnel',
    agentsSave: 'tunnel',
    agentsDelete: 'tunnel',
    agentsImportShared: 'tunnel',
    agentsImportReadiness: 'tunnel',
    agentsPublicImportReadiness: 'tunnel',
    agentsPackageAnalyze: 'tunnel',
    agentsPackageCancelAnalysis: 'tunnel',
    agentsPackageCommit: 'tunnel',
    agentsDetectPublic: 'tunnel',
    agentsImportPublic: 'tunnel',
    agentsUninstallPublic: 'tunnel',
    agentsSharedList: 'tunnel',
    agentsSharedGet: 'tunnel',
    agentsSharedCreate: 'tunnel',
    agentsSharedUpdate: 'tunnel',
    agentsSharedDelete: 'tunnel',
    agentsPublicSharePublish: 'tunnel',
    agentsPublicShareRevoke: 'tunnel',
    agentsChanged: 'tunnel',
    // Cost views read the controlled computer's chats and pipeline runs.
    costGetScope: 'tunnel',
    costGetChat: 'tunnel',
    costGetPipelineRun: 'tunnel',
    costRefresh: 'tunnel',
    costWatchScope: 'tunnel',
    costUnwatchScope: 'tunnel',
    costUpdated: 'tunnel',
    resourceMonitorGetSnapshot: 'tunnel',
    resourceMonitorSnapshot: 'tunnel',
    memoryDiagnosticsGetStatus: 'blocked',
    memoryDiagnosticsCreateReport: 'blocked',
    memoryDiagnosticsRevealReport: 'blocked',
    // slow-action UI tracker of the renderer
    slowActionSnapshot: 'local',
    // slow-action UI tracker of the renderer
    slowActionEvent: 'local',
    // slow-action UI tracker of the renderer
    slowActionClear: 'local',
    wakeLockGetState: 'tunnel',
    wakeLockStateChanged: 'tunnel',
    ollamaGetState: 'tunnel',
    ollamaRefreshModels: 'tunnel',
    ollamaPullModel: 'tunnel',
    ollamaDeleteModel: 'tunnel',
    ollamaSetConfiguration: 'tunnel',
    ollamaTestConnection: 'tunnel',
    ollamaRedetectInstallation: 'tunnel',
    ollamaBrowseInstallation: 'tunnel',
    ollamaInstall: 'tunnel',
    ollamaInstallProgress: 'tunnel',
    ollamaStatus: 'tunnel',
    ollamaPullProgress: 'tunnel',
    gitExecutableStatus: 'tunnel',
    gitExecutableRedetect: 'tunnel',
    gitExecutableBrowse: 'tunnel',
    gitExecutableInstallWinget: 'tunnel',
    gitExecutableInstallXcode: 'tunnel',
    gitExecutableInstallProgress: 'tunnel',
    // OS notification display/permission on this machine
    osNotificationShow: 'local',
    // OS notification display/permission on this machine
    osNotificationOptIn: 'local',
    // OS notification display/permission on this machine
    osNotificationOpenSystemSettings: 'local',
    // OS notification display/permission on this machine
    osNotificationClicked: 'local',
    // OS notification display/permission on this machine
    osNotificationClosed: 'local',
    // OS notification click navigation push to main window
    activationCampaignNavigate: 'local',
    // voice dictation/microphone on this machine
    voiceIsSupported: 'local',
    // voice dictation/microphone on this machine
    voiceResetSupport: 'local',
    // voice dictation/microphone on this machine
    voiceGetMicrophoneAccess: 'local',
    // voice dictation/microphone on this machine
    voiceRequestSystemAccess: 'local',
    // voice dictation/microphone on this machine
    voiceStart: 'local',
    // voice dictation/microphone on this machine
    voicePushAudio: 'local',
    // voice dictation/microphone on this machine
    voiceStop: 'local',
    // voice dictation/microphone on this machine
    voiceCancel: 'local',
    // voice dictation/microphone on this machine
    voiceEvent: 'local',
    // voice dictation/microphone on this machine
    voiceOpenSettings: 'local',
    terminalSpawn: 'tunnel',
    terminalRestore: 'tunnel',
    terminalAttach: 'tunnel',
    terminalWrite: 'tunnel',
    terminalResize: 'tunnel',
    terminalKill: 'tunnel',
    terminalLoadWorktreeState: 'tunnel',
    terminalSaveWorktreeState: 'tunnel',
    terminalList: 'tunnel',
    terminalListProfiles: 'tunnel',
    terminalGetSettings: 'tunnel',
    terminalUpdateSettings: 'tunnel',
    panelLayoutLoad: 'tunnel',
    panelLayoutSave: 'tunnel',
    panelLayoutDelete: 'tunnel',
    panelLayoutLoadMode: 'tunnel',
    panelLayoutInitializeMode: 'tunnel',
    panelLayoutSaveMode: 'tunnel',
    panelLayoutSaveDefault: 'tunnel',
    panelLayoutLoadDefault: 'tunnel',
    workspaceNotesList: 'tunnel',
    workspaceNotesRead: 'tunnel',
    workspaceNotesSave: 'tunnel',
    workspaceNotesDelete: 'tunnel',
    workspacePromptsList: 'tunnel',
    workspacePromptsRead: 'tunnel',
    workspacePromptsReadByPath: 'tunnel',
    workspacePromptsSave: 'tunnel',
    workspacePromptsDelete: 'tunnel',
    workspaceAttachmentsList: 'tunnel',
    workspaceAttachmentsImport: 'tunnel',
    workspaceAttachmentsDelete: 'tunnel',
    terminalOutput: 'tunnel',
    terminalSpawned: 'tunnel',
    terminalExit: 'tunnel',
    terminalRunningChanged: 'tunnel',
    claudeTerminalLaunch: 'tunnel',
    claudeTerminalCleanup: 'tunnel',
    claudeTerminalGetState: 'tunnel',
    claudeTerminalInterrupt: 'tunnel',
    claudeTerminalSyncTranscript: 'tunnel',
    claudeTerminalStateChanged: 'tunnel',
    claudeTerminalScheduledPrompt: 'tunnel',
    claudeTerminalSyncCompleted: 'tunnel',
    claudeTerminalError: 'tunnel',
    // Each sign-in attempt belongs to the app window that started it
    // (ipc/codex-login.ts), so a remote window cannot drive one; sign in on
    // that computer.
    codexLoginStart: 'blocked',
    codexLoginCancel: 'blocked',
    codexLoginRetryVerification: 'blocked',
    codexLoginOpenBrowser: 'blocked',
    codexLoginState: 'blocked',
    authTerminalStart: 'tunnel',
    authTerminalWrite: 'tunnel',
    authTerminalResize: 'tunnel',
    authTerminalStop: 'tunnel',
    authTerminalOutput: 'tunnel',
    authTerminalExit: 'tunnel',
    // in-app browser native view not available remotely
    browserProfiles: 'blocked',
    // in-app browser native view not available remotely
    browserSwitchProfile: 'blocked',
    // in-app browser native view not available remotely
    browserCreate: 'blocked',
    // in-app browser native view not available remotely
    browserDestroy: 'blocked',
    // in-app browser native view not available remotely
    browserDisposeLiveView: 'blocked',
    // in-app browser native view not available remotely
    browserLoadWorktreeState: 'blocked',
    // in-app browser native view not available remotely
    browserSaveWorktreeState: 'blocked',
    // in-app browser native view not available remotely
    browserSetActive: 'blocked',
    // in-app browser native view not available remotely
    browserSetBounds: 'blocked',
    // in-app browser native view not available remotely
    browserSetVisible: 'blocked',
    // native overlay layer views are local window presentation
    overlayLayerSetBounds: 'blocked',
    // native overlay layer views are local window presentation
    overlayLayerFocus: 'blocked',
    // in-app browser native view not available remotely
    browserNavigate: 'blocked',
    // in-app browser native view not available remotely
    browserBack: 'blocked',
    // in-app browser native view not available remotely
    browserForward: 'blocked',
    // in-app browser native view not available remotely
    browserReload: 'blocked',
    // in-app browser native view not available remotely
    browserStop: 'blocked',
    // in-app browser native view not available remotely
    browserSetTheme: 'blocked',
    // in-app browser native view not available remotely
    browserSetPickMode: 'blocked',
    // in-app browser native view not available remotely
    browserOpenLink: 'blocked',
    // in-app browser native view not available remotely
    browserReportLinkBrowserTarget: 'blocked',
    // in-app browser native view not available remotely
    browserResolveOpenLinkRequest: 'blocked',
    // in-app browser native view not available remotely
    browserGetDefaultRegistrationStatus: 'blocked',
    // in-app browser native view not available remotely
    browserDefaultRegistrationStatusChanged: 'blocked',
    // in-app browser native view not available remotely
    browserOpenExternal: 'blocked',
    // in-app browser native view not available remotely
    browserGetConsole: 'blocked',
    // in-app browser native view not available remotely
    browserGetNetwork: 'blocked',
    // in-app browser native view not available remotely
    browserScreenshot: 'blocked',
    // in-app browser native view not available remotely
    browserInputSnapshot: 'blocked',
    // in-app browser native view not available remotely
    browserInspect: 'blocked',
    // in-app browser native view not available remotely
    browserGetDialog: 'blocked',
    // in-app browser native view not available remotely
    browserHandleDialog: 'blocked',
    // in-app browser native view not available remotely
    browserAutomation: 'blocked',
    // in-app browser native view not available remotely
    browserStartRecording: 'blocked',
    // in-app browser native view not available remotely
    browserStopRecording: 'blocked',
    // in-app browser native view not available remotely
    browserFindInPage: 'blocked',
    // in-app browser native view not available remotely
    browserStopFindInPage: 'blocked',
    // in-app browser native view not available remotely
    browserClearRecording: 'blocked',
    // in-app browser native view not available remotely
    browserGetRecording: 'blocked',
    // in-app browser native view not available remotely
    browserListTransfers: 'blocked',
    // in-app browser native view not available remotely
    browserTransferCommand: 'blocked',
    // in-app browser native view not available remotely
    browserSaveDownload: 'blocked',
    // in-app browser native view not available remotely
    browserAnswerFileChooser: 'blocked',
    // in-app browser native view not available remotely
    browserGetFileChooser: 'blocked',
    // in-app browser native view not available remotely
    browserSavePdf: 'blocked',
    // in-app browser native view not available remotely
    browserGetPrintRequest: 'blocked',
    // in-app browser native view not available remotely
    browserAnswerPrintRequest: 'blocked',
    // in-app browser native view not available remotely
    browserGetAuthRequest: 'blocked',
    // in-app browser native view not available remotely
    browserAnswerAuthRequest: 'blocked',
    // in-app browser native view not available remotely
    browserEvent: 'blocked',
    // Remote Control (Portal) pairing/state of B
    canopyPortalGetState: 'blocked',
    // Remote Control (Portal) pairing/state of B
    canopyPortalStart: 'blocked',
    // Remote Control (Portal) pairing/state of B
    canopyPortalStop: 'blocked',
    // Remote Control (Portal) pairing/state of B
    canopyPortalRegeneratePairingCode: 'blocked',
    // Remote Control (Portal) pairing/state of B
    canopyPortalCancelPairingCode: 'blocked',
    // Remote Control (Portal) pairing/state of B
    canopyPortalStateChanged: 'blocked',
    experimentsGetSnapshot: 'tunnel',
    experimentsSetChoice: 'tunnel',
    experimentsSnapshotChanged: 'tunnel',
    featureFlagsGetSnapshot: 'tunnel',
    featureFlagsRefreshContext: 'tunnel',
    featureFlagsSnapshotChanged: 'tunnel',
    foreignActivityGet: 'tunnel',
    foreignActivityChanged: 'tunnel',
    foreignActivityStop: 'tunnel',
    managedDelegationActivityChanged: 'tunnel',
    managedDelegationActivityList: 'tunnel',
    managedDelegationStop: 'tunnel',
    managedDelegationStopAll: 'tunnel',
    managedDelegationChanges: 'tunnel',
    managedDelegationTranscript: 'tunnel',
    workspaceContextGet: 'tunnel',
    workspaceContextSet: 'tunnel',
    workspaceContextChanged: 'tunnel',
    orgProjectsSharedMultiRepoPrepare: 'blocked',
    orgProjectsSharedMultiRepoCreate: 'blocked',
    orgProjectsSharedMultiRepoGetCreation: 'blocked',
    orgProjectsSharedMultiRepoListCreations: 'blocked',
    orgProjectsSetupStart: 'tunnel',
    orgProjectsSetupFromFolder: 'tunnel',
    orgProjectsMemberCodeEligibility: 'tunnel',
    orgProjectsInspectFolder: 'tunnel',
    orgProjectsFindRepositoryOwner: 'tunnel',
    orgProjectsCreateMemberCodeProject: 'tunnel',
    orgProjectsCreateMemberMultiRepoProject: 'tunnel',
    orgProjectsCheckRepositories: 'tunnel',
    orgProjectsSetupCancel: 'tunnel',
    orgProjectsSetupProgress: 'tunnel',
    orgProjectsConvertWorkspace: 'tunnel',
    orgProjectsMoveWorkspace: 'tunnel',
    // Linking a workspace to its cloud project (CAN-5190) stays on the
    // computer whose checkout it is, until a controlled link is designed.
    cloudProjectsFindLink: 'blocked',
    cloudProjectsLink: 'blocked',
    // Setting a cloud project up clones onto this computer with its own Git
    // credentials (CAN-5192); a remote controller cannot start it.
    cloudProjectsSetupCatalog: 'blocked',
    cloudProjectsSetupOptions: 'blocked',
    cloudProjectsStartSetup: 'blocked',
    cloudProjectsSetupProgress: 'blocked',
    // A cloud session remint is the local person's action (CAN-4185).
    cloudChatsReconnect: 'blocked',
    // Bytes from the local person's own file pick (CAN-5972).
    cloudChatsUploadAttachment: 'blocked',
    orgProjectsMoveBackToPersonal: 'tunnel',
    orgProjectsOwnershipChanged: 'tunnel',
    orgProjectsList: 'tunnel',
    orgProjectLinksList: 'tunnel',
    orgProjectLinksDecide: 'tunnel',
    orgProjectsRefresh: 'tunnel',
    orgProjectsSetPreference: 'tunnel',
    orgProjectsChanged: 'tunnel',
    // The controlled computer addresses each request to one window: its own,
    // or the controller's window for a chat driven from there.
    appAdvisorToolRequest: 'tunnel',
    appAdvisorToolRequestCancelled: 'tunnel',
    appAdvisorToolResponse: 'tunnel',
    appAdvisorGetState: 'tunnel',
    appAdvisorStateChanged: 'tunnel',
    appAdvisorSettingsLoad: 'tunnel',
    appAdvisorSettingsSave: 'tunnel',
    // The Orchestrator settings Portal's settings get and save serve
    // (CAN-5985).
    appAdvisorSettingsView: 'tunnel',
    appAdvisorSettingsPatch: 'tunnel',
    appAdvisorSettingsChanged: 'tunnel',
    appAdvisorLoadClaudeMd: 'tunnel',
    appAdvisorSaveClaudeMd: 'tunnel',
    appAdvisorReportWindowUiState: 'tunnel',
    appAdvisorWindowUiStateChanged: 'tunnel',
    // The controlled computer keeps an App Advisor window per controller and
    // asks the controller to show it.
    appAdvisorWindowOpen: 'tunnel',
    appAdvisorWindowEnsure: 'tunnel',
    appAdvisorWindowClose: 'tunnel',
    appAdvisorWindowToggle: 'tunnel',
    appAdvisorWindowGetState: 'tunnel',
    appAdvisorWindowStateChanged: 'tunnel',
    appAdvisorWindowRendererReady: 'tunnel',
    appAdvisorWindowCommand: 'tunnel',
    appAdvisorOpenAgentArtifact: 'tunnel',
    appAdvisorOpenTurnFile: 'tunnel',
    appAdvisorTurnFileClosed: 'tunnel',
    appAdvisorWatchersList: 'tunnel',
    appAdvisorWatchersCompletedList: 'tunnel',
    appAdvisorWatcherDelete: 'tunnel',
    appAdvisorWatcherCreate: 'tunnel',
    appAdvisorWatcherUpdate: 'tunnel',
    appAdvisorWatcherHoldFiring: 'tunnel',
    appAdvisorWatcherReleaseFiring: 'tunnel',
    appAdvisorWatchersChanged: 'tunnel',
    appAdvisorWatcherMessageDelivery: 'tunnel',
    // Main asks one renderer to edit its open pipeline; a controller's
    // renderer would edit and save its own.
    pipelineEditorToolRequest: 'blocked',
    pipelineEditorToolResponse: 'blocked',
    automationsList: 'tunnel',
    automationsListRuns: 'tunnel',
    automationsCreate: 'tunnel',
    automationsUpdate: 'tunnel',
    automationsDelete: 'tunnel',
    automationsRunNow: 'tunnel',
    automationsCancelRun: 'tunnel',
    automationsGenerateCron: 'tunnel',
    automationsGenerateIfCommand: 'tunnel',
    automationsChanged: 'tunnel',
    automationsSharedList: 'tunnel',
    automationsSharedGet: 'tunnel',
    automationsCuratedList: 'tunnel',
    automationsCuratedGet: 'tunnel',
    automationsSharedCreate: 'tunnel',
    automationsSharedUpdate: 'tunnel',
    automationsSharedDelete: 'tunnel',
    automationsPublicSharePublish: 'tunnel',
    automationsPublicShareRevoke: 'tunnel',
    automationsCapabilityPackageAnalyze: 'tunnel',
    automationsCapabilityPackageCancel: 'tunnel',
    automationsCapabilityPackageCommit: 'tunnel',
    automationsCapabilityPackageReadiness: 'tunnel',
    automationsCapabilityPackageInstall: 'tunnel',
    automationsSharedPipelinePinVerify: 'tunnel',
    automationsSharedPipelinePinResolve: 'tunnel',
    automationsSharedPipelineReviewApprove: 'tunnel',
    externalProjectsDiscover: 'tunnel',
    // Local consent authorizes ongoing rule reads, not remote filesystem access.
    repoRulesScan: 'blocked',
    repoRulesApply: 'blocked',
    repoRulesStatus: 'blocked',
    repoRulesCheck: 'blocked',
    repoRulesPreview: 'blocked',
    editorSetupPresence: 'blocked',
    // Read-only menus and the picker catalog Portal's executor serves; the
    // invocable resolve writes nothing (CAN-5985).
    editorListSlashCommands: 'tunnel',
    editorListInvocables: 'tunnel',
    editorResolveInvocable: 'tunnel',
    pluginCatalogList: 'tunnel',
    externalProjectsImport: 'tunnel',
    externalProjectsPickFolder: 'tunnel',
    externalProjectsReadInvite: 'tunnel',
    externalProjectsAcknowledgeInvite: 'tunnel',
    externalProjectsProviderPresence: 'tunnel',
    externalProjectsImportProgress: 'tunnel',
    workersList: 'tunnel',
    workerCancel: 'tunnel',
    workerRetry: 'tunnel',
    workerStarted: 'tunnel',
    workerUpdated: 'tunnel',
    workerExited: 'tunnel',
    environmentConfigLoad: 'tunnel',
    environmentConfigSave: 'tunnel',
    codeGraphBuildStatusChanged: 'tunnel',
    codeGraphGetWorktreeSummary: 'tunnel',
    codeGraphBuildWorktree: 'tunnel',
    codeGraphSchedulePerformanceBuild: 'tunnel',
    codeGraphGetWorkspaceSummary: 'tunnel',
    codeGraphBuildWorkspace: 'tunnel',
    codeGraphGetGenerationQueue: 'tunnel',
    codeGraphReorderGenerationQueue: 'tunnel',
    codeGraphGenerationQueueChanged: 'tunnel',
    localMemoryRebuild: 'tunnel',
    localMemoryListSnapshots: 'tunnel',
    localMemoryRestoreSnapshot: 'tunnel',
    // Memory sync is the account's consent and a computer's own cloud
    // binding: it is turned on, merged and deleted on that computer, not
    // from another one controlling it (CAN-5188).
    memorySyncGetState: 'blocked',
    memorySyncChanged: 'blocked',
    memorySyncUpdateSettings: 'blocked',
    memorySyncPreviewMerge: 'blocked',
    memorySyncApplyMerge: 'blocked',
    memorySyncReadConflict: 'blocked',
    memorySyncResolveConflict: 'blocked',
    memorySyncListHistory: 'blocked',
    memorySyncRestore: 'blocked',
    memorySyncDeleteFromCloud: 'blocked',
    memorySyncSetProjectMemory: 'blocked',
    workspaceCheckAddFromFolder: 'tunnel',
    chatSetStateScopes: 'tunnel',
    // A remote window's interest reaches the host that publishes to it.
    chatSetInterest: 'tunnel',
    // This computer encodes the `chat:event` pushes it forwards to each
    // window, so a window's reset request resets this computer's encoder.
    chatEventOutputReset: 'local',
    spaceNotificationsGetSnapshot: 'tunnel',
    spaceNotificationsRefresh: 'tunnel',
    spaceNotificationsSet: 'tunnel',
    spaceNotificationsChanged: 'tunnel',
    sidebarItemGroupsList: 'tunnel',
    sidebarItemGroupsCreate: 'tunnel',
    sidebarItemGroupsUpdate: 'tunnel',
    sidebarItemGroupsUngroup: 'tunnel',
    sidebarItemGroupsMoveItem: 'tunnel',
    sidebarItemGroupsMoveGroup: 'tunnel',
    sidebarItemGroupsChanged: 'tunnel',
    // Remote-control plumbing and machine management run on the controller.
    remoteControlGetState: 'local',
    remoteControlStateChanged: 'local',
    remoteControlOpenMachine: 'local',
    remoteControlSetAllowIncoming: 'local',
    remoteControlSetAllowRemoteUpdates: 'local',
    remoteControlStartPairing: 'local',
    remoteControlCancelPairing: 'local',
    remoteControlRespondToPairing: 'local',
    remoteControlForgetDevice: 'local',
    remoteControlDisconnectController: 'local',
    remoteControlInvoke: 'local',
    remoteControlSend: 'local',
    remoteControlPush: 'local',
    remoteControlUpload: 'local',
    remoteControlPathPickerRequest: 'local',
    remoteControlPathPickerResolve: 'local',
    remoteControlListDirectory: 'tunnel',
    // The pairing window is this computer's own opt-in surface.
    remoteControlOpenPairingWindow: 'local',
    remoteControlClosePairingWindow: 'local',
    remoteControlPairingEvent: 'local',
    // The controlled computer's stable install identifier; controllers
    // (hosted MCP pairing) read it after authorization.
    remoteControlInstallId: 'tunnel',
  };

export const PIPELINE_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof PIPELINE_CHANNELS
> = {
  LIST: 'tunnel',
  CURATED_LIST: 'tunnel',
  CURATED_GET: 'tunnel',
  CURATED_IMPORT: 'tunnel',
  DISCOVER_PROJECT: 'tunnel',
  GET: 'tunnel',
  SAVE: 'tunnel',
  DELETE: 'tunnel',
  DUPLICATE: 'tunnel',
  RESOLVE_ACTION: 'tunnel',
  LIST_ACTIONS: 'tunnel',
  EXECUTE: 'tunnel',
  // The controlled computer starts a cloud run, so its web core decides.
  CLOUD_RUNS_AVAILABILITY: 'tunnel',
  RESUME: 'tunnel',
  RESUME_AUTOMATION: 'tunnel',
  RETRY_EXECUTION: 'tunnel',
  RERUN_EXECUTION: 'tunnel',
  CANCEL_EXECUTION: 'tunnel',
  RETRY_MATRIX_JOB: 'tunnel',
  CANCEL_MATRIX_VARIANT: 'tunnel',
  GET_EXECUTION: 'tunnel',
  LIST_EXECUTIONS: 'tunnel',
  LIST_FOR_WORKTREE: 'tunnel',
  LIST_WORKTREE_EXECUTIONS: 'tunnel',
  GET_WORKTREE_EXECUTION: 'tunnel',
  GET_FOR_WORKTREE: 'tunnel',
  SET_EXECUTION_HIDDEN: 'tunnel',
  EXECUTION_EVENT: 'tunnel',
  STEP_OUTPUT_EVENT: 'tunnel',
  READ_STEP_LOG: 'tunnel',
  READ_REPORT_FILE: 'tunnel',
  RESOLVE_PLUGIN_COLLECTIONS: 'tunnel',
  LIST_CAPABILITY_REFS: 'tunnel',
  SAVE_PLUGIN_COLLECTION_PREFERENCES: 'tunnel',
  LOAD_MODEL_ALIAS_PREFERENCES: 'tunnel',
  SAVE_MODEL_ALIAS_PREFERENCES: 'tunnel',
  SHARED_LIST: 'tunnel',
  SHARED_GET: 'tunnel',
  SHARED_CREATE: 'tunnel',
  ANALYZE_PACKAGE: 'tunnel',
  CANCEL_PACKAGE_ANALYSIS: 'tunnel',
  SHARED_CREATE_PACKAGED: 'tunnel',
  PACKAGE_PROGRESS: 'tunnel',
  PACKAGE_READINESS: 'tunnel',
  PACKAGE_INSTALLS_LIST: 'tunnel',
  INSTALL_PACKAGE_SHARE: 'tunnel',
  SHARED_UPDATE_IMPACT: 'tunnel',
  SHARED_UPDATE: 'tunnel',
  SHARED_DELETE: 'tunnel',
  SHARED_PUBLIC_PUBLISH: 'tunnel',
  SHARED_PUBLIC_REVOKE: 'tunnel',
  SHARED_ORGANIZATIONS_LIST: 'tunnel',
  SHARED_TEAMS_LIST: 'tunnel',
  PIPELINE_QUEUE_EVENT: 'tunnel',
  LIST_QUEUED_EXECUTIONS: 'tunnel',
  CANCEL_QUEUED_EXECUTION: 'tunnel',
  RUN_ADVISOR: 'tunnel',
  GET_ADVISOR: 'tunnel',
  LIST_ADVISORS: 'tunnel',
  ADVISOR_EVENT: 'tunnel',
};

export const MCP_SERVER_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof MCP_SERVER_CHANNELS
> = {
  LIST_ACCOUNT_CONNECTIONS: 'tunnel',
  START_ACCOUNT: 'tunnel',
  GET_ACCOUNT: 'tunnel',
  UPDATE_ACCOUNT: 'tunnel',
  REMOVE_ACCOUNT: 'tunnel',
  REWRITE_REFS: 'tunnel',
  DISCONNECT_ACCOUNT: 'tunnel',
  SET_ACCOUNT_TOOLS: 'tunnel',
  LIST_ACCOUNT_UPSTREAM_TOOLS: 'tunnel',
  AWAIT_ACCOUNT: 'tunnel',
  LOAD_INDEX: 'tunnel',
  LOAD_SERVER: 'tunnel',
  SAVE_SERVER: 'tunnel',
  DELETE_SERVER: 'tunnel',
  CHECK_HEALTH: 'tunnel',
  TEST_CONNECTION: 'tunnel',
  LIST_DETECTED: 'tunnel',
  CANCEL_OAUTH_LOGIN: 'tunnel',
  // OAuth browser and callback would open on B
  START_OAUTH_LOGIN: 'blocked',
  CLEAR_OAUTH_TOKEN: 'tunnel',
  GET_PROXY_STATE: 'tunnel',
  APPLY_PROXY_PORT: 'tunnel',
  PROXY_STATUS: 'tunnel',
  AUTH_CHANGED: 'tunnel',
  LIST_PROVIDER_CONNECTORS: 'tunnel',
  // opens https URL in system browser (mcp-servers.ts:1879)
  OPEN_PROVIDER_CONNECTOR_SETTINGS: 'local',
  LIST_CURATED: 'tunnel',
  REFRESH_CURATED: 'tunnel',
  RESOLVE_REMOTE_IMAGE: 'tunnel',
  LIST_STATUS: 'tunnel',
  GET_TOOLS: 'tunnel',
};

export const SKILLS_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof SKILLS_CHANNELS
> = {
  MARKETPLACE_LIST: 'tunnel',
  LOAD: 'tunnel',
  FETCH_AVAILABLE: 'tunnel',
  INSTALL: 'tunnel',
  REMOVE: 'tunnel',
  UPDATE: 'tunnel',
  CHECK_UPDATES: 'tunnel',
  UPDATE_PROGRESS: 'tunnel',
  CHANGED: 'tunnel',
  READ_CONTENT: 'tunnel',
  LIST_FILES: 'tunnel',
  READ_FILE: 'tunnel',
  SAVE_CUSTOM: 'tunnel',
  READ_RAW: 'tunnel',
  WRITE_RAW: 'tunnel',
  SHARED_LIST: 'tunnel',
  SHARED_GET: 'tunnel',
  SHARED_CREATE: 'tunnel',
  SHARED_UPDATE: 'tunnel',
  SHARED_DELETE: 'tunnel',
  SHARED_PUBLISH_PUBLIC: 'tunnel',
  SHARED_REVOKE_PUBLIC: 'tunnel',
  PACKAGE_ANALYZE: 'tunnel',
  PACKAGE_CANCEL_ANALYSIS: 'tunnel',
  PACKAGE_COMMIT: 'tunnel',
  PACKAGE_INSTALL: 'tunnel',
  RECORD_SHARE_ORIGIN: 'tunnel',
  DEPENDENCY_READINESS: 'tunnel',
};

export const PLUGINS_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof PLUGINS_CHANNELS
> = {
  LOAD: 'tunnel',
  LOAD_CACHE_ONLY: 'tunnel',
  RESOLVE_PORTABLE_REFS: 'tunnel',
  RESOLVE_PORTABLE_ENABLE_REF: 'tunnel',
  REFRESH: 'tunnel',
  ADD: 'tunnel',
  UPDATE: 'tunnel',
  REMOVE: 'tunnel',
  OPERATION_PROGRESS: 'tunnel',
  READ_COMPONENT: 'tunnel',
  INSTALL_PLUGIN: 'tunnel',
  INSTALL_BUILT_IN_PLUGIN: 'tunnel',
  PREPARE_CODEX_COMPATIBILITY: 'tunnel',
  SET_CODEX_COMPAT_DISABLED: 'tunnel',
  SHARED_LIST: 'tunnel',
  SHARED_GET: 'tunnel',
  SHARED_CREATE: 'tunnel',
  SHARED_UPDATE: 'tunnel',
  SHARED_DELETE: 'tunnel',
  SHARED_PUBLIC_PUBLISH: 'tunnel',
  SHARED_PUBLIC_REVOKE: 'tunnel',
  SHARED_REFERENCE_ANALYZE: 'tunnel',
};

export const COLLECTIONS_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof COLLECTIONS_CHANNELS
> = {
  LOAD_INDEX: 'tunnel',
  LOAD_COLLECTION: 'tunnel',
  SAVE_COLLECTION: 'tunnel',
  DUPLICATE_COLLECTION: 'tunnel',
  APPLY_SHARED_UPDATE: 'tunnel',
  DELETE_COLLECTION: 'tunnel',
  SHARED_LIST: 'tunnel',
  SHARED_GET: 'tunnel',
  SHARED_CREATE: 'tunnel',
  SHARED_UPDATE: 'tunnel',
  SHARED_DELETE: 'tunnel',
  SHARED_PUBLIC_PUBLISH: 'tunnel',
  SHARED_PUBLIC_REVOKE: 'tunnel',
  PACKAGE_ANALYZE: 'tunnel',
  PACKAGE_CANCEL_ANALYSIS: 'tunnel',
  PACKAGE_COMMIT: 'tunnel',
  IMPORT_READINESS: 'tunnel',
  PACKAGE_INSTALL: 'tunnel',
};

export const INVOCABLE_INVENTORY_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof INVOCABLE_INVENTORY_CHANNELS
> = {
  LOAD: 'tunnel',
  REFRESH: 'tunnel',
  RESOLVE: 'tunnel',
  CHANGED: 'tunnel',
};

export const INSTALLED_ITEM_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof INSTALLED_ITEM_CHANNELS
> = {
  LIST_STATUS: 'tunnel',
  SET_STATUS: 'tunnel',
  UNINSTALL: 'tunnel',
  CHANGED: 'tunnel',
};

export const BUNDLES_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof BUNDLES_CHANNELS
> = {
  LOAD_INDEX: 'tunnel',
  LOAD_BUNDLE: 'tunnel',
  SAVE_BUNDLE: 'tunnel',
  DELETE_BUNDLE: 'tunnel',
};

export const SKILL_SHARE_NUDGE_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof SKILL_SHARE_NUDGE_CHANNELS
> = {
  getPending: 'tunnel',
  resolve: 'tunnel',
  changed: 'tunnel',
};

// Repeat-task skill suggestions (CAN-385) are desktop-only for now: the
// banner and modal are not mounted on Remote Control, and blocking keeps
// prompt excerpts off the tunnel.
export const SKILL_SUGGESTION_REMOTE_DISPOSITIONS: RemoteDispositions<
  typeof SKILL_SUGGESTION_CHANNELS
> = {
  getPending: 'blocked',
  list: 'blocked',
  resolve: 'blocked',
  changed: 'blocked',
};

function addCatalog<Catalog extends Record<string, string>>(
  target: Map<string, RemoteChannelDisposition>,
  catalog: Catalog,
  dispositions: RemoteDispositions<Catalog>,
): void {
  for (const key of Object.keys(catalog)) {
    const channel = catalog[key];
    const disposition = dispositions[key];
    if (channel === undefined || disposition === undefined) continue;
    target.set(channel, disposition);
  }
}

function buildChannelDispositions(): ReadonlyMap<
  string,
  RemoteChannelDisposition
> {
  const map = new Map<string, RemoteChannelDisposition>();
  addCatalog(map, IPC_CHANNELS, IPC_REMOTE_DISPOSITIONS);
  addCatalog(map, PIPELINE_CHANNELS, PIPELINE_REMOTE_DISPOSITIONS);
  addCatalog(map, MCP_SERVER_CHANNELS, MCP_SERVER_REMOTE_DISPOSITIONS);
  addCatalog(map, SKILLS_CHANNELS, SKILLS_REMOTE_DISPOSITIONS);
  addCatalog(map, PLUGINS_CHANNELS, PLUGINS_REMOTE_DISPOSITIONS);
  addCatalog(map, COLLECTIONS_CHANNELS, COLLECTIONS_REMOTE_DISPOSITIONS);
  addCatalog(
    map,
    INVOCABLE_INVENTORY_CHANNELS,
    INVOCABLE_INVENTORY_REMOTE_DISPOSITIONS,
  );
  addCatalog(map, BUNDLES_CHANNELS, BUNDLES_REMOTE_DISPOSITIONS);
  addCatalog(map, INSTALLED_ITEM_CHANNELS, INSTALLED_ITEM_REMOTE_DISPOSITIONS);
  addCatalog(
    map,
    SKILL_SHARE_NUDGE_CHANNELS,
    SKILL_SHARE_NUDGE_REMOTE_DISPOSITIONS,
  );
  addCatalog(
    map,
    SKILL_SUGGESTION_CHANNELS,
    SKILL_SUGGESTION_REMOTE_DISPOSITIONS,
  );
  return map;
}

let channelDispositions: ReadonlyMap<string, RemoteChannelDisposition> | null =
  null;

/** Every classified channel and its disposition. */
export function getRemoteChannelDispositions(): ReadonlyMap<
  string,
  RemoteChannelDisposition
> {
  channelDispositions ??= buildChannelDispositions();
  return channelDispositions;
}

/** Disposition for a channel; unclassified channels are blocked. */
export function getRemoteChannelDisposition(
  channel: string,
): RemoteChannelDisposition {
  return getRemoteChannelDispositions().get(channel) ?? 'blocked';
}
