import { createHash } from 'node:crypto';
import { assertShareScopeTarget } from './share-scope-target';
import type { BrowserWindow } from 'electron';
import { CANOPY_CLOUD_SERVER_ID } from '@canopy/desktop-shared/constants/canopy-cloud';
import {
  IPC_CHANNELS,
  type PlanComment,
  type PlanCommentThread,
  type ShareTrackedPlanRequest,
  type TrackedPlanData,
  type UnshareTrackedPlanRequest,
  type TrackedPlanShareState,
} from '@canopy/desktop-shared/types';
import {
  buildSharedPlanSnapshotInput,
  stableStringify,
  type PlanShareScope,
  type SharedPlanCreateRequest,
  type SharedPlanDetail,
  type SharedPlanRepositoryRef,
  type SharedPlanUpdateRequest,
  type WirePlanComment,
  type WirePlanCommentThread,
} from '@canopy/protocol/plans';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import {
  createSharedPlan,
  deleteSharedPlan,
  getSharedPlan,
  updateSharedPlan,
} from '../plans/canopy-server-client';
import {
  createPlanRealtimeSubscription,
  type PlanRealtimeSubscription,
} from '../plans/plan-realtime-subscription';
import {
  applyRemoteSharedPlanComments,
  getTrackedPlan,
  listTrackedPlans,
  setTrackedPlanShareState,
} from './plan-persistence';
import { logMainProcessError } from './main-process-logging';
import { buildSharedPlanRepositoryRefs } from './plan-share-repos';
import { readAllSidebarItems } from './sidebar-items';
import { sendToWindow } from './window-send';

const SYNC_DEBOUNCE_MS = 1000;
const BASE_RETRY_MS = 5000;
const MAX_RETRY_MS = 5 * 60 * 1000;

interface SyncRef {
  projectId: string;
  worktreeId: string;
  planId: string;
}

export interface StartupTrackedPlanInventoryEntry {
  projectId: string;
  worktreeId: string;
  plans: readonly TrackedPlanData[];
}

export type StartupTrackedPlanInventory =
  readonly StartupTrackedPlanInventoryEntry[];

interface SyncRuntime {
  getWindow: () => BrowserWindow | null;
}

interface SharedPlanPayloadParts {
  repositories: SharedPlanRepositoryRef[];
  snapshotHash: string;
}

let runtime: SyncRuntime = {
  getWindow: () => null,
};

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlight = new Set<string>();
const pending = new Set<string>();
const retryAttempts = new Map<string, number>();
// Hash of the comment threads last pushed per plan, so a content-unchanged sync
// only re-pushes comments when they actually changed (the server is idempotent
// either way; this just avoids redundant writes). In-memory only.
const lastPushedCommentHash = new Map<string, string>();
// Live `plan.detail` SSE subscriptions, keyed by `remoteId` and reference-counted
// by the tuples (planKeys) that need them. Multiple tracked-plan tuples across
// worktrees can point at the same remote plan; keying by remoteId opens one stream
// per distinct remote plan instead of one per tuple, and each inbound signal fans
// out to every ref currently in the bucket. Purely additive on top of the
// debounced pull loop: each signal triggers `refreshSharedPlanFromServer`.
interface RealtimeBucket {
  subscription: PlanRealtimeSubscription;
  refs: Map<string /* planKey */, SyncRef>;
}
const realtimeByRemote = new Map<string /* remoteId */, RealtimeBucket>();
const remoteByTuple = new Map<string /* planKey */, string /* remoteId */>();
// Unshares in flight by planKey (CAN-5904). While a key is here no sync, share,
// retry or realtime refresh writes share state, so nothing resurrects the share
// the unshare is clearing.
const unsharing = new Map<string, Promise<TrackedPlanData | null>>();
// Plans edited while their unshare ran; a failed unshare pushes them again.
const editedWhileUnsharing = new Set<string>();
// Sync runs and share calls in flight by planKey, which an unshare awaits
// before it clears timers, so nothing they schedule survives it.
const activeWork = new Map<string, Set<Promise<unknown>>>();

function trackWork<T>(key: string, work: Promise<T>): Promise<T> {
  let set = activeWork.get(key);
  if (!set) {
    set = new Set();
    activeWork.set(key, set);
  }
  set.add(work);
  const remove = (): void => {
    set.delete(work);
    if (set.size === 0 && activeWork.get(key) === set) {
      activeWork.delete(key);
    }
  };
  work.then(remove, remove);
  return work;
}

export function initializeSharedPlanSync(nextRuntime: SyncRuntime): void {
  runtime = nextRuntime;
  debounceTimers.forEach(clearTimeout);
  debounceTimers.clear();
  retryTimers.forEach(clearTimeout);
  retryTimers.clear();
  inFlight.clear();
  pending.clear();
  retryAttempts.clear();
  lastPushedCommentHash.clear();
  unsharing.clear();
  editedWhileUnsharing.clear();
  activeWork.clear();
  stopAllPlanRealtimeSubscriptions();
}

function commentThreadsHash(threads: WirePlanCommentThread[]): string {
  return sha256Hex(stableStringify(threads));
}

function planKey(ref: SyncRef): string {
  return `${ref.projectId}/${ref.worktreeId}/${ref.planId}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function computeSnapshotHash(
  plan: TrackedPlanData,
  repositories: SharedPlanRepositoryRef[],
): string {
  const contentHash = sha256Hex(plan.content);
  const diagramsHash = sha256Hex(stableStringify(plan.diagrams ?? null));
  const repositoriesHash = sha256Hex(stableStringify(repositories));
  return sha256Hex(
    buildSharedPlanSnapshotInput({
      contentHash,
      diagramsHash,
      repositoriesHash,
      title: plan.title,
      source: plan.source,
      reviewStatus: plan.reviewStatus,
      localRevisionNumber: plan.latestRevisionNumber,
    }),
  );
}

async function buildPayloadParts(
  plan: TrackedPlanData,
): Promise<SharedPlanPayloadParts> {
  const repositories = await buildSharedPlanRepositoryRefs(
    plan.projectId,
    plan.worktreeId,
  );
  return {
    repositories,
    snapshotHash: computeSnapshotHash(plan, repositories),
  };
}

/**
 * Map a local comment to its wire shape, dropping the renderer-only `staged` /
 * `submittedToChat` flags. Posted comments sync regardless of whether they have
 * been submitted to the chat agent yet, so the two humans can converse on the
 * shared plan before any LLM hand-off (CAN-393).
 */
function toWireComment(comment: PlanComment): WirePlanComment {
  const wire: WirePlanComment = {
    id: comment.id,
    author: comment.author,
    body: comment.body,
    createdAt: comment.createdAt,
  };
  if (comment.author === 'remote' && comment.remoteAuthor) {
    wire.remoteAuthor = comment.remoteAuthor;
  }
  return wire;
}

/**
 * Map local comment threads to the wire shape for an outbound sync payload.
 */
function toWireCommentThreads(
  threads: PlanCommentThread[] | undefined,
): WirePlanCommentThread[] {
  if (!threads || threads.length === 0) {
    return [];
  }
  return threads
    .filter((thread) => thread.comments.length > 0)
    .map((thread) => ({
      id: thread.id,
      status: thread.status,
      createdAt: thread.createdAt,
      anchor: thread.anchor,
      anchorState: thread.anchorState,
      comments: thread.comments.map(toWireComment),
    }));
}

function buildCreatePayload(
  plan: TrackedPlanData,
  parts: SharedPlanPayloadParts,
  options: {
    shareScope?: PlanShareScope;
    teamId?: string;
    organizationId?: string;
  },
): SharedPlanCreateRequest {
  const commentThreads = toWireCommentThreads(plan.commentThreads);
  return {
    clientLocalPlanId: plan.id,
    workspaceLocalId: plan.projectId,
    worktreeLocalId: plan.worktreeId,
    title: plan.title,
    content: plan.content,
    source: plan.source,
    reviewStatus: plan.reviewStatus,
    localRevisionNumber: plan.latestRevisionNumber,
    localCreatedAt: plan.createdAt,
    localUpdatedAt: plan.updatedAt,
    ...(plan.diagrams ? { diagrams: plan.diagrams } : {}),
    repositories: parts.repositories,
    snapshotHash: parts.snapshotHash,
    ...(commentThreads.length > 0 ? { commentThreads } : {}),
    shareScope: options.shareScope ?? 'private',
    ...(options.shareScope === 'team' && options.teamId
      ? { teamId: options.teamId }
      : {}),
    ...(options.shareScope === 'organization' && options.organizationId
      ? { organizationId: options.organizationId }
      : {}),
  };
}

function buildUpdatePayload(
  plan: TrackedPlanData,
  parts: SharedPlanPayloadParts,
  share: TrackedPlanShareState,
): SharedPlanUpdateRequest {
  if (!share.lastSyncedSnapshotHash) {
    throw new Error(
      'Cannot update a shared plan without a last synced snapshot hash.',
    );
  }

  const commentThreads = toWireCommentThreads(plan.commentThreads);
  return {
    clientLocalPlanId: plan.id,
    workspaceLocalId: plan.projectId,
    worktreeLocalId: plan.worktreeId,
    title: plan.title,
    content: plan.content,
    source: plan.source,
    reviewStatus: plan.reviewStatus,
    localRevisionNumber: plan.latestRevisionNumber,
    localCreatedAt: plan.createdAt,
    localUpdatedAt: plan.updatedAt,
    ...(plan.diagrams ? { diagrams: plan.diagrams } : {}),
    repositories: parts.repositories,
    snapshotHash: parts.snapshotHash,
    ...(commentThreads.length > 0 ? { commentThreads } : {}),
    expectedSnapshotHash: share.lastSyncedSnapshotHash,
  };
}

/**
 * Merge any server/web-authored comment threads returned in a `SharedPlanDetail`
 * back into the local store, emitting a plan-updated event only when the merge
 * changed something (CAN-393).
 */
async function mergeRemoteCommentsFromDetail(
  ref: SyncRef,
  remote: SharedPlanDetail,
): Promise<void> {
  const result = await applyRemoteSharedPlanComments(
    ref.projectId,
    ref.worktreeId,
    ref.planId,
    remote.commentThreads,
  );
  if (result?.changed) {
    emitPlanUpdated(result.plan);
  }
}

/**
 * Pull the latest shared plan from the server and merge its comment threads
 * into the local store (CAN-393). Used for pull-on-open, the manual refresh
 * button, and as the fallback every live `plan.detail` realtime signal
 * triggers (CAN-394; see `reconcilePlanRealtimeSubscription`). Returns the
 * (possibly updated) local plan, or null when the plan is unknown.
 */
export async function refreshSharedPlanFromServer(ref: {
  projectId: string;
  worktreeId: string;
  planId: string;
}): Promise<TrackedPlanData | null> {
  const plan = await getTrackedPlan(ref.projectId, ref.worktreeId, ref.planId);
  if (!plan) {
    return null;
  }
  if (!plan.share) {
    return plan;
  }
  const remote = await getSharedPlan(plan.share.remoteId);
  const result = await applyRemoteSharedPlanComments(
    ref.projectId,
    ref.worktreeId,
    ref.planId,
    remote.commentThreads,
  );
  if (result?.changed) {
    emitPlanUpdated(result.plan);
  }
  return result?.plan ?? plan;
}

function shareFromRemote(
  remote: SharedPlanDetail,
  previous: TrackedPlanShareState | undefined,
  overrides: Partial<TrackedPlanShareState> = {},
): TrackedPlanShareState {
  const targetIds =
    remote.shareScope === 'team' && remote.owner.type === 'team'
      ? { teamId: overrides.teamId ?? remote.owner.id }
      : remote.shareScope === 'organization' &&
          remote.owner.type === 'organization'
        ? { organizationId: overrides.organizationId ?? remote.owner.id }
        : {};

  return {
    serverId: CANOPY_CLOUD_SERVER_ID,
    remoteId: remote.id,
    shareScope: remote.shareScope,
    ...targetIds,
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
    lastSyncedLocalRevisionNumber: remote.localRevisionNumber,
    lastSyncedRemoteRevisionNumber: remote.remoteRevisionNumber,
    lastSyncedSnapshotHash: remote.snapshotHash,
    ...overrides,
  };
}

function emitPlanUpdated(plan: TrackedPlanData): void {
  sendToWindow(runtime.getWindow(), IPC_CHANNELS.trackedPlansUpdated, {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    plan,
  });
}

async function writeShareState(
  ref: SyncRef,
  share:
    | TrackedPlanShareState
    | undefined
    | ((
        current: TrackedPlanShareState | undefined,
      ) => TrackedPlanShareState | undefined),
): Promise<TrackedPlanData | null> {
  const updated = await setTrackedPlanShareState(
    ref.projectId,
    ref.worktreeId,
    ref.planId,
    share,
  );
  if (updated) {
    emitPlanUpdated(updated);
  }
  return updated;
}

async function writeShareStatus(
  ref: SyncRef,
  syncStatus: TrackedPlanShareState['syncStatus'],
  lastSyncError?: string,
): Promise<TrackedPlanData | null> {
  return writeShareState(ref, (current) =>
    current
      ? {
          ...current,
          syncStatus,
          lastSyncError,
        }
      : current,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isHttpStatus(error: unknown, status: number): boolean {
  return error instanceof CanopyCloudClientError && error.status === status;
}

function shouldStopRetryingSyncError(
  error: unknown,
  options: { includeNotFound?: boolean } = {},
): boolean {
  return (
    isHttpStatus(error, 409) ||
    isNonRetryableCloudConfigError(error) ||
    isNonRetryableCloudHttpError(error, options)
  );
}

function isNonRetryableCloudHttpError(
  error: unknown,
  options: { includeNotFound?: boolean },
): boolean {
  if (
    !(error instanceof CanopyCloudClientError) ||
    error.code !== 'http-error' ||
    error.status === undefined
  ) {
    return false;
  }

  if (error.status === 404 && options.includeNotFound !== true) {
    return false;
  }

  return error.status >= 400 && error.status < 500;
}

function isNonRetryableCloudConfigError(error: unknown): boolean {
  return (
    error instanceof CanopyCloudClientError &&
    (error.code === 'cloud-not-configured' ||
      error.code === 'missing-api-key' ||
      error.code === 'unsupported-capability')
  );
}

export function shareTrackedPlan(
  request: ShareTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  const key = planKey(request);
  if (unsharing.has(key)) {
    return Promise.reject(
      new Error('This plan is being unshared. Try again in a moment.'),
    );
  }
  return trackWork(key, shareTrackedPlanNow(request));
}

async function shareTrackedPlanNow(
  request: ShareTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  const plan = await getTrackedPlan(
    request.projectId,
    request.worktreeId,
    request.planId,
  );
  if (!plan) {
    return null;
  }
  assertShareScopeTarget(request, 'a plan');

  const ref: SyncRef = {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    planId: plan.id,
  };
  if (plan.share) {
    await writeShareStatus(ref, 'syncing');
  }

  try {
    const parts = await buildPayloadParts(plan);
    const shareScope = request.shareScope ?? 'private';
    const replacesPrivateShare =
      plan.share?.shareScope === 'private' && shareScope !== 'private';
    const createsShare = !plan.share || replacesPrivateShare;
    let remote: SharedPlanDetail;
    if (!createsShare && plan.share) {
      remote = await updateSharedPlan(
        plan.share.remoteId,
        buildUpdatePayload(plan, parts, plan.share),
      );
    } else {
      remote = await createSharedPlan(
        buildCreatePayload(plan, parts, {
          shareScope,
          teamId: request.teamId,
          organizationId: request.organizationId,
        }),
      );
    }
    const initialShareTargetIds = createsShare
      ? {
          ...(shareScope === 'team' && request.teamId
            ? { teamId: request.teamId }
            : {}),
          ...(shareScope === 'organization' && request.organizationId
            ? { organizationId: request.organizationId }
            : {}),
        }
      : {};
    const nextShare = shareFromRemote(
      remote,
      plan.share,
      initialShareTargetIds,
    );
    retryAttempts.delete(planKey(ref));

    if (createsShare) {
      const latest = await getTrackedPlan(
        ref.projectId,
        ref.worktreeId,
        ref.planId,
      );
      if (latest) {
        const latestSnapshotHash = computeSnapshotHash(
          latest,
          parts.repositories,
        );
        if (latestSnapshotHash !== parts.snapshotHash) {
          const updated = await writeShareState(ref, {
            ...nextShare,
            syncStatus: 'pending',
            lastSyncError: undefined,
          });
          if (updated) {
            reconcilePlanRealtimeSubscription(updated);
          }
          scheduleSharedPlanSync(ref);
          return updated;
        }
      }
    }

    const updated = await writeShareState(ref, nextShare);
    if (updated) {
      reconcilePlanRealtimeSubscription(updated);
    }
    await mergeRemoteCommentsFromDetail(ref, remote);
    return updated;
  } catch (error) {
    if (plan.share) {
      await writeShareStatus(ref, 'error', errorMessage(error));
    }
    throw error;
  }
}

/**
 * Mark a shared plan pending and schedule a debounced push. Best-effort and
 * safe to call from any write path: it never throws, and every detached step
 * (the pending-status write and the scheduled sync run) logs its own failure
 * instead of surfacing an unhandled rejection. The local write that prompted
 * the sync is already durable; a later edit, restart, or retry re-queues it.
 */
export function queueSharedPlanSync(
  plan: TrackedPlanData,
  reason: 'plan' | 'diagram',
): void {
  void reason;
  // A legacy private-only share is a hidden copy nobody else can read, and
  // the UI treats the plan as unshared, so background edits are not pushed.
  // Sharing it to a team or organization replaces it (see shareTrackedPlan).
  if (!plan.share || plan.share.shareScope === 'private') {
    return;
  }

  const ref: SyncRef = {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    planId: plan.id,
  };
  if (unsharing.has(planKey(ref))) {
    editedWhileUnsharing.add(planKey(ref));
    return;
  }
  void writeShareStatus(ref, 'pending').catch((error: unknown) => {
    logMainProcessError(
      `Failed to mark shared plan ${ref.planId} pending sync`,
      error,
    );
  });
  scheduleSharedPlanSync(ref);
}

function scheduleSharedPlanSync(ref: SyncRef): void {
  const key = planKey(ref);
  const retryTimer = retryTimers.get(key);
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimers.delete(key);
  }

  const existingTimer = debounceTimers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(key);
    void runSharedPlanSync(ref);
  }, SYNC_DEBOUNCE_MS);
  debounceTimers.set(key, timer);
}

export async function readStartupTrackedPlanInventory(): Promise<StartupTrackedPlanInventory> {
  const { items } = await readAllSidebarItems();
  const inventory: StartupTrackedPlanInventoryEntry[] = [];
  for (const item of items) {
    if (item.type === 'cowork') {
      continue;
    }

    for (const worktree of item.worktrees) {
      const plans = await listTrackedPlans(item.id, worktree.id).catch(
        () => [],
      );
      inventory.push({
        projectId: item.id,
        worktreeId: worktree.id,
        plans,
      });
    }
  }
  return inventory;
}

export function queueSharedPlanSyncForInventory(
  inventory: StartupTrackedPlanInventory,
): void {
  for (const entry of inventory) {
    for (const plan of entry.plans) {
      if (plan.share) {
        queueSharedPlanSync(plan, 'plan');
      }
    }
  }
}

export async function queueSharedPlanSyncForAllTrackedPlans(): Promise<void> {
  queueSharedPlanSyncForInventory(await readStartupTrackedPlanInventory());
}

/**
 * Remove a tuple from its remote-plan bucket's ref set. When the bucket has no
 * remaining refs, stop its shared subscription and drop the bucket.
 */
function removeTupleFromRealtimeBucket(remoteId: string, key: string): void {
  const bucket = realtimeByRemote.get(remoteId);
  if (!bucket) {
    return;
  }
  bucket.refs.delete(key);
  if (bucket.refs.size === 0) {
    bucket.subscription.stop();
    realtimeByRemote.delete(remoteId);
  }
}

/**
 * Reconcile the live `plan.detail` subscription for a single tracked plan.
 * Subscriptions are keyed by `remoteId` and reference-counted by tuple: joining
 * a plan to a remote id reuses the existing shared stream (opening one only if it
 * is the first ref), and unsharing (or a remote-id change) drops the tuple's ref,
 * stopping the shared stream once the last tuple leaves. Each inbound signal
 * triggers the existing pull for every ref, so this stays purely additive on top
 * of the debounced loop.
 */
function reconcilePlanRealtimeSubscription(plan: TrackedPlanData): void {
  const ref: SyncRef = {
    projectId: plan.projectId,
    worktreeId: plan.worktreeId,
    planId: plan.id,
  };
  const key = planKey(ref);
  const nextRemoteId = plan.share?.remoteId;
  const prevRemoteId = remoteByTuple.get(key);

  if (prevRemoteId && prevRemoteId !== nextRemoteId) {
    removeTupleFromRealtimeBucket(prevRemoteId, key);
    remoteByTuple.delete(key);
  }

  if (!nextRemoteId) {
    return;
  }

  if (prevRemoteId === nextRemoteId) {
    // Already subscribed for this tuple against this remote id.
    return;
  }

  let bucket = realtimeByRemote.get(nextRemoteId);
  if (!bucket) {
    const refs = new Map<string, SyncRef>();
    const subscription = createPlanRealtimeSubscription({
      remoteId: nextRemoteId,
      onSignal: (): void => {
        refs.forEach((bucketRef) => {
          // The final signal of our own unshare: the plan is gone remotely.
          if (unsharing.has(planKey(bucketRef))) {
            return;
          }
          void refreshSharedPlanFromServer(bucketRef).catch(() => undefined);
        });
      },
    });
    bucket = { subscription, refs };
    realtimeByRemote.set(nextRemoteId, bucket);
  }
  bucket.refs.set(key, ref);
  remoteByTuple.set(key, nextRemoteId);
}

/**
 * Add/remove the live subscription for a plan as it becomes shared/unshared.
 * Wired to the plan-share change listener.
 */
export function syncPlanRealtimeSubscription(plan: TrackedPlanData): void {
  reconcilePlanRealtimeSubscription(plan);
}

/** Start live subscriptions for all currently tracked shared plans (startup). */
export function startPlanRealtimeSubscriptionsForInventory(
  inventory: StartupTrackedPlanInventory,
): void {
  for (const entry of inventory) {
    for (const plan of entry.plans) {
      if (plan.share) {
        reconcilePlanRealtimeSubscription(plan);
      }
    }
  }
}

export async function startAllPlanRealtimeSubscriptions(): Promise<void> {
  startPlanRealtimeSubscriptionsForInventory(
    await readStartupTrackedPlanInventory(),
  );
}

/**
 * Build the immutable startup inventory once, then fan it out to both startup
 * consumers. This avoids rereading the sidebar and every tracked-plan file
 * while preserving the independently callable sweep helpers used after
 * startup and by focused tests.
 */
export async function initializeSharedPlanStartup(): Promise<void> {
  const inventory = await readStartupTrackedPlanInventory();
  queueSharedPlanSyncForInventory(inventory);
  startPlanRealtimeSubscriptionsForInventory(inventory);
}

/** Stop all live subscriptions (app quit / sync re-init). */
export function stopAllPlanRealtimeSubscriptions(): void {
  realtimeByRemote.forEach((bucket) => bucket.subscription.stop());
  realtimeByRemote.clear();
  remoteByTuple.clear();
}

/**
 * Run one sync for a plan, coalescing overlapping runs. Never rejects: every
 * caller detaches it from a timer or a finished run, so a persistence failure
 * that escapes the sync's own error handling (a failed status write, an
 * unreadable plans file) is logged here instead of becoming an unhandled
 * rejection.
 */
async function runSharedPlanSync(ref: SyncRef): Promise<void> {
  const key = planKey(ref);
  if (unsharing.has(key)) {
    return;
  }
  if (inFlight.has(key)) {
    pending.add(key);
    return;
  }
  inFlight.add(key);

  try {
    await trackWork(key, syncLatestPlan(ref));
  } catch (error) {
    logMainProcessError(
      `Shared-plan sync failed for plan ${ref.planId}`,
      error,
    );
  } finally {
    inFlight.delete(key);
    if (pending.has(key)) {
      pending.delete(key);
      void runSharedPlanSync(ref);
    }
  }
}

async function syncLatestPlan(ref: SyncRef): Promise<void> {
  if (unsharing.has(planKey(ref))) {
    return;
  }
  const plan = await getTrackedPlan(ref.projectId, ref.worktreeId, ref.planId);
  if (!plan?.share) {
    return;
  }

  await writeShareStatus(ref, 'syncing');

  try {
    const latest = await getTrackedPlan(
      ref.projectId,
      ref.worktreeId,
      ref.planId,
    );
    if (!latest?.share) {
      return;
    }
    const key = planKey(ref);
    const parts = await buildPayloadParts(latest);
    if (parts.snapshotHash === latest.share.lastSyncedSnapshotHash) {
      // Plan content is unchanged, but comments are excluded from the snapshot
      // hash. Push local comments up (so the teammate sees the owner's replies)
      // only when they changed since the last push, and always pull web-authored
      // comments back. A comment-sync failure must not fail the sync.
      try {
        const localThreads = toWireCommentThreads(latest.commentThreads);
        const commentHash = commentThreadsHash(localThreads);
        const shouldPush =
          localThreads.length > 0 &&
          commentHash !== lastPushedCommentHash.get(key);
        const remote = shouldPush
          ? await updateSharedPlan(
              latest.share.remoteId,
              buildUpdatePayload(latest, parts, latest.share),
            )
          : await getSharedPlan(latest.share.remoteId);
        await mergeRemoteCommentsFromDetail(ref, remote);
        if (shouldPush) {
          lastPushedCommentHash.set(key, commentHash);
        }
      } catch {
        // Non-fatal: the next sync / manual refresh retries the comment sync.
      }
      await writeShareStatus(ref, 'synced');
      retryAttempts.delete(key);
      return;
    }

    const remote = await updateSharedPlan(
      latest.share.remoteId,
      buildUpdatePayload(latest, parts, latest.share),
    );
    await writeShareState(ref, shareFromRemote(remote, latest.share));
    await mergeRemoteCommentsFromDetail(ref, remote);
    lastPushedCommentHash.set(
      key,
      commentThreadsHash(toWireCommentThreads(latest.commentThreads)),
    );
    retryAttempts.delete(key);
  } catch (error) {
    await handleSyncError(ref, error);
  }
}

async function handleSyncError(ref: SyncRef, error: unknown): Promise<void> {
  const plan = await getTrackedPlan(ref.projectId, ref.worktreeId, ref.planId);
  if (!plan?.share) {
    return;
  }

  await persistSyncError(
    ref,
    error,
    shouldStopRetryingSyncError(error, { includeNotFound: true }),
  );
}

async function persistSyncError(
  ref: SyncRef,
  error: unknown,
  stopRetry: boolean,
): Promise<void> {
  if (unsharing.has(planKey(ref))) {
    return;
  }
  const message = isHttpStatus(error, 409)
    ? 'The shared plan changed on the server. Review the cloud copy before syncing again.'
    : errorMessage(error);
  await writeShareStatus(ref, 'error', message);

  if (stopRetry) {
    return;
  }

  const key = planKey(ref);
  const attempt = (retryAttempts.get(key) ?? 0) + 1;
  retryAttempts.set(key, attempt);
  const delay = Math.min(BASE_RETRY_MS * 2 ** (attempt - 1), MAX_RETRY_MS);
  const timer = setTimeout(() => {
    retryTimers.delete(key);
    void runSharedPlanSync(ref);
  }, delay);
  retryTimers.set(key, timer);
}

/**
 * Stop sharing a tracked plan (CAN-5904): delete the cloud copy, then clear
 * the local `share`. A second call while one runs answers the same promise.
 *
 * In order: the key joins `unsharing`, so no new sync, share, retry or
 * realtime refresh writes share state; work already in flight is awaited;
 * only then are its timers and per-plan sync state dropped, so nothing it
 * scheduled survives. A share whose first push never succeeded has no
 * `remoteId` and clears without a network call. A cloud copy that is already
 * gone (`unshared: false`) still clears. Any other failure (offline, 5xx)
 * leaves the share as it was and rethrows, so the caller can show it; there
 * is no local-only unshare.
 *
 * Only `share` is cleared. The local plan content and its comment threads,
 * teammate comments merged in by `applyRemoteSharedPlanComments` included,
 * stay in the local plan file.
 */
export function unshareTrackedPlan(
  request: UnshareTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  const ref: SyncRef = {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    planId: request.planId,
  };
  const key = planKey(ref);
  const existing = unsharing.get(key);
  if (existing) {
    return existing;
  }
  const run = (async (): Promise<TrackedPlanData | null> => {
    try {
      await Promise.allSettled([...(activeWork.get(key) ?? [])]);
      clearTimeout(debounceTimers.get(key));
      debounceTimers.delete(key);
      clearTimeout(retryTimers.get(key));
      retryTimers.delete(key);
      retryAttempts.delete(key);
      pending.delete(key);
      lastPushedCommentHash.delete(key);

      const plan = await getTrackedPlan(
        ref.projectId,
        ref.worktreeId,
        ref.planId,
      );
      if (!plan) {
        return null;
      }
      if (!plan.share) {
        reconcilePlanRealtimeSubscription(plan);
        return plan;
      }
      // `remoteId` is typed as required, but a share whose first push never
      // succeeded may have persisted without one.
      if (plan.share.remoteId) {
        try {
          await deleteSharedPlan(plan.share.remoteId);
        } catch (error) {
          // The share stays, but its timers and pending state were dropped
          // above and edits made meanwhile were not queued. Push once more
          // when anything was left unpushed; a synced share stays as it was.
          unsharing.delete(key);
          if (
            plan.share.syncStatus !== 'synced' ||
            editedWhileUnsharing.has(key)
          ) {
            scheduleSharedPlanSync(ref);
          }
          throw error;
        }
      }
      const updated = await writeShareState(ref, undefined);
      if (updated) {
        reconcilePlanRealtimeSubscription(updated);
      }
      return updated;
    } finally {
      unsharing.delete(key);
      editedWhileUnsharing.delete(key);
    }
  })();
  unsharing.set(key, run);
  return run;
}
