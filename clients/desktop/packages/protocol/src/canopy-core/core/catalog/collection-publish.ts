import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  CatalogCollectionEntryIdSchema,
  CatalogCollectionPackageRefSchema,
  CatalogCollectionShareDocumentSchema,
  CatalogSharedCollectionHashSchema,
  CatalogSharedCollectionIdSchema,
} from './collection-entries';

/*
 * Kind `collection` on `core.catalog.entry.publish` and `unpublish` (CAN-4170
 * PR 5a, decision K1): its own branch beside the unchanged skill and plugin
 * branch. A collection is shared to the account (private), a team or an
 * organization, and a share may carry a public link, as the hosted service
 * models it today. Contract only: every host refuses this branch with
 * `capability_unavailable` before any read, upload or write until 5b serves
 * the public link and 5d the shares.
 */

const IdSchema = z.string().min(1).max(512);
const TimestampSchema = z.iso.datetime({ offset: true });
const KeyedMetaSchema = CanopyRequestMetadataSchema.extend({
  idempotencyKey: IdSchema,
});

/**
 * Who a share is for. A team share names its team (and may name the team's
 * organization), an organization share its organization, and a private share
 * neither. A public link is its own mode, never an audience.
 */
export const CatalogCollectionShareAudienceSchema = z.discriminatedUnion(
  'visibility',
  [
    z.strictObject({
      visibility: z.literal('private'),
      teamId: z.null(),
      organizationId: z.null(),
    }),
    z.strictObject({
      visibility: z.literal('team'),
      teamId: IdSchema,
      organizationId: IdSchema.nullable(),
    }),
    z.strictObject({
      visibility: z.literal('organization'),
      teamId: z.null(),
      organizationId: IdSchema,
    }),
  ],
);

const publishFields = {
  kind: z.literal('collection'),
  /**
   * The cloud account the person consented under. Refused when the desktop
   * is signed in to another, before anything is sent.
   */
  expectedAccountId: IdSchema.optional(),
  _meta: KeyedMetaSchema,
};

const packageFields = {
  /** The package a share pins; null shares the definition only. */
  capabilityPackage: CatalogCollectionPackageRefSchema.nullable().optional(),
  /** The upload `core.catalog.entry.import` `mode: "commit"` answered. */
  committedPackageUploadId: IdSchema.optional(),
};

export const CatalogCollectionPublishParamsSchema = z.discriminatedUnion(
  'mode',
  [
    /** Share a local collection, or a document built without one. */
    z.strictObject({
      ...publishFields,
      ...packageFields,
      mode: z.literal('create'),
      sourceEntryId: CatalogCollectionEntryIdSchema.nullable(),
      document: CatalogCollectionShareDocumentSchema,
      audience: CatalogCollectionShareAudienceSchema,
    }),
    /**
     * Replace a share's document, at the content hash the caller read when
     * it names one, and optionally move it to another audience.
     */
    z.strictObject({
      ...publishFields,
      ...packageFields,
      mode: z.literal('update'),
      publicationId: CatalogSharedCollectionIdSchema,
      sourceEntryId: CatalogCollectionEntryIdSchema.nullable(),
      expectedContentHash: CatalogSharedCollectionHashSchema.optional(),
      document: CatalogCollectionShareDocumentSchema,
      audience: CatalogCollectionShareAudienceSchema.optional(),
    }),
    /** Publish a public link pinned to the share's current content. */
    z.strictObject({
      ...publishFields,
      mode: z.literal('publicLink'),
      publicationId: CatalogSharedCollectionIdSchema,
    }),
  ],
);
export type CatalogCollectionPublishParams = z.output<
  typeof CatalogCollectionPublishParamsSchema
>;

const NullableNameSchema = z.string().max(512).nullable();
const SlugSchema = z.string().max(512).nullable().optional();

/** Who owns a share, as the hosted service reports it. */
export const CatalogCollectionShareOwnerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('system') }),
  z.strictObject({
    type: z.literal('user'),
    id: IdSchema,
    name: NullableNameSchema,
    slug: SlugSchema,
  }),
  z.strictObject({
    type: z.literal('team'),
    id: IdSchema,
    name: NullableNameSchema,
    slug: SlugSchema,
    organization: z.strictObject({ id: IdSchema, name: NullableNameSchema }),
  }),
  z.strictObject({
    type: z.literal('organization'),
    id: IdSchema,
    name: NullableNameSchema,
    slug: SlugSchema,
  }),
]);

/** A site-relative path on the hosted service; never a URL or a host path. */
const SharePathSchema = z
  .string()
  .max(512)
  .regex(/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);

/** A share's public link, pinned to the content hash it was published at. */
export const CatalogCollectionPublicShareSchema = z.strictObject({
  externalId: CatalogSharedCollectionIdSchema,
  pinnedContentHash: CatalogSharedCollectionHashSchema,
  upToDate: z.boolean(),
  sharePath: SharePathSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

/**
 * A share as the hosted service answers its create or update. Results may
 * gain fields additively; 5d settles what the share channels need beyond
 * this before it serves them.
 */
export const CatalogCollectionShareSchema = z.strictObject({
  id: CatalogSharedCollectionIdSchema,
  name: z.string().max(512),
  description: z.string().max(16_384),
  contentHash: CatalogSharedCollectionHashSchema,
  itemCounts: z.strictObject({
    skills: z.number().int().min(0),
    plugins: z.number().int().min(0),
    customSkills: z.number().int().min(0),
  }),
  shareScope: z.enum(['private', 'team', 'organization']),
  owner: CatalogCollectionShareOwnerSchema,
  createdBy: z.strictObject({
    id: IdSchema,
    name: NullableNameSchema,
    email: z.string().max(512).nullable(),
  }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  canUpdate: z.boolean(),
  canDelete: z.boolean(),
  publicShare: CatalogCollectionPublicShareSchema.nullable().optional(),
});

export const CatalogCollectionPublishResultSchema = z.discriminatedUnion(
  'mode',
  [
    z.strictObject({
      kind: z.literal('collection'),
      mode: z.literal('create'),
      publicationId: CatalogSharedCollectionIdSchema,
      share: CatalogCollectionShareSchema,
    }),
    z.strictObject({
      kind: z.literal('collection'),
      mode: z.literal('update'),
      publicationId: CatalogSharedCollectionIdSchema,
      share: CatalogCollectionShareSchema,
    }),
    z.strictObject({
      kind: z.literal('collection'),
      mode: z.literal('publicLink'),
      publicationId: CatalogSharedCollectionIdSchema,
      publicShare: CatalogCollectionPublicShareSchema,
    }),
  ],
);
export type CatalogCollectionPublishResult = z.output<
  typeof CatalogCollectionPublishResultSchema
>;

export const CATALOG_COLLECTION_UNPUBLISH_SCOPES = [
  /** Revoke the share's public link; the share stays. */
  'publicLink',
  /** Delete the share; its public link goes with it. */
  'share',
] as const;

export const CatalogCollectionUnpublishParamsSchema = z.strictObject({
  publicationId: CatalogSharedCollectionIdSchema,
  kind: z.literal('collection'),
  scope: z.enum(CATALOG_COLLECTION_UNPUBLISH_SCOPES),
  /** The share's content hash the caller saw; null removes whatever is there. */
  expectedRemoteVersion: z.string().max(256).nullable(),
  _meta: KeyedMetaSchema,
});
export type CatalogCollectionUnpublishParams = z.output<
  typeof CatalogCollectionUnpublishParamsSchema
>;

export const CatalogCollectionUnpublishResultSchema = z.strictObject({
  kind: z.literal('collection'),
  scope: z.enum(CATALOG_COLLECTION_UNPUBLISH_SCOPES),
  publicationId: CatalogSharedCollectionIdSchema,
});

/** Existing catalog codes kind `collection` answers on publish; none is new. */
export const CORE_CATALOG_COLLECTION_PUBLISH_CODES = [
  /** The desktop is signed in to another account than expectedAccountId. */
  'core.catalog.accountMismatch',
  /** The source collection is not in the catalog. */
  'core.catalog.entryNotFound',
  /** The share is absent on the hosted service. */
  'core.catalog.remoteNotFound',
  /** The hosted service refused the account, team or organization access. */
  'core.catalog.remoteAccessDenied',
  /** The share changed since `expectedContentHash` was read. */
  'core.catalog.remoteVersionConflict',
  'core.catalog.remoteUnavailable',
  /** The audience is not one this caller may share to. */
  'core.catalog.visibilityInvalid',
] as const;

/** Existing catalog codes kind `collection` answers on unpublish. */
export const CORE_CATALOG_COLLECTION_UNPUBLISH_CODES = [
  'core.catalog.remoteNotFound',
  'core.catalog.remoteAccessDenied',
  'core.catalog.remoteVersionConflict',
  'core.catalog.remoteUnavailable',
] as const;
