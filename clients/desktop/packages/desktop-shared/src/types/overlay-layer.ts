/**
 * Native overlay layers: transparent views the main window raises above its
 * in-app browser views, so app UI can draw over a live page. Each slot is one
 * layer owned by one renderer surface.
 */
export type OverlayLayerSlot = 'notifications' | 'above-browser';

export interface OverlayLayerRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which window edge an edge of a layer keeps its distance to. */
export type OverlayLayerEdgeAnchor = 'start' | 'end';

/**
 * How a layer's bounds move with its window, so main can move the layer in
 * the window's own resize event instead of a frame or more later, when the
 * renderer reports again.
 */
export interface OverlayLayerFollow {
  /** The renderer viewport the bounds were measured in, CSS px. */
  viewport: { width: number; height: number };
  edges: {
    left: OverlayLayerEdgeAnchor;
    right: OverlayLayerEdgeAnchor;
    top: OverlayLayerEdgeAnchor;
    bottom: OverlayLayerEdgeAnchor;
  };
}

/** Bounds are main-renderer CSS px; `null` hides the layer. */
export interface OverlayLayerSetBoundsRequest {
  slot: OverlayLayerSlot;
  bounds: OverlayLayerRect | null;
  /** Only with bounds. Without it the layer stays where the bounds say. */
  follow?: OverlayLayerFollow;
}

/** Moves keyboard focus into the slot's layer, or back to the main page. */
export interface OverlayLayerFocusRequest {
  slot: OverlayLayerSlot;
  target: 'layer' | 'main';
}

export interface OverlayLayerApi {
  setBounds(request: OverlayLayerSetBoundsRequest): Promise<void>;
  focus(request: OverlayLayerFocusRequest): Promise<void>;
}
