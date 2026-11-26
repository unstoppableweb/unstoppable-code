import type { VaultFamilyWriter, VaultRepository } from '../../vault/contracts';
import { cloudAccountEndpointAuthority } from '@canopy/protocol/canopy-core';
import {
  CodexGatewayProxyService,
  createDaemonModelBroker,
  type DaemonModelBroker,
} from '../model-broker';
import {
  createCloudAccountAuthority,
  type CloudAccountAuthority,
  type CloudAccountAuthorityEvents,
} from './authority';
import {
  createCloudAiCreditsAvailability,
  type CloudAiCreditsAvailabilityService,
  type CloudJsonRequest,
} from './availability';
import { createCloudAccountCustody, type CloudAccountCustody } from './custody';
import { CLOUD_ACCOUNT_PROBE_TIMEOUT_MS, probeCloudAccount } from './probe';
import {
  createCloudAccountRefresher,
  type CloudAccountRefresher,
  type CloudAccountRefreshResult,
} from './refresh';
import { createCloudAccountModule } from './module';
import { applyCloudAccountHeader } from './authorization';
import { buildCloudAccountSnapshot } from './snapshot';
import type { RuntimeModule } from '../../kernel/runtime-profile-graph';
import type { RuntimeService } from '../../kernel/service-container';

/**
 * Daemon composition of the whole Cloud account (CAN-6997): custody on the
 * vault's `cloud-account` family, the single-writer authority, account and
 * policy refresh, AI Credits availability and the daemon model broker.
 *
 * The record is the daemon's own, provisioned from a client's sign-in and
 * written only by this authority; no client's record is written here.
 *
 * Constructing this does no I/O. `start` arms the refresh timer even when
 * custody is temporarily unreadable. An unprovisioned selected daemon may read
 * its vault but makes no Cloud request. Unselected composition never starts
 * it (see `activation.ts`).
 */

/** The app's periodic account re-probe interval (`org-enforced-settings.ts`). */
export const CLOUD_ACCOUNT_REFRESH_INTERVAL_MS = 20 * 60_000;

export interface DaemonCloudEndpoint {
  /** Origin without a trailing slash; https, or http on localhost. */
  readonly baseUrl: string;
  /** `/.well-known/{wellKnownNamespace}` lists the server's capabilities. */
  readonly wellKnownNamespace: string;
  /** `/api/v1/{apiNamespace}` holds the account and organization routes. */
  readonly apiNamespace: string;
}

export interface DaemonCloudAccountServicesOptions {
  readonly repository: () => Promise<VaultRepository>;
  /** Minted once by trusted daemon composition for `cloud-account` only. */
  readonly writer: () => Promise<VaultFamilyWriter>;
  readonly probeKeyIfDue?: () => Promise<void>;
  /** Null when this build has no Cloud (local-only): nothing is requested. */
  readonly cloud: DaemonCloudEndpoint | null;
  readonly fetch?: typeof fetch;
  readonly refreshIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly events?: CloudAccountAuthorityEvents;
  /** Redacted outcome only: never a credential, URL or response body. */
  readonly onRefresh?: (result: CloudAccountRefreshResult) => void;
}

export interface DaemonCloudAccountServices {
  readonly custody: CloudAccountCustody;
  readonly authority: CloudAccountAuthority;
  readonly refresher: CloudAccountRefresher;
  readonly availability: CloudAiCreditsAvailabilityService;
  readonly broker: DaemonModelBroker;
  /** `core.integration.cloudAccount.*` over this composition. */
  readonly module: RuntimeModule;
  /**
   * Arms periodic refresh, including recovery after transient vault failures.
   * Returns whether custody was readable; a failed read still arms it. Idempotent.
   */
  start(): Promise<boolean>;
  /**
   * Stops and drains refresh and releases broker routes, settling once both
   * finish. The module's service drains refresh in shutdown phase 4 and shuts
   * the broker down in phase 6, without waiting on that drain, after pipeline
   * hosts stop and before the vault closes; hosts may call it again.
   * Idempotent; never rejects.
   */
  dispose(): Promise<void>;
}

function noCloud(): never {
  throw new Error('No Cloud is configured for this build.');
}

export function createDaemonCloudAccountServices(
  options: DaemonCloudAccountServicesOptions,
): DaemonCloudAccountServices {
  const fetcher = options.fetch ?? fetch;
  // Copy trusted configuration: callers cannot retarget a live credential by
  // mutating the options object. Bind the encrypted record across restarts too.
  const cloud = options.cloud ? Object.freeze({ ...options.cloud }) : null;
  const endpointAuthority = cloud ? cloudAccountEndpointAuthority(cloud) : null;
  const baseUrl = (): string => (cloud ? cloud.baseUrl : noCloud());
  const custody = createCloudAccountCustody({
    endpointAuthority,
    repository: options.repository,
    writer: options.writer,
    ...(options.probeKeyIfDue ? { probeKeyIfDue: options.probeKeyIfDue } : {}),
  });
  const authority = createCloudAccountAuthority({
    custody,
    ...(options.events ? { events: options.events } : {}),
  });
  const timeoutMs = options.requestTimeoutMs ?? CLOUD_ACCOUNT_PROBE_TIMEOUT_MS;
  const probe = (
    apiKey: string,
    signal?: AbortSignal,
  ): ReturnType<typeof probeCloudAccount> =>
    probeCloudAccount(
      {
        fetch: fetcher,
        baseUrl,
        wellKnownPath: `/.well-known/${cloud?.wellKnownNamespace ?? ''}`,
        accountPath: `/api/v1/${cloud?.apiNamespace ?? ''}/account`,
        timeoutMs,
      },
      apiKey,
      signal,
    );
  const refresher = createCloudAccountRefresher({
    authority,
    probe,
    buildSnapshot: buildCloudAccountSnapshot,
    ...(options.onRefresh ? { onResult: options.onRefresh } : {}),
  });
  const request: CloudJsonRequest = async ({
    path,
    apiKey,
    headers,
    signal,
  }) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestHeaders = new Headers({
      ...headers,
      Accept: 'application/json',
    });
    applyCloudAccountHeader(requestHeaders, apiKey);
    const response = await fetcher(`${baseUrl()}${path}`, {
      redirect: 'error',
      headers: requestHeaders,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (response.status < 200 || response.status > 299) {
      void response.body?.cancel().catch(() => undefined);
      return { status: response.status, body: null };
    }
    const text = await response.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, body };
  };
  const availability = createCloudAiCreditsAvailability({
    authority,
    request,
    organizationNamespace: cloud?.apiNamespace ?? '',
  });
  const broker = createDaemonModelBroker({
    // No app session-failure sink: the daemon has no chat session to mark.
    proxy: new CodexGatewayProxyService(),
    authority,
    cloudBaseUrl: baseUrl,
    // The endpoint is fixed per build; a different build is a different daemon.
    endpointEpoch: () => endpointAuthority ?? '',
    refreshAccount: async (): Promise<void> => {
      await refresher.refresh();
    },
  });

  const operations = createCloudAccountModule({
    endpointAuthority,
    authority,
    refresher,
    probe,
    // Refresh starts once a client first provisions this daemon's record.
    onProvisioned: () => void start().catch(() => false),
  });
  // Phase 4 (stop-schedulers) drains refresh. Phase 6 releases broker routes
  // once phase 5 stopped pipeline hosts, before the vault closes in phase 7.
  const lifecycle: RuntimeService = {
    name: 'daemon.cloudAccount.refresh',
    plane: 'core',
    required: false,
    stop: { 4: () => drainRefresh(), 6: () => shutdownBroker() },
  };
  const module: RuntimeModule = {
    ...operations,
    services: [...(operations.services ?? []), lifecycle],
  };

  let stop: (() => void) | undefined;
  let disposed = false;
  let starting: Promise<boolean> | undefined;
  let refreshDrain: Promise<void> | undefined;
  let brokerShutdown: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  function drainRefresh(): Promise<void> {
    disposed = true;
    stop?.();
    stop = undefined;
    return (refreshDrain ??= (async (): Promise<void> => {
      const armed = refresher.dispose();
      // A start still reading custody must settle before the vault closes.
      await starting?.catch(() => false);
      await armed;
    })());
  }
  /** Idempotent; never rejects: composition disposes without awaiting. */
  function shutdownBroker(): Promise<void> {
    return (brokerShutdown ??= broker.shutdown().catch(() => undefined));
  }
  /** Idempotent: every shutdown path shares one drain and one broker shutdown. */
  function dispose(): Promise<void> {
    // A custody read can hold the drain; it must not hold the broker's routes.
    return (disposal ??= Promise.all([drainRefresh(), shutdownBroker()]).then(
      () => undefined,
    ));
  }
  function start(): Promise<boolean> {
    return (starting ??= (async (): Promise<boolean> => {
      try {
        if (disposed || !cloud) return false;
        const read = await authority.read();
        if (disposed) return false;
        stop ??= refresher.start(
          options.refreshIntervalMs ?? CLOUD_ACCOUNT_REFRESH_INTERVAL_MS,
        );
        return read.kind === 'ok';
      } finally {
        starting = undefined;
      }
    })());
  }

  return {
    custody,
    authority,
    refresher,
    availability,
    broker,
    module,
    start,
    dispose,
  };
}
