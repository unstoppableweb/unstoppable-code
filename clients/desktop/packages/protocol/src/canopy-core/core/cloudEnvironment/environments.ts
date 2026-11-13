import { z } from 'zod';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { STORED_SECRET_REF_PATTERN } from '../../worker/execution-secrets';

/*
 * Cloud Environments (CAN-6215, plan CP-27): the variables cloud workflow
 * runs receive, at user, organization and project scope. They mirror one
 * desktop environment's variable list: each variable is public (sent to the
 * run as plain `env`) or secret (sent only by reference, as a CAN-5067
 * binding, and redeemed on the runner). Served by the web core only and not
 * composed into the core registry, so desktop and the daemon answer
 * `capability_unavailable`; desktop edits them over its web core connection.
 */

export const CLOUD_ENVIRONMENT_GRANTS = {
  read: 'core.cloudEnvironment.read',
  write: 'core.cloudEnvironment.write',
} as const;

/** Variables one scope may hold. */
export const CLOUD_ENVIRONMENT_VARIABLES_MAX = 256;
/** The longest value, in UTF-16 code units, public or secret. */
export const CLOUD_ENVIRONMENT_VALUE_MAX_LENGTH = 16_384;

/**
 * Whose variables: the caller's own (`user`), an organization's, or a cloud
 * project's. Organization and project variables reach only runs that
 * organization or project owns.
 */
export const CloudEnvironmentScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({
    kind: z.literal('organization'),
    organizationId: z.uuid(),
  }),
  z.strictObject({ kind: z.literal('project'), projectId: z.uuid() }),
]);
export type CloudEnvironmentScope = z.output<
  typeof CloudEnvironmentScopeSchema
>;

/**
 * A stored secret value, as every read shows it: the slot's reference, never
 * the value. Saving it back keeps the stored value unchanged.
 */
export const CloudEnvironmentStoredSecretSchema = z.strictObject({
  kind: z.literal('stored-secret'),
  ref: z.string().regex(STORED_SECRET_REF_PATTERN),
});

export const CloudEnvironmentVariableNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

/** One variable as a read shows it: a secret's value is its reference. */
export const CloudEnvironmentVariableViewSchema = z.strictObject({
  key: CloudEnvironmentVariableNameSchema,
  secret: z.boolean(),
  value: z.union([
    z.string().max(CLOUD_ENVIRONMENT_VALUE_MAX_LENGTH),
    CloudEnvironmentStoredSecretSchema,
  ]),
});
export type CloudEnvironmentVariableView = z.output<
  typeof CloudEnvironmentVariableViewSchema
>;

/**
 * One variable as a save sends it. A secret's value is write-only: plaintext
 * replaces it, its reference keeps it. A reference is accepted only for a
 * variable stored as secret under the same key.
 */
export const CloudEnvironmentVariableInputSchema = z.strictObject({
  key: CloudEnvironmentVariableNameSchema,
  secret: z.boolean(),
  value: z.union([
    z
      .string()
      .max(CLOUD_ENVIRONMENT_VALUE_MAX_LENGTH)
      // A process environment can't hold NUL.
      .refine((value) => !value.includes('\0'))
      .meta({ writeOnly: true }),
    CloudEnvironmentStoredSecretSchema,
  ]),
});

function uniqueKeys(
  variables: readonly { readonly key: string }[],
  ctx: z.RefinementCtx,
): void {
  const keys = new Set<string>();
  for (const variable of variables) {
    if (keys.has(variable.key))
      ctx.addIssue({
        code: 'custom',
        message: 'Each variable has a different name.',
      });
    keys.add(variable.key);
  }
}

export const CloudEnvironmentSchema = z.strictObject({
  scope: CloudEnvironmentScopeSchema,
  /**
   * Starts at 0 for a scope never saved. An equal revision is the same list;
   * compare for equality only.
   */
  revision: z.number().int().min(0),
  variables: z
    .array(CloudEnvironmentVariableViewSchema)
    .max(CLOUD_ENVIRONMENT_VARIABLES_MAX)
    .superRefine(uniqueKeys),
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CloudEnvironment = z.output<typeof CloudEnvironmentSchema>;

export const CloudEnvironmentGetParamsSchema = z.strictObject({
  scope: CloudEnvironmentScopeSchema,
});

export const CloudEnvironmentSaveParamsSchema = z.strictObject({
  scope: CloudEnvironmentScopeSchema,
  /** The revision the caller read; any other refuses the save. */
  expectedRevision: z.number().int().min(0),
  /** The whole list: variables left out are removed. */
  variables: z
    .array(CloudEnvironmentVariableInputSchema)
    .max(CLOUD_ENVIRONMENT_VARIABLES_MAX)
    .superRefine(uniqueKeys),
});
export type CloudEnvironmentSaveParams = z.output<
  typeof CloudEnvironmentSaveParamsSchema
>;

export const CLOUD_ENVIRONMENT_ERROR_CODES = [
  'core.cloudEnvironment.scopeNotFound',
  'core.cloudEnvironment.forbidden',
  'core.cloudEnvironment.revisionConflict',
  'core.cloudEnvironment.unknownSecretRef',
  'core.cloudEnvironment.tooLarge',
  'core.cloudEnvironment.storageUnavailable',
] as const;

const CloudEnvironmentErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CLOUD_ENVIRONMENT_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

/**
 * Served by the web core only, behind the cloud pipelines rollout flag; not
 * composed into the core registry, so desktop and the daemon answer
 * `capability_unavailable`.
 */
export const CORE_CLOUD_ENVIRONMENT_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.cloudEnvironment.get': defineCanopyQuery({
      plane: 'core',
      domain: 'cloudEnvironment',
      version: 1,
      placement: 'core-only',
      params: CloudEnvironmentGetParamsSchema,
      result: CloudEnvironmentSchema,
      error: CloudEnvironmentErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [CLOUD_ENVIRONMENT_GRANTS.read],
    }),
  });

export const CORE_CLOUD_ENVIRONMENT_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    // A resend whose first save landed finds the list it asked for and
    // answers it, so repeating a save never changes anything twice.
    'core.cloudEnvironment.save': defineCanopyInstruction({
      plane: 'core',
      domain: 'cloudEnvironment',
      version: 1,
      placement: 'core-only',
      params: CloudEnvironmentSaveParamsSchema,
      result: CloudEnvironmentSchema,
      error: CloudEnvironmentErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [CLOUD_ENVIRONMENT_GRANTS.write],
    }),
  });
