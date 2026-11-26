/**
 * A Cursor sign-in another computer started through Remote Control sends its
 * cursor.com link to that computer with the progress status instead of
 * opening this computer's browser (CAN-6718). Connect and Change account
 * tunnel, so the progress status reaches the controller.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { IPC_REMOTE_DISPOSITIONS } from '@canopy/desktop-shared/remote-control/channel-dispositions';

const mockOpenExternal = jest.fn<Promise<void>, [string]>(() =>
  Promise.resolve(),
);
jest.mock('../../lib/open-external', () => ({
  openExternalGuarded: (url: string): Promise<void> => mockOpenExternal(url),
}));

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
const mockHandlers = new Map<string, Handler>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    mockHandlers.set(channel, handler);
  },
}));
jest.mock('../feature-flag', () => ({
  assertCursorHarnessEnabled: (): void => undefined,
}));
const mockInvalidateUsage = jest.fn();
jest.mock('../../observability', () => ({
  getObservabilityService: (): object => ({
    invalidateCursorUsage: mockInvalidateUsage,
    refreshProviderUsage: jest.fn(),
  }),
}));
const mockBroadcast = jest.fn();
jest.mock('../../models/model-registry', () => ({
  broadcastModelRegistryUpdated: (): void => {
    mockBroadcast();
  },
}));
jest.mock('../runtime-availability', () => ({
  probeCursorRuntimeStatus: jest.fn(),
  refreshCursorRuntimeAvailability: jest.fn(),
}));
jest.mock('../../remote-control/host/bridge-window', () => ({
  resolveRemoteBridgeSender: (): string => 'controller-device',
}));
const mockConnect = jest.fn();
const mockChangeAccount = jest.fn();
const mockReadAccount = jest.fn();
jest.mock('../connection', () => ({
  connectCursor: (...args: unknown[]): unknown => mockConnect(...args),
  changeCursorAccount: (...args: unknown[]): unknown =>
    mockChangeAccount(...args),
  readCursorAccount: (...args: unknown[]): unknown => mockReadAccount(...args),
}));
// The account probe follows a real window (CAN-6718 review case below).
jest.mock('electron', () => ({
  ...jest.requireActual<object>('electron'),
  BrowserWindow: { fromWebContents: (): object => ({}) },
}));

jest.mock('../../ipc/app-error-policy', () => ({
  ipcShowsRawErrorDetail: (): boolean => false,
}));

import { registerCursorConnectionHandlers } from '../../ipc/cursor-connection';
import { toIpcRejection } from '../../ipc/app-error-rejection';
import {
  assertCursorSignInReachable,
  cursorSignInLinkOpener,
  readCursorSignInOptions,
} from '../sign-in-link';

const LINK =
  'https://cursor.com/loginDeepControl?challenge=c&uuid=u&mode=login';

beforeEach(() => {
  mockOpenExternal.mockClear();
});

describe('Cursor sign-in link', () => {
  it('reaches the controller through tunneled connect, change account and progress', () => {
    expect(IPC_REMOTE_DISPOSITIONS.cursorConnectionConnect).toBe('tunnel');
    expect(IPC_REMOTE_DISPOSITIONS.cursorConnectionChangeAccount).toBe(
      'tunnel',
    );
    expect(IPC_REMOTE_DISPOSITIONS.cursorConnectionProgress).toBe('tunnel');
    const contract = JSON.parse(
      readFileSync(
        join(__dirname, '../../remote-control/remote-protocol-contract.json'),
        'utf8',
      ),
    ) as { tunneledChannels: string[] };
    expect(contract.tunneledChannels).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.cursorConnectionConnect,
        IPC_CHANNELS.cursorConnectionChangeAccount,
        IPC_CHANNELS.cursorConnectionProgress,
      ]),
    );
  });

  it('goes to the progress status, not this computer’s browser, for a remote sign-in', async () => {
    const present = jest.fn();
    await cursorSignInLinkOpener({ remote: true }, present)(LINK);
    expect(present).toHaveBeenCalledWith(LINK);
    expect(mockOpenExternal).not.toHaveBeenCalled();
  });

  it('opens this computer’s browser for a sign-in started here', async () => {
    const present = jest.fn();
    await cursorSignInLinkOpener({}, present)(LINK);
    expect(mockOpenExternal).toHaveBeenCalledWith(LINK);
    expect(present).not.toHaveBeenCalled();
  });

  // CAN-6718 review: an older controller ignores `signInUrl`, so a sign-in
  // it starts here could never finish, and Change account would first sign
  // this computer out. Only a controller whose app says it shows the link
  // may start one; the refusal runs before any read or sign-out.
  it('refuses a remote sign-in from an app that doesn’t show the link', () => {
    expect(readCursorSignInOptions(false, undefined)).toEqual({});
    expect(readCursorSignInOptions(false, { signInLink: true })).toEqual({});
    expect(readCursorSignInOptions(true, undefined)).toEqual({ remote: true });
    expect(readCursorSignInOptions(true, { signInLink: 'yes' })).toEqual({
      remote: true,
    });
    expect(readCursorSignInOptions(true, { signInLink: true })).toEqual({
      remote: true,
      showsLink: true,
    });
    expect(() => assertCursorSignInReachable({ remote: true })).toThrow(
      'Update the app on the computer you are using to sign in to Cursor from it.',
    );
    expect(() =>
      assertCursorSignInReachable({ remote: true, showsLink: true }),
    ).not.toThrow();
    expect(() => assertCursorSignInReachable({})).not.toThrow();
  });

  it('is told the app shows the link by the preload’s Connect and Change account', () => {
    const preload = readFileSync(
      join(__dirname, '../../../preload/index.ts'),
      'utf8',
    );
    expect(preload).toContain(
      'const CURSOR_CLIENT: CursorSignInClient = { signInLink: true };',
    );
    expect(preload).toMatch(
      /invoke\(IPC_CHANNELS\.cursorConnectionConnect, CURSOR_CLIENT\)/u,
    );
    expect(preload).toMatch(
      /IPC_CHANNELS\.cursorConnectionChangeAccount,\s+intent,\s+CURSOR_CLIENT,/u,
    );
  });

  // CAN-6718 review: Connect from an older controller is refused before it
  // claims the setup slot, clears the catalog, installs or probes anything.
  it('refuses a remote Connect or Change account from an older app before any setup', async () => {
    registerCursorConnectionHandlers();
    const sender = { id: 7, isDestroyed: (): boolean => false };
    for (const [channel, args] of [
      [IPC_CHANNELS.cursorConnectionConnect, []],
      [IPC_CHANNELS.cursorConnectionChangeAccount, ['change']],
    ] as const) {
      const handler = mockHandlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      await expect(handler({ sender }, ...args)).rejects.toThrow(
        'Update the app on the computer you are using to sign in to Cursor from it.',
      );
    }
    expect(mockInvalidateUsage).not.toHaveBeenCalled();
    expect(mockBroadcast).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockChangeAccount).not.toHaveBeenCalled();
  });

  // CAN-6718 review: stable builds replace a thrown error's text with
  // generic copy; this fixed refusal keeps its words on both channels, so
  // an older controller tells the person what to do.
  it('keeps the update instruction through the stable IPC error policy', () => {
    const refusal = (): Error => {
      try {
        assertCursorSignInReachable({ remote: true });
      } catch (error) {
        if (error instanceof Error) return error;
      }
      throw new Error('expected a refusal');
    };
    // The rejection's message is the IPC envelope; `legacy` is the text a
    // renderer (and an older controller) shows.
    const legacyText = (rejection: Error): unknown => {
      const envelope: unknown = JSON.parse(rejection.message);
      return typeof envelope === 'object' &&
        envelope !== null &&
        'legacy' in envelope
        ? envelope.legacy
        : undefined;
    };
    for (const channel of [
      IPC_CHANNELS.cursorConnectionConnect,
      IPC_CHANNELS.cursorConnectionChangeAccount,
    ])
      expect(legacyText(toIpcRejection(channel, refusal()))).toBe(
        'Error: Update the app on the computer you are using to sign in to Cursor from it.',
      );
    // Another failure on the same channel still gets catalog copy.
    expect(
      legacyText(
        toIpcRejection(
          IPC_CHANNELS.cursorConnectionConnect,
          new Error('/home/someone/private detail'),
        ),
      ),
    ).not.toContain('private detail');
  });

  // CAN-6718 review: Cursor's account probe verifies the whole runtime on a
  // cache miss, on the queue local launches use. Probes that overlap, as a
  // paired browser can send, share one read instead of queueing one each.
  it('shares one account read between overlapping probes', async () => {
    registerCursorConnectionHandlers();
    const handler = mockHandlers.get(IPC_CHANNELS.cursorConnectionAccount);
    if (!handler) throw new Error('no account handler');
    const account = { email: 'person@example.com' };
    let answer: (value: unknown) => void = () => undefined;
    mockReadAccount.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const window = Object.assign(new EventEmitter(), {
      id: 11,
      mainFrame: {},
      isDestroyed: (): boolean => false,
    });
    const probes = [1, 2, 3, 4].map(() =>
      Promise.resolve(
        handler({ sender: window, senderFrame: window.mainFrame }),
      ),
    );
    for (let tick = 0; tick < 5; tick++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(mockReadAccount).toHaveBeenCalledTimes(1);
    answer(account);
    await expect(Promise.all(probes)).resolves.toEqual([
      account,
      account,
      account,
      account,
    ]);
    // A later probe reads again.
    mockReadAccount.mockResolvedValueOnce(null);
    await expect(
      Promise.resolve(
        handler({ sender: window, senderFrame: window.mainFrame }),
      ),
    ).resolves.toBeNull();
    expect(mockReadAccount).toHaveBeenCalledTimes(2);
  });

  // CAN-6718 review: a shared account read belongs to no one window. A
  // window that goes away stops only its own wait; the read is cancelled
  // only once every window waiting on it has gone.
  it('keeps a shared account read for the windows still waiting on it', async () => {
    registerCursorConnectionHandlers();
    const handler = mockHandlers.get(IPC_CHANNELS.cursorConnectionAccount);
    if (!handler) throw new Error('no account handler');
    const account = { email: 'person@example.com' };
    let answer: (value: unknown) => void = () => undefined;
    const signals: AbortSignal[] = [];
    mockReadAccount.mockReset().mockImplementation(
      (signal: AbortSignal) =>
        new Promise((resolve) => {
          signals.push(signal);
          answer = resolve;
        }),
    );
    const windowOf = (id: number): EventEmitter & { id: number } =>
      Object.assign(new EventEmitter(), {
        id,
        mainFrame: {},
        isDestroyed: (): boolean => false,
      });
    const first = windowOf(21);
    const second = windowOf(22);
    const ask = (window: EventEmitter & { id: number }): Promise<unknown> =>
      new Promise((resolve) =>
        resolve(
          handler({
            sender: window,
            senderFrame: (window as unknown as { mainFrame: object }).mainFrame,
          }),
        ),
      );
    const firstProbe = ask(first);
    const secondProbe = ask(second);
    for (let tick = 0; tick < 5; tick++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(mockReadAccount).toHaveBeenCalledTimes(1);
    first.emit('destroyed');
    await expect(firstProbe).rejects.toThrow();
    expect(signals[0]?.aborted).toBe(false);
    answer(account);
    await expect(secondProbe).resolves.toEqual(account);
    // Once every waiting window has gone, the read is cancelled.
    const third = windowOf(23);
    const lastProbe = ask(third);
    for (let tick = 0; tick < 5; tick++)
      await new Promise((resolve) => setImmediate(resolve));
    third.emit('destroyed');
    await expect(lastProbe).rejects.toThrow();
    expect(signals[1]?.aborted).toBe(true);
  });
});
