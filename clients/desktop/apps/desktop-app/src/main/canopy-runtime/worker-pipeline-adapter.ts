import { getDesktopExecutionSecrets } from '../execution-secrets/owner';
import {
  createWorkerPipelineHandlers,
  createWorkerPipelineHostRequestHandlers,
  PipelineHostRequestBroker,
  type PipelineExecutionWorker,
  type WorkerPipelineHandlers,
  type WorkerPipelineHostRequestHandlers,
} from '@canopy/core-runtime/node/pipeline';

/*
 * Registers `worker.pipeline.execution.*` on the desktop dispatcher
 * (CAN-4140) over this process's local pipeline worker. The worker loads on
 * the first pipeline call, because its host modules import back into the
 * runtime.
 */

export interface WorkerPipelineAdapter {
  queries: WorkerPipelineHandlers['queries'];
  instructions: WorkerPipelineHandlers['instructions'] &
    WorkerPipelineHostRequestHandlers['instructions'];
  streams: WorkerPipelineHandlers['streams'] &
    WorkerPipelineHostRequestHandlers['streams'];
  /** The loaded worker, for core's run records; `null` before the first call. */
  loaded(): PipelineExecutionWorker | null;
  /** The worker's host step requests, which core settles. */
  readonly hostRequests: PipelineHostRequestBroker;
}

export function createWorkerPipelineAdapter(
  load: () => Promise<PipelineExecutionWorker> = async () =>
    (await import('../pipelines/pipeline-worker-host')).desktopPipelineWorker,
): WorkerPipelineAdapter {
  const hostRequests = new PipelineHostRequestBroker();
  const host = createWorkerPipelineHostRequestHandlers(hostRequests);
  let worker: PipelineExecutionWorker | null = null;
  let loading: Promise<WorkerPipelineHandlers> | undefined;
  const handlers = (): Promise<WorkerPipelineHandlers> =>
    (loading ??= load().then((loadedWorker) => {
      worker = loadedWorker;
      return createWorkerPipelineHandlers(loadedWorker, {
        secrets: getDesktopExecutionSecrets(),
      });
    }));
  return {
    queries: {
      // Main reads a run on the daemon, else in process (CAN-7874).
      'worker.pipeline.execution.get': async (params, context) => {
        const reads = await import('../lib/daemon-pipeline-read-route');
        return reads.readPipelineExecutionInDaemon(
          'get',
          (session) =>
            session.query('worker.pipeline.execution.get', params, {
              signal: context.signal,
            }),
          async () =>
            (await handlers()).queries['worker.pipeline.execution.get'](
              params,
              context,
            ),
        );
      },
      'worker.pipeline.execution.list': async (params, context) =>
        (await handlers()).queries['worker.pipeline.execution.list'](
          params,
          context,
        ),
    },
    instructions: {
      'worker.pipeline.execution.start': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.execution.start'](
          params,
          context,
        ),
      'worker.pipeline.execution.cancel': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.execution.cancel'](
          params,
          context,
        ),
      'worker.pipeline.execution.resume': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.execution.resume'](
          params,
          context,
        ),
      'worker.pipeline.execution.retry': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.execution.retry'](
          params,
          context,
        ),
      'worker.pipeline.matrixJob.retry': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.matrixJob.retry'](
          params,
          context,
        ),
      'worker.pipeline.matrixVariant.cancel': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.matrixVariant.cancel'](
          params,
          context,
        ),
      'worker.pipeline.recovery.sweep': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.recovery.sweep'](
          params,
          context,
        ),
      'worker.pipeline.recovery.checkpoint': async (params, context) =>
        (await handlers()).instructions['worker.pipeline.recovery.checkpoint'](
          params,
          context,
        ),
      'worker.pipeline.hostRequest.respond':
        host.instructions['worker.pipeline.hostRequest.respond'],
    },
    streams: {
      'worker.pipeline.execution.events': async (params, context, sink) =>
        (await handlers()).streams['worker.pipeline.execution.events'](
          params,
          context,
          sink,
        ),
      'worker.pipeline.hostRequests':
        host.streams['worker.pipeline.hostRequests'],
    },
    loaded: () => worker,
    hostRequests,
  };
}
