import { EventEmitter } from 'node:events';
import type { BrowserWindowConstructorOptions } from 'electron';

const mockRuntimeState: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
} = {
  isPackaged: true,
  platform: 'linux',
};

class MockWebContents extends EventEmitter {
  readonly session = {
    setPermissionRequestHandler: jest.fn(),
  };

  readonly setWindowOpenHandler = jest.fn();

  isDestroyed(): boolean {
    return false;
  }
}

class MockBrowserWindow extends EventEmitter {
  readonly options: BrowserWindowConstructorOptions;
  readonly webContents = new MockWebContents();
  readonly show = jest.fn();
  readonly focus = jest.fn();
  readonly restore = jest.fn();

  minimized = false;

  constructor(options: BrowserWindowConstructorOptions) {
    super();
    this.options = options;
    createdWindows.push(this);
  }

  isMinimized(): boolean {
    return this.minimized;
  }

  isDestroyed(): boolean {
    return false;
  }
}

const createdWindows: MockBrowserWindow[] = [];

jest.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return mockRuntimeState.isPackaged;
    },
  },
  BrowserWindow: function BrowserWindow(
    options: BrowserWindowConstructorOptions,
  ): MockBrowserWindow {
    return new MockBrowserWindow(options);
  },
  dialog: {
    showOpenDialog: jest.fn(),
  },
  shell: {
    openExternal: jest.fn(),
  },
}));

jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): NodeJS.Platform => mockRuntimeState.platform,
}));

jest.mock('../../../lib/e2e-gate', () => ({
  isE2eBuild: jest.fn(() => false),
}));

import { isE2eBuild } from '../../../lib/e2e-gate';
import {
  getUiAutomationWindowWebPreferences,
  isHeadlessUiAutomationLaunch,
  shouldShowUiAutomationWindow,
} from '../../../lib/ui-automation-window';
import { RemoteMachineWindows, type RemoteWindowHost } from '../remote-windows';

const HOST: RemoteWindowHost = {
  deviceId: 'host-device-1',
  name: 'Workstation',
  platform: 'linux',
};

function makeRemoteWindows(keepHidden?: () => boolean): RemoteMachineWindows {
  return new RemoteMachineWindows({
    preloadPath: '/preload/index.js',
    title: (host) => `${host.name} — Canopy`,
    baseWindowOptions: () => ({
      minWidth: 800,
      minHeight: 500,
      webPreferences: { spellcheck: true },
    }),
    loadRenderer: () => Promise.resolve(),
    getMainWindow: () => null,
    showLocalWindow: () => undefined,
    isAllowedNavigation: () => false,
    onClosed: () => undefined,
    onAppAdvisorStateChanged: () => undefined,
    ...(keepHidden ? { keepHidden } : {}),
  });
}

describe('RemoteMachineWindows headless automation guard (CAN-7899)', () => {
  let savedShowWindow: string | undefined;
  let savedIsolatedLogging: string | undefined;
  let savedOffscreenWindow: string | undefined;

  beforeEach(() => {
    createdWindows.length = 0;
    mockRuntimeState.isPackaged = true;
    mockRuntimeState.platform = 'linux';
    jest.mocked(isE2eBuild).mockReturnValue(false);
    savedShowWindow = process.env.CANOPY_E2E_SHOW_WINDOW;
    savedIsolatedLogging = process.env.CANOPY_E2E_ISOLATED_LOGGING;
    savedOffscreenWindow = process.env.CANOPY_E2E_OFFSCREEN_WINDOW;
    delete process.env.CANOPY_E2E_SHOW_WINDOW;
    delete process.env.CANOPY_E2E_ISOLATED_LOGGING;
    delete process.env.CANOPY_E2E_OFFSCREEN_WINDOW;
  });

  afterEach(() => {
    if (savedShowWindow === undefined) {
      delete process.env.CANOPY_E2E_SHOW_WINDOW;
    } else {
      process.env.CANOPY_E2E_SHOW_WINDOW = savedShowWindow;
    }
    if (savedIsolatedLogging === undefined) {
      delete process.env.CANOPY_E2E_ISOLATED_LOGGING;
    } else {
      process.env.CANOPY_E2E_ISOLATED_LOGGING = savedIsolatedLogging;
    }
    if (savedOffscreenWindow === undefined) {
      delete process.env.CANOPY_E2E_OFFSCREEN_WINDOW;
    } else {
      process.env.CANOPY_E2E_OFFSCREEN_WINDOW = savedOffscreenWindow;
    }
  });

  it('keeps UI automation window overrides inert in packaged, dev, and headed launches', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      mockRuntimeState.platform = platform;
      mockRuntimeState.isPackaged = true;
      jest.mocked(isE2eBuild).mockReturnValue(false);
      process.env.CANOPY_E2E_ISOLATED_LOGGING = '1';
      process.env.CANOPY_E2E_OFFSCREEN_WINDOW = '1';

      expect(isHeadlessUiAutomationLaunch(false, true, process.env)).toBe(
        false,
      );
      expect(shouldShowUiAutomationWindow()).toBe(true);
      expect(getUiAutomationWindowWebPreferences()).toEqual({});

      createdWindows.length = 0;
      const windows = makeRemoteWindows(() => !shouldShowUiAutomationWindow());
      windows.open(HOST);
      expect(createdWindows).toHaveLength(1);
      expect(
        createdWindows[0].options.webPreferences?.offscreen,
      ).toBeUndefined();
    }

    mockRuntimeState.platform = 'linux';
    mockRuntimeState.isPackaged = false;
    delete process.env.CANOPY_E2E_ISOLATED_LOGGING;
    delete process.env.CANOPY_E2E_OFFSCREEN_WINDOW;
    expect(shouldShowUiAutomationWindow()).toBe(true);
    expect(getUiAutomationWindowWebPreferences()).toEqual({});

    jest.mocked(isE2eBuild).mockReturnValue(true);
    process.env.CANOPY_E2E_SHOW_WINDOW = '1';
    process.env.CANOPY_E2E_OFFSCREEN_WINDOW = '1';
    expect(shouldShowUiAutomationWindow()).toBe(true);
    expect(getUiAutomationWindowWebPreferences()).toEqual({});

    createdWindows.length = 0;
    const headedWindows = makeRemoteWindows(
      () => !shouldShowUiAutomationWindow(),
    );
    headedWindows.open(HOST);
    expect(createdWindows).toHaveLength(1);
    expect(createdWindows[0].options.webPreferences?.offscreen).toBeUndefined();
  });

  it('shows and focuses the remote window normally in a non-automation launch', () => {
    for (const keepHidden of [
      undefined,
      (): boolean => !shouldShowUiAutomationWindow(),
    ]) {
      createdWindows.length = 0;
      const windows = makeRemoteWindows(keepHidden);

      windows.open(HOST);
      expect(createdWindows).toHaveLength(1);
      const [win] = createdWindows;
      expect(win.options.show).toBe(false);
      expect(win.options.webPreferences?.offscreen).toBeUndefined();

      expect(win.show).not.toHaveBeenCalled();
      win.emit('ready-to-show');
      expect(win.show).toHaveBeenCalledTimes(1);

      windows.open(HOST);
      expect(win.restore).not.toHaveBeenCalled();
      expect(win.show).toHaveBeenCalledTimes(2);
      expect(win.focus).toHaveBeenCalledTimes(1);

      win.minimized = true;
      windows.open(HOST);
      expect(win.restore).toHaveBeenCalledTimes(1);
      expect(win.show).toHaveBeenCalledTimes(3);
      expect(win.focus).toHaveBeenCalledTimes(2);
    }
  });

  it('keeps the remote window hidden and enables offscreen rendering during headless automation', () => {
    mockRuntimeState.isPackaged = false;
    mockRuntimeState.platform = 'linux';
    jest.mocked(isE2eBuild).mockReturnValue(true);

    const linuxWindows = makeRemoteWindows(
      () => !shouldShowUiAutomationWindow(),
    );
    linuxWindows.open(HOST);
    expect(createdWindows).toHaveLength(1);
    const [linuxWin] = createdWindows;
    expect(linuxWin.options.show).toBe(false);
    expect(linuxWin.options.webPreferences?.offscreen).toBe(true);

    linuxWin.emit('ready-to-show');
    expect(linuxWin.show).not.toHaveBeenCalled();

    linuxWin.minimized = true;
    linuxWindows.open(HOST);
    expect(linuxWin.restore).not.toHaveBeenCalled();
    expect(linuxWin.show).not.toHaveBeenCalled();
    expect(linuxWin.focus).not.toHaveBeenCalled();

    // Windows opts into offscreen rendering only with CANOPY_E2E_OFFSCREEN_WINDOW=1.
    createdWindows.length = 0;
    mockRuntimeState.platform = 'win32';
    makeRemoteWindows(() => !shouldShowUiAutomationWindow()).open(HOST);
    expect(createdWindows[0].options.webPreferences?.offscreen).toBeUndefined();

    createdWindows.length = 0;
    process.env.CANOPY_E2E_OFFSCREEN_WINDOW = '1';
    makeRemoteWindows(() => !shouldShowUiAutomationWindow()).open(HOST);
    expect(createdWindows[0].options.webPreferences?.offscreen).toBe(true);

    // macOS never sets offscreen rendering.
    createdWindows.length = 0;
    mockRuntimeState.platform = 'darwin';
    makeRemoteWindows(() => !shouldShowUiAutomationWindow()).open(HOST);
    expect(createdWindows[0].options.webPreferences?.offscreen).toBeUndefined();
  });
});
