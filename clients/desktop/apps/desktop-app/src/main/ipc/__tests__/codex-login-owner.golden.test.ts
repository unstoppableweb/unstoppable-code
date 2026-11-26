/**
 * Codex sign-in from another computer (CAN-6718). A remote bridge window may
 * start and drive a device-code attempt, whose code and page the controlling
 * computer shows and opens; the browser method, whose callback runs on this
 * computer, and opening this computer's browser stay with the app window.
 */
import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContents } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { isMirrored } from '../../remote-control/host/main-window-pushes';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
interface PushedState {
  attemptId?: string | null;
  phase: string;
  outcome?: string;
  activeWorkCount?: number;
  userCode?: string;
  verificationUrl?: string;
}
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
const mockSendToWindow = jest.fn();
jest.mock('../../lib/window-send', () => ({
  sendToWindow: (...args: unknown[]): unknown => mockSendToWindow(...args),
}));
const mockOpenExternal = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
jest.mock('../../lib/open-external', () => ({
  openExternalGuarded: (url: string): Promise<void> => mockOpenExternal(url),
}));
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): null => null,
}));
const mockManager = {
  start: jest.fn((request: { method: string }) => ({
    attemptId: 'attempt-1',
    phase: 'waiting',
    activeWorkCount: 0,
    method: request.method,
  })),
  finish: jest.fn<Promise<unknown>, [string]>(() =>
    Promise.resolve({ attemptId: null, phase: 'ready' }),
  ),
  abandon: jest.fn<Promise<unknown>, []>(() =>
    Promise.resolve({ attemptId: null, phase: 'ready' }),
  ),
  retryVerification: jest.fn(() =>
    Promise.resolve({ attemptId: 'attempt-1', phase: 'verifying' }),
  ),
  browserUrl: jest.fn(() => 'https://auth.openai.com/oauth/authorize?x=1'),
  onState: jest.fn<void, [(state: PushedState) => void]>(),
};
jest.mock('../../auth/codex-login', () => ({
  // Read when the handlers run, after this file's constants exist.
  get codexLoginManager(): typeof mockManager {
    return mockManager;
  },
}));

import { registerCodexLoginHandlers } from '../codex-login';

class FakeContents extends EventEmitter {
  private destroyed = false;
  public constructor(public readonly id: number) {
    super();
    this.once('destroyed', () => {
      this.destroyed = true;
    });
  }
  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

const appWindow = new FakeContents(1);
const appBrowserWindow = { webContents: appWindow };
const bridge = new FakeContents(2);
const stranger = new FakeContents(3);
const bridges = new Set<unknown>([bridge]);
let publishState: (state: PushedState) => void = () => undefined;

function invoke(
  channel: string,
  sender: FakeContents,
  ...args: unknown[]
): unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({ sender }, ...args);
}

beforeAll(() => {
  registerCodexLoginHandlers(
    () => appBrowserWindow as unknown as BrowserWindow,
    (sender: WebContents) => bridges.has(sender),
  );
  const listener = mockManager.onState.mock.calls[0]?.[0];
  if (listener) publishState = listener;
});
beforeEach(() => {
  jest.clearAllMocks();
});

describe('Codex sign-in owner', () => {
  it('tunnels start, cancel, retry and state, and keeps open-browser blocked', () => {
    expect(IPC_REMOTE_DISPOSITIONS.codexLoginStart).toBe('tunnel');
    expect(IPC_REMOTE_DISPOSITIONS.codexLoginCancel).toBe('tunnel');
    expect(IPC_REMOTE_DISPOSITIONS.codexLoginRetryVerification).toBe('tunnel');
    expect(IPC_REMOTE_DISPOSITIONS.codexLoginState).toBe('tunnel');
    expect(IPC_REMOTE_DISPOSITIONS.codexLoginOpenBrowser).toBe('blocked');
  });

  it('refuses the browser method from a remote bridge before starting', () => {
    expect(() =>
      invoke(IPC_CHANNELS.codexLoginStart, bridge, {
        confirmPause: false,
        method: 'chatgpt',
      }),
    ).toThrow('Sign in to Codex with a device code from another computer.');
    expect(mockManager.start).not.toHaveBeenCalled();
  });

  it('refuses a window that is neither the app window nor a bridge', () => {
    expect(() =>
      invoke(IPC_CHANNELS.codexLoginStart, stranger, {
        confirmPause: false,
        method: 'chatgptDeviceCode',
      }),
    ).toThrow('Codex sign-in requires the desktop window.');
  });

  it('lets a bridge own a device-code attempt, but never open this computer’s browser', async () => {
    expect(
      invoke(IPC_CHANNELS.codexLoginStart, bridge, {
        confirmPause: false,
        method: 'chatgptDeviceCode',
      }),
    ).toMatchObject({ attemptId: 'attempt-1', method: 'chatgptDeviceCode' });
    await expect(
      invoke(IPC_CHANNELS.codexLoginOpenBrowser, bridge),
    ).rejects.toThrow('Open the sign-in page on the computer you are using.');
    expect(mockOpenExternal).not.toHaveBeenCalled();
    // Another window cannot drive the bridge's attempt.
    await expect(
      invoke(IPC_CHANNELS.codexLoginCancel, appWindow),
    ).rejects.toThrow('requires the owning desktop window');
    await invoke(IPC_CHANNELS.codexLoginRetryVerification, bridge);
    expect(mockManager.retryVerification).toHaveBeenCalledTimes(1);
    // A bridge's cancel closes its attempt without verifying the account.
    await invoke(IPC_CHANNELS.codexLoginCancel, bridge);
    expect(mockManager.abandon).toHaveBeenCalledTimes(1);
    expect(mockManager.finish).not.toHaveBeenCalled();
  });

  // CAN-6718 review: nobody is left to finish a gone bridge's attempt, so it
  // is abandoned without verifying the account, which on a signed-out host
  // would fail and keep the attempt reserved.
  it('abandons the attempt when its bridge goes away', () => {
    invoke(IPC_CHANNELS.codexLoginStart, bridge, {
      confirmPause: false,
      method: 'chatgptDeviceCode',
    });
    bridge.emit('destroyed');
    expect(mockManager.abandon).toHaveBeenCalledTimes(1);
    expect(mockManager.finish).not.toHaveBeenCalled();
  });

  it('frees a gone bridge’s attempt for the next controller once it is abandoned', async () => {
    const gone = new FakeContents(10);
    const next = new FakeContents(11);
    bridges.add(gone);
    bridges.add(next);
    invoke(IPC_CHANNELS.codexLoginStart, gone, {
      confirmPause: false,
      method: 'chatgptDeviceCode',
    });
    mockManager.abandon.mockImplementationOnce(() =>
      Promise.resolve({
        attemptId: 'attempt-1',
        phase: 'complete',
        outcome: 'cancelled',
      }),
    );
    gone.emit('destroyed');
    await Promise.resolve();
    await Promise.resolve();
    expect(
      invoke(IPC_CHANNELS.codexLoginStart, next, {
        confirmPause: false,
        method: 'chatgptDeviceCode',
      }),
    ).toMatchObject({ attemptId: 'attempt-1' });
    publishState({ attemptId: 'attempt-1', phase: 'complete' });
  });

  it('does not cancel an attempt another window owns when an earlier bridge goes away', async () => {
    const earlier = new FakeContents(4);
    bridges.add(earlier);
    invoke(IPC_CHANNELS.codexLoginStart, earlier, {
      confirmPause: false,
      method: 'chatgptDeviceCode',
    });
    await invoke(IPC_CHANNELS.codexLoginCancel, earlier);
    // The manager publishes the cancelled attempt as complete.
    publishState({ phase: 'complete' });
    invoke(IPC_CHANNELS.codexLoginStart, appWindow, {
      confirmPause: false,
      method: 'chatgpt',
    });
    mockManager.finish.mockClear();
    mockManager.abandon.mockClear();
    earlier.emit('destroyed');
    // A window that goes away abandons only its own attempt (CAN-6718 review
    // round 11: the close handler abandons, so that is what must not run).
    expect(mockManager.abandon).not.toHaveBeenCalled();
    expect(mockManager.finish).not.toHaveBeenCalled();
    // The app window still owns, and may cancel, its own attempt.
    await invoke(IPC_CHANNELS.codexLoginCancel, appWindow);
    expect(mockManager.finish).toHaveBeenCalledWith('cancelled');
    publishState({ phase: 'complete' });
  });

  // CAN-6718 review: a bridge's attempt whose code expired, that timed out or
  // failed, and then couldn't verify the account (a signed-out host) is
  // abandoned once, so the sign-in isn't held for the still-connected
  // controller. One that signed in but failed only verification stays for
  // that controller to retry.
  it('abandons a bridge’s failed attempt once when it can’t verify the account', async () => {
    const owner = new FakeContents(12);
    bridges.add(owner);
    invoke(IPC_CHANNELS.codexLoginStart, owner, {
      confirmPause: false,
      method: 'chatgptDeviceCode',
    });
    publishState({
      attemptId: 'attempt-1',
      phase: 'verification-failed',
      outcome: 'success',
    });
    await Promise.resolve();
    expect(mockManager.abandon).not.toHaveBeenCalled();
    const failed = {
      attemptId: 'attempt-1',
      phase: 'verification-failed',
      outcome: 'failed',
      activeWorkCount: 0,
    };
    publishState(failed);
    await Promise.resolve();
    expect(mockManager.abandon).toHaveBeenCalledTimes(1);
    // A close that fails publishes the failure again; it isn't retried.
    publishState(failed);
    await Promise.resolve();
    expect(mockManager.abandon).toHaveBeenCalledTimes(1);
    publishState({ attemptId: 'attempt-1', phase: 'complete' });
  });

  // CAN-6718 review round 7: a failed attempt with paused work moves to the
  // controller's resume prompt, whose Retry and Cancel need the attempt to
  // still be that bridge's.
  it('keeps a bridge’s failed attempt with paused work for its resume prompt to retry', async () => {
    const owner = new FakeContents(13);
    bridges.add(owner);
    mockManager.start.mockReturnValueOnce({
      attemptId: 'attempt-paused',
      phase: 'waiting',
      activeWorkCount: 2,
      method: 'chatgptDeviceCode',
    });
    invoke(IPC_CHANNELS.codexLoginStart, owner, {
      confirmPause: true,
      method: 'chatgptDeviceCode',
    });
    publishState({
      attemptId: 'attempt-paused',
      phase: 'verification-failed',
      outcome: 'failed',
      activeWorkCount: 2,
    });
    await Promise.resolve();
    expect(mockManager.abandon).not.toHaveBeenCalled();
    await expect(
      invoke(IPC_CHANNELS.codexLoginRetryVerification, owner),
    ).resolves.toMatchObject({ phase: 'verifying' });
    // The prompt's Cancel still closes it through abandon.
    await invoke(IPC_CHANNELS.codexLoginCancel, owner);
    expect(mockManager.abandon).toHaveBeenCalledTimes(1);
    publishState({ attemptId: 'attempt-paused', phase: 'complete' });
  });

  it('keeps this computer’s failed attempt for its own window', async () => {
    invoke(IPC_CHANNELS.codexLoginStart, appWindow, {
      confirmPause: false,
      method: 'chatgpt',
    });
    publishState({
      attemptId: 'attempt-2',
      phase: 'verification-failed',
      outcome: 'failed',
    });
    await Promise.resolve();
    expect(mockManager.abandon).not.toHaveBeenCalled();
    await invoke(IPC_CHANNELS.codexLoginCancel, appWindow);
    expect(mockManager.finish).toHaveBeenCalledWith('cancelled');
    publishState({ attemptId: 'attempt-2', phase: 'complete' });
  });

  it('keeps the app window’s browser sign-in unchanged', async () => {
    invoke(IPC_CHANNELS.codexLoginStart, appWindow, {
      confirmPause: false,
      method: 'chatgpt',
    });
    expect(mockManager.start).toHaveBeenCalledWith({
      confirmPause: false,
      method: 'chatgpt',
    });
    await invoke(IPC_CHANNELS.codexLoginOpenBrowser, appWindow);
    expect(mockOpenExternal).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/authorize?x=1',
    );
  });

  // CAN-6718 review W2: a start while another window's attempt runs says
  // so as an answer, not a thrown error, which IPC would replace with generic
  // copy; it starts nothing.
  it('tells another window that a Codex sign-in is already running', () => {
    invoke(IPC_CHANNELS.codexLoginStart, appWindow, {
      confirmPause: false,
      method: 'chatgpt',
    });
    mockManager.start.mockClear();
    expect(
      invoke(IPC_CHANNELS.codexLoginStart, bridge, {
        confirmPause: false,
        method: 'chatgptDeviceCode',
      }),
    ).toEqual({
      attemptId: null,
      phase: 'ready',
      activeWorkCount: 0,
      refusal: 'already-running',
    });
    expect(mockManager.start).not.toHaveBeenCalled();
    publishState({ phase: 'complete' });
  });

  // CAN-6718 review: the device code lets whoever holds it finish the
  // sign-in, so it reaches only the window that owns the attempt.
  it('sends a bridge’s attempt, code included, only to that bridge', () => {
    const owner = new FakeContents(5);
    bridges.add(owner);
    invoke(IPC_CHANNELS.codexLoginStart, owner, {
      confirmPause: false,
      method: 'chatgptDeviceCode',
    });
    mockSendToWindow.mockClear();
    const waiting = {
      attemptId: 'attempt-1',
      phase: 'waiting',
      activeWorkCount: 0,
      method: 'chatgptDeviceCode',
      userCode: 'ABCD-1234',
      verificationUrl: 'https://auth.openai.com/codex/device',
    };
    publishState(waiting);
    expect(mockSendToWindow).toHaveBeenCalledWith(
      expect.objectContaining({ webContents: owner }),
      IPC_CHANNELS.codexLoginState,
      waiting,
    );
    // This computer's window learns the phase, never the code or page.
    expect(mockSendToWindow).toHaveBeenCalledWith(
      appBrowserWindow,
      IPC_CHANNELS.codexLoginState,
      {
        attemptId: 'attempt-1',
        phase: 'waiting',
        activeWorkCount: 0,
        method: 'chatgptDeviceCode',
      },
    );
    // Main's copy for its own window is never mirrored to controllers.
    expect(isMirrored(IPC_CHANNELS.codexLoginState)).toBe(false);
    publishState({ attemptId: 'attempt-1', phase: 'complete' });
  });

  it('keeps an app window’s attempt on that window', () => {
    invoke(IPC_CHANNELS.codexLoginStart, appWindow, {
      confirmPause: false,
      method: 'chatgptDeviceCode',
    });
    mockSendToWindow.mockClear();
    const waiting = {
      attemptId: 'attempt-1',
      phase: 'waiting',
      userCode: 'WXYZ-0000',
    };
    publishState(waiting);
    expect(mockSendToWindow).toHaveBeenCalledWith(
      appBrowserWindow,
      IPC_CHANNELS.codexLoginState,
      waiting,
    );
    expect(mockSendToWindow).toHaveBeenCalledTimes(1);
    publishState({ attemptId: 'attempt-1', phase: 'complete' });
  });

  // CAN-6718 review: a bridge that goes away keeps its attempt reserved
  // until the cancellation finishes, so another window cannot adopt the
  // attempt being cancelled.
  it('keeps a gone bridge’s attempt reserved until its cancellation finishes', async () => {
    const gone = new FakeContents(6);
    const next = new FakeContents(7);
    bridges.add(gone);
    bridges.add(next);
    invoke(IPC_CHANNELS.codexLoginStart, gone, {
      confirmPause: false,
      method: 'chatgptDeviceCode',
    });
    let finishCancel: (value: unknown) => void = () => undefined;
    mockManager.abandon.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        }),
    );
    gone.emit('destroyed');
    expect(mockManager.abandon).toHaveBeenCalledTimes(1);
    mockManager.start.mockClear();
    expect(
      invoke(IPC_CHANNELS.codexLoginStart, next, {
        confirmPause: false,
        method: 'chatgptDeviceCode',
      }),
    ).toMatchObject({ refusal: 'already-running' });
    expect(mockManager.start).not.toHaveBeenCalled();
    finishCancel({ attemptId: null, phase: 'ready' });
    await Promise.resolve();
    await Promise.resolve();
    expect(
      invoke(IPC_CHANNELS.codexLoginStart, next, {
        confirmPause: false,
        method: 'chatgptDeviceCode',
      }),
    ).toMatchObject({ attemptId: 'attempt-1' });
    publishState({ attemptId: 'attempt-1', phase: 'complete' });
  });

  // CAN-6718 review: a gone bridge's attempt that abandoning can't close
  // (closing its session failed, so the manager still holds it) stays
  // reserved, so no other controller adopts it; this computer's own window
  // may take it over to cancel or retry it.
  it('keeps a gone bridge’s unfinished attempt from other controllers, but lets this computer’s window recover it', async () => {
    const gone = new FakeContents(8);
    const other = new FakeContents(9);
    bridges.add(gone);
    bridges.add(other);
    invoke(IPC_CHANNELS.codexLoginStart, gone, {
      confirmPause: false,
      method: 'chatgptDeviceCode',
    });
    mockManager.abandon.mockImplementationOnce(() =>
      Promise.resolve({
        attemptId: 'attempt-1',
        phase: 'verification-failed',
      }),
    );
    gone.emit('destroyed');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    mockManager.start.mockClear();
    expect(
      invoke(IPC_CHANNELS.codexLoginStart, other, {
        confirmPause: false,
        method: 'chatgptDeviceCode',
      }),
    ).toMatchObject({ refusal: 'already-running' });
    await expect(
      invoke(IPC_CHANNELS.codexLoginRetryVerification, other),
    ).rejects.toThrow('requires the owning desktop window');
    expect(mockManager.start).not.toHaveBeenCalled();
    // This computer's window takes it over and cancels it.
    await invoke(IPC_CHANNELS.codexLoginRetryVerification, appWindow);
    expect(mockManager.retryVerification).toHaveBeenCalledTimes(1);
    await invoke(IPC_CHANNELS.codexLoginCancel, appWindow);
    expect(mockManager.finish).toHaveBeenLastCalledWith('cancelled');
    publishState({ attemptId: 'attempt-1', phase: 'complete' });
  });
});
