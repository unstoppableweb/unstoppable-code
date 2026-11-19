import {
  CANOPY_HOST_EXECUTION_MEMBER,
  CanopyCallerDescriptorSchema,
  CanopyJsonRpcMessageSchema,
  CanopyJsonRpcRequestSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  decodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyHostExecution,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcNotification,
  type CanopyJsonRpcRequest,
  type CanopyOperationEnvelopes,
  type CanopyRequestMetadata,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from './dispatcher';
import type {
  CanopyHandlerContext,
  CanopyStreamSink,
  InProcessCanopyClient,
} from './types';
import {
  parseWorkerExecutorReceipt,
  type WorkerExecutorReceipt,
} from './worker-executor-receipts';
import {
  CanopyOperationError,
  canopyCancelledError,
  canopyCapabilityUnavailableError,
  canopyDeadlineExceededError,
  canopyInvalidArgumentError,
  canopyInvalidHandlerResultError,
  canopyUnavailableError,
} from './errors';
import {
  bindOperations,
  CANCEL_METHOD,
  capacityError,
  directed,
  MAX_PENDING,
  MAX_STREAMS,
  RECEIPT_METHOD,
  RELEASE_METHOD,
  subscriptionOf,
  transportStopError,
  type BoundOperation,
  type CallKind,
  type WorkerBindingConnection,
  type WorkerBindingDefinitions,
} from './local-worker-binding-wire';

// `execution` crosses only to this same-host worker (CAN-5496); a transport
// to any other target must drop or refuse it.
type ForwardedContext = Pick<
  CanopyHandlerContext,
  'metadata' | 'signal' | 'execution' | 'workerSettlement'
>;
type ForwardedCall = (
  params: unknown,
  context: ForwardedContext,
) => Promise<unknown>;
type ForwardedStream = (
  params: unknown,
  context: ForwardedContext,
  sink: CanopyStreamSink<unknown>,
) => Promise<() => void>;

/** Core-dispatcher handlers that reach the worker only across the binding. */
export interface InProcessWorkerBindingForwarders {
  readonly queries: Readonly<Record<string, ForwardedCall>>;
  readonly instructions: Readonly<Record<string, ForwardedCall>>;
  readonly streams: Readonly<Record<string, ForwardedStream>>;
}

/** The core half of a local worker binding. */
export interface LocalWorkerBindingClient extends InProcessCanopyClient {
  readonly forwarders: InProcessWorkerBindingForwarders;
  /** Aborts once the binding has stopped; the reason is the typed error. */
  readonly signal: AbortSignal;
  /**
   * Asks the worker how a keyed instruction it was sent settled, waiting for
   * a running one; null when it never arrived. Never sends it again.
   */
  receipt(
    operation: string,
    idempotencyKey: string,
  ): Promise<WorkerExecutorReceipt | null>;
  /** The core recorded the outcome; the worker may forget its receipt. */
  releaseReceipt(operation: string, idempotencyKey: string): void;
  close(error?: CanopyOperationError): void;
}

export interface ConnectLocalWorkerBindingOptions {
  /** The worker's maps, exactly as its dispatcher declares them. */
  readonly definitions: WorkerBindingDefinitions;
  /** The trusted owning core, checked by the direct stream API. */
  readonly caller: CanopyCallerDescriptor;
  /** The core end of the binding. */
  readonly connection: WorkerBindingConnection;
  /**
   * Resolves once the worker process has exited. A stopped binding proves
   * nothing about a handler still running in the worker, so a keyed
   * instruction whose receipt can no longer be read counts as settled only
   * once this resolves; without it, never.
   */
  readonly workerExited?: Promise<unknown>;
}

type EnvelopeSchema = CanopyOperationEnvelopes['request'];
interface PendingCall {
  reply(message: CanopyJsonRpcMessage): void;
  fail(error: CanopyOperationError): void;
}
interface StreamRoute {
  readonly name: string;
  readonly requestId: string;
  readonly notification: EnvelopeSchema;
  /** Null once the stream ended locally; later worker frames are dropped. */
  sink: CanopyStreamSink<unknown> | null;
  release(): void;
}
interface CallOptions {
  metadata?: CanopyRequestMetadata;
  signal?: AbortSignal;
  execution?: CanopyHostExecution;
  /** Handed a promise that resolves once the worker itself settles the call. */
  workerSettlement?: (settled: Promise<void>) => void;
}

const EndOutcomeSchema = CanopyStreamEndSchema.pick({
  outcome: true,
  error: true,
});

/**
 * Carries worker queries, instructions and streams from the core over
 * `connection` to a worker serving the same definitions. Cancellation
 * crosses as a binding-private notification.
 */
export function connectLocalWorkerBinding({
  definitions,
  caller: callerInput,
  connection,
  workerExited,
}: ConnectLocalWorkerBindingOptions): LocalWorkerBindingClient {
  const caller = CanopyCallerDescriptorSchema.parse(callerInput);
  Object.freeze(caller.grants);
  Object.freeze(caller);
  const operations = bindOperations(definitions);
  const pending = new Map<string, PendingCall>();
  const routes = new Map<string, StreamRoute>();
  const stopped = new AbortController();
  let sequence = 0;
  let closed = false;
  let openingStreams = 0;
  let requestSends = 0;
  const stop = (error: CanopyOperationError): void => {
    if (closed) return;
    closed = true;
    connection.signal.removeEventListener('abort', disconnected);
    pending.forEach((call) => call.fail(error));
    pending.clear();
    const open = Array.from(routes.values());
    routes.clear();
    for (const route of open) {
      const { sink } = route;
      route.sink = null;
      route.release();
      sink?.end('error', error.payload);
    }
    // Published before the close, as the worker half does.
    stopped.abort(error);
    connection.close(error.payload);
  };
  const disconnected = (): void => stop(canopyUnavailableError());
  const transportFailure = (error: unknown): void =>
    stop(transportStopError(error));

  const sendCancel = (requestId: string): void => {
    if (closed) return;
    void connection
      .send({ jsonrpc: '2.0', method: CANCEL_METHOD, params: { requestId } })
      .catch(transportFailure);
  };
  const transmit = (request: CanopyJsonRpcRequest): void => {
    requestSends += 1;
    void connection
      .send(request)
      .catch((error: unknown) => {
        if (connection.signal.aborted) return transportFailure(error);
        // Refused before a byte was written, such as too large to send:
        // only this call fails and the binding stays open.
        const id = String(request.id);
        const call = pending.get(id);
        pending.delete(id);
        call?.fail(transportStopError(error));
      })
      .finally(() => {
        requestSends -= 1;
      });
  };
  const admit = (
    kind: CallKind,
    name: string,
    params: unknown,
    { metadata, signal, execution }: CallOptions,
  ): {
    id: string;
    request: CanopyJsonRpcRequest;
    operation: BoundOperation;
    deadlineAt: number | undefined;
  } => {
    const operation = operations[kind].get(name);
    if (closed)
      throw operation
        ? directed(operation.definition, canopyUnavailableError())
        : canopyUnavailableError();
    if (!operation) throw canopyCapabilityUnavailableError();
    const id = `worker-request-${++sequence}`;
    let request: CanopyJsonRpcRequest;
    try {
      const parsed = operation.definition.params.parse(params);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new Error('Operation params must be an object');
      request = CanopyJsonRpcRequestSchema.parse({
        jsonrpc: '2.0',
        id,
        method: name,
        params: {
          ...parsed,
          ...(metadata === undefined ? {} : { _meta: metadata }),
          // The composed envelope admits it only on opted-in operations.
          ...(execution === undefined
            ? {}
            : { [CANOPY_HOST_EXECUTION_MEMBER]: execution }),
        },
      });
      operation.envelopes.request.parse(request);
    } catch {
      throw canopyInvalidArgumentError('Invalid worker transport request.');
    }
    if (signal?.aborted) throw canopyCancelledError();
    const deadline = request.params._meta?.deadlineAt;
    const deadlineAt =
      deadline === undefined ? undefined : Date.parse(deadline);
    if (deadlineAt !== undefined && deadlineAt <= Date.now())
      throw directed(operation.definition, canopyDeadlineExceededError());
    if (pending.size >= MAX_PENDING || requestSends >= MAX_PENDING)
      throw capacityError('Worker request capacity exceeded.');
    return { id, request, operation, deadlineAt };
  };
  /**
   * Resolves once the worker's handler has settled. A result reply means it
   * did; an error reply may be the worker dispatcher's own cancel or
   * deadline cutting the reply short, so a keyed instruction's executor
   * receipt is awaited, which waits while the handler still runs.
   */
  const workerSettled = async (
    name: string,
    { metadata }: CallOptions,
    workerReplied: Promise<boolean>,
  ): Promise<void> => {
    const succeeded = await workerReplied;
    const key =
      metadata && 'idempotencyKey' in metadata
        ? metadata.idempotencyKey
        : undefined;
    if (succeeded || key === undefined) return;
    // A refused lookup, such as one over capacity, proves nothing: ask again.
    for (let delayMs = 25; ; delayMs = Math.min(delayMs * 2, 1_000)) {
      const answered = await receipt(name, key).then(
        () => true,
        () => false,
      );
      if (answered) return;
      if (closed) {
        // The worker can say no more, but its handler may still be running:
        // only the worker's exit proves it has stopped.
        await (workerExited ?? new Promise<never>(() => undefined));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  };
  const call = async (
    kind: 'query' | 'instruction',
    name: string,
    params: unknown,
    options: CallOptions,
  ): Promise<unknown> => {
    const { id, request, operation, deadlineAt } = admit(
      kind,
      name,
      params,
      options,
    );
    const { signal } = options;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): boolean => {
        if (settled) return false;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        return true;
      };
      // The ID stays pending until the worker's late reply consumes it.
      const fail = (error: CanopyOperationError): void => {
        if (!finish()) return;
        reject(directed(operation.definition, error));
        sendCancel(id);
      };
      const cancel = (): void => fail(canopyCancelledError());
      // The pending ID is consumed once: by the worker's reply, even a late
      // one after a cancel or deadline rejected the call, or by a stop.
      let replied: (succeeded: boolean) => void = () => undefined;
      const workerReplied = new Promise<boolean>((resolveReplied) => {
        replied = resolveReplied;
      });
      pending.set(id, {
        fail: (error): void => {
          replied(false);
          fail(error);
        },
        reply: (message): void => {
          replied('result' in message);
          if (!finish()) return;
          try {
            const parsed = CanopyJsonRpcMessageSchema.parse(
              operation.envelopes.response.parse(message),
            );
            if ('error' in parsed)
              reject(new CanopyOperationError(decodeCanopyError(parsed.error)));
            else if ('result' in parsed) resolve(parsed.result);
            else reject(canopyInvalidHandlerResultError());
          } catch {
            reject(canopyInvalidHandlerResultError());
          }
        },
      });
      // Sent first: a cancel must never reach the worker ahead of its request.
      transmit(request);
      if (options.workerSettlement)
        options.workerSettlement(workerSettled(name, options, workerReplied));
      signal?.addEventListener('abort', cancel, { once: true });
      if (deadlineAt !== undefined) {
        const schedule = (): void => {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) fail(canopyDeadlineExceededError());
          else timer = setTimeout(schedule, Math.min(remaining, 2_147_483_647));
        };
        schedule();
      }
      if (signal?.aborted) cancel();
    });
  };
  const receipt = (
    operation: string,
    idempotencyKey: string,
  ): Promise<WorkerExecutorReceipt | null> => {
    if (closed) return Promise.reject(canopyUnavailableError());
    if (pending.size >= MAX_PENDING || requestSends >= MAX_PENDING)
      return Promise.reject(capacityError('Worker request capacity exceeded.'));
    const id = `worker-request-${++sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        fail: reject,
        reply: (message): void => {
          if ('error' in message) {
            reject(new CanopyOperationError(decodeCanopyError(message.error)));
            return;
          }
          const result = 'result' in message ? message.result : undefined;
          const value =
            typeof result === 'object' && result !== null && 'receipt' in result
              ? result.receipt
              : undefined;
          const parsed =
            value === null ? null : parseWorkerExecutorReceipt(value);
          if (parsed === undefined) reject(canopyInvalidHandlerResultError());
          else resolve(parsed);
        },
      });
      transmit({
        jsonrpc: '2.0',
        id,
        method: RECEIPT_METHOD,
        params: { operation, idempotencyKey },
      });
    });
  };
  const releaseReceipt = (operation: string, idempotencyKey: string): void => {
    if (closed) return;
    void connection
      .send({
        jsonrpc: '2.0',
        method: RELEASE_METHOD,
        params: { operation, idempotencyKey },
      })
      .catch(transportFailure);
  };
  const detach = (route: StreamRoute): void => {
    if (route.sink === null) return;
    route.sink = null;
    route.release();
    sendCancel(route.requestId);
  };
  /**
   * Bridges a worker stream into the calling dispatcher's sink, which owns the
   * frame queue, its bound, cursor order and the end schema.
   */
  const openRemoteStream = (
    name: string,
    params: unknown,
    options: CallOptions,
    sink: CanopyStreamSink<unknown>,
  ): Promise<() => void> => {
    const { id, request, operation } = admit('stream', name, params, options);
    const { notification } = operation.envelopes;
    if (notification === undefined) throw canopyCapabilityUnavailableError();
    if (routes.size + openingStreams >= MAX_STREAMS)
      throw capacityError('Worker stream capacity exceeded.');
    const { signal } = options;
    openingStreams += 1;
    return new Promise((resolve, reject) => {
      let opening = true;
      const onAbort = (): void => {
        if (!opening) return detach(route);
        opening = false;
        reject(canopyCancelledError());
        sendCancel(id);
      };
      const route: StreamRoute = {
        name,
        requestId: id,
        notification,
        sink,
        release: () => signal?.removeEventListener('abort', onAbort),
      };
      pending.set(id, {
        // Only a stopped binding or a refused send fails an open, and no
        // reply follows either, so the open gives its slot back here.
        fail: (error): void => {
          openingStreams -= 1;
          route.release();
          if (opening) reject(error);
          opening = false;
        },
        reply: (message): void => {
          openingStreams -= 1;
          const wasOpening = opening;
          opening = false;
          const valid = operation.envelopes.response.safeParse(message).success;
          if (!('result' in message)) {
            route.release();
            if (wasOpening)
              reject(
                valid && 'error' in message
                  ? new CanopyOperationError(decodeCanopyError(message.error))
                  : canopyInvalidHandlerResultError(),
              );
            return;
          }
          const subscriptionId = subscriptionOf(message.result);
          if (subscriptionId === undefined || routes.has(subscriptionId)) {
            route.release();
            if (wasOpening) reject(canopyInvalidHandlerResultError());
            // Frames for an unroutable subscription cannot be delivered safely.
            throw canopyInvalidHandlerResultError();
          }
          routes.set(subscriptionId, route);
          // Abandoned during open: its cancel is already on the wire.
          if (!wasOpening) {
            route.sink = null;
            route.release();
          } else if (!valid) {
            reject(canopyInvalidHandlerResultError());
            detach(route);
          } else resolve(() => detach(route));
        },
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      transmit(request);
    });
  };
  const deliver = (message: CanopyJsonRpcNotification): void => {
    const { params } = message;
    const subscriptionId =
      typeof params.subscriptionId === 'string' ? params.subscriptionId : '';
    const route = routes.get(subscriptionId);
    const end = route !== undefined && message.method === `${route.name}.end`;
    if (!route || (!end && message.method !== `${route.name}.item`))
      throw canopyInvalidHandlerResultError();
    const valid = route.notification.safeParse(message).success;
    if (end) {
      routes.delete(subscriptionId);
      const { sink } = route;
      route.sink = null;
      route.release();
      const parsed = EndOutcomeSchema.safeParse({
        outcome: params.outcome,
        error: params.error,
      });
      const cursor = CanopyStreamCursorSchema.safeParse(params.cursor);
      // Ends where the worker ended, so a resume from the end reaches it
      // even when the stream ended before its first item (CAN-5696).
      if (valid && parsed.success && cursor.success)
        sink?.endAt(
          cursor.data,
          parsed.data.outcome,
          parsed.data.error ?? undefined,
        );
      else sink?.end('error', canopyInvalidHandlerResultError().payload);
      return;
    }
    if (route.sink === null) return;
    const cursor = CanopyStreamCursorSchema.safeParse(params.cursor);
    if (!valid || !cursor.success) {
      route.sink.end('error', canopyInvalidHandlerResultError().payload);
      return detach(route);
    }
    // Null: the dispatcher ended the stream on cursor order or its bound.
    if (route.sink.emitAt(cursor.data, params.item) === null) detach(route);
  };
  const read = async (): Promise<void> => {
    while (!closed) {
      const message = CanopyJsonRpcMessageSchema.parse(
        await connection.receive(),
      );
      if ('method' in message) {
        if ('id' in message) throw canopyInvalidHandlerResultError();
        deliver(message);
        continue;
      }
      if (typeof message.id !== 'string')
        throw canopyInvalidHandlerResultError();
      const pendingCall = pending.get(message.id);
      if (!pendingCall) throw canopyInvalidHandlerResultError();
      pending.delete(message.id);
      pendingCall.reply(message);
    }
  };
  connection.signal.addEventListener('abort', disconnected, { once: true });
  if (connection.signal.aborted) disconnected();
  else void read().catch(transportFailure);

  const queries: Record<string, ForwardedCall> = {};
  const instructions: Record<string, ForwardedCall> = {};
  const streams: Record<string, ForwardedStream> = {};
  for (const name of Object.keys(definitions.queries))
    queries[name] = (
      params,
      { metadata, signal, execution },
    ): Promise<unknown> =>
      call('query', name, params, { metadata, signal, execution });
  for (const name of Object.keys(definitions.instructions))
    instructions[name] = (
      params,
      { metadata, signal, execution, workerSettlement },
    ): Promise<unknown> =>
      call('instruction', name, params, {
        metadata,
        signal,
        execution,
        workerSettlement,
      });
  for (const name of Object.keys(definitions.streams))
    streams[name] = async (
      params,
      { metadata, signal, execution },
      sink,
    ): Promise<() => void> =>
      openRemoteStream(name, params, { metadata, signal, execution }, sink);
  // Direct streams get the dispatcher's frame queue, bound and cursor checks.
  const local = createCanopyDispatcher({
    profile: 'worker',
    definitions: {
      queries: {},
      instructions: {},
      streams: definitions.streams,
    },
    handlers: { queries: {}, instructions: {}, streams },
  });
  return {
    forwarders: { queries, instructions, streams },
    signal: stopped.signal,
    query: (name, params, options = {}): Promise<unknown> =>
      call('query', name, params, options),
    instruction: (name, params, options = {}): Promise<unknown> =>
      call('instruction', name, params, options),
    openStream: (name, params, options = {}) =>
      local.openStream(name, params, { ...options, caller }),
    receipt,
    releaseReceipt,
    close: (error = canopyUnavailableError()): void => stop(error),
  };
}
