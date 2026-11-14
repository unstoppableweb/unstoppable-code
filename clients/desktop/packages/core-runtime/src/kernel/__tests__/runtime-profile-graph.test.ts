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
