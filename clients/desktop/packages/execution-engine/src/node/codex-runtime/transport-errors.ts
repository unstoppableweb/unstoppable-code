import type { CodexTransportErrorDetail } from '@canopy/execution-engine/agent-failures/codex-transport-failure';
import {
  CodexSharedRestartRecoveryError,
  isCodexAppServerRequestTimeoutError,
  isCodexSharedRestartPeerError,
  isCodexThreadClosingError,
} from './connection';

/**
 * Rebuilds a failed turn outcome as an error without losing its transport
 * marker (`CodexTurnOutcome.transportFailure`).
 */
export class CodexTurnTransportFailureError extends Error {
  readonly detail: CodexTransportErrorDetail;

  constructor(message: string, detail: CodexTransportErrorDetail) {
    super(message);
    this.name = 'CodexTurnTransportFailureError';
    this.detail = detail;
  }
}

/** The error for a failed turn outcome, keeping its transport marker. */
export function codexTurnOutcomeError(
  outcome: {
    error?: string;
    transportFailure?: CodexTransportErrorDetail;
  },
  fallbackMessage: string,
): Error {
  const message = outcome.error ?? fallbackMessage;
  return outcome.transportFailure
    ? new CodexTurnTransportFailureError(message, outcome.transportFailure)
    : new Error(message);
}

// Recovery and wrapper errors keep the transport failure as `Error.cause`
// (for example a shared restart whose bystander recovery then failed).
const MAX_CAUSE_DEPTH = 5;

/**
 * The structured marker for a failure raised by the app-server transport, or
 * null for any other failure. Matches error types, not message text, except
 * for the app-server's own "thread is closing" rejection, which has no code.
 * Follows a bounded, cycle-safe `Error.cause` chain.
 */
export function classifyCodexTransportError(
  error: unknown,
): CodexTransportErrorDetail | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    const detail = classifyOwnTransportError(current);
    if (detail) return detail;
    if (!(current instanceof Error)) return null;
    // `Error.cause` is not in this package's TypeScript lib; read it directly.
    const cause: unknown = Reflect.get(current, 'cause');
    if (cause === undefined) return null;
    current = cause;
  }
  return null;
}

function classifyOwnTransportError(
  error: unknown,
): CodexTransportErrorDetail | null {
  if (error instanceof CodexTurnTransportFailureError) {
    return error.detail;
  }
  if (isCodexAppServerRequestTimeoutError(error)) {
    return {
      codex_error_code: 'app_server_request_timeout',
      codex_error_method: error.method,
    };
  }
  if (
    isCodexSharedRestartPeerError(error) ||
    error instanceof CodexSharedRestartRecoveryError
  ) {
    return { codex_error_code: 'app_server_shared_restart' };
  }
  if (isCodexThreadClosingError(error)) {
    return { codex_error_code: 'thread_closing' };
  }
  return null;
}
