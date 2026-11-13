import type {
  ScriptExecutionObserver,
  ScriptExecutionWorker,
  WorkerScriptHandlers,
} from '@canopy/core-runtime/node/script/execution';
import { createWorkerScriptHandlers } from '@canopy/core-runtime/node/script/execution';
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
  return {
    queries: {
      'worker.script.execution.get': async (params, context) =>
        (await handlers()).queries['worker.script.execution.get'](
          params,
          context,
        ),
      'worker.script.execution.list': async (params, context) =>
        (await handlers()).queries['worker.script.execution.list'](
          params,
          context,
        ),
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
    },
    observe: async (executionId, observer) =>
      (await loadWorker()).observe(executionId, observer),
  };
}
