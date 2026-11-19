import { z } from 'zod';

import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  BotCreateParamsSchema,
  BotDeleteParamsSchema,
  BotGetParamsSchema,
  BotListParamsSchema,
  BotListResultSchema,
  BotResultSchema,
  BotSetPinsParamsSchema,
  BotUpdateParamsSchema,
} from './schemas';

export const BOT_GRANTS = {
  read: 'core.bots.read',
  write: 'core.bots.write',
} as const;

export const BotOperationErrorDetailsSchema = z.strictObject({
  reason: z.enum([
    'unknown_bot',
    'revision_conflict',
    'name_conflict',
    'invalid_input',
    'unknown_project',
    'default_bot_protected',
    'experiment_off',
    'storage_failed',
  ]),
});

const botErrorCodes = z.enum([
  'core.bots.notFound',
  'core.bots.revisionConflict',
  'core.bots.nameConflict',
  'core.bots.invalidInput',
  'core.bots.unknownProject',
  'core.bots.defaultBotProtected',
  'core.bots.unavailable',
  'core.bots.storageFailed',
]);

export const BotQueryErrorSchema = CanopyErrorPayloadSchema.extend({
  code: botErrorCodes.optional(),
  details: BotOperationErrorDetailsSchema.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const BotInstructionErrorSchema = CanopyErrorPayloadSchema.extend({
  code: botErrorCodes.optional(),
  details: BotOperationErrorDetailsSchema.optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

export const BOT_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.bots.list': defineCanopyQuery({
    plane: 'core',
    domain: 'bots',
    version: 1,
    placement: 'core-only',
    params: BotListParamsSchema,
    result: BotListResultSchema,
    error: BotQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [BOT_GRANTS.read],
  }),
  'core.bots.get': defineCanopyQuery({
    plane: 'core',
    domain: 'bots',
    version: 1,
    placement: 'core-only',
    params: BotGetParamsSchema,
    result: BotResultSchema,
    error: BotQueryErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [BOT_GRANTS.read],
  }),
});

export const BOT_INSTRUCTION_DEFINITIONS = defineCanopyInstructionRegistry(
  'core',
  {
    'core.bots.create': defineCanopyInstruction({
      plane: 'core',
      domain: 'bots',
      version: 1,
      placement: 'core-only',
      params: BotCreateParamsSchema,
      result: BotResultSchema,
      error: BotInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [BOT_GRANTS.write],
    }),
    'core.bots.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'bots',
      version: 1,
      placement: 'core-only',
      params: BotUpdateParamsSchema,
      result: BotResultSchema,
      error: BotInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [BOT_GRANTS.write],
    }),
    'core.bots.pins.set': defineCanopyInstruction({
      plane: 'core',
      domain: 'bots',
      version: 1,
      placement: 'core-only',
      params: BotSetPinsParamsSchema,
      result: BotResultSchema,
      error: BotInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [BOT_GRANTS.write],
    }),
    'core.bots.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'bots',
      version: 1,
      placement: 'core-only',
      params: BotDeleteParamsSchema,
      result: BotResultSchema,
      error: BotInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [BOT_GRANTS.write],
    }),
  },
);
