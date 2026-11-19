import {
  CANOPY_HOST_EXECUTION_MEMBER,
  CanopyCallerDescriptorSchema,
  CanopyJsonRpcMessageSchema,
  type CanopyCallerDescriptor,
  type CanopyJsonRpcId,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcNotification,
  type CanopyJsonRpcRequest,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import type { CanopyDispatcher, CanopyStreamHandle } from './types';
import { hostExecutionOption } from './host-execution';
import { streamPositionBefore } from './stream-position';
import type { WorkerExecutorReceipts } from './worker-executor-receipts';
import {
  type CanopyOperationError,
  canopyInvalidArgumentError,
  canopyInvalidHandlerResultError,
  canopyUnavailableError,
} from './errors';
import {
  bindOperations,
  CANCEL_METHOD,
  errorResponse,
  MAX_PENDING,
  MAX_STREAMS,
  RECEIPT_METHOD,
  RELEASE_METHOD,
  transportStopError,
  without,
  type BoundOperation,
  type WorkerBindingConnection,
  type WorkerBindingDefinitions,
} from './local-worker-binding-wire';

export interface ServeLocalWorkerBindingOptions {
  readonly dispatcher: CanopyDispatcher;
  /** The worker dispatcher's maps; the dispatcher exposes only its queries. */
  readonly definitions: WorkerBindingDefinitions;
  /** The trusted owning core every request runs as; grants are checked here too. */
  readonly caller: CanopyCallerDescriptor;
  /** The worker end of the binding. */
  readonly connection: WorkerBindingConnection;
  /**
   * The worker's executor receipts, recorded by its wrapped instruction
   * handlers. Without them every receipt lookup answers that nothing arrived.
   */
  readonly receipts?: WorkerExecutorReceipts;
}

/** The worker half of a local worker binding. */
export interface LocalWorkerBindingServer {
  /** Aborts once the binding has stopped; the reason is the typed error. */
  readonly signal: AbortSignal;
  close(error?: CanopyOperationError): void;
}

/**
 * Serves worker queries, instructions and streams to the core end of
 * `connection`, on the worker dispatcher, as the trusted owning core.
 * Cancellation and receipt lookups arrive as binding-private messages.
 */
export function serveLocalWorkerBinding({
  dispatcher,
  definitions,
  caller: callerInput,
  connection,
  receipts,
}: ServeLocalWorkerBindingOptions): LocalWorkerBindingServer {
  if (dispatcher.profile !== 'worker')
    throw new Error('Worker binding requires a worker graph');
  const caller = CanopyCallerDescriptorSchema.parse(callerInput);
  Object.freeze(caller.grants);
  Object.freeze(caller);
  const operations = bindOperations(definitions);
  const served = new Map<CanopyJsonRpcId, AbortController>();
  const stopped = new AbortController();
  let closed = false;
  let active = 0;
  let replySends = 0;
  const replyWaiters: Array<() => void> = [];
  const stop = (error: CanopyOperationError): void => {
    if (closed) return;
    closed = true;
    connection.signal.removeEventListener('abort', disconnected);
    // Served calls abort here, not through a per-call AbortSignal.any.
    served.forEach((controller) => controller.abort());
    for (const resume of replyWaiters.splice(0)) resume();
    // Published first: a linked core half stops with this error, not with
    // the bare disconnect a synchronous close would show it.
    stopped.abort(error);
    connection.close(error.payload);
  };
  const disconnected = (): void => stop(canopyUnavailableError());
  const transportFailure = (error: unknown): void =>
    stop(transportStopError(error));

  const sendReply = async (response: CanopyJsonRpcMessage): Promise<void> => {
    if (closed) return;
    if (replySends >= MAX_PENDING) {
      if (replyWaiters.length >= MAX_PENDING) throw canopyUnavailableError();
      await new Promise<void>((resolve) => replyWaiters.push(resolve));
    } else replySends += 1;
    if (closed) return;
    try {
      await connection.send(response).catch((error: unknown) => {
        // Refused before a byte was written, such as too large to send: the
        // call fails on its own and the binding stays open.
        if (
          connection.signal.aborted ||
          !('id' in response) ||
          response.id === null
        )
          throw error;
        const refusal = transportStopError(error);
        return connection.send(
          errorResponse(
            response.id,
            refusal.payload.kind === 'resource_exhausted'
              ? refusal
              : canopyInvalidHandlerResultError(),
          ),
        );
      });
    } finally {
      const next = replyWaiters.shift();
      if (next) next();
      else replySends -= 1;
    }
  };
  // Frames skip the reply waiters: one send in flight per open stream.
  const pumpStream = async (
    { id, method }: CanopyJsonRpcRequest,
    handle: CanopyStreamHandle<unknown, unknown>,
  ): Promise<void> => {
    const { subscriptionId } = handle.openResult;
    let delivered: CanopyStreamCursor | undefined;
    for await (const frame of handle.frames) {
      if (closed) return;
      if (frame.kind === 'end') {
        // Freed before the end crosses: the core reuses the slot on receipt.
        served.delete(id);
        return connection.send({
          jsonrpc: '2.0',
          method: `${method}.end`,
          params: { subscriptionId, ...without(frame, 'kind') },
        });
      }
      const refusal = await connection
        .send({
          jsonrpc: '2.0',
          method: `${method}.item`,
          params: {
            subscriptionId,
            cursor: frame.cursor,
            itemId: `item-${frame.cursor.sequence}`,
            occurredAt: new Date().toISOString(),
            item: frame.item,
          },
        })
        .then(
          () => null,
          (error: unknown) => {
            if (connection.signal.aborted) throw error;
            return transportStopError(error);
          },
        );
      if (refusal === null) {
        delivered = frame.cursor;
        continue;
      }
      // Refused before a byte was written, such as larger than the core
      // joins: only this stream ends, with the typed error (CAN-5684), at
      // the position before the refused item, where the core's stream ends
      // too (CAN-5696).
      served.delete(id);
      handle.close();
      return connection.send({
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
          error: (refusal.payload.kind === 'resource_exhausted'
            ? refusal
            : canopyInvalidHandlerResultError()
          ).payload,
        },
      });
    }
  };
  const serveStream = async (
    request: CanopyJsonRpcRequest,
    operation: BoundOperation,
    signal: AbortSignal,
  ): Promise<void> => {
    const { id, method, params } = request;
    const {
      _meta,
      [CANOPY_HOST_EXECUTION_MEMBER]: execution,
      ...body
    } = params;
    let executionOption: ReturnType<typeof hostExecutionOption>;
    try {
      executionOption = hostExecutionOption(execution);
    } catch (error) {
      active -= 1;
      served.delete(id);
      return sendReply(errorResponse(id, error, operation.definition));
    }
    const opened = await dispatcher
      .openStream(
        method,
        operation.declaresMeta
          ? without(params, CANOPY_HOST_EXECUTION_MEMBER)
          : body,
        { caller, metadata: _meta, signal, ...executionOption },
      )
      .then(
        (handle) => ({ handle }),
        (error: unknown) => ({ error }),
      );
    active -= 1;
    if (!('handle' in opened)) {
      served.delete(id);
      return sendReply(errorResponse(id, opened.error, operation.definition));
    }
    const { handle } = opened;
    const reply: CanopyJsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      result: handle.openResult,
    };
    if (!operation.envelopes.response.safeParse(reply).success) {
      handle.close();
      served.delete(id);
      return sendReply(errorResponse(id, canopyInvalidHandlerResultError()));
    }
    try {
      await sendReply(reply);
      await pumpStream(request, handle);
    } finally {
      // Still served: the pump stopped before the end, so stop the stream too.
      if (served.delete(id)) handle.close();
    }
  };
  const serveReceipt = async (
    { id, params }: CanopyJsonRpcRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    let response: CanopyJsonRpcMessage;
    try {
      const { operation, idempotencyKey } = params;
      if (typeof operation !== 'string' || typeof idempotencyKey !== 'string')
        throw canopyInvalidArgumentError('Invalid worker receipt request.');
      const receipt =
        (await receipts?.settled(
          caller.principalId,
          operation,
          idempotencyKey,
          signal,
        )) ?? null;
      response = { jsonrpc: '2.0', id, result: { receipt } };
    } catch (error) {
      response = errorResponse(
        id,
        signal.aborted ? canopyUnavailableError() : error,
      );
    } finally {
      active -= 1;
      served.delete(id);
    }
    await sendReply(response);
  };
  const serve = async (
    request: CanopyJsonRpcRequest,
    signal: AbortSignal,
  ): Promise<void> => {
    const { id, method, params } = request;
    if (method === RECEIPT_METHOD) return serveReceipt(request, signal);
    const stream = operations.stream.get(method);
    if (stream) return serveStream(request, stream, signal);
    const instruction = operations.instruction.get(method);
    const operation = instruction ?? operations.query.get(method);
    let response: CanopyJsonRpcMessage;
    try {
      const {
        _meta,
        [CANOPY_HOST_EXECUTION_MEMBER]: execution,
        ...body
      } = params;
      const input = operation?.declaresMeta
        ? without(params, CANOPY_HOST_EXECUTION_MEMBER)
        : body;
      const options = {
        caller,
        metadata: _meta,
        signal,
        ...hostExecutionOption(execution),
      };
      const result = instruction
        ? await dispatcher.instruction(method, input, options)
        : await dispatcher.query(method, input, options);
      response = { jsonrpc: '2.0', id, result };
    } catch (error) {
      response = errorResponse(id, error, operation?.definition);
    } finally {
      active -= 1;
      served.delete(id);
    }
    // A peer can read the reply before send resolves under write backpressure.
    await sendReply(response);
  };
  const cancelServed = (notification: CanopyJsonRpcNotification): void => {
    if (notification.method === RELEASE_METHOD) {
      const { operation, idempotencyKey } = notification.params;
      if (typeof operation !== 'string' || typeof idempotencyKey !== 'string')
        throw new Error('Unexpected worker binding notification');
      receipts?.release(caller.principalId, operation, idempotencyKey);
      return;
    }
    const { requestId } = notification.params;
    if (
      notification.method !== CANCEL_METHOD ||
      (typeof requestId !== 'string' && typeof requestId !== 'number')
    )
      throw new Error('Unexpected worker binding notification');
    // A cancel that crossed its reply finds nothing left to stop.
    served.get(requestId)?.abort();
  };
  const read = async (): Promise<void> => {
    while (!closed) {
      const message = CanopyJsonRpcMessageSchema.parse(
        await connection.receive(),
      );
      if (closed) return;
      if (!('method' in message))
        throw new Error('Unexpected worker binding response');
      if (!('id' in message)) {
        cancelServed(message);
        continue;
      }
      if (
        active >= MAX_PENDING ||
        served.size >= MAX_PENDING + MAX_STREAMS ||
        served.has(message.id)
      )
        throw new Error('Worker request capacity exceeded');
      // Registered before serving so a cancel right behind the request is kept.
      const controller = new AbortController();
      served.set(message.id, controller);
      active += 1;
      void serve(message, controller.signal).catch(transportFailure);
    }
  };
  connection.signal.addEventListener('abort', disconnected, { once: true });
  if (connection.signal.aborted) disconnected();
  else void read().catch(transportFailure);
  return {
    signal: stopped.signal,
    close: (error = canopyUnavailableError()): void => stop(error),
  };
}
