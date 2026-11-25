/**
 * A Cloud account sign-in that the user cancelled or that a newer sign-in
 * replaced (CAN-6895). Named `AbortError` so the IPC boundary passes it through
 * as a cancellation, with no AppError and no defect report.
 *
 * The message is pinned by the cloud account lifecycle golden and quoted by
 * the generated cloud account protocol pages; it must not change.
 *
 * Kept apart from `oauth-login.ts` so `ipc/settings.ts` can import it without
 * defeating that module's lazy import.
 */
export class OAuthLoginEndedError extends Error {
  readonly reason: 'cancelled' | 'replaced';

  constructor(reason: 'cancelled' | 'replaced') {
    super(`OAuth login ${reason}.`);
    this.name = 'AbortError';
    this.reason = reason;
  }
}
