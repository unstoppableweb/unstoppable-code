import {
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import { z } from 'zod';
import {
  HostedDelegationSchema,
  type HostedDelegation,
} from '@canopy/protocol/remote-control';
import {
  decodeBase64Url,
  deriveDeviceId,
  encodeBase64Url,
  importEd25519PublicKey,
  type DeviceKeyPair,
} from './device-key';

/**
 * Mutually authenticated key exchange between two paired devices, carried
 * over the untrusted relay.
 *
 * Signed ephemeral Diffie-Hellman (SIGMA-style): each side contributes an
 * ephemeral X25519 key and a nonce, and each signs a hash of the whole
 * transcript with its long-term Ed25519 identity key under a role label.
 * The initiator commits to its ephemeral key before seeing the responder's,
 * so a man in the middle cannot grind ephemeral keys to make the short
 * authentication string shown during first-time pairing collide.
 *
 *   1. I → R  hello1  { purpose, initiatorKey, commitment = H(eI || nI) }
 *   2. R → I  hello2  { responderKey, eR, nR }
 *   3. I → R  hello3  { eI, nI, sig_I("initiator" || transcript) }
 *   4. R → I  hello4  { sig_R("responder" || transcript) }
 *
 * Traffic keys come from HKDF over X25519(eI, eR) salted with the
 * transcript hash: one key per direction.
 */
export const HANDSHAKE_PROTOCOL = 'canopy-remote-control/1';

export type HandshakePurpose = 'control' | 'pair';

const RAW_X25519_KEY_BYTES = 32;
const NONCE_BYTES = 32;
const SESSION_ID_BYTES = 16;

const base64UrlField = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const Hello1Schema = z.object({
  protocol: z.literal(HANDSHAKE_PROTOCOL),
  purpose: z.enum(['control', 'pair']),
  initiatorKey: base64UrlField,
  commitment: base64UrlField,
  /**
   * A hosted agents root's signed grant for this ephemeral initiator key.
   * Not part of the transcript: its session key must equal `initiatorKey`,
   * which the transcript already binds. The responder authorizes it before
   * hello2 and again after hello3.
   */
  delegation: HostedDelegationSchema.optional(),
});
export type Hello1 = z.infer<typeof Hello1Schema>;

export const Hello2Schema = z.object({
  responderKey: base64UrlField,
  ephemeral: base64UrlField,
  nonce: base64UrlField,
});
export type Hello2 = z.infer<typeof Hello2Schema>;

export const Hello3Schema = z.object({
  ephemeral: base64UrlField,
  nonce: base64UrlField,
  signature: base64UrlField,
});
export type Hello3 = z.infer<typeof Hello3Schema>;

export const Hello4Schema = z.object({ signature: base64UrlField });
export type Hello4 = z.infer<typeof Hello4Schema>;

export interface HandshakeResult {
  purpose: HandshakePurpose;
  peerDeviceId: string;
  peerPublicKey: string;
  sendKey: Buffer;
  receiveKey: Buffer;
  transcriptHash: Buffer;
  /** Six-digit short authentication string for first-time pairing. */
  shortAuthenticationString: string;
  /** The initiator's hello1 delegation, on the responder side only. */
  delegation: HostedDelegation | null;
  /**
   * Authenticates session resume messages (`resume1`, `resume2`). Derived
   * like the traffic keys under its own label, so it never encrypts.
   */
  resumeKey: Buffer;
}

export class HandshakeError extends Error {
  constructor(
    readonly code:
      | 'protocol'
      | 'unexpected_message'
      | 'unauthorized_peer'
      | 'peer_key_mismatch'
      | 'bad_commitment'
      | 'bad_signature'
      | 'weak_key',
    message: string,
  ) {
    super(message);
    this.name = 'HandshakeError';
  }
}

interface Ephemeral {
  privateKey: KeyObject;
  publicKey: string;
  nonce: string;
}

function createEphemeral(): Ephemeral {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') {
    throw new Error('X25519 key is missing its public component.');
  }
  return {
    privateKey,
    publicKey: jwk.x,
    nonce: encodeBase64Url(randomBytes(NONCE_BYTES)),
  };
}

function importX25519PublicKey(value: string): KeyObject {
  if (decodeBase64Url(value).byteLength !== RAW_X25519_KEY_BYTES) {
    throw new HandshakeError('protocol', 'Malformed ephemeral key.');
  }
  return createPublicKey({
    key: { kty: 'OKP', crv: 'X25519', x: value },
    format: 'jwk',
  });
}

function commitmentFor(ephemeral: string, nonce: string): string {
  return encodeBase64Url(
    createHash('sha256')
      .update('commit')
      .update(decodeBase64Url(ephemeral))
      .update(decodeBase64Url(nonce))
      .digest(),
  );
}

function lengthPrefixed(value: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.byteLength, 0);
  return Buffer.concat([length, value]);
}

interface TranscriptFields {
  purpose: HandshakePurpose;
  sessionId: Uint8Array;
  initiatorKey: string;
  responderKey: string;
  commitment: string;
  initiatorEphemeral: string;
  initiatorNonce: string;
  responderEphemeral: string;
  responderNonce: string;
}

function transcriptHash(fields: TranscriptFields): Buffer {
  const hash = createHash('sha256');
  for (const part of [
    Buffer.from(HANDSHAKE_PROTOCOL, 'utf8'),
    Buffer.from(fields.purpose, 'utf8'),
    fields.sessionId,
    decodeBase64Url(fields.initiatorKey),
    decodeBase64Url(fields.responderKey),
    decodeBase64Url(fields.commitment),
    decodeBase64Url(fields.initiatorEphemeral),
    decodeBase64Url(fields.initiatorNonce),
    decodeBase64Url(fields.responderEphemeral),
    decodeBase64Url(fields.responderNonce),
  ]) {
    hash.update(lengthPrefixed(part));
  }
  return hash.digest();
}

function roleMessage(
  role: 'initiator' | 'responder',
  transcript: Buffer,
): Buffer {
  return Buffer.concat([Buffer.from(role, 'utf8'), transcript]);
}

function signTranscript(
  identity: DeviceKeyPair,
  role: 'initiator' | 'responder',
  transcript: Buffer,
): string {
  return encodeBase64Url(
    sign(null, roleMessage(role, transcript), identity.privateKey),
  );
}

function verifyTranscript(
  peerPublicKey: string,
  role: 'initiator' | 'responder',
  transcript: Buffer,
  signature: string,
): void {
  const valid = verify(
    null,
    roleMessage(role, transcript),
    importEd25519PublicKey(peerPublicKey),
    decodeBase64Url(signature),
  );
  if (!valid) {
    throw new HandshakeError('bad_signature', 'Peer signature is invalid.');
  }
}

function deriveResult(
  role: 'initiator' | 'responder',
  purpose: HandshakePurpose,
  ownEphemeral: Ephemeral,
  peerEphemeral: string,
  peerPublicKey: string,
  transcript: Buffer,
): HandshakeResult {
  const shared = diffieHellman({
    privateKey: ownEphemeral.privateKey,
    publicKey: importX25519PublicKey(peerEphemeral),
  });
  if (shared.every((byte) => byte === 0)) {
    throw new HandshakeError('weak_key', 'Peer ephemeral key is degenerate.');
  }
  const traffic = Buffer.from(
    hkdfSync('sha256', shared, transcript, `${HANDSHAKE_PROTOCOL} traffic`, 64),
  );
  const initiatorToResponder = traffic.subarray(0, 32);
  const responderToInitiator = traffic.subarray(32, 64);
  const resumeKey = Buffer.from(
    hkdfSync('sha256', shared, transcript, `${HANDSHAKE_PROTOCOL} resume`, 32),
  );
  const sas = Buffer.from(
    hkdfSync('sha256', shared, transcript, `${HANDSHAKE_PROTOCOL} sas`, 4),
  ).readUInt32BE(0);
  return {
    purpose,
    peerDeviceId: deriveDeviceId(peerPublicKey),
    peerPublicKey,
    sendKey: role === 'initiator' ? initiatorToResponder : responderToInitiator,
    receiveKey:
      role === 'initiator' ? responderToInitiator : initiatorToResponder,
    transcriptHash: transcript,
    shortAuthenticationString: String(sas % 1_000_000).padStart(6, '0'),
    delegation: null,
    resumeKey,
  };
}

function assertSessionId(sessionId: Uint8Array): void {
  if (sessionId.byteLength !== SESSION_ID_BYTES) {
    throw new Error('Session IDs are 16 bytes.');
  }
}

export interface HandshakeInitiatorOptions {
  sessionId: Uint8Array;
  purpose: HandshakePurpose;
  identity: DeviceKeyPair;
  /** Device the initiator addressed through the relay. */
  peerDeviceId: string;
  /**
   * Pinned public key for `control` sessions. Pairing has no pin yet; the
   * peer key must still hash to `peerDeviceId`.
   */
  pinnedPeerPublicKey: string | null;
  /** Sent in hello1 when this initiator acts for a hosted root. */
  delegation?: HostedDelegation;
}

export class HandshakeInitiator {
  private readonly ephemeral = createEphemeral();
  private stage: 'new' | 'sent_hello1' | 'sent_hello3' | 'done' = 'new';
  private transcript: Buffer | null = null;
  private peerPublicKey: string | null = null;
  private peerEphemeral: string | null = null;

  constructor(private readonly options: HandshakeInitiatorOptions) {
    assertSessionId(options.sessionId);
  }

  start(): Hello1 {
    if (this.stage !== 'new') {
      throw new HandshakeError('unexpected_message', 'Handshake started.');
    }
    this.stage = 'sent_hello1';
    return {
      protocol: HANDSHAKE_PROTOCOL,
      purpose: this.options.purpose,
      initiatorKey: this.options.identity.publicKey,
      commitment: commitmentFor(this.ephemeral.publicKey, this.ephemeral.nonce),
      ...(this.options.delegation
        ? { delegation: this.options.delegation }
        : {}),
    };
  }

  receiveHello2(hello2: Hello2): Hello3 {
    if (this.stage !== 'sent_hello1') {
      throw new HandshakeError('unexpected_message', 'Unexpected hello2.');
    }
    const { pinnedPeerPublicKey, peerDeviceId } = this.options;
    if (
      pinnedPeerPublicKey !== null &&
      hello2.responderKey !== pinnedPeerPublicKey
    ) {
      throw new HandshakeError(
        'peer_key_mismatch',
        'The other computer presented a different key than the one paired.',
      );
    }
    if (deriveDeviceId(hello2.responderKey) !== peerDeviceId) {
      throw new HandshakeError(
        'peer_key_mismatch',
        'The other computer key does not match its device ID.',
      );
    }
    const transcript = transcriptHash({
      purpose: this.options.purpose,
      sessionId: this.options.sessionId,
      initiatorKey: this.options.identity.publicKey,
      responderKey: hello2.responderKey,
      commitment: commitmentFor(this.ephemeral.publicKey, this.ephemeral.nonce),
      initiatorEphemeral: this.ephemeral.publicKey,
      initiatorNonce: this.ephemeral.nonce,
      responderEphemeral: hello2.ephemeral,
      responderNonce: hello2.nonce,
    });
    this.transcript = transcript;
    this.peerPublicKey = hello2.responderKey;
    this.peerEphemeral = hello2.ephemeral;
    this.stage = 'sent_hello3';
    return {
      ephemeral: this.ephemeral.publicKey,
      nonce: this.ephemeral.nonce,
      signature: signTranscript(this.options.identity, 'initiator', transcript),
    };
  }

  receiveHello4(hello4: Hello4): HandshakeResult {
    if (
      this.stage !== 'sent_hello3' ||
      this.transcript === null ||
      this.peerPublicKey === null ||
      this.peerEphemeral === null
    ) {
      throw new HandshakeError('unexpected_message', 'Unexpected hello4.');
    }
    verifyTranscript(
      this.peerPublicKey,
      'responder',
      this.transcript,
      hello4.signature,
    );
    this.stage = 'done';
    return deriveResult(
      'initiator',
      this.options.purpose,
      this.ephemeral,
      this.peerEphemeral,
      this.peerPublicKey,
      this.transcript,
    );
  }
}

/** Throws unless hello1's initiator key hashes to the relay-reported sender. */
export function assertHello1Sender(hello1: Hello1, peerDeviceId: string): void {
  if (deriveDeviceId(hello1.initiatorKey) !== peerDeviceId) {
    throw new HandshakeError(
      'peer_key_mismatch',
      'Initiator key does not match its device ID.',
    );
  }
}

export interface HandshakeResponderOptions {
  sessionId: Uint8Array;
  identity: DeviceKeyPair;
  /** Source device reported by the relay for hello1. */
  peerDeviceId: string;
  /**
   * Decides whether a peer may open a session of this purpose. For `control`
   * this checks the pinned controller list; for `pair` it checks that the
   * device accepts pairing requests.
   */
  authorize: (purpose: HandshakePurpose, initiatorKey: string) => boolean;
}

export class HandshakeResponder {
  private readonly ephemeral = createEphemeral();
  private stage: 'new' | 'sent_hello2' | 'done' = 'new';
  private hello1: Hello1 | null = null;

  constructor(private readonly options: HandshakeResponderOptions) {
    assertSessionId(options.sessionId);
  }

  get purpose(): HandshakePurpose | null {
    return this.hello1?.purpose ?? null;
  }

  receiveHello1(hello1: Hello1): Hello2 {
    if (this.stage !== 'new') {
      throw new HandshakeError('unexpected_message', 'Unexpected hello1.');
    }
    assertHello1Sender(hello1, this.options.peerDeviceId);
    if (!this.options.authorize(hello1.purpose, hello1.initiatorKey)) {
      throw new HandshakeError(
        'unauthorized_peer',
        'This computer has not allowed that device.',
      );
    }
    this.hello1 = hello1;
    this.stage = 'sent_hello2';
    return {
      responderKey: this.options.identity.publicKey,
      ephemeral: this.ephemeral.publicKey,
      nonce: this.ephemeral.nonce,
    };
  }

  receiveHello3(hello3: Hello3): { hello4: Hello4; result: HandshakeResult } {
    const hello1 = this.hello1;
    if (this.stage !== 'sent_hello2' || hello1 === null) {
      throw new HandshakeError('unexpected_message', 'Unexpected hello3.');
    }
    const expected = decodeBase64Url(
      commitmentFor(hello3.ephemeral, hello3.nonce),
    );
    const received = decodeBase64Url(hello1.commitment);
    if (
      expected.byteLength !== received.byteLength ||
      !timingSafeEqual(expected, received)
    ) {
      throw new HandshakeError(
        'bad_commitment',
        'Initiator ephemeral key does not match its commitment.',
      );
    }
    const transcript = transcriptHash({
      purpose: hello1.purpose,
      sessionId: this.options.sessionId,
      initiatorKey: hello1.initiatorKey,
      responderKey: this.options.identity.publicKey,
      commitment: hello1.commitment,
      initiatorEphemeral: hello3.ephemeral,
      initiatorNonce: hello3.nonce,
      responderEphemeral: this.ephemeral.publicKey,
      responderNonce: this.ephemeral.nonce,
    });
    verifyTranscript(
      hello1.initiatorKey,
      'initiator',
      transcript,
      hello3.signature,
    );
    this.stage = 'done';
    return {
      hello4: {
        signature: signTranscript(
          this.options.identity,
          'responder',
          transcript,
        ),
      },
      result: {
        ...deriveResult(
          'responder',
          hello1.purpose,
          this.ephemeral,
          hello3.ephemeral,
          hello1.initiatorKey,
          transcript,
        ),
        delegation: hello1.delegation ?? null,
      },
    };
  }
}
