import type {
  SpawnedProcessResult,
  SpawnedProcessRunOptions,
  SpawnedProcessSpec,
} from '@canopy/execution-engine/node/pipelines/executor/types';

export interface PipelineProcessHostRunRequest {
  type: 'run';
  requestId: string;
  childId?: string;
  processSpec: SpawnedProcessSpec;
  options: Omit<SpawnedProcessRunOptions, 'signal' | 'onOutput' | 'resource'>;
}

export interface PipelineProcessHostCancelRequest {
  type: 'cancel';
  requestId: string;
}

export interface PipelineProcessHostShutdownRequest {
  type: 'shutdown';
}

export type PipelineProcessHostRequest =
  | PipelineProcessHostRunRequest
  | PipelineProcessHostCancelRequest
  | PipelineProcessHostShutdownRequest;

export type PipelineProcessHostResponse =
  | { type: 'started'; requestId: string; pid: number }
  | {
      type: 'output';
      requestId: string;
      stream: 'stdout' | 'stderr';
      data: string;
    }
  | {
      type: 'result';
      requestId: string;
      result: SpawnedProcessResult;
    }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'cleanup-complete'; requestId: string }
  | { type: 'shutdown-complete' };
