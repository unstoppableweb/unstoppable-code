import { DEFAULT_MAX_ACTIVE_REQUESTS } from './limits';
import { Buffer } from 'node:buffer';
import { Duplex } from 'node:stream';
import {
  CANOPY_MAX_MESSAGE_BYTES,
  CanopyTransportError,
  createCanopyFramedConnection,
  resolveCanopyChannelLimits,
  type CanopyFramedAuthOptions,
  type CanopyFramedConnectionOptions,
} from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CANOPY_HOST_EXECUTION_MEMBER,
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CoreRuntimeHealthGetResultSchema,
  CoreRuntimeInitializeParamsSchema,
  CoreRuntimeManifestGetResultSchema,
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyErrorPayload,
  type CanopyJsonRpcId,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcRequest,
  type CanopyStreamCursor,
  type CoreRuntimeInitializeResult,
} from '@canopy/protocol/canopy-core';

import type { RuntimeOperation } from '../../kernel/operation-registry';
import {
  CanopyOperationError,
  canopyDeadlineExceededError,
  canopyInternalError,
  canopyInvalidArgumentError,
  canopyPermissionDeniedError,
} from '../../runtime/errors';
import { hostExecutionOption } from '../../runtime/host-execution';
import { streamPositionBefore } from '../../runtime/stream-position';
import type { CanopyDispatcher } from '../../runtime/types';
import type {
  PlatformByteStream,
  PlatformEndpointListener,
} from '../../platform/platform-services';
import {
  CANOPY_SYSTEM_CLOCK,
  createCanopyLeaseRegistry,
  createCanopyObligationRegistry,
  startCanopyIdleGrace,
  type CanopyClientLeaseView,
  type CanopyDaemonClock,
  type CanopyIdleGraceOptions,
  type CanopyLeaseEnd,
  type CanopyLeaseOptions,
  type CanopyLeaseRegistry,
  type CanopyObligationRegistry,
} from './leases';
import type { CanopyOwnerProofVerifier } from './owner-proof';
import { createCanopyLeaseRegistrations } from './registrations';
import {
  CANOPY_DEFAULT_MAX_CHANNELS_PER_LEASE,
  createCanopyChannelRegistry,
  type CanopyChannelOptions,
  type CanopyChannelRegistry,
} from './channels';

const INITIALIZE = 'core.runtime.initialize';
const HEALTH = 'core.runtime.health.get';
const MANIFEST = 'core.runtime.manifest.get';
const LEASE_GRANT = 'core.client.manage';
const RUNTIME_READ_GRANT = 'core.runtime.read';
const LEASE_OPERATIONS = [
  'core.client.lease.acquire',
  'core.client.lease.renew',
  'core.client.lease.release',
  'core.client.capabilities.register',
] as const;
type LeaseOperation = (typeof LEASE_OPERATIONS)[number];
// Platform streams accept bounded writes; larger frames are written in slices.
const MAX_STREAM_WRITE_BYTES = 64 * 1024;

/** Per-connection identity handed to the host's caller policy. */
export interface CanopyControlConnectionIdentity {
  readonly connectionId: string;
  readonly lease: CanopyClientLeaseView | null;
  /** The connection proved the daemon's owner secret at initialize (CAN-5771). */
  readonly owner: boolean;
}

export type CanopyControlPlaneConnectionOptions = Omit<
  CanopyFramedConnectionOptions,
  'role' | 'auth'
>;

export interface CanopyDaemonControlPlaneOptions {
  /** `CanopyDaemonPublication` satisfies this; the publication keeps endpoint lifetime. */
  readonly binding: {
    readonly listener: PlatformEndpointListener<unknown>;
    readonly auth: CanopyFramedAuthOptions;
  };
  /** The kernel's dispatcher and operation registry (`CanopyRuntime`). */
  readonly dispatcher: CanopyDispatcher;
  /**
   * `declaresMeta` operations get `_meta` in params as well as in metadata,
   * as their params schema requires; the rest get it split off.
   */
  readonly operations: readonly Pick<
    RuntimeOperation,
    'name' | 'kind' | 'declaresMeta'
  >[];
  /** Trusted host policy: principal and grants for an authenticated connection. */
  readonly callerFor: (
    connection: CanopyControlConnectionIdentity,
  ) => CanopyCallerDescriptor;
  /** Admits owner connections; without it every owner proof is refused (CAN-5771). */
  readonly ownerProof?: CanopyOwnerProofVerifier;
  readonly buildVersion: string;
  readonly leases?: CanopyLeaseOptions;
  /** Negotiates lease-bound opaque byte channels; no kinds are enabled by default. */
  readonly channels?: CanopyChannelOptions;
  readonly idleGrace?: CanopyIdleGraceOptions;
  /** Called once when the idle grace elapses; the host runs the phased stop. */
  readonly onIdle: () => void;
  /**
   * Called once when the accept loop fails before the plane closes
   * (CAN-7116). No new client can connect, while held leases would keep the
   * daemon alive, so the host runs the phased stop and its supervisor starts
   * a fresh daemon.
   */
  readonly onAcceptFailed?: () => void;
  readonly connection?: CanopyControlPlaneConnectionOptions;
  /** Requests served at once per connection; excess fails `resource_exhausted`. */
  readonly maxActiveRequests?: number;
  /**
   * Operations served only while this connection holds a live client lease.
   * Admission and the reply follow the lease's bound connection, never a
   * declared label, a caller descriptor, or a payload claim.
   */
  readonly leaseBoundOperations?: readonly string[];
  /**
   * Lease-bound keyed operations requiring `same_idempotency_key` rather
   * than `never` after a fence (W5 DM-5 #4; entry q-22(d)). Hosts must qualify
   * real-result replay before granting production callers.
   */
  readonly sameKeyFencedOperations?: readonly string[];
  /**
   * Fits a query or instruction reply to what this connection's client said
   * it decodes (`client.capabilities` in `core.runtime.initialize`), so an
   * additive field reaches only clients that understand it.
   */
  readonly fitReply?: CanopyControlReplyFit;
  readonly clock?: CanopyDaemonClock;
}

/** Per-connection reply fitting; both halves see the client's capabilities. */
export interface CanopyControlReplyFit {
  result(
    method: string,
    result: unknown,
    clientCapabilities: ReadonlySet<string>,
  ): unknown;
  error(
    method: string,
    error: CanopyErrorPayload,
    clientCapabilities: ReadonlySet<string>,
  ): CanopyErrorPayload;
}

/** Applies each fit in turn, so independent additive fields fit together. */
export function composeCanopyControlReplyFits(
  ...fits: readonly CanopyControlReplyFit[]
): CanopyControlReplyFit {
  return {
    result: (method, result, capabilities) =>
      fits.reduce(
        (fitted, fit) => fit.result(method, fitted, capabilities),
        result,
      ),
    error: (method, error, capabilities) =>
      fits.reduce(
        (fitted, fit) => fit.error(method, fitted, capabilities),
        error,
      ),
  };
}

export interface CanopyDaemonControlPlane {
  readonly leases: CanopyLeaseRegistry;
  readonly obligations: CanopyObligationRegistry;
  /** Stops serving and closes every connection; the listener stays with its owner. */
  close(): Promise<void>;
}

/** What one plane instance needs to serve its connections. */
type CanopyControlServingOptions = Pick<
  CanopyDaemonControlPlaneOptions,
  | 'dispatcher'
  | 'operations'
  | 'callerFor'
  | 'ownerProof'
  | 'buildVersion'
  | 'leases'
  | 'channels'
  | 'connection'
  | 'maxActiveRequests'
  | 'leaseBoundOperations'
  | 'sameKeyFencedOperations'
  | 'fitReply'
  | 'clock'
>;

export interface CanopyControlStreamOptions extends Omit<
  CanopyControlServingOptions,
  'callerFor'
> {
  /** One stream the host admitted before serving; it still runs the D3 handshake. */
  readonly stream: PlatformByteStream;
  readonly auth: CanopyFramedAuthOptions;
  /** Fixed at admission and used for every request; the connection never changes it. */
  readonly caller: CanopyCallerDescriptor;
  /** The daemon plane's obligations: held for the session so it cannot idle-stop. */
  readonly obligations: Pick<CanopyObligationRegistry, 'hold'>;
}

export interface CanopyControlStreamSession {
  /** Settles once the session has ended and released its obligation. */
  readonly done: Promise<void>;
  /** Ends the session and closes its stream. */
  close(): Promise<void>;
}

/** Adapts a pull-based platform stream to the duplex the framed codec reads. */
function platformStreamDuplex(stream: PlatformByteStream): Duplex {
  return new Duplex({
    read(): void {
      stream.read().then(
        (bytes) => this.push(bytes === null ? null : Buffer.from(bytes)),
        () => this.destroy(),
      );
    },
    write(chunk: Buffer, _encoding, callback): void {
      void (async (): Promise<void> => {
        for (let at = 0; at < chunk.length; at += MAX_STREAM_WRITE_BYTES)
          await stream.write(chunk.subarray(at, at + MAX_STREAM_WRITE_BYTES));
      })().then(
        () => callback(),
        () => callback(new Error('Stream write failed.')),
      );
    },
    final(callback): void {
      stream.close().then(
        () => callback(),
        () => callback(),
      );
    },
    destroy(error, callback): void {
      stream.close().then(
        () => callback(error),
        () => callback(error),
      );
    },
  });
}

/**
 * Accepts every stream from `listener` and runs the D3 server handshake on
 * it. Only authenticated connections reach `onConnection`; a failed
 * handshake has already closed its stream.
 */
export function acceptCanopyFramedConnections(options: {
  readonly listener: PlatformEndpointListener<unknown>;
  readonly auth: CanopyFramedAuthOptions;
  readonly connection?: CanopyControlPlaneConnectionOptions;
  readonly onConnection: (connection: CanopyFramedConnection) => void;
}): { readonly done: Promise<void> } {
  const accept = async (stream: PlatformByteStream): Promise<void> => {
    const duplex = platformStreamDuplex(stream);
    try {
      options.onConnection(
        await createCanopyFramedConnection(duplex, {
          maxMessageBytes: CANOPY_MAX_MESSAGE_BYTES,
          ...options.connection,
          role: 'server',
          auth: options.auth,
        }),
      );
    } catch {
      duplex.destroy();
    }
  };
  const done = (async (): Promise<void> => {
    for await (const stream of options.listener.connections())
      void accept(stream);
  })();
  return { done };
}

function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}

/**
 * The dispatcher's metadata rules for the operations the control plane
 * serves itself: schema, idempotency-key presence and an elapsed deadline.
 */
function admitMetadata(
  metadata: unknown,
  kind: 'query' | 'keyed' | 'inherent',
): void {
  const parsed = (
    kind === 'query'
      ? CanopyQueryRequestMetadataSchema
      : CanopyRequestMetadataSchema
  ).safeParse(metadata ?? {});
  if (!parsed.success)
    throw canopyInvalidArgumentError('Invalid request metadata.');
  const keyed =
    'idempotencyKey' in parsed.data && parsed.data.idempotencyKey !== undefined;
  if (kind === 'keyed' && !keyed)
    throw canopyInvalidArgumentError('An idempotency key is required.');
  if (kind === 'inherent' && keyed)
    throw canopyInvalidArgumentError('An idempotency key is not allowed.');
  const { deadlineAt } = parsed.data;
  if (deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now())
    throw canopyDeadlineExceededError(undefined, {
      kind: kind === 'keyed' ? 'same_idempotency_key' : 'same_request',
    });
}

// Bare: with no operation's error schema here, a diagnostic could make the
// client reject the error as undeclared. Handler failures already carry one.
function errorPayload(error: unknown): CanopyOperationError['payload'] {
  return error instanceof CanopyOperationError
    ? error.payload
    : canopyInternalError().payload;
}

// Code-free: lease codes are outside the leased operations' error schemas.
const LEASE_REQUIRED: CanopyErrorPayload = {
  kind: 'not_found',
  message: 'This operation requires a live client lease on this connection.',
  retry: { kind: 'never' },
};
const OWNER_REFUSED: CanopyErrorPayload = {
  kind: 'unauthenticated',
  message: 'The owner proof was refused.',
  retry: { kind: 'never' },
};
// Each fenced call's retry is its operation's (`sameKeyFencedOperations`).
const LEASE_FENCED: Readonly<
  Record<CanopyLeaseEnd | 'moved', Omit<CanopyErrorPayload, 'retry'>>
> = {
  released: { kind: 'cancelled', message: 'The client lease was released.' },
  evicted: { kind: 'not_found', message: 'The client lease expired.' },
  moved: {
    kind: 'failed_precondition',
    message: 'The client lease moved to another connection.',
  },
};

/**
 * Binds one leased call to the lease held at admission: its signal aborts
 * when that lease ends or rebinds elsewhere, and `refusal` re-checks the
 * holder synchronously, so a late result is never sent on a fenced lease.
 * Known cost: the bundled worker is not told to stop, so a fenced read runs
 * on and holds an in-process request slot until it settles or its deadline.
 */
function fenceLeasedCall(
  leases: CanopyLeaseRegistry,
  connectionId: string,
  retry: CanopyErrorPayload['retry'],
): {
  readonly signal: AbortSignal;
  refusal(): CanopyOperationError | null;
  dispose(): void;
} {
  const lease = leases.lease(connectionId);
  if (!lease) throw new CanopyOperationError(LEASE_REQUIRED);
  const { leaseId } = lease;
  const controller = new AbortController();
  let ended: CanopyLeaseEnd | 'moved' | null = null;
  const end = (reason: CanopyLeaseEnd | 'moved'): void => {
    ended ??= reason;
    controller.abort();
  };
  const offEnd = leases.onEnd((view, reason) => {
    if (view.leaseId === leaseId) end(reason);
  });
  const offChange = leases.onChange(() => {
    if (leases.holder(leaseId) !== connectionId) end('moved');
  });
  return {
    signal: controller.signal,
    refusal: (): CanopyOperationError | null => {
      // `holder` evicts an expired lease on access, which records the end first.
      if (leases.holder(leaseId) !== connectionId) end('moved');
      return ended
        ? new CanopyOperationError({ ...LEASE_FENCED[ended], retry })
        : null;
    },
    dispose: (): void => {
      offEnd();
      offChange();
    },
  };
}

function selectProtocolVersion(
  offered: readonly number[],
  supported: readonly number[],
): number | null {
  const common = offered.filter((version) => supported.includes(version));
  return common.length ? Math.max(...common) : null;
}

/** `client.ownerProof` as sent, of any type; undefined when absent (CAN-5771). */
function ownerProofOf(params: Record<string, unknown>): unknown {
  const client = params.client;
  if (typeof client !== 'object' || client === null || Array.isArray(client))
    return undefined;
  return Object.prototype.hasOwnProperty.call(client, 'ownerProof')
    ? Reflect.get(client, 'ownerProof')
    : undefined;
}

/** Serves one authenticated connection until it closes. */
function serveControlConnection(
  connection: CanopyFramedConnection,
  options: CanopyControlServingOptions,
  leases: CanopyLeaseRegistry,
  channels: CanopyChannelRegistry,
  registrations: ReturnType<typeof createCanopyLeaseRegistrations>,
  planeSignal: AbortSignal,
): void {
  const kinds = new Map(options.operations.map((op) => [op.name, op.kind]));
  const declaringMeta: ReadonlySet<string> = new Set(
    options.operations.filter((op) => op.declaresMeta).map((op) => op.name),
  );
  const paramsFor = (request: CanopyJsonRpcRequest): Record<string, unknown> =>
    declaringMeta.has(request.method)
      ? request.params
      : without(request.params, '_meta');
  const leaseBound: ReadonlySet<string> = new Set(
    options.leaseBoundOperations ?? [],
  );
  const sameKeyFenced: ReadonlySet<string> = new Set(
    options.sameKeyFencedOperations ?? [],
  );
  const channelKinds = options.channels?.kinds ?? {};
  const mayOpenChannel = (
    caller: CanopyCallerDescriptor,
    kind: string,
  ): boolean =>
    caller.grants.includes(LEASE_GRANT) &&
    (channelKinds[kind]?.requiredGrants ?? []).every((grant) =>
      caller.grants.some((held) => held === grant),
    );
  /** This connection's negotiated manifest; nothing outside it is served. */
  let advertised: ReadonlySet<string> = new Set();
  let clientCapabilities: ReadonlySet<string> = new Set();
  let advertisedChannelKinds: ReadonlySet<string> = new Set();
  let owner = false;
  const identity = (): CanopyControlConnectionIdentity => ({
    connectionId: connection.connectionId,
    lease: leases.lease(connection.connectionId),
    owner,
  });
  let initialization: 'none' | 'pending' | 'done' = 'none';
  let ownedLeaseId: string | null = null;
  let active = 0;
  const maxActive = options.maxActiveRequests ?? DEFAULT_MAX_ACTIVE_REQUESTS;
  const send = (message: CanopyJsonRpcMessage): Promise<void> =>
    connection.send(message).catch((error: unknown) => {
      // Refused before a byte was written, such as a result larger than the
      // client reassembles: the request is still answered.
      if (
        connection.signal.aborted ||
        !(error instanceof CanopyTransportError) ||
        !('id' in message) ||
        'error' in message
      )
        return;
      return connection
        .send({
          jsonrpc: '2.0',
          id: message.id,
          error: encodeCanopyError(error.payload),
        })
        .catch(() => undefined);
    });
  const fail = (id: CanopyJsonRpcId, error: unknown): Promise<void> =>
    send({ jsonrpc: '2.0', id, error: encodeCanopyError(errorPayload(error)) });
  const offEvicted = registrations.onEvicted((event) => {
    if (event.leaseId === ownedLeaseId)
      void send({
        jsonrpc: '2.0',
        method: 'core.client.lease.evicted',
        params: event,
      });
  });
  const offOwner = leases.onChange(() => {
    if (ownedLeaseId && leases.holder(ownedLeaseId) !== connection.connectionId)
      ownedLeaseId = null;
  });
  connection.signal.addEventListener(
    'abort',
    () => {
      offEvicted();
      offOwner();
    },
    { once: true },
  );

  const refusal = (
    kind:
      | 'failed_precondition'
      | 'capability_unavailable'
      | 'permission_denied'
      | 'internal',
    message: string,
  ): CanopyErrorPayload => ({ kind, message, retry: { kind: 'never' } });
  connection.onChannel(
    (channel) => {
      if (!channels.track(connection.connectionId, channel)) return;
      // Admission ran in this same turn, so both are present.
      const lease = leases.lease(connection.connectionId);
      const consumer = channelKinds[channel.kind];
      try {
        if (!lease || !consumer) throw new Error('Channel admission changed.');
        consumer.accept(channel, {
          connectionId: connection.connectionId,
          lease,
          caller: options.callerFor(identity()),
        });
      } catch {
        channel.close(refusal('internal', 'The channel consumer failed.'));
      }
    },
    {
      admit: (attempt) => {
        if (initialization !== 'done')
          return refusal(
            'failed_precondition',
            'Call core.runtime.initialize first.',
          );
        if (!advertisedChannelKinds.has(attempt.kind))
          return refusal(
            'capability_unavailable',
            `Channel kind ${attempt.kind} is not available on this connection.`,
          );
        // Grants can change after initialize; dispatcher calls re-check too.
        if (!mayOpenChannel(options.callerFor(identity()), attempt.kind))
          return refusal(
            'permission_denied',
            `The caller may not open ${attempt.kind} channels.`,
          );
        return channels.admit(connection.connectionId, attempt.leaseId);
      },
    },
  );

  const initialize = async (
    request: CanopyJsonRpcRequest,
    caller: CanopyCallerDescriptor,
  ): Promise<CoreRuntimeInitializeResult> => {
    admitMetadata(request.params._meta, 'query');
    const params = CoreRuntimeInitializeParamsSchema.safeParse(
      without(request.params, '_meta'),
    );
    if (!params.success)
      throw canopyInvalidArgumentError('Invalid core.runtime.initialize.');
    clientCapabilities = new Set(params.data.client.capabilities);
    // Additive: a client that reassembles message parts says how large.
    const { maxMessageBytes } = params.data.client;
    if (
      typeof maxMessageBytes === 'number' &&
      Number.isSafeInteger(maxMessageBytes) &&
      maxMessageBytes > 0
    )
      connection.allowPeerMessageBytes?.(maxMessageBytes);
    // Initialize requires no grant, so the runtime reads run with runtime-read
    // added; advertised availability is still judged on the caller's grants.
    const reader: CanopyCallerDescriptor = {
      ...caller,
      grants: caller.grants.includes(RUNTIME_READ_GRANT)
        ? caller.grants
        : [...caller.grants, RUNTIME_READ_GRANT],
    };
    const { runtime } = CoreRuntimeHealthGetResultSchema.parse(
      await options.dispatcher.query(HEALTH, {}, { caller: reader }),
    );
    const selected = selectProtocolVersion(
      params.data.client.protocolVersions,
      runtime.protocolVersions,
    );
    if (selected === null)
      throw new CanopyOperationError({
        kind: 'failed_precondition',
        message:
          'Protocol version mismatch: restart the daemon or update this client.',
        code: 'core.runtime.invalidState',
        details: {
          supportedProtocolVersions: runtime.protocolVersions,
          action: 'restart_or_update',
        },
        retry: { kind: 'never' },
      });
    const manifest = CoreRuntimeManifestGetResultSchema.parse(
      await options.dispatcher.query(
        MANIFEST,
        { includeUnavailable: true },
        { caller: reader },
      ),
    );
    const reachable = manifest.operations.filter(({ requiredGrants }) =>
      requiredGrants.every((grant) =>
        caller.grants.some((held) => held === grant),
      ),
    );
    const channelKindsForCaller = Object.keys(channelKinds)
      .sort()
      .filter((name) => mayOpenChannel(caller, name));
    advertisedChannelKinds = new Set(channelKindsForCaller);
    const channelLimits = resolveCanopyChannelLimits(options.connection ?? {});
    return {
      runtime: { ...runtime, buildVersion: options.buildVersion },
      selectedProtocolVersion: selected,
      capabilities: {
        operations: [
          ...reachable
            .filter(({ kind }) => kind !== 'stream')
            .map(({ name }) => name),
          ...(caller.grants.includes(LEASE_GRANT) ? LEASE_OPERATIONS : []),
        ],
        events: [],
        streams: reachable
          .filter(({ kind }) => kind === 'stream')
          .map(({ name }) => name),
        channels: channelKindsForCaller,
      },
      limits: {
        ...(connection.maxMessageBytes !== undefined && {
          maxMessageBytes: connection.maxMessageBytes,
        }),
        channels: {
          maxChannelsPerLease: channels.maxChannelsPerLease,
          maxChunkBytes: channelLimits.maxChunkBytes,
          maxBufferedChunks: channelLimits.maxBufferedChunks,
          maxBufferedBytes: channelLimits.maxBufferedBytes,
        },
      },
      authentication: { required: true, methods: [] },
    };
  };

  const lease = (
    method: LeaseOperation,
    request: CanopyJsonRpcRequest,
    caller: CanopyCallerDescriptor,
  ): unknown => {
    if (!caller.grants.includes(LEASE_GRANT))
      throw canopyPermissionDeniedError();
    const definitions = CORE_TRANSPORT_INSTRUCTION_DEFINITIONS;
    const invalid = (): CanopyOperationError =>
      canopyInvalidArgumentError(`Invalid ${method} params.`);
    const { connectionId } = connection;
    if (method === 'core.client.capabilities.register') {
      admitMetadata(request.params._meta, 'keyed');
      const params = definitions[method].params.safeParse(request.params);
      if (!params.success) throw invalid();
      return registrations.register(connectionId, params.data);
    }
    if (method === 'core.client.lease.acquire') {
      admitMetadata(request.params._meta, 'keyed');
      const params = definitions[method].params.safeParse(request.params);
      if (!params.success) throw invalid();
      const acquired = leases.acquire(connectionId, params.data);
      ownedLeaseId = acquired.leaseId;
      return acquired;
    }
    // Only keyed acquire carries request metadata in its params schema.
    admitMetadata(request.params._meta, 'inherent');
    const body = without(request.params, '_meta');
    if (method === 'core.client.lease.renew') {
      const params = definitions[method].params.safeParse(body);
      if (!params.success) throw invalid();
      return leases.renew(connectionId, params.data);
    }
    if (!definitions[method].params.safeParse(body).success) throw invalid();
    const disposition = registrations.disposition(connectionId);
    return {
      released: leases.release(connectionId),
      ...disposition,
    };
  };

  const stream = async (
    request: CanopyJsonRpcRequest,
    caller: CanopyCallerDescriptor,
  ): Promise<void> => {
    const { id, method } = request;
    const registration = registrations.beginStream(
      connection.connectionId,
      method,
      String(id),
    );
    try {
      const handle = await options.dispatcher.openStream(
        method,
        paramsFor(request),
        {
          caller,
          metadata: request.params._meta,
          signal: AbortSignal.any([connection.signal, registration.signal]),
        },
      );
      registration.attach(() => handle.close());
      const { subscriptionId } = handle.openResult;
      await connection.send({ jsonrpc: '2.0', id, result: handle.openResult });
      let delivered: CanopyStreamCursor | undefined;
      // Pulling applies the dispatcher's bounded buffer as backpressure.
      for await (const frame of handle.frames) {
        if (frame.kind === 'item') {
          const refusal = await connection
            .send({
              jsonrpc: '2.0',
              method: `${method}.item`,
              params: {
                subscriptionId,
                cursor: frame.cursor,
                itemId: `item-${frame.cursor.sequence}`,
                occurredAt: new Date(
                  (options.clock ?? CANOPY_SYSTEM_CLOCK).now(),
                ).toISOString(),
                item: frame.item,
              },
            })
            .then(
              () => null,
              (error: unknown) => {
                if (
                  connection.signal.aborted ||
                  !(error instanceof CanopyTransportError)
                )
                  throw error;
                return error.payload;
              },
            );
          if (refusal === null) {
            delivered = frame.cursor;
            continue;
          }
          // Refused before a byte was written, such as an item larger than
          // the client joins: only this stream ends, typed (CAN-5684), at
          // the position before the refused item so a resume reads it again.
          handle.close();
          return await connection.send({
            jsonrpc: '2.0',
            method: `${method}.end`,
            params: {
              subscriptionId,
              cursor: streamPositionBefore(
                frame.cursor,
                delivered,
                handle.openResult.acceptedCursor,
              ),
              outcome: 'error',
              error: refusal,
            },
          });
        } else
          await connection.send({
            jsonrpc: '2.0',
            method: `${method}.end`,
            params: { subscriptionId, ...without(frame, 'kind') },
          });
      }
    } finally {
      registration.finish(connection.signal.aborted);
    }
  };

  /** One query or instruction; a lease-bound call is fenced to its admitted lease. */
  const dispatch = async (
    request: CanopyJsonRpcRequest,
    query: boolean,
    caller: CanopyCallerDescriptor,
  ): Promise<void> => {
    const { id, method } = request;
    const { [CANOPY_HOST_EXECUTION_MEMBER]: execution, ...params } =
      paramsFor(request);
    const fence = leaseBound.has(method)
      ? fenceLeasedCall(
          leases,
          connection.connectionId,
          sameKeyFenced.has(method)
            ? { kind: 'same_idempotency_key' }
            : { kind: 'never' },
        )
      : null;
    try {
      const call = {
        caller,
        metadata: request.params._meta,
        signal: fence
          ? AbortSignal.any([connection.signal, fence.signal])
          : connection.signal,
        // Same-host input for this request only; the dispatcher refuses it
        // on operations that do not accept it (CAN-5496).
        ...hostExecutionOption(execution),
      };
      let result: unknown;
      try {
        result = query
          ? await options.dispatcher.query(method, params, call)
          : await options.dispatcher.instruction(method, params, call);
      } catch (error) {
        const refusal = fence?.refusal() ?? error;
        throw options.fitReply && refusal instanceof CanopyOperationError
          ? new CanopyOperationError(
              options.fitReply.error(
                method,
                refusal.payload,
                clientCapabilities,
              ),
              refusal.runtimeCause,
            )
          : refusal;
      }
      // Checked in the same turn as the send, so no lease change slips between.
      const refused = fence?.refusal();
      if (refused) throw refused;
      return await send({
        jsonrpc: '2.0',
        id,
        result: options.fitReply
          ? options.fitReply.result(method, result, clientCapabilities)
          : result,
      });
    } finally {
      fence?.dispose();
    }
  };

  const serve = async (request: CanopyJsonRpcRequest): Promise<void> => {
    const { id, method } = request;
    const kind = kinds.get(method);
    const leaseMethod = LEASE_OPERATIONS.find((name) => name === method);
    if (
      initialization === 'done' &&
      method !== INITIALIZE &&
      !leaseMethod &&
      !kind
    )
      return send({
        jsonrpc: '2.0',
        id,
        error: {
          code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
          message: `Unknown method ${method}.`,
        },
      });
    if (method === INITIALIZE && initialization === 'none') {
      const claimed = ownerProofOf(request.params);
      if (claimed !== undefined) {
        if (
          typeof claimed !== 'string' ||
          options.ownerProof?.verify(connection.connectionId, claimed) !== true
        ) {
          initialization = 'pending';
          await fail(id, new CanopyOperationError(OWNER_REFUSED));
          connection.close(OWNER_REFUSED);
          return;
        }
        owner = true;
      }
    }
    try {
      const caller = options.callerFor(identity());
      if (method === INITIALIZE) {
        if (initialization !== 'none')
          throw new CanopyOperationError({
            kind: 'failed_precondition',
            message: 'The connection is already initialized.',
            retry: { kind: 'never' },
          });
        initialization = 'pending';
        const result = await initialize(request, caller).catch(
          async (error: unknown) => {
            await fail(id, error);
            // A version mismatch fails the whole connection closed.
            connection.close(errorPayload(error));
            return null;
          },
        );
        if (!result) return;
        advertised = new Set([
          ...result.capabilities.operations,
          ...result.capabilities.streams,
        ]);
        initialization = 'done';
        return await send({ jsonrpc: '2.0', id, result });
      }
      if (initialization !== 'done')
        throw new CanopyOperationError({
          kind: 'failed_precondition',
          message: 'Call core.runtime.initialize first.',
          retry: { kind: 'never' },
        });
      if (!advertised.has(method)) throw canopyPermissionDeniedError();
      if (leaseMethod)
        return await send({
          jsonrpc: '2.0',
          id,
          result: lease(leaseMethod, request, caller),
        });
      if (kind !== 'stream')
        return await dispatch(request, kind === 'query', caller);
      if (leaseBound.has(method) && !leases.lease(connection.connectionId))
        throw new CanopyOperationError(LEASE_REQUIRED);
      return await stream(request, caller);
    } catch (error) {
      return fail(id, error);
    }
  };

  void (async (): Promise<void> => {
    for (;;) {
      const message = await connection.receive().catch(() => null);
      if (!message || planeSignal.aborted) break;
      // Reverse RPC and client notifications are not served yet.
      if (!('method' in message) || !('id' in message)) continue;
      if (active >= maxActive) {
        // Awaited, so a peer that stops reading stops being read.
        await fail(
          message.id,
          new CanopyOperationError({
            kind: 'resource_exhausted',
            message: 'Too many requests in flight on this connection.',
            retry: { kind: 'same_request', delayMs: 100 },
          }),
        );
        continue;
      }
      active += 1;
      void serve(message).finally(() => {
        active -= 1;
      });
    }
    // Detached only once frames buffered before the close have been served:
    // lease operations apply synchronously, so a release sent just before
    // hanging up ends the lease as released, and an acquire starts the grace.
    leases.detach(connection.connectionId);
  })();
}

/**
 * One plane instance's leases, registrations, channels and connections.
 * Instances share nothing, so a second instance never sees the first's state.
 */
function createControlServing(options: CanopyControlServingOptions): {
  readonly leases: CanopyLeaseRegistry;
  readonly serve: (connection: CanopyFramedConnection) => void;
  readonly close: () => void;
} {
  const clock = options.clock ?? CANOPY_SYSTEM_CLOCK;
  const { maxActiveRequests } = options;
  if (
    maxActiveRequests !== undefined &&
    (!Number.isSafeInteger(maxActiveRequests) || maxActiveRequests < 1)
  )
    throw new RangeError('maxActiveRequests must be a positive integer.');
  const leases = createCanopyLeaseRegistry(options.leases, clock);
  const registrations = createCanopyLeaseRegistrations(leases);
  // A lease never gets more channels than one connection may hold.
  const channels = createCanopyChannelRegistry(leases, {
    maxChannelsPerLease: Math.min(
      options.channels?.maxChannelsPerLease ??
        CANOPY_DEFAULT_MAX_CHANNELS_PER_LEASE,
      resolveCanopyChannelLimits(options.connection).maxChannels,
    ),
  });
  const connections = new Set<CanopyFramedConnection>();
  const closing = new AbortController();
  return {
    leases,
    serve: (connection): void => {
      if (closing.signal.aborted) return connection.close();
      connections.add(connection);
      connection.signal.addEventListener(
        'abort',
        () => connections.delete(connection),
        { once: true },
      );
      serveControlConnection(
        connection,
        options,
        leases,
        channels,
        registrations,
        closing.signal,
      );
    },
    close: (): void => {
      if (closing.signal.aborted) return;
      closing.abort();
      connections.forEach((connection) => connection.close());
      channels.close();
      registrations.close();
      leases.close();
    },
  };
}

/**
 * The daemon control plane (doc 17 §W2): authenticated framed connections,
 * per-connection `core.runtime.initialize` negotiation, connection-bound
 * client leases, and the idle grace that asks the host to stop.
 */
export function serveCanopyDaemonControlPlane(
  options: CanopyDaemonControlPlaneOptions,
): CanopyDaemonControlPlane {
  const serving = createControlServing(options);
  const obligations = createCanopyObligationRegistry();
  const idle = startCanopyIdleGrace(
    serving.leases,
    obligations,
    options.onIdle,
    options.idleGrace,
    options.clock ?? CANOPY_SYSTEM_CLOCK,
  );
  let closed = false;
  acceptCanopyFramedConnections({
    listener: options.binding.listener,
    auth: options.binding.auth,
    connection: options.connection,
    onConnection: serving.serve,
  }).done.catch(() => {
    if (!closed) options.onAcceptFailed?.();
  });
  return {
    leases: serving.leases,
    obligations,
    close: (): Promise<void> => {
      closed = true;
      idle.close();
      serving.close();
      return Promise.resolve();
    },
  };
}

/**
 * Serves one stream the host admitted out of band as its own plane instance:
 * every request runs as the admitted caller, never through `callerFor`. The
 * daemon plane's obligation is held from this call until the session ends.
 */
export function serveCanopyControlStream(
  options: CanopyControlStreamOptions,
): CanopyControlStreamSession {
  const { caller } = options;
  const serving = createControlServing({
    dispatcher: options.dispatcher,
    operations: options.operations,
    callerFor: () => caller,
    buildVersion: options.buildVersion,
    leases: options.leases,
    channels: options.channels,
    connection: options.connection,
    maxActiveRequests: options.maxActiveRequests,
    leaseBoundOperations: options.leaseBoundOperations,
    sameKeyFencedOperations: options.sameKeyFencedOperations,
    clock: options.clock,
  });
  const release = options.obligations.hold('control stream');
  let settle = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    serving.close();
    release();
    settle();
  };
  const duplex = platformStreamDuplex(options.stream);
  let connected = false;
  void (async (): Promise<void> => {
    try {
      const connection = await createCanopyFramedConnection(duplex, {
        maxMessageBytes: CANOPY_MAX_MESSAGE_BYTES,
        ...options.connection,
        role: 'server',
        auth: options.auth,
      });
      if (ended) return connection.close();
      connected = true;
      serving.serve(connection);
      connection.signal.addEventListener('abort', end, { once: true });
      if (connection.signal.aborted) end();
    } catch {
      duplex.destroy();
      end();
    }
  })();
  return {
    done,
    close: (): Promise<void> => {
      // A served connection closes with the serving state; a handshake does not.
      if (!connected) duplex.destroy();
      end();
      return done;
    },
  };
}
