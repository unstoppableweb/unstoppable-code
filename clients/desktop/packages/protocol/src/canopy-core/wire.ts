import { z, type ZodType } from 'zod';

import {
  CanopyQueryRequestMetadataSchema,
  CanopyUnkeyedInstructionRequestMetadataSchema,
  CanopyRequestMetadataSchema,
  CanopyWorkspaceScopeSchema,
} from './common';
import {
  CanopyStreamCursorSchema,
  type CanopyInstructionDefinition,
  type CanopyStreamCursor,
  type CanopyQueryDefinition,
  type CanopyStreamDefinition,
} from './definitions';
import {
  CANOPY_HOST_EXECUTION_MEMBER,
  CanopyHostExecutionSchema,
  canopyOperationAcceptsHostExecution,
} from './host-execution';
import {
  CANOPY_ERROR_KINDS,
  CanopyErrorPayloadSchema,
  CanopyJsonValueSchema,
  type CanopyErrorKind,
  type CanopyErrorPayload,
} from './errors';
import { CanopyEventNameSchema, CanopyOperationNameSchema } from './names';

export const CANOPY_JSON_RPC_VERSION = '2.0';

/** Frozen operation-error mapping (protocol README §Frozen JSON-RPC error-code mapping). */
export const CANOPY_JSON_RPC_ERROR_CODES = {
  invalid_argument: -32602,
  unauthenticated: -32001,
  permission_denied: -32002,
  not_found: -32003,
  already_exists: -32004,
  conflict: -32005,
  failed_precondition: -32006,
  capability_unavailable: -32007,
  cancelled: -32008,
  deadline_exceeded: -32009,
  unavailable: -32010,
  resource_exhausted: -32011,
  internal: -32603,
} as const satisfies Record<CanopyErrorKind, number>;

/** Envelope failures raised before any operation handler runs. */
export const CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
} as const;

export type CanopyJsonRpcOperationErrorCode =
  (typeof CANOPY_JSON_RPC_ERROR_CODES)[CanopyErrorKind];

/** The mapping's codes in `CANOPY_ERROR_KINDS` order, as the catalog lists them. */
export const CANOPY_JSON_RPC_OPERATION_ERROR_CODES: readonly CanopyJsonRpcOperationErrorCode[] =
  CANOPY_ERROR_KINDS.map((kind) => CANOPY_JSON_RPC_ERROR_CODES[kind]);

// Protocol-level codes have no operation kind; map them to the nearest stable
// kind so clients still branch on `kind`, never on the integer.
const PROTOCOL_ERROR_KINDS: ReadonlyMap<number, CanopyErrorKind> = new Map([
  [CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.parseError, 'invalid_argument'],
  [CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.invalidRequest, 'invalid_argument'],
  [
    CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
    'capability_unavailable',
  ],
]);

export function canopyErrorKindForJsonRpcCode(
  code: number,
): CanopyErrorKind | null {
  for (const kind of CANOPY_ERROR_KINDS)
    if (CANOPY_JSON_RPC_ERROR_CODES[kind] === code) return kind;
  return PROTOCOL_ERROR_KINDS.get(code) ?? null;
}

const JsonRpcVersionSchema = z.literal(CANOPY_JSON_RPC_VERSION);
const RequestIdSchema = z.union([z.string().min(1).max(512), z.number().int()]);
const ResponseIdSchema = z.union([z.string(), z.number().int()]);
const ErrorResponseIdSchema = z.union([z.string(), z.number().int(), z.null()]);
const ErrorMessageSchema = z.string().min(1).max(4_096);
const IdentifierSchema = z.string().min(1).max(512);
const TimestampSchema = z.iso.datetime({ offset: true });
// Bodies are validated by their operation schema; the generic envelope only
// requires a present value.
const PresentValueSchema = z.custom<unknown>(
  (value) => value !== undefined,
  'Expected a value',
);

export const CanopyJsonRpcIdSchema = RequestIdSchema;
export type CanopyJsonRpcId = z.output<typeof CanopyJsonRpcIdSchema>;

export interface CanopyJsonRpcOperationErrorObject {
  code: CanopyJsonRpcOperationErrorCode;
  message: string;
  data: CanopyErrorPayload;
}

function operationErrorObjectSchema(
  data: ZodType<CanopyErrorPayload>,
): ZodType<CanopyJsonRpcOperationErrorObject> {
  return z
    .strictObject({
      code: z.literal(CANOPY_JSON_RPC_OPERATION_ERROR_CODES),
      message: ErrorMessageSchema,
      data,
    })
    .refine(
      (error) => CANOPY_JSON_RPC_ERROR_CODES[error.data.kind] === error.code,
      'error.code must match error.data.kind',
    );
}

export const CanopyJsonRpcOperationErrorObjectSchema =
  operationErrorObjectSchema(CanopyErrorPayloadSchema);

export const CanopyJsonRpcProtocolErrorObjectSchema = z
  .strictObject({
    code: z.literal(Object.values(CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES)),
    message: ErrorMessageSchema,
    data: CanopyErrorPayloadSchema.optional(),
  })
  .refine(
    (error) =>
      !error.data || PROTOCOL_ERROR_KINDS.get(error.code) === error.data.kind,
    'error.data.kind must match the protocol error code',
  );

export const CanopyJsonRpcErrorObjectSchema = z.union([
  CanopyJsonRpcOperationErrorObjectSchema,
  CanopyJsonRpcProtocolErrorObjectSchema,
]);
export type CanopyJsonRpcErrorObject = z.output<
  typeof CanopyJsonRpcErrorObjectSchema
>;

export const CanopyJsonRpcRequestSchema = z.strictObject({
  jsonrpc: JsonRpcVersionSchema,
  id: RequestIdSchema,
  method: CanopyOperationNameSchema,
  params: z.looseObject({ _meta: CanopyRequestMetadataSchema.optional() }),
});
export type CanopyJsonRpcRequest = z.output<typeof CanopyJsonRpcRequestSchema>;

export const CanopyJsonRpcSuccessResponseSchema = z.strictObject({
  jsonrpc: JsonRpcVersionSchema,
  id: ResponseIdSchema,
  result: PresentValueSchema,
});
export type CanopyJsonRpcSuccessResponse = z.output<
  typeof CanopyJsonRpcSuccessResponseSchema
>;

export const CanopyJsonRpcErrorResponseSchema = z.strictObject({
  jsonrpc: JsonRpcVersionSchema,
  id: ErrorResponseIdSchema,
  error: CanopyJsonRpcErrorObjectSchema,
});
export type CanopyJsonRpcErrorResponse = z.output<
  typeof CanopyJsonRpcErrorResponseSchema
>;

export const CanopyJsonRpcNotificationSchema = z.strictObject({
  jsonrpc: JsonRpcVersionSchema,
  method: CanopyOperationNameSchema,
  params: z.looseObject({}),
});
export type CanopyJsonRpcNotification = z.output<
  typeof CanopyJsonRpcNotificationSchema
>;

export const CanopyJsonRpcMessageSchema = z.union([
  CanopyJsonRpcRequestSchema,
  CanopyJsonRpcSuccessResponseSchema,
  CanopyJsonRpcErrorResponseSchema,
  CanopyJsonRpcNotificationSchema,
]);
export type CanopyJsonRpcMessage = z.output<typeof CanopyJsonRpcMessageSchema>;

export type CanopyJsonRpcParseResult =
  | { success: true; message: CanopyJsonRpcMessage }
  | { success: false; error: CanopyErrorPayload };

/** Validates one decoded envelope. Batch arrays are rejected (normative rule 4). */
export function parseCanopyJsonRpcMessage(
  value: unknown,
): CanopyJsonRpcParseResult {
  const parsed = Array.isArray(value)
    ? null
    : CanopyJsonRpcMessageSchema.safeParse(value);
  if (parsed?.success) return { success: true, message: parsed.data };
  // An error response keeps its known fields, as `decodeCanopyError` does,
  // so a newer peer's extra error field does not fail the envelope.
  const tolerant =
    parsed && typeof value === 'object' && value !== null && 'error' in value
      ? CanopyJsonRpcErrorResponseSchema.safeParse({
          ...value,
          error: knownErrorFields(value.error),
        })
      : undefined;
  if (tolerant?.success) return { success: true, message: tolerant.data };
  return {
    success: false,
    error: {
      kind: 'invalid_argument',
      message: parsed
        ? 'Invalid JSON-RPC 2.0 envelope.'
        : 'JSON-RPC batch requests are not supported.',
      retry: { kind: 'never' },
    },
  };
}

/** Maps a typed operation error onto its JSON-RPC error object. */
export function encodeCanopyError(
  error: CanopyErrorPayload | { readonly payload: CanopyErrorPayload },
): CanopyJsonRpcOperationErrorObject {
  const payload = 'payload' in error ? error.payload : error;
  return {
    code: CANOPY_JSON_RPC_ERROR_CODES[payload.kind],
    message: payload.message,
    data: payload,
  };
}

const ERROR_OBJECT_KEYS: readonly string[] = ['code', 'message', 'data'];
const ERROR_PAYLOAD_KEYS: readonly string[] = Object.keys(
  CanopyErrorPayloadSchema.shape,
);

function pickKeys(value: unknown, keys: readonly string[]): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).filter(([key]) => keys.includes(key)),
      )
    : value;
}

/** A newer peer's extra fields on an error object and its payload, dropped. */
function knownErrorFields(error: unknown): unknown {
  const object = pickKeys(error, ERROR_OBJECT_KEYS);
  return typeof object === 'object' && object !== null && 'data' in object
    ? { ...object, data: pickKeys(object.data, ERROR_PAYLOAD_KEYS) }
    : object;
}

/**
 * Inverse of `encodeCanopyError`. A newer peer's extra field on the error
 * object or its payload is dropped; invalid known fields still fail closed
 * as `internal`.
 */
export function decodeCanopyError(error: unknown): CanopyErrorPayload {
  const strict = CanopyJsonRpcErrorObjectSchema.safeParse(error);
  const parsed = strict.success
    ? strict
    : CanopyJsonRpcErrorObjectSchema.safeParse(knownErrorFields(error));
  if (!parsed.success)
    return {
      kind: 'internal',
      message: 'Received a malformed JSON-RPC error.',
      retry: { kind: 'never' },
    };
  return (
    parsed.data.data ?? {
      kind: canopyErrorKindForJsonRpcCode(parsed.data.code) ?? 'internal',
      message: parsed.data.message,
      retry: { kind: 'never' },
    }
  );
}

/** A stale or foreign cursor (doc 03 §Events and reconnect). */
export function isCanopySnapshotRequiredError(
  error: CanopyErrorPayload | null | undefined,
): boolean {
  return (
    error?.kind === 'failed_precondition' &&
    typeof error.code === 'string' &&
    error.code.endsWith('.snapshotRequired')
  );
}

/** One cursored, scoped domain event: the `core.events.subscribe` item. */
export const CanopyEventSchema = z
  .object({
    cursor: CanopyStreamCursorSchema,
    eventId: IdentifierSchema,
    // The catalog's JSON Schema freezes only the plane prefix; the runtime
    // also enforces the full name grammar (normative rule 2).
    name: z
      .string()
      .regex(/^(core|worker)\./)
      .refine(
        (name) => CanopyEventNameSchema.safeParse(name).success,
        'Expected a plane-qualified event name',
      ),
    scope: CanopyWorkspaceScopeSchema,
    occurredAt: TimestampSchema,
    payload: z.object({}).catchall(CanopyJsonValueSchema),
  })
  .catchall(CanopyJsonValueSchema);
export type CanopyEvent = z.output<typeof CanopyEventSchema>;

export interface CanopyStreamItemNotification<Item = unknown> {
  jsonrpc: typeof CANOPY_JSON_RPC_VERSION;
  method: string;
  params: {
    subscriptionId: string;
    cursor: CanopyStreamCursor;
    itemId: string;
    occurredAt: string;
    item: Item;
  };
}

export interface CanopyStreamEndNotification<End = unknown> {
  jsonrpc: typeof CANOPY_JSON_RPC_VERSION;
  method: string;
  params: { subscriptionId: string } & End;
}

export function canopyStreamItemNotificationSchema<Item>(
  name: string,
  item: ZodType<Item>,
): ZodType<CanopyStreamItemNotification<Item>> {
  return z.strictObject({
    jsonrpc: JsonRpcVersionSchema,
    method: z.literal(`${name}.item`),
    params: z.strictObject({
      subscriptionId: IdentifierSchema,
      cursor: CanopyStreamCursorSchema,
      itemId: IdentifierSchema,
      occurredAt: TimestampSchema,
      item,
    }),
  });
}

export function canopyStreamEndNotificationSchema(
  name: string,
  end: z.ZodObject,
): ZodType<CanopyStreamEndNotification<Record<string, unknown>>> {
  return z.strictObject({
    jsonrpc: JsonRpcVersionSchema,
    method: z.literal(`${name}.end`),
    params: z.strictObject({ subscriptionId: IdentifierSchema, ...end.shape }),
  });
}

export type CanopyStreamFrameType = 'item' | 'end' | 'snapshot_required';

/**
 * Classifies a stream notification. `snapshot_required` is an end frame whose
 * typed error asks the client to re-query canonical state before resubscribing.
 */
export function canopyStreamFrameType(
  name: string,
  notification: CanopyJsonRpcNotification,
): CanopyStreamFrameType | null {
  if (notification.method === `${name}.item`) return 'item';
  if (notification.method !== `${name}.end`) return null;
  const error = CanopyErrorPayloadSchema.safeParse(notification.params.error);
  return error.success && isCanopySnapshotRequiredError(error.data)
    ? 'snapshot_required'
    : 'end';
}

export interface CanopyOperationEnvelopes {
  readonly request: ZodType;
  readonly response: ZodType;
  /** Stream item and end notifications; absent for queries and instructions. */
  readonly notification?: ZodType;
}

type RequestMetadataKind = 'keyed' | 'instruction' | 'read';

function withRequestMetadata(
  params: ZodType,
  kind: RequestMetadataKind,
): ZodType {
  // A union of objects (for example create-or-replace) gets `_meta` per branch.
  if (
    params instanceof z.ZodUnion &&
    params.options.every((option) => option instanceof z.ZodObject)
  )
    return params.clone({
      ...params.def,
      options: params.options.map((option) =>
        withRequestMetadata(option, kind),
      ),
    });
  if (!(params instanceof z.ZodObject) || '_meta' in params.shape)
    return params;
  return params.extend({
    _meta:
      kind === 'keyed'
        ? CanopyRequestMetadataSchema.required({ idempotencyKey: true })
        : kind === 'instruction'
          ? CanopyUnkeyedInstructionRequestMetadataSchema.optional()
          : CanopyQueryRequestMetadataSchema.optional(),
  });
}

/** Admits `_execution` beside `_meta`; no params schema may declare it. */
function withHostExecution(name: string, params: ZodType): ZodType {
  const options =
    params instanceof z.ZodUnion &&
    params.options.every((option) => option instanceof z.ZodObject)
      ? params.options
      : [params];
  for (const option of options)
    if (
      option instanceof z.ZodObject &&
      CANOPY_HOST_EXECUTION_MEMBER in option.shape
    )
      throw new Error(`${name} params declare ${CANOPY_HOST_EXECUTION_MEMBER}`);
  if (!canopyOperationAcceptsHostExecution(name)) return params;
  if (!(params instanceof z.ZodObject))
    throw new Error(`${name} needs object params to accept host execution`);
  return params.extend({
    [CANOPY_HOST_EXECUTION_MEMBER]: CanopyHostExecutionSchema.optional(),
  });
}

function requestResponseEnvelopes(
  name: string,
  params: ZodType,
  result: ZodType,
  error: ZodType<CanopyErrorPayload>,
): CanopyOperationEnvelopes {
  return {
    request: z.strictObject({
      jsonrpc: JsonRpcVersionSchema,
      id: RequestIdSchema,
      method: z.literal(name),
      params,
    }),
    response: z.union([
      z.strictObject({
        jsonrpc: JsonRpcVersionSchema,
        id: ResponseIdSchema,
        result,
      }),
      z.strictObject({
        jsonrpc: JsonRpcVersionSchema,
        id: ErrorResponseIdSchema,
        error: operationErrorObjectSchema(error),
      }),
    ]),
  };
}

/**
 * Composes an operation definition into its full JSON-RPC envelopes: the
 * catalog's per-operation Request, Response, and stream Notification blocks.
 * A stream's `open` frame is its request; its success result is `openResult`.
 */
export function composeCanopyOperationEnvelopes(
  name: string,
  definition:
    | CanopyQueryDefinition
    | CanopyInstructionDefinition
    | CanopyStreamDefinition,
): CanopyOperationEnvelopes {
  const metadata: RequestMetadataKind =
    definition.kind !== 'instruction'
      ? 'read'
      : definition.idempotency === 'keyed'
        ? 'keyed'
        : 'instruction';
  const params = withHostExecution(
    name,
    withRequestMetadata(definition.params, metadata),
  );
  if (definition.kind !== 'stream')
    return requestResponseEnvelopes(
      name,
      params,
      definition.result,
      definition.error,
    );
  if (!definition.openResult || !(definition.end instanceof z.ZodObject))
    throw new Error(`stream ${name} needs an open result and an object end`);
  return {
    ...requestResponseEnvelopes(
      name,
      params,
      definition.openResult,
      definition.error,
    ),
    notification: z.union([
      canopyStreamItemNotificationSchema(name, definition.item),
      canopyStreamEndNotificationSchema(name, definition.end),
    ]),
  };
}
