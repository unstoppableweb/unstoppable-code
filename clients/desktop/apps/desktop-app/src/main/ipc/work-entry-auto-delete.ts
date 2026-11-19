import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  WorkEntryAutoDeleteDisarmRequest,
  WorkEntryAutoDeleteResolveBranchRequest,
  WorkEntryAutoDeleteWorkspaceSnapshot,
} from '@canopy/protocol/work-entry-auto-delete';
import {
  listWorkEntryAutoDeleteSnapshots,
  disarmWorkEntryAutoDeleteByUser,
  resolveWorkEntryAutoDeleteBranch,
} from '../lib/work-entry-auto-delete';
import { validateId } from '../lib/validation';
import { isRecord } from '../lib/type-guards';
import { registerIpcHandler } from './register';

function target(value: unknown): WorkEntryAutoDeleteDisarmRequest {
  if (!isRecord(value)) throw new Error('Invalid auto-delete target');
  const { workspaceId, targetId } = value;
  validateId(workspaceId, 'workspaceId');
  validateId(targetId, 'targetId');
  return { workspaceId, targetId };
}

export function registerWorkEntryAutoDeleteHandlers(): void {
  registerIpcHandler<[], WorkEntryAutoDeleteWorkspaceSnapshot[]>(
    IPC_CHANNELS.workEntryAutoDeleteList,
    () => listWorkEntryAutoDeleteSnapshots(),
  );
  registerIpcHandler<[WorkEntryAutoDeleteDisarmRequest], boolean>(
    IPC_CHANNELS.workEntryAutoDeleteDisarm,
    (_event, request) => disarmWorkEntryAutoDeleteByUser(target(request)),
  );
  registerIpcHandler<[WorkEntryAutoDeleteResolveBranchRequest], void>(
    IPC_CHANNELS.workEntryAutoDeleteResolveBranch,
    (_event, request) => {
      const identity = target(request);
      if (
        request.answer !== 'disarm' &&
        request.answer !== 'delete-branch' &&
        request.answer !== 'keep-branch'
      )
        throw new Error('Invalid auto-delete branch answer');
      return resolveWorkEntryAutoDeleteBranch({
        ...identity,
        answer: request.answer,
        confirmationId: request.confirmationId,
      });
    },
  );
}
