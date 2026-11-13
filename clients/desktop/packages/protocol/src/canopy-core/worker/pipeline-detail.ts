import { z } from 'zod';

import { CanopyJsonValueSchema } from '../errors';

/*
 * The detail projection of one pipeline execution (CAN-6117): everything the
 * run views render beyond the summary. `worker.pipeline.execution.get` and
 * `.list` carry it beside the summary when a client asks for it, so callers
 * that read only the summary see the version 1 result unchanged. Host paths,
 * diagnostics, step outputs and environments never cross; a saved report or
 * plan crosses as a reference.
 */

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });
const count = z.number().int().min(0);

/** The longest job, variant or step name a detail carries. */
export const WORKER_PIPELINE_DETAIL_NAME_MAX_LENGTH = 512;
/** The longest model name a detail carries. */
export const WORKER_PIPELINE_DETAIL_MODEL_MAX_LENGTH = 512;
/** The most logical jobs, variants per job or steps per job one detail carries. */
export const WORKER_PIPELINE_DETAIL_ITEMS_MAX = 1024;
/** The most pending pauses or status reasons one detail carries. */
export const WORKER_PIPELINE_DETAIL_PAUSES_MAX = 256;
/**
 * The serialized size every pause request of one detail shares. A request
 * past it crosses as `requestUnavailableReason: 'too_large'`, as the Portal's
 * do, so one huge form can't crowd out the run.
 */
export const WORKER_PIPELINE_PAUSE_REQUESTS_MAX_BYTES = 256 * 1024;
/** The serialized size one variant's matrix values may take; past it they are `null`. */
export const WORKER_PIPELINE_MATRIX_VALUES_MAX_BYTES = 16 * 1024;

/**
 * A physical job's status. `waiting_for_capacity` marks one whose next step
 * its host holds while memory is tight; it starts on its own once memory
 * frees (CAN-6325).
 */
export const WORKER_PIPELINE_JOB_STATUSES = [
  'pending',
  'queued',
  'waiting_for_capacity',
  'running',
  'restarting',
  'paused',
  'success',
  'failure',
  'cancelled',
  'skipped',
] as const;

/** A step's status; `waiting_for_capacity` holds it before it starts (CAN-6325). */
export const WORKER_PIPELINE_STEP_STATUSES = [
  'pending',
  'waiting_for_capacity',
  'running',
  'paused',
  'success',
  'failure',
  'cancelled',
  'skipped',
] as const;

export const WORKER_PIPELINE_STEP_CONCLUSIONS = [
  'success',
  'failure',
  'cancelled',
  'skipped',
] as const;

/**
 * Why a paused run stopped, as its status reasons name it; mirrors the
 * executor's `PipelineStatusReasonKind`. `owner_lost` marks a remote owner
 * that stayed away past its lease or stopped answering (CAN-6102);
 * `host_rollover` marks a run checkpointed on request, after its running
 * steps had until a deadline to finish, so its host can roll over
 * (CAN-6199); `app_shutdown` marks a checkpoint or a local owner's loss.
 */
export const WORKER_PIPELINE_STATUS_REASON_KINDS = [
  'provider_sign_in',
  'app_shutdown',
  'owner_lost',
  'host_rollover',
  'input_required',
  'action_paused',
  'provider_authentication_required',
  'provider_usage_limit',
  'provider_temporarily_unavailable',
] as const;

/** Mirrors the executor's `PipelineStatusReasonCode`. */
export const WORKER_PIPELINE_STATUS_REASON_CODES = [
  'provider_sign_in',
  'app_shutdown',
  'owner_lost',
  'host_rollover',
  'input_requested',
  'action_requested_pause',
  'authentication_failed',
  'unauthorized',
  'oauth_organization_forbidden',
  'http_401',
  'rate_limit',
  'usage_limit_exceeded',
  'credits_depleted',
  'http_429',
  'model_capacity',
  'server_overloaded',
  'internal_server_error',
  'http_5xx',
  'connection_failed',
  'stream_disconnected',
  'provider_timeout',
] as const;

export const WORKER_PIPELINE_AGENT_PROVIDERS = [
  'claude',
  'codex',
  'ollama',
  'cursor',
  'opencode',
  'copilot',
] as const;

export const WORKER_PIPELINE_AGENT_HARNESSES = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
] as const;

export const WORKER_PIPELINE_TRIGGER_EVENTS = [
  'dispatch',
  'plan_ready',
  'task_ready',
  'workflow',
] as const;

const conclusion = z.enum(WORKER_PIPELINE_STEP_CONCLUSIONS).nullable();

/** The model a step's agent ran, without its config or credentials. */
export const WorkerPipelineStepAgentSchema = z.strictObject({
  provider: z.enum(WORKER_PIPELINE_AGENT_PROVIDERS).nullable(),
  harness: z.enum(WORKER_PIPELINE_AGENT_HARNESSES).nullable(),
  model: z.string().max(WORKER_PIPELINE_DETAIL_MODEL_MAX_LENGTH).nullable(),
});

export const WorkerPipelineStepDetailSchema = z.strictObject({
  stepId: id,
  name: z.string().max(WORKER_PIPELINE_DETAIL_NAME_MAX_LENGTH),
  status: z.enum(WORKER_PIPELINE_STEP_STATUSES),
  conclusion,
  outcome: conclusion,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  exitCode: z.number().int().nullable(),
  /** Bounded like the summary's; the step log holds the rest. */
  error: z.string().max(4096).nullable(),
  /** Agent recoveries this attempt took. */
  recoveryCount: count,
  /** The child run a `pipeline` step started. */
  childExecutionId: id.nullable(),
  agent: WorkerPipelineStepAgentSchema.nullable(),
});

/** One physical job: a single job's only run, or one matrix variant. */
export const WorkerPipelineVariantDetailSchema = z.strictObject({
  jobId: id,
  name: z.string().max(WORKER_PIPELINE_DETAIL_NAME_MAX_LENGTH),
  status: z.enum(WORKER_PIPELINE_JOB_STATUSES),
  conclusion,
  outcome: conclusion,
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  /** The current retry attempt and iteration, which a step log read names. */
  attempt: count,
  iteration: z.number().int().min(1),
  /** A matrix variant's values; `null` for a single job or values past the limit. */
  matrix: z.record(z.string().max(256), CanopyJsonValueSchema).nullable(),
  steps: z
    .array(WorkerPipelineStepDetailSchema)
    .max(WORKER_PIPELINE_DETAIL_ITEMS_MAX),
});

/** One logical job of the definition, with its physical runs. */
export const WorkerPipelineJobDetailSchema = z.strictObject({
  jobId: id,
  name: z.string().max(WORKER_PIPELINE_DETAIL_NAME_MAX_LENGTH),
  kind: z.enum(['single', 'matrix']),
  status: z.enum(WORKER_PIPELINE_JOB_STATUSES),
  conclusion,
  outcome: conclusion,
  /** The jobs it waits for; empty when it has none. */
  needs: z.array(id).max(WORKER_PIPELINE_DETAIL_ITEMS_MAX),
  expansion: z.enum(['pending', 'expanded', 'failure']),
  expansionError: z.string().max(4096).nullable(),
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  maxParallel: z.number().int().min(1).nullable(),
  /** A single job's one physical job, or a matrix job's variants in order. */
  variants: z
    .array(WorkerPipelineVariantDetailSchema)
    .max(WORKER_PIPELINE_DETAIL_ITEMS_MAX),
});

/** A pause field as the step declared it; optional members appear only when declared. */
export const WorkerPipelinePauseFieldSchema = z.strictObject({
  key: z.string().min(1).max(256),
  label: z.string().max(4096),
  type: z.enum(['string', 'boolean', 'number', 'choice']),
  description: z.string().max(16_384).optional(),
  required: z.boolean().optional(),
  default: z
    .union([z.string().max(65_536), z.number(), z.boolean()])
    .optional(),
  options: z.array(z.string().max(4096)).max(1024).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  multiline: z.boolean().optional(),
});

export const WorkerPipelinePauseRequestSchema = z.strictObject({
  title: z.string().max(4096).optional(),
  message: z.string().max(65_536).optional(),
  fields: z.array(WorkerPipelinePauseFieldSchema).max(256),
});

/** A checkpoint a resume may answer, by the exact identity it names. */
export const WorkerPipelinePauseDetailSchema = z.strictObject({
  id,
  kind: z.enum(['input', 'action']),
  /** The physical job, a matrix variant's own id. */
  jobId: id,
  logicalJobId: id,
  stepId: id,
  attempt: count,
  iteration: count,
  detectedAt: timestamp,
  /** The input request; absent for an action pause or one too large to cross. */
  request: WorkerPipelinePauseRequestSchema.optional(),
  requestUnavailableReason: z.literal('too_large').optional(),
});

/** An active blocker a resume may name, without its host diagnostics. */
export const WorkerPipelineStatusReasonSchema = z.strictObject({
  id,
  kind: z.enum(WORKER_PIPELINE_STATUS_REASON_KINDS),
  code: z.enum(WORKER_PIPELINE_STATUS_REASON_CODES),
  provider: z.enum(WORKER_PIPELINE_AGENT_PROVIDERS).optional(),
  harness: z.enum(WORKER_PIPELINE_AGENT_HARNESSES).optional(),
  accountScope: z.enum(['native', 'ai_credits', 'local']).optional(),
  model: z.string().max(WORKER_PIPELINE_DETAIL_MODEL_MAX_LENGTH).optional(),
  detectedAt: timestamp,
  /** Present only when the provider reported a reset time. */
  resetsAt: timestamp.optional(),
  autoResumeSuppressed: z.literal(true).optional(),
  source: z.strictObject({
    jobId: id,
    stepId: id,
    attempt: count,
    iteration: count,
    childExecutionId: id.optional(),
    childReasonId: id.optional(),
  }),
});

/** A saved output, by reference; its file stays on the worker's host. */
export const WorkerPipelineArtifactSchema = z.strictObject({
  kind: z.enum(['report', 'report_json']),
  /** The physical job and step that saved it; both `null` for the run's own report. */
  jobId: id.nullable(),
  stepId: id.nullable(),
});

const chatAddress = z.strictObject({
  projectId: id,
  worktreeId: id,
  chatId: id,
});

/** Who started a run; host-only gate output and presentation never cross. */
export const WorkerPipelineInitiatorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('user') }),
  z.strictObject({ kind: z.literal('hook') }),
  z.strictObject({ kind: z.literal('portal') }),
  z.strictObject({
    kind: z.literal('automation'),
    automationId: id,
    automationName: z.string().max(512).optional(),
  }),
  z.strictObject({
    kind: z.literal('app_advisor'),
    chat: chatAddress.optional(),
  }),
  z.strictObject({ kind: z.literal('agent'), chat: chatAddress }),
]);

/** The hook that fired a run. */
export const WorkerPipelineHookTriggerSchema = z.strictObject({
  hookKey: z.string().min(1).max(2048),
  hookLabel: z.string().max(512),
  triggerName: z.string().min(1).max(256),
  target: z.enum(['project', 'workspace-root', 'workspace-repo']),
  repoId: id.optional(),
  repoName: z.string().max(512).optional(),
  actionIndex: count,
  triggeredAt: timestamp,
});

export const WorkerPipelineExecutionDetailSchema = z.strictObject({
  /**
   * Changes whenever anything in this detail or its summary changes. Compare
   * it for equality only; it is a digest, not a counter.
   */
  revision: z.string().regex(/^[0-9a-f]{64}$/),
  /** The pinned definition the run executes. */
  definition: z.strictObject({
    /** A curated or stored source's reviewed content hash. */
    contentHash: z.string().min(1).max(512).nullable(),
    /** A curated source's catalog revision. */
    revision: count.nullable(),
    /** The capability package digest the run pinned. */
    packageDigest: z.string().min(1).max(512).nullable(),
  }),
  initiation: z.strictObject({
    /** The usage source; `unknown` when an older run recorded none. */
    source: z.enum([
      'user',
      'hook',
      'automation',
      'app_advisor',
      'portal',
      'unknown',
    ]),
    initiator: WorkerPipelineInitiatorSchema.nullable(),
    hook: WorkerPipelineHookTriggerSchema.nullable(),
    event: z.enum(WORKER_PIPELINE_TRIGGER_EVENTS).nullable(),
    /** The run this one reran or started over. */
    rerunSourceId: id.nullable(),
    /** The step of the parent run that started this child run. */
    parentStep: z
      .strictObject({ stepId: id, attempt: count, iteration: count })
      .nullable(),
  }),
  /** What a rerun can replay; a client gates rerun on it. */
  rerun: z.strictObject({
    inputsPersisted: z.boolean(),
    planReadyText: z.boolean(),
    taskReadyText: z.boolean(),
  }),
  hidden: z.boolean(),
  /** When the whole run paused, while it stays paused. */
  pausedAt: timestamp.nullable(),
  /** Time banked by closed whole-run pauses. */
  pausedMs: count,
  plan: z
    .strictObject({
      planId: id.nullable(),
      /** The run saved a plan. */
      saved: z.boolean(),
      modified: z.boolean(),
    })
    .nullable(),
  artifacts: z
    .array(WorkerPipelineArtifactSchema)
    .max(WORKER_PIPELINE_DETAIL_ITEMS_MAX),
  jobs: z
    .array(WorkerPipelineJobDetailSchema)
    .max(WORKER_PIPELINE_DETAIL_ITEMS_MAX),
  pendingPauses: z
    .array(WorkerPipelinePauseDetailSchema)
    .max(WORKER_PIPELINE_DETAIL_PAUSES_MAX),
  statusReasons: z
    .array(WorkerPipelineStatusReasonSchema)
    .max(WORKER_PIPELINE_DETAIL_PAUSES_MAX),
});

export type WorkerPipelineExecutionDetail = z.output<
  typeof WorkerPipelineExecutionDetailSchema
>;
export type WorkerPipelineJobDetail = z.output<
  typeof WorkerPipelineJobDetailSchema
>;
export type WorkerPipelineVariantDetail = z.output<
  typeof WorkerPipelineVariantDetailSchema
>;
export type WorkerPipelineStepDetail = z.output<
  typeof WorkerPipelineStepDetailSchema
>;
export type WorkerPipelinePauseDetail = z.output<
  typeof WorkerPipelinePauseDetailSchema
>;
export type WorkerPipelinePauseRequest = z.output<
  typeof WorkerPipelinePauseRequestSchema
>;
export type WorkerPipelineStatusReason = z.output<
  typeof WorkerPipelineStatusReasonSchema
>;
export type WorkerPipelineArtifact = z.output<
  typeof WorkerPipelineArtifactSchema
>;
