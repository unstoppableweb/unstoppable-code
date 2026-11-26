import {
  WORKER_AGENT_SUBAGENT_FAILED_CODE,
  WORKER_AGENT_SUBAGENT_FAILED_MESSAGE,
  WorkerAgentSubagentRunResultSchema,
  isTerminalOperationStatus,
  type CanopyErrorPayload,
  type OperationFailure,
  type OperationOrigin,
  type OperationOwner,
  type OperationRecord,
  type WorkerAgentSubagentRunParams,
  type WorkerAgentTurnScope,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import { OperationLedgerRefusedError } from '../../operations/ledger/errors';
import type {
  LocalWorkerDispatchResult,
  LocalWorkerExecution,
} from '../../operations/local-worker';
import {
  OperationCancelRefusedError,
  type OperationServicePort,
} from '../../operations/service';

export const CORE_AGENT_SUBAGENT_RUN_KIND = 'core.agent.subagent.run';
export const WORKER_AGENT_SUBAGENT_RUN = 'worker.agent.subagent.run';

export interface SubagentRunRef {
  readonly subagentRunId: string;
  readonly operationId: string;
  readonly delegationId: string;
  readonly runGeneration: number;
}
/** The delegated run a cancelled core.agent.subagent.run must stop (CAN-4112). */
export interface SubagentNativeStopTarget {
  readonly subagentRunId: string;
  readonly delegationId: string;
  readonly runGeneration: number;
  readonly scope: WorkerAgentTurnScope;
}
export interface CoreSubagentBeginRequest {
  params: WorkerAgentSubagentRunParams;
  origin: OperationOrigin;
  owner: OperationOwner;
  parentOperationId: string | null;
}
export type CoreSubagentRunResult =
  | { status: 'completed'; ref: SubagentRunRef }
  | { status: 'failed'; ref: SubagentRunRef; error: CanopyErrorPayload }
  | { status: 'cancelled'; ref: SubagentRunRef };

const SUBAGENT_FAILED: CanopyErrorPayload = {
  kind: 'internal',
  code: WORKER_AGENT_SUBAGENT_FAILED_CODE,
  message: WORKER_AGENT_SUBAGENT_FAILED_MESSAGE,
  retry: { kind: 'never' },
};
const OUTCOME_UNKNOWN: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.outcomeUnknown',
  message: 'The local worker did not report how this subagent run ended.',
  retry: { kind: 'never' },
};
const NOT_DISPATCHED: CanopyErrorPayload = {
  kind: 'internal',
  message: 'This subagent run could not be dispatched.',
  retry: { kind: 'never' },
};

function isPlaneQualifiedCode(
  code: string,
): code is `core.${string}.${string}` | `worker.${string}.${string}` {
  return /^(core|worker)\.[^.]+\..+$/.test(code);
}

function toErrorPayload(failure: OperationFailure): CanopyErrorPayload {
  const { code, ...rest } = failure;
  return code !== undefined && isPlaneQualifiedCode(code)
    ? { ...rest, code }
    : rest;
}

/**
 * Managed subagent generations as core operations (CAN-4115). Each run is one
 * `core.agent.subagent.run`, a child of the turn or subagent run that started
 * it, whose `worker.agent.subagent.run` child is dispatched through
 * `LocalWorkerExecution`. A finished lineage parent never refuses the run.
 */
export class CoreSubagentRuns {
  private readonly live = new Map<string, SubagentRunRef>();
  private readonly reserved = new Set<string>();
  private readonly stopTargets = new Map<string, SubagentNativeStopTarget>();
  private readonly stopping = new Map<string, Promise<void>>();

  constructor(
    private readonly options: {
      operations: OperationServicePort;
      localWorker: LocalWorkerExecution;
      onError?: (error: unknown, context: string) => void;
      stopNative?: (target: SubagentNativeStopTarget) => Promise<void>;
    },
  ) {
    options.operations.registerDomain({
      domain: 'core.agent.subagent',
      kinds: [CORE_AGENT_SUBAGENT_RUN_KIND],
      restartClass: 'lost',
      cancel: (operation) => this.cancelRun(operation),
    });
  }

  async begin(request: CoreSubagentBeginRequest): Promise<{
    ref: SubagentRunRef;
    settled: Promise<CoreSubagentRunResult>;
  }> {
    const { params } = request;
    const key = `${params.delegationId}\u0000${params.runGeneration}`;
    if (this.live.has(key) || this.reserved.has(key))
      throw new CanopyOperationError({
        kind: 'failed_precondition',
        code: 'core.agent.subagentRunActive',
        message: 'This subagent run is already running.',
        retry: { kind: 'never' },
      });
    this.reserved.add(key);
    let operationId: string;
    try {
      operationId = await this.admit(request);
    } finally {
      this.reserved.delete(key);
    }
    const ref: SubagentRunRef = {
      subagentRunId: params.subagentRunId,
      operationId,
      delegationId: params.delegationId,
      runGeneration: params.runGeneration,
    };
    this.live.set(key, ref);
    this.stopTargets.set(operationId, {
      subagentRunId: params.subagentRunId,
      delegationId: params.delegationId,
      runGeneration: params.runGeneration,
      scope: params.scope,
    });
    const settled = this.options.localWorker
      .dispatch({
        parentOperationId: operationId,
        operation: WORKER_AGENT_SUBAGENT_RUN,
        params,
        idempotencyKey: params.subagentRunId,
      })
      .then(
        (dispatched) => this.settleDispatched(ref, dispatched),
        (error: unknown) => this.settleRefused(ref, error),
      )
      .then((result) => {
        if (this.live.get(key) === ref) this.live.delete(key);
        this.stopTargets.delete(operationId);
        this.stopping.delete(operationId);
        return result;
      });
    return { ref, settled };
  }

  findLive(delegationId: string, runGeneration: number): SubagentRunRef | null {
    return this.live.get(`${delegationId}\u0000${runGeneration}`) ?? null;
  }

  /** Whether the ledger records this operation as a core.agent.subagent.run (CAN-6000). */
  async isSubagentRun(operationId: string): Promise<boolean> {
    const operation = await this.options.operations
      .get(operationId)
      .catch(() => null);
    return operation?.kind === CORE_AGENT_SUBAGENT_RUN_KIND;
  }

  private async cancelRun(operation: OperationRecord): Promise<'requested'> {
    const { stopNative } = this.options;
    const target = this.stopTargets.get(operation.operationId);
    if (!stopNative || !target) return 'requested';
    let stop = this.stopping.get(operation.operationId);
    if (!stop) {
      stop = stopNative(target);
      this.stopping.set(operation.operationId, stop);
    }
    try {
      await stop;
    } catch (error) {
      if (this.stopping.get(operation.operationId) === stop)
        this.stopping.delete(operation.operationId);
      this.options.onError?.(error, 'subagent native stop');
      throw new OperationCancelRefusedError(
        'This subagent run could not be stopped.',
      );
    }
    return 'requested';
  }

  private async admit(request: CoreSubagentBeginRequest): Promise<string> {
    const { operations } = this.options;
    const { scope } = request.params;
    const base = {
      kind: CORE_AGENT_SUBAGENT_RUN_KIND,
      status: 'running' as const,
      origin: request.origin,
      owner: request.owner,
      scope: {
        workspaceId: scope.workspaceId,
        worktreeId: scope.worktreeId,
        chatId: scope.chatId,
      },
    };
    if (request.parentOperationId === null)
      return (await operations.admit(base)).operation.operationId;
    try {
      return (
        await operations.admit({
          ...base,
          parentOperationId: request.parentOperationId,
        })
      ).operation.operationId;
    } catch (error) {
      // Lineage alone never refuses a subagent run, but a parent that is
      // still stopping keeps it inside its cancellation.
      if (!(error instanceof OperationLedgerRefusedError)) throw error;
      const parent = await operations
        .get(request.parentOperationId)
        .catch(() => null);
      if (parent && !isTerminalOperationStatus(parent.status)) throw error;
      this.options.onError?.(error, 'subagent lineage parent finished');
      return (await operations.admit(base)).operation.operationId;
    }
  }

  private async settleDispatched(
    ref: SubagentRunRef,
    dispatched: LocalWorkerDispatchResult,
  ): Promise<CoreSubagentRunResult> {
    const parsed = WorkerAgentSubagentRunResultSchema.safeParse(
      dispatched.result,
    );
    const result = parsed.success ? parsed.data : null;
    const status =
      result?.status ??
      (dispatched.operation.status === 'cancelled' ? 'cancelled' : 'failed');
    if (status === 'completed') {
      await this.finish(ref.operationId, {
        status: 'completed',
        ...(result ? { outcome: result } : {}),
      });
      return { status: 'completed', ref };
    }
    if (status === 'cancelled') {
      await this.finish(ref.operationId, { status: 'cancelled' });
      return { status: 'cancelled', ref };
    }
    const error =
      result?.status === 'failed'
        ? SUBAGENT_FAILED
        : dispatched.operation.error
          ? toErrorPayload(dispatched.operation.error)
          : OUTCOME_UNKNOWN;
    await this.finish(ref.operationId, { status: 'failed', error });
    return { status: 'failed', ref, error };
  }

  private async settleRefused(
    ref: SubagentRunRef,
    error: unknown,
  ): Promise<CoreSubagentRunResult> {
    this.options.onError?.(error, 'subagent dispatch');
    const current = await this.options.operations
      .get(ref.operationId)
      .catch(() => null);
    if (current?.cancellation) {
      await this.finish(ref.operationId, { status: 'cancelled' });
      return { status: 'cancelled', ref };
    }
    await this.finish(ref.operationId, {
      status: 'failed',
      error: NOT_DISPATCHED,
    });
    return { status: 'failed', ref, error: NOT_DISPATCHED };
  }

  private async finish(
    operationId: string,
    terminal: Parameters<OperationServicePort['finish']>[1],
  ): Promise<void> {
    try {
      await this.options.operations.finish(operationId, terminal);
    } catch (error) {
      this.options.onError?.(error, 'subagent finish');
    }
  }
}
