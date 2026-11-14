import type { ShareOperationResult } from '@canopy/protocol/sharing';
import { toShareOperationResult } from '../sharing/share-operation-result';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
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
  createTrackedPlanData,
  deleteTrackedPlanData,
  listTrackedPlanData,
  listTrackedPlanDataWithSkipped,
  readTrackedPlanData,
  saveTrackedPlanCommentsData,
  shareTrackedPlanData,
  syncTrackedPlansToPortal,
  unshareTrackedPlanData,
  updateTrackedPlanData,
} from '../services/plans-service';
import {
  addTrackedPlansWriteListener,
  getTrackedPlan,
} from '../lib/plan-persistence';
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
): void {
  // Publish tracked plans to Remote Control from the persistence write hook
  // rather than per-caller (CAN-3019). The mutators in `plans-service` emit
  // their own events, but the agent's plan-mode path bypasses them entirely:
  // `ExitPlanMode` writes through `lib/plan-persistence` directly, so an
  // agent-authored plan — the ordinary way a plan gets made — never reached the
  // portal and the web Plans card stayed empty. Every writer funnels through
  // this single hook, so subscribing here covers imports, pipeline
  // `plan_ready`, and deletes at the same time.
  addTrackedPlansWriteListener((projectId, worktreeId, file) => {
    syncTrackedPlansToPortal(projectId, worktreeId, file.plans);
  });
  registerIpcHandler<[TrackedPlanListRequest], TrackedPlanData[]>(
    IPC_CHANNELS.trackedPlansList,
    async (_event, request) => {
      // Cowork workspaces have no tracked-plan storage (worktree-only
      // feature); return an empty list instead of the resolve-worktree throw
      // so shared callers (e.g. the pipeline-runs subscription's plan-event
      // reload) stay safe on the cowork surface.
      if (isCoworkWorkspace(request.projectId)) {
        return [];
      }
      return listTrackedPlanData(request);
    },
  );

  registerIpcHandler<
    [TrackedPlanListRequest],
    TrackedPlanListWithSkippedResult
  >(IPC_CHANNELS.trackedPlansListWithSkipped, async (_event, request) =>
    // As tracked-plans:list: a cowork workspace has no tracked plans.
    isCoworkWorkspace(request.projectId)
      ? { plans: [] }
      : listTrackedPlanDataWithSkipped(request),
  );

  registerIpcHandler<[TrackedPlanGetRequest], TrackedPlanData | null>(
    IPC_CHANNELS.trackedPlansGet,
    async (_event, request) => readTrackedPlanData(request),
  );

  registerIpcHandler<[CreateTrackedPlanRequest], TrackedPlanData>(
    IPC_CHANNELS.trackedPlansCreate,
    async (_event, request) => createTrackedPlanData(request),
  );

  registerIpcHandler<[UpdateTrackedPlanRequest], TrackedPlanData | null>(
    IPC_CHANNELS.trackedPlansUpdate,
    async (_event, request) => updateTrackedPlanData(request),
  );

  registerIpcHandler<[DeleteTrackedPlanRequest], void>(
    IPC_CHANNELS.trackedPlansDelete,
    async (_event, request) => {
      await deleteTrackedPlanData(request);
    },
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
