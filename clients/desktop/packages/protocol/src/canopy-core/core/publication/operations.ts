import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../../errors';

/**
 * Publications (CAN-5904): a local resource shared with an audience in the
 * cloud. `core.publication.delete` revokes one. The web core serves it for
 * plans only; desktop and the daemon don't register it and answer
 * `capability_unavailable`. A plan publication is the hosted `SharedPlan`
 * row, hard-deleted on revoke, so the result is a tombstone built from the
 * row before it went: a retry with the same key replays it, and a call with
 * a new key answers `not_found`.
 */
export const PUBLICATION_GRANTS = {
  read: 'core.publication.read',
  write: 'core.publication.write',
} as const;

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .describe('Stable opaque identifier.');
const TimestampSchema = z.iso
  .datetime({ offset: true })
  .describe('RFC 3339 timestamp with an offset.');
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const RevisionSchema = z.number().int().nonnegative();

export const PUBLICATION_RESOURCE_KINDS = [
  'workspace',
  'worktree',
  'chat',
  'turn',
  'plan',
  'pipeline_execution',
  'agent_session',
  'artifact',
  'archive',
  'review',
] as const;
export type PublicationResourceKind =
  (typeof PUBLICATION_RESOURCE_KINDS)[number];

/** Who a publication is shared with. */
export const PUBLICATION_SCOPES = [
  'private_link',
  'team',
  'organization',
] as const;
export type PublicationScope = (typeof PUBLICATION_SCOPES)[number];

export const PUBLICATION_STATES = [
  'publishing',
  'published',
  'revoking',
  'revoked',
  'failed',
] as const;
export type PublicationState = (typeof PUBLICATION_STATES)[number];

export const PUBLICATION_CONSENTS = [
  'explicit_user',
  'policy_allowed',
] as const;

export const PublicationResourceSchema = z.strictObject({
  kind: z.enum(PUBLICATION_RESOURCE_KINDS),
  id: OpaqueIdSchema,
  revision: RevisionSchema.optional(),
  digest: DigestSchema.optional(),
});
export type PublicationResource = z.output<typeof PublicationResourceSchema>;

export const PublicationSchema = z.strictObject({
  publicationId: OpaqueIdSchema,
  resource: PublicationResourceSchema,
  scope: z.enum(PUBLICATION_SCOPES),
  /** The team or organization ids it is shared with; empty for a private link. */
  audienceIds: z.array(OpaqueIdSchema),
  sourceRevision: RevisionSchema,
  sourceDigest: DigestSchema,
  remoteId: OpaqueIdSchema.nullable(),
  state: z.enum(PUBLICATION_STATES),
  consent: z.enum(PUBLICATION_CONSENTS),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  revision: RevisionSchema,
});
export type Publication = z.output<typeof PublicationSchema>;

export const PublicationDeleteParamsSchema = z.strictObject({
  publicationId: OpaqueIdSchema,
  /** Compare-and-swap on the publication's revision; drift is `conflict`. */
  expectedRevision: RevisionSchema,
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});
export type PublicationDeleteParams = z.output<
  typeof PublicationDeleteParamsSchema
>;

/** The publication's revision moved since the caller read it (`conflict`). */
export const PUBLICATION_REVISION_CONFLICT_CODE =
  'core.publication.revisionConflict';

export const PUBLICATION_INSTRUCTION_ERROR_CODES = [
  PUBLICATION_REVISION_CONFLICT_CODE,
] as const;

export const PublicationInstructionErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(PUBLICATION_INSTRUCTION_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const CORE_PUBLICATION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.publication.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'publication',
      version: 1,
      placement: 'core-only',
      params: PublicationDeleteParamsSchema,
      // The publication as it was, with `state: 'revoked'`.
      result: PublicationSchema,
      error: PublicationInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PUBLICATION_GRANTS.write],
    }),
  });
