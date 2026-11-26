// ---------------------------------------------------------------------------
// Team activity feed read DTOs (CAN-373).
//
// The web server assembles a poll-first, team/org-scoped activity feed from
// already-synced telemetry rows (transcript turns, plans, PR status, worktree
// summaries, pipeline runs). This module is the single source of truth for the
// serializable read shapes that cross the web API ⇄ browser boundary.
//
// These are READ DTOs only. The telemetry *ingest* payloads the desktop client
// posts live in `../telemetry`. Both modules stay dependency-free (no Node,
// Prisma, or React) so the web service, the desktop main process, and the
// renderer can all import them.
// ---------------------------------------------------------------------------

// ===========================================================================
// Item-type vocabulary.
// ===========================================================================

/**
 * The feed item types, newest-first. All are team/org-scoped; `USER`-private
 * rows never surface. `plan_approved` fires on implementation-start (see
 * CAN-373 F4), not on review-status change. `plan_shared` / `plan_updated`
 * (CAN-393) fire when a SharedPlan is first shared / re-synced to a team or
 * organization scope and link to the standalone shared-plan web view.
 * `run_shared` (CAN-395) fires when a finished agent session is explicitly
 * shared to an organization scope and links to the standalone run web view.
 */
export const FEED_ITEM_TYPES = [
  'pr_opened',
  'pr_merged',
  'plan_approved',
  'plan_shared',
  'plan_updated',
  'run_shared',
  'worktree_started',
  'worktree_updated',
  'agent_session',
  'pipeline_run',
  'run_failed',
] as const;
export type FeedItemType = (typeof FEED_ITEM_TYPES)[number];

// ===========================================================================
// Shared attribution + base shapes.
// ===========================================================================

/**
 * Who a feed item is attributed to. Resolved server-side from the row's
 * `ownerUserId` / `createdByUserId`. `displayName` is null when the user can
 * no longer be resolved (e.g. removed from the org).
 */
export interface FeedActor {
  userId: string;
  displayName: string | null;
}

/** Fields common to every feed item. */
export interface FeedItemBase {
  /** Stable, shareable permalink id. Unique within a scope. */
  id: string;
  type: FeedItemType;
  /** ISO-8601 instant used for newest-first ordering. */
  occurredAt: string;
  actor: FeedActor;
  /** Server `Worktree.externalId` this item belongs to, when applicable. */
  worktreeId: string | null;
}

// ===========================================================================
// Per-type hydrated DTOs.
// ===========================================================================

export interface PrOpenedFeedItem extends FeedItemBase {
  type: 'pr_opened';
  repoName: string;
  prNumber: number;
  prUrl: string;
  title: string;
  branchName: string | null;
  checkStatus: string;
  reviewStatus: string;
  hasConflicts: boolean;
  commentCount: number;
  summary: string | null;
}

export interface PrMergedFeedItem extends FeedItemBase {
  type: 'pr_merged';
  repoName: string;
  prNumber: number;
  prUrl: string;
  title: string;
  branchName: string | null;
  summary: string | null;
  /** Diff stats (CAN-373 F1). */
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  /** Enrichment from the worktree's agent activity, when derivable. */
  totalCostUsd: number | null;
  totalTokens: number | null;
  /** All distinct models used for the actual work, most-recently-used first.
   * Empty when no primary-work turn was correlated. */
  models: string[];
  planId: string | null;
  /** Collaborative `/plans/{id}` link, when the plan was shared. */
  sharedPlanId: string | null;
  /** Human-readable title of the correlated plan, for the plan chip. */
  planTitle: string | null;
  runUrl: string | null;
}

export interface PlanApprovedFeedItem extends FeedItemBase {
  type: 'plan_approved';
  planId: string;
  title: string;
  reviewStatus: string | null;
  planVersion: number | null;
}

/**
 * A plan was shared to a team / organization (CAN-393). `sharedPlanId` is the
 * `SharedPlan.externalId`, used to link to the standalone `…/plans/{id}` web
 * view where teammates can read and comment.
 */
export interface PlanSharedFeedItem extends FeedItemBase {
  type: 'plan_shared';
  sharedPlanId: string;
  title: string;
  shareScope: string;
}

/**
 * A previously shared plan was re-synced with new content or comments
 * (CAN-393). Updated in place as the shared plan evolves.
 */
export interface PlanUpdatedFeedItem extends FeedItemBase {
  type: 'plan_updated';
  sharedPlanId: string;
  title: string;
  shareScope: string;
  remoteRevisionNumber: number | null;
}

/**
 * A finished agent session was explicitly shared to an organization (CAN-395).
 * `sharedRunId` is the `SharedRun.externalId`, used to link to the standalone
 * `…/runs/{id}` web view where org members can read the assembled transcript.
 */
export interface RunSharedFeedItem extends FeedItemBase {
  type: 'run_shared';
  sharedRunId: string;
  title: string;
  shareScope: string;
  /** Terminal status of the shared session (drives the card badge). */
  status: string;
  /** Number of turns in the shared session. */
  turnCount: number;
  /** Number of tool invocations across the session's turns. */
  toolUseCount: number;
  /** Model of the session, when known. */
  model: string | null;
  /** Total cost of the session in USD, when recorded. */
  totalCostUsd: number | null;
}

export interface WorktreeStartedFeedItem extends FeedItemBase {
  type: 'worktree_started';
  branchName: string;
  workspaceName: string | null;
}

export interface WorktreeUpdatedFeedItem extends FeedItemBase {
  type: 'worktree_updated';
  branchName: string;
  /** Latest synced summary; updated in place as the worktree evolves. */
  summary: string | null;
}

export interface AgentSessionFeedItem extends FeedItemBase {
  type: 'agent_session';
  clientChatId: string;
  turnCount: number;
  /** Latest turn status in the session (drives the card badge). */
  latestStatus: string;
  latestModel: string | null;
  totalCostUsd: number | null;
  /** Number of tool invocations across the session's turns. */
  toolUseCount: number | null;
  /**
   * The canonical organization transcript session ID, set only for an
   * organization owner with the transcript browser on when the session has a
   * shared transcript. Absent otherwise; older clients ignore it.
   */
  transcriptSessionId?: string;
}

export interface PipelineRunFeedItem extends FeedItemBase {
  type: 'pipeline_run';
  pipelineId: string;
  pipelineName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  runDurationMs: number | null;
  jobCount: number | null;
  stepCount: number | null;
  agentStepCount: number | null;
  retryCount: number | null;
}

export interface RunFailedFeedItem extends FeedItemBase {
  type: 'run_failed';
  clientChatId: string | null;
  label: string;
  status: string;
  model: string | null;
  /** Always true — only emitted for the terminal failure of a session. */
  notificationWorthy: true;
}

/** Discriminated union of every hydrated feed item. */
export type FeedItem =
  | PrOpenedFeedItem
  | PrMergedFeedItem
  | PlanApprovedFeedItem
  | PlanSharedFeedItem
  | PlanUpdatedFeedItem
  | RunSharedFeedItem
  | WorktreeStartedFeedItem
  | WorktreeUpdatedFeedItem
  | AgentSessionFeedItem
  | PipelineRunFeedItem
  | RunFailedFeedItem;

// ===========================================================================
// Response shapes.
// ===========================================================================

/**
 * One page of the feed. `nextCursor` is an opaque base64url keyset cursor;
 * null when the page is the last one.
 */
export interface FeedPageResponse {
  items: FeedItem[];
  nextCursor: string | null;
}

/**
 * A single item resolved by its stable id, with a bidirectional window of
 * surrounding items for permalink/deep-link rendering. `forwardCursor` pages
 * toward newer items; `backwardCursor` toward older. Either is null at an edge.
 */
export interface FeedItemPermalinkResponse {
  anchor: FeedItem;
  /** Items newer than the anchor, newest-first. */
  newer: FeedItem[];
  /** Items older than the anchor, newest-first. */
  older: FeedItem[];
  forwardCursor: string | null;
  backwardCursor: string | null;
}

/**
 * One entry in a worktree's summary-snapshot timeline. `id` is the snapshot's
 * server `externalId`; `summary` is the plaintext search abstract; `generatedAt`
 * is the client generation instant.
 */
export interface WorktreeSummaryHistoryEntry {
  id: string;
  summary: string;
  generatedAt: string;
}

/**
 * A page of a `worktree_updated` card's summary history, newest-first.
 * `nextCursor` is an opaque keyset cursor; null on the last page.
 */
export interface WorktreeSummaryHistoryResponse {
  entries: WorktreeSummaryHistoryEntry[];
  nextCursor: string | null;
}
