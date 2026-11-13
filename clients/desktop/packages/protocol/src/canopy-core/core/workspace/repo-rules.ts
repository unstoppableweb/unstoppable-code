import { z } from 'zod';

import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
  CanopyRetryDirectiveSchema,
} from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';

export const CORE_WORKSPACE_REPO_RULES_GRANTS = {
  read: 'core.workspace.read',
  write: 'core.workspace.write',
} as const;

export const CORE_WORKSPACE_REPO_RULES_ERROR_CODES = [
  'core.workspace.repoRules.localOnly',
  'core.workspace.repoRules.checkoutUnavailable',
  'core.workspace.repoRules.reviewExpired',
  'core.workspace.repoRules.ruleNotInReview',
  'core.workspace.repoRules.selectionInvalid',
  'core.workspace.repoRules.policyChanged',
  'core.workspace.repoRules.checkoutChanged',
  'core.workspace.repoRules.policyTooLarge',
  'core.workspace.repoRules.saveFailed',
] as const;

export type CoreWorkspaceRepoRulesErrorCode =
  (typeof CORE_WORKSPACE_REPO_RULES_ERROR_CODES)[number];

// The params mirror the desktop request schemas (`@canopy/protocol/repo-rules`)
// exactly, so a request the IPC projection accepted is never refused here; a
// parity test pins them together.
const workspaceId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
export const CoreWorkspaceRepoRulesScanParamsSchema = z.strictObject({
  workspaceId,
  worktreeId: workspaceId.optional(),
});
export const CoreWorkspaceRepoRulesStatusParamsSchema =
  CoreWorkspaceRepoRulesScanParamsSchema.pick({ workspaceId: true });
export const CoreWorkspaceRepoRulesPreviewParamsSchema = z.strictObject({
  workspaceId,
  scanId: z.string().uuid(),
  ruleId: z.string().max(4096),
});
export const CoreWorkspaceRepoRulesApplyParamsSchema = z.strictObject({
  workspaceId,
  enabled: z.boolean(),
  scanId: z.string().uuid().optional(),
  disabledRuleIds: z.array(z.string().max(4096)).max(200).optional(),
});

const diagnostic = z.enum([
  'missing',
  'invalid',
  'unsupported-version',
  'unavailable',
]);

// Results bound nothing the desktop service does not bound: a valid scan must
// never fail result validation, which would replace its legacy result.
const proposal = z.strictObject({
  id: z.string(),
  repoId: z.string(),
  path: z.string(),
  kind: z.enum([
    'always',
    'auto',
    'agent-requested',
    'manual',
    'legacy-cursorrules',
  ]),
  description: z.string(),
  globs: z.array(z.string()),
  scope: z.string(),
  hash: z.string(),
  bytes: z.number().int().nonnegative(),
  selected: z.boolean(),
  flags: z.array(
    z.enum([
      'duplicate',
      'unsupported-frontmatter',
      'malformed-frontmatter',
      'missing-file-reference',
      'unsupported-glob',
    ]),
  ),
});

const skipped = z.strictObject({
  repoId: z.string(),
  path: z.string(),
  reason: z.enum([
    'unavailable',
    'unsafe-path',
    'too-large',
    'changed',
    'limit',
    'unsupported-git',
  ]),
});

export const CoreWorkspaceRepoRulesStatusResultSchema = z.strictObject({
  enabled: z.boolean(),
  disabledRuleIds: z.array(z.string()),
  revision: z.number().int().nonnegative(),
  reviewedAt: z.string().optional(),
  diagnostic: diagnostic.optional(),
});

export const CoreWorkspaceRepoRulesApplyResultSchema =
  CoreWorkspaceRepoRulesStatusResultSchema;

export const CoreWorkspaceRepoRulesScanResultSchema = z.strictObject({
  scanId: z.string().uuid(),
  enabled: z.boolean(),
  revision: z.number().int().nonnegative(),
  worktreeId: z.string().optional(),
  proposals: z.array(proposal),
  nestedDirectories: z.record(z.string(), z.array(z.string())),
  skipped: z.array(skipped),
  diagnostic: diagnostic.optional(),
});

export const CoreWorkspaceRepoRulesPreviewResultSchema = z.strictObject({
  body: z.string(),
});

export const CoreWorkspaceRepoRulesQueryErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_WORKSPACE_REPO_RULES_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

// Apply takes no idempotency key and is never replayed by the runtime.
export const CoreWorkspaceRepoRulesApplyErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_WORKSPACE_REPO_RULES_ERROR_CODES).optional(),
    retry: z.discriminatedUnion('kind', [
      CanopyRetryDirectiveSchema.options[0],
      CanopyRetryDirectiveSchema.options[3],
    ]),
  });

export type CoreWorkspaceRepoRulesScanParams = z.output<
  typeof CoreWorkspaceRepoRulesScanParamsSchema
>;
export type CoreWorkspaceRepoRulesStatusParams = z.output<
  typeof CoreWorkspaceRepoRulesStatusParamsSchema
>;
export type CoreWorkspaceRepoRulesPreviewParams = z.output<
  typeof CoreWorkspaceRepoRulesPreviewParamsSchema
>;
export type CoreWorkspaceRepoRulesApplyParams = z.output<
  typeof CoreWorkspaceRepoRulesApplyParamsSchema
>;

export const CORE_WORKSPACE_REPO_RULES_QUERIES = defineCanopyQueryRegistry(
  'core',
  {
    // Allocates a short-lived review bound to the calling session; repeating
    // the call allocates another review and never changes durable state.
    'core.workspace.repoRules.scan': defineCanopyQuery({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_WORKSPACE_REPO_RULES_GRANTS.read],
      params: CoreWorkspaceRepoRulesScanParamsSchema,
      result: CoreWorkspaceRepoRulesScanResultSchema,
      error: CoreWorkspaceRepoRulesQueryErrorSchema,
    }),
    'core.workspace.repoRules.preview': defineCanopyQuery({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_WORKSPACE_REPO_RULES_GRANTS.read],
      params: CoreWorkspaceRepoRulesPreviewParamsSchema,
      result: CoreWorkspaceRepoRulesPreviewResultSchema,
      error: CoreWorkspaceRepoRulesQueryErrorSchema,
    }),
    'core.workspace.repoRules.status': defineCanopyQuery({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_WORKSPACE_REPO_RULES_GRANTS.read],
      params: CoreWorkspaceRepoRulesStatusParamsSchema,
      result: CoreWorkspaceRepoRulesStatusResultSchema,
      error: CoreWorkspaceRepoRulesQueryErrorSchema,
    }),
  },
);

export const CORE_WORKSPACE_REPO_RULES_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    // A reviewed apply consumes its review, so a replay fails as an expired
    // review; a disable without a review bumps the revision again.
    'core.workspace.repoRules.apply': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'none',
      requiredGrants: [CORE_WORKSPACE_REPO_RULES_GRANTS.write],
      params: CoreWorkspaceRepoRulesApplyParamsSchema,
      result: CoreWorkspaceRepoRulesApplyResultSchema,
      error: CoreWorkspaceRepoRulesApplyErrorSchema,
    }),
  });
