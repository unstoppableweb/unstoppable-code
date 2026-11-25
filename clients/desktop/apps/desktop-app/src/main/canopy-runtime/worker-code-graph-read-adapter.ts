import {
  createWorkerCodeGraphReadHandlers,
  type CodeGraphReadWorker,
  type WorkerCodeGraphReadHandlers,
} from '@canopy/core-runtime/node/code-graph';
import type { WorkerCodeGraphQueryResult } from '@canopy/protocol/canopy-core';
import { onDaemonCodeGraphRoute } from '../code-graph/daemon-code-graph-route-context';

/*
 * Registers the worker's code-graph reads (CAN-4150) on the desktop
 * dispatcher over this process's code-graph read service: queries, status,
 * snapshot export and import, and custom-language validation. The service
 * loads on the first call: its host modules import the build and read
 * schedulers and the engine's snapshot and language modules.
 */

export function createWorkerCodeGraphReadAdapter(
  load: () => Promise<CodeGraphReadWorker> = async () =>
    (await import('../code-graph/read-service-host'))
      .desktopCodeGraphReadWorker,
): WorkerCodeGraphReadHandlers {
  let loading: Promise<CodeGraphReadWorker> | undefined;
  const loaded = (): Promise<CodeGraphReadWorker> => (loading ??= load());
  const handlers = createWorkerCodeGraphReadHandlers({
    status: async (scope) => (await loaded()).status(scope),
    query: async (params, signal) => (await loaded()).query(params, signal),
    exportSnapshot: async (params, signal) =>
      (await loaded()).exportSnapshot(params, signal),
    importSnapshot: async (params, signal) =>
      (await loaded()).importSnapshot(params, signal),
    validateLanguages: async (params, signal) =>
      (await loaded()).validateLanguages(params, signal),
  });
  return {
    queries: {
      // A selected agent status read may take the daemon route (CAN-5093).
      'worker.codeGraph.status.get': (params, context) =>
        onDaemonCodeGraphRoute(
          (daemon) =>
            daemon.readCodeGraphScopeInDaemon(
              'worker.codeGraph.status.get',
              params,
            ),
          async () =>
            handlers.queries['worker.codeGraph.status.get'](params, context),
        ),
      // A renderer worktree summary may take the daemon route (CAN-5089).
      'worker.codeGraph.query': (params, context) => {
        const inProcess = async (): Promise<WorkerCodeGraphQueryResult> =>
          handlers.queries['worker.codeGraph.query'](params, context);
        return 'kind' in params.scope
          ? inProcess()
          : onDaemonCodeGraphRoute(
              (daemon) => daemon.queryCodeGraphInDaemon(params),
              inProcess,
            );
      },
      'worker.codeGraph.snapshot.export':
        handlers.queries['worker.codeGraph.snapshot.export'],
      // A selected steering language check may take the daemon route (CAN-5093).
      'worker.codeGraph.languages.validate': (params, context) =>
        onDaemonCodeGraphRoute(
          (daemon) =>
            daemon.readCodeGraphScopeInDaemon(
              'worker.codeGraph.languages.validate',
              params,
            ),
          async () =>
            handlers.queries['worker.codeGraph.languages.validate'](
              params,
              context,
            ),
        ),
    },
    instructions: {
      'worker.codeGraph.snapshot.import':
        handlers.instructions['worker.codeGraph.snapshot.import'],
    },
  };
}
