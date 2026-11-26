/**
 * Marks every top bar in a window (`.canopy-shed-scope`) with
 * `data-window-resizing` while the window is being resized, and clears the
 * mark once the size has held still for a moment.
 *
 * A top bar sheds controls and folds labels as it narrows, and those changes
 * ease over a few hundred milliseconds. When the window itself is being
 * dragged, the bar's width changes on every frame, so an easing control kept
 * moving after the window edge had passed it: the launch button and Open in
 * trailed the right edge. Under the mark those changes apply in the frame the
 * width crosses their breakpoint (`canopy-tokens-core.css`); a bar that
 * narrows for another reason, such as a panel opening, still eases.
 *
 * The mark sits on the bars only, never on `<html>`: an attribute there would
 * restyle the whole document when the drag starts and again when it ends.
 */

export const WINDOW_RESIZING_ATTRIBUTE = 'data-window-resizing';

/** How long the size must hold before the mark comes off. */
const SETTLE_MS = 200;
const SCOPE_SELECTOR = '.canopy-shed-scope';

interface ResizeMarker {
  users: number;
  readonly dispose: () => void;
}

const markers = new WeakMap<Window, ResizeMarker>();

function createMarker(view: Window): ResizeMarker {
  let settleTimer: number | null = null;
  let marked: Element[] = [];
  const clear = (): void => {
    settleTimer = null;
    for (const element of marked) {
      element.removeAttribute(WINDOW_RESIZING_ATTRIBUTE);
    }
    marked = [];
  };
  const onResize = (): void => {
    if (settleTimer === null) {
      // The resize event runs before this frame's style pass, so the bars
      // are marked before any breakpoint the new width crosses applies.
      marked = Array.from(view.document.querySelectorAll(SCOPE_SELECTOR));
      for (const element of marked) {
        element.setAttribute(WINDOW_RESIZING_ATTRIBUTE, '');
      }
    } else {
      view.clearTimeout(settleTimer);
    }
    settleTimer = view.setTimeout(clear, SETTLE_MS);
  };
  view.addEventListener('resize', onResize);
  return {
    users: 0,
    dispose: (): void => {
      view.removeEventListener('resize', onResize);
      if (settleTimer !== null) view.clearTimeout(settleTimer);
      clear();
    },
  };
}

/**
 * Starts marking `view`'s top bars during window resizes, shared by every
 * mounted bar in that window. Returns the release for this caller.
 */
export function retainWindowResizeMarker(view: Window): () => void {
  const marker = markers.get(view) ?? createMarker(view);
  markers.set(view, marker);
  marker.users += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    marker.users -= 1;
    if (marker.users === 0) {
      marker.dispose();
      markers.delete(view);
    }
  };
}
