import { CanopyOperationError } from '../../runtime/errors';

export function executionSecretNotGrantedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.executionSecret.notGranted',
    message:
      'This work was not granted the secrets it asked for. Start it again.',
    retry: { kind: 'never' },
  });
}

/** `source_failed`: the secret reader threw, unlike a value that is missing. */
export function executionSecretUnavailableError(
  reason?: 'source_failed',
): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.executionSecret.unavailable',
    message:
      'A secret this work needs is no longer available. Check its environment, integration or shared-container values, then start it again.',
    ...(reason && { details: { reason } }),
    retry: { kind: 'never' },
  });
}

export function executionSecretRevokedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'failed_precondition',
    code: 'worker.executionSecret.revoked',
    message: 'The secrets for this work were withdrawn before it started.',
    retry: { kind: 'never' },
  });
}

export function executionSecretUnsupportedError(): CanopyOperationError {
  return new CanopyOperationError({
    kind: 'capability_unavailable',
    code: 'worker.executionSecret.unsupported',
    message: 'This worker cannot receive account-proxy routes yet.',
    retry: { kind: 'never' },
  });
}

export class ExecutionSecretStageError extends Error {
  constructor(
    readonly code: 'invalid_bindings' | 'already_staged' | 'capacity',
    message: string,
  ) {
    super(message);
    this.name = 'ExecutionSecretStageError';
  }
}
