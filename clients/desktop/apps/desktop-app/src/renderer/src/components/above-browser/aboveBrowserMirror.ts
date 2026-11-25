import type { OverlayLayerRect } from '@canopy/desktop-shared/types';
import {
  ABOVE_BROWSER_ATTRIBUTE,
  ABOVE_BROWSER_HOVER_ATTRIBUTE,
} from '@canopy/ui-shared/lib/above-browser';
import {
  BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE,
  BROWSER_NATIVE_VIEW_COVER_CHANGED_EVENT,
  BROWSER_NATIVE_VIEW_COVERED_ATTRIBUTE,
  BROWSER_NATIVE_VIEW_FROZEN_ATTRIBUTE,
  findBrowserNativeViewOverlays,
  setAboveBrowserMirrorActive,
  setAboveBrowserMirrorPage,
  subscribeBrowserOverlayTopology,
} from '@/lib/browserNativeOverlay';
import { BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT } from '@/lib/browserViewBounds';
import {
  isOverlayLayerAvailable,
  openOverlayLayer,
  type OverlayLayer,
} from '@/lib/overlayLayer';

const SLOT = 'above-browser';
/**
 * Room around a marked element for its shadow (`shadow-xl` reaches about this
 * far), so the copy over a page is not cut at the element's own edge.
 */
const SHADOW_MARGIN = 32;
const MARKED_SELECTOR = `[${ABOVE_BROWSER_ATTRIBUTE}]`;
const PAGE_SELECTOR = `[${BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE}="true"]`;
/**
 * What makes a `"hover"` element show: hovered (now, or by its own delayed
 * `hover` class), or a handle being dragged.
 */
const HOVER_MODE_SHOWN_SELECTOR = ':hover, .hover, .active';
/**
 * Set on an original while its copy is drawn above a page, so tests and
 * tooling can tell it is visible there.
 */
export const ABOVE_BROWSER_COPIED_ATTRIBUTE = 'data-above-browser-copied';

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface MirrorEntry {
  readonly source: HTMLElement;
  /** The outermost ancestor shell, appended to the frame. */
  root: HTMLElement;
  /** The innermost shell (the source's parent's copy), holding the copy. */
  parent: HTMLElement;
  copy: HTMLElement;
  /** The measured box a non-fixed copy is placed by; `null` when fixed. */
  placement: DOMRect | null;
  readonly observer: MutationObserver;
  /** The source's subtree changed beyond its own attributes. */
  stale: boolean;
  /** The source's animations already playing on the current copy. */
  played: WeakSet<Animation>;
}

const EMPTY_RECT: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

function union(rects: readonly Rect[]): Rect {
  return rects.reduce((a, b) => ({
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }));
}

function toLayerBounds(rect: Rect): OverlayLayerRect {
  const x = Math.floor(rect.left);
  const y = Math.floor(rect.top);
  return {
    x,
    y,
    width: Math.ceil(rect.right) - x,
    height: Math.ceil(rect.bottom) - y,
  };
}

function sameBounds(
  a: OverlayLayerRect | null,
  b: OverlayLayerRect | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height)
  );
}

function isShown(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) {
    return false;
  }
  return typeof element.checkVisibility === 'function'
    ? element.checkVisibility({ visibilityProperty: true })
    : true;
}

/** Strips what must not repeat in a second document from a copied node. */
function neutralize(element: Element): void {
  element.removeAttribute('id');
  element.removeAttribute(ABOVE_BROWSER_ATTRIBUTE);
  element.removeAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE);
  for (const node of Array.from(element.querySelectorAll('[id]'))) {
    node.removeAttribute('id');
  }
}

function copyOf(source: HTMLElement): HTMLElement {
  const node = source.cloneNode(true);
  if (!(node instanceof HTMLElement)) {
    throw new Error('Above-browser copy is not an element.');
  }
  neutralize(node);
  node.setAttribute('aria-hidden', 'true');
  node.inert = true;
  return node;
}

/**
 * Writes a changed text node's value onto its twin in the copy, found by the
 * same child-index path, so ticking text (a working chat's elapsed time) does
 * not re-copy the element and restart its animations. Returns false when the
 * twin is not there, so the caller copies the element again.
 */
function copyText(source: HTMLElement, copy: HTMLElement, text: Node): boolean {
  const path: number[] = [];
  let node: Node = text;
  while (node !== source) {
    const parent = node.parentNode;
    if (!parent) return false;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
    node = parent;
  }
  let twin: Node | undefined = copy;
  for (const index of path) twin = twin?.childNodes[index];
  if (!twin || twin.nodeType !== text.nodeType) return false;
  twin.nodeValue = text.nodeValue;
  return true;
}

/** Places a copy at a measured box, relative to the frame. */
function place(copy: HTMLElement, rect: DOMRect): void {
  copy.style.position = 'absolute';
  copy.style.left = `${rect.left}px`;
  copy.style.top = `${rect.top}px`;
  copy.style.right = 'auto';
  copy.style.bottom = 'auto';
  copy.style.width = `${rect.width}px`;
  copy.style.height = `${rect.height}px`;
  copy.style.margin = '0';
  copy.style.transform = 'none';
  copy.style.boxSizing = 'border-box';
}

/**
 * Box-less copies of the source's ancestors, so stylesheet rules that depend
 * on them (`[data-window-layout='inset'] .canopy-sash`, `.dark …`) still
 * match the copy. Returns the outermost and innermost shell.
 */
function ancestorShells(
  source: HTMLElement,
): { root: HTMLElement; parent: HTMLElement } | null {
  let root: HTMLElement | null = null;
  let parent: HTMLElement | null = null;
  for (
    let ancestor = source.parentElement;
    ancestor !== null && ancestor !== source.ownerDocument.documentElement;
    ancestor = ancestor.parentElement
  ) {
    const shell = ancestor.cloneNode(false);
    if (!(shell instanceof HTMLElement)) continue;
    neutralize(shell);
    shell.removeAttribute('style');
    shell.style.display = 'contents';
    if (root === null) {
      parent = shell;
    } else {
      shell.appendChild(root);
    }
    root = shell;
  }
  return root !== null && parent !== null ? { root, parent } : null;
}

/**
 * Draws elements marked with {@link ABOVE_BROWSER_ATTRIBUTE} above the native
 * in-app browser pages they overlap, through the `above-browser` overlay
 * layer: a transparent native view raised above every browser view. The
 * originals stay in this document (where they keep working and draw over the
 * rest of the app); wherever they overlap a page, a pointer-transparent copy
 * in the layer shows over the live page.
 *
 * The layer is cut to the elements' overlap with one page (with room for
 * their shadows), so it only ever covers page area: the app's own controls,
 * and the triggers that open these overlays, never lose the pointer to it.
 * Within that rectangle the layer does take the pointer, even where it is
 * transparent, for as long as the overlay shows.
 *
 * A copy is re-made when the original's elements change, which restarts its
 * CSS animations; text, attribute and position changes only update it. Mark
 * elements whose structure holds still while shown.
 */
export class AboveBrowserMirror {
  private readonly window: Window & typeof globalThis;
  private readonly entries = new Map<HTMLElement, MirrorEntry>();
  private layer: OverlayLayer | null = null;
  private layerLostUnsubscribe: (() => void) | null = null;
  private frame: HTMLElement | null = null;
  private sentBounds: OverlayLayerRect | null = null;
  private evaluationFrame: number | null = null;
  private topologyUnsubscribe: (() => void) | null = null;
  private disposed = false;

  private readonly evaluateNow = (): void => {
    if (this.evaluationFrame !== null) {
      this.window.cancelAnimationFrame(this.evaluationFrame);
      this.evaluationFrame = null;
    }
    this.evaluate();
  };

  /**
   * The pointer entering or leaving a marked element can show or hide it
   * (`"hover"` mode). Moving between any other two elements changes nothing
   * here, and re-evaluating for each of those ran the whole pass on most
   * frames the pointer moved.
   */
  private readonly onPointer = (event: PointerEvent): void => {
    const marks = (target: EventTarget | null): boolean =>
      target instanceof Element && target.closest(MARKED_SELECTOR) !== null;
    if (
      this.entries.size > 0 ||
      marks(event.target) ||
      marks(event.relatedTarget)
    ) {
      this.schedule();
    }
  };

  private readonly schedule = (): void => {
    if (this.disposed || this.evaluationFrame !== null) return;
    this.evaluationFrame = this.window.requestAnimationFrame(() => {
      this.evaluationFrame = null;
      this.evaluate();
    });
  };

  constructor(private readonly document: Document) {
    const view = document.defaultView;
    if (!view) {
      throw new Error('Above-browser mirror needs a window.');
    }
    this.window = view;
  }

  start(): void {
    setAboveBrowserMirrorActive(isOverlayLayerAvailable(SLOT));
    // While a copy is drawn over a page it follows its original through any
    // reflow, so it hears every change; otherwise only overlay changes.
    this.topologyUnsubscribe = subscribeBrowserOverlayTopology(this.schedule, {
      everyChange: () => this.entries.size > 0,
    });
    const options = { capture: true, passive: true };
    this.document.addEventListener('pointerover', this.onPointer, options);
    this.document.addEventListener('pointerout', this.onPointer, options);
    this.window.addEventListener('resize', this.schedule);
    this.window.addEventListener('scroll', this.schedule, true);
    this.window.addEventListener(
      BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT,
      this.schedule,
    );
    // A pane reports a cover change from its own frame callback: answer in
    // that frame, so an overlay over the live page shows at once.
    this.window.addEventListener(
      BROWSER_NATIVE_VIEW_COVER_CHANGED_EVENT,
      this.evaluateNow,
    );
    this.schedule();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.evaluationFrame !== null) {
      this.window.cancelAnimationFrame(this.evaluationFrame);
      this.evaluationFrame = null;
    }
    this.topologyUnsubscribe?.();
    this.topologyUnsubscribe = null;
    const options = { capture: true };
    this.document.removeEventListener('pointerover', this.onPointer, options);
    this.document.removeEventListener('pointerout', this.onPointer, options);
    this.window.removeEventListener('resize', this.schedule);
    this.window.removeEventListener('scroll', this.schedule, true);
    this.window.removeEventListener(
      BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT,
      this.schedule,
    );
    this.window.removeEventListener(
      BROWSER_NATIVE_VIEW_COVER_CHANGED_EVENT,
      this.evaluateNow,
    );
    this.clear();
    setAboveBrowserMirrorActive(false);
  }

  /** Lays every marked element over a page into the layer, or hides it. */
  evaluate(): void {
    if (this.disposed) return;
    if (this.layer?.isLost()) this.handleLayerLoss();

    const pageElements = Array.from(
      this.document.querySelectorAll<HTMLElement>(PAGE_SELECTOR),
    )
      // A frozen page's native view is hidden, so the originals already
      // show there: only live pages need the layer.
      .filter(
        (element) =>
          element.getAttribute(BROWSER_NATIVE_VIEW_FROZEN_ATTRIBUTE) !== 'true',
      )
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.width > 0 && rect.height > 0);
    const pages = pageElements.map(({ rect }) => rect);
    if (pages.length === 0) {
      this.clear();
      return;
    }
    if (!isOverlayLayerAvailable(SLOT)) {
      setAboveBrowserMirrorActive(false);
      this.clear();
      return;
    }

    // Marked overlays, plus the overlays covering a page its freeze frame does
    // not stand in for yet: drawn over the live page until the frame does, so
    // a menu is never cut off while the capture runs.
    const candidates = new Set<HTMLElement>();
    for (const source of Array.from(
      this.document.querySelectorAll<HTMLElement>(MARKED_SELECTOR),
    )) {
      const mode = source.getAttribute(ABOVE_BROWSER_ATTRIBUTE);
      if (mode !== 'true' && mode !== 'hover') continue;
      if (mode === 'hover' && !source.matches(HOVER_MODE_SHOWN_SELECTOR)) {
        continue;
      }
      if (isShown(source)) candidates.add(source);
    }
    for (const { element, rect } of pageElements) {
      if (
        element.getAttribute(BROWSER_NATIVE_VIEW_COVERED_ATTRIBUTE) !== 'true'
      ) {
        continue;
      }
      for (const overlay of findBrowserNativeViewOverlays(
        this.document,
        rect,
      )) {
        candidates.add(overlay);
      }
    }

    // Each candidate's reach (its box plus shadow) over each page.
    const overlaps: { source: HTMLElement; rect: DOMRect; clips: Rect[] }[] =
      [];
    for (const source of Array.from(candidates)) {
      const rect = source.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const span = this.travelOf(source, rect);
      const reach = {
        left: span.left - SHADOW_MARGIN,
        top: span.top - SHADOW_MARGIN,
        right: span.right + SHADOW_MARGIN,
        bottom: span.bottom + SHADOW_MARGIN,
      };
      overlaps.push({
        source,
        rect,
        clips: pages.map((page) => intersect(reach, page) ?? EMPTY_RECT),
      });
    }
    // One layer is one rectangle, and a rectangle spanning two pages would
    // cover the app between them (a sash between two browsers would then
    // lose the pointer to it). Draw over the page with the most overlap.
    const area = (rect: Rect): number =>
      Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
    let pageIndex = -1;
    let pageArea = 0;
    pages.forEach((_page, index) => {
      const total = overlaps.reduce(
        (sum, overlap) => sum + area(overlap.clips[index] ?? EMPTY_RECT),
        0,
      );
      if (total > pageArea) {
        pageIndex = index;
        pageArea = total;
      }
    });
    const shown = overlaps.filter(
      (overlap) => area(overlap.clips[pageIndex] ?? EMPTY_RECT) > 0,
    );
    setAboveBrowserMirrorPage(pages[pageIndex] ?? null);
    const clips = shown.map(
      (overlap) => overlap.clips[pageIndex] ?? EMPTY_RECT,
    );
    if (shown.length === 0) {
      this.clear();
      return;
    }

    const layer = this.layer ?? this.openLayer();
    if (!layer) {
      this.clear();
      return;
    }
    const bounds = toLayerBounds(union(clips));
    const frame = this.ensureFrame(layer);
    // The frame stands where the main viewport is, relative to the layer's
    // own viewport (its bounds). Its transform makes it the containing block
    // of `position: fixed` copies too, so those land where the originals are.
    frame.style.left = `${-bounds.x}px`;
    frame.style.top = `${-bounds.y}px`;
    frame.style.width = `${this.window.innerWidth}px`;
    frame.style.height = `${this.window.innerHeight}px`;

    const keep = new Set(shown.map(({ source }) => source));
    for (const [source, entry] of Array.from(this.entries)) {
      if (!keep.has(source)) this.removeEntry(entry);
    }
    for (const { source, rect } of shown) {
      this.syncEntry(frame, source, rect);
    }

    if (!sameBounds(bounds, this.sentBounds)) {
      this.sentBounds = bounds;
      void layer.setBounds(bounds);
    }
  }

  private openLayer(): OverlayLayer | null {
    const layer = openOverlayLayer(SLOT);
    if (!layer) {
      // The layer will not open on this page: marked overlays fall back to
      // freezing the page, which counts them again.
      setAboveBrowserMirrorActive(false);
      return null;
    }
    this.layer = layer;
    this.layerLostUnsubscribe = layer.onLost(() => this.handleLayerLoss());
    return layer;
  }

  private handleLayerLoss(): void {
    this.layerLostUnsubscribe?.();
    this.layerLostUnsubscribe = null;
    this.layer = null;
    this.frame = null;
    this.sentBounds = null;
    // The copies went with the layer; only the originals need resetting.
    for (const entry of Array.from(this.entries.values())) {
      entry.observer.disconnect();
      entry.source.removeAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE);
    }
    this.entries.clear();
    setAboveBrowserMirrorActive(isOverlayLayerAvailable(SLOT));
    this.schedule();
  }

  private ensureFrame(layer: OverlayLayer): HTMLElement {
    if (this.frame?.isConnected) return this.frame;
    // Created in this realm and adopted, like every node in the layer.
    const frame = this.document.createElement('div');
    frame.dataset.testid = 'above-browser-frame';
    frame.style.position = 'absolute';
    frame.style.transform = 'translate(0px, 0px)';
    frame.style.pointerEvents = 'none';
    layer.root.appendChild(frame);
    this.frame = frame;
    return frame;
  }

  private syncEntry(
    frame: HTMLElement,
    source: HTMLElement,
    rect: DOMRect,
  ): void {
    let entry = this.entries.get(source);
    if (!entry) {
      const shells = ancestorShells(source);
      const copy = copyOf(source);
      const parent = shells?.parent ?? frame;
      parent.appendChild(copy);
      if (shells) frame.appendChild(shells.root);
      const observer = new this.window.MutationObserver((records) => {
        const current = this.entries.get(source);
        if (!current) return;
        for (const record of records) {
          if (record.type === 'attributes' && record.target === source) {
            const name = record.attributeName;
            if (
              name &&
              name !== 'id' &&
              name !== ABOVE_BROWSER_ATTRIBUTE &&
              name !== ABOVE_BROWSER_COPIED_ATTRIBUTE
            ) {
              const value = source.getAttribute(name);
              if (value === null) current.copy.removeAttribute(name);
              else current.copy.setAttribute(name, value);
              // The layer paints on its own: keep a placed copy where it is
              // until the next evaluation measures it again.
              if (name === 'style' && current.placement !== null) {
                place(current.copy, current.placement);
              }
            }
          } else if (
            record.type !== 'characterData' ||
            current.stale ||
            !copyText(source, current.copy, record.target)
          ) {
            current.stale = true;
          }
        }
        this.schedule();
      });
      observer.observe(source, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
      entry = {
        source,
        root: shells?.root ?? copy,
        parent,
        copy,
        placement: null,
        observer,
        stale: false,
        played: new WeakSet(),
      };
      this.entries.set(source, entry);
    } else if (entry.stale) {
      // Re-copy only on subtree changes: a fresh copy restarts its CSS
      // animations, which a position or state attribute change must not.
      const copy = copyOf(source);
      entry.parent.replaceChild(copy, entry.copy);
      entry.copy = copy;
      entry.stale = false;
      entry.played = new WeakSet();
    }
    if (!entry.root.isConnected) frame.appendChild(entry.root);
    if (!source.hasAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE)) {
      source.setAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE, 'true');
    }

    const { copy } = entry;
    copy.toggleAttribute(
      ABOVE_BROWSER_HOVER_ATTRIBUTE,
      source.matches(':hover'),
    );
    if (this.window.getComputedStyle(source).position === 'fixed') {
      entry.placement = null;
    } else {
      // Out of its layout context, an in-flow or absolute element is placed
      // by its measured box instead.
      entry.placement = rect;
      place(copy, rect);
    }
    this.playAnimations(entry);
  }

  /**
   * Where a marked overlay can be while it animates. A fixed overlay that
   * slides into place (a hover card moving to the next tab) is measured
   * mid-way, so the layer, sized once, would cut it off as it lands: cover
   * the way from its box now to its layout box, where it ends, and measure
   * again once the animation ends.
   */
  private travelOf(source: HTMLElement, rect: DOMRect): Rect {
    const now = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    };
    if (typeof source.getAnimations !== 'function') return now;
    const running = source
      .getAnimations()
      .filter((animation) => animation.playState === 'running');
    if (running.length === 0) return now;
    if (this.window.getComputedStyle(source).position !== 'fixed') return now;
    for (const animation of running) {
      animation.finished.then(this.schedule, this.schedule);
    }
    // A fixed element's offsets are viewport positions without transforms
    // or animated translation: where it rests.
    return union([
      now,
      {
        left: source.offsetLeft,
        top: source.offsetTop,
        right: source.offsetLeft + source.offsetWidth,
        bottom: source.offsetTop + source.offsetHeight,
      },
    ]);
  }

  /**
   * A copy does not inherit animations started on its source with the Web
   * Animations API (a hover card sliding over from the previous tab), so the
   * copy would jump while the hidden source moves. Each running keyframe
   * animation is started once on the copy, from the source's current time.
   */
  private playAnimations(entry: MirrorEntry): void {
    const { source, copy } = entry;
    if (typeof source.getAnimations !== 'function') return;
    if (typeof copy.animate !== 'function') return;
    for (const animation of source.getAnimations()) {
      if (animation.playState !== 'running' || entry.played.has(animation)) {
        continue;
      }
      const effect = animation.effect;
      if (!(effect instanceof this.window.KeyframeEffect)) continue;
      entry.played.add(animation);
      const replay = copy.animate(effect.getKeyframes(), effect.getTiming());
      replay.currentTime = animation.currentTime;
    }
  }

  private removeEntry(entry: MirrorEntry): void {
    entry.observer.disconnect();
    entry.root.remove();
    entry.source.removeAttribute(ABOVE_BROWSER_COPIED_ATTRIBUTE);
    this.entries.delete(entry.source);
  }

  /** Empties and hides the layer; the layer stays open for the next use. */
  private clear(): void {
    setAboveBrowserMirrorPage(null);
    for (const entry of Array.from(this.entries.values())) {
      this.removeEntry(entry);
    }
    if (this.layer && this.sentBounds !== null) {
      this.sentBounds = null;
      void this.layer.setBounds(null);
    }
  }
}

/** Starts mirroring for the main renderer; returns its disposer. */
export function installAboveBrowserMirror(document: Document): () => void {
  const mirror = new AboveBrowserMirror(document);
  mirror.start();
  return (): void => mirror.dispose();
}
