import { z } from 'zod';

import {
  MAX_SHARED_AUTOMATION_NAME_LENGTH,
  MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS,
  automationCronExpressionError,
} from '../../../automations';
import {
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
} from '../../common';
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
import { WorkerPipelineLaunchInputsSchema } from '../../host-execution';
import { PipelineRunOwnerSchema } from '../../pipeline-values';
import { PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH } from './schemas';

/*
 * Cloud workflow schedules (CAN-6183, cloud pipelines CP-71, decisions P3
 * and P7). A workflow's schedule whose `executionLocation` is `cloud` is
 * stored here, server-side, and the desktop keeps a stub that names it. The
 * server record is authoritative: the desktop never fires a stub, and moving
 * a schedule back to the desktop deletes it here first.
 *
 * Only the web core serves these, behind the cloud pipelines rollout flag;
 * like the attachment upload they stay out of the composed registries, so
 * the desktop dispatcher answers `capability_unavailable`. Firing them is
 * CP-46.
 */

export const PIPELINE_SCHEDULE_GRANTS = {
  read: 'core.pipeline.scheduleRead',
  write: 'core.pipeline.scheduleWrite',
} as const;

/** The most schedules one person keeps in the cloud. */
export const PIPELINE_SCHEDULE_MAX_PER_USER = 500;
export const PIPELINE_SCHEDULE_LIST_MAX_LIMIT = 200;
export const PIPELINE_SCHEDULE_LIST_DEFAULT_LIMIT = 100;

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const packageDigest = z.string().regex(/^pp:v1:[A-Za-z0-9_-]{43}$/);

/** Whether `value` names a time zone this runtime knows, such as `Europe/Paris`. */
export function isPipelineScheduleTimeZone(value: string): boolean {
  if (value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine(isPipelineScheduleTimeZone, 'Unknown time zone.');

/**
 * When a schedule fires, in an IANA time zone: the desktop's `local` trigger
 * resolved to the zone it ran in when the schedule moved.
 */
export const PipelineScheduleTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('cron'),
    expression: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (expression) => automationCronExpressionError(expression) === null,
        {
          message: 'Invalid cron expression.',
        },
      ),
    timeZone,
  }),
  z.strictObject({
    kind: z.literal('one_time'),
    runAt: timestamp,
    timeZone,
  }),
]);
export type PipelineScheduleTrigger = z.output<
  typeof PipelineScheduleTriggerSchema
>;

/**
 * The workflow a schedule runs (P7). A shared, curated or project definition
 * is read through `core.pipeline.definition.get` when the schedule fires; a
 * workflow that exists on one desktop only is uploaded as a snapshot with its
 * package digest, and uploaded again when it is saved.
 */
export const PIPELINE_SCHEDULE_DEFINITION_SOURCES = [
  'shared',
  'curated',
  'project',
] as const;

export const PipelineScheduleWorkflowInputSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('definition'),
      source: z.enum(PIPELINE_SCHEDULE_DEFINITION_SOURCES),
      definitionId: id,
    }),
    z.strictObject({
      kind: z.literal('snapshot'),
      /** The YAML document as the desktop saved it. */
      document: z.string().min(1).max(PIPELINE_DEFINITION_DOCUMENT_MAX_LENGTH),
      /** Lowercase SHA-256 hex of `document`; the server refuses a mismatch. */
      contentHash: sha256,
      /** The package it runs with; null for a definition-only workflow. */
      packageDigest: packageDigest.nullable(),
    }),
  ],
);
export type PipelineScheduleWorkflowInput = z.output<
  typeof PipelineScheduleWorkflowInputSchema
>;

/** A schedule's workflow as reads answer it: a snapshot without its document. */
export const PipelineScheduleWorkflowSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('definition'),
    source: z.enum(PIPELINE_SCHEDULE_DEFINITION_SOURCES),
    definitionId: id,
  }),
  z.strictObject({
    kind: z.literal('snapshot'),
    contentHash: sha256,
    packageDigest: packageDigest.nullable(),
  }),
]);
export type PipelineScheduleWorkflow = z.output<
  typeof PipelineScheduleWorkflowSchema
>;

/**
 * Where a scheduled run goes, as the desktop's `worktree_pipeline` target
 * names it. Ids are the desktop's until CP-47 re-points them at cloud
 * projects and tasks.
 */
export const PipelineScheduleDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global') }),
  z.strictObject({
    kind: z.literal('new_worktree'),
    workspaceId: id,
    baseWorktreeId: id.optional(),
    repoId: id.optional(),
  }),
  z.strictObject({
    kind: z.literal('task'),
    workspaceId: id,
    taskId: id,
  }),
  z.strictObject({
    kind: z.literal('project'),
    workspaceId: id,
    repoId: id.optional(),
  }),
]);
export type PipelineScheduleDestination = z.output<
  typeof PipelineScheduleDestinationSchema
>;

const name = z.string().trim().min(1).max(MAX_SHARED_AUTOMATION_NAME_LENGTH);
const runCondition = z
  .string()
  .min(1)
  .max(MAX_SHARED_AUTOMATION_RUN_CONDITION_CHARS);

export const PipelineScheduleSchema = z.strictObject({
  scheduleId: z.uuid(),
  /** Advances on every change; updates and deletes may compare it. */
  revision: z.number().int().min(1),
  /** Who the runs belong to: Personal, or an organization. */
  owner: PipelineRunOwnerSchema,
  name,
  /** The desktop pipeline the schedule belongs to; a workflow may have several. */
  sourcePipelineId: id,
  /** The desktop automation record it came from; one schedule per record. */
  sourceRecordId: id,
  workflow: PipelineScheduleWorkflowSchema,
  trigger: PipelineScheduleTriggerSchema,
  /** The If command; null runs every time. */
  runCondition: runCondition.nullable(),
  enabled: z.boolean(),
  inputs: WorkerPipelineLaunchInputsSchema,
  destination: PipelineScheduleDestinationSchema,
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type PipelineSchedule = z.output<typeof PipelineScheduleSchema>;

const keyedMeta = CanopyRequestMetadataSchema.extend({ idempotencyKey: id });

export const PipelineScheduleCreateParamsSchema = z.strictObject({
  owner: PipelineRunOwnerSchema,
  name,
  sourcePipelineId: id,
  sourceRecordId: id,
  workflow: PipelineScheduleWorkflowInputSchema,
  trigger: PipelineScheduleTriggerSchema,
  runCondition: runCondition.optional(),
  enabled: z.boolean(),
  inputs: WorkerPipelineLaunchInputsSchema.optional(),
  destination: PipelineScheduleDestinationSchema,
  _meta: keyedMeta,
});
export type PipelineScheduleCreateParams = z.output<
  typeof PipelineScheduleCreateParamsSchema
>;

export const PipelineScheduleGetParamsSchema = z.strictObject({
  scheduleId: z.uuid(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export type PipelineScheduleGetParams = z.output<
  typeof PipelineScheduleGetParamsSchema
>;

export const PipelineScheduleListParamsSchema = z.strictObject({
  sourcePipelineId: id.optional(),
  sourceRecordId: id.optional(),
  owner: PipelineRunOwnerSchema.optional(),
  cursor: z.string().max(2_048).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(PIPELINE_SCHEDULE_LIST_MAX_LIMIT)
    .optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});
export type PipelineScheduleListParams = z.output<
  typeof PipelineScheduleListParamsSchema
>;

export const PipelineScheduleUpdateParamsSchema = z.strictObject({
  scheduleId: z.uuid(),
  expectedRevision: z.number().int().min(1),
  owner: PipelineRunOwnerSchema.optional(),
  name: name.optional(),
  workflow: PipelineScheduleWorkflowInputSchema.optional(),
  trigger: PipelineScheduleTriggerSchema.optional(),
  /** Null clears the If command. */
  runCondition: runCondition.nullable().optional(),
  enabled: z.boolean().optional(),
  inputs: WorkerPipelineLaunchInputsSchema.optional(),
  destination: PipelineScheduleDestinationSchema.optional(),
  _meta: keyedMeta,
});
export type PipelineScheduleUpdateParams = z.output<
  typeof PipelineScheduleUpdateParamsSchema
>;

export const PipelineScheduleDeleteParamsSchema = z.strictObject({
  scheduleId: z.uuid(),
  /** Deletes only at this revision when given. */
  expectedRevision: z.number().int().min(1).optional(),
  _meta: keyedMeta,
});
export type PipelineScheduleDeleteParams = z.output<
  typeof PipelineScheduleDeleteParamsSchema
>;

export const PipelineScheduleResultSchema = z.strictObject({
  schedule: PipelineScheduleSchema,
});
export type PipelineScheduleResult = z.output<
  typeof PipelineScheduleResultSchema
>;

export const PipelineScheduleListResultSchema = z.strictObject({
  schedules: z.array(PipelineScheduleSchema),
  nextCursor: z.string().max(2_048).nullable(),
});
export type PipelineScheduleListResult = z.output<
  typeof PipelineScheduleListResultSchema
>;

export const PIPELINE_SCHEDULE_QUERY_ERROR_CODES = [
  'core.pipeline.schedule.notFound',
] as const;

export const PIPELINE_SCHEDULE_INSTRUCTION_ERROR_CODES = [
  ...PIPELINE_SCHEDULE_QUERY_ERROR_CODES,
  'core.pipeline.schedule.revisionConflict',
  'core.pipeline.schedule.sourceRecordTaken',
  'core.pipeline.schedule.ownerDenied',
  'core.pipeline.schedule.workflowUnavailable',
  'core.pipeline.schedule.digestMismatch',
  'core.pipeline.schedule.limitReached',
] as const;

export type PipelineScheduleInstructionErrorCode =
  (typeof PIPELINE_SCHEDULE_INSTRUCTION_ERROR_CODES)[number];

export const PipelineScheduleQueryErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(PIPELINE_SCHEDULE_QUERY_ERROR_CODES).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  },
);

export const PipelineScheduleInstructionErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(PIPELINE_SCHEDULE_INSTRUCTION_ERROR_CODES).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const PIPELINE_SCHEDULE_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.pipeline.schedule.get': defineCanopyQuery({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineScheduleGetParamsSchema,
      result: PipelineScheduleResultSchema,
      error: PipelineScheduleQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_SCHEDULE_GRANTS.read],
    }),
    'core.pipeline.schedule.list': defineCanopyQuery({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineScheduleListParamsSchema,
      result: PipelineScheduleListResultSchema,
      error: PipelineScheduleQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [PIPELINE_SCHEDULE_GRANTS.read],
    }),
  },
);

export const PIPELINE_SCHEDULE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.pipeline.schedule.create': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineScheduleCreateParamsSchema,
      result: PipelineScheduleResultSchema,
      error: PipelineScheduleInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_SCHEDULE_GRANTS.write],
    }),
    'core.pipeline.schedule.update': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineScheduleUpdateParamsSchema,
      result: PipelineScheduleResultSchema,
      error: PipelineScheduleInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_SCHEDULE_GRANTS.write],
    }),
    'core.pipeline.schedule.delete': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'core-only',
      params: PipelineScheduleDeleteParamsSchema,
      result: PipelineScheduleResultSchema,
      error: PipelineScheduleInstructionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_SCHEDULE_GRANTS.write],
    }),
  });

/** Every cloud schedule operation, as the web core serves them. */
export const CORE_PIPELINE_SCHEDULE_OPERATIONS = [
  'core.pipeline.schedule.create',
  'core.pipeline.schedule.get',
  'core.pipeline.schedule.list',
  'core.pipeline.schedule.update',
  'core.pipeline.schedule.delete',
] as const;

export type CorePipelineScheduleOperation =
  (typeof CORE_PIPELINE_SCHEDULE_OPERATIONS)[number];
