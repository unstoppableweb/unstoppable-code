import { toActiveComposerView } from '@/components/chat/types';
import { AppLoadingScreen } from '@/components/onboarding/AppLoadingScreen';
import { WindowsGitRequiredScreen } from '@/components/startup/WindowsGitRequiredScreen';
import { ResumeQueueModal } from '@/components/usage-limit/ResumeQueueModal';
import { CloneProgressModal } from '@/components/worktree/CloneProgressModal';
import { useCanopyDesktopSharedContainersEnabled } from '@/hooks/useCanopyDesktopSharedContainersEnabled';
import {
  resolveStartupGateView,
  useWindowsGitRequirement,
} from '@/hooks/useWindowsGitRequirement';
import { isCanopyCloudConnected } from '@/lib/canopy-cloud';
import { localPlatform } from '@/lib/local-platform';
import { bridgeMainSkillsChanged } from '@/lib/skillsChanged';
import {
  openCloudAccountSettings,
  openIntegrationSettings,
  openSettingsDeepLink,
} from '@/lib/navigation/settings-destinations';
import { canTransferChatSession } from '@/lib/session-transfer-eligibility';
import { resolveSharedRunUrl } from '@/lib/share-links';
import { initializeDelegationActivityStore } from '@/stores/delegationActivityStore';
import { initializeLiveBackgroundTaskStore } from '@/stores/liveBackgroundTaskStore';
import { initializeSharedContainerReplicasStore } from '@/stores/sharedContainerReplicasStore';
import { initializeSharedContainersStore } from '@/stores/sharedContainersStore';
import {
  NAVIGATION_PAGE_REPLAY_PRIVACY,
  replayBlockClassFor,
} from '@canopy/desktop-instrumentation/posthog-replay-surfaces';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  CONSENT_TOS_VERSION,
  type CanopyGuestConsent,
} from '@canopy/desktop-shared/constants/consent';
import { codexSpeedFromFastMode } from '@canopy/execution-engine/lib/codex-speed';
import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import {
  APP_ADVISOR_PROJECT_ID,
  type AppAdvisorAction,
  type ChatWindowCommand,
  type PortalChatComposerCommandResult,
  type PortalChatComposerLifecycleCommand,
  type PortalChatComposerRendererRequest,
  type PortalChatComposerSetterRequest,
  type PreferencesLoadResult,
  type WorktreeChatBadgesSummary,
} from '@canopy/desktop-shared/types';
import { REMOTE_CONTROL_LABEL } from '@canopy/protocol';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { SurfaceFindHost } from '@canopy/ui-app/find';
import {
  getInAppNotificationContainerClasses,
  TitlebarIconButton,
} from '@canopy/ui-shared';
import { EditBigIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  Fragment,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
} from 'react';
import { ImportPlanModalHost } from './components/activity/ImportPlanModal';
import { AppAdvisorDockPage } from './components/app-advisor/AppAdvisorDockPage';
import { AppAdvisorMinimizedBubble } from './components/app-advisor/AppAdvisorMinimizedBubble';
import { AppAdvisorPanelShadow } from './components/app-advisor/AppAdvisorPanelShadow';
import { AppAdvisorMainRuntimeBridge } from './components/app-advisor/AppAdvisorRuntimeBridge';
import { AutomationInstallContinuationHost } from './components/automations/AutomationInstallContinuationHost';
import { CommitMessageReviewModalHost } from './components/github/CommitMessageReviewModal';
import { GitHubConnectOfferHost } from './components/github/GitHubConnectOfferHost';
import { ImportProjectsInvite } from './components/import-projects/ImportProjectsInvite';
import { ImportProjectsModalHost } from './components/import-projects/ImportProjectsModalHost';
import { DevPagesShell } from './components/pages/DevPagesShell';
import { MainPage } from './components/pages/MainPage';
import { WorktreeErrorNotice } from './components/worktree/WorktreeErrorNotice';
import { isDevPage } from './components/pages/dev-pages';
import { PipelineEditorRuntimeBridge } from './components/pipeline/PipelineEditorRuntimeBridge';
import { ReleaseHighlightsHost } from './components/release-highlights/ReleaseHighlightsHost';
import { RemoteAccessControlledNotice } from './components/remote-access/RemoteAccessControlledNotice';
import { WorkspaceRecoveryNotice } from './components/background-service/WorkspaceRecoveryNotice';
import { BackgroundServiceUnavailableNotice } from './components/background-service/BackgroundServiceUnavailableNotice';
import { RemoteAccessHost } from './components/remote-access/RemoteAccessHost';
import { RepoRulesModalHost } from './components/repo-rules/RepoRulesModalHost';
import { ScriptActionsDesktopHost } from './components/script-actions/ScriptActionsDesktopHost';
import { DataSharingOptInSheetHost } from './components/settings/DataSharingOptInSheetHost';
import { ChatShareHost } from './components/share/ChatShareHost';
import { PublicShareDispatchHost } from './components/share/PublicShareDispatchHost';
import { ShareInstallModalHost } from './components/share/ShareInstallModal';
import { CloudConnectGate } from './components/shared/CloudConnectGate';
import { GuestUpgradeNudge } from './components/shared/GuestUpgradeNudge';
import { SuggestionCorner } from '@canopy/ui-app/suggestions';
import { OsNotificationOfferProducer } from './components/suggestions/OsNotificationOfferProducer';
import { RepeatTaskOfferProducer } from './components/suggestions/RepeatTaskOfferProducer';
import { RunCommentsModalHost } from './components/shared/RunCommentsModal';
import { ShareSessionStatusModal } from './components/shared/ShareSessionStatusModal';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import { ToastContainer } from './components/shared/ToastContainer';
import { ScriptFailureOutputModal } from './components/activity/ScriptFailureOutputModal';
import { OverlayLayerSlot } from './components/overlay-layer/OverlayLayerSlot';
import { installAboveBrowserMirror } from './components/above-browser/aboveBrowserMirror';
import {
  shouldReserveSidebarTrafficLightRegion,
  sidebarDockedEdgeCss,
  titlebarCornerWidthCss,
  titlebarCreateTaskLeftCss,
  titlebarRowPaddingBottomCss,
  titlebarRowPaddingTopCss,
  titlebarToggleLeadingCss,
} from './components/sidebar-layout';
import { AppSidebar } from './components/sidebar/AppSidebar';
import { NavigationHistoryButtons } from './components/sidebar/NavigationHistoryButtons';
import { SidebarToggleButton } from './components/sidebar/SidebarToggleButton';
import { SkillSuggestionsModal } from './components/skills/SkillSuggestionsModal';
import { UsageLimitResumeModal } from './components/usage-limit/UsageLimitResumeModal';
import { WatcherModalHost } from './components/watchers/WatcherModalHost';
import { AddWorkspaceModalHost } from './components/worktree/AddRepoModal';
import { BaseBranchChangeConfirmationModalHost } from './components/worktree/BaseBranchChangeConfirmationModal';
import { BranchFromConfirmationModalHost } from './components/worktree/BranchFromConfirmationModal';
import { ImportSessionModalHost } from './components/worktree/ImportSessionModalHost';
import { APP_BOTTOM_STATUS_HOST_ID } from './hooks/useAppBottomStatusHost';
import { useAutoArchiveNotifications } from './hooks/useAutoArchiveNotifications';
import { useBillingLaneRuntimeSync } from './hooks/useBillingLaneRuntimeSync';
import { useCanopyPortalSubscription } from './hooks/useCanopyPortalSubscription';
import { useChatEventSubscriptions } from './hooks/useChatEventSubscriptions';
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts';
import { useModelUnlockReturn } from './hooks/useModelUnlockReturn';
import { usePipelineCompletionToasts } from './hooks/usePipelineCompletionToasts';
import { usePresenceReporter } from './hooks/usePresenceReporter';
import { useRemoteControlSubscription } from './hooks/useRemoteControlSubscription';
import { useRunCommentUpdates } from './hooks/useRunCommentUpdates';
import { useStandaloneChatEventSubscriptions } from './hooks/useStandaloneChatEventSubscriptions';
import { useTerminalActivitySubscription } from './hooks/useTerminalActivitySubscription';
import { useTerminalCompletionToasts } from './hooks/useTerminalCompletionToasts';
import { useTerminalDrawerAttentionSubscriptions } from './hooks/useTerminalDrawerAttentionSubscriptions';
import { useUpdateBusyReporter } from './hooks/useUpdateBusyReporter';
import { dispatchAppAction } from './lib/app-actions/dispatcher';
import { brandText } from './lib/brand';
import {
  flushChatInterest,
  getChatInterest,
  subscribeChatInterest,
  useChatInterestDeclaration,
} from './lib/chat-interest';
import { initCurrentUiStateTracking } from './lib/current-ui-state/initCurrentUiStateTracking';
import {
  NAVIGATION_FALLBACK_PAGE,
  useIsPageAvailable,
} from './lib/navigation/page-availability';
import { isWorkflowsTabId } from './lib/navigation/workflows-navigation';
import { applyOsNotificationOfferPreferences } from './lib/osNotificationOffer';
import {
  refreshInAppNotificationPrefs,
  refreshOsNotificationPrefs,
  setOsNotificationNavigationHandler,
} from './lib/osNotifications';
import {
  emitPreferencesUpdated,
  subscribePreferencesUpdated,
} from './lib/preferences-events';
import { useRendererDiagnostics } from './lib/renderer-diagnostics';
import {
  requestSidebarPreviewClose,
  requestSidebarPreviewOpen,
  requestSidebarPreviewOpenFromFocus,
  startSidebarEdgeHoverWatch,
} from './lib/sidebar-preview-controller';
import { prefetchTerminalShellProfiles } from './lib/terminalShellProfiles';
import { applyChatWidth, applyDisplayPreferences } from './lib/theme';
import { useInAppNotificationPlacement } from './lib/useInAppNotificationPlacement';
import { WatcherDeliveryDeduplicator } from './lib/watcherDeliveryDeduplicator';
import { WatcherDeliveryScheduler } from './lib/watcherDeliveryScheduler';
import { installWorkspaceContextSelectionSync } from './lib/workspaceContextSelection';
import { canNavigateToWorktreeFromSidebarItems } from './lib/worktreeNavigation';
import { useActivityStore } from './stores/activityStore';
import { useAppAdvisorStore } from './stores/appAdvisorStore';
import { setMainContentCoveredByAppAdvisorDock } from './stores/appAdvisorDockCover';
import { installAppAdvisorDockLeaveOnNavigation } from './lib/appAdvisorDockLeave';
import { ensureArchivedContainersSubscription } from './stores/archivedContainersStore';
import { useBranchDisplayStore } from './stores/branchDisplayStore';
import { useBranchGroupingPreferenceStore } from './stores/branchGroupingPreferenceStore';
import { ensureBrowserEventSubscription } from './stores/browserEventSubscription';
import { useBrowserStore } from './stores/browserStore';
import { invalidateApprovalDefaults } from './stores/chat/approval-defaults';
import { followClaudeModAdmissionPreferences } from './stores/chat/claude-mod-discovery';
import { useChatPrefetch } from './stores/chat/chat-prefetch';
import { tabRequestedCodexSpeed } from './stores/chat/codex-speed';
import { waitForWorktreeHydration } from './stores/chat/hydration';
import { isRetiredPlanChatScope } from './stores/chat/plan-explore-registry';
import {
  isClaudeTerminalBackedChatTab,
  WATCHER_TERMINAL_ONLY_MESSAGE,
} from './stores/chat/tab-utils';
import {
  useStaleChatCatchUp,
  type StaleChatCatchUpHost,
} from './stores/chat/stale-catch-up';
import { useChatSidebarStore } from './stores/chatSidebarStore';
import {
  initializeClaudeTerminalChatSync,
  initializeVisibleContextSync,
  useChatStore,
} from './stores/chatStore';
import { useCloudConnectGateStore } from './stores/cloudConnectGateStore';
import { useFeatureFlagsStore } from './stores/featureFlagsStore';
import { useRemoteControlStore } from './stores/remoteControlStore';
import { useLabsExperimentEnabled } from './stores/labsExperimentsStore';
import { ORCHESTRATOR_PAGE_EXPERIMENT_ID } from './lib/orchestratorPageExperiment';
import { useFileLabelsStore } from './stores/fileLabelsStore';
import { useFileTabUiStore } from './stores/fileTabUiStore';
import { useGitHubStore } from './stores/githubStore';
import { useGlobalPluginDefaultsStore } from './stores/globalPluginDefaultsStore';
import { startLinkBrowserTargetReporter } from './stores/linkBrowserTargetReporter';
import { initNavigationHistoryTracking } from './stores/navigationHistoryStore';
import { useNavigationModeStore } from './stores/navigationModeStore';
import {
  initAgentNavigationFlagTracking,
  useNavigationStore,
} from './stores/navigationStore';
import { setFixedSidePanelTabsClosable } from './stores/panelLayoutStore';
import { usePipelineCompatDetailStore } from './stores/pipelineCompatDetailStore';
import { useProjectsStore } from './stores/projectsStore';
import { useReleaseHighlightsStore } from './stores/releaseHighlightsStore';
import { useSidebarPageHandoffStore } from './stores/sidebarPageHandoffStore';
import { useSidebarStore } from './stores/sidebarStore';
import { isWorkerUnsettled, useWorkersStore } from './stores/workersStore';
import { useWorkspaceContextStore } from './stores/workspaceContextStore';
import { useMemoryReportStore } from './stores/memoryReportStore';

const staleChatCatchUpHost: StaleChatCatchUpHost = {
  current: getChatInterest,
  subscribe: subscribeChatInterest,
  flush: flushChatInterest,
};

const SettingsOverlay = lazy(() =>
  import('./components/settings/SettingsOverlay').then((module) => ({
    default: module.SettingsOverlay,
  })),
);

const MemoryReportOverlay = lazy(() =>
  import('./components/resource-diagnostics/MemoryReportOverlay').then(
    (module) => ({ default: module.MemoryReportOverlay }),
  ),
);

const OverviewPage = lazy(() =>
  import('./components/pages/OverviewPage').then((m) => ({
    default: m.OverviewPage,
  })),
);

const HomePage = lazy(() =>
  import('./components/pages/HomePage').then((m) => ({
    default: m.HomePage,
  })),
);

const CloudChatPage = lazy(() =>
  import('./cloud-chats/CloudChatPage').then((m) => ({
    default: m.CloudChatPage,
  })),
);
const StandaloneChatPage = lazy(() =>
  import('./components/pages/StandaloneChatPage').then((m) => ({
    default: m.StandaloneChatPage,
  })),
);

const WorkflowsPage = lazy(() =>
  import('./components/pages/WorkflowsPage').then((m) => ({
    default: m.WorkflowsPage,
  })),
);

const PluginsPage = lazy(() =>
  import('./components/pages/PluginsPage').then((m) => ({
    default: m.PluginsPage,
  })),
);

const DesktopStandingConditions = lazy(() =>
  import('./components/standing-conditions/DesktopStandingConditions').then(
    (m) => ({
      default: m.DesktopStandingConditions,
    }),
  ),
);

const HeaderStateGalleryPage = lazy(() =>
  import('./components/pages/HeaderStateGalleryPage').then((m) => ({
    default: m.HeaderStateGalleryPage,
  })),
);

const NoticeStateGalleryPage = lazy(() =>
  import('./components/pages/NoticeStateGalleryPage').then((m) => ({
    default: m.NoticeStateGalleryPage,
  })),
);

const FeedPage = lazy(() =>
  import('./components/pages/FeedPage').then((m) => ({
    default: m.FeedPage,
  })),
);
const AuditTrailPage = lazy(() =>
  import('./components/pages/AuditTrailPage').then((m) => ({
    default: m.AuditTrailPage,
  })),
);

const StatisticsPage = lazy(() =>
  import('./components/pages/StatisticsPage').then((m) => ({
    default: m.StatisticsPage,
  })),
);

const WorktreeStateGalleryPage = lazy(() =>
  import('./components/pages/WorktreeStateGalleryPage').then((m) => ({
    default: m.WorktreeStateGalleryPage,
  })),
);

const ActivityStateGalleryPage = lazy(() =>
  import('./components/pages/ActivityStateGalleryPage').then((m) => ({
    default: m.ActivityStateGalleryPage,
  })),
);

const MessageBubbleStateGalleryPage = lazy(() =>
  import('./components/pages/MessageBubbleStateGalleryPage').then((m) => ({
    default: m.MessageBubbleStateGalleryPage,
  })),
);

const ChangeReviewPage = lazy(() =>
  import('./components/pages/ChangeReviewPage').then((m) => ({
    default: m.ChangeReviewPage,
  })),
);

const UsagePage = lazy(() =>
  import('./components/pages/UsagePage').then((m) => ({
    default: m.UsagePage,
  })),
);

const WorkersPage = lazy(() =>
  import('./components/pages/WorkersPage').then((m) => ({
    default: m.WorkersPage,
  })),
);

const CanopyPortalModal = lazy(() =>
  import('./components/portal/CanopyPortalModal').then((m) => ({
    default: m.CanopyPortalModal,
  })),
);

// Lazy on purpose: the banner mounts in the always-mounted shell, and it pulls
// in ~27KB of base64 store-badge artwork plus the `qrcode` encoder. A lazy
// boundary keeps both off the startup path (see the `store-badges` and
// `vendor-qrcode` manualChunks entries in electron.vite.config.ts).
const MobileAppCtaBanner = lazy(() =>
  import('./components/shared/MobileAppCtaBanner').then((m) => ({
    default: m.MobileAppCtaBanner,
  })),
);

const CloudSignInGate = lazy(() =>
  import('./components/onboarding/CloudSignInGate').then((m) => ({
    default: m.CloudSignInGate,
  })),
);

const LegalConsentGate = lazy(() =>
  import('./components/onboarding/LegalConsentGate').then((m) => ({
    default: m.LegalConsentGate,
  })),
);

const CommandPalette = lazy(() =>
  import('./components/command-palette/CommandPalette').then((m) => ({
    default: m.CommandPalette,
  })),
);

const AppAdvisorQuickPromptModal = lazy(() =>
  import('./components/app-advisor/AppAdvisorQuickPromptModal').then((m) => ({
    default: m.AppAdvisorQuickPromptModal,
  })),
);

const FileSearchPalette = lazy(() =>
  import('./components/file-search-palette/FileSearchPalette').then((m) => ({
    default: m.FileSearchPalette,
  })),
);

const PrPicker = lazy(() =>
  import('./components/pr-picker/PrPicker').then((m) => ({
    default: m.PrPicker,
  })),
);

const FileTabCloseGuard = lazy(() =>
  import('./components/chat/FileTabCloseGuard').then((m) => ({
    default: m.FileTabCloseGuard,
  })),
);

const PipelineExecutionCompatHost = lazy(() =>
  import('./components/activity/PipelineExecutionCompatHost').then((m) => ({
    default: m.PipelineExecutionCompatHost,
  })),
);
const SplitPreflightModalHost = lazy(() =>
  import('./components/activity/SplitPreflightModal').then((m) => ({
    default: m.SplitPreflightModalHost,
  })),
);

// Bounded backoff for re-attempting a deferred (offline) guest mint while the
// app stays open. `online`/window `focus` cover the common "connectivity came
// back" cases immediately; the interval is a backstop for network recoveries
// that fire neither event (e.g. a server that was down comes back up).
const GUEST_MINT_RETRY_INTERVAL_MS = 30_000;

function App(): JSX.Element {
  useChatEventSubscriptions();
  // Declares the chats this window shows (and showed recently) to main.
  useChatInterestDeclaration('main');
  useStaleChatCatchUp(staleChatCatchUpHost);
  useChatPrefetch();
  // Local-only frame and delivery diagnostics for this renderer.
  useRendererDiagnostics();
  // Single app-wide mount: reports coarse human presence for the selected
  // worktree so the cloud stops pushing "your run finished" at someone who is
  // sitting there watching it finish (CAN-3195).
  usePresenceReporter();
  useStandaloneChatEventSubscriptions();
  useTerminalDrawerAttentionSubscriptions();
  useGlobalShortcuts();
  useUpdateBusyReporter();
  // Single app-wide mount: pushes live billing-lane availability into
  // `billingLaneRuntime` so the synchronous default resolver can see it, and
  // re-stamps pristine chat tabs once a provisional answer settles.
  useBillingLaneRuntimeSync();
  // Single app-wide mount: follows a browser checkout back into the app and
  // owns the one poll loop that confirms it (CAN-4028).
  useModelUnlockReturn();
  useCanopyPortalSubscription();
  // Device-to-device remote access: pairing state, the machine picker, and
  // the being-controlled notice all read this one store.
  useRemoteControlSubscription();
  // Fold main's shared-run comment poll into the tab's SharedRunMetadata and
  // fire the OS notification (CAN-397). The poll, not SSE, is the delivery
  // mechanism in production until CAN-486.
  useRunCommentUpdates();
  useAutoArchiveNotifications();

  const loadBranchDisplayMappings = useBranchDisplayStore(
    (s) => s.loadMappings,
  );
  const loadFileLabels = useFileLabelsStore((s) => s.loadFileLabels);
  const loadBranchGroupingPreference = useBranchGroupingPreferenceStore(
    (s) => s.loadEnabled,
  );
  const loadModelDefaults = useChatStore((s) => s.loadModelDefaults);
  const acknowledgeSelectedWorktreeAttention = useChatStore(
    (s) => s.acknowledgeSelectedWorktreeAttention,
  );
  const activePage = useNavigationStore((s) => s.activePage);
  const mainReplayBlockClass = replayBlockClassFor(
    NAVIGATION_PAGE_REPLAY_PRIVACY[activePage],
  );
  const settingsOpen = useNavigationStore((s) => s.settingsOpen);
  const memoryReportActive = useMemoryReportStore(
    (s) => s.flow.phase !== 'idle',
  );
  const secondarySidebarPageOpen = useSidebarPageHandoffStore(
    (state) => state.active,
  );
  const sidebarPageOpen = settingsOpen || secondarySidebarPageOpen;
  // A secondary page that covers the window (project settings) hides the
  // shell under it as Settings does.
  const secondaryPageCoversShell = useSidebarPageHandoffStore(
    (state) => state.coversMainShell,
  );
  const mainShellCovered = settingsOpen || secondaryPageCoversShell;
  const settingsInitialSection = useNavigationStore(
    (s) => s.settingsInitialSection,
  );
  const commandPaletteOpen = useNavigationStore((s) => s.commandPaletteOpen);
  const commandPaletteInitialQuery = useNavigationStore(
    (s) => s.commandPaletteInitialQuery,
  );
  const appAdvisorQuickPromptOpen = useNavigationStore(
    (s) => s.appAdvisorQuickPromptOpen,
  );
  const fileSearchPaletteOpen = useNavigationStore(
    (s) => s.fileSearchPaletteOpen,
  );
  const fileSearchPaletteInitialQuery = useNavigationStore(
    (s) => s.fileSearchPaletteInitialQuery,
  );
  const prPickerOpen = useNavigationStore((s) => s.prPickerOpen);
  const prPickerOptions = useNavigationStore((s) => s.prPickerOptions);
  const canopyPortalOpen = useNavigationStore((s) => s.canopyPortalOpen);
  const canopyPortalEnabled = useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key),
  );
  // The Remote Control dialog follows device Remote Control; Portal only
  // follows its opt-in (CAN-5985). Unknown until main's first snapshot.
  const remoteControlAvailable = useRemoteControlStore(
    (s) => s.state.available,
  );
  const remoteControlHydrated = useRemoteControlStore((s) => s.hydrated);
  const cloudSignInRequired = useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyCloudSignInRequired.key),
  );
  // Sidebar and customization choices follow the page availability policy.
  const claudeTuiWorkersEnabled = useIsPageAvailable('workers');
  const ledgerEnabled = useIsPageAvailable('feed');
  // The page host renders `visiblePage`, never `activePage`: content for a
  // page that was just switched off is gone in the same render, before the
  // effect below moves to the fallback page.
  const activePageAvailable = useIsPageAvailable(activePage);
  const visiblePage = activePageAvailable
    ? activePage
    : NAVIGATION_FALLBACK_PAGE;
  const guestModeEnabled = useFeatureFlagsStore((s) =>
    s.isEnabled(CLIENT_FEATURE_FLAGS.canopyGuestModeEnabled.key),
  );
  // null = account state not yet loaded; keep showing the loading screen until
  // we know whether the gate should block the shell.
  const [cloudConnected, setCloudConnected] = useState<boolean | null>(null);
  // Once the required sign-in wall has been shown, an account-change event is
  // not enough to dismiss it: auth broadcasts before the one-time privacy
  // disclosure is handled. Only CloudSignInGate's explicit completion callback
  // releases the wall, keeping the disclosure mounted throughout the hand-off.
  const [
    cloudSignInWallAwaitingCompletion,
    setCloudSignInWallAwaitingCompletion,
  ] = useState(false);
  // null = preferences not yet loaded; tracks whether the user has already
  // recorded first-run guest consent (CAN-934). Once accepted, the shell opens
  // even while the guest session is still minting (offline first launch).
  const [guestConsentAccepted, setGuestConsentAccepted] = useState<
    boolean | null
  >(null);
  // null = preferences not yet loaded. Tracks the blocking first-run legal
  // acceptance (ToS/Privacy, CAN-934). Unlike the guest/cloud gate this is
  // required on every first run regardless of feature flags, so the shell (and
  // startup unlock / onboarding auto-launch) stays gated until it is `true`.
  const [legalConsentAccepted, setLegalConsentAccepted] = useState<
    boolean | null
  >(null);
  const desktopSharedContainersEnabled =
    useCanopyDesktopSharedContainersEnabled();
  // First-run identity establishment is driven by the flags as named:
  //   - guest mode on → silently mint an anonymous guest (the anon-usage path);
  //     this is independent of `cloud-sign-in-required` so anon users still get
  //     a synced identity in production without ever being forced to sign in.
  //   - guest mode off + sign-in required → the blocking sign-in wall.
  const cloudSignInWallActive = cloudSignInRequired && !guestModeEnabled;
  const firstRunIdentityGateActive = guestModeEnabled || cloudSignInWallActive;
  // When guest mode is on, recorded consent satisfies the gate even before the
  // guest session finishes minting, so downstream startup gates can proceed.
  const guestConsentSatisfiesGate =
    guestModeEnabled && guestConsentAccepted === true;
  const cloudSignInWallComplete =
    !cloudSignInWallActive || !cloudSignInWallAwaitingCompletion;
  const cloudGateSatisfied =
    !firstRunIdentityGateActive ||
    (cloudConnected === true && cloudSignInWallComplete) ||
    guestConsentSatisfiesGate;
  const startupUnlockSentRef = useRef(false);
  // Desktop Git startup gate. Unsupported builds resolve to `not-required`
  // synchronously and perform no IPC. When cloud sign-in is
  // required, keep the probe dormant until the account check is satisfied.
  const gitGate = useWindowsGitRequirement({ enabled: cloudGateSatisfied });
  const appAdvisorOpen = useNavigationStore((s) => s.appAdvisorOpen);
  const appAdvisorFocused = useNavigationStore((s) => s.appAdvisorFocused);
  // The Orchestrator as a page in this window's content area (docked): its
  // own page draws the panel grid in the slot `AppAdvisorDockPage` reports.
  const appAdvisorDocked = useAppAdvisorStore(
    (s) => s.open && s.layout === 'docked',
  );
  const orchestratorPageEnabled = useLabsExperimentEnabled(
    ORCHESTRATOR_PAGE_EXPERIMENT_ID,
  );
  // Any navigation leaves the Orchestrator page: a page request (even for
  // the page already open), or another worktree or chat chosen anywhere
  // (palette, notification, agent action). The sidebar closes it itself.
  useEffect(() => installAppAdvisorDockLeaveOnNavigation(), []);
  // While it shows, the page under it is hidden, so its chat is not in view
  // (unread, attention, OS notifications). Leaving it shows that chat again,
  // which counts as seeing it, as returning to the page does.
  const appAdvisorWasDockedRef = useRef(false);
  useLayoutEffect(() => {
    setMainContentCoveredByAppAdvisorDock(appAdvisorDocked);
    if (appAdvisorWasDockedRef.current && !appAdvisorDocked) {
      useChatStore.getState().acknowledgeSelectedWorktreeAttention();
    }
    appAdvisorWasDockedRef.current = appAdvisorDocked;
  }, [appAdvisorDocked]);
  // Entry-keyed read-only mirrors — populated by `hydrateForNavigation()`
  // (which lists App Advisor Work Entries and loads each entry's tab
  // metadata) and updated via the shared `useChatEventSubscriptions` stream.
  // The single-writer policy keeps the App Advisor renderer as the canonical
  // persistence owner for every `app-advisor/<entryId>` slice; these
  // main-window mirrors exist purely so the Sidebar can derive
  // thinking/unread status while the App Advisor window is hidden.
  const appAdvisorThinking = useChatSidebarStore((s) => {
    for (const [key, wc] of Object.entries(s.worktrees)) {
      if (!key.startsWith(`${APP_ADVISOR_PROJECT_ID}/`)) continue;
      if (wc.tabs.some((tab) => tab.status === 'streaming')) return true;
    }
    return false;
  });
  const appAdvisorHasUnread = useChatSidebarStore((s) => {
    for (const [key, wc] of Object.entries(s.worktrees)) {
      if (!key.startsWith(`${APP_ADVISOR_PROJECT_ID}/`)) continue;
      if (wc.tabs.some((tab) => tab.unread === true)) return true;
    }
    return false;
  });
  const appAdvisorUnread = !appAdvisorFocused && appAdvisorHasUnread;
  const workersActive = useWorkersStore((s) =>
    Array.from(s.workers.values()).some((worker) =>
      isWorkerUnsettled(worker.status),
    ),
  );
  const navigate = useNavigationStore((s) => s.navigate);
  const returnToSectionRoot = useNavigationStore((s) => s.returnToSectionRoot);
  const sectionRootRequest = useNavigationStore((s) => s.sectionRootRequest);
  const sidebarHidden = useSidebarStore((s) => s.hidden);
  const sidebarPreviewing = useSidebarStore((s) => s.previewing);
  const sidebarPreviewPresented = useSidebarStore((s) => s.previewPresented);
  const sidebarPreviewSlidIn = useSidebarStore((s) => s.previewSlidIn);
  const sidebarWidth = useSidebarStore((s) => s.width);
  const toggleSidebarHidden = useSidebarStore((s) => s.toggleHidden);
  const hydrateSidebarFromPreferences = useSidebarStore(
    (s) => s.hydrateFromPreferences,
  );
  const syncSidebarFromPreferences = useSidebarStore(
    (s) => s.syncFromPreferences,
  );
  const addToast = useGitHubStore((s) => s.addToast);
  const closeSettings = useNavigationStore((s) => s.closeSettings);
  const closeCommandPalette = useNavigationStore((s) => s.closeCommandPalette);
  const closeAppAdvisorQuickPrompt = useNavigationStore(
    (s) => s.closeAppAdvisorQuickPrompt,
  );
  const closeFileSearchPalette = useNavigationStore(
    (s) => s.closeFileSearchPalette,
  );
  const closePrPicker = useNavigationStore((s) => s.closePrPicker);
  const closeCanopyPortal = useNavigationStore((s) => s.closeCanopyPortal);
  const previousActivePageRef = useRef(activePage);
  const watcherDeliverySchedulerRef = useRef(new WatcherDeliveryScheduler());
  const watcherDeliveryDeduplicatorRef = useRef(
    new WatcherDeliveryDeduplicator((request) =>
      window.api.appAdvisor.acknowledgeWatcherMessageDelivery(request),
    ),
  );
  const portalComposerQueueRef = useRef<Promise<void>>(Promise.resolve());
  const dispatchUiAction = useCallback((action: AppAdvisorAction): void => {
    void dispatchAppAction({
      requestId: `ui-${action.type}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`,
      source: 'ui',
      action,
    });
  }, []);

  const inAppNotificationPlacement = useInAppNotificationPlacement();

  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [loadedPreferences, setLoadedPreferences] =
    useState<PreferencesLoadResult | null>(null);
  const [appReadyWatchdogElapsed, setAppReadyWatchdogElapsed] = useState(false);

  const hasHydratedProjects = useProjectsStore((s) => s.hasHydratedProjects);
  const loadAllWorktreeTabs = useChatStore((s) => s.loadAllWorktreeTabs);
  // Stable signature of every `${projectId}/${worktreeId}` so the eager
  // chat-tab hydration effect re-runs only when the worktree set changes.
  const worktreeRefsSignature = useProjectsStore((s) =>
    s.projects
      .flatMap((p) =>
        p.type === 'cowork' ? [] : p.worktrees.map((w) => `${p.id}/${w.id}`),
      )
      .join('|'),
  );
  const eagerlyHydratedWorktreeKeysRef = useRef<Set<string>>(new Set());
  const pipelineCompatDetailOpen = usePipelineCompatDetailStore(
    (s) => s.request !== null,
  );

  // Hydrate the feature-flag store on mount and subscribe to broadcast
  // updates so renderer reads always reflect the latest main-process
  // verdict. Errors are swallowed by the store and logged; this effect
  // must never block render. The unsubscribe in the cleanup keeps the
  // listener count steady across React strict-mode remounts.
  useEffect(() => {
    void useFeatureFlagsStore.getState().hydrate();
    const unsubscribe = window.api.featureFlags.onSnapshotChanged(
      (snapshot) => {
        useFeatureFlagsStore.getState().setSnapshot(snapshot);
      },
    );
    // Electron main has no network-change event, so the renderer's `online`
    // tells main to retry a failed LaunchDarkly start right away instead of
    // waiting out its backoff (CAN-3511). Healthy snapshots skip the call.
    const retryUnavailableFlags = (): void => {
      if (useFeatureFlagsStore.getState().snapshot.status !== 'error') return;
      void window.api.featureFlags.refreshContext().catch(() => undefined);
    };
    window.addEventListener('online', retryUnavailableFlags);
    return (): void => {
      unsubscribe();
      window.removeEventListener('online', retryUnavailableFlags);
    };
  }, []);

  // Tooltips, hover cards and resize handles marked to draw above in-app
  // browser pages are copied into a native layer over the live page.
  useEffect(() => installAboveBrowserMirror(document), []);

  // Same shape for the Personal/organization context (CAN-2952): hydrate once,
  // then mirror every main-process broadcast so all windows agree.
  useEffect(() => {
    void useWorkspaceContextStore.getState().hydrate();
    const unsubscribe = window.api.workspaceContext.onChanged((broadcast) => {
      useWorkspaceContextStore.getState().applyBroadcast(broadcast);
    });
    // Selection follows the context (CAN-2954): clear on the way into a
    // context, restore that context's last selection on the way back.
    const unsubscribeSelection = installWorkspaceContextSelectionSync();
    return (): void => {
      unsubscribe();
      unsubscribeSelection();
    };
  }, []);

  // If Remote Control becomes unavailable while its dialog is open, close the
  // dialog. The conditional render below ALSO gates on availability so the
  // dialog never paints between snapshot broadcasts and this effect.
  useEffect(() => {
    if (remoteControlHydrated && !remoteControlAvailable && canopyPortalOpen) {
      closeCanopyPortal();
    }
  }, [
    remoteControlHydrated,
    remoteControlAvailable,
    canopyPortalOpen,
    closeCanopyPortal,
  ]);

  useEffect(() => {
    if (!activePageAvailable) {
      navigate(NAVIGATION_FALLBACK_PAGE);
    }
  }, [activePage, activePageAvailable, navigate]);

  // Hydrates the shared-container org snapshot once (so sidebar rows can answer
  // "can this user share?" synchronously) and subscribes to main's publication
  // broadcast. Both are account-scoped, not page-scoped, so they live here.
  useEffect(() => initializeSharedContainersStore(), []);
  // Per-chat managed delegation activity keeps a chat with live delegates
  // open and shown as working. The live provider background-task mirror keeps the
  // background-process cards current. App-lifetime, like the other
  // main-pushed mirrors.
  useEffect(() => {
    const disposeActivity = initializeDelegationActivityStore();
    const disposeLiveBackgroundTasks = initializeLiveBackgroundTaskStore();
    return (): void => {
      disposeLiveBackgroundTasks();
      disposeActivity();
    };
  }, []);
  useEffect(() => {
    if (!desktopSharedContainersEnabled) return;
    return initializeSharedContainerReplicasStore();
  }, [desktopSharedContainersEnabled]);

  useEffect(() => {
    void loadModelDefaults().catch(() => {
      // Defaults degrade gracefully to null
    });
  }, [loadModelDefaults]);

  useEffect(() => {
    void loadBranchDisplayMappings();
  }, [loadBranchDisplayMappings]);

  useEffect(() => {
    void loadFileLabels();
  }, [loadFileLabels]);

  useEffect(() => {
    void loadBranchGroupingPreference();
  }, [loadBranchGroupingPreference]);

  useEffect(() => {
    // Hydrate the file-tab UI store's autoSave preference before any file tab
    // opens. The store's `loadPreferences` is idempotent; the desktop session
    // runtime keeps the controller's autosave policy in sync with it.
    void useFileTabUiStore.getState().loadPreferences();
  }, []);

  useEffect(() => {
    // Single app-lifetime subscription so background archive expiry pushed by
    // the main process refreshes archived-container UI without interaction.
    ensureArchivedContainersSubscription();
  }, []);

  useEffect(() => {
    // Warm the terminal shell profiles before the first add-panel menu opens,
    // so its rows are complete on first paint instead of "Terminal (bash)"
    // popping in and shifting the list under the cursor.
    prefetchTerminalShellProfiles();
  }, []);

  useEffect(() => {
    ensureBrowserEventSubscription();
    startLinkBrowserTargetReporter();
    void useBrowserStore.getState().loadBrowserPreferences();
    if (typeof window.api.onPreferencesSynced !== 'function') {
      return undefined;
    }
    // Initial display hydration happens in the layout effect below. This
    // subscription separately keeps the renderer current when the main process
    // pushes a preference change after startup.
    return window.api.onPreferencesSynced((preferences) => {
      applyChatWidth(preferences.chatWidth);
      // An answer or notifications turned on elsewhere clears a pending offer.
      applyOsNotificationOfferPreferences(preferences);
      invalidateApprovalDefaults();
      useChatStore.setState({ approvalDefaultsCache: {} });
      useBrowserStore
        .getState()
        .setLocalServersOnly(preferences.inAppBrowserLocalServersOnly === true);
      useBrowserStore
        .getState()
        .setOpenAppLinksInBuiltInBrowser(
          preferences.openAppLinksInBuiltInBrowser === true,
        );
      useBrowserStore.getState().applySearchPreferences(preferences);
      followClaudeModAdmissionPreferences(preferences);
      // A save made in main, such as an App Advisor settings action
      // (CAN-6004), reaches this window only through this broadcast, so
      // announce it the way this window's own Settings save does.
      emitPreferencesUpdated(preferences);
      useAppAdvisorStore.getState().applyPreferences(preferences);
    });
  }, []);

  // Hydrate the Claude Workers store and subscribe to worker lifecycle events
  // at startup so worker cards stay current even before the Workers page is
  // first opened. `initialize` is idempotent (wires subscriptions once) and
  // self-heals: if it fails (e.g. the backend bridge isn't ready yet) the
  // store resets so the Workers page can retry on mount.
  useEffect(() => {
    void useWorkersStore
      .getState()
      .initialize()
      .catch(() => undefined);
  }, []);

  // Hydrate App Advisor entry tab metadata into the main renderer's
  // chat-store mirrors so Sidebar nav status (thinking/unread) renders
  // correctly even before the App Advisor window has been opened. Idempotent.
  useEffect(() => {
    void useAppAdvisorStore.getState().hydrateForNavigation();
  }, []);

  // Subscribe to the authoritative App Advisor window-state broadcast. The
  // initial fetch primes `useNavigationStore.appAdvisorOpen` before the
  // first nav-render; the live subscription keeps it in lockstep with
  // BrowserWindow `isVisible()` and focus state. Focus drives unread.
  useEffect(() => {
    void window.api.appAdvisor.getWindowState().then((state) => {
      useAppAdvisorStore.getState().syncWindowState(state);
    });
    return window.api.appAdvisor.onWindowStateChanged((state) => {
      useAppAdvisorStore.getState().syncWindowState(state);
    });
  }, []);

  useEffect(() => {
    setOsNotificationNavigationHandler((target) => {
      if (
        !canNavigateToWorktreeFromSidebarItems(
          useProjectsStore.getState().projects,
          target.projectId,
          target.worktreeId,
          useProjectsStore.getState().hasHydratedProjects,
        )
      ) {
        return;
      }

      useNavigationStore.getState().navigate('main');
      useChatStore
        .getState()
        .selectWorktree(target.projectId, target.worktreeId);
      if (target.chatId) {
        useChatStore.getState().switchTab(target.chatId);
      }
    });

    return (): void => {
      setOsNotificationNavigationHandler(null);
    };
  }, []);

  useEffect(() => {
    const disposeClaudeTerminalChatSync = initializeClaudeTerminalChatSync();
    const disposeVisibleContextSync = initializeVisibleContextSync();
    const disposeCurrentUiState = initCurrentUiStateTracking();
    const disposeAgentNavigationFlags = initAgentNavigationFlagTracking();

    return (): void => {
      disposeClaudeTerminalChatSync();
      disposeVisibleContextSync();
      disposeCurrentUiState();
      disposeAgentNavigationFlags();
    };
  }, []);

  // Preferences choose the real startup page asynchronously. Starting history
  // before that restore would seed the store's invisible `overview` default
  // and make Back available on every launch. WorktreeManager re-seeds once its
  // later worktree restore has also settled.
  useEffect(() => {
    if (!loadedPreferences) {
      return undefined;
    }
    return initNavigationHistoryTracking();
  }, [loadedPreferences]);

  useEffect(() => {
    const deliverWatcherCommand = async (
      command: ChatWindowCommand,
    ): Promise<void> => {
      // The retired plan-explore takeover's dedicated chat scope must never
      // start an invisible turn: refuse before any scope is loaded, exactly
      // like a missing/read-only destination tab.
      if (isRetiredPlanChatScope(command.projectId)) {
        throw new Error('Watcher destination chat is not available.');
      }
      const chatStore = useChatStore.getState();
      await chatStore.loadTabsForTarget(command.projectId, command.worktreeId);
      const key = `${command.projectId}/${command.worktreeId}`;
      // Startup may already own this scope's load, in which case the loader
      // returns early. Wait for that owner before resolving the destination.
      await waitForWorktreeHydration(key);
      const chatState = useChatStore.getState().worktreeChats[key];
      const tab = chatState?.tabs.find((entry) => entry.id === command.chatId);
      if (!tab || tab.kind === 'file' || tab.readOnly === true) {
        throw new Error('Watcher destination chat is not available.');
      }
      if (!isClaudeTerminalBackedChatTab(tab)) {
        throw new Error(WATCHER_TERMINAL_ONLY_MESSAGE);
      }
      await useChatStore.getState().sendMessage(
        command.text,
        undefined,
        {
          projectId: command.projectId,
          worktreeId: command.worktreeId,
          chatId: command.chatId,
        },
        undefined,
        {
          ...(command.hiddenContextText
            ? {
                hiddenContext: {
                  kind: 'canopy-watcher-event',
                  text: command.hiddenContextText,
                },
              }
            : {}),
          ...(command.watcherFired
            ? { watcherFired: command.watcherFired }
            : {}),
          watcherDeliveryId: command.deliveryId,
          throwOnDispatchFailure: true,
        },
      );
    };

    // Main delivers watcher messages directly for every chat except
    // Claude terminal-backed chats, whose terminal lives in this renderer.
    // This is the terminal presenter only; each delivery stays ordered per
    // chat and bounded by the scheduler's global limit and timeout.
    return window.api.chat.onWindowCommand((command) => {
      const deduplicator = watcherDeliveryDeduplicatorRef.current;
      if (!deduplicator.begin(command)) return;
      void watcherDeliverySchedulerRef.current
        .schedule(
          `${command.projectId}/${command.worktreeId}/${command.chatId}`,
          () => deliverWatcherCommand(command),
        )
        .then(
          () => {
            deduplicator.complete(command, { ok: true });
          },
          (error: unknown) => {
            deduplicator.complete(command, {
              ok: false,
              error:
                error instanceof Error
                  ? error.message
                  : 'Watcher message delivery failed.',
            });
          },
        );
    });
  }, []);

  // Apply Portal-originated composer control changes (CAN-1217) by driving the
  // same desktop store actions a local click would, so the desktop chip updates
  // live and the store's own persist re-projects the change back to the portal.
  useEffect(() => {
    const completeSetterRequest = async (
      result: PortalChatComposerCommandResult,
    ): Promise<void> => {
      try {
        await window.api.chat.completePortalComposerCommand(result);
      } catch {
        // Main process falls back to the acknowledgement timeout when the
        // renderer cannot return this best-effort result.
      }
    };

    const applyLifecycleCommand = async (
      command: PortalChatComposerLifecycleCommand,
    ): Promise<void> => {
      await useChatStore
        .getState()
        .loadTabsForTarget(command.projectId, command.worktreeId);
      const key = `${command.projectId}/${command.worktreeId}`;
      // CAN-1233: the create command's target tab does NOT yet exist — append
      // it (before the existence guard below, which the setters rely on). The
      // store's persist re-projects the new empty tab to the portal. Idempotent:
      // a duplicate id (command replay) is a no-op.
      if (command.kind === 'create') {
        const alreadyExists = useChatStore
          .getState()
          .worktreeChats[
            key
          ]?.tabs?.some((entry) => entry.id === command.chatId);
        if (!alreadyExists) {
          useChatStore.getState().createTab({
            projectId: command.projectId,
            worktreeId: command.worktreeId,
            id: command.chatId,
          });
        }
        return;
      }
      // Close (portal tab close button). `closeTab` looks the tab up itself,
      // honors the streaming/queued/pending-plan guard, and archives-or-discards
      // it; the committed removal re-projects the survivors and emits a
      // `chat_summary` removal delta so the portal evicts the closed tab. A
      // missing id is a no-op. Runs BEFORE the setter existence guard below,
      // which would otherwise reject a tab that closeTab is allowed to remove.
      if (command.kind === 'close') {
        useChatStore.getState().closeTab(command.chatId, {
          projectId: command.projectId,
          worktreeId: command.worktreeId,
        });
        return;
      }
      // Fork (portal end-of-turn fork action). Drives the renderer's own
      // `forkTab` for the same reason `close` drives `closeTab`: the desktop
      // owns transcript slicing, provider-normalized model config and the
      // clamped thinking level, so the portal inherits all of it. Omitting
      // `forkAfterUserMessageId` forks the whole chat. Runs BEFORE the setter
      // existence guard, which is scoped to composer setters (CAN-2527).
      if (command.kind === 'fork') {
        useChatStore.getState().forkTab(
          command.chatId,
          {
            projectId: command.projectId,
            worktreeId: command.worktreeId,
          },
          command.forkAfterUserMessageId === undefined
            ? // Whole-chat fork. `includeActiveTurn` is what lets a STREAMING
              // source fork at all (the selection helper rejects it
              // otherwise); an idle source clones everything either way, so
              // the flag is inert there. Mirrors the desktop's active-timer
              // fork.
              { includeActiveTurn: true }
            : { forkAfterUserMessageId: command.forkAfterUserMessageId },
        );
        return;
      }
    };

    const applySetterRequest = async (
      request: PortalChatComposerSetterRequest,
    ): Promise<void> => {
      const { command, requestId } = request;
      if (command.kind === 'branch') {
        // Must remain comfortably below main's COMPOSER_COMMAND_ACK_TIMEOUT_MS
        // so the renderer can settle the correlated request first.
        const branchConfirmationDeadlineMs = 25_000;
        let deadlineExpired = false;
        // Set at branchTab's point of no return (just before createWorktree).
        // From then on the deadline must not report failure: the worktree IS
        // being created, so only the real outcome may be acked — otherwise the
        // portal shows a failure for a branch that succeeded (TOCTOU between
        // the cancellation check and creation).
        let committed = false;
        const deadlineTimer = setTimeout(() => {
          deadlineExpired = true;
          if (committed) return;
          void completeSetterRequest({
            requestId,
            ok: false,
            code: 'execution_failed',
            error:
              'The desktop needed user confirmation that did not arrive in time. Try again from the desktop.',
            retryable: false,
          });
        }, branchConfirmationDeadlineMs);
        try {
          await useChatStore
            .getState()
            .loadTabsForTarget(command.projectId, command.worktreeId);
          const result = await useChatStore.getState().branchTab(
            command.chatId,
            {
              projectId: command.projectId,
              worktreeId: command.worktreeId,
            },
            {
              ...(command.forkAfterUserMessageId === undefined
                ? {}
                : {
                    forkAfterUserMessageId: command.forkAfterUserMessageId,
                  }),
              cancelled: () => deadlineExpired,
              onCommitted: (): void => {
                committed = true;
              },
            },
          );
          if (deadlineExpired && !committed) return;
          if (result.status === 'created') {
            await completeSetterRequest({ requestId, ok: true });
            return;
          }
          await completeSetterRequest({
            requestId,
            ok: false,
            code: 'execution_failed',
            error:
              result.status === 'failed'
                ? result.message
                : 'Branching the chat was cancelled.',
            retryable: result.status === 'failed' && result.retryable,
          });
        } catch {
          if (deadlineExpired && !committed) return;
          await completeSetterRequest({
            requestId,
            ok: false,
            code: 'execution_failed',
            error: 'The desktop app could not branch the chat.',
            retryable: false,
          });
        } finally {
          clearTimeout(deadlineTimer);
        }
        return;
      }
      if (command.kind === 'share') {
        if (!canTransferChatSession(command.projectId)) {
          await completeSetterRequest({
            requestId,
            ok: false,
            code: 'execution_failed',
            error: 'This chat cannot be shared as a run.',
            retryable: false,
          });
          return;
        }
        // Same hydration branch needed: the target worktree's tabs may not be
        // loaded yet, and shareRun reads the tab to build the run. A missing tab
        // must fail the command, not share nothing.
        await useChatStore
          .getState()
          .loadTabsForTarget(command.projectId, command.worktreeId);
        const shareTabs =
          useChatStore.getState().worktreeChats[
            `${command.projectId}/${command.worktreeId}`
          ]?.tabs ?? [];
        const shareTab = shareTabs.find((tab) => tab.id === command.chatId);
        if (!shareTab || shareTab.kind === 'file') {
          await completeSetterRequest({
            requestId,
            ok: false,
            code: 'execution_failed',
            error: 'The chat to share was not found in the target worktree.',
            retryable: false,
          });
          return;
        }
        // Exact parity with the desktop share control's disabled state
        // (`busy || !hasMessages`), through the SAME derivation it uses —
        // approximating the busy predicate here would drift from
        // `shareSessionBusy`'s queued-hook-placeholder nuance.
        const shareView = toActiveComposerView(shareTab);
        if (shareView.shareSessionBusy || !shareView.hasStartedSession) {
          await completeSetterRequest({
            requestId,
            ok: false,
            code: 'execution_failed',
            error: shareView.shareSessionBusy
              ? 'The chat is busy; wait for the current turn to finish before sharing.'
              : 'An empty chat cannot be shared.',
            // Busy clears when the turn ends, so a retry is meaningful.
            retryable: shareView.shareSessionBusy,
          });
          return;
        }
        // Ack a clear timeout BEFORE the channel's opaque 30s cutoff. Unlike
        // branch there is nothing to cancel — the cloud call IS the side
        // effect — and none is needed: sharing is idempotent (re-sharing
        // re-acks the SAME url, pinned by portal-chat-share.spec.mjs), so this
        // failure is safely RETRYABLE; a retry after a slow-but-successful
        // share converges instead of double-creating. Late real acks are
        // ignored by the settle path once the request has been answered.
        let shareDeadlineExpired = false;
        const shareDeadlineTimer = setTimeout(() => {
          shareDeadlineExpired = true;
          void completeSetterRequest({
            requestId,
            ok: false,
            code: 'execution_failed',
            error: 'Sharing is taking longer than expected. Try again.',
            retryable: true,
          });
        }, 25_000);
        try {
          const result = await useActivityStore
            .getState()
            .shareRun(command.projectId, command.worktreeId, command.chatId, {
              shareScope: command.shareScope,
              ...(command.teamId ? { teamId: command.teamId } : {}),
              ...(command.organizationId
                ? { organizationId: command.organizationId }
                : {}),
            });
          if (!result.externalId) {
            const error =
              result.reason === 'no-activity'
                ? 'This chat has no shareable activity.'
                : result.reason === 'blocked-by-org-policy'
                  ? 'An organization policy prevents sharing this chat.'
                  : result.reason === 'blocked-by-org-billing'
                    ? 'The target organization has no active plan, so it cannot receive shared runs.'
                    : 'The desktop app could not share the chat.';
            await completeSetterRequest({
              requestId,
              ok: false,
              code: 'execution_failed',
              error,
              retryable: false,
            });
            return;
          }
          // Mirror the desktop share flow's persistence (useShareRunAction):
          // without this the chat tab still reads as unshared on the desktop —
          // no "Shared" indicator, no comments affordance — for a share the
          // portal just performed. Team/organization NAMES are not on
          // ShareRunResponse (the modal flow enriches them from its own UI
          // request), so this records ids and scope; the desktop renders the
          // scope when names are absent.
          await useChatStore
            .getState()
            .setSharedRun(
              command.projectId,
              command.worktreeId,
              command.chatId,
              {
                externalId: result.externalId,
                shareScope: command.shareScope,
                ...(command.teamId ? { teamId: command.teamId } : {}),
                ...(command.organizationId
                  ? { organizationId: command.organizationId }
                  : {}),
                sharedAt: new Date().toISOString(),
              },
            );
          const shareUrl = await resolveSharedRunUrl(result.externalId);
          if (!shareUrl) {
            await completeSetterRequest({
              requestId,
              ok: false,
              code: 'execution_failed',
              error: 'The desktop app could not resolve the shared run URL.',
              retryable: false,
            });
            return;
          }
          await completeSetterRequest({
            requestId,
            ok: true,
            data: { shareUrl },
          });
        } catch (error: unknown) {
          if (!shareDeadlineExpired) {
            await completeSetterRequest({
              requestId,
              ok: false,
              code: 'execution_failed',
              error:
                error instanceof Error
                  ? error.message
                  : 'The desktop app could not share the chat.',
              retryable: false,
            });
          }
        } finally {
          clearTimeout(shareDeadlineTimer);
        }
        return;
      }
      const target = {
        projectId: command.projectId,
        worktreeId: command.worktreeId,
        chatId: command.chatId,
      };
      const key = `${command.projectId}/${command.worktreeId}`;

      try {
        await useChatStore
          .getState()
          .loadTabsForTarget(command.projectId, command.worktreeId);
        const tab = useChatStore
          .getState()
          .worktreeChats[
            key
          ]?.tabs.find((entry) => entry.id === command.chatId);
        if (!tab) {
          await completeSetterRequest({
            requestId,
            ok: false,
            code: 'not_found',
            error: 'The target chat is no longer available.',
            retryable: false,
          });
          return;
        }
        if (tab.kind === 'file' || tab.readOnly === true) {
          await completeSetterRequest({
            requestId,
            ok: false,
            code: 'invalid_target',
            error: 'Composer settings cannot be changed for this tab.',
            retryable: false,
          });
          return;
        }

        const actions = useChatStore.getState();
        let pluginSelectionsApplied = true;
        let modelApplied = true;
        switch (command.kind) {
          case 'model':
            modelApplied =
              command.executionHarness === undefined
                ? await actions.setModelAndWait(command.model, target)
                : await actions.setModelAndWait(
                    command.model,
                    target,
                    command.executionHarness,
                  );
            break;
          case 'thinking':
            await actions.setThinkingLevel(command.thinkingLevel, target);
            break;
          case 'fast':
            await actions.setFastMode(command.fastMode, target);
            break;
          case 'plan':
            // No explicit setter exists; only toggle when the desired state
            // differs so the command stays idempotent.
            if (tab.planMode !== command.planMode) {
              actions.togglePlanMode(target);
            }
            break;
          case 'plugins':
            pluginSelectionsApplied =
              actions.setPluginSelections(
                command.selections,
                target,
                command.deferredToolsAllowed,
              ) !== undefined;
            break;
        }

        const updatedTab = useChatStore
          .getState()
          .worktreeChats[
            key
          ]?.tabs.find((entry) => entry.id === command.chatId);
        const applied = ((): boolean => {
          if (!updatedTab || !pluginSelectionsApplied) {
            return false;
          }
          switch (command.kind) {
            case 'model':
              return (
                modelApplied &&
                updatedTab.model === command.model &&
                (command.executionHarness === undefined ||
                  updatedTab.executionHarness === command.executionHarness)
              );
            case 'thinking':
              return updatedTab.thinkingLevel === command.thinkingLevel;
            case 'fast':
              // A legacy boolean replaces the speed. Compare the exact speed:
              // Ultra fast also projects `false`, so the boolean alone would
              // report a Regular command as applied while Ultra fast remains.
              return (
                tabRequestedCodexSpeed(updatedTab) ===
                codexSpeedFromFastMode(command.fastMode)
              );
            case 'plan':
              return updatedTab.planMode === command.planMode;
            case 'plugins':
              return true;
          }
        })();

        if (!applied) {
          await completeSetterRequest({
            requestId,
            ok: false,
            code: 'invalid_target',
            error: 'The composer change is not available for this chat.',
            retryable: false,
          });
          return;
        }
        await completeSetterRequest({ requestId, ok: true });
      } catch {
        await completeSetterRequest({
          requestId,
          ok: false,
          code: 'execution_failed',
          error: 'The desktop app could not apply the composer change.',
          retryable: false,
        });
      }
    };

    const applyComposerCommand = async (
      request: PortalChatComposerRendererRequest,
    ): Promise<void> => {
      if ('requestId' in request) {
        await applySetterRequest(request);
        return;
      }
      await applyLifecycleCommand(request);
    };

    return window.api.chat.onPortalComposerCommand((request) => {
      portalComposerQueueRef.current = portalComposerQueueRef.current
        .catch(() => undefined)
        .then(() => applyComposerCommand(request));
    });
  }, []);

  useEffect(() => {
    const previousActivePage = previousActivePageRef.current;
    previousActivePageRef.current = activePage;
    if (activePage !== 'main' || previousActivePage === 'main') {
      return;
    }

    acknowledgeSelectedWorktreeAttention();
  }, [acknowledgeSelectedWorktreeAttention, activePage]);

  useLayoutEffect(() => {
    void window.api.loadPreferences().then((prefs) => {
      // Reuse the startup snapshot so plugin-default hydration cannot win the
      // preferences IPC race or issue a redundant startup read.
      void useGlobalPluginDefaultsStore.getState().hydrate(prefs);
      void useNavigationModeStore.getState().hydrate(prefs);
      applyDisplayPreferences(prefs);
      followClaudeModAdmissionPreferences(prefs);

      // Startup always lands on the Home composer. The MRU context
      // (`lastActiveContext` / legacy `lastSelectedWorktree*`) no longer
      // auto-navigates anywhere — once project hydration completes,
      // WorktreeManager's initialize pass turns it into a dismissible
      // "Resume" offer on the Home surface (see startupResumeStore).
      navigate('home');

      hydrateSidebarFromPreferences(prefs);
      // Populate the OS-notifications preference cache so the first toast
      // after app launch can respect the user's settings without a
      // round-trip on the hot path.
      refreshOsNotificationPrefs(prefs.osNotifications);
      refreshInAppNotificationPrefs(prefs.inAppNotifications);
      // Completions cannot arm the notification offer until this resolves.
      applyOsNotificationOfferPreferences(prefs);
      if (prefs.__error) {
        const backupMessage = prefs.__error.backupPath
          ? ` A backup was created at ${prefs.__error.backupPath}.`
          : '';
        const restoredMessage = prefs.__error.restoredFromPath
          ? `Preferences failed to load, so the last saved preferences were restored from ${prefs.__error.restoredFromPath}.${backupMessage}`
          : `Preferences failed to load, so defaults were restored.${backupMessage}`;
        addToast(restoredMessage, 'error');
        void window.api.acknowledgePreferencesLoadError?.();
      }
      setGuestConsentAccepted(Boolean(prefs.guestConsentAcceptedAt));
      setLegalConsentAccepted(Boolean(prefs.legalConsentAcceptedAt));
      // Snapshot release-highlights eligibility from this first read, before
      // the legal gate or onboarding can change it. Profiles predating the
      // onboarding marker intentionally count as fresh once.
      useReleaseHighlightsStore.getState().captureInitialSnapshot({
        lastSeenVersion: prefs.releaseHighlightsLastSeenVersion ?? null,
        onboardingCompleted: (prefs.onboardingCompleted?.length ?? 0) > 0,
      });
      setLoadedPreferences(prefs);
      setPreferencesLoaded(true);
    });
    // `navigate` is a stable zustand action reference; the startup
    // preference must only apply once at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addToast]);

  // Keep the unified sidebar's width/hidden/section-collapsed state in sync
  // with live preference updates broadcast from Settings (mirrors the old
  // Sidebar.tsx subscription).
  useEffect(() => {
    const unsubscribe = subscribePreferencesUpdated((prefs) => {
      applyChatWidth(prefs.chatWidth);
      // Use the sync variant so live Settings changes update the mounted
      // sidebar without re-running startup hydration.
      syncSidebarFromPreferences(prefs);
    });
    return unsubscribe;
  }, [syncSidebarFromPreferences]);

  // Watchdog: if preferences or project hydration never finish (e.g. IPC
  // failure), unblock the loading screen after 10s so the app stays usable.
  useEffect(() => {
    if (preferencesLoaded && hasHydratedProjects) return undefined;
    const timer = window.setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn('[canopy] app_loading_screen_stuck');
      setAppReadyWatchdogElapsed(true);
      setPreferencesLoaded(true);
    }, 10_000);
    return (): void => {
      window.clearTimeout(timer);
    };
  }, [preferencesLoaded, hasHydratedProjects]);

  // Kick off the initial workspace hydration as soon as the app mounts so
  // `appReady` (which gates the shell render) can flip even before
  // WorktreeManager — the usual loader — has had a chance to mount. This
  // matters especially for fresh-user installs where onboarding might
  // suppress the main page from being the active tab.
  useEffect(() => {
    void useProjectsStore.getState().loadProjects();
  }, []);

  // Startup badge hydration without full transcripts: seed sidebar badges
  // (unread, review plan) from each worktree's persisted `chatBadges` summary
  // in worktrees.json, and eagerly hydrate ONLY the worktrees whose persisted
  // state needs a live runtime (scheduled sends, pending plan approvals,
  // pending ask-user questions) or that predate the badge summary (no
  // `chatBadges` yet — legacy behavior until main backfills them). Everything
  // else hydrates lazily on selection or when live chat events arrive.
  // Driven off the worktree-refs signature so it only re-runs when the set of
  // worktrees changes; `getState()` reads the latest snapshot when the effect
  // fires. A dedup ref keeps each worktree from being re-processed.
  useEffect(() => {
    const badgeSeed: Record<string, WorktreeChatBadgesSummary> = {};
    const allWorktrees = useProjectsStore.getState().projects.flatMap((p) => {
      if (p.type === 'cowork') {
        return [];
      }
      return p.worktrees.map((wt) => {
        const key = `${p.id}/${wt.id}`;
        if (wt.chatBadges) {
          badgeSeed[key] = wt.chatBadges;
        }
        return {
          projectId: p.id,
          worktreeId: wt.id,
          needsEagerHydration:
            wt.chatBadges === undefined || wt.chatBadges.needsHydration,
        };
      });
    });
    const currentKeys = new Set(
      allWorktrees.map(
        (worktree) => `${worktree.projectId}/${worktree.worktreeId}`,
      ),
    );
    for (const key of Array.from(eagerlyHydratedWorktreeKeysRef.current)) {
      if (!currentKeys.has(key)) {
        eagerlyHydratedWorktreeKeysRef.current.delete(key);
      }
    }

    useChatStore.getState().seedPersistedWorktreeBadges(badgeSeed);

    const newlySeenWorktrees = allWorktrees.filter((worktree) => {
      const key = `${worktree.projectId}/${worktree.worktreeId}`;
      if (eagerlyHydratedWorktreeKeysRef.current.has(key)) {
        return false;
      }
      eagerlyHydratedWorktreeKeysRef.current.add(key);
      return worktree.needsEagerHydration;
    });

    if (newlySeenWorktrees.length > 0) {
      void loadAllWorktreeTabs(
        newlySeenWorktrees.map(({ projectId, worktreeId }) => ({
          projectId,
          worktreeId,
        })),
      );
    }
  }, [worktreeRefsSignature, loadAllWorktreeTabs]);

  const appReady =
    (preferencesLoaded && hasHydratedProjects) || appReadyWatchdogElapsed;
  const startupView = resolveStartupGateView(appReady, gitGate.state);
  const startupUnlockReady =
    legalConsentAccepted === true &&
    cloudGateSatisfied &&
    appReady &&
    gitGate.state.kind === 'not-required';

  // A new install lands on the first-run import page (HomePage), then Home,
  // where `HomeOnboardingSuggestions` carries the remaining setup steps.

  // Track Canopy Cloud connection state for the blocking sign-in gate. We load
  // the account on mount and re-load whenever the account section broadcasts a
  // connect/disconnect, so the gate dismisses live without a restart. The gate
  // is the only consumer of `cloudConnected`, so when the flag is off we skip
  // the startup IPC call and the lifetime event listener entirely.
  useEffect(() => {
    if (!firstRunIdentityGateActive) {
      setCloudSignInWallAwaitingCompletion(false);
      return;
    }
    let cancelled = false;
    const refresh = (): void => {
      void window.api
        .loadCanopyCloudAccount()
        .then((account) => {
          if (cancelled) return;
          const connected =
            isCanopyCloudConnected(account) &&
            (!cloudSignInWallActive || !isGuestAccount(account));
          setCloudConnected(connected);
          if (cloudSignInWallActive && !connected) {
            setCloudSignInWallAwaitingCompletion(true);
          }
        })
        .catch(() => {
          if (cancelled) return;
          setCloudConnected(false);
          if (cloudSignInWallActive) {
            setCloudSignInWallAwaitingCompletion(true);
          }
        });
    };
    refresh();
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    return (): void => {
      cancelled = true;
      window.removeEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, refresh);
    };
  }, [cloudSignInWallActive, firstRunIdentityGateActive]);

  // Silent guest identity (CAN-936): when guest mode is on and the user is
  // signed out after accepting the first-run legal terms, mint an anonymous
  // guest in the background — no interstitial screen. The already-accepted legal
  // consent is the basis. On success the account-changed broadcast flips
  // `cloudConnected` true and the shell opens; if the mint is deferred (offline)
  // consent is still recorded so the shell opens and the retry effect below
  // mints when connectivity returns.
  useEffect(() => {
    if (!guestModeEnabled) return;
    if (legalConsentAccepted !== true) return;
    // Only when signed out and not yet minted/attempted this run. `null` =
    // account state still loading; `true` = already connected (real or guest).
    if (cloudConnected !== false || guestConsentAccepted === true) return;
    let cancelled = false;
    const consent: CanopyGuestConsent = {
      acceptedAt: new Date().toISOString(),
      tosVersion: CONSENT_TOS_VERSION,
    };
    void window.api
      .startCanopyGuestSession(consent)
      .then(() => {
        if (cancelled) return;
        setGuestConsentAccepted(true);
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      })
      .catch(() => {
        // Offline / transient: consent is recorded, so open the shell; the
        // retry effect below mints when connectivity returns.
        if (!cancelled) setGuestConsentAccepted(true);
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    guestModeEnabled,
    legalConsentAccepted,
    cloudConnected,
    guestConsentAccepted,
  ]);

  // Retry a deferred (offline) guest mint using previously-recorded consent.
  // Fires when consent is accepted but no account is connected yet — e.g. the
  // first-run mint was deferred offline, or the user signed out from a real
  // account while connectivity was down (disconnect clears the real credential
  // and its guest-fallback mint failed, stranding the sidebar at "Not signed
  // in"). Besides the immediate attempt, re-attempt when connectivity is likely
  // restored (`online`/window `focus`) and on a bounded interval, so the
  // stranded state self-heals in-session without a restart. `startCanopyGuest-
  // Session` is idempotent (no-op once a credential exists), and a successful
  // mint broadcasts the account-changed event, which flips `cloudConnected`
  // true and tears these listeners down.
  useEffect(() => {
    if (!guestModeEnabled) return;
    if (guestConsentAccepted !== true || cloudConnected !== false) return;
    let cancelled = false;
    let inFlight = false;
    const attempt = (): void => {
      if (cancelled || inFlight) return;
      inFlight = true;
      void window.api
        .startCanopyGuestSession()
        .then((account) => {
          if (cancelled) return;
          if (account.hasApiKey) {
            window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          }
        })
        .catch(() => {
          // Still offline; a later trigger retries.
        })
        .finally(() => {
          inFlight = false;
        });
    };
    attempt();
    window.addEventListener('online', attempt);
    window.addEventListener('focus', attempt);
    const intervalId = window.setInterval(
      attempt,
      GUEST_MINT_RETRY_INTERVAL_MS,
    );
    return (): void => {
      cancelled = true;
      window.removeEventListener('online', attempt);
      window.removeEventListener('focus', attempt);
      window.clearInterval(intervalId);
    };
  }, [guestModeEnabled, guestConsentAccepted, cloudConnected]);

  // Notify startup consumers only after cloud auth, hydration, and Git
  // checks have cleared. Auto-onboarding uses the same readiness boundary.
  useEffect(() => {
    if (!startupUnlockReady || startupUnlockSentRef.current) return;
    startupUnlockSentRef.current = true;
    void window.api.notifyStartupUnlocked();
  }, [startupUnlockReady]);

  // OS share deep links (CAN-2361): the main process delivers validated
  // payloads only after startup unlock, so this mount-time subscription is
  // always attached before the first delivery. Parked in the navigation
  // store until the shared-entity landing surface consumes it.
  // Agent skill actions run in Electron main; re-announce them so open
  // skill inventories (the Plugins page among them) refresh.
  useEffect(() => {
    const skills = window.skills;
    if (typeof skills?.onChanged !== 'function') return undefined;
    return bridgeMainSkillsChanged((listener) => skills.onChanged(listener));
  }, []);

  useEffect(() => {
    return window.api.onDeepLinkShareOpen((event) => {
      useNavigationStore.getState().openShareInstall(event, 'deep-link');
    });
  }, []);

  useEffect(() => {
    return window.api.onDeepLinkRemoteControlOpen(() => {
      useNavigationStore.getState().openCanopyPortal();
    });
  }, []);

  useEffect(() => {
    return window.api.onDeepLinkSettingsOpen(openSettingsDeepLink);
  }, []);

  // Privacy opt-in links (CAN-3383) open a confirmation sheet; receipt never
  // saves. Older links without parameters still arrive as a bare Settings open.
  useEffect(() => {
    return window.api.onDeepLinkPrivacyOptInOpen((request) => {
      useNavigationStore.getState().openPrivacyOptIn(request);
    });
  }, []);

  // Activation campaign notification click (CAN-1967). Main buffers the
  // payload until a renderer exists, so this can fire immediately after a
  // cold start that the click itself triggered.
  useEffect(() => {
    return window.api.onActivationCampaignNavigate((event) => {
      const navigation = useNavigationStore.getState();
      switch (event.destination.kind) {
        case 'canopy-portal':
          navigation.openCanopyPortal();
          return;
        case 'add-workspace':
          navigation.openAddWorkspaceModal();
          return;
        case 'settings':
          // Campaign account steps name what they are about, so they follow
          // that content to its hosted page when hosted settings are on.
          if (event.destination.section !== 'account') {
            navigation.openSettings(event.destination.section);
          } else if (event.destination.target === 'integrations') {
            openIntegrationSettings();
          } else {
            openCloudAccountSettings();
          }
          return;
        case 'plugins-discovery':
          // An explicit intent, not `navigate('plugins')`: the bare form
          // leaves a pending intent in place, so a stale app-only filter
          // would hide the skills and plugins this step points at.
          navigation.openPluginsNavigation({ kind: 'discovery' });
          return;
        case 'page':
          navigation.navigate(event.destination.page);
          return;
      }
    });
  }, []);

  // CAN-2415 follow-up: running the pointer into the window's left edge
  // reveals the hidden sidebar, the same overlay the titlebar toggle's hover
  // opens. It is the edge-slam gesture rather than an aimed one, so the
  // sidebar can be consulted from anywhere in the window.
  //
  // Only mounted while the sidebar is actually hidden, and never while
  // Settings owns the window (it expects a static sidebar and releases any
  // live preview), so the listener does not exist in the states where it could
  // only no-op.
  useEffect((): (() => void) | undefined => {
    if (sidebarPageOpen || !sidebarHidden) return undefined;
    return startSidebarEdgeHoverWatch();
  }, [sidebarPageOpen, sidebarHidden]);

  usePipelineCompletionToasts();
  useTerminalActivitySubscription();
  useTerminalCompletionToasts(navigate);

  // Early access: the sidebar and the top bar sit on the window, and the work
  // area below them is one inset card (see the inset layout in globals.css).

  // Before any worktree layout loads: under early access the Side Panel can
  // be emptied and narrows further, so it never runs past the window edge.
  useLayoutEffect(() => {
    setFixedSidePanelTabsClosable(true);
  }, []);

  if (!appReady) {
    return <AppLoadingScreen />;
  }

  // Blocking first-run legal gate, evaluated before every other gate and
  // independent of feature flags. `null` = preferences still loading (keep the
  // loading screen up so the shell never flashes before the decision is made);
  // `false` = not yet accepted, so block the shell entirely until the user
  // agrees to the Terms of Service / Privacy Policy.
  if (legalConsentAccepted === null) {
    return <AppLoadingScreen />;
  }
  if (!legalConsentAccepted) {
    return (
      <Suspense fallback={<AppLoadingScreen />}>
        <LegalConsentGate
          onAccepted={(): void => setLegalConsentAccepted(true)}
        />
      </Suspense>
    );
  }

  if (firstRunIdentityGateActive) {
    // Keep the loading screen up until the account state resolves so the shell
    // never flashes before the gate decision is made.
    if (cloudConnected === null) {
      return <AppLoadingScreen />;
    }
    if (
      cloudSignInWallActive &&
      (cloudConnected === false || cloudSignInWallAwaitingCompletion)
    ) {
      // Account-change broadcasts happen before the privacy prompt completes,
      // so a connected account alone cannot release this wall.
      return (
        <Suspense fallback={<AppLoadingScreen />}>
          <CloudSignInGate
            onConnected={() => {
              setCloudSignInWallAwaitingCompletion(false);
              setCloudConnected(true);
            }}
          />
        </Suspense>
      );
    }
    if (cloudConnected === false) {
      if (guestModeEnabled) {
        // A guest is minted silently (see the silent-mint effect above) — no
        // interstitial. Hold the loading screen until it connects, unless
        // consent is already recorded (offline-deferred), in which case open the
        // shell and let the retry effect finish minting in the background.
        if (!guestConsentSatisfiesGate) {
          return <AppLoadingScreen />;
        }
      }
    }
  }

  // The remote access host stays mounted behind the startup screens: in a
  // window showing another computer, the Git gate's Browse is answered with a
  // file picker from that computer, and only this host can show it.
  if (startupView === 'loading') {
    return (
      <>
        <AppLoadingScreen />
        <RemoteAccessHost />
      </>
    );
  }
  if (startupView === 'git-gate') {
    return (
      <>
        <WindowsGitRequiredScreen
          state={gitGate.state}
          onRecheck={gitGate.recheck}
          onBrowse={gitGate.browse}
          onAutoInstall={gitGate.autoInstall}
          onContinue={gitGate.dismiss}
          onCancelInstall={gitGate.cancelInstall}
        />
        <RemoteAccessHost />
      </>
    );
  }

  const reserveTitlebarTrafficLights =
    shouldReserveSidebarTrafficLightRegion(localPlatform());

  // The icon-only New Task control exists only to replace the sidebar's own
  // full-width New Task button while the sidebar is away. A hover preview
  // brings that button back on screen, so the titlebar stand-in fades out for
  // the duration rather than duplicating it. The corner's reserved width still
  // follows `sidebarHidden`, so nothing shifts as it fades.
  // Keyed on `previewing`, deliberately NOT on the presented state: the
  // control must come back the instant the preview is dismissed. Gating it on
  // the presentation release held it hidden for the whole slide-out, which
  // read as a lag. The brief overlap with the sidebar's own New Task while the
  // panel fades away is the accepted trade-off for a responsive control.
  const showCollapsedCreateTask = sidebarHidden && !sidebarPreviewing;
  // At a narrow sidebar the docked titlebar's last control (Resources, or the
  // activity bell) sits in New Task's seat. That control is only ever cut by
  // the sidebar's moving edge, so New Task is cut by the same edge from the
  // other side: the seat changes hands in the frame the edge crosses it, with
  // no frames where both icons are drawn or neither is. An opacity fade on
  // its own timer overlapped the two on hide and left the seat empty on show.
  // The edge is animated as a typed custom property on the aside's exact
  // lengths and curve; see `.titlebar-create-task-seat`.
  const createTaskSeatStyle: CSSProperties &
    Record<'--titlebar-seat-edge' | '--titlebar-seat-left', string> = {
    '--titlebar-seat-edge': sidebarDockedEdgeCss(
      reserveTitlebarTrafficLights,
      sidebarHidden,
      sidebarWidth,
    ),
    '--titlebar-seat-left': titlebarCreateTaskLeftCss(
      reserveTitlebarTrafficLights,
    ),
  };
  // Pages with a worktree or chat top bar keep that bar on the window and
  // card the panel grid under it. Every other page is one card that keeps the
  // same top bar row, empty, so it starts where a worktree's grid does.
  const mainFrame =
    appAdvisorDocked ||
    visiblePage === 'main' ||
    visiblePage === 'kanban' ||
    visiblePage === 'chat'
      ? 'split'
      : visiblePage === 'home'
        ? 'card-below-bar'
        : 'card';

  return (
    <div
      className="app-window-material relative flex h-screen w-screen overflow-hidden fg-primary"
      data-window-layout={'inset'}
      // With the sidebar hidden the cards' left edge is the window's: the
      // inset layout gives them the same 4px there as on the right and bottom.
      data-sidebar-hidden={sidebarHidden ? 'true' : undefined}
    >
      <div
        inert={mainShellCovered}
        aria-hidden={mainShellCovered || undefined}
        className="relative h-full shrink-0"
        data-page-active={mainShellCovered ? 'false' : 'true'}
        data-testid="app-sidebar-page"
      >
        <AppSidebar
          // On the Orchestrator page only its row is selected.
          activePage={appAdvisorDocked ? 'main' : activePage}
          onNavigate={(page) => {
            if (appAdvisorDocked) useAppAdvisorStore.getState().closeDialog();
            dispatchUiAction({ type: 'navigation.go_to_page', page });
          }}
          onReturnToSectionRoot={returnToSectionRoot}
          onSettingsClick={() =>
            dispatchUiAction({ type: 'navigation.open_settings' })
          }
          settingsOpen={sidebarPageOpen}
          onCanopyPortalClick={() =>
            dispatchUiAction({ type: 'canopy_portal.open' })
          }
          canopyPortalEnabled={canopyPortalEnabled}
          ledgerEnabled={ledgerEnabled}
          claudeTuiWorkersEnabled={claudeTuiWorkersEnabled}
          // With the Orchestrator page experiment the row opens it as a page
          // here, in the normal chat layout; ⌘L and agent requests keep the
          // floating panel.
          onAppAdvisorClick={() => {
            if (orchestratorPageEnabled) {
              useAppAdvisorStore.getState().openDocked();
            } else {
              dispatchUiAction({ type: 'app_advisor.open' });
            }
          }}
          appAdvisorOpen={appAdvisorOpen}
          appAdvisorThinking={appAdvisorThinking}
          appAdvisorUnread={appAdvisorUnread}
          workersActive={workersActive}
        />
      </div>
      <div
        inert={mainShellCovered}
        aria-hidden={mainShellCovered || undefined}
        className={`relative flex min-w-0 flex-1 flex-col bg-base ${mainShellCovered ? 'invisible' : ''}`}
        data-testid="app-main-shell"
      >
        {localPlatform() === 'darwin' && (
          <div
            className="electron-drag absolute inset-x-0 top-0 h-10"
            data-testid="app-main-titlebar-drag-region"
          />
        )}
        <Suspense
          fallback={
            // The inset layout keeps the page's card while it loads.
            <main
              className="relative flex min-w-0 flex-1"
              data-main-frame={mainFrame}
              data-testid="app-main-loading"
            >
              <DelayedLoadingPlaceholder className="flex-1">
                <CenteredLoadingSpinner />
              </DelayedLoadingPlaceholder>
            </main>
          }
        >
          {/* Session replay: the active page's classification
              (`NAVIGATION_PAGE_REPLAY_PRIVACY`). This long-lived element
              toggles the block, which is safe only while every blocked page
              is one users never see here (the internal galleries, and the
              aliases `mcp-account-connections` and `environments`, which
              open another destination instead). A
              user-facing `blocked` page must carry the block on its own root,
              which mounts with its content. */}
          <main
            className={
              mainReplayBlockClass
                ? `${mainReplayBlockClass} relative flex-1 min-w-0 overflow-auto`
                : 'relative flex-1 min-w-0 overflow-auto'
            }
            data-main-frame={mainFrame}
          >
            {/* A worktree started, repaired, joined, archived or deleted
                from the sidebar can fail while another page shows: the
                failure is a card in the window's toast stack. */}
            <WorktreeErrorNotice />
            <div
              className={
                !appAdvisorDocked &&
                (visiblePage === 'main' || visiblePage === 'kanban')
                  ? 'h-full w-full'
                  : 'hidden'
              }
              data-main-page-hidden={
                !appAdvisorDocked &&
                (visiblePage === 'main' || visiblePage === 'kanban')
                  ? undefined
                  : 'true'
              }
            >
              <MainPage />
            </div>
            {appAdvisorDocked && <AppAdvisorDockPage />}
            {/* Keyed so a section returning to its root from the sidebar
                mounts fresh. Entering Customize from another page restores
                where it was left (CAN-4267); its root return clears that. */}
            {/* The Orchestrator page stands in for every other page while it
                shows. They stay mounted, hidden, so leaving it returns to
                them as they were, and no page's teardown (a Cowork chat
                restoring the previous selection) reads as navigation. */}
            <div
              className={appAdvisorDocked ? 'hidden' : 'contents'}
              data-testid="app-pages"
              // Hidden like the worktree page above: the inset frame rules
              // skip what a hidden page holds (styles/globals.css).
              data-main-page-hidden={appAdvisorDocked ? 'true' : undefined}
            >
              <Fragment key={sectionRootRequest}>
                {visiblePage === 'overview' && <OverviewPage />}
                {visiblePage === 'home' && <HomePage />}
                {visiblePage === 'chat' && <StandaloneChatPage />}
                {visiblePage === 'cloud-chat' && <CloudChatPage />}
                {visiblePage !== null && isWorkflowsTabId(visiblePage) && (
                  <WorkflowsPage tab={visiblePage} />
                )}
                {visiblePage === 'plugins' && (
                  <PluginsPage
                    onOpenAccountSettings={() => {
                      dispatchUiAction({
                        type: 'canopy_portal.open_account_settings',
                      });
                    }}
                  />
                )}
                {visiblePage === 'audit' && <AuditTrailPage />}
                {visiblePage !== null && isDevPage(visiblePage) && (
                  <DevPagesShell
                    page={visiblePage}
                    onNavigate={(page) =>
                      dispatchUiAction({ type: 'navigation.go_to_page', page })
                    }
                  >
                    {visiblePage === 'notice-states' && (
                      <NoticeStateGalleryPage />
                    )}
                    {visiblePage === 'header-states' && (
                      <HeaderStateGalleryPage />
                    )}
                    {visiblePage === 'worktree-states' && (
                      <WorktreeStateGalleryPage />
                    )}
                    {visiblePage === 'activity-states' && (
                      <ActivityStateGalleryPage />
                    )}
                    {visiblePage === 'message-bubble-states' && (
                      <MessageBubbleStateGalleryPage />
                    )}
                    {visiblePage === 'change-review' && <ChangeReviewPage />}
                  </DevPagesShell>
                )}
                {visiblePage === 'statistics' && <StatisticsPage />}
                {visiblePage === 'usage' && <UsagePage />}
                {visiblePage === 'workers' && <WorkersPage />}
                {visiblePage === 'feed' && <FeedPage />}
              </Fragment>
            </div>
          </main>
        </Suspense>
        {/* Floating overlay, not a flow row: this host exists only for small
            app-status chips (currently the wake-lock indicator), and reserving
            a full-width strip under the panel grid for them pushed the whole
            app up whenever one appeared. It sizes to its content (zero when
            idle) and `pointer-events` is re-enabled per child so the empty
            host never eats clicks meant for the panel chrome beneath it.
            Anchored to the shell's bottom-right corner like a quiet persistent
            toast, floating above whatever panel content is there: a centered
            placement visually sat inside the collapsed terminal tab strip and
            read as one of its controls. Nothing reserves space for it on
            purpose; it overlaps content the way a toast does, and the chip is
            small enough that the corner control it may cover (an Activity
            card action, or the composer's send button when chat is rightmost)
            stays reachable around it.
            `z-30` is the context-local top tier (the shell is the positioned
            ancestor), so the chip paints above panel content but under every
            viewport overlay (dialogs, menus, tooltips), which start at
            `z-sticky`. */}
        <div
          id={APP_BOTTOM_STATUS_HOST_ID}
          className="electron-no-drag pointer-events-none absolute right-3 bottom-3 z-30 flex items-center justify-end gap-3 [&>*]:pointer-events-auto"
          data-testid="app-bottom-status"
        />
      </div>
      <Suspense fallback={null}>
        <SettingsOverlay
          open={settingsOpen}
          onClose={closeSettings}
          initialSection={settingsInitialSection}
        />
      </Suspense>
      {/* After Settings, which a report started from Settings must cover. */}
      {memoryReportActive && (
        <Suspense fallback={null}>
          <MemoryReportOverlay />
        </Suspense>
      )}
      {commandPaletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            initialQuery={commandPaletteInitialQuery}
            onClose={closeCommandPalette}
          />
        </Suspense>
      )}
      {appAdvisorQuickPromptOpen && (
        <Suspense fallback={null}>
          <AppAdvisorQuickPromptModal onClose={closeAppAdvisorQuickPrompt} />
        </Suspense>
      )}
      <SurfaceFindHost />
      {/* Early access: the shadow under the floating App Advisor panel, and
          the bubble it folds into when minimized. */}
      <AppAdvisorPanelShadow />
      <AppAdvisorMinimizedBubble running={appAdvisorThinking} />
      {fileSearchPaletteOpen && (
        <Suspense fallback={null}>
          <FileSearchPalette
            initialQuery={fileSearchPaletteInitialQuery}
            onClose={closeFileSearchPalette}
          />
        </Suspense>
      )}
      {prPickerOpen && (
        <Suspense fallback={null}>
          <PrPicker options={prPickerOptions} onClose={closePrPicker} />
        </Suspense>
      )}
      {canopyPortalOpen && remoteControlAvailable && (
        <Suspense fallback={null}>
          <CanopyPortalModal
            onClose={closeCanopyPortal}
            onOpenAccountSettings={() => {
              dispatchUiAction({ type: 'canopy_portal.open_account_settings' });
            }}
            onRequestSignIn={() => {
              // Route through the shared cloud connect gate (CAN-936, WS3). The
              // Portal modal stays mounted underneath, so once connected it
              // recomputes cloudReady on CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT and
              // advances to the Enable state — no Settings trip, no restart. We
              // re-open the Portal modal in `proceed` in case it was dismissed
              // meanwhile.
              useCloudConnectGateStore.getState().requestConnect(
                {
                  title: REMOTE_CONTROL_LABEL,
                  subtitle: `Sign in to ${brandText.appName} Cloud to enable ${REMOTE_CONTROL_LABEL}.`,
                  toastMessage: `You're connected. You can now enable ${REMOTE_CONTROL_LABEL}.`,
                },
                () => {
                  useNavigationStore.getState().openCanopyPortal();
                },
              );
            }}
          />
        </Suspense>
      )}
      {/*
        The one compatibility host for pipeline runs without a workspace
        owner; every owned run opens in its own pipeline-execution panel.
      */}
      {pipelineCompatDetailOpen && (
        <Suspense fallback={null}>
          <PipelineExecutionCompatHost />
        </Suspense>
      )}
      <ImportPlanModalHost />
      <ChatShareHost />
      <SkillSuggestionsModal />
      <WatcherModalHost />
      <AddWorkspaceModalHost />
      <AutomationInstallContinuationHost />
      <UsageLimitResumeModal />
      <ResumeQueueModal />
      <CloneProgressModal />
      <ShareSessionStatusModal />
      <RunCommentsModalHost />
      <ImportSessionModalHost />
      <ImportProjectsModalHost />
      <ImportProjectsInvite />
      <RepoRulesModalHost />
      <ScriptActionsDesktopHost />
      <Suspense fallback={null}>
        <SplitPreflightModalHost />
      </Suspense>
      <Suspense fallback={null}>
        <FileTabCloseGuard />
      </Suspense>
      {/*
        The App Advisor is no longer rendered as a top-most overlay in the
        main window. Its UI (transcript, composer, ask-user cards) lives
        in the standalone App Advisor BrowserWindow (see
        `AppAdvisorWindowApp` mounted via `?surface=app-advisor`). The
        main renderer keeps only the runtime bridge so UI-state and
        dispatch-action renderer-tool requests can be serviced here.
      */}
      <AppAdvisorMainRuntimeBridge />
      {/* Mounted at the App root (not inside the lazily/conditionally rendered
          PipelinesPage) so pipeline-editor renderer-tool requests are serviced
          even when the user navigates away mid-turn. Reads the page/editor
          controllers from the bridge store, and tool calls can bring the
          Pipelines page online when those controllers are not mounted yet. */}
      <PipelineEditorRuntimeBridge />
      {/* Shared cloud connect gate (CAN-936, WS3): a single modal instance that
          any contextual sign-in prompt drives via `useCloudConnectGateStore`, so
          prompts never stack their own sign-in modals. */}
      <CloudConnectGate />
      <ShareInstallModalHost />
      <DataSharingOptInSheetHost />
      <PublicShareDispatchHost />
      <BranchFromConfirmationModalHost />
      <BaseBranchChangeConfirmationModalHost />
      <CommitMessageReviewModalHost />
      <GitHubConnectOfferHost />
      <ReleaseHighlightsHost ready={startupUnlockReady} />
      <RemoteAccessHost />
      <div
        className={getInAppNotificationContainerClasses(
          inAppNotificationPlacement,
          {
            // The notification stack starts top corners below the header.
            clearHeader: true,
          },
        )}
        // The corner's own `z-toast` class must not freeze a Browser page
        // under it: each child below decides for itself (nearest marker wins).
        data-canopy-browser-native-overlay="false"
      >
        {/* Nudge and banner are mutually exclusive by gate (guest vs
            signed-in), so they never stack. Toasts render last, so with the
            bottom placements they sit nearest the screen edge as the
            transient layer; the container is `flex-col` for all four corners,
            so under the top placements they sit below the banner instead.
            The one suggestion corner (CAN-4343) shows at most one
            event-driven offer at a time: the notification offer, the
            repeated-task automation offer, or the skill-share nudge.

            The withheld-file count used to render here too. It only ever had a
            value while a share was mounted — the same moments the recipient
            surface shows its own disclosure — so it was a second, less
            informative copy of a message already on screen: it named a count
            but never the reasons (CAN-2551). */}
        {/* The banners stay in this document and still freeze a Browser
            page they cover; `empty:hidden` keeps the corner's gap unchanged
            while none shows. */}
        <div
          className="flex flex-col gap-2 empty:hidden"
          data-canopy-browser-native-overlay="true"
        >
          {/* While another computer controls this one; persistent until the
              session ends, so it sits above the transient layers. */}
          <RemoteAccessControlledNotice />
          {/* The top standing condition, until it recovers. */}
          <Suspense fallback={null}>
            <DesktopStandingConditions />
          </Suspense>
          <WorkspaceRecoveryNotice />
          <GuestUpgradeNudge />
          <OsNotificationOfferProducer />
          <RepeatTaskOfferProducer />
          <SuggestionCorner />
          <Suspense fallback={null}>
            <MobileAppCtaBanner />
          </Suspense>
        </div>
        {/* Over a live Browser page the toasts move into a native overlay
            layer above it, so the page keeps running under them. */}
        {/* Pins its warning card into the toast stack below until the
            background service is reached again or the card is closed. */}
        <BackgroundServiceUnavailableNotice />
        <OverlayLayerSlot
          slot="notifications"
          placement={inAppNotificationPlacement}
        >
          <ToastContainer placement={inAppNotificationPlacement} />
        </OverlayLayerSlot>
        <ScriptFailureOutputModal />
      </div>
      {/*
        Persistent titlebar corner: the ONE sidebar toggle, at constant window
        coordinates in both states, over a surface that keeps content from
        showing behind the macOS window controls while the sidebar changes
        state. The shell is pointer-transparent and explicitly `no-drag`: the
        titlebar beneath it already owns window dragging, while this later layer
        must not cover the adjacent New Chat control when the sidebar is
        collapsed. Only the corner's actual controls opt back into pointer
        events.
      */}
      {!sidebarPageOpen && (
        <div
          className={`sidebar-instant-interactions electron-no-drag pointer-events-none absolute left-0 top-0 flex h-10 items-center gap-1 overflow-visible ${
            // The revealed sidebar uses the shared sticky-chrome tier so page overlays cannot hide
            // it; the corner must out-rank that for as long as the panel is on
            // screen or the toggle is buried under the sidebar it controls.
            // Outside the preview it returns to its context-local z-30, leaving modal and
            // overlay stacking elsewhere exactly as it was.
            sidebarPreviewPresented ? 'z-sticky' : 'z-30'
          } ${
            // Same handover rule as the sidebar and the header spacer: pinning
            // a revealed preview commits the docked geometry in one frame, so
            // the corner must not animate its width alongside them.
            !sidebarHidden && sidebarPreviewSlidIn
              ? ''
              : 'sidebar-layout-transition transition-[width,background-color] duration-200 ease-in-out'
          } ${
            // Collapsed: transparent, so the page's own background (including
            // gradient surfaces like Home) shows through with no sidebar-tinted
            // box around the window controls. Expanded: a solid fallback outside
            // macOS, but transparent over the already-frosted sidebar on macOS so
            // the tint and blur are not applied twice.
            sidebarHidden ? 'bg-transparent' : 'app-sidebar-titlebar-surface'
          }`}
          style={{
            width: titlebarCornerWidthCss(
              reserveTitlebarTrafficLights,
              sidebarHidden,
            ),
            paddingLeft: titlebarToggleLeadingCss(reserveTitlebarTrafficLights),
            // The macOS window buttons are fixed-size OS chrome the page zoom
            // cannot reach, so the row that reads as one line with them holds
            // their physical centre instead of riding the zoom. The outer
            // `h-10` still zooms, so nothing below the titlebar moves.
            paddingTop: titlebarRowPaddingTopCss(reserveTitlebarTrafficLights),
            paddingBottom: titlebarRowPaddingBottomCss(
              reserveTitlebarTrafficLights,
            ),
          }}
          // Leave handling lives on the CORNER, not on the toggle alone: the
          // history arrows and New Task are separate pointer-events islands,
          // so a toggle-only handler returns early when the pointer lands on a
          // sibling and then never hears about the pointer leaving the corner
          // for good. `pointerout` bubbles from those children, so this fires
          // even though the corner shell itself is pointer-events-none.
          onPointerOut={(event): void => {
            const next = event.relatedTarget;
            if (
              next instanceof Element &&
              next.closest(
                '[data-testid="app-sidebar"], [data-testid="app-titlebar-corner"]',
              ) !== null
            ) {
              return;
            }
            requestSidebarPreviewClose({
              unknownDestination: next === null,
              pointer: { x: event.clientX, y: event.clientY },
            });
          }}
          data-testid="app-titlebar-corner"
        >
          <span
            className="pointer-events-auto inline-flex shrink-0"
            // CAN-2415: hovering or keyboard-focusing the collapsed-state
            // toggle temporarily previews the sidebar as an overlay; clicking
            // still pins it open (the store clears the preview on pin). Touch
            // pointers keep plain click behavior, and pointer *enter* (not
            // move) means a click-to-hide with a stationary pointer never
            // instantly re-opens the preview.
            onPointerEnter={(event): void => {
              if (event.pointerType === 'touch') return;
              requestSidebarPreviewOpen({ immediate: true });
            }}
            onFocus={(event): void => {
              if (
                event.target instanceof Element &&
                event.target.matches(':focus-visible')
              ) {
                requestSidebarPreviewOpenFromFocus();
              }
            }}
            onBlur={(event): void => {
              // Same rule as the panel: focus leaving the toggle is only a
              // close signal when the pointer is not still on it or in the
              // revealed sidebar.
              if (event.currentTarget.matches(':hover')) return;
              const next = event.relatedTarget;
              if (
                next instanceof Element &&
                next.closest('[data-testid="app-sidebar"]') !== null
              ) {
                return;
              }
              requestSidebarPreviewClose();
            }}
          >
            <SidebarToggleButton
              hidden={sidebarHidden}
              onToggle={toggleSidebarHidden}
            />
          </span>
          <NavigationHistoryButtons />
          {/* The seat clip and the preview fade live on this host span, not
              the button, so the button keeps the shared titlebar
              color/background transitions and the sidebar's
              instant-interaction scope cannot zero them. */}
          <span
            data-testid="titlebar-create-task-fade"
            className={`titlebar-create-task-seat inline-flex shrink-0 ${
              // Same handover rule as the sidebar: pinning a revealed preview
              // commits the docked geometry in one frame.
              !sidebarHidden && sidebarPreviewSlidIn
                ? 'titlebar-create-task-seat-instant'
                : ''
            } ${sidebarPreviewing ? 'opacity-0' : 'opacity-100'} ${
              showCollapsedCreateTask
                ? 'pointer-events-auto'
                : 'pointer-events-none'
            }`}
            style={createTaskSeatStyle}
          >
            <TitlebarIconButton
              onClick={() =>
                dispatchUiAction({
                  type: 'navigation.go_to_page',
                  page: 'home',
                })
              }
              icon={EditBigIcon}
              aria-label="New task"
              tooltipLabel="New task"
              aria-hidden={!showCollapsedCreateTask}
              tabIndex={showCollapsedCreateTask ? 0 : -1}
              data-testid="titlebar-create-task"
            />
          </span>
        </div>
      )}
    </div>
  );
}

export default App;
