import type {
  ScriptExecutionObserver,
  ScriptExecutionWorker,
  WorkerScriptHandlers,
} from '@canopy/core-runtime/node/script/execution';
import { randomUUID } from 'node:crypto';
import { KeyedOutcomes } from '@canopy/core-runtime/node/operations';
import {
  createWorkerScriptHandlers,
  idempotencyKeyReusedError,
} from '@canopy/core-runtime/node/script/execution';
import type { WorkerScriptExecutionClearResult } from '@canopy/protocol/canopy-core';
import { recordDaemonRoute } from './daemon-route-telemetry';
import {
  currentDaemonScriptRoute,
  isDaemonScriptRunEligible,
} from '../lib/daemon-script-route-context';

/*
 * Registers `worker.script.*` on the desktop dispatcher (CAN-4143) over this
 * process's local worker script execution. The worker and its host load on
 * the first script call, because the host modules import back into the
 * runtime. A renderer run the `script:run` handler routed runs in the daemon
 * instead (CAN-5087).
 */

export interface WorkerScriptAdapter extends WorkerScriptHandlers {
  /** The worker's in-process observation of a run, for core script runs. */
  observe(
    executionId: string,
    observer: ScriptExecutionObserver,
  ): Promise<() => void>;
}

export function createWorkerScriptAdapter(
  load: () => Promise<ScriptExecutionWorker> = async () =>
    (await import('../lib/script-runner')).desktopScriptWorker,
): WorkerScriptAdapter {
  let loading: Promise<WorkerScriptHandlers> | undefined;
  let worker: Promise<ScriptExecutionWorker> | undefined;
  const loadWorker = (): Promise<ScriptExecutionWorker> => (worker ??= load());
  const handlers = (): Promise<WorkerScriptHandlers> =>
    (loading ??= loadWorker().then(createWorkerScriptHandlers));
  // One replay for a clear on either route: the daemon and this process keep
  // separate outcomes, so a retry after the route changes would miss its own.
  // A rejection is not kept, so a retry sends the same key again.
  const clears = new KeyedOutcomes<WorkerScriptExecutionClearResult>({
    reusedError: idempotencyKeyReusedError,
    forget: (): boolean => true,
  });
  return {
    queries: {
      // The daemon reads the same run logs, never signalling a run's process
      // as it reads (CAN-7663).
      'worker.script.execution.get': async (params, context) => {
        const reads = await import('../lib/daemon-script-read-route');
        return reads.readScriptRunsInDaemon(
          'get',
          params.scope,
          (session) =>
            session.query('worker.script.execution.get', params, {
              signal: context.signal,
            }),
          async () =>
            (await handlers()).queries['worker.script.execution.get'](
              params,
              context,
            ),
        );
      },
      'worker.script.execution.list': async (params, context) => {
        const reads = await import('../lib/daemon-script-read-route');
        return reads.readScriptRunsInDaemon(
          'list',
          params.scope,
          (session) =>
            session.query('worker.script.execution.list', params, {
              signal: context.signal,
            }),
          async () =>
            (await handlers()).queries['worker.script.execution.list'](
              params,
              context,
            ),
        );
      },
      // Read from the shared run logs and the host's process table, so the
      // daemon answers it on a selected host (CAN-7663).
      'worker.script.execution.groupMembers': async (params, context) => {
        const reads = await import('../lib/daemon-script-read-route');
        return reads.readScriptRunsInDaemon(
          'groupMembers',
          params.scope,
          (session) =>
            session.query('worker.script.execution.groupMembers', params, {
              signal: context.signal,
            }),
          async () =>
            (await handlers()).queries['worker.script.execution.groupMembers'](
              params,
              context,
            ),
        );
      },
    },
    instructions: {
      // The daemon branch needs no keyed replay: LocalWorkerExecution never
      // sends a dispatch twice, and a lost reply is resolved through the
      // executor receipt of this handler's result.
      'worker.script.execute': async (params, context) => {
        const route = currentDaemonScriptRoute();
        const runEligible = isDaemonScriptRunEligible(params);
        if (route !== undefined && !runEligible)
          recordDaemonRoute('scripts', 'run_kind');
        if (route !== undefined && runEligible && route.claim()) {
          const daemon = await import('../lib/daemon-script-route');
          const { result, servedByDaemon } = await daemon.executeScriptInDaemon(
            {
              params,
              signal: context.signal,
              worker: await loadWorker(),
            },
          );
          if (servedByDaemon) route.servedByDaemon();
          return result;
        }
        return (await handlers()).instructions['worker.script.execute'](
          params,
          context,
        );
      },
      'worker.script.execution.cancel': async (params, context) =>
        (await handlers()).instructions['worker.script.execution.cancel'](
          params,
          context,
        ),
      // Electron main and the daemon change the same run logs under one lock
      // (CAN-5087, CAN-5839), so the daemon clears on a selected host (CAN-7663).
      'worker.script.execution.clear': (params, context) =>
        clears.run(context, params, async () => {
          const writes = await import('../lib/daemon-script-write-route');
          return writes.clearScriptRunInDaemon(
            params,
            writes.forwardedClearKey(
              context.caller.principalId,
              context.metadata.idempotencyKey ?? randomUUID(),
            ),
            async () =>
              (await handlers()).instructions['worker.script.execution.clear'](
                params,
                context,
              ),
          );
        }),
      'worker.script.execution.stop': async (params, context) =>
        (await handlers()).instructions['worker.script.execution.stop'](
          params,
          context,
        ),
    },
    observe: async (executionId, observer) =>
      (await loadWorker()).observe(executionId, observer),
  };
}
