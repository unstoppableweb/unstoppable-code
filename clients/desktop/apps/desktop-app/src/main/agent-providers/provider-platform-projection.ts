import type { CanopyQueryOptions } from '@canopy/core-runtime';
import {
  WORKER_AGENT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerAgentProviderId,
  type WorkerAgentProviderPlatformGetParams,
  type WorkerAgentProviderPlatformGetResult,
} from '@canopy/protocol/canopy-core';

/** The dispatcher surface the provider platform projection uses. */
export interface WorkerAgentProviderPlatformDispatcher {
  query(
    name: 'worker.agent.provider.platform.get',
    params: WorkerAgentProviderPlatformGetParams,
    options: CanopyQueryOptions,
  ): Promise<WorkerAgentProviderPlatformGetResult>;
}

/**
 * Whether this worker's platform can run `providerId`, as a projection of
 * `worker.agent.provider.platform.get` (CAN-6718): the local scope with a
 * per-call `worker.agent.read` grant. The worker answers from pinned runtime
 * artifacts and platform checks alone.
 */
export async function isProviderPlatformSupportedThroughWorker(
  dispatcher: WorkerAgentProviderPlatformDispatcher,
  caller: CanopyCallerDescriptor,
  providerId: WorkerAgentProviderId,
): Promise<boolean> {
  const result = await dispatcher.query(
    'worker.agent.provider.platform.get',
    { scope: {} },
    { caller: { ...caller, grants: [WORKER_AGENT_GRANTS.read] } },
  );
  return result.providerIds.includes(providerId);
}
