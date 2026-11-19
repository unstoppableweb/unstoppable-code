import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { inherentOperationErrorSchema } from '../shared';
import {
  DictationModelInstallCancelParamsSchema,
  DictationModelInstallParamsSchema,
  DictationModelRemoveParamsSchema,
  DictationModelStatusGetParamsSchema,
  DictationModelStatusSchema,
} from './schemas';

export const DICTATION_GRANTS = {
  read: 'core.dictation.read',
  write: 'core.dictation.write',
} as const;

/**
 * `unsupported`: the host has no dictation model to manage.
 * `sourceUnavailable`: this build has no download location for the model.
 */
export const DICTATION_ERROR_CODES = [
  'core.dictation.unsupported',
  'core.dictation.sourceUnavailable',
] as const;

export const DictationErrorSchema = inherentOperationErrorSchema(
  DICTATION_ERROR_CODES,
);

export const DICTATION_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.dictation.model.status.get': defineCanopyQuery({
    plane: 'core',
    domain: 'dictation',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [DICTATION_GRANTS.read],
    error: DictationErrorSchema,
    params: DictationModelStatusGetParamsSchema,
    result: DictationModelStatusSchema,
  }),
});

export const DICTATION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.dictation.model.install': defineCanopyInstruction({
      plane: 'core',
      domain: 'dictation',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [DICTATION_GRANTS.write],
      error: DictationErrorSchema,
      params: DictationModelInstallParamsSchema,
      result: DictationModelStatusSchema,
    }),
    'core.dictation.model.install.cancel': defineCanopyInstruction({
      plane: 'core',
      domain: 'dictation',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [DICTATION_GRANTS.write],
      error: DictationErrorSchema,
      params: DictationModelInstallCancelParamsSchema,
      result: DictationModelStatusSchema,
    }),
    'core.dictation.model.remove': defineCanopyInstruction({
      plane: 'core',
      domain: 'dictation',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [DICTATION_GRANTS.write],
      error: DictationErrorSchema,
      params: DictationModelRemoveParamsSchema,
      result: DictationModelStatusSchema,
    }),
  });
