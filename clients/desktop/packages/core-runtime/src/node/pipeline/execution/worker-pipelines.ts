import {
  NO_EXECUTION_SECRETS,
  redeemExecutionSecrets,
  type ExecutionSecretSource,
  type RedeemedExecutionSecrets,
} from '../../execution-secrets';
import {
  WORKER_PIPELINE_NOTIFICATION_BODY_MAX_LENGTH,
  WORKER_PIPELINE_NOTIFICATION_TITLE_MAX_LENGTH,
  WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH,
  WORKER_PIPELINE_TERMINAL_STATUSES,
  type CanopyInstructionHandler,
  type CanopyQueryHandler,
  type CanopyStreamHandlerMap,
  type WorkerPipelineCancelMode,
  type WorkerPipelineControlResult,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionEventsItem,
  type WorkerPipelineExecutionListParams,
  type WorkerPipelineExecutionListResult,
  type WorkerPipelineExecutionResult,
  type WorkerPipelineExecutionResumeParams,
  type WorkerPipelineExecutionView,
  type WorkerPipelineExecutionRetryParams,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineMatrixJobRetryParams,
  type WorkerPipelineRecoveryCheckpointResult,
  type WorkerPipelineRecoverySweepParams,
  type WorkerPipelineRecoverySweepResult,
  type WorkerPipelineMatrixVariantCancelParams,
  type CanopyErrorPayload,
  type CanopyHostExecution,
  type CanopyStreamCursor,
  CANOPY_IN_PROCESS_WORKER_TARGET_ID,
  WORKER_PIPELINE_LIST_LIMIT_DEFAULT,
} from '@canopy/protocol/canopy-core';

import {
  CanopyOperationError,
  canopyInternalError,
  canopyInvalidArgumentError,
} from '../../../runtime/errors';
import type {
  CanopyHandlerContext,
  CanopyStreamSink,
} from '../../../runtime/types';
import type {
  PipelineEventJournal,
  PipelineEventJournalEntry,
} from './event-journal';

/** A desktop notification a step asked for (CAN-5868). */
export interface PipelineExecutionNotification {
  readonly stepId: string;
  readonly title: string;
  readonly body: string;
}

/** What a worker reports while one of its executions runs. */
export interface PipelineExecutionObserver {
  onExecution(event: string, execution: WorkerPipelineExecution): void;
  onOutput(output: {
    jobId: string;
    stepId: string;
    /** The retry attempt and job iteration that printed it, when known. */
    attempt?: number;
    iteration?: number;
    stream: 'stdout' | 'stderr';
    text: string;
  }): void;
  /** A desktop notification a step asked for (CAN-5868). */
  /** Whether this observer delivered it; one nobody delivers is kept for the next stream. */
  onNotification?(notification: PipelineExecutionNotification): boolean;
  /** The worker can no longer follow this execution, such as when its host process ended. */
  onEnd?(error: CanopyErrorPayload): void;
}

/** One recovery control (CAN-4141), by the instruction that carries it. */
export type PipelineControlRequest =
  | {
      operation: 'worker.pipeline.execution.resume';
      params: WorkerPipelineExecutionResumeParams;
    }
  | {
      operation: 'worker.pipeline.execution.retry';
      params: WorkerPipelineExecutionRetryParams;
    }
  | {
      operation: 'worker.pipeline.matrixJob.retry';
      params: WorkerPipelineMatrixJobRetryParams;
    }
  | {
      operation: 'worker.pipeline.matrixVariant.cancel';
      params: WorkerPipelineMatrixVariantCancelParams;
    };

export type PipelineControlOperation = PipelineControlRequest['operation'];

/** Where a list page starts: just after this execution in list order. */
export interface PipelineExecutionListPosition {
  readonly startedAt: string;
  readonly executionId: string;
}

/**
 * One `worker.pipeline.execution.list` page as a worker reads it (CAN-6117).
 * The handler has checked the target and decoded the cursor.
 */
export interface PipelineExecutionListQuery {
  readonly workspaceId?: string;
  readonly worktreeId?: string;
  readonly owner?: string;
  readonly pipelineId?: string;
  readonly runScopes?: readonly WorkerPipelineExecution['runScope'][];
  readonly statuses?: readonly WorkerPipelineExecution['status'][];
  readonly detail: boolean;
  readonly after: PipelineExecutionListPosition | null;
  readonly limit: number;
}

export interface PipelineExecutionListPage {
  /** Newest first: by start time, then by execution id, both descending. */
  readonly executions: readonly WorkerPipelineExecutionView[];
  /** More executions match after the last one. */
  readonly more: boolean;
}

/**
 * The trusted host side of `worker.pipeline.execution.*`: the executor, its
 * execution store and the launches core prepared. Every method speaks
 * portable projections; host paths and live handles stay on the host.
 */
export interface PipelineExecutionWorker {
  /**
   * The worker maps a start's `portableLaunch` to its own paths (CAN-6161),
   * as a cloud runner does. Every other worker is refused one before
   * {@link start} runs.
   */
  readonly portableLaunches?: boolean;
  /**
   * Admits a start before its secrets are redeemed (CAN-6161). Throws what
   * {@link start} would refuse, so a refusal the caller may retry with the
   * same key leaves the start's secret grant for that retry. Resolves the
   * run a resend joins, which answers without redeeming the grant again,
   * or `null` for a start to run.
   */
  admitStart?(
    params: WorkerPipelineExecutionStartParams,
    execution?: CanopyHostExecution,
  ): Promise<WorkerPipelineExecution | null>;
  /**
   * Takes a portable start sent again for a run the worker already holds
   * (CAN-6376), as a new runner incarnation does once its owner restored
   * the run there: the run is not started again, but the start becomes the
   * launch its recovery controls run with. Resolves the run as `stored`
   * holds it, without redeeming the start's secrets. Throws what
   * {@link start} would refuse, and when the stored run is another
   * workflow's. Without it, a held run answers as it is.
   */
  adoptStart?(
    params: WorkerPipelineExecutionStartParams,
    stored: WorkerPipelineExecution,
  ): Promise<WorkerPipelineExecution>;
  /**
   * Run the launch core prepared for this execution, once. Throws
   * {@link pipelineLaunchUnavailableError} when there is none, so a client
   * can never start a run core did not admit. Only a worker that runs
   * host-local launches reads `execution` (CAN-5086); only one with
   * {@link portableLaunches} reads `params.portableLaunch`.
   */
  start(
    params: WorkerPipelineExecutionStartParams,
    signal: AbortSignal,
    secrets: RedeemedExecutionSecrets,
    execution?: CanopyHostExecution,
  ): Promise<WorkerPipelineExecution>;
  /**
   * Run the recovery control core prepared under `params.requestId`, once.
   * Throws {@link pipelineLaunchUnavailableError} when there is none.
   */
  control(
    request: PipelineControlRequest,
    signal: AbortSignal,
    secrets: RedeemedExecutionSecrets,
  ): Promise<WorkerPipelineControlResult>;
  /**
   * Pause the executions among `params.executionIds` whose recorded owner
   * has exited, so they can resume (the startup orphan sweep).
   */
  sweep(
    params: WorkerPipelineRecoverySweepParams,
  ): Promise<WorkerPipelineRecoverySweepResult>;
  /**
   * Close admission and pause every live execution at a checkpoint before
   * the worker stops. Throws {@link pipelineCheckpointFailedError} when one
   * could not be paused.
   */
  checkpoint(params: {
    requestId: string;
  }): Promise<WorkerPipelineRecoveryCheckpointResult>;
  /** `null` when this worker has no such execution. */
  get(executionId: string): Promise<WorkerPipelineExecution | null>;
  /**
   * The summary with its detail projection (CAN-6117); `null` when this
   * worker has no such execution.
   */
  inspect(executionId: string): Promise<WorkerPipelineExecutionView | null>;
  /** One page of the executions this worker holds (CAN-6117). */
  list(query: PipelineExecutionListQuery): Promise<PipelineExecutionListPage>;
  /**
   * Throws {@link pipelineExecutionNotFoundError} for an unknown run, and
   * {@link PipelineDrainTimeoutError} when a drain's bounded wait ends first.
   */
  cancel(
    executionId: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<WorkerPipelineExecution>;
  /**
   * Live events for an execution, across every handle that runs it, such
   * as a resume's. `null` when the worker can't follow it.
   */
  observe(
    executionId: string,
    observer: PipelineExecutionObserver,
  ): (() => void) | null;
  /** Notifications the run sent before any stream followed it (CAN-5868). */
  takeNotifications?(
    executionId: string,
  ): readonly PipelineExecutionNotification[];
}

export function pipelineExecutionNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'worker.pipeline.executionNotFound',
    message: 'This workflow run does not exist.',
    retry: { kind: 'never' },
  });
}

export function pipelineLaunchUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.pipeline.launchUnavailable',
    message: 'Core has not prepared this workflow run.',
    retry: { kind: 'never' },
  });
}

export function pipelineLaunchRefusedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code: 'worker.pipeline.launchRefused',
    message: 'This workflow run cannot run in the background service.',
    retry: { kind: 'never' },
  });
}

/**
 * How long a remote owner waits before it retries a start refused
 * `ownerUnavailable`: about how long it takes to resubscribe to
 * `worker.pipeline.hostRequests` after it reconnects.
 */
export const PIPELINE_REMOTE_OWNER_RETRY_DELAY_MS = 1_000;

/**
 * An owner-bound start while no owner is subscribed (CAN-5771); nothing ran.
 * A local owner that is gone has exited, so the start is never retried. A
 * remote owner reaches the worker over a relay, where a missing subscription
 * is transient: it may retry the start with its idempotency key (CAN-6161),
 * unless the refusal came after the start's secrets were redeemed.
 */
export function pipelineOwnerUnavailableError(
  { retryable }: { readonly retryable: boolean } = { retryable: false },
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'unavailable',
    code: 'worker.pipeline.ownerUnavailable',
    message: 'The app is not connected to the background workflow service.',
    retry: retryable
      ? {
          kind: 'same_idempotency_key',
          delayMs: PIPELINE_REMOTE_OWNER_RETRY_DELAY_MS,
        }
      : { kind: 'never' },
  });
}

/**
 * A portable start (CAN-6161) to a worker that runs only launches its own
 * core prepared, or one that also carries a host-local launch.
 */
export function pipelinePortableLaunchRefusedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code: 'worker.pipeline.launchRefused',
    message: 'This worker does not run portable workflow starts.',
    retry: { kind: 'never' },
  });
}

export function pipelineModelStepsUnsupportedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    code: 'worker.pipeline.modelStepsUnsupported',
    message:
      'This workflow has steps that call a model, so it runs in the app.',
    retry: { kind: 'never' },
  });
}

export function pipelineHostUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'unavailable',
    code: 'worker.pipeline.hostUnavailable',
    message: 'The background workflow service could not start.',
    retry: { kind: 'never' },
  });
}

export function pipelineHostLostError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'unavailable',
    code: 'worker.pipeline.hostLost',
    message:
      'The background workflow service stopped while this run was in progress.',
    retry: { kind: 'never' },
  });
}

/** A list cursor this worker never issued. */
export function pipelineInvalidCursorError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'invalid_argument',
    code: 'worker.pipeline.invalidCursor',
    message: 'This page of workflow runs is no longer available.',
    retry: { kind: 'never' },
  });
}

/**
 * An events cursor this worker cannot resume (CAN-6161): another epoch's,
 * older than its journal keeps, or sent to a worker that keeps none. The
 * caller reads the run again and reopens the stream without a cursor.
 */
export function pipelineSnapshotRequiredError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.pipeline.snapshotRequired',
    message:
      "This workflow run's earlier events are no longer available. Read the run again.",
    retry: { kind: 'after_refresh', resource: 'worker.pipeline.execution' },
  });
}

/** A list that selected an execution target this worker isn't. */
export function pipelineTargetUnavailableError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    code: 'worker.pipeline.targetUnavailable',
    message: 'The selected workflow worker is unavailable.',
    retry: { kind: 'never' },
  });
}

/** The opaque cursor of the page after `position`. */
export function encodePipelineListCursor(
  position: PipelineExecutionListPosition,
): string {
  return Buffer.from(
    JSON.stringify([position.startedAt, position.executionId]),
  ).toString('base64url');
}

/** Throws {@link pipelineInvalidCursorError} for a cursor this module didn't encode. */
export function decodePipelineListCursor(
  cursor: string,
): PipelineExecutionListPosition {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw pipelineInvalidCursorError();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    Number.isNaN(Date.parse(value[0])) ||
    typeof value[1] !== 'string' ||
    value[1].length === 0 ||
    value[1].length > 512
  )
    throw pipelineInvalidCursorError();
  return { startedAt: value[0], executionId: value[1] };
}

/** Builds the worker's query from validated list params (CAN-6117). */
export function pipelineListQueryOf(
  params: WorkerPipelineExecutionListParams,
  targetId: string,
): PipelineExecutionListQuery {
  const { scope } = params;
  if (scope?.targetId !== undefined && scope.targetId !== targetId)
    throw pipelineTargetUnavailableError();
  return {
    ...(scope?.workspaceId !== undefined && {
      workspaceId: scope.workspaceId,
    }),
    ...(scope?.worktreeId !== undefined && { worktreeId: scope.worktreeId }),
    ...(params.owner !== undefined && { owner: params.owner }),
    ...(params.pipelineId !== undefined && { pipelineId: params.pipelineId }),
    ...(params.runScopes !== undefined && { runScopes: params.runScopes }),
    ...(params.statuses !== undefined && { statuses: params.statuses }),
    detail: params.detail === true,
    after:
      params.cursor === undefined
        ? null
        : decodePipelineListCursor(params.cursor),
    limit: params.limit ?? WORKER_PIPELINE_LIST_LIMIT_DEFAULT,
  };
}

/** The list result for one page a worker read. */
export function pipelineListResultOf(
  page: PipelineExecutionListPage,
): WorkerPipelineExecutionListResult {
  const last = page.executions[page.executions.length - 1];
  return {
    executions: [...page.executions],
    nextCursor:
      page.more && last
        ? encodePipelineListCursor({
            startedAt: last.execution.startedAt,
            executionId: last.execution.executionId,
          })
        : null,
  };
}

/** A drain whose bounded wait ended with the run still stopping. */
export class PipelineDrainTimeoutError extends Error {
  constructor() {
    super('The workflow run is still stopping.');
    this.name = 'PipelineDrainTimeoutError';
  }
}

export function pipelineDrainTimedOutError(
  cause: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'deadline_exceeded',
      code: 'worker.pipeline.drainTimedOut',
      message: 'The workflow run is still stopping.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** A start the executor refused; its message stays in host diagnostics. */
export function pipelineStartFailedError(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: 'worker.pipeline.startFailed',
      message: 'The workflow run could not start.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** A control the executor refused; its message stays in host diagnostics. */
export function pipelineControlFailedError(
  cause: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: 'worker.pipeline.controlFailed',
      message: 'The workflow run could not be changed.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** A shutdown checkpoint that left a live execution unpaused. */
export function pipelineCheckpointFailedError(
  cause: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'failed_precondition',
      code: 'worker.pipeline.checkpointFailed',
      message: 'Some workflow runs could not be paused.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

/**
 * A pipeline data import or export while a run of that pipeline is running
 * on the runner (CAN-6317): its files may be mid-write. Also an import
 * while another import of it unpacks, or after a start used its data on
 * this incarnation. Checkpoint the run or let it end, then call again with
 * a new key.
 */
export function pipelineDataBusyError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.pipeline.dataBusy',
    message: "This workflow's data is in use by a run or a restore.",
    retry: { kind: 'never' },
  });
}

/**
 * A pipeline data archive the runner refuses (CAN-6317): over its limit, a
 * chunk out of order, a digest that does not match, or an entry that would
 * leave the data folder.
 */
export function pipelineDataRefusedError(
  message: string,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'invalid_argument',
      code: 'worker.pipeline.dataRefused',
      message,
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** An export that continues a snapshot the runner no longer holds (CAN-6317). */
export function pipelineDataSnapshotGoneError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.pipeline.dataSnapshotGone',
    message: "This workflow's data snapshot is gone. Export it again.",
    retry: { kind: 'never' },
  });
}

/**
 * A run handoff export or import while the run is pending or running on the
 * runner (CAN-6376): its state still moves. Also an import while another
 * import of the run unpacks. Checkpoint the run first, then call again with
 * a new key.
 */
export function pipelineHandoffBusyError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.pipeline.handoffBusy',
    message: 'This workflow run is running or being restored.',
    retry: { kind: 'never' },
  });
}

/**
 * A run handoff the runner refuses (CAN-6376): over its limit, a chunk out
 * of order, a digest that does not match, an archive that holds anything
 * but the named run and its sessions, or an import once the lease ended.
 */
export function pipelineHandoffRefusedError(
  message: string,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'invalid_argument',
      code: 'worker.pipeline.handoffRefused',
      message,
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** A handoff export that continues a snapshot the runner no longer holds (CAN-6376). */
export function pipelineHandoffSnapshotGoneError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.pipeline.handoffSnapshotGone',
    message: "This workflow run's handoff snapshot is gone. Export it again.",
    retry: { kind: 'never' },
  });
}

/** A transcript export of a step that recorded none (CAN-6421). */
export function pipelineTranscriptNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'worker.pipeline.transcriptNotFound',
    message: 'This step has no transcript.',
    retry: { kind: 'never' },
  });
}

/** A transcript over its limit, or one that is not a file of the run (CAN-6421). */
export function pipelineTranscriptRefusedError(
  message: string,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'invalid_argument',
      code: 'worker.pipeline.transcriptRefused',
      message,
      retry: { kind: 'never' },
    },
    cause,
  );
}

/**
 * A capability delivery over its limit, out of order or not matching its
 * digest, or a bundle or blob that fails its checks (CAN-6439).
 */
export function pipelineCapabilitiesRefusedError(
  message: string,
  cause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'invalid_argument',
      code: 'worker.pipeline.capabilitiesRefused',
      message,
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** A transcript export that continues a transcript that changed since (CAN-6421). */
export function pipelineTranscriptSnapshotGoneError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.pipeline.transcriptSnapshotGone',
    message: "This step's transcript changed. Export it again.",
    retry: { kind: 'never' },
  });
}

const TERMINAL: ReadonlySet<string> = new Set(
  WORKER_PIPELINE_TERMINAL_STATUSES,
);

export function isTerminalPipelineExecution(
  execution: WorkerPipelineExecution,
): boolean {
  return TERMINAL.has(execution.status);
}

/**
 * Output budget for one events subscription: at most `items` output items
 * per `windowMs`. Output past it is dropped and counted into the next `gap`
 * item; lifecycle items never count against it.
 */
export interface PipelineOutputBudget {
  readonly items: number;
  readonly windowMs: number;
  /**
   * The most frames a slow consumer may have waiting before output is
   * dropped, well under the dispatcher's buffer, so lifecycle and terminal
   * items always fit.
   */
  readonly backlog: number;
}

/**
 * The most portable starts (CAN-6161), and resumes and retries (CAN-6103),
 * whose receipts a worker keeps for keyed resends; a runner serves one
 * delegation's runs.
 */
const PORTABLE_START_RECEIPTS_MAX = 1_024;

/** How often a held update retries while the consumer is behind. */
const HELD_UPDATE_RETRY_MS = 50;

export const DEFAULT_PIPELINE_OUTPUT_BUDGET: PipelineOutputBudget = {
  items: 200,
  windowMs: 1_000,
  backlog: 256,
};

export interface WorkerPipelineHandlers {
  queries: {
    'worker.pipeline.execution.get': CanopyQueryHandler<
      'worker.pipeline.execution.get',
      CanopyHandlerContext
    >;
    'worker.pipeline.execution.list': CanopyQueryHandler<
      'worker.pipeline.execution.list',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'worker.pipeline.execution.start': CanopyInstructionHandler<
      'worker.pipeline.execution.start',
      CanopyHandlerContext
    >;
    'worker.pipeline.execution.cancel': CanopyInstructionHandler<
      'worker.pipeline.execution.cancel',
      CanopyHandlerContext
    >;
    'worker.pipeline.recovery.sweep': CanopyInstructionHandler<
      'worker.pipeline.recovery.sweep',
      CanopyHandlerContext
    >;
    'worker.pipeline.recovery.checkpoint': CanopyInstructionHandler<
      'worker.pipeline.recovery.checkpoint',
      CanopyHandlerContext
    >;
  } & {
    [N in PipelineControlOperation]: CanopyInstructionHandler<
      N,
      CanopyHandlerContext
    >;
  };
  streams: Pick<
    CanopyStreamHandlerMap<CanopyHandlerContext>,
    'worker.pipeline.execution.events'
  >;
}

/** `worker.pipeline.execution.*` over one worker host (CAN-4140). */
export function createWorkerPipelineHandlers(
  worker: PipelineExecutionWorker,
  options: {
    secrets: ExecutionSecretSource;
    budget?: PipelineOutputBudget;
    now?: () => number;
    /** The execution target this worker serves; a list naming another is refused. */
    targetId?: string;
    /**
     * The worker's event journal (CAN-6161), as a cloud runner keeps one:
     * events streams number their items with it and resume after a cursor.
     * Without it a stream given a cursor answers snapshotRequired.
     */
    journal?: PipelineEventJournal;
  },
): WorkerPipelineHandlers {
  const budget = options.budget ?? DEFAULT_PIPELINE_OUTPUT_BUDGET;
  const now = options.now ?? Date.now;
  /** Each portable start this worker took, by execution id (CAN-6161). */
  const portableStarts = new Map<string, Promise<WorkerPipelineExecution>>();
  const targetId = options.targetId ?? CANOPY_IN_PROCESS_WORKER_TARGET_ID;
  /** Each resume or retry a portable worker took, by request id (CAN-6103). */
  const controls = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly result: Promise<WorkerPipelineControlResult>;
    }
  >();
  const redeemedControl = async (
    request: Extract<
      PipelineControlRequest,
      {
        operation:
          | 'worker.pipeline.execution.resume'
          | 'worker.pipeline.execution.retry';
      }
    >,
    signal: AbortSignal,
  ): Promise<WorkerPipelineControlResult> =>
    worker.control(
      request,
      signal,
      await redeemExecutionSecrets(
        options.secrets,
        { operation: request.operation, key: request.params.requestId },
        request.params.secrets,
        signal,
      ),
    );
  /**
   * A resume or retry, once per request id on a worker that maps portable
   * starts (CAN-6103): a remote caller resends a keyed control when a reply
   * is lost, and the resend joins the first, which redeemed the one-shot
   * secret grant. Any other worker runs each as it comes; its core keeps
   * the receipts.
   */
  const controlOnce = async (
    request: Parameters<typeof redeemedControl>[0],
    signal: AbortSignal,
  ): Promise<WorkerPipelineControlResult> => {
    if (worker.portableLaunches !== true)
      return redeemedControl(request, signal);
    const { requestId } = request.params;
    const fingerprint = JSON.stringify(request);
    const receipt = controls.get(requestId);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw canopyInvalidArgumentError(
          'This workflow control was already requested with other details.',
        );
      return receipt.result;
    }
    const result = redeemedControl(request, signal);
    controls.set(requestId, { fingerprint, result });
    const oldest = controls.keys().next();
    if (controls.size > PORTABLE_START_RECEIPTS_MAX && !oldest.done)
      controls.delete(oldest.value);
    try {
      return await result;
    } catch (error) {
      // A refused or failed control changed nothing; a retry runs it again.
      if (controls.get(requestId)?.result === result)
        controls.delete(requestId);
      throw error;
    }
  };
  return {
    queries: {
      'worker.pipeline.execution.get': async ({
        executionId,
        detail,
      }): Promise<WorkerPipelineExecutionView> => {
        if (detail) {
          const view = await worker.inspect(executionId);
          if (!view) throw pipelineExecutionNotFoundError();
          return view;
        }
        const execution = await worker.get(executionId);
        if (!execution) throw pipelineExecutionNotFoundError();
        return { execution };
      },
      'worker.pipeline.execution.list': async (
        params,
      ): Promise<WorkerPipelineExecutionListResult> =>
        pipelineListResultOf(
          await worker.list(pipelineListQueryOf(params, targetId)),
        ),
    },
    instructions: {
      'worker.pipeline.execution.start': async (
        params,
        { signal, execution },
      ): Promise<WorkerPipelineExecutionResult> => {
        // A start runs one launch: the portable one only where the worker maps it.
        if (
          params.portableLaunch !== undefined &&
          (worker.portableLaunches !== true ||
            execution?.pipelineLaunch !== undefined)
        )
          throw pipelinePortableLaunchRefusedError();
        const startOnce = async (): Promise<WorkerPipelineExecution> => {
          // A resend joins its run; its grant was redeemed by the first start.
          const joined = await worker.admitStart?.(params, execution);
          if (joined) return joined;
          return worker.start(
            params,
            signal,
            await redeemExecutionSecrets(
              options.secrets,
              {
                operation: 'worker.pipeline.execution.start',
                key: params.executionId,
              },
              params.secrets,
              signal,
            ),
            execution,
          );
        };
        if (params.portableLaunch === undefined)
          return { execution: await startOnce() };
        // A remote caller resends a keyed start when a reply is lost: while
        // the first is still redeeming, or after its run settled. Either
        // joins the first start, which redeemed the one-shot grant.
        const { executionId } = params;
        const receipt = portableStarts.get(executionId);
        if (receipt) {
          const first = await receipt;
          return { execution: (await worker.get(executionId)) ?? first };
        }
        // Without a receipt (evicted, or a new incarnation its owner
        // restored the run on), a run the worker already holds answers as it
        // is, and the worker takes the start as that run's (CAN-6376):
        // nothing runs twice, and no secret is redeemed for it.
        const run = (async (): Promise<WorkerPipelineExecution> => {
          const held = await worker.get(executionId);
          if (!held) return startOnce();
          return worker.adoptStart ? worker.adoptStart(params, held) : held;
        })();
        portableStarts.set(executionId, run);
        const oldest = portableStarts.keys().next();
        if (portableStarts.size > PORTABLE_START_RECEIPTS_MAX && !oldest.done)
          portableStarts.delete(oldest.value);
        try {
          return { execution: await run };
        } catch (error) {
          // A refused or failed start ran nothing; a retry starts again.
          if (portableStarts.get(executionId) === run)
            portableStarts.delete(executionId);
          throw error;
        }
      },
      'worker.pipeline.execution.resume': (params, { signal }) =>
        controlOnce(
          { operation: 'worker.pipeline.execution.resume', params },
          signal,
        ),
      'worker.pipeline.execution.retry': (params, { signal }) =>
        controlOnce(
          { operation: 'worker.pipeline.execution.retry', params },
          signal,
        ),
      'worker.pipeline.matrixJob.retry': async (params, { signal }) =>
        worker.control(
          { operation: 'worker.pipeline.matrixJob.retry', params },
          signal,
          await redeemExecutionSecrets(
            options.secrets,
            {
              operation: 'worker.pipeline.matrixJob.retry',
              key: params.requestId,
            },
            params.secrets,
            signal,
          ),
        ),
      'worker.pipeline.matrixVariant.cancel': (params, { signal }) =>
        worker.control(
          { operation: 'worker.pipeline.matrixVariant.cancel', params },
          signal,
          NO_EXECUTION_SECRETS,
        ),
      'worker.pipeline.recovery.sweep': (params) => worker.sweep(params),
      'worker.pipeline.recovery.checkpoint': (params) =>
        worker.checkpoint(params),
      'worker.pipeline.execution.cancel': async ({
        executionId,
        mode = 'finalize',
      }): Promise<WorkerPipelineExecutionResult> => {
        try {
          return { execution: await worker.cancel(executionId, mode) };
        } catch (error) {
          if (error instanceof PipelineDrainTimeoutError)
            throw pipelineDrainTimedOutError(error);
          throw error;
        }
      },
    },
    streams: {
      'worker.pipeline.execution.events': async (
        { executionId, cursor },
        context,
        sink,
      ): Promise<(() => void) | void> => {
        if (options.journal) {
          // The dispatcher's sink numbers items by the journal's cursors.
          if (!isCursorSink(sink)) throw canopyInternalError();
          const served = await serveJournaledEvents({
            worker,
            journal: options.journal,
            executionId,
            cursor: cursor ?? null,
            context,
            sink,
            budget,
            now,
          });
          if (served !== 'untracked') return served;
        } else if (cursor) {
          sink.end('error', pipelineSnapshotRequiredError().payload);
          return;
        }
        let ended = false;
        let stop: (() => void) | null = null;
        let retry: ReturnType<typeof setTimeout> | null = null;
        const cancelRetry = (): void => {
          if (retry !== null) clearTimeout(retry);
          retry = null;
        };
        const finish = (): void => {
          if (ended) return;
          ended = true;
          cancelRetry();
          stop?.();
          sink.end('completed');
        };
        const emit = (item: WorkerPipelineExecutionEventsItem): boolean => {
          if (ended) return false;
          if (sink.emit(item) !== null) return true;
          ended = true;
          stop?.();
          return false;
        };
        let windowStart = now();
        let windowItems = 0;
        let dropped = 0;
        const flushGap = (): void => {
          if (dropped === 0) return;
          emit({ kind: 'gap', droppedOutputItems: dropped });
          dropped = 0;
        };
        let lastStatus: WorkerPipelineExecution['status'] | null = null;
        // The latest update held back while a slow consumer has a backlog.
        let heldUpdate: {
          event: string;
          execution: WorkerPipelineExecution;
        } | null = null;
        const backlogged = (): boolean =>
          (sink.buffered?.() ?? 0) >= budget.backlog;
        const deliver = (
          event: string,
          execution: WorkerPipelineExecution,
        ): void => {
          flushGap();
          lastStatus = execution.status;
          emit({ kind: 'execution', event, execution });
          if (isTerminalPipelineExecution(execution)) finish();
        };
        const flushHeld = (): void => {
          if (ended || heldUpdate === null) return;
          // The consumer drains without telling the handler, so a held
          // update retries until it fits, with or without more output.
          if (backlogged()) {
            retry ??= setTimeout(() => {
              retry = null;
              flushHeld();
            }, HELD_UPDATE_RETRY_MS);
            return;
          }
          cancelRetry();
          const { event, execution } = heldUpdate;
          heldUpdate = null;
          deliver(event, execution);
        };
        // Updates coalesce into the latest while the consumer is behind;
        // every other lifecycle item, and the terminal one, always goes.
        const onExecution = (
          event: string,
          execution: WorkerPipelineExecution,
        ): void => {
          if (ended) return;
          if (event === 'execution.updated' && backlogged()) {
            heldUpdate = { event, execution };
            flushHeld();
            return;
          }
          heldUpdate = null;
          cancelRetry();
          deliver(event, execution);
        };
        // Never budgeted or dropped, like a lifecycle item.
        const emitNotification = ({
          stepId,
          title,
          body,
        }: PipelineExecutionNotification): boolean => {
          if (ended || context.signal.aborted) return false;
          flushGap();
          return emit({
            kind: 'notification',
            stepId,
            title: title.slice(
              0,
              WORKER_PIPELINE_NOTIFICATION_TITLE_MAX_LENGTH,
            ),
            body: body.slice(0, WORKER_PIPELINE_NOTIFICATION_BODY_MAX_LENGTH),
          });
        };
        let observed = false;
        const current = await worker.get(executionId);
        if (!current) {
          sink.end('error', pipelineExecutionNotFoundError().payload);
          return;
        }
        // A stream cancelled meanwhile leaves them for the next one.
        if (context.signal.aborted) return;
        // What the run sent before this stream, ahead of a terminal snapshot.
        for (const notification of worker.takeNotifications?.(executionId) ??
          [])
          emitNotification(notification);
        onExecution('snapshot', current);
        if (ended) return;
        stop = worker.observe(executionId, {
          onExecution: (event, execution) => {
            observed = true;
            onExecution(event, execution);
          },
          onOutput: ({ jobId, stepId, attempt, iteration, stream, text }) => {
            if (ended) return;
            flushHeld();
            const at = now();
            if (at - windowStart >= budget.windowMs) {
              windowStart = at;
              windowItems = 0;
            }
            if (
              windowItems >= budget.items ||
              (sink.buffered?.() ?? 0) >= budget.backlog
            ) {
              dropped += 1;
              return;
            }
            windowItems += 1;
            flushGap();
            const truncated =
              text.length > WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH;
            emit({
              kind: 'output',
              jobId,
              stepId,
              ...(attempt !== undefined && { attempt }),
              ...(iteration !== undefined && { iteration }),
              stream,
              text: truncated
                ? text.slice(0, WORKER_PIPELINE_OUTPUT_ITEM_MAX_LENGTH)
                : text,
              truncated,
            });
          },
          onNotification: (notification) => {
            if (ended) return false;
            flushHeld();
            return emitNotification(notification);
          },
          onEnd: (error) => {
            if (ended) return;
            ended = true;
            cancelRetry();
            stop?.();
            sink.end('error', error);
          },
        });
        if (stop === null) {
          // It settled between the snapshot and the subscription.
          const settled = await worker.get(executionId);
          if (settled) onExecution('snapshot', settled);
          finish();
          return;
        }
        // It may have paused or settled between the snapshot and the
        // subscription; an event the subscription already saw is newer.
        const latest = await worker.get(executionId);
        if (latest && !observed && latest.status !== lastStatus)
          onExecution('snapshot', latest);
        if (context.signal.aborted) stop();
        return () => {
          ended = true;
          cancelRetry();
          stop?.();
        };
      },
    },
  };
}

type EventsSink = Pick<
  CanopyStreamSink<WorkerPipelineExecutionEventsItem>,
  'buffered' | 'emit' | 'end'
>;

/** Whether the stream's sink takes source cursors, as the dispatcher's does. */
function isCursorSink(
  sink: EventsSink,
): sink is EventsSink &
  Pick<CanopyStreamSink<WorkerPipelineExecutionEventsItem>, 'emitAt'> {
  return 'emitAt' in sink && typeof sink.emitAt === 'function';
}

/**
 * One queued delivery of a journaled stream: an entry, live output dropped
 * while the consumer was behind (counted, at the last one's cursor), or the
 * run's end.
 */
type JournaledDelivery =
  | { readonly entry: PipelineEventJournalEntry; readonly live: boolean }
  | { dropped: number; at: CanopyStreamCursor }
  | { readonly end: CanopyErrorPayload | null };

/**
 * How many journals' worth of deliveries one journaled stream holds for a
 * slow consumer: room for a full journal's replay and as much again live,
 * whatever the journal keeps (a runner's keeps 8,192 items). Past it the
 * stream ends `snapshotRequired`; dropped output counts once per run of
 * drops.
 */
const JOURNALED_QUEUE_JOURNALS = 2;

/**
 * `worker.pipeline.execution.events` over the worker's event journal
 * (CAN-6161). Every item goes out at its journal cursor. A stream opened
 * with a cursor replays what followed it; one opened without starts with
 * the notifications no stream received and a journaled snapshot. Replayed
 * items wait for a slow consumer; live output keeps the output budget, as
 * the stream without a journal does.
 */
async function serveJournaledEvents({
  worker,
  journal,
  executionId,
  cursor,
  context,
  sink,
  budget,
  now,
}: {
  worker: PipelineExecutionWorker;
  journal: PipelineEventJournal;
  executionId: string;
  cursor: CanopyStreamCursor | null;
  context: CanopyHandlerContext;
  sink: Pick<
    CanopyStreamSink<WorkerPipelineExecutionEventsItem>,
    'buffered' | 'emitAt' | 'end'
  >;
  budget: PipelineOutputBudget;
  now: () => number;
}): Promise<'untracked' | (() => void) | void> {
  // The journal's own view of the run is the stream's; this read only checks it exists.
  if (!(await worker.get(executionId))) {
    sink.end('error', pipelineExecutionNotFoundError().payload);
    return;
  }
  if (context.signal.aborted) return;
  const queue: JournaledDelivery[] =
    cursor === null
      ? journal
          .undelivered(executionId)
          .map((entry) => ({ entry, live: false }))
      : [];
  let ended = false;
  let opening = true;
  let unsubscribe: (() => void) | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let windowStart = now();
  let windowItems = 0;
  let dropped = 0;
  let droppedAt: CanopyStreamCursor | null = null;
  const close = (): void => {
    ended = true;
    if (retry !== null) clearTimeout(retry);
    retry = null;
    unsubscribe?.();
  };
  const emit = (
    at: CanopyStreamCursor,
    item: WorkerPipelineExecutionEventsItem,
  ): boolean => {
    if (ended) return false;
    if (sink.emitAt(at, item) !== null) return true;
    close();
    return false;
  };
  const flushGap = (): boolean => {
    if (dropped === 0 || droppedAt === null) return true;
    const ok = emit(droppedAt, { kind: 'gap', droppedOutputItems: dropped });
    dropped = 0;
    droppedAt = null;
    return ok;
  };
  const backlogged = (): boolean => (sink.buffered?.() ?? 0) >= budget.backlog;
  const pump = (): void => {
    while (!ended && !opening && queue.length > 0) {
      const next = queue[0];
      if ('end' in next) {
        if (!flushGap()) return;
        close();
        if (next.end) sink.end('error', next.end);
        else sink.end('completed');
        return;
      }
      if ('dropped' in next) {
        queue.shift();
        dropped += next.dropped;
        droppedAt = next.at;
        continue;
      }
      const { entry, live } = next;
      const item = entry.event;
      if (item.kind === 'output' && live) {
        const at = now();
        if (at - windowStart >= budget.windowMs) {
          windowStart = at;
          windowItems = 0;
        }
        if (windowItems >= budget.items || backlogged()) {
          queue.shift();
          dropped += 1;
          droppedAt = entry.cursor;
          continue;
        }
        windowItems += 1;
      } else if (backlogged()) {
        // The consumer drains without telling the handler; try again shortly.
        retry ??= setTimeout(() => {
          retry = null;
          pump();
        }, HELD_UPDATE_RETRY_MS);
        return;
      }
      queue.shift();
      if (!flushGap() || !emit(entry.cursor, item)) return;
      if (item.kind === 'notification')
        journal.delivered(executionId, entry.cursor);
      if (
        item.kind === 'execution' &&
        isTerminalPipelineExecution(item.execution)
      ) {
        close();
        sink.end('completed');
        return;
      }
    }
  };
  /** Queues a live entry; a consumer far behind sheds output, then needs a snapshot. */
  const enqueueLive = (entry: PipelineEventJournalEntry): void => {
    if (entry.event.kind === 'output' && queue.length >= budget.backlog) {
      const last = queue[queue.length - 1];
      if ('dropped' in last) {
        last.dropped += 1;
        last.at = entry.cursor;
      } else queue.push({ dropped: 1, at: entry.cursor });
      return;
    }
    if (queue.length >= JOURNALED_QUEUE_JOURNALS * journal.maxEntries) {
      queue.length = 0;
      queue.push({ end: pipelineSnapshotRequiredError().payload });
    } else queue.push({ entry, live: true });
  };
  const opened = journal.open(executionId, cursor, {
    entry: (entry) => {
      if (opening) queue.push({ entry, live: false });
      else enqueueLive(entry);
      pump();
    },
    end: (error) => {
      queue.push({ end: error });
      pump();
    },
  });
  if (opened.kind === 'untracked') return 'untracked';
  if (opened.kind === 'snapshot_required') {
    sink.end('error', pipelineSnapshotRequiredError().payload);
    return;
  }
  unsubscribe = opened.unsubscribe;
  // Without a cursor the journal sent its snapshot first; a run that
  // already finished ends after it.
  if (opened.ended) queue.push({ end: opened.ended.error });
  opening = false;
  pump();
  if (context.signal.aborted) close();
  return close;
}
