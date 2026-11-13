import { create, type StateCreator } from 'zustand';
import {
  normalizeMarketplaceNavigation,
  marketplaceManagementDestination,
} from '@canopy/ui-shared/lib';
import type { SettingsSection } from '@/components/settings/SettingsNav';
import type { SettingsRoute } from '@canopy/protocol/settings';
import {
  hostedSettingsLocation,
  ORGANIZATIONS_LIST_LOCATION,
  pushHostedSettingsHistory,
  type HostedSettingsLocation,
  type HostedSettingsLocationOptions,
} from '@/components/settings/hosted/hosted-settings-location';
// Canonical declaration of `NavigationPage` lives in `@canopy/desktop-shared`
// so the App Advisor action union (which targets these pages) and the
// renderer's navigation store share a single source of truth. The renderer
// re-exports the alias from this module for backwards-compatible imports.
import { NAVIGATION_PAGE_MAP } from '@canopy/desktop-shared/types';
import { localAgentEntryId } from '@canopy/protocol/unified-entry';
import type { InstalledStatusFilterValue } from '@canopy/ui-shared/lib/installed-item-status';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from './featureFlagsStore';
import type {
  ArchivedContainerViewerTab,
  DataSharingOptInRequest,
  DeepLinkShareOpenEvent,
  NavigationPage as SharedNavigationPage,
  PluginsManagementSectionId,
  WorkflowEditSection,
} from '@canopy/desktop-shared/types';
import type { PrState } from '@canopy/desktop-shared/types/github';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import type {
  MarketplaceTypeTabId,
  PipelineFilterValues,
} from '@canopy/ui-shared/lib';
import {
  NAVIGATION_FALLBACK_PAGE,
  isPageAvailable,
  resolveNavigationTarget,
} from '@/lib/navigation/page-availability';
import {
  consumeLegacyCalendarPreference,
  peekLegacyCalendarPreference,
  resolveWorkflowsTarget,
} from '@/lib/navigation/workflows-target';
import { notifyPageSwitchedOff } from '@/lib/navigation/page-unavailable-toast';
import { resolveWorkflowEditBack } from '@/lib/workflows/edit-back';
import {
  isSameWorkflowEditItem,
  newWorkflowDraftKey,
  withWorkflowDraftKey,
  workflowEditKey,
  type AutomationDraftSeed,
  type WorkflowEditTarget,
  type WorkflowEditTargetCommon,
} from '@/lib/workflows/edit-target';
import { useWorkflowsViewStore } from './workflowsViewStore';
import { useWorkspaceContextStore } from './workspaceContextStore';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import type { InstalledSharedSkillTarget } from '@/lib/sharedSkillImport';
import { requestPipelineAssistantNewChat } from '@/lib/pipelineAssistantEvents';
import {
  createSidebarSectionRootRegistry,
  returnSidebarSectionToRoot,
} from '@canopy/ui-app/sidebar';

export type NavigationPage = SharedNavigationPage;

/**
 * What the Settings overlay shows: one of its own local sections, or a hosted
 * account or organization settings route (CAN-4386). Exactly one is current.
 */
export type SettingsDestination =
  | { readonly kind: 'local'; readonly section: SettingsSection }
  | { readonly kind: 'hosted'; readonly route: SettingsRoute };

export type { HostedSettingsLocation };

export interface OpenAccountOrganizationSettingsOptions extends HostedSettingsLocationOptions {
  /** Replace the current hosted destination instead of adding to Back. */
  readonly replace?: boolean;
  /**
   * Element id the hosted page scrolls to once it renders, like
   * `openSettings`'s `scrollTo`. Left untouched on an already-open overlay
   * when omitted, so a pending scroll from `openSettings` still fires.
   */
  readonly scrollTo?: string;
}

export type CapabilityMarketplaceTabId = MarketplaceTypeTabId;

export interface MarketplaceSourceReturnContext {
  readonly sourceId: string;
  readonly filters: {
    readonly query: string;
    readonly category: string | null;
    readonly author: string | null;
  };
}

/** Discovery state restored after viewing a capability on another page. */
export interface CapabilityMarketplaceReturnTarget {
  query: string;
  tab: CapabilityMarketplaceTabId;
  category?: string;
  focusSection?: 'installed' | 'shared-by-me';
  installedStatusFilter?: InstalledStatusFilterValue;
  installedExpanded?: boolean;
  pipelineFilters?: PipelineFilterValues;
  source?: MarketplaceSourceReturnContext;
}

/** In-memory Customize history; completed dialogs and mutations are never replayed. */
export interface PluginsPresentationLocation {
  readonly scrollTop?: number;
  readonly browseScrollTop?: number;
  readonly detailReturnScrollTop?: number;
  readonly categoryQuery?: string;
  readonly browse: CapabilityMarketplaceReturnTarget;
  readonly source?: MarketplaceSourceReturnContext;
  readonly entry?: {
    readonly id: string;
    readonly stack: string[];
    readonly fromInstalled: boolean;
    readonly skillFilePath?: string;
    readonly pipelineReturn?: PipelineReturnTarget;
    readonly browseReturn?: CapabilityMarketplaceReturnTarget;
  };
}

/** Source-aware pipeline locator used by related-item return paths (CAN-2382). */
export interface PipelineReturnTarget {
  pipelineId: string;
  cwd?: string;
  filePath?: string;
  /**
   * Stored-catalog namespace. Bundled and user pipelines can share an id and
   * bare-id lookups resolve user-before-bundled, so callers that know the
   * source include it to open the exact pipeline.
   */
  source?: 'bundled' | 'user' | 'curated';
  sharedRemoteId?: string;
  /** Capability detail that opened this pipeline, when one exists. */
  returnToEntryId?: string;
  /** Complete capability-detail history that opened this pipeline. */
  returnToEntryContext?: EntryDetailReturnContext;
  /** Earlier pipeline in a multi-hop recommendation chain. */
  returnToPipeline?: PipelineReturnTarget;
  /** Marketplace search state that originally opened this pipeline. */
  returnToMarketplace?: CapabilityMarketplaceReturnTarget;
}

/** Capability detail state restored after returning from a pipeline editor. */
export interface EntryDetailReturnContext {
  entryId: string;
  /** Entry ids behind `entryId`, ordered from oldest to newest. */
  stack: string[];
  /** Pipeline origin behind the oldest capability detail, when one exists. */
  pipelineReturn?: PipelineReturnTarget;
  /** Whether the detail was opened from installed inventory. */
  fromInstalled?: boolean;
  /** Management section restored when Back closes the reopened detail. */
  managementReturn?: PluginsManagementSectionId;
  /**
   * Marketplace browse state (query/tab/category) behind the detail. The
   * Plugins page unmounts while the pipeline editor is open, so the editor's
   * Back must carry this alongside the detail stack or closing the reopened
   * detail lands on a reset browse view (CAN-2780 review).
   */
  marketplace?: CapabilityMarketplaceReturnTarget;
}

export interface PipelineEditDeepLink {
  pipelineId: string | null;
  cwd?: string;
  filePath?: string;
  /** Stored-catalog namespace; see {@link PipelineReturnTarget.source}. */
  source?: 'bundled' | 'user' | 'curated';
  sharedRemoteId?: string;
  /**
   * The worktree `cwd` belongs to, when the opener knows it. A Workflows panel
   * in a pop-out window opens its own checkout's pipeline while the main
   * window may show another worktree, so the editor cannot derive it there.
   */
  worktree?: { projectId: string; worktreeId: string };
  /**
   * Plugins-page unified entry id that opened this pipeline (a related-item
   * click on a skill/plugin detail page, CAN-2382). When set, the pipeline
   * editor's Back returns to that entry's detail instead of the pipeline
   * list, preserving the cross-page navigation context.
   */
  returnToEntryId?: string;
  /** Full capability-detail stack to restore instead of a single entry id. */
  returnToEntryContext?: EntryDetailReturnContext;
  /**
   * Pipeline the user was viewing when they clicked a "Similar pipelines"
   * recommendation (CAN-2382). When set, the editor's Back reopens that
   * pipeline instead of returning to the list.
   */
  returnToPipeline?: PipelineReturnTarget;
  /** Marketplace search state that originally opened this pipeline. */
  returnToMarketplace?: CapabilityMarketplaceReturnTarget;
}

/**
 * Pending dispatch-modal open with a preselected pipeline (CAN-2361 PR2b):
 * the share landing's pipeline "Try now" stages the dispatch modal against
 * the selected worktree with the saved pipeline highlighted — the user still
 * explicitly clicks Run. Consumed by `PublicShareDispatchHost`.
 */
export interface PipelineDispatchDeepLink {
  pipelineId: string;
  projectId: string;
  worktreeId: string;
  /** Distinguishes repeat requests for the same pipeline. */
  nonce: number;
}

export interface AutomationEditDeepLink {
  activityId: string;
  /** Shell section to open; see {@link WorkflowEditTargetCommon.section}. */
  section?: WorkflowEditSection;
  /**
   * Run to select in the Runs section. A run no longer in the history still
   * opens Runs.
   */
  runId?: string;
  /** Item the shell's Back reopens instead of the Library. */
  returnTo?: WorkflowEditTarget;
}

/**
 * Request to show one just-installed or just-updated automation on the
 * Automations → Triggered tab (CAN-3651). `activityId` is the exact local
 * copy, never a share origin, so several copies of one share stay distinct.
 */
export interface AutomationRevealDeepLink {
  activityId: string;
  outcome: 'installed' | 'updated';
}

/** Where a request to install a shared resource came from (CAN-3710). */
export type ShareInstallOrigin = 'deep-link' | 'in-app';

/**
 * A shared resource waiting in the install review. A deep link from the web
 * and an in-app Add or Install open the same review; only `deep-link` installs
 * report the web handoff funnel.
 */
export interface PendingShareInstall {
  link: DeepLinkShareOpenEvent;
  origin: ShareInstallOrigin;
  /** Ephemeral UI intent: update the copy whose installed detail was opened. */
  skillTarget?: InstalledSharedSkillTarget;
}

/**
 * Request to show one local agent in the Marketplace Agents tab (CAN-3710,
 * CAN-4266): `highlight` opens its detail after an install, `edit` opens its
 * editor over that detail.
 */
export interface AgentRevealDeepLink {
  agentId: string;
  mode: 'highlight' | 'edit';
}

/** Request to mark one just-installed pipeline on Workflows → Library. */
export interface PipelineRevealDeepLink {
  pipelineId: string;
}

export interface AutomationSharedPipelineReviewDeepLink {
  activityId: string;
}

/**
 * Pending request to focus one user-authored turn inside a chat transcript
 * (ECW-8684). Deliberately generic — an automation run row is the first
 * caller, but nothing here is automation-specific.
 *
 * The caller is responsible for navigating to the surface that owns the chat
 * (worktree chat on `main`, cowork chat on `chat`, App Advisor through its
 * popout window) and for selecting the chat tab. This payload only carries
 * the intra-transcript target, which `ChatMessageList` consumes.
 *
 * `nonce` (the `pendingPipelineDispatch` idiom) makes re-clicking the same run
 * re-fire the scroll instead of being swallowed as an unchanged value.
 */
export interface ChatTurnFocusDeepLink {
  projectId: string;
  worktreeId?: string;
  chatId: string;
  userMessageId: string;
  /** Distinguishes repeat requests for the same turn. */
  nonce: number;
}

/**
 * Request to focus a freshly forked container once it is in the foreground
 * (CAN-4782). Keyed to the destination and the page that renders it, and
 * consumed by that destination's provenance notice only after focus lands.
 *
 * `nonce` comes from a counter that never resets, so a repeat request for the
 * same copy stays distinguishable after an earlier one was consumed, and an
 * old consumer cannot clear a newer request. `accountEpoch` drops a request
 * that outlived an account change.
 */
export interface ForkedContainerFocusRequest {
  projectId: string;
  worktreeId: string;
  page: 'main' | 'chat';
  accountEpoch: number;
  nonce: number;
}

export type SkillViewerDeepLink =
  | {
      kind: 'installed';
      sourceId: string;
      skillName: string;
      filePath?: string;
    }
  | { kind: 'shared'; skillId: string }
  // Legacy in-memory/persisted callers remain accepted during hydration.
  | { sourceId: string; skillName: string; filePath?: string };

/**
 * Where an `entry-detail` navigation came from, so the opened detail can
 * offer a Back affordance to the source (CAN-2382): another capability's
 * detail (seeds the Plugins-page detail stack) or a pipeline editor
 * (reopens that pipeline).
 */
export type EntryDetailReturnTarget =
  | { kind: 'entry'; entryId: string }
  | {
      kind: 'entry-context';
      stack: string[];
      pipelineReturn?: PipelineReturnTarget;
      /** Whether the detail was opened from installed inventory. */
      fromInstalled?: boolean;
      /** Management section restored when Back closes the reopened detail. */
      managementReturn?: PluginsManagementSectionId;
      /** Browse state to restore behind the reopened detail. */
      marketplace?: CapabilityMarketplaceReturnTarget;
    }
  | ({ kind: 'pipeline' } & PipelineReturnTarget);

export type PluginsNavigationIntent =
  | { kind: 'browse-apps' }
  | { kind: 'restore'; location: PluginsPresentationLocation }
  | { kind: 'marketplace-source'; target: 'list' }
  | {
      kind: 'marketplace-source';
      target: 'detail';
      sourceId: string;
      pluginKey?: string;
    }
  | ({ kind: 'marketplace-browse' } & CapabilityMarketplaceReturnTarget)
  /**
   * Open the unfiltered discovery view — the surface that browses and
   * installs skills, plugins, and apps. Distinct from `browse-apps`, which
   * pins `kindFilter` to `'app'` and therefore hides skills and plugins.
   * Used by the onboarding checklist's "Enable a skill or plugin" item, which
   * needs an explicit intent rather than a bare `navigate('plugins')`: the
   * bare form leaves any pending intent in place, so a stale `browse-apps`
   * would be consumed by the remounting page and land the user back on the
   * app-only filter this item exists to avoid.
   */
  | {
      kind: 'discovery';
      /**
       * Optional search prefill for the discovery view, so a caller that
       * could not complete an install itself (e.g. the Home onboarding
       * suggestions' Add fallback when the curated catalog has no match)
       * lands the user on the relevant results instead of the full browse.
       */
      searchQuery?: string;
    }
  | {
      kind: 'management';
      section: PluginsManagementSectionId;
      /**
       * Opens Installed with the Customize status filter applied (Settings'
       * Active summary opens it on Active, CAN-4255; any status, CAN-4838).
       */
      statusFilter?: InstalledStatusFilterValue;
    }
  /**
   * Open a unified discovery entry's detail surface by entry id (e.g.
   * `skill:<sourceId>:<name>`, `mkt:<marketplaceId>/<name>`,
   * `curated:<name>`). Used by related-item navigation from pipeline
   * surfaces and by the pipeline editor's return path (CAN-2382).
   */
  | {
      kind: 'entry-detail';
      entryId: string;
      mcpTarget?: {
        serverName: string;
        provider?: 'claude' | 'codex';
        requestId: string;
      };
      /**
       * `edit` opens a local agent's editor over its detail (CAN-4266); other
       * entries treat it as `view`.
       */
      intent?: 'view' | 'connect' | 'edit';
      from?: EntryDetailReturnTarget;
    };

export type WorkspaceSettingsInitialTab =
  | 'details'
  | 'repositories'
  | 'scripts'
  | 'hooks'
  | 'environment'
  | 'code-graph'
  | 'share'
  | 'start-page';

/**
 * Opens the code-project Start page tab in a specific mode. `prefill` seeds
 * the draft (the "Share with team" toast and share-sheet "Change" use it) so
 * the user only has to confirm. Omitted keeps the stored value.
 */
export interface StartPageSettingsIntent {
  mode: 'source' | 'local';
  prefill?: ProjectStartPage | null;
}

export interface WorkspaceSettingsDeepLink {
  workspaceId: string;
  initialTab?: WorkspaceSettingsInitialTab;
  /** Only read when `initialTab` is `'start-page'`. */
  startPage?: StartPageSettingsIntent;
  /**
   * Worktree context the settings were opened FROM (e.g. the worktree
   * header's project icon). Seeds the modal's source-worktree picker so the
   * "Default branch" selector starts on the branch you were looking at,
   * matching the scripts/hooks gear flow.
   */
  worktreeId?: string;
}

/**
 * Transient worktree-scoped request payload used by the sidebar's worktree-row
 * action menu to trigger a `WorktreeManager`-hosted modal (dispatch pipeline,
 * ad-hoc add-repo, drift details) without a direct component reference. Mirrors
 * the {@link WorkspaceSettingsDeepLink} consume pattern.
 */
export interface WorktreeActionRequest {
  projectId: string;
  worktreeId: string;
  deleteBranch?: boolean;
  expectedBranchName?: string;
  lockAfterArchive?: boolean;
  /** Ask main to delete outright only if it confirms the path is missing. */
  deleteWithoutRetentionIfMissing?: boolean;
}

export interface PrPickerOption {
  repoId: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prState: PrState;
}

export type PluginsTabDeepLink =
  | 'collections'
  | 'marketplace'
  | 'skills'
  | 'mcp';

interface NavigationState {
  activePage: NavigationPage;
  /** Marketplace category currently open inside the Plugins page. */
  pluginsBrowseSectionId: string | null;
  /**
   * Monotonic request consumed by the visible Home surface to focus its
   * composer. Incrementing instead of storing a boolean makes re-clicking New
   * Task while already on Home observable.
   */
  homeComposerFocusRequest: number;
  settingsOpen: boolean;
  settingsInitialSection?: SettingsSection;
  /**
   * Monotonic `openSettings` request, so re-requesting the section already
   * in {@link NavigationState.settingsInitialSection} (after the user moved
   * to another row) still reaches the open overlay.
   */
  settingsOpenRequest: number;
  /**
   * One-shot `data-testid` the Settings overlay scrolls to, focuses, and
   * briefly highlights after opening — for CTAs that target a control deep
   * inside a section (e.g. the onboarding Linear connect → the Linear token
   * input far down the Account section). Consumed by `SettingsOverlay`.
   */
  settingsScrollTarget?: string;
  /**
   * The Settings section currently DISPLAYED by `SettingsOverlay`, as opposed
   * to {@link NavigationState.settingsInitialSection}, which stays the
   * *requested* deep link.
   *
   * The two differ whenever the overlay redirects a request it cannot honor
   * (unsupported platform, unavailable Claude settings, disabled Canopy
   * Teams, an absent request), and those redirections can also resolve
   * asynchronously after mount. Only the overlay knows the outcome, so it
   * publishes the resolved value here after its own section state settles.
   *
   * Purely transient and never persisted: it is `null` whenever Settings is
   * closed, and it is reset to `null` when Settings (re)opens so the next
   * open never briefly re-reports the previous session's section.
   *
   * The renderer's synthetic screen-route projection is the only consumer
   * (see `lib/instrumentation/posthog-route-source.ts`); no UI reads it.
   */
  settingsActiveSection: SettingsSection | null;
  /**
   * The hosted account or organization settings destination on screen, or
   * `null` while a local section shows. Carries the page-owned query and
   * fragment. Transient: cleared whenever Settings closes or a local section
   * is opened.
   */
  settingsHostedLocation: HostedSettingsLocation | null;
  /** Earlier hosted destinations this Settings session, oldest first. */
  settingsHostedHistory: readonly HostedSettingsLocation[];
  commandPaletteOpen: boolean;
  commandPaletteInitialQuery: string;
  appAdvisorQuickPromptOpen: boolean;
  fileSearchPaletteOpen: boolean;
  fileSearchPaletteInitialQuery: string;
  prPickerOpen: boolean;
  prPickerOptions: PrPickerOption[];
  canopyPortalOpen: boolean;
  /**
   * Whether the App Advisor floating dialog is visible. The App Advisor is
   * a top-most overlay that intentionally does not displace other surfaces
   * (Settings, Canopy Portal, command palette, …), so other `open*` actions
   * leave this flag alone.
   */
  appAdvisorOpen: boolean;
  appAdvisorFocused: boolean;
  /**
   * Mirror of a main window existing, from the App Advisor window state.
   * Without one, App Advisor raises its own chat notifications.
   */
  appAdvisorMainWindowOpen: boolean;
  /**
   * Counts reports of the main window being unable to notify, so a delayed
   * App Advisor notification can tell its page went down and came back.
   */
  appAdvisorMainWindowDownCount: number;
  /**
   * The item the Workflows edit shell shows on the Library page (CAN-4072),
   * or unset for the Library list. It is live state, not a one-shot request:
   * the shell stays open until Back, another page, or another item replaces
   * it. Any update that moves to another page without setting a new target
   * clears it.
   */
  workflowEdit?: WorkflowEditTarget;
  /**
   * Counts {@link NavigationState.replaceWorkflowEdit} calls. The history
   * tracker compares it across updates to record a replaced target over the
   * current entry instead of pushing a new one. Nothing else reads it.
   */
  workflowEditReplaceCount: number;
  /**
   * Counts {@link NavigationState.returnToSectionRoot} calls that entered a
   * root fresh. The page host keys the open page on it, so a section
   * returning to its root from a deeper page mounts fresh, the same as
   * entering it from another page. A page already on its root resets in
   * place instead (see {@link desktopSectionRoot}).
   */
  sectionRootRequest: number;
  /**
   * Counts page requests: every write that names a page, including the page
   * already open. A request is navigation even when the page stays, which
   * the docked Orchestrator page leaves on (`lib/appAdvisorDockLeave.ts`).
   */
  pageRequestSeq: number;
  /** Curated catalog key consumed after the lazy Pipelines page mounts. */
  pendingCuratedPipelinePreviewKey?: string;
  pendingPipelineDispatch?: PipelineDispatchDeepLink;
  pendingWorkspaceSettings?: WorkspaceSettingsDeepLink;
  /**
   * True while a code-workspace settings modal is pending or mounted. The
   * onboarding workspace tour uses this to pause after repository creation so
   * Workspace Settings is not covered by the higher-z tour overlay.
   */
  workspaceSettingsModalOpen: boolean;
  /**
   * Transient request to reveal an installed or updated automation on the
   * Triggered tab. Set by {@link NavigationState.openAutomationReveal} and
   * cleared by {@link NavigationState.consumeAutomationReveal}. Never
   * persisted. The newest explicit request wins: opening a reveal closes the
   * edit shell, and opening the shell drops a pending reveal.
   */
  pendingAutomationReveal?: AutomationRevealDeepLink;
  /**
   * Transient request to select one run in an automation's Runs section,
   * staged by {@link NavigationState.openAutomationEdit} with a `runId` and
   * cleared by {@link NavigationState.consumeAutomationRunFocus}.
   */
  pendingAutomationRunFocus?: { activityId: string; runId: string };
  /**
   * Transient request to open the explicit shared-pipeline review modal for
   * one automation. Navigation may stage this request, but approval remains a
   * user click inside the modal.
   */
  pendingAutomationSharedPipelineReview?: AutomationSharedPipelineReviewDeepLink;
  /**
   * Transient request to scroll one chat transcript to a specific
   * user-authored turn, consumed exactly once by the `ChatMessageList` that
   * owns `chatId` (see {@link ChatTurnFocusDeepLink}).
   */
  pendingChatTurnFocus?: ChatTurnFocusDeepLink;
  /** See {@link ForkedContainerFocusRequest}. */
  pendingForkedContainerFocus?: ForkedContainerFocusRequest;
  /**
   * Open fork dialogs. A pending fork focus request waits while any is open,
   * so the dialog's own dismissal cannot take focus back from the copy.
   */
  forkedContainerFocusHolds: number;
  /**
   * Transient deep-link target for a skill's detail viewer on the Plugins
   * page's Skills tab. Window CustomEvents cannot reach that surface reliably —
   * both PluginsPage (lazy chunk) and SkillsTab (tab-gated) attach their
   * listeners only after they mount, so an event fired right after
   * `navigate('plugins')` can be dropped. This pending payload survives until
   * SkillsTab consumes it: PluginsPage reacts by switching to the Skills tab,
   * then SkillsTab opens the viewer and calls
   * {@link NavigationState.consumeSkillViewer}. Set by
   * {@link NavigationState.openSkillViewer} (Cmd+K palette skill rows).
   */
  pendingSkillViewer?: SkillViewerDeepLink;
  /** Durable destination consumed after the lazy Plugins page mounts. */
  pendingPluginsNavigation?: PluginsNavigationIntent;
  pluginsPresentation?: PluginsPresentationLocation;
  setPluginsPresentation: (location: PluginsPresentationLocation) => void;
  /**
   * The shared resource in the install review (CAN-3710): an OS share deep
   * link (`<scheme>://share/...`, CAN-2361) pushed from the main process after
   * startup unlock, or an in-app Add / Install. Parked here (same
   * survives-until-consumed pattern as
   * {@link NavigationState.pendingSkillViewer}) for the review to consume; set
   * by {@link NavigationState.openShareInstall} and cleared by
   * {@link NavigationState.consumeShareInstall}. Never persisted: a pending
   * install must not survive a restart.
   */
  pendingShareInstall?: PendingShareInstall;
  /**
   * A request that arrived while the review was writing. It replaces the
   * review only after the write settles, so an install is never unmounted
   * halfway (see {@link NavigationState.setShareInstallBusy}).
   */
  heldShareInstall?: PendingShareInstall;
  /** True while the install review is writing. */
  shareInstallBusy: boolean;
  /** Transient request to mark one pipeline on Workflows → Library. */
  pendingPipelineReveal?: PipelineRevealDeepLink;
  /**
   * The privacy opt-in confirmation being shown (CAN-3383), from a web link.
   * Receipt never saves: the sheet asks first. A different link arriving while
   * one is open waits in {@link NavigationState.queuedPrivacyOptIns}, so the
   * organization or feature under review is never silently replaced.
   */
  pendingPrivacyOptIn?: PendingPrivacyOptIn;
  queuedPrivacyOptIns: PendingPrivacyOptIn[];
  /**
   * Transient text seed for the Home composer (CAN-2361 v2 "Try now"): the
   * deep-link landing stages a starter prompt here when no worktree is
   * selected, and `HomeSurface` consumes it into the Slate editor via its
   * insert-command path. Nonce makes re-staging identical text observable
   * (same pattern as {@link NavigationState.homeComposerFocusRequest}).
   */
  pendingHomeComposerText?: { text: string; nonce: number };
  /**
   * Transient deep-link target for the Claude Workers page: the `workerId` of
   * a card that should receive a brief highlight ring once the page mounts.
   * Set by {@link NavigationState.openWorkers} (e.g. the pipeline "View worker"
   * button) and cleared by {@link NavigationState.consumeWorkerHighlight} after
   * the page applies the effect.
   */
  pendingWorkerHighlight?: string;
  addWorkspaceModalOpen: boolean;
  /**
   * Optional repo URL the Add Workspace modal seeds its Remote → URL input
   * with when it opens. Set by the Home branch picker's
   * "Add {owner}/{repo} as a project…" offer row (a foreign-repo PR URL that
   * matches no existing workspace) so the modal's existing local-reuse-or-clone
   * machinery takes over pre-filled. `null` for every other opener. Cleared on
   * modal close.
   */
  addWorkspaceInitialRepoUrl: string | null;
  addWorkspaceInitialProjectType: 'cowork' | 'single-repo' | null;
  /**
   * Transient request flag set by the sidebar's "Customize sidebar" item (or
   * App Advisor's `navigation.open_customize_sidebar` action) so `AppSidebar`
   * can open its existing `CustomizeSidebarModal` local state without an
   * external caller needing a direct reference to that component. Consumed
   * (cleared) once `AppSidebar` reacts to it.
   */
  customizeSidebarRequested: boolean;
  /**
   * Transient worktree-row action requests set by the sidebar's worktree
   * action menu. `WorktreeManager` (always mounted under `MainPage`) consumes
   * each one and opens the matching modal it hosts. Cleared on consume.
   */
  pendingDispatchPipeline?: WorktreeActionRequest;
  pendingAddRepoAdhoc?: WorktreeActionRequest;
  pendingSplitWorkspace?: WorktreeActionRequest;
  pendingDriftDetails?: WorktreeActionRequest;
  /**
   * Transient archive request set by the sidebar's worktree-row "Archive"
   * action. `WorktreeManager` (always mounted under `MainPage`) consumes it
   * and runs its local `requestArchiveWorktree`, which surfaces
   * `TeardownFailureDialog` on teardown failure instead of a toast-only
   * fallback. Cleared on consume.
   */
  pendingArchiveWorktree?: WorktreeActionRequest;
  navigate: (page: NavigationPage | 'agents') => void;
  /**
   * The current sidebar row's click (2026-10-22): returns `page`'s section to
   * its root, the same as entering it fresh, so a detail or an editor closes.
   * On the root itself a registered page only resets its tab and scroll, with
   * no remount (QA, 2026-10-23). Unlike {@link NavigationState.navigate} it asks the navigation guard even
   * when the page stays the same, so unsaved changes are confirmed first.
   */
  returnToSectionRoot: (page: NavigationPage) => void;
  setPluginsBrowseSectionId: (sectionId: string | null) => void;
  openSettings: (
    section?: SettingsSection,
    options?: { scrollTo?: string },
  ) => void;
  /** Clears {@link NavigationState.settingsScrollTarget}. */
  consumeSettingsScrollTarget: () => void;
  /**
   * Publishes the section `SettingsOverlay` is actually displaying, or `null`
   * while Settings is closed. Called only by the overlay — see
   * {@link NavigationState.settingsActiveSection}.
   */
  setSettingsActiveSection: (section: SettingsSection | null) => void;
  /**
   * Opens Settings on a hosted account or organization settings route, or
   * moves the open overlay there. `openSettings` callers keep their local
   * sections (`openSettings('account')` is the local Accounts section, shown
   * as Providers in the hosted layout). Content that moved to hosted pages
   * opens through `lib/navigation/settings-destinations.ts`.
   */
  openAccountOrganizationSettings: (
    route: SettingsRoute,
    options?: OpenAccountOrganizationSettingsOptions,
  ) => void;
  /**
   * Contextual return inside hosted settings: the previous hosted destination
   * this session, or the Organizations list.
   */
  backAccountOrganizationSettings: () => void;
  /** Leaves hosted settings for the overlay's local section. */
  showLocalSettingsSection: () => void;
  closeSettings: () => void;
  openCommandPalette: (initialQuery?: string) => void;
  closeCommandPalette: () => void;
  openAppAdvisorQuickPrompt: () => void;
  closeAppAdvisorQuickPrompt: () => void;
  openFileSearchPalette: (initialQuery?: string) => void;
  closeFileSearchPalette: () => void;
  openPrPicker: (options: PrPickerOption[]) => void;
  closePrPicker: () => void;
  openCanopyPortal: () => void;
  closeCanopyPortal: () => void;
  /**
   * Reveal the App Advisor surface. When a `chatId` target is supplied the
   * dedicated App Advisor window is opened focused on that chat's tab (the
   * App-Advisor analog of {@link useChatStore}'s `switchTab`); otherwise the
   * surface is simply revealed.
   */
  openAppAdvisor: (target?: {
    chatId?: string;
    workEntryId?: string;
    archivedContainer?: {
      containerId: string;
      tab?: ArchivedContainerViewerTab;
      chatId?: string;
      planId?: string;
    };
  }) => void;
  closeAppAdvisor: () => void;
  toggleAppAdvisor: () => void;
  openWorkers: (workerId?: string) => void;
  consumeWorkerHighlight: () => void;
  /**
   * Opens the edit shell on `target`. A target with the key already shown
   * only moves to its `section`, without asking or remounting; any other
   * target asks the navigation guard first.
   */
  openWorkflowEdit: (target: WorkflowEditTarget) => void;
  /**
   * The shell's Back: asks the guard, then goes where
   * `resolveWorkflowEditBack` says (another item, the Library, or a Plugins
   * destination).
   */
  closeWorkflowEdit: () => void;
  /**
   * Swaps the shown target without asking, and records it over the current
   * history entry. For a draft that got its saved id, a fresh duplicate, and
   * history restore. `null` returns to the Library list.
   */
  replaceWorkflowEdit: (target: WorkflowEditTarget | null) => void;
  /** Moves the open shell to `section`; a no-op with no shell open. */
  setWorkflowEditSection: (section: WorkflowEditSection) => void;
  /** {@link NavigationState.openWorkflowEdit} for a pipeline locator. */
  openPipelineEdit: (
    link: PipelineEditDeepLink,
    options?: WorkflowEditTargetCommon,
  ) => void;
  openCuratedPipelinePreview: (key: string) => void;
  consumeCuratedPipelinePreview: () => void;
  openPipelineDispatch: (link: Omit<PipelineDispatchDeepLink, 'nonce'>) => void;
  consumePipelineDispatch: () => void;
  /** {@link NavigationState.openWorkflowEdit} for a saved automation. */
  openAutomationEdit: (link: AutomationEditDeepLink) => void;
  /** Opens the shell on a new automation draft with a fresh draft key. */
  openAutomationDraft: (seed?: AutomationDraftSeed) => void;
  openAutomationReveal: (link: AutomationRevealDeepLink) => void;
  consumeAutomationReveal: () => void;
  consumeAutomationRunFocus: () => void;
  openAutomationSharedPipelineReview: (
    link: AutomationSharedPipelineReviewDeepLink,
  ) => void;
  consumeAutomationSharedPipelineReview: () => void;
  openChatTurn: (link: Omit<ChatTurnFocusDeepLink, 'nonce'>) => void;
  consumeChatTurnFocus: () => void;
  requestForkedContainerFocus: (
    request: Omit<ForkedContainerFocusRequest, 'nonce'>,
  ) => void;
  /** Clears the request only while `nonce` is still the pending one. */
  consumeForkedContainerFocus: (nonce: number) => void;
  /** Hold pending fork focus while a fork dialog is open; returns the release. */
  holdForkedContainerFocus: () => () => void;
  openSkillViewer: (link: SkillViewerDeepLink) => void;
  consumeSkillViewer: () => void;
  openPluginsTab: (tab: PluginsTabDeepLink) => void;
  openPluginsNavigation: (intent: PluginsNavigationIntent) => void;
  consumePluginsNavigation: (expected?: PluginsNavigationIntent) => void;
  /**
   * Opens the install review on `link`. While a review is writing, the
   * request is held and applied once the write settles.
   */
  openShareInstall: (
    link: DeepLinkShareOpenEvent,
    origin: ShareInstallOrigin,
    skillTarget?: InstalledSharedSkillTarget,
  ) => void;
  /** Marks the review as writing, or settled; settling applies a held request. */
  setShareInstallBusy: (busy: boolean) => void;
  /** Opens a local agent in the Marketplace Agents tab. */
  openAgentReveal: (reveal: AgentRevealDeepLink) => void;
  openPipelineReveal: (reveal: PipelineRevealDeepLink) => void;
  consumePipelineReveal: () => void;
  /** Open (or queue) a privacy opt-in confirmation; identical links dedupe. */
  openPrivacyOptIn: (request: DataSharingOptInRequest) => void;
  /**
   * Close the confirmation with this `id` and advance the queue. A stale id
   * (an older request finishing late) is ignored, so it never consumes a
   * newer pending link.
   */
  consumePrivacyOptIn: (id: number) => void;
  consumeShareInstall: () => void;
  requestHomeComposerText: (text: string) => void;
  consumeHomeComposerTextRequest: () => void;
  openWorkspaceSettings: (link: WorkspaceSettingsDeepLink) => void;
  openWorkspaceSettingsModal: (link: WorkspaceSettingsDeepLink) => void;
  consumeWorkspaceSettings: () => void;
  setWorkspaceSettingsModalOpen: (open: boolean) => void;
  openAddWorkspaceModal: (options?: {
    initialRepoUrl?: string;
    initialProjectType?: 'cowork' | 'single-repo';
  }) => void;
  closeAddWorkspaceModal: () => void;
  requestCustomizeSidebar: () => void;
  consumeCustomizeSidebarRequest: () => void;
  requestDispatchPipeline: (request: WorktreeActionRequest) => void;
  consumeDispatchPipelineRequest: () => void;
  requestAddRepoAdhoc: (request: WorktreeActionRequest) => void;
  consumeAddRepoAdhocRequest: () => void;
  requestSplitWorkspace: (request: WorktreeActionRequest) => void;
  consumeSplitWorkspaceRequest: () => void;
  requestDriftDetails: (request: WorktreeActionRequest) => void;
  consumeDriftDetailsRequest: () => void;
  requestArchiveWorktree: (request: WorktreeActionRequest) => void;
  consumeArchiveWorktreeRequest: () => void;
}

/** A privacy opt-in confirmation request with a per-arrival identity. */
export interface PendingPrivacyOptIn extends DataSharingOptInRequest {
  id: number;
}
let privacyOptInSequence = 0;

/** Whether a requested navigation may proceed, now or once a prompt closes. */
export type NavigationGuardDecision = boolean | Promise<boolean>;

/**
 * Consulted by `navigate` before the page changes (CAN-3981). The pipeline
 * editor registers one so every path that goes through `navigate` (the
 * sidebar, shortcuts, the palette, deep links, App Advisor) asks about
 * unsaved changes in one place. Return `true` when there is nothing to ask
 * (`canLeaveNow` on the shared unsaved-changes guard): a promise defers the
 * page change, and callers read `activePage` right after `navigate`.
 *
 * `requestedPage` is the page as asked for, so it may be a legacy id that
 * resolves to the tab already shown. Deferred decisions are applied in the
 * order they resolve; a guard that defers has to settle that itself.
 */
export type NavigationGuard = (
  requestedPage: NavigationPage,
) => NavigationGuardDecision;

let navigationGuard: NavigationGuard | null = null;

/**
 * The open page's root state for {@link NavigationState.returnToSectionRoot}:
 * a page that registers resets in place when it is already on its root,
 * instead of remounting.
 */
export const desktopSectionRoot = createSidebarSectionRootRegistry();

/** Depth of {@link runWithoutNavigationGuard} calls in progress. */
let navigationGuardBypassDepth = 0;

/**
 * Registers the navigation guard. One at a time: registering replaces the
 * previous guard. The returned function clears it, and is a no-op once
 * another guard has taken its place, so an unmounting editor never removes
 * its successor's guard.
 */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  navigationGuard = guard;
  return (): void => {
    if (navigationGuard === guard) navigationGuard = null;
  };
}

/**
 * Runs `fn` synchronously with the registered guard bypassed, so the
 * navigations it makes never ask. For navigations that have nothing left to
 * save (Delete, the navigation that follows a save) and for history restore,
 * which asked before it started.
 */
export function runWithoutNavigationGuard<T>(fn: () => T): T {
  navigationGuardBypassDepth += 1;
  try {
    return fn();
  } finally {
    navigationGuardBypassDepth -= 1;
  }
}

/**
 * Asks the registered guard about leaving for `requestedPage`. `true` when
 * no guard is registered or it is bypassed. For callers that must know the
 * answer before they act, such as history, which moves its index only once
 * navigation is allowed.
 */
export function askNavigationGuard(
  requestedPage: NavigationPage,
): NavigationGuardDecision {
  const guard = navigationGuard;
  if (guard === null || navigationGuardBypassDepth > 0) return true;
  return guard(requestedPage);
}

/**
 * Runs `apply` once the guard allows leaving for `requestedPage`. With no
 * guard registered, or a guard that answers at once, it runs synchronously,
 * as callers and tests assume. Every action that sets `activePage` goes
 * through it, so no path changes the page behind a dirty editor. Editor-open
 * actions use it too, so opening another item from a dirty editor asks even
 * when the page id stays the same.
 */
function runGuardedNavigation(
  requestedPage: NavigationPage,
  apply: () => void,
): void {
  const decision = askNavigationGuard(requestedPage);
  if (typeof decision === 'boolean') {
    if (decision) apply();
    return;
  }
  // The guard already answered for this request, so the navigation it
  // allowed applies without asking again.
  void decision.then(
    (allowed) => {
      if (allowed) apply();
    },
    () => undefined,
  );
}

let pluginsNavigationGeneration = 0;
let pluginsPresentationContextGeneration = 0;

/** Identifies the account/workspace context that owns private Customize history. */
export function getPluginsPresentationContextGeneration(): number {
  return pluginsPresentationContextGeneration;
}

/** The store update that opens Plugins on `intent`. */
function pluginsNavigationUpdate(
  intent: PluginsNavigationIntent,
): Partial<NavigationState> {
  if (intent.kind === 'management') {
    intent = {
      kind: 'marketplace-browse',
      ...marketplaceManagementDestination(intent.section, intent.statusFilter),
    };
  }
  if (intent.kind === 'marketplace-browse') {
    const normalized = normalizeMarketplaceNavigation(
      intent.tab,
      intent.focusSection ?? Reflect.get(intent, 'ownership'),
    );
    intent = {
      kind: 'marketplace-browse',
      query: intent.query,
      ...(intent.installedStatusFilter
        ? { installedStatusFilter: intent.installedStatusFilter }
        : {}),
      ...(intent.installedExpanded !== undefined
        ? { installedExpanded: intent.installedExpanded }
        : {}),
      ...(intent.pipelineFilters
        ? { pipelineFilters: intent.pipelineFilters }
        : {}),
      ...(intent.category ? { category: intent.category } : {}),
      ...normalized,
      ...(normalized.tab === 'sources' && intent.source
        ? { source: intent.source }
        : {}),
    };
  }
  return {
    activePage: 'plugins',
    settingsOpen: false,
    pluginsBrowseSectionId: null,
    // History captures synchronously before the page consumes this intent.
    ...(intent.kind === 'restore'
      ? { pluginsPresentation: intent.location }
      : {}),
    pendingPluginsNavigation: intent,
    pendingAutomationReveal: undefined,
  };
}

type NavigationUpdate =
  | Partial<NavigationState>
  | ((state: NavigationState) => Partial<NavigationState>);

/**
 * Hands the store a setter through which an update that moves to another
 * page without naming a target closes the edit shell, so no action has to
 * remember to (CAN-4072).
 */
function withWorkflowEditClearing(
  initializer: StateCreator<NavigationState>,
): StateCreator<NavigationState> {
  return (rawSet, get, api) => {
    const set = (update: NavigationUpdate): void => {
      rawSet((state) => {
        const requested = typeof update === 'function' ? update(state) : update;
        if (requested === state) return state;
        const next =
          requested.activePage === undefined
            ? requested
            : { ...requested, pageRequestSeq: state.pageRequestSeq + 1 };
        if (
          next.activePage === undefined ||
          next.activePage === state.activePage ||
          'workflowEdit' in next ||
          state.workflowEdit === undefined
        ) {
          return next;
        }
        return { ...next, workflowEdit: undefined };
      });
    };
    return initializer(set, get, api);
  };
}

/**
 * Opens the Workflows edit shell on `requested`: the shared body of
 * {@link NavigationState.openWorkflowEdit} and
 * {@link NavigationState.openPipelineEdit}. `onOpened` runs only when the
 * shell moves to another item, right after it does, with the item it shows:
 * never for the item already shown, nor when the guard keeps the person where
 * they are.
 */
function openWorkflowEditTarget(
  set: (update: NavigationUpdate) => void,
  get: () => NavigationState,
  requested: WorkflowEditTarget,
  onOpened?: (opened: WorkflowEditTarget) => void,
): void {
  const target = withWorkflowDraftKey(requested);
  const state = get();
  const current = state.workflowEdit;
  if (
    state.activePage === 'workflows-library' &&
    current !== undefined &&
    isSameWorkflowEditItem(current, target)
  ) {
    // The same item: only the section moves, and the guard is not asked.
    if (target.section !== undefined && target.section !== current.section) {
      set({ workflowEdit: { ...current, section: target.section } });
    }
    return;
  }
  runGuardedNavigation('workflows-library', (): void => {
    set({
      activePage: 'workflows-library',
      workflowEdit: target,
      pendingAutomationReveal: undefined,
    });
    onOpened?.(target);
  });
}

function isAgentNavigation(
  intent: PluginsNavigationIntent | undefined,
): boolean {
  return intent?.kind === 'entry-detail'
    ? intent.entryId.startsWith('agent:')
    : intent?.kind === 'marketplace-browse' && intent.tab === 'agent';
}

let agentNavigationGeneration = 0;
let forkedContainerFocusNonce = 0;

export const useNavigationStore = create<NavigationState>(
  withWorkflowEditClearing((set, get) => ({
    // Overview is a Labs page experiment, off by default (CAN-3678).
    activePage: 'home',
    pageRequestSeq: 0,
    workflowEditReplaceCount: 0,
    sectionRootRequest: 0,
    pluginsBrowseSectionId: null,
    homeComposerFocusRequest: 0,
    settingsOpen: false,
    settingsOpenRequest: 0,
    settingsActiveSection: null,
    settingsHostedLocation: null,
    settingsHostedHistory: [],
    commandPaletteOpen: false,
    commandPaletteInitialQuery: '',
    appAdvisorQuickPromptOpen: false,
    fileSearchPaletteOpen: false,
    fileSearchPaletteInitialQuery: '',
    prPickerOpen: false,
    prPickerOptions: [],
    canopyPortalOpen: false,
    appAdvisorOpen: false,
    appAdvisorFocused: false,
    appAdvisorMainWindowOpen: true,
    appAdvisorMainWindowDownCount: 0,
    workspaceSettingsModalOpen: false,
    addWorkspaceModalOpen: false,
    addWorkspaceInitialRepoUrl: null,
    addWorkspaceInitialProjectType: null,
    customizeSidebarRequested: false,
    forkedContainerFocusHolds: 0,
    navigate: (requestedPage): void => {
      if (requestedPage === 'agents') {
        if (
          !useFeatureFlagsStore
            .getState()
            .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key) ||
          !isPageAvailable('plugins')
        ) {
          get().navigate(NAVIGATION_FALLBACK_PAGE);
          return;
        }
        get().openPluginsNavigation({
          kind: 'marketplace-browse',
          query: '',
          tab: 'agent',
        });
        return;
      }
      // CAN-5765: account connections moved from Settings to Customize's MCP
      // servers. Opening it closes Settings and any detail above that tab.
      if (requestedPage === 'mcp-account-connections') {
        if (!isPageAvailable('plugins')) {
          get().navigate(NAVIGATION_FALLBACK_PAGE);
          return;
        }
        get().openPluginsNavigation({
          kind: 'marketplace-browse',
          ...marketplaceManagementDestination('mcp'),
        });
        return;
      }
      const apply = (): void => {
        // CAN-4269: the Environments page moved into Settings → Environments.
        if (requestedPage === 'environments') {
          get().openSettings('environment');
          return;
        }
        // A legacy Workflows id is never activated: it opens the tab it became
        // with the filters it implies, so history only records real tabs.
        const workflowsTarget = resolveWorkflowsTarget(requestedPage, {
          legacyCalendarPreference:
            requestedPage === 'automations' &&
            resolveNavigationTarget('workflows-schedule') ===
              'workflows-schedule' &&
            consumeLegacyCalendarPreference(
              typeof localStorage === 'undefined' ? undefined : localStorage,
            ),
        });
        // A page that is switched off is never activated: the request becomes
        // an ordinary navigation to the fallback page, side effects included.
        const targetPage = workflowsTarget?.tab ?? requestedPage;
        const page = resolveNavigationTarget(targetPage);
        if (page !== targetPage) {
          // Say where a Labs page went; silent before a ready snapshot.
          notifyPageSwitchedOff(targetPage, () =>
            get().openSettings('experiments'),
          );
        }
        if (workflowsTarget?.presetFilters && page === workflowsTarget.tab) {
          useWorkflowsViewStore
            .getState()
            .applyPreset(workflowsTarget.presetFilters);
        }
        set((state) => ({
          activePage: page,
          pendingAutomationReveal:
            page === 'workflows-library'
              ? state.pendingAutomationReveal
              : undefined,
          // Leaving the copy's page cancels its focus request, so a later
          // visit does not take focus unexpectedly.
          pendingForkedContainerFocus:
            state.pendingForkedContainerFocus?.page === page
              ? state.pendingForkedContainerFocus
              : undefined,
          pluginsBrowseSectionId:
            page === 'plugins' ? state.pluginsBrowseSectionId : null,
          homeComposerFocusRequest:
            page === 'home'
              ? state.homeComposerFocusRequest + 1
              : state.homeComposerFocusRequest,
        }));
      };
      // A request that lands on the page already shown replaces nothing, so
      // there is nothing to ask about. A legacy id counts as the tab it opens.
      const storage =
        typeof localStorage === 'undefined' ? undefined : localStorage;
      const landsOn = resolveNavigationTarget(
        resolveWorkflowsTarget(requestedPage, {
          legacyCalendarPreference:
            requestedPage === 'automations' &&
            resolveNavigationTarget('workflows-schedule') ===
              'workflows-schedule' &&
            peekLegacyCalendarPreference(storage),
        })?.tab ?? requestedPage,
      );
      if (landsOn === get().activePage) {
        apply();
        return;
      }
      runGuardedNavigation(requestedPage, apply);
    },
    returnToSectionRoot: (page): void => {
      runGuardedNavigation(page, (): void => {
        const state = get();
        // Only the open page's own root can reset in place: another tab of
        // the section, an editor or a category is deeper.
        const onRoot =
          state.activePage === page &&
          state.workflowEdit === undefined &&
          state.pluginsBrowseSectionId === null;
        returnSidebarSectionToRoot({
          section: onRoot ? desktopSectionRoot.current() : undefined,
          enterRoot: (): void => {
            // The guard has answered: entering `page` must not ask again.
            runWithoutNavigationGuard((): void => {
              get().navigate(page);
            });
            set((current) => ({
              workflowEdit: undefined,
              pluginsBrowseSectionId: null,
              // The remounted Customize page restores this presentation;
              // its home has none (CAN-4267).
              ...(page === 'plugins' ? { pluginsPresentation: undefined } : {}),
              sectionRootRequest: current.sectionRootRequest + 1,
            }));
          },
        });
      });
    },
    setPluginsBrowseSectionId: (sectionId): void => {
      set({ pluginsBrowseSectionId: sectionId });
    },
    openSettings: (section, options): void => {
      set({
        settingsOpen: true,
        settingsInitialSection: section,
        settingsOpenRequest: get().settingsOpenRequest + 1,
        settingsScrollTarget: options?.scrollTo,
        // Cleared on every open, including re-opens onto a different deep link,
        // so the displayed-section report always describes THIS Settings
        // session. `SettingsOverlay` republishes one commit later.
        settingsActiveSection: null,
        // A local section is the destination, exactly as before hosted
        // settings existed.
        settingsHostedLocation: null,
        settingsHostedHistory: [],
        commandPaletteOpen: false,
        commandPaletteInitialQuery: '',
        appAdvisorQuickPromptOpen: false,
        fileSearchPaletteOpen: false,
        fileSearchPaletteInitialQuery: '',
        prPickerOpen: false,
        prPickerOptions: [],
        canopyPortalOpen: false,
        // App Advisor floats above Settings and must not be closed by other
        // surfaces opening.
      });
    },
    consumeSettingsScrollTarget: (): void => {
      set({ settingsScrollTarget: undefined });
    },
    setSettingsActiveSection: (section): void => {
      set({ settingsActiveSection: section });
    },
    openAccountOrganizationSettings: (route, options): void => {
      // Desktop keeps Labs in its own section, over main's Labs snapshot.
      if (route.scope === 'account' && route.page === 'labs') {
        get().openSettings('experiments', { scrollTo: options?.scrollTo });
        return;
      }
      // Desktop keeps Plugins and MCP servers in its own sections, beside its
      // device settings.
      if (
        route.scope === 'account' &&
        (route.page === 'plugins' || route.page === 'mcp')
      ) {
        get().openSettings(route.page, { scrollTo: options?.scrollTo });
        return;
      }
      // Desktop sets chat detail on this computer, under Display.
      if (route.scope === 'account' && route.page === 'appearance') {
        get().openSettings('display', { scrollTo: options?.scrollTo });
        return;
      }
      const state = get();
      const next = hostedSettingsLocation(route, options);
      if (state.settingsOpen) {
        set({
          settingsHostedLocation: next,
          settingsHostedHistory: options?.replace
            ? state.settingsHostedHistory
            : pushHostedSettingsHistory(
                state.settingsHostedHistory,
                state.settingsHostedLocation,
                next,
              ),
          ...(options?.scrollTo === undefined
            ? {}
            : { settingsScrollTarget: options.scrollTo }),
        });
        return;
      }
      set({
        settingsOpen: true,
        // The local section underneath stays General, as on a plain open.
        settingsInitialSection: undefined,
        settingsScrollTarget: options?.scrollTo,
        settingsActiveSection: null,
        settingsHostedLocation: next,
        settingsHostedHistory: [],
        commandPaletteOpen: false,
        commandPaletteInitialQuery: '',
        appAdvisorQuickPromptOpen: false,
        fileSearchPaletteOpen: false,
        fileSearchPaletteInitialQuery: '',
        prPickerOpen: false,
        prPickerOptions: [],
        canopyPortalOpen: false,
      });
    },
    backAccountOrganizationSettings: (): void => {
      const { settingsHostedHistory: history } = get();
      const previous = history[history.length - 1];
      set({
        settingsHostedLocation: previous ?? ORGANIZATIONS_LIST_LOCATION,
        settingsHostedHistory:
          previous === undefined ? [] : history.slice(0, -1),
      });
    },
    showLocalSettingsSection: (): void => {
      if (get().settingsHostedLocation === null) return;
      set({ settingsHostedLocation: null, settingsHostedHistory: [] });
    },
    closeSettings: (): void => {
      set({
        settingsOpen: false,
        settingsInitialSection: undefined,
        settingsScrollTarget: undefined,
        settingsActiveSection: null,
        settingsHostedLocation: null,
        settingsHostedHistory: [],
      });
    },
    openCommandPalette: (initialQuery = ''): void => {
      set({
        settingsOpen: false,
        settingsInitialSection: undefined,
        settingsHostedLocation: null,
        settingsHostedHistory: [],
        commandPaletteOpen: true,
        commandPaletteInitialQuery: initialQuery,
        appAdvisorQuickPromptOpen: false,
        fileSearchPaletteOpen: false,
        fileSearchPaletteInitialQuery: '',
        prPickerOpen: false,
        prPickerOptions: [],
        canopyPortalOpen: false,
        addWorkspaceModalOpen: false,
      });
    },
    closeCommandPalette: (): void => {
      set({
        commandPaletteOpen: false,
        commandPaletteInitialQuery: '',
      });
    },
    openAppAdvisorQuickPrompt: (): void => {
      set({
        settingsOpen: false,
        settingsInitialSection: undefined,
        settingsHostedLocation: null,
        settingsHostedHistory: [],
        commandPaletteOpen: false,
        commandPaletteInitialQuery: '',
        appAdvisorQuickPromptOpen: true,
        fileSearchPaletteOpen: false,
        fileSearchPaletteInitialQuery: '',
        prPickerOpen: false,
        prPickerOptions: [],
        canopyPortalOpen: false,
      });
    },
    closeAppAdvisorQuickPrompt: (): void => {
      set({ appAdvisorQuickPromptOpen: false });
    },
    openFileSearchPalette: (initialQuery = ''): void => {
      set({
        settingsOpen: false,
        settingsInitialSection: undefined,
        settingsHostedLocation: null,
        settingsHostedHistory: [],
        commandPaletteOpen: false,
        commandPaletteInitialQuery: '',
        appAdvisorQuickPromptOpen: false,
        fileSearchPaletteOpen: true,
        fileSearchPaletteInitialQuery: initialQuery,
        prPickerOpen: false,
        prPickerOptions: [],
        canopyPortalOpen: false,
      });
    },
    closeFileSearchPalette: (): void => {
      set({
        fileSearchPaletteOpen: false,
        fileSearchPaletteInitialQuery: '',
      });
    },
    openPrPicker: (options): void => {
      set({
        settingsOpen: false,
        settingsInitialSection: undefined,
        settingsHostedLocation: null,
        settingsHostedHistory: [],
        commandPaletteOpen: false,
        commandPaletteInitialQuery: '',
        appAdvisorQuickPromptOpen: false,
        fileSearchPaletteOpen: false,
        fileSearchPaletteInitialQuery: '',
        prPickerOpen: true,
        prPickerOptions: options,
        canopyPortalOpen: false,
      });
    },
    closePrPicker: (): void => {
      set({
        prPickerOpen: false,
        prPickerOptions: [],
      });
    },
    openCanopyPortal: (): void => {
      set({
        settingsOpen: false,
        settingsInitialSection: undefined,
        settingsHostedLocation: null,
        settingsHostedHistory: [],
        commandPaletteOpen: false,
        commandPaletteInitialQuery: '',
        appAdvisorQuickPromptOpen: false,
        fileSearchPaletteOpen: false,
        fileSearchPaletteInitialQuery: '',
        prPickerOpen: false,
        prPickerOptions: [],
        canopyPortalOpen: true,
      });
    },
    closeCanopyPortal: (): void => {
      set({ canopyPortalOpen: false });
    },
    // App Advisor open/close/toggle deliberately do not touch any other
    // overlay flags. Settings, Portal, palettes, and the active page remain
    // unchanged so the floating dialog truly behaves as a top-most overlay.
    openAppAdvisor: (target): void => {
      set({ appAdvisorOpen: true });
      // App Advisor renders in its own BrowserWindow. Opening it — and, when a
      // target chat is given, selecting that chat's tab — goes through the same
      // window-open IPC the unread-chat toast uses, so cross-surface deep links
      // resolve against the real App Advisor window rather than a local flag.
      void window.api?.appAdvisor?.openWindow?.({
        ...(target?.chatId ? { chatId: target.chatId } : {}),
        ...(target?.workEntryId ? { workEntryId: target.workEntryId } : {}),
        ...(target?.archivedContainer
          ? { archivedContainer: target.archivedContainer }
          : {}),
        focus: true,
      });
    },
    closeAppAdvisor: (): void => {
      set({ appAdvisorOpen: false, appAdvisorFocused: false });
    },
    toggleAppAdvisor: (): void => {
      const nextOpen = !get().appAdvisorOpen;
      set({
        appAdvisorOpen: nextOpen,
        appAdvisorFocused: nextOpen ? get().appAdvisorFocused : false,
      });
    },
    openWorkers: (workerId): void => {
      if (!isPageAvailable('workers')) {
        // Drop any highlight left by an earlier request so it cannot fire if
        // the page comes back later.
        set({ pendingWorkerHighlight: undefined });
        get().navigate(NAVIGATION_FALLBACK_PAGE);
        return;
      }
      runGuardedNavigation('workers', (): void => {
        set({
          activePage: 'workers',
          pendingAutomationReveal: undefined,
          pendingWorkerHighlight: workerId,
        });
      });
    },
    consumeWorkerHighlight: (): void => {
      set({ pendingWorkerHighlight: undefined });
    },
    openWorkflowEdit: (requested): void => {
      openWorkflowEditTarget(set, get, requested);
    },
    closeWorkflowEdit: (): void => {
      const current = get().workflowEdit;
      if (current === undefined) return;
      const key = workflowEditKey(current);
      const back = resolveWorkflowEditBack(current);
      runGuardedNavigation(
        back.kind === 'plugins' ? 'plugins' : 'workflows-library',
        (): void => {
          // A deferred answer applies only to the item it was asked about.
          const shown = get().workflowEdit;
          if (shown === undefined || workflowEditKey(shown) !== key) return;
          switch (back.kind) {
            case 'edit':
              // Back keeps the assistant's current chat on purpose: its
              // chats are one pool, not one per workflow, so the chat the
              // earlier item had is still a tab beside it rather than
              // brought back.
              set({
                activePage: 'workflows-library',
                workflowEdit: withWorkflowDraftKey(back.target),
              });
              return;
            case 'library':
              set({ workflowEdit: undefined });
              return;
            case 'plugins':
              // One update, so the guard the shell still has registered is
              // never asked a second time.
              set({
                ...pluginsNavigationUpdate(back.intent),
                workflowEdit: undefined,
              });
          }
        },
      );
    },
    replaceWorkflowEdit: (target): void => {
      set((state) => ({
        ...(target === null
          ? { workflowEdit: undefined }
          : {
              activePage: 'workflows-library',
              workflowEdit: withWorkflowDraftKey(target),
            }),
        workflowEditReplaceCount: state.workflowEditReplaceCount + 1,
      }));
    },
    setWorkflowEditSection: (section): void => {
      const current = get().workflowEdit;
      if (current === undefined || current.section === section) return;
      set({ workflowEdit: { ...current, section } });
    },
    openPipelineEdit: (link, options): void => {
      // A workflow opened this way gets a new, empty assistant chat, as a new
      // workflow does (CAN-4319); the conversation it had stays in its tab.
      // That covers every link, including the `pipeline.open_editor` action
      // an agent in another chat runs. The assistant's own tools open
      // workflows through `openWorkflowEdit`, so the chat that asked keeps
      // showing. The request names the opened item, so one its edit view
      // never takes cannot move a later item's chat.
      openWorkflowEditTarget(
        set,
        get,
        {
          ...link,
          kind: 'pipeline',
          ...(options?.section !== undefined
            ? { section: options.section }
            : {}),
          ...(options?.returnTo !== undefined
            ? { returnTo: options.returnTo }
            : {}),
        },
        (opened): void =>
          requestPipelineAssistantNewChat(workflowEditKey(opened)),
      );
    },
    openCuratedPipelinePreview: (key): void => {
      // Curated starters live in Marketplace, which shows the preview.
      runGuardedNavigation('plugins', (): void => {
        set({
          activePage: 'plugins',
          pendingCuratedPipelinePreviewKey: key,
          pendingAutomationReveal: undefined,
        });
      });
    },
    consumeCuratedPipelinePreview: (): void => {
      set({ pendingCuratedPipelinePreviewKey: undefined });
    },
    openPipelineDispatch: (link): void => {
      runGuardedNavigation('main', (): void => {
        set((state) => ({
          activePage: 'main',
          pendingPipelineDispatch: {
            ...link,
            nonce: (state.pendingPipelineDispatch?.nonce ?? 0) + 1,
          },
          pendingAutomationReveal: undefined,
        }));
      });
    },
    consumePipelineDispatch: (): void => {
      set({ pendingPipelineDispatch: undefined });
    },
    openAutomationEdit: (link): void => {
      set({
        pendingAutomationRunFocus: link.runId
          ? { activityId: link.activityId, runId: link.runId }
          : undefined,
      });
      // A run request opens Runs unless the caller named another section.
      const section = link.section ?? (link.runId ? 'runs' : undefined);
      get().openWorkflowEdit({
        kind: 'automation',
        activityId: link.activityId,
        ...(section !== undefined ? { section } : {}),
        ...(link.returnTo !== undefined ? { returnTo: link.returnTo } : {}),
      });
    },
    openAutomationDraft: (seed): void => {
      get().openWorkflowEdit({
        kind: 'automation-draft',
        draftKey: newWorkflowDraftKey(),
        ...(seed !== undefined ? { seed } : {}),
      });
    },
    // A reveal and a review both act on the Library list, so they close the
    // edit shell.
    openAutomationReveal: (link): void => {
      runGuardedNavigation('workflows-library', (): void => {
        set({
          activePage: 'workflows-library',
          workflowEdit: undefined,
          pendingAutomationReveal: { ...link },
          pendingAutomationSharedPipelineReview: undefined,
        });
      });
    },
    consumeAutomationReveal: (): void => {
      set({ pendingAutomationReveal: undefined });
    },
    consumeAutomationRunFocus: (): void => {
      set({ pendingAutomationRunFocus: undefined });
    },
    openAutomationSharedPipelineReview: (link): void => {
      runGuardedNavigation('workflows-library', (): void => {
        set({
          activePage: 'workflows-library',
          workflowEdit: undefined,
          pendingAutomationSharedPipelineReview: link,
          pendingAutomationReveal: undefined,
        });
      });
    },
    consumeAutomationSharedPipelineReview: (): void => {
      set({ pendingAutomationSharedPipelineReview: undefined });
    },
    openChatTurn: (link): void => {
      // Intentionally does not navigate: the owning surface differs per chat
      // kind, so the caller picks the page and selects the tab first.
      set((state) => ({
        pendingChatTurnFocus: {
          ...link,
          nonce: (state.pendingChatTurnFocus?.nonce ?? 0) + 1,
        },
      }));
    },
    consumeChatTurnFocus: (): void => {
      set({ pendingChatTurnFocus: undefined });
    },
    requestForkedContainerFocus: (request): void => {
      forkedContainerFocusNonce += 1;
      set({
        pendingForkedContainerFocus: {
          ...request,
          nonce: forkedContainerFocusNonce,
        },
      });
    },
    consumeForkedContainerFocus: (nonce): void => {
      if (get().pendingForkedContainerFocus?.nonce !== nonce) return;
      set({ pendingForkedContainerFocus: undefined });
    },
    holdForkedContainerFocus: (): (() => void) => {
      set((state) => ({
        forkedContainerFocusHolds: state.forkedContainerFocusHolds + 1,
      }));
      let released = false;
      return (): void => {
        if (released) return;
        released = true;
        set((state) => ({
          forkedContainerFocusHolds: Math.max(
            0,
            state.forkedContainerFocusHolds - 1,
          ),
        }));
      };
    },
    openSkillViewer: (link): void => {
      runGuardedNavigation('plugins', (): void => {
        set({
          activePage: 'plugins',
          pluginsBrowseSectionId: null,
          pendingSkillViewer: link,
          pendingAutomationReveal: undefined,
        });
      });
    },
    consumeSkillViewer: (): void => {
      set({ pendingSkillViewer: undefined });
    },
    setPluginsPresentation: (location): void => {
      if (
        JSON.stringify(get().pluginsPresentation) !== JSON.stringify(location)
      )
        set({ pluginsPresentation: location });
    },
    openPluginsTab: (tab): void => {
      get().openPluginsNavigation({
        kind: 'marketplace-browse',
        ...marketplaceManagementDestination(tab),
      });
    },
    openPluginsNavigation: (intent): void => {
      pluginsNavigationGeneration += 1;
      const requestGeneration = pluginsNavigationGeneration;
      const agentIntent = isAgentNavigation(intent);
      const generation = agentNavigationGeneration;
      if (
        agentIntent &&
        (!useFeatureFlagsStore
          .getState()
          .isEnabled(CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key) ||
          !isPageAvailable('plugins'))
      )
        return;
      runGuardedNavigation('plugins', (): void => {
        if (requestGeneration !== pluginsNavigationGeneration) return;
        if (agentIntent && generation !== agentNavigationGeneration) return;
        set(pluginsNavigationUpdate(intent));
      });
    },
    consumePluginsNavigation: (expected): void => {
      if (expected && get().pendingPluginsNavigation !== expected) return;
      set({ pendingPluginsNavigation: undefined });
    },
    shareInstallBusy: false,
    openShareInstall: (link, origin, skillTarget): void => {
      const request: PendingShareInstall = {
        link,
        origin,
        ...(link.entity === 'skill' && skillTarget
          ? { skillTarget: { ...skillTarget } }
          : {}),
      };
      if (get().shareInstallBusy) {
        set({ heldShareInstall: request });
        return;
      }
      set({ pendingShareInstall: request, heldShareInstall: undefined });
    },
    setShareInstallBusy: (busy): void => {
      if (busy) {
        set({ shareInstallBusy: true });
        return;
      }
      const held = get().heldShareInstall;
      set(
        held
          ? {
              shareInstallBusy: false,
              pendingShareInstall: held,
              heldShareInstall: undefined,
            }
          : { shareInstallBusy: false },
      );
    },
    openAgentReveal: (reveal): void => {
      get().openPluginsNavigation({
        kind: 'entry-detail',
        entryId: localAgentEntryId(reveal.agentId),
        intent: reveal.mode === 'edit' ? 'edit' : 'view',
      });
    },
    // A reveal acts on the Library list, so it closes the edit shell.
    openPipelineReveal: (reveal): void => {
      runGuardedNavigation('workflows-library', (): void => {
        set({
          activePage: 'workflows-library',
          workflowEdit: undefined,
          pendingPipelineReveal: { ...reveal },
          pendingAutomationReveal: undefined,
        });
      });
    },
    consumePipelineReveal: (): void => {
      set({ pendingPipelineReveal: undefined });
    },
    queuedPrivacyOptIns: [],
    openPrivacyOptIn: (request): void => {
      set((state) => {
        const same = (entry: PendingPrivacyOptIn | undefined): boolean =>
          entry !== undefined &&
          entry.feature === request.feature &&
          entry.organizationId === request.organizationId;
        if (
          same(state.pendingPrivacyOptIn) ||
          state.queuedPrivacyOptIns.some(same)
        ) {
          return state;
        }
        const entry: PendingPrivacyOptIn = {
          id: ++privacyOptInSequence,
          feature: request.feature,
          organizationId: request.organizationId,
        };
        return state.pendingPrivacyOptIn === undefined
          ? { pendingPrivacyOptIn: entry }
          : { queuedPrivacyOptIns: [...state.queuedPrivacyOptIns, entry] };
      });
    },
    consumePrivacyOptIn: (id): void => {
      set((state) => {
        if (state.pendingPrivacyOptIn?.id !== id) return state;
        const [next, ...rest] = state.queuedPrivacyOptIns;
        return { pendingPrivacyOptIn: next, queuedPrivacyOptIns: rest };
      });
    },
    consumeShareInstall: (): void => {
      // A review that is writing cannot be closed; its close affordances are
      // inert until the write settles.
      if (get().shareInstallBusy) return;
      set({ pendingShareInstall: undefined });
    },
    requestHomeComposerText: (text): void => {
      runGuardedNavigation('home', (): void => {
        set((state) => ({
          activePage: 'home',
          homeComposerFocusRequest: state.homeComposerFocusRequest + 1,
          pendingAutomationReveal: undefined,
          pendingHomeComposerText: {
            text,
            nonce: state.homeComposerFocusRequest + 1,
          },
        }));
      });
    },
    consumeHomeComposerTextRequest: (): void => {
      set({ pendingHomeComposerText: undefined });
    },
    openWorkspaceSettings: (link): void => {
      runGuardedNavigation('main', (): void => {
        set({
          activePage: 'main',
          pendingWorkspaceSettings: link,
          workspaceSettingsModalOpen: true,
          pendingAutomationReveal: undefined,
        });
      });
    },
    openWorkspaceSettingsModal: (link): void => {
      set({
        pendingWorkspaceSettings: link,
        workspaceSettingsModalOpen: true,
      });
    },
    consumeWorkspaceSettings: (): void => {
      set({ pendingWorkspaceSettings: undefined });
    },
    setWorkspaceSettingsModalOpen: (open): void => {
      set({ workspaceSettingsModalOpen: open });
    },

    openAddWorkspaceModal: (options): void => {
      // The Add Workspace modal is hosted at App level (`AddWorkspaceModalHost`),
      // so it overlays whatever page is active — opening it must NOT navigate.
      // Home (or any other page) stays visible underneath (Task H1 item 2).
      // An optional `initialRepoUrl` seeds the modal's Remote → URL input so the
      // Home picker's "Add {owner}/{repo} as a workspace…" offer row lands on a
      // pre-filled clone/reuse flow (ECW-8121).
      set({
        addWorkspaceModalOpen: true,
        addWorkspaceInitialRepoUrl: options?.initialRepoUrl ?? null,
        addWorkspaceInitialProjectType: options?.initialProjectType ?? null,
      });
    },

    closeAddWorkspaceModal: (): void => {
      set({
        addWorkspaceModalOpen: false,
        addWorkspaceInitialRepoUrl: null,
        addWorkspaceInitialProjectType: null,
      });
    },

    requestCustomizeSidebar: (): void => {
      set({ customizeSidebarRequested: true });
    },

    consumeCustomizeSidebarRequest: (): void => {
      set({ customizeSidebarRequested: false });
    },

    requestDispatchPipeline: (request): void => {
      set({ pendingDispatchPipeline: request });
    },

    consumeDispatchPipelineRequest: (): void => {
      set({ pendingDispatchPipeline: undefined });
    },

    requestAddRepoAdhoc: (request): void => {
      set({ pendingAddRepoAdhoc: request });
    },

    consumeAddRepoAdhocRequest: (): void => {
      set({ pendingAddRepoAdhoc: undefined });
    },

    requestSplitWorkspace: (request): void => {
      set({ pendingSplitWorkspace: request });
    },

    consumeSplitWorkspaceRequest: (): void => {
      set({ pendingSplitWorkspace: undefined });
    },

    requestDriftDetails: (request): void => {
      set({ pendingDriftDetails: request });
    },

    consumeDriftDetailsRequest: (): void => {
      set({ pendingDriftDetails: undefined });
    },

    requestArchiveWorktree: (request): void => {
      set({ pendingArchiveWorktree: request });
    },

    consumeArchiveWorktreeRequest: (): void => {
      set({ pendingArchiveWorktree: undefined });
    },
  })),
);

// The navigation store outlives lazy pages. Invalidate agent requests here so
// off/on cannot replay an editor that has not mounted (or a deferred guard).
export function initAgentNavigationFlagTracking(): () => void {
  return useFeatureFlagsStore.subscribe((state, previous) => {
    const key = CLIENT_FEATURE_FLAGS.canopySharedCustomAgents.key;
    if (
      previous.snapshot.values[key] !== true ||
      state.snapshot.values[key] === true
    )
      return;
    agentNavigationGeneration += 1;
    if (
      isAgentNavigation(useNavigationStore.getState().pendingPluginsNavigation)
    ) {
      useNavigationStore.setState({ pendingPluginsNavigation: undefined });
    }
  });
}

interface E2eNavigationTestApi {
  /** The link in the install review, or null. */
  getPendingShareInstall: () => DeepLinkShareOpenEvent | null;
  /** The privacy opt-in confirmation currently shown, without its queue id. */
  getPendingPrivacyOptIn: () => DataSharingOptInRequest | null;
  /**
   * Opens an automation's editor the way the "automation created" toast and
   * agent artifact links do, including automations the current context hides.
   */
  openAutomationEdit: (activityId: string) => void;
  /** The edit shell's target, or null for the Library list (CAN-4072). */
  workflowEdit: () => WorkflowEditTarget | null;
  /** Opens the edit shell through the guarded store action. */
  openWorkflowEdit: (target: WorkflowEditTarget) => void;
  /**
   * Requests a page through `navigate`, the path programmatic openers use.
   * Returns false, without navigating, for a string that is not a page.
   */
  navigate: (page: string) => boolean;
  /** The page the store currently has active. */
  activePage: () => NavigationPage;
  /** The hosted account or organization route Settings shows, if any. */
  settingsHostedRoute: () => SettingsRoute | null;
}

declare global {
  interface Window {
    __canopyNavigationTestApi?: E2eNavigationTestApi;
  }
}

// E2E-only probe (same pattern as `__canopyProjectsTestApi`): OS deep-link
// delivery has no visible UI until the landing surface ships, so the
// automation spec asserts the parked payload directly.
if (__CANOPY_E2E__) {
  window.__canopyNavigationTestApi = {
    getPendingShareInstall: (): DeepLinkShareOpenEvent | null =>
      useNavigationStore.getState().pendingShareInstall?.link ?? null,
    getPendingPrivacyOptIn: (): DataSharingOptInRequest | null => {
      const pending = useNavigationStore.getState().pendingPrivacyOptIn;
      return pending
        ? { feature: pending.feature, organizationId: pending.organizationId }
        : null;
    },
    openAutomationEdit: (activityId: string): void =>
      useNavigationStore.getState().openAutomationEdit({ activityId }),
    workflowEdit: (): WorkflowEditTarget | null =>
      useNavigationStore.getState().workflowEdit ?? null,
    openWorkflowEdit: (target: WorkflowEditTarget): void =>
      useNavigationStore.getState().openWorkflowEdit(target),
    navigate: (page: string): boolean => {
      const known = Object.values(NAVIGATION_PAGE_MAP).find(
        (candidate) => candidate === page,
      );
      if (known === undefined) return false;
      useNavigationStore.getState().navigate(known);
      return true;
    },
    activePage: (): NavigationPage => useNavigationStore.getState().activePage,
    settingsHostedRoute: (): SettingsRoute | null =>
      useNavigationStore.getState().settingsHostedLocation?.route ?? null,
  };
}

/**
 * The Settings overlay's current destination, or `null` while Settings is
 * closed or has not yet reported its local section. A hosted destination
 * wins over the local section kept underneath it.
 */
export function selectSettingsDestination(state: {
  readonly settingsOpen: boolean;
  readonly settingsHostedLocation: HostedSettingsLocation | null;
  readonly settingsActiveSection: SettingsSection | null;
}): SettingsDestination | null {
  if (!state.settingsOpen) return null;
  if (state.settingsHostedLocation !== null)
    return { kind: 'hosted', route: state.settingsHostedLocation.route };
  return state.settingsActiveSection === null
    ? null
    : { kind: 'local', section: state.settingsActiveSection };
}

// Legacy browser events remain accepted even before Customize's lazy chunk loads.
function invalidatePluginsPresentation(): void {
  pluginsNavigationGeneration += 1;
  pluginsPresentationContextGeneration += 1;
  useNavigationStore.setState({
    pendingPluginsNavigation: undefined,
    pluginsPresentation: undefined,
  });
}

useWorkspaceContextStore.subscribe((state, previous): void => {
  if (
    state.appliedGeneration !== previous.appliedGeneration ||
    state.accountEpoch !== previous.accountEpoch
  )
    invalidatePluginsPresentation();
});

/**
 * Module-level window listeners need a real event target. Tests and other
 * non-renderer hosts may stub `window` without one; importing this store
 * must not throw there.
 */
function windowAcceptsListeners(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.addEventListener === 'function'
  );
}

if (windowAcceptsListeners()) {
  window.addEventListener(
    CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
    invalidatePluginsPresentation,
  );
  window.addEventListener('canopy:plugins-open-tab', (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    const tab: unknown =
      typeof detail === 'object' && detail !== null
        ? Reflect.get(detail, 'tab')
        : undefined;
    if (
      typeof tab !== 'string' ||
      !['marketplace', 'skills', 'mcp', 'collections', 'bundles'].includes(tab)
    )
      return;
    useNavigationStore.getState().openPluginsNavigation({
      kind: 'marketplace-browse',
      ...marketplaceManagementDestination(tab),
    });
  });
  window.addEventListener(
    'canopy:plugins-open-management',
    (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      const section: unknown =
        typeof detail === 'object' && detail !== null
          ? Reflect.get(detail, 'section')
          : undefined;
      useNavigationStore.getState().openPluginsNavigation({
        kind: 'marketplace-browse',
        ...marketplaceManagementDestination(section),
      });
    },
  );
}

if (windowAcceptsListeners()) {
  window.addEventListener('canopy:mcp-open-browse', (): void => {
    useNavigationStore
      .getState()
      .openPluginsNavigation({ kind: 'browse-apps' });
  });
  window.addEventListener('canopy:plugin-open-detail', (event: Event): void => {
    if (!(event instanceof CustomEvent)) return;
    const detail: unknown = event.detail;
    if (typeof detail !== 'object' || detail === null) return;
    const sourceId: unknown = Reflect.get(detail, 'marketplaceId');
    const pluginKey: unknown = Reflect.get(detail, 'pluginName');
    if (typeof sourceId !== 'string' || typeof pluginKey !== 'string') return;
    useNavigationStore.getState().openPluginsNavigation({
      kind: 'marketplace-source',
      target: 'detail',
      sourceId,
      pluginKey,
    });
  });
}

useNavigationStore.subscribe((state, previous): void => {
  if (
    state.activePage !== previous.activePage &&
    state.activePage !== 'plugins'
  ) {
    pluginsNavigationGeneration += 1;
    if (state.pendingPluginsNavigation)
      useNavigationStore.setState({ pendingPluginsNavigation: undefined });
  }
});
