/**
 * CAN-6008: the OpenCode Settings operations keep one owner per window, for
 * the window's own IPC calls (opencode-connection:status, :models,
 * :connect, :cancel and :disconnect) and for App Advisor's calls made for the
 * main window through runOpenCodeConnectionForWindow.
 */
import type * as AgentCatalogCompatibility from '../../remote-projection/agent-catalog-compatibility';
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
const mockConnectSignals: AbortSignal[] = [];
jest.mock('../../opencode/connection', () => ({
  opencodeConnectionStatus: (): Promise<object> =>
    Promise.resolve({ connected: false }),
  listOpenCodeModels: (): Promise<[]> => Promise.resolve([]),
  connectOpenCode: (
    signal: AbortSignal,
    progress: (status: object) => void,
  ): Promise<object> => {
    mockConnectSignals.push(signal);
    progress({ phase: 'downloading' });
    return new Promise((resolve, reject) => {
      mockRelease = (): void => resolve({ connected: true });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  },
  disconnectOpenCode: (): Promise<void> => Promise.resolve(),
  revokeOpenCodeRuntimes: (): Promise<void> => Promise.resolve(),
}));

import {
  registerOpenCodeConnectionHandlers,
  runOpenCodeConnectionForWindow,
} from '../opencode-connection';

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
});
