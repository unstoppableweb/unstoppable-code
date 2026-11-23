import { z } from 'zod';

import { COLLECTION_SHARE_SCOPES } from '../../../collections';
import { isSafePortableRelativePath } from '../../../safe-relative-path';
import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';
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
  type CanopyErrorPayload,
} from '../../errors';
import type { CanopyOperationCode } from '../../names';
import { CATALOG_GRANTS } from './operations';

/*
 * Local collection management on `core.catalog.entry.*` (CAN-4170, decision
 * K1). Kind `collection` is the only kind these operations serve; another
 * kind joins as its own branch. Members are installed identities (skills,
 * plugins and MCP server configurations), never their content or any secret,
 * and a member the catalog cannot resolve is kept and reported, not dropped.
 * Collections never write selections; `core.catalog.selection.*` does.
 */

const IdSchema = z.string().min(1).max(512);
const TimestampSchema = z.iso.datetime({ offset: true });
const KeyedMetaSchema = CanopyRequestMetadataSchema.extend({
  idempotencyKey: IdSchema,
});
const QueryMetaSchema = CanopyQueryRequestMetadataSchema.optional();

/** A local collection's catalog id: `collection:` and its store id. */
export const CatalogCollectionEntryIdSchema = z
  .string()
  .regex(/^collection:[a-f0-9-]{1,128}$/);

/** The opaque store revision a read returned; compare it for equality only. */
export const CatalogCollectionRevisionSchema = z.string().min(1).max(256);

/** A shared collection's id on the hosted service. Never a path or a URL. */
export const CatalogSharedCollectionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,128}$/);

/** The SHA-256 a shared collection revision is pinned to. */
export const CatalogSharedCollectionHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/);

export const CatalogCollectionPackageRefSchema = z.strictObject({
  version: z.literal(1),
  digest: z.string().regex(/^pp:v1:[A-Za-z0-9_-]{43}$/),
});

const NameSchema = z.string().min(1).max(512).regex(/\S/);
const DescriptionSchema = z.string().max(16_384);
const StoreIdSchema = z.string().regex(/^[a-f0-9-]{1,128}$/);

export const CatalogCollectionSkillRefSchema = z.strictObject({
  sourceId: IdSchema,
  skillName: IdSchema,
});
export const CatalogCollectionPluginRefSchema = z.strictObject({
  marketplaceId: IdSchema,
  pluginName: IdSchema,
});
export const CatalogCollectionMcpServerRefSchema = z.strictObject({
  serverId: StoreIdSchema,
  configId: StoreIdSchema,
});

export const CatalogCollectionMembersSchema = z.strictObject({
  skills: z.array(CatalogCollectionSkillRefSchema).max(1024),
  plugins: z.array(CatalogCollectionPluginRefSchema).max(1024),
  mcpServers: z.array(CatalogCollectionMcpServerRefSchema).max(1024),
});
export type CatalogCollectionMembers = z.output<
  typeof CatalogCollectionMembersSchema
>;

/** A member kept in the collection that no installed skill, plugin or MCP server answers. */
export const CatalogCollectionUnresolvedMemberSchema = z.discriminatedUnion(
  'kind',
  [
    CatalogCollectionSkillRefSchema.extend({ kind: z.literal('skill') }),
    CatalogCollectionPluginRefSchema.extend({ kind: z.literal('plugin') }),
    CatalogCollectionMcpServerRefSchema.extend({
      kind: z.literal('mcp_server'),
    }),
  ],
);

/** Where an added collection came from; set by an install or a shared update. */
export const CatalogCollectionSharedSourceSchema = z.strictObject({
  remoteId: CatalogSharedCollectionIdSchema,
  /** Null on copies added before the hash was recorded. */
  contentHash: z.string().min(1).max(128).nullable(),
  fromPublicShare: z.boolean(),
  fetchedAt: TimestampSchema,
});

/** The author-side link to this collection's own share. Sharing writes it. */
export const CatalogCollectionShareLinkSchema = z.strictObject({
  remoteId: CatalogSharedCollectionIdSchema,
  contentHash: z.string().min(1).max(128),
  shareScope: z.enum(COLLECTION_SHARE_SCOPES),
  sharedAt: TimestampSchema,
});

export const CatalogCollectionEntrySchema = z.strictObject({
  kind: z.literal('collection'),
  entryId: CatalogCollectionEntryIdSchema,
  revision: CatalogCollectionRevisionSchema,
  name: NameSchema,
  description: DescriptionSchema,
  members: CatalogCollectionMembersSchema,
  /** First save of this copy; absent when the desktop has no record (CAN-5239). */
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema,
  sharedSource: CatalogCollectionSharedSourceSchema.nullable(),
  share: CatalogCollectionShareLinkSchema.nullable(),
  unresolvedMembers: z.array(CatalogCollectionUnresolvedMemberSchema).max(3072),
});
export type CatalogCollectionEntry = z.output<
  typeof CatalogCollectionEntrySchema
>;

/** The shared collection revision an upsert's members came from. */
export const CatalogCollectionSharedRevisionSchema = z.strictObject({
  remoteId: CatalogSharedCollectionIdSchema,
  contentHash: CatalogSharedCollectionHashSchema,
  fromPublicShare: z.boolean(),
});

const upsertFields = {
  kind: z.literal('collection'),
  name: NameSchema,
  description: DescriptionSchema,
  members: CatalogCollectionMembersSchema,
  sharedRevision: CatalogCollectionSharedRevisionSchema.nullable(),
  _meta: KeyedMetaSchema,
};

/**
 * Create a collection (`entryId` and `expectedRevision` null), or replace one
 * with the revision the caller read. Duplicating is a create with the copied
 * members; applying a shared update is a replace naming `sharedRevision`.
 */
export const CatalogCollectionUpsertParamsSchema = z.union([
  z.strictObject({
    ...upsertFields,
    entryId: z.null(),
    expectedRevision: z.null(),
  }),
  z.strictObject({
    ...upsertFields,
    entryId: CatalogCollectionEntryIdSchema,
    expectedRevision: CatalogCollectionRevisionSchema,
  }),
]);
export type CatalogCollectionUpsertParams = z.output<
  typeof CatalogCollectionUpsertParamsSchema
>;

export const CatalogCollectionUpsertResultSchema = z.strictObject({
  entry: CatalogCollectionEntrySchema,
});

export const CatalogCollectionDeleteParamsSchema = z.strictObject({
  kind: z.literal('collection'),
  entryId: CatalogCollectionEntryIdSchema,
  expectedRevision: CatalogCollectionRevisionSchema,
  _meta: KeyedMetaSchema,
});

export const CatalogCollectionDeleteResultSchema = z.strictObject({
  kind: z.literal('collection'),
  entryId: CatalogCollectionEntryIdSchema,
  deleted: z.literal(true),
});

export const CATALOG_COLLECTION_REQUIREMENT_KINDS = [
  'connector',
  'mcp',
  'model',
  'command',
  'runtime',
] as const;

/** Something a collection package needs on this host that it does not bring. */
export const CatalogCollectionRequirementSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(CATALOG_COLLECTION_REQUIREMENT_KINDS),
  displayName: z.string().min(1).max(512),
  required: z.boolean(),
  setupHint: z.string().max(4096),
});

export const CatalogCollectionImportReadinessSchema = z.strictObject({
  remoteId: CatalogSharedCollectionIdSchema,
  contentHash: CatalogSharedCollectionHashSchema,
  /** Null when the shared collection has no package. */
  package: CatalogCollectionPackageRefSchema.nullable(),
  requirements: z
    .array(
      CatalogCollectionRequirementSchema.extend({
        status: z.enum(['available', 'missing', 'unknown']),
      }),
    )
    .max(1024),
});

export const CatalogCollectionGetParamsSchema = z.discriminatedUnion('read', [
  z.strictObject({
    kind: z.literal('collection'),
    read: z.literal('entry'),
    entryId: CatalogCollectionEntryIdSchema,
    _meta: QueryMetaSchema,
  }),
  /** What installing a shared collection needs here; nothing is written. */
  z.strictObject({
    kind: z.literal('collection'),
    read: z.literal('importReadiness'),
    remoteId: CatalogSharedCollectionIdSchema,
    fromPublicShare: z.boolean(),
    _meta: QueryMetaSchema,
  }),
]);

export const CatalogCollectionGetResultSchema = z.discriminatedUnion('read', [
  z.strictObject({
    read: z.literal('entry'),
    entry: CatalogCollectionEntrySchema,
  }),
  z.strictObject({
    read: z.literal('importReadiness'),
    readiness: CatalogCollectionImportReadinessSchema,
  }),
]);

/** A package file path, relative to the skill it was installed into. */
const PackageRelativePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(isSafePortableRelativePath, 'Expected a package-relative path.');

/**
 * An unresolved member-body invocation a person may dismiss: the analyzer
 * reports it on the blocker, and analyze takes it back in
 * `dismissedInvocations`.
 */
export const CatalogCollectionInvocationDismissalSchema = z.strictObject({
  provider: z.enum(['claude', 'codex']),
  token: z.string().min(1).max(512),
});

const importFields = {
  kind: z.literal('collection'),
  _meta: KeyedMetaSchema,
};

export const CatalogCollectionImportParamsSchema = z.discriminatedUnion(
  'mode',
  [
    /** Scan the collection's members into a package a share can upload. */
    z.strictObject({
      ...importFields,
      mode: z.literal('analyze'),
      entryId: CatalogCollectionEntryIdSchema,
      expectedRevision: CatalogCollectionRevisionSchema,
      dismissedInvocations: z
        .array(CatalogCollectionInvocationDismissalSchema)
        .max(256),
    }),
    /** Upload a ready analysis's package, with the optional resources chosen. */
    z.strictObject({
      ...importFields,
      mode: z.literal('commit'),
      entryId: CatalogCollectionEntryIdSchema,
      expectedRevision: CatalogCollectionRevisionSchema,
      analysisId: IdSchema,
      selectedOptionalResourceIds: z.array(IdSchema).max(256),
    }),
    /**
     * Install a shared collection's package into a new collection or an
     * existing one, pinned to the revision and package its readiness read.
     */
    z.strictObject({
      ...importFields,
      mode: z.literal('install'),
      remoteId: CatalogSharedCollectionIdSchema,
      fromPublicShare: z.boolean(),
      expectedContentHash: CatalogSharedCollectionHashSchema,
      package: CatalogCollectionPackageRefSchema,
      target: z.union([
        z.strictObject({
          create: z.strictObject({
            name: NameSchema,
            description: DescriptionSchema,
          }),
        }),
        z.strictObject({
          entryId: CatalogCollectionEntryIdSchema,
          expectedRevision: CatalogCollectionRevisionSchema,
        }),
      ]),
    }),
  ],
);
export type CatalogCollectionImportParams = z.output<
  typeof CatalogCollectionImportParamsSchema
>;

export const CatalogCollectionAnalysisSchema = z.strictObject({
  analysisId: IdSchema,
  state: z.enum(['ready', 'blocked']),
  blockers: z
    .array(
      z.strictObject({
        code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
        subject: z.string().max(512).nullable(),
        message: z.string().min(1).max(4096),
        /** Set when the blocker is an invocation the person may dismiss. */
        dismissal: CatalogCollectionInvocationDismissalSchema.optional(),
      }),
    )
    .max(1024),
  resources: z
    .array(
      z.strictObject({
        resourceId: IdSchema,
        displayName: z.string().max(512),
        fileCount: z.number().int().min(0),
        totalBytes: z.number().int().min(0),
      }),
    )
    .max(1024),
  requirements: z.array(CatalogCollectionRequirementSchema).max(1024),
  /** Members the package cannot carry; they stay in the collection. */
  unpackageableMemberLabels: z.array(z.string().max(512)).max(1024),
  expiresAt: TimestampSchema,
});

export const CatalogCollectionImportResultSchema = z.discriminatedUnion(
  'mode',
  [
    z.strictObject({
      kind: z.literal('collection'),
      mode: z.literal('analyze'),
      analysis: CatalogCollectionAnalysisSchema,
    }),
    z.strictObject({
      kind: z.literal('collection'),
      mode: z.literal('commit'),
      package: CatalogCollectionPackageRefSchema,
      committedPackageUploadId: IdSchema,
    }),
    z.strictObject({
      kind: z.literal('collection'),
      mode: z.literal('install'),
      entry: CatalogCollectionEntrySchema,
      installedSkills: z
        .array(z.strictObject({ name: IdSchema, localName: IdSchema }))
        .max(1024),
      /** Requirements this host does not meet; the install still completes. */
      unmetRequirements: z.array(CatalogCollectionRequirementSchema).max(1024),
      uninstalledResourceLabels: z.array(z.string().max(512)).max(1024),
      /** Supporting files that were already present and were kept. */
      keptLocalFiles: z.array(PackageRelativePathSchema).max(4096),
    }),
  ],
);

export const CATALOG_COLLECTION_ERROR_CODES = {
  entryNotFound: 'core.catalog.entryNotFound',
  /** The stored collection cannot be read; a write never replaces it. */
  entryUnreadable: 'core.catalog.entryUnreadable',
  entryInvalid: 'core.catalog.entryInvalid',
  revisionConflict: 'core.catalog.revisionConflict',
  /** A replace names another shared collection than the one the entry came from. */
  sharedSourceMismatch: 'core.catalog.sharedSourceMismatch',
  remoteNotFound: 'core.catalog.remoteNotFound',
  /** The hosted service refused the account or organization access. */
  remoteAccessDenied: 'core.catalog.remoteAccessDenied',
  /** The shared collection or its package changed since it was read. */
  remoteVersionConflict: 'core.catalog.remoteVersionConflict',
  remoteUnavailable: 'core.catalog.remoteUnavailable',
  /** The analysis expired or was never made on this host. */
  analysisNotFound: 'core.catalog.analysisNotFound',
  packageBlocked: 'core.catalog.packageBlocked',
  /** The analysis was made over another revision of the collection. */
  packageStale: 'core.catalog.packageStale',
  /** A downloaded package does not verify against its pinned digest. */
  packageInvalid: 'core.catalog.packageInvalid',
  /** An install failed and its new collection could not be removed again. */
  installRollbackIncomplete: 'core.catalog.installRollbackIncomplete',
} as const;

const codes = CATALOG_COLLECTION_ERROR_CODES;

export const CATALOG_COLLECTION_OPERATION_CODES = {
  get: [
    codes.entryNotFound,
    codes.entryUnreadable,
    codes.remoteNotFound,
    codes.remoteAccessDenied,
    codes.remoteUnavailable,
  ],
  upsert: [
    codes.entryNotFound,
    codes.entryUnreadable,
    codes.entryInvalid,
    codes.revisionConflict,
    codes.sharedSourceMismatch,
    codes.remoteAccessDenied,
    codes.remoteVersionConflict,
    codes.remoteUnavailable,
  ],
  delete: [codes.entryNotFound, codes.entryUnreadable, codes.revisionConflict],
  import: [
    codes.entryNotFound,
    codes.entryUnreadable,
    codes.entryInvalid,
    codes.revisionConflict,
    codes.remoteNotFound,
    codes.remoteAccessDenied,
    codes.remoteVersionConflict,
    codes.remoteUnavailable,
    codes.analysisNotFound,
    codes.packageBlocked,
    codes.packageStale,
    codes.packageInvalid,
    codes.installRollbackIncomplete,
  ],
} as const;

/** The stored revision a refused write was compared with, when one exists. */
export const CatalogCollectionErrorDetailsSchema = z.strictObject({
  currentRevision: CatalogCollectionRevisionSchema.optional(),
});

type OperationCodes = readonly [CanopyOperationCode, ...CanopyOperationCode[]];

const queryError = <const Codes extends OperationCodes>(
  operationCodes: Codes,
): z.ZodType<CanopyErrorPayload> =>
  CanopyErrorPayloadSchema.extend({
    code: z.enum(operationCodes).optional(),
    details: CatalogCollectionErrorDetailsSchema.optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

const instructionError = <const Codes extends OperationCodes>(
  operationCodes: Codes,
): z.ZodType<CanopyErrorPayload> =>
  CanopyErrorPayloadSchema.extend({
    code: z.enum(operationCodes).optional(),
    details: CatalogCollectionErrorDetailsSchema.optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

const catalog = {
  plane: 'core',
  domain: 'catalog',
  version: 1,
  placement: 'core-only',
} as const;

// Spec-first (CAN-4170 PR 2): no registry composes these yet. CAN-4170 PR 3
// composes them with the desktop handler; until then every binding answers
// `capability_unavailable`.
export const CORE_CATALOG_COLLECTION_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.catalog.entry.get': defineCanopyQuery({
      ...catalog,
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogCollectionGetParamsSchema,
      result: CatalogCollectionGetResultSchema,
      error: queryError(CATALOG_COLLECTION_OPERATION_CODES.get),
    }),
  });

export const CORE_CATALOG_COLLECTION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.catalog.entry.upsert': defineCanopyInstruction({
      ...catalog,
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogCollectionUpsertParamsSchema,
      result: CatalogCollectionUpsertResultSchema,
      error: instructionError(CATALOG_COLLECTION_OPERATION_CODES.upsert),
    }),
    'core.catalog.entry.delete': defineCanopyInstruction({
      ...catalog,
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogCollectionDeleteParamsSchema,
      result: CatalogCollectionDeleteResultSchema,
      error: instructionError(CATALOG_COLLECTION_OPERATION_CODES.delete),
    }),
    'core.catalog.entry.import': defineCanopyInstruction({
      ...catalog,
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogCollectionImportParamsSchema,
      result: CatalogCollectionImportResultSchema,
      error: instructionError(CATALOG_COLLECTION_OPERATION_CODES.import),
    }),
  });
