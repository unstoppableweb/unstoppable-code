import {
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../dispatcher';
import { createInProcessWorkerBinding } from '../in-process-worker-binding';
import { connectLocalWorkerBinding } from '../local-worker-binding-client';
import { CanopyOperationError } from '../errors';
import type { CanopyDispatcherHandlerMap } from '../types';
import { serializingWorkerPair } from './serializing-worker-pair';

const pairs: ReturnType<typeof serializingWorkerPair>[] = [];
afterEach(() => {
  for (const pair of pairs.splice(0)) pair.client.close();
});

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'binding',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: ['worker.filesystem.read'],
};
const params = { scope: { workspaceId: 'workspace', worktreeId: 'worktree' } };
const roots = { roots: [] };
type Handler = CanopyDispatcherHandlerMap<
  typeof WORKER_QUERY_DEFINITIONS
>['worker.filesystem.roots.list'];
function build(
  grants = caller.grants,
  handler: Handler = () => roots,
): ReturnType<typeof createInProcessWorkerBinding> {
  const pair = serializingWorkerPair();
  pairs.push(pair);
  const definitions = {
    queries: WORKER_QUERY_DEFINITIONS,
    instructions: {},
    streams: {},
  };
  return createInProcessWorkerBinding({
    dispatcher: createCanopyDispatcher({
      profile: 'worker',
      definitions,
      handlers: {
        queries: {
          'worker.agent.usageLimits.get': (): never => {
            throw new Error('Not exercised.');
          },
          'worker.agent.provider.list': (): never => {
            throw new Error('Not exercised.');
          },
          'worker.filesystem.roots.list': handler,
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
          'worker.operation.receipt.get': (): never => {
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
        instructions: {},
        streams: {},
      },
    }),
    definitions,
    caller: { ...caller, grants },
    pair,
  });
}
const error = { payload: { kind: 'invalid_argument' } };
it('copies validated requests, metadata and results and fixes the worker caller', async () => {
  const metadata = { traceparent: 'trace' };
  const binding = build(caller.grants, (request, context) => {
    expect(request).toEqual(params);
    expect(request).not.toBe(params);
    expect(context.caller).toEqual(caller);
    expect(context.metadata).toEqual(metadata);
    expect(context.metadata).not.toBe(metadata);
    return roots;
  });
  const result = await binding.query('worker.filesystem.roots.list', params, {
    metadata,
  });
  expect(result).toEqual(roots);
  expect(result).not.toBe(roots);
});
it('answers a reply its connection refuses to send and keeps serving', async () => {
  const binding = build();
  const { server } = pairs[pairs.length - 1];
  // Refused before a byte was written, as a reply larger than the peer
  // reassembles is: only that call fails (CAN-5630).
  server.send.mockRejectedValueOnce(
    new CanopyOperationError({
      kind: 'resource_exhausted',
      message: 'Message too large.',
      retry: { kind: 'never' },
    }),
  );
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({
    payload: {
      kind: 'resource_exhausted',
      message: 'Message too large.',
      retry: { kind: 'never' },
    },
  });
  server.send.mockRejectedValueOnce(new Error('Not JSON-safe.'));
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({ payload: { kind: 'internal' } });
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).resolves.toEqual(roots);
});
it('fails only a request its connection refuses to send', async () => {
  const binding = build();
  const { client } = pairs[pairs.length - 1];
  client.send.mockRejectedValueOnce(
    new CanopyOperationError({
      kind: 'resource_exhausted',
      message: 'Message too large.',
      retry: { kind: 'never' },
    }),
  );
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).resolves.toEqual(roots);
});

it.each([
  new Date(),
  1n,
  (): undefined => undefined,
  undefined,
  { ...params, injected: (): undefined => undefined },
])('rejects non-contract parameters before serialization', async (invalid) => {
  await expect(
    build().query('worker.filesystem.roots.list', invalid),
  ).rejects.toMatchObject(error);
});
it('preserves grants and declared errors and strips private causes', async () => {
  await expect(
    build([]).query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  const binding = build(caller.grants, () => {
    throw new CanopyOperationError(
      { kind: 'not_found', message: 'Missing', retry: { kind: 'never' } },
      new Error('private'),
    );
  });
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({
    payload: { kind: 'not_found' },
    runtimeCause: undefined,
  });
});
it('preserves deadline and cancellation admission', async () => {
  const handler = jest.fn(() => roots);
  const binding = build(caller.grants, handler);
  await expect(
    binding.query('worker.filesystem.roots.list', params, {
      metadata: { deadlineAt: '2000-01-01T00:00:00Z' },
    }),
  ).rejects.toMatchObject({ payload: { kind: 'deadline_exceeded' } });
  const controller = new AbortController();
  controller.abort();
  await expect(
    binding.query('worker.filesystem.roots.list', params, {
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
  expect(handler).not.toHaveBeenCalled();
});
it('fails closed for names the binding does not declare under that kind', async () => {
  const binding = build();
  for (const name of ['worker.example.write', 'worker.filesystem.roots.list'])
    await expect(binding.instruction(name, params)).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  for (const name of ['worker.example.events', 'worker.filesystem.roots.list'])
    await expect(binding.openStream(name, params)).rejects.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  expect(pairs[pairs.length - 1].client.send).not.toHaveBeenCalled();
});

it('correlates concurrent responses delivered in reverse order', async () => {
  const releases = new Map<string, () => void>();
  const binding = build(
    caller.grants,
    (request) =>
      new Promise((resolve) => {
        const id = request.scope.workspaceId ?? 'none';
        releases.set(id, () =>
          resolve({ roots: [{ fileRootId: id, name: id, kind: 'git-repo' }] }),
        );
      }),
  );
  const first = binding.query('worker.filesystem.roots.list', {
    scope: { workspaceId: 'first' },
  });
  const second = binding.query('worker.filesystem.roots.list', {
    scope: { workspaceId: 'second' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(releases.size).toBe(2);
  releases.get('second')?.();
  expect(await second).toMatchObject({ roots: [{ fileRootId: 'second' }] });
  releases.get('first')?.();
  expect(await first).toMatchObject({ roots: [{ fileRootId: 'first' }] });
});

it('consumes a cancelled query late reply without closing its siblings', async () => {
  let release = (): void => undefined;
  const binding = build(caller.grants, (request) =>
    request.scope.workspaceId === 'slow'
      ? new Promise((resolve) => {
          release = (): void => resolve(roots);
        })
      : roots,
  );
  const controller = new AbortController();
  const slow = binding.query(
    'worker.filesystem.roots.list',
    { scope: { workspaceId: 'slow' } },
    { signal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await expect(slow).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
  release();
  expect(await binding.query('worker.filesystem.roots.list', params)).toEqual(
    roots,
  );
});

it('bounds unreplied requests and rejects them all when the binding closes', async () => {
  const binding = build(caller.grants, () => new Promise(() => undefined));
  const requests = Array.from({ length: 128 }, () =>
    binding
      .query('worker.filesystem.roots.list', params)
      .catch((error: unknown) => error),
  );
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
  binding.close();
  for (const result of await Promise.all(requests))
    expect(result).toMatchObject({ payload: { kind: 'unavailable' } });
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
});

it('uses the normalized response value at the binding boundary', async () => {
  const binding = build();
  const pair = pairs[pairs.length - 1];
  const send = pair.server.send.getMockImplementation();
  pair.server.send.mockImplementation(async (message) => {
    if (!send) throw new Error('Missing serializing sender');
    await send({
      ...message,
      result: {
        roots: [
          {
            fileRootId: 'root',
            name: 'repo',
            kind: 'git-repo',
            hostPath: '/private/repo',
            absolutePath: '/private/repo',
          },
        ],
      },
    });
  });
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).resolves.toEqual({
    roots: [{ fileRootId: 'root', name: 'repo', kind: 'git-repo' }],
  });
});

it('admits a replacement after a reply arrives while its send is backpressured', async () => {
  const releases: Array<() => void> = [];
  const binding = build(caller.grants, (request) =>
    request.scope.workspaceId === 'replacement'
      ? roots
      : new Promise((resolve) => {
          releases.push(() => resolve(roots));
        }),
  );
  const pair = pairs[pairs.length - 1];
  const send = pair.server.send.getMockImplementation();
  let releaseSend = (): void => undefined;
  const blockedSend = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  pair.server.send.mockImplementation(async (message) => {
    if (!send) throw new Error('Missing serializing sender');
    await send(message);
    if ('id' in message && message.id === 'worker-request-1') await blockedSend;
  });
  const requests = Array.from({ length: 128 }, () =>
    binding
      .query('worker.filesystem.roots.list', params)
      .catch((error: unknown) => error),
  );
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(releases).toHaveLength(128);
    releases[0]();
    expect(await requests[0]).toEqual(roots);
    await expect(
      binding.query('worker.filesystem.roots.list', {
        scope: { workspaceId: 'replacement' },
      }),
    ).resolves.toEqual(roots);
    releases[1]();
    expect(await requests[1]).toEqual(roots);
  } finally {
    releaseSend();
    for (const release of releases) release();
    binding.close();
    await Promise.all(requests);
  }
});

it('validates response envelopes and never exports handler exception causes', async () => {
  const binding = build(caller.grants, () => {
    throw new Error('private exception');
  });
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({
    payload: { kind: 'internal', message: 'The operation failed.' },
    runtimeCause: undefined,
  });
  const pair = pairs[pairs.length - 1];
  const send = pair.server.send.getMockImplementation();
  pair.server.send.mockImplementation(async (message) => {
    if (!send) throw new Error('Missing serializing sender');
    await send(
      'error' in message
        ? {
            jsonrpc: '2.0',
            id: message.id ?? 'missing',
            result: { roots: 'malformed' },
          }
        : message,
    );
  });
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({
    payload: {
      kind: 'internal',
      message: 'The operation returned an invalid result.',
    },
  });
});

it.each(['client', 'server'])(
  'bounds delivered but undrained %s sends',
  async (side) => {
    const binding = build();
    const pair = pairs[pairs.length - 1];
    const connection = side === 'client' ? pair.client : pair.server;
    const send = connection.send.getMockImplementation();
    const releases: Array<() => void> = [];
    let undrained = 0;
    connection.signal.addEventListener(
      'abort',
      () => {
        for (const release of releases) release();
      },
      { once: true },
    );
    connection.send.mockImplementation(async (message) => {
      if (!send) throw new Error('Missing serializing sender');
      await send(message);
      undrained += 1;
      try {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      } finally {
        undrained -= 1;
      }
    });
    try {
      for (let index = 0; index < 128; index += 1)
        expect(
          await binding.query('worker.filesystem.roots.list', params),
        ).toEqual(roots);
      await new Promise((resolve) => setImmediate(resolve));
      expect(undrained).toBe(128);
      let completed = false;
      const replacement = binding
        .query('worker.filesystem.roots.list', params)
        .then((value) => {
          completed = true;
          return value;
        })
        .catch((error: unknown) => error);
      await new Promise((resolve) => setImmediate(resolve));
      expect(connection.send).toHaveBeenCalledTimes(128);
      if (side === 'client') {
        expect(await replacement).toMatchObject({
          payload: { kind: 'resource_exhausted' },
        });
        releases[0]();
        await new Promise((resolve) => setImmediate(resolve));
        expect(
          await binding.query('worker.filesystem.roots.list', params),
        ).toEqual(roots);
      } else {
        expect(completed).toBe(false);
        releases[0]();
        expect(await replacement).toEqual(roots);
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(undrained).toBe(128);
      const queued =
        side === 'server'
          ? Array.from({ length: 128 }, () =>
              binding
                .query('worker.filesystem.roots.list', params)
                .catch((error: unknown) => error),
            )
          : [];
      await new Promise((resolve) => setImmediate(resolve));
      expect(connection.send).toHaveBeenCalledTimes(129);
      await expect(
        binding.query('worker.filesystem.roots.list', params),
      ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
      binding.close();
      for (const value of await Promise.all(queued))
        expect(value).toMatchObject({ payload: { kind: 'unavailable' } });
      await new Promise((resolve) => setImmediate(resolve));
      expect(undrained).toBe(0);
    } finally {
      binding.close();
      for (const release of releases) release();
    }
  },
);

it('fails the query and binding when a client send rejects', async () => {
  const binding = build();
  pairs[pairs.length - 1].client.send.mockRejectedValue(
    new Error('Transport failed'),
  );
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
  await expect(
    binding.query('worker.filesystem.roots.list', params),
  ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
});

it.each([
  new Date(),
  1n,
  undefined,
  (): undefined => undefined,
  { fn: (): undefined => undefined },
])(
  'the host adapter rejects non-serializable envelope bodies',
  async (result) => {
    const pair = serializingWorkerPair();
    pairs.push(pair);
    await expect(
      pair.server.send({ jsonrpc: '2.0', id: 'unsafe', result }),
    ).rejects.toThrow();
  },
);

/**
 * A core-end connection the test answers by hand: nothing runs a handler, so
 * only what the worker says (or its exit) can settle a call (CAN-4730 E2-G).
 */
function handAnsweredConnection(): {
  connection: Parameters<typeof connectLocalWorkerBinding>[0]['connection'];
  sent: CanopyJsonRpcMessage[];
  deliver(message: CanopyJsonRpcMessage): void;
} {
  const sent: CanopyJsonRpcMessage[] = [];
  const inbox: CanopyJsonRpcMessage[] = [];
  const waiting: Array<{
    resolve(message: CanopyJsonRpcMessage): void;
    reject(error: Error): void;
  }> = [];
  const lifetime = new AbortController();
  lifetime.signal.addEventListener('abort', () => {
    for (const waiter of waiting.splice(0))
      waiter.reject(new Error('The connection closed.'));
  });
  return {
    sent,
    deliver: (message): void => {
      const waiter = waiting.shift();
      if (waiter) waiter.resolve(message);
      else inbox.push(message);
    },
    connection: {
      signal: lifetime.signal,
      send: (message): Promise<void> => {
        sent.push(message);
        return Promise.resolve();
      },
      receive: (): Promise<CanopyJsonRpcMessage> => {
        const next = inbox.shift();
        if (next) return Promise.resolve(next);
        return new Promise((resolve, reject) => {
          waiting.push({ resolve, reject });
        });
      },
      close: (): void => lifetime.abort(),
    },
  };
}

describe('settling a keyed instruction whose binding stops (CAN-4730 E2-G)', () => {
  const writer: CanopyCallerDescriptor = {
    ...caller,
    grants: ['worker.filesystem.write'],
  };
  const definitions = {
    queries: {},
    instructions: WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    streams: {},
  };
  const remove = {
    scope: params.scope,
    fileRootId: 'root',
    relativePath: 'a.txt',
    expectedVersion: null,
    recursive: false,
    disposition: 'permanent',
    _meta: { idempotencyKey: 'delete-1' },
  };
  const turns = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };

  /** Sends a keyed delete; `settled` flips once the binding counts it settled. */
  function sendDelete(workerExited?: Promise<unknown>): {
    hand: ReturnType<typeof handAnsweredConnection>;
    client: ReturnType<typeof connectLocalWorkerBinding>;
    state: { settled: boolean };
  } {
    const hand = handAnsweredConnection();
    const client = connectLocalWorkerBinding({
      definitions,
      caller: writer,
      connection: hand.connection,
      ...(workerExited && { workerExited }),
    });
    const state = { settled: false };
    void client.forwarders.instructions['worker.filesystem.entry.delete'](
      remove,
      {
        metadata: { idempotencyKey: 'delete-1' },
        signal: new AbortController().signal,
        workerSettlement: (settled) => {
          void settled.then(() => {
            state.settled = true;
          });
        },
      },
    ).catch(() => undefined);
    return { hand, client, state };
  }

  it('counts nothing settled when the binding stops without an exit to wait for', async () => {
    const { client, state, hand } = sendDelete();
    await turns();
    expect(hand.sent).toMatchObject([
      { method: 'worker.filesystem.entry.delete' },
    ]);
    client.close();
    await turns();
    expect(state.settled).toBe(false);
  });

  it("counts a stopped binding's instruction settled only once the worker has exited", async () => {
    let exit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      exit = resolve;
    });
    const { client, state, hand } = sendDelete(exited);
    await turns();
    expect(hand.sent).toMatchObject([
      { method: 'worker.filesystem.entry.delete' },
    ]);
    client.close();
    await turns();
    expect(state.settled).toBe(false);
    exit();
    await turns();
    expect(state.settled).toBe(true);
  });
  it.each([
    ['killed by a signal', { kind: 'crashed', code: null, signal: 'SIGKILL' }],
    ['exiting non-zero', { kind: 'exited', code: 1, signal: null }],
  ])(
    "counts a stopped binding's instruction settled once the worker crashes mid-handler, %s",
    async (_how, outcome) => {
      let exit: (value: unknown) => void = () => undefined;
      const exited = new Promise<unknown>((resolve) => {
        exit = resolve;
      });
      const { client, state, hand } = sendDelete(exited);
      await turns();
      expect(hand.sent).toMatchObject([
        { method: 'worker.filesystem.entry.delete' },
      ]);
      client.close();
      await turns();
      expect(state.settled).toBe(false);
      // The process outcome never rejects: a crash resolves it too.
      exit({ ...outcome, output: 'complete' });
      await turns();
      expect(state.settled).toBe(true);
    },
  );
});
