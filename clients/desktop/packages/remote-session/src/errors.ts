/**
 * Typed failures of the portable session stack. Wire-level failures keep the
 * desktop's error classes and codes (handshake, secure channel, codec, RPC);
 * these are the lifecycle and compatibility outcomes consumers branch on.
 */
export type RemoteSessionErrorCode =
  /** The host is reachable but lacks a required controller security feature. */
  | 'host_unsupported'
  /** The relay does not advertise a feature this client requires. */
  | 'relay_unsupported'
  /** The runtime lacks WebCrypto Ed25519/X25519 or raw deflate streams. */
  | 'runtime_unsupported'
  /** The call was never sent: there is no open session. */
  | 'not_connected'
  /** The peer did not finish the handshake in time. */
  | 'handshake_timeout'
  /** Too many handshakes or sessions with this peer. */
  | 'admission_refused'
  /** A bounded queue is full; nothing was sent. */
  | 'queue_full'
  /** The session manager or connection was shut down. */
  | 'shut_down'
  /** The hosted delegation expired before the session could open. */
  | 'delegation_expired'
  /** The host ended the session on purpose; no automatic reconnect. */
  | 'session_ended'
  /** The caller cancelled the operation. */
  | 'cancelled'
  /** The arguments were refused before anything was sent. */
  | 'invalid_request';

export class RemoteSessionError extends Error {
  constructor(
    readonly code: RemoteSessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RemoteSessionError';
  }
}

/** Host security features a restricted controller requires. */
export type HostSecurityFeature =
  | 'controllerProfiles'
  | 'pairingProof'
  | 'hostedDelegation'
  | 'pairRevoke'
  | 'secretRequestSettle'
  | 'protocolVersion';

/**
 * The host answered `session.hello` without affirmatively advertising the
 * features this controller depends on. Never retried with another version.
 */
export class HostUnsupportedError extends RemoteSessionError {
  constructor(
    readonly missing: ReadonlyArray<HostSecurityFeature>,
    message = 'The other computer needs an update before it can be controlled from here.',
  ) {
    super('host_unsupported', message);
    this.name = 'HostUnsupportedError';
  }
}

/** The relay did not advertise a feature in `ready.features`. */
export class RelayUnsupportedError extends RemoteSessionError {
  constructor(readonly missingFeature: string) {
    super('relay_unsupported', 'The device relay is out of date.');
    this.name = 'RelayUnsupportedError';
  }
}

/**
 * Abort messages a responder sends when it refuses this device itself: the
 * key is not paired there (or was removed), its kind is refused, or incoming
 * control is off. Admission limits and failures use other messages. The
 * desktop host sends the same text; the wire carries only the message.
 */
export const PEER_REFUSAL_MESSAGES = {
  hello1: 'This computer has not allowed that device.',
  hello3: 'This computer is not allowed to connect.',
} as const;
