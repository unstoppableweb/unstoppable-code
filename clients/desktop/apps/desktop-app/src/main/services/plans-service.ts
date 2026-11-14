import type {
  CreateTrackedPlanRequest,
  DeleteTrackedPlanRequest,
  PortalEntityEnvelope,
  PortalPlanDetail,
  PortalPlanSummary,
  SaveTrackedPlanCommentsRequest,
  ShareTrackedPlanRequest,
  UnshareTrackedPlanRequest,
  TrackedPlanData,
  TrackedPlanGetRequest,
  TrackedPlanListRequest,
  TrackedPlanListWithSkippedResult,
  TrackedPlanSource,
  UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { BrowserWindow } from 'electron';
import {
  worktreeScopedParentLocalId,
  type PortalPlanGetPayload,
} from '@canopy/protocol/portal';
import {
  createTrackedPlan,
  deleteTrackedPlan,
  getTrackedPlan,
  listTrackedPlans,
  listTrackedPlansWithSkipped,
  saveTrackedPlanComments,
  updateTrackedPlan,
} from '../lib/plan-persistence';
import { validateId } from '../lib/validation';
import {
  emitPortalFeatureRemove,
  emitPortalFeatureUpsert,
} from './portal-feature-event-service';
import { shareTrackedPlan, unshareTrackedPlan } from '../lib/shared-plan-sync';
import { sendToWindow } from '../lib/window-send';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { getSharedContainerReader } from '../shared-containers/read/reader';
import { resolveSharedContainerViewerReadRoots } from '../shared-containers/read/viewer-root';
import { assertWritableScope } from '../lib/read-only-scope';

type PlanMutationOptions = {
  portalCommandId?: string;
  getWindow?: () => BrowserWindow | null;
};

function emitTrackedPlanUpdate(
  plan: TrackedPlanData,
  options: PlanMutationOptions,
): void {
  sendToWindow(
    options.getWindow?.() ?? null,
    IPC_CHANNELS.trackedPlansUpdated,
    {
      projectId: plan.projectId,
      worktreeId: plan.worktreeId,
      plan,
      change: 'upsert',
    },
  );
}

function emitTrackedPlanRemoval(
  request: DeleteTrackedPlanRequest,
  plan: TrackedPlanData | null,
  options: PlanMutationOptions,
): void {
  sendToWindow(
    options.getWindow?.() ?? null,
    IPC_CHANNELS.trackedPlansUpdated,
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      planId: request.planId,
      ...(plan ? { plan } : {}),
      change: 'remove',
    },
  );
}

function validateWorktreeIds(request: TrackedPlanListRequest): void {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
}

const TRACKED_PLAN_SOURCES = new Set<TrackedPlanSource>([
  'cursor',
  'claude',
  'codex',
  'opencode',
  'ollama',
  'pipeline',
  'imported',
  'detected',
]);

async function listViewerPlans(
  request: TrackedPlanListRequest,
): Promise<TrackedPlanData[]> {
  const roots = await resolveSharedContainerViewerReadRoots(request.worktreeId);
  const revisionId = roots[0]?.revisionId;
  if (!revisionId) return [];
  const reader = getSharedContainerReader();
  const summaries = [];
  let cursor: string | undefined;
  do {
    const page = await reader.listPlans({
      containerId: request.worktreeId,
      revisionId,
      ...(cursor ? { cursor } : {}),
      limit: 100,
    });
    summaries.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return Promise.all(
    summaries.map(async ({ planId }) => {
      const plan = await reader.readPlan({
        containerId: request.worktreeId,
        revisionId,
        planId,
      });
      const source = TRACKED_PLAN_SOURCES.has(plan.source as TrackedPlanSource)
        ? (plan.source as TrackedPlanSource)
        : 'imported';
      const reviewStatus =
        plan.reviewStatus === 'approved' || plan.reviewStatus === 'dismissed'
          ? plan.reviewStatus
          : 'pending';
      return {
        id: plan.planId,
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        source,
        title: plan.title,
        content: plan.content,
        reviewStatus,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
        latestRevisionNumber: plan.latestRevisionNumber,
        ...(plan.approvedAt ? { approvedAt: plan.approvedAt } : {}),
        ...(plan.dismissedAt ? { dismissedAt: plan.dismissedAt } : {}),
        revisions: [],
        linkedExecutionIds: [],
        commentThreads: plan.commentThreads,
        ...(plan.lastEditSource === 'agent' ||
        plan.lastEditSource === 'pipeline'
          ? { lastEditSource: plan.lastEditSource }
          : {}),
        ...(plan.sourceRepoId ? { sourceRepoId: plan.sourceRepoId } : {}),
        ...(plan.sourceFilePath ? { sourceFilePath: plan.sourceFilePath } : {}),
      } satisfies TrackedPlanData;
    }),
  );
}

/**
 * Delete the plan row, then reclaim its plan-explore state on behalf of the
 * owning worktree: the scoped plan file, and — only when the takeover
 * registry row is absent or owned by this worktree — the sentinel chat scope
 * (transcript, manifest, attachments, runtime metadata, registry row). The
 * explore cleanup never blocks the deletion: on failure the registry row
 * stays behind so the owning worktree's cleanup sweep reclaims it later.
 */
async function deleteTrackedPlanWithExploreChat(
  request: DeleteTrackedPlanRequest,
): Promise<void> {
  await deleteTrackedPlan(
    request.projectId,
    request.worktreeId,
    request.planId,
  );
  // Deferred on purpose: the explore cleanup pulls in the chat-state, search,
  // and live session teardown services, which importing the plans service
  // alone must not initialize.
  const { removePlanExploreChat } = await import('../lib/plan-explore-cleanup');
  await removePlanExploreChat(request.planId, {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  }).catch(() => undefined);
}

function toPlanSummary(plan: TrackedPlanData): PortalPlanSummary {
  return {
    workspaceLocalId: plan.projectId,
    worktreeLocalId: plan.worktreeId,
    planId: plan.id,
    title: plan.title,
    status: plan.reviewStatus,
    source: plan.source,
    // Only imported plans name their source file; detected plans keep the
    // path as a local dedup key and agent plans have none.
    ...(plan.source === 'imported' && plan.sourceFilePath
      ? { sourceFilePath: plan.sourceFilePath }
      : {}),
    updatedAt: plan.updatedAt,
  };
}

function toPlanDetail(plan: TrackedPlanData): PortalPlanDetail {
  return {
    ...toPlanSummary(plan),
    // Transport plan §1.4: `content` is the canonical markdown body field.
    // `body` is retained for backward compatibility with pre-rollout
    // payloads — emitters MUST populate `content` and consumers MAY fall
    // back to `body` for in-flight legacy frames.
    content: plan.content,
    body: plan.content,
    reviewStatus: plan.reviewStatus,
    approvedAt: plan.approvedAt ?? null,
    dismissedAt: plan.dismissedAt ?? null,
    hidden: plan.hidden,
    latestRevisionNumber: plan.latestRevisionNumber,
    // Mirror the canonical revision counter under the shorter alias too so
    // renderers that just want "v3" can read `revisionNumber` directly.
    revisionNumber: plan.latestRevisionNumber,
  };
}

/** Historical reads must never substitute the current revision's Markdown. */
function toRequestedPlanDetail(
  plan: TrackedPlanData,
  revisionNumber: number | undefined,
): PortalPlanDetail | null {
  const detail = toPlanDetail(plan);
  if (
    revisionNumber === undefined ||
    revisionNumber === plan.latestRevisionNumber
  ) {
    return detail;
  }
  const revision = plan.revisions.find(
    (candidate) => candidate.revisionNumber === revisionNumber,
  );
  if (!revision) return null;
  return {
    ...detail,
    content: revision.content,
    body: revision.content,
    revisionNumber: revision.revisionNumber,
    source: revision.source,
    status: revision.reviewStatus,
    reviewStatus: revision.reviewStatus,
    approvedAt: revision.approvedAt ?? null,
    dismissedAt: revision.dismissedAt ?? null,
  };
}

export async function listPlans(
  request: TrackedPlanListRequest,
): Promise<PortalPlanSummary[]> {
  validateWorktreeIds(request);
  const plans =
    request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID
      ? await listViewerPlans(request)
      : await listTrackedPlans(request.projectId, request.worktreeId);
  return plans.map(toPlanSummary);
}

export async function listTrackedPlanData(
  request: TrackedPlanListRequest,
): Promise<TrackedPlanData[]> {
  validateWorktreeIds(request);
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return listViewerPlans(request);
  }
  return listTrackedPlans(request.projectId, request.worktreeId);
}

/** `listTrackedPlanData`, with the stored records it left out (CAN-6666). */
export async function listTrackedPlanDataWithSkipped(
  request: TrackedPlanListRequest,
): Promise<TrackedPlanListWithSkippedResult> {
  validateWorktreeIds(request);
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return { plans: await listViewerPlans(request) };
  }
  return listTrackedPlansWithSkipped(request.projectId, request.worktreeId);
}

export async function readPlan(
  request: PortalPlanGetPayload,
  options: { portalCommandId?: string } = {},
): Promise<PortalPlanDetail | null> {
  validateWorktreeIds(request);
  validateId(request.planId, 'planId');
  if (
    request.revisionNumber !== undefined &&
    (!Number.isSafeInteger(request.revisionNumber) ||
      request.revisionNumber < 1)
  ) {
    throw new Error('revisionNumber must be a positive safe integer.');
  }
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    const plan =
      (await listViewerPlans(request)).find(
        (plan) => plan.id === request.planId,
      ) ?? null;
    return plan ? toRequestedPlanDetail(plan, request.revisionNumber) : null;
  }
  const plan = await getTrackedPlan(
    request.projectId,
    request.worktreeId,
    request.planId,
  );
  const detail = plan
    ? toRequestedPlanDetail(plan, request.revisionNumber)
    : null;
  // A pinned read is a query result, not a change to the live Plans card.
  if (detail && request.revisionNumber === undefined) {
    emitPortalFeatureUpsert({
      type: 'portal.plan.event',
      commandId: options.portalCommandId,
      entity: planToPortalEntity(detail),
    });
  }
  return detail;
}

export async function readTrackedPlanData(
  request: TrackedPlanGetRequest,
): Promise<TrackedPlanData | null> {
  validateWorktreeIds(request);
  validateId(request.planId, 'planId');
  if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID) {
    return (
      (await listViewerPlans(request)).find(
        (plan) => plan.id === request.planId,
      ) ?? null
    );
  }
  const plan = await getTrackedPlan(
    request.projectId,
    request.worktreeId,
    request.planId,
  );
  if (plan) {
    emitPortalFeatureUpsert({
      type: 'portal.plan.event',
      entity: planToPortalEntity(toPlanDetail(plan)),
    });
  }
  return plan;
}

export async function createPlan(
  request: CreateTrackedPlanRequest,
  options: PlanMutationOptions = {},
): Promise<PortalPlanDetail> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  const plan = await createTrackedPlan(request);
  const detail = toPlanDetail(plan);
  emitPortalFeatureUpsert({
    type: 'portal.plan.event',
    commandId: options.portalCommandId,
    entity: planToPortalEntity(detail),
  });
  emitTrackedPlanUpdate(plan, options);
  return detail;
}

export async function createTrackedPlanData(
  request: CreateTrackedPlanRequest,
): Promise<TrackedPlanData> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  const plan = await createTrackedPlan(request);
  emitPortalFeatureUpsert({
    type: 'portal.plan.event',
    entity: planToPortalEntity(toPlanDetail(plan)),
  });
  return plan;
}

export async function updatePlan(
  request: UpdateTrackedPlanRequest,
  options: PlanMutationOptions = {},
): Promise<PortalPlanDetail | null> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  const plan = await updateTrackedPlan(request);
  const detail = plan ? toPlanDetail(plan) : null;
  if (plan && detail) {
    emitPortalFeatureUpsert({
      type: 'portal.plan.event',
      commandId: options.portalCommandId,
      entity: planToPortalEntity(detail),
    });
    emitTrackedPlanUpdate(plan, options);
  }
  return detail;
}

/** Record only the plan revision that the user explicitly chose to implement. */
export async function approveOpenCodePlanReview(request: {
  projectId: string;
  worktreeId: string;
  chatId: string;
  planId: string;
  revisionNumber: number;
  approvedAt: string;
}): Promise<boolean> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  const plan = await updateTrackedPlan(
    {
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      planId: request.planId,
      chatId: request.chatId,
      reviewStatus: 'approved',
      approvedAt: request.approvedAt,
      dismissedAt: null,
      initiationSource: 'user',
    },
    {
      revisionNumber: request.revisionNumber,
      source: 'opencode',
    },
  );
  if (!plan) return false;
  emitPortalFeatureUpsert({
    type: 'portal.plan.event',
    entity: planToPortalEntity(toPlanDetail(plan)),
  });
  return true;
}

export async function updateTrackedPlanData(
  request: UpdateTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  const plan = await updateTrackedPlan(request);
  if (plan) {
    emitPortalFeatureUpsert({
      type: 'portal.plan.event',
      entity: planToPortalEntity(toPlanDetail(plan)),
    });
  }
  return plan;
}

export async function saveTrackedPlanCommentsData(
  request: SaveTrackedPlanCommentsRequest,
): Promise<TrackedPlanData | null> {
  validateId(request.projectId, 'projectId');
  assertWritableScope(request.projectId);
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.planId, 'planId');
  const plan = await saveTrackedPlanComments(request);
  if (plan) {
    emitPortalFeatureUpsert({
      type: 'portal.plan.event',
      entity: planToPortalEntity(toPlanDetail(plan)),
    });
  }
  return plan;
}

export async function shareTrackedPlanData(
  request: ShareTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  const plan = await shareTrackedPlan(request);
  if (plan) {
    emitPortalFeatureUpsert({
      type: 'portal.plan.event',
      entity: planToPortalEntity(toPlanDetail(plan)),
    });
  }
  return plan;
}

/** Stop sharing a tracked plan (CAN-5904); the answered plan has no `share`. */
export async function unshareTrackedPlanData(
  request: UnshareTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  const plan = await unshareTrackedPlan(request);
  if (plan) {
    emitPortalFeatureUpsert({
      type: 'portal.plan.event',
      entity: planToPortalEntity(toPlanDetail(plan)),
    });
  }
  return plan;
}

export async function deletePlan(
  request: DeleteTrackedPlanRequest,
  options: PlanMutationOptions = {},
): Promise<{ ok: true }> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  // Read the plan before it is gone so the renderer event can include its last
  // known data. A corrupt or unreadable file still emits a plan-id tombstone.
  const plan = await getTrackedPlan(
    request.projectId,
    request.worktreeId,
    request.planId,
  ).catch(() => null);
  await deleteTrackedPlanWithExploreChat(request);
  emitPortalFeatureRemove({
    type: 'portal.plan.event',
    commandId: options.portalCommandId,
    entityType: 'plan',
    localId: request.planId,
    parentLocalId: worktreeScopedParentLocalId(
      request.projectId,
      request.worktreeId,
    ),
  });
  emitTrackedPlanRemoval(request, plan, options);
  return { ok: true };
}

export async function deleteTrackedPlanData(
  request: DeleteTrackedPlanRequest,
): Promise<void> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  await deleteTrackedPlanWithExploreChat(request);
  emitPortalFeatureRemove({
    type: 'portal.plan.event',
    entityType: 'plan',
    localId: request.planId,
    parentLocalId: worktreeScopedParentLocalId(
      request.projectId,
      request.worktreeId,
    ),
  });
}

export function planToPortalEntity(
  plan: PortalPlanSummary,
): PortalEntityEnvelope {
  return {
    entityType: 'plan',
    localId: plan.planId,
    parentLocalId: worktreeScopedParentLocalId(
      plan.workspaceLocalId,
      plan.worktreeLocalId,
    ),
    payload: plan,
  };
}

/**
 * What this process has already published to the portal, keyed
 * `${projectId}:${worktreeId}` then plan id, with a serialized detail payload
 * as the change fingerprint. In-memory only: a restart republishes on the first
 * write, and an upsert is idempotent.
 */
const publishedPlanDetails = new Map<string, Map<string, string>>();

/**
 * Publish a worktree's tracked plans to the portal (CAN-3019).
 *
 * Every mutator in this module emits its own `portal.plan.event`, but the
 * agent's plan-mode path never calls them: `ExitPlanMode` routes through
 * `upsertTrackedPlan` in `agents/claude-session.ts`, which writes through
 * `lib/plan-persistence` directly. Plans authored by an agent — the ordinary
 * way a plan gets made — were therefore invisible to Remote Control until some
 * later worktree-scoped snapshot happened to include them, which is why the web
 * Plans card stayed absent while desktop showed the plan.
 *
 * Registered against the tracked-plans write hook, which fires after EVERY
 * write to the file (agent plans, imports, pipeline `plan_ready`, comment and
 * share updates, deletes), so this one subscriber covers every writer rather
 * than each of them remembering to publish. Unchanged plans are skipped: those
 * other writers rewrite the file often, and a plan body is not a cheap payload.
 */
export function syncTrackedPlansToPortal(
  projectId: string,
  worktreeId: string,
  plans: readonly TrackedPlanData[],
): void {
  const worktreeKey = `${projectId}:${worktreeId}`;
  const published: ReadonlyMap<string, string> =
    publishedPlanDetails.get(worktreeKey) ?? new Map<string, string>();
  const next = new Map<string, string>();

  for (const plan of plans) {
    const detail = toPlanDetail(plan);
    const fingerprint = JSON.stringify(detail);
    next.set(plan.id, fingerprint);
    if (published.get(plan.id) === fingerprint) continue;
    emitPortalFeatureUpsert({
      type: 'portal.plan.event',
      entity: planToPortalEntity(detail),
    });
  }

  published.forEach((_fingerprint, planId) => {
    if (next.has(planId)) return;
    emitPortalFeatureRemove({
      type: 'portal.plan.event',
      entityType: 'plan',
      localId: planId,
      parentLocalId: worktreeScopedParentLocalId(projectId, worktreeId),
    });
  });

  publishedPlanDetails.set(worktreeKey, next);
}
