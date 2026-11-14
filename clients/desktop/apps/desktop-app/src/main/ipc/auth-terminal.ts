import {
  recordProviderConnectionFailure,
  classifyConnectionFailure,
  withProviderConnectionAttempt,
} from '../lib/provider-connection-events';
import type { BrowserWindow } from 'electron';
import {
  IPC_CHANNELS,
  type AuthTerminalResizeRequest,
  type AuthTerminalStartRequest,
  type AuthTerminalStartResponse,
  type AuthTerminalStopRequest,
  type AuthTerminalWriteRequest,
  type AuthTerminalProvider,
} from '@canopy/desktop-shared/types';
import { sendToWindow } from '../lib/window-send';
import {
  getActiveSignInTerminalSessionId,
  resizeSignInTerminal,
  setSignInTerminalEventSender,
  startSignInTerminal,
  stopSignInTerminal,
  writeSignInTerminal,
} from '../sign-in-runs/sign-in-runs';
import { registerIpcHandler } from './register';
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

export function registerAuthTerminalHandlers(
  getWindow: () => BrowserWindow | null,
): void {
  const openCodeSessions = new Map<string, () => Promise<void>>();
  setSignInTerminalEventSender((channel, payload): void => {
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
          .finally(() => sendToWindow(getWindow(), channel, payload));
        return;
      }
      if (
        payload.exitCode !== 0 ||
        (payload.signal !== null && payload.signal !== '0') ||
        (payload.provider !== 'codex' && payload.provider !== 'antigravity')
      ) {
        sendToWindow(getWindow(), channel, payload);
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
        .finally(() => sendToWindow(getWindow(), channel, payload));
      return;
    }
    sendToWindow(getWindow(), channel, payload);
  });

  registerIpcHandler<[AuthTerminalStartRequest], AuthTerminalStartResponse>(
    IPC_CHANNELS.authTerminalStart,
    async (_event, request): Promise<AuthTerminalStartResponse> => {
      const provider: unknown = request.provider;
      if (provider === 'codex')
        throw new Error('Use the managed Codex sign-in flow.');
      if (
        provider !== 'claude' &&
        provider !== 'github' &&
        provider !== 'opencode' &&
        provider !== 'antigravity'
      ) {
        throw new Error(`Invalid auth-terminal provider: ${String(provider)}`);
      }
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
            }
          },
        );
        try {
          runtime.signal.throwIfAborted();
          const { sessionId } = await startSignInTerminal({
            provider,
            cols: request.cols,
            rows: request.rows,
            verifiedOpenCodeExecutable: runtime.executable,
          });
          const stop = (): void => stopSignInTerminal(sessionId);
          const release = (): Promise<void> => {
            openCodeSessions.delete(sessionId);
            runtime.signal.removeEventListener('abort', stop);
            return runtime.close();
          };
          openCodeSessions.set(sessionId, release);
          runtime.signal.addEventListener('abort', stop, { once: true });
          if (getActiveSignInTerminalSessionId() !== sessionId) await release();
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
      const sessionId =
        provider === 'claude'
          ? await withProviderConnectionAttempt(
              'claude',
              'native_login',
              undefined,
              () =>
                startSignInTerminal({
                  provider,
                  cols: request.cols,
                  rows: request.rows,
                }).then((started) => started.sessionId),
            )
          : (
              await startSignInTerminal({
                provider,
                cols: request.cols,
                rows: request.rows,
              })
            ).sessionId;
      return { sessionId };
    },
  );

  registerIpcHandler<[AuthTerminalWriteRequest], void>(
    IPC_CHANNELS.authTerminalWrite,
    (_event, request): void => {
      writeSignInTerminal(request.sessionId, request.data);
    },
  );

  registerIpcHandler<[AuthTerminalResizeRequest], void>(
    IPC_CHANNELS.authTerminalResize,
    (_event, request): void => {
      resizeSignInTerminal(request.sessionId, request.cols, request.rows);
    },
  );

  registerIpcHandler<[AuthTerminalStopRequest], void>(
    IPC_CHANNELS.authTerminalStop,
    (_event, request): void => {
      stopSignInTerminal(request.sessionId);
    },
  );
}
