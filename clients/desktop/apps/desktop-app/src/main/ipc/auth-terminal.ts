import {
  recordProviderConnectionFailure,
  classifyConnectionFailure,
  withProviderConnectionAttempt,
} from '../lib/provider-connection-events';
import type { BrowserWindow, WebContents } from 'electron';
import {
  IPC_CHANNELS,
  type AuthTerminalResizeRequest,
  type AuthTerminalStartRequest,
  type AuthTerminalStartResponse,
  type AuthTerminalStopRequest,
  type AuthTerminalWriteRequest,
  type AuthTerminalProvider,
} from '@canopy/desktop-shared/types';
import { sendToWindow, type SendableBrowserWindow } from '../lib/window-send';
import {
  getActiveSignInTerminalSessionId,
  resizeSignInTerminal,
  setSignInTerminalEventSender,
  startSignInTerminal,
  stopSignInTerminal,
  writeSignInTerminal,
} from '../sign-in-runs/sign-in-runs';
import { registerIpcHandler } from './register';
import { resolveRemoteBridgeSender } from '../remote-control/host/bridge-window';
import {
  OPENCODE_SETUP_RUNNING_MESSAGE,
  SIGN_IN_ALREADY_RUNNING_MESSAGE,
  openCodeSetupHeldByAnother,
  setOpenCodeSignInOwnerCheck,
} from './sign-in-owner-guard';
import type { ManagedOpenCodeRuntime } from '../opencode/connection';
import {
  checkClaudeAuthStatusObserved,
  checkCodexAuthStatusObserved,
} from '../auth/provider-auth-state';

async function refreshProviderAfterAuthTerminalExit(
  provider: AuthTerminalProvider,
  exitCode: number | null,
  signal: string | null,
): Promise<void> {
  const cancelled = exitCode === null || (signal !== null && signal !== '0');
  const succeeded = exitCode === 0 && !cancelled;
  if (provider === 'antigravity') {
    const models = await import('../antigravity/models');
    models.invalidateAntigravityModels();
    return;
  }
  if (provider === 'opencode') {
    if (succeeded) {
      const connection = await import('../opencode/connection');
      await connection.revokeOpenCodeRuntimes();
      // Discovery must not delay the exit event after the auth cutover.
      void connection
        .refreshOpenCodeAccounts(undefined, 'in_app')
        .catch(() => undefined);
    } else
      recordProviderConnectionFailure(
        'opencode',
        'native_login',
        cancelled ? 'cancelled' : 'authentication',
      );
    return;
  }
  if (provider === 'claude') {
    if (!succeeded) {
      recordProviderConnectionFailure(
        'claude',
        'native_login',
        cancelled ? 'cancelled' : 'authentication',
      );
    }
    const status = await checkClaudeAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: succeeded,
    });
    if (succeeded && (!status.authenticated || status.probeFailed))
      recordProviderConnectionFailure(
        'claude',
        'native_login',
        status.probeFailed ? 'other' : 'authentication',
      );
    return;
  }
  if (provider === 'codex') {
    await checkCodexAuthStatusObserved('auth-terminal-exit', {
      forceAuthenticatedInvalidation: succeeded,
      prepareExplicitTransitionBeforeProbe: succeeded,
    });
  }
}

/**
 * The longest a sign-in another computer started may wait for its code. Its
 * controller may be gone without a stop ever arriving. A backstop one minute
 * after a sign-in's own 600-second deadline (Antigravity's, in both modes),
 * so a sign-in that times out by itself reports its timeout, not a stop.
 */
const REMOTE_SIGN_IN_DEADLINE_MS = 660_000;

/**
 * The most one write may carry. A pasted code or a typed key is far below
 * it; a larger write is refused before any sign-in reads it.
 */
const MAX_WRITE_LENGTH = 16_384;

export { SIGN_IN_ALREADY_RUNNING_MESSAGE };

export function registerAuthTerminalHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  const openCodeSessions = new Map<string, () => Promise<void>>();
  // Each remote sign-in's deadline and bridge hook, removed when it exits.
  const remoteSessions = new Map<string, () => void>();
  // The bridge window that started each remote sign-in. Only it hears the
  // sign-in's output and exit, and only it may type into, resize or stop
  // it; another controller that learns the session id cannot.
  const remoteOwners = new Map<string, WebContents>();
  const bindRemoteSignIn = (sender: WebContents, sessionId: string): void => {
    remoteSessions.get(sessionId)?.();
    remoteOwners.set(sessionId, sender);
    const stop = (): void => {
      release();
      stopSignInTerminal(sessionId);
    };
    const deadline = setTimeout(stop, REMOTE_SIGN_IN_DEADLINE_MS);
    const release = (): void => {
      clearTimeout(deadline);
      sender.removeListener('destroyed', stop);
      remoteSessions.delete(sessionId);
    };
    remoteSessions.set(sessionId, release);
    sender.once('destroyed', stop);
  };
  /**
   * A bridge that went away while its sign-in was starting never fires
   * `destroyed` again, so the started sign-in is stopped here instead.
   */
  const stopIfBridgeGone = (sender: WebContents, sessionId: string): void => {
    if (!sender.isDestroyed()) return;
    remoteSessions.get(sessionId)?.();
    stopSignInTerminal(sessionId);
  };
  // Starts that passed their ownership check and whose sign-in doesn't
  // exist yet (OpenCode verifies first), with the window that made each.
  const starting = new Map<
    symbol,
    { sender: WebContents; provider: unknown }
  >();
  /**
   * Whether a bridge would end someone else's sign-in by starting one: the
   * computer runs one sign-in at a time, and a start replaces the running
   * one. This computer's window may still replace any, and a bridge its
   * own; a sign-in with no bridge owner is this computer's, so someone
   * else's. Another window's start still on its way counts as running,
   * unless that window has gone away.
   */
  const wouldPreemptAnotherOwner = (sender: WebContents): boolean => {
    const active = getActiveSignInTerminalSessionId();
    if (active !== null && remoteOwners.get(active) !== sender) return true;
    return Array.from(starting.values()).some(
      (other) => other.sender !== sender && !other.sender.isDestroyed(),
    );
  };
  /**
   * Refuses a bridge's start that would replace someone else's sign-in, and
   * a bridge's second start while its first is still on its way: each
   * OpenCode start verifies the executable, so one controller can't pile
   * those up.
   */
  const assertMayStart = (sender: WebContents, token: symbol): void => {
    if (resolveRemoteBridgeSender(sender) === null) return;
    if (sender.isDestroyed())
      throw new Error('The other computer is no longer connected.');
    const ownPending = Array.from(starting.entries()).some(
      ([other, start]) => other !== token && start.sender === sender,
    );
    if (ownPending || wouldPreemptAnotherOwner(sender))
      throw new Error(SIGN_IN_ALREADY_RUNNING_MESSAGE);
  };
  // OpenCode setup revokes every OpenCode runtime, the one under a sign-in
  // included, so it asks first whose sign-in that would end.
  setOpenCodeSignInOwnerCheck((sender) => {
    const active = getActiveSignInTerminalSessionId();
    if (
      active !== null &&
      openCodeSessions.has(active) &&
      remoteOwners.get(active) !== sender
    )
      return true;
    return Array.from(starting.values()).some(
      (other) =>
        other.provider === 'opencode' &&
        other.sender !== sender &&
        !other.sender.isDestroyed(),
    );
  });
  const assertSessionWriter = (
    sender: WebContents,
    sessionId: string,
  ): void => {
    const owner = remoteOwners.get(sessionId);
    if (owner ? owner !== sender : resolveRemoteBridgeSender(sender) !== null)
      throw new Error('This sign-in belongs to another window.');
  };
  /**
   * Where a sign-in's events go: a remote sign-in's to its bridge window,
   * which forwards them to its controller only; a local one's to this
   * computer's window. Main's copy for that window is never mirrored to
   * controllers (`remote-control/host/main-window-pushes.ts`). An exit is
   * the session's last event, so its owner is forgotten once it is aimed.
   */
  const windowFor = (
    channel: string,
    sessionId: string,
  ): SendableBrowserWindow | null => {
    const owner = remoteOwners.get(sessionId);
    if (channel === IPC_CHANNELS.authTerminalExit)
      remoteOwners.delete(sessionId);
    return owner
      ? { isDestroyed: () => owner.isDestroyed(), webContents: owner }
      : getWindow();
  };
  setSignInTerminalEventSender((channel, payload): void => {
    const target = windowFor(channel, payload.sessionId);
    if (channel === IPC_CHANNELS.authTerminalExit)
      remoteSessions.get(payload.sessionId)?.();
    if (channel === IPC_CHANNELS.authTerminalExit && 'provider' in payload) {
      if (payload.provider === 'opencode') {
        const release = openCodeSessions.get(payload.sessionId);
        // Release this lease before successful-auth revocation, which waits
        // for all registered runtimes (including this login) to finish.
        void (async (): Promise<void> => {
          await release?.();
          await refreshProviderAfterAuthTerminalExit(
            payload.provider,
            payload.exitCode,
            payload.signal,
          );
        })()
          .catch(() => undefined)
          .finally(() => sendToWindow(target, channel, payload));
        return;
      }
      if (
        payload.exitCode !== 0 ||
        (payload.signal !== null && payload.signal !== '0') ||
        (payload.provider !== 'codex' && payload.provider !== 'antigravity')
      ) {
        sendToWindow(target, channel, payload);
        void refreshProviderAfterAuthTerminalExit(
          payload.provider,
          payload.exitCode,
          payload.signal,
        ).catch(() => undefined);
        return;
      }
      // Hold the renderer exit event until provider state has crossed the auth
      // boundary. AuthLoginModal immediately refreshes Usage and may open the
      // interrupted-session prompt when this event arrives.
      void refreshProviderAfterAuthTerminalExit(
        payload.provider,
        payload.exitCode,
        payload.signal,
      )
        .catch(() => undefined)
        .finally(() => sendToWindow(target, channel, payload));
      return;
    }
    sendToWindow(target, channel, payload);
  });

  registerIpcHandler<[AuthTerminalStartRequest], AuthTerminalStartResponse>(
    IPC_CHANNELS.authTerminalStart,
    async (event, request): Promise<AuthTerminalStartResponse> => {
      const provider: unknown = request.provider;
      // A remote bridge window carries another computer's calls. Its sign-in
      // is bound to it as soon as the session exists, before any event.
      const remote = resolveRemoteBridgeSender(event.sender) !== null;
      // Set from a callback, so held in an object the catch below reads.
      const bound: { sessionId?: string } = {};
      const startToken = Symbol('auth-terminal start');
      const remoteStart = remote
        ? {
            remote,
            onSessionId: (sessionId: string): void => {
              bound.sessionId = sessionId;
              bindRemoteSignIn(event.sender, sessionId);
            },
          }
        : {};
      try {
        if (provider === 'codex')
          throw new Error('Use the managed Codex sign-in flow.');
        if (
          provider !== 'claude' &&
          provider !== 'github' &&
          provider !== 'opencode' &&
          provider !== 'antigravity'
        ) {
          throw new Error(
            `Invalid auth-terminal provider: ${String(provider)}`,
          );
        }
        // Checked here, and again after OpenCode's verification wait, with
        // this start held against other bridges until its sign-in exists.
        // A controller's OpenCode setup is about to revoke every OpenCode
        // runtime; a sign-in started now would be ended by it.
        if (provider === 'opencode' && openCodeSetupHeldByAnother(event.sender))
          throw new Error(OPENCODE_SETUP_RUNNING_MESSAGE);
        assertMayStart(event.sender, startToken);
        starting.set(startToken, { sender: event.sender, provider });
        if (provider === 'opencode') {
          const controller = new AbortController();
          const timeout = setTimeout(
            () =>
              controller.abort(
                new DOMException(
                  'OpenCode verification timed out.',
                  'TimeoutError',
                ),
              ),
            60_000,
          );
          // A bridge that goes away stops its verification too.
          const abandon = (): void =>
            controller.abort(
              new DOMException(
                'The other computer is no longer connected.',
                'AbortError',
              ),
            );
          if (remote) event.sender.once('destroyed', abandon);
          const runtime = await withProviderConnectionAttempt(
            'opencode',
            'native_login',
            controller.signal,
            async (): Promise<ManagedOpenCodeRuntime> => {
              try {
                return await (
                  await import('../opencode/connection')
                ).openManagedOpenCodeRuntime({
                  signal: controller.signal,
                  requireEnabled: false,
                });
              } finally {
                // Verification is bounded; interactive sign-in has no deadline.
                clearTimeout(timeout);
                event.sender.removeListener('destroyed', abandon);
              }
            },
          );
          try {
            assertMayStart(event.sender, startToken);
          } catch (error) {
            await runtime.close();
            throw error;
          }
          try {
            runtime.signal.throwIfAborted();
            const { sessionId } = await startSignInTerminal({
              provider,
              cols: request.cols,
              rows: request.rows,
              verifiedOpenCodeExecutable: runtime.executable,
              ...remoteStart,
            });
            const stop = (): void => stopSignInTerminal(sessionId);
            const release = (): Promise<void> => {
              openCodeSessions.delete(sessionId);
              runtime.signal.removeEventListener('abort', stop);
              return runtime.close();
            };
            openCodeSessions.set(sessionId, release);
            if (remote) stopIfBridgeGone(event.sender, sessionId);
            runtime.signal.addEventListener('abort', stop, { once: true });
            if (getActiveSignInTerminalSessionId() !== sessionId)
              await release();
            else if (runtime.signal.aborted) stop();
            return { sessionId };
          } catch (error) {
            recordProviderConnectionFailure(
              'opencode',
              'native_login',
              classifyConnectionFailure(error, runtime.signal),
            );
            await runtime.close();
            throw error;
          }
        }
        // Nothing has waited since the check above, so it still holds.
        const startNow = (): Promise<string> =>
          startSignInTerminal({
            provider,
            cols: request.cols,
            rows: request.rows,
            ...remoteStart,
          }).then((started) => started.sessionId);
        const sessionId =
          provider === 'claude'
            ? await withProviderConnectionAttempt(
                'claude',
                'native_login',
                undefined,
                startNow,
              )
            : await startNow();
        // The sign-in waits on the other computer, which may go away without
        // a stop arriving (its bridge closes when the session drops); one that
        // went away while this started is stopped now. A session that already
        // exited is a no-op to stop.
        if (remote) stopIfBridgeGone(event.sender, sessionId);
        return { sessionId };
      } catch (error) {
        // A sign-in that failed to start emits no exit, so nothing else
        // would forget its owner or its deadline.
        if (bound.sessionId !== undefined) {
          remoteSessions.get(bound.sessionId)?.();
          remoteOwners.delete(bound.sessionId);
        }
        throw error;
      } finally {
        // Started or not, the running sign-in (if any) now speaks for it.
        starting.delete(startToken);
      }
    },
  );

  registerIpcHandler<[AuthTerminalWriteRequest], void>(
    IPC_CHANNELS.authTerminalWrite,
    (event, request): void => {
      if (typeof request.data !== 'string')
        throw new Error('Invalid sign-in input.');
      if (request.data.length > MAX_WRITE_LENGTH)
        throw new Error('Sign-in input is too long.');
      assertSessionWriter(event.sender, request.sessionId);
      writeSignInTerminal(request.sessionId, request.data);
    },
  );

  registerIpcHandler<[AuthTerminalResizeRequest], void>(
    IPC_CHANNELS.authTerminalResize,
    (event, request): void => {
      assertSessionWriter(event.sender, request.sessionId);
      resizeSignInTerminal(request.sessionId, request.cols, request.rows);
    },
  );

  registerIpcHandler<[AuthTerminalStopRequest], void>(
    IPC_CHANNELS.authTerminalStop,
    (event, request): void => {
      assertSessionWriter(event.sender, request.sessionId);
      stopSignInTerminal(request.sessionId);
    },
  );
}
