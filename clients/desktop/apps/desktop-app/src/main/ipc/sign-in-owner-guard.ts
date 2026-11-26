import type { WebContents } from 'electron';

/**
 * Why a controller's sign-in work waits for someone else's sign-in (CAN-6718
 * review S2). The stable IPC error policy keeps this sentence on the
 * channels that send it (`legacy-error-text-contracts.ts`).
 */
export const SIGN_IN_ALREADY_RUNNING_MESSAGE =
  'A sign-in is already running on the computer.';

let openCodeSignInElsewhere: (sender: WebContents) => boolean = () => false;

/** Set by the auth-terminal handlers, which know each sign-in's window. */
export function setOpenCodeSignInOwnerCheck(
  check: (sender: WebContents) => boolean,
): void {
  openCodeSignInElsewhere = check;
}

/**
 * Whether revoking the OpenCode runtimes for `sender` would end an OpenCode
 * sign-in another window started, or fail one another window is starting:
 * every live OpenCode runtime is aborted, the one under a sign-in included.
 */
export function wouldEndAnotherOwnersOpenCodeSignIn(
  sender: WebContents,
): boolean {
  return openCodeSignInElsewhere(sender);
}

/** Why an OpenCode sign-in waits for a controller's OpenCode setup. */
export const OPENCODE_SETUP_RUNNING_MESSAGE =
  'OpenCode setup is already running.';

// Remote bridges whose OpenCode connect or disconnect passed its check and
// has not revoked yet (or is still running).
const openCodeSetupHolds = new Map<symbol, WebContents>();

/**
 * Holds OpenCode sign-in starts from every other window while a bridge's
 * OpenCode setup, which revokes every OpenCode runtime, runs: a sign-in
 * started then would be ended by the revoke, or would make the setup's
 * last check refuse after it had changed preferences. Returns the release.
 */
export function holdOpenCodeSignInStarts(sender: WebContents): () => void {
  const hold = Symbol('opencode setup');
  openCodeSetupHolds.set(hold, sender);
  return () => {
    openCodeSetupHolds.delete(hold);
  };
}

/** Whether another window's OpenCode setup holds `sender`'s OpenCode start. */
export function openCodeSetupHeldByAnother(sender: WebContents): boolean {
  return Array.from(openCodeSetupHolds.values()).some(
    (holder) => holder !== sender && !holder.isDestroyed(),
  );
}
