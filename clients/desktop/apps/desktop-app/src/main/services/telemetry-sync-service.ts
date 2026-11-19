import type { DataSharingOptInHistoryEntry } from '@canopy/desktop-shared/types';
import { capTelemetrySharingToConsentHistory } from './historical-telemetry-sharing';
// ---------------------------------------------------------------------------
// Centralized telemetry sync service (CAN-402).
//
// This main-process singleton packages per-turn telemetry (plus plans, PR
// status, and the worktree summary), scrubs secrets before anything leaves the
// machine, uploads through a durable queue, tracks returned server IDs so
// restarted turns / changed artifacts amend rather than duplicate, and stays
// off by default until a scope is opted in.
//
// Privacy invariant: every free-text field is redacted by the pure mappers in
// `@canopy/desktop-shared/lib/telemetry-mapping` before it enters a payload.
//
// Gate model (CAN-403 per-data-type opt-in, `PreferencesData.telemetrySharing`).
// Each data type has its own visibility (`off | private | team | organization`):
//   - `metadata`    governs the per-turn record (token/cost/timing/tool rollups),
//                   pull-request status, and the workspace/worktree envelope.
//   - `transcripts` governs the encrypted turn body. A turn row carries body and
//                   metadata under ONE owner scope server-side, so the body only
//                   rides along when `transcripts` resolves to the SAME scope as
//                   `metadata`. Enabling `transcripts` while `metadata` is off (or
//                   at a different scope) uploads nothing for transcripts — a
//                   transcript cannot exist without its (metadata-owned) turn row.
//   - `plans`       governs plan records.
//   - `summaries`   governs the AI-written worktree recaps: the latest-pointer
//                   `worktree.summary` and the `summaries[]` snapshot history.
//                   Split out of `metadata` so a transcripts prohibition is not
//                   undermined by conversation-derived prose. Like the turn
//                   body, the summary rides the worktree ENVELOPE rather than
//                   standing alone, so it only attaches when `summaries`
//                   resolves to the SAME scope as `metadata` — `metadata` is a
//                   hard prerequisite. Deliberately NOT its own envelope group
//                   the way `plans` has one.
//
// Effective sharing starts with stored preferences; no plan floor applies.
// At ingress and again at delivery, the work's governing organization is
// resolved and only that organization's required/prohibited policy is applied.
// Personal work, Personal Cowork, and App Advisor have no governing
// organization; an org-owned Cowork workspace is governed by its saved owner.
// Unresolved ownership fails closed.
//
// When every type is `off` (the default) each ingress hard short-circuits —
// nothing is enqueued, persisted, or uploaded. A flush partitions pending content
// by resolved scope and sends one ingest request per distinct scope.
//
// Owner scope (CAN-3515, replacing the CAN-3278 selected-context ceiling):
// activity counts only in the scope that owns the work, whatever the sidebar
// shows. Work in an organization-owned workspace (converted, set up from the
// catalog, org Cowork, an org's default Chats) goes only to that organization;
// Personal work, including a Personal checkout of a repository an org also
// tracks, stays private. The sidebar selection is never captured, and it
// neither chooses nor caps a destination (`resolveTelemetryDeliveryTarget`).
//
// Items carry no captured context. At flush the owner and current policy are
// re-evaluated per item, so anything queued earlier, including legacy queue
// lines stamped with a selection by older builds, lands where the work belongs.
// The one explicit destination is a shared container's anchor registration,
// which names the organization the member chose; it carries the worktree
// envelope only. Membership, billing, the org's enforced policy, the member's
// per-kind preferences, and the CAN-2948 ownership gates still apply, and
// unresolved ownership still uploads nothing.
//
// Per-owner rows: the server keys Workspace/Worktree by
// (createdByUserId, clientLocalId) and freezes owner scope, so one id cannot be
// shared across owners (the second target would 409). Each non-private target
// therefore gets its OWN namespaced clientLocalId (`scopedClampedId`), yielding
// one set of server rows per owner. That per-owner duplication is inherent: the
// server encrypts bodies with owner scope mixed into the AAD, so the same
// content stored for two owners is two distinct ciphertexts and cannot be
// deduplicated server-side. `private` keeps the bare id for backward
// compatibility.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { sharedContainerOwnerKey } from '../shared-containers/owner-scope';
import {
  MAX_TELEMETRY_ATTENTION_PER_REQUEST,
  MAX_TELEMETRY_CLIENT_ID_LENGTH,
  MAX_TELEMETRY_INGEST_BATCH_BYTES,
  MAX_TELEMETRY_LABEL_LENGTH,
  MAX_TELEMETRY_NAME_LENGTH,
  MAX_TELEMETRY_PIPELINE_RUNS_PER_WORKTREE,
  MAX_TELEMETRY_PLANS_PER_WORKTREE,
  MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE,
  MAX_TELEMETRY_SHARE_BODY_BYTES,
  MAX_TELEMETRY_SUMMARIES_PER_WORKTREE,
  RUN_SHARE_ID_SUFFIX,
  type TelemetryAttention,
  type TelemetryAttentionReason,
  type TelemetryAttentionState,
  type TelemetryIngestRequest,
  type TelemetryIngestResponse,
  type TelemetryPipelineRunPayload,
  type TelemetryPlanPayload,
  type TelemetryPullRequestPayload,
  type TelemetryShareScope,
  type TelemetryTurnPayload,
  type TelemetryWorkspaceType,
  type TelemetryWorktreeStatus,
  type TelemetryWorktreeSummarySnapshot,
} from '@canopy/protocol';
import {
  TELEMETRY_OWNER_SCOPE_CONFLICT_CODE,
  TELEMETRY_SCOPE_PROHIBITED_CODE,
  TELEMETRY_TRACKED_SOURCE_ORGANIZATION_TARGET_CODE,
  telemetryNamespacedClientLocalId,
  telemetryPrivateOwnerConflictClientLocalId,
  type PrStateValue,
} from '@canopy/protocol/telemetry';
import {
  buildTelemetryAttention,
  buildTelemetryAttentionDetail,
  clampId,
  clampText,
  mapAuditEntryToTurnPayload,
  mapVisibilityToShareScope,
  mapPipelineRunUsageEventToPayload,
  mapTrackedPlanToPlanPayload,
  mapWorktreePrStatusToPayloads,
  mapWorktreeSummaryToText,
  splitTelemetryIngestRequest,
} from '@canopy/desktop-shared/lib/telemetry-mapping';
import { redactSecrets } from '@canopy/execution-engine/lib/redaction';
import { normalizeUuid } from '@canopy/execution-engine/lib/workspace-owner';
import {
  resolveEffectiveTelemetrySharing,
  enforcementForOrganization,
  type OrgTelemetryEnforcement,
} from '@canopy/desktop-shared/lib/telemetry-enforcement';
import { TELEMETRY_SHARING_SCOPES } from '@canopy/desktop-shared/types';
import type {
  TelemetryScopeKey,
  TelemetrySharingPreferences,
  TelemetrySharingVisibility,
  TelemetrySyncStatus,
  TrackedPlanData,
  WorkspaceType,
  WorktreeSummaryData,
} from '@canopy/desktop-shared/types';
import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import type {
  AgentAuditEntry,
  AgentAuditTranscriptInjectedPromptRecord,
  AgentObservabilityUpdateEvent,
  PipelineRunUsageEvent,
} from '@canopy/execution-engine/types/observability';
import { getObservabilityService } from '../observability';
import {
  oldestQueuedTelemetryItemAt,
  type TelemetrySyncHealthSnapshot,
} from './telemetry-sync-pause';
import {
  CanopyCloudClientError,
  requestCanopyCloudJson,
} from '../canopy-cloud/client';
import { getCanopyCloudCredentials } from '../lib/canopy-cloud-account-store';
import { resolveSpaceNotificationScope } from '../lib/space-notification-scope';
import {
  spaceNotificationProducerId,
  spaceNotificationSourceRef,
} from '../lib/space-notification-ref';
import type { SpaceNotificationScope } from '@canopy/desktop-shared/types';
import { isOrgTeamsLapsed } from '@canopy/desktop-shared/lib/org-billing-state-parsing';
import { loadStoredOrgBillingStates } from '../lib/org-billing-state';
import {
  getTelemetrySyncMapFilePath,
  getTelemetrySyncQueueFilePath,
} from '../lib/paths';
import { getWorkspaceContextService } from '../lib/workspace-context-service';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  peekPreferencesLoadError,
  readPreferencesFile,
} from '../lib/preferences-store';
import {
  emptyTelemetryEnforcementByOrganization,
  loadStoredTelemetryEnforcementByOrganization,
  recordTelemetryEnforcementReadFailure,
  type StoredTelemetryEnforcementByOrganization,
} from '../lib/telemetry-enforcement-state';
import {
  resolveWorkOwnerOrganization,
  workOwnerContextForSelection,
  type WorkOwnerOrganization,
} from '../lib/work-owner';
import { resolveTelemetryDeliveryTarget } from './telemetry-delivery-scope';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';
// Leaf module, NOT `../lib/cowork-work-entries`: that barrel imports
// `@canopy/desktop-shared/types` as a value and pulls the brand runtime in at
// require time, which fails suites that stub the brand module.
import { readWorkEntriesFile } from '../lib/cowork-work-entries-file';
import { readWorkspaceIndexEntry } from '../lib/sidebar-items';
import {
  readWorkspaceConfigDetailed,
  readWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import {
  addPlanContentChangeListener,
  addPlanShareChangeListener,
  listTrackedPlans,
  removePlanContentChangeListener,
  removePlanShareChangeListener,
} from '../lib/plan-persistence';
import {
  addWorktreeSummaryChangeListener,
  removeWorktreeSummaryChangeListener,
} from '../lib/worktree-summary-persistence';
// PR-status changes are subscribed via a leaf emitter module (not
// `github-poller`) to avoid an import cycle back through session-manager.
import {
  addWorktreePrStatusChangeListener,
  removeWorktreePrStatusChangeListener,
} from '../lib/pr-status-change-emitter';
// Pipeline-run completions are subscribed via a leaf emitter module (not the
// pipeline handlers) to avoid an import cycle back through the executor.
import {
  addPipelineRunCompletionListener,
  removePipelineRunCompletionListener,
  type PipelineRunCompletionEvent,
} from '../lib/pipeline-run-completion-emitter';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  PR_RECONCILIATION_INTERVAL_MS,
  PR_RECONCILIATION_STARTUP_DELAY_MS,
  PR_RECONCILIATION_WORKTREE_ID,
  mostAdvancedPrState,
  prStateIsBehind,
  reconcilePullRequests,
  type PrReconciliationResult,
} from './pr-telemetry-reconciler';
import { getSentinelTelemetryWorkspace } from '../lib/sentinel-telemetry-workspaces';
import { allowsAutomaticCall } from '../local-only/policy';

/**
 * Per-worktree debounce window. Coalesces late transcript writes and batches
 * multiple same-worktree changes into one upload. Kept as a single named
 * constant so it is trivially tunable and overridable in tests via fake timers.
 */
export const TELEMETRY_SYNC_DEBOUNCE_MS = 60_000;

/**
 * Escalating re-arm delays after consecutive SERVER rejections (CAN-3106).
 *
 * The debounce used to be the only delay in the system, so a batch the server
 * could never accept was re-sent every 60 seconds forever — in staging that was
 * 52-59 identical `P2020`s per hour, all day. The ladder mirrors
 * `ai-gateway-models/service.ts` and caps at 15 minutes; the first entry is
 * deliberately `TELEMETRY_SYNC_DEBOUNCE_MS` so a single blip retries on the
 * normal cadence and only a sustained outage backs off.
 */
export const TELEMETRY_SYNC_RETRY_DELAYS_MS: readonly number[] = [
  60_000, 120_000, 240_000, 480_000, 900_000,
];

/**
 * Consecutive server rejections after which a batch is abandoned rather than
 * queued again. On the capped ladder that is roughly 1.5 hours of sustained
 * 5xx. Losing one telemetry batch to a backend outage that long is the
 * deliberate tradeoff against an unbounded queue file (CAN-3106).
 */
export const MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS = 10;

// Bumped to 2 for the per-worktree summary-snapshot queue field. Old (v1) queue
// lines are silently discarded on load by the version guard; the only cost is
// losing un-flushed telemetry that had not yet been uploaded, so no migration is
// needed.
const QUEUE_LINE_VERSION = 2;
// Bumped to 2 for the per-target sync-map shape (org fan-out). v1 maps are
// silently discarded on load by the version guard; the only cost is that the
// first post-upgrade flush re-sends bodies the server already has (an idempotent
// no-op amend), so no migration is needed. The later-added `summaries` record is
// optional on the target so pre-existing v2 maps (without it) still load without
// a version bump; a missing map is treated as empty.
const SYNC_MAP_VERSION = 2;
// Persisted in the sync map. Its id suffix is the frozen protocol constant
// `TELEMETRY_PRIVATE_OWNER_CONFLICT_ID_SUFFIX` (sha256 of this name, sliced to
// 16 hex chars), which the server recomputes to find these rows (CAN-3601).
const PRIVATE_OWNER_CONFLICT_ID_VARIANT = 'private-owner-conflict-v1' as const;

interface WorktreeMeta {
  workspaceName: string;
  workspaceType: TelemetryWorkspaceType;
  branchName: string;
  status?: TelemetryWorktreeStatus;
  createdAt?: string;
}

/**
 * Maps a desktop `WorkspaceType` to its telemetry counterpart. `cowork` is
 * included alongside `single-repo`/`multi-repo` (Cowork Workspace
 * Unification Plan 7) so cowork workspaces produce workspace-type
 * telemetry like every other workspace kind.
 */
function toTelemetryWorkspaceType(
  type: WorkspaceType | undefined,
): TelemetryWorkspaceType | undefined {
  if (type === 'single-repo' || type === 'multi-repo' || type === 'cowork') {
    return type;
  }
  return undefined;
}

/**
 * One pending attention transition for a chat inside a worktree.
 *
 * Deliberately NOT part of the persisted queue. Attention is live desktop state
 * ("this chat is parked on an unanswered question right now"); replaying a
 * pre-restart transition would push the user about a block a restart already
 * resolved. A restart starts from a clean slate and the next real block
 * re-arms.
 */
interface PendingAttention {
  clientChatId: string;
  state: TelemetryAttentionState;
  reason: TelemetryAttentionReason;
  since: string;
  detail?: string;
}

interface PendingItem<T> {
  capturedAt?: string;
  memoryExcluded?: boolean;
  id: string;
  /**
   * An organization the member explicitly chose for this item (a shared
   * container's anchor registration). Null for ambient activity, which is
   * routed by the work's owner at flush. Never the sidebar selection.
   */
  targetOrganizationId: string | null;
  value: T;
}

/**
 * Shape of an item as persisted by any build. `selectedOrganizationId` is the
 * CAN-3278 capture-time stamp; it is read only to be ignored, so a legacy item
 * is re-evaluated by its owner like any other.
 */
interface PersistedPendingItem<T> {
  capturedAt?: string;
  memoryExcluded?: boolean;
  id: string;
  targetOrganizationId?: string | null;
  selectedOrganizationId?: string | null;
  value: T;
}

interface PendingMetadata extends WorktreeMeta {
  /** Envelope-only refresh, retained until its captured destination drains. */
  dirty?: boolean;
}

interface PendingWorktree extends WorktreeMeta {
  projectId: string;
  worktreeId: string;
  turns: Map<string, PendingItem<TelemetryTurnPayload>>;
  plans: Map<string, PendingItem<TelemetryPlanPayload>>;
  pullRequests: Map<string, PendingItem<TelemetryPullRequestPayload>>;
  pipelineRuns: Map<string, PendingItem<TelemetryPipelineRunPayload>>;
  summaries: Map<string, PendingItem<string>>;
  summarySnapshots: Map<string, PendingItem<TelemetryWorktreeSummarySnapshot>>;
  attention: Map<string, PendingItem<PendingAttention>>;
  metadata: Map<string, PendingItem<PendingMetadata>>;
  /**
   * Unbroken run of SERVER rejections (a response arrived and it was a 5xx)
   * for this worktree's queued content. Drives the escalating re-arm delay and
   * the abandon threshold (CAN-3106).
   *
   * Only a rejection counts. `status === undefined` — offline, DNS failure,
   * timeout — leaves this untouched, so a laptop on a plane never loses
   * telemetry to a counter it cannot influence. Reset on any successful upload.
   */
  consecutiveServerRejections?: number;
  /** When the current rejection run started, for the abandon diagnostic. */
  firstRejectionAt?: string;
}

interface PersistedPendingWorktree extends WorktreeMeta {
  /** CAN-3278 line-level stamp. Ignored: the owner decides at flush. */
  selectedOrganizationId?: string | null;
  items?: {
    turns: PersistedPendingItem<TelemetryTurnPayload>[];
    plans: PersistedPendingItem<TelemetryPlanPayload>[];
    pullRequests: PersistedPendingItem<TelemetryPullRequestPayload>[];
    pipelineRuns: PersistedPendingItem<TelemetryPipelineRunPayload>[];
    summaries: PersistedPendingItem<string>[];
    summarySnapshots: PersistedPendingItem<TelemetryWorktreeSummarySnapshot>[];
    metadata: PersistedPendingItem<PendingMetadata>[];
  };
  version: number;
  projectId: string;
  worktreeId: string;
  turns: TelemetryTurnPayload[];
  plans: TelemetryPlanPayload[];
  pullRequests: TelemetryPullRequestPayload[];
  pipelineRuns: TelemetryPipelineRunPayload[];
  summary?: string;
  summarySnapshots?: TelemetryWorktreeSummarySnapshot[];
  /** Legacy envelope-only refresh. */
  metaDirty?: boolean;
  /**
   * See {@link PendingWorktree.consecutiveServerRejections}. Deliberately
   * OPTIONAL and added WITHOUT bumping `QUEUE_LINE_VERSION`: `loadQueue`
   * discards every line whose version does not match, so a bump would delete
   * each user's queued telemetry on upgrade. Absent fields read as `0` /
   * `undefined`, which is exactly the pre-change behaviour.
   */
  consecutiveServerRejections?: number;
  /** See {@link PendingWorktree.firstRejectionAt}. Optional for the same reason. */
  firstRejectionAt?: string;
}

interface SyncMapRef {
  externalId: string;
  contentHash?: string;
}

/**
 * Server-assigned ids and last-synced content hashes for one worktree at one
 * owner-scope target. A local worktree can accumulate targets (private, its
 * owner, a shared-container anchor, and targets written by earlier builds),
 * each with its own server records, so this is keyed per target rather than
 * stored flat on the worktree.
 */
interface SyncMapTarget {
  externalId: string;
  /** Stable namespace selected after a legacy bare-id owner conflict. */
  clientIdVariant?: typeof PRIVATE_OWNER_CONFLICT_ID_VARIANT;
  turns: Record<string, SyncMapRef>;
  plans: Record<string, SyncMapRef>;
  /**
   * `prUrl` is persisted alongside the server id so cross-writer PR ownership
   * survives a restart. Optional: maps written before this field existed
   * simply contribute no claim, which degrades to the previous behaviour
   * rather than breaking the load.
   *
   * `state` is the last state sent, so the reconciliation sweep can re-send a
   * merge or close the poller never observed (CAN-3513). Optional: entries
   * written before it existed read as unknown, which the sweep backfills.
   */
  pullRequests: Record<
    string,
    { externalId: string; prUrl?: string; state?: PrStateValue }
  >;
  pipelineRuns: Record<string, { externalId: string }>;
  // Optional so a pre-existing v2 sync-map (written before summary history) still
  // loads; a missing map means no snapshots have been recorded for this target.
  summaries?: Record<string, { externalId: string }>;
}

interface SyncMapWorktree {
  // Keyed by target key (`scopeTargetKey`): 'private' | `team:<id>` | `org:<id>`.
  targets: Record<string, SyncMapTarget>;
  /**
   * First server worktree chosen as the shared-container identity for each org.
   * Target maps accumulate as telemetry scope changes; freezing the first
   * usable id prevents a later, higher-priority target from orphaning grants
   * that are unique by server worktree id.
   *
   * Keyed by organization id, or by `PERSONAL_SHARED_CONTAINER_OWNER_KEY`
   * (`'personal'`, never a UUID) for a personal container, which anchors to
   * the user-owned `private` target.
   */
  sharedContainerAnchors?: Record<string, string>;
}

interface SyncMapWorkspace {
  // Workspace externalId per target key (each org returns its own).
  externalIds: Record<string, string>;
  worktrees: Record<string, SyncMapWorktree>;
}

interface TelemetrySyncMapFile {
  version: number;
  workspaces: Record<string, SyncMapWorkspace>;
  // Optional status fields persisted so "Synced Xm ago" survives a restart.
  // Older files without these are tolerated by the version guard.
  lastSyncedAt?: string;
  lastErrorAt?: string;
  lastError?: 'upload-failed';
}

interface ScopeContext {
  shareScope: TelemetryShareScope;
  teamId?: string;
  organizationId?: string;
  /**
   * For team targets only: the team's parent organization, used to apply the
   * same-organization rule (CAN-2948). Never sent to the server.
   */
  ownerOrganizationId?: string;
}

/**
 * Outcome of resolving a share scope's owner-scope targets.
 *
 * The `unavailable` / `all-lapsed` split is the point of this type. Both mean
 * zero destinations, but only one of them can resolve on its own:
 *
 * - `unavailable` is TRANSIENT — no credentials, or no matching org/team yet.
 *   Keeping the data queued is correct; it will land once the scope resolves.
 * - `all-lapsed` is TERMINAL under the current billing state: every membership
 *   resolved and every one is gated by CAN-2311, so no retry can succeed.
 *   Collapsing it into `unavailable` made the flush loop defer, reschedule
 *   every 60s, and rewrite an unbounded pending-turn queue for as long as the
 *   org stayed lapsed — and then, if it ever paid, backfill the whole lapsed
 *   period, which is exactly the delivery the gate exists to prevent.
 */
/**
 * Per-flush record of whether a fresh billing confirmation has already been
 * obtained during THIS flush. Created per `doFlushWorktree` call and discarded
 * with it, so no flush inherits another's deletion authority.
 */
interface LapseConfirmationCache {
  confirmed: boolean;
}

type ScopeResolution =
  | {
      kind: 'targets';
      targets: ScopeContext[];
      /**
       * At least one membership was dropped from this fan-out as lapsed, so
       * `targets` is a PARTIAL list.
       *
       * Load-bearing for the delete decision, not just informational. A group
       * is dropped from the queue once every target in `targets` has stored it,
       * so a partial fan-out that reports success would permanently delete data
       * the filtered-out org never received — and the filter ran against the
       * persisted snapshot, which the background probe refreshes only every ~20
       * minutes. If that org had already renewed, the loss is unrecoverable and
       * caused purely by local staleness. `all-lapsed` alone cannot express
       * this: one lapsed org plus one healthy org resolves to `targets`.
       */
      filteredLapsed: boolean;
    }
  | { kind: 'unavailable' }
  | { kind: 'excluded' }
  | { kind: 'all-lapsed' };

/** One scope's worth of content assembled for a single ingest request. */
interface FlushGroup {
  memoryExcluded: boolean;
  routeKey: string;
  shareScope: TelemetryShareScope;
  /** Destination organization; null for private. */
  organizationId: string | null;
  /**
   * Whether the member's presence may ride this envelope: only on the route
   * the work's own metadata goes to. False for a plans-only route shared more
   * widely than metadata, and for a shared-container anchor outside the owner.
   */
  carriesPresence: boolean;
  meta: WorktreeMeta;
  metaDirty: boolean;
  drop: () => void;
  turns: TelemetryTurnPayload[];
  plans: TelemetryPlanPayload[];
  pullRequests: TelemetryPullRequestPayload[];
  pipelineRuns: TelemetryPipelineRunPayload[];
  summary?: string;
  summaries: TelemetryWorktreeSummarySnapshot[];
  /**
   * Attention transitions riding this group's worktree envelope. Only the
   * `metadata` group ever carries them — the state is envelope-shaped, so it
   * cannot land on a worktree row that scope did not create.
   */
  attention?: TelemetryAttention[];
}

type TelemetryCollection =
  | 'metadata'
  | 'turns'
  | 'plans'
  | 'pullRequests'
  | 'pipelineRuns'
  | 'summaries'
  | 'summarySnapshots'
  | 'attention';

interface ItemRoute {
  routeKey: string;
  scope: TelemetryShareScope;
  organizationId: string | null;
  carriesPresence: boolean;
  includeBody: boolean;
}

function deliveryRouteKey(target: {
  scope: TelemetryShareScope;
  organizationId: string | null;
}): string {
  return target.scope === 'private'
    ? 'private'
    : JSON.stringify([target.scope, target.organizationId]);
}

function worktreeKey(projectId: string, worktreeId: string): string {
  return `${projectId}::${worktreeId}`;
}

function pendingWorktreeKey(
  entry: Pick<PendingWorktree, 'projectId' | 'worktreeId'>,
): string {
  return worktreeKey(entry.projectId, entry.worktreeId);
}

/**
 * Target for ambient activity: no explicit destination, so the item is routed
 * by the work's owner at flush.
 */
const OWNER_ROUTED = null;

function pendingItemKey(id: string, organizationId: string | null): string {
  return JSON.stringify([id, organizationId]);
}

function queueItem<T>(
  items: Map<string, PendingItem<T>>,
  id: string,
  value: T,
  organizationId: string | null,
  memoryExcluded?: boolean,
  capturedAt?: string,
): void {
  const key = pendingItemKey(id, organizationId);
  const previousCapturedAt = items.get(key)?.capturedAt;
  const previouslyExcluded = items.get(key)?.memoryExcluded === true;
  // Refresh insertion order as well as the value, so the newest update per
  // identity wins when items are coalesced.
  items.delete(key);
  items.set(key, {
    id,
    targetOrganizationId: organizationId,
    capturedAt: previousCapturedAt ?? capturedAt ?? new Date().toISOString(),
    value,
    memoryExcluded: memoryExcluded === true || previouslyExcluded,
  });
}

function dropItems<T>(
  items: Map<string, PendingItem<T>>,
  sent: PendingItem<T>[],
): void {
  for (const item of sent) {
    const key = pendingItemKey(item.id, item.targetOrganizationId);
    // An enqueue during an upload replaces the object and must survive.
    if (items.get(key) === item) items.delete(key);
  }
}

/**
 * The sidebar selection. Read only by the run-share policy check, which uses it
 * to apply a matching organization's prohibitions to linked Personal work. It
 * never chooses or limits where ambient telemetry is delivered (CAN-3515).
 */
function selectedOrganizationId(): string | null {
  const context = getWorkspaceContextService().getState()?.context;
  return context?.kind === 'organization' ? context.organizationId : null;
}

function pullRequestKey(repoId: string, prNumber: number): string {
  return `${repoId}#${prNumber}`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Stable sync-map key for one owner-scope target, independent of which
 * context is currently selected. Existing server identities stay unchanged.
 */
function scopeTargetKey(context: ScopeContext): string {
  switch (context.shareScope) {
    case 'private':
      return 'private';
    case 'team':
      return `team:${context.teamId ?? ''}`;
    case 'organization':
      return `org:${context.organizationId ?? ''}`;
  }
}

/**
 * Per-target workspace/worktree `clientLocalId` sent to the server.
 *
 * The server keys Workspace and Worktree by `(createdByUserId, clientLocalId)`
 * and freezes owner scope on re-sync, so reusing one id across owners makes the
 * second+ fan-out target collide with the first owner's row and fail with 409.
 * Namespacing the id per non-private target (a stable hash of the target key)
 * gives every org/team its own rows, which is also what makes per-owner storage
 * unavoidable — each owner gets its own (separately encrypted) records.
 *
 * `private` stays on the bare id for backward compatibility, except when a
 * downgraded upload discovers that a legacy organization row already owns it.
 * That one conflict selects and persists a deterministic private fallback.
 * The result is run through `clampId` so it stays within the shared length
 * bound; `clampId` is idempotent, so the server echoes the same id back and the
 * sync-map round-trip still matches.
 */
function scopedClampedId(
  baseId: string,
  context: ScopeContext,
  clientIdVariant?: typeof PRIVATE_OWNER_CONFLICT_ID_VARIANT,
): string {
  if (context.shareScope === 'private') {
    if (clientIdVariant === PRIVATE_OWNER_CONFLICT_ID_VARIANT) {
      return telemetryPrivateOwnerConflictClientLocalId(baseId);
    }
    return clampId(baseId, MAX_TELEMETRY_CLIENT_ID_LENGTH);
  }
  // The server recomputes this id to find a checkout's organization rows
  // (CAN-3517), so both sides use the protocol derivation.
  return telemetryNamespacedClientLocalId(
    baseId,
    sha256(scopeTargetKey(context)),
  );
}

/**
 * `clientLocalId` for the self-contained "share session" ingest (CAN-395).
 *
 * The explicit share materializes its own USER-owned copy of a session's rows
 * (the request still sends `shareScope: 'private'`, so the server owns them as
 * USER). Reusing the bare id here would collide with ambient private rows and,
 * worse, with legacy pre-namespacing org rows that squat the bare id — the
 * server freezes owner scope on re-sync, so that collision 409s the share. A
 * dedicated stable namespace makes the share's ids unique to the share path, so
 * the write can never conflict regardless of what else the user has synced. The
 * same ids are handed to the `SharedRun` grant so it references exactly these
 * rows.
 *
 * The suffix itself is the frozen protocol constant `RUN_SHARE_ID_SUFFIX`
 * (literally `sha256('canopy-run-share-v1').slice(0, 16)`, asserted by a test
 * in this package). It is shared with the web rollups, which must exclude these
 * USER-owned duplicate rows from `user-global`-scoped scoring queries — that
 * scope has no owner filter, so a shared Cowork entry would otherwise be
 * counted twice.
 */
function runShareClientLocalId(baseId: string): string {
  return clampId(
    `${baseId}-${RUN_SHARE_ID_SUFFIX}`,
    MAX_TELEMETRY_CLIENT_ID_LENGTH,
  );
}

/**
 * Drop the encrypted body (and its now-meaningless content hash) from a turn
 * payload. Used when `transcripts` is off or resolves to a different owner scope
 * than `metadata`: the turn row still uploads with its rollups, but without the
 * transcript text, which cannot share a row owned at a different scope.
 */
function stripTurnBody(turn: TelemetryTurnPayload): TelemetryTurnPayload {
  if (turn.body === undefined && turn.contentHash === undefined) {
    return turn;
  }
  const rest: TelemetryTurnPayload = { ...turn };
  delete rest.body;
  delete rest.contentHash;
  return rest;
}

const DEFAULT_SHARING: TelemetrySharingPreferences = {
  transcripts: 'off',
  plans: 'off',
  metadata: 'off',
  summaries: 'off',
};

/**
 * Machine-readable code the server returns (as a 403) when a request carries a
 * scope the user's org prohibits. Re-exported from the protocol package, which
 * is the single source of truth shared with the web ingest path — a local
 * duplicate would drift silently, and the only symptom would be this client
 * retrying a permanently-rejected batch forever.
 */
export { TELEMETRY_SCOPE_PROHIBITED_CODE };

/**
 * Outcome of {@link TelemetrySyncService.ingestSessionForShare}.
 *
 * The explicit run-share path deliberately bypasses the ambient sharing gate,
 * so an org prohibition has to be refused here explicitly rather than falling
 * out of the ambient `off` checks. The refusal is TYPED (not a silent `null`)
 * so the caller can render an explanation naming the org instead of a generic
 * "sharing failed".
 */
export type IngestSessionForShareResult =
  | { status: 'ok'; workspaceLocalId: string; worktreeLocalId: string }
  /** No finished turns, or the worktree metadata could not be resolved. */
  | { status: 'no-activity' }
  | {
      status: 'blocked-by-org-policy';
      /** The prohibited scope that blocked the share. */
      scope: TelemetryScopeKey;
      /** Names of the organizations prohibiting it. */
      organizationNames: string[];
    };

/**
 * `summaries` sharing as Agent Ledger sync follows it (LD02): the stored
 * choice, and whether any organization the
 * account belongs to prohibits summaries.
 */
export interface TelemetrySummariesSharing {
  readonly visibility: TelemetrySharingVisibility;
  /**
   * An organization the account belongs to prohibits sharing summaries, or
   * the organizations' policy could not be read.
   */
  readonly prohibited: boolean;
}

export interface TelemetrySyncServiceDeps {
  /**
   * Relay device id of this computer when its relay key is already loaded.
   * Read at request build time so an id loaded after construction is sent.
   */
  getRelayDeviceId?: () => string | null;
}

export class TelemetrySyncService {
  private readonly getRelayDeviceId: () => string | null;

  constructor(deps: TelemetrySyncServiceDeps = {}) {
    this.getRelayDeviceId = deps.getRelayDeviceId ?? ((): null => null);
  }

  private started = false;
  /**
   * Resolves once `start()` has hydrated the durable queue. Ingress paths that
   * can be invoked from IPC before startup finishes must await this, otherwise
   * their `persistQueue()` would rewrite the queue file from an unhydrated map
   * and destroy the previous session's queued telemetry. Observability-driven
   * ingress is safe by construction (its listener is only subscribed after
   * hydration); `refreshWorktreeMetadata` is reachable earlier.
   *
   * Created at field-initialization rather than inside `start()` so the guard
   * holds structurally from construction. Deriving it in `start()` would make
   * correctness depend on the incidental ordering of
   * `initializeTelemetrySyncService()` and `registerAllIpcHandlers()` in
   * `main/index.ts` — two distant lines with nothing asserting the relationship.
   */
  private resolveQueueReady: () => void = () => undefined;
  private readonly queueReady: Promise<void> = new Promise<void>((resolve) => {
    this.resolveQueueReady = resolve;
  });
  /**
   * True only when `loadQueue()` completed normally. The `queueReady` promise
   * settles in a `finally` so nothing can dangle, which means it also opens on
   * a FAILED hydration — and writing against a partially-hydrated map would
   * drop the lines that were never read, the exact loss the gate exists to
   * prevent. Liveness comes from the promise; correctness comes from this flag.
   */
  private queueHydrated = false;
  // `disposing` is set at the very start of dispose() so ingress short-circuits
  // immediately, while `disposed` is only set after the final drain so the
  // flush path is not short-circuited mid-teardown.
  private disposing = false;
  private disposed = false;
  // The user's stored prefs. Org enforcement is resolved per work item by
  // `effectiveSharingFor`.
  private sharing: TelemetrySharingPreferences = DEFAULT_SHARING;
  private optInHistory: DataSharingOptInHistoryEntry[] = [];
  /**
   * Coarse presence: the last renderer interaction observed per worktree. It
   * rides only the envelope of the work's own route (private or its owner),
   * never a shared-container anchor in another organization.
   *
   * Deliberately in-memory; each throttled advance queues an envelope-only
   * metadata flush so activity after the final turn still reaches the server.
   * A restart drops it, which fails in the safe direction: an unknown
   * `userActiveAt` suppresses nothing.
   */
  private userActivity = new Map<string, string>();
  // The prefs exactly as persisted.
  private rawSharing: TelemetrySharingPreferences = DEFAULT_SHARING;
  private enforcementByOrganization: ReadonlyMap<
    string,
    OrgTelemetryEnforcement
  > = emptyTelemetryEnforcementByOrganization();
  /** False only while the persisted account policy could not be read. */
  private enforcementAvailable = false;
  /** True when the last preferences read threw and defaults stood in. */
  private preferencesReadFailed = false;

  private readonly pending = new Map<string, PendingWorktree>();
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private syncMap: TelemetrySyncMapFile = {
    version: SYNC_MAP_VERSION,
    workspaces: {},
  };

  // Serializes disk writes and uploads so the queue/sync-map stay consistent.
  private ioChain: Promise<void> = Promise.resolve();
  private flushChain: Promise<void> = Promise.resolve();
  private readonly sharedContainerAnchorReservations = new Map<
    string,
    Promise<boolean>
  >();

  private unsubscribeObservability: (() => void) | null = null;

  /**
   * Canonical PR identity -> the worktree key that owns it in THIS process.
   *
   * The live poller and the reconciliation sweep are independent writers whose
   * rows do not converge: `(worktreeId, repoId, prNumber)` is a storage key, so
   * the same PR reported against two worktrees yields two rows that BOTH count.
   * The sweep's pre-flight ownership and synced-key checks are snapshots taken
   * before a multi-page network call, so on their own they leave a window where
   * the poller can enqueue the same PR concurrently (or vice versa).
   *
   * Both writers run in this process, so a claim keyed on `prUrl` -- the only
   * identity both producers agree on -- closes that window outright. The
   * check-and-claim below is a single synchronous block, so it is atomic with
   * respect to the event loop and no interleaving can pass it twice.
   *
   * The value is the claiming worktree key, not a boolean, so the owner can
   * keep amending its own row (open -> merged) while a different writer is
   * refused.
   */
  private readonly claimedPullRequests = new Map<string, string>();

  /** Repeating PR reconciliation sweep; null until `start()` schedules it. */
  private prReconciliationTimer: NodeJS.Timeout | null = null;
  /** Deferred first sweep; cleared on dispose so it cannot fire post-teardown. */
  private prReconciliationStartupTimer: NodeJS.Timeout | null = null;
  /** Guards against a slow sweep overlapping the next interval tick. */
  private prReconciliationRunning = false;

  // -------------------------------------------------------------------------
  // Status tracking (surfaced to the renderer via the sidebar account menu's
  // cloud-sync row). Main owns the network truth: whether an upload is in
  // flight, when the last upload succeeded/failed. `lastSyncedAt`/
  // `lastErrorAt`/`lastError` are persisted on the sync-map file so the
  // status survives restart.
  // -------------------------------------------------------------------------
  private isSyncing = false;
  /**
   * De-duplicates the confirmation probe across concurrent flushes.
   *
   * Flushes are per worktree with their own debounce timers, so several can hit
   * an all-lapsed scope within the same second. Without this they would each
   * fire a probe. Sharing ONE in-flight promise also means every one of them
   * waits for, and decides on, the same refreshed snapshot — which is why this
   * replaced the earlier per-scope "already confirmed" flag: that flag was
   * keyed by scope alone on a singleton, so the first worktree's deferral
   * silently authorized every other worktree's deletion.
   */
  private inFlightLapseConfirmation: Promise<boolean> | null = null;
  private lastSyncedAt: string | null = null;
  private lastErrorAt: string | null = null;
  private lastError: 'upload-failed' | null = null;
  private readonly statusListeners = new Set<
    (status: TelemetrySyncStatus) => void
  >();
  private readonly summariesSharingListeners = new Set<() => void>();
  /** The `summaries` sharing listeners last heard of. */
  private lastSummariesSharingKey = 'off:false';
  // Last emitted snapshot, compared before emitting so we never strobe the
  // spinner or wake the renderer on no-op transitions.
  private lastEmittedStatus: TelemetrySyncStatus | null = null;

  // Bound listener references kept as stable instance fields so `dispose()` can
  // unregister them. The change-emitter Sets key on function identity, so the
  // exact reference passed to `add*` must be passed to `remove*`.
  private readonly planContentListener = (plan: TrackedPlanData): void => {
    void this.handlePlanChange(plan);
  };

  private readonly planShareListener = (plan: TrackedPlanData): void => {
    void this.handlePlanChange(plan);
  };

  private readonly summaryChangeListener = (event: {
    projectId: string;
    worktreeId: string;
    summary: WorktreeSummaryData;
    snapshotId: string;
    isNewSnapshot: boolean;
  }): void => {
    void this.handleSummaryChange(
      event.projectId,
      event.worktreeId,
      event.summary,
      event.snapshotId,
      event.isNewSnapshot,
    );
  };

  private readonly prStatusChangeListener = (event: {
    projectId: string;
    worktreeId: string;
    status: WorktreePrStatus | null;
  }): void => {
    if (event.status === null) return;
    void this.handlePrStatusChange(
      event.projectId,
      event.worktreeId,
      event.status,
    );
  };

  private readonly pipelineRunCompletionListener = (
    event: PipelineRunCompletionEvent,
  ): void => {
    void this.handlePipelineRunCompletion(
      event.projectId,
      event.worktreeId,
      event.event,
    );
  };

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    try {
      // Hydrate org enforcement BEFORE the first `this.sharing` derivation so a
      // prohibited scope is never briefly effective during startup.
      try {
        this.enforcementByOrganization =
          await loadStoredTelemetryEnforcementByOrganization();
        this.enforcementAvailable = true;
      } catch (error) {
        this.enforcementAvailable = false;
        recordTelemetryEnforcementReadFailure('telemetry-sync-startup', error);
      }
      await this.refreshScopeFromPreferences();
      await this.loadSyncMap();
      this.rehydrateClaimsFromSyncMap();
      await this.loadQueue();
      this.queueHydrated = true;
    } finally {
      // Always settle, even if a load threw: `refreshWorktreeMetadata` awaits
      // this, and a permanently-pending promise would dangle every later call.
      // `queueHydrated` stays false on failure so the gate still refuses to
      // write against a half-read queue.
      this.resolveQueueReady();
    }

    this.unsubscribeObservability = getObservabilityService().subscribe(
      (event) => {
        this.handleObservabilityEvent(event);
      },
    );
    addPlanContentChangeListener(this.planContentListener);
    addPlanShareChangeListener(this.planShareListener);
    addWorktreeSummaryChangeListener(this.summaryChangeListener);
    addWorktreePrStatusChangeListener(this.prStatusChangeListener);
    addPipelineRunCompletionListener(this.pipelineRunCompletionListener);

    // Resume any items that survived a restart.
    if (!this.isOff()) {
      for (const key of Array.from(this.pending.keys())) {
        this.scheduleFlush(key);
      }
    } else if (
      !this.disposed &&
      this.enforcementAvailable &&
      this.pending.size > 0 &&
      !this.preferencesReadFailed &&
      peekPreferencesLoadError() === null
    ) {
      // With every scope declined the resumed queue has no allowed route, so
      // it is terminal. Older builds floored a stored Off to Just me; what
      // they queued must never upload if the user later turns sharing on.
      // Items the user queued under an earlier opt-in are dropped too, since
      // the queue cannot tell them apart. Within a session, turning sharing
      // Off keeps the queue. If enforcement or preferences could not be read,
      // the queue is kept: an organization requirement may still route it,
      // and fallback defaults are not the user's choice.
      this.pending.clear();
      try {
        await this.persistQueue();
      } catch (error) {
        // Best effort: the on-disk queue is dropped again next launch, and a
        // failed write must not abort startup.
        try {
          logMainProcessWarn(
            '[telemetry-sync] dropping the declined queue failed',
            error,
          );
        } catch {
          // Logger unavailable; drop the message.
        }
      }
      this.emitStatus();
    }

    this.schedulePullRequestReconciliation();
  }

  /**
   * Kick off the recurring PR reconciliation sweep.
   *
   * The first sweep is deferred rather than run inline: startup already
   * contends for the GitHub rate limit (the poller hydrates every tracked
   * worktree), and reconciliation is a catch-up path with no latency
   * requirement. The timer is unref'd so it never keeps the app alive.
   */
  private schedulePullRequestReconciliation(): void {
    if (this.prReconciliationTimer) {
      return;
    }
    // Never arm the sweep under Jest. Its first run is a long real timer, so a
    // suite that constructs the service without disposing it would fire the
    // callback after the environment is torn down, where even the logger has
    // been unloaded. Production wiring is unaffected.
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    const run = (): void => {
      void this.runPullRequestReconciliation();
    };
    const initial = setTimeout(() => {
      this.prReconciliationStartupTimer = null;
      run();
    }, PR_RECONCILIATION_STARTUP_DELAY_MS);
    initial.unref?.();
    this.prReconciliationStartupTimer = initial;
    const interval = setInterval(run, PR_RECONCILIATION_INTERVAL_MS);
    interval.unref?.();
    this.prReconciliationTimer = interval;
  }

  /**
   * Re-read the per-data-type opt-in gate from preferences. Called at startup
   * and whenever preferences are saved. Kept named `refreshScopeFromPreferences`
   * for its existing callers (the preferences IPC handler).
   */
  async refreshScopeFromPreferences(): Promise<void> {
    let sharing: TelemetrySharingPreferences;
    try {
      const prefs = await readPreferencesFile();
      sharing = prefs.telemetrySharing ?? DEFAULT_SHARING;
      this.optInHistory = prefs.dataSharingOptInHistory ?? [];
      this.preferencesReadFailed = false;
    } catch {
      sharing = DEFAULT_SHARING;
      this.preferencesReadFailed = true;
    }
    this.rawSharing = sharing;
    this.applyEffectiveSharing();
  }

  /**
   * Replace the org-enforced policy and re-derive effective sharing.
   *
   * Called by the org-enforced-settings applier on every apply (startup pass
   * and the periodic re-probe), including the "nothing enforced" case so
   * de-enforcement releases the pin instead of leaving a stale one in place.
   */
  setTelemetryEnforcementByOrganization(
    byOrg: ReadonlyMap<string, OrgTelemetryEnforcement>,
  ): boolean {
    const previous = JSON.stringify(Array.from(this.enforcementByOrganization));
    const next = JSON.stringify(Array.from(byOrg));
    const changed = previous !== next || !this.enforcementAvailable;
    this.enforcementByOrganization = byOrg;
    this.enforcementAvailable = true;
    if (!changed) return false;
    this.applyEffectiveSharing();
    this.schedulePendingFlushes();
    return true;
  }

  private effectiveSharingFor(
    organizationId: string | null,
  ): TelemetrySharingPreferences {
    const enforcement = enforcementForOrganization(
      this.enforcementByOrganization,
      organizationId,
    );
    // A metadata prohibition wins and is handled before routing.
    return resolveEffectiveTelemetrySharing(this.sharing, enforcement);
  }

  /**
   * The organization that owns the work. `selectedOrganization` is consulted
   * only by the run-share policy check (linked Personal work in a matching
   * context); ambient telemetry passes null, so a Personal workspace is always
   * Personal there, whatever is selected (CAN-3515).
   */
  private async governingOrgFor(
    projectId: string,
    worktreeId: string,
    selectedOrganization: string | null,
    cache?: Map<string, Promise<WorkOwnerOrganization>>,
  ): Promise<WorkOwnerOrganization> {
    const key = JSON.stringify([projectId, worktreeId, selectedOrganization]);
    const resolve = (): Promise<WorkOwnerOrganization> =>
      resolveWorkOwnerOrganization(
        { projectId, worktreeId },
        workOwnerContextForSelection(selectedOrganization),
      );
    if (!cache) return resolve();
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = resolve();
    cache.set(key, pending);
    return pending;
  }

  private async effectiveSharingForWork(
    projectId: string,
    worktreeId: string,
  ): Promise<TelemetrySharingPreferences | null> {
    const owner = await this.governingOrgFor(projectId, worktreeId, null);
    if (owner.kind === 'unknown') return null;
    if (owner.kind === 'organization' && !this.enforcementAvailable) {
      return null;
    }
    return this.effectiveSharingFor(
      owner.kind === 'organization' ? owner.organizationId : null,
    );
  }

  /**
   * Adopt the user's stored choice as the runtime sharing. Every plan may keep
   * a scope Off; no subscription floor applies. Org policy is applied later,
   * against each item's governing organization.
   *
   * Reschedules pending flushes when the derivation newly enables sync, and
   * re-emits status so `sharingActive` reflects the change either direction.
   */
  private applyEffectiveSharing(): void {
    const wasAllOff = this.allOff();
    const previousMetadata = this.sharing.metadata;
    const previousPlans = this.sharing.plans;
    this.sharing = this.rawSharing;
    // Metadata newly becoming shareable must reschedule too, not just the
    // all-off -> not-all-off transition. A `metaDirty` envelope has no
    // collection items, so nothing else will wake it: when a user toggles
    // metadata off and back on while another data type stayed on the whole
    // time, `allOff()` never flipped and the queued rename / mark-done would
    // otherwise wait for unrelated activity on that worktree or for app quit.
    const metadataNewlyOn =
      previousMetadata === 'off' && this.sharing.metadata !== 'off';
    // Plans have their own group and can remain queued while metadata stays
    // on. Transcripts and summaries ride the metadata group instead.
    const plansNewlyOn =
      previousPlans === 'off' && this.sharing.plans !== 'off';
    if ((wasAllOff && !this.allOff()) || metadataNewlyOn || plansNewlyOn) {
      this.schedulePendingFlushes();
    }
    this.emitStatus();
    this.emitSummariesSharing();
  }

  /**
   * `summaries` sharing, as the Agent Ledger follows it (LD02). Organization
   * policy applies only to the work an organization owns, so no requirement
   * raises the account's choice here. A prohibition still holds the whole
   * account: a private Ledger scope's registration names no owner.
   */
  getSummariesSharing(): TelemetrySummariesSharing {
    return {
      visibility: this.sharing.summaries,
      prohibited:
        !this.enforcementAvailable ||
        Array.from(this.enforcementByOrganization.values()).some(
          ({ enforcement }) => enforcement.prohibited.summaries,
        ),
    };
  }

  /**
   * Calls `listener` after effective `summaries` sharing changed: the stored
   * choice or organization enforcement. Returns the
   * unsubscribe.
   */
  subscribeSummariesSharing(listener: () => void): () => void {
    this.summariesSharingListeners.add(listener);
    return (): void => {
      this.summariesSharingListeners.delete(listener);
    };
  }

  private emitSummariesSharing(): void {
    const { visibility, prohibited } = this.getSummariesSharing();
    const key = `${visibility}:${String(prohibited)}`;
    if (key === this.lastSummariesSharingKey) return;
    this.lastSummariesSharingKey = key;
    for (const listener of Array.from(this.summariesSharingListeners)) {
      try {
        listener();
      } catch {
        // A listener never breaks sharing.
      }
    }
  }

  /** True when no data type is opted in to sync. */
  private allOff(): boolean {
    return TELEMETRY_SHARING_SCOPES.every(
      (scope) => this.sharing[scope] === 'off',
    );
  }

  private isOff(): boolean {
    return this.disposed || this.sharingDeclined();
  }

  /** Every scope is off and no organization requires one. */
  private sharingDeclined(): boolean {
    const anyRequired = Array.from(
      this.enforcementByOrganization.values(),
    ).some(({ enforcement }) =>
      TELEMETRY_SHARING_SCOPES.some((scope) => enforcement.required[scope]),
    );
    return this.allOff() && !anyRequired;
  }

  /**
   * Read-only gate and queue view for the sync-paused monitor
   * (`telemetry-sync-pause.ts`, CAN-3512). Reads state only; never schedules,
   * flushes, or persists.
   */
  getHealthSnapshot(): TelemetrySyncHealthSnapshot {
    const worktrees = Array.from(this.pending.values());
    return {
      sharingWanted: !this.disposed && !this.sharingDeclined(),
      // The published count, so the Privacy line, the snapshot and the
      // diagnostic agree.
      pendingCount: this.buildStatus().pendingCount,
      oldestPendingAt: oldestQueuedTelemetryItemAt(worktrees),
      lastSyncedAt: this.lastSyncedAt,
    };
  }

  // -------------------------------------------------------------------------
  // Status surface (renderer sidebar account menu cloud-sync row)
  // -------------------------------------------------------------------------

  /**
   * Subscribe to status snapshots. The current snapshot is emitted immediately
   * on subscribe (modeled on `ObservabilityService.subscribe`). Returns an
   * unsubscribe function.
   */
  subscribeStatus(listener: (status: TelemetrySyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.buildStatus());
    return (): void => {
      this.statusListeners.delete(listener);
    };
  }

  getStatus(): TelemetrySyncStatus {
    return this.buildStatus();
  }

  /** Derive the live status snapshot from current service state. */
  private buildStatus(): TelemetrySyncStatus {
    let pendingCount = 0;
    for (const entry of Array.from(this.pending.values())) {
      pendingCount +=
        entry.turns.size +
        entry.plans.size +
        entry.pullRequests.size +
        entry.pipelineRuns.size +
        entry.summarySnapshots.size +
        entry.summaries.size;
    }
    return {
      isSyncing: this.isSyncing,
      // Invariant: `pendingCount` intentionally reflects all retained items even
      // when `sharingActive` is false. Flipping the feature flag off cancels
      // debounced flushes without draining, so queued content is preserved and
      // resumes if the flag flips back on. Consumers must therefore treat
      // `pendingCount > 0` while `sharingActive === false` as "content retained
      // but uploads gated", not as an inconsistency. Do not zero it here — that
      // would erase the signal that retained content is waiting to resume.
      pendingCount,
      // Reflects user opt-in or an org requirement; required work can remain
      // active even when every preference is off.
      sharingActive: !this.isOff(),
      lastSyncedAt: this.lastSyncedAt,
      lastErrorAt: this.lastErrorAt,
      lastError: this.lastError,
    };
  }

  /** Flip the in-flight flag, emitting only on an actual transition. */
  private setSyncing(value: boolean): void {
    if (this.isSyncing === value) {
      return;
    }
    this.isSyncing = value;
    this.emitStatus();
  }

  /** Emit the current snapshot to subscribers, skipping no-op transitions. */
  private emitStatus(): void {
    const status = this.buildStatus();
    if (
      this.lastEmittedStatus !== null &&
      this.lastEmittedStatus.isSyncing === status.isSyncing &&
      this.lastEmittedStatus.pendingCount === status.pendingCount &&
      this.lastEmittedStatus.sharingActive === status.sharingActive &&
      this.lastEmittedStatus.lastSyncedAt === status.lastSyncedAt &&
      this.lastEmittedStatus.lastErrorAt === status.lastErrorAt &&
      this.lastEmittedStatus.lastError === status.lastError
    ) {
      return;
    }
    this.lastEmittedStatus = status;
    for (const listener of Array.from(this.statusListeners)) {
      listener(status);
    }
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  private handleObservabilityEvent(event: AgentObservabilityUpdateEvent): void {
    if (this.disposing || this.isOff() || event.type !== 'entries') {
      return;
    }
    for (const entry of event.entries) {
      if (entry.status === 'running') {
        continue;
      }
      void this.handleTurn(entry);
    }
  }

  private async handleTurn(entry: AgentAuditEntry): Promise<void> {
    // A turn record is owned by `metadata`; the body only rides along when
    // `transcripts` is also on. If metadata is off, there is no turn row to
    // carry anything, so nothing about this turn can be uploaded.
    if (this.disposing || this.disposed) {
      return;
    }
    const { projectId, worktreeId } = entry;
    if (!projectId || !worktreeId) {
      // Only worktree-scoped turns map onto the worktree-nested contract.
      return;
    }
    const sharing = await this.effectiveSharingForWork(projectId, worktreeId);
    if (!sharing || sharing.metadata === 'off') return;
    const meta = await this.resolveWorktreeMeta(projectId, worktreeId);
    if (!meta) {
      return;
    }

    // Only pay the cost of reconstructing the transcript when transcripts are
    // opted in; otherwise the body would be discarded at flush anyway.
    const transcriptBody =
      sharing.transcripts === 'off'
        ? undefined
        : await this.loadTranscriptBody(entry);
    const payload = mapAuditEntryToTurnPayload(entry, { transcriptBody });
    if (payload === null) {
      // Desktop-only audit event types (e.g. `pr_split_planning`) are not in
      // the telemetry wire contract yet; they stay local-only.
      return;
    }
    if (payload.body !== undefined) {
      payload.contentHash = sha256(payload.body);
    }

    const target = this.ensurePending(
      projectId,
      worktreeId,
      meta,
      OWNER_ROUTED,
    );
    const memoryPolicy = await resolveLocalMemoryPolicy({
      projectId,
      worktreeId,
    });
    queueItem(
      target.turns,
      payload.clientTurnId,
      payload,
      OWNER_ROUTED,
      memoryPolicy.kind === 'blocked' ||
        (memoryPolicy.kind === 'scoped' && memoryPolicy.privateMemory),
    );
    await this.persistQueue();
    this.scheduleFlush(pendingWorktreeKey(target));
  }

  private async handlePlanChange(plan: TrackedPlanData): Promise<void> {
    if (this.disposing || this.disposed) {
      return;
    }
    const { projectId, worktreeId } = plan;
    if (!projectId || !worktreeId) {
      return;
    }
    const sharing = await this.effectiveSharingForWork(projectId, worktreeId);
    if (!sharing || sharing.plans === 'off') return;
    const meta = await this.resolveWorktreeMeta(projectId, worktreeId);
    if (!meta) {
      return;
    }
    const payload = mapTrackedPlanToPlanPayload(plan);
    if (payload.body !== undefined) {
      payload.contentHash = sha256(payload.body);
    }
    const target = this.ensurePending(
      projectId,
      worktreeId,
      meta,
      OWNER_ROUTED,
    );
    queueItem(
      target.plans,
      payload.clientPlanId,
      payload,
      OWNER_ROUTED,
      undefined,
      plan.createdAt,
    );
    await this.persistQueue();
    this.scheduleFlush(pendingWorktreeKey(target));
  }

  private async handlePrStatusChange(
    projectId: string,
    worktreeId: string,
    status: WorktreePrStatus,
  ): Promise<void> {
    // PR status is metadata-class rollup data.
    if (this.disposing || this.disposed) {
      return;
    }
    const sharing = await this.effectiveSharingForWork(projectId, worktreeId);
    if (!sharing || sharing.metadata === 'off') return;
    const payloads = mapWorktreePrStatusToPayloads(status);
    if (payloads.length === 0) {
      return;
    }
    const meta = await this.resolveWorktreeMeta(projectId, worktreeId);
    if (!meta) {
      return;
    }
    const target = this.ensurePending(
      projectId,
      worktreeId,
      meta,
      OWNER_ROUTED,
    );
    const ownerKey = worktreeKey(projectId, worktreeId);
    for (const payload of payloads) {
      if (!this.claimPullRequest(payload.prUrl, ownerKey)) {
        // The reconciliation sweep already queued this PR. Writing it here too
        // would create a second server row for one pull request.
        continue;
      }
      queueItem(
        target.pullRequests,
        pullRequestKey(payload.repoId, payload.prNumber),
        payload,
        OWNER_ROUTED,
        undefined,
        // Rediscovery is not new work. Missing creation time stays historical.
        payload.openedAt ?? '1970-01-01T00:00:00.000Z',
      );
    }
    await this.persistQueue();
    this.scheduleFlush(pendingWorktreeKey(target));
  }

  // -------------------------------------------------------------------------
  // PR reconciliation (recovers PRs the live poller could never observe)
  // -------------------------------------------------------------------------

  /**
   * Every `${repoId}#${prNumber}` this workspace has already synced, across all
   * worktrees and all owner-scope targets.
   *
   * Deliberately target-agnostic: a PR reported under one org must not be
   * re-enqueued as "missing" merely because a different context is selected.
   */
  getSyncedPullRequestKeys(projectId: string): ReadonlySet<string> {
    const keys = new Set<string>();
    const workspace = this.syncMap.workspaces[projectId];
    if (workspace) {
      for (const worktree of Object.values(workspace.worktrees)) {
        for (const target of Object.values(worktree.targets)) {
          for (const key of Object.keys(target.pullRequests)) {
            keys.add(key);
          }
        }
      }
    }
    // Include not-yet-flushed entries so two sweeps in quick succession (or a
    // sweep racing the live poller) cannot enqueue the same PR twice.
    for (const entry of Array.from(this.pending.values())) {
      if (entry.projectId !== projectId) {
        continue;
      }
      for (const item of Array.from(entry.pullRequests.values())) {
        keys.add(item.id);
      }
    }
    return keys;
  }

  /** Canonical PR URLs already synced or pending anywhere on this machine. */
  getSyncedPullRequestUrls(): ReadonlySet<string> {
    return new Set(this.claimedPullRequests.keys());
  }

  /**
   * Which owner-scope targets (sync-map target keys) the work's own route
   * reaches now: private for Personal work or a private preference, otherwise
   * the owning organization (or, for a legacy `team` preference, the owning
   * organization's current teams, exactly as flush would resolve them). Null
   * when nothing can be sent: unknown ownership, unavailable or prohibiting
   * policy, metadata sharing off, or no current team to deliver to.
   * `pendingKeys` are the targets an owner-routed pending item stands for.
   *
   * PR state tracking uses only these targets (CAN-3515). A row written
   * earlier to a target the owner route no longer reaches (a misfiled
   * private row, or another organization's row from before owner scoping) is
   * left as it is: updating it would count the work somewhere it does not
   * belong.
   */
  private async ownerRouteTargets(
    projectId: string,
    worktreeId: string,
    ownerCache: Map<string, Promise<WorkOwnerOrganization>>,
  ): Promise<{
    reaches: (targetKey: string) => boolean;
    pendingKeys: string[];
  } | null> {
    const owner = await this.governingOrgFor(
      projectId,
      worktreeId,
      null,
      ownerCache,
    );
    if (owner.kind === 'unknown') return null;
    const governingOrg =
      owner.kind === 'organization' ? owner.organizationId : null;
    if (governingOrg !== null && !this.enforcementAvailable) return null;
    const enforcement = enforcementForOrganization(
      this.enforcementByOrganization,
      governingOrg,
    );
    if (enforcement.prohibited.metadata) return null;
    const scope = mapVisibilityToShareScope(
      this.effectiveSharingFor(governingOrg).metadata,
    );
    if (scope === null) return null;
    const target = resolveTelemetryDeliveryTarget({
      preferredScope: scope,
      ownerOrganizationId: governingOrg,
      explicitOrganizationId: null,
    });
    if (target.scope === 'private') {
      return { reaches: (key) => key === 'private', pendingKeys: ['private'] };
    }
    if (target.scope === 'organization') {
      const key = `org:${target.organizationId ?? ''}`;
      return { reaches: (candidate) => candidate === key, pendingKeys: [key] };
    }
    // Legacy team scope: only the owning organization's current teams. A row
    // recorded for a team the member has since left is stale; an update would
    // land on the current teams instead and could create a row there.
    const resolution = await this.resolveScopeTargets(
      'team',
      target.organizationId,
    );
    if (resolution.kind !== 'targets') return null;
    const keys = resolution.targets.map((candidate) =>
      scopeTargetKey(candidate),
    );
    const reachable = new Set(keys);
    return { reaches: (key) => reachable.has(key), pendingKeys: keys };
  }

  /**
   * Last state sent or queued for each PR, per owner-scope target (one server
   * row each), keyed by canonical PR URL then target key (`scopeTargetKey`).
   *
   * Per target because the rows are independent: a PR sent to a private
   * target and to `org:<id>` has two rows, and a merge recorded in one says
   * nothing about the other. Within one target the most advanced entry wins
   * (e.g. the sweep's merged update beside the poller's earlier open entry).
   * An entry with no recorded state reads as `undefined` (unknown).
   *
   * Only targets the recording workspace's owner route reaches are included
   * (`ownerRouteTargets`). Owner-routed pending items overlay the target their
   * route resolves to; an explicit shared-container anchor carries no PRs.
   */
  private async recordedPullRequestTargets(
    ownerCache: Map<string, Promise<WorkOwnerOrganization>>,
  ): Promise<Map<string, Map<string, PrStateValue | undefined>>> {
    const byUrl = new Map<string, Map<string, PrStateValue | undefined>>();
    const note = (
      prUrl: string | undefined,
      targetKey: string,
      state: PrStateValue | undefined,
    ): void => {
      if (!prUrl) {
        return;
      }
      const targets =
        byUrl.get(prUrl) ?? new Map<string, PrStateValue | undefined>();
      const current = targets.get(targetKey);
      targets.set(
        targetKey,
        state === undefined ? current : mostAdvancedPrState(current, state),
      );
      byUrl.set(prUrl, targets);
    };
    for (const [projectId, workspace] of Object.entries(
      this.syncMap.workspaces,
    )) {
      for (const [worktreeId, worktree] of Object.entries(
        workspace.worktrees,
      )) {
        const route = await this.ownerRouteTargets(
          projectId,
          worktreeId,
          ownerCache,
        );
        if (!route) continue;
        for (const [targetKey, target] of Object.entries(worktree.targets)) {
          if (!route.reaches(targetKey)) continue;
          for (const ref of Object.values(target.pullRequests)) {
            note(ref.prUrl, targetKey, ref.state);
          }
        }
      }
    }
    for (const entry of Array.from(this.pending.values())) {
      if (entry.pullRequests.size === 0) continue;
      const route = await this.ownerRouteTargets(
        entry.projectId,
        entry.worktreeId,
        ownerCache,
      );
      if (!route) continue;
      for (const item of Array.from(entry.pullRequests.values())) {
        if (item.targetOrganizationId !== OWNER_ROUTED) continue;
        for (const key of route.pendingKeys) {
          note(item.value.prUrl, key, item.value.state);
        }
      }
    }
    return byUrl;
  }

  /**
   * Least advanced PR state already sent or queued, per canonical PR URL,
   * across the owner-scope targets a state update can reach. A URL with any
   * such target of unknown state is absent, which the sweep treats as unknown
   * (and so behind).
   *
   * A URL whose only rows sit on targets no owner route reaches reads as
   * `merged`: nothing a state update may touch is behind, so the sweep leaves
   * it alone instead of retrying it every run.
   */
  async getSyncedPullRequestStates(): Promise<
    ReadonlyMap<string, PrStateValue>
  > {
    const states = new Map<string, PrStateValue>();
    const recorded = await this.recordedPullRequestTargets(new Map());
    for (const [prUrl, targets] of Array.from(recorded)) {
      let least: PrStateValue | undefined;
      let unknown = false;
      for (const state of Array.from(targets.values())) {
        if (state === undefined) {
          unknown = true;
          break;
        }
        least =
          least === undefined || prStateIsBehind(state, least) ? state : least;
      }
      if (!unknown && least !== undefined) {
        states.set(prUrl, least);
      }
    }
    for (const prUrl of Array.from(this.claimedPullRequests.keys())) {
      if (!recorded.has(prUrl)) states.set(prUrl, 'merged');
    }
    return states;
  }

  /**
   * Queue PRs recovered by the sweep against the workspace's synthetic
   * reconciliation worktree.
   *
   * Uses the ordinary pending/flush machinery, so these rows inherit the same
   * sharing gate, owner routing, per-request chunking and sync-map bookkeeping
   * as live PR status changes. It is not a side channel.
   *
   * `stateUpdate` payloads re-send a newer state for PRs already sent, possibly
   * by another writer (CAN-3513). They skip the ownership claim, and do not
   * take it over: the server matches creator, PR URL and owner scope to update
   * the existing row in place rather than add one. Like all activity they are
   * routed by the work's owner (CAN-3515), so one is queued only when that
   * route reaches a recorded row for the PR whose state is behind; it never
   * creates a row, and never updates a row the owner route does not reach.
   *
   * Resolves to the PR URLs actually queued. Sharing off, unresolvable
   * metadata, a lost claim or no behind row on the owner route queue nothing
   * for that payload, which lets the sweep try another workspace or a later
   * sweep instead of dropping it.
   */
  async enqueueReconciledPullRequests(
    projectId: string,
    payloads: TelemetryPullRequestPayload[],
    options: { stateUpdate?: boolean } = {},
  ): Promise<ReadonlySet<string>> {
    const queued = new Set<string>();
    if (this.disposing || this.disposed || payloads.length === 0) {
      return queued;
    }
    await this.queueReady;
    if (!this.queueHydrated) {
      return queued;
    }
    const sharing = await this.effectiveSharingForWork(
      projectId,
      PR_RECONCILIATION_WORKTREE_ID,
    );
    if (!sharing || sharing.metadata === 'off') return queued;
    let accepted = payloads;
    if (options.stateUpdate === true) {
      const ownerCache = new Map<string, Promise<WorkOwnerOrganization>>();
      const route = await this.ownerRouteTargets(
        projectId,
        PR_RECONCILIATION_WORKTREE_ID,
        ownerCache,
      );
      if (!route) return queued;
      const recorded = await this.recordedPullRequestTargets(ownerCache);
      accepted = payloads.filter((payload) =>
        Array.from(recorded.get(payload.prUrl) ?? []).some(
          ([targetKey, state]) =>
            route.reaches(targetKey) && prStateIsBehind(state, payload.state),
        ),
      );
      if (accepted.length === 0) return queued;
    }
    const meta = await this.resolveWorktreeMeta(
      projectId,
      PR_RECONCILIATION_WORKTREE_ID,
    );
    if (!meta) {
      return queued;
    }
    const target = this.ensurePending(
      projectId,
      PR_RECONCILIATION_WORKTREE_ID,
      meta,
      OWNER_ROUTED,
    );
    const ownerKey = worktreeKey(projectId, PR_RECONCILIATION_WORKTREE_ID);
    for (const payload of accepted) {
      // A state update never claims the URL (checked first, so a legacy
      // key-only entry with no restored claim stays claimable by the poller).
      if (
        options.stateUpdate !== true &&
        !this.claimPullRequest(payload.prUrl, ownerKey)
      ) {
        // The live poller reported this PR while the sweep was querying
        // GitHub. It owns the row; drop the reconciliation copy.
        continue;
      }
      queueItem(
        target.pullRequests,
        pullRequestKey(payload.repoId, payload.prNumber),
        payload,
        OWNER_ROUTED,
        undefined,
        payload.openedAt ?? '1970-01-01T00:00:00.000Z',
      );
      queued.add(payload.prUrl);
    }
    await this.persistQueue();
    this.scheduleFlush(pendingWorktreeKey(target));
    return queued;
  }

  /**
   * Run one sweep. Safe to call at any time; overlapping calls are dropped.
   * Never throws — reconciliation is best-effort and must not take down
   * startup or the interval timer.
   */
  async runPullRequestReconciliation(): Promise<PrReconciliationResult | null> {
    if (this.prReconciliationRunning || this.disposing || this.disposed) {
      return null;
    }
    this.prReconciliationRunning = true;
    try {
      // Imported lazily: the GitHub layer pulls in the request broker (and
      // through it Electron/native deps), which must not be loaded merely by
      // constructing the sync service.
      const { listPullRequestsByViewer, listReconcilableRepos } =
        await import('../lib/github-pr-reconcile');
      return await reconcilePullRequests({
        listRepos: () => listReconcilableRepos(),
        listPullRequestsByViewer: (repo, since) =>
          listPullRequestsByViewer(repo, since),
        getSyncedPrKeys: (projectId) =>
          Promise.resolve(this.getSyncedPullRequestKeys(projectId)),
        getSyncedPrUrls: () => Promise.resolve(this.getSyncedPullRequestUrls()),
        getSyncedPrStates: () => this.getSyncedPullRequestStates(),
        enqueue: (projectId, payloads) =>
          this.enqueueReconciledPullRequests(projectId, payloads),
        enqueueStateUpdates: (projectId, payloads) =>
          this.enqueueReconciledPullRequests(projectId, payloads, {
            stateUpdate: true,
          }),
        onLog: (message, meta) => {
          logMainProcessWarn(`[telemetry-sync] ${message}`, meta ?? {});
        },
      });
    } catch (error) {
      // The sweep runs from a timer, so an throw here would be an unhandled
      // rejection that can take the process down. Logging is itself best-effort
      // for the same reason.
      try {
        logMainProcessWarn(
          '[telemetry-sync] PR reconciliation sweep failed',
          error,
        );
      } catch {
        // Logger unavailable (e.g. torn-down environment); drop the message.
      }
      return null;
    } finally {
      this.prReconciliationRunning = false;
    }
  }

  /**
   * Claim `payload` for `owner`, or report that another writer owns it.
   *
   * Synchronous by construction: callers must run this and the subsequent
   * `pullRequests.set` without awaiting in between, otherwise the atomicity the
   * claim provides is lost.
   */
  /**
   * Restore PR ownership for rows that were already flushed.
   *
   * `loadQueue` only restores claims for PRs still pending; once flushed they
   * leave the queue. Without this, a restart would drop ownership of every
   * successfully-synced PR, and the other writer could then create a second
   * server row for one pull request.
   */
  private rehydrateClaimsFromSyncMap(): void {
    for (const [projectId, workspace] of Object.entries(
      this.syncMap.workspaces,
    )) {
      for (const [worktreeId, worktree] of Object.entries(
        workspace.worktrees,
      )) {
        const ownerKey = worktreeKey(projectId, worktreeId);
        for (const target of Object.values(worktree.targets)) {
          for (const ref of Object.values(target.pullRequests)) {
            if (ref.prUrl && !this.claimedPullRequests.has(ref.prUrl)) {
              this.claimedPullRequests.set(ref.prUrl, ownerKey);
            }
          }
        }
      }
    }
  }

  private claimPullRequest(
    prUrl: string | undefined,
    ownerKey: string,
  ): boolean {
    if (!prUrl || prUrl.length === 0) {
      // No canonical identity to claim on; fall back to the existing
      // per-worktree de-duplication rather than blocking the write.
      return true;
    }
    const existing = this.claimedPullRequests.get(prUrl);
    if (existing !== undefined && existing !== ownerKey) {
      return false;
    }
    this.claimedPullRequests.set(prUrl, ownerKey);
    return true;
  }

  private async handlePipelineRunCompletion(
    projectId: string,
    worktreeId: string,
    event: PipelineRunUsageEvent,
  ): Promise<void> {
    // Pipeline-run records are metadata-class rollup data.
    if (this.disposing || this.disposed) {
      return;
    }
    const sharing = await this.effectiveSharingForWork(projectId, worktreeId);
    if (!sharing || sharing.metadata === 'off') return;
    const payload = mapPipelineRunUsageEventToPayload(event);
    if (!payload) {
      return;
    }
    const meta = await this.resolveWorktreeMeta(projectId, worktreeId);
    if (!meta) {
      return;
    }
    const target = this.ensurePending(
      projectId,
      worktreeId,
      meta,
      OWNER_ROUTED,
    );
    queueItem(
      target.pipelineRuns,
      payload.clientPipelineRunId,
      payload,
      OWNER_ROUTED,
    );
    await this.persistQueue();
    this.scheduleFlush(pendingWorktreeKey(target));
  }

  private async handleSummaryChange(
    projectId: string,
    worktreeId: string,
    summary: WorktreeSummaryData,
    snapshotId: string,
    isNewSnapshot: boolean,
  ): Promise<void> {
    // AI-written worktree recaps are governed by `summaries`, NOT `metadata`.
    // They are prose derived from the conversation, so they were split out of
    // the counters-and-identifiers `metadata` scope. (`metadata` remains a hard
    // prerequisite at flush time — the summary rides the worktree envelope —
    // but the ingress gate is the summaries scope.)
    if (this.disposing || this.disposed) {
      return;
    }
    const sharing = await this.effectiveSharingForWork(projectId, worktreeId);
    if (!sharing || sharing.summaries === 'off') return;
    const meta = await this.resolveWorktreeMeta(projectId, worktreeId);
    if (!meta) {
      return;
    }
    const text = mapWorktreeSummaryToText(summary);
    const target = this.ensurePending(
      projectId,
      worktreeId,
      meta,
      OWNER_ROUTED,
    );
    // Always refresh the latest-pointer summary text.
    queueItem(
      target.summaries,
      'summary',
      text,
      OWNER_ROUTED,
      undefined,
      summary.generatedAt,
    );
    // Only enqueue a history snapshot when the content meaningfully changed.
    // The client `snapshotId` is authoritative and makes the server append
    // idempotent, so re-syncs/debounce coalescing cannot duplicate.
    if (isNewSnapshot) {
      queueItem(
        target.summarySnapshots,
        clampId(snapshotId, MAX_TELEMETRY_CLIENT_ID_LENGTH),
        {
          clientSnapshotId: clampId(snapshotId, MAX_TELEMETRY_CLIENT_ID_LENGTH),
          generatedAt: summary.generatedAt,
          summary: text,
        },
        OWNER_ROUTED,
      );
    }
    await this.persistQueue();
    this.scheduleFlush(pendingWorktreeKey(target));
  }

  // -------------------------------------------------------------------------
  // Flush / upload
  // -------------------------------------------------------------------------

  /**
   * Debounce window for one worktree, escalated by its unbroken run of server
   * rejections. A healthy queue (`0` rejections) keeps the plain
   * {@link TELEMETRY_SYNC_DEBOUNCE_MS} cadence.
   */
  private retryDelayMs(key: string): number {
    const rejections = this.pending.get(key)?.consecutiveServerRejections ?? 0;
    if (rejections <= 0) {
      return TELEMETRY_SYNC_DEBOUNCE_MS;
    }
    const index = Math.min(
      rejections - 1,
      TELEMETRY_SYNC_RETRY_DELAYS_MS.length - 1,
    );
    return TELEMETRY_SYNC_RETRY_DELAYS_MS[index] ?? TELEMETRY_SYNC_DEBOUNCE_MS;
  }

  private scheduleFlush(key: string): void {
    // All enqueue paths (turns/plans/PR-status/summary) funnel through here
    // after mutating `pending`, so this is the single point to surface an
    // updated `pendingCount` to the renderer.
    this.emitStatus();
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      void this.flushWorktreeByKey(key);
    }, this.retryDelayMs(key));
    // Do not keep the event loop alive solely for a telemetry debounce.
    timer.unref?.();
    this.debounceTimers.set(key, timer);
  }

  /** Immediately drain every pending worktree (bypasses debounce). */
  async flushAll(): Promise<void> {
    for (const timer of Array.from(this.debounceTimers.values())) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    const keys = Array.from(this.pending.keys());
    for (const key of keys) {
      await this.flushWorktreeByKey(key);
    }
  }

  /**
   * Re-resolve a worktree's metadata (branch name, status, createdAt) and queue
   * an envelope-only sync for it.
   *
   * Content ingress (`recordTurn` and friends) refreshes metadata as a side
   * effect of enqueueing content, which covers every case except a metadata
   * edit that is itself the final action: renaming a Cowork Work Entry to carry
   * a ticket id, or marking it done. Those feed the Impact delivery track's
   * linkage and done bonuses, so they must reach the server on their own.
   *
   * No-ops when metadata sharing is off (nothing would be uploaded) or when the
   * metadata cannot be resolved.
   */
  async refreshWorktreeMetadata(
    projectId: string,
    worktreeId: string,
    /**
     * An organization the member explicitly chose, which today is only a
     * shared container's owner registering its server worktree there. Omitted
     * or `null`: routed by the work's owner, like all other activity; a
     * personal shared container registers through the private target this way.
     */
    targetOrganizationId?: string | null,
  ): Promise<void> {
    const organizationId = targetOrganizationId ?? OWNER_ROUTED;
    // Checked BEFORE the await: `dispose()` settles `queueReady`, but a service
    // constructed and disposed without ever being started would otherwise park
    // here forever.
    if (this.disposing || this.disposed) {
      return;
    }
    // Wait for the durable queue to hydrate before touching `this.pending`, so a
    // mark-done landing during startup cannot truncate the persisted queue.
    await this.queueReady;
    if (!this.queueHydrated || this.disposing || this.disposed) {
      return;
    }
    const sharing = await this.effectiveSharingForWork(projectId, worktreeId);
    if (!sharing || sharing.metadata === 'off') return;
    const meta = await this.resolveWorktreeMeta(projectId, worktreeId);
    if (!meta) {
      return;
    }
    const target = this.ensurePending(
      projectId,
      worktreeId,
      meta,
      organizationId,
    );
    queueItem(
      target.metadata,
      'metadata',
      { ...meta, dirty: true },
      organizationId,
    );
    await this.persistQueue();
    this.scheduleFlush(pendingWorktreeKey(target));
  }

  /**
   * Record that a chat entered or left a human-blocking state.
   *
   * This is the Phase 1 attention signal: the desktop knows the difference
   * between "the turn ended" and "the turn ended because it needs YOU", and
   * until now only the former reached the cloud. A `needs_input` / `blocked`
   * transition is what earns a push; `clear` is what lets a later re-block earn
   * another one.
   *
   * Gating notes:
   * - The attention STATE is envelope-shaped (ids, an enum, a timestamp) and
   *   carries no content, so it rides the existing `metadata` visibility.
   *   `metadata: 'off'` therefore yields no attention push at all, which is the
   *   correct reading of the preference rather than a new exception to it.
   * - `detail` is free text and is dropped at flush unless `transcripts`
   *   resolves to the same owner scope as `metadata` (see `doFlushWorktree`).
   *   It is scrubbed and capped here regardless, so an over-long or
   *   secret-bearing detail can never be held in the queue at all.
   *
   * Does NOT flush. The caller owns the timing — see `AttentionTracker`, which
   * holds a transition for a short grace period so a question answered at the
   * desktop never syncs a blocked state, then flushes explicitly rather than
   * trusting a debounce that a busy worktree can re-arm indefinitely.
   */
  async recordAttention(
    projectId: string,
    worktreeId: string,
    chatId: string,
    state: TelemetryAttentionState,
    reason: TelemetryAttentionReason,
    options: { since?: string; detail?: string } = {},
  ): Promise<void> {
    if (this.disposing || this.disposed) {
      return;
    }
    await this.queueReady;
    if (
      !this.queueHydrated ||
      this.disposing ||
      this.disposed ||
      chatId.length === 0
    ) {
      return;
    }
    const sharing = await this.effectiveSharingForWork(projectId, worktreeId);
    if (!sharing || sharing.metadata === 'off') return;
    const meta = await this.resolveWorktreeMeta(projectId, worktreeId);
    if (!meta) {
      return;
    }
    const target = this.ensurePending(
      projectId,
      worktreeId,
      meta,
      OWNER_ROUTED,
    );
    const clampedChatId = clampId(chatId, MAX_TELEMETRY_CLIENT_ID_LENGTH);
    // A `clear` never carries context — there is no push to compose from it,
    // only a state reset that re-arms the next block's eligibility to notify.
    const detail =
      state === 'clear'
        ? undefined
        : buildTelemetryAttentionDetail(options.detail);
    // Last-write-wins per chat: exactly one live state per (worktree, chat),
    // matching the server's unique on the same pair. A block superseded before
    // it flushes is simply never sent.
    queueItem(
      target.attention,
      clampedChatId,
      {
        clientChatId: clampedChatId,
        state,
        reason,
        since: options.since ?? new Date().toISOString(),
        ...(detail !== undefined ? { detail } : {}),
      },
      OWNER_ROUTED,
    );
    await this.persistQueue();
    this.scheduleFlush(pendingWorktreeKey(target));
  }

  /**
   * Record coarse human presence in a worktree (last renderer interaction).
   *
   * Cheap and synchronous at the IPC boundary: the renderer reports a
   * throttled heartbeat, this stamps the latest value immediately, and the
   * existing envelope-only metadata path uploads it on the normal debounce.
   * That upload is required even after the final turn drained; otherwise
   * activity during the completion settle window would remain local forever.
   *
   * Desktop liveness is NOT presence — the app is almost always running — so
   * this is the only signal the server may use to conclude a human was at the
   * machine.
   */
  recordUserActivity(
    projectId: string,
    worktreeId: string,
    at: string = new Date().toISOString(),
  ): void {
    if (this.disposing || this.disposed) {
      return;
    }
    if (projectId.length === 0 || worktreeId.length === 0) {
      return;
    }
    void this.recordUserActivityFor(projectId, worktreeId, at);
  }

  private async recordUserActivityFor(
    projectId: string,
    worktreeId: string,
    at: string,
  ): Promise<void> {
    const sharing = await this.effectiveSharingForWork(projectId, worktreeId);
    if (!sharing || sharing.metadata === 'off') return;
    const key = worktreeKey(projectId, worktreeId);
    const existing = this.userActivity.get(key);
    if (existing !== undefined && existing >= at) return;
    this.userActivity.set(key, at);
    // Presence is best-effort telemetry, and this method is the synchronous
    // target of fire-and-forget IPC. Reuse the durable metadata refresh path so
    // shutdown drains and ordinary retry behavior apply without surfacing an
    // unhandled rejection to Electron.
    void this.refreshWorktreeMetadata(projectId, worktreeId).catch(
      () => undefined,
    );
  }

  /** Immediately drain a single worktree (bypasses debounce). */
  async flushWorktreeNow(projectId: string, worktreeId: string): Promise<void> {
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (entry.projectId !== projectId || entry.worktreeId !== worktreeId)
        continue;
      const timer = this.debounceTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.debounceTimers.delete(key);
      }
      await this.flushWorktreeByKey(key);
    }
  }

  /**
   * Resolve the server telemetry worktree used as a shared-container anchor.
   * This probe is deliberately read-only: opening or cancelling an invite
   * must not freeze a fallback target before a grant actually exists.
   *
   * `organizationId` absent means a personal container. Its server worktree
   * must be user-owned, so only the `private` target is a candidate; its
   * anchor is stored under the personal owner key.
   */
  resolveServerWorktreeExternalId(
    projectId: string,
    worktreeId: string,
    organizationId: string | undefined,
    selectedOrganizationTeamIds: readonly string[] = [],
  ): string | null {
    const anchorKey = sharedContainerOwnerKey(organizationId);
    const worktree = this.syncMap.workspaces[projectId]?.worktrees[worktreeId];
    const existingAnchor = worktree?.sharedContainerAnchors?.[anchorKey];
    if (existingAnchor) return existingAnchor;
    const targets = worktree?.targets;
    const anchorsReservedByOtherOrganizations = new Set(
      Object.entries(worktree?.sharedContainerAnchors ?? {})
        .filter(([candidateAnchorKey]) => candidateAnchorKey !== anchorKey)
        .map(([, externalId]) => externalId),
    );
    const selectedTeamExternalId =
      organizationId === undefined
        ? undefined
        : [...selectedOrganizationTeamIds]
            .sort()
            .map((teamId) => targets?.[`team:${teamId}`]?.externalId)
            .find(
              (externalId): externalId is string =>
                typeof externalId === 'string' &&
                !anchorsReservedByOtherOrganizations.has(externalId),
            );
    const resolved = [
      organizationId === undefined
        ? undefined
        : targets?.[`org:${organizationId}`]?.externalId,
      selectedTeamExternalId,
      targets?.private?.externalId,
    ].find(
      (externalId): externalId is string =>
        typeof externalId === 'string' &&
        !anchorsReservedByOtherOrganizations.has(externalId),
    );
    return resolved ?? null;
  }

  /**
   * Reverse of {@link resolveServerWorktreeExternalId}: the whole
   * `serverWorktreeExternalId -> local (projectId, worktreeId)` map for one
   * organization, built in a single pass.
   *
   * This is the only supported form of the reverse mapping. Callers resolve a
   * page of server containers at once, so they build this once and look up
   * from it. The owned-target listing pages up to
   * `MAX_OWNED_TARGET_PAGE_SIZE * MAX_OWNED_TARGET_MAX_PAGES` containers per
   * organization and runs for every organization during startup hydration, all
   * on the Electron main thread; a per-container scan made that
   * O(worktrees x containers), while one index makes it
   * O(worktrees + containers). Do not "simplify" this back into a scan per
   * container, and do not reintroduce a single-lookup wrapper that rebuilds
   * the whole index to answer one id.
   *
   * Only frozen `sharedContainerAnchors` are indexed, never the mutable
   * `targets` map. An anchor is the identity a grant was actually created
   * against, so matching it is exact, while matching a target would let
   * ordinary telemetry scope churn attribute someone else's container to a
   * local worktree. An id that is absent from the returned map is "not ours",
   * which the caller must treat as a skip rather than as an error.
   *
   * Tie-break: if two local worktrees somehow anchored the same external id
   * for the same organization, the first in workspace-then-worktree insertion
   * order wins - which is why an existing key is never overwritten. That is
   * exactly what a linear first-match scan over the same object graph returned.
   */
  buildLocalWorktreeIndexByServerExternalId(
    organizationId: string | undefined,
  ): ReadonlyMap<string, { projectId: string; worktreeId: string }> {
    const anchorKey = sharedContainerOwnerKey(organizationId);
    const index = new Map<string, { projectId: string; worktreeId: string }>();
    for (const [projectId, workspace] of Object.entries(
      this.syncMap.workspaces,
    )) {
      for (const [worktreeId, worktree] of Object.entries(
        workspace.worktrees,
      )) {
        const anchor = worktree.sharedContainerAnchors?.[anchorKey];
        if (anchor === undefined || index.has(anchor)) continue;
        index.set(anchor, { projectId, worktreeId });
      }
    }
    return index;
  }

  /**
   * Identify a permanent cross-organization anchor conflict after normal
   * resolution has exhausted every eligible target. Returns null whenever the
   * selected organization already owns an anchor or any candidate remains
   * available, so callers do not mislabel ordinary sync lag as a conflict.
   */
  resolveSharedContainerAnchorConflictOrganizationId(
    projectId: string,
    worktreeId: string,
    organizationId: string | undefined,
    selectedOrganizationTeamIds: readonly string[] = [],
  ): string | null {
    const anchorKey = sharedContainerOwnerKey(organizationId);
    const worktree = this.syncMap.workspaces[projectId]?.worktrees[worktreeId];
    if (!worktree || worktree.sharedContainerAnchors?.[anchorKey]) {
      return null;
    }
    const candidates = (
      organizationId === undefined
        ? [worktree.targets?.private?.externalId]
        : [
            worktree.targets?.[`org:${organizationId}`]?.externalId,
            ...[...selectedOrganizationTeamIds]
              .sort()
              .map(
                (teamId) => worktree.targets?.[`team:${teamId}`]?.externalId,
              ),
            worktree.targets?.private?.externalId,
          ]
    ).filter((externalId): externalId is string => Boolean(externalId));
    if (candidates.length === 0) return null;

    const anchorsByExternalId = new Map(
      Object.entries(worktree.sharedContainerAnchors ?? {})
        .filter(([candidateAnchorKey]) => candidateAnchorKey !== anchorKey)
        .map(([candidateOrganizationId, externalId]) => [
          externalId,
          candidateOrganizationId,
        ]),
    );
    if (candidates.some((externalId) => !anchorsByExternalId.has(externalId))) {
      return null;
    }
    return anchorsByExternalId.get(candidates[0]) ?? null;
  }

  /**
   * Durably reserve the target immediately before creating a remote grant.
   * Opening/cancelling remains read-only, while a process crash after this
   * write can no longer strand a successful remote grant under a lost target.
   */
  async reserveSharedContainerAnchor(
    projectId: string,
    worktreeId: string,
    organizationId: string | undefined,
    externalId: string,
  ): Promise<boolean> {
    const anchorKey = sharedContainerOwnerKey(organizationId);
    const reservationKey = JSON.stringify([projectId, worktreeId, anchorKey]);
    // A failed writer rolls its optimistic in-memory anchor back. Later callers
    // must wait for that outcome before deciding an anchor already exists;
    // otherwise they can proceed to the remote mutation against an anchor that
    // was never durably saved.
    while (this.sharedContainerAnchorReservations.has(reservationKey)) {
      try {
        await this.sharedContainerAnchorReservations.get(reservationKey);
      } catch {
        // The waiting caller gets its own persistence attempt below.
      }
    }
    const reservation = this.persistSharedContainerAnchorReservation(
      projectId,
      worktreeId,
      anchorKey,
      externalId,
    );
    this.sharedContainerAnchorReservations.set(reservationKey, reservation);
    try {
      return await reservation;
    } finally {
      if (
        this.sharedContainerAnchorReservations.get(reservationKey) ===
        reservation
      ) {
        this.sharedContainerAnchorReservations.delete(reservationKey);
      }
    }
  }

  private async persistSharedContainerAnchorReservation(
    projectId: string,
    worktreeId: string,
    anchorKey: string,
    externalId: string,
  ): Promise<boolean> {
    const worktree = this.syncMap.workspaces[projectId]?.worktrees[worktreeId];
    if (!worktree) {
      throw new Error('Cannot persist an anchor for an unknown worktree.');
    }
    if (worktree.sharedContainerAnchors?.[anchorKey]) return false;
    if (
      Object.entries(worktree.sharedContainerAnchors ?? {}).some(
        ([candidateAnchorKey, candidateExternalId]) =>
          candidateAnchorKey !== anchorKey &&
          candidateExternalId === externalId,
      )
    ) {
      throw new Error(
        'Cannot persist an anchor already reserved by another organization.',
      );
    }
    const isKnownTarget = Object.values(worktree.targets).some(
      (target) => target.externalId === externalId,
    );
    if (!isKnownTarget) {
      throw new Error('Cannot persist an anchor for an unknown sync target.');
    }
    const hadAnchors = worktree.sharedContainerAnchors !== undefined;
    worktree.sharedContainerAnchors ??= {};
    worktree.sharedContainerAnchors[anchorKey] = externalId;
    try {
      await this.saveSyncMap();
    } catch (error) {
      delete worktree.sharedContainerAnchors[anchorKey];
      if (
        !hadAnchors &&
        Object.keys(worktree.sharedContainerAnchors).length === 0
      ) {
        delete worktree.sharedContainerAnchors;
      }
      throw error;
    }
    return true;
  }

  /** Release a reservation after the remote grant is known not to exist. */
  async releaseSharedContainerAnchor(
    projectId: string,
    worktreeId: string,
    organizationId: string | undefined,
    externalId: string,
  ): Promise<void> {
    const anchorKey = sharedContainerOwnerKey(organizationId);
    const worktree = this.syncMap.workspaces[projectId]?.worktrees[worktreeId];
    const anchors = worktree?.sharedContainerAnchors;
    if (!worktree || anchors?.[anchorKey] !== externalId) return;
    delete anchors[anchorKey];
    if (Object.keys(anchors).length === 0) {
      delete worktree.sharedContainerAnchors;
    }
    try {
      await this.saveSyncMap();
    } catch (error) {
      worktree.sharedContainerAnchors ??= {};
      worktree.sharedContainerAnchors[anchorKey] = externalId;
      throw error;
    }
  }

  /**
   * Owner keys (organization ids, or the personal owner key) that already
   * anchor a shared container for this worktree, in the order they were
   * first reserved. The first shared container fixes a worktree's owner, so
   * eligibility reads this before offering an organization picker.
   */
  listSharedContainerAnchorKeys(
    projectId: string,
    worktreeId: string,
  ): string[] {
    return Object.keys(
      this.syncMap.workspaces[projectId]?.worktrees[worktreeId]
        ?.sharedContainerAnchors ?? {},
    );
  }

  /**
   * Drain a worktree's pending telemetry before its local data is purged, then
   * drop the worktree from the queue and sync-map.
   */
  async drainWorktreeForDeletion(
    projectId: string,
    worktreeId: string,
  ): Promise<void> {
    await this.flushWorktreeNow(projectId, worktreeId);
    let removedPending = false;
    for (const [key, entry] of Array.from(this.pending.entries())) {
      if (entry.projectId !== projectId || entry.worktreeId !== worktreeId)
        continue;
      removedPending = this.pending.delete(key) || removedPending;
      const timer = this.debounceTimers.get(key);
      if (timer) clearTimeout(timer);
      this.debounceTimers.delete(key);
    }
    const workspace = this.syncMap.workspaces[projectId];
    let removedFromMap = false;
    if (workspace && workspace.worktrees[worktreeId]) {
      delete workspace.worktrees[worktreeId];
      removedFromMap = true;
    }
    if (removedPending) {
      await this.persistQueue();
    }
    if (removedFromMap) {
      await this.saveSyncMap();
    }
    if (removedPending) {
      // Dropped items change pendingCount.
      this.emitStatus();
    }
  }

  private flushWorktreeByKey(key: string): Promise<void> {
    // Serialize uploads so the queue/sync-map mutate one worktree at a time.
    const run = this.flushChain.then(() => this.doFlushWorktree(key));
    this.flushChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doFlushWorktree(key: string): Promise<void> {
    // One confirmation slot for this flush, shared by every group it processes
    // and discarded when it returns. See `confirmLapseWithFreshSnapshot` for
    // why deletion authority must not outlive the flush that earned it.
    const lapseConfirmation: LapseConfirmationCache = { confirmed: false };

    if (this.isOff()) {
      return;
    }
    const entry = this.pending.get(key);
    if (!entry) {
      return;
    }

    const ownerCache = new Map<string, Promise<WorkOwnerOrganization>>();
    const routes = new Map<PendingItem<unknown>, ItemRoute | null>();
    const policyAllowedMetadata = new Set<PendingItem<unknown>>();
    const routeFor = async (
      collection: TelemetryCollection,
      item: PendingItem<unknown>,
    ): Promise<ItemRoute | null> => {
      // Ownership alone picks the organization; the sidebar is not consulted.
      const owner = await this.governingOrgFor(
        entry.projectId,
        entry.worktreeId,
        null,
        ownerCache,
      );
      if (owner.kind === 'unknown') return null;
      const governingOrg =
        owner.kind === 'organization' ? owner.organizationId : null;
      if (governingOrg !== null && !this.enforcementAvailable) return null;
      const enforcement = enforcementForOrganization(
        this.enforcementByOrganization,
        governingOrg,
      );
      // The envelope is metadata, so an org metadata prohibition blocks every
      // collection for that org, including otherwise-independent plans.
      if (enforcement.prohibited.metadata) return null;
      // A saved metadata `off` preference can suppress the metadata collection
      // without making its snapshot unsafe as an envelope for an independently
      // enabled collection such as plans.
      if (collection === 'metadata') policyAllowedMetadata.add(item);
      const value = item.value;
      // Turn/snapshot producer timestamps keep later retries of historical
      // content behind the original consent boundary. Legacy queue items with
      // no capture timestamp are historical, never inferred to be new work.
      const producedAt =
        typeof value === 'object' && value !== null
          ? 'startedAt' in value && typeof value.startedAt === 'string'
            ? value.startedAt
            : 'generatedAt' in value && typeof value.generatedAt === 'string'
              ? value.generatedAt
              : collection === 'metadata' && 'prNumber' in value
                ? 'openedAt' in value && typeof value.openedAt === 'string'
                  ? value.openedAt
                  : '1970-01-01T00:00:00.000Z'
                : undefined
          : undefined;
      const capturedAt =
        item.capturedAt &&
        (!producedAt || Date.parse(item.capturedAt) < Date.parse(producedAt))
          ? item.capturedAt
          : (producedAt ?? '1970-01-01T00:00:00.000Z');
      const historical = capTelemetrySharingToConsentHistory(
        this.sharing,
        this.optInHistory,
        capturedAt,
      );
      const sharing = resolveEffectiveTelemetrySharing(historical, enforcement);
      const metadataScope = mapVisibilityToShareScope(sharing.metadata);
      const scope =
        collection === 'plans'
          ? mapVisibilityToShareScope(sharing.plans)
          : metadataScope;
      if (scope === null) return null;
      if (
        (collection === 'summaries' || collection === 'summarySnapshots') &&
        mapVisibilityToShareScope(sharing.summaries) !== metadataScope
      ) {
        return null;
      }
      // Compared at preference level: a body rides only when transcripts and
      // metadata were chosen for the same audience, even if both then land
      // privately because the work is Personal.
      const includeBody =
        mapVisibilityToShareScope(sharing.transcripts) === metadataScope;
      const target = resolveTelemetryDeliveryTarget({
        preferredScope: scope,
        ownerOrganizationId: governingOrg,
        explicitOrganizationId: item.targetOrganizationId,
      });
      const routeKey = deliveryRouteKey(target);
      // Presence is metadata-class: it rides only the route the work's own
      // metadata goes to, never a route only plans are shared with, and never
      // a shared-container anchor outside the owner.
      const metadataRouteKey =
        metadataScope === null
          ? null
          : deliveryRouteKey(
              resolveTelemetryDeliveryTarget({
                preferredScope: metadataScope,
                ownerOrganizationId: governingOrg,
                explicitOrganizationId: null,
              }),
            );
      return {
        scope: target.scope,
        organizationId: target.organizationId,
        carriesPresence: target.ownerRoute && routeKey === metadataRouteKey,
        includeBody,
        routeKey,
      };
    };

    const collections: Array<
      [TelemetryCollection, Map<string, PendingItem<unknown>>]
    > = [
      ['metadata', entry.metadata],
      ['turns', entry.turns],
      ['plans', entry.plans],
      ['pullRequests', entry.pullRequests],
      ['pipelineRuns', entry.pipelineRuns],
      ['summaries', entry.summaries],
      ['summarySnapshots', entry.summarySnapshots],
      ['attention', entry.attention],
    ];
    for (const [collection, items] of collections) {
      for (const item of Array.from(items.values())) {
        routes.set(item, await routeFor(collection, item));
      }
    }
    const safeEnvelopeMetadata = Array.from(entry.metadata.values()).filter(
      (item) => policyAllowedMetadata.has(item),
    );

    // Policy and ownership are re-evaluated at delivery. Items that no longer
    // have an allowed route are terminal and leave the durable queue.
    for (const [, items] of collections) {
      for (const [itemKey, item] of Array.from(items)) {
        if (routes.get(item) === null) items.delete(itemKey);
      }
    }

    const selectRouted = <T>(
      items: Map<string, PendingItem<T>>,
      routeKey: string,
    ): PendingItem<T>[] => {
      const selected = new Map<string, PendingItem<T>>();
      for (const item of Array.from(items.values())) {
        const route = routes.get(item);
        if (!route || route.routeKey !== routeKey) continue;
        const previous = selected.get(item.id);
        if (previous) {
          items.delete(
            pendingItemKey(previous.id, previous.targetOrganizationId),
          );
          selected.delete(item.id);
        }
        selected.set(item.id, item);
      }
      return Array.from(selected.values());
    };

    const groupRoutes = new Map<string, ItemRoute>();
    for (const route of Array.from(routes.values())) {
      if (route) groupRoutes.set(route.routeKey, route);
    }

    const groups: FlushGroup[] = [];
    for (const [routeKey, route] of Array.from(groupRoutes)) {
      const turns = selectRouted(entry.turns, routeKey);
      const plans = selectRouted(entry.plans, routeKey).slice(
        0,
        MAX_TELEMETRY_PLANS_PER_WORKTREE,
      );
      const prs = selectRouted(entry.pullRequests, routeKey).slice(
        0,
        MAX_TELEMETRY_PULL_REQUESTS_PER_WORKTREE,
      );
      const runs = selectRouted(entry.pipelineRuns, routeKey).slice(
        0,
        MAX_TELEMETRY_PIPELINE_RUNS_PER_WORKTREE,
      );
      const summaries = selectRouted(entry.summarySnapshots, routeKey).slice(
        0,
        MAX_TELEMETRY_SUMMARIES_PER_WORKTREE,
      );
      const latestSummary = selectRouted(entry.summaries, routeKey);
      const attention = selectRouted(entry.attention, routeKey).slice(
        0,
        MAX_TELEMETRY_ATTENTION_PER_REQUEST,
      );
      const metadata = selectRouted(entry.metadata, routeKey);
      // Every metadata item describes the same worktree, so any one whose
      // owner policy allows an envelope can carry this route's content.
      const fallbackMetadata = safeEnvelopeMetadata;
      const meta =
        metadata[metadata.length - 1]?.value ??
        fallbackMetadata[fallbackMetadata.length - 1]?.value;
      if (!meta) continue;
      const buildGroup = (
        selectedTurns: PendingItem<TelemetryTurnPayload>[],
        includeOther: boolean,
        memoryExcluded: boolean,
      ): FlushGroup => ({
        memoryExcluded,
        routeKey,
        shareScope: route.scope,
        organizationId: route.scope === 'private' ? null : route.organizationId,
        carriesPresence: route.carriesPresence,
        meta,
        metaDirty: includeOther && metadata.some((item) => item.value.dirty),
        turns: selectedTurns.map((item) =>
          routes.get(item)?.includeBody
            ? item.value
            : stripTurnBody(item.value),
        ),
        plans: includeOther ? plans.map(({ value }) => value) : [],
        pullRequests: includeOther ? prs.map(({ value }) => value) : [],
        pipelineRuns: includeOther ? runs.map(({ value }) => value) : [],
        summaries: includeOther ? summaries.map(({ value }) => value) : [],
        summary: includeOther
          ? latestSummary[latestSummary.length - 1]?.value
          : undefined,
        attention: (includeOther ? attention : []).map((item) =>
          buildTelemetryAttention({
            clientChatId: item.value.clientChatId,
            clientWorktreeId: entry.worktreeId,
            state: item.value.state,
            reason: item.value.reason,
            since: item.value.since,
            ...(routes.get(item)?.includeBody && item.value.detail !== undefined
              ? { detail: item.value.detail }
              : {}),
          }),
        ),
        drop: (): void => {
          dropItems(entry.turns, selectedTurns);
          if (!includeOther) return;
          dropItems(entry.plans, plans);
          dropItems(entry.pullRequests, prs);
          dropItems(entry.pipelineRuns, runs);
          dropItems(entry.summarySnapshots, summaries);
          dropItems(entry.summaries, latestSummary);
          dropItems(entry.attention, attention);
          for (const item of metadata) {
            const current = entry.metadata.get(
              pendingItemKey(item.id, item.targetOrganizationId),
            );
            if (current === item) current.value.dirty = undefined;
          }
        },
      });
      const excludedTurns = turns.filter(
        (item) => item.memoryExcluded === true,
      );
      if (excludedTurns.length > 0 && excludedTurns.length < turns.length) {
        groups.push(
          buildGroup(
            turns.filter((item) => item.memoryExcluded !== true),
            true,
            false,
          ),
          buildGroup(excludedTurns, false, true),
        );
      } else {
        groups.push(buildGroup(turns, true, excludedTurns.length > 0));
      }
    }

    // We hold content destined for at least one scope, so we are committing to
    // a network upload attempt: flip the spinner on (transition-only emit).
    this.setSyncing(true);
    let deferred = false;
    // Every group exit uses the same scope/context boundary for cleanup and
    // scheduling. Terminal policy refusals cover the entire queue, whereas a
    // delivered or poisoned request only consumes its captured, capped batch.
    const finishGroup = (
      group: FlushGroup,
      outcome: 'terminal' | 'batch' | 'retain',
    ): void => {
      const matches = (item: PendingItem<unknown>): boolean =>
        routes.get(item)?.routeKey === group.routeKey;
      if (outcome === 'terminal') {
        for (const [, items] of collections) {
          for (const [itemKey, item] of Array.from(items)) {
            if (matches(item)) items.delete(itemKey);
          }
        }
      } else {
        if (outcome === 'batch') group.drop();
        // Disabled scopes do not keep the debounce alive; capped leftovers
        // and replacements enqueued during delivery do.
        deferred ||= collections.some(([, items]) =>
          Array.from(items.values()).some(matches),
        );
      }
    };
    let syncMapDirty = false;
    // Track upload outcomes across all scopes/targets in this flush. Clearing the
    // error banner inside the loop on one success would erase a sibling's
    // failure, so we only clear after the loop when at least one upload succeeded
    // and none failed.
    let uploadSucceeded = false;
    let uploadFailed = false;
    // A fan-out flush can hit the same outage once per target; the abandon
    // threshold is meant to count FLUSH ATTEMPTS, so the run advances at most
    // once per flush no matter how many targets refused.
    let serverRejectionCounted = false;
    /**
     * Advance (or start) this worktree's server-rejection run and report the
     * new count. Only a real 5xx response reaches here — see
     * {@link PendingWorktree.consecutiveServerRejections}.
     */
    const noteServerRejection = (): number => {
      if (serverRejectionCounted) {
        return entry.consecutiveServerRejections ?? 0;
      }
      serverRejectionCounted = true;
      entry.consecutiveServerRejections =
        (entry.consecutiveServerRejections ?? 0) + 1;
      entry.firstRejectionAt =
        entry.firstRejectionAt ?? new Date().toISOString();
      return entry.consecutiveServerRejections;
    };
    try {
      for (const group of groups) {
        // Routing already resolved the destination from the work's owner.
        const deliveryScope = group.shareScope;
        // A metadata-only refresh (Work Entry renamed or marked done, with no
        // subsequent turn) carries no collection items but must still send its
        // worktree envelope, so it is exempt from the empty-group skip.
        // `splitTelemetryIngestRequest` always emits at least one
        // (possibly envelope-only) piece, so the envelope does reach the server.
        const envelopeOnlyMetaSync =
          group.metaDirty || (group.attention?.length ?? 0) > 0;
        if (
          group.turns.length === 0 &&
          group.plans.length === 0 &&
          group.pullRequests.length === 0 &&
          group.pipelineRuns.length === 0 &&
          group.summaries.length === 0 &&
          group.summary === undefined &&
          !envelopeOnlyMetaSync
        ) {
          finishGroup(group, 'retain');
          continue;
        }

        // Private resolves to the current user; organization and team resolve
        // within the destination organization (the work's owner, or a shared
        // container's explicit anchor). Missing credentials or membership make
        // a destination unavailable. Keep those items queued for a later
        // attempt — this is NOT an upload error (the renderer already shows
        // "disconnected").
        // CAN-3296 supersedes D25's private-only restriction: tracked sources
        // may reach private and owner-organization targets. Team resolution
        // below only includes teams belonging to that organization. Unknown
        // ownership still uploads nothing, even privately, to avoid losing
        // source provenance. Decide exclusions before resolving credentials so
        // cross-org groups are terminal even while offline or signed out.
        const owner = await this.loadWorkspaceOwner(entry.projectId);
        const ownershipAllowsDelivery =
          owner.kind === 'personal' ||
          (owner.kind === 'organization' &&
            (deliveryScope === 'private' ||
              group.organizationId === owner.binding.organizationId));
        if (!ownershipAllowsDelivery) {
          getObservabilityService().recordSessionDiagnostic({
            version: 1,
            timestamp: new Date().toISOString(),
            kind:
              owner.kind === 'unknown'
                ? 'telemetry_target_dropped_ownership_unknown'
                : 'telemetry_target_dropped_cross_org',
            sessionKey: key,
            projectId: entry.projectId,
            worktreeId: entry.worktreeId,
            chatId: '',
            providerType: 'unknown',
          });
          // Nothing to deliver for this scope, and nothing to keep queued.
          finishGroup(group, 'terminal');
          continue;
        }

        const resolution = await this.resolveScopeTargets(
          deliveryScope,
          group.organizationId,
        );
        // Every destination for this scope is gated (CAN-2311). Unlike an
        // unavailable scope this cannot come back on its own, so deferring
        // forever would queue these items indefinitely. Dropping is also what
        // makes the gate honest: a lapsed org must not receive this data later
        // either, and retaining it only to backfill on restore would deliver
        // exactly what the lapse withheld.
        //
        // But CONFIRM AGAINST A FRESH SNAPSHOT FIRST, and confirm it PROPERLY.
        // This verdict is read from the persisted account snapshot, which the
        // background probe refreshes only every ~20 minutes. Deleting off a
        // stale snapshot destroys telemetry for a window in which the org had
        // ALREADY paid — an unrecoverable loss caused purely by local
        // staleness, where the pre-CAN-2311 behavior was merely to defer.
        //
        // "Attempted a probe" is NOT confirmation: the probe no-ops (leaving
        // `orgBillingStates` untouched) when there is no API key, when it
        // throws because the client is offline, when the response is
        // unauthenticated, and when the response omits the field. So the probe
        // is AWAITED and must REPORT that it refreshed per-org billing state
        // before anything may be deleted; otherwise this defers, which is the
        // safe direction. The verdict is then re-resolved against the refreshed
        // snapshot rather than reusing the stale one that got us here.
        //
        // CONFIRM ON ANY LAPSE VERDICT, not just an all-lapsed one. A group
        // leaves the queue once every target in `targets` has stored it, so a
        // PARTIAL fan-out (one lapsed org, one healthy org) reports success and
        // deletes the group having never delivered to the filtered org. If that
        // org had already renewed, the data is gone — the same unrecoverable,
        // purely-local-staleness loss the all-lapsed branch exists to prevent,
        // reached through a verdict that branch does not cover.
        let effective = resolution;
        if (
          resolution.kind === 'all-lapsed' ||
          (resolution.kind === 'targets' && resolution.filteredLapsed)
        ) {
          const refreshed =
            await this.confirmLapseWithFreshSnapshot(lapseConfirmation);
          if (!refreshed) {
            // Defer the WHOLE group rather than delivering to the healthy
            // subset: delivering is what makes the drop fire, and we cannot yet
            // prove the filtered targets are genuinely lapsed. Nothing is lost
            // by waiting — this is the same safe direction `unavailable` takes,
            // and an old server that never sends the field never reaches here
            // (unknown ⇒ entitled ⇒ nothing filtered), so this cannot wedge.
            finishGroup(group, 'retain');
            continue;
          }
          effective = await this.resolveScopeTargets(
            deliveryScope,
            group.organizationId,
          );
        }
        if (effective.kind === 'all-lapsed' || effective.kind === 'excluded') {
          // Defensive unresolved-context exclusion, or confirmed lapse against a
          // fresh snapshot: no matching item can be delivered, including those
          // beyond this request's cap. These policy refusals must not accumulate.
          finishGroup(group, 'terminal');
          continue;
        }
        if (effective.kind === 'unavailable') {
          finishGroup(group, 'retain');
          continue;
        }
        const targets = effective.targets;

        // A group's items may only leave the queue once EVERY target has stored
        // them. If one target fails, the items stay queued and the next flush
        // re-sends to all targets; targets that already succeeded short-circuit
        // the body cheaply and the server upserts idempotently.
        // A `targets` resolution never carries an empty list, so the optimistic
        // default is only tested after at least one target has been attempted.
        let groupFullyDelivered = true;
        let groupPoisoned = false;
        // Notification provenance is the same for every target, so it is
        // resolved once per group. Loaded lazily: the OAuth module pulls in
        // brand and window wiring the sync service otherwise never needs.
        const notificationProducerId =
          await import('../canopy-cloud/oauth-login')
            .then(({ getDesktopOAuthClientDeviceId }) =>
              getDesktopOAuthClientDeviceId(),
            )
            .then(spaceNotificationProducerId)
            .catch(() => null);
        const notificationScope = await resolveSpaceNotificationScope({
          projectId: entry.projectId,
          worktreeId: entry.worktreeId,
        }).catch(() => null);

        for (const target of targets) {
          const targetKey = scopeTargetKey(target);
          const syncTarget =
            this.syncMap.workspaces[entry.projectId]?.worktrees[
              entry.worktreeId
            ]?.targets[targetKey];
          let clientIdVariant = syncTarget?.clientIdVariant;

          // Drop the body for turns/plans this target already stored unchanged.
          // Applied per target so a newly selected org gets full bodies
          // even when a previous target already has them.
          const targetTurns = group.turns.map((turn) =>
            this.applyTurnContentHashShortCircuit(turn, syncTarget),
          );
          const targetPlans = group.plans.map((plan) =>
            this.applyPlanContentHashShortCircuit(plan, syncTarget),
          );
          // Summaries are idempotent by `clientSnapshotId`; skip any this target
          // has already recorded so re-syncs don't re-send stored snapshots.
          const targetSummaries = group.summaries.filter(
            (snapshot) =>
              syncTarget?.summaries?.[snapshot.clientSnapshotId] === undefined,
          );

          // Assemble ONE full request for this target, then byte-aware split it
          // into pieces each under MAX_TELEMETRY_INGEST_BATCH_BYTES (and under
          // every per-request count cap). Each piece re-sends the same
          // workspace/worktree envelope, so the server appends every collection
          // across pieces idempotently by stable client id — a later piece may
          // carry non-turn collections (plans, PRs, pipeline runs, summaries),
          // not just turns. `splitTelemetryIngestRequest` always emits at least
          // one (possibly envelope-only) piece so a metadata/summary-only group
          // still sends. Mirrors the shareable-run ingest path
          // (`ingestSessionForShare`).
          const currentMemoryPolicy = await resolveLocalMemoryPolicy({
            projectId: entry.projectId,
            worktreeId: entry.worktreeId,
          });
          const memoryExcluded =
            group.memoryExcluded ||
            currentMemoryPolicy.kind === 'blocked' ||
            (currentMemoryPolicy.kind === 'scoped' &&
              currentMemoryPolicy.privateMemory);
          const buildPieces = (): TelemetryIngestRequest[] =>
            splitTelemetryIngestRequest(
              this.buildRequest(
                { ...entry, ...group.meta },
                targetTurns,
                targetPlans,
                group.pullRequests,
                group.pipelineRuns,
                group.summary,
                targetSummaries,
                target,
                group.attention ?? [],
                owner.kind === 'organization' ? owner.binding : undefined,
                group.carriesPresence,
                clientIdVariant,
                memoryExcluded,
                notificationProducerId,
                notificationScope,
              ),
              MAX_TELEMETRY_INGEST_BATCH_BYTES,
            );
          let pieces = buildPieces();
          let pieceIndex = 0;

          while (pieceIndex < pieces.length) {
            const request = pieces[pieceIndex];
            let response: TelemetryIngestResponse;
            try {
              response = await requestCanopyCloudJson<TelemetryIngestResponse>(
                `/api/v1/${BRAND.web.apiNamespace}/telemetry/ingest`,
                { method: 'POST', body: JSON.stringify(request) },
              );
            } catch (error) {
              const status =
                error instanceof CanopyCloudClientError
                  ? error.status
                  : undefined;
              const serverCode =
                error instanceof CanopyCloudClientError
                  ? error.serverCode
                  : undefined;
              const message =
                error instanceof Error ? error.message : String(error);

              // Surface every rejection as a triageable diagnostic so a future
              // failure is visible instead of an infinite silent retry. No
              // worktree id is recorded here, honoring the app-diagnostics
              // boundary; the share scope plus server message are enough to
              // triage.
              getObservabilityService().recordAppDiagnostic({
                version: 1,
                timestamp: new Date().toISOString(),
                kind: 'telemetry_upload_failed',
                reason:
                  serverCode ===
                  TELEMETRY_TRACKED_SOURCE_ORGANIZATION_TARGET_CODE
                    ? serverCode
                    : `telemetry ingest upload failed (scope=${deliveryScope})`,
                error: message,
                telemetryUploadStatus: status ?? null,
                telemetryShareScope: deliveryScope,
              });

              // A private upload can be the first attempt for a worktree whose
              // pre-namespacing organization row owns the bare id. Retry that
              // exact collision under a stable USER-owned namespace, then
              // persist the variant in targets.private so every later private
              // upload reuses the same row. All other 409s keep the terminal
              // behavior below.
              if (
                status === 409 &&
                serverCode === TELEMETRY_OWNER_SCOPE_CONFLICT_CODE &&
                target.shareScope === 'private' &&
                clientIdVariant === undefined
              ) {
                clientIdVariant = PRIVATE_OWNER_CONFLICT_ID_VARIANT;
                pieces = buildPieces();
                pieceIndex = 0;
                continue;
              }

              // Permanent per-target conflict (409): the server keys
              // workspace/worktree by (createdByUserId, clientLocalId) and
              // freezes owner scope, so a colliding id is rejected permanently.
              // Per-owner id namespacing (`scopedClampedId`) makes this
              // effectively unreachable; if it ever fires it is a bug, not a
              // retryable error. Skip THIS target's remaining pieces without
              // blocking the rest of the group or re-queuing — retrying would
              // loop forever, and the conflict is specific to this target, not
              // the piece. The diagnostic above keeps it triageable.
              //
              // This `break` leaves `groupFullyDelivered` untouched (still true
              // if piece 0 succeeded), so any still-unsent later pieces for this
              // target are dropped by `dropGroupItems` below rather than
              // re-queued. That is intentional and safe: 409 is keyed on the
              // target's stable `clientLocalId`, established on piece 0. If piece
              // 0 was accepted, that id is already registered, so a later piece
              // to the same target cannot legitimately 409 — a 409 can only fire
              // on piece 0 itself, before anything for this target is recorded.
              // A non-first-piece 409 is therefore unreachable. (Every piece now
              // re-sends the full envelope and may carry non-turn collections,
              // but the envelope ids are identical across pieces, so this
              // argument is unchanged.) If the server's conflict semantics ever
              // change to per-turn id collisions, this branch should defer
              // (`deferred = true`) instead of dropping the remaining items.
              if (status === 409) {
                break;
              }

              // The target does not own the work (another organization for a
              // tracked source, or any organization for Personal activity,
              // CAN-3515). This structured refusal is terminal for this
              // target; the diagnostic above records it and healthy siblings
              // must still receive their pieces.
              if (
                status === 403 &&
                serverCode === TELEMETRY_TRACKED_SOURCE_ORGANIZATION_TARGET_CODE
              ) {
                break;
              }

              // Permanent PER-TARGET refusal (403 + `telemetry_scope_prohibited`):
              // an org data-sharing policy, or — since CAN-2311 — a billing
              // lapse on the target org, which deliberately reuses this same
              // code so already-shipped clients stop retrying.
              //
              // Handled HERE, beside the 409, rather than as group poison. The
              // refusal names ONE target: the fan-out sends the same group to
              // every current org/team, so a lapsed org ordered before a healthy
              // one would otherwise poison the group and `dropGroupItems` would
              // delete data the healthy org never received. That is the same
              // unrecoverable loss the stale-snapshot guard above exists to
              // prevent, reached through the server instead of the local
              // snapshot — and it is MORE reachable now that billing lapses
              // emit this code too. Poison is for target-agnostic payload
              // rejections (400/422/413); a scope refusal is not one.
              //
              // `break` skips this target's remaining pieces and leaves
              // `groupFullyDelivered` untouched, exactly as 409 does, so the
              // group still drops once every other target has stored it and a
              // permanently-refused target never re-queues it forever.
              if (
                status === 403 &&
                serverCode === TELEMETRY_SCOPE_PROHIBITED_CODE
              ) {
                // Pick up the new policy/billing state immediately, so
                // `this.sharing` and the per-org gate stop producing content
                // for a target that will keep refusing it.
                this.triggerEnforcedSettingsReprobe();
                break;
              }

              this.lastError = 'upload-failed';
              this.lastErrorAt = new Date().toISOString();
              syncMapDirty = true;
              uploadFailed = true;
              groupFullyDelivered = false;

              // Permanent client-validation rejection (400/422) or payload too
              // large (413): with the client- and server-side clamping in place
              // these are effectively impossible, so this branch is a last-resort
              // backstop. A 413 can only escape when `splitTelemetryIngestRequest`
              // is forced to emit a single lone item that is itself over the
              // server byte cap — a piece that can never shrink on retry, so it is
              // just as permanent as a 400/422. The rejection is about payload
              // shape/size, not the target, so the batch is poison for every
              // target — drop it from the queue instead of retrying a poison batch
              // forever. (Decision locked: an unbounded retry loop that grows the
              // queue file is worse than losing one rollup batch; flip to
              // retry-but-log later if that tradeoff ever changes.)
              if (status === 400 || status === 422 || status === 413) {
                groupPoisoned = true;
                break;
              }

              // NOTE: the 403 `telemetry_scope_prohibited` refusal is handled
              // ABOVE, beside the 409, as a permanent PER-TARGET refusal. It
              // deliberately does not reach here, and it must not become group
              // poison again — see the reasoning at that branch.
              //
              // Matched there on the STRUCTURED `serverCode` the transport lifts
              // off the JSON error body, not on the message text: the server's
              // `error` string is human-readable prose ("Your organization
              // prohibits sharing transcripts") and never contains the code, so
              // a substring match against it would silently never fire and the
              // branch would decay back into the retry-forever bug it exists to
              // prevent.

              // A 5xx is a REJECTION: the server answered and refused. That is
              // the failure mode that used to retry forever (CAN-3106) — a
              // payload Prisma could never persist surfaced as a bare 500, which
              // this catch-all reads as transient. Count it, back the next
              // attempt off, and abandon the batch once the run proves the
              // server will not take it. A missing status (offline, DNS,
              // timeout) is explicitly NOT a rejection and never counts: the
              // user's queued telemetry must survive a flight.
              if (status !== undefined && status >= 500) {
                const rejections = noteServerRejection();
                if (rejections >= MAX_TELEMETRY_CONSECUTIVE_SERVER_REJECTIONS) {
                  getObservabilityService().recordAppDiagnostic({
                    version: 1,
                    timestamp: new Date().toISOString(),
                    kind: 'telemetry_upload_abandoned',
                    reason: `telemetry ingest abandoned after ${rejections} consecutive server rejections (scope=${deliveryScope}, lastError=${this.lastError ?? 'none'})`,
                    error: message,
                    telemetryUploadStatus: status,
                    telemetryShareScope: deliveryScope,
                    telemetryConsecutiveServerRejections: rejections,
                    telemetryFirstRejectionAt: entry.firstRejectionAt,
                  });
                  // Clear the run with the batch it belongs to: the NEXT batch
                  // deserves a full ladder, not an immediate drop.
                  entry.consecutiveServerRejections = undefined;
                  entry.firstRejectionAt = undefined;
                  groupPoisoned = true;
                  break;
                }
              }

              // Transient failure (network/timeout, 401/403/408/429, any 5xx,
              // or no status) — keep this group queued for the next attempt and
              // stop batching this target.
              break;
            }

            // Successful upload stamps the sync time. Clearing any prior error
            // is deferred until after the loop so a sibling failure in the same
            // flush is not erased by this success.
            this.lastSyncedAt = new Date().toISOString();
            uploadSucceeded = true;

            // Record the sync map with THIS piece's own turns/plans/summaries.
            // The server echoes refs for exactly what each piece sent, and the
            // union across pieces is complete, so per-piece recording covers the
            // whole group.
            const pieceWorktree = request.workspace.worktrees?.[0];
            this.recordSyncMap(
              entry,
              target,
              pieceWorktree?.turns ?? [],
              pieceWorktree?.plans ?? [],
              pieceWorktree?.pullRequests ?? [],
              pieceWorktree?.summaries ?? [],
              response,
              clientIdVariant,
            );
            syncMapDirty = true;
            pieceIndex += 1;
          }

          // Payload-shape poison (400/422) is target-agnostic, so stop
          // attempting further targets for this group.
          if (groupPoisoned) {
            break;
          }
        }

        // Drop the group's items once they are either fully delivered to every
        // target or permanently rejected. A partial failure leaves them queued
        // so the next flush retries the failed target(s).
        //
        // Note the degenerate all-targets-409 case: every target hit the 409
        // `continue` above (leaving `groupFullyDelivered === true`) without any
        // `recordSyncMap`, so the items are dropped without a successful store.
        // This is intentional, not an oversight. 409 is a permanent per-target
        // conflict that is non-retryable by design (see above); gating the drop
        // on "delivered to at least one target" would re-queue an all-conflict
        // group forever — the exact unbounded retry loop this path avoids. With
        // per-owner id namespacing (`scopedClampedId`) an all-409 group is
        // effectively unreachable, and the per-target diagnostic above keeps any
        // real occurrence triageable.
        finishGroup(
          group,
          groupPoisoned || groupFullyDelivered ? 'batch' : 'retain',
        );
      }
    } finally {
      this.setSyncing(false);
    }

    // A successful piece proves reachability but does not end a rejection run
    // when a later piece or fan-out target returns 5xx in the same flush. Clear
    // only after the whole flush observed at least one success and no server
    // rejection; otherwise a healthy first piece would pin the counter at one
    // and recreate the retry-forever bug this ladder bounds.
    if (uploadSucceeded && !serverRejectionCounted) {
      entry.consecutiveServerRejections = undefined;
      entry.firstRejectionAt = undefined;
    }

    // Only clear the error banner when the entire flush completed without an
    // upload failure and at least one scope actually uploaded. This prevents a
    // successful scope from masking a sibling scope's still-queued failure.
    if (uploadSucceeded && !uploadFailed) {
      this.lastError = null;
      this.lastErrorAt = null;
      syncMapDirty = true;
    }

    if (syncMapDirty) {
      await this.saveSyncMap();
    }

    if (
      entry.turns.size === 0 &&
      entry.plans.size === 0 &&
      entry.pullRequests.size === 0 &&
      entry.pipelineRuns.size === 0 &&
      entry.summarySnapshots.size === 0 &&
      entry.summaries.size === 0 &&
      // Same reasoning as `metaDirty`: an undelivered attention transition has
      // no collection item to keep it alive, and dropping it would silently
      // lose the one signal this whole path exists to deliver.
      entry.attention.size === 0 &&
      // An undelivered metadata refresh has no collection items to keep it
      // alive, so it must hold the entry open until its envelope lands.
      !Array.from(entry.metadata.values()).some((item) => item.value.dirty)
    ) {
      this.pending.delete(key);
    } else if (deferred) {
      this.scheduleFlush(key);
    }
    await this.persistQueue();
    // Reflect drained pendingCount / lastSyncedAt / lastError to the renderer.
    this.emitStatus();
  }

  /**
   * Re-probe org-enforced settings after a server policy rejection so the
   * stale client picks up the new policy immediately instead of waiting for the
   * 20-minute interval.
   *
   * Loaded with a dynamic `import()` purely to break a module cycle
   * (`telemetry-sync-service` → `ipc/settings` → `org-enforced-settings` →
   * `telemetry-sync-service`); a static import would leave `applyEnforcedSettings`
   * undefined at require time. Local module only, per the packaged-main rule in
   * CLAUDE.md. Fire-and-forget: a probe failure must not fail the flush.
   */
  /**
   * Refresh the account snapshot and report whether PER-ORG BILLING STATE was
   * genuinely updated from the server.
   *
   * This is the precondition for deleting queued data on a lapse verdict, so it
   * deliberately reports the narrow thing rather than "the probe ran":
   * `reprobeAndApplyCanopyCloudEnforcedSettings` leaves `orgBillingStates`
   * untouched when there is no API key, when the probe throws (offline), when
   * the response is unauthenticated, and when the response omits the field. In
   * every one of those the local verdict is still the stale one, and acting on
   * it would delete telemetry for a period the org may have already paid for.
   *
   * Never throws: any failure reports `false`, which makes the caller defer.
   */
  private async confirmLapseWithFreshSnapshot(
    flightCache: LapseConfirmationCache,
  ): Promise<boolean> {
    // Confirmation is scoped to ONE FLUSH, not memoized across flushes.
    //
    // Two failure modes bound this from opposite sides, and per-flush scoping
    // is what satisfies both:
    //
    //  - Confirming per GROUP is a probe storm. `filteredLapsed` is a stable
    //    property of a mixed healthy/lapsed membership set, not a one-shot, so
    //    unlike `all-lapsed` (which drops the group and terminates) it would
    //    re-confirm forever — a full `GET /account` plus an encrypt+write of
    //    the account file, per group, per worktree, roughly once a minute.
    //  - Memoizing ACROSS flushes makes the confirmation prove the wrong
    //    thing. A cached `true` says the account was refreshed recently, not
    //    that its lapse verdict is still current: if the org renews inside the
    //    window, a later flush reuses the cached answer, re-reads the
    //    still-lapsed local snapshot, and deletes newly queued telemetry.
    //    Deletion is irreversible, so its authority must not outlive the flush
    //    that earned it.
    //
    // So the cache lives on the flush, shared by that flush's groups and
    // discarded with it. Only successes are cached; a failure re-probes.
    if (flightCache.confirmed) {
      return true;
    }

    // BOUND TO THE ACCOUNT that produced it. This service is a
    // process-lifetime singleton that survives sign-out and account
    // replacement, and the in-flight promise is shared, so an answer must
    // never be credited to a different tenant than the one it was asked for.
    const accountKey = await this.currentAccountKey();
    if (accountKey === null) {
      return false;
    }

    this.inFlightLapseConfirmation ??= import('../ipc/settings')
      .then((module) => module.reprobeAndApplyCanopyCloudEnforcedSettings())
      .catch(() => false)
      .finally(() => {
        this.inFlightLapseConfirmation = null;
      });
    const refreshed = await this.inFlightLapseConfirmation;
    if (!refreshed) {
      return false;
    }

    // Re-read the identity AFTER awaiting: the account can be replaced while a
    // shared probe is outstanding, and the result belongs to whoever was
    // signed in when it resolved.
    const settledKey = await this.currentAccountKey();
    if (settledKey === null || settledKey !== accountKey) {
      return false;
    }

    flightCache.confirmed = true;
    return true;
  }

  /**
   * Stable identity of the currently signed-in cloud account, or `null` when
   * there is none (or it cannot be read).
   *
   * Keyed on the API key because that is what actually scopes every ingest
   * request and every per-org billing verdict; a different key is a different
   * tenant regardless of how the UI got there. Only ever compared, never
   * logged or persisted.
   */
  private async currentAccountKey(): Promise<string | null> {
    try {
      const credentials = await getCanopyCloudCredentials();
      return credentials?.apiKey ?? null;
    } catch {
      return null;
    }
  }

  private triggerEnforcedSettingsReprobe(): void {
    void import('../ipc/settings')
      .then((module) => module.reprobeAndApplyCanopyCloudEnforcedSettings())
      .catch(() => undefined);
  }

  private schedulePendingFlushes(): void {
    for (const key of Array.from(this.pending.keys())) {
      this.scheduleFlush(key);
    }
  }

  /**
   * Only a successfully read config can authorize delivery targets.
   * A present but malformed owner is unknown ownership and uploads nothing.
   */
  private async loadWorkspaceOwner(
    projectId: string,
  ): Promise<
    | { kind: 'personal' }
    | { kind: 'organization'; binding: WorkspaceOwnerBinding }
    | { kind: 'unknown' }
  > {
    try {
      const { config, authority, ownerMalformed } =
        await readWorkspaceConfigDetailed(projectId);
      if (authority !== 'ok' || ownerMalformed === true) {
        return { kind: 'unknown' };
      }
      return config.owner
        ? { kind: 'organization', binding: config.owner }
        : { kind: 'personal' };
    } catch {
      return { kind: 'unknown' };
    }
  }

  private buildRequest(
    entry: PendingWorktree,
    turns: TelemetryTurnPayload[],
    plans: TelemetryPlanPayload[],
    pullRequests: TelemetryPullRequestPayload[],
    pipelineRuns: TelemetryPipelineRunPayload[],
    summary: string | undefined,
    summaries: TelemetryWorktreeSummarySnapshot[],
    scopeContext: ScopeContext,
    attention: TelemetryAttention[],
    owner: WorkspaceOwnerBinding | undefined,
    includeUserActivity: boolean,
    clientIdVariant?: typeof PRIVATE_OWNER_CONFLICT_ID_VARIANT,
    memoryExcluded?: boolean,
    notificationProducerId?: string | null,
    notificationScope?: SpaceNotificationScope | null,
  ): TelemetryIngestRequest {
    // The originating space's full identity (CAN-3615), so the server maps
    // every owner-scope replica of this worktree or Work Entry to the one
    // personal notification preference the desktop registered for it.
    const sourceWorktreeId = clampId(
      entry.worktreeId,
      MAX_TELEMETRY_CLIENT_ID_LENGTH,
    );
    // Plan and review chats count toward the real worktree they serve, and
    // advisory surfaces belong to no space (see `space-notification-scope`).
    // The ids travel as the same keyed references the producer sync sends.
    const notificationSpace =
      notificationProducerId && notificationScope
        ? {
            version: 1 as const,
            producerId: notificationProducerId,
            ...spaceNotificationSourceRef(notificationProducerId, {
              workspaceId: notificationScope.projectId,
              spaceId: notificationScope.worktreeId,
            }),
            enforcementVersion: 1 as const,
          }
        : undefined;
    const scopedWorktreeId = scopedClampedId(
      entry.worktreeId,
      scopeContext,
      clientIdVariant,
    );
    // Presence counts only where the work's own metadata lands (see
    // `FlushGroup.carriesPresence`).
    const userActiveAt = includeUserActivity
      ? this.userActivity.get(worktreeKey(entry.projectId, entry.worktreeId))
      : undefined;
    const relayDeviceId = this.getRelayDeviceId();
    const request: TelemetryIngestRequest = {
      shareScope: scopeContext.shareScope,
      workspace: {
        ...(memoryExcluded === true ? { memoryExcluded: true } : {}),
        clientLocalId: scopedClampedId(
          entry.projectId,
          scopeContext,
          clientIdVariant,
        ),
        // Organization-project provenance (CAN-2948) so the server can
        // enforce the private-only contract until milestone-3 feed-read guards land.
        ...(owner
          ? {
              sourceProjectId: owner.projectId,
              sourceOrganizationId: owner.organizationId,
            }
          : {}),
        // Workspace name and branch name are user-controlled free text, so they
        // pass through the same secret redaction as plan/PR titles before they
        // leave the machine, then clamp to the shared length bound.
        name: clampText(
          redactSecrets(entry.workspaceName),
          MAX_TELEMETRY_NAME_LENGTH,
        ),
        workspaceType: entry.workspaceType,
        worktrees: [
          {
            clientLocalId: scopedWorktreeId,
            sourceClientLocalId: sourceWorktreeId,
            // Lets a push tap open the chat on this computer. Absent until the
            // relay has started; the server then keeps any stored id.
            ...(relayDeviceId ? { sourceRelayDeviceId: relayDeviceId } : {}),
            ...(notificationSpace ? { notificationSpace } : {}),
            branchName: clampText(
              redactSecrets(entry.branchName),
              MAX_TELEMETRY_LABEL_LENGTH,
            ),
            ...(entry.status ? { status: entry.status } : {}),
            ...(entry.createdAt ? { clientCreatedAt: entry.createdAt } : {}),
            ...(userActiveAt !== undefined ? { userActiveAt } : {}),
            ...(summary !== undefined ? { summary } : {}),
            ...(turns.length > 0 ? { turns } : {}),
            ...(plans.length > 0 ? { plans } : {}),
            ...(pullRequests.length > 0 ? { pullRequests } : {}),
            ...(pipelineRuns.length > 0 ? { pipelineRuns } : {}),
            ...(summaries.length > 0 ? { summaries } : {}),
          },
        ],
      },
    };
    if (attention.length > 0) {
      // Re-key onto the SAME namespaced worktree id the envelope carries: the
      // server rejects an attention entry that references a worktree outside
      // the request, and the per-owner namespacing differs per target.
      request.attention = attention.map((item) => ({
        ...item,
        clientWorktreeId: scopedWorktreeId,
      }));
    }
    if (scopeContext.teamId) {
      request.teamId = scopeContext.teamId;
    }
    if (scopeContext.organizationId) {
      request.organizationId = scopeContext.organizationId;
    }
    return request;
  }

  private applyTurnContentHashShortCircuit(
    turn: TelemetryTurnPayload,
    syncTarget: SyncMapTarget | undefined,
  ): TelemetryTurnPayload {
    const recorded = syncTarget?.turns[turn.clientTurnId];
    if (
      recorded &&
      turn.contentHash !== undefined &&
      recorded.contentHash === turn.contentHash
    ) {
      // Body unchanged from the last sync — drop it so the server short-circuits
      // re-encryption; keep the hash so it can confirm the match.
      const rest: TelemetryTurnPayload = { ...turn };
      delete rest.body;
      return rest;
    }
    return turn;
  }

  private applyPlanContentHashShortCircuit(
    plan: TelemetryPlanPayload,
    syncTarget: SyncMapTarget | undefined,
  ): TelemetryPlanPayload {
    const recorded = syncTarget?.plans[plan.clientPlanId];
    if (
      recorded &&
      plan.contentHash !== undefined &&
      recorded.contentHash === plan.contentHash
    ) {
      const rest: TelemetryPlanPayload = { ...plan };
      delete rest.body;
      return rest;
    }
    return plan;
  }

  private recordSyncMap(
    entry: PendingWorktree,
    context: ScopeContext,
    turns: TelemetryTurnPayload[],
    plans: TelemetryPlanPayload[],
    pullRequests: TelemetryPullRequestPayload[],
    summaries: TelemetryWorktreeSummarySnapshot[],
    response: TelemetryIngestResponse,
    clientIdVariant?: typeof PRIVATE_OWNER_CONFLICT_ID_VARIANT,
  ): void {
    const targetKey = scopeTargetKey(context);
    // Match the response worktree on the SAME namespaced id we sent, not the
    // bare worktree id — the server echoes back the per-target clientLocalId.
    const wtClientId = scopedClampedId(
      entry.worktreeId,
      context,
      clientIdVariant,
    );
    const ws = response.workspace;
    const workspace: SyncMapWorkspace = this.syncMap.workspaces[
      entry.projectId
    ] ?? { externalIds: {}, worktrees: {} };
    // Kept as workspace-level provenance per target for the persisted v2 map.
    // Current retry logic reads target.externalId below, not this parent id.
    workspace.externalIds[targetKey] = ws.externalId;

    const wtRef = ws.worktrees.find(
      (candidate) => candidate.clientLocalId === wtClientId,
    );
    const worktree: SyncMapWorktree = workspace.worktrees[entry.worktreeId] ?? {
      targets: {},
    };
    const target: SyncMapTarget = worktree.targets[targetKey] ?? {
      externalId: wtRef?.externalId ?? '',
      turns: {},
      plans: {},
      pullRequests: {},
      pipelineRuns: {},
      summaries: {},
    };
    if (clientIdVariant !== undefined) {
      target.clientIdVariant = clientIdVariant;
    }
    if (wtRef) {
      target.externalId = wtRef.externalId;
      for (const ref of wtRef.turns) {
        const sent = turns.find((t) => t.clientTurnId === ref.clientTurnId);
        target.turns[ref.clientTurnId] = {
          externalId: ref.externalId,
          contentHash:
            sent?.contentHash ?? target.turns[ref.clientTurnId]?.contentHash,
        };
      }
      for (const ref of wtRef.plans) {
        const sent = plans.find((p) => p.clientPlanId === ref.clientPlanId);
        target.plans[ref.clientPlanId] = {
          externalId: ref.externalId,
          contentHash:
            sent?.contentHash ?? target.plans[ref.clientPlanId]?.contentHash,
        };
      }
      for (const ref of wtRef.pullRequests) {
        const key = pullRequestKey(ref.repoId, ref.prNumber);
        const sent = pullRequests.find(
          (pr) => pullRequestKey(pr.repoId, pr.prNumber) === key,
        );
        const state = sent?.state ?? target.pullRequests[key]?.state;
        target.pullRequests[key] = {
          externalId: ref.externalId,
          ...(sent?.prUrl ? { prUrl: sent.prUrl } : {}),
          ...(state !== undefined ? { state } : {}),
        };
      }
      for (const ref of wtRef.pipelineRuns) {
        target.pipelineRuns[ref.clientPipelineRunId] = {
          externalId: ref.externalId,
        };
      }
      const sentSnapshotIds = new Set(
        summaries.map((snapshot) => snapshot.clientSnapshotId),
      );
      const returnedSummaries = wtRef.summaries ?? [];
      if (returnedSummaries.length > 0) {
        const summaryMap = target.summaries ?? {};
        for (const ref of returnedSummaries) {
          // Only record refs for snapshots we actually sent this request; the
          // server may echo previously stored snapshots which are already mapped.
          if (sentSnapshotIds.has(ref.clientSnapshotId)) {
            summaryMap[ref.clientSnapshotId] = { externalId: ref.externalId };
          }
        }
        target.summaries = summaryMap;
      }
    }

    worktree.targets[targetKey] = target;
    workspace.worktrees[entry.worktreeId] = worktree;
    this.syncMap.workspaces[entry.projectId] = workspace;
  }

  /**
   * Resolve configured destinations within the enqueue-time context ceiling.
   * Private is unchanged. Organization requires membership in the stamped org;
   * legacy team scope includes only that org's current teams. Flush callers
   * downgrade a missing selection to private before resolving. Membership and
   * billing checks may narrow these targets further, but never retarget work to
   * a different org. Unavailable membership defers; a confirmed lapse permits
   * dropping content.
   */
  private async resolveScopeTargets(
    shareScope: TelemetryShareScope,
    organizationId: string | null,
  ): Promise<ScopeResolution> {
    if (shareScope === 'private') {
      // Private scope has no org to gate, so nothing can be filtered out.
      return {
        kind: 'targets',
        targets: [{ shareScope }],
        filteredLapsed: false,
      };
    }
    if (organizationId === null) {
      // Defensive fallback: flush callers downgrade this case to private first.
      return { kind: 'excluded' };
    }
    let credentials: Awaited<ReturnType<typeof getCanopyCloudCredentials>>;
    try {
      credentials = await getCanopyCloudCredentials();
    } catch {
      return { kind: 'unavailable' };
    }
    // Per-org billing gate (CAN-2311): an org that has lost the `teams`
    // capability is dropped from the fan-out entirely. Read once for the whole
    // resolution and applied PER TARGET, never as a global switch — a member of
    // one lapsed org and one healthy org keeps syncing to the healthy one. A
    // team is gated by its OWNING org, since a team's data lands in that org.
    // Unknown ⇒ entitled, so an older server or an offline snapshot degrades to
    // today's behavior instead of silently stopping every upload.
    const billingStates = await loadStoredOrgBillingStates();
    if (shareScope === 'team') {
      // Legacy team sharing stays inside the stamped organization. The server
      // rejects `organizationId` unless `shareScope` is `organization`
      // (telemetry-service parseIngestRequest), so a team-scope request must
      // carry only `teamId`.
      const teams = (credentials.teams ?? []).filter(
        (team) => team.organization.id === organizationId,
      );
      const liveTeams = teams.filter(
        (team) => !isOrgTeamsLapsed(billingStates, team.organization.id),
      );
      if (liveTeams.length === 0) {
        return teams.length > 0
          ? { kind: 'all-lapsed' }
          : { kind: 'unavailable' };
      }
      return {
        kind: 'targets',
        targets: liveTeams.map((team) => ({
          shareScope,
          teamId: team.id,
          ownerOrganizationId: team.organization.id,
        })),
        filteredLapsed: liveTeams.length !== teams.length,
      };
    }
    // Membership validates the stamped organization; it never supplies another.
    const organizations = (credentials.organizations ?? []).filter(
      (organization) => organization.id === organizationId,
    );
    const liveOrganizations = organizations.filter(
      (organization) => !isOrgTeamsLapsed(billingStates, organization.id),
    );
    if (liveOrganizations.length === 0) {
      return organizations.length > 0
        ? { kind: 'all-lapsed' }
        : { kind: 'unavailable' };
    }
    return {
      kind: 'targets',
      targets: liveOrganizations.map((organization) => ({
        shareScope,
        organizationId: organization.id,
      })),
      filteredLapsed: liveOrganizations.length !== organizations.length,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private ensurePending(
    projectId: string,
    worktreeId: string,
    meta: WorktreeMeta,
    targetOrganizationId: string | null,
  ): PendingWorktree {
    const key = worktreeKey(projectId, worktreeId);
    const existing = this.pending.get(key);
    if (existing) {
      // Refresh metadata snapshot in case the branch/status/name changed.
      existing.workspaceName = meta.workspaceName;
      existing.workspaceType = meta.workspaceType;
      existing.branchName = meta.branchName;
      existing.status = meta.status;
      existing.createdAt = meta.createdAt;
      const previous = existing.metadata.get(
        pendingItemKey('metadata', targetOrganizationId),
      );
      queueItem(
        existing.metadata,
        'metadata',
        { ...meta, dirty: previous?.value.dirty },
        targetOrganizationId,
      );
      return existing;
    }
    const created: PendingWorktree = {
      projectId,
      worktreeId,
      turns: new Map(),
      plans: new Map(),
      pullRequests: new Map(),
      pipelineRuns: new Map(),
      summarySnapshots: new Map(),
      attention: new Map(),
      summaries: new Map(),
      metadata: new Map(),
      ...meta,
    };
    queueItem(created.metadata, 'metadata', meta, targetOrganizationId);
    this.pending.set(key, created);
    return created;
  }

  private async resolveWorktreeMeta(
    projectId: string,
    worktreeId: string,
  ): Promise<WorktreeMeta | null> {
    // Prefer the durable snapshot we already captured (survives deletion).
    const existing = Array.from(this.pending.values()).find(
      (entry) =>
        entry.projectId === projectId && entry.worktreeId === worktreeId,
    );
    const indexEntry = await readWorkspaceIndexEntry(projectId).catch(
      () => null,
    );
    const worktrees = await readWorkspaceWorktrees(projectId).catch(() => []);
    const worktree = worktrees.find((candidate) => candidate.id === worktreeId);

    // Chat surfaces that are not rows in `workspaces/index.json` (App Advisor,
    // the Pipeline Assistant, plan-explore and code-review chats) have no index
    // entry, so without this fallback `workspaceName`/`workspaceType` stayed
    // undefined, this method returned null, and every ingress path dropped the
    // turn — those surfaces never synced at all. The index entry still wins
    // wherever one exists, so a real workspace's name and type are unaffected.
    const sentinel = getSentinelTelemetryWorkspace(projectId);
    const workspaceName =
      indexEntry?.name ?? existing?.workspaceName ?? sentinel?.name;
    const workspaceType =
      toTelemetryWorkspaceType(indexEntry?.type) ??
      existing?.workspaceType ??
      sentinel?.type;

    // Cowork Work Entries occupy the `worktreeId` slot but live in
    // work-entries.json, not worktrees.json — without this lookup every cowork
    // entry syncs with `branchName` = the raw entry UUID and no
    // status/clientCreatedAt, which makes the Impact delivery track's linkage
    // and done bonuses unreachable server-side.
    //
    // Registry override only: the *derived* title needs `deriveEntryMeta`,
    // which reads each entry's chat-tabs file. That is filesystem I/O on the
    // sync hot path, and it would make `branch_name` an agent-generated chat
    // title. The registry `title` is a deliberate user rename, which is the
    // honest linkage signal.
    const workEntry =
      worktree === undefined && workspaceType === 'cowork'
        ? (
            await readWorkEntriesFile(projectId).catch(() => null)
          )?.entries.find((entry) => entry.id === worktreeId)
        : undefined;

    const branchName =
      worktree?.branchName ??
      workEntry?.title ??
      existing?.branchName ??
      worktreeId;

    if (workspaceName === undefined || workspaceType === undefined) {
      return null;
    }

    return {
      workspaceName,
      workspaceType,
      branchName,
      status: worktree?.status ?? workEntry?.status ?? existing?.status,
      createdAt:
        worktree?.createdAt ?? workEntry?.createdAt ?? existing?.createdAt,
    };
  }

  private async loadTranscriptBody(
    entry: AgentAuditEntry,
  ): Promise<string | undefined> {
    if (!entry.hasTranscript) {
      return undefined;
    }
    try {
      const transcript = await getObservabilityService().loadTranscript({
        id: entry.id,
        eventType: entry.eventType,
        startedAt: entry.startedAt,
      });
      if (transcript.type !== 'success' || transcript.lines.length === 0) {
        return undefined;
      }
      // `loadTranscript` strips `canopy_injected_prompt` records out of
      // `lines` into `injectedPrompts`. Re-serialize the org_memory ones —
      // and only those — back into the uploaded body: the server-side
      // usefulness judge (CAN-2253) joins delivered memory injections to
      // turn transcripts by finding this record as its anchor. The lines are
      // PREPENDED (the block chronologically precedes the turn, and the
      // line-aware byte clamp in `prepareTelemetryBody` keeps the head, so a
      // clamped over-cap body still carries the anchor). System-prompt and
      // plan-mode prompts stay local: larger, boilerplate, and no server
      // consumer reads them.
      const anchorLines = transcript.injectedPrompts
        .filter((prompt) => prompt.kind === 'org_memory')
        .map((prompt) => {
          const record: AgentAuditTranscriptInjectedPromptRecord = {
            type: 'canopy_injected_prompt',
            kind: prompt.kind,
            provider: prompt.provider,
            application_condition: prompt.applicationCondition,
            text: prompt.text,
          };
          return JSON.stringify(record);
        });
      return [...anchorLines, ...transcript.lines].join('\n');
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // On-demand share ingest (CAN-395)
  // -------------------------------------------------------------------------

  /**
   * Ingest a single finished chat session's transcript turns to the corpus on
   * demand, bypassing the ambient `telemetrySharing` gate. Used by the explicit
   * "Share run" action (CAN-395): the click is its own consent, so the run's
   * referenced rows are guaranteed to exist server-side even when ambient sync
   * is Off. Rows are ingested at USER/private owner scope; the user/team/org
   * grant is a separate `SharedRun` created by the run-share orchestration.
   *
   * Returns the share-namespaced `{ workspaceLocalId, worktreeLocalId }` the
   * rows were written under (so the caller's `SharedRun` grant can reference
   * exactly them), `no-activity` when the session has no finished turns or the
   * worktree metadata cannot be resolved, or `blocked-by-org-policy` when an
   * org prohibits the data this path would upload.
   *
   * BACKSTOP GUARD. Because this path bypasses the ambient gate on purpose, a
   * prohibition has to be enforced explicitly here — `this.sharing` is never
   * consulted. `transcripts` or `metadata` prohibited refuses outright (the
   * whole point of a shared run is its transcript, and the worktree/turn
   * envelope IS metadata); a `plans` prohibition only strips the plans
   * collection, since the run itself is still shareable without it.
   * `getShareRunEligibility` gates the same thing earlier so the UI can explain
   * it before the user picks an audience; this guard covers every other caller.
   */
  async ingestSessionForShare(
    projectId: string,
    worktreeId: string,
    chatId: string,
    selectedContext?: WorkspaceContext | null,
  ): Promise<IngestSessionForShareResult> {
    const selectedOrganization =
      selectedContext === undefined
        ? selectedOrganizationId()
        : selectedContext?.kind === 'organization'
          ? selectedContext.organizationId
          : null;
    const owner = await this.governingOrgFor(
      projectId,
      worktreeId,
      selectedOrganization,
    );
    if (owner.kind === 'unknown') {
      return {
        status: 'blocked-by-org-policy',
        scope: 'metadata',
        organizationNames: [],
      };
    }
    const governingOrg =
      owner.kind === 'organization' ? owner.organizationId : null;
    let byOrg: StoredTelemetryEnforcementByOrganization =
      emptyTelemetryEnforcementByOrganization();
    if (governingOrg !== null) {
      try {
        byOrg = await loadStoredTelemetryEnforcementByOrganization();
      } catch (error) {
        recordTelemetryEnforcementReadFailure('share-ingest', error);
        return {
          status: 'blocked-by-org-policy',
          scope: 'metadata',
          organizationNames: [],
        };
      }
    }
    const normalizedGoverningOrg = governingOrg
      ? normalizeUuid(governingOrg)
      : null;
    const orgPolicy = normalizedGoverningOrg
      ? byOrg.get(normalizedGoverningOrg)
      : undefined;
    const enforcement = enforcementForOrganization(byOrg, governingOrg);
    for (const scope of ['transcripts', 'metadata'] as const) {
      if (enforcement.prohibited[scope]) {
        return {
          status: 'blocked-by-org-policy',
          scope,
          organizationNames: orgPolicy ? [orgPolicy.organizationName] : [],
        };
      }
    }
    const includePlans = !enforcement.prohibited.plans;

    const meta = await this.resolveWorktreeMeta(projectId, worktreeId);
    if (!meta) {
      return { status: 'no-activity' };
    }

    const entries = await this.loadFinishedChatEntries(
      projectId,
      worktreeId,
      chatId,
    );
    if (entries.length === 0) {
      return { status: 'no-activity' };
    }

    // Full-session capture: unlike ambient sync, do NOT stop at the
    // per-worktree turn cap. Map every finished turn (with the higher
    // share-only per-turn body cap) and paginate the upload into cap-sized
    // batches below so a >100-turn session ingests fully before the run grant
    // is created.
    const turns: TelemetryTurnPayload[] = [];
    for (const entry of entries) {
      const transcriptBody = await this.loadTranscriptBody(entry);
      const payload = mapAuditEntryToTurnPayload(entry, {
        transcriptBody,
        maxBodyBytes: MAX_TELEMETRY_SHARE_BODY_BYTES,
      });
      if (payload) {
        turns.push(payload);
      }
    }
    if (turns.length === 0) {
      return { status: 'no-activity' };
    }

    // Include the worktree's plans present at share time, stamped with the
    // run's shared chat id so they are scopable by `(worktreeId, clientChatId)`
    // and bounded by `createdAt` on read (CAN-396). Capped like ambient.
    // Skipped entirely when an org prohibits `plans` — the run still shares.
    const trackedPlans = includePlans
      ? await listTrackedPlans(projectId, worktreeId)
      : [];
    const plans: TelemetryPlanPayload[] = trackedPlans
      .slice(0, MAX_TELEMETRY_PLANS_PER_WORKTREE)
      .map((plan) => {
        const payload = mapTrackedPlanToPlanPayload(plan, {
          clientChatId: chatId,
          maxBodyBytes: MAX_TELEMETRY_SHARE_BODY_BYTES,
        });
        if (payload.body !== undefined && payload.body.length > 0) {
          payload.contentHash = sha256(payload.body);
        }
        return payload;
      });

    // Self-contained share: USER-owned rows (the request sends `shareScope:
    // 'private'`) under a dedicated namespace so the write can never collide
    // with ambient private rows or legacy per-org rows. Never derived from
    // `this.sharing`, and never early-returns on `sharing.* === 'off'`.
    const workspaceLocalId = runShareClientLocalId(projectId);
    const worktreeLocalId = runShareClientLocalId(worktreeId);
    const branchName = clampText(
      redactSecrets(meta.branchName),
      MAX_TELEMETRY_LABEL_LENGTH,
    );
    const workspaceName = clampText(
      redactSecrets(meta.workspaceName),
      MAX_TELEMETRY_NAME_LENGTH,
    );

    // Assemble ONE full request for the whole session, then byte-aware split it
    // into pieces each under MAX_TELEMETRY_INGEST_BATCH_BYTES (and under every
    // per-request count cap the server enforces). Each piece re-sends the
    // workspace/worktree envelope keyed by the stable share-namespaced ids, so
    // the server appends every collection across pieces idempotently before the
    // run grant is created. A later piece may carry non-turn collections (e.g.
    // plans), not just turns.
    const fullRequest: TelemetryIngestRequest = {
      shareScope: 'private',
      fullSession: true,
      workspace: {
        clientLocalId: workspaceLocalId,
        name: workspaceName,
        workspaceType: meta.workspaceType,
        worktrees: [
          {
            clientLocalId: worktreeLocalId,
            branchName,
            ...(meta.status ? { status: meta.status } : {}),
            ...(meta.createdAt ? { clientCreatedAt: meta.createdAt } : {}),
            turns,
            ...(plans.length > 0 ? { plans } : {}),
          },
        ],
      },
    };
    const pieces = splitTelemetryIngestRequest(
      fullRequest,
      MAX_TELEMETRY_INGEST_BATCH_BYTES,
    );
    try {
      for (const request of pieces) {
        await requestCanopyCloudJson<TelemetryIngestResponse>(
          `/api/v1/${BRAND.web.apiNamespace}/telemetry/ingest`,
          { method: 'POST', body: JSON.stringify(request) },
        );
      }
    } catch (error) {
      // The pre-check above reads the LOCALLY cached policy, which lags the
      // server by up to one re-probe interval. An admin who prohibits a scope
      // inside that window leaves this the only place the refusal shows up, and
      // the server is authoritative — so translate its 403 into the same typed
      // refusal the local gate returns, rather than letting it surface as a
      // generic "Failed to share session." Matched on the structured
      // `serverCode`, not the human-readable message, for the same reason the
      // flush path is.
      //
      // Re-probing matters as much as the message: without it the stale local
      // policy survives and every retry inside the window fails identically.
      const cloudError =
        error instanceof CanopyCloudClientError ? error : undefined;
      if (
        cloudError?.status === 403 &&
        cloudError.serverCode === TELEMETRY_SCOPE_PROHIBITED_CODE
      ) {
        this.triggerEnforcedSettingsReprobe();
        // Attribution comes from the SERVER's own refusal, not from a re-read
        // of local state. The re-probe above is deliberately fire-and-forget
        // (it does a network round trip and a disk write), so anything read
        // here would still be the stale "nothing prohibited" snapshot that let
        // the local pre-check pass in the first place — the attribution would
        // then always fall back to a hardcoded guess. The server names the
        // scope it rejected, so use it; the org names are genuinely not known
        // until the re-probe lands, and `ShareRunModal` already degrades an
        // empty list to "an organization you belong to" rather than inventing
        // one.
        const scopeKeys: readonly TelemetryScopeKey[] = [
          'transcripts',
          'plans',
          'metadata',
          'summaries',
        ];
        const rejectedScope = scopeKeys.find(
          (candidate) => candidate === cloudError.serverScope,
        );
        return {
          status: 'blocked-by-org-policy',
          // Falls back to `transcripts` only if a future server stops naming
          // the scope; the refusal itself is what matters to the caller.
          scope: rejectedScope ?? 'transcripts',
          organizationNames: [],
        };
      }
      throw error;
    }
    return { status: 'ok', workspaceLocalId, worktreeLocalId };
  }

  /**
   * Load every finished (non-`running`) audit entry for a single chat within a
   * worktree, paging through the observability history until exhausted or a
   * generous safety cap is reached.
   */
  private async loadFinishedChatEntries(
    projectId: string,
    worktreeId: string,
    chatId: string,
  ): Promise<AgentAuditEntry[]> {
    const observability = getObservabilityService();
    const collected: AgentAuditEntry[] = [];
    let cursor: string | undefined;
    // Safety cap: at most 10 pages of 200 entries. A single chat session should
    // never exceed this; the per-worktree turn cap bounds the ingest anyway.
    for (let page = 0; page < 10; page++) {
      const response = await observability.loadHistory({
        projectId,
        worktreeId,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of response.entries) {
        if (entry.chatId === chatId && entry.status !== 'running') {
          collected.push(entry);
        }
      }
      if (!response.nextCursor) {
        break;
      }
      cursor = response.nextCursor;
    }
    // History is newest-first; the transcript reads oldest-first.
    return collected.reverse();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private enqueueIo<T>(task: () => Promise<T>): Promise<T> {
    // `task` is passed as BOTH the fulfillment and rejection handler so a
    // failure in a prior IO task never stalls the chain — the next task always
    // runs regardless of the previous outcome. Do not refactor to
    // `.then(task).catch(...)`, which has different semantics.
    const run = this.ioChain.then(task, task);
    this.ioChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private persistQueue(): Promise<void> {
    return this.enqueueIo(async () => {
      const filePath = getTelemetrySyncQueueFilePath();
      const lines: string[] = [];
      for (const entry of Array.from(this.pending.values())) {
        const persisted: PersistedPendingWorktree = {
          version: QUEUE_LINE_VERSION,
          projectId: entry.projectId,
          worktreeId: entry.worktreeId,
          workspaceName: entry.workspaceName,
          workspaceType: entry.workspaceType,
          branchName: entry.branchName,
          status: entry.status,
          createdAt: entry.createdAt,
          turns: [],
          plans: [],
          pullRequests: [],
          pipelineRuns: [],
          items: {
            turns: Array.from(entry.turns.values()),
            plans: Array.from(entry.plans.values()),
            pullRequests: Array.from(entry.pullRequests.values()),
            pipelineRuns: Array.from(entry.pipelineRuns.values()),
            summaries: Array.from(entry.summaries.values()),
            summarySnapshots: Array.from(entry.summarySnapshots.values()),
            metadata: Array.from(entry.metadata.values()),
          },
          consecutiveServerRejections: entry.consecutiveServerRejections,
          firstRejectionAt: entry.firstRejectionAt,
        };
        lines.push(JSON.stringify(persisted));
      }
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(
        filePath,
        lines.length > 0 ? `${lines.join('\n')}\n` : '',
        'utf8',
      );
    });
  }

  private async loadQueue(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(getTelemetrySyncQueueFilePath(), 'utf8');
    } catch {
      return;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      let parsed: PersistedPendingWorktree;
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- durable queue file written by this service; version/shape guarded below.
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (
        parsed.version !== QUEUE_LINE_VERSION ||
        !parsed.projectId ||
        !parsed.worktreeId
      ) {
        continue;
      }
      // Preserve the hydration fail-closed guard for structurally corrupt
      // collections rather than rewriting a partially read queue.
      const collections = [
        parsed.turns,
        parsed.plans,
        parsed.pullRequests,
        parsed.pipelineRuns,
        parsed.summarySnapshots,
        ...Object.values(parsed.items ?? {}),
      ];
      if (
        collections.some(
          (items) => items !== undefined && !Array.isArray(items),
        )
      ) {
        throw new Error('Invalid telemetry queue collection');
      }
      // Stamps written by CAN-3278 builds (on the line or on each item) are
      // deliberately dropped: every legacy item is re-evaluated by the work's
      // owner at flush, so work queued under the wrong selection still lands
      // where it belongs (CAN-3515).
      const pending = this.ensurePending(
        parsed.projectId,
        parsed.worktreeId,
        {
          workspaceName: parsed.workspaceName,
          workspaceType: parsed.workspaceType,
          branchName: parsed.branchName,
          status: parsed.status,
          createdAt: parsed.createdAt,
        },
        OWNER_ROUTED,
      );
      const restore = <T>(
        target: Map<string, PendingItem<T>>,
        items: PersistedPendingItem<T>[] | undefined,
        legacy: T[],
        id: (value: T) => string,
      ): void => {
        if (items) {
          for (const item of items) {
            queueItem(
              target,
              item.id,
              item.value,
              typeof item.targetOrganizationId === 'string' &&
                item.targetOrganizationId.length > 0
                ? item.targetOrganizationId
                : OWNER_ROUTED,
              item.memoryExcluded === true,
              item.capturedAt ?? '1970-01-01T00:00:00.000Z',
            );
          }
        } else {
          for (const value of legacy)
            queueItem(
              target,
              id(value),
              value,
              OWNER_ROUTED,
              undefined,
              '1970-01-01T00:00:00.000Z',
            );
        }
      };
      restore(
        pending.turns,
        parsed.items?.turns,
        parsed.turns ?? [],
        (turn) => turn.clientTurnId,
      );
      restore(
        pending.plans,
        parsed.items?.plans,
        parsed.plans ?? [],
        (plan) => plan.clientPlanId,
      );
      restore(
        pending.pullRequests,
        parsed.items?.pullRequests,
        parsed.pullRequests ?? [],
        (pr) => pullRequestKey(pr.repoId, pr.prNumber),
      );
      restore(
        pending.pipelineRuns,
        parsed.items?.pipelineRuns,
        parsed.pipelineRuns ?? [],
        (run) => run.clientPipelineRunId,
      );
      restore(
        pending.summaries,
        parsed.items?.summaries,
        parsed.summary === undefined ? [] : [parsed.summary],
        () => 'summary',
      );
      restore(
        pending.summarySnapshots,
        parsed.items?.summarySnapshots,
        parsed.summarySnapshots ?? [],
        (snapshot) => snapshot.clientSnapshotId,
      );
      restore(
        pending.metadata,
        parsed.items?.metadata,
        [
          {
            workspaceName: parsed.workspaceName,
            workspaceType: parsed.workspaceType,
            branchName: parsed.branchName,
            status: parsed.status,
            createdAt: parsed.createdAt,
            dirty: parsed.metaDirty,
          },
        ],
        () => 'metadata',
      );
      pending.consecutiveServerRejections =
        typeof parsed.consecutiveServerRejections === 'number' &&
        Number.isFinite(parsed.consecutiveServerRejections) &&
        parsed.consecutiveServerRejections > 0
          ? Math.floor(parsed.consecutiveServerRejections)
          : undefined;
      pending.firstRejectionAt =
        typeof parsed.firstRejectionAt === 'string'
          ? parsed.firstRejectionAt
          : undefined;
      const key = worktreeKey(parsed.projectId, parsed.worktreeId);
      // Re-establish PR ownership for anything that survived a restart, so a
      // queued-but-unflushed PR is not re-claimed by the other writer.
      for (const { value: pr } of Array.from(pending.pullRequests.values())) {
        if (pr.prUrl && pr.prUrl.length > 0) {
          this.claimedPullRequests.set(pr.prUrl, key);
        }
      }
      this.pending.set(pendingWorktreeKey(pending), pending);
    }
  }

  private saveSyncMap(): Promise<void> {
    // Stamp the latest status onto the persisted map so "Synced Xm ago"
    // survives a restart. These are optional top-level fields tolerated by the
    // version guard in loadSyncMap.
    if (this.lastSyncedAt !== null) {
      this.syncMap.lastSyncedAt = this.lastSyncedAt;
    } else {
      delete this.syncMap.lastSyncedAt;
    }
    if (this.lastErrorAt !== null) {
      this.syncMap.lastErrorAt = this.lastErrorAt;
    } else {
      delete this.syncMap.lastErrorAt;
    }
    if (this.lastError !== null) {
      this.syncMap.lastError = this.lastError;
    } else {
      delete this.syncMap.lastError;
    }
    return this.enqueueIo(async () => {
      const filePath = getTelemetrySyncMapFilePath();
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(this.syncMap, null, 2), 'utf8');
    });
  }

  private async loadSyncMap(): Promise<void> {
    try {
      const raw = await readFile(getTelemetrySyncMapFilePath(), 'utf8');
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- durable sync-map file written by this service; version/shape guarded below.
      const parsed: TelemetrySyncMapFile = JSON.parse(raw);
      if (parsed.version === SYNC_MAP_VERSION && parsed.workspaces) {
        this.syncMap = parsed;
        // Hydrate persisted status so the pill shows "Synced Xm ago" on launch
        // before any new flush happens.
        this.lastSyncedAt = parsed.lastSyncedAt ?? null;
        // Validate the persisted enum rather than trusting the on-disk string;
        // a corrupted sync-map must not drive an unexpected pill state.
        const persistedLastError =
          parsed.lastError === 'upload-failed' ? 'upload-failed' : null;
        this.lastError = persistedLastError;
        this.lastErrorAt =
          persistedLastError === null ? null : (parsed.lastErrorAt ?? null);
      }
    } catch {
      // Missing/corrupt → start from an empty map.
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed || this.disposing) {
      return;
    }
    // Close ingress first so nothing new is enqueued during the final drain,
    // then drain, then mark fully disposed.
    this.disposing = true;
    // Release anyone parked on the hydration gate. A service disposed without
    // ever being started would otherwise leave them awaiting forever; they
    // re-check `disposing` after the await and bail.
    this.resolveQueueReady();
    for (const timer of Array.from(this.debounceTimers.values())) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.unsubscribeObservability?.();
    this.unsubscribeObservability = null;
    removePlanContentChangeListener(this.planContentListener);
    removePlanShareChangeListener(this.planShareListener);
    removeWorktreeSummaryChangeListener(this.summaryChangeListener);
    removeWorktreePrStatusChangeListener(this.prStatusChangeListener);
    removePipelineRunCompletionListener(this.pipelineRunCompletionListener);
    if (this.prReconciliationStartupTimer) {
      clearTimeout(this.prReconciliationStartupTimer);
      this.prReconciliationStartupTimer = null;
    }
    if (this.prReconciliationTimer) {
      clearInterval(this.prReconciliationTimer);
      this.prReconciliationTimer = null;
    }
    // Drain before marking disposed so the final flush still uploads.
    await this.flushAll().catch(() => undefined);
    this.disposed = true;
  }
}

let service: TelemetrySyncService | null = null;
let relayDeviceIdSource: () => string | null = (): null => null;

/**
 * Sets where the singleton reads this computer's relay device id. Wired by
 * the main entry, so this module never imports the Electron remote-control
 * graph; read at request build time, so wiring order does not matter.
 */
export function setTelemetryRelayDeviceIdSource(
  source: () => string | null,
): void {
  relayDeviceIdSource = source;
}

export function getTelemetrySyncService(): TelemetrySyncService {
  if (!service) {
    service = new TelemetrySyncService({
      getRelayDeviceId: (): string | null => relayDeviceIdSource(),
    });
  }
  return service;
}

export async function initializeTelemetrySyncService(): Promise<TelemetrySyncService> {
  const instance = getTelemetrySyncService();
  // A local-only build never starts the hosted telemetry sync.
  if (!allowsAutomaticCall('telemetry.sync')) return instance;
  await instance.start();
  return instance;
}
