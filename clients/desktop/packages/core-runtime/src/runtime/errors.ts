import {
  canopyErrorDiagnostic,
  CanopyErrorPayloadSchema,
  type CanopyErrorKind,
  type CanopyErrorPayload,
  type CanopyRetryDirective,
} from '@canopy/protocol/canopy-core';

const NEVER_RETRY = { kind: 'never' } as const;
const SAME_REQUEST_RETRY = { kind: 'same_request' } as const;

export class CanopyOperationError extends Error {
  public readonly payload: CanopyErrorPayload;
  public readonly runtimeCause: unknown;

  public constructor(payload: CanopyErrorPayload, runtimeCause?: unknown) {
    const validatedPayload = CanopyErrorPayloadSchema.parse(payload);
    super(validatedPayload.message);
    this.name = 'CanopyOperationError';
    this.payload = validatedPayload;
    Object.defineProperty(this, 'runtimeCause', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: runtimeCause,
    });
  }

  public toJSON(): CanopyErrorPayload {
    return this.payload;
  }
}

function operationError(
  kind: CanopyErrorKind,
  message: string,
  retry: CanopyRetryDirective,
  runtimeCause?: unknown,
): CanopyOperationError {
  return new CanopyOperationError(
    { kind, message: message.slice(0, 4_096), retry },
    runtimeCause,
  );
}

export function canopyInvalidArgumentError(
  message: string,
  runtimeCause?: unknown,
): CanopyOperationError {
  return operationError('invalid_argument', message, NEVER_RETRY, runtimeCause);
}

export function canopyUnauthenticatedError(
  message = 'Caller authentication is invalid.',
  runtimeCause?: unknown,
): CanopyOperationError {
  return operationError('unauthenticated', message, NEVER_RETRY, runtimeCause);
}

export function canopyPermissionDeniedError(
  message = 'The caller is not permitted to perform this operation.',
  runtimeCause?: unknown,
): CanopyOperationError {
  return operationError(
    'permission_denied',
    message,
    NEVER_RETRY,
    runtimeCause,
  );
}

export function canopyDeadlineExceededError(
  message = 'The operation deadline was exceeded.',
  retry: CanopyRetryDirective = SAME_REQUEST_RETRY,
): CanopyOperationError {
  return operationError('deadline_exceeded', message, retry);
}

export function canopyCancelledError(
  message = 'The operation was cancelled.',
): CanopyOperationError {
  return operationError('cancelled', message, NEVER_RETRY);
}

export function canopyUnavailableError(
  message = 'The runtime is unavailable.',
  retry: CanopyRetryDirective = SAME_REQUEST_RETRY,
): CanopyOperationError {
  return operationError('unavailable', message, retry);
}

export function canopyStreamBufferExhaustedError(): CanopyOperationError {
  return operationError(
    'resource_exhausted',
    'Stream buffer capacity exceeded.',
    { kind: 'after_refresh', resource: 'stream' },
  );
}

export function canopyCapabilityUnavailableError(
  message = 'The requested operation is unavailable.',
): CanopyOperationError {
  return operationError('capability_unavailable', message, NEVER_RETRY);
}

export function canopyInvalidHandlerResultError(): CanopyOperationError {
  return operationError(
    'internal',
    'The operation returned an invalid result.',
    NEVER_RETRY,
  );
}

export function canopyInternalError(
  message = 'The operation failed.',
  runtimeCause?: unknown,
): CanopyOperationError {
  return operationError('internal', message, NEVER_RETRY, runtimeCause);
}

/** The value-free facts of a failed process spawn: no path, argument or message. */
export interface SpawnFailureDetails {
  readonly errno: string;
  readonly stage: 'spawn';
}

// The errnos a caller can act on; any other reads as `other` (CAN-7113).
const ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'ENOTDIR']);

export function isAllowlistedErrno(value: unknown): value is string {
  return typeof value === 'string' && ERRNOS.has(value);
}

/** A spawn error's own `code` when it is an allowlisted errno, else `other`. */
export function spawnFailureDetails(error: unknown): SpawnFailureDetails {
  const code: unknown =
    typeof error === 'object' && error !== null
      ? Reflect.get(error, 'code')
      : undefined;
  return { errno: isAllowlistedErrno(code) ? code : 'other', stage: 'spawn' };
}

/**
 * The fixed-message `internal` error for a failure nobody typed. Its
 * `details.diagnostic` keeps the original's class and frames over the wire,
 * but only where the operation's error schema admits it: a client fails any
 * other error closed as undeclared. The original stays the `runtimeCause`.
 */
export function canopyUnexpectedError(
  error: unknown,
  errorSchema: { safeParse(value: unknown): { success: boolean } },
  message = 'The operation failed.',
): CanopyOperationError {
  const payload: CanopyErrorPayload = {
    kind: 'internal',
    message,
    details: { diagnostic: canopyErrorDiagnostic(error) },
    retry: NEVER_RETRY,
  };
  return errorSchema.safeParse(payload).success
    ? new CanopyOperationError(payload, error)
    : operationError('internal', message, NEVER_RETRY, error);
}
