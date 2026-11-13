import { portablePipelineTriggerTypes } from '@canopy/protocol/pipelines';
import {
  inlineFailureReason,
  inlineFailureText,
  type InlineFailure,
} from '@/lib/inline-app-error';
import { marketplaceManagementDestination } from '@canopy/ui-shared/lib';
import { scriptPreferencesActionSchema } from '@canopy/agent-actions/families/settings/script-preferences';
import { requestScriptActionsReview } from '@canopy/ui-app/script-actions';
import { isReplayableAppAdvisorResponse } from '@canopy/desktop-shared/lib/app-advisor-replay';
import { pipelineAutomationTargetSummary } from '@canopy/desktop-shared/lib/automation-pipeline-target';
import { unwrapShareOperationResult } from '@/lib/sharing/share-operation-result';
import { classifyShareFailure } from '@canopy/ui-app/sharing';
import {
  isSidebarItemGroupAction,
  sidebarItemGroupIds,
} from '@canopy/desktop-shared/lib/sidebar-item-group-actions';
import { z } from 'zod/v4';
import { sidebarGroupStackUnits } from '@canopy/desktop-shared/lib/worktree-grouping';
import type { SidebarItemGroupScope } from '@canopy/protocol/sidebar';
import { getCursorSettingsSection } from '@/lib/cursor-settings';
import { extractCreateFromReferences } from '@canopy/desktop-shared/lib/create-from-reference';
import {
  materializeHomeLinkPlan,
  resolveHomeLink,
  homeLinkPromptWithIssueContext,
  selectHomeLink,
} from '@/components/home/homeLinkTarget';
import {
  createHomeLinkMaterializeDeps,
  createHomeLinkResolveDeps,
  currentHomeLinkResolveContext,
  homeLinkScopeKey,
} from '@/components/home/homeLinkTargetHost';
import { createOptionsForBranchTarget } from '@/stores/homeComposerStore';
import { sharingOpenDialogSchema } from '@canopy/desktop-shared/lib/sharing-action-schema';
import {
  isChatCreationActionType,
  parseChatCreationAction,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type { ShareTarget } from '@canopy/desktop-shared/lib/skill-share-nudge';
import { loadChatShareLocalData } from '@/hooks/useChatShareData';
import { resolveShareTarget } from '@/lib/invocableShareTarget';
import { requestShare, useShareRequestStore } from '@/stores/shareRequestStore';
import { isMcpOAuthBrowserScope } from '@canopy/execution-engine/types/browser';
import { dispatchChatHarnessAction } from '@/lib/chat-harness-actions';
import {
  useHomeComposerStore,
  resolveHomeEffectiveDefaults,
} from '@/stores/homeComposerStore';
import {
  ACCOUNT_MCP_ACTION_EVENT,
  type AccountMcpActionEventDetail,
} from '../accountMcpEvents';
import { dispatchCursorSettingsAction } from '@/lib/cursor-settings-actions';
import { resetLayoutToDefault } from '@/lib/panels/persistence-bridge';
import {
  openPipelineExecutionPanel,
  type OpenPipelineExecutionResult,
} from '@/lib/panels/open-pipeline-execution';
import { sharedContainerCanView } from '@/lib/shared-containers/panel-allowlist';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import {
  browserReadTargetFailure,
  decodeBrowserReadTargetError,
} from '@canopy/desktop-shared/browser/read-target-error';
import { isCanopyDesktopStartPageEnabled } from '@/hooks/useCanopyDesktopStartPageEnabled';
import { saveStartPageFromAction } from '@/lib/start-page/save-start-page';
import type {
  BrowserElementSnapshot,
  BrowserInputSnapshotResponse,
  CreateOrgCoworkProjectResult,
  CreateOrgMemberCodeProjectResult,
  CreateOrgMemberMultiRepoProjectResult,
  OrgMemberFolderInspection,
} from '@canopy/desktop-shared/types';
import { orgCreateFolderRefusalText } from '@/lib/orgCreateProject';
import {
  navigateAfterRepositoryWorkspaceCreated,
  openCreatedMultiRepoWorkspaceSettings,
} from '@/lib/postWorkspaceCreateNavigation';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  deriveOrgProjectPlaceholderState,
  MEMBER_ORG_PROJECT_LIMIT,
  ORG_PROJECT_LIMITS,
  type OrgProjectPlaceholderState,
  type OrgProjectSetupProgress,
  type OrgProjectSummary,
} from '@canopy/protocol/org-projects';
import {
  serializeWorkspaceContext,
  type WorkspaceContext,
} from '@canopy/protocol/workspace-context';
import {
  addOrgProjectToComputer,
  getOrgProjectAddStore,
  isOrgProjectAddableState,
  orgProjectAddDestination,
  type OrgProjectAddOutcome,
} from '@/lib/orgProjectCatalogAdd';
import { useLinkedPersonalWorkspacesStore } from '@/stores/linkedPersonalWorkspacesStore';
import {
  BROWSER_ACTION_ROW_LIMIT,
  truncateBrowserConsoleEntry,
  truncateBrowserNetworkEntry,
} from '@canopy/desktop-shared/browser-truncation';
import { buildBrowserAutomationCommand } from '@canopy/agent-actions/families/browser/command';
import {
  FILE_CHOOSER_NOT_PENDING,
  fileChooserDialogAnswer,
  PRINT_REQUEST_NOT_PENDING,
  printRequestDialogAnswer,
  AUTH_REQUEST_NOT_PENDING,
  authRequestDialogAnswer,
} from '@canopy/desktop-shared/lib/browser-pending-surfaces';
import { parseAdvisorBrowserAction } from '@canopy/agent-actions/families/browser/schemas';
import {
  MAX_ARCHIVE_RETENTION_DAYS,
  resolveArchiveRetentionDays,
} from '@canopy/desktop-shared/lib/archive-retention';
import { isLocalMemoryWorkspaceId } from '@canopy/desktop-shared/lib/local-memory-scope';
import { loadPipelineShareTargetDocument } from '@/lib/pipelineDocument';
import {
  assertNever,
  type AppAdvisorAction,
  type AppAdvisorActionError,
  type AppAdvisorActionRequest,
  type AppAdvisorActionResponse,
  type AppAdvisorJson,
} from './types';
import type { RemoteControlState } from '@canopy/desktop-shared/types/remote-control';
import { useAppAdvisorStore } from '@/stores/appAdvisorStore';
import {
  CLAUDE_MAX_TURNS_MIN,
  CLAUDE_MAX_TURNS_MAX,
} from '@canopy/desktop-shared/constants/preferences';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { getSidebarScopingContext } from '@/components/sidebar/useSidebarScopingContext';
import {
  getRendererToolRequestScopeKey,
  isWorkspaceContext,
} from '@canopy/desktop-shared/types';
import { useCanopyPortalStore } from '@/stores/canopyPortalStore';
import {
  useChatStore,
  type ChatTab,
  type WorktreeChatState,
} from '@/stores/chatStore';
import { useActivityStore } from '@/stores/activityStore';
import { useLiveBackgroundTaskStore } from '@/stores/liveBackgroundTaskStore';
import { getLockedHarness } from '@/lib/chatProviderLock';
import { backgroundProcessKindForTaskType } from '@canopy/desktop-shared/lib/background-work';
import { requestBackgroundTaskStop } from '@canopy/app-state';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { addPlanExploreOriginWorktreeKeys } from '@/lib/planExploreWorktreeKeys';
import { useClaudeTerminalStore } from '@/stores/claudeTerminalStore';
import { useCodeReviewStore } from '@/stores/codeReviewStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useFileTabUiStore } from '@/stores/fileTabUiStore';
import { openRunComments } from '@/stores/runCommentsStore';
import { desktopFileSessionController } from '@/lib/file-viewer/desktop-file-session-controller';
import {
  SEND_EDITOR_SELECTION_TO_CHAT_EVENT,
  type SendEditorSelectionToChatDetail,
} from '@/lib/editorSelectionContext';
import { FILE_TREE_SET_SEARCH_EVENT } from '@/lib/fileTreeSearchEvents';
import {
  FILE_PREVIEW_SEARCH_EVENT,
  type FilePreviewSearchEventDetail,
} from '@/lib/filePreviewSearchEvents';
import { requestPipelineAssistantOpen } from '@/lib/pipelineAssistantEvents';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useSkillSuggestionStore } from '@/stores/skillSuggestionStore';
import {
  isSplitPrEligible,
  useGitHubStore,
  type GitShippingSource,
} from '@/stores/githubStore';
import { useNavigationHistoryStore } from '@/stores/navigationHistoryStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  formatPageUnavailableMessage,
  getPageAvailability,
  type PageUnavailable,
} from '@/lib/navigation/page-availability';
import { requestAgentEditor } from '@/lib/agents/agent-editor-request';
import { unifiedEntryIdForRef } from '@canopy/ui-app/capability';
import { normalizeAgentArtifactNavigationRequest } from '@canopy/protocol/agent-artifacts';
import { openLegacyAutomationsTab } from '@/lib/navigation/workflows-navigation';
import { isDataSharingOptInFeature } from '@canopy/protocol/canopy-server';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import { isRetiredTemporaryWorkspace } from '@canopy/desktop-shared/lib/workspace-visibility';
import { openImportProjectsModal } from '@/stores/importProjectsModalStore';
import { openRepoRulesModal } from '@/stores/repoRulesModalStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useBranchFromStore } from '@/stores/branchFromStore';
import { useBaseBranchAlignmentStore } from '@/stores/baseBranchAlignmentStore';
import { useUsageLimitResumePromptStore } from '@/stores/usageLimitResumePromptStore';
import { useResumeQueueStore } from '@/stores/resumeQueueStore';
import { summarizeCloneJobs, useCloneJobsStore } from '@/stores/cloneJobsStore';
import { openImportSessionModal } from '@/stores/importSessionModalStore';
import { openMoveToOrganizationModal } from '@/stores/moveToOrganizationModalStore';
import { isConnectedNonGuest } from '@/stores/cloudConnectGateStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import { launchWorkspaceReadinessFix } from '@/lib/workspaceReadinessLauncher';
import { useSplitPrPreferencesStore } from '@/hooks/useSplitPrPreferences';
import {
  gatherSplitPrEligibilityInputs,
  splitPrLineCount,
} from '@/lib/splitPrEligibilityInputs';
import {
  resolveCreateFromTarget,
  workspaceRepoPathForCreateFrom,
  type ResolvedCreateFromTarget,
} from '@/lib/createFromSource';
import {
  workspaceSummary,
  worktreeSummary,
  workspaceSettingsCapabilities,
} from '@canopy/desktop-shared/lib/app-advisor-worktree-summaries';
import {
  CHAT_HISTORY_MAX_LIMIT,
  CHAT_PLUGIN_LIST_MAX_LIMIT,
  STANDALONE_LIST_MAX_LIMIT,
  chatSettingsResult,
  clampLimit,
  fuzzyMatchText,
  standaloneChatSummary,
  standaloneProjectSummary,
  worktreeTabsResult as advisorWorktreeTabsResult,
} from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import {
  TRACKED_PLAN_COMMENT_MAX_LIMIT,
  TRACKED_PLAN_CONTENT_MAX_CHARS,
  TRACKED_PLAN_LIST_MAX_LIMIT,
  trackedPlanSummary,
} from '@canopy/desktop-shared/lib/app-advisor-tracked-plan-results';
import {
  currentCoworkDestinationRequestId,
  useStandaloneChatStore,
} from '@/stores/standaloneChatStore';
import { useEnvironmentsStore } from '@/stores/environmentsStore';
import {
  ensureTerminalWorktreeHydrated,
  useTerminalStore,
} from '@/stores/terminalStore';
import {
  makeWorktreePanelKey,
  usePanelLayoutStore,
  type WorktreePanelLayout,
} from '@/stores/panelLayoutStore';
import { saveCurrentLayoutAsDefault } from '@/lib/panels/default-layout-save';
import { setWorkspacePanelLayoutMode } from '@/lib/panels/workspace-layout-mode-actions';
import { addEmptyFileTabPanelToGroup } from '@/lib/panels/addChatPanel';
import {
  isAutomationsPanelVariant,
  isSessionBreakdownPanelInstance,
  isUsagePanelVariant,
  CUSTOMIZE_LABEL,
  ORCHESTRATOR_LABEL,
  PANEL_KINDS,
} from '@canopy/protocol';
import {
  openContentPanel,
  type ContentPanelSeed,
} from '@/lib/panels/chat-panel-sync';
import {
  costPanelSeed,
  sessionBreakdownPanelSeed,
  sessionBreakdownTitleFor,
} from '@/lib/cost/open-cost-panels';
import {
  isCuratedCatalogKey,
  PROFILE_ROLES,
  type ProfileRoleId,
} from '@canopy/protocol/plugin-catalog';
import { USAGE_PANEL_VARIANT_LABELS } from '@/lib/panels/usage-variants';
import { AUTOMATIONS_PANEL_VARIANT_LABELS } from '@/lib/panels/automations-variants';
import {
  useBrowserStore,
  type WorktreeBrowserBucket,
} from '@/stores/browserStore';
import { ensureBrowserEventSubscription } from '@/stores/browserEventSubscription';
import { getBrowserUserInteractionGeneration } from '@/lib/browserUserInteraction';
import { buildHookEntries } from '@/components/activity/hook-utils';
import * as yaml from 'js-yaml';
import {
  buildPipelineFailureDebugContext,
  buildPipelineFailureDebugPromptForExecution,
} from '@/lib/pipelineFailureDebugContext';
import {
  getVisibleTriggerInputDefs,
  resolvePipelineTriggerInputs,
} from '@/lib/pipelineTriggerInputs';
import {
  loadDisabledPipelineIdsBestEffort,
  setPipelineDisabled,
} from '@/lib/pipelineEnablement';
import {
  isNavigationMode,
  COWORK_HOME_WORKTREE_ID,
  APP_ADVISOR_PROJECT_ID,
  PIPELINE_EDITOR_PROJECT_ID,
  PIPELINE_EDITOR_WORKTREE_ID,
  PLAN_EXPLORE_CHAT_PROJECT_ID,
  PLUGINS_MANAGEMENT_SECTIONS,
  WORKFLOW_EDIT_SECTIONS,
  WORKSPACE_ROOT_REPO_ID,
  getProviderForModel,
  getChatHarnessOptions,
  isThinkingLevel,
  type AdhocJoinedWorktreeMigration,
  type AdhocMultiRepoRepoMapping,
  type AutomationMutationResponse,
  type BrowserSessionSnapshot,
  type CanopyCloudAccountPublicState,
  type ChatProjectData,
  type ChatTabPluginSelections,
  type EnvironmentRuntime,
  type MultiRepoSidebarItem,
  type PluginsManagementSectionId,
  type RepoBranchInfo,
  type ScheduledActivity,
  type ScheduledActivityRun,
  type SidebarItem,
  type SingleRepoSidebarItem,
  type UpdateChatProjectRequest,
  type WorktreeCompatibilitySymlink,
  type WorktreeData,
  type WorkspaceApplySourceChangesTarget,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import { isCodexSpeed } from '@canopy/execution-engine/lib/codex-speed';
import {
  buildSharedPipelineId,
  parseSharedPipelineLocalId,
} from '@canopy/desktop-shared/pipelines/shared-pipeline-id';
import { APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES } from '@canopy/desktop-shared/lib/app-advisor-actions';
import { runLedgerOpenAction } from '@/lib/ledger/ledger-advisor-actions';
import { openChatTurnDestination } from '@/components/automations/resolveAutomationRunDestination';
import {
  buildAutomationArtifactReceipt,
  buildPipelineArtifactReceipt,
  buildPipelineRunArtifactReceipt,
  buildSkillArtifactReceipt,
  createAgentArtifactDedupeKey,
  withAgentArtifacts as withTransportAgentArtifacts,
} from '@canopy/desktop-shared/lib/agent-artifacts';
import {
  AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR,
  validateAgentAutomationRunPolicy,
} from '@canopy/desktop-shared/lib/agent-automation-policy';
import { validateAgentPipelineMutationPolicy } from '@canopy/desktop-shared/lib/agent-pipeline-policy';
import { cloudChatActionSchema } from '@canopy/agent-actions/families/cloud-chats/actions';
import {
  listCloudChatsForAdvisor,
  openCloudChatForAdvisor,
} from '@/cloud-chats/cloud-chat-advisor-actions';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { MAX_MANAGED_DELEGATION_DEPTH } from '@canopy/protocol/delegation/discovery';
import { isClaudeSettingsAvailable } from '@/lib/claude-settings-availability';
import { useRemoteControlStore } from '@/stores/remoteControlStore';
import { isClaudeTuiChatsEnabled } from '@/lib/claude-tui-chats';
import {
  getTriggerTypes,
  type ExecutionState,
  type ExecutionSummary,
  type IPCResult,
  type Pipeline,
  type PipelineData,
  type PipelineInfo,
  type PipelineInputDef,
  type PipelineLookupRequest,
  type PipelineTriggerType,
  type SharedPipelineSummary,
} from '@canopy/execution-engine/types/pipeline';
import { advisorJobJson } from './advisorPipelineJson';
import type {
  MergePrBlockedReason,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import {
  isPrReadyToMerge,
  hasUnresolvedReviewThreads,
} from '@canopy/desktop-shared/types/github';
import { parsePipelineText } from '@canopy/execution-engine/pipelines/parse-pipeline';
import { normalizePipeline } from '@canopy/execution-engine/pipelines/normalize-pipeline';
import {
  createEmptySelections,
  parseSelectionsJson,
} from '@/lib/pluginSelections';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { brandText } from '@/lib/brand';
import { isClaudeBackedChatTab } from '@/lib/chat-provider';
import { isCoworkChatTarget } from '@/lib/cowork';
import { hydratePersistedChatTab } from '@/lib/chatTabPersistence';
import { useArchivedContainersStore } from '@/stores/archivedContainersStore';
import { useSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { openSharedContainerInOwningContext } from '@/lib/openSharedContainerInOwningContext';
import {
  openArchivedContainerSurface,
  openArchivedOverviewSurface,
} from '@/lib/archivedContainerNavigation';
import {
  getMultiRepoBranchSyncVisibility,
  getSingleRepoGitAction,
  repoCanMergeLocalBranch,
  repoHasChanges,
  repoIsLocalOnly,
  repoRequiresCommitAndPush,
  repoRequiresCommitOnly,
  repoRequiresPush,
  type BranchSyncAction,
} from '@/lib/githubBranchActions';
import type {
  InstalledSkillInfo,
  InstallSkillCapabilityPackageResult,
  SaveCustomSkillRequest,
  SharedSkillDetail,
  SkillContentResponse,
} from '@canopy/desktop-shared/types/skills';
import { importSharedSkill } from '@/lib/sharedSkillImport';
import { resolveSharedResourceErrorMessage } from '@/lib/sharedResourceErrors';
import { requestBrowserPanel } from '@/lib/browserPanelActivation';
import { requestWorktreeArchiveConfirmation } from '@/lib/worktreeArchiveConfirmationEvents';
import { requestSharedContainerRevocationConfirmation } from '@/lib/sharedContainerRevocationConfirmationEvents';
import { requestSharedContainerInvite } from '@/lib/sharedContainerInviteEvents';
import {
  IN_APP_BROWSER_INVALID_URL_MESSAGE,
  isFileBrowserUrl,
  isSafeExternalBrowserUrl,
  normalizeInAppBrowserInput,
} from '@/lib/browserUrl';
import { raiseLocalOnlyConflictToast } from '@/lib/localOnlyConflictToast';
import { registerPendingBrowserActivation } from '@/lib/panels/browser-panel-activation';
import { browserPanelIdFor } from '@/lib/panels/browser-panel-identity';
import { ensureMinimalDestination } from '@/lib/panels/minimal-layout';
import { openDesktopChatVisualsPanel } from '@/lib/panels/chat-visuals-panel-open';
import {
  openPlanDiagramPanel,
  openPlanPanel,
} from '@/lib/panels/plan-panel-open';
import {
  openSubagentsPanel,
  type SubagentPanelIntent,
} from '@/lib/panels/subagent-panel-open';
import { openTrackedPlan } from '@/lib/plans/open-tracked-plan';
import { getWorkspaceLayoutMode } from '@/stores/workspaceLayoutModeStore';
import { SPACE_NOTIFICATION_MENU_COPY } from '@canopy/ui-shared/components';
import {
  spaceNotificationMenuStateFor,
  useSpaceNotificationStore,
} from '@/stores/spaceNotificationStore';
import { openCloudAccountSettings } from '@/lib/navigation/settings-destinations';
import {
  CLOUD_RUN_RETRY_UNSUPPORTED,
  cancelCloudRun,
  getCloudRun,
  listCloudRuns,
  readCloudRun,
  resumeCloudRun,
} from '@canopy/agent-actions/families/pipeline-executions/cloud-runs';
import { AgentPortError } from '@canopy/agent-actions/port/environment-port';
import { cloudExecutionAnswer, withCloudRuns } from './cloud-run-actions';

/**
 * A worktree failure as an agent reads it: the reason behind our sentence,
 * so it can tell a branch conflict from running setup.
 */
function worktreeFailureAgentText(
  failure: InlineFailure | null,
): string | null {
  return inlineFailureReason(failure) ?? inlineFailureText(failure);
}

interface CacheEntry {
  response: AppAdvisorActionResponse;
}

const VALID_PROFILE_ROLES: ReadonlySet<string> = new Set(PROFILE_ROLES);
const ENVIRONMENT_RUNTIMES: readonly EnvironmentRuntime[] = [
  'canopy',
  'agent',
  'pipeline',
];
const ENVIRONMENT_RUNTIME_KEYS = new Set<string>(ENVIRONMENT_RUNTIMES);

/**
 * Narrows an untrusted action field to a known role id. Mirrors the
 * main-process preferences normalizer, which drops unrecognized ids.
 */
function isProfileRoleId(value: unknown): value is ProfileRoleId {
  return typeof value === 'string' && VALID_PROFILE_ROLES.has(value);
}

function isManagedDelegationMode(value: unknown): boolean {
  return value === 'off' || value === 'explicit-only' || value === 'proactive';
}

const RESPONSE_CACHE_LIMIT = 100;
// Keyed by origin chat plus request ID: request IDs are only unique within a
// chat, so one chat must never replay another chat's response (CAN-3976).
const responseCache = new Map<string, CacheEntry>();

function responseCacheKey(
  request: Pick<AppAdvisorActionRequest, 'requestId' | 'originChatTabId'>,
): string {
  return getRendererToolRequestScopeKey(
    request.requestId,
    request.originChatTabId,
  );
}
/**
 * Actions the Ledger keys by request ID. A failure of one is not cached: its
 * outcome can be unclear, and sending it again with the same key lets the
 * Ledger return what it recorded instead of recording it twice.
 */
const LEDGER_KEYED_ACTION_TYPES: ReadonlySet<string> = new Set([
  'ledger.add_entry',
]);
/** The retired Agents page id, translated at the `go_to_page` boundary. */
const LEGACY_AGENTS_PAGE = 'agents';
const NAVIGATION_PAGES = new Set([
  'mcp-account-connections',
  'main',
  'overview',
  // The Home surface renderer plan adds a top-level Home page (chat-centric
  // draft composer) reachable from the sidebar's New Task button. The
  // dispatcher validates the payload against this set before delegating to
  // `navigationStore.navigate`, so the value must be listed here for
  // `navigation.go_to_page` to reach it.
  'home',
  'chat',
  'pipelines',
  // The Automations frontend plan adds a new top-level page that lives in
  // the sidebar between Pipelines and Plugins. The dispatcher validates the
  // payload against this set before delegating to `navigationStore.navigate`,
  // so the new value must be listed here for `navigation.go_to_page` to
  // succeed.
  'automations',
  // Legacy Workflows id (CAN-3980): `navigate` resolves it to Runs filtered
  // to watchers, as it resolves `automations` and `pipelines` to the Library.
  'watchers',
  // The Workflows tabs (CAN-3981): Runs, Schedule and Library.
  'workflows',
  'workflows-schedule',
  'workflows-library',
  'plugins',
  'audit',
  'statistics',
  'usage',
  'environments',
  // The Claude Workers frontend plan adds a top-level page (a grid of
  // read-only worker terminals) above Audit Trail. The dispatcher validates
  // the payload against this set before delegating to
  // `navigationStore.navigate`, so the value must be listed here for
  // `navigation.go_to_page` to reach it.
  'workers',
  // The retired Agents page (CAN-4266). Not a page any more: requests for it
  // open the Marketplace Agents tab instead, so stored prompts keep working.
  LEGACY_AGENTS_PAGE,
  // The unified left-sidebar rework promotes the worktree kanban board to a
  // page-level destination. The dispatcher validates the payload against
  // this set before delegating to `navigationStore.navigate`, so the value
  // must be listed here for `navigation.go_to_page` to reach it.
  'kanban',
  // The global Ledger Feed (phase 14). Reachable only while
  // `canopy-ledger-enabled` is on; see the gate where the action runs.
  'feed',
  // Dev-only Header States reference page. The sidebar entry routes through
  // `navigation.go_to_page` like every other destination, and the dispatcher
  // validates against this set before delegating to `navigationStore.navigate`
  // — an omitted value is dropped SILENTLY, so the menu item would appear and
  // do nothing. Visibility is still gated by `header-states-page-flag.ts`.
  'header-states',
  // Dev/E2E-only WorktreeRow state reference page. Listed so the sidebar
  // More-menu entry (which routes through `navigation.go_to_page`) can reach
  // it; the entry itself is gated to dev and E2E builds.
  'worktree-states',
  // Dev/E2E-only Activity card state-machine reference page.
  'activity-states',
  // Dev/E2E-only message-bubble state reference page; same gating model as
  // 'worktree-states'.
  'message-bubble-states',
  // Dev/E2E-only review page for a batch of landed UI fixes; same gating
  // model as 'header-states' (page-level gate, localStorage opt-in).
  'change-review',
  // Dev/E2E-only reference page for every inline notice; page-level gate.
  'notice-states',
]);
const WORKSPACE_SETTINGS_TABS = new Set([
  'details',
  'repositories',
  'scripts',
  'hooks',
  'environment',
  'code-graph',
]);
const CLAUDE_TERMINAL_BUSY_TURN_STATES = new Set([
  'starting',
  'running',
  'cleaning_up',
]);
const PLUGINS_OPEN_TAB_EVENT = 'canopy:plugins-open-tab';
const PLUGINS_MANAGEMENT_SECTION_SET: Set<string> = new Set(
  PLUGINS_MANAGEMENT_SECTIONS,
);
const WORKFLOW_EDIT_SECTION_SET: Set<string> = new Set(WORKFLOW_EDIT_SECTIONS);
const WORKTREE_CHAT_OPEN_ARCHIVES_EVENT = 'canopy:worktree-chat-open-archives';
const SKILLS_CHANGED_EVENT = 'canopy:skills-changed';
const SETTINGS_SECTIONS = new Set([
  'canopy',
  'performance',
  'shortcuts',
  'display',
  'notifications',
  'account',
  'privacy',
  'remote-access',
  'chat',
  'approvals',
  'instructions',
  'harnesses',
  'app-advisor',
  'terminal',
  'environment',
  'files',
  'dictation',
  'codex',
  'claude',
  'ollama',
  'account-proxy',
  'git',
  'plan-detection',
  'applications',
  'mcp',
  'code-graph',
  'experiments',
  'memory',
  'plugins',
  'feedback',
  'legal',
]);
const SKILL_LIST_DEFAULT_LIMIT = 50;
const SKILL_LIST_MAX_LIMIT = 200;
const PLUGIN_KINDS = new Set(['collection', 'skill', 'plugin', 'mcp']);
const PLUGIN_PROVIDERS = new Set(['claude', 'codex']);
const AGENT_PROVIDER_TYPES = new Set(['claude', 'codex', 'ollama']);
const WORKTREE_CHAT_ACTIONS = new Set(['hand_off', 'fork', 'branch']);
const PIPELINE_LIST_DEFAULT_LIMIT = 50;
const PIPELINE_LIST_MAX_LIMIT = 200;
// Server contract for shared-Automation listing (web MAX_LIMIT).
const SHARED_AUTOMATION_LIST_MAX_LIMIT = 100;
const PIPELINE_EXECUTION_LIST_DEFAULT_LIMIT = 25;
const PIPELINE_EXECUTION_LIST_MAX_LIMIT = 200;
const PIPELINE_CONTENT_DEFAULT_MAX_CHARS = 60_000;
const PIPELINE_CONTENT_MAX_CHARS = 500_000;
const RENDERER_BROWSER_ADVISOR_SCOPE_SHAPE = {
  expectedRuntimeGeneration: z.number().int().positive().optional(),
  projectId: z.string().optional(),
  worktreeId: z.string().optional(),
};
const PIPELINE_RUN_MODES = new Set<PipelineTriggerType>([
  'dispatch',
  'plan_ready',
  'task_ready',
]);
const PANEL_KIND_SET = new Set<string>(PANEL_KINDS);
const LEDGER_ENTRY_TYPE_SET = new Set<string>([
  'TASK',
  'ACTION',
  'DECISION',
  'OBSERVATION',
  'SUMMARY',
]);
const LEDGER_PUBLIC_ENTRY_TYPE_SET = new Set<string>([
  'TASK',
  'ACTION',
  'DECISION',
  'OBSERVATION',
]);
const LEDGER_STATUS_SET = new Set<string>([
  'TODO',
  'IN_PROGRESS',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'NEEDS_REVIEW',
  'INFO',
]);
const LEDGER_SEARCH_LIMIT_MAX = 50;
const LEDGER_HIGHLIGHTS_MAX = 5;
const PANEL_SPLIT_DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
const PANEL_DROP_EDGES = new Set(['top', 'bottom', 'left', 'right', 'center']);
type WorktreeGitAction = Extract<
  AppAdvisorAction,
  { type: 'worktree.run_git_action' }
>['action'];
const WORKTREE_GIT_ACTIONS = new Set<WorktreeGitAction>([
  'create-pr',
  'commit',
  'merge',
  'merge-pr',
  'commit-and-push',
  'pull-commit-and-push',
  'push',
  'pull',
]);

const CLOUD_NAME = `${brandText.appName} Cloud`;
const PORTAL_NAME = REMOTE_CONTROL_LABEL;
// Lowercase form for mid-sentence prose; PORTAL_NAME stays proper-cased for
// sentence-start usage.
const PORTAL_NAME_INLINE = REMOTE_CONTROL_LABEL.toLowerCase();

export const CANOPY_PORTAL_DISABLED_TOAST = `${PORTAL_NAME} is not available.`;

const SHARED_CONTAINERS_DISABLED_MESSAGE =
  'Shared containers are not available.';

function isCanopyPortalEnabled(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key);
}

function isDesktopPrSplitEnabled(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key);
}

function isSharedContainerRecipientEnabled(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key);
}

function rejectIfPortalDisabled(actionLabel: string): boolean {
  if (isCanopyPortalEnabled()) {
    return false;
  }
  useGitHubStore.getState().addToast(CANOPY_PORTAL_DISABLED_TOAST, 'info');
  // eslint-disable-next-line no-console
  console.info(
    `[dispatcher] Skipping ${actionLabel}: canopy-portal-enabled flag is off.`,
  );
  return true;
}

function claudeSettingsUnavailableError(): AppAdvisorActionError {
  return {
    code: 'surface_unavailable',
    message: 'Claude settings are not available.',
  };
}

function claudeTuiChatsUnavailableError(): AppAdvisorActionError {
  return {
    code: 'surface_unavailable',
    message: 'Claude terminal chat mode is not available.',
  };
}

/** Refuses a Browser open in a window that cannot host the in-app browser. */
function inAppBrowserUnavailableError(): AppAdvisorActionError {
  return {
    code: 'surface_unavailable',
    message: "Open Browser from the other computer's own window.",
  };
}

/** Refuses a known page the availability policy has switched off. */
function pageUnavailableError(
  unavailable: PageUnavailable,
): AppAdvisorActionError {
  return {
    code: 'surface_unavailable',
    message: formatPageUnavailableMessage(unavailable),
  };
}

function canopyPortalDisabledResponse(): {
  ok: true;
  result: { skipped: true; reason: string };
} {
  return {
    ok: true,
    result: {
      skipped: true,
      reason: 'canopy-portal-disabled',
    },
  };
}

/**
 * `pipeline.open_run`'s response for an opener result. `applied` and
 * `ownerless` are shown runs; each opener error keeps its reason, and the
 * message is the same user-facing copy the UI toasts.
 */
function pipelineOpenRunResponse(result: OpenPipelineExecutionResult): {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
} {
  switch (result.status) {
    case 'applied':
      return {
        ok: true,
        result: {
          host: 'panel',
          outcome: result.outcome,
          ownerKey: result.ownerKey,
          panelId: result.panelId,
          auxiliaryWindow: result.layoutKey !== result.ownerKey,
        },
      };
    case 'ownerless':
      return {
        ok: true,
        result: { host: 'compatibility', reason: result.reason },
      };
    case 'error':
      return { ok: false, error: pipelineOpenRunError(result) };
  }
}

function pipelineOpenRunError(
  result: Extract<OpenPipelineExecutionResult, { status: 'error' }>,
): AppAdvisorActionError {
  const { message } = result;
  switch (result.code) {
    case 'not_found':
    case 'owner_missing':
      return { code: 'not_found', message };
    case 'owner_mismatch':
      return { code: 'invalid_target', message };
    case 'layout_unavailable':
      return { code: 'surface_unavailable', message, retryable: true };
    case 'navigation_failed':
      return { code: 'navigation_failed', message, retryable: true };
    case 'superseded':
      // A newer navigation replaced this one; retrying would undo it.
      return { code: 'navigation_failed', message };
  }
}

function createClientId(): string {
  return (
    window.crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}
const PIPELINE_EXECUTION_STATUSES = new Set<ExecutionState['status']>([
  'pending',
  'running',
  'paused',
  'success',
  'failure',
  'cancelled',
]);

interface ChatHistoryTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
  tab: ChatTab;
}

interface StandaloneChatHistoryTarget extends ChatHistoryTarget {
  archived: boolean;
}

interface PipelineRunModeSummary {
  [key: string]: AppAdvisorJson;
  mode: PipelineTriggerType;
  inputCount: number | null;
}

interface PipelineInputSummary {
  [key: string]: AppAdvisorJson;
  name: string;
  type: string;
  required: boolean;
  description: string;
  default: AppAdvisorJson;
  options: AppAdvisorJson;
  min: AppAdvisorJson;
  max: AppAdvisorJson;
}

interface PipelineListRow {
  [key: string]: AppAdvisorJson;
  id: string;
  name: string;
  description: string;
  source: string;
  readonly: boolean;
  filename: string;
  filePath: string;
  enabled: boolean;
  runModes: PipelineRunModeSummary[];
}

interface PipelineExecutionRow {
  [key: string]: AppAdvisorJson;
  id: string;
  pipelineId: string;
  name: string;
  description: string;
  status: ExecutionState['status'];
  startedAt: string;
  completedAt: string | null;
  projectId: string | null;
  worktreeId: string | null;
  eventName: string | null;
  hasReport: boolean;
  hasPlan: boolean;
  planModified: boolean;
  inputRequested: boolean;
  inputRequestCount: number;
}

/** Canopy Cloud is the only shared-pipeline server this dispatcher resolves. */
function parseCanopyCloudPipelineLocalId(
  pipelineId: string,
): { remoteId: string } | null {
  const parsed = parseSharedPipelineLocalId(pipelineId);
  if (!parsed || parsed.serverId !== CANOPY_CLOUD_SERVER_ID) return null;
  return { remoteId: parsed.remoteId };
}

function resolveSharedPipelineTarget(action: {
  pipelineId?: string;
  remoteId?: string;
}): { remoteId: string } | null {
  if (action.pipelineId) {
    const parsed = parseCanopyCloudPipelineLocalId(action.pipelineId);
    if (parsed) return parsed;
  }
  return action.remoteId ? { remoteId: action.remoteId } : null;
}

function sharedPipelineInfo(summary: SharedPipelineSummary): PipelineInfo {
  return {
    id: buildSharedPipelineId(CANOPY_CLOUD_SERVER_ID, summary.id),
    name: summary.name,
    filename: '',
    description: summary.description,
    icon: summary.icon,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    triggerTypes: summary.triggerTypes,
    source: 'shared',
    readonly: !summary.canUpdate,
    serverId: CANOPY_CLOUD_SERVER_ID,
    remoteId: summary.id,
    canUpdate: summary.canUpdate,
    canDelete: summary.canDelete,
    shareScope: summary.shareScope ?? 'private',
    ...(summary.owner ? { owner: summary.owner } : {}),
  };
}

function applyPipelineMetadataOverrides(
  pipeline: Pipeline,
  action: { name?: string; description?: string; icon?: string },
): Pipeline {
  return {
    ...pipeline,
    ...(action.name !== undefined ? { name: action.name } : {}),
    ...(action.description !== undefined
      ? { description: action.description }
      : {}),
    ...(action.icon !== undefined ? { icon: action.icon } : {}),
  };
}

function pipelineToYaml(pipeline: Pipeline): string {
  return yaml.dump({ pipeline }, { lineWidth: 120, noRefs: true });
}

async function loadPipelineYamlSource(action: {
  rawYaml?: string;
  yamlFilePath?: string;
}): Promise<string> {
  if (action.rawYaml !== undefined) {
    return action.rawYaml;
  }
  if (!action.yamlFilePath) {
    throw new Error('Provide rawYaml or yamlFilePath.');
  }
  const file = await window.api.readFileContent({
    absolutePath: action.yamlFilePath,
  });
  if (file.truncated) {
    throw new Error(
      `Pipeline YAML file ${action.yamlFilePath} exceeds the readable file size limit.`,
    );
  }
  if (file.kind !== 'text' && file.kind !== 'markdown') {
    throw new Error(
      `Pipeline YAML file ${action.yamlFilePath} is not a supported text file.`,
    );
  }
  return file.content;
}

async function parsePipelineYamlSource(action: {
  rawYaml?: string;
  yamlFilePath?: string;
  name?: string;
  description?: string;
  icon?: string;
}): Promise<Pipeline> {
  const rawYaml = await loadPipelineYamlSource(action);
  const pipeline = applyPipelineMetadataOverrides(
    parsePipelineText(rawYaml),
    action,
  );
  normalizePipeline(pipeline);
  return pipeline;
}

async function loadSharedPipeline(
  pipelineId: string,
): Promise<PipelineData | null> {
  const sharedRef = parseCanopyCloudPipelineLocalId(pipelineId);
  if (!sharedRef) return null;

  const detailResult = await window.pipelines.getShared(sharedRef);
  if (!detailResult.success || !detailResult.data) {
    return null;
  }
  const detail = detailResult.data;
  return {
    info: {
      id: pipelineId,
      name: detail.name,
      filename: '',
      description: detail.description,
      icon: detail.icon,
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
      triggerTypes: detail.triggerTypes,
      source: 'shared',
      readonly: !detail.canUpdate,
      serverId: CANOPY_CLOUD_SERVER_ID,
      remoteId: detail.id,
      canUpdate: detail.canUpdate,
      canDelete: detail.canDelete,
      shareScope: detail.shareScope ?? 'private',
      ...(detail.owner ? { owner: detail.owner } : {}),
    },
    content: parsePipelineText(detail.rawPipeline),
  };
}

async function loadRunnablePipeline(
  pipelineId: string,
  cwd: string,
): Promise<PipelineData | null> {
  const sharedPipeline = await loadSharedPipeline(pipelineId);
  if (sharedPipeline) {
    return sharedPipeline;
  }

  const projectListPromise =
    cwd.length > 0
      ? window.pipelines.discoverProject(cwd)
      : Promise.resolve({ success: true, data: [] as PipelineInfo[] });

  const [storedResult, projectResult] = await Promise.all([
    window.pipelines.list(),
    projectListPromise,
  ]);

  const pipelineInfos: PipelineInfo[] = [
    ...(storedResult.success && storedResult.data ? storedResult.data : []),
    ...(projectResult.success && projectResult.data ? projectResult.data : []),
  ];

  const matchingInfo = pipelineInfos.find((info) => info.id === pipelineId);

  const lookup = matchingInfo
    ? buildPipelineLookupRequest(matchingInfo, cwd)
    : pipelineId;
  const result = await window.pipelines.get(lookup);

  return result.success && result.data ? result.data : null;
}

function buildPipelineLookupRequest(
  info: PipelineInfo,
  cwd: string,
): PipelineLookupRequest {
  if (info.source === 'project' && info.filePath) {
    return { id: info.id, cwd, filePath: info.filePath };
  }

  if (info.source === 'shared' && info.remoteId) {
    return {
      source: 'shared',
      remoteId: info.remoteId,
    };
  }

  return {
    id: info.id,
    source:
      info.source === 'bundled'
        ? 'bundled'
        : info.source === 'curated'
          ? 'curated'
          : 'user',
  };
}

function pipelineInputCount(
  pipeline: PipelineData,
  mode: PipelineTriggerType,
): number {
  return Object.keys(
    getVisibleTriggerInputDefs(
      resolvePipelineTriggerInputs(pipeline.content, mode).inputDefs,
    ),
  ).length;
}

// `workflow` starts only from the Workflows page, never an agent run, so it
// is never listed as a run mode (CAN-5782).
function pipelineRunModes(pipeline: PipelineData): PipelineRunModeSummary[] {
  return portablePipelineTriggerTypes(getTriggerTypes(pipeline.content.on)).map(
    (mode) => ({
      mode,
      inputCount: pipelineInputCount(pipeline, mode),
    }),
  );
}

function pipelineInputDetails(
  inputDefs: Record<string, PipelineInputDef>,
): PipelineInputSummary[] {
  return Object.entries(inputDefs).map(([name, input]) => ({
    name,
    type: input.type ?? 'string',
    required: input.required === true,
    description: input.description ?? '',
    default: input.default === undefined ? null : input.default,
    options: input.options ?? null,
    min: input.min ?? null,
    max: input.max ?? null,
  }));
}

function pipelineListRow(
  pipeline: PipelineData,
  disabledPipelineIds: Set<string>,
): PipelineListRow {
  return {
    id: pipeline.info.id,
    name: pipeline.info.name,
    description: pipeline.info.description,
    source: pipeline.info.source,
    readonly: pipeline.info.readonly,
    filename: pipeline.info.filename,
    filePath: pipeline.info.filePath ?? '',
    enabled: !disabledPipelineIds.has(pipeline.info.id),
    runModes: pipelineRunModes(pipeline),
  };
}

function attachAgentArtifacts(
  response: { ok: true; result?: AppAdvisorJson },
  receipts: readonly unknown[],
): { ok: true; result: AppAdvisorJson } {
  const currentResult = isRecord(response.result) ? response.result : {};
  const attached = withTransportAgentArtifacts(
    { ok: true, result: currentResult },
    receipts,
  );
  return {
    ok: true,
    result:
      sanitizeAppAdvisorJsonValue(attached.result) ??
      sanitizeAppAdvisorJsonValue(currentResult) ??
      null,
  };
}

function sanitizeAppAdvisorJsonValue(
  value: unknown,
): AppAdvisorJson | undefined {
  try {
    const sanitized: unknown = JSON.parse(JSON.stringify(value));
    return isAppAdvisorJsonValue(sanitized) ? sanitized : undefined;
  } catch {
    return undefined;
  }
}

function isAppAdvisorJsonValue(value: unknown): value is AppAdvisorJson {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isAppAdvisorJsonValue);
  return isRecord(value) && Object.values(value).every(isAppAdvisorJsonValue);
}

function automationScheduleLabel(activity: ScheduledActivity): string {
  return activity.schedule.kind === 'cron'
    ? `cron ${activity.schedule.expression} (${activity.schedule.timezone})`
    : `once ${activity.schedule.runAt} (${activity.schedule.timezone})`;
}

function automationTargetLabel(activity: ScheduledActivity): string {
  const action = activity.action;
  switch (action.type) {
    case 'app_advisor_prompt':
      return ORCHESTRATOR_LABEL;
    case 'standalone_prompt':
      return `cowork project ${action.chatProjectId}`;
    case 'worktree_prompt':
      return `project ${action.workspaceId}`;
    case 'worktree_session_prompt':
      return `chat ${action.workspaceId}/${action.worktreeId}/${action.chatId}`;
    case 'worktree_pipeline':
      return pipelineAutomationTargetSummary(action);
    case 'pipeline_execution_resume':
      return `pipeline execution ${action.executionId}`;
  }
}

function appAdvisorAutomationReceipt(
  operation: string,
  activity: ScheduledActivity,
  running: boolean,
): ReturnType<typeof buildAutomationArtifactReceipt> {
  return buildAutomationArtifactReceipt({
    operation,
    activityId: activity.id,
    name: activity.name,
    enabled: activity.enabled,
    running,
    schedule: automationScheduleLabel(activity),
    ...(activity.nextRunAt ? { nextRunAt: activity.nextRunAt } : {}),
    actionKind: activity.action.type,
    targetSummary: automationTargetLabel(activity),
    ifCommandConfigured: Boolean(activity.ifCommand?.trim()),
    navigationTarget: { kind: 'automation_editor', activityId: activity.id },
  });
}

async function appAdvisorPipelineReceipt(
  operation: string,
  pipeline: PipelineData,
  context?: { projectId?: string; worktreeId?: string; repoId?: string },
): Promise<ReturnType<typeof buildPipelineArtifactReceipt>> {
  const disabled = await loadDisabledPipelineIdsBestEffort();
  const normalized = normalizePipeline(pipeline.content);
  const remoteId = pipeline.info.remoteId;
  if (pipeline.info.source === 'shared' && !remoteId) {
    throw new Error('A shared pipeline receipt requires a remote id.');
  }
  return buildPipelineArtifactReceipt({
    operation,
    source: pipeline.info.source,
    ...(pipeline.info.source === 'shared'
      ? { sharedRemoteId: remoteId }
      : { localId: pipeline.info.id }),
    name: pipeline.content.name,
    ...(pipeline.content.description
      ? { description: pipeline.content.description }
      : {}),
    enabled: !disabled.has(pipeline.info.id),
    scopes: normalized.scope,
    // `workflow` starts only from the Workflows page, never an agent run.
    runModes: portablePipelineTriggerTypes(
      getTriggerTypes(pipeline.content.on),
    ),
    jobCount: Object.keys(pipeline.content.jobs).length,
    stepCount: Object.values(pipeline.content.jobs).reduce(
      (total, job) => total + job.steps.length,
      0,
    ),
    navigationTarget: {
      kind: 'pipeline_editor',
      pipelineId: pipeline.info.id,
      source: pipeline.info.source,
      ...(pipeline.info.source === 'project' &&
      context?.projectId &&
      context.worktreeId
        ? {
            projectId: context.projectId,
            worktreeId: context.worktreeId,
            ...(context.repoId ? { repoId: context.repoId } : {}),
          }
        : {}),
      ...(pipeline.info.remoteId
        ? { sharedRemoteId: pipeline.info.remoteId }
        : {}),
    },
  });
}

function truncateContent(
  content: string,
  maxChars: number | undefined,
): { content: string; truncated: boolean; originalLength: number } {
  const limit = clampLimit(
    maxChars,
    PIPELINE_CONTENT_DEFAULT_MAX_CHARS,
    PIPELINE_CONTENT_MAX_CHARS,
  );
  if (content.length <= limit) {
    return { content, truncated: false, originalLength: content.length };
  }
  return {
    content: content.slice(0, limit),
    truncated: true,
    originalLength: content.length,
  };
}

// Uses the sidebar's retirement rule so every action can reach exactly the
// combinations the sidebar shows, including empty ones kept by explicit
// Always show or by retained archived containers.
function visibleWorkspaces(): SidebarItem[] {
  return useProjectsStore
    .getState()
    .projects.filter((item) => !isRetiredTemporaryWorkspace(item));
}

function repoMappingSummary(
  mapping: AdhocMultiRepoRepoMapping,
): AppAdvisorJson {
  return {
    ...(mapping.sourceRepoId ? { sourceRepoId: mapping.sourceRepoId } : {}),
    destinationRepoId: mapping.destinationRepoId,
    repoName: mapping.repoName,
    repoPath: mapping.repoPath,
    ...(mapping.oldWorktreePath
      ? { oldWorktreePath: mapping.oldWorktreePath }
      : {}),
    newWorktreePath: mapping.newWorktreePath,
  };
}

function compatibilitySymlinkSummary(
  symlink: WorktreeCompatibilitySymlink,
): AppAdvisorJson {
  return {
    path: symlink.path,
    targetPath: symlink.targetPath,
    reason: symlink.reason,
    sourceWorkspaceId: symlink.sourceWorkspaceId,
    sourceWorktreeId: symlink.sourceWorktreeId,
    ...(symlink.repoId ? { repoId: symlink.repoId } : {}),
    createdAt: symlink.createdAt,
  };
}

function joinedWorktreeSummary(
  joined: AdhocJoinedWorktreeMigration,
): AppAdvisorJson {
  return {
    workspaceId: joined.workspaceId,
    worktreeId: joined.worktreeId,
    repoMappings: joined.repoMappings.map(repoMappingSummary),
    selectedRepoIdRewrites: joined.selectedRepoIdRewrites,
    sourceRootRepoIdRewrite: joined.sourceRootRepoIdRewrite ?? null,
    filePathRewrites: joined.filePathRewrites.map((rewrite) => ({
      fromRoot: rewrite.fromRoot,
      toRoot: rewrite.toRoot,
    })),
    compatibilitySymlinks: joined.compatibilitySymlinks.map(
      compatibilitySymlinkSummary,
    ),
    removedTemporaryWorkspaceId: joined.removedTemporaryWorkspaceId ?? null,
  };
}

function getWorkspaceOrError(
  workspaceId: string,
): SidebarItem | { error: AppAdvisorActionError } {
  const workspace = visibleWorkspaces().find((item) => item.id === workspaceId);
  if (!workspace) {
    return {
      error: {
        code: 'not_found',
        message: `Project ${workspaceId} was not found.`,
      },
    };
  }
  return workspace;
}

/**
 * Same as {@link getWorkspaceOrError}, but also rejects cowork workspaces.
 * Cowork workspaces have no git worktrees; real cowork App Advisor support
 * lands in a later phase, so worktree-scoped actions reject them explicitly
 * rather than fabricating git data.
 */
function getGitWorkspaceOrError(
  workspaceId: string,
):
  | SingleRepoSidebarItem
  | MultiRepoSidebarItem
  | { error: AppAdvisorActionError } {
  const workspace = getWorkspaceOrError(workspaceId);
  if ('error' in workspace) {
    return workspace;
  }
  if (workspace.type === 'cowork') {
    return {
      error: {
        code: 'unsupported_action',
        message: `Project ${workspaceId} is a cowork project and has no git worktrees.`,
      },
    };
  }
  return workspace;
}

async function ensureProjectsHydrated(): Promise<void> {
  const projects = useProjectsStore.getState();
  if (projects.hasHydratedProjects || projects.isLoading) {
    return;
  }
  await projects.loadProjects({ silent: true });
}

/**
 * The memory scope an action names explicitly. A project scope must name a
 * project that still exists; it never falls back to the selected project.
 */
/**
 * Dispatch a single {@link AppAdvisorAction} against the renderer. Used by
 * both the renderer-side App Advisor tool bridge (for assistant tool
 * calls) and UI handlers that funnel button clicks through the same typed
 * action surface.
 *
 * Idempotency:
 *  - The dispatcher keeps an LRU of the last 100 `requestId → response`
 *    entries. A repeated `requestId` returns the cached response without
 *    re-executing the action. A retryable failure is not kept, so a
 *    repeated `requestId` runs the action again.
 *  - Failures of actions the Ledger keys by request ID are not cached, so a
 *    repeated `requestId` reaches the Ledger, which answers it idempotently.
 *
 * Staleness:
 *  - Actions that mutate UI honor `expectedUiRevision` when supplied. A
 *    revision mismatch returns `stale_ui_state`. Pure-open/close/navigation
 *    actions skip the check so simple "open settings" flows still work.
 */
type AppAdvisorActionRequestInput = Omit<AppAdvisorActionRequest, 'action'> & {
  action: unknown;
  signal?: AbortSignal;
};

/**
 * Live provider tasks of a worktree that no process card lists: Agent
 * activity's native task rows, which come from the live task set (turn-state
 * phases 20 and 41d). Their Stop works only in a Claude chat (D10). A chat
 * whose transcript isn't loaded may still be Claude, so only a known other
 * harness refuses; main refuses a Codex stop itself.
 */
function uncardedLiveTasks(
  projectId: string,
  worktreeId: string,
  processes: readonly { chatId: string; taskId?: string }[],
): {
  chatId: string;
  task: { taskId: string; taskType?: string; status?: string };
  canStop: boolean;
}[] {
  const carded = new Set(
    processes.map((process) =>
      JSON.stringify([process.chatId, process.taskId]),
    ),
  );
  const tabs =
    useChatStore.getState().worktreeChats[worktreeKey(projectId, worktreeId)]
      ?.tabs ?? [];
  return Object.values(useLiveBackgroundTaskStore.getState().byChat)
    .filter(
      (entry) =>
        entry.projectId === projectId && entry.worktreeId === worktreeId,
    )
    .flatMap((entry) => {
      const tab = tabs.find((candidate) => candidate.id === entry.chatId);
      const harness = tab?.executionHarness ?? getLockedHarness(tab);
      const canStop = harness === undefined || harness === 'claude';
      return entry.liveTasks
        .filter(
          (task) => !carded.has(JSON.stringify([entry.chatId, task.taskId])),
        )
        .map((task) => ({ chatId: entry.chatId, task, canStop }));
    });
}

export async function dispatchAppAction(
  request: AppAdvisorActionRequestInput,
): Promise<AppAdvisorActionResponse> {
  const cached = responseCache.get(responseCacheKey(request));
  if (cached) {
    return cached.response;
  }

  const actionValidation = validateAppAdvisorAction(request.action);
  if (!actionValidation.ok) {
    const response = buildInvalidPayloadResponse(
      request,
      actionValidation.message,
    );
    if (
      isRecord(request.action) &&
      request.action.type === 'settings.set_daily_credit_drip'
    ) {
      response.error = {
        code: 'unsupported_action',
        message: actionValidation.message,
      };
    }
    return cacheAndReturn(request, response);
  }

  const { signal, ...wireRequest } = request;
  const validatedRequest: AppAdvisorActionRequest = {
    ...wireRequest,
    action: actionValidation.action,
  };

  if (
    validatedRequest.source === 'assistant' &&
    (validatedRequest.action.type ===
      'worktree.resolve_branch_from_confirmation' ||
      validatedRequest.action.type ===
        'github.resolve_base_branch_alignment') &&
    typeof validatedRequest.expectedUiRevision !== 'number'
  ) {
    return cacheAndReturn(
      validatedRequest,
      buildInvalidPayloadResponse(
        validatedRequest,
        'expectedUiRevision is required for assistant-originated branch-from confirmations.',
      ),
    );
  }

  const stale = enforceExpectedRevision(validatedRequest);
  if (stale) {
    return cacheAndReturn(validatedRequest, stale);
  }

  const cacheFailure = !LEDGER_KEYED_ACTION_TYPES.has(
    validatedRequest.action.type,
  );
  try {
    const handlerResult = await routeAction(
      validatedRequest,
      validatedRequest.originChatTabId,
      signal,
      validatedRequest.requestId,
    );
    const envelope = useCurrentUiStateStore.getState().getEnvelope();
    const response: AppAdvisorActionResponse = {
      requestId: validatedRequest.requestId,
      ok: handlerResult.ok,
      ...(handlerResult.result !== undefined
        ? { result: handlerResult.result }
        : {}),
      ...(handlerResult.error ? { error: handlerResult.error } : {}),
      uiState: envelope,
    };
    return response.ok || cacheFailure
      ? cacheAndReturn(validatedRequest, response)
      : response;
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Unknown dispatcher failure.';
    const response: AppAdvisorActionResponse = {
      requestId: validatedRequest.requestId,
      ok: false,
      error: {
        code: 'execution_failed',
        message,
      },
      uiState: useCurrentUiStateStore.getState().getEnvelope(),
    };
    return cacheFailure ? cacheAndReturn(validatedRequest, response) : response;
  }
}

function buildInvalidPayloadResponse(
  request: Pick<AppAdvisorActionRequest, 'requestId'>,
  message: string,
): AppAdvisorActionResponse {
  return {
    requestId: request.requestId,
    ok: false,
    error: {
      code: 'invalid_payload',
      message,
    },
    uiState: useCurrentUiStateStore.getState().getEnvelope(),
  };
}

function enforceExpectedRevision(
  request: AppAdvisorActionRequest,
  required = false,
): AppAdvisorActionResponse | null {
  if (!required && typeof request.expectedUiRevision !== 'number') return null;
  if (isRevisionAgnosticAction(request.action)) return null;
  const envelope = useCurrentUiStateStore.getState().getEnvelope();
  if (envelope.revision === request.expectedUiRevision) return null;
  const error: AppAdvisorActionError = {
    code: 'stale_ui_state',
    message: `UI state revision ${envelope.revision} does not match expected ${request.expectedUiRevision}.`,
    retryable: true,
  };
  return {
    requestId: request.requestId,
    ok: false,
    error,
    uiState: envelope,
  };
}

/**
 * Navigation/open/close actions don't read prior UI state, so demanding a
 * matching revision adds friction without preventing any class of bug.
 */
function isRevisionAgnosticAction(action: AppAdvisorAction): boolean {
  return (
    APP_ADVISOR_REVISION_AGNOSTIC_ACTION_TYPES as readonly string[]
  ).includes(action.type);
}

function cacheAndReturn(
  request: Pick<AppAdvisorActionRequest, 'requestId' | 'originChatTabId'>,
  response: AppAdvisorActionResponse,
): AppAdvisorActionResponse {
  if (!isReplayableAppAdvisorResponse(response)) {
    responseCache.delete(responseCacheKey(request));
    return response;
  }
  responseCache.set(responseCacheKey(request), { response });
  if (responseCache.size > RESPONSE_CACHE_LIMIT) {
    const firstKey = responseCache.keys().next().value;
    if (firstKey !== undefined) {
      responseCache.delete(firstKey);
    }
  }
  return response;
}

type ActionValidationResult =
  | { ok: true; action: AppAdvisorAction }
  | { ok: false; message: string };

/**
 * The audiences an agent can share to. `private` is only a storage value (a
 * public share, the owner's Personal lane), and the list endpoints hide
 * private-only rows, so an agent share never targets it.
 */
function isSelectableShareScope(
  value: unknown,
): value is 'team' | 'organization' {
  return value === 'team' || value === 'organization';
}

const SIGN_IN_PAGES_PRIVATE_MESSAGE =
  'Sign-in pages are private. Complete sign-in yourself in the browser.';

function validateAppAdvisorAction(action: unknown): ActionValidationResult {
  if (!isRecord(action)) {
    return { ok: false, message: 'Action payload must be an object.' };
  }
  const type = readString(action, 'type');
  if (!type) {
    return { ok: false, message: 'Action payload is missing type.' };
  }

  const missing = (...fields: string[]): ActionValidationResult => ({
    ok: false,
    message: `Action ${type} requires ${fields.join(', ')}.`,
  });
  const invalid = (field: string): ActionValidationResult => ({
    ok: false,
    message: `Action ${type} has invalid ${field}.`,
  });
  const valid = (): ActionValidationResult => ({
    ok: true,
    action: action as unknown as AppAdvisorAction,
  });

  // Plan discussion happens in the worktree's ordinary chats. A legacy
  // plan-explore chat scope is never selected as a worktree or sent to: its
  // turns would run in a session no surface shows.
  if (
    type.startsWith('worktree-chat.') &&
    action.projectId === PLAN_EXPLORE_CHAT_PROJECT_ID
  ) {
    return invalid('projectId');
  }

  if (isChatCreationActionType(type)) return parseChatCreationAction(action);

  if (type.startsWith('sidebar.item_groups.'))
    return isSidebarItemGroupAction(action)
      ? { ok: true, action }
      : invalid('group command');

  switch (type) {
    case 'chat.set_harness':
      return typeof action.pickerId === 'string' &&
        action.pickerId.length > 0 &&
        isKnownString(action.harness, new Set(['claude', 'codex', 'cursor']))
        ? valid()
        : invalid('pickerId or harness');
    case 'account_proxy.status':
      return action.refresh === undefined || typeof action.refresh === 'boolean'
        ? valid()
        : invalid('refresh');
    case 'account_proxy.set_routing': {
      const settings = [
        action.claude,
        action.codex,
        action.keepChatOnOneAccount,
      ];
      return settings.some((value) => value !== undefined) &&
        settings.every(
          (value) => value === undefined || typeof value === 'boolean',
        )
        ? valid()
        : invalid('claude, codex, or keepChatOnOneAccount');
    }
    case 'opencode.connection':
      return isKnownString(
        action.operation,
        new Set(['status', 'models', 'connect', 'cancel', 'disconnect']),
      )
        ? valid()
        : invalid('operation');
    case 'cursor.connection':
      return isKnownString(
        action.operation,
        new Set([
          'connect',
          'disconnect',
          'cancel',
          'change-account',
          'sign-in',
        ]),
      )
        ? valid()
        : invalid('operation');
    case 'cursor.approval_check':
      return isKnownString(action.operation, new Set(['run', 'stop']))
        ? valid()
        : invalid('operation');
    case 'navigation.go_to_page':
      if (!isKnownString(action.page, NAVIGATION_PAGES)) {
        return invalid('page');
      }
      return action.tab === undefined ||
        (action.page === 'automations' &&
          (action.tab === 'scheduled' ||
            action.tab === 'watchers' ||
            action.tab === 'shared'))
        ? valid()
        : invalid('tab');
    case 'navigation.open_chat_turn': {
      if (!readString(action, 'projectId')) return missing('projectId');
      if (!readString(action, 'chatId')) return missing('chatId');
      if (!readString(action, 'userMessageId')) return missing('userMessageId');
      if (
        action.worktreeId !== undefined &&
        !readString(action, 'worktreeId')
      ) {
        return invalid('worktreeId');
      }
      return valid();
    }
    case 'navigation.open_settings':
      return action.section === undefined ||
        isKnownString(action.section, SETTINGS_SECTIONS)
        ? valid()
        : invalid('section');
    case 'navigation.open_workspace_settings':
      if (!readString(action, 'workspaceId')) return missing('workspaceId');
      return action.tab === undefined ||
        isKnownString(action.tab, WORKSPACE_SETTINGS_TABS)
        ? valid()
        : invalid('tab');
    case 'navigation.open_code_graph':
      return readString(action, 'workspaceId')
        ? valid()
        : missing('workspaceId');
    case 'script_actions.list':
    case 'script_actions.open_review':
    case 'script_actions.rescan':
    case 'script_actions.set_pin':
    case 'script_actions.set_shortcut':
      return scriptPreferencesActionSchema.safeParse(action).success
        ? valid()
        : invalid('script preferences');
    case 'navigation.open_editor_setup':
      return action.workspaceId === undefined ||
        readString(action, 'workspaceId')
        ? valid()
        : invalid('workspaceId');
    case 'cloud_chats.list':
    case 'cloud_chats.open':
      return cloudChatActionSchema.safeParse(action).success
        ? valid()
        : invalid('cloud chat');
    case 'memory.rebuild':
    case 'memory.list_snapshots':
    case 'memory.restore_snapshot':
      if (action.scope === undefined) return missing('scope');
      // The snapshot id format is checked in main by the restore IPC.
      if (
        type === 'memory.restore_snapshot' &&
        !readString(action, 'snapshotId')
      ) {
        return missing('snapshotId');
      }
      if (action.scope === 'user') {
        return action.workspaceId === undefined
          ? valid()
          : invalid('workspaceId');
      }
      if (action.scope !== 'workspace') return invalid('scope');
      return isLocalMemoryWorkspaceId(readString(action, 'workspaceId') ?? '')
        ? valid()
        : invalid('workspaceId');
    case 'navigation.go_back':
    case 'navigation.go_forward':
    case 'navigation.open_customize_sidebar':
    case 'navigation.close_settings':
    case 'ollama.install':
    case 'settings.open_memory_folder':
    case 'memory.import_external':
    case 'memory.consolidate_now':
    case 'navigation.open_import_projects':
    case 'navigation.open_pr_picker':
    case 'preferences.get_global_plugin_selections':
    case 'skills.open_manager':
    case 'skill_suggestions.list':
    case 'skill_suggestions.open':
    case 'plugins.open_marketplaces':
    case 'plugins.open_mcp_browse':
    case 'workspace.list':
      return valid();
    case 'plugins.open_management':
      return action.section === undefined ||
        isKnownString(action.section, PLUGINS_MANAGEMENT_SECTION_SET)
        ? valid()
        : invalid('section');
    case 'mcp.account_connect':
    case 'mcp.account_reconnect':
    case 'mcp.account_disconnect':
    case 'mcp.account_promote':
    case 'mcp.account_edit':
      return readString(action, 'serverId') &&
        String(action.serverId).length <= 256
        ? valid()
        : invalid('serverId');
    case 'plugins.open_entry_detail':
      if (
        action.intent !== undefined &&
        action.intent !== 'view' &&
        action.intent !== 'connect'
      )
        return invalid('intent');
      return readString(action, 'entryId') ? valid() : missing('entryId');
    case 'pipeline.save':
    case 'file.save_active':
    case 'file.preview_search_open':
    case 'file.preview_search_close':
    case 'canopy_portal.open':
    case 'canopy_portal.close':
    case 'canopy_portal.stop':
    case 'canopy_cloud.load_account':
    case 'canopy_cloud.clear_api_key':
    case 'canopy_cloud.start_oauth_login':
    case 'canopy_cloud.cancel_oauth_login':
    case 'canopy_cloud.disconnect':
    case 'canopy_portal.open_account_settings':
    case 'app_advisor.open':
    case 'app_advisor.close':
    case 'app_advisor.toggle':
      return valid();
    case 'app_advisor.update_settings':
      return (
        validateOptionalArchiveDays(action, 'archiveRetentionDays') ??
        validateOptionalAutoArchiveDays(action, 'autoArchiveDays') ??
        (action.archiveRetentionDays !== undefined ||
        action.autoArchiveDays !== undefined
          ? valid()
          : missing('archiveRetentionDays or autoArchiveDays'))
      );
    case 'usage.open_resume_modal':
      return action.provider === undefined ||
        action.provider === 'claude' ||
        action.provider === 'codex'
        ? valid()
        : invalid('provider');
    case 'usage.open_resume_queue':
      return valid();
    case 'usage.control_resume_queue':
      return action.action === 'pause' ||
        action.action === 'resume' ||
        action.action === 'stop' ||
        action.action === 'dismiss'
        ? valid()
        : invalid('action');
    case 'preferences.set_global_plugin_selections':
      return (
        validateOptionalPluginSelections(action, 'selections') ??
        (action.selections !== undefined ? valid() : missing('selections'))
      );
    case 'remote_control.get_state':
      return valid();
    case 'remote_control.open_computer':
      return action.deviceId === null ||
        (typeof action.deviceId === 'string' && action.deviceId.length > 0)
        ? valid()
        : invalid('deviceId');
    case 'settings.personalCatalog.set':
    case 'remote_control.set_allow_incoming':
    case 'settings.set_local_memory_enabled':
    case 'settings.set_ledger_agent_recording_enabled':
    case 'settings.set_skill_suggestions_enabled':
    case 'settings.set_launch_at_login':
      return typeof action.enabled === 'boolean' ? valid() : invalid('enabled');
    case 'settings.get_local_memory_model':
    case 'settings.get_handoff_model':
      return valid();
    case 'settings.set_local_memory_model':
    case 'settings.set_handoff_model':
      // Model availability and thinking support are checked by each setting's
      // existing runtime validation when the action runs.
      if (typeof action.model !== 'string' || action.model.length === 0)
        return invalid('model');
      return action.thinkingLevel === undefined ||
        isThinkingLevel(action.thinkingLevel)
        ? valid()
        : invalid('thinkingLevel');
    case 'settings.get_claude_max_turns':
      return valid();
    case 'settings.set_claude_max_turns':
      return action.maxTurns === null ||
        (typeof action.maxTurns === 'number' &&
          Number.isInteger(action.maxTurns) &&
          action.maxTurns >= CLAUDE_MAX_TURNS_MIN &&
          action.maxTurns <= CLAUDE_MAX_TURNS_MAX)
        ? valid()
        : invalid('maxTurns');
    case 'settings.set_managed_delegation_mode':
      return isManagedDelegationMode(action.mode) ? valid() : invalid('mode');
    case 'settings.set_managed_delegation_max_depth':
      return typeof action.maxDepth === 'number' &&
        Number.isInteger(action.maxDepth) &&
        action.maxDepth >= 1 &&
        action.maxDepth <= MAX_MANAGED_DELEGATION_DEPTH
        ? valid()
        : invalid('maxDepth');
    case 'workspace_context.switch':
      return isWorkspaceContext(action.context) ? valid() : invalid('context');
    case 'settings.review_privacy_opt_in':
      if (!isDataSharingOptInFeature(action.feature)) return invalid('feature');
      return normalizeUuid(action.organizationId)
        ? valid()
        : invalid('organizationId');
    case 'settings.set_navigation_mode':
      return isNavigationMode(action.mode) ? valid() : invalid('mode');
    case 'settings.set_profile_role': {
      if (!isProfileRoleId(action.role)) return invalid('role');
      if (
        action.roleDetail !== undefined &&
        typeof action.roleDetail !== 'string'
      ) {
        return invalid('roleDetail');
      }
      return valid();
    }
    case 'watcher.list':
      return valid();
    case 'watcher.get':
      return requireStrings(action, ['id']) ?? valid();
    case 'watcher.delete':
      return (
        requireStrings(action, ['id']) ??
        validateOptionalBoolean(action, 'notifySubscriber') ??
        valid()
      );
    case 'navigation.open_command_palette':
    case 'navigation.open_file_search':
      return action.query === undefined || typeof action.query === 'string'
        ? valid()
        : invalid('query');
    case 'file-tree.set_search':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        (typeof action.query === 'string' ? valid() : invalid('query'))
      );
    case 'file-tree.create_file':
    case 'file-tree.create_directory':
    case 'file-tree.delete':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        (isFileTreeItemReference(action.target) ? valid() : invalid('target'))
      );
    case 'file-tree.copy':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        (isFileTreeItemReference(action.source)
          ? isFileTreeItemReference(action.target)
            ? action.conflict === undefined ||
              action.conflict === 'error' ||
              action.conflict === 'increment'
              ? valid()
              : invalid('conflict')
            : invalid('target')
          : invalid('source'))
      );
    case 'file-tree.move':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        (isFileTreeItemReference(action.source)
          ? isFileTreeItemReference(action.target)
            ? valid()
            : invalid('target')
          : invalid('source'))
      );
    case 'canopy_cloud.validate_api_key':
      return action.apiKey === undefined || typeof action.apiKey === 'string'
        ? valid()
        : invalid('apiKey');
    case 'canopy_cloud.save_api_key':
      return typeof action.apiKey === 'string' && action.apiKey.trim()
        ? valid()
        : missing('apiKey');
    case 'skills.open_viewer':
      return (
        requireStrings(action, ['sourceId', 'skillName']) ??
        optionalStrings(action, ['filePath']) ??
        valid()
      );
    case 'skills.open_shared_viewer':
    case 'skills.read_shared':
      return requireStrings(action, ['skillId']) ?? valid();
    case 'skills.list':
      return action.query === undefined || typeof action.query === 'string'
        ? action.customOnly === undefined ||
          typeof action.customOnly === 'boolean'
          ? action.limit === undefined ||
            (typeof action.limit === 'number' &&
              Number.isInteger(action.limit) &&
              action.limit >= 1 &&
              action.limit <= SKILL_LIST_MAX_LIMIT)
            ? valid()
            : invalid('limit')
          : invalid('customOnly')
        : invalid('query');
    case 'skills.read':
      return requireStrings(action, ['sourceId', 'skillName']) ?? valid();
    case 'skills.read_file':
      return (
        requireStrings(action, ['sourceId', 'skillName', 'filePath']) ?? valid()
      );
    case 'skills.create_custom':
      return (
        requireStrings(action, ['name', 'description', 'body']) ??
        validateOptionalStringRecord(action, 'extraMetadata') ??
        valid()
      );
    case 'skills.update_custom':
      return (
        requireStrings(action, ['originalName']) ??
        optionalStrings(action, ['name', 'description', 'body']) ??
        validateOptionalStringRecord(action, 'extraMetadata') ??
        (action.name !== undefined ||
        action.description !== undefined ||
        action.body !== undefined ||
        action.extraMetadata !== undefined
          ? valid()
          : missing('name, description, body, or extraMetadata'))
      );
    case 'skills.delete_custom':
      return requireStrings(action, ['name']) ?? valid();
    case 'skills.list_shared':
      return valid();
    case 'sharing.open_dialog':
      return sharingOpenDialogSchema.safeParse(action).success
        ? valid()
        : invalid('target');
    case 'skills.share_custom':
      return (
        requireStrings(action, ['name']) ??
        (isSelectableShareScope(action.shareScope)
          ? valid()
          : invalid('shareScope'))
      );
    case 'skills.import_shared':
      return requireStrings(action, ['skillId']) ?? valid();
    case 'skills.update_shared':
      return requireStrings(action, ['skillId', 'name']) ?? valid();
    case 'skills.delete_shared':
      return requireStrings(action, ['skillId']) ?? valid();
    case 'collections.open_manager':
      return valid();
    case 'collections.list':
      return valid();
    case 'collections.create':
      return requireStrings(action, ['name']) ?? valid();
    case 'collections.update':
      return requireStrings(action, ['id']) ?? valid();
    case 'collections.delete':
      return requireStrings(action, ['id']) ?? valid();
    case 'collections.share':
      return (
        requireStrings(action, ['id']) ??
        optionalStrings(action, ['teamId', 'organizationId']) ??
        (isSelectableShareScope(action.shareScope)
          ? valid()
          : invalid('shareScope'))
      );
    case 'collections.list_shared':
      return valid();
    case 'collections.import_shared':
      return requireStrings(action, ['collectionId']) ?? valid();
    case 'collections.update_shared':
      return requireStrings(action, ['collectionId', 'id']) ?? valid();
    case 'collections.delete_shared':
      return requireStrings(action, ['collectionId']) ?? valid();
    case 'agents.open_manager':
    case 'agents.list':
    case 'agents.list_shared':
      return valid();
    case 'agents.get':
    case 'agents.delete':
      return requireStrings(action, ['id']) ?? valid();
    case 'agents.create':
      return (
        requireStrings(action, ['name', 'baseModel', 'instructions']) ?? valid()
      );
    case 'agents.update':
      return (
        requireStrings(action, ['id']) ??
        optionalStrings(action, ['name', 'baseModel', 'instructions']) ??
        (action.name !== undefined ||
        action.baseModel !== undefined ||
        action.instructions !== undefined ||
        action.pluginSelections !== undefined
          ? valid()
          : missing('name, baseModel, instructions, or pluginSelections'))
      );
    case 'agents.import_shared':
    case 'agents.delete_shared':
    case 'agents.publish_public_share':
    case 'agents.revoke_public_share':
      return requireStrings(action, ['agentId']) ?? valid();
    case 'plugins.list_marketplaces':
      return (
        optionalStrings(action, ['query']) ??
        validateOptionalLimit(action, 'limit', CHAT_PLUGIN_LIST_MAX_LIMIT) ??
        valid()
      );
    case 'skills.list_marketplace':
      return (
        optionalStrings(action, ['query']) ??
        validateOptionalLimit(action, 'limit', CHAT_PLUGIN_LIST_MAX_LIMIT) ??
        valid()
      );
    case 'plugins.refresh_marketplace':
      return requireStrings(action, ['marketplaceId']) ?? valid();
    case 'plugins.remove_marketplace':
      return (
        requireStrings(action, ['marketplaceId']) ??
        validateOptionalProviderArray(action, 'providers') ??
        valid()
      );
    case 'workspace.open_add_dialog':
    case 'workspace.open_clone_progress':
    case 'org_project.list':
      return valid();
    case 'workspace.add_org_project':
      return requireStrings(action, ['projectId']) ?? valid();
    case 'org_project.setup_start':
    case 'org_project.setup_cancel':
      return requireStrings(action, ['projectId']) ?? valid();
    case 'org_project.open_move_to_organization':
      return requireStrings(action, ['workspaceId']) ?? valid();
    case 'org_project.create_cowork':
      return (
        requireStrings(action, ['name']) ??
        (typeof action.name !== 'string' ||
        action.name.trim().length === 0 ||
        action.name.trim().length > ORG_PROJECT_LIMITS.nameLength
          ? invalid('name')
          : valid())
      );
    case 'org_project.create_code':
      return (
        requireStrings(action, ['name']) ??
        (typeof action.name !== 'string' ||
        action.name.trim().length === 0 ||
        action.name.trim().length > ORG_PROJECT_LIMITS.nameLength
          ? invalid('name')
          : action.folderPath !== undefined &&
              (typeof action.folderPath !== 'string' ||
                action.folderPath.trim().length === 0)
            ? invalid('folderPath')
            : valid())
      );
    case 'workspace.create_multi_repo':
      return (
        requireStrings(action, ['name']) ??
        (typeof action.name !== 'string' ||
        action.name.trim().length === 0 ||
        action.name.trim().length > ORG_PROJECT_LIMITS.nameLength
          ? invalid('name')
          : valid())
      );
    case 'workspace.add_repo':
      return (
        requireNonBlankStrings(action, ['workspaceId', 'repoPath']) ??
        // Main checks the path against the host's own rules.
        (typeof action.repoPath === 'string' &&
        looksLikeAbsoluteLocalPath(action.repoPath)
          ? valid()
          : invalid('repoPath'))
      );
    case 'workspace.remove_repo':
      return (
        requireNonBlankStrings(action, ['workspaceId', 'repoId']) ?? valid()
      );
    case 'workspace.list_worktrees':
      return requireStrings(action, ['workspaceId']) ?? valid();
    case 'workspace.list_join_options':
    case 'workspace.list_existing_worktree_join_options':
      return (
        requireStrings(action, ['sourceWorkspaceId', 'sourceWorktreeId']) ??
        valid()
      );
    case 'worktree.select':
      return requireStrings(action, ['projectId', 'worktreeId']) ?? valid();
    case 'worktree.archive':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        (typeof action.deleteBranch !== 'boolean'
          ? invalid('deleteBranch')
          : action.mode !== undefined &&
              action.mode !== 'delete' &&
              action.mode !== 'archive'
            ? invalid('mode')
            : valid())
      );
    case 'worktree.create':
      return (
        requireStrings(action, ['workspaceId']) ??
        optionalNonEmptyStrings(action, ['baseWorktreeId', 'baseBranch']) ??
        (action.baseWorktreeId !== undefined && action.baseBranch !== undefined
          ? invalid('baseBranch')
          : action.select === undefined || typeof action.select === 'boolean'
            ? valid()
            : invalid('select'))
      );
    case 'worktree.create_from_link': {
      const required = requireStrings(action, ['url']);
      if (required) return required;
      if (
        typeof action.url !== 'string' ||
        !/^https?:\/\//i.test(action.url.trim()) ||
        action.url.trim().length > 2048
      )
        return invalid('url');
      const parsed = extractCreateFromReferences(action.url.trim());
      return parsed.complete &&
        parsed.references.length === 1 &&
        (action.prompt === undefined || typeof action.prompt === 'string')
        ? valid()
        : invalid('url');
    }
    case 'worktree.create_from':
      return (
        requireStrings(action, ['workspaceId', 'reference']) ??
        optionalNonEmptyStrings(action, ['baseBranch']) ??
        (action.source === 'branch' ||
        action.source === 'pr' ||
        action.source === 'linear'
          ? action.select === undefined || typeof action.select === 'boolean'
            ? valid()
            : invalid('select')
          : invalid('source'))
      );
    case 'worktree.set_notification_level':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        (action.level === 'all' ||
        action.level === 'attention' ||
        action.level === 'mute'
          ? valid()
          : invalid('level'))
      );
    case 'worktree.set_base_branch':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'baseBranch']) ??
        optionalNonEmptyStrings(action, ['baseBranch']) ??
        optionalStrings(action, ['repoId']) ??
        valid()
      );
    case 'worktree.resolve_branch_from_confirmation':
      return (
        requireStrings(action, ['confirmationId', 'projectId', 'worktreeId']) ??
        (action.choice === 'commit-first' ||
        action.choice === 'do-not-commit' ||
        action.choice === 'cancel'
          ? valid()
          : invalid('choice'))
      );
    case 'worktree.add_workspace': {
      const joinWorkspaceIds: string[] = [];
      if (isStringArray(action.joinWorkspaceIds)) {
        joinWorkspaceIds.push(...action.joinWorkspaceIds);
      }
      if (typeof action.joinWorkspaceId === 'string') {
        joinWorkspaceIds.push(action.joinWorkspaceId);
      }
      return (
        requireStrings(action, ['sourceWorkspaceId', 'sourceWorktreeId']) ??
        optionalStrings(action, ['joinWorkspaceId']) ??
        (action.joinWorkspaceIds === undefined ||
        isStringArray(action.joinWorkspaceIds)
          ? joinWorkspaceIds.length > 0
            ? action.mode === undefined ||
              action.mode === 'temporary' ||
              action.mode === 'update-source-workspace'
              ? action.select === undefined ||
                typeof action.select === 'boolean'
                ? valid()
                : invalid('select')
              : invalid('mode')
            : missing('joinWorkspaceId or joinWorkspaceIds')
          : invalid('joinWorkspaceIds'))
      );
    }
    case 'worktree.split_temporary_workspace': {
      const selectionsValid =
        action.selections === undefined ||
        (isRecord(action.selections) &&
          Object.values(action.selections).every(
            (selection) => selection === 'split' || selection === 'remove',
          ));
      return (
        requireStrings(action, ['workspaceId', 'worktreeId']) ??
        (selectionsValid
          ? action.rootAction === 'archive' || action.rootAction === 'delete'
            ? valid()
            : invalid('rootAction')
          : invalid('selections'))
      );
    }
    case 'worktree.add_existing_worktree':
      return (
        requireStrings(action, [
          'sourceWorkspaceId',
          'sourceWorktreeId',
          'joinWorkspaceId',
          'joinWorktreeId',
        ]) ??
        (action.mode === undefined ||
        action.mode === 'temporary' ||
        action.mode === 'update-source-workspace'
          ? action.select === undefined || typeof action.select === 'boolean'
            ? valid()
            : invalid('select')
          : invalid('mode'))
      );
    case 'worktree.get_settings':
      return requireStrings(action, ['projectId', 'worktreeId']) ?? valid();
    case 'worktree.update_settings':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        (action.hidden === undefined || typeof action.hidden === 'boolean'
          ? action.pausedHookKeys === undefined ||
            isStringArray(action.pausedHookKeys)
            ? action.branchGroupingOverride === undefined ||
              action.branchGroupingOverride === null ||
              action.branchGroupingOverride === 'group' ||
              action.branchGroupingOverride === 'ungroup'
              ? valid()
              : invalid('branchGroupingOverride')
            : invalid('pausedHookKeys')
          : invalid('hidden'))
      );
    case 'hook.pause':
    case 'hook.resume':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        optionalStrings(action, ['hookKey']) ??
        (action.all === undefined || typeof action.all === 'boolean'
          ? action.all === true || typeof action.hookKey === 'string'
            ? valid()
            : missing('hookKey or all')
          : invalid('all'))
      );
    case 'worktree.list_git_actions':
      return requireStrings(action, ['projectId', 'worktreeId']) ?? valid();
    case 'worktree.run_git_action':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'action']) ??
        (typeof action.action === 'string' &&
        WORKTREE_GIT_ACTIONS.has(action.action as WorktreeGitAction)
          ? action.repoIds === undefined || isStringArray(action.repoIds)
            ? valid()
            : invalid('repoIds')
          : invalid('action'))
      );
    case 'worktree.cancel_git_action':
      return requireStrings(action, ['projectId', 'worktreeId']) ?? valid();
    case 'worktree.start_merge_conflict_resolution':
    case 'worktree.start_pr_comment_triage':
    case 'worktree.start_ci_check_fix':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        optionalStrings(action, ['repoId', 'repoName', 'branchName']) ??
        valid()
      );
    case 'github.split_pr':
      return requireStrings(action, ['projectId', 'worktreeId']) ?? valid();
    case 'github.resolve_base_branch_alignment':
      return (
        requireStrings(action, ['confirmationId', 'projectId', 'worktreeId']) ??
        (action.choice === 'confirm' || action.choice === 'cancel'
          ? valid()
          : invalid('choice'))
      );
    case 'code_review.open':
      return requireStrings(action, ['projectId', 'worktreeId']) ?? valid();
    case 'runs.open_comments':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'chatId']) ?? valid()
      );
    case 'workspace.get_settings':
      return (
        requireStrings(action, ['workspaceId']) ??
        (action.worktreeId === undefined ||
        typeof action.worktreeId === 'string'
          ? action.includeClaudeMd === undefined ||
            typeof action.includeClaudeMd === 'boolean'
            ? valid()
            : invalid('includeClaudeMd')
          : invalid('worktreeId'))
      );
    case 'workspace.get_start_page':
      return (
        requireStrings(action, ['workspaceId']) ??
        optionalStrings(action, ['worktreeId']) ??
        valid()
      );
    case 'workspace.set_start_page':
      return (
        requireStrings(action, ['workspaceId']) ??
        (action.startPage === null || isProjectStartPage(action.startPage)
          ? valid()
          : invalid('startPage'))
      );
    case 'workspace.read_readiness':
      return (
        requireStrings(action, ['workspaceId']) ??
        optionalStrings(action, ['worktreeId']) ??
        valid()
      );
    case 'workspace.start_readiness_fix':
      return (
        requireStrings(action, ['workspaceId', 'issueCode']) ??
        optionalStrings(action, ['worktreeId', 'repoId']) ??
        (action.issueCode === 'configure-scripts' ||
        action.issueCode === 'configure-hooks' ||
        action.issueCode === 'configure-agent-instructions'
          ? valid()
          : invalid('issueCode'))
      );
    case 'workspace.update_local_settings':
      return (
        requireStrings(action, ['workspaceId']) ??
        validateOptionalArchiveDays(action, 'archiveRetentionDays') ??
        validateOptionalAutoArchiveDays(action, 'autoArchiveDays') ??
        validateOptionalBoolean(action, 'autoArchiveDeleteBranch') ??
        validateOptionalPluginSelections(action, 'defaultPluginSelections') ??
        validateOptionalObject(action, 'scripts') ??
        validateOptionalObject(action, 'hooks') ??
        validateOptionalRepoScriptChanges(action, 'repoScripts') ??
        validateOptionalRepoHookChanges(action, 'repoHooks') ??
        (action.alwaysShow === undefined ||
        typeof action.alwaysShow === 'boolean'
          ? valid()
          : invalid('alwaysShow'))
      );
    case 'workspace.apply_source_edits':
      return (
        requireStrings(action, ['workspaceId']) ??
        (action.worktreeId === undefined ||
        typeof action.worktreeId === 'string'
          ? action.createWorktree === undefined ||
            typeof action.createWorktree === 'boolean'
            ? action.claudeMd === undefined ||
              typeof action.claudeMd === 'string'
              ? (validateOptionalObject(action, 'scripts') ??
                validateOptionalObject(action, 'hooks') ??
                validateOptionalArray(action, 'plugins') ??
                validateOptionalRepoScriptChanges(
                  action,
                  'repoScriptChanges',
                ) ??
                validateOptionalRepoHookChanges(action, 'repoHookChanges') ??
                validateOptionalArray(action, 'repoAdds') ??
                validateOptionalStringArray(action, 'repoRemovals') ??
                valid())
              : invalid('claudeMd')
            : invalid('createWorktree')
          : invalid('worktreeId'))
      );
    case 'workspace.promote_temporary':
      return requireStrings(action, ['workspaceId', 'name']) ?? valid();
    case 'chat.open_import_session_modal':
      return optionalStrings(action, ['workspaceId']) ?? valid();
    case 'worktree-chat.open_tab':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        optionalStrings(action, ['chatId', 'initialMessage']) ??
        valid()
      );
    case 'worktree-chat.list_tabs':
    case 'worktree-chat.open_archives':
      return validateOptionalWorktreeScope(action) ?? valid();
    case 'worktree-chat.list_background_processes':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        optionalStrings(action, ['chatId']) ??
        valid()
      );
    case 'worktree-chat.stop_background_process':
      return (
        requireStrings(action, [
          'projectId',
          'worktreeId',
          'chatId',
          'taskId',
        ]) ?? valid()
      );
    case 'delegation.stop':
      return (
        requireStrings(action, [
          'projectId',
          'worktreeId',
          'chatId',
          'delegationId',
        ]) ?? valid()
      );
    case 'delegation.stop_all':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'chatId']) ?? valid()
      );
    case 'delegation.read_changes':
      return (
        requireStrings(action, [
          'projectId',
          'worktreeId',
          'delegationId',
          'revision',
        ]) ?? valid()
      );
    case 'worktree-chat.retry_state_refresh':
    case 'worktree-chat.dismiss_state_notice':
      return requireStrings(action, ['projectId', 'worktreeId']) ?? valid();
    case 'worktree-chat.switch_tab':
      return (
        requireStrings(action, ['tabId']) ??
        validateOptionalWorktreeScope(action) ??
        valid()
      );
    case 'worktree-chat.run_chat_action':
      return (
        validateOptionalChatHistoryTarget(action) ??
        (typeof action.action === 'string' &&
        WORKTREE_CHAT_ACTIONS.has(action.action)
          ? valid()
          : invalid('action'))
      );
    case 'worktree-chat.send_message':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'chatId', 'text']) ??
        (action.queueForSetup === undefined ||
        typeof action.queueForSetup === 'boolean'
          ? null
          : invalid('queueForSetup')) ??
        validateOptionalInlineWatchers(action) ??
        valid()
      );
    case 'worktree-chat.steer_queued_message':
      return (
        requireStrings(action, [
          'projectId',
          'worktreeId',
          'chatId',
          'queuedMessageId',
        ]) ?? valid()
      );
    case 'worktree-chat.schedule_message':
      return (
        requireStrings(action, [
          'projectId',
          'worktreeId',
          'chatId',
          'text',
          'runAt',
        ]) ??
        optionalStrings(action, ['name']) ??
        (action.timezone === undefined || action.timezone === 'local'
          ? null
          : invalid('timezone')) ??
        validateOptionalArray(action, 'fileReferences') ??
        validateOptionalStringArray(action, 'attachmentPaths') ??
        validateOptionalArray(action, 'attachmentPromptContexts') ??
        (action.inputMode === undefined ||
        action.inputMode === 'typed' ||
        action.inputMode === 'voice'
          ? valid()
          : invalid('inputMode'))
      );
    case 'worktree-chat.get_last_user_message':
    case 'worktree-chat.get_last_agent_response':
      return validateOptionalChatHistoryTarget(action) ?? valid();
    case 'worktree-chat.read_history':
      return (
        validateOptionalChatHistoryTarget(action) ??
        (action.query === undefined || typeof action.query === 'string'
          ? action.limit === undefined ||
            (typeof action.limit === 'number' &&
              Number.isInteger(action.limit) &&
              action.limit >= 1 &&
              action.limit <= CHAT_HISTORY_MAX_LIMIT)
            ? valid()
            : invalid('limit')
          : invalid('query'))
      );
    case 'worktree-chat.set_plan_mode':
    case 'worktree-chat.set_fast_mode':
      return (
        validateOptionalChatHistoryTarget(action) ??
        (typeof action.enabled === 'boolean' ? valid() : invalid('enabled'))
      );
    case 'worktree-chat.set_speed':
      return (
        validateOptionalChatHistoryTarget(action) ??
        (isCodexSpeed(action.speed) ? valid() : invalid('speed'))
      );
    case 'worktree-chat.set_interface_mode':
      return (
        validateOptionalChatHistoryTarget(action) ??
        (typeof action.mode === 'string' &&
        (action.mode === 'canopy' ||
          action.mode === 'claude-code' ||
          action.mode === 'auto')
          ? valid()
          : invalid('mode'))
      );
    case 'home.set_execution_harness':
      return action.executionHarness === 'claude' ||
        action.executionHarness === 'codex'
        ? valid()
        : invalid('executionHarness');
    case 'worktree-chat.set_model':
      if (
        action.executionHarness !== undefined &&
        action.executionHarness !== 'claude' &&
        action.executionHarness !== 'codex'
      )
        return invalid('executionHarness');
      return (
        validateOptionalChatHistoryTarget(action) ??
        (typeof action.model === 'string' && action.model.length > 0
          ? valid()
          : invalid('model'))
      );
    case 'worktree-chat.set_thinking_level':
      return (
        validateOptionalChatHistoryTarget(action) ??
        (typeof action.level === 'string' && isThinkingLevel(action.level)
          ? valid()
          : invalid('level'))
      );
    case 'worktree-chat.list_plugins':
      return (
        validateOptionalChatHistoryTarget(action) ??
        (action.query === undefined || typeof action.query === 'string'
          ? action.kind === undefined ||
            (typeof action.kind === 'string' && PLUGIN_KINDS.has(action.kind))
            ? action.limit === undefined ||
              (typeof action.limit === 'number' &&
                Number.isInteger(action.limit) &&
                action.limit >= 1 &&
                action.limit <= CHAT_PLUGIN_LIST_MAX_LIMIT)
              ? valid()
              : invalid('limit')
            : invalid('kind')
          : invalid('query'))
      );
    case 'worktree-chat.update_plugin_selection':
      return (
        validateOptionalChatHistoryTarget(action) ??
        (typeof action.kind === 'string' && PLUGIN_KINDS.has(action.kind)
          ? typeof action.key === 'string' && action.key.length > 0
            ? typeof action.enabled === 'boolean'
              ? valid()
              : invalid('enabled')
            : invalid('key')
          : invalid('kind'))
      );
    case 'worktree-chat.set_plugin_selections':
      return (
        validateOptionalChatHistoryTarget(action) ??
        validateOptionalPluginSelections(action, 'selections') ??
        (action.selections !== undefined ? valid() : missing('selections'))
      );
    case 'tracked-plan.list':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        optionalStrings(action, ['query']) ??
        (action.reviewStatus === undefined ||
        action.reviewStatus === 'pending' ||
        action.reviewStatus === 'approved' ||
        action.reviewStatus === 'dismissed'
          ? action.includeHidden === undefined ||
            typeof action.includeHidden === 'boolean'
            ? action.limit === undefined ||
              (typeof action.limit === 'number' &&
                Number.isInteger(action.limit) &&
                action.limit >= 1 &&
                action.limit <= TRACKED_PLAN_LIST_MAX_LIMIT)
              ? valid()
              : invalid('limit')
            : invalid('includeHidden')
          : invalid('reviewStatus'))
      );
    case 'tracked-plan.import':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'filePath']) ??
        valid()
      );
    case 'tracked-plan.get':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'planId']) ??
        (action.includeContent === undefined ||
        typeof action.includeContent === 'boolean'
          ? action.maxContentChars === undefined ||
            (typeof action.maxContentChars === 'number' &&
              Number.isInteger(action.maxContentChars) &&
              action.maxContentChars >= 1 &&
              action.maxContentChars <= TRACKED_PLAN_CONTENT_MAX_CHARS)
            ? valid()
            : invalid('maxContentChars')
          : invalid('includeContent'))
      );
    case 'tracked-plan.open_explore':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'planId']) ?? valid()
      );
    case 'tracked-plan.list_comment_threads':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'planId']) ??
        optionalStrings(action, ['query']) ??
        (action.status === undefined ||
        action.status === 'open' ||
        action.status === 'resolved'
          ? action.anchorState === undefined ||
            action.anchorState === 'matched' ||
            action.anchorState === 'outdated'
            ? action.staged === undefined || typeof action.staged === 'boolean'
              ? action.includeComments === undefined ||
                typeof action.includeComments === 'boolean'
                ? action.limit === undefined ||
                  (typeof action.limit === 'number' &&
                    Number.isInteger(action.limit) &&
                    action.limit >= 1 &&
                    action.limit <= TRACKED_PLAN_COMMENT_MAX_LIMIT)
                  ? valid()
                  : invalid('limit')
                : invalid('includeComments')
              : invalid('staged')
            : invalid('anchorState')
          : invalid('status'))
      );
    case 'tracked-plan.get_comment_thread':
      return (
        requireStrings(action, [
          'projectId',
          'worktreeId',
          'planId',
          'threadId',
        ]) ?? valid()
      );
    case 'pipeline-assistant-chat.list_tabs':
      return valid();
    case 'pipeline-assistant-chat.create_tab':
      return optionalStrings(action, ['initialMessage']) ?? valid();
    case 'pipeline-assistant-chat.switch_tab':
      return requireStrings(action, ['tabId']) ?? valid();
    case 'pipeline-assistant-chat.send_message':
      return requireStrings(action, ['chatId', 'text']) ?? valid();
    case 'pipeline-assistant-chat.get_last_user_message':
    case 'pipeline-assistant-chat.get_last_agent_response':
      return optionalStrings(action, ['chatId']) ?? valid();
    case 'pipeline-assistant-chat.read_history':
      return (
        optionalStrings(action, ['chatId', 'query']) ??
        (action.limit === undefined ||
        (typeof action.limit === 'number' &&
          Number.isInteger(action.limit) &&
          action.limit >= 1 &&
          action.limit <= CHAT_HISTORY_MAX_LIMIT)
          ? valid()
          : invalid('limit'))
      );
    case 'pipeline-assistant-chat.set_model':
      return (
        optionalStrings(action, ['chatId']) ??
        (typeof action.model === 'string' && action.model.length > 0
          ? valid()
          : invalid('model'))
      );
    case 'pipeline-assistant-chat.set_thinking_level':
      return (
        optionalStrings(action, ['chatId']) ??
        (typeof action.level === 'string' && isThinkingLevel(action.level)
          ? valid()
          : invalid('level'))
      );
    case 'pipeline-assistant-chat.list_plugins':
      return (
        optionalStrings(action, ['chatId', 'query']) ??
        (action.kind === undefined ||
        (typeof action.kind === 'string' && PLUGIN_KINDS.has(action.kind))
          ? action.limit === undefined ||
            (typeof action.limit === 'number' &&
              Number.isInteger(action.limit) &&
              action.limit >= 1 &&
              action.limit <= CHAT_PLUGIN_LIST_MAX_LIMIT)
            ? valid()
            : invalid('limit')
          : invalid('kind'))
      );
    case 'pipeline-assistant-chat.update_plugin_selection':
      return (
        optionalStrings(action, ['chatId']) ??
        (typeof action.kind === 'string' && PLUGIN_KINDS.has(action.kind)
          ? typeof action.key === 'string' && action.key.length > 0
            ? typeof action.enabled === 'boolean'
              ? valid()
              : invalid('enabled')
            : invalid('key')
          : invalid('kind'))
      );
    case 'pipeline-assistant-chat.set_plugin_selections':
      return (
        optionalStrings(action, ['chatId']) ??
        validateOptionalPluginSelections(action, 'selections') ??
        (action.selections !== undefined ? valid() : missing('selections'))
      );
    case 'standalone-chat.list_projects':
      return action.query === undefined || typeof action.query === 'string'
        ? action.includeDefault === undefined ||
          typeof action.includeDefault === 'boolean'
          ? action.limit === undefined ||
            (typeof action.limit === 'number' &&
              Number.isInteger(action.limit) &&
              action.limit >= 1 &&
              action.limit <= STANDALONE_LIST_MAX_LIMIT)
            ? valid()
            : invalid('limit')
          : invalid('includeDefault')
        : invalid('query');
    case 'standalone-chat.list_chats':
      return (
        optionalStrings(action, ['projectId', 'query', 'providerType']) ??
        (action.includeArchived === undefined ||
        typeof action.includeArchived === 'boolean'
          ? action.providerType === undefined ||
            (typeof action.providerType === 'string' &&
              AGENT_PROVIDER_TYPES.has(action.providerType))
            ? action.limit === undefined ||
              (typeof action.limit === 'number' &&
                Number.isInteger(action.limit) &&
                action.limit >= 1 &&
                action.limit <= STANDALONE_LIST_MAX_LIMIT)
              ? valid()
              : invalid('limit')
            : invalid('providerType')
          : invalid('includeArchived'))
      );
    case 'standalone-chat.switch_project':
      return requireStrings(action, ['projectId']) ?? valid();
    case 'standalone-chat.switch_chat':
      return (
        requireStrings(action, ['chatId']) ??
        optionalStrings(action, ['projectId']) ??
        valid()
      );
    case 'standalone-chat.create_chat':
      return requireStrings(action, ['projectId']) ?? valid();
    case 'standalone-chat.rename_work_entry':
      return (
        requireStrings(action, ['projectId', 'workEntryId']) ??
        (action.title === null || typeof action.title === 'string'
          ? valid()
          : invalid('title'))
      );
    case 'standalone-chat.delete_work_entry':
      return requireStrings(action, ['projectId', 'workEntryId']) ?? valid();
    case 'standalone-chat.send_message':
      return (
        requireStrings(action, ['projectId', 'chatId', 'text']) ??
        validateOptionalInlineWatchers(action) ??
        valid()
      );
    case 'standalone-chat.get_last_user_message':
    case 'standalone-chat.get_last_agent_response':
      return requireStrings(action, ['projectId', 'chatId']) ?? valid();
    case 'standalone-chat.read_history':
      return (
        requireStrings(action, ['projectId', 'chatId']) ??
        (action.query === undefined || typeof action.query === 'string'
          ? action.limit === undefined ||
            (typeof action.limit === 'number' &&
              Number.isInteger(action.limit) &&
              action.limit >= 1 &&
              action.limit <= CHAT_HISTORY_MAX_LIMIT)
            ? valid()
            : invalid('limit')
          : invalid('query'))
      );
    case 'standalone-chat.set_model':
      return (
        requireStrings(action, ['projectId', 'chatId', 'model']) ?? valid()
      );
    case 'standalone-chat.set_thinking_level':
      return (
        requireStrings(action, ['projectId', 'chatId']) ??
        (typeof action.level === 'string' && isThinkingLevel(action.level)
          ? valid()
          : invalid('level'))
      );
    case 'standalone-chat.list_plugins':
      return (
        optionalStrings(action, ['projectId', 'chatId', 'query']) ??
        (action.kind === undefined ||
        (typeof action.kind === 'string' && PLUGIN_KINDS.has(action.kind))
          ? action.limit === undefined ||
            (typeof action.limit === 'number' &&
              Number.isInteger(action.limit) &&
              action.limit >= 1 &&
              action.limit <= CHAT_PLUGIN_LIST_MAX_LIMIT)
            ? valid()
            : invalid('limit')
          : invalid('kind'))
      );
    case 'standalone-chat.update_plugin_selection':
      return (
        requireStrings(action, ['projectId', 'chatId', 'kind', 'key']) ??
        (typeof action.kind === 'string' && PLUGIN_KINDS.has(action.kind)
          ? typeof action.enabled === 'boolean'
            ? valid()
            : invalid('enabled')
          : invalid('kind'))
      );
    case 'standalone-chat.set_plugin_selections':
      return (
        requireStrings(action, ['projectId', 'chatId']) ??
        validateOptionalPluginSelections(action, 'selections') ??
        (action.selections !== undefined ? valid() : missing('selections'))
      );
    case 'standalone-chat.list_prompts':
    case 'standalone-chat.list_notes':
    case 'standalone-chat.list_attachments':
      return (
        requireStrings(action, ['projectId']) ??
        optionalStrings(action, ['query']) ??
        (action.limit === undefined ||
        (typeof action.limit === 'number' &&
          Number.isInteger(action.limit) &&
          action.limit >= 1 &&
          action.limit <= STANDALONE_LIST_MAX_LIMIT)
          ? valid()
          : invalid('limit'))
      );
    case 'standalone-chat.get_prompt':
      return requireStrings(action, ['projectId', 'promptId']) ?? valid();
    case 'standalone-chat.get_note':
      return requireStrings(action, ['projectId', 'noteId']) ?? valid();
    case 'standalone-chat.get_attachment':
      return (
        requireStrings(action, ['projectId', 'attachmentId']) ??
        (action.includeContent === undefined ||
        typeof action.includeContent === 'boolean'
          ? valid()
          : invalid('includeContent'))
      );
    case 'standalone-chat.get_settings':
      return (
        requireStrings(action, ['projectId']) ??
        (action.includeClaudeMd === undefined ||
        typeof action.includeClaudeMd === 'boolean'
          ? valid()
          : invalid('includeClaudeMd'))
      );
    case 'archived.list':
    case 'archived.open_overview':
    case 'archived.open_empty_trash':
      return requireStrings(action, ['workspaceId']) ?? valid();
    case 'archived.open':
      return (
        requireStrings(action, ['workspaceId', 'containerId']) ??
        optionalStrings(action, ['chatId', 'planId']) ??
        (action.tab === undefined ||
        action.tab === 'chats' ||
        action.tab === 'pipelines' ||
        action.tab === 'attachments' ||
        action.tab === 'plans' ||
        action.tab === 'changes'
          ? valid()
          : invalid('tab'))
      );
    case 'archived.read_chat':
      return (
        requireStrings(action, ['workspaceId', 'containerId', 'chatId']) ??
        (action.limit === undefined ||
        (typeof action.limit === 'number' &&
          Number.isInteger(action.limit) &&
          action.limit >= 1 &&
          action.limit <= 100)
          ? valid()
          : invalid('limit'))
      );
    case 'archived.restore':
      return requireStrings(action, ['workspaceId', 'containerId']) ?? valid();
    case 'archived.set_locked':
      return (
        requireStrings(action, ['workspaceId', 'containerId']) ??
        (typeof action.locked === 'boolean' ? valid() : invalid('locked'))
      );
    case 'standalone-chat.update_settings':
      return (
        requireStrings(action, ['projectId']) ??
        optionalStrings(action, [
          'name',
          'description',
          'color',
          'defaultModel',
          'defaultPresetId',
          'claudeMd',
        ]) ??
        validateOptionalPluginSelections(action, 'defaultPluginSelections') ??
        validateOptionalArray(action, 'presets') ??
        validateOptionalBoolean(action, 'alwaysShow') ??
        validateOptionalAutoArchiveDays(action, 'autoArchiveDays') ??
        (action.archiveRetentionDays === undefined ||
        action.archiveRetentionDays === null ||
        (typeof action.archiveRetentionDays === 'number' &&
          Number.isInteger(action.archiveRetentionDays) &&
          action.archiveRetentionDays >= 0 &&
          action.archiveRetentionDays <= MAX_ARCHIVE_RETENTION_DAYS)
          ? valid()
          : invalid('archiveRetentionDays'))
      );
    case 'environment.update_workspace_assignment': {
      const required = requireStrings(action, ['workspaceId']);
      if (required) return required;
      const runtimes = action.runtimes;
      if (
        !isRecord(runtimes) ||
        Object.keys(runtimes).some((key) => !ENVIRONMENT_RUNTIME_KEYS.has(key))
      ) {
        return invalid('runtimes');
      }
      for (const runtime of ENVIRONMENT_RUNTIMES) {
        const value = runtimes[runtime];
        if (
          value !== undefined &&
          value !== null &&
          (typeof value !== 'string' || value.trim().length === 0)
        ) {
          return invalid(`runtimes.${runtime}`);
        }
      }
      return valid();
    }
    case 'pipeline.open_editor':
      if (
        action.section !== undefined &&
        !isKnownString(action.section, WORKFLOW_EDIT_SECTION_SET)
      ) {
        return invalid('section');
      }
      return action.pipelineId === undefined ||
        typeof action.pipelineId === 'string'
        ? (optionalStrings(action, [
            'cwd',
            'filePath',
            'projectId',
            'worktreeId',
            'repoId',
            'sharedRemoteId',
          ]) ?? valid())
        : invalid('pipelineId');
    case 'pipeline.open_curated_preview':
      return typeof action.key === 'string' && isCuratedCatalogKey(action.key)
        ? valid()
        : invalid('key');
    case 'pipeline.create':
      return (
        optionalStrings(action, [
          'rawYaml',
          'yamlFilePath',
          'name',
          'description',
          'icon',
        ]) ??
        (action.rawYaml || action.yamlFilePath
          ? valid()
          : invalid('rawYaml or yamlFilePath'))
      );
    case 'pipeline.update':
      return (
        requireStrings(action, ['pipelineId']) ??
        optionalStrings(action, [
          'rawYaml',
          'yamlFilePath',
          'name',
          'description',
          'icon',
        ]) ??
        (action.rawYaml ||
        action.yamlFilePath ||
        action.name !== undefined ||
        action.description !== undefined ||
        action.icon !== undefined
          ? valid()
          : missing('rawYaml, yamlFilePath, or metadata override'))
      );
    case 'pipeline.delete':
      return requireStrings(action, ['pipelineId']) ?? valid();
    case 'pipeline.duplicate':
      return (
        requireStrings(action, ['pipelineId']) ??
        validateOptionalWorktreeScope(action) ??
        valid()
      );
    case 'pipeline.share':
      return (
        requireStrings(action, ['pipelineId']) ??
        validateOptionalWorktreeScope(action) ??
        optionalStrings(action, ['teamId', 'organizationId']) ??
        (isSelectableShareScope(action.shareScope)
          ? // `deleteLocal` still validates so older payloads are accepted;
            // its value is ignored because sharing keeps the local pipeline.
            (validateOptionalBoolean(action, 'deleteLocal') ?? valid())
          : invalid('shareScope'))
      );
    case 'pipeline.update_shared':
      return (
        optionalStrings(action, [
          'pipelineId',
          'remoteId',
          'rawYaml',
          'name',
          'description',
          'icon',
        ]) ??
        (action.pipelineId || action.remoteId
          ? action.rawYaml ||
            action.name !== undefined ||
            action.description !== undefined ||
            action.icon !== undefined
            ? valid()
            : missing('rawYaml or metadata override')
          : missing('pipelineId or remoteId'))
      );
    case 'pipeline.delete_shared':
      return (
        optionalStrings(action, ['pipelineId', 'remoteId']) ??
        (action.pipelineId || action.remoteId
          ? valid()
          : missing('pipelineId or remoteId'))
      );
    case 'pipeline.set_enabled':
      return (
        requireStrings(action, ['pipelineId']) ??
        (typeof action.enabled === 'boolean' ? valid() : invalid('enabled'))
      );
    case 'pipeline.list':
      return (
        validateOptionalWorktreeScope(action) ??
        optionalStrings(action, ['query']) ??
        validateOptionalRunModeArray(action, 'runModes') ??
        validateOptionalBoolean(action, 'includeDisabled') ??
        validateOptionalLimit(action, 'limit', PIPELINE_LIST_MAX_LIMIT) ??
        valid()
      );
    case 'pipeline.get':
      return (
        requireStrings(action, ['pipelineId']) ??
        validateOptionalWorktreeScope(action) ??
        (action.includeYaml === undefined ||
        typeof action.includeYaml === 'boolean'
          ? valid()
          : invalid('includeYaml'))
      );
    case 'pipeline.open_run':
      return (
        requireStrings(action, ['executionId']) ??
        optionalStrings(action, ['jobId', 'projectId', 'worktreeId']) ??
        // An owner hint names both halves or neither.
        ((action.projectId === undefined) !== (action.worktreeId === undefined)
          ? invalid(action.projectId === undefined ? 'projectId' : 'worktreeId')
          : valid())
      );
    case 'pipeline.debug_run':
      return requireStrings(action, ['executionId']) ?? valid();
    case 'pipeline.execution_list_for_worktree':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        optionalStrings(action, ['query', 'pipelineId']) ??
        validateOptionalExecutionStatus(action, 'status') ??
        validateOptionalLimit(
          action,
          'limit',
          PIPELINE_EXECUTION_LIST_MAX_LIMIT,
        ) ??
        valid()
      );
    case 'pipeline.execution_list':
      return (
        validateOptionalWorktreeScope(action) ??
        optionalStrings(action, ['query', 'pipelineId']) ??
        (action.runOn === undefined ||
        action.runOn === 'local' ||
        action.runOn === 'cloud'
          ? null
          : invalid('runOn')) ??
        validateOptionalExecutionStatus(action, 'status') ??
        validateOptionalLimit(
          action,
          'limit',
          PIPELINE_EXECUTION_LIST_MAX_LIMIT,
        ) ??
        valid()
      );
    case 'pipeline.execution_get':
      return (
        requireStrings(action, ['executionId']) ??
        validateOptionalBoolean(action, 'includeReport') ??
        validateOptionalBoolean(action, 'includePlan') ??
        validateOptionalLimit(action, 'maxChars', PIPELINE_CONTENT_MAX_CHARS) ??
        valid()
      );
    case 'pipeline.execution_resume':
      return (
        validateRequiredPipelineExecutionId(action, 'executionId') ??
        (action.statusReasonIds === undefined &&
        action.pauseResponses === undefined
          ? invalid('statusReasonIds or pauseResponses')
          : null) ??
        (action.statusReasonIds === undefined
          ? null
          : validateRequiredUniqueStringArray(action, 'statusReasonIds')) ??
        validateOptionalPauseResponses(action, 'pauseResponses') ??
        valid()
      );
    case 'pipeline.execution_cancel':
    case 'pipeline.execution_retry':
    case 'pipeline.execution_start_over':
      return requireStrings(action, ['executionId']) ?? valid();
    case 'pipeline.execution_retry_matrix_job':
      return (
        requireStrings(action, ['executionId', 'jobId', 'mode']) ??
        (action.mode === 'all' ||
        action.mode === 'failed' ||
        action.mode === 'expansion' ||
        (action.mode === 'variants' &&
          Array.isArray(action.variantJobIds) &&
          action.variantJobIds.length > 0 &&
          action.variantJobIds.every(
            (variantJobId) =>
              typeof variantJobId === 'string' && variantJobId.trim() !== '',
          ))
          ? valid()
          : invalid('mode'))
      );
    case 'pipeline.execution_cancel_matrix_variant':
      return (
        requireStrings(action, ['executionId', 'jobId', 'variantJobId']) ??
        valid()
      );
    case 'pipeline.execution_read_report':
      return (
        requireStrings(action, ['executionId']) ??
        (action.kind === undefined ||
        action.kind === 'text' ||
        action.kind === 'json'
          ? (validateOptionalLimit(
              action,
              'maxChars',
              PIPELINE_CONTENT_MAX_CHARS,
            ) ?? valid())
          : invalid('kind'))
      );
    case 'pipeline.execution_read_plan':
      return (
        requireStrings(action, ['executionId']) ??
        validateOptionalLimit(action, 'maxChars', PIPELINE_CONTENT_MAX_CHARS) ??
        valid()
      );
    case 'pipeline.execution_send_report_to_chat':
    case 'pipeline.execution_send_plan_to_chat':
      return (
        requireStrings(action, ['executionId']) ??
        optionalStrings(action, ['chatId', 'prompt']) ??
        valid()
      );
    case 'pipeline.execution_chain':
      return (
        requireStrings(action, ['executionId', 'pipelineId']) ??
        (action.inputs === undefined || isStringRecord(action.inputs)
          ? (optionalStrings(action, ['repoId']) ?? valid())
          : invalid('inputs'))
      );
    case 'browser.list':
    case 'browser.open':
    case 'browser.navigate':
    case 'browser.back':
    case 'browser.forward':
    case 'browser.reload':
    case 'browser.stop':
    case 'browser.get_dialog':
    case 'browser.handle_dialog':
    case 'browser.click':
    case 'browser.fill':
    case 'browser.set_checked':
    case 'browser.select_option':
    case 'browser.type':
    case 'browser.press':
    case 'browser.hover':
    case 'browser.scroll':
    case 'browser.drag':
    case 'browser.focus':
    case 'browser.wait_for':
    case 'browser.screenshot':
    case 'browser.input_snapshot':
    case 'browser.inspect':
    case 'browser.get_console':
    case 'browser.get_network':
    case 'browser.list_transfers':
    case 'browser.cancel_transfer':
    case 'browser.save_download':
    case 'browser.save_pdf':
    case 'browser.upload_files':
    case 'browser.request_files':
    case 'browser.drop_files':
    case 'browser.start_recording':
    case 'browser.stop_recording':
    case 'browser.open_external': {
      // The sign-in refusal answers before any schema rule, so an agent
      // learns why rather than being sent to fetch a runtime generation.
      const projectId = readString(action, 'projectId');
      const worktreeId = readString(action, 'worktreeId');
      if (
        projectId &&
        worktreeId &&
        isMcpOAuthBrowserScope(projectId, worktreeId)
      ) {
        return { ok: false, message: SIGN_IN_PAGES_PRIVATE_MESSAGE };
      }
      const parsed = parseAdvisorBrowserAction(
        action,
        RENDERER_BROWSER_ADVISOR_SCOPE_SHAPE,
      );
      return parsed.ok
        ? { ok: true, action: parsed.action }
        : { ok: false, message: parsed.message };
    }
    case 'file.open':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'path']) ??
        (action.repoId === undefined || typeof action.repoId === 'string'
          ? valid()
          : invalid('repoId'))
      );
    case 'file.send_selection_to_chat':
      return valid();
    case 'terminal.open':
      return requireStrings(action, ['projectId', 'worktreeId']) ?? valid();
    case 'terminal.close':
      return action.sessionId === undefined ||
        typeof action.sessionId === 'string'
        ? valid()
        : invalid('sessionId');
    case 'panel.split':
      return (
        optionalStrings(action, ['groupId']) ??
        (isKnownString(action.direction, PANEL_SPLIT_DIRECTIONS)
          ? valid()
          : invalid('direction'))
      );
    case 'panel.set_layout_mode':
      return action.mode === 'minimal' || action.mode === 'advanced'
        ? valid()
        : invalid('mode');
    case 'panel.focus':
      return requireStrings(action, ['groupId']) ?? valid();
    case 'panel.close':
      return optionalStrings(action, ['groupId']) ?? valid();
    case 'panel.reset_layout':
      return valid();
    case 'panel.maximize':
      return (
        optionalStrings(action, ['groupId']) ??
        (typeof action.maximized === 'boolean' ? valid() : invalid('maximized'))
      );
    case 'panel.add_tab': {
      const invalidGroup = optionalStrings(action, ['groupId']);
      if (invalidGroup) return invalidGroup;
      if (!isKnownString(action.kind, PANEL_KIND_SET)) return invalid('kind');
      switch (action.kind) {
        case 'pipeline-execution':
          // A run panel is bound to one execution and is opened from that
          // run; it is never offered as an addable tab (see the
          // `PanelAddTabAction` type, which excludes the kind).
          return {
            ok: false,
            message:
              'Action panel.add_tab cannot add a pipeline-execution panel. Use pipeline.open_run to show a run.',
          };
        case 'subagent-chat':
          // A subagent chat is opened from its subagent, never as an
          // unbound tab or through an App Advisor panel action.
          return {
            ok: false,
            message:
              'Action panel.add_tab cannot add a subagent-chat panel. A subagent chat opens from its subagent.',
          };
        case 'chat':
        case 'chat-visuals':
          return requireStrings(action, ['chatTabId']) ?? valid();
        case 'file-diff': {
          const invalidBinding = optionalStrings(action, [
            'fileTabId',
            'filePath',
          ]);
          if (invalidBinding) return invalidBinding;
          return valid();
        }
        case 'activity-card':
          return requireStrings(action, ['sectionId']) ?? valid();
        case 'usage':
          return isUsagePanelVariant(
            typeof action.variant === 'string' ? action.variant : undefined,
          )
            ? valid()
            : invalid('variant');
        case 'automations':
          return isAutomationsPanelVariant(
            typeof action.variant === 'string' ? action.variant : undefined,
          )
            ? valid()
            : invalid('variant');
        case 'plan':
        case 'plan-diagram':
          // Plan panels bind a tracked plan and open through the plan
          // opener (reveal-or-create), never as a raw tab add.
          return requireStrings(action, ['planId']) ?? valid();
        case 'session-breakdown':
          // Bound to one chat; opened through the cost opener
          // (reveal-or-create), like plan panels.
          return requireStrings(action, ['chatId']) ?? valid();
        default:
          return action.chatTabId === undefined &&
            action.fileTabId === undefined &&
            action.filePath === undefined &&
            action.sectionId === undefined &&
            action.variant === undefined &&
            action.planId === undefined &&
            action.chatId === undefined
            ? valid()
            : invalid('instance binding');
      }
    }
    case 'ledger.open':
      return (
        validateOptionalWorktreeScope(action) ??
        optionalStrings(action, ['entryId']) ??
        valid()
      );
    case 'ledger.search':
      return (
        validateOptionalWorktreeScope(action) ??
        optionalStrings(action, ['query']) ??
        validateOptionalKnownStringArray(
          action,
          'types',
          LEDGER_ENTRY_TYPE_SET,
        ) ??
        validateOptionalKnownStringArray(
          action,
          'statuses',
          LEDGER_STATUS_SET,
        ) ??
        validateOptionalLimit(action, 'limit', LEDGER_SEARCH_LIMIT_MAX) ??
        valid()
      );
    case 'ledger.add_entry':
      return (
        validateOptionalWorktreeScope(action) ??
        requireStrings(action, ['title', 'content']) ??
        (isKnownString(action.entryType, LEDGER_PUBLIC_ENTRY_TYPE_SET)
          ? null
          : invalid('entryType')) ??
        (action.status === undefined ||
        isKnownString(action.status, LEDGER_STATUS_SET)
          ? null
          : invalid('status')) ??
        validateOptionalStringArray(action, 'highlights') ??
        (Array.isArray(action.highlights) &&
        action.highlights.length > LEDGER_HIGHLIGHTS_MAX
          ? invalid('highlights')
          : null) ??
        optionalStrings(action, ['supersedesEntryId']) ??
        valid()
      );
    case 'panel.move':
      return (
        requireStrings(action, ['panelId', 'targetGroupId']) ??
        (isKnownString(action.edge, PANEL_DROP_EDGES)
          ? valid()
          : invalid('edge'))
      );
    case 'panel.arrange':
      return action.arrangement === 'even' ? valid() : invalid('arrangement');
    case 'panel.save_default_layout':
      return valid();
    case 'canopy_portal.start':
      return valid();
    // ------------------------------------------------------------------
    // Automations actions: shape-validate the request envelope so the
    // dispatcher's switch lands in the matching `automation.*` case below.
    // We intentionally keep the validation light — the main-process
    // automations service is the single source of truth for schedule /
    // action shape, and the renderer ferries the payload verbatim through
    // `window.api.automations.*`.
    // ------------------------------------------------------------------
    case 'automation.list':
      return action.includeRuns === undefined ||
        typeof action.includeRuns === 'boolean'
        ? valid()
        : invalid('includeRuns');
    case 'automation.get':
      return requireStrings(action, ['id']) ?? valid();
    case 'automation.open_editor':
      if (
        action.section !== undefined &&
        !isKnownString(action.section, WORKFLOW_EDIT_SECTION_SET)
      ) {
        return invalid('section');
      }
      return requireStrings(action, ['id']) ?? valid();
    case 'agents.open_editor': {
      if (action.source !== 'local' && action.source !== 'shared') {
        return invalid('source');
      }
      const target = normalizeAgentArtifactNavigationRequest({
        kind: action.source === 'local' ? 'agent_editor' : 'shared_agent',
        agentId: action.agentId,
      });
      return target !== null ? valid() : invalid('agentId');
    }
    case 'capabilities.open_entry': {
      const target = normalizeAgentArtifactNavigationRequest({
        kind: 'capability_entry',
        entry: action.entry,
      });
      return target?.kind === 'capability_entry'
        ? { ok: true, action: { type, entry: target.entry } }
        : invalid('entry');
    }
    case 'automation.open_shared_pipeline_review':
      return requireStrings(action, ['id']) ?? valid();
    case 'automation.create':
      return isRecord(action.input) ? valid() : invalid('input');
    case 'automation.update':
      return (
        requireStrings(action, ['id']) ??
        (isRecord(action.patch) ? valid() : invalid('patch'))
      );
    case 'automation.disable':
    case 'automation.delete':
    case 'automation.run_now':
      return requireStrings(action, ['id']) ?? valid();
    case 'automation.share':
      return (
        requireStrings(action, ['id']) ??
        optionalStrings(action, ['teamId', 'organizationId', 'description']) ??
        (action.shareScope === undefined ||
        isSelectableShareScope(action.shareScope)
          ? valid()
          : invalid('shareScope'))
      );
    case 'automation.list_shared':
      return (
        optionalStrings(action, ['query', 'cursor']) ??
        validateOptionalLimit(
          action,
          'limit',
          SHARED_AUTOMATION_LIST_MAX_LIMIT,
        ) ??
        (action.createdBy === undefined ||
        action.createdBy === 'me' ||
        action.createdBy === 'anyone'
          ? valid()
          : invalid('createdBy'))
      );
    case 'automation.read_shared':
    case 'automation.unshare':
      return requireStrings(action, ['automationId']) ?? valid();
    case 'plan.share':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'planId']) ??
        optionalStrings(action, ['teamId', 'organizationId']) ??
        (isSelectableShareScope(action.shareScope)
          ? valid()
          : invalid('shareScope'))
      );
    case 'plan.unshare':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'planId']) ?? valid()
      );
    case 'runs.share':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'chatId']) ??
        (isSelectableShareScope(action.shareScope)
          ? null
          : invalid('shareScope')) ??
        optionalStrings(action, ['teamId', 'organizationId']) ??
        valid()
      );
    case 'runs.unshare':
      return (
        requireStrings(action, ['projectId', 'worktreeId', 'chatId']) ?? valid()
      );
    case 'shared-containers.open_invite':
      return (
        requireStrings(action, ['projectId', 'worktreeId']) ??
        (action.containerType !== 'CODE_WORKTREE' &&
        action.containerType !== 'COWORK_WORK_ENTRY'
          ? invalid('containerType')
          : action.audience !== undefined &&
              action.audience !== 'team' &&
              action.audience !== 'organization' &&
              action.audience !== 'public'
            ? invalid('audience')
            : valid())
      );
    case 'shared-containers.revoke_recipient':
      // `organizationId` is absent for a personal container.
      return (
        requireStrings(action, ['containerId', 'recipientId']) ??
        optionalStrings(action, ['organizationId']) ??
        valid()
      );
    case 'shared-containers.open_received':
      return (
        requireStrings(action, ['containerId']) ??
        optionalStrings(action, ['organizationId']) ??
        valid()
      );
    case 'shared-containers.retry_received':
      return requireStrings(action, ['containerId']) ?? valid();
    default:
      return { ok: false, message: `Unsupported action type ${type}.` };
  }

  function requireStrings(
    record: Record<string, unknown>,
    fields: string[],
  ): ActionValidationResult | null {
    const missingFields = fields.filter((field) => !readString(record, field));
    return missingFields.length > 0 ? missing(...missingFields) : null;
  }

  function requireNonBlankStrings(
    record: Record<string, unknown>,
    fields: string[],
  ): ActionValidationResult | null {
    const required = requireStrings(record, fields);
    if (required) return required;
    const blankField = fields.find(
      (field) => readString(record, field)?.trim().length === 0,
    );
    return blankField ? invalid(blankField) : null;
  }

  function optionalStrings(
    record: Record<string, unknown>,
    fields: string[],
  ): ActionValidationResult | null {
    const invalidField = fields.find(
      (field) =>
        record[field] !== undefined && typeof record[field] !== 'string',
    );
    return invalidField ? invalid(invalidField) : null;
  }

  function optionalNonEmptyStrings(
    record: Record<string, unknown>,
    fields: string[],
  ): ActionValidationResult | null {
    const invalidField = fields.find(
      (field) =>
        record[field] !== undefined &&
        (typeof record[field] !== 'string' ||
          record[field].trim().length === 0),
    );
    return invalidField ? invalid(invalidField) : null;
  }

  function validateRequiredPipelineExecutionId(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    const value = readString(record, field);
    return value && /^[a-z0-9][a-z0-9-]*$/.test(value) ? null : invalid(field);
  }

  function validateOptionalObject(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    return record[field] === undefined || isRecord(record[field])
      ? null
      : invalid(field);
  }

  function validateOptionalArray(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    return record[field] === undefined || Array.isArray(record[field])
      ? null
      : invalid(field);
  }

  function validateOptionalStringArray(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    return record[field] === undefined || isStringArray(record[field])
      ? null
      : invalid(field);
  }

  function validateRequiredUniqueStringArray(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    const value = record[field];
    if (!Array.isArray(value) || value.length === 0) return invalid(field);
    if (
      !value.every((entry) => typeof entry === 'string' && entry.length > 0)
    ) {
      return invalid(field);
    }
    return new Set(value).size === value.length ? null : invalid(field);
  }

  function validateOptionalPauseResponses(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    const value = record[field];
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length === 0) return invalid(field);
    const validResponses = value.every((entry) => {
      if (!isRecord(entry)) return false;
      if (!readString(entry, 'jobId') || !readString(entry, 'stepId')) {
        return false;
      }
      if (
        entry.checkpointId !== undefined &&
        typeof entry.checkpointId !== 'string'
      ) {
        return false;
      }
      if (entry.answers === undefined) return true;
      return (
        isRecord(entry.answers) &&
        Object.values(entry.answers).every(
          (answer) =>
            typeof answer === 'string' ||
            typeof answer === 'number' ||
            typeof answer === 'boolean',
        )
      );
    });
    return validResponses ? null : invalid(field);
  }

  function validateOptionalProviderArray(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    if (record[field] === undefined) return null;
    if (!Array.isArray(record[field])) return invalid(field);
    return record[field].every(
      (entry) => typeof entry === 'string' && PLUGIN_PROVIDERS.has(entry),
    )
      ? null
      : invalid(field);
  }

  function validateOptionalStringRecord(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    return record[field] === undefined || isStringRecord(record[field])
      ? null
      : invalid(field);
  }

  function validateOptionalInlineWatchers(
    record: Record<string, unknown>,
  ): ActionValidationResult | null {
    if (record.watchers === undefined) return null;
    if (!Array.isArray(record.watchers) || record.watchers.length > 10) {
      return invalid('watchers');
    }
    for (const watcher of record.watchers) {
      if (!isRecord(watcher)) return invalid('watchers');
      if (watcher.label !== undefined && typeof watcher.label !== 'string') {
        return invalid('watchers');
      }
      if (
        watcher.followUpInstruction !== undefined &&
        typeof watcher.followUpInstruction !== 'string'
      ) {
        return invalid('watchers');
      }
      if (
        watcher.allowDuplicate !== undefined &&
        typeof watcher.allowDuplicate !== 'boolean'
      ) {
        return invalid('watchers');
      }
      if (
        watcher.terminalStatuses !== undefined &&
        (!Array.isArray(watcher.terminalStatuses) ||
          watcher.terminalStatuses.some(
            (status) =>
              status !== 'success' &&
              status !== 'failure' &&
              status !== 'cancelled',
          ))
      ) {
        return invalid('watchers');
      }
    }
    return null;
  }

  function validateOptionalPluginSelections(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    if (record[field] === undefined) return null;
    return parseSelections(record[field]) ? null : invalid(field);
  }

  function validateOptionalBoolean(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    return record[field] === undefined || typeof record[field] === 'boolean'
      ? null
      : invalid(field);
  }

  function validateOptionalArchiveDays(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    const value = record[field];
    return value === undefined ||
      value === null ||
      (typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_ARCHIVE_RETENTION_DAYS)
      ? null
      : invalid(field);
  }

  function validateOptionalAutoArchiveDays(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    const value = record[field];
    return value === undefined ||
      value === null ||
      (typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= MAX_ARCHIVE_RETENTION_DAYS)
      ? null
      : invalid(field);
  }

  function validateOptionalLimit(
    record: Record<string, unknown>,
    field: string,
    max: number,
  ): ActionValidationResult | null {
    return record[field] === undefined ||
      (typeof record[field] === 'number' &&
        Number.isInteger(record[field]) &&
        record[field] >= 1 &&
        record[field] <= max)
      ? null
      : invalid(field);
  }

  function validateOptionalRunModeArray(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    if (record[field] === undefined) return null;
    if (!Array.isArray(record[field])) return invalid(field);
    return record[field].every(
      (entry) =>
        typeof entry === 'string' &&
        PIPELINE_RUN_MODES.has(entry as PipelineTriggerType),
    )
      ? null
      : invalid(field);
  }

  function validateOptionalKnownStringArray(
    record: Record<string, unknown>,
    field: string,
    allowed: Set<string>,
  ): ActionValidationResult | null {
    const value = record[field];
    if (value === undefined) return null;
    return Array.isArray(value) &&
      value.every((entry) => isKnownString(entry, allowed))
      ? null
      : invalid(field);
  }

  function validateOptionalExecutionStatus(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    return record[field] === undefined ||
      (typeof record[field] === 'string' &&
        PIPELINE_EXECUTION_STATUSES.has(
          record[field] as ExecutionState['status'],
        ))
      ? null
      : invalid(field);
  }

  function validateOptionalWorktreeScope(
    record: Record<string, unknown>,
  ): ActionValidationResult | null {
    const base = optionalStrings(record, ['projectId', 'worktreeId']);
    if (base) return base;
    const hasProject = record.projectId !== undefined;
    const hasWorktree = record.worktreeId !== undefined;
    if (hasProject !== hasWorktree) {
      return {
        ok: false,
        message: `Action ${type} requires projectId and worktreeId to be supplied together.`,
      };
    }
    return null;
  }

  function validateOptionalRepoScriptChanges(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    if (record[field] === undefined) return null;
    if (!Array.isArray(record[field])) return invalid(field);
    const validEntries = record[field].every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.repoId === 'string' &&
        isRecord(entry.scripts),
    );
    return validEntries ? null : invalid(field);
  }

  function validateOptionalRepoHookChanges(
    record: Record<string, unknown>,
    field: string,
  ): ActionValidationResult | null {
    if (record[field] === undefined) return null;
    if (!Array.isArray(record[field])) return invalid(field);
    const validEntries = record[field].every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.repoId === 'string' &&
        isRecord(entry.hooks),
    );
    return validEntries ? null : invalid(field);
  }

  function validateOptionalChatHistoryTarget(
    record: Record<string, unknown>,
  ): ActionValidationResult | null {
    const base = optionalStrings(record, ['projectId', 'worktreeId', 'chatId']);
    if (base) return base;
    const hasProject = record.projectId !== undefined;
    const hasWorktree = record.worktreeId !== undefined;
    if (hasProject !== hasWorktree) {
      return {
        ok: false,
        message: `Action ${type} requires projectId and worktreeId to be supplied together.`,
      };
    }
    if (record.chatId !== undefined && (!hasProject || !hasWorktree)) {
      return {
        ok: false,
        message: `Action ${type} requires projectId and worktreeId when chatId is supplied.`,
      };
    }
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileTreeItemReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.repoId === 'string' &&
    value.repoId.trim().length > 0 &&
    typeof value.relativePath === 'string'
  );
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  return typeof record[key] === 'string' && record[key].length > 0
    ? record[key]
    : null;
}

/**
 * A POSIX path, a Windows rooted/drive path, or a UNC path. Rejects relative paths
 * and URLs; main re-checks the path against the executing host's rules.
 */
function looksLikeAbsoluteLocalPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith('\\')
  );
}

function isKnownString(value: unknown, allowed: Set<string>): boolean {
  return typeof value === 'string' && allowed.has(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}/${worktreeId}`;
}

function hasActiveWorktreeSession(
  projectId: string,
  worktreeId: string,
): boolean {
  const chatState = useChatStore.getState();
  const pendingPlanExitChatIds = new Set(
    Object.values(chatState.pendingPlanExits).map((exit) => exit.chatId),
  );
  const activeScopeKeys = Object.entries(chatState.worktreeChats)
    .filter(([, chat]) =>
      chat.tabs.some(
        (tab) =>
          tab.status === 'streaming' &&
          !tab.pendingPlanExit &&
          !pendingPlanExitChatIds.has(tab.id),
      ),
    )
    .map(([key]) => key);
  return addPlanExploreOriginWorktreeKeys(
    activeScopeKeys,
    useActivityStore.getState().trackedPlans,
  ).has(worktreeKey(projectId, worktreeId));
}

/**
 * Consistent refusal message for dispatcher actions blocked because their
 * target worktree is currently split-locked (a Split PR workflow owns it end
 * to end, from resource termination through plan review and execution). Main
 * process chokepoints (`assertNotSplitLocked`) are the authority and still
 * refuse regardless of this check; this early, renderer-side gate exists so
 * the assistant gets a friendly, typed refusal instead of a raw IPC error
 * surfaced after side effects like worktree selection or tab creation have
 * already run.
 */
function splitLockRefusalError(): AppAdvisorActionError {
  return {
    code: 'surface_unavailable',
    message:
      'A Split PR is in progress for this worktree; it is locked until the split finishes.',
    retryable: true,
  };
}

/**
 * Returns a typed refusal when `projectId`/`worktreeId` is currently
 * split-locked (mirrored from main via `splitLockedWorktrees`), or
 * `undefined` when the action may proceed. Callers place this before any
 * worktree-mutating side effect (chat sends, git actions, pipeline/terminal/
 * browser launches targeting the worktree, and the Split PR launcher itself).
 */
function refuseIfSplitLocked(
  projectId: string,
  worktreeId: string,
): AppAdvisorActionError | undefined {
  const key = worktreeKey(projectId, worktreeId);
  if (useGitHubStore.getState().splitLockedWorktrees.has(key)) {
    return splitLockRefusalError();
  }
  return undefined;
}

interface WorktreeGitActionRow {
  [key: string]: AppAdvisorJson;
  action: WorktreeGitAction;
  label: string;
  repoIds: string[] | null;
  repoNames: string[];
  description: string;
}

interface WorktreeGitActionsContext {
  workspace: SidebarItem;
  worktree: WorktreeData;
  isMultiRepo: boolean;
  branchSyncBusy: boolean;
  commitReviewPending: boolean;
  creatingPr: boolean;
  mergingPr: boolean;
  activeBranchSyncAction: BranchSyncAction | null;
  actions: WorktreeGitActionRow[];
}

function getBranchSyncActionLabel(action: BranchSyncAction): string {
  switch (action) {
    case 'push':
      return 'Push';
    case 'pull':
      return 'Pull';
    case 'pull-commit-and-push':
      return 'Pull, commit & push';
    case 'commit':
      return 'Commit';
    default:
      return 'Commit & push';
  }
}

function getCreatePrActionLabel(params: {
  isMultiRepo: boolean;
  uncommittedChanges: boolean;
  hasUnpushedCommits: boolean;
  repoBranches?: RepoBranchInfo[];
  repoCount?: number;
}): string {
  if (params.isMultiRepo) {
    const anyNeedsCommit =
      params.repoBranches?.some((branch) =>
        repoRequiresCommitAndPush(branch),
      ) ?? false;
    const anyNeedsPush =
      params.repoBranches?.some((branch) => repoRequiresPush(branch)) ?? false;
    const count = params.repoCount ?? 0;
    const suffix = count > 1 ? `${count} PRs` : 'PR';
    if (anyNeedsCommit) return `Commit, push & create ${suffix}`;
    if (anyNeedsPush) return `Push & create ${suffix}`;
    return `Create ${suffix}`;
  }
  if (params.uncommittedChanges) return 'Commit, push & create PR';
  if (params.hasUnpushedCommits) return 'Push & create PR';
  return 'Create PR';
}

function repoHasOpenPr(repo: WorktreePrStatus['repos'][number]): boolean {
  return repo.status?.state === 'open' || repo.status?.state === 'draft';
}

function filterRepoBranchesByIds(
  repoBranches: RepoBranchInfo[] | undefined,
  repoIds: string[],
): RepoBranchInfo[] | undefined {
  if (repoIds.length === 0) return undefined;
  const repoIdSet = new Set(repoIds);
  return repoBranches?.filter((branch) => repoIdSet.has(branch.repoId));
}

function gitActionRow(params: {
  action: WorktreeGitAction;
  label: string;
  repoIds?: string[];
  repoNames?: string[];
  description: string;
}): WorktreeGitActionRow {
  return {
    action: params.action,
    label: params.label,
    repoIds: params.repoIds ?? null,
    repoNames: params.repoNames ?? [],
    description: params.description,
  };
}

async function buildWorktreeGitActionsContext(
  projectId: string,
  worktreeId: string,
): Promise<
  | { ok: true; context: WorktreeGitActionsContext }
  | { ok: false; error: AppAdvisorActionError }
> {
  await ensureProjectsHydrated();
  const workspace = getWorkspaceOrError(projectId);
  if ('error' in workspace) {
    return { ok: false, error: workspace.error };
  }
  if (workspace.type === 'cowork') {
    return {
      ok: false,
      error: {
        code: 'unsupported_action',
        message: `Project ${projectId} is a cowork project and has no git worktrees.`,
      },
    };
  }
  const worktree = workspace.worktrees.find(
    (candidate) => candidate.id === worktreeId,
  );
  if (!worktree) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Worktree ${worktreeId} was not found in project ${projectId}.`,
      },
    };
  }

  const key = worktreeKey(projectId, worktreeId);
  const projectsState = useProjectsStore.getState();
  const githubState = useGitHubStore.getState();
  const prStatus =
    githubState.prStatuses[key] ?? worktree.lastKnownPrStatus ?? null;
  const repoBranches = projectsState.repoBranches[key];
  const hasCommitsAhead = projectsState.commitsAhead[key] ?? false;
  const uncommittedChanges = projectsState.uncommittedChanges[key] ?? false;
  const hasRemoteTracking = projectsState.hasRemoteTracking[key] ?? false;
  const hasOriginRemote = projectsState.hasOriginRemote[key] ?? true;
  const hasUnpushedCommits = projectsState.hasUnpushedCommits[key] ?? false;
  const hasUnpulledCommits = projectsState.hasUnpulledCommits[key] ?? false;
  const hasBranchBeenPushed = projectsState.hasBranchBeenPushed[key] ?? false;
  const baseBranchExistsLocally =
    projectsState.baseBranchExistsLocally[key] ?? false;
  const baseBranchExistsInRemote =
    projectsState.baseBranchExistsInRemote[key] ?? false;
  const branchSyncBusy =
    githubState.committingAndPushing.has(key) ||
    githubState.mergingLocalBranches.has(key);
  const commitReviewPending = Boolean(githubState.commitReviewPending[key]);
  const mergingPr = githubState.mergingPr.has(key);
  const activeBranchSyncAction =
    githubState.activeBranchSyncAction[key] ?? null;

  const isMultiRepo = prStatus
    ? prStatus.repos.length > 1
    : repoBranches
      ? repoBranches.length > 1
      : false;
  const hasChanges =
    hasCommitsAhead || uncommittedChanges || hasUnpushedCommits;
  const singleRepoSyntheticBranch: RepoBranchInfo | undefined = isMultiRepo
    ? undefined
    : {
        repoId: prStatus?.repos[0]?.repoId ?? projectId,
        repoName: prStatus?.repos[0]?.repoName ?? workspace.name,
        branch: worktree.branchName,
        baseBranch: projectsState.baseBranches[key],
        hasUncommittedChanges: uncommittedChanges,
        hasUnpushedCommits,
        hasUnpulledCommits,
        commitsAhead: hasCommitsAhead,
        hasRemoteTrackingBranch: hasRemoteTracking,
        hasOriginRemote,
        hasBranchBeenPushed,
        baseBranchExistsLocally,
        baseBranchExistsInRemote,
      };
  const openPrRepos = prStatus?.repos.filter(repoHasOpenPr) ?? [];
  const hasOpenPr = openPrRepos.length > 0;
  const hasAnyPr =
    prStatus?.repos.some((repo) => repo.status !== null) ?? false;
  const multiRepoBranchActions = getMultiRepoBranchSyncVisibility(
    repoBranches,
    openPrRepos.map((repo) => repo.repoId),
  );
  const multiRepoPullVisibility =
    getMultiRepoBranchSyncVisibility(repoBranches);
  const singleRepoAction = getSingleRepoGitAction({
    hasOpenPr,
    hasAnyChanges: hasChanges || uncommittedChanges,
    hasRemoteTracking,
    hasOriginRemote,
    hasUncommittedChanges: uncommittedChanges,
    hasUnpushedCommits,
    hasUnpulledCommits,
    commitsAhead: hasCommitsAhead,
    baseBranchExistsLocally,
  });

  const actions: WorktreeGitActionRow[] = [];
  const showCommitPush = branchSyncBusy
    ? activeBranchSyncAction === 'commit-and-push'
    : hasOpenPr &&
      (isMultiRepo
        ? multiRepoBranchActions.showCommitAndPush
        : singleRepoAction === 'commit-and-push');
  const showPullCommitPush = branchSyncBusy
    ? activeBranchSyncAction === 'pull-commit-and-push'
    : hasOpenPr &&
      (isMultiRepo
        ? multiRepoBranchActions.showPullCommitAndPush
        : singleRepoAction === 'pull-commit-and-push');
  const showPushOnly = branchSyncBusy
    ? activeBranchSyncAction === 'push'
    : hasOpenPr &&
      (isMultiRepo
        ? multiRepoBranchActions.showPush
        : singleRepoAction === 'push');
  const showPullOnly = branchSyncBusy
    ? activeBranchSyncAction === 'pull'
    : isMultiRepo
      ? multiRepoPullVisibility.showPull
      : singleRepoAction === 'pull';

  const localOnlyCommitBranches = isMultiRepo
    ? (repoBranches?.filter((branch) => repoRequiresCommitOnly(branch)) ?? [])
    : singleRepoSyntheticBranch &&
        repoRequiresCommitOnly(singleRepoSyntheticBranch)
      ? [singleRepoSyntheticBranch]
      : [];
  const localOnlyMergeBranches = isMultiRepo
    ? (repoBranches?.filter((branch) => repoCanMergeLocalBranch(branch)) ?? [])
    : singleRepoSyntheticBranch &&
        repoCanMergeLocalBranch(singleRepoSyntheticBranch)
      ? [singleRepoSyntheticBranch]
      : [];

  if (showCommitPush) {
    actions.push(
      gitActionRow({
        action: 'commit-and-push',
        label: getBranchSyncActionLabel('commit-and-push'),
        description:
          'Commit local changes and push them for repos with open PRs.',
      }),
    );
  }
  if (showPullCommitPush) {
    actions.push(
      gitActionRow({
        action: 'pull-commit-and-push',
        label: getBranchSyncActionLabel('pull-commit-and-push'),
        description:
          'Pull remote commits, then commit local changes and push for repos with open PRs.',
      }),
    );
  }
  if (showPushOnly) {
    actions.push(
      gitActionRow({
        action: 'push',
        label: getBranchSyncActionLabel('push'),
        description:
          'Push already committed local work for repos with open PRs.',
      }),
    );
  }
  if (showPullOnly) {
    actions.push(
      gitActionRow({
        action: 'pull',
        label: getBranchSyncActionLabel('pull'),
        description: 'Pull remote commits into the worktree.',
      }),
    );
  }
  if (localOnlyCommitBranches.length > 0) {
    actions.push(
      gitActionRow({
        action: 'commit',
        label: getBranchSyncActionLabel('commit'),
        repoIds: localOnlyCommitBranches.map((branch) => branch.repoId),
        repoNames: localOnlyCommitBranches.map((branch) => branch.repoName),
        description: 'Commit changes in local-only repos without pushing.',
      }),
    );
  }
  if (localOnlyMergeBranches.length > 0) {
    actions.push(
      gitActionRow({
        action: 'merge',
        label: 'Merge',
        repoIds: localOnlyMergeBranches.map((branch) => branch.repoId),
        repoNames: localOnlyMergeBranches.map((branch) => branch.repoName),
        description:
          'Merge committed local-only repo branches back into their default branches.',
      }),
    );
  }

  const reposReadyForPr =
    prStatus && !hasAnyPr && isMultiRepo
      ? prStatus.repos.filter((repo) => {
          const branch = repoBranches?.find(
            (entry) => entry.repoId === repo.repoId,
          );
          return !repoIsLocalOnly(branch) && repoHasChanges(branch);
        })
      : [];
  const showCreatePr =
    prStatus !== null
      ? isMultiRepo
        ? !hasAnyPr && reposReadyForPr.length > 0
        : !hasAnyPr
          ? singleRepoAction === 'create-pr'
          : !branchSyncBusy && singleRepoAction === 'create-pr'
      : false;
  if (showCreatePr && !branchSyncBusy) {
    const repoIds = isMultiRepo
      ? reposReadyForPr.map((repo) => repo.repoId)
      : undefined;
    actions.push(
      gitActionRow({
        action: 'create-pr',
        label: getCreatePrActionLabel({
          isMultiRepo,
          uncommittedChanges,
          hasUnpushedCommits,
          repoBranches: isMultiRepo
            ? filterRepoBranchesByIds(repoBranches, repoIds ?? [])
            : repoBranches,
          repoCount: reposReadyForPr.length,
        }),
        repoIds,
        repoNames: reposReadyForPr.map((repo) => repo.repoName),
        description:
          'Create pull requests for repos ready for PR creation. The backend commits or pushes first when required.',
      }),
    );
  }

  const reposNeedingPr =
    prStatus && hasAnyPr && isMultiRepo
      ? prStatus.repos.filter((repo) => {
          if (repoHasOpenPr(repo)) return false;
          const branch = repoBranches?.find(
            (entry) => entry.repoId === repo.repoId,
          );
          return !repoIsLocalOnly(branch) && repoHasChanges(branch);
        })
      : [];
  if (reposNeedingPr.length > 0 && !branchSyncBusy) {
    const repoIds = reposNeedingPr.map((repo) => repo.repoId);
    actions.push(
      gitActionRow({
        action: 'create-pr',
        label: getCreatePrActionLabel({
          isMultiRepo: true,
          uncommittedChanges,
          hasUnpushedCommits,
          repoBranches: filterRepoBranchesByIds(repoBranches, repoIds),
          repoCount: reposNeedingPr.length,
        }),
        repoIds,
        repoNames: reposNeedingPr.map((repo) => repo.repoName),
        description:
          'Create pull requests for changed repos that do not already have open PRs.',
      }),
    );
  }

  // Merge open PR(s) via the GitHub API. Mirrors the PR status bar's merge
  // button: at least one open mergeable PR and a locally clean worktree.
  const mergeableOpenPrRepos = openPrRepos.filter(
    (repo) => repo.status != null && isPrReadyToMerge(repo.status),
  );
  const worktreeCleanForMerge =
    isMultiRepo && repoBranches
      ? repoBranches.every(
          (branch) =>
            !branch.hasUncommittedChanges && !branch.hasUnpushedCommits,
        )
      : !uncommittedChanges && !hasUnpushedCommits;
  if (
    mergeableOpenPrRepos.length > 0 &&
    worktreeCleanForMerge &&
    !branchSyncBusy &&
    !mergingPr
  ) {
    const hasUnresolved = mergeableOpenPrRepos.some(
      (repo) => repo.status != null && hasUnresolvedReviewThreads(repo.status),
    );
    const description = hasUnresolved
      ? 'Merge the open pull request(s) via GitHub. One or more PRs have unresolved review comments, so this requires ignoreUnresolvedCommentsWarning: true, set only after the user confirms they want to ignore them.'
      : 'Merge the open pull request(s) via GitHub.';
    actions.push(
      gitActionRow({
        action: 'merge-pr',
        label: 'Merge PR',
        repoIds: isMultiRepo
          ? mergeableOpenPrRepos.map((repo) => repo.repoId)
          : undefined,
        repoNames: mergeableOpenPrRepos.map((repo) => repo.repoName),
        description,
      }),
    );
  }

  return {
    ok: true,
    context: {
      workspace,
      worktree,
      isMultiRepo,
      branchSyncBusy,
      commitReviewPending,
      creatingPr: githubState.creatingPr.has(key),
      mergingPr,
      activeBranchSyncAction,
      actions,
    },
  };
}

function worktreeGitActionsResult(
  context: WorktreeGitActionsContext,
): AppAdvisorJson {
  return {
    workspace: workspaceSummary(context.workspace),
    worktree: worktreeSummary(context.worktree),
    isMultiRepo: context.isMultiRepo,
    busy:
      context.branchSyncBusy ||
      context.creatingPr ||
      context.mergingPr ||
      context.commitReviewPending,
    activeAction: context.activeBranchSyncAction,
    totalActions: context.actions.length,
    actions: context.actions,
  };
}

async function resolveChatHistoryTarget(action: {
  projectId?: string;
  worktreeId?: string;
  chatId?: string;
}): Promise<ChatHistoryTarget | { error: AppAdvisorActionError }> {
  const chatStore = useChatStore.getState();
  let projectId = action.projectId;
  let worktreeId = action.worktreeId;

  if (!projectId || !worktreeId) {
    const selected = chatStore.selectedWorktree;
    if (!selected) {
      return {
        error: {
          code: 'surface_unavailable',
          message:
            'No worktree is selected. Provide projectId/worktreeId/chatId or select a worktree first.',
          retryable: true,
        },
      };
    }
    projectId = selected.projectId;
    worktreeId = selected.worktreeId;
  }

  const key = worktreeKey(projectId, worktreeId);
  if (!useChatStore.getState().worktreeChats[key]) {
    await useChatStore.getState().loadTabsForTarget(projectId, worktreeId);
  }

  const worktreeChat = useChatStore.getState().worktreeChats[key];
  if (!worktreeChat) {
    return {
      error: {
        code: 'not_found',
        message: `No chat state found for worktree ${projectId}/${worktreeId}.`,
      },
    };
  }

  const chatId = action.chatId ?? worktreeChat.activeTabId;
  const tab = worktreeChat.tabs.find((candidate) => candidate.id === chatId);
  if (!tab) {
    return {
      error: {
        code: 'not_found',
        message: `Chat tab ${chatId || '(active)'} was not found.`,
      },
    };
  }
  if (tab.kind === 'file') {
    return {
      error: {
        code: 'invalid_target',
        message: 'The target tab is a file tab, not a chat transcript.',
      },
    };
  }

  return { projectId, worktreeId, chatId, tab };
}

async function resolveWorktreeTabsTarget(action: {
  projectId?: string;
  worktreeId?: string;
}): Promise<
  | {
      projectId: string;
      worktreeId: string;
      worktreeChat: WorktreeChatState;
    }
  | { error: AppAdvisorActionError }
> {
  const chatStore = useChatStore.getState();
  let projectId = action.projectId;
  let worktreeId = action.worktreeId;

  if (!projectId || !worktreeId) {
    const selected = chatStore.selectedWorktree;
    if (!selected) {
      return {
        error: {
          code: 'surface_unavailable',
          message:
            'No worktree is selected. Provide projectId/worktreeId or select a worktree first.',
          retryable: true,
        },
      };
    }
    projectId = selected.projectId;
    worktreeId = selected.worktreeId;
  }

  const key = worktreeKey(projectId, worktreeId);
  if (!useChatStore.getState().worktreeChats[key]) {
    await useChatStore.getState().loadTabsForTarget(projectId, worktreeId);
  }

  const worktreeChat = useChatStore.getState().worktreeChats[key];
  if (!worktreeChat) {
    return {
      error: {
        code: 'not_found',
        message: `No tab state found for worktree ${projectId}/${worktreeId}.`,
      },
    };
  }

  return { projectId, worktreeId, worktreeChat };
}

async function resolveBrowserWorktreeTarget(action: {
  projectId?: string;
  worktreeId?: string;
}): Promise<
  | {
      projectId: string;
      worktreeId: string;
    }
  | { error: AppAdvisorActionError }
> {
  const chatStore = useChatStore.getState();
  let projectId = action.projectId;
  let worktreeId = action.worktreeId;

  if (!projectId || !worktreeId) {
    const selected = chatStore.selectedWorktree;
    if (!selected) {
      return {
        error: {
          code: 'surface_unavailable',
          message:
            'No worktree is selected. Provide projectId/worktreeId or select a worktree first.',
          retryable: true,
        },
      };
    }
    projectId = selected.projectId;
    worktreeId = selected.worktreeId;
  }
  if (isMcpOAuthBrowserScope(projectId, worktreeId)) {
    return {
      error: {
        code: 'surface_unavailable',
        message: SIGN_IN_PAGES_PRIVATE_MESSAGE,
        retryable: false,
      },
    };
  }

  ensureBrowserEventSubscription();
  await useBrowserStore.getState().loadBrowserPreferences();
  await useBrowserStore.getState().hydrateWorktree(projectId, worktreeId);
  return { projectId, worktreeId };
}

function readBrowserBucket(
  projectId: string,
  worktreeId: string,
): WorktreeBrowserBucket | undefined {
  return useBrowserStore.getState().worktrees[
    worktreeKey(projectId, worktreeId)
  ];
}

function activeBrowserIdForWorktree(
  projectId: string,
  worktreeId: string,
): string | null {
  const bucket = readBrowserBucket(projectId, worktreeId);
  if (!bucket) return null;
  // The omitted-ID target is the EXPLICITLY active browser (the last one the
  // user focused); fall back to the first session in stable order.
  if (
    bucket.activeBrowserId !== null &&
    bucket.browsers[bucket.activeBrowserId] !== undefined
  ) {
    return bucket.activeBrowserId;
  }
  return bucket.browserOrder[0] ?? Object.keys(bucket.browsers)[0] ?? null;
}

async function resolveBrowserActionTarget(action: {
  projectId?: string;
  worktreeId?: string;
  browserId?: string;
}): Promise<
  | {
      projectId: string;
      worktreeId: string;
      browserId: string;
    }
  | { error: AppAdvisorActionError }
> {
  const target = await resolveBrowserWorktreeTarget(action);
  if ('error' in target) return target;
  const bucket = readBrowserBucket(target.projectId, target.worktreeId);
  if (action.browserId && bucket?.browsers[action.browserId] === undefined) {
    return {
      error: {
        code: 'not_found',
        message: 'No in-app browser is available for this worktree.',
      },
    };
  }
  const browserId =
    action.browserId ??
    activeBrowserIdForWorktree(target.projectId, target.worktreeId);
  if (!browserId) {
    return {
      error: {
        code: 'not_found',
        message: 'No in-app browser is available for this worktree.',
      },
    };
  }
  await useBrowserStore
    .getState()
    .ensureLiveView(target.projectId, target.worktreeId, browserId);
  return { ...target, browserId };
}

function browserListResult(
  projectId: string,
  worktreeId: string,
): AppAdvisorJson {
  const bucket = readBrowserBucket(projectId, worktreeId);
  // Flat: sessions in stable `browserOrder` (no inner grouping remains).
  const browserIds = bucket?.browserOrder ?? [];
  const browsers = browserIds
    .map((browserId) => bucket?.browsers[browserId])
    .filter(Boolean);
  return {
    browsers,
    activeBrowserId: activeBrowserIdForWorktree(projectId, worktreeId),
  } as unknown as AppAdvisorJson;
}

function focusBrowserInStore(
  projectId: string,
  worktreeId: string,
  browserId: string,
): void {
  const bucket = readBrowserBucket(projectId, worktreeId);
  if (bucket?.browsers[browserId] !== undefined) {
    void useBrowserStore
      .getState()
      .setActiveBrowser(projectId, worktreeId, browserId);
  }
}

function browserSnapshotForTarget(target: {
  projectId: string;
  worktreeId: string;
  browserId: string;
}): BrowserSessionSnapshot | null {
  return (
    readBrowserBucket(target.projectId, target.worktreeId)?.browsers[
      target.browserId
    ] ?? null
  );
}

function browserActionResult(
  target: { projectId: string; worktreeId: string; browserId: string },
  payload: Record<string, unknown> = {},
): AppAdvisorJson {
  return {
    browser: browserSnapshotForTarget(target),
    ...payload,
  } as unknown as AppAdvisorJson;
}

/**
 * A snapshot or inspect whose target did not resolve comes back from IPC
 * as a rejection whose text encodes the read failure (E3); it fails like
 * an action refusal, as on the MCP route. Other errors still throw.
 */
function browserReadFailure(failure: unknown): {
  ok: false;
  error: AppAdvisorActionError;
} {
  const decoded = decodeBrowserReadTargetError(failure);
  if (!decoded) throw failure;
  return { ok: false, error: browserReadTargetFailure(decoded) };
}

/**
 * The write is decided by the approval session of the chat that made the
 * call. Without that chat main has no one to ask, and denies it.
 */
async function runSaveDownload(
  action: Extract<AppAdvisorAction, { type: 'browser.save_download' }>,
  originChat?: AppAdvisorActionRequest['originChat'],
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const target = await resolveBrowserActionTarget(action);
  if ('error' in target) return { ok: false, error: target.error };
  const result = await window.api.browser.saveDownload({
    browserId: target.browserId,
    downloadId: action.downloadId,
    path: action.path,
    ...(action.overwrite !== undefined ? { overwrite: action.overwrite } : {}),
    ...(action.timeoutMs !== undefined ? { timeoutMs: action.timeoutMs } : {}),
    ...(originChat ? { approvalChat: originChat } : {}),
  });
  return {
    ok: true,
    result:
      sanitizeAppAdvisorJsonValue({ browserId: target.browserId, ...result }) ??
      null,
  };
}

/** Saves the page as a PDF task file; no approval, like a screenshot. */
async function runSavePdf(
  action: Extract<AppAdvisorAction, { type: 'browser.save_pdf' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const target = await resolveBrowserActionTarget(action);
  if ('error' in target) return { ok: false, error: target.error };
  const result = await window.api.browser.savePdf({
    browserId: target.browserId,
    expectedRuntimeGeneration: action.expectedRuntimeGeneration,
    fileName: action.fileName,
    landscape: action.landscape,
    printBackground: action.printBackground,
    scale: action.scale,
    paperFormat: action.paperFormat,
    pageRanges: action.pageRanges,
    displayHeaderFooter: action.displayHeaderFooter,
    actionId: action.actionId,
    timeoutMs: action.timeoutMs,
  });
  return {
    ok: true,
    result:
      sanitizeAppAdvisorJsonValue({ browserId: target.browserId, ...result }) ??
      null,
  };
}

async function runBrowserAction(
  action: Extract<AppAdvisorAction, { type: `browser.${string}` }>,
  originChatTabId?: string,
  requestId?: string,
  signal?: AbortSignal,
  /** The App Advisor chat that asks, for an action that needs approval. */
  originChat?: AppAdvisorActionRequest['originChat'],
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const focusedElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const browserUserInteractionGeneration =
    getBrowserUserInteractionGeneration();
  let userChangedFocus = false;
  const handlePointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (
      focusedElement !== null &&
      target instanceof Node &&
      !focusedElement.contains(target)
    ) {
      userChangedFocus = true;
    }
  };
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      userChangedFocus = true;
    }
  };
  if (focusedElement !== null) {
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
  }
  try {
    switch (action.type) {
      case 'browser.list': {
        const target = await resolveBrowserWorktreeTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        return {
          ok: true,
          result: browserListResult(target.projectId, target.worktreeId),
        };
      }
      case 'browser.open': {
        if (action.handoff === true) {
          // Main owns the handoff lifecycle (CAN-4663); a renderer-local open
          // could not be released by the user's reply.
          return {
            ok: false,
            error: {
              code: 'unsupported_action',
              message: 'Browser handoffs run in the main process.',
            },
          };
        }
        const target = await resolveBrowserWorktreeTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const browserId = action.browserId;
        if (browserId) {
          const bucket = readBrowserBucket(target.projectId, target.worktreeId);
          if (bucket?.browsers[browserId] === undefined) {
            return {
              ok: false,
              error: {
                code: 'not_found',
                message: 'No in-app browser is available for this worktree.',
              },
            };
          }
        }
        const requestedUrl = action.url?.trim();
        const normalizedRequestedUrl =
          requestedUrl && requestedUrl !== 'about:blank'
            ? normalizeInAppBrowserInput(
                requestedUrl,
                useBrowserStore.getState().localServersOnly,
              )
            : null;
        if (
          requestedUrl &&
          requestedUrl !== 'about:blank' &&
          normalizedRequestedUrl === null
        ) {
          // A local file the in-app gate refused (a network share, a bare
          // `file:///`) must never fall through to `openExternal`: that path is
          // http/https-only, so it would reject with an unhandled rejection
          // rather than a clean action error. Anything else `openExternal`
          // cannot take (`~/site`, `\\?\C:\…`, `javascript:`) gets the same
          // clean refusal. Mirrors the main-process `browserOpen` ordering,
          // so both dispatchers answer one action with one error code.
          if (
            isFileBrowserUrl(requestedUrl) ||
            !isSafeExternalBrowserUrl(requestedUrl)
          ) {
            return {
              ok: false,
              error: {
                code: 'invalid_target',
                message: IN_APP_BROWSER_INVALID_URL_MESSAGE,
              },
            };
          }
          await window.api.browser.openExternal({ url: requestedUrl });
          // Say why it left the app instead of quietly opening elsewhere.
          raiseLocalOnlyConflictToast(requestedUrl);
          const browser = browserId
            ? (readBrowserBucket(target.projectId, target.worktreeId)?.browsers[
                browserId
              ] ?? null)
            : null;
          return {
            ok: true,
            result: {
              browser,
              openedUrl: requestedUrl,
            } as unknown as AppAdvisorJson,
          };
        }
        // Hand main the canonical URL so a typed path (`/Users/me/site/x.html`)
        // dedupes against an already-open session the same way main does.
        const openUrl = normalizedRequestedUrl ?? action.url;
        if (!browserId) {
          // Mirrors the main-process `browserCreate` chokepoint
          // (`assertNotSplitLocked(..., 'opening a browser')`) — only opening
          // a NEW browser session against the worktree is guarded; reusing an
          // already-open `browserId` below is not a new mutation.
          const browserOpenLockError = refuseIfSplitLocked(
            target.projectId,
            target.worktreeId,
          );
          if (browserOpenLockError) {
            return { ok: false, error: browserOpenLockError };
          }
          // The tab is revealed while its session is created; the result
          // waits for the live session.
          const opened = useBrowserStore
            .getState()
            .openBrowser(
              target.projectId,
              target.worktreeId,
              openUrl ? { url: openUrl } : undefined,
            );
          if (opened === null) {
            return { ok: false, error: inAppBrowserUnavailableError() };
          }
          // A rejected placement is a declined one: discard below.
          const activated = await requestBrowserPanel(
            target.projectId,
            target.worktreeId,
            opened.browserId,
            originChatTabId,
            { focus: false },
          ).catch(() => false);
          const snapshot = activated ? await opened.ready : null;
          if (snapshot === null) {
            const lastError = readBrowserBucket(
              target.projectId,
              target.worktreeId,
            )?.browsers[opened.browserId]?.lastError;
            const { discardOpenedBrowser } =
              await import('@/lib/panels/browser-panel-sync');
            await discardOpenedBrowser(
              target.projectId,
              target.worktreeId,
              opened.browserId,
            );
            return {
              ok: false,
              error: {
                code: 'execution_failed',
                message: activated
                  ? (lastError ?? 'Unable to open Browser.')
                  : 'Unable to open Browser panel.',
              },
            };
          }
          return {
            ok: true,
            result: sanitizeAppAdvisorJsonValue({
              browser:
                readBrowserBucket(target.projectId, target.worktreeId)
                  ?.browsers[opened.browserId] ?? snapshot,
            }) ?? { browser: null },
          };
        }
        focusBrowserInStore(target.projectId, target.worktreeId, browserId);
        await useBrowserStore
          .getState()
          .ensureLiveView(target.projectId, target.worktreeId, browserId);
        if (openUrl && action.browserId) {
          const snapshot = await window.api.browser.navigate({
            browserId,
            url: openUrl,
          });
          useBrowserStore.getState().applySnapshot(snapshot);
        }
        // Reveal (select-or-create) the EXACT bound panel for this session.
        const activated = await requestBrowserPanel(
          target.projectId,
          target.worktreeId,
          browserId,
          originChatTabId,
          { focus: false },
        );
        if (!activated) {
          return {
            ok: false,
            error: {
              code: 'execution_failed',
              message: 'Unable to open Browser panel.',
            },
          };
        }
        return {
          ok: true,
          result: {
            browser:
              readBrowserBucket(target.projectId, target.worktreeId)?.browsers[
                browserId
              ] ?? null,
          } as unknown as AppAdvisorJson,
        };
      }
      case 'browser.navigate': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const browser = await window.api.browser.navigate({
          browserId: target.browserId,
          url: action.url,
        });
        useBrowserStore.getState().applySnapshot(browser);
        void requestBrowserPanel(
          target.projectId,
          target.worktreeId,
          target.browserId,
          originChatTabId,
          { focus: false },
        );
        return { ok: true, result: { browser } as unknown as AppAdvisorJson };
      }
      case 'browser.back':
      case 'browser.forward':
      case 'browser.reload':
      case 'browser.stop': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const browser =
          action.type === 'browser.back'
            ? await window.api.browser.back({ browserId: target.browserId })
            : action.type === 'browser.forward'
              ? await window.api.browser.forward({
                  browserId: target.browserId,
                })
              : action.type === 'browser.reload'
                ? await window.api.browser.reload({
                    browserId: target.browserId,
                  })
                : await window.api.browser.stop({
                    browserId: target.browserId,
                  });
        useBrowserStore.getState().applySnapshot(browser);
        return { ok: true, result: { browser } as unknown as AppAdvisorJson };
      }
      case 'browser.get_dialog': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const [dialog, fileChooser, printRequest, auth] = await Promise.all([
          window.api.browser.getDialog({ browserId: target.browserId }),
          window.api.browser.getFileChooser({ browserId: target.browserId }),
          window.api.browser.getPrintRequest({ browserId: target.browserId }),
          window.api.browser.getAuthRequest({ browserId: target.browserId }),
        ]);
        return {
          ok: true,
          result: browserActionResult(target, {
            dialog,
            fileChooser,
            printRequest,
            auth,
          }),
        };
      }
      case 'browser.handle_dialog': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const chooser = fileChooserDialogAnswer(action.dialogId, action.accept);
        if (chooser.kind === 'refuse')
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: chooser.error.message,
              details: { error: chooser.error },
            },
          };
        if (chooser.kind === 'dismiss') {
          const answered = await window.api.browser.answerFileChooser({
            browserId: target.browserId,
            chooserId: chooser.chooserId,
            answer: 'dismiss',
          });
          return answered.ok
            ? {
                ok: true,
                result: browserActionResult(target, {
                  handled: { fileChooserId: chooser.chooserId, accept: false },
                }),
              }
            : {
                ok: false,
                error: {
                  code: 'invalid_target',
                  message: FILE_CHOOSER_NOT_PENDING,
                },
              };
        }
        const auth = authRequestDialogAnswer(action.dialogId, action.accept);
        if (auth.kind === 'refuse')
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: auth.error.message,
              details: { error: auth.error },
            },
          };
        if (auth.kind === 'cancel') {
          const cancelled = await window.api.browser.answerAuthRequest({
            browserId: target.browserId,
            authRequestId: auth.authRequestId,
            answer: 'cancel',
          });
          return cancelled.ok
            ? {
                ok: true,
                result: browserActionResult(target, {
                  handled: { authRequestId: auth.authRequestId, accept: false },
                }),
              }
            : {
                ok: false,
                error: {
                  code: 'invalid_target',
                  message: AUTH_REQUEST_NOT_PENDING,
                },
              };
        }
        const print = printRequestDialogAnswer(action.dialogId, action.accept);
        if (print.kind === 'answer') {
          const answered = await window.api.browser.answerPrintRequest({
            browserId: target.browserId,
            printRequestId: print.printRequestId,
            answer: print.answer,
          });
          if (answered.ok)
            return {
              ok: true,
              result: browserActionResult(target, {
                handled: {
                  printRequestId: print.printRequestId,
                  accept: action.accept,
                  ...(answered.transfer ? { transfer: answered.transfer } : {}),
                },
              }),
            };
          return answered.error?.code === 'not_found'
            ? {
                ok: false,
                error: {
                  code: 'invalid_target',
                  message: PRINT_REQUEST_NOT_PENDING,
                },
              }
            : {
                ok: false,
                error: {
                  code: 'execution_failed',
                  message:
                    answered.error?.message ?? "The PDF couldn't be saved.",
                },
              };
        }
        const handled = await window.api.browser.handleDialog({
          browserId: target.browserId,
          dialogId: action.dialogId,
          accept: action.accept,
          ...(action.promptText !== undefined
            ? { promptText: action.promptText }
            : {}),
        });
        return {
          ok: true,
          result: browserActionResult(target, { handled }),
        };
      }
      case 'browser.click':
      case 'browser.fill':
      case 'browser.set_checked':
      case 'browser.select_option':
      case 'browser.type':
      case 'browser.upload_files':
      case 'browser.request_files':
      case 'browser.drop_files':
      case 'browser.press':
      case 'browser.hover':
      case 'browser.scroll':
      case 'browser.drag':
      case 'browser.focus':
      case 'browser.wait_for': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        if (signal?.aborted) {
          return {
            ok: false,
            error: {
              code: 'execution_failed',
              message: 'The browser action was cancelled before it was sent.',
            },
          };
        }
        const response = await window.api.browser.automation({
          browserId: target.browserId,
          expectedRuntimeGeneration: action.expectedRuntimeGeneration,
          cancellationKey: requestId,
          command: buildBrowserAutomationCommand(action),
          ...((action.type === 'browser.upload_files' ||
            action.type === 'browser.request_files' ||
            action.type === 'browser.drop_files') &&
          originChat
            ? { approvalChat: originChat }
            : {}),
        });
        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: response.error?.code ?? 'execution_failed',
              message: response.error?.message ?? 'Browser automation failed.',
              ...(response.error?.details
                ? { details: response.error.details }
                : {}),
            },
          };
        }
        if (response.browser) {
          useBrowserStore.getState().applySnapshot(response.browser);
        }
        return {
          ok: true,
          result:
            sanitizeAppAdvisorJsonValue({
              ...response,
              ...(response.receipt?.status === 'outcome_unknown' &&
              !response.browser
                ? {}
                : {
                    browser:
                      response.browser ?? browserSnapshotForTarget(target),
                  }),
            }) ?? null,
        };
      }
      case 'browser.screenshot': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const screenshot = await window.api.browser.screenshot({
          browserId: target.browserId,
          saveToAttachments: action.saveToAttachments ?? true,
        });
        useBrowserStore.getState().addScreenshot(target.browserId, {
          id: createClientId(),
          filename:
            screenshot.attachmentPath?.split(/[\\/]/).pop() ??
            'browser-screenshot.png',
          attachmentPath: screenshot.attachmentPath,
          dataUrl: screenshot.dataUrl,
          capturedAt: Date.now(),
          attached: false,
        });
        const resultScreenshot = { ...screenshot };
        if (resultScreenshot.attachmentPath) {
          delete resultScreenshot.dataUrl;
        }
        return {
          ok: true,
          result: browserActionResult(target, { screenshot: resultScreenshot }),
        };
      }
      case 'browser.inspect': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        let element: BrowserElementSnapshot;
        try {
          element = await window.api.browser.inspect({
            browserId: target.browserId,
            ref: action.ref,
            locator: action.locator,
            ...(action.frame === undefined ? {} : { frame: action.frame }),
            x: action.x,
            y: action.y,
          });
        } catch (failure) {
          return browserReadFailure(failure);
        }
        return {
          ok: true,
          result: browserActionResult(target, { element }),
        };
      }
      case 'browser.input_snapshot': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        let inputSnapshot: BrowserInputSnapshotResponse;
        try {
          inputSnapshot = await window.api.browser.inputSnapshot({
            browserId: target.browserId,
            filter: {
              ...(action.frame === undefined ? {} : { frame: action.frame }),
              ...(action.inputType ? { inputType: action.inputType } : {}),
              ...(action.role ? { role: action.role } : {}),
              ...(action.name ? { name: action.name } : {}),
            },
            offset: action.offset ?? 0,
            limit: clampLimit(action.limit, 25, 100),
          });
        } catch (failure) {
          return browserReadFailure(failure);
        }
        return {
          ok: true,
          result: browserActionResult(target, { inputSnapshot }),
        };
      }
      case 'browser.get_console': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const limit = clampLimit(
          action.limit,
          BROWSER_ACTION_ROW_LIMIT,
          BROWSER_ACTION_ROW_LIMIT,
        );
        const entries = await window.api.browser.getConsole({
          browserId: target.browserId,
          level: action.level,
          limit,
        });
        const truncatedEntries = entries
          .slice(0, limit)
          .map(truncateBrowserConsoleEntry);
        return {
          ok: true,
          result: browserActionResult(target, {
            entries: truncatedEntries,
            returned: truncatedEntries.length,
            limit,
          }),
        };
      }
      case 'browser.get_network': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const limit = clampLimit(
          action.limit,
          BROWSER_ACTION_ROW_LIMIT,
          BROWSER_ACTION_ROW_LIMIT,
        );
        const entries = await window.api.browser.getNetwork({
          browserId: target.browserId,
          failed: action.failed,
          status: action.status,
          urlContains: action.urlContains,
          limit,
        });
        const truncatedEntries = entries
          .slice(0, limit)
          .map(truncateBrowserNetworkEntry);
        return {
          ok: true,
          result: browserActionResult(target, {
            entries: truncatedEntries,
            returned: truncatedEntries.length,
            limit,
          }),
        };
      }
      case 'browser.list_transfers': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const result = await window.api.browser.listTransfers({
          browserId: target.browserId,
          kind: action.kind,
          status: action.status,
          offset: action.offset ?? 0,
          limit: clampLimit(action.limit, 25, 100),
        });
        return {
          ok: true,
          result:
            sanitizeAppAdvisorJsonValue({
              browserId: target.browserId,
              ...result,
            }) ?? null,
        };
      }
      case 'browser.cancel_transfer': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const result = await window.api.browser.transferCommand({
          kind: 'cancel',
          browserId: target.browserId,
          transferId: action.transferId,
        });
        return {
          ok: true,
          result:
            sanitizeAppAdvisorJsonValue({
              browserId: target.browserId,
              ...result,
            }) ?? null,
        };
      }
      case 'browser.start_recording': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const browser = await window.api.browser.startRecording({
          browserId: target.browserId,
        });
        useBrowserStore.getState().applySnapshot(browser);
        return { ok: true, result: { browser } as unknown as AppAdvisorJson };
      }
      case 'browser.stop_recording': {
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const recording = await window.api.browser.stopRecording({
          browserId: target.browserId,
        });
        useBrowserStore
          .getState()
          .setRecordingResult(target.browserId, recording);
        const current = browserSnapshotForTarget(target);
        const browser = current
          ? {
              ...current,
              recording: recording.recording,
              updatedAt: Date.now(),
            }
          : null;
        if (browser) {
          useBrowserStore.getState().applySnapshot(browser);
        }
        return {
          ok: true,
          result: { browser, recording } as unknown as AppAdvisorJson,
        };
      }
      case 'browser.open_external': {
        // The system browser stays http/https-only, so a `file:` target is
        // refused here rather than handed to `browser.openExternal` (which
        // rejects) — the in-app browser can now be sitting on a local file,
        // so this is reachable with no `url` at all. Mirrors the main-process
        // `browserOpenExternalAction` guard, message included.
        if (
          action.url &&
          (isFileBrowserUrl(action.url) ||
            !isSafeExternalBrowserUrl(action.url))
        ) {
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'Enter an http or https URL.',
            },
          };
        }
        if (action.url) {
          if (action.browserId) {
            const target = await resolveBrowserActionTarget(action);
            if ('error' in target) return { ok: false, error: target.error };
            await window.api.browser.openExternal({ url: action.url });
            return {
              ok: true,
              result: browserActionResult(target, { openedUrl: action.url }),
            };
          }
          await window.api.browser.openExternal({ url: action.url });
          return {
            ok: true,
            result: { browser: null, openedUrl: action.url },
          };
        }
        const target = await resolveBrowserActionTarget(action);
        if ('error' in target) return { ok: false, error: target.error };
        const url = readBrowserBucket(target.projectId, target.worktreeId)
          ?.browsers[target.browserId]?.url;
        if (!url) {
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'A browser URL is required.',
            },
          };
        }
        if (isFileBrowserUrl(url) || !isSafeExternalBrowserUrl(url)) {
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'Enter an http or https URL.',
            },
          };
        }
        await window.api.browser.openExternal({ url });
        return {
          ok: true,
          result: browserActionResult(target, { openedUrl: url }),
        };
      }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message:
          error instanceof Error ? error.message : 'Browser action failed.',
      },
    };
  } finally {
    document.removeEventListener('pointerdown', handlePointerDown, true);
    document.removeEventListener('keydown', handleKeyDown, true);
    // Browser-page fill/click implementations may focus an element inside the
    // native WebContentsView, and panel creation can focus its new grid group.
    // If no user pointer/Tab intent moved focus while the action was in flight,
    // hand keyboard routing back to exactly the renderer element they were
    // already using.
    if (
      focusedElement !== null &&
      focusedElement.isConnected &&
      !userChangedFocus &&
      browserUserInteractionGeneration === getBrowserUserInteractionGeneration()
    ) {
      focusedElement.focus({ preventScroll: true });
    }
  }
  return {
    ok: false,
    error: {
      code: 'unsupported_action',
      message: 'Unsupported browser action.',
    },
  };
}

function worktreeTabsResult(
  projectId: string,
  worktreeId: string,
  worktreeChat: WorktreeChatState,
): AppAdvisorJson {
  return advisorWorktreeTabsResult(
    projectId,
    worktreeId,
    worktreeChat.tabs,
    worktreeChat.activeTabId,
    (tabId) => desktopFileSessionController.isDirty(tabId),
  );
}

async function importTrackedPlanResult(
  action: Extract<AppAdvisorAction, { type: 'tracked-plan.import' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const response = await window.api.activity.plans.import({
    projectId: action.projectId,
    worktreeId: action.worktreeId,
    filePath: action.filePath,
    repoId: action.repoId,
    initiationSource: 'app_advisor',
  });
  if (!response.plan) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'No tracked plan was imported.',
      },
    };
  }
  useActivityStore.getState().upsertTrackedPlan(response.plan);
  return {
    ok: true,
    result: {
      plan: trackedPlanSummary(response.plan),
      trackedPlanFilePath: response.trackedPlanFilePath,
    },
  };
}

function trackedPlanPanelOpenError(
  action: { planId: string; worktreeId: string },
  status: 'unavailable' | 'failed' | 'worktree-unavailable',
): AppAdvisorActionError {
  switch (status) {
    case 'unavailable':
      return {
        code: 'not_found',
        message: `Tracked plan ${action.planId} was not found.`,
      };
    case 'worktree-unavailable':
      return {
        code: 'not_found',
        message: `Worktree ${action.worktreeId} that owns tracked plan ${action.planId} is not available.`,
      };
    case 'failed':
      return {
        code: 'execution_failed',
        message: `Unable to open the Plan panel for tracked plan ${action.planId}.`,
      };
  }
}

/**
 * `tracked-plan.open_explore` (a compatibility name): bring the plan's
 * owning worktree on screen and open or reveal its Plan panel through the
 * shared tracked-plan opener. The plan is resolved first so an unknown plan
 * never navigates.
 */
async function openTrackedPlanPanelResult(
  action: Extract<AppAdvisorAction, { type: 'tracked-plan.open_explore' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const plan = await useActivityStore
    .getState()
    .ensureTrackedPlanLoaded(
      action.projectId,
      action.worktreeId,
      action.planId,
    );
  if (!plan) {
    return {
      ok: false,
      error: trackedPlanPanelOpenError(action, 'unavailable'),
    };
  }
  const opened = await openTrackedPlan(
    {
      projectId: action.projectId,
      worktreeId: action.worktreeId,
      planId: action.planId,
    },
    { reportFailure: false },
  );
  if (opened.status !== 'revealed' && opened.status !== 'placed') {
    return {
      ok: false,
      error: trackedPlanPanelOpenError(action, opened.status),
    };
  }
  return {
    ok: true,
    result: {
      plan: trackedPlanSummary(plan),
      panel: {
        panelId: opened.location.panelId,
        groupId: opened.location.groupId,
        layoutKey: opened.location.layoutKey,
        revealed: opened.status === 'revealed',
      },
    },
  };
}

function pipelineAssistantChatTarget(chatId?: string): {
  projectId: string;
  worktreeId: string;
  chatId?: string;
} {
  return {
    projectId: PIPELINE_EDITOR_PROJECT_ID,
    worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
    ...(chatId ? { chatId } : {}),
  };
}

async function ensurePipelineAssistantTabsLoaded(): Promise<
  | {
      worktreeChat: WorktreeChatState;
    }
  | { error: AppAdvisorActionError }
> {
  const target = pipelineAssistantChatTarget();
  const key = worktreeKey(target.projectId, target.worktreeId);
  if (!useChatStore.getState().worktreeChats[key]) {
    let pluginSelections;
    try {
      const prefs = await window.api.loadPreferences();
      pluginSelections = prefs.pipelineEditorPluginSelections;
    } catch {
      pluginSelections = undefined;
    }
    await useChatStore
      .getState()
      .loadTabsForTarget(
        target.projectId,
        target.worktreeId,
        pluginSelections ? { pluginSelections } : undefined,
      );
  }
  void useChatStore.getState().ensureWorktreeHasChatTab(target);
  const worktreeChat = useChatStore.getState().worktreeChats[key];
  if (!worktreeChat) {
    return {
      error: {
        code: 'not_found',
        message: 'No Pipeline Assistant chat state was found.',
      },
    };
  }
  return { worktreeChat };
}

async function resolvePipelineAssistantChatHistoryTarget(action: {
  chatId?: string;
}): Promise<ChatHistoryTarget | { error: AppAdvisorActionError }> {
  const loaded = await ensurePipelineAssistantTabsLoaded();
  if ('error' in loaded) return loaded;
  return resolveChatHistoryTarget(pipelineAssistantChatTarget(action.chatId));
}

async function openPipelineAssistantSurface(): Promise<void> {
  useNavigationStore.getState().navigate('workflows-library');
  requestPipelineAssistantOpen();
  await window.api
    .savePreferences({ pipelineChatPanelVisible: true })
    .catch(() => {
      // The immediate renderer event still opens the drawer for this session.
    });
}

async function createPipelineAssistantChatTabResult(
  action: Extract<
    AppAdvisorAction,
    { type: 'pipeline-assistant-chat.create_tab' }
  >,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const loaded = await ensurePipelineAssistantTabsLoaded();
  if ('error' in loaded) return { ok: false, error: loaded.error };
  await openPipelineAssistantSurface();
  useChatStore.getState().createTab(pipelineAssistantChatTarget());
  const key = worktreeKey(
    PIPELINE_EDITOR_PROJECT_ID,
    PIPELINE_EDITOR_WORKTREE_ID,
  );
  const worktreeChat = useChatStore.getState().worktreeChats[key];
  const chatId = worktreeChat?.activeTabId;
  const createdTab = chatId
    ? worktreeChat?.tabs.find((tab) => tab.id === chatId)
    : undefined;
  if (!chatId || !createdTab || createdTab.kind === 'file') {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: 'No new Pipeline Assistant chat tab was created.',
      },
    };
  }
  const initialMessage = action.initialMessage?.trim();
  if (initialMessage) {
    await useChatStore.getState().sendMessage(
      initialMessage,
      undefined,
      {
        projectId: PIPELINE_EDITOR_PROJECT_ID,
        worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
        chatId,
      },
      undefined,
      { throwOnDispatchFailure: true },
    );
  }
  return {
    ok: true,
    result: {
      chatId,
      tabs: worktreeChat
        ? worktreeTabsResult(
            PIPELINE_EDITOR_PROJECT_ID,
            PIPELINE_EDITOR_WORKTREE_ID,
            worktreeChat,
          )
        : null,
    },
  };
}

async function pipelineAssistantChatSwitchTabResult(
  action: Extract<
    AppAdvisorAction,
    { type: 'pipeline-assistant-chat.switch_tab' }
  >,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const loaded = await ensurePipelineAssistantTabsLoaded();
  if ('error' in loaded) return { ok: false, error: loaded.error };
  const tab = loaded.worktreeChat.tabs.find(
    (candidate) => candidate.id === action.tabId,
  );
  if (!tab || (tab.kind ?? 'chat') !== 'chat') {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Pipeline Assistant chat tab ${action.tabId} was not found.`,
      },
    };
  }
  await openPipelineAssistantSurface();
  useChatStore
    .getState()
    .switchTab(action.tabId, pipelineAssistantChatTarget());
  const updated =
    useChatStore.getState().worktreeChats[
      worktreeKey(PIPELINE_EDITOR_PROJECT_ID, PIPELINE_EDITOR_WORKTREE_ID)
    ] ?? loaded.worktreeChat;
  return {
    ok: true,
    result: {
      activeTabId: action.tabId,
      tabs: worktreeTabsResult(
        PIPELINE_EDITOR_PROJECT_ID,
        PIPELINE_EDITOR_WORKTREE_ID,
        updated,
      ),
    },
  };
}

async function sendPipelineAssistantChatMessageResult(
  action: Extract<
    AppAdvisorAction,
    { type: 'pipeline-assistant-chat.send_message' }
  >,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const target = await resolvePipelineAssistantChatHistoryTarget(action);
  if ('error' in target) return { ok: false, error: target.error };
  await openPipelineAssistantSurface();
  useChatStore
    .getState()
    .switchTab(action.chatId, pipelineAssistantChatTarget());
  await useChatStore.getState().sendMessage(
    action.text,
    undefined,
    {
      projectId: PIPELINE_EDITOR_PROJECT_ID,
      worktreeId: PIPELINE_EDITOR_WORKTREE_ID,
      chatId: action.chatId,
    },
    undefined,
    { throwOnDispatchFailure: true },
  );
  return {
    ok: true,
    result: {
      chatId: target.chatId,
      tabTitle: target.tab.title,
    },
  };
}

function skillKey(sourceId: string, skillName: string): string {
  return `${sourceId}/${skillName}`;
}

function skillSummary(
  skill: InstalledSkillInfo,
): Record<string, AppAdvisorJson> {
  return {
    key: skillKey(skill.sourceId, skill.name),
    name: skill.name,
    sourceId: skill.sourceId,
    description: skill.description,
    source: skill.source,
    installedAt: skill.installedAt,
    updatedAt: skill.updatedAt,
    updateAvailable: skill.updateAvailable,
    builtIn: skill.builtIn === true,
    custom: skill.custom === true,
    shareableSource: (skill.shareableSource ?? null) as AppAdvisorJson,
  };
}

function skillMatches(
  skill: InstalledSkillInfo,
  query: string | undefined,
): boolean {
  const normalized = query?.trim().toLowerCase();
  if (!normalized) return true;
  return [
    skill.name,
    skill.sourceId,
    skill.description,
    skill.source,
    skill.custom ? 'custom' : '',
    skill.builtIn ? 'built-in builtin' : '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(normalized);
}

async function listSkillsResult(
  action: Extract<AppAdvisorAction, { type: 'skills.list' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const result = await window.skills.loadSkills();
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to load skills.',
      },
    };
  }

  const query = action.query?.trim() ?? '';
  const limit = clampLimit(
    action.limit,
    SKILL_LIST_DEFAULT_LIMIT,
    SKILL_LIST_MAX_LIMIT,
  );
  const filtered = result.data
    .filter((skill) => (action.customOnly === true ? skill.custom : true))
    .filter((skill) => skillMatches(skill, query))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: true,
    result: {
      query,
      customOnly: action.customOnly === true,
      totalMatches: filtered.length,
      returned: Math.min(filtered.length, limit),
      skills: filtered.slice(0, limit).map(skillSummary) as AppAdvisorJson,
    },
  };
}

async function readSkillResult(
  action: Extract<AppAdvisorAction, { type: 'skills.read' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const result = await window.skills.readContent(
    action.sourceId,
    action.skillName,
  );
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message:
          result.error ??
          `Skill ${skillKey(action.sourceId, action.skillName)} was not found.`,
      },
    };
  }
  return {
    ok: true,
    result: {
      sourceId: action.sourceId,
      skillName: action.skillName,
      content: result.data as unknown as AppAdvisorJson,
    },
  };
}

async function readSkillFileResult(
  action: Extract<AppAdvisorAction, { type: 'skills.read_file' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const filesResult = await window.skills.listFiles(
    action.sourceId,
    action.skillName,
  );
  if (!filesResult.success || !filesResult.data) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message:
          filesResult.error ??
          `Skill ${skillKey(action.sourceId, action.skillName)} was not found.`,
      },
    };
  }
  if (!filesResult.data.files.includes(action.filePath)) {
    return {
      ok: false,
      error: {
        code: 'invalid_target',
        message: `File ${action.filePath} is not exposed by ${skillKey(action.sourceId, action.skillName)}.`,
      },
    };
  }

  const result = await window.skills.readFile(
    action.sourceId,
    action.skillName,
    action.filePath,
  );
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message:
          result.error ??
          `File ${action.filePath} was not found in ${skillKey(action.sourceId, action.skillName)}.`,
      },
    };
  }
  return {
    ok: true,
    result: {
      sourceId: action.sourceId,
      skillName: action.skillName,
      filePath: action.filePath,
      file: {
        content: result.data.content,
        truncated: result.data.truncated,
        binary: result.data.binary,
      },
    },
  };
}

async function openSkillViewerResult(
  action: Extract<AppAdvisorAction, { type: 'skills.open_viewer' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const result = await window.skills.readContent(
    action.sourceId,
    action.skillName,
  );
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message:
          result.error ??
          `Skill ${skillKey(action.sourceId, action.skillName)} was not found.`,
      },
    };
  }

  if (action.filePath) {
    const filesResult = await window.skills.listFiles(
      action.sourceId,
      action.skillName,
    );
    if (
      !filesResult.success ||
      !filesResult.data?.files.includes(action.filePath)
    ) {
      return {
        ok: false,
        error: {
          code: 'not_found',
          message:
            filesResult.error ??
            `File ${action.filePath} was not found in ${skillKey(action.sourceId, action.skillName)}.`,
        },
      };
    }
  }

  useNavigationStore.getState().openSkillViewer({
    sourceId: action.sourceId,
    skillName: action.skillName,
    ...(action.filePath ? { filePath: action.filePath } : {}),
  });

  return {
    ok: true,
    result: {
      sourceId: action.sourceId,
      skillName: action.skillName,
      ...(action.filePath ? { filePath: action.filePath } : {}),
    },
  };
}

function customSkillExtras(
  content: SkillContentResponse,
): Record<string, string> {
  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(content.frontmatter)) {
    if (key === 'name' || key === 'description') continue;
    if (typeof value === 'string') {
      extras[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      extras[key] = String(value);
    }
  }
  return extras;
}

async function saveCustomSkillResult(
  payload: SaveCustomSkillRequest,
  operation: 'skills.create_custom' | 'skills.update_custom',
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const result = await window.skills.saveCustomSkill(payload);
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to save custom skill.',
      },
    };
  }
  window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
  return attachAgentArtifacts(
    {
      ok: true,
      result: sanitizeAppAdvisorJsonValue(result.data) ?? null,
    },
    [
      buildSkillArtifactReceipt({
        operation,
        source: 'installed',
        sourceId: 'custom:app',
        installedName: result.data.name,
        name: result.data.name,
        description: payload.description,
        canUpdate: true,
        ...(payload.originalName && payload.originalName !== result.data.name
          ? {
              aliases: [
                createAgentArtifactDedupeKey(
                  'skill',
                  'installed',
                  'custom:app',
                  payload.originalName,
                ),
              ],
            }
          : {}),
        navigationTarget: {
          kind: 'installed_skill',
          sourceId: 'custom:app',
          skillName: result.data.name,
        },
      }),
    ],
  );
}

async function updateCustomSkillResult(
  action: Extract<AppAdvisorAction, { type: 'skills.update_custom' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const existing = await window.skills.readContent(
    'custom:app',
    action.originalName,
  );
  if (!existing.success || !existing.data) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message:
          existing.error ?? `Custom skill "${action.originalName}" not found.`,
      },
    };
  }

  const currentName =
    typeof existing.data.frontmatter.name === 'string'
      ? existing.data.frontmatter.name
      : action.originalName;
  const currentDescription =
    typeof existing.data.frontmatter.description === 'string'
      ? existing.data.frontmatter.description
      : '';

  return saveCustomSkillResult(
    {
      originalName: action.originalName,
      name: action.name ?? currentName,
      description: action.description ?? currentDescription,
      body: action.body ?? existing.data.body,
      extraMetadata: action.extraMetadata ?? customSkillExtras(existing.data),
    },
    action.type,
  );
}

async function deleteCustomSkillResult(
  action: Extract<AppAdvisorAction, { type: 'skills.delete_custom' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const result = await window.skills.removeSkill('custom:app', action.name);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to delete custom skill.',
      },
    };
  }
  window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
  return { ok: true, result: { name: action.name } };
}

function openMarketplacesTab(): void {
  useNavigationStore.getState().openPluginsNavigation({
    kind: 'marketplace-source',
    target: 'list',
  });
}

/**
 * Curated MCP browse now lives on the Plugins **discovery** surface: the page
 * listens for `MCP_OPEN_BROWSE_EVENT` itself and focuses its search in apps
 * mode (API-2153, design section 5). Deliberately does NOT fire
 * `PLUGINS_OPEN_TAB_EVENT` first — that would route Customize to a tab
 * destination instead of the search this action is about to focus. The
 * destination is stored until the lazily-loaded Plugins page consumes it.
 */
function openMcpBrowse(): void {
  useNavigationStore.getState().openPluginsNavigation({ kind: 'browse-apps' });
}

/** Retained Advisor action names resolve to canonical Customize destinations. */
function openPluginsManagement(section: PluginsManagementSectionId): void {
  useNavigationStore.getState().openPluginsNavigation({
    kind: 'marketplace-browse',
    ...marketplaceManagementDestination(section),
  });
}

/**
 * Open a local agent's editor over its Marketplace detail, or a shared
 * agent's detail (CAN-4266). The request survives the page mounting after
 * navigation and opens once the agent inventory resolves it.
 */
function openAgentEditorResult(
  action: Extract<AppAdvisorAction, { type: 'agents.open_editor' }>,
): {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
} {
  const unavailable = agentsMarketplaceUnavailable();
  if (unavailable) return { ok: false, error: unavailable };
  if (action.source === 'shared') {
    openPluginsEntryDetail(`agent:shared:${action.agentId}`);
    return { ok: true, result: { agentId: action.agentId } };
  }
  requestAgentEditor(action.agentId);
  return { ok: true, result: { agentId: action.agentId } };
}

/**
 * Why the Marketplace Agents tab cannot open, or `null` when it can
 * (CAN-4266): agents must be switched on and the Marketplace available.
 */
function agentsMarketplaceUnavailable(): AppAdvisorActionError | null {
  if (
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key)
  ) {
    return {
      code: 'surface_unavailable',
      message: 'Agents are not available.',
    };
  }
  const availability = getPageAvailability('plugins');
  return availability.available ? null : pageUnavailableError(availability);
}

/** Open one unified Plugins entry detail through the durable page intent. */
function openPluginsEntryDetail(
  entryId: string,
  intent?: 'view' | 'connect',
): void {
  useNavigationStore.getState().openPluginsNavigation({
    kind: 'entry-detail',
    entryId,
    ...(intent ? { intent } : {}),
  });
}

function chatActionTargetError(
  target: ChatHistoryTarget,
  action: Extract<AppAdvisorAction, { type: 'worktree-chat.run_chat_action' }>,
): AppAdvisorActionError | null {
  if (action.action === 'hand_off') {
    return target.tab.staleSessionDetected
      ? null
      : {
          code: 'invalid_target',
          message: 'The target chat is not marked as an expired session.',
        };
  }

  if (target.tab.status === 'streaming') {
    return {
      code: 'invalid_target',
      message: 'Cannot fork or branch a chat while it is active.',
    };
  }
  if (target.tab.messages.length === 0) {
    return {
      code: 'invalid_target',
      message: 'Cannot fork or branch an empty chat.',
    };
  }
  if (action.action === 'branch' && isCoworkChatTarget(target.projectId)) {
    return {
      code: 'invalid_target',
      message: 'Standalone chats cannot be branched into worktrees.',
    };
  }

  return null;
}

function worktreeTabsResultForTarget(
  projectId: string,
  worktreeId: string,
): AppAdvisorJson | null {
  const worktreeChat =
    useChatStore.getState().worktreeChats[worktreeKey(projectId, worktreeId)];
  return worktreeChat
    ? worktreeTabsResult(projectId, worktreeId, worktreeChat)
    : null;
}

async function runWorktreeChatActionResult(
  action: Extract<AppAdvisorAction, { type: 'worktree-chat.run_chat_action' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const target = await resolveChatHistoryTarget(action);
  if ('error' in target) {
    return { ok: false, error: target.error };
  }

  const targetError = chatActionTargetError(target, action);
  if (targetError) {
    return { ok: false, error: targetError };
  }

  const lockError = refuseIfSplitLocked(target.projectId, target.worktreeId);
  if (lockError) {
    return { ok: false, error: lockError };
  }

  useChatStore.getState().selectWorktree(target.projectId, target.worktreeId);
  useChatStore.getState().switchTab(target.chatId, {
    projectId: target.projectId,
    worktreeId: target.worktreeId,
  });

  if (action.action === 'hand_off') {
    await useChatStore.getState().handleStaleSessionHandOff();
    return {
      ok: true,
      result: {
        action: action.action,
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        sourceChatId: target.chatId,
        tabs: worktreeTabsResultForTarget(target.projectId, target.worktreeId),
      },
    };
  }

  if (action.action === 'fork') {
    useChatStore.getState().forkTab(target.chatId, {
      projectId: target.projectId,
      worktreeId: target.worktreeId,
    });
    const tabs = worktreeTabsResultForTarget(
      target.projectId,
      target.worktreeId,
    );
    const activeTabId =
      useChatStore.getState().worktreeChats[
        worktreeKey(target.projectId, target.worktreeId)
      ]?.activeTabId ?? null;
    return {
      ok: true,
      result: {
        action: action.action,
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        sourceChatId: target.chatId,
        activeTabId,
        tabs,
      },
    };
  }

  const branchResult = await useChatStore.getState().branchTab(target.chatId);
  if (branchResult.status === 'cancelled') {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: 'Worktree creation was cancelled.',
        retryable: false,
      },
    };
  }
  if (branchResult.status === 'failed') {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: branchResult.message,
        retryable: branchResult.retryable,
      },
    };
  }
  const state = useChatStore.getState();
  const resultTabs = worktreeTabsResultForTarget(
    branchResult.projectId,
    branchResult.worktreeId,
  );
  const activeTabId =
    state.worktreeChats[
      worktreeKey(branchResult.projectId, branchResult.worktreeId)
    ]?.activeTabId ?? null;

  return {
    ok: true,
    result: {
      action: action.action,
      sourceProjectId: target.projectId,
      sourceWorktreeId: target.worktreeId,
      sourceChatId: target.chatId,
      projectId: branchResult.projectId,
      worktreeId: branchResult.worktreeId,
      activeTabId,
      tabs: resultTabs,
    },
  };
}

function parseSelections(value: unknown): ChatTabPluginSelections | null {
  try {
    return parseSelectionsJson(JSON.stringify(value));
  } catch {
    return null;
  }
}

async function ensureStandaloneProjectsLoaded(): Promise<void> {
  const store = useStandaloneChatStore.getState();
  if (store.chatProjectsLoaded) return;
  await store.loadChatProjects();
}

async function getStandaloneProjectOrError(
  projectId: string,
): Promise<ChatProjectData | { error: AppAdvisorActionError }> {
  await ensureStandaloneProjectsLoaded();
  const project = useStandaloneChatStore
    .getState()
    .chatProjects.find((candidate) => candidate.id === projectId);
  if (!project) {
    return {
      error: {
        code: 'not_found',
        message: `Cowork project ${projectId} was not found.`,
      },
    };
  }
  return project;
}

function activeStandaloneProjectId(): string {
  return useStandaloneChatStore.getState().activeChatProjectId;
}

async function resolveStandaloneProjectId(
  projectId: string | undefined,
): Promise<string | { error: AppAdvisorActionError }> {
  const resolved = projectId ?? activeStandaloneProjectId();
  const project = await getStandaloneProjectOrError(resolved);
  if ('error' in project) return project;
  return resolved;
}

async function resolveStandaloneChatTarget(
  projectId: string,
  chatId: string,
): Promise<StandaloneChatHistoryTarget | { error: AppAdvisorActionError }> {
  await window.api.standaloneChat.init(projectId);
  // Cowork chats live inside Work Entries (the entry id occupies the
  // worktreeId slot). Resolve which entry's tab file owns this chat; the
  // legacy `home` worktree id remains only as a pre-migration fallback.
  const resolution = await window.api.workEntries.resolveChat({
    projectId,
    chatId,
  });
  if (resolution.archivedInEntryId !== null) {
    const archived = await window.api.chat.readArchive({
      projectId,
      worktreeId: resolution.archivedInEntryId,
      chatId,
      fullTranscript: true,
    });
    return {
      projectId,
      worktreeId: resolution.archivedInEntryId,
      chatId,
      tab: hydratePersistedChatTab(archived.tab),
      archived: true,
    };
  }
  const worktreeId = resolution.entryId ?? COWORK_HOME_WORKTREE_ID;
  const target = await resolveChatHistoryTarget({
    projectId,
    worktreeId,
    chatId,
  });
  if ('error' in target) {
    const legacyArchive = await window.api.standaloneChat
      .readArchive({ projectId, chatId })
      .catch(() => null);
    if (legacyArchive?.snapshot?.tab) {
      return {
        projectId,
        worktreeId: COWORK_HOME_WORKTREE_ID,
        chatId,
        tab: hydratePersistedChatTab(legacyArchive.snapshot.tab),
        archived: true,
      };
    }
    return {
      error: {
        ...target.error,
        message: `Standalone chat ${chatId} in project ${projectId} could not be resolved: ${target.error.message}`,
      },
    };
  }
  return { ...target, archived: false };
}

function archivedStandaloneMutationError(
  target: StandaloneChatHistoryTarget,
): AppAdvisorActionError | null {
  if (!target.archived) return null;
  return {
    code: 'invalid_target',
    message:
      'Archived standalone chats are read-only. Restore the chat before applying mutations.',
  };
}

async function resolvePipelineScopeCwd(action: {
  projectId?: string;
  worktreeId?: string;
  repoId?: string;
}): Promise<string> {
  if (!action.projectId || !action.worktreeId) {
    return '';
  }
  return window.api.getWorktreePath({
    projectId: action.projectId,
    worktreeId: action.worktreeId,
    ...(action.repoId ? { repoId: action.repoId } : {}),
  });
}

async function listSharedPipelineInfos(action: {
  query?: string;
}): Promise<{ infos: PipelineInfo[]; warnings: string[] }> {
  try {
    const account = await window.api.loadCanopyCloudAccount();
    if (!account.hasApiKey || !account.account) {
      return { infos: [], warnings: [] };
    }
    const result = await window.pipelines.listShared({
      limit: PIPELINE_LIST_MAX_LIMIT,
      ...(action.query ? { q: action.query } : {}),
    });
    if (!result.success || !result.data) {
      return {
        infos: [],
        warnings: [
          result.error ?? `Shared pipelines failed to load from ${CLOUD_NAME}.`,
        ],
      };
    }
    return {
      infos: result.data.data.map((summary) => sharedPipelineInfo(summary)),
      warnings: [],
    };
  } catch (error: unknown) {
    return {
      infos: [],
      warnings: [
        error instanceof Error
          ? error.message
          : 'Shared pipelines failed to load.',
      ],
    };
  }
}

async function loadPipelinesForScope(action: {
  projectId?: string;
  worktreeId?: string;
  query?: string;
  runModes?: PipelineTriggerType[];
  includeDisabled?: boolean;
  limit?: number;
}): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const cwd = await resolvePipelineScopeCwd(action);
  const emptyProjectResult: IPCResult<PipelineInfo[]> = {
    success: true,
    data: [],
  };
  const [storedResult, projectResult]: [
    IPCResult<PipelineInfo[]>,
    IPCResult<PipelineInfo[]>,
  ] = await Promise.all([
    window.pipelines.list(),
    cwd
      ? window.pipelines.discoverProject(cwd)
      : Promise.resolve(emptyProjectResult),
  ]);
  const sharedResult = await listSharedPipelineInfos(action);

  if (!storedResult.success && !projectResult.success) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message:
          storedResult.error ??
          projectResult.error ??
          'Failed to list pipelines.',
      },
    };
  }

  const disabledPipelineIds = await loadDisabledPipelineIdsBestEffort();
  const infos = [
    ...(storedResult.success && storedResult.data ? storedResult.data : []),
    ...(projectResult.success && projectResult.data ? projectResult.data : []),
    ...sharedResult.infos,
    // Disabled pipelines stay hidden from run-oriented listings, but management
    // flows can opt in so App Advisor can re-enable them.
  ].filter(
    (info) =>
      action.includeDisabled === true || !disabledPipelineIds.has(info.id),
  );
  const hydrated = await Promise.all(
    infos
      .filter((info) => info.source !== 'curated')
      .map((info) =>
        window.pipelines.get(buildPipelineLookupRequest(info, cwd)),
      ),
  );
  const requestedModes = new Set(action.runModes ?? []);
  const rows = [
    ...hydrated.flatMap((result) =>
      result.success && result.data
        ? [pipelineListRow(result.data, disabledPipelineIds)]
        : [],
    ),
    ...infos
      .filter((info) => info.source === 'curated')
      .map(
        (info): PipelineListRow => ({
          id: info.id,
          name: info.name,
          description: info.description,
          source: info.source,
          readonly: true,
          filename: info.filename,
          filePath: '',
          enabled: !disabledPipelineIds.has(info.id),
          scopes: info.scopes ?? [],
          metadataOnly: true,
          runModes: (info.triggerTypes ?? []).map((mode) => ({
            mode,
            inputCount: null,
          })),
        }),
      ),
  ]
    .filter((row) =>
      fuzzyMatchText(action.query, [row.id, row.name, row.description]),
    )
    .filter(
      (row) =>
        requestedModes.size === 0 ||
        row.runModes.some((mode) => requestedModes.has(mode.mode)),
    )
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const limit = clampLimit(
    action.limit,
    PIPELINE_LIST_DEFAULT_LIMIT,
    PIPELINE_LIST_MAX_LIMIT,
  );

  return {
    ok: true,
    result: {
      scope:
        action.projectId && action.worktreeId
          ? {
              projectId: action.projectId,
              worktreeId: action.worktreeId,
              cwd,
            }
          : null,
      filters: {
        query: action.query ?? '',
        runModes: action.runModes ?? [],
        limit,
      },
      totalMatches: rows.length,
      returned: Math.min(rows.length, limit),
      pipelines: rows.slice(0, limit),
      warnings: [
        ...(storedResult.success
          ? []
          : [storedResult.error ?? 'Stored pipelines failed to load.']),
        ...(projectResult.success
          ? []
          : [projectResult.error ?? 'Project pipelines failed to load.']),
        ...sharedResult.warnings,
      ],
    },
  };
}

async function getPipelineDetailsResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.get' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const cwd = await resolvePipelineScopeCwd(action);
  const pipeline = await loadRunnablePipeline(action.pipelineId, cwd);
  if (!pipeline) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Pipeline ${action.pipelineId} was not found.`,
      },
    };
  }

  const runModes = portablePipelineTriggerTypes(
    getTriggerTypes(pipeline.content.on),
  ).map((mode) => {
    const inputState = resolvePipelineTriggerInputs(pipeline.content, mode);
    return {
      mode,
      inputs: pipelineInputDetails(
        getVisibleTriggerInputDefs(inputState.inputDefs),
      ),
      inputError: inputState.error,
    };
  });
  const disabledPipelineIds = await loadDisabledPipelineIdsBestEffort();

  return {
    ok: true,
    result: {
      pipeline: pipelineListRow(pipeline, disabledPipelineIds),
      version: pipeline.content.version ?? '',
      icon: pipeline.content.icon ?? '',
      env: (pipeline.content.env ?? {}) as unknown as AppAdvisorJson,
      defaults: (pipeline.content.defaults ?? {}) as unknown as AppAdvisorJson,
      jobCount: Object.keys(pipeline.content.jobs).length,
      stepCount: Object.values(pipeline.content.jobs).reduce(
        (total, job) => total + job.steps.length,
        0,
      ),
      runModes: runModes as unknown as AppAdvisorJson,
      ...(action.includeYaml
        ? {
            yamlDefinition: yaml.dump(
              { pipeline: pipeline.content },
              { lineWidth: 120, noRefs: true },
            ),
          }
        : {}),
    },
  };
}

async function createLocalPipelineResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.create' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    const pipeline = await parsePipelineYamlSource(action);
    const policyError = validateAgentPipelineMutationPolicy(pipeline);
    if (policyError) {
      return {
        ok: false,
        error: { code: 'validation_failed', message: policyError },
      };
    }
    const result = await window.pipelines.save({
      name: pipeline.name,
      description: pipeline.description ?? '',
      icon: pipeline.icon ?? '',
      content: pipeline,
    });
    if (!result.success || !result.data) {
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: result.error ?? 'Failed to create pipeline.',
        },
      };
    }
    return attachAgentArtifacts(
      { ok: true, result: result.data as unknown as AppAdvisorJson },
      [
        await appAdvisorPipelineReceipt(action.type, {
          info: result.data,
          content: pipeline,
        }),
      ],
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message:
          error instanceof Error ? error.message : 'Invalid pipeline YAML.',
      },
    };
  }
}

async function updateLocalPipelineResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.update' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    const hasYamlSource =
      action.rawYaml !== undefined || action.yamlFilePath !== undefined;
    let pipeline: Pipeline;
    if (hasYamlSource) {
      pipeline = await parsePipelineYamlSource(action);
      const policyError = validateAgentPipelineMutationPolicy(pipeline);
      if (policyError) {
        return {
          ok: false,
          error: { code: 'validation_failed', message: policyError },
        };
      }
    } else {
      const existing = await window.pipelines.get({
        id: action.pipelineId,
        source: 'user',
      });
      if (!existing.success || !existing.data) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Pipeline ${action.pipelineId} was not found.`,
          },
        };
      }
      if (existing.data.info.source !== 'user') {
        return {
          ok: false,
          error: {
            code: 'read_only_source',
            message: `${existing.data.info.source} pipelines are read-only.`,
          },
        };
      }
      pipeline = applyPipelineMetadataOverrides(existing.data.content, action);
      normalizePipeline(pipeline);
    }
    const result = await window.pipelines.save({
      id: action.pipelineId,
      name: pipeline.name,
      description: pipeline.description ?? '',
      icon: pipeline.icon ?? '',
      content: pipeline,
    });
    if (!result.success || !result.data) {
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: result.error ?? 'Failed to update pipeline.',
        },
      };
    }
    return attachAgentArtifacts(
      { ok: true, result: result.data as unknown as AppAdvisorJson },
      [
        await appAdvisorPipelineReceipt(action.type, {
          info: result.data,
          content: pipeline,
        }),
      ],
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message:
          error instanceof Error ? error.message : 'Invalid pipeline YAML.',
      },
    };
  }
}

async function duplicatePipelineResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.duplicate' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const cwd = await resolvePipelineScopeCwd(action);
  const pipeline = await loadRunnablePipeline(action.pipelineId, cwd);
  if (!pipeline) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Pipeline ${action.pipelineId} was not found.`,
      },
    };
  }
  const policyError = validateAgentPipelineMutationPolicy(pipeline.content);
  if (policyError) {
    return {
      ok: false,
      error: { code: 'validation_failed', message: policyError },
    };
  }
  const lookup = buildPipelineLookupRequest(pipeline.info, cwd);
  const result = await window.pipelines.duplicate(lookup);
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to duplicate pipeline.',
      },
    };
  }
  try {
    const loaded = await window.pipelines.get({
      id: result.data.id,
      source: 'user',
    });
    return loaded.success && loaded.data
      ? attachAgentArtifacts(
          { ok: true, result: result.data as unknown as AppAdvisorJson },
          [await appAdvisorPipelineReceipt(action.type, loaded.data)],
        )
      : { ok: true, result: result.data as unknown as AppAdvisorJson };
  } catch {
    return { ok: true, result: result.data as unknown as AppAdvisorJson };
  }
}

async function sharePipelineResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.share' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const resolved = resolveActionShareOrganization(action);
  if (!resolved.ok) return resolved;
  const cwd = await resolvePipelineScopeCwd(action);
  const pipeline = await loadRunnablePipeline(action.pipelineId, cwd);
  if (!pipeline) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Pipeline ${action.pipelineId} was not found.`,
      },
    };
  }
  if (pipeline.info.source === 'shared') {
    return {
      ok: false,
      error: {
        code: 'invalid_target',
        message:
          'This pipeline is already shared. Use pipeline.update_shared for shared pipelines.',
      },
    };
  }

  const result = await window.pipelines.createShared({
    rawPipeline: pipelineToYaml(pipeline.content),
    shareScope: resolved.action.shareScope,
    ...(resolved.action.teamId ? { teamId: resolved.action.teamId } : {}),
    ...(resolved.action.organizationId
      ? { organizationId: resolved.action.organizationId }
      : {}),
  });
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to share pipeline.',
      },
    };
  }

  // Sharing always keeps the local pipeline; `deleteLocal` is ignored and the
  // compatibility fields always report no deletion. Use `pipeline.delete`.
  const response = {
    ok: true as const,
    result: {
      sharedPipeline: result.data as unknown as AppAdvisorJson,
      deletedLocal: false,
      deleteLocalError: null,
    },
  };
  return attachAgentArtifacts(response, [
    await appAdvisorPipelineReceipt(
      action.type,
      {
        info: sharedPipelineInfo(result.data),
        content: pipeline.content,
      },
      action,
    ),
  ]);
}

async function updateSharedPipelineResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.update_shared' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const target = resolveSharedPipelineTarget(action);
  if (!target) {
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message:
          'Provide remoteId or select a shared pipeline before retrying.',
      },
    };
  }

  try {
    let rawYaml = action.rawYaml;
    if (rawYaml === undefined) {
      const existing = await window.pipelines.getShared(target);
      if (!existing.success || !existing.data) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: existing.error ?? 'Shared pipeline was not found.',
          },
        };
      }
      rawYaml = existing.data.rawPipeline;
    }
    if (!rawYaml) {
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Shared pipeline was not found.',
        },
      };
    }
    const pipeline = await parsePipelineYamlSource({ ...action, rawYaml });
    if (action.rawYaml !== undefined) {
      const policyError = validateAgentPipelineMutationPolicy(pipeline);
      if (policyError) {
        return {
          ok: false,
          error: { code: 'validation_failed', message: policyError },
        };
      }
    }
    const hasAffectedAutomations = await window.pipelines
      .getSharedUpdateImpact(target.remoteId)
      .then(
        (impact) =>
          !impact.success || !impact.data || impact.data.automations.length > 0,
      )
      .catch(() => true);
    const result = await window.pipelines.updateShared({
      ...target,
      rawPipeline: pipelineToYaml(pipeline),
    });
    if (!result.success || !result.data) {
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: result.error ?? 'Failed to update shared pipeline.',
        },
      };
    }
    const responseResult = hasAffectedAutomations
      ? {
          ...result.data,
          message:
            'People using this pipeline in their automations will need to approve your changes before they run again.',
        }
      : result.data;
    return attachAgentArtifacts(
      { ok: true, result: responseResult as unknown as AppAdvisorJson },
      [
        await appAdvisorPipelineReceipt(action.type, {
          info: sharedPipelineInfo(result.data),
          content: pipeline,
        }),
      ],
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message:
          error instanceof Error ? error.message : 'Invalid pipeline YAML.',
      },
    };
  }
}

async function deleteSharedPipelineResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.delete_shared' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const target = resolveSharedPipelineTarget(action);
  if (!target) {
    return {
      ok: false,
      error: {
        code: 'invalid_payload',
        message:
          'Provide remoteId or select a shared pipeline before retrying.',
      },
    };
  }

  const result = await window.pipelines.deleteShared(target);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to delete shared pipeline.',
      },
    };
  }
  return { ok: true, result: target };
}

function getExecutionPlanPath(state: ExecutionState): string | null {
  return (
    state.event_data?.plan_ready?.plan_path ??
    state.event_data?.task_ready?.plan_path ??
    null
  );
}

async function loadExecutionStateForAction(
  executionId: string,
): Promise<
  | { ok: true; state: ExecutionState }
  | { ok: false; error: AppAdvisorActionError }
> {
  const result = await window.pipelines.getExecution(executionId);
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to load pipeline execution.',
      },
    };
  }
  if (!result.data) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Pipeline execution ${executionId} was not found.`,
      },
    };
  }
  return { ok: true, state: result.data };
}

function executionRow(
  summary: ExecutionSummary,
  state?: ExecutionState,
): PipelineExecutionRow {
  const inputRequestCount =
    state?.pending_pauses?.filter((checkpoint) => checkpoint.request).length ??
    0;
  return {
    id: summary.id,
    pipelineId: summary.pipeline_id,
    name: summary.pipeline_name,
    description: state?.pipeline_snapshot.description ?? '',
    status: summary.status,
    startedAt: summary.started_at,
    completedAt: summary.completed_at ?? null,
    projectId: summary.project_id ?? null,
    worktreeId: summary.worktree_id ?? null,
    eventName: summary.event_name ?? null,
    hasReport: summary.has_report === true,
    hasPlan: summary.has_plan === true,
    planModified: summary.plan_modified === true,
    inputRequested: inputRequestCount > 0,
    inputRequestCount,
  };
}

function executionDetails(state: ExecutionState): AppAdvisorJson {
  const pendingPauses = (state.pending_pauses ?? []).map(
    (checkpoint): Record<string, AppAdvisorJson> => ({
      checkpointId: checkpoint.id,
      kind: checkpoint.kind,
      jobId: checkpoint.job_id,
      logicalJobId: checkpoint.logical_job_id,
      stepId: checkpoint.step_id,
      request: sanitizeAppAdvisorJsonValue(checkpoint.request) ?? null,
    }),
  );
  const inputRequests = pendingPauses.filter(
    (checkpoint) => checkpoint.request !== null,
  );
  return {
    id: state.id,
    pipelineId: state.pipeline_id,
    name: state.pipeline_snapshot.name,
    description: state.pipeline_snapshot.description ?? '',
    status: state.status,
    startedAt: state.started_at,
    completedAt: state.completed_at ?? null,
    cwd: state.cwd,
    projectId: state.project_id ?? null,
    worktreeId: state.worktree_id ?? null,
    eventName: state.event_name ?? null,
    inputs: state.inputs as unknown as AppAdvisorJson,
    planId: state.planId ?? null,
    planPath: getExecutionPlanPath(state),
    planModified: state.plan_hash_before !== state.plan_hash_after,
    reportOutputs: (state.report_outputs ?? null) as unknown as AppAdvisorJson,
    error: state.error ?? null,
    inputRequested: inputRequests.length > 0,
    inputRequests,
    pendingPauses,
    resumableStatusReasons: (state.status_reasons ?? [])
      .filter((reason) => reason.kind !== 'input_required')
      .map((reason) => ({
        id: reason.id,
        kind: reason.kind,
        code: reason.code,
        jobId: reason.source.job_id,
        stepId: reason.source.step_id,
      })),
    jobs: Object.entries(state.jobs).map(([jobId, job]) =>
      advisorJobJson(jobId, state.job_definitions[jobId]?.name ?? jobId, job),
    ),
  };
}

function pipelineExecutionArtifact(
  operation: string,
  state: ExecutionState,
): ReturnType<typeof buildPipelineRunArtifactReceipt> | null {
  if (!state.project_id || !state.worktree_id) return null;
  return buildPipelineRunArtifactReceipt({
    operation,
    executionId: state.id,
    pipelineId: state.pipeline_id,
    pipelineName: state.pipeline_snapshot.name,
    initialStatus:
      state.status === 'paused' || state.status === 'running'
        ? state.status
        : 'pending',
    queuedAt: state.started_at,
    ...(state.status === 'running' ? { startedAt: state.started_at } : {}),
    projectId: state.project_id,
    worktreeId: state.worktree_id,
    navigationTarget: {
      kind: 'pipeline_execution',
      executionId: state.id,
      projectId: state.project_id,
      worktreeId: state.worktree_id,
    },
  });
}

async function executionScopeOptions(): Promise<AppAdvisorJson> {
  const workspaces = useProjectsStore.getState().projects;
  return {
    workspaces: await Promise.all(
      workspaces.map(async (workspace): Promise<AppAdvisorJson> => {
        const memberships = await codeSidebarGroupIdsForListing(
          workspace.id,
          workspace.type === 'cowork' ? [] : workspace.worktrees,
        ).catch(() => new Map<string, string>());
        return {
          id: workspace.id,
          name: workspace.name,
          type: workspace.type,
          worktrees:
            workspace.type === 'cowork'
              ? []
              : workspace.worktrees.map((worktree) => ({
                  id: worktree.id,
                  branchName: worktree.branchName,
                  ...(memberships.get(worktree.id)
                    ? { groupId: memberships.get(worktree.id) ?? null }
                    : {}),
                })),
        };
      }),
    ),
  };
}

async function listPipelineExecutionsResult(
  action: Extract<
    AppAdvisorAction,
    {
      type: 'pipeline.execution_list' | 'pipeline.execution_list_for_worktree';
    }
  >,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  if (action.type === 'pipeline.execution_list' && action.runOn === 'cloud') {
    if (action.projectId !== undefined || action.worktreeId !== undefined)
      return {
        ok: false,
        error: {
          code: 'invalid_payload',
          message:
            'Cloud runs have no project here: omit projectId and worktreeId with runOn "cloud".',
        },
      };
    return withCloudRuns((access) =>
      listCloudRuns(access, {
        ...(action.query === undefined ? {} : { query: action.query }),
        ...(action.pipelineId === undefined
          ? {}
          : { pipelineId: action.pipelineId }),
        ...(action.status === undefined ? {} : { status: action.status }),
        ...(action.limit === undefined ? {} : { limit: action.limit }),
      }),
    );
  }
  const result = await window.pipelines.listExecutions();
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to list pipeline executions.',
      },
    };
  }

  const filtered = result.data.filter((summary) => {
    if (action.projectId && summary.project_id !== action.projectId) {
      return false;
    }
    if (action.worktreeId && summary.worktree_id !== action.worktreeId) {
      return false;
    }
    if (action.pipelineId && summary.pipeline_id !== action.pipelineId) {
      return false;
    }
    if (action.status && summary.status !== action.status) {
      return false;
    }
    return fuzzyMatchText(action.query, [
      summary.pipeline_id,
      summary.pipeline_name,
      summary.id,
    ]);
  });
  const limit = clampLimit(
    action.limit,
    PIPELINE_EXECUTION_LIST_DEFAULT_LIMIT,
    PIPELINE_EXECUTION_LIST_MAX_LIMIT,
  );
  const selected = filtered.slice(0, limit);
  const states = await Promise.all(
    selected.map((summary) => window.pipelines.getExecution(summary.id)),
  );

  if (action.type === 'pipeline.execution_list') {
    await ensureProjectsHydrated();
  }

  return {
    ok: true,
    result: {
      filters: {
        projectId: action.projectId ?? null,
        worktreeId: action.worktreeId ?? null,
        query: action.query ?? '',
        pipelineId: action.pipelineId ?? null,
        status: action.status ?? null,
        limit,
      },
      ...(action.type === 'pipeline.execution_list'
        ? { availableScopes: await executionScopeOptions() }
        : {}),
      totalMatches: filtered.length,
      returned: selected.length,
      executions: selected.map((summary, index) =>
        executionRow(
          summary,
          states[index]?.success && states[index].data
            ? states[index].data
            : undefined,
        ),
      ),
    },
  };
}

async function readExecutionReportResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.execution_read_report' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const kind = action.kind ?? 'text';
  const result = await window.pipelines.readReportFile(
    action.executionId,
    kind,
  );
  if (!result.success || !result.data) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: result.error ?? 'Pipeline execution report was not found.',
      },
    };
  }
  const truncated = truncateContent(result.data.content, action.maxChars);
  return {
    ok: true,
    result: {
      executionId: action.executionId,
      kind,
      filePath: result.data.filePath,
      ...truncated,
    },
  };
}

async function readExecutionPlanResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.execution_read_plan' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const state = await loadExecutionStateForAction(action.executionId);
  if (!state.ok) {
    return { ok: false, error: state.error };
  }
  const planPath = getExecutionPlanPath(state.state);
  if (!planPath) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: 'This pipeline execution does not have a saved plan file.',
      },
    };
  }
  const file = await window.api.readFileContent({ absolutePath: planPath });
  if (file.kind !== 'text' && file.kind !== 'markdown') {
    return {
      ok: false,
      error: {
        code: 'invalid_target',
        message: 'The plan file is not readable text.',
      },
    };
  }
  const truncated = truncateContent(file.content, action.maxChars);
  return {
    ok: true,
    result: {
      executionId: action.executionId,
      filePath: planPath,
      filename: file.filename,
      sizeBytes: file.sizeBytes,
      modifiedAtMs: file.modifiedAtMs,
      planModified:
        state.state.plan_hash_before !== state.state.plan_hash_after,
      ...truncated,
    },
  };
}

async function executionGetResult(
  action: Extract<AppAdvisorAction, { type: 'pipeline.execution_get' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const state = await loadExecutionStateForAction(action.executionId);
  if (!state.ok) {
    const cloud =
      state.error.code === 'not_found'
        ? await cloudExecutionAnswer(action.executionId, (access) =>
            getCloudRun(access, action.executionId),
          )
        : null;
    return cloud ?? { ok: false, error: state.error };
  }
  const [report, plan] = await Promise.all([
    action.includeReport
      ? readExecutionReportResult({
          type: 'pipeline.execution_read_report',
          executionId: action.executionId,
          maxChars: action.maxChars,
        })
      : Promise.resolve(null),
    action.includePlan
      ? readExecutionPlanResult({
          type: 'pipeline.execution_read_plan',
          executionId: action.executionId,
          maxChars: action.maxChars,
        })
      : Promise.resolve(null),
  ]);
  return {
    ok: true,
    result: {
      execution: executionDetails(state.state),
      ...(report?.ok ? { report: report.result ?? null } : {}),
      ...(report && !report.ok
        ? { reportError: report.error?.message ?? '' }
        : {}),
      ...(plan?.ok ? { plan: plan.result ?? null } : {}),
      ...(plan && !plan.ok ? { planError: plan.error?.message ?? '' } : {}),
    },
  };
}

async function chainPipelineFromExecution(
  action: Extract<AppAdvisorAction, { type: 'pipeline.execution_chain' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const source = await loadExecutionStateForAction(action.executionId);
  if (!source.ok) {
    return { ok: false, error: source.error };
  }
  const planPath = getExecutionPlanPath(source.state);
  if (!planPath) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: 'This pipeline execution does not have a saved plan file.',
      },
    };
  }
  let cwd = source.state.cwd;
  if (source.state.project_id && source.state.worktree_id) {
    cwd = await window.api.getWorktreePath({
      projectId: source.state.project_id,
      worktreeId: source.state.worktree_id,
      ...(action.repoId ? { repoId: action.repoId } : {}),
    });
  }
  const pipeline = await loadRunnablePipeline(action.pipelineId, cwd);
  if (!pipeline) {
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Pipeline ${action.pipelineId} was not found.`,
      },
    };
  }
  if (!getTriggerTypes(pipeline.content.on).includes('plan_ready')) {
    return {
      ok: false,
      error: {
        code: 'invalid_target',
        message: `Pipeline ${action.pipelineId} does not support plan_ready.`,
      },
    };
  }

  const result = await window.pipelines.execute(pipeline.content, {
    cwd,
    pipelineId: pipeline.info.id,
    pipelineFilePath:
      pipeline.info.source === 'project' ? pipeline.info.filePath : undefined,
    repoPath: pipeline.info.source === 'project' ? cwd : undefined,
    projectId: source.state.project_id,
    worktreeId: source.state.worktree_id,
    initiationSource: 'app_advisor',
    eventName: 'plan_ready',
    eventData: {
      plan_ready: {
        plan_path: planPath,
        ...(source.state.planId ? { planId: source.state.planId } : {}),
      },
    },
    ...(action.inputs && Object.keys(action.inputs).length > 0
      ? { inputs: action.inputs }
      : {}),
  });
  if (!result.success) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: result.error ?? 'Failed to start follow-up pipeline.',
      },
    };
  }
  const receipt = result.data
    ? pipelineExecutionArtifact(action.type, result.data)
    : null;
  return receipt
    ? attachAgentArtifacts(
        { ok: true, result: result as unknown as AppAdvisorJson },
        [receipt],
      )
    : { ok: true, result: result as unknown as AppAdvisorJson };
}

// ---------------------------------------------------------------------------
// Shared resource helpers for the dispatcher.
// ---------------------------------------------------------------------------

function sharedResourceFailure(
  err: unknown,
  options: {
    deleteConflictMessage?: string;
    unsupportedResource?: 'skills' | 'collections' | 'agents' | 'automations';
    /** Resource noun for structured share failures, e.g. `plan`. */
    noun?: string;
  } = {},
): { ok: false; error: AppAdvisorActionError } {
  const message = resolveSharedResourceErrorMessage(err, {
    ...options,
    ...(options.unsupportedResource !== undefined
      ? { noun: SHARED_RESOURCE_NOUN[options.unsupportedResource] }
      : {}),
  });
  // Repeating an uncertain or landed publication could duplicate it.
  const commitState = classifyShareFailure(err)?.commitState;
  const retryable =
    commitState === undefined || commitState === 'not-committed';
  return {
    ok: false,
    error: { code: 'execution_failed', message, retryable },
  };
}

const SHARED_RESOURCE_NOUN = {
  skills: 'skill',
  collections: 'collection',
  agents: 'agent',
  automations: 'automation',
} as const;

async function importSharedSkillIntoLocal(detail: SharedSkillDetail): Promise<{
  skillId: string;
  skillName: string;
  reused: boolean;
  /**
   * Present when the skill imported but its packaged supporting files did not.
   * Declared here so it survives into the action result the assistant reads —
   * the value was always returned at runtime, and narrowing it away made a
   * partial import indistinguishable from a complete one.
   */
  packageInstallError?: string;
  /**
   * What the package installed, including `keptLocalFiles` — files not written
   * because the recipient's own version was kept. Declared so the assistant
   * can tell the user, exactly like `packageInstallError`.
   */
  packageInstall?: InstallSkillCapabilityPackageResult;
}> {
  return importSharedSkill(detail);
}

const ORGANIZATION_SHARE_TARGET_MESSAGE =
  'Choose an organization from the context switcher above the account in the sidebar, or pass organizationId, to share with an organization.';

function resolveActionShareOrganization<
  T extends { shareScope?: string; organizationId?: string },
>(
  action: T,
): { ok: true; action: T } | { ok: false; error: AppAdvisorActionError } {
  if (action.shareScope !== 'organization' || action.organizationId) {
    return { ok: true, action };
  }
  const context = getSidebarScopingContext();
  if (context?.kind !== 'organization') {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: ORGANIZATION_SHARE_TARGET_MESSAGE,
      },
    };
  }
  return {
    ok: true,
    action: { ...action, organizationId: context.organizationId },
  };
}

// ---------------------------------------------------------------------------
// Shared-skill action handlers (Phase F3 step 1).
//
// Each handler proxies through `window.skills.*` and resolves errors via
// {@link resolveSharedResourceErrorMessage} so the dispatch surface returns
// the same canonical copy as the UI surfaces.
// ---------------------------------------------------------------------------

async function listSharedSkillsResult(
  action: Extract<AppAdvisorAction, { type: 'skills.list_shared' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    const response = await window.skills.listShared({
      ...(action.query ? { query: action.query } : {}),
      ...(action.limit !== undefined ? { limit: action.limit } : {}),
      ...(action.cursor ? { cursor: action.cursor } : {}),
      ...(action.createdBy ? { createdBy: action.createdBy } : {}),
    });
    return {
      ok: true,
      result: {
        skills: response.skills as unknown as AppAdvisorJson,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
      },
    };
  } catch (err: unknown) {
    return sharedResourceFailure(err, { unsupportedResource: 'skills' });
  }
}

async function readSharedSkillResult(
  action: Extract<AppAdvisorAction, { type: 'skills.read_shared' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    const detail = await window.skills.getShared(action.skillId);
    return {
      ok: true,
      result: sanitizeAppAdvisorJsonValue(detail) ?? null,
    };
  } catch (err: unknown) {
    return sharedResourceFailure(err, { unsupportedResource: 'skills' });
  }
}

async function shareCustomSkillResult(
  action: Extract<AppAdvisorAction, { type: 'skills.share_custom' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const resolved = resolveActionShareOrganization(action);
  if (!resolved.ok) return resolved;
  try {
    const skillId = `custom:app/${action.name}`;
    const rawSkill = await window.skills.readRawSkill(skillId);
    const detail = unwrapShareOperationResult(
      await window.skills.createShared({
        rawSkill,
        shareScope: resolved.action.shareScope,
        ...(resolved.action.teamId ? { teamId: resolved.action.teamId } : {}),
        ...(resolved.action.organizationId
          ? { organizationId: resolved.action.organizationId }
          : {}),
      }),
    );
    return attachAgentArtifacts(
      { ok: true, result: detail as unknown as AppAdvisorJson },
      [
        buildSkillArtifactReceipt({
          operation: action.type,
          source: 'shared',
          sharedSkillId: detail.id,
          name: detail.name,
          description: detail.description,
          shareScope: detail.shareScope,
          owner:
            detail.owner.type === 'system'
              ? undefined
              : {
                  type: detail.owner.type,
                  id: detail.owner.id,
                  ...(detail.owner.name ? { name: detail.owner.name } : {}),
                },
          canUpdate: detail.canUpdate,
          navigationTarget: { kind: 'shared_skill', skillId: detail.id },
        }),
      ],
    );
  } catch (err: unknown) {
    return sharedResourceFailure(err, { unsupportedResource: 'skills' });
  }
}

/**
 * Asks the mounted share host for the common skill or plugin dialog. Unlike
 * `skills.share_custom`, nothing is published here: the user picks the
 * audience and confirms in the dialog, after any sign-in prompt. A successful
 * result therefore only means the request was accepted.
 */
async function openShareDialogResult(
  action: Extract<AppAdvisorAction, { type: 'sharing.open_dialog' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  if (useShareRequestStore.getState().hostCount === 0) {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message:
          'Sharing is not available in this window. Ask from a chat in the main app window.',
      },
    };
  }
  const target: ShareTarget =
    action.target.kind === 'skill'
      ? {
          kind: 'skill',
          sourceId:
            'sourceId' in action.target && action.target.sourceId
              ? action.target.sourceId
              : 'custom:app',
          name: action.target.name,
        }
      : action.target;
  if (target.kind === 'pipeline') {
    const loaded = await loadPipelineShareTargetDocument(target);
    if (!loaded.data || loaded.error !== undefined)
      return {
        ok: false,
        error: {
          code: 'invalid_target',
          message:
            "Couldn't open sharing for this item. Check that the pipeline and its project are available, then try again.",
          retryable: true,
        },
      };
  } else {
    let resolution: ReturnType<typeof resolveShareTarget>;
    try {
      const data = await loadChatShareLocalData(target.kind);
      resolution = resolveShareTarget(
        target,
        data.installedSkills,
        data.marketplaces,
      );
    } catch {
      resolution = { status: 'unknown' };
    }
    if (resolution.status === 'unknown') {
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Installed skills and plugins could not be read. Try again.',
          retryable: true,
        },
      };
    }
    if (resolution.status === 'ineligible') {
      return {
        ok: false,
        error: {
          code: 'invalid_target',
          message:
            target.kind === 'skill'
              ? 'No shareable installed skill matches this name and source.'
              : 'No shareable installed plugin matches this marketplace and name.',
        },
      };
    }
  }
  // Agent requests always open in the main window, including for a chat that
  // is popped out, so no originating document is passed.
  const requestId = requestShare(target, { source: 'agent' });
  if (requestId === null) {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message:
          'Sharing is not available in this window. Ask from a chat in the main app window.',
      },
    };
  }
  return {
    ok: true,
    result: {
      message: 'Share dialog requested; the user confirms in the app.',
    },
  };
}

async function importSharedSkillResult(
  action: Extract<AppAdvisorAction, { type: 'skills.import_shared' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    const detail = await window.skills.getShared(action.skillId);
    const local = await importSharedSkillIntoLocal(detail);
    window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
    return attachAgentArtifacts(
      { ok: true, result: local as unknown as AppAdvisorJson },
      [
        buildSkillArtifactReceipt({
          operation: action.type,
          source: 'installed',
          sourceId: 'custom:app',
          installedName: local.skillName,
          sharedSkillId: detail.id,
          name: local.skillName,
          description: detail.description,
          shareScope: detail.shareScope,
          canUpdate: true,
          navigationTarget: {
            kind: 'installed_skill',
            sourceId: 'custom:app',
            skillName: local.skillName,
          },
        }),
      ],
    );
  } catch (err: unknown) {
    return sharedResourceFailure(err, { unsupportedResource: 'skills' });
  }
}

async function updateSharedSkillResult(
  action: Extract<AppAdvisorAction, { type: 'skills.update_shared' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    const localSkillId = `custom:app/${action.name}`;
    const currentDetail = await window.skills.getShared(action.skillId);
    const rawSkill = await window.skills.readRawSkill(localSkillId);
    const detail = unwrapShareOperationResult(
      await window.skills.updateShared({
        skillId: action.skillId,
        rawSkill,
        expectedContentHash: currentDetail.contentHash,
      }),
    );
    return attachAgentArtifacts(
      { ok: true, result: detail as unknown as AppAdvisorJson },
      [
        buildSkillArtifactReceipt({
          operation: action.type,
          source: 'shared',
          sharedSkillId: detail.id,
          name: detail.name,
          description: detail.description,
          shareScope: detail.shareScope,
          owner:
            detail.owner.type === 'system'
              ? undefined
              : {
                  type: detail.owner.type,
                  id: detail.owner.id,
                  ...(detail.owner.name ? { name: detail.owner.name } : {}),
                },
          canUpdate: detail.canUpdate,
          navigationTarget: { kind: 'shared_skill', skillId: detail.id },
        }),
      ],
    );
  } catch (err: unknown) {
    return sharedResourceFailure(err, { unsupportedResource: 'skills' });
  }
}

async function deleteSharedSkillResult(
  action: Extract<AppAdvisorAction, { type: 'skills.delete_shared' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    await window.skills.deleteShared({ skillId: action.skillId });
    return {
      ok: true,
      result: { skillId: action.skillId },
    };
  } catch (err: unknown) {
    return sharedResourceFailure(err, {
      unsupportedResource: 'skills',
      deleteConflictMessage:
        'This skill is used by one or more Collections. Remove it from those Collections before deleting it.',
    });
  }
}

// ---------------------------------------------------------------------------
// Local + shared Collection action handlers.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Local + shared Agent action handlers.
// ---------------------------------------------------------------------------

async function listSharedAgentsResult(
  action: Extract<AppAdvisorAction, { type: 'agents.list_shared' }>,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    const response = await window.agents.listShared({
      ...(action.query ? { query: action.query } : {}),
      ...(action.limit ? { limit: action.limit } : {}),
      ...(action.cursor ? { cursor: action.cursor } : {}),
      ...(action.createdBy ? { createdBy: action.createdBy } : {}),
    });
    return {
      ok: true,
      result: {
        agents: response.agents as unknown as AppAdvisorJson,
        ...(response.nextCursor ? { nextCursor: response.nextCursor } : {}),
      },
    };
  } catch (err: unknown) {
    return sharedResourceFailure(err, { unsupportedResource: 'agents' });
  }
}

// ---------------------------------------------------------------------------
// Automations helpers (App Advisor → window.api.automations bridge)
// ---------------------------------------------------------------------------

/**
 * Coerce an {@link AutomationMutationResponse} into the dispatcher's
 * `{ ok, result?, error? }` shape. Backend errors are normalized to
 * `code: 'execution_failed'` so the App Advisor always sees a single failure
 * envelope regardless of which automations IPC failed. The success branch
 * forwards `activity` / `run` payloads so the assistant can quote the new
 * row id back to the user.
 */
async function resolveAutomationMutation(
  response: AutomationMutationResponse,
  operation?: 'automation.create' | 'automation.update' | 'automation.disable',
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  if (response.ok) {
    const result: Record<string, AppAdvisorJson> = {};
    if (response.activity) {
      result.activity = response.activity as unknown as AppAdvisorJson;
    }
    if (response.run) {
      result.run = response.run as unknown as AppAdvisorJson;
    }
    const success =
      Object.keys(result).length > 0
        ? { ok: true as const, result }
        : { ok: true as const };
    if (operation && response.activity) {
      try {
        const snapshot = await window.api.automations.list();
        const running = snapshot.recentRuns.some(
          (run) =>
            run.activityId === response.activity?.id &&
            run.status === 'running',
        );
        return attachAgentArtifacts(success, [
          appAdvisorAutomationReceipt(operation, response.activity, running),
        ]);
      } catch {
        // A legacy/sparse IPC test payload may omit receipt fields. The
        // successful mutation remains authoritative and must not be recast as
        // a failure because optional presentation metadata was incomplete.
      }
    }
    return success;
  }
  return {
    ok: false,
    error: { code: 'execution_failed', message: response.error },
  };
}

function automationExecutionFailure(error: unknown): {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
} {
  return {
    ok: false,
    error: {
      code: 'execution_failed',
      message:
        error instanceof Error ? error.message : 'Automation IPC failed.',
    },
  };
}

/** Reject agent-only automation policy violations at the renderer boundary. */
function rejectAdvisorAutomationPolicy(message: string): {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
} {
  return { ok: false, error: { code: 'invalid_payload', message } };
}

function formatMergePrRepos(
  repos: Array<{ repoName: string; prNumber?: number }>,
): string {
  return repos
    .map((repo) =>
      repo.prNumber === undefined
        ? repo.repoName
        : `${repo.repoName} (#${repo.prNumber})`,
    )
    .join(', ');
}

function formatBlockedMergePrRepos(
  repos: Array<{
    repoName: string;
    prNumber?: number;
    blockedReason?: MergePrBlockedReason;
  }>,
): string {
  return repos
    .map((repo) => {
      const reason =
        repo.blockedReason === 'has_conflicts'
          ? 'has conflicts'
          : repo.blockedReason === 'base_changed'
            ? 'base branch changed'
            : repo.blockedReason === 'in_merge_queue'
              ? 'already in the merge queue'
              : 'not mergeable';
      return repo.prNumber === undefined
        ? `${repo.repoName} (${reason})`
        : `${repo.repoName} #${repo.prNumber} (${reason})`;
    })
    .join(', ');
}

// Re-export the shared types as referenced symbols so TS keeps them around
// in the bundle (these helpers consume the types via the union resolution
// above; explicit re-imports keep tree-shaking happy if the union ever
// drops a variant).
export type { ScheduledActivity, ScheduledActivityRun };

// ---------------------------------------------------------------------------
// Panel-grid action helpers
// ---------------------------------------------------------------------------

interface PanelActionFailure {
  ok: false;
  error: AppAdvisorActionError;
}

interface PanelLayoutTarget {
  worktreeKey: string;
  layout: WorktreePanelLayout;
}

/**
 * `panel.add_tab` for the selected worktree's Chat visuals panel: show the
 * visuals of the chat whose tab is `chatTabId`, through the same opener a
 * visual's Expand uses.
 */
async function addChatVisualsPanelTab(
  chatTabId: string,
  worktreeKey: string,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const separator = worktreeKey.indexOf('/');
  const opened = await openDesktopChatVisualsPanel({
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
    chatId: chatTabId,
  });
  switch (opened.status) {
    case 'revealed':
    case 'placed':
      return { ok: true, result: { panelId: opened.location.panelId } };
    case 'missing-chat':
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: `Chat ${chatTabId} is not open in the selected worktree.`,
        },
      };
    case 'unavailable':
    case 'failed':
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Unable to add the panel tab.',
        },
      };
  }
}

/**
 * `panel.add_tab` for a tracked plan of the selected worktree: open (or
 * reveal where it already is) the plan's document or diagram panel in
 * `groupId` through the plan opener, never as a raw tab add.
 */
async function addPlanPanelTab(
  action: { kind: 'plan' | 'plan-diagram'; planId: string },
  worktreeKey: string,
  groupId: string,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const separator = worktreeKey.indexOf('/');
  const scope = {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
  const intent = { groupId, layoutKey: worktreeKey };
  const opened =
    action.kind === 'plan'
      ? await openPlanPanel(scope, action.planId, { intent })
      : await openPlanDiagramPanel(scope, action.planId, { intent });
  switch (opened.status) {
    case 'revealed':
    case 'placed':
      return { ok: true, result: { panelId: opened.location.panelId } };
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: `Tracked plan ${action.planId} was not found in the selected worktree.`,
        },
      };
    case 'failed':
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Unable to add the panel tab.',
        },
      };
  }
}

/** Open or reveal the selected worktree's Subagents singleton. */
async function addSubagentsPanelTab(
  worktreeKey: string,
  groupId: string | undefined,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const separator = worktreeKey.indexOf('/');
  const scope = {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
  const intent: SubagentPanelIntent =
    groupId === undefined ? 'auto' : { groupId, layoutKey: worktreeKey };
  const opened = await openSubagentsPanel(scope, { intent });
  switch (opened.status) {
    case 'revealed':
    case 'placed':
      return { ok: true, result: { panelId: opened.location.panelId } };
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'surface_unavailable',
          message:
            'The Subagents panel is not available in the selected worktree.',
        },
      };
    case 'failed':
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Unable to add the panel tab.',
        },
      };
  }
}

/**
 * Opens the selected scope's Cost panel, or one chat's Session breakdown, in
 * `groupId`; an open one is revealed where it is instead of being added
 * again (both kinds are unique per layout family).
 */
async function addCostPanelTab(
  action:
    | { readonly kind: 'cost' }
    | { readonly kind: 'session-breakdown'; readonly chatId: string },
  worktreeKey: string,
  groupId: string,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const separator = worktreeKey.indexOf('/');
  const scope = {
    projectId: worktreeKey.slice(0, separator),
    worktreeId: worktreeKey.slice(separator + 1),
  };
  let seed: ContentPanelSeed;
  if (action.kind === 'cost') {
    seed = costPanelSeed();
  } else {
    if (!isSessionBreakdownPanelInstance({ chatId: action.chatId })) {
      return {
        ok: false,
        error: {
          code: 'invalid_target',
          message: 'chatId must be a chat id of the selected worktree.',
        },
      };
    }
    seed = sessionBreakdownPanelSeed(
      action.chatId,
      sessionBreakdownTitleFor(scope, action.chatId),
    );
  }
  const opened = await openContentPanel(worktreeKey, seed, {
    intent: { kind: 'group', groupId },
  });
  switch (opened.status) {
    case 'revealed':
    case 'placed':
      return { ok: true, result: { panelId: opened.location.panelId } };
    case 'unavailable':
      return {
        ok: false,
        error: {
          code: 'surface_unavailable',
          message: 'Cost panels are not available in the selected worktree.',
        },
      };
    case 'failed':
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: 'Unable to add the panel tab.',
        },
      };
  }
}

/**
 * Panel actions operate on the currently selected worktree's panel grid.
 * Resolution mirrors the terminal/file actions: the chatStore selection is
 * the source of truth, and the layout must already be built (the grid host
 * builds it when the main page shows the worktree).
 */
function resolvePanelLayoutTarget(): PanelLayoutTarget | PanelActionFailure {
  const selected = useChatStore.getState().selectedWorktree;
  if (!selected) {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'No worktree is selected.',
        retryable: true,
      },
    };
  }
  const worktreeKey = makeWorktreePanelKey(
    selected.projectId,
    selected.worktreeId,
  );
  const layout = usePanelLayoutStore.getState().layouts[worktreeKey];
  if (!layout) {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message:
          'The selected worktree has no panel layout yet. Open the worktree on the main page first.',
        retryable: true,
      },
    };
  }
  return { worktreeKey, layout };
}

function isPanelActionFailure(
  value: PanelLayoutTarget | PanelActionFailure,
): value is PanelActionFailure {
  return 'ok' in value;
}

/**
 * Resolves the group a panel action targets: an explicit `groupId` when
 * provided, otherwise the layout's active group. Returns `null` when the
 * resolved group does not exist in the layout.
 */
function resolvePanelGroupId(
  layout: WorktreePanelLayout,
  explicitGroupId: string | undefined,
): string | null {
  const groupId = explicitGroupId ?? layout.activeGroupId;
  if (groupId === null || groupId === undefined) return null;
  return layout.groups[groupId] ? groupId : null;
}

function panelGroupNotFound(groupId: string | undefined): PanelActionFailure {
  return {
    ok: false,
    error: {
      code: 'not_found',
      message:
        groupId === undefined
          ? 'The panel layout has no active group.'
          : `Panel group ${groupId} was not found in the current layout.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Action routing
// ---------------------------------------------------------------------------

/** Why a catalog project Add cannot start, in the member's words. */
function orgProjectUnaddableReason(state: OrgProjectPlaceholderState): string {
  switch (state) {
    case 'offline':
      return "your organization can't be reached right now";
    case 'access-changed':
      return 'your access to it changed';
    default:
      return "it doesn't run on this computer";
  }
}

/**
 * Resolves true once `ready` holds for the store's state, false at the
 * deadline or when the request is cancelled.
 */
function waitForStoreState<T>(
  store: {
    getState(): T;
    subscribe(listener: (state: T) => void): () => void;
  },
  ready: (state: T) => boolean,
  deadline: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ready(store.getState())) return Promise.resolve(true);
  return new Promise((resolve): void => {
    const settle = (value: boolean): void => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = (): void => settle(false);
    const timer = setTimeout(onAbort, Math.max(0, deadline - Date.now()));
    const unsubscribe = store.subscribe((state): void => {
      if (ready(state)) settle(true);
    });
    signal?.addEventListener('abort', onAbort);
  });
}

/** The turn stopped while setup ran: it may still finish on its own. */
function stoppedWaitingForSetup(project: OrgProjectSummary): {
  ok: false;
  error: AppAdvisorActionError;
} {
  return {
    ok: false,
    error: {
      code: 'execution_failed',
      message: `Stopped waiting for ${project.name}; its setup may still finish in the background, and it is not on this computer yet.`,
    },
  };
}

/**
 * What a finished setup means for the Advisor: added only once a workspace
 * is bound to the project here. A setup that ends without one added nothing,
 * and the result says so rather than reporting success (CAN-3592).
 */
async function orgProjectSetupOutcomeReply(
  finished: OrgProjectSetupProgress,
  project: OrgProjectSummary,
  organizationName: string,
  reply: (
    status: 'setting_up' | 'awaiting_setup' | 'on_this_computer',
    message: string,
  ) => { ok: true; result: AppAdvisorJson },
  deadline: number,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  if (finished.state === 'cancelled')
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: `Setup of ${project.name} was cancelled; it is not on this computer.`,
      },
    };
  const bound = (projects: { projects: SidebarItem[] }): boolean =>
    projects.projects.some(
      (item): boolean =>
        item.owner?.type === 'organization' &&
        item.owner.projectId === project.id,
    );
  // The workspace reaches the projects store a moment after setup reports.
  // A failure can also be main's "already a workspace" for a project that
  // is bound here, so the binding decides, not the setup's own state.
  const boundSoon = await waitForStoreState(
    useProjectsStore,
    bound,
    Math.min(
      deadline,
      Date.now() + Math.min(3_000, orgProjectSetupOutcomeWaitMs),
    ),
    signal,
  );
  if (!boundSoon && signal?.aborted) return stoppedWaitingForSetup(project);
  const boundHere =
    boundSoon ||
    bound(
      await useProjectsStore
        .getState()
        .loadProjects({ silent: true })
        .catch((): void => {})
        .then((): { projects: SidebarItem[] } => useProjectsStore.getState()),
    );
  if (boundHere)
    return reply(
      'on_this_computer',
      `${project.name} is now on this computer in ${organizationName} and in the sidebar.`,
    );
  if (finished.state === 'failed')
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: `Couldn't set up ${project.name}: ${(finished.message ?? 'setup failed').replace(/[.\s]+$/, '')}. It is not on this computer.`,
      },
    };
  return {
    ok: false,
    error: {
      code: 'execution_failed',
      message: `Setup of ${project.name} ended without putting it on this computer, so nothing was added. Try the add again: setup releases what an earlier setup left behind and starts over.`,
    },
  };
}

/**
 * How long the Advisor's add waits for setup to finish before reporting it
 * under way, within the action's overall deadline.
 */
const ORG_PROJECT_SETUP_OUTCOME_WAIT_MS = 8_000;
const orgProjectSetupOutcomeWaitMs = ORG_PROJECT_SETUP_OUTCOME_WAIT_MS;

/**
 * The catalog's Add for App Advisor (CAN-3592): the sidebar lists only
 * projects on this computer, so listing alone adds nothing the member can
 * see. Sets the project up through the same routine as the dialog's Add and
 * reports where it stands, so the Advisor never calls a listing an add.
 */
async function addOrgProjectFromAdvisor(
  context: Extract<WorkspaceContext, { kind: 'organization' }>,
  project: OrgProjectSummary,
  signal?: AbortSignal,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const store = getOrgProjectAddStore();
  if (store === null)
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Organization projects are not available in this window.',
      },
    };
  const organizationName =
    useWorkspaceContextStore
      .getState()
      .state.organizations.find(
        (organization): boolean => organization.id === context.organizationId,
      )?.name || 'the organization';
  const alreadyHere = `${project.name} is already on this computer in ${organizationName}.`;
  const stillLoading: AppAdvisorActionError = {
    code: 'timeout',
    message: `Projects on this computer are still loading for ${organizationName}. Try again.`,
    retryable: true,
  };
  const reply = (
    status: 'setting_up' | 'awaiting_setup' | 'on_this_computer',
    message: string,
  ): { ok: true; result: AppAdvisorJson } => ({
    ok: true,
    result: {
      projectId: project.id,
      organizationId: project.organizationId,
      status,
      onThisComputer: status === 'on_this_computer',
      message,
    },
  });
  const cancelled: { ok: false; error: AppAdvisorActionError } = {
    ok: false,
    error: {
      code: 'execution_failed',
      message: `Adding ${project.name} was cancelled; nothing was added.`,
    },
  };
  // Every wait in the add fits one 20 second deadline, well inside main's 30
  // second tool budget; the calls between them are not bounded by it.
  const actionDeadline = Date.now() + 20_000;
  // A context switch answers the organization's links a moment later. Until
  // then a linked project looks unadded, and Add could clone it twice. The
  // links and project-load waits share the first 10 seconds.
  const deadline = Date.now() + 10_000;
  const linksAnswered = await waitForStoreState(
    useLinkedPersonalWorkspacesStore,
    (links): boolean => links.resolvedOrganizationId === context.organizationId,
    deadline,
    signal,
  );
  if (signal?.aborted) return cancelled;
  if (!linksAnswered) return { ok: false, error: stillLoading };
  await ensureProjectsHydrated();
  // An in-flight load finishes before the bound projects are read; main's
  // own "already a workspace" check backs this up if it runs out of time.
  await waitForStoreState(
    useProjectsStore,
    (projects): boolean => !projects.isLoading,
    deadline,
    signal,
  );
  if (signal?.aborted) return cancelled;
  const local = new Set([
    ...useProjectsStore
      .getState()
      .projects.flatMap((item): string[] =>
        item.owner?.type === 'organization' ? [item.owner.projectId] : [],
      ),
    ...useLinkedPersonalWorkspacesStore.getState().projectIds,
  ]);
  // Only a workspace bound or linked here counts. A READY instance alone can
  // be left over from a removed workspace, which setup releases and redoes.
  if (local.has(project.id)) return reply('on_this_computer', alreadyHere);
  const state = deriveOrgProjectPlaceholderState({
    project,
    snapshotError: null,
  });
  if (!isOrgProjectAddableState(state))
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: `${project.name} can't be set up on this computer: ${orgProjectUnaddableReason(state)}.`,
      },
    };
  const preferences = await window.api
    .loadPreferences()
    .catch((): null => null);
  const folder =
    preferences === null || preferences.__error !== undefined
      ? ''
      : (preferences.orgProjectDefaultDestinationRoot ?? '');
  if (signal?.aborted) return cancelled;
  // Setup reports its end through progress events; listen before it starts
  // so a quick finish is not missed. Main runs one setup per project and a
  // second start joins the running one, so the project's end is this setup's.
  const setupEnd: {
    finished: OrgProjectSetupProgress | null;
    onFinished: () => void;
  } = { finished: null, onFinished: (): void => {} };
  const stopListening = window.api.orgProjects.onSetupProgress(
    (progress): void => {
      if (
        progress.projectId !== project.id ||
        (progress.state !== 'ready' &&
          progress.state !== 'failed' &&
          progress.state !== 'cancelled')
      )
        return;
      setupEnd.finished = progress;
      setupEnd.onFinished();
    },
  );
  let outcome: OrgProjectAddOutcome;
  try {
    outcome = await addOrgProjectToComputer(store, {
      context,
      project,
      destination: orgProjectAddDestination(project, state, folder),
      signal,
    });
    if (
      outcome.kind === 'setup-started' &&
      setupEnd.finished === null &&
      signal?.aborted !== true
    )
      await new Promise<void>((resolve): void => {
        const settle = (): void => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', settle);
          resolve();
        };
        const timer = setTimeout(
          settle,
          Math.max(
            0,
            Math.min(orgProjectSetupOutcomeWaitMs, actionDeadline - Date.now()),
          ),
        );
        setupEnd.onFinished = settle;
        signal?.addEventListener('abort', settle);
      });
  } finally {
    stopListening();
  }
  if (outcome.kind === 'setup-started' && setupEnd.finished !== null)
    return orgProjectSetupOutcomeReply(
      setupEnd.finished,
      project,
      organizationName,
      reply,
      actionDeadline,
      signal,
    );
  if (outcome.kind === 'setup-started' && signal?.aborted)
    return stoppedWaitingForSetup(project);
  switch (outcome.kind) {
    case 'setup-started':
      return reply(
        'setting_up',
        `Setup of ${project.name} in ${organizationName} started; it is not on this computer yet. Its row in the sidebar shows progress until setup finishes.`,
      );
    case 'setup-requested':
      return reply(
        'awaiting_setup',
        `${project.name} is not on this computer yet: the setup dialog is open for the member to choose a folder and start it.`,
      );
    case 'linked':
      return reply('on_this_computer', alreadyHere);
    case 'links-unknown':
      return { ok: false, error: stillLoading };
    case 'cancelled':
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: `Adding ${project.name} was cancelled before setup; it is not on this computer.`,
        },
      };
    case 'listing-failed':
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: `Couldn't add ${project.name} to ${organizationName}. Try again.`,
        },
      };
    case 'setup-failed':
      return {
        ok: false,
        error: {
          code: 'execution_failed',
          message: `Couldn't set up ${project.name}: ${outcome.message}`,
        },
      };
  }
}

function orgProjectSetupStartResult(progress: OrgProjectSetupProgress): {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
} {
  return {
    ok: true,
    result: {
      projectId: progress.projectId,
      state: progress.state,
      message: progress.message,
      ...(progress.percent === null || progress.percent === undefined
        ? {}
        : { percent: progress.percent }),
    },
  };
}

// The catalog entry's requiredFeatureFlag governs discovery, not dispatch, so
// a skill suggestion action learned while the flag was on is refused after
// it turns off (CAN-385).
function skillSuggestionsAvailable(): boolean {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key);
}

function skillSuggestionsUnavailable(): {
  ok: false;
  error: AppAdvisorActionError;
} {
  return {
    ok: false,
    error: {
      code: 'surface_unavailable',
      message: 'Skill suggestions are not available.',
    },
  };
}

/**
 * Creates the member's own private Cowork project in the selected
 * organization (CAN-3453) through the same store method the Add project
 * dialog uses, then opens it. Never switches the workspace context.
 */
async function createOrgCoworkProjectFromAdvisor(name: string): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  // The catalog entry's requiredFeatureFlag governs discovery, not dispatch:
  // an action type learned while the feature was on must not still create a
  // project after it is turned off.
  if (
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
  ) {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Organization projects are not available.',
      },
    };
  }
  const { state, hydrated } = useWorkspaceContextStore.getState();
  const context = state.context;
  if (!hydrated || context.kind !== 'organization') {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Select an organization to create its projects.',
      },
    };
  }
  const organizationId = context.organizationId;
  const organizationName =
    state.organizations.find(
      (organization): boolean => organization.id === organizationId,
    )?.name || 'your organization';
  const projectName = name.trim();
  const failed = (
    message: string,
  ): { ok: boolean; error: AppAdvisorActionError } => ({
    ok: false,
    error: { code: 'execution_failed', message },
  });
  let created: CreateOrgCoworkProjectResult;
  try {
    created = await useStandaloneChatStore
      .getState()
      .createOrgCoworkProject({ organizationId, name: projectName });
  } catch {
    return failed(
      `Couldn't create ${projectName} in ${organizationName}. Try again.`,
    );
  }
  if (!created.ok) {
    switch (created.code) {
      case 'limit-reached':
        return failed(
          `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} private projects in ${organizationName}. Delete one to make another.`,
        );
      case 'setup-failed':
        return {
          ok: true,
          result: {
            projectId: created.organizationProjectId,
            organizationId,
            state: 'setup-failed',
            retryAction: {
              type: 'org_project.setup_start',
              projectId: created.organizationProjectId,
            },
            message: `${projectName} was created in ${organizationName}, but couldn't be set up on this computer. Use org_project.setup_start to try again.`,
          },
        };
      default:
        return failed(
          `Couldn't create ${projectName} in ${organizationName}. Try again.`,
        );
    }
  }
  const createdButNotOpened = (): {
    ok: true;
    result: AppAdvisorJson;
  } => ({
    ok: true,
    result: {
      projectId: created.organizationProjectId,
      organizationId,
      workspaceId: created.localWorkspaceId,
      state: 'created',
      opened: false,
      message: `Created ${projectName} in ${organizationName}, but couldn't open it. Open it from the project list.`,
    },
  });
  try {
    const opened = await useStandaloneChatStore
      .getState()
      .activateCreatedCoworkWorkspace(created.localWorkspaceId);
    if (!opened) return createdButNotOpened();
    useNavigationStore.getState().navigate('chat');
  } catch {
    return createdButNotOpened();
  }
  return {
    ok: true,
    result: {
      projectId: created.organizationProjectId,
      organizationId,
      workspaceId: created.localWorkspaceId,
      message: `Created ${projectName} in ${organizationName}.`,
    },
  };
}

/**
 * Creates the member's own private Code project in the selected organization
 * (CAN-3534) through the same store method and folder check the Add project
 * dialog uses, then opens it. With a folder, that git repository is used in
 * place: linked when the organization already has its project, created
 * otherwise. Without one, a new empty repository is started. Never switches
 * the workspace context.
 */
async function createOrgCodeProjectFromAdvisor(
  name: string,
  folderPath: string | undefined,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  // Discovery is gated by the catalog entry; dispatch re-checks, as the
  // Cowork create does.
  if (
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
  ) {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Organization projects are not available.',
      },
    };
  }
  const { state, hydrated } = useWorkspaceContextStore.getState();
  const context = state.context;
  if (!hydrated || context.kind !== 'organization') {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: 'Select an organization to create its projects.',
      },
    };
  }
  const organizationId = context.organizationId;
  const organizationName =
    state.organizations.find(
      (organization): boolean => organization.id === organizationId,
    )?.name || 'your organization';
  // Fails closed, like the dialog: an older server, or a main process that
  // cannot answer, offers no Code create.
  const eligibility = await window.api.orgProjects
    .getMemberCodeEligibility(organizationId)
    .catch((): 'ineligible' => 'ineligible');
  if (eligibility !== 'eligible') {
    return {
      ok: false,
      error: {
        code: 'surface_unavailable',
        message: `You can't create Code projects in ${organizationName} right now.`,
      },
    };
  }
  const failed = (
    message: string,
  ): { ok: boolean; error: AppAdvisorActionError } => ({
    ok: false,
    error: { code: 'execution_failed', message },
  });
  const path = folderPath?.trim();
  let projectName = name.trim();
  let linked = false;
  if (path !== undefined) {
    const inspection = await window.api.orgProjects
      .inspectFolder({ organizationId, path })
      .catch(
        (): OrgMemberFolderInspection => ({
          kind: 'refused',
          reason: 'unreadable',
        }),
      );
    if (inspection.kind === 'refused')
      return failed(
        orgCreateFolderRefusalText(inspection.reason, organizationName),
      );
    if (inspection.kind === 'cowork')
      return failed(
        "That folder isn't a git repository, so it can't be a Code project. Add it as a Cowork project from the Add project dialog.",
      );
    if (inspection.kind === 'multi-repo')
      return failed(
        'That folder is a multi-repo project. Add it from the Add project dialog.',
      );
    if (inspection.target !== 'new') {
      // The organization's project keeps its own name.
      projectName = inspection.target.projectName;
      linked = true;
    }
  }
  let created: CreateOrgMemberCodeProjectResult;
  try {
    created = await useProjectsStore.getState().createOrgMemberCodeProject({
      organizationId,
      name: projectName,
      ...(path === undefined ? {} : { folderPath: path }),
    });
  } catch {
    return failed(
      `Couldn't create ${projectName} in ${organizationName}. Try again.`,
    );
  }
  if (!created.ok) {
    switch (created.code) {
      case 'limit-reached':
        return failed(
          `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} private projects in ${organizationName}. Delete one to make another.`,
        );
      case 'refused':
        return failed(
          orgCreateFolderRefusalText(created.reason, organizationName),
        );
      case 'setup-failed':
        if (linked)
          return failed(
            `Couldn't set up ${projectName} on this computer. Try again.`,
          );
        // No retry action: `org_project.setup_start` clones, and this
        // project's files are already on this computer. The dialog's catalog
        // offers the right setup for it.
        return {
          ok: true,
          result: {
            projectId: created.organizationProjectId,
            organizationId,
            state: 'setup-failed',
            message: `${projectName} was created in ${organizationName}, but couldn't be set up on this computer. Add it from ${organizationName} in the Add project dialog to try again.`,
          },
        };
      default:
        return failed(
          `Couldn't create ${projectName} in ${organizationName}. Try again.`,
        );
    }
  }
  const receipt = {
    projectId: created.organizationProjectId,
    organizationId,
    workspaceId: created.localWorkspaceId,
  };
  try {
    navigateAfterRepositoryWorkspaceCreated(created.localWorkspaceId);
  } catch {
    return {
      ok: true,
      result: {
        ...receipt,
        state: 'created',
        opened: false,
        message: `${linked ? 'Linked' : 'Created'} ${projectName} in ${organizationName}, but couldn't open it. Open it from the project list.`,
      },
    };
  }
  return {
    ok: true,
    result: {
      ...receipt,
      message: linked
        ? `Linked this folder to ${projectName} in ${organizationName}.`
        : `Created ${projectName} in ${organizationName}.`,
    },
  };
}

type AdvisorMutationResponse = {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
};

async function ensureMultiRepoProjectsHydrated(): Promise<void> {
  const projects = useProjectsStore.getState();
  if (!projects.hasHydratedProjects)
    await projects.loadProjects({ silent: true, requireSuccess: true });
}

/**
 * Creates an empty multi-repo project in the selected Personal or
 * organization context (CAN-3573) through the Add project dialog's store
 * methods, then opens its settings on Repositories. The context is captured
 * before project hydration and eligibility, then rechecked before mutation;
 * it never switches context, falls back to Personal, or retries.
 */
async function createMultiRepoProjectFromAdvisor(
  name: string,
): Promise<AdvisorMutationResponse> {
  const projectName = name.trim();
  const unavailable = (message: string): AdvisorMutationResponse => ({
    ok: false,
    error: { code: 'surface_unavailable', message },
  });
  const failed = (message: string): AdvisorMutationResponse => ({
    ok: false,
    error: { code: 'execution_failed', message },
  });
  if (!useWorkspaceContextStore.getState().hydrated)
    await useWorkspaceContextStore.getState().hydrate();
  const captured = useWorkspaceContextStore.getState();
  // Personal is only the render default until main answers; never create
  // there on an unloaded context.
  if (!captured.hydrated)
    return unavailable("The selected context isn't loaded yet. Try again.");
  const context = captured.state.context;
  const contextKey = serializeWorkspaceContext(context);
  const contextUnchanged = (): boolean => {
    const current = useWorkspaceContextStore.getState();
    return (
      current.hydrated &&
      current.accountEpoch === captured.accountEpoch &&
      current.state.revision === captured.state.revision &&
      serializeWorkspaceContext(current.state.context) === contextKey
    );
  };
  const staleContext: AdvisorMutationResponse = {
    ok: false,
    error: {
      code: 'stale_ui_state',
      message: 'The selected context changed. Nothing was created.',
    },
  };
  const created = (
    receipt: Record<string, AppAdvisorJson>,
    workspaceId: string,
    where: string,
  ): AdvisorMutationResponse => {
    try {
      openCreatedMultiRepoWorkspaceSettings(workspaceId);
    } catch {
      return {
        ok: true,
        result: {
          ...receipt,
          state: 'created',
          settingsOpened: false,
          message: `Created ${projectName}${where}, but couldn't open its settings. Open project settings to add repositories.`,
        },
      };
    }
    return {
      ok: true,
      result: {
        ...receipt,
        state: 'created',
        settingsOpened: true,
        message: `Created ${projectName}${where}. Add its repositories in project settings.`,
      },
    };
  };

  try {
    await ensureMultiRepoProjectsHydrated();
  } catch {
    return unavailable("Projects aren't loaded yet. Try again.");
  }
  if (!contextUnchanged()) return staleContext;

  if (context.kind !== 'organization') {
    let workspaceId: string;
    try {
      workspaceId = await useProjectsStore
        .getState()
        .createWorkspace(projectName);
    } catch {
      return failed(
        `Couldn't create ${projectName}. Check the project list before trying again.`,
      );
    }
    return created({ workspaceId }, workspaceId, '');
  }

  // Dispatch re-checks the flag, as the other organization creates do.
  if (
    !useFeatureFlagsStore
      .getState()
      .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
  )
    return unavailable('Organization projects are not available.');
  const organizationId = context.organizationId;
  const organizationName =
    captured.state.organizations.find(
      (organization): boolean => organization.id === organizationId,
    )?.name || 'your organization';
  // Fails closed, like the dialog.
  const eligibility = await window.api.orgProjects
    .getMemberCodeEligibility(organizationId)
    .catch((): 'ineligible' => 'ineligible');
  if (!contextUnchanged()) return staleContext;
  if (eligibility !== 'eligible')
    return unavailable(
      `You can't create projects in ${organizationName} right now.`,
    );
  let result: CreateOrgMemberMultiRepoProjectResult;
  try {
    result = await useProjectsStore
      .getState()
      .createOrgMemberMultiRepoProject({ organizationId, name: projectName });
  } catch {
    return failed(
      `Couldn't create ${projectName} in ${organizationName}. Check the project list before trying again.`,
    );
  }
  if (result.ok)
    return created(
      {
        workspaceId: result.localWorkspaceId,
        organizationId,
        projectId: result.organizationProjectId,
      },
      result.localWorkspaceId,
      ` in ${organizationName}`,
    );
  switch (result.code) {
    case 'limit-reached':
      return failed(
        `You've reached the limit of ${MEMBER_ORG_PROJECT_LIMIT} private projects in ${organizationName}. Delete one to make another.`,
      );
    case 'refused':
      return failed(
        orgCreateFolderRefusalText(
          result.reason,
          organizationName,
          result.repositories,
        ),
      );
    case 'unavailable':
      return unavailable(
        `Projects in ${organizationName} aren't available right now.`,
      );
    case 'setup-failed':
      // Partial success: the local project exists. Recovery is the dialog's
      // Try again, not another create or `org_project.setup_start`.
      return {
        ok: true,
        result: {
          workspaceId: result.localWorkspaceId,
          organizationId,
          state: 'setup-failed',
          message: `${projectName} was created in ${organizationName}, but couldn't be set up on this computer. Use Try again in the Add project dialog.`,
        },
      };
    case 'create-failed':
      return failed(
        `Couldn't create ${projectName} in ${organizationName}. Try again.`,
      );
  }
}

/**
 * The multi-repo project a repository action targets. Its own ownership
 * decides organization checks, not the selected context.
 */
async function getMultiRepoWorkspaceOrError(
  workspaceId: string,
): Promise<MultiRepoSidebarItem | { error: AppAdvisorActionError }> {
  await ensureMultiRepoProjectsHydrated();
  const workspace = getWorkspaceOrError(workspaceId);
  if ('error' in workspace) return workspace;
  if (workspace.type !== 'multi-repo')
    return {
      error: {
        code: 'invalid_target',
        message: `Project ${workspaceId} isn't a multi-repo project.`,
      },
    };
  return workspace;
}

function findMultiRepoWorkspace(
  workspaceId: string,
): MultiRepoSidebarItem | undefined {
  const workspace = useProjectsStore
    .getState()
    .projects.find((item) => item.id === workspaceId);
  return workspace?.type === 'multi-repo' ? workspace : undefined;
}

/**
 * Adds a local checkout through the project settings path (CAN-3573), which
 * keeps main's Git validation, organization repository checks, server
 * synchronization, and rollback. The exact-path duplicate check matches
 * settings; it is not an atomic guard against aliases or concurrent adds.
 */
async function addRepoToMultiRepoProjectFromAdvisor(
  workspaceId: string,
  repoPath: string,
): Promise<AdvisorMutationResponse> {
  const workspace = await getMultiRepoWorkspaceOrError(workspaceId);
  if ('error' in workspace) return { ok: false, error: workspace.error };
  if (workspace.repos.some((repo) => repo.repoPath === repoPath))
    return {
      ok: false,
      error: {
        code: 'invalid_target',
        message: `${workspace.name} already has the repository at ${repoPath}.`,
      },
    };
  try {
    await useProjectsStore
      .getState()
      .addRepoToWorkspace(workspaceId, repoPath, false);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: extractIpcErrorMessage(cause),
      },
    };
  }
  const repo = findMultiRepoWorkspace(workspaceId)?.repos.find(
    (item) => item.repoPath === repoPath,
  );
  if (!repo)
    return {
      ok: true,
      result: {
        workspaceId,
        message: `Added the repository to ${workspace.name}. Use workspace.list to find its ID.`,
      },
    };
  return {
    ok: true,
    result: {
      workspaceId,
      repo: {
        id: repo.id,
        name: repo.name,
        repoPath: repo.repoPath,
        source: repo.source ?? 'local',
      },
      message: `Added ${repo.name} to ${workspace.name}.`,
    },
  };
}

/**
 * Removes a repository from the project configuration through the project
 * settings path (CAN-3573); worktree checkouts stay on disk. The project root
 * is not a configured repository and is never removed here.
 */
async function removeRepoFromMultiRepoProjectFromAdvisor(
  workspaceId: string,
  repoId: string,
): Promise<AdvisorMutationResponse> {
  const workspace = await getMultiRepoWorkspaceOrError(workspaceId);
  if ('error' in workspace) return { ok: false, error: workspace.error };
  if (repoId === WORKSPACE_ROOT_REPO_ID)
    return {
      ok: false,
      error: {
        code: 'invalid_target',
        message: `The project root of ${workspace.name} can't be removed.`,
      },
    };
  const repo = workspace.repos.find((item) => item.id === repoId);
  if (!repo)
    return {
      ok: false,
      error: {
        code: 'not_found',
        message: `Repository ${repoId} was not found in ${workspace.name}.`,
      },
    };
  try {
    await useProjectsStore
      .getState()
      .removeRepoFromWorkspace(workspaceId, repoId);
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: extractIpcErrorMessage(cause),
      },
    };
  }
  const removed = `Removed ${repo.name} from ${workspace.name}. Its worktree checkouts stay on disk.`;
  const refreshed = findMultiRepoWorkspace(workspaceId);
  if (!refreshed)
    return {
      ok: true,
      result: {
        workspaceId,
        removedRepoId: repoId,
        removedRepoName: repo.name,
        message: `${removed} Use workspace.list to see its remaining repositories.`,
      },
    };
  return {
    ok: true,
    result: {
      workspaceId,
      removedRepoId: repoId,
      removedRepoName: repo.name,
      remainingRepoCount: refreshed.repos.filter(
        (item) => item.id !== WORKSPACE_ROOT_REPO_ID,
      ).length,
      message: removed,
    },
  };
}

async function sidebarGroupsForListing(
  scope: SidebarItemGroupScope,
): Promise<Awaited<ReturnType<typeof window.api.sidebarItemGroups.list>>> {
  return window.api.sidebarItemGroups.list(scope);
}

async function codeSidebarGroupIdsForListing(
  projectId: string,
  worktrees: readonly WorktreeData[],
  groupingEnabled?: () => Promise<boolean>,
): Promise<Map<string, string>> {
  if (worktrees.length === 0) return new Map();
  const groups = await sidebarGroupsForListing({ workspaceLocalId: projectId });
  if (groups.length === 0) return new Map();
  const groupChildBranchesWithBase = groupingEnabled
    ? await groupingEnabled()
    : (await window.api.loadPreferences()).groupChildBranchesWithBase;
  return sidebarItemGroupIds(
    groups,
    sidebarGroupStackUnits(worktrees, groupChildBranchesWithBase),
  );
}

type RemoteControlAction = Extract<
  AppAdvisorAction,
  { type: 'remote_control.open_computer' }
>;

/** What App Advisor may see: no pairing codes or connection errors. */
interface RemoteControlActionResult {
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}

async function dispatchRemoteControlAction(
  action: RemoteControlAction,
): Promise<RemoteControlActionResult> {
  const unavailable: RemoteControlActionResult = {
    ok: false,
    error: {
      code: 'surface_unavailable',
      message: 'Remote control is not available.',
    },
  };
  const remote = window.api.remoteControl;
  let state: RemoteControlState;
  try {
    state = await remote.getState();
  } catch {
    return unavailable;
  }
  if (!state.available) return unavailable;
  try {
    const { deviceId } = action;
    if (
      deviceId !== null &&
      !state.hosts.some((host) => host.deviceId === deviceId)
    ) {
      return {
        ok: false,
        error: {
          code: 'invalid_payload',
          message: 'That computer is not paired with this one.',
        },
      };
    }
    await remote.openMachine(deviceId);
    return { ok: true, result: { opened: deviceId ?? 'this-computer' } };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message:
          error instanceof Error ? error.message : 'Remote control failed.',
      },
    };
  }
}

async function routeAction(
  request: AppAdvisorActionRequest,
  originChatTabId?: string,
  signal?: AbortSignal,
  requestId?: string,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  const { action } = request;
  switch (action.type) {
    case 'navigation.go_to_page': {
      const requestedPage: string = action.page;
      if (requestedPage === LEGACY_AGENTS_PAGE) {
        const unavailable = agentsMarketplaceUnavailable();
        if (unavailable) return { ok: false, error: unavailable };
        useNavigationStore.getState().openPluginsNavigation({
          kind: 'marketplace-browse',
          query: '',
          tab: 'agent',
        });
        return { ok: true };
      }
      // Refuse before any navigation or tab side effect. Discovery results
      // can be stale, so this check is the authoritative one.
      const availability = getPageAvailability(action.page);
      if (!availability.available) {
        return { ok: false, error: pageUnavailableError(availability) };
      }
      if (
        action.page === 'feed' &&
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'The Feed is not available.',
          },
        };
      }
      // A legacy Automations tab opens the Workflows tab (or, for the retired
      // Shared tab, the Marketplace filter) it became (CAN-3980).
      if (action.page === 'automations' && action.tab) {
        openLegacyAutomationsTab(action.tab);
      } else {
        useNavigationStore.getState().navigate(action.page);
      }
      return { ok: true };
    }
    case 'navigation.go_back':
    case 'navigation.go_forward': {
      const history = useNavigationHistoryStore.getState();
      const moved =
        action.type === 'navigation.go_back'
          ? history.goBack()
          : history.goForward();
      if (!moved) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message:
              action.type === 'navigation.go_back'
                ? 'There is no earlier location in the navigation history.'
                : 'There is no later location in the navigation history.',
          },
        };
      }
      return {
        ok: true,
        result: { page: useNavigationStore.getState().activePage },
      };
    }
    case 'navigation.open_chat_turn': {
      const result = await openChatTurnDestination({
        projectId: action.projectId,
        ...(action.worktreeId ? { worktreeId: action.worktreeId } : {}),
        chatId: action.chatId,
        userMessageId: action.userMessageId,
      });
      if (!result.ok) {
        return {
          ok: false,
          error: { code: 'not_found', message: result.error },
        };
      }
      return { ok: true };
    }
    case 'navigation.open_settings':
      if (action.section === 'claude' && !isClaudeSettingsAvailable()) {
        return { ok: false, error: claudeSettingsUnavailableError() };
      }
      useNavigationStore.getState().openSettings(action.section);
      return { ok: true };
    case 'navigation.open_workspace_settings': {
      const workspace = useProjectsStore
        .getState()
        .projects.find((candidate) => candidate.id === action.workspaceId);
      if (!workspace) {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Project not found.' },
        };
      }
      const requestedTab = action.tab ?? 'details';
      if (
        requestedTab === 'code-graph' &&
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Code Graph is not available.',
          },
        };
      }
      const tabIsUnavailable =
        (workspace.type === 'cowork' &&
          requestedTab !== 'details' &&
          requestedTab !== 'environment') ||
        (workspace.type === 'single-repo' && requestedTab === 'repositories');
      if (tabIsUnavailable) {
        const tabLabel =
          requestedTab === 'code-graph'
            ? 'Code Graph'
            : `${requestedTab.charAt(0).toUpperCase()}${requestedTab.slice(1)}`;
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `${tabLabel} settings are not available for this project.`,
          },
        };
      }
      useNavigationStore.getState().openWorkspaceSettings({
        workspaceId: action.workspaceId,
        initialTab: requestedTab,
      });
      return { ok: true };
    }
    case 'navigation.open_code_graph': {
      if (
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopWorkspaceCodeGraph.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Code Graph is not available.',
          },
        };
      }
      const workspace = useProjectsStore
        .getState()
        .projects.find(
          (candidate) =>
            candidate.id === action.workspaceId && candidate.type !== 'cowork',
        );
      if (!workspace) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: 'Project not found.',
          },
        };
      }
      useNavigationStore.getState().openWorkspaceSettings({
        workspaceId: action.workspaceId,
        initialTab: 'code-graph',
      });
      return { ok: true };
    }
    case 'navigation.open_customize_sidebar':
      useNavigationStore.getState().requestCustomizeSidebar();
      return { ok: true };
    case 'navigation.close_settings':
      useNavigationStore.getState().closeSettings();
      return { ok: true };
    case 'chat.set_harness':
      return dispatchChatHarnessAction(action.pickerId, action.harness)
        ? { ok: true, result: { started: true } }
        : {
            ok: false,
            error: {
              code: 'surface_unavailable',
              message:
                'This harness choice is unavailable. Refresh the current UI state.',
            },
          };
    case 'cursor.connection':
    case 'cursor.approval_check': {
      if (
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key)
      ) {
        return {
          ok: false,
          error: { code: 'execution_failed', message: 'Cursor is disabled.' },
        };
      }
      useNavigationStore.getState().openSettings(getCursorSettingsSection());
      const accepted = await dispatchCursorSettingsAction(action);
      return accepted
        ? { ok: true, result: { started: true } }
        : {
            ok: false,
            error: {
              code: 'execution_failed',
              message:
                'Cursor action unavailable. Check the Cursor panel in Settings.',
            },
          };
    }
    case 'workspace_context.switch': {
      if (
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Workspace context switching is not available.',
          },
        };
      }
      try {
        // The same main-owned switch the sidebar picker and Cmd+K use, so a
        // stale revision or a lost membership is refused the same way.
        const state = await useWorkspaceContextStore
          .getState()
          .setContext(action.context);
        return {
          ok: true,
          result: {
            context: state.context,
            organizationCount: state.organizations.length,
          },
        };
      } catch (error: unknown) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to switch the workspace context.',
          },
        };
      }
    }
    case 'settings.review_privacy_opt_in': {
      const organizationId = normalizeUuid(action.organizationId);
      if (!organizationId) {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'organizationId must be an organization UUID.',
          },
        };
      }
      // Opens the confirmation only; the user saves or cancels in the sheet.
      useNavigationStore
        .getState()
        .openPrivacyOptIn({ feature: action.feature, organizationId });
      return { ok: true, result: { opened: true } };
    }
    case 'canopy_cloud.load_account':
    case 'canopy_cloud.validate_api_key':
    case 'canopy_cloud.save_api_key':
    case 'canopy_cloud.clear_api_key':
    case 'canopy_cloud.start_oauth_login':
    case 'canopy_cloud.cancel_oauth_login':
    case 'canopy_cloud.disconnect':
    case 'canopy_portal.start':
    case 'canopy_portal.stop':
    case 'remote_control.get_state':
    case 'remote_control.set_allow_incoming':
    case 'opencode.connection':
    case 'ollama.install':
      // CAN-6008: the App Advisor runtime runs credential and remote-access
      // actions in main, only while this window's lease is bound; these
      // never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message:
            'Credential and remote-access actions run in the main process.',
        },
      };
    case 'remote_control.open_computer':
      return dispatchRemoteControlAction(action);
    case 'settings.personalCatalog.set': {
      if (
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Personal project catalog enrollment is not available.',
          },
        };
      }
      const stale = enforceExpectedRevision(request, true);
      if (stale) return stale;
      try {
        await window.api.savePreferences({
          personalWorkspaceCatalogSync: action.enabled ? 'private' : 'off',
          personalCatalogOfferSeen: true,
          personalCatalogNotice: null,
        });
        return { ok: true, result: { enabled: action.enabled } };
      } catch {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Could not save your choice. Try again.',
          },
        };
      }
    }
    case 'account_proxy.set_routing':
    case 'account_proxy.status':
    case 'app_advisor.update_settings':
    case 'settings.get_claude_max_turns':
    case 'settings.get_handoff_model':
    case 'settings.get_local_memory_model':
    case 'settings.set_claude_max_turns':
    case 'settings.set_handoff_model':
    case 'settings.set_launch_at_login':
    case 'settings.set_ledger_agent_recording_enabled':
    case 'settings.set_local_memory_enabled':
    case 'settings.set_local_memory_model':
    case 'settings.set_managed_delegation_max_depth':
    case 'settings.set_managed_delegation_mode':
    case 'settings.set_navigation_mode':
    case 'settings.set_profile_role':
    case 'settings.set_skill_suggestions_enabled':
      // CAN-6004: the App Advisor runtime runs settings actions in main
      // through core.config.*; these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Settings actions run in the main process.',
        },
      };
    case 'settings.open_memory_folder': {
      try {
        await window.api.openMemoryDir();
        return { ok: true };
      } catch (error: unknown) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to open the local memory folder.',
          },
        };
      }
    }
    case 'memory.consolidate_now':
    case 'memory.import_external':
    case 'memory.list_snapshots':
    case 'memory.rebuild':
    case 'memory.restore_snapshot':
      // CAN-6005: the App Advisor runtime runs these in main through the
      // core.memory maintenance operations, a rebuild, restore or import only
      // after a person confirms; they never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Memory actions run in the main process.',
        },
      };
    case 'navigation.open_import_projects':
      openImportProjectsModal({ source: 'app-advisor' });
      return { ok: true };
    case 'script_actions.open_review': {
      const opened = requestScriptActionsReview({
        projectId: action.workspaceId,
        worktreeId: action.inWorktreeId,
        source: 'app-advisor',
      });
      return opened
        ? { ok: true }
        : {
            ok: false,
            error: {
              code: 'surface_unavailable',
              message: 'Script review is unavailable in this window.',
            },
          };
    }
    case 'script_actions.list':
    case 'script_actions.rescan':
    case 'script_actions.set_pin':
    case 'script_actions.set_shortcut':
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: `Script preferences must use the ${ORCHESTRATOR_LABEL} host port.`,
        },
      };
    case 'cloud_chats.list':
      return listCloudChatsForAdvisor();
    case 'cloud_chats.open':
      return openCloudChatForAdvisor(action.chatId);
    case 'navigation.open_editor_setup': {
      // Without a project the review asks the member to choose one rather
      // than picking one from collection order.
      if (action.workspaceId === undefined) {
        openRepoRulesModal({ source: 'app-advisor' });
        return { ok: true };
      }
      const workspaceId = action.workspaceId;
      const isCodeProject = useProjectsStore
        .getState()
        .projects.some(
          (candidate) =>
            candidate.id === workspaceId && candidate.type !== 'cowork',
        );
      if (!isCodeProject) {
        return {
          ok: false,
          error: { code: 'not_found', message: 'Code project not found.' },
        };
      }
      openRepoRulesModal({ source: 'app-advisor', workspaceId });
      return { ok: true };
    }
    case 'navigation.open_command_palette':
      useNavigationStore.getState().openCommandPalette(action.query ?? '');
      return { ok: true };
    case 'navigation.open_file_search':
      useNavigationStore.getState().openFileSearchPalette(action.query ?? '');
      return { ok: true };
    case 'file-tree.set_search': {
      let fileTreeSearchHandled = false;
      window.dispatchEvent(
        new CustomEvent(FILE_TREE_SET_SEARCH_EVENT, {
          detail: {
            projectId: action.projectId,
            worktreeId: action.worktreeId,
            query: action.query,
            acknowledge: (): void => {
              fileTreeSearchHandled = true;
            },
          },
        }),
      );
      if (!fileTreeSearchHandled) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: 'No active file explorer matched the requested target.',
          },
        };
      }
      return {
        ok: true,
        result: {
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          open: action.query.trim().length > 0,
        },
      };
    }
    case 'file-tree.create_file':
    case 'file-tree.create_directory':
    case 'file-tree.copy':
    case 'file-tree.move':
    case 'file-tree.delete':
      // CAN-6006: the App Advisor runtime creates, copies, moves and deletes
      // file tree entries in main; these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'File tree changes run in the main process.',
        },
      };
    case 'navigation.open_pr_picker':
      useNavigationStore.getState().openPrPicker([]);
      return { ok: true };
    case 'usage.open_resume_modal':
      useUsageLimitResumePromptStore
        .getState()
        .open(
          action.provider ?? null,
          action.provider === undefined ? 'home' : 'usage-review',
        );
      return {
        ok: true,
        result: {
          provider: action.provider ?? null,
          origin: action.provider === undefined ? 'home' : 'usage-review',
        },
      };
    case 'usage.open_resume_queue': {
      const snapshot = await window.api.getResumeQueue();
      useResumeQueueStore.getState().apply(snapshot);
      useResumeQueueStore.getState().open();
      return { ok: true, result: { revision: snapshot.revision } };
    }
    case 'usage.control_resume_queue': {
      const snapshot = await window.api.controlResumeQueue(action.action);
      useResumeQueueStore.getState().apply(snapshot);
      if (action.action === 'dismiss') useResumeQueueStore.getState().close();
      return { ok: true, result: { revision: snapshot.revision } };
    }
    case 'skills.open_manager':
      useNavigationStore.getState().navigate('plugins');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      window.dispatchEvent(
        new CustomEvent(PLUGINS_OPEN_TAB_EVENT, { detail: { tab: 'skills' } }),
      );
      return { ok: true };
    case 'skill_suggestions.open':
      if (!skillSuggestionsAvailable()) return skillSuggestionsUnavailable();
      useSkillSuggestionStore.getState().setModalOpen(true);
      return { ok: true };
    case 'skills.list':
      return listSkillsResult(action);
    case 'skills.open_viewer':
      return openSkillViewerResult(action);
    case 'skills.read':
      return readSkillResult(action);
    case 'skills.read_file':
      return readSkillFileResult(action);
    case 'skills.create_custom':
      return saveCustomSkillResult(
        {
          name: action.name,
          description: action.description,
          body: action.body,
          ...(action.extraMetadata
            ? { extraMetadata: action.extraMetadata }
            : {}),
        },
        action.type,
      );
    case 'skills.update_custom':
      return updateCustomSkillResult(action);
    case 'skills.delete_custom':
      return deleteCustomSkillResult(action);
    case 'skills.list_shared':
      return listSharedSkillsResult(action);
    case 'skills.read_shared':
      return readSharedSkillResult(action);
    case 'skills.share_custom':
      return shareCustomSkillResult(action);
    case 'sharing.open_dialog':
      return openShareDialogResult(action);
    case 'skills.import_shared':
      return importSharedSkillResult(action);
    case 'skills.update_shared':
      return updateSharedSkillResult(action);
    case 'skills.delete_shared':
      return deleteSharedSkillResult(action);
    case 'collections.open_manager': {
      useNavigationStore.getState().navigate('plugins');
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      window.dispatchEvent(
        new CustomEvent(PLUGINS_OPEN_TAB_EVENT, {
          detail: { tab: 'collections' },
        }),
      );
      return { ok: true };
    }
    case 'collections.share':
    case 'collections.list_shared':
    case 'collections.import_shared':
    case 'collections.update_shared':
    case 'collections.delete_shared':
      // CAN-6003 part B: the App Advisor runtime runs collection sharing in
      // main; these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Collection sharing actions run in the main process.',
        },
      };
    case 'agents.open_manager': {
      const unavailable = agentsMarketplaceUnavailable();
      if (unavailable) return { ok: false, error: unavailable };
      useNavigationStore.getState().openPluginsNavigation({
        kind: 'marketplace-browse',
        query: '',
        tab: 'agent',
      });
      return { ok: true };
    }
    case 'agents.list_shared':
      return listSharedAgentsResult(action);
    case 'plugins.open_marketplaces':
      openMarketplacesTab();
      return { ok: true };
    case 'mcp.account_connect':
    case 'mcp.account_reconnect':
    case 'mcp.account_disconnect':
    case 'mcp.account_promote':
    case 'mcp.account_edit': {
      let handled = false;
      let refusal: string | undefined;
      const operations = {
        'mcp.account_connect': 'connect',
        'mcp.account_reconnect': 'reconnect',
        'mcp.account_disconnect': 'disconnect',
        'mcp.account_promote': 'promote',
        'mcp.account_edit': 'edit',
      } as const;
      const detail: AccountMcpActionEventDetail = {
        operation: operations[action.type],
        serverId: action.serverId,
        acknowledge: (): void => {
          handled = true;
        },
        refuse: (message: string): void => {
          refusal = message;
        },
      };
      window.dispatchEvent(
        new CustomEvent(ACCOUNT_MCP_ACTION_EVENT, { detail }),
      );
      return handled
        ? { ok: true }
        : {
            ok: false,
            error: {
              code: 'invalid_target',
              message:
                refusal ??
                `Open MCP servers in ${CUSTOMIZE_LABEL} and choose an available server action.`,
            },
          };
    }
    case 'plugins.open_mcp_browse':
      openMcpBrowse();
      return { ok: true };
    case 'plugins.open_management': {
      const section = action.section ?? 'installed';
      openPluginsManagement(section);
      return { ok: true, result: { section } };
    }
    case 'plugins.open_entry_detail':
      openPluginsEntryDetail(action.entryId, action.intent);
      return { ok: true, result: { entryId: action.entryId } };
    case 'workspace.open_add_dialog': {
      useNavigationStore.getState().openAddWorkspaceModal();
      return { ok: true, result: {} };
    }
    case 'workspace.open_clone_progress': {
      const cloneJobs = useCloneJobsStore.getState();
      cloneJobs.hydrate(await window.api.listCloneJobs());
      const summary = summarizeCloneJobs(useCloneJobsStore.getState().jobs);
      if (summary) cloneJobs.open();
      return {
        ok: true,
        result: {
          running: summary?.running ?? 0,
          failed: summary?.failed ?? 0,
        },
      };
    }
    case 'workspace.add_org_project': {
      // The catalog entry's requiredFeatureFlag governs discovery, not
      // dispatch: an action type learned while the feature was on must not
      // still write a preference after it is turned off.
      if (
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyOrgProjectsEnabled.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Organization projects are not available.',
          },
        };
      }
      const { state, hydrated } = useWorkspaceContextStore.getState();
      const context = state.context;
      if (hydrated === false || context.kind === 'personal') {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Select an organization to add its projects.',
          },
        };
      }
      const snapshot = await window.api.orgProjects.list({
        context,
      });
      const project = snapshot.projects.find(
        (candidate): boolean =>
          snapshot.context === `org:${context.organizationId}` &&
          candidate.id === action.projectId &&
          candidate.organizationId === context.organizationId &&
          // An archived project, or one this member cannot use, is excluded
          // from the catalog: adding it would write a preference that can
          // never make it listed and report success for nothing.
          candidate.state === 'ACTIVE' &&
          candidate.capabilities.use,
      );
      if (project === undefined) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: 'Project not found in the selected organization.',
          },
        };
      }
      return addOrgProjectFromAdvisor(context, project, signal);
    }
    case 'org_project.setup_start':
    case 'org_project.setup_cancel': {
      // Organization projects only exist inside an organization context, and
      // the catalog is main-owned, so every case reads the context first and
      // then goes through the preload API rather than the renderer store.
      const contextState = useWorkspaceContextStore.getState();
      const context = contextState.state.context;
      if (!contextState.hydrated || context.kind !== 'organization') {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'Organization projects are only available while an organization context is selected. Choose an organization from the context switcher above the account in the sidebar first.',
          },
        };
      }
      if (action.type === 'org_project.setup_start') {
        // A Cowork project has no repository to clone: main sets it up in an
        // app-managed folder, so there is no destination to ask for.
        const catalog = await window.api.orgProjects.refresh({
          context,
          force: true,
        });
        const cowork = catalog.projects.some(
          (project): boolean =>
            project.id === action.projectId && project.kind === 'COWORK',
        );
        if (cowork) {
          return orgProjectSetupStartResult(
            await window.api.orgProjects.setupStart({
              projectId: action.projectId,
            }),
          );
        }
        const preferences = await window.api.loadPreferences();
        let destinationRoot = preferences.orgProjectDefaultDestinationRoot;
        if (!destinationRoot) {
          const choice = await window.api.browseForCloneDirectory();
          if (choice.canceled || !choice.directoryPath)
            return {
              ok: true,
              result: { projectId: action.projectId, state: 'cancelled' },
            };
          destinationRoot = choice.directoryPath;
          await window.api.savePreferences({
            orgProjectDefaultDestinationRoot: destinationRoot,
          });
        }
        return orgProjectSetupStartResult(
          await window.api.orgProjects.setupStart({
            projectId: action.projectId,
            destinationRoot,
          }),
        );
      }
      await window.api.orgProjects.setupCancel({ projectId: action.projectId });
      return { ok: true, result: { projectId: action.projectId } };
    }
    case 'org_project.open_move_to_organization': {
      await ensureProjectsHydrated();
      // Opens the dialog only; the move stays the user's click.
      if (!openMoveToOrganizationModal(action.workspaceId)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'Move to organization is available only for a Personal project while Personal is selected and you belong to an organization.',
          },
        };
      }
      return { ok: true, result: { workspaceId: action.workspaceId } };
    }
    case 'org_project.create_cowork':
      return createOrgCoworkProjectFromAdvisor(action.name);
    case 'org_project.create_code':
      return createOrgCodeProjectFromAdvisor(action.name, action.folderPath);
    case 'workspace.create_multi_repo':
      return createMultiRepoProjectFromAdvisor(action.name);
    case 'workspace.add_repo':
      return addRepoToMultiRepoProjectFromAdvisor(
        action.workspaceId,
        action.repoPath,
      );
    case 'workspace.remove_repo':
      return removeRepoFromMultiRepoProjectFromAdvisor(
        action.workspaceId,
        action.repoId,
      );
    case 'worktree.select':
      useChatStore
        .getState()
        .selectWorktree(action.projectId, action.worktreeId);
      return { ok: true };
    case 'worktree.archive': {
      await ensureProjectsHydrated();
      const workspace = getGitWorkspaceOrError(action.projectId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      const worktree = workspace.worktrees.find(
        (candidate) => candidate.id === action.worktreeId,
      );
      if (!worktree) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Worktree ${action.worktreeId} was not found in project ${action.projectId}.`,
          },
        };
      }
      const splitLockError = refuseIfSplitLocked(
        action.projectId,
        action.worktreeId,
      );
      if (splitLockError) {
        return { ok: false, error: splitLockError };
      }
      if (hasActiveWorktreeSession(action.projectId, action.worktreeId)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'Stop the active agent session before archiving this worktree.',
            retryable: true,
          },
        };
      }
      const mode = action.mode ?? 'delete';
      const confirmationOpened = requestWorktreeArchiveConfirmation({
        projectId: action.projectId,
        worktreeId: action.worktreeId,
        requestedDeleteBranch: action.deleteBranch,
        ...(mode === 'archive' ? { lockAfterArchive: true } : {}),
      });
      if (!confirmationOpened) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'The worktree archive confirmation dialog is not currently available.',
            retryable: true,
          },
        };
      }
      const confirmLabel = mode === 'archive' ? 'Archive' : 'Delete';
      const requestedBranch = action.deleteBranch
        ? 'off, so the local branch is deleted'
        : 'on, so the local branch is kept';
      return {
        ok: true,
        result: {
          workspaceId: action.projectId,
          worktreeId: action.worktreeId,
          confirmationOpened: true,
          requestedDeleteBranch: action.deleteBranch,
          mode,
          note: `The ${confirmLabel} worktree confirmation is open; it has no mode switch. Its Keep the local branch switch starts ${requestedBranch}, and the dialog names that request. The user can flip the switch and confirms with ${confirmLabel} worktree. Nothing is removed until the user confirms.`,
        },
      };
    }
    case 'worktree.create_from_link': {
      await ensureProjectsHydrated();
      const scope = homeLinkScopeKey();
      const activePage = useNavigationStore.getState().activePage;
      const home = useHomeComposerStore.getState();
      const selectedProjectId =
        activePage === 'home'
          ? home.workspaceId
          : activePage === 'main'
            ? (useChatStore.getState().selectedWorktree?.projectId ?? null)
            : null;
      const explicitProject =
        activePage === 'home'
          ? home.workspaceSelectionExplicit
          : activePage === 'main' && selectedProjectId !== null;
      const resolution = await resolveHomeLink(
        selectHomeLink(action.url, [], null),
        {
          ...currentHomeLinkResolveContext(selectedProjectId, explicitProject),
          chosenAttachmentKey: null,
        },
        createHomeLinkResolveDeps(),
      );
      if (resolution.status !== 'ready')
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              resolution.status === 'blocked'
                ? resolution.message
                : 'Choose a supported GitHub or Linear link.',
            retryable: true,
          },
        };
      if (signal?.aborted || homeLinkScopeKey() !== scope)
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              'Worktree creation cancelled because the invocation context changed.',
            retryable: true,
          },
        };
      const destination = await materializeHomeLinkPlan(
        resolution.plan,
        createHomeLinkMaterializeDeps((): void => undefined, signal),
      );
      if (!destination.ok)
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: destination.message,
            retryable: destination.retryable,
          },
        };
      if (signal?.aborted || homeLinkScopeKey() !== scope)
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              'Worktree creation cancelled. The project remains available.',
            retryable: true,
          },
        };
      const destinationWorkspace = useProjectsStore
        .getState()
        .projects.find((project) => project.id === destination.workspaceId);
      const linkCreateOptions =
        destination.branchTarget.kind === 'linear-issue' &&
        destinationWorkspace &&
        workspaceRepoPathForCreateFrom(destinationWorkspace)
          ? { suggestedBranch: destination.branchTarget.branchName }
          : createOptionsForBranchTarget(
              destination.branchTarget,
              destination.branches,
            );
      const created = await useProjectsStore
        .getState()
        .createWorktree(destination.workspaceId, {
          suppressStartPage: true,
          select: false,
          ...linkCreateOptions,
        });
      if (!created)
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              worktreeFailureAgentText(
                useProjectsStore.getState().worktreeError,
              ) ??
              'Couldn’t create the worktree. The project remains available.',
            retryable: true,
          },
        };
      const receipt = {
        workspaceId: destination.workspaceId,
        worktreeId: created.id,
      };
      if (signal?.aborted || homeLinkScopeKey() !== scope)
        return {
          ok: false,
          result: receipt,
          error: {
            code: 'execution_failed',
            message:
              'Creation cancelled after the worktree was registered. The worktree remains available.',
            retryable: false,
          },
        };
      try {
        const opened = await routeAction(
          {
            ...request,
            action: {
              type: 'worktree-chat.open_tab',
              projectId: destination.workspaceId,
              worktreeId: created.id,
              ...(action.prompt
                ? {
                    initialMessage: homeLinkPromptWithIssueContext(
                      action.prompt,
                      resolution.plan.linearIssue,
                    ),
                  }
                : {}),
            },
          },
          originChatTabId,
          signal,
          requestId,
        );
        return {
          ...opened,
          result: {
            ...receipt,
            ...(opened.result &&
            typeof opened.result === 'object' &&
            !Array.isArray(opened.result)
              ? opened.result
              : {}),
          },
        };
      } catch {
        return {
          ok: false,
          result: receipt,
          error: {
            code: 'execution_failed',
            message:
              'Created the worktree, but couldn’t deliver the prompt. Open its chat to retry.',
            retryable: false,
          },
        };
      }
    }
    case 'worktree.create_from': {
      await ensureProjectsHydrated();
      const workspace = getWorkspaceOrError(action.workspaceId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      let resolved: ResolvedCreateFromTarget;
      try {
        resolved = await resolveCreateFromTarget(
          action.source,
          action.reference,
          workspace,
        );
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to resolve the requested source.',
            retryable: true,
          },
        };
      }
      const previousSelection = useChatStore.getState().selectedWorktree;
      const created = await useProjectsStore
        .getState()
        .createWorktree(action.workspaceId, {
          suppressStartPage: true,
          ...resolved.createOptions,
          ...(action.baseBranch ? { baseBranch: action.baseBranch } : {}),
        });
      if (!created) {
        const state = useProjectsStore.getState();
        const pendingRepair = state.pendingWorkspaceRepair;
        return {
          ok: false,
          error: {
            code: pendingRepair ? 'surface_unavailable' : 'execution_failed',
            message:
              pendingRepair !== null
                ? `Worktree creation needs repair before it can continue: ${pendingRepair.repairIssues
                    .map((issue) => issue.message)
                    .join('; ')}`
                : (worktreeFailureAgentText(state.worktreeError) ??
                  'Failed to create worktree.'),
            retryable: pendingRepair === null,
          },
        };
      }
      if (action.select === false) {
        if (previousSelection) {
          useChatStore
            .getState()
            .selectWorktree(
              previousSelection.projectId,
              previousSelection.worktreeId,
            );
        } else {
          useChatStore.getState().deselectWorktree();
        }
      }
      return {
        ok: true,
        result: {
          workspaceId: action.workspaceId,
          worktreeId: created.id,
          resolved: resolved.resolvedLabel,
        },
      };
    }
    case 'worktree.set_notification_level': {
      // Only a real local space: refreshing registers the scope on the
      // server, so an unknown id would otherwise save against an orphan.
      await ensureProjectsHydrated();
      const workspace = getWorkspaceOrError(action.projectId);
      if ('error' in workspace) return { ok: false, error: workspace.error };
      const known =
        workspace.type === 'cowork'
          ? (
              await window.api.workEntries.list({ projectId: workspace.id })
            ).entries.some((entry) => entry.id === action.worktreeId)
          : workspace.worktrees.some(
              (worktree) => worktree.id === action.worktreeId,
            );
      if (!known) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Worktree or task ${action.worktreeId} was not found in project ${action.projectId}.`,
          },
        };
      }
      const scope = {
        projectId: action.projectId,
        worktreeId: action.worktreeId,
      };
      const store = useSpaceNotificationStore.getState();
      await store.refresh(scope);
      // All activity clears the override, as the row menu does.
      const choice = action.level === 'all' ? null : action.level;
      const before = useSpaceNotificationStore.getState();
      const menu = spaceNotificationMenuStateFor(before, scope);
      if (menu.selectionKnown === false || menu.disabledReason !== undefined) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              menu.disabledReason ?? SPACE_NOTIFICATION_MENU_COPY.loadFailed,
            retryable: true,
          },
        };
      }
      if (menu.override !== choice) {
        await store.setChoice(scope, choice);
      }
      const after = spaceNotificationMenuStateFor(
        useSpaceNotificationStore.getState(),
        scope,
      );
      if (after.status === 'failed' || after.override !== choice) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: after.failure ?? SPACE_NOTIFICATION_MENU_COPY.saveFailed,
            retryable: true,
          },
        };
      }
      return {
        ok: true,
        result: {
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          level: action.level,
        },
      };
    }
    case 'worktree.resolve_branch_from_confirmation': {
      const pending = useBranchFromStore.getState().pending;
      if (!pending) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: 'No branch-from confirmation is currently open.',
          },
        };
      }
      if (
        pending.confirmationId !== action.confirmationId ||
        pending.projectId !== action.projectId ||
        pending.worktreeId !== action.worktreeId
      ) {
        return {
          ok: false,
          error: {
            code: 'stale_ui_state',
            message:
              'The branch-from confirmation no longer matches the requested worktree.',
            retryable: true,
          },
        };
      }
      useBranchFromStore
        .getState()
        .resolveConfirmation(action.choice === 'cancel' ? null : action.choice);
      return {
        ok: true,
        result: {
          projectId: pending.projectId,
          worktreeId: pending.worktreeId,
          choice: action.choice,
        },
      };
    }
    case 'worktree.add_workspace': {
      await ensureProjectsHydrated();
      const sourceWorkspace = getGitWorkspaceOrError(action.sourceWorkspaceId);
      if ('error' in sourceWorkspace) {
        return { ok: false, error: sourceWorkspace.error };
      }
      const sourceWorktree = sourceWorkspace.worktrees.find(
        (candidate) => candidate.id === action.sourceWorktreeId,
      );
      if (!sourceWorktree) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Worktree ${action.sourceWorktreeId} was not found in project ${action.sourceWorkspaceId}.`,
          },
        };
      }
      const mode = action.mode ?? 'temporary';
      if (
        mode === 'update-source-workspace' &&
        (sourceWorkspace.type !== 'multi-repo' ||
          sourceWorkspace.temporary === true)
      ) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'update-source-workspace mode is only valid for permanent multi-repo projects. Use temporary mode or promote the project first.',
          },
        };
      }
      const joinOptions = await window.api.listAdhocMultiRepoJoinOptions({
        sourceWorkspaceId: action.sourceWorkspaceId,
      });
      const joinWorkspaceIds = Array.from(
        new Set([
          ...(action.joinWorkspaceIds ?? []),
          ...(action.joinWorkspaceId ? [action.joinWorkspaceId] : []),
        ]),
      );
      const joinOptionIds = new Set(
        joinOptions.options.map((option) => option.id),
      );
      const invalidJoinWorkspaceId = joinWorkspaceIds.find(
        (joinWorkspaceId) => !joinOptionIds.has(joinWorkspaceId),
      );
      if (invalidJoinWorkspaceId) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Project ${invalidJoinWorkspaceId} cannot be added to ${action.sourceWorkspaceId}; it may already be included or may not add any new repos.`,
          },
        };
      }

      const addWorkspaceLockError = refuseIfSplitLocked(
        action.sourceWorkspaceId,
        action.sourceWorktreeId,
      );
      if (addWorkspaceLockError) {
        return { ok: false, error: addWorkspaceLockError };
      }

      await useChatStore
        .getState()
        .flushWorktreeTabs(action.sourceWorkspaceId, action.sourceWorktreeId);
      const response = await useProjectsStore
        .getState()
        .combineWorktreeWithWorkspace({
          sourceWorkspaceId: action.sourceWorkspaceId,
          sourceWorktreeId: action.sourceWorktreeId,
          joinWorkspaceIds,
          mode,
        });
      if (!response) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              worktreeFailureAgentText(
                useProjectsStore.getState().worktreeError,
              ) ?? 'Failed to add project to worktree.',
            retryable: true,
          },
        };
      }
      if (response.removedSourceWorktree) {
        await useChatStore
          .getState()
          .migrateWorktreeTabsToAdhocWorkspace(response);
      }
      if (action.select !== false) {
        useChatStore
          .getState()
          .selectWorktree(
            response.destinationWorkspaceId,
            response.destinationWorktreeId,
          );
      }
      return {
        ok: true,
        result: {
          sourceWorkspaceId: response.sourceWorkspaceId,
          sourceWorktreeId: response.sourceWorktreeId,
          destinationWorkspaceId: response.destinationWorkspaceId,
          destinationWorktreeId: response.destinationWorktreeId,
          destinationWorkspace: workspaceSummary(response.destinationWorkspace),
          destinationWorktree: worktreeSummary(response.destinationWorktree),
          repoMappings: response.repoMappings.map(repoMappingSummary),
          selectedRepoIdRewrites: response.selectedRepoIdRewrites,
          sourceRootRepoIdRewrite: response.sourceRootRepoIdRewrite ?? null,
          filePathRewrites: response.filePathRewrites.map((rewrite) => ({
            fromRoot: rewrite.fromRoot,
            toRoot: rewrite.toRoot,
          })),
          compatibilitySymlinks: response.compatibilitySymlinks.map(
            compatibilitySymlinkSummary,
          ),
          createdTemporaryWorkspace: response.createdTemporaryWorkspace,
          reusedWorkspace: response.reusedWorkspace,
          removedSourceWorktree: response.removedSourceWorktree,
          removedTemporaryWorkspaceId:
            response.removedTemporaryWorkspaceId ?? null,
        },
      };
    }
    case 'worktree.split_temporary_workspace': {
      await ensureProjectsHydrated();
      const splitSource = useProjectsStore
        .getState()
        .projects.find((project) => project.id === action.workspaceId);
      if (
        !splitSource ||
        splitSource.type !== 'multi-repo' ||
        splitSource.temporary !== true
      ) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'Split project is only available for temporary multi-repo projects.',
          },
        };
      }
      const splitLockError = refuseIfSplitLocked(
        action.workspaceId,
        action.worktreeId,
      );
      if (splitLockError) {
        return { ok: false, error: splitLockError };
      }
      try {
        const hasRemoveSelection = Object.values(
          action.selections ?? {},
        ).includes('remove');
        if (hasRemoveSelection || action.rootAction === 'delete') {
          const preview = await window.api.previewSplitTemporaryWorkspace({
            workspaceId: action.workspaceId,
            worktreeId: action.worktreeId,
          });
          const hardDeleteRepos = preview.repos.filter(
            (repo) =>
              action.selections?.[repo.repoId] === 'remove' &&
              repo.removalMode === 'delete',
          );
          const deletesRootData =
            action.rootAction === 'delete' && preview.root.present;
          if (hardDeleteRepos.length > 0 || deletesRootData) {
            return {
              ok: false,
              error: {
                code: 'invalid_payload',
                message:
                  'Permanent deletion must be confirmed in the Split project dialog. Review the current preview and confirm the operation there.',
              },
            };
          }
        }
        const response = await useProjectsStore
          .getState()
          .splitTemporaryWorkspaceWorktree(
            action.workspaceId,
            action.worktreeId,
            action.selections ?? {},
            action.rootAction,
          );
        // Mirror SplitWorkspaceModal's post-split navigation: first split
        // worktree, else the first archive's workspace, else Home.
        const target = response.navigationTarget;
        if (target.kind === 'worktree') {
          useNavigationStore.getState().navigate('main');
          useChatStore
            .getState()
            .selectWorktree(target.workspaceId, target.worktreeId);
        } else if (target.kind === 'workspace') {
          useNavigationStore.getState().navigate('main');
        } else {
          useNavigationStore.getState().navigate('home');
        }
        return {
          ok: true,
          result: {
            // Planned dispositions from the fast phase — checkout moves,
            // removals, and source teardown continue in the background and
            // surface through the split-complete toast flow.
            results: response.results.map((entry) => ({
              repoId: entry.repoId,
              repoName: entry.repoName,
              disposition: entry.disposition,
              destinationWorkspaceId: entry.destinationWorkspaceId ?? null,
              destinationWorktreeId: entry.destinationWorktreeId ?? null,
            })),
            warnings: response.warnings,
            navigationTarget: response.navigationTarget,
            backgroundCompletionPending: true,
          },
        };
      } catch (error: unknown) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to split project.',
            retryable: true,
          },
        };
      }
    }
    case 'hook.pause':
    case 'hook.resume': {
      await ensureProjectsHydrated();
      const workspace = getGitWorkspaceOrError(action.projectId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      const worktree = workspace.worktrees.find(
        (candidate) => candidate.id === action.worktreeId,
      );
      if (!worktree) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Worktree ${action.worktreeId} was not found in project ${action.projectId}.`,
          },
        };
      }
      const entries = buildHookEntries(
        workspace,
        action.worktreeId,
        useProjectsStore.getState().appliedProjectWorktreeHooks,
      );
      const knownHookKeys = new Set(entries.map((entry) => entry.hook.hookKey));
      if (action.hookKey && !knownHookKeys.has(action.hookKey)) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Hook ${action.hookKey} was not found in worktree ${action.projectId}/${action.worktreeId}.`,
          },
        };
      }
      const next = new Set(worktree.pausedHookKeys ?? []);
      if (action.all === true) {
        if (action.type === 'hook.pause') {
          for (const entry of entries) next.add(entry.hook.hookKey);
        } else {
          for (const entry of entries) next.delete(entry.hook.hookKey);
        }
      } else if (action.hookKey) {
        if (action.type === 'hook.pause') {
          next.add(action.hookKey);
        } else {
          next.delete(action.hookKey);
        }
      }
      const pausedHookKeys = Array.from(next).sort();
      await useProjectsStore
        .getState()
        .setWorktreePausedHookKeys(
          action.projectId,
          action.worktreeId,
          pausedHookKeys,
        );
      const refreshedWorkspace =
        useProjectsStore
          .getState()
          .projects.find((item) => item.id === action.projectId) ?? workspace;
      const refreshedWorktree =
        (refreshedWorkspace.type !== 'cowork'
          ? refreshedWorkspace.worktrees.find(
              (candidate) => candidate.id === action.worktreeId,
            )
          : undefined) ?? worktree;
      return {
        ok: true,
        result: {
          workspace: workspaceSummary(refreshedWorkspace),
          worktree: worktreeSummary(refreshedWorktree),
          pausedHookKeys: refreshedWorktree.pausedHookKeys ?? [],
        },
      };
    }
    case 'worktree.list_git_actions': {
      const contextResult = await buildWorktreeGitActionsContext(
        action.projectId,
        action.worktreeId,
      );
      if (!contextResult.ok) {
        return { ok: false, error: contextResult.error };
      }
      return {
        ok: true,
        result: worktreeGitActionsResult(contextResult.context),
      };
    }
    case 'worktree.run_git_action': {
      const contextResult = await buildWorktreeGitActionsContext(
        action.projectId,
        action.worktreeId,
      );
      if (!contextResult.ok) {
        return { ok: false, error: contextResult.error };
      }
      const { context } = contextResult;
      if (context.branchSyncBusy || context.creatingPr || context.mergingPr) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'A git action is already running for this worktree.',
            retryable: true,
          },
        };
      }
      if (context.commitReviewPending) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'A commit message review is pending for this worktree. Resolve the review before running another git action.',
            retryable: true,
          },
        };
      }
      const availableAction = context.actions.find(
        (candidate) => candidate.action === action.action,
      );
      if (!availableAction) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Git action ${action.action} is not currently available for this worktree. Available actions: ${
              context.actions.map((candidate) => candidate.action).join(', ') ||
              'none'
            }.`,
          },
        };
      }
      const repoIds = action.repoIds ?? availableAction.repoIds ?? undefined;
      const requestedRepoIds = repoIds ?? [];
      if (action.repoIds && !availableAction.repoIds) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'repoIds can only be supplied for scoped multi-repo git actions that returned repoIds from worktree.list_git_actions.',
          },
        };
      }
      if (
        requestedRepoIds.length > 0 &&
        availableAction.repoIds &&
        requestedRepoIds.some(
          (repoId) => !availableAction.repoIds?.includes(repoId),
        )
      ) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `One or more repoIds are outside the scope of the available git action. Requested: ${requestedRepoIds.join(
              ', ',
            )}. Available: ${availableAction.repoIds.join(', ')}.`,
          },
        };
      }

      const gitActionLockError = refuseIfSplitLocked(
        action.projectId,
        action.worktreeId,
      );
      if (gitActionLockError) {
        return { ok: false, error: gitActionLockError };
      }

      useChatStore
        .getState()
        .selectWorktree(action.projectId, action.worktreeId);
      const github = useGitHubStore.getState();
      // Analytics attribution only; UI requests keep main's manual default.
      const source: GitShippingSource | undefined =
        request.source === 'assistant' ? 'chat' : undefined;
      switch (action.action) {
        case 'create-pr':
          await github.createPr(action.projectId, action.worktreeId, repoIds, {
            source,
          });
          break;
        case 'commit':
          await github.commitOnly(
            action.projectId,
            action.worktreeId,
            context.isMultiRepo ? repoIds : undefined,
            { source },
          );
          break;
        case 'merge':
          await github.mergeLocalBranches(
            action.projectId,
            action.worktreeId,
            context.isMultiRepo ? repoIds : undefined,
          );
          break;
        case 'merge-pr': {
          const response = await github.mergePr(
            action.projectId,
            action.worktreeId,
            {
              repoIds: context.isMultiRepo ? repoIds : undefined,
              confirmUnresolvedComments:
                action.ignoreUnresolvedCommentsWarning === true,
              source,
            },
          );
          if (!response) {
            return {
              ok: false,
              error: {
                code: 'execution_failed',
                message:
                  'Failed to merge the pull request. Check the worktree notifications for details.',
                retryable: true,
              },
            };
          }
          const blocked = response.verifiedRepos.filter(
            (repo) => repo.blockedReason !== undefined,
          );
          // `mergedRepos` holds both outcomes: merged now, or added to the
          // base branch's merge queue.
          const mergedNow = response.mergedRepos.filter(
            (repo) => repo.status === 'merged',
          );
          const enqueued = response.mergedRepos.filter(
            (repo) => repo.status === 'enqueued',
          );
          // An opened merge queue chat is a completed handoff, never a merge.
          const queueChats = response.mergeQueueChats ?? [];
          const completedCount =
            response.mergedRepos.length + queueChats.length;
          if (
            completedCount > 0 &&
            (response.requiresUnresolvedConfirmation.length > 0 ||
              response.failedRepos.length > 0 ||
              blocked.length > 0 ||
              response.cancelled === true)
          ) {
            const partialDetails = [
              mergedNow.length > 0
                ? `merged ${formatMergePrRepos(mergedNow)}`
                : null,
              enqueued.length > 0
                ? `added ${formatMergePrRepos(enqueued)} to the merge queue`
                : null,
              queueChats.length > 0
                ? `opened a merge queue chat for ${formatMergePrRepos(
                    queueChats,
                  )}, which is not merged yet`
                : null,
              response.requiresUnresolvedConfirmation.length > 0
                ? `requires unresolved-comment confirmation for ${formatMergePrRepos(
                    response.requiresUnresolvedConfirmation,
                  )}`
                : null,
              response.failedRepos.length > 0
                ? `failed for ${response.failedRepos
                    .map((repo) => `${repo.repoName} (${repo.error})`)
                    .join(', ')}`
                : null,
              blocked.length > 0
                ? `blocked for ${formatBlockedMergePrRepos(blocked)}`
                : null,
              response.cancelled === true
                ? 'cancelled before the remaining pull requests were processed'
                : null,
            ].filter((detail): detail is string => detail !== null);
            return {
              ok: false,
              error: {
                code: 'execution_failed',
                message: `The pull request merge partially completed: ${partialDetails.join(
                  '; ',
                )}.`,
              },
            };
          }
          if (response.requiresUnresolvedConfirmation.length > 0) {
            const hasUnknownThreadCount =
              response.requiresUnresolvedConfirmation.some(
                (repo) => repo.unresolvedReviewThreadCount === undefined,
              );
            const total = response.requiresUnresolvedConfirmation.reduce(
              (sum, repo) => sum + (repo.unresolvedReviewThreadCount ?? 0),
              0,
            );
            const unresolvedDescription = hasUnknownThreadCount
              ? 'unresolved review comments or an unknown review thread state'
              : `${total} unresolved review ${
                  total === 1 ? 'comment' : 'comments'
                }`;
            return {
              ok: false,
              error: {
                code: 'invalid_payload',
                message: `The pull request has ${unresolvedDescription} and was not merged. Only if the user has explicitly confirmed they want to ignore the unresolved comments, retry this action with ignoreUnresolvedCommentsWarning: true.`,
              },
            };
          }
          if (completedCount === 0) {
            if (response.failedRepos.length > 0) {
              return {
                ok: false,
                error: {
                  code: 'execution_failed',
                  message: `Merge failed: ${response.failedRepos
                    .map((repo) => `${repo.repoName} (${repo.error})`)
                    .join(', ')}.`,
                },
              };
            }
            return {
              ok: false,
              error: {
                code: 'surface_unavailable',
                message:
                  blocked.length > 0
                    ? `The pull request is not currently mergeable: ${blocked
                        .map(
                          (repo) =>
                            `${repo.repoName} (${
                              repo.blockedReason === 'has_conflicts'
                                ? 'has conflicts'
                                : repo.blockedReason === 'base_changed'
                                  ? 'base branch changed'
                                  : repo.blockedReason === 'in_merge_queue'
                                    ? 'already in the merge queue'
                                    : 'not mergeable'
                            })`,
                        )
                        .join(', ')}.`
                    : 'No open, mergeable pull request was found for this worktree.',
                // A PR already in the merge queue lands on its own; retrying
                // cannot change the outcome.
                retryable: !(
                  blocked.length > 0 &&
                  blocked.every(
                    (repo) => repo.blockedReason === 'in_merge_queue',
                  )
                ),
              },
            };
          }
          return {
            ok: true,
            result: {
              dispatchedAction: action.action,
              label: availableAction.label,
              repoIds: repoIds ?? null,
              mergedPrNumbers: mergedNow.map((repo) => repo.prNumber),
              enqueuedPrNumbers: enqueued.map((repo) => repo.prNumber),
              mergeQueueChats: queueChats.map((chat) => ({
                repoName: chat.repoName,
                prNumber: chat.prNumber,
                prUrl: chat.prUrl,
                chatId: chat.chatId,
              })),
              // Spell out the handoff so the agent never reports it as merged.
              ...(queueChats.length > 0
                ? {
                    message: [
                      mergedNow.length > 0
                        ? `Merged ${formatMergePrRepos(mergedNow)}.`
                        : null,
                      enqueued.length > 0
                        ? `Added ${formatMergePrRepos(enqueued)} to the merge queue.`
                        : null,
                      `Opened a chat to merge ${formatMergePrRepos(
                        queueChats,
                      )} through the merge queue. Not merged yet.`,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(' '),
                  }
                : {}),
            },
          };
        }
        case 'commit-and-push':
          await github.commitAndPush(action.projectId, action.worktreeId, {
            source,
          });
          break;
        case 'pull-commit-and-push':
          await github.commitAndPush(action.projectId, action.worktreeId, {
            pullFirst: true,
            source,
          });
          break;
        case 'push':
          await github.pushOnly(action.projectId, action.worktreeId);
          break;
        case 'pull':
          await github.pull(action.projectId, action.worktreeId);
          break;
        default:
          throw new Error('Unsupported git action.');
      }

      return {
        ok: true,
        result: {
          dispatchedAction: action.action,
          label: availableAction.label,
          repoIds: repoIds ?? null,
        },
      };
    }
    case 'worktree.cancel_git_action': {
      const contextResult = await buildWorktreeGitActionsContext(
        action.projectId,
        action.worktreeId,
      );
      if (!contextResult.ok) {
        return { ok: false, error: contextResult.error };
      }

      const key = worktreeKey(action.projectId, action.worktreeId);
      const github = useGitHubStore.getState();
      if (!github.gitActionOperationIds[key]) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'There is no cancellable git action running for this worktree.',
            retryable: true,
          },
        };
      }
      if (github.gitActionCancellationRequested.has(key)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'Git action cancellation has already been requested for this worktree.',
            retryable: true,
          },
        };
      }

      const cancellation = await github.cancelGitAction(
        action.projectId,
        action.worktreeId,
      );
      if (!cancellation.accepted) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              cancellation.reason === 'refreshing'
                ? 'The Git action is already refreshing and can no longer be cancelled.'
                : 'The Git action cancellation request was not accepted.',
            retryable: cancellation.reason !== 'refreshing',
          },
        };
      }
      return {
        ok: true,
        result: {
          dispatchedAction: action.type,
          projectId: action.projectId,
          worktreeId: action.worktreeId,
        },
      };
    }
    case 'github.resolve_base_branch_alignment': {
      const pending = useBaseBranchAlignmentStore.getState().pending;
      if (!pending) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: 'No base-branch alignment confirmation is currently open.',
          },
        };
      }
      if (
        pending.confirmationId !== action.confirmationId ||
        pending.projectId !== action.projectId ||
        pending.worktreeId !== action.worktreeId
      ) {
        return {
          ok: false,
          error: {
            code: 'stale_ui_state',
            message:
              'The base-branch alignment confirmation no longer matches the requested worktree.',
            retryable: true,
          },
        };
      }
      useBaseBranchAlignmentStore
        .getState()
        .resolveConfirmation(action.choice === 'confirm');
      return {
        ok: true,
        result: {
          projectId: pending.projectId,
          worktreeId: pending.worktreeId,
          choice: action.choice,
        },
      };
    }
    case 'github.split_pr': {
      if (!isDesktopPrSplitEnabled()) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Split PR is not available right now.',
          },
        };
      }
      await ensureProjectsHydrated();
      const workspace = getGitWorkspaceOrError(action.projectId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      const worktree = workspace.worktrees.find(
        (candidate) => candidate.id === action.worktreeId,
      );
      if (!worktree) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Worktree ${action.worktreeId} was not found in project ${action.projectId}.`,
          },
        };
      }
      // Pre-gate on an existing lock BEFORE opening the pre-flight modal: a
      // second dispatch against an already-locked worktree (e.g. the split is
      // already mid-execute) must not pop the pre-flight dialog onto a
      // worktree it cannot actually start against — that modal's own Start
      // button would immediately double-acquire and toast. Refuse here with
      // the same friendly reason every other guarded action uses instead.
      const splitPrLockError = refuseIfSplitLocked(
        action.projectId,
        action.worktreeId,
      );
      if (splitPrLockError) {
        return { ok: false, error: splitPrLockError };
      }
      // Same lazily-loaded gating preferences the PR activity panel and the
      // worktree-row menu use. Outside a component there is no useEffect to
      // trigger the shared one-time load, so ensure it here before gating.
      if (!useSplitPrPreferencesStore.getState().hasLoaded) {
        await useSplitPrPreferencesStore.getState().load();
      }
      const key = worktreeKey(action.projectId, action.worktreeId);
      const githubState = useGitHubStore.getState();
      const isSingleRepo = workspace.type === 'single-repo';
      const eligibilityInputs = gatherSplitPrEligibilityInputs(
        action.projectId,
        action.worktreeId,
        isSingleRepo,
        {
          getPrStatus: (statusProjectId, statusWorktreeId) =>
            githubState.prStatuses[
              worktreeKey(statusProjectId, statusWorktreeId)
            ],
          getDiffStats: (statsProjectId, statsWorktreeId) =>
            useProjectsStore.getState().diffStats[
              createDiffStatsKey(statsProjectId, statsWorktreeId)
            ],
          getGatingPreferences: () => useSplitPrPreferencesStore.getState(),
        },
      );
      const eligible = isSplitPrEligible(eligibilityInputs);
      if (!eligible) {
        const lineCount = splitPrLineCount(eligibilityInputs);
        let reason: string;
        if (!eligibilityInputs.splitPrEnabled) {
          reason = 'the Split PR preference is disabled in Settings';
        } else if (!isSingleRepo) {
          reason = 'Split PR is only available for single-repo worktrees';
        } else if (eligibilityInputs.prState !== 'open') {
          reason = 'the worktree has no open pull request';
        } else if (lineCount === undefined) {
          reason = 'the pull request line count is not known yet';
        } else {
          reason = `the pull request has ${lineCount} changed lines, below the configured ${eligibilityInputs.thresholdLines}-line split threshold`;
        }
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Split PR is not available for this worktree: ${reason}.`,
          },
        };
      }
      if (
        githubState.planningSplitPr.has(key) ||
        githubState.splittingPr.has(key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'A Split PR plan or execution is already in progress for this worktree.',
            retryable: true,
          },
        };
      }
      // Select the worktree so the PR activity panel is visible, then route
      // through the SAME pre-flight gate the four UI launch surfaces use rather
      // than starting the workflow directly. The advisor cannot invoke the
      // lockdown-aware `startSplitWorkflow` itself: the panel's Approve now
      // calls `approveSplitWorkflow`, whose handler rejects unless the worktree
      // is locked — and only the pre-flight modal's Start acquires that lock.
      // Opening the pre-flight modal keeps the human in the loop (they still
      // review resource-termination warnings and click Start) and matches the
      // planned A8 behavior, pulled forward here.
      useChatStore
        .getState()
        .selectWorktree(action.projectId, action.worktreeId);
      useActivityStore
        .getState()
        .openSplitPreflight(action.projectId, action.worktreeId);
      return {
        ok: true,
        result: {
          dispatchedAction: action.type,
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          preflightOpened: true,
          note: 'Split PR pre-flight dialog opened for the selected worktree. The user reviews the resource-termination warnings and clicks Start to begin planning; no PRs are created until they review and approve the proposed plan.',
        },
      };
    }
    case 'code_review.open': {
      await ensureProjectsHydrated();
      const workspace = getWorkspaceOrError(action.projectId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      if (workspace.type === 'cowork') {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Project ${action.projectId} does not have worktrees for code review.`,
          },
        };
      }
      const worktree = workspace.worktrees.find(
        (candidate) => candidate.id === action.worktreeId,
      );
      if (!worktree) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Worktree ${action.worktreeId} was not found in project ${action.projectId}.`,
          },
        };
      }
      // Reveal the owning workspace before routing the compatibility action to its panel.
      useChatStore
        .getState()
        .selectWorktree(action.projectId, action.worktreeId);
      await useCodeReviewStore
        .getState()
        .openCodeReview(
          { projectId: action.projectId, worktreeId: action.worktreeId },
          { arm: false },
        );
      return {
        ok: true,
        result: {
          dispatchedAction: action.type,
          projectId: action.projectId,
          worktreeId: action.worktreeId,
        },
      };
    }
    case 'runs.open_comments': {
      // Comments only exist for a chat that has actually been shared as a run
      // (CAN-397). The panel itself is server-authoritative — it fetches over
      // `runs:comments:*` — so all this action does is route the UI to it.
      const target = await resolveWorktreeTabsTarget(action);
      if ('error' in target) return { ok: false, error: target.error };
      const tab = target.worktreeChat.tabs.find(
        (candidate) => candidate.id === action.chatId,
      );
      if (!tab) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Chat ${action.chatId} was not found in worktree ${target.projectId}/${target.worktreeId}.`,
          },
        };
      }
      const sharedRun = tab.kind === 'file' ? undefined : tab.sharedRun;
      if (!sharedRun) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Chat ${action.chatId} has not been shared as a run, so it has no comments. Share the session first.`,
          },
        };
      }
      openRunComments({
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: action.chatId,
        title: tab.title,
      });
      return {
        ok: true,
        result: {
          dispatchedAction: action.type,
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: action.chatId,
          runExternalId: sharedRun.externalId,
          unreadCommentCount: sharedRun.unreadCommentCount ?? 0,
        },
      };
    }
    case 'worktree.add_existing_worktree': {
      await ensureProjectsHydrated();
      const sourceWorkspace = getGitWorkspaceOrError(action.sourceWorkspaceId);
      if ('error' in sourceWorkspace) {
        return { ok: false, error: sourceWorkspace.error };
      }
      const sourceWorktree = sourceWorkspace.worktrees.find(
        (candidate) => candidate.id === action.sourceWorktreeId,
      );
      if (!sourceWorktree) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Worktree ${action.sourceWorktreeId} was not found in project ${action.sourceWorkspaceId}.`,
          },
        };
      }
      const mode = action.mode ?? 'temporary';
      if (
        mode === 'update-source-workspace' &&
        (sourceWorkspace.type !== 'multi-repo' ||
          sourceWorkspace.temporary === true)
      ) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'update-source-workspace mode is only valid for permanent multi-repo projects. Use temporary mode or promote the project first.',
          },
        };
      }
      const joinOptions = await window.api.listExistingWorktreeJoinOptions({
        sourceWorkspaceId: action.sourceWorkspaceId,
        sourceWorktreeId: action.sourceWorktreeId,
      });
      const joinCandidate = joinOptions.groups
        .flatMap((group) => group.candidates)
        .find(
          (candidate) =>
            candidate.workspaceId === action.joinWorkspaceId &&
            candidate.worktreeId === action.joinWorktreeId,
        );
      if (!joinCandidate || joinCandidate.busyReason) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Worktree ${action.joinWorkspaceId}/${action.joinWorktreeId} cannot be joined into ${action.sourceWorkspaceId}/${action.sourceWorktreeId}.`,
          },
        };
      }

      const sourceLockError = refuseIfSplitLocked(
        action.sourceWorkspaceId,
        action.sourceWorktreeId,
      );
      if (sourceLockError) {
        return { ok: false, error: sourceLockError };
      }
      const joinLockError = refuseIfSplitLocked(
        action.joinWorkspaceId,
        action.joinWorktreeId,
      );
      if (joinLockError) {
        return { ok: false, error: joinLockError };
      }

      await useChatStore
        .getState()
        .flushWorktreeTabs(action.sourceWorkspaceId, action.sourceWorktreeId);
      await useChatStore
        .getState()
        .flushWorktreeTabs(action.joinWorkspaceId, action.joinWorktreeId);
      const response = await useProjectsStore
        .getState()
        .combineWorktreeWithExistingWorktree({
          sourceWorkspaceId: action.sourceWorkspaceId,
          sourceWorktreeId: action.sourceWorktreeId,
          joinWorkspaceId: action.joinWorkspaceId,
          joinWorktreeId: action.joinWorktreeId,
          mode,
        });
      if (!response) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              worktreeFailureAgentText(
                useProjectsStore.getState().worktreeError,
              ) ?? 'Failed to join existing worktree.',
            retryable: true,
          },
        };
      }
      if (response.removedSourceWorktree) {
        await useChatStore
          .getState()
          .migrateWorktreeTabsToAdhocWorkspace(response);
      }
      const joined = response.joinedWorktree;
      await useChatStore.getState().migrateWorktreeTabsToAdhocWorkspace({
        ...response,
        sourceWorkspaceId: joined.workspaceId,
        sourceWorktreeId: joined.worktreeId,
        repoMappings: joined.repoMappings,
        selectedRepoIdRewrites: joined.selectedRepoIdRewrites,
        sourceRootRepoIdRewrite: joined.sourceRootRepoIdRewrite,
        filePathRewrites: joined.filePathRewrites,
        compatibilitySymlinks: joined.compatibilitySymlinks,
        removedTemporaryWorkspaceId: joined.removedTemporaryWorkspaceId,
      });
      if (action.select !== false) {
        useChatStore
          .getState()
          .selectWorktree(
            response.destinationWorkspaceId,
            response.destinationWorktreeId,
          );
      }
      return {
        ok: true,
        result: {
          sourceWorkspaceId: response.sourceWorkspaceId,
          sourceWorktreeId: response.sourceWorktreeId,
          joinedWorktree: joinedWorktreeSummary(response.joinedWorktree),
          destinationWorkspaceId: response.destinationWorkspaceId,
          destinationWorktreeId: response.destinationWorktreeId,
          destinationWorkspace: workspaceSummary(response.destinationWorkspace),
          destinationWorktree: worktreeSummary(response.destinationWorktree),
          repoMappings: response.repoMappings.map(repoMappingSummary),
          selectedRepoIdRewrites: response.selectedRepoIdRewrites,
          sourceRootRepoIdRewrite: response.sourceRootRepoIdRewrite ?? null,
          filePathRewrites: response.filePathRewrites.map((rewrite) => ({
            fromRoot: rewrite.fromRoot,
            toRoot: rewrite.toRoot,
          })),
          compatibilitySymlinks: response.compatibilitySymlinks.map(
            compatibilitySymlinkSummary,
          ),
          createdTemporaryWorkspace: response.createdTemporaryWorkspace,
          reusedWorkspace: response.reusedWorkspace,
          removedSourceWorktree: response.removedSourceWorktree,
          removedTemporaryWorkspaceId:
            response.removedTemporaryWorkspaceId ?? null,
        },
      };
    }
    case 'workspace.set_start_page': {
      if (!isCanopyDesktopStartPageEnabled()) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Project start pages are not available.',
            retryable: false,
          },
        };
      }
      await ensureProjectsHydrated();
      const workspace = getWorkspaceOrError(action.workspaceId);
      if ('error' in workspace) return { ok: false, error: workspace.error };
      const saved = await saveStartPageFromAction(
        action.workspaceId,
        action.startPage,
      );
      if (!saved) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Could not save the project start page.',
            retryable: true,
          },
        };
      }
      return { ok: true, result: { updated: true } };
    }
    case 'workspace.start_readiness_fix': {
      await ensureProjectsHydrated();
      const workspace = getGitWorkspaceOrError(action.workspaceId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      const response = await window.api.getWorkspaceReadiness({
        workspaceId: action.workspaceId,
        ...(action.worktreeId ? { worktreeId: action.worktreeId } : {}),
      });
      const matchingIssues = response.issues.filter(
        (issue) =>
          issue.code === action.issueCode &&
          (action.repoId === undefined || issue.repoId === action.repoId),
      );
      if (matchingIssues.length !== 1) {
        return {
          ok: false,
          error: {
            code: matchingIssues.length === 0 ? 'not_found' : 'invalid_target',
            message:
              matchingIssues.length === 0
                ? 'The requested readiness issue is no longer present.'
                : 'More than one repository has this readiness issue; provide repoId.',
          },
        };
      }
      const issue = matchingIssues[0];
      // Launch from the target just audited: an empty id audited the
      // reference checkout, and launch records are keyed by audit target.
      const launched = await launchWorkspaceReadinessFix(
        action.workspaceId,
        issue,
        action.worktreeId ? action.worktreeId : undefined,
      );
      if (!launched.ok) {
        return {
          ok: false,
          error: { code: 'execution_failed', message: launched.message },
        };
      }
      return {
        ok: true,
        result: {
          issueCode: issue.code,
          repoName: issue.repoName,
          ...(issue.repoId ? { repoId: issue.repoId } : {}),
          launched: true,
        },
      };
    }
    case 'workspace.update_local_settings': {
      await ensureProjectsHydrated();
      const workspace = getWorkspaceOrError(action.workspaceId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      const updated: string[] = [];
      if (
        action.archiveRetentionDays !== undefined ||
        action.autoArchiveDays !== undefined ||
        action.autoArchiveDeleteBranch !== undefined
      ) {
        await window.api.setWorkspaceArchiveRetention({
          workspaceId: action.workspaceId,
          archiveRetentionDays:
            action.archiveRetentionDays !== undefined
              ? action.archiveRetentionDays
              : workspace.archiveRetentionDays !== undefined
                ? workspace.archiveRetentionDays
                : resolveArchiveRetentionDays(workspace.type, undefined),
          autoArchiveDays:
            action.autoArchiveDays !== undefined
              ? action.autoArchiveDays
              : (workspace.autoArchiveDays ?? null),
          autoArchiveDeleteBranch:
            action.autoArchiveDeleteBranch !== undefined
              ? action.autoArchiveDeleteBranch
              : 'autoArchiveDeleteBranch' in workspace
                ? (workspace.autoArchiveDeleteBranch ?? false)
                : false,
        });
        if (action.archiveRetentionDays !== undefined) {
          updated.push('archiveRetentionDays');
        }
        if (action.autoArchiveDays !== undefined) {
          updated.push('autoArchiveDays');
        }
        if (action.autoArchiveDeleteBranch !== undefined) {
          updated.push('autoArchiveDeleteBranch');
        }
      }
      if (action.scripts !== undefined) {
        if (workspace.type === 'multi-repo') {
          await window.api.saveWorkspaceScripts({
            workspaceId: action.workspaceId,
            scripts: action.scripts,
          });
        } else {
          await window.api.saveProjectScripts({
            projectId: action.workspaceId,
            scripts: action.scripts,
          });
        }
        updated.push('scripts');
      }
      if (action.hooks !== undefined) {
        if (workspace.type === 'multi-repo') {
          await window.api.saveWorkspaceHooks({
            workspaceId: action.workspaceId,
            hooks: action.hooks,
          });
        } else {
          await window.api.saveProjectHooks({
            projectId: action.workspaceId,
            hooks: action.hooks,
          });
        }
        updated.push('hooks');
      }
      if (action.repoScripts !== undefined || action.repoHooks !== undefined) {
        if (workspace.type !== 'multi-repo') {
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message:
                'Repo-scoped local overrides are only valid for multi-repo projects.',
            },
          };
        }
        if (action.repoScripts !== undefined) {
          await window.api.saveWorkspaceRepoScripts({
            workspaceId: action.workspaceId,
            repos: action.repoScripts,
          });
          updated.push('repoScripts');
        }
        if (action.repoHooks !== undefined) {
          await window.api.saveWorkspaceRepoHooks({
            workspaceId: action.workspaceId,
            repos: action.repoHooks,
          });
          updated.push('repoHooks');
        }
      }
      if (
        action.defaultPluginSelections !== undefined ||
        action.alwaysShow !== undefined
      ) {
        const defaultPluginSelections =
          action.defaultPluginSelections ??
          workspace.defaultPluginSelections ??
          createEmptySelections();
        const request = {
          projectId: action.workspaceId,
          defaultPluginSelections,
          ...(action.alwaysShow !== undefined
            ? { alwaysShow: action.alwaysShow }
            : {}),
        };
        if (workspace.type === 'multi-repo') {
          await window.api.saveWorkspaceDefaultPlugins(request);
        } else {
          await window.api.saveProjectDefaultPlugins(request);
        }
        updated.push('defaultPluginSelections');
      }
      await useProjectsStore.getState().loadProjects({ silent: true });
      return {
        ok: true,
        result: {
          workspaceId: action.workspaceId,
          updated,
        },
      };
    }
    case 'workspace.apply_source_edits': {
      await ensureProjectsHydrated();
      const workspace = getGitWorkspaceOrError(action.workspaceId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      if (workspace.type === 'multi-repo' && workspace.temporary === true) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'Temporary projects do not support source-controlled edits. Promote the project before applying source-controlled changes.',
          },
        };
      }
      if (workspace.type === 'multi-repo' && !workspace.sourceRepoPath) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'This multi-repo project has no attached source repo for source-controlled edits.',
          },
        };
      }
      if (!action.worktreeId && action.createWorktree !== true) {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message:
              'Provide worktreeId for an existing target or set createWorktree true.',
          },
        };
      }
      const target: WorkspaceApplySourceChangesTarget = action.worktreeId
        ? { mode: 'existing', worktreeId: action.worktreeId }
        : {
            mode: 'new',
            existingWorktreeIds: workspace.worktrees.map(
              (worktree) => worktree.id,
            ),
          };
      if (target.mode === 'existing') {
        const applySourceEditsLockError = refuseIfSplitLocked(
          action.workspaceId,
          target.worktreeId,
        );
        if (applySourceEditsLockError) {
          return { ok: false, error: applySourceEditsLockError };
        }
      }
      const clientRequestId = createClientId();
      const response =
        workspace.type === 'multi-repo'
          ? await window.api.applyWorkspaceSourceChanges({
              clientRequestId,
              workspaceId: action.workspaceId,
              target,
              ...(action.claudeMd !== undefined
                ? { claudeMd: action.claudeMd }
                : {}),
              ...(action.scripts !== undefined
                ? { workspaceScripts: action.scripts }
                : {}),
              ...(action.hooks !== undefined
                ? { workspaceHooks: action.hooks }
                : {}),
              ...(action.plugins !== undefined
                ? { workspacePlugins: action.plugins }
                : {}),
              ...(action.repoScriptChanges !== undefined
                ? { repoScriptChanges: action.repoScriptChanges }
                : {}),
              ...(action.repoHookChanges !== undefined
                ? { repoHookChanges: action.repoHookChanges }
                : {}),
              ...(action.repoAdds !== undefined
                ? { repoAdds: action.repoAdds }
                : {}),
              ...(action.repoRemovals !== undefined
                ? { repoRemovals: action.repoRemovals }
                : {}),
            })
          : await window.api.applyProjectSourceChanges({
              clientRequestId,
              projectId: action.workspaceId,
              target,
              ...(action.scripts !== undefined
                ? { scripts: action.scripts }
                : {}),
              ...(action.hooks !== undefined ? { hooks: action.hooks } : {}),
              ...(action.plugins !== undefined
                ? { plugins: action.plugins }
                : {}),
            });
      await useProjectsStore.getState().loadProjects({ silent: true });
      useChatStore
        .getState()
        .selectWorktree(action.workspaceId, response.worktreeId);
      return {
        ok: true,
        result: response as unknown as AppAdvisorJson,
      };
    }
    case 'workspace.promote_temporary': {
      await ensureProjectsHydrated();
      const workspace = getWorkspaceOrError(action.workspaceId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      if (workspace.type !== 'multi-repo' || workspace.temporary !== true) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Project ${action.workspaceId} is not a temporary multi-repo project.`,
          },
        };
      }
      const name = action.name.trim();
      if (!name) {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'Permanent project name cannot be empty.',
          },
        };
      }
      const promoted = await window.api.promoteTemporaryWorkspace({
        workspaceId: action.workspaceId,
        name,
      });
      await useProjectsStore.getState().loadProjects({ silent: true });
      return {
        ok: true,
        result: {
          workspace: workspaceSummary(promoted),
          capabilities: workspaceSettingsCapabilities(promoted),
        },
      };
    }
    case 'chat.open_import_session_modal': {
      await ensureProjectsHydrated();
      const workspaceId =
        action.workspaceId ??
        useChatStore.getState().selectedWorktree?.projectId;
      if (!workspaceId) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Select a project before opening session import.',
          },
        };
      }
      const workspace = useProjectsStore
        .getState()
        .projects.find((candidate) => candidate.id === workspaceId);
      if (!workspace) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Project ${workspaceId} was not found.`,
          },
        };
      }
      let account: CanopyCloudAccountPublicState | null;
      try {
        account = await window.api.loadCanopyCloudAccount();
      } catch {
        account = null;
      }
      if (!isConnectedNonGuest(account)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: `Sign in to a non-guest ${brandText.appName} Cloud account before importing a session.`,
          },
        };
      }
      if (!openImportSessionModal(workspace.id)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: `Session import is unavailable for project ${workspace.id}.`,
          },
        };
      }
      return {
        ok: true,
        result: {
          workspaceId: workspace.id,
          modalRequested: true,
        },
      };
    }
    case 'worktree-chat.open_tab': {
      const wantsInitialMessage = Boolean(action.initialMessage?.trim());
      if (wantsInitialMessage) {
        const openTabLockError = refuseIfSplitLocked(
          action.projectId,
          action.worktreeId,
        );
        if (openTabLockError) {
          return { ok: false, error: openTabLockError };
        }
      }
      useChatStore
        .getState()
        .selectWorktree(action.projectId, action.worktreeId);
      if (action.chatId) {
        if (action.initialMessage?.trim()) {
          return {
            ok: false,
            error: {
              code: 'invalid_payload',
              message:
                'initialMessage is only supported when creating a new chat tab.',
            },
          };
        }
        const chatTarget = {
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          chatId: action.chatId,
        };
        let target = await resolveChatHistoryTarget(chatTarget);
        if ('error' in target && target.error.code === 'not_found') {
          // A new worktree may still be loading; loadTabsForTarget returns early
          // for that concurrent load, so await canonical hydration and retry once.
          await useChatStore
            .getState()
            .hydrateChatScopeRevisioned(action.projectId, action.worktreeId);
          target = await resolveChatHistoryTarget(chatTarget);
        }
        if ('error' in target) return { ok: false, error: target.error };
        useChatStore.getState().switchTab(action.chatId, {
          projectId: action.projectId,
          worktreeId: action.worktreeId,
        });
        return { ok: true, result: { chatId: action.chatId } };
      }
      useChatStore.getState().createTab({
        projectId: action.projectId,
        worktreeId: action.worktreeId,
      });
      const key = worktreeKey(action.projectId, action.worktreeId);
      const worktreeChat = useChatStore.getState().worktreeChats[key];
      const chatId = worktreeChat?.activeTabId;
      const createdTab = chatId
        ? worktreeChat?.tabs.find((tab) => tab.id === chatId)
        : undefined;
      if (!chatId || !createdTab || createdTab.kind === 'file') {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `No new chat tab was created for worktree ${action.projectId}/${action.worktreeId}.`,
          },
        };
      }
      const initialMessage = action.initialMessage;
      if (initialMessage?.trim()) {
        const target = {
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          chatId,
        };
        if ((createdTab.interfaceMode ?? 'canopy') === 'claude-code') {
          await useChatStore
            .getState()
            .ensureClaudeTerminal(chatId, target, undefined, initialMessage);
        } else {
          await useChatStore
            .getState()
            .sendMessage(initialMessage, undefined, target, undefined, {
              throwOnDispatchFailure: true,
            });
        }
      }
      return { ok: true, result: { chatId } };
    }
    case 'worktree-chat.list_background_processes': {
      const processes =
        useActivityStore.getState().bgProcesses[
          worktreeKey(action.projectId, action.worktreeId)
        ] ?? [];
      return {
        ok: true,
        result: {
          processes: [
            ...processes.map((process) => ({
              id: process.id,
              chatId: process.chatId,
              ...(process.taskId ? { taskId: process.taskId } : {}),
              kind: process.kind,
              description: process.advisorDescription ?? process.toolName,
              status: process.status,
              canStop: process.canStop,
            })),
            // Provider descriptions can carry prompt text, so these rows
            // have none.
            ...uncardedLiveTasks(
              action.projectId,
              action.worktreeId,
              processes,
            ).map(({ chatId, task, canStop }) => ({
              id: task.taskId,
              chatId,
              taskId: task.taskId,
              kind: backgroundProcessKindForTaskType(task.taskType) ?? 'task',
              status: task.status === 'pending' ? 'queued' : 'running',
              canStop,
            })),
          ].filter(
            (process) => !action.chatId || process.chatId === action.chatId,
          ),
        },
      };
    }
    case 'worktree-chat.stop_background_process': {
      const key = worktreeKey(action.projectId, action.worktreeId);
      const processes = useActivityStore.getState().bgProcesses[key] ?? [];
      const process =
        processes.find(
          (candidate) =>
            candidate.chatId === action.chatId &&
            candidate.taskId === action.taskId,
        ) ??
        uncardedLiveTasks(action.projectId, action.worktreeId, processes).find(
          (live) =>
            live.chatId === action.chatId && live.task.taskId === action.taskId,
        );
      if (!process) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Background process ${action.taskId} was not found.`,
          },
        };
      }
      if (!process.canStop) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'task' in process
                ? `Background task ${action.taskId} has no per-task Stop in this chat's provider.`
                : `Background process ${action.taskId} is no longer running.`,
          },
        };
      }
      const outcome = await requestBackgroundTaskStop(ipcCanopyClient, {
        projectId: action.projectId,
        worktreeId: action.worktreeId,
        chatId: action.chatId,
        taskId: action.taskId,
      });
      return {
        ok: true,
        result: { taskId: action.taskId, status: outcome },
      };
    }
    case 'worktree-chat.retry_state_refresh': {
      const key = worktreeKey(action.projectId, action.worktreeId);
      const chatStore = useChatStore.getState();
      if (chatStore.chatStateSync?.[key]?.phase !== 'refresh_error') {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'No failed chat-state refresh is available to retry.',
          },
        };
      }
      chatStore.retryChatStateRefresh(action.projectId, action.worktreeId);
      return { ok: true };
    }
    case 'worktree-chat.dismiss_state_notice': {
      const key = worktreeKey(action.projectId, action.worktreeId);
      const chatStore = useChatStore.getState();
      if (!chatStore.chatStateNotices?.[key]) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'No chat-state notice is available to dismiss.',
          },
        };
      }
      chatStore.dismissChatStateNotice(action.projectId, action.worktreeId);
      return { ok: true };
    }
    case 'worktree-chat.open_archives': {
      const target = await resolveWorktreeTabsTarget(action);
      if ('error' in target) return { ok: false, error: target.error };
      useNavigationStore.getState().navigate('main');
      useChatStore
        .getState()
        .selectWorktree(target.projectId, target.worktreeId);
      await useChatStore
        .getState()
        .loadArchivedChats(target.projectId, target.worktreeId);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      window.dispatchEvent(
        new CustomEvent(WORKTREE_CHAT_OPEN_ARCHIVES_EVENT, {
          detail: {
            projectId: target.projectId,
            worktreeId: target.worktreeId,
          },
        }),
      );
      const archiveCount =
        useChatStore.getState().archivedChats[
          worktreeKey(target.projectId, target.worktreeId)
        ]?.length ?? 0;
      return {
        ok: true,
        result: {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          archiveCount,
          modalRequested: true,
        },
      };
    }
    case 'worktree-chat.switch_tab': {
      const target = await resolveWorktreeTabsTarget(action);
      if ('error' in target) return { ok: false, error: target.error };
      const tab = target.worktreeChat.tabs.find(
        (candidate) => candidate.id === action.tabId,
      );
      if (!tab) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Tab ${action.tabId} was not found.`,
          },
        };
      }
      useChatStore
        .getState()
        .selectWorktree(target.projectId, target.worktreeId);
      useChatStore.getState().switchTab(action.tabId, {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
      });
      const updated =
        useChatStore.getState().worktreeChats[
          worktreeKey(target.projectId, target.worktreeId)
        ] ?? target.worktreeChat;
      return {
        ok: true,
        result: {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          activeTabId: action.tabId,
          activeTabKind: tab.kind ?? 'chat',
          tabs: worktreeTabsResult(
            target.projectId,
            target.worktreeId,
            updated,
          ),
        },
      };
    }
    case 'worktree-chat.send_message': {
      // Agent sends run in main with sender context. Only StartBranchedAgent's
      // own "Continue" sends from here, into its new worktree, where main
      // holds the send until the worktree's setup finishes.
      if (request.hostSend !== 'start_branched_agent')
        return {
          ok: false,
          error: {
            code: 'unsupported_action',
            message: 'Chat sends must run in the main process.',
          },
        };
      const sendMessageLockError = refuseIfSplitLocked(
        action.projectId,
        action.worktreeId,
      );
      if (sendMessageLockError) {
        return { ok: false, error: sendMessageLockError };
      }
      // loadTabsForTarget returns early for a concurrent new-worktree load;
      // await canonical hydration before looking up the new chat.
      await useChatStore
        .getState()
        .hydrateChatScopeRevisioned(action.projectId, action.worktreeId);
      useChatStore
        .getState()
        .selectWorktree(action.projectId, action.worktreeId);
      const target = await resolveChatHistoryTarget(action);
      if ('error' in target) return { ok: false, error: target.error };
      useChatStore.getState().switchTab(action.chatId, {
        projectId: action.projectId,
        worktreeId: action.worktreeId,
      });
      await useChatStore.getState().sendMessage(
        action.text,
        undefined,
        {
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          chatId: action.chatId,
        },
        undefined,
        { throwOnDispatchFailure: true },
      );
      return { ok: true };
    }
    case 'worktree-chat.steer_queued_message':
    case 'worktree-chat.schedule_message':
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Chat message controls run in the main process.',
        },
      };
    case 'worktree-chat.run_chat_action':
      return runWorktreeChatActionResult(action);
    case 'worktree-chat.set_plan_mode': {
      const target = await resolveChatHistoryTarget(action);
      if ('error' in target) {
        return { ok: false, error: target.error };
      }
      if (target.tab.planMode !== action.enabled) {
        useChatStore.getState().togglePlanMode({
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
        });
      }
      return {
        ok: true,
        result: {
          ...chatSettingsResult(target),
          planMode: action.enabled,
        },
      };
    }
    case 'worktree-chat.set_interface_mode': {
      if (!isClaudeTuiChatsEnabled() && action.mode !== 'canopy') {
        return { ok: false, error: claudeTuiChatsUnavailableError() };
      }
      const target = await resolveChatHistoryTarget(action);
      if ('error' in target) {
        return { ok: false, error: target.error };
      }
      // App Advisor must respect the same idle-gating the UI enforces. If
      // either runtime is busy, refuse the switch with a structured error so
      // the assistant can prompt the user to wait.
      const tab = target.tab;
      if (!isClaudeBackedChatTab(tab)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'Chat-interface mode toggle is only available on Claude-backed chats.',
          },
        };
      }
      const claudeTerminalSnapshot =
        useClaudeTerminalStore
          .getState()
          .getStateForChat(
            target.projectId,
            target.worktreeId,
            target.chatId,
          ) ?? tab.claudeTerminal;
      const canopyNativeBusy = tab.status === 'streaming';
      const terminalBusy = CLAUDE_TERMINAL_BUSY_TURN_STATES.has(
        claudeTerminalSnapshot?.turnState ?? 'uninitialized',
      );
      if (
        (action.mode === 'claude-code' || action.mode === 'auto') &&
        canopyNativeBusy
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: `Claude Code is available when the ${brandText.appName} turn is idle.`,
            retryable: true,
          },
        };
      }
      if (action.mode === 'claude-code' && terminalBusy) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Claude Code is available when its terminal is idle.',
            retryable: true,
          },
        };
      }
      if (action.mode === 'canopy' && terminalBusy) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: `${brandText.appName} is available when the Claude Code turn is idle.`,
            retryable: true,
          },
        };
      }
      const disposition = await useChatStore
        .getState()
        .setChatInterfaceMode(target.chatId, action.mode, {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
        });
      if (disposition && disposition !== 'accepted') {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Failed to persist the chat interface mode.',
            retryable: true,
          },
        };
      }
      return {
        ok: true,
        result: {
          ...chatSettingsResult(target),
          interfaceMode: action.mode,
        },
      };
    }
    case 'home.set_execution_harness': {
      const draft = useHomeComposerStore.getState();
      const model =
        draft.model ?? resolveHomeEffectiveDefaults(draft.workspaceId).model;
      if (
        useNavigationStore.getState().activePage !== 'home' ||
        draft.mode !== 'chat' ||
        !draft.workspaceId ||
        useProjectsStore
          .getState()
          .projects.find((project) => project.id === draft.workspaceId)
          ?.type === 'cowork' ||
        draft.scheduledSendDraft ||
        !getChatHarnessOptions(model).includes(action.executionHarness)
      ) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'Select a supported model in a fresh Code chat to change its harness.',
          },
        };
      }
      draft.setExecutionHarness(action.executionHarness);
      return {
        ok: true,
        result: {
          executionHarness: action.executionHarness,
        },
      };
    }
    case 'worktree-chat.set_model': {
      if (getProviderForModel(action.model) === 'cursor') {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Cursor is not available through ${ORCHESTRATOR_LABEL} model changes.`,
          },
        };
      }
      const target = await resolveChatHistoryTarget(action);
      if ('error' in target) {
        return { ok: false, error: target.error };
      }
      const accepted = await useChatStore.getState().setModelAndWait(
        action.model,
        {
          projectId: target.projectId,
          worktreeId: target.worktreeId,
          chatId: target.chatId,
        },
        action.executionHarness,
      );
      if (!accepted) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'The model or harness change was not accepted.',
          },
        };
      }
      const updatedTab = useChatStore
        .getState()
        .worktreeChats[
          `${target.projectId}/${target.worktreeId}`
        ]?.tabs.find((tab) => tab.id === target.chatId);
      return {
        ok: true,
        result: {
          ...chatSettingsResult({ ...target, tab: updatedTab ?? target.tab }),
          model: action.model,
          ...(updatedTab?.executionHarness
            ? { executionHarness: updatedTab.executionHarness }
            : {}),
        },
      };
    }
    case 'worktree-chat.set_thinking_level': {
      const target = await resolveChatHistoryTarget(action);
      if ('error' in target) {
        return { ok: false, error: target.error };
      }
      await useChatStore.getState().setThinkingLevel(action.level, {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      });
      return {
        ok: true,
        result: {
          ...chatSettingsResult(target),
          thinkingLevel: action.level,
        },
      };
    }
    case 'pipeline-assistant-chat.create_tab':
      return createPipelineAssistantChatTabResult(action);
    case 'pipeline-assistant-chat.switch_tab':
      return pipelineAssistantChatSwitchTabResult(action);
    case 'pipeline-assistant-chat.send_message':
      return sendPipelineAssistantChatMessageResult(action);
    case 'pipeline-assistant-chat.set_model': {
      if (getProviderForModel(action.model) === 'cursor') {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'Cursor is not available in Pipeline Assistant.',
          },
        };
      }
      const target = await resolvePipelineAssistantChatHistoryTarget(action);
      if ('error' in target) return { ok: false, error: target.error };
      useChatStore.getState().setModel(action.model, {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      });
      return {
        ok: true,
        result: {
          ...chatSettingsResult(target),
          model: action.model,
        },
      };
    }
    case 'pipeline-assistant-chat.set_thinking_level': {
      const target = await resolvePipelineAssistantChatHistoryTarget(action);
      if ('error' in target) return { ok: false, error: target.error };
      await useChatStore.getState().setThinkingLevel(action.level, {
        projectId: target.projectId,
        worktreeId: target.worktreeId,
        chatId: target.chatId,
      });
      return {
        ok: true,
        result: {
          ...chatSettingsResult(target),
          thinkingLevel: action.level,
        },
      };
    }
    case 'standalone-chat.switch_project': {
      const project = await getStandaloneProjectOrError(action.projectId);
      if ('error' in project) {
        return { ok: false, error: project.error };
      }
      // Work Entries Phase 3: switching a project auto-selects the most
      // recent Work Entry (created when none exist); report that entry's
      // active chat tab. Dedicated entry-level actions land in Phase 3.
      await useStandaloneChatStore
        .getState()
        .switchChatProject(action.projectId);
      const newestEntryId =
        useStandaloneChatStore.getState().workEntries[0]?.id ?? null;
      if (
        newestEntryId !== null &&
        useStandaloneChatStore.getState().activeWorkEntryId !== newestEntryId
      ) {
        await useStandaloneChatStore.getState().selectWorkEntry(newestEntryId);
      }
      const activeEntryId = useStandaloneChatStore.getState().activeWorkEntryId;
      const activeChatId = activeEntryId
        ? (useChatStore.getState().worktreeChats[
            `${action.projectId}/${activeEntryId}`
          ]?.activeTabId ?? null)
        : null;
      useNavigationStore.getState().navigate('chat');
      return {
        ok: true,
        result: {
          activeProjectId: action.projectId,
          project: standaloneProjectSummary(project),
          workEntryId: activeEntryId,
          chat: activeChatId ? { id: activeChatId } : null,
        },
      };
    }
    case 'standalone-chat.switch_chat': {
      const resolved = await resolveStandaloneProjectId(action.projectId);
      if (typeof resolved !== 'string') {
        return { ok: false, error: resolved.error };
      }
      // Work Entries Phase 3: live chats are resolved to their owning Work
      // Entry; the legacy flat chat list no longer exists.
      const resolution = await window.api.workEntries.resolveChat({
        projectId: resolved,
        chatId: action.chatId,
      });
      if (resolution.entryId === null) {
        if (resolution.archivedInEntryId !== null) {
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message:
                'Archived standalone chats cannot be made the active chat. Use standalone-chat.read_history to inspect archived data.',
            },
          };
        }
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Standalone chat ${action.chatId} was not found in project ${resolved}.`,
          },
        };
      }
      const switched = await useStandaloneChatStore
        .getState()
        .switchChatProject(resolved);
      if (!switched) {
        return {
          ok: false,
          error: {
            code: 'stale_ui_state',
            message:
              'The project selection changed before the requested chat could be revealed.',
          },
        };
      }
      // Main may have just committed an entry absent from the renderer's list.
      // Refresh before selecting it; never synthesize an entry or fallback tab.
      const destination = currentCoworkDestinationRequestId();
      await useStandaloneChatStore.getState().refreshWorkEntries(resolved);
      // A selection the user made during the refresh wins over this reveal.
      const selected =
        currentCoworkDestinationRequestId() === destination &&
        (await useStandaloneChatStore.getState().selectChat(action.chatId));
      if (!selected) {
        return {
          ok: false,
          error: {
            code: 'stale_ui_state',
            message:
              'The chat selection changed before the requested chat could be revealed.',
          },
        };
      }
      useNavigationStore.getState().navigate('chat');
      const target = await resolveStandaloneChatTarget(resolved, action.chatId);
      if ('error' in target) {
        return { ok: false, error: target.error };
      }
      return {
        ok: true,
        result: {
          // Main reuses this projection for the legacy send response without sending here.
          settings: chatSettingsResult(target),
          projectId: resolved,
          workEntryId: resolution.entryId,
          chat: standaloneChatSummary({
            id: action.chatId,
            title: target.tab.title,
            description: target.tab.description ?? '',
            createdAt: target.tab.createdAt,
            messageCount: target.tab.messages.length,
            providerType: target.tab.providerType,
            pluginSelections: target.tab.pluginSelections,
          }),
        },
      };
    }
    case 'standalone-chat.create_chat': {
      const project = await getStandaloneProjectOrError(action.projectId);
      if ('error' in project) {
        return { ok: false, error: project.error };
      }
      // Work Entries Phase 3: creating a workspace-level chat creates a new
      // multi-chat Work Entry; the entry's initial empty tab IS the new
      // chat. Dedicated entry-level actions land in Phase 3.
      await useStandaloneChatStore
        .getState()
        .switchChatProject(action.projectId);
      await useStandaloneChatStore.getState().createWorkEntry();
      const entryId = useStandaloneChatStore.getState().activeWorkEntryId;
      const chatStore = useChatStore.getState();
      let chatId = entryId
        ? (chatStore.worktreeChats[`${action.projectId}/${entryId}`]
            ?.activeTabId ?? null)
        : null;
      if (chatId === null) {
        chatId = createClientId();
        chatStore.createTabWithId(chatId);
      }
      useNavigationStore.getState().navigate('chat');
      // The fresh tab lives only in renderer memory until the debounced
      // persistence flush, so `resolveStandaloneChatTarget`'s disk-backed
      // entry resolution cannot find it yet — build the target directly.
      const createdTab = entryId
        ? useChatStore
            .getState()
            .worktreeChats[
              `${action.projectId}/${entryId}`
            ]?.tabs.find((tab) => tab.id === chatId)
        : undefined;
      if (entryId === null || createdTab === undefined) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Failed to create a standalone chat.',
          },
        };
      }
      const target: ChatHistoryTarget = {
        projectId: action.projectId,
        worktreeId: entryId,
        chatId,
        tab: createdTab,
      };
      return {
        ok: true,
        result: {
          projectId: action.projectId,
          workEntryId: entryId,
          chatId,
          chat: standaloneChatSummary({
            id: chatId,
            title: target.tab.title,
            description: target.tab.description ?? '',
            createdAt: target.tab.createdAt,
            messageCount: target.tab.messages.length,
            providerType: target.tab.providerType,
            pluginSelections: target.tab.pluginSelections,
          }),
          settings: chatSettingsResult(target),
        },
      };
    }
    case 'standalone-chat.rename_work_entry': {
      const project = await getStandaloneProjectOrError(action.projectId);
      if ('error' in project) {
        return { ok: false, error: project.error };
      }
      const { entries } = await window.api.workEntries.list({
        projectId: action.projectId,
      });
      if (!entries.some((entry) => entry.id === action.workEntryId)) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Work Entry ${action.workEntryId} was not found in cowork project ${action.projectId}.`,
          },
        };
      }
      await useStandaloneChatStore
        .getState()
        .renameWorkEntry(action.workEntryId, action.title, action.projectId);
      return {
        ok: true,
        result: {
          projectId: action.projectId,
          workEntryId: action.workEntryId,
          title: action.title,
        },
      };
    }
    case 'standalone-chat.delete_work_entry': {
      const project = await getStandaloneProjectOrError(action.projectId);
      if ('error' in project) {
        return { ok: false, error: project.error };
      }
      const { entries } = await window.api.workEntries.list({
        projectId: action.projectId,
      });
      if (!entries.some((entry) => entry.id === action.workEntryId)) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Work Entry ${action.workEntryId} was not found in cowork project ${action.projectId}.`,
          },
        };
      }
      await useStandaloneChatStore
        .getState()
        .deleteWorkEntry(action.workEntryId, action.projectId);
      return {
        ok: true,
        result: {
          projectId: action.projectId,
          workEntryId: action.workEntryId,
          deleted: true,
        },
      };
    }
    case 'standalone-chat.send_message':
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Chat sends must run in the main process.',
        },
      };
    case 'standalone-chat.set_model': {
      const target = await resolveStandaloneChatTarget(
        action.projectId,
        action.chatId,
      );
      if ('error' in target) {
        return { ok: false, error: target.error };
      }
      const archivedError = archivedStandaloneMutationError(target);
      if (archivedError) return { ok: false, error: archivedError };
      // Await the canonical IPC like `worktree-chat.set_model` does: main can
      // refuse (a Cursor model while the managed runtime is disconnected, a
      // policy-blocked model), and App Advisor must hear that refusal rather
      // than a success for a change that never landed.
      const accepted = await useChatStore
        .getState()
        .setModelAndWait(action.model, {
          projectId: action.projectId,
          worktreeId: target.worktreeId,
          chatId: action.chatId,
        });
      if (!accepted) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'The model change was not accepted.',
          },
        };
      }
      return {
        ok: true,
        result: {
          ...chatSettingsResult(target),
          model: action.model,
        },
      };
    }
    case 'standalone-chat.set_thinking_level': {
      const target = await resolveStandaloneChatTarget(
        action.projectId,
        action.chatId,
      );
      if ('error' in target) {
        return { ok: false, error: target.error };
      }
      const archivedError = archivedStandaloneMutationError(target);
      if (archivedError) return { ok: false, error: archivedError };
      await useChatStore.getState().setThinkingLevel(action.level, {
        projectId: action.projectId,
        worktreeId: target.worktreeId,
        chatId: action.chatId,
      });
      return {
        ok: true,
        result: {
          ...chatSettingsResult(target),
          thinkingLevel: action.level,
        },
      };
    }
    case 'standalone-chat.update_settings': {
      const project = await getStandaloneProjectOrError(action.projectId);
      if ('error' in project) {
        return { ok: false, error: project.error };
      }
      if (action.name !== undefined && action.name.trim().length === 0) {
        return {
          ok: false,
          error: {
            code: 'invalid_payload',
            message: 'Cowork project name cannot be empty.',
          },
        };
      }
      const updateRequest: UpdateChatProjectRequest = {
        projectId: action.projectId,
        ...(action.name !== undefined ? { name: action.name } : {}),
        ...(action.description !== undefined
          ? { description: action.description }
          : {}),
        ...(action.color !== undefined ? { color: action.color } : {}),
        ...(action.defaultModel !== undefined
          ? { defaultModel: action.defaultModel }
          : {}),
        ...(action.defaultPresetId !== undefined
          ? { defaultPresetId: action.defaultPresetId }
          : {}),
        ...(action.defaultPluginSelections !== undefined
          ? { defaultPluginSelections: action.defaultPluginSelections }
          : {}),
        ...(action.presets !== undefined ? { presets: action.presets } : {}),
        ...(action.archiveRetentionDays !== undefined
          ? { archiveRetentionDays: action.archiveRetentionDays }
          : {}),
        ...(action.autoArchiveDays !== undefined
          ? { autoArchiveDays: action.autoArchiveDays }
          : {}),
        ...(action.alwaysShow !== undefined
          ? { alwaysShow: action.alwaysShow }
          : {}),
      };
      await useStandaloneChatStore.getState().updateChatProject(updateRequest);
      if (action.claudeMd !== undefined) {
        const loaded = await window.api.chatProject.loadClaudeMd({
          projectId: action.projectId,
        });
        const saved = await window.api.chatProject.saveClaudeMd({
          projectId: action.projectId,
          content: action.claudeMd,
          revision: loaded.revision,
        });
        if (saved.status !== 'saved') {
          return {
            ok: false,
            error: { code: 'execution_failed', message: saved.message },
          };
        }
      }
      await useStandaloneChatStore.getState().loadChatProjects();
      const updated =
        useStandaloneChatStore
          .getState()
          .chatProjects.find(
            (candidate) => candidate.id === action.projectId,
          ) ?? project;
      return {
        ok: true,
        result: {
          project: updated as unknown as AppAdvisorJson,
          summary: standaloneProjectSummary(updated),
          updatedFields: Object.keys(updateRequest).filter(
            (key) => key !== 'projectId',
          ),
          claudeMdUpdated: action.claudeMd !== undefined,
        },
      };
    }
    case 'environment.update_workspace_assignment': {
      await ensureProjectsHydrated();
      const workspace = getWorkspaceOrError(action.workspaceId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      const loaded = await window.api.loadEnvironmentConfig();
      if (!('data' in loaded)) {
        const failure = loaded.secureStorageFailure;
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: loaded.error,
            ...(failure ? { retryable: failure.retryable } : {}),
          },
          ...(failure
            ? { result: { secureStorageFailure: { ...failure } } }
            : {}),
        };
      }
      const { data } = loaded;
      const environmentIds = new Set(
        data.environments.map((environment) => environment.id),
      );
      for (const runtime of ENVIRONMENT_RUNTIMES) {
        const environmentId = action.runtimes[runtime];
        if (environmentId && !environmentIds.has(environmentId)) {
          return {
            ok: false,
            error: {
              code: 'not_found',
              message: `Environment ${environmentId} was not found.`,
            },
          };
        }
      }

      const existing = data.workspaceAssignments.find(
        (assignment) => assignment.workspaceId === action.workspaceId,
      );
      const runtimes: Partial<Record<EnvironmentRuntime, string | null>> = {
        ...existing?.runtimes,
      };
      for (const runtime of ENVIRONMENT_RUNTIMES) {
        if (!(runtime in action.runtimes)) continue;
        const environmentId = action.runtimes[runtime];
        if (environmentId === null || environmentId === undefined) {
          delete runtimes[runtime];
        } else {
          runtimes[runtime] = environmentId;
        }
      }

      const workspaceAssignments = data.workspaceAssignments.filter(
        (assignment) => assignment.workspaceId !== action.workspaceId,
      );
      if (Object.keys(runtimes).length > 0) {
        workspaceAssignments.push({
          workspaceId: action.workspaceId,
          runtimes,
          updatedAt: new Date().toISOString(),
        });
      }
      await useEnvironmentsStore.getState().saveWorkspaceAssignments({
        ...data,
        workspaceAssignments,
      });
      return {
        ok: true,
        result: {
          workspaceId: action.workspaceId,
          runtimes,
        },
      };
    }
    case 'pipeline.open_editor': {
      const editOptions =
        action.section !== undefined ? { section: action.section } : undefined;
      if (action.sharedRemoteId) {
        useNavigationStore.getState().openPipelineEdit(
          {
            pipelineId: null,
            sharedRemoteId: action.sharedRemoteId,
          },
          editOptions,
        );
        return { ok: true };
      }
      if (action.projectId && action.worktreeId && action.pipelineId) {
        const cwd = await window.api.getWorktreePath({
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          ...(action.repoId ? { repoId: action.repoId } : {}),
        });
        const result = await window.pipelines.discoverProject(cwd);
        const pipeline = result.data?.find(
          (candidate) => candidate.id === action.pipelineId,
        );
        if (!result.success || !pipeline?.filePath) {
          return {
            ok: false,
            error: {
              code: 'not_found',
              message:
                result.error ??
                `Project pipeline ${action.pipelineId} was not found.`,
            },
          };
        }
        useNavigationStore.getState().openPipelineEdit(
          {
            pipelineId: action.pipelineId,
            cwd,
            filePath: pipeline.filePath,
          },
          editOptions,
        );
        return { ok: true };
      }
      useNavigationStore.getState().openPipelineEdit(
        {
          pipelineId: action.pipelineId ?? '',
          cwd: action.cwd,
          filePath: action.filePath,
        },
        editOptions,
      );
      return { ok: true };
    }
    case 'pipeline.open_curated_preview':
      useNavigationStore.getState().openCuratedPipelinePreview(action.key);
      return { ok: true };
    case 'pipeline.create':
      return createLocalPipelineResult(action);
    case 'pipeline.save':
      window.dispatchEvent(new Event('canopy:pipeline-save-active'));
      return { ok: true };
    case 'pipeline.update':
      return updateLocalPipelineResult(action);
    case 'pipeline.delete': {
      const result = await window.pipelines.delete(action.pipelineId);
      if (!result.success) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: result.error ?? 'Failed to delete pipeline.',
          },
        };
      }
      return { ok: true, result: { pipelineId: action.pipelineId } };
    }
    case 'pipeline.duplicate':
      return duplicatePipelineResult(action);
    case 'pipeline.share':
      return sharePipelineResult(action);
    case 'pipeline.update_shared':
      return updateSharedPipelineResult(action);
    case 'pipeline.delete_shared':
      return deleteSharedPipelineResult(action);
    case 'pipeline.set_enabled': {
      try {
        const disabledPipelineIds = await setPipelineDisabled(
          action.pipelineId,
          !action.enabled,
        );
        const response = {
          ok: true as const,
          result: {
            pipelineId: action.pipelineId,
            enabled: action.enabled,
            disabledPipelineIds: Array.from(disabledPipelineIds),
          },
        };
        try {
          const cwd = await resolvePipelineScopeCwd(action);
          const pipeline = await loadRunnablePipeline(action.pipelineId, cwd);
          return pipeline
            ? attachAgentArtifacts(response, [
                await appAdvisorPipelineReceipt(action.type, pipeline, action),
              ])
            : response;
        } catch {
          return response;
        }
      } catch (error: unknown) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to update pipeline enabled state.',
          },
        };
      }
    }
    case 'pipeline.list':
      return loadPipelinesForScope(action);
    case 'pipeline.get':
      return getPipelineDetailsResult(action);
    case 'pipeline.open_run': {
      // Success only once the run is shown: its panel revealed in its own
      // worktree or Cowork task, or the compatibility view for a run with no
      // workspace. Every other outcome is a structured error.
      const result = await openPipelineExecutionPanel({
        executionId: action.executionId,
        ...(action.projectId && action.worktreeId
          ? {
              owner: {
                projectId: action.projectId,
                worktreeId: action.worktreeId,
              },
            }
          : {}),
        ...(action.jobId ? { target: { jobId: action.jobId } } : {}),
      });
      return pipelineOpenRunResponse(result);
    }
    // The window's own Debug buttons dispatch this with source 'ui'; App
    // Advisor's debug runs in main (CAN-6001).
    case 'pipeline.debug_run': {
      const context = await buildPipelineFailureDebugContext(
        action.executionId,
      );
      if (!context) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Pipeline execution ${action.executionId} not found or not failed.`,
          },
        };
      }
      const prompt = await buildPipelineFailureDebugPromptForExecution(
        action.executionId,
      );
      if (!prompt) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Failed to build pipeline-debug prompt.',
          },
        };
      }
      const title = context.pipelineName
        ? `Debug ${context.pipelineName}`
        : deriveTitleFromPrompt(prompt);
      const chatId =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `pipeline-debug-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2)}`;
      const windowState = await window.api.appAdvisor.openWindow({
        focus: true,
        focusComposer: true,
        quickPrompt: prompt,
        quickPromptTitle: title,
        quickPromptChatId: chatId,
      });
      useAppAdvisorStore.getState().syncWindowState(windowState);
      return { ok: true, result: { chatId } };
    }
    case 'pipeline.execution_list_for_worktree':
    case 'pipeline.execution_list':
      return listPipelineExecutionsResult(action);
    case 'pipeline.execution_get':
      return executionGetResult(action);
    case 'pipeline.execution_cancel': {
      const cloud = await cloudExecutionAnswer(action.executionId, (access) =>
        cancelCloudRun(
          access,
          action.executionId,
          `app-advisor:${request.requestId}`,
        ),
      );
      if (cloud) return cloud;
      const result = await window.pipelines.cancelExecution(action.executionId);
      if (!result.success) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: result.error ?? 'Failed to cancel pipeline execution.',
          },
        };
      }
      return { ok: true, result: result as unknown as AppAdvisorJson };
    }
    case 'pipeline.execution_retry_matrix_job': {
      try {
        const state = await window.pipelines.retryMatrixJob({
          executionId: action.executionId,
          jobId: action.jobId,
          mode: action.mode,
          ...(action.variantJobIds
            ? { variantJobIds: action.variantJobIds }
            : {}),
        });
        return { ok: true, result: executionDetails(state) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to retry matrix job.',
          },
        };
      }
    }
    case 'pipeline.execution_cancel_matrix_variant': {
      try {
        const state = await window.pipelines.cancelMatrixVariant({
          executionId: action.executionId,
          jobId: action.jobId,
          variantJobId: action.variantJobId,
        });
        return { ok: true, result: executionDetails(state) };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to cancel matrix variant.',
          },
        };
      }
    }
    case 'pipeline.execution_resume': {
      const cloud = await cloudExecutionAnswer(action.executionId, (access) =>
        resumeCloudRun(
          access,
          action.executionId,
          {
            ...(action.statusReasonIds
              ? { statusReasonIds: action.statusReasonIds }
              : {}),
            ...(action.pauseResponses
              ? { pauseResponses: action.pauseResponses }
              : {}),
          },
          `app-advisor:${request.requestId}`,
        ),
      );
      if (cloud) return cloud;
      const result = await window.pipelines.resumeAutomation(
        action.executionId,
        {
          ...(action.statusReasonIds
            ? { statusReasonIds: action.statusReasonIds }
            : {}),
          ...(action.pauseResponses
            ? {
                pauseResponses: action.pauseResponses.map((response) => ({
                  ...(response.checkpointId
                    ? { checkpoint_id: response.checkpointId }
                    : {}),
                  job_id: response.jobId,
                  step_id: response.stepId,
                  ...(response.answers ? { answers: response.answers } : {}),
                })),
              }
            : {}),
        },
      );
      if (!result.success || !result.data) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: result.error ?? 'Failed to resume pipeline execution.',
          },
        };
      }
      const receipt = pipelineExecutionArtifact(action.type, result.data);
      return receipt
        ? attachAgentArtifacts(
            { ok: true, result: executionDetails(result.data) },
            [receipt],
          )
        : { ok: true, result: executionDetails(result.data) };
    }
    case 'pipeline.execution_retry': {
      // A cloud run has no retry yet, as on cloud chats.
      const cloud = await cloudExecutionAnswer(
        action.executionId,
        async (access) => {
          await readCloudRun(access, action.executionId);
          throw new AgentPortError(
            'unsupported_action',
            CLOUD_RUN_RETRY_UNSUPPORTED,
          );
        },
      );
      if (cloud) return cloud;
      const result = await window.pipelines.retryExecution(action.executionId);
      if (!result.success || !result.data) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: result.error ?? 'Failed to retry pipeline execution.',
          },
        };
      }
      const receipt = pipelineExecutionArtifact(action.type, result.data);
      return receipt
        ? attachAgentArtifacts(
            { ok: true, result: result as unknown as AppAdvisorJson },
            [receipt],
          )
        : { ok: true, result: result as unknown as AppAdvisorJson };
    }
    case 'pipeline.execution_chain':
      return chainPipelineFromExecution(action);
    case 'file.open': {
      const target = {
        projectId: action.projectId,
        worktreeId: action.worktreeId,
      };
      useChatStore
        .getState()
        .selectWorktree(target.projectId, target.worktreeId);
      const chat = useChatStore.getState();
      const worktreeChat =
        chat.worktreeChats[`${target.projectId}/${target.worktreeId}`];
      const activeTab = worktreeChat?.tabs.find(
        (tab) => tab.id === worktreeChat.activeTabId,
      );
      const file = {
        absolutePath: action.path,
        filename: action.path.split(/[\\/]/).pop() ?? action.path,
      };
      if (
        activeTab?.kind === 'file' &&
        (activeTab.filePath === undefined || activeTab.filePath === '')
      ) {
        const assigned = chat.assignFileTab(activeTab.id, file, target);
        if (assigned === activeTab.id) {
          useFileTabUiStore.getState().setFileTreeVisible(activeTab.id, false);
        }
      } else {
        chat.openFileTab(file, target);
      }
      return { ok: true };
    }
    case 'file.send_selection_to_chat': {
      const chat = useChatStore.getState();
      const selected = chat.selectedWorktree;
      if (!selected) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'No worktree is selected.',
            retryable: true,
          },
        };
      }
      const splitLockError = refuseIfSplitLocked(
        selected.projectId,
        selected.worktreeId,
      );
      if (splitLockError) {
        return { ok: false, error: splitLockError };
      }
      const worktreeChat =
        chat.worktreeChats[`${selected.projectId}/${selected.worktreeId}`];
      const activeTab = worktreeChat?.tabs.find(
        (tab) => tab.id === worktreeChat.activeTabId,
      );
      if (!activeTab || activeTab.kind !== 'file') {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'The active tab is not a file editor.',
          },
        };
      }
      let handled = false;
      const detail: SendEditorSelectionToChatDetail = {
        tabId: activeTab.id,
        markHandled: (): void => {
          handled = true;
        },
      };
      document.dispatchEvent(
        new CustomEvent(SEND_EDITOR_SELECTION_TO_CHAT_EVENT, { detail }),
      );
      return handled
        ? { ok: true }
        : {
            ok: false,
            error: {
              code: 'invalid_target',
              message:
                'The active file editor does not have a non-empty selection.',
            },
          };
    }
    case 'file.save_active': {
      const chat = useChatStore.getState();
      const selected = chat.selectedWorktree;
      if (!selected) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'No worktree is selected.',
            retryable: true,
          },
        };
      }
      const saveActiveLockError = refuseIfSplitLocked(
        selected.projectId,
        selected.worktreeId,
      );
      if (saveActiveLockError) {
        return { ok: false, error: saveActiveLockError };
      }
      const wc =
        chat.worktreeChats[`${selected.projectId}/${selected.worktreeId}`];
      const activeTab = wc?.tabs.find((tab) => tab.id === wc.activeTabId);
      if (!activeTab || activeTab.kind !== 'file') {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'The active tab is not an editable file.',
          },
        };
      }
      const saved = await desktopFileSessionController.saveTab(activeTab.id);
      return saved
        ? { ok: true }
        : {
            ok: false,
            error: {
              code: 'execution_failed',
              message: 'Unable to save the active file.',
            },
          };
    }
    case 'file.preview_search_open':
    case 'file.preview_search_close': {
      let handled = false;
      const detail: FilePreviewSearchEventDetail = {
        operation:
          action.type === 'file.preview_search_open' ? 'open' : 'close',
        acknowledge: (): void => {
          handled = true;
        },
      };
      window.dispatchEvent(
        new CustomEvent(FILE_PREVIEW_SEARCH_EVENT, { detail }),
      );
      return handled
        ? { ok: true }
        : {
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'The active tab does not have a searchable preview.',
            },
          };
    }
    case 'terminal.open': {
      const terminalOpenLockError = refuseIfSplitLocked(
        action.projectId,
        action.worktreeId,
      );
      if (terminalOpenLockError) {
        return { ok: false, error: terminalOpenLockError };
      }
      useChatStore
        .getState()
        .selectWorktree(action.projectId, action.worktreeId);
      await ensureTerminalWorktreeHydrated(action.projectId, action.worktreeId);
      useTerminalStore
        .getState()
        .setDrawerCollapsed(action.projectId, action.worktreeId, false);
      return { ok: true };
    }
    case 'terminal.close': {
      const terminalStore = useTerminalStore.getState();
      if (action.sessionId) {
        const selected = useChatStore.getState().selectedWorktree;
        if (!selected) {
          return {
            ok: false,
            error: {
              code: 'surface_unavailable',
              message: 'No worktree is selected.',
              retryable: true,
            },
          };
        }
        terminalStore.removeTerminal(
          selected.projectId,
          selected.worktreeId,
          action.sessionId,
        );
        return { ok: true };
      }
      const selected = useChatStore.getState().selectedWorktree;
      if (!selected) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'No worktree is selected.',
            retryable: true,
          },
        };
      }
      terminalStore.setDrawerCollapsed(
        selected.projectId,
        selected.worktreeId,
        true,
      );
      return { ok: true };
    }
    case 'panel.split': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      const groupId = resolvePanelGroupId(target.layout, action.groupId);
      if (groupId === null) {
        return panelGroupNotFound(action.groupId);
      }
      const newGroupId = usePanelLayoutStore
        .getState()
        .splitGroup(target.worktreeKey, groupId, action.direction);
      if (newGroupId === null) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Unable to split the panel group.',
          },
        };
      }
      return { ok: true, result: { newGroupId } };
    }
    case 'panel.set_layout_mode': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      const changed = await setWorkspacePanelLayoutMode(
        target.worktreeKey,
        action.mode,
      );
      if (!changed) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Unable to change the project panel layout mode.',
          },
        };
      }
      return { ok: true };
    }
    case 'panel.focus': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      if (!target.layout.groups[action.groupId]) {
        return panelGroupNotFound(action.groupId);
      }
      usePanelLayoutStore
        .getState()
        .focusGroup(target.worktreeKey, action.groupId);
      return { ok: true };
    }
    case 'panel.reset_layout': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      const reset = await resetLayoutToDefault(target.worktreeKey);
      if (!reset) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'The panel layout could not be reset (no live layout, or persistence is suspended for migration recovery).',
          },
        };
      }
      return { ok: true };
    }
    case 'panel.close': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      const groupId = resolvePanelGroupId(target.layout, action.groupId);
      if (groupId === null) {
        return panelGroupNotFound(action.groupId);
      }
      if (Object.keys(target.layout.groups).length <= 1) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'The last remaining panel group cannot be closed.',
          },
        };
      }
      const closed = usePanelLayoutStore
        .getState()
        .closeGroup(target.worktreeKey, groupId);
      if (!closed) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message:
              'This panel group cannot be closed in the current layout mode.',
          },
        };
      }
      return { ok: true };
    }
    case 'panel.maximize': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      if (action.maximized) {
        const groupId = resolvePanelGroupId(target.layout, action.groupId);
        if (groupId === null) {
          return panelGroupNotFound(action.groupId);
        }
        if (Object.keys(target.layout.groups).length < 2) {
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: 'Maximizing requires at least two panel groups.',
            },
          };
        }
        usePanelLayoutStore
          .getState()
          .maximizeGroup(target.worktreeKey, groupId, true);
        return { ok: true };
      }
      const maximizedGroupId = target.layout.maximizedGroupId;
      if (maximizedGroupId === null) {
        // Nothing is maximized — restoring is an idempotent no-op.
        return { ok: true };
      }
      if (action.groupId !== undefined && action.groupId !== maximizedGroupId) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Panel group ${action.groupId} is not the maximized group.`,
          },
        };
      }
      usePanelLayoutStore
        .getState()
        .maximizeGroup(target.worktreeKey, maximizedGroupId, false);
      return { ok: true };
    }
    case 'ledger.open':
      return runLedgerOpenAction(action);
    case 'ledger.search':
    case 'ledger.add_entry':
      // CAN-6007: the App Advisor runtime searches and adds Feed entries in
      // main, as the advisor chat; these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Feed actions run in the main process.',
        },
      };
    case 'panel.add_tab': {
      if (
        action.kind === 'usage' &&
        action.variant === 'copilot' &&
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCopilotHarness.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'GitHub Copilot usage is not available.',
          },
        };
      }
      if (
        action.kind === 'usage' &&
        action.variant === 'cursor' &&
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopCursorHarness.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'Cursor usage is not available.',
          },
        };
      }
      if (
        action.kind === 'ledger' &&
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'The Feed is not available.',
          },
        };
      }
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      if (action.kind === 'chat-visuals') {
        // It opens beside its chat, as from a visual, wherever that is.
        return addChatVisualsPanelTab(action.chatTabId, target.worktreeKey);
      }
      const requestedGroupId = resolvePanelGroupId(
        target.layout,
        action.groupId,
      );
      const groupId =
        getWorkspaceLayoutMode(target.worktreeKey) === 'minimal'
          ? ensureMinimalDestination(target.worktreeKey, action.kind)
          : requestedGroupId;
      if (groupId === null) {
        return panelGroupNotFound(action.groupId);
      }
      if (action.kind === 'plan' || action.kind === 'plan-diagram') {
        return addPlanPanelTab(action, target.worktreeKey, groupId);
      }
      if (action.kind === 'cost') {
        return addCostPanelTab({ kind: 'cost' }, target.worktreeKey, groupId);
      }
      if (action.kind === 'session-breakdown') {
        return addCostPanelTab(
          { kind: 'session-breakdown', chatId: action.chatId },
          target.worktreeKey,
          groupId,
        );
      }
      if (action.kind === 'subagents') {
        return addSubagentsPanelTab(
          target.worktreeKey,
          action.groupId === undefined ? undefined : groupId,
        );
      }
      if (
        action.kind === 'file-diff' &&
        action.fileTabId === undefined &&
        action.filePath === undefined
      ) {
        const panelId = addEmptyFileTabPanelToGroup(
          target.worktreeKey,
          groupId,
        );
        return panelId === null
          ? {
              ok: false,
              error: {
                code: 'execution_failed',
                message: 'Unable to add the empty file tab.',
              },
            }
          : { ok: true, result: { panelId } };
      }
      if (action.kind === 'browser') {
        // Repeatable Browser panels use the same path as the add menu: the
        // bound panel is placed at once and its session is created in the
        // background (the pane shows an inline Retry if that fails).
        const separator = target.worktreeKey.indexOf('/');
        const projectId = target.worktreeKey.slice(0, separator);
        const worktreeId = target.worktreeKey.slice(separator + 1);
        const opened = useBrowserStore
          .getState()
          .openBrowser(projectId, worktreeId);
        if (opened === null) {
          return { ok: false, error: inAppBrowserUnavailableError() };
        }
        const { browserId } = opened;
        const releasePending = registerPendingBrowserActivation(browserId);
        let boundPanelId: string | null = null;
        try {
          boundPanelId =
            usePanelLayoutStore
              .getState()
              .addTab(target.worktreeKey, groupId, 'browser', {
                panelId: browserPanelIdFor(browserId),
                instance: { browserId },
              }) ??
            usePanelLayoutStore
              .getState()
              .addTab(target.worktreeKey, groupId, 'browser', {
                instance: { browserId },
              });
        } finally {
          releasePending();
        }
        if (boundPanelId === null) {
          const { discardOpenedBrowser } =
            await import('@/lib/panels/browser-panel-sync');
          await discardOpenedBrowser(projectId, worktreeId, browserId);
          return {
            ok: false,
            error: {
              code: 'execution_failed',
              message: 'Unable to add the panel tab.',
            },
          };
        }
        void useBrowserStore
          .getState()
          .setActiveBrowser(projectId, worktreeId, browserId);
        return { ok: true, result: { panelId: boundPanelId } };
      }
      const tabOptions = (():
        | {
            readonly title?: string;
            readonly instance?: Readonly<Record<string, string>>;
          }
        | undefined => {
        switch (action.kind) {
          case 'chat':
            return { instance: { chatTabId: action.chatTabId } };
          case 'file-diff':
            return {
              instance: {
                ...(action.fileTabId ? { fileTabId: action.fileTabId } : {}),
                ...(action.filePath ? { filePath: action.filePath } : {}),
              },
            };
          case 'activity-card':
            return { instance: { sectionId: action.sectionId } };
          case 'usage':
            return {
              instance: { variant: action.variant },
              title: USAGE_PANEL_VARIANT_LABELS[action.variant],
            };
          case 'automations':
            return {
              instance: { variant: action.variant },
              title: AUTOMATIONS_PANEL_VARIANT_LABELS[action.variant],
            };
          default:
            return undefined;
        }
      })();
      const panelId = usePanelLayoutStore
        .getState()
        .addTab(target.worktreeKey, groupId, action.kind, tabOptions);
      if (panelId === null) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Unable to add the panel tab.',
          },
        };
      }
      return { ok: true, result: { panelId } };
    }
    case 'panel.move': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      const sourceGroupId = Object.keys(target.layout.groups).find((gid) =>
        target.layout.groups[gid].tabs.some(
          (tab) => tab.panelId === action.panelId,
        ),
      );
      if (sourceGroupId === undefined) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Panel ${action.panelId} was not found in the current layout.`,
          },
        };
      }
      if (!target.layout.groups[action.targetGroupId]) {
        return panelGroupNotFound(action.targetGroupId);
      }
      const moved = usePanelLayoutStore
        .getState()
        .movePanel(
          target.worktreeKey,
          action.panelId,
          action.targetGroupId,
          action.edge,
        );
      if (!moved) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'This panel cannot be moved in the current layout mode.',
          },
        };
      }
      return { ok: true };
    }
    case 'panel.arrange': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      usePanelLayoutStore
        .getState()
        .arrangeGroups(target.worktreeKey, action.arrangement);
      return { ok: true };
    }
    case 'panel.save_default_layout': {
      const target = resolvePanelLayoutTarget();
      if (isPanelActionFailure(target)) {
        return target;
      }
      const saved = await saveCurrentLayoutAsDefault(target.worktreeKey);
      if (!saved) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: 'Unable to save the current panel layout as the default.',
          },
        };
      }
      return { ok: true, result: { saved: true } };
    }
    case 'canopy_portal.open':
      // The Remote Control dialog follows device Remote Control, not the
      // Portal flag: Portal only follows its opt-in (CAN-5985).
      if (!useRemoteControlStore.getState().state.available) {
        useGitHubStore
          .getState()
          .addToast(CANOPY_PORTAL_DISABLED_TOAST, 'info');
        return canopyPortalDisabledResponse();
      }
      useNavigationStore.getState().openCanopyPortal();
      return { ok: true };
    case 'canopy_portal.close':
      useNavigationStore.getState().closeCanopyPortal();
      return { ok: true };
    case 'canopy_portal.open_account_settings': {
      if (
        rejectIfPortalDisabled(`open ${PORTAL_NAME_INLINE} account settings`)
      ) {
        return canopyPortalDisabledResponse();
      }
      useNavigationStore.getState().closeCanopyPortal();
      openCloudAccountSettings();
      // Touch the Portal store so the reporter snapshot stays accurate.
      void useCanopyPortalStore.getState().hydrate();
      return { ok: true };
    }
    case 'app_advisor.open': {
      // User-visible open: creates the BrowserWindow if missing, then
      // shows/focuses/raises it. Idempotent in main — calling on an
      // already-visible window focuses + raises rather than toggling off.
      const state = await window.api.appAdvisor.openWindow({
        focus: true,
        focusComposer: true,
      });
      useAppAdvisorStore.getState().syncWindowState(state);
      return { ok: true };
    }
    case 'app_advisor.close': {
      // Hide-only: pending questions, sessions, and transcripts survive in
      // the App Advisor renderer's in-memory state because the
      // BrowserWindow stays alive.
      const state = await window.api.appAdvisor.closeWindow();
      useAppAdvisorStore.getState().syncWindowState(state);
      return { ok: true };
    }
    case 'app_advisor.toggle': {
      const state = await window.api.appAdvisor.toggleWindow({ focus: true });
      useAppAdvisorStore.getState().syncWindowState(state);
      return { ok: true };
    }
    case 'watcher.list':
    case 'watcher.get':
    case 'watcher.delete':
      // CAN-6007: the App Advisor runtime reads and deletes watchers in main;
      // these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Watcher actions run in the main process.',
        },
      };
    // ----------------------------------------------------------------------
    // Automations actions — bridge each App Advisor action verb onto the
    // matching `window.api.automations.*` IPC method. The transport plan
    // owns the validation of the union variants; the dispatcher just maps
    // request shapes and routes results back through the standard
    // `execution_failed` error envelope so the App Advisor surfaces the
    // backend's human-readable message without further translation.
    //
    // `automation.list` returns the persisted snapshot directly. The
    // mutating verbs translate failures into `execution_failed` and forward
    // success/payload data so the App Advisor can echo the new activity /
    // run id to the user.
    // ----------------------------------------------------------------------
    case 'automation.list': {
      try {
        // Only the selected context's automations (CAN-3448), scoped in main
        // by the same owner authority that authorizes runs, so this window
        // and the App Advisor window agree. Unchanged while org projects are
        // off. `automation.get` stays unscoped.
        const snapshot = await window.api.automations.list({
          scope: 'selected-context',
        });
        const result =
          action.includeRuns === false
            ? { activities: snapshot.activities }
            : snapshot;
        // Cast through `unknown` so the strongly-typed transport contract
        // can flow into the generic `AppAdvisorJson` envelope. The shape is
        // declared in the shared types package and remains JSON-serializable.
        return {
          ok: true,
          result: result as unknown as AppAdvisorJson,
        };
      } catch (error: unknown) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'Failed to load automations.',
          },
        };
      }
    }
    case 'automation.get': {
      try {
        const snapshot = await window.api.automations.list();
        const activity = snapshot.activities.find(
          (entry) => entry.id === action.id,
        );
        if (!activity) {
          return {
            ok: false,
            error: {
              code: 'not_found',
              message: `Triggered activity ${action.id} was not found.`,
            },
          };
        }
        const recentRuns = snapshot.recentRuns.filter(
          (run) => run.activityId === action.id,
        );
        return {
          ok: true,
          result: { activity, recentRuns } as unknown as AppAdvisorJson,
        };
      } catch (error: unknown) {
        return automationExecutionFailure(error);
      }
    }
    case 'automation.create':
    case 'automation.update':
      // CAN-4551 7c: agents' automation writes run in main, which marks them
      // agent-authored and converts them. No caller reaches this dispatcher
      // with one, and the person's save it would call would drop the marker.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: `${action.type} runs in the main process.`,
        },
      };
    case 'automation.disable': {
      try {
        const result = await window.api.automations.update({
          id: action.id,
          enabled: false,
        });
        return resolveAutomationMutation(result, action.type);
      } catch (error: unknown) {
        return automationExecutionFailure(error);
      }
    }
    case 'automation.delete': {
      try {
        const result = await window.api.automations.delete({ id: action.id });
        return resolveAutomationMutation(result);
      } catch (error: unknown) {
        return automationExecutionFailure(error);
      }
    }
    case 'automation.run_now': {
      try {
        const snapshot = await window.api.automations.list();
        const activity = snapshot.activities.find(
          (entry) => entry.id === action.id,
        );
        if (!activity) {
          return {
            ok: false,
            error: {
              code: 'not_found',
              message: `Triggered activity ${action.id} was not found.`,
            },
          };
        }
        if (activity.ifCommand?.trim()) {
          return rejectAdvisorAutomationPolicy(
            AGENT_AUTOMATION_IF_COMMAND_POLICY_ERROR,
          );
        }
        const policyError = validateAgentAutomationRunPolicy(activity.action);
        if (policyError) {
          return rejectAdvisorAutomationPolicy(policyError);
        }
        const result = await window.api.automations.runNow({ id: action.id });
        return resolveAutomationMutation(result);
      } catch (error: unknown) {
        return automationExecutionFailure(error);
      }
    }
    case 'shared-containers.open_invite': {
      // Opening the modal is not a share. The user still picks a recipient and
      // confirms the disclosure inside it, so this action deliberately stops
      // at "the invite surface is on screen".
      if (
        !useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopyDesktopSharedContainers.key)
      ) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: SHARED_CONTAINERS_DISABLED_MESSAGE,
          },
        };
      }
      await ensureProjectsHydrated();
      const workspace = getWorkspaceOrError(action.projectId);
      if ('error' in workspace) {
        return { ok: false, error: workspace.error };
      }
      if (action.containerType === 'COWORK_WORK_ENTRY') {
        if (workspace.type !== 'cowork') {
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: `Project ${action.projectId} is not a cowork project, so it has no Work Entries.`,
            },
          };
        }
        const { entries } = await window.api.workEntries.list({
          projectId: action.projectId,
        });
        if (!entries.some((entry) => entry.id === action.worktreeId)) {
          return {
            ok: false,
            error: {
              code: 'not_found',
              message: `Work Entry ${action.worktreeId} was not found in cowork project ${action.projectId}.`,
            },
          };
        }
      } else {
        if (workspace.type === 'cowork') {
          return {
            ok: false,
            error: {
              code: 'invalid_target',
              message: `Project ${action.projectId} is a cowork project and has no git worktrees.`,
            },
          };
        }
        if (
          !workspace.worktrees.some(
            (candidate) => candidate.id === action.worktreeId,
          )
        ) {
          return {
            ok: false,
            error: {
              code: 'not_found',
              message: `Worktree ${action.worktreeId} was not found in project ${action.projectId}.`,
            },
          };
        }
      }
      // The owning sidebar row renders the modal, and a collapsed workspace
      // only keeps its selected row mounted — expand first so the requested
      // row exists to render it.
      if (workspace.collapsed) {
        await useProjectsStore.getState().toggleCollapsed(action.projectId);
      }
      const inviteOpened = requestSharedContainerInvite({
        projectId: action.projectId,
        worktreeId: action.worktreeId,
        containerType: action.containerType,
        ...(action.audience ? { audience: action.audience } : {}),
      });
      if (!inviteOpened) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'The teammate invite dialog is not currently available.',
            retryable: true,
          },
        };
      }
      return {
        ok: true,
        result: {
          projectId: action.projectId,
          worktreeId: action.worktreeId,
          containerType: action.containerType,
          opened: true,
        },
      };
    }
    case 'shared-containers.revoke_recipient': {
      const confirmationOpened = requestSharedContainerRevocationConfirmation({
        containerId: action.containerId,
        recipientId: action.recipientId,
        ...(action.organizationId
          ? { organizationId: action.organizationId }
          : {}),
      });
      if (!confirmationOpened) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'The teammate access confirmation dialog is not currently available.',
            retryable: true,
          },
        };
      }
      return {
        ok: true,
        result: {
          containerId: action.containerId,
          recipientId: action.recipientId,
          organizationId: action.organizationId ?? null,
          confirmationOpened: true,
        },
      };
    }
    case 'shared-containers.open_received': {
      if (!isSharedContainerRecipientEnabled()) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: SHARED_CONTAINERS_DISABLED_MESSAGE,
          },
        };
      }
      const sharedStore = useSharedContainerReplicasStore.getState();
      const entry = sharedStore.entries.find(
        (candidate) =>
          candidate.container.id === action.containerId &&
          candidate.organizationId === action.organizationId,
      );
      if (!entry) {
        return {
          ok: false,
          error: {
            code: 'not_found',
            message: `Received shared container ${action.containerId} was not found.`,
          },
        };
      }
      if (!sharedContainerCanView(entry.container.capabilities)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'This shared container is not available to view.',
          },
        };
      }
      // Accepting a share is the user's decision, not the assistant's: it
      // authorizes cloning the publisher's repositories onto this machine.
      // Advisor can point at the invitation; it cannot consent on their behalf.
      if (!sharedStore.acceptedIds.includes(action.containerId)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message:
              'This share is still an invitation. Ask the user to accept it in the "Shared with you" sidebar section first, which is what authorizes downloading it to this device.',
          },
        };
      }
      try {
        await openSharedContainerInOwningContext({
          mode: 'open',
          resolveAccess: () =>
            Promise.resolve({
              ...entry.container,
              ...(entry.organizationId
                ? { organizationId: entry.organizationId }
                : {}),
              ...(entry.access ? { access: entry.access } : {}),
            }),
        });
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message:
              error instanceof Error
                ? error.message
                : 'The received share did not open.',
            retryable: true,
          },
        };
      }
      const viewer = useSharedContainerReplicasStore.getState().viewer;
      if (viewer?.containerId !== action.containerId || viewer.openError) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: viewer?.openError ?? 'The received share did not open.',
            retryable: true,
          },
        };
      }
      return {
        ok: true,
        result: {
          containerId: action.containerId,
          ...(action.organizationId
            ? { organizationId: action.organizationId }
            : {}),
          status: viewer.replica?.status ?? 'loading',
        },
      };
    }
    case 'shared-containers.retry_received': {
      if (!isSharedContainerRecipientEnabled()) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: SHARED_CONTAINERS_DISABLED_MESSAGE,
          },
        };
      }
      const sharedStore = useSharedContainerReplicasStore.getState();
      if (sharedStore.viewer?.containerId !== action.containerId) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: `Received shared container ${action.containerId} is not open.`,
          },
        };
      }
      const entry = sharedStore.entries.find(
        (candidate) =>
          candidate.container.id === action.containerId &&
          candidate.organizationId === sharedStore.viewer?.organizationId,
      );
      if (!sharedContainerCanView(entry?.container.capabilities)) {
        return {
          ok: false,
          error: {
            code: 'surface_unavailable',
            message: 'This shared container is not available to view.',
          },
        };
      }
      await sharedStore.retryContainer();
      const viewer = useSharedContainerReplicasStore.getState().viewer;
      if (viewer?.openError) {
        return {
          ok: false,
          error: {
            code: 'execution_failed',
            message: viewer.openError,
            retryable: true,
          },
        };
      }
      return {
        ok: true,
        result: {
          containerId: action.containerId,
          status: viewer?.replica?.status ?? 'loading',
        },
      };
    }
    case 'browser.profile.preview_clear':
    case 'browser.profile.clear':
    case 'browser.profile.job_get':
    case 'browser.profile.job_cancel':
    case 'browser.profile.list':
    case 'browser.profile.get':
    case 'browser.profile.switch':
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message:
            'Browser profile agent actions require the captured main-process task context.',
        },
      };
    case 'advisor-chat.create_entry':
    case 'advisor-chat.create_chat':
    case 'advisor-chat.send_message':
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: `${ORCHESTRATOR_LABEL} chat actions run in the main process from an ${ORCHESTRATOR_LABEL} chat.`,
        },
      };
    case 'projects.list':
    case 'projects.list_tasks':
    case 'projects.list_task_chats':
    case 'projects.get_last_user_message':
    case 'projects.get_last_agent_response':
    case 'projects.read_history':
    case 'projects.create_task':
    case 'projects.create_task_chat':
    case 'projects.send_message':
    case 'projects.steer_queued_message':
    case 'projects.schedule_message':
      // The App Advisor runtime answers project discovery and reads in main;
      // these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Project actions run in the main process.',
        },
      };
    case 'bots.list':
    case 'bots.list_tasks':
    case 'bots.list_task_chats':
    case 'bots.get_last_user_message':
    case 'bots.get_last_agent_response':
    case 'bots.read_history':
    case 'bots.create_task':
    case 'bots.create_task_chat':
    case 'bots.send_message':
      // Bot discovery and history reads are resolved by the main-process bot
      // service; they never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Bot actions run in the main process.',
        },
      };
    case 'delegation.tree':
    case 'delegation.transcript':
    case 'delegation.roots':
    case 'delegation.worktree_summary':
      // The App Advisor runtime answers these delegation reads in main; they
      // never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Delegation read actions run in the main process.',
        },
      };
    case 'code-graph.get_context':
    case 'code-graph.build':
    case 'code-graph.query':
    case 'code-graph.search':
    case 'code-graph.explain':
    case 'code-graph.impact':
    case 'code-graph.detect_changes':
    case 'code-graph.compare_changes':
    case 'code-graph.review':
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message:
            'Code Graph actions run in the main process with the requested worktree.',
        },
      };
    case 'tracked-plan.import':
      return importTrackedPlanResult(action);
    case 'tracked-plan.open_explore':
      return openTrackedPlanPanelResult(action);
    case 'worktree-chat.update_plugin_selection':
    case 'worktree-chat.set_plugin_selections':
    case 'standalone-chat.update_plugin_selection':
    case 'standalone-chat.set_plugin_selections':
    case 'pipeline-assistant-chat.update_plugin_selection':
    case 'pipeline-assistant-chat.set_plugin_selections':
    case 'worktree-chat.set_fast_mode':
    case 'worktree-chat.set_speed':
      // CAN-5999: the App Advisor runtime changes speed and plugin
      // selections in main; these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Chat speed and plugin changes run in the main process.',
        },
      };
    case 'agents.import_shared':
    case 'agents.delete_shared':
    case 'agents.publish_public_share':
    case 'agents.revoke_public_share':
    case 'plan.share':
    case 'plan.unshare':
    case 'runs.share':
    case 'runs.unshare':
      // CAN-6003: the App Advisor runtime shares in main; these never reach
      // the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Sharing actions run in the main process.',
        },
      };
    case 'agents.list':
    case 'agents.get':
    case 'agents.create':
    case 'agents.update':
    case 'agents.delete':
    case 'collections.list':
    case 'collections.create':
    case 'collections.update':
    case 'collections.delete':
    case 'plugins.list_marketplaces':
    case 'plugins.refresh_marketplace':
    case 'plugins.remove_marketplace':
    case 'skills.list_marketplace':
    case 'skill_suggestions.list':
    case 'preferences.get_global_plugin_selections':
    case 'preferences.set_global_plugin_selections':
      // CAN-6002: the App Advisor runtime runs catalog actions in main;
      // these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Catalog actions run in the main process.',
        },
      };
    case 'pipeline.execution_read_plan':
    case 'pipeline.execution_read_report':
    case 'pipeline.execution_start_over':
    case 'pipeline.execution_send_plan_to_chat':
    case 'pipeline.execution_send_report_to_chat':
      // CAN-6001: the App Advisor runtime reads, reruns, sends and debugs
      // pipeline executions in main; these never reach the renderer
      // dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Pipeline execution actions run in the main process.',
        },
      };
    case 'delegation.stop':
    case 'delegation.stop_all':
    case 'delegation.read_changes':
      // CAN-6000: the App Advisor runtime stops delegates and reads their
      // changes in main; these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Delegation stops and change reads run in the main process.',
        },
      };
    case 'worktree-chat.list_tabs':
    case 'worktree-chat.read_history':
    case 'worktree-chat.get_last_user_message':
    case 'worktree-chat.get_last_agent_response':
    case 'worktree-chat.list_plugins':
    case 'pipeline-assistant-chat.list_tabs':
    case 'pipeline-assistant-chat.read_history':
    case 'pipeline-assistant-chat.get_last_user_message':
    case 'pipeline-assistant-chat.get_last_agent_response':
    case 'pipeline-assistant-chat.list_plugins':
    case 'standalone-chat.list_projects':
    case 'standalone-chat.list_chats':
    case 'standalone-chat.get_settings':
    case 'standalone-chat.list_plugins':
    case 'standalone-chat.read_history':
    case 'standalone-chat.get_last_user_message':
    case 'standalone-chat.get_last_agent_response':
    case 'standalone-chat.list_prompts':
    case 'standalone-chat.get_prompt':
    case 'standalone-chat.list_notes':
    case 'standalone-chat.get_note':
    case 'standalone-chat.list_attachments':
    case 'standalone-chat.get_attachment':
      // CAN-5999: the App Advisor runtime runs these chat reads in main;
      // they never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Chat reads run in the main process.',
        },
      };
    case 'workspace.list':
    case 'workspace.get_settings':
    case 'workspace.get_start_page':
    case 'workspace.list_worktrees':
    case 'workspace.list_join_options':
    case 'workspace.list_existing_worktree_join_options':
    case 'workspace.read_readiness':
    case 'org_project.list':
    case 'sidebar.item_groups.list':
    case 'sidebar.item_groups.list_items':
    case 'sidebar.item_groups.create':
    case 'sidebar.item_groups.update':
    case 'sidebar.item_groups.set_item':
    case 'sidebar.item_groups.move_item':
    case 'sidebar.item_groups.move_group':
    case 'sidebar.item_groups.ungroup':
    case 'tracked-plan.list':
    case 'tracked-plan.get':
    case 'tracked-plan.list_comment_threads':
    case 'tracked-plan.get_comment_thread':
      // CAN-5998: the App Advisor runtime runs these in main from main's
      // own owners; they never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message:
            'Project, sidebar group and tracked plan actions run in the main process.',
        },
      };
    case 'worktree.create':
    case 'worktree.get_settings':
    case 'worktree.update_settings':
    case 'worktree.set_base_branch':
    case 'worktree.start_ci_check_fix':
    case 'worktree.start_merge_conflict_resolution':
    case 'worktree.start_pr_comment_triage':
      // CAN-5997 and CAN-6024: the App Advisor runtime runs these in main
      // with the requested worktree; they never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message:
            'Worktree actions run in the main process with the requested worktree.',
        },
      };
    case 'worktree.list_scripts':
    case 'worktree.run_script':
      // The App Advisor runtime dispatches script actions in main against the
      // requested worktree; they never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message:
            'Worktree script actions run in the main process with the requested worktree.',
        },
      };
    case 'workspace.find_repository_owner':
      // The App Advisor runtime answers this read-only lookup in main through
      // the Add project dialog's own owner lookup; it never reaches the
      // renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Repository owner lookups run in the main process.',
        },
      };
    case 'browser.list':
    case 'browser.open':
    case 'browser.navigate':
    case 'browser.back':
    case 'browser.forward':
    case 'browser.reload':
    case 'browser.stop':
    case 'browser.get_dialog':
    case 'browser.handle_dialog':
    case 'browser.click':
    case 'browser.fill':
    case 'browser.set_checked':
    case 'browser.select_option':
    case 'browser.type':
    case 'browser.press':
    case 'browser.hover':
    case 'browser.scroll':
    case 'browser.drag':
    case 'browser.focus':
    case 'browser.wait_for':
    case 'browser.screenshot':
    case 'browser.input_snapshot':
    case 'browser.inspect':
    case 'browser.get_console':
    case 'browser.get_network':
    case 'browser.list_transfers':
    case 'browser.cancel_transfer':
    case 'browser.start_recording':
    case 'browser.stop_recording':
    case 'browser.open_external':
      return runBrowserAction(action, originChatTabId, requestId, signal);
    case 'browser.upload_files':
    case 'browser.request_files':
    case 'browser.drop_files':
      return runBrowserAction(
        action,
        originChatTabId,
        requestId,
        signal,
        request.originChat,
      );
    case 'browser.save_download':
      return runSaveDownload(action, request.originChat);
    case 'browser.save_pdf':
      return runSavePdf(action);
    case 'archived.open_overview':
    case 'archived.open_empty_trash':
    case 'archived.open':
      return runArchivedAction(action);
    case 'archived.list':
    case 'archived.read_chat':
    case 'archived.restore':
    case 'archived.set_locked':
      // CAN-6007: the App Advisor runtime lists, reads, restores and locks
      // archives in main through core.archive.*; these never reach the
      // renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Archive actions run in the main process.',
        },
      };
    case 'skills.open_shared_viewer':
      useNavigationStore.getState().openSkillViewer({
        kind: 'shared',
        skillId: action.skillId,
      });
      return { ok: true, result: { skillId: action.skillId } };
    case 'automation.share':
    case 'automation.list_shared':
    case 'automation.read_shared':
    case 'automation.unshare':
      // CAN-6003 part B: the App Advisor runtime runs automation sharing in
      // main; these never reach the renderer dispatcher.
      return {
        ok: false,
        error: {
          code: 'unsupported_action',
          message: 'Automation sharing actions run in the main process.',
        },
      };
    case 'automation.open_editor':
      useNavigationStore.getState().openAutomationEdit({
        activityId: action.id,
        ...(action.section !== undefined ? { section: action.section } : {}),
        ...(action.runId !== undefined ? { runId: action.runId } : {}),
      });
      return { ok: true, result: { activityId: action.id } };
    case 'agents.open_editor':
      return openAgentEditorResult(action);
    case 'capabilities.open_entry': {
      const entryId = unifiedEntryIdForRef(action.entry);
      if (!entryId) {
        return {
          ok: false,
          error: {
            code: 'invalid_target',
            message: 'This capability has no Plugins entry to open.',
          },
        };
      }
      openPluginsEntryDetail(entryId);
      return { ok: true, result: { entryId } };
    }
    case 'automation.open_shared_pipeline_review':
      useNavigationStore
        .getState()
        .openAutomationSharedPipelineReview({ activityId: action.id });
      return { ok: true, result: { activityId: action.id } };
    default:
      // Exhaustiveness — see `assertNever` in `./types`.
      return assertNever(action);
  }
}

/**
 * Archived-container actions (Archive & Retention). Reads go through the
 * typed `window.api.archivedContainers` transport; open/restore reuse the
 * exact store/navigation flows of direct UI interaction
 * (`openArchivedContainerSurface` / `navigateToRestoredContainerDestination`),
 * and `archived.read_chat` applies the same bounded-transcript rules as the
 * live chat-history reads (default 20 messages, max 100).
 */
async function runArchivedAction(
  action: Extract<
    AppAdvisorAction,
    {
      type:
        | 'archived.open_overview'
        | 'archived.open_empty_trash'
        | 'archived.open';
    }
  >,
): Promise<{
  ok: boolean;
  result?: AppAdvisorJson;
  error?: AppAdvisorActionError;
}> {
  try {
    switch (action.type) {
      case 'archived.open_overview': {
        if (action.workspaceId === APP_ADVISOR_PROJECT_ID) {
          await window.api.appAdvisor.openWindow({
            focus: true,
            archivedOverview: {},
          });
          return {
            ok: true,
            result: { workspaceId: action.workspaceId, overviewOpen: true },
          };
        }
        openArchivedOverviewSurface(action.workspaceId);
        return {
          ok: true,
          result: { workspaceId: action.workspaceId, overviewOpen: true },
        };
      }
      case 'archived.open_empty_trash': {
        if (action.workspaceId === APP_ADVISOR_PROJECT_ID) {
          const containers = await window.api.archivedContainers.list({
            projectId: action.workspaceId,
          });
          const deletedCount = containers.filter(
            (entry) => entry.lockedAt === undefined,
          ).length;
          if (deletedCount === 0) {
            return {
              ok: false,
              error: {
                code: 'not_found',
                message: `Project ${action.workspaceId} has no Deleted items to remove.`,
              },
            };
          }
          const requestId = createClientId();
          let resolveOutcome: (opened: boolean | null) => void = () => {};
          const outcome = new Promise<boolean | null>((resolve) => {
            resolveOutcome = resolve;
          });
          const timeoutId = window.setTimeout(
            () => resolveOutcome(null),
            5_000,
          );
          const unsubscribe = window.api.appAdvisor.onWindowUiStateChanged(
            (state) => {
              if (state.lastArchivedOverviewRequestId === requestId) {
                resolveOutcome(
                  state.lastArchivedOverviewConfirmationOpened ?? false,
                );
              }
            },
          );
          let confirmationOpened: boolean | null;
          try {
            await window.api.appAdvisor.openWindow({
              focus: true,
              archivedOverview: {
                openEmptyTrashConfirmation: true,
                requestId,
              },
            });
            confirmationOpened = await outcome;
          } finally {
            window.clearTimeout(timeoutId);
            unsubscribe();
          }
          if (confirmationOpened !== true) {
            return {
              ok: false,
              error: {
                code: 'execution_failed',
                message:
                  confirmationOpened === false
                    ? 'Empty trash is already running.'
                    : `The ${ORCHESTRATOR_LABEL} window did not confirm that the Empty trash dialog opened.`,
                retryable: confirmationOpened === null,
              },
            };
          }
          return {
            ok: true,
            result: {
              workspaceId: action.workspaceId,
              confirmationOpened: true,
              deletedCount,
            },
          };
        }
        const store = useArchivedContainersStore.getState();
        if (store.emptyTrashRun !== null) {
          return {
            ok: false,
            error: {
              code: 'execution_failed',
              message: 'Empty trash is already running.',
              retryable: false,
            },
          };
        }
        await store.loadForWorkspace(action.workspaceId, {
          trailing: true,
          strict: true,
        });
        const deletedCount = (
          useArchivedContainersStore.getState().byWorkspace[
            action.workspaceId
          ] ?? []
        ).filter((entry) => entry.lockedAt === undefined).length;
        if (deletedCount === 0) {
          return {
            ok: false,
            error: {
              code: 'not_found',
              message: `Project ${action.workspaceId} has no Deleted items to remove.`,
            },
          };
        }
        openArchivedOverviewSurface(action.workspaceId);
        useArchivedContainersStore
          .getState()
          .requestEmptyTrashConfirmation(action.workspaceId);
        return {
          ok: true,
          result: {
            workspaceId: action.workspaceId,
            confirmationOpened: true,
            deletedCount,
          },
        };
      }
      case 'archived.open': {
        await useArchivedContainersStore
          .getState()
          .loadForWorkspace(action.workspaceId);
        const container = useArchivedContainersStore
          .getState()
          .byWorkspace[
            action.workspaceId
          ]?.find((entry) => entry.id === action.containerId);
        if (container === undefined) {
          return {
            ok: false,
            error: {
              code: 'not_found',
              message: `Archived container ${action.containerId} was not found in project ${action.workspaceId}.`,
            },
          };
        }
        openArchivedContainerSurface(action.workspaceId, action.containerId, {
          ...(action.tab !== undefined ? { tab: action.tab } : {}),
          ...(action.chatId !== undefined ? { chatId: action.chatId } : {}),
          ...(action.planId !== undefined ? { planId: action.planId } : {}),
        });
        return {
          ok: true,
          result: {
            workspaceId: action.workspaceId,
            containerId: action.containerId,
            kind: container.kind,
            tab: action.tab ?? 'chats',
            ...(action.chatId !== undefined ? { chatId: action.chatId } : {}),
            ...(action.planId !== undefined ? { planId: action.planId } : {}),
          },
        };
      }
      default:
        return assertNever(action);
    }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'execution_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
    };
  }
}

function deriveTitleFromPrompt(prompt: string): string {
  const firstLine = prompt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return 'Debug workflow';
  return firstLine.length > 40 ? `${firstLine.slice(0, 37)}...` : firstLine;
}
