import type { CoreClientWindowTicket } from '@canopy/protocol/canopy-core';

import { CanopyClientError } from '../errors';
import {
  createCanopyClientLease,
  type CanopyClientLeasePresence,
  type CanopyLeaseClient,
} from '../lease';
import type { CanopyRuntimeIdentity } from '../types';
import type { CanopyClientEndpoint } from './endpoint';

/** What a window's host hands it for one connection (CAN-8068). */
export interface CanopyWindowAdmission {
  /** The endpoint the host's own connection reached after its runtime checks. */
  readonly endpoint: Exclude<CanopyClientEndpoint, { kind: 'inMemory' }>;
  /** Single use: every connection needs a fresh admission. */
  readonly ticket: CoreClientWindowTicket;
  /** The runtime the host verified; a window reaching another closes. */
  readonly runtime: Pick<CanopyRuntimeIdentity, 'runtimeId' | 'daemonEpoch'>;
}

export type CanopyWindowConnection = CanopyLeaseClient & {
  readonly identity: Pick<CanopyRuntimeIdentity, 'runtimeId' | 'daemonEpoch'>;
};

export interface CanopyWindowClientOptions<C extends CanopyWindowConnection> {
  /** A fresh admission from the host, or `null` to keep the window off the daemon. */
  readonly admit: () => Promise<CanopyWindowAdmission | null>;
  /**
   * Connects with `admission.ticket` as `windowTicket`, bounded by its own
   * timeout. No abort signal: the window client closes what it adopts.
   */
  readonly connect: (admission: CanopyWindowAdmission) => Promise<C>;
  readonly lease: {
    readonly clientInstanceId: string;
    readonly label: string;
    /** TTL is 4× the interval the daemon grants; renderer timers can be throttled. */
    readonly renewalIntervalMs: number;
    readonly presence: () => CanopyClientLeasePresence;
  };
  readonly onError?: (error: CanopyClientError) => void;
}

export interface CanopyWindowClient<C extends CanopyWindowConnection> {
  /** The connection serving the window now; a reconnect replaces it. */
  readonly client: C;
  /** Aborts once the window's lease ends for good; its streams end with it. */
  readonly signal: AbortSignal;
  /** Renews at once when throttled timers let the renew point pass. */
  checkClock(): void;
  close(): Promise<void>;
}

const KEPT_OFF = (): CanopyClientError =>
  new CanopyClientError({
    kind: 'failed_precondition',
    message: 'The window was not admitted to the daemon.',
    retry: { kind: 'never' },
  });

const OTHER_RUNTIME = (): CanopyClientError =>
  new CanopyClientError({
    kind: 'failed_precondition',
    message: 'The window reached another runtime than its host verified.',
    retry: { kind: 'never' },
  });

/**
 * A renderer window's own daemon connection (CAN-8022 2b-3): admitted by a
 * ticket its host issues, bound to the runtime the host verified (the
 * window skips the host's runtime checks, so it only goes where the host
 * went), and leased. A reconnect asks the host for a fresh ticket; a host
 * that refuses one ends the lease, and `signal` aborts. `null` when the host
 * keeps the window off the daemon or the first connection fails.
 */
export async function connectCanopyWindowClient<
  C extends CanopyWindowConnection,
>(
  options: CanopyWindowClientOptions<C>,
): Promise<CanopyWindowClient<C> | null> {
  const open = async (signal?: AbortSignal): Promise<C> => {
    const admission = await options.admit();
    signal?.throwIfAborted();
    if (!admission) throw KEPT_OFF();
    const client = await options.connect(admission);
    const { runtimeId, daemonEpoch } = client.identity;
    const elsewhere =
      runtimeId !== admission.runtime.runtimeId ||
      daemonEpoch !== admission.runtime.daemonEpoch;
    if (elsewhere || signal?.aborted) {
      await client.close().catch(() => undefined);
      if (elsewhere) throw OTHER_RUNTIME();
      signal?.throwIfAborted();
    }
    return client;
  };
  let first: C;
  try {
    first = await open();
  } catch (error) {
    if (error instanceof CanopyClientError) options.onError?.(error);
    return null;
  }
  const ended = new AbortController();
  const lease = createCanopyClientLease<C>({
    client: first,
    attach: (attempt) => open(attempt.signal),
    identity: {
      clientInstanceId: options.lease.clientInstanceId,
      interfaceKind: 'desktop',
      label: options.lease.label,
    },
    renewalIntervalMs: options.lease.renewalIntervalMs,
    presence: options.lease.presence,
    onError: (error) => {
      options.onError?.(error);
      if (lease.state === 'failed') end();
    },
  });
  const end = (): void => {
    if (ended.signal.aborted) return;
    ended.abort();
    void lease
      .release('normal_shutdown')
      .then(() => lease.client.close())
      .catch(() => undefined);
  };
  try {
    await lease.acquire();
  } catch {
    end();
    return null;
  }
  return {
    get client(): C {
      return lease.client;
    },
    signal: ended.signal,
    checkClock: () => lease.checkClock(),
    close: async () => {
      end();
      await lease.release('normal_shutdown');
    },
  };
}
