import { z } from 'zod';
import { CanopyQueryRequestMetadataSchema } from '../../common';
import {
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
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
 * The minor schema revision of `core.mutationFence.publish` (protocol rule 5,
 * CAN-4730 E2 2b): revision 2 adds `writes` to the result, and the daemon
 * admits writes only for a set published at revision 2. The desktop owner
 * always sends it to the daemon it spawned; one that predates it rejects
 * the param, so the publish fails closed. Advertising it is CAN-7472.
 */
export const CORE_MUTATION_FENCE_PUBLISH_SCHEMA_REVISION = 2;
const REVISION = z
  .literal(CORE_MUTATION_FENCE_PUBLISH_SCHEMA_REVISION)
  .optional();

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
      revision: REVISION,
    }),
    z.strictObject({
      kind: z.literal('change'),
      epoch: EPOCH,
      fenced: TARGETS,
      released: TARGETS,
      revision: REVISION,
    }),
  ],
);

export type CoreMutationFencePublishParams = z.output<
  typeof CoreMutationFencePublishParamsSchema
>;

/** Milliseconds since the Unix epoch, on the daemon's clock. */
const AT = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * A worktree and when the daemon last admitted a write to it: identifiers
 * and a time only, never a path, a file name or content.
 */
export const CoreMutationFenceWriteSchema = z.strictObject({
  workspaceId: ID,
  worktreeId: ID,
  at: AT,
});

export type CoreMutationFenceWrite = z.output<
  typeof CoreMutationFenceWriteSchema
>;

/**
 * `writes` (revision 2 only) names each Auto Delete hold this publish
 * fences whose worktree the daemon has admitted a write to, with the last
 * such time, so the owner never deletes past a write it has not counted yet.
 */
export const CoreMutationFencePublishResultSchema = z.strictObject({
  acknowledged: z.literal(true),
  epoch: EPOCH,
  writes: z
    .array(CoreMutationFenceWriteSchema)
    .max(MUTATION_FENCE_MAX_TARGETS)
    .optional(),
});

export type CoreMutationFencePublishResult = z.output<
  typeof CoreMutationFencePublishResultSchema
>;

/**
 * `busy`: an Auto Delete hold was refused because a write to its worktree
 * is still running; nothing was applied.
 */
export const CORE_MUTATION_FENCE_ERROR_CODES = [
  'core.mutationFence.staleEpoch',
  'core.mutationFence.unresolved',
  'core.mutationFence.busy',
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

export const CoreMutationFenceActivityParamsSchema = z.strictObject({
  /** The stream doesn't resume; a new subscriber gets the writes from now. */
  cursor: z.null().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const CoreMutationFenceActivityOpenResultSchema = z.strictObject({
  subscriptionId: ID,
  acceptedCursor: z.null(),
});

export const CoreMutationFenceActivityItemSchema = CoreMutationFenceWriteSchema;

export type CoreMutationFenceActivityItem = z.output<
  typeof CoreMutationFenceActivityItemSchema
>;

/** The stream has no codes of its own: only the dispatcher's refusals. */
export const CoreMutationFenceActivityErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.never().optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const CoreMutationFenceActivityEndSchema = CanopyStreamEndSchema.extend({
  error: CoreMutationFenceActivityErrorSchema.nullable(),
});

/**
 * The daemon's writes, reported to the desktop owner (CAN-4730 E2 2b) so
 * each one counts as worktree activity, as a desktop write does. The daemon
 * admits writes only while the current owner holds this stream open. Owner
 * only, under the same grant as the publish.
 */
export const CORE_MUTATION_FENCE_STREAM_DEFINITIONS =
  defineCanopyStreamRegistry('core', {
    'core.mutationFence.activity': defineCanopyStream({
      plane: 'core',
      domain: 'mutationFence',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [MUTATION_FENCE_GRANTS.publish],
      params: CoreMutationFenceActivityParamsSchema,
      openResult: CoreMutationFenceActivityOpenResultSchema,
      item: CoreMutationFenceActivityItemSchema,
      end: CoreMutationFenceActivityEndSchema,
      error: CoreMutationFenceActivityErrorSchema,
    }),
  });
