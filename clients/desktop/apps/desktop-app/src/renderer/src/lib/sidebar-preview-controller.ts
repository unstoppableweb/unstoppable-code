import { useSidebarStore } from '../stores/sidebarStore';

/**
 * Hover/focus timing for the collapsed-sidebar preview (CAN-2415).
 *
 * The titlebar toggle opens the preview after a short hover delay (so a
 * pointer passing through the corner doesn't flash the overlay), and closing
 * has a grace period so the pointer can travel from the toggle into the
 * revealed sidebar without the preview collapsing mid-way. Only one sidebar
 * exists per renderer, so module-level timers are sufficient (matching the
 * width-persist debounce in `sidebarStore`).
 */

/**
 * Hover dwell before the preview opens. Zero: the reveal is meant to feel
 * immediate. A dwell would also make a quick in-and-out feel unresponsive,
 * since the reveal could not begin before the pointer had already left.
 */
export const SIDEBAR_PREVIEW_OPEN_DELAY_MS = 0;
/**
 * Grace period after pointer/focus leaves before the preview closes. Zero, so
 * an unhover reverses the reveal from wherever it currently is — including
 * mid-animation — rather than finishing first. The pointer handoff between the
 * toggle and the panel is handled by `relatedTarget` checks at the call sites,
 * not by waiting; a sidebar menu being open defers the close (see below).
 */
export const SIDEBAR_PREVIEW_CLOSE_DELAY_MS = 0;
/**
 * How long to wait before honouring a leave that reported no destination.
 * Short enough to stay imperceptible against the 250ms reveal, long enough for
 * the pointer to land somewhere the renderer can see after crossing a
 * window-drag region.
 */
export const SIDEBAR_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS = 120;
/**
 * Width in px of the band at the window's left edge that reveals the hidden
 * sidebar. Sized for the gesture it is named after — pushing the pointer left
 * until it stops — while staying narrow enough that ordinary travel down the
 * left of the page never crosses it. The window's own frame owns a couple of
 * pixels outside the web contents on both platforms, so a band this thin is
 * only reachable by deliberately running into the edge.
 */
export const SIDEBAR_EDGE_TRIGGER_PX = 4;

let openTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
// True only inside `closeSidebarPreviewAndRefocusToggle`'s programmatic
// `toggle.focus()` call, whose synchronous focus event must not instantly
// reopen the preview that Escape just closed.
let suppressFocusOpen = false;
// A close that arrived while a sidebar menu was open, to be run once it closes.
let closeDeferredByMenu = false;
let menuFlagObserver: MutationObserver | null = null;

function clearOpenTimer(): void {
  if (openTimer !== null) {
    clearTimeout(openTimer);
    openTimer = null;
  }
}

function clearCloseTimer(): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/**
 * Requests the preview to open. Delayed by default (pointer hover);
 * `immediate` is for keyboard focus, where a dwell delay would only hurt.
 * No-ops (and cancels any pending close) when the sidebar is not hidden.
 */
export function requestSidebarPreviewOpen(options?: {
  immediate?: boolean;
}): void {
  // Cancels EVERY form of pending close, not just the timer: a close deferred
  // while a sidebar menu was open lives in `closeDeferredByMenu`, and would
  // otherwise fire when the menu closes and collapse a preview the user has
  // since re-opened.
  cancelSidebarPreviewClose();
  const store = useSidebarStore.getState();
  if (!store.hidden || store.previewing) return;
  // A modal that is ALREADY open must block the preview outright: the observer
  // only ever fires on future mutations, so a scrim mounted before this request
  // would never be noticed and the preview would sit above it unclosable.
  if (scrimPresent()) return;
  if (options?.immediate) {
    clearOpenTimer();
    startScrimWatch();
    useSidebarStore.getState().setPreviewing(true);
    return;
  }
  if (openTimer !== null) return;
  openTimer = setTimeout(() => {
    openTimer = null;
    if (scrimPresent()) return;
    startScrimWatch();
    useSidebarStore.getState().setPreviewing(true);
  }, SIDEBAR_PREVIEW_OPEN_DELAY_MS);
}

/**
 * True while any sidebar dropdown/context menu is open. Those menus portal
 * OUTSIDE the sidebar, so opening one fires a pointer-leave on the panel —
 * which must not be read as "the user left the preview". The flag is the
 * shared reference-counted one set by Menu and
 * `useSuspendSidebarHovers`.
 */
function sidebarMenuOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.body?.hasAttribute('data-sidebar-menu-open') ?? false;
}

/**
 * Once the menu closes the pointer is usually already outside the sidebar, so
 * no further pointer event would ever arrive to close the preview. Watch the
 * flag and run the deferred close when it clears.
 */
function ensureMenuFlagObserver(): void {
  if (
    menuFlagObserver !== null ||
    typeof MutationObserver === 'undefined' ||
    typeof document === 'undefined' ||
    document.body === null
  ) {
    return;
  }
  menuFlagObserver = new MutationObserver(() => {
    if (sidebarMenuOpen() || !closeDeferredByMenu) return;
    closeDeferredByMenu = false;
    requestSidebarPreviewClose();
  });
  menuFlagObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['data-sidebar-menu-open'],
  });
}

/**
 * True when the pointer is still inside the preview's own surfaces. Used to
 * second-guess a close whose `relatedTarget` was null: OS window-drag regions
 * (`-webkit-app-region: drag`) swallow pointer events, so crossing one inside
 * the sidebar reports a leave to nowhere even though the cursor never left.
 */
function pointerStillInsidePreview(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.querySelector('[data-testid="app-sidebar"]:hover') !== null ||
    document.querySelector('[data-testid="app-titlebar-corner"]:hover') !== null
  );
}

/** The revealed panel plus the titlebar corner that opens and holds it. */
const PREVIEW_SURFACE_SELECTORS: readonly string[] = [
  '[data-testid="sidebar-panel"]',
  '[data-testid="app-titlebar-corner"]',
];

/** The titlebar corner alone (window controls, toggle, history, New Task). */
const TITLEBAR_CORNER_SELECTORS: readonly string[] = [
  '[data-testid="app-titlebar-corner"]',
];

/**
 * True when the given viewport point lies within the preview's own surfaces.
 *
 * This is the authoritative test, because the DOM's own signals are not
 * trustworthy here: leaves fire with a null `relatedTarget` while the cursor is
 * demonstrably still inside the panel (observed at (32,351) on a 221px-wide
 * panel), and `:hover` goes stale for the same reasons. Geometry does not lie.
 */
function pointInsidePreview(x: number, y: number): boolean {
  return pointInsideAny(x, y, PREVIEW_SURFACE_SELECTORS);
}

/** Whether a viewport point falls inside any of the given elements' boxes. */
function pointInsideAny(
  x: number,
  y: number,
  selectors: readonly string[],
): boolean {
  if (typeof document === 'undefined') return false;
  return selectors
    .map((selector) => document.querySelector(selector))
    .some((element) => {
      if (element === null) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      return (
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
    });
}

/** Cancels a pending delayed open (pointer left the toggle before dwell). */
export function cancelSidebarPreviewOpen(): void {
  clearOpenTimer();
}

/**
 * Opens the preview for a keyboard-visible focus on the toggle. Immediate
 * (no hover dwell), but ignored during the programmatic refocus performed by
 * `closeSidebarPreviewAndRefocusToggle` — otherwise Escape would close the
 * preview and the resulting focus event would instantly reopen it.
 */
export function requestSidebarPreviewOpenFromFocus(): void {
  if (suppressFocusOpen) return;
  requestSidebarPreviewOpen({ immediate: true });
}

/**
 * Requests the preview to close after the grace period (or immediately for
 * Escape / pinning). Also cancels any pending open.
 */
export function requestSidebarPreviewClose(options?: {
  immediate?: boolean;
  /**
   * The leave reported no destination. Treated as suspect rather than final:
   * see `pointerStillInsidePreview`.
   */
  unknownDestination?: boolean;
  /** Viewport coordinates the leave was reported at, when available. */
  pointer?: { x: number; y: number };
}): void {
  clearOpenTimer();
  if (options?.immediate) {
    clearCloseTimer();
    closeDeferredByMenu = false;
    useSidebarStore.getState().setPreviewing(false);
    return;
  }
  if (!useSidebarStore.getState().previewing) return;
  // The cursor is still geometrically within the preview, so it has not left —
  // regardless of what the event reported.
  if (
    options?.pointer !== undefined &&
    pointInsidePreview(options.pointer.x, options.pointer.y)
  ) {
    return;
  }
  // A leave with no destination is re-checked a frame later instead of being
  // trusted: if the pointer is still over the panel or the corner, it never
  // actually left, so the preview stays.
  if (options?.unknownDestination) {
    clearCloseTimer();
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (pointerStillInsidePreview()) return;
      // A menu opened in the meantime: hand off to the same deferral the
      // explicit-leave path uses. Returning here without arming it would
      // strand the preview — the pointer is already outside, so no further
      // pointer event would ever arrive to close it.
      if (sidebarMenuOpen()) {
        closeDeferredByMenu = true;
        ensureMenuFlagObserver();
        return;
      }
      useSidebarStore.getState().setPreviewing(false);
    }, SIDEBAR_PREVIEW_UNKNOWN_LEAVE_RECHECK_MS);
    return;
  }
  // The pointer went to a sidebar menu, not away from the sidebar. Hold the
  // preview open and re-run this once the menu closes.
  if (sidebarMenuOpen()) {
    clearCloseTimer();
    closeDeferredByMenu = true;
    ensureMenuFlagObserver();
    return;
  }
  if (closeTimer !== null) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    useSidebarStore.getState().setPreviewing(false);
  }, SIDEBAR_PREVIEW_CLOSE_DELAY_MS);
}

/**
 * Modal dialogs and ordinary page overlays share the same z-40 tier, so no
 * single stacking value can put the preview above one and below the other.
 * The preview sits above both and this resolves the modal case in behaviour
 * instead: a scrim mounting means a true modal took over, so the preview is
 * released rather than floating on top of it.
 */
let scrimObserver: MutationObserver | null = null;

function scrimPresent(): boolean {
  if (typeof document === 'undefined') return false;
  // Presence in the DOM is not enough: scrims can be mounted while hidden.
  // Only a scrim that actually occupies space is covering the preview.
  return Array.from(document.querySelectorAll('.bg-overlay-scrim')).some(
    (node) => node.getClientRects().length > 0,
  );
}

function startScrimWatch(): void {
  if (
    scrimObserver !== null ||
    typeof MutationObserver === 'undefined' ||
    typeof document === 'undefined' ||
    document.body === null
  ) {
    return;
  }
  scrimObserver = new MutationObserver(() => {
    const store = useSidebarStore.getState();
    // Deliberately NOT gated on `previewing`: the panel stays rendered for the
    // release window after that flips, so a scrim mounted during the slide-out
    // would otherwise be left covered with no later mutation to correct it.
    if (!store.previewing && !store.previewPresented) return;
    if (!scrimPresent()) return;
    // Release the whole overlay atomically. Closing alone would leave the
    // panel presented (and stacked above the modal) for the release window.
    requestSidebarPreviewClose({ immediate: true });
    store.setPreviewSlidIn(false);
    store.setPreviewPresented(false);
  });
  scrimObserver.observe(document.body, { childList: true, subtree: true });
}

/** Cancels a pending close (pointer/focus re-entered the preview). */
export function cancelSidebarPreviewClose(): void {
  clearCloseTimer();
  closeDeferredByMenu = false;
}

/**
 * Closes the preview immediately and returns focus to the titlebar toggle so
 * a keyboard user isn't dropped onto `document.body` when the overlay's
 * contents go inert (Escape while focus is inside the preview).
 */
export function closeSidebarPreviewAndRefocusToggle(): void {
  requestSidebarPreviewClose({ immediate: true });
  const toggle = document.querySelector('[data-testid="sidebar-toggle"]');
  if (toggle instanceof HTMLElement) {
    // React dispatches the resulting focus event synchronously, so the flag
    // only needs to cover the `focus()` call itself.
    suppressFocusOpen = true;
    try {
      toggle.focus();
    } finally {
      suppressFocusOpen = false;
    }
  }
}

/**
 * Pointer travel handler for the left-edge reveal: pushing the pointer into
 * the window's left edge opens the same preview the titlebar toggle's hover
 * opens, so the sidebar can be consulted without aiming for a control.
 *
 * It also owns the close in one case the DOM cannot report. The panel mounts
 * a frame after the open request, so a pointer that only brushed the edge is
 * already gone by the time it appears — the panel never receives a
 * pointer-enter, and therefore never a leave either, and the preview would sit
 * there open with nothing left to dismiss it. Travel outside the preview's own
 * geometry closes it, which covers that case and any other leave the DOM
 * missed.
 *
 * Deliberately does nothing while a sidebar menu is open: those menus portal
 * outside the panel, so the pointer using one is legitimately outside its box.
 * The panel's own leave handler already defers that close until the menu
 * clears, and this must not race it.
 *
 * Takes a plain point rather than an event so the decision is testable without
 * synthesising pointer events.
 */
export function handleSidebarEdgePointerMove(point: {
  x: number;
  y: number;
}): void {
  const store = useSidebarStore.getState();
  if (!store.hidden) return;
  if (point.x <= SIDEBAR_EDGE_TRIGGER_PX) {
    // The titlebar corner reaches the same edge and owns its own hover
    // behaviour: on macOS the window controls sit there, and reaching for
    // one must not fling the sidebar out.
    if (pointInsideAny(point.x, point.y, TITLEBAR_CORNER_SELECTORS)) return;
    requestSidebarPreviewOpen({ immediate: true });
    return;
  }
  if (!store.previewing) return;
  if (pointInsidePreview(point.x, point.y)) return;
  closeFromEdgeWatch();
}

/**
 * True when keyboard-visible focus currently sits inside the preview.
 *
 * A preview opened by tabbing to the toggle belongs to the keyboard, and the
 * pointer may be anywhere — resting on a trackpad, nudged by a passing hand.
 * Without this, incidental travel would collapse a preview the user is
 * actively navigating with the keyboard, which is exactly when they cannot
 * cheaply re-open it. `:focus-visible` (not plain focus) so a click that
 * happens to leave focus in the sidebar does not pin the preview open against
 * an ordinary unhover.
 */
function keyboardFocusInsidePreview(): boolean {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  if (active === null) return false;
  if (
    active.closest(
      '[data-testid="app-sidebar"], [data-testid="app-titlebar-corner"]',
    ) === null
  ) {
    return false;
  }
  return active.matches(':focus-visible');
}

/**
 * The close the edge watch is allowed to perform, with the two holds that
 * belong to it alone.
 *
 * A sidebar menu being open is a hold because those menus portal OUTSIDE the
 * panel, so the pointer using one is legitimately outside its box; the panel's
 * own leave handler already defers that close until the menu clears, and this
 * must not race it. Keyboard focus inside the preview is a hold because the
 * pointer is not what is driving the preview at all.
 */
function closeFromEdgeWatch(options?: { unknownDestination?: boolean }): void {
  if (sidebarMenuOpen()) return;
  if (keyboardFocusInsidePreview()) return;
  requestSidebarPreviewClose(options);
}

/**
 * Watches pointer travel for the left-edge reveal, returning a teardown.
 *
 * A window listener rather than a hit-testable strip at the edge: an element
 * wide enough to be reachable is also wide enough to swallow clicks and text
 * selections that start at the very left of the page, and this affordance must
 * cost the rest of the window nothing.
 */
export function startSidebarEdgeHoverWatch(): () => void {
  if (typeof window === 'undefined') return (): void => {};
  const onPointerMove = (event: PointerEvent): void => {
    // Touch has no hover, so an edge "hover" is really the start of a swipe or
    // a tap; either way the preview is not what was asked for.
    if (event.pointerType === 'touch') return;
    handleSidebarEdgePointerMove({ x: event.clientX, y: event.clientY });
  };
  // Pointer travel alone cannot close a preview the pointer left the WINDOW
  // from: opening at the edge and then continuing off the window delivers no
  // further move for the watch to read, and if the panel mounted after the
  // pointer had already gone it never received an enter either — so it has no
  // leave of its own to fire. The overlay would sit there with nothing able to
  // dismiss it. A leave that names no destination is the only signal that the
  // pointer left the web contents entirely.
  //
  // Such a leave is reported as suspect rather than final, because crossing an
  // OS window-drag region inside the app produces the identical event: the
  // shared recheck re-tests a frame later and keeps the preview if the pointer
  // turns out to still be over it.
  const onPointerOut = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') return;
    if (event.relatedTarget !== null) return;
    if (!useSidebarStore.getState().previewing) return;
    closeFromEdgeWatch({ unknownDestination: true });
  };
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerout', onPointerOut, { passive: true });
  return (): void => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerout', onPointerOut);
  };
}
