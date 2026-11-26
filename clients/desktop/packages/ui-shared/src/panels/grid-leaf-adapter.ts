/**
 * Grid-leaf adapter: lets the {@link Grid} / {@link SerializableGrid} engine
 * host React-rendered leaves without the engine ever knowing about React.
 *
 * The pattern mirrors the SplitView component's portal contract
 * (`components/panels/SplitView.tsx`): the component realm creates one stable
 * container element per leaf id, renders content into it via `createPortal`,
 * and hands the element to a {@link PanelLeafView}. The grid engine adopts
 * the element into its own wrapper DOM and drives sizing imperatively;
 * because the container's identity never changes, portal content never
 * remounts across relayouts, splits, moves, or serialization round-trips.
 *
 * This file is engine-layer code: no React, no stores, no runtime deps.
 */

import { DisposableStore } from '../lib/disposable';
import { Emitter, type Event } from '../lib/emitter';
import { LayoutPriority } from './splitview';
import type { ISerializableView, IViewSize } from './grid';

/**
 * Default minimum width for a panel leaf, in px. VS Code clamps editor
 * groups to 220×70 (`DEFAULT_EDITOR_MIN_DIMENSIONS`); Canopy uses a narrower
 * minimum because side panel groups (terminal, activity sections) are
 * legitimately narrower than code editors.
 *
 * The floor must still cover the min-content width of an activity card
 * header: 24+24px padding, a 16px icon, 12+8px gaps, and a 28px icon button
 * (≈112px), plus room for a short title. Leaves clip with `overflow: hidden`,
 * so a lower floor (the previous 100px) let the header's call-to-action
 * disappear when a panel was dragged narrow, and the card bodies (MCP
 * server rows, tab labels) need roughly 240px before they stop colliding;
 * 320px gives them breathing room. It also sits above the left sidebar's
 * 220px minimum and the file tree
 * minimum in Code Review (`MIN_FILE_TREE_WIDTH`).
 */
export const DEFAULT_PANEL_LEAF_MINIMUM_WIDTH = 320;

/**
 * Default minimum height for a panel leaf, in px. Matches VS Code's editor
 * minimum height (70): enough for a tab bar plus a sliver of content.
 */
export const DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT = 70;

/** Construction options for {@link PanelLeafView}. */
export interface PanelLeafViewOptions {
  /** Stable leaf identity; round-trips through {@link PanelLeafView.toJSON}. */
  readonly id: string;
  /**
   * The leaf's root DOM node, created by the OPENER/component realm (see
   * {@link createPanelLeafElement}), never by this class.
   */
  readonly element: HTMLElement;
  /** @defaultValue {@link DEFAULT_PANEL_LEAF_MINIMUM_WIDTH} (320) */
  readonly minimumWidth?: number;
  /** @defaultValue `Number.POSITIVE_INFINITY` */
  readonly maximumWidth?: number;
  /** @defaultValue {@link DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT} (70) */
  readonly minimumHeight?: number;
  /** @defaultValue `Number.POSITIVE_INFINITY` */
  readonly maximumHeight?: number;
}

/** Partial constraint update for {@link PanelLeafView.setConstraints}. */
export interface PanelLeafViewConstraints {
  readonly minimumWidth?: number;
  readonly maximumWidth?: number;
  readonly minimumHeight?: number;
  readonly maximumHeight?: number;
}

/** The box a leaf last received from {@link PanelLeafView.layout}. */
export interface PanelLeafLayoutBox {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly left: number;
}

/**
 * Serialized payload of one panel leaf: identity only. Panel content is
 * persisted by id and re-attached from live state on restore (see the
 * `@canopy/protocol` panels contract).
 */
export interface PanelLeafViewJson {
  readonly id: string;
}

/**
 * Type guard for {@link PanelLeafViewJson}; the seam `IViewDeserializer`
 * implementations use to validate leaf payloads before recreating views.
 */
export function isPanelLeafViewJson(
  value: unknown,
): value is PanelLeafViewJson {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0
  );
}

/**
 * The engine-facing leaf: implements the grid-level `ISerializableView`
 * contract around a caller-provided container element.
 *
 * Realm rule (doc 13 / opener-realm rule): the element is provided by the
 * caller and MUST be created in the opener/component realm, not by this
 * class. Phase 0 pull-out spike findings
 * (`docs/planning/2026-06-27-vs-code-panels/13-phase0-pullout-spike-findings.md`,
 * confirming doc 10 A1) verified that a node created by the opener's
 * `document` stays `instanceof` the opener realm's `HTMLElement` after being
 * adopted into a child window, while nodes created by the child document
 * belong to a distinct realm and break `instanceof`-based engine checks.
 * Creating containers in the opener realm and adopting them is what makes
 * future pull-out windows work; {@link createPanelLeafElement} is the
 * creation seam.
 *
 * Layout flow: the grid calls {@link layout} with the leaf's box; this class
 * records it and fires {@link onDidLayout} so content (tab bar + body) can
 * size itself without a per-leaf `ResizeObserver`. It writes NOTHING to
 * React — content subscribes if and only if it needs the box.
 */
export class PanelLeafView implements ISerializableView {
  readonly id: string;
  readonly element: HTMLElement;

  private readonly disposables = new DisposableStore();

  private readonly changeEmitter = new Emitter<IViewSize | undefined>();
  /**
   * Fires when size constraints change (via {@link setConstraints}); the
   * hosting grid subscribes and relayouts.
   */
  readonly onDidChange: Event<IViewSize | undefined> = this.changeEmitter.event;

  private readonly layoutEmitter = new Emitter<PanelLeafLayoutBox>();
  /** Fires after every {@link layout} call with the box the grid assigned. */
  readonly onDidLayout: Event<PanelLeafLayoutBox> = this.layoutEmitter.event;

  private readonly visibilityEmitter = new Emitter<boolean>();
  /** Fires when the grid shows/hides this leaf (e.g. sibling maximized). */
  readonly onDidVisibilityChange: Event<boolean> = this.visibilityEmitter.event;

  private _minimumWidth: number;
  private _maximumWidth: number;
  private _minimumHeight: number;
  private _maximumHeight: number;
  private _lastLayout: PanelLeafLayoutBox | undefined;
  private _visible = true;
  private _priority = LayoutPriority.Normal;

  get priority(): LayoutPriority {
    return this._priority;
  }

  /** Prefer this sibling during one synchronous grid resize, then restore
   * normal drag/window-resize behavior even if the operation throws. */
  withHighLayoutPriority(action: () => void): void {
    const previous = this._priority;
    this._priority = LayoutPriority.High;
    try {
      action();
    } finally {
      this._priority = previous;
    }
  }

  constructor(options: PanelLeafViewOptions) {
    this.id = options.id;
    this.element = options.element;
    this._minimumWidth =
      options.minimumWidth ?? DEFAULT_PANEL_LEAF_MINIMUM_WIDTH;
    this._maximumWidth = options.maximumWidth ?? Number.POSITIVE_INFINITY;
    this._minimumHeight =
      options.minimumHeight ?? DEFAULT_PANEL_LEAF_MINIMUM_HEIGHT;
    this._maximumHeight = options.maximumHeight ?? Number.POSITIVE_INFINITY;

    this.disposables.add(this.changeEmitter);
    this.disposables.add(this.layoutEmitter);
    this.disposables.add(this.visibilityEmitter);
  }

  get minimumWidth(): number {
    return this._minimumWidth;
  }

  get maximumWidth(): number {
    return this._maximumWidth;
  }

  get minimumHeight(): number {
    return this._minimumHeight;
  }

  get maximumHeight(): number {
    return this._maximumHeight;
  }

  /** The last box received from the grid, or `undefined` before layout. */
  get lastLayout(): PanelLeafLayoutBox | undefined {
    return this._lastLayout;
  }

  /** Whether the grid currently shows this leaf. Defaults to `true`. */
  get visible(): boolean {
    return this._visible;
  }

  /**
   * Grid → leaf callback. Records the box and fires {@link onDidLayout}.
   * Intentionally does not touch the element: the engine sizes its own
   * wrapper and the leaf element fills it via CSS.
   */
  layout(width: number, height: number, top: number, left: number): void {
    const box: PanelLeafLayoutBox = { width, height, top, left };
    this._lastLayout = box;
    this.layoutEmitter.fire(box);
  }

  /** Grid → leaf visibility callback (grid-level `IView.setVisible`). */
  setVisible(visible: boolean): void {
    if (visible === this._visible) {
      return;
    }

    this._visible = visible;
    this.visibilityEmitter.fire(visible);
  }

  /**
   * Updates any provided size constraints (omitted fields keep their current
   * values) and fires {@link onDidChange} so the hosting grid relayouts with
   * the new minimums/maximums. No-op when nothing actually changed.
   */
  setConstraints(constraints: PanelLeafViewConstraints): void {
    const minimumWidth = constraints.minimumWidth ?? this._minimumWidth;
    const maximumWidth = constraints.maximumWidth ?? this._maximumWidth;
    const minimumHeight = constraints.minimumHeight ?? this._minimumHeight;
    const maximumHeight = constraints.maximumHeight ?? this._maximumHeight;

    if (
      minimumWidth === this._minimumWidth &&
      maximumWidth === this._maximumWidth &&
      minimumHeight === this._minimumHeight &&
      maximumHeight === this._maximumHeight
    ) {
      return;
    }

    this._minimumWidth = minimumWidth;
    this._maximumWidth = maximumWidth;
    this._minimumHeight = minimumHeight;
    this._maximumHeight = maximumHeight;
    this.changeEmitter.fire(undefined);
  }

  /**
   * `ISerializableView` glue: `SerializableGrid.serialize()` stores this as
   * the leaf's `data` payload. Identity only — content is re-attached from
   * live state on restore.
   */
  toJSON(): PanelLeafViewJson {
    return { id: this.id };
  }

  dispose(): void {
    this.disposables.dispose();
  }
}

/**
 * Creates a panel-leaf container element in the given document.
 *
 * This is the opener-realm creation seam (doc 13 / opener-realm rule):
 * callers pass the OPENER window's `document` — including when the leaf will
 * be adopted into a pulled-out child window — so the node keeps its
 * opener-realm identity (`instanceof HTMLElement`) after adoption. The
 * element fills the grid's wrapper, which the engine positions and sizes.
 */
export function createPanelLeafElement(ownerDocument: Document): HTMLElement {
  const element = ownerDocument.createElement('div');
  element.classList.add('canopy-panel-leaf');
  element.style.position = 'relative';
  element.style.width = '100%';
  element.style.height = '100%';
  element.style.overflow = 'hidden';
  return element;
}
