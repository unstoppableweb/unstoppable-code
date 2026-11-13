import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_LIST_LIMIT_MAX,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  WORKER_PIPELINE_RUNNER_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  type WorkerPipelineDataExportParams,
  type WorkerPipelineDataExportResult,
  type WorkerPipelineDataImportParams,
  type WorkerPipelineDataImportResult,
} from '@canopy/protocol/canopy-core';
import {
  defineRuntimeModule,
  type RuntimeModule,
} from '../../../kernel/runtime-profile-graph';
import type { CanopyRuntimeHandlerMaps } from '../../../runtime/types';
import type { ExecutionSecretSource } from '../../execution-secrets';
import {
  createPipelineOwnerChannel,
  type PipelineOwnerChannel,
} from '../execution/owner-channel';
import {
  withPipelineEventJournal,
  type PipelineEventJournal,
} from '../execution/event-journal';
import {
  createWorkerPipelineHandlers,
  pipelineDataBusyError,
} from '../execution/worker-pipelines';
import {
  PipelineHostSupervisor,
  type PipelineHostSupervisorOptions,
} from './supervisor';

/**
 * Every `worker.pipeline.*` operation a supervised pipeline host serves
 * (CAN-5086): the daemon's set, which a cloud runner serves too (CAN-6173).
 * The daemon serves no recovery control, sweep or checkpoint (D10): the app
 * that started a run resumes it.
 */
export const PIPELINE_HOST_DEFINITIONS = {
  queries: {
    'worker.pipeline.execution.get':
      WORKER_PIPELINE_QUERY_DEFINITIONS['worker.pipeline.execution.get'],
    // The detail and list reads a cloud runner's web core needs (CAN-6117).
    'worker.pipeline.execution.list':
      WORKER_PIPELINE_QUERY_DEFINITIONS['worker.pipeline.execution.list'],
  },
  instructions: {
    'worker.pipeline.execution.start':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.start'
      ],
    'worker.pipeline.execution.cancel':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.execution.cancel'
      ],
    // The owner settles host steps (CAN-5771); only an owner connection is advertised them.
    'worker.pipeline.hostRequest.respond':
      WORKER_PIPELINE_INSTRUCTION_DEFINITIONS[
        'worker.pipeline.hostRequest.respond'
      ],
  },
  streams: {
    'worker.pipeline.execution.events':
      WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.execution.events'],
    // The owner settles host steps (CAN-5771); only an owner connection is advertised them.
    'worker.pipeline.hostRequests':
      WORKER_PIPELINE_STREAM_DEFINITIONS['worker.pipeline.hostRequests'],
  },
};

/**
 * The recovery controls a cloud runner serves (CAN-6103, P8): it has no
 * other executor to resume its paused runs. The matrix controls, the sweep
 * and the shutdown checkpoint stay unserved.
 */
const PIPELINE_RECOVERY_DEFINITIONS = {
  'worker.pipeline.execution.resume':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.resume'],
  'worker.pipeline.execution.retry':
    WORKER_PIPELINE_INSTRUCTION_DEFINITIONS['worker.pipeline.execution.retry'],
};

/** The operations only a cloud runner serves (CAN-6199, CAN-6103). */
const PIPELINE_RUNNER_ONLY_DEFINITIONS = {
  ...WORKER_PIPELINE_RUNNER_INSTRUCTION_DEFINITIONS,
  ...PIPELINE_RECOVERY_DEFINITIONS,
};

/**
 * Every `worker.pipeline.*` operation a cloud runner serves: the daemon's
 * set, one run's graceful checkpoint (CAN-6199), so its owner can roll the
 * runner's sandbox over, resume and retry for its own runs (CAN-6103), and
 * the pipeline data import and export (CAN-6317), so its owner can keep a
 * pipeline's data between runs.
 */
export const PIPELINE_RUNNER_DEFINITIONS = {
  queries: PIPELINE_HOST_DEFINITIONS.queries,
  instructions: {
    ...PIPELINE_HOST_DEFINITIONS.instructions,
    ...PIPELINE_RUNNER_ONLY_DEFINITIONS,
  },
  streams: PIPELINE_HOST_DEFINITIONS.streams,
};

export interface PipelineHostModuleOptions {
  /** The supervisor's options; the module supplies its owner channel. */
  readonly supervisor: Omit<PipelineHostSupervisorOptions, 'owner'>;
  /**
   * The owner endpoint (CAN-5771): the channel that holds the owner's
   * `worker.pipeline.hostRequests` subscription and settles its requests.
   * A host composes it from its own transport; omitted, the module makes one.
   */
  readonly owner?: PipelineOwnerChannel;
  /** Redeems a start's secret bindings (CAN-5067). */
  readonly secrets: ExecutionSecretSource;
  /**
   * The execution target this host serves, which a list request may name.
   * Default: the in-process worker, as the daemon's bundled worker is.
   */
  readonly targetId?: string;
  /**
   * The event journal (CAN-6161) a cloud runner keeps, so events streams
   * resume after a cursor across relay outages. The daemon keeps none.
   */
  readonly journal?: PipelineEventJournal;
  /** Phase 5, after the supervisor stopped: stops what its hosts ran on. */
  readonly stopHosts?: () => Promise<void>;
  /**
   * Serve a cloud runner's own operations under
   * {@link PIPELINE_RUNNER_DEFINITIONS}: one run's checkpoint (CAN-6199),
   * resume and retry for the runs the supervisor started from a portable
   * launch (CAN-6103), and `worker.pipeline.data.*` over `pipelineData`
   * (CAN-6317). The daemon serves none of them.
   */
  readonly runnerOperations?: { readonly pipelineData: PipelineRunnerDataPort };
}

/**
 * Where a cloud runner keeps each pipeline's data (CAN-6317). The module
 * refuses either call with `worker.pipeline.dataBusy` while a run of the
 * pipeline is pending or running, so the data is never read or replaced
 * mid-write.
 */
export interface PipelineRunnerDataPort {
  importData(
    params: WorkerPipelineDataImportParams,
  ): Promise<WorkerPipelineDataImportResult>;
  exportData(
    params: WorkerPipelineDataExportParams,
  ): Promise<WorkerPipelineDataExportResult>;
}

/** The handlers a pipeline host module serves, for a host to bind to its transport. */
export type PipelineHostHandlers = CanopyRuntimeHandlerMaps<
  (typeof PIPELINE_HOST_DEFINITIONS)['queries'],
  (typeof PIPELINE_HOST_DEFINITIONS)['instructions'],
  (typeof PIPELINE_HOST_DEFINITIONS)['streams']
>;

/** The handlers of a cloud runner's own operations (CAN-6199, CAN-6103). */
export type PipelineRunnerOnlyHandlers = CanopyRuntimeHandlerMaps<
  Record<never, never>,
  typeof PIPELINE_RUNNER_ONLY_DEFINITIONS,
  Record<never, never>
>['instructions'];

export interface PipelineHostModule {
  readonly module: RuntimeModule;
  /** The daemon's set, served by every pipeline host module. */
  readonly handlers: PipelineHostHandlers;
  /**
   * The runner's own operations, with `runnerOperations`; `null` without.
   * A runner binds them beside `handlers` under {@link PIPELINE_RUNNER_DEFINITIONS}.
   */
  readonly runnerHandlers: PipelineRunnerOnlyHandlers | null;
  readonly supervisor: PipelineHostSupervisor;
  readonly owner: PipelineOwnerChannel;
}

/**
 * `worker.pipeline.*` over a supervised pipeline host: the composition the
 * daemon (CAN-5086) and the cloud runner (CAN-6173, decision P1) share. Phase
 * 5 checkpoints every running execution, then stops the host.
 */
export function createPipelineHostModule(
  options: PipelineHostModuleOptions,
): PipelineHostModule {
  const owner = options.owner ?? createPipelineOwnerChannel();
  const supervisor = new PipelineHostSupervisor({
    ...options.supervisor,
    owner,
  });
  const { journal } = options;
  const all = createWorkerPipelineHandlers(
    journal ? withPipelineEventJournal(supervisor, journal) : supervisor,
    {
      secrets: options.secrets,
      ...(options.targetId !== undefined && { targetId: options.targetId }),
      ...(journal && { journal }),
    },
  );
  const handlers = {
    queries: {
      'worker.pipeline.execution.get':
        all.queries['worker.pipeline.execution.get'],
      'worker.pipeline.execution.list':
        all.queries['worker.pipeline.execution.list'],
    },
    instructions: {
      'worker.pipeline.execution.start':
        all.instructions['worker.pipeline.execution.start'],
      'worker.pipeline.execution.cancel':
        all.instructions['worker.pipeline.execution.cancel'],
      'worker.pipeline.hostRequest.respond':
        owner.handlers.instructions['worker.pipeline.hostRequest.respond'],
    },
    streams: {
      'worker.pipeline.execution.events':
        all.streams['worker.pipeline.execution.events'],
      'worker.pipeline.hostRequests':
        owner.handlers.streams['worker.pipeline.hostRequests'],
    },
  };
  // A pending or running run of the pipeline may be writing its data. The
  // list reads stored state, which can trail a run that just ended, so each
  // run it names is read again before the call is refused.
  const refuseWhileRunning = async (data: {
    readonly owner: string;
    readonly pipelineId: string;
  }): Promise<void> => {
    const page = await supervisor.list({
      owner: data.owner,
      pipelineId: data.pipelineId,
      statuses: ['pending', 'running'],
      detail: false,
      after: null,
      limit: WORKER_PIPELINE_LIST_LIMIT_MAX,
    });
    for (const { execution } of page.executions) {
      const current = await supervisor.get(execution.executionId);
      if (current?.status === 'pending' || current?.status === 'running')
        throw pipelineDataBusyError();
    }
  };
  const pipelineData = options.runnerOperations?.pipelineData;
  const runnerHandlers: PipelineRunnerOnlyHandlers | null = pipelineData
    ? {
        'worker.pipeline.execution.checkpoint': async ({
          executionId,
          drainMs,
        }) => ({
          execution: await supervisor.checkpointExecution({
            executionId,
            drainMs,
          }),
        }),
        // A runner has no other executor to resume its runs (CAN-6103, P8).
        'worker.pipeline.execution.resume':
          all.instructions['worker.pipeline.execution.resume'],
        'worker.pipeline.execution.retry':
          all.instructions['worker.pipeline.execution.retry'],
        'worker.pipeline.data.import': async (params) => {
          await refuseWhileRunning(params);
          return pipelineData.importData(params);
        },
        'worker.pipeline.data.export': async (params) => {
          await refuseWhileRunning(params);
          return pipelineData.exportData(params);
        },
      }
    : null;
  const module = defineRuntimeModule({
    name: 'worker.pipeline',
    plane: 'worker',
    services: [
      {
        name: 'worker.pipeline.host',
        plane: 'worker',
        stop: {
          5: async (): Promise<void> => {
            await supervisor.stop();
            await options.stopHosts?.();
          },
        },
      },
    ],
    ...(runnerHandlers
      ? {
          definitions: PIPELINE_RUNNER_DEFINITIONS,
          handlers: {
            ...handlers,
            instructions: { ...handlers.instructions, ...runnerHandlers },
          },
        }
      : { definitions: PIPELINE_HOST_DEFINITIONS, handlers }),
  });
  return { module, handlers, runnerHandlers, supervisor, owner };
}
