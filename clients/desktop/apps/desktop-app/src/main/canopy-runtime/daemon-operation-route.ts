import type {
  CanopyClientInstructionOptions,
  CanopyClientQueryOptions,
  CanopyClientStreamFrame,
  CanopyClientStreamHandle,
  CanopyClientStreamOptions,
} from '@canopy/core-client';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  CanopySchemaOutput,
  CoreOperationCancelParams,
  CoreOperationCancelResult,
  CoreOperationEventsEndSchema,
  CoreOperationEventsItem,
  CoreOperationEventsParams,
  CoreOperationGetParams,
  CoreOperationGetResult,
  CoreOperationListParams,
  CoreOperationListResult,
} from '@canopy/protocol/canopy-core';
import type { ElectronDaemonClient } from './electron-daemon-host';

/*
 * `core.operation.*` over a daemon session (CAN-5092 S1a). Unselected: no
 * production caller uses it, and it never opens, leases or starts a daemon.
 * A daemon that does not serve operation records refuses each call
 * capability_unavailable before the wire; no call falls back to Electron
 * main's ledger.
 */

type OperationClient = Pick<
  ElectronDaemonClient,
  'query' | 'instruction' | 'openStream'
>;
type EventsEnd = CanopySchemaOutput<typeof CoreOperationEventsEndSchema>;
export type DaemonOperationEventsHandle = CanopyClientStreamHandle<
  CoreOperationEventsItem,
  EventsEnd
>;

export interface DaemonOperationRouteOptions {
  /** An established session's client, or null; read at each call. */
  readonly client: () => OperationClient | null;
}

export interface DaemonOperationRoute {
  get(
    params: CoreOperationGetParams,
    options?: CanopyClientQueryOptions,
  ): Promise<CoreOperationGetResult>;
  list(
    params: CoreOperationListParams,
    options?: CanopyClientQueryOptions,
  ): Promise<CoreOperationListResult>;
  cancel(
    params: CoreOperationCancelParams,
    options?: CanopyClientInstructionOptions,
  ): Promise<CoreOperationCancelResult>;
  events(
    params: CoreOperationEventsParams,
    options?: CanopyClientStreamOptions<
      CanopyClientStreamFrame<CoreOperationEventsItem, EventsEnd>
    >,
  ): Promise<DaemonOperationEventsHandle>;
}

function connected(options: DaemonOperationRouteOptions): OperationClient {
  const client = options.client();
  if (client) return client;
  throw new CanopyOperationError({
    kind: 'unavailable',
    message: 'No daemon session is open.',
    retry: { kind: 'never' },
  });
}

export function createDaemonOperationRoute(
  options: DaemonOperationRouteOptions,
): DaemonOperationRoute {
  return {
    get: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).query('core.operation.get', params, callOptions),
      ),
    list: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).query('core.operation.list', params, callOptions),
      ),
    cancel: (params, callOptions) =>
      Promise.resolve().then(() =>
        connected(options).instruction(
          'core.operation.cancel',
          params,
          callOptions,
        ),
      ),
    events: (params, streamOptions) =>
      Promise.resolve().then(() =>
        connected(options).openStream(
          'core.operation.events',
          params,
          streamOptions,
        ),
      ),
  };
}
