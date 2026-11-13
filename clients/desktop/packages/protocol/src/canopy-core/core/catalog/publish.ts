import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import { keyedOperationErrorSchema } from '../shared';
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
});

/**
 * Publish a local catalog entry to the account's cloud catalog (CAN-6176).
 * Served with `visibility: 'private'` only. For `kind: 'plugin'` the entry's
 * public marketplace source is added to the user's own cloud marketplaces,
 * and nothing else leaves the desktop. For `kind: 'skill'` the custom skill
 * and the consented `package` upload as the user's private cloud copy.
 */
export const CatalogEntryPublishParamsSchema = z.strictObject({
  entryId: IdSchema,
  kind: CatalogEntryKindSchema,
  expectedRevision: z.number().int().min(0),
  visibility: z.enum(CATALOG_PUBLICATION_VISIBILITIES),
  teamId: IdSchema.nullable(),
  organizationId: IdSchema.nullable(),
  /** Required for a skill; refused for a plugin. */
  package: CatalogEntryPublishPackageSchema.optional(),
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
  'core.catalog.entryNotFound',
  'core.catalog.entryReadOnly',
  /** The consented package was analysed over content the skill no longer has. */
  'core.catalog.packageStale',
  'core.catalog.revisionConflict',
  'core.catalog.remoteUnavailable',
  'core.catalog.visibilityInvalid',
] as const;

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
      params: CatalogEntryPublishParamsSchema,
      result: CatalogEntryPublishResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_PUBLISH_CODES),
    }),
  });
