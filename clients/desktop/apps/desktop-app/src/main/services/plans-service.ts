import type {
  CreateTrackedPlanRequest,
  RemoteControlPlanDetail,
  RemoteControlPlanSummary,
  SaveTrackedPlanCommentsRequest,
  ShareTrackedPlanRequest,
  UnshareTrackedPlanRequest,
  TrackedPlanData,
  TrackedPlanGetRequest,
  TrackedPlanListRequest,
} from '@canopy/desktop-shared/types';
import { type RemoteControlPlanGetPayload } from '@canopy/protocol/remote-control/shell';
import {
  getTrackedPlan,
  listTrackedPlans,
  saveTrackedPlanComments,
} from '../lib/plan-persistence';
import { validateId } from '../lib/validation';
import { shareTrackedPlan, unshareTrackedPlan } from '../lib/shared-plan-sync';
import { SHARED_CONTAINER_VIEWER_PROJECT_ID } from '@canopy/desktop-shared/types';
import { assertWritableScope } from '../lib/read-only-scope';
import { listViewerPlans } from '../lib/shared-container-viewer-plans';
import { desktopPlanOperations } from '../canopy-runtime/plan-operations';
import {
  planToRemoteControlEntity,
  toPlanSummary,
  toRequestedPlanDetail,
} from './plan-remote-control-projection';

export { planToRemoteControlEntity };

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

export function createTrackedPlanData(
  request: CreateTrackedPlanRequest,
): Promise<TrackedPlanData> {
  return desktopPlanOperations.create(request);
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
