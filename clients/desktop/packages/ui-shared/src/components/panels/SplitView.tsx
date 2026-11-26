import { useLayoutEffect, useRef, type JSX, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { DisposableStore, toDisposable } from '../../lib/disposable';
import { Emitter, type Event } from '../../lib/emitter';
import { getWindow } from '../../lib/window-registry';
import type { Sash as SashInstance } from '../../panels/sash';
import {
  type IView,
  LayoutPriority,
  Orientation,
  Sizing,
  SplitView as SplitViewEngine,
} from '../../panels/splitview';

/**
 * Orientation of the pane axis:
 * - `'vertical'`   — panes are stacked top-to-bottom (sashes are horizontal).
 * - `'horizontal'` — panes sit side by side (sashes are vertical).
 */
export type SplitViewOrientation = 'horizontal' | 'vertical';

export type SplitViewPanePriority = 'normal' | 'low' | 'high';

/**
 * Descriptor for a single pane hosted by {@link SplitView}.
 */
export interface SplitViewPane {
  /** Stable identity for diffing. Panes are added/removed/matched by id. */
  id: string;
  /** React content rendered into the pane container via a portal. */
  content: ReactNode;
  /** Minimum size along the split axis, in pixels. @defaultValue `0` */
  minSize?: number;
  /**
   * Maximum size along the split axis, in pixels.
   * @defaultValue `Number.POSITIVE_INFINITY`
   */
  maxSize?: number;
  /** Whether the pane snaps closed at its minimum size. */
  snap?: boolean;
  /** Layout priority used when the split view itself is resized. */
  priority?: SplitViewPanePriority;
  /**
   * Controlled size in pixels. Applied when the pane is added and again
   * whenever the prop value changes. Live sash drags do not write this back;
   * commit the sizes reported by `onResizeEnd` to keep it in sync.
   */
  size?: number;
}

export interface SplitViewProps {
  orientation: SplitViewOrientation;
  panes: SplitViewPane[];
  /**
   * Resize panes proportionally when the split view itself resizes.
   * @defaultValue `true`
   */
  proportionalLayout?: boolean;
  /** CSS color for the separator border between panes. */
  separatorBorder?: string;
  /** Fired when the user starts dragging a sash. */
  onResizeStart?: () => void;
  /** Fired with live pane sizes (keyed by pane id) during a sash drag. */
  onResize?: (sizes: Record<string, number>) => void;
  /**
   * Fired with committed pane sizes (keyed by pane id) when a drag ends, a
   * keyboard resize is applied, or a sash reset redistributes the panes.
   */
  onResizeEnd?: (sizes: Record<string, number>) => void;
  /** Accessible label applied to every sash. @defaultValue `'Resize panes'` */
  sashAriaLabel?: string;
  className?: string;
}

const KEYBOARD_RESIZE_STEP = 10;

function toLayoutPriority(
  priority: SplitViewPanePriority | undefined,
): LayoutPriority | undefined {
  switch (priority) {
    case 'low':
      return LayoutPriority.Low;
    case 'high':
      return LayoutPriority.High;
    case 'normal':
      return LayoutPriority.Normal;
    default:
      return undefined;
  }
}

/**
 * IView adapter around a React-owned pane container element. The element is
 * created once per pane id and keeps its identity for the lifetime of the
 * component, so pane content rendered into it via `createPortal` never
 * remounts when sizes change or when sibling panes are added/removed.
 */
class PaneView implements IView {
  readonly element: HTMLElement;

  private readonly changeEmitter = new Emitter<number | undefined>();
  readonly onDidChange: Event<number | undefined> = this.changeEmitter.event;

  private _minimumSize: number;
  private _maximumSize: number;
  private _snap: boolean;
  private _priority: LayoutPriority | undefined;

  constructor(element: HTMLElement, pane: SplitViewPane) {
    this.element = element;
    this._minimumSize = pane.minSize ?? 0;
    this._maximumSize = pane.maxSize ?? Number.POSITIVE_INFINITY;
    this._snap = pane.snap ?? false;
    this._priority = toLayoutPriority(pane.priority);
  }

  get minimumSize(): number {
    return this._minimumSize;
  }

  get maximumSize(): number {
    return this._maximumSize;
  }

  get snap(): boolean {
    return this._snap;
  }

  get priority(): LayoutPriority | undefined {
    return this._priority;
  }

  layout(): void {
    // The engine sizes the wrapper container imperatively; the pane element
    // fills it via width/height 100%, so nothing to do here.
  }

  /** Applies changed constraints and notifies the engine so it relayouts. */
  updateFrom(pane: SplitViewPane): void {
    const minimumSize = pane.minSize ?? 0;
    const maximumSize = pane.maxSize ?? Number.POSITIVE_INFINITY;
    const snap = pane.snap ?? false;
    const priority = toLayoutPriority(pane.priority);

    if (
      minimumSize === this._minimumSize &&
      maximumSize === this._maximumSize &&
      snap === this._snap &&
      priority === this._priority
    ) {
      return;
    }

    this._minimumSize = minimumSize;
    this._maximumSize = maximumSize;
    this._snap = snap;
    this._priority = priority;
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

interface SashRecord {
  element: HTMLElement;
  disposables: DisposableStore;
  onKeyDown: (event: KeyboardEvent) => void;
}

interface EngineConfig {
  orientation: SplitViewOrientation;
  proportionalLayout: boolean;
}

interface LatestProps {
  orientation: SplitViewOrientation;
  panes: SplitViewPane[];
  sashAriaLabel: string;
}

interface LatestCallbacks {
  onResizeStart?: () => void;
  onResize?: (sizes: Record<string, number>) => void;
  onResizeEnd?: (sizes: Record<string, number>) => void;
}

/**
 * Controlled React wrapper around the imperative panels SplitView engine.
 *
 * The engine owns all drag-time geometry: live sash drags write styles
 * imperatively and never pass through React state. React owns pane content
 * only, rendered through portals into stable per-pane container elements so
 * pane subtrees never remount across relayouts or sibling add/remove.
 */
export function SplitView({
  orientation,
  panes,
  proportionalLayout,
  separatorBorder,
  onResizeStart,
  onResize,
  onResizeEnd,
  sashAriaLabel,
  className,
}: SplitViewProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<SplitViewEngine | null>(null);
  const engineConfigRef = useRef<EngineConfig | null>(null);
  const engineDisposablesRef = useRef<DisposableStore | null>(null);
  const paneElementsRef = useRef<Map<string, HTMLElement>>(new Map());
  const paneViewsRef = useRef<Map<string, PaneView>>(new Map());
  const mountedIdsRef = useRef<string[]>([]);
  const appliedSizesRef = useRef<Map<string, number | undefined>>(new Map());
  const sashRecordsRef = useRef<Map<SashInstance, SashRecord>>(new Map());
  const hasRealSizeRef = useRef(false);
  const appliedSeparatorBorderRef = useRef<string | undefined>(undefined);

  const latestPropsRef = useRef<LatestProps>({
    orientation,
    panes,
    sashAriaLabel: sashAriaLabel ?? 'Resize panes',
  });
  latestPropsRef.current = {
    orientation,
    panes,
    sashAriaLabel: sashAriaLabel ?? 'Resize panes',
  };

  const callbacksRef = useRef<LatestCallbacks>({});
  callbacksRef.current = { onResizeStart, onResize, onResizeEnd };

  const getPaneElement = (id: string): HTMLElement => {
    const map = paneElementsRef.current;
    const existing = map.get(id);

    if (existing) {
      return existing;
    }

    // Opener-realm rule (doc 13): pane containers are created via the
    // component realm's global `document` — even when they are later adopted
    // into another window's DOM — so `instanceof HTMLElement` checks keep
    // resolving against this realm.
    const element = document.createElement('div');
    element.classList.add('canopy-split-view-pane');
    element.style.width = '100%';
    element.style.height = '100%';
    map.set(id, element);
    return element;
  };

  const collectSizes = (): Record<string, number> => {
    const engine = engineRef.current;
    const sizes: Record<string, number> = {};

    if (!engine) {
      return sizes;
    }

    mountedIdsRef.current.forEach((id, index) => {
      sizes[id] = engine.getViewSize(index);
    });
    return sizes;
  };

  const updateSashAria = (): void => {
    const engine = engineRef.current;

    if (!engine) {
      return;
    }

    const {
      orientation: currentOrientation,
      panes: currentPanes,
      sashAriaLabel: label,
    } = latestPropsRef.current;
    const stacked = currentOrientation === 'vertical';
    const sashes = engine.sashes;
    const contentSize = Math.round(engine.contentSize);

    for (let index = 0; index < sashes.length; index++) {
      const record = sashRecordsRef.current.get(sashes[index]);

      if (!record) {
        continue;
      }

      const element = record.element;
      element.setAttribute('role', 'separator');
      // aria-orientation describes the separator line itself: a horizontal
      // line between stacked panes, a vertical line between side-by-side
      // panes.
      element.setAttribute(
        'aria-orientation',
        stacked ? 'horizontal' : 'vertical',
      );
      element.setAttribute('aria-label', label);

      const paneId = mountedIdsRef.current[index];
      const pane = currentPanes.find((candidate) => candidate.id === paneId);
      const minSize = Math.round(pane?.minSize ?? 0);
      const maxSize = pane?.maxSize;
      element.setAttribute('aria-valuemin', String(minSize));
      element.setAttribute(
        'aria-valuemax',
        String(
          typeof maxSize === 'number' && Number.isFinite(maxSize)
            ? Math.round(maxSize)
            : contentSize,
        ),
      );

      const size = engine.getViewSize(index);

      if (size >= 0) {
        element.setAttribute('aria-valuenow', String(Math.round(size)));
      }
    }
  };

  const handleSashKeyDown = (
    sash: SashInstance,
    event: KeyboardEvent,
  ): void => {
    const engine = engineRef.current;

    if (!engine) {
      return;
    }

    const index = engine.sashes.indexOf(sash);

    if (index < 0) {
      return;
    }

    const stacked = latestPropsRef.current.orientation === 'vertical';
    const decreaseKey = stacked ? 'ArrowUp' : 'ArrowLeft';
    const increaseKey = stacked ? 'ArrowDown' : 'ArrowRight';
    let delta: number;

    if (event.key === decreaseKey) {
      delta = -KEYBOARD_RESIZE_STEP;
    } else if (event.key === increaseKey) {
      delta = KEYBOARD_RESIZE_STEP;
    } else {
      return;
    }

    event.preventDefault();
    const currentSize = engine.getViewSize(index);

    if (currentSize < 0) {
      return;
    }

    engine.resizeView(index, currentSize + delta);
    updateSashAria();
    callbacksRef.current.onResizeEnd?.(collectSizes());
  };

  /**
   * Reconciles the engine's sash instances with locally tracked records.
   * The engine owns the sash DOM, so ARIA decoration, keyboard handling, and
   * live drag subscriptions are attached here after each add/remove. Called
   * after every single engine mutation so element pairing stays unambiguous
   * (each addView creates at most one new sash, appended last).
   */
  const syncSashRecords = (): void => {
    const engine = engineRef.current;

    if (!engine) {
      return;
    }

    const records = sashRecordsRef.current;
    const currentSashes = new Set<SashInstance>(engine.sashes);

    for (const [sash, record] of records) {
      if (!currentSashes.has(sash)) {
        record.element.removeEventListener('keydown', record.onKeyDown);
        record.disposables.dispose();
        records.delete(sash);
      }
    }

    const sashContainer = engine.el.querySelector(':scope > .sash-container');

    if (!(sashContainer instanceof HTMLElement)) {
      return;
    }

    const claimedElements = new Set<HTMLElement>();

    for (const record of records.values()) {
      claimedElements.add(record.element);
    }

    const unclaimedElements: HTMLElement[] = [];

    for (const child of Array.from(sashContainer.children)) {
      if (
        child instanceof HTMLElement &&
        child.classList.contains('canopy-sash') &&
        !claimedElements.has(child)
      ) {
        unclaimedElements.push(child);
      }
    }

    const newSashes = engine.sashes.filter((sash) => !records.has(sash));
    const pairCount = Math.min(newSashes.length, unclaimedElements.length);

    for (let i = 0; i < pairCount; i++) {
      const sash = newSashes[i];
      const element = unclaimedElements[i];
      const disposables = new DisposableStore();

      disposables.add(
        sash.onDidStart(() => {
          callbacksRef.current.onResizeStart?.();
        }),
      );
      // The engine's own drag handler is subscribed first, so sizes are
      // already updated when this listener reads them. Live drags stay out
      // of React state entirely.
      disposables.add(
        sash.onDidChange(() => {
          updateSashAria();
          callbacksRef.current.onResize?.(collectSizes());
        }),
      );

      const onKeyDown = (event: KeyboardEvent): void => {
        handleSashKeyDown(sash, event);
      };

      element.addEventListener('keydown', onKeyDown);
      element.tabIndex = 0;
      records.set(sash, { element, disposables, onKeyDown });
    }
  };

  const measureHost = (): number => {
    const host = hostRef.current;

    if (!host) {
      return 0;
    }

    return latestPropsRef.current.orientation === 'vertical'
      ? host.clientHeight
      : host.clientWidth;
  };

  const applyInitialSizes = (): void => {
    const engine = engineRef.current;

    if (!engine) {
      return;
    }

    const currentPanes = latestPropsRef.current.panes;
    let hasExplicitSize = false;

    mountedIdsRef.current.forEach((id, index) => {
      const pane = currentPanes.find((candidate) => candidate.id === id);

      if (pane && typeof pane.size === 'number') {
        hasExplicitSize = true;
        engine.resizeView(index, pane.size);
      }
    });

    if (!hasExplicitSize && engine.length > 0) {
      engine.distributeViewSizes();
    }
  };

  const handleMeasured = (size: number): void => {
    const engine = engineRef.current;

    if (!engine) {
      return;
    }

    engine.layout(Math.max(0, Math.round(size)));

    if (!hasRealSizeRef.current && size > 0) {
      hasRealSizeRef.current = true;
      applyInitialSizes();
    }

    updateSashAria();
  };

  const teardownEngine = (): void => {
    for (const record of sashRecordsRef.current.values()) {
      record.element.removeEventListener('keydown', record.onKeyDown);
      record.disposables.dispose();
    }

    sashRecordsRef.current.clear();
    engineDisposablesRef.current?.dispose();
    engineDisposablesRef.current = null;
    engineRef.current = null;
    engineConfigRef.current = null;
    mountedIdsRef.current = [];
    appliedSizesRef.current.clear();
    appliedSeparatorBorderRef.current = undefined;
    hasRealSizeRef.current = false;
  };

  const ensureEngine = (): void => {
    const host = hostRef.current;

    if (!host) {
      return;
    }

    const desiredConfig: EngineConfig = {
      orientation: latestPropsRef.current.orientation,
      proportionalLayout: proportionalLayout ?? true,
    };
    const currentConfig = engineConfigRef.current;

    if (
      engineRef.current &&
      currentConfig &&
      currentConfig.orientation === desiredConfig.orientation &&
      currentConfig.proportionalLayout === desiredConfig.proportionalLayout
    ) {
      return;
    }

    teardownEngine();

    const engine = new SplitViewEngine(host, {
      orientation:
        desiredConfig.orientation === 'vertical'
          ? Orientation.VERTICAL
          : Orientation.HORIZONTAL,
      proportionalLayout: desiredConfig.proportionalLayout,
    });
    engineRef.current = engine;
    engineConfigRef.current = desiredConfig;

    const store = new DisposableStore();
    engineDisposablesRef.current = store;
    store.add(
      toDisposable(() => {
        engine.dispose();
        engine.el.remove();
      }),
    );
    // Commit discipline: the engine fires onDidSashChange exactly once when a
    // drag ends; live per-frame changes go through each sash's onDidChange.
    store.add(
      engine.onDidSashChange(() => {
        updateSashAria();
        callbacksRef.current.onResizeEnd?.(collectSizes());
      }),
    );
    store.add(
      engine.onDidSashReset(() => {
        engine.distributeViewSizes();
        updateSashAria();
        callbacksRef.current.onResizeEnd?.(collectSizes());
      }),
    );

    // Construct the observer from the host element's own realm (window
    // registry) so measurement works when the split view renders inside an
    // auxiliary window (doc 05 §7.8).
    const hostWindow = getWindow(host);

    if (typeof hostWindow.ResizeObserver !== 'undefined') {
      const observer = new hostWindow.ResizeObserver((entries) => {
        const rect = entries[0]?.contentRect;
        const measured = rect
          ? latestPropsRef.current.orientation === 'vertical'
            ? rect.height
            : rect.width
          : measureHost();
        handleMeasured(measured);
      });
      observer.observe(host);
      store.add(toDisposable(() => observer.disconnect()));
    }

    const initialSize = measureHost();

    if (initialSize > 0) {
      hasRealSizeRef.current = true;
      engine.layout(initialSize);
    }
  };

  const syncSeparatorBorder = (): void => {
    const engine = engineRef.current;

    if (!engine || appliedSeparatorBorderRef.current === separatorBorder) {
      return;
    }

    appliedSeparatorBorderRef.current = separatorBorder;
    engine.style({ separatorBorder });
  };

  const syncPanes = (): void => {
    const engine = engineRef.current;

    if (!engine) {
      return;
    }

    const mounted = mountedIdsRef.current;
    const desired = latestPropsRef.current.panes;
    const desiredIds = new Set(desired.map((pane) => pane.id));

    // 1. Remove panes whose id is gone (reverse order keeps indexes valid).
    for (let index = mounted.length - 1; index >= 0; index--) {
      const id = mounted[index];

      if (desiredIds.has(id)) {
        continue;
      }

      engine.removeView(
        index,
        engine.length > 1 ? Sizing.Distribute : undefined,
      );
      mounted.splice(index, 1);
      paneViewsRef.current.get(id)?.dispose();
      paneViewsRef.current.delete(id);
      paneElementsRef.current.delete(id);
      appliedSizesRef.current.delete(id);
      syncSashRecords();
    }

    // 2. Add new panes / reorder existing ones by id.
    for (let target = 0; target < desired.length; target++) {
      const pane = desired[target];
      const currentIndex = mounted.indexOf(pane.id);

      if (currentIndex === target) {
        continue;
      }

      if (currentIndex >= 0) {
        // Reorder: remove and re-add at the target index, preserving size.
        // The pane container element is stable, so React content survives.
        const size = engine.getViewSize(currentIndex);
        engine.removeView(currentIndex);
        mounted.splice(currentIndex, 1);
        syncSashRecords();

        const view = paneViewsRef.current.get(pane.id);

        if (view) {
          engine.addView(view, size >= 0 ? size : Sizing.Distribute, target);
          mounted.splice(target, 0, pane.id);
          syncSashRecords();
        }
      } else {
        const view = new PaneView(getPaneElement(pane.id), pane);
        paneViewsRef.current.set(pane.id, view);
        const sizing =
          typeof pane.size === 'number' && hasRealSizeRef.current
            ? pane.size
            : Sizing.Distribute;
        engine.addView(view, sizing, target);
        mounted.splice(target, 0, pane.id);
        appliedSizesRef.current.set(pane.id, pane.size);
        syncSashRecords();
      }
    }

    // 3. Push constraint changes and controlled size changes.
    for (let index = 0; index < desired.length; index++) {
      const pane = desired[index];
      paneViewsRef.current.get(pane.id)?.updateFrom(pane);

      const appliedSize = appliedSizesRef.current.get(pane.id);

      if (pane.size !== appliedSize) {
        appliedSizesRef.current.set(pane.id, pane.size);

        if (typeof pane.size === 'number' && hasRealSizeRef.current) {
          engine.resizeView(index, pane.size);
        }
      }
    }
  };

  // Runs after every render: creates/recreates the engine when construction
  // options change, then diffs the panes prop into engine mutations. Live
  // drags never re-enter React, so this only does work when props change.
  useLayoutEffect(() => {
    ensureEngine();
    syncPanes();
    syncSeparatorBorder();
    updateSashAria();
  });

  useLayoutEffect(() => {
    return (): void => {
      teardownEngine();

      for (const view of paneViewsRef.current.values()) {
        view.dispose();
      }

      paneViewsRef.current.clear();
      paneElementsRef.current.clear();
    };
  }, []);

  // The no-remount rule: each pane's React content is rendered through a
  // portal into a stable per-id container element that the engine adopts
  // into its own `.split-view-view` wrapper. Because the portal target node
  // never changes identity, pane subtrees keep DOM/state across relayouts,
  // reorders, and sibling add/remove.
  const paneContent =
    typeof document === 'undefined'
      ? null
      : panes.map((pane) =>
          createPortal(pane.content, getPaneElement(pane.id), pane.id),
        );

  return (
    <div
      ref={hostRef}
      className={
        className
          ? `canopy-split-view-host ${className}`
          : 'canopy-split-view-host'
      }
    >
      {paneContent}
    </div>
  );
}
