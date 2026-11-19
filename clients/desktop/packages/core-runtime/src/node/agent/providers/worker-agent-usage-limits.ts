import type { WORKER_AGENT_USAGE_LIMITS_QUERY_DEFINITIONS } from '@canopy/protocol/canopy-core';
import {
  USAGE_LIMITS_MAX_ACCOUNTS,
  type UsageLimitsSnapshot,
} from '@canopy/protocol/provider-usage';
import { CanopyOperationError } from '../../../runtime/errors';
import type {
  CanopyDispatcherHandlerMap,
  CanopyHandlerContext,
} from '../../../runtime/types';
import {
  assertWorkerAgentServedSelection,
  type WorkerAgentServedSelection,
} from './worker-agent-providers';

/**
 * Cached observability only. Hosts must not refresh or create provider services.
 * Account membership must be vetted as current, including identified errors;
 * historical accounts and anonymous failed observations are not inventory.
 */
export interface WorkerAgentUsageLimitsHost extends WorkerAgentServedSelection {
  get(
    context: CanopyHandlerContext,
  ): UsageLimitsSnapshot | null | Promise<UsageLimitsSnapshot | null>;
}

export interface WorkerAgentUsageLimitsHandlers {
  queries: CanopyDispatcherHandlerMap<
    typeof WORKER_AGENT_USAGE_LIMITS_QUERY_DEFINITIONS
  >;
}

export function createWorkerAgentUsageLimitsHandlers(
  host?: WorkerAgentUsageLimitsHost,
): WorkerAgentUsageLimitsHandlers {
  return {
    queries: {
      'worker.agent.usageLimits.get': async (
        params,
        context,
      ): Promise<UsageLimitsSnapshot> => {
        if (!host)
          throw new CanopyOperationError({
            kind: 'capability_unavailable',
            message: 'Cached provider usage is unavailable on this worker.',
            retry: { kind: 'never' },
          });
        assertWorkerAgentServedSelection(params.scope, host);
        let snapshot: UsageLimitsSnapshot | null;
        try {
          snapshot = await host.get(context);
        } catch (error) {
          if (error instanceof CanopyOperationError) throw error;
          throw new CanopyOperationError(
            {
              kind: 'internal',
              message: 'Cached provider usage could not be read.',
              retry: { kind: 'never' },
            },
            error,
          );
        }
        // Vetted current membership is useful even before the first successful
        // quota observation. Never invent an observation time to retain it.
        if (
          !snapshot ||
          (snapshot.accounts.length === 0 &&
            !snapshot.sources.some(
              (source) =>
                source.state === 'observed' ||
                (source.state === 'unavailable' && source.observedAt !== null),
            ))
        )
          throw new CanopyOperationError({
            kind: 'unavailable',
            message: 'No cached provider usage source has been observed.',
            retry: { kind: 'never' },
          });
        if (snapshot.accounts.length > USAGE_LIMITS_MAX_ACCOUNTS)
          throw new CanopyOperationError({
            kind: 'resource_exhausted',
            message:
              'The provider account inventory exceeds the snapshot limit.',
            retry: { kind: 'never' },
          });
        return snapshot;
      },
    },
  };
}
