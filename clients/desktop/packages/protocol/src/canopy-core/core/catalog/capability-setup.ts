import { z } from 'zod';

import { CanopyRequestMetadataSchema } from '../../common';
import { CanopyJsonValueSchema } from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';
import { getShareablePluginRefKey } from '../../../plugins';
import type { ShareablePluginRef } from '../../../plugins';
import { CATALOG_GRANTS } from './operations';

// ---------------------------------------------------------------------------
// An organization's capability defaults and each organization project's own
// setup (CAN-6236, CAN-6237, CAN-6238; spec FR-4.1, FR-4.2, FR-5).
//
// The organization marks its own skills, plugins, agents and pipelines as
// defaults for every project it owns. A project adds organization items of
// its own, switches inherited defaults off, and adds a repository's plugin
// recommendation for everyone. The store names items by kind and hosted id,
// never by a host's local ref, so desktop and web read the same setup and each
// maps it to its own selection refs with the organization as their owner.
//
//   shared(project) = added ∪ (organizationDefaults − removed)
//
// Served by the web core only. The desktop core does not install these
// operations and answers capability_unavailable; desktop main reads them from
// the web core.
// ---------------------------------------------------------------------------

export const CAPABILITY_SETUP_ITEM_LIMIT = 256;
/** The longest item name and description a reader is given. */
export const CAPABILITY_SETUP_NAME_MAX_LENGTH = 512;
export const CAPABILITY_SETUP_DESCRIPTION_MAX_LENGTH = 4000;
/** The most dismissed repository recommendations a project keeps. */
export const CAPABILITY_SETUP_DISMISSED_RECOMMENDATION_LIMIT = 256;

const HostedIdSchema = z.string().min(1).max(128);
const OrganizationIdSchema = z.string().min(1).max(128);
const ProjectIdSchema = z.string().min(1).max(128);
const NameSchema = z.string().min(1).max(512);

const ShareablePluginSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('builtin'), id: NameSchema }),
  z.strictObject({ type: z.literal('github'), repo: NameSchema }),
]);

/** A portable `ShareablePluginRef`, as `canopy.json` recommends it. */
export const CapabilitySetupShareablePluginRefSchema = z.discriminatedUnion(
  'type',
  [
    z.strictObject({
      type: z.literal('skill'),
      source: ShareablePluginSourceSchema,
      skill_name: NameSchema,
    }),
    z.strictObject({
      type: z.literal('plugin'),
      marketplace: ShareablePluginSourceSchema,
      plugin_name: NameSchema,
    }),
    z.strictObject({
      type: z.literal('claude_plugin'),
      marketplace: ShareablePluginSourceSchema,
      plugin_name: NameSchema,
    }),
    z.strictObject({
      type: z.literal('codex_plugin'),
      marketplace: z.strictObject({
        type: z.literal('codex-builtin'),
        id: NameSchema,
      }),
      plugin_name: NameSchema,
    }),
  ],
);

/**
 * One item of an organization's defaults or a project's setup: an
 * organization-owned `CustomSkill`, `SharedPlugin`, `CustomAgent` or
 * `Pipeline` by its hosted id, or a marketplace plugin a project added from
 * its repository's recommendations.
 */
export const CapabilitySetupItemRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skill'), id: HostedIdSchema }),
  z.strictObject({ kind: z.literal('plugin'), id: HostedIdSchema }),
  z.strictObject({ kind: z.literal('agent'), id: HostedIdSchema }),
  z.strictObject({ kind: z.literal('pipeline'), id: HostedIdSchema }),
  z.strictObject({
    kind: z.literal('marketplacePlugin'),
    ref: CapabilitySetupShareablePluginRefSchema,
  }),
]);
export type CapabilitySetupItemRef = z.output<
  typeof CapabilitySetupItemRefSchema
>;

const ItemRefListSchema = z
  .array(CapabilitySetupItemRefSchema)
  .max(CAPABILITY_SETUP_ITEM_LIMIT);

/** An item as a reader sees it. */
export const CapabilitySetupItemSchema = z
  .object({
    ref: CapabilitySetupItemRefSchema,
    name: z.string().max(CAPABILITY_SETUP_NAME_MAX_LENGTH),
    description: z
      .string()
      .max(CAPABILITY_SETUP_DESCRIPTION_MAX_LENGTH)
      .nullable(),
    /**
     * False when the item was deleted or is no longer the organization's. An
     * unavailable item loads nowhere; it stays listed so an admin can remove
     * it.
     */
    available: z.boolean(),
  })
  .catchall(CanopyJsonValueSchema);
export type CapabilitySetupItem = z.output<typeof CapabilitySetupItemSchema>;

const ItemListSchema = z
  .array(CapabilitySetupItemSchema)
  .max(CAPABILITY_SETUP_ITEM_LIMIT * 4);

export const CapabilitySetupItemSourceSchema = z.enum([
  'organization',
  'project',
]);
export type CapabilitySetupItemSource = z.output<
  typeof CapabilitySetupItemSourceSchema
>;

/** The stored project setup (`TrackedWorkspace.capabilitySetup`). */
export const StoredProjectCapabilitySetupSchema = z.strictObject({
  version: z.literal(1),
  added: ItemRefListSchema,
  removed: ItemRefListSchema,
  /** `capabilitySetupItemKey` of each dismissed repository recommendation. */
  dismissedRecommendations: z
    .array(z.string().min(1).max(1024))
    .max(CAPABILITY_SETUP_DISMISSED_RECOMMENDATION_LIMIT),
});
export type StoredProjectCapabilitySetup = z.output<
  typeof StoredProjectCapabilitySetupSchema
>;

/** The stored organization defaults (`OrganizationCapabilityDefaults.items`). */
export const StoredOrganizationCapabilityDefaultsSchema = ItemRefListSchema;

/**
 * The identity of an item ref: kind and hosted id, or the marketplace
 * plugin's portable key. Two refs are the same item exactly when their keys
 * are equal.
 */
export function capabilitySetupItemKey(ref: CapabilitySetupItemRef): string {
  if (ref.kind === 'marketplacePlugin') {
    const portable: ShareablePluginRef = ref.ref;
    try {
      return `marketplacePlugin:${getShareablePluginRefKey(portable)}`;
    } catch {
      // A repository name the portable key refuses still names one item.
      return `marketplacePlugin:${JSON.stringify(portable)}`;
    }
  }
  return `${ref.kind}:${ref.id}`;
}

/** `refs` in order with later duplicates dropped. */
export function uniqueCapabilitySetupItemRefs<
  Ref extends CapabilitySetupItemRef,
>(refs: readonly Ref[]): Ref[] {
  const seen = new Set<string>();
  const out: Ref[] = [];
  for (const ref of refs) {
    const key = capabilitySetupItemKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

export interface ResolvedProjectCapabilityItem<
  Ref extends CapabilitySetupItemRef = CapabilitySetupItemRef,
> {
  readonly ref: Ref;
  readonly source: CapabilitySetupItemSource;
}

/**
 * The items every member of a project gets:
 * `added ∪ (organizationDefaults − removed)`. An item the project added is
 * the project's even while it is also a default, so removing the default
 * later leaves it in place; a default the project switched off is left out
 * only here. Organization defaults come first, in their order, then the
 * project's additions.
 */
export function resolveProjectCapabilitySet<
  Ref extends CapabilitySetupItemRef,
>(input: {
  readonly organizationDefaults: readonly Ref[];
  readonly added: readonly Ref[];
  readonly removed: readonly CapabilitySetupItemRef[];
}): ResolvedProjectCapabilityItem<Ref>[] {
  const added = uniqueCapabilitySetupItemRefs(input.added);
  const addedKeys = new Set(added.map(capabilitySetupItemKey));
  const removedKeys = new Set(input.removed.map(capabilitySetupItemKey));
  const inherited = uniqueCapabilitySetupItemRefs(
    input.organizationDefaults,
  ).filter((ref) => {
    const key = capabilitySetupItemKey(ref);
    return !removedKeys.has(key) && !addedKeys.has(key);
  });
  return [
    ...inherited.map((ref) => ({ ref, source: 'organization' as const })),
    ...added.map((ref) => ({ ref, source: 'project' as const })),
  ];
}

const SETUP_CODES = [
  'core.catalog.capabilitySetup.revisionConflict',
  'core.catalog.capabilitySetup.notFound',
  'core.catalog.capabilitySetup.invalidItem',
] as const;

// --- core.catalog.organizationDefaults.get ---------------------------------

export const CatalogOrganizationDefaultsGetParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
});

export const CatalogOrganizationDefaultsGetResultSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    /** Compare for equality only; pass it back to `.update`. */
    revision: z.number().int().min(0),
    items: ItemListSchema,
    /**
     * The organization's own skills, plugins, agents and pipelines an admin
     * can mark as defaults, defaults included.
     */
    candidates: ItemListSchema,
    /** Whether the caller may change the defaults (an owner or admin). */
    canEdit: z.boolean(),
  })
  .catchall(CanopyJsonValueSchema);
export type CatalogOrganizationDefaultsGetResult = z.output<
  typeof CatalogOrganizationDefaultsGetResultSchema
>;

// --- core.catalog.organizationDefaults.update ------------------------------

export const CatalogOrganizationDefaultsUpdateParamsSchema = z.strictObject({
  organizationId: OrganizationIdSchema,
  /** The revision the caller read; any other refuses the write. */
  expectedRevision: z.number().int().min(0),
  items: ItemRefListSchema,
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});

export const CatalogOrganizationDefaultsUpdateResultSchema = z
  .object({
    organizationId: OrganizationIdSchema,
    revision: z.number().int().min(0),
    items: ItemListSchema,
  })
  .catchall(CanopyJsonValueSchema);

// --- core.catalog.projectSetup.get -----------------------------------------

export const CatalogProjectSetupGetParamsSchema = z.strictObject({
  projectId: ProjectIdSchema,
});

export const CatalogProjectSetupItemSchema = z
  .object({
    item: CapabilitySetupItemSchema,
    source: CapabilitySetupItemSourceSchema,
  })
  .catchall(CanopyJsonValueSchema);
export type CatalogProjectSetupItem = z.output<
  typeof CatalogProjectSetupItemSchema
>;

export const CatalogProjectSetupGetResultSchema = z
  .object({
    projectId: ProjectIdSchema,
    organizationId: OrganizationIdSchema,
    /** The project setup's own revision; pass it back to `.update`. */
    revision: z.number().int().min(0),
    organizationDefaultsRevision: z.number().int().min(0),
    organizationDefaults: ItemListSchema,
    added: ItemListSchema,
    removed: ItemRefListSchema,
    dismissedRecommendations: z.array(z.string()).max(1024),
    /** What every member of the project gets, with each item's source. */
    effective: z
      .array(CatalogProjectSetupItemSchema)
      .max(CAPABILITY_SETUP_ITEM_LIMIT * 2),
    /** Whether the caller may change this project's setup. */
    canEdit: z.boolean(),
  })
  .catchall(CanopyJsonValueSchema);
export type CatalogProjectSetupGetResult = z.output<
  typeof CatalogProjectSetupGetResultSchema
>;

// --- core.catalog.projectSetup.update --------------------------------------

export const CatalogProjectSetupUpdateParamsSchema = z.strictObject({
  projectId: ProjectIdSchema,
  /** The revision the caller read; any other refuses the write. */
  expectedRevision: z.number().int().min(0),
  added: ItemRefListSchema,
  removed: ItemRefListSchema,
  dismissedRecommendations: z
    .array(z.string().min(1).max(1024))
    .max(CAPABILITY_SETUP_DISMISSED_RECOMMENDATION_LIMIT),
  _meta: CanopyRequestMetadataSchema.extend({
    idempotencyKey: z.string().min(1).max(512),
  }),
});

export const CatalogProjectSetupUpdateResultSchema =
  CatalogProjectSetupGetResultSchema;

export const CORE_CATALOG_CAPABILITY_SETUP_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.catalog.organizationDefaults.get': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogOrganizationDefaultsGetParamsSchema,
      result: CatalogOrganizationDefaultsGetResultSchema,
      error: inherentOperationErrorSchema(SETUP_CODES),
    }),
    'core.catalog.projectSetup.get': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogProjectSetupGetParamsSchema,
      result: CatalogProjectSetupGetResultSchema,
      error: inherentOperationErrorSchema(SETUP_CODES),
    }),
  });

export const CORE_CATALOG_CAPABILITY_SETUP_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.catalog.organizationDefaults.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogOrganizationDefaultsUpdateParamsSchema,
      result: CatalogOrganizationDefaultsUpdateResultSchema,
      error: keyedOperationErrorSchema(SETUP_CODES),
    }),
    'core.catalog.projectSetup.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogProjectSetupUpdateParamsSchema,
      result: CatalogProjectSetupUpdateResultSchema,
      error: keyedOperationErrorSchema(SETUP_CODES),
    }),
  });
