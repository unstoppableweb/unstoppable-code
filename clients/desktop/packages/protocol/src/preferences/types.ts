/**
 * The preferences document (`PreferencesData`) and its type closure, moved
 * from desktop-shared so the core daemon can name them (CAN-5722). The old
 * desktop-shared homes re-export these declarations.
 */
import type { AgentModelConfig } from '../agent-model-config';
import type { AgentProviderType, ChatInterfaceMode } from '../agent-providers';
import type { ApprovalDefaults, ApprovalRule } from '../approval-policy';
import type { BrowserDrawerTabId } from '../browser';
import type { DataSharingOptInFeature } from '../canopy-server';
import type { ChatDetail } from '../chat-detail';
import type { ChatModel } from '../chat-models';
import type { ClaudeModAdmission } from '../claude-mods/admission';
import type { CopilotHostSelection } from '../copilot-selection';
import type { ManagedDelegationMode } from '../delegation/discovery';
import type { ManagedDelegationModelPolicy } from '../delegation/model-policy';
import type { FileIndexingPreferences } from '../file-indexing';
import type { GlobalInstructionsConfig } from '../global-instructions';
import type {
  InstalledItemRef,
  InstalledItemUninstallTarget,
} from '../installed-items';
import type { McpRemovalRecovery } from '../mcp-removal';
import type { McpHttpAuthHandler } from '../mcp-servers';
import type { PlanModeHintRecord } from '../onboarding';
import type { OnboardingTipDismissals } from '../onboarding-tips';
import type { GitHubStarPromptRecord } from '../onboarding/github-star-prompt';
import type { PlanDetectionRule } from '../plan-detection';
import type { ProfileRoleId } from '../plugin-catalog';
import type { ChatTabPluginSelections } from '../plugins/selections';
import type { ReferenceEnrichmentMode } from '../reference-previews';
import type { SidebarNavLayout } from '../sidebar';
import type { SuggestionsState } from '../suggestions';
import type { TelemetryShareScope } from '../telemetry';
import type { TerminalPreset, TerminalShellProfileId } from '../terminal';
import type { ThinkingLevel } from '../thinking';
import type { UsageDataPreferences } from '../usage-data';

/**
 * Code vs Work navigation mode (CAN-1817).
 *
 * The saved mode decides how much repository detail project and task setup
 * shows and, later, how the assistant explains its work (CAN-999). It is a
 * global user preference (`PreferencesData.navigationMode`), seeded from the
 * onboarding role and overridable in Settings → General. Internal data
 * models never change with the mode; only presentation does.
 */
export const NAVIGATION_MODES = ['code', 'work'] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

export const WORKSPACE_LAYOUT_MODES = ['minimal', 'advanced'] as const;
export type WorkspaceLayoutMode = (typeof WORKSPACE_LAYOUT_MODES)[number];

/**
 * Preferences fields contributed by the terminal drawer feature.
 *
 * Merged into `PreferencesData` in `src/shared/types.ts`. The main-side
 * normalize/clamp logic lives with the rest of preference validation.
 */
export interface TerminalDrawerPreferences {
  /** Whether the drawer is collapsed. Default: `true`. */
  terminalDrawerCollapsed: boolean;
  /** Drawer height in pixels. Default: 300. Clamp: 180–600. */
  terminalDrawerHeight: number;
  /**
   * Active drawer tab id. Default: `'terminal'`. The shared drawer now hosts
   * both the terminal and the in-app browser, so this accepts
   * {@link BrowserDrawerTabId} (`'terminal' | 'browser'`). The field name is
   * kept for backward compatibility with persisted preferences. Runtime
   * validation / invalid-value normalization of the stored value is a backend
   * concern (see the backend plan).
   */
  terminalDrawerActiveTabId: BrowserDrawerTabId;
  /** Detected shell entries hidden from the Terminal panel picker. */
  disabledTerminalShellProfileIds: TerminalShellProfileId[];
  /** User-defined shell + command shortcuts offered in the panel picker. */
  terminalPresets: TerminalPreset[];
  /**
   * Revision of `disabledTerminalShellProfileIds` and `terminalPresets`
   * (CAN-4148). It moves exactly when either committed value changes; the
   * preference merge sets it and no patch can. Starts at 0.
   */
  terminalSettingsRevision: number;
}

/**
 * Whether Merge hands a pull request on a merge queue to an agent chat that
 * runs the `merge-pr` skill (Settings > Git > Merge queue):
 * - `always`: every merge-queue merge starts the chat.
 * - `when_hook_absent`: the chat starts unless the worktree would run a
 *   configured, unpaused `pr:queue:removed` hook for the PR's repository.
 * - `never`: Merge adds the pull request to the merge queue directly.
 */
export type MergeQueueAgentHandling = 'always' | 'when_hook_absent' | 'never';

export interface CopilotAccount {
  host: string;
  login: string;
}

/**
 * Where the proxy runs. Only `server` exists today; `local` (this device runs
 * it) and `device` (another paired desktop relays its accounts) are reserved
 * so stored connections never need a migration to add them.
 */
export type AccountProxyConnectionKind = 'server' | 'local' | 'device';

export interface AccountProxyConnection {
  /** Random id, stable for the life of the connection. */
  readonly id: string;
  readonly kind: AccountProxyConnectionKind;
  /** Normalized base URL without a trailing slash. */
  readonly url: string;
}

/** How the proxy picks an account for each request (`routing.strategy`). */
export const ACCOUNT_PROXY_ROUTING_STRATEGIES = [
  'round-robin',
  'weighted-round-robin',
  'fill-first',
] as const;

export type AccountProxyRoutingStrategy =
  (typeof ACCOUNT_PROXY_ROUTING_STRATEGIES)[number];

export type BillingLane =
  | 'claude-native'
  | 'codex-native'
  | 'ai-credits'
  | 'ollama';

/**
 * Saved owner of a code or cowork project: Personal, or one organization.
 * App Advisor has no owner and never uses this type.
 */
export type ProjectOwnerContext =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string };

export type BranchNamePrefixMode = 'github' | 'custom' | 'none';

export interface BranchDisplayMappingSettings {
  replaceHyphens: boolean;
  capitalize: boolean;
}

export interface BranchDisplayMapping {
  id: string;
  label: string;
  matcher: string;
  result: string;
  settings: BranchDisplayMappingSettings;
  enabled: boolean;
  builtin: boolean;
  examples: string[];
  readonlyExampleCount: number;
}

/** Persisted ordering choice for a sidebar section. */
export type SidebarSortMode = 'last-updated' | 'manual';

export type PrInstructionMode = 'replace' | 'append';

export const THEME_NAMES = [
  'default',
  'unstoppable',
  'dusk',
  'lime',
  'ocean',
  'retro',
  'neo',
  'forest',
] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const COLOR_MODES = ['light', 'dark', 'system'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export const SIDEBAR_APPEARANCES = ['opaque', 'translucent'] as const;
export type SidebarAppearance = (typeof SIDEBAR_APPEARANCES)[number];

export const WORKTREE_DIFF_STATS_STYLES = ['short', 'complete'] as const;
export type WorktreeDiffStatsStyle =
  (typeof WORKTREE_DIFF_STATS_STYLES)[number];

export const SCROLLBAR_BEHAVIORS = [
  'system',
  'always',
  'scroll',
  'hover',
  'never',
] as const;
export type ScrollbarBehavior = (typeof SCROLLBAR_BEHAVIORS)[number];

/**
 * How chat transcripts enrich a provider's references (CAN-4060). `replace`
 * shows inline titles and icons, `hover` keeps the author's text and adds
 * preview links, `off` leaves references untouched.
 */
export const CHAT_ENRICHMENT_MODES = ['replace', 'hover', 'off'] as const;
export type ChatEnrichmentMode = ReferenceEnrichmentMode;

/**
 * Discovery channels offered by the onboarding attribution step (CAN-1009).
 * Ids are persisted in preferences and reported to telemetry, so they must
 * stay bounded and stable; user-facing labels live in the renderer.
 */
export const ATTRIBUTION_SOURCES = [
  'search',
  'social-media',
  'youtube',
  'friend-coworker',
  'blog-article',
  'github',
  'work-team',
  'other',
] as const;
export type AttributionSourceId = (typeof ATTRIBUTION_SOURCES)[number];

/** Local wall-clock quiet window; `endHour` may be less than `startHour`. */
export interface ActivationQuietHours {
  enabled: boolean;
  /** 0-23 local hour the quiet window opens. */
  startHour: number;
  /** 0-23 local hour the quiet window closes (exclusive). */
  endHour: number;
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Built-in macOS system sounds under `/System/Library/Sounds/`. Passing one
 * of these as the `sound` property on the Electron `Notification` constructor
 * overrides the user's default alert sound for that single notification.
 *
 * Offered on every platform except Windows, which has its own list
 * ({@link OS_NOTIFICATION_WINDOWS_SOUNDS}).
 */
export const OS_NOTIFICATION_MACOS_SOUNDS = [
  'Basso',
  'Blow',
  'Bottle',
  'Frog',
  'Funk',
  'Glass',
  'Hero',
  'Morse',
  'Ping',
  'Pop',
  'Purr',
  'Sosumi',
  'Submarine',
  'Tink',
] as const;

/**
 * Windows notification sounds. Windows toasts pick a sound through the
 * `ms-winsoundevent:` audio source in the toast XML; these are the
 * non-looping sound events that ship with every Windows install. The mapping
 * to each event lives in `notification-sounds.ts`.
 */
export const OS_NOTIFICATION_WINDOWS_SOUNDS = [
  'Mail',
  'Message',
  'Reminder',
  'SMS',
] as const;

/**
 * Top-level sound choices. `None` suppresses sound (sets `silent: true`).
 * `System` delegates to the OS default alert sound (no `sound` override).
 *
 * This is every value a saved preference may hold, on any platform. What a
 * given platform offers in Settings is `osNotificationSoundsForPlatform`.
 */
export const OS_NOTIFICATION_TOP_LEVEL_SOUNDS = [
  'System',
  'None',
  ...OS_NOTIFICATION_MACOS_SOUNDS,
  ...OS_NOTIFICATION_WINDOWS_SOUNDS,
] as const;

export type OsNotificationTopLevelSound =
  (typeof OS_NOTIFICATION_TOP_LEVEL_SOUNDS)[number];

/**
 * Per-category sound choices. `Default` inherits the top-level sound value.
 */
export const OS_NOTIFICATION_CATEGORY_SOUNDS = [
  'Default',
  ...OS_NOTIFICATION_TOP_LEVEL_SOUNDS,
] as const;

export type OsNotificationCategorySound =
  (typeof OS_NOTIFICATION_CATEGORY_SOUNDS)[number];

export interface OsNotificationCategorySoundMap {
  chat: OsNotificationCategorySound;
  script: OsNotificationCategorySound;
  hook: OsNotificationCategorySound;
  gitCommit: OsNotificationCategorySound;
  gitPush: OsNotificationCategorySound;
  prCreate: OsNotificationCategorySound;
  pipeline: OsNotificationCategorySound;
  terminal: OsNotificationCategorySound;
  runComment: OsNotificationCategorySound;
  activation: OsNotificationCategorySound;
}

export interface NotificationCategoryMap {
  chat: boolean;
  script: boolean;
  hook: boolean;
  gitCommit: boolean;
  gitPush: boolean;
  prCreate: boolean;
  pipeline: boolean;
  terminal: boolean;
  /**
   * Somebody commented on a run you shared (CAN-397). Its own opt-in rather
   * than a reuse of `chat`: this fires for another person's activity on a
   * finished, shared session, which is a different interruption budget than
   * your own agent finishing a turn.
   */
  runComment: boolean;
  /**
   * Post-install activation journey nudges (CAN-1967 / CAN-2438). Its own
   * opt-in rather than a reuse of `chat` or `pipeline`: these are lifecycle
   * prompts scheduled by the app, not your agent's activity, and the
   * fail-closed rule in `renderer/src/lib/osNotifications.ts` forbids
   * smuggling them through an unrelated category's consent.
   */
  activation: boolean;
}

export const IN_APP_NOTIFICATION_PLACEMENTS = [
  'top-right',
  'bottom-right',
  'bottom-left',
  'top-left',
] as const;

export type InAppNotificationPlacement =
  (typeof IN_APP_NOTIFICATION_PLACEMENTS)[number];

export interface InAppNotificationPreferences {
  enabled: boolean;
  /**
   * A retained notification corner. Unset follows the app's bottom-right
   * default, resolved by the renderer. Explicit choices are preserved, as are
   * legacy top-right, top-left, and bottom-left values without a chosen flag.
   */
  placement?: InAppNotificationPlacement;
  /**
   * Set when the user picked `placement` in Settings, preserving any of the
   * four corners, including bottom-right. Older builds saved `bottom-right`
   * automatically; without this flag, that value is dropped on load to follow
   * the app default, even when the default is also bottom-right. Other valid
   * legacy corners are retained without this flag.
   */
  placementChosen?: true;
  categories: NotificationCategoryMap;
}

export interface OsNotificationPreferences {
  enabled: boolean;
  skipWhenFocused: boolean;
  defaultSound: OsNotificationTopLevelSound;
  categories: NotificationCategoryMap;
  categorySounds: OsNotificationCategorySoundMap;
}

/**
 * Promotional notification controls (CAN-3013). `enabled` is the master; the
 * remaining category is independently configurable. Operational notifications -- agent completion,
 * failures, approval requests -- are outside this control entirely and stay
 * governed by {@link OsNotificationPreferences}.
 *
 * `arbitrary` covers product and growth campaigns, including activation campaigns.
 */
export interface PromotionalNotificationPreferences {
  enabled: boolean;
  arbitrary: boolean;
}

/**
 * A single provider's default model + thinking level. Used inside
 * {@link ModelDefaultsByProvider} to hold per-provider defaults for the
 * standalone-chat and worktree-chat settings.
 */
export interface ProviderModelSelection {
  model: ChatModel;
  thinkingLevel: ThinkingLevel;
  modelConfig?: AgentModelConfig;
}

/**
 * Per-provider default model selections. Ollama is nullable because the user
 * may not have any Ollama models installed; in that state it cannot be chosen
 * as the overall default provider.
 */
export interface ModelDefaultsByProvider {
  claude: ProviderModelSelection;
  codex: ProviderModelSelection;
  ollama: ProviderModelSelection | null;
  /** `null` means choose the current catalog-backed AI Credits default. */
  aiCredits?: ProviderModelSelection | null;
  cursor?: ProviderModelSelection | null;
  copilot?: ProviderModelSelection | null;
  antigravity?: ProviderModelSelection | null;
  opencode?: ProviderModelSelection | null;
}

/**
 * Per-data-type telemetry upload visibility. `off` is a Canopy-local
 * non-sync state (nothing uploads); the remaining values reuse the
 * server's {@link TelemetryShareScope} vocabulary as the single source of
 * truth for who can see an uploaded record.
 */
export type TelemetrySharingVisibility = 'off' | TelemetryShareScope;

/**
 * The user's desktop→server telemetry-sync intent, recorded per data type. The
 * persisted fallback starts at `'off'`; a definitive entitlement probe applies
 * the paid/free tier default before the main-process sync service uses it.
 */
export interface TelemetrySharingPreferences {
  transcripts: TelemetrySharingVisibility;
  plans: TelemetrySharingVisibility;
  metadata: TelemetrySharingVisibility;
  /**
   * AI-generated worktree recaps (`worktree.summary` + the `summaries[]`
   * snapshot history), split out of `metadata` so a transcripts prohibition is
   * not undermined by conversation-derived prose.
   *
   * MIGRATION: this key was added after `metadata` shipped, and summaries used
   * to ride on `metadata`. A persisted preferences file missing this key must
   * read back as the stored `metadata` value, NOT `'off'` — see
   * `normalizePreferences` in the main-process preferences IPC. Defaulting to
   * `'off'` would silently stop summaries for every existing user.
   */
  summaries: TelemetrySharingVisibility;
}

/** Device-local snapshots cap historical queued work to its pre-consent audience. */
export interface DataSharingOptInHistoryEntry {
  enabledAt: string;
  sharing: TelemetrySharingPreferences;
}

/**
 * How AI Credits are used as an LLM-routing fallback (CAN-771 / CAN-838).
 * - `'off'` (default): feature disabled. On quota exhaustion with credits
 *   available, a one-time in-chat discovery prompt is shown; accepting is the
 *   consent moment. Missing native provider auth is not treated as consent and
 *   must not auto-enable AI Credits.
 * - `'on-quota'`: auto-route silently for the session whenever the user's own
 *   provider auth is unavailable or native quota is exhausted.
 * - `'on'`: always route through AI Credits from session start, regardless of
 *   native quota.
 */
export const AI_CREDITS_ROUTING_MODES = ['off', 'on-quota', 'on'] as const;
export type AiCreditsRoutingMode = (typeof AI_CREDITS_ROUTING_MODES)[number];

/**
 * Which billing framework a chat runs under, as chosen in the model picker's
 * "Use AI Credits" toggle:
 * - `'subscription'`: bill the user's native provider subscription (toggle off).
 * - `'ai-credits'`: route through UD AI Credits (toggle on).
 *
 * Recorded globally as `PreferencesData.lastChatBillingFramework` so the user's
 * last explicit picker choice can seed new chats/trees (CAN-838 follow-up).
 */
export const CHAT_BILLING_FRAMEWORKS = ['subscription', 'ai-credits'] as const;
export type ChatBillingFramework = (typeof CHAT_BILLING_FRAMEWORKS)[number];

/**
 * Unified most-recently-used chat/worktree context. Drives startup routing
 * (`PreferencesData.lastActiveContext`) so the app can restore either a
 * worktree chat or a cowork chat without a separate `defaultStartupPage`
 * setting.
 */
export type LastActiveContext =
  | { kind: 'worktree'; workspaceId: string; worktreeId: string }
  | {
      kind: 'cowork';
      workspaceId: string;
      /**
       * The cowork Work Entry that was active, when known. Optional for
       * backward compatibility with contexts persisted before Work Entries;
       * restore falls back to the workspace's first available entry.
       */
      workEntryId?: string;
    };

/**
 * Availability policy for background Code Graph generation, surfaced on the
 * Settings → Labs page.
 *
 * - `'enabled'`  — generation runs for every workspace.
 * - `'disabled'` — generation is turned off everywhere.
 * - `'selected-workspaces'` — generation runs only for the workspaces listed
 *   in {@link CodeGraphPreferences.selectedWorkspaceIds}.
 *
 * Browser-safe (string literals only) so the renderer Experiments UI can
 * import it without pulling in Node-only code.
 */
export type CodeGraphPreferenceMode =
  | 'enabled'
  | 'disabled'
  | 'selected-workspaces';

/**
 * Complete Code Graph feature preferences. This object is treated atomically
 * across the {@link IPC_CHANNELS.preferencesSave} boundary — see the
 * cross-boundary invariant documented on {@link PreferencesData.codeGraph}.
 *
 * Contract both sides honor:
 * - Default value is
 *   `{ mode: 'enabled', selectedWorkspaceIds: [], generationTimeoutMinutes: 30 }`.
 * - `generationTimeoutMinutes` is a whole number in the inclusive range 1–1440.
 *
 * Browser-safe (only strings/numbers/arrays) so the renderer imports it freely.
 */
export interface CodeGraphPreferences {
  mode: CodeGraphPreferenceMode;
  selectedWorkspaceIds: string[];
  generationTimeoutMinutes: number;
}

/**
 * "Allow project agents to use App Advisor chats and create automations" availability. `enabled`
 * allows every project owner; `selected-owners` allows only
 * {@link AppAdvisorProjectAgentAccess.selectedOwners}; `disabled` allows none.
 */
export type AppAdvisorProjectAgentAccessMode =
  | 'enabled'
  | 'selected-owners'
  | 'disabled';

/**
 * Complete App Advisor project-agent access preference. Governs whether code
 * and cowork agents of a project owner may use App Advisor tools and create
 * App Advisor prompt automations. Default (missing or invalid):
 * `{ mode: 'enabled', selectedOwners: [] }`. Saves carry the complete object,
 * like {@link CodeGraphPreferences}.
 */
export interface AppAdvisorProjectAgentAccess {
  mode: AppAdvisorProjectAgentAccessMode;
  selectedOwners: ProjectOwnerContext[];
}

/** Billed providers whose native account changes revert AI Credits routing. */
export type NativeAccountProvider = 'claude' | 'codex';

/** Last confirmed native account for one billed provider (CAN-4200). */
export interface NativeProviderAccountRecord {
  /** Normalized identity from `providerAccountKey`. */
  accountKey: string;
  /** ms since epoch of the last observed change to a different account. */
  changedAt?: number;
  /** Start of the last successful account-bound usage read with included headroom. */
  subscriptionRestoredAt?: number;
}

/**
 * A Browser-bar search engine, as in Chrome: a name and a URL template whose
 * `%s` is replaced with the encoded search words.
 */
export interface BrowserSearchEngine {
  readonly id: string;
  readonly name: string;
  readonly urlTemplate: string;
}

export interface PreferencesData extends TerminalDrawerPreferences {
  /** Last confirmed native account per billed provider, main-owned (CAN-4200). */
  nativeProviderAccounts?: Partial<
    Record<NativeAccountProvider, NativeProviderAccountRecord>
  >;
  personalWorkspaceCatalogSync: 'off' | 'private';
  personalCatalogOfferSeen: boolean;
  personalCatalogNotice: 'collision' | 'removed' | 'full' | 'failed' | null;
  /** Where organization project setups clone to, once the member picks. */
  orgProjectDefaultDestinationRoot?: string;
  /** Which transport an organization project clone uses. */
  orgProjectCloneProtocol?: 'https' | 'ssh';
  /** Opt-in to the app-managed pinned Cursor runtime. */
  cursorEnabled?: boolean;
  /** App-local Google opt-out; leaves the native Google account signed in. */
  googleSubscriptionDisconnected?: boolean;
  /** Written by the main process only; renderer saves drop it. */
  copilotEnabled?: boolean;
  opencodeEnabled?: boolean;
  /**
   * Whether the account proxy is turned on (Settings > Multi-account proxy).
   * On by default. The `canopy-desktop-account-proxy` flag must also be on.
   */
  accountProxyEnabled?: boolean;
  /**
   * Set when the user chose `accountProxyEnabled` with the Settings switch,
   * so that choice holds whether or not a connection is saved. Without it
   * the value came from the retired Labs opt-in, which stored `false` for
   * everyone, and counts as off only beside a saved connection.
   */
  accountProxyEnabledSetByUser?: boolean;
  /**
   * The person's choice for the one-window work (CAN-7750), Settings → Labs
   * → One window for all computers. Absent until they choose; the build
   * then decides (see `resolveOneWindowEnabled`). Belongs to this computer:
   * saves from a paired computer drop it.
   */
  oneWindowEnabled?: boolean;
  /**
   * The proxy this device connects to. Written by the main process only (the
   * management key lives in secure storage, keyed by `id`); renderer saves
   * that include it are rejected.
   */
  accountProxyConnection?: AccountProxyConnection | null;
  /**
   * "Keep a chat on one account": a chat stays on one proxy account until it
   * reaches a limit. On unless the user turned it off.
   */
  accountProxyKeepChatOnOneAccount?: boolean;
  /**
   * Route Claude and Codex sessions (chats, subagents, pipeline steps,
   * helpers) through the connected account proxy. On unless turned off;
   * nothing routes until a proxy is connected.
   */
  accountProxyRouteClaude?: boolean;
  accountProxyRouteCodex?: boolean;
  /**
   * Start the proxy on this device when the app starts, while it is the
   * connection. On unless the user turned it off (CAN-4023).
   */
  accountProxyLocalStartWithApp?: boolean;
  /**
   * The account order chosen for the proxy on this device, written into its
   * config on every start. Written by the main process only; unset means the
   * proxy's default, round robin.
   */
  accountProxyLocalRoutingStrategy?: AccountProxyRoutingStrategy;
  /**
   * The signed-in Copilot account pin. Written by the main process only;
   * renderer saves that include it are rejected.
   */
  copilotAccount?: CopilotAccount;
  /** Main-owned durable vault selection. Null is damaged authority, never legacy. */
  copilotVaultSelection?: CopilotHostSelection | null;
  /** Executable path for the local Cursor approval-check diagnostic. */
  cursorAgentPath?: string;
  /** Default layout mode snapshotted only when a new workspace entity is created. */
  workspaceDefaultLayoutMode: WorkspaceLayoutMode;
  /** Full width removes the shared chat and composer reading caps. */
  chatWidth?: 'default' | 'full';
  /**
   * Code vs Work navigation mode (CAN-1817). Seeded from the onboarding role
   * (engineering roles → `code`, everything else → `work`, no role → `code`)
   * and overridable in Settings → General. Work mode hides repository and
   * branch controls from the default setup path; internal data models never
   * change. Defaults to `code` so existing installs keep every control.
   */
  navigationMode: NavigationMode;
  worktreePanelPercent: number;
  activityPanelExpanded: boolean;
  activityPanelWidthPercent: number;
  kanbanWorktreePanelPercent: number;
  kanbanActivityPanelExpanded: boolean;
  kanbanActivityPanelWidthPercent: number;
  kanbanChatPanelVisible: boolean;
  /**
   * When true, the unified sidebar is fully hidden. Previously this
   * controlled only the icon-rail collapsed state; it now hides the entire
   * sidebar (icon rail plus the Code Workspaces / Cowork Projects sections).
   */
  sidebarCollapsed: boolean;
  /** Ordering mode for the top-level Projects section. */
  sidebarProjectSortMode?: SidebarSortMode;
  /**
   * Unified sidebar width in px. Clamped by the main-process preferences
   * normalizer to `SIDEBAR_MIN_WIDTH`..`SIDEBAR_MAX_WIDTH`, defaulting to
   * `DEFAULT_SIDEBAR_WIDTH` (see `constants/preferences`).
   */
  sidebarWidth: number;
  /**
   * Whether the unified workspace-list sidebar section is collapsed. Covers
   * both git workspaces and blended Cowork workspace rows.
   */
  sidebarCodeSectionCollapsed: boolean;
  /**
   * Whether the top-level "Chats" sidebar section (the default cowork
   * workspace's Work Entries, CAN-2363) is collapsed. The key predates that
   * section — it was the retired "Cowork Projects" section flag — and is
   * reused so the persisted preference shape stays stable.
   */
  sidebarCoworkSectionCollapsed: boolean;
  /** Whether the Orchestrator's chat list under its sidebar row is collapsed. */
  sidebarOrchestratorCollapsed: boolean;
  /** Left-nav ordering and main-nav/More split. Normalized on read. */
  sidebarNavLayout: SidebarNavLayout;
  branchNamePrefixMode: BranchNamePrefixMode;
  branchNameCustomPrefix: string;
  deleteBranchOnArchive: boolean;
  archiveOnMerge: boolean;
  /**
   * When true (default), the worktree sidebar visually nests child branches
   * (worktrees whose base branch is another worktree's branch) under their
   * base-branch worktree. When false, the sidebar shows the flat list with no
   * grouping. Individual worktrees can override this via
   * {@link WorktreeData.branchGroupingOverride}.
   */
  groupChildBranchesWithBase: boolean;
  defaultChatProvider: AgentProviderType;
  defaultChatModelByProvider: ModelDefaultsByProvider;
  defaultWorktreeProvider: AgentProviderType;
  defaultWorktreeModelByProvider: ModelDefaultsByProvider;
  /** Per-surface default tool-approval mode, applied when a chat/tab has no explicit override. */
  approvalDefaults: ApprovalDefaults;
  /** Exact installed Claude plugin content that the person admitted to run Mods. */
  claudeModAdmissions: ClaudeModAdmission[];
  /** Personal kill switch for Claude plugin Mods; leaves settings hooks intact. */
  claudeModsDisabled: boolean;
  /** User-authored approval rules that apply across every workspace ("global" scope). */
  globalApprovalRules: ApprovalRule[];
  /** Whether the user has dismissed the one-time upgrade notice introducing the tool-approval system. */
  approvalsUpgradeNoticeDismissed: boolean;
  /**
   * Onboarding tips the user dismissed, with when (CAN-4904). A tip listed
   * here stays hidden until "Show tips again" in Settings clears the record.
   * The web Portal reads and writes it through the paired desktop.
   */
  onboardingTipsDismissed: OnboardingTipDismissals;
  suggestions: SuggestionsState;
  /**
   * Most recent fully-resolved lane across BOTH default scopes, retained while
   * auth, policy, or catalog facts reload.
   *
   * Scope-agnostic consumers only (the startup prewarm, and the renderer's
   * pre-preferences fallback seed). Anything answering "what lane does THIS
   * scope resolve to?" must read {@link lastResolvedDefaultLaneByScope}: the
   * worktree and chat defaults can prefer different providers, so one shared
   * slot let a Codex chat send hand a Claude-defaulted worktree the wrong
   * provisional lane on the next loading window. Kept as the migration seed for
   * preference files written before the per-scope map existed.
   */
  lastResolvedDefaultLane?: BillingLane;
  /** Last fully-resolved lane per default scope. See {@link lastResolvedDefaultLane}. */
  lastResolvedDefaultLaneByScope?: {
    chat?: BillingLane;
    worktree?: BillingLane;
  };
  /** Until the user picks one, follows {@link defaultSummaryModel}. */
  summaryModel: ChatModel;
  /** Whether the chat-description model was explicitly selected by the user. */
  summaryModelSetByUser?: boolean;
  summaryThinkingLevel: ThinkingLevel;
  handoffSummaryModel: ChatModel;
  handoffSummaryThinkingLevel: ThinkingLevel;
  worktreeSummaryEnabled: boolean;
  worktreeSummaryModel: ChatModel;
  worktreeSummaryThinkingLevel: ThinkingLevel;
  planDiagramModel: ChatModel;
  planDiagramThinkingLevel: ThinkingLevel;
  codeReviewModel: ChatModel;
  codeReviewThinkingLevel: ThinkingLevel;
  prGenerationModel: ChatModel;
  prGenerationThinkingLevel: ThinkingLevel;
  prInstructions: string;
  prInstructionMode: PrInstructionMode;
  commitGenerationModel: ChatModel;
  commitGenerationThinkingLevel: ThinkingLevel;
  commitInstructions: string;
  commitInstructionMode: PrInstructionMode;
  branchNamingModel: ChatModel;
  branchNamingThinkingLevel: ThinkingLevel;
  branchNamingInstructions: string;
  /**
   * Global Instructions configured on the Models settings page. Two sections
   * (chats, pipelines), each with one overall instruction plus ordered scoped
   * instructions narrowed by harness/model (chats also by workspace type)
   * with append/replace modes. Resolved at agent-session creation into a
   * "User Overall Preferences" system-prompt block; applies only to newly
   * created sessions, never resumed ones.
   */
  globalInstructions: GlobalInstructionsConfig;
  /**
   * Enables automatic Pipeline Advisor starts. When false, Canopy does not
   * start advisor supervisors for new pipeline executions, but manual advisor
   * runs from pipeline details remain available.
   */
  pipelineAdvisorEnabled: boolean;
  /**
   * Whether Slack requests from the person's own Slack link may start
   * Orchestrator turns on this computer (CAN-7604). Off by default. Set on
   * this computer in Settings → Integrations, where turning it on also turns
   * on `allowIncoming`, which every Slack request needs; browser, mobile and hosted
   * controllers can't change it (a full desktop controller, which can change
   * anything here, can). Read on every hosted Slack send, so turning it off
   * refuses the next one. It gates sends only: transcript reads and turn
   * status stay available so in-flight turns can finish and be read.
   */
  slackOrchestratorRequestsEnabled: boolean;
  /** Injects organization memory into eligible interactive chat turns. */
  orgMemoryInjectionEnabled: boolean;
  /**
   * Enables the local memory store and injection. Opt-in (defaults to
   * `false`); while enabled, harness-native provider memory is suppressed
   * (CAN-1969).
   */
  localMemoryEnabled: boolean;
  /** Opt-in transcript extraction; the rollout flag must also be enabled. */
  localMemoryLearnFromChats: boolean;
  // True once the user has explicitly set localMemoryEnabled (Settings
  // toggle or App Advisor action); lets migrations distinguish a deliberate
  // opt-out from an incidentally materialized default.
  localMemoryEnabledSetByUser: boolean;
  /**
   * Model every local memory helper run uses: consolidation, rebuild, and the
   * chat history profile. Independent of the chat description model. Until
   * the user picks one, it follows {@link defaultLocalMemoryModel}.
   */
  localMemoryModel: ChatModel;
  /** Whether the local memory model was explicitly selected by the user. */
  localMemoryModelSetByUser?: boolean;
  localMemoryThinkingLevel: ThinkingLevel;
  /**
   * Model used by the Pipeline Advisor (persistent supervisor) when it runs
   * its periodic and final turns. Stored as `ChatModel` to align with every
   * other model preference; the backend normalizes the runtime value, falling
   * back to {@link DEFAULT_PIPELINE_ADVISOR_MODEL} for invalid or Ollama
   * selections. Ollama models are not selectable as Pipeline Advisor providers.
   */
  pipelineAdvisorModel: ChatModel;
  /**
   * Thinking level for the Pipeline Advisor. Invalid values normalize to
   * `'high'` (the default).
   */
  pipelineAdvisorThinkingLevel: ThinkingLevel;
  /**
   * Pipeline ids the user has disabled. Disabled pipelines still appear on the
   * Pipelines management page (so they can be re-enabled) but are excluded from
   * every pipeline run picker (dispatch / plan_ready / task_ready trigger
   * modals, hook-action pipeline picker, and the App Advisor pipeline list).
   *
   * This is a global, user-local denylist keyed by `PipelineInfo.id`, so it
   * works for read-only sources (bundled, shared) that cannot store an
   * `enabled` flag in their own file/record. Absence means enabled; everything
   * is enabled by default.
   */
  disabledPipelineIds: string[];
  /**
   * Model used by the App Advisor (the local Canopy assistant). Stored as
   * `ChatModel` so it agrees with every other model preference. The backend
   * falls back to {@link DEFAULT_APP_ADVISOR_MODEL} when the persisted value
   * is unsupported (e.g. a removed Ollama model).
   */
  appAdvisorModel: ChatModel;
  /**
   * Thinking level for the App Advisor. Invalid values normalize via
   * {@link normalizePersistedThinkingLevel} (e.g. legacy `'auto'` migrates to
   * `'high'`).
   */
  appAdvisorThinkingLevel: ThinkingLevel;
  /**
   * Model used by the Automations page to translate natural-language schedule
   * descriptions into five-field cron expressions. Kept separate from App
   * Advisor so users can choose a cheaper/faster structured-output helper.
   */
  cronGenerationModel: ChatModel;
  /**
   * Thinking level for cron-expression generation.
   */
  cronGenerationThinkingLevel: ThinkingLevel;
  /**
   * Model used by the Automations page to translate natural-language
   * descriptions into automation If Commands. Kept separate from cron
   * generation so users can pick a different structured-output helper.
   */
  ifCommandGenerationModel: ChatModel;
  /** Thinking level for If Command generation. */
  ifCommandGenerationThinkingLevel: ThinkingLevel;
  /** Minimum total changed lines (additions + deletions) before the Split PR affordance appears. */
  splitPrThresholdLines: number;
  /** Master toggle for the Split PR feature. */
  splitPrEnabled: boolean;
  /** Model for the Split PR planner query. Same value domain as {@link PreferencesData.prGenerationModel}. */
  splitPrPlannerModel: ChatModel;
  /** Thinking level for the Split PR planner query. */
  splitPrPlannerThinkingLevel: ThinkingLevel;
  /**
   * Global default plugin selections. Never copied into workspace or chat
   * files: chat-facing plugin resolution overlays these selections at read
   * time (`local ∪ (global − tombstones)`), so adding a global default makes
   * it effective everywhere on the next send, and removing one withdraws it
   * everywhere unless a scope also selected it locally. Individual chats and
   * workspaces suppress a global default durably via
   * {@link PluginSelectionTombstones}.
   *
   * Optional for compatibility with preferences files and renderer fixtures
   * created before this setting was introduced; the backend normalizer always
   * supplies an empty selection object at runtime.
   */
  globalPluginSelections?: ChatTabPluginSelections;
  /** Canonical installed-item keys. MCP uses its authoritative enabled flag. */
  disabledInstalledItems?: string[];
  pendingInstalledItemUninstalls?: Array<{
    target: InstalledItemUninstallTarget;
    refs: InstalledItemRef[];
    /** Device-only custody retry. Absent on legacy intents; stages live in the receipt. */
    mcpRemoval?: McpRemovalRecovery;
  }>;
  /** Local recovery state; never project source paths to a remote client. */
  parkedCodexPlugins?: Array<{
    key: string;
    pluginId: string;
    pluginName: string;
    marketplacePath: string | null;
    remoteMarketplaceName: string | null;
    version?: string;
    state: 'parking' | 'parked' | 'restoring';
    sourceDigest?: string;
    marketplaceSourceDigest?: string;
  }>;
  /** Seen curated names. Missing means legacy preferences; first scan records names without changing selections. */
  initializedCuratedPluginDefaults?: string[];
  /**
   * Plugin selections applied when sending a message from the App Advisor
   * dialog. Mirrors {@link ChatTabPluginSelections} so the App Advisor can
   * load the same plugin bundles that worktree chats do.
   */
  appAdvisorPluginSelections: ChatTabPluginSelections;
  /**
   * Whether the embedded pipeline-editor chat drawer is visible. The drawer is
   * default-visible; the concrete `true` default and the `normalizePreferences`
   * fallback live in the backend slice (`preferences-store.ts`). Declared
   * optional here because this transport slice owns only the type declaration —
   * the backend slice populates `DEFAULT_PREFERENCES` / normalization so the
   * value is always present at runtime.
   */
  pipelineChatPanelVisible?: boolean;
  /**
   * Persisted width of the pipeline-editor chat drawer as a percentage of the
   * page width. The concrete default (e.g. `30`) and the 20–65 clamp live in
   * the backend slice (`preferences-store.ts`). Optional for the same reason as
   * {@link pipelineChatPanelVisible}.
   */
  pipelineChatPanelWidthPercent?: number;
  /**
   * Plugin selections applied when sending a message from the pipeline-editor
   * chat drawer. Mirrors {@link ChatTabPluginSelections}; the
   * `createEmptyPluginSelections()` default and normalization live in the
   * backend slice (`preferences-store.ts`). Optional for the same reason as
   * {@link pipelineChatPanelVisible}.
   */
  pipelineEditorPluginSelections?: ChatTabPluginSelections;
  /**
   * Legacy-named persisted bounds for the standalone App Advisor window
   * (relative to the primary display). The preference key was retained
   * from the original floating-dialog implementation to avoid a
   * preference migration; today it stores `BrowserWindow` bounds for the
   * standalone App Advisor window. `null` means the window should fall
   * back to the default size and position.
   */
  appAdvisorDialogBounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  /** Whether the Work Entries navigation in the App Advisor window is collapsed. */
  appAdvisorNavCollapsed?: boolean;
  /**
   * When true, Codex multi-agent (`spawnAgent`/`sendInput`/...) tool calls
   * are enabled inside the App Advisor's runtime. Defaults to `false` so the
   * App Advisor avoids spawning long-running subagents by accident.
   */
  codexMultiAgentAppAdvisorEnabled: boolean;
  providerModelConfigDefaults: Partial<
    Record<AgentProviderType, AgentModelConfig>
  >;
  /**
   * Default per-chat Fast Mode state for newly created Codex chats. This maps
   * to the app-server priority service tier at the Codex boundary.
   *
   * @deprecated Use providerModelConfigDefaults.codex.speed. Legacy alias
   * read after the default record's `speed` and `fastMode`.
   */
  codexFastModeDefaultEnabled: boolean;
  branchDisplayMappings: BranchDisplayMapping[];
  reviewCommitMessage: boolean;
  rtkEnabled: boolean;
  /**
   * When true, chat turns that fail with a transient provider error
   * (`provider_temporarily_unavailable`) are automatically retried with
   * backoff. Defaults to `true` (default applied in the main-process
   * preferences store).
   */
  autoRetryTransientErrorsChats: boolean;
  /**
   * When true, pipeline executions paused by a transient provider error
   * (`provider_temporarily_unavailable`) are automatically resumed with
   * backoff. Defaults to `true` (default applied in the main-process
   * preferences store).
   */
  autoRetryTransientErrorsPipelines: boolean;
  agentRebaseResolutionEnabled: boolean;
  /**
   * Whether Merge on a pull request whose base branch uses a merge queue
   * starts an agent chat to oversee the merge. Defaults to
   * `when_hook_absent` (default applied in the main-process preferences
   * store). See {@link MergeQueueAgentHandling}.
   */
  mergeQueueAgentHandling: MergeQueueAgentHandling;
  /** When null, the agent chat falls back to `defaultWorktreeModel`. */
  agentRebaseResolutionModel: ChatModel | null;
  /** When null, the agent chat falls back to `defaultWorktreeThinkingLevel`. */
  agentRebaseResolutionThinkingLevel: ThinkingLevel | null;
  scriptTimeoutMinutes: number;
  codexAppServerIdleTimeoutMinutes: number;
  /**
   * Minutes an open chat on the Claude harness (Claude, or Ollama on the
   * Claude harness) stays idle before its `claude` process is released; the
   * next message resumes the conversation.
   */
  claudeSessionIdleTimeoutMinutes: number;
  /**
   * Default {@link ChatInterfaceMode} applied to newly-created Claude-backed
   * worktree chats. Honored by:
   *
   *   - the chat-store `createTab` / `createTabWithId` actions when the
   *     chosen model resolves to provider `'claude'`,
   *   - the chat-store `setModel` action when the user swaps a not-yet-
   *     started Claude tab from Codex/Ollama into a Claude model,
   *   - the main-process `launchHookChat` helper when the hook's resolved
   *     model is Claude.
   *
   * Codex- and Ollama-backed chats ignore this preference because the
   * managed Claude Code terminal experience is Claude-specific.
   */
  defaultChatInterfaceMode: ChatInterfaceMode;
  /**
   * Default {@link ChatInterfaceMode} applied to newly-created Claude-backed
   * standalone chats. This is intentionally separate from
   * {@link defaultChatInterfaceMode} so standalone chat projects can default
   * to a different Claude surface than worktree chats.
   */
  defaultStandaloneChatInterfaceMode: ChatInterfaceMode;
  /**
   * Default {@link ChatInterfaceMode} applied to newly-created Claude-backed
   * App Advisor chats. Kept separate from worktree and standalone defaults so
   * the global assistant can use a different Claude surface.
   */
  defaultAppAdvisorInterfaceMode: ChatInterfaceMode;
  /**
   * macOS-only guard for Claude Code's native `caffeinate` sleep inhibitor.
   * When true, managed Claude Code terminal/worker launches prepend a
   * runtime-local no-op `caffeinate` shim. Ignored on non-macOS platforms.
   */
  preventClaudeNativeCaffeinate: boolean;
  /** Claude SDK chat turn cap (1–9999, default 500). Null disables the cap. */
  claudeMaxTurns: number | null;
  /** Maximum concurrently active chat turns. Null disables the chat concurrency cap. */
  maxActiveChatTurns: number | null;
  /** Maximum concurrently active pipeline executions. Null disables the pipeline cap. */
  maxActivePipelineExecutions: number | null;
  /**
   * Execution mode for Canopy background/helper Claude work (branch naming,
   * commit messages, PR generation, worktree/chat/archive summaries). `'canopy'`
   * runs these in-process via the Claude SDK; `'terminal'` runs them as managed
   * Claude Code CLI terminal sessions surfaced on the Claude Workers page.
   * Defaults to `'canopy'`. The runtime guard and default live in the
   * main-process preferences store.
   */
  canopyBackgroundProcessesMode: 'canopy' | 'terminal';
  /**
   * Execution mode for pipeline `builtin/agent-prompt` steps. `'canopy'` runs
   * them in-process via the Claude SDK; `'terminal'` runs them as managed Claude
   * Code CLI terminal sessions (workers). Defaults to `'canopy'`.
   */
  pipelinesMode: 'canopy' | 'terminal';
  /**
   * Maximum number of Claude Worker terminal sessions allowed to run
   * concurrently; additional workers queue until a slot frees. Defaults to `5`
   * and is clamped to a sane range (1–16) by the main-process preferences
   * normalizer.
   */
  workerConcurrencyLimit: number;
  /** When false, memory pressure diagnostics still run but do not block new work. */
  memoryPressureGuardEnabled: boolean;
  /** When true, critical pressure may suspend idle Codex app servers before their idle timeout. */
  bypassCodexAppServerIdleTimeoutUnderCriticalPressure: boolean;
  /** Canopy RSS threshold for elevated memory diagnostics. */
  memoryPressureWarningThresholdBytes: number;
  /** Canopy RSS threshold that blocks new guarded work when the guard is enabled. */
  memoryPressureCriticalThresholdBytes: number;
  /** When true, active chat turns and pipeline runs prevent supported platforms from idle sleeping. */
  keepSystemAwakeWhileAgentsActive: boolean;
  /** Opt-in managed delegation for macOS, Windows, and Linux Code worktree chats. */
  managedDelegationMode?: ManagedDelegationMode;
  /** Maximum active managed children per parent chat; defaults to 5 (1–64). */
  managedDelegationMaxConcurrent?: number;
  managedDelegationMaxDepth?: number;
  /** Lifetime retained-result limit for managed delegation; defaults to the shipped cap. */
  managedDelegationLifetimeLimit?: number;
  /** Allowed models for managed delegates; absent means All models, every route. */
  managedDelegationModelPolicy?: ManagedDelegationModelPolicy;
  codexMultiAgentWorktreeChatsEnabled: boolean;
  codexMultiAgentStandaloneChatsEnabled: boolean;
  codexMultiAgentPipelinesEnabled: boolean;
  /** Concurrent Codex subagents per session, excluding the primary; null uses Codex defaults. */
  codexMaxConcurrentSubagents?: number | null;
  /** Default deferred-tools permission for newly-created worktree chats. */
  deferredToolsWorktreeChatsEnabled?: boolean;
  /** Default deferred-tools permission for newly-created cowork chats. */
  deferredToolsStandaloneChatsEnabled?: boolean;
  /** Default deferred-tools permission for newly-created App Advisor chats. */
  deferredToolsAppAdvisorEnabled?: boolean;
  /** Default deferred-tools permission for newly-created Pipeline Assistant chats. */
  deferredToolsPipelineAssistantEnabled?: boolean;
  lastOpenApp: string;
  disabledOpenApps: string[];
  /**
   * Legacy MRU worktree-selection fields. Superseded by `lastActiveContext`
   * as the read source for startup routing, but still written by the
   * existing chatStore `selectWorktree` path (cheap, preserves rollback) and
   * still consulted as a read-fallback when `lastActiveContext` is null.
   */
  lastSelectedWorktreeProjectId: string;
  lastSelectedWorktreeId: string;
  /**
   * Unified most-recently-used chat/worktree context, used to drive startup
   * routing. Replaces `defaultStartupPage`. `null` means nothing to restore
   * (startup lands on the Home surface).
   */
  lastActiveContext: LastActiveContext | null;
  executionDetailViewMode: 'list' | 'flow';
  worktreeViewMode: 'list' | 'kanban';
  /**
   * Workspace IDs to hide from the worktree list and kanban views.
   * Empty array means all workspaces are visible (the "select all" state).
   */
  worktreeFilterHiddenWorkspaceIds: string[];
  auditRetentionDays: number;
  /** Number of days to retain durable per-automation run history. */
  automationRunRetentionDays?: number;
  /**
   * How UD AI Credits are used as an LLM-routing fallback (CAN-771). Optional on
   * the interface for back-compat with persisted/constructed preferences that
   * predate this field; `normalizePreferences` always fills a concrete value
   * (default `'off'`).
   */
  aiCreditsRoutingMode?: AiCreditsRoutingMode;
  /**
   * The user's last explicit "Use AI Credits" picker choice, used to seed new
   * chat tabs and worktrees so their billing preference is remembered across
   * new chats/trees (CAN-838 follow-up). Optional/unset means "never chosen" —
   * new chats fall back to today's behavior (the `aiCreditsRoutingMode` safety
   * net). `normalizePreferences` leaves this unset when absent/invalid; it is
   * intentionally NOT part of `DEFAULT_PREFERENCES`.
   */
  lastChatBillingFramework?: ChatBillingFramework;
  theme: ThemeName;
  colorMode: ColorMode;
  /**
   * Legacy sidebar material, retained for older clients and persisted objects.
   * Current renderers ignore it: the sidebar is opaque in every mode.
   */
  sidebarAppearance?: SidebarAppearance;
  /**
   * Number formatting for worktree diff stats in the left navigation.
   * Optional for compatibility; normalization always supplies `short`.
   */
  worktreeDiffStatsStyle?: WorktreeDiffStatsStyle;
  /**
   * Visibility policy for scrollbar affordances. Optional for compatibility
   * with preferences written before the setting existed; normalization always
   * supplies the default `system` value.
   */
  scrollbarBehavior?: ScrollbarBehavior;
  /**
   * Whether chat and Markdown previews render `$...$` as inline math
   * (CAN-5124). Optional for compatibility; normalization supplies `true`.
   * `\(...\)`, `\[...\]`, `$$...$$` and math fences render either way.
   */
  singleDollarMath?: boolean;
  /**
   * Whether the empty composer offers the provider's predicted next message
   * after a completed Claude or Codex turn, for Tab to fill in. Optional for
   * compatibility; normalization supplies `true`.
   */
  promptSuggestionsEnabled?: boolean;
  /**
   * Chat transcript enrichment for Linear and GitHub references, set per
   * provider. Optional for compatibility; normalization supplies each
   * provider's default independently (Linear `replace`, GitHub `hover`).
   */
  linearChatEnrichmentMode?: ChatEnrichmentMode;
  githubChatEnrichmentMode?: ChatEnrichmentMode;
  /**
   * Interface scale, in percent. Applied as a uniform Electron page zoom on
   * every window; 50–200, snapped to 5% steps by `normalizePreferences`. See
   * `@canopy/desktop-shared/lib/ui-scale`.
   */
  uiScale: number;
  /**
   * "Agents add to the Feed" (LD09): whether agent sessions get the Ledger
   * tools and recording prompt while `canopy-ledger-enabled` is on. On by
   * default. A session decides whether to offer the tools when it starts, but
   * every call re-checks this value, so turning it off also stops agents in
   * open chats; turning it on reaches the next session. It never changes
   * existing entries, the Ledger panel, the Feed or entries the user writes.
   * While a preferences read is degraded the tools treat it as off. Optional
   * for compatibility with earlier preferences; normalization always supplies
   * a boolean.
   */
  ledgerAgentRecordingEnabled?: boolean;
  /**
   * Legacy repeated-task switch (CAN-4009), retained only when a boolean was
   * already stored. CAN-4343 migrates its opt-out to suggestions.enabled.
   * Legacy-only saves change the master, but keep this value unchanged for
   * downgrades; fresh profiles omit it. New callers use updateSuggestions.
   */
  repeatTaskAutomationSuggestionsEnabled?: boolean;
  /**
   * Settings → Plugins → "Suggest skills for repeated requests" (CAN-385).
   * On by default, and only effective while the suggestions master and
   * `canopy-desktop-skill-suggestions` are on and the category is not dismissed. Off deletes the local request
   * fingerprints, clears pending suggestions and resets the 30-day backfill;
   * resolved suggestions stay resolved. Independent of `localMemoryEnabled`,
   * which only picks the model a scan uses. Optional for compatibility with
   * earlier preferences; normalization always supplies a boolean.
   */
  skillSuggestionsEnabled?: boolean;
  /**
   * Experiment: load the main and App Advisor windows from the privileged
   * `app-renderer://bundle` scheme instead of `file://`, so V8 can keep a
   * code cache across launches. Off by default; turned on from Settings →
   * Labs and applied at the next launch, which first moves the
   * renderer's origin-keyed storage to the new origin. Normalization reads
   * anything but `true` as `false`. See `docs/desktop-app-performance.md`
   * § Renderer code cache.
   */
  rendererCodeCacheSchemeEnabled?: boolean;
  /**
   * Appearance → "Chat detail": how much of an agent's work a chat shows
   * (`detailed`, `recent` or `compact`). Preferences saved before the
   * setting existed move over once from the retired switches: "Show only
   * recent steps" (`chatLiveStepWindowEnabled`, CAN-4274) on reads as
   * `recent`, "Group tool calls" (`chatGroupToolCallsEnabled`) on as
   * `compact`, anything else as the default `recent`.
   */
  chatDetail?: ChatDetail;
  windowBounds: WindowBounds | null;
  windowMaximized: boolean;
  windowFullScreen: boolean;
  ollamaServerPort: number;
  /**
   * Persisted Ollama connection mode. `managed` lets the app own the
   * `ollama serve` child (validated executable path) while reusing an
   * already-reachable server; `manual` connects to `127.0.0.1:<port>` only and
   * never launches/terminates/installs Ollama.
   *
   * The default (`managed` when absent) and load-time normalization live in
   * the main-process preferences store.
   */
  ollamaConnectionMode: OllamaConnectionMode;
  /**
   * Absolute path to the validated Ollama executable used in `managed` mode.
   * Empty string means "not yet resolved" (the default).
   *
   * Default placement and load-time normalization live in the main-process
   * preferences store.
   */
  ollamaExecutablePath: string;
  mcpProxyPort: number;
  hideAnthropicNav: boolean;
  inAppNotifications: InAppNotificationPreferences;
  osNotifications: OsNotificationPreferences;
  /**
   * When true, edits made to files in worktree file tabs are auto-saved.
   * Defaults to `false` so users opt in explicitly.
   */
  fileAutoSave: boolean;
  /**
   * Restricts in-app network navigation to loopback HTTP(S) servers. Local
   * file navigation remains available in either mode.
   * Defaults to `false`, allowing any valid HTTP(S) URL or local file.
   */
  inAppBrowserLocalServersOnly?: boolean;
  /**
   * The search engine the Browser bar uses when what was typed is not an
   * address: a built-in engine id or one of
   * {@link inAppBrowserCustomSearchEngines}. An unknown id searches Google.
   */
  inAppBrowserSearchEngineId?: string;
  /** Search engines the user added, each a name and a `%s` URL template. */
  inAppBrowserCustomSearchEngines?: BrowserSearchEngine[];
  /**
   * Routes ordinary app content links to the selected worktree's built-in
   * browser. Authentication and explicit external-browser actions bypass it.
   * Independent of `useAsSystemDefaultBrowser`. Defaults to `false`.
   */
  openAppLinksInBuiltInBrowser?: boolean;
  /**
   * Asks the OS to make this app the default HTTP(S) handler, so links opened
   * in other apps arrive in the selected worktree's built-in browser.
   * Independent of `openAppLinksInBuiltInBrowser`. Defaults to `false`.
   */
  useAsSystemDefaultBrowser?: boolean;
  voiceDictationEnabled: boolean;
  /**
   * Windows-only: closing the last window hides to the tray instead of
   * quitting, so background work and scheduled notifications survive
   * (CAN-1967 phase 4). macOS already keeps the app alive on window close by
   * platform convention, so this preference has no effect there.
   */
  closeToTray: boolean;
  /**
   * OS-level shortcut that focuses, restores, and raises the main window
   * from any application (CAN-1963). Off until the user turns it on from the
   * Getting started checklist or Settings → Shortcuts.
   */
  globalFocusShortcutEnabled: boolean;
  /**
   * The chord for {@link globalFocusShortcutEnabled}, as an Electron
   * accelerator in the canonical form produced by `normalizeAccelerator`
   * (`CommandOrControl+Shift+O` by default). The normalizer falls back to
   * the default for anything the strict parser rejects.
   */
  globalFocusShortcut: string;
  /**
   * Quiet window for post-install activation campaigns (CAN-2438). Scoped to
   * lifecycle nudges only — agent, pipeline, and terminal notifications
   * intentionally ignore it, because a user waiting on a long run at night
   * wants that notification.
   */
  activationQuietHours: ActivationQuietHours;
  /** Master and per-category opt-ins for promotional notifications. */
  promotionalNotifications: PromotionalNotificationPreferences;
  /**
   * ISO-8601 stamp of the one-time "still running in the tray" disclosure, so
   * it is shown once rather than on every close.
   */
  closeToTrayDisclosedAt?: string;
  /**
   * ISO-8601 stamp of the last time the OS itself refused to present a
   * notification (CAN-2793). Distinct from `osNotifications.enabled`: that is
   * Canopy's own gate, this records the OS gate, which Electron gives no way
   * to query and only reports asynchronously when a post fails. Absent means
   * "no refusal observed", never "authorized" -- a fresh install has simply
   * not asked yet. Cleared as soon as a notification is presented again.
   */
  osNotificationsDeniedAt?: string;
  /**
   * ISO-8601 timestamp of the first notification-offer answer or explicit
   * master-toggle choice. Local to this preference profile and permanent,
   * including across checklist resets. Main preserves the first valid stamp.
   */
  osNotificationOfferAnsweredAt?: string;
  branchNamingPluginSelections: ChatTabPluginSelections;
  commitGenerationPluginSelections: ChatTabPluginSelections;
  prGenerationPluginSelections: ChatTabPluginSelections;
  worktreeSummaryPluginSelections: ChatTabPluginSelections;
  /**
   * Marketplace plugin keys (`${marketplaceId}/${pluginName-lowercased}`) for
   * which Claude→Codex compatibility mode is disabled. Such plugins are skipped
   * when resolving plugins for Codex sessions. Claude usage is unaffected.
   */
  codexCompatDisabledPlugins: string[];
  /**
   * Global default for which side handles HTTP MCP auth when no per-server
   * override is present. See {@link McpHttpAuthHandler}.
   */
  mcpHttpAuthDefaultHandler: McpHttpAuthHandler;
  /**
   * Controls which globs are excluded from the search-oriented file index
   * (Cmd+P / `@` mentions). Built-in globs are opted-in by default; users can
   * disable individual built-ins by id and add their own custom patterns.
   */
  fileIndexing: FileIndexingPreferences;
  /**
   * Controls which glob patterns are used to detect plan files in a worktree.
   * Built-in rules are opted-in by default; users can disable individual
   * built-ins by id and add their own custom include/exclude patterns.
   */
  planDetection: PlanDetectionPreferences;
  /**
   * Ordered file-label classification buckets used to group changed files
   * (Tests, Documentation, ...). Stored like `branchDisplayMappings`: the
   * full ordered array including built-in buckets, merged with the seeded
   * definitions on read via `mergeFileLabelsWithBuiltins`. Empty array means
   * "seeded defaults, untouched".
   */
  fileLabels: FileLabelBucket[];
  /**
   * File-label ids hidden in the Changed Files card and Review Changes file
   * tree. Empty array means every label (including the synthetic "other"
   * bucket) is visible.
   */
  changedFilesHiddenLabelIds: string[];
  /**
   * When true, Canopy automatically downloads new updates in the background
   * once they are detected, without prompting the user. The user is still
   * asked to restart to install. When false, Canopy waits for an explicit
   * Download click before fetching.
   */
  autoDownloadUpdates: boolean;
  /**
   * When true (the default), the updater looks for new versions at launch and
   * on its periodic timers. When false, it checks only when the user asks.
   * Read inside the timer callbacks, so a change applies at the next tick.
   */
  automaticUpdateChecks: boolean;
  /**
   * When true, the renderer surfaces the resource-monitor diagnostics pill in
   * the UI. The pill subscribes to live snapshots emitted on
   * `IPC_CHANNELS.resourceMonitorSnapshot`. Defaults to `true`; users can
   * hide the pill by setting this preference to `false`.
   */
  showDiagnosticsPill: boolean;
  /**
   * Opt-in memory diagnostics in the main process: allocation sampling,
   * automatic dumps near the heap limit, and on-demand memory reports.
   * Defaults to `false`; while off, nothing runs.
   */
  memoryDiagnosticsEnabled: boolean;
  /**
   * Ordered list of onboarding flow version markers the user has completed
   * or exited. Currently a single value 'v1' is written on completion or
   * confirmed exit; future revisions append additional version tags.
   */
  onboardingCompleted: string[];
  /**
   * Last automatically presented or silently recorded release identity
   * (`major.minor.patch`). Main enforces a monotonic watermark inside its
   * write queue: a save can raise it but never lower or clear it, so a stale
   * renderer write cannot roll back history. There is deliberately no reset
   * path; replaying the dialog is Settings > Canopy > "What's new", which
   * never touches this value. A corrupt (unparseable) stored value counts as
   * no history and is overwritten by the next valid save.
   */
  releaseHighlightsLastSeenVersion: string | null;
  /**
   * Discovery channel chosen on the onboarding attribution step (CAN-1009).
   * Absent until the user answers; skipping the step records nothing. This
   * transport slice owns only the type declaration — the main-process
   * preferences store owns load-time normalization (invalid ids are dropped)
   * and intentionally supplies no default.
   */
  attributionSource?: AttributionSourceId;
  /**
   * Free-text detail entered when `attributionSource` is `'other'` (CAN-1009).
   * Trimmed and length-clamped by the main-process normalizer. Absent when
   * empty. User-authored content — never sent to telemetry.
   */
  attributionSourceDetail?: string;
  /**
   * Role chosen on the onboarding role/intent step (CAN-1009). Absent until
   * the user answers; skipping records nothing. Normalization mirrors
   * `attributionSource` (invalid ids dropped, no default).
   */
  profileRole?: ProfileRoleId;
  /**
   * Full multi-select role answer from the Home onboarding suggestions
   * module's role tiles. `profileRole` stays the single primary role (the
   * first selected in `PROFILE_ROLES` order) for every existing consumer —
   * cloud profile sync, curated recommendations, telemetry — while this
   * array preserves the complete selection for role-driven queue filtering.
   * Absent until the user submits; invalid ids dropped, deduped, no default.
   */
  profileRoles?: ProfileRoleId[];
  /**
   * Free-text detail entered when `profileRole` is `'other'` (CAN-1009).
   * Trimmed and length-clamped by the main-process normalizer. Absent when
   * empty. User-authored content — never sent to telemetry.
   */
  profileRoleDetail?: string;
  /**
   * Optional free-text "what are you hoping to get done" intent captured on
   * the onboarding role/intent step (CAN-1009). Trimmed and length-clamped by
   * the main-process normalizer. Absent when empty. User-authored content —
   * never sent to telemetry.
   */
  profileIntent?: string;
  /**
   * ISO-8601 timestamp of when the user accepted the first-run guest consent
   * (CAN-934). Set when the user chooses "Get started" on the first-run consent
   * screen. Absent until consent is recorded. Consent is recorded locally even
   * when the guest mint call must be retried later (offline first launch).
   */
  guestConsentAcceptedAt?: string;
  /**
   * The `CONSENT_TOS_VERSION` the user agreed to when accepting guest consent
   * (CAN-934). Lets a future copy revision re-prompt only users on an older
   * version. Absent until consent is recorded.
   */
  guestConsentTosVersion?: string;
  /**
   * Number of app launches observed while the saved cloud credential is a guest
   * credential (CAN-936, WS3). Incremented once per launch by the main process
   * when `credentialSource === 'guest'`. Drives the soft upgrade nudge's
   * session threshold. Absent on older preference files; `normalizePreferences`
   * fills a concrete `0` default.
   */
  guestSessionCount?: number;
  /**
   * The `guestSessionCount` value at which the soft upgrade nudge was last
   * shown (CAN-936, WS3). Used to snooze the nudge so it does not reappear until
   * another threshold of guest sessions has elapsed. Absent until the nudge has
   * been shown at least once; `normalizePreferences` fills a concrete `0`
   * default.
   */
  guestUpgradeNudgeLastShownSessionCount?: number;
  /**
   * ISO-8601 deadline until which desktop mobile-install promotions are
   * snoozed. Absent until the signed-in user dismisses a promotion.
   */
  mobileInstallCueSnoozedUntil?: string;
  /**
   * Read-only legacy input for CAN-4008/#5222's independent plan-mode migration.
   * Remove after that converter is integrated; never use for checklist UI.
   */
  homeOnboardingSuggestions?: LegacyPlanModeChecklistInput;
  /**
   * Local plan-mode lesson state. Save a patch through the authoritative
   * preference writer: retirement merges within a generation; a higher
   * generation resets it. Keep the version marker after reset so legacy
   * checklist progress cannot retire the lesson again.
   */
  planModeHint?: PlanModeHintRecord;
  /**
   * Local GitHub star nudge state: accepted chat sends and its one-time
   * retirement. Save a patch through the authoritative preference writer,
   * which merges it so the count never drops and retirement is permanent.
   */
  githubStarPrompt?: GitHubStarPromptRecord;
  /**
   * ISO-8601 timestamp of when the user accepted the first-run legal consent
   * (Terms of Service / Privacy Policy). Unlike guest consent, this blocking
   * acceptance is required on every first run regardless of guest-mode or
   * cloud-sign-in flags — the app shell stays gated until it is recorded.
   * Absent until consent is recorded.
   */
  legalConsentAcceptedAt?: string;
  /**
   * The `CONSENT_TOS_VERSION` the user agreed to when accepting the first-run
   * legal consent. Lets a future copy revision re-prompt only users on an older
   * version. Absent until consent is recorded.
   */
  legalConsentTosVersion?: string;
  /**
   * ISO-8601 timestamp of when the member confirmed the Welcome gate's "What
   * you share" choices. Absent until the gate saves it, so profiles that
   * accepted consent before the choices were shown can be told apart.
   */
  dataChoicesConfirmedAt?: string;
  /**
   * Main-derived: true when the commit that first recorded legal consent
   * turned Usage analytics from on to off. While true, the daily anonymous
   * opt-out ping does not send. Incoming patch values are ignored;
   * normalization clears it once Usage analytics is on.
   */
  usageAnalyticsDeclinedAtOnboarding: boolean;
  /**
   * Organization ID → signature of the required data-sharing scope set last
   * shown in the one-time organization requirement notice. Merged per key by
   * the main-owned writer. An empty map is meaningful: the member's existing
   * requirements were seeded and later changes should show the notice.
   */
  orgSharingNoticesSeen?: Record<string, string>;
  /**
   * Per-data-type visibility for desktop→server telemetry sync. The persisted
   * fallback is `'off'` on every plan; nothing rewrites it when the plan
   * changes.
   */
  dataSharingOptInHints?: Partial<
    Record<DataSharingOptInFeature, { dismissedAt: string }>
  >;
  dataSharingOptInHistory?: DataSharingOptInHistoryEntry[];
  /**
   * Usage-data switches (Settings → Privacy → Usage data). All default to
   * `true`. Organization prohibitions narrow the effective value in main but
   * never rewrite this stored choice.
   */
  usageData: UsageDataPreferences;
  telemetrySharing: TelemetrySharingPreferences;
  /**
   * @deprecated No longer written; read-tolerated so older `preferences.json`
   * files normalize.
   */
  telemetrySharingTier?: 'free' | 'paid';
  /**
   * Gates the one-time post-link telemetry opt-in modal shown in Settings →
   * Account on the unlinked→linked Canopy Cloud transition. Set to `true`
   * once the user confirms or dismisses the prompt so it does not reappear.
   */
  telemetrySharingPromptSeen: boolean;
  /**
   * Absolute path to the user's resolved Git executable. Persisted locally and
   * re-validated on each startup so detection survives restarts. Empty string
   * means "not yet resolved" (the default). The store wiring — default value
   * and load-time normalization — lives in the main-process preferences store;
   * this is the shared type contract only.
   */
  gitExecutablePath: string;
  /**
   * Code Graph feature preferences surfaced on the Settings → Labs
   * page (mode, per-workspace selection, generation timeout). See
   * {@link CodeGraphPreferences} for the field contract; the default is
   * `{ mode: 'enabled', selectedWorkspaceIds: [], generationTimeoutMinutes: 30 }`.
   *
   * **Cross-boundary save invariant** ({@link IPC_CHANNELS.preferencesSave}):
   * the save channel carries a `Partial<PreferencesData>` **patch** that the
   * write path shallow-merges over the existing file and then re-normalizes.
   * Because of that shallow merge + re-normalize, whenever a save patch
   * includes `codeGraph` it MUST carry the *complete* {@link CodeGraphPreferences}
   * object (all of `mode`, `selectedWorkspaceIds`, and
   * `generationTimeoutMinutes` together) — any omitted sub-field is reset to
   * its default, silently wiping the workspace selection or resetting the
   * timeout.
   *
   * Declared optional here because this transport slice owns only the type
   * declaration — the main-process preferences store owns the concrete default
   * value ({@link CodeGraphPreferences} above) and load-time normalization, so
   * the value is always present at runtime.
   */
  codeGraph?: CodeGraphPreferences;
  /**
   * Settings > App Advisor "Allow project agents to use App Advisor chats and create automations".
   * Absent or invalid values mean `{ mode: 'enabled', selectedOwners: [] }`;
   * nothing is written on upgrade. Save patches that include this field carry
   * the complete {@link AppAdvisorProjectAgentAccess} object. Only the user
   * changes it: no App Advisor or agent action writes this field.
   */
  appAdvisorProjectAgentAccess?: AppAdvisorProjectAgentAccess;
}

/**
 * One glob matcher inside a file-label bucket. Matchers are evaluated in
 * array order within their bucket; the first enabled matcher that matches a
 * file assigns the bucket's label. `stopMatching` ("do not keep matching")
 * ends the whole classification for that file so no later bucket can add
 * more labels. Built-in matcher ids are stable and must never change once
 * shipped; user-added matchers carry generated ids.
 */
export interface FileLabelMatcher {
  id: string;
  pattern: string;
  enabled: boolean;
  stopMatching: boolean;
  builtin: boolean;
}

/**
 * One file-classification bucket (Tests, Documentation, Configuration, ...).
 * Buckets are evaluated in array order — the persisted order is the priority
 * order. A file can collect multiple labels unless a matching bucket has
 * `stopFurtherLabels` (or the matching matcher has `stopMatching`). Built-in
 * buckets can be toggled, reordered, and extended with custom matchers but
 * keep their seeded name; user buckets are fully editable and deletable.
 * Files matching no enabled bucket fall into the synthetic "Other" label
 * (see `OTHER_FILE_LABEL_ID` in `src/file-labels.ts`).
 */
export interface FileLabelBucket {
  id: string;
  name: string;
  enabled: boolean;
  stopFurtherLabels: boolean;
  builtin: boolean;
  matchers: FileLabelMatcher[];
}

/**
 * Global tier — mirrors {@link FileIndexingPreferences}. Attached to
 * {@link PreferencesData} as `planDetection`. Only built-ins are disabled by
 * id here; global custom rules are toggled via their own `enabled` flag.
 */
export interface PlanDetectionPreferences {
  disabledBuiltinRuleIds: string[];
  customRules: PlanDetectionRule[];
}

/**
 * Persisted Ollama operating mode.
 *
 * - `managed` — the app uses a validated executable path and owns the
 *   `ollama serve` child it launches, while reusing an already-reachable
 *   server on the configured port.
 * - `manual` — the app only connects to `127.0.0.1:<port>` and never launches,
 *   terminates, installs, or updates Ollama.
 */
export type OllamaConnectionMode = 'managed' | 'manual';

/** Exact legacy preference input retained until CAN-4008/#5222 conversion lands. */
export interface LegacyPlanModeChecklistInput {
  startedAt: string;
  entries: {
    'plan-mode'?: {
      dismissedAt?: string;
      completedAt?: string;
    };
  };
}
