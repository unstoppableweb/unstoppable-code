/**
 * A worktree's panel rows over IPC (CAN-5985): the plan, script, hook,
 * pipeline and summary entities a Portal `worktree` snapshot carries, built by
 * the same section readers, for controllers that reach this computer without
 * Portal, such as a browser over direct Remote Control. Read-only.
 */
import {
  IPC_CHANNELS,
  type WorktreeActivityEntitiesRequest,
  type WorktreeActivityEntitiesResponse,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from './register';

export function registerWorktreeActivityHandlers(): void {
  registerIpcHandler(
    IPC_CHANNELS.worktreeActivityEntities,
    async (
      _event,
      request: WorktreeActivityEntitiesRequest,
    ): Promise<WorktreeActivityEntitiesResponse> => {
      const { listWorktreeActivityEntities } =
        await import('../remote-projection/worktree-activity-entities');
      return {
        entities: await listWorktreeActivityEntities({
          workspaceLocalId: request.projectId,
          worktreeLocalId: request.worktreeId,
        }),
      };
    },
  );
}
