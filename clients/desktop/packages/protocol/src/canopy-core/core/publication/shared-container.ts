import { z } from 'zod';

import {
  MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION,
  MAX_SHARED_CONTAINER_RUN_COMMAND_LENGTH,
  MAX_SHARED_CONTAINER_RUN_COMMANDS,
  MAX_SHARED_CONTAINER_RUN_ENV_NAME_LENGTH,
  MAX_SHARED_CONTAINER_RUN_ENV_NAMES,
  SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN,
  SHARED_CONTAINER_TYPES,
} from '../../../shared-containers';
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
} from '../../errors';
import { PUBLICATION_GRANTS } from './operations';
import { PublicationRepositoryRefSchema } from './plan-sharing';

/*
 * A shared container's publisher side (CAN-6501 PR 5): the file scope a
 * worktree shares and the share preview, as desktop's shared-containers
 * save-file-scope and preview channels answer them. Spec-first: no registry
 * composes them, so every runtime answers `capability_unavailable` until a
 * later CAN-6501 PR adds the handler.
 */

/** The workspace and worktree id charset (`validateId`). */
const SlugSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

// Desktop's file-scope-store bounds.
const MAX_SCOPE_PATHS = 200;
const MAX_SCOPE_PATH_LENGTH = 1_024;
const MAX_SCOPE_ITEM_IDS = 1_000;

const ScopePathSchema = z.string().min(1).max(MAX_SCOPE_PATH_LENGTH);
// No length cap: ids mirror the desktop store, which keeps any id in this
// charset (`normalizeIds`); the transport frame limit (8 MiB) still bounds them.
const ScopeItemIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe(
    'A selected note or prompt id. Unbounded in length, as the desktop store keeps it; the transport frame limit applies.',
  );
// A picker row's id is Cowork's raw Markdown filename stem.
const PickerItemIdSchema = z
  .string()
  .describe(
    'A Markdown filename stem without `.md`, as desktop passes it through: it may hold dots or spaces, and a file named `.md` gives an empty id. Unbounded in length; the transport frame limit applies.',
  );
const RunScriptNameSchema = z
  .string()
  .regex(SHARED_CONTAINER_RUN_COMMAND_NAME_PATTERN);
const CountSchema = z.number().int().nonnegative();

/** The normalized scope; a pinned layout's snapshot never leaves the core. */
export const SharedContainerFileScopeSchema = z.strictObject({
  includedPaths: z.array(ScopePathSchema).max(MAX_SCOPE_PATHS),
  excludedPaths: z.array(ScopePathSchema).max(MAX_SCOPE_PATHS).optional(),
  legacyAllowlist: z.boolean().optional(),
  includedNoteIds: z
    .array(ScopeItemIdSchema)
    .max(MAX_SCOPE_ITEM_IDS)
    .optional(),
  excludedNoteIds: z
    .array(ScopeItemIdSchema)
    .max(MAX_SCOPE_ITEM_IDS)
    .optional(),
  includedPromptIds: z
    .array(ScopeItemIdSchema)
    .max(MAX_SCOPE_ITEM_IDS)
    .optional(),
  excludedPromptIds: z
    .array(ScopeItemIdSchema)
    .max(MAX_SCOPE_ITEM_IDS)
    .optional(),
  runSharingEnabled: z.boolean().optional(),
  runSharingDisabled: z.boolean().optional(),
  includedRunScripts: z
    .array(RunScriptNameSchema)
    .max(MAX_SHARED_CONTAINER_RUN_COMMANDS)
    .optional(),
  excludedRunScripts: z
    .array(RunScriptNameSchema)
    .max(MAX_SCOPE_ITEM_IDS)
    .optional(),
  preferredLayout: z
    .strictObject({
      enabled: z.boolean(),
      pinnedAt: z.iso.datetime().optional(),
    })
    .optional(),
});
export type SharedContainerFileScope = z.output<
  typeof SharedContainerFileScopeSchema
>;

/** A published revision's run commands and the env names they need. */
export const SharedContainerRunConfigSchema = z.strictObject({
  commands: z
    .array(
      z.strictObject({
        name: RunScriptNameSchema,
        command: z.string().min(1).max(MAX_SHARED_CONTAINER_RUN_COMMAND_LENGTH),
        repoId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      }),
    )
    .max(MAX_SHARED_CONTAINER_RUN_COMMANDS),
  requiredEnv: z
    .array(
      z
        .string()
        .max(MAX_SHARED_CONTAINER_RUN_ENV_NAME_LENGTH)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    )
    .max(MAX_SHARED_CONTAINER_RUN_ENV_NAMES),
});

const WorktreeParamsSchema = z.strictObject({
  projectId: SlugSchema,
  worktreeId: SlugSchema,
});

// Selections arrive as save-file-scope takes them; the core normalizes them
// and drops entries that are not valid paths, ids or script names.
const RequestPathsSchema = z.array(z.string()).max(MAX_SCOPE_PATHS);
const RequestIdsSchema = z.array(z.string()).max(MAX_SCOPE_ITEM_IDS);

export const PublicationFileScopeUpdateParamsSchema =
  WorktreeParamsSchema.extend({
    includedPaths: RequestPathsSchema,
    excludedPaths: RequestPathsSchema.optional(),
    legacyAllowlist: z.boolean().optional(),
    includedNoteIds: RequestIdsSchema.optional(),
    excludedNoteIds: RequestIdsSchema.optional(),
    includedPromptIds: RequestIdsSchema.optional(),
    excludedPromptIds: RequestIdsSchema.optional(),
    runSharingEnabled: z.boolean().optional(),
    runSharingDisabled: z.boolean().optional(),
    includedRunScripts: z
      .array(z.string())
      .max(MAX_SHARED_CONTAINER_RUN_COMMANDS)
      .optional(),
    excludedRunScripts: RequestIdsSchema.optional(),
    /** Absent is `keep`. */
    preferredLayout: z.enum(['keep', 'pin-current', 'clear']).optional(),
  });
export type PublicationFileScopeUpdateParams = z.output<
  typeof PublicationFileScopeUpdateParamsSchema
>;

const FileScopeResultSchema = z.strictObject({
  fileScope: SharedContainerFileScopeSchema,
});

export const PublicationPreviewGetParamsSchema = WorktreeParamsSchema.extend({
  /** Absent for a personal container, which only `public` can create. */
  organizationId: SlugSchema.optional(),
  containerType: z.enum(SHARED_CONTAINER_TYPES),
  audience: z.enum(['team', 'organization', 'public']).optional(),
});

const RemoteUrlSchema = PublicationRepositoryRefSchema.shape.remoteUrl.unwrap();
const CommitShaSchema = PublicationRepositoryRefSchema.shape.commitSha.unwrap();
const ItemSchema = z.strictObject({
  id: PickerItemIdSchema,
  title: z.string(),
});
const PathListSchema = z
  .array(ScopePathSchema)
  .max(MAX_SHARED_CONTAINER_ARTIFACTS_PER_REVISION);

export const PublicationPreviewSchema = z.strictObject({
  containerType: z.enum(SHARED_CONTAINER_TYPES),
  chatCount: CountSchema,
  planCount: CountSchema,
  attachmentCount: CountSchema,
  noteCount: CountSchema,
  promptCount: CountSchema,
  notes: z.array(ItemSchema),
  prompts: z.array(ItemSchema),
  startPage: z
    .strictObject({
      label: z.string(),
      status: z.enum(['included', 'withheld', 'url']),
    })
    .nullable(),
  repository: z
    .strictObject({
      remoteUrl: RemoteUrlSchema,
      baseCommitSha: CommitShaSchema,
    })
    .optional(),
  repositories: z
    .array(
      z.strictObject({
        repoId: z.string().min(1).max(512),
        repoName: z.string().min(1),
        remoteUrl: RemoteUrlSchema,
        baseCommitSha: CommitShaSchema,
      }),
    )
    .optional(),
  dirtyFileCount: CountSchema,
  untrackedCandidates: PathListSchema,
  untrackedCandidateCount: CountSchema,
  defaultIncludedFilePaths: PathListSchema.optional(),
  approvedFileScope: SharedContainerFileScopeSchema,
  availableRunScripts: z.array(RunScriptNameSchema).optional(),
  run: SharedContainerRunConfigSchema.optional(),
  artifactBudget: z.strictObject({ used: CountSchema, limit: CountSchema }),
  unpushedCommitCount: CountSchema.optional(),
  snapshotRepositoryCount: CountSchema.optional(),
  snapshotBytes: CountSchema.optional(),
  snapshotRepositoryNames: z.array(z.string()).optional(),
  undisclosedRepositoryCount: CountSchema.optional(),
  withheldFileCount: CountSchema.optional(),
  withheldFilePaths: PathListSchema.optional(),
  withheldSymlinkPaths: PathListSchema.optional(),
  capabilityPackageCounts: z
    .strictObject({
      skills: CountSchema,
      pipelines: CountSchema,
      agents: CountSchema,
      automations: CountSchema,
      hooks: CountSchema,
    })
    .optional(),
});
export type PublicationPreview = z.output<typeof PublicationPreviewSchema>;

// No operation-specific codes: refusals are told apart by kind.
const QueryErrorSchema = CanopyErrorPayloadSchema.omit({ code: true }).extend({
  retry: CanopyQueryRetryDirectiveSchema,
});

const publication = {
  plane: 'core',
  domain: 'publication',
  version: 1,
  placement: 'core-only',
} as const;

export const CORE_PUBLICATION_SHARED_CONTAINER_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.publication.fileScope.get': defineCanopyQuery({
      ...publication,
      params: WorktreeParamsSchema,
      result: FileScopeResultSchema,
      error: QueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PUBLICATION_GRANTS.read],
    }),
    'core.publication.preview.get': defineCanopyQuery({
      ...publication,
      params: PublicationPreviewGetParamsSchema,
      result: PublicationPreviewSchema,
      error: QueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PUBLICATION_GRANTS.read],
    }),
  });

export const CORE_PUBLICATION_SHARED_CONTAINER_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.publication.fileScope.update': defineCanopyInstruction({
      ...publication,
      params: PublicationFileScopeUpdateParamsSchema,
      result: FileScopeResultSchema,
      error: CanopyErrorPayloadSchema.omit({ code: true }).extend({
        retry: CanopyKeyedRetryDirectiveSchema,
      }),
      idempotency: 'keyed',
      requiredGrants: [PUBLICATION_GRANTS.write],
    }),
  });
