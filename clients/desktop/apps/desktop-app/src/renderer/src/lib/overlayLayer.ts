/**
 * Owns the transparent, per-slot child document used to render over native
 * browser views. React containers must be created in the opener realm and
 * adopted into the child document so their DOM prototypes remain compatible
 * with opener-realm code. A layer opens lazily, reports loss before teardown,
 * and is disposed with the opener page; failed opens and repeated early loss
 * leave the slot unavailable for the rest of that page's lifetime.
 */

import { overlayLayerFrameName } from '@canopy/desktop-shared/lib/overlay-layer';
import type {
  OverlayLayerFollow,
  OverlayLayerApi,
  OverlayLayerRect,
  OverlayLayerSlot,
} from '@canopy/desktop-shared/types';
import { DisposableStore, registerWindow } from '@canopy/ui-shared/panels';
import { readRemoteControlContext } from '../stores/remoteControlStore';
import {
  mirrorHtmlAttributesInto,
  mirrorStylesheetsInto,
} from './panels/child-window-styles';

export interface OverlayLayer {
  readonly slot: OverlayLayerSlot;
  /** The popup window (child realm). */
  readonly window: Window;
  /** The popup's document. */
  readonly document: Document;
  /**
   * Opener-realm element adopted into the child body. It is fixed to the
   * viewport, clipped, and pointer-transparent; callers append their own
   * opener-realm content and position it absolutely.
   */
  readonly root: HTMLElement;
  /** True once the layer was lost or disposed. */
  isLost(): boolean;
  /**
   * Registers a once-only loss listener. It runs synchronously before child
   * teardown; a listener added after loss is never called.
   */
  onLost(listener: () => void): () => void;
  /**
   * Sets native layer bounds, and with `follow` how they move with the
   * window. A rejected IPC loses the layer; this never rejects.
   */
  setBounds(
    bounds: OverlayLayerRect | null,
    follow?: OverlayLayerFollow,
  ): Promise<void>;
  /** Moves focus into the layer or back to the main page; this never rejects. */
  focus(target: 'layer' | 'main'): Promise<void>;
}

interface LayerRecord {
  readonly slot: OverlayLayerSlot;
  readonly childWindow: WindowProxy;
  readonly root: HTMLElement;
  readonly disposables: DisposableStore;
  readonly listeners: Set<() => void>;
  readonly onChildPageHide: () => void;
  layer: OverlayLayer | null;
  pollHandle: number | null;
  lost: boolean;
  didSetBounds: boolean;
}

interface SlotState {
  active: LayerRecord | null;
  unavailable: boolean;
  consecutiveLossesBeforeBounds: number;
}

const CLOSE_POLL_INTERVAL_MS = 500;
const OVERLAY_LAYER_TITLES: Record<OverlayLayerSlot, string> = {
  notifications: 'Notifications',
  'above-browser': 'Above browser',
};
const MAX_CONSECUTIVE_EARLY_LOSSES = 3;
const slotStates = new Map<OverlayLayerSlot, SlotState>();

let openerPageHideListenerInstalled = false;

function getSlotState(slot: OverlayLayerSlot): SlotState {
  let state = slotStates.get(slot);

  if (!state) {
    state = {
      active: null,
      unavailable: false,
      consecutiveLossesBeforeBounds: 0,
    };
    slotStates.set(slot, state);
  }

  return state;
}

function isOverlayLayerApi(value: unknown): value is OverlayLayerApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    'setBounds' in value &&
    typeof value.setBounds === 'function' &&
    'focus' in value &&
    typeof value.focus === 'function'
  );
}

/** Reflect through the preload surface so test and non-Electron hosts may omit it. */
function getOverlayLayerApi(): OverlayLayerApi | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const preloadApi: unknown = Reflect.get(window, 'api');

    if (typeof preloadApi !== 'object' || preloadApi === null) {
      return null;
    }

    const overlayApi: unknown = Reflect.get(preloadApi, 'overlayLayer');
    return isOverlayLayerApi(overlayApi) ? overlayApi : null;
  } catch {
    return null;
  }
}

function closeChildWindow(childWindow: WindowProxy): void {
  try {
    if (!childWindow.closed) {
      childWindow.close();
    }
  } catch {
    // A closed or navigating WindowProxy can throw during cross-window access.
  }
}

function safelyDispose(disposables: DisposableStore): void {
  try {
    disposables.dispose();
  } catch {
    // Continue tearing down the remaining child-window resources.
  }
}

function teardownRecord(record: LayerRecord): void {
  if (record.pollHandle !== null && typeof window !== 'undefined') {
    window.clearInterval(record.pollHandle);
    record.pollHandle = null;
  }

  try {
    record.childWindow.removeEventListener('pagehide', record.onChildPageHide);
  } catch {
    // A closed child can reject access to its event target.
  }

  safelyDispose(record.disposables);
  record.root.remove();
  closeChildWindow(record.childWindow);

  const state = slotStates.get(record.slot);
  if (state?.active === record) {
    state.active = null;
  }
}

function loseRecord(record: LayerRecord, countEarlyLoss: boolean): void {
  if (record.lost) {
    return;
  }

  record.lost = true;
  const state = slotStates.get(record.slot);

  if (countEarlyLoss && state && !record.didSetBounds) {
    state.consecutiveLossesBeforeBounds += 1;
    if (state.consecutiveLossesBeforeBounds >= MAX_CONSECUTIVE_EARLY_LOSSES) {
      state.unavailable = true;
    }
  }

  for (const listener of Array.from(record.listeners)) {
    try {
      listener();
    } catch {
      // One consumer must not prevent other loss listeners from restoring UI.
    }
  }
  record.listeners.clear();

  teardownRecord(record);
}

function handleOpenerPageHide(): void {
  for (const slot of Array.from(slotStates.keys())) {
    disposeOverlayLayer(slot);
  }
}

function installOpenerPageHideListener(): void {
  if (openerPageHideListenerInstalled || typeof window === 'undefined') {
    return;
  }

  window.addEventListener('pagehide', handleOpenerPageHide);
  openerPageHideListenerInstalled = true;
}

/**
 * The slot's currently open (not lost) layer, without opening one.
 */
export function getOpenOverlayLayer(
  slot: OverlayLayerSlot,
): OverlayLayer | null {
  const active = slotStates.get(slot)?.active;
  return active && !active.lost ? active.layer : null;
}

/**
 * Whether this page can layer the slot. A missing preload API, remote-control
 * context, failed open, or repeated early loss is terminal for this page.
 */
export function isOverlayLayerAvailable(slot: OverlayLayerSlot): boolean {
  const state = getSlotState(slot);

  if (state.unavailable) {
    return false;
  }

  if (readRemoteControlContext().mode === 'remote') {
    state.unavailable = true;
    return false;
  }

  if (!getOverlayLayerApi()) {
    state.unavailable = true;
    return false;
  }

  return true;
}

/**
 * Opens and prepares the slot's child document on first use. The opener
 * continues to own all script execution; the child contains only mirrored
 * styling and opener-created DOM.
 */
export function openOverlayLayer(slot: OverlayLayerSlot): OverlayLayer | null {
  const existing = getOpenOverlayLayer(slot);
  if (existing) {
    return existing;
  }

  const state = getSlotState(slot);
  if (!isOverlayLayerAvailable(slot)) {
    return null;
  }

  let childWindow: WindowProxy | null = null;
  let record: LayerRecord | null = null;
  const disposables = new DisposableStore();
  let root: HTMLElement | null = null;

  try {
    const frameName = overlayLayerFrameName(slot, crypto.randomUUID());
    childWindow = window.open('about:blank', frameName);

    if (!childWindow) {
      state.unavailable = true;
      return null;
    }

    // Register before touching the child DOM so window-aware helpers resolve
    // it during synchronous document preparation.
    disposables.add(registerWindow(childWindow));

    const childDocument = childWindow.document;
    const csp = childDocument.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = "script-src 'none'";
    childDocument.head.appendChild(csp);

    disposables.add(mirrorStylesheetsInto(childDocument));
    disposables.add(mirrorHtmlAttributesInto(childDocument));

    // These !important declarations keep the native view transparent over
    // mirrored inline theme backgrounds and ordinary app stylesheet rules, so
    // no head-order observer is needed when later stylesheets are mirrored.
    const transparentStyle = childDocument.createElement('style');
    transparentStyle.textContent =
      'html, body { background: transparent !important; overflow: hidden !important; }';
    childDocument.head.appendChild(transparentStyle);
    childDocument.title = OVERLAY_LAYER_TITLES[slot];

    // Containers rendered by the opener must be created in this realm, then
    // adopted into the child body's document.
    root = document.createElement('div');
    root.dataset.canopyOverlayLayerRoot = slot;
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.overflow = 'hidden';
    root.style.pointerEvents = 'none';
    root.style.margin = '0';
    childDocument.body.appendChild(root);

    const recordReference: { current: LayerRecord | null } = {
      current: null,
    };
    const onChildPageHide = (): void => {
      const activeRecord = recordReference.current;
      if (activeRecord) {
        loseRecord(activeRecord, true);
      }
    };
    const recordListeners = new Set<() => void>();
    const layerRecord: LayerRecord = {
      slot,
      childWindow,
      root,
      disposables,
      listeners: recordListeners,
      onChildPageHide,
      layer: null,
      pollHandle: null,
      lost: false,
      didSetBounds: false,
    };
    recordReference.current = layerRecord;
    record = layerRecord;

    const layer: OverlayLayer = {
      slot,
      window: childWindow,
      document: childDocument,
      root,
      isLost: (): boolean => layerRecord.lost,
      onLost: (listener: () => void): (() => void) => {
        if (layerRecord.lost) {
          return (): void => undefined;
        }

        layerRecord.listeners.add(listener);
        let subscribed = true;

        return (): void => {
          if (subscribed) {
            subscribed = false;
            layerRecord.listeners.delete(listener);
          }
        };
      },
      setBounds: async (
        bounds: OverlayLayerRect | null,
        follow?: OverlayLayerFollow,
      ): Promise<void> => {
        if (layerRecord.lost) {
          return;
        }

        try {
          const api = getOverlayLayerApi();
          if (!api) {
            loseRecord(layerRecord, true);
            return;
          }
          await api.setBounds(
            bounds !== null && follow !== undefined
              ? { slot, bounds, follow }
              : { slot, bounds },
          );
          if (layerRecord.lost) {
            return;
          }
          layerRecord.didSetBounds = true;
          state.consecutiveLossesBeforeBounds = 0;
        } catch {
          loseRecord(layerRecord, true);
        }
      },
      focus: async (target: 'layer' | 'main'): Promise<void> => {
        if (layerRecord.lost) {
          return;
        }

        try {
          const api = getOverlayLayerApi();
          if (!api) {
            loseRecord(layerRecord, true);
            return;
          }
          await api.focus({ slot, target });
        } catch {
          loseRecord(layerRecord, true);
        }
      },
    };
    layerRecord.layer = layer;
    state.active = layerRecord;

    childWindow.addEventListener('pagehide', layerRecord.onChildPageHide);
    layerRecord.pollHandle = window.setInterval(() => {
      try {
        if (childWindow?.closed) {
          loseRecord(layerRecord, true);
        }
      } catch {
        loseRecord(layerRecord, true);
      }
    }, CLOSE_POLL_INTERVAL_MS);
    installOpenerPageHideListener();

    return layer;
  } catch {
    state.unavailable = true;
    if (record) {
      loseRecord(record, false);
    } else {
      if (root) {
        root.remove();
      }
      safelyDispose(disposables);
      if (childWindow) {
        closeChildWindow(childWindow);
      }
    }
    return null;
  }
}

/** Loses and tears down the slot's layer without changing availability. */
export function disposeOverlayLayer(slot: OverlayLayerSlot): void {
  const active = slotStates.get(slot)?.active;
  if (active) {
    loseRecord(active, false);
  }
}
