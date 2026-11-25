import { z } from 'zod';

import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { STORED_SECRET_REF_PATTERN } from '../../worker/execution-secrets';
import { PUBLICATION_GRANTS } from '../publication/operations';
import { SharedContainerRunConfigSchema } from '../publication/shared-container';
import { CoreSharedContainerForkResultSchema } from '../workspace/source-composition-commands';

/*
 * A shared container's recipient-side state on this device (CAN-6501 PR 5):
 * the accepted containers, a fork's provenance and the run status, as
 * desktop's shared-containers list-accepted, read-fork-provenance and
 * run-status channels answer them. All three are local reads, served by the
 * desktop dispatcher (CAN-6501 PR 7); other runtimes answer
 * `capability_unavailable`.
 */

/** The container, revision, workspace and worktree id charset (`validateId`). */
const SlugSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const OpaqueIdSchema = z.string().min(1).max(512);
/** A timestamp as the store keeps it; not re-parsed. */
const StoredTimestampSchema = z.string().min(1).max(512);

export const SHARED_CONTAINER_READ_ERROR_CODES = {
  NOT_ACCEPTED: 'core.sharedContainer.notAccepted',
  REVISION_UNAVAILABLE: 'core.sharedContainer.revisionUnavailable',
} as const;

const QueryErrorSchema = CanopyErrorPayloadSchema.extend({
  // Both are `failed_precondition`.
  code: z
    .enum([
      SHARED_CONTAINER_READ_ERROR_CODES.NOT_ACCEPTED,
      SHARED_CONTAINER_READ_ERROR_CODES.REVISION_UNAVAILABLE,
    ])
    .optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

/** Identity only: run consent stays in the core. */
export const SharedContainerAcceptanceSchema = z.strictObject({
  organizationId: OpaqueIdSchema.optional(),
  access: z.enum(['organization', 'direct']).optional(),
  acceptedAt: StoredTimestampSchema.optional(),
});

export const SharedContainerAcceptanceListResultSchema = z.strictObject({
  containerIds: z.array(OpaqueIdSchema),
  records: z.record(OpaqueIdSchema, SharedContainerAcceptanceSchema),
});

export const SharedContainerForkProvenanceGetResultSchema = z.strictObject({
  provenance: z
    .strictObject(CoreSharedContainerForkResultSchema.shape.provenance.shape)
    .nullable(),
});

/** A stored value as every read shows it: empty, or its slot's reference. */
const RunEnvironmentValueSchema = z.strictObject({
  key: z.string().min(1).max(256),
  value: z.union([
    z.literal(''),
    z.strictObject({
      kind: z.literal('stored-secret'),
      ref: z.string().regex(STORED_SECRET_REF_PATTERN),
    }),
  ]),
  secret: z.boolean().optional(),
});

export const SharedContainerRunGetResultSchema = z.strictObject({
  allowed: z.boolean(),
  allowedAt: StoredTimestampSchema.optional(),
  publisherUserId: OpaqueIdSchema.optional(),
  run: SharedContainerRunConfigSchema.optional(),
  values: z.array(RunEnvironmentValueSchema),
  unsetRequiredEnv: z.array(z.string().min(1).max(256)),
  /** A decimal byte count; it may exceed a JSON number's safe range. */
  runCopySizeBytes: z.string().regex(/^\d+$/),
  runCopyNeedsRefresh: z.boolean(),
  hasRunningProcesses: z.boolean(),
});
export type SharedContainerRunGetResult = z.output<
  typeof SharedContainerRunGetResultSchema
>;

const sharedContainer = {
  plane: 'core',
  domain: 'sharedContainer',
  version: 1,
  placement: 'core-only',
  idempotency: 'inherent',
  error: QueryErrorSchema,
} as const;

export const CORE_SHARED_CONTAINER_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.sharedContainer.acceptance.list': defineCanopyQuery({
      ...sharedContainer,
      params: z.strictObject({}),
      result: SharedContainerAcceptanceListResultSchema,
      requiredGrants: [PUBLICATION_GRANTS.read],
    }),
    'core.sharedContainer.forkProvenance.get': defineCanopyQuery({
      ...sharedContainer,
      params: z.strictObject({ projectId: SlugSchema, worktreeId: SlugSchema }),
      result: SharedContainerForkProvenanceGetResultSchema,
      // A local worktree's detail: publication.read plus workspace.read.
      requiredGrants: [PUBLICATION_GRANTS.read, 'core.workspace.read'],
    }),
    'core.sharedContainer.run.get': defineCanopyQuery({
      ...sharedContainer,
      params: z.strictObject({
        containerId: SlugSchema,
        revisionId: SlugSchema,
      }),
      result: SharedContainerRunGetResultSchema,
      // The local run environment and run copy: plus workspace.read.
      requiredGrants: [PUBLICATION_GRANTS.read, 'core.workspace.read'],
    }),
  });
