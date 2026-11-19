import { randomUUID } from 'node:crypto';
import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { toShareOperationResult } from '../sharing/share-operation-result';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import {
  PLAN_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type CreateTrackedPlanRequest,
  type DeleteTrackedPlanRequest,
  type GenerateTrackedPlanDiagramsRequest,
  type ImportTrackedPlanRequest,
  type ImportTrackedPlanResponse,
  type RefreshTrackedPlanCommentsRequest,
  type SaveTrackedPlanCommentsRequest,
  type ShareTrackedPlanRequest,
  type TrackedPlanData,
  type TrackedPlanGetRequest,
  type TrackedPlanListRequest,
  type TrackedPlanListWithSkippedResult,
  type UnshareTrackedPlanRequest,
  type UpdateTrackedPlanRequest,
} from '@canopy/desktop-shared/types';
import {
  saveTrackedPlanCommentsData,
  shareTrackedPlanData,
  unshareTrackedPlanData,
} from '../services/plans-service';
import { getTrackedPlan } from '../lib/plan-persistence';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { withTrackedPlansIpcProjection } from '../canopy-runtime/plan-update-publisher';
import {
  legacyError,
  planCreateParams,
  planUpdateParams,
  trackedPlan,
  writtenTrackedPlan,
} from '../canopy-runtime/tracked-plan-projection';
import { assertWritableScope } from '../lib/read-only-scope';
import type { DesktopIpcCallerResolver } from './file-tree';
import {
  queueSharedPlanSync,
  refreshSharedPlanFromServer,
} from '../lib/shared-plan-sync';
import { schedulePlanDiagramGeneration } from '../lib/plan-diagram-scheduler';
import { importTrackedPlanFromPath } from '../lib/plan-import';
import { resolveTrackedPlansFilePath } from '../lib/resolve-worktree';
import { validateId } from '../lib/validation';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { sendToWindow } from '../lib/window-send';
import { showOpenDialogForEvent } from '../lib/dialog-window';
import { registerIpcHandler } from './register';

type PlanDispatcher = Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;

function planCaller(
  caller: CanopyCallerDescriptor,
  access: 'read' | 'write',
): CanopyCallerDescriptor {
  return { ...caller, grants: [PLAN_GRANTS[access]] };
}

function validateScope(request: TrackedPlanListRequest): {
  projectId: string;
  worktreeId: string;
} {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  return { projectId: request.projectId, worktreeId: request.worktreeId };
}

async function projected<Result>(call: () => Promise<Result>): Promise<Result> {
  try {
    return await withTrackedPlansIpcProjection(call);
  } catch (error) {
    throw legacyError(error);
  }
}

export async function listTrackedPlansForIpc(
  dispatcher: PlanDispatcher,
  caller: CanopyCallerDescriptor,
  request: TrackedPlanListRequest,
): Promise<TrackedPlanListWithSkippedResult> {
  const scope = validateScope(request);
  // Cowork workspaces have no tracked-plan storage (worktree-only feature);
  // shared callers (e.g. the pipeline-runs subscription's plan-event reload)
  // get an empty list instead of a refusal on the cowork surface.
  if (isCoworkWorkspace(scope.projectId)) return { plans: [] };
  return projected(async () => {
    const listed = await dispatcher.query(
      'core.plan.list',
      { scope },
      { caller: planCaller(caller, 'read') },
    );
    const plans: TrackedPlanData[] = [];
    for (const record of listed.plans) {
      const plan = trackedPlan(record);
      if (plan) plans.push(plan);
    }
    const skipped = (listed.skipped ?? 0) + listed.plans.length - plans.length;
    return skipped > 0 ? { plans, skipped } : { plans };
  });
}

export async function getTrackedPlanForIpc(
  dispatcher: PlanDispatcher,
  caller: CanopyCallerDescriptor,
  request: TrackedPlanGetRequest,
): Promise<TrackedPlanData | null> {
  const scope = validateScope(request);
  validateId(request.planId, 'planId');
  return projected(async () => {
    const { plan } = await dispatcher.query(
      'core.plan.get',
      { scope, planId: request.planId },
      { caller: planCaller(caller, 'read') },
    );
    return trackedPlan(plan);
  });
}

export async function createTrackedPlanForIpc(
  dispatcher: PlanDispatcher,
  caller: CanopyCallerDescriptor,
  request: CreateTrackedPlanRequest,
): Promise<TrackedPlanData> {
  const scope = validateScope(request);
  assertWritableScope(scope.projectId);
  const params = planCreateParams(scope, request);
  return projected(async () => {
    const idempotencyKey = randomUUID();
    const { plan } = await dispatcher.instruction('core.plan.create', params, {
      caller: planCaller(caller, 'write'),
      metadata: { idempotencyKey },
    });
    return writtenTrackedPlan(plan);
  });
}

export async function updateTrackedPlanForIpc(
  dispatcher: PlanDispatcher,
  caller: CanopyCallerDescriptor,
  request: UpdateTrackedPlanRequest,
): Promise<TrackedPlanData | null> {
  const scope = validateScope(request);
  assertWritableScope(scope.projectId);
  validateId(request.planId, 'planId');
  const params = planUpdateParams(scope, request);
  return projected(async () => {
    const idempotencyKey = randomUUID();
    const { plan } = await dispatcher.instruction('core.plan.update', params, {
      caller: planCaller(caller, 'write'),
      metadata: { idempotencyKey },
    });
    return plan ? writtenTrackedPlan(plan) : null;
  });
}

export async function deleteTrackedPlanForIpc(
  dispatcher: PlanDispatcher,
  caller: CanopyCallerDescriptor,
  request: DeleteTrackedPlanRequest,
): Promise<void> {
  const scope = validateScope(request);
  assertWritableScope(scope.projectId);
  validateId(request.planId, 'planId');
  await projected(async () => {
    const idempotencyKey = randomUUID();
    await dispatcher.instruction(
      'core.plan.delete',
      { scope, planId: request.planId },
      { caller: planCaller(caller, 'write'), metadata: { idempotencyKey } },
    );
  });
}

export async function importTrackedPlanFromFile(
  request: ImportTrackedPlanRequest,
  /** IPC event the request arrived on, so the open panel is owned by the
   * requesting window rather than floating free of the app (CAN-2706). */
  event?: Pick<IpcMainInvokeEvent, 'sender'>,
): Promise<ImportTrackedPlanResponse> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  if (request.filePath?.trim()) {
    return importTrackedPlanFromPath({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      filePath: request.filePath,
      repoId: request.repoId,
      initiationSource: request.initiationSource,
    });
  }
  const selection = await showOpenDialogForEvent(event, {
    title: 'Import plan document',
    properties: ['openFile'],
    filters: [{ name: 'Plan documents', extensions: ['md', 'txt'] }],
  });
  if (selection.canceled || selection.filePaths.length === 0) {
    return {
      plan: null,
      trackedPlanFilePath: resolveTrackedPlansFilePath(
        request.projectId,
        request.worktreeId,
      ),
    };
  }
  return importTrackedPlanFromPath({
    projectId: request.projectId,
    worktreeId: request.worktreeId,
    filePath: selection.filePaths[0],
    initiationSource: request.initiationSource,
    allowAbsolutePath: true,
  });
}

/** The window's tracked plan share, which App Advisor's plan.share shares (CAN-6003). */
export async function shareTrackedPlanForWindow(
  request: ShareTrackedPlanRequest,
): Promise<ShareOperationResult<TrackedPlanData | null>> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.planId, 'planId');
  if (request.teamId !== undefined) {
    validateId(request.teamId, 'teamId');
  }
  if (request.organizationId !== undefined) {
    validateId(request.organizationId, 'organizationId');
  }
  return toShareOperationResult(() => shareTrackedPlanData(request));
}

/** Stop sharing the window's tracked plan, which App Advisor's plan.unshare calls (CAN-5904). */
export async function unshareTrackedPlanForWindow(
  request: UnshareTrackedPlanRequest,
): Promise<ShareOperationResult<TrackedPlanData | null>> {
  validateId(request.projectId, 'projectId');
  validateId(request.worktreeId, 'worktreeId');
  validateId(request.planId, 'planId');
  return toShareOperationResult(() => unshareTrackedPlanData(request));
}

export function registerPlansHandlers(
  getWindow: () => BrowserWindow | null,
  dispatcher: PlanDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler<[TrackedPlanListRequest], TrackedPlanData[]>(
    IPC_CHANNELS.trackedPlansList,
    async (event, request) =>
      (await listTrackedPlansForIpc(dispatcher, resolveCaller(event), request))
        .plans,
  );

  registerIpcHandler<
    [TrackedPlanListRequest],
    TrackedPlanListWithSkippedResult
  >(IPC_CHANNELS.trackedPlansListWithSkipped, (event, request) =>
    listTrackedPlansForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[TrackedPlanGetRequest], TrackedPlanData | null>(
    IPC_CHANNELS.trackedPlansGet,
    (event, request) =>
      getTrackedPlanForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[CreateTrackedPlanRequest], TrackedPlanData>(
    IPC_CHANNELS.trackedPlansCreate,
    (event, request) =>
      createTrackedPlanForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[UpdateTrackedPlanRequest], TrackedPlanData | null>(
    IPC_CHANNELS.trackedPlansUpdate,
    (event, request) =>
      updateTrackedPlanForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[DeleteTrackedPlanRequest], void>(
    IPC_CHANNELS.trackedPlansDelete,
    (event, request) =>
      deleteTrackedPlanForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[SaveTrackedPlanCommentsRequest], TrackedPlanData | null>(
    IPC_CHANNELS.trackedPlansSaveComments,
    async (_event, request) => {
      const updated = await saveTrackedPlanCommentsData(request);
      if (updated) {
        sendToWindow(getWindow(), IPC_CHANNELS.trackedPlansUpdated, {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          plan: updated,
        });
        // Propagate the owner's comments to a shared plan so the teammate can
        // see them (no-op when the plan isn't shared).
        queueSharedPlanSync(updated, 'plan');
      }
      return updated;
    },
  );

  registerIpcHandler<[GenerateTrackedPlanDiagramsRequest], void>(
    IPC_CHANNELS.trackedPlansGenerateDiagrams,
    async (_event, request) => {
      validateId(request.projectId, 'projectId');
      validateId(request.worktreeId, 'worktreeId');
      validateId(request.planId, 'planId');
      const plan = await getTrackedPlan(
        request.projectId,
        request.worktreeId,
        request.planId,
      );
      if (plan) {
        schedulePlanDiagramGeneration(plan, getWindow, { immediate: true });
      }
    },
  );

  registerIpcHandler<
    [ShareTrackedPlanRequest],
    ShareOperationResult<TrackedPlanData | null>
  >(IPC_CHANNELS.trackedPlansShare, (_event, request) =>
    shareTrackedPlanForWindow(request),
  );

  registerIpcHandler<
    [UnshareTrackedPlanRequest],
    ShareOperationResult<TrackedPlanData | null>
  >(IPC_CHANNELS.trackedPlansUnshare, (_event, request) =>
    unshareTrackedPlanForWindow(request),
  );

  registerIpcHandler<[ImportTrackedPlanRequest], ImportTrackedPlanResponse>(
    IPC_CHANNELS.trackedPlansImport,
    async (event, request) => {
      const response = await importTrackedPlanFromFile(request, event);
      if (response.plan) {
        sendToWindow(getWindow(), IPC_CHANNELS.trackedPlansUpdated, {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          plan: response.plan,
        });
      }
      return response;
    },
  );

  registerIpcHandler<
    [RefreshTrackedPlanCommentsRequest],
    TrackedPlanData | null
  >(IPC_CHANNELS.trackedPlansRefreshComments, async (_event, request) => {
    validateId(request.projectId, 'projectId');
    validateId(request.worktreeId, 'worktreeId');
    validateId(request.planId, 'planId');
    // refreshSharedPlanFromServer emits trackedPlansUpdated itself when the
    // merge changes anything; the returned plan lets the caller update eagerly.
    return refreshSharedPlanFromServer({
      projectId: request.projectId,
      worktreeId: request.worktreeId,
      planId: request.planId,
    });
  });
}
