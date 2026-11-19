import { CanopyOperationError } from '@canopy/core-runtime';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type CreateTrackedPlanRequest,
  type DeleteTrackedPlanRequest,
  type TrackedPlanData,
  type TrackedPlanGetRequest,
  type TrackedPlanListRequest,
  type TrackedPlanListWithSkippedResult,
  type UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import { PLAN_ERROR_CODES } from '@canopy/protocol/canopy-core';
import {
  createTrackedPlan,
  deleteTrackedPlan,
  getTrackedPlan,
  listTrackedPlansWithSkipped,
  updateTrackedPlan,
} from '../lib/plan-persistence';
import { READ_ONLY_SCOPE_ERROR, isWritableScope } from '../lib/read-only-scope';
import { resolveTrackedPlansFilePath } from '../lib/resolve-worktree';
import { listViewerPlans } from '../lib/shared-container-viewer-plans';
import { validateId } from '../lib/validation';
import { isCoworkWorkspace } from '../lib/workspace-registry';

/*
 * The tracked-plan lifecycle as desktop serves it (CAN-4165): scope policy,
 * and the plan engine behind plan-persistence. `core.plan.*` on the desktop dispatcher runs these, and so
 * do the in-process callers that have not moved onto the dispatcher yet.
 */

export type UpdateTrackedPlanInput = UpdateTrackedPlanRequest & {
  /** With it, a write against another revision is refused. */
  expectedRevision?: number;
};

export interface DesktopPlanOperations {
  list(
    request: TrackedPlanListRequest,
  ): Promise<TrackedPlanListWithSkippedResult>;
  get(request: TrackedPlanGetRequest): Promise<TrackedPlanData | null>;
  create(request: CreateTrackedPlanRequest): Promise<TrackedPlanData>;
  update(request: UpdateTrackedPlanInput): Promise<TrackedPlanData | null>;
  /** False when the worktree did not have the plan. */
  delete(request: DeleteTrackedPlanRequest): Promise<boolean>;
}

function validateScope(request: TrackedPlanListRequest): void {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
}

/** Shared-container recipient scopes stay read-only for every caller. */
function assertWritable(projectId: string): void {
  if (isWritableScope(projectId)) return;
  const cause = new Error(READ_ONLY_SCOPE_ERROR);
  throw new CanopyOperationError(
    {
      kind: 'permission_denied',
      code: PLAN_ERROR_CODES.READ_ONLY_SCOPE,
      message: READ_ONLY_SCOPE_ERROR,
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** Cowork, plan-explore, code-review and standalone chat scopes have no plans. */
function assertPlanScope(request: TrackedPlanListRequest): void {
  try {
    resolveTrackedPlansFilePath(request.projectId, request.worktreeId);
  } catch (cause) {
    throw new CanopyOperationError(
      {
        kind: 'failed_precondition',
        code: PLAN_ERROR_CODES.UNSUPPORTED_SCOPE,
        message:
          cause instanceof Error
            ? cause.message
            : 'This scope does not have tracked plans.',
        retry: { kind: 'never' },
      },
      cause,
    );
  }
}

/**
 * Delete the plan row, then reclaim its plan-explore state on behalf of the
 * owning worktree: the scoped plan file, and, only when the takeover registry
 * row is absent or owned by this worktree, the sentinel chat scope. The
 * explore cleanup never blocks the deletion: on failure the registry row stays
 * behind so the owning worktree's cleanup sweep reclaims it later.
 */
export async function deleteTrackedPlanWithExploreChat(
  request: DeleteTrackedPlanRequest,
): Promise<boolean> {
  const deleted = await deleteTrackedPlan(
    request.projectId,
    request.worktreeId,
    request.planId,
  );
  // Deferred on purpose: the explore cleanup pulls in the chat-state, search,
  // and live session teardown services, which importing this module alone
  // must not initialize.
  const { removePlanExploreChat } = await import('../lib/plan-explore-cleanup');
  await removePlanExploreChat(request.planId, {
    projectId: request.projectId,
    worktreeId: request.worktreeId,
  }).catch(() => undefined);
  return deleted;
}

export const desktopPlanOperations: DesktopPlanOperations = {
  async list(request) {
    validateScope(request);
    if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
      return { plans: await listViewerPlans(request) };
    if (isCoworkWorkspace(request.projectId)) return { plans: [] };
    assertPlanScope(request);
    return listTrackedPlansWithSkipped(request.projectId, request.worktreeId);
  },

  async get(request) {
    validateScope(request);
    validateId(request.planId, 'planId');
    if (request.projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
      return (
        (await listViewerPlans(request)).find(
          (plan) => plan.id === request.planId,
        ) ?? null
      );
    assertPlanScope(request);
    const plan = await getTrackedPlan(
      request.projectId,
      request.worktreeId,
      request.planId,
    );
    return plan;
  },

  async create(request) {
    validateScope(request);
    assertWritable(request.projectId);
    assertPlanScope(request);
    const plan = await createTrackedPlan(request);
    return plan;
  },

  async update(request) {
    validateScope(request);
    assertWritable(request.projectId);
    validateId(request.planId, 'planId');
    assertPlanScope(request);
    const plan = await updateTrackedPlan(request);
    return plan;
  },

  async delete(request) {
    validateScope(request);
    assertWritable(request.projectId);
    validateId(request.planId, 'planId');
    assertPlanScope(request);
    const deleted = await deleteTrackedPlanWithExploreChat(request);
    return deleted;
  },
};
