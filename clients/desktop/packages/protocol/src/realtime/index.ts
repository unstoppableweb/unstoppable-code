// ---------------------------------------------------------------------------
// Real-time SSE gateway wire contract (CAN-387).
//
// Environment-neutral contract for the authenticated, owner-scoped server→
// client push channel. The transport (SSE), the cross-pod backplane (Postgres
// LISTEN/NOTIFY) and the durable replay table all live in `apps/web`; this
// module only describes the serializable shapes that cross the web API ⇄
// client boundary.
//
// Keep this module free of Node, Prisma, Next, Electron, and React imports.
// ---------------------------------------------------------------------------

import type { FeedItem } from '../feed';

// ===========================================================================
// Event-type vocabulary.
// ===========================================================================

/**
 * Closed set of real-time event families carried over the gateway. Producers
 * MUST use a type from this set; new families MUST be added here first. The
 * transport-only PR (CAN-387) ships the vocabulary; real producers wire up in
 * their own tickets (feed-on-write → CAN-373 follow-on, plan-on-change →
 * CAN-394).
 */
export const REALTIME_EVENT_TYPES = [
  'feed.item',
  'plan.detail',
  'run.detail',
  'credit.pool',
  'sharedcontainer.detail',
  'cloud.workspace',
  'cloud.attention',
  'memory.scope',
  'project.lifecycle',
] as const satisfies readonly string[];
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

// ===========================================================================
// Owner scope (unified protocol-level reconciliation).
// ===========================================================================

/**
 * Unified owner-scope kinds. This reconciles the three duplicated
 * `['private','team','organization']` arrays (telemetry/plans/pipelines) into
 * one protocol-level vocabulary. It does NOT replace the server-only
 * `TelemetryRollupScope` (numeric-id based) used inside `apps/web`.
 */
export const REALTIME_OWNER_SCOPES = [
  'private',
  'team',
  'organization',
] as const satisfies readonly string[];
export type RealtimeOwnerScopeKind = (typeof REALTIME_OWNER_SCOPES)[number];

/**
 * Owner-type discriminants as they appear on the wire / DB enum. The mapping
 * from the external scope kind to this is fixed (`private→USER`, `team→TEAM`,
 * `organization→ORGANIZATION`).
 */
export const REALTIME_OWNER_TYPES = [
  'USER',
  'TEAM',
  'ORGANIZATION',
] as const satisfies readonly string[];
export type RealtimeOwnerType = (typeof REALTIME_OWNER_TYPES)[number];

/** Fixed mapping from the unified scope kind to the owner-type discriminant. */
export const REALTIME_OWNER_SCOPE_TO_OWNER_TYPE = {
  private: 'USER',
  team: 'TEAM',
  organization: 'ORGANIZATION',
} as const satisfies Record<RealtimeOwnerScopeKind, RealtimeOwnerType>;

/**
 * Discriminated union identifying the owner a real-time event belongs to,
 * carrying external string ids only (never internal numeric ids).
 */
export type RealtimeOwnerScope =
  | { scope: 'private'; userId: string }
  | { scope: 'team'; teamId: string }
  | { scope: 'organization'; organizationId: string };

// ===========================================================================
// Event envelope.
// ===========================================================================

/**
 * Wire shape of a single real-time event. Modeled on `RemoteControlEventEnvelope`
 * (`../portal`) but owner-scoped and carrying the numeric `sequence` (the
 * durable, globally-monotonic row id) so a reconnecting client can resume with
 * `Last-Event-ID` without gap or duplicate.
 *
 * - `eventId` is the producer-generated idempotency key; duplicate inserts are
 *   dropped server-side via the unique constraint, so retries are safe.
 * - `sequence` is the durable cursor. It is global and the replay table is
 *   shared, so the cursor survives landing on either replica after the ~300s
 *   Cloud-Run forced reconnect.
 */
export interface RealtimeEventEnvelope<TPayload = unknown> {
  type: RealtimeEventType;
  eventId: string;
  occurredAt: string;
  sequence: number;
  payload: TPayload;
}

/** A real-time envelope carrying a hydrated team-feed item. */
export type RealtimeFeedEnvelope = RealtimeEventEnvelope<FeedItem>;

/**
 * Lightweight `plan.detail` signal payload (CAN-394). The event carries only the
 * changed plan's external id plus its remote revision so a subscriber can cheaply
 * decide staleness; the authoritative `SharedPlanDetail` is then refetched over
 * the durable read path. The durable replay row stays tiny and per-viewer-correct.
 */
export interface PlanRealtimeSignal {
  /** External (uuid) id of the shared plan that changed. */
  planId: string;
  /** Remote revision after the change, for cheap client staleness checks. */
  revision: number;
}

/** A real-time envelope carrying a `plan.detail` signal. */
export type RealtimePlanEnvelope = RealtimeEventEnvelope<PlanRealtimeSignal>;

/**
 * Lightweight `run.detail` signal payload (CAN-397). Mirrors
 * `PlanRealtimeSignal`: it carries only the changed run's external id plus the
 * run's comment revision so a subscriber can cheaply decide staleness, then
 * refetch the authoritative `SharedRunDetail` over the durable read path. The
 * signal is a refetch trigger, never state.
 */
export interface RunRealtimeSignal {
  /** External (uuid) id of the shared run that changed. */
  runId: string;
  /** `SharedRun.commentRevision` after the change, for staleness checks. */
  commentRevision: number;
}

/** A real-time envelope carrying a `run.detail` signal. */
export type RealtimeRunEnvelope = RealtimeEventEnvelope<RunRealtimeSignal>;

/**
 * Lightweight `credit.pool` signal payload. Emitted post-commit whenever an
 * owner's AI credit balance changes (today: Stripe-webhook credit top-ups). Like
 * `plan.detail` it is a refetch trigger, not the authoritative state: it carries
 * only the new balance in whole credits so a subscriber can cheaply update or
 * decide staleness, then refetch the authoritative `CreditsSummary`/ledger over
 * the durable read path. No second sync path is introduced.
 */
export interface CreditPoolRealtimeSignal {
  /** Owner's AI credit balance in whole credits after the change. */
  balanceCredits: number;
  /** Refetch owner-scoped access; never proof of payment or eligibility. */
  modelLibraryAccessChanged?: true;
}

/** A real-time envelope carrying a `credit.pool` signal. */
export type RealtimeCreditPoolEnvelope =
  RealtimeEventEnvelope<CreditPoolRealtimeSignal>;

/** Refetch-only signal for a named-recipient shared container. */
export interface SharedContainerRealtimeSignal {
  containerId: string;
  revision: number;
}

export type RealtimeSharedContainerEnvelope =
  RealtimeEventEnvelope<SharedContainerRealtimeSignal>;

/**
 * Refetch-only signal that a chat now exists in one of the owner's cloud
 * workspaces, whoever created it. A client that does not hold the chat
 * reloads its workspace projection; one that does ignores it.
 */
export interface CloudWorkspaceRealtimeSignal {
  /** External (uuid) id of the cloud workspace. */
  workspaceId: string;
  /** External (uuid) id of the chat that was created there. */
  chatId: string;
}

export type RealtimeCloudWorkspaceEnvelope =
  RealtimeEventEnvelope<CloudWorkspaceRealtimeSignal>;

/**
 * A question or tool approval in one of the owner's cloud chats started
 * (`requested`) or ended (`resolved`: answered, expired or cancelled)
 * (CAN-5656). Sent only to the user the agent is waiting on. Identifiers
 * only: the chat's own interactions read carries the request.
 */
export interface CloudAttentionRealtimeSignal {
  /** External (uuid) id of the cloud workspace. */
  workspaceId: string;
  /** External (uuid) id of the chat. */
  chatId: string;
  /** Core interaction id, the one `respond` takes. */
  interactionId: string;
  kind: 'question' | 'approval';
  state: 'requested' | 'resolved';
  /** When an unanswered request expires (ISO 8601), on `requested` only. */
  expiresAt: string | null;
}

export type RealtimeCloudAttentionEnvelope =
  RealtimeEventEnvelope<CloudAttentionRealtimeSignal>;

/**
 * Refetch-only signal that a cloud project the owner uses has a new lifecycle
 * event (CAN-5189): a rename, a redirect, a move, an archive or a delete. The
 * client reads `GET /api/v1/projects/{projectId}/events` after its cursor.
 */
export interface ProjectLifecycleRealtimeSignal {
  /** External (uuid) id of the project whose event feed grew. */
  projectId: string;
  /** Opaque cursor of the new event in that feed (`CloudProjectEventCursorSchema`). */
  cursor: string;
}

export type RealtimeProjectLifecycleEnvelope =
  RealtimeEventEnvelope<ProjectLifecycleRealtimeSignal>;

// ===========================================================================
// Transport limits.
// ===========================================================================

/**
 * Hard upper bound (bytes) on the LISTEN/NOTIFY payload. The NOTIFY carries an
 * id + owner identity only (never the row body), so this is a generous ceiling
 * that the id-only payload will never approach; the publisher asserts against
 * it defensively. Postgres itself caps a NOTIFY payload at 8000 bytes.
 */
export const REALTIME_NOTIFY_MAX_BYTES = 7000;
