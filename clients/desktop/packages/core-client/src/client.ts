// Browser-safe: protocol values plus transport types only.
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CANOPY_HOST_EXECUTION_MEMBER,
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CANOPY_JSON_RPC_VERSION,
  CanopyOperationNameSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  CORE_CLIENT_LEASE_EVICTED,
  CoreClientLeaseEvictedSchema,
  composeCanopyOperationEnvelopes,
  safeParseCanopySchema,
  type CanopyErrorPayload,
  type CanopyInstructionDefinition,
  type CanopyInstructionDefinitionMap,
  type CanopyJsonRpcErrorResponse,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcNotification,
  type CanopyJsonRpcRequest,
  type CanopyJsonRpcSuccessResponse,
  type CanopyOperationEnvelopes,
  type CanopyQueryDefinition,
  type CanopyQueryDefinitionMap,
  type CanopyRetryDirective,
  type CanopySchema,
  type CanopyStreamCursor,
  type CanopyStreamDefinition,
  type CanopyStreamDefinitionMap,
  type CoreClientLeaseEvicted,
} from '@canopy/protocol/canopy-core';

import { AbandonedIds } from './abandoned-ids';
import {
  CANOPY_CLIENT_PROTOCOL_VERSIONS,
  CanopyClientError,
  MAX_ERROR_MESSAGE_LENGTH,
  decodeCanopyClientResponseError,
  toCanopyClientError,
} from './errors';
import {
  acceptCanopyInitializeResult,
  buildCanopyInitializeParams,
  toCanopyInitializeError,
  type CanopyAcceptedInitialize,
} from './handshake';
import { PendingFrames } from './pending-frames';
import {
  ByteBudget,
  CONNECTION_BUDGET_BYTES,
  StreamBudget,
  TERMINAL_RESERVATION_BYTES,
  encodedSize,
} from './stream-budget';
import type {
  CanopyClient,
  CanopyClientDefinitions,
  CanopyClientOptions,
  CanopyClientStreamFrame,
  CanopyClientStreamHandle,
  CanopyClientStreamOptions,
} from './types';

type Definition =
  | CanopyQueryDefinition
  | CanopyInstructionDefinition
  | CanopyStreamDefinition;
type Frame = CanopyClientStreamFrame<unknown, unknown>;
type StreamHandle = CanopyClientStreamHandle<unknown, unknown>;
type Response = CanopyJsonRpcSuccessResponse | CanopyJsonRpcErrorResponse;
type WideDefinitions = CanopyClientDefinitions<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
>;
type WideClient = CanopyClient<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
>;
interface CallOptions {
  readonly metadata?: object;
  readonly signal?: AbortSignal;
  readonly execution?: object;
  readonly headers?: Readonly<Record<string, string>>;
}
interface PendingCall {
  respond(response: Response): void;
  fail(error: CanopyClientError): void;
}
interface RequestSpec<T> {
  readonly signal?: AbortSignal;
  readonly headers?: Readonly<Record<string, string>>;
  readonly deadlineAt?: number;
  readonly definition?: Definition;
  accept(response: Response): T;
  /** The call `id` was given up before its reply: abort or deadline. */
  abandoned?(id: number): void;
}

const INITIALIZE = 'core.runtime.initialize';
const UNSUBSCRIBE = 'core.events.unsubscribe';
// Late replies to abandoned calls are matched exactly. Contiguous ids share a
// range; a core that fragments them past this bound closes the session rather
// than letting the client forget an id or accept a stray reply.
const MAX_ABANDONED_RANGES = 1_024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
// Matches the in-process dispatcher's per-stream bound.
const MAX_BUFFERED_STREAM_ITEMS = 1_024;
// Refused opens stay routable until their remote end; past either bound the
// session fails closed rather than forget an id the core may still reuse.
const MAX_REFUSED_STREAMS = 1_024;
const MAX_REFUSED_ID_BYTES = 1024 * 1024;
// Locally ended streams the core still serves; the oldest past it is
// forgotten, and its frames are then only held while an open waits.
const MAX_ORPHANED_STREAMS = 1_024;

function clientError(
  kind: CanopyErrorPayload['kind'],
  message: string,
  retry: CanopyRetryDirective = { kind: 'never' },
): CanopyClientError {
  return new CanopyClientError({
    kind,
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    retry,
  });
}

const cancelled = (): CanopyClientError =>
  clientError('cancelled', 'The operation was cancelled.');
const deadlineExceeded = (): CanopyClientError =>
  clientError('deadline_exceeded', 'The request deadline passed.', {
    kind: 'same_request',
  });

const streamBufferExhausted = (): CanopyClientError =>
  clientError('resource_exhausted', 'Stream buffer capacity exceeded.', {
    kind: 'after_refresh',
    resource: 'stream',
  });

/** A call lost to disconnect or deadline may have run; retry follows idempotency. */
function forDefinition(
  error: CanopyClientError,
  definition: Definition | undefined,
): CanopyClientError {
  const { payload } = error;
  if (
    !definition ||
    definition.idempotency === 'inherent' ||
    payload.retry.kind !== 'same_request'
  )
    return error;
  return new CanopyClientError({
    ...payload,
    retry:
      definition.idempotency === 'keyed'
        ? { ...payload.retry, kind: 'same_idempotency_key' }
        : { kind: 'never' },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownDefinition<D extends Definition>(
  map: Readonly<Record<string, D>>,
  name: string,
): D | undefined {
  return Object.prototype.hasOwnProperty.call(map, name)
    ? map[name]
    : undefined;
}

function onDeadline(deadlineAt: number, fire: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const remaining = deadlineAt - Date.now();
    timer = setTimeout(
      remaining > MAX_TIMER_DELAY_MS ? arm : fire,
      Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS)),
    );
  };
  arm();
  return () => clearTimeout(timer);
}

/** Close must not wait on a send the transport never settles. */
function untilSettledOrAborted(
  promise: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      signal.removeEventListener('abort', settle);
      resolve();
    };
    signal.addEventListener('abort', settle, { once: true });
    void promise.then(settle);
  });
}

/** A locally generated end; only `cancelled` is not an error. */
function endFrame(error: CanopyClientError, cursor: CanopyStreamCursor): Frame {
  const { kind } = error.payload;
  return {
    kind: 'end',
    cursor,
    outcome: kind === 'cancelled' ? 'cancelled' : 'error',
    error: error.payload,
  };
}

interface StreamSpec {
  readonly name: string;
  readonly definition: CanopyStreamDefinition;
  readonly notification: CanopySchema;
  readonly options: CanopyClientStreamOptions<Frame>;
  readonly deadlineAt?: number;
  /** Holds the terminal reservation from admission. */
  readonly budget: StreamBudget;
  /**
   * Removes the stream from its session's routing table. `orphaned`: it ended
   * locally, so the core may still send its frames.
   */
  readonly forget: (orphaned: boolean) => void;
}

/** A stream opened by the core but refused locally; its frames are dropped. */
type RefusedStream = Pick<StreamSpec, 'name' | 'definition' | 'notification'>;

/** A buffered frame and the bytes it holds against both budgets. */
interface Entry {
  readonly frame: Frame;
  readonly bytes: number;
}

/**
 * One subscription on one connection. The receive loop never waits on it:
 * undelivered frames are bounded by count and encoded bytes, and listener
 * errors are contained. Close, abort, and deadline end it locally and later
 * frames are dropped. A core that lists `core.events.unsubscribe` is asked to
 * drop the subscription (CAN-5970); any other core's handler runs until its
 * own end.
 */
class ClientStream {
  readonly handle: StreamHandle;
  private readonly queue: Entry[] = [];
  private readonly listeners = new Set<(frame: Frame) => void>();
  private readonly waiters: (() => void)[] = [];
  private consumption: 'pull' | 'push' | null = null;
  /** An end is queued; its reservation became that end's charge. */
  private ended = false;
  /** The end was consumed or cancelled; nothing more is delivered. */
  private settled = false;
  private draining = false;
  private delivered: CanopyStreamCursor;
  private readonly releaseDeadline: () => void = () => {};
  private readonly onAbort = (): void => this.cancel(cancelled());

  /** `cursor` starts at the accepted cursor or a local-only sentinel. */
  constructor(
    private readonly spec: StreamSpec,
    private cursor: CanopyStreamCursor,
    opened: Pick<StreamHandle, 'requestId' | 'openResult'>,
  ) {
    this.delivered = cursor;
    const { onFrame, signal } = spec.options;
    if (onFrame) {
      this.consumption = 'push';
      this.listeners.add(onFrame);
    }
    signal?.addEventListener('abort', this.onAbort, { once: true });
    if (spec.deadlineAt !== undefined)
      this.releaseDeadline = onDeadline(spec.deadlineAt, () =>
        this.cancel(deadlineExceeded()),
      );
    this.handle = {
      ...opened,
      frames: {
        [Symbol.asyncIterator]: (): AsyncIterator<Frame> => this.iterate(),
      },
      onFrame: (listener): (() => void) => this.subscribe(listener),
      close: (): void =>
        this.cancel(clientError('cancelled', 'The stream was closed.')),
    };
  }

  receive(message: CanopyJsonRpcNotification): void {
    const { name, definition, notification, budget } = this.spec;
    const malformed = (): void =>
      this.terminate(
        clientError('internal', `The core sent a malformed ${name} frame.`),
      );
    if (!safeParseCanopySchema(notification, message).success)
      return malformed();
    const { params } = message;
    if (message.method === `${name}.end`) {
      const fields = Object.fromEntries(
        Object.entries(params).filter(([key]) => key !== 'subscriptionId'),
      );
      const parsed = safeParseCanopySchema(definition.end, fields);
      const end: Record<string, unknown> =
        parsed.success && isRecord(parsed.data) ? parsed.data : {};
      const base = CanopyStreamEndSchema.safeParse({
        cursor: end.cursor,
        outcome: end.outcome,
        error: end.error,
      });
      if (!base.success) return malformed();
      const frame: Frame = { ...end, ...base.data, kind: 'end' };
      return this.finish(frame, encodedSize(message), false);
    }
    const item = safeParseCanopySchema(definition.item, params.item);
    const cursor = CanopyStreamCursorSchema.safeParse(params.cursor);
    if (!item.success || !cursor.success) return malformed();
    const bytes = encodedSize(message);
    // Ends at the last accepted item, so a resume from its cursor skips nothing.
    if (this.queue.length >= MAX_BUFFERED_STREAM_ITEMS || !budget.admit(bytes))
      return this.terminate(streamBufferExhausted());
    this.cursor = cursor.data;
    const frame: Frame = { kind: 'item', cursor: cursor.data, item: item.data };
    this.append({ frame, bytes });
  }

  /**
   * Ends locally at the last accepted cursor after any queued frames; only
   * `cancelled` is not an error.
   */
  terminate(error: CanopyClientError): void {
    const frame = endFrame(error, this.cursor);
    this.finish(frame, encodedSize(frame), true);
  }

  /**
   * Close, abort, and deadline discard every unread frame, even a queued end,
   * and release all charges at once: unlike the in-process queue, so a
   * cancelled handle nobody drains cannot starve its siblings. The one
   * uncharged end is at the last delivered cursor.
   */
  private cancel(error: CanopyClientError): void {
    if (this.settled) return;
    this.settle();
    const { budget } = this.spec;
    if (!this.ended) budget.release(TERMINAL_RESERVATION_BYTES);
    this.ended = true;
    this.spec.forget(true);
    this.queue.splice(0).forEach(({ bytes }) => budget.release(bytes));
    this.append({ frame: endFrame(error, this.delivered), bytes: 0 });
  }

  /**
   * Converts the reservation into the end's charge. An end that does not fit
   * becomes `resource_exhausted` at the last accepted cursor, which the
   * reservation always holds. Abort and deadline stay armed until it is read.
   */
  private finish(frame: Frame, bytes: number, orphaned: boolean): void {
    if (this.ended) return;
    this.ended = true;
    this.spec.forget(orphaned);
    const { budget } = this.spec;
    if (budget.admit(bytes, TERMINAL_RESERVATION_BYTES))
      return this.append({ frame, bytes });
    const exhausted = endFrame(streamBufferExhausted(), this.cursor);
    const size = encodedSize(exhausted);
    const held = budget.admit(size, TERMINAL_RESERVATION_BYTES);
    this.append({
      frame: exhausted,
      bytes: held ? size : TERMINAL_RESERVATION_BYTES,
    });
  }

  private append(entry: Entry): void {
    this.queue.push(entry);
    this.waiters.splice(0).forEach((wake) => wake());
    this.drain();
  }

  /** Releases the next frame's charge as it is delivered. */
  private next(): Frame | undefined {
    const entry = this.queue.shift();
    if (!entry) return undefined;
    const { frame, bytes } = entry;
    this.spec.budget.release(bytes);
    this.delivered = frame.cursor;
    if (frame.kind === 'end') this.settle();
    return frame;
  }

  private settle(): void {
    this.settled = true;
    this.releaseDeadline();
    this.spec.options.signal?.removeEventListener('abort', this.onAbort);
  }

  private drain(): void {
    // A listener that re-enters (close, subscribe) is served by the outer loop.
    if (this.draining) return;
    this.draining = true;
    try {
      for (
        let frame = this.listeners.size ? this.next() : undefined;
        frame;
        frame = this.listeners.size ? this.next() : undefined
      )
        for (const listener of Array.from(this.listeners))
          try {
            listener(frame);
          } catch {
            // A failing consumer must not stop the receive loop or its siblings.
          }
    } finally {
      this.draining = false;
    }
  }

  private subscribe(listener: (frame: Frame) => void): () => void {
    if (this.consumption === 'pull')
      throw clientError(
        'failed_precondition',
        'Stream frames are consumed by the frames iterator.',
      );
    this.consumption = 'push';
    this.listeners.add(listener);
    this.drain();
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Leaving early keeps the subscription live and bounded, as in process; a
   * later iterator resumes in order. Only `close()` or an end releases it.
   */
  private async *iterate(): AsyncGenerator<Frame, void, undefined> {
    if (this.consumption === 'push')
      throw clientError(
        'failed_precondition',
        'Stream frames are consumed by onFrame listeners.',
      );
    this.consumption = 'pull';
    for (;;) {
      const frame = this.next();
      if (frame) {
        yield frame;
        if (frame.kind === 'end') return;
      } else if (this.ended) return;
      else await new Promise<void>((wake) => this.waiters.push(wake));
    }
  }
}

class ClientSession {
  readonly done: Promise<void>;
  accepted: CanopyAcceptedInitialize | null = null;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly abandoned = new AbandonedIds();
  private readonly envelopes = new Map<string, CanopyOperationEnvelopes>();
  private readonly streams = new Map<string, ClientStream>();
  private readonly refused = new Map<string, RefusedStream>();
  private readonly early = new PendingFrames();
  /** Locally ended subscriptions awaiting the core's end, by stream name. */
  private readonly orphans = new Map<string, string>();
  /** Stream opens given up before their reply, by request id. */
  private readonly abandonedOpens = new Map<number, string>();
  private refusedIdBytes = 0;
  private readonly budget = new ByteBudget(CONNECTION_BUDGET_BYTES);
  private closeReason: CanopyClientError | null = null;
  readonly leaseEvictions = new Set<(event: CoreClientLeaseEvicted) => void>();

  constructor(
    private readonly connection: CanopyFramedConnection,
    private readonly definitions: WideDefinitions,
  ) {
    this.done = this.receiveLoop();
  }

  request<T>(
    method: string,
    params: Record<string, unknown>,
    spec: RequestSpec<T>,
  ): Promise<T> {
    const local = (error: CanopyClientError): CanopyClientError =>
      forDefinition(error, spec.definition);
    const name = CanopyOperationNameSchema.safeParse(method);
    if (!name.success)
      return Promise.reject(
        clientError('invalid_argument', `Invalid method ${method}.`),
      );
    if (this.closeReason) return Promise.reject(local(this.closeReason));
    if (spec.signal?.aborted) return Promise.reject(cancelled());
    if (spec.deadlineAt !== undefined && spec.deadlineAt <= Date.now())
      return Promise.reject(local(deadlineExceeded()));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      // Opted-in keyed instructions may commit after local cancellation.
      const sameKeyOnAbandon =
        spec.definition?.kind === 'instruction' &&
        spec.definition.idempotency === 'keyed' &&
        spec.definition.abandonedRetry === 'same_idempotency_key';
      const interrupted = (error: CanopyClientError): CanopyClientError =>
        error.payload.kind === 'cancelled' && sameKeyOnAbandon
          ? clientError(
              'unavailable',
              'The response was abandoned; the operation may have completed. Retry with the same idempotency key.',
              { kind: 'same_idempotency_key' },
            )
          : local(error);
      let releaseDeadline = (): void => {};
      const release = (): void => {
        releaseDeadline();
        spec.signal?.removeEventListener('abort', onAbort);
      };
      const abandon = (error: CanopyClientError): void => {
        if (!this.pending.delete(id)) return;
        this.rememberAbandoned(id);
        spec.abandoned?.(id);
        release();
        reject(error);
      };
      const onAbort = (): void => abandon(interrupted(cancelled()));
      // Registered before sending, so no reply can outrun its call.
      this.pending.set(id, {
        respond: (response) => {
          release();
          try {
            resolve(spec.accept(response));
          } catch (error) {
            reject(toCanopyClientError(error));
          }
        },
        fail: (error) => {
          release();
          reject(interrupted(error));
        },
      });
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      if (spec.deadlineAt !== undefined)
        releaseDeadline = onDeadline(spec.deadlineAt, () =>
          abandon(local(deadlineExceeded())),
        );
      this.connection
        .send(
          {
            jsonrpc: CANOPY_JSON_RPC_VERSION,
            id,
            method: name.data,
            params,
          },
          spec.headers === undefined ? undefined : { headers: spec.headers },
        )
        .catch((error: unknown) => {
          const failure = toCanopyClientError(error);
          // A cancelled send may have delivered the request before failing.
          // Keep its id routable so a late reply cannot poison the session.
          if (sameKeyOnAbandon && failure.payload.kind === 'cancelled')
            return abandon(interrupted(failure));
          if (!this.pending.delete(id)) return;
          release();
          reject(local(failure));
        });
    });
  }

  async call(
    kind: 'query' | 'instruction',
    name: string,
    params: unknown,
    options: CallOptions,
  ): Promise<unknown> {
    const definition =
      kind === 'query'
        ? ownDefinition(this.definitions.queries, name)
        : ownDefinition(this.definitions.instructions, name);
    const prepared = this.prepare(kind, definition, name, params, options);
    return this.request(name, prepared.params, {
      ...prepared,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      accept: (response) => {
        if ('error' in response)
          throw this.operationError(prepared.definition, response.error);
        const result = safeParseCanopySchema(
          prepared.definition.result,
          response.result,
        );
        if (!result.success)
          throw clientError('internal', `${name} returned an invalid result.`);
        return result.data;
      },
    });
  }

  async openStream(
    name: string,
    params: unknown,
    options: CanopyClientStreamOptions<Frame>,
  ): Promise<StreamHandle> {
    const definition = ownDefinition(this.definitions.streams, name);
    const prepared = this.prepare('stream', definition, name, params, options);
    const { notification } = prepared.envelopes;
    const { openResult } = prepared.definition;
    if (!notification || !openResult)
      throw clientError('internal', `${name} has an incomplete definition.`);
    const pending = this.early.begin();
    // Runs inside the receive loop: the stream is routable before the next
    // frame, after the frames that outran this reply.
    const accept = (response: Response): StreamHandle => {
      if ('error' in response)
        throw this.operationError(prepared.definition, response.error);
      const parsed = safeParseCanopySchema(openResult, response.result);
      const opened: Record<string, unknown> =
        parsed.success && isRecord(parsed.data) ? parsed.data : {};
      const { subscriptionId } = opened;
      const accepted = CanopyStreamCursorSchema.nullish().safeParse(
        opened.acceptedCursor,
      );
      if (typeof subscriptionId !== 'string' || !accepted.success)
        throw clientError(
          'internal',
          `${name} returned an invalid open result.`,
        );
      // An error or invalid reply settles below, dropping them once no open
      // waits.
      const early = this.early.settle(pending, subscriptionId);
      if (
        this.streams.has(subscriptionId) ||
        this.refused.has(subscriptionId)
      ) {
        const reused = clientError(
          'internal',
          'The core reused an active stream subscription.',
        );
        this.failClosed(reused);
        throw reused;
      }
      // Reserved before any listener or timer exists, so refusal leaks nothing.
      const budget = StreamBudget.open(this.budget);
      if (!budget) {
        const route = { name, definition: prepared.definition, notification };
        const retained = this.retainRefused(subscriptionId, route);
        // A held end frees the id it would otherwise keep.
        if (retained)
          early.forEach((message) => this.dropRefused(subscriptionId, message));
        const exhausted = clientError(
          'resource_exhausted',
          retained
            ? 'Stream buffer capacity on this connection is exhausted.'
            : 'Too many refused streams are awaiting their end.',
          { kind: 'after_refresh', resource: 'stream' },
        );
        if (!retained) this.failClosed(exhausted);
        throw exhausted;
      }
      const acceptedCursor = accepted.data ?? null;
      const daemonEpoch = this.accepted?.identity.daemonEpoch ?? '';
      // A local-only "nothing observed" sentinel; never sent as a resume cursor.
      const cursor = acceptedCursor ?? { daemonEpoch, sequence: 0 };
      const stream = new ClientStream(
        {
          ...prepared,
          name,
          notification,
          options,
          budget,
          forget: (orphaned): void => {
            if (this.streams.get(subscriptionId) !== stream) return;
            this.streams.delete(subscriptionId);
            if (orphaned) this.orphan(subscriptionId, name);
          },
        },
        cursor,
        {
          requestId: String(response.id),
          openResult: { subscriptionId, acceptedCursor },
        },
      );
      // The core may reuse an orphaned id; the new stream takes it.
      this.orphans.delete(subscriptionId);
      this.streams.set(subscriptionId, stream);
      // Ends at its accepted cursor, so a resume from it skips nothing.
      if (pending.overflowed) stream.terminate(streamBufferExhausted());
      else
        for (const message of early) {
          // Routing stops at an end, as it does for frames off the wire.
          if (this.streams.get(subscriptionId) !== stream) break;
          stream.receive(message);
        }
      return stream.handle;
    };
    const opening = this.request(name, prepared.params, {
      ...prepared,
      accept,
      // Its late reply names a subscription the core serves: an orphan.
      abandoned: (id) => {
        this.abandonedOpens.set(id, name);
        const oldest = this.abandonedOpens.keys().next().value;
        if (
          this.abandonedOpens.size > MAX_ORPHANED_STREAMS &&
          oldest !== undefined
        )
          this.abandonedOpens.delete(oldest);
      },
    });
    // Releases an open whose reply is an error, never comes, or never
    // registers. A side chain, so the handle resolves on the same turn.
    const settle = (): unknown => this.early.settle(pending);
    opening.then(settle, settle);
    return opening;
  }

  close(reason?: CanopyClientError): Promise<void> {
    this.shutdown(reason ?? clientError('cancelled', 'The client was closed.'));
    this.connection.close(reason?.payload);
    return this.done;
  }

  /** Local gates and validation; failures never reach the wire. */
  private prepare<D extends Definition>(
    kind: 'query' | 'instruction' | 'stream',
    definition: D | undefined,
    name: string,
    params: unknown,
    options: CallOptions,
  ): {
    definition: D;
    envelopes: CanopyOperationEnvelopes;
    params: Record<string, unknown>;
    deadlineAt?: number;
    signal?: AbortSignal;
  } {
    if (this.closeReason) throw forDefinition(this.closeReason, definition);
    const manifestKind = kind === 'stream' ? 'streams' : 'operations';
    if (!definition || !this.accepted?.manifest.has(manifestKind, name))
      throw clientError(
        'capability_unavailable',
        `${name} is not available on this connection.`,
      );
    const cacheKey = `${kind}:${name}`;
    let envelopes = this.envelopes.get(cacheKey);
    if (!envelopes) {
      try {
        envelopes = composeCanopyOperationEnvelopes(name, definition);
      } catch {
        throw clientError('internal', `${name} has an incomplete definition.`);
      }
      this.envelopes.set(cacheKey, envelopes);
    }
    // `_execution` comes only from the typed option, never from params.
    const wireParams =
      isRecord(params) &&
      !Object.prototype.hasOwnProperty.call(
        params,
        CANOPY_HOST_EXECUTION_MEMBER,
      )
        ? {
            ...params,
            ...(options.metadata === undefined
              ? {}
              : { _meta: options.metadata }),
            ...(options.execution === undefined
              ? {}
              : { [CANOPY_HOST_EXECUTION_MEMBER]: options.execution }),
          }
        : null;
    const request = { jsonrpc: '2.0', id: 0, method: name, params: wireParams };
    if (!wireParams || !envelopes.request.safeParse(request).success)
      throw clientError(
        'invalid_argument',
        `Invalid ${name} parameters or request metadata.`,
      );
    // Read from the validated wire params: `_meta` may come from either source.
    const meta = wireParams._meta;
    const deadline =
      isRecord(meta) && typeof meta.deadlineAt === 'string'
        ? Date.parse(meta.deadlineAt)
        : undefined;
    return {
      definition,
      envelopes,
      params: wireParams,
      deadlineAt: deadline,
      signal: options.signal,
    };
  }

  /** Errors outside the operation's declared schema fail closed as `internal`. */
  private operationError(
    definition: Definition,
    error: unknown,
  ): CanopyClientError {
    const decoded = decodeCanopyClientResponseError(error);
    return safeParseCanopySchema(definition.error, decoded.payload).success
      ? decoded
      : clientError('internal', 'The core returned an undeclared error.');
  }

  private async receiveLoop(): Promise<void> {
    let reply: Promise<void> | null = null;
    while (!this.closeReason) {
      let message: CanopyJsonRpcMessage;
      try {
        message = await this.connection.receive();
      } catch (error) {
        return this.shutdown(toCanopyClientError(error));
      }
      if (this.closeReason) return;
      if (!('method' in message)) {
        this.onResponse(message);
        continue;
      }
      if (!('id' in message)) {
        if (message.method === CORE_CLIENT_LEASE_EVICTED) {
          const parsed = CoreClientLeaseEvictedSchema.safeParse(message.params);
          if (!parsed.success)
            return this.failClosed(
              clientError('internal', 'Invalid lease eviction notification.'),
            );
          this.leaseEvictions.forEach((listener) => {
            try {
              listener(parsed.data);
            } catch {
              /* Isolate lifecycle observers. */
            }
          });
          continue;
        }
        // Unknown or locally ended subscriptions are never answered; their
        // frames are held while an open waits for its reply, else dropped.
        const { subscriptionId } = message.params;
        if (typeof subscriptionId !== 'string') continue;
        const stream = this.streams.get(subscriptionId);
        if (stream) stream.receive(message);
        else if (this.refused.has(subscriptionId))
          this.dropRefused(subscriptionId, message);
        else if (this.orphans.has(subscriptionId)) {
          // Dropped, never held: no open claims them. Any end frees the id;
          // a stray one only lets later frames be held, never delivered.
          if (message.method === `${this.orphans.get(subscriptionId)}.end`)
            this.orphans.delete(subscriptionId);
        } else this.early.hold(subscriptionId, message);
        continue;
      }
      // One reply in flight: a core that stops draining stops being read.
      if (reply) await untilSettledOrAborted(reply, this.signal);
      if (this.closeReason) return;
      reply = this.replyMethodNotFound(message.id);
    }
  }

  /** A subscription the core may still serve that nothing here reads. */
  private orphan(subscriptionId: string, name: string): void {
    this.orphans.set(subscriptionId, name);
    // Refused locally, never sent, unless both the definitions and the
    // core's manifest list it. A later turn, outside the receive loop.
    void Promise.resolve()
      .then(() => this.call('instruction', UNSUBSCRIBE, { subscriptionId }, {}))
      .catch(() => {});
    const oldest = this.orphans.keys().next().value;
    if (this.orphans.size > MAX_ORPHANED_STREAMS && oldest !== undefined)
      this.orphans.delete(oldest);
  }

  /** False when retaining the id would pass a bound. */
  private retainRefused(subscriptionId: string, route: RefusedStream): boolean {
    const bytes = this.refusedIdBytes + encodedSize(subscriptionId);
    if (
      this.refused.size >= MAX_REFUSED_STREAMS ||
      bytes > MAX_REFUSED_ID_BYTES
    )
      return false;
    this.refused.set(subscriptionId, route);
    this.refusedIdBytes = bytes;
    return true;
  }

  /** Drops a refused stream's frames; only its valid end frees the id. */
  private dropRefused(
    subscriptionId: string,
    message: CanopyJsonRpcNotification,
  ): void {
    const route = this.refused.get(subscriptionId);
    if (
      !route ||
      message.method !== `${route.name}.end` ||
      !safeParseCanopySchema(route.notification, message).success
    )
      return;
    const fields = Object.fromEntries(
      Object.entries(message.params).filter(
        ([key]) => key !== 'subscriptionId',
      ),
    );
    const end = safeParseCanopySchema(route.definition.end, fields);
    if (!end.success || !isRecord(end.data)) return;
    const { cursor, outcome, error } = end.data;
    if (!CanopyStreamEndSchema.safeParse({ cursor, outcome, error }).success)
      return;
    this.refused.delete(subscriptionId);
    this.refusedIdBytes -= encodedSize(subscriptionId);
  }

  /**
   * This client serves no methods; answer as any JSON-RPC peer would. The
   * constant message keeps an arbitrarily long method name off the wire.
   */
  private replyMethodNotFound(id: CanopyJsonRpcRequest['id']): Promise<void> {
    return this.connection
      .send({
        jsonrpc: CANOPY_JSON_RPC_VERSION,
        id,
        error: {
          code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
          message: 'Method not found.',
        },
      })
      .catch(() => {});
  }

  private onResponse(response: Response): void {
    const { id } = response;
    if (typeof id === 'number') {
      const call = this.pending.get(id);
      if (call) {
        this.pending.delete(id);
        return call.respond(response);
      }
      // Taking an interior id splits its range, so the bound is checked here too.
      if (this.abandoned.take(id)) {
        const name = this.abandonedOpens.get(id);
        this.abandonedOpens.delete(id);
        const result = 'result' in response ? response.result : undefined;
        const subscriptionId = isRecord(result) && result.subscriptionId;
        if (name && typeof subscriptionId === 'string')
          this.orphan(subscriptionId, name);
        return this.boundAbandoned();
      }
    }
    this.failClosed(
      clientError(
        'internal',
        'The core sent a response to no outstanding request.',
      ),
    );
  }

  private rememberAbandoned(id: number): void {
    this.abandoned.add(id);
    this.boundAbandoned();
  }

  private boundAbandoned(): void {
    if (this.abandoned.rangeCount <= MAX_ABANDONED_RANGES) return;
    this.failClosed(
      clientError(
        'resource_exhausted',
        'Too many cancelled requests are awaiting late replies.',
        { kind: 'same_request' },
      ),
    );
  }

  private failClosed(error: CanopyClientError): void {
    this.shutdown(error);
    this.connection.close(error.payload);
  }

  private shutdown(reason: CanopyClientError): void {
    if (this.closeReason) return;
    this.closeReason = reason;
    this.controller.abort(reason);
    const calls = Array.from(this.pending.values());
    this.pending.clear();
    calls.forEach((call) => call.fail(reason));
    const streams = Array.from(this.streams.values());
    this.streams.clear();
    streams.forEach((stream) => stream.terminate(reason));
    this.refused.clear();
    this.early.clear();
    this.orphans.clear();
    this.abandonedOpens.clear();
    this.leaseEvictions.clear();
    this.refusedIdBytes = 0;
  }
}

/**
 * Connects a typed facade over an authenticated framed connection: runs
 * `core.runtime.initialize`, then correlates queries, instructions, and
 * stream opens and frames on one receive loop. The client owns the
 * connection; a failed handshake closes it.
 */
export function createCanopyClient<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = Record<never, never>,
  S extends CanopyStreamDefinitionMap = Record<never, never>,
>(options: CanopyClientOptions<Q, I, S>): Promise<CanopyClient<Q, I, S>>;
export async function createCanopyClient(
  options: CanopyClientOptions<
    CanopyQueryDefinitionMap,
    CanopyInstructionDefinitionMap,
    CanopyStreamDefinitionMap
  >,
): Promise<WideClient> {
  const { connection, signal } = options;
  const protocolVersions =
    options.protocolVersions ?? CANOPY_CLIENT_PROTOCOL_VERSIONS;
  const session = new ClientSession(connection, options.definitions);
  try {
    if (signal?.aborted) throw cancelled();
    signal?.addEventListener('abort', () => void session.close(cancelled()), {
      once: true,
      signal: session.signal,
    });
    const params = buildCanopyInitializeParams({
      clientName: options.clientName,
      clientVersion: options.clientVersion,
      protocolVersions,
      clientCapabilities: options.clientCapabilities ?? [],
      ...(connection.maxMessageBytes !== undefined && {
        maxMessageBytes: connection.maxMessageBytes,
      }),
      ...(options.ownerProof && {
        ownerProof: options.ownerProof(connection.connectionId),
      }),
    });
    session.accepted = await session.request(INITIALIZE, params, {
      signal,
      accept: (response) => {
        if ('error' in response)
          throw toCanopyInitializeError(
            decodeCanopyClientResponseError(response.error),
            protocolVersions,
          );
        return acceptCanopyInitializeResult(response.result, {
          protocolVersions,
          connectionId: connection.connectionId,
        });
      },
    });
  } catch (error) {
    const failure = toCanopyClientError(error);
    await session.close(failure);
    throw failure;
  }
  const { runtime, identity, manifest, peerMaxMessageBytes } = session.accepted;
  if (peerMaxMessageBytes !== null)
    connection.allowPeerMessageBytes?.(peerMaxMessageBytes);
  return {
    connection,
    runtime,
    identity,
    manifest,
    signal: session.signal,
    onLeaseEvicted: (listener) => {
      session.leaseEvictions.add(listener);
      return () => void session.leaseEvictions.delete(listener);
    },
    query: (name, params, callOptions = {}) =>
      session.call('query', name, params, callOptions),
    instruction: (name, params, callOptions = {}) =>
      session.call('instruction', name, params, callOptions),
    openStream: (name, params, streamOptions = {}) =>
      session.openStream(name, params, streamOptions),
    close: () => session.close(),
  };
}
