import {
  WebContentsView,
  type BrowserWindow,
  type HandlerDetails,
  type WebContents,
} from 'electron';
import { parseOverlayLayerFrameName } from '@canopy/desktop-shared/lib/overlay-layer';
import type {
  OverlayLayerFocusRequest,
  OverlayLayerFollow,
  OverlayLayerRect,
  OverlayLayerSetBoundsRequest,
  OverlayLayerSlot,
} from '@canopy/desktop-shared/types';
import { attachInputGuardsToContents } from '../menu';
import { cssRectToWindowDips, registerUiZoomContents } from '../lib/ui-zoom';
import {
  isOpenExternallyClick,
  openExternalGuarded,
} from '../lib/open-external';
import { isElectronWebContents } from '../lib/electron-web-contents';
import { registerIpcSurface } from '../lib/web-contents-send';

const SAFE_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const OVERLAY_LAYER_BACKGROUND = '#00000000';

export interface OverlayLayerHostOptions {
  readonly routeAppLink: (url: string) => Promise<unknown>;
  readonly onLayerAttached: (window: BrowserWindow) => void;
}

interface LayerRecord {
  /** The window the layer is attached to, above its Browser views. */
  readonly window: BrowserWindow;
  /** The trusted renderer that opened the layer and draws into it. */
  readonly opener: WebContents;
  readonly slot: OverlayLayerSlot;
  readonly view: WebContentsView;
  readonly contents: WebContents;
  readonly onWillNavigate: (
    details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
  ) => void;
  readonly onWillFrameNavigate: (
    details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
  ) => void;
  readonly onDestroyed: () => void;
  readonly onBeforeMouseEvent: (
    event: Electron.Event,
    mouse: Electron.MouseInputEvent,
  ) => void;
  unregisterZoom: () => void;
  bounds: OverlayLayerRect | null;
  /** How the bounds move with the window; `null` keeps them where they are. */
  follow: OverlayLayerFollow | null;
  zoomFactor: number;
  disposed: boolean;
}

/** A window is still resizing this long after its last `resize` event. */
const WINDOW_RESIZE_ACTIVE_MS = 400;

interface WindowFollowState {
  resizedAt: number;
  /**
   * Whether the opener's viewport was the window's content size when last
   * seen at rest. With developer tools docked it is not, and a layer moved
   * by the window's size would land where the page never draws it.
   */
  viewportTracksWindow: boolean;
}

/** Shifts each edge anchored to the window's end by how much that end moved. */
export function followedOverlayBounds(
  bounds: OverlayLayerRect,
  follow: OverlayLayerFollow,
  viewport: { width: number; height: number },
): OverlayLayerRect {
  const dx = viewport.width - follow.viewport.width;
  const dy = viewport.height - follow.viewport.height;
  if (dx === 0 && dy === 0) return bounds;
  const { edges } = follow;
  const left = bounds.x + (edges.left === 'end' ? dx : 0);
  const right = bounds.x + bounds.width + (edges.right === 'end' ? dx : 0);
  const top = bounds.y + (edges.top === 'end' ? dy : 0);
  const bottom = bounds.y + bounds.height + (edges.bottom === 'end' ? dy : 0);
  const x = Math.max(0, left);
  const y = Math.max(0, top);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function isAllowedOverlayNavigation(url: string): boolean {
  return url === 'about:blank';
}

function routeExternalIfSafe(
  url: string,
  options: OverlayLayerHostOptions,
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
      void openExternalGuarded(url).catch(() => undefined);
    }
  } catch {
    // Malformed URLs are not opened externally.
  }
}

/**
 * Returns the overlay slot for a narrowly recognized same-origin popup.
 * The opener identity is mandatory: only a trusted renderer that hosts
 * Browser views (the main renderer, the full Orchestrator page) may create
 * layers, and it must be the popup's actual source.
 */
export function decideOverlayLayerWindowOpen(
  details: Pick<HandlerDetails, 'url' | 'frameName'>,
  sourceWebContentsId: number,
  openerWebContentsId: number,
): OverlayLayerSlot | null {
  if (
    details.url !== 'about:blank' ||
    sourceWebContentsId !== openerWebContentsId
  ) {
    return null;
  }
  return parseOverlayLayerFrameName(details.frameName);
}

/**
 * Owns adopted same-origin popup pages as transparent, per-slot native views
 * above a window's Browser views. Layers belong to the renderer that opened
 * them, so two renderers in one window (the main renderer and a hosted
 * Orchestrator page) each keep their own.
 */
export class OverlayLayerHost {
  private readonly layersByOpener = new WeakMap<
    WebContents,
    Map<OverlayLayerSlot, LayerRecord>
  >();
  private readonly records = new Set<LayerRecord>();
  private readonly followedWindows = new WeakMap<
    BrowserWindow,
    WindowFollowState
  >();
  private readonly observedWindows = new WeakSet<BrowserWindow>();
  private readonly observedOpeners = new WeakSet<WebContents>();

  constructor(private readonly options: OverlayLayerHostOptions) {}

  /** Installs lifecycle cleanup once for the lifetime of a host window. */
  observeWindow(window: BrowserWindow): void {
    if (window.isDestroyed() || this.observedWindows.has(window)) return;
    const onClosed = (): void => {
      this.disposeWhere((record) => record.window === window);
      window.removeListener('closed', onClosed);
      this.observedWindows.delete(window);
    };
    this.observedWindows.add(window);
    window.on('closed', onClosed);
  }

  /**
   * Installs lifecycle cleanup once for an opener renderer: its layers go
   * when it navigates away, crashes or is destroyed.
   */
  observeOpener(opener: WebContents): void {
    if (opener.isDestroyed() || this.observedOpeners.has(opener)) return;
    const disposeOpenerLayers = (): void => {
      this.disposeWhere((record) => record.opener === opener);
    };
    const onNavigation = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        disposeOpenerLayers();
      }
    };
    const onDestroyed = (): void => {
      disposeOpenerLayers();
      opener.off('did-start-navigation', onNavigation);
      opener.off('render-process-gone', disposeOpenerLayers);
      this.observedOpeners.delete(opener);
    };
    this.observedOpeners.add(opener);
    opener.on('did-start-navigation', onNavigation);
    opener.on('render-process-gone', disposeOpenerLayers);
    opener.once('destroyed', onDestroyed);
  }

  /**
   * Creates a narrowly allowed popup response for `opener`, whose layer is
   * attached to `window`. Electron supplies the real guest WebContents in
   * `options`; validating it via Electron's registry keeps untrusted
   * callback data from being adopted as a view.
   */
  createWindowOpenResponse(
    window: BrowserWindow,
    slot: OverlayLayerSlot,
    opener: WebContents = window.webContents,
  ): Electron.WindowOpenHandlerResponse {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: {
          preload: undefined,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      },
      createWindow: (
        options: Electron.BrowserWindowConstructorOptions,
      ): WebContents => {
        const candidate: unknown = Reflect.get(options, 'webContents');
        if (!isElectronWebContents(candidate)) {
          throw new Error('Overlay layer popup did not provide a WebContents.');
        }
        this.adoptGuest(window, opener, slot, candidate);
        return candidate;
      },
    };
  }

  /** Applies an opener's CSS rectangle or hides the requested slot. */
  setBounds(opener: WebContents, request: OverlayLayerSetBoundsRequest): void {
    const record = this.layersByOpener.get(opener)?.get(request.slot);
    if (!record || record.disposed) return;

    record.bounds = request.bounds;
    record.follow = request.bounds === null ? null : (request.follow ?? null);
    if (request.bounds === null) {
      record.view.setVisible(false);
      return;
    }
    record.zoomFactor = opener.getZoomFactor();
    if (record.follow) this.followWindowResize(record);
    this.fitRecord(record);
    record.view.setVisible(true);
  }

  /** Moves keyboard focus into the layer or back to its opener. */
  focus(opener: WebContents, request: OverlayLayerFocusRequest): void {
    const record = this.layersByOpener.get(opener)?.get(request.slot);
    if (!record || record.disposed) return;
    // Focusing either page also focuses the window, which would bring the
    // app in front of the one the person is working in.
    if (record.window.isDestroyed() || !record.window.isFocused()) return;

    if (request.target === 'layer') {
      if (!record.contents.isDestroyed()) record.contents.focus();
      return;
    }
    if (!opener.isDestroyed()) opener.focus();
  }

  /** Re-adds each slot to place it above Browser views attached later. */
  raise(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    for (const record of Array.from(this.records)) {
      if (!record.disposed && record.window === window) {
        window.contentView.addChildView(record.view);
      }
    }
  }

  private adoptGuest(
    window: BrowserWindow,
    opener: WebContents,
    slot: OverlayLayerSlot,
    contents: WebContents,
  ): void {
    const view = new WebContentsView({ webContents: contents });
    view.setBackgroundColor(OVERLAY_LAYER_BACKGROUND);
    view.setVisible(false);

    contents.setWindowOpenHandler((details) => {
      routeExternalIfSafe(
        details.url,
        this.options,
        isOpenExternallyClick(details),
      );
      return { action: 'deny' };
    });
    const onWillNavigate = (
      details: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
    ): void => {
      if (isAllowedOverlayNavigation(details.url)) return;
      details.preventDefault();
      routeExternalIfSafe(details.url, this.options);
    };
    const onWillFrameNavigate = (
      details: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
    ): void => {
      if (!isAllowedOverlayNavigation(details.url)) details.preventDefault();
    };
    contents.on('will-navigate', onWillNavigate);
    contents.on('will-frame-navigate', onWillFrameNavigate);
    attachInputGuardsToContents(contents);
    registerIpcSurface(contents, 'aux');

    const oldRecord = this.layersByOpener.get(opener)?.get(slot);
    if (oldRecord) this.disposeRecord(oldRecord, true);
    const layers = this.layersForOpener(opener);

    const record: LayerRecord = {
      window,
      opener,
      slot,
      view,
      contents,
      onWillNavigate,
      onWillFrameNavigate,
      onDestroyed: (): void => this.disposeRecord(record, false),
      onBeforeMouseEvent: (_event, mouse): void => {
        if (mouse.type !== 'mouseUp') return;
        setImmediate((): void => {
          if (
            record.disposed ||
            this.layersByOpener.get(opener)?.get(slot) !== record ||
            window.isDestroyed() ||
            opener.isDestroyed() ||
            contents.isDestroyed()
          ) {
            return;
          }
          opener.focus();
        });
      },
      unregisterZoom: (): void => undefined,
      bounds: null,
      follow: null,
      zoomFactor: opener.getZoomFactor(),
      disposed: false,
    };

    contents.setZoomFactor(record.zoomFactor);
    window.contentView.addChildView(view);
    layers.set(slot, record);
    this.records.add(record);
    contents.on('destroyed', record.onDestroyed);
    contents.on('before-mouse-event', record.onBeforeMouseEvent);
    record.unregisterZoom = registerUiZoomContents(contents, (zoomFactor) => {
      record.zoomFactor = zoomFactor;
      this.fitRecord(record);
    });
    this.options.onLayerAttached(window);
  }

  private fitRecord(record: LayerRecord): void {
    if (record.disposed || record.bounds === null) return;
    if (record.contents.isDestroyed() || record.window.isDestroyed()) return;
    record.view.setBounds(
      cssRectToWindowDips(
        this.placedBounds(record, record.bounds),
        record.zoomFactor,
      ),
    );
  }

  /**
   * Where a layer sits now. The renderer measures a frame or more after the
   * window resized, so its bounds can be for a size the window has already
   * left; a layer pinned to a window edge is moved by how far that edge has
   * moved since.
   */
  private placedBounds(
    record: LayerRecord,
    bounds: OverlayLayerRect,
  ): OverlayLayerRect {
    const follow = record.follow;
    if (!follow) return bounds;
    const state = this.followedWindows.get(record.window);
    const content = record.window.getContentBounds();
    const zoom = record.zoomFactor > 0 ? record.zoomFactor : 1;
    const viewport = {
      width: Math.round(content.width / zoom),
      height: Math.round(content.height / zoom),
    };
    // A px of rounding apart at a fractional zoom is the same viewport.
    const same =
      Math.abs(viewport.width - follow.viewport.width) <= 1 &&
      Math.abs(viewport.height - follow.viewport.height) <= 1;
    const resizing =
      state !== undefined &&
      Date.now() - state.resizedAt <= WINDOW_RESIZE_ACTIVE_MS;
    if (!resizing) {
      if (state) state.viewportTracksWindow = same;
      return bounds;
    }
    if (same || state?.viewportTracksWindow !== true) return bounds;
    return followedOverlayBounds(bounds, follow, viewport);
  }

  /** Moves this window's pinned layers in its own `resize` event. */
  private followWindowResize(record: LayerRecord): void {
    const window = record.window;
    if (window.isDestroyed() || this.followedWindows.has(window)) return;
    const content = window.getContentBounds();
    const zoom = record.zoomFactor > 0 ? record.zoomFactor : 1;
    const follow = record.follow;
    this.followedWindows.set(window, {
      resizedAt: 0,
      viewportTracksWindow:
        follow !== null &&
        Math.abs(Math.round(content.width / zoom) - follow.viewport.width) <=
          1 &&
        Math.abs(Math.round(content.height / zoom) - follow.viewport.height) <=
          1,
    });
    window.on('resize', () => {
      const state = this.followedWindows.get(window);
      if (!state || window.isDestroyed()) return;
      state.resizedAt = Date.now();
      for (const candidate of Array.from(this.records)) {
        if (
          candidate.window === window &&
          candidate.follow !== null &&
          candidate.bounds !== null
        ) {
          this.fitRecord(candidate);
        }
      }
    });
  }

  private layersForOpener(
    opener: WebContents,
  ): Map<OverlayLayerSlot, LayerRecord> {
    let layers = this.layersByOpener.get(opener);
    if (!layers) {
      layers = new Map<OverlayLayerSlot, LayerRecord>();
      this.layersByOpener.set(opener, layers);
    }
    return layers;
  }

  private disposeWhere(matches: (record: LayerRecord) => boolean): void {
    for (const record of Array.from(this.records)) {
      if (matches(record)) this.disposeRecord(record, true);
    }
  }

  private disposeRecord(record: LayerRecord, closeContents: boolean): void {
    if (record.disposed) return;
    record.disposed = true;
    this.records.delete(record);

    const layers = this.layersByOpener.get(record.opener);
    if (layers?.get(record.slot) === record) {
      layers.delete(record.slot);
      if (layers.size === 0) this.layersByOpener.delete(record.opener);
    }

    record.contents.off('destroyed', record.onDestroyed);
    record.contents.off('before-mouse-event', record.onBeforeMouseEvent);
    record.contents.off('will-navigate', record.onWillNavigate);
    record.contents.off('will-frame-navigate', record.onWillFrameNavigate);
    record.unregisterZoom();
    if (!record.window.isDestroyed()) {
      record.window.contentView.removeChildView(record.view);
    }
    if (closeContents && !record.contents.isDestroyed()) {
      record.contents.close({ waitForBeforeUnload: false });
    }
  }
}
