import {
  CanopyOperationError,
  type CanopyQueryOptions,
} from '@canopy/core-runtime';
import {
  WORKER_AGENT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerAgentUsageLimitsGetParams,
} from '@canopy/protocol/canopy-core';
import type { UsageLimitsSnapshot } from '@canopy/protocol/provider-usage';
import { PortalProviderUsageLimitsGetPayloadSchema } from '@canopy/protocol/portal';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { registerIpcHandler } from './register';
import type { DesktopIpcCallerResolver } from './file-tree';

interface ProviderUsageLimitsIpcRuntime {
  dispatcher: DesktopCanopyDispatcher;
  resolveCaller: DesktopIpcCallerResolver;
}

/**
 * `provider-usage:limits-get` is a compatibility projection of the passive
 * worker query. Resolve the invoking surface for every call, then let this
 * trusted main-process adapter delegate only the usage-read grant as core.
 */
export function registerProviderUsageLimitsHandlers(
  runtime: ProviderUsageLimitsIpcRuntime,
): void {
  registerIpcHandler<unknown[], UsageLimitsSnapshot>(
    IPC_CHANNELS.providerUsageLimitsGet,
    async (event, ...rawArgs) => {
      if (rawArgs.length !== 1) {
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          message:
            'Provider usage limits requests must contain one empty object.',
          retry: { kind: 'never' },
        });
      }
      const request = PortalProviderUsageLimitsGetPayloadSchema.safeParse(
        rawArgs[0],
      );
      if (!request.success) {
        throw new CanopyOperationError({
          kind: 'invalid_argument',
          message: 'Provider usage limits requests must be empty.',
          retry: { kind: 'never' },
        });
      }

      const surfaceCaller: CanopyCallerDescriptor =
        runtime.resolveCaller(event);
      const caller: CanopyCallerDescriptor = {
        ...surfaceCaller,
        principalId: 'core',
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        grants: [WORKER_AGENT_GRANTS.usageRead],
      };
      const params: WorkerAgentUsageLimitsGetParams = {
        scope: { authorityId: LOCAL_DESKTOP_AUTHORITY_ID },
      };
      const options: CanopyQueryOptions = { caller };
      return runtime.dispatcher.query(
        'worker.agent.usageLimits.get',
        params,
        options,
      );
    },
  );
}
