import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectCanopyClient } from '@canopy/core-client/node';
import {
  createCanopyDesktopPeerProof,
  createCanopyFramedConnection,
  createCanopyOwnerProof,
} from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CANOPY_RUNTIME_QUERY_DEFINITIONS,
  createCanopyDispatcher,
  createCanopyRuntime,
  type CanopyDispatcher,
  type CanopyRuntime,
  type CanopyRuntimeQueries,
  type CanopyRuntimeStreams,
  type PlatformEndpointListener,
  type PlatformUnixSocketAddress,
} from '@canopy/core-runtime';
import {
  createCanopyOwnerProofVerifier,
  serveCanopyDaemonControlPlane,
  type CanopyControlConnectionIdentity,
  type CanopyControlWindowIdentity,
  type CanopyDaemonControlPlaneOptions,
  type CanopyOwnerProofVerifier,
  type CanopyWindowTicketVerifier,
} from '@canopy/core-runtime/node';
import {
  decodeCanopyError,
  type CanopyOperationName,
} from '@canopy/protocol/canopy-core';
import { createPlatformEndpointServices } from '@canopy/core-platform';

const posix = process.platform === 'win32' ? describe.skip : describe;
const AUTH = { secret: 'socket-secret', dataRootHash: '0'.repeat(64) };
const DEFINITIONS = {
  queries: CANOPY_RUNTIME_QUERY_DEFINITIONS,
  instructions: {},
  streams: {},
};

let directory = '';
let sockets = 0;
const teardown: (() => Promise<unknown>)[] = [];

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'owner-')));
});
afterEach(async () => {
  for (const step of teardown.splice(0).reverse())
    await step().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});

async function bindListener(): Promise<
  PlatformEndpointListener<PlatformUnixSocketAddress>
> {
  const endpoints = createPlatformEndpointServices(
    process.platform === 'darwin' ? 'darwin' : 'linux',
  );
  if (endpoints.semantics !== 'filesystem-socket')
    throw new Error('Unix sockets required.');
  const bound = await endpoints.bind({
    kind: 'unix-socket',
    path: join(directory, `${(sockets += 1)}.sock`),
  });
  if (bound.kind !== 'bound') throw new Error('Socket in use.');
  teardown.push(() => bound.listener.close());
  return bound.listener;
}

type Kernel = CanopyRuntime<
  CanopyDispatcher<
    CanopyRuntimeQueries,
    Record<never, never>,
    CanopyRuntimeStreams
  >
>;

async function startedKernel(): Promise<Kernel> {
  const runtime = createCanopyRuntime({
    profile: 'core',
    identity: { runtimeId: 'runtime', hostId: 'host', authorityId: null },
    definitions: { queries: {}, instructions: {}, streams: {} },
    owners: [],
    services: [],
    principalFor: () => 'interface',
    phaseDeadlineMs: 1_000,
    createDispatcher: (input) =>
      createCanopyDispatcher({
        profile: input.profile,
        definitions: input.definitions,
        handlers: { ...input.runtimeHandlers, instructions: {} },
      }),
  });
  await runtime.start();
  teardown.push(() => runtime.shutdown('test'));
  return runtime;
}

async function controlPlane(
  ownerProof?: CanopyOwnerProofVerifier,
  windows: Pick<
    CanopyDaemonControlPlaneOptions,
    'windowTickets' | 'operationsFor'
  > = {},
): Promise<{
  path: string;
  identities: CanopyControlConnectionIdentity[];
}> {
  const listener = await bindListener();
  const runtime = await startedKernel();
  const identities: CanopyControlConnectionIdentity[] = [];
  const plane = serveCanopyDaemonControlPlane({
    binding: { listener, auth: AUTH },
    dispatcher: runtime.dispatcher,
    operations: runtime.operations,
    callerFor: (identity) => {
      identities.push(identity);
      return {
        principalId: 'local-user',
        clientInstanceId:
          identity.lease?.clientInstanceId ?? identity.connectionId,
        authorityId: 'local',
        interfaceKind: 'test',
        grants: ['core.runtime.read', 'core.client.manage'],
      };
    },
    ...(ownerProof && { ownerProof }),
    ...windows,
    buildVersion: '0.0.0-test',
    idleGrace: { graceMs: 30_000 },
    onIdle: () => undefined,
  });
  teardown.push(() => plane.close());
  return { path: listener.address.path, identities };
}

function client(
  path: string,
  ownerProof?: (connectionId: string) => string,
): ReturnType<
  typeof connectCanopyClient<typeof CANOPY_RUNTIME_QUERY_DEFINITIONS>
> {
  const connecting = connectCanopyClient({
    endpoint: { kind: 'socket', path, auth: AUTH },
    clientName: 'owner-test',
    clientVersion: '0',
    definitions: DEFINITIONS,
    ...(ownerProof && { ownerProof }),
  });
  void connecting.then(
    (connected) => teardown.push(() => connected.close()),
    () => undefined,
  );
  return connecting;
}

/** A raw framed connection, for initialize params a client never sends. */
async function rawConnection(path: string): Promise<CanopyFramedConnection> {
  const wire = createConnection(path);
  teardown.push(() => Promise.resolve(wire.destroy()));
  return createCanopyFramedConnection(wire, {
    role: 'client',
    auth: AUTH,
    handshakeTimeoutMs: 2_000,
  });
}

async function initializeWith(
  connection: CanopyFramedConnection,
  ownerProof: unknown,
): Promise<ReturnType<typeof decodeCanopyError> | null> {
  await connection.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'core.runtime.initialize',
    params: {
      client: {
        name: 'raw',
        version: '0',
        protocolVersions: [1],
        capabilities: [],
        ownerProof,
      },
    },
  });
  const response = await connection.receive();
  if (!('id' in response) || 'method' in response)
    throw new Error('Expected a response.');
  return 'error' in response ? decodeCanopyError(response.error) : null;
}

async function closed(connection: CanopyFramedConnection): Promise<boolean> {
  await connection.receive().catch(() => undefined);
  return connection.signal.aborted;
}

const REFUSED = {
  kind: 'unauthenticated',
  message: 'The owner proof was refused.',
};

posix('daemon owner proof (CAN-5771)', () => {
  const secret = randomBytes(32);
  const verifier = (): CanopyOwnerProofVerifier =>
    createCanopyOwnerProofVerifier({
      secret,
      dataRootHash: AUTH.dataRootHash,
    });
  const prove = (connectionId: string): string =>
    createCanopyOwnerProof(secret, connectionId, AUTH.dataRootHash);

  it('a connection that proves the owner secret is an owner for its life', async () => {
    const daemon = await controlPlane(verifier());
    let ownerConnection = '';
    const owner = await client(daemon.path, (id) => {
      ownerConnection = id;
      return prove(id);
    });
    await owner.query('core.runtime.health.get', {});
    const ownerIdentities = daemon.identities.filter(
      (identity) => identity.connectionId === ownerConnection,
    );
    expect(ownerIdentities.length).toBeGreaterThanOrEqual(2);
    expect(ownerIdentities.every((identity) => identity.owner)).toBe(true);

    const peer = await client(daemon.path);
    await peer.query('core.runtime.health.get', {});
    const peerIdentities = daemon.identities.filter(
      (identity) => identity.connectionId !== ownerConnection,
    );
    expect(peerIdentities.length).toBeGreaterThan(0);
    expect(peerIdentities.every((identity) => !identity.owner)).toBe(true);
  });

  it('a wrong owner proof is refused and closes the connection', async () => {
    const daemon = await controlPlane(verifier());
    const other = randomBytes(32);
    await expect(
      client(daemon.path, (id) =>
        createCanopyOwnerProof(other, id, AUTH.dataRootHash),
      ),
    ).rejects.toMatchObject({ payload: REFUSED });
    expect(daemon.identities.some((identity) => identity.owner)).toBe(false);

    const raw = await rawConnection(daemon.path);
    const refusal = await initializeWith(
      raw,
      createCanopyOwnerProof(other, raw.connectionId, AUTH.dataRootHash),
    );
    expect(refusal).toMatchObject(REFUSED);
    expect(await closed(raw)).toBe(true);
    expect(daemon.identities.some((identity) => identity.owner)).toBe(false);
  });

  it('a proof made for another connection is refused', async () => {
    const daemon = await controlPlane(verifier());
    let replayed = '';
    await client(daemon.path, (id) => (replayed = prove(id)));
    const raw = await rawConnection(daemon.path);
    expect(await initializeWith(raw, replayed)).toMatchObject(REFUSED);
    expect(await closed(raw)).toBe(true);
    expect(
      daemon.identities.some(
        (identity) =>
          identity.connectionId === raw.connectionId && identity.owner,
      ),
    ).toBe(false);
  });

  it('a daemon without an owner secret refuses every proof', async () => {
    const daemon = await controlPlane();
    await expect(client(daemon.path, prove)).rejects.toMatchObject({
      payload: REFUSED,
    });
    const peer = await client(daemon.path);
    await expect(
      peer.query('core.runtime.health.get', {}),
    ).resolves.toBeTruthy();
    expect(daemon.identities.some((identity) => identity.owner)).toBe(false);
  });

  it('a proof that is not a string is refused', async () => {
    const daemon = await controlPlane(verifier());
    const raw = await rawConnection(daemon.path);
    expect(await initializeWith(raw, 42)).toMatchObject(REFUSED);
    expect(await closed(raw)).toBe(true);
  });
});

/** Initializes with these extra `client` fields; the response's result or error. */
async function initializeWithClient(
  connection: CanopyFramedConnection,
  extra: Record<string, unknown>,
): Promise<{ result?: unknown; error?: unknown }> {
  await connection.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'core.runtime.initialize',
    params: {
      client: {
        name: 'raw',
        version: '0',
        protocolVersions: [1],
        capabilities: [],
        ...extra,
      },
    },
  });
  const response = await connection.receive();
  if (!('id' in response) || 'method' in response)
    throw new Error('Expected a response.');
  return 'error' in response
    ? { error: decodeCanopyError(response.error) }
    : { result: response.result };
}

posix('desktop peer proof (CAN-7201)', () => {
  const secret = randomBytes(32);
  const verifier = (): CanopyOwnerProofVerifier =>
    createCanopyOwnerProofVerifier({
      secret,
      dataRootHash: AUTH.dataRootHash,
    });
  const provePeer = (connectionId: string): string =>
    createCanopyDesktopPeerProof(secret, connectionId, AUTH.dataRootHash);
  const identitiesOf = (
    daemon: { identities: CanopyControlConnectionIdentity[] },
    connectionId: string,
  ): CanopyControlConnectionIdentity[] =>
    daemon.identities.filter(
      (identity) => identity.connectionId === connectionId,
    );

  it('a connection that proves it is the launching desktop is a peer, not an owner', async () => {
    const daemon = await controlPlane(verifier());
    let peerConnection = '';
    const peer = await connectCanopyClient({
      endpoint: { kind: 'socket', path: daemon.path, auth: AUTH },
      clientName: 'peer-test',
      clientVersion: '0',
      definitions: DEFINITIONS,
      desktopPeerProof: (id) => {
        peerConnection = id;
        return provePeer(id);
      },
    });
    teardown.push(() => peer.close());
    await peer.query('core.runtime.health.get', {});
    const seen = identitiesOf(daemon, peerConnection);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((identity) => identity.peer && !identity.owner)).toBe(
      true,
    );
  });

  it('every failed peer proof leaves an ordinary connection, exactly as no proof', async () => {
    const daemon = await controlPlane(verifier());
    const plain = await rawConnection(daemon.path);
    const baseline = await initializeWithClient(plain, {});
    expect(baseline.error).toBeUndefined();

    const other = await rawConnection(daemon.path);
    const elsewhere = provePeer(other.connectionId);
    const otherSecret = randomBytes(32);
    const claims: ((connectionId: string) => unknown)[] = [
      // S1: an owner proof is never a peer proof.
      (id) => createCanopyOwnerProof(secret, id, AUTH.dataRootHash),
      // S2: another connection's proof, and another data root's.
      () => elsewhere,
      (id) => createCanopyDesktopPeerProof(secret, id, 'c'.repeat(64)),
      // S5: the wrong secret, malformed, empty and non-string proofs.
      (id) => createCanopyDesktopPeerProof(otherSecret, id, AUTH.dataRootHash),
      () => 'not-a-proof',
      () => '',
      () => 42,
      () => null,
    ];
    for (const claim of claims) {
      const raw = await rawConnection(daemon.path);
      const outcome = await initializeWithClient(raw, {
        desktopPeerProof: claim(raw.connectionId),
      });
      expect(outcome).toEqual(baseline);
      expect(raw.signal.aborted).toBe(false);
      expect(
        identitiesOf(daemon, raw.connectionId).some(
          (identity) => identity.peer || identity.owner,
        ),
      ).toBe(false);
    }
  });

  it('a peer proof sent as an owner proof is refused as one', async () => {
    const daemon = await controlPlane(verifier());
    const raw = await rawConnection(daemon.path);
    expect(
      await initializeWith(raw, provePeer(raw.connectionId)),
    ).toMatchObject(REFUSED);
    expect(await closed(raw)).toBe(true);
  });

  it('an owner proof decides when both are sent', async () => {
    const daemon = await controlPlane(verifier());
    const raw = await rawConnection(daemon.path);
    const outcome = await initializeWithClient(raw, {
      ownerProof: createCanopyOwnerProof(
        secret,
        raw.connectionId,
        AUTH.dataRootHash,
      ),
      desktopPeerProof: provePeer(raw.connectionId),
    });
    expect(outcome.error).toBeUndefined();
    const seen = identitiesOf(daemon, raw.connectionId);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((identity) => identity.owner && !identity.peer)).toBe(
      true,
    );
  });

  it('a daemon without an owner secret treats every peer proof as absent', async () => {
    const daemon = await controlPlane();
    const raw = await rawConnection(daemon.path);
    const outcome = await initializeWithClient(raw, {
      desktopPeerProof: provePeer(raw.connectionId),
    });
    expect(outcome.error).toBeUndefined();
    expect(
      identitiesOf(daemon, raw.connectionId).some((identity) => identity.peer),
    ).toBe(false);
  });

  it('keeps the proof out of the identity the host sees', async () => {
    const daemon = await controlPlane(verifier());
    const raw = await rawConnection(daemon.path);
    const proof = provePeer(raw.connectionId);
    await initializeWithClient(raw, { desktopPeerProof: proof });
    const seen = JSON.stringify(identitiesOf(daemon, raw.connectionId));
    const hex = secret.toString('hex');
    const encoded = secret.toString('base64url');
    // Booleans only, so a failure never prints the secret or the proof.
    expect(
      seen.includes(proof) || seen.includes(hex) || seen.includes(encoded),
    ).toBe(false);
  });
});

/** One raw request's response; notifications in between are skipped. */
async function requestOn(
  connection: CanopyFramedConnection,
  id: number,
  method: CanopyOperationName,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: ReturnType<typeof decodeCanopyError> }> {
  await connection.send({ jsonrpc: '2.0', id, method, params });
  for (;;) {
    const message = await connection.receive();
    if (!('id' in message) || 'method' in message || message.id !== id)
      continue;
    return 'error' in message
      ? { error: decodeCanopyError(message.error) }
      : { result: message.result };
  }
}

function operationsOf(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return undefined;
  const capabilities: unknown = Reflect.get(result, 'capabilities');
  if (typeof capabilities !== 'object' || capabilities === null)
    return undefined;
  const operations: unknown = Reflect.get(capabilities, 'operations');
  return Array.isArray(operations)
    ? operations.filter((name) => typeof name === 'string').sort()
    : operations;
}

posix('desktop window ticket (CAN-8039)', () => {
  const secret = randomBytes(32);
  const verifier = (): CanopyOwnerProofVerifier =>
    createCanopyOwnerProofVerifier({
      secret,
      dataRootHash: AUTH.dataRootHash,
    });
  const WINDOW_REFUSED = {
    kind: 'unauthenticated',
    message: 'The window ticket was refused.',
  };
  /** Single-use tickets the test issues, and the window ends it reports. */
  const ticketsFor = (): CanopyWindowTicketVerifier & {
    issue(ticket: string, window: CanopyControlWindowIdentity): void;
    end(windowInstanceId: string): void;
    readonly presented: unknown[];
  } => {
    const issued = new Map<string, CanopyControlWindowIdentity>();
    const ended = new Set<(windowInstanceId: string) => void>();
    const presented: unknown[] = [];
    return {
      presented,
      issue: (ticket, window) => void issued.set(ticket, window),
      end: (windowInstanceId) =>
        ended.forEach((listener) => listener(windowInstanceId)),
      redeem: (ticket) => {
        presented.push(ticket);
        if (typeof ticket !== 'string') return null;
        const window = issued.get(ticket) ?? null;
        issued.delete(ticket);
        return window;
      },
      onWindowEnded: (listener) => {
        ended.add(listener);
        return () => void ended.delete(listener);
      },
    };
  };
  const WINDOW = { windowInstanceId: 'window-1', issuerLeaseId: 'lease-1' };
  const ONLY_HEALTH: ReadonlySet<string> = new Set(['core.runtime.health.get']);
  const windowsOnly = (
    identity: CanopyControlConnectionIdentity,
  ): ReadonlySet<string> | undefined =>
    identity.window ? ONLY_HEALTH : undefined;
  const identitiesOf = (
    daemon: { identities: CanopyControlConnectionIdentity[] },
    connectionId: string,
  ): CanopyControlConnectionIdentity[] =>
    daemon.identities.filter(
      (identity) => identity.connectionId === connectionId,
    );

  it('a ticket admits its window once; a replayed, unknown or malformed ticket is refused and closes the connection', async () => {
    const tickets = ticketsFor();
    const daemon = await controlPlane(verifier(), {
      windowTickets: tickets,
      operationsFor: windowsOnly,
    });
    tickets.issue('ticket-1', WINDOW);
    const admitted = await rawConnection(daemon.path);
    const outcome = await initializeWithClient(admitted, {
      windowTicket: 'ticket-1',
    });
    expect(outcome.error).toBeUndefined();
    const seen = identitiesOf(daemon, admitted.connectionId);
    expect(seen.length).toBeGreaterThan(0);
    expect(
      seen.every(
        (identity) =>
          !identity.owner &&
          identity.window?.windowInstanceId === WINDOW.windowInstanceId &&
          identity.window.issuerLeaseId === WINDOW.issuerLeaseId,
      ),
    ).toBe(true);
    for (const claim of ['ticket-1', 'never-issued', 42, null, {}]) {
      const raw = await rawConnection(daemon.path);
      expect(
        await initializeWithClient(raw, { windowTicket: claim }),
      ).toMatchObject({ error: WINDOW_REFUSED });
      expect(await closed(raw)).toBe(true);
      expect(
        identitiesOf(daemon, raw.connectionId).some(
          (identity) => identity.window !== null,
        ),
      ).toBe(false);
    }
  });

  it('a daemon without a ticket verifier refuses every ticket', async () => {
    const daemon = await controlPlane(verifier());
    const raw = await rawConnection(daemon.path);
    expect(
      await initializeWithClient(raw, { windowTicket: 'ticket-1' }),
    ).toMatchObject({ error: WINDOW_REFUSED });
    expect(await closed(raw)).toBe(true);
  });

  it('an owner proof beside a window ticket closes the connection, and spends the ticket', async () => {
    const tickets = ticketsFor();
    const daemon = await controlPlane(verifier(), { windowTickets: tickets });
    tickets.issue('ticket-1', WINDOW);
    const raw = await rawConnection(daemon.path);
    expect(
      await initializeWithClient(raw, {
        ownerProof: createCanopyOwnerProof(
          secret,
          raw.connectionId,
          AUTH.dataRootHash,
        ),
        windowTicket: 'ticket-1',
      }),
    ).toMatchObject({ error: WINDOW_REFUSED });
    expect(await closed(raw)).toBe(true);
    expect(
      identitiesOf(daemon, raw.connectionId).some(
        (identity) => identity.owner || identity.window !== null,
      ),
    ).toBe(false);
    // Spent: the same ticket admits nothing afterwards.
    const again = await rawConnection(daemon.path);
    expect(
      await initializeWithClient(again, { windowTicket: 'ticket-1' }),
    ).toMatchObject({ error: WINDOW_REFUSED });
  });

  it('a peer proof beside a window ticket gets only the window allowlist, never more than the peer alone', async () => {
    const tickets = ticketsFor();
    const daemon = await controlPlane(verifier(), {
      windowTickets: tickets,
      operationsFor: windowsOnly,
    });
    const peerOnly = await rawConnection(daemon.path);
    const peer = await initializeWithClient(peerOnly, {
      desktopPeerProof: createCanopyDesktopPeerProof(
        secret,
        peerOnly.connectionId,
        AUTH.dataRootHash,
      ),
    });
    tickets.issue('ticket-1', WINDOW);
    const raw = await rawConnection(daemon.path);
    const window = await initializeWithClient(raw, {
      desktopPeerProof: createCanopyDesktopPeerProof(
        secret,
        raw.connectionId,
        AUTH.dataRootHash,
      ),
      windowTicket: 'ticket-1',
    });
    expect(window.error).toBeUndefined();
    const seen = identitiesOf(daemon, raw.connectionId);
    expect(seen.every((identity) => identity.peer && identity.window)).toBe(
      true,
    );
    expect(operationsOf(window.result)).toEqual(['core.runtime.health.get']);
    expect(operationsOf(peer.result)).toEqual(
      expect.arrayContaining([
        'core.runtime.health.get',
        'core.runtime.manifest.get',
        'core.client.lease.acquire',
      ]),
    );
    // Outside the allowlist is permission_denied, never served as the peer.
    for (const [method, params] of [
      ['core.runtime.manifest.get', {}],
      ['core.client.lease.release', { reason: 'normal_shutdown' }],
    ] as const)
      expect(await requestOn(raw, 2, method, params)).toMatchObject({
        error: { kind: 'permission_denied' },
      });
    expect(
      await requestOn(raw, 3, 'core.runtime.health.get', {}),
    ).toHaveProperty('result');
    expect(raw.signal.aborted).toBe(false);
  });

  it("closes a window connection when its issuing lease ends, or its window ends, and nobody else's", async () => {
    const tickets = ticketsFor();
    const daemon = await controlPlane(verifier(), { windowTickets: tickets });
    const issuer = await rawConnection(daemon.path);
    await initializeWithClient(issuer, {});
    const acquired = await requestOn(issuer, 2, 'core.client.lease.acquire', {
      clientInstanceId: 'electron-main',
      interfaceKind: 'desktop',
      label: 'Desktop',
      interactive: true,
      foreground: true,
      renewalIntervalMs: 15_000,
      _meta: { idempotencyKey: 'acquire-1' },
    });
    const leaseId: unknown =
      typeof acquired.result === 'object' && acquired.result !== null
        ? Reflect.get(acquired.result, 'leaseId')
        : undefined;
    if (typeof leaseId !== 'string') throw new Error('No lease.');
    const windowOn = async (
      ticket: string,
      windowInstanceId: string,
    ): Promise<CanopyFramedConnection> => {
      tickets.issue(ticket, { windowInstanceId, issuerLeaseId: leaseId });
      const raw = await rawConnection(daemon.path);
      expect(
        (await initializeWithClient(raw, { windowTicket: ticket })).error,
      ).toBeUndefined();
      return raw;
    };
    const first = await windowOn('ticket-1', 'window-1');
    const second = await windowOn('ticket-2', 'window-2');
    const bystander = await rawConnection(daemon.path);
    await initializeWithClient(bystander, {});

    tickets.end('window-1');
    expect(await closed(first)).toBe(true);
    expect(second.signal.aborted).toBe(false);

    await requestOn(issuer, 3, 'core.client.lease.release', {
      reason: 'normal_shutdown',
    });
    expect(await closed(second)).toBe(true);
    expect(bystander.signal.aborted).toBe(false);
    expect(issuer.signal.aborted).toBe(false);
  });
});
