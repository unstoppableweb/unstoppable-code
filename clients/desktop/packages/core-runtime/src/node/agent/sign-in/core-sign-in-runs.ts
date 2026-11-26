import {
  WORKER_AGENT_SIGN_IN_FAILED_CODE,
  WORKER_AGENT_SIGN_IN_FAILED_MESSAGE,
  WorkerAgentSignInRunResultSchema,
  type CanopyErrorPayload,
  type OperationFailure,
  type OperationOrigin,
  type OperationOwner,
  type WorkerAgentSignInRunParams,
  type WorkerAgentSignInRunResult,
} from '@canopy/protocol/canopy-core';

import type { LocalWorkerExecution } from '../../operations/local-worker';
import type { OperationServicePort } from '../../operations/service';

export const CORE_SIGN_IN_RUN_KIND = 'core.signIn.run';
export const WORKER_AGENT_SIGN_IN_RUN = 'worker.agent.signIn.run';

const SIGN_IN_FAILED: CanopyErrorPayload = {
  kind: 'internal',
  code: WORKER_AGENT_SIGN_IN_FAILED_CODE,
  message: WORKER_AGENT_SIGN_IN_FAILED_MESSAGE,
  retry: { kind: 'never' },
};
const OUTCOME_UNKNOWN: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.outcomeUnknown',
  message: 'The local worker did not report how this sign-in ended.',
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

export interface CoreSignInRunRequest {
  params: WorkerAgentSignInRunParams;
  origin: OperationOrigin;
  owner: OperationOwner;
}

export interface CoreSignInRunOptions {
  signal?: AbortSignal;
  cancelledBy?: string;
}

export type CoreSignInRunResult =
  | {
      status: 'succeeded';
      signInRunId: string;
      operationId: string;
      result: Extract<WorkerAgentSignInRunResult, { status: 'succeeded' }>;
    }
  | {
      status: 'failed';
      signInRunId: string;
      operationId: string;
      error: CanopyErrorPayload;
      result: Extract<WorkerAgentSignInRunResult, { status: 'failed' }> | null;
    }
  | {
      status: 'cancelled';
      signInRunId: string;
      operationId: string;
      result: Extract<
        WorkerAgentSignInRunResult,
        { status: 'cancelled' }
      > | null;
    };

export class CoreSignInRuns {
  constructor(
    private readonly options: {
      operations: OperationServicePort;
      localWorker: LocalWorkerExecution;
    },
  ) {
    options.operations.registerDomain({
      domain: 'core.signIn',
      kinds: [CORE_SIGN_IN_RUN_KIND],
      restartClass: 'lost',
      cancel: () => Promise.resolve('requested'),
    });
  }

  async run(
    request: CoreSignInRunRequest,
    runOptions: CoreSignInRunOptions = {},
  ): Promise<CoreSignInRunResult> {
    const { operations, localWorker } = this.options;
    const { params } = request;
    const { operation: parent } = await operations.admit({
      kind: CORE_SIGN_IN_RUN_KIND,
      status: 'running',
      origin: request.origin,
      owner: request.owner,
      scope: {},
    });
    const base = {
      signInRunId: params.signInRunId,
      operationId: parent.operationId,
    };
    const onAbort = (): void => {
      void operations
        .cancel(parent.operationId, {
          reason: 'The caller stopped this sign-in.',
          requestedBy: runOptions.cancelledBy ?? 'core',
        })
        .catch(() => undefined);
    };
    const { signal } = runOptions;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const dispatched = await localWorker.dispatch({
        parentOperationId: parent.operationId,
        operation: WORKER_AGENT_SIGN_IN_RUN,
        params,
        idempotencyKey: params.signInRunId,
      });
      const parsed = WorkerAgentSignInRunResultSchema.safeParse(
        dispatched.result,
      );
      if (dispatched.operation.status === 'completed' && parsed.success) {
        const result = parsed.data;
        if (result.status === 'succeeded') {
          await operations.finishOrRecord(parent.operationId, {
            status: 'completed',
            outcome: result,
          });
          return { ...base, status: 'succeeded', result };
        }
        if (result.status === 'failed') {
          await operations.finishOrRecord(parent.operationId, {
            status: 'failed',
            error: SIGN_IN_FAILED,
          });
          return { ...base, status: 'failed', error: SIGN_IN_FAILED, result };
        }
      }
      if (
        dispatched.operation.status === 'cancelled' ||
        (dispatched.operation.status === 'completed' &&
          parsed.success &&
          parsed.data.status === 'cancelled')
      ) {
        await operations.finishOrRecord(parent.operationId, {
          status: 'cancelled',
        });
        return {
          ...base,
          status: 'cancelled',
          result:
            parsed.success && parsed.data.status === 'cancelled'
              ? parsed.data
              : null,
        };
      }
      const error = dispatched.operation.error
        ? toErrorPayload(dispatched.operation.error)
        : OUTCOME_UNKNOWN;
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error,
      });
      return { ...base, status: 'failed', error, result: null };
    } catch (error) {
      const current = await operations
        .get(parent.operationId)
        .catch(() => null);
      if (signal?.aborted || current?.cancellation) {
        await operations.finishOrRecord(parent.operationId, {
          status: 'cancelled',
        });
        return { ...base, status: 'cancelled', result: null };
      }
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error: {
          kind: 'internal',
          message: 'This sign-in could not be dispatched.',
          retry: { kind: 'never' },
        },
      });
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
