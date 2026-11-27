import type { z } from 'zod';
import {
  CanopyClientError,
  createCanopyEventSubscription,
  type CanopyClientInstructionOptions,
  type CanopyEventDelivery,
  type CanopyEventsConnection,
} from '@canopy/core-client';
import {
  CORE_CONFIG_COMMITTED_EVENT,
  CORE_CONFIG_EVENT_FAMILY,
  CORE_CONFIG_INVALIDATED_EVENT,
  CoreConfigCommittedPayloadSchema,
  CoreConfigInvalidatedPayloadSchema,
  type ConfigDocumentGetParamsSchema,
  type ConfigDocumentGetResult,
  type ConfigDocumentOwnerUpdateParams,
  type ConfigDocumentUpdateParams,
  type ConfigDocumentUpdateResult,
  type ConfigLegacyClientLocalGetParamsSchema,
  type ConfigLegacyClientLocalGetResult,
  type ConfigLoadErrorAcknowledgeParamsSchema,
  type ConfigLoadErrorAcknowledgeResultSchema,
} from '@canopy/protocol/canopy-core/core';
import type {
  PreferencesDocumentEvent,
  PreferencesDocumentRoute,
} from './preferences-daemon-client';

/*
 * The daemon preference client's route over real daemon sessions (CAN-7991,
 * CAN-5722). Reads and open writes go over the interface session; owner
 * writes and the notice acknowledgement over the owner session, the only one
 * that can hold `core.config.document.own`. Commit events come from
 * `core.events.subscribe` on the interface session, family `core.config`.
 *
 * Unselected: nothing constructs it until the flip, which also grants the
 * sessions their config grants and lets the runtime profiles serve the
 * document. It never opens, leases or starts a daemon. With no session open
 * a call fails as `DAEMON_PREFERENCES_UNAVAILABLE_CODE` before anything is
 * sent, a definite refusal and never an unknown outcome, so a caller (the
 * preference outbox, CAN-7993) can hold the save and send it later. No call
 * falls back to Electron main's own document.
 */

/** Nothing was sent: no daemon session, or this app is not its owner. */
export const DAEMON_PREFERENCES_UNAVAILABLE_CODE =
  'core.config.daemonUnavailable';

/** While subscribed with no live stream, how often a new session is looked for. */
export const DAEMON_PREFERENCES_EVENTS_RECHECK_MS = 250;
/** Failed stream openings on one connection before waiting for another. */
const MAX_ATTACHES_PER_CONNECTION = 3;

type ConfigDocumentGetParams = z.input<typeof ConfigDocumentGetParamsSchema>;
type ConfigLegacyClientLocalGetParams = z.input<
  typeof ConfigLegacyClientLocalGetParamsSchema
>;
type ConfigLoadErrorAcknowledgeParams = z.input<
  typeof ConfigLoadErrorAcknowledgeParamsSchema
>;
type ConfigLoadErrorAcknowledgeResult = z.output<
  typeof ConfigLoadErrorAcknowledgeResultSchema
>;

/**
 * The interface session calls the route makes: what `ElectronDaemonClient`
 * carries (its document definitions are typing only until the flip).
 */
interface DocumentCalls {
  query(
    name: 'core.config.document.get',
    params: ConfigDocumentGetParams,
  ): Promise<ConfigDocumentGetResult>;
  query(
    name: 'core.config.legacyClientLocal.get',
    params: ConfigLegacyClientLocalGetParams,
  ): Promise<ConfigLegacyClientLocalGetResult>;
  instruction(
    name: 'core.config.document.update',
    params: ConfigDocumentUpdateParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<ConfigDocumentUpdateResult>;
}
export type PreferencesDocumentSessionClient = DocumentCalls &
  CanopyEventsConnection;

/** The owner session calls: what `ElectronDaemonOwnerClient` carries. */
export interface PreferencesDocumentOwnerClient {
  instruction(
    name: 'core.config.document.ownerUpdate',
    params: ConfigDocumentOwnerUpdateParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<ConfigDocumentGetResult>;
  instruction(
    name: 'core.config.loadError.acknowledge',
    params: ConfigLoadErrorAcknowledgeParams,
  ): Promise<ConfigLoadErrorAcknowledgeResult>;
}

export interface DaemonPreferencesRouteOptions {
  /** The interface session's client instance id: its commits' `publishedBy`. */
  readonly clientInstanceId: string;
  /** The owner session's client instance id, for its commits' echoes. */
  readonly ownerClientInstanceId: string;
  /** The established interface session's client, or null; read at each call. */
  readonly client: () => PreferencesDocumentSessionClient | null;
  /** The owner session's client; rejects while there is none. Read at each owner call. */
  readonly ownerClient: () => Promise<PreferencesDocumentOwnerClient>;
  readonly log: { warn(message: string, error?: unknown): void };
}

export interface DaemonPreferencesRoute extends PreferencesDocumentRoute {
  /** Ends the event subscription and its rechecks. */
  close(): Promise<void>;
}

function unavailable(message: string): CanopyClientError {
  return new CanopyClientError({
    kind: 'unavailable',
    code: DAEMON_PREFERENCES_UNAVAILABLE_CODE,
    message,
    // Not `same_idempotency_key` or `never`: either reads as a write whose
    // outcome is unknown, and this one never left the app.
    retry: { kind: 'same_request' },
  });
}

/** One delivery as the client's event; anything it cannot read is a resync. */
function toDocumentEvent(
  delivery: CanopyEventDelivery,
): PreferencesDocumentEvent | null {
  if (delivery.kind === 'gap') return { name: 'resync' };
  const { event } = delivery;
  if (event.name === CORE_CONFIG_COMMITTED_EVENT) {
    const payload = CoreConfigCommittedPayloadSchema.safeParse(event.payload);
    return payload.success
      ? { name: CORE_CONFIG_COMMITTED_EVENT, payload: payload.data }
      : { name: 'resync' };
  }
  if (event.name === CORE_CONFIG_INVALIDATED_EVENT) {
    const payload = CoreConfigInvalidatedPayloadSchema.safeParse(event.payload);
    return payload.success
      ? { name: CORE_CONFIG_INVALIDATED_EVENT, payload: payload.data }
      : { name: 'resync' };
  }
  // Subscribers ignore names they do not know.
  return null;
}

export function createDaemonPreferencesRoute(
  options: DaemonPreferencesRouteOptions,
): DaemonPreferencesRoute {
  const { log } = options;
  let listener: ((event: PreferencesDocumentEvent) => void) | null = null;
  let closed = false;
  // Set by a snapshot (first open, a new daemon, an expired cursor): the
  // stream then starts at the daemon's latest entry, so the document is
  // re-read once it is open and nothing committed before it is missed.
  let resyncOnOpen = false;
  let attached: PreferencesDocumentSessionClient | null = null;
  let attaching = false;
  let recheck: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive failed openings per connection. */
  const attachFailures = new WeakMap<
    PreferencesDocumentSessionClient,
    number
  >();
  const watched = new WeakSet<AbortSignal>();

  const emit = (event: PreferencesDocumentEvent): void => {
    try {
      listener?.(event);
    } catch (error) {
      log.warn('A preferences event could not be handled.', error);
    }
  };

  const subscription = createCanopyEventSubscription({
    families: [CORE_CONFIG_EVENT_FAMILY],
    snapshot: () => {
      resyncOnOpen = true;
      return Promise.resolve(null);
    },
    handle: (delivery) => {
      const event = toDocumentEvent(delivery);
      if (event !== null) emit(event);
      return Promise.resolve();
    },
  });

  const isLive = (client: PreferencesDocumentSessionClient): boolean => {
    const { authorityId } = client.identity;
    if (authorityId === null) return false;
    const state = subscription.state(authorityId);
    return state === 'open' || state === 'rehydrating';
  };

  function scheduleRecheck(): void {
    if (closed || listener === null || recheck !== undefined) return;
    recheck = setTimeout(() => {
      recheck = undefined;
      ensureStream();
    }, DAEMON_PREFERENCES_EVENTS_RECHECK_MS);
    recheck.unref?.();
  }

  /** Keeps one stream open on the current session; never connects. */
  function ensureStream(): void {
    if (closed || listener === null || attaching) return;
    const client = options.client();
    if (client === null || client.signal.aborted) {
      scheduleRecheck();
      return;
    }
    if (client === attached && isLive(client)) return;
    const failures = attachFailures.get(client) ?? 0;
    // This connection keeps refusing: its end (the abort listener) looks for
    // the next one.
    if (failures >= MAX_ATTACHES_PER_CONNECTION) return;
    attached = client;
    attaching = true;
    if (!watched.has(client.signal)) {
      watched.add(client.signal);
      client.signal.addEventListener('abort', scheduleRecheck, { once: true });
    }
    subscription
      .attach(client)
      .then(
        () => {
          attachFailures.delete(client);
          if (resyncOnOpen) {
            resyncOnOpen = false;
            emit({ name: 'resync' });
          }
        },
        (error: unknown) => {
          attachFailures.set(client, failures + 1);
          log.warn('Preference events could not be followed.', error);
        },
      )
      .finally(() => {
        attaching = false;
        if (!isLive(client)) scheduleRecheck();
      });
  }

  /** The interface session's client; a call with none is never sent. */
  function connected(): PreferencesDocumentSessionClient {
    const client = options.client();
    if (client === null || client.signal.aborted)
      throw unavailable('No background service session is open.');
    // A call is a good moment to notice a stream that ended.
    ensureStream();
    return client;
  }

  async function owner(): Promise<PreferencesDocumentOwnerClient> {
    try {
      return await options.ownerClient();
    } catch {
      throw unavailable('No background service owner session is open.');
    }
  }

  return {
    clientInstanceId: options.clientInstanceId,
    ownerClientInstanceId: options.ownerClientInstanceId,
    get: () =>
      Promise.resolve().then(() =>
        connected().query('core.config.document.get', {}),
      ),
    legacyClientLocal: () =>
      Promise.resolve().then(() =>
        connected().query('core.config.legacyClientLocal.get', {}),
      ),
    update: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected().instruction(
          'core.config.document.update',
          params,
          callOptions,
        ),
      ),
    ownerUpdate: async (params, callOptions) =>
      (await owner()).instruction(
        'core.config.document.ownerUpdate',
        params,
        callOptions,
      ),
    acknowledgeLoadError: async (params) =>
      (await owner()).instruction('core.config.loadError.acknowledge', params),
    subscribe: (next) => {
      listener = next;
      ensureStream();
      return () => {
        if (listener === next) listener = null;
      };
    },
    close: async () => {
      closed = true;
      listener = null;
      clearTimeout(recheck);
      recheck = undefined;
      await subscription.close();
    },
  };
}
