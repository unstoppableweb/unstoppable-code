import type { NotificationSpaceProvenance } from '../space-notifications';
import type { ModelRoutingAttributionV1 } from '../model-routing';

/** The caller no longer has USE access to the bound source project. */
export const TELEMETRY_TRACKED_SOURCE_ACCESS_DENIED_CODE =
  'tracked-source-access-denied';

/**
 * The target does not own the work: organization-project activity may reach
 * only private scope or its owning organization (CAN-2948, CAN-3296), and
 * Personal activity may reach only private scope (CAN-3515).
 */
export const TELEMETRY_TRACKED_SOURCE_ORGANIZATION_TARGET_CODE =
  'tracked-source-organization-target';

/** An existing telemetry row belongs to a different immutable owner scope. */
export const TELEMETRY_OWNER_SCOPE_CONFLICT_CODE =
  'telemetry_owner_scope_conflict';

// ---------------------------------------------------------------------------
// Server telemetry ingest API contracts (CAN-401).
//
// The desktop app uploads agent telemetry (transcripts, plans, per-turn
// rollup metadata, per-repo PR status) to the web server so team-collaboration
// surfaces (activity feed, cost dashboard, shareable runs) can reproduce the
// desktop Statistics panel for a whole team.
//
// Each stored record separates into three tiers:
//   1. Encrypted body  — sensitive free-text (transcript/plan text). Encrypted
//      at rest server-side; never aggregated. Travels here as plaintext `body`
//      (TLS in transit), and the server encrypts it before persisting.
//   2. Plaintext summary — a guardrailed search abstract. Scrubbing is
//      client-side (CAN-374); the server only length-validates.
//   3. Plaintext strongly-typed rollup metadata — numeric/enum/timestamp
//      columns the server can SUM/GROUP BY without decrypting any body.
//
// IMPORTANT: this module must stay dependency-free (no node:crypto, no
// filesystem, no Prisma, no React). It mirrors the desktop `AgentAuditEntry`
// and GitHub PR shapes without importing desktop-shared (which web cannot
// import). The compile-time fidelity test in
// `packages/desktop-shared/src/__tests__/telemetry-protocol-fidelity.test.ts`
// guards the unions against drift from their desktop sources.
// ---------------------------------------------------------------------------

// Type-only, and from a sibling protocol module — the dependency-free rule
// above still holds.
import type { TelemetryEnforcedScopeMap } from '../canopy-server';

// ===========================================================================
// Wire version.
// ===========================================================================

/** Wire version of the telemetry ingest API. Bump only on breaking changes. */
export const TELEMETRY_API_VERSION = 1;

// ===========================================================================
// Subscription plan catalog — canonical plan keys, labels, and default prices
// shared by the hosted web billing tables and the desktop Usage page. Pure
// helpers + serializable constants, so they belong in protocol.
// ===========================================================================

export * from './subscription-plan-catalog';
export * from './tool-category-labels';

// ===========================================================================
// Union constants — single source of truth for the wire vocabularies.
//
// Shapes mirror `AgentAuditEntry` / `AgentAuditToolCounts` and the GitHub PR
// unions in `packages/desktop-shared/src/types/github.ts`.
// ===========================================================================

/** Mirrors desktop `AgentProviderType`. */
export const TELEMETRY_PROVIDERS = ['claude', 'codex', 'ollama'] as const;
export type TelemetryProvider = (typeof TELEMETRY_PROVIDERS)[number];

/** Mirrors desktop `AgentAuditEventType` (16 values). */
export const TELEMETRY_EVENT_TYPES = [
  'worktree_chat',
  'standalone_chat',
  'app_advisor',
  'pipeline_editor',
  'pipeline_agent_turn',
  'pipeline_advisor',
  'pr_generation',
  'commit_message_generation',
  'branch_naming',
  'cron_generation',
  'automation_if_command_generation',
  'worktree_summary',
  'chat_summary',
  'archive_summary',
  'worktree_plan_chat',
  'worktree_plan_diagram',
] as const;
export type TelemetryEventType = (typeof TELEMETRY_EVENT_TYPES)[number];

/** Mirrors desktop `AgentAuditStatus` (5 values). */
export const TELEMETRY_TURN_STATUSES = [
  'running',
  'success',
  'failure',
  'cancelled',
  'interrupted',
] as const;
export type TelemetryTurnStatus = (typeof TELEMETRY_TURN_STATUSES)[number];

export const TELEMETRY_ATTENTION_STATES = [
  'needs_input',
  'blocked',
  'clear',
] as const;
export type TelemetryAttentionState =
  (typeof TELEMETRY_ATTENTION_STATES)[number];

export const TELEMETRY_ATTENTION_REASONS = [
  'tool_approval',
  'ask_user',
  'plan_review',
  'pipeline_input',
  'usage_limit',
  'auth_required',
  'error',
] as const;
export type TelemetryAttentionReason =
  (typeof TELEMETRY_ATTENTION_REASONS)[number];

/**
 * Which reasons each attention state may carry.
 *
 * The ingest parser rejects any other pair, and a parse error fails the WHOLE
 * request — every turn, plan, and pull request in that piece, not just the
 * attention entry. So the acceptance table belongs here, beside the enums it
 * partitions, rather than as a private copy inside the parser: a reason added
 * to {@link TELEMETRY_ATTENTION_REASONS} and wired on the desktop would
 * otherwise start 400-ing that worktree's telemetry sync outright.
 *
 * `clear` ends whichever block was raised, so it carries that block's reason.
 */
export const TELEMETRY_ATTENTION_REASONS_BY_STATE: Readonly<
  Record<TelemetryAttentionState, readonly TelemetryAttentionReason[]>
> = {
  needs_input: ['tool_approval', 'ask_user', 'plan_review', 'pipeline_input'],
  blocked: ['usage_limit', 'auth_required', 'error'],
  clear: TELEMETRY_ATTENTION_REASONS,
};

/** Mirrors desktop `AgentAuditChatMode`. Null/omitted implies `canopy`. */
export const TELEMETRY_CHAT_MODES = ['canopy', 'terminal'] as const;
export type TelemetryChatMode = (typeof TELEMETRY_CHAT_MODES)[number];

/**
 * Mirrors `keyof AgentAuditToolCounts` — every per-category tool count the
 * desktop tracks. Kept exhaustive by the compile-time fidelity test.
 */
export const TELEMETRY_TOOL_CATEGORIES = [
  'thinking',
  'bash',
  'read',
  'readLines',
  'writeEdit',
  'plan',
  'fileEdit',
  'fileAdd',
  'fileDelete',
  'search',
  'grep',
  'web',
  'agent',
  'workflow',
  'tasks',
  'taskStop',
  'skills',
  'monitor',
  'claude',
  'scheduleWakeup',
  'askUser',
  'scriptOutput',
  'watcher',
  'canopy',
  'graph',
  'appAdvisor',
  'pipelineEditor',
  'mcp',
  'other',
] as const;
export type TelemetryToolCategory = (typeof TELEMETRY_TOOL_CATEGORIES)[number];

/** Mirrors desktop `WorkspaceType`. */
export const TELEMETRY_WORKSPACE_TYPES = [
  'single-repo',
  'multi-repo',
  'cowork',
] as const;
export type TelemetryWorkspaceType = (typeof TELEMETRY_WORKSPACE_TYPES)[number];

/** Mirrors desktop `WorktreeData.status`. */
export const TELEMETRY_WORKTREE_STATUSES = ['active', 'done'] as const;
export type TelemetryWorktreeStatus =
  (typeof TELEMETRY_WORKTREE_STATUSES)[number];

/** Owner visibility scope requested at ingest time. */
export const TELEMETRY_SHARE_SCOPES = [
  'private',
  'team',
  'organization',
] as const;
export type TelemetryShareScope = (typeof TELEMETRY_SHARE_SCOPES)[number];

/** Mirrors desktop `PrState` (`types/github.ts`). */
export const PR_STATES = ['open', 'merged', 'closed', 'draft'] as const;
export type PrStateValue = (typeof PR_STATES)[number];

/** Mirrors desktop `CheckStatus` (`types/github.ts`). */
export const PR_CHECK_STATUSES = [
  'passing',
  'failing',
  'pending',
  'neutral',
  'none',
] as const;
export type PrCheckStatusValue = (typeof PR_CHECK_STATUSES)[number];

/** Mirrors desktop `ReviewStatus` (`types/github.ts`). */
export const PR_REVIEW_STATUSES = [
  'approved',
  'changes_requested',
  'pending',
  'none',
] as const;
export type PrReviewStatusValue = (typeof PR_REVIEW_STATUSES)[number];

/**
 * Terminal/active states of a synced pipeline run. Mirrors the narrowed
 * `PipelineRunUsageEvent.status` desktop vocabulary (lowercase). The server
 * maps these onto its `PipelineRunStatus` Prisma enum.
 */
export const PIPELINE_RUN_STATUSES = [
  'running',
  'success',
  'failure',
  'cancelled',
] as const;
export type PipelineRunStatusValue = (typeof PIPELINE_RUN_STATUSES)[number];

// ===========================================================================
// Byte / count limits enforced at the route boundary.
// ===========================================================================

/** Max raw bytes of a single turn/plan encrypted `body`. Mirrors plans. */
export const MAX_TELEMETRY_BODY_BYTES = 1024 * 1024;

/**
 * Higher per-turn/plan encrypted `body` cap accepted ONLY on the explicit
 * full-session run-share ingest path (`TelemetryIngestRequest.fullSession`,
 * CAN-396). Lowered to 3 MiB so a single share turn — even when JSON string
 * escaping roughly doubles its serialized size — still fits within the client
 * chunk target {@link MAX_TELEMETRY_INGEST_BATCH_BYTES}, guaranteeing every
 * turn fits in some chunk. Ambient sync never sets `fullSession` and stays
 * capped at {@link MAX_TELEMETRY_BODY_BYTES}.
 */
export const MAX_TELEMETRY_SHARE_BODY_BYTES = 3 * 1024 * 1024;

/** Max raw bytes of a single plaintext `summary`. */
export const MAX_TELEMETRY_SUMMARY_BYTES = 32 * 1024;

/**
 * Client chunk target for a single ingest POST, measured on the serialized JSON
 * (`utf8ByteLength(JSON.stringify(request))`) so string-escaping is included.
 * The desktop uploader splits any assembled request into pieces each at or
 * under this budget before POSTing.
 *
 * Invariant (must hold at all times):
 *   BATCH_BYTES (8 MiB) < INGEST_REQUEST_BYTES (9_000_000) < Next's ~10 MB limit
 *
 * A correctly-chunked client stays under the 8 MiB target, is always accepted
 * by the server's {@link MAX_TELEMETRY_INGEST_REQUEST_BYTES} hard cap, and never
 * reaches Next's ~10 MB request-body read limit (which silently truncates the
 * body before the route reads it).
 */
export const MAX_TELEMETRY_INGEST_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * Coarse server-side hard cap on a single ingest POST. Set above the 8 MiB
 * client chunk target {@link MAX_TELEMETRY_INGEST_BATCH_BYTES} so correctly
 * chunked clients are always accepted, but under both 10,000,000 and 10 MiB so
 * an over-budget POST returns a clean 413 *before* the self-hosted Next.js
 * standalone server silently truncates the body at its ~10 MB request-read
 * limit (truncation → `JSON.parse` failure → misleading 400).
 */
export const MAX_TELEMETRY_INGEST_REQUEST_BYTES = 9_000_000;

/** Max worktrees accepted per ingest request. */
export const MAX_TELEMETRY_WORKTREES_PER_REQUEST = 20;
export const MAX_TELEMETRY_ATTENTION_PER_REQUEST = 100;
export const ATTENTION_DETAIL_MAX_CHARS = 160;

/** Max transcript turns accepted per worktree. */
export const MAX_TELEMETRY_TURNS_PER_WORKTREE = 100;

/** Max plans accepted per worktree. */
export const MAX_TELEMETRY_PLANS_PER_WORKTREE = 25;

/** Max pull requests accepted per worktree. */
/**
 * Project ids of chat surfaces that are not rows in `workspaces/index.json`.
 *
 * App Advisor, plan-explore, code-review chat and the Pipeline Assistant are
 * advisory or embedded surfaces rather than authored work areas. Their turns
 * ARE synced (they belong in the activity feed and in usage/cost), but the
 * `worktrees` rows they necessarily create must never be counted as authored
 * worktrees — see `advisoryWorkspaceExclusion` in the web telemetry rollups.
 *
 * Shared here because the desktop resolves these ids when labelling the
 * workspace envelope and the server excludes them from worktree counts; a
 * fidelity test asserts the two lists cannot drift.
 */
export const ADVISORY_WORKSPACE_PROJECT_IDS = [
  'app-advisor',
  'plan-explore-chat',
  'code-review-chat',
  'pipeline-editor',
] as const;
export type AdvisoryWorkspaceProjectId =
  (typeof ADVISORY_WORKSPACE_PROJECT_IDS)[number];

export const MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE = 25;

/**
 * Upper bound on a single turn's wall-clock duration (7 days). The
 * `transcript_turns.duration_ms` column is INTEGER (24.8-day ceiling), but the
 * real constraint is semantic: a multi-day "turn" means a stale `startedAt` or
 * an entry that was never finalized, not a long-running agent. CAN-3106.
 */
export const MAX_TELEMETRY_TURN_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Max pipeline runs accepted per worktree. */
export const MAX_TELEMETRY_PIPELINE_RUNS_PER_WORKTREE = 50;

/** Max worktree summary snapshots accepted per worktree. */
export const MAX_TELEMETRY_SUMMARIES_PER_WORKTREE = 50;

// ===========================================================================
// String-length limits — single source of truth shared by the server clampers
// (`telemetry-service.ts`) and the client clampers (`telemetry-mapping.ts`).
//
// Derived from the server's historical per-field caps. The server no longer
// hard-rejects on length; it clamps to these bounds, and the client clamps to
// the same bounds before sending so the two sides can never drift. These also
// match the backing Prisma column widths (e.g. `clientTurnId @db.VarChar(128)`).
// ===========================================================================

/**
 * Max length of any client-supplied correlation id: `clientTurnId`,
 * `clientPlanId`, `clientPipelineRunId`, `pipelineId`, `clientChatId`,
 * `clientRepoId`, `clientPipelineId`, `clientPipelineExecutionId`,
 * `clientLocalId`, `repoId`.
 */
export const MAX_TELEMETRY_CLIENT_ID_LENGTH = 128;

function fnv1aHex(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Collision-safe clamp for correlation-key ids. Short ids pass through
 * untouched. Over-length ids are truncated to `maxLen - 9` chars plus a `'~'`
 * separator and an 8-hex FNV-1a hash of the full value, so the result is
 * exactly `maxLen` chars and stable across runs. For a bound under 9 the
 * suffix cannot fit, so it degrades to plain truncation.
 *
 * The desktop clamps every `clientLocalId` it uploads with this, and the
 * server recomputes the same ids to find a checkout's rows (CAN-3517), so the
 * two sides share one implementation.
 */
export function clampTelemetryClientId(
  value: string,
  maxLen: number = MAX_TELEMETRY_CLIENT_ID_LENGTH,
): string {
  if (value.length <= maxLen) {
    return value;
  }
  if (maxLen < 9) {
    return value.slice(0, maxLen);
  }
  return `${value.slice(0, maxLen - 9)}~${fnv1aHex(value)}`;
}

/** The owner-scope target key an organization-scoped upload is namespaced by. */
export function telemetryOrganizationTargetKey(organizationId: string): string {
  return `org:${organizationId}`;
}

/**
 * The `clientLocalId` the desktop uploads a non-private target's rows under:
 * `${baseId}-${first 16 hex of sha256(targetKey)}`, clamped. The caller
 * supplies the SHA-256 hex digest of the target key, because this package has
 * no crypto. Private rows keep the bare id.
 */
export function telemetryNamespacedClientLocalId(
  baseId: string,
  targetKeySha256Hex: string,
): string {
  return clampTelemetryClientId(`${baseId}-${targetKeySha256Hex.slice(0, 16)}`);
}

/**
 * Suffix of the private fallback id (CAN-3601). When a legacy organization
 * row already holds a checkout's bare id, the desktop uploads the member's
 * Personal rows for it under `${baseId}-${suffix}` instead, for both the
 * workspace and its worktrees.
 *
 * The value is frozen: it is literally `sha256('private-owner-conflict-v1')`
 * sliced to 16 hex chars and is already persisted. The desktop writes these
 * ids; the server recomputes them to find a checkout's Personal rows.
 * A protocol test asserts it still equals the sha256 derivation.
 */
export const TELEMETRY_PRIVATE_OWNER_CONFLICT_ID_SUFFIX = '80877b3cb26d605c';

/** The private fallback `clientLocalId` for `baseId`, clamped. */
export function telemetryPrivateOwnerConflictClientLocalId(
  baseId: string,
): string {
  return clampTelemetryClientId(
    `${baseId}-${TELEMETRY_PRIVATE_OWNER_CONFLICT_ID_SUFFIX}`,
  );
}

/** Max length of a display label: `turn.label`, `worktree.branchName`, `pr.title`. */
export const MAX_TELEMETRY_LABEL_LENGTH = 512;

/**
 * Stable namespace suffix appended to the `clientLocalId`s written by the
 * explicit "Share run" ingest (CAN-395): `${baseId}-${RUN_SHARE_ID_SUFFIX}`.
 *
 * The value is frozen: it is literally `sha256('canopy-run-share-v1')` sliced
 * to 16 hex chars and is already persisted in the database, so it can never be
 * recomputed differently. It lives in the protocol because both sides need it —
 * the desktop client to *write* the namespaced ids, and the web rollups to
 * *exclude* those USER-owned duplicate rows from scoring queries whose scope
 * (`user-global`) has no owner filter to separate them from the ambient rows.
 *
 * A desktop test asserts this still equals the sha256 derivation.
 */
export const RUN_SHARE_ID_SUFFIX = '0d67ee24e4105624';

/**
 * `clientLocalId` of the synthetic worktree the desktop PR-telemetry
 * reconciliation sweep attributes recovered historical merges to.
 *
 * Lives in the protocol for the same reason as `RUN_SHARE_ID_SUFFIX` above:
 * both sides need it and neither may import the other. The desktop sweep
 * *writes* worktree rows under this id; `apps/web` *reads* it to suppress
 * on-PR provenance comments for those rows, since the sweep recovers merges
 * Canopy did not necessarily produce and commenting on them would be a
 * confidently wrong public attribution.
 *
 * Previously duplicated as a bare literal on both sides, where a rename would
 * have silently disabled the web-side guard rather than failing a build.
 */
export const PR_RECONCILIATION_CLIENT_LOCAL_ID = 'pr-reconciliation';

/**
 * Max length of a name/title field: `model`, `plan.title`, `repoName`,
 * `pipelineName`, `workspace.name`.
 */
export const MAX_TELEMETRY_NAME_LENGTH = 256;

/** Max length of `plan.reviewStatus`. */
export const MAX_TELEMETRY_REVIEW_STATUS_LENGTH = 32;

/** Max length of `contentHash`. */
export const MAX_TELEMETRY_CONTENT_HASH_LENGTH = 64;

/** Max length of `pr.prUrl`. */
export const MAX_TELEMETRY_PR_URL_LENGTH = 1024;

// ===========================================================================
// Payload shapes (request tier).
// ===========================================================================

/** Token totals; mirrors desktop `AgentAuditTokenTotals`. */
export interface TelemetryTokenTotals {
  input: number;
  output: number;
  cacheReadInput: number;
  cacheCreationInput: number;
}

/**
 * Compact wire form of the desktop `AgentObservedCost` carried on a synced
 * turn so hosted telemetry preserves the unknown/unpriced status (rather than
 * collapsing everything to `totalCostUsd`). Strings are intentionally loose
 * (`reason`, `pricingBasis`, `contextTier`, `canonicalServiceTier`) so the
 * server can persist forward-compatible values without redeploying the
 * protocol. Parsing must be optional and backward-compatible.
 */
export interface TelemetryObservedCost {
  status: 'priced' | 'partially_priced' | 'unpriced';
  reason: string;
  tokenUsd?: number;
  nonTokenUsd?: number;
  pricingBasis?: string;
  contextTier?: string;
  canonicalServiceTier?: string;
}

/**
 * Sparse per-category tool counts. Only non-zero categories should be sent;
 * absent categories are treated as zero.
 */
export type TelemetryToolCountMap = Partial<
  Record<TelemetryToolCategory, number>
>;

/**
 * One transcript turn, mirroring the rollup-relevant fields of
 * `AgentAuditEntry`. `body` is plaintext free-text the server encrypts at
 * rest; `summary` is a plaintext search abstract (scrubbed client-side).
 */
export interface TelemetryTurnPayload {
  clientTurnId: string;
  eventType: TelemetryEventType;
  status: TelemetryTurnStatus;
  provider: TelemetryProvider;
  chatMode?: TelemetryChatMode;
  label: string;
  model?: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokens?: TelemetryTokenTotals;
  totalCostUsd?: number;
  /**
   * Optional structured cost breakdown mirroring desktop `observedCost`.
   * Backward-compatible: payloads omitting it must still parse, and the
   * server persists it only when present.
   */
  observedCost?: TelemetryObservedCost;
  /** Bounded, text-free attribution for a turn whose model was chosen by Auto. */
  modelRouting?: ModelRoutingAttributionV1;
  messageCount?: number;
  assistantMessageCount?: number;
  toolUseCount?: number;
  subAgentCount?: number;
  toolCounts?: TelemetryToolCountMap;
  /** Client correlation refs (plaintext, non-sensitive). */
  clientChatId?: string;
  /**
   * The renderer's per-turn user message id (`msg-{n}-{epochMs}`). This is the
   * correlation key turn-level feedback (CAN-1521) joins on, because
   * `clientTurnId` is rewritten by the mapping layer's `clampId` and cannot be
   * reproduced server-side.
   */
  clientUserMessageId?: string;
  clientRepoId?: string;
  clientPipelineId?: string;
  clientPipelineExecutionId?: string;
  /** Plaintext search abstract; scrubbed client-side per CAN-374. */
  summary?: string;
  /** Sensitive free-text; encrypted at rest server-side. */
  body?: string;
  /** Optional no-op short-circuit hint; matches the stored row's hash. */
  contentHash?: string;
  /**
   * True when this turn's LLM traffic was routed through the UD AI Credits
   * gateway proxy rather than a native provider subscription. Emitted only when
   * true; absent turns are treated as native. Routed turns are not attributed
   * to a subscription account, so the account fields below are omitted.
   */
  aiCreditsRouted?: boolean;
  /**
   * Stable attribution key for the driving provider subscription account:
   * `` `${provider}:${normalizedEmail}` ``. Present only for native
   * subscription turns (not routed, not API-key/Bedrock).
   */
  providerAccountKey?: string;
  /** Email of the driving provider subscription account, when attributed. */
  providerAccountEmail?: string;
  /** Raw provider plan/subscription type string, when attributed. */
  providerPlanType?: string;
}

/** One plan, mirroring the rollup-relevant plan fields. */
export interface TelemetryPlanPayload {
  clientPlanId: string;
  title: string;
  reviewStatus: string;
  planVersion?: number;
  planTextBytes?: number;
  planLineCount?: number;
  clientChatId?: string;
  summary?: string;
  body?: string;
  contentHash?: string;
  /**
   * Approximate instant an implementation was first started against this plan
   * (the plan was approved via any implement path, or — for legacy plans — its
   * `linkedExecutionIds` became non-empty). Drives the `plan_approved` feed
   * card. Absent until implementation begins. (CAN-373 F4.)
   */
  implementationStartedAt?: string;
}

/**
 * One per-repo PR for a worktree, built client-side from
 * `WorktreePrStatus.repos[].status` (repos with a null status are skipped).
 * GitHub PR metadata is not sensitive — plaintext rollup tier, no encryption.
 */
export interface TelemetryPullRequestPayload {
  repoId: string;
  repoName: string;
  prNumber: number;
  prUrl: string;
  title: string;
  state: PrStateValue;
  checkStatus: PrCheckStatusValue;
  reviewStatus: PrReviewStatusValue;
  hasConflicts: boolean;
  commentCount: number;
  prUpdatedAt?: string;
  lastCheckedAt?: string;
  /** PR open instant from Octokit `created_at`. (CAN-373 F1.) */
  openedAt?: string;
  /** PR merge instant from Octokit `merged_at`. (CAN-373 F1.) */
  mergedAt?: string;
  /** Lines added across the PR diff. (CAN-373 F1.) */
  additions?: number;
  /** Lines deleted across the PR diff. (CAN-373 F1.) */
  deletions?: number;
  /** Files changed in the PR diff. (CAN-373 F1.) */
  changedFiles?: number;
}

/**
 * One completed pipeline run synced for the activity feed. Built client-side
 * from a `pipeline_run_completed` `PipelineRunUsageEvent`. Numeric/timestamp
 * rollup tier — no encryption. (CAN-373 F2.)
 */
export interface TelemetryPipelineRunPayload {
  clientPipelineRunId: string;
  pipelineId: string;
  pipelineName: string;
  status: PipelineRunStatusValue;
  startedAt: string;
  completedAt?: string;
  runDurationMs?: number;
  jobCount?: number;
  stepCount?: number;
  agentStepCount?: number;
  retryCount?: number;
}

/**
 * One append-on-change worktree summary snapshot. `clientSnapshotId` is the
 * client-authoritative stable id assigned at write time; it flows local file →
 * wire → server row and makes the server append idempotent (re-syncs and
 * debounce coalescing cannot duplicate). `summary` is a plaintext search
 * abstract, scrubbed client-side like the scalar latest-pointer `summary`.
 */
export interface TelemetryWorktreeSummarySnapshot {
  clientSnapshotId: string;
  generatedAt: string;
  summary: string;
}

/** One worktree with its nested children. */
export interface TelemetryWorktreePayload {
  /** Full source identity; absent on legacy and explicit Share-run uploads. */
  notificationSpace?: NotificationSpaceProvenance;
  clientLocalId: string;
  /** Unscoped producer id shared by every owner-scope fan-out replica. */
  sourceClientLocalId?: string;
  /**
   * Relay device id of the computer that uploaded this worktree. Absent when
   * the uploader has never started its relay; the server keeps a stored id.
   */
  sourceRelayDeviceId?: string;
  branchName: string;
  status?: TelemetryWorktreeStatus;
  /** Latest summary pointer (plaintext search abstract). */
  summary?: string;
  clientCreatedAt?: string;
  /** Last renderer interaction observed for this worktree. */
  userActiveAt?: string;
  turns?: TelemetryTurnPayload[];
  plans?: TelemetryPlanPayload[];
  pullRequests?: TelemetryPullRequestPayload[];
  pipelineRuns?: TelemetryPipelineRunPayload[];
  /** Append-on-change summary history snapshots (idempotent by snapshot id). */
  summaries?: TelemetryWorktreeSummarySnapshot[];
}

export interface TelemetryAttention {
  clientChatId: string;
  clientWorktreeId: string;
  state: TelemetryAttentionState;
  reason: TelemetryAttentionReason;
  since: string;
  /** Client-scrubbed, word-boundary-truncated notification context. */
  detail?: string;
}

/** One workspace with its nested worktrees. */
export interface TelemetryWorkspacePayload {
  /** Source turn was recorded while project memory was private. */
  memoryExcluded?: boolean;
  clientLocalId: string;
  name: string;
  workspaceType: TelemetryWorkspaceType;
  worktrees?: TelemetryWorktreePayload[];
  /**
   * Organization project this local workspace materializes (CAN-2948): the
   * tracked workspace external id. Present only
   * for organization-owned checkouts; the server refuses every organization
   * or team target until the milestone-3 feed-read guards required by D25 land.
   * Only private uploads are currently allowed for tracked sources.
   */
  sourceProjectId?: string;
  /** Optional consistency check against the server-resolved project owner. */
  sourceOrganizationId?: string;
}

/** Top-level ingest request — one combined nested batch. */
export interface TelemetryIngestRequest {
  shareScope?: TelemetryShareScope;
  teamId?: string;
  organizationId?: string;
  /**
   * Marks this as the explicit full-session run-share ingest (CAN-396) rather
   * than ambient sync. When true the server accepts the higher
   * {@link MAX_TELEMETRY_SHARE_BODY_BYTES} per-turn/plan body cap. Ambient sync
   * omits it and stays at {@link MAX_TELEMETRY_BODY_BYTES}. It does NOT change
   * scope/consent: the share path still writes USER-owned rows.
   */
  fullSession?: boolean;
  attention?: TelemetryAttention[];
  workspace: TelemetryWorkspacePayload;
}

// ===========================================================================
// Response shapes — map every client id to its server `externalId`.
// ===========================================================================

export interface TelemetryPullRequestRef {
  repoId: string;
  prNumber: number;
  externalId: string;
}

export interface TelemetryTurnRef {
  clientTurnId: string;
  externalId: string;
}

export interface TelemetryPlanRef {
  clientPlanId: string;
  externalId: string;
}

export interface TelemetryPipelineRunRef {
  clientPipelineRunId: string;
  externalId: string;
}

export interface TelemetryWorktreeSummaryRef {
  clientSnapshotId: string;
  externalId: string;
}

export interface TelemetryWorktreeRef {
  clientLocalId: string;
  externalId: string;
  turns: TelemetryTurnRef[];
  plans: TelemetryPlanRef[];
  pullRequests: TelemetryPullRequestRef[];
  pipelineRuns: TelemetryPipelineRunRef[];
  summaries?: TelemetryWorktreeSummaryRef[];
}

export interface TelemetryWorkspaceRef {
  clientLocalId: string;
  externalId: string;
  worktrees: TelemetryWorktreeRef[];
}

export interface TelemetryIngestResponse {
  workspace: TelemetryWorkspaceRef;
}

/**
 * Machine-readable `error.code` on the 403 an ingest gets when the organization
 * governing the uploaded work PROHIBITS a scope carried by the payload.
 * Distinct from a generic auth failure: the client must drop the batch and
 * re-probe its enforced settings rather than retrying it forever.
 */
export const TELEMETRY_SCOPE_PROHIBITED_CODE = 'telemetry_scope_prohibited';

/**
 * Machine-readable code returned when Prisma proves an ingest payload can
 * never be persisted unchanged. Clients must poison and drop that batch.
 */
export const TELEMETRY_PERMANENT_WRITE_ERROR_CODE =
  'telemetry_permanent_write_error';

/** 422 body accompanying {@link TELEMETRY_PERMANENT_WRITE_ERROR_CODE}. */
export interface TelemetryPermanentWriteErrorBody {
  code: typeof TELEMETRY_PERMANENT_WRITE_ERROR_CODE;
}

/** 409 body accompanying {@link TELEMETRY_OWNER_SCOPE_CONFLICT_CODE}. */
export interface TelemetryOwnerScopeConflictErrorBody {
  error: string;
  code: typeof TELEMETRY_OWNER_SCOPE_CONFLICT_CODE;
}

/**
 * The scope vocabulary a prohibition can be stated over — the key set of the
 * enforced-policy map itself, so the rejection can never name a scope no policy
 * could have prohibited.
 *
 * Kept as an alias of {@link TelemetryEnforcedScopeMap}'s keys rather than a
 * second hand-written union: a new scope is added to the policy map once and
 * every client `switch` over this type stops compiling until it handles the new
 * value.
 */
export type TelemetryProhibitedScopeKey = keyof TelemetryEnforcedScopeMap;

/** 403 body accompanying {@link TELEMETRY_SCOPE_PROHIBITED_CODE}. */
export interface TelemetryScopeProhibitedErrorBody {
  error: string;
  code: typeof TELEMETRY_SCOPE_PROHIBITED_CODE;
  /** The offending scope key (`transcripts` | `plans` | `metadata` | `summaries`). */
  scope: TelemetryProhibitedScopeKey;
}

// ===========================================================================
// Read-side contracts — team usage & cost dashboard (CAN-377).
//
// These are the serializable request params + response shapes the hosted web
// Statistics dashboard consumes. They are derived entirely from the plaintext
// tier-(c) rollup metadata (no body/summary decryption). Like the ingest
// contracts above, this section must stay dependency-free.
// ===========================================================================

/** Scope a usage query is rolled up over. */
export const TELEMETRY_USAGE_SCOPES = ['organization', 'team'] as const;
export type TelemetryUsageScope = (typeof TELEMETRY_USAGE_SCOPES)[number];

/** Time-bucket granularity for usage time-series. */
export const TELEMETRY_TIME_GRANULARITIES = ['hour', 'day', 'week'] as const;
export type TelemetryTimeGranularity =
  (typeof TELEMETRY_TIME_GRANULARITIES)[number];

/** Pivot dimension for the breakdown table (client-side pivot selector). */
export const TELEMETRY_USAGE_GROUP_BY = [
  'user',
  'model',
  'provider',
  'pipeline',
  'worktree',
] as const;
export type TelemetryUsageGroupBy = (typeof TELEMETRY_USAGE_GROUP_BY)[number];

/** Headline-card value formatting hint. */
export const TELEMETRY_CARD_UNITS = ['currency', 'count', 'tokens'] as const;
export type TelemetryCardUnit = (typeof TELEMETRY_CARD_UNITS)[number];

/** Parsed query params for `GET /api/account/organizations/[orgId]/usage`. */
export interface TeamUsageRequestParams {
  scope: TelemetryUsageScope;
  /** Required when `scope === 'team'`; the sub-team externalId. */
  teamId?: string;
  granularity: TelemetryTimeGranularity;
  /** Inclusive ISO start of the reporting window. */
  startIso: string;
  /** Exclusive ISO end of the reporting window. */
  endIso: string;
  /** Optional attribution-user filter (member externalId). */
  userId?: string;
  /** Optional default breakdown-table pivot dimension. */
  groupBy?: TelemetryUsageGroupBy;
}

/** One token time-series bucket keyed by provider or model. */
export interface TelemetryTokenBucket {
  bucketStartIso: string;
  /** Provider or model name. */
  key: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** One cost time-series bucket keyed by provider or model. */
export interface TelemetryCostBucket {
  bucketStartIso: string;
  /** Provider or model name. */
  key: string;
  totalCostUsd: number;
}

/**
 * One priceable subscription plan type observed across an org's team, for the
 * org-settings pricing table. Grouped by normalized plan key; individual
 * account emails are never included.
 */
export interface SubscriptionPlanPricingRow {
  /** Normalized plan key, e.g. `claude:max-5x`. */
  planKey: string;
  provider: TelemetryProvider;
  /** Human-readable plan label, e.g. `Claude Max 5x`. */
  label: string;
  /** Distinct raw provider plan-type strings folded into this key. */
  rawPlanTypes: string[];
  /** Distinct subscription accounts observed on this plan. */
  accountCount: number;
  /** Catalog default monthly price; null when the catalog has no default. */
  defaultMonthlyUsd: number | null;
  /** Per-org override, or null when unset. */
  overrideMonthlyUsd: number | null;
  /** Override ?? default; null when neither is set. */
  effectiveMonthlyUsd: number | null;
}

/** Subscription plan pricing table payload for org settings. */
export interface SubscriptionPricingResponse {
  plans: SubscriptionPlanPricingRow[];
  /** Whether the requesting user may edit price overrides. */
  canEdit: boolean;
}

/**
 * One billed-cost rollup row grouped by provider + normalized plan key. No
 * per-account rows are exposed; `accountCount` is the distinct-account tally.
 */
export interface SubscriptionPlanUsageRow {
  provider: TelemetryProvider;
  planKey: string;
  label: string;
  accountCount: number;
  effectiveMonthlyUsd: number | null;
  /** Total distinct account-months of activity across the range. */
  monthsActive: number;
  /** Estimated billed cost for this plan across the range. */
  billedUsd: number;
}

/**
 * One Impact time-series bucket keyed by person (display name, or `Others` for
 * the folded remainder beyond the charted top contributors). Each person's
 * values across all buckets sum to their leaderboard `impactScore`, so a
 * stacked chart of these buckets reads as the team's total impact over time.
 */
export interface TelemetryImpactBucket {
  bucketStartIso: string;
  /** Person display name, or `Others` for the folded remainder. */
  key: string;
  impactScore: number;
}

/** A headline metric card with an optional prior-window value for trend. */
export interface TelemetryHeadlineCard {
  /** Stable key, e.g. `totalCostUsd` / `totalTokens` / `turns`. */
  key: string;
  label: string;
  value: number;
  /** Prior comparison-window value; null when no comparison applies. */
  previousValue: number | null;
  unit: TelemetryCardUnit;
}

/** Tool usage rolled up by category. */
export interface TelemetryToolCategoryTotal {
  toolCategory: string;
  total: number;
}

/** Turn counts grouped by event type + terminal status. */
export interface TelemetryEventStatusCount {
  eventType: string;
  status: string;
  count: number;
}

/**
 * Per-person leaderboard row for the People tab. Every field is a plain
 * serializable number/string/null derived from owner-scoped plaintext rollup
 * columns. `impactScore` is the headline KPI (see
 * `apps/web/src/lib/telemetry/impact-score.ts`); the `prImpactRaw` /
 * `deliveryImpactRaw` / `executionBonus` / `agentWorkBonus` breakdown fields
 * back the header tooltip. The remaining fields are PR-, plan-, worktree-,
 * pipeline-, Cowork-delivery-, and turn-derived aggregates the table sorts on.
 */
export interface TelemetryUserLeaderboardRow {
  /** Member externalId; null when the actor is no longer resolvable. */
  userId: string | null;
  userName: string | null;

  // --- Impact KPI + breakdown ---
  /**
   * Composite headline KPI:
   * `round1(prImpactRaw + deliveryImpactRaw + executionBonus + agentWorkBonus)`.
   */
  impactScore: number;
  /** Σ per-merged-PR base points + linkage/cross-repo bonuses. */
  prImpactRaw: number;
  /**
   * Non-code delivery track: Σ per-Cowork-Work-Entry points (after the
   * entry-count soft cap) + the capped shared-run bonus.
   */
  deliveryImpactRaw: number;
  /** +1 per implemented plan in range, capped at prsMerged. */
  executionBonus: number;
  /** Soft-capped bonus for terminal primary agent work in range. */
  agentWorkBonus: number;
  /** Terminal primary-work transcript turns in range. */
  agentTurns: number;
  /**
   * Agent turns plus the weighted tool-call modulation used for Impact.
   *
   * Currently serialized for score auditability rather than display: it is the
   * only field that makes `agentWorkBonus` reproducible from the row (the tool
   * weights and soft cap are server-side), so support and score disputes can be
   * settled without re-querying. No UI surface reads it yet.
   */
  agentWorkUnits: number;

  // --- Usage (transcript turns) ---
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  turnCount: number;
  toolUseCount: number;

  // --- Velocity ---
  worktreesCreated: number;
  plansCreated: number;
  plansImplemented: number;
  prsCreated: number;
  prsMerged: number;
  prsOpen: number;
  linesChanged: number;
  changedFiles: number;
  /** Mean (mergedAt - openedAt) over merged PRs with both timestamps; 0 when none. */
  avgCycleTimeMs: number;

  // --- Quality (numerator/denominator pairs; guard division in the UI) ---
  checksPassing: number;
  checksDecided: number;
  /** Mean (additions + deletions) over the user's PRs; 0 when none. */
  avgPrSize: number;

  // --- Linkage ---
  prsWithTicket: number;

  // --- Pipeline execution (completed pipeline_runs in range) ---
  /** Σ executed agent steps over completed runs; Detailed-only, not scored. */
  pipelineAgentSteps: number;
  /** Completed pipeline runs in range. */
  pipelineRuns: number;
  pipelineRunsSucceeded: number;
  pipelineRunsFailed: number;
  pipelineRunsCancelled: number;
  /** Distinct pipeline_id values across the user's completed runs. */
  pipelineDistinctPipelines: number;
  /** Σ retry_count over completed runs. */
  pipelineRetries: number;
  /** Mean run_duration_ms over completed runs; 0 when none. */
  pipelineAvgRunMs: number;

  // --- Non-code delivery (Cowork Work Entries with in-range activity) ---
  /** Work Entries that scored above the floor (substantive or engaged). */
  deliveryEntries: number;
  /** Σ WRITE_EDIT + FILE_ADD + FILE_EDIT tool counts over scoring entries. */
  deliveryArtifacts: number;
  /** Σ MCP tool counts over scoring entries. */
  deliveryExternalActions: number;
  /** Scoring entries whose label carries a Linear-style ticket id. */
  deliveryEntriesWithTicket: number;
  /** Scoring entries the user marked Done. */
  deliveryEntriesDone: number;
  /** Cowork shared runs in range (the bonus is capped at `deliveryEntries`). */
  deliverySharedRuns: number;
}

/** Per-pipeline usage rollup derived from `pipeline_agent_turn` turns. */
export interface TelemetryPipelineUsage {
  clientPipelineId: string;
  /** Friendly pipeline name resolved from pipeline_runs; null if unresolved. */
  pipelineName: string | null;
  /** Distinct pipeline execution count. */
  runCount: number;
  turnCount: number;
  agentTimeMs: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Pipeline type classification derived purely from the client pipeline id. */
export type PipelineUsageType = 'bundled' | 'shared' | 'project' | 'private';

/**
 * Classify a pipeline's type from its client pipeline id using stable id
 * conventions owned by the desktop client:
 * - `shared:<serverId>:<remoteId>` → shared
 * - `bundled-*` → bundled
 * - `*.yaml` / file path → project
 * - anything else (bare UUID, plain custom name) → private
 */
export function classifyPipelineType(id: string): PipelineUsageType {
  if (id.startsWith('shared:')) return 'shared';
  if (id.startsWith('bundled-')) return 'bundled';
  if (/\.ya?ml$/i.test(id) || id.includes('/') || id.includes('\\')) {
    return 'project';
  }
  return 'private';
}

/** A single most-expensive session for the click-through panel. */
export interface TelemetryExpensiveRun {
  /** Stable per-session id: `${worktreeExternalId}:${sessionKey}`. */
  sessionId: string;
  /** Number of turns summed into this session. */
  turnCount: number;
  /** From the session's latest turn. */
  label: string;
  /** From the session's latest turn. */
  provider: string;
  /** From the session's latest turn. */
  model: string | null;
  /** Summed across all of the session's turns. */
  totalCostUsd: number;
  /** Most-recent turn start (`MAX(started_at)`) across the session. */
  startedAtIso: string;
  worktreeId: string;
  branchName: string;
  /** Most-recent PR url for the worktree, when one exists. */
  prUrl: string | null;
  /** `users.name` for the attribution actor; null → render "Unknown". */
  authorName: string | null;
  /** Raw turn status enum value from the latest turn, e.g. "SUCCESS" / "FAILURE". */
  status: string;
  /** Raw turn event-type enum value from the latest turn, e.g. "WORKTREE_CHAT". */
  eventType: string;
  /** Summed per-turn agent durations across the session in ms; null when unrecorded. */
  durationMs: number | null;
  /** Summed across all of the session's turns. */
  inputTokens: number;
  /** Summed across all of the session's turns. */
  outputTokens: number;
}

/** Full team usage dashboard payload for a scope/range/filter. */
export interface TeamUsageResponse {
  scope: TelemetryUsageScope;
  /** Sub-team externalId when scoped to a team; null for org-wide. */
  teamId: string | null;
  range: {
    startIso: string;
    endIso: string;
    granularity: TelemetryTimeGranularity;
  };
  /** Active attribution-user filter (member externalId), or null. */
  filterUserId: string | null;
  headline: TelemetryHeadlineCard[];
  tokensByProvider: TelemetryTokenBucket[];
  tokensByModel: TelemetryTokenBucket[];
  costByProvider: TelemetryCostBucket[];
  costByModel: TelemetryCostBucket[];
  toolCategoryTotals: TelemetryToolCategoryTotal[];
  eventTypeStatusCounts: TelemetryEventStatusCount[];
  byUser: TelemetryUserLeaderboardRow[];
  /** Team Impact over time: per-person impact bucketed by `range.granularity`. */
  impactByUser: TelemetryImpactBucket[];
  pipelines: TelemetryPipelineUsage[];
  mostExpensiveRuns: TelemetryExpensiveRun[];
  /** Flag-gated Auto comparison over the same scope, range, and user filter. */
  autoRoutingSavings?: {
    autoTurnCount: number;
    comparableTurnCount: number;
    benchmarkEstimatedExecutionCostUsd: number | null;
    selectedExecutionCostUsd: number | null;
    routingCostUsd: number | null;
    actualWithAutoCostUsd: number | null;
    /**
     * Period-total net savings, clamped at 0: a period where Auto cost more
     * reads as saving nothing. It can therefore exceed
     * `benchmarkEstimatedExecutionCostUsd - actualWithAutoCostUsd`.
     */
    netEstimatedSavingsUsd: number | null;
    /** Prior-window {@link netEstimatedSavingsUsd}, clamped the same way. */
    previousNetEstimatedSavingsUsd: number | null;
  };
  /**
   * Estimated subscription billing derived from the plan types the team
   * actually used. Omitted entirely when zero subscription accounts were
   * attributed in the range (honest empty state — observed cost still shows).
   */
  billedCost?: {
    byBucket: TelemetryCostBucket[];
    totalUsd: number;
    /** Prior comparison-window billed total; null when no comparison applies. */
    previousTotalUsd: number | null;
    /** Observed minus billed for the range; may be negative. */
    savingsUsd: number;
    /** Per-plan rollup rows grouped by provider + plan key. */
    plans: SubscriptionPlanUsageRow[];
    /** Count of active accounts whose plan has no price (catalog + override). */
    unpricedAccountCount: number;
  };
}
