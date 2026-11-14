/**
 * `@canopy/ui-app` holds the write-once feature components for the unified
 * Code-tab and home-screen UI, rendered by both the desktop renderer and the
 * web portal.
 *
 * Convention: components that use hooks/state are client components and carry a
 * top-of-file `'use client'` directive (a no-op on desktop, required by Next on
 * web). Browser-safe: depends only on `@canopy/app-core`, `@canopy/app-state`,
 * `@canopy/ui-shared`, `@canopy/ui-rich`, `@canopy/protocol`, and React — never
 * Electron, Node, Prisma, Next, or `window.api`.
 *
 * Ships the `CapabilityGate` primitive, the shared Code-tab `ChatPanel` (with
 * its presentational parts), and the shared `FileViewer`/`DiffViewer`.
 * Remaining feature panels (ActivityPanel, Overview, shell/sidebar) arrive in
 * later tickets.
 */
export * from './capability';
export { TurnFiles } from './code/TurnFiles';
export * from './code/subagents/LifetimeLimitNoticeContainer';
export {
  CHAT_VISUAL_TEST_IDS,
  ChatVisualHostProvider,
  useChatVisualHost,
  type ChatVisualHost,
  type ChatVisualOwner,
} from './code/chat-visual-host';
export {
  ChatVisualBlock,
  type ChatVisualBlockProps,
} from './code/ChatVisualBlock';
export {
  ChatVisualSourceButton,
  type ChatVisualSourceButtonProps,
} from './code/ChatVisualSourceButton';
export {
  ChatVisualDialog,
  type ChatVisualDialogProps,
} from './code/ChatVisualDialog';
export {
  ChatVisualsPanel,
  type ChatVisualsPanelProps,
} from './code/ChatVisualsPanel';
export {
  collectChatVisualOwners,
  publishChatVisuals,
  requestChatVisualReveal,
  useChatVisualsPublisher,
  type ChatVisualReveal,
  type ChatVisualsSource,
} from './code/chat-visuals-source';
export {
  CHAT_VISUALS_PANEL_KIND,
  CHAT_VISUALS_PANEL_TITLE,
  openChatVisualsPanel,
  rebindChatVisualsPanel,
  type OpenChatVisualsPanelRequest,
} from './code/panels/chat-visuals-panel-open';
export {
  ChatVisualDocumentCache,
  chatVisualDocumentCache,
  readVisualRanges,
  verifyVisualDocument,
  VISUAL_RANGE_LIMIT,
  VISUAL_CACHE_BYTE_BUDGET,
  type VisualRangeReader,
  type VisualRangeResponse,
} from './code/chat-visual-reader';
export * from './code/shell/sidebar/sidebar-item-groups-model';
export {
  McpWorkspaceDefaultsSection,
  type McpWorkspaceDefaultsChoice,
  type McpWorkspaceDefaultsSectionProps,
} from './capability/McpWorkspaceDefaultsSection';
export {
  PipelineReadDetail,
  type PipelineReadDetailProps,
} from './pipelines/PipelineReadDetail';
export {
  PipelineStepRow,
  type PipelineStepKind,
  type PipelineStepRowProps,
} from './pipelines/PipelineStepRow';
export {
  PipelineRunDefinitionUsed,
  type PipelineRunDefinitionUsedProps,
} from './pipelines/PipelineRunDefinitionUsed';
export {
  CLOUD_MODEL_DIALOG_TEST_IDS,
  CloudModelReplacementDialog,
  confirmedCloudModelChoices,
  type CloudModelReplacementDialogProps,
} from './pipelines/CloudModelReplacementDialog';
export {
  GitHubWorkflowRunRow,
  githubWorkflowJobDagStatus,
  githubWorkflowRunRowStatus,
  githubWorkflowRunRowTitle,
  type GitHubWorkflowRunRowData,
  type GitHubWorkflowRunRowJob,
  type GitHubWorkflowRunRowProps,
  type GitHubWorkflowRunRowState,
  type GitHubWorkflowRunRowStatus,
} from './code/activity/github/GitHubWorkflowRunRow';
export { githubWorkflowJobTiers } from './code/activity/github/github-workflow-job-tiers';
export {
  GITHUB_PLACEHOLDER_JOB_PREFIX,
  githubWorkflowDefinitionTiers,
  githubWorkflowGraphDepths,
  type GitHubWorkflowDefinitionTiers,
  type GitHubWorkflowRunRowGraph,
  type GitHubWorkflowRunRowGraphJob,
} from './code/activity/github/github-workflow-definition-tiers';
export {
  ChatPanel,
  type ChatPanelProps,
  type ChatPanelSendContext,
  type ChatComposerSendOptions,
  type ChatComposerHostControls,
  type ChatTranscriptHostControls,
} from './code/ChatPanel';
export {
  ChatTranscript,
  type ChatTranscriptProps,
  type ChatTranscriptWorktreeSetup,
} from './code/ChatTranscript';
export { ChatComposer, type ChatComposerProps } from './code/ChatComposer';
export {
  QueuedMessageStack,
  QUEUED_MESSAGE_REORDER_ERROR,
  type QueuedMessageStackProps,
} from './code/QueuedMessageStack';
export {
  ComposerWorkDrawer,
  type ComposerWorkDrawerBackground,
  type ComposerWorkDrawerSections,
  type ComposerWorkDrawerProps,
} from './code/ComposerWorkDrawer';
export {
  ChatMessageView,
  type ChatMessageViewProps,
} from './code/ChatMessageView';
export {
  ChatMessageAuthorProvider,
  type ChatMessageAuthor,
  type ChatMessageAuthorResolver,
} from './code/ChatMessageAuthorContext';
export {
  CHAT_PART_REPLAY_POLICY,
  ChatPartView,
  ToolNamespaceContext,
  type ChatPartViewProps,
  AskUserQuestionInteractionProvider,
  DeliverableInteractionProvider,
  ManagedDelegationLiveContext,
  ModelAccessRecoveryInteractionProvider,
  TurnWorkingStatusProvider,
  useAskUserQuestionInteraction,
  useModelAccessRecoveryInteraction,
  useTurnWorkingStatus,
  type AskUserQuestionInteraction,
  type ModelAccessRecoveryInteraction,
  type AskUserQuestionRequestStatus,
  type DeliverableInteraction,
  type DeliverableRef,
  type ManagedDelegationLiveState,
} from './code/ChatPartView';
export {
  DeferredToolOutput,
  transcriptFieldUnavailable,
  ToolOutputReaderContext,
  type ToolOutputPage,
  type ToolOutputReader,
  type ToolOutputIdentity,
} from './code/DeferredToolOutput';
export {
  TranscriptReadHostContext,
  type TranscriptReadHost,
} from './code/transcript-read-host-context';
export {
  DelegationChildPages,
  isStreamBackedDelegation,
  type DelegationChildPagesProps,
} from './code/DelegationChildPages';
export {
  overlayManagedDelegationProgress,
  overlayManagedDelegationSnapshot,
  type ManagedDelegationProgress,
  type ManagedDelegationProgressOverlay,
} from './code/managed-delegation-progress';
export {
  ManagedDelegationCard,
  type ManagedDelegationCardProps,
} from './code/ManagedDelegationCard';
export {
  DelegationChildRowNotice,
  repeatsCardResult,
  type DelegationChildRowDisplay,
  type DelegationChildRowEntry,
} from './code/delegation-child-rows';
export {
  ChatToolResultPart,
  readChatToolResultVisual,
  type ChatToolResultPartProps,
} from './code/ChatToolResultPart';
export {
  TranscriptFileLinkInteractionProvider,
  TRANSCRIPT_FILE_LINK_MARKDOWN_OPTIONS,
  useTranscriptProseOptions,
  type FileLinkLineLocation,
  type TranscriptFileLinkInteraction,
} from './code/TranscriptFileLinks';
export {
  TurnGroupView,
  isFirstTurnHeldForSetup,
  type TurnGroupViewProps,
} from './code/TurnGroupView';
export {
  usePinnedPlanCopy,
  type PinnedPlanTarget,
} from './code/activity/plans/usePinnedPlanCopy';
export {
  FileViewer,
  type FileViewerProps,
  type FileEditorSlot,
  type FileLineReveal,
  type FileContentScrollBinding,
  type FileDocumentBytesResult,
  type FileDocumentRenderFailure,
  type FileRichDocumentSlot,
} from './code/file/FileViewer';
export {
  FileReadOnlyCode,
  type FileReadOnlyCodeProps,
} from './code/file/FileReadOnlyCode';
export { DiffViewer, type DiffViewerProps } from './code/file/DiffViewer';
export {
  FindableFileViewer,
  type FindableFileViewerProps,
} from './find/FindableFileViewer';
export {
  FileMarkdownPreview,
  type FileMarkdownPreviewProps,
} from './code/file/FileMarkdownPreview';
export {
  FileHtmlPreview,
  buildSandboxedHtmlSrcDoc,
  type FileHtmlPreviewProps,
} from './code/file/FileHtmlPreview';
export {
  FrontmatterBlock,
  type FrontmatterBlockProps,
} from './code/file/FrontmatterBlock';
export {
  MarkdownFrontmatterContent,
  type MarkdownFrontmatterContentProps,
  type FrontmatterValue,
} from './code/file/MarkdownFrontmatterContent';
export { parseFrontmatterAndBody } from './code/file/frontmatter';
export {
  UnifiedDiffView,
  type UnifiedDiffViewProps,
} from './code/file/UnifiedDiffView';
export {
  resolveFileRenderKind,
  defaultFileViewMode,
  fileExtension,
  fileRenderKindForMediaType,
  isRichDocumentRenderKind,
  type FileRenderKind,
  type RichDocumentRenderKind,
} from './code/file/file-kind';
export { toDiffFileStatus } from './code/file/diff-status';
export {
  ActivityPanel,
  ACTIVITY_POINTER_DRAG_ACTIVATION_CONSTRAINT,
  type ActivityPanelProps,
  type ActivityPanelHostActions,
  type ScriptsSectionHostModel,
  type HooksSectionHostModel,
  type ChangedFilesSectionHostModel,
  type ActivityPanelSectionOverride,
  type ActivityPanelExtraSection,
  ActivitySectionBody,
  getActivitySectionDescriptor,
  type ActivitySectionBodyProps,
  type ActivitySectionMenuDescriptor,
  type ActivitySectionPresenceInput,
  // `activitySectionPresenceIds` / `activitySectionRenders` /
  // `activitySectionHasContent` are deliberately NOT re-exported here. They are
  // the per-section internals of the panel-level predicate below, used by this
  // package's own tests through the module directly; hosts ask the rail-level
  // question, and a barrel export with no caller is just public API to keep
  // compatible.
  activityPanelHasContent,
} from './code/activity/ActivityPanel';
export {
  changedFilesHeaderHasContent,
  changedFilesHeaderSubtitle,
  type ChangedFilesHeaderInput,
} from './code/activity/changed-files-header';
export {
  SortableSection,
  type SortableSectionProps,
} from './code/activity/SortableSection';
export { FilesTab, type FilesTabProps } from './code/activity/FilesTab';
export {
  SummarySectionBody,
  type SummarySectionBodyProps,
  type SummarySectionBodyRepo,
  type SummarySectionBodySummary,
} from './code/activity/SummarySectionBody';
export {
  TodoSectionBody,
  type TodoSectionBodyItem,
  type TodoSectionBodyProps,
} from './code/activity/TodoSectionBody';
export { BackgroundTasksList } from './code/activity/BackgroundTasksList';
export {
  backgroundTasksHeaderChrome,
  type BackgroundTaskDetail,
  type BackgroundTaskHostActions,
  type BackgroundTasksSectionHostModel,
  type BackgroundWorkflowAgentProgress,
  type BackgroundWorkflowProgress,
} from './code/activity/background-tasks-section';
export {
  TaskStopAction,
  TASK_STOP_FAILED_LABEL,
  type TaskStopActionProps,
} from './code/activity/TaskStopAction';
export {
  AgentCardHeaderActionContext,
  agentPartTaskStoppable,
  type AgentCardTaskStopHost,
} from './code/agent-card-task-stop';
export {
  BackgroundTray,
  backgroundTrayCounts,
  type BackgroundTrayCounts,
  type BackgroundTrayProps,
  type BackgroundTrayWatcher,
  type DeleteBackgroundTrayWatcher,
} from './code/activity/background-tray/BackgroundTray';
export {
  githubBackgroundTrayRun,
  githubPullRequestBackgroundTrayRun,
  isFinishedTrayRun,
  pipelineBackgroundTrayRun,
  pipelineTrayRunStatus,
  type BackgroundTrayRun,
  type BackgroundTrayRunDag,
  type BackgroundTrayRunKind,
  type BackgroundTrayRunStatus,
  type GitHubPullRequestRowData,
} from './code/activity/background-tray/RunRow';
export {
  AGENT_STEP_LIMIT,
  delegateAgentMeta,
  delegateAgentStatus,
  type BackgroundTrayAgent,
  type BackgroundTrayAgentKind,
  type BackgroundTrayAgentStep,
} from './code/activity/background-tray/AgentRow';
export {
  portalBackgroundProcessToTask,
  portalBackgroundTrayAgents,
  portalBackgroundTrayRuns,
  portalBackgroundTrayWatchers,
} from './code/activity/portal-background-tray-mapper';
export {
  McpServersSectionBody,
  type McpServersSectionBodyProps,
  type McpServersSectionItem,
} from './code/activity/McpServersSectionBody';
export {
  ScriptsSectionBody,
  type ScriptsSectionBodyProps,
  type ScriptsSectionEntry,
  type ScriptsSectionLifecycle,
  type ScriptsSectionOrphanGroup,
  type ScriptsSectionOrphanGroupMember,
  type ScriptsSectionOrphanGroupStop,
  type ScriptsSectionOrphanStopOutcome,
  type ScriptsSectionRun,
  type ScriptsSectionRunOrphan,
  type ScriptsSectionRunStatus,
  type ScriptsSectionScript,
  type ScriptsSectionTarget,
  type ScriptsSectionWorkspaceLifecycleGroup,
} from './code/activity/scripts/ScriptsSectionBody';
export {
  RunOutputModal,
  describeRunOutcome,
  type RunOutcome,
  type RunOutputModalProps,
  type RunOutputStatus,
} from './code/activity/scripts/RunOutputModal';
export {
  ScriptOutputModal,
  type ScriptOutputModalProps,
} from './code/activity/scripts/ScriptOutputModal';
export {
  HooksSectionBody,
  type HooksSectionAction,
  type HooksSectionActionType,
  type HooksSectionBodyProps,
  type HooksSectionEntry,
  type HooksSectionHook,
  type HooksSectionRun,
  type HooksSectionRunStatus,
  type HooksSectionTarget,
  type HooksSectionUnconfiguredWatcher,
} from './code/activity/hooks/HooksSectionBody';
export {
  FailedPendingExecutionCard,
  FailedQueuedHookPipelineCard,
  HookTriggerIndicator,
  PendingExecutionCard,
  QueuedHookPipelineCard,
  type FailedPendingExecutionCardEntry,
  type FailedPendingExecutionCardProps,
  type FailedQueuedHookPipelineCardProps,
  type FailedQueuedPipelineCardEntry,
  type PendingExecutionCardEntry,
  type PendingExecutionCardProps,
  type PipelineHookTriggerSource,
  type QueuedHookPipelineCardProps,
  type QueuedPipelineCardEntry,
} from './code/activity/pipeline/PipelineQueuedCards';
// Only the tree row (which composes the Active/Completed rows internally)
// is public API today; the portal-adoption brick widens this deliberately
// when it consumes more.
export {
  FollowUpButton,
  isPipelineExecutionActiveStatus,
  pipelineRunStatusBadge,
  PipelineRunTreeRow,
  type ActiveRunRowProps,
  type CompletedRunRowProps,
  type PipelineRunBreadcrumbEntry,
  type PipelineRunExecutionState,
  type PipelineRunJobDefinition,
  type PipelineRunJobGroup,
  type PipelineRunJobResult,
  type PipelineRunPauseResponse,
  type PipelineRunRenderSlot,
  type PipelineRunStatus,
  type PipelineRunSummary,
  type PipelineRunTreeRowProps,
} from './code/activity/pipeline/PipelineRunRows';
export {
  PipelineRunsSectionBody,
  type PipelineRunsSectionBodyProps,
} from './code/activity/pipeline/PipelineRunsSectionBody';
// The shared run DETAIL surface (CAN-3020). The web portal hosts it inside a
// full-viewport `DialogModal`; desktop adopts it at CAN-1965.
export {
  PipelineRunDetail,
  type PipelineRunDetailLog,
  type PipelineRunDetailProps,
  type PipelineRunDetailStepSelection,
} from './code/activity/pipeline/PipelineRunDetail';
export {
  buildPipelineRunDetailJobs,
  flattenPipelineRunDetailSteps,
  pipelineRunDetailStatusClassName,
  pipelineRunStepKey,
  type PipelineRunDetailJob,
  type PipelineRunDetailJobGroup,
  type PipelineRunDetailPauseCheckpoint,
  type PipelineRunDetailPauseField,
  type PipelineRunDetailStep,
  type PipelineRunDetailStepEntry,
  type PipelineRunDetailVariant,
  type PipelineRunDetailVariantGroup,
  type PipelineRunDetailView,
} from './code/activity/pipeline/PipelineRunDetailModel';
export {
  PipelineRunPauseForm,
  type PipelineRunPauseFormProps,
} from './code/activity/pipeline/PipelineRunPauseForm';
export { pipelinePauseInputHeading } from './code/activity/pipeline/pipeline-pause-input-heading';
export {
  PipelineRunStepTree,
  type PipelineRunStepTreeProps,
  type PipelineRunStepTreeSelection,
} from './code/activity/pipeline/PipelineRunStepTree';
export {
  ChangedFilesSection,
  type ChangedFileRow,
  type ChangedFilesSectionProps,
} from './code/activity/sections/ChangedFilesSection';
export {
  PullRequestSection,
  type PullRequestSectionProps,
} from './code/activity/sections/PullRequestSection';
export {
  PullRequestSectionBody,
  PullRequestRepoDetail,
  type PullRequestSectionBodyProps,
  type PullRequestSectionRepo,
  type PullRequestSectionPrStatus,
  type PullRequestSectionPrState,
  type PullRequestSectionCheckStatus,
  type PullRequestSectionCheckDetail,
  type PullRequestSectionReviewStatus,
  type PullRequestSectionLabel,
  type PullRequestSectionCreationStep,
  type PullRequestSectionCreationProgress,
} from './code/activity/PullRequestSectionBody';
export {
  ItemListSection,
  type ItemListSectionProps,
  type ActivityListItem,
} from './code/activity/sections/ItemListSection';
export {
  CodeShell,
  type CodeShellProps,
  type CodeShellRegions,
  type CodeShellTestId,
  type CodeShellTestIds,
} from './code/shell/CodeShell';
export {
  WorktreeSidebar,
  type WorktreeSidebarProps,
} from './code/shell/WorktreeSidebar';
export {
  WorkspacesSidebarSections,
  type WorkspacesSidebarSectionsProps,
  type SidebarAdditionalProject,
  type WorkspacesSidebarSectionsTestIds,
  type WorkspacesSidebarSelection,
  type WorkspaceSectionSlotContext,
  type CoworkWorkspaceSlotContext,
  type ArchivedWorktreeEntry,
  type WorktreeRowSlotContext,
  type WorkspaceDndWrapperContext,
  type WorktreeDndWrapperContext,
  type WorkspaceDialogTriggerContext,
  type WorktreeDialogTriggerContext,
  type WorktreePopoverSlotContext,
  type WorkspaceBranchGrouping,
  type UseWorktreeRowOverrides,
  type WorktreeRowOverrideKey,
  type WorktreeRowOverrides,
  pickWorktreeRowOverrides,
} from './code/shell/WorkspacesSidebarSections';
export {
  PendingProjectRow,
  PendingProjectRows,
  type SidebarPendingProject,
} from './code/shell/PendingProjectRow';
export { useProjectListPagination } from './code/shell/sidebar/useProjectListPagination';
export {
  CHATS_SECTION_VISIBLE_ENTRIES,
  SidebarSurface,
  type SidebarSurfaceProps,
  type SidebarSurfaceSnapshot,
  type SidebarSurfaceTestIds,
  type SidebarSelection,
  type SidebarPipelineEntry,
  type SidebarChatSearchHost,
  type SidebarNavItemAction,
} from './code/shell/SidebarSurface';
export {
  SidebarChatsSkeleton,
  SidebarProjectsSkeleton,
  SidebarRailSkeleton,
} from './code/shell/SidebarProjectsSkeleton';
export {
  isSidebarActivityAvailable,
  prepareSidebarActivityLoader,
  withSidebarActivitySpaceMute,
  type SidebarActivityHost,
  type SidebarActivityHostInventory,
} from './code/shell/sidebar-activity-host';
export {
  SidebarActivityModeToggle,
  type SidebarActivityModeToggleProps,
} from './code/shell/SidebarActivityModeToggle';
export {
  SidebarActivityModeSwitch,
  SidebarActivityModeView,
  useSidebarActivityGate,
  type SidebarActivityModeSwitchProps,
  type SidebarActivityModeViewProps,
} from './code/shell/SidebarActivityModeView';
export {
  SidebarGuestProjectsCard,
  type SidebarGuestProjectsCardProps,
} from './code/shell/SidebarGuestProjectsCard';
export {
  SidebarAccountFooter,
  SidebarAccountRow,
  type SidebarAccountAttention,
  type SidebarAccountFooterProps,
  type SidebarAccountIdentity,
  type SidebarAccountIdentityTone,
  type SidebarAccountRowProps,
} from './code/shell/SidebarAccountFooter';
export {
  getSidebarNavItemDefs,
  type SidebarNavItemDef,
  type SidebarNavItemKey,
} from './code/shell/sidebar-nav-items';
export {
  buildSidebarChatSearchCandidates,
  filterSidebarChatSearchResults,
  type SidebarChatSearchInventory,
  type SidebarChatSearchResult,
  type SidebarChatSearchWorktreeChat,
} from './code/shell/sidebar-chat-search-model';
export {
  CreateWorkspaceDialog,
  type CreateWorkspaceDialogProps,
  type CreateWorkspaceDialogTestIds,
} from './code/shell/CreateWorkspaceDialog';
export {
  publishSidebarMoreWorkspaces,
  registerSidebarHiddenWorktreeHandler,
  requestSidebarHiddenWorktreeAction,
  useSidebarHiddenWorktreeRemovalAvailable,
  useSidebarHiddenWorktrees,
  useSidebarMoreWorkspace,
  type SidebarHiddenWorktreeAbilities,
  type SidebarHiddenWorktreeEntry,
  type SidebarHiddenWorktreeRequest,
  type SidebarMoreWorkspace,
} from './code/shell/sidebar-more-bridge';
export {
  archivedMoreWorktreeItem,
  formatMoreWorktreeDate,
  formatRestoreNote,
  useHiddenMoreWorktreeItems,
  type ArchivedMoreWorktreeItemInput,
  type MoreHiddenWorktreeOptions,
} from './code/shell/more-worktree-items';
export {
  firstVisibleWorkspaceId,
  visibleWorkspaceCount,
  workspaceColor,
} from './code/shell/sidebar-model';
export {
  isWorktreeDone,
  snapshotWorkspaceMatchesContext,
  type WorkspaceSectionsSnapshot,
} from './code/shell/workspace-sections-model';
// Shared worktree top bar (CAN-1485): the component value plus its locked
// public types. The transport slice locked the type surface; the frontend
// slice authored the component body and exports it here for the portal mount.
export {
  WorktreeTopBar,
  type WorktreeTopBarPinnedAction,
  type WorktreeTopBarProps,
  type WorktreeTopBarScriptHostActions,
} from './code/shell/WorktreeTopBar';
export {
  SHARED_WITH_YOU_SECTION_LABEL,
  SidebarList,
  SidebarRowFrame,
  SidebarSection,
  type SidebarDensity,
  type SidebarListProps,
  type SidebarRowFrameProps,
  type SidebarRowFrameVariant,
  type SidebarSectionProps,
} from './code/shell/sidebar';
// Bulk selection and removal of sidebar rows (CAN-3975).
export {
  batchActionAvailability,
  worktreeRemovalBlockedReason,
  type SidebarBatchActionAvailability,
  type SidebarBatchAvailabilityRow,
  type WorktreeBatchActionAvailability,
  type WorktreeBatchAvailabilityRow,
  type WorktreeRemovalBlockInputs,
} from './code/shell/worktree-menu-items';
export {
  bulkStateActions,
  deriveSelectionMenuItems,
  rowNeedsStateAction,
  withSelectionGroupItems,
  type SidebarBulkNotificationState,
  type SidebarBulkRowState,
  type SidebarBulkStateAction,
  type SidebarBulkStateActions,
  type SidebarSelectionMenuTestIds,
} from './code/shell/sidebar-selection-menu-items';
export {
  isWorktreeSelectable,
  useSidebarBatchRemoval,
  useSidebarBulk,
  useSidebarRowSelection,
  useSidebarSelectionRows,
  SidebarSelectionRowsReporter,
  useSidebarWorkEntryBulk,
  workEntryRowKey,
  workEntryRowMultiSelectProps,
  type GetWorkEntryBatchRemovalFacts,
  type GetWorkEntryBulkState,
  type GetWorktreeBatchRemovalFacts,
  type RemoveWorkEntryInBatch,
  type WorkEntryBatchRemovalFacts,
  type WorkEntryBatchTarget,
  type WorkEntryMultiSelectBinding,
  type RemoveRowInBatch,
  type RemoveWorktreeInBatch,
  type SidebarBatchRemovalMode,
  type SidebarBatchRemovalOptions,
  type SidebarBatchRemovalUiState,
  type SidebarBatchTarget,
  type SidebarBulk,
  type SidebarBulkBinding,
  type SidebarBulkTarget,
  type SidebarRowKind,
  type SidebarRowMultiSelect,
  type SidebarRowSelection,
  type SidebarSelectionRow,
  type SidebarSelectionRows,
  type WorktreeBatchItem,
  type WorktreeBatchLocalWork,
  type WorktreeBatchRemovalFacts,
  type WorktreeBatchRemovalMode,
  type WorktreeBatchRemovalOptions,
  type WorktreeBatchRemovalUiState,
} from './code/shell/sidebar';
export {
  deriveWorktreeMenuItems,
  foldWorktreeMenuIntoMore,
  WORKTREE_GROUPING_GLYPHS,
  type WorktreeGroupingActionKind,
  type WorktreeMenuCallbacks,
} from './code/shell/worktree-menu-items';
export {
  getWorktreeBranchChoiceHint,
  getWorktreeDeleteLabels,
  type WorktreeDeleteLabels,
  type WorktreeRemovalMode,
} from './code/shell/worktree-removal-labels';
export {
  ARCHIVE_TOOLTIP,
  deleteRetentionTooltip,
  getWorkEntryBatchCopy,
  getWorkEntryRemovalLabels,
  WORK_ENTRY_BATCH_UNIT,
  type WorkEntryRemovalLabels,
  type WorkEntryRemovalMode,
} from './code/shell/work-entry-removal-labels';
export {
  deriveWorktreeUiStatus,
  isTreeLayout,
  orderedWorkspaces,
  workspaceLayout,
  worktreesForWorkspace,
  type WorktreeUiStatus,
  type SnapshotWorkspace,
  type SnapshotWorktree,
  type SidebarWorkspace,
  type WorkspaceVisibilitySnapshot,
} from './code/shell/worktree-status';
export {
  Overview,
  OverviewSectionHeader,
  type OverviewProps,
  type OverviewSectionHeaderProps,
} from './home/Overview';
export { OverviewCard, type OverviewCardProps } from './home/OverviewCard';
export {
  ContinueSection,
  useContinueAttentionPaging,
  type ContinueAttentionPaging,
  buildContinueSectionModel,
  continueAttentionTargetKey,
  countContinueAttentionByKind,
  rankContinueAttention,
  resolveLastViewedNames,
  sameContinueAttentionItems,
  type ContinueAttentionItem,
  type ContinueAttentionKind,
  type ContinueAttentionTarget,
  type ContinueInterruptedSession,
  type ContinueInterruptedTarget,
  type ContinueLastViewed,
  type ContinueSectionInterrupted,
  type ContinueSectionProps,
} from './home/continue';
export {
  PanelGridSurface,
  type PanelAddTabMenuRenderProps,
  type PanelGridSurfaceProps,
  type PanelGridSurfaceServices,
} from './code/panels/PanelGridSurface';
export {
  splitDirectionToDropEdge,
  splitGroupMovingActiveTab,
} from './code/panels/split-active-tab';
export {
  getPanelCommand,
  isPanelCommandAvailable,
  matchesPanelShortcutBinding,
  PANEL_COMMANDS,
  PANEL_SHORTCUT_BINDINGS,
  runPanelCommand,
  type PanelCommand,
  type PanelCommandId,
  type PanelShortcutBinding,
} from './code/panels/panel-commands';
export {
  findPanelByInstanceKey,
  getAuxPanelLayoutOwnerKey,
  getPanelGridController,
  getPanelInstanceKey,
  getPanelLayoutViewModel,
  isAuxPanelLayoutKey,
  isSingletonPanelKind,
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  setPanelLeafDocumentResolver,
  usePanelGridController,
  usePanelLayoutStore,
  usePanelLayoutViewModel,
  type AdoptLayoutTabsOptions,
  type DefaultLayoutDescriptor,
  type DefaultLayoutGroupSeed,
  type PanelGridController,
  type PanelGroupState,
  type PanelInstanceLocation,
  type PanelLeafDocumentResolver,
  type PanelLayoutState,
  type PanelTabDescriptor,
  type SplitGroupSeed,
  type WorktreePanelLayout,
} from './code/panels/panel-layout-store';
export * from './code/shell/SidebarPlanSubtitle';
export { FeedbackSubmissionHeldError } from './feedback/feedback-submission-held-error';
// Keep the base form on its on-demand subpath, outside the startup barrel.
export type {
  FeedbackDialogProps,
  FeedbackDialogReportType,
  FeedbackDialogSubmission,
} from './feedback/FeedbackDialog';
export * from './feedback/AppErrorBoundary';
export * from './feedback/FeedbackReportDialogEntry';
export * from './feedback/ReportThisAction';

export {
  ChatMessageMedia,
  useChatMessageAttachmentSplit,
  type ChatMessageAttachmentSplit,
  type ChatMessageMediaItem,
  ChatAssetImage,
  type ChatAssetImageReference,
  type ChatAssetImageSource,
  ChatMessageAttachmentInteractionProvider,
  useChatMessageAttachmentInteraction,
  type ChatMessageAttachmentInteraction,
} from './code/ChatMessageAttachments';
export {
  SidebarContextRow,
  SidebarContextGlyph,
  SidebarContextMenuItems,
  buildOrganizationOptions,
  type SidebarContextMenuItemsProps,
  type SidebarContextOrgScopedActions,
  type SidebarContextRowProps,
} from './code/shell/SidebarContextRow';
export {
  usePendingOrganizationInvitations,
  ACCEPTED_FOLLOW_UP_FALLBACK_COPY,
  INVITATION_UNAVAILABLE_COPY,
  type AcceptedInvitationFollowUp,
  type PendingInvitationError,
  type PendingInvitationResponse,
  type PendingOrganizationInvitationsOptions,
  type SidebarContextInvitations,
} from './code/shell/usePendingOrganizationInvitations';
export { resolveJoinedOrganization } from './settings/organization/resolve-joined-organization';
export {
  resolveSidebarContextActions,
  sidebarContextSwitcherAvailable,
  type SidebarContextActions,
} from './code/shell/sidebar-context-actions';
export {
  SidebarAccountMenuHeader,
  type SidebarAccountMenuHeaderProps,
} from './code/shell/SidebarAccountMenuHeader';
export {
  SidebarCreateOrganizationMenuItem,
  SidebarFeedMenuItem,
  SidebarInviteTeamMenuItem,
  SidebarStatisticsMenuItem,
  invitableOrganization,
  organizationCreatePath,
  organizationSettingsPath,
} from './code/shell/AccountMenuActivityItem';
export {
  CONTEXT_CARRYOVER_LINGER_MS,
  activitySourceOf,
  contextActivityItemsFromSnapshot,
  contextCarryoverDeadline,
  contextCarryoverProjection,
  contextKeysWithUpdates,
  contextUpdateKey,
  isForeignActivityUpdate,
  observeContextCarryover,
  startContextCarryover,
  type ContextActivityItem,
  type ContextActivitySnapshot,
  type ContextActivitySource,
  type ContextCarryoverState,
} from './code/shell/context-updates';

export type {
  FilesTabMutations,
  FilesTabSearch,
} from './code/activity/FilesTab';
export { FilesTabActionMenu } from './code/activity/FilesTabActionMenu';
export type {
  FilesTabMenuAction,
  FilesTabActionTarget,
  FilesTabActionMenuProps,
} from './code/activity/FilesTabActionMenu';
export {
  DEFAULT_FILE_TREE_MENU_LABELS,
  FileTreeContextMenu,
  deriveFileTreeMenuItems,
} from './code/activity/FileTreeContextMenu';
export type {
  FileTreeContextMenuProps,
  FileTreeMenuKey,
  FileTreeMenuLabels,
  FileTreeMenuOptions,
  FileTreeMenuTargetKind,
} from './code/activity/FileTreeContextMenu';
export * from './code/activity/files-tab-search';
export * from './code/activity/files-tab-inline-editor';

export {
  buildComposerOverflowMenuItems,
  defaultChatPlaceholder,
  getSlashCommandInsertText,
  resolveComposerThinking,
  resolveModelOptionProviderType,
  resolvePortalExecutionHarness,
  resolveUsageIndicatorIsCodex,
  toUsageIndicatorUsage,
  type ComposerOverflowMenuArgs,
} from './code/composer/composer-helpers';
export {
  usePlanModeSuggestion,
  type PlanModeSuggestion,
  type UsePlanModeSuggestionOptions,
} from './code/composer/usePlanModeSuggestion';
export {
  cloneComposerDraft,
  composerDraftContentEquals,
  createComposerDraftHolder,
  EMPTY_COMPOSER_DRAFT,
  useComposerDraftHolder,
  useComposerDraftRestoration,
  type ComposerDraftHolder,
  type ComposerDraftRestorationOptions,
  type ComposerDraftSnapshot,
} from './code/composer/composer-draft';
export {
  ComposerMenu,
  type ComposerMenuCommand,
  type ComposerMenuCommandOutcome,
  type ComposerMenuItem,
  type ComposerMenuLinear,
  type ComposerMenuPick,
  type ComposerMenuPlugin,
  type ComposerMenuProps,
} from './code/composer/ComposerMenu';
export {
  ComposerEditorMenu,
  type ComposerEditorMenuProps,
} from './code/composer/ComposerEditorMenu';
export { DirectoryPickerHeading } from './code/composer/DirectoryPickerHeading';
export {
  BaseBranchPicker,
  baseBranchRef,
  baseBranchTargetKey,
  type BaseBranchPickerBranchState,
  type BaseBranchPickerProps,
  type BaseBranchPickerPullRequest,
  type BaseBranchPickerPullRequests,
  type BaseBranchPickerWorktree,
  type BaseBranchTarget,
} from './code/composer/BaseBranchPicker';
export {
  useWorktreeBaseBranches,
  type WorktreeBaseBranches,
} from './code/composer/useWorktreeBaseBranches';
export {
  PortalDirectoryPicker,
  type DirectoryPickerOption,
} from './code/composer/PortalDirectoryPicker';
export {
  PortalModelPicker,
  type PortalModelPickerProps,
} from './code/composer/PortalModelPicker';
export {
  PendingAttachmentRow,
  type PendingAttachmentChip,
} from './code/composer/pending-attachment-row';
export {
  countPortalPluginSelections,
  PORTAL_PLUGINS_MCP_NEEDS_RECONNECTING_LABEL,
  PORTAL_PLUGINS_MCP_NOT_SIGNED_IN_LABEL,
  PORTAL_PLUGINS_PROJECT_DEFAULT_LABEL,
  PortalPluginsPicker,
  type AccountMcpEntryComponentProps,
  type AccountMcpSeam,
  type AddMarketplaceConfirmation,
  type AddMarketplaceDialogComponent,
  type AddMarketplaceSeam,
  type PortalPluginsLocalItem,
  type PortalPluginsLocalItemsSeam,
  type PortalPluginsPickerProps,
} from './code/composer/PortalPluginsPicker';
export {
  MoveProjectToOrganizationDialog,
  moveProjectToOrganizationErrorMessage,
  type MoveProjectToOrganizationDialogProps,
  type MoveProjectToOrganizationError,
  type MoveProjectToOrganizationOption,
} from './org-projects/MoveProjectToOrganizationDialog';
export {
  LinkCloudProjectDialog,
  linkCloudProjectErrorMessage,
  linkCloudProjectUnavailableMessage,
  type LinkCloudProjectCandidate,
  type LinkCloudProjectDialogProps,
  type LinkCloudProjectErrorCode,
  type LinkCloudProjectState,
  type LinkCloudProjectTarget,
  type LinkCloudProjectUnavailableReason,
} from './cloud-projects/LinkCloudProjectDialog';
export {
  CloudProjectSetupPanel,
  cloudProjectSetupErrorMessage,
  cloudProjectSetupUnavailableMessage,
  type CloudProjectSetupErrorCode,
  type CloudProjectSetupListEntry,
  type CloudProjectSetupPanelProps,
  type CloudProjectSetupPanelState,
  type CloudProjectSetupProgressLine,
  type CloudProjectSetupRepository,
  type CloudProjectSetupUnavailableReason,
} from './cloud-projects/CloudProjectSetupPanel';
export {
  OrgRepositoryOwnerNotice,
  orgRepositoryOwnerNoticeCopy,
  orgRepositoryOwnerSwitchFailure,
  type OrgRepositoryOwnerNoticeCopy,
  type OrgRepositoryOwnerNoticeCopyInput,
  type OrgRepositoryOwnerNoticeProps,
} from './org-projects/OrgRepositoryOwnerNotice';
export {
  OrgContextEmptyState,
  type OrgContextEmptyStatePlanMissing,
  type OrgContextEmptyStateProps,
} from './org-projects/OrgContextEmptyState';
export {
  DraftComposerEditor,
  type DraftComposerEditorProps,
} from './code/composer/DraftComposerEditor';
export {
  LinearReferencePreview,
  useLinearTeamCatalog,
  type LinearReferencePreviewProps,
} from './code/LinearReferencePreview';
export {
  GitHubReferencePreview,
  useGitHubOriginRepository,
  useGitHubPreviewConnected,
  type GitHubReferencePreviewProps,
} from './code/GitHubReferencePreview';
export {
  PlanModeHintProvider,
  usePlanModeHintStore,
} from './code/composer/PlanModeHintContext';
export { useComposerHintActivity } from './code/composer/useComposerHintActivity';
export {
  PlanModeHint,
  type PlanModeHintProps,
} from './code/composer/PlanModeHint';
export {
  GitHubStarPromptProvider,
  useGitHubStarPromptStore,
} from './code/composer/GitHubStarPromptContext';
export {
  GITHUB_STAR_PROMPT_DONE_MS,
  useGitHubStarPrompt,
  type GitHubStarPromptOffer,
  type UseGitHubStarPromptOptions,
} from './code/composer/useGitHubStarPrompt';
export {
  GitHubStarPrompt,
  type GitHubStarPromptProps,
} from './code/composer/GitHubStarPrompt';

export {
  DelegationRowBlocks,
  type DelegationRowBlocksProps,
  type DelegationBlockRenderer,
} from './code/DelegationRowBlocks';

export {
  useSidebarAutoDelete,
  SidebarAutoDeleteProvider,
  SidebarAutoDeleteNotice,
} from './code/shell/SidebarAutoDelete';
