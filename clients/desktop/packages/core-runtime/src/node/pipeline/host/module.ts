import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_LIST_LIMIT_MAX,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  WORKER_PIPELINE_RUNNER_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
  type WorkerPipelineCapabilitiesImportParams,
  type WorkerPipelineCapabilitiesImportResult,
  type WorkerPipelineDataExportParams,
  type WorkerPipelineDataExportResult,
  type WorkerPipelineDataImportParams,
  type WorkerPipelineDataImportResult,
  type WorkerPipelineExecutionHandoffExportParams,
  type WorkerPipelineExecutionHandoffExportResult,
  type WorkerPipelineExecutionHandoffImportParams,
  type WorkerPipelineExecutionHandoffImportResult,
  type WorkerPipelineExecutionTranscriptExportParams,
  type WorkerPipelineExecutionTranscriptExportResult,
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
  pipelineCapabilitiesRefusedError,
  pipelineDataBusyError,
  pipelineExecutionNotFoundError,
  pipelineHandoffBusyError,
  pipelineHandoffRefusedError,
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
 * runner's sandbox over, resume and retry for its own runs (CAN-6103), the
 * pipeline data import and export (CAN-6317), so its owner can keep a
 * pipeline's data between runs, one run's handoff export and import
 * (CAN-6376), so its owner can resume it on another incarnation, an
 * agent step's transcript export (CAN-6421), so its owner keeps it, and the
 * capability import (CAN-6439), so a run's agent steps get the skills,
 * plugins and MCP servers of its plugin collections.
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
   * launch (CAN-6103), `worker.pipeline.data.*` over `pipelineData`
   * (CAN-6317), `worker.pipeline.execution.handoff.*` over `handoffs`
   * (CAN-6376), `worker.pipeline.execution.transcript.export` over
   * `transcripts` (CAN-6421) and `worker.pipeline.capabilities.import` over
   * `capabilities` (CAN-6439). The daemon serves none of them.
   */
  readonly runnerOperations?: {
    readonly pipelineData: PipelineRunnerDataPort;
    readonly handoffs: PipelineRunnerHandoffPort;
    readonly transcripts: PipelineRunnerTranscriptPort;
    readonly capabilities: PipelineRunnerCapabilityPort;
  };
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

/**
 * Where a cloud runner packs and restores one run's handoff (CAN-6376): its
 * execution directory and the provider sessions its agent steps recorded.
 * The module refuses an export of a run the runner does not hold, and
 * either call with `worker.pipeline.handoffBusy` while the run is pending
 * or running, so the store is never read or replaced mid-write; an import
 * once the lease ended is refused `worker.pipeline.handoffRefused`.
 */
export interface PipelineRunnerHandoffPort {
  exportHandoff(
    params: WorkerPipelineExecutionHandoffExportParams,
  ): Promise<WorkerPipelineExecutionHandoffExportResult>;
  /**
   * Restores only while `context.leaseHeld()` answers true: the port writes
   * outside the host's lease fence, so it asks again before and after it
   * copies the run.
   */
  importHandoff(
    params: WorkerPipelineExecutionHandoffImportParams,
    context: { readonly leaseHeld: () => boolean },
  ): Promise<WorkerPipelineExecutionHandoffImportResult>;
}

/**
 * Where a cloud runner reads an agent step's transcript (CAN-6421): the file
 * the step's `transcript_file` output names in the run's execution
 * directory. The module refuses an export of a run the runner does not hold.
 */
export interface PipelineRunnerTranscriptPort {
  exportTranscript(
    params: WorkerPipelineExecutionTranscriptExportParams,
  ): Promise<WorkerPipelineExecutionTranscriptExportResult>;
}

/**
 * Where a cloud runner materializes a run's capabilities (CAN-6439): the
 * capability bundles its owner resolved from the run's plugin collections,
 * with their plugin trees' blobs. Bundles are immutable by digest, so an
 * import only adds; the module refuses one once the lease ended
 * (`worker.pipeline.capabilitiesRefused`).
 */
export interface PipelineRunnerCapabilityPort {
  /**
   * Writes only while `context.leaseHeld()` answers true: the port writes
   * outside the host's lease fence, so it asks again before it installs.
   */
  importCapabilities(
    params: WorkerPipelineCapabilitiesImportParams,
    context: { readonly leaseHeld: () => boolean },
  ): Promise<WorkerPipelineCapabilitiesImportResult>;
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
  // A run whose state still moves is neither packed nor replaced.
  const refuseWhileLive = async (executionId: string): Promise<boolean> => {
    const current = await supervisor.get(executionId);
    if (current?.status === 'pending' || current?.status === 'running')
      throw pipelineHandoffBusyError();
    return current !== null;
  };
  const runnerOperations = options.runnerOperations;
  const runnerHandlers: PipelineRunnerOnlyHandlers | null = runnerOperations
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
          return runnerOperations.pipelineData.importData(params);
        },
        'worker.pipeline.data.export': async (params) => {
          await refuseWhileRunning(params);
          return runnerOperations.pipelineData.exportData(params);
        },
        // A paused run moves to the next incarnation (CAN-6376).
        'worker.pipeline.execution.handoff.export': async (params) => {
          if (!(await refuseWhileLive(params.executionId)))
            throw pipelineExecutionNotFoundError();
          return runnerOperations.handoffs.exportHandoff(params);
        },
        'worker.pipeline.execution.handoff.import': async (params) => {
          // A stale incarnation restores nothing: its fence stopped its runs.
          if (!supervisor.leaseHeld())
            throw pipelineHandoffRefusedError("This runner's lease has ended.");
          await refuseWhileLive(params.executionId);
          return runnerOperations.handoffs.importHandoff(params, {
            leaseHeld: () => supervisor.leaseHeld(),
          });
        },
        // A finished agent step's transcript, while its run goes on too:
        // the step's record no longer changes (CAN-6421).
        'worker.pipeline.execution.transcript.export': async (params) => {
          if ((await supervisor.get(params.executionId)) === null)
            throw pipelineExecutionNotFoundError();
          return runnerOperations.transcripts.exportTranscript(params);
        },
        // A run's skills, plugin trees and MCP servers, before its start
        // (CAN-6439). A stale incarnation installs nothing.
        'worker.pipeline.capabilities.import': (params) => {
          if (!supervisor.leaseHeld())
            throw pipelineCapabilitiesRefusedError(
              "This runner's lease has ended.",
            );
          return runnerOperations.capabilities.importCapabilities(params, {
            leaseHeld: () => supervisor.leaseHeld(),
          });
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
