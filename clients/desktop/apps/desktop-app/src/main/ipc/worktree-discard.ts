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
export function registerWorktreeDiscardHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.worktreeDiscardDescribe,
    async (
      _event,
      request: WorktreeDiscardDescribeRequest,
    ): Promise<WorktreeDiscardDescription> => {
      validateId(request.projectId, 'projectId');
      assertWritableScope(request.projectId);
      validateId(request.worktreeId, 'worktreeId');
      // Older callers keep their exact call; only the opt-in adds options.
      return request.retainedArchives === true
        ? describeWorktreeDiscard(request.projectId, request.worktreeId, {
            retainedArchives: true,
          })
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
