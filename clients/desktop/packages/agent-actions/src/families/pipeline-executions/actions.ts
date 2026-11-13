import { z } from 'zod';

/**
 * The pipeline execution actions, in the order desktop has always
 * advertised them. `pipeline.execution_list_for_worktree` is a compatibility
 * alias of `pipeline.execution_list` on chat surfaces.
 */
export const PIPELINE_EXECUTIONS_ACTION_TYPES = [
  'pipeline.execution_list_for_worktree',
  'pipeline.execution_list',
  'pipeline.execution_get',
  'pipeline.execution_cancel',
  'pipeline.execution_resume',
  'pipeline.execution_retry_matrix_job',
  'pipeline.execution_cancel_matrix_variant',
  'pipeline.execution_retry',
  'pipeline.execution_chain',
] as const;

export type PipelineExecutionsActionType =
  (typeof PIPELINE_EXECUTIONS_ACTION_TYPES)[number];

/**
 * The execution actions a cloud chat dispatches (CAN-6339). Retry and the
 * matrix controls wait for cloud recovery: the cloud runner serves no
 * matrix control, and a cloud run that ended runs again only as a new run.
 */
export const CLOUD_PIPELINE_EXECUTION_TYPES = [
  'pipeline.execution_list',
  'pipeline.execution_get',
  'pipeline.execution_cancel',
  'pipeline.execution_resume',
] as const satisfies readonly PipelineExecutionsActionType[];

const executionStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'success',
  'failure',
  'cancelled',
]);

/** A persisted job or step id: no path separators or traversal syntax. */
const runtimeIdentifierSchema = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/, {
  message:
    'identifiers must start with a letter or underscore and contain only letters, digits, underscores, and hyphens',
});

const listFields = {
  query: z.string().optional(),
  pipelineId: z.string().optional(),
  status: executionStatusSchema.optional(),
  limit: z.number().int().min(1).optional(),
};

const pipelineExecutionActionBaseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('pipeline.execution_list_for_worktree'),
    ...listFields,
  }),
  z.object({
    type: z.literal('pipeline.execution_list'),
    ...listFields,
    /**
     * `cloud` lists cloud runs on a host that also runs on this computer
     * (CAN-6354); a cloud-only host lists cloud runs either way.
     */
    runOn: z.enum(['local', 'cloud']).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_get'),
    executionId: z.string(),
    includeReport: z.boolean().optional(),
    includePlan: z.boolean().optional(),
    maxChars: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_cancel'),
    executionId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_resume'),
    executionId: z.string(),
    statusReasonIds: z.array(z.string().uuid()).min(1).optional(),
    pauseResponses: z
      .array(
        z.object({
          checkpointId: z.string().min(1),
          jobId: runtimeIdentifierSchema,
          stepId: runtimeIdentifierSchema,
          answers: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
        }),
      )
      .min(1)
      .optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_retry_matrix_job'),
    executionId: z.string(),
    jobId: z.string(),
    mode: z.enum(['all', 'failed', 'variants', 'expansion']),
    variantJobIds: z.array(z.string()).min(1).optional(),
  }),
  z.object({
    type: z.literal('pipeline.execution_cancel_matrix_variant'),
    executionId: z.string(),
    jobId: z.string(),
    variantJobId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_retry'),
    executionId: z.string(),
  }),
  z.object({
    type: z.literal('pipeline.execution_chain'),
    executionId: z.string(),
    pipelineId: z.string(),
    inputs: z.record(z.string(), z.string()).optional(),
    repoId: z.string().optional(),
  }),
]);

export const RESUME_NEEDS_ANSWER_MESSAGE =
  'pipeline.execution_resume requires statusReasonIds or pauseResponses from the observed pause.';

/** A pipeline execution action, as desktop chats have always parsed it. */
export const pipelineExecutionActionSchema =
  pipelineExecutionActionBaseSchema.superRefine((action, context) => {
    if (
      action.type === 'pipeline.execution_resume' &&
      action.statusReasonIds === undefined &&
      action.pauseResponses === undefined
    )
      context.addIssue({
        code: 'custom',
        message: RESUME_NEEDS_ANSWER_MESSAGE,
      });
  });

export type PipelineExecutionAction = z.output<
  typeof pipelineExecutionActionSchema
>;
