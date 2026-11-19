import {
  CanopyErrorKindSchema,
  CanopyErrorPayloadSchema,
  CanopyOperationCodeSchema,
  CanopyRetryDirectiveSchema,
  readCanopyErrorDiagnostic,
  type CanopyErrorDiagnostic,
  type CanopyErrorPayload,
} from '@canopy/protocol/canopy-core';
import { z } from 'zod';
import {
  safeErrorProperty,
  type IpcOperationFailure,
} from './app-error-rejection';

/** Validates the semantics a preload lookup returns to its reader. */
export const IpcOperationFailureSchema: z.ZodType<IpcOperationFailure> =
  z.strictObject({
    status: CanopyErrorKindSchema,
    code: CanopyOperationCodeSchema.optional(),
    retry: CanopyRetryDirectiveSchema,
    effects: z.enum(['none', 'unknown']).optional(),
  });

const operationPayloadMarker = Symbol.for('canopy.ipcOperationPayload');

/**
 * Attaches a typed outcome to the legacy rejection a compatibility adapter
 * rethrows, keeping that value's identity and enumerable fields.
 */
export function markIpcOperationPayload<ErrorValue>(
  error: ErrorValue,
  payload: CanopyErrorPayload,
): ErrorValue {
  try {
    if (typeof error === 'object' && error !== null)
      Object.defineProperty(error, operationPayloadMarker, {
        value: payload,
        enumerable: false,
        configurable: true,
      });
  } catch {
    // A frozen rejection still propagates unchanged.
  }
  return error;
}

function toOperationFailure(payload: CanopyErrorPayload): IpcOperationFailure {
  const claim =
    typeof payload.details === 'object' &&
    payload.details !== null &&
    !Array.isArray(payload.details)
      ? payload.details.effects
      : undefined;
  return {
    status: payload.kind,
    ...(payload.code === undefined ? {} : { code: payload.code }),
    retry: payload.retry,
    // A claim this reader can't interpret is not evidence that nothing happened.
    ...(claim === undefined
      ? {}
      : { effects: claim === 'none' ? 'none' : 'unknown' }),
  };
}

/** Only a schema-valid payload counts; the outermost in the cause chain wins. */
function readOperationPayload(thrown: unknown): CanopyErrorPayload | undefined {
  const visited = new Set<unknown>();
  let current = thrown;
  for (let depth = 0; depth <= 4 && !visited.has(current); depth++) {
    visited.add(current);
    for (const key of [operationPayloadMarker, 'payload']) {
      const parsed = CanopyErrorPayloadSchema.safeParse(
        safeErrorProperty(current, key),
      );
      if (parsed.success) return parsed.data;
    }
    current = safeErrorProperty(current, 'cause');
    if (current === undefined) break;
  }
  return undefined;
}

export function readIpcOperationFailure(
  thrown: unknown,
): IpcOperationFailure | undefined {
  const payload = readOperationPayload(thrown);
  return payload && toOperationFailure(payload);
}

/**
 * The class, system code and frames a daemon kept of an unexpected failure.
 * Separate from the preload-facing failure shape; an invalid one is ignored.
 */
export function readIpcOperationDiagnostic(
  thrown: unknown,
): CanopyErrorDiagnostic | undefined {
  return readCanopyErrorDiagnostic(readOperationPayload(thrown)?.details);
}
