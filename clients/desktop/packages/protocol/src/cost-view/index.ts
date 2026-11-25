// ---------------------------------------------------------------------------
// View contracts for reading the observed cost of one work scope: the Cost
// panel, the Session breakdown, a pipeline run's cost and the usage popover's
// preview.
//
// These are portable DTOs. They carry logical IDs only (projects, worktrees,
// Work Entries, chats, pipeline executions, retained containers), never host
// paths, and never prompts, replies, summaries, errors or tool input. The
// `core.cost.*` operations validate the same shapes.
//
// Dependency-free like the rest of `@canopy/protocol`: safe to import from the
// desktop main process, the renderer and the web app.
// ---------------------------------------------------------------------------

/** Where an amount came from, in display order. */
export const COST_SOURCES = [
  'chat',
  'pipeline',
  'subagents',
  'delegations',
  'background',
] as const;

export type CostSource = (typeof COST_SOURCES)[number];

/** How a turn was paid for, in display order. */
export const COST_BILLING_BASES = [
  'subscription',
  'ai_credits',
  'account_proxy',
  'api_key',
  'org_gateway',
  'local',
  'unknown',
] as const;

export type CostBillingBasis = (typeof COST_BILLING_BASES)[number];

/**
 * How a record's amount was arrived at. `not_priced` work keeps its tokens
 * and shows `Not priced`, never `$0.00`.
 */
export const COST_STATUSES = [
  'reported',
  'estimated',
  'partial',
  'not_priced',
] as const;

export type CostStatus = (typeof COST_STATUSES)[number];

/** Background helpers the breakdown names. `other` covers the rest. */
export const COST_HELPER_KINDS = [
  'chat_title',
  'branch_name',
  'handoff_summary',
  'commit_message',
  'entry_summary',
  'pull_request_text',
  'pipeline_advisor',
  'other',
] as const;

export type CostHelperKind = (typeof COST_HELPER_KINDS)[number];

/** Token totals, named as the audit stream names them. */
export interface CostTokenTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** Part of `output`; shown, never added to it. */
  readonly reasoningOutputTokens: number;
}

/** Sums for an entry, a chat, a run or one row of a breakdown. */
export interface CostTotals {
  /** Priced work in US dollars. Work that could not be priced adds nothing. */
  readonly usd: number;
  readonly bySource: Readonly<Record<CostSource, number>>;
  readonly byBilling: Readonly<Record<CostBillingBasis, number>>;
  readonly tokens: CostTokenTotals;
  /** Records with tokens and no price. Above zero, the UI says so. */
  readonly notPricedCount: number;
  /**
   * `notPricedCount` split by how the records were paid for (CAN-7305), so a
   * basis with no dollars (an organization gateway) can still be named.
   * Holds only bases above zero, and is absent when none is; totals built
   * before the split, and sealed copies of them, omit it.
   */
  readonly notPricedByBilling?: Readonly<
    Partial<Record<CostBillingBasis, number>>
  >;
  /** True when any priced amount is an estimate rather than reported. */
  readonly hasEstimate: boolean;
}

/**
 * The work scope a view reads. `entry` is a panel layout's project and
 * worktree, where a Cowork or App Advisor Work Entry occupies the worktree
 * slot. `retained` is an archived or deleted entry, read from its sealed copy.
 */
export type CostScopeRef =
  | {
      readonly kind: 'entry';
      readonly projectId: string;
      readonly worktreeId: string;
    }
  | {
      readonly kind: 'retained';
      readonly projectId: string;
      readonly containerId: string;
    };

export type CostPipelineRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * An account-proxy account named on a row (CAN-4021), without figures of its
 * own: a Claude subagent shares its turn's account.
 */
export interface CostProxyAccountRef {
  /** `proxy:<connectionId>:<auth_index>`, stable for the connection. */
  readonly accountKey: string;
  /** The account's label or email when it served; empty when unknown. */
  readonly label: string;
  /** `claude`, `codex`, and so on, when known. */
  readonly provider?: string;
}

/** One account-proxy account's share of a chat's, step's or run's work. */
export interface CostProxyAccountRow extends CostProxyAccountRef {
  /**
   * Turns or step attempts the account served. Work it shared with another
   * account counts by its share of the requests, so the shares add up to the
   * proxied turns.
   */
  readonly turnShare: number;
  readonly requestCount: number;
  /** An API-price estimate, split by requests like the turns. */
  readonly usd: number;
  /** Work with tokens and no price that the account served. */
  readonly notPricedCount: number;
}

export interface CostChatRow {
  readonly chatId: string;
  /** Joined from the chat store at read time, so a rename needs no rewrite. */
  readonly label: string;
  readonly state: 'open' | 'archived';
  readonly totals: CostTotals;
  readonly turnCount: number;
  readonly lastActivityAt: string;
  /** Always false in a retained entry. */
  readonly running: boolean;
  /** The models the chat's own turns used, most used first. */
  readonly models: readonly string[];
  /** Set only when the chat is older than its cost data (an ISO day). */
  readonly coverageStart?: string;
  /** The account-proxy accounts that served the chat, most turns first. */
  readonly proxyAccounts?: readonly CostProxyAccountRow[];
}

export interface CostPipelineRunRow {
  /** The root run; child runs add to their root. */
  readonly executionId: string;
  readonly pipelineName: string;
  readonly startedAt: string;
  readonly status: CostPipelineRunStatus;
  readonly totals: CostTotals;
  readonly agentStepCount: number;
}

export interface CostScopeView {
  readonly scope: CostScopeRef;
  /** When the store last caught up. Null while the first build runs. */
  readonly updatedAt: string | null;
  /** True while the first build has not finished for this entry. */
  readonly building: boolean;
  /** Retained entries only: when the copy was sealed. */
  readonly sealedAt?: string;
  /** Set only when the entry is older than its cost data (an ISO day). */
  readonly coverageStart?: string;
  /** Days of activity the first build reads (the Retention days setting). */
  readonly retentionDays: number;
  readonly totals: CostTotals;
  /** Ordered by cost, then by recency. */
  readonly chats: readonly CostChatRow[];
  /** Root runs with cost, ordered by cost, then by recency. */
  readonly pipelineRuns: readonly CostPipelineRunRow[];
  /** Background work tied to no chat or run. Absent when there is none. */
  readonly unattached?: CostTotals;
  /** True when any amount in the entry comes from Codex estimates. */
  readonly hasCodexEstimate: boolean;
}

/** A subagent or a managed delegation started by a chat turn or agent step. */
export interface CostAttributedItem {
  /** The subagent id, or the delegation id. */
  readonly id: string;
  readonly kind: 'claude_task' | 'codex_agent' | 'delegation';
  /** A short Canopy-generated or tool-supplied label; never prompt text. */
  readonly label: string;
  readonly model?: string;
  /** Delegations only. */
  readonly harness?: string;
  readonly billingBasis: CostBillingBasis;
  readonly tokens: CostTokenTotals;
  /** Tokens reported without a split by kind; set when `tokens` has no split. */
  readonly totalTokens?: number;
  /** Absent when not priced. */
  readonly usd?: number;
  readonly costStatus: CostStatus;
  /**
   * `included`: already part of the turn that started it, shown as a share.
   * `additional`: its own cost on top of that turn.
   */
  readonly inclusion: 'included' | 'additional';
  /** Delegations only: how many runs it has had. */
  readonly runCount?: number;
  /**
   * A delegation's state. On a subagent, only `running` is used: the turn
   * that started it has not ended, so its share of that turn is not known yet.
   */
  readonly status?: 'running' | 'completed' | 'failed' | 'cancelled';
  /** The account-proxy accounts that served it, when the proxy did. */
  readonly proxyAccounts?: readonly CostProxyAccountRef[];
}

export interface CostBackgroundRow {
  readonly kind: CostHelperKind;
  readonly runCount: number;
  readonly usd: number;
  readonly notPricedCount: number;
  readonly tokens: CostTokenTotals;
}

export interface CostModelRow {
  readonly model: string;
  readonly turnCount: number;
  readonly usd: number;
  readonly notPricedCount: number;
  readonly tokens: CostTokenTotals;
}

export interface CostSourceBreakdown {
  readonly chat: { readonly usd: number; readonly turnCount: number };
  readonly subagents: {
    readonly usd: number;
    readonly items: readonly CostAttributedItem[];
  };
  readonly delegations: {
    readonly usd: number;
    readonly items: readonly CostAttributedItem[];
  };
  readonly background: {
    readonly usd: number;
    readonly rows: readonly CostBackgroundRow[];
  };
}

export type CostContextCategoryKind = 'used' | 'free' | 'buffer' | 'deferred';

export interface CostContextCategory {
  readonly name: string;
  readonly tokens: number;
  readonly kind: CostContextCategoryKind;
}

/** Context at the end of one turn, for the timeline. */
export interface CostContextPoint {
  readonly at: string;
  readonly endTokens: number;
  /** A compaction happened during this turn. */
  readonly compaction?: 'auto' | 'manual' | 'unknown';
}

export interface CostContextView {
  /** The latest fill. Absent when the provider reports none. */
  readonly latest?: {
    readonly usedTokens: number;
    readonly windowTokens: number;
    readonly at: string;
  };
  /** The latest category snapshot (Claude only). Empty when there is none. */
  readonly categories: readonly CostContextCategory[];
  readonly peak?: {
    readonly usedTokens: number;
    readonly windowTokens: number;
  };
  /** Oldest first. */
  readonly timeline: readonly CostContextPoint[];
}

export interface CostToolCount {
  /** A Canopy tool category key, such as `bash` or `read`. */
  readonly tool: string;
  readonly count: number;
}

export interface CostActivityStats {
  readonly turnCount: number;
  readonly totalDurationMs: number;
  readonly averageTurnMs: number | null;
  readonly p95TurnMs: number | null;
  readonly toolCallCount: number;
  readonly subagentCount: number;
  readonly plansCreated: number;
  readonly plansApproved: number;
  /** Most used first. */
  readonly topTools: readonly CostToolCount[];
}

export interface SessionBreakdownView {
  readonly chat: CostChatRow;
  readonly updatedAt: string | null;
  /** Retained entries only. */
  readonly sealedAt?: string;
  readonly bySource: CostSourceBreakdown;
  /** More than one row only when the chat's own turns used several models. */
  readonly chatTurnsByModel: readonly CostModelRow[];
  /** Every model that added cost to the chat, any source. */
  readonly byModel: readonly CostModelRow[];
  readonly context: CostContextView;
  readonly compactions: {
    readonly total: number;
    readonly auto: number;
    readonly manual: number;
  };
  readonly activity: CostActivityStats;
}

export interface PipelineRunStepCost {
  readonly jobId: string;
  readonly stepId: string;
  /** The step's name when the store has one; otherwise its id. */
  readonly label: string;
  readonly attemptCount: number;
  readonly model?: string;
  readonly harness?: string;
  readonly totals: CostTotals;
  /** The child run this step belongs to, when the run is nested. */
  readonly executionId: string;
  /** The account-proxy accounts that served the step, by attempt. */
  readonly proxyAccounts?: readonly CostProxyAccountRow[];
}

export interface PipelineRunChildCost {
  readonly executionId: string;
  readonly pipelineName: string;
  readonly usd: number;
  readonly agentStepCount: number;
  /** Records with tokens and no price. Absent when every record is priced. */
  readonly notPricedCount?: number;
}

export interface PipelineRunCostView {
  readonly run: CostPipelineRunRow;
  readonly updatedAt: string | null;
  /** Retained entries only. */
  readonly sealedAt?: string;
  readonly steps: readonly PipelineRunStepCost[];
  /**
   * Steps of the run, child runs included, that ran no agent and so cost
   * nothing. Read from the run's execution state, never inferred from missing
   * cost records; absent when that state is not available.
   */
  readonly nonAgentStepCount?: number;
  /** Pipeline Advisor reports for the run. Absent when there are none. */
  readonly advisor?: {
    readonly reportCount: number;
    readonly usd: number;
    readonly notPricedCount: number;
  };
  readonly subagents: readonly CostAttributedItem[];
  readonly delegations: readonly CostAttributedItem[];
  /** Child runs when the run is nested. */
  readonly childRuns: readonly PipelineRunChildCost[];
  readonly byModel: readonly CostModelRow[];
  /** The run's total per account-proxy account, when the proxy served it. */
  readonly byProxyAccount?: readonly CostProxyAccountRow[];
}

// ---- Requests -------------------------------------------------------------

export interface CostScopeRequest {
  readonly scope: CostScopeRef;
}

export interface CostChatRequest {
  readonly scope: CostScopeRef;
  readonly chatId: string;
  /** `summary` returns only the chat's row. Defaults to `full`. */
  readonly detail?: 'summary' | 'full';
  /** Returns one subagent's or delegation's row instead. */
  readonly subagentId?: string;
}

export interface CostPipelineRunRequest {
  readonly scope: CostScopeRef;
  /** A root run, or a child run (answered with its root). */
  readonly executionId: string;
}

/**
 * Why a view asks for a refresh. `manual` flushes pending audit entries
 * first. `open` runs only when the last refresh is stale. `turn` is debounced.
 */
export type CostRefreshTrigger = 'manual' | 'open' | 'turn';

export interface CostRefreshRequest {
  readonly scope: CostScopeRef;
  readonly trigger: CostRefreshTrigger;
}

// ---- Results --------------------------------------------------------------

export type CostChatView =
  | { readonly kind: 'summary'; readonly chat: CostChatRow }
  | { readonly kind: 'full'; readonly breakdown: SessionBreakdownView }
  | {
      readonly kind: 'subagent';
      readonly chat: CostChatRow;
      readonly item: CostAttributedItem;
    };

export interface CostRefreshReceipt {
  /** False when the trigger's policy found nothing to do. */
  readonly ran: boolean;
  readonly updatedAt: string | null;
  /** Bumped on every refresh that changed the scope. */
  readonly revision: number;
}

/** Why a scope has no cost to read right now. */
export const COST_VIEW_UNAVAILABLE_REASONS = [
  /** The scope has no entry, or the entry no longer exists. */
  'no_scope',
  /** The cost runtime is not running (startup or shutdown). */
  'runtime_unavailable',
  /**
   * The host doesn't serve this read for the scope, such as a cloud chat's
   * full breakdown (CAN-6941). Asking again won't change it.
   */
  'not_served',
] as const;

export type CostViewUnavailableReason =
  (typeof COST_VIEW_UNAVAILABLE_REASONS)[number];

export const COST_ERROR_REASONS = [
  'INVALID_INPUT',
  /** The chat, subagent or run has no recorded cost in the scope. */
  'NOT_FOUND',
  /** A retained entry's cost is final and cannot be refreshed. */
  'SCOPE_SEALED',
  'UNKNOWN',
] as const;

export type CostErrorReason = (typeof COST_ERROR_REASONS)[number];

/**
 * A view read's outcome. An error is never folded into an empty result, so an
 * interface can tell "no cost yet" from "could not read the cost".
 */
export type CostViewResult<Value> =
  | { readonly status: 'ok'; readonly value: Value }
  | {
      readonly status: 'unavailable';
      readonly reason: CostViewUnavailableReason;
    }
  | {
      readonly status: 'error';
      readonly reason: CostErrorReason;
      readonly message: string;
    };

/** Broadcast after a refresh changed stored figures. IDs and a revision only. */
export interface CostUpdatedEvent {
  readonly scopes: readonly CostScopeRef[];
  readonly revision: number;
}

// ---- Helpers --------------------------------------------------------------

export const EMPTY_COST_TOKEN_TOTALS: CostTokenTotals = {
  input: 0,
  output: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
};

/** Counts input, output, cache reads and cache writes; reasoning is part of output. */
export function costTokenCount(tokens: CostTokenTotals): number {
  return (
    tokens.input +
    tokens.output +
    tokens.cacheReadInputTokens +
    tokens.cacheCreationInputTokens
  );
}

export function createEmptyCostTotals(): CostTotals {
  return {
    usd: 0,
    bySource: {
      chat: 0,
      pipeline: 0,
      subagents: 0,
      delegations: 0,
      background: 0,
    },
    byBilling: {
      subscription: 0,
      ai_credits: 0,
      account_proxy: 0,
      api_key: 0,
      org_gateway: 0,
      local: 0,
      unknown: 0,
    },
    tokens: EMPTY_COST_TOKEN_TOTALS,
    notPricedCount: 0,
    hasEstimate: false,
  };
}

/** A stable key for a scope, for maps and change events. */
export function costScopeKey(scope: CostScopeRef): string {
  return scope.kind === 'entry'
    ? `entry:${scope.projectId}:${scope.worktreeId}`
    : `retained:${scope.projectId}:${scope.containerId}`;
}

export function isSameCostScope(a: CostScopeRef, b: CostScopeRef): boolean {
  return costScopeKey(a) === costScopeKey(b);
}
