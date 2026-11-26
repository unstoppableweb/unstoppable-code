import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PLAN_ERROR_CODES,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type DetectedPlanEntry,
  type DetectedPlanUpdateRequest,
  type DetectedPlansListRequest,
  type DetectedPlansScanRequest,
  type DetectedPlansScanResponse,
} from '@canopy/desktop-shared/types';
import {
  detectedPlanScanParams,
  detectedPlanUpdateParams,
} from '@canopy/desktop-shared/lib/tracked-plan-params';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { withTrackedPlansIpcProjection } from '../canopy-runtime/plan-update-publisher';
import { legacyError } from '../canopy-runtime/tracked-plan-projection';
import { validateId } from '../lib/validation';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { sendToWindow } from '../lib/window-send';
import type { DesktopIpcCallerResolver } from './file-tree';
import { planCaller, validateScope } from './plans';
import { registerIpcHandler } from './register';

/*
 * The detected-plans channels project `core.plan.detected.*` (CAN-4165 PR
 * 5b), which remote windows and Remote Control still use. A channel write's
 * window hears of it from the channel, as before; the publisher announces a
 * write from another binding, the main window's relay included (PR 7c).
 */

type PlanDispatcher = Pick<DesktopCanopyDispatcher, 'query' | 'instruction'>;

/**
 * The channel always answered the writer's own refusal of a damaged file,
 * and the other refusals as the tracked-plans channels do.
 */
async function projected<Result>(call: () => Promise<Result>): Promise<Result> {
  try {
    return await withTrackedPlansIpcProjection(call);
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.code === PLAN_ERROR_CODES.DAMAGED_STATE &&
      types.isNativeError(error.runtimeCause)
    )
      throw error.runtimeCause;
    throw legacyError(error);
  }
}

export async function listDetectedPlansForIpc(
  dispatcher: PlanDispatcher,
  caller: CanopyCallerDescriptor,
  request: DetectedPlansListRequest,
): Promise<DetectedPlanEntry[]> {
  const scope = validateScope(request);
  // Cowork workspaces have no detected-plan storage (worktree-only feature).
  if (isCoworkWorkspace(scope.projectId)) return [];
  return projected(
    async () =>
      (
        await dispatcher.query(
          'core.plan.detected.list',
          { scope },
          { caller: planCaller(caller, 'read') },
        )
      ).detected,
  );
}

export async function scanDetectedPlansForIpc(
  dispatcher: PlanDispatcher,
  caller: CanopyCallerDescriptor,
  request: DetectedPlansScanRequest,
): Promise<DetectedPlansScanResponse> {
  const scope = validateScope(request);
  validateId(request.chatId, 'chatId');
  // Nothing is detected where nothing is stored (worktree-only feature).
  if (isCoworkWorkspace(scope.projectId))
    return { entries: [], newlyDetected: [] };
  return projected(async () => {
    const { detected, newlyDetected } = await dispatcher.instruction(
      'core.plan.detected.scan',
      detectedPlanScanParams(scope, request),
      {
        caller: planCaller(caller, 'write'),
        metadata: { idempotencyKey: randomUUID() },
      },
    );
    return { entries: detected, newlyDetected };
  });
}

export async function updateDetectedPlanForIpc(
  dispatcher: PlanDispatcher,
  caller: CanopyCallerDescriptor,
  request: DetectedPlanUpdateRequest,
): Promise<DetectedPlanEntry[]> {
  const scope = validateScope(request);
  validateId(request.entryId, 'entryId');
  if (request.importedPlanId !== undefined) {
    validateId(request.importedPlanId, 'importedPlanId');
  }
  return projected(
    async () =>
      (
        await dispatcher.instruction(
          'core.plan.detected.update',
          detectedPlanUpdateParams(scope, request),
          {
            caller: planCaller(caller, 'write'),
            metadata: { idempotencyKey: randomUUID() },
          },
        )
      ).detected,
  );
}

export function registerDetectedPlansHandlers(
  getWindow: () => BrowserWindow | null,
  dispatcher: PlanDispatcher,
  resolveCaller: DesktopIpcCallerResolver,
): void {
  registerIpcHandler<[DetectedPlansScanRequest], DetectedPlansScanResponse>(
    IPC_CHANNELS.detectedPlansScan,
    async (event, request) => {
      const response = await scanDetectedPlansForIpc(
        dispatcher,
        resolveCaller(event),
        request,
      );
      if (response.newlyDetected.length > 0) {
        sendToWindow(getWindow(), IPC_CHANNELS.detectedPlansUpdated, {
          projectId: request.projectId,
          worktreeId: request.worktreeId,
          entries: response.entries,
        });
      }
      return response;
    },
  );

  registerIpcHandler<[DetectedPlansListRequest], DetectedPlanEntry[]>(
    IPC_CHANNELS.detectedPlansList,
    (event, request) =>
      listDetectedPlansForIpc(dispatcher, resolveCaller(event), request),
  );

  registerIpcHandler<[DetectedPlanUpdateRequest], DetectedPlanEntry[]>(
    IPC_CHANNELS.detectedPlansUpdate,
    async (event, request) => {
      const entries = await updateDetectedPlanForIpc(
        dispatcher,
        resolveCaller(event),
        request,
      );
      sendToWindow(getWindow(), IPC_CHANNELS.detectedPlansUpdated, {
        projectId: request.projectId,
        worktreeId: request.worktreeId,
        entries,
      });
      return entries;
    },
  );
}
