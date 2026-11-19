// ---------------------------------------------------------------------------
// Shared Run API contracts (CAN-395).
//
// A "run" is a lightweight, shareable manifest/grant over an already-synced
// agent session. It does NOT copy the transcript: it references the existing
// telemetry `TranscriptTurn` / `Plan` rows for a `(worktreeId, clientChatId)`
// pair and adds the run diff plus a denormalized rollup snapshot. The explicit
// "Share run to organization" action is its own consent — it proceeds even
// when the ambient `telemetrySharing` opt-in is Off (CAN-374), ingesting the
// referenced rows on demand at USER/owner scope first, then creating the org
// grant.
//
// This module is the single source of truth for the wire shapes that cross the
// desktop ⇄ web boundary:
//   - the create request the desktop client posts (`SharedRunCreateRequest`)
//   - the reference the create returns (`SharedRunRef`)
//   - the assembled viewer detail the gated GET returns (`SharedRunDetail`)
//
// IMPORTANT: this module must stay dependency-free (no `node:crypto`, no
// filesystem, no network, no Prisma, no React) so it is safe to import from the
// renderer, the desktop main process, and the web service alike. It mirrors the
// dependency-free banner of `telemetry/index.ts` and `feed/index.ts`. The only
// sibling protocol import it takes is the pure `RemoteControlChatMessage` wire type
// (CAN-396): the run viewer now assembles a structured, projected transcript in
// addition to the per-turn plaintext fallback CAN-395 shipped.
// ---------------------------------------------------------------------------

import type { RemoteControlChatMessage } from '../remote-control/shell';

// ===========================================================================
// Wire version.
// ===========================================================================

/**
 * Wire version of the shared-run API. Bump only on breaking shape changes.
 *
 * v2 (CAN-396) adds the projected structured transcript (`messages`) and the
 * session plans (`plans`) to `SharedRunDetail`, and defines the downloadable
 * `SharedRunPackage` envelope.
 *
 * v3 (CAN-397) adds threaded comments (`commentThreads`) to `SharedRunDetail`
 * plus the desktop-facing comment request DTOs.
 */
export const RUNS_API_VERSION = 3;

// ===========================================================================
// Scope vocabulary.
//
// Shared runs may be granted to the current user, a team, or an organization.
// Importable session snapshot exports use a separate API and lifecycle.
// ===========================================================================

export const RUN_SHARE_SCOPES = ['private', 'team', 'organization'] as const;
export type RunShareScope = (typeof RUN_SHARE_SCOPES)[number];

// ===========================================================================
// Byte / count limits enforced at the route boundary.
// ===========================================================================

/** Max raw bytes of the run `diff` blob (encrypted at rest; contains code). */
export const MAX_SHARED_RUN_DIFF_BYTES = 5 * 1024 * 1024;

/** Max length of a client-supplied correlation id (mirrors telemetry ids). */
export const MAX_SHARED_RUN_CLIENT_ID_LENGTH = 128;

/** Max length of the run title. */
export const MAX_SHARED_RUN_TITLE_LENGTH = 256;

/** Max raw bytes of the plaintext `summary` search abstract. */
export const MAX_SHARED_RUN_SUMMARY_BYTES = 32 * 1024;

/** Max comment threads a single run may carry. */
export const MAX_SHARED_RUN_COMMENT_THREADS = 1000;

/** Max comments a single run comment thread may carry. */
export const MAX_SHARED_RUN_COMMENTS_PER_THREAD = 500;

/** Max length of a single run comment body. */
export const MAX_SHARED_RUN_COMMENT_BODY_LENGTH = 16_384;

// ===========================================================================
// Comments (CAN-397).
//
// A shared run is a review object: a reader can open a thread against the whole
// run, or against one projected transcript message. Threads are always
// server-authored by an authenticated principal (there is no desktop-local
// comment store to merge upward, unlike plans), so every comment carries an
// author user and no author-kind discriminant is needed. "Is this the run
// author / is this me" is derived at render time by comparing
// `author.userId` against `SharedRunDetail.author.userId` / the viewer id.
//
// The message anchor references `SharedRunDetail.messages[].messageId`
// verbatim and treats it as OPAQUE — nothing parses its internal structure.
// ===========================================================================

/** Whole-run thread, or one anchored to a projected transcript message. */
export type SharedRunCommentAnchor =
  | { kind: 'run' }
  | { kind: 'message'; messageId: string };

/**
 * Reconciliation state of a thread's anchor, computed at read time against the
 * assembled transcript. `'orphaned'` when the anchored message is no longer
 * present (transcript truncation, the `helper:` filter, or a narrowed
 * re-share); such threads render in the run-level list rather than disappearing.
 */
export type SharedRunCommentAnchorState = 'matched' | 'orphaned';

/** Lifecycle status of a run comment thread. */
export type SharedRunCommentThreadStatus = 'open' | 'resolved';

/** Identity of a run comment's author. */
export interface SharedRunCommentAuthor {
  /** Server user externalId; empty when the author row is gone. */
  userId: string;
  displayName: string | null;
  image: string | null;
}

/** One comment inside a run comment thread. */
export interface SharedRunComment {
  /** Stable client/server thread-scoped comment id. */
  id: string;
  author: SharedRunCommentAuthor;
  body: string;
  createdAt: string;
}

/** A threaded conversation anchored to a run or one of its messages. */
export interface SharedRunCommentThread {
  /** Stable run-scoped thread id (the id the mutation routes take). */
  id: string;
  status: SharedRunCommentThreadStatus;
  anchor: SharedRunCommentAnchor;
  anchorState: SharedRunCommentAnchorState;
  createdAt: string;
  comments: SharedRunComment[];
}

/** Body of the create-thread request (`POST …/runs/{runId}/comments`). */
export interface SharedRunCommentCreateRequest {
  body: string;
  /** Defaults to `{ kind: 'run' }` when omitted. */
  anchor?: SharedRunCommentAnchor;
}

/** Body of the reply request (`POST …/runs/{runId}/comments/{threadId}`). */
export interface SharedRunCommentReplyRequest {
  body: string;
}

/** Body of the status request (`PATCH …/runs/{runId}/comments/{threadId}`). */
export interface SharedRunCommentStatusRequest {
  status: SharedRunCommentThreadStatus;
}

// ===========================================================================
// Rollup snapshot.
//
// A point-in-time denormalized rollup of the session, computed client-side by
// summing the session's `AgentAuditEntry` / turn columns. Persisted on the
// `SharedRun` row so a run list/card can render cost/token/tool totals without
// re-summing the referenced turns, and echoed back on the viewer detail.
// ===========================================================================

export interface SharedRunRollup {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number;
  toolUseCount: number;
  /** Number of turns summed into this run. */
  turnCount: number;
  /** Summed per-turn agent durations across the session in ms, when recorded. */
  durationMs?: number;
  /** Driving provider of the session, from its latest turn. */
  provider: string;
  /** Model of the session, from its latest turn, when known. */
  model?: string;
  /** Terminal status of the session, from its latest turn. */
  status: string;
}

// ===========================================================================
// Request DTO.
// ===========================================================================

export interface SharedRunCreateRequest {
  /** Stable client-authoritative id for this run (idempotency key). */
  clientLocalRunId: string;
  /** Local workspace id the session belongs to. */
  workspaceLocalId: string;
  /** Local worktree id the session belongs to. */
  worktreeLocalId: string;
  /** The chat id whose turns/plans this run references. */
  clientChatId: string;
  /** Grant scope. The desktop creates shared-run grants at team/org scope. */
  shareScope: RunShareScope;
  /** Required when `shareScope === 'team'`; the target team externalId. */
  teamId?: string;
  /** Required when `shareScope === 'organization'`; the target org externalId. */
  organizationId?: string;
  /**
   * Preserve the grant's server-authoritative owner while refreshing content.
   * Background desktop refreshes set this so stale local audience metadata
   * cannot move a run after a newer explicit share action.
   */
  preserveExistingOwner?: boolean;
  title: string;
  /** Plaintext search abstract; scrubbed client-side per CAN-374. */
  summary: string;
  /** Denormalized rollup snapshot summed client-side. */
  rollup: SharedRunRollup;
  /** Sensitive run diff (code); encrypted at rest server-side. */
  diff: string;
  /** Optional inclusive first client turn id in the shared range. */
  turnRangeStartClientTurnId?: string;
  /** Optional inclusive last client turn id in the shared range. */
  turnRangeEndClientTurnId?: string;
}

// ===========================================================================
// Owner / actor / reference shapes.
// ===========================================================================

/** Who authored the run, for the viewer byline. */
export interface SharedRunAuthor {
  /** Display name; empty for a removed/unknown actor. */
  name: string;
  /** Avatar URL when one exists. */
  image: string | null;
  /**
   * Author's stable external id (the member-profile route segment). `null`
   * when the creator can't be resolved. Combined with the run's owner
   * `organizationId`, the viewer links the byline to that member's profile.
   */
  userId: string | null;
}

/** Minimal reference returned by create — enough for the client to link/store. */
export interface SharedRunRef {
  externalId: string;
  shareScope: RunShareScope;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Lightweight list-item shape for a shared run, rendered on a member's profile
 * "Sessions" tab and any other run listing. Carries the denormalized rollup
 * snapshot columns so a row can show cost/turn/tool totals without assembling
 * the full transcript. `id` is the `SharedRun.externalId` (links to
 * `…/runs/{id}`); the `id` field name matches the `useMemberPagedResource`
 * keyset contract.
 */
export interface SharedRunSummary {
  id: string;
  title: string;
  shareScope: RunShareScope;
  /** Terminal status of the session, from its latest turn. */
  status: string;
  /** Driving provider of the session. */
  provider: string;
  /** Model of the session, when known. */
  model: string | null;
  turnCount: number;
  toolUseCount: number;
  /** Total cost in USD, when recorded. */
  totalCostUsd: number | null;
  /** Summed per-turn agent durations in ms, when recorded. */
  durationMs: number | null;
  createdAt: string;
  updatedAt: string;
}

// ===========================================================================
// Viewer detail — the assembled run the gated GET returns.
//
// The transcript is assembled server-side from the referenced turn rows: each
// entry is the per-turn decrypted plaintext plus its rollup-relevant metadata,
// ordered by `startedAt`. CAN-396 renders this; CAN-395 only produces it.
// ===========================================================================

/** One assembled transcript turn in the viewer. */
export interface SharedRunTranscriptTurn {
  /** Decrypted plaintext body; empty string when absent / not decryptable. */
  text: string;
  /** ISO instant the turn started. */
  startedAt: string;
  /** Per-turn rollup-relevant metadata (cost/tokens/tools/status). */
  rollup: SharedRunTurnRollup;
}

/** Per-turn rollup carried on each assembled transcript turn. */
export interface SharedRunTurnRollup {
  status: string;
  provider: string;
  model: string | null;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalCostUsd: number | null;
  toolUseCount: number;
  durationMs: number | null;
}

// ===========================================================================
// Session plans (CAN-396).
//
// The plans present on the run's worktree at share time (bounded by the
// consent snapshot `createdAt <= run.updatedAt`) are included in the run
// package for plan-vs-reality context. `content` is the decrypted plan body.
//
// Association is chat-level via `(worktreeId, clientChatId)`, but tracked plans
// are worktree-keyed with no native chat linkage — the share path stamps the
// run's `clientChatId` onto the worktree's plans at share time. v1 imprecision:
// if a worktree hosted more than one chat session, that worktree's other plans
// are attributed to this run. Not a cross-tenant concern (same owner,
// sharer-initiated); a precise per-chat plan link is a future refinement.
// ===========================================================================

/** One session plan included in the run package. */
export interface SharedRunPlan {
  /** Server-side external id of the plan row. */
  externalId: string;
  /** Client-authoritative plan id (stable across syncs). */
  clientPlanId: string;
  title: string;
  /** Decrypted plan body markdown; empty string when absent / not decryptable. */
  content: string;
  /** Review status of the plan (e.g. `pending`, `approved`). */
  reviewStatus: string;
  /** Monotonic plan revision, when recorded. */
  planVersion?: number;
  /** Plaintext plan summary abstract, when present. */
  summary?: string;
  /** ISO instant the plan was created. */
  createdAt: string;
}

export interface SharedRunDetail extends SharedRunRef {
  clientChatId: string;
  summary: string;
  /** Ordered assembled transcript (per-turn decrypted text + rollup). */
  transcript: SharedRunTranscriptTurn[];
  /**
   * Ordered, projected whole-run transcript as structured Portal chat
   * messages (thinking / tool-use / text blocks). Assembled server-side by
   * parsing each turn's decrypted provider JSONL. Empty when nothing could be
   * parsed; the per-turn `transcript` plaintext remains the fallback.
   */
  messages: RemoteControlChatMessage[];
  /** Decrypted run diff; empty string when absent / not decryptable. */
  diff: string;
  /** Rollup summed server-side over the referenced turn columns. */
  rollup: SharedRunRollup;
  /** The member who authored the run, for the viewer byline. */
  author: SharedRunAuthor;
  /**
   * External id of the owning organization for an org-scoped run (`null`
   * otherwise). With `author.userId`, the viewer links the byline to
   * `/organization/{organizationId}/members/{author.userId}`.
   */
  organizationId: string | null;
  /** Session plan(s) captured with the run, for plan-vs-reality context. */
  plans: SharedRunPlan[];
  /**
   * Threaded comments on the run (CAN-397), ordered oldest-first. Always
   * present; empty when nobody has commented. Anchor states are reconciled
   * server-side against `messages` on every read.
   */
  commentThreads: SharedRunCommentThread[];
  /**
   * Monotonic counter bumped on every comment mutation (CAN-397). It is the
   * cheap staleness scalar behind the `run.detail` realtime signal and the
   * desktop's background poll — deliberately NOT `updatedAt`, which is the
   * consent snapshot bound for the visible turn set.
   */
  commentRevision: number;
  /**
   * External id of the principal this detail was assembled for, so a client can
   * render "you" without a second identity lookup, and the desktop poller can
   * avoid notifying a user about their own comment. `null` when the viewer
   * cannot be resolved.
   */
  viewerUserId: string | null;
}

/** Back-compat alias: the viewer shape is the run detail. */
export type SharedRunViewer = SharedRunDetail;

// ===========================================================================
// Unshare (delete) result.
//
// Unshare is keyed by the desktop's authoritative `clientLocalRunId`, not the
// server-minted `externalId`, so the client never has to depend on a locally
// persisted `externalId` that may be stale. It is sent as a URL path segment
// (`DELETE .../runs/{clientLocalRunId}`), so there is no request body DTO. The
// web route resolves the row via the `(createdByUserId, clientLocalRunId)`
// unique and hard-deletes it.
// ===========================================================================

export interface SharedRunUnshareResult {
  /**
   * The run is not shared after a successful call. `true` when a matching grant
   * was found and removed; `false` when no grant matched (already absent — an
   * idempotent no-op). The web route returns a uniform 404 for both "missing"
   * and "unauthorized" so run existence is never leaked; the desktop client
   * maps that 404 onto `unshared: false`, so an already-deleted run still
   * resolves successfully and local "Shared" state can always converge.
   */
  unshared: boolean;
}

// ===========================================================================
// Download envelope (CAN-396).
//
// The client-side "Download run" action serializes the assembled detail into
// this self-describing envelope. JSON only for v1 (Markdown deferred).
// ===========================================================================

/**
 * Version of the downloadable run-package envelope shape.
 *
 * v2 (CAN-397): the embedded run detail now carries `commentThreads`.
 */
export const SHARED_RUN_PACKAGE_VERSION = 2;

export interface SharedRunPackage {
  /** Envelope shape version (`SHARED_RUN_PACKAGE_VERSION`). */
  packageVersion: number;
  /** ISO instant the package was generated client-side. */
  generatedAt: string;
  /** The full assembled run detail. */
  run: SharedRunDetail;
}

/**
 * Pure structural validator for a parsed `SharedRunPackage`. Returns `true`
 * only when `value` has the required envelope fields with the right primitive
 * types and a `run` object carrying a run `externalId`. Deliberately shallow:
 * it guards the envelope, not every nested field.
 */
export function isSharedRunPackage(value: unknown): value is SharedRunPackage {
  if (!isPlainRecord(value)) {
    return false;
  }
  if (typeof value.packageVersion !== 'number') {
    return false;
  }
  if (typeof value.generatedAt !== 'string') {
    return false;
  }
  if (!isPlainRecord(value.run)) {
    return false;
  }
  return typeof value.run.externalId === 'string';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
