/**
 * Renderer-side error helpers.
 *
 * Electron rejects a renderer-side `ipcRenderer.invoke(...)` with an `Error`
 * whose `.message` is wrapped with the channel name and the original error's
 * `toString()` — for example:
 *
 *   "Error invoking remote method 'chat:send-message': ResourceGuardError:
 *    Canopy is under high memory pressure. Wait for active work to finish
 *    before starting another chat."
 *
 * Use {@link extractIpcErrorMessage} on every renderer code path that takes a
 * caught IPC rejection and renders it to the user, so the message is shown
 * verbatim with no `Error invoking remote method '…':` wrapper, no class-name
 * prefix, and no `Error:` prefix. {@link extractIpcErrorName} returns the
 * error class name Electron keeps in front of a wrapped IPC message
 * (`CopilotPolicyError: …`), or undefined for a plain `Error`. Both live in
 * `@canopy/protocol/app-errors/ipc-rejection`, shared with the portable
 * CanopyClient adapter.
 */
import {
  extractIpcErrorMessage,
  extractIpcErrorName,
} from '@canopy/protocol/app-errors/ipc-rejection';

export {
  extractIpcErrorMessage,
  extractIpcErrorName,
} from '@canopy/protocol/app-errors/ipc-rejection';

/**
 * Our sentence for a failure, paired with the raw reason behind it. Settings
 * show `shown` and hand `details` to `ErrorBanner`'s Copy details action, so
 * the raw text never renders.
 */
export interface FailureDetails {
  readonly shown: string;
  readonly details: string;
}

/** Pairs the sentence a surface shows with the caught failure's raw reason. */
export function failureDetails(shown: string, cause: unknown): FailureDetails {
  return { shown, details: extractIpcErrorMessage(cause) };
}

/**
 * The raw reason for the error a surface shows now, or `undefined` once the
 * shown error is a different one (a later validation message, a cleared
 * error), so stale details never ride along.
 */
export function detailsFor(
  shown: string | null | undefined,
  failure: FailureDetails | null,
): string | undefined {
  return shown && failure?.shown === shown ? failure.details : undefined;
}

/**
 * Whether a caught rejection is a cancellation: an `AbortError` thrown
 * locally, or one an IPC handler rejected with (Electron keeps the name in
 * front of the wrapped message). Cancelled work shows nothing to the user.
 */
export function isIpcCancellation(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  return extractIpcErrorName(error) === 'AbortError';
}
