import { z } from 'zod';
import {
  ExecutionSecretBindingsSchema,
  WORKER_EXECUTION_SECRET_ERROR_CODES,
} from './execution-secrets';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from '../common';
import {
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../errors';
import { SIDEBAR_ITEM_GROUP_COLORS } from '../sidebar-values';
import {
  PIPELINE_DEFINITION_SOURCES,
  PipelineRunOwnerSchema,
} from '../pipeline-values';
import {
  WORKER_PIPELINE_HOST_TEXT_MAX,
  WorkerPipelineChatAddressSchema,
  WorkerPipelineChatSendRecordSchema,
  WorkerPipelinePromptReferenceSchema,
  WorkerPipelineSendSettingsSchema,
} from './pipeline-host-values';
import {
  WORKER_PIPELINE_OWNER_REQUEST_MEMBERS,
  WorkerPipelineOwnerResultSchema,
} from './pipeline-owner-requests';
import {
  WORKER_PIPELINE_STATUS_REASON_KINDS,
  WorkerPipelineExecutionDetailSchema,
} from './pipeline-detail';
import { WorkerPipelinePortableLaunchSchema } from './pipeline-portable-launch';

/*
 * `worker.pipeline.execution.*` (CAN-4140): start, status, cancel and bounded
 * events for one pipeline execution on a worker. Core resolves the
 * definition, the run's owner and its authorization before it dispatches a
 * start; the worker runs the snapshot core admitted and never treats a
 * client path as definition authority. Host paths never cross this boundary.
 */

export const WORKER_PIPELINE_GRANTS = {
  read: 'worker.pipeline.read',
  write: 'worker.pipeline.write',
  /**
   * Settles host-step requests. Only the owning core holds it: no interface
   * surface lists the host request operations, so the renderer relay never
   * passes it on.
   */
  host: 'worker.pipeline.host',
} as const;

const id = z.string().min(1).max(512);
const timestamp = z.iso.datetime({ offset: true });

export const WORKER_PIPELINE_EXECUTION_STATUSES = [
  'pending',
  'running',
  'paused',
  'success',
  'failure',
  'cancelled',
] as const;

export const WORKER_PIPELINE_TERMINAL_STATUSES = [
  'success',
  'failure',
  'cancelled',
] as const;

export const WORKER_PIPELINE_RUN_SCOPES = [
  'global',
  'directory',
  'worktree',
] as const;

/** Where a run's definition came from; `inline` has no stored identity. */
export const WORKER_PIPELINE_DEFINITION_SOURCES = [
  ...PIPELINE_DEFINITION_SOURCES,
  'inline',
] as const;

/** What started a run, as the usage records name it. */
export const WORKER_PIPELINE_INITIATION_SOURCES = [
  'user',
  'hook',
  'automation',
  'app_advisor',
  'portal',
  'unknown',
] as const;

/** The longest error message an execution projection carries. */
export const WORKER_PIPELINE_ERROR_MAX_LENGTH = 4096;
/** The most output text one events item carries. */
export const WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH = 16_384;
/** The longest notification title and body one events item carries (CAN-5868). */
export const WORKER_PIPELINE_NOTIFICATION_TITLE_MAX_LENGTH = 256;
export const WORKER_PIPELINE_NOTIFICATION_BODY_MAX_LENGTH = 4096;

export const WorkerPipelineExecutionSchema = z.strictObject({
  executionId: id,
  pipelineId: id,
  name: z.string().max(512),
  status: z.enum(WORKER_PIPELINE_EXECUTION_STATUSES),
  runScope: z.enum(WORKER_PIPELINE_RUN_SCOPES),
  definitionSource: z.enum(WORKER_PIPELINE_DEFINITION_SOURCES),
  /** The run's owner; older runs may have none. */
  owner: PipelineRunOwnerSchema.nullable(),
  workspaceId: id.nullable(),
  worktreeId: id.nullable(),
  parentExecutionId: id.nullable(),
  startedAt: timestamp,
  completedAt: timestamp.nullable(),
  /** Pause checkpoints a resume may answer. */
  pendingPauseCount: z.number().int().min(0),
  /**
   * The kinds of the run's active status reasons, each once; absent when it
   * has none (CAN-6102).
   */
  statusReasonKinds: z
    .array(z.enum(WORKER_PIPELINE_STATUS_REASON_KINDS))
    .min(1)
    .max(WORKER_PIPELINE_STATUS_REASON_KINDS.length)
    .optional(),
  error: z.string().max(WORKER_PIPELINE_ERROR_MAX_LENGTH).nullable(),
});

export const WorkerPipelineExecutionStartParamsSchema = z.strictObject({
  executionId: id,
  pipelineId: id,
  definitionSource: z.enum(WORKER_PIPELINE_DEFINITION_SOURCES),
  runScope: z.enum(WORKER_PIPELINE_RUN_SCOPES),
  workspaceId: id.nullable(),
  worktreeId: id.nullable(),
  /** The owner core resolved and authorized the run for. */
  owner: PipelineRunOwnerSchema,
  initiationSource: z.enum(WORKER_PIPELINE_INITIATION_SOURCES),
  secrets: ExecutionSecretBindingsSchema.optional(),
  /**
   * What a remote primary asks a cloud runner to run (CAN-6161): the launch
   * without host paths. Only a worker that maps portable starts to its own
   * paths accepts it, and never beside a host-local `_execution.pipelineLaunch`.
   */
  portableLaunch: WorkerPipelinePortableLaunchSchema.optional(),
});

export const WorkerPipelineExecutionResultSchema = z.strictObject({
  execution: WorkerPipelineExecutionSchema,
});

export const WorkerPipelineExecutionGetParamsSchema = z.strictObject({
  executionId: id,
  /** Also return the execution's detail projection (CAN-6117). */
  detail: z.literal(true).optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

/** The summary, and the detail when the request asked for it. */
export const WorkerPipelineExecutionViewSchema = z.strictObject({
  execution: WorkerPipelineExecutionSchema,
  detail: WorkerPipelineExecutionDetailSchema.optional(),
});

export const WorkerPipelineExecutionGetResultSchema =
  WorkerPipelineExecutionViewSchema;

/** The most executions one list page carries. */
export const WORKER_PIPELINE_LIST_LIMIT_MAX = 100;
export const WORKER_PIPELINE_LIST_LIMIT_DEFAULT = 50;

/**
 * `worker.pipeline.execution.list` (CAN-6117): the executions this worker
 * holds, newest first (by start time, then execution id), one bounded page
 * at a time. Every filter narrows; an absent one matches everything.
 */
export const WorkerPipelineExecutionListParamsSchema = z.strictObject({
  /**
   * The workspace and worktree to list, and the execution target that must
   * serve the call. A worker refuses a `targetId` it isn't.
   */
  scope: CanopyWorkspaceScopeSchema.pick({
    workspaceId: true,
    worktreeId: true,
    targetId: true,
  }).optional(),
  /** Runs this owner owns; a run that recorded none is `personal`. */
  owner: PipelineRunOwnerSchema.optional(),
  pipelineId: id.optional(),
  runScopes: z
    .array(z.enum(WORKER_PIPELINE_RUN_SCOPES))
    .min(1)
    .max(WORKER_PIPELINE_RUN_SCOPES.length)
    .optional(),
  statuses: z
    .array(z.enum(WORKER_PIPELINE_EXECUTION_STATUSES))
    .min(1)
    .max(WORKER_PIPELINE_EXECUTION_STATUSES.length)
    .optional(),
  /** Also return each execution's detail projection. */
  detail: z.literal(true).optional(),
  /** The previous page's `nextCursor`; absent for the first page. */
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(WORKER_PIPELINE_LIST_LIMIT_MAX).optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const WorkerPipelineExecutionListResultSchema = z.strictObject({
  executions: z
    .array(WorkerPipelineExecutionViewSchema)
    .max(WORKER_PIPELINE_LIST_LIMIT_MAX),
  /** `null` on the last page. */
  nextCursor: z.string().min(1).max(2048).nullable(),
});

export const WORKER_PIPELINE_CANCEL_MODES = ['finalize', 'drain'] as const;

export const WorkerPipelineExecutionCancelParamsSchema = z.strictObject({
  executionId: id,
  /**
   * `finalize` (the default) settles a run that ignores its cancel after a
   * bounded window. `drain` stops its live processes within a bounded wait
   * and never writes a terminal state itself, so a run still stopping keeps
   * its cancel request and running state (archive teardown).
   */
  mode: z.enum(WORKER_PIPELINE_CANCEL_MODES).optional(),
});

export const WorkerPipelineExecutionEventsParamsSchema = z.strictObject({
  executionId: id,
  /**
   * The last cursor the caller received, to resume after it (CAN-6161). A
   * worker that keeps an event journal replays what followed; any other
   * answers `worker.pipeline.snapshotRequired`, as it does for another
   * epoch's cursor or one older than its journal. Without one the stream
   * starts from a snapshot.
   */
  cursor: CanopyStreamCursorSchema.nullable().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const WorkerPipelineExecutionEventsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});

/**
 * One events item. Lifecycle and notification items are never dropped. Output is budgeted:
 * text past an item's limit is cut, and output past the stream's budget is
 * dropped and reported by the next `gap` item, so output pressure never
 * crowds out a lifecycle or terminal item.
 */
export const WorkerPipelineExecutionEventsItemSchema = z.discriminatedUnion(
  'kind',
  [
    z.strictObject({
      kind: z.literal('execution'),
      event: z.string().min(1).max(128),
      execution: WorkerPipelineExecutionSchema,
    }),
    z.strictObject({
      kind: z.literal('output'),
      jobId: id,
      stepId: id,
      /** The retry attempt and job iteration that printed it (CAN-5086). */
      attempt: z.number().int().min(0).optional(),
      iteration: z.number().int().min(1).optional(),
      stream: z.enum(['stdout', 'stderr']),
      text: z.string().max(WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH),
      truncated: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal('gap'),
      droppedOutputItems: z.number().int().min(1),
    }),
    /** A desktop notification a step asked for, such as `builtin/notify` (CAN-5868). */
    z.strictObject({
      kind: z.literal('notification'),
      stepId: id,
      title: z.string().max(WORKER_PIPELINE_NOTIFICATION_TITLE_MAX_LENGTH),
      body: z.string().max(WORKER_PIPELINE_NOTIFICATION_BODY_MAX_LENGTH),
    }),
  ],
);

export const WorkerPipelineExecutionErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.launchUnavailable',
        'worker.pipeline.startFailed',
        'worker.pipeline.launchRefused',
        'worker.pipeline.modelStepsUnsupported',
        'worker.pipeline.hostUnavailable',
        'worker.pipeline.hostLost',
        'worker.pipeline.ownerUnavailable',
        ...WORKER_EXECUTION_SECRET_ERROR_CODES,
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const WorkerPipelineExecutionCancelErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.drainTimedOut',
        'worker.pipeline.hostUnavailable',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

export const WorkerPipelineExecutionQueryErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.hostUnavailable',
        'worker.pipeline.hostLost',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WorkerPipelineExecutionListErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.pipeline.invalidCursor',
        'worker.pipeline.targetUnavailable',
        'worker.pipeline.hostUnavailable',
        'worker.pipeline.hostLost',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

/** The events stream's errors: the query errors, and a cursor it cannot resume (CAN-6161). */
export const WorkerPipelineExecutionEventsErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.hostUnavailable',
        'worker.pipeline.hostLost',
        'worker.pipeline.snapshotRequired',
      ])
      .optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WorkerPipelineExecutionEventsEndSchema =
  CanopyStreamEndSchema.extend({
    error: WorkerPipelineExecutionEventsErrorSchema.nullable(),
  });

/*
 * Recovery controls (CAN-4141): resume, retry, start over and the matrix
 * controls act on an execution the worker holds. Core records each as a
 * `core.pipeline.control` operation receipted by `requestId`, so a
 * redelivered or unanswered control is never sent again.
 */

/** The idempotency key of one control; a Portal command id when it has one. */
const requestId = id;
const statusReasonId = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

/**
 * The longest text one pause answer carries. The executor never capped
 * answers, and a multiline input may take pasted logs or a spec, so the
 * boundary only rules out unbounded payloads.
 */
export const WORKER_PIPELINE_PAUSE_ANSWER_MAX_LENGTH = 1_000_000;

/** An answer to one pending input request, the run's pending-input command. */
export const WorkerPipelinePauseResponseSchema = z.strictObject({
  /** The exact pause it answers, so a stale answer can't reach a newer one. */
  checkpointId: id.optional(),
  jobId: id,
  stepId: id,
  answers: z
    .record(
      z.string().min(1).max(256),
      z.union([
        z.string().max(WORKER_PIPELINE_PAUSE_ANSWER_MAX_LENGTH),
        z.number(),
        z.boolean(),
      ]),
    )
    .refine(
      (answers) => Object.keys(answers).length <= 256,
      'Too many answers.',
    )
    .optional(),
});

/** Who asked for a control; usage records keep the run's own source. */
export const WORKER_PIPELINE_CONTROL_SOURCES = [
  'user',
  'automation',
  'portal',
] as const;

export const WorkerPipelineExecutionResumeParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  /** The pauses to resume; every recoverable one when absent. */
  statusReasonIds: z.array(statusReasonId).min(1).max(256).optional(),
  pauseResponses: z
    .array(WorkerPipelinePauseResponseSchema)
    .min(1)
    .max(256)
    .optional(),
  /** Answer `stale_noop` when none of the named pauses is current. */
  allowStaleNoop: z.boolean().optional(),
  initiationSource: z.enum(WORKER_PIPELINE_CONTROL_SOURCES),
  /** Attribute the rest of the run to `initiationSource`. */
  persistInitiationSource: z.boolean().optional(),
  secrets: ExecutionSecretBindingsSchema.optional(),
});

export const WORKER_PIPELINE_RETRY_MODES = [
  'failed_only',
  'from_start',
] as const;

export const WorkerPipelineExecutionRetryParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  /**
   * `failed_only` reruns the execution's failed work in place. `from_start` runs
   * its snapshot again as `newExecutionId`.
   */
  mode: z.enum(WORKER_PIPELINE_RETRY_MODES),
  newExecutionId: id.optional(),
  initiationSource: z.enum(WORKER_PIPELINE_CONTROL_SOURCES).optional(),
  secrets: ExecutionSecretBindingsSchema.optional(),
});

export const WORKER_PIPELINE_MATRIX_RETRY_MODES = [
  'all',
  'failed',
  'variants',
  'expansion',
] as const;

export const WorkerPipelineMatrixJobRetryParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  jobId: id,
  mode: z.enum(WORKER_PIPELINE_MATRIX_RETRY_MODES),
  variantJobIds: z.array(id).min(1).max(1024).optional(),
  secrets: ExecutionSecretBindingsSchema.optional(),
});

export const WorkerPipelineMatrixVariantCancelParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  jobId: id,
  variantJobId: id,
});

/**
 * What a control did. `started` runs the execution (for `from_start`, the
 * new one); `updated` changed it without running anything; `already_running`
 * and `stale_noop` changed nothing.
 */
export const WORKER_PIPELINE_CONTROL_OUTCOMES = [
  'started',
  'updated',
  'already_running',
  'stale_noop',
] as const;

export const WorkerPipelineControlResultSchema = z.strictObject({
  outcome: z.enum(WORKER_PIPELINE_CONTROL_OUTCOMES),
  execution: WorkerPipelineExecutionSchema,
});

export const WorkerPipelineControlErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.launchUnavailable',
        'worker.pipeline.controlFailed',
        // A cloud runner's resume and retry (CAN-6103): its launch, host and owner.
        'worker.pipeline.launchRefused',
        'worker.pipeline.hostUnavailable',
        'worker.pipeline.hostLost',
        'worker.pipeline.ownerUnavailable',
        ...WORKER_EXECUTION_SECRET_ERROR_CODES,
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  },
);

/*
 * Startup and shutdown recovery (CAN-4141): the orphan sweep pauses the
 * executions a process left running when it exited, so they can resume, and
 * the shutdown checkpoint pauses every live execution before the worker
 * stops. Messages stay on the host; results carry ids and counts only.
 */

/** The most executions one startup sweep looks at. */
export const WORKER_PIPELINE_SWEEP_MAX = 10_000;

export const WorkerPipelineRecoverySweepParamsSchema = z.strictObject({
  requestId,
  /** The executions the startup scan found; only orphaned ones change. */
  executionIds: z.array(id).max(WORKER_PIPELINE_SWEEP_MAX),
});

export const WorkerPipelineRecoverySweepResultSchema = z.strictObject({
  /** Executions the sweep could not recover; a later startup retries them. */
  failureCount: z.number().int().min(0),
});

export const WorkerPipelineRecoveryCheckpointParamsSchema = z.strictObject({
  requestId,
});

export const WorkerPipelineRecoveryCheckpointResultSchema = z.strictObject({
  /** Live executions the worker paused at a checkpoint. */
  checkpointedCount: z.number().int().min(0),
});

export const WorkerPipelineRecoveryErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(['worker.pipeline.checkpointFailed']).optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

/*
 * One run's graceful checkpoint (CAN-6199, cloud pipelines CP-09), which a
 * cloud runner serves so its owner can roll its sandbox over, or stop paying
 * for one that only waits. No new step starts; the steps already running may
 * finish until the drain ends; then the rest pauses with `host_rollover`. A
 * run whose only running work is host waits, such as `wait-for-agent-reply`,
 * pauses at once, and each wait resumes on the same turn.
 */

/** The longest a checkpoint lets running steps finish: the rollover warning's lead. */
export const WORKER_PIPELINE_CHECKPOINT_DRAIN_MAX_MS = 3_600_000;

export const WorkerPipelineExecutionCheckpointParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  /**
   * How long the run's running steps may finish before the rest is
   * checkpointed; 0 checkpoints at once. A second checkpoint of the same run
   * joins the first and may only bring its end forward.
   */
  drainMs: z.number().int().min(0).max(WORKER_PIPELINE_CHECKPOINT_DRAIN_MAX_MS),
});

export const WorkerPipelineExecutionCheckpointErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        'worker.pipeline.executionNotFound',
        'worker.pipeline.checkpointFailed',
        'worker.pipeline.hostUnavailable',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

/*
 * A pipeline's data on a cloud runner (CAN-6317, cloud pipelines CP-35): its
 * `canopy.pipeline_data_dir` state, its installed assets and the workspace a
 * global run works in, where `memory`, `memory-read`, `memory-write` and
 * `comms-setup` keep their files. The web core keeps it per run owner and
 * pipeline. It imports it before a start on each new incarnation, and
 * exports it after a checkpoint and when the run ends. Both move one
 * uncompressed tar archive in chunks, so each frame fits the relay. The
 * runner never calls the web core, so the web core drives both.
 */

/** The largest pipeline data archive a runner imports or exports. */
export const WORKER_PIPELINE_DATA_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;

/** The largest chunk of an archive one call carries, before base64. */
export const WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES = 3 * 1024 * 1024;

const base64 = z
  .string()
  .max(Math.ceil(WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** The archive one import or export moves: its SHA-256 and size. */
export const WorkerPipelineDataArchiveSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().min(0).max(WORKER_PIPELINE_DATA_ARCHIVE_MAX_BYTES),
});

/** Which pipeline's data: the run owner and pipeline id a start names. */
const pipelineDataOf = {
  owner: PipelineRunOwnerSchema,
  pipelineId: id,
};

/**
 * One chunk of the archive to restore, in order from offset 0. The runner
 * unpacks it when the last chunk arrives and its SHA-256 matches, replacing
 * the pipeline's data on the runner. A chunk sent again is answered as
 * received.
 */
export const WorkerPipelineDataImportParamsSchema = z.strictObject({
  requestId,
  ...pipelineDataOf,
  archive: WorkerPipelineDataArchiveSchema,
  offset: z.number().int().min(0).max(WORKER_PIPELINE_DATA_ARCHIVE_MAX_BYTES),
  /** base64 of at most `WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES`. */
  chunk: base64,
});

export const WorkerPipelineDataImportResultSchema = z.strictObject({
  /** Bytes of the archive the runner holds so far. */
  received: z.number().int().min(0).max(WORKER_PIPELINE_DATA_ARCHIVE_MAX_BYTES),
  /** The archive is complete and unpacked. */
  complete: z.boolean(),
});

/**
 * Reads the pipeline's data from the runner. Without `snapshot`, the runner
 * packs the data as it is now; with it, the call continues reading that
 * snapshot at `offset`.
 */
export const WorkerPipelineDataExportParamsSchema = z.strictObject({
  requestId,
  ...pipelineDataOf,
  snapshot: z
    .strictObject({
      sha256: WorkerPipelineDataArchiveSchema.shape.sha256,
      offset: z
        .number()
        .int()
        .min(0)
        .max(WORKER_PIPELINE_DATA_ARCHIVE_MAX_BYTES),
    })
    .optional(),
});

export const WorkerPipelineDataExportResultSchema = z.strictObject({
  archive: WorkerPipelineDataArchiveSchema,
  offset: z.number().int().min(0).max(WORKER_PIPELINE_DATA_ARCHIVE_MAX_BYTES),
  chunk: base64,
  /** This chunk ends the archive. */
  complete: z.boolean(),
});

export const WorkerPipelineDataErrorSchema = CanopyErrorPayloadSchema.extend({
  code: z
    .enum([
      /** A run of the pipeline is running; checkpoint it or let it end first. */
      'worker.pipeline.dataBusy',
      /** The data exceeds its limit, a chunk is out of order, or the archive is invalid. */
      'worker.pipeline.dataRefused',
      /** The snapshot an export continues is gone: export again without one. */
      'worker.pipeline.dataSnapshotGone',
    ])
    .optional(),
  retry: CanopyKeyedRetryDirectiveSchema,
});

/*
 * One run's handoff between cloud runner incarnations (CAN-6376, cloud
 * pipelines CP-74). A runner's data root is lost with its sandbox, so after
 * a checkpoint the web core exports the paused run: its whole execution
 * directory (CAN-6198) and the Claude Code and Codex sessions its agent
 * steps recorded, so an agent step resumes its session. On a new
 * incarnation the web core imports it before it sends the run's portable
 * start again, which the runner takes as the run's own, and then resumes the
 * run. Both move one archive in chunks, as pipeline data does; the web core
 * stores it unread.
 */

/** The largest run handoff a runner imports or exports: the web core's object limit. */
export const WORKER_PIPELINE_HANDOFF_ARCHIVE_MAX_BYTES = 64 * 1024 * 1024;

/** The handoff archive one import or export moves: its SHA-256 and size. */
export const WorkerPipelineHandoffArchiveSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z
    .number()
    .int()
    .min(0)
    .max(WORKER_PIPELINE_HANDOFF_ARCHIVE_MAX_BYTES),
});

const handoffOffset = z
  .number()
  .int()
  .min(0)
  .max(WORKER_PIPELINE_HANDOFF_ARCHIVE_MAX_BYTES);

/**
 * Reads one run's handoff from the runner. Without `snapshot`, the runner
 * packs the run as its store holds it now; with it, the call continues
 * reading that snapshot at `offset`.
 */
export const WorkerPipelineExecutionHandoffExportParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  snapshot: z
    .strictObject({
      sha256: WorkerPipelineHandoffArchiveSchema.shape.sha256,
      offset: handoffOffset,
    })
    .optional(),
});

export const WorkerPipelineExecutionHandoffExportResultSchema = z.strictObject({
  archive: WorkerPipelineHandoffArchiveSchema,
  offset: handoffOffset,
  /** base64 of at most `WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES`. */
  chunk: base64,
  /** This chunk ends the archive. */
  complete: z.boolean(),
});

/**
 * One chunk of a run's handoff to restore, in order from offset 0. When the
 * last chunk arrives and its SHA-256 matches, the runner restores the run
 * into its store and its sessions into the provider stores. A store that
 * already holds the run keeps it. A chunk sent again is answered as
 * received.
 */
export const WorkerPipelineExecutionHandoffImportParamsSchema = z.strictObject({
  requestId,
  executionId: id,
  archive: WorkerPipelineHandoffArchiveSchema,
  offset: handoffOffset,
  /** base64 of at most `WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES`. */
  chunk: base64,
});

export const WorkerPipelineExecutionHandoffImportResultSchema = z.strictObject({
  /** Bytes of the archive the runner holds so far. */
  received: handoffOffset,
  /** The archive is complete and the run restored. */
  complete: z.boolean(),
});

export const WorkerPipelineHandoffErrorSchema = CanopyErrorPayloadSchema.extend(
  {
    code: z
      .enum([
        /** The runner holds no such run to export. */
        'worker.pipeline.executionNotFound',
        /** The run is pending or running, or another import of it is unpacking. */
        'worker.pipeline.handoffBusy',
        /** Over its limit, out of order, not this run's, invalid, or the lease ended. */
        'worker.pipeline.handoffRefused',
        /** The snapshot an export continues is gone: export again without one. */
        'worker.pipeline.handoffSnapshotGone',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  },
);

/*
 * One agent step's transcript from a cloud runner (CAN-6421, cloud pipelines
 * CP-24). An agent step's events carry its transcript as output, but output
 * is budgeted (cut past an item's limit, dropped past the stream's), and the
 * transcript file the step records stays in the sandbox, which is lost with
 * it. So the web core reads each finished agent step's transcript back, one
 * chunk at a time, and keeps it as a run artifact. The step's latest
 * attempt's transcript is read: the one its `transcript_file` output names.
 */

/** The largest transcript a runner exports: the web core's object limit. */
export const WORKER_PIPELINE_TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;

/** The transcript one export reads: its SHA-256 and size. */
export const WorkerPipelineTranscriptSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: z.number().int().min(0).max(WORKER_PIPELINE_TRANSCRIPT_MAX_BYTES),
});

const transcriptOffset = z
  .number()
  .int()
  .min(0)
  .max(WORKER_PIPELINE_TRANSCRIPT_MAX_BYTES);

/**
 * Reads one step's transcript from the runner. Without `snapshot`, the
 * runner reads the transcript the step records now; with it, the call
 * continues reading that transcript at `offset`.
 */
export const WorkerPipelineExecutionTranscriptExportParamsSchema =
  z.strictObject({
    requestId,
    executionId: id,
    /** The physical job: a single job's id, or a matrix variant's own. */
    jobId: id,
    stepId: id,
    snapshot: z
      .strictObject({
        sha256: WorkerPipelineTranscriptSchema.shape.sha256,
        offset: transcriptOffset,
      })
      .optional(),
  });

export const WorkerPipelineExecutionTranscriptExportResultSchema =
  z.strictObject({
    transcript: WorkerPipelineTranscriptSchema,
    offset: transcriptOffset,
    /** base64 of at most `WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES`. */
    chunk: base64,
    /** This chunk ends the transcript. */
    complete: z.boolean(),
  });

export const WorkerPipelineTranscriptErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        /** The runner holds no such run. */
        'worker.pipeline.executionNotFound',
        /** The step recorded no transcript: it is not an agent step, or has not finished. */
        'worker.pipeline.transcriptNotFound',
        /** The transcript is over its limit, or not a file of the run. */
        'worker.pipeline.transcriptRefused',
        /** The transcript an export continues changed: export again without a snapshot. */
        'worker.pipeline.transcriptSnapshotGone',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

/*
 * A cloud run's capabilities on its runner (CAN-6439, cloud pipelines
 * CP-25). The web core resolves each plugin collection a run names into a
 * capability bundle (`@canopy/protocol/capability-bundle`) before the run
 * starts, and imports the bundles into each new incarnation before it sends
 * the run's portable start: one delivery document with the bundles and the
 * blobs of their plugin trees, moved in chunks as pipeline data is. The
 * runner materializes each bundle in its data root, where its steps resolve
 * the selection refs `cloudRunCapabilityPlan` names
 * (`@canopy/protocol/capability-bundle`), and which the start's plugin
 * collection snapshots carry. Bundles are secret-free: an MCP server's
 * proxy credential is the run's AI Credits session key, which the runner
 * adds from its activation.
 */

/** The largest capability delivery a runner imports: the web core's object limit. */
export const WORKER_PIPELINE_CAPABILITIES_MAX_BYTES = 64 * 1024 * 1024;

/** The most bundles one delivery carries: one per plugin collection a run names. */
export const WORKER_PIPELINE_CAPABILITY_BUNDLES_MAX = 32;

/** The most blobs one delivery carries: every bundle's file tree entries. */
export const WORKER_PIPELINE_CAPABILITY_BLOBS_MAX = 8192;

const capabilitiesOffset = z
  .number()
  .int()
  .min(0)
  .max(WORKER_PIPELINE_CAPABILITIES_MAX_BYTES);

/** The delivery one import moves: the SHA-256 and size of its document's UTF-8 JSON. */
export const WorkerPipelineCapabilityDeliveryRefSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteSize: capabilitiesOffset,
});

/**
 * The delivery document: each bundle with its digest, and the content of
 * every blob a bundle's file trees name, once. The runner checks each
 * bundle against its digest and validation, and each blob against its
 * SHA-256 and the size its entries record, before it writes anything.
 */
export const WorkerPipelineCapabilityDeliverySchema = z.strictObject({
  version: z.literal(1),
  bundles: z
    .array(
      z.strictObject({
        /** `cb:v1:<base64url SHA-256>` of the bundle's canonical form. */
        digest: z.string().regex(/^cb:v1:[A-Za-z0-9_-]{43}$/),
        /** A `CapabilityBundleV1`, checked with `isCapabilityBundleV1`. */
        bundle: z.unknown(),
      }),
    )
    .max(WORKER_PIPELINE_CAPABILITY_BUNDLES_MAX),
  blobs: z
    .array(
      z.strictObject({
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        /** base64 of the blob's bytes. */
        content: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/),
      }),
    )
    .max(WORKER_PIPELINE_CAPABILITY_BLOBS_MAX),
});

/**
 * One chunk of a capability delivery, in order from offset 0. When the last
 * chunk arrives and its SHA-256 matches, the runner materializes every
 * bundle it does not hold yet. Bundles are immutable by digest, so a bundle
 * the runner already holds is kept, and an import adds to what earlier
 * imports delivered. A chunk sent again is answered as received.
 */
export const WorkerPipelineCapabilitiesImportParamsSchema = z.strictObject({
  requestId,
  delivery: WorkerPipelineCapabilityDeliveryRefSchema,
  offset: capabilitiesOffset,
  /** base64 of at most `WORKER_PIPELINE_DATA_CHUNK_MAX_BYTES`. */
  chunk: base64,
});

export const WorkerPipelineCapabilitiesImportResultSchema = z.strictObject({
  /** Bytes of the delivery the runner holds so far. */
  received: capabilitiesOffset,
  /** The delivery is complete and its bundles materialized. */
  complete: z.boolean(),
});

export const WorkerPipelineCapabilitiesErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z
      .enum([
        /**
         * Over its limit, out of order, not matching its digest, or a bundle
         * or blob that is invalid, or an MCP server outside the runner's
         * proxy origin.
         */
        'worker.pipeline.capabilitiesRefused',
      ])
      .optional(),
    retry: CanopyKeyedRetryDirectiveSchema,
  });

/** Every host step crosses as a request (CAN-4140, CAN-5077). */
export const WORKER_PIPELINE_HOST_ACTIONS = [
  'move-to-group',
  'create-worktree',
  'create-project-entry',
  'create-bot-entry',
  'send-agent-message',
  'wait-for-agent-reply',
] as const;

export const WORKER_PIPELINE_HOST_FAILURE_REASONS = [
  'not_found',
  'advisor_access_disabled',
  'owner_context_unavailable',
  'validation_failed',
  'target_not_ready',
  'unsupported_action',
  'authorization_conflict',
  'needs_desktop',
  'needs_host',
  'setup_failed',
  'setup_timed_out',
  'reply_timed_out',
] as const;

/** Outputs that are host paths; the worker derives them on its own host. */
export const WORKER_PIPELINE_HOST_PATH_OUTPUTS = [
  'path',
  'setup_log_file',
  'setup_results_file',
  'reply_file',
] as const;

const hostRequestId = z.string().min(1).max(3072);
/**
 * A name a step's inputs carry, such as a group or branch name. The step
 * parsers don't bound them, so the boundary bounds them only as it bounds
 * output values; the host applies its own limits as it always has.
 */
const name = z.string().min(1).max(20_000);

const hostOutputs = z
  .record(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^(?!(?:path|setup_log_file|setup_results_file|reply_file)$)/, {
        message: 'Host paths never cross this boundary.',
      }),
    z.string().max(20_000),
  )
  .refine((outputs) => Object.keys(outputs).length <= 64, 'Too many outputs.');

export const WorkerPipelineHostActionRequestSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({
      action: z.literal('move-to-group'),
      task: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('project'),
          projectId: id,
          taskId: id,
        }),
        z.strictObject({ kind: z.literal('bot'), botId: id, taskId: id }),
      ]),
      target: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('name'),
          name,
          color: z.enum(SIDEBAR_ITEM_GROUP_COLORS).optional(),
        }),
        z.strictObject({ kind: z.literal('id'), groupId: id }),
        z.strictObject({ kind: z.literal('remove') }),
      ]),
    }),
    z.strictObject({
      action: z.literal('create-worktree'),
      projectId: id,
      branch: z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('default') }),
        z.strictObject({ kind: z.literal('new'), name }),
        z.strictObject({ kind: z.literal('existing'), name }),
      ]),
      baseBranch: name.optional(),
      baseTaskId: id.optional(),
      repair: z.boolean(),
      restoreClaudeMd: z.boolean().optional(),
      setup: z.enum(['skip', 'run', 'run_and_wait']),
      group: name.optional(),
    }),
    z.strictObject({
      action: z.literal('create-project-entry'),
      projectId: id,
      title: z.string().min(1).max(200).optional(),
      group: name.optional(),
    }),
    z.strictObject({
      action: z.literal('create-bot-entry'),
      botId: id,
      title: z.string().min(1).max(200).optional(),
      group: name.optional(),
    }),
    z.strictObject({
      action: z.literal('send-agent-message'),
      target: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('project'),
          projectId: id,
          taskId: id,
          chatId: id.optional(),
        }),
        z.strictObject({
          kind: z.literal('bot'),
          botId: id,
          taskId: id,
          chatId: id.optional(),
        }),
      ]),
      /** The text to send, `text_file` already read. */
      text: z.string().min(1).max(WORKER_PIPELINE_HOST_TEXT_MAX),
      mode: z.enum(['queue', 'steer']),
      settings: WorkerPipelineSendSettingsSchema,
      textReferences: z
        .array(WorkerPipelinePromptReferenceSchema)
        .max(1024)
        .optional(),
      /**
       * How many attachments the step sends. Their paths are host paths: the
       * worker contained them in the step's working folder, and they stay
       * on its host.
       */
      attachmentCount: z.number().int().min(1).max(1024).optional(),
      /**
       * A converted chat automation's composer payload (CAN-5479): absolute
       * attachment paths, their prompt contexts and legacy file references.
       * Each holds host paths, so only its count crosses.
       */
      attachmentPathCount: z.number().int().min(1).max(1024).optional(),
      attachmentPromptContextCount: z
        .number()
        .int()
        .min(1)
        .max(1024)
        .optional(),
      fileReferenceCount: z.number().int().min(1).max(1024).optional(),
      inputMode: z.enum(['typed', 'voice']).optional(),
      literalText: z.literal(true).optional(),
      replaceEmptyChat: z.literal(true).optional(),
      newChat: z.literal(true).optional(),
    }),
    z.strictObject({
      action: z.literal('wait-for-agent-reply'),
      chat: WorkerPipelineChatAddressSchema,
      messageId: id.optional(),
      replyTimeoutMinutes: z.number().positive().max(720),
    }),
    ...WORKER_PIPELINE_OWNER_REQUEST_MEMBERS,
  ],
);

/**
 * One host step the worker raises for core to settle (`runs.using: host`).
 * `requestId` is the step's idempotency key; core keys its effects by it.
 * Owner requests (`owner.*` actions, CAN-5095) use the same envelope; a call
 * that is not about one step uses `jobId` and `stepId` `_run`, `attempt` and
 * `iteration` 0.
 */
export const WorkerPipelineHostRequestSchema = z.strictObject({
  requestId: hostRequestId,
  executionId: id,
  jobId: id,
  stepId: id,
  childExecutionId: id.nullable(),
  attempt: z.number().int().min(0),
  iteration: z.number().int().min(0),
  /**
   * The run's owner; core checks every target against it. A run without one
   * is `personal`; `null` is an owner that isn't a workspace context, whose
   * project targets core refuses.
   */
  owner: PipelineRunOwnerSchema.nullable(),
  /** When the executor withdraws the call. */
  deadlineAt: timestamp,
  /** The inputs the executor parsed; absent optional inputs stay absent. */
  request: WorkerPipelineHostActionRequestSchema,
});

/**
 * A request the worker withdrew before it was settled (CAN-5771). Only a
 * worker that announces withdrawals sends it; a settling core stops applying
 * that request.
 */
export const WorkerPipelineHostWithdrawalSchema = z.strictObject({
  withdrawn: z.literal(true),
  executionId: id,
  requestId: hostRequestId,
});

/** One `worker.pipeline.hostRequests` item: a request, or its withdrawal. */
export const WorkerPipelineHostRequestsItemSchema = z.union([
  WorkerPipelineHostRequestSchema,
  WorkerPipelineHostWithdrawalSchema,
]);

export type WorkerPipelineHostWithdrawal = z.output<
  typeof WorkerPipelineHostWithdrawalSchema
>;
export type WorkerPipelineHostRequestsItem = z.output<
  typeof WorkerPipelineHostRequestsItemSchema
>;

export function isWorkerPipelineHostWithdrawal(
  item: WorkerPipelineHostRequestsItem,
): item is WorkerPipelineHostWithdrawal {
  return 'withdrawn' in item;
}

export const WorkerPipelineHostResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('success'),
    outputs: hostOutputs,
    chatSend: WorkerPipelineChatSendRecordSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('failure'),
    /** `null` for an unexpected host error, whose message is redacted. */
    failureReason: z.enum(WORKER_PIPELINE_HOST_FAILURE_REASONS).nullable(),
    message: z.string().min(1).max(WORKER_PIPELINE_ERROR_MAX_LENGTH),
    outputs: hostOutputs,
    /** A message the step sent before it failed, such as a refused steer. */
    chatSend: WorkerPipelineChatSendRecordSchema.optional(),
  }),
  z.strictObject({
    status: z.literal('owner'),
    value: WorkerPipelineOwnerResultSchema,
  }),
]);

export const WorkerPipelineHostRequestsParamsSchema = z.strictObject({
  /** The stream doesn't resume; a new subscriber gets every pending request. */
  cursor: z.null().optional(),
  _meta: CanopyQueryRequestMetadataSchema.optional(),
});

export const WorkerPipelineHostRequestsOpenResultSchema = z.strictObject({
  subscriptionId: id,
  acceptedCursor: z.null(),
});

export const WorkerPipelineHostRequestRespondParamsSchema = z.strictObject({
  executionId: id,
  requestId: hostRequestId,
  result: WorkerPipelineHostResultSchema,
});

export const WorkerPipelineHostRequestRespondResultSchema = z.strictObject({
  executionId: id,
  requestId: hostRequestId,
  /** `already_settled` when the step settled first, from a response or its timeout. */
  outcome: z.enum(['applied', 'already_settled']),
  settledAt: timestamp,
});

export const WorkerPipelineHostRequestErrorSchema =
  CanopyErrorPayloadSchema.extend({
    code: z.enum(['worker.pipeline.hostRequestNotFound']).optional(),
    retry: CanopyQueryRetryDirectiveSchema,
  });

export const WorkerPipelineHostRequestsEndSchema = CanopyStreamEndSchema.extend(
  { error: WorkerPipelineExecutionQueryErrorSchema.nullable() },
);

export type WorkerPipelineCancelMode =
  (typeof WORKER_PIPELINE_CANCEL_MODES)[number];
export type WorkerPipelineHostActionRequest = z.output<
  typeof WorkerPipelineHostActionRequestSchema
>;
export type WorkerPipelineHostRequest = z.output<
  typeof WorkerPipelineHostRequestSchema
>;
export type WorkerPipelineHostResult = z.output<
  typeof WorkerPipelineHostResultSchema
>;
export type WorkerPipelineHostRespondResult = z.output<
  typeof WorkerPipelineHostRequestRespondResultSchema
>;

export type WorkerPipelineExecution = z.output<
  typeof WorkerPipelineExecutionSchema
>;
export type WorkerPipelineExecutionStartParams = z.output<
  typeof WorkerPipelineExecutionStartParamsSchema
>;
export type WorkerPipelineExecutionResult = z.output<
  typeof WorkerPipelineExecutionResultSchema
>;
export type WorkerPipelineExecutionGetParams = z.output<
  typeof WorkerPipelineExecutionGetParamsSchema
>;
export type WorkerPipelineExecutionView = z.output<
  typeof WorkerPipelineExecutionViewSchema
>;
export type WorkerPipelineExecutionListParams = z.output<
  typeof WorkerPipelineExecutionListParamsSchema
>;
export type WorkerPipelineExecutionListResult = z.output<
  typeof WorkerPipelineExecutionListResultSchema
>;
export type WorkerPipelineExecutionCancelParams = z.output<
  typeof WorkerPipelineExecutionCancelParamsSchema
>;
export type WorkerPipelineExecutionEventsParams = z.output<
  typeof WorkerPipelineExecutionEventsParamsSchema
>;
export type WorkerPipelineExecutionEventsItem = z.output<
  typeof WorkerPipelineExecutionEventsItemSchema
>;
export type WorkerPipelinePauseResponse = z.output<
  typeof WorkerPipelinePauseResponseSchema
>;
export type WorkerPipelineExecutionResumeParams = z.output<
  typeof WorkerPipelineExecutionResumeParamsSchema
>;
export type WorkerPipelineExecutionRetryParams = z.output<
  typeof WorkerPipelineExecutionRetryParamsSchema
>;
export type WorkerPipelineMatrixJobRetryParams = z.output<
  typeof WorkerPipelineMatrixJobRetryParamsSchema
>;
export type WorkerPipelineMatrixVariantCancelParams = z.output<
  typeof WorkerPipelineMatrixVariantCancelParamsSchema
>;
export type WorkerPipelineControlOutcome =
  (typeof WORKER_PIPELINE_CONTROL_OUTCOMES)[number];
export type WorkerPipelineControlResult = z.output<
  typeof WorkerPipelineControlResultSchema
>;
export type WorkerPipelineRecoverySweepParams = z.output<
  typeof WorkerPipelineRecoverySweepParamsSchema
>;
export type WorkerPipelineRecoverySweepResult = z.output<
  typeof WorkerPipelineRecoverySweepResultSchema
>;
export type WorkerPipelineRecoveryCheckpointResult = z.output<
  typeof WorkerPipelineRecoveryCheckpointResultSchema
>;
export type WorkerPipelineExecutionCheckpointParams = z.output<
  typeof WorkerPipelineExecutionCheckpointParamsSchema
>;
export type WorkerPipelineDataArchive = z.output<
  typeof WorkerPipelineDataArchiveSchema
>;
export type WorkerPipelineDataImportParams = z.output<
  typeof WorkerPipelineDataImportParamsSchema
>;
export type WorkerPipelineDataImportResult = z.output<
  typeof WorkerPipelineDataImportResultSchema
>;
export type WorkerPipelineDataExportParams = z.output<
  typeof WorkerPipelineDataExportParamsSchema
>;
export type WorkerPipelineDataExportResult = z.output<
  typeof WorkerPipelineDataExportResultSchema
>;
export type WorkerPipelineHandoffArchive = z.output<
  typeof WorkerPipelineHandoffArchiveSchema
>;
export type WorkerPipelineExecutionHandoffExportParams = z.output<
  typeof WorkerPipelineExecutionHandoffExportParamsSchema
>;
export type WorkerPipelineExecutionHandoffExportResult = z.output<
  typeof WorkerPipelineExecutionHandoffExportResultSchema
>;
export type WorkerPipelineExecutionHandoffImportParams = z.output<
  typeof WorkerPipelineExecutionHandoffImportParamsSchema
>;
export type WorkerPipelineExecutionHandoffImportResult = z.output<
  typeof WorkerPipelineExecutionHandoffImportResultSchema
>;
export type WorkerPipelineTranscript = z.output<
  typeof WorkerPipelineTranscriptSchema
>;
export type WorkerPipelineExecutionTranscriptExportParams = z.output<
  typeof WorkerPipelineExecutionTranscriptExportParamsSchema
>;
export type WorkerPipelineExecutionTranscriptExportResult = z.output<
  typeof WorkerPipelineExecutionTranscriptExportResultSchema
>;
export type WorkerPipelineCapabilityDeliveryRef = z.output<
  typeof WorkerPipelineCapabilityDeliveryRefSchema
>;
export type WorkerPipelineCapabilityDelivery = z.output<
  typeof WorkerPipelineCapabilityDeliverySchema
>;
export type WorkerPipelineCapabilitiesImportParams = z.output<
  typeof WorkerPipelineCapabilitiesImportParamsSchema
>;
export type WorkerPipelineCapabilitiesImportResult = z.output<
  typeof WorkerPipelineCapabilitiesImportResultSchema
>;
export type WorkerPipelineExecutionStatus =
  (typeof WORKER_PIPELINE_EXECUTION_STATUSES)[number];

export const WORKER_PIPELINE_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.pipeline.execution.get': defineCanopyQuery({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionGetParamsSchema,
      result: WorkerPipelineExecutionGetResultSchema,
      error: WorkerPipelineExecutionQueryErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.read],
    }),
    'worker.pipeline.execution.list': defineCanopyQuery({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionListParamsSchema,
      result: WorkerPipelineExecutionListResultSchema,
      error: WorkerPipelineExecutionListErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.read],
    }),
  },
);

export const WORKER_PIPELINE_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.pipeline.execution.start': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionStartParamsSchema,
      result: WorkerPipelineExecutionResultSchema,
      error: WorkerPipelineExecutionErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.hostRequest.respond': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineHostRequestRespondParamsSchema,
      result: WorkerPipelineHostRequestRespondResultSchema,
      error: WorkerPipelineHostRequestErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.host],
    }),
    'worker.pipeline.execution.resume': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionResumeParamsSchema,
      result: WorkerPipelineControlResultSchema,
      error: WorkerPipelineControlErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.execution.retry': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionRetryParamsSchema,
      result: WorkerPipelineControlResultSchema,
      error: WorkerPipelineControlErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.matrixJob.retry': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineMatrixJobRetryParamsSchema,
      result: WorkerPipelineControlResultSchema,
      error: WorkerPipelineControlErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.matrixVariant.cancel': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineMatrixVariantCancelParamsSchema,
      result: WorkerPipelineControlResultSchema,
      error: WorkerPipelineControlErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.recovery.sweep': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineRecoverySweepParamsSchema,
      result: WorkerPipelineRecoverySweepResultSchema,
      error: WorkerPipelineRecoveryErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.recovery.checkpoint': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineRecoveryCheckpointParamsSchema,
      result: WorkerPipelineRecoveryCheckpointResultSchema,
      error: WorkerPipelineRecoveryErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.execution.cancel': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionCancelParamsSchema,
      result: WorkerPipelineExecutionResultSchema,
      error: WorkerPipelineExecutionCancelErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
  });

/**
 * The operations only a cloud runner serves (CAN-6199, CAN-6317, CAN-6376,
 * CAN-6421).
 * Desktop and the daemon pause their runs through
 * `worker.pipeline.recovery.checkpoint` and the owner-loss pause, and keep
 * pipeline data and their runs' execution directories on their own disk, so
 * these are not composed into the worker registry.
 */
export const WORKER_PIPELINE_RUNNER_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('worker', {
    'worker.pipeline.execution.checkpoint': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionCheckpointParamsSchema,
      result: WorkerPipelineExecutionResultSchema,
      error: WorkerPipelineExecutionCheckpointErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    // The pipeline's data, restored and saved by its owner (CAN-6317).
    'worker.pipeline.data.import': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineDataImportParamsSchema,
      result: WorkerPipelineDataImportResultSchema,
      error: WorkerPipelineDataErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.data.export': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineDataExportParamsSchema,
      result: WorkerPipelineDataExportResultSchema,
      error: WorkerPipelineDataErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    // One run's handoff between incarnations, moved by its owner (CAN-6376).
    'worker.pipeline.execution.handoff.export': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionHandoffExportParamsSchema,
      result: WorkerPipelineExecutionHandoffExportResultSchema,
      error: WorkerPipelineHandoffErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    'worker.pipeline.execution.handoff.import': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionHandoffImportParamsSchema,
      result: WorkerPipelineExecutionHandoffImportResultSchema,
      error: WorkerPipelineHandoffErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    // An agent step's transcript, kept by its owner as a run artifact (CAN-6421).
    'worker.pipeline.execution.transcript.export': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineExecutionTranscriptExportParamsSchema,
      result: WorkerPipelineExecutionTranscriptExportResultSchema,
      error: WorkerPipelineTranscriptErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
    // A run's skills, plugin trees and MCP servers, delivered by its owner
    // before the run's start (CAN-6439).
    'worker.pipeline.capabilities.import': defineCanopyInstruction({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      params: WorkerPipelineCapabilitiesImportParamsSchema,
      result: WorkerPipelineCapabilitiesImportResultSchema,
      error: WorkerPipelineCapabilitiesErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [WORKER_PIPELINE_GRANTS.write],
    }),
  });

export const WORKER_PIPELINE_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'worker',
  {
    'worker.pipeline.execution.events': defineCanopyStream({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.read],
      params: WorkerPipelineExecutionEventsParamsSchema,
      openResult: WorkerPipelineExecutionEventsOpenResultSchema,
      item: WorkerPipelineExecutionEventsItemSchema,
      end: WorkerPipelineExecutionEventsEndSchema,
      error: WorkerPipelineExecutionEventsErrorSchema,
    }),
    'worker.pipeline.hostRequests': defineCanopyStream({
      plane: 'worker',
      domain: 'pipeline',
      version: 1,
      placement: 'target-selectable',
      idempotency: 'inherent',
      requiredGrants: [WORKER_PIPELINE_GRANTS.host],
      params: WorkerPipelineHostRequestsParamsSchema,
      openResult: WorkerPipelineHostRequestsOpenResultSchema,
      item: WorkerPipelineHostRequestsItemSchema,
      end: WorkerPipelineHostRequestsEndSchema,
      error: WorkerPipelineExecutionQueryErrorSchema,
    }),
  },
);
