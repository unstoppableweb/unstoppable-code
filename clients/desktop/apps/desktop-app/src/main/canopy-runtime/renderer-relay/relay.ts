import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createCanopyClient,
  createCanopyClientLease,
  type CanopyClient,
  type CanopyClientLease,
  type CanopyClientLeaseIdentity,
  type CanopyClientStreamFrame,
  type CanopyClientStreamHandle,
} from '@canopy/core-client';
import {
  CanopyErrorPayloadSchema,
  CanopyOperationNameSchema,
  CanopyRequestMetadataSchema,
  type CanopyCallerDescriptor,
  type CanopyErrorKind,
  type CanopyErrorPayload,
  type CanopyRequestMetadata,
  type CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';
import {
  relayRetryFor,
  type CanopyCoreRelayReply,
} from '../../../shared/canopy-core-relay';
import type { DesktopIpcEvent, DesktopIpcSender } from '../desktop-ipc-caller';
import {
  RELAY_DEFINITIONS,
  type RelayBindingConnection,
  type RelayBindingProvider,
  type RelayDefinitions,
} from './definitions';
import type {
  InterfaceRelayAccessMode,
  InterfaceRelayOperationKind,
} from './interface-allowlist.generated';
import {
  isAdminMethod,
  relayAllows,
  type RendererRelaySurface,
} from './surface-allowlist';

export interface RendererRelayLimits {
  /** UTF-8 bytes of a JSON-encoded request input. */
  readonly maxFrameBytes: number;
  /** UTF-8 bytes of a JSON-encoded reply value or stream frame. */
  readonly maxReplyBytes: number;
  readonly maxConcurrentCalls: number;
  readonly maxOpenStreams: number;
  /** Bounds connection setup plus each request, stream open, and stream read. */
  readonly deadlineMs: number;
}

export const RENDERER_RELAY_LIMITS: RendererRelayLimits = {
  maxFrameBytes: 1024 * 1024,
  maxReplyBytes: 1024 * 1024,
  maxConcurrentCalls: 32,
  maxOpenStreams: 16,
  deadlineMs: 30_000,
};

/** Structurally satisfied by Electron's `WebContents`. */
export interface RendererRelaySender extends DesktopIpcSender {
  on(
    event: 'destroyed' | 'render-process-gone' | 'did-navigate',
    listener: () => void,
  ): unknown;
  removeListener(
    event: 'destroyed' | 'render-process-gone' | 'did-navigate',
    listener: () => void,
  ): unknown;
}

export interface RendererRelayEvent extends DesktopIpcEvent {
  sender: RendererRelaySender;
}

export interface RendererRelaySurfaceResolution {
  readonly surface: RendererRelaySurface;
  /** The trusted host caller; its grants bound the renderer principal's grants. */
  readonly caller: CanopyCallerDescriptor;
}

export interface RendererRelayOptions {
  readonly bindingProvider: RelayBindingProvider;
  /** Runs on every invocation; throws for an untrusted sender or main-frame URL. */
  readonly resolveSurface: (
    event: RendererRelayEvent,
  ) => RendererRelaySurfaceResolution;
  readonly accessMode?: InterfaceRelayAccessMode;
  /** What this relay can reach; defaults to the local core's `RELAY_DEFINITIONS`. */
  readonly definitions?: RelayDefinitions;
  /**
   * Replaces the generated interface allowlist (and `accessMode`) for an
   * authority that is not the local core. Admin methods stay refused.
   */
  readonly allows?: RendererRelayAllows;
  /**
   * Narrows what an allowed request may carry: a message refuses it as
   * `invalid_argument` before it leaves main; `null` lets it through.
   */
  readonly refuseParams?: (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => string | null;
  /**
   * The params an allowed request is sent with, after `refuseParams`: drops
   * what main cannot honour for the renderer.
   */
  readonly narrowParams?: (method: string, params: RelayParams) => RelayParams;
  /**
   * Refuses an allowed call with this payload, or lets it through with
   * `null`. Unlike `allows` it is read on every call, never cached in a
   * session's definitions, so it can follow a flag that changes.
   */
  readonly refuseCall?: (method: string) => CanopyErrorPayload | null;
  /**
   * The minor schema revision main asks for, by stream (protocol rule 5):
   * a stream opens with `revision` only when the connection's manifest
   * advertises that revision, as the web client's `withRevision` does.
   */
  readonly streamRevisions?: Readonly<Record<string, number>>;
  readonly host?: RendererRelayHostOptions;
  readonly clientVersion?: string;
  readonly limits?: Partial<RendererRelayLimits>;
}

/**
 * What an authority needs from the host beyond relaying (the web core):
 * operations only the host calls on the session's client, a client lease
 * held for the session's life, and acknowledgement of each stream item once
 * its frame is handed to the renderer.
 */
export interface RendererRelayHostOptions {
  /** Never renderer-callable: the renderer's requests resolve only against `definitions`. */
  readonly definitions: RelayDefinitions;
  readonly lease?: {
    readonly label: string;
    readonly interfaceKind: CanopyClientLeaseIdentity['interfaceKind'];
  };
  readonly ackDelivered?: boolean;
}

export type RendererRelayAllows = (
  surface: RendererRelaySurface,
  kind: InterfaceRelayOperationKind,
  method: string,
) => boolean;

export interface RendererRelay {
  invoke(
    event: RendererRelayEvent,
    input: unknown,
  ): Promise<CanopyCoreRelayReply>;
  dispose(): void;
}

const MethodSchema = z
  .string()
  .max(256)
  .refine((name) => CanopyOperationNameSchema.safeParse(name).success);
const ParamsSchema = z.record(z.string(), z.json());
const SubscriptionIdSchema = z.string().min(1).max(128);
const RelayRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('request'),
    method: MethodSchema,
    params: ParamsSchema,
  }),
  z.strictObject({
    kind: z.literal('openStream'),
    method: MethodSchema,
    params: ParamsSchema,
  }),
  z.strictObject({
    kind: z.literal('readStream'),
    subscriptionId: SubscriptionIdSchema,
  }),
  z.strictObject({
    kind: z.literal('closeStream'),
    subscriptionId: SubscriptionIdSchema,
  }),
  z.strictObject({ kind: z.literal('close') }),
]);
type RelayRequest = z.output<typeof RelayRequestSchema>;
type RelayParams = Record<string, unknown>;

const hasOwn = (map: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

class RelayFailure extends Error {
  constructor(readonly payload: CanopyErrorPayload) {
    super(payload.message);
  }
}

const NEVER: CanopyRetryDirective = { kind: 'never' };
/** Proposal only; the core's replies set the actual renewal timing. */
const LEASE_RENEWAL_MS = 30_000;
const UNSUBSCRIBE = 'core.events.unsubscribe';
const failure = (
  kind: CanopyErrorKind,
  message: string,
  retry: CanopyRetryDirective = NEVER,
): RelayFailure => new RelayFailure({ kind, message, retry });
const connectionClosed = (retry: CanopyRetryDirective = NEVER): RelayFailure =>
  failure('unavailable', 'The renderer relay connection closed.', retry);

/** Typed payloads keep kind, message, code, and retry; `details` and untyped errors never reach the renderer. */
function toPayload(error: unknown): CanopyErrorPayload {
  if (error instanceof RelayFailure) return error.payload;
  if (typeof error === 'object' && error !== null && 'payload' in error) {
    const parsed = CanopyErrorPayloadSchema.safeParse(error.payload);
    if (parsed.success) {
      const { kind, message, code, retry } = parsed.data;
      return code === undefined
        ? { kind, message, retry }
        : { kind, message, code, retry };
    }
  }
  return {
    kind: 'internal',
    message: 'The relay request failed.',
    retry: NEVER,
  };
}

function encodedBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
  } catch {
    return null;
  }
}

const deadlineExceeded = (
  retry: CanopyRetryDirective = { kind: 'same_request' },
): RelayFailure =>
  failure('deadline_exceeded', 'The relay deadline passed.', retry);

/** Settles with `work`, or rejects at the deadline or when `signal` aborts; `work` keeps running. */
function raceDeadline<T>(
  work: Promise<T>,
  signal: AbortSignal,
  deadlineMs?: number,
  recovery?: CanopyRetryDirective,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(connectionClosed(recovery));
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const onAbort = (): void =>
      finish(() => reject(connectionClosed(recovery)));
    const timer =
      deadlineMs === undefined
        ? undefined
        : setTimeout(
            () => finish(() => reject(deadlineExceeded(recovery))),
            deadlineMs,
          );
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) =>
        finish(() =>
          reject(
            error instanceof Error ? error : new RelayFailure(toPayload(error)),
          ),
        ),
    );
  });
}

type RelayFrame = CanopyClientStreamFrame<unknown, unknown>;

/** A reply value, and what runs once the reply carrying it is handed over. */
interface Dispatched {
  readonly value: unknown;
  readonly onDelivered?: () => void;
}

interface RelayStream {
  readonly handle: CanopyClientStreamHandle<unknown, unknown>;
  readonly iterator: AsyncIterator<RelayFrame>;
  /** A read that passed its deadline leaves its pull here for the next read. */
  next: Promise<IteratorResult<RelayFrame>> | null;
  reading: boolean;
}

class RelaySession {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  client: Promise<CanopyClient> | null = null;
  connection: RelayBindingConnection | null = null;
  lease: CanopyClientLease<CanopyClient> | null = null;
  calls = 0;
  openingStreams = 0;
  /** The client sends `core.events.unsubscribe` when a stream is released. */
  unsubscribes = false;
  readonly streams = new Map<string, RelayStream>();

  constructor(
    readonly surface: RendererRelaySurface,
    readonly caller: CanopyCallerDescriptor,
    readonly webContentsId: number,
    private readonly detach: () => void,
  ) {}

  get closed(): boolean {
    return this.signal.aborted;
  }

  close(): void {
    if (this.closed) return;
    this.controller.abort();
    this.detach();
    this.streams.forEach((stream) => stream.handle.close());
    this.streams.clear();
    void this.lease?.release('normal_shutdown');
    this.lease = null;
    this.connection?.close();
    void this.client?.then(
      (client) => client.close(),
      () => undefined,
    );
    this.client = null;
  }

  /** Forgets a stream whose end was delivered; the hook, when present, also frees a locally ended one. */
  endStream(id: string, stream: RelayStream): void {
    if (this.streams.get(id) === stream) this.streams.delete(id);
    this.connection?.releaseStream?.(
      stream.handle.openResult.subscriptionId,
      'ended',
    );
    stream.handle.close();
  }

  /** Abandons a stream the core may still be serving. */
  cancelStream(id: string, stream: RelayStream): void {
    if (this.streams.get(id) === stream) this.streams.delete(id);
    this.releaseHandle(stream.handle);
  }

  releaseHandle(handle: CanopyClientStreamHandle<unknown, unknown>): void {
    const { connection } = this;
    if (!this.closed && connection?.releaseStream) {
      try {
        connection.releaseStream(
          handle.openResult.subscriptionId,
          this.unsubscribes ? 'unsubscribed' : 'cancelled',
        );
      } catch {
        this.close();
      }
    } else this.close();
    handle.close();
  }
}

/**
 * Relays renderer calls to a core connection owned per sender. Each
 * connection authenticates as `local-desktop-renderer:<surface>` with a fresh
 * client instance id and the trusted caller's grants narrowed to the surface.
 */
export function createRendererRelay(
  options: RendererRelayOptions,
): RendererRelay {
  const limits: RendererRelayLimits = {
    ...RENDERER_RELAY_LIMITS,
    ...options.limits,
  };
  const accessMode = options.accessMode ?? 'authority';
  const relayDefinitions = options.definitions ?? RELAY_DEFINITIONS;
  const allowOverride = options.allows;
  const sessions = new Map<RendererRelaySender, RelaySession>();
  const surfaceDefinitions = new Map<RendererRelaySurface, RelayDefinitions>();
  let disposed = false;

  const allows = (
    surface: RendererRelaySurface,
    kind: InterfaceRelayOperationKind,
    method: string,
  ): boolean =>
    allowOverride
      ? !isAdminMethod(method) && allowOverride(surface, kind, method)
      : relayAllows(surface, kind, method, accessMode);

  function pick<D>(
    map: Readonly<Record<string, D>>,
    surface: RendererRelaySurface,
    kind: InterfaceRelayOperationKind,
  ): Record<string, D> {
    return Object.fromEntries(
      Object.entries(map).filter(([name]) => allows(surface, kind, name)),
    );
  }

  function definitionsFor(surface: RendererRelaySurface): RelayDefinitions {
    let definitions = surfaceDefinitions.get(surface);
    if (!definitions) {
      definitions = {
        queries: pick(relayDefinitions.queries, surface, 'query'),
        instructions: pick(
          relayDefinitions.instructions,
          surface,
          'instruction',
        ),
        streams: pick(relayDefinitions.streams, surface, 'stream'),
      };
      surfaceDefinitions.set(surface, definitions);
    }
    return definitions;
  }

  /** The renderer's surface definitions plus the host-only ones. */
  function clientDefinitions(surface: RendererRelaySurface): RelayDefinitions {
    const surfaceDefinitions = definitionsFor(surface);
    const host = options.host?.definitions;
    if (!host) return surfaceDefinitions;
    return {
      queries: { ...surfaceDefinitions.queries, ...host.queries },
      instructions: {
        ...surfaceDefinitions.instructions,
        ...host.instructions,
      },
      streams: { ...surfaceDefinitions.streams, ...host.streams },
    };
  }

  function rendererCaller(
    resolved: RendererRelaySurfaceResolution,
  ): CanopyCallerDescriptor {
    const definitions = definitionsFor(resolved.surface);
    const required = new Set(
      [
        ...Object.values(definitions.queries),
        ...Object.values(definitions.instructions),
        ...Object.values(definitions.streams),
      ].flatMap((definition) => definition.requiredGrants),
    );
    return {
      principalId: `local-desktop-renderer:${resolved.surface}`,
      clientInstanceId: `renderer-relay:${randomUUID()}`,
      authorityId: resolved.caller.authorityId,
      interfaceKind: resolved.caller.interfaceKind,
      grants: Array.from(new Set(resolved.caller.grants)).filter((grant) =>
        required.has(grant),
      ),
    };
  }

  function sessionFor(event: RendererRelayEvent): RelaySession {
    let resolved: RendererRelaySurfaceResolution;
    try {
      resolved = options.resolveSurface(event);
    } catch {
      throw failure('permission_denied', 'Untrusted renderer.');
    }
    const { sender } = event;
    const existing = sessions.get(sender);
    if (existing?.surface === resolved.surface && !existing.closed)
      return existing;
    existing?.close();
    if (sender.isDestroyed())
      throw failure('permission_denied', 'Untrusted renderer.');

    const onGone = (): void => session.close();
    const session = new RelaySession(
      resolved.surface,
      rendererCaller(resolved),
      sender.id,
      () => {
        sender.removeListener('destroyed', onGone);
        sender.removeListener('render-process-gone', onGone);
        sender.removeListener('did-navigate', onGone);
        if (sessions.get(sender) === session) sessions.delete(sender);
      },
    );
    sender.on('destroyed', onGone);
    sender.on('render-process-gone', onGone);
    // Navigation start can be cancelled; only a committed new document retires identity.
    sender.on('did-navigate', onGone);
    sessions.set(sender, session);
    return session;
  }

  async function connect(session: RelaySession): Promise<CanopyClient> {
    const { signal } = session;
    const binding = options.bindingProvider({
      caller: session.caller,
      webContentsId: session.webContentsId,
      signal,
    });
    // A binding that settles after disconnect is closed on arrival.
    signal.addEventListener(
      'abort',
      () =>
        void binding.then(
          (connection) => connection.close(),
          () => undefined,
        ),
      { once: true },
    );
    const connection: RelayBindingConnection = await raceDeadline(
      binding,
      signal,
    );
    session.connection = connection;
    const close = (): void => session.close();
    connection.signal.addEventListener('abort', close, { once: true });
    signal.addEventListener(
      'abort',
      () => connection.signal.removeEventListener('abort', close),
      { once: true },
    );
    if (connection.signal.aborted) session.close();
    const client = await createCanopyClient({
      connection,
      clientName: 'canopy-desktop-renderer-relay',
      clientVersion: options.clientVersion ?? '0.0.0',
      definitions: clientDefinitions(session.surface),
      signal,
    });
    // The shared client's own rule: its definitions and the manifest list it.
    session.unsubscribes =
      hasOwn(clientDefinitions(session.surface).instructions, UNSUBSCRIBE) &&
      client.manifest.has('operations', UNSUBSCRIBE);
    client.signal.addEventListener('abort', close, { once: true });
    signal.addEventListener(
      'abort',
      () => client.signal.removeEventListener('abort', close),
      { once: true },
    );
    if (client.signal.aborted) session.close();
    if (options.host?.lease)
      await holdLease(session, client, options.host.lease);
    return client;
  }

  /** Acquires right after the handshake; the session ends with the lease. */
  async function holdLease(
    session: RelaySession,
    client: CanopyClient,
    identity: NonNullable<RendererRelayHostOptions['lease']>,
  ): Promise<void> {
    const lease = createCanopyClientLease({
      client,
      // The session never replaces its client: a dropped connection ends it.
      attach: () => Promise.reject(connectionClosed()),
      identity: {
        clientInstanceId: session.caller.clientInstanceId,
        interfaceKind: identity.interfaceKind,
        label: identity.label,
      },
      renewalIntervalMs: LEASE_RENEWAL_MS,
      presence: () => ({ interactive: true, foreground: true }),
      onError: () => {
        if (lease.state === 'failed' || lease.state === 'released')
          session.close();
      },
    });
    session.lease = lease;
    if (session.closed) void lease.release('normal_shutdown');
    await lease.acquire();
  }

  /**
   * One lazy setup per connection, shared by concurrent calls. A failure is
   * retried by the next call; a setup past the deadline closes the session.
   */
  function clientFor(session: RelaySession): Promise<CanopyClient> {
    if (session.closed) return Promise.reject(connectionClosed());
    if (!session.client) {
      const pending = connect(session);
      session.client = pending;
      const timer = setTimeout(() => session.close(), limits.deadlineMs);
      pending.then(
        () => clearTimeout(timer),
        () => {
          clearTimeout(timer);
          if (session.client === pending) session.client = null;
        },
      );
    }
    return session.client;
  }

  /** Splits renderer `_meta` from params; requests carry the relay deadline unless the renderer's is sooner. */
  function splitMetadata(
    params: RelayParams,
    withDeadline: boolean,
  ): { params: RelayParams; metadata?: CanopyRequestMetadata } {
    const { _meta: meta, ...rest } = params;
    const parsed = CanopyRequestMetadataSchema.safeParse(meta ?? {});
    if (!parsed.success)
      throw failure('invalid_argument', 'Invalid request metadata.');
    if (!withDeadline)
      return {
        params: rest,
        metadata: meta === undefined ? undefined : parsed.data,
      };
    const relayDeadline = Date.now() + limits.deadlineMs;
    const requested = parsed.data.deadlineAt
      ? Date.parse(parsed.data.deadlineAt)
      : relayDeadline;
    const deadlineAt = new Date(
      Math.min(requested, relayDeadline),
    ).toISOString();
    return { params: rest, metadata: { ...parsed.data, deadlineAt } };
  }

  /** Reserves a call slot synchronously; the returned release is idempotent. */
  function reserveCall(session: RelaySession): () => void {
    if (session.calls >= limits.maxConcurrentCalls)
      throw failure('resource_exhausted', 'Too many concurrent relay calls.', {
        kind: 'after_refresh',
        resource: 'relay',
      });
    session.calls += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.calls -= 1;
    };
  }

  const unavailable = (method: string): RelayFailure =>
    failure('capability_unavailable', `${method} is not available here.`);

  function refuseCall(method: string): void {
    const refusal = options.refuseCall?.(method) ?? null;
    if (refusal !== null) throw new RelayFailure(refusal);
  }

  function requestRecovery(method: string): CanopyRetryDirective {
    if (hasOwn(relayDefinitions.queries, method))
      return { kind: 'same_request' };
    const definition = hasOwn(relayDefinitions.instructions, method)
      ? relayDefinitions.instructions[method]
      : undefined;
    if (definition?.idempotency === 'keyed')
      return { kind: 'same_idempotency_key' };
    return definition?.idempotency === 'inherent'
      ? { kind: 'same_request' }
      : NEVER;
  }

  async function request(
    session: RelaySession,
    method: string,
    rawParams: RelayParams,
  ): Promise<unknown> {
    const kind = hasOwn(relayDefinitions.queries, method)
      ? 'query'
      : hasOwn(relayDefinitions.instructions, method)
        ? 'instruction'
        : null;
    if (!kind || !allows(session.surface, kind, method))
      throw unavailable(method);
    refuseCall(method);
    const split = splitMetadata(rawParams, true);
    const refusal = options.refuseParams?.(method, split.params) ?? null;
    if (refusal !== null) throw failure('invalid_argument', refusal);
    const params = options.narrowParams?.(method, split.params) ?? split.params;
    const { metadata } = split;
    const release = reserveCall(session);
    const callOptions = { metadata, signal: session.signal };
    // The slot is held until the client settles the call, at its deadline at the latest.
    const work = clientFor(session).then((client) =>
      kind === 'query'
        ? client.query(method, params, callOptions)
        : client.instruction(method, params, callOptions),
    );
    work.then(release, release);
    return raceDeadline(
      work,
      session.signal,
      limits.deadlineMs,
      requestRecovery(method),
    );
  }

  /** The stream's params with the revision the manifest advertises, if any. */
  function withStreamRevision(
    client: CanopyClient,
    method: string,
    params: RelayParams,
  ): RelayParams {
    const revisions = options.streamRevisions;
    const revision =
      revisions !== undefined && hasOwn(revisions, method)
        ? revisions[method]
        : undefined;
    const advertised = client.manifest.schemaRevisions?.get(method) ?? 1;
    return revision !== undefined && advertised >= revision
      ? { ...params, revision }
      : params;
  }

  /**
   * Reservations are held until the open settles, so abandoned opens stay
   * counted. An open that settles after its caller gave up is released on
   * arrival; adoption is decided in that same callback.
   */
  function openStream(
    session: RelaySession,
    method: string,
    rawParams: RelayParams,
  ): Promise<unknown> {
    if (
      !hasOwn(relayDefinitions.streams, method) ||
      !allows(session.surface, 'stream', method)
    )
      throw unavailable(method);
    refuseCall(method);
    const { params, metadata } = splitMetadata(rawParams, false);
    if (session.streams.size + session.openingStreams >= limits.maxOpenStreams)
      throw failure('resource_exhausted', 'Too many open relay streams.', {
        kind: 'after_refresh',
        resource: 'stream',
      });
    const releaseCall = reserveCall(session);
    session.openingStreams += 1;
    const opening = clientFor(session).then((client) =>
      client.openStream(method, withStreamRevision(client, method, params), {
        metadata,
      }),
    );
    return new Promise((resolve, reject) => {
      let settled = false;
      const giveUp = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.signal.removeEventListener('abort', onAbort);
        reject(error);
      };
      const onAbort = (): void => giveUp(connectionClosed());
      const timer = setTimeout(
        () => giveUp(deadlineExceeded()),
        limits.deadlineMs,
      );
      session.signal.addEventListener('abort', onAbort, { once: true });
      if (session.closed) onAbort();
      const unreserve = (): void => {
        session.openingStreams -= 1;
        releaseCall();
      };
      opening.then(
        (handle) => {
          unreserve();
          if (settled || session.closed) {
            session.releaseHandle(handle);
            return giveUp(connectionClosed());
          }
          settled = true;
          clearTimeout(timer);
          session.signal.removeEventListener('abort', onAbort);
          const subscriptionId = randomUUID();
          session.streams.set(subscriptionId, {
            handle,
            iterator: handle.frames[Symbol.asyncIterator](),
            next: null,
            reading: false,
          });
          resolve({
            subscriptionId,
            acceptedCursor: handle.openResult.acceptedCursor,
          });
        },
        (error: unknown) => {
          unreserve();
          giveUp(
            error instanceof Error ? error : new RelayFailure(toPayload(error)),
          );
        },
      );
    });
  }

  /** Acks an item once its reply is handed over, unless the stream was released meanwhile. */
  function ackOnDelivery(
    session: RelaySession,
    subscriptionId: string,
    stream: RelayStream,
    frame: RelayFrame,
  ): (() => void) | undefined {
    if (!options.host?.ackDelivered || frame.kind !== 'item') return undefined;
    return () => {
      const client = session.client;
      if (
        session.closed ||
        !client ||
        session.streams.get(subscriptionId) !== stream
      )
        return;
      void client
        .then((connected) =>
          connected.instruction(
            'core.events.ack',
            {
              subscriptionId: stream.handle.openResult.subscriptionId,
              cursor: frame.cursor,
            },
            { signal: session.signal },
          ),
        )
        .catch(() => undefined);
    };
  }

  async function readStream(
    session: RelaySession,
    subscriptionId: string,
  ): Promise<Dispatched> {
    const stream = session.streams.get(subscriptionId);
    if (!stream) throw failure('not_found', 'Unknown relay stream.');
    if (stream.reading)
      throw failure('failed_precondition', 'A read is already pending.');
    const release = reserveCall(session);
    stream.reading = true;
    try {
      stream.next ??= stream.iterator.next();
      let result: IteratorResult<RelayFrame>;
      try {
        result = await raceDeadline(
          stream.next,
          session.signal,
          limits.deadlineMs,
        );
      } catch (error) {
        // Deadline and close keep the pending pull; a failed pull ends the stream.
        if (!(error instanceof RelayFailure)) {
          stream.next = null;
          session.cancelStream(subscriptionId, stream);
        }
        throw error;
      }
      stream.next = null;
      if (result.done) {
        session.endStream(subscriptionId, stream);
        return { value: null };
      }
      const frame = result.value;
      const bytes = encodedBytes(frame);
      if (bytes === null || bytes > limits.maxReplyBytes) {
        if (frame.kind === 'end') session.endStream(subscriptionId, stream);
        else session.cancelStream(subscriptionId, stream);
        throw failure(
          'resource_exhausted',
          'A stream frame exceeded the relay cap.',
          { kind: 'after_refresh', resource: 'stream' },
        );
      }
      if (frame.kind === 'end') session.endStream(subscriptionId, stream);
      return {
        value: frame,
        onDelivered: ackOnDelivery(session, subscriptionId, stream, frame),
      };
    } finally {
      stream.reading = false;
      release();
    }
  }

  async function dispatch(
    session: RelaySession,
    input: RelayRequest,
  ): Promise<Dispatched> {
    switch (input.kind) {
      case 'close':
        session.close();
        return { value: null };
      case 'closeStream': {
        const stream = session.streams.get(input.subscriptionId);
        if (!stream) throw failure('not_found', 'Unknown relay stream.');
        session.cancelStream(input.subscriptionId, stream);
        return { value: null };
      }
      case 'request':
        return { value: await request(session, input.method, input.params) };
      case 'openStream':
        return {
          value: await openStream(session, input.method, input.params),
        };
      case 'readStream':
        return readStream(session, input.subscriptionId);
    }
  }

  function parseRequest(input: unknown): RelayRequest {
    const bytes = encodedBytes(input);
    if (bytes === null)
      throw failure('invalid_argument', 'The relay request is not JSON.');
    if (bytes > limits.maxFrameBytes)
      throw failure(
        'resource_exhausted',
        'The relay request exceeded the cap.',
        {
          kind: 'after_refresh',
          resource: 'request',
        },
      );
    const parsed = RelayRequestSchema.safeParse(input);
    if (!parsed.success)
      throw failure('invalid_argument', 'Invalid relay request.');
    return parsed.data;
  }

  return {
    async invoke(event, input): Promise<CanopyCoreRelayReply> {
      let method: string | undefined;
      try {
        if (disposed)
          throw failure('unavailable', 'The renderer relay is closed.');
        const session = sessionFor(event);
        const request = parseRequest(input);
        if (request.kind === 'request') method = request.method;
        const { value, onDelivered } = await dispatch(session, request);
        // Results never cross an identity change: a closed connection drops
        // them. Close requests carry no result and may close it themselves.
        const closes =
          request.kind === 'close' || request.kind === 'closeStream';
        const recovery =
          request.kind === 'request' ? requestRecovery(request.method) : NEVER;
        if (session.closed && !closes) throw connectionClosed(recovery);
        const bytes = encodedBytes(value);
        if (bytes === null || bytes > limits.maxReplyBytes)
          throw failure(
            'resource_exhausted',
            'The relay reply exceeded the cap.',
            recovery.kind === 'same_idempotency_key'
              ? recovery
              : {
                  kind: 'after_refresh',
                  resource: 'reply',
                },
          );
        onDelivered?.();
        return { ok: true, value: value ?? null };
      } catch (error) {
        // One exit for every layer's failure: dispatcher, binding and relay.
        const payload = toPayload(error);
        return {
          ok: false,
          error: { ...payload, retry: relayRetryFor(method, payload.retry) },
        };
      }
    },
    dispose(): void {
      disposed = true;
      Array.from(sessions.values()).forEach((session) => session.close());
      sessions.clear();
    },
  };
}
