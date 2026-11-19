import {
  CORE_WORKTREE_SETUP_CALLER_REFUSED_CODE,
  type CORE_WORKTREE_SETUP_INSTRUCTIONS,
  type CoreWorktreeSetupCancelParams,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyDispatcherInstructionHandlerMap } from '../../runtime/types';
import { isCoreWorkspaceLifecycleCaller } from '../workspace/lifecycle-commands';

/*
 * `core.worktree.setup.cancel` (CAN-4097, CAN-3745 RC-15): stop a worktree's
 * setup, over a host port. Core admits the caller (the lifecycle commands' Q8
 * rule) before any effect; the host cancels the target's runtime preparation
 * and drains its automatic-setup and lifecycle script runs. Params name the
 * target only, never a host path.
 */

export type CoreWorktreeSetupHandlers = CanopyDispatcherInstructionHandlerMap<
  typeof CORE_WORKTREE_SETUP_INSTRUCTIONS
>;

export interface CoreWorktreeSetupHost {
  cancelSetup(target: CoreWorktreeSetupCancelParams): Promise<void>;
}

export const CORE_WORKTREE_SETUP_CANCEL_CALLER_REFUSED_MESSAGE =
  "This caller cannot stop a worktree's setup here.";

/** The setup handlers over `host`; register them only where `host` runs. */
export function createCoreWorktreeSetupHandlers(
  host: CoreWorktreeSetupHost,
): CoreWorktreeSetupHandlers {
  return {
    'core.worktree.setup.cancel': async (params, context) => {
      if (!isCoreWorkspaceLifecycleCaller(context.caller))
        throw new CanopyOperationError({
          kind: 'permission_denied',
          message: CORE_WORKTREE_SETUP_CANCEL_CALLER_REFUSED_MESSAGE,
          code: CORE_WORKTREE_SETUP_CALLER_REFUSED_CODE,
          details: { reason: 'caller-refused' },
          retry: { kind: 'never' },
        });
      await host.cancelSetup({
        workspaceId: params.workspaceId,
        worktreeId: params.worktreeId,
      });
      return {};
    },
  };
}
