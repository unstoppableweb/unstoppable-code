import type {
  RemoteControlProviderUsageProjection,
  RemoteControlProviderUsageRefreshProvider,
} from '@canopy/protocol/remote-control/shell';
import type { AgentUsageOverview } from '@canopy/desktop-shared/types';
import { getObservabilityService } from '../observability';
import {
  isRemoteControlProviderUsageServedByAccountProxy,
  projectRemoteControlProviderUsage,
  readRemoteControlProviderUsageAccountProxySource,
  type RemoteControlProviderUsageAccountProxySource,
} from './provider-usage-projection';

/**
 * The curated provider quota projection and its refresh for Remote Control
 * controllers (CAN-7433): `provider-usage:load` and `provider-usage:refresh`.
 * The routing is the one the retired Portal refresh used: the account proxy's
 * accounts while the proxy serves the provider, otherwise the native sign-in.
 */
export interface ProviderUsageRefreshDeps {
  readonly usageOverview: () => AgentUsageOverview;
  readonly accountProxySource: () => Promise<RemoteControlProviderUsageAccountProxySource>;
  readonly refreshAccountProxyUsage: (options: {
    readonly interactive: true;
    readonly provider: 'claude' | 'codex';
  }) => Promise<void>;
  readonly refreshProviderUsage: (
    provider: RemoteControlProviderUsageRefreshProvider,
    options: { readonly joinInFlight: true },
  ) => Promise<void>;
}

export interface ProviderUsageReader {
  /** The projection the desktop's own provider host reads; no provider I/O. */
  load(): Promise<RemoteControlProviderUsageProjection>;
  /** Refresh one provider (joining a refresh already running), then load. */
  refresh(
    provider: RemoteControlProviderUsageRefreshProvider,
  ): Promise<RemoteControlProviderUsageProjection>;
}

export function createProviderUsageReader(
  deps: ProviderUsageRefreshDeps,
): ProviderUsageReader {
  // The native path joins through `joinInFlight`; proxy reads join here, so
  // one Refresh per provider sent in parallel reaches the proxy once each.
  const proxyRefreshes = new Map<'claude' | 'codex', Promise<void>>();

  const refreshThroughProxy = (provider: 'claude' | 'codex'): Promise<void> => {
    const running = proxyRefreshes.get(provider);
    if (running) return running;
    const started = deps
      .refreshAccountProxyUsage({ interactive: true, provider })
      .finally((): void => {
        proxyRefreshes.delete(provider);
      });
    proxyRefreshes.set(provider, started);
    return started;
  };

  const load = async (): Promise<RemoteControlProviderUsageProjection> =>
    projectRemoteControlProviderUsage(
      deps.usageOverview(),
      await deps.accountProxySource(),
    );

  return {
    load,
    async refresh(provider): Promise<RemoteControlProviderUsageProjection> {
      if (
        (provider === 'claude' || provider === 'codex') &&
        isRemoteControlProviderUsageServedByAccountProxy(
          provider,
          await deps.accountProxySource(),
        )
      ) {
        await refreshThroughProxy(provider);
      } else {
        await deps.refreshProviderUsage(provider, { joinInFlight: true });
      }
      return load();
    },
  };
}

let reader: ProviderUsageReader | null = null;

/** The production reader over the observability service and account proxy. */
export function getProviderUsageReader(): ProviderUsageReader {
  reader ??= createProviderUsageReader({
    usageOverview: () => getObservabilityService().getUsageOverview(),
    accountProxySource: readRemoteControlProviderUsageAccountProxySource,
    refreshAccountProxyUsage: (options) =>
      getObservabilityService().refreshAccountProxyUsage(options),
    refreshProviderUsage: (provider, options) =>
      getObservabilityService().refreshProviderUsage(provider, options),
  });
  return reader;
}
