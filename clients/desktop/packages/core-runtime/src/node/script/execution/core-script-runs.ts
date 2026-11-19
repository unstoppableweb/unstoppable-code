import { createHash, randomUUID } from 'node:crypto';
import { executionSecretFingerprints } from '../../execution-secrets';

import {
  WorkerScriptExecuteResultSchema,
  type CanopyErrorPayload,
  type OperationFailure,
  type OperationOrigin,
  type OperationOwner,
  type OperationRecord,
  type WorkerScriptExecuteParams,
  type WorkerScriptExecuteResult,
} from '@canopy/protocol/canopy-core';
import { stableStringify } from '@canopy/protocol/plans';

import { OperationLedgerRefusedError } from '../../operations/ledger/errors';
import type { LocalWorkerExecution } from '../../operations/local-worker';
import type { OperationService } from '../../operations/service';
import type { ScriptExecutionObserver } from './worker-scripts';

/** The parent operation of one script run; its child is the dispatch. */
export const CORE_SCRIPT_RUN_KIND = 'core.script.run';
const WORKER_SCRIPT_EXECUTE = 'worker.script.execute';
/** Whose receipts a keyed run's operation records. */
const RUN_RECEIPT_CALLER = 'core.script.run';

function digest(value: unknown): string {
  return `sha256:${createHash('sha256')
    .update(stableStringify(value) ?? 'null')
    .digest('hex')}`;
}

/** What a keyed run's execution id is bound to. */
interface ScriptRunIdentity {
  workspaceId: string | undefined;
  worktreeId: string | undefined;
  scriptKey: string | undefined;
}

function sameScriptRun(a: ScriptRunIdentity, b: ScriptRunIdentity): boolean {
  return (
    a.workspaceId === b.workspaceId &&
    a.worktreeId === b.worktreeId &&
    a.scriptKey === b.scriptKey
  );
}

function runReceipt(target: ScriptRunIdentity & { executionId: string }): {
  caller: string;
  idempotencyKey: string;
  fingerprint: string;
} {
  return {
    caller: RUN_RECEIPT_CALLER,
    idempotencyKey: target.executionId,
    fingerprint: digest([
      target.workspaceId ?? null,
      target.worktreeId ?? null,
      target.scriptKey ?? null,
    ]),
  };
}

const ALREADY_STARTED: CanopyErrorPayload = {
  kind: 'already_exists',
  message: 'This request already started a script run, so none was started.',
  retry: { kind: 'never' },
};

const KEY_REUSED: CanopyErrorPayload = {
  kind: 'conflict',
  message:
    'This request was already used to run another script, so none was started.',
  retry: { kind: 'never' },
};

const OUTCOME_UNKNOWN: CanopyErrorPayload = {
  kind: 'unavailable',
  code: 'core.delegation.outcomeUnknown',
  message: 'The local worker did not report how this script run ended.',
  retry: { kind: 'never' },
};

function isPlaneQualifiedCode(
  code: string,
): code is `core.${string}.${string}` | `worker.${string}.${string}` {
  return /^(core|worker)\.[^.]+\..+$/.test(code);
}

/** A recorded failure as an error payload, keeping a plane-qualified code. */
function toErrorPayload(failure: OperationFailure): CanopyErrorPayload {
  const { code, ...rest } = failure;
  return code !== undefined && isPlaneQualifiedCode(code)
    ? { ...rest, code }
    : rest;
}

export interface CoreScriptRunRequest {
  params: Omit<WorkerScriptExecuteParams, 'executionId'> & {
    executionId?: string;
  };
  /** What started the run: a client, a hook, an automation or the system. */
  origin: OperationOrigin;
  owner: OperationOwner;
  /**
   * Admit the run under a receipt keyed by its execution id and bound to its
   * workspace, worktree and script key. A key already held starts nothing:
   * the run fails as already started, or as reused for another script.
   */
  keyed?: boolean;
}

export interface CoreScriptRunOptions {
  /** Cancels the run through its operation, from any caller. */
  signal?: AbortSignal;
  /** In-process observation of the run; see {@link ScriptExecutionObserver}. */
  observer?: ScriptExecutionObserver;
  /** The principal recorded on a cancellation the signal requests. */
  cancelledBy?: string;
}

export type CoreScriptRunResult =
  | {
      status: 'completed';
      executionId: string;
      operationId: string;
      result: WorkerScriptExecuteResult;
    }
  | {
      status: 'cancelled';
      executionId: string;
      operationId: string;
      error: null;
    }
  | {
      status: 'failed';
      executionId: string;
      /** Null when nothing was admitted, as for a refused keyed run. */
      operationId: string | null;
      error: CanopyErrorPayload | null;
    };

/**
 * A keyed run already started under an execution id: still in this process,
 * or recorded by its receipt in the operation ledger, whose `core.script.run`
 * rows are kept. `conflict` is the key held for another script.
 */
export type CoreScriptRunLookup =
  | { status: 'in_flight' }
  | { status: 'conflict' }
  | { status: 'completed'; result: WorkerScriptExecuteResult }
  | { status: Exclude<OperationRecord['status'], 'completed'> };

/**
 * Core-side script runs (CAN-4143). Each run is a `core.script.run`
 * operation whose child is the `worker.script.execute` dispatch to the local
 * worker, recorded with its target, lease and secret fingerprints before the
 * process starts (CAN-4132):
 *
 * - Any client cancels a run through `core.operation.cancel`; the
 *   cancellation reaches the dispatch and stops that process.
 * - Runs are `lost` across a restart: neither the parent nor the dispatch
 *   is run again, and the run log reports the run as lost.
 * - A script that exits non-zero is a completed run with a `failed` result;
 *   the operation fails only when the worker could not run it.
 */
interface InFlightScriptRun extends ScriptRunIdentity {
  stop: AbortController;
  settled: Promise<CoreScriptRunResult>;
}

export class CoreScriptRuns {
  constructor(
    private readonly options: {
      operations: OperationService;
      localWorker: LocalWorkerExecution;
      /** The worker's in-process observation, until CAN-5087's stream. */
      observe: (
        executionId: string,
        observer: ScriptExecutionObserver,
      ) => (() => void) | Promise<() => void>;
    },
  ) {
    options.operations.registerDomain({
      domain: 'core.script',
      kinds: [CORE_SCRIPT_RUN_KIND],
      restartClass: 'lost',
      // The dispatch is cancelled with its parent and stops the process;
      // the run then finishes this operation.
      cancel: () => Promise.resolve('requested'),
    });
  }

  private readonly inFlight = new Map<string, InFlightScriptRun>();

  /**
   * Runs a script. Until the run settles, {@link cancelInFlight} stops it by
   * scope and script key, including before the worker has seen it.
   */
  run(
    request: CoreScriptRunRequest,
    runOptions: CoreScriptRunOptions = {},
  ): Promise<CoreScriptRunResult> {
    const executionId = request.params.executionId ?? randomUUID();
    const identity: ScriptRunIdentity = {
      workspaceId: request.params.scope.workspaceId,
      worktreeId: request.params.scope.worktreeId,
      scriptKey: request.params.record?.script.scriptKey,
    };
    const holder = this.inFlight.get(executionId);
    if (request.keyed && holder)
      return Promise.resolve({
        status: 'failed',
        executionId,
        operationId: null,
        error: sameScriptRun(holder, identity) ? ALREADY_STARTED : KEY_REUSED,
      });
    const stop = new AbortController();
    const callerSignal = runOptions.signal;
    const forward = (): void => stop.abort();
    if (callerSignal?.aborted) stop.abort();
    else callerSignal?.addEventListener('abort', forward, { once: true });
    const settled = this.runOnce(request, executionId, {
      ...runOptions,
      signal: stop.signal,
    }).finally(() => {
      callerSignal?.removeEventListener('abort', forward);
      if (this.inFlight.get(executionId) === entry)
        this.inFlight.delete(executionId);
    });
    const entry: InFlightScriptRun = { ...identity, stop, settled };
    this.inFlight.set(executionId, entry);
    return settled;
  }

  /**
   * The keyed run a caller already started with this execution id, if any. A
   * caller that derives the id from its own request uses it so a retry
   * never starts a second run, including after a restart or when the first
   * answer was lost. The id held for another script, workspace or worktree
   * is a conflict.
   */
  async find(target: {
    workspaceId: string;
    worktreeId: string;
    executionId: string;
    scriptKey: string;
  }): Promise<CoreScriptRunLookup | null> {
    const live = this.inFlight.get(target.executionId);
    if (live)
      return sameScriptRun(live, target)
        ? { status: 'in_flight' }
        : { status: 'conflict' };
    const recorded = await this.options.operations.lookupReceipt(
      CORE_SCRIPT_RUN_KIND,
      runReceipt(target),
    );
    if (recorded.status === 'none') return null;
    if (recorded.status === 'key-reused') return { status: 'conflict' };
    const { operation } = recorded;
    if (operation.status !== 'completed') return { status: operation.status };
    // A completed run always records the worker's result as its outcome.
    const result = WorkerScriptExecuteResultSchema.safeParse(operation.outcome);
    return result.success
      ? { status: 'completed', result: result.data }
      : { status: 'failed' };
  }

  /**
   * Stops the in-flight runs of a script key, or one of them, wherever they
   * are: waiting for admission, dispatching, or running on the worker. Resolves
   * with each stopped run's result once it has settled.
   */
  async cancelInFlight(target: {
    workspaceId: string;
    worktreeId: string;
    scriptKey: string;
    executionId?: string;
  }): Promise<CoreScriptRunResult[]> {
    const matching = [...this.inFlight.entries()].filter(
      ([executionId, run]) =>
        sameScriptRun(run, target) &&
        (target.executionId === undefined ||
          target.executionId === executionId),
    );
    for (const [, run] of matching) run.stop.abort();
    const results = await Promise.all(
      matching.map(([, run]) => run.settled.catch(() => null)),
    );
    return results.filter(
      (result): result is CoreScriptRunResult => result !== null,
    );
  }

  private async runOnce(
    request: CoreScriptRunRequest,
    executionId: string,
    runOptions: CoreScriptRunOptions,
  ): Promise<CoreScriptRunResult> {
    const { operations, localWorker } = this.options;
    const params: WorkerScriptExecuteParams = {
      ...request.params,
      executionId,
    };
    const stopObserving = runOptions.observer
      ? await this.options.observe(executionId, runOptions.observer)
      : undefined;
    const { workspaceId, worktreeId } = params.scope;
    const admitted = await operations
      .admit({
        kind: CORE_SCRIPT_RUN_KIND,
        status: 'running',
        origin: request.origin,
        owner: request.owner,
        scope: {
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          ...(worktreeId !== undefined ? { worktreeId } : {}),
          executionId,
        },
        ...(params.scope.authorityId !== undefined
          ? { authorityId: params.scope.authorityId }
          : {}),
        ...(request.keyed
          ? {
              receipt: runReceipt({
                workspaceId,
                worktreeId,
                executionId,
                scriptKey: params.record?.script.scriptKey,
              }),
            }
          : {}),
      })
      .catch((error: unknown) => {
        if (
          error instanceof OperationLedgerRefusedError &&
          error.refusal === 'key-reused'
        )
          return null;
        stopObserving?.();
        throw error;
      });
    if (admitted === null || admitted.status !== 'accepted') {
      stopObserving?.();
      return {
        status: 'failed',
        executionId,
        operationId: admitted?.operation.operationId ?? null,
        error: admitted === null ? KEY_REUSED : ALREADY_STARTED,
      };
    }
    const parent = admitted.operation;
    const onAbort = (): void => {
      void operations
        .cancel(parent.operationId, {
          reason: 'The caller stopped this script run.',
          requestedBy: runOptions.cancelledBy ?? 'core',
        })
        .catch(() => undefined);
    };
    const { signal } = runOptions;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const secrets = executionSecretFingerprints(params.secrets);
      const dispatched = await localWorker.dispatch({
        parentOperationId: parent.operationId,
        operation: WORKER_SCRIPT_EXECUTE,
        params,
        idempotencyKey: executionId,
        ...(secrets.length ? { secrets } : {}),
      });
      return await this.finish(parent, executionId, dispatched.operation, {
        result: dispatched.result,
      });
    } catch (error) {
      // A run cancelled before its dispatch was admitted ran nothing.
      const current = await operations
        .get(parent.operationId)
        .catch(() => null);
      if (signal?.aborted || current?.cancellation) {
        await operations.finishOrRecord(parent.operationId, {
          status: 'cancelled',
        });
        return {
          status: 'cancelled',
          executionId,
          operationId: parent.operationId,
          error: null,
        };
      }
      await operations.finishOrRecord(parent.operationId, {
        status: 'failed',
        error: {
          kind: 'internal',
          message: 'This script run could not be dispatched.',
          retry: { kind: 'never' },
        },
      });
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      stopObserving?.();
    }
  }

  private async finish(
    parent: OperationRecord,
    executionId: string,
    child: OperationRecord,
    reply: { result: unknown },
  ): Promise<CoreScriptRunResult> {
    const { operations } = this.options;
    const base = { executionId, operationId: parent.operationId };
    const parsed = WorkerScriptExecuteResultSchema.safeParse(reply.result);
    if (child.status === 'completed' && parsed.success) {
      const result = parsed.data;
      if (result.status === 'cancelled') {
        await operations.finishOrRecord(parent.operationId, {
          status: 'cancelled',
        });
        return { ...base, status: 'cancelled', error: null };
      }
      await operations.finishOrRecord(parent.operationId, {
        status: 'completed',
        outcome: result,
      });
      return { ...base, status: 'completed', result };
    }
    if (child.status === 'cancelled') {
      await operations.finishOrRecord(parent.operationId, {
        status: 'cancelled',
      });
      return { ...base, status: 'cancelled', error: null };
    }
    const error = child.error ? toErrorPayload(child.error) : OUTCOME_UNKNOWN;
    await operations.finishOrRecord(parent.operationId, {
      status: 'failed',
      error,
    });
    return { ...base, status: 'failed', error };
  }
}
