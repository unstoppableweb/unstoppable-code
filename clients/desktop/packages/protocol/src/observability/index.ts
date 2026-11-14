// Audit and usage record contracts for execution observability (CAN-4136).
// They describe what the observability ingest stores and serves, so any host
// (desktop main today, the core daemon later) shares one definition. The
// desktop-shared `types/observability` module re-exports them.
import type { OpenCodeAccountSnapshot } from '../portal';
import type { AgentExecutionHarness } from '../models';
import type { ModelRoutingAttributionV1 } from '../model-routing';

/**
 * The agent providers an audit entry names. Mirrors `AgentProviderType` in
 * `@canopy/agent-transcript`; desktop-shared checks the two stay equal.
 */
export type AgentAuditProvider =
  | 'claude'
  | 'codex'
  | 'ollama'
  | 'cursor'
  | 'opencode'
  | 'copilot'
  | 'antigravity';

/** Mirrors desktop-shared `ModelHarnessSource`. */
export type AgentAuditModelSource =
  | 'claude-managed'
  | 'codex-managed'
  | 'cursor-managed'
  | 'copilot-managed'
  | 'antigravity-managed'
  | 'opencode-managed'
  | 'ai-gateway'
  | 'ollama';

/** Mirrors `FileReference` in `@canopy/agent-transcript`. */
export interface AgentAuditFileReference {
  displayPath: string;
  absolutePath: string;
  repoName?: string;
  /** Opaque host-defined mention kind used by composer send-time handling. */
  kind?: string;
  /** Start offset of the pill in the accompanying serialized text. */
  textStart?: number;
}

/** Mirrors desktop-shared `DeferredResourceSummary`. */
export interface AgentAuditDeferredResource {
  ref: string;
  kind: 'skill' | 'plugin' | 'mcp';
  name: string;
  sourceLabel?: string;
}

type AgentProviderType = AgentAuditProvider;
type ModelHarness = AgentExecutionHarness;
type ModelHarnessSource = AgentAuditModelSource;
type FileReference = AgentAuditFileReference;
type DeferredResourceSummary = AgentAuditDeferredResource;

export type AgentAuditEventType =
  | 'worktree_chat'
  | 'standalone_chat'
  | 'app_advisor'
  | 'pipeline_editor'
  | 'pipeline_agent_turn'
  | 'pipeline_advisor'
  | 'pr_generation'
  | 'pr_split_planning'
  | 'commit_message_generation'
  | 'branch_naming'
  | 'cron_generation'
  | 'automation_if_command_generation'
  | 'worktree_summary'
  | 'chat_summary'
  | 'chat_handoff_summary'
  | 'archive_summary'
  | 'worktree_plan_chat'
  | 'worktree_plan_diagram'
  | 'code_review_annotations'
  | 'code_review_diagram'
  | 'local_memory_consolidation'
  | 'local_memory_chat_profile'
  /** One idle repeat-task skill suggestion scan for one owner partition. */
  | 'skill_suggestion_scan'
  /**
   * One run of a managed delegation, one entry per `(delegationId,
   * runGeneration)`. Not a chat turn: excluded from turn counts.
   */
  | 'managed_delegation';

/**
 * Every `AgentAuditEventType`, mapped to itself. Declaring this as a
 * `Record<AgentAuditEventType, AgentAuditEventType>` makes a new union member a
 * compile error here rather than a value that silently fails to parse at
 * runtime. The values (not the keys) are what `parseAgentAuditEventType`
 * returns, which is how it narrows an arbitrary `string` without a cast.
 */
const AUDIT_EVENT_TYPE_VALUES: Record<
  AgentAuditEventType,
  AgentAuditEventType
> = {
  worktree_chat: 'worktree_chat',
  standalone_chat: 'standalone_chat',
  app_advisor: 'app_advisor',
  pipeline_editor: 'pipeline_editor',
  pipeline_agent_turn: 'pipeline_agent_turn',
  pipeline_advisor: 'pipeline_advisor',
  pr_generation: 'pr_generation',
  pr_split_planning: 'pr_split_planning',
  commit_message_generation: 'commit_message_generation',
  branch_naming: 'branch_naming',
  cron_generation: 'cron_generation',
  automation_if_command_generation: 'automation_if_command_generation',
  worktree_summary: 'worktree_summary',
  chat_summary: 'chat_summary',
  chat_handoff_summary: 'chat_handoff_summary',
  archive_summary: 'archive_summary',
  worktree_plan_chat: 'worktree_plan_chat',
  worktree_plan_diagram: 'worktree_plan_diagram',
  code_review_annotations: 'code_review_annotations',
  code_review_diagram: 'code_review_diagram',
  local_memory_consolidation: 'local_memory_consolidation',
  local_memory_chat_profile: 'local_memory_chat_profile',
  skill_suggestion_scan: 'skill_suggestion_scan',
  managed_delegation: 'managed_delegation',
};

/** Ordered list of every audit event type, derived from the exhaustive map. */
export const AGENT_AUDIT_EVENT_TYPES: readonly AgentAuditEventType[] =
  Object.values(AUDIT_EVENT_TYPE_VALUES);

/**
 * A `Map` rather than plain-object indexing: object lookup would resolve
 * inherited `Object.prototype` keys, so `'constructor'` and `'toString'` would
 * parse as valid event types instead of returning `null`.
 */
const AUDIT_EVENT_TYPE_LOOKUP: ReadonlyMap<string, AgentAuditEventType> =
  new Map(AGENT_AUDIT_EVENT_TYPES.map((eventType) => [eventType, eventType]));

export function parseAgentAuditEventType(
  value: string,
): AgentAuditEventType | null {
  return AUDIT_EVENT_TYPE_LOOKUP.get(value) ?? null;
}

export type AgentAuditStatus =
  | 'running'
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'interrupted';

/**
 * Which chat surface executed an audited chat turn. `'canopy'` is the
 * native SDK-backed chat runtime; `'terminal'` is the managed Claude Code
 * terminal (both the `'claude-code'` and `'auto'` interface modes).
 */
export type AgentAuditChatMode = 'canopy' | 'terminal';

export type AgentAuditPage = 'main' | 'chat' | 'pipelines' | 'audit' | 'usage';

export type AgentAuditLinkKind =
  | 'worktree-chat'
  | 'app-advisor'
  | 'pipeline-editor'
  | 'standalone-chat'
  | 'pipeline-execution';

export interface AgentAuditLinkTarget {
  page: AgentAuditPage;
  kind: AgentAuditLinkKind;
  projectId?: string;
  worktreeId?: string;
  planId?: string;
  chatId?: string;
  pipelineExecutionId?: string;
}

export interface AgentAuditTokenTotals {
  input: number;
  output: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /**
   * Diagnostic subset of `output` tokens spent on model reasoning. Tracked for
   * display only — never double-counted for cost. Older persisted entries omit
   * it; consumers default a missing value to `0`.
   */
  reasoningOutputTokens?: number;
}

export interface AgentAuditToolCounts {
  thinking: number;
  bash: number;
  read: number;
  readLines: number;
  writeEdit: number;
  plan: number;
  fileEdit: number;
  fileAdd: number;
  fileDelete: number;
  search: number;
  grep: number;
  web: number;
  agent: number;
  workflow: number;
  tasks: number;
  taskStop: number;
  skills: number;
  monitor: number;
  claude: number;
  scheduleWakeup: number;
  askUser: number;
  scriptOutput: number;
  watcher: number;
  canopy: number;
  graph: number;
  appAdvisor: number;
  pipelineEditor: number;
  mcp: number;
  other: number;
}

/**
 * Outcome of attempting to price an agent turn against the Canopy-served
 * OpenAI pricing payload.
 *
 * - `'priced'`        — every billable component was priced.
 * - `'partially_priced'` — some components priced, at least one could not be.
 * - `'unpriced'`      — nothing could be priced (model/pricing unavailable).
 *
 * The explicit status + {@link AgentObservedCostReason} replaces the
 * ambiguous `totalCostUsd: 0`, so unpriced turns are never mistaken for free.
 */
export type AgentObservedCostStatus =
  | 'priced'
  | 'partially_priced'
  | 'unpriced';

export type AgentObservedCostReason =
  | 'priced'
  | 'model_not_priced'
  | 'billable_tool_pricing_unavailable'
  | 'pricing_unavailable'
  | 'model_missing'
  | 'unsupported_fast_pricing'
  /**
   * The requested service tier (for example `ultrafast`) has no exact alias in
   * the pricing payload. The turn stays unpriced; it is never estimated with
   * Standard or Fast rates.
   */
  | 'unsupported_service_tier'
  | 'unsupported_usage_shape'
  | 'invalid_pricing_payload';

export interface AgentObservedCostComponent {
  kind: 'tokens' | 'web_search_call' | 'unpriced_tokens' | 'unpriced_tool';
  label: string;
  quantity?: number;
  unit?: 'tokens' | 'calls';
  usd?: number;
  reason?: AgentObservedCostReason;
}

export interface AgentObservedCost {
  status: AgentObservedCostStatus;
  reason: AgentObservedCostReason;
  currency: 'usd';
  totalUsd?: number;
  tokenUsd?: number;
  nonTokenUsd?: number;
  pricingSource?: {
    type: 'canopy_openai_pricing';
    fetchedAt?: string;
    pricingUrl?: string;
    codexPricingUrl?: string;
    codexSpeedUrl?: string;
  };
  pricingBasis?:
    | 'openai_api_standard'
    | 'codex_credit_adjusted_standard_equivalent';
  model?: string;
  /** The requested tier the cost was computed for; never a served tier. */
  serviceTier?: string;
  canonicalServiceTier?: 'standard' | 'fast';
  contextTier?: 'standard' | 'long' | 'unknown';
  contextTierSource?:
    | 'pricing_payload_threshold'
    | 'not_applicable'
    | 'unknown';
  longContextApplied?: boolean;
  fastModeMultiplierApplied?: number;
  components: AgentObservedCostComponent[];
}

/**
 * How a run was paid for, stamped when the entry is finalized. Older entries
 * omit it and readers infer it from `modelGatewayRouted`, `aiCreditsRouted`,
 * the provider and `providerAccountKey`.
 */
export type AgentAuditBillingBasis =
  | 'subscription'
  | 'api_key'
  | 'ai_credits'
  | 'account_proxy'
  | 'org_gateway'
  | 'local'
  | 'unknown';

const AUDIT_BILLING_BASIS_VALUES: Record<
  AgentAuditBillingBasis,
  AgentAuditBillingBasis
> = {
  subscription: 'subscription',
  api_key: 'api_key',
  ai_credits: 'ai_credits',
  account_proxy: 'account_proxy',
  org_gateway: 'org_gateway',
  local: 'local',
  unknown: 'unknown',
};

const AUDIT_BILLING_BASIS_LOOKUP: ReadonlyMap<string, AgentAuditBillingBasis> =
  new Map(
    Object.values(AUDIT_BILLING_BASIS_VALUES).map((basis) => [basis, basis]),
  );

export function parseAgentAuditBillingBasis(
  value: string,
): AgentAuditBillingBasis | null {
  return AUDIT_BILLING_BASIS_LOOKUP.get(value) ?? null;
}

export type AgentAuditContextCategoryKind =
  | 'used'
  | 'free'
  | 'buffer'
  | 'deferred';

/** One category of a provider's context breakdown. Names and counts only. */
export interface AgentAuditContextCategory {
  name: string;
  tokens: number;
  kind: AgentAuditContextCategoryKind;
}

/** Context fill of the provider session when the turn ended. */
export interface AgentAuditContextUsage {
  endTokens: number;
  windowTokens: number;
  /** The highest fill seen during the turn, when it differs from the end. */
  peakTokens?: number;
  /**
   * The provider's category breakdown at the end of the turn, when it offers
   * one without an API call (Claude). At most 24 categories.
   */
  categories?: AgentAuditContextCategory[];
}

export type AgentAuditCompactionTrigger = 'auto' | 'manual' | 'unknown';

/** A context compaction observed during the turn. Never carries the summary. */
export interface AgentAuditCompaction {
  at: string;
  trigger: AgentAuditCompactionTrigger;
  preTokens?: number;
}

export type AgentAuditSubagentKind = 'claude_task' | 'codex_agent';

/**
 * Whether a subagent's usage is already inside its parent turn's totals
 * (`included`) or comes on top of them (`additional`).
 */
export type AgentAuditSubagentInclusion = 'included' | 'additional';

/**
 * Which interface lease answered one agent tool call of the turn (CAN-5828).
 * Identifiers and kinds only, never the call's input, reply or error text.
 */
export interface AgentAuditInterfaceToolCall {
  callId: string;
  /** The interface tool catalog name, for example `ui.show_files`. */
  toolName: string;
  leaseId: string;
  /** The window that served it: `main` or `app-advisor`. */
  surface: string;
  interfaceKind: string;
  /** The remote-control controller whose window served it; absent for this computer's own. */
  audience?: string;
  /** `answered`, or the kind of the failure that settled the call. */
  outcome: string;
  deliveredAt: string;
  settledAt: string;
}

/** A provider-native subagent a turn started, with the usage it reported. */
export interface AgentAuditSubagentUsage {
  id: string;
  kind: AgentAuditSubagentKind;
  /** The tool's short description, capped. Never prompt text. */
  label?: string;
  model?: string;
  tokens: AgentAuditTokenTotals;
  /**
   * Tokens reported without a split by kind (Claude `task_progress`
   * `usage.total_tokens`). Absent when `tokens` carries the split.
   */
  totalTokens?: number;
  costUsd?: number;
  inclusion: AgentAuditSubagentInclusion;
}

/** How a Claude entry's cost was derived from the SDK's running totals. */
export type AgentAuditCostDerivation = 'exact' | 'estimated_unknown_baseline';

/**
 * One model's share of an entry, as the change in the Claude SDK's
 * `modelUsage` running totals across the entry. Covers the main loop,
 * subagents and other query-pipeline calls.
 */
export interface AgentAuditModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests?: number;
  costUsd: number;
  costBasis?: 'list' | 'managed' | 'unknown';
}

/** Marks an audit line rewritten by the one-time cost history repair. */
export interface AgentAuditCostRepair {
  version: number;
  previousTotalCostUsd?: number;
}

/** One account-proxy account that served part of a run (CAN-4021). */
export interface AgentAuditAccountProxyAccount {
  /** CLIProxyAPI's `auth_index`, stable per credential. */
  authIndex: string;
  /** The account's label or email when it served; absent when unknown. */
  label?: string;
  /** `claude`, `codex`, and so on; absent when unknown. */
  provider?: string;
  /** Responses this account served in the run. */
  requests: number;
}

/**
 * Which account-proxy accounts served a run, from the proxy's trace header on
 * each response. Absent when the run did not go through the proxy.
 */
export interface AgentAuditAccountProxyUsage {
  connectionId: string;
  /** Most requests first. */
  accounts: AgentAuditAccountProxyAccount[];
}

/** Plan lifecycle facts attributed to one turn. */
export interface AgentAuditPlanEvents {
  created: number;
  approved: number;
  /**
   * Ids of the `PlanUsageEvent`s already counted, so a replayed or duplicate
   * event is not counted twice. Absent on entries stored before CAN-5078.
   */
  eventIds?: string[];
}

/** Where a `managed_delegation` entry's run was started from. */
export interface AgentAuditDelegationLineage {
  delegationId: string;
  runGeneration: number;
  /** The chat that started the delegation, when a chat did. */
  parentChatId?: string;
  parentUserMessageId?: string;
  /** The delegation that started this one, when nested. */
  parentDelegationId?: string;
  /** The pipeline execution whose agent step started it, when one did. */
  parentPipelineExecutionId?: string;
  /** The route's harness, such as `claude` or `codex`. */
  harness?: string;
  /** A short Canopy-supplied name for the delegate. Never prompt text. */
  label?: string;
}

export interface AgentAuditEntry {
  id: string;
  eventType: AgentAuditEventType;
  status: AgentAuditStatus;
  provider: AgentProviderType;
  /** Catalog ownership/lifecycle source, recorded separately from execution. */
  modelSource?: ModelHarnessSource;
  /** Claude or Codex runtime selected for this task. */
  executionHarness?: ModelHarness;
  label: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /**
   * The model that served the turn. A routed Claude turn carries the gateway
   * id its replies report; a credits-routed Codex turn carries the served
   * model's registry id.
   */
  model?: string;
  /** Agent identity, independent of the model that served the turn. */
  agentId?: string;
  /**
   * The selection the turn was started with, which may be an Agent id rather
   * than a model id. Set once at turn start and never overwritten by provider
   * output, unlike `model`. Persisted because steering and autonomous wakes
   * copy metadata from closed entries; an entry written before this field
   * existed has none.
   */
  requestedModel?: string;
  totalCostUsd?: number;
  /**
   * Structured cost breakdown for the turn. Optional and backward-compatible:
   * older persisted entries omit it. When `observedCost.totalUsd` is defined,
   * `totalCostUsd` mirrors it so existing aggregations keep working.
   */
  observedCost?: AgentObservedCost;
  /** Text-free per-turn Auto routing attribution. */
  modelRouting?: ModelRoutingAttributionV1;
  /**
   * Service tier the turn requested — the same string the app-server client
   * sends as `TurnStartParams.serviceTier` (for example `'default'` for
   * Regular or `'priority'` for Fast), produced by `codexServiceTierForModelConfig`
   * (`packages/execution-engine/src/lib/codex-model-config.ts`). This is request
   * evidence, not the tier the provider served: the bundled Codex runtime
   * reports no served tier, so never copy this echo into a served-tier field.
   * Load-bearing for Fast-mode pricing. When absent, the cost calculator uses
   * `default` → `standard`. A present tier without an exact pricing alias
   * (for example `ultrafast`) is left unpriced as `unsupported_service_tier`
   * rather than estimated with Standard or Fast rates.
   */
  serviceTier?: string;
  /** Per-turn billable hosted-tool call counts (priced as non-token cost). */
  billableToolCounts?: {
    openAiWebSearchCalls?: number;
  };
  tokens: AgentAuditTokenTotals;
  messageCount: number;
  assistantMessageCount: number;
  toolUseCount: number;
  subAgentCount: number;
  toolCounts: AgentAuditToolCounts;
  error?: string;
  projectId?: string;
  worktreeId?: string;
  /**
   * Real workspace that owns an app-managed synthetic chat target. History
   * responses supply this for context filtering without changing the
   * persisted execution target used to load transcripts.
   */
  contextWorkspaceId?: string;
  repoId?: string;
  repoLabel?: string;
  chatId?: string;
  /**
   * Renderer-minted per-turn user message id (`msg-{n}-{epochMs}` from
   * `stores/chat/ids.ts`). Threaded through so turn-level feedback (CAN-1521)
   * has a correlation key the server can reproduce: `id` becomes the telemetry
   * `clientTurnId`, which the mapping layer rewrites via `clampId` and is
   * therefore unusable as a join key. Absent on older persisted entries and on
   * non-chat event types.
   */
  userMessageId?: string;
  sdkSessionId?: string;
  pipelineId?: string;
  pipelineName?: string;
  pipelineExecutionId?: string;
  jobId?: string;
  stepId?: string;
  attempt?: number;
  /**
   * Chat surface that executed this turn. Present only on chat event types
   * (worktree/standalone/app-advisor/plan chats); older persisted entries
   * may omit it, in which case `'canopy'` is implied.
   */
  chatMode?: AgentAuditChatMode;
  hasTranscript: boolean;
  linkTarget?: AgentAuditLinkTarget;
  /**
   * True when this run's LLM traffic was routed through the AI Credits gateway
   * proxy (billing UD AI Credits) rather than the native provider subscription.
   * Set for chat turns, in-process helper tasks, and pipeline steps. Absent on
   * older persisted entries and on natively-authenticated runs.
   */
  aiCreditsRouted?: boolean;
  /**
   * True when the run used an organization-owned model gateway. Such turns
   * retain token usage but never receive vendor-list-price dollar estimates.
   */
  modelGatewayRouted?: boolean;
  /**
   * Stable attribution key for the provider subscription account that drove
   * this run: `` `${provider}:${normalizedEmail}` ``. Only set for
   * natively-authenticated subscription turns (not AI-Credits-routed, not
   * API-key/Bedrock). Absent on older persisted entries and unattributable
   * runs.
   */
  providerAccountKey?: string;
  /** Email of the driving provider subscription account, when attributed. */
  providerAccountEmail?: string;
  /** Raw provider plan/subscription type string, when attributed. */
  providerPlanType?: string;
  /**
   * True for the entry of a turn no one dispatched, such as a wake
   * (turn-state phase 35d1). Product activity doesn't count it; usage and
   * cost still do. Absent on dispatched turns and older entries.
   */
  autonomous?: true;
  /** How the run was paid for. Absent on older persisted entries. */
  billingBasis?: AgentAuditBillingBasis;
  /** The account-proxy accounts that served the run (CAN-4021). */
  accountProxy?: AgentAuditAccountProxyUsage;
  /** Context fill when the turn ended. Absent when the provider reports none. */
  context?: AgentAuditContextUsage;
  /** Compactions observed during the turn. Absent when there were none. */
  compactions?: AgentAuditCompaction[];
  /** Provider-native subagents the turn started. Absent when there were none. */
  subagents?: AgentAuditSubagentUsage[];
  /**
   * The interface lease that answered each agent tool call of the turn, up
   * to the first 64. Absent when the turn made none.
   */
  interfaceToolCalls?: AgentAuditInterfaceToolCall[];
  /** Present only on `managed_delegation` entries. */
  delegation?: AgentAuditDelegationLineage;
  /**
   * Plans the turn created or had approved, counted where the matching
   * `PlanUsageEvent` is recorded. Absent when the turn touched no plan.
   */
  planEvents?: AgentAuditPlanEvents;
  /**
   * The root run of a nested pipeline execution, on `pipeline_agent_turn` and
   * `pipeline_advisor` entries. Absent when the run is not nested.
   */
  rootPipelineExecutionId?: string;
  /**
   * Claude only: the SDK's running `total_cost_usd` after this entry, so a
   * later entry of the same session can be differenced against it.
   */
  sdkCumulativeCostUsd?: number;
  /** Claude only: how `totalCostUsd` was derived from the running totals. */
  costDerivation?: AgentAuditCostDerivation;
  /** Claude only: per-model cost and tokens for this entry. */
  modelUsage?: AgentAuditModelUsage[];
  /** Present when the cost history repair rewrote this line. */
  costRepair?: AgentAuditCostRepair;
}

export interface AgentAuditTranscriptRequest {
  id: string;
  eventType: AgentAuditEventType;
  startedAt: string;
}

export type AgentTranscriptApplicationCondition =
  | 'claude_system_prompt_append_each_turn'
  // NOTE: kept DISTINCT from `deferred_tools_reload_continuation` below. Both
  // can fire on a freshly recreated thread with no prior session id, but the
  // deferred-tools reload continuation is its own condition so the backend can
  // select the right one and not let the Codex first-turn condition mask or
  // duplicate it.
  | 'codex_first_turn_without_session_id'
  | 'helper_task_system_prompt'
  | 'pipeline_step_system_prompt'
  | 'plan_mode_enabled'
  // Hidden `<system_instruction>` that resumes the interrupted turn after a
  // deferred-tools (Search/Load) reload enabled new skills/plugins/MCP servers.
  | 'deferred_tools_reload_continuation'
  | 'org_memory_enabled_for_turn';

export interface AgentTranscriptInjectedPrompt {
  kind:
    | 'system_prompt_append'
    | 'plan_mode_developer_instructions'
    | 'org_memory';
  provider: AgentProviderType;
  applicationCondition: AgentTranscriptApplicationCondition;
  text: string;
  deferredToolsReload?: {
    enabledResources: DeferredResourceSummary[];
  };
}

export interface AgentAuditTranscriptInjectedPromptRecord {
  type: 'canopy_injected_prompt';
  kind: AgentTranscriptInjectedPrompt['kind'];
  provider: AgentProviderType;
  application_condition: AgentTranscriptApplicationCondition;
  /**
   * Human-readable injected text. For
   * `application_condition === 'deferred_tools_reload_continuation'` this is the
   * canonical `<system_instruction>...</system_instruction>` continuation.
   */
  text: string;
  /**
   * Present only when `application_condition ===
   * 'deferred_tools_reload_continuation'`. Records the structured revalidated
   * resource identities that were enabled by the reload, independent of the
   * human-readable `text` above. Snake-cased to match the record's persisted
   * field convention.
   */
  deferred_tools_reload?: {
    enabled_resources: DeferredResourceSummary[];
  };
}

export interface AgentTranscriptTruncationMetadata {
  truncated: boolean;
  maxBytes: number;
  storedBytes: number;
}

export interface AgentAuditTranscriptSyntheticPromptRecord {
  type: 'canopy_user_prompt';
  provider: AgentProviderType;
  original_text: string;
  submitted_text: string;
  file_references?: FileReference[];
  plan_mode: boolean;
  user_message_id?: string;
  steering?: { startsTurn: boolean; rootUserMessageId?: string };
  /** Set for an internal row's prompt; transcript readers mark it hidden. */
  canopy_hidden?: true;
}

export interface AgentAuditTranscriptSuccessResponse {
  type: 'success';
  lines: string[];
  providerHint?: AgentProviderType;
  truncation: AgentTranscriptTruncationMetadata;
  injectedPrompts: AgentTranscriptInjectedPrompt[];
}

export interface AgentAuditTranscriptNotAvailableResponse {
  type: 'not_available';
}

export type AgentAuditTranscriptResponse =
  | AgentAuditTranscriptSuccessResponse
  | AgentAuditTranscriptNotAvailableResponse;

export type ProviderAuthState =
  | 'authenticated'
  | 'unauthenticated'
  | 'unknown'
  | 'error';

export interface ProviderRateLimitWindow {
  /** Reported by the provider, not inferred from an absent percentage. */
  unlimited?: boolean;
  limit?: number;
  remaining?: number;
  usedPercent?: number;
  resetsAt?: string | number;
  windowDurationMins?: number;
}

export interface ProviderCreditsSnapshot {
  /** Provider-reported spend in the current billing period, when available. */
  usedUsd?: number;
  totalUsd?: number;
  remainingUsd?: number;
  expiresAt?: string;
}

/** Billing-period spend and cap, never a prepaid credit balance. Money is in major units. */
export interface ProviderSpendSnapshot {
  currency?: string;
  used?: number;
  /** Absent means no usable cap was reported; null is reserved for an explicit uncapped cap. */
  limit?: number | null;
  isEnabled?: boolean;
}

export interface ProviderRateLimitSnapshot {
  limitId?: string;
  limitName?: string;
  planType?: string;
  primary?: ProviderRateLimitWindow;
  secondary?: ProviderRateLimitWindow;
  credits?: ProviderCreditsSnapshot;
  spend?: ProviderSpendSnapshot;
  /** Provider-reported applicability, rather than a label inferred by callers. */
  scope?: {
    model?: { id: string | null; displayName: string | null };
    surface?: string | null;
  };
}

/**
 * Broad category of a failed provider usage/rate-limit fetch, used by the
 * renderer to pick friendly copy and actions instead of dumping the raw
 * provider/transport message:
 * - `auth` — the stored credential was rejected or revoked; signing in again
 *   is the fix.
 * - `network` — the provider could not be reached (DNS/connect/timeout).
 * - `service` — the provider responded but with a server-side error or an
 *   unreadable payload; retrying later is the fix.
 * - `rate_limited` — the provider throttled the usage request (HTTP 429);
 *   the desktop waits until `retryAt` before asking again.
 * - `unsupported` — the provider answered but has no usage data for this
 *   account/plan/platform; retrying will not help.
 * - `unknown` — none of the above could be determined.
 */
export type UsageFetchErrorKind =
  | 'auth'
  | 'network'
  | 'service'
  | 'rate_limited'
  | 'unsupported'
  | 'unknown';

/**
 * Structured companion to {@link ProviderUsageSummary.error}. `message` is an
 * optional curated human-readable explanation produced where the failure
 * context is known (e.g. Claude credential-store failures); when absent the
 * renderer derives generic copy from `kind`. `detail` preserves the raw
 * underlying provider/transport message for a collapsed diagnostics
 * disclosure.
 */
export interface ProviderUsageErrorInfo {
  kind: UsageFetchErrorKind;
  message?: string;
  detail?: string;
  /**
   * ISO timestamp before which the desktop will not ask the provider again.
   * Set for `rate_limited` failures; absent when no wait applies.
   */
  retryAt?: string;
}

/**
 * After a failed read for the same account, `rateLimits` keeps the last
 * successful values and `lastUpdatedAt` stays the time of that success, while
 * `error`/`errorInfo` describe the latest failure.
 */
export interface ProviderUsageSummary {
  provider: AgentProviderType;
  authState: ProviderAuthState;
  hasRemainingLimits: boolean;
  lastUpdatedAt?: string;
  accountEmail?: string;
  accountLabel?: string;
  subscriptionLabel?: string;
  authMethod?: string;
  error?: string;
  errorInfo?: ProviderUsageErrorInfo;
  rateLimits?: ProviderRateLimitSnapshot[];
}

export interface RetainedAccountUsageSnapshot {
  provider: AgentProviderType;
  /** Stable retention/dedup key: `${provider}:${email}:${subscription}`. */
  accountKey: string;
  accountEmail?: string;
  accountLabel?: string;
  subscriptionLabel?: string;
  rateLimits?: ProviderRateLimitSnapshot[];
  /** ISO timestamp of when this snapshot was collected. */
  capturedAt: string;
}

export interface AgentUsageOverview {
  /** Memory-only native account metadata; no plan or quota inference. */
  openCodeAccounts?: OpenCodeAccountSnapshot;
  updatedAt: string;
  providers: ProviderUsageSummary[];
  /**
   * All retained per-account usage snapshots across providers (includes the
   * currently active account so the list round-trips through persistence). The
   * renderer derives the "other, still-relevant" subset for display.
   */
  accountSnapshots?: RetainedAccountUsageSnapshot[];
}

export interface AgentObservabilitySnapshot {
  version: 1;
  historicalMode: 'forward-only';
  retentionDays: number;
  recentEntries: AgentAuditEntry[];
  usage: AgentUsageOverview;
}

export interface AgentAuditHistoryRequest {
  cursor?: string;
  limit?: number;
  search?: string;
  eventType?: AgentAuditEventType | 'all';
  provider?: AgentProviderType | 'all';
  status?: AgentAuditStatus | 'all';
  projectId?: string;
  worktreeId?: string;
  pipelineExecutionId?: string;
  activeOnly?: boolean;
  /**
   * Optional inclusive lower bound on `startedAt` (ISO 8601). When both
   * `startDate` and `endDate` are omitted, the date filter is a no-op and
   * existing callers observe no behavior change.
   */
  startDate?: string;
  /**
   * Optional exclusive upper bound on `startedAt` (ISO 8601). When both
   * `startDate` and `endDate` are omitted, the date filter is a no-op and
   * existing callers observe no behavior change.
   */
  endDate?: string;
}

export interface AgentAuditHistoryResponse {
  entries: AgentAuditEntry[];
  nextCursor?: string;
}

/** Discriminator for the interactive Statistics tabs. */
export type UsageTabId =
  | 'tokens'
  | 'cost'
  | 'worktrees'
  | 'chats'
  | 'plans'
  | 'tools'
  | 'pipelines';

/**
 * Per-tab metric IDs. Each tab's union is distinct so picker options can be
 * constrained to a single tab's metric vocabulary at compile time. The
 * `UsageMetricId` super-union exists for transport request payloads.
 */
export type WorktreeMetricId =
  | 'created'
  | 'merged'
  | 'deleted_with_changes'
  | 'deleted_without_changes'
  | 'age_at_deletion_ms';

export type TokenMetricId =
  | 'token_total'
  | 'token_input'
  | 'token_output'
  | 'token_cache_read'
  | 'token_cache_creation'
  | 'token_provider_claude'
  | 'token_provider_codex'
  | 'token_provider_ollama';

export type CostModelMetricId = `cost_model:${string}`;

export type CostMetricId =
  | 'cost_total_usd'
  | 'cost_provider_claude_usd'
  | 'cost_provider_codex_usd'
  | CostModelMetricId;

export type ChatMetricId =
  | 'chat_turns'
  | 'tool_calls'
  | 'turn_duration_ms'
  | 'tool_calls_per_turn';

export type PlanMetricId = 'plan_created' | 'plan_updated' | 'plan_approved';

/**
 * Tool metrics are the aggregate `tool_calls` plus one per
 * `AgentAuditToolCounts` key prefixed with `tool_`.
 */
export type ToolMetricId =
  | 'tool_calls'
  | `tool_${Extract<keyof AgentAuditToolCounts, string>}`;

/**
 * Pipeline metrics surfaced on the Pipelines Usage tab. Counts are derived
 * from the `pipeline_run_started` and `pipeline_run_completed` events; the
 * distribution metrics (`pipeline_duration_ms`, `pipeline_steps_per_run`,
 * `pipeline_agent_steps_per_run`, `pipeline_retries_per_run`) are derived
 * from the matching numeric fields on `PipelineRunUsageEvent`.
 *
 * NOTE: `pipeline_runs_completed` means "reached a terminal state" — it is
 * the sum of `pipeline_runs_succeeded`, `pipeline_runs_failed`, and
 * `pipeline_runs_cancelled` (plus any terminal events whose `status` could
 * not be narrowed).
 */
export type PipelineMetricId =
  | 'pipeline_runs_started'
  | 'pipeline_runs_completed'
  | 'pipeline_runs_succeeded'
  | 'pipeline_runs_failed'
  | 'pipeline_runs_cancelled'
  | 'pipeline_duration_ms'
  | 'pipeline_steps_per_run'
  | 'pipeline_agent_steps_per_run'
  | 'pipeline_retries_per_run';

export type UsageMetricId =
  | TokenMetricId
  | CostMetricId
  | WorktreeMetricId
  | ChatMetricId
  | PlanMetricId
  | ToolMetricId
  | PipelineMetricId;

/**
 * Discriminator for {@link UsageTimeseriesRequest.dataset}. The legacy
 * single-shape request (no `dataset`) is preserved by treating an absent
 * field as `{ kind: 'tokens' }` server-side.
 */
export type UsageTimeseriesDataset =
  | { kind: 'tokens' }
  | { kind: 'tab-counts'; tab: UsageTabId; series: UsageMetricId[] }
  | { kind: 'tab-distribution'; tab: UsageTabId; metric: UsageMetricId };

/**
 * Bucket shape for `tab-counts`. The `series` map only contains keys the
 * request asked for; renderers should treat missing keys as zero.
 */
export interface UsageCountsTimeseriesBucket {
  bucketStart: string;
  series: Partial<Record<UsageMetricId, number>>;
}

/**
 * Bucket shape for `tab-distribution`. `sampleCount` is the number of
 * underlying samples in the bucket (0 means no data; percentiles will all be
 * 0 in that case).
 */
export interface UsageDistributionTimeseriesBucket {
  bucketStart: string;
  p50: number;
  p95: number;
  p99: number;
  sampleCount: number;
}

export interface UsageTimeseriesRequest {
  /** Inclusive lower bound (ISO 8601). */
  startDate: string;
  /** Exclusive upper bound (ISO 8601). */
  endDate: string;
  bucket: 'hour' | 'day' | 'week';
  /**
   * Defaults to `{ kind: 'tokens' }` server-side when omitted, preserving
   * the original (Tokens chart) shape.
   */
  dataset?: UsageTimeseriesDataset;
}

export interface UsageTimeseriesBucket {
  /** Start-of-bucket instant as ISO 8601. Local calendar buckets are encoded in UTC. */
  bucketStart: string;
  /**
   * Keyed by every `AgentProviderType`. Each bucket must include an entry for
   * every provider, with zeroed `in`/`out` when the provider had no activity
   * in that bucket — this keeps renderer mapping branch-free.
   */
  providers: Record<AgentProviderType, { in: number; out: number }>;
}

export type UsageTimeseriesResponse =
  | { kind: 'tokens'; buckets: UsageTimeseriesBucket[] }
  | { kind: 'tab-counts'; buckets: UsageCountsTimeseriesBucket[] }
  | { kind: 'tab-distribution'; buckets: UsageDistributionTimeseriesBucket[] };

export type AgentObservabilityUpdateEvent =
  | { type: 'snapshot'; snapshot: AgentObservabilitySnapshot }
  | { type: 'entries'; entries: AgentAuditEntry[] }
  | { type: 'usage'; usage: AgentUsageOverview }
  | { type: 'retention'; retentionDays: number };

// ---------------------------------------------------------------------------
// Worktree Usage Metrics — shared transport contracts.
//
// A separate, local-only observability data stream for product usage metrics
// that is recorded alongside (but distinct from) `AgentAuditEntry`. The main
// process appends raw events; the renderer requests on-demand summaries via
// the `observability:load-usage-metrics` IPC channel.
//
// Identifier convention: existing `AgentAuditEntry` records use `projectId`
// for the workspace identifier, while `worktree-service.ts` and most newer
// code use `workspaceId`. These new usage event types use `workspaceId` as
// the canonical name, and renderer-facing breakdown rows expose
// `workspaceId` as well.
// ---------------------------------------------------------------------------

/**
 * Classification of what kicked off a chat turn. Recorded on chat-turn and
 * plan events so summaries can break activity down by initiation surface.
 *
 * `'unknown'` exists so the backend never has to drop an event when the
 * source cannot be confidently inferred at recording time.
 */
export type UsageInitiationSource =
  | 'user'
  | 'hook'
  | 'automation'
  | 'app_advisor'
  | 'portal'
  | 'unknown';

const USAGE_INITIATION_SOURCES: ReadonlySet<string> =
  new Set<UsageInitiationSource>([
    'user',
    'hook',
    'automation',
    'app_advisor',
    'portal',
    'unknown',
  ]);

export function isUsageInitiationSource(
  value: unknown,
): value is UsageInitiationSource {
  return typeof value === 'string' && USAGE_INITIATION_SOURCES.has(value);
}

export type UsageMetricProvider = AgentProviderType | 'pipeline';

/**
 * Discriminator for every event shape recorded in the usage-metrics stream.
 *
 * - `worktree_*` events describe worktree lifecycle (created, PR merged,
 *   deleted).
 * - `chat_turn_*` events describe one finalized `worktree_chat`,
 *   `standalone_chat`, or `app_advisor` audit entry's lifecycle boundary
 *   (`'chat_turn_started'` then `'chat_turn_completed'`).
 * - `plan_*` events describe plan lifecycle transitions. Plan lifecycle
 *   metrics are computed from these explicit events; the renderer does not
 *   infer plan state from any other source.
 */
export type UsageWorktreeEventType =
  | 'worktree_created'
  | 'worktree_pr_merged'
  | 'worktree_deleted'
  | 'chat_turn_started'
  | 'chat_turn_completed'
  | 'plan_created'
  | 'plan_updated'
  | 'plan_approved'
  | 'pipeline_run_started'
  | 'pipeline_run_completed';

/**
 * A repo scope attached to a usage event. Some events span multiple repos
 * (multi-repo worktrees), so events that carry a `repos` array re-use this
 * shape per repo, optionally extended with event-specific fields.
 */
export interface UsageRepoScope {
  workspaceId: string;
  workspaceLabel?: string;
  worktreeId?: string;
  repoId: string;
  repoLabel: string;
  repoPath?: string;
}

/**
 * Fields shared by every usage event. Concrete event types narrow `type`
 * and add event-specific fields.
 */
export interface UsageMetricEventBase {
  version: 1;
  id: string;
  type: UsageWorktreeEventType;
  timestamp: string;
  workspaceId: string;
  workspaceLabel?: string;
  worktreeId?: string;
  repoId?: string;
  repoLabel?: string;
  provider?: UsageMetricProvider;
  initiationSource?: UsageInitiationSource;
}

export interface WorktreeCreatedUsageEvent extends UsageMetricEventBase {
  type: 'worktree_created';
  worktreeCreatedAt: string;
  repos: UsageRepoScope[];
}

export interface WorktreePrMergedUsageEvent extends UsageMetricEventBase {
  type: 'worktree_pr_merged';
  prNumber?: number;
  prUrl?: string;
  mergedAt?: string;
  repos: UsageRepoScope[];
}

export interface WorktreeDeletedUsageEvent extends UsageMetricEventBase {
  type: 'worktree_deleted';
  deletedWithChanges: boolean;
  worktreeAgeMs?: number;
  repos: Array<
    UsageRepoScope & {
      hadChanges: boolean;
      insertions: number;
      deletions: number;
      hasUncommittedChanges: boolean;
      hasCommitsAhead: boolean;
    }
  >;
}

/**
 * One finalized `worktree_chat`, `standalone_chat`, or `app_advisor` audit
 * entry produces a `'chat_turn_started'` event when the turn begins and a
 * `'chat_turn_completed'` event when the turn reaches a terminal status.
 *
 * `turnDurationMs`, `turnCompletedAt`, `toolUseCount`, `toolCounts`,
 * `status`, and `error` are only populated for the completed half of the
 * pair; consumers should treat them as optional on the started event.
 */
export interface ChatTurnUsageEvent extends UsageMetricEventBase {
  type: 'chat_turn_started' | 'chat_turn_completed';
  chatId: string;
  auditEntryId?: string;
  model?: string;
  agentId?: string;
  turnStartedAt: string;
  turnCompletedAt?: string;
  turnDurationMs?: number;
  turnIndexInChat?: number;
  turnIndexInWorktree?: number;
  tokens?: AgentAuditTokenTotals;
  totalCostUsd?: number;
  /**
   * Structured cost breakdown for the turn, reused by local Statistics so it
   * can render the same status/breakdown as the audit trail. When
   * `observedCost.totalUsd` is defined, `totalCostUsd` is set to the same
   * value so existing aggregations keep working.
   */
  observedCost?: AgentObservedCost;
  toolUseCount?: number;
  toolCounts?: AgentAuditToolCounts;
  status?: AgentAuditStatus;
  error?: string;
}

export interface PlanUsageEvent extends UsageMetricEventBase {
  type: 'plan_created' | 'plan_updated' | 'plan_approved';
  chatId?: string;
  auditEntryId?: string;
  planId: string;
  planVersion?: number;
  planTextBytes?: number;
  planLineCount?: number;
}

/**
 * Best-known source class for a pipeline at execution time. Used to derive
 * the stable {@link PipelineUsageIdentity.key} so that pipelines with the
 * same `id` but different provenance do not collide.
 */
export type PipelineUsageIdentitySource =
  | 'curated'
  | 'bundled'
  | 'user'
  | 'project'
  | 'shared'
  | 'inline'
  | 'unknown';

/**
 * Serializable identity for a pipeline captured at execution time. The
 * recorder fills this in once per execution so the UI can group and sort by
 * pipeline without re-reading execution state.
 *
 * `key` is the only field consumers must use for grouping; the convenience
 * fields are exposed for simple table/group logic and back-compat.
 */
export interface PipelineUsageIdentity {
  /**
   * Stable key used for grouping. Prefer a canonical source-qualified key:
   * - stored bundled: `stored:bundled:<pipelineId>`
   * - stored user: `stored:user:<pipelineId>`
   * - project file: `file:<absolute pipeline yaml path>`
   * - shared: `shared:<serverId>:<remoteId>`
   * - inline/unknown: `inline:<pipelineId>` or `unknown:<pipelineId>`
   */
  key: string;
  /** Raw pipeline id used by the execution state. */
  id: string;
  /** Human-readable display name captured at execution time. */
  name: string;
  /** Best-known source class for the pipeline. */
  source: PipelineUsageIdentitySource;
}

/**
 * One lifecycle boundary of a pipeline execution. The recorder emits one
 * `pipeline_run_started` event when execution begins and a single
 * `pipeline_run_completed` event when the execution reaches any terminal
 * state (`success`, `failure`, or `cancelled`). The terminal outcome is
 * carried on `status` rather than the event type, so the terminal event
 * count is the sum across all outcomes.
 *
 * Deterministic event ids (`pipeline-run-started:<executionId>` and
 * `pipeline-run-completed:<executionId>`) allow replayed snapshots to
 * dedupe safely; retried executions reuse the same id and collapse to one
 * lifecycle, while reruns receive a new execution id (and therefore a
 * distinct lifecycle pair).
 *
 * `status` is intentionally narrower than `ExecutionState.status`. The
 * backend must narrow defensively; non-conforming values cause optional
 * drop rather than a runtime break.
 */
export interface PipelineRunUsageEvent extends UsageMetricEventBase {
  type: 'pipeline_run_started' | 'pipeline_run_completed';

  /** Execution id. Used for linking lifecycle events and dedupe ids. */
  pipelineExecutionId: string;

  /** Stable grouping identity for "Most Used Pipeline" style UX. */
  pipeline: PipelineUsageIdentity;

  /**
   * Convenience mirrors retained for simple table/group logic and
   * compatibility. These must match `pipeline.id`, `pipeline.name`, and
   * `pipeline.key` respectively.
   */
  pipelineId: string;
  pipelineName: string;
  pipelineIdentityKey: string;

  eventName?: string;
  triggerSource?: string;

  runStartedAt: string;
  runCompletedAt?: string;
  runDurationMs?: number;

  status?: 'running' | 'success' | 'failure' | 'cancelled';

  jobCount?: number;
  stepCount?: number;
  agentStepCount?: number;
  retryCount?: number;

  parentExecutionId?: string;
  rerunSourceId?: string;
  hidden?: boolean;
}

/**
 * Discriminated union of every shape recorded in the usage-metrics stream.
 * Consumers should switch on `type` to narrow safely.
 */
export type UsageMetricEvent =
  | WorktreeCreatedUsageEvent
  | WorktreePrMergedUsageEvent
  | WorktreeDeletedUsageEvent
  | ChatTurnUsageEvent
  | PlanUsageEvent
  | PipelineRunUsageEvent;

// ---------------------------------------------------------------------------
// Usage-metrics summary request/response shapes.
// ---------------------------------------------------------------------------

/**
 * Numeric distribution summary returned alongside a breakdown row. The
 * percentiles are inclusive, computed from the underlying samples by the
 * backend; the renderer never recomputes them.
 */
export interface UsageStats {
  total: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface UsageMetricsRequest {
  /** Inclusive lower bound on event `timestamp` (ISO 8601). */
  startDate: string;
  /** Exclusive upper bound on event `timestamp` (ISO 8601). */
  endDate: string;
  workspaceId?: string;
  repoId?: string;
  provider?: UsageMetricProvider | 'all';
  initiationSource?: UsageInitiationSource | 'all';
}

/**
 * One row inside a {@link UsageBreakdownRows} grouping. `key` is the stable
 * identifier the renderer can use as a React key; `label` is the
 * human-readable text. Optional dimension fields are populated when the
 * row represents a grouping along that dimension.
 */
export interface UsageBreakdownRow {
  key: string;
  label: string;
  workspaceId?: string;
  workspaceLabel?: string;
  worktreeId?: string;
  repoId?: string;
  provider?: UsageMetricProvider;
  initiationSource?: UsageInitiationSource;
  count: number;
  stats?: UsageStats;
}

/**
 * A pre-aggregated set of {@link UsageBreakdownRow} rows. `total` reflects
 * the summed row counts, while `stats` summarizes every underlying sample
 * across all rows for headline metric cards.
 */
export interface UsageBreakdownRows {
  total: number;
  /** Aggregate stats across every sample represented by all rows. */
  stats?: UsageStats;
  rows: UsageBreakdownRow[];
}

export interface UsageMetricsResponse {
  updatedAt: string;
  retentionDays: number;
  worktrees: {
    created: UsageBreakdownRows;
    merged: UsageBreakdownRows;
    deletedWithChanges: UsageBreakdownRows;
    deletedWithoutChanges: UsageBreakdownRows;
    deletionAgeMs: UsageBreakdownRows;
  };
  chats: {
    turnCountsPerChat: UsageBreakdownRows;
    turnCountsPerWorktree: UsageBreakdownRows;
    turnCountsByInitiationSource?: UsageBreakdownRows;
    turnCountsByProvider?: UsageBreakdownRows;
    turnDurationMs: UsageBreakdownRows;
    toolCallsPerTurn: UsageBreakdownRows;
    toolCallsPerChat: UsageBreakdownRows;
    toolCallsPerWorktree: UsageBreakdownRows;
    statusCounts: Array<{ status: AgentAuditStatus; count: number }>;
  };
  plans: {
    created: UsageBreakdownRows;
    updated: UsageBreakdownRows;
    approved: UsageBreakdownRows;
    createdPerWorktree: UsageBreakdownRows;
    updatedPerWorktree: UsageBreakdownRows;
    approvedPerWorktree: UsageBreakdownRows;
  };
  tools: {
    byCategory: Array<{ category: keyof AgentAuditToolCounts; count: number }>;
    byProvider: UsageBreakdownRows;
    byInitiationSource: UsageBreakdownRows;
  };
}

// ---------------------------------------------------------------------------
// Interactive Usage page — tab-scoped metric exploration.
// ---------------------------------------------------------------------------

export type WorktreeGroupById =
  | 'workspace'
  | 'workspace_then_repo'
  | 'repo'
  | 'day_of_week';

export type ChatGroupById =
  | 'workspace'
  | 'workspace_then_repo'
  | 'worktree'
  | 'chat'
  | 'provider'
  | 'initiation_source'
  | 'model';

export type TokenGroupById = ChatGroupById;

export type CostGroupById = ChatGroupById;

export type PlanGroupById = 'workspace' | 'worktree' | 'initiation_source';

export type ToolGroupById =
  | 'category'
  | 'provider'
  | 'initiation_source'
  | 'workspace'
  | 'worktree';

/**
 * Pipeline groupings available on the Pipelines Usage tab. All groupings
 * resolve at workspace/worktree level — repo grouping is intentionally
 * omitted because pipeline executions are tracked above the repo layer.
 */
export type PipelineGroupById =
  | 'workspace'
  | 'worktree'
  | 'pipeline'
  | 'status'
  | 'event_name'
  | 'initiation_source'
  | 'trigger_source';

export type UsageGroupById =
  | TokenGroupById
  | WorktreeGroupById
  | PlanGroupById
  | ToolGroupById
  | PipelineGroupById;

/**
 * Time window for tab-summary and metrics-view requests. `last7d` and
 * `prior7d` are resolved server-side from "now" so the renderer never has to
 * agree on the boundary. `allTime` resolves to
 * `[earliestRecordedUsageEvent, now)`.
 */
export type UsageWindow =
  | { kind: 'last7d' }
  | { kind: 'prior7d' }
  | { kind: 'allTime' }
  | { kind: 'custom'; start: string; end: string };

export interface UsageMetricsViewRequest {
  tab: UsageTabId;
  metric: UsageMetricId;
  groupBy: UsageGroupById;
  window: UsageWindow;
}

export interface UsageMetricsViewResponse {
  rows: UsageBreakdownRow[];
  /** Present when `metric` is a distribution metric. */
  stats?: UsageStats;
  resolvedWindow: { start: string; end: string };
  earliestEventAt: string;
}

export interface UsageTabSummaryRequest {
  tab: UsageTabId;
}

/**
 * One headline card's last-7d / prior-7d / all-time values. The card's `key`
 * matches the `HeadlineCardSpec.key` defined per tab on the renderer.
 *
 * Values are `number` for count cards and `UsageStats` for distribution cards
 * (so the renderer can render `avg` or `p95` without another round-trip).
 */
export interface UsageTabSummaryCard {
  key: string;
  last7d?: number | UsageStats;
  prior7d?: number | UsageStats;
  allTime?: number | UsageStats;
}

export interface UsageTabSummaryResponse {
  tab: UsageTabId;
  cards: UsageTabSummaryCard[];
  earliestEventAt: string;
  /**
   * The resolved windows, returned so the renderer can render time labels and
   * tooltip ranges without recomputing.
   */
  resolvedWindows: {
    last7d: { start: string; end: string };
    prior7d: { start: string; end: string };
    allTime: { start: string; end: string };
  };
}
