import { isCodexContextWindowSetting } from './lib/codex-context-window';
import type { CodexContextWindowSetting } from './lib/codex-context-window';
import { codexSpeedFastMode, isCodexSpeed } from './lib/codex-speed';
import type { CodexSpeed } from './lib/codex-speed';
import type { ConfiguredModelBillingMetadata } from './model-catalog';
import { isThinkingLevel } from './thinking';
import type { BrowserLoadStatus } from './types/browser';
import type { McpHttpAuthPreference } from './types/mcp-servers';
import type { UsageInitiationSource } from './types/observability';
import type { ThinkingLevel } from './types/thinking';
import type { AgentProviderType } from '@canopy/agent-transcript';
import type { AiGatewayHarness } from '@canopy/protocol/ai-gateway-models';
import type {
  GatewayModelConfig,
  GatewayModelEntry,
} from '@canopy/protocol/llm-gateway';
import type { AutoResumeReason } from '@canopy/protocol/portal';
import type {
  CommandShellDefinition,
  ScriptDevServerPattern,
  ScriptLifecyclePhase,
} from '@canopy/protocol/scripts';
import type { TryItCapability } from '@canopy/protocol/try-it';

/**
 * Local ownership binding of a workspace to an organization project
 * (CAN-2954, plan chapter 03). Absent means Personal. Written by the
 * materialization coordinator when a catalog project is set up on this
 * device; readers only ever stamp it onto sidebar and snapshot rows.
 */
export interface WorkspaceOwnerBinding {
  type: 'organization';
  /** Organization external id (lower-case UUID). */
  organizationId: string;
  /** Tracked workspace (project definition) external id. */
  projectId: string;
  /** Workspace instance external id claimed for this checkout. */
  instanceId: string;
  bindingGeneration: number;
}

/**
 * Durable record of an existing workspace converted between owners
 * (CAN-3415). Written only by the organization-project conversion and its
 * move back in Electron main; absent means the workspace was never converted.
 * `movedBackAt` marks a workspace that was moved back to its previous owner,
 * which automatic conversion (CAN-3416) must never convert again.
 */
export interface WorkspaceOwnershipTransfer {
  version: 1;
  /** The owner before the conversion. Only Personal workspaces convert. */
  previousOwner: { type: 'personal' };
  /** Organization external id (lower-case UUID) the workspace moved to. */
  organizationId: string;
  /** Organization project (tracked workspace) external id. */
  projectId: string;
  convertedAt: string;
  /** Set when the workspace was moved back to `previousOwner`. */
  movedBackAt?: string;
}

export const DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES = 10;

export interface AgentModelConfig {
  thinkingLevel?: ThinkingLevel;
  /**
   * Requested Codex speed; the source of truth when present. Canonical writes
   * pair it with the derived `fastMode` (see `lib/codex-speed.ts`).
   */
  speed?: CodexSpeed;
  /**
   * Legacy compatibility projection, always `speed === 'fast'` on canonical
   * writes and never `true` for `ultrafast`. Read only as a fallback when
   * `speed` is absent. An explicit boolean command without `speed` replaces
   * the speed (true → Fast, false → Regular).
   */
  fastMode?: boolean;
  /**
   * Requested Codex context window. Absent uses the provider default, then
   * the model's own window (`lib/codex-context-window.ts`).
   */
  contextWindow?: CodexContextWindowSetting;
}

/**
 * The usage-data switches under Settings → Privacy → Usage data. Every flow
 * defaults on; turning one off stops that flow. The main-process usage-data
 * policy combines these with the selected organization's prohibitions.
 */
export const USAGE_DATA_KEYS = [
  'productAnalytics',
  'sessionReplay',
  'errorReports',
  'activeUseSignal',
  'featureFlagIdentity',
  'skillSafetyCheck',
] as const;

/** One usage-data switch. */
export type UsageDataKey = (typeof USAGE_DATA_KEYS)[number];

/**
 * The usage-data switches an organization admin can turn off for members.
 * Prohibitions only narrow; they never turn a flow on. The skill safety check
 * is the member's choice alone.
 */
export const ORG_PROHIBITABLE_USAGE_DATA_KEYS = [
  'productAnalytics',
  'sessionReplay',
  'errorReports',
  'activeUseSignal',
  'featureFlagIdentity',
] as const satisfies readonly UsageDataKey[];

/** One usage-data switch an organization can prohibit. */
export type OrgProhibitableUsageDataKey =
  (typeof ORG_PROHIBITABLE_USAGE_DATA_KEYS)[number];

/** The member's stored usage-data choices. `true` means the flow may send. */
export type UsageDataPreferences = Record<UsageDataKey, boolean>;

/** Why a usage-data flow is turned off by policy rather than by the member. */
export interface UsageDataProhibitionSource {
  /**
   * The organization that turned it off, or `null` while main fails closed:
   * the stored account can't be read (until the next successful policy
   * check), or, with `preferencesUnreadable`, the stored preferences can't.
   */
  organizationName: string | null;
  /**
   * Set while the member's stored preferences can't be read, so their own
   * opt-out is unknown. Lasts until a preferences save or restart.
   */
  preferencesUnreadable?: true;
}

/**
 * Main's effective usage-data policy, as delivered to renderers. `effective`
 * is `preferences` narrowed by `prohibitedBy`, resolved for the selected
 * workspace context.
 */
export interface UsageDataPolicySnapshot {
  /**
   * The stored choices. While they can't be read this holds the defaults;
   * `prohibitedBy` (with `preferencesUnreadable`) and `effective` say so.
   */
  preferences: UsageDataPreferences;
  effective: UsageDataPreferences;
  prohibitedBy: Partial<
    Record<OrgProhibitableUsageDataKey, UsageDataProhibitionSource>
  >;
}

export interface UsageLimitedChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

export type AccountChangeResumeReason = Exclude<
  AutoResumeReason,
  'auth_recovery'
>;

/** A single chat surfaced by `listUsageLimitedIdleChats`, grouped by workspace. */
export interface UsageLimitedChatItem extends UsageLimitedChatTarget {
  accountProxyConnectionId?: string;
  provider: AgentProviderType;
  chatTitle: string;
  detectedAt: number;
  resetsAt?: number;
  /** Missing only for legacy persisted usage-limit entries. */
  resumeReason?: AccountChangeResumeReason;
  authenticationAttemptId?: string;
  /**
   * Display name of the chat's worktree (`label ?? branchName ?? worktreeId`),
   * used to group and identify worktree chats under a per-worktree sub-header.
   * Empty for cowork workspaces, which have no branches and render flat.
   */
  worktreeName: string;
  /** Preview only; execution re-evaluates its existing prompt policy. */
  resumePromptKind?: 'continue' | 'resend_user_message';
  /** Last persisted invocation in the current turn, not proof it was interrupted. */
  lastStep?: {
    toolName: string;
    detail?: string;
    /**
     * true requires an unambiguous matching later result with isError false.
     * false requires positive evidence the invocation did not finish; current
     * transcript evidence does not establish this, so previews never derive it.
     * Missing/error/unspecified or ambiguous results leave this absent. Even a
     * synthetic interruption records no outcome, not proof of no side effects.
     * Completion describes this invocation, not the original request.
     */
    finished?: boolean;
  };
}

/**
 * Shape of the Claude SDK thinking options produced by
 * {@link buildClaudeThinkingOptions}.
 *
 * - `thinking` uses the current SDK shape (`disabled` / `adaptive`), with
 *   summarized display so supported Claude models return visible thinking text.
 * - `effort` is the typed SDK option (`low | medium | high | xhigh | max`).
 * - `settings` carries session flag settings that have no first-class SDK
 *   option (currently only `ultracode`). It merges into the SDK's `--settings`
 *   layer.
 * - `extraArgs` is available for CLI passthroughs that are not represented as
 *   first-class SDK options.
 */
export interface ClaudeThinkingSdkOptions {
  thinking: { type: 'disabled' } | { type: 'adaptive'; display: 'summarized' };
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  settings?: { ultracode?: boolean };
  extraArgs?: Record<string, string | null>;
}

/**
 * Build the Claude SDK option payload for a requested thinking level.
 *
 * - `off` → disabled thinking, no effort.
 * - `ultra` → adaptive thinking with the session-scoped `ultracode` flag
 *   setting. The Claude SDK has no `ultra` effort value: ultracode is the
 *   verified mechanism (`Settings.ultracode` — "xhigh effort plus standing
 *   dynamic-workflow orchestration"), so effort is pinned to `xhigh` per the
 *   SDK contract and the extra capability comes from the orchestration layer.
 * - everything else → adaptive thinking with the typed `effort` field.
 */
export function buildClaudeThinkingOptions(
  level: ThinkingLevel,
): ClaudeThinkingSdkOptions {
  if (level === 'off') {
    return { thinking: { type: 'disabled' } };
  }
  if (level === 'ultra') {
    return {
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: 'xhigh',
      settings: { ultracode: true },
    };
  }
  return {
    thinking: { type: 'adaptive', display: 'summarized' },
    effort: level,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeAgentModelConfig(
  value: unknown,
): AgentModelConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const config: AgentModelConfig = {};
  if (
    typeof value.thinkingLevel === 'string' &&
    isThinkingLevel(value.thinkingLevel)
  ) {
    config.thinkingLevel = value.thinkingLevel;
  }
  if (isCodexSpeed(value.speed)) {
    // A valid speed is authoritative; the boolean is re-derived so a
    // persisted Ultra fast record can never project `fastMode: true`.
    config.speed = value.speed;
    config.fastMode = codexSpeedFastMode(value.speed);
  } else if (typeof value.fastMode === 'boolean') {
    // Legacy read: an invalid or missing speed falls back to the boolean.
    config.fastMode = value.fastMode;
  }
  if (isCodexContextWindowSetting(value.contextWindow)) {
    config.contextWindow = value.contextWindow;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

/** Serializable app-server capability root selected for a Codex thread. */
export interface CodexSelectedCapabilityRoot {
  id: string;
  location: {
    type: 'environment';
    environmentId: string;
    path: string;
  };
}

export interface ChatTabPluginSelections {
  /** Catalog selections awaiting installation/auth; never runtime filesystem refs. */
  unresolvedCapabilities?: TryItCapability[];
  /**
   * IDs of locally-saved Collections (formerly "Bundles") attached to this
   * chat. Persisted writes emit only `collectionIds`; the legacy
   * {@link ChatTabPluginSelections.bundleIds} alias is preserved for read-side
   * migration from older persisted state and must not be written by new
   * code.
   */
  collectionIds: string[];
  /**
   * @deprecated Read only for migration from older persisted state. The
   * normalization helper merges any legacy `bundleIds` into `collectionIds`
   * and drops this field on output.
   */
  bundleIds?: string[];
  skillRefs: { sourceId: string; skillName: string }[];
  pluginRefs: { marketplaceId: string; pluginName: string }[];
  mcpServerRefs?: { serverId: string; configId: string }[];
  /**
   * Per-server overrides for the HTTP MCP auth handler scoped to this
   * chat/worktree's plugin selections. Each entry pairs an
   * {@link McpHttpAuthTarget} with the {@link McpHttpAuthHandler} that should
   * be used in place of the global default.
   *
   * Intentionally NOT counted in {@link hasAnySelections} — overrides alone
   * should not flip an empty selection set into an active one, because that
   * would cause plugin discovery and resolution to run for chats that have
   * no actual plugin/MCP refs.
   */
  mcpHttpAuthPreferences?: McpHttpAuthPreference[];
}

/**
 * Explicit local rejections of inherited plugin defaults, persisted per scope.
 * A workspace config's tombstones suppress
 * {@link PreferencesData.globalPluginSelections} entries for the workspace; a
 * chat tab's tombstones suppress everything the chat inherits (its
 * workspace's `defaultPluginSelections` and the surviving global defaults). A
 * tombstoned entry stays excluded even when the same resource is later
 * re-added as a default, which is what makes a local "turn this default off"
 * durable. Tombstones only suppress inherited layers; they never remove a
 * scope's own local selections. Entries use the same identity granularity as
 * {@link ChatTabPluginSelections}; `mcpHttpAuthPreferences` are not
 * selections and cannot be tombstoned.
 */
export interface PluginSelectionTombstones {
  collectionIds?: string[];
  skillRefs?: { sourceId: string; skillName: string }[];
  pluginRefs?: { marketplaceId: string; pluginName: string }[];
  mcpServerRefs?: { serverId: string; configId: string }[];
}

export type TrackedPlanSource =
  | 'copilot'
  | 'antigravity'
  | 'opencode'
  | 'cursor'
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'pipeline'
  | 'imported'
  | 'detected';

export type TrackedPlanReviewStatus = 'pending' | 'approved' | 'dismissed';

export type PlanEditSource = 'agent' | 'pipeline';

export interface TrackedPlanListRequest {
  projectId: string;
  worktreeId: string;
}

export interface TrackedPlanGetRequest extends TrackedPlanListRequest {
  planId: string;
}

export interface CreateTrackedPlanRequest extends TrackedPlanListRequest {
  proposalRequestId?: string;
  source: TrackedPlanSource;
  content: string;
  /**
   * Optional explicit plan id. When provided, the plan is created with this id;
   * if a plan with this id already exists in the worktree it is returned
   * unchanged (idempotent). Used to promote a pending plan-mode tab into a
   * persisted tracked plan while keeping the tab's `trackedPlanId` consistent.
   */
  id?: string;
  title?: string;
  reviewStatus?: TrackedPlanReviewStatus;
  linkedExecutionId?: string;
  chatId?: string;
  sourceFilePath?: string;
  sourceRepoId?: string;
  initiationSource?: UsageInitiationSource;
}

export interface UpdateTrackedPlanRequest extends TrackedPlanGetRequest {
  proposalRequestId?: string;
  content?: string;
  title?: string;
  source?: TrackedPlanSource;
  reviewStatus?: TrackedPlanReviewStatus;
  linkedExecutionId?: string;
  approvedAt?: string | null;
  dismissedAt?: string | null;
  hidden?: boolean;
  chatId?: string;
  initiationSource?: UsageInitiationSource;
  lastEditSource?: PlanEditSource;
}

export interface ScriptDescriptor {
  scriptKey: string;
  scriptName: string;
  label: string;
  command: string;
  lifecycle: ScriptLifecyclePhase | 'custom';
  target: 'project' | 'workspace-repo' | 'workspace-root';
  repoId?: string;
  repoName?: string;
  /**
   * Optional dev-server URL pattern(s) carried alongside the script command on
   * every IPC `started` / `output` / `complete` event. The main process and
   * the renderer both populate this from `getScriptDevServerPattern` against
   * the same effective scripts map so optimistic-start descriptors agree with
   * the descriptors the main process emits.
   *
   * Streaming output events MUST preserve `devServerPattern` even when
   * stripping `command`, otherwise the renderer would silently lose the
   * pattern attached at start time.
   */
  devServerPattern?: ScriptDevServerPattern;
  shell?: CommandShellDefinition;
  /** True when this run is backed by a worktree terminal PTY. */
  interactive?: true;
}

export interface ScriptStartedEvent {
  projectId: string;
  worktreeId: string;
  /** Stable identity for one execution across start, output, and completion. */
  runId?: string;
  script: ScriptDescriptor;
  invocation:
    | 'automatic-setup'
    | 'manual-run'
    | 'manual-lifecycle'
    | 'workspace-lifecycle';
}

/** API-only gateway catalog row kept separate from managed registries. */
export interface AiGatewayModelEntry extends ConfiguredModelBillingMetadata {
  id: string;
  cursorModelId?: string;
  label: string;
  description?: string;
  showMoreOnly?: boolean;
  recommendedHarness: AiGatewayHarness;
  contextWindow: number;
  supportsPromptCaching: boolean;
  supportsImages?: boolean;
  supportedThinkingLevels: ThinkingLevel[];
  toolSchemaProfile: GatewayModelConfig['toolSchemaProfile'];
  family?: string;
  familyLabel?: string;
  vendor?: string;
  sortOrder?: number;
}

/** Serializable gateway route metadata; contains no credentials or prompts. */
export type GatewayRouteEntry = GatewayModelEntry;

export type ResourceGroupId =
  | 'app'
  | 'browser'
  | 'codex'
  | 'claude'
  | 'chat'
  | 'pipelines'
  | 'terminal'
  | 'scripts'
  | 'other';

export type ResourceProcessKind =
  | 'electron-main'
  | 'electron-renderer'
  | 'electron-utility'
  | 'electron-gpu'
  | 'in-app-browser'
  | 'codex-app-server-pool'
  | 'pipeline-execution'
  | 'pipeline-step'
  | 'chat-provider'
  | 'terminal'
  | 'script'
  | 'hook'
  | 'other';

export interface CodexPoolResourceMetadata {
  poolKeyLabel: string;
  pooled: boolean;
  clientCount: number;
  activeTurnCount: number;
  initialized: boolean;
}

export interface PipelineResourceMetadata {
  executionId: string;
  pipelineId?: string;
  pipelineName?: string;
  jobId?: string;
  childId?: string;
  stepId?: string;
  attempt?: number;
  iteration?: number;
}

export interface BrowserResourceMetadata {
  projectId: string;
  worktreeId: string;
  browserId: string;
  title?: string;
  displayUrl?: string;
  visible: boolean;
  status: BrowserLoadStatus;
}

export interface ScriptResourceMetadata {
  projectId: string;
  worktreeId: string;
  scriptKey: string;
  scriptName: string;
  scriptLabel: string;
  target: ScriptDescriptor['target'];
  repoId?: string;
  repoName?: string;
  invocation?: ScriptStartedEvent['invocation'];
}

export type ResourceMetadata =
  | { type: 'codex-pool'; codexPool: CodexPoolResourceMetadata }
  | { type: 'pipeline'; pipeline: PipelineResourceMetadata }
  | { type: 'browser'; browser: BrowserResourceMetadata }
  | { type: 'script'; script: ScriptResourceMetadata }
  | { type: 'generic' };

/**
 * Terminal statuses a `worktree_pipeline_completion` watcher will treat as a
 * consuming fire trigger. Paused executions also notify watchers, but pause is
 * non-consuming and intentionally not part of this filter.
 */
export type AppAdvisorPipelineTerminalStatus =
  | 'success'
  | 'failure'
  | 'cancelled';

/**
 * Optional watcher setup embedded in actions that start asynchronous work.
 * The action target itself supplies the watched chat/pipeline ids; callers
 * only provide watcher metadata and, for pipeline runs, optional terminal
 * status filtering. Pipeline pause notifications are sent regardless of this
 * filter and leave the watcher active.
 */
export interface AppAdvisorInlineWatcherSetup {
  label?: string;
  followUpInstruction?: string;
  allowDuplicate?: boolean;
  terminalStatuses?: AppAdvisorPipelineTerminalStatus[];
}

/**
 * Destination chat the watcher posts its follow-up message to when it fires.
 *
 * `projectId` and `worktreeId` identify the chat that receives the fired
 * message. App Advisor tools always use the App Advisor sentinel destination;
 * worktree-scoped Canopy tools use the current worktree chat as destination.
 * Provider tools must never accept destination fields from the model — the
 * backend captures them from the active chat runtime.
 *
 * `delegationId` is set only for watchers a managed delegate created through
 * its app tools. The triple still names the delegate's root chat, which keeps
 * worktree scoping, cleanup, and the user's watcher list on that chat, but the
 * fired message is delivered to the delegate as a host message, never to the
 * chat. Only that delegate's watcher tools can list or delete such a watcher.
 */
export interface AppAdvisorWatcherDestination {
  projectId: string;
  worktreeId: string;
  chatId: string;
  chatTitle?: string;
  delegationId?: string;
  /**
   * Display-only name and depth of the `delegationId` delegate, captured when
   * it created the watcher. Never part of the recipient identity.
   */
  delegationDescription?: string;
  delegationDepth?: number;
}
