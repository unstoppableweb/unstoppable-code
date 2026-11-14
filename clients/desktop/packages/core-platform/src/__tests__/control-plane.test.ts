import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCanopyClient } from '@canopy/core-client/node';
import {
  createCanopyClientLease,
  type CanopyClient,
} from '@canopy/core-client';
import {
  createCanopyFramedConnection,
  encodeCanopyJsonFrame,
  runCanopyChannelConformance,
  runCanopyLeaseConformance,
  runCanopyTransportConformance,
  type CanopyChannelConformanceTarget,
  type CanopyConformancePairOptions,
  type CanopyFramedPair,
  type CanopyLeaseConformanceTarget,
} from '@canopy/core-transport';
import type {
  CanopyByteChannel,
  CanopyFramedConnection,
} from '@canopy/core-transport/types';
import {
  CANOPY_RUNTIME_QUERY_DEFINITIONS,
  CanopyOperationError,
  createCanopyDispatcher,
  createCanopyRuntime,
  type CanopyHandlerContext,
  type CanopyDispatcher,
  type CanopyRuntime,
  type CanopyRuntimeQueries,
  type CanopyRuntimeStreams,
  type PlatformEndpointListener,
  type PlatformUnixSocketAddress,
} from '@canopy/core-runtime';
import {
  acceptCanopyFramedConnections,
  serveCanopyControlStream,
  serveCanopyDaemonControlPlane,
  type CanopyControlStreamOptions,
  type CanopyControlStreamSession,
  type CanopyDaemonClock,
  type CanopyDaemonControlPlaneOptions,
} from '@canopy/core-runtime/node';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CORE_VAULT_INSTRUCTION_DEFINITIONS,
  CORE_VAULT_QUERY_DEFINITIONS,
  WORKER_QUERY_DEFINITIONS,
  CanopyErrorPayloadSchema,
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  CoreClientLeaseSchema,
  CoreEventsSubscribeOpenResultSchema,
  type CanopyOperationName,
  composeCanopyOperationEnvelopes,
  decodeCanopyError,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
  vaultError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyJsonRpcId,
  type CanopyJsonRpcMessage,
  type CoreClientLease,
  type CoreClientCapabilitiesRegisterResult,
} from '@canopy/protocol/canopy-core';
import { createPlatformEndpointServices } from '@canopy/core-platform';
import { z } from 'zod';
import {
  FixtureCleanup,
  requireCompletedPhases,
  type FixtureRelease,
} from './fixtures/pipe-test-cleanup';
import { manualClock, echo, HOLD } from './fixtures/control-plane-conformance';

function isWorkerOperationName(
  name: string,
): name is `worker.${string}.${string}` {
  return /^worker\.[^.]+\..+$/.test(name);
}

const posix = process.platform === 'win32' ? describe.skip : describe;
const AUTH = { secret: 'socket-secret', dataRootHash: '0'.repeat(64) };
const GRACE_MS = 30_000;

let directory = '';
let sockets = 0;
let cleanup: FixtureCleanup;
let files: FixtureRelease;
beforeEach(async () => {
  cleanup = new FixtureCleanup();
  const acquired = await cleanup.acquire(
    () => mkdtemp(join(tmpdir(), 'c6-')),
    (directory) => rm(directory, { recursive: true, force: true }),
  );
  files = acquired.release;
  directory = await realpath(acquired.value);
});
afterEach(async () => {
  const failures = await cleanup.close();
  if (failures) throw new Error(`Fixture teardown incomplete (${failures})`);
}, 20_000);

async function bindListener(scope: FixtureCleanup): Promise<{
  listener: PlatformEndpointListener<PlatformUnixSocketAddress>;
  release: FixtureRelease;
}> {
  const endpoints = createPlatformEndpointServices(
    process.platform === 'darwin' ? 'darwin' : 'linux',
  );
  if (endpoints.semantics !== 'filesystem-socket')
    throw new Error('Unix sockets required.');
  const path = join(directory, `${(sockets += 1)}.sock`);
  const { value: listener, release } = await scope.acquire(
    async () => {
      const bound = await endpoints.bind({ kind: 'unix-socket', path });
      if (bound.kind !== 'bound') throw new Error('Socket in use.');
      return bound.listener;
    },
    (listener) => listener.close(),
  );
  return { listener: { ...listener, close: () => release.release() }, release };
}

async function connect(
  path: string,
  options: CanopyConformancePairOptions = {},
  scope = cleanup.fork([files]),
): Promise<{
  client: CanopyFramedConnection;
  clientWire: ReturnType<typeof createConnection>;
}> {
  return scope.initialize(async () => {
    const clientWire = createConnection(path);
    const closed = new Promise<void>((resolve) =>
      clientWire.once('close', () => resolve()),
    );
    scope.own(async () => {
      clientWire.destroy();
      await closed;
    });
    const client = await createCanopyFramedConnection(clientWire, {
      role: 'client',
      auth: {
        secret: options.clientSecret ?? AUTH.secret,
        dataRootHash: options.clientDataRootHash ?? AUTH.dataRootHash,
      },
      maxFrameBytes: options.maxFrameBytes,
      maxBufferedMessages: options.maxBufferedMessages,
      handshakeTimeoutMs: 2_000,
    });
    return { client, clientWire };
  });
}

/** A real Unix socket per pair; its listener closes once both ends have. */
async function socketPair(
  options: CanopyConformancePairOptions = {},
): Promise<CanopyFramedPair> {
  const scope = cleanup.fork([files]);
  return scope.initialize(async () => {
    const { listener } = await bindListener(scope);
    const server = new Promise<CanopyFramedConnection>((resolve) => {
      acceptCanopyFramedConnections({
        listener,
        auth: AUTH,
        connection: {
          maxFrameBytes: options.maxFrameBytes,
          maxBufferedMessages: options.maxBufferedMessages,
          handshakeTimeoutMs: 2_000,
        },
        onConnection: resolve,
      });
    });
    const { client, clientWire } = await connect(
      listener.address.path,
      options,
      scope.fork(),
    );
    const pair = { client, server: await server, clientWire };
    const closeWhenDone = (): void => {
      if (client.signal.aborted && pair.server.signal.aborted)
        void listener.close().catch(() => undefined);
    };
    client.signal.addEventListener('abort', closeWhenDone);
    pair.server.signal.addEventListener('abort', closeWhenDone);
    return pair;
  });
}

const INSTRUCTIONS = defineCanopyInstructionRegistry('core', {
  'core.events.ack': CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.ack'],
  'core.example.write': defineCanopyInstruction({
    plane: 'core',
    domain: 'example',
    version: 1,
    placement: 'core-only',
    idempotency: 'keyed',
    requiredGrants: [],
    params: CanopyStreamCursorSchema,
    result: CanopyStreamCursorSchema,
    error: CanopyErrorPayloadSchema,
  }),
});

type Kernel = CanopyRuntime<
  CanopyDispatcher<
    CanopyRuntimeQueries,
    typeof INSTRUCTIONS,
    CanopyRuntimeStreams
  >
>;

async function startedKernel(scope = cleanup.fork([files])): Promise<{
  runtime: Kernel;
  shutdown: FixtureRelease;
}> {
  const runtime = createCanopyRuntime({
    profile: 'core',
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    definitions: { queries: {}, instructions: INSTRUCTIONS, streams: {} },
    owners: [
      { name: 'core.example', operations: ['core.example.write'] },
      { name: 'core.events', operations: ['core.events.ack'] },
    ],
    services: [],
    principalFor: () => 'interface',
    phaseDeadlineMs: 1_000,
    createDispatcher: (input) =>
      createCanopyDispatcher({
        profile: input.profile,
        definitions: input.definitions,
        handlers: {
          ...input.runtimeHandlers,
          instructions: {
            'core.example.write': (params) => params,
            'core.events.ack': ({ cursor }) => ({ acknowledgedCursor: cursor }),
          },
        },
      }),
  });
  const started = runtime.start();
  const shutdown = scope.own(async () => {
    await started.catch(() => undefined);
    await requireCompletedPhases(runtime.shutdown('test'));
  });
  return scope.initialize(async () => {
    await started;
    return { runtime, shutdown };
  });
}

async function controlPlane(
  overrides: Partial<CanopyDaemonControlPlaneOptions> = {},
): Promise<{
  path: string;
  clock: ReturnType<typeof manualClock>;
  runtime: Kernel;
  plane: ReturnType<typeof serveCanopyDaemonControlPlane>;
  close(): Promise<void>;
}> {
  const scope = cleanup.fork([files]);
  return scope.initialize(async () => {
    const { listener, release: listenerRelease } = await bindListener(scope);
    const { runtime, shutdown } = await startedKernel(scope);
    const clock = manualClock();
    const plane = serveCanopyDaemonControlPlane({
      binding: { listener, auth: AUTH },
      dispatcher: runtime.dispatcher,
      operations: runtime.operations,
      callerFor: ({ connectionId, lease }) => ({
        principalId: 'local-user',
        clientInstanceId: lease?.clientInstanceId ?? connectionId,
        authorityId: 'local',
        interfaceKind: lease?.interfaceKind ?? 'test',
        grants: ['core.runtime.read', 'core.client.manage', 'core.events.read'],
      }),
      buildVersion: '0.0.0-test',
      idleGrace: { graceMs: GRACE_MS },
      onIdle: () => undefined,
      clock,
      ...overrides,
    });
    const planeRelease = scope.own(() => plane.close());
    listenerRelease.dependsOn(planeRelease);
    shutdown.dependsOn(listenerRelease);
    return {
      path: listener.address.path,
      clock,
      runtime,
      plane: { ...plane, close: () => planeRelease.release() },
      close: async (): Promise<void> => {
        const failures = await scope.close();
        if (failures)
          throw new Error(`Fixture teardown incomplete (${failures})`);
      },
    };
  });
}

const ACQUIRE = {
  clientInstanceId: 'client',
  interfaceKind: 'cli',
  label: 'CLI',
  interactive: false,
  foreground: true,
  renewalIntervalMs: 15_000,
} as const;

posix('lease-owned registrations', () => {
  const declaration = {
    capabilities: [
      {
        name: 'core.test.presentation',
        version: 1,
        inputSchema: {},
        outputSchema: {},
      },
    ],
    _meta: { idempotencyKey: 'declaration' },
  };
  const clients = new Set<{ close(): Promise<void> }>();
  afterEach(async () => {
    await Promise.all(Array.from(clients, (client) => client.close()));
    clients.clear();
  });
  type Client = CanopyClient<
    typeof CANOPY_RUNTIME_QUERY_DEFINITIONS,
    typeof CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    typeof CORE_TRANSPORT_STREAM_DEFINITIONS
  >;
  async function attached(path: string): Promise<Client> {
    const client = await connectCanopyClient({
      endpoint: { kind: 'socket', path, auth: AUTH },
      clientName: 'lifecycle',
      clientVersion: '0',
      definitions: {
        queries: CANOPY_RUNTIME_QUERY_DEFINITIONS,
        instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
        streams: CORE_TRANSPORT_STREAM_DEFINITIONS,
      },
    });
    clients.add(client);
    return client;
  }
  const release = (client: Client): ReturnType<Client['instruction']> =>
    client.instruction('core.client.lease.release', {
      reason: 'normal_shutdown',
    });

  const acquire = (
    client: Client,
    key: string,
    previousLeaseId?: string,
    clientInstanceId: string = ACQUIRE.clientInstanceId,
  ): Promise<CoreClientLease> =>
    client.instruction('core.client.lease.acquire', {
      ...ACQUIRE,
      clientInstanceId,
      previousLeaseId,
      _meta: { idempotencyKey: key },
    });
  const declare = (
    client: Client,
  ): Promise<CoreClientCapabilitiesRegisterResult> =>
    client.instruction('core.client.capabilities.register', declaration);
  function gate(): { promise: Promise<void>; open(): void } {
    let open = (): void => {};
    const promise = new Promise<void>((done) => (open = done));
    return { promise, open };
  }
  it('delivers typed TTL eviction only to its owner and replays a real declaration', async () => {
    const daemon = await controlPlane();
    const client = await attached(daemon.path);
    const foreign = await attached(daemon.path);
    const otherEvents = jest.fn();
    foreign.onLeaseEvicted(otherEvents);
    const events = jest.fn();
    client.onLeaseEvicted(events);
    const issued: string[] = [];
    const registered = gate();
    const replayed = gate();
    const owner = createCanopyClientLease({
      client,
      attach: () => attached(daemon.path),
      identity: {
        clientInstanceId: 'owner',
        interfaceKind: 'cli',
        label: 'owner',
      },
      renewalIntervalMs: 15_000,
      presence: () => ({ interactive: false, foreground: false }),
    });
    owner.register('presentation', async (lease, connected) => {
      await declare(connected);
      issued.push(lease.leaseId);
      if (issued.length === 1) registered.open();
      else replayed.open();
    });
    try {
      await owner.acquire();
      await registered.promise;
      await acquire(foreign, 'foreign', undefined, 'foreign');
      await daemon.clock.advance(59_999);
      await foreign.instruction('core.client.lease.renew', {
        expectedRevision: 0,
        interactive: false,
        foreground: true,
      });
      await daemon.clock.advance(1);
      await replayed.promise;
      expect(issued[1]).not.toBe(issued[0]);
      expect(events).toHaveBeenCalledWith({
        leaseId: issued[0],
        reason: 'expired',
        releasedRegistrationCount: 1,
      });
      expect(otherEvents).not.toHaveBeenCalled();
      await release(foreign);
      const moved = await attached(daemon.path);
      const ended = gate();
      moved.onLeaseEvicted((event) => {
        otherEvents(event);
        ended.open();
      });
      await acquire(moved, 'move', issued[1], 'owner');
      await daemon.clock.advance(60_000);
      await ended.promise;
      await client.query('core.runtime.health.get', {});
      expect(events).toHaveBeenCalledTimes(1);
      expect(otherEvents).toHaveBeenCalledWith({
        leaseId: issued[1],
        reason: 'expired',
        releasedRegistrationCount: 1,
      });
    } finally {
      await owner.release('normal_shutdown');
      await daemon.close();
    }
  });

  it('fences late async stream registration and reports the failed request on release', async () => {
    const { runtime, shutdown } = await startedKernel();
    const entered = gate();
    const completion = gate();
    const closed = jest.fn();
    const daemon = await controlPlane({
      dispatcher: {
        ...runtime.dispatcher,
        openStream: async (
          _method,
          _body,
          options,
        ): ReturnType<CanopyDispatcher['openStream']> => {
          const handle = await runtime.dispatcher.openStream(
            'core.runtime.events',
            {},
            options,
          );
          entered.open();
          await completion.promise;
          return {
            ...handle,
            close: (): void => {
              closed();
              handle.close();
              throw new Error('disposer failed after cleanup');
            },
          };
        },
      },
    });
    const client = await attached(daemon.path);
    try {
      await acquire(client, 'late');
      const opening = client.openStream('core.runtime.events', {});
      const rejected = expect(opening).rejects.toMatchObject({
        payload: { kind: 'not_found' },
      });
      await entered.promise;
      const result = await release(client);
      expect(result.releasedRegistrationCount).toBe(1);
      expect(result.failedRequestIds).toHaveLength(1);
      completion.open();
      await rejected;
      expect(closed).toHaveBeenCalledTimes(1);
      await expect(release(client)).resolves.toMatchObject({
        releasedRegistrationCount: 0,
        failedRequestIds: [],
      });
    } finally {
      completion.open();
      await daemon.close();
      await shutdown.release();
    }
  });
  it('retains actual declarations through grace, isolates owners, and reports cleanup', async () => {
    const daemon = await controlPlane();
    try {
      const first = await attached(daemon.path);
      const held = await acquire(first, 'first');
      const registered = await declare(first);
      const replacement = {
        capabilities: [
          ...declaration.capabilities,
          { ...declaration.capabilities[0], name: 'core.test.second' },
        ],
        _meta: { idempotencyKey: 'replacement' },
      };
      await expect(
        first.instruction('core.client.capabilities.register', replacement),
      ).resolves.toMatchObject({ registrationRevision: 2 });
      expect(first.manifest.has('operations', 'core.test.presentation')).toBe(
        false,
      );
      expect(first.manifest.has('streams', 'core.events.subscribe')).toBe(
        false,
      );
      const foreign = await attached(daemon.path);
      await acquire(foreign, 'foreign', undefined, 'foreign');
      await expect(release(foreign)).resolves.toMatchObject({
        releasedRegistrationCount: 0,
      });
      await first.close();
      await whenDetached(daemon.plane, held.leaseId);
      await daemon.clock.advance(9_999);
      const rebound = await attached(daemon.path);
      await acquire(rebound, 'reconnect', held.leaseId);
      await expect(declare(rebound)).resolves.toEqual(registered);
      await expect(release(rebound)).resolves.toMatchObject({
        released: true,
        releasedRegistrationCount: 2,
        failedRequestIds: [],
      });
      await expect(release(rebound)).resolves.toMatchObject({
        released: false,
        releasedRegistrationCount: 0,
      });
      await expect(declare(rebound)).rejects.toMatchObject({
        payload: { kind: 'not_found' },
      });
    } finally {
      await daemon.close();
    }
  });

  it('counts runtime subscription declarations retained after transport loss', async () => {
    const daemon = await controlPlane();
    try {
      const first = await attached(daemon.path);
      const held = await acquire(first, 'stream');
      await first.openStream('core.runtime.events', {});
      await first.openStream('core.runtime.events', {});
      await first.close();
      await whenDetached(daemon.plane, held.leaseId);
      const second = await attached(daemon.path);
      await acquire(second, 'stream-rebind', held.leaseId);
      await second.openStream('core.runtime.events', {});
      await expect(release(second)).resolves.toMatchObject({
        releasedRegistrationCount: 2,
      });
    } finally {
      await daemon.close();
    }
  });
});

const initialize = (
  id: number,
  protocolVersions: number[] = [1],
  metadata?: Record<string, unknown>,
): Parameters<CanopyFramedConnection['send']>[0] => ({
  jsonrpc: '2.0',
  id,
  method: 'core.runtime.initialize',
  params: {
    client: { name: 'test', version: '0', protocolVersions, capabilities: [] },
    ...(metadata ? { _meta: metadata } : {}),
  },
});

async function call(
  client: CanopyFramedConnection,
  message: Parameters<CanopyFramedConnection['send']>[0],
): Promise<{ result?: unknown; error?: unknown }> {
  await client.send(message);
  const response = await client.receive();
  if (!('id' in response) || 'method' in response)
    throw new Error('Expected a response.');
  return response;
}

runCanopyTransportConformance({
  name: 'unix-socket',
  createPair: socketPair,
  describe: posix,
  it,
  todo: it.todo,
});

function whenDetached(
  plane: ReturnType<typeof serveCanopyDaemonControlPlane>,
  leaseId: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const check = (): void => {
      if (plane.leases.holder(leaseId) !== null) return;
      off();
      resolve();
    };
    const off = plane.leases.onChange(check);
    check();
  });
}

const LEASE_TARGET: CanopyLeaseConformanceTarget = {
  name: 'control plane',
  start: async () => {
    const daemon = await controlPlane();
    const clients: CanopyFramedConnection[] = [];
    return {
      connect: async (): Promise<CanopyFramedConnection> => {
        const { client } = await connect(daemon.path);
        clients.push(client);
        return client;
      },
      now: (): number => daemon.clock.now(),
      advance: (ms): Promise<void> => daemon.clock.advance(ms),
      whenDetached: (leaseId) => whenDetached(daemon.plane, leaseId),
      reconnectGraceMs: 10_000,
      close: async (): Promise<void> => {
        clients.forEach((client) => client.close());
        await daemon.close();
      },
    };
  },
};

runCanopyLeaseConformance({
  name: 'unix-socket',
  target: LEASE_TARGET,
  describe: posix,
  it,
});

const CHANNEL_TARGET: CanopyChannelConformanceTarget = {
  name: 'control plane',
  echoKind: 'conformance.echo',
  holdKind: 'conformance.hold',
  start: async () => {
    const daemon = await controlPlane({
      channels: {
        kinds: {
          'conformance.echo': { accept: (channel) => void echo(channel) },
          'conformance.hold': HOLD,
        },
      },
      connection: { maxChannelBufferedChunks: 4 },
    });
    const clients: CanopyFramedConnection[] = [];
    return {
      connect: async (): Promise<
        Pick<CanopyFramedPair, 'client' | 'clientWire'>
      > => {
        const opened = await connect(daemon.path);
        clients.push(opened.client);
        return opened;
      },
      now: (): number => daemon.clock.now(),
      advance: (ms): Promise<void> => daemon.clock.advance(ms),
      whenDetached: (leaseId) => whenDetached(daemon.plane, leaseId),
      reconnectGraceMs: 10_000,
      close: async (): Promise<void> => {
        clients.forEach((client) => client.close());
        await daemon.close();
      },
    };
  },
};

runCanopyChannelConformance({
  name: 'unix-socket',
  target: CHANNEL_TARGET,
  describe: posix,
  it,
});

/** A connected, initialized client holding a lease. */
async function leased(path: string): Promise<{
  client: CanopyFramedConnection;
  leaseId: string;
  initialized: unknown;
}> {
  const { client } = await connect(path);
  const { result: initialized } = await call(client, initialize(1));
  const { result } = await call(client, {
    jsonrpc: '2.0',
    id: 2,
    method: 'core.client.lease.acquire',
    params: { ...ACQUIRE, _meta: { idempotencyKey: 'channels' } },
  });
  if (
    typeof result !== 'object' ||
    result === null ||
    !('leaseId' in result) ||
    typeof result.leaseId !== 'string'
  )
    throw new Error('Expected a lease.');
  return { client, leaseId: result.leaseId, initialized };
}

const CAPS = { maxChunkBytes: 1_024, maxBufferedChunks: 4 };

function closedWith({
  signal,
}: Pick<CanopyByteChannel, 'signal'>): Promise<unknown> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(signal.reason);
    signal.addEventListener('abort', () => resolve(signal.reason), {
      once: true,
    });
  });
}

posix('daemon control plane over a Unix socket', () => {
  it('fails a protocol-major mismatch closed with the actionable error', async () => {
    const daemon = await controlPlane();
    try {
      const { client } = await connect(daemon.path);
      const error = decodeCanopyError(
        (await call(client, initialize(1, [99]))).error,
      );
      expect(error).toMatchObject({
        kind: 'failed_precondition',
        code: 'core.runtime.invalidState',
        details: {
          supportedProtocolVersions: [1],
          action: 'restart_or_update',
        },
      });
      await expect(client.receive()).rejects.toMatchObject({
        payload: { kind: 'failed_precondition' },
      });
      expect(client.signal.aborted).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('fails a foreign data root and a wrong token closed', async () => {
    const daemon = await controlPlane();
    try {
      await expect(
        connect(daemon.path, { clientDataRootHash: 'f'.repeat(64) }),
      ).rejects.toMatchObject({ payload: { kind: 'failed_precondition' } });
      await expect(
        connect(daemon.path, { clientSecret: 'wrong' }),
      ).rejects.toMatchObject({ payload: { kind: 'unauthenticated' } });
      expect(daemon.plane.leases.size).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  it('refuses operations before initialize and serves health after it', async () => {
    const daemon = await controlPlane();
    try {
      const { client } = await connect(daemon.path);
      const health = {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.runtime.health.get',
        params: {},
      } as const;
      expect(decodeCanopyError((await call(client, health)).error).kind).toBe(
        'failed_precondition',
      );
      const { result } = await call(client, initialize(3));
      expect(result).toMatchObject({
        selectedProtocolVersion: 1,
        runtime: { buildVersion: '0.0.0-test', profile: 'core' },
        capabilities: {
          operations: [
            'core.events.ack',
            'core.runtime.health.get',
            'core.runtime.manifest.get',
            'core.client.lease.acquire',
            'core.client.lease.renew',
            'core.client.lease.release',
            'core.client.capabilities.register',
          ],
        },
      });
      expect(
        decodeCanopyError((await call(client, initialize(5))).error).kind,
      ).toBe('failed_precondition');
      expect((await call(client, { ...health, id: 4 })).result).toMatchObject({
        runtime: { runtimeId: 'runtime', state: 'ready' },
      });
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('forwards instructions and streams and rejects unknown methods', async () => {
    const daemon = await controlPlane();
    try {
      const { client } = await connect(daemon.path);
      await call(client, initialize(1));
      const cursor = { daemonEpoch: 'one', sequence: 4 };
      const acked = await call(client, {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.events.ack',
        params: { subscriptionId: 'sub-1', cursor },
      });
      expect(acked.result).toEqual({ acknowledgedCursor: cursor });
      // Registered and granted, but outside the negotiated manifest.
      const unlisted = await call(client, {
        jsonrpc: '2.0',
        id: 5,
        method: 'core.example.write',
        params: { ...cursor, _meta: { idempotencyKey: 'write-1' } },
      });
      expect(decodeCanopyError(unlisted.error).kind).toBe('permission_denied');
      const unknown = await call(client, {
        jsonrpc: '2.0',
        id: 3,
        method: 'core.example.missing',
        params: {},
      });
      expect(unknown.error).toMatchObject({ code: -32601 });

      const envelopes = composeCanopyOperationEnvelopes(
        'core.runtime.events',
        CORE_TRANSPORT_STREAM_DEFINITIONS['core.runtime.events'],
      );
      await call(client, {
        jsonrpc: '2.0',
        id: 10,
        method: 'core.client.lease.acquire',
        params: { ...ACQUIRE, _meta: { idempotencyKey: 'events' } },
      });
      const opened = await call(client, {
        jsonrpc: '2.0',
        id: 4,
        method: 'core.runtime.events',
        params: { cursor: null },
      });
      envelopes.response.parse({ jsonrpc: '2.0', ...opened });
      const stopping = daemon.runtime.shutdown('test');
      const methods: string[] = [];
      for (;;) {
        const frame = await client.receive();
        envelopes.notification?.parse(frame);
        if (!('method' in frame)) throw new Error('Expected a notification.');
        methods.push(frame.method);
        if (frame.method === 'core.runtime.events.end') {
          expect(frame.params).toMatchObject({ outcome: 'completed' });
          break;
        }
      }
      expect(methods).toContain('core.runtime.events.item');
      await stopping;
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('requires the lease grant for lease operations', async () => {
    const daemon = await controlPlane({
      callerFor: ({ connectionId }) => ({
        principalId: 'local-user',
        clientInstanceId: connectionId,
        authorityId: 'local',
        interfaceKind: 'test',
        grants: ['core.runtime.read'],
      }),
    });
    try {
      const { client } = await connect(daemon.path);
      const { result } = await call(client, initialize(1));
      expect(result).toMatchObject({
        capabilities: {
          operations: ['core.runtime.health.get', 'core.runtime.manifest.get'],
        },
      });
      const denied = await call(client, {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.client.lease.release',
        params: { reason: 'normal_shutdown' },
      });
      expect(decodeCanopyError(denied.error).kind).toBe('permission_denied');
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('answers unknown methods before initialize with failed_precondition', async () => {
    const daemon = await controlPlane();
    try {
      const { client } = await connect(daemon.path);
      const early = await call(client, {
        jsonrpc: '2.0',
        id: 1,
        method: 'core.example.missing',
        params: {},
      });
      expect(decodeCanopyError(early.error).kind).toBe('failed_precondition');
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('initializes a zero-grant caller and admits only valid metadata', async () => {
    const daemon = await controlPlane({
      callerFor: ({ connectionId }) => ({
        principalId: 'local-user',
        clientInstanceId: connectionId,
        authorityId: 'local',
        interfaceKind: 'test',
        grants: [],
      }),
    });
    try {
      const { client } = await connect(daemon.path);
      const keyed = await call(
        client,
        initialize(1, [1], { idempotencyKey: 'nope' }),
      );
      expect(decodeCanopyError(keyed.error).kind).toBe('invalid_argument');
      const { client: second } = await connect(daemon.path);
      const { result } = await call(second, initialize(1, [1], {}));
      expect(result).toMatchObject({
        capabilities: { operations: [], streams: [] },
      });
      const health = await call(second, {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.runtime.health.get',
        params: {},
      });
      expect(decodeCanopyError(health.error).kind).toBe('permission_denied');
      second.close();
    } finally {
      await daemon.close();
    }
  });

  it('enforces metadata rules on lease operations', async () => {
    const daemon = await controlPlane();
    try {
      const { client } = await connect(daemon.path);
      await call(client, initialize(1));
      const expired = await call(client, {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.client.lease.acquire',
        params: {
          ...ACQUIRE,
          _meta: {
            idempotencyKey: 'late',
            deadlineAt: '2000-01-01T00:00:00Z',
          },
        },
      });
      expect(decodeCanopyError(expired.error).kind).toBe('deadline_exceeded');
      expect(daemon.plane.leases.size).toBe(0);
      const keyedRelease = await call(client, {
        jsonrpc: '2.0',
        id: 3,
        method: 'core.client.lease.release',
        params: {
          reason: 'normal_shutdown',
          _meta: { idempotencyKey: 'nope' },
        },
      });
      expect(decodeCanopyError(keyedRelease.error).kind).toBe(
        'invalid_argument',
      );
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('starts the reconnect grace for an acquire buffered before a close', async () => {
    const daemon = await controlPlane();
    try {
      const { client, clientWire } = await connect(daemon.path);
      await call(client, initialize(1));
      clientWire.write(
        Buffer.concat([
          encodeCanopyJsonFrame({
            jsonrpc: '2.0',
            id: 2,
            method: 'core.client.lease.acquire',
            params: { ...ACQUIRE, _meta: { idempotencyKey: 'buffered' } },
          }),
          encodeCanopyJsonFrame({ type: 'connection.close', error: null }),
        ]),
      );
      await new Promise((resolve) =>
        client.signal.addEventListener('abort', resolve, { once: true }),
      );
      await daemon.clock.advance(0);
      expect(daemon.plane.leases.size).toBe(1);
      await daemon.clock.advance(10_000);
      expect(daemon.plane.leases.size).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  it('applies a release sent together with the connection close', async () => {
    const daemon = await controlPlane();
    try {
      const ends: string[] = [];
      daemon.plane.leases.onEnd((_lease, end) => ends.push(end));
      const { client, clientWire } = await connect(daemon.path);
      await call(client, initialize(1));
      await call(client, {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.client.lease.acquire',
        params: { ...ACQUIRE, _meta: { idempotencyKey: 'release-close' } },
      });
      clientWire.write(
        Buffer.concat([
          encodeCanopyJsonFrame({
            jsonrpc: '2.0',
            id: 3,
            method: 'core.client.lease.release',
            params: { reason: 'normal_shutdown' },
          }),
          encodeCanopyJsonFrame({ type: 'connection.close', error: null }),
        ]),
      );
      await new Promise((resolve) =>
        client.signal.addEventListener('abort', resolve, { once: true }),
      );
      await daemon.clock.advance(0);
      expect(ends).toEqual(['released']);
      expect(daemon.plane.leases.size).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  it('refuses requests beyond the per-connection limit', async () => {
    const daemon = await controlPlane({ maxActiveRequests: 1 });
    try {
      const { client } = await connect(daemon.path);
      await call(client, initialize(1));
      // An open stream holds its request slot.
      await client.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'core.runtime.events',
        params: { cursor: null },
      });
      await client.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'core.runtime.health.get',
        params: {},
      });
      for (;;) {
        const message = await client.receive();
        if (!('id' in message) || 'method' in message || message.id !== 3)
          continue;
        if (!('error' in message))
          throw new Error(
            'Expected an error response for the over-limit request.',
          );
        expect(decodeCanopyError(message.error).kind).toBe(
          'resource_exhausted',
        );
        break;
      }
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('serves core.runtime.health.get to the lane K client', async () => {
    const daemon = await controlPlane();
    try {
      const client = await connectCanopyClient({
        endpoint: { kind: 'socket', path: daemon.path, auth: AUTH },
        clientName: 'test',
        clientVersion: '0',
        definitions: {
          queries: CANOPY_RUNTIME_QUERY_DEFINITIONS,
          instructions: {},
          streams: {},
        },
      });
      const health = await client.query('core.runtime.health.get', {});
      expect(health.runtime).toEqual(
        (
          await daemon.runtime.dispatcher.query(
            'core.runtime.health.get',
            {},
            {
              caller: {
                principalId: 'local-user',
                clientInstanceId: 'test',
                authorityId: 'local',
                interfaceKind: 'test',
                grants: ['core.runtime.read'],
              },
            },
          )
        ).runtime,
      );
      await client.close();
    } finally {
      await daemon.close();
    }
  });

  it('runs the phased stop after the idle grace with no lease', async () => {
    let report: Promise<unknown> | undefined;
    const daemon = await controlPlane({
      onIdle: () => {
        report = daemon.runtime.shutdown('idle');
      },
    });
    try {
      await daemon.clock.advance(GRACE_MS - 1);
      expect(report).toBeUndefined();
      await daemon.clock.advance(1);
      await expect(report).resolves.toMatchObject({
        reason: 'idle',
        phases: Array.from({ length: 7 }, (_, index) => ({
          id: index + 1,
          status: 'completed',
        })),
      });
    } finally {
      await daemon.close();
    }
  });

  it('cancels the idle grace when a client leases again within it', async () => {
    const onIdle = jest.fn();
    const daemon = await controlPlane({ onIdle });
    try {
      const { client } = await connect(daemon.path);
      await call(client, initialize(1));
      const acquire = (id: number): Parameters<typeof call>[1] => ({
        jsonrpc: '2.0',
        id,
        method: 'core.client.lease.acquire',
        params: {
          clientInstanceId: 'client',
          interfaceKind: 'cli',
          label: 'CLI',
          interactive: false,
          foreground: true,
          renewalIntervalMs: 15_000,
          _meta: { idempotencyKey: `acquire-${id}` },
        },
      });
      await call(client, acquire(2));
      const release = {
        jsonrpc: '2.0',
        id: 3,
        method: 'core.client.lease.release',
        params: { reason: 'normal_shutdown' },
      } as const;
      expect((await call(client, release)).result).toMatchObject({
        released: true,
      });
      await daemon.clock.advance(GRACE_MS - 1);
      await call(client, acquire(4));
      await daemon.clock.advance(GRACE_MS);
      expect(onIdle).not.toHaveBeenCalled();
      await call(client, { ...release, id: 5 });
      await daemon.clock.advance(GRACE_MS);
      expect(onIdle).toHaveBeenCalledTimes(1);
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('advertises no channel kinds by default and refuses every open', async () => {
    const daemon = await controlPlane();
    try {
      const { client, leaseId, initialized } = await leased(daemon.path);
      expect(initialized).toMatchObject({ capabilities: { channels: [] } });
      await expect(
        client.openChannel({ kind: 'conformance.hold', leaseId, caps: CAPS }),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('advertises only channel kinds whose grants the caller holds', async () => {
    const daemon = await controlPlane({
      channels: {
        kinds: {
          'conformance.secret': {
            requiredGrants: ['core.secret.use'],
            ...HOLD,
          },
          'conformance.events': {
            requiredGrants: ['core.events.read'],
            ...HOLD,
          },
        },
      },
    });
    try {
      const { client, leaseId, initialized } = await leased(daemon.path);
      expect(initialized).toMatchObject({
        capabilities: { channels: ['conformance.events'] },
      });
      await expect(
        client.openChannel({ kind: 'conformance.secret', leaseId, caps: CAPS }),
      ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });
      const channel = await client.openChannel({
        kind: 'conformance.events',
        leaseId,
        caps: CAPS,
      });
      expect(channel.signal.aborted).toBe(false);
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('judges each channel open on the caller grants current at the open', async () => {
    const grants: CanopyCallerDescriptor['grants'] = [
      'core.runtime.read',
      'core.client.manage',
      'core.events.read',
    ];
    const daemon = await controlPlane({
      callerFor: ({ connectionId }) => ({
        principalId: 'local-user',
        clientInstanceId: connectionId,
        authorityId: 'local',
        interfaceKind: 'test',
        grants: [...grants],
      }),
      channels: {
        kinds: {
          'conformance.events': {
            requiredGrants: ['core.events.read'],
            ...HOLD,
          },
        },
      },
    });
    try {
      const { client, leaseId } = await leased(daemon.path);
      const open = (): Promise<CanopyByteChannel> =>
        client.openChannel({ kind: 'conformance.events', leaseId, caps: CAPS });
      await open();
      grants.splice(grants.indexOf('core.events.read'), 1);
      await expect(open()).rejects.toMatchObject({
        payload: { kind: 'permission_denied' },
      });
      grants.push('core.events.read');
      grants.splice(grants.indexOf('core.client.manage'), 1);
      await expect(open()).rejects.toMatchObject({
        payload: { kind: 'permission_denied' },
      });
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('closes open channels when the control plane closes', async () => {
    const daemon = await controlPlane({
      channels: { kinds: { 'conformance.hold': HOLD } },
    });
    try {
      const { client, leaseId } = await leased(daemon.path);
      const channel = await client.openChannel({
        kind: 'conformance.hold',
        leaseId,
        caps: CAPS,
      });
      await daemon.plane.close();
      await closedWith(channel);
      expect(channel.signal.aborted).toBe(true);
    } finally {
      await daemon.close();
    }
  });

  it('closes a channel whose consumer throws as internal', async () => {
    const daemon = await controlPlane({
      channels: {
        kinds: {
          'conformance.broken': {
            accept: () => {
              throw new Error('consumer failed');
            },
          },
        },
      },
    });
    try {
      const { client, leaseId } = await leased(daemon.path);
      const channel = await client.openChannel({
        kind: 'conformance.broken',
        leaseId,
        caps: CAPS,
      });
      await expect(closedWith(channel)).resolves.toMatchObject({
        payload: { kind: 'internal' },
      });
      expect(client.signal.aborted).toBe(false);
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('advertises the per-lease channel cap within the connection channel limit', async () => {
    const daemon = await controlPlane({
      channels: {
        kinds: { 'conformance.hold': HOLD },
        maxChannelsPerLease: 8,
      },
      connection: { maxChannels: 2 },
    });
    try {
      const { client, leaseId, initialized } = await leased(daemon.path);
      expect(initialized).toMatchObject({
        limits: { channels: { maxChannelsPerLease: 2 } },
      });
      const open = (): Promise<CanopyByteChannel> =>
        client.openChannel({ kind: 'conformance.hold', leaseId, caps: CAPS });
      await open();
      await open();
      await expect(open()).rejects.toMatchObject({
        payload: {
          kind: 'resource_exhausted',
          details: { maxChannelsPerLease: 2 },
        },
      });
      client.close();
    } finally {
      await daemon.close();
    }
  });
});

type LeasedKernel = {
  runtime: CanopyRuntime<CanopyDispatcher>;
  shutdown: FixtureRelease;
  hold(): { entered: Promise<void>; release(): void };
  /** The params and context each `worker.git.branch.list` handler call saw. */
  branchCalls: { params: unknown; context: CanopyHandlerContext }[];
};

/** A kernel whose next query can be held open by the test. */
async function leasedKernel(): Promise<LeasedKernel> {
  const scope = cleanup.fork([files]);
  const branchCalls: LeasedKernel['branchCalls'] = [];
  let gate: { entered(): void; released: Promise<void> } | null = null;
  const roots = async (): Promise<{ roots: [] }> => {
    const held = gate;
    gate = null;
    if (held) {
      held.entered();
      await held.released;
    }
    return { roots: [] };
  };
  const runtime = createCanopyRuntime({
    profile: 'core+worker',
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: 'local' },
    definitions: {
      queries: WORKER_QUERY_DEFINITIONS,
      instructions: {},
      streams: {},
    },
    owners: [
      {
        name: 'worker.filesystem',
        plane: 'worker',
        operations: Object.keys(WORKER_QUERY_DEFINITIONS),
      },
    ],
    services: [],
    principalFor: () => 'interface',
    phaseDeadlineMs: 1_000,
    createDispatcher: (input) =>
      createCanopyDispatcher({
        profile: input.profile,
        definitions: input.definitions,
        handlers: {
          ...input.runtimeHandlers,
          instructions: {},
          queries: {
            ...input.runtimeHandlers.queries,
            'worker.agent.provider.list': (): never => {
              throw new Error('Not exercised.');
            },
            'worker.filesystem.roots.list': roots,
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
            'worker.git.branch.list': (params, context) => {
              branchCalls.push({ params, context });
              return {
                branches: [],
                defaultBranch: null,
                defaultBranchSource: null,
              };
            },
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
      }),
  });
  const started = runtime.start();
  const shutdown = scope.own(async () => {
    await started.catch(() => undefined);
    await requireCompletedPhases(runtime.shutdown('test'));
  });
  await scope.initialize(() => started);
  return {
    runtime,
    shutdown,
    branchCalls,
    hold: (): { entered: Promise<void>; release(): void } => {
      let entered = (): void => undefined;
      let release = (): void => undefined;
      const enteredPromise = new Promise<void>((done) => (entered = done));
      const released = new Promise<void>((done) => (release = done));
      gate = { entered, released };
      return { entered: enteredPromise, release };
    },
  };
}

type RpcReply = { result?: unknown; error?: unknown };
type RpcPeer = {
  readonly client: CanopyFramedConnection;
  request(
    method: CanopyOperationName,
    params?: Record<string, unknown>,
  ): Promise<RpcReply>;
};

/** A raw framed peer that matches replies by id and skips notifications. */
function rpcPeer(client: CanopyFramedConnection): RpcPeer {
  let nextId = 1;
  const waiting = new Map<CanopyJsonRpcId, (reply: RpcReply) => void>();
  void (async (): Promise<void> => {
    for (;;) {
      const message = await client.receive().catch(() => null);
      if (!message) return;
      if ('id' in message && message.id !== null && !('method' in message)) {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    }
  })();
  return {
    client,
    request: (method: CanopyOperationName, params = {}): Promise<RpcReply> => {
      const id = (nextId += 1);
      const reply = new Promise<RpcReply>((resolve) =>
        waiting.set(id, resolve),
      );
      return client
        .send({ jsonrpc: '2.0', id, method, params })
        .then(() => reply);
    },
  };
}

posix('lease-bound operations', () => {
  const LEASED_ACQUIRE = {
    ...ACQUIRE,
    label: 'Desktop',
    interfaceKind: 'desktop',
  };
  const grants: CanopyCallerDescriptor['grants'] = [
    'core.runtime.read',
    'core.client.manage',
    'worker.filesystem.read',
  ];
  async function leasedPlane(
    options: {
      readonly clock?: CanopyDaemonClock;
      readonly grants?: readonly CanopyCallerDescriptor['grants'][number][];
      readonly sameKeyFencedOperations?: readonly string[];
    } = {},
  ): Promise<
    Awaited<ReturnType<typeof controlPlane>> & {
      hold: LeasedKernel['hold'];
      branchCalls: LeasedKernel['branchCalls'];
      open(): Promise<RpcPeer>;
    }
  > {
    const kernel = await leasedKernel();
    const daemon = await controlPlane({
      dispatcher: kernel.runtime.dispatcher,
      operations: kernel.runtime.operations,
      leaseBoundOperations: Object.keys(WORKER_QUERY_DEFINITIONS),
      ...(options.sameKeyFencedOperations && {
        sameKeyFencedOperations: options.sameKeyFencedOperations,
      }),
      callerFor: ({ connectionId, lease }) => ({
        principalId: 'local-user',
        clientInstanceId: lease?.clientInstanceId ?? connectionId,
        authorityId: 'local',
        interfaceKind: lease?.interfaceKind ?? 'test',
        grants: [...(options.grants ?? grants)],
      }),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    kernel.shutdown.dependsOn(cleanup.own(() => daemon.close()));
    const peers: CanopyFramedConnection[] = [];
    return {
      ...daemon,
      hold: (): ReturnType<LeasedKernel['hold']> => kernel.hold(),
      branchCalls: kernel.branchCalls,
      open: async (): Promise<RpcPeer> => {
        const { client } = await connect(daemon.path);
        peers.push(client);
        const peer = rpcPeer(client);
        await peer.request('core.runtime.initialize', {
          client: {
            name: 'test',
            version: '0',
            protocolVersions: [1],
            capabilities: [],
          },
        });
        return peer;
      },
      close: async (): Promise<void> => {
        peers.forEach((client) => client.close());
        await daemon.close();
        await kernel.shutdown.release();
      },
    };
  }
  const acquire = (
    peer: RpcPeer,
    key: string,
    fields: Record<string, unknown> = {},
  ): Promise<RpcReply> =>
    peer.request('core.client.lease.acquire', {
      ...LEASED_ACQUIRE,
      ...fields,
      _meta: { idempotencyKey: key },
    });
  const release = (peer: RpcPeer): Promise<RpcReply> =>
    peer.request('core.client.lease.release', { reason: 'normal_shutdown' });
  const read = (
    peer: RpcPeer,
    params: Record<string, unknown> = {},
  ): Promise<RpcReply> =>
    peer.request('worker.filesystem.roots.list', {
      scope: { workspaceId: 'v' },
      ...params,
    });
  const refusal = (reply: RpcReply): unknown => decodeCanopyError(reply.error);
  const leaseIdOf = (reply: RpcReply): string => {
    const { result } = reply;
    if (
      typeof result !== 'object' ||
      result === null ||
      !('leaseId' in result) ||
      typeof result.leaseId !== 'string'
    )
      throw new Error('Expected a lease.');
    return result.leaseId;
  };
  const REQUIRED = {
    kind: 'not_found',
    message: 'This operation requires a live client lease on this connection.',
    retry: { kind: 'never' },
  };

  // CAN-5496: the peer's `_execution` reaches the handler as call input for
  // an accepting operation, never as params, and is refused elsewhere.
  it('splits _execution into the call only for operations that accept it', async () => {
    const daemon = await leasedPlane({
      grants: [...grants, 'worker.git.read'],
    });
    try {
      const peer = await daemon.open();
      await acquire(peer, 'execution');
      const execution = { childEnvironment: { PATH: '/forwarded/bin' } };
      const branchParams = {
        scope: { workspaceId: 'v', worktreeId: 'w' },
        repository: { kind: 'checkout' },
      };
      const served = await peer.request('worker.git.branch.list', {
        ...branchParams,
        _meta: { traceparent: 'trace' },
        _execution: execution,
      });
      expect(served.error).toBeUndefined();
      expect(daemon.branchCalls).toHaveLength(1);
      expect(daemon.branchCalls[0]?.params).toEqual(branchParams);
      expect(daemon.branchCalls[0]?.context.execution).toEqual(execution);
      expect(daemon.branchCalls[0]?.context.metadata).toEqual({
        traceparent: 'trace',
      });
      for (const reply of [
        await peer.request('worker.git.branch.list', {
          ...branchParams,
          _execution: { childEnvironment: { 'A=B': 'x' } },
        }),
        await read(peer, { _execution: execution }),
      ])
        expect(refusal(reply)).toMatchObject({ kind: 'invalid_argument' });
      expect(daemon.branchCalls).toHaveLength(1);
      // Without one the handler sees none: the CLI keeps the daemon's own.
      await peer.request('worker.git.branch.list', branchParams);
      expect(daemon.branchCalls[1]?.context).not.toHaveProperty('execution');
    } finally {
      await daemon.close();
    }
  });

  it('advertises the read at initialize and admits it only on a leased connection', async () => {
    const daemon = await leasedPlane();
    try {
      const { client } = await connect(daemon.path);
      expect((await call(client, initialize(1))).result).toMatchObject({
        capabilities: {
          operations: [
            'core.runtime.health.get',
            'core.runtime.manifest.get',
            'worker.filesystem.directory.list',
            'worker.filesystem.file.read',
            'worker.filesystem.link.resolve',
            'worker.filesystem.roots.list',
            'worker.filesystem.search',
            'core.client.lease.acquire',
            'core.client.lease.renew',
            'core.client.lease.release',
            'core.client.capabilities.register',
          ],
        },
      });
      client.close();
      const peer = await daemon.open();
      expect(refusal(await read(peer))).toEqual(REQUIRED);
      expect(
        refusal(
          await peer.request('worker.filesystem.directory.list', {
            scope: { workspaceId: 'v' },
            fileRootId: 'root',
            relativePath: '',
          }),
        ),
      ).toEqual(REQUIRED);
      // Operations outside the lease-bound list stay unleased.
      expect(
        (await peer.request('core.runtime.health.get')).result,
      ).toMatchObject({ runtime: { state: 'ready' } });
      await acquire(peer, 'first');
      expect((await read(peer)).result).toEqual({ roots: [] });
      expect((await release(peer)).result).toEqual({
        released: true,
        releasedRegistrationCount: 0,
        failedRequestIds: [],
      });
      expect(refusal(await read(peer))).toEqual(REQUIRED);
      await acquire(peer, 'again');
      expect((await read(peer)).result).toEqual({ roots: [] });
    } finally {
      await daemon.close();
    }
  });

  // CAN-5037: search is served to leased same-user peers under the existing
  // read grant; a leased peer without it is refused before the handler.
  it('refuses worker.filesystem.search to a leased peer without worker.filesystem.read', async () => {
    const search = (peer: RpcPeer): Promise<RpcReply> =>
      peer.request('worker.filesystem.search', {
        scope: { workspaceId: 'v', worktreeId: 't' },
        fileRootId: 'root',
        query: '',
        mode: 'name',
      });
    const ungranted = await leasedPlane({ grants: grants.slice(0, 2) });
    try {
      const peer = await ungranted.open();
      await acquire(peer, 'search-ungranted');
      expect((await read(peer)).error).toBeDefined();
      expect(refusal(await search(peer))).toMatchObject({
        kind: 'permission_denied',
      });
    } finally {
      await ungranted.close();
    }
    const granted = await leasedPlane();
    try {
      const peer = await granted.open();
      expect(refusal(await search(peer))).toEqual(REQUIRED);
      await acquire(peer, 'search-granted');
      // Admitted: the stub handler's failure proves the call reached it.
      expect(refusal(await search(peer))).toMatchObject({ kind: 'internal' });
    } finally {
      await granted.close();
    }
  });

  it('refuses after expiry, including an expiry no timer has delivered yet', async () => {
    let now = Date.parse('2026-10-17T00:00:00Z');
    const silentClock: CanopyDaemonClock = {
      now: () => now,
      setTimer: () => ({ cancel: () => undefined }),
    };
    const daemon = await leasedPlane({ clock: silentClock });
    try {
      const peer = await daemon.open();
      await acquire(peer, 'ttl');
      expect((await read(peer)).result).toEqual({ roots: [] });
      now += 60_000;
      expect(refusal(await read(peer))).toEqual(REQUIRED);
      expect(daemon.plane.leases.size).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  it('refuses a read whose lease expired while it ran, before any timer fires', async () => {
    let now = Date.parse('2026-10-17T00:00:00Z');
    const daemon = await leasedPlane({
      clock: {
        now: (): number => now,
        setTimer: (): { cancel(): void } => ({ cancel: () => undefined }),
      },
    });
    try {
      const peer = await daemon.open();
      await acquire(peer, 'ttl-in-flight');
      const held = daemon.hold();
      const pending = read(peer);
      await held.entered;
      now += 60_000;
      held.release();
      expect(refusal(await pending)).toEqual({
        kind: 'not_found',
        message: 'The client lease expired.',
        retry: { kind: 'never' },
      });
    } finally {
      await daemon.close();
    }
  });

  it('fences an in-flight read when its lease is released, with no failed request ids', async () => {
    const daemon = await leasedPlane();
    try {
      const peer = await daemon.open();
      await acquire(peer, 'in-flight');
      const held = daemon.hold();
      const pending = read(peer);
      await held.entered;
      expect((await release(peer)).result).toMatchObject({
        released: true,
        failedRequestIds: [],
      });
      const reply = await pending;
      held.release();
      expect(reply.result).toBeUndefined();
      expect(refusal(reply)).toEqual({
        kind: 'cancelled',
        message: 'The client lease was released.',
        retry: { kind: 'never' },
      });
    } finally {
      await daemon.close();
    }
  });

  // DM-5 #4: a keyed operation whose receipts never name the lease is retried
  // with its key; every other lease-bound operation keeps `never`.
  it('answers a fenced same-key operation with same_idempotency_key, and an unleased one with never', async () => {
    const daemon = await leasedPlane({
      sameKeyFencedOperations: ['worker.filesystem.roots.list'],
    });
    try {
      const peer = await daemon.open();
      expect(refusal(await read(peer))).toEqual(REQUIRED);
      const first = await daemon.open();
      await acquire(first, 'same-key');
      const releasedHold = daemon.hold();
      const released = read(first);
      await releasedHold.entered;
      await release(first);
      releasedHold.release();
      expect(refusal(await released)).toEqual({
        kind: 'cancelled',
        message: 'The client lease was released.',
        retry: { kind: 'same_idempotency_key' },
      });
      await acquire(first, 'moved-key');
      const movedHold = daemon.hold();
      const moved = read(first);
      await movedHold.entered;
      await acquire(peer, 'moved-key');
      movedHold.release();
      expect(refusal(await moved)).toEqual({
        kind: 'failed_precondition',
        message: 'The client lease moved to another connection.',
        retry: { kind: 'same_idempotency_key' },
      });
    } finally {
      await daemon.close();
    }
  });

  it('keeps an in-flight read fenced when its connection reacquires a new lease', async () => {
    const daemon = await leasedPlane();
    try {
      const peer = await daemon.open();
      const before = leaseIdOf(await acquire(peer, 'before'));
      const held = daemon.hold();
      const pending = read(peer);
      await held.entered;
      await release(peer);
      expect(leaseIdOf(await acquire(peer, 'after'))).not.toBe(before);
      held.release();
      // Admission bound the read to the released lease, not to the connection.
      expect(refusal(await pending)).toEqual({
        kind: 'cancelled',
        message: 'The client lease was released.',
        retry: { kind: 'never' },
      });
      expect((await read(peer)).result).toEqual({ roots: [] });
    } finally {
      await daemon.close();
    }
  });

  it('fences an in-flight read when its lease is evicted', async () => {
    const daemon = await leasedPlane();
    try {
      const peer = await daemon.open();
      await acquire(peer, 'in-flight');
      const held = daemon.hold();
      const pending = read(peer);
      await held.entered;
      await daemon.clock.advance(60_000);
      const reply = await pending;
      held.release();
      expect(reply.result).toBeUndefined();
      expect(refusal(reply)).toEqual({
        kind: 'not_found',
        message: 'The client lease expired.',
        retry: { kind: 'never' },
      });
    } finally {
      await daemon.close();
    }
  });

  it('fences the first connection when a replayed acquire rebinds its lease', async () => {
    const daemon = await leasedPlane();
    try {
      const first = await daemon.open();
      const leaseId = leaseIdOf(await acquire(first, 'shared-key'));
      const held = daemon.hold();
      const pending = read(first);
      await held.entered;
      const second = await daemon.open();
      // The same client instance, key and arguments replay onto the lease.
      expect(leaseIdOf(await acquire(second, 'shared-key'))).toBe(leaseId);
      const fenced = await pending;
      held.release();
      expect(refusal(fenced)).toEqual({
        kind: 'failed_precondition',
        message: 'The client lease moved to another connection.',
        retry: { kind: 'never' },
      });
      expect(refusal(await read(first))).toEqual(REQUIRED);
      expect((await read(second)).result).toEqual({ roots: [] });
    } finally {
      await daemon.close();
    }
  });

  it('follows the connection-bound lease, not declared labels or payload claims', async () => {
    const daemon = await leasedPlane();
    try {
      const first = await daemon.open();
      const second = await daemon.open();
      const leaseId = leaseIdOf(await acquire(first, 'first'));
      // Identical declared labels and client instance; a distinct lease.
      const otherId = leaseIdOf(await acquire(second, 'second'));
      expect(otherId).not.toBe(leaseId);
      expect((await read(first)).result).toEqual({ roots: [] });
      expect((await read(second)).result).toEqual({ roots: [] });
      await release(first);
      expect(refusal(await read(first))).toEqual(REQUIRED);
      expect((await read(second)).result).toEqual({ roots: [] });

      const claims = [
        { leaseId: otherId },
        { caller: { principalId: 'local-user', grants } },
      ];
      // Admission precedes params: an unleased claim learns nothing more.
      const intruder = await daemon.open();
      for (const claim of claims)
        expect(refusal(await read(intruder, claim))).toEqual(REQUIRED);
      await acquire(first, 'first-again');
      for (const claim of claims)
        expect(refusal(await read(first, claim))).toMatchObject({
          kind: 'invalid_argument',
        });
      // The JSON-RPC envelope refuses unknown metadata before it is framed.
      await expect(
        read(first, { _meta: { leaseId: otherId } }),
      ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
      expect((await read(second)).result).toEqual({ roots: [] });
    } finally {
      await daemon.close();
    }
  });

  it('admits a reconnect that reclaims its lease within the grace', async () => {
    const daemon = await leasedPlane();
    try {
      const first = await daemon.open();
      const leaseId = leaseIdOf(await acquire(first, 'before'));
      first.client.close();
      await whenDetached(daemon.plane, leaseId);
      const second = await daemon.open();
      expect(refusal(await read(second))).toEqual(REQUIRED);
      expect(
        leaseIdOf(await acquire(second, 'after', { previousLeaseId: leaseId })),
      ).toBe(leaseId);
      expect((await read(second)).result).toEqual({ roots: [] });
    } finally {
      await daemon.close();
    }
  });

  it('refuses every worker filesystem query to a leased peer without worker.filesystem.read', async () => {
    const daemon = await leasedPlane({ grants: grants.slice(0, 2) });
    try {
      const peer = await daemon.open();
      await acquire(peer, 'ungranted');
      const params: Record<string, Record<string, unknown>> = {
        'worker.filesystem.roots.list': {},
        'worker.filesystem.directory.list': {
          fileRootId: 'root',
          relativePath: '',
        },
        'worker.filesystem.file.read': {
          fileRootId: 'root',
          relativePath: 'a.md',
          maxBytes: 1,
        },
        'worker.filesystem.search': {
          fileRootId: 'root',
          query: '',
          mode: 'name',
        },
        'worker.filesystem.link.resolve': {
          mode: 'transcript',
          href: 'a.md',
        },
      };
      // Any worker query that requires worker.filesystem.read, in any
      // registry group, must be added here and proved grant-bound.
      expect(Object.keys(params).sort()).toEqual(
        Object.entries(WORKER_QUERY_DEFINITIONS)
          .filter(([, definition]) =>
            definition.requiredGrants.some(
              (grant) => grant === 'worker.filesystem.read',
            ),
          )
          .map(([name]) => name)
          .sort(),
      );
      for (const [method, fields] of Object.entries(params)) {
        if (!isWorkerOperationName(method))
          throw new Error(`not a worker query: ${method}`);
        // Refused before the handler: the stand-ins would fail as internal.
        expect(
          refusal(
            await peer.request(method, {
              scope: { workspaceId: 'v', worktreeId: 'w' },
              ...fields,
            }),
          ),
        ).toMatchObject({ kind: 'permission_denied' });
      }
    } finally {
      await daemon.close();
    }
  });

  it.each([
    ['granted', grants, REQUIRED.kind],
    ['ungranted', grants.slice(0, 2), 'permission_denied'],
  ])(
    'never grants or admits a %s caller through capability declarations',
    async (_label, held, unleasedRefusal) => {
      const daemon = await leasedPlane({ grants: held });
      const declaration = (key: string): Record<string, unknown> => ({
        // Client capability names are `core.`-scoped; none names a grant.
        capabilities: ['core.filesystem.read', 'core.client.manage'].map(
          (name) => ({
            name,
            version: 1,
            inputSchema: {},
            outputSchema: {},
          }),
        ),
        _meta: { idempotencyKey: key },
      });
      try {
        const peer = await daemon.open();
        expect(
          refusal(
            await peer.request(
              'core.client.capabilities.register',
              declaration('unleased'),
            ),
          ),
        ).toMatchObject({ kind: 'not_found' });
        expect(refusal(await read(peer))).toMatchObject({
          kind: unleasedRefusal,
        });
        await acquire(peer, 'declaring');
        expect(
          (
            await peer.request(
              'core.client.capabilities.register',
              declaration('leased'),
            )
          ).result,
        ).toMatchObject({ registrationRevision: 1 });
        const leased = await read(peer);
        if (held === grants) expect(leased.result).toEqual({ roots: [] });
        else
          expect(refusal(leased)).toMatchObject({ kind: 'permission_denied' });
        await release(peer);
        expect(refusal(await read(peer))).toMatchObject({
          kind: unleasedRefusal,
        });
      } finally {
        await daemon.close();
      }
    },
  );
});

/** A per-launch secret, distinct from the published endpoint's token. */
const SESSION_AUTH = {
  secret: 'launch-secret',
  dataRootHash: AUTH.dataRootHash,
};
const ADMITTED: CanopyCallerDescriptor = {
  principalId: 'admitted',
  clientInstanceId: 'admitted-session',
  authorityId: 'local',
  interfaceKind: 'test',
  grants: ['core.runtime.read', 'core.client.manage'],
};

/** Serves the first stream a fresh listener accepts, as a host hands one over. */
async function admitted(
  daemon: Awaited<ReturnType<typeof controlPlane>>,
  overrides: Partial<CanopyControlStreamOptions> = {},
): Promise<{ path: string; session: Promise<CanopyControlStreamSession> }> {
  const scope = cleanup.fork([files]);
  const { listener, release: listenerRelease } = await bindListener(scope);
  const session = listener
    .connections()
    [Symbol.asyncIterator]()
    .next()
    .then((next) => {
      if (next.done) throw new Error('The listener closed.');
      const served = serveCanopyControlStream({
        stream: next.value,
        auth: SESSION_AUTH,
        caller: ADMITTED,
        obligations: daemon.plane.obligations,
        dispatcher: daemon.runtime.dispatcher,
        operations: daemon.runtime.operations,
        buildVersion: '0.0.0-test',
        clock: daemon.clock,
        ...overrides,
      });
      listenerRelease.dependsOn(scope.own(() => served.close()));
      return served;
    });
  return { path: listener.address.path, session };
}

function rawWire(path: string): {
  wire: ReturnType<typeof createConnection>;
  closed: Promise<void>;
} {
  // Flowing, so it reads to the server's close past an unanswered challenge.
  const wire = createConnection(path).resume();
  const closed = new Promise<void>((resolve) =>
    wire.once('close', () => resolve()),
  );
  cleanup.own(async () => {
    wire.destroy();
    await closed;
  });
  return { wire, closed };
}

posix('one admitted control stream', () => {
  const session = { clientSecret: SESSION_AUTH.secret };

  it('serves every request as the admitted caller, apart from the daemon plane', async () => {
    const callerFor = jest.fn<
      ReturnType<CanopyDaemonControlPlaneOptions['callerFor']>,
      Parameters<CanopyDaemonControlPlaneOptions['callerFor']>
    >();
    const daemon = await controlPlane({ callerFor });
    const query = jest.spyOn(daemon.runtime.dispatcher, 'query');
    const seen: CanopyCallerDescriptor[] = [];
    const { path } = await admitted(daemon, {
      channels: {
        kinds: {
          'session.hold': {
            accept: (_channel, { caller }) => seen.push(caller),
          },
        },
      },
    });
    try {
      const { client } = await connect(path, session);
      const { result } = await call(client, initialize(1));
      // Reachability follows the admitted grants: no core.events.read here.
      expect(result).toMatchObject({
        capabilities: {
          operations: [
            'core.runtime.health.get',
            'core.runtime.manifest.get',
            'core.client.lease.acquire',
            'core.client.lease.renew',
            'core.client.lease.release',
            'core.client.capabilities.register',
          ],
          channels: ['session.hold'],
        },
      });
      const acquired = await call(client, {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.client.lease.acquire',
        params: {
          ...ACQUIRE,
          clientInstanceId: 'declared',
          _meta: { idempotencyKey: 'session' },
        },
      });
      const leaseId = CoreClientLeaseSchema.parse(acquired.result).leaseId;
      // A declared lease identity never replaces the admitted caller.
      await client.openChannel({ kind: 'session.hold', leaseId, caps: CAPS });
      const health = await call(client, {
        jsonrpc: '2.0',
        id: 3,
        method: 'core.runtime.health.get',
        params: {},
      });
      expect(health.result).toMatchObject({ runtime: { state: 'ready' } });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe(ADMITTED);
      // Initialize's two reads run as a copy that holds runtime-read; the
      // client's own read runs as the admitted caller itself.
      expect(
        query.mock.calls.map(([name, , { caller }]) => [name, caller]),
      ).toEqual([
        ['core.runtime.health.get', ADMITTED],
        ['core.runtime.manifest.get', ADMITTED],
        ['core.runtime.health.get', ADMITTED],
      ]);
      expect(query.mock.calls[2]?.[2].caller).toBe(ADMITTED);
      // The session's lease lives in its own plane state.
      expect(daemon.plane.leases.size).toBe(0);
      expect(callerFor).not.toHaveBeenCalled();
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('holds a daemon plane obligation from admission until the stream closes', async () => {
    const onIdle = jest.fn();
    const daemon = await controlPlane({ onIdle });
    const admission = await admitted(daemon);
    try {
      const { client } = await connect(admission.path, session);
      const served = await admission.session;
      expect(daemon.plane.obligations.size).toBe(1);
      await call(client, initialize(1));
      await daemon.clock.advance(GRACE_MS * 2);
      expect(onIdle).not.toHaveBeenCalled();
      client.close();
      await served.done;
      expect(daemon.plane.obligations.size).toBe(0);
      await daemon.clock.advance(GRACE_MS - 1);
      expect(onIdle).not.toHaveBeenCalled();
      await daemon.clock.advance(1);
      expect(onIdle).toHaveBeenCalledTimes(1);
    } finally {
      await daemon.close();
    }
  });

  it('admits lease-bound operations only on the session lease', async () => {
    const daemon = await controlPlane();
    const admission = await admitted(daemon, {
      leaseBoundOperations: ['core.runtime.health.get'],
    });
    try {
      const { client: published } = await connect(daemon.path);
      await call(published, initialize(1));
      await call(published, {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.client.lease.acquire',
        params: { ...ACQUIRE, _meta: { idempotencyKey: 'published' } },
      });
      expect(daemon.plane.leases.size).toBe(1);
      const { client } = await connect(admission.path, session);
      await call(client, initialize(1));
      const health = {
        jsonrpc: '2.0',
        id: 2,
        method: 'core.runtime.health.get',
        params: {},
      } as const;
      expect(decodeCanopyError((await call(client, health)).error).kind).toBe(
        'not_found',
      );
      await call(client, {
        jsonrpc: '2.0',
        id: 3,
        method: 'core.client.lease.acquire',
        params: { ...ACQUIRE, _meta: { idempotencyKey: 'session' } },
      });
      expect(daemon.plane.leases.size).toBe(1);
      expect((await call(client, { ...health, id: 4 })).result).toMatchObject({
        runtime: { state: 'ready' },
      });
      client.close();
      published.close();
    } finally {
      await daemon.close();
    }
  });

  it('ends the session and its obligation when the handshake fails', async () => {
    const daemon = await controlPlane();
    const admission = await admitted(daemon);
    try {
      // The published endpoint's token does not open the session.
      await expect(connect(admission.path)).rejects.toThrow();
      await (
        await admission.session
      ).done;
      expect(daemon.plane.obligations.size).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  it('closes the stream and releases only its own obligation, once', async () => {
    const daemon = await controlPlane();
    const admission = await admitted(daemon);
    try {
      const { client } = await connect(admission.path, session);
      const served = await admission.session;
      await call(client, initialize(1));
      const other = daemon.plane.obligations.hold('other');
      expect(daemon.plane.obligations.size).toBe(2);
      const aborted = new Promise((resolve) =>
        client.signal.addEventListener('abort', resolve, { once: true }),
      );
      await served.close();
      await aborted;
      expect(daemon.plane.obligations.size).toBe(1);
      await served.close();
      expect(daemon.plane.obligations.size).toBe(1);
      other();
      expect(daemon.plane.obligations.size).toBe(0);
    } finally {
      await daemon.close();
    }
  });

  it('closes a stream that is still in its handshake', async () => {
    const daemon = await controlPlane();
    const admission = await admitted(daemon);
    try {
      const { closed } = rawWire(admission.path);
      const served = await admission.session;
      expect(daemon.plane.obligations.size).toBe(1);
      await served.close();
      expect(daemon.plane.obligations.size).toBe(0);
      await closed;
    } finally {
      await daemon.close();
    }
  });

  it('rejects invalid serving options before holding an obligation', async () => {
    const daemon = await controlPlane();
    const admission = await admitted(daemon, { maxActiveRequests: 0 });
    try {
      rawWire(admission.path);
      await expect(admission.session).rejects.toThrow(RangeError);
      expect(daemon.plane.obligations.size).toBe(0);
    } finally {
      await daemon.close();
    }
  });
});

// A write-granted test kernel serves vault contracts over a real socket,
// exercising `_meta` splitting and client error validation on the framed path.
posix('vault contracts over the framed control plane', () => {
  const PUT = 'core.vault.entry.put';
  const DELETE = 'core.vault.entry.delete';
  const VAULT_GRANTS: CanopyCallerDescriptor['grants'] = [
    'core.runtime.read',
    'core.vault.read',
    'core.vault.write',
  ];
  const ref = { vaultId: 'vault-1', entryId: 'entry-1' };
  const entry = {
    ref,
    family: 'copilot.account',
    label: 'GitHub Copilot',
    revision: 2,
    state: 'available' as const,
    expiresAt: null,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
  };
  const create = {
    entryId: null,
    expectedRevision: null,
    family: 'copilot.account',
    label: 'GitHub Copilot',
    secret: 'sk-vault-framed-sentinel',
    expiresAt: null,
  };
  const replace = {
    ref,
    expectedRevision: 2,
    label: 'GitHub Copilot',
    secret: 'sk-vault-framed-sentinel',
    expiresAt: null,
  };
  const remove = { ref, expectedRevision: 2 };
  const vaultErrorSchemas = [
    ...Object.values(CORE_VAULT_QUERY_DEFINITIONS),
    ...Object.values(CORE_VAULT_INSTRUCTION_DEFINITIONS),
  ].map((definition) => definition.error);

  async function vaultPlane(
    options: {
      readonly fail?: CanopyErrorPayload;
      readonly grants?: readonly CanopyCallerDescriptor['grants'][number][];
      readonly maxActiveRequests?: number;
    } = {},
  ): Promise<{
    seen: { method: string; params: unknown; key: unknown }[];
    hold(): { entered: Promise<void>; release(): void };
    path: string;
    open(): Promise<RpcPeer>;
    close(): Promise<void>;
  }> {
    const scope = cleanup.fork([files]);
    const seen: { method: string; params: unknown; key: unknown }[] = [];
    let gate: { entered(): void; released: Promise<void> } | null = null;
    const recordWrite = (
      method: string,
      params: unknown,
      context: CanopyHandlerContext,
    ): void => {
      seen.push({ method, params, key: context.metadata.idempotencyKey });
      if (options.fail) throw new CanopyOperationError(options.fail);
    };
    const runtime = createCanopyRuntime({
      profile: 'core',
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: 'local' },
      definitions: {
        queries: CORE_VAULT_QUERY_DEFINITIONS,
        instructions: CORE_VAULT_INSTRUCTION_DEFINITIONS,
        streams: {},
      },
      owners: [
        {
          name: 'core.vault',
          operations: [
            ...Object.keys(CORE_VAULT_QUERY_DEFINITIONS),
            ...Object.keys(CORE_VAULT_INSTRUCTION_DEFINITIONS),
          ],
        },
      ],
      services: [],
      principalFor: () => 'interface',
      phaseDeadlineMs: 1_000,
      createDispatcher: (input) =>
        createCanopyDispatcher<
          typeof input.definitions.queries,
          typeof input.definitions.instructions,
          typeof input.definitions.streams
        >({
          profile: input.profile,
          definitions: input.definitions,
          handlers: {
            ...input.runtimeHandlers,
            queries: {
              ...input.runtimeHandlers.queries,
              'core.vault.status.get': () => ({
                protection: { state: 'unknown', backend: null },
                observedAt: null,
              }),
              'core.vault.entry.list': () => ({ items: [], nextCursor: null }),
              'core.vault.entry.get': async () => {
                const held = gate;
                gate = null;
                if (held) {
                  held.entered();
                  await held.released;
                }
                if (options.fail) throw new CanopyOperationError(options.fail);
                return entry;
              },
            },
            instructions: {
              [PUT]: (params, context) => {
                recordWrite(PUT, params, context);
                return entry;
              },
              [DELETE]: (params, context) => {
                recordWrite(DELETE, params, context);
                return { ref, tombstoneRevision: 3, revokedGrantCount: 0 };
              },
            },
          },
        }),
    });
    const started = runtime.start();
    const shutdown = scope.own(async () => {
      await started.catch(() => undefined);
      await requireCompletedPhases(runtime.shutdown('test'));
    });
    await scope.initialize(() => started);
    const daemon = await controlPlane({
      dispatcher: runtime.dispatcher,
      operations: runtime.operations,
      callerFor: ({ connectionId }) => ({
        principalId: 'local-user',
        clientInstanceId: connectionId,
        authorityId: 'local',
        interfaceKind: 'test',
        grants: [...(options.grants ?? VAULT_GRANTS)],
      }),
      ...(options.maxActiveRequests
        ? { maxActiveRequests: options.maxActiveRequests }
        : {}),
    });
    shutdown.dependsOn(cleanup.own(() => daemon.close()));
    const peers: CanopyFramedConnection[] = [];
    return {
      seen,
      hold: (): { entered: Promise<void>; release(): void } => {
        let entered = (): void => undefined;
        let release = (): void => undefined;
        const enteredPromise = new Promise<void>((done) => (entered = done));
        const released = new Promise<void>((done) => (release = done));
        gate = { entered, released };
        return { entered: enteredPromise, release };
      },
      path: daemon.path,
      open: async (): Promise<RpcPeer> => {
        const { client } = await connect(daemon.path);
        peers.push(client);
        return rpcPeer(client);
      },
      close: async (): Promise<void> => {
        peers.forEach((client) => client.close());
        await daemon.close();
        await shutdown.release();
      },
    };
  }
  const initialized = async (peer: RpcPeer): Promise<RpcPeer> => {
    await peer.request('core.runtime.initialize', {
      client: {
        name: 'test',
        version: '0',
        protocolVersions: [1],
        capabilities: [],
      },
    });
    return peer;
  };
  const acceptedByEveryVaultSchema = (payload: unknown): boolean =>
    vaultErrorSchemas.every((schema) => schema.safeParse(payload).success);

  it('serves put and delete with the idempotency key split off the params', async () => {
    const daemon = await vaultPlane();
    const client = await connectCanopyClient({
      endpoint: { kind: 'socket', path: daemon.path, auth: AUTH },
      clientName: 'vault',
      clientVersion: '0',
      definitions: {
        queries: CORE_VAULT_QUERY_DEFINITIONS,
        instructions: CORE_VAULT_INSTRUCTION_DEFINITIONS,
        streams: {},
      },
    });
    try {
      await expect(
        client.instruction(PUT, create, {
          metadata: { idempotencyKey: 'create-1' },
        }),
      ).resolves.toEqual(entry);
      await expect(
        client.instruction(PUT, replace, {
          metadata: { idempotencyKey: 'replace-1' },
        }),
      ).resolves.toEqual(entry);
      await expect(
        client.instruction(DELETE, remove, {
          metadata: { idempotencyKey: 'delete-1' },
        }),
      ).resolves.toMatchObject({ tombstoneRevision: 3 });
      // The client refuses a keyless write before it reaches the wire.
      await expect(client.instruction(PUT, create, {})).rejects.toMatchObject({
        payload: { kind: 'invalid_argument' },
      });
      expect(daemon.seen).toEqual([
        { method: PUT, params: create, key: 'create-1' },
        { method: PUT, params: replace, key: 'replace-1' },
        { method: DELETE, params: remove, key: 'delete-1' },
      ]);
      // A raw keyless frame is refused by the daemon with a listed message.
      const peer = await initialized(await daemon.open());
      const keyless = decodeCanopyError(
        (await peer.request(PUT, create)).error,
      );
      expect(keyless).toMatchObject({ kind: 'invalid_argument' });
      expect(acceptedByEveryVaultSchema(keyless)).toBe(true);
      expect(daemon.seen).toHaveLength(3);
    } finally {
      await client.close();
      await daemon.close();
    }
  });

  it('redacts an uncoded handler error with arbitrary text before it leaves the daemon', async () => {
    const daemon = await vaultPlane({
      fail: {
        kind: 'unavailable',
        message: 'TOP_SECRET',
        retry: { kind: 'same_request' },
      },
    });
    const client = await connectCanopyClient({
      endpoint: { kind: 'socket', path: daemon.path, auth: AUTH },
      clientName: 'vault',
      clientVersion: '0',
      definitions: {
        queries: CORE_VAULT_QUERY_DEFINITIONS,
        instructions: CORE_VAULT_INSTRUCTION_DEFINITIONS,
        streams: {},
      },
    });
    try {
      const peer = await initialized(await daemon.open());
      for (const reply of [
        await peer.request('core.vault.entry.get', { ref }),
        await peer.request(PUT, {
          ...replace,
          _meta: { idempotencyKey: 'leak-1' },
        }),
      ]) {
        expect(JSON.stringify(reply)).not.toContain('TOP_SECRET');
        expect(decodeCanopyError(reply.error)).toEqual({
          kind: 'internal',
          message: 'The operation returned an invalid error.',
          retry: { kind: 'never' },
        });
      }
      await expect(
        client.instruction(DELETE, remove, {
          metadata: { idempotencyKey: 'leak-2' },
        }),
      ).rejects.toMatchObject({ payload: { kind: 'internal' } });
    } finally {
      await client.close();
      await daemon.close();
    }
  });

  // Guards VAULT_UNCODED_ERROR_MESSAGES against drift in the control plane.
  it("sends the control plane's own refusals with messages the vault schemas accept", async () => {
    const daemon = await vaultPlane({ maxActiveRequests: 1 });
    const denied = await vaultPlane({ grants: ['core.runtime.read'] });
    try {
      const early = await daemon.open();
      const uninitialized = decodeCanopyError(
        (await early.request('core.vault.status.get')).error,
      );
      expect(uninitialized).toMatchObject({ kind: 'failed_precondition' });
      expect(acceptedByEveryVaultSchema(uninitialized)).toBe(true);

      const ungranted = await initialized(await denied.open());
      const refused = decodeCanopyError(
        (await ungranted.request('core.vault.status.get')).error,
      );
      expect(refused).toMatchObject({ kind: 'permission_denied' });
      expect(acceptedByEveryVaultSchema(refused)).toBe(true);

      const busy = await initialized(await daemon.open());
      const held = daemon.hold();
      const first = busy.request('core.vault.entry.get', { ref });
      await held.entered;
      const exhausted = decodeCanopyError(
        (await busy.request('core.vault.entry.get', { ref })).error,
      );
      held.release();
      expect((await first).result).toEqual(entry);
      expect(exhausted).toMatchObject({
        kind: 'resource_exhausted',
        retry: { kind: 'same_request' },
      });
      // Sent before the method is read, so keyed writes get it unrewritten.
      expect(acceptedByEveryVaultSchema(exhausted)).toBe(true);
    } finally {
      await daemon.close();
      await denied.close();
    }
  });

  const vaultClient = (path: string): ReturnType<typeof connectCanopyClient> =>
    connectCanopyClient({
      endpoint: { kind: 'socket', path, auth: AUTH },
      clientName: 'vault',
      clientVersion: '0',
      definitions: {
        queries: CORE_VAULT_QUERY_DEFINITIONS,
        instructions: CORE_VAULT_INSTRUCTION_DEFINITIONS,
        streams: {},
      },
    });

  it('delivers an idempotency-key reuse refusal from put and delete to the client unchanged', async () => {
    const reused = vaultError('core.vault.entry.idempotencyKeyReused', { ref });
    const daemon = await vaultPlane({ fail: reused });
    const client = await vaultClient(daemon.path);
    try {
      await expect(
        client.instruction(PUT, replace, {
          metadata: { idempotencyKey: 'reused-1' },
        }),
      ).rejects.toMatchObject({ payload: reused });
      await expect(
        client.instruction(DELETE, remove, {
          metadata: { idempotencyKey: 'reused-2' },
        }),
      ).rejects.toMatchObject({ payload: reused });
      expect(daemon.seen.map(({ key }) => key)).toEqual([
        'reused-1',
        'reused-2',
      ]);
    } finally {
      await client.close();
      await daemon.close();
    }
  });

  it('delivers the overload refusal of a keyed write to the client with its retry', async () => {
    const daemon = await vaultPlane({ maxActiveRequests: 1 });
    const client = await vaultClient(daemon.path);
    const held = daemon.hold();
    const first = client.query('core.vault.entry.get', { ref });
    // Rejected by close() if an assertion below fails first.
    void first.catch(() => undefined);
    try {
      await held.entered;
      const overload = {
        kind: 'resource_exhausted',
        message: 'Too many requests in flight on this connection.',
        retry: { kind: 'same_request', delayMs: 100 },
      };
      await expect(
        client.instruction(PUT, replace, {
          metadata: { idempotencyKey: 'busy-1' },
        }),
      ).rejects.toMatchObject({ payload: overload });
      await expect(
        client.instruction(DELETE, remove, {
          metadata: { idempotencyKey: 'busy-2' },
        }),
      ).rejects.toMatchObject({ payload: overload });
      held.release();
      await expect(first).resolves.toEqual(entry);
      // Refused before dispatch: no write ran, so the replay is safe.
      expect(daemon.seen).toEqual([]);
    } finally {
      held.release();
      await client.close();
      await daemon.close();
    }
  });
});

// CAN-4802: a params schema that declares `_meta` receives it from the framed
// host, as it does in process; any other schema still gets it split off.
posix('request metadata a params schema declares', () => {
  const cursor = { daemonEpoch: 'epoch', sequence: 1 };
  const keyed = { idempotencyKey: 'key-1' };
  const traced = { traceparent: 'trace-1' };
  const example = {
    plane: 'core',
    domain: 'example',
    version: 1,
    placement: 'core-only',
    requiredGrants: [],
    error: CanopyErrorPayloadSchema,
  } as const;
  const QUERIES = defineCanopyQueryRegistry('core', {
    'core.example.read': defineCanopyQuery({
      ...example,
      idempotency: 'inherent',
      params: CanopyStreamCursorSchema.extend({
        _meta: CanopyQueryRequestMetadataSchema.optional(),
      }),
      result: CanopyStreamCursorSchema,
    }),
  });
  const DECLARING_INSTRUCTIONS = defineCanopyInstructionRegistry('core', {
    'core.example.keyed': defineCanopyInstruction({
      ...example,
      idempotency: 'keyed',
      params: CanopyStreamCursorSchema.extend({
        _meta: CanopyRequestMetadataSchema.required({ idempotencyKey: true }),
      }),
      result: CanopyStreamCursorSchema,
    }),
    'core.example.write': defineCanopyInstruction({
      ...example,
      idempotency: 'keyed',
      params: CanopyStreamCursorSchema,
      result: CanopyStreamCursorSchema,
    }),
  });
  const STREAMS = defineCanopyStreamRegistry('core', {
    'core.example.watch': defineCanopyStream({
      ...example,
      idempotency: 'inherent',
      params: CanopyStreamCursorSchema.pick({ daemonEpoch: true }).extend({
        cursor: CanopyStreamCursorSchema.nullable().optional(),
        _meta: CanopyQueryRequestMetadataSchema.optional(),
      }),
      item: CanopyStreamCursorSchema.pick({ daemonEpoch: true }),
      end: CanopyStreamEndSchema,
      openResult: CoreEventsSubscribeOpenResultSchema,
    }),
  });
  const definitions = [
    ...Object.entries(QUERIES),
    ...Object.entries(DECLARING_INSTRUCTIONS),
    ...Object.entries(STREAMS),
  ];
  type Seen = { method: string; params: unknown; metadata: unknown };

  async function declaringPlane(): Promise<{
    seen: Seen[];
    peer: RpcPeer;
    close(): Promise<void>;
  }> {
    const scope = cleanup.fork([files]);
    const seen: Seen[] = [];
    const record = (
      method: string,
      params: unknown,
      context: CanopyHandlerContext,
    ): void => {
      seen.push({ method, params, metadata: context.metadata });
    };
    const runtime = createCanopyRuntime({
      profile: 'core',
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: 'local' },
      definitions: {
        queries: QUERIES,
        instructions: DECLARING_INSTRUCTIONS,
        streams: STREAMS,
      },
      owners: [
        {
          name: 'core.example',
          operations: definitions.map(([name]) => name),
        },
      ],
      services: [],
      principalFor: () => 'interface',
      phaseDeadlineMs: 1_000,
      createDispatcher: (input) =>
        createCanopyDispatcher<
          typeof input.definitions.queries,
          typeof input.definitions.instructions,
          typeof input.definitions.streams
        >({
          profile: input.profile,
          definitions: input.definitions,
          handlers: {
            ...input.runtimeHandlers,
            queries: {
              ...input.runtimeHandlers.queries,
              // Test host policy: no profile row installs the test-only
              // operations, so this manifest advertises them itself.
              'core.runtime.manifest.get': async (params, context) => {
                const manifest = await input.runtimeHandlers.queries[
                  'core.runtime.manifest.get'
                ](params, context);
                return {
                  ...manifest,
                  operations: [
                    ...manifest.operations,
                    ...definitions.map(([name, definition]) => ({
                      name,
                      kind: definition.kind,
                      version: definition.version,
                      placement: definition.placement,
                      requiredGrants: [...definition.requiredGrants],
                      available: true,
                    })),
                  ],
                };
              },
              'core.example.read': (params, context) => {
                record('core.example.read', params, context);
                return cursor;
              },
            },
            instructions: {
              'core.example.keyed': (params, context) => {
                record('core.example.keyed', params, context);
                return cursor;
              },
              'core.example.write': (params, context) => {
                record('core.example.write', params, context);
                return cursor;
              },
            },
            streams: {
              ...input.runtimeHandlers.streams,
              'core.example.watch': (params, context) => {
                record('core.example.watch', params, context);
                return Promise.resolve();
              },
            },
          },
        }),
    });
    const started = runtime.start();
    const shutdown = scope.own(async () => {
      await started.catch(() => undefined);
      await requireCompletedPhases(runtime.shutdown('test'));
    });
    await scope.initialize(() => started);
    const daemon = await controlPlane({
      dispatcher: runtime.dispatcher,
      operations: runtime.operations,
    });
    shutdown.dependsOn(cleanup.own(() => daemon.close()));
    const { client } = await connect(daemon.path);
    const peer = rpcPeer(client);
    await peer.request('core.runtime.initialize', {
      client: {
        name: 'test',
        version: '0',
        protocolVersions: [1],
        capabilities: [],
      },
    });
    return {
      seen,
      peer,
      close: async (): Promise<void> => {
        client.close();
        await daemon.close();
        await shutdown.release();
      },
    };
  }

  it('hands a keyed instruction its declared _meta in params and metadata', async () => {
    const daemon = await declaringPlane();
    try {
      const params = { ...cursor, _meta: keyed };
      const reply = await daemon.peer.request('core.example.keyed', params);
      expect(reply.error).toBeUndefined();
      expect(reply.result).toEqual(cursor);
      expect(daemon.seen).toEqual([
        { method: 'core.example.keyed', params, metadata: keyed },
      ]);
    } finally {
      await daemon.close();
    }
  });

  it('keeps a declared _meta for queries and streams too', async () => {
    const daemon = await declaringPlane();
    try {
      const read = { ...cursor, _meta: traced };
      expect(
        (await daemon.peer.request('core.example.read', read)).result,
      ).toEqual(cursor);
      // Stream registrations are lease-owned.
      await daemon.peer.request('core.client.lease.acquire', {
        ...ACQUIRE,
        _meta: { idempotencyKey: 'watch' },
      });
      const watch = { daemonEpoch: 'epoch', cursor: null, _meta: traced };
      const opened = await daemon.peer.request('core.example.watch', watch);
      expect(opened.error).toBeUndefined();
      CoreEventsSubscribeOpenResultSchema.parse(opened.result);
      expect(daemon.seen).toEqual([
        { method: 'core.example.read', params: read, metadata: traced },
        { method: 'core.example.watch', params: watch, metadata: traced },
      ]);
    } finally {
      await daemon.close();
    }
  });

  it('still splits _meta off a schema that does not declare it', async () => {
    const daemon = await declaringPlane();
    try {
      const reply = await daemon.peer.request('core.example.write', {
        ...cursor,
        _meta: keyed,
      });
      expect(reply.result).toEqual(cursor);
      expect(daemon.seen).toEqual([
        { method: 'core.example.write', params: cursor, metadata: keyed },
      ]);
    } finally {
      await daemon.close();
    }
  });

  it('refuses a declared keyed schema whose _meta lacks the key', async () => {
    const daemon = await declaringPlane();
    try {
      const reply = await daemon.peer.request('core.example.keyed', cursor);
      expect(decodeCanopyError(reply.error).kind).toBe('invalid_argument');
      expect(daemon.seen).toEqual([]);
    } finally {
      await daemon.close();
    }
  });
});

posix('messages larger than one frame (CAN-5630, CAN-5684)', () => {
  const QUERIES = defineCanopyQueryRegistry('core', {
    'core.example.blob': defineCanopyQuery({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [],
      // `sequence` is the reply's text length.
      params: CanopyStreamCursorSchema,
      result: z.strictObject({ text: z.string() }),
      error: CanopyErrorPayloadSchema,
    }),
  });
  // Each opened stream sends a `sequence`-long item, then a small one.
  const STREAMS = defineCanopyStreamRegistry('core', {
    'core.example.blobs': defineCanopyStream({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: [],
      params: CanopyStreamCursorSchema.extend({
        cursor: CanopyStreamCursorSchema.nullable().optional(),
      }),
      item: z.strictObject({ text: z.string() }),
      end: CanopyStreamEndSchema,
      openResult: CoreEventsSubscribeOpenResultSchema,
      error: CanopyErrorPayloadSchema,
    }),
  });
  const LARGE = 10 * 1024 * 1024;

  async function blobPlane(): Promise<{
    path: string;
    close(): Promise<void>;
  }> {
    const scope = cleanup.fork([files]);
    const runtime = createCanopyRuntime({
      profile: 'core',
      identity: {
        runtimeId: 'runtime',
        hostId: 'host',
        authorityId: 'local',
      },
      definitions: { queries: QUERIES, instructions: {}, streams: STREAMS },
      owners: [
        {
          name: 'core.example',
          operations: ['core.example.blob', 'core.example.blobs'],
        },
      ],
      services: [],
      principalFor: () => 'interface',
      phaseDeadlineMs: 1_000,
      createDispatcher: (input) =>
        createCanopyDispatcher<
          typeof input.definitions.queries,
          typeof input.definitions.instructions,
          typeof input.definitions.streams
        >({
          profile: input.profile,
          definitions: input.definitions,
          handlers: {
            ...input.runtimeHandlers,
            queries: {
              ...input.runtimeHandlers.queries,
              // Test host policy: no profile row installs the test-only
              // operation, so this manifest advertises it itself.
              'core.runtime.manifest.get': async (params, context) => {
                const manifest = await input.runtimeHandlers.queries[
                  'core.runtime.manifest.get'
                ](params, context);
                return {
                  ...manifest,
                  operations: [
                    ...manifest.operations,
                    ...(['query', 'stream'] as const).map((kind) => ({
                      name:
                        kind === 'query'
                          ? 'core.example.blob'
                          : 'core.example.blobs',
                      kind,
                      version: 1,
                      placement: 'core-only' as const,
                      requiredGrants: [],
                      available: true,
                    })),
                  ],
                };
              },
              'core.example.blob': ({ sequence }) => ({
                text: 'ü'.repeat(sequence / 2),
              }),
            },
            instructions: {},
            streams: {
              ...input.runtimeHandlers.streams,
              'core.example.blobs': ({ sequence }, _context, sink) => {
                sink.emit({ text: 'ü'.repeat(sequence / 2) });
                sink.emit({ text: 'ü' });
                sink.end('completed');
                return Promise.resolve();
              },
            },
          },
        }),
    });
    const started = runtime.start();
    const shutdown = scope.own(async () => {
      await started.catch(() => undefined);
      await requireCompletedPhases(runtime.shutdown('test'));
    });
    await scope.initialize(() => started);
    const daemon = await controlPlane({
      dispatcher: runtime.dispatcher,
      operations: runtime.operations,
    });
    shutdown.dependsOn(cleanup.own(() => daemon.close()));
    return {
      path: daemon.path,
      close: async (): Promise<void> => {
        await daemon.close();
        await shutdown.release();
      },
    };
  }

  it('sends a client that reassembles parts the whole reply', async () => {
    const daemon = await blobPlane();
    const client = await connectCanopyClient({
      endpoint: { kind: 'socket', path: daemon.path, auth: AUTH },
      clientName: 'parts',
      clientVersion: '0',
      definitions: { queries: QUERIES, instructions: {}, streams: {} },
    });
    try {
      const reply = await client.query('core.example.blob', {
        daemonEpoch: 'epoch',
        sequence: LARGE,
      });
      expect(reply).toEqual({ text: 'ü'.repeat(LARGE / 2) });
      await expect(
        client.query('core.example.blob', {
          daemonEpoch: 'epoch',
          sequence: 2,
        }),
      ).resolves.toEqual({ text: 'ü' });
    } finally {
      await client.close();
      await daemon.close();
    }
  });

  it('answers a client that did not say it reassembles parts with resource_exhausted', async () => {
    const daemon = await blobPlane();
    try {
      const { client } = await connect(daemon.path);
      const peer = rpcPeer(client);
      // An older client: no `client.maxMessageBytes`, so nothing is split.
      await peer.request('core.runtime.initialize', {
        client: {
          name: 'test',
          version: '0',
          protocolVersions: [1],
          capabilities: [],
        },
      });
      const refused = await peer.request('core.example.blob', {
        daemonEpoch: 'epoch',
        sequence: LARGE,
      });
      expect(decodeCanopyError(refused.error)).toMatchObject({
        kind: 'resource_exhausted',
        retry: { kind: 'never' },
      });
      await expect(
        peer.request('core.example.blob', {
          daemonEpoch: 'epoch',
          sequence: 2,
        }),
      ).resolves.toMatchObject({ result: { text: 'ü' } });
      client.close();
    } finally {
      await daemon.close();
    }
  });

  it('sends a client that reassembles parts a whole stream item', async () => {
    const daemon = await blobPlane();
    const client = await connectCanopyClient({
      endpoint: { kind: 'socket', path: daemon.path, auth: AUTH },
      clientName: 'parts',
      clientVersion: '0',
      definitions: {
        queries: QUERIES,
        instructions: CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
        streams: STREAMS,
      },
    });
    try {
      await client.instruction('core.client.lease.acquire', {
        ...ACQUIRE,
        _meta: { idempotencyKey: 'blobs' },
      });
      const handle = await client.openStream('core.example.blobs', {
        daemonEpoch: 'epoch',
        sequence: LARGE,
      });
      const frames: unknown[] = [];
      for await (const frame of handle.frames) frames.push(frame);
      expect(frames).toMatchObject([
        { kind: 'item', item: { text: 'ü'.repeat(LARGE / 2) } },
        { kind: 'item', item: { text: 'ü' } },
        { kind: 'end', outcome: 'completed', error: null },
      ]);
    } finally {
      await client.close();
      await daemon.close();
    }
  });

  it('ends only the stream whose item a client without parts cannot take', async () => {
    const daemon = await blobPlane();
    try {
      const { client } = await connect(daemon.path);
      const exchange = async (
        id: number,
        method: CanopyOperationName,
        params: Record<string, unknown>,
      ): Promise<CanopyJsonRpcMessage> => {
        await client.send({ jsonrpc: '2.0', id, method, params });
        return client.receive();
      };
      // An older client: no `client.maxMessageBytes`, so nothing is split.
      await exchange(1, 'core.runtime.initialize', {
        client: {
          name: 'test',
          version: '0',
          protocolVersions: [1],
          capabilities: [],
        },
      });
      await exchange(2, 'core.client.lease.acquire', {
        ...ACQUIRE,
        _meta: { idempotencyKey: 'blobs' },
      });
      const resumed = { daemonEpoch: 'resumed', sequence: 5 };
      const opened = await exchange(3, 'core.example.blobs', {
        daemonEpoch: 'epoch',
        sequence: LARGE,
        cursor: resumed,
      });
      const { subscriptionId } = CoreEventsSubscribeOpenResultSchema.parse(
        'result' in opened ? opened.result : undefined,
      );
      // Before CAN-5684 the refused item answered the open request again.
      const ended = await client.receive();
      expect(ended).toMatchObject({
        method: 'core.example.blobs.end',
        params: {
          subscriptionId,
          // Nothing was delivered, so it ends where it resumed.
          cursor: resumed,
          outcome: 'error',
          error: { kind: 'resource_exhausted', retry: { kind: 'never' } },
        },
      });
      await expect(
        exchange(4, 'core.example.blob', {
          daemonEpoch: 'epoch',
          sequence: 2,
        }),
      ).resolves.toMatchObject({ id: 4, result: { text: 'ü' } });
      client.close();
    } finally {
      await daemon.close();
    }
  });
});
