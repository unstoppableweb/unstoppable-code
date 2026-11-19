import {
  CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS,
  CanopyCallerDescriptorSchema,
  CanopyHostExecutionSchema,
  CanopyStreamCursorSchema,
  canopyOperationAcceptsHostExecution,
  CanopyQueryRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  safeParseCanopySchema,
  type CanopyInstructionDefinitionMap,
  type CanopyInstructionDefinition,
  type CanopyQueryDefinitionMap,
  type CanopyQueryDefinition,
  type CanopyStreamDefinitionMap,
  type CanopyStreamDefinition,
  type CanopyErrorPayload,
  type CanopyHostExecution,
  type CanopyRetryDirective,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';

import {
  CanopyOperationError,
  canopyCancelledError,
  canopyCapabilityUnavailableError,
  canopyDeadlineExceededError,
  canopyInternalError,
  canopyUnexpectedError,
  canopyInvalidArgumentError,
  canopyInvalidHandlerResultError,
  canopyPermissionDeniedError,
  canopyStreamBufferExhaustedError,
  canopyUnauthenticatedError,
  canopyUnavailableError,
} from './errors';
import type {
  CanopyDispatcher,
  CanopyHandlerContext,
  CanopyInstructionOptions,
  CanopyQueryOptions,
  CanopyRuntimeProfile,
  CanopyRuntimeState,
  CanopyStreamFrame,
  CanopyStreamHandle,
  CanopyStreamOptions,
  CreateCanopyDispatcherOptions,
  CreateCanopyDispatcherKindOptions,
  CreateCanopyDispatcherLegacyOptions,
  CanopyRuntimeDefinitionMaps,
  CanopyRuntimeHandlerMaps,
} from './types';

export const CANOPY_DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const MAX_BUFFERED_STREAM_ITEMS = 1_024;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
type AbortSource = 'caller' | 'deadline' | 'shutdown';
type Definition =
  | CanopyQueryDefinition
  | CanopyInstructionDefinition
  | CanopyStreamDefinition;
type CallOptions = CanopyQueryOptions | CanopyInstructionOptions;
interface ActiveCall {
  abort(source: AbortSource): void;
  settled: Promise<void>;
}
interface PreparedCall {
  params: unknown;
  context: CanopyHandlerContext;
  deadlineAt: number | undefined;
  readonly abortSource: AbortSource | undefined;
  finish(): void;
  abort(source: AbortSource): void;
}
function hasUnrefTimer(timer: unknown): timer is { unref(): void } {
  return (
    typeof timer === 'object' &&
    timer !== null &&
    'unref' in timer &&
    typeof timer.unref === 'function'
  );
}
function unrefTimer(timer: unknown): void {
  if (hasUnrefTimer(timer)) timer.unref();
}
function profileAcceptsPlane(
  profile: CanopyRuntimeProfile,
  plane: 'core' | 'worker',
): boolean {
  return profile === 'core+worker' || profile === plane;
}
function validateRuntimeMaps(
  profile: CanopyRuntimeProfile,
  definitions: Readonly<Record<string, Definition>>,
  handlers: Readonly<Record<string, unknown>>,
): void {
  for (const [name, definition] of Object.entries(definitions)) {
    if (!profileAcceptsPlane(profile, definition.plane))
      throw new Error(
        `Canopy runtime profile ${profile} cannot register definition ${name}`,
      );
    if (!Object.prototype.hasOwnProperty.call(handlers, name))
      throw new Error(`Missing Canopy handler for definition ${name}`);
  }
  for (const name of Object.keys(handlers))
    if (!Object.prototype.hasOwnProperty.call(definitions, name))
      throw new Error(`Canopy handler has no definition: ${name}`);
}
/**
 * The request's host execution, validated and frozen; refused on an operation
 * that does not accept it. Messages never carry a value (CAN-5496).
 */
function hostExecutionFor(
  name: string,
  execution: unknown,
): CanopyHostExecution | undefined {
  if (execution === undefined) return undefined;
  if (!canopyOperationAcceptsHostExecution(name))
    throw canopyInvalidArgumentError(
      'This operation does not accept host execution.',
    );
  const parsed = CanopyHostExecutionSchema.safeParse(execution);
  if (!parsed.success)
    throw canopyInvalidArgumentError('Invalid host execution.');
  const { childEnvironment, ...members } = parsed.data;
  const accepted: Record<string, unknown> = {};
  for (const [member, value] of Object.entries(members)) {
    if (value === undefined) continue;
    const rule = hostExecutionMemberRule(member);
    if (!rule)
      throw canopyInvalidArgumentError(
        'This operation does not accept that host execution member.',
      );
    if (rule.operation !== name) throw canopyInvalidArgumentError(rule.refusal);
    accepted[member] = Object.freeze({ ...value });
  }
  return Object.freeze({
    childEnvironment: Object.freeze({ ...childEnvironment }),
    ...accepted,
  });
}

const HOST_EXECUTION_MEMBER_RULES: ReadonlyMap<
  string,
  { readonly operation: string; readonly refusal: string }
> = new Map(Object.entries(CANOPY_HOST_EXECUTION_MEMBER_OPERATIONS));

/** The table row for an `_execution` member; undefined for any member it lacks (CAN-5771). */
function hostExecutionMemberRule(
  member: string,
): { readonly operation: string; readonly refusal: string } | undefined {
  return HOST_EXECUTION_MEMBER_RULES.get(member);
}
function retryForDefinition(
  definition: Definition | undefined,
): CanopyRetryDirective {
  if (definition?.idempotency === 'keyed')
    return { kind: 'same_idempotency_key' };
  if (definition?.idempotency === 'none') return { kind: 'never' };
  return { kind: 'same_request' };
}
function abortError(
  source: AbortSource,
  definition: Definition,
): CanopyOperationError {
  return source === 'deadline'
    ? canopyDeadlineExceededError(undefined, retryForDefinition(definition))
    : canopyCancelledError();
}
/**
 * The error a handler failure is answered with: a keyed instruction's
 * transport-class retry becomes `same_idempotency_key`, and an error outside
 * the definition's schema becomes an internal error. Shared with the worker
 * executor receipts, which record the same answer the dispatcher sends.
 */
export function translateCanopyHandlerError(
  definition: Definition,
  error: unknown,
): CanopyOperationError {
  if (error instanceof CanopyOperationError) {
    const normalized =
      'idempotency' in definition &&
      definition.idempotency === 'keyed' &&
      (error.payload.kind === 'deadline_exceeded' ||
        error.payload.kind === 'unavailable') &&
      error.payload.retry.kind === 'same_request'
        ? new CanopyOperationError(
            {
              ...error.payload,
              retry: { ...error.payload.retry, kind: 'same_idempotency_key' },
            },
            error.runtimeCause,
          )
        : error;
    return definition.error.safeParse(normalized.payload).success
      ? normalized
      : canopyInternalError('The operation returned an invalid error.', error);
  }
  return canopyUnexpectedError(error, definition.error);
}
function isDefinitionBundle(
  value:
    | CanopyQueryDefinitionMap
    | CanopyRuntimeDefinitionMaps<
        CanopyQueryDefinitionMap,
        CanopyInstructionDefinitionMap,
        CanopyStreamDefinitionMap
      >,
): value is CanopyRuntimeDefinitionMaps<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
> {
  return (
    Object.prototype.hasOwnProperty.call(value, 'queries') &&
    Object.prototype.hasOwnProperty.call(value, 'instructions') &&
    Object.prototype.hasOwnProperty.call(value, 'streams')
  );
}
function isHandlerBundle(
  value:
    | CanopyRuntimeHandlerMaps<
        CanopyQueryDefinitionMap,
        CanopyInstructionDefinitionMap,
        CanopyStreamDefinitionMap
      >
    | Readonly<Record<string, unknown>>,
): value is CanopyRuntimeHandlerMaps<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
> {
  return (
    Object.prototype.hasOwnProperty.call(value, 'queries') &&
    Object.prototype.hasOwnProperty.call(value, 'instructions') &&
    Object.prototype.hasOwnProperty.call(value, 'streams')
  );
}

export { CanopyOperationError } from './errors';
export function createCanopyDispatcher<
  const Q extends CanopyQueryDefinitionMap,
  const I extends CanopyInstructionDefinitionMap,
  const S extends CanopyStreamDefinitionMap,
>(
  options: CreateCanopyDispatcherKindOptions<Q, I, S>,
): CanopyDispatcher<Q, I, S>;
export function createCanopyDispatcher<
  const Q extends CanopyQueryDefinitionMap,
>(
  options: CreateCanopyDispatcherLegacyOptions<Q>,
): CanopyDispatcher<Q, Record<never, never>, Record<never, never>>;
export function createCanopyDispatcher(
  options: CreateCanopyDispatcherOptions<
    CanopyQueryDefinitionMap,
    CanopyInstructionDefinitionMap,
    CanopyStreamDefinitionMap
  >,
): CanopyDispatcher {
  const definitions = isDefinitionBundle(options.definitions)
    ? options.definitions
    : { queries: options.definitions, instructions: {}, streams: {} };
  const handlers = isHandlerBundle(options.handlers)
    ? options.handlers
    : { queries: options.handlers, instructions: {}, streams: {} };
  validateRuntimeMaps(options.profile, definitions.queries, handlers.queries);
  validateRuntimeMaps(
    options.profile,
    definitions.instructions,
    handlers.instructions,
  );
  validateRuntimeMaps(options.profile, definitions.streams, handlers.streams);
  const shutdownTimeoutMs =
    options.shutdownTimeoutMs ?? CANOPY_DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 0)
    throw new Error('shutdownTimeoutMs must be a non-negative finite number');

  let state: CanopyRuntimeState = 'accepting';
  let requestSequence = 0;
  let streamSequence = 0;
  const daemonEpoch = crypto.randomUUID();
  const activeCalls = new Set<ActiveCall>();
  let shutdownPromise: Promise<void> | undefined;
  let resolveShutdown: (() => void) | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  const finishShutdownIfDrained = (): void => {
    if (state !== 'closed' || activeCalls.size !== 0 || !resolveShutdown)
      return;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    resolveShutdown();
    resolveShutdown = undefined;
  };
  const nextCursor = (): CanopyStreamCursor => ({
    daemonEpoch,
    sequence: ++streamSequence,
  });

  const prepareCall = (
    name: string,
    definition: Definition | undefined,
    params: unknown,
    callOptions: CallOptions,
    onAbort: (error: CanopyOperationError) => void,
  ): PreparedCall => {
    if (
      state === 'closed' ||
      (state === 'draining' && definition?.kind === 'instruction')
    )
      throw canopyUnavailableError(undefined, retryForDefinition(definition));
    if (!definition) throw canopyCapabilityUnavailableError();
    const metadataSchema =
      definition.kind === 'instruction'
        ? CanopyRequestMetadataSchema
        : CanopyQueryRequestMetadataSchema;
    const metadata = metadataSchema.safeParse(callOptions?.metadata ?? {});
    if (!metadata.success)
      throw canopyInvalidArgumentError('Invalid request metadata.');
    if (
      definition.kind === 'instruction' &&
      definition.idempotency === 'keyed' &&
      !('idempotencyKey' in metadata.data && metadata.data.idempotencyKey)
    )
      throw canopyInvalidArgumentError('An idempotency key is required.');
    if (
      definition.kind === 'instruction' &&
      definition.idempotency !== 'keyed' &&
      'idempotencyKey' in metadata.data
    )
      throw canopyInvalidArgumentError('An idempotency key is not allowed.');
    const execution = hostExecutionFor(name, callOptions.execution);
    const parsedParams = safeParseCanopySchema(definition.params, params);
    if (!parsedParams.success)
      throw canopyInvalidArgumentError('Invalid operation parameters.');
    const parsedCaller = CanopyCallerDescriptorSchema.safeParse(
      callOptions?.caller,
    );
    if (!parsedCaller.success) throw canopyUnauthenticatedError();
    const caller = parsedCaller.data;
    const grants = new Set(caller.grants);
    if (definition.requiredGrants.some((grant) => !grants.has(grant)))
      throw canopyPermissionDeniedError();
    if (callOptions.signal?.aborted) throw canopyCancelledError();
    const deadlineAt = metadata.data.deadlineAt
      ? Date.parse(metadata.data.deadlineAt)
      : undefined;
    if (deadlineAt !== undefined && deadlineAt <= Date.now())
      throw canopyDeadlineExceededError(
        undefined,
        retryForDefinition(definition),
      );
    const controller = new AbortController();
    let abortSource: AbortSource | undefined;
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const activeCall: ActiveCall = {
      abort(source): void {
        if (abortSource) return;
        abortSource = source;
        controller.abort(source);
        onAbort(abortError(source, definition));
      },
      settled,
    };
    const onCallerAbort = (): void => activeCall.abort('caller');
    callOptions.signal?.addEventListener('abort', onCallerAbort, {
      once: true,
    });
    if (callOptions.signal?.aborted) activeCall.abort('caller');
    if (deadlineAt !== undefined) {
      const scheduleDeadline = (): void => {
        const remaining = deadlineAt - Date.now();
        deadlineTimer = setTimeout(
          remaining <= MAX_TIMER_DELAY_MS
            ? (): void => activeCall.abort('deadline')
            : scheduleDeadline,
          Math.max(0, Math.min(remaining, MAX_TIMER_DELAY_MS)),
        );
        unrefTimer(deadlineTimer);
      };
      scheduleDeadline();
    }
    activeCalls.add(activeCall);
    const context: CanopyHandlerContext = {
      requestId: `canopy-request-${Date.now()}-${++requestSequence}`,
      caller,
      metadata: metadata.data,
      signal: controller.signal,
      ...(execution === undefined ? {} : { execution }),
    };
    return {
      params: parsedParams.data,
      context,
      deadlineAt,
      get abortSource(): AbortSource | undefined {
        return abortSource;
      },
      finish(): void {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        callOptions.signal?.removeEventListener('abort', onCallerAbort);
        activeCalls.delete(activeCall);
        resolveSettled();
        finishShutdownIfDrained();
      },
      abort(source: AbortSource): void {
        activeCall.abort(source);
      },
    };
  };
  const invoke = async (
    name: string,
    definition: Definition | undefined,
    params: unknown,
    callOptions: CallOptions,
    handler:
      | ((params: unknown, context: CanopyHandlerContext) => unknown)
      | undefined,
  ): Promise<unknown> => {
    let rejectAbort: (error: CanopyOperationError) => void = () => undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    let call: PreparedCall | undefined;
    try {
      call = prepareCall(name, definition, params, callOptions, rejectAbort);
      const preparedCall = call;
      if (!handler) throw canopyCapabilityUnavailableError();
      const raw = await Promise.race([
        Promise.resolve().then(() =>
          handler(preparedCall.params, preparedCall.context),
        ),
        abortPromise,
      ]);
      if (call.deadlineAt !== undefined && call.deadlineAt <= Date.now())
        throw canopyDeadlineExceededError(
          undefined,
          retryForDefinition(definition),
        );
      if (!definition || !('result' in definition))
        throw canopyCapabilityUnavailableError();
      const result = safeParseCanopySchema(definition.result, raw);
      if (!result.success) throw canopyInvalidHandlerResultError();
      return result.data;
    } catch (error) {
      throw definition
        ? translateCanopyHandlerError(definition, error)
        : error instanceof CanopyOperationError
          ? error
          : canopyCapabilityUnavailableError();
    } finally {
      call?.finish();
    }
  };
  const query = (
    name: string,
    params: unknown,
    callOptions: CanopyQueryOptions,
  ): Promise<unknown> =>
    invoke(
      name,
      Object.prototype.hasOwnProperty.call(definitions.queries, name)
        ? definitions.queries[name]
        : undefined,
      params,
      callOptions,
      handlers.queries[name],
    );
  const instruction = (
    name: string,
    params: unknown,
    callOptions: CanopyInstructionOptions,
  ): Promise<unknown> =>
    invoke(
      name,
      Object.prototype.hasOwnProperty.call(definitions.instructions, name)
        ? definitions.instructions[name]
        : undefined,
      params,
      callOptions,
      handlers.instructions[name],
    );

  const openStream = async (
    name: string,
    params: unknown,
    callOptions: CanopyStreamOptions,
  ): Promise<CanopyStreamHandle<unknown, unknown>> => {
    const definition = Object.prototype.hasOwnProperty.call(
      definitions.streams,
      name,
    )
      ? definitions.streams[name]
      : undefined;
    const queue: CanopyStreamFrame<unknown, unknown>[] = [];
    let wake: (() => void) | undefined;
    let terminal = false;
    let cleanup: (() => void) | void;
    let cleanupReady = false;
    let cleanupDone = false;
    const callHolder: { value?: PreparedCall } = {};
    let finished = false;
    let lastCursor: CanopyStreamCursor = {
      daemonEpoch,
      sequence: streamSequence,
    };
    let cursorSource: 'allocated' | 'supplied' | undefined;
    const runCleanup = (): void => {
      if (cleanupDone || !cleanupReady) return;
      cleanupDone = true;
      try {
        cleanup?.();
      } catch {
        // Cleanup runs after the terminal frame; a failure must not interrupt draining.
      }
    };
    const finish = (): void => {
      if (finished || !callHolder.value) return;
      // Shutdown remains bounded if adapter setup never settles; late cleanup runs on resolution.
      finished = true;
      callHolder.value.finish();
    };
    const listeners = new Set<
      (frame: CanopyStreamFrame<unknown, unknown>) => void
    >();
    let consumption: 'pull' | 'push' | undefined;
    let draining = false;
    const deliver = (frame: CanopyStreamFrame<unknown, unknown>): void => {
      for (const listener of Array.from(listeners)) {
        try {
          listener({ ...frame, cursor: { ...frame.cursor } });
        } catch {
          // A failing push consumer must not interrupt the producer or other listeners.
        }
      }
    };
    if (callOptions.onFrame) {
      consumption = 'push';
      listeners.add(callOptions.onFrame);
    }
    const drain = (): void => {
      if (draining) return;
      draining = true;
      try {
        while (listeners.size > 0 && queue.length > 0) {
          const frame = queue.shift();
          if (frame) deliver(frame);
        }
      } finally {
        draining = false;
      }
    };
    const append = (frame: CanopyStreamFrame<unknown, unknown>): void => {
      queue.push(frame);
      if (listeners.size > 0) {
        drain();
        return;
      }
      wake?.();
      wake = undefined;
    };
    const end = (
      outcome: 'completed' | 'cancelled' | 'error',
      error?: CanopyErrorPayload,
    ): void => {
      if (terminal) return;
      terminal = true;
      const cursor = { ...lastCursor };
      const frame = {
        kind: 'end' as const,
        cursor,
        outcome,
        error: error ?? null,
      };
      const parsed = definition
        ? safeParseCanopySchema(definition.end, {
            cursor,
            outcome,
            error: error ?? null,
          })
        : undefined;
      if (!parsed?.success || typeof parsed.data !== 'object' || !parsed.data) {
        append({
          kind: 'end',
          cursor,
          outcome: 'error',
          error: canopyInvalidHandlerResultError().payload,
        });
      } else append({ ...frame, ...parsed.data, kind: 'end' });
      finish();
      runCleanup();
    };
    const call = prepareCall(name, definition, params, callOptions, (error) =>
      end(
        error.payload.kind === 'deadline_exceeded' ? 'error' : 'cancelled',
        error.payload,
      ),
    );
    callHolder.value = call;
    if (terminal) finish();
    // Parsed before the handler runs so handler mutation of params cannot change it.
    const resumeCursor =
      typeof call.params === 'object' &&
      call.params !== null &&
      'cursor' in call.params
        ? CanopyStreamCursorSchema.safeParse(call.params.cursor)
        : null;
    const acceptedCursor = resumeCursor?.success ? resumeCursor.data : null;
    // An idle resumed stream ends at the caller's acknowledged position.
    if (acceptedCursor) lastCursor = { ...acceptedCursor };
    const emitWith = (
      item: unknown,
      assignCursor: () => CanopyStreamCursor | null,
      onCursorAssigned?: (cursor: CanopyStreamCursor) => void,
    ): CanopyStreamCursor | null => {
      if (terminal || call.context.signal.aborted) return null;
      const parsed = definition
        ? safeParseCanopySchema(definition.item, item)
        : undefined;
      const cursor = parsed?.success ? assignCursor() : null;
      if (!parsed?.success || !cursor) {
        end('error', canopyInvalidHandlerResultError().payload);
        return null;
      }
      // lastCursor stays private; consumers get copies so they cannot change ordering.
      lastCursor = cursor;
      onCursorAssigned?.({ ...cursor });
      append({ kind: 'item', cursor: { ...cursor }, item: parsed.data });
      if (queue.length > MAX_BUFFERED_STREAM_ITEMS)
        end('error', canopyStreamBufferExhaustedError().payload);
      return { ...cursor };
    };
    const endDeclared = (
      outcome: 'completed' | 'cancelled' | 'error',
      error?: CanopyErrorPayload,
    ): void => {
      // Mirrors translateCanopyHandlerError: handler errors must match the operation's declared error schema.
      const declared =
        !error || !definition || definition.error.safeParse(error).success;
      end(
        outcome,
        declared
          ? error
          : canopyInternalError('The operation returned an invalid error.')
              .payload,
      );
    };
    const sink = {
      buffered: (): number => queue.length,
      emit(
        item: unknown,
        onCursorAssigned?: (cursor: CanopyStreamCursor) => void,
      ): CanopyStreamCursor | null {
        return emitWith(
          item,
          () => {
            if (cursorSource === 'supplied') return null;
            cursorSource = 'allocated';
            return nextCursor();
          },
          onCursorAssigned,
        );
      },
      emitAt(
        cursor: CanopyStreamCursor,
        item: unknown,
      ): CanopyStreamCursor | null {
        return emitWith(item, () => {
          // The parsed copy detaches the accepted cursor from caller mutation.
          const parsed = CanopyStreamCursorSchema.safeParse(cursor);
          if (!parsed.success || cursorSource === 'allocated') return null;
          // On resume, lastCursor starts as a private copy of the accepted cursor.
          if (
            (cursorSource === 'supplied' || acceptedCursor !== null) &&
            (parsed.data.daemonEpoch !== lastCursor.daemonEpoch ||
              parsed.data.sequence <= lastCursor.sequence)
          )
            return null;
          cursorSource = 'supplied';
          return parsed.data;
        });
      },
      end: endDeclared,
      endAt(
        cursor: CanopyStreamCursor,
        outcome: 'completed' | 'cancelled' | 'error',
        error?: CanopyErrorPayload,
      ): void {
        if (terminal) return;
        const parsed = CanopyStreamCursorSchema.safeParse(cursor);
        if (
          !parsed.success ||
          cursorSource === 'allocated' ||
          ((cursorSource === 'supplied' || acceptedCursor !== null) &&
            (parsed.data.daemonEpoch !== lastCursor.daemonEpoch ||
              parsed.data.sequence < lastCursor.sequence))
        ) {
          end('error', canopyInvalidHandlerResultError().payload);
          return;
        }
        cursorSource = 'supplied';
        lastCursor = parsed.data;
        endDeclared(outcome, error);
      },
    };
    const handler = handlers.streams[name];
    const onHandlerError = (error: unknown): void => {
      end(
        'error',
        definition
          ? translateCanopyHandlerError(definition, error).payload
          : canopyCapabilityUnavailableError().payload,
      );
      cleanupReady = true;
      runCleanup();
    };
    try {
      if (!handler) throw canopyCapabilityUnavailableError();
      void Promise.resolve(handler(call.params, call.context, sink)).then(
        (returnedCleanup) => {
          cleanup = returnedCleanup;
          cleanupReady = true;
          if (terminal) runCleanup();
        },
        onHandlerError,
      );
    } catch (error) {
      onHandlerError(error);
    }
    await Promise.resolve();
    return {
      requestId: call.context.requestId,
      openResult: { subscriptionId: call.context.requestId, acceptedCursor },
      frames: {
        async *[Symbol.asyncIterator](): AsyncGenerator<
          CanopyStreamFrame<unknown, unknown>
        > {
          if (consumption === 'push')
            throw new Error('Stream frames are consumed by onFrame.');
          consumption = 'pull';
          while (true) {
            if (queue.length === 0)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            while (queue.length) {
              const frame = queue.shift();
              if (!frame) continue;
              yield frame;
              if (frame.kind === 'end') return;
            }
          }
        },
      },
      onFrame(listener): () => void {
        if (consumption === 'pull')
          throw new Error('Stream frames are consumed by the frames iterator.');
        consumption = 'push';
        listeners.add(listener);
        drain();
        return (): void => {
          listeners.delete(listener);
        };
      },
      close(): void {
        call.abort('caller');
      },
    };
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    state = 'closed';
    shutdownPromise = new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    });
    if (activeCalls.size === 0) finishShutdownIfDrained();
    else {
      shutdownTimer = setTimeout(() => {
        const calls = Array.from(activeCalls);
        for (const call of calls) call.abort('shutdown');
        void Promise.allSettled(calls.map((call) => call.settled)).then(
          finishShutdownIfDrained,
        );
      }, shutdownTimeoutMs);
      unrefTimer(shutdownTimer);
    }
    return shutdownPromise;
  };
  return {
    profile: options.profile,
    definitions: definitions.queries,
    get state(): CanopyRuntimeState {
      return state;
    },
    query,
    instruction,
    openStream,
    drainInstructions(): void {
      if (state === 'accepting') state = 'draining';
    },
    shutdown,
  };
}
