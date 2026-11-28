import type { ConfiguredModelBillingMetadata } from './model-catalog';
import type { BrowserLoadStatus } from './types/browser';
import type { UsageInitiationSource } from './types/observability';
import type { ThinkingLevel } from './types/thinking';
import type { AgentProviderType } from '@canopy/agent-transcript';
import type { AiGatewayHarness } from '@canopy/protocol/ai-gateway-models';
import type {
  GatewayModelConfig,
  GatewayModelEntry,
} from '@canopy/protocol/llm-gateway';
import type { AutoResumeReason } from '@canopy/protocol/remote-control/shell';
import type {
  CommandShellDefinition,
  ScriptDevServerPattern,
  ScriptLifecyclePhase,
} from '@canopy/protocol/scripts';

export { normalizeAgentModelConfig } from '@canopy/protocol/agent-model-config';
export type { AgentModelConfig } from '@canopy/protocol/agent-model-config';
export type {
  ChatTabPluginSelections,
  PluginSelectionTombstones,
  SelectionMcpServerRef,
  SelectionPluginRef,
  SelectionSkillRef,
} from '@canopy/protocol/plugins/selections';
export {
  ORG_PROHIBITABLE_USAGE_DATA_KEYS,
  USAGE_DATA_KEYS,
} from '@canopy/protocol/usage-data';
export type {
  OrgProhibitableUsageDataKey,
  UsageDataKey,
  UsageDataPolicySnapshot,
  UsageDataPreferences,
  UsageDataProhibitionSource,
} from '@canopy/protocol/usage-data';

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

export { DEFAULT_CODEX_APP_SERVER_IDLE_TIMEOUT_MINUTES } from '@canopy/protocol/preferences';

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

/** Serializable app-server capability root selected for a Codex thread. */
export interface CodexSelectedCapabilityRoot {
  id: string;
  location: {
    type: 'environment';
    environmentId: string;
    path: string;
  };
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
