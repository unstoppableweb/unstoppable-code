import {
  WORKER_AGENT_HELPER_FAILED_CODE,
  WORKER_AGENT_HELPER_FAILED_MESSAGE,
  WorkerAgentHelperRunResultSchema,
  type CanopyErrorPayload,
  type OperationFailure,
  type OperationOrigin,
  type OperationOwner,
  type WorkerAgentHelperRunParams,
  type WorkerAgentHelperRunResult,
  type WorkerAgentHelperUsage,
} from '@canopy/protocol/canopy-core';

import type { LocalWorkerExecution } from '../../operations/local-worker';
import type { OperationService } from '../../operations/service';

export const CORE_HELPER_RUN_KIND = 'core.helper.run';
export const WORKER_AGENT_HELPER_RUN = 'worker.agent.helper.run';

const HELPER_FAILED: CanopyErrorPayload = {
  kind: 'internal',
  code: WORKER_AGENT_HELPER_FAILED_CODE,
  message: WORKER_AGENT_HELPER_FAILED_MESSAGE,
  retry: { kind: 'never' },
};
const OUTCOME_UNKNOWN: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.outcomeUnknown',
  message: 'The local worker did not report how this helper run ended.',
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

export interface CoreHelperRunRequest {
  params: WorkerAgentHelperRunParams;
  origin: OperationOrigin;
  owner: OperationOwner;
}

export interface CoreHelperRunOptions {
  signal?: AbortSignal;
  cancelledBy?: string;
}

export type CoreHelperRunResult =
  | {
      status: 'succeeded';
      helperRunId: string;
      operationId: string;
      result: Extract<WorkerAgentHelperRunResult, { status: 'succeeded' }>;
    }
  | {
      status: 'failed';
      helperRunId: string;
      operationId: string;
      error: CanopyErrorPayload;
      usage: WorkerAgentHelperUsage | null;
    }
  | {
      status: 'cancelled';
      helperRunId: string;
      operationId: string;
      usage: WorkerAgentHelperUsage | null;
    };

export class CoreHelperRuns {
  constructor(
    private readonly options: {
      operations: OperationService;
      localWorker: LocalWorkerExecution;
    },
  ) {
    options.operations.registerDomain({
      domain: 'core.helper',
      kinds: [CORE_HELPER_RUN_KIND],
      restartClass: 'lost',
      cancel: () => Promise.resolve('requested'),
    });
  }

  async run(
    request: CoreHelperRunRequest,
    runOptions: CoreHelperRunOptions = {},
  ): Promise<CoreHelperRunResult> {
    const { operations, localWorker } = this.options;
    const { params } = request;
    const {
      workspaceId,
      worktreeId,
      chatId,
      executionId,
      repoId,
      authorityId,
    } = params.scope;
    const { operation: parent } = await operations.admit({
      kind: CORE_HELPER_RUN_KIND,
      status: 'running',
      origin: request.origin,
      owner: request.owner,
      scope: {
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        ...(worktreeId !== undefined ? { worktreeId } : {}),
        ...(chatId !== undefined ? { chatId } : {}),
        ...(executionId !== undefined ? { executionId } : {}),
        ...(repoId !== undefined ? { repoId } : {}),
      },
      ...(authorityId !== undefined ? { authorityId } : {}),
    });
    const base = {
      helperRunId: params.helperRunId,
      operationId: parent.operationId,
    };
    const onAbort = (): void => {
      void operations
        .cancel(parent.operationId, {
          reason: 'The caller stopped this helper run.',
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
        operation: WORKER_AGENT_HELPER_RUN,
        params,
        idempotencyKey: params.helperRunId,
      });
      const parsed = WorkerAgentHelperRunResultSchema.safeParse(
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
            error: HELPER_FAILED,
          });
          return {
            ...base,
            status: 'failed',
            error: HELPER_FAILED,
            usage: result.usage,
          };
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
          usage: parsed.success ? parsed.data.usage : null,
        };
      }
      const error = dispatched.operation.error
        ? toErrorPayload(dispatched.operation.error)
        : OUTCOME_UNKNOWN;
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error,
      });
      return { ...base, status: 'failed', error, usage: null };
    } catch (error) {
      const current = await operations
        .get(parent.operationId)
        .catch(() => null);
      if (signal?.aborted || current?.cancellation) {
        await operations.finishOrRecord(parent.operationId, {
          status: 'cancelled',
        });
        return { ...base, status: 'cancelled', usage: null };
      }
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error: {
          kind: 'internal',
          message: 'This helper run could not be dispatched.',
          retry: { kind: 'never' },
        },
      });
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
