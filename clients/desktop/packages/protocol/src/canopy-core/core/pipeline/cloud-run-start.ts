import { z } from 'zod';

import { CanopyWorkspaceScopeSchema } from '../../common';
import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyRetryDirectiveSchema,
} from '../../errors';
import {
  WORKER_PIPELINE_LAUNCH_EVENT_TEXT_MAX_BYTES,
  WorkerPipelineLaunchInputsSchema,
} from '../../host-execution';
import { OperationRecordSchema } from '../operation/schemas';
import {
  CLOUD_MODEL_UNCONFIRMED_CODE,
  CloudModelChoicesSchema,
} from './cloud-model-preflight';
import { PIPELINE_GRANTS } from './operations';

/**
 * `core.pipeline.execution.start` (CAN-6187, plan CP-37): a manual run
 * started on an execution target the serving core places it on. The run
 * location is its own field (decision P6): `scope.targetId` names the
 * target, apart from where the run goes (no project, a task or a project)
 * and from a run chat.
 *
 * The web core serves it for its cloud target only
 * (`CLOUD_PIPELINE_RUN_TARGET_ID`), through the cloud run service's start
 * (CAN-6169): admission, the definition pin and the confirmed cloud models
 * (CAN-6174). Beside its target, the scope may name the cloud project
 * (`workspaceId`) whose folder the run executes in, and one of its
 * worktrees (`worktreeId`, CAN-6672). Any other target, or a scope naming
 * anything else, is `capability_unavailable`. Desktop and the daemon don't serve it: a local
 * run starts through their own start paths.
 */

const id = z.string().min(1).max(512);

/** The trigger a manual cloud run starts from. */
export const CLOUD_PIPELINE_RUN_EVENTS = [
  'dispatch',
  'workflow',
  'plan_ready',
  'task_ready',
] as const;

const eventText = z
  .string()
  .min(1)
  .refine(
    (text) =>
      new TextEncoder().encode(text).length <=
      WORKER_PIPELINE_LAUNCH_EVENT_TEXT_MAX_BYTES,
    'The text exceeds its limit.',
  );

/**
 * The plan a `plan_ready` run starts from (CAN-6327): a cloud plan the
 * caller may edit, which the run's writes revise; a plan's text, such as a
 * desktop tracked plan's, which the run's first write keeps as a cloud plan;
 * or the plan of an earlier cloud run of the caller's, so a run chains on
 * from it and revises the same plan.
 */
export const CloudPipelineRunPlanSchema = z.union([
  z.strictObject({ planId: id }),
  z.strictObject({ text: eventText }),
  z.strictObject({ fromExecutionId: id }),
]);
export type CloudPipelineRunPlan = z.output<typeof CloudPipelineRunPlanSchema>;

export const CloudPipelineRunStartParamsSchema = z.strictObject({
  /**
   * `targetId` names the execution target; `workspaceId` and `worktreeId`
   * the cloud project and worktree the run executes in. Nothing else is
   * served.
   */
  scope: CanopyWorkspaceScopeSchema,
  /** `shared:canopy-cloud:<id>` or `curated:<key>`. */
  definitionId: id,
  /** `personal` or `org:<uuid>`: who the run belongs to. */
  owner: z.string().min(1).max(64),
  inputs: WorkerPipelineLaunchInputsSchema.optional(),
  /** Omitted picks `workflow` for a definition that declares only it. */
  eventName: z.enum(CLOUD_PIPELINE_RUN_EVENTS).optional(),
  /** A `plan_ready` run's plan; required with that event and refused with any other. */
  plan: CloudPipelineRunPlanSchema.optional(),
  /** A `task_ready` run's task; required with that event and refused with any other. */
  task: z.strictObject({ text: eventText }).optional(),
  /**
   * Cloud models the user just confirmed for the steps the model preflight
   * listed, with the hash and fingerprint of the preflight they saw.
   */
  modelChoices: z
    .strictObject({
      definitionHash: z.string().length(64),
      policyFingerprint: z.string().length(64),
      choices: CloudModelChoicesSchema,
    })
    .optional(),
  /**
   * The chat whose agent started the run, as the calling host names it
   * (CAN-6391): a desktop project, task and chat. The serving core reports
   * it as the run's agent initiator, so that host's watchers know which of
   * its chats started the run. It grants nothing: it is never the run's
   * agent origin (D11), which only the serving core sets for its own chats,
   * and it may not name one of the serving core's projects.
   */
  chat: z
    .strictObject({ projectId: id, worktreeId: id, chatId: id })
    .optional(),
});
export type CloudPipelineRunStartParams = z.output<
  typeof CloudPipelineRunStartParamsSchema
>;

/** Where a started run waits: in the admission queue, or admitted. */
export const CLOUD_PIPELINE_RUN_ADMISSION_STATES = [
  'waiting',
  'admitted',
  'released',
] as const;

export const CloudPipelineRunStartResultSchema = z.strictObject({
  /** The `core.pipeline.run` operation the start recorded. */
  operation: OperationRecordSchema,
  /** Why it waits, such as `admission_limit`; null when it doesn't. */
  statusReason: z.string().max(128).nullable(),
  admission: z.enum(CLOUD_PIPELINE_RUN_ADMISSION_STATES),
  /** The idempotency key was seen before; the recorded run is answered. */
  replayed: z.boolean(),
});
export type CloudPipelineRunStartResult = z.output<
  typeof CloudPipelineRunStartResultSchema
>;

/**
 * An administrator stopped new cloud runs for the caller's brand (CAN-6377):
 * nothing was recorded; the run may be started once the stop is lifted.
 */
export const CLOUD_RUNS_STOPPED_CODE = 'core.pipeline.cloudRunsStopped';

/** Codes a cloud run start may fail with. */
export const CLOUD_PIPELINE_RUN_START_ERROR_CODES = [
  'core.pipeline.targetUnavailable',
  'core.pipeline.definitionNotFound',
  'core.pipeline.definitionInvalid',
  'core.pipeline.parseFailed',
  'core.pipeline.sourceUnavailable',
  'core.pipeline.contextMismatch',
  'core.pipeline.cloudRunRefused',
  'core.pipeline.planNotFound',
  CLOUD_MODEL_UNCONFIRMED_CODE,
  CLOUD_RUNS_STOPPED_CODE,
] as const;

export const CloudPipelineRunStartErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z.enum(CLOUD_PIPELINE_RUN_START_ERROR_CODES).optional(),
    retry: CanopyRetryDirectiveSchema,
  },
);

/**
 * Served by the web core only, behind the cloud pipelines rollout flag, and
 * not composed into the core registry. It is the first operation of
 * `CORE_PIPELINE_CLOUD_RUN_OPERATIONS`; CP-21 adds the reads and controls.
 */
export const CORE_PIPELINE_CLOUD_RUN_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.pipeline.execution.start': defineCanopyInstruction({
      plane: 'core',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: CloudPipelineRunStartParamsSchema,
      result: CloudPipelineRunStartResultSchema,
      error: CloudPipelineRunStartErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [PIPELINE_GRANTS.write],
    }),
  });
