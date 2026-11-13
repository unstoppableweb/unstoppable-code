import { z } from 'zod';

import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';

export const CORE_WORKSPACE_INSTRUCTIONS_GRANTS = {
  read: 'core.workspace.read',
  write: 'core.workspace.write',
} as const;

export const CORE_WORKSPACE_INSTRUCTIONS_ERROR_CODES = [
  'core.workspace.instructions.invalidWorkspaceId',
  'core.workspace.instructions.unsupportedLayout',
] as const;

// Identifier rules stay with the host validator so a rejected id keeps its
// existing message; the wire only requires a string.
export const CoreWorkspaceInstructionsGetParamsSchema = z.strictObject({
  workspaceId: z.string(),
});

// Content has no size bound: today's editor saves any string, and a bound
// would refuse saves that succeed now.
export const CoreWorkspaceInstructionsUpdateParamsSchema = z.strictObject({
  workspaceId: z.string(),
  content: z.string(),
});

export const CoreWorkspaceInstructionsGetResultSchema = z.strictObject({
  content: z.string(),
});

export const CoreWorkspaceInstructionsUpdateResultSchema = z.strictObject({});

export const CoreWorkspaceInstructionsErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(CORE_WORKSPACE_INSTRUCTIONS_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export type CoreWorkspaceInstructionsGetParams = z.output<
  typeof CoreWorkspaceInstructionsGetParamsSchema
>;
export type CoreWorkspaceInstructionsUpdateParams = z.output<
  typeof CoreWorkspaceInstructionsUpdateParamsSchema
>;
export type CoreWorkspaceInstructionsGetResult = z.output<
  typeof CoreWorkspaceInstructionsGetResultSchema
>;
export type CoreWorkspaceInstructionsUpdateResult = z.output<
  typeof CoreWorkspaceInstructionsUpdateResultSchema
>;

export const CORE_WORKSPACE_INSTRUCTIONS_QUERIES = defineCanopyQueryRegistry(
  'core',
  {
    'core.workspace.instructions.get': defineCanopyQuery({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_WORKSPACE_INSTRUCTIONS_GRANTS.read],
      params: CoreWorkspaceInstructionsGetParamsSchema,
      result: CoreWorkspaceInstructionsGetResultSchema,
      error: CoreWorkspaceInstructionsErrorSchema,
    }),
  },
);

export const CORE_WORKSPACE_INSTRUCTIONS_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    // A full overwrite with the same content converges to the same files, so
    // a repeated call is safe without an idempotency key.
    'core.workspace.instructions.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [CORE_WORKSPACE_INSTRUCTIONS_GRANTS.write],
      params: CoreWorkspaceInstructionsUpdateParamsSchema,
      result: CoreWorkspaceInstructionsUpdateResultSchema,
      error: CoreWorkspaceInstructionsErrorSchema,
    }),
  });
