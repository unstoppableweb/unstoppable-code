import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { PlanScopeSchema } from '../plan/schemas';
import {
  PUBLICATION_GRANTS,
  PUBLICATION_REVISION_CONFLICT_CODE,
  PUBLICATION_STATES,
  PublicationSchema,
  type PublicationResourceKind,
  type PublicationScope,
} from './operations';

/*
 * Sharing a tracked plan (CAN-4166, decision C1): create, get, list and
 * update for resource kind `plan`, beside CAN-5904's delete. Spec-first: no
 * registry composes them yet. Desktop shares a plan with one team or one
 * organization; a legacy private copy reads as `private_link` and moves to a
 * team or organization when shared again. The core builds a share's
 * repository refs from the worktree, so callers never send them and no
 * credential, query or local path can appear in one.
 */

const OpaqueIdSchema = PublicationSchema.shape.publicationId;
const RevisionSchema = PublicationSchema.shape.revision;
const DigestSchema = PublicationSchema.shape.sourceDigest;

const PLAN_KIND = 'plan' satisfies PublicationResourceKind;

export const PLAN_SHARE_AUDIENCE_SCOPES = [
  'team',
  'organization',
] as const satisfies readonly PublicationScope[];

export const PlanPublicationTargetSchema = z.strictObject({
  kind: z.literal(PLAN_KIND),
  id: OpaqueIdSchema,
  scope: PlanScopeSchema,
});
export type PlanPublicationTarget = z.output<
  typeof PlanPublicationTargetSchema
>;

const SHARE_FIELD_MAX = 2_048;

/**
 * True for a remote URL with no userinfo, query or fragment that names a
 * network host, or an scp-style `git@host:path` remote: what desktop's
 * `sanitizeRemoteUrl` returns. Local paths and `file:` URLs are refused.
 */
function isShareableRemoteUrl(value: string): boolean {
  if (value !== value.trim() || /^(?:\/|~\/|[a-zA-Z]:|\\\\)/.test(value))
    return false;
  const url = parseUrl(value);
  if (url)
    return (
      url.protocol !== 'file:' &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      !value.includes('?') &&
      !value.includes('#')
    );
  return !value.includes('://') && /^git@[^:@/\s]+:[^?#\s]+$/.test(value);
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const ShareFieldSchema = z.string().min(1).max(SHARE_FIELD_MAX);

export const PublicationRepositoryRefSchema = z.strictObject({
  repoId: OpaqueIdSchema,
  repoName: ShareFieldSchema,
  remoteUrl: ShareFieldSchema.refine(
    isShareableRemoteUrl,
    'Expected a remote URL without credentials, a query or a local path.',
  ).nullable(),
  branch: ShareFieldSchema.nullable(),
  commitSha: z
    .string()
    .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
    .nullable(),
  defaultBranch: ShareFieldSchema.nullable(),
});
export type PublicationRepositoryRef = z.output<
  typeof PublicationRepositoryRefSchema
>;

// `publicationId` is the hosted shared plan's id, the one
// `core.publication.delete` takes, and `remoteId` repeats it.
export const PlanPublicationSchema = PublicationSchema.extend({
  resource: PlanPublicationTargetSchema.extend({
    revision: RevisionSchema,
    digest: DigestSchema,
  }),
  repositories: z.array(PublicationRepositoryRefSchema).max(100),
});
export type PlanPublication = z.output<typeof PlanPublicationSchema>;

const ShareAudienceFields = {
  scope: z.enum(PLAN_SHARE_AUDIENCE_SCOPES),
  audienceIds: z.array(OpaqueIdSchema).length(1),
};

const KeyedMetadataSchema = CanopyRequestMetadataSchema.extend({
  idempotencyKey: z.string().min(1).max(512),
});

export const PublicationCreateParamsSchema = z.strictObject({
  resource: PlanPublicationTargetSchema,
  ...ShareAudienceFields,
  consent: z.literal('explicit_user'),
  _meta: KeyedMetadataSchema,
});
export type PublicationCreateParams = z.output<
  typeof PublicationCreateParamsSchema
>;

export const PublicationUpdateParamsSchema = z.strictObject({
  publicationId: OpaqueIdSchema,
  expectedRevision: RevisionSchema,
  ...ShareAudienceFields,
  _meta: KeyedMetadataSchema,
});
export type PublicationUpdateParams = z.output<
  typeof PublicationUpdateParamsSchema
>;

export const PublicationGetParamsSchema = z.strictObject({
  resource: PlanPublicationTargetSchema,
});
export const PublicationGetResultSchema = z.strictObject({
  publication: PlanPublicationSchema.nullable(),
});

export const PublicationListParamsSchema = z.strictObject({
  resource: PlanPublicationTargetSchema.partial({ id: true }),
  states: z.array(z.enum(PUBLICATION_STATES)).min(1).max(5).optional(),
  cursor: OpaqueIdSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const PublicationListResultSchema = z.strictObject({
  publications: z.array(PlanPublicationSchema).max(200),
  nextCursor: OpaqueIdSchema.nullable(),
});

// Each code has one error kind: the first three `permission_denied`, the
// next two `failed_precondition`, then `not_found` (alike for a missing
// publication and another person's) and `conflict`.
export const PUBLICATION_SHARE_ERROR_CODES = {
  NO_PLAN_ACCESS: 'core.publication.noPlanAccess',
  READ_ONLY: 'core.publication.readOnly',
  AUDIENCE_NOT_ALLOWED: 'core.publication.audienceNotAllowed',
  REVOKED: 'core.publication.revoked',
  AUDIENCE_LOCKED: 'core.publication.audienceLocked',
  NOT_FOUND: 'core.publication.notFound',
  REVISION_CONFLICT: PUBLICATION_REVISION_CONFLICT_CODE,
} as const;

const PublicationShareErrorCodeSchema = z
  .enum([
    PUBLICATION_SHARE_ERROR_CODES.NO_PLAN_ACCESS,
    PUBLICATION_SHARE_ERROR_CODES.READ_ONLY,
    PUBLICATION_SHARE_ERROR_CODES.AUDIENCE_NOT_ALLOWED,
    PUBLICATION_SHARE_ERROR_CODES.REVOKED,
    PUBLICATION_SHARE_ERROR_CODES.AUDIENCE_LOCKED,
    PUBLICATION_SHARE_ERROR_CODES.NOT_FOUND,
    PUBLICATION_SHARE_ERROR_CODES.REVISION_CONFLICT,
  ])
  .optional();

export const PublicationShareQueryErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: PublicationShareErrorCodeSchema,
    retry: CanopyQueryRetryDirectiveSchema,
  },
);

export const PublicationShareInstructionErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: PublicationShareErrorCodeSchema,
    retry: CanopyKeyedRetryDirectiveSchema,
  });

const publication = {
  plane: 'core',
  domain: 'publication',
  version: 1,
  placement: 'core-only',
} as const;

// Spec-first (CAN-4166): no registry composes these yet, so every binding
// answers `capability_unavailable` until the sharing PR adds the desktop
// handler. The web core serves only `core.publication.delete`.
export const CORE_PUBLICATION_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.publication.get': defineCanopyQuery({
      ...publication,
      params: PublicationGetParamsSchema,
      result: PublicationGetResultSchema,
      error: PublicationShareQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PUBLICATION_GRANTS.read],
    }),
    'core.publication.list': defineCanopyQuery({
      ...publication,
      params: PublicationListParamsSchema,
      result: PublicationListResultSchema,
      error: PublicationShareQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PUBLICATION_GRANTS.read],
    }),
  },
);

export const CORE_PUBLICATION_SHARE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.publication.create': defineCanopyInstruction({
      ...publication,
      params: PublicationCreateParamsSchema,
      result: PlanPublicationSchema,
      error: PublicationShareInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PUBLICATION_GRANTS.write],
    }),
    'core.publication.update': defineCanopyInstruction({
      ...publication,
      params: PublicationUpdateParamsSchema,
      result: PlanPublicationSchema,
      error: PublicationShareInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PUBLICATION_GRANTS.write],
    }),
  });
