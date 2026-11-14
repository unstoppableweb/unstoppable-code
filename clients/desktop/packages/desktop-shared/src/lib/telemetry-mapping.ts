// ---------------------------------------------------------------------------
// Pure desktop → telemetry-wire mappers (CAN-402).
//
// These helpers translate desktop domain shapes (`AgentAuditEntry`,
// `TrackedPlanData`, `WorktreePrStatus`, `WorktreeSummaryData`) into the
// `@canopy/protocol` telemetry ingest payloads. They are pure (no I/O, no
// crypto, no Electron) so they stay testable and pass
// `npm run check:electron-boundary`. The main-process telemetry-sync service
// owns the side-effecting parts: reading transcripts, computing `contentHash`
// (SHA-256), resolving cloud credentials, queueing, and uploading.
//
// Every free-text field is run through {@link redactSecrets} here so a secret
// can never reach a payload regardless of which trigger built it.
// ---------------------------------------------------------------------------

import {
  ATTENTION_DETAIL_MAX_CHARS,
  clampTelemetryClientId,
  MAX_TELEMETRY_BODY_BYTES,
  MAX_TELEMETRY_CLIENT_ID_LENGTH,
  MAX_TELEMETRY_LABEL_LENGTH,
  MAX_TELEMETRY_NAME_LENGTH,
  MAX_TELEMETRY_PIPELINE_RUNS_PER_WORKTREE,
  MAX_TELEMETRY_PLANS_PER_WORKTREE,
  MAX_TELEMETRY_PR_URL_LENGTH,
  MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE,
  MAX_TELEMETRY_REVIEW_STATUS_LENGTH,
  MAX_TELEMETRY_SUMMARIES_PER_WORKTREE,
  MAX_TELEMETRY_SUMMARY_BYTES,
  MAX_TELEMETRY_TURN_DURATION_MS,
  MAX_TELEMETRY_TURNS_PER_WORKTREE,
  PIPELINE_RUN_STATUSES,
  TELEMETRY_TOOL_CATEGORIES,
  type PipelineRunStatusValue,
  type TelemetryAttention,
  type TelemetryEventType,
  type TelemetryIngestRequest,
  type TelemetryPipelineRunPayload,
  type TelemetryPlanPayload,
  type TelemetryPullRequestPayload,
  type TelemetryObservedCost,
  type TelemetryShareScope,
  type TelemetryTokenTotals,
  type TelemetryToolCategory,
  type TelemetryToolCountMap,
  type TelemetryTurnPayload,
  type TelemetryWorktreePayload,
  type TelemetryWorktreeSummarySnapshot,
} from '@canopy/protocol';
import type { TelemetrySharingVisibility, TrackedPlanData } from '../types';
import type { WorktreeSummaryData } from '../types';
import type { WorktreePrStatus } from '../types/github';
import type {
  AgentAuditEntry,
  AgentAuditEventType,
  PipelineRunUsageEvent,
} from '@canopy/execution-engine/types/observability';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';

/**
 * Exhaustive value-level mapping from every desktop `AgentAuditEventType` to
 * its telemetry wire counterpart, or `null` when the audit event type is
 * deliberately audit-only and must not be uploaded to cloud telemetry (e.g.
 * it has no paired protocol + web Prisma enum value yet).
 *
 * This `Record<AgentAuditEventType, ...>` is typed against the full union, so
 * adding a new `AgentAuditEventType` forces a compile-time decision here —
 * either map it to the matching `TelemetryEventType` or explicitly mark it
 * `null` with a comment. This is what `tsc:check` actually enforces (the
 * type-level assertions in `telemetry-protocol-fidelity.test.ts` are not
 * checked by Jest's SWC transform).
 */
export const AUDIT_EVENT_TELEMETRY_MAPPING: Record<
  AgentAuditEventType,
  TelemetryEventType | null
> = {
  worktree_chat: 'worktree_chat',
  standalone_chat: 'standalone_chat',
  app_advisor: 'app_advisor',
  pipeline_editor: 'pipeline_editor',
  pipeline_agent_turn: 'pipeline_agent_turn',
  pipeline_advisor: 'pipeline_advisor',
  pr_generation: 'pr_generation',
  // Audit-only: no paired protocol + web Prisma enum value yet.
  pr_split_planning: null,
  commit_message_generation: 'commit_message_generation',
  branch_naming: 'branch_naming',
  cron_generation: 'cron_generation',
  automation_if_command_generation: 'automation_if_command_generation',
  worktree_summary: 'worktree_summary',
  chat_summary: 'chat_summary',
  // Audit-only: no paired protocol + web Prisma enum value yet.
  chat_handoff_summary: null,
  archive_summary: 'archive_summary',
  worktree_plan_chat: 'worktree_plan_chat',
  worktree_plan_diagram: 'worktree_plan_diagram',
  // Audit-only: no paired protocol + web Prisma enum value yet.
  code_review_annotations: null,
  // Audit-only: no paired protocol + web Prisma enum value yet.
  code_review_diagram: null,
  // Audit-only: no paired protocol + web Prisma enum value yet.
  local_memory_consolidation: null,
  // Audit-only: no paired protocol + web Prisma enum value yet.
  local_memory_chat_profile: null,
  // Audit-only: a local scan over the user's own requests.
  skill_suggestion_scan: null,
  // Audit-only: a delegation run is local cost attribution, not a chat turn.
  managed_delegation: null,
};

export interface TruncateToBytesOptions {
  /**
   * When true, after byte-truncating, cut back to the last newline so the
   * result never ends mid-line. For JSONL bodies this guarantees a clipped
   * body never emits a corrupt trailing (partial) line that would fail
   * `JSON.parse` on read. When the truncated slice contains no newline the
   * single (partial) line is kept as-is \u2014 dropping it would lose everything.
   */
  lineAware?: boolean;
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting a
 * multi-byte sequence. Browser-safe (TextEncoder/TextDecoder, no Buffer).
 */
export function truncateToBytes(
  text: string,
  maxBytes: number,
  options: TruncateToBytesOptions = {},
): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= maxBytes) {
    return text;
  }
  const decoder = new TextDecoder('utf-8', { fatal: false });
  // A byte-slice can split a multi-byte sequence at the boundary; the lossy
  // decode turns that partial tail into a U+FFFD replacement char. Strip any
  // trailing replacement chars so the result never exceeds `maxBytes`.
  const truncated = decoder
    .decode(encoded.subarray(0, maxBytes))
    .replace(/\uFFFD+$/, '');
  if (options.lineAware === true) {
    const lastNewline = truncated.lastIndexOf('\n');
    if (lastNewline >= 0) {
      return truncated.slice(0, lastNewline);
    }
  }
  return truncated;
}

/** Byte length of a UTF-8 string. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Tiny non-cryptographic FNV-1a 32-bit hash rendered as 8 lowercase hex chars.
 * Browser-safe (no `node:crypto`) so this module stays pure for
 * `check:electron-boundary`. The server's `clampId` uses the identical
 * algorithm so a long id clamps to the same key on both sides.
 */
/**
 * Clamp a free-text/display string to at most `maxLen` characters by plain
 * truncation. For values where collisions don't matter (labels, names, titles,
 * urls, review status, content hash).
 */
export function clampText(value: string, maxLen: number): string {
  return value.length <= maxLen ? value : value.slice(0, maxLen);
}

/**
 * Collision-safe clamp for correlation-key ids. Delegates to the protocol's
 * {@link clampTelemetryClientId} so the desktop and the server derive the same
 * ids (the server recomputes a checkout's namespaced ids, CAN-3517).
 */
export function clampId(value: string, maxLen: number): string {
  return clampTelemetryClientId(value, maxLen);
}

/**
 * Redact and hard-cap a free-text body for the encrypted `body` tier.
 *
 * Bodies are transcript JSONL (one JSON event per line), so truncation is
 * line-aware: a clipped body ends on a complete line and never emits a corrupt
 * trailing partial line. `maxBytes` defaults to the ambient
 * {@link MAX_TELEMETRY_BODY_BYTES} (1 MiB); the explicit full-session share
 * path passes a higher cap.
 */
export function prepareTelemetryBody(
  text: string,
  maxBytes: number = MAX_TELEMETRY_BODY_BYTES,
): string {
  return truncateToBytes(redactSecrets(text), maxBytes, { lineAware: true });
}

/**
 * Map a per-data-type sharing visibility to the wire `shareScope`. `'off'`
 * returns null (that data type does not upload); every other value is already a
 * valid {@link TelemetryShareScope}.
 */
export function mapVisibilityToShareScope(
  visibility: TelemetrySharingVisibility,
): TelemetryShareScope | null {
  if (visibility === 'off') {
    return null;
  }
  return visibility;
}

/** Build a sparse tool-count map, dropping every zero category. */
export function toSparseToolCounts(
  counts: AgentAuditEntry['toolCounts'],
): TelemetryToolCountMap | undefined {
  const sparse: TelemetryToolCountMap = {};
  let any = false;
  for (const category of TELEMETRY_TOOL_CATEGORIES) {
    const key: TelemetryToolCategory = category;
    const value = counts[key];
    if (typeof value === 'number' && value > 0) {
      sparse[key] = value;
      any = true;
    }
  }
  return any ? sparse : undefined;
}

function mapTokenTotals(
  tokens: AgentAuditEntry['tokens'],
): TelemetryTokenTotals {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheReadInput: tokens.cacheReadInputTokens,
    cacheCreationInput: tokens.cacheCreationInputTokens,
  };
}

function mapObservedCost(
  observedCost: AgentAuditEntry['observedCost'],
): TelemetryObservedCost | undefined {
  if (!observedCost) {
    return undefined;
  }
  return {
    status: observedCost.status,
    reason: observedCost.reason,
    ...(typeof observedCost.tokenUsd === 'number'
      ? { tokenUsd: observedCost.tokenUsd }
      : {}),
    ...(typeof observedCost.nonTokenUsd === 'number'
      ? { nonTokenUsd: observedCost.nonTokenUsd }
      : {}),
    ...(observedCost.pricingBasis
      ? { pricingBasis: observedCost.pricingBasis }
      : {}),
    ...(observedCost.contextTier
      ? { contextTier: observedCost.contextTier }
      : {}),
    ...(observedCost.canonicalServiceTier
      ? { canonicalServiceTier: observedCost.canonicalServiceTier }
      : {}),
  };
}

export interface TurnMappingOptions {
  /** Reconstructed transcript text (already loaded by the service). */
  transcriptBody?: string;
  /**
   * Override the per-turn encrypted `body` byte cap. Defaults to the ambient
   * {@link MAX_TELEMETRY_BODY_BYTES}; the explicit full-session run-share path
   * passes {@link MAX_TELEMETRY_SHARE_BODY_BYTES} so a big shared turn retains
   * more than ambient.
   */
  maxBodyBytes?: number;
}

/**
 * Narrow a desktop `AgentAuditEventType` to the telemetry wire union via
 * {@link AUDIT_EVENT_TELEMETRY_MAPPING}. Desktop can grow audit event types
 * ahead of the telemetry ingest contract (which requires a paired protocol +
 * web Prisma enum change); event types mapped to `null` there return `null`
 * here and stay local-only.
 */
export function toTelemetryEventType(
  eventType: AgentAuditEntry['eventType'],
): TelemetryEventType | null {
  return AUDIT_EVENT_TELEMETRY_MAPPING[eventType];
}

/**
 * True when a locally recorded turn duration is worth putting on the wire.
 *
 * `transcript_turns.duration_ms` is an INTEGER column, so a value above
 * {@link MAX_TELEMETRY_TURN_DURATION_MS} (7 days) is both semantically
 * meaningless and physically unpersistable — one such turn made every ingest
 * batch carrying it fail permanently, and the desktop outbox replayed it
 * forever (CAN-3106). Non-finite, fractional, and negative values are rejected
 * on the same basis: they can only come from a corrupt clock or a stale
 * `startedAt`, never from a real turn.
 */
export function isPlausibleTurnDurationMs(
  durationMs: number | undefined,
): durationMs is number {
  return (
    durationMs !== undefined &&
    Number.isInteger(durationMs) &&
    durationMs >= 0 &&
    durationMs <= MAX_TELEMETRY_TURN_DURATION_MS
  );
}

/**
 * Map a terminal `AgentAuditEntry` to a `TelemetryTurnPayload`. Drops local
 * bookkeeping fields (`error`, `sdkSessionId`, `pipelineName`, `repoLabel`,
 * `linkTarget`, `jobId`, `stepId`, `attempt`) and renames client correlation
 * refs. `contentHash` is intentionally left for the service to set. Returns
 * `null` for audit event types that are not part of the telemetry wire
 * contract yet (see {@link toTelemetryEventType}); those turns are not
 * uploaded.
 */
export function mapAuditEntryToTurnPayload(
  entry: AgentAuditEntry,
  options: TurnMappingOptions = {},
): TelemetryTurnPayload | null {
  // Cursor local experiments are not in the hosted telemetry provider contract.
  if (
    entry.provider === 'cursor' ||
    entry.provider === 'copilot' ||
    entry.provider === 'antigravity' ||
    entry.provider === 'opencode'
  )
    return null;
  const eventType = toTelemetryEventType(entry.eventType);
  if (eventType === null) {
    return null;
  }
  const payload: TelemetryTurnPayload = {
    clientTurnId: clampId(entry.id, MAX_TELEMETRY_CLIENT_ID_LENGTH),
    eventType,
    status: entry.status,
    provider: entry.provider,
    // `label` is a fixed, event-type-derived display string (see
    // observability `labelForEventType` and the constant helper labels), never
    // user free-text, so it is sent verbatim. If a user-controlled value is
    // ever routed into `label`, run it through `redactSecrets` here.
    label: clampText(entry.label, MAX_TELEMETRY_LABEL_LENGTH),
    startedAt: entry.startedAt,
    tokens: mapTokenTotals(entry.tokens),
    messageCount: entry.messageCount,
    assistantMessageCount: entry.assistantMessageCount,
    toolUseCount: entry.toolUseCount,
    subAgentCount: entry.subAgentCount,
  };

  if (entry.chatMode !== undefined) {
    payload.chatMode = entry.chatMode;
  }
  if (entry.model !== undefined) {
    payload.model = clampText(entry.model, MAX_TELEMETRY_NAME_LENGTH);
  }
  if (entry.completedAt !== undefined) {
    payload.completedAt = entry.completedAt;
  }
  // Only a plausible, storable duration reaches the wire (CAN-3106). A
  // non-finite, negative, fractional, or multi-day value is never a real turn —
  // it is a stale `startedAt` or an entry that was never finalized — and
  // `transcript_turns.duration_ms` is an INTEGER column, so an over-ceiling
  // value made the whole batch permanently unpersistable and the outbox
  // replayed it forever. Omitting the field keeps every sibling field of a
  // genuinely useful turn instead of dropping the batch.
  if (isPlausibleTurnDurationMs(entry.durationMs)) {
    payload.durationMs = entry.durationMs;
  }
  if (entry.totalCostUsd !== undefined) {
    payload.totalCostUsd = entry.totalCostUsd;
  }
  const observedCost = mapObservedCost(entry.observedCost);
  if (observedCost !== undefined) {
    payload.observedCost = observedCost;
  }
  if (entry.modelRouting !== undefined) {
    payload.modelRouting = entry.modelRouting;
  }
  const toolCounts = toSparseToolCounts(entry.toolCounts);
  if (toolCounts) {
    payload.toolCounts = toolCounts;
  }
  if (entry.chatId !== undefined) {
    payload.clientChatId = clampId(
      entry.chatId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
  }
  if (entry.userMessageId !== undefined) {
    payload.clientUserMessageId = clampId(
      entry.userMessageId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
  }
  if (entry.repoId !== undefined) {
    payload.clientRepoId = clampId(
      entry.repoId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
  }
  if (entry.pipelineId !== undefined) {
    payload.clientPipelineId = clampId(
      entry.pipelineId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
  }
  if (entry.pipelineExecutionId !== undefined) {
    payload.clientPipelineExecutionId = clampId(
      entry.pipelineExecutionId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
  }

  // Subscription attribution. Routed turns are billed to UD AI Credits, not a
  // native subscription, so we emit only the `aiCreditsRouted` flag and never
  // the account fields. Non-routed turns carry the attributed account when
  // desktop was able to snapshot it.
  if (entry.aiCreditsRouted === true) {
    payload.aiCreditsRouted = true;
  } else {
    if (entry.providerAccountKey !== undefined) {
      payload.providerAccountKey = clampId(
        entry.providerAccountKey,
        MAX_TELEMETRY_CLIENT_ID_LENGTH,
      );
    }
    if (entry.providerAccountEmail !== undefined) {
      payload.providerAccountEmail = clampText(
        entry.providerAccountEmail,
        MAX_TELEMETRY_NAME_LENGTH,
      );
    }
    if (entry.providerPlanType !== undefined) {
      payload.providerPlanType = clampText(
        entry.providerPlanType,
        MAX_TELEMETRY_NAME_LENGTH,
      );
    }
  }

  const body = options.transcriptBody;
  if (body !== undefined && body.length > 0) {
    payload.body = prepareTelemetryBody(body, options.maxBodyBytes);
  }

  return payload;
}

export interface PlanMappingOptions {
  /**
   * Stamp the run's shared chat id onto the plan payload so a shared run's
   * plans are scopable by `(worktreeId, clientChatId)` and bounded by
   * `createdAt` (CAN-396). Plans are worktree-keyed and land with
   * `clientChatId = null` by default; the ambient path omits this.
   */
  clientChatId?: string;
  /**
   * Override the plan `body` byte cap. Defaults to the ambient
   * {@link MAX_TELEMETRY_BODY_BYTES}; the full-session share path may pass a
   * higher cap.
   */
  maxBodyBytes?: number;
}

/**
 * Map a `TrackedPlanData` to a `TelemetryPlanPayload`. The plan content becomes
 * the redacted/capped encrypted `body`; `contentHash` is left for the service.
 */
export function mapTrackedPlanToPlanPayload(
  plan: TrackedPlanData,
  options: PlanMappingOptions = {},
): TelemetryPlanPayload {
  const body = prepareTelemetryBody(plan.content, options.maxBodyBytes);
  const payload: TelemetryPlanPayload = {
    clientPlanId: clampId(plan.id, MAX_TELEMETRY_CLIENT_ID_LENGTH),
    title: clampText(redactSecrets(plan.title), MAX_TELEMETRY_NAME_LENGTH),
    reviewStatus: clampText(
      plan.reviewStatus,
      MAX_TELEMETRY_REVIEW_STATUS_LENGTH,
    ),
    planVersion: plan.latestRevisionNumber,
    planTextBytes: utf8ByteLength(body),
    planLineCount: body.length === 0 ? 0 : body.split('\n').length,
  };
  if (options.clientChatId !== undefined) {
    payload.clientChatId = clampId(
      options.clientChatId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
  }
  if (body.length > 0) {
    payload.body = body;
  }
  // Implementation is considered started once the plan is approved (every
  // implement path — chat, plan-explore, activity panel, and pipeline — stamps
  // approvedAt) or, for legacy plans, once an execution is linked. (CAN-373 F4.)
  const implementationStartedAt =
    plan.approvedAt ??
    (plan.linkedExecutionIds.length > 0 ? plan.updatedAt : undefined);
  if (implementationStartedAt !== undefined) {
    payload.implementationStartedAt = implementationStartedAt;
  }
  return payload;
}

/**
 * Map a `WorktreePrStatus` to per-repo pull-request payloads. Repos with a null
 * status are skipped. PR metadata is non-sensitive rollup data; only the
 * free-text `title` is defensively redacted.
 */
export function mapWorktreePrStatusToPayloads(
  status: WorktreePrStatus,
): TelemetryPullRequestPayload[] {
  const payloads: TelemetryPullRequestPayload[] = [];
  for (const repo of status.repos) {
    const pr = repo.status;
    if (!pr) {
      continue;
    }
    const payload: TelemetryPullRequestPayload = {
      repoId: clampId(repo.repoId, MAX_TELEMETRY_CLIENT_ID_LENGTH),
      repoName: clampText(repo.repoName, MAX_TELEMETRY_NAME_LENGTH),
      prNumber: pr.prNumber,
      prUrl: clampText(pr.prUrl, MAX_TELEMETRY_PR_URL_LENGTH),
      title: clampText(redactSecrets(pr.title), MAX_TELEMETRY_LABEL_LENGTH),
      state: pr.state,
      checkStatus: pr.checkStatus,
      reviewStatus: pr.reviewStatus,
      hasConflicts: pr.hasConflicts,
      commentCount: pr.commentCount,
      prUpdatedAt: pr.updatedAt,
      lastCheckedAt: status.lastCheckedAt,
    };
    // PR open/merge timestamps and diff stats are numeric/timestamp rollup
    // data (non-sensitive), passed through verbatim without redaction.
    if (pr.openedAt !== undefined) {
      payload.openedAt = pr.openedAt;
    }
    if (pr.mergedAt !== undefined) {
      payload.mergedAt = pr.mergedAt;
    }
    if (pr.additions !== undefined) {
      payload.additions = pr.additions;
    }
    if (pr.deletions !== undefined) {
      payload.deletions = pr.deletions;
    }
    if (pr.changedFiles !== undefined) {
      payload.changedFiles = pr.changedFiles;
    }
    payloads.push(payload);
  }
  return payloads;
}

function isPipelineRunStatus(
  value: string | undefined,
): value is PipelineRunStatusValue {
  return (
    value !== undefined &&
    (PIPELINE_RUN_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Map a completed-pipeline-run usage event to a `TelemetryPipelineRunPayload`.
 * Returns null when the event is missing a conforming terminal/active status so
 * a malformed event drops rather than poisoning the wire vocabulary. All fields
 * are numeric/timestamp rollup data — no redaction. (CAN-373 F2.)
 */
export function mapPipelineRunUsageEventToPayload(
  event: PipelineRunUsageEvent,
): TelemetryPipelineRunPayload | null {
  if (!isPipelineRunStatus(event.status)) {
    return null;
  }
  const payload: TelemetryPipelineRunPayload = {
    clientPipelineRunId: clampId(
      event.pipelineExecutionId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    ),
    pipelineId: clampId(event.pipelineId, MAX_TELEMETRY_CLIENT_ID_LENGTH),
    pipelineName: clampText(event.pipelineName, MAX_TELEMETRY_NAME_LENGTH),
    status: event.status,
    startedAt: event.runStartedAt,
  };
  if (event.runCompletedAt !== undefined) {
    payload.completedAt = event.runCompletedAt;
  }
  if (event.runDurationMs !== undefined) {
    payload.runDurationMs = event.runDurationMs;
  }
  if (event.jobCount !== undefined) {
    payload.jobCount = event.jobCount;
  }
  if (event.stepCount !== undefined) {
    payload.stepCount = event.stepCount;
  }
  if (event.agentStepCount !== undefined) {
    payload.agentStepCount = event.agentStepCount;
  }
  if (event.retryCount !== undefined) {
    payload.retryCount = event.retryCount;
  }
  return payload;
}

/**
 * Flatten a `WorktreeSummaryData` into a single redacted, capped plaintext
 * search abstract for `TelemetryWorktreePayload.summary`.
 */
export function mapWorktreeSummaryToText(summary: WorktreeSummaryData): string {
  const parts: string[] = [summary.title.trim(), summary.description.trim()];
  for (const highlight of summary.highlights) {
    const trimmed = highlight.trim();
    if (trimmed.length > 0) {
      parts.push(`- ${trimmed}`);
    }
  }
  const text = parts.filter((part) => part.length > 0).join('\n');
  return truncateToBytes(redactSecrets(text), MAX_TELEMETRY_SUMMARY_BYTES);
}

// ---------------------------------------------------------------------------
// Byte-aware ingest chunking (CAN-401).
//
// A single assembled ingest request can be tens of MB (25 plans × 1 MiB, a
// multi-MiB share turn body, etc.). The self-hosted Next.js standalone server
// silently truncates a request body past its ~10 MB read limit before the route
// reads it, so an oversize POST fails with a misleading 400. To stay under that
// limit we split any assembled request into pieces each at or under a byte
// budget (`MAX_TELEMETRY_INGEST_BATCH_BYTES`, 8 MiB) AND at or under every
// collection's per-request count cap, then POST the pieces sequentially. The
// server upserts every collection idempotently by stable client ids and appends
// across requests (each piece re-sends the workspace/worktree envelope), so
// splitting is behavior-preserving — exactly how the existing 100-turn
// pagination already works, generalized to all collections.
// ---------------------------------------------------------------------------

/** Mutable per-piece accumulator of a worktree's five nested collections. */
interface IngestPieceCollections {
  turns: TelemetryTurnPayload[];
  plans: TelemetryPlanPayload[];
  pullRequests: TelemetryPullRequestPayload[];
  pipelineRuns: TelemetryPipelineRunPayload[];
  summaries: TelemetryWorktreeSummarySnapshot[];
}

function emptyIngestPieceCollections(): IngestPieceCollections {
  return {
    turns: [],
    plans: [],
    pullRequests: [],
    pipelineRuns: [],
    summaries: [],
  };
}

/**
 * Reconstruct one ingest request piece from the shared workspace/worktree
 * envelope plus this piece's collection slice.
 *
 * `includeSummary` gates the worktree `summary` string onto piece 0 only (a
 * later piece re-appends the same envelope but must not re-send the latest
 * summary pointer). When `omitEmptyCollections` is true (the emitted piece)
 * empty collection keys are dropped, mirroring `buildRequest`; when false (the
 * byte-measurement skeleton) all five arrays are kept as `[]` so per-item cost
 * accounting is a clean `size + comma`.
 */
function buildIngestPiece(
  request: TelemetryIngestRequest,
  worktree: TelemetryWorktreePayload,
  collections: IngestPieceCollections,
  isFirstPiece: boolean,
  omitEmptyCollections: boolean,
): TelemetryIngestRequest {
  const wt: TelemetryWorktreePayload = {
    clientLocalId: worktree.clientLocalId,
    ...(worktree.sourceClientLocalId !== undefined
      ? { sourceClientLocalId: worktree.sourceClientLocalId }
      : {}),
    // Space identity rides every piece with the id it describes (CAN-3615).
    ...(worktree.notificationSpace !== undefined
      ? { notificationSpace: worktree.notificationSpace }
      : {}),
    branchName: worktree.branchName,
  };
  if (worktree.status !== undefined) {
    wt.status = worktree.status;
  }
  if (worktree.clientCreatedAt !== undefined) {
    wt.clientCreatedAt = worktree.clientCreatedAt;
  }
  // Presence is envelope-shaped (one timestamp, last-write-wins server-side),
  // so it rides every piece exactly like `status`/`clientCreatedAt`.
  if (worktree.userActiveAt !== undefined) {
    wt.userActiveAt = worktree.userActiveAt;
  }
  if (isFirstPiece && worktree.summary !== undefined) {
    wt.summary = worktree.summary;
  }
  const include = (length: number): boolean =>
    omitEmptyCollections ? length > 0 : true;
  if (include(collections.turns.length)) {
    wt.turns = collections.turns;
  }
  if (include(collections.plans.length)) {
    wt.plans = collections.plans;
  }
  if (include(collections.pullRequests.length)) {
    wt.pullRequests = collections.pullRequests;
  }
  if (include(collections.pipelineRuns.length)) {
    wt.pipelineRuns = collections.pipelineRuns;
  }
  if (include(collections.summaries.length)) {
    wt.summaries = collections.summaries;
  }
  const piece: TelemetryIngestRequest = {
    workspace: {
      clientLocalId: request.workspace.clientLocalId,
      name: request.workspace.name,
      workspaceType: request.workspace.workspaceType,
      ...(request.workspace.memoryExcluded === true
        ? { memoryExcluded: true }
        : {}),
      // Organization-project provenance (CAN-2948) rides every piece so the
      // server enforces the same-organization rule on each request.
      ...(request.workspace.sourceProjectId !== undefined
        ? { sourceProjectId: request.workspace.sourceProjectId }
        : {}),
      ...(request.workspace.sourceOrganizationId !== undefined
        ? { sourceOrganizationId: request.workspace.sourceOrganizationId }
        : {}),
      worktrees: [wt],
    },
  };
  if (request.workspace.sourceProjectId !== undefined) {
    piece.workspace.sourceProjectId = request.workspace.sourceProjectId;
  }
  if (request.workspace.sourceOrganizationId !== undefined) {
    piece.workspace.sourceOrganizationId =
      request.workspace.sourceOrganizationId;
  }
  if (request.shareScope !== undefined) {
    piece.shareScope = request.shareScope;
  }
  if (request.teamId !== undefined) {
    piece.teamId = request.teamId;
  }
  if (request.organizationId !== undefined) {
    piece.organizationId = request.organizationId;
  }
  if (request.fullSession !== undefined) {
    piece.fullSession = request.fullSession;
  }
  // Attention is a last-write-wins per-(worktree, chat) state, not a collection
  // that accumulates across pieces, so it rides piece 0 only — exactly like the
  // worktree `summary` pointer. Repeating it on successors would re-submit the
  // same transition once per piece; the server's dedupe key would swallow the
  // duplicates, but there is nothing to gain from sending them.
  if (isFirstPiece && request.attention !== undefined) {
    piece.attention = request.attention;
  }
  return piece;
}

/**
 * Split one assembled {@link TelemetryIngestRequest} into a sequence of pieces,
 * each of which satisfies BOTH invariants independently:
 *
 *   - `utf8ByteLength(JSON.stringify(piece)) <= maxBytes`
 *   - every collection is within its per-request count cap (turns ≤100,
 *     plans ≤25, pullRequests ≤25, pipelineRuns ≤50, summaries ≤50)
 *
 * Properties (covered by the unit tests):
 *   - The union of all pieces' collections equals the input, order preserved,
 *     no duplicates.
 *   - The shared workspace/worktree envelope (`clientLocalId`, `name`,
 *     `workspaceType`, `branchName`, `status`, `clientCreatedAt`) plus the
 *     scope fields (`shareScope`/`teamId`/`organizationId`/`fullSession`) ride
 *     on EVERY piece; the worktree `summary` string rides on piece 0 only.
 *   - Empty collections → exactly one envelope-only piece (a metadata- or
 *     summary-only sync still sends).
 *   - At least one item is emitted per non-first piece, so a single item that
 *     is itself over `maxBytes` is emitted alone rather than looping forever
 *     (the lowered body caps guarantee a lone item fits in practice).
 *   - Deterministic: no randomness, fixed collection + within-collection order.
 *
 * Cost accounting is O(n): while packing/sizing, each item is serialized once
 * and the envelope skeleton is measured once per summary variant — this routine
 * never re-serializes the growing piece. (The caller's final
 * `JSON.stringify(piece)` at POST time is a separate, unavoidable serialization
 * of the emitted pieces; the one-time guarantee here is about the sizing/packing
 * pass, not the upload.)
 *
 * Both real callers assemble exactly one worktree per request; a request with
 * zero or multiple worktrees is returned unchanged (one piece) rather than
 * reshaped.
 */
export function splitTelemetryIngestRequest(
  request: TelemetryIngestRequest,
  maxBytes: number,
): TelemetryIngestRequest[] {
  const worktrees = request.workspace.worktrees;
  if (!worktrees || worktrees.length !== 1) {
    return [request];
  }
  const worktree = worktrees[0];
  if (!worktree) {
    return [request];
  }

  // Byte cost of the shared envelope with all five collections kept as `[]`.
  // The emitted piece omits empty collections, so its serialized size is always
  // <= (skeletonBytes + Σ itemCost); measuring against this skeleton therefore
  // keeps every emitted piece safely at or under `maxBytes`.
  const skeletonBytes = (isFirstPiece: boolean): number =>
    utf8ByteLength(
      JSON.stringify(
        buildIngestPiece(
          request,
          worktree,
          emptyIngestPieceCollections(),
          isFirstPiece,
          false,
        ),
      ),
    );

  const pieces: IngestPieceCollections[] = [];
  let current = emptyIngestPieceCollections();
  let currentBytes = skeletonBytes(true);
  let currentHasItems = false;

  const seal = (): void => {
    pieces.push(current);
    current = emptyIngestPieceCollections();
    // Only piece 0 carries the summary and attention; sealed successors drop
    // both.
    currentBytes = skeletonBytes(false);
    currentHasItems = false;
  };

  const packCollection = <T>(
    items: readonly T[],
    cap: number,
    select: (piece: IngestPieceCollections) => T[],
  ): void => {
    for (const item of items) {
      // +1 for the comma separator between array elements; a small, constant
      // overestimate (the first element of a collection has no leading comma)
      // that keeps the emitted piece strictly within budget.
      const itemCost = utf8ByteLength(JSON.stringify(item)) + 1;
      const overCount = select(current).length + 1 > cap;
      const overBytes = currentBytes + itemCost > maxBytes;
      // Seal only when the current piece already holds at least one item —
      // otherwise force this (lone, over-budget) item into its own piece so we
      // always make progress and never loop.
      if ((overCount || overBytes) && currentHasItems) {
        seal();
      }
      select(current).push(item);
      currentBytes += itemCost;
      currentHasItems = true;
    }
  };

  packCollection(
    worktree.turns ?? [],
    MAX_TELEMETRY_TURNS_PER_WORKTREE,
    (piece) => piece.turns,
  );
  packCollection(
    worktree.plans ?? [],
    MAX_TELEMETRY_PLANS_PER_WORKTREE,
    (piece) => piece.plans,
  );
  packCollection(
    worktree.pullRequests ?? [],
    MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE,
    (piece) => piece.pullRequests,
  );
  packCollection(
    worktree.pipelineRuns ?? [],
    MAX_TELEMETRY_PIPELINE_RUNS_PER_WORKTREE,
    (piece) => piece.pipelineRuns,
  );
  packCollection(
    worktree.summaries ?? [],
    MAX_TELEMETRY_SUMMARIES_PER_WORKTREE,
    (piece) => piece.summaries,
  );

  // Always emit the final (possibly envelope-only) piece.
  pieces.push(current);

  return pieces.map((collections, index) =>
    buildIngestPiece(request, worktree, collections, index === 0, true),
  );
}

/**
 * Scrub and cap a free-text attention `detail` before it can enter a telemetry
 * payload.
 *
 * `detail` is the approving command, the agent's question, the failing error —
 * user- and agent-authored free text — so it runs through the same
 * {@link redactSecrets} path every other free-text telemetry field uses.
 *
 * The cap is {@link ATTENTION_DETAIL_MAX_CHARS} rather than the 32KB body
 * bound, because the only destination is a two-line push body that already
 * spends one line on the branch name: anything longer is truncated by the OS
 * and stored for nothing. Truncation happens here, client-side, so the server
 * never holds more than it can use.
 *
 * Returns `undefined` for absent/blank input so the caller can omit the field
 * entirely rather than sending an empty string.
 */
export function buildTelemetryAttentionDetail(
  detail: string | undefined,
): string | undefined {
  if (detail === undefined) {
    return undefined;
  }
  const scrubbed = redactSecrets(detail).replace(/\s+/g, ' ').trim();
  if (scrubbed.length === 0) {
    return undefined;
  }
  if (scrubbed.length <= ATTENTION_DETAIL_MAX_CHARS) {
    return scrubbed;
  }
  // Reserve one character for the ellipsis so the result is always within the
  // cap the server clamps to.
  const budget = ATTENTION_DETAIL_MAX_CHARS - 1;
  const head = scrubbed.slice(0, budget);
  const lastSpace = head.lastIndexOf(' ');
  // Only honor a word boundary that leaves a useful amount of text; a single
  // very long token (a path, a URL) is cut mid-word rather than emptied.
  const body = lastSpace > budget / 2 ? head.slice(0, lastSpace) : head;
  return `${body.trimEnd()}…`;
}

/**
 * Assemble one wire-ready {@link TelemetryAttention} entry, applying the id
 * clamps and the `detail` scrub/cap in one place so no caller can skip them.
 *
 * `clientWorktreeId` must be the SAME namespaced id the worktree envelope
 * carries — the server rejects an attention entry that references a worktree
 * outside the request.
 */
export function buildTelemetryAttention(input: {
  clientChatId: string;
  clientWorktreeId: string;
  state: TelemetryAttention['state'];
  reason: TelemetryAttention['reason'];
  since: string;
  detail?: string;
}): TelemetryAttention {
  const detail = buildTelemetryAttentionDetail(input.detail);
  return {
    clientChatId: clampId(input.clientChatId, MAX_TELEMETRY_CLIENT_ID_LENGTH),
    clientWorktreeId: clampId(
      input.clientWorktreeId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    ),
    state: input.state,
    reason: input.reason,
    since: input.since,
    ...(detail !== undefined ? { detail } : {}),
  };
}
