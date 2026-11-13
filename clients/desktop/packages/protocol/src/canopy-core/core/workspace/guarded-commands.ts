import { z } from 'zod';
import { isSafePortableRelativePath } from '../../../safe-relative-path';
import { CanopyRequestMetadataSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
} from '../../errors';

/*
 * The guarded W5 settings commands (CAN-5524, W7b-1a): the Zod of the
 * cataloged `core.workspace.hooks.update` and `core.worktree.hooks.setPaused`
 * pages, of `core.workspace.plugins.update`, `.retention.update` and
 * `.cowork.update`, and of CAN-5527's `core.worktree.reorder` page. Their typed
 * in-process boundaries stay in Electron main (W5d2); only the desktop's
 * in-process dispatcher serves these definitions (W7b-1b, W7b-1c), so, like
 * the web-only registries, they stay out of CORE_INSTRUCTION_DEFINITIONS,
 * whose daemon dispatcher requires a handler for every definition. The web
 * core never serves them: they edit host-local W5 files.
 */

/** The workspace, worktree and repository id charset (`validateId`). */
const slug = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
const revision = z.number().int().nonnegative();
const keyedMeta = CanopyRequestMetadataSchema.extend({
  idempotencyKey: z.string().min(1).max(512),
});
/** A closed, additive success result: clients ignore unknown fields. */
const openResult = <Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodObject<Shape, z.core.$catchall<typeof CanopyJsonValueSchema>> =>
  z.object(shape).catchall(CanopyJsonValueSchema);

// Every keyed operation's retry codes (the scripts page's vocabulary).
const WORKSPACE_KEYED_CODES = [
  'core.workspace.idempotencyKeyReused',
  'core.workspace.requestInProgress',
  'core.workspace.recoveryRequired',
  'core.workspace.outcomeExpired',
] as const;
const WORKTREE_KEYED_CODES = [
  'core.worktree.idempotencyKeyReused',
  'core.worktree.requestInProgress',
  'core.worktree.recoveryRequired',
  'core.worktree.outcomeExpired',
] as const;

// --- core.workspace.hooks.update (#7) --------------------------------------

const hookAction = z.union([
  z.strictObject({
    type: z.literal('command'),
    command: z.string(),
    shell: z
      .strictObject({
        windows: z.enum(['cmd', 'powershell', 'bash']).optional(),
        mac: z.enum(['zsh', 'bash']).optional(),
        linux: z.enum(['bash', 'zsh']).optional(),
      })
      .optional(),
    interactive: z.literal(true).optional(),
  }),
  // Chat and pipeline actions keep their persisted fields open (CAN-4413).
  z
    .object({ type: z.literal('chat'), prompt: z.string() })
    .catchall(CanopyJsonValueSchema),
  z
    .object({
      type: z.literal('pipeline'),
      source: z.enum(['bundled', 'local', 'project', 'curated']),
      id: z.string().min(1),
    })
    .catchall(CanopyJsonValueSchema),
]);
const hookMap = z.record(
  // The catalog's propertyNames carries bounds and no type.
  z.string().min(1).max(512).meta({ type: undefined }),
  z.array(hookAction).nullable(),
);

export const CoreWorkspaceHooksUpdateParamsSchema = z.strictObject({
  workspaceId: slug,
  expectedRevision: revision.optional(),
  change: z.union([
    z.strictObject({ kind: z.literal('replace'), hooks: hookMap.optional() }),
    z.strictObject({
      kind: z.literal('repositories'),
      repos: z.array(
        z.strictObject({ repoId: slug, hooks: hookMap.optional() }),
      ),
    }),
  ]),
  _meta: keyedMeta,
});
export type CoreWorkspaceHooksUpdateParams = z.output<
  typeof CoreWorkspaceHooksUpdateParamsSchema
>;

/** Version 1 returns no fields; the keyed outcome is null. */
export const CoreWorkspaceHooksUpdateResultSchema = openResult({});
export type CoreWorkspaceHooksUpdateResult = z.output<
  typeof CoreWorkspaceHooksUpdateResultSchema
>;

export const CoreWorkspaceHooksUpdateErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.workspace.readOnly',
        'core.workspace.configurationUnavailable',
        'core.workspace.repositoryNotFound',
        'core.workspace.revisionConflict',
        ...WORKSPACE_KEYED_CODES,
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

// --- core.workspace.plugins.update (#9) ------------------------------------

const ref = <Shape extends z.ZodRawShape>(
  shape: Shape,
): z.ZodArray<z.ZodObject<Shape, z.core.$strict>> =>
  z.array(z.strictObject(shape));

/**
 * Plugin selections in their persisted shape (`ChatTabPluginSelections`)
 * without the legacy `bundleIds` alias. The host normalizes entries as it does
 * in process (`normalizePluginSelections`).
 */
export const CoreWorkspacePluginSelectionsSchema = z.strictObject({
  collectionIds: z.array(z.string()),
  skillRefs: ref({ sourceId: z.string(), skillName: z.string() }),
  pluginRefs: ref({ marketplaceId: z.string(), pluginName: z.string() }),
  mcpServerRefs: ref({ serverId: z.string(), configId: z.string() }).optional(),
  mcpHttpAuthPreferences: z
    .array(
      z.strictObject({
        target: z.union([
          z.strictObject({
            kind: z.literal('standalone'),
            serverId: z.string(),
            configId: z.string(),
          }),
          z.strictObject({
            kind: z.literal('plugin'),
            marketplaceId: z.string(),
            pluginName: z.string(),
            serverName: z.string(),
          }),
        ]),
        handler: z.enum(['canopy', 'provider', 'account']),
      }),
    )
    .optional(),
  unresolvedCapabilities: z
    .array(
      z.strictObject({
        kind: z.enum(['plugin', 'mcp', 'skill']),
        sourceId: z.string().min(1).max(256),
        catalogId: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
      }),
    )
    .max(200)
    .optional(),
});
export type CoreWorkspacePluginSelections = z.output<
  typeof CoreWorkspacePluginSelectionsSchema
>;

export const CoreWorkspacePluginsUpdateParamsSchema = z.strictObject({
  workspaceId: slug,
  expectedRevision: revision.optional(),
  change: z.union([
    z.strictObject({
      kind: z.literal('setDefaults'),
      defaultPluginSelections: CoreWorkspacePluginSelectionsSchema,
    }),
    z.strictObject({
      kind: z.literal('selectRecommended'),
      selections: z.array(
        z.union([
          z.strictObject({
            kind: z.literal('skill'),
            sourceId: z.string(),
            skillName: z.string(),
          }),
          z.strictObject({
            kind: z.literal('plugin'),
            marketplaceId: z.string(),
            pluginName: z.string(),
          }),
        ]),
      ),
      optOutKeys: z.array(z.string()),
      clearOptOutKeys: z.array(z.string()),
    }),
  ]),
  _meta: keyedMeta,
});
export type CoreWorkspacePluginsUpdateParams = z.output<
  typeof CoreWorkspacePluginsUpdateParamsSchema
>;

export const CoreWorkspacePluginsUpdateResultSchema = openResult({
  workspaceId: slug,
  written: z.boolean(),
  defaultPluginSelections: CoreWorkspacePluginSelectionsSchema.optional(),
  recommendedPluginOptOutKeys: z.array(z.string()).optional(),
});
export type CoreWorkspacePluginsUpdateResult = z.output<
  typeof CoreWorkspacePluginsUpdateResultSchema
>;

export const CoreWorkspacePluginsUpdateErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.workspace.notFound',
        'core.workspace.configurationUnavailable',
        'core.workspace.revisionConflict',
        ...WORKSPACE_KEYED_CODES,
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

// --- core.workspace.retention.update (#11) ---------------------------------

/** `MAX_ARCHIVE_RETENTION_DAYS` in `@canopy/protocol/archive-retention`. */
const MAX_RETENTION_DAYS = 36_500;
const days = (minimum: number): z.ZodNullable<z.ZodNumber> =>
  z.number().int().min(minimum).max(MAX_RETENTION_DAYS).nullable();

export const CoreWorkspaceRetentionUpdateParamsSchema = z.strictObject({
  workspaceId: slug,
  expectedRevision: revision.optional(),
  patch: z.strictObject({
    archiveRetentionDays: days(0),
    autoArchiveDays: days(1).optional(),
    autoArchiveDeleteBranch: z.boolean().optional(),
  }),
  _meta: keyedMeta,
});
export type CoreWorkspaceRetentionUpdateParams = z.output<
  typeof CoreWorkspaceRetentionUpdateParamsSchema
>;

export const CoreWorkspaceRetentionUpdateResultSchema = openResult({
  workspaceId: slug,
  activityBaselineRecorded: z.boolean(),
});
export type CoreWorkspaceRetentionUpdateResult = z.output<
  typeof CoreWorkspaceRetentionUpdateResultSchema
>;

export const CoreWorkspaceRetentionUpdateErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.workspace.notFound',
        'core.workspace.configurationUnavailable',
        'core.workspace.invalidState',
        'core.workspace.revisionConflict',
        ...WORKSPACE_KEYED_CODES,
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

// --- core.workspace.cowork.update (#12, A28′(a)) ---------------------------

/** `MAX_WORKSPACE_TEMPLATE_STARTER_PROMPTS` and its id and text bounds. */
const starterPrompts = z
  .array(
    z.strictObject({
      id: z.string().min(1).max(128).regex(/\S/),
      text: z.string().min(1).max(2_000).regex(/\S/),
    }),
  )
  .max(15)
  .refine(
    (prompts) => new Set(prompts.map(({ id }) => id)).size === prompts.length,
    'Duplicate starter prompt id',
  );

/**
 * `isProjectStartPage`'s file path rule, and not blank. The pattern publishes
 * the rule in the page's JSON Schema; the refinement keeps the host's
 * validator authoritative.
 */
const startPagePath = z
  .string()
  .min(1)
  .max(4096)
  .regex(
    /^(?=[\s\S]*\S)(?![A-Za-z]:)(?!\.\.?(?:\/|$))(?![\s\S]*\/\.\.?(?:\/|$))[^/\\]+(?:\/[^/\\]+)*$/,
  )
  .refine(isSafePortableRelativePath, 'Not a safe relative path');

export const CoreWorkspaceCoworkUpdateParamsSchema = z.strictObject({
  workspaceId: slug,
  expectedRevision: revision.optional(),
  // A28′(a): name, color and Always show are core.workspace.update fields;
  // explicit default plugins are core.workspace.plugins.update's.
  settings: z.strictObject({
    description: z.string().optional(),
    defaultModel: z.string().optional(),
    defaultPresetId: z.string().optional(),
    presets: z
      .array(
        z.strictObject({
          id: z.string(),
          name: z.string(),
          pluginSelections: CoreWorkspacePluginSelectionsSchema,
        }),
      )
      .optional(),
    archiveRetentionDays: days(0).optional(),
    autoArchiveDays: days(1).optional(),
    starterPrompts: starterPrompts.optional(),
    startPage: z
      .union([
        z.strictObject({
          kind: z.literal('file'),
          repoId: z
            .string()
            .regex(/^[A-Za-z0-9_-]+$/)
            .optional(),
          path: startPagePath,
        }),
        z.strictObject({
          kind: z.literal('url'),
          // The catalog's unescaped pattern, enforced by the protocol check.
          url: z
            .url({ protocol: /^https?$/ })
            .max(4096)
            .meta({ pattern: '^https?://' }),
        }),
        z.null(),
      ])
      .optional(),
  }),
  _meta: keyedMeta,
});
export type CoreWorkspaceCoworkUpdateParams = z.output<
  typeof CoreWorkspaceCoworkUpdateParamsSchema
>;

export const CoreWorkspaceCoworkUpdateResultSchema = openResult({
  workspaceId: slug,
});
export type CoreWorkspaceCoworkUpdateResult = z.output<
  typeof CoreWorkspaceCoworkUpdateResultSchema
>;

export const CoreWorkspaceCoworkUpdateErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.workspace.notFound',
        'core.workspace.configurationUnavailable',
        'core.workspace.invalidState',
        'core.workspace.revisionConflict',
        ...WORKSPACE_KEYED_CODES,
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

// --- core.worktree.hooks.setPaused (#26) -----------------------------------

export const CoreWorktreeHooksSetPausedParamsSchema = z.strictObject({
  workspaceId: slug,
  worktreeId: slug,
  expectedRevision: revision.optional(),
  change: z.union([
    z.strictObject({
      kind: z.literal('replace'),
      pausedHookKeys: z.array(z.string()),
    }),
    z.strictObject({
      kind: z.enum(['pause', 'resume']),
      hookKeys: z.array(z.string()),
    }),
  ]),
  _meta: keyedMeta,
});
export type CoreWorktreeHooksSetPausedParams = z.output<
  typeof CoreWorktreeHooksSetPausedParamsSchema
>;

export const CoreWorktreeHooksSetPausedResultSchema = openResult({
  worktree: openResult({
    id: z.string().min(1).max(512),
    branchName: z.string(),
    createdAt: z.string(),
    label: z.string().optional(),
    hidden: z.boolean().optional(),
    pinned: z.boolean().optional(),
    branchGroupingOverride: z.enum(['group', 'ungroup']).optional(),
    branchGroupingParentWorktreeId: z.string().optional(),
    trackedBaseBranch: z.string().nullable().optional(),
    // The catalog leaves the repository-id keys unconstrained.
    trackedRepoBaseBranches: z
      .record(z.string(), z.string())
      .meta({ propertyNames: undefined })
      .optional(),
    includedRepoIds: z.array(z.string()).optional(),
    setupPhase: z.enum(['git-pending', 'git-ready']).optional(),
    pausedHookKeys: z.array(z.string()).optional(),
  }),
  pausedHookKeys: z.array(z.string()),
  changed: z.boolean(),
});
export type CoreWorktreeHooksSetPausedResult = z.output<
  typeof CoreWorktreeHooksSetPausedResultSchema
>;

export const CoreWorktreeHooksSetPausedErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'core.worktree.readOnly',
        'core.worktree.notFound',
        'core.worktree.listUnavailable',
        'core.worktree.revisionConflict',
        ...WORKTREE_KEYED_CODES,
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

// --- core.worktree.reorder (#23, CAN-5527's move-only page) ----------------

/** The page's opaque ids carry bounds only, not the `validateId` charset. */
const opaqueId = z.string().min(1).max(512);

// A22(a): group membership is not a field, so it fails as unknown.
export const CoreWorktreeReorderParamsSchema = z.strictObject({
  workspaceId: opaqueId,
  activeWorktreeId: opaqueId,
  overWorktreeId: opaqueId,
  // Of the `worktrees:{workspaceId}` collection, not of a row.
  expectedRevision: revision.optional(),
  _meta: keyedMeta,
});
export type CoreWorktreeReorderParams = z.output<
  typeof CoreWorktreeReorderParamsSchema
>;

/**
 * Empty and, as the page publishes it, closed. Clients read the new order from
 * `core.worktree.list`.
 */
export const CoreWorktreeReorderResultSchema = z.strictObject({});
export type CoreWorktreeReorderResult = z.output<
  typeof CoreWorktreeReorderResultSchema
>;

export const CoreWorktreeReorderErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.worktree.revisionConflict',
      'core.worktree.notFound',
      'core.worktree.readOnly',
      ...WORKTREE_KEYED_CODES,
    ])
    .optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

const guarded = {
  plane: 'core',
  version: 1,
  placement: 'core-only',
  idempotency: 'keyed',
} as const;

export const CORE_GUARDED_SETTINGS_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.workspace.hooks.update': defineCanopyInstruction({
      ...guarded,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceHooksUpdateParamsSchema,
      result: CoreWorkspaceHooksUpdateResultSchema,
      error: CoreWorkspaceHooksUpdateErrorSchema,
    }),
    'core.workspace.plugins.update': defineCanopyInstruction({
      ...guarded,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspacePluginsUpdateParamsSchema,
      result: CoreWorkspacePluginsUpdateResultSchema,
      error: CoreWorkspacePluginsUpdateErrorSchema,
    }),
    'core.workspace.retention.update': defineCanopyInstruction({
      ...guarded,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceRetentionUpdateParamsSchema,
      result: CoreWorkspaceRetentionUpdateResultSchema,
      error: CoreWorkspaceRetentionUpdateErrorSchema,
    }),
    'core.workspace.cowork.update': defineCanopyInstruction({
      ...guarded,
      domain: 'workspace',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceCoworkUpdateParamsSchema,
      result: CoreWorkspaceCoworkUpdateResultSchema,
      error: CoreWorkspaceCoworkUpdateErrorSchema,
    }),
    'core.worktree.hooks.setPaused': defineCanopyInstruction({
      ...guarded,
      domain: 'worktree',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeHooksSetPausedParamsSchema,
      result: CoreWorktreeHooksSetPausedResultSchema,
      error: CoreWorktreeHooksSetPausedErrorSchema,
    }),
    'core.worktree.reorder': defineCanopyInstruction({
      ...guarded,
      domain: 'worktree',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeReorderParamsSchema,
      result: CoreWorktreeReorderResultSchema,
      error: CoreWorktreeReorderErrorSchema,
    }),
  });
