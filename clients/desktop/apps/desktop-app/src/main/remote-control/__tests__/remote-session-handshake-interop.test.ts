import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import {
  DEVICE_RELAY_FEATURE_DEVICE_KIND,
  DEVICE_RELAY_SUBPROTOCOL,
  type DeviceRelayDeviceInfo,
  type DeviceRelayTokenResponse,
} from '@canopy/protocol/device-relay';
import {
  HOSTED_DELEGATION_MAX_MS,
  PAIR_PROOF_LABEL,
  RemoteTransportDisconnectedError,
  hostedDelegationSigningBytes,
  type HelloResult,
  type HostedDelegation,
} from '@canopy/protocol/remote-control';
import {
  HANDSHAKE_PROTOCOL,
  HandshakeError,
  HandshakeInitiator,
  HandshakeResponder,
  HostUnsupportedError,
  RelayClient,
  RelayUnsupportedError,
  RemoteControllerConnection,
  RemoteSessionError,
  RemoteSessionManager,
  RpcClosedError,
  RpcPeer,
  computePairProof,
  decodeBase64Url,
  encodeBase64Url,
  exportDeviceIdentityPkcs8,
  generateDeviceIdentity,
  importDeviceIdentityJwk,
  importDeviceIdentityPkcs8,
  isPeerRefusal,
  pairWithHost,
  signHostedDelegation,
  signWithIdentity,
  verifyHostedDelegation,
  type ControllerProfile,
  type DeviceIdentity,
  type HandshakeResult,
  type IncomingSessionAuthorization,
  type RelaySocket,
  type RelaySocketHandlers,
  type SecureSession,
} from '@canopy/remote-session';
import {
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  importDeviceKeyPair,
  type DeviceKeyPair,
} from '../crypto/device-key';
import {
  RemoteSessionManager as DesktopSessionManager,
  type SecureSession as DesktopSecureSession,
  type SessionGrant,
} from '../transport/session-manager';

/** A desktop controller's grant, as the host gives a legacy pin. */
const DESKTOP_GRANT: SessionGrant = {
  kind: 'desktop',
  kindAuthenticated: false,
  rootDeviceId: null,
  expiresAt: null,
};
import {
  RpcPeer as DesktopRpcPeer,
  RpcPublicError,
} from '../transport/rpc-peer';
import { ipcResultCorpus } from './helpers/ipc-result-corpus';
import {
  ManualScheduler,
  MemoryRelayHub,
  flush,
  type MemoryRelayEndpoint,
} from './helpers/remote-session-harness';

/**
 * Handshake, session and controller interop between the portable stack and
 * the desktop's Node implementation, in both directions, over an in-memory
 * relay; plus fixed identity/proof vectors and the lifecycle limits.
 */

const FIXED_PKCS8 =
  '302e020100300506032b6570042204200102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const FIXED_PUBLIC_KEY = 'ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ';
const FIXED_DEVICE_ID = 'ZbYGc9btiEvwHCwiLYKtoA';

function lengthPrefixed(bytes: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength, 0);
  return Buffer.concat([length, bytes]);
}

/** Independent transcript oracle written from the protocol description. */
function oracleTranscript(fields: {
  purpose: string;
  sessionId: Uint8Array;
  initiatorKey: string;
  responderKey: string;
  commitment: string;
  initiatorEphemeral: string;
  initiatorNonce: string;
  responderEphemeral: string;
  responderNonce: string;
}): Buffer {
  const hash = createHash('sha256');
  for (const part of [
    Buffer.from(HANDSHAKE_PROTOCOL),
    Buffer.from(fields.purpose),
    fields.sessionId,
    Buffer.from(fields.initiatorKey, 'base64url'),
    Buffer.from(fields.responderKey, 'base64url'),
    Buffer.from(fields.commitment, 'base64url'),
    Buffer.from(fields.initiatorEphemeral, 'base64url'),
    Buffer.from(fields.initiatorNonce, 'base64url'),
    Buffer.from(fields.responderEphemeral, 'base64url'),
    Buffer.from(fields.responderNonce, 'base64url'),
  ]) {
    hash.update(lengthPrefixed(part));
  }
  return hash.digest();
}

function oracleCommitment(ephemeral: string, nonce: string): string {
  return createHash('sha256')
    .update('commit')
    .update(Buffer.from(ephemeral, 'base64url'))
    .update(Buffer.from(nonce, 'base64url'))
    .digest('base64url');
}

function frameJson(event: { payload: Buffer }): Record<string, unknown> {
  const value: unknown = JSON.parse(
    event.payload.subarray(17).toString('utf8'),
  );
  if (typeof value !== 'object' || value === null)
    throw new Error('Not a JSON object.');
  return Object.fromEntries(Object.entries(value));
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`Missing ${key}.`);
  return value;
}

interface Pair {
  hub: MemoryRelayHub;
  desktopKey: DeviceKeyPair;
  portableIdentity: DeviceIdentity;
  desktopEndpoint: MemoryRelayEndpoint;
  portableEndpoint: MemoryRelayEndpoint;
  desktop: DesktopSessionManager;
  portable: RemoteSessionManager;
  desktopIncoming: DesktopSecureSession[];
  portableIncoming: SecureSession[];
  desktopAllows: { value: boolean };
  portableAuthorizations: IncomingSessionAuthorization[];
}

async function createPair(
  options: {
    portableAuthorize?: (
      request: IncomingSessionAuthorization,
    ) => boolean | Promise<boolean>;
    scheduler?: ManualScheduler;
  } = {},
): Promise<Pair> {
  const hub = new MemoryRelayHub();
  const desktopKey = generateDeviceKeyPair();
  const portableIdentity = await generateDeviceIdentity();
  const desktopEndpoint = hub.endpoint(desktopKey.deviceId);
  const portableEndpoint = hub.endpoint(portableIdentity.deviceId);
  const desktopIncoming: DesktopSecureSession[] = [];
  const portableIncoming: SecureSession[] = [];
  const desktopAllows = { value: true };
  const portableAuthorizations: IncomingSessionAuthorization[] = [];
  const desktop = new DesktopSessionManager({
    transport: desktopEndpoint,
    identity: (): DeviceKeyPair => desktopKey,
    authorize: ({ purpose, initiatorKey }): SessionGrant | null =>
      desktopAllows.value &&
      (purpose === 'pair' || initiatorKey === portableIdentity.publicKey)
        ? DESKTOP_GRANT
        : null,
    onIncomingSession: (session): void => {
      desktopIncoming.push(session);
    },
  });
  const portable = new RemoteSessionManager({
    transport: portableEndpoint,
    identity: (): DeviceIdentity => portableIdentity,
    authorize: (request): boolean | Promise<boolean> => {
      portableAuthorizations.push(request);
      return options.portableAuthorize
        ? options.portableAuthorize(request)
        : request.initiatorKey === desktopKey.publicKey;
    },
    onIncomingSession: (session): void => {
      portableIncoming.push(session);
    },
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  return {
    hub,
    desktopKey,
    portableIdentity,
    desktopEndpoint,
    portableEndpoint,
    desktop,
    portable,
    desktopIncoming,
    portableIncoming,
    desktopAllows,
    portableAuthorizations,
  };
}

async function waitFor<T>(
  read: () => T | undefined,
  label: string,
): Promise<T> {
  // Crypto and compression finish on worker threads. Immediate turns can
  // drain before those workers run on a busy CI host, so bound elapsed time.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function expectSameHandshake(
  portable: HandshakeResult,
  desktop: DesktopSecureSession['handshake'],
): void {
  expect(portable.shortAuthenticationString).toMatch(/^\d{6}$/);
  expect(portable.shortAuthenticationString).toBe(
    desktop.shortAuthenticationString,
  );
  expect(Buffer.from(portable.transcriptHash)).toEqual(desktop.transcriptHash);
  expect(Buffer.from(portable.sendKey)).toEqual(desktop.receiveKey);
  expect(Buffer.from(portable.receiveKey)).toEqual(desktop.sendKey);
  expect(portable.purpose).toBe(desktop.purpose);
}

function echoDesktopPeer(session: DesktopSecureSession): DesktopRpcPeer {
  return new DesktopRpcPeer(session, {
    onRequest: (_method, params): Promise<unknown> => Promise.resolve(params),
    onEvent: (): void => undefined,
  });
}

describe('identity, delegation and proof vectors', () => {
  it('imports desktop PKCS#8 keys non-extractably and derives the same device ID', async () => {
    const identity = await importDeviceIdentityPkcs8(
      Buffer.from(FIXED_PKCS8, 'hex'),
    );
    expect(identity.publicKey).toBe(FIXED_PUBLIC_KEY);
    expect(identity.deviceId).toBe(FIXED_DEVICE_ID);
    expect(identity.privateKey.extractable).toBe(false);
    await expect(exportDeviceIdentityPkcs8(identity)).rejects.toThrow(
      'cannot be exported',
    );
    const desktop = importDeviceKeyPair(Buffer.from(FIXED_PKCS8, 'hex'));
    expect([desktop.publicKey, desktop.deviceId]).toEqual([
      FIXED_PUBLIC_KEY,
      FIXED_DEVICE_ID,
    ]);
    // Ed25519 is deterministic: identical signatures, verifiable by Node.
    const message = Buffer.from('responderx');
    const signature = await signWithIdentity(identity, message);
    expect(Buffer.from(signature)).toEqual(
      sign(null, message, desktop.privateKey),
    );
    const jwk = createPrivateKey({
      key: Buffer.from(FIXED_PKCS8, 'hex'),
      format: 'der',
      type: 'pkcs8',
    }).export({ format: 'jwk' });
    const fromJwk = await importDeviceIdentityJwk({
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      d: jwk.d,
    });
    expect(fromJwk.deviceId).toBe(FIXED_DEVICE_ID);
    const extractable = await generateDeviceIdentity({ extractable: true });
    const exported = await exportDeviceIdentityPkcs8(extractable);
    const roundTrip = importDeviceKeyPair(Buffer.from(exported));
    expect([roundTrip.publicKey, roundTrip.deviceId]).toEqual([
      extractable.publicKey,
      extractable.deviceId,
    ]);
    await expect(
      importDeviceIdentityJwk({
        ...jwk,
        kty: 'OKP',
        crv: 'Ed25519',
        x: FIXED_PUBLIC_KEY,
        d: encodeBase64Url(new Uint8Array(32)),
      }),
    ).rejects.toThrow('does not match');
    expect(Buffer.from(exportDeviceKeyPair(desktop)).toString('hex')).toBe(
      FIXED_PKCS8,
    );
  });

  it('computes the transcript-bound pairing proof', async () => {
    const secret = Buffer.from(
      Array.from({ length: 32 }, (_, index) => 0xa0 + (index % 16)),
    );
    const transcript = createHash('sha256')
      .update('canopy transcript vector')
      .digest();
    expect(await computePairProof(secret, transcript)).toBe(
      '-Ttu8BAHKxQEEt5u8qgPAY_RZm6c_I2tQEb-YoJAxI0',
    );
    await expect(
      computePairProof(new Uint8Array(16), transcript),
    ).rejects.toThrow('32 bytes');
  });

  it('signs and verifies hosted delegations over the protocol signing bytes', async () => {
    const root = await generateDeviceIdentity();
    const session = await generateDeviceIdentity();
    const now = 1_762_560_000_000;
    const delegation = await signHostedDelegation(
      root,
      session.publicKey,
      now + 60_000,
    );
    const rootKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: root.publicKey },
      format: 'jwk',
    });
    expect(
      verify(
        null,
        hostedDelegationSigningBytes(session.publicKey, now + 60_000),
        rootKey,
        Buffer.from(delegation.signature, 'base64url'),
      ),
    ).toBe(true);
    const trusted = (key: string): boolean => key === root.publicKey;
    const check = (
      value: unknown,
      at = now,
      initiatorKey = session.publicKey,
    ): ReturnType<typeof verifyHostedDelegation> =>
      verifyHostedDelegation(value, {
        initiatorKey,
        now: at,
        isTrustedRoot: trusted,
      });
    expect(await check(delegation)).toEqual({
      ok: true,
      rootPublicKey: root.publicKey,
      expiresAt: now + 60_000,
    });
    expect(await check(delegation, now + 60_000)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(await check(delegation, now, root.publicKey)).toEqual({
      ok: false,
      reason: 'session_key_mismatch',
    });
    const far = await signHostedDelegation(
      root,
      session.publicKey,
      now + HOSTED_DELEGATION_MAX_MS + 1,
    );
    expect(await check(far)).toEqual({ ok: false, reason: 'expiry_too_far' });
    expect(
      await verifyHostedDelegation(delegation, {
        initiatorKey: session.publicKey,
        now,
        isTrustedRoot: () => false,
      }),
    ).toEqual({ ok: false, reason: 'root_not_trusted' });
    const forged = { ...delegation, expiresAt: now + 61_000 };
    expect(await check(forged)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(await check({ ...delegation, signature: 'short' })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('handshake interop with the desktop', () => {
  it('portable initiator ↔ desktop responder: same SAS, transcript and keys; RPC both ways', async () => {
    const pair = await createPair();
    const session = await pair.portable.connect({
      peerDeviceId: pair.desktopKey.deviceId,
      purpose: 'control',
      pinnedPeerPublicKey: pair.desktopKey.publicKey,
    });
    const desktopSession = await waitFor(
      () => pair.desktopIncoming[0],
      'desktop session',
    );
    expectSameHandshake(session.handshake, desktopSession.handshake);
    expect(session.peerDeviceId).toBe(pair.desktopKey.deviceId);
    expect(desktopSession.handshake.peerPublicKey).toBe(
      pair.portableIdentity.publicKey,
    );
    // The transcript matches an independent oracle over the observed hellos,
    // and both role-prefixed signatures verify under Node.
    const hello1 = frameJson(
      pair.portableEndpoint.sent[0] ?? { payload: Buffer.alloc(0) },
    );
    const hello2 = frameJson(
      pair.desktopEndpoint.sent[0] ?? { payload: Buffer.alloc(0) },
    );
    const hello3 = frameJson(
      pair.portableEndpoint.sent[1] ?? { payload: Buffer.alloc(0) },
    );
    const hello4 = frameJson(
      pair.desktopEndpoint.sent[1] ?? { payload: Buffer.alloc(0) },
    );
    const transcript = oracleTranscript({
      purpose: 'control',
      sessionId: session.sessionId,
      initiatorKey: stringField(hello1, 'initiatorKey'),
      responderKey: stringField(hello2, 'responderKey'),
      commitment: stringField(hello1, 'commitment'),
      initiatorEphemeral: stringField(hello3, 'ephemeral'),
      initiatorNonce: stringField(hello3, 'nonce'),
      responderEphemeral: stringField(hello2, 'ephemeral'),
      responderNonce: stringField(hello2, 'nonce'),
    });
    expect(Buffer.from(session.handshake.transcriptHash)).toEqual(transcript);
    expect(stringField(hello1, 'commitment')).toBe(
      oracleCommitment(
        stringField(hello3, 'ephemeral'),
        stringField(hello3, 'nonce'),
      ),
    );
    const portableKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: pair.portableIdentity.publicKey },
      format: 'jwk',
    });
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from('initiator'), transcript]),
        portableKey,
        Buffer.from(stringField(hello3, 'signature'), 'base64url'),
      ),
    ).toBe(true);
    const desktopKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: pair.desktopKey.publicKey },
      format: 'jwk',
    });
    expect(
      verify(
        null,
        Buffer.concat([Buffer.from('responder'), transcript]),
        desktopKey,
        Buffer.from(stringField(hello4, 'signature'), 'base64url'),
      ),
    ).toBe(true);

    // Concurrent RPC in both directions over one session, including large
    // compressed multi-fragment messages and the allowlisted IPC corpus.
    const respond = (method: string, params: unknown): Promise<unknown> => {
      if (method === 'typed-refusal') {
        return Promise.reject(
          Object.assign(new RpcPublicError('Safe refusal.'), {
            operationFailure: {
              status: 'unavailable',
              code: 'private-provider-detail',
              effects: { diagnostic: 'private-provider-detail' },
              retry: {
                kind: 'after_refresh',
                resource: 'private-provider-detail',
                delayMs: 12,
              },
            },
          }),
        );
      }
      if (method === 'legacy-refusal') {
        return Promise.reject(new RpcPublicError('Legacy refusal.'));
      }
      return Promise.resolve({ method, params });
    };
    const desktopEvents: unknown[] = [];
    const desktopPeer = new DesktopRpcPeer(desktopSession, {
      onRequest: respond,
      onEvent: (name, payload): void => {
        desktopEvents.push([name, payload]);
      },
    });
    const portableEvents: unknown[] = [];
    const portablePeer = new RpcPeer(session, {
      onRequest: respond,
      onEvent: (name, payload): void => {
        portableEvents.push([name, payload]);
      },
    });
    // New peers preserve only portable retry advice. Legacy refusals remain
    // readable in both directions without requiring the optional field.
    for (const peer of [desktopPeer, portablePeer]) {
      const refusal: unknown = await peer
        .request('typed-refusal', {})
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({
        message: 'Safe refusal.',
        operationFailure: {
          status: 'unavailable',
          retry: { kind: 'after_refresh', delayMs: 12 },
        },
      });
      expect(JSON.stringify(refusal)).not.toContain('private-provider-detail');
      await expect(peer.request('legacy-refusal', {})).rejects.toMatchObject({
        message: 'Legacy refusal.',
        operationFailure: undefined,
      });
    }
    const corpus = ipcResultCorpus().map((entry) => entry.value);
    const big = {
      text: 'compressible line\n'.repeat(30_000),
      bytes: new Uint8Array(randomBytes(150_000)),
    };
    const payloads = [...corpus, big, ...corpus, big];
    const results = await Promise.all([
      ...payloads.map((params, index) =>
        portablePeer.request(`p${index}`, params),
      ),
      ...payloads.map((params, index) =>
        desktopPeer.request(`d${index}`, params),
      ),
    ]);
    results.forEach((result, index) => {
      const local = index < payloads.length;
      const position = local ? index : index - payloads.length;
      expect(result).toEqual({
        method: `${local ? 'p' : 'd'}${position}`,
        params: payloads[position],
      });
    });
    for (let index = 0; index < 20; index += 1) {
      portablePeer.notify('ev', index);
      desktopPeer.notify('ev', index);
    }
    await waitFor(
      () =>
        desktopEvents.length === 20 && portableEvents.length === 20
          ? true
          : undefined,
      'events',
    );
    // Events arrive in send order on each side.
    expect(desktopEvents).toEqual(
      Array.from({ length: 20 }, (_, index) => ['ev', index]),
    );
    expect(portableEvents).toEqual(
      Array.from({ length: 20 }, (_, index) => ['ev', index]),
    );
    portablePeer.close();
    await waitFor(
      () => (desktopPeer.isClosed ? true : undefined),
      'desktop close',
    );
    pair.desktop.dispose();
    pair.portable.dispose();
  });

  it('desktop initiator ↔ portable responder, for control and pair sessions', async () => {
    const pair = await createPair();
    for (const purpose of ['control', 'pair'] as const) {
      const desktopSession = await pair.desktop.connect({
        peerDeviceId: pair.portableIdentity.deviceId,
        purpose,
        pinnedPeerPublicKey:
          purpose === 'control' ? pair.portableIdentity.publicKey : null,
      });
      const portableSession = await waitFor(
        () =>
          pair.portableIncoming.find(
            (candidate) => candidate.purpose === purpose,
          ),
        `${purpose} session`,
      );
      expectSameHandshake(portableSession.handshake, desktopSession.handshake);
      const desktopPeer = echoDesktopPeer(desktopSession);
      const portablePeer = new RpcPeer(portableSession, {
        onRequest: (_method, params): Promise<unknown> =>
          Promise.resolve(params),
        onEvent: (): void => undefined,
      });
      const value = { purpose, at: new Date(0), list: [1, 'two', null] };
      expect(await desktopPeer.request('echo', value)).toEqual(value);
      expect(await portablePeer.request('echo', value)).toEqual(value);
      desktopPeer.close();
      await waitFor(
        () => (portablePeer.isClosed ? true : undefined),
        'portable close',
      );
    }
    // Both authorization checks ran for each session, the second with the transcript.
    expect(
      pair.portableAuthorizations.map((request) => [
        request.stage,
        request.purpose,
        request.transcriptHash !== null,
      ]),
    ).toEqual([
      ['hello1', 'control', false],
      ['hello3', 'control', true],
      ['hello1', 'pair', false],
      ['hello3', 'pair', true],
    ]);
    pair.desktop.dispose();
    pair.portable.dispose();
  });

  it('pair sessions from the portable side, with a hello1 delegation an older desktop ignores', async () => {
    const pair = await createPair();
    const root = await generateDeviceIdentity();
    const delegation = await signHostedDelegation(
      root,
      pair.portableIdentity.publicKey,
      Date.now() + 60_000,
    );
    const session = await pair.portable.connect({
      peerDeviceId: pair.desktopKey.deviceId,
      purpose: 'pair',
      pinnedPeerPublicKey: null,
      delegation,
    });
    const desktopSession = await waitFor(
      () => pair.desktopIncoming[0],
      'desktop session',
    );
    expectSameHandshake(session.handshake, desktopSession.handshake);
    expect(session.handshake.delegation).toEqual(delegation);
    expect(
      frameJson(pair.portableEndpoint.sent[0] ?? { payload: Buffer.alloc(0) })
        .delegation,
    ).toEqual(delegation);
    pair.desktop.dispose();
    pair.portable.dispose();
  });

  it('refuses a mismatched pin and an unauthorized initiator', async () => {
    const pair = await createPair();
    const other = generateDeviceKeyPair();
    const mismatch: unknown = await pair.portable
      .connect({
        peerDeviceId: pair.desktopKey.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: other.publicKey,
      })
      .catch((error: unknown) => error);
    expect(mismatch).toMatchObject({ code: 'peer_key_mismatch' });
    // A wrong pin is this side's refusal, not the host forgetting this device.
    expect(isPeerRefusal(mismatch)).toBe(false);
    pair.desktopAllows.value = false;
    const refused: unknown = await pair.portable
      .connect({
        peerDeviceId: pair.desktopKey.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: pair.desktopKey.publicKey,
      })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      name: 'HandshakeError',
      code: 'unauthorized_peer',
    });
    // Browsers report this as "pair again" instead of retrying.
    expect(isPeerRefusal(refused)).toBe(true);
    await flush();
    expect(pair.portable.counts).toEqual({
      sessions: 0,
      initiators: 0,
      responders: 0,
    });
    pair.desktop.dispose();
    pair.portable.dispose();
  });

  it('maps degenerate X25519 keys to weak_key on both handshake roles', async () => {
    const desktopKey = importDeviceKeyPair(Buffer.from(FIXED_PKCS8, 'hex'));
    const portableIdentity = await generateDeviceIdentity();
    const lowOrderPoints = [
      new Uint8Array(32),
      Uint8Array.of(1, ...new Uint8Array(31)),
    ];
    for (const point of lowOrderPoints) {
      const weak = encodeBase64Url(point);
      const nonce = encodeBase64Url(new Uint8Array(randomBytes(32)));
      // Responder role: a signed hello3 carrying a low-order ephemeral key.
      const sessionId = new Uint8Array(randomBytes(16));
      const responder = await HandshakeResponder.create({
        sessionId,
        identity: portableIdentity,
        peerDeviceId: desktopKey.deviceId,
        authorize: () => true,
      });
      const commitment = oracleCommitment(weak, nonce);
      const hello2 = await responder.receiveHello1({
        protocol: HANDSHAKE_PROTOCOL,
        purpose: 'control',
        initiatorKey: desktopKey.publicKey,
        commitment,
      });
      const transcript = oracleTranscript({
        purpose: 'control',
        sessionId,
        initiatorKey: desktopKey.publicKey,
        responderKey: hello2.responderKey,
        commitment,
        initiatorEphemeral: weak,
        initiatorNonce: nonce,
        responderEphemeral: hello2.ephemeral,
        responderNonce: hello2.nonce,
      });
      const signature = sign(
        null,
        Buffer.concat([Buffer.from('initiator'), transcript]),
        desktopKey.privateKey,
      ).toString('base64url');
      await expect(
        responder.receiveHello3({ ephemeral: weak, nonce, signature }),
      ).rejects.toMatchObject({
        name: 'HandshakeError',
        code: 'weak_key',
      });
      // Initiator role: a correctly signed hello4 after a low-order hello2.
      const initiatorSession = new Uint8Array(randomBytes(16));
      const initiator = await HandshakeInitiator.create({
        sessionId: initiatorSession,
        purpose: 'control',
        identity: portableIdentity,
        peerDeviceId: desktopKey.deviceId,
        pinnedPeerPublicKey: desktopKey.publicKey,
      });
      const hello1 = await initiator.start();
      const hello3 = await initiator.receiveHello2({
        responderKey: desktopKey.publicKey,
        ephemeral: weak,
        nonce,
      });
      const initiatorTranscript = oracleTranscript({
        purpose: 'control',
        sessionId: initiatorSession,
        initiatorKey: portableIdentity.publicKey,
        responderKey: desktopKey.publicKey,
        commitment: hello1.commitment,
        initiatorEphemeral: hello3.ephemeral,
        initiatorNonce: hello3.nonce,
        responderEphemeral: weak,
        responderNonce: nonce,
      });
      const hello4Signature = sign(
        null,
        Buffer.concat([Buffer.from('responder'), initiatorTranscript]),
        desktopKey.privateKey,
      ).toString('base64url');
      await expect(
        initiator.receiveHello4({ signature: hello4Signature }),
      ).rejects.toBeInstanceOf(HandshakeError);
      await expect(
        initiator.receiveHello4({ signature: hello4Signature }),
      ).rejects.toMatchObject({ code: 'unexpected_message' });
    }
    // A fresh initiator surfaces the weak_key code itself.
    const sessionId = new Uint8Array(randomBytes(16));
    const initiator = await HandshakeInitiator.create({
      sessionId,
      purpose: 'pair',
      identity: portableIdentity,
      peerDeviceId: desktopKey.deviceId,
      pinnedPeerPublicKey: null,
    });
    const hello1 = await initiator.start();
    const nonce = encodeBase64Url(new Uint8Array(randomBytes(32)));
    const weak = encodeBase64Url(new Uint8Array(32));
    const hello3 = await initiator.receiveHello2({
      responderKey: desktopKey.publicKey,
      ephemeral: weak,
      nonce,
    });
    const transcript = oracleTranscript({
      purpose: 'pair',
      sessionId,
      initiatorKey: portableIdentity.publicKey,
      responderKey: desktopKey.publicKey,
      commitment: hello1.commitment,
      initiatorEphemeral: hello3.ephemeral,
      initiatorNonce: hello3.nonce,
      responderEphemeral: weak,
      responderNonce: nonce,
    });
    const signature = sign(
      null,
      Buffer.concat([Buffer.from('responder'), transcript]),
      desktopKey.privateKey,
    ).toString('base64url');
    await expect(initiator.receiveHello4({ signature })).rejects.toMatchObject({
      code: 'weak_key',
    });
  });
});

describe('delegated handshakes between the two authorization checks', () => {
  async function delegatedSetup(
    authorizeAt: (
      request: IncomingSessionAuthorization,
      state: { now: number; roots: Set<string> },
    ) => void,
  ): Promise<{
    hostManager: RemoteSessionManager;
    controller: RemoteSessionManager;
    connect: () => Promise<SecureSession>;
    verdicts: unknown[];
    delegation: HostedDelegation;
    host: DeviceIdentity;
  }> {
    const hub = new MemoryRelayHub();
    const host = await generateDeviceIdentity();
    const root = await generateDeviceIdentity();
    const sessionIdentity = await generateDeviceIdentity();
    const state = { now: 1_762_560_000_000, roots: new Set([root.publicKey]) };
    const verdicts: unknown[] = [];
    const hostManager = new RemoteSessionManager({
      transport: hub.endpoint(host.deviceId),
      identity: (): DeviceIdentity => host,
      authorize: async (request): Promise<boolean> => {
        const verdict = await verifyHostedDelegation(request.delegation, {
          initiatorKey: request.initiatorKey,
          now: state.now,
          isTrustedRoot: (key): boolean => state.roots.has(key),
        });
        verdicts.push([request.stage, verdict.ok ? 'ok' : verdict.reason]);
        authorizeAt(request, state);
        return verdict.ok;
      },
    });
    const controller = new RemoteSessionManager({
      transport: hub.endpoint(sessionIdentity.deviceId),
      identity: (): DeviceIdentity => sessionIdentity,
    });
    const delegation = await signHostedDelegation(
      root,
      sessionIdentity.publicKey,
      state.now + 60_000,
    );
    const connect = (): Promise<SecureSession> =>
      controller.connect({
        peerDeviceId: host.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: host.publicKey,
        delegation,
      });
    return {
      hostManager,
      controller,
      connect,
      verdicts,
      delegation,
      host,
    };
  }

  it('accepts a valid delegation at both checks', async () => {
    const setup = await delegatedSetup(() => undefined);
    const session = await setup.connect();
    expect(session.handshake.delegation).toEqual(setup.delegation);
    expect(setup.verdicts).toEqual([
      ['hello1', 'ok'],
      ['hello3', 'ok'],
    ]);
    setup.controller.dispose();
    setup.hostManager.dispose();
  });

  it('refuses at hello3 when the delegation expires after hello1', async () => {
    const setup = await delegatedSetup((request, state) => {
      if (request.stage === 'hello1') state.now += 60_000;
    });
    await expect(setup.connect()).rejects.toMatchObject({
      code: 'unauthorized_peer',
    });
    expect(setup.verdicts).toEqual([
      ['hello1', 'ok'],
      ['hello3', 'expired'],
    ]);
    expect(setup.hostManager.counts).toEqual({
      sessions: 0,
      initiators: 0,
      responders: 0,
    });
    setup.controller.dispose();
    setup.hostManager.dispose();
  });

  it('refuses at hello3 when the root is revoked after hello1', async () => {
    const setup = await delegatedSetup((request, state) => {
      if (request.stage === 'hello1') state.roots.clear();
    });
    await expect(setup.connect()).rejects.toMatchObject({
      code: 'unauthorized_peer',
    });
    expect(setup.verdicts).toEqual([
      ['hello1', 'ok'],
      ['hello3', 'root_not_trusted'],
    ]);
    setup.controller.dispose();
    setup.hostManager.dispose();
  });

  it('refuses before hello2 without a delegation or for another session key', async () => {
    const setup = await delegatedSetup(() => undefined);
    await expect(
      setup.controller.connect({
        peerDeviceId: setup.host.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: setup.host.publicKey,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized_peer' });
    const otherSession = await generateDeviceIdentity();
    const misbound = {
      ...setup.delegation,
      sessionPublicKey: otherSession.publicKey,
    };
    await expect(
      setup.controller.connect({
        peerDeviceId: setup.host.deviceId,
        purpose: 'control',
        pinnedPeerPublicKey: setup.host.publicKey,
        delegation: misbound,
      }),
    ).rejects.toMatchObject({ code: 'unauthorized_peer' });
    expect(setup.verdicts).toEqual([
      ['hello1', 'malformed'],
      ['hello1', 'session_key_mismatch'],
    ]);
    setup.controller.dispose();
    setup.hostManager.dispose();
  });
});

describe('encrypted session integrity and lifecycle', () => {
  async function establish(scheduler?: ManualScheduler): Promise<{
    pair: Pair;
    session: SecureSession;
    desktopSession: DesktopSecureSession;
    desktopPeer: DesktopRpcPeer;
    portablePeer: RpcPeer;
  }> {
    const pair = await createPair(scheduler ? { scheduler } : {});
    const session = await pair.portable.connect({
      peerDeviceId: pair.desktopKey.deviceId,
      purpose: 'control',
      pinnedPeerPublicKey: pair.desktopKey.publicKey,
    });
    const desktopSession = await waitFor(
      () => pair.desktopIncoming[0],
      'desktop session',
    );
    const desktopPeer = echoDesktopPeer(desktopSession);
    const portablePeer = new RpcPeer(session, {
      onRequest: (_method, params): Promise<unknown> => Promise.resolve(params),
      onEvent: (): void => undefined,
      ...(scheduler ? { scheduler } : {}),
    });
    return { pair, session, desktopSession, desktopPeer, portablePeer };
  }

  const dataFrom =
    (from: string) =>
    (event: { from: string; payload: Buffer }): boolean =>
      event.from === from && event.payload[0] === 0x20;

  it('closes on a tampered frame and fails pending requests without retrying', async () => {
    const { pair, session, desktopSession, portablePeer } = await establish();
    let tampered = false;
    pair.hub.filter = (event): Buffer[] => {
      if (!tampered && dataFrom(pair.desktopKey.deviceId)(event)) {
        tampered = true;
        const copy = Buffer.from(event.payload);
        copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1;
        return [copy];
      }
      return [event.payload];
    };
    await expect(portablePeer.request('echo', { n: 1 })).rejects.toBeInstanceOf(
      RpcClosedError,
    );
    expect(session.closeReason).toBe('protocol_error');
    await waitFor(
      () => (desktopSession.isClosed ? true : undefined),
      'desktop abort',
    );
    const requests = pair.portableEndpoint.sent.filter(
      dataFrom(pair.portableIdentity.deviceId),
    );
    expect(requests).toHaveLength(1);
    pair.desktop.dispose();
    pair.portable.dispose();
  });

  it('closes on a replayed frame and on a gap', async () => {
    for (const mode of ['replay', 'gap'] as const) {
      const { pair, session, desktopPeer, portablePeer } = await establish();
      expect(await portablePeer.request('warmup', 1)).toBe(1);
      let applied = false;
      pair.hub.filter = (event): Buffer[] => {
        if (!applied && dataFrom(pair.desktopKey.deviceId)(event)) {
          applied = true;
          return mode === 'replay' ? [event.payload, event.payload] : [];
        }
        return [event.payload];
      };
      desktopPeer.notify('first', 1);
      desktopPeer.notify('second', 2);
      await waitFor(
        () => (session.isClosed ? true : undefined),
        `${mode} close`,
      );
      expect(session.closeReason).toBe('protocol_error');
      pair.desktop.dispose();
      pair.portable.dispose();
    }
  });

  it('cleans up handshakes, admissions and idle sessions on timeouts', async () => {
    const scheduler = new ManualScheduler();
    const hub = new MemoryRelayHub();
    const identity = await generateDeviceIdentity();
    const silent = generateDeviceKeyPair();
    hub.endpoint(silent.deviceId);
    const manager = new RemoteSessionManager({
      transport: hub.endpoint(identity.deviceId),
      identity: (): DeviceIdentity => identity,
      authorize: (): boolean => true,
      scheduler,
    });
    const attempts = Array.from({ length: 4 }, () =>
      manager.connect({
        peerDeviceId: silent.deviceId,
        purpose: 'pair',
        pinnedPeerPublicKey: null,
      }),
    );
    await expect(
      manager.connect({
        peerDeviceId: silent.deviceId,
        purpose: 'pair',
        pinnedPeerPublicKey: null,
      }),
    ).rejects.toMatchObject({ code: 'admission_refused' });
    await flush();
    scheduler.advance(15_000);
    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        code: 'handshake_timeout',
      });
    }
    expect(manager.counts).toEqual({
      sessions: 0,
      initiators: 0,
      responders: 0,
    });
    expect(scheduler.pending).toBe(0);
    manager.dispose();

    // An idle session closes after 45 s without inbound traffic, failing its requests.
    const { pair, session, portablePeer } = await establish(scheduler);
    pair.hub.filter = (event): Buffer[] =>
      event.from === pair.desktopKey.deviceId ? [] : [event.payload];
    const pending = portablePeer.request('never-answered', null, {
      timeoutMs: null,
    });
    await flush();
    scheduler.advance(60_000);
    await expect(pending).rejects.toMatchObject({ reason: 'timeout' });
    expect(session.closeReason).toBe('timeout');
    expect(scheduler.pending).toBe(0);
    pair.desktop.dispose();
    pair.portable.dispose();
  });
});

describe('relay client', () => {
  interface FakeSocket {
    url: string;
    protocols: string[];
    handlers: RelaySocketHandlers;
    sent: Array<string | Uint8Array>;
    closed: boolean;
  }

  interface RelayHarness {
    scheduler: ManualScheduler;
    sockets: FakeSocket[];
    minted: string[];
    client: RelayClient;
    ready: (
      socket: FakeSocket,
      features: string[] | undefined,
      peers?: DeviceRelayDeviceInfo[],
    ) => void;
    failWith: (error: Error | null) => void;
  }

  function relayHarness(
    options: {
      retryable?: boolean;
      onRelayError?: (code: string, message: string) => void;
    } = {},
  ): RelayHarness {
    const scheduler = new ManualScheduler();
    const sockets: FakeSocket[] = [];
    const minted: string[] = [];
    let failMint: Error | null = null;
    const device = {
      deviceId: FIXED_DEVICE_ID,
      name: 'Browser',
      platform: 'darwin' as const,
      appVersion: '1.0.0',
      publicKey: FIXED_PUBLIC_KEY,
      acceptsRemoteControl: false,
    };
    const client = new RelayClient({
      kind: 'browser',
      scheduler,
      mintToken: async (kind): Promise<DeviceRelayTokenResponse> => {
        await Promise.resolve();
        if (failMint) throw failMint;
        const token = `token-${minted.length + 1}`;
        minted.push(`${kind}:${token}`);
        return {
          token,
          relayUrl: 'wss://relay.example/ignored',
          expiresAt: new Date(scheduler.now() + 600_000).toISOString(),
        };
      },
      deviceInfo: (): typeof device => device,
      createSocket: (url, protocols, handlers): RelaySocket => {
        const socket: FakeSocket = {
          url,
          protocols,
          handlers,
          sent: [],
          closed: false,
        };
        sockets.push(socket);
        return {
          bufferedAmount: 0,
          transmit: (data): void => {
            socket.sent.push(data);
          },
          close: (): void => {
            socket.closed = true;
          },
        };
      },
      isRetryableTokenError: (): boolean => options.retryable ?? true,
      onRelayError: options.onRelayError,
    });
    const ready = (
      socket: FakeSocket,
      features: string[] | undefined,
      peers: DeviceRelayDeviceInfo[] = [],
    ): void => {
      socket.handlers.onOpen();
      socket.handlers.onText(
        JSON.stringify({
          type: 'ready',
          deviceId: FIXED_DEVICE_ID,
          peers,
          ...(features ? { features } : {}),
        }),
      );
    };
    return {
      scheduler,
      sockets,
      minted,
      client,
      ready,
      failWith: (error: Error | null): void => {
        failMint = error;
      },
    };
  }

  const peer: DeviceRelayDeviceInfo = {
    deviceId: 'AAAAAAAAAAAAAAAAAAAAAA',
    name: 'Host',
    platform: 'darwin',
    kind: 'desktop',
    appVersion: '1.0.0',
    publicKey: FIXED_PUBLIC_KEY,
    acceptsRemoteControl: true,
  };

  it('mints a fresh token for every connection and requires device-kind', async () => {
    const harness = relayHarness();
    const offline: string[] = [];
    harness.client.onPeerOffline((deviceId) => offline.push(deviceId));
    harness.client.start();
    await flush();
    const first = harness.sockets[0];
    if (!first) throw new Error('No socket.');
    expect(first.url).toBe('wss://relay.example/v2/connect');
    expect(first.protocols).toEqual([
      DEVICE_RELAY_SUBPROTOCOL,
      'canopy-relay-token.token-1',
    ]);
    harness.ready(first, [DEVICE_RELAY_FEATURE_DEVICE_KIND], [peer]);
    expect(JSON.parse(String(first.sent[0]))).toMatchObject({
      type: 'hello',
      device: { kind: 'browser', deviceId: FIXED_DEVICE_ID },
    });
    expect(harness.client.connectionStatus).toBe('connected');
    expect(harness.client.peers).toEqual([peer]);
    expect(harness.client.sendFrame(peer.deviceId, new Uint8Array(20))).toBe(
      true,
    );
    first.handlers.onClose();
    expect(offline).toEqual([peer.deviceId]);
    expect(harness.client.sendFrame(peer.deviceId, new Uint8Array(20))).toBe(
      false,
    );
    harness.scheduler.advance(500);
    await flush();
    const second = harness.sockets[1];
    if (!second) throw new Error('No reconnect.');
    expect(second.protocols).toEqual([
      DEVICE_RELAY_SUBPROTOCOL,
      'canopy-relay-token.token-2',
    ]);
    expect(harness.minted).toEqual(['browser:token-1', 'browser:token-2']);
    // A relay that does not advertise device-kind stops the client.
    harness.ready(second, ['something-else']);
    expect(harness.client.connectionStatus).toBe('unsupported');
    expect(harness.client.lastError).toBeInstanceOf(RelayUnsupportedError);
    expect(second.closed).toBe(true);
    harness.scheduler.advance(120_000);
    await flush();
    expect(harness.sockets).toHaveLength(2);
    expect(harness.minted).toHaveLength(2);
  });

  it('reports relay errors such as the account device cap, then retries at the longest backoff', async () => {
    const errors: string[] = [];
    const harness = relayHarness({
      onRelayError: (code) => errors.push(code),
    });
    harness.client.start();
    await flush();
    const first = harness.sockets[0];
    if (!first) throw new Error('No socket.');
    first.handlers.onOpen();
    first.handlers.onText(
      JSON.stringify({
        type: 'error',
        code: 'too_many_devices',
        message: 'An account can connect at most 32 devices at once.',
      }),
    );
    first.handlers.onClose();
    expect(errors).toEqual(['too_many_devices']);
    expect(harness.client.connectionStatus).toBe('reconnecting');
    // Contested: no new attempt before half the longest backoff.
    harness.scheduler.advance(14_000);
    await flush();
    expect(harness.sockets).toHaveLength(1);
    harness.scheduler.advance(16_000);
    await flush();
    expect(harness.sockets).toHaveLength(2);
    expect(harness.minted).toHaveLength(2);
    harness.client.stop();
  });

  it('reconnects when ready never arrives and stops on a permanent token refusal', async () => {
    const harness = relayHarness();
    harness.client.start();
    await flush();
    harness.scheduler.advance(15_000);
    expect(harness.sockets[0]?.closed).toBe(true);
    harness.scheduler.advance(1_000);
    await flush();
    expect(harness.sockets).toHaveLength(2);
    harness.client.stop();
    const refused = relayHarness({ retryable: false });
    refused.failWith(new Error('entitlement_denied'));
    refused.client.start();
    await flush();
    expect(refused.client.connectionStatus).toBe('failed');
    expect(refused.client.lastError?.message).toBe('entitlement_denied');
    refused.scheduler.advance(120_000);
    await flush();
    expect(refused.sockets).toHaveLength(0);
  });
});

describe('controller connection and pairing against a desktop host', () => {
  interface HostOptions {
    features?: HelloResult['features'];
    servesPairHello?: boolean;
    pairingSecret?: Buffer;
  }

  interface HostHarness {
    scheduler: ManualScheduler;
    hostKey: DeviceKeyPair;
    controllerIdentity: DeviceIdentity;
    invokes: Array<{ channel: string; args: unknown[] }>;
    sends: unknown[];
    hellos: unknown[];
    revokes: number[];
    pairRequests: Array<{
      params: Record<string, unknown>;
      transcript: Buffer;
      sas: string;
    }>;
    hostPeers: DesktopRpcPeer[];
    hub: MemoryRelayHub;
    host: DesktopSessionManager;
    controllerSessions: RemoteSessionManager;
    profile: ControllerProfile;
    releaseSlow: () => void;
  }

  async function hostHarness(options: HostOptions = {}): Promise<HostHarness> {
    const scheduler = new ManualScheduler();
    const hub = new MemoryRelayHub();
    const hostKey = generateDeviceKeyPair();
    const controllerIdentity = await generateDeviceIdentity();
    const invokes: Array<{ channel: string; args: unknown[] }> = [];
    const sends: unknown[] = [];
    const hellos: unknown[] = [];
    const revokes: number[] = [];
    const pairRequests: Array<{
      params: Record<string, unknown>;
      transcript: Buffer;
      sas: string;
    }> = [];
    const hostPeers: DesktopRpcPeer[] = [];
    let release: (() => void) | null = null;
    const hello = (): HelloResult => ({
      name: 'Host',
      platform: 'darwin',
      appVersion: '9.9.9',
      version: { protocolVersion: 17, appVersion: '9.9.9' },
      ...(options.features ? { features: options.features } : {}),
    });
    const host = new DesktopSessionManager({
      transport: hub.endpoint(hostKey.deviceId),
      identity: (): DeviceKeyPair => hostKey,
      authorize: ({ purpose, initiatorKey }): SessionGrant | null =>
        purpose === 'pair' || initiatorKey === controllerIdentity.publicKey
          ? DESKTOP_GRANT
          : null,
      onIncomingSession: (session): void => {
        const peer = new DesktopRpcPeer(session, {
          onEvent: (name, payload): void => {
            sends.push([name, payload]);
          },
          onRequest: async (method, params): Promise<unknown> => {
            if (
              method === 'session.hello' &&
              (session.purpose === 'control' || options.servesPairHello)
            ) {
              hellos.push(params);
              return hello();
            }
            if (method === 'pair.request' && session.purpose === 'pair') {
              const record =
                typeof params === 'object' && params !== null
                  ? Object.fromEntries(Object.entries(params))
                  : {};
              pairRequests.push({
                params: record,
                transcript: session.handshake.transcriptHash,
                sas: session.handshake.shortAuthenticationString,
              });
              const secret = options.pairingSecret;
              const expected = secret
                ? createHmac('sha256', secret)
                    .update(
                      Buffer.concat([
                        Buffer.from(PAIR_PROOF_LABEL),
                        session.handshake.transcriptHash,
                      ]),
                    )
                    .digest('base64url')
                : null;
              return {
                approved: expected === null || record.proof === expected,
                name: 'Host',
                platform: 'darwin',
              };
            }
            if (method === 'pair.revoke' && session.purpose === 'control') {
              revokes.push(Date.now());
              // As the desktop: the session ends once the answer is out.
              setImmediate(() => peer.close('revoked'));
              return { revoked: true };
            }
            if (method === 'ipc.invoke' && session.purpose === 'control') {
              const call =
                typeof params === 'object' && params !== null
                  ? Object.fromEntries(Object.entries(params))
                  : {};
              const channel = String(call.channel);
              const args = Array.isArray(call.args) ? call.args : [];
              invokes.push({ channel, args });
              if (channel === 'slow') {
                await new Promise<void>((resolve) => {
                  release = resolve;
                });
              }
              return { channel, args };
            }
            throw new RpcPublicError(`Unknown remote method ${method}.`);
          },
        });
        hostPeers.push(peer);
      },
    });
    const controllerSessions = new RemoteSessionManager({
      transport: hub.endpoint(controllerIdentity.deviceId),
      identity: (): DeviceIdentity => controllerIdentity,
      scheduler,
    });
    const profile: ControllerProfile = {
      kind: 'browser',
      version: { protocolVersion: 17, appVersion: '1.0.0' },
      minVersion: 17,
    };
    return {
      scheduler,
      revokes,
      hostKey,
      controllerIdentity,
      invokes,
      sends,
      hellos,
      pairRequests,
      hostPeers,
      hub,
      host,
      controllerSessions,
      profile,
      releaseSlow: (): void => release?.(),
    };
  }

  const fullFeatures = {
    controllerProfiles: true,
    pairingProof: true,
    hostedDelegation: true,
  };

  it('refuses a host without controller profiles and never retries with another version', async () => {
    const harness = await hostHarness();
    const statuses: string[] = [];
    const connection = new RemoteControllerConnection({
      sessions: harness.controllerSessions,
      host: {
        deviceId: harness.hostKey.deviceId,
        publicKey: harness.hostKey.publicKey,
      },
      controller: harness.profile,
      scheduler: harness.scheduler,
      onStatusChange: (status): void => {
        statuses.push(status);
      },
    });
    const refusal = connection.connect();
    await expect(refusal).rejects.toBeInstanceOf(HostUnsupportedError);
    await expect(refusal).rejects.toMatchObject({
      code: 'host_unsupported',
      missing: ['controllerProfiles'],
    });
    expect(harness.hellos).toEqual([
      {
        version: { protocolVersion: 17, appVersion: '1.0.0' },
        controller: { kind: 'browser', minVersion: 17 },
        secretRequestSettleReason: true,
      },
    ]);
    harness.scheduler.advance(120_000);
    await flush();
    expect(harness.hellos).toHaveLength(1);
    expect(connection.status).toBe('error');
    await expect(
      connection.transport.invoke('projects:load'),
    ).rejects.toMatchObject({ code: 'not_connected' });
    expect(harness.invokes).toHaveLength(0);
    harness.controllerSessions.dispose();
    harness.host.dispose();
  });

  it('requires hostedDelegation when a delegation is sent', async () => {
    const harness = await hostHarness({
      features: {
        controllerProfiles: true,
        pairingProof: true,
        hostedDelegation: false,
      },
    });
    const root = await generateDeviceIdentity();
    const delegation = await signHostedDelegation(
      root,
      harness.controllerIdentity.publicKey,
      harness.scheduler.now() + 60_000,
    );
    const connection = new RemoteControllerConnection({
      sessions: harness.controllerSessions,
      host: {
        deviceId: harness.hostKey.deviceId,
        publicKey: harness.hostKey.publicKey,
      },
      controller: { ...harness.profile, kind: 'hosted' },
      delegation,
      scheduler: harness.scheduler,
    });
    await expect(connection.connect()).rejects.toMatchObject({
      missing: ['hostedDelegation'],
    });
    harness.controllerSessions.dispose();
    harness.host.dispose();
  });

  it('revokes its own pairing only on a host that advertises pair.revoke', async () => {
    const without = await hostHarness({
      features: {
        controllerProfiles: true,
        pairingProof: true,
        hostedDelegation: true,
      },
    });
    const old = new RemoteControllerConnection({
      sessions: without.controllerSessions,
      host: {
        deviceId: without.hostKey.deviceId,
        publicKey: without.hostKey.publicKey,
      },
      controller: without.profile,
      scheduler: without.scheduler,
    });
    await old.connect();
    await expect(old.revokeOwnPairing()).rejects.toMatchObject({
      code: 'host_unsupported',
      missing: ['pairRevoke'],
    });
    expect(without.revokes).toHaveLength(0);
    old.close();
    without.controllerSessions.dispose();
    without.host.dispose();

    const harness = await hostHarness({
      features: {
        controllerProfiles: true,
        pairingProof: true,
        hostedDelegation: true,
        pairRevoke: true,
      },
    });
    const connection = new RemoteControllerConnection({
      sessions: harness.controllerSessions,
      host: {
        deviceId: harness.hostKey.deviceId,
        publicKey: harness.hostKey.publicKey,
      },
      controller: harness.profile,
      scheduler: harness.scheduler,
    });
    await connection.connect();
    // The answer, the end notice and the abort that follows them arrive in
    // one burst, as over a busy socket: the answer still settles the call.
    const held: Buffer[] = [];
    harness.hub.filter = (event): Buffer[] => {
      if (event.from !== harness.hostKey.deviceId) return [event.payload];
      held.push(event.payload);
      return event.payload[0] === 0x30 ? held.splice(0) : [];
    };
    await connection.revokeOwnPairing();
    expect(harness.revokes).toHaveLength(1);
    // The session ends with the pairing; nothing reconnects or resends.
    expect(connection.status).toBe('idle');
    harness.scheduler.advance(120_000);
    await flush();
    expect(harness.revokes).toHaveLength(1);
    harness.controllerSessions.dispose();
    harness.host.dispose();
  });

  it('exposes RemoteIpcTransport: invoke, send, filtered pushes and no replay after a drop', async () => {
    const harness = await hostHarness({ features: fullFeatures });
    let reconnected = 0;
    const connection = new RemoteControllerConnection({
      sessions: harness.controllerSessions,
      host: {
        deviceId: harness.hostKey.deviceId,
        publicKey: harness.hostKey.publicKey,
      },
      controller: harness.profile,
      scheduler: harness.scheduler,
      onReconnected: (): void => {
        reconnected += 1;
      },
    });
    const hello = await connection.connect();
    expect(hello.features).toEqual(fullFeatures);
    const transport = connection.transport;
    expect(
      await transport.invoke('projects:load', { scope: 'all' }, 2),
    ).toEqual({ channel: 'projects:load', args: [{ scope: 'all' }, 2] });
    transport.send('chat:set-interest', { chatId: 'c1' });
    const pushes: unknown[][] = [];
    const unsubscribe = transport.on('chat:state-changed', (...args) =>
      pushes.push(args),
    );
    const hostPeer = harness.hostPeers[0];
    if (!hostPeer) throw new Error('No host session.');
    hostPeer.notify('ipc.push', {
      channel: 'chat:state-changed',
      args: [{ chatId: 'c1' }],
    });
    hostPeer.notify('ipc.push', {
      channel: 'chat:state-changed',
      args: ['advisor-only'],
      surface: 'app-advisor',
    });
    hostPeer.notify('ipc.push', { channel: 'other', args: [1] });
    await waitFor(
      () =>
        pushes.length === 1 && harness.sends.length > 0 ? true : undefined,
      'push and send',
    );
    await flush();
    expect(pushes).toEqual([[{ chatId: 'c1' }]]);
    expect(harness.sends).toEqual([
      ['ipc.send', { channel: 'chat:set-interest', args: [{ chatId: 'c1' }] }],
    ]);
    unsubscribe();
    unsubscribe();
    hostPeer.notify('ipc.push', {
      channel: 'chat:state-changed',
      args: ['after'],
    });
    await flush();
    expect(pushes).toHaveLength(1);
    // A drop while an invoke is in flight: unknown outcome, never replayed.
    const slow = transport.invoke('slow', 'mutation');
    await waitFor(
      () =>
        harness.invokes.some((call) => call.channel === 'slow')
          ? true
          : undefined,
      'slow invoke',
    );
    hostPeer.close('closed');
    await expect(slow).rejects.toBeInstanceOf(RemoteTransportDisconnectedError);
    harness.releaseSlow();
    harness.scheduler.advance(2_000);
    await waitFor(
      () => (connection.status === 'connected' ? true : undefined),
      'reconnect',
    );
    expect(reconnected).toBe(1);
    expect(await transport.invoke('projects:load')).toEqual({
      channel: 'projects:load',
      args: [],
    });
    expect(
      harness.invokes.filter((call) => call.channel === 'slow'),
    ).toHaveLength(1);
    // A host ending the session on purpose stops reconnecting.
    const second = harness.hostPeers[1];
    second?.notify('session.ended', { reason: 'revoked' });
    await flush();
    second?.close('closed');
    await waitFor(
      () => (connection.status === 'error' ? true : undefined),
      'ended',
    );
    expect(connection.error).toMatchObject({ code: 'session_ended' });
    harness.scheduler.advance(120_000);
    await flush();
    expect(harness.hostPeers).toHaveLength(2);
    connection.close();
    harness.controllerSessions.dispose();
    harness.host.dispose();
  });

  it('pairs with a transcript-bound proof or with SAS comparison', async () => {
    const secret = randomBytes(32);
    const harness = await hostHarness({
      features: fullFeatures,
      servesPairHello: true,
      pairingSecret: secret,
    });
    const shown: string[] = [];
    const proofResult = await pairWithHost({
      sessions: harness.controllerSessions,
      hostDeviceId: harness.hostKey.deviceId,
      controller: harness.profile,
      request: { name: 'Chrome on Mac', platform: 'darwin' },
      proofSecret: secret,
      onShortAuthenticationString: (code) => shown.push(code),
      scheduler: harness.scheduler,
    });
    const hostView = harness.pairRequests[0];
    if (!hostView) throw new Error('No pair request.');
    expect(proofResult).toMatchObject({
      approved: true,
      method: 'proof',
      hostPublicKey: harness.hostKey.publicKey,
      hostName: 'Host',
    });
    expect(proofResult.shortAuthenticationString).toBe(hostView.sas);
    expect(Buffer.from(proofResult.transcriptHash)).toEqual(
      hostView.transcript,
    );
    expect(hostView.params).toEqual({
      kind: 'browser',
      name: 'Chrome on Mac',
      platform: 'darwin',
      proof: createHmac('sha256', secret)
        .update(
          Buffer.concat([Buffer.from(PAIR_PROOF_LABEL), hostView.transcript]),
        )
        .digest('base64url'),
    });
    expect(shown).toEqual([hostView.sas]);
    // A proof from another secret does not approve.
    const wrong = await pairWithHost({
      sessions: harness.controllerSessions,
      hostDeviceId: harness.hostKey.deviceId,
      controller: harness.profile,
      request: { name: 'Chrome on Mac', platform: 'darwin' },
      proofSecret: randomBytes(32),
      scheduler: harness.scheduler,
    });
    expect(wrong.approved).toBe(false);
    harness.controllerSessions.dispose();
    harness.host.dispose();

    const sasHarness = await hostHarness({
      features: fullFeatures,
      servesPairHello: true,
    });
    const sas = await pairWithHost({
      sessions: sasHarness.controllerSessions,
      hostDeviceId: sasHarness.hostKey.deviceId,
      controller: sasHarness.profile,
      request: { name: 'Chrome on Mac', platform: 'darwin' },
      scheduler: sasHarness.scheduler,
    });
    expect(sas).toMatchObject({ approved: true, method: 'sas' });
    expect(sasHarness.pairRequests[0]?.params.proof).toBeUndefined();
    expect(sas.shortAuthenticationString).toBe(sasHarness.pairRequests[0]?.sas);
    sasHarness.controllerSessions.dispose();
    sasHarness.host.dispose();
  });

  it('never sends a proof to a host that cannot verify one', async () => {
    for (const options of [
      {
        features: {
          controllerProfiles: true,
          pairingProof: false,
          hostedDelegation: false,
        },
        servesPairHello: true,
      },
      { features: fullFeatures, servesPairHello: false },
    ]) {
      const harness = await hostHarness(options);
      await expect(
        pairWithHost({
          sessions: harness.controllerSessions,
          hostDeviceId: harness.hostKey.deviceId,
          controller: harness.profile,
          request: { name: 'Chrome on Mac', platform: 'darwin' },
          proofSecret: randomBytes(32),
          scheduler: harness.scheduler,
        }),
      ).rejects.toBeInstanceOf(HostUnsupportedError);
      expect(harness.pairRequests).toHaveLength(0);
      harness.controllerSessions.dispose();
      harness.host.dispose();
    }
  });
});

it('keeps the remote session error vocabulary typed', () => {
  expect(new RemoteSessionError('queue_full', 'x').code).toBe('queue_full');
  expect(decodeBase64Url(FIXED_PUBLIC_KEY)).toHaveLength(32);
});
