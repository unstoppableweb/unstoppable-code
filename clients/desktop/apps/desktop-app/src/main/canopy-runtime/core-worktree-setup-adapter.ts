import {
  createCoreWorktreeSetupHandlers,
  type CoreWorktreeSetupHost,
} from '@canopy/core-runtime/node/worktree/setup-cancel';
import {
  CoreWorktreeSetupCancelParamsSchema,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { ScriptCompleteEvent } from '@canopy/desktop-shared/types';
import type {
  DesktopCanopyDispatcher,
  DesktopDomainAdapter,
} from './desktop-runtime';
import {
  answerWorkspaceLifecycleProjection,
  projectWorkspaceLifecycleCommand,
  takeWorkspaceLifecycleProjection,
} from './workspace-lifecycle-dispatch';

async function cancelSetup(
  target: { workspaceId: string; worktreeId: string },
  onRendererComplete?: (event: ScriptCompleteEvent) => void,
): Promise<void> {
  const { cancelWorktreeSetup } = await import('../services/scripts-service');
  await cancelWorktreeSetup(
    { projectId: target.workspaceId, worktreeId: target.worktreeId },
    onRendererComplete ? { onRendererComplete } : {},
  );
}

/**
 * The desktop host: an IPC projection runs the request it carries, with its
 * renderer's completion events; any other admitted caller runs the same
 * cancellation without a renderer to tell.
 */
export const desktopWorktreeSetupHost: CoreWorktreeSetupHost = {
  async cancelSetup(target) {
    const projection = takeWorkspaceLifecycleProjection(
      'core.worktree.setup.cancel',
    );
    if (projection) await answerWorkspaceLifecycleProjection(projection);
    else await cancelSetup(target);
  },
};

export function createCoreWorktreeSetupAdapter(
  host: CoreWorktreeSetupHost = desktopWorktreeSetupHost,
): DesktopDomainAdapter {
  const handlers = createCoreWorktreeSetupHandlers(host);
  return {
    instructions: {
      'core.worktree.setup.cancel': handlers['core.worktree.setup.cancel'],
    },
  };
}

/**
 * `script:cancel-worktree-setup` as a projection of
 * `core.worktree.setup.cancel`, with the worktree write grant added for this
 * call only. The host runs today's request, so its renderer still receives
 * each stopped run's completion event, and its errors stay the same.
 */
export function projectWorktreeSetupCancel(
  target: {
    dispatcher: Pick<DesktopCanopyDispatcher, 'instruction'>;
    caller: CanopyCallerDescriptor;
  },
  request: { projectId: string; worktreeId: string },
  onRendererComplete: (event: ScriptCompleteEvent) => void,
): Promise<void> {
  const workspaceTarget = {
    workspaceId: request.projectId,
    worktreeId: request.worktreeId,
  };
  const run = (): Promise<void> =>
    cancelSetup(workspaceTarget, onRendererComplete);
  const params = CoreWorktreeSetupCancelParamsSchema.safeParse(workspaceTarget);
  // A request the wire cannot express keeps its in-process call, which
  // refuses it with today's validation error.
  if (!params.success) return run();
  return projectWorkspaceLifecycleCommand(
    'core.worktree.setup.cancel',
    () =>
      target.dispatcher.instruction('core.worktree.setup.cancel', params.data, {
        caller: { ...target.caller, grants: ['core.worktree.write'] },
      }),
    run,
  );
}
