import {
  WebContentsView,
  webContents,
  type BrowserWindow,
  type HandlerDetails,
  type WebContents,
} from 'electron';
import { parseOverlayLayerFrameName } from '@canopy/desktop-shared/lib/overlay-layer';
import type {
  OverlayLayerFocusRequest,
  OverlayLayerRect,
  OverlayLayerSetBoundsRequest,
  OverlayLayerSlot,
} from '@canopy/desktop-shared/types';
import { attachInputGuardsToContents } from '../menu';
import { cssRectToWindowDips, registerUiZoomContents } from '../lib/ui-zoom';
import { openExternalGuarded } from '../lib/open-external';
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
  zoomFactor: number;
  disposed: boolean;
}

function isElectronWebContents(value: unknown): value is WebContents {
  if (typeof value !== 'object' || value === null) return false;
  const id: unknown = Reflect.get(value, 'id');
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return false;
  return webContents.fromId(id) === value;
}

function isAllowedOverlayNavigation(url: string): boolean {
  return url === 'about:blank';
}

function routeExternalIfSafe(
  url: string,
  options: OverlayLayerHostOptions,
): void {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
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
    if (request.bounds === null) {
      record.view.setVisible(false);
      return;
    }
    record.zoomFactor = opener.getZoomFactor();
    this.fitRecord(record);
    record.view.setVisible(true);
  }

  /** Moves keyboard focus into the layer or back to its opener. */
  focus(opener: WebContents, request: OverlayLayerFocusRequest): void {
    const record = this.layersByOpener.get(opener)?.get(request.slot);
    if (!record || record.disposed) return;

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
      routeExternalIfSafe(details.url, this.options);
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
      cssRectToWindowDips(record.bounds, record.zoomFactor),
    );
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
