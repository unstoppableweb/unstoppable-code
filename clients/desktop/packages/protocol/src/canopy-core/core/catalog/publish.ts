import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import { keyedOperationErrorSchema } from '../shared';
import {
  CatalogCollectionPublishParamsSchema,
  CatalogCollectionPublishResultSchema,
  CatalogCollectionUnpublishParamsSchema,
  CatalogCollectionUnpublishResultSchema,
} from './collection-publish';
import { CATALOG_GRANTS } from './operations';
import { CatalogEntryKindSchema } from './snapshot';

const IdSchema = z.string().min(1).max(512);

export const CATALOG_PUBLICATION_VISIBILITIES = [
  'private',
  'team',
  'organization',
  'public_link',
] as const;

/**
 * The package the person agreed to upload: the analysis the consent dialog
 * showed, and the optional resources they ticked. Ids only; the desktop holds
 * the analysis and refuses one made over other content.
 */
export const CatalogEntryPublishPackageSchema = z.strictObject({
  analysisId: IdSchema,
  selectedOptionalResourceIds: z.array(IdSchema).max(256),
  /**
   * "Keep the cloud copy up to date": republish on a cloud chat's send while
   * the skill stays within this consent (D9, revised).
   */
  keepInStep: z.boolean(),
});

/**
 * Publish a local catalog entry to the account's cloud catalog (CAN-6176).
 * Served with `visibility: 'private'` only. For `kind: 'plugin'` without a
 * `package`, the entry's public marketplace source is added to the user's own
 * cloud marketplaces, and nothing else leaves the desktop. For a plugin with
 * a `package` (a local or private-marketplace plugin), only that plugin's
 * consented files upload to the desktop's private cloud marketplace, without
 * hooks or MCP and LSP configs. For `kind: 'skill'` the custom skill and the
 * consented `package` upload as the user's private cloud copy.
 */
export const CatalogEntryPublishParamsSchema = z.strictObject({
  entryId: IdSchema,
  kind: CatalogEntryKindSchema,
  expectedRevision: z.number().int().min(0),
  visibility: z.enum(CATALOG_PUBLICATION_VISIBILITIES),
  teamId: IdSchema.nullable(),
  organizationId: IdSchema.nullable(),
  /** Required for a skill; for a plugin, uploads its consented files. */
  package: CatalogEntryPublishPackageSchema.optional(),
  /**
   * The cloud account the person consented under. The publish is refused
   * when the desktop is signed in to another, before anything uploads.
   */
  expectedAccountId: IdSchema.optional(),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: IdSchema }),
});
export type CatalogEntryPublishParams = z.output<
  typeof CatalogEntryPublishParamsSchema
>;

export const CatalogEntryPublishResultSchema = z.strictObject({
  /** The cloud record the entry was published to (for a plugin, its marketplace). */
  publicationId: IdSchema,
  /** The cloud catalog entry a cloud chat selects, as the web core lists it. */
  remoteEntryId: IdSchema,
  /** The source revision the cloud copy is pinned to. */
  revision: z.string().min(1).max(256),
});
export type CatalogEntryPublishResult = z.output<
  typeof CatalogEntryPublishResultSchema
>;

export const CORE_CATALOG_PUBLISH_CODES = [
  /** The desktop is signed in to another account than expectedAccountId. */
  'core.catalog.accountMismatch',
  'core.catalog.entryNotFound',
  /** A same-named plugin from another local marketplace is already uploaded. */
  'core.catalog.entryNameTaken',
  'core.catalog.entryReadOnly',
  /** The consented package's analysis is blocked: a file or dependency it can't take. */
  'core.catalog.packageBlocked',
  /** The consented package was analysed over content the entry no longer has. */
  'core.catalog.packageStale',
  /**
   * An identical skill the account already has is shared by link, with a
   * team or with an organization, so a private cloud copy can't use it
   * (CAN-7037). Nothing uploads.
   */
  'core.catalog.audienceWider',
  'core.catalog.revisionConflict',
  'core.catalog.remoteUnavailable',
  'core.catalog.visibilityInvalid',
] as const;

/**
 * Remove a cloud copy published from this desktop (CAN-6176, D10). Served for
 * `kind: 'skill'` only: the account's private copy is deleted and the local
 * skill keeps its file but loses its link. A copy shared with a team or an
 * organization stays with the share dialog.
 */
export const CatalogEntryUnpublishParamsSchema = z.strictObject({
  /** The cloud record, as `core.catalog.entry.publish` returned it. */
  publicationId: IdSchema,
  kind: CatalogEntryKindSchema,
  /** The copy's revision the caller saw; null removes whatever is there. */
  expectedRemoteVersion: z.string().max(256).nullable(),
  _meta: CanopyRequestMetadataSchema.extend({ idempotencyKey: IdSchema }),
});
export type CatalogEntryUnpublishParams = z.output<
  typeof CatalogEntryUnpublishParamsSchema
>;

export const CatalogEntryUnpublishResultSchema = z.strictObject({
  publicationId: IdSchema,
});
export type CatalogEntryUnpublishResult = z.output<
  typeof CatalogEntryUnpublishResultSchema
>;

export const CORE_CATALOG_UNPUBLISH_CODES = [
  'core.catalog.publicationNotFound',
  /** The copy is shared beyond the account; the share dialog removes it. */
  'core.catalog.entryReadOnly',
  'core.catalog.remoteVersionConflict',
  'core.catalog.remoteUnavailable',
] as const;

/*
 * Kind `collection` joins publish and unpublish as its own branch (CAN-4170
 * PR 5a, decision K1; `collection-publish.ts`). The skill and plugin branch
 * is the unchanged schema above. Until CAN-4170 5b serves it, every host
 * refuses the collection branch with `capability_unavailable` before any
 * read, upload or write.
 */
// The collection modes join as flat branches, so each declares its own `_meta`.
export const CatalogEntryOrCollectionPublishParamsSchema = z.union([
  CatalogEntryPublishParamsSchema,
  ...CatalogCollectionPublishParamsSchema.options,
]);
export type CatalogEntryOrCollectionPublishParams = z.output<
  typeof CatalogEntryOrCollectionPublishParamsSchema
>;
export const CatalogEntryOrCollectionPublishResultSchema = z.union([
  CatalogEntryPublishResultSchema,
  CatalogCollectionPublishResultSchema,
]);
export const CatalogEntryOrCollectionUnpublishParamsSchema = z.union([
  CatalogEntryUnpublishParamsSchema,
  CatalogCollectionUnpublishParamsSchema,
]);
export type CatalogEntryOrCollectionUnpublishParams = z.output<
  typeof CatalogEntryOrCollectionUnpublishParamsSchema
>;
export const CatalogEntryOrCollectionUnpublishResultSchema = z.union([
  CatalogEntryUnpublishResultSchema,
  CatalogCollectionUnpublishResultSchema,
]);

/** Served by the desktop dispatcher only; kept out of the composed registries. */
export const CORE_CATALOG_PUBLISH_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.catalog.entry.publish': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogEntryOrCollectionPublishParamsSchema,
      result: CatalogEntryOrCollectionPublishResultSchema,
      // Kind collection's codes that skill and plugin do not already carry.
      error: keyedOperationErrorSchema([
        ...CORE_CATALOG_PUBLISH_CODES,
        'core.catalog.remoteNotFound',
        'core.catalog.remoteAccessDenied',
        'core.catalog.remoteVersionConflict',
      ]),
    }),
    'core.catalog.entry.unpublish': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogEntryOrCollectionUnpublishParamsSchema,
      result: CatalogEntryOrCollectionUnpublishResultSchema,
      error: keyedOperationErrorSchema([
        ...CORE_CATALOG_UNPUBLISH_CODES,
        'core.catalog.remoteNotFound',
        'core.catalog.remoteAccessDenied',
      ]),
    }),
  });
