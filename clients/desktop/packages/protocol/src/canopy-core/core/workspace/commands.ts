import { z } from 'zod';
import {
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { OperationStatusSchema } from '../operation/schemas';
import { CoreWorkspaceSchema } from './reads';

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const revision = z.number().int().nonnegative();
const keyedMeta = CanopyRequestMetadataSchema.extend({ idempotencyKey: id });

export const CoreWorkspaceUpdateParamsSchema = z.strictObject({
  workspaceId: id,
  // Enforced when present (DM-3(a)): desktop reads publish no revision for a
  // workspace W5 never wrote, and these field-scoped patches lose no edit.
  expectedRevision: revision.optional(),
  patch: z
    .strictObject({
      name: z.string().min(1).max(256).regex(/\S/).optional(),
      color: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/)
        .optional(),
      pinned: z.boolean().optional(),
      collapsed: z.boolean().optional(),
      itemSortMode: z.enum(['manual', 'last-updated']).optional(),
      activitySectionOrder: z
        .array(
          z.enum([
            'plugins',
            'summary',
            'changed-files',
            'pull-request',
            'background-processes',
            'plans',
            'pipeline-runs',
            'cost',
            'scripts',
            'hooks',
            'terminals',
            'todo',
            'mcp-servers',
            'notes',
            'prompts',
            'attachments',
            'memory',
          ]),
        )
        .max(17)
        .meta({ uniqueItems: true })
        .optional(),
      alwaysShow: z.boolean().optional(),
      startPage: z
        .union([
          z.strictObject({
            kind: z.literal('file'),
            repoId: z
              .string()
              .regex(/^[A-Za-z0-9_-]+$/)
              .optional(),
            path: z.string().min(1).max(4096).regex(/\S/),
          }),
          z.strictObject({
            kind: z.literal('url'),
            // The catalog's unescaped pattern, enforced by the protocol check.
            url: z
              .url({ protocol: /^https?$/ })
              .max(4096)
              .meta({ pattern: '^https?://' }),
          }),
          z.strictObject({ kind: z.literal('inherit') }),
          z.null(),
        ])
        .optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, 'Patch is empty.')
    .meta({ minProperties: 1 }),
  _meta: keyedMeta,
});
export type CoreWorkspaceUpdateParams = z.output<
  typeof CoreWorkspaceUpdateParamsSchema
>;

// The `core.workspace.get` projection, typed workspace fields included
// (CAN-5373), with the update's bounded name. Its stamps follow the read
// (DM-2): a host omits a revision or time it lacks. The web core returns all.
export const CoreWorkspaceUpdateResultSchema = CoreWorkspaceSchema.safeExtend({
  name: z.string().min(1).max(256),
});
export type CoreWorkspaceUpdateResult = z.output<
  typeof CoreWorkspaceUpdateResultSchema
>;

const workspaceErrorCodes = [
  'core.workspace.invalidState',
  'core.workspace.revisionConflict',
  'core.workspace.notFound',
] as const;

const workspaceError = CanopyErrorPayloadSchema.extend({
  code: z.enum(workspaceErrorCodes).optional(),
});

// #3 adds the W5 refusal, key and recovery codes (A7, q-14 D2(a)).
const workspaceUpdateError = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      ...workspaceErrorCodes,
      'core.workspace.idempotencyKeyReused',
      'core.workspace.requestInProgress',
      'core.workspace.recoveryRequired',
      'core.workspace.outcomeExpired',
      'core.workspace.configurationUnavailable',
      'core.workspace.readOnly',
    ])
    .optional(),
});

// #1 and #2 add the keyed creates' key and recovery codes (W7b-3, A7, q-14
// D2(a)).
const workspaceCreateError = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      ...workspaceErrorCodes,
      'core.workspace.idempotencyKeyReused',
      'core.workspace.requestInProgress',
      'core.workspace.recoveryRequired',
      'core.workspace.outcomeExpired',
    ])
    .optional(),
});

const workspaceKind = z.enum(['single_repo', 'multi_repo', 'cowork']);
const repositoryWorkspaceKind = z.enum(['single_repo', 'multi_repo']);
const nullableText = (max: number): z.ZodNullable<z.ZodString> =>
  z.string().max(max).nullable();

export const CoreWorkspaceCreateParamsSchema = z.strictObject({
  name: z.string().min(1).max(512),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('empty'), workspaceKind }),
    z.strictObject({
      kind: z.literal('local_repository'),
      rootGrantId: id,
      workspaceKind: repositoryWorkspaceKind,
    }),
    z.strictObject({
      kind: z.literal('remote_repositories'),
      repositories: z
        .array(
          z.strictObject({
            remoteUrl: z.string().min(1).max(4096),
            defaultBranch: nullableText(512),
          }),
        )
        .min(1),
      workspaceKind: repositoryWorkspaceKind,
    }),
    z.strictObject({
      kind: z.literal('integration_resources'),
      integrationId: id,
      resourceIds: z.array(id).min(1),
      workspaceKind: repositoryWorkspaceKind,
    }),
  ]),
  temporary: z.boolean(),
  _meta: keyedMeta,
});
export type CoreWorkspaceCreateParams = z.output<
  typeof CoreWorkspaceCreateParamsSchema
>;

export const CoreWorkspaceCreateResultSchema = z.strictObject({
  workspace: z.strictObject({
    workspaceId: id,
    name: z.string().min(1).max(512),
    kind: workspaceKind,
    temporary: z.boolean(),
    repositories: z.array(
      z.strictObject({
        repoId: id,
        name: z.string().min(1).max(512),
        remoteUrl: nullableText(4096),
        branch: nullableText(512),
        headSha: z
          .string()
          .regex(/^[a-fA-F0-9]{7,64}$/)
          .nullable(),
      }),
    ),
    // D-2 (W7b-3): a host omits a revision or time it lacks, as the
    // `core.workspace.get` read does. The web core returns all four.
    settingsRevision: revision.optional(),
    revision: revision.optional(),
    createdAt: timestamp.optional(),
    updatedAt: timestamp.optional(),
  }),
  operation: z
    .strictObject({
      operationId: id,
      state: z.enum([
        'queued',
        'running',
        'waiting',
        'succeeded',
        'failed',
        'cancelled',
      ]),
    })
    .nullable(),
});
export type CoreWorkspaceCreateResult = z.output<
  typeof CoreWorkspaceCreateResultSchema
>;

export const CoreWorkspaceDeleteParamsSchema = z.strictObject({
  workspaceId: id,
  expectedRevision: revision,
  deleteRemoteBranches: z.boolean().optional(),
  /**
   * `archive` keeps the project indefinitely instead of moving it to the
   * trash (CAN-6109); a host that cannot keep one refuses it.
   */
  mode: z.enum(['delete', 'archive']).optional(),
  _meta: keyedMeta,
});
export type CoreWorkspaceDeleteParams = z.output<
  typeof CoreWorkspaceDeleteParamsSchema
>;

// The catalog's operation reference for accepted durable work, open for
// additive fields. Its kind pattern is looser than OperationKindSchema's.
const operationReference = z
  .object({
    operationId: id,
    kind: z.string().regex(/^(core|worker)(\.[a-z][A-Za-z0-9]*){2,}$/),
    status: OperationStatusSchema,
    authorityId: nullableText(512).optional(),
    executionTargetId: nullableText(512).optional(),
    runtimeDelegationId: nullableText(512).optional(),
    parentOperationId: nullableText(512).optional(),
  })
  .catchall(CanopyJsonValueSchema);

export const CoreWorkspaceDeleteResultSchema = operationReference;
export type CoreWorkspaceDeleteResult = z.output<
  typeof CoreWorkspaceDeleteResultSchema
>;

// The catalog's git remote forms; `.meta` keeps the page's unescaped pattern.
const GIT_URL_PATTERN =
  '^(?:[Hh][Tt][Tt][Pp][Ss]?://|[Ss][Ss][Hh]://|[^\\s/@-][^\\s/@]*@[^\\s/:]+:\\S)';

// #2's page (W7b-3, B7): no owner or organization field; the host derives it.
export const CoreWorkspaceImportParamsSchema = z.strictObject({
  source: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('local_picker_selection'),
      selectionId: id,
    }),
    z.strictObject({
      kind: z.literal('git_url'),
      value: z
        .string()
        .min(1)
        .max(4096)
        .regex(new RegExp(GIT_URL_PATTERN))
        .meta({ pattern: GIT_URL_PATTERN }),
    }),
    z.strictObject({ kind: z.literal('provider_project'), value: id }),
  ]),
  name: z.string().min(1).max(256),
  targetId: z.string().nullable().optional(),
  _meta: keyedMeta,
});
export type CoreWorkspaceImportParams = z.output<
  typeof CoreWorkspaceImportParamsSchema
>;

export const CoreWorkspaceImportResultSchema = operationReference;
export type CoreWorkspaceImportResult = z.output<
  typeof CoreWorkspaceImportResultSchema
>;

const branch = z.string().min(1).max(512).regex(/\S/);
const branchName = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\s*[^\s-]/);
const exclusiveWorktreeSources = [
  ['branch', 'existingBranch'],
  ['branch', 'suggestedBranch'],
  ['existingBranch', 'suggestedBranch'],
  ['baseWorktreeId', 'baseBranch'],
  ['baseWorktreeId', 'existingBranch'],
] as const;

export const CoreWorktreeCreateParamsSchema = z
  .strictObject({
    workspaceId: id,
    branch: branchName.optional(),
    existingBranch: branchName.optional(),
    suggestedBranch: branchName.optional(),
    baseBranch: branch.optional(),
    baseWorktreeId: id.optional(),
    includedRepositoryIds: z
      .array(id)
      .max(256)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate id')
      .meta({ uniqueItems: true })
      .optional(),
    sidebarItemGroupId: z
      .string()
      .max(512)
      .regex(/^grp-[a-z0-9][a-z0-9-]*$/)
      .optional(),
    baseHeadSha: z.string().nullable().optional(),
    targetId: z.string().nullable().optional(),
    _meta: keyedMeta,
  })
  .superRefine((params, context) => {
    for (const [first, second] of exclusiveWorktreeSources)
      if (params[first] !== undefined && params[second] !== undefined)
        context.addIssue({
          code: 'custom',
          path: [second],
          message: `${first} and ${second} are mutually exclusive.`,
        });
  })
  .meta({
    allOf: [
      {
        not: {
          anyOf: exclusiveWorktreeSources
            .slice(0, 3)
            .map((pair) => ({ required: [...pair] })),
        },
      },
      {
        not: {
          anyOf: exclusiveWorktreeSources
            .slice(3)
            .map((pair) => ({ required: [...pair] })),
        },
      },
    ],
  });
export type CoreWorktreeCreateParams = z.output<
  typeof CoreWorktreeCreateParamsSchema
>;

export const CoreWorktreeCreateResultSchema = operationReference.extend({
  worktreeId: id.optional(),
  branchName: z.string().min(1).max(512).optional(),
  setupPhase: z.enum(['git-pending', 'git-ready']).optional(),
});
export type CoreWorktreeCreateResult = z.output<
  typeof CoreWorktreeCreateResultSchema
>;

// The worktree read's `createdAt`, echoed so a recreated id is refused. It
// keeps the read's loose string: historical rows hold date-only values.
const expectedCreatedAt = z.string().min(1).max(512);

export const CoreWorktreeDeleteParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  worktreeId: id,
  expectedRevision: revision,
  expectedCreatedAt: expectedCreatedAt.optional(),
  force: z.boolean().optional(),
  _meta: keyedMeta,
});
export type CoreWorktreeDeleteParams = z.output<
  typeof CoreWorktreeDeleteParamsSchema
>;

export const CoreWorktreeDeleteResultSchema = operationReference;
export type CoreWorktreeDeleteResult = z.output<
  typeof CoreWorktreeDeleteResultSchema
>;

export const CoreWorktreeUpdateParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  worktreeId: id,
  expectedRevision: revision,
  patch: z
    .strictObject({
      label: z.string().max(256).nullable().optional(),
      hidden: z.boolean().optional(),
      pinned: z.boolean().optional(),
      // The catalog lists null inside the enum as well as beside it.
      branchGroupingOverride: z
        .enum(['group', 'ungroup'])
        .meta({ enum: ['group', 'ungroup', null] })
        .nullable()
        .optional(),
      trackedBaseBranch: branch.nullable().optional(),
      trackedRepoBaseBranches: z
        .record(
          // The catalog's propertyNames carries a pattern and no type.
          z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,512}$/)
            .meta({ type: undefined }),
          branch.nullable(),
        )
        .optional(),
      targetId: z.string().nullable().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, 'Patch is empty.')
    .meta({ minProperties: 1 }),
  _meta: keyedMeta,
});
export type CoreWorktreeUpdateParams = z.output<
  typeof CoreWorktreeUpdateParamsSchema
>;

export const CoreWorktreeArchiveParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  worktreeId: id,
  expectedRevision: revision,
  expectedCreatedAt: expectedCreatedAt.optional(),
  // Web restores with false; the desktop refuses it (D-6(1)).
  archived: z.boolean(),
});
export type CoreWorktreeArchiveParams = z.output<
  typeof CoreWorktreeArchiveParamsSchema
>;

// Fields follow the desktop worktree read (D-2): a host omits a revision or
// write time it lacks, nulls an untracked base, and keeps a historical
// date-only createdAt. The web core returns every field. `name` takes the
// branch's 512 bound because the desktop read's name is its stored label or
// branch (W7b-1b, settled by the orchestrator; ref can5549-name-bound).
export const CoreWorktreeCommandResultSchema = z
  .object({
    worktreeId: id,
    workspaceId: id,
    name: z.string().min(1).max(512),
    state: z.enum(['creating', 'ready', 'archived', 'deleting', 'error']),
    revision: revision.optional(),
    baseBranch: id.nullable(),
    branch: id,
    targetId: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: timestamp.optional(),
  })
  .catchall(CanopyJsonValueSchema);
export type CoreWorktreeCommandResult = z.output<
  typeof CoreWorktreeCommandResultSchema
>;

const worktreeError = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      'core.worktree.invalidState',
      'core.worktree.revisionConflict',
      'core.worktree.notFound',
      'core.worktree.idempotencyKeyReused',
      'core.worktree.requestInProgress',
      'core.worktree.recoveryRequired',
      'core.worktree.outcomeExpired',
    ])
    .optional(),
});

// Served by the web core only (CAN-4158). Kept out of CORE_INSTRUCTION_DEFINITIONS,
// as the transport definitions are, because the daemon dispatcher requires a
// handler for every definition it is given and has none for these yet.
export const CORE_WORKSPACE_COMMAND_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.workspace.create': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceCreateParamsSchema,
      result: CoreWorkspaceCreateResultSchema,
      error: workspaceCreateError.extend({
        retry: CanopyKeyedRetryDirectiveSchema,
      }),
    }),
    'core.workspace.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceDeleteParamsSchema,
      result: CoreWorkspaceDeleteResultSchema,
      error: workspaceError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.worktree.create': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeCreateParamsSchema,
      result: CoreWorktreeCreateResultSchema,
      error: worktreeError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.worktree.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeDeleteParamsSchema,
      result: CoreWorktreeDeleteResultSchema,
      error: worktreeError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.workspace.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceUpdateParamsSchema,
      result: CoreWorkspaceUpdateResultSchema,
      error: workspaceUpdateError.extend({
        retry: CanopyKeyedRetryDirectiveSchema,
      }),
    }),
    'core.worktree.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeUpdateParamsSchema,
      result: CoreWorktreeCommandResultSchema,
      error: worktreeError.extend({ retry: CanopyKeyedRetryDirectiveSchema }),
    }),
    'core.worktree.archive': defineCanopyInstruction({
      plane: 'core',
      domain: 'worktree',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.worktree.write'],
      params: CoreWorktreeArchiveParamsSchema,
      result: CoreWorktreeCommandResultSchema,
      error: worktreeError.extend({ retry: CanopyQueryRetryDirectiveSchema }),
    }),
  });

// `core.workspace.import` (#2, W7b-3): served by the in-process desktop
// dispatcher only, so kept out of the web registry above and, like it, out of
// CORE_INSTRUCTION_DEFINITIONS. It shares #1's error codes.
export const CORE_WORKSPACE_IMPORT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.workspace.import': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: ['core.workspace.write'],
      params: CoreWorkspaceImportParamsSchema,
      result: CoreWorkspaceImportResultSchema,
      error: workspaceCreateError.extend({
        retry: CanopyKeyedRetryDirectiveSchema,
      }),
    }),
  });
