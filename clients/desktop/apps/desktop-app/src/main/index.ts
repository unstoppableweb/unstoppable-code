import './lifecycle/build-storage-startup';
import { prepareCanopySecureStorage } from '@canopy/desktop-shared/node/build-storage-startup';
import { startWorkEntryAutoDeleteScheduler } from './lib/work-entry-auto-delete';
import { replayHookChatPlaceholders } from './lib/hook-chat-placeholders';
import { BRAND } from '@canopy/brand/current';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { TurnBinding } from '@canopy/protocol/canopy-core';
import type { TurnLifecycleProvider } from './agents/provider-turn-lifecycle';
import {
  deliverWatcherMessageToChat,
  type WatcherChatDelivery,
  type WatcherChatDeliveryOutcome,
} from './services/watcher-chat-delivery';
import type {
  AppAdvisorBrowserAction,
  AppAdvisorWatcherDestination,
} from '@canopy/desktop-shared/types';
import { electronApp, is } from '@electron-toolkit/utils';
import {
  BrowserWindow,
  WebContentsView,
  app,
  crashReporter,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  screen,
  shell,
  systemPreferences,
  webContents,
  type WebContents,
} from 'electron';
import { existsSync } from 'fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'path';
import { advertiseWindowsDefaultBrowserCapabilities } from './browser/windows-default-browser-capabilities';
import { reportShareHandoffEvent } from './canopy-cloud/share-handoff-events';
import { drainChatStateBeforeRuntimeShutdown } from './canopy-runtime/chat-state-shutdown';
import { installCoreChatProjections } from './canopy-runtime/core-chat-projections';
import { allowsRendererClipboardWrite } from './lib/renderer-clipboard-permission';
import { deriveDesktopIpcCaller } from './canopy-runtime/desktop-ipc-caller';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from './canopy-runtime/desktop-runtime';
import { setDesktopCanopyRuntime } from './canopy-runtime/desktop-runtime-access';
import {
  disposeDesktopDaemonGitRoute,
  getDesktopDaemonGitRoute,
} from './canopy-runtime/electron-daemon-git-access';
import {
  disposeElectronDaemonFiles,
  getDesktopDaemonFilesRoute,
} from './canopy-runtime/electron-daemon-files-access';
import { resolveTrustedRelaySurface } from './canopy-runtime/renderer-relay/trusted-surface';
import { bindLedgerToolsDispatcher } from './canopy-tools/ledger-tools-runtime';
import {
  handleProtocolArgv,
  handleProtocolUrl,
  notifyDeepLinkStartupUnlocked,
  setBillingReturnSender,
  setDeepLinkSender,
  setWebLinkSender,
} from './deep-link/deep-link-service';
import {
  flushPendingOrgProjectDeepLink,
  handleOrgProjectDeepLink,
  setOrgProjectDeepLinkSender,
} from './deep-link/org-project-deep-link-host';
import { registerAllIpcHandlers } from './ipc';
import { setApprovalOwnerResolver } from './ipc/approvals';
import { RENDERER_RELAY_GRANTS } from './ipc/canopy-core-relay';
import {
  addLedgerEntryForE2e,
  handBackLedgerEntryForE2e,
  pausePipelineAgentForE2e,
  resumePipelineExecutionForE2e,
  updateLedgerEntryForE2e,
} from './ledger/e2e-ledger-seeder';
import { pinIsolateSandboxedIframes } from './lib/chromium-feature-switches';
import { bindConfiguredPromptFilesystemDispatcher } from './lib/configured-prompt-resolution';
import {
  armE2eClaudeQueryPrelude,
  readE2eClaudeQueryPreludeState,
  resetE2eClaudeQueryPreludes,
} from './lib/e2e-claude-query-prelude';
import {
  captureBrowserBoundary,
  observeBrowserCreate,
  observeLoadedTaskReset,
  observeProfileOperations,
} from './lib/e2e-profile-operation-diagnostics';
import { markE2eStartup } from './lib/e2e-startup-marks';
import {
  attachEditableContextMenu,
  attachEditableContextMenuToContents,
} from './lib/editable-context-menu';
import {
  attachLinkContextMenu,
  attachLinkContextMenuToContents,
  isLinkBrowserTargetAvailable,
  setLinkBrowserTargetAvailable,
  shouldOfferOpenInBrowser,
  type LinkContextMenuDeps,
} from './lib/link-context-menu';
import {
  drainMainProcessLogging,
  drainMainProcessLoggingBestEffort,
  initializeMainProcessLogging,
  logMainProcessError,
  logMainProcessInfo,
  logMainProcessWarn,
} from './lib/main-process-logging';
import { getOrgProjectMaterialization } from './lib/org-project-materialization';
import {
  isRemoteControlEnabled,
  onRemoteControlEnabledChanged,
  setRemoteControlEnabled,
} from './lib/remote-control-preference';
import {
  CHILD_TOOL_LIVENESS_STAMP,
  readChildToolLivenessStamp,
} from '@canopy/agent-transcript';
import {
  APP_ADVISOR_RENDERER_PAGE,
  APP_ADVISOR_RENDERER_SEARCH,
  MAIN_WINDOW_RENDERER_PAGE,
  appAdvisorDevServerUrl,
} from './lib/renderer-pages';
import { configureLinuxSecureStorage } from './lib/secure-storage-policy';
import { configureLinuxDesktopIdentity } from './lib/linux-desktop-identity';
import { isAllowedMainWindowFrameNavigation } from './lib/subframe-navigation-guard';
import {
  getUiAutomationWindowWebPreferences,
  shouldShowUiAutomationWindow,
} from './lib/ui-automation-window';
import {
  attachInputGuardsToContents,
  attachWindowInputGuards,
  installApplicationMenu,
} from './menu';
import { notifyCampaignClickStartupUnlocked } from './notifications/campaigns/click-router';
import { recordActivity } from './notifications/campaigns/journey-state';
import {
  initializeActivationJourney,
  shutdownActivationJourney,
} from './notifications/campaigns/wiring';
import { broadcastPipelineExecutionEvent } from './pipelines/pipeline-execution-event-broadcaster';
import { pauseAllActivePipelineExecutions } from './pipelines/pipeline-execution-registry';
import { checkpointPipelinesThroughLocalWorker } from './pipelines/pipeline-worker-dispatch';
import {
  getRemoteControlRuntime,
  initializeRemoteControl,
} from './remote-control/electron-remote-control';
import { resolveRemoteBridgeSender } from './remote-control/host/bridge-window';
import {
  createElectronOriginStorageBridge,
  registerElectronRendererSchemeHandler,
  registerRendererSchemePrivileges,
} from './renderer-origin/electron-renderer-origin';
import { setRendererCodeCacheSchemeStatusSource } from './renderer-origin/renderer-code-cache-scheme-status';
import {
  createRendererOriginController,
  type RendererOriginDiagnostic,
} from './renderer-origin/renderer-origin-controller';
import {
  RENDERER_ORIGIN_RECORD_FILE,
  createFileRendererOriginRecordStore,
  type RendererOriginRecordStore,
} from './renderer-origin/renderer-origin-migration';
import { shutdownCloneJobs } from './services/clone-jobs-host';
import { getForeignActivityCarryoverService } from './services/foreign-activity-carryover-service';
import {
  disposeLabsExperimentsService,
  getLabsExperimentsService,
  initializeLabsExperimentsService,
} from './services/labs-experiments-runtime';
import { startPersonalOrganizationUpgradeRecovery } from './services/personal-organization-upgrade-host';
import {
  flushResumeQueue,
  startResumeQueue,
  stopResumeQueue,
} from './services/resume-queue-host';
import {
  initializeSidebarItemGroups,
  sidebarItemGroupsService,
} from './services/sidebar-item-groups-service';
// Imported directly (not via the ./ipc barrel) so the module cycle
// index → ipc barrel → snapshot handler cannot leave this binding
// undefined when the before-quit cleanup path runs.
import {
  createForeignCrashDumpFilter,
  flushDesktopInstrumentation,
  initializePostHogMain,
  suspendPostHogMain,
} from '@canopy/desktop-instrumentation/electron/main';
import { getPostHogEmailDomain } from '@canopy/desktop-instrumentation/posthog-account';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  appAdvisorWindowButtonPosition,
  macWindowButtonPosition,
} from '@canopy/desktop-shared/lib/titlebar-geometry';
import { chatStorageCommitTotal } from '@canopy/desktop-shared/node/chat-storage-activity';
import { getCodeGraphWorktreeService } from '@canopy/desktop-shared/node/code-graph/service';
import { installDesktopCodeGraphResources } from '@canopy/desktop-shared/node/code-graph/resources';
import { installWorkCountersQuery } from '@canopy/desktop-shared/node/work-counters';
import {
  prewarmLoginShellPath,
  setLoginShellProbe,
} from '@canopy/execution-engine/pipelines/config-paths';
import { createPortLoginShellProbe } from '@canopy/desktop-shared/node/execution-host/login-shell-probe';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import {
  APP_ADVISOR_FLOATING_DEFAULT_SIZE,
  APP_ADVISOR_PROJECT_ID,
  APP_ADVISOR_WORKTREE_ID,
  APPROVAL_MODES,
  CLIENT_FEATURE_FLAGS,
  IPC_CHANNELS,
  appAdvisorInitialLayoutArgument,
  clampAppAdvisorFloatingSize,
  type AppAdvisorDockResult,
  type AppAdvisorFloatingSize,
  type AppAdvisorWindowCommand,
  type AppAdvisorWindowLayout,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowState,
  type AutoArchiveNotification,
  type ChatWindowCommand,
  type PersistedPendingQuestion,
  type PreferencesData,
  type WindowBounds,
} from '@canopy/desktop-shared/types';
import {
  isPanelAuxWindowFrameName,
  ORCHESTRATOR_LABEL,
} from '@canopy/protocol';
import { shutdownLocalAccountProxyAtQuit } from './account-proxy/local-shutdown';
import {
  clearAiCreditsRoutingContextCache,
  clearAiCreditsRoutingModeCache,
  prewarmAiCreditsAvailability,
  prewarmAiCreditsRoutingMode,
} from './agents/ai-credits-routing';
import { shutdownClaudeProcessHost } from './agents/claude-process-host-runner';
import { shutdownProviderProcessHost } from './agent-runs/provider-process-host';
import {
  enableClaudeProcessPidPersistence,
  reapStaleClaudeProcesses,
} from './agents/claude-process-registry';
import { recordReapedClaudeProcessDiagnostic } from './agents/claude-process-diagnostics';
import {
  getCodexGatewayProxyService,
  setCodexGatewayProxyDiagnosticSink,
} from './agents/codex-gateway-proxy-service';
import { shutdownDelegationLifecycle } from './agents/delegation/lifecycle';
import { startNativeAccountChangeTracking } from './agents/native-account-change';
import { getRoutedSessionPressureSnapshot } from './agents/session-event-router';
import {
  applyE2eIngestedLiveBackgroundTaskEvent,
  destroyAllSessions,
  getChatTurnConcurrencySnapshot,
  getChildToolLiveness,
  hasActiveChatTurnsForProject,
  updateClaudeSessionIdleTimeoutMinutes,
} from './agents/session-manager';
import { startChildToolsSettlement } from './agents/child-tools-settlement';
import {
  createAiGatewayModelCatalogService,
  type AiGatewayModelCatalogService,
} from './ai-gateway-models/service';
import {
  setAiGatewayCatalogRetryHandler,
  setAiGatewayCatalogStatus,
} from './ai-gateway-models/status';
import { AppAdvisorViewHost } from './app-advisor/advisor-host';
import {
  appAdvisorCloseLeavesBubble,
  appAdvisorLayoutAfterFloatingShow,
  appAdvisorPaintProbe,
  appAdvisorRequestedLayout,
  floatingAppAdvisorBounds,
  resolveAppAdvisorWindowLayout,
  shouldRemakeAppAdvisorWindow,
} from './app-advisor/floating-layout';
import { getAppAdvisorWatcherService } from './app-advisor/watchers';
import { getLatestAppAdvisorWindowUiState } from './app-advisor/window-ui-state';
import { shutdownArchiveIoRunner } from './archive/archive-io-runner';
import { shutdownSignInRuns } from './sign-in-runs/sign-in-runs';
import {
  prewarmProviderNativeAuthStatus,
  shouldPrewarmCodexNativeAuthAtStartup,
  subscribeConfirmedProviderAuth,
} from './auth/provider-auth-state';
import { migrateAutomationRunArchive } from './automations/run-archive-migration';
import { startChatAutomationMigration } from './automations/chat-automation-migration';
import { getAutomationsService } from './automations/service';
import {
  openLinkInBuiltInBrowser,
  routeAppLink,
  routeSafeNavigation,
} from './browser/app-link-router';
import { getBrowserProfileService } from './browser/browser-profile-service';
import { getBrowserService } from './browser/browser-service';
import {
  getDefaultBrowserRegistrationService,
  initializeDefaultBrowserRegistrationService,
} from './browser/default-browser-registration';
import { getCanopyCloudBaseUrl } from './canopy-cloud/config';
import { subscribeSharedItemSubscriptionFlush } from './canopy-cloud/shared-item-subscriptions';
import {
  closeChatSearchService,
  getChatSearchService,
} from './chat-search/service';
import { installTurnStateAudit } from './observability/turn-state-audit';
import { installTurnStateInvariantGuard } from './observability/turn-state-invariant-guard';
import {
  getCodeGraphGenerationQueueSnapshot,
  killAllBuilds,
} from './code-graph/build-runner';
import { shutdownCodeGraphFingerprintWorkers } from './code-graph/fingerprint-runner';
import { shutdownCodeGraphReadWorkers } from './code-graph/read-runner';
import {
  enableCodexAppServerPidPersistence,
  reapStaleCodexAppServerProcesses,
  terminateAllCodexAppServerProcesses,
} from './codex/app-server-process-registry';
import { collectDesktopCodexCapabilityGarbage } from './codex/capability-store';
import { cleanupGatewayCompatibleCodexCatalog } from './codex/gateway-model-catalog';
import {
  getCodexRuntimeService,
  shutdownCodexRuntimeService,
} from './codex/runtime-service';
import {
  registerCostRetentionGuard,
  scheduleCostIndexStartup,
} from './cost-index/bootstrap';
import { subscribeConfirmedCursorAccount } from './cursor/connection';
import {
  disposeFeatureFlagService,
  getFeatureFlagService,
  initializeFeatureFlagService,
  installFeatureFlagRecoveryTriggers,
} from './feature-flags';
import { getLastBuiltFeatureFlagIdentity } from './feature-flags/context';
import { subscribeTurnFeedbackFlush } from './feedback/turn-feedback-client';
import { getClaudeTerminalSessionService } from './integration/claude-terminal-session-service';
import { getClaudeWorkerSessionService } from './integration/claude-worker-session-service';
import { redeliverPendingAppAdvisorAskUserRequests } from './ipc/app-advisor';
import {
  nudgeCoworkWorkEntrySidebar,
  projectChatTabsMaterialization,
} from './ipc/chat-persistence';
import { shutdownCopilotConnections } from './ipc/copilot-connection';
import { shutdownCursorApprovalChecks } from './ipc/cursor-approval-check';
import { shutdownCursorConnections } from './ipc/cursor-connection';
import { disposeDesktopSessionSnapshotHandlers } from './ipc/desktop-session-snapshot';
import { releaseIdleSplitLocksForRendererLifecycle } from './ipc/github';
import { setModelHarnessAssignmentController } from './ipc/model-harness-assignments';
import { installClaudeModAdmissionHost } from './agents/claude-mod-admission-launch';
import { shutdownOpenCodeConnections } from './ipc/opencode-connection';
import {
  reprobeAndApplyCanopyCloudEnforcedSettings,
  stopSettingsWriteRefreshRetries,
} from './ipc/settings';
import { cancelAllDiscoveries } from './ipc/worktree-discovery';
import { whenLedgerLifecycleIdle } from './ledger/lifecycle';
import {
  enqueueDesktopPendingTitle,
  shutdownDesktopPendingTitleOrchestrator,
  startDesktopPendingTitleOrchestrator,
} from './ledger/pending-titles';
import { setLedgerPendingTitleScheduler } from './ledger/service';
import {
  ledgerStorageWorkersStarted,
  shutdownLedgerStorageHost,
} from './ledger/storage-host';
import {
  setLedgerSyncEnabled,
  setLedgerSyncProhibitionHandler,
  stopLedgerSync,
} from './ledger/sync-host';
import { startMemorySync, stopMemorySync } from './memory/sync/host';
import { refreshAgentModelsFromStore } from './lib/agent-models';
import {
  getPostHogInstallLaunch,
  getStablePostHogAnonymousKey,
} from './lib/anonymous-id';
import { migrateAppAdvisorChatsToWorkEntries } from './lib/app-advisor-work-entry-migration';
import {
  initializeAppAdvisorWorkspace,
  loadAppAdvisorWorkspaceSettings,
  readAppAdvisorClaudeMd,
  saveAppAdvisorClaudeMd,
  saveAppAdvisorWorkspaceSettings,
} from './lib/app-advisor-workspace';
import {
  getCanopyReleaseFlavor,
  getRuntimeAppName,
  getRuntimeAppUserModelId,
} from './lib/app-identity';
import { migrateAppManagedChatWorkspaces } from './lib/app-managed-workspaces';
import { startArchivedContainerRetentionScheduler } from './lib/archived-container-retention';
import {
  readArchivedContainerManifest,
  withArchivedWorkspaceOperationLock,
} from './lib/archived-containers';
import {
  setAutoArchiveResultListener,
  startAutoArchiveScheduler,
  touchActiveAutoArchiveTargets,
} from './lib/auto-archive';
import { shutdownBackgroundHelperQueue } from './lib/background-helper-queue';
import { stopAllOutputPolling } from './lib/bg-output-poller';
import { scheduleMissingBundledBinaryReport } from './lib/bundled-binary-report';
import {
  loadCanopyCloudAccount,
  subscribeCanopyCloudAccountChanges,
  type CanopyCloudAccountEntry,
} from './lib/canopy-cloud-account-store';
import { readChatArchivesFile } from './lib/chat-archives';
import { syncWorktreeChatBadgesFromWrite } from './lib/chat-badge-sync';
import { startChatStorageActivityDiagnostics } from './lib/chat-storage-activity-diagnostics';
import {
  reconcileCodeGraphAvailability,
  setCodeGraphPreferences,
} from './lib/code-graph-availability';
import { shutdownCodeGraphBaseManager } from './lib/code-graph-base-manager';
import { migrateStandaloneChatToCowork } from './lib/cowork-migration';
import { loadCoworkMigrationMapCache } from './lib/cowork-migration-map';
import { setAppAdvisorProjectAgentAccess } from './lib/app-advisor-project-agent-access';
import {
  createWorkEntry,
  listWorkEntries,
  resolveWorkEntryForChat,
  syncWorkEntrySummaryFromWrite,
} from './lib/cowork-work-entries';
import { migrateCoworkChatsToWorkEntries } from './lib/cowork-work-entry-migration';
import { migrateDefaultCoworkWorkspaceName } from './lib/default-cowork-workspace-name-migration';
import { startProviderAccountConnectTelemetry } from './lib/desktop-telemetry';
import { getGitHubBroker } from './lib/github-broker';
import { holdHooksForShutdown } from './lib/hook-runner';
import {
  recoverInterruptedWorkAtStartup,
  sweepInterruptedPipelinesAtStartup,
} from './lib/interrupted-work-recovery';
import { sweepOrphanedMacosWorktreeDirectories } from './lib/macos-worktree-directory-cleanup';
import { startMainEventLoopMonitor } from './lib/main-event-loop-monitor';
import { buildMainEventLoopStallDiagnostic } from './lib/main-event-loop-stall-diagnostic';
import {
  focusMainWindow,
  focusWindow,
  isAppFrontmost,
  setMainWindowResolver,
} from './lib/main-window-focus';
import {
  loadModelsFromPackageJson,
  refreshModelsForFeatureFlags,
  updateAiGatewayModelCatalog,
} from './lib/model-config';
import {
  consumeExternalOpenLoopGuard,
  openExternalGuarded,
} from './lib/open-external';
import { installOrgDefaultCoworkProvisioning } from './lib/org-cowork-binding-deps';
import { updatePerformanceLimitsFromPreferences } from './lib/performance-limits';
import { installPostHogOperationCaptureGate } from './lib/posthog-operation-capture-gate';
import { getUsageDataPolicy } from './lib/usage-data-policy';
import {
  attachUsageDataPolicyToWorkspaceContext,
  initializeStartupUsageDataPolicy,
  installPostHogMainLifecycle,
  installUsageDataPolicyFeatureFlagRefresh,
} from './lib/usage-data-policy-host';
import {
  capturePreferenceMigrationSnapshots,
  migrateApprovalDefaultsToFullAccess,
  migrateChatSummaryModelSelection,
  migrateClaudeWorkerModesToCanopy,
  migrateLocalMemoryDefaultOn,
  migrateLocalMemoryModelFromSummary,
  migrateSidebarManualSortDefault,
  migrateOpenAppLinksInBuiltInBrowserDefault,
  migrateSidebarMorePagesToMain,
  migrateSidebarRemoteControlVisible,
} from './lib/preferences-migrations';
import {
  flushPreferencesWrites,
  readPreferencesFile,
  startPreferencesGenerationStamp,
  stopPreferencesGenerationStamp,
  updatePreferencesFile,
  writePreferencesFile,
} from './lib/preferences-store';
import { recordRealisticStartupPerformanceEvent } from './lib/realistic-startup-performance';
import {
  hostRendererInView,
  rendererContentsOf,
  type RendererSurfaceWindow,
} from './lib/renderer-surface';
import { stopAllRunningShellScripts } from './lib/script-runner';
import {
  discardAllStagedSessionImports,
  discardStaleSessionImportArtifacts,
} from './lib/session-transfer';
import {
  initializeSharedPlanStartup,
  stopAllPlanRealtimeSubscriptions,
} from './lib/shared-plan-sync';
import { setSharedRunCommentsCorruptionReporter } from './lib/shared-run-comments-registry';
import {
  beginSplitTemporaryWorkspaceShutdown,
  drainSplitTemporaryWorkspaceBackgroundPhases,
} from './lib/split-temporary-workspace';
import {
  applyUiZoomToWindow,
  registerUiZoomContents,
  registerUiZoomMinimumSize,
  registerUiZoomWindowButtons,
  scaledMinimumSize,
  uiScaleToZoomFactor,
  uiZoomWebPreferences,
} from './lib/ui-zoom';
import { validateId } from './lib/validation';
import { runRequestedW5Recovery } from './lib/w5-recovery-startup';
import { admitDesktopW5Host } from './lib/w5-host-admission';
import {
  cancelPendingW5FlipHandoff,
  disposeW5FlipHandoff,
  startW5FlipHandoff,
} from './canopy-runtime/w5-flip-handoff';
import {
  ipcWindowLabel,
  registerIpcSurface,
  sendToWebContents,
} from './lib/web-contents-send';
import { primaryWindowFocus } from './lib/window-focus-recency';
import {
  getMainWindowMaterialOptions,
  getMainWindowStartupBackgroundColor,
  getNativeThemeSource,
} from './lib/window-material';
import { sendToAllWindows, sendToWindowDetailed } from './lib/window-send';
import { subscribeCanopyCloudSessionStatus } from './canopy-cloud/session-status';
import { validateWindowBounds } from './lib/window-state';
import { getWindowTitleBarOptions } from './lib/window-title-bar';
import {
  flushWorkspaceTargetTouches,
  touchWorkspaceTarget,
  touchWorkspaceTargetAfterCommit,
} from './lib/workspace-activity';
import { stopWorkspaceApprovalsManifestWatchers } from './lib/workspace-approvals-manifest';
import { getWorkspaceContextService } from './lib/workspace-context-service';
import { isWorkspaceTargetRuntimeStartReserved } from './lib/workspace-target-exclusion';
import {
  startWorktreeBranchEnrollment,
  startWorktreeBranchObserver,
  stopWorktreeBranchWatchers,
} from './lib/worktree-branch-watcher';
import { stopWorktreesFileWatchers } from './lib/worktrees-file-watcher';
import {
  resolveAppActivationTarget,
  resolveTrayOpenTarget,
  type AppActivationTarget,
  type AppActivationWindows,
} from './lifecycle/app-activation';
import {
  destroyBackgroundTray,
  discloseCloseToTray,
  isActivationJourneyEnabled,
  isCloseToTrayEnabled,
  setActivationJourneyFlagEnabled,
  setCloseToTrayPreference,
  setTrayOptions,
  shouldDiscloseCloseToTray,
  shouldQuitOnAllWindowsClosed,
  syncActivationTray,
} from './lifecycle/background-presence';
import {
  disposeGlobalFocusShortcutService,
  getGlobalFocusShortcutService,
  initializeGlobalFocusShortcutService,
} from './lifecycle/global-focus-shortcut';
import { initializeLaunchAtLoginService } from './lifecycle/launch-at-login';
import { stopLinuxCrashpadHandlers } from './lifecycle/linux-crashpad-cleanup';
import { createMainWindowRecreation } from './lifecycle/main-window-recreation';
import {
  DrainedProcessExitGuard,
  RuntimeCleanupStages,
  settleBestEffortCleanup,
  type RuntimeCleanupDiagnostic,
} from './lifecycle/runtime-cleanup';
import { createUnsavedCloseGuard } from './lifecycle/unsaved-close-guard';
import { getMcpHttpProxyService } from './mcp/http-proxy-service';
import { startCuratedMcpRefresh } from './mcp/refresh-scheduler';
import {
  startLocalMemoryConsolidationScheduler,
  stopLocalMemoryConsolidationScheduler,
} from './memory/local/consolidation-scheduler';
import { flushPendingUsage as flushPendingLocalMemoryUsage } from './memory/local/usage';
import {
  broadcastModelRegistryUpdated,
  initializeModelHarnessRegistry,
  modelHarnessAssignmentController,
  refreshModelHarnessAssignments,
} from './models/model-registry';
import { requestActivationRecompute } from './notifications/campaigns/scheduler';
import {
  getObservabilityService,
  initializeObservabilityService,
} from './observability';
import { createCrashDumpClassificationRecorder } from './observability/crash-dump-filter-diagnostics';
import { sweepCrashDumps } from './observability/crash-dump-sweep';
import { getExecutionObservabilityIngest } from './observability/ingest';
import {
  formatUnknownError,
  recordMainProcessError,
} from './observability/main-process-errors';
import { getOllamaService } from './ollama';
import {
  decidePanelAuxWindowOpen,
  hardenPanelAuxWindow,
} from './panels/aux-window-service';
import {
  decideOverlayLayerWindowOpen,
  OverlayLayerHost,
} from './overlay-layer/overlay-layer-host';
import { panelLayoutPersistenceStore } from './panels/persistence';
import {
  registerExecutionHandlers,
  registerPipelineHandlers,
} from './pipelines';
import { getPipelineAdvisorService } from './pipelines/pipeline-advisor';
import { shutdownPipelineProcessHost } from './pipelines/process-host-runner';
import { getExecutionHostPort } from './execution-host/utility-process-host';
import { registerPluginHandlers } from './plugins';
import { shutdownCodexPluginMaterializationWorker } from './plugins/codex-plugin-materialization-runner';
import { startProviderPluginBackfill } from './plugins/provider-plugin-backfill';
import {
  getCanopyPortalState,
  resumeCanopyPortalIfPossible,
  setCanopyPortalPowerMonitor,
  startCanopyPortal,
  stopCanopyPortal,
} from './portal/portal-session-manager';
import { cancelPortalStructuralSync } from './portal/portal-structural-sync';
import { getWakeLockService } from './power/wake-lock-service';
import { installExecutionAccountingHost } from './execution-accounting';
import {
  configureMemoryDiagnostics,
  getMemoryDiagnosticsService,
  type MemoryDiagnosticsRendererTarget,
} from './memory-diagnostics';
import {
  disposeResourceMonitorService,
  initializeResourceMonitorService,
} from './resource-monitor';
import { getAttentionTracker } from './services/attention-tracker';
import { getBackgroundExecutionContextRebinder } from './services/background-execution-rebinding';
import { getChatStateService } from './services/chat-state-service';
import { getDesktopInventorySyncService } from './services/desktop-inventory-sync-service';
import { startOnboardingProfileSync } from './services/onboarding-profile-sync-service';
import {
  startOrgEnforcedSettingsSync,
  stopOrgEnforcedSettingsSync,
} from './services/org-enforced-settings';
import { startOrgProjectAutoConversion } from './services/org-project-auto-conversion-host';
import { getOrgProjectCatalogService } from './services/org-project-catalog-service';
import { installOrgProjectSnapshotInvalidation } from './services/org-project-snapshot-invalidation';
import { installOrgProjectsCapabilityRefresh } from './services/org-projects-capability-refresh';
import {
  startPersonalCatalogSync,
  stopPersonalCatalogSync,
} from './services/personal-catalog-sync-host';
import {
  startCloudProjectBinding,
  stopCloudProjectBinding,
} from './cloud-projects/cloud-project-binding-host';
import {
  startCloudProjectSetupSweep,
  stopCloudProjectSetupSweep,
} from './cloud-projects/project-setup-host';
import {
  disposeProductActivityReporter,
  initializeProductActivityReporter,
} from './services/product-activity-reporter';
import { getSharedContainerInboxWatcher } from './services/shared-container-inbox-watcher';
import { getSharedRunAutoUpdater } from './services/shared-run-auto-updater';
import { getSharedRunCommentPoller } from './services/shared-run-comment-poller';
import { applySyncServiceFeatureFlags } from './services/sync-service-feature-flags';
import {
  getTelemetrySyncService,
  initializeTelemetrySyncService,
} from './services/telemetry-sync-service';
import { handleChatTabsWritten } from './services/worktree-runtime-status-service';
import {
  initializeSuggestionsGate,
  stopSuggestionsGateHydration,
} from './lib/suggestions-preferences';
import {
  startSkillSuggestions,
  stopSkillSuggestions,
} from './skill-suggestions';
import { registerSkillHandlers } from './skills';
import {
  scheduleDeferredStartupBackgroundTasks,
  shutdownDeferredStartupStreamRepair,
} from './startup-background-tasks';
import { terminalPersistenceStore } from './terminal/persistence';
import { workerTerminal } from './terminal/worker-terminal';
import { startUpdater, stopUpdater } from './updater';
import { getVoiceService } from './voice/service';
import { shutdownW5CommitLogHost } from './w5-commit-log/commit-log-host';
import { recordDesktopInstanceEvent } from './lifecycle/desktop-instance-diagnostics';
import type { W5StoreArmHandle } from './e2e-fixtures/w5-daemon-record-store-arm';

const hasSingleInstanceLock = __CANOPY_E2E__ || app.requestSingleInstanceLock();
recordDesktopInstanceEvent({
  event: hasSingleInstanceLock ? 'owner-acquired' : 'contender-rejected',
});

if (hasSingleInstanceLock) {
  configureLinuxDesktopIdentity(app);
  initializeMainProcessLogging();
  installDesktopCodeGraphResources();

  installCoreChatProjections({
    search: () => getChatSearchService(),
    subscribeChildSearchDirty: (listener) =>
      getChatStateService().subscribeChildSearchDirty(listener),
    // A canonical chat command holds the target reservation until this durable
    // watermark completes, so Auto Delete cannot enter between the journal
    // commit and its activity update.
    touchTargetAfterCommit: (projectId, worktreeId) =>
      touchWorkspaceTargetAfterCommit(projectId, worktreeId),
    steps: {
      // Keep the worktree's persisted chat badge summary current so sidebar
      // badges render at startup without hydrating full transcripts.
      syncBadges: syncWorktreeChatBadgesFromWrite,
      syncWorkEntrySummary: syncWorkEntrySummaryFromWrite,
      logRetry: logMainProcessWarn,
      publishRuntimeStatus: handleChatTabsWritten,
      // Portal chat-summary/todo/MCP projections and the cowork sidebar nudge
      // follow every canonical materialization (throttled per scope) now that
      // the renderer-driven save choke point is gone.
      publishScope: (projectId, worktreeId, data, delta) =>
        projectChatTabsMaterialization(
          () => mainWindow,
          projectId,
          worktreeId,
          data,
          delta,
        ),
      nudgeSummary: (projectId) =>
        nudgeCoworkWorkEntrySidebar(() => mainWindow, projectId),
    },
  });

  // Observability's first initialization prunes audit days; install its reader first.
  registerCostRetentionGuard();
}

let mainWindow: BrowserWindow | null = null;
let mainWindowRendererReady = false;
/**
 * The main window's page crashed or a main-frame reload committed, and its
 * renderer has not come back up. App Advisor raises its own chat
 * notifications meanwhile. Sub-frame loads (an HTML file preview's iframe)
 * leave it, and `mainWindowRendererReady`, alone.
 */
let mainWindowPageDown = false;

/**
 * Link context menu actions for a page (CAN-2632). The window label is read
 * at right-click, after pull-outs registered theirs; "Open in browser" places
 * the tab through the main renderer, as left-click app links do.
 */
function linkContextMenuDeps(contents: WebContents): LinkContextMenuDeps {
  return {
    canOpenInBrowser: () =>
      shouldOfferOpenInBrowser({
        label: ipcWindowLabel(contents),
        isMainWindow: contents === mainWindow?.webContents,
        available: isLinkBrowserTargetAvailable(),
      }),
    openInBrowser: (url) =>
      openLinkInBuiltInBrowser({
        url,
        sender: mainWindowRendererReady
          ? (mainWindow?.webContents ?? null)
          : null,
      }),
    openExternal: openExternalGuarded,
  };
}
let pendingAutoArchiveNotifications: AutoArchiveNotification[] = [];
/**
 * The full App Advisor window. Without early access its own page is the App
 * Advisor renderer. Under early access the renderer is a view's page
 * (`appAdvisorViewContents`), which `appAdvisorHost` moves between this
 * window and a floating panel in the main window (see `advisor-host.ts`);
 * sends addressed to this window still reach the renderer
 * (`hostRendererInView`).
 */
let appAdvisorWindow: BrowserWindow | null = null;
/**
 * Read once, when the view is made: a view's `webContents` reads `undefined`
 * once its page is destroyed, which at quit happens before the window's
 * `closed`.
 */
let appAdvisorViewContents: WebContents | null = null;
let appAdvisorHost: AppAdvisorViewHost<WebContentsView, BrowserWindow> | null =
  null;
/** Transparent native surfaces, each owned by the renderer that opened it. */
const overlayLayerHost = new OverlayLayerHost({
  routeAppLink: (url): Promise<unknown> =>
    routeSafeNavigation({
      url,
      sender: mainWindowRendererReady
        ? (mainWindow?.webContents ?? null)
        : null,
      source: 'app-link',
    }),
  // Layers join lazily; an already-floating Advisor must still stay above.
  onLayerAttached: (window): void => {
    appAdvisorHost?.raise(window);
  },
});
/** The interface zoom the floating panel is sized for. */
let appAdvisorPanelZoom = 1;
/** The floating panel's size (CSS px at 100%), as the user last left it. */
let appAdvisorFloatingSize: AppAdvisorFloatingSize =
  APP_ADVISOR_FLOATING_DEFAULT_SIZE;
let windowStateSaveTimeout: ReturnType<typeof setTimeout> | null = null;
let appAdvisorWindowStateSaveTimeout: ReturnType<typeof setTimeout> | null =
  null;
let pendingAppAdvisorWindowCommands: AppAdvisorWindowCommand[] = [];
let appAdvisorWindowCreating: Promise<BrowserWindow> | null = null;
/** Early access: the floating panel is minimized to its bubble. */
let appAdvisorMinimized = false;
let appAdvisorWindowReady = false;
let rendererRecoveryReloadPending = false;
let appAdvisorRendererRecoveryReloadPending = false;
const DEFAULT_WINDOW_WIDTH = 1400;
const APP_ADVISOR_MIN_WIDTH = 360;
/** How long the floating panel waits for its page to paint before showing. */
const APP_ADVISOR_PAINT_WAIT_MS = 500;
// Matches the deferred startup tasks' delay.
const WORKTREE_BRANCH_ENROLLMENT_FALLBACK_MS = 5_000;
/**
 * Window minimums at 100% interface scale. The live minimum is
 * `base × zoom` (`lib/ui-zoom.ts`), so the renderer's CSS-px layout floors
 * still fit at every scale.
 */
const MAIN_WINDOW_MIN_SIZE = { width: 800, height: 500 };
const APP_ADVISOR_MIN_SIZE = { width: APP_ADVISOR_MIN_WIDTH, height: 420 };

/**
 * The work area of the display a window is about to open on: the one
 * matching its persisted bounds, or the primary display for a fresh window.
 */
function workAreaForBounds(
  bounds: Electron.Rectangle | null,
): Electron.Rectangle {
  return bounds
    ? screen.getDisplayMatching(bounds).workArea
    : screen.getPrimaryDisplay().workArea;
}
let appIsQuitting = false;
// Asks the main-window renderer before a close or quit drops unsaved workflow
// edits (CAN-4072). Inert until the renderer reports dirty state.
const unsavedCloseGuard = createUnsavedCloseGuard({
  revealWindow: (): void => {
    // The user just asked to close or quit, so bringing the window forward
    // is theirs to expect; a hidden window would hold an invisible prompt.
    focusMainWindow({ steal: true, moveTop: true });
  },
  sendRequest: (request): boolean => {
    const window = mainWindow;
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
      return false;
    }
    sendToWebContents(
      window.webContents,
      IPC_CHANNELS.appWindowConfirmClose,
      request,
    );
    return true;
  },
});
let runtimeCleanupPromise: Promise<void> | null = null;
let drainedProcessExitGuard: DrainedProcessExitGuard | null = null;
let desktopCanopyRuntime: DesktopCanopyDispatcher | null = null;
let closeChatStatePush: (() => void) | null = null;
let closeCanopyCloudSessionStatusPush: (() => void) | null = null;
/** E2E builds only: the daemon-backed W5 store arm a performance launch chose. */
let w5StoreArm: W5StoreArmHandle | null = null;
const DESKTOP_CANOPY_RUNTIME_SHUTDOWN_TIMEOUT_MS = 750;
/** How long quit waits for queued Ledger lifecycle steps before storage stops. */
const LEDGER_LIFECYCLE_DRAIN_TIMEOUT_MS = 2_000;
let signalExitStarted = false;
let cancelStartupBackgroundTasks: (() => void) | null = null;
let stopMainEventLoopMonitor: (() => void) | null = null;
let stopChatStorageActivityDiagnostics:
  | ((options?: { flush?: boolean }) => void)
  | null = null;
let uninstallFeatureFlagRecoveryTriggers: (() => void) | null = null;
let disposeTurnFeedbackFlush: (() => void) | null = null;
let disposeSharedItemSubscriptionFlush: (() => void) | null = null;
let stopArchivedContainerRetention: (() => void) | null = null;
let workEntryAutoDeleteScheduler: ReturnType<
  typeof startWorkEntryAutoDeleteScheduler
> | null = null;
let autoArchiveScheduler: ReturnType<typeof startAutoArchiveScheduler> | null =
  null;
let disposeCuratedMcpRefresh: (() => void) | null = null;
let disposeOnboardingProfileSync: (() => void) | null = null;
let childToolsSettlement: ReturnType<typeof startChildToolsSettlement> | null =
  null;
let disposeProviderPluginBackfill: (() => void) | null = null;
let disposeNativeAccountChangeTracking: (() => void) | null = null;
let disposeProviderAccountConnectTelemetry: (() => void) | null = null;
let aiGatewayModelCatalogService: AiGatewayModelCatalogService | null = null;
let startupUnlocked = false;
const recordCrashDumpClassification = createCrashDumpClassificationRecorder(
  (diagnostic): void =>
    getExecutionObservabilityIngest().recordAppDiagnostic(diagnostic),
);

const E2E_CHAT_EVENT_INGESTOR_KEY = '__CANOPY_E2E_INGEST_CHAT_EVENT__';
const E2E_PENDING_QUESTION_UPSERTER_KEY =
  '__CANOPY_E2E_UPSERT_PENDING_QUESTION__';
const E2E_CLAUDE_QUERY_PRELUDE_KEY = '__CANOPY_E2E_CLAUDE_QUERY_PRELUDE__';
const E2E_PROVIDER_EVENT_PRESSURE_CHANNEL =
  '__CANOPY_E2E_PROVIDER_EVENT_PRESSURE__';

interface E2eChatEventPayload {
  projectId: string;
  worktreeId: string;
  chatId: string;
  data: unknown;
  providerType?: 'claude' | 'codex' | 'ollama';
  turnUserMessageId?: string;
}

/**
 * Give deterministic Electron specs the same commit-before-broadcast ingress
 * as real providers. The build-time gate removes this seam from production.
 */
function installE2eChatEventIngestor(): void {
  if (!__CANOPY_E2E__) return;
  Object.defineProperty(globalThis, '__CANOPY_E2E_DELIVER_WATCHER_MESSAGE__', {
    configurable: true,
    value: (
      delivery: WatcherChatDelivery,
    ): Promise<WatcherChatDeliveryOutcome> =>
      deliverWatcherMessageToChat(delivery),
  });
  Object.defineProperty(globalThis, '__CANOPY_E2E_PREVIEW_VISUAL__', {
    configurable: true,
    value: async (input: {
      kind: 'preview' | 'measure' | 'count';
      html?: string;
      width?: number;
      widths?: number[];
      maxHeight?: number;
      appearance?: 'light' | 'dark';
      imageBudgetBytes?: number;
    }): Promise<unknown> => {
      const { getVisualPreviewService, getVisualPreviewWindowCount } =
        await import('./browser/visual-preview-service');
      if (input.kind === 'count')
        return { liveWindows: getVisualPreviewWindowCount() };
      const prepared = { html: input.html ?? '', unresolvedImagePaths: [] };
      if (input.kind === 'measure') {
        return getVisualPreviewService().measure({
          prepared,
          widths: input.widths ?? [360, 520, 720, 960],
          maxHeight: input.maxHeight ?? 2000,
          appearance: input.appearance,
          deadlineMs: 3000,
        });
      }
      const result = await getVisualPreviewService().preview({
        prepared,
        width: input.width ?? 720,
        appearance: input.appearance,
        imageBudgetBytes: input.imageBudgetBytes ?? 256 * 1024,
      });
      return { ...result, liveWindows: getVisualPreviewWindowCount() };
    },
  });
  // Scalar-only route diagnostics for held-sink Electron checks. The handler
  // is absent from release builds and never exposes provider event payloads.
  ipcMain.removeHandler(E2E_PROVIDER_EVENT_PRESSURE_CHANNEL);
  ipcMain.handle(
    E2E_PROVIDER_EVENT_PRESSURE_CHANNEL,
    (
      _event,
      target: unknown,
    ): ReturnType<typeof getRoutedSessionPressureSnapshot> => {
      if (
        !target ||
        typeof target !== 'object' ||
        !('projectId' in target) ||
        typeof target.projectId !== 'string' ||
        !('worktreeId' in target) ||
        typeof target.worktreeId !== 'string' ||
        !('chatId' in target) ||
        typeof target.chatId !== 'string'
      ) {
        throw new Error('Invalid provider event pressure scope');
      }
      return getRoutedSessionPressureSnapshot({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      });
    },
  );
  Object.defineProperty(globalThis, '__CANOPY_E2E_HOLD_CHAT_TURN__', {
    configurable: true,
    value: async (target: {
      projectId: string;
      worktreeId: string;
      chatId: string;
      turnUserMessageId: string;
    }): Promise<void> => {
      const { getChatQueueService } =
        await import('./services/chat-queue-service');
      const queue = getChatQueueService();
      // Model the host gate held by a dispatched turn, without a live provider.
      // Normal completion and Stop release it through the production queue.
      queue.invalidatePendingInputOperations(target);
      queue.confirmTurnRevived(target, target.turnUserMessageId);
    },
  });
  // Canonical root turns start and end only from lifecycle receipts (turn-state
  // phase 35c5d), which injected chat events lack. Publish a provider
  // session's receipts for an injected turn through the production producer.
  Object.defineProperty(globalThis, '__CANOPY_E2E_PUBLISH_TURN_LIFECYCLE__', {
    configurable: true,
    value: async (input: {
      projectId: string;
      worktreeId: string;
      chatId: string;
      turnUserMessageId: string;
      phase: 'start' | 'end';
      outcome?: 'completed' | 'failed';
      atMs?: number;
      providerType?: TurnLifecycleProvider;
    }): Promise<void> => {
      const [{ getTurnLifecycleProducer }, { setE2eInjectedTurnLive }] =
        await Promise.all([
          import('./agents/provider-turn-lifecycle'),
          import('./lib/e2e-injected-turns'),
        ]);
      // The injected turn stands in for a provider session's live host.
      setE2eInjectedTurnLive(input, input.phase === 'start');
      const producer = getTurnLifecycleProducer(
        input.providerType ?? 'claude',
        {
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          chatId: input.chatId,
        },
      );
      const binding = {
        turnId: `e2e-turn:${input.turnUserMessageId}`,
        origin: 'user',
        binding: 'bound',
        submissionIds: [],
        userMessageIds: [input.turnUserMessageId],
        providerUserMessageUuids: [],
      } satisfies TurnBinding;
      if (input.phase === 'start')
        producer.turnStarted({
          ...binding,
          phase: 'start',
          startedAtMs: input.atMs ?? Date.now(),
        });
      else
        producer.turnEnded({
          ...binding,
          endedAtMs: input.atMs ?? Date.now(),
          outcome: input.outcome ?? 'completed',
          source: 'result',
        });
    },
  });
  Object.defineProperty(globalThis, '__CANOPY_E2E_INGEST_PIPELINE_EVENT__', {
    configurable: true,
    value: broadcastPipelineExecutionEvent,
  });
  const { AsyncResource } = process.getBuiltinModule('async_hooks');
  // Exercise the real scoped and App Advisor main dispatch paths with captured
  // fixture identities; the build-time gate removes this seam from production.
  Object.defineProperty(globalThis, '__CANOPY_E2E_BROWSER_DOWNLOADS__', {
    configurable: true,
    value: () => getBrowserService()?.downloads.listActive() ?? [],
  });
  // Final-review fixtures retain the actual service/IPC path and are removed
  // from production by the enclosing build-time gate. Only one captured
  // profile may be armed; every wrapper restores itself within 30 seconds.
  let createDiagnostics: ReturnType<typeof observeBrowserCreate> | undefined;
  let createDiagnosticToken: string | undefined;
  let createDiagnosticScope:
    | { projectId: string; worktreeId: string }
    | undefined;
  let operationDiagnostics:
    | ReturnType<typeof observeProfileOperations>
    | undefined;
  Object.defineProperty(
    globalThis,
    '__CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__',
    {
      configurable: true,
      value: (input: {
        kind:
          | 'arm'
          | 'snapshot'
          | 'release'
          | 'arm-create'
          | 'browser-snapshot'
          | 'release-create';
        scope?: {
          projectId: string;
          worktreeId: string;
          browserId?: string;
          url?: string;
        };
        deadline?: number;
        observerToken?: string;
        profileId: string;
        storageGeneration: number;
        clear?: boolean;
      }) => {
        if (
          input.kind === 'arm-create' ||
          input.kind === 'browser-snapshot' ||
          input.kind === 'release-create'
        ) {
          const scope = input.scope;
          if (
            !scope ||
            ![scope.projectId, scope.worktreeId].every((value) =>
              /^[a-z0-9-]{1,128}$/i.test(value),
            )
          )
            throw new Error('Captured synthetic scope required.');
          if (
            input.kind !== 'release-create' &&
            (typeof input.deadline !== 'number' ||
              !Number.isFinite(input.deadline) ||
              Date.now() > input.deadline)
          )
            return {
              status: 'unavailable',
              reason: 'expired-diagnostic-request',
            };
          if (input.kind === 'arm-create') {
            if (
              typeof input.observerToken !== 'string' ||
              !/^[0-9a-f-]{36}$/i.test(input.observerToken)
            )
              throw new Error(
                'A captured diagnostic observer token is required.',
              );
            if (
              createDiagnostics?.snapshot().active ||
              operationDiagnostics?.snapshot().active ||
              profileReviewFixture ||
              browserRestoreBarrier
            )
              throw new Error(
                'A conflicting profile fixture is already armed.',
              );
            const service = getBrowserService();
            if (!service) throw new Error('Browser service is unavailable.');
            createDiagnostics = observeBrowserCreate(service, scope);
            createDiagnosticToken = input.observerToken;
            createDiagnosticScope = {
              projectId: scope.projectId,
              worktreeId: scope.worktreeId,
            };
          }
          const matches =
            createDiagnosticToken !== undefined &&
            createDiagnosticToken === input.observerToken &&
            createDiagnosticScope?.projectId === scope.projectId &&
            createDiagnosticScope?.worktreeId === scope.worktreeId;
          if (input.kind === 'release-create') {
            if (!matches)
              return {
                status: 'unavailable',
                reason: 'observer-scope-mismatch',
              };
            createDiagnostics?.release();
            return createDiagnostics?.snapshot();
          }
          return {
            receipt: matches
              ? createDiagnostics?.snapshot()
              : { status: 'not-armed' },
            ...captureBrowserBoundary(
              getBrowserService(),
              BrowserWindow.getAllWindows(),
              scope,
            ),
          };
        }
        if (input.kind === 'arm') {
          if (
            operationDiagnostics?.snapshot().active ||
            profileReviewFixture ||
            browserRestoreBarrier
          )
            throw new Error('A conflicting profile fixture is already armed.');
          if (
            !/^[0-9a-f-]{36}$/i.test(input.profileId) ||
            !Number.isSafeInteger(input.storageGeneration) ||
            input.storageGeneration < 1
          )
            throw new Error(
              'A captured synthetic profile and generation are required.',
            );
          const service = getBrowserService();
          if (!service) throw new Error('Browser service is unavailable.');
          operationDiagnostics = observeProfileOperations(
            service.profileData,
            input.profileId,
            input.storageGeneration,
            input.clear === true,
          );
        } else if (input.kind !== 'snapshot' && input.kind !== 'release') {
          throw new Error('Invalid profile diagnostic operation.');
        }
        if (!operationDiagnostics) return { active: false, stage: 'not-armed' };
        const snapshot = operationDiagnostics.snapshot();
        if (
          snapshot.profileId !== input.profileId ||
          snapshot.storageGeneration !== input.storageGeneration
        )
          throw new Error(
            'The observer belongs to another profile generation.',
          );
        if (input.kind === 'release') operationDiagnostics.release();
        return operationDiagnostics.snapshot();
      },
    },
  );
  let profileReviewLastFailure: string | undefined;
  let profileReviewFixture:
    | { profileId: string; entered: boolean; release: () => void }
    | undefined;
  Object.defineProperty(globalThis, '__CANOPY_E2E_PROFILE_REVIEW_FIXTURE__', {
    configurable: true,
    value: (input: {
      kind: 'delay-preview' | 'fail-reset-rebind' | 'status' | 'release';
      profileId: string;
    }): { armed: boolean; entered: boolean } => {
      if (input.kind === 'status' || input.kind === 'release') {
        const fixture = profileReviewFixture;
        if (!fixture)
          return {
            armed: false,
            entered: profileReviewLastFailure === input.profileId,
          };
        if (fixture.profileId !== input.profileId)
          throw new Error(
            'The profile review fixture belongs to another profile.',
          );
        if (input.kind === 'release') fixture.release();
        return { armed: input.kind !== 'release', entered: fixture.entered };
      }
      if (input.kind !== 'delay-preview' && input.kind !== 'fail-reset-rebind')
        throw new Error('Invalid profile review fixture operation.');
      if (
        profileReviewFixture ||
        operationDiagnostics?.snapshot().active ||
        !input.profileId
      )
        throw new Error(
          'A single captured profile is required for the review fixture.',
        );
      const service = getBrowserService();
      if (!service) throw new Error('Browser service is unavailable.');
      const method =
        input.kind === 'delay-preview' ? 'profileUsage' : 'rebindProfileViews';
      const descriptor = Object.getOwnPropertyDescriptor(service, method);
      let unblock = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      let released = false;
      const fixture = {
        profileId: input.profileId,
        entered: false,
        release: (): void => {
          if (released) return;
          released = true;
          clearTimeout(timer);
          if (descriptor) Object.defineProperty(service, method, descriptor);
          else Reflect.deleteProperty(service, method);
          if (profileReviewFixture === fixture)
            profileReviewFixture = undefined;
          unblock();
        },
      };
      profileReviewLastFailure = undefined;
      profileReviewFixture = fixture;
      const timer = setTimeout(fixture.release, 30_000);
      timer.unref();
      if (input.kind === 'delay-preview') {
        const original = service.profileUsage.bind(service);
        service.profileUsage = async (
          profileId,
        ): Promise<Awaited<ReturnType<typeof original>>> => {
          const result = await original(profileId);
          if (released || fixture.entered || profileId !== fixture.profileId)
            return result;
          fixture.entered = true;
          try {
            await gate;
            return result;
          } finally {
            fixture.release();
          }
        };
      } else {
        const original = service.rebindProfileViews.bind(service);
        service.rebindProfileViews = async (
          preview,
          generation,
        ): Promise<void> => {
          if (
            released ||
            preview.profileId !== fixture.profileId ||
            preview.operation.kind !== 'reset' ||
            generation !== preview.storageGeneration + 1
          )
            return original(preview, generation);
          fixture.entered = true;
          profileReviewLastFailure = fixture.profileId;
          fixture.release();
          throw new Error('Injected post-commit profile reset rebind failure');
        };
      }
      return { armed: true, entered: false };
    },
  });
  // Hold one fixture profile's restoration without changing maintenance
  // admission or exposing the BrowserService instance to the test runner.
  let browserRestoreBarrier:
    | { profileId: string; entered: boolean; release: () => void }
    | undefined;
  Object.defineProperty(globalThis, '__CANOPY_E2E_BROWSER_RESTORE_BARRIER__', {
    configurable: true,
    value: (input: {
      kind: 'arm' | 'status' | 'release';
      profileId: string;
    }): { armed: boolean; entered: boolean } => {
      if (input.kind === 'arm') {
        if (browserRestoreBarrier || operationDiagnostics?.snapshot().active)
          throw new Error('A browser restoration fixture is already armed.');
        if (!input.profileId)
          throw new Error('A browser restoration fixture profile is required.');
        const service = getBrowserService();
        if (!service) throw new Error('Browser service is unavailable.');
        const original = service.resumeProfileViews.bind(service);
        const descriptor = Object.getOwnPropertyDescriptor(
          service,
          'resumeProfileViews',
        );
        let unblock = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        let released = false;
        const barrier = {
          profileId: input.profileId,
          entered: false,
          release: (): void => {
            if (released) return;
            released = true;
            try {
              if (descriptor)
                Object.defineProperty(
                  service,
                  'resumeProfileViews',
                  descriptor,
                );
              else Reflect.deleteProperty(service, 'resumeProfileViews');
            } finally {
              if (browserRestoreBarrier === barrier)
                browserRestoreBarrier = undefined;
              unblock();
            }
          },
        };
        browserRestoreBarrier = barrier;
        service.resumeProfileViews = async function (
          ...args: Parameters<typeof original>
        ): Promise<void> {
          // captureProfileViews returns { snapshot, bounds, visible } records.
          if (
            !args[0].some(
              (tab) =>
                tab.snapshot.profile?.resolvedProfileId === barrier.profileId,
            )
          )
            return original(...args);
          barrier.entered = true;
          try {
            await gate;
            await original(...args);
          } finally {
            barrier.release();
          }
        };
        return { armed: true, entered: false };
      }
      const barrier = browserRestoreBarrier;
      if (!barrier) return { armed: false, entered: false };
      if (barrier.profileId !== input.profileId)
        throw new Error(
          'The browser restoration fixture belongs to another profile.',
        );
      if (input.kind === 'release') {
        barrier.release();
        return { armed: false, entered: barrier.entered };
      }
      if (input.kind !== 'status')
        throw new Error('Invalid browser restoration fixture operation.');
      return { armed: true, entered: barrier.entered };
    },
  });
  // Hold every browser session creation so UI automation can observe a tab
  // that is placed and loading before its backend session exists.
  let browserCreateGate: { entered: number; release: () => void } | undefined;
  Object.defineProperty(globalThis, '__CANOPY_E2E_BROWSER_CREATE_GATE__', {
    configurable: true,
    value: (input: {
      kind: 'arm' | 'status' | 'release';
    }): { armed: boolean; entered: number } => {
      if (input.kind === 'arm') {
        if (browserCreateGate)
          throw new Error('The browser creation gate is already armed.');
        const service = getBrowserService();
        if (!service) throw new Error('Browser service is unavailable.');
        const original = service.create.bind(service);
        const descriptor = Object.getOwnPropertyDescriptor(service, 'create');
        let unblock = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        let released = false;
        const armed = {
          entered: 0,
          release: (): void => {
            if (released) return;
            released = true;
            if (descriptor)
              Object.defineProperty(service, 'create', descriptor);
            else Reflect.deleteProperty(service, 'create');
            if (browserCreateGate === armed) browserCreateGate = undefined;
            unblock();
          },
        };
        browserCreateGate = armed;
        service.create = async function (
          ...args: Parameters<typeof original>
        ): Promise<Awaited<ReturnType<typeof original>>> {
          armed.entered += 1;
          await gate;
          return original(...args);
        };
        return { armed: true, entered: 0 };
      }
      const armed = browserCreateGate;
      if (!armed) return { armed: false, entered: 0 };
      if (input.kind === 'release') {
        const entered = armed.entered;
        armed.release();
        return { armed: false, entered };
      }
      if (input.kind !== 'status')
        throw new Error('Invalid browser creation gate operation.');
      return { armed: true, entered: armed.entered };
    },
  });
  // The browser context regression needs an actual authenticated HTTP ingress.
  // Expose only a synthetic seeded route, never the service or arbitrary owners.
  const browserMcpFixtureSessions = new Set<string>();
  Object.defineProperty(globalThis, '__CANOPY_E2E_BROWSER_MCP_ROUTE__', {
    configurable: true,
    value: async (
      input:
        | {
            kind: 'create';
            mode?: 'app-advisor';
            owner?: 'worktree' | 'cowork' | 'advisor';
          }
        | { kind: 'delete'; sessionKey: string },
    ) => {
      const service = getMcpHttpProxyService();
      if (input.kind === 'delete') {
        const removed = browserMcpFixtureSessions.delete(input.sessionKey);
        if (removed)
          service.unregisterCanopyWorktreeSessionRoute(input.sessionKey);
        return { removed };
      }
      if (input.kind !== 'create')
        throw new Error('Invalid browser MCP fixture operation.');
      const fixtureOwner = input.owner ?? 'worktree';
      if (!['worktree', 'cowork', 'advisor'].includes(fixtureOwner))
        throw new Error('Invalid browser MCP fixture owner.');
      const destination =
        fixtureOwner === 'cowork'
          ? {
              projectId: 'profile-data-cowork',
              worktreeId: 'profile-cowork-entry',
            }
          : fixtureOwner === 'advisor'
            ? { projectId: 'app-advisor', worktreeId: 'profile-advisor-entry' }
            : { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
      const sessionKey = `e2e-browser-profile-${randomUUID()}`;
      const authToken = randomUUID();
      const { createAppAdvisorToolRuntime } =
        await import('./app-advisor/runtime');
      await service.registerCanopyWorktreeSessionRoute({
        sessionKey,
        ...destination,
        chatId: 'seed-chat',
        cwd: app.getPath('userData'),
        sdkSessionId: sessionKey,
        authToken,
        createdAt: Date.now(),
        hookHandler: () => undefined,
        ...(input.mode === 'app-advisor'
          ? {
              assistantMode: 'app-advisor',
              appAdvisorRuntime: createAppAdvisorToolRuntime(
                {
                  getMainWindow: () => mainWindow,
                  getAppAdvisorWindow,
                  openAppAdvisorWindow,
                  ensureAppAdvisorWindow,
                },
                {
                  ...destination,
                  chatId: 'seed-chat',
                },
              ),
            }
          : {}),
      });
      browserMcpFixtureSessions.add(sessionKey);
      return {
        sessionKey,
        authToken,
        url: service.getCanopyWorktreeMcpUrl(sessionKey),
      };
    },
  });
  // A Canopy action that asks for approval needs a live session for the chat
  // that called it. Specs run no provider session, so they register a real
  // one for a chat, with a mode, here.
  const approvalFixtureSessions = new Map<string, { dispose(): void }>();
  Object.defineProperty(globalThis, '__CANOPY_E2E_APPROVAL_SESSION__', {
    configurable: true,
    value: async (
      input:
        | {
            kind: 'create';
            projectId: string;
            worktreeId: string;
            chatId: string;
            mode: string;
            /** The worktree whose root Auto treats as the workspace. */
            root: { projectId: string; worktreeId: string };
          }
        | { kind: 'dispose'; id: string },
    ) => {
      if (input.kind === 'dispose') {
        approvalFixtureSessions.get(input.id)?.dispose();
        return { disposed: approvalFixtureSessions.delete(input.id) };
      }
      if (input.kind !== 'create')
        throw new Error('Invalid approval fixture operation.');
      const mode = APPROVAL_MODES.find((candidate) => candidate === input.mode);
      if (!mode) throw new Error('Invalid approval fixture mode.');
      const [{ createApprovalSession }, { resolveWorktreeCwd }] =
        await Promise.all([
          import('./approvals/approval-service'),
          import('./lib/resolve-worktree'),
        ]);
      const workspaceRoot = resolveWorktreeCwd(
        input.root.projectId,
        input.root.worktreeId,
      );
      const id = randomUUID();
      approvalFixtureSessions.set(
        id,
        createApprovalSession({
          sessionKey: `e2e-approval-${id}`,
          projectId: input.projectId,
          worktreeId: input.worktreeId,
          chatId: input.chatId,
          provider: 'claude',
          workspaceRoot,
          mode,
          sessionRules: [],
          getWindow: () =>
            input.projectId === APP_ADVISOR_PROJECT_ID
              ? (getAppAdvisorWindow() ?? mainWindow)
              : mainWindow,
        }),
      );
      return { id, workspaceRoot };
    },
  });
  Object.defineProperty(globalThis, '__CANOPY_E2E_DISPATCH_BROWSER_ACTION__', {
    configurable: true,
    // Inspector calls can arrive inside another browser command's ALS scope.
    // Capture the clean startup boundary once, while preserving each command's
    // own runtime-generation checks inside the real dispatchers.
    value: AsyncResource.bind(
      async (input: {
        action: AppAdvisorBrowserAction;
        destination: AppAdvisorWatcherDestination;
        path: 'scoped' | 'app-advisor';
      }) => {
        if (input.path === 'app-advisor') {
          const { createAppAdvisorToolRuntime } =
            await import('./app-advisor/runtime');
          const runtime = createAppAdvisorToolRuntime(
            {
              getMainWindow: () => mainWindow,
              getAppAdvisorWindow,
              openAppAdvisorWindow,
              ensureAppAdvisorWindow,
            },
            input.destination,
          );
          return runtime.dispatchRendererAction(input.action);
        }
        const { dispatchWorktreeAction } =
          await import('./canopy-tools/worktree-actions');
        return dispatchWorktreeAction(
          { action: input.action },
          {
            ...input.destination,
            cwd: app.getPath('userData'),
            getWindow:
              input.destination.projectId === APP_ADVISOR_PROJECT_ID
                ? getAppAdvisorWindow
                : (): BrowserWindow | null => mainWindow,
          },
        );
      },
      'CanopyE2eBrowserDispatch',
    ),
  });
  Object.defineProperty(globalThis, '__CANOPY_E2E_WORKSPACE_ACTIVITY__', {
    configurable: true,
    value: {
      touchWorkspaceTarget,
      withArchivedWorkspaceOperationLock,
      getChatStateService,
      isWorkspaceTargetRuntimeStartReserved,
      getBrowserProfileService,
    },
  });
  // Ledger panel specs seed entries through the desktop dispatcher.
  Object.defineProperty(globalThis, '__CANOPY_E2E_LEDGER__', {
    configurable: true,
    value: {
      addEntry: addLedgerEntryForE2e,
      updateEntry: updateLedgerEntryForE2e,
      handBackEntry: handBackLedgerEntryForE2e,
      pausePipelineAgent: pausePipelineAgentForE2e,
      resumePipelineExecution: resumePipelineExecutionForE2e,
      storageWorkersStarted: ledgerStorageWorkersStarted,
    },
  });
  Object.defineProperty(globalThis, E2E_CHAT_EVENT_INGESTOR_KEY, {
    configurable: true,
    value: async (event: E2eChatEventPayload): Promise<void> => {
      // Injected events stand in for a provider session, so feed main's own
      // live background-task reducer the same way a real session does.
      applyE2eIngestedLiveBackgroundTaskEvent(
        event.projectId,
        event.worktreeId,
        event.chatId,
        event.data,
      );
      const data =
        (event.providerType === undefined || event.providerType === 'claude') &&
        isRecord(event.data) &&
        (event.data.type === 'error' ||
          (event.data.type === 'result' &&
            event.data.canopy_session_continues !== true))
          ? {
              ...event.data,
              [CHILD_TOOL_LIVENESS_STAMP]:
                readChildToolLivenessStamp(event.data) ??
                getChildToolLiveness(
                  event.projectId,
                  event.worktreeId,
                  event.chatId,
                ),
            }
          : event.data;
      const outcome =
        await getChatStateService().ingestProviderEventWithOutcome({
          projectId: event.projectId,
          worktreeId: event.worktreeId,
          chatId: event.chatId,
          data,
          mutationId: `e2e-provider:${randomUUID()}`,
          ...(event.providerType ? { providerType: event.providerType } : {}),
          ...(event.turnUserMessageId
            ? { turnUserMessageId: event.turnUserMessageId }
            : {}),
        });
      if (outcome === 'not-applied') return;
      if (mainWindow)
        sendToWebContents(mainWindow.webContents, IPC_CHANNELS.chatEvent, {
          ...event,
          data,
        });
    },
  });
  Object.defineProperty(globalThis, E2E_PENDING_QUESTION_UPSERTER_KEY, {
    configurable: true,
    value: async (input: {
      projectId: string;
      worktreeId: string;
      question: PersistedPendingQuestion;
    }): Promise<void> => {
      await getChatStateService().upsertPendingQuestion(
        { projectId: input.projectId, worktreeId: input.worktreeId },
        input.question,
      );
    },
  });
  Object.defineProperty(globalThis, E2E_CLAUDE_QUERY_PRELUDE_KEY, {
    configurable: true,
    value: {
      arm: armE2eClaudeQueryPrelude,
      read: readE2eClaudeQueryPreludeState,
      reset: resetE2eClaudeQueryPreludes,
    },
  });
}

function getInstrumentationAccountEmail(
  account: CanopyCloudAccountEntry | null,
): string | undefined {
  return isGuestAccount(account) ? undefined : account?.account?.email;
}

/**
 * The main PostHog client follows the effective usage-data policy (see
 * `installPostHogMainLifecycle`): it starts once the policy settles on the
 * selected context and while Usage analytics or Error reports is on.
 */
function startDesktopInstrumentation(): void {
  installPostHogMainLifecycle(
    getUsageDataPolicy(),
    suspendPostHogMain,
    () =>
      void initializePostHogMain(
        getStablePostHogAnonymousKey,
        {
          getSnapshot: async (): Promise<string | null> =>
            getPostHogEmailDomain(
              getInstrumentationAccountEmail(await loadCanopyCloudAccount()),
            ),
          onSnapshotChanged: (listener): (() => void) =>
            subscribeCanopyCloudAccountChanges((account): void => {
              const domain = getPostHogEmailDomain(
                getInstrumentationAccountEmail(account),
              );
              listener(domain);
              sendToAllWindows(
                IPC_CHANNELS.observabilityPostHogEmailDomainUpdate,
                domain,
              );
            }),
        },
        getPostHogInstallLaunch,
        () => ({
          osVersion: process.getSystemVersion(),
          cpuArchitecture: app.runningUnderARM64Translation
            ? 'arm64'
            : process.arch,
        }),
      ).then((result) => {
        if (!result.enabled && result.reason && result.reason !== 'disabled') {
          getObservabilityService().recordAppDiagnostic({
            version: 1,
            timestamp: new Date().toISOString(),
            kind: 'desktop_instrumentation_init_failed',
            reason: `posthog: ${result.reason}`,
          });
        }
      }),
  );
}

/**
 * Startup retention for the local Crashpad database (`uploadToServer: false`,
 * so nothing else prunes it). Foreign dumps are deleted where the filter
 * applies; on other hosts every dump is treated as Canopy's.
 */
async function runStartupCrashDumpSweep(): Promise<void> {
  const hostOs = hostOperatingSystem();
  const counts = await sweepCrashDumps({
    crashDumpsDir: app.getPath('crashDumps'),
    ...(hostOs && {
      classify: createForeignCrashDumpFilter({
        getCrashDumpsDir: () => app.getPath('crashDumps'),
        getExePath: () => app.getPath('exe'),
        platform: hostOs,
        onClassified: recordCrashDumpClassification,
      }),
    }),
  });
  // An empty, error-free sweep is the common launch; recording it adds noise.
  if (counts.listed === 0 && counts.errors === 0) return;
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: 'crash_dump_sweep',
    crashDumpSweep: counts,
  });
}

const W5_REFUSAL_FLUSH_TIMEOUT_MS = 1_000;

/**
 * TRANSITIONAL (CAN-3797 Q3): startup refuses while data maintenance holds the
 * data folder. Final copy waits until maintenance is user-facing (CAN-4498);
 * remove with the W5 host cohort. Nothing has started yet, so exit directly.
 */
function exitForW5HostRefusal(message: string): void {
  // A modal alert would block headless E2E launches, which assert the exit.
  if (!__CANOPY_E2E__)
    dialog.showErrorBox(`Couldn't open ${BRAND.displayName}`, message);
  let exited = false;
  const exit = (): void => {
    if (exited) return;
    exited = true;
    app.exit(1);
  };
  // Exit once stderr flushes: pipe writes are asynchronous on macOS, and
  // app.exit() drops a pending one. The timer bounds a stalled stderr.
  const flushTimeout = setTimeout(exit, W5_REFUSAL_FLUSH_TIMEOUT_MS);
  process.stderr.write(`${message}\n`, (): void => {
    clearTimeout(flushTimeout);
    exit();
  });
}

function movePackagedMacAppToApplicationsIfNeeded(): boolean {
  if (
    process.platform !== 'darwin' ||
    !app.isPackaged ||
    app.isInApplicationsFolder()
  ) {
    return false;
  }

  const response = dialog.showMessageBoxSync({
    type: 'question',
    buttons: ['Move to Applications', 'Continue Here'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    message: `Move ${BRAND.displayName} to the Applications folder?`,
    detail: `Automatic updates require ${BRAND.displayName} to run from Applications. The app will relaunch after it moves.`,
  });

  if (response !== 0) {
    return false;
  }

  try {
    return app.moveToApplicationsFolder();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`Failed to move ${BRAND.displayName} to Applications.`, error);
    return false;
  }
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

setMainWindowResolver(getMainWindow);

function unlockStartupWork(): void {
  if (startupUnlocked || appIsQuitting) return;
  startupUnlocked = true;

  recordRealisticStartupPerformanceEvent('startup:unlock');
  // Persisted auto-delete arms wait for startup recovery: the resume queue
  // starts just before this, so interrupted turns count as busy first.
  workEntryAutoDeleteScheduler ??= startWorkEntryAutoDeleteScheduler();

  recordRealisticStartupPerformanceEvent('startup:automations:requested');
  // Rebind items of projects moved before rebinding existed, before the
  // first scheduled run; a failed sweep never holds back the schedules.
  void getBackgroundExecutionContextRebinder()
    .repairRecordedOwnershipChanges()
    .catch((error: unknown): void => {
      logMainProcessError(
        'Failed to repair background execution bindings:',
        error,
      );
    })
    .then((): Promise<void> => getAutomationsService().start())
    .then((): void => {
      recordRealisticStartupPerformanceEvent('startup:automations:completed');
      // CAN-5479: converts the remaining chat automations once released.
      if (!appIsQuitting)
        startChatAutomationMigration({ service: getAutomationsService() });
    })
    .catch((error: unknown): void => {
      recordRealisticStartupPerformanceEvent('startup:automations:failed');
      // eslint-disable-next-line no-console
      console.error('Failed to start automations service:', error);
    });
  recordRealisticStartupPerformanceEvent('startup:shared-plan:requested');
  void initializeSharedPlanStartup()
    .then((): void => {
      recordRealisticStartupPerformanceEvent('startup:shared-plan:completed');
    })
    .catch((error: unknown): void => {
      recordRealisticStartupPerformanceEvent('startup:shared-plan:failed');
      // eslint-disable-next-line no-console
      console.error('Failed to initialize shared plan startup:', error);
    });
  initializeResourceMonitorService(() => mainWindow);
  recordRealisticStartupPerformanceEvent('startup:resource-monitor:started');
  // Beachballs are main-thread stalls that process CPU averages cannot show.
  // Record each window with a long stall or sustained jank in app-events, with
  // what main was doing: its utilization, thread-pool probe latency, chat
  // commits, running turns, and background code-graph generation.
  stopMainEventLoopMonitor = startMainEventLoopMonitor({
    readCommitCount: chatStorageCommitTotal,
    onStall: (stall): void => {
      const queue = getCodeGraphGenerationQueueSnapshot();
      getObservabilityService().recordAppDiagnostic(
        buildMainEventLoopStallDiagnostic(stall, {
          timestamp: new Date().toISOString(),
          runningCodeGraphBuildCount: queue.entries.filter(
            (entry) => entry.status === 'running',
          ).length,
          queuedCodeGraphBuildCount: queue.entries.filter(
            (entry) => entry.status === 'queued',
          ).length,
          activeTurnCount: getChatTurnConcurrencySnapshot().activeTurns,
        }),
      );
    },
  });
  // About once a minute while chat storage is active: per-scope summaries in
  // session-events and an aggregate without identifiers in app-events.
  stopChatStorageActivityDiagnostics = startChatStorageActivityDiagnostics();
  recordRealisticStartupPerformanceEvent(
    'startup:codex-capability-gc:requested',
  );
  void collectDesktopCodexCapabilityGarbage()
    .then((): void => {
      recordRealisticStartupPerformanceEvent(
        'startup:codex-capability-gc:completed',
      );
    })
    .catch((error: unknown): void => {
      recordRealisticStartupPerformanceEvent(
        'startup:codex-capability-gc:failed',
      );
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'startup_background_task_failed',
        reason: `codex_capability_gc: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    });
  if (
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
    )
  ) {
    // Wake recovery (CAN-2651): the heartbeat timer chain and the long-poll
    // await both freeze across sleep, so a >90s suspend crosses the server's
    // reap threshold with nothing in flight. Injected structurally so the
    // portal module keeps no direct `electron` runtime import.
    setCanopyPortalPowerMonitor(powerMonitor);
    recordRealisticStartupPerformanceEvent('startup:portal-resume:requested');
    void resumeCanopyPortalIfPossible();
  }
  startUpdater(
    () => mainWindow,
    () =>
      cleanupRuntimeResources('app-quit').catch(() => {
        // Cleanup has crossed irreversible process-lifetime gates. The app
        // cannot safely remain open or retry the memoized cleanup promise.
        app.exit(0);
      }),
  );
  recordRealisticStartupPerformanceEvent('startup:updater:started');
  cancelStartupBackgroundTasks = scheduleDeferredStartupBackgroundTasks(
    getMainWindow,
    {
      runCrashDumpSweep: runStartupCrashDumpSweep,
    },
  );
  disposeOnboardingProfileSync ??= startOnboardingProfileSync();
  // Flush turn ratings queued while signed out (CAN-1521). Sign-in is the
  // trigger that makes rate-as-guest → sign in work.
  disposeTurnFeedbackFlush ??= subscribeTurnFeedbackFlush();
  // Upload install subscriptions when a non-guest account signs in or
  // switches (CAN-2334).
  disposeSharedItemSubscriptionFlush ??= subscribeSharedItemSubscriptionFlush();
  disposeCuratedMcpRefresh = startCuratedMcpRefresh();
  // Plugins installed before a provider was connected reach it once its
  // sign-in is confirmed (CAN-3639). Deferred with the other background work;
  // a provider the startup prewarm already confirmed is replayed on subscribe.
  disposeProviderPluginBackfill ??= startProviderPluginBackfill({
    subscribe: subscribeConfirmedProviderAuth,
  });
  // A sign-in to a different Claude or Codex account ends session-scoped AI
  // Credits routing (CAN-4200). Startup replay covers a switch made while the
  // app was closed.
  disposeNativeAccountChangeTracking ??= startNativeAccountChangeTracking({
    subscribe: subscribeConfirmedProviderAuth,
    clearRoutingCaches: (): void => {
      clearAiCreditsRoutingContextCache();
      clearAiCreditsRoutingModeCache();
    },
  });
}

function getAppAdvisorWindow(): BrowserWindow | null {
  return appAdvisorWindow;
}

/**
 * App Advisor's renderer page as a window-like surface: the window itself,
 * or under early access the view it hosts. For code that matches a renderer
 * by identity (IPC callers) rather than sending to it.
 */
function getAppAdvisorRendererSurface(): RendererSurfaceWindow | null {
  const win = appAdvisorWindow;
  if (!win || win.isDestroyed()) return null;
  const renderer = rendererContentsOf(win.webContents);
  return renderer === win.webContents
    ? win
    : {
        isDestroyed: (): boolean => renderer.isDestroyed(),
        webContents: renderer,
      };
}

function isAppAdvisorVisible(): boolean {
  if (appAdvisorHost) return appAdvisorHost.isVisible();
  const win = appAdvisorWindow;
  return win !== null && !win.isDestroyed() && win.isVisible();
}

function isAppAdvisorFocused(): boolean {
  if (appAdvisorHost) return appAdvisorHost.isFocused();
  const win = appAdvisorWindow;
  return win !== null && !win.isDestroyed() && win.isFocused();
}

/**
 * The early access layout, from where the host has the renderer: hidden, the
 * layout it last showed, which its page keeps rendering.
 */
function currentAppAdvisorLayout(): AppAdvisorWindowLayout {
  return appAdvisorHost?.layout ?? 'full';
}

function flushPendingWindowState(): Promise<void> {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    if (windowStateSaveTimeout !== null) {
      clearTimeout(windowStateSaveTimeout);
      windowStateSaveTimeout = null;
    }
    return Promise.resolve();
  }

  return cancelDebouncedSaveAndFlush(mainWindow);
}

function flushPendingAppAdvisorWindowState(): Promise<void> {
  if (appAdvisorWindow === null || appAdvisorWindow.isDestroyed()) {
    if (appAdvisorWindowStateSaveTimeout !== null) {
      clearTimeout(appAdvisorWindowStateSaveTimeout);
      appAdvisorWindowStateSaveTimeout = null;
    }
    return Promise.resolve();
  }

  return cancelDebouncedAppAdvisorWindowStateAndFlush(appAdvisorWindow);
}

/**
 * Lets queued Ledger lifecycle steps finish before Ledger storage shuts down,
 * which would otherwise reject them. Bounded, and it never fails quit: the
 * next startup pass settles whatever is left. Resolves at once when no
 * lifecycle step ever ran.
 */
async function drainLedgerLifecycle(): Promise<void> {
  let cancelTimeout = (): void => undefined;
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, LEDGER_LIFECYCLE_DRAIN_TIMEOUT_MS);
    cancelTimeout = (): void => clearTimeout(timer);
  });
  try {
    await Promise.race([whenLedgerLifecycleIdle(), timeout]);
  } catch {
    // Best effort: an unexpected lifecycle rejection must not fail quit.
  } finally {
    cancelTimeout();
  }
}

let runtimeCleanupComplete = false;
let startupRecoveryPromise: Promise<void> | null = null;

async function cleanupRuntimeResources(
  reason: 'app-quit' | 'fatal-exit',
): Promise<void> {
  if (runtimeCleanupPromise !== null) {
    return runtimeCleanupPromise;
  }

  appIsQuitting = true;
  stopPreferencesGenerationStamp();
  stopSettingsWriteRefreshRetries();
  stopMainEventLoopMonitor?.();
  stopMainEventLoopMonitor = null;
  stopPersonalCatalogSync();
  stopCloudProjectBinding();
  stopCloudProjectSetupSweep();
  stopResumeQueue();
  beginSplitTemporaryWorkspaceShutdown();
  cancelPendingW5FlipHandoff();
  let diagnosticsOpen = true;
  const reportCleanup = (event: RuntimeCleanupDiagnostic): void => {
    // The file sink survives observability disposal and the updater's direct
    // cleanup path (which runs before Electron emits before-quit).
    logMainProcessInfo('[shutdown]', event);
    if (diagnosticsOpen) getObservabilityService().recordAppDiagnostic(event);
  };
  const stages = new RuntimeCleanupStages(reportCleanup, reason);
  const exitGuard = new DrainedProcessExitGuard({
    exit: (): void => app.exit(0),
    report: reportCleanup,
    reason,
  });
  drainedProcessExitGuard = exitGuard;
  runtimeCleanupPromise = stages.run('runtime', async (): Promise<void> => {
    // A failed preparatory stage must not skip the recovery drains or the
    // provider stops below; it fails the runtime stage once teardown finishes.
    const preparationFailures: unknown[] = [];
    const deferPreparationFailure = (stage: Promise<unknown>): Promise<void> =>
      stage.then(
        () => undefined,
        (error: unknown): void => {
          logMainProcessWarn('[shutdown] Preparatory stage failed', error);
          preparationFailures.push(error);
        },
      );
    // Release the OS-level chord first: nothing below depends on it and a
    // registration must never outlive the process that owns the callback.
    disposeGlobalFocusShortcutService();
    await settleBestEffortCleanup(
      stages.run('foreign-activity', () =>
        Promise.race([
          getForeignActivityCarryoverService().shutdown(),
          new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
        ]),
      ),
    );
    stopLocalMemoryConsolidationScheduler();
    stopSuggestionsGateHydration();
    stopSkillSuggestions();
    await settleBestEffortCleanup(
      stages.run('local-memory-usage', flushPendingLocalMemoryUsage),
    );
    await deferPreparationFailure(stages.run('resume-queue', flushResumeQueue));
    setLedgerPendingTitleScheduler(undefined);
    await deferPreparationFailure(
      stages.run(
        'ledger-pending-titles',
        shutdownDesktopPendingTitleOrchestrator,
      ),
    );
    shutdownBackgroundHelperQueue();
    const windowStateFlush = stages.run(
      'window-state',
      flushPendingWindowState,
    );
    const appAdvisorWindowStateFlush = stages.run(
      'advisor-window-state',
      flushPendingAppAdvisorWindowState,
    );
    stopAllPlanRealtimeSubscriptions();
    disposeDesktopSessionSnapshotHandlers();
    stopOrgEnforcedSettingsSync();
    disposeOnboardingProfileSync?.();
    disposeOnboardingProfileSync = null;
    disposeCuratedMcpRefresh?.();
    disposeCuratedMcpRefresh = null;
    disposeProviderPluginBackfill?.();
    disposeProviderPluginBackfill = null;
    disposeNativeAccountChangeTracking?.();
    disposeNativeAccountChangeTracking = null;
    disposeProviderAccountConnectTelemetry?.();
    disposeProviderAccountConnectTelemetry = null;
    setAiGatewayCatalogRetryHandler(undefined);
    aiGatewayModelCatalogService?.dispose();
    aiGatewayModelCatalogService = null;
    // Detach the module-scope proxy diagnostic sink before the observability
    // service is disposed; otherwise a late in-flight proxy failure keeps
    // pushing records into a torn-down service during shutdown.
    setCodexGatewayProxyDiagnosticSink(undefined);
    // Snapshot every active target before producer teardown. Hook/script/PTY
    // stop APIs can return before their asynchronous exit notifications, so
    // this final watermark must be initiated while their registries are intact.
    const activeTargetTouchFlush = stages.run(
      'active-target-touch',
      touchActiveAutoArchiveTargets,
    );
    // Disarm the scheduler and drain any active sweep before services used by
    // Auto Delete begins shutting down. Activity subscriptions stay attached
    // until producers have emitted their final inactivity watermarks below.
    await deferPreparationFailure(
      stages.run('work-entry-auto-delete', () =>
        workEntryAutoDeleteScheduler?.stop(),
      ),
    );
    await deferPreparationFailure(
      stages.run('auto-archive', () => autoArchiveScheduler?.stopScheduling()),
    );
    // Stream repair owns the same durable ports as live delegation actors.
    // Disarm the gate and drain its current scope before watcher/chat teardown.
    cancelStartupBackgroundTasks?.();
    cancelStartupBackgroundTasks = null;
    await deferPreparationFailure(
      stages.run(
        'delegation-startup-repair',
        shutdownDeferredStartupStreamRepair,
      ),
    );
    // Stop schedulers before closing admission and checkpointing active work.
    getAutomationsService().stop();
    getAppAdvisorWatcherService().shutdown();
    const localWatcherShutdown = settleBestEffortCleanup(
      stages.run('watcher-drain', () => getAppAdvisorWatcherService().drain()),
    );
    holdHooksForShutdown();
    if (startupRecoveryPromise)
      await deferPreparationFailure(
        stages.run('startup-recovery', () => startupRecoveryPromise),
      );
    // Before chat and runtime teardown can end or fail a daemon host step in
    // flight, such as an agent-reply wait: its run should pause, not settle
    // on a quit (CAN-6033).
    await stages.bestEffort('daemon-host-steps', async (): Promise<void> => {
      const owner = await import('./pipelines/daemon-pipeline-owner');
      owner.stopDaemonPipelineOwnerSettlement();
    });
    // The checkpoint goes through core while its runtime still runs; with
    // none, nothing could have started a run, so only admission closes.
    const pipelinePause = stages.run('pipeline-recovery', () =>
      desktopCanopyRuntime
        ? checkpointPipelinesThroughLocalWorker()
        : pauseAllActivePipelineExecutions(),
    );
    const splitBackgroundDrain = stages
      .run('split-background', drainSplitTemporaryWorkspaceBackgroundPhases)
      .catch(() => undefined);
    // Stop in-flight Add project clones so git's helpers do not outlive the
    // app. Clone jobs remove their partial checkouts; clones without a job
    // keep theirs, reserved for launch recovery.
    const cloneJobsShutdown = stages
      .run('clone-jobs', shutdownCloneJobs)
      .catch(() => undefined);
    const stagedSessionImportCleanup = stages
      .run('session-imports', discardAllStagedSessionImports)
      .catch(() => undefined);
    getPipelineAdvisorService().shutdown(reason);
    await stages
      .run('delegation', shutdownDelegationLifecycle)
      .catch((error: unknown) => {
        logMainProcessWarn(
          '[delegation] Shutdown did not confirm every owned child stopped',
          error,
        );
      });
    const chatShutdown = stages.run('chat-recovery', () =>
      destroyAllSessions({ recordInterrupted: true }),
    );
    const claudeTerminalShutdown = stages.run('terminal-recovery', () =>
      getClaudeTerminalSessionService().shutdown({
        recordInterrupted: true,
      }),
    );
    // Provider event routes and runtime transports must survive both drains.
    const recoveryDrainResults = await Promise.allSettled([
      pipelinePause,
      localWatcherShutdown,
      chatShutdown,
      claudeTerminalShutdown,
    ]);
    // First provider stop: Copilot closes admission and revokes runtimes, then
    // drains rotations alongside the other provider stops in the stage below.
    const copilotShutdown = shutdownCopilotConnections();
    // Session teardown performs the bounded final output drain. Clear any
    // orphan pollers only after that drain has had access to their state.
    stopAllOutputPolling();
    const recoveryDrainFailures = recoveryDrainResults.filter(
      (result) => result.status === 'rejected',
    );
    // Stop every Codex app-server (pooled and one-shot) with a bounded,
    // awaited SIGTERM → SIGKILL escalation. The pool's own force-kill timers
    // are unref'd and die with the main process, and the app-servers are
    // spawned detached — without this sweep a slow-to-exit app-server
    // survives quit as an orphan holding the shared Codex state DB, wedging
    // every Codex session and marketplace call in the next app launch.
    const codexRuntimeShutdown = stages
      .run('codex-runtime', shutdownCodexRuntimeService)
      .catch(() => undefined);
    // Bounded: a Connect that is mid-extraction or a running approval check
    // stops on abort, but quit must never wait on either indefinitely.
    const cursorShutdown = stages.run('cursor-connections', () =>
      Promise.race([
        Promise.allSettled([
          shutdownCursorApprovalChecks(),
          shutdownCursorConnections(),
          copilotShutdown,
          shutdownOpenCodeConnections(),
        ]),
        new Promise<void>((resolve) => setTimeout(resolve, 3_000)),
      ]),
    );
    const codexProcessTermination = codexRuntimeShutdown.then(() =>
      stages
        .run('codex-processes', terminateAllCodexAppServerProcesses)
        .catch(() => undefined),
    );
    const pipelineProcessTermination = stages
      .run('pipeline-processes', shutdownPipelineProcessHost)
      .catch(() => undefined);
    const claudeProcessTermination = stages
      .run('claude-processes', shutdownClaudeProcessHost)
      .catch(() => undefined);
    const providerProcessTermination = stages
      .run('provider-processes', shutdownProviderProcessHost)
      .catch(() => undefined);
    const archiveIoTermination = stages
      .run('archive-io', shutdownArchiveIoRunner)
      .catch(() => undefined);
    cancelAllDiscoveries();
    stopAllRunningShellScripts();
    disposeTurnFeedbackFlush?.();
    disposeTurnFeedbackFlush = null;
    disposeSharedItemSubscriptionFlush?.();
    disposeSharedItemSubscriptionFlush = null;
    stopArchivedContainerRetention?.();
    stopArchivedContainerRetention = null;
    // Kill any in-flight/queued off-main code-graph build workers so quitting
    // Canopy can never leave a `code-graph-build` utilityProcess orphaned or
    // still writing to a worktree's graph.db after the app exits. Kills are
    // issued synchronously here; the returned promise (killed workers have
    // exited, with a bounded per-worker fallthrough — it never rejects) is
    // awaited just before `getCodeGraphWorktreeService().closeAll()` below so
    // no worker is left racing that close.
    const codeGraphBaseTeardown = stages
      .run('code-graph-base', shutdownCodeGraphBaseManager)
      .catch(() => undefined);
    const codeGraphWorkerTeardown = codeGraphBaseTeardown.then(() =>
      stages.run('code-graph-builds', killAllBuilds),
    );
    const codeGraphReadTeardown = stages
      .run('code-graph-readers', shutdownCodeGraphReadWorkers)
      .catch(() => undefined);
    const codeGraphFingerprintTeardown = stages
      .run('code-graph-fingerprints', shutdownCodeGraphFingerprintWorkers)
      .catch(() => undefined);
    // Cancel any in-progress OAuth connect/login flows so their loopback
    // servers and 10-minute timeouts don't outlive shutdown. Dynamic import
    // mirrors the ipc/settings.ts pattern and keeps these modules off
    // index.ts's static graph; best-effort so a failed import can't block quit.
    void (async (): Promise<void> => {
      try {
        const { cancelCanopyCloudOAuthLogin } =
          await import('./canopy-cloud/oauth-login');
        cancelCanopyCloudOAuthLogin();
      } catch {
        // best-effort: never block shutdown on a cancel failure
      }
    })();
    getGitHubBroker().shutdown();
    stopWorktreeBranchWatchers();
    stopWorktreesFileWatchers();
    stopWorkspaceApprovalsManifestWatchers();
    const browserShutdown = stages.run('browser', () =>
      getBrowserService()?.shutdown(),
    );
    const claudeWorkerShutdown = stages.run('claude-workers', () =>
      getClaudeWorkerSessionService().shutdown(),
    );
    terminalPersistenceStore.markAllLiveTerminalsExited(
      reason === 'app-quit' ? 'app-quit' : 'fatal-exit',
    );
    // Flush any debounce-pending panel-layout writes before quit so the last
    // grid mutation survives the restart.
    panelLayoutPersistenceStore.flushAllSync();
    workerTerminal.killAll();
    // D4: daemon terminals end before this app's daemon session closes.
    const daemonTerminalsTeardown = stages
      .run('daemon-terminals', () => workerTerminal.daemonTerminals?.killAll())
      .catch(() => undefined);
    cancelPortalStructuralSync();
    getDesktopInventorySyncService().dispose();
    void stopCanopyPortal('app_shutdown').catch(() => undefined);
    getSharedContainerInboxWatcher().shutdown();
    uninstallFeatureFlagRecoveryTriggers?.();
    uninstallFeatureFlagRecoveryTriggers = null;
    await stages.run('labs-experiments', disposeLabsExperimentsService);
    await stages.run('feature-flags', disposeFeatureFlagService);
    destroyBackgroundTray();
    await stages.run('activation-journey', shutdownActivationJourney);
    getVoiceService().shutdown();
    shutdownSignInRuns();
    await stages.run('ollama', () => getOllamaService().shutdown('app-quit'));
    await stages.run('account-proxy-local', shutdownLocalAccountProxyAtQuit);
    await splitBackgroundDrain;
    await codexRuntimeShutdown;
    await pipelineProcessTermination;
    await claudeProcessTermination;
    await providerProcessTermination;
    await archiveIoTermination;
    await cursorShutdown;
    await stagedSessionImportCleanup;
    await cloneJobsShutdown;
    await stages
      .run('codex-plugin-worker', shutdownCodexPluginMaterializationWorker)
      .catch(() => undefined);
    await codexProcessTermination;
    await stages
      .run('codex-catalog', cleanupGatewayCompatibleCodexCatalog)
      .catch(() => undefined);
    await browserShutdown;
    await claudeWorkerShutdown;
    childToolsSettlement?.stop();
    await stages.run('child-tools-settlement', () =>
      childToolsSettlement?.drain(),
    );
    childToolsSettlement = null;
    try {
      await drainChatStateBeforeRuntimeShutdown(
        () => stages.run('chat-state', () => getChatStateService().drain()),
        async () => {
          closeChatStatePush?.();
          closeChatStatePush = null;
          closeCanopyCloudSessionStatusPush?.();
          closeCanopyCloudSessionStatusPush = null;
          await stages.run('core-runtime', () =>
            desktopCanopyRuntime?.shutdown(),
          );
        },
      );
    } finally {
      exitGuard.markDrained();
    }
    desktopCanopyRuntime = null;
    setDesktopCanopyRuntime(null);
    await daemonTerminalsTeardown;
    await stages.bestEffort(
      'electron-daemon-connections',
      async (): Promise<void> => {
        // The owner subscription closes before the shared sessions (CAN-5771).
        await import('./pipelines/daemon-pipeline-owner')
          .then((owner) => owner.disposeDaemonPipelineOwnerSettlement())
          .catch(() => undefined);
        disposeDesktopDaemonGitRoute();
        await disposeElectronDaemonFiles();
      },
    );
    bindConfiguredPromptFilesystemDispatcher(null);
    bindLedgerToolsDispatcher(null);
    // The last chat-storage summary counts the commits made while chat state
    // drained, and is recorded before observability is disposed below.
    stopChatStorageActivityDiagnostics?.({ flush: true });
    stopChatStorageActivityDiagnostics = null;
    // Keep activity subscriptions alive until every producer has stopped so
    // terminal/session teardown can publish its final inactivity watermark.
    await activeTargetTouchFlush;
    await stages.run('workspace-touches', flushWorkspaceTargetTouches);
    autoArchiveScheduler?.disposeActivitySubscriptions();
    autoArchiveScheduler = null;
    workEntryAutoDeleteScheduler = null;
    setAutoArchiveResultListener(null);
    await codeGraphWorkerTeardown;
    await codeGraphReadTeardown;
    await codeGraphFingerprintTeardown;
    await stages
      .run('code-graph-stores', () => getCodeGraphWorktreeService().closeAll())
      .catch(() => undefined);
    await stages
      .run('chat-search', closeChatSearchService)
      .catch(() => undefined);
    // Sync first, so a purge waiting at quit does not wait on the network.
    await stages.run('ledger-sync', () => stopLedgerSync());
    await stages.run('memory-sync', () => stopMemorySync());
    await stages.run('ledger-lifecycle', () => drainLedgerLifecycle());
    await stages
      .run('ledger-storage', () => shutdownLedgerStorageHost())
      .catch(() => undefined);
    // After every W5 writer above (including the workspace touch flush), so
    // no commit is refused or cut off at quit.
    if (__CANOPY_E2E__ && w5StoreArm) {
      const arm = w5StoreArm;
      await stages
        .run('w5-store-arm', () => arm.shutdown())
        .catch(() => undefined);
    }
    await stages
      .run('w5-commit-log', () => shutdownW5CommitLogHost())
      .catch(() => undefined);
    // A flip build's W5 sessions outlive the Files route until here.
    await stages.bestEffort('w5-daemon-handoff', disposeW5FlipHandoff);
    // Also closes the desktop integration server, which aliases this service.
    await stages.bestEffort('mcp-proxy', () =>
      getMcpHttpProxyService().shutdown(),
    );
    await stages.bestEffort('gateway-proxy', () =>
      getCodexGatewayProxyService().shutdown(),
    );
    stopUpdater();
    disposeResourceMonitorService();
    getWakeLockService().shutdown();
    await stages.bestEffort('memory-diagnostics', () =>
      getMemoryDiagnosticsService().dispose(),
    );
    await stages.bestEffort(
      'instrumentation-upload',
      flushDesktopInstrumentation,
    );
    await windowStateFlush;
    await appAdvisorWindowStateFlush;
    appAdvisorHost?.dispose();
    if (appAdvisorViewContents && !appAdvisorViewContents.isDestroyed()) {
      appAdvisorViewContents.close();
    }
    if (appAdvisorWindow && !appAdvisorWindow.isDestroyed()) {
      appAdvisorWindow.close();
    }
    await stages.run('preferences', flushPreferencesWrites);
    // Stop auto-reshares before observability disposes (it unsubscribes from
    // the observability event stream and clears pending debounce timers).
    getSharedRunAutoUpdater().shutdown();
    // Stop the shared-run comment poll for the same reason (it records session
    // diagnostics through observability).
    getSharedRunCommentPoller().shutdown();
    // A resolved blocker queues a clear and flushes immediately. Let that
    // operation finish before telemetry closes ingress for its final drain.
    const attentionTracker = getAttentionTracker();
    attentionTracker.dispose();
    await stages
      .run('attention-tracker', () => attentionTracker.drain())
      .catch(() => undefined);
    // Unsubscribes from observability and cancels pending signal retries.
    disposeProductActivityReporter();
    // Drain pending telemetry before observability disposes its sidecars.
    await stages
      .run('telemetry-outbox', () => getTelemetrySyncService().dispose())
      .catch(() => undefined);
    await stages.run('observability', () => {
      diagnosticsOpen = false;
      return getObservabilityService().dispose();
    });
    if (recoveryDrainFailures.length > 0) {
      throw new Error(
        `Application shutdown recovery drain failed: ${recoveryDrainFailures
          .map((result) => formatUnknownError(result.reason))
          .join('; ')}`,
      );
    }
    // Failed preparatory stages already reported and logged; rethrow the first.
    if (preparationFailures.length > 0) {
      const [failure] = preparationFailures;
      throw failure instanceof Error
        ? failure
        : new Error(formatUnknownError(failure));
    }
  });
  // Datadog starts Electron's Crashpad handler. On Linux it can outlive all
  // windows and app-owned children. Stop it last, on success or cleanup failure,
  // while the single-instance lock still protects this crash database.
  runtimeCleanupPromise = runtimeCleanupPromise.finally(
    async (): Promise<void> => {
      const hostOs = hostOperatingSystem();
      if (hostOs !== 'linux') return;
      await stages.bestEffort('linux-crashpad', () =>
        stopLinuxCrashpadHandlers({
          platform: hostOs,
          executablePath: process.execPath,
          crashDumpsPath: app.getPath('crashDumps'),
        }),
      );
    },
  );
  runtimeCleanupPromise = runtimeCleanupPromise.then(
    async (): Promise<void> => {
      // The OUTER runtime stage has emitted completed, including after observability.
      await drainMainProcessLogging();
      runtimeCleanupComplete = true;
      exitGuard.markCleanupComplete();
    },
    async (error: unknown): Promise<never> => {
      // Include the outer failed diagnostic and the final error before closing ingress.
      // eslint-disable-next-line no-console
      console.error(
        'Application shutdown could not save interrupted work:',
        error,
      );
      await drainMainProcessLoggingBestEffort(1000);
      throw error;
    },
  );
  return runtimeCleanupPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readPropertyString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

function getErrorCode(value: unknown): string | undefined {
  return readPropertyString(value, 'code');
}

function getErrorSyscall(value: unknown): string | undefined {
  return readPropertyString(value, 'syscall');
}

function exitAfterSignalCleanup(exitCode: number): void {
  if (signalExitStarted) {
    return;
  }

  signalExitStarted = true;
  void (async (): Promise<void> => {
    try {
      await Promise.race([
        cleanupRuntimeResources('fatal-exit').catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      process.exit(exitCode);
    }
  })();
}

if (hasSingleInstanceLock) {
  process.on('unhandledRejection', (reason: unknown): void => {
    // eslint-disable-next-line no-console
    console.error('Unhandled rejection in main process:', reason);
    recordMainProcessError(
      getObservabilityService(),
      'main_unhandled_rejection',
      reason,
    );
  });

  process.on('uncaughtException', (error: Error): void => {
    // EPIPE occurs when the Claude CLI subprocess dies and the SDK tries to write
    // to its closed stdin pipe. This is safe to continue after — the session's
    // normal error handling will detect the dead subprocess and clean up.
    if (getErrorCode(error) === 'EPIPE' && getErrorSyscall(error) === 'write') {
      // eslint-disable-next-line no-console
      console.warn('Ignored EPIPE from dead subprocess pipe:', error.message);
      return;
    }

    // For all other uncaught exceptions, log and crash (default Node.js behavior).
    // Once an uncaughtException handler is registered, Node.js no longer terminates
    // automatically — we must call process.exit for truly fatal errors.
    // eslint-disable-next-line no-console
    console.error('Fatal uncaught exception in main process:', error);
    recordMainProcessError(
      getObservabilityService(),
      'main_uncaught_exception',
      error,
    );
    void (async (): Promise<void> => {
      try {
        await Promise.race([
          Promise.allSettled([
            cleanupRuntimeResources('fatal-exit'),
            // The error above is already queued for PostHog; start its flush
            // now rather than after the earlier cleanup stages, so it can
            // finish inside the exit deadline. Idempotent with the stage's.
            flushDesktopInstrumentation(),
          ]),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 1000);
          }),
        ]);
      } finally {
        process.exit(1);
      }
    })();
  });

  process.on('SIGINT', (): void => {
    exitAfterSignalCleanup(130);
  });

  process.on('SIGTERM', (): void => {
    exitAfterSignalCleanup(143);
  });
}

function getIconPath(): string {
  if (is.dev) {
    const devResourcesPath = resolveDevResourcesPath();
    switch (process.platform) {
      case 'darwin':
        return join(devResourcesPath, 'icon-dev-256.png');
      case 'win32':
        return join(devResourcesPath, 'icon-dev-full.ico');
      default:
        return join(devResourcesPath, 'icon-dev.png');
    }
  }

  const resourcesPath = process.resourcesPath;

  switch (process.platform) {
    case 'darwin':
      return join(resourcesPath, 'icon.icns');
    case 'win32':
      return join(resourcesPath, 'icon-full.ico');
    default:
      return join(resourcesPath, 'icon.png');
  }
}

function resolveDevResourcesPath(): string {
  const candidates = [
    resolve(process.cwd(), 'apps/desktop-app/dev-resources'),
    resolve(process.cwd(), 'dev-resources'),
    resolve(__dirname, '../../dev-resources'),
    resolve(__dirname, '../../apps/desktop-app/dev-resources'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

async function writeWindowStateToPreferences(
  state: Pick<
    PreferencesData,
    'windowBounds' | 'windowMaximized' | 'windowFullScreen'
  >,
): Promise<void> {
  try {
    await writePreferencesFile(state);
  } catch {
    // Window state is opportunistic; a later preference save can recreate it.
  }
}

function saveWindowState(win: BrowserWindow): Promise<void> {
  const isMaximized = win.isMaximized();
  const isFullScreen = win.isFullScreen();
  const normalBounds = win.getNormalBounds();
  const bounds: WindowBounds = {
    x: normalBounds.x,
    y: normalBounds.y,
    width: normalBounds.width,
    height: normalBounds.height,
  };

  return writeWindowStateToPreferences({
    windowBounds: bounds,
    windowMaximized: isMaximized,
    windowFullScreen: isFullScreen,
  });
}

function debouncedSaveWindowState(win: BrowserWindow): void {
  if (windowStateSaveTimeout !== null) {
    clearTimeout(windowStateSaveTimeout);
  }
  windowStateSaveTimeout = setTimeout(() => {
    windowStateSaveTimeout = null;
    void saveWindowState(win);
  }, 500);
}

function cancelDebouncedSaveAndFlush(win: BrowserWindow): Promise<void> {
  if (windowStateSaveTimeout !== null) {
    clearTimeout(windowStateSaveTimeout);
    windowStateSaveTimeout = null;
  }
  return saveWindowState(win);
}

async function writeAppAdvisorWindowStateToPreferences(
  bounds: PreferencesData['appAdvisorDialogBounds'],
): Promise<void> {
  try {
    await writePreferencesFile({ appAdvisorDialogBounds: bounds });
  } catch {
    // Window state is opportunistic; a later preference save can recreate it.
  }
}

function saveAppAdvisorWindowState(win: BrowserWindow): Promise<void> {
  const normalBounds = win.getNormalBounds();
  return writeAppAdvisorWindowStateToPreferences({
    x: normalBounds.x,
    y: normalBounds.y,
    width: normalBounds.width,
    height: normalBounds.height,
  });
}

function debouncedSaveAppAdvisorWindowState(win: BrowserWindow): void {
  if (appAdvisorWindowStateSaveTimeout !== null) {
    clearTimeout(appAdvisorWindowStateSaveTimeout);
  }
  appAdvisorWindowStateSaveTimeout = setTimeout(() => {
    appAdvisorWindowStateSaveTimeout = null;
    void saveAppAdvisorWindowState(win);
  }, 500);
}

function cancelDebouncedAppAdvisorWindowStateAndFlush(
  win: BrowserWindow,
): Promise<void> {
  if (appAdvisorWindowStateSaveTimeout !== null) {
    clearTimeout(appAdvisorWindowStateSaveTimeout);
    appAdvisorWindowStateSaveTimeout = null;
  }
  return saveAppAdvisorWindowState(win);
}

function getAppAdvisorWindowState(): AppAdvisorWindowState {
  const win = appAdvisorWindow;
  const mainWindowOpen =
    mainWindow !== null && !mainWindow.isDestroyed() && !mainWindowPageDown;
  if (!win || win.isDestroyed()) {
    return { open: false, focused: false, layout: 'full', mainWindowOpen };
  }
  return {
    open: isAppAdvisorVisible(),
    mainWindowOpen,
    focused: isAppAdvisorFocused(),
    layout: currentAppAdvisorLayout(),
    floatingSize: appAdvisorFloatingSize,
    ...(appAdvisorHost
      ? { minimized: appAdvisorMinimized && !isAppAdvisorVisible() }
      : {}),
  };
}

/**
 * Resizes the floating panel from its own drag handles (early access). The
 * size is untrusted renderer input, so anything but finite numbers is
 * ignored; the rest is clamped to the allowed range, and the bounds cap it
 * to the main window.
 */
function setAppAdvisorFloatingSize(size: unknown): AppAdvisorWindowState {
  if (
    typeof size === 'object' &&
    size !== null &&
    'width' in size &&
    'height' in size &&
    typeof size.width === 'number' &&
    typeof size.height === 'number' &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height)
  ) {
    const next = clampAppAdvisorFloatingSize({
      width: size.width,
      height: size.height,
    });
    if (
      next.width !== appAdvisorFloatingSize.width ||
      next.height !== appAdvisorFloatingSize.height
    ) {
      appAdvisorFloatingSize = next;
      appAdvisorHost?.refit();
      broadcastAppAdvisorWindowState();
    }
  }
  return getAppAdvisorWindowState();
}

/** Whether App Advisor's page shows in the main window (panel or page). */
function appAdvisorInMainWindow(): boolean {
  const placement = appAdvisorHost?.placement;
  return placement === 'floating' || placement === 'docked';
}

/** Counts dock requests, so a capture that resolves late never wins. */
let appAdvisorDockRequestSeq = 0;

function isFiniteDockNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The main window's page reports where the docked Orchestrator page goes (its
 * content area, in the page's CSS px) and whether it may show. `request` is
 * untrusted renderer input, accepted only from the main window's page.
 * Before hiding the page for an overlay, the page asks for a still frame of
 * it to show in its place.
 */
async function setAppAdvisorDock(
  sender: WebContents,
  request: unknown,
): Promise<AppAdvisorDockResult> {
  const main = mainWindow;
  const host = appAdvisorHost;
  if (
    !main ||
    main.isDestroyed() ||
    sender !== main.webContents ||
    !host ||
    typeof request !== 'object' ||
    request === null ||
    !('rect' in request) ||
    !('visible' in request) ||
    typeof request.visible !== 'boolean'
  ) {
    return { state: getAppAdvisorWindowState() };
  }
  const { rect, visible } = request;
  const seq = ++appAdvisorDockRequestSeq;
  let dipRect: Electron.Rectangle | null = null;
  if (rect !== null) {
    if (
      typeof rect !== 'object' ||
      !('x' in rect) ||
      !('y' in rect) ||
      !('width' in rect) ||
      !('height' in rect) ||
      !isFiniteDockNumber(rect.x) ||
      !isFiniteDockNumber(rect.y) ||
      !isFiniteDockNumber(rect.width) ||
      !isFiniteDockNumber(rect.height)
    ) {
      return { state: getAppAdvisorWindowState() };
    }
    // The page reports CSS px; the view is placed in window DIPs, which
    // differ under the interface scale's zoom.
    const zoom = main.webContents.getZoomFactor();
    dipRect = {
      x: Math.round(rect.x * zoom),
      y: Math.round(rect.y * zoom),
      width: Math.max(0, Math.round(rect.width * zoom)),
      height: Math.max(0, Math.round(rect.height * zoom)),
    };
  }
  let frame: string | undefined;
  const contents = appAdvisorViewContents;
  if (
    'captureFrame' in request &&
    request.captureFrame === true &&
    host.placement === 'docked' &&
    contents &&
    !contents.isDestroyed()
  ) {
    try {
      const image = await contents.capturePage();
      if (!image.isEmpty()) frame = image.toDataURL();
    } catch {
      // No frame: the page shows its background meanwhile.
    }
    // A newer request (a closed page's teardown, a reopened page) arrived
    // during the capture: its state stands.
    if (seq !== appAdvisorDockRequestSeq) {
      return { state: getAppAdvisorWindowState() };
    }
  }
  host.setDock(dipRect, visible);
  return { state: getAppAdvisorWindowState(), ...(frame ? { frame } : {}) };
}

/**
 * The main page crashed or a main-frame reload committed. Main waits for the
 * new renderer before it delivers app links or notifications to it, and App
 * Advisor raises its own chat notifications until the page is back. Not on
 * `did-start-loading`: sub-frame loads (agent visuals, HTML previews) fire it
 * too, and treating them as a reload sent every later chat link to the system
 * browser.
 */
function markMainWindowPageDown(): void {
  mainWindowRendererReady = false;
  mainWindowPageDown = true;
  broadcastAppAdvisorWindowState();
}

function broadcastAppAdvisorWindowState(): void {
  const state = getAppAdvisorWindowState();
  sendToWindowDetailed(
    mainWindow,
    IPC_CHANNELS.appAdvisorWindowStateChanged,
    state,
  );
  sendToWindowDetailed(
    appAdvisorWindow,
    IPC_CHANNELS.appAdvisorWindowStateChanged,
    state,
  );
}

function sendAppAdvisorWindowCommand(command: AppAdvisorWindowCommand): void {
  if (
    appAdvisorWindow &&
    !appAdvisorWindow.isDestroyed() &&
    appAdvisorWindowReady
  ) {
    sendToWindowDetailed(
      appAdvisorWindow,
      IPC_CHANNELS.appAdvisorWindowCommand,
      command,
    );
    return;
  }

  // Selection intents are mutually exclusive — a newer one supersedes any
  // pending selection of every kind, not just its own type.
  const selectionCommandTypes = new Set<AppAdvisorWindowCommand['type']>([
    'select_chat',
    'select_entry',
    'open_archived_container',
    'open_archived_overview',
  ]);
  if (selectionCommandTypes.has(command.type)) {
    pendingAppAdvisorWindowCommands = pendingAppAdvisorWindowCommands.filter(
      (entry) => !selectionCommandTypes.has(entry.type),
    );
  }
  pendingAppAdvisorWindowCommands.push(command);
}

/**
 * Sends the renderer what an open request selects. Resolves to whether it
 * selects an archived chat, which only the full window shows.
 */
async function sendAppAdvisorWindowRequestCommands(
  request?: AppAdvisorWindowOpenRequest,
  send: (
    command: AppAdvisorWindowCommand,
  ) => void = sendAppAdvisorWindowCommand,
): Promise<{ readonly archivedChat: boolean }> {
  let archivedChat = false;
  if (request?.userMessageId && !request.chatId) {
    throw new Error('userMessageId requires chatId.');
  }
  if (request?.delegationId !== undefined && !request.chatId) {
    throw new Error('delegationId requires chatId.');
  }
  if (request?.chatId) {
    validateId(request.chatId, 'chatId');
    if (request.delegationId !== undefined) {
      validateId(request.delegationId, 'delegationId');
    }
    if (request.userMessageId) {
      validateId(request.userMessageId, 'userMessageId');
    }
    const resolution = await resolveWorkEntryForChat(
      APP_ADVISOR_PROJECT_ID,
      request.chatId,
    );
    const legacyArchives =
      !resolution.entryId && !resolution.archivedInEntryId
        ? await readChatArchivesFile(
            APP_ADVISOR_PROJECT_ID,
            APP_ADVISOR_WORKTREE_ID,
          )
        : null;
    const isLegacyArchive =
      legacyArchives?.archived.some(
        (entry) => entry.tab.id === request.chatId,
      ) === true;
    if (
      !resolution.entryId &&
      !resolution.archivedInEntryId &&
      !isLegacyArchive
    ) {
      throw new Error(`Unknown App Advisor chat ${request.chatId}.`);
    }
    archivedChat = !resolution.entryId;
    send({
      type: 'select_chat',
      chatId: request.chatId,
      ...(!archivedChat && request.delegationId !== undefined
        ? { delegationId: request.delegationId }
        : {}),
      ...(request.userMessageId
        ? { userMessageId: request.userMessageId }
        : {}),
    });
  }
  if (request?.workEntryId) {
    validateId(request.workEntryId, 'workEntryId');
    const entries = await listWorkEntries(APP_ADVISOR_PROJECT_ID);
    if (!entries.some((entry) => entry.id === request.workEntryId)) {
      throw new Error(`Unknown App Advisor work entry ${request.workEntryId}.`);
    }
    send({
      type: 'select_entry',
      entryId: request.workEntryId,
    });
  }
  if (request?.archivedContainer) {
    const { containerId, tab, chatId, planId } = request.archivedContainer;
    validateId(containerId, 'containerId');
    if (chatId) validateId(chatId, 'chatId');
    if (planId) validateId(planId, 'planId');
    // Throws on an unknown/uncommitted container, mirroring the chatId path.
    await readArchivedContainerManifest(APP_ADVISOR_PROJECT_ID, containerId);
    send({
      type: 'open_archived_container',
      containerId,
      ...(tab ? { tab } : {}),
      ...(chatId ? { chatId } : {}),
      ...(planId ? { planId } : {}),
    });
  }
  if (request?.archivedOverview) {
    if (request.archivedOverview.requestId) {
      validateId(request.archivedOverview.requestId, 'requestId');
    }
    send({
      type: 'open_archived_overview',
      ...(request.archivedOverview.openEmptyTrashConfirmation === true
        ? { openEmptyTrashConfirmation: true }
        : {}),
      ...(request.archivedOverview.requestId
        ? { requestId: request.archivedOverview.requestId }
        : {}),
    });
  }
  if (request?.newWorkEntry === true) {
    send({ type: 'new_entry' });
  }
  if (request?.openSettings === true) {
    send({ type: 'open_settings' });
  }
  if (request?.quickPrompt?.trim()) {
    const chatId = request.quickPromptChatId ?? randomUUID();
    const userMessageId = request.quickPromptUserMessageId ?? randomUUID();
    validateId(userMessageId, 'quickPromptUserMessageId');
    // A targeted Work Entry receives the new chat as-is: it is neither
    // retitled nor removed when the send fails.
    let entryId: string;
    let removeEntryOnFailure: boolean;
    let replaceActiveEmpty: boolean;
    if (request.quickPromptWorkEntryId) {
      validateId(request.quickPromptWorkEntryId, 'quickPromptWorkEntryId');
      const entries = await listWorkEntries(APP_ADVISOR_PROJECT_ID);
      if (
        !entries.some((entry) => entry.id === request.quickPromptWorkEntryId)
      ) {
        throw new Error(
          `Unknown App Advisor work entry ${request.quickPromptWorkEntryId}.`,
        );
      }
      entryId = request.quickPromptWorkEntryId;
      removeEntryOnFailure = false;
      replaceActiveEmpty = false;
    } else {
      const created = await createWorkEntry(APP_ADVISOR_PROJECT_ID, {
        id: chatId,
        createdAt: new Date().toISOString(),
        ...(request.quickPromptTitle?.trim()
          ? { title: request.quickPromptTitle.trim() }
          : {}),
      });
      entryId = created.entry.id;
      removeEntryOnFailure = !created.reusedExistingEmpty;
      replaceActiveEmpty = !created.reusedExistingEmpty;
      const sidebarGroupName = request.quickPromptSidebarGroupName;
      if (sidebarGroupName?.trim()) {
        try {
          await sidebarItemGroupsService.assignItemToNamedGroup({
            scope: { appAdvisor: true },
            itemId: created.entry.id,
            name: sidebarGroupName,
          });
        } catch {
          // Group names are user text; keep this best-effort log content-free.
          logMainProcessError('App Advisor sidebar group assignment failed', {
            operation: 'assign-sidebar-group',
          });
        }
      }
    }
    send({
      type: 'send_quick_prompt',
      // Resolved file-reference offsets belong to the untrimmed prompt.
      text: request.quickPromptFileReferences?.length
        ? request.quickPrompt
        : request.quickPrompt.trim(),
      ...(request.quickPromptFileReferences?.length
        ? { fileReferences: request.quickPromptFileReferences }
        : {}),
      ...(request.quickPromptPlanMode !== undefined
        ? { planMode: request.quickPromptPlanMode }
        : {}),
      entryId,
      removeEntryOnFailure,
      replaceActiveEmpty,
      ...(request.quickPromptTitle?.trim()
        ? { title: request.quickPromptTitle.trim() }
        : {}),
      chatId,
      userMessageId,
      ...(request.quickPromptModel ? { model: request.quickPromptModel } : {}),
      ...(request.quickPromptProviderType
        ? { providerType: request.quickPromptProviderType }
        : {}),
      ...(request.quickPromptModelConfig
        ? { modelConfig: request.quickPromptModelConfig }
        : {}),
      ...(request.quickPromptThinkingLevel
        ? { thinkingLevel: request.quickPromptThinkingLevel }
        : {}),
      ...(request.quickPromptPluginSelections
        ? { pluginSelections: request.quickPromptPluginSelections }
        : {}),
      ...(request.quickPromptPackageOverlay
        ? { packageOverlay: request.quickPromptPackageOverlay }
        : {}),
      ...(request.quickPromptApprovalMode
        ? { approvalMode: request.quickPromptApprovalMode }
        : {}),
      ...(request.quickPromptInitiationSource
        ? { initiationSource: request.quickPromptInitiationSource }
        : {}),
      ...(request.quickPromptAutomationName
        ? { automationName: request.quickPromptAutomationName }
        : {}),
    });
  }
  return { archivedChat };
}

function sendChatWindowCommand(command: ChatWindowCommand): boolean {
  const delivery = sendToWindowDetailed(
    mainWindow,
    IPC_CHANNELS.chatWindowCommand,
    command,
  );
  return delivery.delivered;
}

function flushPendingAppAdvisorWindowCommands(): void {
  const commands = pendingAppAdvisorWindowCommands;
  pendingAppAdvisorWindowCommands = [];
  for (const command of commands) {
    sendAppAdvisorWindowCommand(command);
  }
}

function scheduleAppAdvisorAskUserRedelivery(win: BrowserWindow): void {
  setTimeout(() => {
    if (
      appAdvisorWindow !== win ||
      win.isDestroyed() ||
      !appAdvisorWindowReady
    ) {
      return;
    }
    redeliverPendingAppAdvisorAskUserRequests(getAppAdvisorWindow);
  }, 0);
}

function isAllowedRendererFrameNavigation(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'about:') {
      return true;
    }

    const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
    if (is.dev && devServerUrl) {
      return parsed.origin === new URL(devServerUrl).origin;
    }
  } catch {
    // Malformed URL — fall through to block
  }
  return false;
}

function markAppAdvisorWindowRendererReady(
  sender?: WebContents,
): AppAdvisorWindowState {
  const win = appAdvisorWindow;
  if (
    !win ||
    win.isDestroyed() ||
    sender !== rendererContentsOf(win.webContents)
  ) {
    return getAppAdvisorWindowState();
  }
  appAdvisorWindowReady = true;
  flushPendingAppAdvisorWindowCommands();
  scheduleAppAdvisorAskUserRedelivery(win);
  return getAppAdvisorWindowState();
}

function sendAutoArchiveNotification(
  window: RendererSurfaceWindow,
  notification: AutoArchiveNotification,
): void {
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    sendToWebContents(
      window.webContents,
      IPC_CHANNELS.autoArchiveCompleted,
      notification,
    );
  }
}

function flushPendingAutoArchiveNotifications(): void {
  const win = mainWindow;
  if (
    !mainWindowRendererReady ||
    !win ||
    win.isDestroyed() ||
    win.webContents.isDestroyed()
  ) {
    return;
  }
  const notifications = pendingAutoArchiveNotifications;
  pendingAutoArchiveNotifications = [];
  for (const notification of notifications) {
    sendAutoArchiveNotification(win, notification);
  }
}

function publishAutoArchiveNotification(
  notification: AutoArchiveNotification,
): void {
  const win = mainWindow;
  if (
    !mainWindowRendererReady ||
    !win ||
    win.isDestroyed() ||
    win.webContents.isDestroyed()
  ) {
    pendingAutoArchiveNotifications.push(notification);
  } else {
    sendAutoArchiveNotification(win, notification);
  }
  const advisorWindow = appAdvisorWindow;
  if (appAdvisorWindowReady && advisorWindow) {
    sendAutoArchiveNotification(advisorWindow, notification);
  }
}

function configureSafeNavigation(
  win: RendererSurfaceWindow,
  overlayLayerWindow?: BrowserWindow,
): void {
  win.webContents.setWindowOpenHandler((details) => {
    // A page that hosts Browser views in `overlayLayerWindow` may open its
    // own recognized same-origin layers there, as the main renderer does.
    if (overlayLayerWindow && !overlayLayerWindow.isDestroyed()) {
      const slot = decideOverlayLayerWindowOpen(
        details,
        win.webContents.id,
        win.webContents.id,
      );
      if (slot) {
        return overlayLayerHost.createWindowOpenResponse(
          overlayLayerWindow,
          slot,
          win.webContents,
        );
      }
    }
    const safeSchemes = new Set(['http:', 'https:', 'mailto:']);
    try {
      const parsed = new URL(details.url);
      if (safeSchemes.has(parsed.protocol)) {
        void routeSafeNavigation({
          url: details.url,
          sender: win.webContents,
          source: 'app-link',
        }).catch(() => undefined);
      }
    } catch {
      // Malformed URL — do not open
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url): void => {
    const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
    if (is.dev && devServerUrl) {
      try {
        if (new URL(url).origin === new URL(devServerUrl).origin) {
          return;
        }
      } catch {
        // Malformed URL — fall through to block
      }
    }
    event.preventDefault();
    const safeSchemes = new Set(['http:', 'https:', 'mailto:']);
    try {
      const parsed = new URL(url);
      if (safeSchemes.has(parsed.protocol)) {
        void routeSafeNavigation({
          url,
          sender: win.webContents,
          source: 'app-link',
        }).catch(() => undefined);
      }
    } catch {
      // Malformed URL — do not open
    }
  });

  win.webContents.on('will-frame-navigate', (details): void => {
    if (details.isMainFrame || isAllowedRendererFrameNavigation(details.url)) {
      return;
    }
    details.preventDefault();
  });
}

/**
 * Destroys the App Advisor window and waits for its `closed` cleanup, so a
 * replacement starts from no window.
 */
function destroyAppAdvisorWindow(win: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    win.once('closed', () => resolve());
    win.destroy();
  });
}

/**
 * Early access: resolves once App Advisor's page has painted `layout` at
 * `size` (DIP), or after {@link APP_ADVISOR_PAINT_WAIT_MS}.
 */
function whenAppAdvisorPainted(
  contents: WebContents,
  layout: AppAdvisorWindowLayout,
  size: { width: number; height: number },
): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve();
  const probe = appAdvisorPaintProbe({
    layout,
    size,
    zoom: contents.getZoomFactor(),
    waitMs: APP_ADVISOR_PAINT_WAIT_MS,
  });
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, APP_ADVISOR_PAINT_WAIT_MS);
    contents
      .executeJavaScript(probe)
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

async function createAppAdvisorWindowIfMissing(
  openLayout?: AppAdvisorWindowLayout,
): Promise<BrowserWindow> {
  const existing =
    appAdvisorWindow && !appAdvisorWindow.isDestroyed()
      ? appAdvisorWindow
      : null;
  // The early access switch changed since the window was made: a hidden,
  // idle window is remade in the current mode, either way.
  const remake =
    existing !== null &&
    shouldRemakeAppAdvisorWindow({
      hostsView: appAdvisorHost !== null,
      earlyAccess: true,
      visible: isAppAdvisorVisible(),
      turnsActive: hasActiveChatTurnsForProject(APP_ADVISOR_PROJECT_ID),
      unsentDraft: getLatestAppAdvisorWindowUiState().hasUnsentDraft === true,
    });
  if (existing && !remake) {
    return existing;
  }
  if (appAdvisorWindowCreating) {
    return appAdvisorWindowCreating;
  }

  appAdvisorWindowCreating = (async (): Promise<BrowserWindow> => {
    if (existing && !existing.isDestroyed()) {
      await destroyAppAdvisorWindow(existing);
    }
    await initializeAppAdvisorWorkspace();
    const preferences = await readPreferencesFile();
    const minimum = scaledMinimumSize(
      APP_ADVISOR_MIN_SIZE,
      uiScaleToZoomFactor(preferences.uiScale),
      workAreaForBounds(preferences.appAdvisorDialogBounds),
    );
    const validatedBounds = validateWindowBounds(
      preferences.appAdvisorDialogBounds,
      { minWidth: minimum.width, minHeight: minimum.height },
    );
    const initialWidth =
      validatedBounds?.width ??
      Math.max(
        minimum.width,
        Math.min(
          DEFAULT_WINDOW_WIDTH,
          screen.getPrimaryDisplay().workArea.width,
        ),
      );
    const windowOptions: Electron.BrowserWindowConstructorOptions = {
      width: initialWidth,
      height: Math.max(validatedBounds?.height ?? 680, minimum.height),
      minWidth: minimum.width,
      minHeight: minimum.height,
      show: false,
      title: ORCHESTRATOR_LABEL,
      icon: getIconPath(),
      ...getWindowTitleBarOptions({
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: appAdvisorWindowButtonPosition(
          uiScaleToZoomFactor(preferences.uiScale),
        ),
      }),
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        spellcheck: true,
        // Interface scale as a uniform zoom, in effect before the first paint.
        ...uiZoomWebPreferences(preferences.uiScale),
      },
    };

    if (validatedBounds) {
      windowOptions.x = validatedBounds.x;
      windowOptions.y = validatedBounds.y;
    }

    const win = new BrowserWindow(windowOptions);
    // The renderer is a view that `appAdvisorHost` moves
    // between this window and a floating panel in the main window, so the
    // page (and its chats) survives every move. This window's own page stays
    // blank and hosts App Advisor's browser panels.
    // Its page renders the layout it opens in from its first frame: floating
    // unless asked for the full window, or without a main window to float
    // in.
    const initialLayout: AppAdvisorWindowLayout =
      openLayout === 'full' || !mainWindow || mainWindow.isDestroyed()
        ? 'full'
        : openLayout === 'docked'
          ? 'docked'
          : 'floating';
    const view = new WebContentsView({
      webPreferences: {
        ...windowOptions.webPreferences,
        additionalArguments: [appAdvisorInitialLayoutArgument(initialLayout)],
      },
    });
    // The only read of the view's page (see `appAdvisorViewContents`).
    const contents = view?.webContents ?? win.webContents;
    const rendererSurface: RendererSurfaceWindow = view
      ? {
          isDestroyed: (): boolean => contents.isDestroyed(),
          webContents: contents,
        }
      : win;
    // Transparent behind the page: the floating panel rounds its own corners
    // in CSS, so they match the shadow the main window draws behind it (a
    // native corner clip uses a different curve). The full layout's page
    // paints its own background.
    view?.setBackgroundColor('#00000000');
    if (view) {
      // The page lives in the view, which no `browser-window-created` hook
      // reaches: give it the windows' input guards and text-field menu, the
      // menu over whichever window holds the page when it opens.
      attachInputGuardsToContents(contents);
      attachEditableContextMenuToContents(contents, () =>
        appAdvisorInMainWindow() ? mainWindow : win,
      );
      attachLinkContextMenuToContents(
        contents,
        () => (appAdvisorInMainWindow() ? mainWindow : win),
        linkContextMenuDeps(contents),
      );
    }
    appAdvisorViewContents = view ? contents : null;
    appAdvisorPanelZoom = uiScaleToZoomFactor(preferences.uiScale);
    const stopHostingRenderer = view
      ? hostRendererInView(win.webContents, () =>
          contents.isDestroyed() ? null : contents,
        )
      : null;
    if (view) {
      const host = new AppAdvisorViewHost<WebContentsView, BrowserWindow>({
        view,
        shell: win,
        getMainWindow: (): BrowserWindow | null => mainWindow,
        floatingBounds: (content): Electron.Rectangle =>
          floatingAppAdvisorBounds(
            content,
            appAdvisorPanelZoom,
            appAdvisorFloatingSize,
          ),
        onPlacementChange: broadcastAppAdvisorWindowState,
        whenPainted: (layout, size): Promise<void> =>
          whenAppAdvisorPainted(contents, layout, size),
      });
      appAdvisorHost = host;
      // Hidden until opened, where it opens: at the floating panel's place
      // in the main window, else in the hidden full window like the page it
      // replaces.
      if (initialLayout === 'full' || !host.park()) host.showFull();
      registerUiZoomContents(contents, (zoom): void => {
        appAdvisorPanelZoom = zoom;
        host.refit();
      });
      // The panel's focus follows its page, not the main window's.
      contents.on('focus', broadcastAppAdvisorWindowState);
      contents.on('blur', broadcastAppAdvisorWindowState);
    }
    registerIpcSurface(contents, 'app-advisor');
    // Later interface-scale changes rescale the minimum from its 100% value.
    registerUiZoomMinimumSize(win, APP_ADVISOR_MIN_SIZE);
    // The header row zooms as a whole, so the lights follow its centre line.
    registerUiZoomWindowButtons(win, appAdvisorWindowButtonPosition);
    appAdvisorWindow = win;
    appAdvisorWindowReady = false;

    win.on('resize', () => {
      if (!win.isDestroyed()) debouncedSaveAppAdvisorWindowState(win);
    });
    win.on('move', () => {
      if (!win.isDestroyed()) debouncedSaveAppAdvisorWindowState(win);
    });
    win.on('show', broadcastAppAdvisorWindowState);
    win.on('hide', broadcastAppAdvisorWindowState);
    win.on('focus', broadcastAppAdvisorWindowState);
    win.on('blur', broadcastAppAdvisorWindowState);
    win.on('minimize', broadcastAppAdvisorWindowState);
    win.on('restore', broadcastAppAdvisorWindowState);
    win.on('hide', () => {
      void cancelDebouncedAppAdvisorWindowStateAndFlush(win);
    });
    win.on('close', (event) => {
      if (appIsQuitting) {
        return;
      }
      event.preventDefault();
      void cancelDebouncedAppAdvisorWindowStateAndFlush(win);
      win.hide();
      broadcastAppAdvisorWindowState();
    });
    win.on('closed', () => {
      if (appAdvisorWindow === win) {
        appAdvisorWindow = null;
        appAdvisorMinimized = false;
        appAdvisorHost?.dispose();
        appAdvisorHost = null;
        stopHostingRenderer?.();
        if (view && !contents.isDestroyed()) contents.close();
        appAdvisorViewContents = null;
      }
      if (appAdvisorWindowStateSaveTimeout !== null) {
        clearTimeout(appAdvisorWindowStateSaveTimeout);
        appAdvisorWindowStateSaveTimeout = null;
      }
      pendingAppAdvisorWindowCommands = [];
      appAdvisorWindowReady = false;
      broadcastAppAdvisorWindowState();
    });

    // The full Orchestrator page sits under its own Browser views, so its
    // toasts lift into a notifications layer above them, as the main
    // window's do. The layer lives in this window: the page has Browser
    // views only here.
    configureSafeNavigation(rendererSurface, view ? win : undefined);
    if (view) {
      overlayLayerHost.observeWindow(win);
      overlayLayerHost.observeOpener(contents);
    }

    contents.on('did-finish-load', (): void => {
      appAdvisorWindowReady = false;
      if (view) {
        reassertUiZoomAfterLoadForContents(contents);
      } else {
        reassertUiZoomAfterLoad(win);
      }
    });

    contents.on(
      'did-fail-load',
      (
        _event,
        errorCode,
        errorDescription,
        _validatedURL,
        isMainFrame,
      ): void => {
        if (!isMainFrame || errorCode === -3) return;
        getObservabilityService().recordAppDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'renderer_did_fail_load',
          reason: `app_advisor_window:${errorDescription} (code ${String(
            errorCode,
          )})`,
        });
      },
    );

    contents.on('console-message', (details): void => {
      if (
        details.level !== 'error' &&
        details.level !== 'warning' &&
        !details.message.startsWith('[renderer]')
      ) {
        return;
      }
      if (details.level === 'error' || details.level === 'warning') {
        getObservabilityService().recordAppDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind:
            details.level === 'error'
              ? 'renderer_console_error'
              : 'renderer_console_warning',
          reason: `app_advisor_window:${details.message}`,
          ...(details.sourceId ? { sourceId: details.sourceId } : {}),
          ...(details.lineNumber > 0 ? { lineNumber: details.lineNumber } : {}),
        });
      }
    });

    contents.on('render-process-gone', (_event, details): void => {
      appAdvisorWindowReady = false;
      getExecutionObservabilityIngest().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'renderer_process_gone',
        reason: `app_advisor_window:${details.reason}`,
        exitCode: details.exitCode,
        rendererSurface: 'app_advisor_window',
      });

      if (
        details.reason === 'clean-exit' ||
        appIsQuitting ||
        appAdvisorRendererRecoveryReloadPending ||
        win.isDestroyed()
      ) {
        return;
      }

      appAdvisorRendererRecoveryReloadPending = true;
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'renderer_reload_scheduled',
        reason: `app_advisor_window:${details.reason}`,
        exitCode: details.exitCode,
      });
      setTimeout((): void => {
        appAdvisorRendererRecoveryReloadPending = false;
        if (
          appIsQuitting ||
          win.isDestroyed() ||
          contents.isDestroyed() ||
          // The renderer-scheme fail-safe is reloading this window.
          rendererOrigin.fallbackInProgress()
        ) {
          return;
        }
        contents.once('did-finish-load', (): void => {
          getObservabilityService().recordAppDiagnostic({
            version: 1,
            timestamp: new Date().toISOString(),
            kind: 'renderer_reload_finished',
            reason: 'app_advisor_window',
          });
        });
        getObservabilityService().recordAppDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'renderer_reload_started',
          reason: 'app_advisor_window',
        });
        contents.reload();
      }, 250);
    });

    contents.on('unresponsive', (): void => {
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'renderer_unresponsive',
        reason: 'app_advisor_window:unresponsive',
      });
    });

    contents.on('responsive', (): void => {
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'renderer_responsive',
        reason: 'app_advisor_window:responsive',
      });
    });

    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      // The page loads in the panel's view under early access, else in the
      // window itself, as before.
      await (view ? contents : win).loadURL(
        appAdvisorDevServerUrl(process.env['ELECTRON_RENDERER_URL']),
      );
    } else {
      // Today's file:// page, or the renderer scheme behind Settings →
      // Labs → "Open windows faster". Either way the load waits for
      // any storage copy between the two origins to finish.
      await rendererOrigin.loadWindow({
        surface: 'app-advisor',
        window: view
          ? {
              isDestroyed: (): boolean => contents.isDestroyed(),
              loadURL: (url: string): Promise<void> => contents.loadURL(url),
              loadFile: (
                filePath: string,
                options?: { search?: string },
              ): Promise<void> => contents.loadFile(filePath, options),
              webContents: contents,
            }
          : win,
      });
    }

    return win;
  })().finally(() => {
    appAdvisorWindowCreating = null;
  });

  return appAdvisorWindowCreating;
}

/**
 * Early access: puts the App Advisor renderer where an open request leaves it
 * (see `resolveAppAdvisorWindowLayout`). Floating shows it as a panel inside
 * the main window, hiding the full window if it was showing; full moves it
 * back into the full window, which the caller shows. Returns the layout,
 * `superseded` when a newer move (a close, another open) replaced this one
 * while the panel painted, so the caller shows nothing, or null when the
 * window was made without early access (the window is the renderer, always
 * full).
 */
async function applyAppAdvisorWindowLayout(
  win: BrowserWindow,
  requested: AppAdvisorWindowLayout | undefined,
): Promise<AppAdvisorWindowLayout | 'superseded' | null> {
  const host = appAdvisorHost;
  if (!host) return null;
  const layout = resolveAppAdvisorWindowLayout({
    requested,
    current: currentAppAdvisorLayout(),
    visible: isAppAdvisorVisible(),
    // The live switch: turned off since this window was made, and it was
    // not remade (it was showing or running a turn), App Advisor goes back
    // to its full window.
    earlyAccess: true,
  });
  if (layout === 'floating' || layout === 'docked') {
    if (host.placement === layout) return layout;
    if (win.isVisible()) {
      await cancelDebouncedAppAdvisorWindowStateAndFlush(win);
      win.hide();
    }
    if (layout === 'docked') {
      // The main window's page then reports where the page goes.
      if (host.showDocked()) return 'docked';
    } else {
      const shown = appAdvisorLayoutAfterFloatingShow(
        await host.showFloating(),
      );
      if (shown !== 'full') return shown;
    }
  }
  host.showFull();
  return 'full';
}

/**
 * Shows the main window for the floating panel inside it, without taking OS
 * focus from another app for a background request (CAN-1993).
 */
function presentAppAdvisorPanel(request?: AppAdvisorWindowOpenRequest): void {
  const main = mainWindow;
  if (!main || main.isDestroyed() || !shouldShowUiAutomationWindow()) return;
  if (main.isMinimized()) main.restore();
  if (request?.background && !isAppFrontmost()) {
    if (!main.isVisible()) main.showInactive();
    return;
  }
  if (!main.isVisible()) main.show();
  if (request?.focus !== false) {
    main.focus();
    appAdvisorHost?.focus();
  }
}

async function openAppAdvisorWindow(
  request?: AppAdvisorWindowOpenRequest,
): Promise<AppAdvisorWindowState> {
  const win = await createAppAdvisorWindowIfMissing(
    appAdvisorRequestedLayout(request),
  );
  const { archivedChat } = await sendAppAdvisorWindowRequestCommands(request);
  appAdvisorMinimized = false;
  const layout = await applyAppAdvisorWindowLayout(
    win,
    appAdvisorRequestedLayout(request, {
      archivedChat,
      docked: appAdvisorHost?.placement === 'docked',
    }),
  );
  if (layout === 'superseded') {
    // A close (or another open) replaced this one while the panel painted;
    // that move decided what shows.
  } else if (layout === 'floating' || layout === 'docked') {
    presentAppAdvisorPanel(request);
  } else if (shouldShowUiAutomationWindow()) {
    // Keep UI-automation windows hidden/unfocused (still scriptable) so both
    // E2E and unpackaged release-like suites stay headless by default.
    if (request?.background && !isAppFrontmost()) {
      // CAN-1993: an agent or automation asked for the window while the user
      // is in another application. `show()` is `activateIgnoringOtherApps:YES`
      // on macOS and would yank this app in front of theirs, so only make the
      // window visible; it comes forward when they return on their own.
      if (win.isMinimized()) {
        win.restore();
      }
      if (!win.isVisible()) {
        win.showInactive();
      }
    } else {
      win.show();
      if (win.isMinimized()) {
        win.restore();
      }
      if (request?.focus !== false) {
        win.focus();
        if (typeof win.moveTop === 'function') {
          win.moveTop();
        }
        appAdvisorHost?.focus();
      }
    }
  }
  if (request?.focusComposer === true) {
    sendAppAdvisorWindowCommand({ type: 'focus_composer' });
  }
  broadcastAppAdvisorWindowState();
  return getAppAdvisorWindowState();
}

async function ensureAppAdvisorWindow(
  request?: AppAdvisorWindowOpenRequest,
): Promise<AppAdvisorWindowState> {
  await createAppAdvisorWindowIfMissing();
  await sendAppAdvisorWindowRequestCommands(request);
  return getAppAdvisorWindowState();
}

async function closeAppAdvisorWindow(
  options?: unknown,
): Promise<AppAdvisorWindowState> {
  const win = appAdvisorWindow;
  if (!win || win.isDestroyed()) {
    return { open: false, focused: false, layout: 'full' };
  }
  appAdvisorMinimized = appAdvisorCloseLeavesBubble({
    options,
    floating: appAdvisorHost?.placement === 'floating',
  });
  if (
    appAdvisorHost?.placement === 'floating' ||
    appAdvisorHost?.placement === 'docked'
  ) {
    appAdvisorHost.hide();
  } else {
    await cancelDebouncedAppAdvisorWindowStateAndFlush(win);
    win.hide();
  }
  broadcastAppAdvisorWindowState();
  return getAppAdvisorWindowState();
}

async function toggleAppAdvisorWindow(
  request?: AppAdvisorWindowOpenRequest,
): Promise<AppAdvisorWindowState> {
  if (isAppAdvisorVisible()) {
    return closeAppAdvisorWindow();
  }
  return openAppAdvisorWindow({ ...request, focus: true });
}

/**
 * Re-asserts the persisted interface scale as the window's zoom after a
 * (re)load. `webPreferences.zoomFactor` already zooms the first navigation,
 * but Chromium also remembers a per-origin zoom level from earlier sessions
 * and prefers it at navigation time, so an externally edited or restored
 * `preferences.json` would otherwise not take effect until the next save.
 */
function reassertUiZoomAfterLoad(win: BrowserWindow): void {
  void readPreferencesFile()
    .then((prefs) => {
      applyUiZoomToWindow(win, uiScaleToZoomFactor(prefs.uiScale));
    })
    .catch(() => undefined);
}

/** {@link reassertUiZoomAfterLoad} for a page hosted in a view. */
function reassertUiZoomAfterLoadForContents(contents: WebContents): void {
  void readPreferencesFile()
    .then((prefs) => {
      if (!contents.isDestroyed()) {
        contents.setZoomFactor(uiScaleToZoomFactor(prefs.uiScale));
      }
    })
    .catch(() => undefined);
}

function createWindowWithState(preferences: PreferencesData): void {
  const minimum = scaledMinimumSize(
    MAIN_WINDOW_MIN_SIZE,
    uiScaleToZoomFactor(preferences.uiScale),
    workAreaForBounds(preferences.windowBounds),
  );
  const validatedBounds = validateWindowBounds(preferences.windowBounds, {
    minWidth: minimum.width,
    minHeight: minimum.height,
  });

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: Math.max(
      validatedBounds?.width ?? DEFAULT_WINDOW_WIDTH,
      minimum.width,
    ),
    height: Math.max(validatedBounds?.height ?? 900, minimum.height),
    minWidth: minimum.width,
    minHeight: minimum.height,
    // A hidden native Wayland surface may never receive the frame that emits
    // ready-to-show. Map Linux windows on creation so cold activation can paint.
    show: hostOperatingSystem() === 'linux' && shouldShowUiAutomationWindow(),
    // Mapping before first paint otherwise exposes Chromium's white canvas,
    // even when the persisted appearance is dark. Keep macOS vibrancy intact.
    ...(hostOperatingSystem() === 'linux'
      ? {
          backgroundColor: getMainWindowStartupBackgroundColor(
            preferences.theme,
            nativeTheme.shouldUseDarkColors,
          ),
        }
      : {}),
    title: BRAND.displayName,
    icon: getIconPath(),
    ...getWindowTitleBarOptions({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: macWindowButtonPosition(
        uiScaleToZoomFactor(preferences.uiScale),
      ),
    }),
    autoHideMenuBar: true,
    ...getMainWindowMaterialOptions(process.platform),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      spellcheck: true,
      ...getUiAutomationWindowWebPreferences(),
      // Interface scale as a uniform zoom, in effect before the first paint.
      ...uiZoomWebPreferences(preferences.uiScale),
    },
  };

  if (validatedBounds) {
    windowOptions.x = validatedBounds.x;
    windowOptions.y = validatedBounds.y;
  }

  mainWindowRendererReady = false;
  mainWindow = new BrowserWindow(windowOptions);
  const createdWindow = mainWindow;
  createdWindow.on('focus', (): void => {
    recordDesktopInstanceEvent({
      event: 'window-focused',
      windowId: createdWindow.id,
    });
  });
  primaryWindowFocus.track(mainWindow);
  registerIpcSurface(mainWindow.webContents, 'main');
  overlayLayerHost.observeWindow(mainWindow);
  overlayLayerHost.observeOpener(mainWindow.webContents);
  // A crashed, reloaded or destroyed renderer holds no edits and cannot answer
  // a pending unsaved-changes prompt, so the guard lets close and quit through.
  const releaseUnsavedCloseGuard = (): void => {
    unsavedCloseGuard.handleRendererGone();
  };
  mainWindow.webContents.on('render-process-gone', releaseUnsavedCloseGuard);
  // A full navigation (a reload) replaces the renderer and its edits, so a
  // pending prompt resolves as proceed. `did-navigate-in-page` keeps the
  // renderer, and with it the edits and the guard, so it is not listened to.
  mainWindow.webContents.on('did-navigate', releaseUnsavedCloseGuard);
  mainWindow.webContents.once('destroyed', releaseUnsavedCloseGuard);
  // Later interface-scale changes rescale the minimum from its 100% value.
  registerUiZoomMinimumSize(mainWindow, MAIN_WINDOW_MIN_SIZE);
  // Outside the zoom band where the titlebar row can hold the lights' fixed
  // centre, the row gives way and the lights move onto it instead.
  registerUiZoomWindowButtons(mainWindow, macWindowButtonPosition);

  if (preferences.windowMaximized) {
    mainWindow.maximize();
  }
  if (preferences.windowFullScreen) {
    mainWindow.setFullScreen(true);
  }

  // Window state tracking
  mainWindow.on('resize', () => {
    if (mainWindow) debouncedSaveWindowState(mainWindow);
  });
  mainWindow.on('move', () => {
    if (mainWindow) debouncedSaveWindowState(mainWindow);
  });
  mainWindow.on('maximize', () => {
    if (mainWindow) void saveWindowState(mainWindow);
  });
  mainWindow.on('unmaximize', () => {
    if (mainWindow) void saveWindowState(mainWindow);
  });
  mainWindow.on('enter-full-screen', () => {
    if (mainWindow) void saveWindowState(mainWindow);
  });
  mainWindow.on('leave-full-screen', () => {
    if (mainWindow) void saveWindowState(mainWindow);
  });
  // Abandonment anchor for the activation journey (CAN-1967). Focus is the
  // cheapest reliable "user is here" signal; the mutator is monotonic so a
  // burst of focus events costs one write at most.
  mainWindow.on('focus', () => {
    // Skip entirely while the journey is dark. The write is throttled to once
    // a minute but it is now fsynced, and paying that on every install for a
    // feature that cannot fire is not worth an anchor nobody reads. The
    // flag-flip handler writes a fresh anchor when the journey turns on, so a
    // continuously-focused session is not left without one.
    if (!isActivationJourneyEnabled()) return;
    // A changed anchor can make an abandonment campaign schedulable for the
    // first time, so the journey has to re-derive -- the first focus of a
    // fresh install lands after the journey's initial evaluation.
    void recordActivity(new Date().toISOString()).then((result) => {
      if (result.changed) requestActivationRecompute();
    });
  });

  mainWindow.on('ready-to-show', () => {
    // Linux is already mapped; do not undo a user's hide during startup.
    // Under UI automation, keep the window hidden so the suite runs truly
    // headless. Hidden Linux automation uses an offscreen compositor so
    // animation frames continue without a mapped X11 window.
    //
    // CANOPY_E2E_SHOW_WINDOW=1 opts a single run back into a visible window so a
    // seeded scenario can be looked at and clicked by hand. Only reachable from
    // an E2E or unpackaged release-like launch, and off unless explicitly set.
    if (hostOperatingSystem() === 'linux' || !shouldShowUiAutomationWindow()) {
      return;
    }
    mainWindow?.show();
  });

  // Close-to-tray must intercept `close`, not `closed`. Electron fires the
  // window's `closed` before the app's `window-all-closed`, so the quit below
  // used to run first and made the tray branch in `window-all-closed`
  // unreachable -- the app quit on Windows regardless of the preference, after
  // showing a balloon promising it had not. Hiding instead of destroying also
  // keeps `mainWindow` non-null, which is what `focusMainWindow()`, the
  // `second-instance` handler, and the tray's open action all assume.
  mainWindow.on('close', (event) => {
    if (appIsQuitting) return;
    let closesToTray = true;
    if (process.platform === 'darwin') {
      closesToTray = false;
    } else if (
      shouldQuitOnAllWindowsClosed({
        platform: process.platform,
        closeToTray: isCloseToTrayEnabled(),
      })
    ) {
      closesToTray = false;
    }
    // Hiding to the tray keeps the renderer and its edits, so only a real
    // close asks about unsaved changes.
    const closingWindow = mainWindow;
    if (
      unsavedCloseGuard.intercept(
        event,
        'close',
        { quitting: appIsQuitting, hidingToTray: closesToTray },
        (): void => {
          if (closingWindow && !closingWindow.isDestroyed()) {
            closingWindow.close();
          }
        },
      )
    ) {
      return;
    }
    if (mainWindow) void cancelDebouncedSaveAndFlush(mainWindow);
    if (!closesToTray) return;
    event.preventDefault();
    mainWindow?.hide();
    maybeDiscloseCloseToTray();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    mainWindowRendererReady = false;
    // This listener runs before the floating host's own closed listener.
    if (appAdvisorHost?.layout === 'floating') appAdvisorHost.dispose();
    // No renderer is left to place a link (CAN-2632).
    setLinkBrowserTargetAvailable(false);
    // App Advisor now raises its own chat notifications.
    broadcastAppAdvisorWindowState();
    if (
      !appIsQuitting &&
      shouldQuitOnAllWindowsClosed({
        platform: process.platform,
        closeToTray: isCloseToTrayEnabled(),
      })
    ) {
      app.quit();
    }
  });

  const panelClipboardWriters = new WeakSet<WebContents>();
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      if (permission === 'clipboard-sanitized-write') {
        const pages = rendererOrigin.trustedRendererPageUrls();
        const devUrl = is.dev
          ? process.env['ELECTRON_RENDERER_URL']
          : undefined;
        if (devUrl) {
          pages.push(new URL(MAIN_WINDOW_RENDERER_PAGE, devUrl).href);
          pages.push(appAdvisorDevServerUrl(devUrl));
        }
        callback(
          allowsRendererClipboardWrite(
            webContents,
            details,
            pages,
            devUrl,
            panelClipboardWriters.has(webContents),
          ),
        );
        return;
      }
      // Voice dictation is the only renderer feature that requests media.
      // Grant microphone-only access, deny everything else (including video).
      if (permission !== 'media' || !('mediaTypes' in details)) {
        callback(false);
        return;
      }
      if (process.platform !== 'darwin') {
        callback(false);
        return;
      }
      const mediaTypes = details.mediaTypes ?? [];
      const isAudioOnly =
        mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
      if (!isAudioOnly) {
        callback(false);
        return;
      }
      callback(
        systemPreferences.getMediaAccessStatus('microphone') === 'granted',
      );
    },
  );

  const layerOpenerWindow = mainWindow;
  mainWindow.webContents.setWindowOpenHandler((details) => {
    // Only the main renderer may open a recognized same-origin layer.
    // Everything else falls through to the existing aux/deny-all policy.
    const openerWindow = mainWindow;
    if (openerWindow === layerOpenerWindow && !openerWindow.isDestroyed()) {
      const slot = decideOverlayLayerWindowOpen(
        details,
        layerOpenerWindow.webContents.id,
        openerWindow.webContents.id,
      );
      if (slot) {
        return overlayLayerHost.createWindowOpenResponse(openerWindow, slot);
      }
    }

    // Panel pull-outs retain their existing narrow about:blank allow path.
    const auxWebContentsId = mainWindow?.webContents.id;
    const auxDecision = decidePanelAuxWindowOpen(
      details,
      auxWebContentsId,
      auxWebContentsId,
      // The pull-out opens at the main window's interface scale.
      { zoomFactor: mainWindow?.webContents.getZoomFactor() },
    );
    if (auxDecision) {
      return auxDecision;
    }

    const safeSchemes = new Set(['http:', 'https:', 'mailto:']);
    try {
      const parsed = new URL(details.url);
      if (safeSchemes.has(parsed.protocol)) {
        void routeSafeNavigation({
          url: details.url,
          sender: mainWindowRendererReady
            ? (mainWindow?.webContents ?? null)
            : null,
          source: 'app-link',
        }).catch(() => undefined);
      }
    } catch {
      // Malformed URL — do not open
    }
    return { action: 'deny' };
  });

  // Harden every panel aux window the allow-path above creates: deny-all
  // nested window.open, pin navigation to about:blank, validate bounds.
  mainWindow.webContents.on('did-create-window', (childWindow, details) => {
    if (isPanelAuxWindowFrameName(details.frameName)) {
      registerIpcSurface(childWindow.webContents, 'aux');
      hardenPanelAuxWindow(childWindow, {
        routeAppLink: (url) =>
          routeSafeNavigation({
            url,
            sender: mainWindowRendererReady
              ? (mainWindow?.webContents ?? null)
              : null,
            source: 'app-link',
          }),
      });
      panelClipboardWriters.add(childWindow.webContents);
    }
  });

  mainWindow.webContents.on('did-finish-load', (): void => {
    if (mainWindow) reassertUiZoomAfterLoad(mainWindow);
  });
  // Branch enrollment's fallback when no projects:load follows first paint.
  mainWindow.webContents.once('did-finish-load', (): void => {
    setTimeout(
      startWorktreeBranchEnrollment,
      WORKTREE_BRANCH_ENROLLMENT_FALLBACK_MS,
    ).unref();
  });

  mainWindow.webContents.on('will-navigate', (event, url): void => {
    // Allow dev server reloads in development
    const devServerUrl = process.env['ELECTRON_RENDERER_URL'];
    if (is.dev && devServerUrl) {
      try {
        if (new URL(url).origin === new URL(devServerUrl).origin) {
          return;
        }
      } catch {
        // Malformed URL — fall through to block
      }
    }
    // Block all other navigations — open safe external URLs in the system browser
    event.preventDefault();
    const safeSchemes = new Set(['http:', 'https:', 'mailto:']);
    try {
      const parsed = new URL(url);
      if (safeSchemes.has(parsed.protocol)) {
        void routeSafeNavigation({
          url,
          sender: mainWindowRendererReady
            ? (mainWindow?.webContents ?? null)
            : null,
          source: 'app-link',
        }).catch(() => undefined);
      }
    } catch {
      // Malformed URL — do not open
    }
  });

  mainWindow.webContents.on('will-frame-navigate', (details): void => {
    // Opaque and srcdoc frames (agent visuals, HTML previews) may only load
    // their srcdoc; see subframe-navigation-guard.
    if (
      isAllowedMainWindowFrameNavigation(
        details,
        isAllowedRendererFrameNavigation,
      )
    ) {
      return;
    }
    details.preventDefault();
  });

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, _validatedURL, isMainFrame): void => {
      if (!isMainFrame || errorCode === -3) return;
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'renderer_did_fail_load',
        reason: `${errorDescription} (code ${String(errorCode)})`,
      });
      // eslint-disable-next-line no-console
      console.error(
        `Renderer failed to load: ${errorDescription} (code ${errorCode})`,
      );
    },
  );

  mainWindow.webContents.on('console-message', (details): void => {
    if (
      details.level !== 'error' &&
      details.level !== 'warning' &&
      !details.message.startsWith('[renderer]')
    ) {
      return;
    }

    const location =
      details.sourceId && details.lineNumber > 0
        ? ` (${details.sourceId}:${String(details.lineNumber)})`
        : '';
    if (details.level === 'error' || details.level === 'warning') {
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind:
          details.level === 'error'
            ? 'renderer_console_error'
            : 'renderer_console_warning',
        reason: details.message,
        ...(details.sourceId ? { sourceId: details.sourceId } : {}),
        ...(details.lineNumber > 0 ? { lineNumber: details.lineNumber } : {}),
      });
    }
    if (details.level === 'error') {
      // eslint-disable-next-line no-console
      console.error(
        `[renderer:${details.level}] ${details.message}${location}`,
      );
      return;
    }

    // eslint-disable-next-line no-console
    console.warn(`[renderer:${details.level}] ${details.message}${location}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details): void => {
    markMainWindowPageDown();
    // A crashed renderer leaves any split lock held in the plan-review phase
    // with an empty renderer mirror and no UI to clear it. Release every idle
    // split lock (locks with a main-side execute in flight are kept — that run
    // survives the crash and its approve settle releases them).
    releaseIdleSplitLocksForRendererLifecycle();

    getExecutionObservabilityIngest().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'renderer_process_gone',
      reason: details.reason,
      exitCode: details.exitCode,
      rendererSurface: 'main_window',
    });
    // eslint-disable-next-line no-console
    console.error('Renderer process gone', {
      reason: details.reason,
      exitCode: details.exitCode,
    });

    if (
      details.reason === 'clean-exit' ||
      appIsQuitting ||
      rendererRecoveryReloadPending ||
      !mainWindow ||
      mainWindow.isDestroyed()
    ) {
      return;
    }

    rendererRecoveryReloadPending = true;
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'renderer_reload_scheduled',
      reason: details.reason,
      exitCode: details.exitCode,
    });
    setTimeout((): void => {
      rendererRecoveryReloadPending = false;
      if (appIsQuitting || !mainWindow || mainWindow.isDestroyed()) {
        return;
      }
      // The renderer-scheme fail-safe is reloading this window on file://.
      if (rendererOrigin.fallbackInProgress()) return;
      if (mainWindow.webContents.isDestroyed()) {
        return;
      }
      mainWindow.webContents.once('did-finish-load', (): void => {
        getObservabilityService().recordAppDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'renderer_reload_finished',
        });
      });
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'renderer_reload_started',
      });
      // A gone renderer leaves the window blank; reloading mirrors the manual
      // Cmd+R recovery while preserving the main process and worktree sessions.
      mainWindow.webContents.reload();
    }, 250);
  });

  mainWindow.webContents.on('did-navigate', (): void => {
    // `did-navigate` only fires once a main-frame, cross-document navigation
    // has actually COMMITTED (manual Cmd+R, recovery reload, or dev-server
    // HMR full reload) — same-document (in-page) navigations, subframe
    // navigations, and navigations that get prevented/cancelled never emit
    // it, so unlike `did-start-navigation` there is no `isMainFrame`/
    // `isSameDocument` payload to check here; the event itself already
    // encodes that guard. This is the more precise seam: it is immune to a
    // navigation that starts but is prevented (e.g. by a will-navigate
    // handler) from ever releasing a lock a still-live renderer still holds.
    // The renderer's mirrored split-lock set is reset by a committed reload,
    // so release every idle split lock here to keep lock state truthful.
    // Locks with a main-side execute in flight are kept (that run survives
    // the reload; approve's settle releases them).
    releaseIdleSplitLocksForRendererLifecycle();
    // The reloaded renderer republishes its link target once it starts. Not
    // on `did-start-loading`, which sub-frame loads also fire (CAN-2632).
    setLinkBrowserTargetAvailable(false);
    // Also clears renderer readiness until the new page reports startup.
    markMainWindowPageDown();
  });

  mainWindow.on('unresponsive', (): void => {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'renderer_unresponsive',
    });
  });

  mainWindow.on('responsive', (): void => {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'renderer_responsive',
    });
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    // Today's file:// page, or the renderer scheme behind Settings →
    // Labs → "Open windows faster". Either way the load waits for any
    // storage copy between the two origins to finish, so a window the tray
    // or the global shortcut opens during startup loads on the final origin.
    void rendererOrigin.loadWindow({ surface: 'main', window: mainWindow });
  }
}

/** The renderer output directory both windows load from. */
const RENDERER_DIR = join(__dirname, '../renderer');

/**
 * Per-installation record of the renderer origin, kept beside the storage it
 * describes: Chromium's origin-keyed storage lives in Electron's
 * `sessionData` (the `userData` directory at ready; E2E's later `userData`
 * redirect does not move it). App metadata, never a worktree checkout.
 */
function rendererOriginRecordFile(): string {
  return join(app.getPath('sessionData'), RENDERER_ORIGIN_RECORD_FILE);
}
const rendererOriginRecordStore: RendererOriginRecordStore = {
  read: async () =>
    createFileRendererOriginRecordStore(rendererOriginRecordFile()).read(),
  write: async (record) =>
    createFileRendererOriginRecordStore(rendererOriginRecordFile()).write(
      record,
    ),
};

function recordRendererOriginDiagnostic(event: RendererOriginDiagnostic): void {
  const timestamp = new Date().toISOString();
  if (event.kind === 'migrated') {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp,
      kind: 'renderer_origin_storage_migrated',
      reason: `${event.from}->${event.to}:${event.outcome}:keys=${String(
        event.keyCount,
      )}:indexeddb=${String(event.indexedDbCount)}`,
    });
    return;
  }
  if (event.kind === 'migration-failed') {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp,
      kind: 'renderer_origin_storage_migration_failed',
      reason: `${event.from}->${event.to}`,
      error: event.error,
    });
    return;
  }
  getObservabilityService().recordAppDiagnostic({
    version: 1,
    timestamp,
    kind: 'renderer_code_cache_scheme_fallback',
    reason: `${event.reason}:storage_migrated=${String(event.storageMigrated)}`,
    ...(event.detail ? { error: event.detail } : {}),
  });
  // eslint-disable-next-line no-console
  console.warn(
    `Renderer scheme fell back to file:// (${event.reason}); the experiment was turned off.`,
  );
}

/**
 * The renderer's origin for this launch: today's `file://`, or the
 * privileged code-cache scheme when Settings → Labs → "Open windows
 * faster" is on. See `renderer-origin/renderer-origin-controller.ts`.
 */
const rendererOrigin = createRendererOriginController({
  rendererDir: RENDERER_DIR,
  store: rendererOriginRecordStore,
  createBridge: () => createElectronOriginStorageBridge(RENDERER_DIR),
  registerSchemeHandler: registerElectronRendererSchemeHandler,
  // Each window's existing file:// load, unchanged.
  loadFile: async (target) => {
    if (target.surface === 'main') {
      await target.window.loadFile(
        join(RENDERER_DIR, MAIN_WINDOW_RENDERER_PAGE),
      );
      return;
    }
    await target.window.loadFile(
      join(RENDERER_DIR, APP_ADVISOR_RENDERER_PAGE),
      {
        search: APP_ADVISOR_RENDERER_SEARCH,
      },
    );
  },
  disableSetting: async () => {
    await updatePreferencesFile(() => ({
      rendererCodeCacheSchemeEnabled: false,
    }));
  },
  reenableSetting: async () => {
    await updatePreferencesFile(() => ({
      rendererCodeCacheSchemeEnabled: true,
    }));
  },
  recordDiagnostic: recordRendererOriginDiagnostic,
});
setRendererCodeCacheSchemeStatusSource(() => rendererOrigin.status());

/**
 * Increment the persisted guest-session counter once per app launch when the
 * saved cloud credential is a guest credential (CAN-936, WS3). Runs in the main
 * process so renderer double-mounts cannot double-count. Best-effort: any
 * failure is logged and swallowed so it never blocks startup.
 */
async function incrementGuestSessionCountOnLaunch(): Promise<void> {
  try {
    const account = await loadCanopyCloudAccount();
    if (!isGuestAccount(account)) {
      return;
    }
    await updatePreferencesFile((existing) => ({
      guestSessionCount: (existing.guestSessionCount ?? 0) + 1,
    }));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to increment guest session count:', error);
  }
}

// --- Share deep links (CAN-2361) -----------------------------------------
// Wired before `whenReady`: macOS can emit `open-url` before ready resolves,
// and the Windows/Linux cold-start URL arrives in this process's argv. The
// scheme is the brand's internalName (same token as the mobile OAuth
// callback scheme); parsing/validation live in
// `@canopy/protocol/share-deep-link` and buffering in
// `./deep-link/deep-link-service`.

// CAN-2781: canopy-branded staging share pages emit canopy:// links while the
// internal desktop build retains its unstoppable-code primary identity.
const INTERNAL_DEEP_LINK_COMPATIBILITY_SCHEME = 'canopy';
const DEEP_LINK_SCHEMES: readonly string[] = Array.from(
  new Set([
    BRAND.internalName,
    ...(getCanopyReleaseFlavor() === 'internal'
      ? [INTERNAL_DEEP_LINK_COMPATIBILITY_SCHEME]
      : []),
  ]),
);

function focusMainWindowForDeepLink(): void {
  focusMainWindow();
  if (mainWindow?.isFocused()) {
    recordDesktopInstanceEvent({
      event: 'window-focused',
      windowId: mainWindow.id,
    });
  }
}

/**
 * Recreate the main window from saved preferences when none exists (macOS
 * keeps the app alive windowless), and bring it to the front on the OS focus
 * shortcut (CAN-1963). The single-flight creation and the focus-after-create
 * rules live in `lifecycle/main-window-recreation.ts` (see its tests for the
 * duplicate-window race); this only binds them to process-level window
 * state. `steal` is deliberate for the shortcut — the user just pressed a
 * chord that means "switch to this app now". The E2E build keeps its window
 * hidden, so it records the trigger without showing anything unless the run
 * opted into a visible window.
 */
const mainWindowRecreation = createMainWindowRecreation<PreferencesData>({
  getMainWindow: (): BrowserWindow | null => mainWindow,
  readPreferences: readPreferencesFile,
  createWindow: (preferences): void => {
    updatePerformanceLimitsFromPreferences(preferences);
    createWindowWithState(preferences);
  },
  focusMainWindow: (): void => {
    focusMainWindow({ steal: true, moveTop: true });
  },
  shouldHandleTrigger: shouldShowUiAutomationWindow,
  onRecreationFailure: (error): void => {
    reportMainWindowRecreationFailure(error);
  },
});
const ensureMainWindowFromPreferences = mainWindowRecreation.ensureMainWindow;
const handleGlobalFocusShortcutTrigger =
  mainWindowRecreation.handleFocusShortcutTrigger;

/**
 * A paired computer's window switching back to this computer. No `steal`: the
 * user is already in this app.
 */
function showMainWindowFromRemoteWindow(): void {
  mainWindowRecreation.showMainWindow((): void => {
    focusMainWindow();
  });
}

function reportMainWindowRecreationFailure(error: unknown): void {
  // eslint-disable-next-line no-console
  console.error('Failed to recreate the main window:', error);
}

function appActivationWindows(): AppActivationWindows<BrowserWindow> {
  return {
    mainWindow,
    remoteWindows: getRemoteControlRuntime()?.liveMachineWindows() ?? [],
    lastFocusedAt: (window) => primaryWindowFocus.lastFocusedAt(window),
  };
}

/**
 * Bring forward the window a Dock click or the tray chose (CAN-4247). No
 * `steal`: the user already activated the app.
 */
function bringAppWindowForward(
  target: AppActivationTarget<BrowserWindow>,
): void {
  if (target.kind === 'focus') {
    focusWindow(target.window);
    return;
  }
  ensureMainWindowFromPreferences().catch(reportMainWindowRecreationFailure);
}

function registerDeepLinkProtocolClient(): void {
  // E2E launches must not mutate the developer machine's OS handler
  // registrations, and dev on macOS must not point LaunchServices at the
  // generic Electron binary (which would steal the scheme from an installed
  // packaged build).
  if (__CANOPY_E2E__) return;
  if (process.platform === 'darwin' && !app.isPackaged) return;
  if (process.defaultApp) {
    const appPath = process.argv[1];
    if (typeof appPath === 'string' && appPath.length > 0) {
      for (const scheme of DEEP_LINK_SCHEMES) {
        app.setAsDefaultProtocolClient(scheme, process.execPath, [
          resolve(appPath),
        ]);
      }
    }
    return;
  }
  for (const scheme of DEEP_LINK_SCHEMES) {
    app.setAsDefaultProtocolClient(scheme);
  }
}

// Single-instance lock: Windows/Linux deliver deep links to a *second*
// process's argv, which must forward to the running instance instead of
// booting a parallel app. Skipped for E2E builds — the lock keys on the
// userData dir, which E2E only redirects per-run *after* ready (see the
// `__CANOPY_E2E__` block inside whenReady), so parallel harness instances
// would collide on the default OS profile here.

if (!hasSingleInstanceLock) {
  // Losing the lock means another instance owns this profile: quit without
  // running any further module-scope setup (protocol registration, argv
  // handling, whenReady work) — `quit()` is asynchronous, so everything
  // below stays gated on `hasSingleInstanceLock`.
  app.quit();
} else {
  app.on('second-instance', (_event, argv): void => {
    recordDesktopInstanceEvent({
      event: 'second-instance',
      windowId: mainWindow?.id ?? null,
    });
    focusMainWindowForDeepLink();
    handleProtocolArgv(argv, DEEP_LINK_SCHEMES);
  });

  app.on('will-finish-launching', (): void => {
    app.on('open-url', (event, url): void => {
      event.preventDefault();
      handleProtocolUrl(url, DEEP_LINK_SCHEMES);
    });
  });

  registerDeepLinkProtocolClient();
  handleProtocolArgv(process.argv, DEEP_LINK_SCHEMES);
  // Must precede ready. Registers privileges only; the scheme serves
  // nothing until a launch that uses it registers the handler.
  registerRendererSchemePrivileges();

  setOrgProjectDeepLinkSender((event): boolean => {
    const target = mainWindow;
    // A window that exists is not a window that can receive: IPC sent before
    // the renderer's listener attaches goes nowhere and is not replayed. Same
    // readiness gate the auto-archive notification buffer uses, so an
    // undelivered result is retried from `notifyStartupUnlocked`.
    if (
      !mainWindowRendererReady ||
      !target ||
      target.isDestroyed() ||
      target.webContents.isDestroyed()
    ) {
      return false;
    }
    sendToWebContents(
      target.webContents,
      IPC_CHANNELS.deepLinkOrgProjectOpen,
      event,
    );
    return true;
  });

  setDeepLinkSender((link): boolean => {
    const window = mainWindow;
    if (!window || window.isDestroyed()) return false;
    focusMainWindowForDeepLink();
    if ('destination' in link && link.destination === 'org-project') {
      // Authorization is asynchronous, so the result is delivered through the
      // host's own buffer against whatever window is current then — this
      // `window` may be gone by the time there is one.
      handleOrgProjectDeepLink(link);
      return true;
    }
    if ('destination' in link && link.destination === 'settings') {
      if (!mainWindowRendererReady || window.webContents.isDestroyed())
        return false;
      if (link.section === 'privacy' && link.optIn) {
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.deepLinkPrivacyOptInOpen,
          link.optIn,
        );
      } else {
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.deepLinkSettingsOpen,
          link.section,
        );
      }
      recordDesktopInstanceEvent({
        event: 'link-delivered',
        windowId: window.id,
        destination: 'settings',
      });
      return true;
    }
    if ('destination' in link) {
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.deepLinkRemoteControlOpen,
      );
      return true;
    }
    sendToWebContents(window.webContents, IPC_CHANNELS.deepLinkShareOpen, link);
    // APP_OPENED funnel leg (CAN-2361 PR4): reported at delivery, when the
    // link demonstrably reached a live window. Fire-and-forget.
    // A shared-container externalId is the capability token itself. It must
    // never enter public-share analytics or logs.
    if (
      link.entity !== 'shared-container' &&
      link.automationSource !== 'curated'
    ) {
      void reportShareHandoffEvent({
        entity: link.entity,
        externalId: link.externalId,
        eventType: 'APP_OPENED',
        audience: link.audience,
      });
    }
    return true;
  });

  // Returning from browser checkout (CAN-4028). The link is a refresh hint:
  // the renderer re-reads access from the server and decides everything from
  // that answer. Nothing here grants access or names a model to select.
  setBillingReturnSender((link): boolean => {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      !mainWindowRendererReady ||
      window.webContents.isDestroyed()
    )
      return false;
    focusMainWindowForDeepLink();
    sendToWebContents(
      window.webContents,
      IPC_CHANNELS.deepLinkBillingUnlocked,
      link,
    );
    return true;
  });

  setWebLinkSender(async (url): Promise<boolean> => {
    const guardedDelivery = await consumeExternalOpenLoopGuard(url);
    if (guardedDelivery !== null) return guardedDelivery;
    const window = mainWindow;
    if (
      !mainWindowRendererReady ||
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed()
    ) {
      return false;
    }
    focusMainWindowForDeepLink();
    try {
      await routeAppLink({
        url,
        sender: window.webContents,
        source: 'system-default',
      });
      return true;
    } catch {
      return false;
    }
  });
}

// -------------------------------------------------------------------------

// Before ready: agent visuals run in their own process, not the app's.
if (hasSingleInstanceLock) {
  pinIsolateSandboxedIframes(app.commandLine);
  configureLinuxSecureStorage(app.commandLine, {
    platform: hostOperatingSystem(),
    isTestHarness: __CANOPY_E2E__,
    passwordStoreOverride: __CANOPY_E2E__
      ? process.env.CANOPY_LINUX_PASSWORD_STORE
      : undefined,
  });
  // E2E test isolation: redirect Electron's `userData` root at the per-run
  // `CANOPY_DATA_DIR`. `app.getPath('userData')`-based state — notably
  // `portal-state.json`, which persists the portal `viewMode` — otherwise
  // lives in the shared `~/Library/Application Support/<name>` directory and
  // leaks across test runs (a spec that switches to chats mode poisons
  // `viewMode: 'standalone-chats'` for every later portal spec, hiding the
  // workspace rail). Gated on the E2E build so production/dev keep the default
  // OS userData location; the harness always launches with a fresh
  // `CANOPY_DATA_DIR`, so each test starts from clean state.
  // It must run before ready: the network service starts with the userData
  // seen then, and on macOS its sandbox cannot write a root assigned later
  // (only the system temp directory), so cookies never reached disk.
  if (__CANOPY_E2E__) {
    // `CANOPY_E2E_USER_DATA_DIR` is the fallback for specs that must blank
    // `CANOPY_DATA_DIR` to exercise real brand-candidate data-dir resolution
    // (CAN-2271): without it those launches would share the default OS
    // profile directory with concurrently running E2E instances.
    const e2eUserDataDir =
      process.env.CANOPY_DATA_DIR || process.env.CANOPY_E2E_USER_DATA_DIR;
    if (e2eUserDataDir && existsSync(e2eUserDataDir)) {
      app.setPath('userData', e2eUserDataDir);
    }
  }
  // After the final `userData` (which `crashDumps` derives from) and before
  // any renderer or utility process. Dumps stay local; feedback bundles can
  // include them. The system crash handler stays on (the retired Datadog SDK
  // turned it off) so macOS DiagnosticReports keeps its `.ips` files.
  crashReporter.start({
    submitURL: '',
    uploadToServer: false,
    compress: false,
  });
}

void app.whenReady().then(async (): Promise<void> => {
  if (!hasSingleInstanceLock) return;
  try {
    await prepareCanopySecureStorage();
  } catch (error) {
    exitForW5HostRefusal(
      error instanceof Error
        ? error.message
        : 'Secure storage maintenance failed.',
    );
    return;
  }
  recordDesktopInstanceEvent({ event: 'app-ready' });
  let recoveryRefusal: { kind: 'refused'; message: string } | undefined;
  try {
    if (!(await runRequestedW5Recovery(getCanopyDataDir()))) {
      app.exit(1);
      return;
    }
  } catch (error) {
    recoveryRefusal = {
      kind: 'refused',
      message:
        error instanceof Error
          ? error.message
          : 'Deletion recovery evidence is unavailable.',
    };
  }
  // TRANSITIONAL (CAN-3797): joins the W5 host cohort before any W5 I/O.
  // Remove when the W5 rows move to `daemon` and the legacy Electron writers
  // are deleted (CAN-3795 / CAN-3802).
  const w5Host =
    recoveryRefusal ??
    (await admitDesktopW5Host(getCanopyDataDir()).catch(
      (error: unknown): { kind: 'refused'; message: string } => ({
        kind: 'refused',
        message:
          error instanceof Error
            ? error.message
            : 'Deletion recovery evidence is unavailable.',
      }),
    ));
  if (w5Host.kind === 'refused') {
    exitForW5HostRefusal(w5Host.message);
    return;
  }
  // TRANSITIONAL (CAN-5543): a flip build hands W5 to the daemon on every
  // launch; W5 calls wait for it, the rest of startup does not. A no-op with
  // legacy rows. Remove at W15.
  void startW5FlipHandoff({ admission: w5Host });
  installExecutionAccountingHost({
    wakeLock: getWakeLockService(),
    recordDiagnostic: (record): void => {
      getObservabilityService().recordAppDiagnostic(record);
    },
  });
  if (__CANOPY_E2E__) {
    // CAN-5532: validate either explicit arm, including on flip builds.
    // An unset selection loads no module.
    const w5StoreArmName = process.env.CANOPY_PERFORMANCE_W5_STORE;
    if (w5StoreArmName) {
      const { startW5StoreArm } =
        await import('./e2e-fixtures/w5-daemon-record-store-arm');
      const started = await startW5StoreArm(w5StoreArmName);
      if ('refusal' in started) {
        exitForW5HostRefusal(started.refusal);
        return;
      }
      w5StoreArm = started.handle;
    }
  }
  initializeSidebarItemGroups();
  if (__CANOPY_E2E__) {
    // The performance harness's J1 journey reads when main became ready.
    markE2eStartup('mainReady');
  }
  app.setName(getRuntimeAppName());
  electronApp.setAppUserModelId(getRuntimeAppUserModelId());
  await discardStaleSessionImportArtifacts().catch(() => undefined);
  if (__CANOPY_E2E__) {
    installE2eChatEventIngestor();
    // The performance harness reads and resets the work counters here.
    installWorkCountersQuery();
  }
  // Read the renderer origin record now, off the critical path, so the
  // origin decision before the first window costs nothing extra.
  if (!(is.dev && process.env['ELECTRON_RENDERER_URL'])) {
    rendererOrigin.startRecordProbe();
  }
  // Custom menu without a plain CmdOrCtrl+R reload accelerator so Ctrl+R
  // reaches the integrated terminal (CAN-338).
  installApplicationMenu();

  if (movePackagedMacAppToApplicationsIfNeeded()) {
    return;
  }

  // Classify a profile as fresh or existing before any startup service can
  // create preferences.json as a side effect (notably Ollama detection).
  // Capture before any migration writes the fully normalized preference
  // object; apply preference-writing migrations only after model registries
  // are ready to validate legacy selections accurately.
  let preferenceMigrationSnapshots:
    | Awaited<ReturnType<typeof capturePreferenceMigrationSnapshots>>
    | undefined;
  try {
    preferenceMigrationSnapshots = await capturePreferenceMigrationSnapshots();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to inspect stored preferences:', error);
  }
  const chatSummaryModelSelectionSnapshot =
    preferenceMigrationSnapshots?.chatSummaryModelSelection;
  const localMemoryModelSnapshot =
    preferenceMigrationSnapshots?.localMemoryModel;
  // Before any gated flow starts: an unreadable stored account fails closed.
  await initializeStartupUsageDataPolicy();
  startDesktopInstrumentation();
  childToolsSettlement ??= startChildToolsSettlement();
  setCodexGatewayProxyDiagnosticSink((record) => {
    getObservabilityService().recordSessionDiagnostic(record);
  });
  void initializeTelemetrySyncService().catch((error: unknown): void => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize telemetry sync service:', error);
  });
  // Counts chat-turn starts as basic usage (CAN-3561). Gated by the member's
  // Active use count choice and the selected organization's usage-data
  // policy, not by activity sharing: it is analytics and sends no content.
  initializeProductActivityReporter();
  // Keep already-shared chats' runs current: re-share (idempotent) as new
  // conversation turns finish, so shared sessions stay live without a manual
  // re-share. Subscribes to observability turn completions — independent of the
  // telemetry-sharing opt-in, since sharing carries its own consent.
  getSharedRunAutoUpdater().start();
  // A corrupt comment registry degrades to empty, which silently disables
  // every unread badge and the whole poll. Surface it as a triageable app
  // diagnostic instead (no worktree id — this is a whole-file failure).
  setSharedRunCommentsCorruptionReporter(({ error }) => {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_run_comments_registry_unreadable',
      error,
    });
  });
  // Learn about comments teammates leave on already-shared runs (CAN-397).
  // Deliberately a bounded poll (slow interval + window focus), not an SSE
  // client in Electron main; it self-gates on the cloud capability and never
  // throws.
  getSharedRunCommentPoller().start();
  // Realtime accelerates recipient-inbox discovery; the independent heartbeat
  // remains the delivery guarantee when SSE is unavailable or disconnected.
  getSharedContainerInboxWatcher().start();
  // Resolve the user's login-shell PATH in the background now so the first
  // terminal/agent spawn never blocks on (or falls back around) the
  // multi-second interactive shell init. Lookups launch through the
  // execution host port, like the pipeline and code-graph hosts.
  setLoginShellProbe(createPortLoginShellProbe(getExecutionHostPort()));
  const loginShellPathPrewarm = prewarmLoginShellPath();
  // Log any promised bundle member that is not staged, once the PATH used for
  // the macOS development fallback is known.
  scheduleMissingBundledBinaryReport(loginShellPathPrewarm);
  // Reap Codex app-server orphans left by a previous run of this instance.
  // A leftover app-server holds the shared Codex state DB and wedges every
  // app-server this run spawns (chat sessions and marketplace calls alike).
  // PIDs are verified to still be Codex app-servers before being killed.
  recordDesktopInstanceEvent({
    event: 'provider-cleanup-started',
    provider: 'codex',
  });
  enableCodexAppServerPidPersistence();
  const staleCodexCleanup = reapStaleCodexAppServerProcesses().catch(
    (error: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn('Failed to reap stale Codex app-server processes:', error);
    },
  );
  // Reap Claude CLIs a crashed run left behind (they run detached). Each PID
  // must still match its recorded start time and executable before a kill.
  recordDesktopInstanceEvent({
    event: 'provider-cleanup-started',
    provider: 'claude',
  });
  enableClaudeProcessPidPersistence();
  void reapStaleClaudeProcesses()
    .then((reaped): void => {
      for (const record of reaped) recordReapedClaudeProcessDiagnostic(record);
    })
    .catch((error: unknown): void => {
      // eslint-disable-next-line no-console
      console.warn('Failed to reap stale Claude processes:', error);
    });
  void sweepOrphanedMacosWorktreeDirectories().catch((error: unknown): void => {
    // eslint-disable-next-line no-console
    console.warn('Failed to sweep orphaned macOS worktree directories.', {
      error,
    });
  });
  stopArchivedContainerRetention ??= startArchivedContainerRetentionScheduler();
  setAutoArchiveResultListener(publishAutoArchiveNotification);
  startLocalMemoryConsolidationScheduler();
  // Repeat-task skill suggestions (CAN-385): recording taps, idle scans and
  // the live kill switch. Nothing scans at startup.
  void initializeSuggestionsGate();
  startSkillSuggestions();
  // Warm the AI Credits routing-mode cache so the first session spawn reflects
  // the persisted always-on/on-quota mode without a blocking disk read.
  prewarmAiCreditsRoutingMode();
  prewarmAiCreditsAvailability();
  // Warm the Claude native-auth cache (Codex stays lazy — see the function's
  // doc comment). Since a confirmed missing native login now force-routes
  // through AI Credits (ECW-9091), every Claude spawn awaits an auth probe;
  // prewarming keeps a cold probe off the first message.
  prewarmProviderNativeAuthStatus();
  // Codex prewarm is opt-in on POSITIVE evidence only. `!== 'claude-native'`
  // also matched `undefined` — every first-ever launch — so a brand-new
  // install, and every credits-only/Ollama user, spawned a Codex app-server at
  // startup for a probe they may never need.
  void readPreferencesFile()
    .then((preferences) => {
      if (shouldPrewarmCodexNativeAuthAtStartup(preferences)) {
        prewarmProviderNativeAuthStatus('codex');
      }
    })
    .catch(() => undefined);

  // Set dock icon on macOS (cosmetic — app bundle icon is the fallback)
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = getIconPath();
    try {
      app.dock.setIcon(iconPath);
    } catch (error) {
      // Icon loading is non-critical; the .app bundle icon is used by default
      // eslint-disable-next-line no-console
      console.warn('Failed to set dock icon, falling back to bundle icon.', {
        iconPath,
        error,
      });
    }
  }

  app.on('browser-window-created', (_, window) => {
    // Replaces optimizer.watchWindowShortcuts, whose packaged-build handler
    // preventDefault()ed Ctrl/Cmd+R before xterm could see it (CAN-338).
    attachWindowInputGuards(window);
    // Cut/Copy/Paste/Select All on right-click in text fields (CAN-3378).
    attachEditableContextMenu(window);
    // Copy link / Open in browser / Open in external browser (CAN-2632).
    attachLinkContextMenu(window, linkContextMenuDeps(window.webContents));
  });

  // A failed or timed-out LaunchDarkly start leaves every flag on its
  // enabled-but-unavailable fallback. The service retries with backoff and
  // records the outage in app-events; focus and power resume retry early
  // (CAN-3511). Consumers below react through snapshot broadcasts.
  getFeatureFlagService().setDiagnosticRecorder((record): void => {
    getObservabilityService().recordAppDiagnostic(record);
  });
  await loadCanopyCloudAccount().catch((error: unknown): void => {
    // Account storage is optional for startup; Labs uses the cached account
    // until the existing account recovery path publishes a newer snapshot.
    logMainProcessWarn(
      '[labs-experiments] Startup account read failed.',
      error,
    );
  });
  // Seed the durable account/local state before Early access consumers start.
  getLabsExperimentsService();
  await initializeFeatureFlagService();
  installClaudeModAdmissionHost();
  void initializeLabsExperimentsService();
  // Background operations reach PostHog only while LaunchDarkly allows capture
  // and the member's effective usage-data policy allows the category.
  installPostHogOperationCaptureGate(getFeatureFlagService());
  installUsageDataPolicyFeatureFlagRefresh(
    () => getFeatureFlagService().refreshContext(),
    getLastBuiltFeatureFlagIdentity,
  );
  // Subscribed once the capture flag is known: the auth feed replays a
  // sign-in the startup prewarm already confirmed (CAN-4015).
  disposeProviderAccountConnectTelemetry ??=
    startProviderAccountConnectTelemetry({
      subscribeProviderAuth: subscribeConfirmedProviderAuth,
      subscribeCursorAccount: subscribeConfirmedCursorAccount,
    });
  uninstallFeatureFlagRecoveryTriggers = installFeatureFlagRecoveryTriggers(
    getFeatureFlagService(),
    { app, powerMonitor },
  );
  // Provider usage can read native credentials. Resolve rollout flags first,
  // then keep those optional reads off the first-window critical path.
  void initializeObservabilityService().catch((error: unknown): void => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize observability service:', error);
  });
  scheduleCostIndexStartup();
  // The Personal/organization context must be restored before the first
  // renderer read; it only touches the account store and one small JSON file.
  // Usage-data prohibitions apply by the selected context from here on.
  attachUsageDataPolicyToWorkspaceContext(getWorkspaceContextService());
  await getWorkspaceContextService().initialize();
  installOrgDefaultCoworkProvisioning();
  await getForeignActivityCarryoverService().initialize();
  // The catalog follows the context service: it refreshes on every switch.
  await getOrgProjectCatalogService().initialize();
  startPersonalCatalogSync();
  startCloudProjectBinding();
  startCloudProjectSetupSweep();
  // The shared session snapshot projects catalog placeholder rows, so catalog,
  // context, and flag changes must mark it stale like local mutations do.
  installOrgProjectSnapshotInvalidation();
  // Subscribes and schedules only: the first run is debounced well past first
  // paint, runs in the background, and nothing is scheduled with the flag off.
  startOrgProjectAutoConversion();
  void getOrgProjectMaterialization()
    .sweepInterruptedSetups()
    .then(async (): Promise<void> => {
      startPersonalOrganizationUpgradeRecovery();
      const { resumeDesktopSharedMultiRepoCreations } =
        await import('./canopy-runtime/core-shared-multi-repo-host');
      await resumeDesktopSharedMultiRepoCreations();
    })
    .catch((error: unknown): void => {
      getObservabilityService().recordAppDiagnostic({
        version: 1,
        timestamp: new Date().toISOString(),
        kind: 'startup_background_task_failed',
        reason: 'org_project_setup_recovery',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  const initialFeatureFlags = getFeatureFlagService().getSnapshot().values;
  loadModelsFromPackageJson(initialFeatureFlags);
  try {
    let initialCatalogHydrated = false;
    const service = createAiGatewayModelCatalogService({
      serverOrigin: getCanopyCloudBaseUrl(),
      brandApiNamespace: BRAND.web.apiNamespace,
      onCatalog: async (catalog): Promise<void> => {
        updateAiGatewayModelCatalog(catalog);
        refreshModelHarnessAssignments();
        if (initialCatalogHydrated) {
          await refreshAgentModelsFromStore();
          broadcastModelRegistryUpdated();
        }
      },
      onStatus: (status): void => {
        // Before hydration completes the first registry read carries the
        // status; afterwards the renderer learns of changes by broadcast.
        if (setAiGatewayCatalogStatus(status) && initialCatalogHydrated) {
          broadcastModelRegistryUpdated();
        }
      },
    });
    aiGatewayModelCatalogService = service;
    setAiGatewayCatalogStatus(service.getStatus());
    setAiGatewayCatalogRetryHandler(() => service.retry());
    // Await one small asynchronous disk read before persisted model
    // preferences are validated. Network work begins only after hydration.
    await service.hydrate();
    initialCatalogHydrated = true;
    service.start();
  } catch (error) {
    // Native package-owned models remain available when cloud configuration or
    // cached catalog hydration is unavailable.
    // eslint-disable-next-line no-console
    console.warn('Failed to initialize the AI Gateway model catalog.', error);
    aiGatewayModelCatalogService?.dispose();
    aiGatewayModelCatalogService = null;
    // No service means no fetch is ever attempted (for example, a build with
    // no cloud origin). Report no status rather than a failure.
    setAiGatewayCatalogStatus(undefined);
    setAiGatewayCatalogRetryHandler(undefined);
  }
  if (isOllamaSupportedOnPlatform()) {
    // Ollama performs a single installation-detection pass during
    // initialization. Wait for the already-started prewarm at this boundary
    // so Finder-launched macOS apps see login-shell-only installations.
    await loginShellPathPrewarm;
    await getOllamaService().initialize();
  }
  // The proxy on this device starts in the background when it is the
  // connection and set to start with the app; nothing here waits on it.
  void import('./account-proxy/service')
    .then(({ initializeLocalAccountProxy }) => initializeLocalAccountProxy())
    .catch(() => undefined);
  await initializeModelHarnessRegistry();
  setModelHarnessAssignmentController(modelHarnessAssignmentController);
  await refreshAgentModelsFromStore();
  // Every preference update normalizes the complete merged object, including
  // persisted model ids. Run preference-writing migrations only after the
  // package, gateway, Ollama, harness, and Agent model registries are ready so
  // an upgrade cannot mistake valid saved selections for unknown models and
  // replace them with provider defaults.
  try {
    await migrateApprovalDefaultsToFullAccess(
      chatSummaryModelSelectionSnapshot?.hasPersistedPreferences,
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate approval defaults:', error);
  }
  if (chatSummaryModelSelectionSnapshot) {
    try {
      await migrateChatSummaryModelSelection(chatSummaryModelSelectionSnapshot);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to migrate chat summary model selection:', error);
    }
  }
  if (localMemoryModelSnapshot) {
    try {
      await migrateLocalMemoryModelFromSummary(localMemoryModelSnapshot);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Failed to migrate the local memory model:', error);
    }
  }
  // Preference normalization validates persisted model ids against the model
  // registries above. The org-enforced sync can perform a partial preference
  // write during its immediate startup pass, so it must not start while those
  // registries are still empty or a valid saved model will be replaced by the
  // hard-coded provider fallback.
  // The background sync only needs the side effect; its boolean return (did the
  // per-org billing state actually refresh?) is for callers that delete data on
  // a lapse verdict.
  startOrgEnforcedSettingsSync(async (): Promise<void> => {
    await reprobeAndApplyCanopyCloudEnforcedSettings();
  });
  installOrgProjectsCapabilityRefresh({
    flags: {
      isEnabled: (): boolean =>
        getFeatureFlagService().isEnabled(
          CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key,
        ),
      onSnapshotChanged: (listener): (() => void) =>
        getFeatureFlagService().onSnapshotChanged(listener),
    },
    refresh: async (): Promise<void> => {
      await reprobeAndApplyCanopyCloudEnforcedSettings();
    },
  });
  try {
    await migrateAppManagedChatWorkspaces();
    // App-managed path migration must land first so the legacy global chat
    // file is split from its final app-workspaces location.
    await migrateAppAdvisorChatsToWorkEntries();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      'Failed to migrate app-managed chat projects or App Advisor Work Entries:',
      error,
    );
  }
  try {
    await migrateStandaloneChatToCowork();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      'Failed to migrate standalone-chat to cowork projects:',
      error,
    );
  }
  try {
    await loadCoworkMigrationMapCache();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to load cowork migration map cache:', error);
  }
  try {
    // After the cowork migration + map cache: splits each cowork workspace's
    // flat chats/home.json into per-entry tab files.
    await migrateCoworkChatsToWorkEntries();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate cowork chats to work entries:', error);
  }
  try {
    // After the cowork migrations, so the default workspace exists in the
    // index before its name is reconciled with the sidebar's Chats section.
    await migrateDefaultCoworkWorkspaceName();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      'Failed to migrate the default cowork workspace name:',
      error,
    );
  }
  try {
    await migrateAutomationRunArchive();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate automation run history:', error);
  }
  try {
    await migrateClaudeWorkerModesToCanopy();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate Claude worker modes:', error);
  }
  try {
    await migrateSidebarRemoteControlVisible();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate sidebar Remote Control:', error);
  }
  // Must follow the Remote Control migration: it upgrades a legacy default
  // layout to the current default, whose More pages this one then moves.
  try {
    await migrateSidebarMorePagesToMain();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate sidebar More pages:', error);
  }
  try {
    await migrateLocalMemoryDefaultOn();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate local memory default:', error);
  }
  try {
    await migrateSidebarManualSortDefault();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate sidebar sort default:', error);
  }
  try {
    await migrateOpenAppLinksInBuiltInBrowserDefault();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Failed to migrate built-in browser link default:', error);
  }
  if (appIsQuitting) return;
  // CAN-5154: a profile without a generation record gets one in the background.
  void startPreferencesGenerationStamp();
  try {
    await (await import('./copilot/connection')).recoverCopilotAtStartup();
  } catch (error) {
    logMainProcessWarn(
      '[copilot] Startup process recovery did not finish',
      error,
    );
  }
  // Re-check after the reaper: quit may already be past its startup-recovery stage.
  if (appIsQuitting) return;
  startupRecoveryPromise = (async (): Promise<void> => {
    await staleCodexCleanup;
    await recoverInterruptedWorkAtStartup();
  })().catch((error: unknown): void => {
    // Keep unreadable items intact so opening them or a later startup can retry.
    // eslint-disable-next-line no-console
    console.error('Failed to recover interrupted work at startup:', error);
  });
  await startupRecoveryPromise;
  if (appIsQuitting) return;
  const preferences = await readPreferencesFile();
  // Decide this launch's renderer origin now, moving origin-keyed storage
  // first when the experiment changed since the last launch (off and never
  // used: no work). Every app window waits for this decision, including one
  // the tray or the global shortcut opens, so it starts before the startup
  // steps below and cannot be stranded by one of them.
  const rendererOriginDecided: Promise<unknown> =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? Promise.resolve()
      : rendererOrigin.prepare(
          preferences.rendererCodeCacheSchemeEnabled === true,
        );
  nativeTheme.themeSource = getNativeThemeSource(preferences.colorMode);
  setAppAdvisorProjectAgentAccess(preferences.appAdvisorProjectAgentAccess);
  setCodeGraphPreferences(preferences.codeGraph);
  // Canonical turn state decides the audit entries of turns no dispatcher started.
  installTurnStateAudit(getObservabilityService(), getChatStateService());
  // Committed turn state and its timer rows must agree (turn-state phase 43c).
  installTurnStateInvariantGuard(
    (diagnostic) =>
      getObservabilityService().recordSessionDiagnostic(diagnostic),
    getChatStateService(),
  );
  setRemoteControlEnabled(preferences.remoteControlEnabled === true);
  let previousCanopyPortalEnabled = getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
  );
  let previousActivationJourneyEnabled = getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key,
  );
  let previousCodeGraphEnabled = getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key,
  );
  getFeatureFlagService().onSnapshotChanged((snapshot) => {
    refreshModelsForFeatureFlags(snapshot.values);
    refreshModelHarnessAssignments();
    void refreshAgentModelsFromStore().then(() =>
      broadcastModelRegistryUpdated(),
    );

    // The journey flag gates close-to-tray, so it has to track live changes
    // like its siblings here -- otherwise the kill switch needs a restart to
    // take effect, and a slow LaunchDarkly init would pin the feature off for
    // the whole session. It also re-arms the scheduler, which no longer polls
    // for `campaign-disabled`.
    const nextActivationJourneyEnabled =
      snapshot.values[
        CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key
      ] === true;
    // Diff before acting, like the portal and code-graph handlers below:
    // otherwise every unrelated flag flip costs a journey evaluation.
    if (nextActivationJourneyEnabled !== previousActivationJourneyEnabled) {
      setActivationJourneyFlagEnabled(nextActivationJourneyEnabled);
      // Keep the creation-failure fallback the other call sites have. Without
      // it, a runtime flip on Windows where `new Tray()` throws leaves
      // close-to-tray enabled with no icon -- and the close handler then hides
      // the window, stranding a running app with no way back.
      if (!syncActivationTray()) {
        setCloseToTrayPreference(false);
      }
      if (nextActivationJourneyEnabled) {
        // Seed the abandonment anchor. The focus handler is flag-gated, and a
        // rollout targets installs whose window is already focused -- so no
        // new focus transition fires and `lastActiveAt` would stay null. With
        // the no-anchor ceiling that leaves campaigns 1 and 2 dormant for the
        // rest of the session on any install older than ~13 hours.
        // The recompute must happen whether or not the seed write succeeds:
        // this is the one call site whose entire purpose is guaranteeing it,
        // and `mutateState` returns an un-caught promise.
        void recordActivity(new Date().toISOString())
          .catch(() => undefined)
          .then(() => {
            requestActivationRecompute();
          });
      } else {
        requestActivationRecompute();
      }
    }
    previousActivationJourneyEnabled = nextActivationJourneyEnabled;

    const nextCanopyPortalEnabled =
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key];
    if (previousCanopyPortalEnabled && !nextCanopyPortalEnabled) {
      void stopCanopyPortal('local_disconnect');
    }
    previousCanopyPortalEnabled = nextCanopyPortalEnabled;

    const nextCodeGraphEnabled =
      snapshot.values[
        CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key
      ] === true;
    if (nextCodeGraphEnabled !== previousCodeGraphEnabled) {
      previousCodeGraphEnabled = nextCodeGraphEnabled;
      void reconcileCodeGraphAvailability().catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error('Failed to reconcile Code Graph availability:', error);
      });
    }

    applySyncServiceFeatureFlags(
      snapshot.values,
      { inventory: getDesktopInventorySyncService() },
      { remoteAccessEnabled: isRemoteControlEnabled() },
    );
    setLedgerSyncEnabled(
      snapshot.values[CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key] === true,
    );
  });
  // Before the IPC handlers, which read the service through its throwing
  // getter as soon as a renderer asks for the status.
  initializeGlobalFocusShortcutService({
    onTrigger: handleGlobalFocusShortcutTrigger,
    onStatusChanged: (status): void => {
      sendToAllWindows(IPC_CHANNELS.globalFocusShortcutStatusChanged, status);
    },
  });
  // Launch at sign-in (CAN-3449) only reads or writes the OS on request, so
  // constructing it here adds no startup work. Unpackaged builds report it
  // unsupported rather than registering the bare Electron binary.
  initializeLaunchAtLoginService({
    electronRegistrar: app,
    platform: process.platform,
    isPackaged: app.isPackaged,
    openExternal: openExternalGuarded,
    onStatusChanged: (status): void => {
      sendToAllWindows(IPC_CHANNELS.launchAtLoginStatusChanged, status);
    },
  });
  const defaultBrowserPlatform =
    process.platform === 'darwin' || process.platform === 'win32'
      ? process.platform
      : 'linux';
  const defaultAppEntry = process.argv[1];
  initializeDefaultBrowserRegistrationService({
    registrar: app,
    platform: defaultBrowserPlatform,
    isPackaged: app.isPackaged,
    isE2e: __CANOPY_E2E__,
    initialEnabled: preferences.useAsSystemDefaultBrowser === true,
    executablePath: process.execPath,
    advertiseWindowsCapabilities: () =>
      advertiseWindowsDefaultBrowserCapabilities({
        appId: getRuntimeAppUserModelId(),
        appName: getRuntimeAppName(),
        description: BRAND.description,
        executablePath: process.execPath,
      }),
    ...(process.defaultApp &&
    typeof defaultAppEntry === 'string' &&
    defaultAppEntry.length > 0
      ? {
          registrationPath: process.execPath,
          registrationArgs: [resolve(defaultAppEntry)],
        }
      : {}),
    openWindowsSettings: () => shell.openExternal('ms-settings:defaultapps'),
    onStatusChanged: (status): void => {
      sendToAllWindows(
        IPC_CHANNELS.browserDefaultRegistrationStatusChanged,
        status,
      );
    },
  });
  desktopCanopyRuntime = createDesktopRuntime({
    getChatStatePort: getChatStateService,
    shutdownTimeoutMs: DESKTOP_CANOPY_RUNTIME_SHUTDOWN_TIMEOUT_MS,
    daemonFilesRoute: getDesktopDaemonFilesRoute,
  });
  setDesktopCanopyRuntime(desktopCanopyRuntime);
  // The orphan sweep goes through core, so it waits for the runtime; nothing
  // can start a pipeline before the handlers below are registered.
  startupRecoveryPromise = sweepInterruptedPipelinesAtStartup();
  if (startupRecoveryPromise) {
    startupRecoveryPromise = startupRecoveryPromise.catch(
      (error: unknown): void => {
        // eslint-disable-next-line no-console
        console.error('Failed to recover interrupted workflow runs:', error);
      },
    );
    await startupRecoveryPromise;
    if (appIsQuitting) return;
  }
  if (__CANOPY_E2E__) {
    // Selected Windows acceptance fixtures only. Activation shares startup's
    // existing service registration; no diagnostic transport request is added.
    interface WindowsBoundaryDiagnosticsConfig {
      file: string;
      mode: string;
      launchId?: string;
      caseId?: string;
      fixturePid?: number;
      owners?: { projectId: string; worktreeId: string }[];
      firstProjectsLoad?: boolean;
      firstProjectsLoadFile?: string;
    }
    const isWindowsBoundaryDiagnosticsConfig = (
      value: unknown,
    ): value is WindowsBoundaryDiagnosticsConfig => {
      if (
        !isRecord(value) ||
        typeof value.file !== 'string' ||
        typeof value.mode !== 'string'
      )
        return false;
      if (value.launchId !== undefined && typeof value.launchId !== 'string')
        return false;
      if (value.caseId !== undefined && typeof value.caseId !== 'string')
        return false;
      if (
        value.fixturePid !== undefined &&
        typeof value.fixturePid !== 'number'
      )
        return false;
      if (
        value.firstProjectsLoad !== undefined &&
        typeof value.firstProjectsLoad !== 'boolean'
      )
        return false;
      if (
        value.firstProjectsLoadFile !== undefined &&
        typeof value.firstProjectsLoadFile !== 'string'
      )
        return false;
      return (
        value.owners === undefined ||
        (Array.isArray(value.owners) &&
          value.owners.every(
            (owner) =>
              isRecord(owner) &&
              typeof owner.projectId === 'string' &&
              typeof owner.worktreeId === 'string',
          ))
      );
    };
    const raw = process.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS;
    if (raw && raw.length <= 4096) {
      try {
        const parsedConfig: unknown = JSON.parse(raw);
        if (!isWindowsBoundaryDiagnosticsConfig(parsedConfig))
          throw new Error('Invalid fixture diagnostic configuration');
        const config = parsedConfig;
        const fs = process.getBuiltinModule('fs');
        const path = process.getBuiltinModule('path');
        if (
          !path.isAbsolute(config.file) ||
          !config.file.endsWith('.jsonl') ||
          !['setup', 'close', 'loaded-task', 'screenshot'].includes(config.mode)
        )
          throw new Error('Invalid fixture diagnostic output');
        if (
          [config.launchId, config.caseId].some(
            (id) =>
              id !== undefined &&
              (typeof id !== 'string' || !/^[a-z0-9_-]{1,160}$/i.test(id)),
          ) ||
          (config.fixturePid !== undefined &&
            (!Number.isInteger(config.fixturePid) || config.fixturePid <= 0)) ||
          (config.firstProjectsLoad !== undefined &&
            typeof config.firstProjectsLoad !== 'boolean') ||
          (config.firstProjectsLoad === true &&
            (config.mode !== 'close' ||
              typeof config.firstProjectsLoadFile !== 'string' ||
              !path.isAbsolute(config.firstProjectsLoadFile) ||
              !config.firstProjectsLoadFile.endsWith('.jsonl') ||
              config.firstProjectsLoadFile === config.file)) ||
          (config.firstProjectsLoad !== true &&
            config.firstProjectsLoadFile !== undefined) ||
          (config.mode === 'close' &&
            config.owners !== undefined &&
            (!Array.isArray(config.owners) ||
              config.owners.length > 2 ||
              config.owners.some(
                (owner) =>
                  !owner ||
                  [owner.projectId, owner.worktreeId].some(
                    (id) =>
                      typeof id !== 'string' ||
                      !/^[a-z0-9_-]{1,128}$/i.test(id),
                  ),
              ))) ||
          (config.mode === 'screenshot' &&
            (config.caseId !== 'two-browser-panels-screenshot' ||
              typeof config.launchId !== 'string' ||
              !Number.isInteger(config.fixturePid) ||
              (config.fixturePid ?? 0) <= 0))
        )
          throw new Error('Invalid fixture diagnostic identity');
        let count = 0,
          size = 0,
          stopped = false;
        const makeLine = (
          stage: string,
          details: Record<string, unknown> = {},
        ): string =>
          JSON.stringify({
            stage,
            pid: process.pid,
            launchId: config.launchId,
            caseId: config.caseId,
            fixturePid: config.fixturePid,
            wallTime: new Date().toISOString(),
            monotonicNs: process.hrtime.bigint().toString(),
            ...details,
          }) + '\n';
        const appendLine = (candidate: string): boolean => {
          if (stopped) return false;
          try {
            let line = candidate;
            const lineBytes = Buffer.byteLength(line);
            if (
              count >= 255 ||
              lineBytes > 16384 ||
              size + lineBytes > 127 * 1024
            ) {
              line = JSON.stringify({ stage: 'observer-truncated' }) + '\n';
              stopped = true;
            }
            fs.appendFileSync(config.file, line);
            count++;
            size += Buffer.byteLength(line);
            return line === candidate;
          } catch {
            stopped = true;
            return false;
          }
        };
        const record = (
          stage: string,
          details: Record<string, unknown> = {},
        ): boolean => {
          if (stopped) return false;
          try {
            return appendLine(makeLine(stage, details));
          } catch {
            stopped = true;
            return false;
          }
        };
        record('app-identity', {
          userDataDir: app.getPath('userData'),
          expectedUserDataDir: process.env.CANOPY_DATA_DIR,
        });
        if (config.firstProjectsLoad === true) {
          const firstProjectsLoadChannel = 'canopy:e2e:first-projects-load';
          const firstProjectsLoadStopChannel =
            'canopy:e2e:first-projects-load-stop';
          const firstProjectsLoadObserverKey =
            '__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__';
          const firstProjectsLoadFile = config.firstProjectsLoadFile;
          const allowedStages = new Set([
            'projects-load-main-entered',
            'projects-load-main-resolved',
            'projects-load-main-rejected',
            'projects-load-renderer-entered',
            'projects-load-renderer-ipc-resolved',
            'projects-load-renderer-superseded',
            'projects-load-renderer-applied',
            'projects-load-renderer-error',
            'projects-load-renderer-completed',
          ]);
          const allowedErrorKinds = new Set([
            'error',
            'type-error',
            'range-error',
            'syntax-error',
            'non-error',
            'unknown',
          ]);
          const allowedErrorCodes = new Set([
            'ENOENT',
            'EACCES',
            'EPERM',
            'EIO',
            'ETIMEDOUT',
            'ECONNRESET',
            'ERR_IPC_CHANNEL_CLOSED',
            'unknown',
          ]);
          const allowedWarningCodes = new Set([
            'invalid-canopy-json',
            'workspace-load-failed',
          ]);
          const allowedPhases = new Set(['caught', 'state-preserved']);
          const allowedSettlementStages = new Set([
            'ipc',
            'post-ipc',
            'post-apply',
          ]);
          const allowedSettlements = new Set(['resolved', 'rejected']);
          const numberKeys = new Set([
            'requestOrdinal',
            'generation',
            'latestGeneration',
            'rendererSequence',
            'rendererTimeMs',
            'itemCount',
            'priorProjectCount',
            'warningCount',
            'invalidIdCount',
            'invalidWarningIdCount',
            'workspaceInspectedCount',
            'workspaceOmittedCount',
            'worktreeInspectedCount',
            'worktreeOmittedCount',
            'warningInspectedCount',
            'warningOmittedCount',
          ]);
          const booleanKeys = new Set([
            'reconciliationAlreadyAttempted',
            'silent',
            'isLoading',
            'hasHydratedProjects',
            'superseded',
            'resolvedThrough',
            'truncated',
            'worktreeCountAvailable',
            'worktreeOmittedCountAvailable',
            'warningTruncated',
          ]);
          const nestedKeys = new Set([
            'loaded',
            'merged',
            'visible',
            'applied',
            'preserved',
          ]);
          let firstProjectsLoadCount = 0;
          let firstProjectsLoadBytes = 0;
          let firstProjectsLoadSequence = 0;
          let firstProjectsLoadReleased = false;
          const safeRead = (
            input: Record<string, unknown>,
            key: string,
          ): unknown => {
            try {
              return input[key];
            } catch {
              return undefined;
            }
          };
          const safeId = (value: unknown): value is string =>
            typeof value === 'string' &&
            value.length <= 128 &&
            /^[a-z0-9._-]+$/i.test(value);
          const sanitizeDetails = (
            input: unknown,
          ): Record<string, unknown> | undefined => {
            if (!input || typeof input !== 'object' || Array.isArray(input))
              return undefined;
            if (!isRecord(input)) return undefined;
            const source = input;
            let remainingWorkspaceIds = 8;
            let remainingWorktreeIds = 32;
            let remainingWarnings = 8;
            let remainingWorkspaceInspections = 16;
            let remainingWorktreeInspections = 64;
            let remainingWarningInspections = 16;
            const sanitizeObject = (
              value: unknown,
              depth = 0,
            ): Record<string, unknown> => {
              if (depth > 1 || !isRecord(value) || Array.isArray(value))
                return {};
              const object = value;
              const projected: Record<string, unknown> = {};
              for (const key of Array.from(numberKeys)) {
                const candidate = safeRead(object, key);
                if (
                  typeof candidate === 'number' &&
                  Number.isFinite(candidate) &&
                  candidate >= 0
                )
                  projected[key] = candidate;
              }
              for (const key of Array.from(booleanKeys)) {
                const candidate = safeRead(object, key);
                if (typeof candidate === 'boolean') projected[key] = candidate;
              }
              for (const [key, allowed] of [
                ['errorKind', allowedErrorKinds],
                ['errorCode', allowedErrorCodes],
                ['phase', allowedPhases],
                ['settlementStage', allowedSettlementStages],
                ['settlement', allowedSettlements],
              ] as const) {
                const candidate = safeRead(object, key);
                if (typeof candidate === 'string' && allowed.has(candidate))
                  projected[key] = candidate;
              }
              const documentId = safeRead(object, 'documentId');
              if (safeId(documentId)) projected.documentId = documentId;
              for (const [key, remaining] of [
                ['workspaceIds', (): number => remainingWorkspaceIds],
                ['worktreeIds', (): number => remainingWorktreeIds],
              ] as const) {
                const rawValues = safeRead(object, key);
                if (!Array.isArray(rawValues)) continue;
                const values: unknown[] = rawValues;
                const ids: string[] = [];
                let length: number;
                try {
                  length = values.length;
                } catch {
                  projected[
                    `receiver${key === 'workspaceIds' ? 'Workspace' : 'Worktree'}CountAvailable`
                  ] = false;
                  continue;
                }
                let inspected = 0;
                for (
                  let index = 0;
                  index < length &&
                  remaining() > 0 &&
                  (key === 'workspaceIds'
                    ? remainingWorkspaceInspections > 0
                    : remainingWorktreeInspections > 0);
                  index++
                ) {
                  inspected++;
                  if (key === 'workspaceIds') remainingWorkspaceInspections--;
                  else remainingWorktreeInspections--;
                  const candidate: unknown = ((): unknown => {
                    try {
                      return values[index];
                    } catch {
                      return undefined;
                    }
                  })();
                  if (!safeId(candidate)) continue;
                  ids.push(candidate);
                  if (key === 'workspaceIds') remainingWorkspaceIds--;
                  else remainingWorktreeIds--;
                }
                projected[key] = ids;
                const prefix =
                  key === 'workspaceIds' ? 'Workspace' : 'Worktree';
                projected[`receiver${prefix}InspectedCount`] = inspected;
                projected[`receiver${prefix}OmittedCount`] = Math.max(
                  0,
                  length - inspected,
                );
                if (length > inspected) projected.truncated = true;
              }
              const warnings = safeRead(object, 'warningIdentities');
              if (Array.isArray(warnings)) {
                const identities: Array<Record<string, string>> = [];
                let warningLength: number;
                try {
                  warningLength = warnings.length;
                } catch {
                  warningLength = 0;
                }
                let warningInspectedCount = 0;
                for (
                  let index = 0;
                  index < warningLength &&
                  remainingWarnings > 0 &&
                  remainingWarningInspections > 0;
                  index++
                ) {
                  warningInspectedCount++;
                  remainingWarningInspections--;
                  let warning: unknown;
                  try {
                    warning = warnings[index];
                  } catch {
                    continue;
                  }
                  if (!isRecord(warning) || Array.isArray(warning)) continue;
                  const workspaceId = safeRead(warning, 'workspaceId');
                  const code = safeRead(warning, 'code');
                  const identity: Record<string, string> = {};
                  if (remainingWorkspaceIds > 0 && safeId(workspaceId)) {
                    identity.workspaceId = workspaceId;
                    remainingWorkspaceIds--;
                  }
                  if (typeof code === 'string' && allowedWarningCodes.has(code))
                    identity.code = code;
                  identities.push(identity);
                  remainingWarnings--;
                }
                projected.warningIdentities = identities;
                projected.receiverWarningInspectedCount = warningInspectedCount;
                projected.receiverWarningOmittedCount = Math.max(
                  0,
                  warningLength - warningInspectedCount,
                );
                if (warningLength > warningInspectedCount)
                  projected.warningTruncated = true;
              }
              for (const key of Array.from(nestedKeys)) {
                const nested = safeRead(object, key);
                if (
                  nested &&
                  typeof nested === 'object' &&
                  !Array.isArray(nested)
                )
                  projected[key] = sanitizeObject(nested, depth + 1);
              }
              return projected;
            };
            return sanitizeObject(source);
          };
          const senderIdentity = (event: {
            sender?: WebContents;
            senderFrame?: Electron.WebFrameMain | null;
          }): Record<string, number> | undefined => {
            try {
              const window = getMainWindow();
              if (
                !window ||
                window.isDestroyed() ||
                event.sender !== window.webContents ||
                !event.senderFrame ||
                event.senderFrame !== event.sender.mainFrame
              )
                return undefined;
              return {
                senderWebContentsId: event.sender.id,
                senderFrameRoutingId: event.senderFrame.routingId,
                senderFrameProcessId: event.senderFrame.processId,
              };
            } catch {
              return undefined;
            }
          };
          const writeSummary = (reason: string): void => {
            if (!firstProjectsLoadFile) return;
            try {
              const line =
                JSON.stringify({
                  stage: 'projects-load-observer-summary',
                  reason,
                  regularEventCount: firstProjectsLoadCount,
                  regularBytes: firstProjectsLoadBytes,
                }) + '\n';
              const bytes = Buffer.byteLength(line);
              if (firstProjectsLoadBytes + bytes <= 65536)
                fs.appendFileSync(firstProjectsLoadFile, line);
            } catch {
              /* Disk failure makes the summary unavailable. */
            }
          };
          const writeFirstProjectsLoad = (
            event: {
              sender?: WebContents;
              senderFrame?: Electron.WebFrameMain | null;
            },
            source: 'main' | 'renderer',
            stage: unknown,
            rawDetails: unknown,
          ): void => {
            if (
              firstProjectsLoadReleased ||
              typeof stage !== 'string' ||
              !allowedStages.has(stage) ||
              !firstProjectsLoadFile
            )
              return;
            const sender = senderIdentity(event);
            if (!sender) return;
            const details = sanitizeDetails(rawDetails);
            if (!details) return;
            try {
              const line =
                JSON.stringify({
                  stage,
                  source,
                  pid: process.pid,
                  launchId: config.launchId,
                  caseId: config.caseId,
                  fixturePid: config.fixturePid,
                  sequence: firstProjectsLoadSequence + 1,
                  receiverWallTime: new Date().toISOString(),
                  receiverMonotonicNs: process.hrtime.bigint().toString(),
                  ...sender,
                  ...details,
                }) + '\n';
              const bytes = Buffer.byteLength(line);
              if (
                firstProjectsLoadCount >= 96 ||
                bytes > 8192 ||
                firstProjectsLoadBytes + bytes > 64512
              ) {
                writeSummary(
                  bytes > 8192 ? 'event-oversize' : 'stream-overflow',
                );
                releaseFirstProjectsLoad();
                return;
              }
              fs.appendFileSync(firstProjectsLoadFile, line);
              firstProjectsLoadCount++;
              firstProjectsLoadBytes += bytes;
              firstProjectsLoadSequence++;
            } catch {
              releaseFirstProjectsLoad();
            }
          };
          const observeMainProjectsLoad = (
            event: Electron.IpcMainInvokeEvent,
            stage: string,
            details: Record<string, unknown>,
          ): void => {
            writeFirstProjectsLoad(event, 'main', stage, details);
          };
          const receiveFirstProjectsLoad = (
            event: Electron.IpcMainEvent,
            stage: unknown,
            details: unknown,
          ): void => {
            writeFirstProjectsLoad(event, 'renderer', stage, details);
          };
          const teardownFirstProjectsLoad = (): void => {
            writeSummary('teardown');
            releaseFirstProjectsLoad();
          };
          const releaseFirstProjectsLoad = (): void => {
            if (firstProjectsLoadReleased) return;
            firstProjectsLoadReleased = true;
            try {
              const window = getMainWindow();
              if (window && !window.isDestroyed())
                sendToWebContents(
                  window.webContents,
                  firstProjectsLoadStopChannel,
                );
            } catch {
              /* Renderer stop delivery is best effort; persistence is retired. */
            }
            clearTimeout(firstProjectsLoadTimer);
            ipcMain.removeListener(
              firstProjectsLoadChannel,
              receiveFirstProjectsLoad,
            );
            app.removeListener('quit', teardownFirstProjectsLoad);
            const descriptor = Object.getOwnPropertyDescriptor(
              globalThis,
              firstProjectsLoadObserverKey,
            );
            if (descriptor?.value === observeMainProjectsLoad)
              Reflect.deleteProperty(globalThis, firstProjectsLoadObserverKey);
          };
          Object.defineProperty(globalThis, firstProjectsLoadObserverKey, {
            configurable: true,
            value: observeMainProjectsLoad,
          });
          ipcMain.on(firstProjectsLoadChannel, receiveFirstProjectsLoad);
          app.once('quit', teardownFirstProjectsLoad);
          const firstProjectsLoadTimer = setTimeout(() => {
            writeSummary('observer-expired');
            releaseFirstProjectsLoad();
          }, 60000);
          firstProjectsLoadTimer.unref();
        }
        if (config.mode === 'close') {
          const inventory = (stage: string): void => {
            try {
              const windows = BrowserWindow.getAllWindows();
              const contents = webContents.getAllWebContents();
              record(stage, {
                windowCount: windows.length,
                webContentsCount: contents.length,
                windows: windows.slice(0, 32).map((win) => {
                  try {
                    return win.isDestroyed()
                      ? { id: win.id, status: 'destroyed' }
                      : {
                          id: win.id,
                          webContentsId: win.webContents.id,
                          status: 'present',
                        };
                  } catch {
                    return { status: 'unavailable' };
                  }
                }),
                webContents: contents.slice(0, 64).map((wc) => {
                  try {
                    return { id: wc.id, type: wc.getType() };
                  } catch {
                    return { status: 'unavailable' };
                  }
                }),
                owners: (config.owners ?? []).map((owner) =>
                  captureBrowserBoundary(
                    getBrowserService(),
                    windows.slice(0, 32),
                    owner,
                  ),
                ),
                truncated: windows.length > 32 || contents.length > 64,
              });
            } catch {
              record(stage, { status: 'unavailable' });
            }
          };
          const beforeQuit = (): void => {
            record('main.before-quit');
            inventory('close-entry-inventory');
          };
          const willQuit = (): void => {
            record('main.will-quit');
            inventory('will-quit-inventory');
          };
          const quit = (): void => {
            record('main.quit');
            inventory('quit-inventory');
          };
          app.on('before-quit', beforeQuit);
          app.on('will-quit', willQuit);
          app.on('quit', quit);
          const release = (): void => {
            clearTimeout(timer);
            app.removeListener('before-quit', beforeQuit);
            app.removeListener('will-quit', willQuit);
            app.removeListener('quit', quit);
            app.removeListener('quit', release);
            Reflect.deleteProperty(
              globalThis,
              '__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__',
            );
          };
          Object.defineProperty(
            globalThis,
            '__CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS__',
            {
              configurable: true,
              value: (stage: string): void => {
                record(stage);
                if (stage === 'close-entry') inventory('pre-close-inventory');
              },
            },
          );
          app.once('quit', release);
          const timer = setTimeout(() => {
            release();
            record('observer-expired');
          }, 180000);
          timer.unref();
        } else if (config.mode === 'loaded-task') {
          try {
            observeLoadedTaskReset(
              getBrowserService(),
              getBrowserProfileService(),
              config.owners ?? [],
              (row) => record('operation', row),
            );
            record('loaded-task-observer-armed');
          } catch {
            record('loaded-task-observer-unavailable');
          }
        } else if (config.mode === 'screenshot') {
          const callbackKey = '__CANOPY_E2E_BROWSER_SCREENSHOT_DIAGNOSTICS__';
          const screenshotStage = 'browser-screenshot-observation';
          const screenshotMaximumRows = 64;
          const screenshotMaximumBytes = 81920;
          const screenshotMarkerReserveBytes = 512;
          let screenshotRows = 0;
          let screenshotBytes = 0;
          let screenshotReleased = false;
          const releaseScreenshot = (): void => {
            if (screenshotReleased) return;
            screenshotReleased = true;
            app.removeListener('quit', releaseScreenshot);
            const descriptor = Object.getOwnPropertyDescriptor(
              globalThis,
              callbackKey,
            );
            if (
              descriptor &&
              Object.prototype.hasOwnProperty.call(descriptor, 'value') &&
              descriptor.value === screenshotCallback
            ) {
              Reflect.deleteProperty(globalThis, callbackKey);
            }
          };
          const writeScreenshotMarker = (): void => {
            if (screenshotRows >= screenshotMaximumRows) {
              releaseScreenshot();
              return;
            }
            const line = makeLine(screenshotStage, {
              phase: 'observer-truncated',
            });
            const lineBytes = Buffer.byteLength(line);
            if (
              screenshotBytes + lineBytes <= screenshotMaximumBytes &&
              appendLine(line)
            ) {
              screenshotRows++;
              screenshotBytes += lineBytes;
            }
            releaseScreenshot();
          };
          const read = (
            input: Record<string, unknown>,
            key: string,
          ): unknown => {
            try {
              const descriptor = Object.getOwnPropertyDescriptor(input, key);
              return descriptor &&
                Object.prototype.hasOwnProperty.call(descriptor, 'value')
                ? descriptor.value
                : undefined;
            } catch {
              return undefined;
            }
          };
          const boundedId = (
            value: unknown,
          ): { value: string; truncated: boolean } | undefined => {
            if (typeof value !== 'string') return undefined;
            let bounded = '';
            let bytes = 0;
            for (const character of value) {
              const characterBytes = Buffer.byteLength(character);
              if (bytes + characterBytes > 128) {
                return { value: bounded, truncated: true };
              }
              bounded += character;
              bytes += characterBytes;
            }
            return { value: bounded, truncated: false };
          };
          const screenshotCallback = (input: unknown): void => {
            if (
              screenshotReleased ||
              !input ||
              typeof input !== 'object' ||
              Array.isArray(input)
            )
              return;
            if (!isRecord(input)) return;
            try {
              const source = input;
              const phase = read(source, 'phase');
              if (
                ![
                  'capture-entered',
                  'capture-returned',
                  'validation',
                  'operation-threw',
                  'capture-exhausted',
                ].includes(typeof phase === 'string' ? phase : '')
              )
                return;
              const requestSequence = read(source, 'requestSequence');
              const requested = boundedId(read(source, 'requestedBrowserId'));
              const resolved = boundedId(read(source, 'resolvedBrowserId'));
              const attempt = read(source, 'attempt');
              if (
                typeof requestSequence !== 'number' ||
                !Number.isSafeInteger(requestSequence) ||
                requestSequence <= 0 ||
                !requested ||
                !resolved ||
                typeof attempt !== 'number' ||
                !Number.isInteger(attempt) ||
                attempt < 1 ||
                attempt > 3
              )
                return;
              const requestedTruncated = read(
                source,
                'requestedBrowserIdTruncated',
              );
              const resolvedTruncated = read(
                source,
                'resolvedBrowserIdTruncated',
              );
              const projected: Record<string, unknown> = {
                phase,
                requestSequence,
                requestedBrowserId: requested.value,
                requestedBrowserIdTruncated:
                  requested.truncated || requestedTruncated === true,
                resolvedBrowserId: resolved.value,
                resolvedBrowserIdTruncated:
                  resolved.truncated || resolvedTruncated === true,
                attempt,
              };
              for (const key of ['webContentsId', 'hostWindowId']) {
                const value = read(source, key);
                if (
                  value === null ||
                  (typeof value === 'number' &&
                    Number.isSafeInteger(value) &&
                    value > 0)
                )
                  projected[key] = value;
              }
              const bounds = read(source, 'stateBounds');
              if (bounds === null) projected.stateBounds = null;
              else if (isRecord(bounds) && !Array.isArray(bounds)) {
                try {
                  const x = read(bounds, 'x');
                  const y = read(bounds, 'y');
                  const width = read(bounds, 'width');
                  const height = read(bounds, 'height');
                  if ([x, y, width, height].every(Number.isFinite)) {
                    projected.stateBounds = { x, y, width, height };
                  } else {
                    projected.projectionUnavailable = 'state-bounds';
                  }
                } catch {
                  projected.projectionUnavailable = 'state-bounds';
                }
              }
              const stateVisible = read(source, 'stateVisible');
              if (stateVisible === null || typeof stateVisible === 'boolean')
                projected.stateVisible = stateVisible;
              if (phase === 'capture-entered' || phase === 'capture-returned') {
                const projectRectangle = (key: string): void => {
                  const candidate = read(source, key);
                  if (candidate === null) {
                    projected[key] = null;
                    return;
                  }
                  if (!isRecord(candidate) || Array.isArray(candidate)) return;
                  const x = read(candidate, 'x');
                  const y = read(candidate, 'y');
                  const width = read(candidate, 'width');
                  const height = read(candidate, 'height');
                  if ([x, y, width, height].every(Number.isFinite)) {
                    projected[key] = { x, y, width, height };
                  }
                };
                for (const key of [
                  'viewBounds',
                  'hostBounds',
                  'hostContentBounds',
                  'contentViewBounds',
                ]) {
                  projectRectangle(key);
                }
                for (const key of [
                  'viewVisible',
                  'webContentsDestroyed',
                  'hostDestroyed',
                  'hostVisible',
                  'hostMinimized',
                  'contentViewVisible',
                  'directChildOverflow',
                ]) {
                  const value = read(source, key);
                  if (value === null || typeof value === 'boolean') {
                    projected[key] = value;
                  }
                }
                for (const [key, maximum] of [
                  ['directChildCount', Number.MAX_SAFE_INTEGER],
                  ['directChildInspectedCount', 32],
                ] as const) {
                  const value = read(source, key);
                  if (
                    value === null ||
                    (typeof value === 'number' &&
                      Number.isSafeInteger(value) &&
                      value >= 0 &&
                      value <= maximum)
                  ) {
                    projected[key] = value;
                  }
                }
                const directChildMembership = read(
                  source,
                  'directChildMembership',
                );
                if (
                  [
                    'present',
                    'absent',
                    'unknown-overflow',
                    'unavailable',
                  ].includes(
                    typeof directChildMembership === 'string'
                      ? directChildMembership
                      : '',
                  )
                ) {
                  projected.directChildMembership = directChildMembership;
                }
                const nativeGeometryUnavailable = read(
                  source,
                  'nativeGeometryUnavailable',
                );
                const allowed = [
                  'view-bounds',
                  'view-visible',
                  'web-contents-destroyed',
                  'host-destroyed',
                  'host-visible',
                  'host-minimized',
                  'host-bounds',
                  'host-content-bounds',
                  'content-view-bounds',
                  'content-view-visible',
                  'direct-children',
                ];
                if (
                  typeof nativeGeometryUnavailable === 'string' &&
                  nativeGeometryUnavailable.length > 0 &&
                  nativeGeometryUnavailable.length <= allowed.join(',').length
                ) {
                  const codes = nativeGeometryUnavailable.split(',');
                  const canonicalCodes = allowed.filter((code) =>
                    codes.includes(code),
                  );
                  if (
                    codes.length === new Set(codes).size &&
                    codes.every((code) => allowed.includes(code)) &&
                    codes.join(',') === canonicalCodes.join(',')
                  ) {
                    projected.nativeGeometryUnavailable =
                      nativeGeometryUnavailable;
                  }
                }
              }
              for (const key of [
                'captureEnteredNs',
                'captureReturnedNs',
                'validationNs',
              ]) {
                const value = read(source, key);
                if (typeof value === 'string' && /^\d{1,32}$/.test(value))
                  projected[key] = value;
              }
              const liveSessionAssertion = read(source, 'liveSessionAssertion');
              if (liveSessionAssertion === 'passed')
                projected.liveSessionAssertion = liveSessionAssertion;
              for (const key of [
                'imageEmpty',
                'encodingPrefixValid',
                'encodingNonempty',
              ]) {
                const value = read(source, key);
                if (
                  typeof value === 'boolean' ||
                  value === 'not-evaluated' ||
                  value === 'operation-threw'
                )
                  projected[key] = value;
              }
              const dataUrlLength = read(source, 'dataUrlLength');
              if (
                typeof dataUrlLength === 'number' &&
                Number.isSafeInteger(dataUrlLength) &&
                dataUrlLength >= 0
              )
                projected.dataUrlLength = dataUrlLength;
              const operation = read(source, 'operation');
              if (
                [
                  'capture-page',
                  'post-capture-live-session-assertion',
                  'to-data-url',
                  'to-png',
                  'is-empty',
                  'invalidate',
                  'post-invalidate-live-session-assertion',
                ].includes(typeof operation === 'string' ? operation : '')
              )
                projected.operation = operation;
              if (read(source, 'outcome') === 'threw')
                projected.outcome = 'threw';
              const thrownType = read(source, 'thrownType');
              if (
                [
                  'undefined',
                  'object',
                  'boolean',
                  'number',
                  'bigint',
                  'string',
                  'symbol',
                  'function',
                  'null',
                ].includes(typeof thrownType === 'string' ? thrownType : '')
              )
                projected.thrownType = thrownType;
              const projectionUnavailable = read(
                source,
                'projectionUnavailable',
              );
              if (
                typeof projectionUnavailable === 'string' &&
                projectionUnavailable.length <= 128
              )
                projected.projectionUnavailable = projectionUnavailable;
              const line = makeLine(screenshotStage, projected);
              const lineBytes = Buffer.byteLength(line);
              if (
                screenshotRows >= screenshotMaximumRows - 1 ||
                screenshotBytes + lineBytes + screenshotMarkerReserveBytes >
                  screenshotMaximumBytes
              ) {
                writeScreenshotMarker();
                return;
              }
              if (!appendLine(line)) {
                releaseScreenshot();
                return;
              }
              screenshotRows++;
              screenshotBytes += lineBytes;
            } catch {
              /* The trusted synchronous observer must remain nonthrowing. */
            }
          };
          if (!stopped) {
            Object.defineProperty(globalThis, callbackKey, {
              configurable: true,
              value: screenshotCallback,
            });
            app.once('quit', releaseScreenshot);
          } else {
            screenshotReleased = true;
          }
        }
      } catch {
        /* Bounded optional observation must not block startup. */
      }
    }
  }
  const activeDesktopCanopyRuntime = desktopCanopyRuntime;
  bindConfiguredPromptFilesystemDispatcher(activeDesktopCanopyRuntime);
  bindLedgerToolsDispatcher(activeDesktopCanopyRuntime);
  if (__CANOPY_E2E__ && process.env.CANOPY_E2E_SEED_LIFETIME_LIMIT_FIXTURE) {
    const { seedDelegationLifetimeLimitFixture } =
      await import('./e2e-fixtures/lifetime-limit-fixture');
    await seedDelegationLifetimeLimitFixture();
  }
  if (__CANOPY_E2E__ && process.env.CANOPY_E2E_SEED_STREAM_FIXTURE) {
    const { seedDelegationStreamFixture } =
      await import('./e2e-fixtures/delegation-stream-fixture');
    await seedDelegationStreamFixture(getChatStateService());
  }
  closeCanopyCloudSessionStatusPush = subscribeCanopyCloudSessionStatus(
    (): void => {
      sendToAllWindows(IPC_CHANNELS.settingsCanopyCloudSessionStatusChanged);
    },
  );
  closeChatStatePush = registerAllIpcHandlers(
    {
      getMainWindow,
      overlayLayerHost,
      isOverlayLayerOpener: (contents): boolean =>
        (mainWindow !== null &&
          !mainWindow.isDestroyed() &&
          contents === mainWindow.webContents) ||
        (appAdvisorViewContents !== null &&
          contents === appAdvisorViewContents),
      getAppAdvisorWindow,
      openAppAdvisorWindow,
      ensureAppAdvisorWindow,
      closeAppAdvisorWindow,
      toggleAppAdvisorWindow,
      getAppAdvisorWindowState,
      markAppAdvisorWindowRendererReady,
      setAppAdvisorFloatingSize,
      setAppAdvisorDock,
      sendAppAdvisorWindowCommand,
      sendChatWindowCommand,
      appAdvisorWorkspaceOperations: {
        settingsLoad: loadAppAdvisorWorkspaceSettings,
        settingsSave: saveAppAdvisorWorkspaceSettings,
        loadClaudeMd: readAppAdvisorClaudeMd,
        saveClaudeMd: saveAppAdvisorClaudeMd,
      },
      chatStatePort: getChatStateService(),
      installScopePinProvider: (provider): (() => void) =>
        getChatStateService().setScopePinProvider(provider),
      isMainWindowRendererReady: (): boolean => mainWindowRendererReady,
      // Browser views < overlay layers < floating App Advisor.
      onBrowserViewAttached: (window: BrowserWindow): void => {
        overlayLayerHost.raise(window);
        appAdvisorHost?.raise(window);
      },
      unsavedCloseGuard,
      // Deep-link unlock is intentionally outside unlockStartupWork's
      // idempotence guard: every fresh renderer process sends this IPC once,
      // so a link buffered while the app sat windowless is retried when a new
      // window's renderer comes up.
      notifyStartupUnlocked: (): void => {
        startResumeQueue();
        mainWindowRendererReady = true;
        mainWindowPageDown = false;
        // The main window mirrors App Advisor's notifications again.
        broadcastAppAdvisorWindowState();
        flushPendingAutoArchiveNotifications();
        unlockStartupWork();
        void getAppAdvisorWatcherService().reconcileAtStartup();
        replayHookChatPlaceholders(getMainWindow());
        void getAppAdvisorWatcherService()
          .resumePresenterHeldDeliveries()
          .catch((error: unknown) =>
            logMainProcessWarn(
              '[watchers] Held watcher deliveries could not resume.',
              error,
            ),
          );
        notifyDeepLinkStartupUnlocked();
        flushPendingOrgProjectDeepLink();
        // Same retry rationale as deep links: a campaign click buffered while
        // the app sat windowless is delivered once a renderer comes up.
        notifyCampaignClickStartupUnlocked();
      },
    },
    {
      dispatcher: activeDesktopCanopyRuntime,
      daemonGitRoute: getDesktopDaemonGitRoute,
      resolveRelaySurface: (event) => {
        const devUrl = is.dev
          ? process.env['ELECTRON_RENDERER_URL']
          : undefined;
        const packagedUrls = rendererOrigin.trustedRendererPageUrls();
        return resolveTrustedRelaySurface(
          event,
          [
            {
              surface: 'main',
              window: getMainWindow(),
              url: devUrl ?? packagedUrls[0] ?? '',
            },
            {
              surface: 'app-advisor',
              window: getAppAdvisorRendererSurface(),
              url: devUrl
                ? appAdvisorDevServerUrl(devUrl)
                : (packagedUrls[1] ?? ''),
            },
          ],
          RENDERER_RELAY_GRANTS,
        );
      },
      resolveCaller: (event) =>
        deriveDesktopIpcCaller(event, {
          getAppWindows: () => [
            getMainWindow(),
            getAppAdvisorRendererSurface(),
          ],
          resolveRemoteBridgeSender,
          // Exactly the two window pages, on this launch's origin.
          packagedRendererUrls: rendererOrigin.trustedRendererPageUrls(),
          devServerUrl: is.dev
            ? process.env['ELECTRON_RENDERER_URL']
            : undefined,
        }),
    },
  );
  // Queued chats recovered at startup drain once core accepts turns and the
  // chat dispatch hooks (Auto model routing among them) are installed
  // (CAN-4112); no window is needed.
  const { getChatQueueService: getStartupChatQueue } =
    await import('./services/chat-queue-service');
  getStartupChatQueue().releaseStartupDrainHold();
  // Git HEAD observation runs in main, independent of the renderer. Every
  // build, E2E included, enrolls at the first projects:load or the
  // first-paint fallback, so perf measures the production trigger (CAN-4899).
  startWorktreeBranchObserver({
    dispatcher: activeDesktopCanopyRuntime,
    getWindow: getMainWindow,
  });
  // A paired computer mirrors the main window, so its bridge answers the
  // approval prompts that window shows. App Advisor prompts stay local.
  setApprovalOwnerResolver((sender) => {
    const win = getMainWindow();
    return win &&
      'id' in sender &&
      typeof sender.id === 'number' &&
      resolveRemoteBridgeSender({ id: sender.id }) !== null
      ? rendererContentsOf(win.webContents)
      : sender;
  });
  registerPipelineHandlers();
  // Device-to-device remote control: idle until the user allows incoming
  // control or pairs a computer to control. A failure here must not block
  // startup.
  try {
    initializeRemoteControl({
      getMainWindow,
      showMainWindow: showMainWindowFromRemoteWindow,
      iconPath: getIconPath(),
      isAppQuitting: (): boolean => appIsQuitting,
      // A controller's App Advisor window opens on the same data as this
      // computer's: the commands resolve here and run in its window.
      appAdvisorRequestCommands: sendAppAdvisorWindowRequestCommands,
      // The single Remote Control opt-in also starts and ends Portal; its
      // own flag still decides whether it may start.
      portal: {
        isEnabled: (): boolean =>
          getFeatureFlagService().isEnabled(
            CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
          ),
        start: async (): Promise<void> => {
          if (getCanopyPortalState().status !== 'disabled') return;
          await startCanopyPortal();
        },
        stop: async (): Promise<void> => {
          if (getCanopyPortalState().status === 'disabled') return;
          await stopCanopyPortal('local_disconnect');
        },
      },
    });
  } catch (error) {
    logMainProcessError('Remote control failed to start', error);
  }
  registerExecutionHandlers(() => mainWindow, getAppAdvisorRendererSurface);
  registerPluginHandlers();
  registerSkillHandlers();

  getWakeLockService().setEnabled(preferences.keepSystemAwakeWhileAgentsActive);
  configureMemoryDiagnostics({
    getAppRenderers: (): readonly MemoryDiagnosticsRendererTarget[] => {
      const targets: MemoryDiagnosticsRendererTarget[] = [];
      const main = getMainWindow();
      if (main && !main.isDestroyed() && !main.webContents.isDestroyed()) {
        targets.push({ label: 'main', webContents: main.webContents });
      }
      // Advisor's one page moves between its pop-out and the floating panel.
      // Its blank shell, browser/preview pages and remote bridges are not app pages.
      const advisor = getAppAdvisorRendererSurface();
      if (
        advisor &&
        !advisor.isDestroyed() &&
        !advisor.webContents.isDestroyed()
      ) {
        targets.push({
          label: 'app-advisor',
          webContents: advisor.webContents,
        });
      }
      return targets;
    },
  });
  getMemoryDiagnosticsService().setEnabled(
    preferences.memoryDiagnosticsEnabled,
  );
  getBrowserService()?.setLocalServersOnly(
    preferences.inAppBrowserLocalServersOnly === true,
  );
  updatePerformanceLimitsFromPreferences(preferences);
  setCloseToTrayPreference(preferences.closeToTray);
  getGlobalFocusShortcutService().apply({
    enabled: preferences.globalFocusShortcutEnabled,
    accelerator: preferences.globalFocusShortcut,
  });
  await getDefaultBrowserRegistrationService().refresh();
  setActivationJourneyFlagEnabled(
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyActivationJourneyEnabled.key,
    ),
  );
  // Register how to build the tray unconditionally, so enabling close-to-tray
  // later in Settings can create one without restarting the app.
  setTrayOptions({
    icon: getIconPath(),
    appName: BRAND.displayName,
    onOpen: (): void => {
      bringAppWindowForward(resolveTrayOpenTarget(appActivationWindows()));
    },
    onQuit: (): void => {
      app.quit();
    },
  });
  // Without a tray there is no way back to a windowless app, so fall back to
  // quit-on-close rather than stranding the user in a running-but-invisible
  // process.
  if (!syncActivationTray()) {
    setCloseToTrayPreference(false);
  }
  // Seed the codex app-server pool with the persisted idle timeout. Preference
  // side effects only run on save, so without this the pool (and every
  // connection created this launch) would run on the built-in default until
  // the user next touched preferences.
  getCodexRuntimeService()
    .admin()
    .updateIdleTimeoutMinutes(preferences.codexAppServerIdleTimeoutMinutes);
  updateClaudeSessionIdleTimeoutMinutes(
    preferences.claudeSessionIdleTimeoutMinutes,
  );
  await rendererOriginDecided;
  createWindowWithState(preferences);
  // The scheduler runs its first sweep immediately. Start it only after the
  // initial renderer exists so completion and failure notifications cannot be
  // discarded during startup.
  autoArchiveScheduler ??= startAutoArchiveScheduler();
  // Count this launch toward the guest-upgrade nudge threshold when the saved
  // credential is a guest credential (CAN-936, WS3). Fire-and-forget so it never
  // delays window creation; main-process placement avoids renderer double-count.
  void incrementGuestSessionCountOnLaunch();
  // Activation notification journey (CAN-1967). Fire-and-forget so scheduling
  // never delays window creation; the scheduler re-derives everything from
  // persisted wall-clock, so a late start costs nothing.
  void initializeActivationJourney({
    getMainWindow: () => mainWindow,
    createMainWindow: () => {
      void readPreferencesFile().then((prefs) => {
        if (mainWindow === null || mainWindow.isDestroyed()) {
          createWindowWithState(prefs);
        }
      });
    },
    focusMainWindow,
  }).catch(() => undefined);
  // Apply the initial Remote Control gate to cloud inventory sync (CAN-2830)
  // before it starts, and re-apply it whenever the Labs Remote access switch
  // changes, since direct Remote Control opens the gate too (CAN-6037). The
  // listener lives for the process: after dispose the service ignores it.
  applySyncServiceFeatureFlags(
    getFeatureFlagService().getSnapshot().values,
    { inventory: getDesktopInventorySyncService() },
    { remoteAccessEnabled: isRemoteControlEnabled() },
  );
  onRemoteControlEnabledChanged((enabled): void => {
    applySyncServiceFeatureFlags(
      getFeatureFlagService().getSnapshot().values,
      { inventory: getDesktopInventorySyncService() },
      { remoteAccessEnabled: enabled },
    );
  });
  getDesktopInventorySyncService().start();
  // Agent Ledger sync (LD01, LD02): a scheduled check only; it reads nothing
  // until then, and nothing at all before the Ledger database exists.
  setLedgerSyncProhibitionHandler((): void => {
    void reprobeAndApplyCanopyCloudEnforcedSettings().catch(() => undefined);
  });
  setLedgerSyncEnabled(
    getFeatureFlagService().isEnabled(
      CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
    ),
  );
  // Cloud memory sync (CAN-5185): runs only for an account carrying
  // memory-sync-v1, and waits out the launch quiet period before any request.
  startMemorySync();
  setLedgerPendingTitleScheduler(enqueueDesktopPendingTitle);
  startDesktopPendingTitleOrchestrator({
    isEnabled: (): boolean =>
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key,
      ),
  });

  app.on('activate', () => {
    bringAppWindowForward(resolveAppActivationTarget(appActivationWindows()));
  });

  app.on('child-process-gone', (_event, details): void => {
    getExecutionObservabilityIngest().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'child_process_gone',
      reason: details.reason,
      exitCode: details.exitCode,
      processType: details.type,
      ...(details.serviceName ? { serviceName: details.serviceName } : {}),
      ...(details.name ? { processName: details.name } : {}),
    });
  });
});

if (hasSingleInstanceLock) {
  app.on('before-quit', (event): void => {
    if (appIsQuitting) {
      if (drainedProcessExitGuard?.handleRepeatedQuit()) return;
      if (!runtimeCleanupComplete) event.preventDefault();
      return;
    }

    // Before cleanup crosses its one-way gates, give unsaved workflow edits a
    // chance. The updater's quit-and-install and fatal exits run cleanup first,
    // so they arrive here already quitting and are never held.
    if (
      unsavedCloseGuard.intercept(
        event,
        'quit',
        { quitting: appIsQuitting, hidingToTray: false },
        (): void => {
          app.quit();
        },
      )
    ) {
      return;
    }

    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'before_quit',
    });

    event.preventDefault();
    void cleanupRuntimeResources('app-quit')
      .then((): void => {
        app.quit();
      })
      .catch(() => {
        // Cleanup closes one-way admission gates and tears down process-lifetime
        // services. Continuing to run would leave a permanently wedged window.
        app.exit(0);
      });
  });
}

/**
 * One-time notice: a user who closes the window and sees nothing reasonably
 * concludes the app quit. Only stamps `closeToTrayDisclosedAt` once, and only
 * when a tray actually exists -- promising a tray icon that failed to be
 * created would strand the user with no window and no way back.
 */
function maybeDiscloseCloseToTray(): void {
  void readPreferencesFile()
    .then(async (prefs) => {
      if (
        !shouldDiscloseCloseToTray({
          disclosedAt: prefs.closeToTrayDisclosedAt,
        })
      ) {
        return;
      }
      if (!discloseCloseToTray(BRAND.displayName)) return;
      await writePreferencesFile({
        closeToTrayDisclosedAt: new Date().toISOString(),
      });
    })
    .catch(() => undefined);
}

if (hasSingleInstanceLock)
  app.on('window-all-closed', () => {
    // Windows historically quit here, which meant a closed window ended every
    // scheduled campaign and background task. Close-to-tray keeps the app
    // resident; macOS is unchanged and never quits on this event.
    if (
      shouldQuitOnAllWindowsClosed({
        platform: process.platform,
        closeToTray: isCloseToTrayEnabled(),
      })
    ) {
      app.quit();
      return;
    }
    // No disclosure here: whenever close-to-tray is active the window's `close`
    // handler prevents the close, so this event never fires in that state. Every
    // other non-darwin case quit above.
  });
