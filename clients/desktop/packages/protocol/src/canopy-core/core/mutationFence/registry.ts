import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';

export const MUTATION_FENCE_GRANTS = {
  publish: 'core.mutationFence.publish',
} as const;

const ID = z.string().min(1).max(512);
/**
 * Synthetic workspaces a write never targets: the shared-container viewer
 * and the plan-explore and code-review chat aliases. The desktop refuses
 * them before a mutation (`DAEMON_FILES_EXCLUDED_WORKSPACE_IDS`), and so does
 * the daemon's fence guard.
 */
export const MUTATION_FENCE_RESERVED_WORKSPACE_IDS: ReadonlySet<string> =
  new Set(['shared-container-viewer', 'plan-explore-chat', 'code-review-chat']);

/** The most worktrees one publish may name. */
export const MUTATION_FENCE_MAX_TARGETS = 1024;

/** Why the owner holds a worktree; each hold is fenced and released alone. */
export const MUTATION_FENCE_HOLDS = [
  'splitLock',
  'archive',
  'autoDelete',
] as const;
export type MutationFenceHold = (typeof MUTATION_FENCE_HOLDS)[number];

/** One fenced worktree, named as its owner names it, with the hold on it. */
export const CoreMutationFenceTargetSchema = z.strictObject({
  workspaceId: ID,
  worktreeId: ID,
  hold: z.enum(MUTATION_FENCE_HOLDS),
});

export type CoreMutationFenceTarget = z.output<
  typeof CoreMutationFenceTargetSchema
>;

const TARGETS = z
  .array(CoreMutationFenceTargetSchema)
  .max(MUTATION_FENCE_MAX_TARGETS);
const EPOCH = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * A `snapshot` names every worktree the owner fences now and replaces this
 * owner lease's fences. A `change` adds `fenced` and removes `released`.
 * Epochs rise per owner lease: an older one is refused, and a repeat of the
 * last epoch is acknowledged only when its payload is identical.
 */
export const CoreMutationFencePublishParamsSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('snapshot'),
      epoch: EPOCH,
      fenced: TARGETS,
    }),
    z.strictObject({
      kind: z.literal('change'),
      epoch: EPOCH,
      fenced: TARGETS,
      released: TARGETS,
    }),
  ],
);

export type CoreMutationFencePublishParams = z.output<
  typeof CoreMutationFencePublishParamsSchema
>;

export const CoreMutationFencePublishResultSchema = z.strictObject({
  acknowledged: z.literal(true),
  epoch: EPOCH,
});

export type CoreMutationFencePublishResult = z.output<
  typeof CoreMutationFencePublishResultSchema
>;

export const CORE_MUTATION_FENCE_ERROR_CODES = [
  'core.mutationFence.staleEpoch',
  'core.mutationFence.unresolved',
] as const;

export const CoreMutationFencePublishErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_MUTATION_FENCE_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/**
 * The daemon's mutation fence (CAN-4730): the desktop owner publishes the
 * worktrees its Split PR service has locked, and the daemon refuses
 * filesystem writes to them for every caller. Owner only: no interface
 * profile installs it, and only the proven owner's caller holds the grant.
 */
export const CORE_MUTATION_FENCE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.mutationFence.publish': defineCanopyInstruction({
      plane: 'core',
      domain: 'mutationFence',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [MUTATION_FENCE_GRANTS.publish],
      params: CoreMutationFencePublishParamsSchema,
      result: CoreMutationFencePublishResultSchema,
      error: CoreMutationFencePublishErrorSchema,
    }),
  });
