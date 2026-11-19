import {
  CanopyErrorPayloadSchema,
  composeCanopyOperationEnvelopes,
  encodeCanopyError,
  type CanopyErrorPayload,
  type CanopyInstructionDefinition,
  type CanopyInstructionDefinitionMap,
  type CanopyJsonRpcId,
  type CanopyJsonRpcMessage,
  type CanopyOperationEnvelopes,
  type CanopyQueryDefinition,
  type CanopyQueryDefinitionMap,
  type CanopyStreamDefinition,
  type CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';
import type { CanopyRuntimeDefinitionMaps } from './types';
import { paramsDeclareMeta } from './request-metadata';
import {
  CanopyOperationError,
  canopyInvalidHandlerResultError,
  canopyUnexpectedError,
  canopyUnavailableError,
} from './errors';

/** Host adapter owns serialization, envelope framing, and bounded delivery. */
export interface WorkerBindingConnection {
  readonly signal: AbortSignal;
  send(message: CanopyJsonRpcMessage): Promise<void>;
  receive(): Promise<CanopyJsonRpcMessage>;
  close(error?: CanopyErrorPayload): void;
}

/** Structurally compatible with L0's pair; concrete transport stays in the host. */
export interface WorkerBindingPair {
  readonly client: WorkerBindingConnection;
  readonly server: WorkerBindingConnection;
}

/** The worker dispatcher's maps; a dispatcher exposes only its queries. */
export type WorkerBindingDefinitions = CanopyRuntimeDefinitionMaps<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
>;

export type CallKind = 'query' | 'instruction' | 'stream';
export interface BoundOperation {
  readonly definition:
    | CanopyQueryDefinition
    | CanopyInstructionDefinition
    | CanopyStreamDefinition;
  readonly envelopes: CanopyOperationEnvelopes;
  /** The params schema declares `_meta`, so the worker keeps it in params. */
  readonly declaresMeta: boolean;
}

export const MAX_PENDING = 128;
export const MAX_STREAMS = 128;
/** Binding-private; `worker.binding` has no profile row, so no operation can share it. */
export const CANCEL_METHOD = 'worker.binding.cancel';
/** Binding-private like cancel: a receipt lookup and its release. */
export const RECEIPT_METHOD = 'worker.binding.receipt';
export const RELEASE_METHOD = 'worker.binding.receipt.release';

/** Composed eagerly: a definition the wire cannot carry fails at build. */
export function bindOperations(
  definitions: WorkerBindingDefinitions,
): Record<CallKind, Map<string, BoundOperation>> {
  const bindAll = (
    kind: CallKind,
    map: Readonly<Record<string, BoundOperation['definition']>>,
  ): Map<string, BoundOperation> => {
    const bound = new Map<string, BoundOperation>();
    for (const [name, definition] of Object.entries(map)) {
      if (definition.kind !== kind)
        throw new Error(`Worker binding ${name} must declare kind ${kind}`);
      const envelopes = composeCanopyOperationEnvelopes(name, definition);
      bound.set(name, {
        definition,
        envelopes,
        declaresMeta: paramsDeclareMeta(definition.params),
      });
    }
    return bound;
  };
  return {
    query: bindAll('query', definitions.queries),
    instruction: bindAll('instruction', definitions.instructions),
    stream: bindAll('stream', definitions.streams),
  };
}

export function capacityError(message: string): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'resource_exhausted',
    message,
    retry: { kind: 'never' },
  });
}

/** An untyped failure keeps its diagnostic only under the call's definition. */
export function errorResponse(
  id: CanopyJsonRpcId,
  error: unknown,
  definition?: BoundOperation['definition'],
): CanopyJsonRpcMessage {
  const payload =
    error instanceof CanopyOperationError
      ? error.payload
      : definition
        ? canopyUnexpectedError(
            error,
            definition.error,
            'The operation returned an invalid result.',
          ).payload
        : canopyInvalidHandlerResultError().payload;
  return { jsonrpc: '2.0', id, error: encodeCanopyError(payload) };
}

export function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([name]) => name !== key),
  );
}

/**
 * The dispatcher's retry class for a failure the binding raises itself, so a
 * lost reply never invites a blind repeat of a non-idempotent effect.
 */
export function directed(
  definition: BoundOperation['definition'],
  error: CanopyOperationError,
): CanopyOperationError {
  const { retry } = error.payload;
  if (
    definition.kind !== 'instruction' ||
    definition.idempotency === 'inherent' ||
    retry.kind !== 'same_request'
  )
    return error;
  return new CanopyOperationError(
    {
      ...error.payload,
      retry:
        definition.idempotency === 'keyed'
          ? { ...retry, kind: 'same_idempotency_key' }
          : { kind: 'never' },
    },
    error.runtimeCause,
  );
}

export function subscriptionOf(result: unknown): string | undefined {
  return typeof result === 'object' &&
    result !== null &&
    'subscriptionId' in result &&
    typeof result.subscriptionId === 'string'
    ? result.subscriptionId
    : undefined;
}

/** A send or read failure's typed payload, or `unavailable`. */
export function transportStopError(error: unknown): CanopyOperationError {
  const payload = CanopyErrorPayloadSchema.safeParse(
    typeof error === 'object' && error !== null && 'payload' in error
      ? error.payload
      : undefined,
  );
  return payload.success
    ? new CanopyOperationError(payload.data)
    : canopyUnavailableError();
}
