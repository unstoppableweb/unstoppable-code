import { z } from 'zod';

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
import {
  PipelineDefinitionDeleteParamsSchema,
  PipelineDefinitionDeleteResultSchema,
  PipelineDefinitionDuplicateParamsSchema,
  PipelineDefinitionDuplicateResultSchema,
  PipelineDefinitionImportParamsSchema,
  PipelineDefinitionImportResultSchema,
  PipelineDefinitionSetEnabledParamsSchema,
  PipelineDefinitionSetEnabledResultSchema,
  PipelineDefinitionUpsertParamsSchema,
  PipelineDefinitionUpsertResultSchema,
  PipelineDefinitionGetParamsSchema,
  PipelineDefinitionGetResultSchema,
  PipelineDefinitionListParamsSchema,
  PipelineDefinitionListResultSchema,
  PipelineDefinitionValidateParamsSchema,
  PipelineDefinitionValidateResultSchema,
} from './schemas';

export const PIPELINE_GRANTS = {
  read: 'core.pipeline.read',
  write: 'core.pipeline.write',
  /**
   * Reads a definition for a named run owner. No operation requires it, so
   * an interface principal, whose grants are narrowed to its operations'
   * required grants, never holds it.
   */
  ownerRead: 'core.pipeline.ownerRead',
} as const;

export const PIPELINE_DEFINITION_QUERY_ERROR_CODES = [
  'core.pipeline.definitionNotFound',
  'core.pipeline.definitionUnreadable',
  'core.pipeline.sourceUnavailable',
  'core.pipeline.scopeInvalid',
  'core.pipeline.contextMismatch',
  'core.pipeline.targetUnavailable',
] as const;

export type PipelineDefinitionQueryErrorCode =
  (typeof PIPELINE_DEFINITION_QUERY_ERROR_CODES)[number];

/** Codes a definition write adds to the read codes. */
export const PIPELINE_DEFINITION_INSTRUCTION_ERROR_CODES = [
  ...PIPELINE_DEFINITION_QUERY_ERROR_CODES,
  'core.pipeline.definitionInvalid',
  'core.pipeline.definitionReadOnly',
  'core.pipeline.revisionConflict',
  /**
   * The app that keeps the definitions' own state was not asked to check the
   * write, so nothing was written (CAN-7522).
   */
  'core.pipeline.ownerUnavailable',
] as const;

export type PipelineDefinitionInstructionErrorCode =
  (typeof PIPELINE_DEFINITION_INSTRUCTION_ERROR_CODES)[number];

/** Codes an import adds: its remote is gone or changed since it was reviewed. */
export const PIPELINE_DEFINITION_IMPORT_ERROR_CODES = [
  ...PIPELINE_DEFINITION_INSTRUCTION_ERROR_CODES,
  'core.pipeline.remoteNotFound',
  'core.pipeline.remoteVersionConflict',
] as const;

export type PipelineDefinitionImportErrorCode =
  (typeof PIPELINE_DEFINITION_IMPORT_ERROR_CODES)[number];

/** Diagnostic codes a validation result may carry. */
export const PIPELINE_DEFINITION_DIAGNOSTIC_CODES = {
  parseFailed: 'core.pipeline.parseFailed',
  definitionInvalid: 'core.pipeline.definitionInvalid',
} as const;

export const PipelineDefinitionQueryErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(PIPELINE_DEFINITION_QUERY_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const PipelineDefinitionInstructionErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(PIPELINE_DEFINITION_INSTRUCTION_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const PipelineDefinitionImportErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(PIPELINE_DEFINITION_IMPORT_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const PIPELINE_DEFINITION_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.pipeline.definition.list': defineCanopyQuery({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineDefinitionListParamsSchema,
      result: PipelineDefinitionListResultSchema,
      error: PipelineDefinitionQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_GRANTS.read],
    }),
    'core.pipeline.definition.get': defineCanopyQuery({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineDefinitionGetParamsSchema,
      result: PipelineDefinitionGetResultSchema,
      error: PipelineDefinitionQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_GRANTS.read],
    }),
    'core.pipeline.definition.validate': defineCanopyQuery({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineDefinitionValidateParamsSchema,
      result: PipelineDefinitionValidateResultSchema,
      error: PipelineDefinitionQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_GRANTS.read],
    }),
  },
);

export const PIPELINE_DEFINITION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.pipeline.definition.upsert': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineDefinitionUpsertParamsSchema,
      result: PipelineDefinitionUpsertResultSchema,
      error: PipelineDefinitionInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_GRANTS.write],
    }),
    'core.pipeline.definition.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineDefinitionDeleteParamsSchema,
      result: PipelineDefinitionDeleteResultSchema,
      error: PipelineDefinitionInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_GRANTS.write],
    }),
    'core.pipeline.definition.duplicate': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineDefinitionDuplicateParamsSchema,
      result: PipelineDefinitionDuplicateResultSchema,
      error: PipelineDefinitionInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_GRANTS.write],
    }),
    'core.pipeline.definition.import': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineDefinitionImportParamsSchema,
      result: PipelineDefinitionImportResultSchema,
      error: PipelineDefinitionImportErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_GRANTS.write],
    }),
    'core.pipeline.definition.setEnabled': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineDefinitionSetEnabledParamsSchema,
      result: PipelineDefinitionSetEnabledResultSchema,
      error: PipelineDefinitionInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_GRANTS.write],
    }),
  });
