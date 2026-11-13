import { z } from 'zod';

import { CanopyQueryRequestMetadataSchema } from '../../common';
import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import { WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH } from '../../worker/pipeline';
import { WorkerPipelineArtifactSchema } from '../../worker/pipeline-detail';
import { PIPELINE_GRANTS } from './operations';

/*
 * Cloud run storage reads (CAN-6214, plan CP-21). A cloud run's step output
 * and saved reports live in the web core's run storage (CAN-6170), not on a
 * host a client can reach, so the web core serves them by position:
 *
 * - `core.pipeline.execution.stepLog.read`: a step's full log, by line index,
 *   instead of the bounded output `worker.pipeline.execution.events` carries.
 * - `core.pipeline.execution.artifact.read`: a saved report's bytes, by byte
 *   offset, for the references the execution detail lists.
 *
 * Desktop and the daemon read their runs' logs and reports from their own
 * data root and don't serve either; they answer `capability_unavailable`.
 */

const id = z.string().min(1).max(512);

/** The most log lines one read returns. */
export const CORE_PIPELINE_STEP_LOG_READ_LIMIT_MAX = 1000;
export const CORE_PIPELINE_STEP_LOG_READ_LIMIT_DEFAULT = 200;
/** The most output text one read returns; a read stops before passing it. */
export const CORE_PIPELINE_STEP_LOG_READ_TEXT_MAX = 1024 * 1024;

export const CorePipelineStepLogReadParamsSchema = z.strictObject({
  executionId: id,
  /** The physical job, a matrix variant's own id. */
  jobId: id,
  stepId: id,
  /** The first line to return; 0 for the start of the log. */
  fromIndex: z.number().int().min(0).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(CORE_PIPELINE_STEP_LOG_READ_LIMIT_MAX)
    .optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export type CorePipelineStepLogReadParams = z.output<
  typeof CorePipelineStepLogReadParamsSchema
>;

/** One line of a step's log: one output item as the run printed it. */
export const CorePipelineStepLogEntrySchema = z.strictObject({
  index: z.number().int().min(0),
  stream: z.enum(['stdout', 'stderr']),
  text: z.string().max(WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH),
  /** The runner cut the text at its item limit. */
  truncated: z.boolean(),
  attempt: z.number().int().min(0).optional(),
  iteration: z.number().int().min(1).optional(),
});
export type CorePipelineStepLogEntry = z.output<
  typeof CorePipelineStepLogEntrySchema
>;

export const CorePipelineStepLogReadResultSchema = z.strictObject({
  /**
   * The lines from `fromIndex`, in index order. A line the run recorded
   * without its text, because it carried a secret value, is left out, so
   * indexes may skip.
   */
  entries: z
    .array(CorePipelineStepLogEntrySchema)
    .max(CORE_PIPELINE_STEP_LOG_READ_LIMIT_MAX),
  /** Where the next read starts. */
  nextIndex: z.number().int().min(0),
  /**
   * The run has ended and no line past `nextIndex` was recorded: the log is
   * complete. While it runs, a later read may return more.
   */
  complete: z.boolean(),
});
export type CorePipelineStepLogReadResult = z.output<
  typeof CorePipelineStepLogReadResultSchema
>;

/** The most bytes one artifact read returns. */
export const CORE_PIPELINE_ARTIFACT_READ_LENGTH_MAX = 1024 * 1024;

export const CorePipelineArtifactReadParamsSchema = z.strictObject({
  executionId: id,
  /** A reference from the execution detail's `artifacts`. */
  artifact: WorkerPipelineArtifactSchema,
  /** The first byte to return. */
  offset: z.number().int().min(0).optional(),
  length: z
    .number()
    .int()
    .min(1)
    .max(CORE_PIPELINE_ARTIFACT_READ_LENGTH_MAX)
    .optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export type CorePipelineArtifactReadParams = z.output<
  typeof CorePipelineArtifactReadParamsSchema
>;

export const CorePipelineArtifactReadResultSchema = z.strictObject({
  artifact: WorkerPipelineArtifactSchema,
  contentType: z.string().min(1).max(256),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  offset: z.number().int().min(0),
  /** The bytes from `offset`, base64. */
  data: z.base64(),
  /** No byte past this read is left. */
  eof: z.boolean(),
});
export type CorePipelineArtifactReadResult = z.output<
  typeof CorePipelineArtifactReadResultSchema
>;

export const CORE_PIPELINE_RUN_READ_ERROR_CODES = [
  'core.pipeline.executionNotFound',
  'core.pipeline.artifactNotFound',
] as const;

export const CorePipelineRunReadErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z.enum(CORE_PIPELINE_RUN_READ_ERROR_CODES).optional(),
  retry: CanopyQueryRetryDirectiveSchema,
});

/**
 * Served by the web core only (CAN-6214). Kept out of the core registries:
 * the desktop dispatcher and the daemon require a handler for every
 * definition they are given and have none for these.
 */
export const CORE_PIPELINE_RUN_READ_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.pipeline.execution.stepLog.read': defineCanopyQuery({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: CorePipelineStepLogReadParamsSchema,
      result: CorePipelineStepLogReadResultSchema,
      error: CorePipelineRunReadErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_GRANTS.read],
    }),
    'core.pipeline.execution.artifact.read': defineCanopyQuery({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: CorePipelineArtifactReadParamsSchema,
      result: CorePipelineArtifactReadResultSchema,
      error: CorePipelineRunReadErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_GRANTS.read],
    }),
  });
