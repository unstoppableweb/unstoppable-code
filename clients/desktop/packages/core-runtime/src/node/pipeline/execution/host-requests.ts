import {
  WORKER_PIPELINE_GRANTS,
  WORKER_PIPELINE_OWNER_RESULT_KIND,
  isWorkerPipelineHostWithdrawal,
  isWorkerPipelineOwnerAction,
  type CanopyCallerDescriptor,
  type CanopyInstructionHandler,
  type CanopyStreamHandlerMap,
  type WorkerPipelineHostRequest,
  type WorkerPipelineHostRequestsItem,
  type WorkerPipelineHostRespondResult,
  type WorkerPipelineHostResult,
  type WorkerPipelineHostStepValues,
  type WorkerPipelineOwnerValues,
} from '@canopy/protocol/canopy-core';

import {
  CanopyOperationError,
  canopyInvalidArgumentError,
} from '../../../runtime/errors';
import type {
  CanopyDispatcher,
  CanopyHandlerContext,
} from '../../../runtime/types';

/*
 * Host steps as worker-to-core requests (CAN-4140). The worker raises each
 * host step on `worker.pipeline.hostRequests`; the owning core applies its
 * policy and settles it with `worker.pipeline.hostRequest.respond`. A request
 * nobody settles by its deadline is withdrawn by the executor, and a late
 * response reports `already_settled`.
 */

/** How many settled requests a late response can still be told about. */
const SETTLED_MEMORY = 1024;

export function hostRequestNotFoundError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'not_found',
    code: 'worker.pipeline.hostRequestNotFound',
    message: 'This host request was not raised here.',
    retry: { kind: 'never' },
  });
}

/** No core settles host requests here; the step fails as it does without a desktop. */
export class PipelineHostUnavailableError extends Error {
  constructor() {
    super('No core is settling host requests.');
    this.name = 'PipelineHostUnavailableError';
  }
}

/** What a host step settles with: never an owner answer (CAN-5095). */
export type PipelineHostStepResult = Exclude<
  WorkerPipelineHostResult,
  { status: 'owner' }
>;

/** An owner request's answer and its host-local values (CAN-5095). */
export interface PipelineOwnerSettlement {
  readonly result: WorkerPipelineHostResult;
  readonly values?: WorkerPipelineOwnerValues;
}

/** A host step's answer and its host-local values (CAN-5771). */
export interface PipelineHostStepAnswer {
  readonly result: PipelineHostStepResult;
  /** `_execution.pipelineHostStep` from the settling respond; absent without one. */
  readonly values?: WorkerPipelineHostStepValues;
}

interface Pending {
  readonly request: WorkerPipelineHostRequest;
  resolve(
    result: WorkerPipelineHostResult,
    values?: WorkerPipelineOwnerValues,
    hostStep?: WorkerPipelineHostStepValues,
  ): void;
}

const UNEXPECTED: PipelineHostStepResult = {
  status: 'failure',
  failureReason: null,
  message: 'The host step failed unexpectedly.',
  outputs: {},
};

function isOwnerRequest(request: WorkerPipelineHostRequest): boolean {
  return isWorkerPipelineOwnerAction(request.request.action);
}

/** A host step never takes an owner answer. */
function hostStepResult(
  result: WorkerPipelineHostResult,
): PipelineHostStepResult {
  return result.status === 'owner' ? UNEXPECTED : result;
}

/**
 * An owner request takes only an owner answer of its own kind, or a failure;
 * also how a worker settles a request it answers itself (CAN-6161).
 */
export function ownerSettlement(
  request: WorkerPipelineHostRequest,
  result: WorkerPipelineHostResult,
  values: WorkerPipelineOwnerValues | undefined,
): PipelineOwnerSettlement {
  if (result.status === 'failure') return { result };
  const action = request.request.action;
  if (
    result.status !== 'owner' ||
    !isWorkerPipelineOwnerAction(action) ||
    result.value.kind !== WORKER_PIPELINE_OWNER_RESULT_KIND[action]
  )
    return { result: UNEXPECTED };
  return values ? { result, values } : { result };
}

/** The worker side: pending host requests and their subscribers. */
export class PipelineHostRequestBroker {
  private readonly pending = new Map<string, Pending>();
  /** Recently settled requests: request id to execution and settle time. */
  private readonly done = new Map<
    string,
    { executionId: string; settledAt: string }
  >();
  private readonly subscribers = new Set<
    (item: WorkerPipelineHostRequestsItem) => void
  >();
  private readonly announceWithdrawals: boolean;

  constructor(options: { readonly announceWithdrawals?: boolean } = {}) {
    this.announceWithdrawals = options.announceWithdrawals === true;
  }

  /** Whether a core is subscribed to settle requests. */
  get settled(): boolean {
    return this.subscribers.size > 0;
  }

  /**
   * Raise a request and resolve with core's result. Rejects with
   * {@link PipelineHostUnavailableError} when no core is subscribed, and
   * withdraws the request when `signal` aborts.
   */
  raise(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<PipelineHostStepResult> {
    if (isOwnerRequest(request))
      return Promise.reject(
        new Error('Owner requests are raised with raiseOwner.'),
      );
    return this.enqueue(request, signal, (result) => hostStepResult(result));
  }

  /**
   * `raise`, resolving with the host-local values the settling respond
   * carried in `_execution.pipelineHostStep` (CAN-5771).
   */
  raiseHostStep(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<PipelineHostStepAnswer> {
    if (isOwnerRequest(request))
      return Promise.reject(
        new Error('Owner requests are raised with raiseOwner.'),
      );
    return this.enqueue(request, signal, (result, _values, hostStep) => {
      const answered = hostStepResult(result);
      return hostStep && answered === result
        ? { result: answered, values: hostStep }
        : { result: answered };
    });
  }

  /**
   * Raise an owner request (`owner.*` action, CAN-5095) and resolve with
   * core's settlement. Shares pending requests, withdrawal and subscribers
   * with {@link raise}.
   */
  raiseOwner(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<PipelineOwnerSettlement> {
    if (!isOwnerRequest(request))
      return Promise.reject(new Error('Host steps are raised with raise.'));
    return this.enqueue(request, signal, (result, values) =>
      ownerSettlement(request, result, values),
    );
  }

  private enqueue<T>(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
    settle: (
      result: WorkerPipelineHostResult,
      values: WorkerPipelineOwnerValues | undefined,
      hostStep: WorkerPipelineHostStepValues | undefined,
    ) => T,
  ): Promise<T> {
    if (this.subscribers.size === 0)
      return Promise.reject(new PipelineHostUnavailableError());
    return new Promise((resolve, reject) => {
      const withdrawn = (): Error => {
        const reason: unknown = signal.reason;
        return reason instanceof Error
          ? reason
          : new Error('The host request was withdrawn.');
      };
      const withdraw = (): void => {
        if (this.pending.get(request.requestId)?.request !== request) return;
        this.pending.delete(request.requestId);
        this.remember(request);
        reject(withdrawn());
        if (!this.announceWithdrawals) return;
        const withdrawal = {
          withdrawn: true,
          executionId: request.executionId,
          requestId: request.requestId,
        } as const;
        for (const subscriber of Array.from(this.subscribers))
          subscriber(withdrawal);
      };
      if (signal.aborted) {
        reject(withdrawn());
        return;
      }
      signal.addEventListener('abort', withdraw, { once: true });
      this.pending.set(request.requestId, {
        request,
        resolve: (result, values, hostStep) => {
          signal.removeEventListener('abort', withdraw);
          resolve(settle(result, values, hostStep));
        },
      });
      for (const subscriber of Array.from(this.subscribers))
        subscriber(request);
    });
  }

  /**
   * Settle a pending request exactly once; `values` only for an owner
   * request, `hostStep` only for a host step (CAN-5771).
   */
  respond(
    executionId: string,
    requestId: string,
    result: WorkerPipelineHostResult,
    values?: WorkerPipelineOwnerValues,
    hostStep?: WorkerPipelineHostStepValues,
  ): WorkerPipelineHostRespondResult {
    if (values !== undefined && values.requestId !== requestId)
      throw canopyInvalidArgumentError(
        'These owner values belong to another request.',
      );
    const pending = this.pending.get(requestId);
    if (pending?.request.executionId === executionId) {
      this.pending.delete(requestId);
      const settledAt = this.remember(pending.request);
      const owner = isOwnerRequest(pending.request);
      pending.resolve(
        result,
        owner ? values : undefined,
        owner ? undefined : hostStep,
      );
      return { executionId, requestId, outcome: 'applied', settledAt };
    }
    const done = this.done.get(requestId);
    if (done?.executionId === executionId)
      return {
        executionId,
        requestId,
        outcome: 'already_settled',
        settledAt: done.settledAt,
      };
    throw hostRequestNotFoundError();
  }

  private remember(request: WorkerPipelineHostRequest): string {
    const settledAt = new Date().toISOString();
    this.done.delete(request.requestId);
    this.done.set(request.requestId, {
      executionId: request.executionId,
      settledAt,
    });
    for (const key of Array.from(this.done.keys())) {
      if (this.done.size <= SETTLED_MEMORY) break;
      this.done.delete(key);
    }
    return settledAt;
  }

  /** Deliver every pending request, then each new item. */
  subscribe(
    subscriber: (item: WorkerPipelineHostRequestsItem) => void,
  ): () => void {
    this.subscribers.add(subscriber);
    for (const { request } of Array.from(this.pending.values()))
      subscriber(request);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}

export interface WorkerPipelineHostRequestHandlers {
  instructions: {
    'worker.pipeline.hostRequest.respond': CanopyInstructionHandler<
      'worker.pipeline.hostRequest.respond',
      CanopyHandlerContext
    >;
  };
  streams: Pick<
    CanopyStreamHandlerMap<CanopyHandlerContext>,
    'worker.pipeline.hostRequests'
  >;
}

export function createWorkerPipelineHostRequestHandlers(
  broker: PipelineHostRequestBroker,
): WorkerPipelineHostRequestHandlers {
  return {
    instructions: {
      'worker.pipeline.hostRequest.respond': (
        { executionId, requestId, result },
        context,
      ): Promise<WorkerPipelineHostRespondResult> =>
        Promise.resolve(
          broker.respond(
            executionId,
            requestId,
            result,
            context.execution?.pipelineOwnerValues,
            context.execution?.pipelineHostStep,
          ),
        ),
    },
    streams: {
      'worker.pipeline.hostRequests': (
        _params,
        _context,
        sink,
      ): Promise<() => void> => {
        let stop: (() => void) | null = null;
        stop = broker.subscribe((item) => {
          if (sink.emit(item) === null) stop?.();
        });
        return Promise.resolve(() => stop?.());
      },
    },
  };
}

/** The owning core's caller for settling host requests. */
export function pipelineHostCoreCaller(
  authorityId: string,
): CanopyCallerDescriptor {
  return {
    principalId: 'core',
    clientInstanceId: 'core-pipeline-host-requests',
    authorityId,
    interfaceKind: 'desktop',
    grants: [WORKER_PIPELINE_GRANTS.host],
  };
}

/**
 * The core side: subscribe to a worker's host requests, apply core policy to
 * each and settle it. An unexpected error, or a result the boundary refuses,
 * is settled as a redacted failure; its detail stays with `onError`.
 */
export async function settlePipelineHostRequests(options: {
  dispatcher: Pick<CanopyDispatcher, 'openStream' | 'instruction'>;
  caller: CanopyCallerDescriptor;
  apply(
    request: WorkerPipelineHostRequest,
    signal: AbortSignal,
  ): Promise<WorkerPipelineHostResult | PipelineOwnerSettlement>;
  onError?(error: unknown, request: WorkerPipelineHostRequest): void;
}): Promise<() => void> {
  const controller = new AbortController();
  const handle = await options.dispatcher.openStream(
    'worker.pipeline.hostRequests',
    {},
    {
      caller: options.caller,
      signal: controller.signal,
      onFrame: (frame) => {
        if (frame.kind !== 'item') return;
        const item = frame.item;
        if (!isHostRequestsItem(item) || isWorkerPipelineHostWithdrawal(item))
          return;
        const request = item;
        void (async (): Promise<void> => {
          let settlement: PipelineOwnerSettlement;
          try {
            const applied = await options.apply(request, controller.signal);
            settlement = 'status' in applied ? { result: applied } : applied;
          } catch (error) {
            options.onError?.(error, request);
            settlement = { result: UNEXPECTED };
          }
          const respond = (
            settled: PipelineOwnerSettlement,
          ): Promise<unknown> =>
            options.dispatcher.instruction(
              'worker.pipeline.hostRequest.respond',
              {
                executionId: request.executionId,
                requestId: request.requestId,
                result: settled.result,
              },
              {
                caller: options.caller,
                metadata: {},
                ...(settled.values
                  ? {
                      execution: {
                        childEnvironment: {},
                        pipelineOwnerValues: settled.values,
                      },
                    }
                  : {}),
              },
            );
          await respond(settlement).catch((error: unknown) => {
            if (settlement.result === UNEXPECTED) return undefined;
            options.onError?.(error, request);
            return respond({ result: UNEXPECTED }).catch(() => undefined);
          });
        })();
      },
    },
  );
  return () => {
    controller.abort();
    handle.close();
  };
}

function isHostRequestsItem(
  value: unknown,
): value is WorkerPipelineHostRequestsItem {
  return typeof value === 'object' && value !== null && 'requestId' in value;
}
