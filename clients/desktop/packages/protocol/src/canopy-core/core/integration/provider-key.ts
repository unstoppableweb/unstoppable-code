import { z } from 'zod';
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

/**
 * A person's own Anthropic or OpenAI API key for cloud chats. Served by the
 * web core only, so these registries stay out of the composed core ones the
 * desktop dispatcher must own; desktop core and the daemon answer `-32601`,
 * which clients read as `capability_unavailable`. The key is write-only: no
 * result ever carries it, only its last four characters.
 */
export const CORE_INTEGRATION_PROVIDER_KEY_GRANT =
  'core.integration.providerKey.manage';

export const PROVIDER_KEY_PROVIDERS = ['anthropic', 'openai'] as const;
export type ProviderKeyProvider = (typeof PROVIDER_KEY_PROVIDERS)[number];
export const ProviderKeyProviderSchema = z.enum(PROVIDER_KEY_PROVIDERS);

export const PROVIDER_KEY_STATUSES = ['none', 'saved', 'rejected'] as const;
export type ProviderKeyStatusValue = (typeof PROVIDER_KEY_STATUSES)[number];

/** Longest API key a save accepts, after trimming. */
export const PROVIDER_KEY_MAX_LENGTH = 4096;

export const ProviderKeyStatusSchema = z.strictObject({
  provider: ProviderKeyProviderSchema,
  status: z.enum(PROVIDER_KEY_STATUSES),
  /** Last four characters of the saved key; null with no key. */
  keyHint: z.string().max(8).nullable(),
  /** How many models the key listed when saved; 0 when not listed. */
  modelCount: z.number().int().nonnegative(),
  /** False when the provider didn't list models for this key. */
  modelsListed: z.boolean(),
  /** ISO time of the last successful save; null with no key. */
  savedAt: z.iso.datetime().nullable(),
  /** Advances on every save and removal; pass back as `expectedRevision`. */
  revision: z.number().int().nonnegative(),
});
export type ProviderKeyStatus = z.output<typeof ProviderKeyStatusSchema>;

export const CoreIntegrationProviderKeyListParamsSchema = z.strictObject({});
export const CoreIntegrationProviderKeyListResultSchema = z.strictObject({
  keys: z.array(ProviderKeyStatusSchema).max(PROVIDER_KEY_PROVIDERS.length),
});

export const CoreIntegrationProviderKeySetParamsSchema = z.strictObject({
  provider: ProviderKeyProviderSchema,
  apiKey: z
    .string()
    .min(1)
    .max(PROVIDER_KEY_MAX_LENGTH * 2)
    .meta({ writeOnly: true }),
  /** Omitted means last write wins. */
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const CoreIntegrationProviderKeyClearParamsSchema = z.strictObject({
  provider: ProviderKeyProviderSchema,
  /** Omitted means last write wins. Clearing a key that doesn't exist succeeds. */
  expectedRevision: z.number().int().nonnegative().optional(),
});

export const CoreIntegrationProviderKeyResultSchema = z.strictObject({
  key: ProviderKeyStatusSchema,
});

export const PROVIDER_KEY_ERROR_CODES = {
  rejected: 'core.integration.providerKey.rejected',
  unreachable: 'core.integration.providerKey.unreachable',
  changed: 'core.integration.providerKey.changed',
  storageUnavailable: 'core.integration.providerKey.storageUnavailable',
  rateLimited: 'core.integration.providerKey.rateLimited',
} as const;

export const CORE_INTEGRATION_PROVIDER_KEY_LIST_ERROR_CODES = [
  PROVIDER_KEY_ERROR_CODES.storageUnavailable,
] as const;
export const CORE_INTEGRATION_PROVIDER_KEY_SET_ERROR_CODES = [
  PROVIDER_KEY_ERROR_CODES.rejected,
  PROVIDER_KEY_ERROR_CODES.unreachable,
  PROVIDER_KEY_ERROR_CODES.changed,
  PROVIDER_KEY_ERROR_CODES.storageUnavailable,
  PROVIDER_KEY_ERROR_CODES.rateLimited,
] as const;
export const CORE_INTEGRATION_PROVIDER_KEY_CLEAR_ERROR_CODES = [
  PROVIDER_KEY_ERROR_CODES.changed,
  PROVIDER_KEY_ERROR_CODES.storageUnavailable,
] as const;

export type ProviderKeyErrorCode =
  (typeof PROVIDER_KEY_ERROR_CODES)[keyof typeof PROVIDER_KEY_ERROR_CODES];

export type CoreIntegrationProviderKeySetParams = z.output<
  typeof CoreIntegrationProviderKeySetParamsSchema
>;
export type CoreIntegrationProviderKeyClearParams = z.output<
  typeof CoreIntegrationProviderKeyClearParamsSchema
>;
export type CoreIntegrationProviderKeyListResult = z.output<
  typeof CoreIntegrationProviderKeyListResultSchema
>;
export type CoreIntegrationProviderKeyResult = z.output<
  typeof CoreIntegrationProviderKeyResultSchema
>;

export const CORE_INTEGRATION_PROVIDER_KEY_QUERIES = defineCanopyQueryRegistry(
  'core',
  {
    'core.integration.providerKey.list': defineCanopyQuery({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreIntegrationProviderKeyListParamsSchema,
      result: CoreIntegrationProviderKeyListResultSchema,
      error: inherentOperationErrorSchema(
        CORE_INTEGRATION_PROVIDER_KEY_LIST_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: [CORE_INTEGRATION_PROVIDER_KEY_GRANT],
    }),
  },
);

export const CORE_INTEGRATION_PROVIDER_KEY_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    'core.integration.providerKey.set': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreIntegrationProviderKeySetParamsSchema,
      result: CoreIntegrationProviderKeyResultSchema,
      error: keyedOperationErrorSchema(
        CORE_INTEGRATION_PROVIDER_KEY_SET_ERROR_CODES,
      ),
      idempotency: 'keyed',
      requiredGrants: [CORE_INTEGRATION_PROVIDER_KEY_GRANT],
    }),
    'core.integration.providerKey.clear': defineCanopyInstruction({
      plane: 'core',
      domain: 'integration',
      version: 1,
      placement: 'core-only',
      params: CoreIntegrationProviderKeyClearParamsSchema,
      result: CoreIntegrationProviderKeyResultSchema,
      error: inherentOperationErrorSchema(
        CORE_INTEGRATION_PROVIDER_KEY_CLEAR_ERROR_CODES,
      ),
      idempotency: 'inherent',
      requiredGrants: [CORE_INTEGRATION_PROVIDER_KEY_GRANT],
    }),
  });
