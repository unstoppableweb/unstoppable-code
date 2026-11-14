import {
  CanopyOperationError,
  type CanopyQueryOptions,
} from '@canopy/core-runtime';
import {
  WORKER_AGENT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerAgentProviderListParams,
  type WorkerAgentProviderListResult,
} from '@canopy/protocol/canopy-core';
import type { ModelRegistrySnapshot } from '@canopy/desktop-shared/types';
import { runWithModelRegistryCapture } from './desktop-provider-host';

/** The dispatcher surface the model-registry projection uses. */
export interface WorkerAgentProviderDispatcher {
  query(
    name: 'worker.agent.provider.list',
    params: WorkerAgentProviderListParams,
    options: CanopyQueryOptions,
  ): Promise<WorkerAgentProviderListResult>;
}

/**
 * `model-registry:get` (async) as a projection of `worker.agent.provider.list`
 * (CAN-4121 D13): dispatches the local scope without probing, with a per-call
 * `worker.agent.read` grant, and returns the registry snapshot the host built
 * inside the projection, unchanged.
 */
export async function getModelRegistryThroughWorker(
  dispatcher: WorkerAgentProviderDispatcher,
  caller: CanopyCallerDescriptor,
  probe = false,
): Promise<ModelRegistrySnapshot> {
  let snapshot: ModelRegistrySnapshot | undefined;
  try {
    ({ snapshot } = await runWithModelRegistryCapture(() =>
      dispatcher.query(
        'worker.agent.provider.list',
        { scope: {}, probe },
        { caller: { ...caller, grants: [WORKER_AGENT_GRANTS.read] } },
      ),
    ));
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.runtimeCause instanceof Error
    )
      throw error.runtimeCause;
    throw error;
  }
  if (snapshot === undefined)
    throw new Error('Model registry projection was not captured.');
  return snapshot;
}
