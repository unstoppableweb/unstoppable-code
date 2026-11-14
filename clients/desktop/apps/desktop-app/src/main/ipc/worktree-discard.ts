import {
  WorktreeRecoveryListParamsSchema,
  WorktreeRecoveryFinishParamsSchema,
  WorktreeRecoveryResolveParamsSchema,
} from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import type { DesktopIpcCallerResolver } from './file-tree';
import { WorktreeRecoveryRequestSchema } from '@canopy/protocol/portal/worktree-discard-schemas';
import {
  IPC_CHANNELS,
  type ProjectDeletionDiscardDescribeRequest,
  type ProjectDeletionDiscardDescription,
  type WorktreeDiscardDescribeRequest,
  type WorktreeDiscardDescription,
  type WorktreeDiscardRequest,
  type WorktreeDiscardResult,
} from '@canopy/desktop-shared/types';
import { describeProjectDeletionDiscard } from '../lib/project-deletion-discard';
import { assertWritableScope } from '../lib/read-only-scope';
import { validateId } from '../lib/validation';
import { describeWorktreeDiscard } from '../lib/worktree-discard';
import { discardWorktreeFromInterface } from '../lib/worktree-discard-interface';
import { registerIpcHandler } from './register';

/**
 * CAN-5334: the user-only worktree discard. Both channels are kind-agnostic
 * (the project kind comes from its configuration) and resolve typed refusals
 * instead of throwing them. Shared-container viewer scopes refuse first.
 */
export function registerWorktreeDiscardHandlers(runtime: {
  dispatcher: DesktopCanopyDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
}): void {
  registerIpcHandler(
    IPC_CHANNELS.worktreeRecoveryResolve,
    async (event, request: unknown) =>
      runtime.dispatcher.instruction(
        'core.worktree.recovery.resolve',
        WorktreeRecoveryResolveParamsSchema.parse(request),
        { caller: runtime.resolveCaller(event) },
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.worktreeRecoveryFinish,
    async (event, request: unknown) =>
      runtime.dispatcher.instruction(
        'core.worktree.recovery.finish',
        WorktreeRecoveryFinishParamsSchema.parse(request),
        { caller: runtime.resolveCaller(event) },
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.worktreeRecoveryList,
    async (event, request: unknown) =>
      runtime.dispatcher.query(
        'core.worktree.recovery.list',
        WorktreeRecoveryListParamsSchema.parse(request),
        {
          caller: runtime.resolveCaller(event),
        },
      ),
  );
  registerIpcHandler(
    IPC_CHANNELS.worktreeDiscardDescribe,
    async (
      _event,
      request: WorktreeDiscardDescribeRequest,
    ): Promise<WorktreeDiscardDescription> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      const recovery =
        request.recovery === undefined
          ? undefined
          : WorktreeRecoveryRequestSchema.parse(request.recovery);
      const options = {
        ...(request.retainedArchives === true
          ? { retainedArchives: true }
          : {}),
        ...(recovery ? { recovery } : {}),
      };
      return Object.keys(options).length > 0
        ? describeWorktreeDiscard(
            request.projectId,
            request.worktreeId,
            options,
          )
        : describeWorktreeDiscard(request.projectId, request.worktreeId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.worktreeDiscard,
    async (
      _event,
      request: WorktreeDiscardRequest,
    ): Promise<WorktreeDiscardResult> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      if (typeof request.confirmation !== 'string' || !request.confirmation)
        throw new Error('A worktree discard requires its confirmation.');
      return discardWorktreeFromInterface({
        workspaceId: request.projectId,
        worktreeId: request.worktreeId,
        confirmation: request.confirmation,
        source: 'desktop-ui',
        ...(request.retainedArchives === true
          ? { retainedArchives: true }
          : {}),
      });
    },
  );

  // CAN-5337: read-only; each item is discarded through the channel above.
  registerIpcHandler(
    IPC_CHANNELS.workspaceDeleteDiscardDescribe,
    async (
      _event,
      request: ProjectDeletionDiscardDescribeRequest,
    ): Promise<ProjectDeletionDiscardDescription> => {
      validateId(request.workspaceId, 'workspaceId');
      assertWritableScope(request.workspaceId);
      return request.retainedArchives === true
        ? describeProjectDeletionDiscard(request.workspaceId, {
            retainedArchives: true,
          })
        : describeProjectDeletionDiscard(request.workspaceId);
    },
  );
}
