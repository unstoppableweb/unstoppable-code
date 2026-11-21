import {
  isRemoteControlProviderUsageRefreshProvider,
  type RemoteControlProviderUsageProjection,
  type RemoteControlProviderUsageRefreshProvider,
} from '@canopy/protocol/remote-control/shell';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { getProviderUsageReader } from '../agent-providers/provider-usage-refresh';
import { registerIpcHandler } from './register';

/**
 * The curated provider quota projection for Remote Control controllers
 * (CAN-7433). Compatibility debt: `provider-usage:limits-get` is the
 * daemon-routed usage read, but it answers a different shape and has no
 * refresh, so these stay Electron handlers until the shared panel reads it
 * (see the CAN-7433 behavior inventory). `observability:*` stays off the
 * browser list; these answer no audit rows, credentials or raw provider
 * responses.
 */

function hasOnlyKey(
  value: unknown,
  key: string,
): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key;
}

/** Exactly one `{ provider }` argument naming a refreshable provider. */
export function parseProviderUsageRefreshRequest(
  args: readonly unknown[],
): RemoteControlProviderUsageRefreshProvider {
  const [request] = args;
  if (
    args.length !== 1 ||
    !hasOnlyKey(request, 'provider') ||
    !isRemoteControlProviderUsageRefreshProvider(request.provider)
  )
    throw new Error('Invalid provider usage refresh request');
  return request.provider;
}

export function registerProviderUsageHandlers(): void {
  registerIpcHandler<unknown[], RemoteControlProviderUsageProjection>(
    IPC_CHANNELS.providerUsageLoad,
    async (_event, ...args) => {
      if (args.length !== 0)
        throw new Error('Provider usage load takes no arguments');
      return getProviderUsageReader().load();
    },
  );
  registerIpcHandler<unknown[], RemoteControlProviderUsageProjection>(
    IPC_CHANNELS.providerUsageRefresh,
    async (_event, ...args) =>
      getProviderUsageReader().refresh(parseProviderUsageRefreshRequest(args)),
  );
}
