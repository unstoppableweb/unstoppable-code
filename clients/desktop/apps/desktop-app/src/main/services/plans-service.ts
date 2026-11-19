import type {
  CreateTrackedPlanRequest,
  DeleteTrackedPlanRequest,
  RemoteControlPlanDetail,
  RemoteControlPlanSummary,
  SaveTrackedPlanCommentsRequest,
  ShareTrackedPlanRequest,
  UnshareTrackedPlanRequest,
  TrackedPlanData,
  TrackedPlanGetRequest,
  TrackedPlanListRequest,
  TrackedPlanListWithSkippedResult,
  UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { BrowserWindow } from 'electron';
import { type RemoteControlPlanGetPayload } from '@canopy/protocol/remote-control/shell';
import {
  createTrackedPlan,
  getTrackedPlan,
  listTrackedPlans,
  saveTrackedPlanComments,
  updateTrackedPlan,
} from '../lib/plan-persistence';
import { validateId } from '../lib/validation';
import { shareTrackedPlan, unshareTrackedPlan } from '../lib/shared-plan-sync';
import { sendToWindow } from '../lib/window-send';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { assertWritableScope } from '../lib/read-only-scope';
import { listViewerPlans } from '../lib/shared-container-viewer-plans';
import {
  deleteTrackedPlanWithExploreChat,
  desktopPlanOperations,
} from '../canopy-runtime/plan-operations';
import {
  planToRemoteControlEntity,
  toPlanDetail,
  toPlanSummary,
  toRequestedPlanDetail,
} from './plan-remote-control-projection';

export { planToRemoteControlEntity };

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

export async function listPlans(
  request: TrackedPlanListRequest,
): Promise<RemoteControlPlanSummary[]> {
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
  return (await desktopPlanOperations.list(request)).plans;
}

/** `listTrackedPlanData`, with the stored records it left out (CAN-6666). */
export function listTrackedPlanDataWithSkipped(
  request: TrackedPlanListRequest,
): Promise<TrackedPlanListWithSkippedResult> {
  return desktopPlanOperations.list(request);
}

export async function readPlan(
  request: RemoteControlPlanGetPayload,
): Promise<RemoteControlPlanDetail | null> {
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
  return plan ? toRequestedPlanDetail(plan, request.revisionNumber) : null;
}

export function readTrackedPlanData(
  request: TrackedPlanGetRequest,
): Promise<TrackedPlanData | null> {
  return desktopPlanOperations.get(request);
}

export async function createPlan(
  request: CreateTrackedPlanRequest,
  options: PlanMutationOptions = {},
): Promise<RemoteControlPlanDetail> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  const plan = await createTrackedPlan(request);
  const detail = toPlanDetail(plan);
  emitTrackedPlanUpdate(plan, options);
  return detail;
}

export function createTrackedPlanData(
  request: CreateTrackedPlanRequest,
): Promise<TrackedPlanData> {
  return desktopPlanOperations.create(request);
}

export async function updatePlan(
  request: UpdateTrackedPlanRequest,
  options: PlanMutationOptions = {},
): Promise<RemoteControlPlanDetail | null> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  const plan = await updateTrackedPlan(request);
  const detail = plan ? toPlanDetail(plan) : null;
  if (plan) {
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
  return plan !== null;
}

export function updateTrackedPlanData(
  request: UpdateTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  return desktopPlanOperations.update(request);
}

export async function saveTrackedPlanCommentsData(
  request: SaveTrackedPlanCommentsRequest,
): Promise<TrackedPlanData | null> {
  validateId(request.projectId, 'projectId');
  assertWritableScope(request.projectId);
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.planId, 'planId');
  const plan = await saveTrackedPlanComments(request);
  return plan;
}

export async function shareTrackedPlanData(
  request: ShareTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  validateWorktreeIds(request);
  assertWritableScope(request.projectId);
  validateId(request.planId, 'planId');
  const plan = await shareTrackedPlan(request);
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
  emitTrackedPlanRemoval(request, plan, options);
  return { ok: true };
}

export async function deleteTrackedPlanData(
  request: DeleteTrackedPlanRequest,
): Promise<void> {
  await desktopPlanOperations.delete(request);
}
