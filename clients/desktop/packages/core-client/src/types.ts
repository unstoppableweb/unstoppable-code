import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import type {
  CanopyErrorPayload,
  CanopyHostExecution,
  CanopyInstructionDefinitionMap,
  CanopyQueryDefinitionMap,
  CanopyQueryRequestMetadata,
  CanopyRequestMetadata,
  CanopySchemaInput,
  CanopySchemaOutput,
  CanopyStreamCursor,
  CanopyStreamDefinitionMap,
  CoreRuntimeInitializeResult,
  CoreClientLeaseEvicted,
} from '@canopy/protocol/canopy-core';

export interface CanopyClientDefinitions<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap,
> {
  readonly queries: Q;
  readonly instructions: I;
  readonly streams: S;
}

export interface CanopyClientOptions<
  Q extends CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = Record<never, never>,
  S extends CanopyStreamDefinitionMap = Record<never, never>,
> {
  /** An authenticated connection from any binding; the client takes ownership. */
  readonly connection: CanopyFramedConnection;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly definitions: CanopyClientDefinitions<Q, I, S>;
  /** Defaults to `CANOPY_CLIENT_PROTOCOL_VERSIONS`. */
  readonly protocolVersions?: readonly number[];
  readonly clientCapabilities?: readonly string[];
  /**
   * Owner sessions only (CAN-5771): proves the daemon's owner secret for this
   * connection. Called once with the connection's server-issued id; the
   * result is sent as `client.ownerProof` in `core.runtime.initialize`.
   * Trusted main composition only; never from renderer, Portal or remote input.
   */
  readonly ownerProof?: (connectionId: string) => string;
  /** Aborting closes the client and the connection. */
  readonly signal?: AbortSignal;
}

/** Authority, runtime, host, and epoch are independent; never derive one from another. */
export interface CanopyRuntimeIdentity {
  readonly connectionId: string;
  readonly authorityId: string | null;
  readonly runtimeId: string;
  readonly hostId: string;
  readonly daemonEpoch: string;
  readonly profile: CoreRuntimeInitializeResult['runtime']['profile'];
  readonly buildVersion: string;
  readonly protocolVersion: number;
}

export type CanopyManifestKind = 'operations' | 'events' | 'streams';

/**
 * The connection's effective allowlists. The public sets are informational
 * copies; `has` reads a private snapshot that callers cannot mutate.
 */
export interface CanopyEffectiveManifest {
  readonly operations: ReadonlySet<string>;
  readonly events: ReadonlySet<string>;
  readonly streams: ReadonlySet<string>;
  has(kind: CanopyManifestKind, name: string): boolean;
}

export interface CanopyClientQueryOptions {
  readonly metadata?: CanopyQueryRequestMetadata;
  readonly signal?: AbortSignal;
  /**
   * Same-host execution input, sent as `_execution` only by operations that
   * accept it (CAN-5496). Supply it only from a trusted host builder; never
   * from params, renderer, Portal or remote input. Never log it.
   */
  readonly execution?: CanopyHostExecution;
}
export interface CanopyClientInstructionOptions {
  readonly metadata?: CanopyRequestMetadata;
  readonly signal?: AbortSignal;
  /** As {@link CanopyClientQueryOptions.execution}. */
  readonly execution?: CanopyHostExecution;
}
export interface CanopyClientStreamOptions<
  Frame = unknown,
> extends CanopyClientQueryOptions {
  /** Attached before the next receive is processed, so no frame is missed. */
  readonly onFrame?: (frame: Frame) => void;
}

export type CanopyClientStreamFrame<Item, End> =
  | { kind: 'item'; cursor: CanopyStreamCursor; item: Item }
  | ({
      kind: 'end';
      cursor: CanopyStreamCursor;
      outcome: 'completed' | 'cancelled' | 'error';
      error: CanopyErrorPayload | null;
    } & End);

export interface CanopyClientStreamHandle<Item, End> {
  requestId: string;
  openResult: {
    subscriptionId: string;
    acceptedCursor: CanopyStreamCursor | null;
  };
  /** Exclusive with `onFrame`. */
  frames: AsyncIterable<CanopyClientStreamFrame<Item, End>>;
  /** Flushes buffered frames, then delivers each new frame. Returns an unsubscribe. */
  onFrame(
    listener: (frame: CanopyClientStreamFrame<Item, End>) => void,
  ): () => void;
  close(): void;
}

type QueryName<Q extends CanopyQueryDefinitionMap> = Extract<keyof Q, string>;
type InstructionName<I extends CanopyInstructionDefinitionMap> = Extract<
  keyof I,
  string
>;
type StreamName<S extends CanopyStreamDefinitionMap> = Extract<keyof S, string>;
type StreamFrameFor<
  S extends CanopyStreamDefinitionMap,
  N extends StreamName<S>,
> = CanopyClientStreamFrame<
  CanopySchemaOutput<S[N]['item']>,
  CanopySchemaOutput<S[N]['end']>
>;

export interface CanopyClient<
  Q extends CanopyQueryDefinitionMap = CanopyQueryDefinitionMap,
  I extends CanopyInstructionDefinitionMap = CanopyInstructionDefinitionMap,
  S extends CanopyStreamDefinitionMap = CanopyStreamDefinitionMap,
> {
  readonly connection: CanopyFramedConnection;
  /** The validated `core.runtime.initialize` runtime descriptor. */
  readonly runtime: CoreRuntimeInitializeResult['runtime'];
  readonly identity: CanopyRuntimeIdentity;
  readonly manifest: CanopyEffectiveManifest;
  /** Aborts when the client closes or its connection drops. */
  readonly signal: AbortSignal;
  /** Authenticated binding lifecycle notification; never a domain-event subscription. */
  onLeaseEvicted(listener: (event: CoreClientLeaseEvicted) => void): () => void;
  query<N extends QueryName<Q>>(
    name: N,
    params: CanopySchemaOutput<Q[N]['params']>,
    options?: CanopyClientQueryOptions,
  ): Promise<CanopySchemaOutput<Q[N]['result']>>;
  instruction<N extends InstructionName<I>>(
    name: N,
    params: CanopySchemaInput<I[N]['params']>,
    options?: CanopyClientInstructionOptions,
  ): Promise<CanopySchemaOutput<I[N]['result']>>;
  openStream<N extends StreamName<S>>(
    name: N,
    params: CanopySchemaInput<S[N]['params']>,
    options?: CanopyClientStreamOptions<StreamFrameFor<S, N>>,
  ): Promise<
    CanopyClientStreamHandle<
      CanopySchemaOutput<S[N]['item']>,
      CanopySchemaOutput<S[N]['end']>
    >
  >;
  close(): Promise<void>;
}
