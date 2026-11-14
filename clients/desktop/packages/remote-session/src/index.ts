/**
 * `@canopy/remote-session`: the portable end-to-end encrypted Remote Control
 * session stack for browser workers and Node 22+ (WebCrypto Ed25519/X25519,
 * AES-256-GCM, HKDF, raw-deflate streams). It speaks the desktop's wire
 * format unchanged (protocol version 17); see docs/remote-control-protocol.md.
 *
 * Typical controller composition:
 *
 *   identity  = await generateDeviceIdentity()            // or restore/import
 *   relay     = new RelayClient({ kind, mintToken, deviceInfo, createSocket })
 *   sessions  = new RemoteSessionManager({ transport: relay, identity: () => identity })
 *   relay.start()
 *   pairing   = await pairWithHost({ sessions, hostDeviceId, controller, request, proofSecret? })
 *   control   = new RemoteControllerConnection({ sessions, host, controller, delegation? })
 *   await control.connect(); control.transport.invoke(channel, ...args)
 */
export { decodeBase64Url, encodeBase64Url, type Bytes } from './bytes';
export {
  HostUnsupportedError,
  PEER_REFUSAL_MESSAGES,
  RelayUnsupportedError,
  RemoteSessionError,
  type HostSecurityFeature,
  type RemoteSessionErrorCode,
} from './errors';
export { defaultScheduler, type SchedulerPort } from './scheduler';
export {
  DeviceIdentityError,
  deriveDeviceId,
  exportDeviceIdentityPkcs8,
  generateDeviceIdentity,
  importDeviceIdentityJwk,
  importDeviceIdentityPkcs8,
  publicKeyMatchesDeviceId,
  restoreDeviceIdentity,
  signWithIdentity,
  verifyEd25519,
  type DeviceIdentity,
  type IdentityKeyOptions,
} from './identity';
export {
  signHostedDelegation,
  verifyHostedDelegation,
  type HostedDelegationRefusal,
  type HostedDelegationVerdict,
  type VerifyHostedDelegationOptions,
} from './delegation';
export {
  HANDSHAKE_PROTOCOL,
  HandshakeError,
  HandshakeInitiator,
  HandshakeResponder,
  Hello1Schema,
  Hello2Schema,
  Hello3Schema,
  Hello4Schema,
  type HandshakeAuthorizationRequest,
  type HandshakeErrorCode,
  type HandshakePurpose,
  type HandshakeResult,
  type Hello1,
  type Hello2,
  type Hello3,
  type Hello4,
} from './handshake';
export {
  SECURE_CHANNEL_MAX_COUNTER,
  SECURE_CHANNEL_OVERHEAD_BYTES,
  SecureChannel,
  SecureChannelError,
  type SecureChannelCounters,
  type SecureChannelErrorCode,
} from './secure-channel';
export {
  ENVELOPE_HEADER_BYTES,
  ENVELOPE_TYPES,
  SESSION_ID_BYTES,
  decodeEnvelope,
  encodeEnvelope,
  envelopeHeader,
  type Envelope,
  type EnvelopeType,
} from './envelope';
export {
  V8_DEFAULT_MAX_DEPTH,
  V8_MAX_READ_VERSION,
  V8_MIN_READ_VERSION,
  V8_SERIALIZATION_VERSION,
  V8SerializationError,
  deserializeV8,
  serializeV8,
  type V8DeserializeOptions,
  type V8SerializationErrorCode,
  type V8SerializeOptions,
} from './v8-serializer';
export {
  FRAGMENT_FLAG_COMPRESSED,
  FRAGMENT_FLAG_FINAL,
  MessageAssembler,
  MessageCodecError,
  encodeMessage,
  fragmentMessage,
  inflateRawBounded,
  serializeMessage,
  type MessageCodecErrorCode,
  type MessageCodecOptions,
} from './message-codec';
export {
  HANDSHAKE_TIMEOUT_MS,
  MAX_PENDING_HANDSHAKES_PER_PEER,
  MAX_SESSIONS_PER_PEER,
  MAX_SESSION_QUEUED_RECEIVE_BYTES,
  MAX_SESSION_QUEUED_SEND_BYTES,
  MAX_SESSION_QUEUED_SENDS,
  MAX_TRACKED_UNKNOWN_SESSIONS,
  RemoteSessionManager,
  SecureSession,
  UNKNOWN_SESSION_ABORT_WINDOW_MS,
  UNKNOWN_SESSION_MESSAGE,
  isPeerRefusal,
  type ConnectOptions,
  type IncomingSessionAuthorization,
  type RelayTransport,
  type SessionCloseReason,
  type SessionManagerOptions,
} from './session-manager';
export {
  MAX_CONCURRENT_RPC_SERVES,
  MAX_PENDING_RPC_REQUESTS,
  RPC_IDLE_TIMEOUT_MS,
  RPC_KEEPALIVE_INTERVAL_MS,
  RPC_REQUEST_TIMEOUT_MS,
  RpcClosedError,
  RpcPeer,
  RpcRemoteError,
  type RpcEventHandler,
  type RpcPeerOptions,
  type RpcRequestHandler,
} from './rpc-peer';
export {
  RELAY_MAX_RECONNECT_DELAY_MS,
  RELAY_MIN_RECONNECT_DELAY_MS,
  RELAY_PING_INTERVAL_MS,
  RELAY_READY_TIMEOUT_MS,
  RELAY_RECONNECT_BACKOFF_FACTOR,
  RelayClient,
  createWebSocketRelaySocketFactory,
  reconnectDelayMs,
  type RelayClientOptions,
  type RelayConnectionStatus,
  type RelaySocket,
  type RelaySocketFactory,
  type RelaySocketHandlers,
} from './relay-client';
export {
  RemoteControllerConnection,
  SESSION_HELLO_TIMEOUT_MS,
  assertHostSupportsController,
  helloHost,
  webControllerProfile,
  type ControllerConnectionOptions,
  type ControllerConnectionStatus,
  type ControllerProfile,
  type RequiredHostFeatures,
} from './controller-connection';
export {
  PAIRING_DECISION_TIMEOUT_MS,
  PAIR_PROOF_SECRET_BYTES,
  computePairProof,
  pairWithHost,
  type PairWithHostOptions,
  type PairingResult,
} from './pairing';
