export * from './OpenCodeAccountCard';
// Pure display components shared between the desktop renderer and the web
// portal. Components in this barrel must be callback-driven and free of
// window.api, Zustand stores, Next router/server actions, Prisma, Electron,
// and Node-only imports.
export * from './StatusBlocks';
export * from './Stack';
export * from './Surface';
export * from './AttachmentDropZone';
export * from './AttachmentItemRow';
export * from './PageColumn';
export * from './useRetry';
export * from './AgentDefinitionSummary';
export * from './ShareScopeControls';
export * from './ShareAudienceLabel';
export * from './ShareActionButton';
export * from './DetailActionBar';
export * from './EmailRecipientInput';
export * from './ErrorFallback';
export * from './AnsiOutput';
export * from './Badge';
export * from './PendingTurnSettingsHint';
export * from './FactList';
export * from './StatusPill';
export * from './StatusLabel';
export * from './McpRowHealth';
export * from './ReadyStatusLine';
export * from './CopyDetailsButton';
export * from './AutoRoutedModelPill';
export * from './CapabilityPill';
export * from './CapabilityTile';
export * from './capability-tile-model';
export * from './CanopyProxyErrorSummary';
export * from './AccountProxyFailureNotice';
export * from './CanopyProxyErrorPresentation';
export * from './AiCreditsStopLine';
export * from './AppErrorDetails';
export * from './ClaudeAiCreditsFallbackErrorNotice';
export * from './CodexAccountModelNotice';
export * from './AiCreditsCheckFeedback';
export * from './aiCreditsPurchaseCopy';
export * from './usageLimitModelSwitchCopy';
export * from './BillingHistoryTable';
export * from './BillingStatusPill';
export * from './CreditLedgerTable';
export * from './DataTable';
export * from './DetailFact';
export * from './InvoicesTable';
export * from './InvoiceDetailView';
export * from './DialogModal';
export * from './DialogFormField';
export * from './ConfirmDialog';
export * from './InstalledShareMenu';
export * from './UninstallConfirmDialog';
export * from './InstalledItemStatusPicker';
export * from './InstalledStatusFilterDropdown';
export * from './InstalledItemStatusRow';
export * from './ActiveItemsSummary';
export * from './ShareInstallDialog';
export * from './ReleaseHighlightsDialog';
export * from './ReleaseHighlightsList';
export * from './RenameDialog';
export * from './WorkspaceSettingsDialog';
export * from './DeferredWorkspaceSettingsDialog';
export * from './ColorSwatchPicker';
export * from './SidebarItemGroup';
export * from './sidebar-item-group-menu';
export * from './WorktreeDialogs';
export * from './WorktreeRemovalDialog';
export * from './SidebarBatchRemovalDialog';
export * from './SidebarBatchRemovalNotice';
export * from './worktree-count-label';
export * from './ResizeRailIndicator';
export * from './Progress';
export * from './UsageIndicator';
export * from './CodexContextWindowControl';
export * from './PageHeader';
export * from './Heading';
export * from './InstructionsEditor';
export * from './Disclosure';
export * from './ProviderUsageAccountRow';
export * from './ProviderAccountUsage';
export * from './RefreshSpinner';
export * from './Sheet';
export * from './LayoutTierProvider';
export * from './useMediaQuery';
export * from './useAnsiSearch';
export * from './useOverlayEscape';
export * from './DataSharingFeaturePills';
export * from './DataSharingOptInCta';
export * from './OrgEnforcedConsentList';
export * from './Button';
export * from './ListRow';
export * from './IconToggleButton';
export * from './StartingPointChip';
export * from './ScrollToBottomButton';
export * from './Choice';
export * from './DateField';
export * from './Field';
export * from './FormField';
export * from './OneTimeCodeInput';
export * from './InlineTextInput';
export * from './chat/InputDeliveryList';
export * from './chat/SteeringTitle';
export * from './chat/SteeringRequestTitle';
export * from './SuggestionRow';
export * from './InterruptedSessionRow';
export * from './HeaderActionButton';
export * from './MobileTopBarButton';
export * from './SidebarNavRow';
export * from './SidebarNavMarker';
export * from './SidebarMoreControl';
export * from './RowActions';
export * from './TableActions';
export * from './RailIconButton';
export * from './RailSectionHeader';
export * from './TitlebarIconButton';
export * from './ToggleSwitch';
export * from './SegmentedControl';
export * from './TabBar';
export * from './SettingsSaveStatus';
export * from './settings/SettingsRows';
export * from './settings/ValueRows';
export * from './settings/SettingsButtonRow';
export * from './settings/SettingsSaveBar';
export * from './ChoiceList';
export * from './ProviderRowLabel';
export * from './ProjectChoiceCard';
export * from './OverlayScrollArea';
export * from './DropdownMenu';
export * from './SidebarAiCreditsMenuItem';
export { isFreeOnlyAiCredits } from './aiCreditsLabel';
export * from './ButtonLink';
export * from './ExternalTextLink';
export * from './TextLink';
export * from './PluginHarnessConnections';
export * from './PluginAccountConnection';
export * from './PluginConfigurationButton';
export * from './FloatingMenu';
export * from './NestedMenuFlyout';
export * from './PickerMenu';
export * from './PickList';
export * from './ComposerSuggestionMenu';
export * from './Popover';
export * from './PullRequestPickerOption';
export * from './FloatingChatWindow';
export * from './ModelGroupHeader';
export * from './SpaceNotificationMenu';
export * from './ActionMenuItems';
export * from './WorktreeActionsMenu';
export * from './bubble-badge';
export * from './BubbleCopyBadge';
export * from './CopyButton';
export * from './CopyLinkButton';
export * from './copy-to-clipboard';
export * from './copy-feedback';
export * from './markdown-mermaid-export-context';
export * from './markdown-mermaid-export-names';
export * from './ForkChatButton';
export * from './Kbd';
export * from './PromptSuggestionKeyHint';
export * from './Chip';
export * from './KbdChip';
export * from './KeyHintFooter';
export * from './PanelSection';
export * from './ActivityActionCardButton';
export * from './ActivityPingDot';
export * from './RailTabBar';
export * from './FileTreeRow';
export * from './FileRootGroupRow';
export * from './TurnFeedbackControl';
export * from './TurnFeedbackDialog';
export * from './TurnTimer';
export * from './ThinkingSpinner';
export * from './StatusGlyph';
export * from './WorkflowLastRunText';
export * from './ChatToolStepGroup';
export * from './Tooltip';
export * from './RichHoverTooltip';
export * from './ActionTooltip';
export * from './AutoArchiveSettingsControl';
export * from './AppAdvisorProjectAgentAccessControl';
export * from './PrivateMemoryCard';
export * from './LoadingButton';
export * from './LoadingSpinner';
export * from './CancelableActionButton';
export type { SpinnerTone } from './spinner-tone';
export * from './ProgressChecklist';
export * from './RunSpinner';
export * from './RunningGlyph';
export * from './ChatTab';
export * from './UserBubble';
export * from './DisplayAvatar';
export * from './SharedChatAuthorHeader';
export * from './StatusBadge';
export * from './PullRequestStateBadge';
export * from './CheckStatusBadge';
export * from './ReviewStatusBadge';
export * from './PrLabelBadge';
export * from './RefreshButton';
export * from './FilesTreeRefreshButton';
export * from './RelatedItemsSection';
export * from './PluginDetailSectionHeading';
export * from './PluginConnectionRouteSection';
export * from './DiffLineCounts';
export * from './FileChangeMetadata';
export * from './FileRevertButton';
export * from './SourceInfoButton';
export * from '../icons/PauseResumeIcon';
export * from './ExecutionActionButton';
export * from './SkillUpdateNotice';
export * from './DetailHeader';
export * from './DetailMoreMenu';
export * from './DetailPrimaryCta';
export * from './UnresolvedCapabilitySelection';
export * from './TryItSignInNotice';
export * from './RunningProcessCard';
export * from './RunConfirmationCard';
export * from './SettingsDangerConfirmBlock';
export * from './LabsExperimentsSection';
export * from './SettingsTabBar';
export * from './PlanActionButtonRow';
export * from './PlanReviewStatusBadge';
export * from './PlanOpenImplementationAction';
export * from './PlanReviewThread';
export * from './DagProgressBar';
export * from './PlanSourceMark';
export * from './PlanProvenance';
export * from './HighlightedSegments';
export * from './Markdown';
export { MarkdownCodeBlock } from './MarkdownCodeBlock';
export * from './SkillFilePreview';
export * from './SkillFileExplorer';
// CAN-1939 — shared mobile-app promotion. The base64 badge artwork lives in
// `../assets/store-badges` and is deliberately NOT re-exported here, so hosts
// that only need the components do not pull ~27KB of data URIs into the barrel.
export * from './StoreBadgeLink';
export * from './MobileAppPromo';
export * from './MobileAppQrPromo';
export * from './CtaBanner';
export * from './Notice';
export * from './UsageLimitNotice';
export * from './StuckAgentNotice';
export * from './CatchingUpNotice';
export * from './BackgroundWorkCapNotice';
export * from './OnboardingTip';
export * from './DirectoryPickerOptionRow';
export * from './chat/ForkContextNotice';
export * from './chat/ApprovalSafetyDeniedNotice';
export * from './DiffStates';
export * from './RepositoryCloneError';
export * from './NoticeList';
export * from './NotificationDetailsDialog';
export * from './SuggestionCard';
export * from './NotificationOfferNotice';
export * from './AutomationOfferNotice';
export * from './AutomationPipelineTargetFields';
export * from './ToastStack';
export * from './ToastNotice';
export {
  attachToastSwipe,
  type ToastSwipe,
  type ToastSwipeGesture,
} from './toast-swipe';
export * from './InlineMention';
// Phase 2B — rail row visuals.
export * from './WorkspaceSectionHeader';
export * from './WorkspaceIconDisclosureSwap';
export * from './HiddenItemsRow';
export * from './ProjectListPagination';
export * from './ArchivedContainersNavLink';
export * from './WorkspaceKindBadge';
export * from './ProjectAvatarBadge';
export * from './SidebarFadePresence';
export * from './SharedWithTeammatesBadge';
export * from './WorktreeRow';
export * from './PipelineDispatchedTime';
export * from './PipelineStatusPopover';
export * from './TerminalStatusPopover';
export * from './RunBadgePopover';
export * from './MergeQueueStatus';
export * from './ChatPreviewPopover';
export * from './StandaloneChatRow';
export * from './SidebarPinMenuItem';
export * from './SidebarPinnedBadge';
export * from './SidebarTrialBadge';
export * from './WorkEntryRow';
export * from './AgentStateGlyph';
export * from './WakeTurnBoundary';
export * from './WakeParkedNotice';
export * from './SidebarMoreRow';
export * from './SidebarSectionToggle';
export * from './SidebarToggleRow';
export * from './SidebarRowAge';
export * from './CometSpinner';
export * from './spinner-style';
export * from './chat-look';
export * from './ChatDetailControl';
export * from './pr-hover-cards';
export * from './streaming-text';
export * from './icon-style';
export * from './LoadingIndicatorStyle';
export * from './BusyLabel';
export * from './context-menu-placement';
export * from './tooltip-handoff';
export * from '../icons/ModelProviderIcon';
export * from './ModelPickerMenu';
export * from './modelLibraryLock';
export * from './modelPickerRowCue';
export * from './ModelUnlockConfirmedNotice';
export * from './aiCreditsArrival';
export * from './AiCreditsArrivedNotice';
export * from './ModelUnlockPendingNotice';
export * from './creditsRecoveryCopy';
export * from './CreditsRecoveryNotice';
export * from './guestModelGate';
export * from './GuestModelGateContent';
export * from './ThinkingLevelControl';
export * from '../icons/ThinkingLevelIcon';
// Phase 3 (part B) — diff viewer chrome.
export * from './diff';
// Phase 4 — chat block render primitives.
export * from './chat';
// Composer parity (CAN-1215) — shared presentational toolbar.
export * from './ChatComposerToolbar';
// Plan chip beside + (CAN-3792): desktop's dismissible tile, Portal's toggle.
export * from './composer-plan-chip';
export * from './FoldReveal';
export * from './AudioWaveform';
export * from './ChatComposerShell';
export * from './ComposerTray';
export * from './ComposerSendButton';
// Terminal mode (`!` drafts): shell edge, mode label and run button.
export * from './TerminalComposerMode';

// Mobile composer compaction (CAN-1229) — overflow (⋯) menu for plan/fast/thinking.
export * from './ChatComposerOverflowMenu';
// Slash-command surface primitives shared by the rich-editor menu and host
// menus that render slash rows themselves (e.g. the portal Commands popup).
export * from './SlashCommandPrimitives';
export * from './TabContextMenu';
export * from './ChatMessageContextMenu';
// Portal Plugins section groundwork — pure plugin-surface parts extracted from
// the desktop plugins/skills/MCP views (see
// docs/planning/2026-08-27-portal-plugins-section/design.md).
export * from './ProgressDots';
export * from './StatusCounts';
export * from './WorkPath';
export * from './BackDetailOverlayShell';
export * from './ComponentSection';
export * from './ClickableName';
export * from './RiskBadge';
export * from './SecurityAuditSummary';
export * from './McpClientSetupDetails';
export * from './McpServerDetailSections';
export * from './FrontmatterBlock';
export * from './MarkdownFrontmatterContent';
export * from './DescriptionMarkdown';
// Portal Plugins section PR 5 — shared presentational core of the plugin
// detail surface (desktop PluginDetailView + web detail route).
export * from './PluginDetailContent';
export * from './ProviderSupportIcons';
export * from './UnifiedTable';
export * from './unified-table-virtualization';
export * from './external-agents';
export * from './PluginMemberDetails';
// Portal Plugins section phase B — portable marketplace install presentation
// moved from the desktop renderer (which keeps a re-export shim).
export * from './MarketplacePluginInstall';
export * from './McpServerLogo';
export * from './McpConnectionStatusBadge';
export * from './McpSignInPending';
export * from './EntrySourceLabel';
export * from './EntrySurfaceIcon';
export * from './PluginsDiscoveryList';
export * from './PluginsDiscoveryListLoading';
export * from './CustomizeBreadcrumbs';
export * from './CustomizeSection';
export * from './CustomizeInstalledRow';
export * from './CustomizeInstalledList';
export * from './CustomizeRowMenu';
export * from './CustomizeInstalledUnavailable';
export * from './UpdateMarker';
export * from './PluginsPipelineFilters';
export * from './WorkflowsTabBar';
export * from './MarketplaceSearchField';
export * from './SearchField';
export * from './SearchPalette';
export * from './PageSearchRow';
export * from './MarketplaceTypeTabs';
export * from './MarketplaceTypeLabel';
export * from './PluginsAddCustomMenu';
export * from './page-header-copy';

export {
  ChecklistDismiss,
  ChecklistAction,
  CHECKLIST_ROW_CLASS_NAME,
} from './ChecklistControls';
export {
  BrowserProfileBadge,
  BrowserProfilePermissions,
} from './BrowserProfileControls';

export * from './chat/WatcherFiredTitle';
// "Sent by {client}" title row on user messages an external MCP agent sent.
export * from './chat/AgentSentMarker';
export * from './AddedPluginsList';
export * from './PluginSelectionScopeHelp';
export * from './ActivityItemRow';
export * from './activity-item-density';
export {
  ComposerActionList,
  type ComposerActionRow,
  type ComposerShowAllControl,
} from './ComposerActionList';
export {
  CuratedPipelineCatalog,
  curatedPipelineStaleMessage,
  type CuratedPipelineCatalogProps,
} from './CuratedPipelineCatalog';
export * from './CuratedCatalogNotice';
export * from './CuratedPipelinePreviewDialog';
export * from './PipelineTemplatesSection';
export * from './ArchivedChatsCard';
export * from './ArchivedOverviewRow';
export * from './SharedContainerAcceptSummary';
export * from './SharedContainerInvitationDialog';
export * from './SharedContainerOwnerDepartureNotices';
export * from './SharedContainerOwnerDepartureFeedback';
export * from './SharedContainerPastSharesList';
export * from './ArchivedRowActionsMenu';
export * from './ArchivedStateFilterDropdown';
export * from '../icons/ArchivedStateIcon';
export * from './ledger';
export * from './EmptyTrashDialog';
export * from './sidebar-item-classes';

export * from './RetryCountdown';

export * from './WorkspaceLayoutPicker';

export * from './GitHubRepositoryPicker';
export * from './LinkTargetChip';
export * from './ComposerHeroFrame';
// GitHubReferencePreviewCard is subpath-only: this barrel is in the web chat's
// first load, which never mounts GitHub previews (perf:web:bundle budget).
export * from './LinearIssuePreviewCard';
export * from './code-graph/CodeGraphSummaryView';
export * from './WordBoundaryTruncatedText';
export * from './InlineTextSkeleton';
export * from './Skeleton';
export * from './CenteredLoadingSpinner';
export * from './DelayedLoadingPlaceholder';
export * from './LoadingRegion';
export * from './SlowLoadNote';

export * from './UsageGroup';
export * from '../icons/UsageResetIcon';
export * from './UsageLimitedSessionsControl';
export {
  DeferredPluginsControl,
  type DeferredPluginsControlProps,
} from './DeferredPluginsControl';
export {
  UsageErrorNotice,
  parseUsageRetryAt,
  useUsageRetryWait,
} from './UsageErrorNotice';
export type { UsageErrorNoticeProps } from './UsageErrorNotice';

export * from './SidebarStylePicker';

export * from './AppearanceSelect';

export * from './SettingsSelect';
export * from './settings/SettingsBackButton';

export * from './ComposerLayout';
export * from './ComposerDrawer';
export * from './ComposerIconButton';
export * from './ComposerPlusMenuPresentation';
export * from './ComposerAccessPicker';
export * from './ModelPickerTriggerControl';
export * from './McpServerCardRow';

export * from './GroupedDiffStats';
export * from './composer-tip-arbiter';

export { StandardPresentationProvider } from './StandardPresentationProvider';
export * from './RemoteControlMobileAppPromo';
export * from './RemoteControlPairingCode';

export * from './HomeSection';
export * from './StartChatSummary';

export * from './DrawerWatcherControl';
export * from './DrawerInspectorAction';
export * from './DetailSeparator';
export * from './ReferenceHoverCard';

export * from './W5RecoveryNotice';

export * from './Fieldset';
export * from './SidebarSectionMenuItems';
export * from './SidebarSelectionControls';
export * from './SidebarAutoDeleteBadge';
export * from './SourceBranchCommitHint';
export * from './AgentAliasModelFields';
