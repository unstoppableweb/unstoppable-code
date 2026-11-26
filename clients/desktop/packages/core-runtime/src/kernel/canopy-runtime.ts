import {
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CoreRuntimeDescriptorSchema,
  defineCanopyQueryRegistry,
  defineCanopyStreamRegistry,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryDefinitionMap,
  type CanopyStreamDefinitionMap,
  type CoreRuntimeDescriptor,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyDispatcher,
  CanopyDispatcherHandlerMap,
  CanopyDispatcherStreamHandlerMap,
  CanopyDispatcherStreamItemInput,
  CanopyRuntimeDefinitionMaps,
  CanopyRuntimeProfile,
  CanopyHandlerContext,
} from '../runtime/types';
import {
  effectiveRuntimeOperations,
  type RuntimePrincipal,
} from './runtime-profile-manifest';
import { createEventJournal } from './event-journal';
import {
  createOperationRegistry,
  type RuntimeOperation,
  type RuntimeOperationOwner,
} from './operation-registry';
import {
  createServiceContainer,
  type RuntimeHealth,
  type RuntimeService,
  type ServiceStopPhase,
} from './service-container';
import {
  createShutdownSequence,
  type ShutdownPhase,
  type ShutdownReport,
} from './shutdown-sequence';

const HEALTH = 'core.runtime.health.get';
const EVENTS = 'core.runtime.events';
const MANIFEST = 'core.runtime.manifest.get';
// The handshake (`core.runtime.initialize`) negotiates per connection (C6).
const PROTOCOL_VERSIONS = [1];

export const CANOPY_RUNTIME_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    [HEALTH]: CORE_TRANSPORT_QUERY_DEFINITIONS[HEALTH],
    [MANIFEST]: CORE_TRANSPORT_QUERY_DEFINITIONS[MANIFEST],
  },
);
export const CANOPY_RUNTIME_STREAM_DEFINITIONS = defineCanopyStreamRegistry(
  'core',
  { [EVENTS]: CORE_TRANSPORT_STREAM_DEFINITIONS[EVENTS] },
);
export type CanopyRuntimeQueries = typeof CANOPY_RUNTIME_QUERY_DEFINITIONS;
export type CanopyRuntimeStreams = typeof CANOPY_RUNTIME_STREAM_DEFINITIONS;
export type CanopyRuntimeEvent = CanopyDispatcherStreamItemInput<
  CanopyRuntimeStreams,
  typeof EVENTS
>;

/** Host-supplied stable identity; the daemon epoch is fresh per runtime. */
export interface CanopyRuntimeIdentity {
  runtimeId: string;
  hostId: string;
  authorityId: string | null;
}

export type CanopyRuntimeDispatcherPort = Pick<
  CanopyDispatcher,
  'drainInstructions' | 'shutdown'
>;

/** The host merges `runtimeHandlers` into its concrete handler maps. */
export interface CanopyRuntimeDispatcherInput<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap,
> {
  profile: CanopyRuntimeProfile;
  definitions: CanopyRuntimeDefinitionMaps<
    Q & CanopyRuntimeQueries,
    I,
    S & CanopyRuntimeStreams
  >;
  runtimeHandlers: {
    queries: CanopyDispatcherHandlerMap<CanopyRuntimeQueries>;
    streams: CanopyDispatcherStreamHandlerMap<CanopyRuntimeStreams>;
  };
  /** The epoch `core.runtime.initialize` reports for this runtime. */
  daemonEpoch: string;
}

export interface CreateCanopyRuntimeOptions<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap,
  D extends CanopyRuntimeDispatcherPort,
> {
  profile: CanopyRuntimeProfile;
  identity: CanopyRuntimeIdentity;
  /**
   * The epoch of this runtime's cursors, when the host also issues cursors
   * from another journal it composes (W5e); fresh per runtime by default.
   */
  daemonEpoch?: string;
  definitions: CanopyRuntimeDefinitionMaps<Q, I, S>;
  /** Owners of every host operation; `core.runtime` owns the runtime's own. */
  owners: readonly RuntimeOperationOwner[];
  services: readonly RuntimeService[];
  /** Minor schema revisions (protocol rule 5) the manifest advertises. */
  schemaRevisions?: Readonly<Record<string, number>>;
  /** Resolves authenticated host bindings; absent resolution advertises nothing. */
  principalFor?: (context: CanopyHandlerContext) => RuntimePrincipal | null;
  /** Per shutdown phase; phase 3 must outlast the dispatcher's own drain. */
  phaseDeadlineMs: number;
  createDispatcher(input: CanopyRuntimeDispatcherInput<Q, I, S>): D;
}

export interface CanopyRuntime<D> {
  readonly dispatcher: D;
  readonly operations: readonly RuntimeOperation[];
  /** Idempotent. Rejects when a required service fails; health stays queryable. */
  start(signal?: AbortSignal): Promise<void>;
  health(): RuntimeHealth;
  /** Idempotent; later calls return the first run's report. */
  shutdown(reason: string): Promise<ShutdownReport>;
}

const PHASE_NAMES = {
  4: 'stop-schedulers',
  5: 'stop-processes',
  6: 'flush',
  7: 'close-resources',
} as const;

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => reject(new Error('Shutdown phase aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

export function createCanopyRuntime<
  const Q extends CanopyQueryDefinitionMap,
  const I extends CanopyInstructionDefinitionMap,
  const S extends CanopyStreamDefinitionMap,
  D extends CanopyRuntimeDispatcherPort,
>(options: CreateCanopyRuntimeOptions<Q, I, S, D>): CanopyRuntime<D> {
  const { profile } = options;
  // Snapshot: later caller mutation must not change descriptors.
  const { runtimeId, hostId, authorityId } = options.identity;
  const schemaRevisions = { ...options.schemaRevisions };
  const host = options.definitions;
  for (const name of [HEALTH, EVENTS, MANIFEST])
    for (const map of [host.queries, host.instructions, host.streams])
      if (Object.prototype.hasOwnProperty.call(map, name))
        throw new Error(`Operation ${name} is reserved by the runtime`);
  // Spread keeps the concrete host maps; handler maps merge in the host.
  const definitions = {
    queries: { ...host.queries, ...CANOPY_RUNTIME_QUERY_DEFINITIONS },
    instructions: host.instructions,
    streams: { ...host.streams, ...CANOPY_RUNTIME_STREAM_DEFINITIONS },
  };
  // Also rejects runtime operations a worker-only profile cannot host.
  const operations = createOperationRegistry({
    profile,
    definitions,
    owners: [
      ...options.owners,
      {
        name: 'core.runtime',
        plane: 'core',
        operations: [HEALTH, EVENTS, MANIFEST],
      },
    ],
  });

  const journal = createEventJournal<CanopyRuntimeEvent>({
    epoch: options.daemonEpoch ?? `runtime:${crypto.randomUUID()}`,
  });
  const descriptor = (
    state: CoreRuntimeDescriptor['state'],
  ): CoreRuntimeDescriptor => ({
    runtimeId,
    hostId,
    authorityId,
    profile,
    daemonEpoch: journal.epoch,
    protocolVersions: PROTOCOL_VERSIONS,
    state,
  });
  CoreRuntimeDescriptorSchema.parse(descriptor('starting'));
  const container = createServiceContainer({
    profile,
    services: options.services,
    onChange: ({ state, checks }) => {
      if (state !== 'starting')
        journal.append({
          event: state,
          runtime: descriptor(state),
          details: { checks },
        });
    },
  });
  const closeEventStreams = new AbortController();

  const dispatcher = options.createDispatcher({
    profile,
    definitions,
    daemonEpoch: journal.epoch,
    runtimeHandlers: {
      queries: {
        [MANIFEST]: (params, context) => ({
          runtime: descriptor(container.health().state),
          operations: effectiveRuntimeOperations({
            profile,
            definitions,
            principal: options.principalFor?.(context) ?? null,
            grants: context.caller.grants,
            includeUnavailable: params.includeUnavailable,
          }).map((operation) =>
            Object.prototype.hasOwnProperty.call(
              schemaRevisions,
              operation.name,
            )
              ? {
                  ...operation,
                  schemaRevision: schemaRevisions[operation.name],
                }
              : operation,
          ),
          generatedAt: new Date().toISOString(),
        }),
        [HEALTH]: () => {
          const { state, checks } = container.health();
          return { runtime: descriptor(state), checks };
        },
      },
      streams: {
        [EVENTS]: (params, _context, sink) => {
          const subscription = journal.subscribe(params.cursor, (entry) => {
            sink.emitAt(entry.cursor, entry.event);
          });
          if (subscription.kind === 'snapshot_required') {
            sink.end('error', {
              kind: 'failed_precondition',
              message: `The runtime event cursor cannot resume (${subscription.reason}); re-read runtime health.`,
              code: 'core.runtime.snapshotRequired',
              retry: { kind: 'after_refresh', resource: HEALTH },
            });
            return Promise.resolve();
          }
          const close = (): void => sink.end('completed');
          if (closeEventStreams.signal.aborted) close();
          closeEventStreams.signal.addEventListener('abort', close);
          return Promise.resolve((): void => {
            subscription.unsubscribe();
            closeEventStreams.signal.removeEventListener('abort', close);
          });
        },
      },
    },
  });
  // Captured before a host wrapper replaces `shutdown` with one that calls
  // back into this runtime; a lazy lookup would recurse until the deadline.
  const drainInstructions = dispatcher.drainInstructions.bind(dispatcher);
  const closeDispatcher = dispatcher.shutdown.bind(dispatcher);

  const phase = (
    id: ShutdownPhase['id'],
    name: string,
    run: ShutdownPhase['run'],
  ): ShutdownPhase => ({ id, name, deadlineMs: options.phaseDeadlineMs, run });
  const stopServices =
    (id: ServiceStopPhase) =>
    (signal: AbortSignal): Promise<void> =>
      container.stopPhase(id, signal);
  const sequence = createShutdownSequence({
    phases: [
      phase(1, 'drain-instructions', drainInstructions),
      phase(2, 'publish-stopping', () => container.markStopping()),
      phase(3, 'cancel-work', async (signal) => {
        closeEventStreams.abort();
        try {
          await Promise.race([
            Promise.resolve().then(closeDispatcher),
            untilAborted(signal),
          ]);
        } finally {
          await container.stopPhase(3, signal);
        }
      }),
      ...([4, 5, 6, 7] as const).map((id) =>
        phase(id, PHASE_NAMES[id], stopServices(id)),
      ),
    ],
  });

  return {
    dispatcher,
    operations,
    start: (signal) => container.start(signal),
    health: () => container.health(),
    shutdown: (reason) => sequence.run(reason),
  };
}
