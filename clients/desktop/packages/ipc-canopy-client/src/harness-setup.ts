import type { HarnessSetupClient, Unsubscribe } from '@canopy/app-core';
import {
  REMOTE_IPC_CHANNELS as C,
  type RemoteIpcChannel,
} from '@canopy/protocol/remote-control/channels';
import {
  BROWSER_SIGN_IN_COLUMNS,
  BROWSER_SIGN_IN_ROWS,
  HARNESS_CURSOR_SIGN_IN_CLIENT,
  isHarnessSignInCodeLine,
  readHarnessAntigravityRuntimeStatus,
  readHarnessCodexLoginState,
  readHarnessCopilotAccount,
  readHarnessCopilotStatus,
  readHarnessCursorAccount,
  readHarnessCursorStatus,
  readHarnessOpenCodeStatus,
  readHarnessProviderAuthStatus,
  readHarnessSignInExit,
  readHarnessSignInOutput,
  readHarnessSignInSession,
} from '@canopy/protocol/remote-control/harness-setup';
import type { ChannelClient } from './channel-client';
import { anyReply } from './decoders';

/** Thrown when the computer answers with something that is not the shape. */
class HarnessSetupReplyError extends Error {
  constructor(channel: string) {
    super(`The computer sent an unexpected reply on ${channel}.`);
    this.name = 'HarnessSetupReplyError';
  }
}

/**
 * Thrown before the transport for a value the computer's browser policy
 * would refuse (CAN-6718 review W1). Its message is the fix, so a host's
 * failure port may show it as the sentence (`inputRefused`). Nothing was
 * sent.
 */
class HarnessSetupInputError extends Error {
  readonly inputRefused = true;
  constructor(message: string) {
    super(message);
    this.name = 'HarnessSetupInputError';
  }
}

const SIGN_IN_LINE_REFUSED = 'Paste the code on one line.';

/**
 * The `harnessSetup` member over the channels in its manifest entry
 * (`REMOTE_MEMBER_CHANNELS.harnessSetup`). Every reply is read with the
 * protocol's reader, so a field the shared rows don't know never reaches
 * them; a reply that is not the shape rejects. Pushes that are not the shape
 * are dropped.
 */
export function createChannelHarnessSetupClient(
  transportChannels: ChannelClient,
  /**
   * Runs one invoke, reporting an older computer's refusal of the channel
   * as the update-the-desktop message.
   */
  onOutdatedHost: <T>(
    channel: RemoteIpcChannel,
    invoke: () => Promise<T>,
  ) => Promise<T>,
): HarnessSetupClient {
  const channels: Pick<ChannelClient, 'invoke' | 'invokeVoid' | 'listen'> = {
    invoke: (channel, decode, ...args) =>
      onOutdatedHost(channel, () =>
        transportChannels.invoke(channel, decode, ...args),
      ),
    invokeVoid: (channel, ...args) =>
      onOutdatedHost(channel, () =>
        transportChannels.invokeVoid(channel, ...args),
      ),
    listen: (channel, accept, listener) =>
      transportChannels.listen(channel, accept, listener),
  };
  const read = async <T>(
    channel: RemoteIpcChannel,
    reader: (value: unknown) => T | null,
    ...args: unknown[]
  ): Promise<T> => {
    const value = reader(
      await channels.invoke(channel, anyReply<unknown>(), ...args),
    );
    if (value === null) throw new HarnessSetupReplyError(channel);
    return value;
  };
  const listen = <T>(
    channel: RemoteIpcChannel,
    reader: (value: unknown) => T | null,
    listener: (value: T) => void,
  ): Unsubscribe =>
    channels.listen(channel, anyReply<unknown>(), (payload) => {
      const value = reader(payload);
      if (value !== null) listener(value);
    });
  // `account` answers `null` when signed out, so "not the shape" can't be
  // told apart from it by the reader alone.
  const readAccount = async <T>(
    channel: RemoteIpcChannel,
    reader: (value: unknown) => T | null,
  ): Promise<T | null> => {
    const value = await channels.invoke(channel, anyReply<unknown>());
    if (value === null) return null;
    const account = reader(value);
    if (account === null) throw new HarnessSetupReplyError(channel);
    return account;
  };
  return {
    antigravity: {
      status: () =>
        read(C.antigravityRuntimeStatus, readHarnessAntigravityRuntimeStatus),
      install: (operationId) =>
        read(
          C.antigravityRuntimeInstall,
          readHarnessAntigravityRuntimeStatus,
          operationId,
        ),
      cancel: (operationId) =>
        channels.invokeVoid(C.antigravityRuntimeCancel, operationId),
      onProgress: (listener) =>
        listen(
          C.antigravityRuntimeProgress,
          readHarnessAntigravityRuntimeStatus,
          listener,
        ),
    },
    cursor: {
      status: () => read(C.cursorConnectionStatus, readHarnessCursorStatus),
      // The browser shows the sign-in link itself (`signInUrl`).
      connect: () =>
        read(
          C.cursorConnectionConnect,
          readHarnessCursorStatus,
          HARNESS_CURSOR_SIGN_IN_CLIENT,
        ),
      cancel: () => channels.invokeVoid(C.cursorConnectionCancel),
      disconnect: () => channels.invokeVoid(C.cursorConnectionDisconnect),
      account: () =>
        readAccount(C.cursorConnectionAccount, readHarnessCursorAccount),
      changeAccount: (intent) =>
        read(
          C.cursorConnectionChangeAccount,
          readHarnessCursorStatus,
          intent,
          HARNESS_CURSOR_SIGN_IN_CLIENT,
        ),
      onProgress: (listener) =>
        listen(C.cursorConnectionProgress, readHarnessCursorStatus, listener),
    },
    copilot: {
      status: () => read(C.copilotConnectionStatus, readHarnessCopilotStatus),
      connect: () => read(C.copilotConnectionConnect, readHarnessCopilotStatus),
      cancel: () => channels.invokeVoid(C.copilotConnectionCancel),
      disconnect: () => channels.invokeVoid(C.copilotConnectionDisconnect),
      account: () =>
        readAccount(C.copilotConnectionAccount, readHarnessCopilotAccount),
      changeAccount: () =>
        read(C.copilotConnectionChangeAccount, readHarnessCopilotStatus),
      onProgress: (listener) =>
        listen(C.copilotConnectionProgress, readHarnessCopilotStatus, listener),
    },
    opencode: {
      status: () => read(C.opencodeConnectionStatus, readHarnessOpenCodeStatus),
      connect: () =>
        read(C.opencodeConnectionConnect, readHarnessOpenCodeStatus),
      cancel: () => channels.invokeVoid(C.opencodeConnectionCancel),
      disconnect: () => channels.invokeVoid(C.opencodeConnectionDisconnect),
      onProgress: (listener) =>
        listen(
          C.opencodeConnectionProgress,
          readHarnessOpenCodeStatus,
          listener,
        ),
    },
    providerAuth: {
      status: (provider, options) =>
        read(
          provider === 'claude'
            ? C.settingsClaudeAuthStatus
            : C.settingsCodexAuthStatus,
          readHarnessProviderAuthStatus,
          ...(options?.forceRefresh === true ? [{ forceRefresh: true }] : []),
        ),
    },
    codexLogin: {
      startDeviceCode: ({ confirmPause }) =>
        read(C.codexLoginStart, readHarnessCodexLoginState, {
          confirmPause,
          method: 'chatgptDeviceCode',
        }),
      cancel: () => read(C.codexLoginCancel, readHarnessCodexLoginState),
      retryVerification: () =>
        read(C.codexLoginRetryVerification, readHarnessCodexLoginState),
      onState: (listener) =>
        listen(C.codexLoginState, readHarnessCodexLoginState, listener),
    },
    signIn: {
      start: (provider) =>
        read(C.authTerminalStart, readHarnessSignInSession, {
          provider,
          cols: BROWSER_SIGN_IN_COLUMNS,
          rows: BROWSER_SIGN_IN_ROWS,
        }),
      submitLine: async (sessionId, line) => {
        if (!isHarnessSignInCodeLine(line))
          throw new HarnessSetupInputError(SIGN_IN_LINE_REFUSED);
        await channels.invokeVoid(C.authTerminalWrite, {
          sessionId,
          data: `${line}\r`,
        });
      },
      stop: (sessionId) =>
        channels.invokeVoid(C.authTerminalStop, { sessionId }),
      onOutput: (listener) =>
        listen(C.authTerminalOutput, readHarnessSignInOutput, listener),
      onExit: (listener) =>
        listen(C.authTerminalExit, readHarnessSignInExit, listener),
    },
  };
}
