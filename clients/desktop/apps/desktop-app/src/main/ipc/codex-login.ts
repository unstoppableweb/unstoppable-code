import type { BrowserWindow, WebContents } from 'electron';
import {
  IPC_CHANNELS,
  type CodexLoginStartRequest,
  type CodexLoginState,
} from '@canopy/desktop-shared/types';
import { codexLoginManager } from '../auth/codex-login';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';
import { openExternalGuarded } from '../lib/open-external';
import { registerIpcHandler } from './register';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';

/**
 * A start refused because another window's attempt is running (CAN-6718).
 * It is an answer, not a thrown error: IPC replaces a thrown error's text
 * with generic copy, and the dialog needs to say what to wait for.
 */
const ALREADY_RUNNING: CodexLoginState = {
  attemptId: null,
  phase: 'ready',
  activeWorkCount: 0,
  refusal: 'already-running',
};

/**
 * The state without what lets someone finish the sign-in: the device code
 * and its page. Windows that don't own the attempt learn only its phase.
 */
function withoutSignInSecrets(state: CodexLoginState): CodexLoginState {
  const shared = { ...state };
  delete shared.userCode;
  delete shared.verificationUrl;
  return shared;
}

/**
 * Each sign-in attempt belongs to the window that started it: this computer's
 * app window, or a remote bridge window carrying another computer's calls.
 * A bridge may only start the device-code method, whose code and page the
 * controlling computer shows and opens itself; the browser method runs a
 * callback on this computer, so it stays with the app window, and so does
 * opening this computer's browser.
 */
export function registerCodexLoginHandlers(
  getWindow: () => BrowserWindow | null,
  isRemoteBridge: (sender: WebContents) => boolean = (sender) =>
    resolveRemoteBridgeSender(sender) !== null,
): void {
  const observedSenders = new WeakSet<WebContents>();
  let attemptOwner: WebContents | null = null;
  // The last bridge attempt abandoned after it failed, so a close that fails
  // and publishes the failure again isn't retried in a loop.
  let abandonedAfterFailure: string | null = null;
  // Windows that went away while their attempt is still being abandoned.
  const cancelling = new Set<WebContents>();
  const isAppWindow = (sender: WebContents): boolean =>
    sender === getWindow()?.webContents;
  /**
   * A window that went away leaves its attempt reserved when abandoning it
   * couldn't close it (the manager still holds the attempt). No other
   * controller may adopt it; this computer's own window may, to cancel or
   * retry it, since only someone at this computer can still recover it.
   */
  const adoptOrphanedAttempt = (sender: WebContents): void => {
    if (
      attemptOwner !== null &&
      attemptOwner.isDestroyed() &&
      !cancelling.has(attemptOwner) &&
      isAppWindow(sender)
    )
      attemptOwner = sender;
  };
  const requireAttemptOwner = (sender: WebContents): void => {
    adoptOrphanedAttempt(sender);
    if (
      sender !== attemptOwner ||
      (!isAppWindow(sender) && !isRemoteBridge(sender))
    )
      throw new Error(
        'Codex sign-in command requires the owning desktop window.',
      );
  };
  // The state goes to the window that owns the attempt. A bridge owner hears
  // it through its own window, so only its controller sees the code; this
  // computer's window then gets it without the code and page. Main's copy
  // for this computer's window is never mirrored to controllers
  // (`remote-control/host/main-window-pushes.ts`).
  codexLoginManager.onState((state) => {
    const owner = attemptOwner;
    if (state.phase === 'complete' && (!owner || !cancelling.has(owner)))
      attemptOwner = null;
    // A bridge's attempt that failed or was cancelled (its code expired or it
    // timed out) and then couldn't verify the account, as on a signed-out
    // host, is closed without a verified account once this state is
    // delivered, so it doesn't hold the sign-in for every other window while
    // its controller stays connected. One that signed in but failed only
    // verification stays for its controller to retry, and so does one with
    // paused work: the controller's resume prompt offers Retry for it, and
    // its Cancel or the controller leaving abandons it.
    const abandonFailed =
      owner !== null &&
      !isAppWindow(owner) &&
      state.phase === 'verification-failed' &&
      state.outcome !== 'success' &&
      state.activeWorkCount === 0 &&
      state.attemptId !== null &&
      abandonedAfterFailure !== state.attemptId;
    const appWindow = getWindow();
    const deliveries: [SendableBrowserWindow | null, CodexLoginState][] =
      owner && !isAppWindow(owner)
        ? [
            [
              { isDestroyed: () => owner.isDestroyed(), webContents: owner },
              state,
            ],
            [appWindow, withoutSignInSecrets(state)],
          ]
        : [[appWindow, state]];
    for (const [target, delivered] of deliveries)
      sendToWindow(target, IPC_CHANNELS.codexLoginState, delivered);
    if (abandonFailed) {
      abandonedAfterFailure = state.attemptId;
      // Publishes nothing before its first await, so it can start here.
      void codexLoginManager.abandon().catch(() => undefined);
    }
  });
  registerIpcHandler<[CodexLoginStartRequest], CodexLoginState>(
    IPC_CHANNELS.codexLoginStart,
    (event, request) => {
      if (
        !request ||
        typeof request.confirmPause !== 'boolean' ||
        (request.method !== 'chatgpt' && request.method !== 'chatgptDeviceCode')
      )
        throw new Error('Invalid Codex sign-in request.');
      if (!isAppWindow(event.sender)) {
        if (!isRemoteBridge(event.sender))
          throw new Error('Codex sign-in requires the desktop window.');
        if (request.method !== 'chatgptDeviceCode')
          throw new Error(
            'Sign in to Codex with a device code from another computer.',
          );
      }
      // Another window's attempt is still running, or still being cancelled
      // after its window went away (CAN-6718 review W2).
      adoptOrphanedAttempt(event.sender);
      if (attemptOwner && attemptOwner !== event.sender) return ALREADY_RUNNING;
      const sender = event.sender;
      if (!observedSenders.has(sender)) {
        observedSenders.add(sender);
        // A window that goes away abandons only the attempt it owns, never
        // one another window started after it. Abandoning checks the account
        // like a cancel, and closes the attempt anyway when that check fails,
        // as on a signed-out host. The attempt stays reserved until that finishes, so no other window
        // adopts it, and is released once the manager holds no attempt.
        sender.once('destroyed', () => {
          if (attemptOwner !== sender) return;
          cancelling.add(sender);
          void codexLoginManager
            .abandon()
            .then((settled) => {
              if (
                attemptOwner === sender &&
                (settled.phase === 'complete' || settled.attemptId === null)
              )
                attemptOwner = null;
            })
            .catch(() => undefined)
            .finally(() => {
              cancelling.delete(sender);
            });
        });
      }
      // Owned before it starts, so the states it publishes while starting
      // reach this window only.
      const previous = attemptOwner;
      attemptOwner = sender;
      let state: CodexLoginState;
      try {
        state = codexLoginManager.start(request);
      } catch (error) {
        attemptOwner = previous;
        throw error;
      }
      if (!state.attemptId) attemptOwner = previous;
      return state;
    },
  );
  registerIpcHandler<[], CodexLoginState>(
    IPC_CHANNELS.codexLoginCancel,
    async (event) => {
      requireAttemptOwner(event.sender);
      // A bridge's cancel abandons the attempt: the account is checked like
      // any cancel, so paused work keeps its grant, and the attempt closes
      // even when the check fails (a signed-out host), since the
      // controller's dialog is done with it. This computer's window keeps
      // the failed check, to retry or cancel it there.
      return isAppWindow(event.sender)
        ? codexLoginManager.finish('cancelled')
        : codexLoginManager.abandon();
    },
  );
  registerIpcHandler<[], CodexLoginState>(
    IPC_CHANNELS.codexLoginRetryVerification,
    async (event) => {
      requireAttemptOwner(event.sender);
      return codexLoginManager.retryVerification();
    },
  );
  registerIpcHandler<[], void>(
    IPC_CHANNELS.codexLoginOpenBrowser,
    async (event) => {
      requireAttemptOwner(event.sender);
      // Only this computer's own window opens this computer's browser.
      if (!isAppWindow(event.sender))
        throw new Error('Open the sign-in page on the computer you are using.');
      const url = codexLoginManager.browserUrl();
      // Fixture sign-ins must never open an OS browser or read a live account.
      if (__CANOPY_E2E__) return;
      await openExternalGuarded(url);
    },
  );
}
