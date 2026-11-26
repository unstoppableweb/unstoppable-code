import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { ProviderConnectionEvent } from '../lib/provider-connection-events';
import type { AuthTerminalEventSender } from '../ipc/auth-terminal-events';
import type { refreshOpenCodeAccounts } from '../opencode/connection';
import { isMirrored } from '../remote-control/host/main-window-pushes';

const mockSetEventSender = jest.fn<void, [AuthTerminalEventSender]>();
const mockStart = jest.fn();
// Creating the sign-in, after its session is named; throws to fail a start.
const mockCreate = jest.fn();
const mockWrite = jest.fn();
const mockResize = jest.fn();
const mockStop = jest.fn();
const mockSendToWindow = jest.fn();
const mockRegisterIpcHandler = jest.fn<
  void,
  [string, (event: unknown, request: unknown) => unknown]
>();
const mockCheckClaudeAuthStatusObserved = jest.fn();
const mockCheckCodexAuthStatusObserved = jest.fn();
let mockRuntimeAbort = new AbortController();
const mockRuntimeClose = jest.fn(() => Promise.resolve());
const mockOpenManaged = jest.fn();
const mockRevokeOpenCode = jest.fn(() => Promise.resolve());
const mockRefreshOpenCodeAccounts = jest.fn<
  ReturnType<typeof refreshOpenCodeAccounts>,
  Parameters<typeof refreshOpenCodeAccounts>
>();
const mockGetActiveSessionId = jest.fn();

jest.mock('../opencode/connection', () => ({
  get openManagedOpenCodeRuntime(): typeof mockOpenManaged {
    return mockOpenManaged;
  },
  get revokeOpenCodeRuntimes(): typeof mockRevokeOpenCode {
    return mockRevokeOpenCode;
  },
  refreshOpenCodeAccounts: mockRefreshOpenCodeAccounts,
}));

jest.mock('../sign-in-runs/sign-in-runs', () => ({
  SignInWorkerUnavailableError: class SignInWorkerUnavailableError extends Error {
    constructor() {
      super('Sign-in could not start on the local worker.');
      this.name = 'SignInWorkerUnavailableError';
    }
  },
  setSignInTerminalEventSender: (sender: AuthTerminalEventSender): void =>
    mockSetEventSender(sender),
  startSignInTerminal: (request: {
    provider: string;
    cols: number;
    rows: number;
    verifiedOpenCodeExecutable?: string;
    remote?: boolean;
    onSessionId?: (sessionId: string) => void;
  }): Promise<{ sessionId: string }> =>
    Promise.resolve().then(() => {
      const sessionId: unknown = mockStart(
        request.provider,
        request.cols,
        request.rows,
        request.verifiedOpenCodeExecutable,
        // Only remote starts carry the flag, so local calls keep their shape.
        ...(request.remote === undefined ? [] : [request.remote]),
      );
      // The real start names the session before it creates the sign-in.
      request.onSessionId?.(String(sessionId));
      mockCreate(String(sessionId));
      return { sessionId: String(sessionId) };
    }),
  writeSignInTerminal: (...args: unknown[]): unknown => mockWrite(...args),
  resizeSignInTerminal: (...args: unknown[]): unknown => mockResize(...args),
  stopSignInTerminal: (...args: unknown[]): unknown => mockStop(...args),
  getActiveSignInTerminalSessionId: (): unknown => mockGetActiveSessionId(),
}));

// A window's web contents: destroyed once it emits `destroyed`.
function fakeSender(id: number): EventEmitter & {
  id: number;
  isDestroyed(): boolean;
  send(): void;
} {
  let destroyed = false;
  const sender = Object.assign(new EventEmitter(), {
    id,
    isDestroyed: (): boolean => destroyed,
    send: (): void => undefined,
  });
  sender.once('destroyed', () => {
    destroyed = true;
  });
  return sender;
}

// The remote bridge window's web contents carry another computer's calls.
const BRIDGE_SENDER = fakeSender(99);
const APP_SENDER = fakeSender(1);
jest.mock('../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (sender: { id: number }): string | null =>
    sender.id === 99 ? 'controller-device' : null,
}));

jest.mock('../lib/window-send', () => ({
  get sendToWindow(): typeof mockSendToWindow {
    return mockSendToWindow;
  },
}));

jest.mock('../ipc/register', () => ({
  get registerIpcHandler(): typeof mockRegisterIpcHandler {
    return mockRegisterIpcHandler;
  },
}));

jest.mock('../auth/provider-auth-state', () => ({
  get checkClaudeAuthStatusObserved(): typeof mockCheckClaudeAuthStatusObserved {
    return mockCheckClaudeAuthStatusObserved;
  },
  get checkCodexAuthStatusObserved(): typeof mockCheckCodexAuthStatusObserved {
    return mockCheckCodexAuthStatusObserved;
  },
}));

jest.mock('../ipc/app-error-policy', () => ({
  ipcShowsRawErrorDetail: (): boolean => false,
}));

import { registerAuthTerminalHandlers } from '../ipc/auth-terminal';
import { toIpcRejection } from '../ipc/app-error-rejection';

function registerAndGetSender(): AuthTerminalEventSender {
  registerAuthTerminalHandlers(() => null);
  const sender = mockSetEventSender.mock.calls[0]?.[0];
  if (!sender) {
    throw new Error('Expected auth terminal event sender to be registered');
  }
  return sender;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: Error) => void) | undefined;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return {
    promise,
    resolve(value: T): void {
      if (!resolve) {
        throw new Error('Deferred resolver was not initialized');
      }
      resolve(value);
    },
    reject(reason: Error): void {
      if (!reject) {
        throw new Error('Deferred rejecter was not initialized');
      }
      reject(reason);
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRuntimeAbort = new AbortController();
  mockRuntimeClose.mockReset().mockResolvedValue(undefined);
  mockRevokeOpenCode.mockReset().mockResolvedValue(undefined);
  mockRefreshOpenCodeAccounts.mockReset().mockResolvedValue(undefined);
  mockStart.mockReset().mockReturnValue('opencode-login');
  mockGetActiveSessionId.mockReturnValue('opencode-login');
  mockOpenManaged.mockReset().mockResolvedValue({
    executable: '/verified/opencode',
    signal: mockRuntimeAbort.signal,
    close: mockRuntimeClose,
  });
  mockCheckClaudeAuthStatusObserved.mockResolvedValue({
    authenticated: true,
    accountLabel: 'claude@example.com',
    detail: null,
    error: null,
  });
  mockCheckCodexAuthStatusObserved.mockResolvedValue({
    authenticated: true,
    accountLabel: 'codex@example.com',
    detail: null,
    error: null,
  });
});

async function startOpenCodeLogin(): Promise<void> {
  const handler = mockRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.authTerminalStart,
  )?.[1];
  if (!handler) throw new Error('Missing start handler');
  await handler(
    { sender: APP_SENDER },
    { provider: 'opencode', cols: 80, rows: 24 },
  );
}

it('keeps the login runtime revocable until the terminal exits', async () => {
  const sender = registerAndGetSender();
  await startOpenCodeLogin();
  expect(mockRuntimeClose).not.toHaveBeenCalled();
  mockRuntimeAbort.abort();
  expect(mockStop).toHaveBeenCalledWith('opencode-login');
  expect(mockRuntimeClose).not.toHaveBeenCalled();
  sender(IPC_CHANNELS.authTerminalExit, {
    sessionId: 'opencode-login',
    provider: 'opencode',
    exitCode: 1,
    signal: null,
  });
  await flushPromises();
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
});

it('cleans up a login which exits synchronously during terminal creation', async () => {
  registerAndGetSender();
  mockGetActiveSessionId.mockReturnValueOnce(null);
  await startOpenCodeLogin();
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
  mockRuntimeAbort.abort();
  expect(mockStop).not.toHaveBeenCalled();
});

it('does not impose the verification deadline on an interactive login', async () => {
  jest.useFakeTimers();
  try {
    const sender = registerAndGetSender();
    let verificationSignal: AbortSignal | undefined;
    mockOpenManaged.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) => {
        verificationSignal = signal;
        return Promise.resolve({
          executable: '/verified/opencode',
          signal,
          close: mockRuntimeClose,
        });
      },
    );
    await startOpenCodeLogin();
    jest.advanceTimersByTime(61_000);
    expect(verificationSignal?.aborted).toBe(false);
    expect(mockStop).not.toHaveBeenCalled();
    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'opencode-login',
      provider: 'opencode',
      exitCode: 1,
      signal: null,
    });
    await flushPromises();
  } finally {
    jest.useRealTimers();
  }
});

it('refuses a login revoked before the PTY starts', async () => {
  registerAndGetSender();
  mockRuntimeAbort.abort();
  await expect(startOpenCodeLogin()).rejects.toThrow();
  expect(mockStart).not.toHaveBeenCalled();
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
});

it.each(['resolve', 'reject'] as const)(
  'waits for login release and revocation, but not account discovery, before notifying (%s)',
  async (outcome) => {
    const sender = registerAndGetSender();
    const closed = deferred<void>();
    const revoked = deferred<void>();
    const refresh = deferred<void>();
    await startOpenCodeLogin();
    mockRuntimeClose.mockReturnValue(closed.promise);
    mockRevokeOpenCode.mockReturnValueOnce(revoked.promise);
    mockRefreshOpenCodeAccounts.mockReturnValueOnce(refresh.promise);
    const payload = {
      sessionId: 'opencode-login',
      provider: 'opencode' as const,
      exitCode: 0,
      signal: null,
    };
    sender(IPC_CHANNELS.authTerminalExit, payload);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
    expect(mockRevokeOpenCode).not.toHaveBeenCalled();
    expect(mockRefreshOpenCodeAccounts).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalled();
    closed.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRevokeOpenCode).toHaveBeenCalledTimes(1);
    expect(mockRefreshOpenCodeAccounts).not.toHaveBeenCalled();
    expect(mockSendToWindow).not.toHaveBeenCalled();
    revoked.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockRefreshOpenCodeAccounts).toHaveBeenCalledTimes(1);
    expect(mockRefreshOpenCodeAccounts).toHaveBeenCalledWith(
      undefined,
      'in_app',
    );
    // Discovery is still pending: it must not hold the modal's exit event.
    try {
      expect(mockSendToWindow).toHaveBeenCalledTimes(1);
      expect(mockSendToWindow).toHaveBeenCalledWith(
        null,
        IPC_CHANNELS.authTerminalExit,
        payload,
      );
    } finally {
      if (outcome === 'reject') refresh.reject(new Error('discovery failed'));
      else refresh.resolve();
      // Let rejection handling run; an unhandled rejection must fail this test.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockSendToWindow).toHaveBeenCalledTimes(1);
  },
);

it('releases the login lease if terminal creation fails', async () => {
  const events = await import('../lib/provider-connection-events');
  const connection = jest.fn();
  const stop = events.subscribeProviderConnections(connection);
  registerAndGetSender();
  mockStart.mockImplementationOnce(() => {
    throw new Error('spawn failed');
  });
  await expect(startOpenCodeLogin()).rejects.toThrow('spawn failed');
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
  expect(connection).toHaveBeenCalledWith({
    provider: 'opencode',
    connectionMethod: 'native_login',
    connectSource: 'in_app',
    failureReason: 'other',
  });
  stop();
});

it('an unavailable worker fails start with the existing message shape', async () => {
  const events = await import('../lib/provider-connection-events');
  const { SignInWorkerUnavailableError } =
    await import('../sign-in-runs/sign-in-runs');
  const connection = jest.fn();
  const stop = events.subscribeProviderConnections(connection);
  registerAndGetSender();
  mockStart.mockImplementationOnce(() => {
    throw new SignInWorkerUnavailableError();
  });
  const handler = mockRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === IPC_CHANNELS.authTerminalStart,
  )?.[1];
  if (!handler) throw new Error('Missing start handler');
  await expect(
    handler({ sender: APP_SENDER }, { provider: 'claude', cols: 80, rows: 24 }),
  ).rejects.toThrow('Sign-in could not start on the local worker.');
  const claudeFailure: unknown = expect.objectContaining({
    provider: 'claude',
    connectionMethod: 'native_login',
  });
  expect(connection).toHaveBeenCalledWith(claudeFailure);
  stop();
});

it('OpenCode releases its runtime lease when start fails', async () => {
  const events = await import('../lib/provider-connection-events');
  const { SignInWorkerUnavailableError } =
    await import('../sign-in-runs/sign-in-runs');
  const connection = jest.fn();
  const stop = events.subscribeProviderConnections(connection);
  registerAndGetSender();
  mockStart.mockImplementationOnce(() => {
    throw new SignInWorkerUnavailableError();
  });
  await expect(startOpenCodeLogin()).rejects.toThrow(
    'Sign-in could not start on the local worker.',
  );
  expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
  const openCodeFailure: unknown = expect.objectContaining({
    provider: 'opencode',
    connectionMethod: 'native_login',
  });
  expect(connection).toHaveBeenCalledWith(openCodeFailure);
  stop();
});

describe('registerAuthTerminalHandlers event sender', () => {
  it('refreshes Claude auth status after forwarding a Claude exit event', () => {
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-1',
      provider: 'claude',
      exitCode: 0,
      signal: null,
    });

    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.authTerminalExit,
      expect.objectContaining({ provider: 'claude' }),
    );
    expect(mockCheckClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'auth-terminal-exit',
      { forceAuthenticatedInvalidation: true },
    );
    expect(mockCheckCodexAuthStatusObserved).not.toHaveBeenCalled();
  });

  it('forwards a successful Codex exit only after the explicit cutover settles', async () => {
    const refresh = deferred<unknown>();
    mockCheckCodexAuthStatusObserved.mockReturnValueOnce(refresh.promise);
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-2',
      provider: 'codex',
      exitCode: 0,
      signal: null,
    });

    expect(mockSendToWindow).not.toHaveBeenCalled();
    expect(mockCheckCodexAuthStatusObserved).toHaveBeenCalledWith(
      'auth-terminal-exit',
      {
        forceAuthenticatedInvalidation: true,
        prepareExplicitTransitionBeforeProbe: true,
      },
    );
    expect(mockCheckClaudeAuthStatusObserved).not.toHaveBeenCalled();

    refresh.resolve({ authenticated: true });
    await flushPromises();
    expect(mockSendToWindow).toHaveBeenCalled();
  });

  it('does not force invalidation after failed Claude or Codex exits', () => {
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-2a',
      provider: 'claude',
      exitCode: 1,
      signal: null,
    });
    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-2b',
      provider: 'codex',
      exitCode: 1,
      signal: null,
    });

    expect(mockCheckClaudeAuthStatusObserved).toHaveBeenCalledWith(
      'auth-terminal-exit',
      { forceAuthenticatedInvalidation: false },
    );
    expect(mockCheckCodexAuthStatusObserved).toHaveBeenCalledWith(
      'auth-terminal-exit',
      {
        forceAuthenticatedInvalidation: false,
        prepareExplicitTransitionBeforeProbe: false,
      },
    );
  });

  it('does not refresh provider auth status for GitHub exits', () => {
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-3',
      provider: 'github',
      exitCode: 0,
      signal: null,
    });

    expect(mockSendToWindow).toHaveBeenCalled();
    expect(mockCheckClaudeAuthStatusObserved).not.toHaveBeenCalled();
    expect(mockCheckCodexAuthStatusObserved).not.toHaveBeenCalled();
  });

  it('still forwards a successful Codex exit when the gated auth refresh rejects', async () => {
    mockCheckCodexAuthStatusObserved.mockRejectedValueOnce(
      new Error('refresh failed'),
    );
    const sender = registerAndGetSender();

    sender(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'session-4',
      provider: 'codex',
      exitCode: 0,
      signal: null,
    });

    expect(mockSendToWindow).not.toHaveBeenCalled();
    await flushPromises();
    expect(mockSendToWindow).toHaveBeenCalled();
  });
});

it('reports the verification deadline as timeout rather than cancellation', async () => {
  jest.useFakeTimers();
  const events = await import('../lib/provider-connection-events');
  events.resetProviderConnectionEventsForTests();
  const connection = jest.fn();
  const stop = events.subscribeProviderConnections(connection);
  try {
    registerAndGetSender();
    mockOpenManaged.mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('verification aborted')),
            {
              once: true,
            },
          );
        }),
    );
    const result = expect(startOpenCodeLogin()).rejects.toThrow();
    await jest.advanceTimersByTimeAsync(60_000);
    await result;
    expect(connection).toHaveBeenCalledTimes(1);
    expect(connection).toHaveBeenCalledWith({
      provider: 'opencode',
      connectionMethod: 'native_login',
      connectSource: 'in_app',
      failureReason: 'timeout',
    });
    expect(mockStart).not.toHaveBeenCalled();
  } finally {
    stop();
    events.resetProviderConnectionEventsForTests();
    jest.useRealTimers();
  }
});

it.each(['claude', 'opencode'] as const)(
  'reports a modal-close SIGTERM with exit code zero once as cancelled for %s',
  async (provider) => {
    const events = await import('../lib/provider-connection-events');
    events.resetProviderConnectionEventsForTests();
    const connection = jest.fn<void, [ProviderConnectionEvent]>();
    const unsubscribe = events.subscribeProviderConnections(connection);
    try {
      const sender = registerAndGetSender();
      if (provider === 'opencode') await startOpenCodeLogin();
      const stopHandler = mockRegisterIpcHandler.mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.authTerminalStop,
      )?.[1];
      if (!stopHandler) throw new Error('Missing stop handler');
      stopHandler({ sender: APP_SENDER }, { sessionId: 'opencode-login' });
      sender(IPC_CHANNELS.authTerminalExit, {
        sessionId: 'opencode-login',
        provider,
        exitCode: 0,
        signal: '15',
      });
      await flushPromises();
      await flushPromises();
      expect(connection.mock.calls.map(([event]) => event)).toEqual([
        {
          provider,
          connectionMethod: 'native_login',
          connectSource: 'in_app',
          failureReason: 'cancelled',
        },
      ]);
      expect(mockRevokeOpenCode).not.toHaveBeenCalled();
      if (provider === 'claude') {
        expect(mockCheckClaudeAuthStatusObserved).toHaveBeenCalledWith(
          'auth-terminal-exit',
          { forceAuthenticatedInvalidation: false },
        );
      } else expect(mockRuntimeClose).toHaveBeenCalledTimes(1);
      expect(mockSendToWindow).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      events.resetProviderConnectionEventsForTests();
    }
  },
);

describe('sign-in another computer started through Remote Control (CAN-6718)', () => {
  // No other sign-in is running unless a case says so: a bridge's start
  // would otherwise meet the shared fixture's live OpenCode session.
  beforeEach(() => {
    mockGetActiveSessionId.mockReturnValue(null);
  });

  function startHandler(): (event: unknown, request: unknown) => unknown {
    registerAndGetSender();
    const handler = mockRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.authTerminalStart,
    )?.[1];
    if (!handler) throw new Error('Missing start handler');
    return handler;
  }

  it('marks a start from the remote bridge as remote, for Claude and Antigravity', async () => {
    const handler = startHandler();
    mockStart.mockReturnValue('remote-login');
    await handler(
      { sender: BRIDGE_SENDER },
      { provider: 'claude', cols: 80, rows: 24 },
    );
    await handler(
      { sender: BRIDGE_SENDER },
      { provider: 'antigravity', cols: 80, rows: 24 },
    );
    expect(mockStart).toHaveBeenNthCalledWith(
      1,
      'claude',
      80,
      24,
      undefined,
      true,
    );
    expect(mockStart).toHaveBeenNthCalledWith(
      2,
      'antigravity',
      80,
      24,
      undefined,
      true,
    );
  });

  // A remote sign-in waits on a code from another computer; when that
  // computer's bridge goes away, or the code never comes, it must not keep
  // the sign-in process running on this one.
  it('stops a remote sign-in when its bridge goes away, for every provider', async () => {
    const handler = startHandler();
    for (const provider of ['claude', 'antigravity'] as const) {
      const bridge = fakeSender(99);
      mockStart.mockReturnValueOnce(`${provider}-login`);
      await handler({ sender: bridge }, { provider, cols: 80, rows: 24 });
      expect(mockStop).not.toHaveBeenCalled();
      bridge.emit('destroyed');
      expect(mockStop).toHaveBeenCalledWith(`${provider}-login`);
      mockStop.mockClear();
    }
    // This computer's own window keeps its sign-in.
    const app = fakeSender(1);
    mockStart.mockReturnValueOnce('local-login');
    await handler({ sender: app }, { provider: 'claude', cols: 80, rows: 24 });
    app.emit('destroyed');
    expect(mockStop).not.toHaveBeenCalled();
  });

  // The deadline is one setTimeout per remote sign-in: 660 s, a backstop
  // one minute after a sign-in's own 600-second deadline.
  it('bounds a remote sign-in with a backstop deadline and forgets it once it exits', async () => {
    jest.useFakeTimers();
    try {
      const sender = registerAndGetSender();
      const handler = mockRegisterIpcHandler.mock.calls.find(
        ([channel]) => channel === IPC_CHANNELS.authTerminalStart,
      )?.[1];
      if (!handler) throw new Error('Missing start handler');
      const bridge = fakeSender(99);
      mockStart.mockReturnValueOnce('slow-login');
      await handler(
        { sender: bridge },
        { provider: 'claude', cols: 80, rows: 24 },
      );
      jest.advanceTimersByTime(659_999);
      expect(mockStop).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(mockStop).toHaveBeenCalledWith('slow-login');
      mockStop.mockClear();
      // A sign-in that exits on its own drops its deadline and bridge hook.
      mockStart.mockReturnValueOnce('quick-login');
      await handler(
        { sender: bridge },
        { provider: 'claude', cols: 80, rows: 24 },
      );
      sender(IPC_CHANNELS.authTerminalExit, {
        sessionId: 'quick-login',
        provider: 'claude',
        exitCode: 0,
        signal: null,
      });
      jest.advanceTimersByTime(660_000);
      bridge.emit('destroyed');
      expect(mockStop).not.toHaveBeenCalled();
      expect(bridge.listenerCount('destroyed')).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a start from this computer’s own window local', async () => {
    const handler = startHandler();
    mockStart.mockReturnValue('local-login');
    await handler(
      { sender: APP_SENDER },
      { provider: 'antigravity', cols: 80, rows: 24 },
    );
    expect(mockStart).toHaveBeenCalledWith('antigravity', 80, 24, undefined);
  });
  function handlerFor(
    channel: string,
  ): (event: unknown, request: unknown) => unknown {
    const handler = mockRegisterIpcHandler.mock.calls.find(
      ([registered]) => registered === channel,
    )?.[1];
    if (!handler) throw new Error(`Missing ${channel} handler`);
    return handler;
  }

  // CAN-6718 review: output carries the sign-in link and the session id
  // input is typed into, so a bridge's sign-in is heard only through that
  // bridge, and this computer's own copy is never mirrored to controllers.
  it('sends a bridge’s sign-in output and exit only to that bridge', async () => {
    const send = registerAndGetSender();
    const handler = handlerFor(IPC_CHANNELS.authTerminalStart);
    const bridge = fakeSender(99);
    mockStart.mockReturnValueOnce('remote-login');
    await handler(
      { sender: bridge },
      { provider: 'claude', cols: 80, rows: 24 },
    );
    const output = { sessionId: 'remote-login', data: 'https://claude.ai/x' };
    send(IPC_CHANNELS.authTerminalOutput, output);
    expect(mockSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockSendToWindow).toHaveBeenCalledWith(
      expect.objectContaining({ webContents: bridge }),
      IPC_CHANNELS.authTerminalOutput,
      output,
    );
    send(IPC_CHANNELS.authTerminalExit, {
      sessionId: 'remote-login',
      provider: 'github',
      exitCode: 1,
      signal: null,
    });
    expect(mockSendToWindow).toHaveBeenLastCalledWith(
      expect.objectContaining({ webContents: bridge }),
      IPC_CHANNELS.authTerminalExit,
      expect.objectContaining({ sessionId: 'remote-login' }),
    );
    mockSendToWindow.mockClear();
    // A local sign-in's events stay on this computer's window.
    send(IPC_CHANNELS.authTerminalOutput, { sessionId: 'local', data: 'x' });
    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.authTerminalOutput,
      { sessionId: 'local', data: 'x' },
    );
    expect(isMirrored(IPC_CHANNELS.authTerminalOutput)).toBe(false);
    expect(isMirrored(IPC_CHANNELS.authTerminalExit)).toBe(false);
  });

  // CAN-6718 review: another controller that learns the session id must not
  // type its own code into a sign-in someone else started.
  it('takes input, resize and stop only from the window that owns the sign-in', async () => {
    registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const write = handlerFor(IPC_CHANNELS.authTerminalWrite);
    const resize = handlerFor(IPC_CHANNELS.authTerminalResize);
    const stop = handlerFor(IPC_CHANNELS.authTerminalStop);
    const owner = fakeSender(99);
    const other = fakeSender(99);
    mockStart.mockReturnValueOnce('owned-login');
    await start(
      { sender: owner },
      { provider: 'antigravity', cols: 80, rows: 24 },
    );
    const request = { sessionId: 'owned-login', data: 'code\r' };
    for (const sender of [other, APP_SENDER]) {
      expect(() => write({ sender }, request)).toThrow(
        'This sign-in belongs to another window.',
      );
      expect(() =>
        resize({ sender }, { sessionId: 'owned-login', cols: 1, rows: 1 }),
      ).toThrow('This sign-in belongs to another window.');
      expect(() => stop({ sender }, { sessionId: 'owned-login' })).toThrow(
        'This sign-in belongs to another window.',
      );
    }
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockResize).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    write({ sender: owner }, request);
    expect(mockWrite).toHaveBeenCalledWith('owned-login', 'code\r');
    // A sign-in this computer's window started takes no controller's input.
    mockStart.mockReturnValueOnce('local-login');
    await start(
      { sender: APP_SENDER },
      { provider: 'claude', cols: 80, rows: 24 },
    );
    expect(() =>
      write({ sender: other }, { sessionId: 'local-login', data: 'x' }),
    ).toThrow('This sign-in belongs to another window.');
    write({ sender: APP_SENDER }, { sessionId: 'local-login', data: 'x' });
    expect(mockWrite).toHaveBeenLastCalledWith('local-login', 'x');
  });

  it('refuses one oversized write before it reaches the sign-in', async () => {
    registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const write = handlerFor(IPC_CHANNELS.authTerminalWrite);
    const owner = fakeSender(99);
    mockStart.mockReturnValueOnce('big-login');
    await start(
      { sender: owner },
      { provider: 'antigravity', cols: 80, rows: 24 },
    );
    expect(() =>
      write(
        { sender: owner },
        { sessionId: 'big-login', data: 'x'.repeat(16_385) },
      ),
    ).toThrow('Sign-in input is too long.');
    expect(mockWrite).not.toHaveBeenCalled();
  });

  // CAN-6718 review: a bridge that goes away while the sign-in is still
  // starting stops it as soon as it has started.
  it('stops a sign-in whose bridge went away while it was starting', async () => {
    registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const bridge = fakeSender(99);
    mockStart.mockReturnValueOnce('orphan-login');
    const started = start(
      { sender: bridge },
      { provider: 'antigravity', cols: 80, rows: 24 },
    );
    bridge.emit('destroyed');
    await started;
    expect(mockStop).toHaveBeenCalledWith('orphan-login');
  });
  // CAN-6718 review: a sign-in that fails to start leaves no owner behind.
  it('forgets a remote sign-in whose start failed', async () => {
    const send = registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const bridge = fakeSender(99);
    const listeners = bridge.listenerCount('destroyed');
    mockStart.mockReturnValueOnce('failed-login');
    mockCreate.mockImplementationOnce(() => {
      throw new Error('Invalid terminal size.');
    });
    await expect(
      start({ sender: bridge }, { provider: 'claude', cols: -1, rows: 24 }),
    ).rejects.toThrow('Invalid terminal size.');
    expect(bridge.listenerCount('destroyed')).toBe(listeners);
    // A later event for that id would go to this computer's window, not the
    // bridge: nothing remembers it.
    send(IPC_CHANNELS.authTerminalOutput, {
      sessionId: 'failed-login',
      data: 'x',
    });
    expect(mockSendToWindow).toHaveBeenCalledWith(
      null,
      IPC_CHANNELS.authTerminalOutput,
      { sessionId: 'failed-login', data: 'x' },
    );
  });

  // CAN-6718 review: the bridge's deadline is a backstop after a sign-in's
  // own 600-second deadline, so Antigravity reports its own timeout first.
  it('stops a remote sign-in only after the sign-in’s own deadline', async () => {
    jest.useFakeTimers();
    try {
      registerAndGetSender();
      const start = handlerFor(IPC_CHANNELS.authTerminalStart);
      const bridge = fakeSender(99);
      mockStart.mockReturnValueOnce('slow-login');
      await start(
        { sender: bridge },
        { provider: 'antigravity', cols: 80, rows: 24 },
      );
      jest.advanceTimersByTime(600_000);
      expect(mockStop).not.toHaveBeenCalled();
      jest.advanceTimersByTime(60_000);
      expect(mockStop).toHaveBeenCalledWith('slow-login');
    } finally {
      jest.useRealTimers();
    }
  });

  // CAN-6718 review S2: the computer runs one sign-in at a time and a start
  // replaces the running one, so a bridge may replace only the sign-in it
  // started. This computer's window may still replace any.
  it('refuses a bridge’s start while someone else’s sign-in runs', async () => {
    registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const own = fakeSender(99);
    const other = fakeSender(99);
    mockStart.mockReturnValueOnce('own-login');
    await start({ sender: own }, { provider: 'claude', cols: 80, rows: 24 });
    mockStart.mockReturnValueOnce('local-login');
    await start(
      { sender: APP_SENDER },
      { provider: 'claude', cols: 80, rows: 24 },
    );
    mockStart.mockClear();
    mockOpenManaged.mockClear();
    const refusals: [string, ReturnType<typeof fakeSender>][] = [
      ['own-login', other],
      ['local-login', own],
      ['unknown-login', own],
    ];
    for (const [active, sender] of refusals)
      for (const provider of ['claude', 'antigravity', 'opencode'] as const) {
        mockGetActiveSessionId.mockReturnValue(active);
        await expect(
          Promise.resolve(start({ sender }, { provider, cols: 80, rows: 24 })),
        ).rejects.toThrow('A sign-in is already running on the computer.');
      }
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockOpenManaged).not.toHaveBeenCalled();
    expect(mockStop).not.toHaveBeenCalled();
    // The bridge replaces its own; this computer's window replaces any.
    mockGetActiveSessionId.mockReturnValue('own-login');
    mockStart.mockReturnValueOnce('own-again');
    await start({ sender: own }, { provider: 'claude', cols: 80, rows: 24 });
    mockStart.mockReturnValueOnce('local-again');
    await start(
      { sender: APP_SENDER },
      { provider: 'claude', cols: 80, rows: 24 },
    );
    expect(
      mockStart.mock.calls.map((args: unknown[]): unknown => args[0]),
    ).toEqual(['claude', 'claude']);
  });

  // CAN-6718 review: the ownership check holds until the sign-in exists, so
  // neither a second bridge starting at the same moment nor a sign-in that
  // starts while OpenCode verifies is replaced by a bridge.
  it('holds a bridge’s start against other owners until its sign-in exists', async () => {
    registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const first = fakeSender(99);
    const second = fakeSender(99);
    mockStart.mockReturnValueOnce('first-login');
    const both = await Promise.allSettled([
      start({ sender: first }, { provider: 'claude', cols: 80, rows: 24 }),
      start({ sender: second }, { provider: 'claude', cols: 80, rows: 24 }),
    ]);
    expect(both[0]).toMatchObject({
      status: 'fulfilled',
      value: { sessionId: 'first-login' },
    });
    expect(both[1]).toMatchObject({
      status: 'rejected',
      reason: { message: 'A sign-in is already running on the computer.' },
    });
    expect(mockStart).toHaveBeenCalledTimes(1);

    // A sign-in this computer starts while a bridge's OpenCode verifies.
    mockStart.mockClear();
    let verified: (runtime: unknown) => void = () => undefined;
    mockOpenManaged.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          verified = resolve;
        }),
    );
    const bridge = fakeSender(99);
    const pending = start(
      { sender: bridge },
      { provider: 'opencode', cols: 80, rows: 24 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    // Another bridge waits for it too.
    await expect(
      Promise.resolve(
        start({ sender: second }, { provider: 'claude', cols: 80, rows: 24 }),
      ),
    ).rejects.toThrow('A sign-in is already running on the computer.');
    mockStart.mockReturnValueOnce('local-login');
    await start(
      { sender: APP_SENDER },
      { provider: 'claude', cols: 80, rows: 24 },
    );
    mockGetActiveSessionId.mockReturnValue('local-login');
    verified({
      executable: '/verified/opencode',
      signal: mockRuntimeAbort.signal,
      close: mockRuntimeClose,
    });
    await expect(Promise.resolve(pending)).rejects.toThrow(
      'A sign-in is already running on the computer.',
    );
    expect(mockRuntimeClose).toHaveBeenCalled();
    expect(
      mockStart.mock.calls.map((args: unknown[]): unknown => args[0]),
    ).toEqual(['claude']);
    expect(mockStop).not.toHaveBeenCalled();
  });

  // CAN-6718 review: the stable IPC error policy keeps the refusal's words,
  // so a controller says what to wait for instead of generic copy.
  it('keeps the sign-in refusal through the stable IPC error policy', () => {
    const rejection = toIpcRejection(
      IPC_CHANNELS.authTerminalStart,
      new Error('A sign-in is already running on the computer.'),
    );
    const envelope: unknown = JSON.parse(rejection.message);
    expect(envelope).toMatchObject({
      legacy: 'Error: A sign-in is already running on the computer.',
    });
    const other: unknown = JSON.parse(
      toIpcRejection(
        IPC_CHANNELS.authTerminalStart,
        new Error('/home/someone/private detail'),
      ).message,
    );
    expect(JSON.stringify(other)).not.toContain('private detail');
  });

  // CAN-6718 review: a bridge has one start on its way at a time, and one
  // that goes away while OpenCode verifies stops verifying and holds no one.
  it('gives a bridge one pending start and frees it when the bridge goes away', async () => {
    registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const signals: AbortSignal[] = [];
    let verified: (runtime: unknown) => void = () => undefined;
    mockOpenManaged.mockImplementationOnce(
      (options: { signal: AbortSignal }) => {
        signals.push(options.signal);
        return new Promise((resolve) => {
          verified = resolve;
        });
      },
    );
    const bridge = fakeSender(99);
    const other = fakeSender(99);
    const pending = start(
      { sender: bridge },
      { provider: 'opencode', cols: 80, rows: 24 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      Promise.resolve(
        start({ sender: bridge }, { provider: 'opencode', cols: 80, rows: 24 }),
      ),
    ).rejects.toThrow('A sign-in is already running on the computer.');
    expect(mockOpenManaged).toHaveBeenCalledTimes(1);
    bridge.emit('destroyed');
    expect(signals[0]?.aborted).toBe(true);
    mockStart.mockReturnValueOnce('other-login');
    await expect(
      Promise.resolve(
        start({ sender: other }, { provider: 'claude', cols: 80, rows: 24 }),
      ),
    ).resolves.toEqual({ sessionId: 'other-login' });
    verified({
      executable: '/verified/opencode',
      signal: mockRuntimeAbort.signal,
      close: mockRuntimeClose,
    });
    await expect(Promise.resolve(pending)).rejects.toThrow();
    expect(mockRuntimeClose).toHaveBeenCalled();
    expect(
      mockStart.mock.calls.map((args: unknown[]): unknown => args[0]),
    ).toEqual(['claude']);
  });

  // CAN-6718 review: OpenCode setup asks whether revoking its runtimes would
  // end an OpenCode sign-in another window started, or is starting.
  it('tells OpenCode setup whose OpenCode sign-in its revoke would end', async () => {
    const { wouldEndAnotherOwnersOpenCodeSignIn } =
      await import('../ipc/sign-in-owner-guard');
    registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const owner = fakeSender(99);
    const other = fakeSender(99);
    // The sign-in is the running one once it has started.
    mockGetActiveSessionId.mockImplementation((): string | null =>
      mockStart.mock.calls.length > 0 ? 'bridge-opencode' : null,
    );
    mockStart.mockReturnValueOnce('bridge-opencode');
    await start(
      { sender: owner },
      { provider: 'opencode', cols: 80, rows: 24 },
    );
    const asked = (sender: unknown): boolean =>
      wouldEndAnotherOwnersOpenCodeSignIn(
        sender as Parameters<typeof wouldEndAnotherOwnersOpenCodeSignIn>[0],
      );
    expect([asked(owner), asked(other), asked(APP_SENDER)]).toEqual([
      false,
      true,
      true,
    ]);
    // A Claude sign-in runs on no OpenCode runtime.
    mockGetActiveSessionId.mockReset().mockReturnValue('claude-login');
    mockStart.mockReturnValueOnce('claude-login');
    await start(
      { sender: APP_SENDER },
      { provider: 'claude', cols: 80, rows: 24 },
    );
    expect(asked(other)).toBe(false);
  });

  // CAN-6718 review: while a controller's OpenCode setup, which revokes
  // every OpenCode runtime, runs, no other window starts an OpenCode
  // sign-in it would end. Other providers' sign-ins aren't held.
  it('holds OpenCode sign-in starts while a controller’s OpenCode setup runs', async () => {
    const { holdOpenCodeSignInStarts } =
      await import('../ipc/sign-in-owner-guard');
    registerAndGetSender();
    const start = handlerFor(IPC_CHANNELS.authTerminalStart);
    const holder = fakeSender(99);
    const release = holdOpenCodeSignInStarts(
      holder as unknown as Parameters<typeof holdOpenCodeSignInStarts>[0],
    );
    try {
      await expect(
        Promise.resolve(
          start(
            { sender: APP_SENDER },
            { provider: 'opencode', cols: 80, rows: 24 },
          ),
        ),
      ).rejects.toThrow('OpenCode setup is already running.');
      expect(mockOpenManaged).not.toHaveBeenCalled();
      mockStart.mockReturnValueOnce('claude-login');
      await expect(
        Promise.resolve(
          start(
            { sender: APP_SENDER },
            { provider: 'claude', cols: 80, rows: 24 },
          ),
        ),
      ).resolves.toEqual({ sessionId: 'claude-login' });
    } finally {
      release();
    }
    mockGetActiveSessionId.mockReturnValue(null);
    mockStart.mockReturnValueOnce('opencode-after');
    await expect(
      Promise.resolve(
        start(
          { sender: APP_SENDER },
          { provider: 'opencode', cols: 80, rows: 24 },
        ),
      ),
    ).resolves.toEqual({ sessionId: 'opencode-after' });
    expect(
      JSON.parse(
        toIpcRejection(
          IPC_CHANNELS.authTerminalStart,
          new Error('OpenCode setup is already running.'),
        ).message,
      ),
    ).toMatchObject({ legacy: 'Error: OpenCode setup is already running.' });
  });
});
