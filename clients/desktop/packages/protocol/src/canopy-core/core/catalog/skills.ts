import { z } from 'zod';

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
import { canopyJsonValueSchemaWithin } from '../../errors';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';
import { CATALOG_GRANTS } from './operations';

const IdSchema = z.string().min(1).max(512);
const Keyed = CanopyRequestMetadataSchema.extend({ idempotencyKey: IdSchema });

/** The most skills one source offers or one install names; 9x the largest measured source (CAN-5873). */
export const CATALOG_SKILL_SOURCE_MAX_SKILLS = 5000;
/** The UTF-8 bytes one frontmatter value may take; 40x the largest measured value (CAN-5873). */
export const CATALOG_SKILL_FRONTMATTER_VALUE_MAX_BYTES = 262_144;

/** A skill's frontmatter on the wire, read or preserved through a save. */
export const CatalogSkillFrontmatterSchema = z.record(
  z.string().max(512),
  canopyJsonValueSchemaWithin(CATALOG_SKILL_FRONTMATTER_VALUE_MAX_BYTES),
);

/** A skill as the persisted selection names it. Parts are bounded only; the host validates paths. */
export const CatalogSkillRefSchema = z.strictObject({
  sourceId: IdSchema,
  skillName: IdSchema,
});
export type CatalogSkillRef = z.output<typeof CatalogSkillRefSchema>;

export const CATALOG_SKILL_RISK_LEVELS = [
  'safe',
  'low',
  'medium',
  'high',
  'critical',
  'unknown',
] as const;

const SkillContentHashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * The cloud custom skill a local skill is linked to (CAN-6176): the share its
 * author published (`author`) or the share it was installed from
 * (`recipient`). Ids and hashes only. Hashes are SHA-256 over the raw
 * SKILL.md bytes, as the cloud hashes them. Only a core that holds local
 * skills sets it; the web core never does.
 */
export const CatalogSkillCloudShareSchema = z.strictObject({
  role: z.enum(['author', 'recipient']),
  /** The cloud skill's id, its `skillName` under the `cloud-custom` source. */
  remoteId: IdSchema,
  /** The SKILL.md hash the link recorded; null when it recorded none. */
  linkedContentHash: SkillContentHashSchema.nullable(),
  /** The local SKILL.md hash now; null when it could not be read. */
  localContentHash: SkillContentHashSchema.nullable(),
});
export type CatalogSkillCloudShare = z.output<
  typeof CatalogSkillCloudShareSchema
>;

export const CatalogSkillRowSchema = z.strictObject({
  entryId: IdSchema,
  sourceId: IdSchema,
  skillName: IdSchema,
  description: z.string().max(4096),
  source: z.string().max(1024),
  origin: z.enum(['builtin', 'custom', 'installed']),
  installedAt: z.string().max(64),
  updatedAt: z.string().max(64),
  updateAvailable: z.boolean(),
  /** The lock entry's version identity; null for built-in and custom skills or an unreadable lock. */
  version: z
    .strictObject({
      skillFolderHash: z.string().max(128).nullable(),
      skillPath: z.string().max(4096),
    })
    .nullable(),
  cloudShare: CatalogSkillCloudShareSchema.optional(),
});
export type CatalogSkillRow = z.output<typeof CatalogSkillRowSchema>;

export const CatalogSkillListParamsSchema = z.strictObject({
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export const CatalogSkillListResultSchema = z.strictObject({
  skills: z.array(CatalogSkillRowSchema).max(10000),
});

export const CatalogSkillReadParamsSchema = z.strictObject({
  skill: CatalogSkillRefSchema,
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export const CatalogSkillReadResultSchema = z.strictObject({
  entryId: IdSchema,
  frontmatter: CatalogSkillFrontmatterSchema,
  body: z.string().max(2_000_000),
  truncated: z.boolean(),
});

export const CatalogSkillFilesListParamsSchema = CatalogSkillReadParamsSchema;
export const CatalogSkillFilesListResultSchema = z.strictObject({
  entryId: IdSchema,
  files: z.array(z.string().min(1).max(4096)).max(501),
  truncated: z.boolean(),
});

export const CatalogSkillFileReadParamsSchema = z.strictObject({
  skill: CatalogSkillRefSchema,
  filePath: z.string().min(1).max(4096),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export const CatalogSkillFileReadResultSchema = z.strictObject({
  entryId: IdSchema,
  content: z.string().max(524_288),
  truncated: z.boolean(),
  binary: z.boolean(),
});

export const CatalogSkillDiscoverParamsSchema = z.strictObject({
  source: z.string().min(1).max(2048),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export const CatalogSkillDiscoverResultSchema = z.strictObject({
  source: z.string().max(512),
  skills: z
    .array(
      z.strictObject({
        name: z.string().max(512),
        description: z.string().max(4096),
        sourcePath: z.string().max(4096),
      }),
    )
    .max(CATALOG_SKILL_SOURCE_MAX_SKILLS),
  riskInfo: z.record(
    z.string().max(512),
    z.strictObject({
      level: z.enum(CATALOG_SKILL_RISK_LEVELS),
      socketAlerts: z.number().min(0).nullable(),
    }),
  ),
  hasMarketplace: z.boolean(),
  truncated: z.boolean(),
});
export type CatalogSkillDiscoverResult = z.output<
  typeof CatalogSkillDiscoverResultSchema
>;

export const CatalogSkillInstallParamsSchema = z.strictObject({
  source: z.string().min(1).max(2048),
  skillNames: z
    .array(z.string().min(1).max(512))
    .max(CATALOG_SKILL_SOURCE_MAX_SKILLS),
  _meta: Keyed,
});
export const CatalogSkillInstallResultSchema = z.strictObject({
  sourceId: IdSchema,
  /** Installed entries in request order, as many as the recorded outcome holds. */
  entryIds: z.array(IdSchema).max(500),
  /** Every named skill installed; absent from outcomes recorded before CAN-5873. */
  installedCount: z
    .number()
    .int()
    .min(0)
    .max(CATALOG_SKILL_SOURCE_MAX_SKILLS)
    .optional(),
});

export const CatalogSkillUpdateParamsSchema = z.strictObject({
  skill: CatalogSkillRefSchema,
  _meta: Keyed,
});
export const CatalogSkillUpdateResultSchema = z.strictObject({
  entryId: IdSchema,
});
export const CatalogSkillRemoveParamsSchema = CatalogSkillUpdateParamsSchema;
export const CatalogSkillRemoveResultSchema = CatalogSkillUpdateResultSchema;

export const CatalogSkillCustomSaveParamsSchema = z.strictObject({
  /** Not min-bounded: the service's name validation answers an empty or bad name. */
  name: z.string().max(512),
  /** Null creates; a value edits that skill and renames it when it differs from name. */
  originalName: z.string().max(512).nullable(),
  description: z.string().max(65_536),
  body: z.string().max(2_000_000),
  extraMetadata: z
    .record(z.string().max(512), z.string().max(65_536))
    .nullable(),
  preservedMetadata: CatalogSkillFrontmatterSchema.nullable(),
  /** Null keeps the supporting files; an array is the full desired set. A null content keeps that file's bytes. */
  files: z
    .array(
      z.strictObject({
        path: z.string().max(4096),
        content: z.string().max(2_000_000).nullable(),
      }),
    )
    .max(1000)
    .nullable(),
  _meta: Keyed,
});
export type CatalogSkillCustomSaveParams = z.output<
  typeof CatalogSkillCustomSaveParamsSchema
>;
export const CatalogSkillCustomSaveResultSchema = z.strictObject({
  entryId: IdSchema,
  skillName: IdSchema,
});

export const CatalogSkillUpdatesCheckParamsSchema = z.strictObject({
  _meta: Keyed,
});
/** The most installed skills one update check counts (CAN-5898). */
export const CATALOG_SKILL_UPDATES_MAX_COUNT = 100_000;

export const CatalogSkillUpdatesCheckResultSchema = z.strictObject({
  /**
   * Skills with an update available, in check order, as many as the recorded
   * outcome holds (CAN-5898). Outcomes recorded before CAN-5898 list every
   * checked skill.
   */
  updates: z
    .array(
      z.strictObject({
        entryId: IdSchema,
        sourceId: IdSchema,
        skillName: IdSchema,
        updateAvailable: z.boolean(),
      }),
    )
    .max(10000),
  /** Every installed skill checked; absent from outcomes recorded before CAN-5898. */
  checkedCount: z
    .number()
    .int()
    .min(0)
    .max(CATALOG_SKILL_UPDATES_MAX_COUNT)
    .optional(),
  /** Every checked skill with an update available; absent before CAN-5898. */
  updateCount: z
    .number()
    .int()
    .min(0)
    .max(CATALOG_SKILL_UPDATES_MAX_COUNT)
    .optional(),
});

const READ = [
  'core.catalog.skillNotFound',
  'core.catalog.skillPathInvalid',
  'core.catalog.skillContextRefused',
  'core.catalog.skillsUnavailable',
] as const;
export const CORE_CATALOG_SKILL_CODES = {
  list: ['core.catalog.skillsUnavailable'],
  read: READ,
  filesList: READ,
  fileRead: READ,
  discover: [
    'core.catalog.skillSourceInvalid',
    'core.catalog.skillDiscoveryFailed',
  ],
  install: [
    'core.catalog.skillSourceInvalid',
    'core.catalog.skillInstallFailed',
  ],
  update: [
    'core.catalog.skillNotFound',
    'core.catalog.skillReadOnly',
    'core.catalog.skillPathInvalid',
    'core.catalog.skillContextRefused',
    'core.catalog.skillUpdateFailed',
  ],
  remove: [
    'core.catalog.skillReadOnly',
    'core.catalog.skillPathInvalid',
    'core.catalog.skillContextRefused',
    'core.catalog.skillRemoveFailed',
  ],
  customSave: [
    'core.catalog.skillInvalid',
    'core.catalog.skillNameTaken',
    'core.catalog.skillNotFound',
    'core.catalog.skillPathInvalid',
    'core.catalog.skillContextRefused',
    'core.catalog.skillSaveFailed',
  ],
  updatesCheck: ['core.catalog.skillUpdateCheckFailed'],
} as const;

/** Served by the desktop dispatcher only (CAN-4124); kept out of the composed registries. */
export const CORE_CATALOG_SKILL_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.catalog.skill.list': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogSkillListParamsSchema,
      result: CatalogSkillListResultSchema,
      error: inherentOperationErrorSchema(CORE_CATALOG_SKILL_CODES.list),
    }),
    'core.catalog.skill.read': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogSkillReadParamsSchema,
      result: CatalogSkillReadResultSchema,
      error: inherentOperationErrorSchema(CORE_CATALOG_SKILL_CODES.read),
    }),
    'core.catalog.skill.files.list': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogSkillFilesListParamsSchema,
      result: CatalogSkillFilesListResultSchema,
      error: inherentOperationErrorSchema(CORE_CATALOG_SKILL_CODES.filesList),
    }),
    'core.catalog.skill.file.read': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogSkillFileReadParamsSchema,
      result: CatalogSkillFileReadResultSchema,
      error: inherentOperationErrorSchema(CORE_CATALOG_SKILL_CODES.fileRead),
    }),
    'core.catalog.skill.discover': defineCanopyQuery({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CATALOG_GRANTS.read],
      params: CatalogSkillDiscoverParamsSchema,
      result: CatalogSkillDiscoverResultSchema,
      error: inherentOperationErrorSchema(CORE_CATALOG_SKILL_CODES.discover),
    }),
  },
);

/** Served by the desktop dispatcher only (CAN-4124); kept out of the composed registries. */
export const CORE_CATALOG_SKILL_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.catalog.skill.install': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSkillInstallParamsSchema,
      result: CatalogSkillInstallResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SKILL_CODES.install),
    }),
    'core.catalog.skill.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSkillUpdateParamsSchema,
      result: CatalogSkillUpdateResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SKILL_CODES.update),
    }),
    'core.catalog.skill.remove': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSkillRemoveParamsSchema,
      result: CatalogSkillRemoveResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SKILL_CODES.remove),
    }),
    'core.catalog.skill.custom.save': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSkillCustomSaveParamsSchema,
      result: CatalogSkillCustomSaveResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SKILL_CODES.customSave),
    }),
    'core.catalog.skill.updates.check': defineCanopyInstruction({
      plane: 'core',
      domain: 'catalog',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [CATALOG_GRANTS.write],
      params: CatalogSkillUpdatesCheckParamsSchema,
      result: CatalogSkillUpdatesCheckResultSchema,
      error: keyedOperationErrorSchema(CORE_CATALOG_SKILL_CODES.updatesCheck),
    }),
  });
