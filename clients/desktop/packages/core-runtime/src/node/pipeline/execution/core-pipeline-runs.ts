import { executionSecretFingerprints } from '../../execution-secrets';
import { createHash, randomUUID } from 'node:crypto';

import {
  OPERATION_TERMINAL_STATUSES,
  WorkerPipelineControlResultSchema,
  WorkerPipelineExecutionResultSchema,
  WorkerPipelineRecoveryCheckpointResultSchema,
  WorkerPipelineRecoverySweepResultSchema,
  type CanopyErrorPayload,
  type OperationFailure,
  type OperationOrigin,
  type OperationOwner,
  type WorkerPipelineCancelMode,
  type WorkerPipelineControlOutcome,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineRecoveryCheckpointResult,
  type WorkerPipelineRecoverySweepResult,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';

import { canopyInvalidArgumentError } from '../../../runtime/errors';
import type {
  LocalWorkerDispatchResult,
  LocalWorkerExecution,
} from '../../operations/local-worker';
import type { OperationAcceptResult } from '../../operations/ledger';
import type { OperationService } from '../../operations/service';
import {
  isTerminalPipelineExecution,
  type PipelineControlRequest,
  type PipelineExecutionWorker,
} from './worker-pipelines';

/** One pipeline run; its worker requests are its children. */
export const CORE_PIPELINE_RUN_KIND = 'core.pipeline.run';
/** A cancel of a run this process did not start, such as a resumed one. */
export const CORE_PIPELINE_CANCEL_KIND = 'core.pipeline.cancel';
/**
 * One recovery control (CAN-4141), receipted by its request id: a child of
 * the run it acts in, whose worker dispatch is its own child.
 */
export const CORE_PIPELINE_CONTROL_KIND = 'core.pipeline.control';
/** The startup orphan sweep or the shutdown checkpoint (CAN-4141). */
export const CORE_PIPELINE_RECOVERY_KIND = 'core.pipeline.recovery';
const WORKER_SWEEP = 'worker.pipeline.recovery.sweep';
const WORKER_CHECKPOINT = 'worker.pipeline.recovery.checkpoint';
const SYSTEM = 'local-desktop-runtime';
const WORKER_START = 'worker.pipeline.execution.start';
/** Whose receipts a sweep's or checkpoint's operation records. */
const RECOVERY_RECEIPT_CALLER = 'core.pipeline.recovery';
/** Whose receipts a control's own operation records. */
const CONTROL_RECEIPT_CALLER = 'core.pipeline.control';

function digest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableStringify(value) ?? 'null')
    .digest('hex')}`;
}
const WORKER_CANCEL = 'worker.pipeline.execution.cancel';

const OUTCOME_UNKNOWN: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.outcomeUnknown',
  message: 'The local worker did not report how this workflow request ended.',
  retry: { kind: 'never' },
};

const TERMINAL_OPERATION_STATUSES: ReadonlySet<string> = new Set(
  OPERATION_TERMINAL_STATUSES,
);

const RUN_FAILED: CanopyErrorPayload = {
  kind: 'failed_precondition',
  message: 'The workflow run failed.',
  retry: { kind: 'never' },
};

function isPlaneQualifiedCode(
  code: string,
): code is `core.${string}.${string}` | `worker.${string}.${string}` {
  return /^(core|worker)\.[^.]+\..+$/.test(code);
}

/** A recorded failure as an error payload, keeping a plane-qualified code. */
function toErrorPayload(failure: OperationFailure | null): CanopyErrorPayload {
  if (!failure) return OUTCOME_UNKNOWN;
  const { code, ...rest } = failure;
  return code !== undefined && isPlaneQualifiedCode(code)
    ? { ...rest, code }
    : rest;
}

export interface CorePipelineStartRequest {
  params: WorkerPipelineExecutionStartParams;
  /** What started the run: a client, a hook or an automation. */
  origin: OperationOrigin;
  owner: OperationOwner;
}

export type CorePipelineRequestResult =
  | {
      status: 'completed';
      operationId: string;
      execution: WorkerPipelineExecution;
    }
  | {
      status: 'failed' | 'cancelled';
      operationId: string;
      error: CanopyErrorPayload | null;
    };

interface AdmittedControl {
  controlId: string;
  runId: string;
  /** The request id was seen before; its recorded control is replayed. */
  replayed: boolean;
}

const RECOVERY_FAILED: CanopyErrorPayload = {
  kind: 'internal',
  message: 'Workflow run recovery could not be dispatched.',
  retry: { kind: 'never' },
};

export type CorePipelineRecoveryResult<T> =
  | { status: 'completed'; operationId: string; result: T }
  | {
      status: 'failed' | 'cancelled';
      operationId: string;
      error: CanopyErrorPayload | null;
    };

export interface CorePipelineControlRequest {
  control: PipelineControlRequest;
  /** Who asked: a client, a hook, an automation or a transient retry. */
  origin: OperationOrigin;
  owner: OperationOwner;
}

export type CorePipelineControlResult =
  | {
      status: 'completed';
      operationId: string;
      outcome: WorkerPipelineControlOutcome;
      /** The execution the control acted on; a start over's new one. */
      execution: WorkerPipelineExecution;
    }
  | {
      status: 'failed' | 'cancelled';
      operationId: string;
      error: CanopyErrorPayload | null;
    };

/** The execution a control runs: a start over runs a new one. */
export function pipelineControlTarget(control: PipelineControlRequest): string {
  return control.operation === 'worker.pipeline.execution.retry' &&
    control.params.mode === 'from_start' &&
    control.params.newExecutionId !== undefined
    ? control.params.newExecutionId
    : control.params.executionId;
}

function controlResult(
  operationId: string,
  dispatched: LocalWorkerDispatchResult,
): CorePipelineControlResult {
  const child = dispatched.operation;
  const reply = WorkerPipelineControlResultSchema.safeParse(dispatched.result);
  if (child.status === 'completed' && reply.success)
    return { status: 'completed', operationId, ...reply.data };
  return child.status === 'cancelled'
    ? { status: 'cancelled', operationId, error: null }
    : { status: 'failed', operationId, error: toErrorPayload(child.error) };
}

function requestResult(
  operationId: string,
  dispatched: LocalWorkerDispatchResult,
): CorePipelineRequestResult {
  const child = dispatched.operation;
  const reply = WorkerPipelineExecutionResultSchema.safeParse(
    dispatched.result,
  );
  if (child.status === 'completed' && reply.success)
    return {
      status: 'completed',
      operationId,
      execution: reply.data.execution,
    };
  return child.status === 'cancelled'
    ? { status: 'cancelled', operationId, error: null }
    : { status: 'failed', operationId, error: toErrorPayload(child.error) };
}

/**
 * Core-side pipeline runs (CAN-4140). A run is a `core.pipeline.run`
 * operation recorded before anything starts. Its `worker.pipeline.execution.*`
 * requests are children dispatched to the local worker, each recorded with
 * its target and lease first (CAN-4132):
 *
 * - The run is `paused` while its execution waits and finishes with the
 *   execution's terminal status.
 * - Any client cancels it through `core.operation.cancel`; the cancellation
 *   is a worker cancel dispatched under the run.
 * - Runs are `lost` across a restart. The execution store keeps a paused
 *   execution resumable; the run record is never started again.
 */
export class CorePipelineRuns {
  /** Unfinished runs this process started, by execution id. */
  private readonly runs = new Map<string, string>();
  /** The live subscription of each run whose execution is watched. */
  private readonly following = new Map<string, () => void>();
  /** Runs recorded as paused. */
  private readonly paused = new Set<string>();
  /** Starts in flight; a cancel waits for its run to exist. */
  private readonly starting = new Map<string, Promise<unknown>>();
  /** Control admissions in flight by execution; one at a time each. */
  private readonly admitting = new Map<string, Promise<AdmittedControl>>();
  /** Controls in flight under each run. */
  private readonly controlling = new Map<string, number>();
  /** Runs a control recorded that have not run their execution yet. */
  private readonly idle = new Set<string>();
  /** In-flight worker cancels by parent operation and mode; a repeat joins one. */
  private readonly cancels = new Map<
    string,
    Promise<CorePipelineRequestResult>
  >();

  constructor(
    private readonly options: {
      operations: OperationService;
      localWorker: LocalWorkerExecution;
      worker: Pick<PipelineExecutionWorker, 'get' | 'observe'>;
    },
  ) {
    options.operations.registerDomain({
      domain: 'core.pipeline',
      kinds: [
        CORE_PIPELINE_RUN_KIND,
        CORE_PIPELINE_CANCEL_KIND,
        CORE_PIPELINE_CONTROL_KIND,
        CORE_PIPELINE_RECOVERY_KIND,
      ],
      restartClass: 'lost',
      cancel: (operation, request) => {
        const { executionId } = operation.scope;
        if (operation.kind !== CORE_PIPELINE_RUN_KIND || !executionId)
          return Promise.resolve('cancelled');
        // A run being cancelled takes no more children, so the worker cancel
        // has its own operation; its reply finishes the run.
        void this.afterStart(executionId)
          .then(() =>
            this.cancelSeparately(executionId, request.requestedBy, 'finalize'),
          )
          .catch(() => undefined);
        return Promise.resolve('requested');
      },
    });
  }

  /**
   * Record a run and start it on the local worker. `completed` once the
   * worker has started the execution; the run itself stays unfinished.
   */
  async start(
    request: CorePipelineStartRequest,
  ): Promise<CorePipelineRequestResult> {
    const { executionId } = request.params;
    const started = this.startRun(request);
    this.starting.set(executionId, started);
    try {
      return await started;
    } finally {
      if (this.starting.get(executionId) === started)
        this.starting.delete(executionId);
    }
  }

  /** Resolves once any start of this execution has settled. */
  private async afterStart(executionId: string): Promise<void> {
    await this.starting.get(executionId)?.catch(() => undefined);
  }

  private async startRun(
    request: CorePipelineStartRequest,
  ): Promise<CorePipelineRequestResult> {
    const { operations, localWorker } = this.options;
    const { params } = request;
    const admitted = await operations.admit({
      kind: CORE_PIPELINE_RUN_KIND,
      status: 'running',
      origin: request.origin,
      owner: request.owner,
      scope: {
        ...(params.workspaceId !== null
          ? { workspaceId: params.workspaceId }
          : {}),
        ...(params.worktreeId !== null
          ? { worktreeId: params.worktreeId }
          : {}),
        executionId: params.executionId,
      },
    });
    const run = admitted.operation;
    let dispatched: LocalWorkerDispatchResult;
    try {
      dispatched = await localWorker.dispatch({
        parentOperationId: run.operationId,
        operation: WORKER_START,
        params,
        idempotencyKey: params.executionId,
        ...(params.secrets?.length
          ? { secrets: executionSecretFingerprints(params.secrets) }
          : {}),
      });
    } catch (error) {
      await operations.finishOrRecord(run.operationId, {
        status: 'failed',
        error: {
          kind: 'internal',
          message: 'This workflow run could not be dispatched.',
          retry: { kind: 'never' },
        },
      });
      throw error;
    }
    const result = requestResult(run.operationId, dispatched);
    if (result.status !== 'completed') {
      await operations.finishOrRecord(
        run.operationId,
        result.status === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'failed', error: result.error ?? OUTCOME_UNKNOWN },
      );
      return result;
    }
    this.runs.set(params.executionId, run.operationId);
    this.follow(params.executionId);
    return result;
  }

  /**
   * Run a recovery control (CAN-4141) on the local worker and resolve with
   * its outcome. A control of an execution whose run this process holds is
   * a child of that run; any other gets a new `core.pipeline.run`, which
   * follows the execution once the control runs it and otherwise finishes
   * with the control's outcome. The dispatch is keyed by the control's
   * `requestId`, so an unanswered control is never sent twice.
   */
  async control(
    request: CorePipelineControlRequest,
  ): Promise<CorePipelineControlResult> {
    const { control } = request;
    const target = pipelineControlTarget(control);
    await this.afterStart(control.params.executionId);
    await this.afterStart(target);
    const admitted = await this.admitControl(target, request);
    return this.dispatchControl(admitted, target, request);
  }

  /**
   * A control's own operation, receipted by its request id, and the run it
   * acts in, counted as in flight before another control of the same
   * execution may look. A request id seen before, in this process or an
   * earlier one, returns its recorded control so the worker replays it;
   * otherwise the control joins the execution's live run, or records a new
   * run.
   */
  private admitControl(
    target: string,
    request: CorePipelineControlRequest,
  ): Promise<AdmittedControl> {
    const previous = this.admitting.get(target) ?? Promise.resolve();
    const admission = previous
      .catch(() => undefined)
      .then(async (): Promise<AdmittedControl> => {
        const { operations } = this.options;
        const receipt = {
          caller: CONTROL_RECEIPT_CALLER,
          idempotencyKey: request.control.params.requestId,
          fingerprint: digest(request.control),
        };
        const admitIn = (runId: string): Promise<OperationAcceptResult> =>
          operations.admit({
            kind: CORE_PIPELINE_CONTROL_KIND,
            status: 'running',
            origin: request.origin,
            owner: request.owner,
            scope: { executionId: target },
            parentOperationId: runId,
            receipt,
          });
        const recorded = await operations.lookupReceipt(
          CORE_PIPELINE_CONTROL_KIND,
          receipt,
        );
        let admitted: OperationAcceptResult | undefined;
        if (recorded.status === 'key-reused')
          throw canopyInvalidArgumentError(
            'This workflow control was already requested with other details.',
          );
        if (recorded.status !== 'none') {
          admitted = await admitIn(
            recorded.operation.parentOperationId ?? target,
          );
        } else {
          const live = await this.liveRun(target);
          if (live !== undefined)
            admitted = await admitIn(live).catch(() => undefined);
        }
        if (admitted === undefined) {
          const run = await operations.admit({
            kind: CORE_PIPELINE_RUN_KIND,
            status: 'running',
            origin: request.origin,
            owner: request.owner,
            scope: { executionId: target },
          });
          const runId = run.operation.operationId;
          const superseded = this.runs.get(target);
          this.runs.set(target, runId);
          this.idle.add(runId);
          if (superseded !== undefined) this.retire(target, superseded);
          admitted = await admitIn(runId);
        }
        const runId = admitted.operation.parentOperationId ?? '';
        this.controlling.set(runId, (this.controlling.get(runId) ?? 0) + 1);
        return {
          controlId: admitted.operation.operationId,
          runId,
          replayed: admitted.status !== 'accepted',
        };
      });
    this.admitting.set(target, admission);
    return admission.finally(() => {
      if (this.admitting.get(target) === admission)
        this.admitting.delete(target);
    });
  }

  /**
   * A run a new one replaced while it was being cancelled: nothing follows
   * its execution for it any more, so it finishes cancelled now.
   */
  private retire(executionId: string, runId: string): void {
    this.following.get(executionId)?.();
    this.paused.delete(executionId);
    this.idle.delete(runId);
    void this.options.operations.finishOrRecord(runId, { status: 'cancelled' });
  }

  /**
   * Record a new run that follows an execution no run holds, unless it has
   * ended: the reply may predate the end its own run already recorded.
   */
  private async adopt(
    target: string,
    request: CorePipelineControlRequest,
  ): Promise<void> {
    const current = await this.options.worker.get(target).catch(() => null);
    if (current === null || isTerminalPipelineExecution(current)) return;
    const run = await this.options.operations
      .admit({
        kind: CORE_PIPELINE_RUN_KIND,
        status: 'running',
        origin: request.origin,
        owner: request.owner,
        scope: { executionId: target },
      })
      .catch(() => null);
    if (run === null || this.runs.has(target)) {
      if (run !== null)
        void this.options.operations.finishOrRecord(run.operation.operationId, {
          status: 'cancelled',
        });
      return;
    }
    this.runs.set(target, run.operation.operationId);
    this.follow(target);
  }

  /**
   * The startup orphan sweep through the local worker: a
   * `core.pipeline.recovery` operation whose child pauses the executions a
   * process left running when it exited. Their runs were `lost` with that
   * process; they resume through a recovery control.
   */
  async sweep(
    executionIds: readonly string[],
    requestId: string = randomUUID(),
  ): Promise<CorePipelineRecoveryResult<WorkerPipelineRecoverySweepResult>> {
    const params = { requestId, executionIds: [...executionIds] };
    const recorded = await this.dispatchRecovery(
      WORKER_SWEEP,
      'startup-sweep',
      params,
    );
    const reply = WorkerPipelineRecoverySweepResultSchema.safeParse(
      recorded.dispatched.result,
    );
    return this.finishRecovery(recorded, reply.success ? reply.data : null);
  }

  /**
   * The shutdown checkpoint through the local worker: every live execution
   * pauses so it can resume after the restart.
   */
  async checkpoint(
    requestId: string = randomUUID(),
  ): Promise<
    CorePipelineRecoveryResult<WorkerPipelineRecoveryCheckpointResult>
  > {
    const recorded = await this.dispatchRecovery(
      WORKER_CHECKPOINT,
      'shutdown-checkpoint',
      { requestId },
    );
    const reply = WorkerPipelineRecoveryCheckpointResultSchema.safeParse(
      recorded.dispatched.result,
    );
    return this.finishRecovery(recorded, reply.success ? reply.data : null);
  }

  private async dispatchRecovery(
    operation: typeof WORKER_SWEEP | typeof WORKER_CHECKPOINT,
    sourceId: string,
    params: { requestId: string },
  ): Promise<{
    operationId: string;
    replayed: boolean;
    dispatched: LocalWorkerDispatchResult;
  }> {
    const { operations, localWorker } = this.options;
    // Receipted by the request id, so a repeat replays the recorded sweep or
    // checkpoint instead of running it again.
    const admitted = await operations.admit({
      kind: CORE_PIPELINE_RECOVERY_KIND,
      status: 'running',
      origin: { kind: 'system', sourceId },
      owner: { kind: 'system', id: SYSTEM },
      receipt: {
        caller: RECOVERY_RECEIPT_CALLER,
        idempotencyKey: params.requestId,
        fingerprint: digest({ operation, params }),
      },
    });
    const operationId = admitted.operation.operationId;
    const replayed = admitted.status !== 'accepted';
    try {
      return {
        operationId,
        replayed,
        dispatched: await localWorker.dispatch({
          parentOperationId: operationId,
          operation,
          params,
          idempotencyKey: params.requestId,
        }),
      };
    } catch (error) {
      if (!replayed)
        await operations.finishOrRecord(operationId, {
          status: 'failed',
          error: RECOVERY_FAILED,
        });
      throw error;
    }
  }

  private async finishRecovery<T extends Record<string, number>>(
    {
      operationId,
      replayed,
      dispatched,
    }: {
      operationId: string;
      replayed: boolean;
      dispatched: LocalWorkerDispatchResult;
    },
    reply: T | null,
  ): Promise<CorePipelineRecoveryResult<T>> {
    const child = dispatched.operation;
    const result: CorePipelineRecoveryResult<T> =
      child.status === 'completed' && reply !== null
        ? { status: 'completed', operationId, result: reply }
        : {
            status: child.status === 'cancelled' ? 'cancelled' : 'failed',
            operationId,
            error: toErrorPayload(child.error),
          };
    if (replayed) return result;
    await this.options.operations.finishOrRecord(
      operationId,
      result.status === 'completed'
        ? { status: 'completed', outcome: result.result }
        : result.status === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'failed', error: result.error ?? OUTCOME_UNKNOWN },
    );
    return result;
  }

  /** The unfinished run this process holds for an execution, if any. */
  private async liveRun(executionId: string): Promise<string | undefined> {
    const runId = this.runs.get(executionId);
    if (runId === undefined) return undefined;
    const run = await this.options.operations.get(runId);
    return run &&
      !TERMINAL_OPERATION_STATUSES.has(run.status) &&
      !run.cancellation
      ? runId
      : undefined;
  }

  private async dispatchControl(
    { controlId, runId, replayed }: AdmittedControl,
    target: string,
    request: CorePipelineControlRequest,
  ): Promise<CorePipelineControlResult> {
    const { control } = request;
    const { operations } = this.options;
    let result: CorePipelineControlResult;
    try {
      const dispatched = await this.options.localWorker.dispatch({
        parentOperationId: controlId,
        operation: control.operation,
        params: control.params,
        idempotencyKey: control.params.requestId,
        ...('secrets' in control.params && control.params.secrets?.length
          ? { secrets: executionSecretFingerprints(control.params.secrets) }
          : {}),
      });
      result = controlResult(runId, dispatched);
    } catch (error) {
      const dispatchFailed = {
        status: 'failed' as const,
        error: {
          kind: 'internal' as const,
          message: 'This workflow control could not be dispatched.',
          retry: { kind: 'never' as const },
        },
      };
      if (!replayed) void operations.finishOrRecord(controlId, dispatchFailed);
      this.afterControl(runId, target, dispatchFailed);
      throw error;
    }
    if (!replayed)
      void operations.finishOrRecord(
        controlId,
        result.status === 'completed'
          ? { status: 'completed', outcome: { outcome: result.outcome } }
          : result.status === 'cancelled'
            ? { status: 'cancelled' }
            : { status: 'failed', error: result.error ?? OUTCOME_UNKNOWN },
      );
    if (result.status === 'completed' && result.outcome === 'started') {
      this.idle.delete(runId);
      this.afterControl(runId, target, null);
      // A replay under an older run reports what that run started; only the
      // run that holds the execution now follows it. When none does, as when
      // a concurrent control already finished their shared run, a new run
      // follows what this control started.
      const holder = this.runs.get(target);
      if (
        !replayed &&
        holder === undefined &&
        !isTerminalPipelineExecution(result.execution)
      ) {
        await this.adopt(target, request);
        return result;
      }
      if (holder !== runId) return result;
      if (isTerminalPipelineExecution(result.execution))
        this.settle(target, result.execution);
      else this.follow(target);
      return result;
    }
    // A control that ran nothing may still end the execution, as cancelling
    // its last paused matrix variant does.
    if (
      result.status === 'completed' &&
      !this.idle.has(runId) &&
      this.runs.get(target) === runId &&
      isTerminalPipelineExecution(result.execution)
    )
      this.settle(target, result.execution);
    this.afterControl(
      runId,
      target,
      result.status === 'completed'
        ? { status: 'completed', outcome: { outcome: result.outcome } }
        : result.status === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'failed', error: result.error ?? OUTCOME_UNKNOWN },
    );
    return result;
  }

  /**
   * A control has settled. A run that only controls recorded, none of which
   * ran its execution, finishes with the last one's outcome.
   */
  private afterControl(
    runId: string,
    target: string,
    terminal: Parameters<OperationService['finish']>[1] | null,
  ): void {
    const remaining = (this.controlling.get(runId) ?? 1) - 1;
    if (remaining > 0) {
      this.controlling.set(runId, remaining);
      return;
    }
    this.controlling.delete(runId);
    if (terminal === null || !this.idle.has(runId)) return;
    this.idle.delete(runId);
    if (this.runs.get(target) === runId) this.runs.delete(target);
    void this.options.operations.finishOrRecord(runId, terminal);
  }

  /**
   * Watch a run's execution again after it resumed on a new handle. A
   * no-op for executions this process did not start.
   */
  reattach(executionId: string): void {
    if (this.runs.has(executionId)) this.follow(executionId);
  }

  /**
   * Cancel an execution and resolve with the worker's answer. The worker
   * cancel of a run this process started is a child of that run; any other
   * execution gets a `core.pipeline.cancel` operation of its own. A `drain`
   * never settles a run that is still stopping; it fails instead.
   */
  async cancel(
    executionId: string,
    requestedBy: string,
    mode: WorkerPipelineCancelMode = 'finalize',
  ): Promise<CorePipelineRequestResult> {
    // A cancel that arrives while its run starts cancels the started run.
    await this.afterStart(executionId);
    const runId = this.runs.get(executionId);
    if (runId !== undefined) {
      const run = await this.options.operations.get(runId);
      if (
        run &&
        !TERMINAL_OPERATION_STATUSES.has(run.status) &&
        !run.cancellation
      ) {
        try {
          return await this.dispatchCancel(
            runId,
            executionId,
            requestedBy,
            mode,
          );
        } catch (error) {
          // The run finished or began cancelling after that read, so it
          // takes no more children; cancel the execution on its own.
          const after = await this.options.operations.get(runId);
          if (
            !after ||
            (!TERMINAL_OPERATION_STATUSES.has(after.status) &&
              !after.cancellation)
          )
            throw error;
        }
      }
    }
    return this.cancelSeparately(executionId, requestedBy, mode);
  }

  /**
   * Finish a run from an execution that has ended, whether its handle
   * reported it or a cancel reply did, as for a paused run whose handle has
   * already settled.
   */
  private settle(
    executionId: string,
    execution: WorkerPipelineExecution,
  ): void {
    const runId = this.runs.get(executionId);
    if (runId === undefined || !isTerminalPipelineExecution(execution)) return;
    this.following.get(executionId)?.();
    this.runs.delete(executionId);
    this.paused.delete(executionId);
    void this.options.operations.finishOrRecord(
      runId,
      execution.status === 'success'
        ? { status: 'completed' }
        : execution.status === 'cancelled'
          ? { status: 'cancelled' }
          : { status: 'failed', error: RUN_FAILED },
    );
  }

  private async cancelSeparately(
    executionId: string,
    requestedBy: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<CorePipelineRequestResult> {
    const { operations } = this.options;
    const admitted = await operations.admit({
      kind: CORE_PIPELINE_CANCEL_KIND,
      status: 'running',
      origin: { kind: 'client', sourceId: requestedBy },
      owner: { kind: 'principal', id: requestedBy },
      scope: { executionId },
    });
    const parent = admitted.operation;
    try {
      const result = await this.dispatchCancel(
        parent.operationId,
        executionId,
        requestedBy,
        mode,
      );
      await operations.finishOrRecord(
        parent.operationId,
        result.status === 'completed'
          ? { status: 'completed' }
          : result.status === 'cancelled'
            ? { status: 'cancelled' }
            : { status: 'failed', error: result.error ?? OUTCOME_UNKNOWN },
      );
      return result;
    } catch (error) {
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error: RUN_FAILED,
      });
      throw error;
    }
  }

  private dispatchCancel(
    parentOperationId: string,
    executionId: string,
    requestedBy: string,
    mode: WorkerPipelineCancelMode,
  ): Promise<CorePipelineRequestResult> {
    // A finalize never joins a drain, which may end with the run still going.
    const key = `${parentOperationId}:${mode}`;
    const existing = this.cancels.get(key);
    if (existing) return existing;
    const pending = this.options.localWorker
      .dispatch({
        parentOperationId,
        operation: WORKER_CANCEL,
        params: { executionId, ...(mode === 'drain' && { mode }) },
        idempotencyKey: `cancel:${requestedBy}:${randomUUID()}`,
      })
      .then((dispatched) => {
        const result = requestResult(parentOperationId, dispatched);
        if (result.status === 'completed')
          this.settle(executionId, result.execution);
        return result;
      })
      .finally(() => this.cancels.delete(key));
    this.cancels.set(key, pending);
    return pending;
  }

  /** Mirror the execution's pauses and terminal status onto its run. */
  private follow(executionId: string): void {
    const { operations, worker } = this.options;
    this.following.get(executionId)?.();
    this.following.delete(executionId);
    let stop: (() => void) | null = null;
    let done = false;
    const release = (): void => {
      done = true;
      stop?.();
      if (this.following.get(executionId) === release)
        this.following.delete(executionId);
    };
    const apply = (execution: WorkerPipelineExecution): void => {
      const runId = this.runs.get(executionId);
      if (done || runId === undefined) return;
      if (isTerminalPipelineExecution(execution)) {
        release();
        this.settle(executionId, execution);
        return;
      }
      const pausedNow = execution.status === 'paused';
      if (pausedNow === this.paused.has(executionId)) return;
      if (pausedNow) this.paused.add(executionId);
      else this.paused.delete(executionId);
      void operations.transitionOrRecord(
        runId,
        pausedNow ? 'paused' : 'running',
      );
    };
    let observed = false;
    stop = worker.observe(executionId, {
      onExecution: (_event, execution) => {
        observed = true;
        apply(execution);
      },
      onOutput: () => undefined,
    });
    if (stop === null) {
      // Not running here any more: record where it stopped. A paused run
      // that resumes on a new handle is watched again through `reattach`.
      void worker
        .get(executionId)
        .then((execution) => {
          if (execution) apply(execution);
        })
        .catch(() => undefined);
      return;
    }
    if (done) {
      stop();
      return;
    }
    this.following.set(executionId, release);
    // It may have paused or ended before the subscription; an event the
    // subscription already saw is newer than this read.
    void worker
      .get(executionId)
      .then((execution) => {
        if (execution && !observed) apply(execution);
      })
      .catch(() => undefined);
  }
}
