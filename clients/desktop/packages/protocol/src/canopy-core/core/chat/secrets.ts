import { z } from 'zod';

import {
  AGENT_SECRET_NAME_PATTERN,
  AGENT_SECRET_VALUE_MAX_LENGTH,
} from '../../../agent-secrets/names';
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

/*
 * Agent secret requests in cloud chats (plan agent-secret-requests, unit U5).
 * A cloud agent's `RequestSecrets` call waits as an Agentic Core
 * `SECRET_REQUEST` interaction. The person answers it with
 * `core.chat.secretRequest.submit`, which carries the values straight to
 * Agentic Core's encrypted store; they never pass through a question answer,
 * the chat snapshot, events or logs. `core.chat.secret.list` and
 * `core.chat.secret.revoke` serve the chat's Secrets chip.
 *
 * Served by the web core only and not composed into the core registry, so
 * the desktop core answers `capability_unavailable`: a desktop chat's
 * secrets go to its own store over the local `secretRequest.submit` IPC.
 */

const IdentifierSchema = z.string().min(1).max(512);

/** An env-var shaped secret name, also the handle the agent uses. */
export const CoreChatSecretNameSchema = z
  .string()
  .regex(AGENT_SECRET_NAME_PATTERN);

/** The most secrets one request asks for (`RequestSecrets` takes 1..10). */
export const CORE_CHAT_SECRET_REQUEST_MAX_SECRETS = 10;

/** One value the person entered. Write-only: no result ever carries it. */
const SecretValueSchema = z
  .string()
  .min(1)
  .max(AGENT_SECRET_VALUE_MAX_LENGTH)
  .meta({ writeOnly: true });

export const CoreChatSecretRequestSubmitParamsSchema = z.strictObject({
  chatId: IdentifierSchema,
  /** The pending request: the chat's Agentic Core interaction. */
  interactionId: IdentifierSchema,
  /**
   * Agentic Core's idempotency key: a retry with the same id replays the
   * first answer, anything else on a settled request is refused.
   */
  submissionId: z.uuid(),
  action: z.enum(['provide', 'decline']),
  /** By name, only for fields the person filled in; provide only. */
  values: z
    .record(CoreChatSecretNameSchema, SecretValueSchema)
    .refine(
      (values) =>
        Object.keys(values).length <= CORE_CHAT_SECRET_REQUEST_MAX_SECRETS,
      `At most ${CORE_CHAT_SECRET_REQUEST_MAX_SECRETS} values.`,
    )
    .optional(),
});
export type CoreChatSecretRequestSubmitParams = z.output<
  typeof CoreChatSecretRequestSubmitParamsSchema
>;

const SecretStateSchema = z.enum(['provided', 'skipped', 'unavailable']);

/** Agentic Core's answer: names and states only, never a value. */
export const CoreChatSecretRequestSubmitResultSchema = z.strictObject({
  chatId: IdentifierSchema,
  interactionId: IdentifierSchema,
  status: z.enum(['submitted', 'rejected']),
  secrets: z
    .array(
      z.strictObject({
        name: CoreChatSecretNameSchema,
        state: SecretStateSchema,
      }),
    )
    .max(CORE_CHAT_SECRET_REQUEST_MAX_SECRETS),
});
export type CoreChatSecretRequestSubmitResult = z.output<
  typeof CoreChatSecretRequestSubmitResultSchema
>;

export const CORE_CHAT_SECRET_REQUEST_ERROR_CODES = [
  'core.chat.secretRequest.notFound',
  'core.chat.secretRequest.alreadyResolved',
  'core.chat.secretRequest.invalid',
  'core.chat.secretRequest.signInRequired',
  'core.chat.secretRequest.unavailable',
] as const;

export const CoreChatSecretRequestSubmitErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_CHAT_SECRET_REQUEST_ERROR_CODES).optional(),
    /**
     * For `core.chat.secretRequest.invalid`: the field Agentic Core refused
     * (`values.NAME`, `action`) and its reason code. Never a value.
     */
    details: z
      .strictObject({
        field: z.string().max(256),
        reason: z.string().max(256),
      })
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/** A secret the chat holds: metadata only. */
export const CoreChatSecretSummarySchema = z.strictObject({
  name: CoreChatSecretNameSchema,
  createdAt: z.iso.datetime({ offset: true }),
  lastUsedAt: z.iso.datetime({ offset: true }).nullable(),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type CoreChatSecretSummary = z.output<
  typeof CoreChatSecretSummarySchema
>;

export const CoreChatSecretListParamsSchema = z.strictObject({
  chatId: IdentifierSchema,
});

export const CoreChatSecretListResultSchema = z.strictObject({
  chatId: IdentifierSchema,
  /** Usable secrets only: revoked and expired ones drop out. */
  secrets: z.array(CoreChatSecretSummarySchema).max(256),
});
export type CoreChatSecretListResult = z.output<
  typeof CoreChatSecretListResultSchema
>;

export const CORE_CHAT_SECRET_ERROR_CODES = [
  'core.chat.secret.notFound',
  'core.chat.secret.signInRequired',
  'core.chat.secret.unavailable',
] as const;

export const CoreChatSecretListErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CORE_CHAT_SECRET_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const CoreChatSecretRevokeParamsSchema = z.strictObject({
  chatId: IdentifierSchema,
  name: CoreChatSecretNameSchema,
});

export const CoreChatSecretRevokeResultSchema = z.strictObject({
  chatId: IdentifierSchema,
  name: CoreChatSecretNameSchema,
  revoked: z.literal(true),
});
export type CoreChatSecretRevokeResult = z.output<
  typeof CoreChatSecretRevokeResultSchema
>;

export const CoreChatSecretRevokeErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CORE_CHAT_SECRET_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

/** Served by the web core only, so kept out of the composed registries. */
export const CORE_CHAT_SECRET_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.chat.secret.list': defineCanopyQuery({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.chat.read'],
      params: CoreChatSecretListParamsSchema,
      result: CoreChatSecretListResultSchema,
      error: CoreChatSecretListErrorSchema,
    }),
  },
);

/** Served by the web core only, so kept out of the composed registries. */
export const CORE_CHAT_SECRET_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.chat.secretRequest.submit': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      // Agentic Core replays a retry with the same `submissionId`.
      idempotency: 'inherent',
      requiredGrants: ['core.chat.write'],
      params: CoreChatSecretRequestSubmitParamsSchema,
      result: CoreChatSecretRequestSubmitResultSchema,
      error: CoreChatSecretRequestSubmitErrorSchema,
    }),
    'core.chat.secret.revoke': defineCanopyInstruction({
      plane: 'core',
      domain: 'chat',
      version: 1,
      placement: 'core-only',
      // Revoking a revoked secret answers the same.
      idempotency: 'inherent',
      requiredGrants: ['core.chat.write'],
      params: CoreChatSecretRevokeParamsSchema,
      result: CoreChatSecretRevokeResultSchema,
      error: CoreChatSecretRevokeErrorSchema,
    }),
  });
