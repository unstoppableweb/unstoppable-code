import type { z } from 'zod';

import {
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';
import {
  UpdateApplyCancelParamsSchema,
  UpdateApplyCancelResultSchema,
  UpdateApplyParamsSchema,
  UpdateCheckParamsSchema,
  UpdateCheckResultSchema,
  UpdateComponentStatusSchema,
  UpdateDownloadParamsSchema,
  UpdateEventsOpenResultSchema,
  UpdateEventsParamsSchema,
  UpdateOperationRefSchema,
  UpdateStatusGetParamsSchema,
  UpdateStatusGetResultSchema,
} from './schemas';

export const UPDATE_GRANTS = {
  read: 'core.update.read',
  write: 'core.update.write',
} as const;

/**
 * Operation error codes. `unsupported` is a host that cannot update the
 * component itself (a source build, an unpackaged build, a Linux install the
 * package manager owns); `channelMismatch` a request for another channel than
 * the build's; `invalidState` a version that is not the current candidate or a
 * step the state does not allow; `disabled` a host whose user turned remote
 * updates off; `rateLimited` a caller asking again too soon.
 */
export const UPDATE_ERROR_CODES = [
  'core.update.unsupported',
  'core.update.channelMismatch',
  'core.update.invalidState',
  'core.update.notFound',
  'core.update.disabled',
  'core.update.rateLimited',
  'core.update.failed',
] as const;

export const UpdateQueryErrorSchema = inherentOperationErrorSchema([
  'core.update.unsupported',
  'core.update.snapshotRequired',
]);
export const UpdateKeyedErrorSchema =
  keyedOperationErrorSchema(UPDATE_ERROR_CODES);
export const UpdateInherentErrorSchema =
  inherentOperationErrorSchema(UPDATE_ERROR_CODES);

export const UpdateEventsEndSchema = CanopyStreamEndSchema.extend({
  error: UpdateQueryErrorSchema.nullable(),
});

export const UPDATE_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.update.status.get': defineCanopyQuery({
    plane: 'core',
    domain: 'update',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [UPDATE_GRANTS.read],
    error: UpdateQueryErrorSchema,
    params: UpdateStatusGetParamsSchema,
    result: UpdateStatusGetResultSchema,
  }),
});

export const UPDATE_INSTRUCTION_DEFINITIONS = defineCanopyInstructionRegistry(
  'core',
  {
    'core.update.check': defineCanopyInstruction({
      plane: 'core',
      domain: 'update',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [UPDATE_GRANTS.write],
      error: UpdateKeyedErrorSchema,
      params: UpdateCheckParamsSchema,
      result: UpdateCheckResultSchema,
    }),
    'core.update.download': defineCanopyInstruction({
      plane: 'core',
      domain: 'update',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [UPDATE_GRANTS.write],
      error: UpdateKeyedErrorSchema,
      params: UpdateDownloadParamsSchema,
      result: UpdateOperationRefSchema,
    }),
    'core.update.apply': defineCanopyInstruction({
      plane: 'core',
      domain: 'update',
      version: 1,
      placement: 'core-only',
      idempotency: 'keyed',
      requiredGrants: [UPDATE_GRANTS.write],
      error: UpdateKeyedErrorSchema,
      params: UpdateApplyParamsSchema,
      result: UpdateOperationRefSchema,
    }),
    'core.update.apply.cancel': defineCanopyInstruction({
      plane: 'core',
      domain: 'update',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [UPDATE_GRANTS.write],
      error: UpdateInherentErrorSchema,
      params: UpdateApplyCancelParamsSchema,
      result: UpdateApplyCancelResultSchema,
    }),
  },
);

export const UPDATE_STREAM_DEFINITIONS = defineCanopyStreamRegistry('core', {
  'core.update.events': defineCanopyStream({
    plane: 'core',
    domain: 'update',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: [UPDATE_GRANTS.read],
    error: UpdateQueryErrorSchema,
    params: UpdateEventsParamsSchema,
    openResult: UpdateEventsOpenResultSchema,
    item: UpdateComponentStatusSchema,
    end: UpdateEventsEndSchema,
  }),
});

export type UpdateApplyCancelParams = z.output<
  typeof UpdateApplyCancelParamsSchema
>;
export type UpdateEventsParams = z.output<typeof UpdateEventsParamsSchema>;
