import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../../common';
import { CanopyJsonValueSchema } from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { inherentOperationErrorSchema } from '../shared';

export const CORE_INTEGRATION_GRANTS = {
  read: 'core.integration.read',
  star: 'core.integration.star',
  write: 'core.integration.write',
} as const;

const OpaqueIdSchema = z
  .string()
  .min(1)
  .max(512)
  .describe('Stable opaque identifier.');

/** Fixed ids of the two GitHub connections the desktop host serves. */
export const GITHUB_INTEGRATION_ID = 'github';
export const GITHUB_CLI_INTEGRATION_ID = 'github-cli';

/** Where Canopy's own GitHub credential comes from; never the credential. */
export const GITHUB_TOKEN_SOURCES = ['pat', 'gh-cli', 'none'] as const;

export const GITHUB_STORED_CREDENTIAL_STATES = [
  'present',
  'absent',
  'storage-unavailable',
  'unreadable',
] as const;

/** `kind: 'github'`: Canopy's GitHub credential, as configured. */
export const GitHubCredentialStatusSchema = z.strictObject({
  tokenSource: z.enum(GITHUB_TOKEN_SOURCES),
  storedCredential: z.enum(GITHUB_STORED_CREDENTIAL_STATES),
});

export const GITHUB_CLI_TOKEN_SOURCE_KINDS = [
  'keyring',
  'config-file',
  'environment',
  'other',
] as const;

export const GITHUB_CLI_ENVIRONMENT_VARIABLES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
] as const;

export const GITHUB_CLI_UNAVAILABLE_REASONS = [
  'not_installed',
  'unparseable_output',
] as const;

/** `kind: 'github-cli'`: the GitHub CLI's own github.com account. */
export const GitHubCliStatusSchema = z.strictObject({
  login: z.string().min(1).max(256).nullable(),
  tokenSourceKind: z.enum(GITHUB_CLI_TOKEN_SOURCE_KINDS).nullable(),
  environmentVariable: z.enum(GITHUB_CLI_ENVIRONMENT_VARIABLES).nullable(),
  hasCredentialStoreLogin: z.boolean(),
  unavailableReason: z.enum(GITHUB_CLI_UNAVAILABLE_REASONS).nullable(),
});

// Open for version 1, as the catalog row declares: kinds add their own
// members. The GitHub members are declared so they are validated.
export const CoreIntegrationSchema = z
  .object({
    integrationId: OpaqueIdSchema,
    kind: z.string().min(1).max(128),
    accountLabel: z.string().max(256),
    state: z.enum(['disconnected', 'connecting', 'connected', 'error']),
    capabilities: z.array(z.string()),
    revision: z.number().int().min(0),
    githubCredential: GitHubCredentialStatusSchema.optional(),
    githubCli: GitHubCliStatusSchema.optional(),
  })
  .catchall(CanopyJsonValueSchema);

export type CoreIntegration = z.output<typeof CoreIntegrationSchema>;

export const CoreIntegrationGetParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  integrationId: OpaqueIdSchema,
});

export const CoreIntegrationListParamsSchema = z.strictObject({
  scope: CanopyWorkspaceScopeSchema.optional(),
  pageSize: z.number().int().min(1).max(500).default(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
});

export const CoreIntegrationListResultSchema = z
  .object({
    items: z.array(CoreIntegrationSchema).max(500),
    nextCursor: z.string().max(2048).nullable(),
  })
  .catchall(CanopyJsonValueSchema);

export const CORE_INTEGRATION_RESOURCE_KINDS = [
  'repository',
  'organization',
  'project',
  'issue',
  'workflow',
] as const;

export const CoreIntegrationResourceListParamsSchema = z.strictObject({
  integrationId: OpaqueIdSchema,
  kinds: z.array(z.enum(CORE_INTEGRATION_RESOURCE_KINDS)),
  query: z.string().max(1024).nullable(),
  cursor: OpaqueIdSchema.nullable(),
  limit: z.number().int().min(1).max(200),
});

export const CoreIntegrationResourceSchema = z.strictObject({
  integrationId: OpaqueIdSchema,
  resourceId: OpaqueIdSchema,
  kind: z.enum(CORE_INTEGRATION_RESOURCE_KINDS),
  name: z.string().max(512),
  locator: z.string().max(4096),
  capabilities: z.array(z.string().max(128)),
  updatedAt: z.iso
    .datetime({ offset: true })
    .describe('RFC 3339 timestamp with an offset.'),
});

export const CoreIntegrationResourceListResultSchema = z.strictObject({
  resources: z.array(CoreIntegrationResourceSchema),
  nextCursor: OpaqueIdSchema.nullable(),
});

export const CORE_INTEGRATION_GET_ERROR_CODES = [
  'core.integration.notFound',
] as const;

export const CORE_INTEGRATION_LIST_ERROR_CODES = [
  'core.integration.list.invalidCursor',
] as const;

export const CORE_INTEGRATION_RESOURCE_LIST_ERROR_CODES = [
  'core.integration.notFound',
  'core.integration.notAuthenticated',
  'core.integration.resource.kindUnsupported',
  'core.integration.resource.queryUnsupported',
  'core.integration.resource.invalidCursor',
] as const;

export type CoreIntegrationGetParams = z.output<
  typeof CoreIntegrationGetParamsSchema
>;
export type CoreIntegrationListParams = z.output<
  typeof CoreIntegrationListParamsSchema
>;
export type CoreIntegrationListResult = z.output<
  typeof CoreIntegrationListResultSchema
>;
export type CoreIntegrationGitHubCredential = z.output<
  typeof GitHubCredentialStatusSchema
>;
export type CoreIntegrationGitHubCli = z.output<typeof GitHubCliStatusSchema>;
export type CoreIntegrationResourceListParams = z.output<
  typeof CoreIntegrationResourceListParamsSchema
>;
export type CoreIntegrationResourceListResult = z.output<
  typeof CoreIntegrationResourceListResultSchema
>;

/**
 * GitHub connection status and the repositories Canopy's credential reaches,
 * served by the desktop dispatcher (CAN-4109).
 */
export const CORE_INTEGRATION_QUERIES = defineCanopyQueryRegistry('core', {
  'core.integration.get': defineCanopyQuery({
    plane: 'core',
    domain: 'integration',
    version: 1,
    placement: 'core-only',
    params: CoreIntegrationGetParamsSchema,
    result: CoreIntegrationSchema,
    error: inherentOperationErrorSchema(CORE_INTEGRATION_GET_ERROR_CODES),
    idempotency: 'inherent',
    requiredGrants: ['core.integration.read'],
  }),
  'core.integration.list': defineCanopyQuery({
    plane: 'core',
    domain: 'integration',
    version: 1,
    placement: 'core-only',
    params: CoreIntegrationListParamsSchema,
    result: CoreIntegrationListResultSchema,
    error: inherentOperationErrorSchema(CORE_INTEGRATION_LIST_ERROR_CODES),
    idempotency: 'inherent',
    requiredGrants: ['core.integration.read'],
  }),
  'core.integration.resource.list': defineCanopyQuery({
    plane: 'core',
    domain: 'integration',
    version: 1,
    placement: 'core-only',
    params: CoreIntegrationResourceListParamsSchema,
    result: CoreIntegrationResourceListResultSchema,
    error: inherentOperationErrorSchema(
      CORE_INTEGRATION_RESOURCE_LIST_ERROR_CODES,
    ),
    idempotency: 'inherent',
    requiredGrants: ['core.integration.read'],
  }),
});

/**
 * No params: the core resolves the product's own source repository from its
 * bundled brand, so a caller cannot star an arbitrary repository.
 */
export const CoreIntegrationSourceRepositoryStarParamsSchema = z.strictObject(
  {},
);

export const CoreIntegrationSourceRepositoryStarResultSchema = z.strictObject({
  repository: z.strictObject({
    owner: z.string().min(1).max(256),
    repo: z.string().min(1).max(256),
  }),
});

export const CORE_INTEGRATION_SOURCE_REPOSITORY_STAR_ERROR_CODES = [
  'core.integration.sourceRepository.unavailable',
  'core.integration.githubCli.notInstalled',
  'core.integration.notAuthenticated',
  'core.integration.sourceRepository.star.failed',
] as const;

export type CoreIntegrationSourceRepositoryStarParams = z.output<
  typeof CoreIntegrationSourceRepositoryStarParamsSchema
>;
export type CoreIntegrationSourceRepositoryStarResult = z.output<
  typeof CoreIntegrationSourceRepositoryStarResultSchema
>;
export type CoreIntegrationSourceRepositoryStarErrorCode =
  (typeof CORE_INTEGRATION_SOURCE_REPOSITORY_STAR_ERROR_CODES)[number];

/**
 * Stars the brand's source repository with the GitHub CLI's own github.com
 * account. Starring is a PUT, so a repeat is inherently idempotent.
 */
export const CORE_INTEGRATION_INSTRUCTIONS = defineCanopyInstructionRegistry(
  'core',
  {
    'core.integration.sourceRepository.star': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreIntegrationSourceRepositoryStarParamsSchema,
      result: CoreIntegrationSourceRepositoryStarResultSchema,
      error: inherentOperationErrorSchema(
        CORE_INTEGRATION_SOURCE_REPOSITORY_STAR_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: ['core.integration.star'],
    }),
  },
);
