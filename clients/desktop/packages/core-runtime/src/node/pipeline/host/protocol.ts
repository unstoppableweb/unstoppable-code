import {
  WorkerPipelineExecutionSchema,
  type WorkerPipelineCancelMode,
  type WorkerPipelineExecution,
  type WorkerPipelineExecutionResumeParams,
  type WorkerPipelineExecutionRetryParams,
  type WorkerPipelineExecutionStartParams,
  type WorkerPipelineHostLaunch,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostResult,
  type WorkerPipelineHostStepValues,
} from '@canopy/protocol/canopy-core';
import type { PipelineOwnerSettlement } from '../execution/host-requests';
import type { PipelineExecutionListQuery } from '../execution/worker-pipelines';

/*
 * The private protocol between a worker and the pipeline host it supervises
 * (CAN-5086). Structured-clone values on the execution host channel; nothing
 * here is a wire operation. Every path in it was verified by the worker.
 */

/** What the host runs: the start's params, its verified launch and base environment. */
export interface PipelineHostLaunch {
  readonly params: Omit<WorkerPipelineExecutionStartParams, 'secrets'>;
  readonly launch: WorkerPipelineHostLaunch;
  /** The run's base environment (`_execution.childEnvironment`). */
  readonly processEnvironment: Readonly<Record<string, string>>;
}

/**
 * A recovery control (CAN-4141) the host runs on a run it stored (CAN-6103),
 * without its secret bindings: the supervisor redeemed them into the
 * launch it sends beside it.
 */
export type PipelineHostControl =
  | {
      readonly operation: 'worker.pipeline.execution.resume';
      readonly params: Omit<WorkerPipelineExecutionResumeParams, 'secrets'>;
    }
  | {
      readonly operation: 'worker.pipeline.execution.retry';
      readonly params: Omit<WorkerPipelineExecutionRetryParams, 'secrets'>;
    };

/** How the supervisor ended one host request (CAN-5771). */
export type PipelineHostStepSettlement =
  | {
      readonly kind: 'settled';
      readonly result: Exclude<WorkerPipelineHostResult, { status: 'owner' }>;
      /** `_execution.pipelineHostStep` from the owner's respond; null when it sent none. */
      readonly values: WorkerPipelineHostStepValues | null;
    }
  /** No owner subscribed within the wait. */
  | { readonly kind: 'unavailable' };

/** How the supervisor ended one request the host raised: a host step's, or an owner request's (CAN-5095). */
export type PipelineHostSettlement =
  | PipelineHostStepSettlement
  | { readonly kind: 'owner'; readonly settlement: PipelineOwnerSettlement };

/** The daemon executable's own command; it serves the Codex MCP launcher mode (CAN-4117). */
export interface PipelineHostLauncherCommand {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * The delegation lease a cloud runner incarnation holds (CAN-6198): its
 * epoch, from the runner credential the relay admitted it with, and when the
 * lease lapses unless the web core renews it, in epoch milliseconds.
 */
export interface PipelineOwnerLease {
  readonly leaseEpoch: number;
  readonly expiresAt: number;
}

/** How a lease fence ends: unrenewed past its expiry, or a newer epoch exists. */
export type PipelineOwnerLeaseEnd = 'lapsed' | 'superseded';

/** The host's answer to `lease`: its fence after the observation. */
export interface PipelineOwnerLeaseAnswer {
  readonly state: 'held' | PipelineOwnerLeaseEnd;
}

/**
 * What the runner learned about its lease over the relay (CAN-6198):
 * `renewed` moves the expiry of its own epoch, or names a newer epoch the
 * web core reported; `superseded` means a newer epoch exists, such as when
 * the relay closed the runner's leg with `superseded`, whose number the
 * runner may not know.
 */
export type PipelineOwnerLeaseObservation =
  | { readonly kind: 'renewed'; readonly lease: PipelineOwnerLease }
  | { readonly kind: 'superseded'; readonly leaseEpoch?: number };

/**
 * A sized host's memory (CAN-6325): a cloud runner's run sandbox. The host
 * holds a step that would start while its own processes and the machine
 * leave less than the step needs.
 */
export interface PipelineHostMemoryBudget {
  /** What the host's steps may take together. */
  readonly budgetBytes: number;
  /** Kept free for chats sharing the sandbox; worktree runs leave it alone. */
  readonly chatReserveBytes?: number;
}

export type PipelineHostRequest =
  /** Sent once, first, by the supervisor; the host refuses every other op before it. */
  | {
      op: 'configure';
      dataRoot: string;
      /** The pipeline host's Codex MCP launcher (CAN-5095 D18). */
      codexMcpLauncher?: PipelineHostLauncherCommand;
      /**
       * A cloud runner's delegation lease (CAN-6198): the host fences its
       * writes with the lease epoch instead of its process identity.
       */
      ownerLease?: PipelineOwnerLease;
      /** A sized host's memory; absent, steps start without waiting (CAN-6325). */
      memory?: PipelineHostMemoryBudget;
      /**
       * A remote owner's lease TTL (CP-11): an owner request the host would
       * give the short deadline waits at least this long instead.
       */
      ownerRequestDeadlineMs?: number;
    }
  | { op: 'start'; start: PipelineHostLaunch }
  /** With `detail`, the host answers the summary and its detail (CAN-6117). */
  | { op: 'get'; executionId: string; detail?: true }
  /** One list page of the executions the host's store holds (CAN-6117). */
  | { op: 'list'; query: PipelineExecutionListQuery }
  | { op: 'cancel'; executionId: string; mode: WorkerPipelineCancelMode }
  | { op: 'sweep'; executionIds: string[] }
  | { op: 'checkpoint' }
  /**
   * Run a recovery control on a stored run (CAN-6103), as a cloud runner
   * serves it: `start` is the run's launch, resolved again for the control
   * (for a `from_start` retry, the new run's). The host answers a
   * `WorkerPipelineControlResult`.
   */
  | { op: 'control'; control: PipelineHostControl; start: PipelineHostLaunch }
  /** The supervisor's answer to a host request the host raised (CAN-5771). */
  | {
      op: 'hostSettled';
      requestId: string;
      settlement: PipelineHostSettlement;
    }
  /**
   * Pause these owner-bound executions at a checkpoint: their owner is gone
   * (CAN-5771). `owner_lost` records that cause for a remote owner (CAN-6102);
   * without it the pause records `app_shutdown`, as on desktop.
   */
  | { op: 'pause'; executionIds: string[]; reason?: 'owner_lost' }
  /**
   * Checkpoint one run so its host can roll over (CAN-6199): no new step
   * starts, running steps may finish within `drainMs`, then the rest pauses
   * with `host_rollover`. Answered with the run once it stopped.
   */
  | { op: 'checkpointRun'; executionId: string; drainMs: number }
  /**
   * What the runner learned about the lease it configured (CAN-6198); the
   * host answers {@link PipelineOwnerLeaseAnswer}.
   */
  | { op: 'lease'; observation: PipelineOwnerLeaseObservation }
  /** Close admission and exit once nothing runs. */
  /**
   * The owner-request deadline floor for a host that started before the
   * remote owner's lease TTL was known (CP-11), as `ownerRequestDeadlineMs`
   * at configure.
   */
  | { op: 'ownerDeadline'; ownerRequestDeadlineMs: number }
  | { op: 'exit' };

export interface PipelineHostRequestMessage {
  readonly id: number;
  readonly request: PipelineHostRequest;
}

export type PipelineHostErrorCode =
  | 'not_found'
  | 'model_steps'
  | 'start_failed'
  | 'drain_timed_out'
  | 'cancel_failed'
  | 'checkpoint_failed'
  | 'host_steps'
  /** The executor refused a recovery control (CAN-6103). */
  | 'control_failed'
  | 'closed';

export type PipelineHostMessage =
  | { kind: 'response'; id: number; ok: true; value: unknown }
  | {
      kind: 'response';
      id: number;
      ok: false;
      error: { code: PipelineHostErrorCode; message: string };
    }
  | {
      kind: 'execution';
      executionId: string;
      event: string;
      execution: WorkerPipelineExecution;
    }
  | {
      kind: 'output';
      executionId: string;
      jobId: string;
      stepId: string;
      attempt?: number;
      iteration?: number;
      stream: 'stdout' | 'stderr';
      text: string;
    }
  /** A desktop notification a step asked for (CAN-5868). */
  | {
      kind: 'notification';
      executionId: string;
      stepId: string;
      title: string;
      body: string;
    }
  | { kind: 'process'; state: 'started'; id: string; processGroupId: number }
  | { kind: 'process'; state: 'exited'; id: string }
  /** An owner-bound run's host step or owner request, for the owner to settle (CAN-5771, CAN-5095). */
  | { kind: 'hostRequest'; request: WorkerPipelineHostRequest }
  | { kind: 'hostRequestWithdrawn'; executionId: string; requestId: string }
  /** The host's lease fence closed for good: it stopped its runs (CAN-6198). */
  | { kind: 'fenced'; state: PipelineOwnerLeaseEnd };

function isOptionalCount(value: unknown, minimum: number): boolean {
  return (
    value === undefined || (Number.isInteger(value) && Number(value) >= minimum)
  );
}

const HOST_ERROR_CODES: ReadonlySet<string> = new Set<PipelineHostErrorCode>([
  'not_found',
  'model_steps',
  'start_failed',
  'drain_timed_out',
  'cancel_failed',
  'checkpoint_failed',
  'host_steps',
  'control_failed',
  'closed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponse(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'number') return false;
  if (value.ok === true) return 'value' in value;
  return (
    value.ok === false &&
    isRecord(value.error) &&
    typeof value.error.code === 'string' &&
    HOST_ERROR_CODES.has(value.error.code) &&
    typeof value.error.message === 'string'
  );
}

function isProcess(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string') return false;
  if (value.state === 'exited') return true;
  return (
    value.state === 'started' &&
    typeof value.processGroupId === 'number' &&
    Number.isInteger(value.processGroupId)
  );
}

export function isPipelineHostMessage(
  value: unknown,
): value is PipelineHostMessage {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'response':
      return isResponse(value);
    case 'execution':
      return (
        typeof value.executionId === 'string' &&
        typeof value.event === 'string' &&
        WorkerPipelineExecutionSchema.safeParse(value.execution).success
      );
    case 'output':
      return (
        typeof value.executionId === 'string' &&
        typeof value.jobId === 'string' &&
        typeof value.stepId === 'string' &&
        isOptionalCount(value.attempt, 0) &&
        isOptionalCount(value.iteration, 1) &&
        (value.stream === 'stdout' || value.stream === 'stderr') &&
        typeof value.text === 'string'
      );
    case 'notification':
      return (
        typeof value.executionId === 'string' &&
        typeof value.stepId === 'string' &&
        typeof value.title === 'string' &&
        typeof value.body === 'string'
      );
    case 'process':
      return isProcess(value);
    case 'hostRequest':
      return (
        isRecord(value.request) &&
        typeof value.request.requestId === 'string' &&
        value.request.requestId.length > 0 &&
        typeof value.request.executionId === 'string' &&
        value.request.executionId.length > 0
      );
    case 'hostRequestWithdrawn':
      return (
        typeof value.executionId === 'string' &&
        value.executionId.length > 0 &&
        typeof value.requestId === 'string' &&
        value.requestId.length > 0
      );
    case 'fenced':
      return value.state === 'lapsed' || value.state === 'superseded';
    default:
      return false;
  }
}
