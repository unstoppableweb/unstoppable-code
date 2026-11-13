import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  PIPELINE_SESSION_LABEL,
  PIPELINE_SESSION_MAX_PLAINTEXT_BYTES,
  PIPELINE_SESSION_VERSION,
  PipelineSessionFrameSchema,
  type PipelineSessionFrame,
} from '@canopy/protocol/pipeline-relay';

/*
 * The end-to-end session between the web core and a cloud runner over the
 * pipeline relay (ADR 31, CAN-6170), as `@canopy/protocol/pipeline-relay`
 * defines its frames. The web core's own implementation is
 * `apps/web/src/lib/web-core/cloud-runner-session.ts`, which apps/web keeps
 * because it may not load this package; the two are held to the same bytes
 * by `fixtures/session-vectors.json`. The runner plays `runner` (CP-11);
 * the conformance kit plays `core` against it.
 */

export type PipelineRelaySessionRole = 'core' | 'runner';

const KEY_BYTES = 32;
const NONCE_BYTES = 32;
const TAG_BYTES = 16;

/** Why a session ended without delivering what it was sent. */
export type PipelineRelaySessionFailure =
  | 'malformed'
  | 'unexpected'
  | 'bad_confirmation'
  | 'bad_frame'
  | 'too_large'
  /** A handshake frame could not be sent: the session could never finish. */
  | 'undelivered';

interface TrafficKeys {
  readonly send: Buffer;
  readonly receive: Buffer;
  readonly confirm: Buffer;
  readonly sendDirection: number;
  readonly receiveDirection: number;
}

function hkdf(key: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, info, KEY_BYTES));
}

/** Both directions' keys and the confirmation key, bound to both nonces. */
export function derivePipelineRelaySessionKeys(
  sessionKey: Uint8Array,
  coreNonce: Uint8Array,
  runnerNonce: Uint8Array,
): { coreToRunner: Buffer; runnerToCore: Buffer; confirm: Buffer } {
  const key = Buffer.from(sessionKey);
  const salt = Buffer.concat([
    Buffer.from(coreNonce),
    Buffer.from(runnerNonce),
  ]);
  return {
    coreToRunner: hkdf(key, salt, `${PIPELINE_SESSION_LABEL} core-to-runner`),
    runnerToCore: hkdf(key, salt, `${PIPELINE_SESSION_LABEL} runner-to-core`),
    confirm: hkdf(key, salt, `${PIPELINE_SESSION_LABEL} confirm`),
  };
}

function confirmation(confirm: Buffer, role: PipelineRelaySessionRole): Buffer {
  return createHmac('sha256', confirm).update(role, 'utf8').digest();
}

/** 4 bytes of direction (0 core to runner, 1 runner to core), 8 of sequence. */
function ivOf(direction: number, seq: number): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeUInt32BE(direction, 0);
  iv.writeBigUInt64BE(BigInt(seq), 4);
  return iv;
}

const AAD = Buffer.from(PIPELINE_SESSION_LABEL, 'utf8');

function seal(
  key: Uint8Array,
  direction: number,
  seq: number,
  plaintext: string,
): PipelineSessionFrame {
  const cipher = createCipheriv('aes-256-gcm', key, ivOf(direction, seq));
  cipher.setAAD(AAD);
  const sealed = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    v: PIPELINE_SESSION_VERSION,
    t: 'data',
    seq,
    ct: sealed.toString('base64url'),
  };
}

function open(
  key: Uint8Array,
  direction: number,
  frame: { readonly seq: number; readonly ct: string },
): string | null {
  const sealed = Buffer.from(frame.ct, 'base64url');
  if (sealed.byteLength < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      ivOf(direction, frame.seq),
    );
    decipher.setAAD(AAD);
    decipher.setAuthTag(sealed.subarray(sealed.byteLength - TAG_BYTES));
    return Buffer.concat([
      decipher.update(sealed.subarray(0, sealed.byteLength - TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null;
  }
}

export interface PipelineRelaySessionOptions {
  readonly role: PipelineRelaySessionRole;
  /** The incarnation's 32-byte session key, from its activation. */
  readonly sessionKey: Uint8Array;
  /** Sends one frame to the peer, through the relay. */
  readonly send: (text: string) => boolean;
  /** The handshake finished: `send` now delivers. */
  readonly onReady: () => void;
  /** One envelope the peer sent, decrypted and in order. */
  readonly onMessage: (plaintext: string) => void;
  /** The session ended; nothing more is delivered either way. */
  readonly onFailed: (reason: PipelineRelaySessionFailure) => void;
  /** Supplies the handshake nonce; random by default. */
  readonly nonce?: () => Buffer;
}

/** One session over one runner attachment. */
export interface PipelineRelaySession {
  /** The core opens the handshake; the runner waits for it. */
  start(): void;
  /** One frame from the peer. */
  receive(text: string): void;
  /** Sends one envelope; false before the session is ready or once it ended. */
  send(plaintext: string): boolean;
  readonly ready: boolean;
  close(): void;
}

export function createPipelineRelaySession(
  options: PipelineRelaySessionOptions,
): PipelineRelaySession {
  if (options.sessionKey.byteLength !== KEY_BYTES)
    throw new RangeError('A runner session key is 32 bytes.');
  const { role } = options;
  const ownNonce = (
    options.nonce ?? ((): Buffer => randomBytes(NONCE_BYTES))
  )();
  let keys: TrafficKeys | null = null;
  let ready = false;
  let ended = false;
  let sent = 0;
  let received = 0;

  const emit = (frame: PipelineSessionFrame): boolean =>
    !ended && options.send(JSON.stringify(frame));

  const fail = (reason: PipelineRelaySessionFailure): void => {
    if (ended) return;
    ended = true;
    ready = false;
    options.onFailed(reason);
  };

  const keysFor = (coreNonce: Buffer, runnerNonce: Buffer): TrafficKeys => {
    const derived = derivePipelineRelaySessionKeys(
      options.sessionKey,
      coreNonce,
      runnerNonce,
    );
    return role === 'core'
      ? {
          send: derived.coreToRunner,
          receive: derived.runnerToCore,
          confirm: derived.confirm,
          sendDirection: 0,
          receiveDirection: 1,
        }
      : {
          send: derived.runnerToCore,
          receive: derived.coreToRunner,
          confirm: derived.confirm,
          sendDirection: 1,
          receiveDirection: 0,
        };
  };

  const confirmed = (presented: string, expected: Buffer): boolean => {
    const bytes = Buffer.from(presented, 'base64url');
    return (
      bytes.byteLength === expected.byteLength &&
      timingSafeEqual(bytes, expected)
    );
  };

  const becomeReady = (): void => {
    ready = true;
    options.onReady();
  };

  const handle = (frame: PipelineSessionFrame): void => {
    switch (frame.t) {
      case 'hello': {
        const theirNonce = Buffer.from(frame.nonce, 'base64url');
        if (role === 'runner') {
          // The core's opening hello, once.
          if (keys !== null || frame.mac !== undefined)
            return fail('unexpected');
          keys = keysFor(theirNonce, ownNonce);
          if (
            !emit({
              v: PIPELINE_SESSION_VERSION,
              t: 'hello',
              nonce: ownNonce.toString('base64url'),
              mac: confirmation(keys.confirm, 'runner').toString('base64url'),
            })
          )
            return fail('undelivered');
          return;
        }
        // The runner's answer: it must prove it holds the key.
        if (keys !== null || frame.mac === undefined) return fail('unexpected');
        const derived = keysFor(ownNonce, theirNonce);
        if (!confirmed(frame.mac, confirmation(derived.confirm, 'runner')))
          return fail('bad_confirmation');
        keys = derived;
        if (
          !emit({
            v: PIPELINE_SESSION_VERSION,
            t: 'ready',
            mac: confirmation(derived.confirm, 'core').toString('base64url'),
          })
        )
          return fail('undelivered');
        becomeReady();
        return;
      }
      case 'ready': {
        if (role !== 'runner' || keys === null || ready)
          return fail('unexpected');
        if (!confirmed(frame.mac, confirmation(keys.confirm, 'core')))
          return fail('bad_confirmation');
        becomeReady();
        return;
      }
      case 'data': {
        // Before this session has keys, a data frame can only be an earlier
        // session's, sealed with keys this one never had: the runner's
        // output to a core that left, reaching the core that came back
        // before the new hello did (CP-11). It is dropped, not a fault.
        if (keys === null) return;
        if (!ready) return fail('unexpected');
        if (frame.seq !== received) return fail('bad_frame');
        const plaintext = open(keys.receive, keys.receiveDirection, frame);
        if (plaintext === null) return fail('bad_frame');
        received += 1;
        options.onMessage(plaintext);
        return;
      }
    }
  };

  return {
    get ready() {
      return ready;
    },
    start: () => {
      if (role !== 'core' || ended || keys !== null) return;
      if (
        !emit({
          v: PIPELINE_SESSION_VERSION,
          t: 'hello',
          nonce: ownNonce.toString('base64url'),
        })
      )
        fail('undelivered');
    },
    receive: (text) => {
      if (ended) return;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return fail('malformed');
      }
      const frame = PipelineSessionFrameSchema.safeParse(value);
      if (!frame.success) return fail('malformed');
      handle(frame.data);
    },
    send: (plaintext) => {
      if (!ready || ended || keys === null) return false;
      if (
        Buffer.byteLength(plaintext, 'utf8') >
        PIPELINE_SESSION_MAX_PLAINTEXT_BYTES
      ) {
        fail('too_large');
        return false;
      }
      const frame = seal(keys.send, keys.sendDirection, sent, plaintext);
      sent += 1;
      return emit(frame);
    },
    close: () => {
      ended = true;
      ready = false;
    },
  };
}

/**
 * Whether a frame is a core's opening `hello`: what a core that connected
 * again sends first, for a new session (CP-11).
 */
export function isPipelineRelayCoreHello(text: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return false;
  }
  const frame = PipelineSessionFrameSchema.safeParse(value);
  return (
    frame.success && frame.data.t === 'hello' && frame.data.mac === undefined
  );
}
