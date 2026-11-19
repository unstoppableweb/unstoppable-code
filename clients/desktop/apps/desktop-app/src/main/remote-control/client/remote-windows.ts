import { randomUUID } from 'node:crypto';
import {
  BrowserWindow,
  dialog,
  shell,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from 'electron';
import {
  IPC_CHANNELS,
  type RemotePathPickerRequest,
  type RemotePathPickerResponse,
} from '@canopy/desktop-shared/types';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { isVoiceDictationPlatform } from '@canopy/desktop-shared/platform-capabilities';
import { encodeRemoteWindowArgument } from '@canopy/desktop-shared/remote-control/window-context';
import type { DevicePlatform } from '@canopy/protocol/device-relay';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import type {
  AppAdvisorWindowParams,
  AppAdvisorWindowStateParams,
  DialogOpenParams,
  DialogOpenResult,
} from '../remote-protocol';
import { RpcPublicError } from '../transport/rpc-peer';
import { uploadLocalFiles } from './upload-local-files';
import {
  sendToWebContents,
  sendWrappedToWebContents,
} from '../../lib/web-contents-send';
import { primaryWindowFocus } from '../../lib/window-focus-recency';

/** The paired computer a window shows. */
export interface RemoteWindowHost {
  deviceId: string;
  name: string;
  platform: DevicePlatform;
}

/** Window-side effects on the controlling computer. */
export interface RemoteControlWindows {
  /** Opens or focuses the window that shows a paired computer. */
  open(host: RemoteWindowHost): void;
  close(deviceId: string): void;
  focusLocal(): void;
  /** `surface` absent: every window that shows the computer. */
  deliverPush(
    deviceId: string,
    channel: string,
    args: unknown[],
    surface?: RemoteSurface,
  ): void;
  /** Reloads a computer's windows after its session was re-established. */
  reload(deviceId: string): void;
  /**
   * Shows, creates hidden, or hides the App Advisor window for a computer
   * whose window is open.
   */
  appAdvisorWindow(
    deviceId: string,
    params: AppAdvisorWindowParams,
  ): Promise<AppAdvisorWindowStateParams>;
  showDialog(
    deviceId: string,
    params: DialogOpenParams,
    upload: (fileName: string, bytes: Uint8Array) => Promise<string>,
  ): Promise<DialogOpenResult>;
}

export interface RemoteWindowsOptions {
  preloadPath: string;
  title: (host: RemoteWindowHost, surface: RemoteSurface) => string;
  /** Shared main-window chrome (title bar style, background, zoom). */
  baseWindowOptions: () => BrowserWindowConstructorOptions;
  loadRenderer: (
    window: BrowserWindow,
    surface: RemoteSurface,
  ) => Promise<void>;
  getMainWindow: () => BrowserWindow | null;
  /** Shows this computer's main window, recreating it when it was closed. */
  showLocalWindow: () => void;
  isAllowedNavigation: (url: string) => boolean;
  onClosed: (deviceId: string) => void;
  /** A computer's App Advisor window opened, closed, or changed focus. */
  onAppAdvisorStateChanged: (
    deviceId: string,
    state: AppAdvisorWindowStateParams,
  ) => void;
  /** Whether automation keeps windows hidden (E2E and headless runs). */
  keepHidden?: () => boolean;
  /** Whether the app is quitting, when closing must not be turned into hiding. */
  isQuitting?: () => boolean;
  /** Called with each window right after it is created. */
  onWindowCreated?: (window: BrowserWindow) => void;
}

interface AppAdvisorWindowRecord {
  window: BrowserWindow;
  /** Its page subscribed to pushes; until then they are held. */
  ready: boolean;
  held: Array<{ channel: string; args: unknown[] }>;
}

/** Pushes held for an App Advisor window still loading, oldest dropped. */
const MAX_HELD_PUSHES = 2_000;

interface PendingPicker {
  deviceId: string;
  resolve: (path: string | null) => void;
}

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function remoteWindowPartition(deviceId: string): string {
  return `persist:canopy-remote-${deviceId}`;
}

/**
 * A partition starts with Electron's permissive defaults. Match the main
 * window: microphone only (voice dictation runs on this computer), and only
 * where the app supports it.
 */
function restrictRemoteWindowPermissions(window: BrowserWindow): void {
  window.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const mediaTypes =
        'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
      const platform = hostPlatformOperatingSystem();
      callback(
        isVoiceDictationPlatform(platform) &&
          permission === 'media' &&
          mediaTypes.length > 0 &&
          mediaTypes.every((type) => type === 'audio') &&
          // Linux has no system microphone permission behind this one, so
          // only the window's own page may ask, not a frame inside it.
          (platform !== 'linux' || details.isMainFrame),
      );
    },
  );
}

function openExternalIfSafe(url: string): void {
  try {
    if (SAFE_EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) {
      void shell.openExternal(url).catch(() => undefined);
    }
  } catch {
    // Malformed URL — do not open.
  }
}

/**
 * Windows on this computer that show a paired computer. Each runs the normal
 * renderer with the remote-routing preload; this class delivers that
 * computer's pushes to it and shows pickers for its file dialogs.
 */
export class RemoteMachineWindows implements RemoteControlWindows {
  private readonly windows = new Map<string, BrowserWindow>();
  private readonly hosts = new Map<string, RemoteWindowHost>();
  private readonly appAdvisorWindows = new Map<
    string,
    AppAdvisorWindowRecord
  >();
  private readonly pickers = new Map<string, PendingPicker>();

  constructor(private readonly options: RemoteWindowsOptions) {}

  /** The computer and window behind a sender, if it shows one. */
  surfaceForSender(
    sender: WebContents,
  ): { deviceId: string; surface: RemoteSurface } | null {
    for (const [deviceId, window] of Array.from(this.windows)) {
      if (!window.isDestroyed() && window.webContents === sender) {
        return { deviceId, surface: 'main' };
      }
    }
    for (const [deviceId, record] of Array.from(this.appAdvisorWindows)) {
      if (
        !record.window.isDestroyed() &&
        record.window.webContents === sender
      ) {
        return { deviceId, surface: 'app-advisor' };
      }
    }
    return null;
  }

  deviceIdForSender(sender: WebContents): string | null {
    return this.surfaceForSender(sender)?.deviceId ?? null;
  }

  /** Open windows, oldest first. */
  liveWindows(): BrowserWindow[] {
    return Array.from(this.windows.values()).filter(
      (window) => !window.isDestroyed(),
    );
  }

  open(host: RemoteWindowHost): void {
    const existing = this.windows.get(host.deviceId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    this.hosts.set(host.deviceId, host);
    const window = this.createWindow(host, 'main');
    this.windows.set(host.deviceId, window);
    primaryWindowFocus.track(window);
    // Shown at first paint, as before. Its native background is visible only
    // in the strip a live resize exposes, and it follows the paired computer's
    // theme color as soon as this window's renderer publishes it.
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      if (this.windows.get(host.deviceId) === window) {
        this.windows.delete(host.deviceId);
      }
      for (const [requestId, picker] of Array.from(this.pickers)) {
        if (picker.deviceId !== host.deviceId) continue;
        this.pickers.delete(requestId);
        picker.resolve(null);
      }
      // App Advisor shows the same computer; it goes with its window.
      const appAdvisor = this.appAdvisorWindows.get(host.deviceId);
      this.appAdvisorWindows.delete(host.deviceId);
      if (appAdvisor && !appAdvisor.window.isDestroyed()) {
        appAdvisor.window.destroy();
      }
      this.options.onClosed(host.deviceId);
    });
    void this.options.loadRenderer(window, 'main').catch(() => undefined);
  }

  /**
   * App Advisor for a paired computer runs in its own window, like this
   * computer's App Advisor, and hides rather than closes.
   */
  appAdvisorWindow(
    deviceId: string,
    params: AppAdvisorWindowParams,
  ): Promise<AppAdvisorWindowStateParams> {
    const host = this.hosts.get(deviceId);
    const main = this.windows.get(deviceId);
    if (!host || !main || main.isDestroyed()) {
      return Promise.reject(
        new RpcPublicError('This computer is not showing that computer.'),
      );
    }
    if (params.action === 'focus_main') {
      if (this.options.keepHidden?.() !== true) {
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
      }
      return Promise.resolve(this.appAdvisorState(deviceId));
    }
    const existing = this.appAdvisorWindows.get(deviceId);
    if (params.action === 'close') {
      if (existing && !existing.window.isDestroyed()) existing.window.hide();
      return Promise.resolve(this.appAdvisorState(deviceId));
    }
    const record =
      existing && !existing.window.isDestroyed()
        ? existing
        : this.createAppAdvisorWindow(host);
    if (params.action === 'open' && this.options.keepHidden?.() !== true) {
      const window = record.window;
      if (window.isMinimized()) window.restore();
      if (params.background === true || params.focus === false) {
        if (!window.isVisible()) window.showInactive();
      } else {
        window.show();
        window.focus();
      }
    }
    return Promise.resolve(this.appAdvisorState(deviceId));
  }

  /**
   * The App Advisor window's page subscribed; held pushes go through. Its
   * state is reported again: after a reconnect the other computer starts
   * from a closed window, while this one may still be showing.
   */
  markAppAdvisorReady(deviceId: string): void {
    const record = this.appAdvisorWindows.get(deviceId);
    if (!record || record.window.isDestroyed()) return;
    record.ready = true;
    this.options.onAppAdvisorStateChanged(
      deviceId,
      this.appAdvisorState(deviceId),
    );
    const held = record.held.splice(0);
    for (const push of held) {
      this.sendPush(record.window, push.channel, push.args);
    }
  }

  private appAdvisorState(deviceId: string): AppAdvisorWindowStateParams {
    const window = this.appAdvisorWindows.get(deviceId)?.window;
    if (!window || window.isDestroyed()) return { open: false, focused: false };
    return { open: window.isVisible(), focused: window.isFocused() };
  }

  private createAppAdvisorWindow(
    host: RemoteWindowHost,
  ): AppAdvisorWindowRecord {
    const window = this.createWindow(host, 'app-advisor');
    const record: AppAdvisorWindowRecord = { window, ready: false, held: [] };
    this.appAdvisorWindows.set(host.deviceId, record);
    const report = (): void => {
      if (this.appAdvisorWindows.get(host.deviceId) !== record) return;
      this.options.onAppAdvisorStateChanged(
        host.deviceId,
        this.appAdvisorState(host.deviceId),
      );
    };
    window.on('show', report);
    window.on('hide', report);
    window.on('focus', report);
    window.on('blur', report);
    window.on('close', (event) => {
      if (this.options.isQuitting?.() === true) return;
      const main = this.windows.get(host.deviceId);
      if (!main || main.isDestroyed()) return;
      event.preventDefault();
      window.hide();
    });
    window.on('closed', () => {
      if (this.appAdvisorWindows.get(host.deviceId) === record) {
        this.appAdvisorWindows.delete(host.deviceId);
        this.options.onAppAdvisorStateChanged(host.deviceId, {
          open: false,
          focused: false,
        });
      }
    });
    // A reload subscribes again; hold pushes until it says it is ready.
    // `did-navigate` fires only once a main-frame, cross-document navigation
    // commits, so an iframe load or a navigation the guard cancels keeps the
    // page that already said it is ready.
    window.webContents.on('did-navigate', () => {
      record.ready = false;
    });
    void this.options
      .loadRenderer(window, 'app-advisor')
      .catch(() => undefined);
    return record;
  }

  private createWindow(
    host: RemoteWindowHost,
    surface: RemoteSurface,
  ): BrowserWindow {
    const base = this.options.baseWindowOptions();
    const mainBounds = this.options.getMainWindow()?.getBounds();
    // App Advisor shows the same paired computer as its main window, so it
    // starts on that window's native background, the paired computer's theme.
    const pairedMain =
      surface === 'app-advisor' ? this.windows.get(host.deviceId) : undefined;
    const window = new BrowserWindow({
      ...base,
      ...(pairedMain && !pairedMain.isDestroyed()
        ? { backgroundColor: pairedMain.getBackgroundColor() }
        : {}),
      ...(mainBounds
        ? {
            x: mainBounds.x + 24,
            y: mainBounds.y + 24,
            width: mainBounds.width,
            height: mainBounds.height,
          }
        : {}),
      show: false,
      title: this.options.title(host, surface),
      webPreferences: {
        ...base.webPreferences,
        preload: this.options.preloadPath,
        sandbox: false,
        contextIsolation: true,
        // Each paired computer gets its own storage, so renderer state kept in
        // localStorage or IndexedDB never mixes with this computer's windows
        // or another computer's.
        partition: remoteWindowPartition(host.deviceId),
        additionalArguments: [
          encodeRemoteWindowArgument({
            deviceId: host.deviceId,
            name: host.name,
            platform: host.platform,
            surface,
          }),
        ],
      },
    });
    restrictRemoteWindowPermissions(window);
    window.webContents.setWindowOpenHandler((details) => {
      openExternalIfSafe(details.url);
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => {
      if (this.options.isAllowedNavigation(url)) return;
      event.preventDefault();
      openExternalIfSafe(url);
    });
    window.on('page-title-updated', (event) => event.preventDefault());
    this.options.onWindowCreated?.(window);
    return window;
  }

  close(deviceId: string): void {
    const window = this.windows.get(deviceId);
    if (window && !window.isDestroyed()) window.close();
  }

  focusLocal(): void {
    this.options.showLocalWindow();
  }

  deliverPush(
    deviceId: string,
    channel: string,
    args: unknown[],
    surface?: RemoteSurface,
  ): void {
    if (surface !== 'app-advisor') {
      const window = this.windows.get(deviceId);
      if (window) this.sendPush(window, channel, args);
    }
    if (surface === 'main') return;
    const record = this.appAdvisorWindows.get(deviceId);
    if (!record || record.window.isDestroyed()) return;
    if (record.ready) {
      this.sendPush(record.window, channel, args);
      return;
    }
    record.held.push({ channel, args });
    if (record.held.length > MAX_HELD_PUSHES) record.held.shift();
  }

  private sendPush(
    window: BrowserWindow,
    channel: string,
    args: unknown[],
  ): void {
    if (window.isDestroyed() || window.webContents.isDestroyed()) return;
    sendWrappedToWebContents(
      window.webContents,
      IPC_CHANNELS.remoteControlPush,
      channel,
      args,
    );
  }

  reload(deviceId: string): void {
    const window = this.windows.get(deviceId);
    if (window && !window.isDestroyed()) window.webContents.reload();
    const appAdvisor = this.appAdvisorWindows.get(deviceId)?.window;
    if (appAdvisor && !appAdvisor.isDestroyed()) {
      appAdvisor.webContents.reload();
    }
  }

  resolvePicker(sender: WebContents, response: RemotePathPickerResponse): void {
    const deviceId = this.deviceIdForSender(sender);
    const picker = this.pickers.get(response.requestId);
    if (!picker || picker.deviceId !== deviceId) return;
    this.pickers.delete(response.requestId);
    picker.resolve(response.path);
  }

  async showDialog(
    deviceId: string,
    params: DialogOpenParams,
    upload: (fileName: string, bytes: Uint8Array) => Promise<string>,
  ): Promise<DialogOpenResult> {
    const window = this.windows.get(deviceId);
    if (!window || window.isDestroyed()) {
      return { canceled: true, filePaths: [] };
    }
    // Picking several files means attaching them: they come from this
    // computer's disk and are copied over. Anything else (a folder, an
    // executable, one document) is a path on the other computer.
    if (params.properties.includes('multiSelections')) {
      const result = await dialog.showOpenDialog(window, {
        title: params.title,
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, filePaths: [] };
      }
      return {
        canceled: false,
        filePaths: await uploadLocalFiles(result.filePaths, upload),
      };
    }
    const request: RemotePathPickerRequest = {
      requestId: randomUUID(),
      mode: params.properties.includes('openDirectory') ? 'directory' : 'file',
      title: params.title ?? 'Choose a location',
    };
    const path = await new Promise<string | null>((resolve) => {
      this.pickers.set(request.requestId, { deviceId, resolve });
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.remoteControlPathPickerRequest,
        request,
      );
      window.focus();
    });
    return path === null
      ? { canceled: true, filePaths: [] }
      : { canceled: false, filePaths: [path] };
  }
}
