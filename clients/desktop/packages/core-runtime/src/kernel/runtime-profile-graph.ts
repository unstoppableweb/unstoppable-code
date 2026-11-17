import type {
  CanopyCallerDescriptor,
  CanopyInstructionDefinitionMap,
  CanopyQueryDefinitionMap,
  CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../runtime/dispatcher';
import type {
  CanopyDispatcher,
  CanopyDispatcherHandlerMap,
  CanopyDispatcherInstructionHandlerMap,
  CanopyDispatcherStreamHandlerMap,
  CanopyHandlerContext,
  CanopyRuntimeDefinitionMaps,
  CanopyRuntimeProfile,
  CanopyStreamSink,
} from '../runtime/types';
import {
  createCanopyRuntime,
  type CanopyRuntime,
  type CanopyRuntimeIdentity,
  type CreateCanopyRuntimeOptions,
} from './canopy-runtime';
import {
  createOperationRegistry,
  type RuntimeOperationOwner,
} from './operation-registry';
import { runtimeProfileInstalls } from './runtime-profile-manifest';
import { scopeForwardedIdempotency } from './peer-scoped-idempotency';
import { keyedInstructionReplay } from './keyed-instruction-fingerprint';
import {
  createInProcessWorkerBinding,
  localWorkerTransportOf,
  type WorkerBindingPair,
} from '../runtime/in-process-worker-binding';
import type { LocalWorkerTransport } from '../runtime/local-worker-transport';
import type { SupervisedLocalWorker } from '../runtime/supervised-local-worker';
import {
  createWorkerExecutorReceipts,
  type WorkerExecutorReceipts,
} from '../runtime/worker-executor-receipts';
import {
  createServiceContainer,
  type RuntimeService,
} from './service-container';
import {
  createShutdownSequence,
  type ShutdownPhase,
} from './shutdown-sequence';

type Plane = RuntimeService['plane'];
// Method-derived signatures are bivariant, so the typed maps accepted by
// `defineRuntimeModule` widen without casts; the dispatcher still validates
// params and results against each definition's schemas.
type ModuleHandler = {
  run(params: unknown, context: CanopyHandlerContext): unknown;
}['run'];
type ModuleStreamHandler = {
  run(
    params: unknown,
    context: CanopyHandlerContext,
    sink: CanopyStreamSink<unknown>,
  ): Promise<(() => void) | void>;
}['run'];

export type RuntimeModuleDefinitions = CanopyRuntimeDefinitionMaps<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
>;
export interface RuntimeModuleHandlers {
  queries: Readonly<Record<string, ModuleHandler>>;
  instructions: Readonly<Record<string, ModuleHandler>>;
  streams: Readonly<Record<string, ModuleStreamHandler>>;
}

/** One plane's domain slice: its operations, handlers, and services. */
export interface RuntimeModule {
  name: string;
  plane: Plane;
  /** Host-declared provider dependency; concrete composition roots must also check imports at build time. */
  providerSdk?: boolean;
  services?: readonly RuntimeService[];
  definitions: RuntimeModuleDefinitions;
  handlers: RuntimeModuleHandlers;
}

export function defineRuntimeModule<
  const Q extends CanopyQueryDefinitionMap,
  const I extends CanopyInstructionDefinitionMap,
  const S extends CanopyStreamDefinitionMap,
>(
  module: Omit<RuntimeModule, 'definitions' | 'handlers'> & {
    definitions: CanopyRuntimeDefinitionMaps<Q, I, S>;
    handlers: {
      queries: CanopyDispatcherHandlerMap<Q>;
      instructions: CanopyDispatcherInstructionHandlerMap<I>;
      streams: CanopyDispatcherStreamHandlerMap<S>;
    };
  },
): RuntimeModule {
  return module;
}

export interface CreateRuntimeProfileGraphOptions {
  profile: CanopyRuntimeProfile;
  identity: CanopyRuntimeIdentity;
  /** Shared with a host journal's cursors; see `CreateCanopyRuntimeOptions`. */
  daemonEpoch?: string;
  modules: readonly RuntimeModule[];
  /** Per shutdown phase; phase 3 must outlast `shutdownTimeoutMs`. */
  phaseDeadlineMs: number;
  shutdownTimeoutMs?: number;
  principalFor?: CreateCanopyRuntimeOptions<
    CanopyQueryDefinitionMap,
    CanopyInstructionDefinitionMap,
    CanopyStreamDefinitionMap,
    CanopyDispatcher
  >['principalFor'];
  /** Trusted owning-core identity and grants for the bundled worker boundary. */
  workerCaller?: CanopyCallerDescriptor;
  /** Required for bundled worker modules; the host supplies serialized envelopes. */
  workerBinding?: WorkerBindingPair;
  /**
   * Split composition: the worker modules run in a separate supervised
   * process, so the graph declares them and routes them through `worker`,
   * and `modules` holds no worker module. Only `core+worker` installs it.
   */
  supervisedWorker?: {
    readonly modules: readonly SupervisedWorkerModule[];
    readonly worker: SupervisedLocalWorker;
  };
  /**
   * Forwarded worker instructions whose idempotency keys are scoped to the
   * interface caller before they cross the worker binding (CAN-5629).
   */
  peerScopedIdempotency?: ReadonlySet<string>;
  /**
   * Keyed worker instructions whose repeated key replays the first
   * request's settlement instead of running again (CAN-4733). Applies to the
   * bundled worker and to a `worker` profile graph.
   */
  replayedKeyedInstructions?: ReadonlySet<string>;
}

function executorReceiptsFor(
  instructions: CanopyInstructionDefinitionMap,
  options: CreateRuntimeProfileGraphOptions,
): WorkerExecutorReceipts {
  const { replayedKeyedInstructions } = options;
  if (replayedKeyedInstructions === undefined)
    return createWorkerExecutorReceipts(instructions);
  for (const name of replayedKeyedInstructions)
    if (instructions[name]?.idempotency !== 'keyed')
      throw new Error(`Replayed worker instruction ${name} must be keyed`);
  return createWorkerExecutorReceipts(instructions, {
    replay: keyedInstructionReplay(replayedKeyedInstructions),
  });
}

/** A worker module served by a supervised worker process: its name and operations. */
export interface SupervisedWorkerModule {
  readonly name: string;
  readonly definitions: RuntimeModuleDefinitions;
}

interface ComposedModules {
  definitions: RuntimeModuleDefinitions;
  handlers: RuntimeModuleHandlers;
  owners: RuntimeOperationOwner[];
  services: RuntimeService[];
}

const KINDS = ['queries', 'instructions', 'streams'] as const;
const OPERATION_KINDS = {
  queries: 'query',
  instructions: 'instruction',
  streams: 'stream',
} as const;

/** Each definition must sit in its own kind's map and be installed by the profile. */
function admitDefinitions(
  profile: CanopyRuntimeProfile,
  module: string,
  kind: (typeof KINDS)[number],
  declared: Readonly<Record<string, { kind: string }>>,
): string[] {
  for (const [operation, definition] of Object.entries(declared)) {
    if (definition.kind !== OPERATION_KINDS[kind])
      throw new Error(
        `Module ${module} declares ${operation} as a ${definition.kind} in its ${kind}`,
      );
    if (!runtimeProfileInstalls(profile, operation, OPERATION_KINDS[kind]))
      throw new Error(
        `Runtime profile ${profile} does not install ${operation}`,
      );
  }
  return Object.keys(declared);
}

/** Operation ownership and planes are checked by the operation registry. */
function composeModules(
  profile: CanopyRuntimeProfile,
  modules: readonly RuntimeModule[],
): ComposedModules {
  const composed: ComposedModules = {
    definitions: { queries: {}, instructions: {}, streams: {} },
    handlers: { queries: {}, instructions: {}, streams: {} },
    owners: [],
    services: [],
  };
  for (const { name, plane, providerSdk, services = [], ...maps } of modules) {
    if (profile !== 'core+worker' && profile !== plane)
      throw new Error(
        `Runtime profile ${profile} cannot host ${plane} module ${name}`,
      );
    if (plane === 'core' && providerSdk === true)
      throw new Error(`Core module ${name} cannot carry a provider SDK`);
    for (const service of services)
      if (service.plane !== plane)
        throw new Error(
          `Module ${name} cannot host ${service.plane} service ${service.name}`,
        );
    const operations: string[] = [];
    for (const kind of KINDS) {
      const names = admitDefinitions(
        profile,
        name,
        kind,
        maps.definitions[kind],
      );
      const handled = Object.keys(maps.handlers[kind]);
      if (
        handled.length !== names.length ||
        !handled.every((op) => names.includes(op))
      )
        throw new Error(`Module ${name} must handle exactly its own ${kind}`);
      operations.push(...names);
      Object.assign(composed.definitions[kind], maps.definitions[kind]);
      Object.assign(composed.handlers[kind], maps.handlers[kind]);
    }
    composed.owners.push({ name, plane, operations });
    composed.services.push(...services);
  }
  return composed;
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void => reject(new Error('Shutdown phase aborted'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * `core.runtime` is core-plane, so a worker graph mirrors its 7 phases. Its
 * instruction handlers record executor receipts, as a bundled worker's do.
 */
function createWorkerRuntime(
  options: CreateRuntimeProfileGraphOptions,
  { definitions, handlers, owners, services }: ComposedModules,
): CanopyRuntime<CanopyDispatcher> & { executor: WorkerExecutor } {
  const profile = 'worker';
  const operations = createOperationRegistry({ profile, definitions, owners });
  const container = createServiceContainer({ profile, services });
  const { shutdownTimeoutMs } = options;
  const receipts = executorReceiptsFor(definitions.instructions, options);
  const dispatcher = createCanopyDispatcher({
    profile,
    definitions,
    handlers: {
      ...handlers,
      instructions: receipts.wrap(handlers.instructions),
    },
    shutdownTimeoutMs,
  });
  const phase = (
    id: ShutdownPhase['id'],
    name: string,
    run: ShutdownPhase['run'],
  ): ShutdownPhase => ({ id, name, deadlineMs: options.phaseDeadlineMs, run });
  const sequence = createShutdownSequence({
    phases: [
      phase(1, 'drain-instructions', () => dispatcher.drainInstructions()),
      phase(2, 'publish-stopping', () => container.markStopping()),
      phase(3, 'cancel-work', async (signal) => {
        try {
          await Promise.race([dispatcher.shutdown(), untilAborted(signal)]);
        } finally {
          await container.stopPhase(3, signal);
        }
      }),
      phase(4, 'stop-schedulers', (signal) => container.stopPhase(4, signal)),
      phase(5, 'stop-processes', (signal) => container.stopPhase(5, signal)),
      phase(6, 'flush', (signal) => container.stopPhase(6, signal)),
      phase(7, 'close-resources', (signal) => container.stopPhase(7, signal)),
    ],
  });
  return {
    dispatcher,
    operations,
    start: (signal) => container.start(signal),
    health: () => container.health(),
    shutdown: (reason) => sequence.run(reason),
    executor: { definitions, receipts },
  };
}

/** A binding's forwarders with the opted-in instructions' keys scoped per caller. */
function scopedForwarders(
  forwarders: RuntimeModuleHandlers,
  options: CreateRuntimeProfileGraphOptions,
): RuntimeModuleHandlers {
  return {
    ...forwarders,
    instructions: scopeForwardedIdempotency(
      forwarders.instructions,
      options.peerScopedIdempotency ?? new Set(),
    ),
  };
}

/**
 * Bundled worker modules run on a worker dispatcher behind the binding; the
 * core dispatcher holds only the binding's forwarders for their operations.
 */
function bindBundledWorker(options: CreateRuntimeProfileGraphOptions): {
  handlers: RuntimeModuleHandlers;
  worker: CanopyDispatcher | null;
  transport: LocalWorkerTransport | null;
  close: () => void;
} {
  const { supervisedWorker } = options;
  if (supervisedWorker)
    return {
      handlers: scopedForwarders(supervisedWorker.worker.forwarders, options),
      worker: null,
      transport: supervisedWorker.worker.transport,
      close: () => undefined,
    };
  const modules = options.modules.filter(({ plane }) => plane === 'worker');
  const { definitions, handlers } = composeModules('core+worker', modules);
  if (modules.length === 0)
    return {
      handlers: { queries: {}, instructions: {}, streams: {} },
      worker: null,
      transport: null,
      close: () => undefined,
    };
  if (options.workerCaller === undefined)
    throw new Error('Bundled worker modules require a workerCaller');
  if (options.workerBinding === undefined)
    throw new Error('Bundled worker modules require a workerBinding');
  // The executor half of shared idempotency (CAN-4132).
  const receipts = executorReceiptsFor(definitions.instructions, options);
  const worker = createCanopyDispatcher({
    profile: 'worker',
    definitions,
    handlers: {
      ...handlers,
      instructions: receipts.wrap(handlers.instructions),
    },
    shutdownTimeoutMs: options.shutdownTimeoutMs,
  });
  const binding = createInProcessWorkerBinding({
    dispatcher: worker,
    definitions,
    caller: options.workerCaller,
    pair: options.workerBinding,
    receipts,
  });
  return {
    handlers: scopedForwarders(binding.forwarders, options),
    worker,
    transport: localWorkerTransportOf(binding, definitions.instructions),
    close: () => binding.close(),
  };
}

/**
 * The supervised worker's modules as the registry sees them: worker-plane
 * owners whose handlers are only the core's routes to the worker process.
 */
function supervisedModules(
  options: CreateRuntimeProfileGraphOptions,
): RuntimeModule[] {
  const { supervisedWorker, profile } = options;
  if (supervisedWorker === undefined) return [];
  if (profile !== 'core+worker')
    throw new Error(`Runtime profile ${profile} cannot supervise a worker`);
  if (options.modules.some(({ plane }) => plane === 'worker'))
    throw new Error('A supervised worker hosts every worker module');
  const forwarders = scopedForwarders(
    supervisedWorker.worker.forwarders,
    options,
  );
  const routes = <T>(
    from: Readonly<Record<string, T>>,
    names: Readonly<Record<string, unknown>>,
  ): Record<string, T> =>
    Object.fromEntries(
      Object.keys(names).map((name) => {
        const route = from[name];
        if (route === undefined)
          throw new Error(`The supervised worker does not serve ${name}`);
        return [name, route];
      }),
    );
  return supervisedWorker.modules.map(({ name, definitions }) => ({
    name,
    plane: 'worker',
    definitions,
    handlers: {
      queries: routes(forwarders.queries, definitions.queries),
      instructions: routes(forwarders.instructions, definitions.instructions),
      streams: routes(forwarders.streams, definitions.streams),
    },
  }));
}

/** What a core needs to serve a worker graph's dispatcher across a binding. */
export interface WorkerExecutor {
  readonly definitions: RuntimeModuleDefinitions;
  readonly receipts: WorkerExecutorReceipts;
}

export interface RuntimeProfileGraph extends CanopyRuntime<CanopyDispatcher> {
  /**
   * The core's transport to the bundled local worker, for dispatch records
   * (CAN-4132); null when the graph bundles no worker module.
   */
  readonly localWorker: LocalWorkerTransport | null;
  /** A `worker` graph's maps and receipts, for its binding; null otherwise. */
  readonly executor: WorkerExecutor | null;
}

/** Builds a `core`, `worker`, or bundled `core+worker` runtime from modules. */
export function createRuntimeProfileGraph(
  options: CreateRuntimeProfileGraphOptions,
): RuntimeProfileGraph {
  const { profile, shutdownTimeoutMs } = options;
  const composed = composeModules(profile, [
    ...options.modules,
    ...supervisedModules(options),
  ]);
  if (profile === 'worker')
    return { ...createWorkerRuntime(options, composed), localWorker: null };
  let localWorker: LocalWorkerTransport | null = null;
  const graph = createCanopyRuntime({
    profile,
    identity: options.identity,
    daemonEpoch: options.daemonEpoch,
    definitions: composed.definitions,
    owners: composed.owners,
    services: composed.services,
    principalFor: options.principalFor,
    phaseDeadlineMs: options.phaseDeadlineMs,
    // Runs after the operation registry validated the whole graph.
    createDispatcher: (input) => {
      const definitions: RuntimeModuleDefinitions = input.definitions;
      const runtime: RuntimeModuleHandlers = {
        ...input.runtimeHandlers,
        instructions: {},
      };
      const {
        handlers: bound,
        worker,
        transport,
        close: closeBinding,
      } = bindBundledWorker(options);
      localWorker = transport;
      // Worker handlers never join this map, so a missing forwarder fails
      // dispatcher validation instead of reaching a worker handler directly.
      const core = composeModules(
        profile,
        options.modules.filter(({ plane }) => plane === 'core'),
      ).handlers;
      const bundle = createCanopyDispatcher({
        profile: input.profile,
        definitions,
        handlers: {
          queries: { ...core.queries, ...bound.queries, ...runtime.queries },
          instructions: { ...core.instructions, ...bound.instructions },
          streams: { ...core.streams, ...bound.streams, ...runtime.streams },
        },
        shutdownTimeoutMs,
      });
      if (worker === null) return bundle;
      const drain = bundle.drainInstructions.bind(bundle);
      const close = bundle.shutdown.bind(bundle);
      return Object.assign(bundle, {
        drainInstructions: (): void => {
          drain();
          worker.drainInstructions();
        },
        shutdown: async (): Promise<void> => {
          try {
            await close();
          } finally {
            closeBinding();
            await worker.shutdown();
          }
        },
      });
    },
  });
  return Object.assign(graph, { localWorker, executor: null });
}
