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
import {
  AnnotationDocumentAppendParamsSchema,
  AnnotationDocumentDismissParamsSchema,
  AnnotationDocumentGetParamsSchema,
  AnnotationDocumentResultSchema,
  AnnotationDocumentSaveParamsSchema,
  AnnotationThreadGetParamsSchema,
  AnnotationThreadGetResultSchema,
  AnnotationThreadListParamsSchema,
  AnnotationThreadListResultSchema,
  AnnotationThreadReplyParamsSchema,
  AnnotationThreadReplyResultSchema,
} from './schemas';

export const ANNOTATION_GRANTS = {
  read: 'core.annotation.read',
  write: 'core.annotation.write',
} as const;

/** The resource a conflicting caller refreshes before it retries. */
export const ANNOTATION_DOCUMENT_RESOURCE = 'core.annotation.document';

export const ANNOTATION_ERROR_REASONS = [
  'NOT_FOUND',
  'REVISION_CONFLICT',
  'READ_ONLY_SCOPE',
  'DAMAGED_STATE',
] as const;
export type AnnotationErrorReason = (typeof ANNOTATION_ERROR_REASONS)[number];

export const ANNOTATION_ERROR_CODES = {
  NOT_FOUND: 'core.annotation.notFound',
  REVISION_CONFLICT: 'core.annotation.revisionConflict',
  READ_ONLY_SCOPE: 'core.annotation.readOnlyScope',
  /**
   * The scope's state file can't be read, or a newer version wrote it, so a
   * write is refused rather than replacing it (CAN-7094).
   */
  DAMAGED_STATE: 'core.annotation.damagedState',
} as const satisfies Record<AnnotationErrorReason, string>;

export const AnnotationOperationErrorDetailsSchema = z.strictObject({
  reason: z.enum(ANNOTATION_ERROR_REASONS),
  /** The stored revision a conflicting write was compared with. */
  currentRevision: z.number().int().min(0).optional(),
});
export type AnnotationOperationErrorDetails = z.output<
  typeof AnnotationOperationErrorDetailsSchema
>;

export const AnnotationOperationErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      ANNOTATION_ERROR_CODES.NOT_FOUND,
      ANNOTATION_ERROR_CODES.REVISION_CONFLICT,
      ANNOTATION_ERROR_CODES.READ_ONLY_SCOPE,
      ANNOTATION_ERROR_CODES.DAMAGED_STATE,
    ])
    .optional(),
  details: AnnotationOperationErrorDetailsSchema.optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

export const ANNOTATION_QUERY_DEFINITIONS = defineCanopyQueryRegistry('core', {
  'core.annotation.document.get': defineCanopyQuery({
    plane: 'core',
    domain: 'annotation',
    version: 1,
    placement: 'core-only',
    params: AnnotationDocumentGetParamsSchema,
    result: AnnotationDocumentResultSchema,
    error: AnnotationOperationErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [ANNOTATION_GRANTS.read],
  }),
  'core.annotation.thread.get': defineCanopyQuery({
    plane: 'core',
    domain: 'annotation',
    version: 1,
    placement: 'core-only',
    params: AnnotationThreadGetParamsSchema,
    result: AnnotationThreadGetResultSchema,
    error: AnnotationOperationErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [ANNOTATION_GRANTS.read],
  }),
  'core.annotation.thread.list': defineCanopyQuery({
    plane: 'core',
    domain: 'annotation',
    version: 1,
    placement: 'core-only',
    params: AnnotationThreadListParamsSchema,
    result: AnnotationThreadListResultSchema,
    error: AnnotationOperationErrorSchema,
    idempotency: 'inherent',
    requiredGrants: [ANNOTATION_GRANTS.read],
  }),
});

export const ANNOTATION_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.annotation.document.save': defineCanopyInstruction({
      plane: 'core',
      domain: 'annotation',
      version: 1,
      placement: 'core-only',
      params: AnnotationDocumentSaveParamsSchema,
      result: AnnotationDocumentResultSchema,
      error: AnnotationOperationErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [ANNOTATION_GRANTS.write],
    }),
    'core.annotation.document.append': defineCanopyInstruction({
      plane: 'core',
      domain: 'annotation',
      version: 1,
      placement: 'core-only',
      params: AnnotationDocumentAppendParamsSchema,
      result: AnnotationDocumentResultSchema,
      error: AnnotationOperationErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [ANNOTATION_GRANTS.write],
    }),
    'core.annotation.document.dismiss': defineCanopyInstruction({
      plane: 'core',
      domain: 'annotation',
      version: 1,
      placement: 'core-only',
      params: AnnotationDocumentDismissParamsSchema,
      result: AnnotationDocumentResultSchema,
      error: AnnotationOperationErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [ANNOTATION_GRANTS.write],
    }),
    // Each reply is a new comment, so a replay posts it again.
    'core.annotation.thread.reply': defineCanopyInstruction({
      plane: 'core',
      domain: 'annotation',
      version: 1,
      placement: 'core-only',
      params: AnnotationThreadReplyParamsSchema,
      result: AnnotationThreadReplyResultSchema,
      error: AnnotationOperationErrorSchema,
      idempotency: 'none',
      requiredGrants: [ANNOTATION_GRANTS.write],
    }),
  });
