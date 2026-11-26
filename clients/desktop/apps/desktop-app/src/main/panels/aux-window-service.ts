/**
 * Panel auxiliary-window main-process service (Phase 8 of the VS Code-style
 * panel system — doc 05 §8, doc 13 spike).
 *
 * This module owns the ONLY exception to the main window's deny-all
 * `setWindowOpenHandler` posture, and the hardening of the windows created
 * through it. Security model, precisely:
 *
 * - **The narrow allow** ({@link decidePanelAuxWindowOpen}): a `window.open`
 *   is allowed if and only if the URL is exactly `about:blank` AND the frame
 *   name carries the `canopy-panel-aux:` prefix
 *   (`PANEL_AUX_WINDOW_FRAME_PREFIX` from `@canopy/protocol`) AND the request
 *   originates from the MAIN window's webContents. The origin condition is
 *   enforced structurally — the decision is only consulted from the handler
 *   installed on the main window's webContents (`index.ts`); the optional
 *   id parameters make the same gate explicit and unit-testable. Every other
 *   `window.open` keeps the existing behavior: deny, with safe http(s)/mailto
 *   URLs routed to the OS browser by the caller.
 * - **The override options**: the child window is created with
 *   `contextIsolation: true`, `nodeIntegration: false`, and NO preload —
 *   the child document runs no app code of its own (its CSP forbids script
 *   execution entirely; see `AuxPanelWindow`); all panel code executes in
 *   the opener realm and reaches the child only through same-origin DOM
 *   access. `sandbox: false` matches the opener's profile (the spike-proven
 *   configuration: an `about:blank` child shares the opener's renderer
 *   context, and Electron does not allow a child to relax the opener's
 *   sandbox anyway).
 * - **Child hardening** ({@link hardenPanelAuxWindow}, wired from the main
 *   window's `did-create-window`): the child webContents gets its own
 *   deny-all `setWindowOpenHandler` (safe web URLs use the owning renderer's
 *   app-link policy, while non-web URLs use the guarded shell helper), and `will-navigate` /
 *   `will-frame-navigate` guards that pin the child to `about:blank`
 *   forever — navigating the child anywhere would break the same-origin
 *   opener contract, so it is blocked. Bounds are validated against the visible displays with the
 *   same `validateWindowBounds` helper the main/App Advisor windows use.
 */
import { BrowserWindow, type HandlerDetails, type WebContents } from 'electron';
import {
  isPanelAuxWindowFrameName,
  makePanelAuxWindowFrameName,
  type SerializablePanelLayoutFile,
} from '@canopy/protocol';
import { BRAND } from '@canopy/brand/current';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { validateWindowBounds } from '../lib/window-state';
import { getWindowTitleBarOptions } from '../lib/window-title-bar';
import {
  isOpenExternallyClick,
  openExternalGuarded,
} from '../lib/open-external';
import { shouldShowUiAutomationWindow } from '../lib/ui-automation-window';
import { registerUiZoomMinimumSize, scaledMinimumSize } from '../lib/ui-zoom';

/**
 * Minimum sane size for an aux window at 100% interface scale (also the
 * bounds-validation clamp floor). The live minimum is `base × zoom`
 * (`lib/ui-zoom.ts`), like every other app window.
 */
const AUX_WINDOW_MIN_WIDTH = 400;
const AUX_WINDOW_MIN_HEIGHT = 300;
const AUX_WINDOW_MIN_SIZE = {
  width: AUX_WINDOW_MIN_WIDTH,
  height: AUX_WINDOW_MIN_HEIGHT,
};

const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/** Linux DOM outer bounds include CSD shadows; window.open consumes native bounds. */
export function canonicalizePanelAuxWindowBounds(
  layout: SerializablePanelLayoutFile,
  sender: WebContents,
): SerializablePanelLayoutFile {
  if (hostPlatformOperatingSystem() !== 'linux' || !layout.poppedOut?.length)
    return layout;
  try {
    if (sender.isDestroyed()) return layout;
    const owner = sender.mainFrame;
    if (owner.detached) return layout;
    const windows = BrowserWindow.getAllWindows();
    return {
      ...layout,
      poppedOut: layout.poppedOut.map((entry) => {
        for (const win of windows) {
          try {
            if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
            const contents = win.webContents;
            const frame = contents.mainFrame;
            const opener = contents.opener;
            if (
              frame.detached ||
              !opener ||
              opener.detached ||
              opener.frameTreeNodeId !== owner.frameTreeNodeId ||
              frame.name !== makePanelAuxWindowFrameName(entry.windowId) ||
              !isAllowedPanelAuxNavigation(contents.getURL())
            ) {
              continue;
            }
            const bounds = win.getNormalBounds();
            if (
              [bounds.x, bounds.y, bounds.width, bounds.height].every(
                Number.isFinite,
              ) &&
              bounds.width > 0 &&
              bounds.height > 0
            ) {
              return { ...entry, bounds };
            }
          } catch {
            // A closing native window/frame may become unavailable during save.
            continue;
          }
        }
        return entry;
      }),
    };
  } catch {
    // Keep the renderer snapshot when the owning renderer is closing.
    return layout;
  }
}

export interface PanelAuxWindowHardeningOptions {
  routeAppLink: (url: string) => Promise<unknown>;
}

function routeExternalIfSafe(
  url: string,
  options: PanelAuxWindowHardeningOptions,
  openExternally = false,
): void {
  try {
    const parsed = new URL(url);
    if (
      !openExternally &&
      (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    ) {
      void options.routeAppLink(url).catch(() => undefined);
    } else if (SAFE_EXTERNAL_SCHEMES.has(parsed.protocol)) {
      void openExternalGuarded(url);
    }
  } catch {
    // Malformed URL — do not open
  }
}

/**
 * Whether a navigation inside a panel aux window is allowed. The child
 * document must stay `about:blank` for its whole life: it is an
 * opener-scripted same-origin document, and any navigation would detach it
 * from the opener realm.
 */
export function isAllowedPanelAuxNavigation(url: string): boolean {
  return url === 'about:blank';
}

/**
 * The pure decision function for the main window's `setWindowOpenHandler`:
 * returns the allow response (with the security override options) for a
 * recognized panel-aux `window.open`, or `null` so the caller falls through
 * to the existing deny-all behavior.
 *
 * When both webContents ids are provided they must match — the handler is
 * only ever installed on the main window's webContents, and this makes that
 * origin gate explicit (and testable) rather than implicit.
 */
export function decidePanelAuxWindowOpen(
  details: Pick<HandlerDetails, 'url' | 'frameName'>,
  sourceWebContentsId?: number,
  mainWindowWebContentsId?: number,
  options: {
    /**
     * The opener's current UI zoom factor (`lib/ui-zoom.ts`). A pull-out is
     * part of the same UI, so the child window is created at the same zoom
     * and its first paint matches the main window; later changes reach it
     * through the preferences save fan-out.
     */
    zoomFactor?: number;
  } = {},
): Electron.WindowOpenHandlerResponse | null {
  if (
    sourceWebContentsId !== undefined &&
    mainWindowWebContentsId !== undefined &&
    sourceWebContentsId !== mainWindowWebContentsId
  ) {
    return null;
  }
  if (details.url !== 'about:blank') {
    return null;
  }
  if (!isPanelAuxWindowFrameName(details.frameName)) {
    return null;
  }

  const minimum = scaledMinimumSize(
    AUX_WINDOW_MIN_SIZE,
    options.zoomFactor ?? 1,
  );
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      // Bounds (left/top/width/height) come from the renderer's window.open
      // features string — fresh pop-outs use the default size, relaunch
      // restores pass the persisted bounds (Phase 9); only chrome + security
      // options are overridden here.
      minWidth: minimum.width,
      minHeight: minimum.height,
      // Same headless posture as the main window: in E2E and unpackaged
      // release-like automation, windows render but are never shown.
      show: shouldShowUiAutomationWindow(),
      title: BRAND.displayName,
      ...getWindowTitleBarOptions({
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 15, y: 12 },
      }),
      autoHideMenuBar: true,
      webPreferences: {
        // NO preload: the child document runs no app code of its own (all
        // scripts execute in the opener; the child additionally gets a
        // `script-src 'none'` CSP). Omitting `preload` here means none is
        // configured for the child — verified empirically by the pull-out
        // spec (`window.api` is undefined in the aux window).
        contextIsolation: true,
        sandbox: false, // matches the opener profile (index.ts main window)
        nodeIntegration: false,
        // Same interface scale as the opener from the first paint.
        ...(options.zoomFactor !== undefined
          ? { zoomFactor: options.zoomFactor }
          : {}),
      },
    },
  };
}

/**
 * Hardens one created panel aux window. Wired from the main window's
 * `did-create-window` (which fires only for allowed opens), routed by
 * {@link isPanelAuxWindowFrameName} on the event's frame name.
 */
export function hardenPanelAuxWindow(
  win: BrowserWindow,
  options: PanelAuxWindowHardeningOptions,
): void {
  // Clamp to a visible display (window-state pattern). `window.open`
  // placement is OS-chosen and normally on-screen; a null result (bounds on
  // no display) keeps the OS placement.
  const validated = validateWindowBounds(win.getBounds(), {
    minWidth: AUX_WINDOW_MIN_WIDTH,
    minHeight: AUX_WINDOW_MIN_HEIGHT,
  });
  if (validated) {
    win.setBounds(validated);
  }
  // Later interface-scale changes rescale the minimum from its 100% value.
  registerUiZoomMinimumSize(win, AUX_WINDOW_MIN_SIZE);

  // Nested window.open from the child: deny-all, with admitted links routed
  // through the same policy as links from the owning main renderer.
  win.webContents.setWindowOpenHandler((details) => {
    routeExternalIfSafe(details.url, options, isOpenExternallyClick(details));
    return { action: 'deny' };
  });

  // Pin the child to about:blank; route admitted links without navigating it.
  win.webContents.on('will-navigate', (event, url): void => {
    if (isAllowedPanelAuxNavigation(url)) {
      return;
    }
    event.preventDefault();
    routeExternalIfSafe(url, options);
  });

  win.webContents.on('will-frame-navigate', (details): void => {
    if (isAllowedPanelAuxNavigation(details.url)) {
      return;
    }
    details.preventDefault();
  });
}
