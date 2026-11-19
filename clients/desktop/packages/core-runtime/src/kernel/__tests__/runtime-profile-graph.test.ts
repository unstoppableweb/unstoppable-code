import { createServiceContainer } from '../service-container';
import {
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError, type CanopyDispatcher } from '../../index';
import { CANOPY_RUNTIME_QUERY_DEFINITIONS } from '../canopy-runtime';
import {
  createRuntimeProfileGraph,
  defineRuntimeModule,
  type RuntimeModule,
} from '../runtime-profile-graph';
import type { RuntimeService } from '../service-container';
import { serializingWorkerPair } from '../../runtime/__tests__/serializing-worker-pair';
import {
  WORKER_EXAMPLE_INSTRUCTIONS,
  WORKER_EXAMPLE_STREAMS,
} from '../../runtime/__tests__/worker-example-definitions';
import { canopyUnavailableError } from '../../runtime/errors';
import type {
  CanopyDispatcherInstructionHandlerMap,
  CanopyDispatcherStreamHandlerMap,
  CanopyStreamFrame,
  CanopyStreamHandle,
} from '../../runtime/types';
import type * as Manifest from '../runtime-profile-manifest';

jest.mock('../runtime-profile-manifest', () => {
  const actual = jest.requireActual<typeof Manifest>(
    '../runtime-profile-manifest',
  );
  return {
    ...actual,
    // Installs this file's test-only worker operations wherever a worker runs.
    runtimeProfileInstalls: (
      ...[profile, name, kind]: Parameters<typeof actual.runtimeProfileInstalls>
    ): boolean =>
      name.startsWith('worker.example.')
        ? profile !== 'core'
        : actual.runtimeProfileInstalls(profile, name, kind),
  };
});

const caller: CanopyCallerDescriptor = {
  principalId: 'test',
  clientInstanceId: 'client',
  authorityId: 'authority',
  interfaceKind: 'test',
  grants: ['core.runtime.read', 'worker.filesystem.read'],
};
const none = { queries: {}, instructions: {}, streams: {} };
const roots = {
  roots: [{ fileRootId: 'root', name: 'repo', kind: 'git-repo' as const }],
};
let log: string[] = [];
beforeEach(() => {
  log = [];
});
const service = (
  name: string,
  plane: RuntimeService['plane'],
): RuntimeService => ({
  name,
  plane,
  start: () => void log.push(`start ${name}`),
  stop: { 7: () => void log.push(`stop ${name}`) },
});
const files = (): RuntimeModule =>
  defineRuntimeModule({
    name: 'worker.filesystem',
    plane: 'worker',
    services: [service('files', 'worker')],
    definitions: { ...none, queries: WORKER_QUERY_DEFINITIONS },
    handlers: {
      ...none,
      queries: {
        'worker.agent.usageLimits.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.agent.provider.list': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.roots.list': () => roots,
        'worker.filesystem.directory.list': () => ({ entries: [] }),
        'worker.filesystem.file.read': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.search': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.link.resolve': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.branch.list': () => ({
          branches: [],
          defaultBranch: null,
          defaultBranchSource: null,
        }),
        'worker.git.executable.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.remote.get': () => ({
          origin: { state: 'absent' as const },
        }),
        'worker.git.worktree.health.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.diff.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.list': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.groupMembers': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.pipeline.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.pipeline.execution.list': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.buildQueue.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.status.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.query': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.snapshot.export': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.languages.validate': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.operation.receipt.get': (): never => {
          throw new Error('Not exercised.');
        },
      },
    },
  });
const store: RuntimeModule = {
  name: 'core.store',
  plane: 'core',
  services: [service('store', 'core')],
  definitions: none,
  handlers: none,
};
const create = (
  profile: 'core' | 'worker' | 'core+worker',
  modules: RuntimeModule[],
  workerCaller?: CanopyCallerDescriptor,
): ReturnType<typeof createRuntimeProfileGraph> =>
  createRuntimeProfileGraph({
    profile,
    modules,
    workerCaller,
    workerBinding:
      workerCaller === undefined ? undefined : serializingWorkerPair(),
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
    shutdownTimeoutMs: 50,
  });
const list = (dispatcher: CanopyDispatcher): Promise<unknown> =>
  dispatcher.query(
    'worker.filesystem.roots.list',
    { scope: { workspaceId: 'workspace' } },
    { caller },
  );
const kind = (promise: Promise<unknown>): Promise<string> =>
  promise.then(
    () => 'resolved',
    (error: unknown) =>
      error instanceof CanopyOperationError ? error.payload.kind : 'thrown',
  );

it('drains admitted worker queries before closing the bundled binding', async () => {
  const module = files();
  let release = (): void => undefined;
  const result = new Promise<typeof roots>((resolve) => {
    release = (): void => resolve(roots);
  });
  const handler = jest.fn(() => result);
  const pair = serializingWorkerPair();
  const graph = createRuntimeProfileGraph({
    profile: 'core+worker',
    modules: [
      {
        ...module,
        handlers: {
          ...module.handlers,
          queries: {
            ...module.handlers.queries,
            'worker.filesystem.roots.list': handler,
          },
        },
      },
    ],
    workerCaller: caller,
    workerBinding: pair,
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
    shutdownTimeoutMs: 500,
  });
  await graph.start();
  const query = list(graph.dispatcher).catch((error: unknown) => error);
  await new Promise((resolve) => setImmediate(resolve));
  expect(handler).toHaveBeenCalledTimes(1);
  const shutdown = graph.shutdown('test');
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(pair.server.signal.aborted).toBe(false);
    release();
    expect(await query).toEqual(roots);
    await shutdown;
    expect(pair.server.signal.aborted).toBe(true);
  } finally {
    release();
    await shutdown;
  }
});

it.each(['core', 'worker', 'core+worker'] as const)(
  'constructs %s with isolated operations and seven shutdown phases',
  async (profile) => {
    const modules =
      profile === 'core'
        ? [store]
        : profile === 'worker'
          ? [files()]
          : [store, files()];
    const graph = create(profile, modules, caller);
    await graph.start();
    expect(graph.health().state).toBe('ready');
    if (profile === 'core')
      expect(await kind(list(graph.dispatcher))).toBe('capability_unavailable');
    else expect(await list(graph.dispatcher)).toEqual(roots);
    const health = graph.dispatcher.query(
      'core.runtime.health.get',
      {},
      { caller },
    );
    if (profile === 'worker')
      expect(await kind(health)).toBe('capability_unavailable');
    else
      expect(await health).toMatchObject({
        runtime: { profile, state: 'ready' },
      });
    expect(
      graph.operations.every(
        (op) => profile === 'core+worker' || op.plane === profile,
      ),
    ).toBe(true);
    expect((await graph.shutdown('test')).phases).toMatchObject(
      [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, status: 'completed' })),
    );
    expect(graph.dispatcher.state).toBe('closed');
    const names = modules.flatMap(
      (module) => module.services?.map(({ name }) => name) ?? [],
    );
    expect(log).toEqual([
      ...names.map((name) => `start ${name}`),
      ...names.reverse().map((name) => `stop ${name}`),
    ]);
  },
);

it('uses a host-bound worker caller and preserves both grant checks', async () => {
  const module = files();
  const seen = jest.fn(() => roots);
  module.handlers = {
    ...module.handlers,
    queries: {
      ...module.handlers.queries,
      'worker.filesystem.roots.list': seen,
    },
  };
  const graph = create('core+worker', [module], { ...caller, grants: [] });
  expect(await kind(list(graph.dispatcher))).toBe('permission_denied');
  expect(seen).not.toHaveBeenCalled();
  await graph.shutdown('test');
  const allowed = create('core+worker', [module], caller);
  const denied = allowed.dispatcher.query(
    'worker.filesystem.roots.list',
    { scope: {} },
    { caller: { ...caller, grants: [] } },
  );
  expect(await kind(denied)).toBe('permission_denied');
  expect(seen).not.toHaveBeenCalled();
  await allowed.shutdown('test');
});

it('requires an injected binding instead of falling back to worker handler calls', () => {
  expect(() =>
    createRuntimeProfileGraph({
      profile: 'core+worker',
      modules: [files()],
      workerCaller: caller,
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
    }),
  ).toThrow('workerBinding');
});

it('crosses the injected request and response binding before returning worker results', async () => {
  const pair = serializingWorkerPair();
  const graph = createRuntimeProfileGraph({
    profile: 'core+worker',
    modules: [files()],
    workerCaller: caller,
    ...{ workerBinding: pair },
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
  });
  try {
    expect(await list(graph.dispatcher)).toEqual(roots);
    expect(pair.client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'worker.filesystem.roots.list',
      }),
    );
    expect(pair.server.send).toHaveBeenCalledWith(
      expect.objectContaining({ result: roots }),
    );
  } finally {
    await graph.shutdown('test');
    pair.client.close();
  }
});

it('cannot bypass a failed binding to reach worker handlers', async () => {
  const pair = serializingWorkerPair();
  pair.client.send.mockRejectedValue(canopyUnavailableError());
  const module = files();
  const seen = jest.fn(() => roots);
  module.handlers = {
    ...module.handlers,
    queries: {
      ...module.handlers.queries,
      'worker.filesystem.roots.list': seen,
    },
  };
  const graph = createRuntimeProfileGraph({
    profile: 'core+worker',
    modules: [module],
    workerCaller: caller,
    workerBinding: pair,
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
  });
  try {
    expect(await kind(list(graph.dispatcher))).toBe('unavailable');
    expect(seen).not.toHaveBeenCalled();
  } finally {
    await graph.shutdown('test');
  }
});

it('preserves a bundled worker error payload across both envelopes', async () => {
  const module = files();
  const payload = {
    kind: 'not_found' as const,
    message: 'Missing root.',
    retry: { kind: 'never' as const },
    details: { fileRootId: 'missing' },
  };
  module.handlers = {
    ...module.handlers,
    queries: {
      ...module.handlers.queries,
      'worker.filesystem.roots.list': (): never => {
        throw new CanopyOperationError(payload, new Error('private cause'));
      },
    },
  };
  const graph = create('core+worker', [module], caller);
  try {
    await expect(list(graph.dispatcher)).rejects.toMatchObject({
      payload,
      runtimeCause: undefined,
    });
  } finally {
    await graph.shutdown('test');
  }
});

it('rejects foreign planes, SDKs, ownership mismatches, missing handlers and absent operations', () => {
  const reject = (
    profile: 'core' | 'worker' | 'core+worker',
    modules: RuntimeModule[],
    message: string,
  ): void => {
    expect(() => create(profile, modules)).toThrow(message);
  };
  reject('core', [files()], 'cannot host worker module');
  reject('worker', [store], 'cannot host core module');
  for (const profile of ['core', 'core+worker'] as const)
    reject(
      profile,
      [{ ...store, providerSdk: true }],
      'cannot carry a provider SDK',
    );
  reject('core+worker', [files()], 'require a workerCaller');
  reject(
    'core+worker',
    [{ ...files(), services: [service('store', 'core')] }],
    'cannot host core service',
  );
  reject(
    'core+worker',
    [{ ...files(), plane: 'core', services: [] }],
    'cannot register worker operation',
  );
  reject('core', [store, store], 'Duplicate operation owner');
  reject(
    'core',
    [{ ...store, handlers: files().handlers }],
    'must handle exactly its own',
  );
  reject(
    'worker',
    [{ ...files(), handlers: none }],
    'must handle exactly its own',
  );
  const health = CANOPY_RUNTIME_QUERY_DEFINITIONS['core.runtime.health.get'];
  for (const operation of ['core.absent.read', 'core.runtime.shadow'])
    reject(
      'core',
      [
        {
          ...store,
          definitions: { ...none, queries: { [operation]: health } },
          handlers: { ...none, queries: { [operation]: (): unknown => ({}) } },
        },
      ],
      'does not install',
    );
});

it('fails closed when the host supplies no principal resolver', async () => {
  const graph = create('core', []);
  await expect(
    graph.dispatcher.query('core.runtime.manifest.get', {}, { caller }),
  ).resolves.toMatchObject({ operations: [] });
  await graph.shutdown('test');
});

type Write = CanopyDispatcherInstructionHandlerMap<
  typeof WORKER_EXAMPLE_INSTRUCTIONS
>['worker.example.write'];
type Events = CanopyDispatcherStreamHandlerMap<
  typeof WORKER_EXAMPLE_STREAMS
>['worker.example.events'];
const exampleCaller: CanopyCallerDescriptor = {
  ...caller,
  grants: [...caller.grants, 'worker.example.read', 'worker.example.write'],
};
const write = { daemonEpoch: 'epoch', sequence: 1 };
const keyed = { idempotencyKey: 'key' };
const example = (
  handlers: { write?: Write; events?: Events } = {},
): RuntimeModule =>
  defineRuntimeModule({
    name: 'worker.example',
    plane: 'worker',
    definitions: {
      queries: {},
      instructions: WORKER_EXAMPLE_INSTRUCTIONS,
      streams: WORKER_EXAMPLE_STREAMS,
    },
    handlers: {
      queries: {},
      instructions: {
        'worker.example.write':
          handlers.write ?? ((params): typeof write => params),
      },
      streams: {
        'worker.example.events':
          handlers.events ??
          ((_params, _context, sink): Promise<void> => {
            sink.emit({ daemonEpoch: 'one' });
            sink.end('completed');
            return Promise.resolve();
          }),
      },
    },
  });
const bundled = (
  modules: RuntimeModule[],
  pair = serializingWorkerPair(),
): ReturnType<typeof createRuntimeProfileGraph> =>
  createRuntimeProfileGraph({
    profile: 'core+worker',
    modules,
    workerCaller: exampleCaller,
    workerBinding: pair,
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
    shutdownTimeoutMs: 50,
  });
const instruct = (dispatcher: CanopyDispatcher): Promise<unknown> =>
  dispatcher.instruction('worker.example.write', write, {
    caller: exampleCaller,
    metadata: keyed,
  });
const subscribe = (
  dispatcher: CanopyDispatcher,
): Promise<CanopyStreamHandle<unknown, unknown>> =>
  dispatcher.openStream(
    'worker.example.events',
    { daemonEpoch: 'scope', cursor: null },
    { caller: exampleCaller },
  );
async function frames(
  handle: CanopyStreamHandle<unknown, unknown>,
): Promise<CanopyStreamFrame<unknown, unknown>[]> {
  const collected: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) collected.push(frame);
  return collected;
}

it('carries bundled worker instructions and streams across the binding', async () => {
  const pair = serializingWorkerPair();
  const graph = bundled([files(), example()], pair);
  try {
    await expect(instruct(graph.dispatcher)).resolves.toEqual(write);
    expect(await frames(await subscribe(graph.dispatcher))).toMatchObject([
      { kind: 'item', item: { daemonEpoch: 'one' } },
      { kind: 'end', outcome: 'completed' },
    ]);
    expect(
      pair.client.send.mock.calls.map(
        ([message]) => 'method' in message && message.method,
      ),
    ).toEqual(['worker.example.write', 'worker.example.events']);
    expect(pair.server.send).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'worker.example.events.item' }),
    );
  } finally {
    await graph.shutdown('test');
  }
});

it('cannot bypass a failed binding to reach worker instruction or stream handlers', async () => {
  const pair = serializingWorkerPair();
  pair.client.send.mockRejectedValue(canopyUnavailableError());
  const writeHandler = jest.fn((params: typeof write) => params);
  const eventsHandler = jest.fn((): Promise<void> => Promise.resolve());
  const graph = bundled(
    [example({ write: writeHandler, events: eventsHandler })],
    pair,
  );
  try {
    expect(await kind(instruct(graph.dispatcher))).toBe('unavailable');
    expect(await frames(await subscribe(graph.dispatcher))).toMatchObject([
      { kind: 'end', outcome: 'error', error: { kind: 'unavailable' } },
    ]);
    expect(writeHandler).not.toHaveBeenCalled();
    expect(eventsHandler).not.toHaveBeenCalled();
  } finally {
    await graph.shutdown('test');
  }
});

/**
 * A bundled graph whose guard admits every forwarded instruction and records
 * each release, with a worker write that runs until `finish` and ignores its
 * cancellation, as a write past its point of no return does (CAN-4730 E2-G).
 */
function guardedSlowWrite(): {
  graph: ReturnType<typeof createRuntimeProfileGraph>;
  pair: ReturnType<typeof serializingWorkerPair>;
  release: jest.Mock;
  entered: Promise<void>;
  finish(): void;
  start(signal?: AbortSignal): Promise<string>;
} {
  const pair = serializingWorkerPair();
  const release = jest.fn();
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const graph = createRuntimeProfileGraph({
    profile: 'core+worker',
    modules: [
      example({
        write: async (params) => {
          enter();
          await finished;
          return params;
        },
      }),
    ],
    workerCaller: exampleCaller,
    workerBinding: pair,
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
    shutdownTimeoutMs: 50,
    instructionGuard: () => release,
  });
  return {
    graph,
    pair,
    release,
    entered,
    finish,
    start: (signal) =>
      kind(
        graph.dispatcher.instruction('worker.example.write', write, {
          caller: exampleCaller,
          metadata: keyed,
          ...(signal && { signal }),
        }),
      ),
  };
}
const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 20; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

it('holds a guarded instruction admitted after its caller cancels, until the worker settles it', async () => {
  const run = guardedSlowWrite();
  try {
    const cancel = new AbortController();
    const outcome = run.start(cancel.signal);
    await run.entered;
    cancel.abort();
    expect(await outcome).toBe('cancelled');
    await settle();
    // The worker is still writing: admission stays held, so a fence waits.
    expect(run.release).not.toHaveBeenCalled();
    run.finish();
    await settle();
    expect(run.release).toHaveBeenCalledTimes(1);
  } finally {
    await run.graph.shutdown('test');
  }
});

it('keeps a guarded instruction admitted after its binding closes while the worker still runs it, with or without a cancel first', async () => {
  for (const cancelFirst of [true, false]) {
    const run = guardedSlowWrite();
    try {
      const cancel = new AbortController();
      const outcome = run.start(cancel.signal);
      await run.entered;
      if (cancelFirst) {
        cancel.abort();
        expect(await outcome).toBe('cancelled');
        await settle();
        expect(run.release).not.toHaveBeenCalled();
      }
      // The core's end of the binding is gone, but the worker's write is
      // still running. An in-process worker gives no exit to wait for, so
      // the write stays admitted: a fence over it can never be acknowledged.
      run.pair.client.close();
      if (!cancelFirst) expect(await outcome).toBe('unavailable');
      await settle();
      expect(run.release).not.toHaveBeenCalled();
      run.finish();
      await settle();
      expect(run.release).not.toHaveBeenCalled();
    } finally {
      run.finish();
      await run.graph.shutdown('test');
    }
  }
});

it('keeps a cancelled instruction admitted while its receipt lookup is refused at capacity, until the worker settles', async () => {
  const pair = serializingWorkerPair();
  const deliver = pair.client.send.getMockImplementation();
  if (!deliver) throw new Error('The test pair has no send.');
  // Each write request is delivered at once, but its send stays open, so
  // the binding counts it in flight and refuses further requests.
  const heldSends: Array<() => void> = [];
  let holding = true;
  pair.client.send.mockImplementation(async (message) => {
    await deliver(message);
    if (
      holding &&
      'method' in message &&
      message.method === 'worker.example.write'
    )
      await new Promise<void>((resolve) => heldSends.push(resolve));
  });
  const releases = new Map<number, jest.Mock>();
  let enterTarget: () => void = () => undefined;
  const targetEntered = new Promise<void>((resolve) => {
    enterTarget = resolve;
  });
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const graph = createRuntimeProfileGraph({
    profile: 'core+worker',
    modules: [
      example({
        write: async (params) => {
          if (params.sequence === 0) enterTarget();
          await finished;
          return params;
        },
      }),
    ],
    workerCaller: exampleCaller,
    workerBinding: pair,
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
    shutdownTimeoutMs: 50,
    instructionGuard: (_operation, params) => {
      const release = jest.fn();
      releases.set((params as typeof write).sequence, release);
      return release;
    },
  });
  const run = (sequence: number, signal?: AbortSignal): Promise<string> =>
    kind(
      graph.dispatcher.instruction(
        'worker.example.write',
        { daemonEpoch: 'epoch', sequence },
        {
          caller: exampleCaller,
          metadata: { idempotencyKey: `key-${sequence}` },
          ...(signal && { signal }),
        },
      ),
    );
  try {
    const cancel = new AbortController();
    const target = run(0, cancel.signal);
    await targetEntered;
    const others = Array.from({ length: 127 }, (_, index) => run(index + 1));
    await settle();
    cancel.abort();
    expect(await target).toBe('cancelled');
    await settle();
    // The receipt lookup is refused at capacity: nothing proves it settled.
    expect(releases.get(0)).not.toHaveBeenCalled();
    holding = false;
    heldSends.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The lookup now reaches the worker, which is still running it.
    expect(releases.get(0)).not.toHaveBeenCalled();
    finish();
    for (
      let wait = 0;
      wait < 100 && !releases.get(0)?.mock.calls.length;
      wait += 1
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(releases.get(0)).toHaveBeenCalledTimes(1);
    await Promise.all(others);
  } finally {
    holding = false;
    heldSends.splice(0).forEach((resolve) => resolve());
    finish();
    await graph.shutdown('test');
  }
});

it('refuses new bundled instructions after drain while queries and streams continue', async () => {
  const graph = bundled([files(), example()]);
  try {
    graph.dispatcher.drainInstructions();
    await expect(instruct(graph.dispatcher)).rejects.toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_idempotency_key' } },
    });
    expect(await list(graph.dispatcher)).toEqual(roots);
    expect(await frames(await subscribe(graph.dispatcher))).toMatchObject([
      { kind: 'item' },
      { kind: 'end', outcome: 'completed' },
    ]);
  } finally {
    await graph.shutdown('test');
  }
});

it('rejects a worker definition filed under another kind or one the wire cannot carry', () => {
  const module = example();
  const mislabeled = { ...WORKER_EXAMPLE_INSTRUCTIONS['worker.example.write'] };
  Object.defineProperty(mislabeled, 'kind', { value: 'stream' });
  expect(() =>
    bundled([
      {
        ...module,
        definitions: {
          ...module.definitions,
          instructions: { 'worker.example.write': mislabeled },
        },
      },
    ]),
  ).toThrow('declares worker.example.write as a stream in its instructions');
  expect(() =>
    bundled([
      {
        ...module,
        definitions: {
          ...module.definitions,
          streams: {
            'worker.example.events': {
              ...WORKER_EXAMPLE_STREAMS['worker.example.events'],
              openResult: undefined,
            },
          },
        },
      },
    ]),
  ).toThrow('needs an open result');
});

it('shares a host-supplied daemon epoch with every journal the host composes', async () => {
  const graph = createRuntimeProfileGraph({
    profile: 'core',
    modules: [store],
    daemonEpoch: 'runtime:shared-epoch',
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    phaseDeadlineMs: 1000,
  });
  await graph.start();
  try {
    const health = await graph.dispatcher.query(
      'core.runtime.health.get',
      {},
      { caller: { ...caller, grants: ['core.runtime.read'] } },
    );
    expect(health).toMatchObject({
      runtime: { daemonEpoch: 'runtime:shared-epoch' },
    });
  } finally {
    await graph.shutdown('test');
  }
  expect(() =>
    createRuntimeProfileGraph({
      profile: 'core',
      modules: [store],
      daemonEpoch: '',
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
      phaseDeadlineMs: 1000,
    }),
  ).toThrow(RangeError);
});

it('startup stop irreversibly fences later service admission while an earlier hook is pending', async () => {
  let enter = (): void => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release = (): void => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const later = jest.fn();
  const cancellation = new AbortController();
  const container = createServiceContainer({
    profile: 'core',
    services: [
      {
        name: 'pending',
        plane: 'core',
        start: (): Promise<void> => {
          enter();
          return barrier;
        },
      },
      { name: 'later', plane: 'core', start: later },
    ],
  });
  const starting = container.start(cancellation.signal);
  await entered;
  cancellation.abort();
  await expect(starting).rejects.toThrow();
  release();
  await expect(container.start()).rejects.toThrow();
  expect(later).not.toHaveBeenCalled();
});
