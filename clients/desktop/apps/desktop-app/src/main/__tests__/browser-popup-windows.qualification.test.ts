/**
 * CAN-6497: the native popup window host adapter for in-app browser tabs.
 * Cited by behavior-inventory/CAN-6497-browser-popup-window.yaml. Electron
 * is faked; the guest, BaseWindow and WebContentsView stand in for the real
 * ones so the adapter's hosting, guards and lifecycle run without an app.
 */
import { EventEmitter } from 'node:events';
import type { Rectangle } from 'electron';

const mockRegistry = new Map<number, MockContents>();
class MockContents extends EventEmitter {
  destroyed = false;
  url = 'about:blank';
  title = '';
  ua = 'Mozilla/5.0 Chrome/156 Electron/45.3.3 Safari/537.36';
  openHandler: ((d: { url: string }) => unknown) | undefined;
  closeCalls = 0;
  session = new EventEmitter();
  constructor(readonly id: number) {
    super();
    mockRegistry.set(id, this);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getUserAgent(): string {
    return this.ua;
  }
  setUserAgent(ua: string): void {
    this.ua = ua;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  setWindowOpenHandler(h: (d: { url: string }) => unknown): void {
    this.openHandler = h;
  }
  close(): void {
    this.closeCalls += 1;
    if (this.destroyed || this.stuck) return;
    this.destroyed = true;
    this.emit('destroyed');
  }
  stuck = false;
}
const mockWindows: MockWindow[] = [];
class MockWindow extends EventEmitter {
  destroyed = false;
  shown = '';
  title = '';
  contentView: unknown;
  constructor(readonly options: Record<string, unknown>) {
    super();
    if (mockFailNextWindow) {
      mockFailNextWindow = false;
      throw new Error('boom');
    }
    mockWindows.push(this);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
  }
  setContentView(v: unknown): void {
    this.contentView = v;
  }
  show(): void {
    this.shown = 'show';
  }
  showInactive(): void {
    this.shown = 'inactive';
  }
  setTitle(t: string): void {
    this.title = t;
  }
  removeMenu(): void {}
}
let mockFailNextWindow = false;
const mockSession = {
  ua: 'Mozilla/5.0 Chrome/156 Electron/45.3.3 Safari/537.36',
  getUserAgent(): string {
    return this.ua;
  },
  setUserAgent(u: string): void {
    this.ua = u;
  },
};
const mockDefaultSession = {
  ua: 'App Electron/45.3.3',
  set: [] as string[],
  getUserAgent(): string {
    return this.ua;
  },
  setUserAgent(u: string): void {
    this.set.push(u);
    this.ua = u;
  },
};
const mockApp = {
  userAgentFallback: 'Mozilla/5.0 Chrome/156 Electron/45.3.3 Safari/537.36',
};

jest.mock('electron', () => ({
  app: {
    get userAgentFallback(): string {
      return mockApp.userAgentFallback;
    },
    set userAgentFallback(v: string) {
      mockApp.userAgentFallback = v;
    },
  },
  session: {
    get defaultSession(): typeof mockDefaultSession {
      return mockDefaultSession;
    },
  },
  webContents: {
    fromId: (id: number): MockContents | undefined => mockRegistry.get(id),
  },
  BaseWindow: function BaseWindow(o: Record<string, unknown>): MockWindow {
    return new MockWindow(o);
  },
  WebContentsView: function WebContentsView(): object {
    return {};
  },
  screen: {
    getDisplayMatching: (): { workArea: Rectangle } => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
    getPrimaryDisplay: (): { workArea: Rectangle } => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
}));
jest.mock('../lib/main-window-focus', () => ({
  mayTakeForeground: (): boolean => false,
}));
jest.mock('../lib/ui-automation-window', () => ({
  shouldShowUiAutomationWindow: (): boolean => true,
}));
jest.mock('../lib/web-contents-send', () => ({
  registerIpcSurface: jest.fn(),
}));

import { BrowserPopupWindows } from '../browser/browser-popup-windows';
import {
  useBrowserUserAgent,
  withoutElectronUserAgentToken,
} from '../browser/browser-user-agent';

/** Stands in for a window an open did not build. */
const NO_WINDOW = new MockWindow({});
let nextId = 100;
function nestedOpen(guest: MockContents, details: { url: string }): unknown {
  if (!guest.openHandler) throw new Error('No window-open handler installed.');
  return guest.openHandler(details);
}
type PopupOptions = ConstructorParameters<typeof BrowserPopupWindows>[0];
interface Opened {
  guest: MockContents;
  returned: unknown;
  /** The window this open built, or a detached stand-in when it built none. */
  window: MockWindow;
}
interface Harness {
  popups: BrowserPopupWindows;
  live: Set<string>;
  warn: jest.Mock;
  requestPopupTab: jest.Mock;
  openExternal: jest.Mock;
  open: (browserId: string, options?: Record<string, unknown>) => Opened;
}
function setup(over: Partial<PopupOptions> = {}): Harness {
  const live = new Set(['tab-1', 'tab-2']);
  const warn = jest.fn();
  const requestPopupTab = jest.fn();
  const openExternal = jest.fn((): Promise<void> => Promise.resolve());
  const host = {
    isDestroyed: (): boolean => false,
    getBounds: (): Rectangle => ({ x: 100, y: 100, width: 1000, height: 700 }),
  };
  const popups = new BrowserPopupWindows({
    isUrlAllowedInApp: (url): boolean =>
      /^(https?:|about:blank)/.test(url) && !url.includes('remote.example'),
    openUrlExternally: openExternal,
    requestPopupTab,
    warn,
    hostWindowFor: (): never => host as never,
    isOpenerLive: (id): boolean => live.has(id),
    ...over,
  });
  const open = (
    browserId: string,
    options: Record<string, unknown> = {},
  ): Opened => {
    const before = mockWindows.length;
    const guest = new MockContents(nextId++);
    const response = popups.windowOpenResponse(browserId);
    if (response.action !== 'allow' || !response.createWindow)
      throw new Error('not allow');
    const returned = response.createWindow({
      webContents: guest,
      ...options,
    } as never);
    return {
      guest,
      returned,
      window:
        mockWindows.length > before
          ? (mockWindows.at(-1) ?? NO_WINDOW)
          : NO_WINDOW,
    };
  };
  return { popups, live, warn, requestPopupTab, openExternal, open };
}

beforeEach(() => {
  mockWindows.length = 0;
});

describe('BrowserPopupWindows', () => {
  it('allows with a sandboxed, preload-free, same-session guest', () => {
    const { popups } = setup();
    const r = popups.windowOpenResponse('tab-1');
    expect(r.action).toBe('allow');
    const prefs =
      r.action === 'allow'
        ? r.overrideBrowserWindowOptions?.webPreferences
        : undefined;
    expect(prefs).toMatchObject({
      preload: undefined,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    });
    expect(prefs && 'partition' in prefs).toBe(false);
  });

  it('hosts the guest, strips the UA, ignores page features, shows inactive', () => {
    const { open, popups } = setup();
    const { guest, returned, window } = open('tab-1', {
      width: 480,
      height: 360,
      frame: false,
      alwaysOnTop: true,
    });
    expect(returned).toBe(guest);
    expect(guest.ua).not.toContain('Electron/');
    expect(window.options).toMatchObject({
      width: 480,
      height: 360,
      show: false,
    });
    expect(window.options.frame).toBeUndefined();
    expect(window.options.alwaysOnTop).toBeUndefined();
    expect(window.shown).toBe('inactive');
    expect(popups.openerFor(guest.id)).toBe('tab-1');
  });

  it('bounds: defaults centered on host, minimum, clamp, page position kept', () => {
    const { open } = setup();
    expect(open('tab-1').window.options).toMatchObject({
      width: 500,
      height: 600,
      x: 350,
      y: 150,
    });
    expect(
      open('tab-1', { width: 10, height: Number.NaN }).window.options,
    ).toMatchObject({ width: 240, height: 600 });
    expect(
      open('tab-2', { width: 5000, height: 5000, x: 9000, y: -50 }).window
        .options,
    ).toMatchObject({ width: 1440, height: 900, x: 0, y: 0 });
    expect(
      open('tab-2', { x: 20, y: 30, width: 300, height: 300 }).window.options,
    ).toMatchObject({ x: 20, y: 30 });
  });

  it('null host window: primary display, no parent', () => {
    const { open } = setup({ hostWindowFor: () => null });
    const { window } = open('tab-1');
    expect(window.options.parent).toBeUndefined();
    expect(window.options).toMatchObject({ x: 470, y: 150 });
  });

  it('opener gone or closing: guest closed, no window, untracked', async () => {
    const { open, live, popups, warn } = setup();
    live.delete('tab-1');
    const { guest } = open('tab-1');
    expect(guest.destroyed).toBe(true);
    expect(mockWindows).toHaveLength(0);
    expect(popups.openerFor(guest.id)).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const first = open('tab-2');
    first.guest.stuck = true;
    jest.useFakeTimers();
    const closing = popups.closeFor('tab-2');
    const late = open('tab-2');
    expect(late.guest.destroyed).toBe(true);
    jest.advanceTimersByTime(2100);
    await closing;
    jest.useRealTimers();
  });

  it('window build failure: guest closed, untracked, no throw', () => {
    const { open, popups } = setup();
    mockFailNextWindow = true;
    let result: ReturnType<typeof open> | undefined;
    expect(() => {
      result = open('tab-1');
    }).not.toThrow();
    expect(result?.guest.destroyed).toBe(true);
    expect(popups.hasRoomFor('tab-1')).toBe(true);
    expect(popups.openerFor(result?.guest.id ?? -1)).toBeUndefined();
  });

  it('cap of three per opener', () => {
    const { open, popups } = setup();
    open('tab-1');
    open('tab-1');
    expect(popups.hasRoomFor('tab-1')).toBe(true);
    open('tab-1');
    expect(popups.hasRoomFor('tab-1')).toBe(false);
    expect(popups.hasRoomFor('tab-2')).toBe(true);
  });

  it('lifecycle: guest destroyed closes window; window closed closes guest', () => {
    const { open, popups } = setup();
    const a = open('tab-1');
    a.guest.close();
    expect(a.window.destroyed).toBe(true);
    expect(popups.openerFor(a.guest.id)).toBeUndefined();
    const b = open('tab-1');
    b.window.destroy();
    expect(b.guest.destroyed).toBe(true);
  });

  it('nested opens route to tab, external, blocked, or dropped', () => {
    const { open, requestPopupTab, openExternal, warn, live } = setup();
    const { guest } = open('tab-1');
    expect(nestedOpen(guest, { url: 'https://ok.test/x' })).toEqual({
      action: 'deny',
    });
    expect(requestPopupTab).toHaveBeenCalledWith('tab-1', 'https://ok.test/x');
    nestedOpen(guest, { url: 'mailto:a@b.c' });
    expect(openExternal).toHaveBeenCalledWith('mailto:a@b.c');
    nestedOpen(guest, { url: 'file:///etc/passwd' });
    expect(warn).toHaveBeenCalledWith(
      'tab-1',
      'A web page cannot navigate directly to a local file.',
    );
    live.delete('tab-1');
    nestedOpen(guest, { url: 'https://ok.test/y' });
    expect(requestPopupTab).toHaveBeenCalledTimes(1);
  });

  it('navigation guards: file blocked, remote under local-only external, blank popup closed', async () => {
    const { open, openExternal, warn } = setup();
    const { guest } = open('tab-1');
    const ev = (url: string): { url: string; preventDefault: jest.Mock } => ({
      url,
      preventDefault: jest.fn(),
    });
    const ok = ev('https://ok.test/');
    guest.emit('will-navigate', ok);
    expect(ok.preventDefault).not.toHaveBeenCalled();
    const file = ev('file:///x');
    guest.emit('will-redirect', file);
    expect(file.preventDefault).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'tab-1',
      'A web page cannot navigate directly to a local file.',
    );
    const remote = ev('https://remote.example/');
    guest.emit('will-redirect', remote);
    expect(remote.preventDefault).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith('https://remote.example/');
    await new Promise((r) => setImmediate(r));
    expect(guest.destroyed).toBe(true);
  });

  it('a committed popup is not closed by a diverted navigation', async () => {
    const { open } = setup();
    const { guest } = open('tab-1');
    guest.url = 'https://ok.test/';
    guest.emit('did-navigate', {}, 'https://ok.test/');
    guest.emit('will-navigate', {
      url: 'mailto:x@y.z',
      preventDefault: jest.fn(),
    });
    await new Promise((r) => setImmediate(r));
    expect(guest.destroyed).toBe(false);
  });

  it('title: hostname first, hostname only, brand on about:blank', () => {
    const { open } = setup();
    const { guest, window } = open('tab-1');
    guest.emit('page-title-updated');
    expect(window.title).not.toBe('');
    expect(window.title).not.toContain('about:blank');
    guest.url = 'https://accounts.example.com/signin';
    guest.title = 'accounts.example.com/signin';
    guest.emit('did-navigate', {}, guest.url);
    expect(window.title).toBe('accounts.example.com');
    guest.title = 'Sign in - Google Accounts';
    guest.emit('page-title-updated');
    expect(window.title).toBe(
      'accounts.example.com — Sign in - Google Accounts',
    );
  });

  it('Cmd/Ctrl+W closes only the popup', () => {
    const { open } = setup();
    const { guest } = open('tab-1');
    const mac = process.platform === 'darwin';
    const event = { preventDefault: jest.fn() };
    guest.emit('before-input-event', event, {
      type: 'keyDown',
      key: 'w',
      meta: mac,
      control: !mac,
      alt: false,
      shift: false,
    });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(guest.destroyed).toBe(true);
  });

  it('closeFor resolves after guests close, at once with none, on timeout, never rejects', async () => {
    const { open, popups, warn } = setup();
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    await expect(popups.closeFor('tab-2')).resolves.toBeUndefined();
    // No popups: no close timer.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
    const a = open('tab-1');
    const b = open('tab-1');
    await popups.closeFor('tab-1');
    expect(a.guest.destroyed && b.guest.destroyed).toBe(true);
    expect(a.window.destroyed).toBe(true);
    const c = open('tab-1');
    c.guest.stuck = true;
    jest.useFakeTimers();
    const p = popups.closeFor('tab-1');
    jest.advanceTimersByTime(2100);
    await expect(p).resolves.toBeUndefined();
    jest.useRealTimers();
    expect(c.window.destroyed).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  it('download from a blank popup closes it; opener mapping', async () => {
    const { open, popups } = setup();
    const { guest } = open('tab-1');
    expect(popups.openerFor(guest.id)).toBe('tab-1');
    guest.session.emit('will-download', {}, {}, { id: guest.id + 1 });
    await new Promise((r) => setImmediate(r));
    expect(guest.destroyed).toBe(false);
    guest.session.emit('will-download', {}, {}, guest);
    await new Promise((r) => setImmediate(r));
    expect(guest.destroyed).toBe(true);
    expect(popups.openerFor(guest.id)).toBeUndefined();
  });
});

describe('useBrowserUserAgent', () => {
  it('strips the token, pins the app session, strips the fallback, idempotent', () => {
    expect(withoutElectronUserAgentToken('A Electron/1.2.3 B')).toBe('A B');
    useBrowserUserAgent(mockSession as never);
    expect(mockSession.ua).not.toContain('Electron/');
    expect(mockApp.userAgentFallback).not.toContain('Electron/');
    expect(mockDefaultSession.set).toEqual(['App Electron/45.3.3']);
    const once = mockSession.ua;
    useBrowserUserAgent(mockSession as never);
    expect(mockSession.ua).toBe(once);
    expect(mockDefaultSession.set).toHaveLength(1);
  });
});
