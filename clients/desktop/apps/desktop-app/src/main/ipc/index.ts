import { registerWorkEntryAutoDeleteHandlers } from './work-entry-auto-delete';
import { registerScriptActionsHandlers } from './script-actions';
import { registerLabsExperimentsHandlers } from './labs-experiments';
import { registerSidebarItemGroupHandlers } from './sidebar-item-groups';
import { registerRepoRulesHandlers } from './repo-rules';
import { registerCanopyCoreRelayHandlers } from './canopy-core-relay';
import type {
  RendererRelayEvent,
  RendererRelaySurfaceResolution,
} from '../canopy-runtime/renderer-relay/relay';
import { registerSkillShareNudgeHandlers } from './skill-share-nudge';
import { registerSkillSuggestionHandlers } from './skill-suggestions';
import { registerForeignActivityHandlers } from './foreign-activity';
import { registerSpaceNotificationHandlers } from './space-notifications';
import { registerManagedDelegationHandlers } from './managed-delegation';
import { registerNativeSubagentHandlers } from './native-subagents';
import { registerLocalMemoryHandlers } from './local-memory';
import { registerMemorySyncHandlers } from './memory-sync';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type {
  AppAdvisorWindowCommand,
  AppAdvisorWindowOpenRequest,
  AppAdvisorDockResult,
  AppAdvisorWindowState,
  ChatWindowCommand,
  ChatStateCommandPort,
} from '@canopy/desktop-shared/types';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { registerPreferenceHandlers } from './preferences';
import { registerClaudeModsHandlers } from './claude-mods';
import { registerInstalledItemHandlers } from './installed-items';
import { registerProjectHandlers } from './projects';
import { registerRepoHandlers } from './repos';
import { registerCloneJobHandlers } from './clone-jobs';
import { registerWorktreeHandlers } from './worktrees';
import type { DaemonGitRoute } from '../canopy-runtime/daemon-git-route';
import { registerWorktreeDiscardHandlers } from './worktree-discard';
import { registerWorktreeDiscoveryHandlers } from './worktree-discovery';
import { registerHomeSurfaceHandlers } from './home-surface';
import { registerFileTreeHandlers } from './file-tree';
import { registerLedgerHandlers } from './ledger';
import { registerCostHandlers } from './cost';
import { registerWorkspaceHandlers } from './workspaces';
import { registerLifecycleJournalHandlers } from './lifecycle-journal';
import { registerBundleHandlers } from './bundles';
import { registerCollectionHandlers } from '../collections/collection-handlers';
import { registerChatHandlers } from './chat';
import { registerChatProjectHandlers } from './chat-projects';
import { registerChatSearchHandlers } from './chat-search';
import { registerChatPersistenceHandlers } from './chat-persistence';
import { registerChatStateHandlers } from './chat-state';
import { remoteBridgeWindows } from '../remote-control/host/bridge-window';
import { registerChatEventOutputHandlers } from './chat-event-output';
import { registerPortalComposerCommandHandlers } from './portal-composer-command';
import { registerSessionTransferHandlers } from './session-transfer';
import { registerSettingsHandlers } from './settings';
import { registerDailyCreditDripHandlers } from './daily-credit-drip';
import { registerStandaloneChatHandlers } from './standalone-chat';
import { registerWorkEntryHandlers } from './work-entries';
import { registerActivityPanelHandlers } from './activity-panel';
import { registerPlansHandlers } from './plans';
import { registerRunsHandlers } from './runs';
import { registerSharedContainerHandlers } from './shared-containers';
import { registerDetectedPlansHandlers } from './detected-plans';
import { registerCodeReviewHandlers } from './code-review';
import { registerPlanFileVisibilityHandlers } from './plan-file-visibility';
import { registerApprovalHandlers } from './approvals';
import { registerCopilotConnectionHandlers } from './copilot-connection';
import { registerOpenCodeConnectionHandlers } from './opencode-connection';
import { registerAccountProxyHandlers } from './account-proxy';
import { registerCursorConnectionHandlers } from './cursor-connection';
import { registerCursorApprovalCheckHandlers } from './cursor-approval-check';
import { registerFileAnnotationsHandlers } from './file-annotations';
import {
  addPlanContentChangeListener,
  addPlanDiagramArtifactChangeListener,
  addPlanShareChangeListener,
} from '../lib/plan-persistence';
import { schedulePlanDiagramGeneration } from '../lib/plan-diagram-scheduler';
import {
  initializeSharedPlanSync,
  queueSharedPlanSync,
  syncPlanRealtimeSubscription,
} from '../lib/shared-plan-sync';
import { getPlanFileSyncService } from '../lib/plan-file-sync';
import { registerWorktreeSummaryHandlers } from './worktree-summary';
import { registerGitHubHandlers } from './github';
import { registerHookHandlers } from './hooks';
import { registerEditorMenuHandlers } from './editor-menus';
import { registerWorktreeActivityHandlers } from './worktree-activity';
import { registerMcpServerHandlers } from './mcp-servers';
import { registerScriptHandlers } from './scripts';
import { registerOpenInHandlers } from './open-in';
import { registerUpdateHandlers } from './update';
import { registerCliHandlers } from './cli';
import { registerObservabilityHandlers } from './observability';
import { registerTelemetrySyncHandlers } from './telemetry-sync';
import { registerWorktreeAttachmentHandlers } from './worktree-attachments';
import { registerWorkspaceItemHandlers } from './workspace-items';
import {
  registerModelRegistryHandlers,
  registerOllamaHandlers,
} from './ollama';
import { registerModelHarnessAssignmentHandlers } from './model-harness-assignments';
import { registerGitExecutableHandlers } from './git-executable';
import { registerDeepLinkHandlers } from './deep-link';
import { registerFilePreviewHandlers } from './file-preview';
import { registerOsNotificationHandlers } from './os-notifications';
import { registerVoiceHandlers } from '../voice/preload-bridge';
import { registerTerminalHandlers } from './terminal';
import { registerPanelLayoutHandlers } from './panel-layout';
import { panelLayoutModePersistenceStore } from '../panels/layout-mode-persistence';
import { registerCodexLoginHandlers } from './codex-login';
import { registerCodexSpeedHandlers } from './codex-speed';
import {
  registerOverlayLayerHandlers,
  type OverlayLayerHandlerAccessors,
} from './overlay-layer';
import { registerAuthTerminalHandlers } from './auth-terminal';
import { registerFeedbackHandlers } from './feedback';
import { registerTurnFeedbackHandlers } from './turn-feedback';
import { registerOrgMemoryHandlers } from './org-memory';
import { registerResourceMonitorHandlers } from './resource-monitor';
import { registerTerminalSettingsHandlers } from './terminal-settings';
import { registerMemoryDiagnosticsHandlers } from './memory-diagnostics';
import { registerRecommendedPluginHandlers } from './recommended-plugins';
import { registerInvocableInventoryHandlers } from './invocable-inventory';
import { registerCanopyPortalHandlers } from './canopy-portal';
import { registerFeatureFlagHandlers } from './feature-flags';
import { registerCodeGraphBuildStatusBroadcast } from './code-graph-build-status';
import { registerCodeGraphHandlers } from './code-graph';
import { registerUserEnvironmentHandlers } from './user-environment';
import { registerWakeLockHandlers } from './wake-lock';
import {
  registerAppAdvisorHandlers,
  type AppAdvisorWorkspaceOperations,
} from './app-advisor';
import { registerAppAdvisorWatcherHandlers } from './app-advisor-watchers';
import { registerPipelineEditorHandlers } from './pipeline-editor';
import { registerAutomationsHandlers } from './automations';
import { registerSlowActionHandlers } from './slow-actions';
import { registerAppWindowHandlers } from './app-window';
import type { UnsavedCloseGuard } from '../lifecycle/unsaved-close-guard';
import { registerBrowserHandlers } from './browser';
import { registerWorkerHandlers } from './workers';
import { registerAgentModelHandlers } from './agent-models';
import { registerUsageLimitedChatsHandlers } from './usage-limited-chats';
import { registerWorkspaceContextHandlers } from './workspace-context';
import { registerSharedMultiRepoHandlers } from './org-shared-multi-repo';
import { registerOrgProjectsHandlers } from './org-projects';
import { registerCloudProjectsHandlers } from './cloud-projects';
import { registerCloudChatsHandlers } from './cloud-chats';
import { registerAccountOrganizationSettingsHandlers } from './account-organization-settings';
import { registerGlobalFocusShortcutHandlers } from './global-focus-shortcut';
import { registerLaunchAtLoginHandlers } from './launch-at-login';
import { registerW5RecoveryHandlers } from './w5-recovery';
import { registerBackgroundServiceHandlers } from './background-service';
import { registerExternalProjectHandlers } from './external-projects';
import {
  disposeDesktopSessionSnapshotHandlers,
  registerDesktopSessionSnapshotHandlers,
} from './desktop-session-snapshot';
import { registerArchivedContainerHandlers } from './archived-containers';
import { initTransientErrorRetryService } from '../lib/transient-error-retry-service';
import { broadcastPipelineExecutionEvent } from '../pipelines/pipeline-execution-event-broadcaster';
import { initTransientErrorRetryScheduler } from '../pipelines/transient-error-retry-scheduler';
import { resumePipelineExecutionFromMain } from '../pipelines/pipeline-resume-service';
import { readPreferencesFile } from '../lib/preferences-store';
import { registerReferencePreviewHandlers } from './reference-previews';
import {
  getBrowserService,
  setBrowserService,
} from '../browser/browser-service';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type { ChatScopeKey } from '../services/chat-state-contracts';

export interface WindowAccessors {
  getMainWindow: () => BrowserWindow | null;
  /** Native presentation layers, each owned by the renderer that opened it. */
  overlayLayerHost?: OverlayLayerHandlerAccessors['overlayLayerHost'];
  /** Renderers allowed to drive their own layers; the main renderer by default. */
  isOverlayLayerOpener?: OverlayLayerHandlerAccessors['isOverlayLayerOpener'];
  getAppAdvisorWindow: () => BrowserWindow | null;
  openAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  ensureAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  /** `options` is untrusted renderer input (`AppAdvisorWindowCloseOptions`). */
  closeAppAdvisorWindow: (options?: unknown) => Promise<AppAdvisorWindowState>;
  toggleAppAdvisorWindow: (
    request?: AppAdvisorWindowOpenRequest,
  ) => Promise<AppAdvisorWindowState>;
  getAppAdvisorWindowState: () => AppAdvisorWindowState;
  markAppAdvisorWindowRendererReady: (
    sender?: WebContents,
  ) => AppAdvisorWindowState;
  /** Resizes the floating panel; the size is untrusted renderer input. */
  setAppAdvisorFloatingSize: (size: unknown) => AppAdvisorWindowState;
  setAppAdvisorDock: (
    sender: WebContents,
    request: unknown,
  ) => Promise<AppAdvisorDockResult>;
  sendAppAdvisorWindowCommand: (command: AppAdvisorWindowCommand) => void;
  sendChatWindowCommand: (command: ChatWindowCommand) => boolean;
  /** Backend adapter for app-managed App Advisor settings/instructions. */
  appAdvisorWorkspaceOperations?: AppAdvisorWorkspaceOperations;
  /** Main-owned revisioned chat service, injected by the backend slice. */
  chatStatePort?: ChatStateCommandPort;
  /** Installs main-window interest as an in-memory chat scope pin. */
  installScopePinProvider?: (
    provider: (scope: ChatScopeKey) => boolean,
  ) => () => void;
  /** True only after the current main-window renderer has unlocked startup. */
  isMainWindowRendererReady?: () => boolean;
  notifyStartupUnlocked: () => void;
  /** Main-window unsaved-edit close and quit guard (CAN-4072). */
  unsavedCloseGuard?: UnsavedCloseGuard;
  /** Runs after a browser view joins a window (see `BrowserServiceOptions`). */
  onBrowserViewAttached?: (window: BrowserWindow) => void;
}

export interface DesktopCanopyRuntimeAccessors {
  dispatcher: DesktopCanopyDispatcher;
  daemonGitRoute?: () => DaemonGitRoute;
  resolveCaller: (event: IpcMainInvokeEvent) => CanopyCallerDescriptor;
  resolveRelaySurface: (
    event: RendererRelayEvent,
  ) => RendererRelaySurfaceResolution;
}

export function registerAllIpcHandlers(
  accessors: WindowAccessors,
  canopyRuntime: DesktopCanopyRuntimeAccessors,
): () => void {
  const getMainWindow = accessors.getMainWindow;
  registerRepoRulesHandlers(
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );
  const closeRendererRelay = registerCanopyCoreRelayHandlers(
    canopyRuntime.dispatcher,
    canopyRuntime.resolveRelaySurface,
  );
  // The relay's web core authority rides the hosted settings bridge, so the
  // bridge must end on sign-out, account switch, key change and quit even when
  // hosted settings never registered (idempotent).
  let relayBridgeClosed = false;
  let uninstallRelayBridgeLifecycle: (() => void) | null = null;
  void import('../canopy-cloud/settings-session')
    .then(({ installSettingsBridgeLifecycle }) => {
      if (!relayBridgeClosed)
        uninstallRelayBridgeLifecycle = installSettingsBridgeLifecycle();
    })
    .catch(() => undefined);
  const closeSkillShareNudge = registerSkillShareNudgeHandlers(
    canopyRuntime.resolveCaller,
  );
  const closeSkillSuggestions = registerSkillSuggestionHandlers(
    canopyRuntime.resolveCaller,
  );
  let closeChatStatePush: () => void = () => undefined;

  initTransientErrorRetryService(getMainWindow);
  initTransientErrorRetryScheduler({
    emitEvent: broadcastPipelineExecutionEvent,
    resume: resumePipelineExecutionFromMain,
    readPreferences: readPreferencesFile,
  });

  registerProjectHandlers(
    getMainWindow,
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );
  registerDesktopSessionSnapshotHandlers(getMainWindow);
  const unsavedCloseGuard = accessors.unsavedCloseGuard;
  registerAppWindowHandlers(
    accessors.notifyStartupUnlocked,
    unsavedCloseGuard
      ? {
          guard: unsavedCloseGuard,
          isMainWindowSender: (sender): boolean => {
            const mainWindow = getMainWindow();
            return (
              mainWindow !== null &&
              !mainWindow.isDestroyed() &&
              mainWindow.webContents === sender
            );
          },
        }
      : undefined,
  );
  registerPreferenceHandlers();
  registerClaudeModsHandlers();
  registerUserEnvironmentHandlers();
  registerActivityPanelHandlers(getMainWindow, canopyRuntime);
  registerPlansHandlers(getMainWindow);
  registerRunsHandlers();
  registerSharedContainerHandlers(canopyRuntime);
  registerDetectedPlansHandlers(getMainWindow);
  registerCodeReviewHandlers(getMainWindow);
  registerPlanFileVisibilityHandlers();
  registerApprovalHandlers();
  registerCursorApprovalCheckHandlers();
  registerCursorConnectionHandlers();
  registerCopilotConnectionHandlers();
  registerOpenCodeConnectionHandlers();
  registerAccountProxyHandlers();
  registerFileAnnotationsHandlers(
    () => [accessors.getMainWindow(), accessors.getAppAdvisorWindow()],
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );
  initializeSharedPlanSync({ getWindow: getMainWindow });
  getPlanFileSyncService().configure({ getWindow: getMainWindow });
  addPlanContentChangeListener((plan) =>
    schedulePlanDiagramGeneration(plan, getMainWindow),
  );
  addPlanShareChangeListener((plan) => {
    queueSharedPlanSync(plan, 'plan');
    syncPlanRealtimeSubscription(plan);
  });
  addPlanDiagramArtifactChangeListener((plan) =>
    queueSharedPlanSync(plan, 'diagram'),
  );
  registerWorktreeSummaryHandlers(getMainWindow);
  registerBundleHandlers();
  registerCollectionHandlers();
  registerRepoHandlers(canopyRuntime);
  registerCloneJobHandlers();
  registerWorktreeHandlers(getMainWindow, canopyRuntime);
  registerWorktreeDiscardHandlers();
  registerWorktreeDiscoveryHandlers(getMainWindow);
  registerHomeSurfaceHandlers(canopyRuntime);
  registerFileTreeHandlers(
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );
  registerLedgerHandlers(canopyRuntime.dispatcher, canopyRuntime.resolveCaller);
  const closeScriptActions = registerScriptActionsHandlers(
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );
  const closeCostHandlers = registerCostHandlers(
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );
  registerWorktreeAttachmentHandlers(canopyRuntime);
  registerWorkspaceItemHandlers(canopyRuntime);
  registerWorkspaceHandlers(getMainWindow, canopyRuntime);
  registerLifecycleJournalHandlers();
  registerChatEventOutputHandlers();
  registerChatHandlers(accessors, canopyRuntime);
  registerChatProjectHandlers(canopyRuntime);
  registerChatSearchHandlers();
  registerAgentModelHandlers(getMainWindow);
  registerChatPersistenceHandlers(getMainWindow, canopyRuntime);
  if (accessors.chatStatePort) {
    closeChatStatePush = registerChatStateHandlers(
      accessors.chatStatePort,
      () => [
        accessors.getMainWindow(),
        accessors.getAppAdvisorWindow(),
        // Each remote session's bridge declares its controller's scopes.
        ...remoteBridgeWindows(),
      ],
      {
        dispatcher: canopyRuntime.dispatcher,
        resolveCaller: canopyRuntime.resolveCaller,
        installScopePinProvider: accessors.installScopePinProvider,
      },
    );
  }
  registerPortalComposerCommandHandlers();
  registerSessionTransferHandlers(getMainWindow);
  registerSettingsHandlers(canopyRuntime);
  registerDailyCreditDripHandlers();
  registerReferencePreviewHandlers();
  registerGitExecutableHandlers(getMainWindow, canopyRuntime);
  registerDeepLinkHandlers();
  registerStandaloneChatHandlers();
  registerWorkEntryHandlers();
  registerWorkEntryAutoDeleteHandlers();
  registerSidebarItemGroupHandlers();
  registerGitHubHandlers(getMainWindow, canopyRuntime);
  registerCliHandlers();
  registerObservabilityHandlers(
    getMainWindow,
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
    accessors.getAppAdvisorWindow,
  );
  registerTelemetrySyncHandlers(getMainWindow);
  registerMcpServerHandlers(getMainWindow);
  registerScriptHandlers(canopyRuntime, accessors);
  registerHookHandlers(getMainWindow, canopyRuntime);
  registerEditorMenuHandlers(canopyRuntime);
  registerWorktreeActivityHandlers();
  registerOpenInHandlers();
  registerFilePreviewHandlers(
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );
  registerUpdateHandlers(canopyRuntime.dispatcher, canopyRuntime.resolveCaller);
  registerModelRegistryHandlers(getMainWindow, canopyRuntime);
  registerModelHarnessAssignmentHandlers();
  if (isOllamaSupportedOnPlatform()) {
    registerOllamaHandlers(getMainWindow);
  }
  registerOsNotificationHandlers(getMainWindow);
  registerVoiceHandlers();
  registerTerminalHandlers(accessors);
  registerPanelLayoutHandlers(panelLayoutModePersistenceStore);
  setBrowserService(
    registerBrowserHandlers(
      getMainWindow,
      getBrowserService() ?? undefined,
      (projectId) =>
        projectId === APP_ADVISOR_PROJECT_ID
          ? accessors.getAppAdvisorWindow()
          : getMainWindow(),
      accessors.onBrowserViewAttached,
    ),
  );
  registerFeatureFlagHandlers(getMainWindow);
  registerLabsExperimentsHandlers();
  registerCodeGraphBuildStatusBroadcast();
  registerCodeGraphHandlers(canopyRuntime, accessors);
  registerAuthTerminalHandlers(getMainWindow);
  registerCodexLoginHandlers(getMainWindow);
  registerCodexSpeedHandlers();
  if (accessors.overlayLayerHost) {
    registerOverlayLayerHandlers({
      isOverlayLayerOpener:
        accessors.isOverlayLayerOpener ??
        ((contents): boolean => contents === getMainWindow()?.webContents),
      overlayLayerHost: accessors.overlayLayerHost,
    });
  }
  registerCanopyPortalHandlers(accessors, canopyRuntime.dispatcher);
  registerAppAdvisorHandlers(
    accessors,
    accessors.appAdvisorWorkspaceOperations,
  );
  registerAppAdvisorWatcherHandlers(accessors);
  registerPipelineEditorHandlers();
  registerAutomationsHandlers(accessors);
  registerFeedbackHandlers();
  registerTurnFeedbackHandlers();
  registerOrgMemoryHandlers();
  registerResourceMonitorHandlers(
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );

  registerTerminalSettingsHandlers(
    canopyRuntime.dispatcher,
    canopyRuntime.resolveCaller,
  );
  registerMemoryDiagnosticsHandlers();
  registerSlowActionHandlers(getMainWindow);
  registerWorkerHandlers(accessors);
  registerWakeLockHandlers(getMainWindow);
  registerRecommendedPluginHandlers(canopyRuntime);
  registerInvocableInventoryHandlers();
  registerInstalledItemHandlers();
  registerUsageLimitedChatsHandlers(
    getMainWindow,
    accessors.isMainWindowRendererReady,
  );
  registerWorkspaceContextHandlers();
  registerForeignActivityHandlers();
  registerManagedDelegationHandlers();
  registerNativeSubagentHandlers();
  registerOrgProjectsHandlers();
  registerCloudProjectsHandlers();
  registerCloudChatsHandlers(canopyRuntime.resolveRelaySurface);
  registerSharedMultiRepoHandlers(canopyRuntime);
  const closeAccountOrganizationSettings =
    registerAccountOrganizationSettingsHandlers();
  registerSpaceNotificationHandlers();
  registerGlobalFocusShortcutHandlers();
  registerLaunchAtLoginHandlers();
  registerW5RecoveryHandlers(
    canopyRuntime.resolveCaller,
    () => accessors.unsavedCloseGuard?.isDirty() === true,
  );
  const closeBackgroundService = registerBackgroundServiceHandlers(
    canopyRuntime.resolveCaller,
  );
  registerExternalProjectHandlers();
  registerArchivedContainerHandlers(canopyRuntime);
  registerLocalMemoryHandlers();
  registerMemorySyncHandlers();
  return () => {
    closeRendererRelay();
    relayBridgeClosed = true;
    uninstallRelayBridgeLifecycle?.();
    closeSkillShareNudge();
    closeSkillSuggestions();
    closeChatStatePush();
    closeCostHandlers();
    void closeScriptActions();
    closeAccountOrganizationSettings();
    closeBackgroundService();
  };
}

export { disposeDesktopSessionSnapshotHandlers };
