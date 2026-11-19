import { z } from 'zod';

import {
  AppErrorClassSchema,
  AppErrorErrnoSchema,
} from '../app-errors/primitives';
import { appErrorNativeFrames } from '../app-errors/native-frames';
import { utf8ByteLength } from './core/ledger/text';
import { CanopyOperationCodeSchema } from './names';

export const CANOPY_ERROR_KINDS = [
  'invalid_argument',
  'unauthenticated',
  'permission_denied',
  'not_found',
  'already_exists',
  'conflict',
  'failed_precondition',
  'capability_unavailable',
  'cancelled',
  'deadline_exceeded',
  'unavailable',
  'resource_exhausted',
  'internal',
] as const;

export const CanopyErrorKindSchema = z.enum(CANOPY_ERROR_KINDS);
export type CanopyErrorKind = z.output<typeof CanopyErrorKindSchema>;

const RETRY_DELAY_SCHEMA = z.number().int().nonnegative().max(86_400_000);

export const CanopyRetryDirectiveSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('never') }),
  z.strictObject({
    kind: z.literal('same_request'),
    delayMs: RETRY_DELAY_SCHEMA.optional(),
  }),
  z.strictObject({
    kind: z.literal('same_idempotency_key'),
    delayMs: RETRY_DELAY_SCHEMA.optional(),
  }),
  z.strictObject({
    kind: z.literal('after_refresh'),
    resource: z.string().min(1).max(512),
    delayMs: RETRY_DELAY_SCHEMA.optional(),
  }),
]);

export const CanopyQueryRetryDirectiveSchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[1],
  CanopyRetryDirectiveSchema.options[3],
]);

// Keyed operations replay only with their idempotency key.
export const CanopyKeyedRetryDirectiveSchema = z.discriminatedUnion('kind', [
  CanopyRetryDirectiveSchema.options[0],
  CanopyRetryDirectiveSchema.options[2],
  CanopyRetryDirectiveSchema.options[3],
]);

export type CanopyRetryDirective = z.output<typeof CanopyRetryDirectiveSchema>;

export type CanopyJsonValue =
  | null
  | boolean
  | number
  | string
  | CanopyJsonValue[]
  | { [key: string]: CanopyJsonValue };

const MAX_DETAILS_DEPTH = 16;
const MAX_DETAILS_COLLECTION_SIZE = 1_000;
const MAX_DETAILS_SERIALIZED_LENGTH = 32_768;

interface JsonValueLimits {
  readonly depth: number;
  readonly collectionSize: number;
}

const DETAILS_LIMITS: JsonValueLimits = {
  depth: MAX_DETAILS_DEPTH,
  collectionSize: MAX_DETAILS_COLLECTION_SIZE,
};

function isJsonValue(
  value: unknown,
  depth: number,
  ancestors: Set<object>,
  limits: JsonValueLimits = DETAILS_LIMITS,
): value is CanopyJsonValue {
  if (value === null) return true;
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (typeof value !== 'object' || depth >= limits.depth) return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return (
        value.length <= limits.collectionSize &&
        value.every((entry) => isJsonValue(entry, depth + 1, ancestors, limits))
      );
    }

    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    const keys = Object.getOwnPropertyNames(value);
    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (keys.length > limits.collectionSize || symbolKeys.length !== 0) {
      return false;
    }

    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !isJsonValue(descriptor.value, depth + 1, ancestors, limits)
      ) {
        return false;
      }
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

export function isBoundedCanopyJsonValue(
  value: unknown,
): value is CanopyJsonValue {
  if (!isJsonValue(value, 0, new Set())) return false;
  try {
    return JSON.stringify(value).length <= MAX_DETAILS_SERIALIZED_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Marks the schemas the protocol catalog renders as a JSON value, so its
 * generators map {@link canopyJsonValueSchemaWithin} schemas as they map
 * {@link CanopyJsonValueSchema}.
 */
export const CANOPY_JSON_VALUE_SCHEMA_MARKER = Symbol.for('canopy.jsonValue');

function markJsonValueSchema<T extends object>(schema: T): T {
  Object.defineProperty(schema, CANOPY_JSON_VALUE_SCHEMA_MARKER, {
    value: true,
  });
  return schema;
}

export const CanopyJsonValueSchema = markJsonValueSchema(
  z.custom<CanopyJsonValue>(
    isBoundedCanopyJsonValue,
    'Expected bounded JSON-safe data',
  ),
);

/** Nesting a byte-bounded JSON value may reach (CAN-5095). */
const BYTE_BOUNDED_LIMITS: JsonValueLimits = {
  depth: 64,
  collectionSize: Number.POSITIVE_INFINITY,
};

/**
 * JSON-safe data of at most `maxBytes` as UTF-8 JSON, for payloads larger
 * than {@link CanopyJsonValueSchema} admits, such as tool calls (CAN-5095).
 */
export function canopyJsonValueSchemaWithin(
  maxBytes: number,
): z.ZodCustom<CanopyJsonValue> {
  return markJsonValueSchema(
    z.custom<CanopyJsonValue>((value) => {
      if (!isJsonValue(value, 0, new Set(), BYTE_BOUNDED_LIMITS)) return false;
      try {
        const serialized = JSON.stringify(value);
        // UTF-8 never takes fewer bytes than UTF-16 code units.
        return (
          serialized.length <= maxBytes &&
          utf8ByteLength(serialized) <= maxBytes
        );
      } catch {
        return false;
      }
    }, 'Expected bounded JSON-safe data'),
  );
}

export const CanopyErrorPayloadSchema = z.strictObject({
  kind: CanopyErrorKindSchema,
  message: z.string().min(1).max(4_096),
  code: CanopyOperationCodeSchema.optional(),
  details: CanopyJsonValueSchema.optional(),
  retry: CanopyRetryDirectiveSchema,
});

export type CanopyErrorPayload = z.output<typeof CanopyErrorPayloadSchema>;

export const CANOPY_ERROR_DIAGNOSTIC_MAX_FRAMES = 12;
export const CANOPY_ERROR_DIAGNOSTIC_MAX_FRAME_LENGTH = 300;
const CANOPY_ERROR_DIAGNOSTIC_FRAME = /^[ \t]*at [^\r\n]*$/;

/**
 * What an unexpected handler failure keeps of its original error:
 * allowlisted class and system code, and V8 `at` frames. Never the message.
 * Carried as `details.diagnostic` of the fixed-message `internal` error.
 */
export const CanopyErrorDiagnosticSchema = z.strictObject({
  name: AppErrorClassSchema,
  code: AppErrorErrnoSchema.optional(),
  frames: z
    .array(
      z
        .string()
        .max(CANOPY_ERROR_DIAGNOSTIC_MAX_FRAME_LENGTH)
        .regex(CANOPY_ERROR_DIAGNOSTIC_FRAME),
    )
    .max(CANOPY_ERROR_DIAGNOSTIC_MAX_FRAMES),
});

export type CanopyErrorDiagnostic = z.output<
  typeof CanopyErrorDiagnosticSchema
>;

/** The diagnostic of an error payload; an invalid one is ignored whole. */
export function readCanopyErrorDiagnostic(
  details: unknown,
): CanopyErrorDiagnostic | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const parsed = CanopyErrorDiagnosticSchema.safeParse(
    Reflect.get(details, 'diagnostic'),
  );
  return parsed.success ? parsed.data : undefined;
}

function readProperty(value: unknown, key: string): unknown {
  try {
    return typeof value === 'object' && value !== null
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The allowlisted facts of an unexpected failure: class, system code and V8
 * frames, never its message. Call it before anything reads `error.stack`.
 */
export function canopyErrorDiagnostic(error: unknown): CanopyErrorDiagnostic {
  const name = AppErrorClassSchema.safeParse(readProperty(error, 'name'));
  const code = AppErrorErrnoSchema.safeParse(readProperty(error, 'code'));
  return {
    name: name.success ? name.data : 'Error',
    ...(code.success ? { code: code.data } : {}),
    frames: appErrorNativeFrames(error)
      .filter((line) => CANOPY_ERROR_DIAGNOSTIC_FRAME.test(line))
      .slice(0, CANOPY_ERROR_DIAGNOSTIC_MAX_FRAMES)
      .map((line) => line.slice(0, CANOPY_ERROR_DIAGNOSTIC_MAX_FRAME_LENGTH)),
  };
}
