import type {
  CanopyCallerDescriptor,
  CanopyErrorPayload,
  CanopyHostExecution,
  CanopyInstructionDefinitionMap,
  CanopyQueryDefinitionMap,
  CanopyQueryRequestMetadata,
  CanopyRequestMetadata,
  CanopySchemaOutput,
  CanopySchemaInput,
  CanopyStreamCursor,
  CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';

export type CanopyRuntimeProfile = 'core' | 'worker' | 'core+worker';
export type CanopyRuntimeState = 'accepting' | 'draining' | 'closed';

export interface CanopyHandlerContext {
  requestId: string;
  caller: CanopyCallerDescriptor;
  metadata: CanopyRequestMetadata;
  signal: AbortSignal;
  /**
   * Host execution input for this request only (CAN-5496): present only on
   * operations that accept it and only when the caller supplied it. Never
   * stored, logged or forwarded beyond the same-host local worker.
   */
  execution?: CanopyHostExecution;
  /**
   * The client lease a lease-bound call was admitted under, set only by the
   * host transport that checked it (CAN-4730 E2-G).
   */
  lease?: CanopyAdmittedLease;
  /**
   * Set by a core wrapper around a forwarded worker instruction (CAN-4730
   * E2-G). Once the request is on its way, the worker binding hands back a
   * promise that resolves when the worker itself has settled it: its reply,
   * even one arriving after a cancel or deadline already rejected the call,
   * or the binding's stop.
   */
  workerSettlement?: (settled: Promise<void>) => void;
}

/** A client lease the host transport admitted a call under. */
export interface CanopyAdmittedLease {
  readonly leaseId: string;
}

export type CanopyDispatcherQueryName<D extends CanopyQueryDefinitionMap> =
  Extract<keyof D, string>;
export type CanopyDispatcherQueryParams<
  D extends CanopyQueryDefinitionMap,
  N extends CanopyDispatcherQueryName<D>,
> = CanopySchemaOutput<D[N]['params']>;
export type CanopyDispatcherQueryResult<
  D extends CanopyQueryDefinitionMap,
  N extends CanopyDispatcherQueryName<D>,
> = CanopySchemaOutput<D[N]['result']>;
export type CanopyDispatcherInstructionName<
  D extends CanopyInstructionDefinitionMap,
> = Extract<keyof D, string>;
export type CanopyDispatcherInstructionParams<
  D extends CanopyInstructionDefinitionMap,
  N extends CanopyDispatcherInstructionName<D>,
> = CanopySchemaOutput<D[N]['params']>;
export type CanopyDispatcherInstructionParamsInput<
  D extends CanopyInstructionDefinitionMap,
  N extends CanopyDispatcherInstructionName<D>,
> = CanopySchemaInput<D[N]['params']>;
export type CanopyDispatcherInstructionResult<
  D extends CanopyInstructionDefinitionMap,
  N extends CanopyDispatcherInstructionName<D>,
> = CanopySchemaOutput<D[N]['result']>;
export type CanopyDispatcherInstructionResultInput<
  D extends CanopyInstructionDefinitionMap,
  N extends CanopyDispatcherInstructionName<D>,
> = CanopySchemaInput<D[N]['result']>;
export type CanopyDispatcherStreamName<D extends CanopyStreamDefinitionMap> =
  Extract<keyof D, string>;
export type CanopyDispatcherStreamParams<
  D extends CanopyStreamDefinitionMap,
  N extends CanopyDispatcherStreamName<D>,
> = CanopySchemaOutput<D[N]['params']>;
export type CanopyDispatcherStreamParamsInput<
  D extends CanopyStreamDefinitionMap,
  N extends CanopyDispatcherStreamName<D>,
> = CanopySchemaInput<D[N]['params']>;
export type CanopyDispatcherStreamItem<
  D extends CanopyStreamDefinitionMap,
  N extends CanopyDispatcherStreamName<D>,
> = CanopySchemaOutput<D[N]['item']>;
export type CanopyDispatcherStreamItemInput<
  D extends CanopyStreamDefinitionMap,
  N extends CanopyDispatcherStreamName<D>,
> = CanopySchemaInput<D[N]['item']>;
export type CanopyDispatcherStreamEnd<
  D extends CanopyStreamDefinitionMap,
  N extends CanopyDispatcherStreamName<D>,
> = CanopySchemaOutput<D[N]['end']>;

export type CanopyDispatcherHandlerMap<D extends CanopyQueryDefinitionMap> = {
  [N in CanopyDispatcherQueryName<D>]: (
    params: CanopyDispatcherQueryParams<D, N>,
    context: CanopyHandlerContext,
  ) =>
    | CanopyDispatcherQueryResult<D, N>
    | Promise<CanopyDispatcherQueryResult<D, N>>;
};
export type CanopyDispatcherInstructionHandlerMap<
  D extends CanopyInstructionDefinitionMap,
> = {
  [N in CanopyDispatcherInstructionName<D>]: (
    params: CanopyDispatcherInstructionParams<D, N>,
    context: CanopyHandlerContext,
  ) =>
    | CanopyDispatcherInstructionResultInput<D, N>
    | Promise<CanopyDispatcherInstructionResultInput<D, N>>;
};
export interface CanopyStreamSink<Item> {
  /**
   * Frames emitted but not yet taken by the consumer. A handler that
   * produces bursts can shed optional items before the buffer overflows and
   * ends the stream.
   */
  buffered?(): number;
  emit(
    item: Item,
    onCursorAssigned?: (cursor: CanopyStreamCursor) => void,
  ): CanopyStreamCursor | null;
  /**
   * Emits at a cursor from an independent durable source such as a journal.
   * Supplied cursors must keep the accepted resume epoch and exceed its sequence.
   * Without a resume cursor, the first call fixes the source epoch; subsequent
   * calls must keep it and strictly increase the sequence. An invalid cursor,
   * a non-increasing sequence, an epoch switch, or mixing with `emit` ends as an
   * invalid handler result and returns null.
   */
  emitAt(cursor: CanopyStreamCursor, item: Item): CanopyStreamCursor | null;
  end(
    outcome: 'completed' | 'cancelled' | 'error',
    error?: CanopyErrorPayload,
  ): void;
  /**
   * Ends at a cursor from the stream's source, such as the end a worker sent
   * for a stream bridged through the core, so a resume from the end reaches
   * that source. The rules of `emitAt` apply, except that the sequence may
   * equal the last one; a stream with no items and no resume cursor adopts
   * it. An invalid cursor ends as an invalid handler result at the last
   * cursor.
   */
  endAt(
    cursor: CanopyStreamCursor,
    outcome: 'completed' | 'cancelled' | 'error',
    error?: CanopyErrorPayload,
  ): void;
}
export type CanopyDispatcherStreamHandlerMap<
  D extends CanopyStreamDefinitionMap,
> = {
  [N in CanopyDispatcherStreamName<D>]: (
    params: CanopyDispatcherStreamParams<D, N>,
    context: CanopyHandlerContext,
    sink: CanopyStreamSink<CanopyDispatcherStreamItemInput<D, N>>,
  ) => Promise<(() => void) | void>;
};

export interface CanopyQueryOptions {
  caller: CanopyCallerDescriptor;
  metadata?: CanopyQueryRequestMetadata;
  signal?: AbortSignal;
  /** Refused unless the operation accepts host execution (CAN-5496). */
  execution?: CanopyHostExecution;
  /** Set only by the host transport that checked the lease (CAN-4730 E2-G). */
  lease?: CanopyAdmittedLease;
}
export interface CanopyInstructionOptions {
  caller: CanopyCallerDescriptor;
  metadata?: CanopyRequestMetadata;
  signal?: AbortSignal;
  /** Refused unless the operation accepts host execution (CAN-5496). */
  execution?: CanopyHostExecution;
  /** Set only by the host transport that checked the lease (CAN-4730 E2-G). */
  lease?: CanopyAdmittedLease;
}
export interface CanopyStreamOptions<
  Frame = CanopyStreamFrame<unknown, unknown>,
> extends CanopyQueryOptions {
  /** Attaches a push listener (see `CanopyStreamHandle.onFrame`) before the handler runs. */
  onFrame?: (frame: Frame) => void;
}
export type InProcessCanopyQueryOptions = Omit<CanopyQueryOptions, 'caller'>;
export type InProcessCanopyInstructionOptions = Omit<
  CanopyInstructionOptions,
  'caller'
>;
export type InProcessCanopyStreamOptions<
  Frame = CanopyStreamFrame<unknown, unknown>,
> = Omit<CanopyStreamOptions<Frame>, 'caller'>;

export type CanopyStreamFrame<Item, End> =
  | { kind: 'item'; cursor: CanopyStreamCursor; item: Item }
  | ({
      kind: 'end';
      cursor: CanopyStreamCursor;
      outcome: 'completed' | 'cancelled' | 'error';
      error: CanopyErrorPayload | null;
    } & End);
export interface CanopyStreamHandle<Item, End> {
  requestId: string;
  openResult: {
    subscriptionId: string;
    acceptedCursor: CanopyStreamCursor | null;
  };
  frames: AsyncIterable<CanopyStreamFrame<Item, End>>;
  /**
   * In-process push consumption: flushes buffered frames, then delivers each
   * frame synchronously from `sink.emit`/`sink.end`. Exclusive with `frames`.
   */
  onFrame(listener: (frame: CanopyStreamFrame<Item, End>) => void): () => void;
  close(): void;
}

export interface CanopyDispatcher<
  Q extends CanopyQueryDefinitionMap = CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap = CanopyStreamDefinitionMap,
> {
  readonly profile: CanopyRuntimeProfile;
  readonly definitions: Q;
  readonly state: CanopyRuntimeState;
  query<N extends CanopyDispatcherQueryName<Q>>(
    name: N,
    params: CanopyDispatcherQueryParams<Q, N>,
    options: CanopyQueryOptions,
  ): Promise<CanopyDispatcherQueryResult<Q, N>>;
  instruction<N extends CanopyDispatcherInstructionName<I>>(
    name: N,
    params: CanopyDispatcherInstructionParamsInput<I, N>,
    options: CanopyInstructionOptions,
  ): Promise<CanopyDispatcherInstructionResult<I, N>>;
  openStream<N extends CanopyDispatcherStreamName<S>>(
    name: N,
    params: CanopyDispatcherStreamParamsInput<S, N>,
    options: CanopyStreamOptions<
      CanopyStreamFrame<
        CanopyDispatcherStreamItem<S, N>,
        CanopyDispatcherStreamEnd<S, N>
      >
    >,
  ): Promise<
    CanopyStreamHandle<
      CanopyDispatcherStreamItem<S, N>,
      CanopyDispatcherStreamEnd<S, N>
    >
  >;
  /**
   * Refuses new instructions as `unavailable` while queries, streams, and
   * in-flight instructions continue. Idempotent; never reopens a closed runtime.
   */
  drainInstructions(): void;
  shutdown(): Promise<void>;
}
export interface InProcessCanopyClient<
  Q extends CanopyQueryDefinitionMap = CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap = CanopyStreamDefinitionMap,
> {
  query<N extends CanopyDispatcherQueryName<Q>>(
    name: N,
    params: CanopyDispatcherQueryParams<Q, N>,
    options?: InProcessCanopyQueryOptions,
  ): Promise<CanopyDispatcherQueryResult<Q, N>>;
  instruction<N extends CanopyDispatcherInstructionName<I>>(
    name: N,
    params: CanopyDispatcherInstructionParamsInput<I, N>,
    options?: InProcessCanopyInstructionOptions,
  ): Promise<CanopyDispatcherInstructionResult<I, N>>;
  openStream<N extends CanopyDispatcherStreamName<S>>(
    name: N,
    params: CanopyDispatcherStreamParamsInput<S, N>,
    options?: InProcessCanopyStreamOptions<
      CanopyStreamFrame<
        CanopyDispatcherStreamItem<S, N>,
        CanopyDispatcherStreamEnd<S, N>
      >
    >,
  ): Promise<
    CanopyStreamHandle<
      CanopyDispatcherStreamItem<S, N>,
      CanopyDispatcherStreamEnd<S, N>
    >
  >;
}

export interface CanopyRuntimeDefinitionMaps<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap,
> {
  queries: Q;
  instructions: I;
  streams: S;
}
export interface CanopyRuntimeHandlerMaps<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap,
> {
  queries: Partial<CanopyDispatcherHandlerMap<Q>>;
  instructions: Partial<CanopyDispatcherInstructionHandlerMap<I>>;
  streams: Partial<CanopyDispatcherStreamHandlerMap<S>>;
}
export interface CreateCanopyDispatcherOptions<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = Record<never, never>,
  S extends CanopyStreamDefinitionMap = Record<never, never>,
> {
  profile: CanopyRuntimeProfile;
  definitions: CanopyRuntimeDefinitionMaps<Q, I, S> | Q;
  handlers: CanopyRuntimeHandlerMaps<Q, I, S> | CanopyDispatcherHandlerMap<Q>;
  shutdownTimeoutMs?: number;
}
export interface CreateCanopyDispatcherKindOptions<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap,
> {
  profile: CanopyRuntimeProfile;
  definitions: CanopyRuntimeDefinitionMaps<Q, I, S>;
  handlers: CanopyRuntimeHandlerMaps<Q, I, S>;
  shutdownTimeoutMs?: number;
}
export interface CreateCanopyDispatcherLegacyOptions<
  Q extends CanopyQueryDefinitionMap,
> {
  profile: CanopyRuntimeProfile;
  definitions: Q;
  handlers: CanopyDispatcherHandlerMap<Q>;
  shutdownTimeoutMs?: number;
}
