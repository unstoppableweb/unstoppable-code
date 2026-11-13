import {
  resolveIpcAppError,
  resolveIpcCoworkFolderMissing,
  resolveIpcOperationFailure,
  restoreIpcAppError,
} from './ipc-app-errors';
import type {
  ApprovalSecretInputRequest,
  UsageDataPolicySnapshot,
} from '@canopy/desktop-shared/types';
import {
  CORE_SHARED_MULTI_REPO_QUERIES,
  CORE_SHARED_MULTI_REPO_INSTRUCTIONS,
} from '@canopy/protocol/canopy-core';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { createScriptActionsBridge } from './script-actions-bridge';
import {
  labsExperimentChoiceRequestSchema,
  isLabsExperimentAvailability,
} from '@canopy/protocol/experiments';
import {
  labsExperimentsSnapshotSchema,
  type LabsExperimentsSnapshot,
} from '@canopy/desktop-shared/lib/labs-experiments';
import type { OpenCodeConnectionStatus } from '@canopy/desktop-shared/types/opencode-connection';
import type { AccountProxyStatus } from '@canopy/desktop-shared/types/account-proxy';
import { isSidebarItemGroupId } from '@canopy/protocol/sidebar';
import { createSkillShareNudgeAPI } from './api/skill-share-nudge-api';
import { createSkillSuggestionsAPI } from './api/skill-suggestions-api';
import { createCanopyCoreRelayApi } from './api/canopy-core-relay-api';
import type { CopilotConnectionStatus } from '@canopy/desktop-shared/types/copilot-connection';
import type { ListCuratedAutomationsRequest } from '@canopy/desktop-shared/types/curated-automations';
import type {
  ForeignActivityProjection,
  ForeignActivityStopRequest,
} from '@canopy/protocol/foreign-activity';
import type { PostHogSessionState } from '@canopy/execution-engine/types/observability';
import { isCloudProjectSetupProgress } from '@canopy/desktop-shared/lib/cloud-project-setup';
import {
  isOrgProjectSetupProgress,
  type OrgProjectDeepLinkOpenEvent,
  type OrgProjectSetupProgress,
} from '@canopy/protocol/org-projects';
import type {
  ChatDelegationActivity,
  CodexLoginState,
  CursorConnectionStatus,
  LocalMemoryScopeRequest,
  MemorySyncState,
  ManagedDelegationMessageRequest,
  ManagedDelegationMessageResult,
  ManagedDelegationTreeRequest,
  ManagedDelegationTreeResult,
  ManagedDelegationTranscriptPageRequest,
  ManagedDelegationTranscriptPageResult,
  ManagedDelegationRootsRequest,
  ManagedDelegationRootsResult,
  ManagedDelegationWorktreeSummaryRequest,
  ManagedDelegationWorktreeSummaryResult,
  ManagedDelegationExtendLifetimeLimitRequest,
  ManagedDelegationExtendLifetimeLimitResult,
  ManagedDelegationLifetimeStatusRequest,
  ManagedDelegationLifetimeStatus,
  ManagedDelegationLifetimeChangedEvent,
  NativeSubagentInterruptRequest,
  NativeSubagentInterruptResult,
  ManagedDelegationStopAllRequest,
  ManagedDelegationStopAllResult,
  ManagedDelegationChangesRequest,
  ManagedDelegationChangesResult,
  ManagedDelegationTranscriptRequest,
  ManagedDelegationTranscriptResult,
  ManagedDelegationStopRequest,
  ManagedDelegationStopResult,
  ResumeQueueSnapshot,
  CloneJobSnapshot,
  OrgRepositoryOwnerLookup,
} from '@canopy/desktop-shared/types';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { contextBridge, webFrame, webUtils } from 'electron';
import { ipcRenderer, remoteWindowContext } from './ipc-router';
import { createChatStateApi } from './api/chat-state-api';
import { createChatEventSubscription } from './api/chat-event-api';
import { createCanopyClientTransport } from './api/canopy-client-transport-api';
import { createCodexSpeedApi } from './api/codex-speed-api';
import { createW5RecoveryApi } from './api/w5-recovery-api';
import { createBackgroundServiceApi } from './api/background-service-api';
import { createPanelLayoutApi } from './api/panel-layout-api';
import { createAccountOrganizationSettingsApi } from './api/account-organization-settings-api';
import { createAuthenticatedPortalApi } from './api/authenticated-portal-api';
import {
  createRemoteControlApi,
  uploadFilesToRemote,
} from './api/remote-control-api';
import { electronAPI } from '@electron-toolkit/preload';
import {
  restoreOptionalRemoteControlFlag,
  CLIENT_FEATURE_FLAGS,
  isLabsExperimentFlagKey,
} from '@canopy/protocol/feature-flags';
import {
  OrganizationInviteResultSchema,
  PersonalOrganizationPromotionOutcomeSchema,
  PersonalProjectListSchema,
  PersonalProjectOperationSchema,
  OrganizationOperationRefusalSchema,
  OrganizationInviteStatusSchema,
  type OrganizationOperationRefusal,
} from '@canopy/protocol/organizations';
import type { BrowserProfilesApi } from '@canopy/protocol/browser-profiles';
import type { CostUpdatedEvent } from '@canopy/protocol/cost-view';
import type { LedgerViewChangedEvent } from '@canopy/protocol/ledger-view';
import type { DesktopSettingsDeepLink } from '@canopy/protocol/share-deep-link';
import type { DesktopBillingDeepLink } from '@canopy/protocol/billing';
import {
  parseModelPackageConfig,
  runtimeClaudeModelEntrySchema,
  runtimeCodexModelEntrySchema,
} from '@canopy/desktop-shared/model-config';
import { MAX_ARCHIVE_RETENTION_DAYS } from '@canopy/desktop-shared/lib/archive-retention';
import {
  normalizeAgentArtifactNavigationError,
  normalizeAgentArtifactNavigationRequest,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  AI_GATEWAY_CATALOG_STATUSES,
  IPC_CHANNELS,
  isPipelineEditorRendererToolRequest,
  initClaudeModels,
  initCodexModels,
  initOllamaModels,
  initModelAliases,
  omitModelFeatureFlags,
  type CanopyApi,
  type PreferencesSaveResult,
  type AutoArchiveNotification,
  type ClaudeModelEntry,
  type CodexModelEntry,
  type OllamaModelEntry,
  type OllamaState,
  type OllamaPullProgress,
  type OllamaInstallProgress,
  type OllamaInstallationStatus,
  type OllamaConnectionTestResult,
  type OllamaConfigurationUpdate,
  type GitExecutableInstallProgress,
  type ModelRegistrySnapshot,
  type RunCommentsUpdatedEvent,
  type SharedContainerReplicaState,
  type ModelHarnessAssignmentSnapshot,
  type TelemetrySyncStatus,
  type UpdateEvent,
  type SplitTemporaryWorkspaceCompleteEvent,
  type DeepLinkShareOpenEvent,
  type WorktreeDiscoveryEvent,
  type WorktreeGitReadyEvent,
  type WorktreeGitFailedEvent,
  type WorktreeNeedsRepairEvent,
  type WorktreeBranchChangedEvent,
  type WorktreesFileChangedEvent,
  type WorktreeData,
  type WorkspaceWorktreesUpdatedEvent,
  type ScriptStartedEvent,
  type ScriptOutputEvent,
  type ScriptCompleteEvent,
  type CodeGraphBuildStatusChangedEvent,
  type HookStartedEvent,
  type HookOutputEvent,
  type HookCompleteEvent,
  type HookSkippedPausedEvent,
  type ActivityBgProcessOutputEvent,
  type ActivityLiveBgTasksChangedEvent,
  type TrackedPlansUpdatedEvent,
  type DetectedPlansUpdatedEvent,
  type WorktreeSummaryGeneratingEvent,
  type WorktreeSummaryUpdatedEvent,
  type ChatQueueUpdatedEvent,
  type ClaudeTerminalScheduledPromptEvent,
  type ChatWindowCommand,
  type PortalChatComposerRendererRequest,
  type HookChatTabStartedEvent,
  type McpAskUserEvent,
  type McpExpireAskUserEvent,
  type PlanExitRequestEvent,
  type ChatTabDescriptionUpdatedEvent,
  type DeferredToolsReloadScopeKey,
  type DeferredToolsReloadRequestBase,
  type DeferredToolsReloadAdditions,
  type DeferredToolsReloadLifecycle,
  type DeferredToolsReloadBeginRequest,
  type DeferredToolsReloadFinishRequest,
  type DeferredToolsReloadCancelRequest,
  type DeferredToolsReloadAck,
  type DeferredToolsReloadEvent,
  type StandaloneChatMetaUpdatedEvent,
  type AgentObservabilityUpdateEvent,
  type WorkspaceReferenceRepoStatusEvent,
  type ProjectSourceChangesAppliedEvent,
  type WorkspaceSourceChangesAppliedEvent,
  type OsNotificationClickEvent,
  type ActivationCampaignNavigateEvent,
  type OsNotificationCloseEvent,
  type GlobalFocusShortcutStatus,
  type LaunchAtLoginStatus,
  type AppWindowConfirmCloseRequest,
  type AppWindowConfirmCloseResponse,
  type VoiceEventPayload,
  type TerminalExitEvent,
  type TerminalOutputEvent,
  type TerminalRunningChangedEvent,
  type TerminalSession,
  type BrowserServiceEvent,
  type DefaultBrowserRegistrationStatus,
  type AuthTerminalExitEvent,
  type AuthTerminalOutputEvent,
  type CanopyPortalState,
  type FeatureFlagSnapshot,
  type WakeLockState,
  type AppAdvisorRendererToolRequest,
  type AppAdvisorRendererToolCancellation,
  type AppAdvisorRendererToolResponse,
  type PipelineEditorRendererToolResponse,
  type AppAdvisorUiStateEnvelope,
  type AppAdvisorSettingsLoadResponse,
  type AppAdvisorSettingsSaveRequest,
  type AppAdvisorWatcherDeleteRequest,
  type AppAdvisorWatcherDestination,
  type AppAdvisorWatcherSummary,
  type AppAdvisorWindowCommand,
  type AppAdvisorWindowOpenRequest,
  type AppAdvisorWindowCloseOptions,
  type AppAdvisorWindowBatchRemovalDialog,
  type AppAdvisorWindowState,
  type AppAdvisorWindowUiState,
  type AutomationCronGenerateRequest,
  type AutomationIfCommandGenerateRequest,
  type AutomationCreateRequest,
  type AutomationDeleteRequest,
  type AutomationRunNowRequest,
  type AutomationRunHistoryRequest,
  type AutomationsListRequest,
  type AutomationCancelRunRequest,
  type AutomationUpdateRequest,
  type AnalyzeAutomationCapabilityPackageRequest,
  type AutomationCapabilityPackageRequest,
  type CommitAutomationCapabilityPackageRequest,
  type CreateSharedAutomationIpcRequest,
  type DeleteSharedAutomationIpcRequest,
  type InstallAutomationCapabilityPackageRequest,
  type ListSharedAutomationsIpcRequest,
  type ResolveAutomationSharedPipelinePinRequest,
  type ApproveAutomationSharedPipelineReviewRequest,
  type UpdateSharedAutomationIpcRequest,
  type VerifyAutomationSharedPipelinePinRequest,
  type AutomationsListResponse,
  type SpaceNotificationPolicySnapshot,
  type SpaceNotificationScope,
  type SpaceNotificationSetRequest,
  type ExternalProjectDiscoverRequest,
  type ExternalProjectImportProgressEvent,
  type ExternalProjectImportRequest,
  type SlowActionEvent,
  type SlowActionKind,
  type SlowActionRecord,
  type WorkerStartedEvent,
  type WorkerUpdatedEvent,
  type WorkerExitedEvent,
  type CodeReviewUpdatedEvent,
  type ApprovalRequestEvent,
  type ApprovalAutoResolvedEvent,
  type ApprovalCancelledEvent,
  type ApprovalRespondRequest,
  type ApprovalDismissRequest,
  type ApprovalMode,
  type ApprovalModeSetRequest,
  type ApprovalResolvedDefaultRequest,
  type ApprovalRulesListRequest,
  type ApprovalRulesListResponse,
  type ApprovalRuleAddRequest,
  type ApprovalRuleRemoveRequest,
  type ApprovalRuleAddedEvent,
  type FileAnnotationsUpdatedEvent,
  type ArchivedContainersChangedEvent,
  isWorkspaceContextChangeReason,
  isWorkspaceContextState,
  type DesktopOrgProjectCatalogSnapshot,
  type OrgProjectOwnershipChangedEvent,
  type WorkspaceContextBroadcast,
  type WorkspaceContextState,
  readAppAdvisorInitialLayout,
} from '@canopy/desktop-shared/types';
import {
  isOrgProjectSummary,
  isOrgRepositoryOwnerLookup,
} from '@canopy/protocol/org-projects';
import { isOllamaSupportedOnPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { isCodeGraphGenerationQueueSnapshot } from './code-graph-validation';
import type { AgentModelRegistryEntry } from '@canopy/execution-engine/types/agent-models';
import type {
  CommitPushProgressEvent,
  DependentBaseBranchesUpdatedEvent,
  PrStatusEvent,
  GitHubRateLimitEvent,
  PrCreationProgressEvent,
  MergePrProgressEvent,
  SplitPrProgressEvent,
  SplitLockChangeEventPayload,
} from '@canopy/desktop-shared/types/github';
import { createBundlesAPI } from './api/bundles-api';
import { createCollectionsAPI } from './api/collections-api';
import { createPipelinesAPI } from './api/pipelines-api';
import { createPluginsAPI } from './api/plugins-api';
import { createMcpServersAPI } from './api/mcp-servers-api';
import { createSkillsAPI } from './api/skills-api';
import { createAgentsAPI } from './api/agents-api';
import { createInvocableInventoryAPI } from './api/invocable-inventory-api';
import { createInstalledItemsAPI } from './api/installed-items-api';
import { isResourceMonitorSnapshot } from './resource-monitor-validation';
import { createClaudeTerminalBridge } from './claude-terminal-bridge';
import { isChatSessionImportedEvent } from './session-transfer-validation';
import {
  isListDismissedSharedContainersResult,
  isRestoreSharedContainerResult,
  isSharedContainerInboxChangedEvent,
  isSharedContainerPublicationState,
  isSharedContainerReplicaBroadcast,
  isSharedContainerReplicaState,
  isSharedContainerReplicaStateOrNull,
  isSharedContainerSyncPhaseEvent,
} from './shared-container-validation';

async function invokeSharedContainerReplicaState(
  channel: string,
  request: unknown,
): Promise<SharedContainerReplicaState> {
  const response: unknown = await ipcRenderer.invoke(channel, request);
  if (!isSharedContainerReplicaState(response)) {
    throw new Error('Main returned an invalid shared-container replica state');
  }
  return response;
}

async function invokeOptionalSharedContainerReplicaState(
  channel: string,
  request: unknown,
): Promise<SharedContainerReplicaState | null> {
  const response: unknown = await ipcRenderer.invoke(channel, request);
  if (!isSharedContainerReplicaStateOrNull(response)) {
    throw new Error('Main returned an invalid shared-container replica state');
  }
  return response;
}

function serializeAppAdvisorSettingsSaveRequest(
  settings: AppAdvisorSettingsSaveRequest,
): AppAdvisorSettingsSaveRequest {
  if (
    settings.description !== undefined &&
    typeof settings.description !== 'string'
  ) {
    throw new TypeError('App Advisor description must be a string');
  }
  if (
    settings.archiveRetentionDays !== undefined &&
    settings.archiveRetentionDays !== null &&
    (typeof settings.archiveRetentionDays !== 'number' ||
      !Number.isInteger(settings.archiveRetentionDays) ||
      settings.archiveRetentionDays < 0 ||
      settings.archiveRetentionDays > MAX_ARCHIVE_RETENTION_DAYS)
  ) {
    throw new TypeError(
      `App Advisor deletion retention must be null or an integer from 0 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }
  if (
    settings.autoArchiveDays !== undefined &&
    settings.autoArchiveDays !== null &&
    (typeof settings.autoArchiveDays !== 'number' ||
      !Number.isInteger(settings.autoArchiveDays) ||
      settings.autoArchiveDays < 1 ||
      settings.autoArchiveDays > MAX_ARCHIVE_RETENTION_DAYS)
  ) {
    throw new TypeError(
      `App Advisor Auto Delete inactivity must be null or an integer from 1 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }
  return {
    ...(settings.description !== undefined
      ? { description: settings.description }
      : {}),
    ...(settings.archiveRetentionDays !== undefined
      ? { archiveRetentionDays: settings.archiveRetentionDays }
      : {}),
    ...(settings.autoArchiveDays !== undefined
      ? { autoArchiveDays: settings.autoArchiveDays }
      : {}),
  };
}

function serializeAppAdvisorSettingsLoadResponse(
  settings: unknown,
): AppAdvisorSettingsLoadResponse {
  if (!isRecord(settings) || settings.version !== 1) {
    throw new TypeError('Invalid App Advisor settings');
  }
  try {
    const serialized = serializeAppAdvisorSettingsSaveRequest(settings);
    return { version: 1, ...serialized };
  } catch {
    throw new TypeError('Invalid App Advisor settings');
  }
}

/**
 * The popout nav's open batch removal dialog, reduced to its mode, count,
 * and phase; `null` when closed and `undefined` when not reported. Throws on
 * a malformed one.
 */
function serializeAppAdvisorBatchRemovalDialog(
  value: unknown,
): AppAdvisorWindowBatchRemovalDialog | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isRecord(value) || value.open !== true) {
    throw new TypeError('Invalid App Advisor window UI state');
  }
  const { mode, phase, count } = value;
  if (
    (mode !== 'archive' && mode !== 'delete') ||
    (phase !== 'confirm' && phase !== 'running' && phase !== 'results') ||
    typeof count !== 'number' ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw new TypeError('Invalid App Advisor window UI state');
  }
  return { open: true, mode, count, phase };
}

function serializeAppAdvisorWindowUiState(
  state: unknown,
): AppAdvisorWindowUiState {
  if (
    !isRecord(state) ||
    !(
      state.activeWorkEntryId === null ||
      typeof state.activeWorkEntryId === 'string'
    ) ||
    !(state.activeChatId === null || typeof state.activeChatId === 'string') ||
    !(
      state.groupEditorId === undefined ||
      state.groupEditorId === null ||
      isSidebarItemGroupId(state.groupEditorId)
    ) ||
    typeof state.navCollapsed !== 'boolean' ||
    typeof state.settingsModalOpen !== 'boolean' ||
    typeof state.archivedOverviewOpen !== 'boolean' ||
    !(
      state.archivedOverviewWorkspaceId === null ||
      typeof state.archivedOverviewWorkspaceId === 'string'
    ) ||
    typeof state.emptyTrashConfirmationOpen !== 'boolean' ||
    typeof state.emptyTrashRunning !== 'boolean' ||
    !(
      state.lastArchivedOverviewRequestId === null ||
      typeof state.lastArchivedOverviewRequestId === 'string'
    ) ||
    !(
      state.lastArchivedOverviewConfirmationOpened === null ||
      typeof state.lastArchivedOverviewConfirmationOpened === 'boolean'
    )
  ) {
    throw new TypeError('Invalid App Advisor window UI state');
  }
  const batchRemovalDialog = serializeAppAdvisorBatchRemovalDialog(
    state.batchRemovalDialog,
  );
  return {
    activeWorkEntryId: state.activeWorkEntryId,
    activeChatId: state.activeChatId,
    navCollapsed: state.navCollapsed,
    ...(state.groupEditorId === undefined
      ? {}
      : { groupEditorId: state.groupEditorId }),
    settingsModalOpen: state.settingsModalOpen,
    archivedOverviewOpen: state.archivedOverviewOpen,
    archivedOverviewWorkspaceId: state.archivedOverviewWorkspaceId,
    emptyTrashConfirmationOpen: state.emptyTrashConfirmationOpen,
    emptyTrashRunning: state.emptyTrashRunning,
    lastArchivedOverviewRequestId: state.lastArchivedOverviewRequestId,
    lastArchivedOverviewConfirmationOpened:
      state.lastArchivedOverviewConfirmationOpened,
    ...(batchRemovalDialog === undefined ? {} : { batchRemovalDialog }),
  };
}

// A window that shows another computer reports that computer's platform, so
// path handling in the renderer matches the paths it receives.
const hostPlatform = ((): NonNullable<
  ReturnType<typeof hostOperatingSystem>
> => {
  const platform = hostOperatingSystem();
  if (platform === null) throw new Error('Unsupported host platform');
  return platform;
})();
const localPlatform =
  __CANOPY_E2E__ &&
  (process.env.CANOPY_E2E_PLATFORM === 'win32' ||
    process.env.CANOPY_E2E_PLATFORM === 'linux')
    ? process.env.CANOPY_E2E_PLATFORM
    : hostPlatform;
const exposedPlatform = remoteWindowContext?.platform ?? localPlatform;

// One `chat:event` IPC listener for this page, shared by every subscriber.
const subscribeToChatEvents = createChatEventSubscription(ipcRenderer);

// The portable CanopyClient's transport, limited to the adapter's channels.
const canopyClientTransport = createCanopyClientTransport(
  ipcRenderer,
  subscribeToChatEvents,
);

// ---------------------------------------------------------------------------
// Load models from package.json (preload has full Node.js access).
// __dirname is out/preload/ in both dev and production; package.json is two
// levels up at the app root.
// ---------------------------------------------------------------------------
let claudeModelEntries: ClaudeModelEntry[] = [];
let codexModelEntries: CodexModelEntry[] = [];
let ollamaModelEntries: OllamaModelEntry[] = [];
let modelAliases: Record<string, string> = {};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isApprovalRuleTarget(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'command':
      return typeof value.pattern === 'string';
    case 'file-write':
      return typeof value.path === 'string';
    case 'mcp':
      return typeof value.server === 'string' && isOptionalString(value.tool);
    case 'network':
      return typeof value.host === 'string';
    case 'tool':
      return typeof value.toolName === 'string';
    case 'browser-upload':
      return typeof value.origin === 'string' && isOptionalString(value.path);
    default:
      return false;
  }
}

function isUploadFileList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (file) =>
        isRecord(file) &&
        typeof file.displayPath === 'string' &&
        typeof file.sizeBytes === 'number',
    )
  );
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

/** Mirrors `ApprovalFileChange`; a malformed change rejects the event. */
function isOptionalApprovalFileChange(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !isOptionalBoolean(value.truncated)) return false;
  switch (value.kind) {
    case 'edit':
      return (
        typeof value.oldText === 'string' &&
        typeof value.newText === 'string' &&
        isOptionalBoolean(value.replaceAll)
      );
    case 'write':
      return typeof value.content === 'string';
    default:
      return false;
  }
}

function isApprovalRequestDetails(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'command':
      return (
        typeof value.command === 'string' &&
        isOptionalString(value.cwd) &&
        isOptionalString(value.reason)
      );
    case 'file-write':
      return (
        isOptionalString(value.path) &&
        isOptionalString(value.displayPath) &&
        isOptionalApprovalFileChange(value.change) &&
        isOptionalString(value.reason) &&
        isOptionalString(value.itemId)
      );
    case 'mcp':
      return (
        typeof value.server === 'string' &&
        typeof value.tool === 'string' &&
        isOptionalString(value.paramsDisplay) &&
        isOptionalString(value.reason)
      );
    case 'network':
      return typeof value.host === 'string' && isOptionalString(value.reason);
    case 'tool':
      return (
        typeof value.toolName === 'string' &&
        isOptionalString(value.path) &&
        isOptionalString(value.displayPath) &&
        isOptionalString(value.inputSummary) &&
        isOptionalString(value.reason)
      );
    case 'browser-upload':
      return (
        typeof value.origin === 'string' &&
        isOptionalString(value.topOrigin) &&
        isUploadFileList(value.files) &&
        isOptionalString(value.reason)
      );
    case 'browser-file-request':
      return (
        typeof value.origin === 'string' &&
        isOptionalString(value.topOrigin) &&
        isOptionalString(value.purpose) &&
        typeof value.multiple === 'boolean'
      );
    default:
      return false;
  }
}

function isApprovalRequestEvent(value: unknown): value is ApprovalRequestEvent {
  return (
    isRecord(value) &&
    (value.surface === undefined ||
      value.surface === 'chat' ||
      value.surface === 'non-chat') &&
    typeof value.requestId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    (value.provider === 'claude' ||
      value.provider === 'codex' ||
      value.provider === 'ollama' ||
      value.provider === 'cursor' ||
      value.provider === 'copilot' ||
      value.provider === 'opencode') &&
    typeof value.title === 'string' &&
    isOptionalString(value.description) &&
    isApprovalRequestDetails(value.details) &&
    (value.suggestedTarget === undefined ||
      isApprovalRuleTarget(value.suggestedTarget)) &&
    isOptionalString(value.toolUseId) &&
    isOptionalString(value.subagentId)
  );
}

function isApprovalCancelledEvent(
  value: unknown,
): value is ApprovalCancelledEvent {
  return isRecord(value) && typeof value.requestId === 'string';
}

function isApprovalAutoResolvedEvent(
  value: unknown,
): value is ApprovalAutoResolvedEvent {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    value.reason === 'mode-change' &&
    isApprovalModeValue(value.mode) &&
    (value.previousMode === undefined ||
      isApprovalModeValue(value.previousMode)) &&
    (value.resolutionMessage === undefined || isRecord(value.resolutionMessage))
  );
}

function isApprovalModeValue(value: unknown): boolean {
  return value === 'ask' || value === 'auto' || value === 'full-access';
}

function isApprovalRuleAddedEvent(
  value: unknown,
): value is ApprovalRuleAddedEvent {
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    typeof value.worktreeId !== 'string' ||
    typeof value.chatId !== 'string' ||
    !isRecord(value.rule)
  ) {
    return false;
  }
  return (
    typeof value.rule.id === 'string' &&
    (value.rule.behavior === 'allow' || value.rule.behavior === 'deny') &&
    isApprovalRuleTarget(value.rule.target) &&
    typeof value.rule.createdAt === 'string' &&
    (value.rule.origin === 'prompt' ||
      value.rule.origin === 'settings' ||
      value.rule.origin === 'canopy-json')
  );
}

function isMcpExpireAskUserEvent(
  value: unknown,
): value is McpExpireAskUserEvent {
  return isRecord(value) && typeof value.requestId === 'string';
}

function isAppAdvisorRendererToolCancellation(
  value: unknown,
): value is AppAdvisorRendererToolCancellation {
  return isRecord(value) && typeof value.requestId === 'string';
}

function isDeferredToolsReloadScopeKey(
  value: unknown,
): value is DeferredToolsReloadScopeKey {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string'
  );
}

function isDeferredToolsReloadRequestBase(
  value: unknown,
): value is DeferredToolsReloadRequestBase & Record<string, unknown> {
  return (
    isRecord(value) &&
    isDeferredToolsReloadScopeKey(value.scope) &&
    typeof value.requestId === 'string' &&
    typeof value.toolCallId === 'string'
  );
}

function isDeferredToolsReloadAdditions(
  value: unknown,
): value is DeferredToolsReloadAdditions {
  return (
    isRecord(value) &&
    Array.isArray(value.skillRefs) &&
    Array.isArray(value.pluginRefs) &&
    Array.isArray(value.mcpServerRefs)
  );
}

function isDeferredToolsReloadBeginRequest(
  value: unknown,
): value is DeferredToolsReloadBeginRequest {
  if (!isDeferredToolsReloadRequestBase(value)) {
    return false;
  }
  return (
    isDeferredToolsReloadAdditions(value.additions) &&
    Array.isArray(value.enabledResources)
  );
}

function isDeferredToolsReloadFinishRequest(
  value: unknown,
): value is DeferredToolsReloadFinishRequest {
  if (!isDeferredToolsReloadRequestBase(value)) {
    return false;
  }
  return (
    typeof value.userMessageId === 'string' &&
    typeof value.continuationText === 'string' &&
    isRecord(value.resume)
  );
}

function deferredToolsReloadRequestId(value: unknown): unknown {
  return isRecord(value) ? value.requestId : undefined;
}

function isDeferredToolsReloadCancelRequest(
  value: unknown,
): value is DeferredToolsReloadCancelRequest {
  return isDeferredToolsReloadRequestBase(value);
}

function isDeferredToolsReloadLifecycle(
  value: unknown,
): value is DeferredToolsReloadLifecycle {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === 'state') {
    return typeof value.state === 'string';
  }
  if (value.kind === 'outcome') {
    return typeof value.outcome === 'string';
  }
  return false;
}

function isDeferredToolsReloadEvent(
  value: unknown,
): value is DeferredToolsReloadEvent {
  return (
    isRecord(value) &&
    isDeferredToolsReloadScopeKey(value.scope) &&
    typeof value.requestId === 'string' &&
    typeof value.toolCallId === 'string' &&
    isDeferredToolsReloadLifecycle(value.lifecycle) &&
    // `additions` is optional but, when present, carries the typed refs the
    // renderer merges — reject a malformed payload rather than let it reach the
    // merge as garbage.
    (value.additions === undefined ||
      isDeferredToolsReloadAdditions(value.additions))
  );
}

/**
 * A well-formed rejected ack returned synchronously when a renderer-supplied
 * reload payload fails validation, so the caller never has to distinguish a
 * transport error from a contract rejection.
 */
function invalidDeferredToolsReloadAck(
  requestId: unknown,
): DeferredToolsReloadAck {
  return {
    requestId: typeof requestId === 'string' ? requestId : '',
    accepted: false,
    lifecycle: { kind: 'outcome', outcome: 'rejected' },
    rejection: {
      code: 'invalid_request',
      message: 'Invalid deferred-tools reload request payload.',
    },
  };
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isGitHubRateLimitEvent(value: unknown): value is GitHubRateLimitEvent {
  return (
    isRecord(value) &&
    (value.kind === 'primary' || value.kind === 'secondary') &&
    typeof value.message === 'string' &&
    typeof value.retryAt === 'string' &&
    typeof value.retryAfterSeconds === 'number' &&
    (value.resource === undefined || typeof value.resource === 'string')
  );
}

function isWakeLockState(value: unknown): value is WakeLockState {
  return (
    isRecord(value) &&
    typeof value.active === 'boolean' &&
    typeof value.enabled === 'boolean' &&
    typeof value.holderCount === 'number' &&
    Number.isFinite(value.holderCount)
  );
}

function isCodeReviewUpdatedEvent(
  value: unknown,
): value is CodeReviewUpdatedEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.fingerprint === 'string' &&
    isRecord(value.review)
  );
}

function isFileAnnotationsUpdatedEvent(
  value: unknown,
): value is FileAnnotationsUpdatedEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    isRecord(value.document) &&
    typeof value.document.filePath === 'string' &&
    Array.isArray(value.document.annotations) &&
    Array.isArray(value.document.commentThreads)
  );
}

function isTelemetrySyncStatus(value: unknown): value is TelemetrySyncStatus {
  return (
    isRecord(value) &&
    typeof value.isSyncing === 'boolean' &&
    typeof value.pendingCount === 'number' &&
    Number.isFinite(value.pendingCount) &&
    typeof value.sharingActive === 'boolean' &&
    (value.lastSyncedAt === null || typeof value.lastSyncedAt === 'string') &&
    (value.lastErrorAt === null || typeof value.lastErrorAt === 'string') &&
    (value.lastError === null || value.lastError === 'upload-failed') &&
    (value.pausedReason === undefined ||
      value.pausedReason === null ||
      value.pausedReason === 'queue-stalled')
  );
}

/** Wire guard for the catalog snapshot main sends and answers (CAN-2955). */
function isDesktopOrgProjectCatalogSnapshot(
  value: unknown,
): value is DesktopOrgProjectCatalogSnapshot {
  return (
    isRecord(value) &&
    typeof value.context === 'string' &&
    typeof value.revision === 'string' &&
    typeof value.fetchedAt === 'string' &&
    typeof value.stale === 'boolean' &&
    (value.error === null ||
      value.error === 'unavailable' ||
      value.error === 'offline' ||
      value.error === 'access-changed') &&
    Array.isArray(value.projects) &&
    value.projects.every(isOrgProjectSummary)
  );
}

function isLedgerGlobalOwner(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === 'personal' ||
      (value.kind === 'organization' &&
        typeof value.organizationId === 'string'))
  );
}

/** A task's scope, or one global (workflow) Ledger by its owner and ID. */
function isLedgerViewScope(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.kind === 'global') {
    return (
      typeof value.ledgerId === 'string' && isLedgerGlobalOwner(value.owner)
    );
  }
  return (
    value.kind === undefined &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string'
  );
}

/** Wire guard for the Ledger change batches main broadcasts. */
function isLedgerViewChangedEvent(
  value: unknown,
): value is LedgerViewChangedEvent {
  return (
    isRecord(value) &&
    Array.isArray(value.changes) &&
    value.changes.every(
      (change: unknown): boolean =>
        isRecord(change) &&
        isLedgerViewScope(change.scope) &&
        typeof change.entryId === 'string' &&
        typeof change.revision === 'number',
    ) &&
    (value.syncChanged === undefined ||
      value.syncChanged === 'all' ||
      (Array.isArray(value.syncChanged) &&
        value.syncChanged.every(isLedgerViewScope)))
  );
}

function isCostScopeRef(value: unknown): boolean {
  if (!isRecord(value) || typeof value.projectId !== 'string') return false;
  if (value.kind === 'entry') return typeof value.worktreeId === 'string';
  return value.kind === 'retained' && typeof value.containerId === 'string';
}

/** Wire guard for the cost updates main broadcasts. */
function isCostUpdatedEvent(value: unknown): value is CostUpdatedEvent {
  return (
    isRecord(value) &&
    typeof value.revision === 'number' &&
    Array.isArray(value.scopes) &&
    value.scopes.every(isCostScopeRef)
  );
}

/** Wire guard for the conversion broadcast (CAN-3415). */
function isOrgProjectOwnershipChangedEvent(
  value: unknown,
): value is OrgProjectOwnershipChangedEvent {
  return (
    isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    typeof value.organizationId === 'string' &&
    typeof value.projectId === 'string' &&
    (value.owner === 'organization' || value.owner === 'personal')
  );
}

async function invokeOrgProjects(
  channel: string,
  ...args: unknown[]
): Promise<DesktopOrgProjectCatalogSnapshot> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  if (!isDesktopOrgProjectCatalogSnapshot(result)) {
    throw new Error(
      `Malformed organization project catalog reply on ${channel}`,
    );
  }
  return result;
}

function isWorkspaceContextBroadcast(
  value: unknown,
): value is WorkspaceContextBroadcast {
  return (
    isWorkspaceContextState(value) &&
    'reason' in value &&
    isWorkspaceContextChangeReason(value.reason)
  );
}

/**
 * The invoke replies share the broadcast's wire guard: a malformed reply
 * rejects here instead of reaching the renderer store as trusted state.
 */
async function invokeWorkspaceContext(
  channel: string,
  ...args: unknown[]
): Promise<WorkspaceContextState> {
  const result: unknown = await ipcRenderer.invoke(channel, ...args);
  if (!isWorkspaceContextState(result)) {
    throw new Error(`Malformed workspace context reply on ${channel}`);
  }
  return result;
}

function isFeatureFlagSnapshot(value: unknown): value is FeatureFlagSnapshot {
  if (!isRecord(value) || !isRecord(value.values)) {
    return false;
  }
  const values = value.values;
  restoreOptionalRemoteControlFlag(values);
  const status = value.status;
  const allFlagsValid = Object.values(CLIENT_FEATURE_FLAGS).every(
    ({ key, launchDarklyEnabledUnavailableValue }) =>
      (!isLabsExperimentFlagKey(key) ||
        isLabsExperimentAvailability(values[key])) &&
      typeof values[key] === typeof launchDarklyEnabledUnavailableValue &&
      (typeof values[key] !== 'number' || Number.isFinite(values[key])),
  );
  return (
    allFlagsValid &&
    (status === 'not_configured' ||
      status === 'initializing' ||
      status === 'ready' ||
      status === 'error') &&
    typeof value.initialized === 'boolean' &&
    typeof value.updatedAt === 'string' &&
    (value.error === null || typeof value.error === 'string')
  );
}

function isClaudeModelEntry(value: unknown): value is ClaudeModelEntry {
  return runtimeClaudeModelEntrySchema.safeParse(value).success;
}

function isCodexModelEntry(value: unknown): value is CodexModelEntry {
  return runtimeCodexModelEntrySchema.safeParse(value).success;
}

function isOllamaModelEntry(value: unknown): value is OllamaModelEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.rawModelId === 'string' &&
    typeof value.label === 'string' &&
    (value.sizeBytes === undefined || typeof value.sizeBytes === 'number') &&
    (value.modifiedAt === undefined || typeof value.modifiedAt === 'string') &&
    (value.digest === undefined || typeof value.digest === 'string') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'string') &&
    (value.sizeVramBytes === undefined ||
      typeof value.sizeVramBytes === 'number') &&
    (value.details === undefined || isOllamaModelDetails(value.details)) &&
    (value.show === undefined || isOllamaShowInfo(value.show))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isWorktreeData(value: unknown): value is WorktreeData {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.branchName === 'string' &&
    typeof value.createdAt === 'string' &&
    (value.pausedHookKeys === undefined || isStringArray(value.pausedHookKeys))
  );
}

function isWorktreeGitReadyEvent(
  value: unknown,
): value is WorktreeGitReadyEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.branchName === 'string'
  );
}

function isWorktreeGitFailedEvent(
  value: unknown,
): value is WorktreeGitFailedEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.error === 'string'
  );
}

function isSplitTemporaryWorkspaceCompleteEvent(
  value: unknown,
): value is SplitTemporaryWorkspaceCompleteEvent {
  return (
    isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.success === 'boolean' &&
    Array.isArray(value.results) &&
    value.results.every(
      (result) =>
        isRecord(result) &&
        typeof result.repoId === 'string' &&
        typeof result.repoName === 'string' &&
        (result.disposition === 'split' ||
          result.disposition === 'archived' ||
          result.disposition === 'deleted') &&
        (result.destinationWorkspaceId === undefined ||
          typeof result.destinationWorkspaceId === 'string') &&
        (result.destinationWorktreeId === undefined ||
          typeof result.destinationWorktreeId === 'string'),
    ) &&
    isStringArray(value.warnings) &&
    (value.rootDisposition === undefined ||
      value.rootDisposition === 'archived' ||
      value.rootDisposition === 'deleted') &&
    (value.removedTemporaryWorkspaceId === undefined ||
      typeof value.removedTemporaryWorkspaceId === 'string') &&
    (value.removedTemporaryWorkspaceName === undefined ||
      typeof value.removedTemporaryWorkspaceName === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isWorktreeNeedsRepairEvent(
  value: unknown,
): value is WorktreeNeedsRepairEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.branchName === 'string' &&
    Array.isArray(value.repairIssues)
  );
}

function isWorktreeBranchChangedEvent(
  value: unknown,
): value is WorktreeBranchChangedEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.branchName === 'string' &&
    (value.repoId === undefined || typeof value.repoId === 'string')
  );
}

function isArchivedContainersChangedEvent(
  value: unknown,
): value is ArchivedContainersChangedEvent {
  return isRecord(value) && typeof value.workspaceId === 'string';
}

function isWorkspaceWorktreesUpdatedEvent(
  value: unknown,
): value is WorkspaceWorktreesUpdatedEvent {
  return (
    isRecord(value) &&
    typeof value.workspaceId === 'string' &&
    (value.worktree === undefined || isWorktreeData(value.worktree)) &&
    (value.worktrees === undefined ||
      (Array.isArray(value.worktrees) && value.worktrees.every(isWorktreeData)))
  );
}

const SLOW_ACTION_KINDS: ReadonlyArray<SlowActionKind> = [
  'ipc',
  'chat',
  'pipeline',
  'terminal',
  'resource-monitor',
  'portal',
  'unknown',
];

function isSlowActionKind(value: unknown): value is SlowActionKind {
  return (
    typeof value === 'string' &&
    SLOW_ACTION_KINDS.some((kind) => kind === value)
  );
}

function isSlowActionContext(
  value: unknown,
): value is NonNullable<SlowActionRecord['context']> {
  if (!isRecord(value)) {
    return false;
  }
  const keys: ReadonlyArray<keyof NonNullable<SlowActionRecord['context']>> = [
    'channel',
    'projectId',
    'worktreeId',
    'chatId',
    'pipelineExecutionId',
    'terminalId',
  ];
  return keys.every((key) => {
    const entry = value[key];
    return entry === undefined || typeof entry === 'string';
  });
}

function isSlowActionRecord(value: unknown): value is SlowActionRecord {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isSlowActionKind(value.kind) &&
    typeof value.label === 'string' &&
    typeof value.startedAt === 'string' &&
    typeof value.startedAtMs === 'number' &&
    Number.isFinite(value.startedAtMs) &&
    typeof value.thresholdMs === 'number' &&
    Number.isFinite(value.thresholdMs) &&
    (value.context === undefined || isSlowActionContext(value.context))
  );
}

function isSlowActionEvent(value: unknown): value is SlowActionEvent {
  if (!isRecord(value)) {
    return false;
  }
  switch (value.type) {
    case 'added':
      return isSlowActionRecord(value.record);
    case 'resolved':
    case 'evicted':
      return typeof value.id === 'string';
    case 'cleared':
      return true;
    default:
      return false;
  }
}

function isOllamaModelDetails(
  value: unknown,
): value is NonNullable<OllamaModelEntry['details']> {
  return (
    isRecord(value) &&
    (value.parentModel === undefined ||
      typeof value.parentModel === 'string') &&
    (value.format === undefined || typeof value.format === 'string') &&
    (value.family === undefined || typeof value.family === 'string') &&
    (value.families === undefined || isStringArray(value.families)) &&
    (value.parameterSize === undefined ||
      typeof value.parameterSize === 'string') &&
    (value.quantizationLevel === undefined ||
      typeof value.quantizationLevel === 'string')
  );
}

function isOllamaShowMessageEntry(
  value: unknown,
): value is NonNullable<
  NonNullable<OllamaModelEntry['show']>['messages']
>[number] {
  return (
    isRecord(value) &&
    typeof value.role === 'string' &&
    typeof value.content === 'string' &&
    (value.thinking === undefined || typeof value.thinking === 'string') &&
    (value.toolName === undefined || typeof value.toolName === 'string')
  );
}

function isOllamaShowInfo(
  value: unknown,
): value is NonNullable<OllamaModelEntry['show']> {
  return (
    isRecord(value) &&
    (value.capabilities === undefined || isStringArray(value.capabilities)) &&
    (value.license === undefined || typeof value.license === 'string') &&
    (value.parameters === undefined || typeof value.parameters === 'string') &&
    (value.template === undefined || typeof value.template === 'string') &&
    (value.system === undefined || typeof value.system === 'string') &&
    (value.messages === undefined ||
      (Array.isArray(value.messages) &&
        value.messages.every((entry) => isOllamaShowMessageEntry(entry)))) &&
    (value.modelInfoJson === undefined ||
      typeof value.modelInfoJson === 'string') &&
    (value.projectorInfoJson === undefined ||
      typeof value.projectorInfoJson === 'string') &&
    (value.rawJson === undefined || typeof value.rawJson === 'string')
  );
}

function isAgentModelRegistryEntry(
  value: unknown,
): value is AgentModelRegistryEntry {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.baseModel === 'string' &&
    typeof value.instructions === 'string' &&
    isRecord(value.pluginSelections) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.available === 'boolean' &&
    (value.unavailableReason === undefined ||
      value.unavailableReason === 'base_model_unavailable')
  );
}

function isAiGatewayModelEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.label === 'string' &&
    isModelHarness(value.recommendedHarness) &&
    typeof value.contextWindow === 'number' &&
    typeof value.supportsPromptCaching === 'boolean' &&
    Array.isArray(value.supportedThinkingLevels) &&
    typeof value.toolSchemaProfile === 'string'
  );
}

function isGatewayRouteEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.modelId === 'string' &&
    typeof value.gatewayId === 'string' &&
    isModelHarness(value.recommendedHarness) &&
    typeof value.gatewayOnly === 'boolean' &&
    typeof value.contextWindow === 'number' &&
    typeof value.supportsPromptCaching === 'boolean' &&
    Array.isArray(value.supportedThinkingLevels) &&
    typeof value.toolSchemaProfile === 'string'
  );
}

/** One rule for both: the snapshot is valid when nothing in it is refused. */
function isModelRegistrySnapshot(
  value: unknown,
): value is ModelRegistrySnapshot {
  return describeModelRegistrySnapshotRejection(value) === null;
}

/** The first entry of `entries` that `isValid` refuses, as `section[index] (id)`. */
function describeRejectedEntry(
  section: string,
  entries: unknown,
  isValid: (entry: unknown) => boolean,
): string | null {
  if (!Array.isArray(entries)) return `${section}: not an array`;
  const index = entries.findIndex((entry) => !isValid(entry));
  if (index === -1) return null;
  const entry: unknown = entries[index];
  const id = isRecord(entry) && typeof entry.id === 'string' ? entry.id : null;
  return `${section}[${index}]${id === null ? '' : ` (${id})`}`;
}

/**
 * Why `value` is not a valid registry snapshot: the first failing section,
 * with the entry's index and id, or `null` when it is valid. Never the payload
 * itself, which is large and names every configured model. `agents` and the
 * gateway sections are optional for backward compatibility: a missing field
 * means none, and a present one must be a valid entry array.
 */
function describeModelRegistrySnapshotRejection(value: unknown): string | null {
  if (!isRecord(value)) return 'snapshot: not an object';
  const optional = (
    section: string,
    entries: unknown,
    isValid: (entry: unknown) => boolean,
  ): string | null =>
    entries === undefined
      ? null
      : describeRejectedEntry(section, entries, isValid);
  return (
    describeRejectedEntry('claude', value.claude, isClaudeModelEntry) ??
    describeRejectedEntry('codex', value.codex, isCodexModelEntry) ??
    describeRejectedEntry('ollama', value.ollama, isOllamaModelEntry) ??
    optional('agents', value.agents, isAgentModelRegistryEntry) ??
    optional('aiGatewayModels', value.aiGatewayModels, isAiGatewayModelEntry) ??
    optional('gatewayRoutes', value.gatewayRoutes, isGatewayRouteEntry) ??
    (value.harnessAssignments === undefined ||
    isModelHarnessAssignmentSnapshot(value.harnessAssignments)
      ? null
      : 'harnessAssignments') ??
    (value.aiGatewayCatalogStatus === undefined ||
    AI_GATEWAY_CATALOG_STATUSES.some(
      (status) => status === value.aiGatewayCatalogStatus,
    )
      ? null
      : 'aiGatewayCatalogStatus') ??
    (isStringRecord(value.aliases) ? null : 'aliases')
  );
}

function isModelHarness(
  value: unknown,
): value is 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode' {
  return (
    value === 'claude' ||
    value === 'codex' ||
    value === 'cursor' ||
    value === 'copilot' ||
    value === 'opencode'
  );
}

function isModelHarnessAssignmentSnapshot(
  value: unknown,
): value is ModelHarnessAssignmentSnapshot {
  return (
    isRecord(value) &&
    typeof value.revision === 'number' &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    Array.isArray(value.assignments) &&
    value.assignments.every(
      (assignment) =>
        isRecord(assignment) &&
        typeof assignment.modelId === 'string' &&
        (assignment.source === 'claude-managed' ||
          assignment.source === 'codex-managed' ||
          assignment.source === 'cursor-managed' ||
          assignment.source === 'copilot-managed' ||
          assignment.source === 'opencode-managed' ||
          assignment.source === 'ai-gateway' ||
          assignment.source === 'ollama') &&
        isModelHarness(assignment.harness) &&
        isModelHarness(assignment.defaultHarness) &&
        typeof assignment.configurable === 'boolean' &&
        typeof assignment.overridden === 'boolean',
    )
  );
}

async function invokeHarnessAssignmentSnapshot(
  channel: string,
  input?: unknown,
): Promise<ModelHarnessAssignmentSnapshot> {
  const value: unknown =
    input === undefined
      ? await ipcRenderer.invoke(channel)
      : await ipcRenderer.invoke(channel, input);
  if (!isModelHarnessAssignmentSnapshot(value)) {
    throw new Error('Invalid model harness assignment snapshot from main');
  }
  return value;
}

function isOllamaStatus(value: unknown): value is OllamaState['status'] {
  return (
    value === 'stopped' ||
    value === 'starting' ||
    value === 'running-managed' ||
    value === 'running-external' ||
    value === 'error'
  );
}

function isOllamaConnectionMode(
  value: unknown,
): value is OllamaConfigurationUpdate['mode'] {
  return value === 'managed' || value === 'manual';
}

function isOllamaInstallationSource(
  value: unknown,
): value is OllamaInstallationStatus['source'] {
  return (
    value === 'persisted' ||
    value === 'environment' ||
    value === 'auto-detected' ||
    value === 'browse' ||
    value === 'installed' ||
    value === 'not-found'
  );
}

function isOllamaInstallationStatus(
  value: unknown,
): value is OllamaInstallationStatus {
  return (
    isRecord(value) &&
    typeof value.platform === 'string' &&
    typeof value.ready === 'boolean' &&
    (value.path === null || typeof value.path === 'string') &&
    (value.version === null || typeof value.version === 'string') &&
    isOllamaInstallationSource(value.source) &&
    typeof value.checkedAt === 'string' &&
    typeof value.automaticInstallSupported === 'boolean' &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isOllamaState(value: unknown): value is OllamaState {
  return (
    isRecord(value) &&
    typeof value.port === 'number' &&
    isOllamaStatus(value.status) &&
    Array.isArray(value.models) &&
    value.models.every((entry) => isOllamaModelEntry(entry)) &&
    isOllamaConnectionMode(value.mode) &&
    isOllamaInstallationStatus(value.installation) &&
    (value.serverVersion === undefined ||
      typeof value.serverVersion === 'string') &&
    (value.refreshedAt === undefined ||
      typeof value.refreshedAt === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isOllamaInstallProgressPhase(
  value: unknown,
): value is OllamaInstallProgress['phase'] {
  return (
    value === 'starting' ||
    value === 'downloading' ||
    value === 'verifying' ||
    value === 'installing' ||
    value === 'detecting' ||
    value === 'success' ||
    value === 'failure'
  );
}

function isOllamaInstallProgress(
  value: unknown,
): value is OllamaInstallProgress {
  return (
    isRecord(value) &&
    isOllamaInstallProgressPhase(value.phase) &&
    typeof value.message === 'string' &&
    (value.downloadedBytes === undefined ||
      typeof value.downloadedBytes === 'number') &&
    (value.totalBytes === undefined || typeof value.totalBytes === 'number') &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.version === undefined || typeof value.version === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isOllamaConnectionTestResult(
  value: unknown,
): value is OllamaConnectionTestResult {
  return (
    isRecord(value) &&
    typeof value.ok === 'boolean' &&
    value.host === '127.0.0.1' &&
    typeof value.port === 'number' &&
    typeof value.checkedAt === 'string' &&
    typeof value.latencyMs === 'number' &&
    (value.version === undefined || typeof value.version === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isValidOllamaPort(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65535
  );
}

function isOllamaConfigurationUpdate(
  value: unknown,
): value is OllamaConfigurationUpdate {
  return (
    isRecord(value) &&
    isOllamaConnectionMode(value.mode) &&
    isValidOllamaPort(value.port)
  );
}

function isOllamaPullProgress(value: unknown): value is OllamaPullProgress {
  return (
    isRecord(value) &&
    typeof value.model === 'string' &&
    typeof value.status === 'string' &&
    typeof value.done === 'boolean' &&
    (value.completed === undefined || typeof value.completed === 'number') &&
    (value.total === undefined || typeof value.total === 'number') &&
    (value.digest === undefined || typeof value.digest === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

function isGitInstallProgressPhase(
  value: unknown,
): value is GitExecutableInstallProgress['phase'] {
  return (
    value === 'starting' ||
    value === 'running' ||
    value === 'verifying' ||
    value === 'success' ||
    value === 'failure'
  );
}

function isGitExecutableInstallProgress(
  value: unknown,
): value is GitExecutableInstallProgress {
  return (
    isRecord(value) &&
    isGitInstallProgressPhase(value.phase) &&
    typeof value.message === 'string' &&
    (value.output === undefined || typeof value.output === 'string') &&
    (value.path === undefined || typeof value.path === 'string') &&
    (value.version === undefined || typeof value.version === 'string') &&
    (value.error === undefined || typeof value.error === 'string')
  );
}

try {
  const pkgPath = join(__dirname, '../../package.json');
  const raw = readFileSync(pkgPath, 'utf8');
  const parsed: unknown = JSON.parse(raw);
  const config = parseModelPackageConfig(parsed);
  claudeModelEntries = config.claudeModels;
  modelAliases = config.modelAliases;
  codexModelEntries = config.codexModels;
} catch {
  // Non-fatal — models will just be unavailable.
}

// Bootstrap Ollama model entries from the main process (synchronous IPC).
// The main process populates these from a cache file before any renderer window
// is created, matching the Claude/Codex pattern.
//
// When Ollama is disabled for the current platform/build, bootstrap is skipped
// so `ollamaModelEntries` — and therefore both the directly-exposed
// `window.ollamaModelEntries` and the shared `initOllamaModels` catalog below —
// stay empty. Renderer surfaces that guard on `OLLAMA_MODELS.length > 0` then
// drop Ollama automatically.
if (isOllamaSupportedOnPlatform()) {
  try {
    const snapshot: unknown = ipcRenderer.sendSync(
      IPC_CHANNELS.modelRegistryGet,
    );
    if (isModelRegistrySnapshot(snapshot)) {
      ollamaModelEntries = snapshot.ollama;
    }
  } catch {
    // Non-fatal — Ollama models will just be unavailable until first refresh.
  }
}

// Populate the shared types registries for any preload-level usage. When Ollama
// is disabled `ollamaModelEntries` is the empty array, keeping the catalog bare.
initClaudeModels(omitModelFeatureFlags(claudeModelEntries));
initModelAliases(modelAliases);
initCodexModels(omitModelFeatureFlags(codexModelEntries));
initOllamaModels(ollamaModelEntries);

// ---------------------------------------------------------------------------
// Dev-mode indicator: expose isDev flag and current git branch to the renderer.
// ---------------------------------------------------------------------------
interface DevInfo {
  isDev: boolean;
  branch: string | null;
}

const devInfo: DevInfo = {
  isDev: false,
  branch: null,
};
if (process.env.NODE_ENV === 'development') {
  devInfo.isDev = true;
  try {
    devInfo.branch = execFileSync(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      {
        cwd: join(__dirname, '../..'),
        encoding: 'utf-8',
        timeout: 3_000,
        windowsHide: hostPlatform === 'win32',
      },
    ).trim();
  } catch {
    // Non-fatal — branch will just show as null.
  }
}

function isWorkspaceReferenceRepoStatusEvent(
  value: unknown,
): value is WorkspaceReferenceRepoStatusEvent {
  if (!isRecord(value) || typeof value.workspaceId !== 'string') {
    return false;
  }

  if (
    value.didUpdateReferenceRepo !== undefined &&
    typeof value.didUpdateReferenceRepo !== 'boolean'
  ) {
    return false;
  }

  return value.status === null || isRecord(value.status);
}

function isWorkspaceSourceChangesAppliedEvent(
  value: unknown,
): value is WorkspaceSourceChangesAppliedEvent {
  return (
    isRecord(value) &&
    (value.clientRequestId === undefined ||
      typeof value.clientRequestId === 'string') &&
    typeof value.workspaceId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.branchName === 'string' &&
    typeof value.createdWorktree === 'boolean'
  );
}

function isProjectSourceChangesAppliedEvent(
  value: unknown,
): value is ProjectSourceChangesAppliedEvent {
  return (
    isRecord(value) &&
    (value.clientRequestId === undefined ||
      typeof value.clientRequestId === 'string') &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.branchName === 'string' &&
    typeof value.createdWorktree === 'boolean'
  );
}

function hasTerminalRouteKeys(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  projectId: string;
  worktreeId: string;
  terminalId: string;
} {
  return (
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.terminalId === 'string'
  );
}

function isTerminalOutputEvent(value: unknown): value is TerminalOutputEvent {
  if (!isRecord(value) || !hasTerminalRouteKeys(value)) {
    return false;
  }
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) {
    return false;
  }
  // `data` is transported as a Uint8Array via Electron structured clone.
  return value.data instanceof Uint8Array;
}

function isRunCommentsUpdatedEvent(
  value: unknown,
): value is RunCommentsUpdatedEvent {
  return (
    isRecord(value) &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.chatId === 'string' &&
    typeof value.externalId === 'string' &&
    typeof value.commentRevision === 'number' &&
    Number.isFinite(value.commentRevision) &&
    typeof value.lastSeenCommentRevision === 'number' &&
    Number.isFinite(value.lastSeenCommentRevision) &&
    typeof value.unreadCommentCount === 'number' &&
    Number.isFinite(value.unreadCommentCount) &&
    typeof value.ownCommentsOnly === 'boolean'
  );
}

function isTerminalSpawnedEvent(value: unknown): value is TerminalSession {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.projectId === 'string' &&
    typeof value.worktreeId === 'string' &&
    typeof value.shell === 'string' &&
    typeof value.shellBasename === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    (value.running === undefined || typeof value.running === 'boolean') &&
    (value.processName === undefined ||
      value.processName === null ||
      typeof value.processName === 'string') &&
    (value.kind === undefined ||
      value.kind === 'shell' ||
      value.kind === 'script' ||
      value.kind === 'claude-code' ||
      value.kind === 'claude-worker') &&
    (value.focusOnSpawn === undefined ||
      typeof value.focusOnSpawn === 'boolean') &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.chatId === undefined || typeof value.chatId === 'string') &&
    (value.sessionKey === undefined || typeof value.sessionKey === 'string')
  );
}

function isTerminalExitEvent(value: unknown): value is TerminalExitEvent {
  if (!isRecord(value) || !hasTerminalRouteKeys(value)) {
    return false;
  }
  const exitCodeOk =
    value.exitCode === null ||
    (typeof value.exitCode === 'number' && Number.isFinite(value.exitCode));
  const signalOk = value.signal === null || typeof value.signal === 'string';
  return exitCodeOk && signalOk;
}

function isTerminalRunningChangedEvent(
  value: unknown,
): value is TerminalRunningChangedEvent {
  if (!isRecord(value) || !hasTerminalRouteKeys(value)) {
    return false;
  }
  if (typeof value.running !== 'boolean') {
    return false;
  }
  return value.processName === null || typeof value.processName === 'string';
}

function isAuthTerminalOutputEvent(
  value: unknown,
): value is AuthTerminalOutputEvent {
  return (
    isRecord(value) &&
    typeof value.sessionId === 'string' &&
    typeof value.data === 'string'
  );
}

function isAuthTerminalExitEvent(
  value: unknown,
): value is AuthTerminalExitEvent {
  if (!isRecord(value) || typeof value.sessionId !== 'string') {
    return false;
  }
  const providerOk =
    value.provider === 'claude' ||
    value.provider === 'codex' ||
    value.provider === 'github' ||
    value.provider === 'opencode';
  const exitCodeOk =
    value.exitCode === null ||
    (typeof value.exitCode === 'number' && Number.isFinite(value.exitCode));
  const signalOk = value.signal === null || typeof value.signal === 'string';
  return providerOk && exitCodeOk && signalOk;
}

/**
 * Exact message surfaced by every Ollama `CanopyApi` method when Ollama is not
 * supported on the current platform/build (see {@link isOllamaSupportedOnPlatform}).
 * The platform-generic wording matches the main-process error and is
 * brand-safe because it contains no literal product name.
 */
const OLLAMA_DISABLED_MESSAGE = "Ollama isn't available on this platform.";

/**
 * Rejection message used when a main → renderer Ollama payload fails its strict
 * preload validator, so malformed request responses never reach the renderer.
 */
const OLLAMA_MALFORMED_PAYLOAD_MESSAGE =
  'Received a malformed Ollama response from the main process.';
const OLLAMA_INVALID_CONFIGURATION_MESSAGE =
  'Cannot send an invalid Ollama configuration update.';

/** The Ollama slice of {@link CanopyApi}, gated by the platform predicate. */
type OllamaApiSurface = Pick<
  CanopyApi,
  | 'getOllamaState'
  | 'refreshOllamaModels'
  | 'pullOllamaModel'
  | 'deleteOllamaModel'
  | 'setOllamaConfiguration'
  | 'testOllamaConnection'
  | 'redetectOllamaInstallation'
  | 'browseOllamaInstallation'
  | 'installOllama'
  | 'onOllamaStatus'
  | 'onOllamaPullProgress'
  | 'onOllamaInstallProgress'
>;

/**
 * Assert a main → renderer response matches its contract before it reaches the
 * renderer. A malformed payload rejects the request promise rather than leaking
 * an unvalidated shape past the preload boundary.
 */
function assertPayload<T>(
  value: unknown,
  guard: (candidate: unknown) => candidate is T,
): T {
  if (!guard(value)) {
    throw new Error(OLLAMA_MALFORMED_PAYLOAD_MESSAGE);
  }
  return value;
}

// When Ollama is unsupported on this platform/build every Ollama request method
// rejects with the exact unsupported message and the subscriptions no-op (no
// listener attached, inert unsubscribe). Supported builds keep the IPC bridges,
// with strict per-payload validators guarding every returned object and every
// progress event. All three layers agree via `isOllamaSupportedOnPlatform()`.
const platformOllamaApi: OllamaApiSurface = isOllamaSupportedOnPlatform()
  ? {
      getOllamaState: () =>
        ipcRenderer
          .invoke(IPC_CHANNELS.ollamaGetState)
          .then((state) => assertPayload(state, isOllamaState)),
      refreshOllamaModels: () =>
        ipcRenderer.invoke(IPC_CHANNELS.ollamaRefreshModels),
      pullOllamaModel: (req) =>
        ipcRenderer.invoke(IPC_CHANNELS.ollamaPullModel, req),
      deleteOllamaModel: (req) =>
        ipcRenderer.invoke(IPC_CHANNELS.ollamaDeleteModel, req),
      setOllamaConfiguration: (update): Promise<OllamaState> => {
        if (!isOllamaConfigurationUpdate(update)) {
          return Promise.reject(
            new Error(OLLAMA_INVALID_CONFIGURATION_MESSAGE),
          );
        }
        return ipcRenderer
          .invoke(IPC_CHANNELS.ollamaSetConfiguration, update)
          .then((state) => assertPayload(state, isOllamaState));
      },
      testOllamaConnection: (port, options) =>
        ipcRenderer
          .invoke(IPC_CHANNELS.ollamaTestConnection, {
            port,
            background: options?.background,
          })
          .then((result) =>
            assertPayload(result, isOllamaConnectionTestResult),
          ),
      redetectOllamaInstallation: () =>
        ipcRenderer
          .invoke(IPC_CHANNELS.ollamaRedetectInstallation)
          .then((state) => assertPayload(state, isOllamaState)),
      browseOllamaInstallation: () =>
        ipcRenderer
          .invoke(IPC_CHANNELS.ollamaBrowseInstallation)
          .then((state) => assertPayload(state, isOllamaState)),
      installOllama: () =>
        ipcRenderer
          .invoke(IPC_CHANNELS.ollamaInstall)
          .then((state) => assertPayload(state, isOllamaState)),
      onOllamaStatus: (callback) => {
        const handler = (
          _event: Electron.IpcRendererEvent,
          data: unknown,
        ): void => {
          if (isOllamaState(data)) {
            callback(data);
          }
        };
        ipcRenderer.on(IPC_CHANNELS.ollamaStatus, handler);
        return () => {
          ipcRenderer.removeListener(IPC_CHANNELS.ollamaStatus, handler);
        };
      },
      onOllamaPullProgress: (callback) => {
        const handler = (
          _event: Electron.IpcRendererEvent,
          data: unknown,
        ): void => {
          if (isOllamaPullProgress(data)) {
            callback(data);
          }
        };
        ipcRenderer.on(IPC_CHANNELS.ollamaPullProgress, handler);
        return () => {
          ipcRenderer.removeListener(IPC_CHANNELS.ollamaPullProgress, handler);
        };
      },
      onOllamaInstallProgress: (callback) => {
        const handler = (
          _event: Electron.IpcRendererEvent,
          data: unknown,
        ): void => {
          if (isOllamaInstallProgress(data)) {
            callback(data);
          }
        };
        ipcRenderer.on(IPC_CHANNELS.ollamaInstallProgress, handler);
        return () => {
          ipcRenderer.removeListener(
            IPC_CHANNELS.ollamaInstallProgress,
            handler,
          );
        };
      },
    }
  : {
      getOllamaState: () => Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      refreshOllamaModels: () =>
        Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      pullOllamaModel: () => Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      deleteOllamaModel: () =>
        Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      setOllamaConfiguration: () =>
        Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      testOllamaConnection: () =>
        Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      redetectOllamaInstallation: () =>
        Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      browseOllamaInstallation: () =>
        Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      installOllama: () => Promise.reject(new Error(OLLAMA_DISABLED_MESSAGE)),
      onOllamaStatus: () => () => {},
      onOllamaPullProgress: () => () => {},
      onOllamaInstallProgress: () => () => {},
    };

function createE2eOllamaApi(api: OllamaApiSurface): OllamaApiSurface {
  if (
    !__CANOPY_E2E__ ||
    !isOllamaSupportedOnPlatform() ||
    process.env.CANOPY_E2E_OLLAMA_SETUP !== 'managed-install'
  ) {
    return api;
  }

  const installListeners = new Set<(progress: OllamaInstallProgress) => void>();
  let state: OllamaState = {
    port: 11434,
    status: 'stopped',
    models: [],
    mode: 'managed',
    installation: {
      platform: localPlatform,
      ready: false,
      path: null,
      version: null,
      source: 'not-found',
      checkedAt: '2026-07-16T00:00:00.000Z',
      automaticInstallSupported: localPlatform !== 'linux',
    },
  };

  return {
    ...api,
    getOllamaState: () => Promise.resolve(state),
    refreshOllamaModels: () => Promise.resolve(state),
    redetectOllamaInstallation: () => {
      if (localPlatform === 'linux') {
        state = {
          ...state,
          status: 'running-managed',
          installation: {
            ...state.installation,
            ready: true,
            path: '/usr/local/bin/ollama',
            version: '0.14.1',
            source: 'auto-detected',
          },
        };
      }
      return Promise.resolve(state);
    },
    browseOllamaInstallation: () => {
      if (localPlatform === 'linux') {
        state = {
          ...state,
          status: 'running-managed',
          installation: {
            ...state.installation,
            ready: true,
            path: '/opt/ollama/bin/ollama',
            version: '0.14.1',
            source: 'browse',
          },
        };
      }
      return Promise.resolve(state);
    },
    installOllama: async (): Promise<OllamaState> => {
      if (localPlatform === 'linux') {
        throw new Error(
          'Automatic Ollama installation is not available on Linux.',
        );
      }
      const progress: OllamaInstallProgress = {
        phase: 'downloading',
        message: 'Downloading Ollama...',
        downloadedBytes: 50,
        totalBytes: 100,
      };
      installListeners.forEach((listener) => listener(progress));
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = {
        ...state,
        status: 'running-managed',
        installation: {
          ...state.installation,
          ready: true,
          path:
            localPlatform === 'win32'
              ? 'C:\\Program Files\\Ollama\\ollama.exe'
              : '/Applications/Ollama.app/Contents/Resources/ollama',
          version: '0.14.1',
          source: 'installed',
        },
      };
      installListeners.forEach((listener) =>
        listener({
          phase: 'success',
          message: 'Ollama installed.',
        }),
      );
      return state;
    },
    onOllamaStatus: () => () => {},
    onOllamaPullProgress: () => () => {},
    onOllamaInstallProgress: (listener) => {
      installListeners.add(listener);
      return () => {
        installListeners.delete(listener);
      };
    },
  };
}

const ollamaApi = createE2eOllamaApi(platformOllamaApi);

let firstProjectsLoadProducerActive = false;
const e2eReportFirstProjectsLoad = (():
  | ((stage: string, details: Record<string, unknown>) => void)
  | undefined => {
  if (!__CANOPY_E2E__) return undefined;
  try {
    const raw = process.env.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS;
    if (!raw || raw.length > 4096) return undefined;
    const config: unknown = JSON.parse(raw);
    if (!isRecord(config)) return undefined;
    const validIdentity = (value: unknown, maximum = 160): boolean =>
      value === undefined ||
      (typeof value === 'string' &&
        value.length <= maximum &&
        /^[a-z0-9_-]+$/i.test(value));
    const owners = config.owners;
    if (
      config.firstProjectsLoad !== true ||
      config.mode !== 'close' ||
      !validIdentity(config.launchId) ||
      !validIdentity(config.caseId) ||
      (config.fixturePid !== undefined &&
        (typeof config.fixturePid !== 'number' ||
          !Number.isInteger(config.fixturePid) ||
          config.fixturePid <= 0)) ||
      (owners !== undefined &&
        (!Array.isArray(owners) ||
          owners.length > 2 ||
          owners.some(
            (owner) =>
              !isRecord(owner) ||
              typeof owner.projectId !== 'string' ||
              typeof owner.worktreeId !== 'string' ||
              !validIdentity(owner.projectId, 128) ||
              !validIdentity(owner.worktreeId, 128),
          ))) ||
      typeof config.file !== 'string' ||
      !isAbsolute(config.file) ||
      !config.file.endsWith('.jsonl') ||
      typeof config.firstProjectsLoadFile !== 'string' ||
      !isAbsolute(config.firstProjectsLoadFile) ||
      !config.firstProjectsLoadFile.endsWith('.jsonl') ||
      config.firstProjectsLoadFile === config.file
    )
      return undefined;
    firstProjectsLoadProducerActive = true;
    ipcRenderer.once('canopy:e2e:first-projects-load-stop', () => {
      firstProjectsLoadProducerActive = false;
    });
    return (stage: string, details: Record<string, unknown>): void => {
      if (!firstProjectsLoadProducerActive) return;
      ipcRenderer.send('canopy:e2e:first-projects-load', stage, details);
    };
  } catch {
    return undefined;
  }
})();
const e2eIsFirstProjectsLoadActive = e2eReportFirstProjectsLoad
  ? (): boolean => firstProjectsLoadProducerActive
  : undefined;

function organizationReply<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): T | OrganizationOperationRefusal {
  const refused = OrganizationOperationRefusalSchema.safeParse(value);
  if (refused.success) return refused.data;
  return schema.parse(value);
}

const canopyApi: CanopyApi = {
  reloadWindow: () => ipcRenderer.invoke(IPC_CHANNELS.appWindowReload),
  restartApp: () => ipcRenderer.invoke(IPC_CHANNELS.appWindowRestart),
  notifyStartupUnlocked: () =>
    ipcRenderer.invoke(IPC_CHANNELS.appStartupUnlocked),
  loadProjects: () => ipcRenderer.invoke(IPC_CHANNELS.projectsLoad),
  getDesktopSessionSnapshot: (args) =>
    ipcRenderer.invoke(IPC_CHANNELS.desktopSessionSnapshot, args),
  onDesktopSessionSnapshotStale: (cb) => {
    const handler = (): void => {
      cb();
    };
    ipcRenderer.on(IPC_CHANNELS.desktopSessionSnapshotStale, handler);
    return (): void => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.desktopSessionSnapshotStale,
        handler,
      );
    };
  },
  deepLinkResolveShare: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.deepLinkResolveShare, request),
  deepLinkReportHandoffEvent: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.deepLinkReportHandoffEvent, request),
  onDeepLinkShareOpen: (cb) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: DeepLinkShareOpenEvent,
    ): void => {
      cb(data);
    };
    ipcRenderer.on(IPC_CHANNELS.deepLinkShareOpen, handler);
    return (): void => {
      ipcRenderer.removeListener(IPC_CHANNELS.deepLinkShareOpen, handler);
    };
  },
  onDeepLinkOrgProjectOpen: (cb) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: OrgProjectDeepLinkOpenEvent,
    ): void => {
      cb(data);
    };
    ipcRenderer.on(IPC_CHANNELS.deepLinkOrgProjectOpen, handler);
    return (): void => {
      ipcRenderer.removeListener(IPC_CHANNELS.deepLinkOrgProjectOpen, handler);
    };
  },
  enableDataSharingForFeature: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.telemetrySharingEnableForFeature, request),
  dismissDataSharingOptInHint: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.telemetrySharingDismissOptInHint, request),
  onDeepLinkPrivacyOptInOpen: (cb) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: NonNullable<DesktopSettingsDeepLink['optIn']>,
    ): void => {
      cb(data);
    };
    ipcRenderer.on(IPC_CHANNELS.deepLinkPrivacyOptInOpen, handler);
    return (): void => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.deepLinkPrivacyOptInOpen,
        handler,
      );
    };
  },
  onDeepLinkSettingsOpen: (cb) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      section: DesktopSettingsDeepLink['section'],
    ): void => {
      cb(section);
    };
    ipcRenderer.on(IPC_CHANNELS.deepLinkSettingsOpen, handler);
    return (): void => {
      ipcRenderer.removeListener(IPC_CHANNELS.deepLinkSettingsOpen, handler);
    };
  },
  onDeepLinkRemoteControlOpen: (cb) => {
    const handler = (): void => {
      cb();
    };
    ipcRenderer.on(IPC_CHANNELS.deepLinkRemoteControlOpen, handler);
    return (): void => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.deepLinkRemoteControlOpen,
        handler,
      );
    };
  },
  onDeepLinkBillingUnlocked: (cb) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      link: DesktopBillingDeepLink,
    ): void => {
      cb(link);
    };
    ipcRenderer.on(IPC_CHANNELS.deepLinkBillingUnlocked, handler);
    return (): void => {
      ipcRenderer.removeListener(IPC_CHANNELS.deepLinkBillingUnlocked, handler);
    };
  },
  invalidateDesktopSessionSnapshot: () =>
    ipcRenderer.invoke(IPC_CHANNELS.desktopSessionSnapshotInvalidate),
  saveProjects: (items, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectsSave, items, options),
  setTrackedBaseBranch: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeSetTrackedBaseBranch, request),
  getUiZoomFactor: () => webFrame.getZoomFactor(),
  loadPreferences: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesLoad, options),
  acknowledgePreferencesLoadError: () =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesAcknowledgeLoadError),
  savePreferences: (preferences, options) =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesSave, preferences, options),
  setPipelineDisabledPreference: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesSetPipelineDisabled, request),
  updateSuggestions: (update) =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesUpdateSuggestions, update),
  updateOnboardingTips: (update) =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesUpdateOnboardingTips, update),
  getClaudeMods: (args) => ipcRenderer.invoke(IPC_CHANNELS.claudeModsGet, args),
  updateClaudeMods: (update) =>
    ipcRenderer.invoke(IPC_CHANNELS.claudeModsUpdate, update),
  setApprovalDefaultPreference: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesSetApprovalDefault, request),
  createPrimaryDataDir: () =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesCreatePrimaryDataDir),
  openMemoryDir: (workspaceId) =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesOpenMemoryDir, workspaceId),
  importClaudeMemory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.preferencesImportClaudeMemory, request),
  ...(__CANOPY_E2E__ &&
  e2eReportFirstProjectsLoad &&
  e2eIsFirstProjectsLoadActive
    ? {
        e2eReportFirstProjectsLoad,
        e2eIsFirstProjectsLoadActive,
      }
    : {}),
  onAutoArchiveCompleted: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      notification: AutoArchiveNotification,
    ): void => {
      if (
        notification !== null &&
        typeof notification === 'object' &&
        typeof notification.workspaceId === 'string' &&
        typeof notification.workspaceName === 'string' &&
        typeof notification.targetId === 'string' &&
        typeof notification.targetName === 'string' &&
        typeof notification.inactivityDays === 'number' &&
        (notification.status === 'success' || notification.status === 'failure')
      ) {
        callback(notification);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.autoArchiveCompleted, handler);
    return (): void => {
      ipcRenderer.removeListener(IPC_CHANNELS.autoArchiveCompleted, handler);
    };
  },
  loadEnvironmentConfig: () =>
    ipcRenderer.invoke(IPC_CHANNELS.environmentConfigLoad),
  saveEnvironmentConfig: (data) =>
    ipcRenderer.invoke(IPC_CHANNELS.environmentConfigSave, data),
  showOsNotification: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.osNotificationShow, request),
  optInToOsNotifications: () =>
    ipcRenderer.invoke(IPC_CHANNELS.osNotificationOptIn),
  openOsNotificationSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.osNotificationOpenSystemSettings),
  onOsNotificationClicked: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as OsNotificationClickEvent);
    ipcRenderer.on(IPC_CHANNELS.osNotificationClicked, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.osNotificationClicked, handler);
    };
  },
  onActivationCampaignNavigate: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as ActivationCampaignNavigateEvent);
    ipcRenderer.on(IPC_CHANNELS.activationCampaignNavigate, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.activationCampaignNavigate,
        handler,
      );
    };
  },
  onOsNotificationClosed: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as OsNotificationCloseEvent);
    ipcRenderer.on(IPC_CHANNELS.osNotificationClosed, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.osNotificationClosed, handler);
    };
  },
  onPreferencesChanged: (callback) => {
    const handler = (): void => callback();
    ipcRenderer.on(IPC_CHANNELS.preferencesChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.preferencesChanged, handler);
    };
  },
  onPreferencesSynced: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      preferences: PreferencesSaveResult,
    ): void => callback(preferences);
    ipcRenderer.on(IPC_CHANNELS.preferencesSynced, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.preferencesSynced, handler);
    };
  },
  getFileIndex: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileIndexGet, request),
  getFileTreeRoots: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileTreeRoots, request),
  getFileTreeDirectory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileTreeDirectory, request),
  mutateFileTree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileTreeMutate, request),
  startFileTreeWatch: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileTreeWatchStart, request),
  stopFileTreeWatch: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileTreeWatchStop, request),
  onFileTreeChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      changeEvent: Parameters<typeof callback>[0],
    ): void => callback(changeEvent);
    ipcRenderer.on(IPC_CHANNELS.fileTreeChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.fileTreeChanged, handler);
    };
  },
  resolveFileReference: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileReferenceResolve, request),
  importWorktreeAttachments: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeImportAttachments, request),
  getDefaultCloneDirectory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.repoDefaultCloneDir),
  listDefaultRepos: () => ipcRenderer.invoke(IPC_CHANNELS.repoListDefaultRepos),
  browseForRepo: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.repoBrowse, request),
  addLocalRepo: (repoPath) =>
    ipcRenderer.invoke(IPC_CHANNELS.repoAddLocal, repoPath),
  addRemoteRepo: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.repoAddRemote, request),
  probeCloneDestination: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.repoProbeCloneDestination, request),
  initLocalRepo: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.repoInitLocal, request),
  addWorkspaceFromFolder: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceAddFromFolder, request),
  checkAddWorkspaceFromFolder: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceCheckAddFromFolder, request),
  addWorkspaceFromRemote: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceAddFromRemote, request),
  listCloneJobs: () => ipcRenderer.invoke(IPC_CHANNELS.cloneJobsList),
  backgroundCloneJob: (jobId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cloneJobsBackground, jobId),
  cancelCloneJob: (jobId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cloneJobsCancel, jobId),
  dismissCloneJob: (jobId) =>
    ipcRenderer.invoke(IPC_CHANNELS.cloneJobsDismiss, jobId),
  onCloneJobsChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      jobs: CloneJobSnapshot[],
    ): void => listener(jobs);
    ipcRenderer.on(IPC_CHANNELS.cloneJobsChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.cloneJobsChanged, handler);
    };
  },
  createNewWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceCreateNew, request),
  convertWorkspaceType: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceConvertType, request),
  readWorkspaceDriftSummary: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceReadDriftSummary, request),
  getRemoteUrl: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.repoGetRemoteUrl, request),
  linkRemote: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.repoLinkRemote, request),
  readCanopyJson: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.canopyJsonRead, request),
  browseForCloneDirectory: () => ipcRenderer.invoke(IPC_CHANNELS.repoBrowseDir),
  createWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeCreate, request),
  archiveWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeArchive, request),
  checkWorktreeRemovalAdmission: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeCheckRemovalAdmission, request),
  describeWorktreeDiscard: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeDiscardDescribe, request),
  discardWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeDiscard, request),
  describeProjectDeletionDiscard: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceDeleteDiscardDescribe, request),
  getDiffStats: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeDiffStats, request),
  getDiffStatsBatch: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeDiffStatsBatch, request),
  retryWorktreeHealthCheck: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeHealthCheck, request),
  renameBranch: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeRenameBranch, request),
  scheduleTaskBranchNaming: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeScheduleTaskBranchNaming, request),
  listBranches: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeListBranches, request),
  homeListBranchTargets: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.homeListBranchTargets, request),
  homeDiscoverEnvironment: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.homeDiscoverEnvironment, request),
  configurationComposerAdvisorEnvironment: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.configurationComposerAdvisorEnvironment,
      request,
    ),
  homeGetCoworkRoot: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.homeGetCoworkRoot, request),
  homeFileIndex: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.homeFileIndex, request),
  switchBranch: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeSwitchBranch, request),
  createBranch: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeCreateBranch, request),
  discoverWorktreeEnv: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeDiscover, request),
  onWorktreeDiscoveryEvent: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as WorktreeDiscoveryEvent);
    ipcRenderer.on(IPC_CHANNELS.worktreeDiscoveryEvent, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.worktreeDiscoveryEvent, handler);
    };
  },
  onWorktreeGitReady: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isWorktreeGitReadyEvent(data)) {
        callback(data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.worktreeGitReady, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.worktreeGitReady, handler);
    };
  },
  onWorktreeGitFailed: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isWorktreeGitFailedEvent(data)) {
        callback(data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.worktreeGitFailed, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.worktreeGitFailed, handler);
    };
  },
  onWorktreeNeedsRepair: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isWorktreeNeedsRepairEvent(data)) {
        callback(data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.worktreeNeedsRepair, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.worktreeNeedsRepair, handler);
    };
  },
  onWorktreeBranchChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isWorktreeBranchChangedEvent(data)) {
        callback(data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.worktreeBranchChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.worktreeBranchChanged, handler);
    };
  },
  onWorktreesFileChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (
        typeof data === 'object' &&
        data !== null &&
        'workspaceId' in data &&
        typeof data.workspaceId === 'string'
      ) {
        const event: WorktreesFileChangedEvent = {
          workspaceId: data.workspaceId,
        };
        callback(event);
      } else if (
        typeof data === 'object' &&
        data !== null &&
        !('workspaceId' in data) &&
        'scope' in data &&
        data.scope === 'all'
      ) {
        callback({ scope: 'all' });
      }
    };
    ipcRenderer.on(IPC_CHANNELS.worktreesFileChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.worktreesFileChanged, handler);
    };
  },
  onWorkspaceWorktreesUpdated: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isWorkspaceWorktreesUpdatedEvent(data)) {
        callback(data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.workspaceWorktreesUpdated, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.workspaceWorktreesUpdated,
        handler,
      );
    };
  },
  createWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceCreate, request),
  createTemporaryWorkspaceFromRepos: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceCreateTemporaryFromRepos, request),
  createTemporaryWorkspaceWorktreeFromRepos: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceCreateTemporaryWorktreeFromRepos,
      request,
    ),
  createTemporaryWorkspaceWorktreeFromWorkspaces: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceCreateTemporaryWorktreeFromWorkspaces,
      request,
    ),
  addRepoToWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceAddRepo, request),
  removeRepoFromWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceRemoveRepo, request),
  initWorkspaceGit: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceInitGit, request),
  attachWorkspaceOrigin: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceAttachOrigin, request),
  importWorkspaceFromRepo: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceImportFromRepo, request),
  combineWorktreeWithWorkspace: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceCombineWorktreeWithWorkspace,
      request,
    ),
  listAdhocMultiRepoJoinOptions: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceListAdhocMultiRepoJoinOptions,
      request,
    ),
  combineWorktreeWithExistingWorktree: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceCombineWorktreeWithExistingWorktree,
      request,
    ),
  listExistingWorktreeJoinOptions: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceListExistingWorktreeJoinOptions,
      request,
    ),
  promoteTemporaryWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspacePromoteTemporary, request),
  previewSplitTemporaryWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSplitTemporaryPreview, request),
  approveSplitTemporaryWorkspaceDestructiveAction: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceSplitTemporaryApproveDestructive,
      request,
    ),
  splitTemporaryWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSplitTemporary, request),
  onWorkspaceSplitTemporaryComplete: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isSplitTemporaryWorkspaceCompleteEvent(data)) {
        callback(data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.workspaceSplitTemporaryComplete, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.workspaceSplitTemporaryComplete,
        handler,
      );
    };
  },
  getWorkspaceSettingsData: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceReadSettingsData, request),
  getWorkspaceReadiness: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceReadReadiness, request),
  setWorkspaceArchiveRetention: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSetArchiveRetention, request),
  setWorkspaceStartPage: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSetStartPage, request),
  setWorkspacePrivateMemory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSetPrivateMemory, request),
  onWorkspacePrivateMemoryChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      workspaceId: unknown,
    ): void => {
      if (typeof workspaceId === 'string') callback(workspaceId);
    };
    ipcRenderer.on(IPC_CHANNELS.workspacePrivateMemoryChanged, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.workspacePrivateMemoryChanged,
        handler,
      );
    };
  },
  resolveProjectStartPage: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.startPageResolve, request),
  addRepoToWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceAddRepoToWorktree, request),
  removeRepoFromWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceRemoveRepoFromWorktree, request),
  createWorkspaceWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceCreateWorktree, request),
  repairWorkspaceWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceRepairWorktree, request),
  archiveWorkspaceWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceArchiveWorktree, request),
  deleteWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceDelete, request),
  deleteProject: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectDelete, request),
  inspectLifecycleJournal: () =>
    ipcRenderer.invoke(IPC_CHANNELS.lifecycleJournalInspect),
  quarantineLifecycleJournalEntry: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.lifecycleJournalQuarantine, request),
  onWorkspaceReferenceRepoStatus: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (!isWorkspaceReferenceRepoStatusEvent(data)) {
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.workspaceReferenceRepoStatusEvent, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.workspaceReferenceRepoStatusEvent,
        handler,
      );
    };
  },
  resolveWorkspaceReferenceRepoWarning: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceResolveReferenceRepoWarning,
      request,
    ),
  requestWorkspaceReferenceRepoRefresh: (request) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.workspaceRequestReferenceRepoRefresh,
      request,
    ),
  onWorkspaceSourceChangesApplied: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (!isWorkspaceSourceChangesAppliedEvent(data)) {
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.workspaceSourceChangesApplied, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.workspaceSourceChangesApplied,
        handler,
      );
    };
  },
  onProjectSourceChangesApplied: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (!isProjectSourceChangesAppliedEvent(data)) {
        return;
      }
      callback(data);
    };
    ipcRenderer.on(IPC_CHANNELS.projectSourceChangesApplied, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.projectSourceChangesApplied,
        handler,
      );
    };
  },
  applyWorkspaceSourceChanges: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceApplySourceChanges, request),
  applyProjectSourceChanges: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectApplySourceChanges, request),
  loadClaudeMd: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceLoadClaudeMd, request),
  saveClaudeMd: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSaveClaudeMd, request),
  updateWorkspaceMetadata: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceUpdateMetadata, request),
  reorderWorkspaces: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceReorder, request),
  reorderWorktrees: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeReorder, request),
  readWorkspaceScripts: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceReadScripts, request),
  mergeWorkspaceScripts: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceMergeScripts, request),
  saveProjectDefaultPlugins: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectSaveDefaultPlugins, request),
  saveWorkspaceDefaultPlugins: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSaveDefaultPlugins, request),
  runScript: (request) => ipcRenderer.invoke(IPC_CHANNELS.scriptRun, request),
  stopScript: (request) => ipcRenderer.invoke(IPC_CHANNELS.scriptStop, request),
  cancelWorktreeSetup: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.scriptCancelWorktreeSetup, request),
  loadWorktreeScriptRuns: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.scriptLoadWorktreeRuns, request),
  getScriptSourceInfo: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.scriptSourceInfo, request),
  onScriptStarted: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as ScriptStartedEvent);
    ipcRenderer.on(IPC_CHANNELS.scriptStarted, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.scriptStarted, handler);
    };
  },
  onScriptOutput: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as ScriptOutputEvent);
    ipcRenderer.on(IPC_CHANNELS.scriptOutput, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.scriptOutput, handler);
    };
  },
  onScriptComplete: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as ScriptCompleteEvent);
    ipcRenderer.on(IPC_CHANNELS.scriptComplete, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.scriptComplete, handler);
    };
  },
  onCodeGraphBuildStatusChanged: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as CodeGraphBuildStatusChangedEvent);
    ipcRenderer.on(IPC_CHANNELS.codeGraphBuildStatusChanged, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.codeGraphBuildStatusChanged,
        handler,
      );
    };
  },
  codeGraphGetWorktreeSummary: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.codeGraphGetWorktreeSummary, request),
  codeGraphBuildWorktree: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.codeGraphBuildWorktree, request),
  codeGraphSchedulePerformanceBuild: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.codeGraphSchedulePerformanceBuild, request),
  codeGraphGetWorkspaceSummary: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.codeGraphGetWorkspaceSummary, request),
  codeGraphBuildWorkspace: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.codeGraphBuildWorkspace, request),
  codeGraphGetGenerationQueue: () =>
    ipcRenderer.invoke(IPC_CHANNELS.codeGraphGetGenerationQueue),
  codeGraphReorderGenerationQueue: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.codeGraphReorderGenerationQueue, request),
  onCodeGraphGenerationQueueChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isCodeGraphGenerationQueueSnapshot(data)) {
        callback(data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.codeGraphGenerationQueueChanged, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.codeGraphGenerationQueueChanged,
        handler,
      );
    };
  },
  saveProjectScripts: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectSaveScripts, request),
  saveWorkspaceScripts: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSaveScripts, request),
  saveWorkspacePlanDetection: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSavePlanDetection, request),
  saveWorkspaceRepoScripts: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSaveRepoScripts, request),
  runHook: (request) => ipcRenderer.invoke(IPC_CHANNELS.hookRun, request),
  stopHook: (request) => ipcRenderer.invoke(IPC_CHANNELS.hookStop, request),
  loadWorktreeHookRuns: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.hookLoadWorktreeRuns, request),
  onHookStarted: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as HookStartedEvent);
    ipcRenderer.on(IPC_CHANNELS.hookStarted, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.hookStarted, handler);
    };
  },
  onHookOutput: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as HookOutputEvent);
    ipcRenderer.on(IPC_CHANNELS.hookOutput, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.hookOutput, handler);
    };
  },
  onHookComplete: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as HookCompleteEvent);
    ipcRenderer.on(IPC_CHANNELS.hookComplete, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.hookComplete, handler);
    };
  },
  onHookSkippedPaused: (callback) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown): void =>
      callback(data as HookSkippedPausedEvent);
    ipcRenderer.on(IPC_CHANNELS.hookSkippedPaused, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.hookSkippedPaused, handler);
    };
  },
  saveProjectHooks: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.projectSaveHooks, request),
  saveWorkspaceHooks: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSaveHooks, request),
  saveWorkspaceRepoHooks: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.workspaceSaveRepoHooks, request),
  getHookSourceInfo: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.hookSourceInfo, request),
  inspectHookChatPluginDependencies: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.hookChatPluginDependenciesInspect, request),
  inspectRecommendedPlugins: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.recommendedPluginsInspect, request),
  applyRecommendedPlugins: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.recommendedPluginsApply, request),
  setWorktreePausedHooks: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeSetPausedHooks, request),
  setWorktreeHidden: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeSetHidden, request),
  setWorktreeLabel: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeSetLabel, request),
  setWorktreePinned: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeSetPinned, request),
  setWorktreeBranchGrouping: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeSetBranchGrouping, request),
  harnessAssignments: {
    load: () =>
      invokeHarnessAssignmentSnapshot(IPC_CHANNELS.harnessAssignmentsLoad),
    set: (input) =>
      invokeHarnessAssignmentSnapshot(
        IPC_CHANNELS.harnessAssignmentsSet,
        input,
      ),
    reset: (input) =>
      invokeHarnessAssignmentSnapshot(
        IPC_CHANNELS.harnessAssignmentsReset,
        input,
      ),
  },
  getModelRegistry: () => {
    const request = ipcRenderer.invoke(IPC_CHANNELS.modelRegistryGet);
    // Log-only here: the live update path rejects, but refusing the startup
    // read too would hide every model if the validator, not the data, is
    // wrong.
    void request.then(
      (snapshot: unknown) => {
        if (isModelRegistrySnapshot(snapshot)) return;
        // eslint-disable-next-line no-console
        console.error(
          `[preload] Model registry snapshot failed validation at ${describeModelRegistrySnapshotRejection(snapshot) ?? 'unknown'}; using it anyway.`,
        );
      },
      // The caller gets the same rejection from `request`.
      () => undefined,
    );
    return request;
  },
  retryAiGatewayModelCatalog: async () => {
    await ipcRenderer.invoke(IPC_CHANNELS.aiGatewayModelCatalogRetry);
  },
  onModelRegistryUpdated: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isModelRegistrySnapshot(data)) {
        callback(data);
        return;
      }
      // eslint-disable-next-line no-console
      console.error(
        `[preload] Rejected model registry snapshot at ${describeModelRegistrySnapshotRejection(data) ?? 'unknown'}; check featureFlag keys and payload shape.`,
      );
    };
    ipcRenderer.on(IPC_CHANNELS.modelRegistryUpdated, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.modelRegistryUpdated, handler);
    };
  },
  getResourceMonitorSnapshot: () =>
    ipcRenderer.invoke(IPC_CHANNELS.resourceMonitorGetSnapshot),
  onResourceMonitorSnapshot: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: unknown,
    ): void => {
      if (isResourceMonitorSnapshot(snapshot)) {
        listener(snapshot);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.resourceMonitorSnapshot, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.resourceMonitorSnapshot, handler);
    };
  },
  memoryDiagnostics: {
    getStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDiagnosticsGetStatus),
    createReport: () =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDiagnosticsCreateReport),
    revealReport: (reportId) =>
      ipcRenderer.invoke(IPC_CHANNELS.memoryDiagnosticsRevealReport, reportId),
  },
  slowActions: {
    loadSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.slowActionSnapshot),
    clear: () => ipcRenderer.invoke(IPC_CHANNELS.slowActionClear),
    onEvent: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: unknown,
      ): void => {
        if (isSlowActionEvent(event)) {
          listener(event);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.slowActionEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.slowActionEvent, handler);
      };
    },
  },
  getWakeLockState: () => ipcRenderer.invoke(IPC_CHANNELS.wakeLockGetState),
  onWakeLockStateChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: unknown,
    ): void => {
      if (isWakeLockState(state)) {
        listener(state);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.wakeLockStateChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.wakeLockStateChanged, handler);
    };
  },
  // Ollama bridges — gated by `__CANOPY_OLLAMA_ENABLED__` (see `ollamaApi`).
  ...ollamaApi,
  // Git executable detection/validation/install bridges (Phase T3). Each
  // request maps 1:1 to an `IPC_CHANNELS.gitExecutable*` channel; the backend
  // plan implements the matching `handle`/emit side.
  getGitExecutableStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.gitExecutableStatus),
  redetectGitExecutable: () =>
    ipcRenderer.invoke(IPC_CHANNELS.gitExecutableRedetect),
  browseGitExecutable: () =>
    ipcRenderer.invoke(IPC_CHANNELS.gitExecutableBrowse),
  installGitWithXcode: () =>
    ipcRenderer.invoke(IPC_CHANNELS.gitExecutableInstallXcode),
  installGitWithWinget: () =>
    ipcRenderer.invoke(IPC_CHANNELS.gitExecutableInstallWinget),
  onGitInstallProgress: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: unknown,
    ): void => {
      if (isGitExecutableInstallProgress(data)) {
        callback(data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.gitExecutableInstallProgress, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.gitExecutableInstallProgress,
        handler,
      );
    };
  },
  getGitHubCliStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsGitHubCliStatus),
  starSourceRepository: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsStarSourceRepository),
  getClaudeAuthStatus: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsClaudeAuthStatus, options),
  getCodexAuthStatus: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsCodexAuthStatus, options),
  getProviderCarryover: (provider) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsProviderCarryover, provider),
  getGitHubPermissions: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsGitHubPermissions, request),
  listUserGitHubRepos: () =>
    ipcRenderer.invoke(IPC_CHANNELS.githubListUserRepos),
  loadGitHubPat: () => ipcRenderer.invoke(IPC_CHANNELS.settingsLoadGitHubPat),
  saveGitHubPat: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsSaveGitHubPat, token),
  refreshGitHubCredentials: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsRefreshGitHubCredentials),
  loadLinearToken: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsLoadLinearToken),
  saveLinearToken: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsSaveLinearToken, token),
  validateLinearToken: (token) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsValidateLinearToken, token),
  loadModelGatewayCredential: (organizationId, expectedBaseUrl) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.modelGatewayLoadCredential,
      organizationId,
      expectedBaseUrl,
    ),
  saveModelGatewayCredential: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.modelGatewaySaveCredential, input),
  validateModelGatewayCredential: (input) =>
    ipcRenderer.invoke(IPC_CHANNELS.modelGatewayValidateCredential, input),
  onModelGatewayCredentialChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      organizationId: unknown,
    ): void => {
      if (typeof organizationId === 'string') callback(organizationId);
    };
    ipcRenderer.on(IPC_CHANNELS.modelGatewayCredentialChanged, handler);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.modelGatewayCredentialChanged,
        handler,
      );
    };
  },
  loadCanopyCloudAccount: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsLoadCanopyCloudAccount),
  getCanopyCloudBaseUrl: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsGetCanopyCloudBaseUrl),
  ...createAuthenticatedPortalApi(ipcRenderer),
  loadCanopyCloudAiCredits: (scope) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsLoadCanopyCloudAiCredits, scope),
  loadCanopyCloudEntitlements: (scope) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsLoadCanopyCloudEntitlements, scope),
  watchCanopyCloudModelLibrary: (scope, onChanged) => {
    const watchId = randomUUID();
    let active = true;
    const handler = (
      _event: Electron.IpcRendererEvent,
      id: unknown,
      credentialsChanged: unknown,
    ): void => {
      if (active && id === watchId) onChanged(credentialsChanged === true);
    };
    ipcRenderer.on(IPC_CHANNELS.modelLibraryChanged, handler);
    void ipcRenderer
      .invoke(IPC_CHANNELS.modelLibraryWatch, watchId, scope)
      .catch((): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.modelLibraryChanged, handler);
      });
    return (): void => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener(IPC_CHANNELS.modelLibraryChanged, handler);
      void ipcRenderer
        .invoke(IPC_CHANNELS.modelLibraryUnwatch, watchId)
        .catch(() => undefined);
    };
  },
  loadCloudReleaseNotes: (version) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsLoadCloudReleaseNotes, version),
  loadCloudDigestPreferences: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsLoadCloudDigestPreferences),
  saveCloudDigestPreferences: (preferences) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.settingsSaveCloudDigestPreferences,
      preferences,
    ),
  loadInstallUpdateEmailPreference: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsLoadInstallUpdateEmailPreference),
  saveInstallUpdateEmailPreference: (preference) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.settingsSaveInstallUpdateEmailPreference,
      preference,
    ),
  loadCanopyCloudMobileActivation: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.canopyCloudMobileActivationLoad, options),
  loadNativeAiCreditsAvailability: (scope) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.settingsLoadNativeAiCreditsAvailability,
      scope,
    ),
  refreshCanopyCloudEnforcedSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsRefreshCanopyCloudEnforcedSettings),
  onCanopyCloudSessionStatus: (callback) => {
    const handler = (): void => callback();
    ipcRenderer.on(
      IPC_CHANNELS.settingsCanopyCloudSessionStatusChanged,
      handler,
    );
    return (): void => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.settingsCanopyCloudSessionStatusChanged,
        handler,
      );
    };
  },
  loadCanopyCloudApiKey: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsLoadCanopyCloudApiKey),
  recheckSecureStorage: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.secureStorageRecheck, request),
  saveCanopyCloudApiKey: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsSaveCanopyCloudApiKey, request),
  clearCanopyCloudApiKey: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsClearCanopyCloudApiKey),
  startCanopyCloudOAuthLogin: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsStartCanopyCloudOAuthLogin),
  cancelCanopyCloudOAuthLogin: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsCancelCanopyCloudOAuthLogin),
  disconnectCanopyCloudAccount: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsDisconnectCanopyCloudAccount),
  resetUnreadableCanopyCloudAccount: () =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsResetUnreadableCanopyCloudAccount),
  startCanopyGuestSession: (consent) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsStartCanopyGuestSession, consent),
  validateCanopyCloudApiKey: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsValidateCanopyCloudApiKey, request),
  searchLinearIssues: (query) =>
    ipcRenderer.invoke(IPC_CHANNELS.settingsSearchLinearIssues, query),
  resolvePullRequest: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.githubResolvePullRequest, request),
  listPullRequests: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.githubListPullRequests, request),
  searchPullRequests: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.githubSearchPullRequests, request),
  getRepoSlug: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.githubGetRepoSlug, request),
  prepareFeedbackDiagnostics: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.feedbackDiagnosticsPrepare, request),
  readFeedbackDiagnosticsEntry: (snapshotId, entryPath) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.feedbackDiagnosticsRead,
      snapshotId,
      entryPath,
    ),
  saveFeedbackDiagnostics: (snapshotId) =>
    ipcRenderer.invoke(IPC_CHANNELS.feedbackDiagnosticsSave, snapshotId),
  releaseFeedbackDiagnostics: (snapshotId) =>
    ipcRenderer.invoke(IPC_CHANNELS.feedbackDiagnosticsRelease, snapshotId),
  submitFeedbackReport: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.feedbackReportSubmit, request),
  feedbackDiagnosticsCapabilities: () =>
    ipcRenderer.invoke(IPC_CHANNELS.feedbackDiagnosticsCapabilities),
  prepareFeedback: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.feedbackPrepare, request),
  submitFeedback: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.feedbackSubmit, request),
  listLocalMemoryFiles: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryList, request),
  readLocalMemoryFile: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryRead, request),
  updateLocalMemoryItem: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryUpdateItem, request),
  deleteLocalMemoryItem: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryDeleteItem, request),
  updateLocalMemoryFile: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryUpdateFile, request),
  deleteLocalMemoryFile: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryDeleteFile, request),
  onLocalMemoryChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      scope: LocalMemoryScopeRequest,
    ): void => callback(scope);
    ipcRenderer.on(IPC_CHANNELS.localMemoryChanged, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.localMemoryChanged, handler);
  },
  watchLocalMemory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryWatch, request),
  unwatchLocalMemory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryUnwatch, request),
  getLocalMemoryConsolidationStatus: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryConsolidationStatus, request),
  consolidateLocalMemory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryConsolidate, request),
  rebuildLocalMemory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryRebuild, request),
  listLocalMemorySnapshots: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryListSnapshots, request),
  restoreLocalMemorySnapshot: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.localMemoryRestoreSnapshot, request),
  getMemorySyncState: () => ipcRenderer.invoke(IPC_CHANNELS.memorySyncGetState),
  onMemorySyncChanged: (callback) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: MemorySyncState,
    ): void => callback(state);
    ipcRenderer.on(IPC_CHANNELS.memorySyncChanged, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.memorySyncChanged, handler);
  },
  updateMemorySyncSettings: (patch) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncUpdateSettings, patch),
  previewMemorySyncMerge: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncPreviewMerge, request),
  applyMemorySyncMerge: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncApplyMerge, request),
  readMemorySyncConflict: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncReadConflict, request),
  resolveMemorySyncConflict: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncResolveConflict, request),
  listMemorySyncHistory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncListHistory, request),
  restoreMemorySyncRevision: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncRestore, request),
  deleteMemorySyncFromCloud: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncDeleteFromCloud, request),
  setMemorySyncProjectMemory: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.memorySyncSetProjectMemory, request),
  submitOrgMemoryFeedback: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.orgMemoryFeedbackSubmit, request),
  getOrgMemoryFeedback: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.orgMemoryFeedbackGet, request),
  rateTurnFeedback: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.turnFeedbackRate, request),
  submitTurnFeedbackDetail: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.turnFeedbackDetail, request),
  clearTurnFeedback: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.turnFeedbackClear, request),
  listTurnFeedback: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.turnFeedbackList, request),
  cli: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.cliGetStatus),
    installToPath: () => ipcRenderer.invoke(IPC_CHANNELS.cliInstallToPath),
    uninstallFromPath: () =>
      ipcRenderer.invoke(IPC_CHANNELS.cliUninstallFromPath),
  },
  detectApps: () => ipcRenderer.invoke(IPC_CHANNELS.worktreeDetectApps),
  refreshDetectedApps: () =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeRefreshDetectedApps),
  openInApp: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeOpenIn, request),
  // A remote window's files are on this computer, not the one it shows:
  // they have no path there, so callers send their bytes instead.
  getPathForFile: (file) =>
    remoteWindowContext ? '' : webUtils.getPathForFile(file),
  getPathsForFiles: async (files) =>
    remoteWindowContext
      ? uploadFilesToRemote(ipcRenderer, files)
      : files
          .map((file) => webUtils.getPathForFile(file))
          .filter((path) => path.length > 0),
  getWorktreePath: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeGetPath, request),
  listWorktreeRepoEntries: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.worktreeListRepoEntries, request),
  showInFinder: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileShowInFinder, request),
  openExternalFile: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileOpenExternal, request),
  readFilePreview: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileReadPreview, request),
  readFileDocumentBytes: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileReadDocumentBytes, request),
  readFileContent: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileReadContent, request),
  saveFileContent: (request) =>
    ipcRenderer.invoke(IPC_CHANNELS.fileSaveContent, request),
  activity: {
    getChangedFiles: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityChangedFiles, request),
    revertFile: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityRevertFile, request),
    loadWorktreeSummary: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.worktreeSummaryLoad, request),
    loadWorktreeSummaries: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.worktreeSummaryLoadBatch, request),
    refreshWorktreeSummary: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.worktreeSummaryRefresh, request),
    getFileDiff: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityFileDiff, request),
    getTurnFileDiff: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityTurnFileDiff, request),
    plans: {
      list: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansList, request),
      get: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansGet, request),
      create: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansCreate, request),
      update: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansUpdate, request),
      delete: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansDelete, request),
      saveComments: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansSaveComments, request),
      generateDiagrams: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansGenerateDiagrams, request),
      share: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansShare, request),
      unshare: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansUnshare, request),
      import: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansImport, request),
      refreshComments: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansRefreshComments, request),
      setFileVisibility: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.trackedPlansFileVisibility, request),
    },
    stopBgProcess: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityStopBgProcess, request),
    startOutputPolling: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityStartOutputPolling, request),
    stopOutputPolling: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityStopOutputPolling, request),
    readFullOutput: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityReadFullOutput, request),
    listLiveBgTasks: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityListLiveBgTasks, request),
    onLiveBgTasksChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: ActivityLiveBgTasksChangedEvent,
      ): void => callback(event);
      ipcRenderer.on(IPC_CHANNELS.activityLiveBgTasksChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.activityLiveBgTasksChanged,
          handler,
        );
      };
    },
    readWorkflowRun: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.activityReadWorkflowRun, request),
    readWorkflowAgentTranscript: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.activityReadWorkflowAgentTranscript,
        request,
      ),
    onBgProcessOutput: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as ActivityBgProcessOutputEvent);
      ipcRenderer.on(IPC_CHANNELS.activityBgProcessOutput, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.activityBgProcessOutput,
          handler,
        );
      };
    },
    onWorktreeSummaryUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as WorktreeSummaryUpdatedEvent);
      ipcRenderer.on(IPC_CHANNELS.worktreeSummaryUpdated, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.worktreeSummaryUpdated,
          handler,
        );
      };
    },
    onWorktreeSummaryGenerating: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as WorktreeSummaryGeneratingEvent);
      ipcRenderer.on(IPC_CHANNELS.worktreeSummaryGenerating, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.worktreeSummaryGenerating,
          handler,
        );
      };
    },
    onTrackedPlansUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as TrackedPlansUpdatedEvent);
      ipcRenderer.on(IPC_CHANNELS.trackedPlansUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.trackedPlansUpdated, handler);
      };
    },
    detectedPlans: {
      scan: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.detectedPlansScan, request),
      list: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.detectedPlansList, request),
      update: (request) =>
        ipcRenderer.invoke(IPC_CHANNELS.detectedPlansUpdate, request),
    },
    onDetectedPlansUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as DetectedPlansUpdatedEvent);
      ipcRenderer.on(IPC_CHANNELS.detectedPlansUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.detectedPlansUpdated, handler);
      };
    },
  },
  codeReview: {
    get: (request) => ipcRenderer.invoke(IPC_CHANNELS.codeReviewGet, request),
    arm: (request) => ipcRenderer.invoke(IPC_CHANNELS.codeReviewArm, request),
    generate: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.codeReviewGenerate, request),
    saveComments: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.codeReviewSaveComments, request),
    registerTarget: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.codeReviewRegister, request),
    setModalOpen: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.codeReviewModalOpen, request),
    onUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isCodeReviewUpdatedEvent(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.codeReviewUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.codeReviewUpdated, handler);
      };
    },
  },
  fileAnnotations: {
    get: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.fileAnnotationsGet, request),
    save: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.fileAnnotationsSave, request),
    append: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.fileAnnotationsAppend, request),
    dismiss: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.fileAnnotationsDismiss, request),
    onUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isFileAnnotationsUpdatedEvent(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.fileAnnotationsUpdated, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.fileAnnotationsUpdated,
          handler,
        );
      };
    },
  },
  chat: {
    ...createChatStateApi(ipcRenderer),
    sendMessage: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatSendMessage, req),
    editQueuedMessage: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatQueueEdit, req),
    cancelQueuedMessage: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatQueueCancel, req),
    forceQueuedMessage: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatQueueForce, req),
    setQueuedMessageEditLock: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatQueueSetEditLock, req),
    getChatQueueSnapshot: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatQueueGetSnapshot, req),
    onChatQueueUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: ChatQueueUpdatedEvent,
      ): void => callback(data);
      ipcRenderer.on(IPC_CHANNELS.chatQueueUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chatQueueUpdated, handler);
      };
    },
    cancel: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatCancel, req),
    getContextUsage: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatGetContextUsage, req),
    resumeStoppedTurn: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatResumeStoppedTurn, req),
    destroySession: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatDestroySession, req),
    cancelTransientRetry: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatTransientRetryCancel, req),
    getTransientRetrySnapshot: () =>
      ipcRenderer.invoke(IPC_CHANNELS.chatTransientRetryGetSnapshot),
    resetToPoint: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatResetToPoint, req),
    exportSession: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSessionExport, req),
    listSessionExports: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSessionCloudExportList, req),
    deleteSessionExport: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSessionCloudExportDelete, req),
    inspectSessionImport: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSessionImportInspect, req),
    importSession: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSessionImport, req),
    discardSessionImport: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSessionImportDiscard, req),
    onChatSessionImported: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isChatSessionImportedEvent(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.chatSessionImported, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chatSessionImported, handler);
      };
    },
    onChatEvent: subscribeToChatEvents,
    onScheduledTerminalPrompt: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as ClaudeTerminalScheduledPromptEvent);
      ipcRenderer.on(IPC_CHANNELS.claudeTerminalScheduledPrompt, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.claudeTerminalScheduledPrompt,
          handler,
        );
      };
    },
    onWindowCommand: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as ChatWindowCommand);
      ipcRenderer.on(IPC_CHANNELS.chatWindowCommand, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chatWindowCommand, handler);
      };
    },
    onPortalComposerCommand: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: PortalChatComposerRendererRequest,
      ): void => callback(data);
      ipcRenderer.on(IPC_CHANNELS.chatPortalComposerCommand, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.chatPortalComposerCommand,
          handler,
        );
      };
    },
    completePortalComposerCommand: (result) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatPortalComposerCommandResult, result),
    onHookQueueRemoved: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (
          !isRecord(data) ||
          typeof data.projectId !== 'string' ||
          typeof data.worktreeId !== 'string' ||
          typeof data.chatId !== 'string' ||
          typeof data.queueId !== 'string'
        )
          return;
        callback({
          projectId: data.projectId,
          worktreeId: data.worktreeId,
          chatId: data.chatId,
          queueId: data.queueId,
        });
      };
      ipcRenderer.on(IPC_CHANNELS.chatHookQueueRemoved, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chatHookQueueRemoved, handler);
      };
    },
    onHookTabStarted: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as HookChatTabStartedEvent);
      ipcRenderer.on(IPC_CHANNELS.chatHookTabStarted, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chatHookTabStarted, handler);
      };
    },
    loadTabs: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatLoadTabs, req),
    flushScope: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatFlushScope, req),
    forkOpenWorktreeTabs: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatForkOpenWorktreeTabs, req),
    adhocMigrateTabs: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatAdhocMigrateTabs, req),
    archiveTab: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatArchiveTab, req),
    loadArchives: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatLoadArchives, req),
    readArchive: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatReadArchive, req),
    restoreArchive: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatRestoreArchive, req),
    markArchiveRead: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatMarkArchiveRead, req),
    markAllArchivesRead: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatMarkAllArchivesRead, req),
    preparePlanFileSystemInstruction: (req) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.chatPreparePlanFileSystemInstruction,
        req,
      ),
    activeSessions: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatActiveSessions, req),
    generateHandoffSummary: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatGenerateHandoffSummary, req),
    forkCodexThread: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatForkCodexThread, req),
    onMcpAskUser: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as McpAskUserEvent);
      ipcRenderer.on(IPC_CHANNELS.mcpAskUser, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.mcpAskUser, handler);
      };
    },
    onMcpExpireAskUser: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isMcpExpireAskUserEvent(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.mcpExpireAskUser, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.mcpExpireAskUser, handler);
      };
    },
    answerMcpQuestion: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.mcpAnswerUser, req),
    dismissMcpQuestion: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.mcpDismissUser, req),
    onPlanExitRequest: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as PlanExitRequestEvent);
      ipcRenderer.on(IPC_CHANNELS.planExitRequest, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.planExitRequest, handler);
      };
    },
    approvePlanExit: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.planExitApprove, req),
    denyPlanExit: (req) => ipcRenderer.invoke(IPC_CHANNELS.planExitDeny, req),
    togglePlanMode: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.planModeToggle, req),
    toggleCodexFastMode: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCodexFastModeToggle, req),
    toggleThinkingLevel: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.thinkingLevelToggle, req),
    changeModel: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatModelChange, req),
    updatePlugins: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatUpdatePlugins, req),
    onTabDescriptionUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as ChatTabDescriptionUpdatedEvent);
      ipcRenderer.on(IPC_CHANNELS.chatTabDescriptionUpdated, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.chatTabDescriptionUpdated,
          handler,
        );
      };
    },
    cancelQueuedHookChat: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCancelQueuedHookChat, req),
    forceQueuedHookChat: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatForceQueuedHookChat, req),
    setQueuedHookChatInterfaceMode: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSetQueuedHookChatInterfaceMode, req),
    beginDeferredToolsReload: (req) => {
      if (!isDeferredToolsReloadBeginRequest(req)) {
        return Promise.resolve(
          invalidDeferredToolsReloadAck(deferredToolsReloadRequestId(req)),
        );
      }
      return ipcRenderer.invoke(IPC_CHANNELS.chatDeferredToolsReloadBegin, req);
    },
    finishDeferredToolsReload: (req) => {
      if (!isDeferredToolsReloadFinishRequest(req)) {
        return Promise.resolve(
          invalidDeferredToolsReloadAck(deferredToolsReloadRequestId(req)),
        );
      }
      return ipcRenderer.invoke(
        IPC_CHANNELS.chatDeferredToolsReloadFinish,
        req,
      );
    },
    cancelDeferredToolsReload: (req) => {
      if (!isDeferredToolsReloadCancelRequest(req)) {
        return Promise.resolve(
          invalidDeferredToolsReloadAck(deferredToolsReloadRequestId(req)),
        );
      }
      return ipcRenderer.invoke(
        IPC_CHANNELS.chatDeferredToolsReloadCancel,
        req,
      );
    },
    onDeferredToolsReloadEvent: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isDeferredToolsReloadEvent(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.chatDeferredToolsReloadEvent, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.chatDeferredToolsReloadEvent,
          handler,
        );
      };
    },
  },
  copilotConnection: {
    usage: () => ipcRenderer.invoke(IPC_CHANNELS.copilotConnectionUsage),
    listModels: () => ipcRenderer.invoke(IPC_CHANNELS.copilotConnectionModels),
    status: () => ipcRenderer.invoke(IPC_CHANNELS.copilotConnectionStatus),
    connect: () => ipcRenderer.invoke(IPC_CHANNELS.copilotConnectionConnect),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.copilotConnectionCancel),
    disconnect: () =>
      ipcRenderer.invoke(IPC_CHANNELS.copilotConnectionDisconnect),
    account: () => ipcRenderer.invoke(IPC_CHANNELS.copilotConnectionAccount),
    changeAccount: () =>
      ipcRenderer.invoke(IPC_CHANNELS.copilotConnectionChangeAccount),
    onProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: CopilotConnectionStatus,
      ): void => callback(status);
      ipcRenderer.on(IPC_CHANNELS.copilotConnectionProgress, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.copilotConnectionProgress,
          handler,
        );
      };
    },
  },
  accountProxy: {
    status: (options) =>
      ipcRenderer.invoke(IPC_CHANNELS.accountProxyStatus, options),
    connect: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.accountProxyConnect, request),
    disconnect: () => ipcRenderer.invoke(IPC_CHANNELS.accountProxyDisconnect),
    setUpLocal: () => ipcRenderer.invoke(IPC_CHANNELS.accountProxySetUpLocal),
    controlLocal: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.accountProxyControlLocal, request),
    signIn: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.accountProxySignIn, request),
    setAccountDisabled: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.accountProxySetAccountDisabled, request),
    removeAccount: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.accountProxyRemoveAccount, request),
    setRoutingStrategy: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.accountProxySetRoutingStrategy, request),
    sessionAccounts: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.accountProxySessionAccounts, request),
    onChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: AccountProxyStatus,
      ): void => callback(status);
      ipcRenderer.on(IPC_CHANNELS.accountProxyChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.accountProxyChanged, handler);
      };
    },
  },
  opencodeConnection: {
    listModels: () => ipcRenderer.invoke(IPC_CHANNELS.opencodeConnectionModels),
    status: () => ipcRenderer.invoke(IPC_CHANNELS.opencodeConnectionStatus),
    connect: (operationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.opencodeConnectionConnect, operationId),
    cancel: (operationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.opencodeConnectionCancel, operationId),
    disconnect: () =>
      ipcRenderer.invoke(IPC_CHANNELS.opencodeConnectionDisconnect),
    onProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: OpenCodeConnectionStatus,
      ): void => callback(status);
      ipcRenderer.on(IPC_CHANNELS.opencodeConnectionProgress, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.opencodeConnectionProgress,
          handler,
        );
      };
    },
  },
  cursorConnection: {
    listModels: () => ipcRenderer.invoke(IPC_CHANNELS.cursorConnectionModels),
    status: () => ipcRenderer.invoke(IPC_CHANNELS.cursorConnectionStatus),
    connect: () => ipcRenderer.invoke(IPC_CHANNELS.cursorConnectionConnect),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.cursorConnectionCancel),
    disconnect: () =>
      ipcRenderer.invoke(IPC_CHANNELS.cursorConnectionDisconnect),
    account: () => ipcRenderer.invoke(IPC_CHANNELS.cursorConnectionAccount),
    changeAccount: (intent) =>
      ipcRenderer.invoke(IPC_CHANNELS.cursorConnectionChangeAccount, intent),
    onProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: CursorConnectionStatus,
      ): void => callback(status);
      ipcRenderer.on(IPC_CHANNELS.cursorConnectionProgress, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.cursorConnectionProgress,
          handler,
        );
      };
    },
  },
  cursorApprovalCheck: {
    available: () =>
      ipcRenderer.invoke(IPC_CHANNELS.cursorApprovalCheckAvailable),
    run: (binaryPath: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.cursorApprovalCheckRun, binaryPath),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.cursorApprovalCheckCancel),
  },
  approvals: {
    respondSecretInput: (req: ApprovalSecretInputRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalSecretInput, req),
    respond: (req: ApprovalRespondRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalRespond, req),
    dismiss: (req: ApprovalDismissRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalDismiss, req),
    pendingRequests: (): Promise<ApprovalRequestEvent[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalPendingRequests),
    setMode: (req: ApprovalModeSetRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalModeSet, req),
    getResolvedDefault: (
      req: ApprovalResolvedDefaultRequest,
    ): Promise<ApprovalMode> =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalResolvedDefault, req),
    listRules: (
      req: ApprovalRulesListRequest,
    ): Promise<ApprovalRulesListResponse> =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalRulesList, req),
    addRule: (req: ApprovalRuleAddRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalRuleAdd, req),
    removeRule: (req: ApprovalRuleRemoveRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.approvalRuleRemove, req),
    onRequest: (callback: (event: ApprovalRequestEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isApprovalRequestEvent(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.approvalRequest, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.approvalRequest, handler);
      };
    },
    onCancelled: (callback: (event: ApprovalCancelledEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isApprovalCancelledEvent(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.approvalCancelled, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.approvalCancelled, handler);
      };
    },
    onAutoResolved: (callback: (event: ApprovalAutoResolvedEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isApprovalAutoResolvedEvent(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.approvalAutoResolved, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.approvalAutoResolved, handler);
      };
    },
    onRuleAdded: (callback: (event: ApprovalRuleAddedEvent) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isApprovalRuleAddedEvent(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.approvalRuleAdded, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.approvalRuleAdded, handler);
      };
    },
  },
  chatProject: {
    rollbackUnstartedSend: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectRollbackUnstartedSend, req),
    checkFolder: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectCheckFolder, req),
    revealFolderLocation: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectRevealFolderLocation, req),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.chatProjectList),
    ensureOrgDefaultCoworkWorkspace: (organizationId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.chatProjectEnsureOrgDefaultCowork,
        organizationId,
      ),
    getOrgDefaultCoworkEligibility: (organizationId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.chatProjectGetOrgDefaultCoworkEligibility,
        organizationId,
      ),
    listBlueprints: () =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectBlueprintsList),
    refreshBlueprints: () =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectBlueprintsRefresh),
    listSharedTemplates: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectSharedTemplatesList, request),
    createOrgCowork: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectCreateOrgCowork, req),
    create: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatProjectCreate, req),
    createFromTemplate: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectCreateFromTemplate, req),
    buildTemplate: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectTemplateBuild, req),
    getTemplateShare: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectTemplateShareGet, req),
    publishTemplateShare: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectTemplateSharePublish, req),
    analyzeTemplateCapabilityPackage: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectTemplatePackageAnalyze, req),
    cancelTemplateCapabilityPackageAnalysis: (analysisId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.chatProjectTemplatePackageCancelAnalysis,
        analysisId,
      ),
    commitTemplateCapabilityPackage: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectTemplatePackageCommit, req),
    inspectTemplateCapabilityPackages: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectTemplatePackageReadiness, req),
    revokeTemplateShare: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectTemplateShareRevoke, req),
    update: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatProjectUpdate, req),
    delete: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatProjectDelete, req),
    loadClaudeMd: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectLoadClaudeMd, req),
    saveClaudeMd: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatProjectSaveClaudeMd, req),
  },
  chatSearch: {
    catalog: (scope) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatSearchCatalog, scope),
    query: (req) => ipcRenderer.invoke(IPC_CHANNELS.chatSearchQuery, req),
    onUpdated: (callback) => {
      const handler = (): void => callback();
      ipcRenderer.on(IPC_CHANNELS.chatSearchUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chatSearchUpdated, handler);
      };
    },
  },
  standaloneChat: {
    init: (projectId) =>
      ipcRenderer.invoke(IPC_CHANNELS.standaloneChatInit, projectId),
    list: (projectId) =>
      ipcRenderer.invoke(IPC_CHANNELS.standaloneChatList, projectId),
    readSummary: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.standaloneChatReadSummary, req),
    readArchive: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.standaloneChatReadArchive, req),
    resumeArchive: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.standaloneChatResumeArchive, req),
    loadWorkspace: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.standaloneChatLoadWorkspace, req),
    exportProject: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.standaloneChatExportProject, req),
    importProject: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.standaloneChatImportProject, req),
    onMetaUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as StandaloneChatMetaUpdatedEvent);
      ipcRenderer.on(IPC_CHANNELS.standaloneChatMetaUpdated, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.standaloneChatMetaUpdated,
          handler,
        );
      };
    },
  },
  github: {
    createPr: (req) => ipcRenderer.invoke(IPC_CHANNELS.githubCreatePr, req),
    requestPrStatusRefresh: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubRequestRefresh, req),
    requestFastRefresh: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubRequestFastRefresh, req),
    requestKnownPrFastRefresh: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubRequestKnownPrFastRefresh, req),
    setForegroundWorktree: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSetForegroundWorktree, req),
    onPrStatusUpdate: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as PrStatusEvent);
      ipcRenderer.on(IPC_CHANNELS.githubPrStatusEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.githubPrStatusEvent, handler);
      };
    },
    onDependentBaseBranchesUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as DependentBaseBranchesUpdatedEvent);
      ipcRenderer.on(IPC_CHANNELS.githubDependentBaseBranchesUpdated, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.githubDependentBaseBranchesUpdated,
          handler,
        );
      };
    },
    onGitHubRateLimitError: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isGitHubRateLimitEvent(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.githubRateLimitEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.githubRateLimitEvent, handler);
      };
    },
    onPrCreationProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as PrCreationProgressEvent);
      ipcRenderer.on(IPC_CHANNELS.githubPrCreationProgress, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.githubPrCreationProgress,
          handler,
        );
      };
    },
    generateCommitMessages: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubGenerateCommitMessages, req),
    cancelGitAction: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubCancelGitAction, req),
    commitAndPush: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubCommitAndPush, req),
    pushOnly: (req) => ipcRenderer.invoke(IPC_CHANNELS.githubPushOnly, req),
    pull: (req) => ipcRenderer.invoke(IPC_CHANNELS.githubPull, req),
    mergeLocalBranches: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubMergeLocalBranches, req),
    mergePr: (req) => ipcRenderer.invoke(IPC_CHANNELS.githubMergePr, req),
    onMergePrProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as MergePrProgressEvent);
      ipcRenderer.on(IPC_CHANNELS.githubMergePrProgress, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.githubMergePrProgress, handler);
      };
    },
    startMergeConflictResolution: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubStartMergeConflictResolution, req),
    startPrCommentTriage: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubStartPrCommentTriage, req),
    startCiCheckFix: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubStartCiCheckFix, req),
    updatePrBaseBranch: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubUpdatePrBaseBranch, req),
    onCommitPushProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as CommitPushProgressEvent);
      ipcRenderer.on(IPC_CHANNELS.githubCommitPushProgress, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.githubCommitPushProgress,
          handler,
        );
      };
    },
    planSplitPr: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSplitPrPlan, req),
    cancelSplitPr: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSplitPrCancel, req),
    discardSplitPr: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSplitPrDiscard, req),
    onSplitPrProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as SplitPrProgressEvent);
      ipcRenderer.on(IPC_CHANNELS.githubSplitPrProgress, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.githubSplitPrProgress, handler);
      };
    },
    getSplitPrMap: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSplitPrGetMap, req),
    startSplitWorkflow: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSplitWorkflowStart, req),
    approveSplitWorkflow: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSplitWorkflowApprove, req),
    exitSplitWorkflow: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSplitWorkflowExit, req),
    onSplitLockChange: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as SplitLockChangeEventPayload);
      ipcRenderer.on(IPC_CHANNELS.githubSplitLockEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.githubSplitLockEvent, handler);
      };
    },
    getSplitLockState: () =>
      ipcRenderer.invoke(IPC_CHANNELS.githubSplitLockState),
    getMergeQueue: (req) =>
      ipcRenderer.invoke(IPC_CHANNELS.githubGetMergeQueue, req),
  },
  update: {
    checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.updateCheck),
    ...(__CANOPY_RELEASE_FLAVOR__ === 'internal' ||
    __CANOPY_RELEASE_FLAVOR__ === 'rc'
      ? {
          checkForVersion: (request) =>
            ipcRenderer.invoke(IPC_CHANNELS.updateCheckVersion, request),
          listVersions: (request) =>
            ipcRenderer.invoke(IPC_CHANNELS.updateListVersions, request),
        }
      : {}),
    downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.updateDownload),
    installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.updateInstall),
    scheduleUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.updateSchedule),
    cancelScheduledUpdate: () =>
      ipcRenderer.invoke(IPC_CHANNELS.updateCancelScheduled),
    reportBusyState: (busy: boolean) =>
      ipcRenderer.invoke(IPC_CHANNELS.updateReportBusy, busy),
    getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetVersion),
    getDependencyVersions: () =>
      ipcRenderer.invoke(IPC_CHANNELS.updateGetDependencyVersions),
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.updateGetState),
    onUpdateEvent: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => callback(data as UpdateEvent);
      ipcRenderer.on(IPC_CHANNELS.updateEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.updateEvent, handler);
      };
    },
  },
  telemetrySync: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.telemetrySyncGetStatus),
    // `send`, not `invoke`: presence is a fire-and-forget heartbeat with no
    // reply to wait on, and a throttled one-way message keeps it off the
    // renderer's promise path entirely.
    recordActivity: (projectId, worktreeId) => {
      ipcRenderer.send(
        IPC_CHANNELS.telemetrySyncRecordActivity,
        projectId,
        worktreeId,
      );
    },
    onStatusEvent: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // Guard the cross-process payload before handing it to the renderer,
        // mirroring the other validated event channels above.
        if (isTelemetrySyncStatus(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.telemetrySyncStatusEvent, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.telemetrySyncStatusEvent,
          handler,
        );
      };
    },
  },
  observability: {
    loadSnapshot: () =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityLoadSnapshot),
    loadHistory: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityLoadHistory, request),
    loadTranscript: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityLoadTranscript, request),
    loadUsageTimeseries: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.observabilityLoadUsageTimeseries,
        request,
      ),
    loadUsageMetrics: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityLoadUsageMetrics, request),
    loadUsageMetricsView: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.observabilityLoadUsageMetricsView,
        request,
      ),
    loadUsageTabSummary: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.observabilityLoadUsageTabSummary,
        request,
      ),
    refreshUsage: (provider) =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityRefreshUsage, provider),
    recordDesktopInstrumentationInitFailure: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.observabilityRecordDesktopInstrumentationInitFailure,
        request,
      ),
    recordRendererSummary: (summary) =>
      ipcRenderer.send(
        IPC_CHANNELS.observabilityRecordRendererSummary,
        summary,
      ),
    getPostHogAnonymousId: () =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityGetPostHogAnonymousId),
    getPostHogEmailDomain: () =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityGetPostHogEmailDomain),
    onPostHogEmailDomainUpdate: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        domain: string | null,
      ): void => callback(domain);
      ipcRenderer.on(
        IPC_CHANNELS.observabilityPostHogEmailDomainUpdate,
        handler,
      );
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.observabilityPostHogEmailDomainUpdate,
          handler,
        );
      };
    },
    getPostHogSession: () =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityGetPostHogSession),
    reportPostHogSessionRotation: (proposal) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.observabilityReportPostHogSessionRotation,
        proposal,
      ),
    onPostHogSessionUpdate: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: PostHogSessionState,
      ): void => callback(state);
      ipcRenderer.on(IPC_CHANNELS.observabilityPostHogSessionUpdate, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.observabilityPostHogSessionUpdate,
          handler,
        );
      };
    },
    getUsageDataPolicy: () =>
      ipcRenderer.invoke(IPC_CHANNELS.observabilityGetUsageDataPolicy),
    onUsageDataPolicyChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        snapshot: UsageDataPolicySnapshot,
      ): void => callback(snapshot);
      ipcRenderer.on(IPC_CHANNELS.observabilityUsageDataPolicyChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.observabilityUsageDataPolicyChanged,
          handler,
        );
      };
    },
    onUpdate: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: AgentObservabilityUpdateEvent,
      ): void => callback(data);
      ipcRenderer.on(IPC_CHANNELS.observabilityEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.observabilityEvent, handler);
      };
    },
  },
  globalFocusShortcut: {
    getStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.globalFocusShortcutGetStatus),
    update: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.globalFocusShortcutUpdate, request),
    onStatusChanged: (callback) => {
      // The main-process lifecycle service is the single producer on this
      // channel; the listener parameter is typed directly so the shared
      // contract applies without a cast.
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: GlobalFocusShortcutStatus,
      ): void => {
        callback(status);
      };
      ipcRenderer.on(IPC_CHANNELS.globalFocusShortcutStatusChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.globalFocusShortcutStatusChanged,
          handler,
        );
      };
    },
  },
  appWindow: {
    setUnsavedChanges: (dirty) =>
      ipcRenderer.invoke(IPC_CHANNELS.appWindowSetUnsavedChanges, dirty),
    onConfirmClose: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        request: AppWindowConfirmCloseRequest,
      ): void => {
        const respond = (response: AppWindowConfirmCloseResponse): void => {
          void ipcRenderer.invoke(
            IPC_CHANNELS.appWindowConfirmCloseResponse,
            response,
          );
        };
        callback(request, {
          acknowledgeShown: () => {
            respond({ requestId: request.requestId, kind: 'shown' });
          },
          resolve: (proceed) => {
            respond({ requestId: request.requestId, kind: 'decided', proceed });
          },
        });
      };
      ipcRenderer.on(IPC_CHANNELS.appWindowConfirmClose, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.appWindowConfirmClose, handler);
      };
    },
  },
  launchAtLogin: {
    getStatus: () => ipcRenderer.invoke(IPC_CHANNELS.launchAtLoginGetStatus),
    setEnabled: (enabled) =>
      ipcRenderer.invoke(IPC_CHANNELS.launchAtLoginSetEnabled, enabled),
    openSystemSettings: () =>
      ipcRenderer.invoke(IPC_CHANNELS.launchAtLoginOpenSystemSettings),
    onStatusChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: LaunchAtLoginStatus,
      ): void => {
        callback(status);
      };
      ipcRenderer.on(IPC_CHANNELS.launchAtLoginStatusChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.launchAtLoginStatusChanged,
          handler,
        );
      };
    },
  },
  backgroundService: createBackgroundServiceApi(ipcRenderer),
  w5Recovery: createW5RecoveryApi(ipcRenderer),
  voice: {
    isSupported: () => ipcRenderer.invoke(IPC_CHANNELS.voiceIsSupported),
    recheckSupported: () => ipcRenderer.invoke(IPC_CHANNELS.voiceResetSupport),
    getMicrophoneAccess: () =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceGetMicrophoneAccess),
    requestSystemAccess: () =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceRequestSystemAccess),
    start: (request) => ipcRenderer.invoke(IPC_CHANNELS.voiceStart, request),
    pushAudio: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.voicePushAudio, request),
    stop: (request) => ipcRenderer.invoke(IPC_CHANNELS.voiceStop, request),
    cancel: (request) => ipcRenderer.invoke(IPC_CHANNELS.voiceCancel, request),
    onEvent: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: VoiceEventPayload,
      ): void => callback(data);
      ipcRenderer.on(IPC_CHANNELS.voiceEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.voiceEvent, handler);
      };
    },
    openSettings: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.voiceOpenSettings, request),
  },
  terminal: {
    listProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.terminalListProfiles),
    getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.terminalGetSettings),
    updateSettings: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalUpdateSettings, request),
    spawn: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalSpawn, request),
    restore: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalRestore, request),
    attach: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalAttach, request),
    write: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalWrite, request),
    resize: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalResize, request),
    kill: (request) => ipcRenderer.invoke(IPC_CHANNELS.terminalKill, request),
    loadWorktreeState: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalLoadWorktreeState, request),
    saveWorktreeState: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.terminalSaveWorktreeState, request),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.terminalList),
    onSpawned: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isTerminalSpawnedEvent(data)) {
          listener(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.terminalSpawned, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.terminalSpawned, handler);
      };
    },
    onOutput: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isTerminalOutputEvent(data)) {
          listener(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.terminalOutput, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.terminalOutput, handler);
      };
    },
    onExit: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isTerminalExitEvent(data)) {
          listener(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.terminalExit, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.terminalExit, handler);
      };
    },
    onRunningChanged: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isTerminalRunningChangedEvent(data)) {
          listener(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.terminalRunningChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.terminalRunningChanged,
          handler,
        );
      };
    },
  },
  runs: {
    share: (request) => ipcRenderer.invoke(IPC_CHANNELS.runsShare, request),
    checkShareEligibility: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.runsShareEligibility, request),
    unshare: (request) => ipcRenderer.invoke(IPC_CHANNELS.runsUnshare, request),
    listComments: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.runsCommentsList, request),
    createCommentThread: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.runsCommentsCreate, request),
    replyToCommentThread: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.runsCommentsReply, request),
    setCommentThreadStatus: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.runsCommentsSetStatus, request),
    markCommentsSeen: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.runsCommentsMarkSeen, request),
    onCommentsUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // Validate before dispatch, consistent with every other IPC event
        // subscription in this file.
        if (!isRunCommentsUpdatedEvent(data)) {
          return;
        }
        callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.runsCommentsUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.runsCommentsUpdated, handler);
      };
    },
  },
  sharedContainers: {
    checkEligibility: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersEligibility, request),
    prepareGithub: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersPrepareGithub, request),
    preview: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersPreview, request),
    saveFileScope: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersSaveFileScope, request),
    invite: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersInvite, request),
    getLink: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersGetLink, request),
    setLink: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersSetLink, request),
    resetLink: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersResetLink, request),
    resolveLink: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersResolveLink, request),
    claimLink: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersClaimLink, request),
    searchMembers: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersSearchMembers, request),
    listRecipients: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListRecipients, request),
    revokeRecipient: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersRevokeRecipient, request),
    listSharedByMe: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListByMe, request),
    listOwnedTargets: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.sharedContainersListOwnedTargets,
        request,
      ),
    listSharedWithMe: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListWithMe, request),
    listAccepted: () =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListAccepted),
    accept: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersAccept, request),
    open: (request) =>
      invokeSharedContainerReplicaState(
        IPC_CHANNELS.sharedContainersOpen,
        request,
      ),
    getReplicaState: (request) =>
      invokeOptionalSharedContainerReplicaState(
        IPC_CHANNELS.sharedContainersReplicaState,
        request,
      ),
    dismiss: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersDismiss, request),
    listDismissed: async (request) => {
      const response: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.sharedContainersListDismissed,
        request,
      );
      if (!isListDismissedSharedContainersResult(response)) {
        throw new Error('Main returned an invalid removed-share listing');
      }
      return response;
    },
    restore: async (request) => {
      const response: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.sharedContainersRestore,
        request,
      );
      if (!isRestoreSharedContainerResult(response)) {
        throw new Error('Main returned an invalid restore result');
      }
      return response;
    },
    retry: (request) =>
      invokeSharedContainerReplicaState(
        IPC_CHANNELS.sharedContainersRetry,
        request,
      ),
    close: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersClose, request),
    runStatus: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersRunStatus, request),
    allowRun: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersAllowRun, request),
    revokeRun: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersRevokeRun, request),
    saveRunEnvironment: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.sharedContainersSaveRunEnvironment,
        request,
      ),
    refreshRunCopy: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersRefreshRunCopy, request),
    fork: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersFork, request),
    readForkProvenance: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.sharedContainersReadForkProvenance,
        request,
      ),
    readRevisionMetadata: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.sharedContainersReadRevisionMetadata,
        request,
      ),
    listChats: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListChats, request),
    readChat: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersReadChat, request),
    listPlans: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListPlans, request),
    readPlan: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersReadPlan, request),
    listNotes: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListNotes, request),
    readNote: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersReadNote, request),
    listPrompts: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListPrompts, request),
    readPrompt: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersReadPrompt, request),
    listAttachments: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersListAttachments, request),
    readAttachment: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersReadAttachment, request),
    listRepositories: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.sharedContainersListRepositories,
        request,
      ),
    listRepositoryTree: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.sharedContainersListRepositoryTree,
        request,
      ),
    readOverlayDiff: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sharedContainersReadOverlayDiff, request),
    onReplicaChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // Validate before dispatch, consistent with every other IPC event
        // subscription in this file. The guard also rejects any undeclared
        // field, so transport internals cannot reach the renderer.
        if (!isSharedContainerReplicaBroadcast(data)) {
          return;
        }
        callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.sharedContainersReplicaChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.sharedContainersReplicaChanged,
          handler,
        );
      };
    },
    onSyncPhase: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (!isSharedContainerSyncPhaseEvent(data)) {
          return;
        }
        callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.sharedContainersSyncPhase, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.sharedContainersSyncPhase,
          handler,
        );
      };
    },
    onPublicationChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // Validate before dispatch, consistent with every other IPC event
        // subscription in this file.
        if (!isSharedContainerPublicationState(data)) {
          return;
        }
        callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.sharedContainersPublicationChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.sharedContainersPublicationChanged,
          handler,
        );
      };
    },
    onInboxChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // Validate before dispatch, consistent with every other IPC event
        // subscription in this file.
        if (!isSharedContainerInboxChangedEvent(data)) {
          return;
        }
        callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.sharedContainersInboxChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.sharedContainersInboxChanged,
          handler,
        );
      };
    },
  },
  panelLayout: createPanelLayoutApi(ipcRenderer),
  remoteControl: createRemoteControlApi(ipcRenderer, remoteWindowContext),
  codexSpeed: createCodexSpeedApi(ipcRenderer),
  overlayLayer: {
    setBounds: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.overlayLayerSetBounds, request),
    focus: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.overlayLayerFocus, request),
  },
  workspaceItems: {
    listNotes: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceNotesList, request),
    readNote: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceNotesRead, request),
    saveNote: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceNotesSave, request),
    deleteNote: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceNotesDelete, request),
    listPrompts: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspacePromptsList, request),
    readPrompt: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspacePromptsRead, request),
    readPromptByPath: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspacePromptsReadByPath, request),
    savePrompt: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspacePromptsSave, request),
    deletePrompt: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspacePromptsDelete, request),
    listAttachments: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceAttachmentsList, request),
    importAttachments: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceAttachmentsImport, request),
    deleteAttachment: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceAttachmentsDelete, request),
  },
  archivedContainers: {
    list: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersList, request),
    listChanges: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersListChanges, request),
    readChangeDiff: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.archivedContainersReadChangeDiff,
        request,
      ),
    refreshPullRequests: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.archivedContainersRefreshPullRequests,
        request,
      ),
    listChats: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersListChats, request),
    readChat: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersReadChat, request),
    listExecutions: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.archivedContainersListExecutions,
        request,
      ),
    listAttachments: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.archivedContainersListAttachments,
        request,
      ),
    listPlans: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersListPlans, request),
    readExecution: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersReadExecution, request),
    readExecutionReport: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.archivedContainersReadExecutionReport,
        request,
      ),
    readExecutionStepLog: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.archivedContainersReadExecutionStepLog,
        request,
      ),
    restore: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersRestore, request),
    delete: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersDelete, request),
    setLocked: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.archivedContainersSetLocked, request),
    onChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isArchivedContainersChangedEvent(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.archivedContainersChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.archivedContainersChanged,
          handler,
        );
      };
    },
  },
  sidebarItemGroups: {
    list: (scope) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarItemGroupsList, scope),
    create: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarItemGroupsCreate, request),
    update: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarItemGroupsUpdate, request),
    ungroup: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarItemGroupsUngroup, request),
    moveItem: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarItemGroupsMoveItem, request),
    moveGroup: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.sidebarItemGroupsMoveGroup, request),
    onChanged: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        scope: Parameters<typeof listener>[0],
      ): void => listener(scope);
      ipcRenderer.on(IPC_CHANNELS.sidebarItemGroupsChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.sidebarItemGroupsChanged,
          handler,
        );
      };
    },
  },
  workEntryAutoDelete: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.workEntryAutoDeleteList),
    disarm: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workEntryAutoDeleteDisarm, request),
    resolveBranch: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.workEntryAutoDeleteResolveBranch,
        request,
      ),
    onChanged: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        snapshot: Parameters<typeof listener>[0],
      ): void => listener(snapshot);
      ipcRenderer.on(IPC_CHANNELS.workEntryAutoDeleteChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.workEntryAutoDeleteChanged,
          handler,
        );
      };
    },
  },
  workEntries: {
    list: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workEntriesList, request),
    create: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workEntriesCreate, request),
    update: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workEntriesUpdate, request),
    reorder: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workEntriesReorder, request),
    delete: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workEntriesDelete, request),
    resolveChat: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.workEntriesResolveChat, request),
  },
  browser: {
    profiles: {
      inventoryStart: (request) =>
        invokeBrowserProfile('inventoryStart', request),
      inventoryGet: (request) => invokeBrowserProfile('inventoryGet', request),
      jobGet: (request) => invokeBrowserProfile('jobGet', request),
      jobList: (request = {}) => invokeBrowserProfile('jobList', request),
      jobCancel: (request) => invokeBrowserProfile('jobCancel', request),
      previewClear: (request) => invokeBrowserProfile('previewClear', request),
      clear: (request) => invokeBrowserProfile('clear', request),
      retryJob: (request) => invokeBrowserProfile('retryJob', request),
      cleanupStatus: () => invokeBrowserProfile('cleanupStatus', {}),
      retryCleanup: () => invokeBrowserProfile('retryCleanup', {}),
      list: (request = {}) => invokeBrowserProfile('list', request),
      get: (request) => invokeBrowserProfile('get', request),
      create: (request) => invokeBrowserProfile('create', request),
      update: (request) => invokeBrowserProfile('update', request),
      context: (request) => invokeBrowserProfile('context', request),
      setDefault: (request) => invokeBrowserProfile('setDefault', request),
      previewDelete: (request) =>
        invokeBrowserProfile('previewDelete', request),
      delete: (request) => invokeBrowserProfile('delete', request),
    },
    switchProfile: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserSwitchProfile, request),
    create: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserCreate, request),
    destroy: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserDestroy, request),
    disposeLiveView: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserDisposeLiveView, request),
    loadWorktreeState: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserLoadWorktreeState, request),
    saveWorktreeState: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserSaveWorktreeState, request),
    setActive: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserSetActive, request),
    setBounds: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserSetBounds, request),
    setVisible: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserSetVisible, request),
    navigate: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserNavigate, request),
    back: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserBack, request),
    forward: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserForward, request),
    reload: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserReload, request),
    stop: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserStop, request),
    findInPage: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserFindInPage, request),
    stopFindInPage: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserStopFindInPage, request),
    setTheme: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserSetTheme, request),
    setPickMode: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserSetPickMode, request),
    startRecording: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserStartRecording, request),
    stopRecording: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserStopRecording, request),
    clearRecording: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserClearRecording, request),
    getRecording: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserGetRecording, request),
    openExternal: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserOpenExternal, request),
    openLink: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserOpenLink, request),
    reportLinkBrowserTarget: (request) => {
      ipcRenderer.send(IPC_CHANNELS.browserReportLinkBrowserTarget, request);
    },
    resolveOpenLinkRequest: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserResolveOpenLinkRequest, request),
    getDefaultRegistrationStatus: () =>
      ipcRenderer.invoke(IPC_CHANNELS.browserGetDefaultRegistrationStatus),
    onDefaultRegistrationStatusChanged: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: DefaultBrowserRegistrationStatus,
      ): void => {
        listener(data);
      };
      ipcRenderer.on(
        IPC_CHANNELS.browserDefaultRegistrationStatusChanged,
        handler,
      );
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.browserDefaultRegistrationStatusChanged,
          handler,
        );
      };
    },
    getConsole: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserGetConsole, request),
    getNetwork: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserGetNetwork, request),
    screenshot: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserScreenshot, request),
    inputSnapshot: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserInputSnapshot, request),
    inspect: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserInspect, request),
    getDialog: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserGetDialog, request),
    handleDialog: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserHandleDialog, request),
    automation: (request) =>
      invokeBrowserWithEpoch(IPC_CHANNELS.browserAutomation, request),
    // Transfers are not runtime scoped: they keep the owner captured when the
    // download started, so no `expectedRuntimeGeneration` and no stale check.
    listTransfers: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserListTransfers, request),
    transferCommand: (command) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserTransferCommand, command),
    saveDownload: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserSaveDownload, request),
    answerFileChooser: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserAnswerFileChooser, request),
    getFileChooser: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserGetFileChooser, request),
    savePdf: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserSavePdf, request),
    getPrintRequest: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserGetPrintRequest, request),
    answerPrintRequest: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserAnswerPrintRequest, request),
    getAuthRequest: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserGetAuthRequest, request),
    answerAuthRequest: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserAnswerAuthRequest, request),
    onEvent: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // The main-process BrowserService is the single producer on this
        // channel; trust the wire shape but cast through the shared union so
        // renderer consumers see the documented BrowserServiceEvent.
        observeBrowserWireValue(data);
        listener(data as BrowserServiceEvent);
        const event = data as BrowserServiceEvent;
        if (
          event.type === 'destroyed' &&
          event.runtimeGeneration ===
            browserRuntimeGenerations.get(event.browserId)
        )
          browserRuntimeGenerations.delete(event.browserId);
      };
      ipcRenderer.on(IPC_CHANNELS.browserEvent, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.browserEvent, handler);
      };
    },
  },
  claudeTerminal: createClaudeTerminalBridge(ipcRenderer),
  codexLogin: {
    start: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.codexLoginStart, request),
    cancel: () => ipcRenderer.invoke(IPC_CHANNELS.codexLoginCancel),
    retryVerification: () =>
      ipcRenderer.invoke(IPC_CHANNELS.codexLoginRetryVerification),
    openBrowser: () => ipcRenderer.invoke(IPC_CHANNELS.codexLoginOpenBrowser),
    onState: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: CodexLoginState,
      ): void => callback(state);
      ipcRenderer.on(IPC_CHANNELS.codexLoginState, handler);
      return (): void => {
        ipcRenderer.removeListener(IPC_CHANNELS.codexLoginState, handler);
      };
    },
  },
  authTerminal: {
    start: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.authTerminalStart, request),
    write: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.authTerminalWrite, request),
    resize: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.authTerminalResize, request),
    stop: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.authTerminalStop, request),
    onOutput: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isAuthTerminalOutputEvent(data)) {
          listener(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.authTerminalOutput, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.authTerminalOutput, handler);
      };
    },
    onExit: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isAuthTerminalExitEvent(data)) {
          listener(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.authTerminalExit, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.authTerminalExit, handler);
      };
    },
  },
  canopyPortal: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.canopyPortalGetState),
    start: () => ipcRenderer.invoke(IPC_CHANNELS.canopyPortalStart),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS.canopyPortalStop),
    regeneratePairingCode: () =>
      ipcRenderer.invoke(IPC_CHANNELS.canopyPortalRegeneratePairingCode),
    cancelPairingCode: () =>
      ipcRenderer.invoke(IPC_CHANNELS.canopyPortalCancelPairingCode),
    onStateChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // Trust the main-process broadcast: the state shape has a single
        // producer on this channel.
        callback(data as CanopyPortalState);
      };
      ipcRenderer.on(IPC_CHANNELS.canopyPortalStateChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.canopyPortalStateChanged,
          handler,
        );
      };
    },
  },
  appAdvisor: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.appAdvisorGetState),
    settingsLoad: () => ipcRenderer.invoke(IPC_CHANNELS.appAdvisorSettingsLoad),
    settingsSave: (settings) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.appAdvisorSettingsSave,
        serializeAppAdvisorSettingsSaveRequest(settings),
      ),
    onSettingsChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        callback(serializeAppAdvisorSettingsLoadResponse(data));
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorSettingsChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.appAdvisorSettingsChanged,
          handler,
        );
      };
    },
    loadClaudeMd: () => ipcRenderer.invoke(IPC_CHANNELS.appAdvisorLoadClaudeMd),
    saveClaudeMd: (contents) => {
      if (typeof contents !== 'string') {
        throw new TypeError('App Advisor CLAUDE.md contents must be a string');
      }
      return ipcRenderer.invoke(IPC_CHANNELS.appAdvisorSaveClaudeMd, contents);
    },
    reportWindowUiState: (state) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.appAdvisorReportWindowUiState,
        serializeAppAdvisorWindowUiState(state),
      ),
    onWindowUiStateChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        callback(serializeAppAdvisorWindowUiState(data));
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorWindowUiStateChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.appAdvisorWindowUiStateChanged,
          handler,
        );
      };
    },
    openWindow: (request?: AppAdvisorWindowOpenRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWindowOpen, request),
    ensureWindow: (request?: AppAdvisorWindowOpenRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWindowEnsure, request),
    closeWindow: (options?: AppAdvisorWindowCloseOptions) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWindowClose, options),
    toggleWindow: (request?: AppAdvisorWindowOpenRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWindowToggle, request),
    getWindowState: () =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWindowGetState),
    // Early access: given only to App Advisor's own page, on its command line.
    initialLayout: readAppAdvisorInitialLayout(process.argv),
    markWindowRendererReady: () =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWindowRendererReady),
    setFloatingSize: (size) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWindowSetFloatingSize, size),
    setDock: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWindowSetDock, request),
    onWindowStateChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // The main-process window manager is the single producer on this
        // channel; trust the wire shape but cast through the shared type.
        callback(data as AppAdvisorWindowState);
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorWindowStateChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.appAdvisorWindowStateChanged,
          handler,
        );
      };
    },
    onWindowCommand: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // One-way main → renderer nudge channel; producers are coalesced
        // in main memory and flushed after `did-finish-load`.
        callback(data as AppAdvisorWindowCommand);
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorWindowCommand, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.appAdvisorWindowCommand,
          handler,
        );
      };
    },
    openTurnFile: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorOpenTurnFile, request),
    notifyTurnFileClosed: (focusReturnId) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorTurnFileClosed, focusReturnId),
    onTurnFileClosed: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        value: unknown,
      ): void => {
        if (typeof value === 'string') callback(value);
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorTurnFileClosed, handler);
      return () =>
        ipcRenderer.removeListener(
          IPC_CHANNELS.appAdvisorTurnFileClosed,
          handler,
        );
    },
    openAgentArtifact: async (request) => {
      const normalized = normalizeAgentArtifactNavigationRequest(request);
      if (!normalized) {
        return {
          ok: false,
          error: {
            code: 'validation_failed',
            message: 'Invalid agent artifact navigation request.',
            retryable: false,
          },
        };
      }
      try {
        const response: unknown = await ipcRenderer.invoke(
          IPC_CHANNELS.appAdvisorOpenAgentArtifact,
          normalized,
        );
        if (isRecord(response) && response.ok === true) {
          return { ok: true };
        }
        return {
          ok: false,
          error: normalizeAgentArtifactNavigationError(
            isRecord(response) ? response.error : response,
          ),
        };
      } catch (error) {
        return {
          ok: false,
          error: normalizeAgentArtifactNavigationError({
            code: 'navigation_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Agent artifact navigation failed.',
            retryable: true,
          }),
        };
      }
    },
    onToolRequest: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // The main-process tool runtime is the single producer on this
        // channel; trust the wire shape but cast through the shared type.
        callback(data as AppAdvisorRendererToolRequest);
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorToolRequest, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.appAdvisorToolRequest, handler);
      };
    },
    onToolRequestCancelled: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isAppAdvisorRendererToolCancellation(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorToolRequestCancelled, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.appAdvisorToolRequestCancelled,
          handler,
        );
      };
    },
    completeToolRequest: (response: AppAdvisorRendererToolResponse) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorToolResponse, response),
    onStateChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        callback(data as AppAdvisorUiStateEnvelope);
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorStateChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.appAdvisorStateChanged,
          handler,
        );
      };
    },
    listWatchers: (request?: {
      destinationChatId?: string;
      destination?: AppAdvisorWatcherDestination;
    }) => ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWatchersList, request),
    listCompletedWatchers: () =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWatchersCompletedList),
    deleteWatcher: (
      watcherIdOrRequest: string | AppAdvisorWatcherDeleteRequest,
    ) => {
      // Normalize legacy string ids into the new request shape so the main
      // handler always sees `{ watcherId, notifySubscriber }`. String input
      // preserves existing semantics — `notifySubscriber` defaults to false.
      const payload: AppAdvisorWatcherDeleteRequest =
        typeof watcherIdOrRequest === 'string'
          ? { watcherId: watcherIdOrRequest, notifySubscriber: false }
          : {
              watcherId: watcherIdOrRequest.watcherId,
              notifySubscriber: watcherIdOrRequest.notifySubscriber === true,
            };
      return ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWatcherDelete, payload);
    },
    createWatcher: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWatcherCreate, request),
    updateWatcher: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWatcherUpdate, request),
    holdChatFiring: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWatcherHoldFiring, request),
    releaseChatFiring: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.appAdvisorWatcherReleaseFiring, request),
    acknowledgeWatcherMessageDelivery: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.appAdvisorWatcherMessageDelivery,
        request,
      ),
    onWatchersChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // The main-process watcher service is the single producer on this
        // channel; trust the wire shape but cast through the shared type.
        callback(data as AppAdvisorWatcherSummary[]);
      };
      ipcRenderer.on(IPC_CHANNELS.appAdvisorWatchersChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.appAdvisorWatchersChanged,
          handler,
        );
      };
    },
  },
  pipelineEditor: {
    onToolRequest: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isPipelineEditorRendererToolRequest(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.pipelineEditorToolRequest, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.pipelineEditorToolRequest,
          handler,
        );
      };
    },
    completeToolRequest: (response: PipelineEditorRendererToolResponse) =>
      ipcRenderer.invoke(IPC_CHANNELS.pipelineEditorToolResponse, response),
  },
  foreignActivity: {
    get: (): Promise<ForeignActivityProjection> =>
      ipcRenderer.invoke(IPC_CHANNELS.foreignActivityGet),
    stop: (request: ForeignActivityStopRequest): Promise<void> =>
      ipcRenderer.invoke(IPC_CHANNELS.foreignActivityStop, request),
    onChanged: (
      listener: (projection: ForeignActivityProjection) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        projection: ForeignActivityProjection,
      ): void => listener(projection);
      ipcRenderer.on(IPC_CHANNELS.foreignActivityChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.foreignActivityChanged,
          handler,
        );
      };
    },
  },
  nativeSubagents: {
    interrupt: (
      req: NativeSubagentInterruptRequest,
    ): Promise<NativeSubagentInterruptResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.nativeSubagentInterrupt, req),
  },
  managedDelegation: {
    message: (
      req: ManagedDelegationMessageRequest,
    ): Promise<ManagedDelegationMessageResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationMessage, req),
    tree: (
      req: ManagedDelegationTreeRequest,
    ): Promise<ManagedDelegationTreeResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationTree, req),
    transcriptPage: (
      req: ManagedDelegationTranscriptPageRequest,
    ): Promise<ManagedDelegationTranscriptPageResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationTranscriptPage, req),
    roots: (
      req: ManagedDelegationRootsRequest,
    ): Promise<ManagedDelegationRootsResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationRoots, req),
    worktreeSummary: (
      req: ManagedDelegationWorktreeSummaryRequest,
    ): Promise<ManagedDelegationWorktreeSummaryResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationWorktreeSummary, req),
    getLifetimeStatus: (
      req: ManagedDelegationLifetimeStatusRequest,
    ): Promise<ManagedDelegationLifetimeStatus> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationLifetimeStatus, req),
    onLifetimeChanged: (
      cb: (event: ManagedDelegationLifetimeChangedEvent) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: ManagedDelegationLifetimeChangedEvent,
      ): void => cb(event);
      ipcRenderer.on(IPC_CHANNELS.managedDelegationLifetimeChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.managedDelegationLifetimeChanged,
          handler,
        );
      };
    },
    extendLifetimeLimit: (
      req: ManagedDelegationExtendLifetimeLimitRequest,
    ): Promise<ManagedDelegationExtendLifetimeLimitResult> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.managedDelegationExtendLifetimeLimit,
        req,
      ),

    listActivity: (): Promise<ChatDelegationActivity[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationActivityList),
    onActivityChanged: (
      cb: (activity: ChatDelegationActivity) => void,
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        activity: ChatDelegationActivity,
      ): void => cb(activity);
      ipcRenderer.on(IPC_CHANNELS.managedDelegationActivityChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.managedDelegationActivityChanged,
          handler,
        );
      };
    },
    stop: (
      req: ManagedDelegationStopRequest,
    ): Promise<ManagedDelegationStopResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationStop, req),
    stopAll: (
      req: ManagedDelegationStopAllRequest,
    ): Promise<ManagedDelegationStopAllResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationStopAll, req),
    changes: (
      req: ManagedDelegationChangesRequest,
    ): Promise<ManagedDelegationChangesResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationChanges, req),
    transcript: (
      req: ManagedDelegationTranscriptRequest,
    ): Promise<ManagedDelegationTranscriptResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.managedDelegationTranscript, req),
  },
  referencePreview: {
    linearScope: () =>
      ipcRenderer.invoke(IPC_CHANNELS.referencePreviewLinearScope),
    linearIssue: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.referencePreviewLinearIssue, request),
    linearTeams: () =>
      ipcRenderer.invoke(IPC_CHANNELS.referencePreviewLinearTeams),
    githubScope: () =>
      ipcRenderer.invoke(IPC_CHANNELS.referencePreviewGitHubScope),
    githubOrigin: (origin) =>
      ipcRenderer.invoke(IPC_CHANNELS.referencePreviewGitHubOrigin, origin),
    github: (target) =>
      ipcRenderer.invoke(IPC_CHANNELS.referencePreviewGitHub, target),
  },
  workspaceContext: {
    get: () => invokeWorkspaceContext(IPC_CHANNELS.workspaceContextGet),
    set: (request) =>
      invokeWorkspaceContext(IPC_CHANNELS.workspaceContextSet, request),
    onChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isWorkspaceContextBroadcast(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.workspaceContextChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.workspaceContextChanged,
          handler,
        );
      };
    },
  },
  personalOrganizationUpgrade: {
    inviteStatus: async (request) =>
      organizationReply(
        OrganizationInviteStatusSchema,
        await ipcRenderer.invoke(
          IPC_CHANNELS.personalOrganizationUpgradeInviteStatus,
          request,
        ),
      ),
    promote: async (request) =>
      organizationReply(
        PersonalOrganizationPromotionOutcomeSchema,
        await ipcRenderer.invoke(
          IPC_CHANNELS.personalOrganizationUpgradePromote,
          request,
        ),
      ),
    invite: async (request) =>
      organizationReply(
        OrganizationInviteResultSchema,
        await ipcRenderer.invoke(
          IPC_CHANNELS.personalOrganizationUpgradeInvite,
          request,
        ),
      ),
    listProjects: async () =>
      PersonalProjectListSchema.parse(
        await ipcRenderer.invoke(IPC_CHANNELS.personalOrganizationUpgradeList),
      ),
    convert: async (request) =>
      PersonalProjectOperationSchema.parse(
        await ipcRenderer.invoke(
          IPC_CHANNELS.personalOrganizationUpgradeConvert,
          request,
        ),
      ),
    status: async (request) =>
      PersonalProjectOperationSchema.nullable().parse(
        await ipcRenderer.invoke(
          IPC_CHANNELS.personalOrganizationUpgradeStatus,
          request,
        ),
      ),
  },
  accountOrganizationSettings:
    createAccountOrganizationSettingsApi(ipcRenderer),
  cloudChats: {
    reconnect: () => ipcRenderer.invoke(IPC_CHANNELS.cloudChatsReconnect),
    uploadAttachment: (target, file) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudChatsUploadAttachment, target, file),
  },
  cloudProjects: {
    findLink: (workspaceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudProjectsFindLink, workspaceId),
    link: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudProjectsLink, request),
    setupCatalog: () =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudProjectsSetupCatalog),
    setupOptions: (projectId) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudProjectsSetupOptions, projectId),
    startSetup: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.cloudProjectsStartSetup, request),
    onSetupProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isCloudProjectSetupProgress(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.cloudProjectsSetupProgress, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.cloudProjectsSetupProgress,
          handler,
        );
      };
    },
  },
  orgProjects: {
    sharedMultiRepo: {
      prepare: async (params) =>
        CORE_SHARED_MULTI_REPO_QUERIES[
          'core.workspace.sharedMultiRepo.prepare'
        ].result.parse(
          await ipcRenderer.invoke(
            IPC_CHANNELS.orgProjectsSharedMultiRepoPrepare,
            params,
          ),
        ),
      create: async (params) =>
        CORE_SHARED_MULTI_REPO_INSTRUCTIONS[
          'core.workspace.sharedMultiRepo.create'
        ].result.parse(
          await ipcRenderer.invoke(
            IPC_CHANNELS.orgProjectsSharedMultiRepoCreate,
            params,
          ),
        ),
      getCreation: async (creationKey) =>
        CORE_SHARED_MULTI_REPO_QUERIES[
          'core.workspace.sharedMultiRepo.getCreation'
        ].result.parse(
          await ipcRenderer.invoke(
            IPC_CHANNELS.orgProjectsSharedMultiRepoGetCreation,
            { creationKey },
          ),
        ),
      listCreations: async () =>
        CORE_SHARED_MULTI_REPO_QUERIES[
          'core.workspace.sharedMultiRepo.listCreations'
        ].result.parse(
          await ipcRenderer.invoke(
            IPC_CHANNELS.orgProjectsSharedMultiRepoListCreations,
            { limit: 50 },
          ),
        ),
    },
    linksList: () => ipcRenderer.invoke(IPC_CHANNELS.orgProjectLinksList),
    linksDecide: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.orgProjectLinksDecide, request),
    setupStart: async ({
      projectId,
      destinationRoot,
    }): Promise<OrgProjectSetupProgress> => {
      const result: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.orgProjectsSetupStart,
        { projectId, destinationRoot },
      );
      if (!isOrgProjectSetupProgress(result))
        throw new Error('Malformed organization project setup reply');
      return result;
    },
    getMemberCodeEligibility: (organizationId) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.orgProjectsMemberCodeEligibility,
        organizationId,
      ),
    inspectFolder: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.orgProjectsInspectFolder, request),
    findRepositoryOwner: async (request): Promise<OrgRepositoryOwnerLookup> => {
      const result: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.orgProjectsFindRepositoryOwner,
        request,
      );
      if (!isOrgRepositoryOwnerLookup(result))
        throw new Error('Malformed organization repository owner reply');
      return result;
    },
    createMemberCodeProject: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.orgProjectsCreateMemberCodeProject,
        request,
      ),
    createMemberMultiRepoProject: (request) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.orgProjectsCreateMemberMultiRepoProject,
        request,
      ),
    checkRepositories: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.orgProjectsCheckRepositories, request),
    setupFromFolder: async ({
      projectId,
      path,
    }): Promise<OrgProjectSetupProgress> => {
      const result: unknown = await ipcRenderer.invoke(
        IPC_CHANNELS.orgProjectsSetupFromFolder,
        { projectId, path },
      );
      if (!isOrgProjectSetupProgress(result))
        throw new Error('Malformed organization project setup reply');
      return result;
    },
    setupCancel: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.orgProjectsSetupCancel, request),
    moveWorkspace: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.orgProjectsMoveWorkspace, request),
    convertWorkspace: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.orgProjectsConvertWorkspace, request),
    moveBackToPersonal: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.orgProjectsMoveBackToPersonal, request),
    onOwnershipChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isOrgProjectOwnershipChangedEvent(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.orgProjectsOwnershipChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.orgProjectsOwnershipChanged,
          handler,
        );
      };
    },
    onSetupProgress: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isOrgProjectSetupProgress(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.orgProjectsSetupProgress, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.orgProjectsSetupProgress,
          handler,
        );
      };
    },
    list: (request) => invokeOrgProjects(IPC_CHANNELS.orgProjectsList, request),
    refresh: (request) =>
      invokeOrgProjects(IPC_CHANNELS.orgProjectsRefresh, request),
    setPreference: (request) =>
      invokeOrgProjects(IPC_CHANNELS.orgProjectsSetPreference, request),
    onChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isDesktopOrgProjectCatalogSnapshot(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.orgProjectsChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.orgProjectsChanged, handler);
      };
    },
  },
  ledger: {
    searchEntries: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.ledgerSearchEntries, request),
    getEntry: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.ledgerGetEntry, request),
    addEntry: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.ledgerAddEntry, request),
    updateEntry: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.ledgerUpdateEntry, request),
    listOwners: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.ledgerListOwners, request),
    searchFeed: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.ledgerFeedSearch, request),
    getFeedEntry: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.ledgerFeedGetEntry, request),
    listFeedWork: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.ledgerFeedWork, request),
    onEntriesChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isLedgerViewChangedEvent(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.ledgerEntriesChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.ledgerEntriesChanged, handler);
      };
    },
  },
  cost: {
    getScope: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.costGetScope, request),
    getChat: (request) => ipcRenderer.invoke(IPC_CHANNELS.costGetChat, request),
    getPipelineRun: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.costGetPipelineRun, request),
    refresh: (request) => ipcRenderer.invoke(IPC_CHANNELS.costRefresh, request),
    watchScope: (scope) => {
      ipcRenderer.send(IPC_CHANNELS.costWatchScope, scope);
      return () => {
        ipcRenderer.send(IPC_CHANNELS.costUnwatchScope, scope);
      };
    },
    onUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isCostUpdatedEvent(data)) callback(data);
      };
      ipcRenderer.on(IPC_CHANNELS.costUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.costUpdated, handler);
      };
    },
  },
  experiments: {
    getSnapshot: async (): Promise<LabsExperimentsSnapshot> =>
      labsExperimentsSnapshotSchema.parse(
        await ipcRenderer.invoke(IPC_CHANNELS.experimentsGetSnapshot),
      ),
    setChoice: async (request): Promise<LabsExperimentsSnapshot> =>
      labsExperimentsSnapshotSchema.parse(
        await ipcRenderer.invoke(
          IPC_CHANNELS.experimentsSetChoice,
          labsExperimentChoiceRequestSchema.parse(request),
        ),
      ),
    onSnapshotChanged: (cb): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        const parsed = labsExperimentsSnapshotSchema.safeParse(data);
        if (parsed.success) cb(parsed.data);
      };
      ipcRenderer.on(IPC_CHANNELS.experimentsSnapshotChanged, handler);
      return (): void => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.experimentsSnapshotChanged,
          handler,
        );
      };
    },
  },
  featureFlags: {
    getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.featureFlagsGetSnapshot),
    refreshContext: () =>
      ipcRenderer.invoke(IPC_CHANNELS.featureFlagsRefreshContext),
    onSnapshotChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        if (isFeatureFlagSnapshot(data)) {
          callback(data);
        }
      };
      ipcRenderer.on(IPC_CHANNELS.featureFlagsSnapshotChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.featureFlagsSnapshotChanged,
          handler,
        );
      };
    },
  },
  automations: {
    list: (request?: AutomationsListRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsList, request),
    listRuns: (request: AutomationRunHistoryRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsListRuns, request),
    create: (request: AutomationCreateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsCreate, request),
    update: (request: AutomationUpdateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsUpdate, request),
    delete: (request: AutomationDeleteRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsDelete, request),
    runNow: (request: AutomationRunNowRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsRunNow, request),
    cancelRun: (request: AutomationCancelRunRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsCancelRun, request),
    generateCron: (request: AutomationCronGenerateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsGenerateCron, request),
    generateIfCommand: (request: AutomationIfCommandGenerateRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsGenerateIfCommand, request),
    listShared: (request: ListSharedAutomationsIpcRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsSharedList, request),
    getShared: (automationId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsSharedGet, automationId),
    listCurated: (request?: ListCuratedAutomationsRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsCuratedList, request),
    getCurated: (key: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsCuratedGet, key),
    createShared: (request: CreateSharedAutomationIpcRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsSharedCreate, request),
    updateShared: (request: UpdateSharedAutomationIpcRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsSharedUpdate, request),
    deleteShared: (request: DeleteSharedAutomationIpcRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.automationsSharedDelete, request),
    publishPublicShare: (
      automationId: string,
    ): ReturnType<CanopyApi['automations']['publishPublicShare']> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsPublicSharePublish,
        automationId,
      ),
    revokePublicShare: (automationId: string): Promise<void> =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsPublicShareRevoke,
        automationId,
      ),
    analyzeCapabilityPackage: (
      request: AnalyzeAutomationCapabilityPackageRequest,
    ) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsCapabilityPackageAnalyze,
        request,
      ),
    cancelCapabilityPackageAnalysis: (analysisId: string) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsCapabilityPackageCancel,
        analysisId,
      ),
    commitCapabilityPackage: (
      request: CommitAutomationCapabilityPackageRequest,
    ) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsCapabilityPackageCommit,
        request,
      ),
    getCapabilityPackageReadiness: (
      request: AutomationCapabilityPackageRequest,
    ) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsCapabilityPackageReadiness,
        request,
      ),
    installCapabilityPackage: (
      request: InstallAutomationCapabilityPackageRequest,
    ) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsCapabilityPackageInstall,
        request,
      ),
    verifySharedPipelineInstallPin: (
      request: VerifyAutomationSharedPipelinePinRequest,
    ) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsSharedPipelinePinVerify,
        request,
      ),
    resolveSharedPipelineInstallPin: (
      request: ResolveAutomationSharedPipelinePinRequest,
    ) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsSharedPipelinePinResolve,
        request,
      ),
    approveSharedPipelineReview: (
      request: ApproveAutomationSharedPipelineReviewRequest,
    ) =>
      ipcRenderer.invoke(
        IPC_CHANNELS.automationsSharedPipelineReviewApprove,
        request,
      ),
    onChanged: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // The main-process automations service is the single producer on
        // this channel; trust the wire shape but cast through the shared
        // type so renderer consumers see the documented snapshot.
        callback(data as AutomationsListResponse);
      };
      ipcRenderer.on(IPC_CHANNELS.automationsChanged, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.automationsChanged, handler);
      };
    },
  },

  spaceNotifications: {
    getSnapshot: () =>
      ipcRenderer.invoke(IPC_CHANNELS.spaceNotificationsGetSnapshot),
    refresh: (scope: SpaceNotificationScope) =>
      ipcRenderer.invoke(IPC_CHANNELS.spaceNotificationsRefresh, scope),
    set: (request: SpaceNotificationSetRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.spaceNotificationsSet, request),
    onChanged: (callback) => {
      // The main-process space notification module is the single producer
      // on this channel.
      const handler = (
        _event: Electron.IpcRendererEvent,
        snapshot: SpaceNotificationPolicySnapshot,
      ): void => {
        callback(snapshot);
      };
      ipcRenderer.on(IPC_CHANNELS.spaceNotificationsChanged, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.spaceNotificationsChanged,
          handler,
        );
      };
    },
  },
  externalProjects: {
    discover: (req: ExternalProjectDiscoverRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.externalProjectsDiscover, req),
    importProjects: (req: ExternalProjectImportRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.externalProjectsImport, req),
    pickFolder: () =>
      ipcRenderer.invoke(IPC_CHANNELS.externalProjectsPickFolder),
    readInvite: () =>
      ipcRenderer.invoke(IPC_CHANNELS.externalProjectsReadInvite),
    acknowledgeInvite: () =>
      ipcRenderer.invoke(IPC_CHANNELS.externalProjectsAcknowledgeInvite),
    readProviderPresence: () =>
      ipcRenderer.invoke(IPC_CHANNELS.externalProjectsProviderPresence),
    onImportProgress: (callback) => {
      // The main-process import module is the single producer on this
      // channel; the listener parameter is typed directly so the shared
      // contract applies without a cast.
      const handler = (
        _event: Electron.IpcRendererEvent,
        event: ExternalProjectImportProgressEvent,
      ): void => {
        callback(event);
      };
      ipcRenderer.on(IPC_CHANNELS.externalProjectsImportProgress, handler);
      return () => {
        ipcRenderer.removeListener(
          IPC_CHANNELS.externalProjectsImportProgress,
          handler,
        );
      };
    },
  },
  scriptActions: createScriptActionsBridge({
    invoke: (channel, request) => ipcRenderer.invoke(channel, request),
    subscribe: (channel, listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: unknown,
      ): void => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  }),
  repoRules: {
    scan: (request) => ipcRenderer.invoke(IPC_CHANNELS.repoRulesScan, request),
    apply: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.repoRulesApply, request),
    status: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.repoRulesStatus, request),
    preview: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.repoRulesPreview, request),
  },
  editorSetup: {
    presence: (request) =>
      ipcRenderer.invoke(IPC_CHANNELS.editorSetupPresence, request),
  },
  workers: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.workersList),
    cancel: (workerId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.workerCancel, workerId),
    retry: (workerId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.workerRetry, workerId),
    onStarted: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        // The main-process worker session service is the single producer on
        // this channel; trust the wire shape but cast through the shared type
        // so renderer consumers see the documented event.
        callback(data as WorkerStartedEvent);
      };
      ipcRenderer.on(IPC_CHANNELS.workerStarted, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.workerStarted, handler);
      };
    },
    onUpdated: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        callback(data as WorkerUpdatedEvent);
      };
      ipcRenderer.on(IPC_CHANNELS.workerUpdated, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.workerUpdated, handler);
      };
    },
    onExited: (callback) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: unknown,
      ): void => {
        callback(data as WorkerExitedEvent);
      };
      ipcRenderer.on(IPC_CHANNELS.workerExited, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.workerExited, handler);
      };
    },
  },
  listUsageLimitedIdleChats: (req) =>
    ipcRenderer.invoke(IPC_CHANNELS.listUsageLimitedIdleChats, req),
  resumeUsageLimitedChats: (req) =>
    ipcRenderer.invoke(IPC_CHANNELS.resumeUsageLimitedChats, req),
  listUsageLimitedIdleSessions: (req) =>
    ipcRenderer.invoke(IPC_CHANNELS.listUsageLimitedIdleSessions, req),
  getResumeQueue: () => ipcRenderer.invoke(IPC_CHANNELS.getResumeQueue),
  enqueueResumeQueue: (req) =>
    ipcRenderer.invoke(IPC_CHANNELS.enqueueResumeQueue, req),
  controlResumeQueue: (action) =>
    ipcRenderer.invoke(IPC_CHANNELS.controlResumeQueue, action),
  onResumeQueueChanged: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      snapshot: ResumeQueueSnapshot,
    ): void => listener(snapshot);
    ipcRenderer.on(IPC_CHANNELS.resumeQueueChanged, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.resumeQueueChanged, handler);
    };
  },
  resumeUsageLimitedSessions: (req) =>
    ipcRenderer.invoke(IPC_CHANNELS.resumeUsageLimitedSessions, req),
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', {
      ...electronAPI,
      ipcRenderer: {
        ...electronAPI.ipcRenderer,
        invoke: (
          ...args: Parameters<typeof electronAPI.ipcRenderer.invoke>
        ): Promise<unknown> =>
          electronAPI.ipcRenderer.invoke(...args).catch(restoreIpcAppError),
      },
    });
    contextBridge.exposeInMainWorld('appErrors', {
      resolve: resolveIpcAppError,
      resolveCoworkFolderMissing: resolveIpcCoworkFolderMissing,
      resolveOperationFailure: resolveIpcOperationFailure,
    });
    contextBridge.exposeInMainWorld('platform', exposedPlatform);
    contextBridge.exposeInMainWorld('localPlatform', localPlatform);
    contextBridge.exposeInMainWorld('api', canopyApi);
    contextBridge.exposeInMainWorld(
      'canopyClientTransport',
      canopyClientTransport,
    );
    contextBridge.exposeInMainWorld(
      'canopyCore',
      createCanopyCoreRelayApi(ipcRenderer),
    );
    contextBridge.exposeInMainWorld('bundles', createBundlesAPI());
    contextBridge.exposeInMainWorld('collections', createCollectionsAPI());
    contextBridge.exposeInMainWorld('pipelines', createPipelinesAPI());
    contextBridge.exposeInMainWorld('plugins', createPluginsAPI());
    contextBridge.exposeInMainWorld(
      'installedItems',
      createInstalledItemsAPI(),
    );
    contextBridge.exposeInMainWorld('skills', createSkillsAPI());
    contextBridge.exposeInMainWorld('agents', createAgentsAPI());
    contextBridge.exposeInMainWorld(
      'skillShareNudge',
      createSkillShareNudgeAPI(),
    );
    contextBridge.exposeInMainWorld(
      'skillSuggestions',
      createSkillSuggestionsAPI(),
    );
    contextBridge.exposeInMainWorld(
      'invocableInventory',
      createInvocableInventoryAPI(),
    );
    contextBridge.exposeInMainWorld('mcpServers', createMcpServersAPI());
    contextBridge.exposeInMainWorld('claudeModelEntries', claudeModelEntries);
    contextBridge.exposeInMainWorld('codexModelEntries', codexModelEntries);
    contextBridge.exposeInMainWorld('ollamaModelEntries', ollamaModelEntries);
    contextBridge.exposeInMainWorld('modelAliases', modelAliases);
    contextBridge.exposeInMainWorld('devInfo', devInfo);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(error);
  }
} else {
  window.electron = {
    ...electronAPI,
    ipcRenderer: {
      ...electronAPI.ipcRenderer,
      invoke: (
        ...args: Parameters<typeof electronAPI.ipcRenderer.invoke>
      ): Promise<unknown> =>
        electronAPI.ipcRenderer.invoke(...args).catch(restoreIpcAppError),
    },
  };
  window.appErrors = {
    resolve: resolveIpcAppError,
    resolveCoworkFolderMissing: resolveIpcCoworkFolderMissing,
    resolveOperationFailure: resolveIpcOperationFailure,
  };
  window.platform = exposedPlatform;
  window.localPlatform = localPlatform;
  window.api = canopyApi;
  window.canopyClientTransport = canopyClientTransport;
  window.canopyCore = createCanopyCoreRelayApi(ipcRenderer);
  window.bundles = createBundlesAPI();
  window.collections = createCollectionsAPI();
  window.pipelines = createPipelinesAPI();
  window.plugins = createPluginsAPI();
  window.installedItems = createInstalledItemsAPI();
  window.skills = createSkillsAPI();
  window.agents = createAgentsAPI();
  window.skillShareNudge = createSkillShareNudgeAPI();
  window.skillSuggestions = createSkillSuggestionsAPI();
  window.invocableInventory = createInvocableInventoryAPI();
  window.mcpServers = createMcpServersAPI();
  // @ts-expect-error -- Fallback for non-context-isolated environments
  window.claudeModelEntries = claudeModelEntries;
  // @ts-expect-error -- Fallback for non-context-isolated environments
  window.modelAliases = modelAliases;
  // @ts-expect-error -- Fallback for non-context-isolated environments
  window.codexModelEntries = codexModelEntries;
  // @ts-expect-error -- Fallback for non-context-isolated environments
  window.ollamaModelEntries = ollamaModelEntries;
  window.devInfo = devInfo;
}

type BrowserProfileMethod = keyof BrowserProfilesApi;
type BrowserProfileResult<M extends BrowserProfileMethod> = Awaited<
  ReturnType<BrowserProfilesApi[M]>
>;
type BrowserProfileEnvelope<M extends BrowserProfileMethod> =
  | { ok: true; value: BrowserProfileResult<M> }
  | { ok: false; error: { code: string; message: string } };

async function invokeBrowserProfile<M extends BrowserProfileMethod>(
  method: M,
  request: unknown,
): Promise<BrowserProfileResult<M>> {
  const result = await ipcRenderer
    .invoke(IPC_CHANNELS.browserProfiles, {
      schemaVersion: 1,
      method,
      request,
    })
    .then((value: BrowserProfileEnvelope<M>) => value);
  if (!result.ok)
    throw Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
  return result.value;
}

// Remember only generations actually delivered to this renderer. Capture before
// invoke, never after an await; an explicit older generation is never replaced.
const browserRuntimeGenerations = new Map<string, number>();
function observeBrowserWireValue(value: unknown): void {
  if (!isRecord(value)) return;
  const item = value;
  if (typeof item.id === 'string' && isRecord(item.profile)) {
    const generation = item.profile.runtimeGeneration;
    if (
      typeof generation === 'number' &&
      generation >= (browserRuntimeGenerations.get(item.id) ?? 0)
    )
      browserRuntimeGenerations.set(item.id, generation);
  }
  if (item.snapshot) observeBrowserWireValue(item.snapshot);
  if (item.browser) observeBrowserWireValue(item.browser);
  if (item.state) observeBrowserWireValue(item.state);
  if (Array.isArray(item.browsers))
    item.browsers.forEach(observeBrowserWireValue);
}
async function invokeBrowserWithEpoch<T>(
  channel: string,
  request: unknown,
): Promise<T> {
  const input = isRecord(request) ? request : {};
  const browserId =
    typeof input.browserId === 'string' ? input.browserId : undefined;
  const expected =
    input.expectedRuntimeGeneration ??
    (browserId ? browserRuntimeGenerations.get(browserId) : undefined);
  const result = await ipcRenderer
    .invoke(
      channel,
      expected === undefined
        ? request
        : { ...input, expectedRuntimeGeneration: expected },
    )
    .then((value: T) => value);
  const runtimeLostAutomation =
    channel === IPC_CHANNELS.browserAutomation &&
    isRecord(result) &&
    result.ok === true &&
    result.completed === false &&
    !('browser' in result) &&
    isRecord(result.receipt) &&
    result.receipt.status === 'outcome_unknown' &&
    result.receipt.outcomeReason === 'runtime_lost';
  const changesGeneration =
    channel === IPC_CHANNELS.browserCreate ||
    channel === IPC_CHANNELS.browserSwitchProfile ||
    channel === IPC_CHANNELS.browserDestroy;
  if (
    !changesGeneration &&
    !runtimeLostAutomation &&
    browserId &&
    expected !== undefined &&
    browserRuntimeGenerations.get(browserId) !== expected
  )
    throw Object.assign(
      new Error(
        'The browser changed profiles while this command was running. Refresh the tab.',
      ),
      { code: 'stale_runtime' },
    );
  observeBrowserWireValue(result);
  return result;
}
