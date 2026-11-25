import {
  BaseWindow,
  WebContentsView,
  screen,
  type BaseWindowConstructorOptions,
  type BrowserWindow,
  type BrowserWindowConstructorOptions,
  type Input,
  type Rectangle,
  type WebContents,
  type WindowOpenHandlerResponse,
} from 'electron';
import { BRAND } from '@canopy/brand/current';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { isElectronWebContents } from '../lib/electron-web-contents';
import { mayTakeForeground } from '../lib/main-window-focus';
import { shouldShowUiAutomationWindow } from '../lib/ui-automation-window';
import { registerIpcSurface } from '../lib/web-contents-send';
import { isFileBrowserUrl } from './browser-url-policy';
import { withoutElectronUserAgentToken } from './browser-user-agent';

/** Popup windows one tab may hold at once; further opens become tabs. */
const MAX_POPUPS_PER_OPENER = 3;
/** How long closing a tab's popups may wait before destroying them. */
const CLOSE_TIMEOUT_MS = 2000;
const DEFAULT_WIDTH = 500;
const DEFAULT_HEIGHT = 600;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 200;
const FILE_URL_WARNING = 'A web page cannot navigate directly to a local file.';

export interface BrowserPopupWindowsOptions {
  readonly isUrlAllowedInApp: (url: string) => boolean;
  readonly openUrlExternally: (url: string) => Promise<void>;
  /**
   * Opens an allowed URL the way the opener tab opens a non-popup request
   * (a new tab, or in place in the sign-in pane); nothing once it is gone.
   */
  readonly requestPopupTab: (browserId: string, url: string) => void;
  /** Records a warning in the opener tab's console. */
  readonly warn: (browserId: string, text: string) => void;
  readonly hostWindowFor: (browserId: string) => BrowserWindow | null;
  readonly isOpenerLive: (browserId: string) => boolean;
}

interface PopupRecord {
  readonly browserId: string;
  readonly guest: WebContents;
  window: BaseWindow | null;
  /** Whether the popup has committed a page other than `about:blank`. */
  committed: boolean;
}

interface RequestedBounds {
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
}

function finiteRounded(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value)
    : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * The popup's window bounds: the page's size and position when usable,
 * kept inside the work area, centered on the host window otherwise.
 */
function popupBounds(
  requested: RequestedBounds,
  workArea: Rectangle,
  hostBounds: Rectangle | null,
): Rectangle {
  const maxWidth = Math.max(MIN_WIDTH, workArea.width);
  const maxHeight = Math.max(MIN_HEIGHT, workArea.height);
  const width = clamp(requested.width ?? DEFAULT_WIDTH, MIN_WIDTH, maxWidth);
  const height = clamp(
    requested.height ?? DEFAULT_HEIGHT,
    MIN_HEIGHT,
    maxHeight,
  );
  const center = hostBounds ?? workArea;
  const x = requested.x ?? Math.round(center.x + (center.width - width) / 2);
  const y = requested.y ?? Math.round(center.y + (center.height - height) / 2);
  return {
    x: clamp(x, workArea.x, workArea.x + workArea.width - width),
    y: clamp(y, workArea.y, workArea.y + workArea.height - height),
    width,
    height,
  };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * The window title: the committed page's hostname first, so a page title
 * cannot pose as the origin, then the page title; the app name while the
 * popup has not loaded a page.
 */
function popupTitle(url: string, pageTitle: string): string {
  const hostname = url === 'about:blank' ? '' : hostnameOf(url);
  if (!hostname) return BRAND.displayName;
  const title = pageTitle.trim();
  // A page without a title reports its URL, less the scheme, as the title.
  if (
    !title ||
    title === url ||
    title === url.replace(/^[a-z][a-z\d+.-]*:\/\//i, '')
  )
    return hostname;
  return `${hostname} — ${title}`;
}

/**
 * The app menu's zoom, development reload, and DevTools chords. Menu
 * accelerators fire whichever window has focus, and these act on the app
 * window, not the popup. `code` covers the DevTools key, whose `key` macOS
 * turns into another character while Option is held.
 */
function isAppWindowMenuChord(
  input: Input,
  key: string,
  mac: boolean,
): boolean {
  if (key === '+' || key === '=' || key === '-' || key === '0')
    return !input.alt;
  if (key === 'r') return input.shift && !input.alt;
  if (key === 'i' || input.code === 'KeyI')
    return mac ? input.alt && !input.shift : input.shift && !input.alt;
  return false;
}

/**
 * Native popup windows for a Browser tab's scripted `window.open`, linked to
 * their opener so popup sign-ins can post their result back (CAN-6497).
 * Each popup is a guest in the opener's session, hosted in a `BaseWindow`
 * parented to the opener's host window. It is not a `BrowserWindow`, so the
 * app's broadcasts, window pickers, and input guards never reach it.
 */
export class BrowserPopupWindows {
  private readonly byOpener = new Map<string, Set<PopupRecord>>();
  private readonly byGuest = new Map<number, PopupRecord>();
  private readonly closingOpeners = new Set<string>();

  constructor(private readonly options: BrowserPopupWindowsOptions) {}

  /** Whether the opener is below the popup cap. */
  hasRoomFor(browserId: string): boolean {
    return (this.byOpener.get(browserId)?.size ?? 0) < MAX_POPUPS_PER_OPENER;
  }

  /** The opener tab of a popup's guest, while both are live. */
  openerFor(guestId: number): string | undefined {
    return this.byGuest.get(guestId)?.browserId;
  }

  /**
   * Lets Chromium create the popup with an opener and hands its guest to
   * {@link createWindow}. The guest never gets the tab preload or another
   * partition, so it stays in the opener's session with no app bridge.
   */
  windowOpenResponse(browserId: string): WindowOpenHandlerResponse {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          preload: undefined,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webviewTag: false,
          safeDialogs: true,
        },
      },
      createWindow: (options) => this.createWindow(browserId, options),
    };
  }

  /**
   * Closes every popup of a tab being disposed, in parallel. Popups it asks
   * for meanwhile are refused. Resolves when their guests are gone, or
   * destroys what remains after {@link CLOSE_TIMEOUT_MS}; never rejects.
   */
  closeFor(browserId: string): Promise<void> {
    const records = Array.from(this.byOpener.get(browserId) ?? []);
    if (records.length === 0) return Promise.resolve();
    this.closingOpeners.add(browserId);
    const gone = records.map(
      (record) =>
        new Promise<void>((resolve) => {
          if (record.guest.isDestroyed()) {
            resolve();
            return;
          }
          record.guest.once('destroyed', () => resolve());
          this.close(record);
        }),
    );
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        for (const record of records) this.destroy(record);
        this.options.warn(
          browserId,
          'A popup window did not close in time and was closed forcibly.',
        );
        resolve();
      }, CLOSE_TIMEOUT_MS);
      void Promise.all(gone).then(() => {
        clearTimeout(timer);
        resolve();
      });
    }).finally(() => {
      this.closingOpeners.delete(browserId);
    });
  }

  private createWindow(
    browserId: string,
    options: BrowserWindowConstructorOptions,
  ): WebContents {
    const candidate: unknown = Reflect.get(options, 'webContents');
    if (!isElectronWebContents(candidate)) {
      throw new Error('Browser popup did not provide a WebContents.');
    }
    const guest = candidate;
    // Throwing past this point would leave Chromium waiting on the popup;
    // every failure closes the guest and returns it instead.
    if (
      !this.options.isOpenerLive(browserId) ||
      this.closingOpeners.has(browserId)
    ) {
      this.refuse(browserId, guest, 'The tab closed before its popup opened.');
      return guest;
    }
    const record: PopupRecord = {
      browserId,
      guest,
      window: null,
      committed: false,
    };
    try {
      guest.setUserAgent(withoutElectronUserAgentToken(guest.getUserAgent()));
      registerIpcSurface(guest, 'browser');
      this.track(record);
      this.guard(record);
      record.window = this.buildWindow(browserId, guest, options);
      this.watchWindow(record, record.window);
      this.showWindow(record.window, guest);
    } catch (error) {
      this.untrack(record);
      if (record.window && !record.window.isDestroyed())
        record.window.destroy();
      record.window = null;
      this.refuse(
        browserId,
        guest,
        `The popup window could not open: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return guest;
  }

  private refuse(browserId: string, guest: WebContents, text: string): void {
    if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
    this.options.warn(browserId, text);
  }

  private track(record: PopupRecord): void {
    const set = this.byOpener.get(record.browserId) ?? new Set<PopupRecord>();
    set.add(record);
    this.byOpener.set(record.browserId, set);
    this.byGuest.set(record.guest.id, record);
  }

  private untrack(record: PopupRecord): void {
    const set = this.byOpener.get(record.browserId);
    set?.delete(record);
    if (set?.size === 0) this.byOpener.delete(record.browserId);
    if (this.byGuest.get(record.guest.id) === record)
      this.byGuest.delete(record.guest.id);
  }

  private buildWindow(
    browserId: string,
    guest: WebContents,
    options: BrowserWindowConstructorOptions,
  ): BaseWindow {
    const host = this.options.hostWindowFor(browserId);
    const parent = host && !host.isDestroyed() ? host : null;
    const hostBounds = parent ? parent.getBounds() : null;
    const display = hostBounds
      ? screen.getDisplayMatching(hostBounds)
      : screen.getPrimaryDisplay();
    const bounds = popupBounds(
      {
        x: finiteRounded(options.x),
        y: finiteRounded(options.y),
        width: finiteRounded(options.width),
        height: finiteRounded(options.height),
      },
      display.workArea,
      hostBounds,
    );
    // Only these options; the page's own features (frame, alwaysOnTop,
    // transparency) never reach the window.
    const windowOptions: BaseWindowConstructorOptions = {
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: BRAND.displayName,
      autoHideMenuBar: true,
      fullscreenable: false,
      show: false,
      ...(parent ? { parent } : {}),
    };
    const window = new BaseWindow(windowOptions);
    if (hostOperatingSystem() === 'win32') window.removeMenu();
    window.setContentView(new WebContentsView({ webContents: guest }));
    return window;
  }

  private showWindow(window: BaseWindow, guest: WebContents): void {
    if (!shouldShowUiAutomationWindow()) return;
    // A page in the background cannot take the foreground from another app.
    if (mayTakeForeground()) {
      window.show();
      // A BaseWindow does not focus its view's page, which typing needs.
      guest.focus();
    } else window.showInactive();
  }

  private watchWindow(record: PopupRecord, window: BaseWindow): void {
    window.on('closed', () => {
      record.window = null;
      if (!record.guest.isDestroyed())
        record.guest.close({ waitForBeforeUnload: false });
    });
  }

  private guard(record: PopupRecord): void {
    const { guest, browserId } = record;
    const onNavigation = (
      event: { preventDefault: () => void },
      url: string,
    ): void => {
      this.guardNavigation(record, event, url);
    };
    // An opener-driven navigation (`popup.location = …`) fires this too.
    guest.on('will-navigate', (event) => onNavigation(event, event.url));
    guest.on('will-redirect', (event) => onNavigation(event, event.url));
    guest.setWindowOpenHandler((details) => {
      // Popups never nest: their own opens go where a tab's would.
      const url = details.url;
      if (isFileBrowserUrl(url)) {
        this.options.warn(browserId, FILE_URL_WARNING);
      } else if (this.options.isUrlAllowedInApp(url)) {
        if (this.options.isOpenerLive(browserId))
          this.options.requestPopupTab(browserId, url);
      } else {
        this.openExternally(browserId, url);
      }
      return { action: 'deny' };
    });
    // The page cannot keep its own window open.
    guest.on('will-prevent-unload', (event) => event.preventDefault());
    guest.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const mac = hostOperatingSystem() === 'darwin';
      const command = mac ? input.meta : input.control;
      if (!command || (mac && input.control)) return;
      const key = input.key.toLowerCase();
      if (key === 'w' && !input.alt && !input.shift) {
        // Also keeps the app menu's close shortcut off the main window.
        event.preventDefault();
        this.close(record);
      } else if (isAppWindowMenuChord(input, key, mac)) {
        event.preventDefault();
      }
    });
    guest.on('render-process-gone', () => this.destroy(record));
    guest.on('did-navigate', (_event, url) => {
      if (url !== 'about:blank') record.committed = true;
      this.updateTitle(record);
    });
    guest.on('page-title-updated', () => this.updateTitle(record));
    // A popup opened only to start a download would be left blank, so it
    // closes once the download starts, admitted or not.
    const { session } = guest;
    const onDownload = (
      _event: unknown,
      _item: unknown,
      source: WebContents | undefined,
    ): void => {
      if (source?.id === guest.id && !record.committed) this.deferClose(record);
    };
    session.on('will-download', onDownload);
    guest.once('destroyed', () => {
      session.removeListener('will-download', onDownload);
      this.untrack(record);
      const { window } = record;
      record.window = null;
      if (window && !window.isDestroyed()) window.destroy();
    });
  }

  private guardNavigation(
    record: PopupRecord,
    event: { preventDefault: () => void },
    url: string,
  ): void {
    const targetIsFile = isFileBrowserUrl(url);
    if (!targetIsFile && this.options.isUrlAllowedInApp(url)) return;
    event.preventDefault();
    if (targetIsFile) this.options.warn(record.browserId, FILE_URL_WARNING);
    else this.openExternally(record.browserId, url);
    // A popup that never showed a page would stay an empty window.
    if (!record.committed) this.deferClose(record);
  }

  private openExternally(browserId: string, url: string): void {
    void this.options.openUrlExternally(url).catch((error: unknown) => {
      this.options.warn(
        browserId,
        error instanceof Error ? error.message : String(error),
      );
    });
  }

  private updateTitle(record: PopupRecord): void {
    const { guest, window } = record;
    if (!window || window.isDestroyed() || guest.isDestroyed()) return;
    window.setTitle(popupTitle(guest.getURL(), guest.getTitle()));
  }

  /** Closes after the current Electron event, which may still use the guest. */
  private deferClose(record: PopupRecord): void {
    setImmediate(() => this.close(record));
  }

  private close(record: PopupRecord): void {
    if (record.guest.isDestroyed()) {
      this.destroy(record);
      return;
    }
    record.guest.close({ waitForBeforeUnload: false });
  }

  private destroy(record: PopupRecord): void {
    const { window } = record;
    record.window = null;
    if (window && !window.isDestroyed()) window.destroy();
    if (!record.guest.isDestroyed())
      record.guest.close({ waitForBeforeUnload: false });
    this.untrack(record);
  }
}
