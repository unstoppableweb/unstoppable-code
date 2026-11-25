/**
 * Animates a panel grid from its current arrangement to the one `change`
 * leaves it in, for opening and closing a panel group (the Side Panel, the
 * Bottom Drawer).
 *
 * The split views place each panel in an absolutely positioned
 * `.split-view-view` with inline offsets and sizes, set synchronously while
 * the grid lays out. Every panel's box is read before and after `change`, and
 * each one that moved animates from the old box to the new one with the Web
 * Animations API, so the inline styles stay exactly what the engine wrote.
 * A panel the change hides is kept on screen (`data-layout-leaving`) while it
 * shrinks toward its far edge; a panel it shows grows from its far edge.
 * Dividers stay hidden until the boxes settle. Reduced motion skips all of it.
 */

/** How long an open or close takes, in milliseconds. */
export const PANEL_LAYOUT_ANIMATION_MS = 200;

const EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const VIEW_SELECTOR = '.split-view-view';
const VISIBLE_CLASS = 'split-view-view-visible';
/** Set on the grid's root while its boxes animate. */
export const PANEL_LAYOUT_ANIMATING_ATTRIBUTE = 'data-layout-animating';
/**
 * Dispatched on the grid's window when an animated open or close starts, so
 * a page drawn above the app (a Browser pane's native view) can stand still
 * until the boxes settle.
 */
export const PANEL_LAYOUT_ANIMATION_EVENT = 'canopy-panel-layout-animation';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  visible: boolean;
}

function readBox(element: HTMLElement): Box {
  const px = (value: string, fallback: number): number => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    left: px(element.style.left, 0),
    top: px(element.style.top, 0),
    width: px(element.style.width, element.offsetWidth),
    height: px(element.style.height, element.offsetHeight),
    visible: element.classList.contains(VISIBLE_CLASS),
  };
}

function sameBox(a: Box, b: Box): boolean {
  return (
    a.visible === b.visible &&
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

/** The keyframe properties a box animates: only the axes it lays out on. */
function frame(box: Box, horizontal: boolean): Keyframe {
  return horizontal
    ? { left: `${box.left}px`, width: `${box.width}px` }
    : { top: `${box.top}px`, height: `${box.height}px` };
}

/** Its box squeezed to nothing at its far edge on the axis it lays out on. */
function shut(box: Box, horizontal: boolean): Box {
  return horizontal
    ? { ...box, left: box.left + box.width, width: 0 }
    : { ...box, top: box.top + box.height, height: 0 };
}

/**
 * The newest transition on each grid, with every panel any of its unfinished
 * transitions kept drawn. A quick open-then-close starts a second transition
 * before the first settles; only the newest one clears the marks, so the first
 * one's cleanup cannot cut the second short.
 */
interface Transition {
  leaving: Set<HTMLElement>;
}
const latestTransitions = new WeakMap<HTMLElement, Transition>();

function prefersReducedMotion(view: Window): boolean {
  return (
    typeof view.matchMedia === 'function' &&
    view.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function animatePanelLayoutChange<T>(
  root: HTMLElement | null | undefined,
  change: () => T,
): T {
  const view = root?.ownerDocument.defaultView;
  if (
    !root ||
    !view ||
    typeof root.animate !== 'function' ||
    prefersReducedMotion(view)
  ) {
    return change();
  }
  const before = new Map<HTMLElement, Box>();
  root.querySelectorAll<HTMLElement>(VIEW_SELECTOR).forEach((element) => {
    before.set(element, readBox(element));
  });
  const result = change();
  const animations: Animation[] = [];
  const transition: Transition = {
    leaving: new Set(latestTransitions.get(root)?.leaving),
  };
  root.querySelectorAll<HTMLElement>(VIEW_SELECTOR).forEach((element) => {
    const from = before.get(element);
    const to = readBox(element);
    if (!from || sameBox(from, to)) return;
    const horizontal = element.style.width !== '';
    const options: KeyframeAnimationOptions = {
      duration: PANEL_LAYOUT_ANIMATION_MS,
      easing: EASING,
    };
    if (from.visible && !to.visible) {
      // Hidden by the change: keep it drawn while it closes.
      element.setAttribute('data-layout-leaving', '');
      transition.leaving.add(element);
      animations.push(
        element.animate(
          [frame(from, horizontal), frame(shut(from, horizontal), horizontal)],
          options,
        ),
      );
    } else if (!from.visible && to.visible) {
      // Shown again, perhaps while an earlier transition was closing it.
      element.removeAttribute('data-layout-leaving');
      transition.leaving.delete(element);
      animations.push(
        element.animate(
          [frame(shut(to, horizontal), horizontal), frame(to, horizontal)],
          options,
        ),
      );
    } else if (to.visible) {
      animations.push(
        element.animate(
          [frame(from, horizontal), frame(to, horizontal)],
          options,
        ),
      );
    }
  });
  if (animations.length === 0) return result;
  latestTransitions.set(root, transition);
  root.setAttribute(PANEL_LAYOUT_ANIMATING_ATTRIBUTE, '');
  view.dispatchEvent(new view.Event(PANEL_LAYOUT_ANIMATION_EVENT));
  void Promise.allSettled(
    animations.map((animation) => animation.finished),
  ).then(() => {
    if (latestTransitions.get(root) !== transition) return;
    latestTransitions.delete(root);
    for (const element of transition.leaving)
      element.removeAttribute('data-layout-leaving');
    root.removeAttribute(PANEL_LAYOUT_ANIMATING_ATTRIBUTE);
  });
  return result;
}
