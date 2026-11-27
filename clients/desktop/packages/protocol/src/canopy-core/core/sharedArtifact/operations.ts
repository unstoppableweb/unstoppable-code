import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { CanopyRequestMetadataSchema } from '../../common';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';
import {
  MAX_SHARED_ARTIFACT_AUTOMATION_ID_LENGTH,
  MAX_SHARED_ARTIFACT_AUTOMATION_LABEL_LENGTH,
  MAX_SHARED_ARTIFACT_BYTES,
  MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH,
  MAX_SHARED_ARTIFACT_RETAINED_REVISIONS,
  MAX_SHARED_ARTIFACT_TITLE_LENGTH,
  SHARED_ARTIFACT_ALL_MEDIA_TYPES,
  SHARED_ARTIFACT_KINDS,
  SHARED_ARTIFACT_LIST_MAX_LIMIT,
  SHARED_ARTIFACT_REPORT_REASONS,
  SHARED_ARTIFACT_SHARE_SCOPES,
} from '../../../shared-artifacts';

/**
 * Shared artifacts (CAN-8015, docs/shared-artifacts.md): static content a
 * desktop user publishes and shares with a team, an organization or the
 * public. Spec-first: CAN-8016 serves these from the web core only; desktop
 * and the daemon never register them and answer `capability_unavailable`.
 *
 * Clients never receive a signed URL, a storage key or a data key: bytes go up
 * through `uploadPath` and come down through the content path, both on the web
 * origin. No access is reported as `not_found`.
 */

const isoInstant = z.iso.datetime({ offset: true });
const cursor = z.string().min(1).max(512);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const title = z.string().trim().min(1).max(MAX_SHARED_ARTIFACT_TITLE_LENGTH);
const automationId = z
  .string()
  .min(1)
  .max(MAX_SHARED_ARTIFACT_AUTOMATION_ID_LENGTH);
const automationLabel = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SHARED_ARTIFACT_AUTOMATION_LABEL_LENGTH);
const note = z.string().min(1).max(MAX_SHARED_ARTIFACT_REPORT_DETAIL_LENGTH);
/** A media type as staged; the server answers `unsupportedContent` for one outside the kind. */
const stagedMediaType = z.string().min(1).max(128);
const revisionByteLength = z
  .number()
  .int()
  .min(1)
  .max(MAX_SHARED_ARTIFACT_BYTES);

const keyedMeta = {
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
};

export const SharedArtifactKindSchema = z.enum(SHARED_ARTIFACT_KINDS);
export const SharedArtifactMediaTypeSchema = z.enum(
  SHARED_ARTIFACT_ALL_MEDIA_TYPES,
);
export const SharedArtifactShareScopeSchema = z.enum(
  SHARED_ARTIFACT_SHARE_SCOPES,
);
export const SharedArtifactReportReasonSchema = z.enum(
  SHARED_ARTIFACT_REPORT_REASONS,
);

/** Who owns an artifact. Mirrors `ResourceOwner` without `system`. */
export const SharedArtifactOwnerSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('user'),
    userId: z.uuid(),
    name: z.string().nullable(),
  }),
  z.strictObject({
    type: z.literal('team'),
    teamId: z.uuid(),
    name: z.string().nullable(),
    organization: z.strictObject({
      id: z.uuid(),
      name: z.string().nullable(),
    }),
  }),
  z.strictObject({
    type: z.literal('organization'),
    organizationId: z.uuid(),
    name: z.string().nullable(),
  }),
]);
export type SharedArtifactOwner = z.output<typeof SharedArtifactOwnerSchema>;

/** A person who acted on an artifact; null when the account no longer exists. */
export const SharedArtifactActorSchema = z.strictObject({
  userId: z.uuid().nullable(),
  name: z.string().nullable(),
});
export type SharedArtifactActor = z.output<typeof SharedArtifactActorSchema>;

/** One immutable revision. No storage key, wrapped key or URL. */
export const SharedArtifactRevisionSchema = z.strictObject({
  id: z.uuid(),
  revisionNumber: z.number().int().min(1),
  sha256,
  byteLength: revisionByteLength,
  mediaType: SharedArtifactMediaTypeSchema,
  author: SharedArtifactActorSchema,
  createdAt: isoInstant,
  /** Set when a republish grant produced the revision. */
  republish: z
    .strictObject({
      /** Null once the grant row is gone. */
      grantId: z.uuid().nullable(),
      /** The automation's label at publish time. */
      automationLabel: z
        .string()
        .max(MAX_SHARED_ARTIFACT_AUTOMATION_LABEL_LENGTH),
    })
    .optional(),
});
export type SharedArtifactRevision = z.output<
  typeof SharedArtifactRevisionSchema
>;

/** A standing grant that lets one automation republish without confirmation. */
export const SharedArtifactRepublishGrantSchema = z.strictObject({
  id: z.uuid(),
  artifactId: z.uuid(),
  grantedBy: SharedArtifactActorSchema,
  automation: z.strictObject({ id: automationId, label: automationLabel }),
  createdAt: isoInstant,
  lastUsedAt: isoInstant.nullable(),
  revokedAt: isoInstant.nullable(),
});
export type SharedArtifactRepublishGrant = z.output<
  typeof SharedArtifactRepublishGrantSchema
>;

export const SharedArtifactReportSchema = z.strictObject({
  id: z.uuid(),
  artifactId: z.uuid(),
  reason: SharedArtifactReportReasonSchema,
  createdAt: isoInstant,
});
export type SharedArtifactReport = z.output<typeof SharedArtifactReportSchema>;

/** The caller's rights, so shared UI never re-derives policy. */
export const SharedArtifactPermissionsSchema = z.strictObject({
  /** Publish a revision, edit the title, and create or revoke republish grants. */
  canEdit: z.boolean(),
  canChangeAudience: z.boolean(),
  /** The caller's right alone; `publicSharingAllowed` carries the org setting. */
  canSetPublic: z.boolean(),
  canUnshare: z.boolean(),
  canViewAnalytics: z.boolean(),
});
export type SharedArtifactPermissions = z.output<
  typeof SharedArtifactPermissionsSchema
>;

export const SharedArtifactSchema = z.strictObject({
  id: z.uuid(),
  /** Fixed for the artifact's life. */
  kind: SharedArtifactKindSchema,
  /** The latest revision's media type; may change within the kind. */
  mediaType: SharedArtifactMediaTypeSchema,
  title,
  /** `private` means the owner is the acting user; `team` and `organization` mean that owner. */
  shareScope: SharedArtifactShareScopeSchema,
  owner: SharedArtifactOwnerSchema,
  createdBy: SharedArtifactActorSchema,
  createdAt: isoInstant,
  /** The last content, audience, public or takedown change; never a view. */
  updatedAt: isoInstant,
  /**
   * The author's public-link choice. Effective public access is
   * `enabled && publicSharingAllowed && takedown === null`.
   */
  public: z.strictObject({
    enabled: z.boolean(),
    publishedAt: isoInstant.nullable(),
    unpublishedAt: isoInstant.nullable(),
  }),
  latestRevision: SharedArtifactRevisionSchema,
  revisionCount: z
    .number()
    .int()
    .min(1)
    .max(MAX_SHARED_ARTIFACT_RETAINED_REVISIONS),
  /** Only a manager or a `moderate` holder ever receives a taken-down artifact. */
  takedown: z
    .strictObject({
      takenDownAt: isoInstant,
      reason: SharedArtifactReportReasonSchema,
    })
    .nullable(),
  /** Present only when `permissions.canViewAnalytics` is true. */
  viewCounts: z
    .strictObject({
      total: z.number().int().min(0),
      unique: z.number().int().min(0),
    })
    .optional(),
  permissions: SharedArtifactPermissionsSchema,
  /**
   * Whether the governing organization's setting (none for personal) and the
   * global switch allow a public link now.
   */
  publicSharingAllowed: z.boolean(),
});
export type SharedArtifact = z.output<typeof SharedArtifactSchema>;

/** Ids are always explicit; the server never infers an organization. */
export const SharedArtifactAudienceInputSchema = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('private') }),
  z.strictObject({ scope: z.literal('team'), teamId: z.uuid() }),
  z.strictObject({
    scope: z.literal('organization'),
    organizationId: z.uuid(),
  }),
]);
export type SharedArtifactAudienceInput = z.output<
  typeof SharedArtifactAudienceInputSchema
>;

const artifactResult = z.strictObject({ artifact: SharedArtifactSchema });
export type SharedArtifactResult = z.output<typeof artifactResult>;

export const SharedArtifactGetParamsSchema = z.strictObject({
  artifactId: z.uuid(),
});
export type SharedArtifactGetParams = z.output<
  typeof SharedArtifactGetParamsSchema
>;

export const SharedArtifactGetResultSchema = z.strictObject({
  artifact: SharedArtifactSchema,
  /** Newest first; present only when `permissions.canEdit` is true. */
  revisions: z
    .array(SharedArtifactRevisionSchema)
    .max(MAX_SHARED_ARTIFACT_RETAINED_REVISIONS)
    .optional(),
  /** Active grants only; present only when `permissions.canEdit` is true. */
  republishGrants: z.array(SharedArtifactRepublishGrantSchema).optional(),
});
export type SharedArtifactGetResult = z.output<
  typeof SharedArtifactGetResultSchema
>;

export const SHARED_ARTIFACT_LIST_VIEWS = [
  'mine',
  'sharedWithMe',
  'organizationPublic',
] as const;

export const SharedArtifactListParamsSchema = z.strictObject({
  view: z.enum(SHARED_ARTIFACT_LIST_VIEWS),
  /**
   * Required for `organizationPublic`, an optional filter for `sharedWithMe`,
   * refused for `mine` (server-side `invalid_argument`).
   */
  organizationId: z.uuid().optional(),
  cursor: cursor.optional(),
  limit: z.number().int().min(1).max(SHARED_ARTIFACT_LIST_MAX_LIMIT).optional(),
});
export type SharedArtifactListParams = z.output<
  typeof SharedArtifactListParamsSchema
>;

export const SharedArtifactListResultSchema = z.strictObject({
  artifacts: z.array(SharedArtifactSchema),
  nextCursor: cursor.nullable(),
});
export type SharedArtifactListResult = z.output<
  typeof SharedArtifactListResultSchema
>;

export const SharedArtifactStageParamsSchema = z.strictObject({
  target: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('new') }),
    z.strictObject({
      type: z.literal('revision'),
      artifactId: z.uuid(),
      /** Set when an automation will publish this upload through `republish`. */
      grantId: z.uuid().optional(),
    }),
  ]),
  kind: SharedArtifactKindSchema,
  mediaType: stagedMediaType,
  /** No schema maximum: past the limit the server answers `tooLarge`. */
  byteLength: z.number().int().min(1),
  sha256,
  ...keyedMeta,
});
export type SharedArtifactStageParams = z.output<
  typeof SharedArtifactStageParamsSchema
>;

/** Exactly the relative path `sharedArtifactUploadPath(id)` builds. */
const uploadPath = z
  .string()
  .regex(
    /^\/api\/v1\/shared-artifacts\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

export const SharedArtifactUploadSchema = z.strictObject({
  id: z.uuid(),
  uploadPath,
  expiresAt: isoInstant,
  /** Equals the staged `byteLength`; the upload route accepts exactly that length and hash. */
  maxBytes: revisionByteLength,
});
export type SharedArtifactUpload = z.output<typeof SharedArtifactUploadSchema>;

export const SharedArtifactStageResultSchema = z.strictObject({
  upload: SharedArtifactUploadSchema,
});
export type SharedArtifactStageResult = z.output<
  typeof SharedArtifactStageResultSchema
>;

export const SharedArtifactCommitParamsSchema = z.strictObject({
  uploadId: z.uuid(),
  mode: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('create'),
      title,
      audience: SharedArtifactAudienceInputSchema,
    }),
    /** Without `title`, the title is kept. */
    z.strictObject({ type: z.literal('revise'), title: title.optional() }),
  ]),
  ...keyedMeta,
});
export type SharedArtifactCommitParams = z.output<
  typeof SharedArtifactCommitParamsSchema
>;

export const SharedArtifactRepublishParamsSchema = z.strictObject({
  artifactId: z.uuid(),
  grantId: z.uuid(),
  uploadId: z.uuid(),
  automationId,
  ...keyedMeta,
});
export type SharedArtifactRepublishParams = z.output<
  typeof SharedArtifactRepublishParamsSchema
>;

export const SharedArtifactUpdateAudienceParamsSchema = z.strictObject({
  artifactId: z.uuid(),
  audience: SharedArtifactAudienceInputSchema,
  ...keyedMeta,
});
export type SharedArtifactUpdateAudienceParams = z.output<
  typeof SharedArtifactUpdateAudienceParamsSchema
>;

export const SharedArtifactSetPublicParamsSchema = z.strictObject({
  artifactId: z.uuid(),
  public: z.boolean(),
  ...keyedMeta,
});
export type SharedArtifactSetPublicParams = z.output<
  typeof SharedArtifactSetPublicParamsSchema
>;

export const SharedArtifactUnshareParamsSchema = z.strictObject({
  artifactId: z.uuid(),
  ...keyedMeta,
});
export type SharedArtifactUnshareParams = z.output<
  typeof SharedArtifactUnshareParamsSchema
>;

export const SharedArtifactUnshareResultSchema = z.strictObject({
  unshared: z.boolean(),
});
export type SharedArtifactUnshareResult = z.output<
  typeof SharedArtifactUnshareResultSchema
>;

/** The report body; CAN-8016's signed-out report route validates the same shape. */
export const SharedArtifactReportBodySchema = z.strictObject({
  artifactId: z.uuid(),
  reason: SharedArtifactReportReasonSchema,
  detail: note.optional(),
});
export type SharedArtifactReportBody = z.output<
  typeof SharedArtifactReportBodySchema
>;

export const SharedArtifactReportParamsSchema =
  SharedArtifactReportBodySchema.extend(keyedMeta);
export type SharedArtifactReportParams = z.output<
  typeof SharedArtifactReportParamsSchema
>;

export const SharedArtifactReportResultSchema = z.strictObject({
  report: SharedArtifactReportSchema,
});
export type SharedArtifactReportResult = z.output<
  typeof SharedArtifactReportResultSchema
>;

export const SharedArtifactTakedownParamsSchema = z.strictObject({
  artifactId: z.uuid(),
  action: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('take_down'),
      reason: SharedArtifactReportReasonSchema,
      note: note.optional(),
    }),
    z.strictObject({ type: z.literal('restore'), note: note.optional() }),
  ]),
  ...keyedMeta,
});
export type SharedArtifactTakedownParams = z.output<
  typeof SharedArtifactTakedownParamsSchema
>;

export const SharedArtifactGrantCreateParamsSchema = z.strictObject({
  artifactId: z.uuid(),
  automation: z.strictObject({ id: automationId, label: automationLabel }),
  ...keyedMeta,
});
export type SharedArtifactGrantCreateParams = z.output<
  typeof SharedArtifactGrantCreateParamsSchema
>;

export const SharedArtifactGrantRevokeParamsSchema = z.strictObject({
  artifactId: z.uuid(),
  grantId: z.uuid(),
  ...keyedMeta,
});
export type SharedArtifactGrantRevokeParams = z.output<
  typeof SharedArtifactGrantRevokeParamsSchema
>;

export const SharedArtifactGrantResultSchema = z.strictObject({
  grant: SharedArtifactRepublishGrantSchema,
});
export type SharedArtifactGrantResult = z.output<
  typeof SharedArtifactGrantResultSchema
>;

/** Operation-specific error codes. `not_found` is generic and takes no code. */
export const SHARED_ARTIFACT_ERROR_CODES = {
  tooLarge: 'core.sharedArtifact.tooLarge',
  quotaExceeded: 'core.sharedArtifact.quotaExceeded',
  publicSharingDisabled: 'core.sharedArtifact.publicSharingDisabled',
  publicationDisabled: 'core.sharedArtifact.publicationDisabled',
  grantRequired: 'core.sharedArtifact.grantRequired',
  uploadNotReady: 'core.sharedArtifact.uploadNotReady',
  unsupportedContent: 'core.sharedArtifact.unsupportedContent',
  takenDown: 'core.sharedArtifact.takenDown',
  storageUnavailable: 'core.sharedArtifact.storageUnavailable',
} as const;

/** The error kind each code is answered with. */
export const SHARED_ARTIFACT_ERROR_CODE_KINDS = {
  [SHARED_ARTIFACT_ERROR_CODES.tooLarge]: 'failed_precondition',
  [SHARED_ARTIFACT_ERROR_CODES.quotaExceeded]: 'resource_exhausted',
  [SHARED_ARTIFACT_ERROR_CODES.publicSharingDisabled]: 'failed_precondition',
  [SHARED_ARTIFACT_ERROR_CODES.publicationDisabled]: 'failed_precondition',
  [SHARED_ARTIFACT_ERROR_CODES.grantRequired]: 'permission_denied',
  [SHARED_ARTIFACT_ERROR_CODES.uploadNotReady]: 'failed_precondition',
  [SHARED_ARTIFACT_ERROR_CODES.unsupportedContent]: 'invalid_argument',
  [SHARED_ARTIFACT_ERROR_CODES.takenDown]: 'failed_precondition',
  [SHARED_ARTIFACT_ERROR_CODES.storageUnavailable]: 'unavailable',
} as const;

/**
 * CAN-8016 decides which sessions hold these in `webCoreGrants`. Agent
 * sessions hold none; `moderate` is for platform administrators.
 */
export const SHARED_ARTIFACT_GRANTS = {
  read: 'core.sharedArtifact.read',
  write: 'core.sharedArtifact.write',
  moderate: 'core.sharedArtifact.moderate',
} as const;

const BASE = {
  plane: 'core',
  domain: 'sharedArtifact',
  version: 1,
  placement: 'core-only',
} as const;

const C = SHARED_ARTIFACT_ERROR_CODES;

// Web-core only. Do not compose into desktop or daemon definitions.
export const CORE_SHARED_ARTIFACT_QUERIES = defineCanopyQueryRegistry('core', {
  'core.sharedArtifact.get': defineCanopyQuery({
    ...BASE,
    requiredGrants: ['core.sharedArtifact.read'],
    idempotency: 'inherent',
    params: SharedArtifactGetParamsSchema,
    result: SharedArtifactGetResultSchema,
    error: inherentOperationErrorSchema([C.storageUnavailable]),
  }),
  'core.sharedArtifact.list': defineCanopyQuery({
    ...BASE,
    requiredGrants: ['core.sharedArtifact.read'],
    idempotency: 'inherent',
    params: SharedArtifactListParamsSchema,
    result: SharedArtifactListResultSchema,
    error: inherentOperationErrorSchema([C.storageUnavailable]),
  }),
});

// Web-core only. Do not compose into desktop or daemon definitions.
export const CORE_SHARED_ARTIFACT_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    'core.sharedArtifact.stage': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactStageParamsSchema,
      result: SharedArtifactStageResultSchema,
      error: keyedOperationErrorSchema([
        C.tooLarge,
        C.quotaExceeded,
        C.publicationDisabled,
        C.grantRequired,
        C.unsupportedContent,
        C.takenDown,
        C.storageUnavailable,
      ]),
    }),
    'core.sharedArtifact.commit': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactCommitParamsSchema,
      result: artifactResult,
      error: keyedOperationErrorSchema([
        C.tooLarge,
        C.quotaExceeded,
        C.publicationDisabled,
        C.uploadNotReady,
        C.unsupportedContent,
        C.takenDown,
        C.storageUnavailable,
      ]),
    }),
    'core.sharedArtifact.republish': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactRepublishParamsSchema,
      result: artifactResult,
      error: keyedOperationErrorSchema([
        C.tooLarge,
        C.quotaExceeded,
        C.publicationDisabled,
        C.grantRequired,
        C.uploadNotReady,
        C.unsupportedContent,
        C.takenDown,
        C.storageUnavailable,
      ]),
    }),
    'core.sharedArtifact.updateAudience': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactUpdateAudienceParamsSchema,
      result: artifactResult,
      error: keyedOperationErrorSchema([
        C.quotaExceeded,
        C.publicSharingDisabled,
        C.takenDown,
        C.storageUnavailable,
      ]),
    }),
    'core.sharedArtifact.setPublic': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactSetPublicParamsSchema,
      result: artifactResult,
      error: keyedOperationErrorSchema([
        C.publicSharingDisabled,
        C.takenDown,
        C.storageUnavailable,
      ]),
    }),
    'core.sharedArtifact.unshare': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactUnshareParamsSchema,
      result: SharedArtifactUnshareResultSchema,
      error: keyedOperationErrorSchema([C.storageUnavailable]),
    }),
    'core.sharedArtifact.report': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactReportParamsSchema,
      result: SharedArtifactReportResultSchema,
      error: keyedOperationErrorSchema([C.storageUnavailable]),
    }),
    'core.sharedArtifact.takedown': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.moderate'],
      idempotency: 'keyed',
      params: SharedArtifactTakedownParamsSchema,
      result: artifactResult,
      error: keyedOperationErrorSchema([C.storageUnavailable]),
    }),
    'core.sharedArtifact.grant.create': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactGrantCreateParamsSchema,
      result: SharedArtifactGrantResultSchema,
      error: keyedOperationErrorSchema([C.storageUnavailable]),
    }),
    'core.sharedArtifact.grant.revoke': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.sharedArtifact.write'],
      idempotency: 'keyed',
      params: SharedArtifactGrantRevokeParamsSchema,
      result: SharedArtifactGrantResultSchema,
      error: keyedOperationErrorSchema([C.storageUnavailable]),
    }),
  });
