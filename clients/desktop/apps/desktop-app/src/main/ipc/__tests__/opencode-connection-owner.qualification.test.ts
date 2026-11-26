/**
 * CAN-6008: the OpenCode Settings operations keep one owner per window, for
 * the window's own IPC calls (opencode-connection:status, :models,
 * :connect, :cancel and :disconnect) and for App Advisor's calls made for the
 * main window through runOpenCodeConnectionForWindow.
 */
import type * as AgentCatalogCompatibility from '../../remote-projection/agent-catalog-compatibility';
import type * as OpenCodeConnection from '../../opencode/connection';
import { EventEmitter } from 'node:events';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

const mockWindows = new Set<unknown>();
jest.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: (contents: unknown): object | null =>
      mockWindows.has(contents) ? {} : null,
  },
}));

const mockSent: Array<[string, unknown]> = [];
jest.mock('../../lib/web-contents-send', () => ({
  sendToWebContents: (
    _contents: unknown,
    channel: string,
    data: unknown,
  ): void => {
    mockSent.push([channel, data]);
  },
}));
jest.mock('../../models/model-registry', () => ({
  broadcastModelRegistryUpdated: jest.fn(),
}));
jest.mock('../../remote-projection/agent-catalog-compatibility', () => ({
  ...jest.requireActual<typeof AgentCatalogCompatibility>(
    '../../remote-projection/agent-catalog-compatibility',
  ),
  notifyModelCatalogChanged: (): Promise<void> => Promise.resolve(),
}));
jest.mock('../../opencode/runtime-availability', () => ({
  peekOpenCodeRuntimeAvailability: (): string => 'ready',
}));

let mockRelease: () => void = () => undefined;
const mockRevokeChecks: Array<(() => void) | undefined> = [];
const mockConnectSignals: AbortSignal[] = [];
jest.mock('../../opencode/connection', () => ({
  opencodeConnectionStatus: (): Promise<object> =>
    Promise.resolve({ connected: false }),
  listOpenCodeModels: (): Promise<[]> => Promise.resolve([]),
  connectOpenCode: (
    signal: AbortSignal,
    progress: (status: object) => void,
    options?: { beforeRevoke?: () => void },
  ): Promise<object> => {
    mockConnectSignals.push(signal);
    // The real connect revokes the OpenCode runtimes after awaited work.
    mockRevokeChecks.push(options?.beforeRevoke);
    progress({ phase: 'downloading' });
    return new Promise((resolve, reject) => {
      mockRelease = (): void => resolve({ connected: true });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  },
  disconnectOpenCode: (options?: {
    beforeRevoke?: () => void;
  }): Promise<void> => {
    mockRevokeChecks.push(options?.beforeRevoke);
    return Promise.resolve();
  },
  revokeOpenCodeRuntimes: (): Promise<void> => Promise.resolve(),
}));

// The real disconnect's state, for the refused-disconnect case (CAN-6718).
let mockPreferences: Record<string, unknown> = { opencodeEnabled: true };
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<Record<string, unknown>> =>
    Promise.resolve(mockPreferences),
  updatePreferencesFile: async (
    update: (preferences: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    await new Promise((resolve) => setImmediate(resolve));
    mockPreferences = update(mockPreferences);
    return mockPreferences;
  },
  getOpenCodeEnabledRevision: (): number => 0,
}));
jest.mock('../../lib/preferences-broadcast', () => ({
  broadcastPreferencesChanged: (): void => undefined,
}));
const mockObservedConnections: unknown[] = [];
jest.mock('../../lib/provider-connection-events', () => ({
  ...jest.requireActual<object>('../../lib/provider-connection-events'),
  observeProviderConnection: (options: unknown): void => {
    mockObservedConnections.push(options);
  },
}));

// A remote bridge window carries another computer's calls (CAN-6718).
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (sender: { id: number }): string | null =>
    sender.id === 99 ? 'controller-device' : null,
}));

import {
  registerOpenCodeConnectionHandlers,
  runOpenCodeConnectionForWindow,
} from '../opencode-connection';
import {
  openCodeSetupHeldByAnother,
  setOpenCodeSignInOwnerCheck,
} from '../sign-in-owner-guard';

class FakeContents extends EventEmitter {
  public readonly mainFrame = {};
  private destroyed = false;
  public constructor(public readonly id: number) {
    super();
  }
  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

function windowFor(contents: FakeContents): Electron.BrowserWindow {
  mockWindows.add(contents);
  return { webContents: contents } as unknown as Electron.BrowserWindow;
}

function event(contents: FakeContents): object {
  return { sender: contents, senderFrame: contents.mainFrame };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 5; tick++)
    await new Promise((resolve) => setImmediate(resolve));
}

beforeAll(() => registerOpenCodeConnectionHandlers());
beforeEach(() => {
  mockWindows.clear();
  mockSent.length = 0;
  mockConnectSignals.length = 0;
});

describe('OpenCode connection ownership (CAN-6008)', () => {
  it("the window's connect reports progress to it, refuses a second setup, and its cancel stops it", async () => {
    const main = new FakeContents(1);
    windowFor(main);
    const connect = handlers.get(IPC_CHANNELS.opencodeConnectionConnect);
    const cancel = handlers.get(IPC_CHANNELS.opencodeConnectionCancel);
    if (!connect || !cancel) throw new Error('handlers missing');

    const running = Promise.resolve(connect(event(main), 'op-1'));
    await settle();
    expect(mockSent).toEqual([
      [IPC_CHANNELS.opencodeConnectionProgress, { phase: 'downloading' }],
    ]);
    await expect(Promise.resolve(connect(event(main), 'op-2'))).rejects.toThrow(
      'OpenCode setup is already running.',
    );
    await cancel(event(main), 'op-1');
    await expect(running).rejects.toThrow('aborted');
  });

  it("App Advisor's connect is owned by the main window: the tool call's abort or a cancel stops it", async () => {
    const main = new FakeContents(2);
    const window = windowFor(main);

    const aborter = new AbortController();
    const first = runOpenCodeConnectionForWindow(
      window,
      'connect',
      aborter.signal,
    );
    await settle();
    aborter.abort();
    await expect(first).rejects.toThrow('aborted');

    const second = runOpenCodeConnectionForWindow(window, 'connect');
    await settle();
    await runOpenCodeConnectionForWindow(window, 'cancel');
    await expect(second).rejects.toThrow('aborted');

    const third = runOpenCodeConnectionForWindow(window, 'connect');
    await settle();
    mockRelease();
    await expect(third).resolves.toEqual({ connected: true });
    expect(mockSent.map(([channel]) => channel)).toEqual([
      IPC_CHANNELS.opencodeConnectionProgress,
      IPC_CHANNELS.opencodeConnectionProgress,
      IPC_CHANNELS.opencodeConnectionProgress,
    ]);
  });

  it("App Advisor's connect refuses a Stop pressed before it started, and never connects", async () => {
    const main = new FakeContents(5);
    const window = windowFor(main);
    const aborter = new AbortController();
    aborter.abort();
    await expect(
      runOpenCodeConnectionForWindow(window, 'connect', aborter.signal),
    ).rejects.toThrow();
    await settle();
    expect(mockConnectSignals).toEqual([]);
    // The window can set up again afterwards: nothing was left running.
    const next = runOpenCodeConnectionForWindow(window, 'connect');
    await settle();
    mockRelease();
    await expect(next).resolves.toEqual({ connected: true });
  });

  it('refuses a window that is gone, and reads status and models as the window does', async () => {
    const gone = new FakeContents(3);
    await expect(
      runOpenCodeConnectionForWindow(
        { webContents: gone } as unknown as Electron.BrowserWindow,
        'status',
      ),
    ).rejects.toThrow('OpenCode setup window is unavailable.');

    const main = new FakeContents(4);
    const window = windowFor(main);
    await expect(
      runOpenCodeConnectionForWindow(window, 'status'),
    ).resolves.toEqual({ connected: false });
    await expect(
      runOpenCodeConnectionForWindow(window, 'models'),
    ).resolves.toEqual([]);
    await expect(
      runOpenCodeConnectionForWindow(window, 'disconnect'),
    ).resolves.toBeUndefined();
    const status = handlers.get(IPC_CHANNELS.opencodeConnectionStatus);
    const models = handlers.get(IPC_CHANNELS.opencodeConnectionModels);
    const disconnect = handlers.get(IPC_CHANNELS.opencodeConnectionDisconnect);
    await expect(Promise.resolve(status?.(event(main)))).resolves.toEqual({
      connected: false,
    });
    await expect(Promise.resolve(models?.(event(main)))).resolves.toEqual([]);
    await expect(
      Promise.resolve(disconnect?.(event(main))),
    ).resolves.toBeUndefined();
  });

  // CAN-6718 review: connect and disconnect revoke every live OpenCode
  // runtime, which ends a sign-in running on one. A bridge may not do that
  // to a sign-in another window started; this computer's window still may.
  it('refuses a bridge’s connect and disconnect over another window’s OpenCode sign-in', async () => {
    const bridge = new FakeContents(99);
    const main = new FakeContents(6);
    windowFor(bridge);
    windowFor(main);
    const connect = handlers.get(IPC_CHANNELS.opencodeConnectionConnect);
    const disconnect = handlers.get(IPC_CHANNELS.opencodeConnectionDisconnect);
    if (!connect || !disconnect) throw new Error('handlers missing');
    const askedFor: unknown[] = [];
    setOpenCodeSignInOwnerCheck((sender) => {
      askedFor.push(sender);
      return true;
    });
    try {
      for (const handler of [connect, disconnect])
        await expect(
          new Promise((resolve) => resolve(handler(event(bridge)))),
        ).rejects.toThrow('A sign-in is already running on the computer.');
      expect(askedFor).toEqual([bridge, bridge]);
      expect(mockConnectSignals).toEqual([]);
      const running = Promise.resolve(connect(event(main), 'op-main'));
      await settle();
      expect(mockConnectSignals).toHaveLength(1);
      mockRelease();
      await expect(running).resolves.toEqual({ connected: true });
    } finally {
      setOpenCodeSignInOwnerCheck(() => false);
    }
  });

  // CAN-6718 review: the check holds up to the revoke itself. A sign-in
  // another window starts while connect probes its status, or disconnect
  // writes its preference, still stops the bridge's revoke.
  it('checks again right before a bridge’s connect or disconnect revokes', async () => {
    const bridge = new FakeContents(99);
    const main = new FakeContents(7);
    windowFor(bridge);
    windowFor(main);
    const connect = handlers.get(IPC_CHANNELS.opencodeConnectionConnect);
    const disconnect = handlers.get(IPC_CHANNELS.opencodeConnectionDisconnect);
    if (!connect || !disconnect) throw new Error('handlers missing');
    let signInRunning = false;
    setOpenCodeSignInOwnerCheck(() => signInRunning);
    mockRevokeChecks.length = 0;
    try {
      const connecting = Promise.resolve(connect(event(bridge), 'op-race'));
      await settle();
      mockRelease();
      await connecting;
      await Promise.resolve(disconnect(event(bridge)));
      const [connectCheck, disconnectCheck] = mockRevokeChecks;
      expect(mockRevokeChecks).toHaveLength(2);
      // Another window's OpenCode sign-in starts during the wait.
      signInRunning = true;
      expect(() => connectCheck?.()).toThrow(
        'A sign-in is already running on the computer.',
      );
      expect(() => disconnectCheck?.()).toThrow(
        'A sign-in is already running on the computer.',
      );
      // This computer's window keeps no such check.
      mockRevokeChecks.length = 0;
      await Promise.resolve(disconnect(event(main))).catch(() => undefined);
      expect(mockRevokeChecks).toEqual([undefined]);
    } finally {
      setOpenCodeSignInOwnerCheck(() => false);
    }
  });

  // CAN-6718 review: a disconnect refused right before its revoke changes
  // nothing: OpenCode stays enabled and its account connection is kept.
  it('leaves OpenCode as it was when a disconnect is refused before its revoke', async () => {
    const actual = jest.requireActual<typeof OpenCodeConnection>(
      '../../opencode/connection',
    );
    mockPreferences = { opencodeEnabled: true };
    mockObservedConnections.length = 0;
    let signInRunning = false;
    const refused = actual.disconnectOpenCode({
      beforeRevoke: () => {
        if (signInRunning)
          throw new Error('A sign-in is already running on the computer.');
      },
    });
    // Another window's OpenCode sign-in starts while the preference is
    // being written.
    signInRunning = true;
    await expect(refused).rejects.toThrow(
      'A sign-in is already running on the computer.',
    );
    expect(mockPreferences.opencodeEnabled).toBe(true);
    expect(mockObservedConnections).toEqual([]);
  });

  // CAN-6718 review: a bridge's OpenCode setup holds other windows' OpenCode
  // sign-in starts until it settles, so none starts between its checks and
  // its revoke. This computer's window's setup holds nothing.
  it('holds other windows’ OpenCode sign-ins while a bridge’s setup runs', async () => {
    const bridge = new FakeContents(99);
    const main = new FakeContents(8);
    windowFor(bridge);
    windowFor(main);
    const connect = handlers.get(IPC_CHANNELS.opencodeConnectionConnect);
    if (!connect) throw new Error('handlers missing');
    const asHolder = (contents: FakeContents): boolean =>
      openCodeSetupHeldByAnother(
        contents as unknown as Parameters<typeof openCodeSetupHeldByAnother>[0],
      );
    const bridgeSetup = Promise.resolve(connect(event(bridge), 'op-hold'));
    await settle();
    expect([asHolder(main), asHolder(bridge)]).toEqual([true, false]);
    mockRelease();
    await bridgeSetup;
    expect(asHolder(main)).toBe(false);
    const mainSetup = Promise.resolve(connect(event(main), 'op-main-hold'));
    await settle();
    expect(asHolder(bridge)).toBe(false);
    mockRelease();
    await mainSetup;
  });
});
