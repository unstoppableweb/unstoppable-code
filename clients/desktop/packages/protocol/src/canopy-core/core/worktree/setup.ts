import { z } from 'zod';
import { defineCanopyInstruction } from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';

const id = z.string().min(1).max(512);

export const CoreWorktreeSetupCancelParamsSchema = z.strictObject({
  workspaceId: id,
  worktreeId: id,
});
export type CoreWorktreeSetupCancelParams = z.output<
  typeof CoreWorktreeSetupCancelParamsSchema
>;

export const CoreWorktreeSetupCancelResultSchema = z.strictObject({});
export type CoreWorktreeSetupCancelResult = z.output<
  typeof CoreWorktreeSetupCancelResultSchema
>;

export const CORE_WORKTREE_SETUP_CALLER_REFUSED_CODE =
  'core.worktree.setup.callerRefused';

export const CoreWorktreeSetupCancelErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum([CORE_WORKTREE_SETUP_CALLER_REFUSED_CODE]).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/** Desktop in-process only (CAN-4097, CAN-3745 RC-15); daemon placement is CAN-4737's. */
export const CORE_WORKTREE_SETUP_INSTRUCTIONS = {
  'core.worktree.setup.cancel': defineCanopyInstruction({
    plane: 'core',
    domain: 'worktree',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.worktree.write'],
    params: CoreWorktreeSetupCancelParamsSchema,
    result: CoreWorktreeSetupCancelResultSchema,
    error: CoreWorktreeSetupCancelErrorSchema,
  }),
};
