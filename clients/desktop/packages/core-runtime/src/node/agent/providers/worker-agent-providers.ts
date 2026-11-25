import {
  WORKER_AGENT_PROVIDER_IDS,
  type WORKER_AGENT_PROVIDER_QUERY_DEFINITIONS,
  type WorkerAgentProvider,
  type WorkerAgentProviderId,
  type WorkerAgentProviderListParams,
  type WorkerAgentProviderListResult,
  type WorkerAgentProviderPlatformGetResult,
} from '@canopy/protocol/canopy-core';

import { CanopyOperationError } from '../../../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyHandlerContext,
} from '../../../runtime/types';

/** The authority and target a `worker.agent.provider.*` host serves. */
export interface WorkerAgentServedSelection {
  readonly authorityId: string;
  readonly targetId: string;
}

/** Refuses a scope selecting another authority or target before the host reads anything (D5). */
export function assertWorkerAgentServedSelection(
  scope: { readonly authorityId?: string; readonly targetId?: string },
  host: WorkerAgentServedSelection,
): void {
  if (
    (scope.authorityId !== undefined &&
      scope.authorityId !== host.authorityId) ||
    (scope.targetId !== undefined && scope.targetId !== host.targetId)
  )
    throw new CanopyOperationError({
      kind: 'capability_unavailable',
      message: 'The selected agent worker is unavailable.',
      retry: { kind: 'never' },
    });
}

/** What the host lists; the handler adds the selection and the probe echo. */
export interface WorkerAgentProviderInventory {
  readonly providers: readonly WorkerAgentProvider[];
}

/** Host port: the host reads its own registry, status, policy and usage sources. */
export interface WorkerAgentProviderHost extends WorkerAgentServedSelection {
  list(
    request: {
      readonly scope: WorkerAgentProviderListParams['scope'];
      readonly probe: boolean;
    },
    context: CanopyHandlerContext,
  ): Promise<WorkerAgentProviderInventory>;
  /**
   * The providers this worker's platform can run, from its pinned runtime
   * artifacts and platform checks only: no executable lookup, hashing,
   * status read or rollout flag.
   */
  platformSupport(
    context: CanopyHandlerContext,
  ): Promise<readonly WorkerAgentProviderId[]>;
}

export interface WorkerAgentProviderHandlers {
  queries: CanopyDispatcherHandlerMap<
    typeof WORKER_AGENT_PROVIDER_QUERY_DEFINITIONS
  >;
}

export function providerListFailedError(cause: unknown): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'internal',
      message: 'The agent provider list could not be read.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

export function providerPlatformFailedError(
  cause: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    {
      kind: 'internal',
      message: 'The agent provider platform support could not be read.',
      retry: { kind: 'never' },
    },
    cause,
  );
}

/** Fixed provider order, no repeats, so clients can compare answers. */
function orderedProviderIds(
  providerIds: readonly WorkerAgentProviderId[],
): WorkerAgentProviderId[] {
  let previous = -1;
  for (const providerId of providerIds) {
    const index = WORKER_AGENT_PROVIDER_IDS.indexOf(providerId);
    if (index <= previous)
      throw providerPlatformFailedError(
        new Error('Platform support is out of order or repeats a provider.'),
      );
    previous = index;
  }
  return [...providerIds];
}

function assertInventoryInvariants(
  providers: readonly WorkerAgentProvider[],
): void {
  let previous = -1;
  for (const provider of providers) {
    const index = WORKER_AGENT_PROVIDER_IDS.indexOf(provider.providerId);
    if (index <= previous)
      throw providerListFailedError(
        new Error('Provider list is out of order or repeats a provider.'),
      );
    previous = index;
    const modelIds = new Set<string>();
    for (const model of provider.models) {
      if (modelIds.has(model.modelId))
        throw providerListFailedError(
          new Error('A provider lists a model twice.'),
        );
      modelIds.add(model.modelId);
    }
  }
}

export function createWorkerAgentProviderHandlers(
  host: WorkerAgentProviderHost,
): WorkerAgentProviderHandlers {
  return {
    queries: {
      'worker.agent.provider.list': async (
        params,
        context,
      ): Promise<WorkerAgentProviderListResult> => {
        assertWorkerAgentServedSelection(params.scope, host);
        let inventory: WorkerAgentProviderInventory;
        try {
          inventory = await host.list(
            { scope: params.scope, probe: params.probe },
            context,
          );
        } catch (error) {
          if (error instanceof CanopyOperationError) throw error;
          throw providerListFailedError(error);
        }
        assertInventoryInvariants(inventory.providers);
        return {
          authorityId: host.authorityId,
          targetId: host.targetId,
          probed: params.probe,
          providers: [...inventory.providers],
        };
      },
      'worker.agent.provider.platform.get': async (
        params,
        context,
      ): Promise<WorkerAgentProviderPlatformGetResult> => {
        assertWorkerAgentServedSelection(params.scope, host);
        let providerIds: readonly WorkerAgentProviderId[];
        try {
          providerIds = await host.platformSupport(context);
        } catch (error) {
          if (error instanceof CanopyOperationError) throw error;
          throw providerPlatformFailedError(error);
        }
        return {
          authorityId: host.authorityId,
          targetId: host.targetId,
          providerIds: orderedProviderIds(providerIds),
        };
      },
    },
  };
}
