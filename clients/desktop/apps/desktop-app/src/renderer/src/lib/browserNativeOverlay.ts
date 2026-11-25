import { ABOVE_BROWSER_ATTRIBUTE } from '@canopy/ui-shared/lib/above-browser';

export const BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE =
  'data-canopy-browser-native-overlay';

/**
 * The design system's floating z-index layers (`--z-index-*` in
 * canopy-tokens.css), everything above `sticky`. A surface on one of these
 * layers floats over the page, so it blocks the native Browser view by
 * default: a new popover, tooltip or dialog needs no marker of its own.
 */
export const BROWSER_NATIVE_VIEW_OVERLAY_LAYERS = [
  'drawer',
  'modal',
  'dropdown',
  'toast',
  'tooltip',
  'spotlight',
] as const;

/**
 * What counts as an overlay: any floating layer, the menu and dialog roles
 * (surfaces that set their z-index another way), and an explicit
 * `data-canopy-browser-native-overlay="true"` for anything else. The same
 * attribute set to `"false"` opts a surface out. The nearest element carrying
 * the attribute (the element itself or an ancestor) decides, so a `"true"`
 * inside a `"false"` region counts again.
 */
export const BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR = [
  `[${BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE}="true"]`,
  '[aria-modal="true"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  // A layer is a `z-*` class or an inline `z-index: var(--z-index-*)`.
  ...BROWSER_NATIVE_VIEW_OVERLAY_LAYERS.flatMap((layer) => [
    `.z-${layer}`,
    `[style*="--z-index-${layer}"]`,
  ]),
].join(', ');

const BROWSER_NATIVE_VIEW_OVERLAY_MARKER_SELECTOR = `[${BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE}]`;

/**
 * Marks an area where a native Browser view can be shown (`"true"`). The
 * notification corner's overlay layer only lifts toasts above such an area.
 */
export const BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE =
  'data-browser-native-view-available';

/**
 * `"true"` on a Browser page area while an overlay covers it. Set by the
 * pane's own overlay check, in the frame it runs in.
 */
export const BROWSER_NATIVE_VIEW_COVERED_ATTRIBUTE =
  'data-browser-native-view-covered';

/**
 * `"true"` on a Browser page area while its freeze frame stands in for the
 * live view. While a page is covered but not frozen yet, the above-browser
 * mirror draws its overlays over the live page, so the live view never cuts
 * one off while a frame is captured.
 */
export const BROWSER_NATIVE_VIEW_FROZEN_ATTRIBUTE =
  'data-browser-native-view-frozen';

/**
 * Dispatched on `window` when a page area's covered or frozen state changes.
 * Not part of the observed overlay topology, so it never re-tests the panes.
 */
export const BROWSER_NATIVE_VIEW_COVER_CHANGED_EVENT =
  'canopy:browser-native-view-cover-changed';

const HIDDEN_ATTRIBUTE_SELECTOR = '[hidden], [inert], [aria-hidden="true"]';

const ABOVE_BROWSER_SELECTOR = `[${ABOVE_BROWSER_ATTRIBUTE}]`;

// Whether the above-browser mirror is drawing marked elements over pages.
// While it is, those elements need no freeze frame; once it cannot (no layer
// on this page), they count as overlays again.
let aboveBrowserMirrorActive = false;
// The page area the mirror draws over, or `null` while it draws nothing. A
// marked element still counts as an overlay for any other page, since the
// layer covers one page only.
let aboveBrowserMirrorPage: BrowserNativeViewOverlayTargetRect | null = null;

/** Set by the above-browser mirror; re-tests every pane on a change. */
export function setAboveBrowserMirrorActive(active: boolean): void {
  if (aboveBrowserMirrorActive === active) {
    return;
  }
  aboveBrowserMirrorActive = active;
  notifyBrowserOverlayTopologyChanged();
}

/** Set by the above-browser mirror; re-tests every pane on a change. */
export function setAboveBrowserMirrorPage(
  page: BrowserNativeViewOverlayTargetRect | null,
): void {
  const current = aboveBrowserMirrorPage;
  if (
    current === page ||
    (current !== null &&
      page !== null &&
      current.left === page.left &&
      current.top === page.top &&
      current.right === page.right &&
      current.bottom === page.bottom)
  ) {
    return;
  }
  aboveBrowserMirrorPage = page;
  notifyBrowserOverlayTopologyChanged();
}

/** Whether marked elements over `targetRect` are the mirror's to draw. */
function mirrorDraws(
  targetRect: BrowserNativeViewOverlayTargetRect | null,
): boolean {
  return (
    aboveBrowserMirrorActive &&
    (targetRect === null ||
      aboveBrowserMirrorPage === null ||
      rectsOverlap(targetRect, aboveBrowserMirrorPage))
  );
}

/**
 * Whether the nearest `data-canopy-browser-native-overlay` marker (on the
 * element or an ancestor) opts the element out. An element without a marker
 * ancestor keeps its default.
 */
function isOptedOutOfNativeOverlay(element: Element): boolean {
  return (
    element
      .closest(BROWSER_NATIVE_VIEW_OVERLAY_MARKER_SELECTOR)
      ?.getAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE) === 'false'
  );
}

interface BrowserNativeViewOverlayTargetRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

function isElementVisibleForNativeOverlay(
  element: Element,
  skipMarked: boolean,
): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return false;
  }

  if (
    element.closest(HIDDEN_ATTRIBUTE_SELECTOR) ||
    isOptedOutOfNativeOverlay(element) ||
    (skipMarked && element.closest(ABOVE_BROWSER_SELECTOR))
  ) {
    return false;
  }

  let current: HTMLElement | null = element;
  while (current) {
    const style = window.getComputedStyle(current);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse'
    ) {
      return false;
    }
    current = current.parentElement;
  }

  return true;
}

function rectsOverlap(
  a: BrowserNativeViewOverlayTargetRect,
  b: BrowserNativeViewOverlayTargetRect,
): boolean {
  if (a.width <= 0 || a.height <= 0 || b.width <= 0 || b.height <= 0) {
    return false;
  }
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
}

function intersectsTargetRect(
  element: HTMLElement,
  targetRect: BrowserNativeViewOverlayTargetRect | null,
): boolean {
  if (targetRect === null) {
    return true;
  }
  return rectsOverlap(element.getBoundingClientRect(), targetRect);
}

/**
 * The document's overlay elements, kept between topology changes.
 *
 * Every pane asks "does an overlay cover me?" on each frame of a window
 * resize, and a hidden Browser tab asks too. Answering from a fresh search
 * of the whole document each time cost a fifth of a resize with a page open
 * (four tabs, 128 steps: 410 ms). The shared observer already knows when
 * the set of overlays can have changed, so the search runs once per change;
 * each caller still tests visibility and position itself.
 */
let cachedOverlayElements: Element[] | null = null;
/** The same for everything the topology filter looks for. */
let cachedTopologyElements: Element[] | null = null;

function overlayElements(root: ParentNode): Element[] {
  const observer = overlayTopologyObserver;
  if (observer === null || root !== document) {
    return Array.from(
      root.querySelectorAll(BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR),
    );
  }
  // Changes the observer has seen and not delivered yet (a caller running in
  // the same task as the change): hand them on, and search again now.
  // A window resize restyles panels in the task every pane asks in, so most
  // of what is undelivered moves things without adding or removing an
  // overlay, and the kept list still holds.
  const undelivered = observer.takeRecords();
  if (undelivered.length > 0) {
    const change = topologyChange(undelivered);
    if (change === 'set') {
      cachedOverlayElements = null;
      cachedTopologyElements = null;
    }
    queueMicrotask(() => notifyOverlayTopologyListeners(undelivered, change));
  }
  cachedOverlayElements ??= Array.from(
    document.querySelectorAll(BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR),
  );
  return cachedOverlayElements;
}

export function hasBrowserNativeViewOverlay(
  root: ParentNode = document,
  targetRect: BrowserNativeViewOverlayTargetRect | null = null,
): boolean {
  const skipMarked = mirrorDraws(targetRect);
  return overlayElements(root).some(
    (element) =>
      isElementVisibleForNativeOverlay(element, skipMarked) &&
      intersectsTargetRect(element, targetRect),
  );
}

/**
 * The outermost overlays (as {@link hasBrowserNativeViewOverlay} counts them)
 * that intersect `targetRect`; an overlay inside another is left out.
 */
export function findBrowserNativeViewOverlays(
  root: ParentNode,
  targetRect: BrowserNativeViewOverlayTargetRect,
): HTMLElement[] {
  const skipMarked = mirrorDraws(targetRect);
  const overlays = overlayElements(root).filter(
    (element): element is HTMLElement =>
      isElementVisibleForNativeOverlay(element, skipMarked) &&
      intersectsTargetRect(element, targetRect),
  );
  return overlays.filter(
    (element) =>
      !overlays.some((other) => other !== element && other.contains(element)),
  );
}

// ---------------------------------------------------------------------------
// Shared overlay-topology observation (ref-counted)
// ---------------------------------------------------------------------------
//
// Multiple Browser panes may be mounted simultaneously (side-by-side
// panels). Each pane independently tests blocking-overlay intersection
// against ITS OWN rectangle, but they all watch the same document body for
// overlay topology changes — so exactly ONE `MutationObserver` is shared and
// ref-counted across subscribers. Unmounting one pane must not disconnect
// observation while other panes remain subscribed.

type OverlayTopologyListener = () => void;

interface OverlayTopologySubscriber {
  readonly listener: OverlayTopologyListener;
  /**
   * While this returns true the subscriber hears every DOM change, as it
   * needs while it tracks where something sits (a copy drawn over a page
   * follows its original through any reflow).
   */
  readonly everyChange?: () => boolean;
}

const overlayTopologySubscribers = new Set<OverlayTopologySubscriber>();
let overlayTopologyObserver: MutationObserver | null = null;

const OVERLAY_OBSERVED_ATTRIBUTES = [
  'aria-hidden',
  'aria-modal',
  ABOVE_BROWSER_ATTRIBUTE,
  'class',
  BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE,
  'hidden',
  'role',
  'style',
];

/**
 * Everything the subscribers look for: overlays, elements drawn above a
 * page, opt-in and opt-out markers, and the page areas themselves.
 */
const OVERLAY_TOPOLOGY_SELECTOR = [
  BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR,
  BROWSER_NATIVE_VIEW_OVERLAY_MARKER_SELECTOR,
  ABOVE_BROWSER_SELECTOR,
  `[${BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE}]`,
].join(', ');

/** A class or style value that put an element on a floating layer. */
const OVERLAY_LAYER_VALUE = new RegExp(
  `(?:^|\\s)z-(?:${BROWSER_NATIVE_VIEW_OVERLAY_LAYERS.join('|')})(?:\\s|$)|--z-index-(?:${BROWSER_NATIVE_VIEW_OVERLAY_LAYERS.join('|')})`,
);

const INLINE_DISPLAY = /(?:^|;)\s*display\s*:\s*([^;]+)/;
const INLINE_VISIBILITY = /(?:^|;)\s*visibility\s*:\s*([^;]+)/;

/** Whether an inline style change touched `display` or `visibility`. */
function inlineVisibilityChanged(
  oldStyle: string | null,
  element: HTMLElement,
): boolean {
  const before = oldStyle ?? '';
  const display = INLINE_DISPLAY.exec(before)?.[1]?.trim() ?? '';
  const visibility = INLINE_VISIBILITY.exec(before)?.[1]?.trim() ?? '';
  return (
    display !== element.style.display || visibility !== element.style.visibility
  );
}

type OverlayTopologyChange = 'none' | 'moved' | 'set';

/** A node no longer in the document: its own subtree is all there is. */
function isOrHoldsOverlayTopology(node: Node): boolean {
  return (
    node instanceof Element &&
    (node.matches(OVERLAY_TOPOLOGY_SELECTOR) ||
      node.querySelector(OVERLAY_TOPOLOGY_SELECTOR) !== null)
  );
}

/**
 * Whether a DOM change can alter what the subscribers see: an overlay, a
 * marked element or a page area appearing, going, or changing, or something
 * around one of them being shown or hidden.
 *
 * The observer watches the whole document, and nearly all of what it sees
 * is unrelated: streamed text, list rows, hover classes. Re-testing every
 * pane, the mirror and the Orchestrator page for each of those meant a
 * document-wide search and a layout on most frames while a page was open.
 *
 * `inDocument` lists the document's topology elements. A resize restyles
 * many large containers at once, and asking each of them for its own subtree
 * would search the page once per container.
 */
function overlayTopologyChange(
  record: MutationRecord,
  inDocument: () => readonly Element[],
): OverlayTopologyChange {
  const touches = (node: Node): boolean =>
    node instanceof Element &&
    (node.matches(OVERLAY_TOPOLOGY_SELECTOR) ||
      inDocument().some((element) => node.contains(element)));
  if (record.type === 'childList') {
    for (const node of Array.from(record.addedNodes)) {
      if (isOrHoldsOverlayTopology(node)) return 'set';
    }
    for (const node of Array.from(record.removedNodes)) {
      if (isOrHoldsOverlayTopology(node)) return 'set';
    }
    // Rows coming or going inside an open overlay (a menu's results arriving,
    // a filter cleared) can change what it covers without moving it.
    const parent =
      record.target instanceof Element
        ? record.target
        : record.target.parentElement;
    return parent?.closest(BROWSER_NATIVE_VIEW_OVERLAY_SELECTOR) != null
      ? 'moved'
      : 'none';
  }
  if (record.type !== 'attributes') return 'none';
  const target = record.target;
  const onLayer =
    (record.attributeName === 'class' || record.attributeName === 'style') &&
    target instanceof Element
      ? {
          before:
            record.oldValue !== null &&
            OVERLAY_LAYER_VALUE.test(record.oldValue),
          now: OVERLAY_LAYER_VALUE.test(
            target.getAttribute(record.attributeName) ?? '',
          ),
        }
      : null;
  // An element that joined or left a floating layer: after leaving it no
  // longer matches, and only its old value says it was one.
  if (onLayer !== null && onLayer.before !== onLayer.now) return 'set';
  if (
    record.attributeName !== 'class' &&
    record.attributeName !== 'style' &&
    record.attributeName !== 'hidden' &&
    record.attributeName !== 'aria-hidden'
  ) {
    // Roles and markers: rare, and each one is topology by itself.
    return 'set';
  }
  // A style change that leaves `display` and `visibility` alone only moves
  // or sizes its element (a panel or a divider during a window resize, a
  // virtual row): that matters when the element is itself an overlay or a
  // marked element, not around one, and never to which elements there are.
  if (
    record.attributeName === 'style' &&
    target instanceof HTMLElement &&
    !inlineVisibilityChanged(record.oldValue, target)
  ) {
    return target.matches(OVERLAY_TOPOLOGY_SELECTOR) ? 'moved' : 'none';
  }
  // Classes, styles and hiding matter on an overlay or around one.
  return touches(target) ? 'set' : 'none';
}

/**
 * The strongest change among `records`: `set` when the overlays, marked
 * elements or page areas there are may differ, `moved` when one of them
 * only moved or was sized, `none` for everything else.
 */
function topologyChange(
  records: readonly MutationRecord[],
): OverlayTopologyChange {
  // Kept until a change that can add or remove one: every other change (a
  // class on a row, a hidden attribute on a list) is then judged without
  // searching the document.
  const inDocument = (): readonly Element[] => {
    cachedTopologyElements ??= Array.from(
      document.querySelectorAll(OVERLAY_TOPOLOGY_SELECTOR),
    );
    return cachedTopologyElements;
  };
  let strongest: OverlayTopologyChange = 'none';
  for (const record of records) {
    const change = overlayTopologyChange(record, inDocument);
    if (change === 'set') return 'set';
    if (change === 'moved') strongest = 'moved';
  }
  return strongest;
}

function notifyOverlayTopologyListeners(
  records?: readonly MutationRecord[],
  judged?: OverlayTopologyChange,
): void {
  const change =
    judged ?? (records === undefined ? 'set' : topologyChange(records));
  const relevant = change !== 'none';
  if (change === 'set') {
    cachedOverlayElements = null;
    cachedTopologyElements = null;
  }
  for (const subscriber of Array.from(overlayTopologySubscribers)) {
    if (relevant || subscriber.everyChange?.() === true) {
      subscriber.listener();
    }
  }
}

/** Re-runs every subscriber, for a change the DOM observer cannot see. */
export function notifyBrowserOverlayTopologyChanged(): void {
  notifyOverlayTopologyListeners();
}

/**
 * Subscribe to document-body overlay topology changes. The underlying
 * `MutationObserver` is created for the first subscriber and disconnected
 * only when the LAST subscriber unsubscribes. Returns an unsubscribe fn.
 */
export function subscribeBrowserOverlayTopology(
  listener: OverlayTopologyListener,
  options: { everyChange?: () => boolean } = {},
): () => void {
  const subscriber: OverlayTopologySubscriber = {
    listener,
    everyChange: options.everyChange,
  };
  overlayTopologySubscribers.add(subscriber);
  if (
    overlayTopologyObserver === null &&
    typeof MutationObserver !== 'undefined' &&
    typeof document !== 'undefined' &&
    document.body
  ) {
    overlayTopologyObserver = new MutationObserver((records) => {
      notifyOverlayTopologyListeners(records);
    });
    overlayTopologyObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: OVERLAY_OBSERVED_ATTRIBUTES,
      attributeOldValue: true,
    });
  }
  let unsubscribed = false;
  return (): void => {
    if (unsubscribed) {
      return;
    }
    unsubscribed = true;
    overlayTopologySubscribers.delete(subscriber);
    if (overlayTopologySubscribers.size === 0 && overlayTopologyObserver) {
      overlayTopologyObserver.disconnect();
      overlayTopologyObserver = null;
      cachedOverlayElements = null;
      cachedTopologyElements = null;
    }
  };
}
