import { z } from 'zod';

import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';

const id = z.string().min(1).max(512);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ offset: true });

export const CORE_ARTIFACT_OWNER_KINDS = [
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

export const CORE_ARTIFACT_KINDS = [
  'file',
  'directory',
  'transcript',
  'diff',
  'report',
  'plan',
  'diagram',
  'log',
  'attachment',
  'recording',
  'diagnostics',
  'session_bundle',
] as const;

export const CORE_ARTIFACT_STATES = [
  'available',
  'uploading',
  'expired',
  'deleted',
] as const;

export const CoreArtifactOwnerSchema = z.strictObject({
  kind: z.enum(CORE_ARTIFACT_OWNER_KINDS),
  id,
  revision: z.number().int().min(0).optional(),
  digest: sha256.optional(),
});
export type CoreArtifactOwner = z.output<typeof CoreArtifactOwnerSchema>;

/**
 * Revision 2 of core.artifact.list (CAN-7008): a workspace's files carry
 * `versionId`, the id of each file's current version, which a new version's
 * upload names as its `expectedVersionId`. A request without `revision`
 * reads revision 1's rows, which carry none.
 */
export const CORE_ARTIFACT_LIST_VERSION_REVISION = 2;

export const CoreArtifactSchema = z.strictObject({
  artifactId: id,
  owner: CoreArtifactOwnerSchema,
  kind: z.enum(CORE_ARTIFACT_KINDS),
  name: z.string().min(1).max(1024),
  mediaType: z.string().min(1).max(255),
  sizeBytes: z.number().int().min(0),
  sha256,
  createdAt: timestamp,
  availability: z.enum(CORE_ARTIFACT_STATES),
  transfer: z
    .strictObject({
      kind: z.enum(['worker_download', 'signed_url']),
      targetId: id.optional(),
      expiresAt: timestamp,
    })
    .nullable(),
  /** A workspace file's current version; only at list revision 2. */
  versionId: id.optional(),
});
export type CoreArtifact = z.output<typeof CoreArtifactSchema>;

export const CoreArtifactListParamsSchema = z.strictObject({
  owner: CoreArtifactOwnerSchema.nullable(),
  kinds: z.array(z.enum(CORE_ARTIFACT_KINDS)),
  states: z.array(z.enum(CORE_ARTIFACT_STATES)),
  cursor: id.nullable(),
  limit: z.number().int().min(1).max(500),
  revision: z.literal(CORE_ARTIFACT_LIST_VERSION_REVISION).optional(),
});

export const CoreArtifactListResultSchema = z.strictObject({
  artifacts: z.array(CoreArtifactSchema),
  nextCursor: id.nullable(),
});

export const CoreArtifactGetParamsSchema = z.strictObject({ artifactId: id });

export const CoreArtifactErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(['core.artifact.notFound']).optional(),
  /** capability_unavailable names the request option this core cannot serve. */
  details: z.strictObject({ option: z.string().min(1).max(128) }).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

// Served by the web core only (CAN-4159). Kept out of CORE_QUERY_DEFINITIONS
// because the daemon dispatcher requires a handler for every definition it is
// given and has none for artifacts yet.
export const CORE_ARTIFACT_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.artifact.list': defineCanopyQuery({
      plane: 'core',
      domain: 'artifact',
      version: 1,
      placement: 'core-only',
      params: CoreArtifactListParamsSchema,
      result: CoreArtifactListResultSchema,
      error: CoreArtifactErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['core.artifact.read'],
    }),
    'core.artifact.get': defineCanopyQuery({
      plane: 'core',
      domain: 'artifact',
      version: 1,
      placement: 'core-only',
      params: CoreArtifactGetParamsSchema,
      result: CoreArtifactSchema,
      error: CoreArtifactErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['core.artifact.read'],
    }),
  },
);
